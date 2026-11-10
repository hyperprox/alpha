// =============================================================================
//  HyperProx — Updates: policy
//
//  Everything cluster-specific about updates lives in config/updates.yaml, a
//  local git-ignored file; config/updates.example.yaml documents every key.
//
//  Two rules shape this file:
//    - Unknown keys fail the load, with the path of the bad key. A typo such as
//      `requre_pin` must not silently drop the one safeguard a GPU node relies on.
//    - Without a policy file the defaults are the SAFE ones: nodes get
//      `apt-get upgrade` and never reboot on their own, guests never reboot, no
//      Docker images are pulled. Inventory and dry runs work; a real run is
//      refused until someone has written down what is allowed.
// =============================================================================

import fs from 'node:fs'
import { z } from 'zod'
import type { UpdatesNodePolicyView, UpdatesPolicyStatus } from './types'
import { nextRun, parseCron } from './cron'

// js-yaml ships no types; only load() is used.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load(src: string): unknown }

export const DEFAULT_POLICY_PATH = '/opt/hyperprox/config/updates.yaml'

export function policyPath(): string {
  return process.env.UPDATES_POLICY_PATH || DEFAULT_POLICY_PATH
}

// --- Schema --------------------------------------------------------------------

const cronString = z.string().superRefine((s, ctx) => {
  try { parseCron(s) } catch (e: any) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: e.message }) }
})

const nodeSchema = z.object({
  upgrade:       z.enum(['upgrade', 'dist-upgrade']).optional(),
  reboot:        z.enum(['auto', 'manual']).optional(),
  order:         z.enum(['first', 'last']).optional(),
  require_holds: z.array(z.string().min(1)).optional(),
  require_pin:   z.string().min(1).optional(),
}).strict()

const guestSchema = z.object({
  apt:          z.boolean().optional(),
  docker:       z.enum(['none', 'auto', 'manual']).optional(),
  reboot:       z.enum(['never', 'if-required']).optional(),
  compose_dirs: z.array(z.string().startsWith('/')).optional(),
  check:        z.string().url().optional(),
  apps:         z.boolean().optional(),
}).strict()

const appModeSchema = z.enum(['auto', 'manual', 'off'])
const APP_ID = /^[a-z0-9][a-z0-9-]{0,40}$/

const fileSchema = z.object({
  schedule: z.object({
    enabled:      z.boolean().optional(),
    cron:         cronString.optional(),
    window_hours: z.number().positive().max(48).optional(),
  }).strict().optional(),
  quiet: z.object({
    plex_streams_block_reboots: z.boolean().optional(),
  }).strict().optional(),
  ceph: z.object({
    accepted_warnings: z.array(z.string().regex(/^[A-Z0-9_]+$/, 'a Ceph health code, e.g. POOL_NO_REDUNDANCY')
      .refine(c => c !== 'OSDMAP_FLAGS', 'OSDMAP_FLAGS cannot be accepted: it is how a noout left behind by a stopped run shows, and Updates must never restart or reboot past it')).optional(),
  }).strict().optional(),
  nodes:  z.record(nodeSchema).optional(),
  // Keys are `default`, `exclude` or a VMID, so the shape is checked by hand below.
  guests: z.record(z.unknown()).optional(),
  batch_size:       z.number().int().min(1).max(20).optional(),
  min_root_free_mb: z.number().int().min(0).optional(),
  self: z.object({
    node_order: z.literal('last').optional(),
    vmid:       z.number().int().positive().optional(),
  }).strict().optional(),
  notify: z.object({
    webhook_url: z.string().url().optional(),
  }).strict().optional(),
  // Keys are `enabled`, `default` or an app provider id, so the shape is checked by hand below.
  apps: z.record(z.unknown()).optional(),
  // The daily read-only check for every cluster (lib/updates/check.ts).
  check: z.object({
    enabled:       z.boolean().optional(),
    cron:          cronString.optional(),
    reminder_days: z.number().int().min(1).max(60).optional(),
  }).strict().optional(),
  // One section per remote cluster, keyed by its id or its exact name; checked by hand below.
  clusters: z.record(z.unknown()).optional(),
}).strict()

