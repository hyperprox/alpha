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
}).strict()

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
    accepted_warnings: z.array(z.string().regex(/^[A-Z0-9_]+$/, 'a Ceph health code, e.g. POOL_NO_REDUNDANCY')).optional(),
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
}

export const SAFE_NODE_DEFAULT: NodePolicy = { upgrade: 'upgrade', reboot: 'manual', requireHolds: [] }
export const SAFE_GUEST_DEFAULT: GuestPolicy = { apt: true, docker: 'none', reboot: 'never', composeDirs: [] }

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
  }
}

export interface PolicyLoad {
  loaded: boolean
  path:   string
  error?: string
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
  for (const [key, g] of Object.entries(p.guests)) {
    if (g.docker === 'auto' && !(g.composeDirs ?? p.guestDefault.composeDirs).length) {
      problems.push(`guests.${key}.compose_dirs: docker: auto needs at least one compose directory`)
    }
  }
  if (problems.length) throw new Error(problems.join('; '))
  return p
}

/** Read the policy file. Never throws: a missing or broken file reports why and yields safe defaults. */
export function loadPolicy(path = policyPath()): PolicyLoad {
  let text: string
  try { text = fs.readFileSync(path, 'utf8') }
  catch (e: any) {
    return {
      loaded: false, path, policy: defaultPolicy(),
      error: e?.code === 'ENOENT' ? 'No policy file — built-in safe defaults apply and runs are refused' : `Cannot read the policy file: ${e.message}`,
    }
  }
  try { return { loaded: true, path, policy: parsePolicy(text) } }
  catch (e: any) { return { loaded: false, path, policy: defaultPolicy(), error: `Policy file rejected: ${e.message}` } }
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
  return out
}