// A remote cluster's section. No schedule (scheduled runs are home-only), no self, no apps, no Plex wait, and a
// node may only be `reboot: manual`: HyperProx never reboots a remote node on its own.
const remoteNodeSchema = z.object({
  upgrade:       z.enum(['upgrade', 'dist-upgrade']).optional(),
  reboot:        z.literal('manual', { errorMap: () => ({ message: 'a remote node is never rebooted automatically; only manual is allowed' }) }).optional(),
  order:         z.enum(['first', 'last']).optional(),
  require_holds: z.array(z.string().min(1)).optional(),
  require_pin:   z.string().min(1).optional(),
}).strict()

const remoteSectionSchema = z.object({
  nodes:  z.record(remoteNodeSchema).optional(),
  guests: z.record(z.unknown()).optional(),
  ceph: z.object({
    accepted_warnings: z.array(z.string().regex(/^[A-Z0-9_]+$/, 'a Ceph health code, e.g. POOL_NO_REDUNDANCY')
      .refine(c => c !== 'OSDMAP_FLAGS', 'OSDMAP_FLAGS cannot be accepted')).optional(),
  }).strict().optional(),
  batch_size:       z.number().int().min(1).max(20).optional(),
  min_root_free_mb: z.number().int().min(0).optional(),
}).strict()

// --- Resolved policy -------------------------------------------------------------

export interface NodePolicy {
  upgrade:      'upgrade' | 'dist-upgrade'
  reboot:       'auto' | 'manual'
  order?:       'first' | 'last'
  requireHolds: string[]
  requirePin?:  string
}

export interface GuestPolicy {
  apt:         boolean
  docker:      'none' | 'auto' | 'manual'
  reboot:      'never' | 'if-required'
  composeDirs: string[]
  check?:      string
  /** Look for apps (plug-in app-update providers) in this guest. */
  apps:        boolean
}

export type AppMode = 'auto' | 'manual' | 'off'

export interface AppsPolicy {
  /** Detect and report apps at all. */
  enabled:   boolean
  /** Mode for any provider not named: `manual` unless the file says otherwise. */
  default:   AppMode
  providers: Record<string, AppMode>
}

export interface Policy {
  schedule:        { enabled: boolean; cron: string; windowHours: number }
  plexBlocksReboots: boolean
  acceptedWarnings: string[]
  nodeDefault:     NodePolicy
  nodes:           Record<string, Partial<NodePolicy>>
  guestDefault:    GuestPolicy
  guests:          Record<string, Partial<GuestPolicy>>
  exclude:         number[]
  batchSize:       number
  minRootFreeMb:   number
  selfVmid?:       number
  webhookUrl?:     string
  apps:            AppsPolicy
  /** The daily read-only check (top level only; it covers every cluster). */
  check:           CheckPolicy
  /** Remote cluster sections as written, by the key used in the file (an id or a name). Home only. */
  remotes:         Record<string, Policy>
  /** True for a remote cluster's policy: a remote's own section, or the built-in remote defaults. */
  remote?:         boolean
}

export interface CheckPolicy { enabled: boolean; cron: string; reminderDays: number }
export const DEFAULT_CHECK: CheckPolicy = { enabled: true, cron: '30 6 * * *', reminderDays: 7 }

export const SAFE_NODE_DEFAULT: NodePolicy = { upgrade: 'upgrade', reboot: 'manual', requireHolds: [] }
export const SAFE_GUEST_DEFAULT: GuestPolicy = { apt: true, docker: 'none', reboot: 'never', composeDirs: [], apps: true }

export function defaultPolicy(): Policy {
  return {
    schedule: { enabled: false, cron: '0 8 * * 3', windowHours: 4 },
    plexBlocksReboots: true,
    acceptedWarnings: [],
    nodeDefault: { ...SAFE_NODE_DEFAULT, requireHolds: [] },
    nodes: {},
    guestDefault: { ...SAFE_GUEST_DEFAULT, composeDirs: [] },
    guests: {},
    exclude: [],
    batchSize: 3,
    minRootFreeMb: 1024,
    // Finding apps and reporting them is read-only; applying one needs `auto` or a person's approval.
    apps: { enabled: true, default: 'manual', providers: {} },
    check: { ...DEFAULT_CHECK },
    remotes: {},
  }
}

/**
 * The built-in policy for a remote cluster with no section of its own: the Proxmox-recommended upgrade for a
 * Proxmox VE node (`apt-get dist-upgrade`, which never installs or removes a held package and never moves a
 * kernel pin), never an automatic reboot, guests `apt-get upgrade` and never rebooted, no Docker pulls, no app
 * updates, no scheduled runs. Nothing from the home cluster's `nodes:` or `guests:` applies to a remote.
 */
export function remoteDefaultPolicy(): Policy {
  const p = defaultPolicy()
  p.nodeDefault = { upgrade: 'dist-upgrade', reboot: 'manual', requireHolds: [] }
  p.plexBlocksReboots = false
  p.apps = { enabled: false, default: 'off', providers: {} }
  p.remote = true
  return p
}

export interface PolicyLoad {
  loaded: boolean
  path:   string
  error?: string
  /** No policy file at all (as opposed to one that failed to load). */
  missing?: boolean
  /** Remote clusters: the section key used, or null for the built-in remote defaults. */
  section?: string | null
  /** Plain-language notes about how this cluster's policy was chosen. */
  notes?:   string[]
  /** Always usable: the file's policy when it loaded, the safe defaults otherwise. */
  policy: Policy
}

function nodeFrom(raw: z.infer<typeof nodeSchema>): Partial<NodePolicy> {
  const out: Partial<NodePolicy> = {}
  if (raw.upgrade)       out.upgrade = raw.upgrade
  if (raw.reboot)        out.reboot = raw.reboot
  if (raw.order)         out.order = raw.order
  if (raw.require_holds) out.requireHolds = raw.require_holds
  if (raw.require_pin)   out.requirePin = raw.require_pin
  return out
}

function guestFrom(raw: z.infer<typeof guestSchema>): Partial<GuestPolicy> {
  const out: Partial<GuestPolicy> = {}
  if (raw.apt !== undefined) out.apt = raw.apt
  if (raw.docker)       out.docker = raw.docker
  if (raw.reboot)       out.reboot = raw.reboot
  if (raw.compose_dirs) out.composeDirs = raw.compose_dirs
  if (raw.check)        out.check = raw.check
  if (raw.apps !== undefined) out.apps = raw.apps
  return out
}

function describeIssues(err: z.ZodError, prefix: string[] = []): string {
  return err.issues.map(i => {
    const at = [...prefix, ...i.path.map(String)]
    if (i.code === z.ZodIssueCode.unrecognized_keys) {
      return i.keys.map(k => `${[...at, k].join('.')}: unknown key`).join('; ')
    }
    return `${at.join('.') || '(top level)'}: ${i.message}`
  }).join('; ')
}

/** Parse and validate policy text. Throws with every bad key's path. */
export function parsePolicy(text: string): Policy {
  let doc: unknown
  try { doc = yaml.load(text) } catch (e: any) { throw new Error(`not valid YAML: ${e.message}`) }
  if (doc === undefined || doc === null) doc = {}
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error('the policy must be a YAML mapping')

  // A section with only comments under it reads as null; treat it as absent.
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) if (v === null) delete (doc as Record<string, unknown>)[k]

  const parsed = fileSchema.safeParse(doc)
  if (!parsed.success) throw new Error(describeIssues(parsed.error))
  const f = parsed.data
  const p = defaultPolicy()

  if (f.schedule?.enabled !== undefined)   p.schedule.enabled = f.schedule.enabled
  if (f.schedule?.cron)                    p.schedule.cron = f.schedule.cron
  if (f.schedule?.window_hours)            p.schedule.windowHours = f.schedule.window_hours
  if (f.quiet?.plex_streams_block_reboots !== undefined) p.plexBlocksReboots = f.quiet.plex_streams_block_reboots
  if (f.ceph?.accepted_warnings)           p.acceptedWarnings = f.ceph.accepted_warnings
  if (f.batch_size)                        p.batchSize = f.batch_size
  if (f.min_root_free_mb !== undefined)    p.minRootFreeMb = f.min_root_free_mb
  if (f.self?.vmid)                        p.selfVmid = f.self.vmid
  if (f.notify?.webhook_url)               p.webhookUrl = f.notify.webhook_url

  for (const [name, raw] of Object.entries(f.nodes ?? {})) {
    if (name === 'default') p.nodeDefault = { ...p.nodeDefault, ...nodeFrom(raw) }
    else p.nodes[name] = nodeFrom(raw)
  }

  const problems: string[] = []
  for (const [key, raw] of Object.entries(f.guests ?? {})) {
    if (key === 'exclude') {
      const ex = z.array(z.number().int().positive()).safeParse(raw)
      if (!ex.success) problems.push(describeIssues(ex.error, ['guests', 'exclude']))
      else p.exclude = ex.data
      continue
    }
    if (key !== 'default' && !/^\d+$/.test(key)) {
      problems.push(`guests.${key}: unknown key (expected default, exclude or a VMID)`)
      continue
    }
    const g = guestSchema.safeParse(raw ?? {})
    if (!g.success) { problems.push(describeIssues(g.error, ['guests', key])); continue }
    if (key === 'default') p.guestDefault = { ...p.guestDefault, ...guestFrom(g.data) }
    else p.guests[key] = guestFrom(g.data)
  }
  for (const [key, raw] of Object.entries(f.apps ?? {})) {
    if (key === 'enabled') {
      if (typeof raw === 'boolean') p.apps.enabled = raw
      else problems.push('apps.enabled: expected true or false')
      continue
    }
    if (key !== 'default' && !APP_ID.test(key)) { problems.push(`apps.${key}: unknown key (expected enabled, default or an app id such as meshcentral)`); continue }
    const m = appModeSchema.safeParse(raw)
    if (!m.success) { problems.push(`apps.${key}: expected auto, manual or off`); continue }
    if (key === 'default') p.apps.default = m.data
    else p.apps.providers[key] = m.data
  }
  problems.push(...composeProblems(p, []))
  if (f.check?.enabled !== undefined) p.check.enabled = f.check.enabled
  if (f.check?.cron)                  p.check.cron = f.check.cron
  if (f.check?.reminder_days)         p.check.reminderDays = f.check.reminder_days
  for (const [key, raw] of Object.entries(f.clusters ?? {})) {
    if (key === 'home' || key.trim().toLowerCase() === 'home cluster') {
      problems.push(`clusters.${key}: the home cluster is configured at the top level of this file, not under clusters`)
      continue
    }
    try { p.remotes[key] = parseRemoteSection(raw ?? {}, ['clusters', key]) }
    catch (e: any) { problems.push(e.message) }
  }
  if (problems.length) throw new Error(problems.join('; '))
  return p
}

function composeProblems(p: Policy, prefix: string[]): string[] {
  const out: string[] = []
  for (const [key, g] of Object.entries(p.guests)) {
    if (g.docker === 'auto' && !(g.composeDirs ?? p.guestDefault.composeDirs).length) {
      out.push(`${[...prefix, 'guests', key, 'compose_dirs'].join('.')}: docker: auto needs at least one compose directory`)
    }
  }
  return out
}

/** One remote cluster's section, on top of the built-in remote defaults. Throws with every bad key's path. */
function parseRemoteSection(raw: unknown, at: string[]): Policy {
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${at.join('.')}: expected a mapping`)
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (v === null) delete (raw as Record<string, unknown>)[k]
  const parsed = remoteSectionSchema.safeParse(raw)
  if (!parsed.success) throw new Error(describeIssues(parsed.error, at))
  const f = parsed.data
  const p = remoteDefaultPolicy()
  if (f.ceph?.accepted_warnings)        p.acceptedWarnings = f.ceph.accepted_warnings
  if (f.batch_size)                     p.batchSize = f.batch_size
  if (f.min_root_free_mb !== undefined) p.minRootFreeMb = f.min_root_free_mb
  for (const [name, n] of Object.entries(f.nodes ?? {})) {
    if (name === 'default') p.nodeDefault = { ...p.nodeDefault, ...nodeFrom(n) }
    else p.nodes[name] = nodeFrom(n)
  }
  const problems: string[] = []
  for (const [key, g0] of Object.entries(f.guests ?? {})) {
    if (key === 'exclude') {
      const ex = z.array(z.number().int().positive()).safeParse(g0)
      if (!ex.success) problems.push(describeIssues(ex.error, [...at, 'guests', 'exclude']))
      else p.exclude = ex.data
      continue
    }
    if (key !== 'default' && !/^\d+$/.test(key)) { problems.push(`${[...at, 'guests', key].join('.')}: unknown key (expected default, exclude or a VMID)`); continue }
    const g = guestSchema.safeParse(g0 ?? {})
    if (!g.success) { problems.push(describeIssues(g.error, [...at, 'guests', key])); continue }
    // Apps are not looked for on a remote cluster; the key is accepted and has no effect beyond false.
    if (key === 'default') p.guestDefault = { ...p.guestDefault, ...guestFrom(g.data), apps: false }
    else p.guests[key] = { ...guestFrom(g.data), apps: false }
  }
  problems.push(...composeProblems(p, at))
  if (problems.length) throw new Error(problems.join('; '))
  return p
}

/** Read the policy file. Never throws: a missing or broken file reports why and yields safe defaults. */
export function loadPolicy(path = policyPath()): PolicyLoad {
  let text: string
  try { text = fs.readFileSync(path, 'utf8') }
  catch (e: any) {
    return {
      loaded: false, path, policy: defaultPolicy(), missing: e?.code === 'ENOENT',
      error: e?.code === 'ENOENT' ? 'No policy file — built-in safe defaults apply and runs are refused' : `Cannot read the policy file: ${e.message}`,
    }
  }
  try { return { loaded: true, path, policy: parsePolicy(text) } }
  catch (e: any) { return { loaded: false, path, policy: defaultPolicy(), error: `Policy file rejected: ${e.message}` } }
}

// --- Which policy a cluster gets -------------------------------------------------------

export interface ClusterRefLike { id: string; name: string; kind: 'home' | 'remote' }

/**
 * The policy for one cluster, from one read of the file.
 *
 *   home    the file's top level, exactly as before (its `nodes:` rules, holds and pins included).
 *   remote  `clusters.<id>` or `clusters.<exact name>`; with neither, the built-in remote defaults. Never the
 *           home cluster's `nodes:` or `guests:`, whatever the node names: a remote node called like a home
 *           node gets nothing from it.
 *
 * A file that exists but does not load stops runs everywhere: the section meant for this cluster may be the
 * broken part. No file at all leaves home on its refused-run defaults; a remote then uses its built-in
 * defaults, which are written for exactly that case.
 */
export function policyForCluster(load: PolicyLoad, c: ClusterRefLike): PolicyLoad {
  if (c.kind === 'home') return load
  if (!load.loaded && !load.missing) {
    return { loaded: false, path: load.path, error: load.error, policy: remoteDefaultPolicy(), section: null }
  }
  const key = sectionKeyFor(load.loaded ? load.policy : null, c)
  const notes = ['Scheduled runs are home-only: on this cluster a run starts only when you start it.', 'A node here is never rebooted automatically: a reboot is a separate action you confirm.']
  const remotes = load.loaded ? load.policy.remotes : {}
  if (key && key === c.id && remotes[c.name]) notes.unshift(`clusters.${c.name} is not used: the section keyed by this cluster's id (clusters.${c.id}) applies.`)
  if (key && key !== c.id) notes.unshift(`The section is keyed by this cluster's name. Keying it by the id (clusters.${c.id}) keeps it attached if the cluster is renamed.`)
  if (key) return { loaded: true, path: load.path, policy: remotes[key], section: key, notes }
  return {
    loaded: true, path: load.path, policy: remoteDefaultPolicy(), section: null,
    notes: [`No clusters section for ${c.name}: the built-in remote defaults apply (node apt-get dist-upgrade, as Proxmox recommends; held packages and kernel pins are never touched; guests apt-get upgrade; no reboots).`, ...notes],
  }
}

/** The section a remote uses: the one keyed by its id when there is one, else the one keyed by its exact name. */
export function sectionKeyFor(p: Policy | null, c: ClusterRefLike): string | null {
  if (!p || c.kind !== 'remote') return null
  if (p.remotes[c.id]) return c.id
  return Object.prototype.hasOwnProperty.call(p.remotes, c.name) ? c.name : null
}

/**
 * Renaming a remote must not quietly attach a name-keyed section to it (one written for another server, say,
 * which was renamed or removed). Returns the refusal in words, or null when the rename is fine.
 */
export function renameRefusal(p: Policy | null, c: ClusterRefLike, newName: string): string | null {
  if (!p || c.kind !== 'remote' || newName === c.name) return null
  if (p.remotes[c.id]) return null   // its own id-keyed section applies whatever its name
  if (!Object.prototype.hasOwnProperty.call(p.remotes, newName)) return null
  return `The Updates policy has a section clusters.${newName}, which would then apply to this server. Pick another name, or key that section by this server's id (clusters.${c.id}) in config/updates.yaml first.`
}

/** Section keys that match no cluster HyperProx knows, so a typo is visible on the page. */
export function unmatchedSections(p: Policy, clusters: ClusterRefLike[]): string[] {
  return Object.keys(p.remotes).filter(k => !clusters.some(c => c.kind === 'remote' && (c.id === k || c.name === k))).sort()
}

// --- Questions the rest of the feature asks ------------------------------------------

export function nodePolicy(p: Policy, node: string): NodePolicy {
  const own = p.nodes[node] ?? {}
  // A node that names holds or a pin is protecting a kernel: it never inherits dist-upgrade from the default.
  const guarded = Boolean(own.requirePin || own.requireHolds?.length)
  return {
    ...p.nodeDefault,
    ...own,
    upgrade: own.upgrade ?? (guarded ? 'upgrade' : p.nodeDefault.upgrade),
    requireHolds: own.requireHolds ?? p.nodeDefault.requireHolds ?? [],
  }
}

export interface UpgradeChoice { verb: 'upgrade' | 'dist-upgrade'; note?: string }

/**
 * The upgrade a node actually gets, from its policy AND what is on it. A node seen to have held packages or a
 * pinned kernel gets `apt-get upgrade` (which never adds or removes a package), whatever the default says, unless
 * the policy sets `upgrade: dist-upgrade` for that node BY NAME. Nodes whose holds and pin could not be read get
 * `upgrade` too. Home and remote alike.
 */
export function effectiveUpgrade(p: Policy, node: string, facts: { holds: string[]; pinned: string | null } | null): UpgradeChoice {
  const pol = nodePolicy(p, node)
  if (pol.upgrade !== 'dist-upgrade') return { verb: 'upgrade' }
  if (p.nodes[node]?.upgrade === 'dist-upgrade') return { verb: 'dist-upgrade' }
  if (!facts) return { verb: 'upgrade', note: `${node}: its package holds and kernel pin could not be read, so it gets apt-get upgrade, not dist-upgrade.` }
  const why = [facts.holds.length ? `held packages (${facts.holds.join(', ')})` : '', facts.pinned ? `a pinned kernel (${facts.pinned})` : ''].filter(Boolean)
  if (!why.length) return { verb: 'dist-upgrade' }
  return { verb: 'upgrade', note: `${node} has ${why.join(' and ')}, so it gets apt-get upgrade, not dist-upgrade. To give it dist-upgrade anyway, set upgrade: dist-upgrade for ${node} by name in the policy.` }
}

export function nodePolicyView(p: Policy, node: string): UpdatesNodePolicyView {
  const n = nodePolicy(p, node)
  const v: UpdatesNodePolicyView = { upgrade: n.upgrade, reboot: n.reboot }
  if (n.order) v.order = n.order
  if (n.requireHolds.length) v.requireHolds = n.requireHolds
  if (n.requirePin) v.requirePin = n.requirePin
  return v
}

export function guestPolicy(p: Policy, vmid: number): GuestPolicy & { excluded: boolean } {
  const own = p.guests[String(vmid)] ?? {}
  return {
    ...p.guestDefault,
    ...own,
    composeDirs: own.composeDirs ?? p.guestDefault.composeDirs,
    excluded: p.exclude.includes(vmid),
  }
}

/** How a run treats updates from this app provider. */
export function appMode(p: Policy, providerId: string): AppMode {
  return p.apps.providers[providerId] ?? p.apps.default
}

/** Provider ids the policy names that no installed plug-in provides: a typo there must not pass quietly. */
export function unknownAppProviders(p: Policy, known: string[]): string[] {
  return Object.keys(p.apps.providers).filter(id => !known.includes(id)).sort()
}

export function policyStatus(load: PolicyLoad, now = new Date()): UpdatesPolicyStatus {
  const s = load.policy.schedule
  const enabled = load.loaded && s.enabled
  let next: string | null = null
  if (enabled) {
    try { next = nextRun(s.cron, now)?.toISOString() ?? null } catch { next = null }
  }
  const out: UpdatesPolicyStatus = {
    loaded: load.loaded,
    path:   load.path,
    schedule: { enabled, cron: s.cron, nextRun: next, windowHours: s.windowHours },
  }
  if (load.error) out.error = load.error
  if (load.section !== undefined) out.section = load.section
  if (load.notes?.length) out.notes = load.notes
  return out
}
