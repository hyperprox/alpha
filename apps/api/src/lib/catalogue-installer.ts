// =============================================================================
//  HyperProx — installing what you do not already run
//
//  Creates a container, runs the recipe inside it from the node, checks the
//  service actually answers, and writes the address into the integration that
//  was waiting for it. The last step is the point: an install that leaves you
//  copying a URL into a settings form has done the easy half.
// =============================================================================

import { ProxmoxClient } from './proxmox-client'
import { execInGuest, nodeCredential } from './node-exec'
import { randomBytes, randomUUID } from 'node:crypto'
import { findRecipe, type CatalogueRecipe } from './catalogue'
import { installScript, distroOf, hostEnv, type Distro } from './install-script'
import {
  pickTemplate, pickDownloadable, scoreNodes, recommend, rootStorages, configUsesGpu, pciHasDiscreteGpu,
  nextFreeVmid, deriveVmid, reverseVmid, withOctetDigits, patternProblem, parseCidr, isHostAddress, sameSubnet,
  ipConflicts, liveAddresses, describeSighting,
  type PlacementNode, type PlacementStorage, type NodeVerdict, type VmidRule, type IpSighting,
} from './wizard-placement'
import { archOfKernel, archOfTemplate } from './ai/facts'
import { execOnNode } from './node-exec'
import type { CreatePVE } from './wizard-executor'
import type { ExecResult } from './node-exec'
import { setCredential, setCredentials, getProviderCredentials, vaultWritable } from './credentials'
import { saveSettings, getSettings } from './plugin-host'
import { PLUGINS } from '../plugins'

export type Phase = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface InstallStep {
  id: string; label: string; status: Phase; detail?: string
}

export interface InstallJob {
  jobId:    string
  /** Who started it, as ownerOf() names them; only they can read it. '' is nobody, and nobody can. */
  owner:    string
  recipeId: string
  status:   'running' | 'completed' | 'failed'
  steps:    InstallStep[]
  /** Live output from the recipe, so a five-minute apt run is not a blank screen. */
  log:      string
  vmid?:    number
  node?:    string
  ip?:      string
  url?:     string
  error?:   string
  /**
   * Where the admin login the installer generated is kept, for recipes that take one from the
   * environment. A reference only: the password lives in the vault (masked) and is read from there
   * when the job is fetched. It is never logged and never held in job memory.
   */
  adminCredential?: { user: string; vault: { category: string; provider: string; key: string }; issuedAt: number }
  startedAt: number
  finishedAt?: number
  /** True once Proxmox accepted a create this job asked for: there is a container this job made. */
  created?: boolean
  /** Set once the half-made container was removed on request. */
  removed?: boolean
}

const JOBS = new Map<string, InstallJob>()
export const getInstallJob = (id: string) => JOBS.get(id)

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Everything startInstall reaches outside itself for, so a test can stand in for each. */
export interface InstallDeps {
  client:      CreatePVE & Pick<ProxmoxClient, 'getClusterResources'>
  credential:  (node: string) => Promise<any>
  exec:        (o: { host: string; cred: any; vmid: number; script: string; timeoutMs: number; onData: (c: string) => void }) => Promise<ExecResult>
  probe:       (url: string) => Promise<number | null>
  wait:        (ms: number) => Promise<unknown>
  /** Can the vault be written now (unlocked, with a signed-in session)? Asked before anything is created. */
  vaultOpen:   () => Promise<boolean>
  /** Write several keys of one vault item in a single write. */
  saveSecrets: (category: string, provider: string, values: Record<string, string>) => Promise<void>
  /** Read a vault item's keys, or throw if the vault is locked. */
  readSecrets: (category: string, provider: string) => Promise<Record<string, string>>
}

const realDeps = (): InstallDeps => ({
  client:     pve(),
  credential: node => nodeCredential(node),
  exec:       o => execInGuest(o),
  probe:      url => fetch(url, { signal: AbortSignal.timeout(4000) }).then(r => r.status).catch(() => null),
  wait:       sleep,
  // A read works whenever the vault is unlocked; the save at the install step also needs a session.
  vaultOpen:   async () => vaultWritable(),
  saveSecrets: (c, p, v) => setCredentials(c, p, v),
  readSecrets: (c, p) => getProviderCredentials(c, p),
})

/** How long after an install the generated admin login is still served to the page. */
export const ADMIN_CREDENTIAL_WINDOW_MS = 15 * 60_000

/**
 * The admin login for a finished install, read from the vault, or undefined when the job has none,
 * is no longer fresh, or the vault is locked. The page shows it once; the vault keeps it.
 */
export async function readAdminCredential(
  job: InstallJob,
  deps: Pick<InstallDeps, 'readSecrets'> = realDeps(),
  now: () => number = Date.now,
): Promise<{ user: string; password: string } | undefined> {
  const ref = job.adminCredential
  if (!ref || job.status !== 'completed' || now() - ref.issuedAt > ADMIN_CREDENTIAL_WINDOW_MS) return undefined
  try {
    const password = (await deps.readSecrets(ref.vault.category, ref.vault.provider))[ref.vault.key]
    return password ? { user: ref.user, password } : undefined
  } catch { return undefined }
}

function pve(): ProxmoxClient {
  return new ProxmoxClient(
    process.env.PROXMOX_HOST!,
    Number(process.env.PROXMOX_PORT ?? 8006),
    `${process.env.PROXMOX_USER}!${process.env.PROXMOX_TOKEN_ID}`,
    process.env.PROXMOX_TOKEN_SECRET!,
  )
}

function step(job: InstallJob, id: string): InstallStep {
  const s = job.steps.find(x => x.id === id)!
  s.status = 'running'
  return s
}

// ---------------------------------------------------------------------------
//  Container creation, exactly as a checked plan says
// ---------------------------------------------------------------------------

/** The mark a wizard-made container carries, so a clean-up can prove the container is the one it made. */
export const installMark = (jobId: string) => `hyperprox-install: ${jobId}`

/** net0 for a plan: DHCP, or the static address with its gateway, always behind the Proxmox firewall. */
export function planNet0(plan: Pick<InstallPlan, 'bridge' | 'ip' | 'gateway'>): string {
  const ip = plan.ip === 'dhcp' ? 'ip=dhcp' : `ip=${plan.ip}${plan.gateway ? `,gw=${plan.gateway}` : ''}`
  return `name=eth0,bridge=${plan.bridge},${ip},firewall=1`
}

/**
 * Create the container the plan describes, through the Proxmox API (never by writing a config file).
 * Unprivileged with nesting only: HyperProx signs in with an API token, and Proxmox lets only root@pam
 * create a privileged container or set any other feature flag. `onCreated` fires once Proxmox has accepted
 * the create, so a failure after it knows there is something to clean up.
 */
export async function createFromPlan(
  plan: InstallPlan, recipe: CatalogueRecipe, jobId: string, client: CreatePVE, onCreated: () => void = () => {},
): Promise<void> {
  const enc = encodeURIComponent
  if (plan.downloadTemplate) {
    const m = /^([^:]+):vztmpl\/(.+)$/.exec(plan.template)
    if (!m) throw new Error(`"${plan.template}" is not a template volume.`)
    await client.waitForTask(plan.node, await client.downloadTemplate(plan.node, m[1], m[2]), { timeoutMs: 15 * 60_000 })
  }
  const body = new URLSearchParams()
  const set = (k: string, v: string | number) => body.set(k, String(v))
  set('vmid', plan.vmid); set('hostname', plan.hostname); set('ostemplate', plan.template)
  set('storage', plan.storage); set('rootfs', `${plan.storage}:${plan.diskGb}`)
  set('memory', plan.memoryMb); set('swap', plan.swapMb); set('cores', plan.cores)
  set('net0', planNet0(plan))
  if (plan.dns) set('nameserver', plan.dns)
  set('unprivileged', 1); set('features', 'nesting=1'); set('onboot', 1); set('start', 1)
  set('password', randomBytes(18).toString('base64url') + 'Aa1')
  set('description', `${recipe.name}, installed by HyperProx on ${new Date().toISOString().slice(0, 10)}.\n${installMark(jobId)}`)
  const upid = await client.fetchStrict<string>(`/nodes/${enc(plan.node)}/lxc`, 'POST', body.toString())
  onCreated()
  await client.waitForTask(plan.node, upid, { timeoutMs: 5 * 60_000 })
}

async function waitRunning(d: InstallDeps, node: string, vmid: number): Promise<void> {
  const client = d.client
  for (let i = 0; i < 24; i++) {
    await d.wait(5000)
    const st = await client.fetchNode<any>(`/nodes/${node}/lxc/${vmid}/status/current`).catch(() => null)
    if (st?.status === 'running') return
  }
  throw new Error(`CT ${vmid} did not start within two minutes.`)
}

async function waitAddress(d: InstallDeps, node: string, vmid: number): Promise<string | undefined> {
  const client = d.client
  for (let i = 0; i < 12; i++) {
    await d.wait(5000)
    const ifs = await client.fetchNode<any[]>(`/nodes/${node}/lxc/${vmid}/interfaces`).catch(() => [])
    const ip  = (ifs ?? []).find((f: any) => f.name === 'eth0')?.inet?.split('/')[0]
    if (ip && !ip.startsWith('169.254')) return ip
  }
  return undefined
}

// ---------------------------------------------------------------------------
//  Wiring the result back into whatever was waiting for it
// ---------------------------------------------------------------------------

async function wireUp(recipe: CatalogueRecipe, url: string): Promise<string> {
  if (!recipe.satisfies) return 'Nothing to configure — this one stands alone.'

  const { kind, id, setting } = recipe.satisfies
  if (kind === 'credential') {
    // Category is inferred from the recipe, not guessed: proxy creds live under
    // 'proxy', AI ones under 'ai'.
    const category = recipe.category === 'ai' ? 'ai' : 'proxy'
    await setCredential(category, id, setting, url, false)
    return `Wrote ${category}/${id}/${setting}. It is configured, not merely installed.`
  }

  const plugin = PLUGINS.find(p => p.manifest.id === id)
  if (!plugin) return `Installed, but no ${id} plug-in is present to configure.`
  const existing = await getSettings(id).catch(() => ({} as Record<string, string>))
  await saveSettings(plugin.manifest, { ...existing, [setting]: url })
  return `Set ${id}.${setting}. Open the plug-in to finish anything it still needs.`
}

// ---------------------------------------------------------------------------

/**
 * Prove an install into an existing container can finish before anything runs. New containers do not come
 * through here: they are planned by the wizard (previewInstall) and created by applyPreview, so nothing is
 * ever placed on a node or given an ID the person did not see first.
 */
async function preflight(d: InstallDeps, intoVmid: number): Promise<{ node: string; vmid: number }> {
  const all = await d.client.getClusterResources('vm')
  const g = (all as any[]).find(r => Number(r.vmid) === intoVmid && r.type === 'lxc')
  if (!g) throw new Error(`CT ${intoVmid} was not found. Only containers can be used, not VMs.`)
  if (g.status !== 'running') throw new Error(`CT ${intoVmid} is not running.`)
  if (!await d.credential(g.node).catch(() => null)) {
    throw new Error(`CT ${intoVmid} is on ${g.node}, which has no SSH login stored. ` +
                    `Add one on the Catalogue page and try again.`)
  }
  return { node: g.node, vmid: Number(g.vmid) }
}

const STEPS = (recipe: CatalogueRecipe, first: string): InstallStep[] => [
  { id: 'container', label: first, status: 'pending' },
  { id: 'network',   label: 'Wait for an address',   status: 'pending' },
  { id: 'install',   label: `Install ${recipe.name}`, status: 'pending' },
  { id: 'verify',    label: 'Check it answers',       status: 'pending' },
  { id: 'wire',      label: 'Configure the integration', status: 'pending' },
]

/** Install a recipe into a container that already exists. */
export async function startInstall(opts: {
  recipeId: string
  /** The container to install into. New containers are made through previewInstall and applyPreview. */
  intoVmid?: number
  /** ownerOf() the request; the job is readable by this owner only. */
  owner?: string
}, over: Partial<InstallDeps> = {}): Promise<InstallJob> {
  const deps: InstallDeps = { ...realDeps(), ...over }
  const recipe = findRecipe(opts.recipeId)
  if (!recipe) throw new Error(`No recipe called ${opts.recipeId}`)
  if (typeof opts.intoVmid !== 'number') {
    throw new Error('A new container is planned in the install wizard first: preview it, then apply that preview.')
  }

  // Throws before a job exists, so a refusal is an error the caller sees rather
  // than a job that fails asynchronously three minutes later.
  if (recipe.firstRun.kind === 'env-admin' && !await deps.vaultOpen()) {
    throw new Error(`${recipe.name} gets a generated admin password, which is saved in the vault, and the vault is locked. Sign in to unlock it and try again.`)
  }
  const target = await preflight(deps, opts.intoVmid)
  const job = newJob(recipe, opts.owner ?? '', `Use CT ${opts.intoVmid}`)
  void runJob(job, recipe, deps, async () => {
    job.vmid = target.vmid; job.node = target.node
    const cfg = await deps.client.fetchNode<any>(`/nodes/${target.node}/lxc/${target.vmid}/config`).catch(() => null)
    const distro = distroOf(String(cfg?.ostype ?? ''))
    if (!distro) {
      throw new Error(`CT ${target.vmid} is ${cfg?.ostype ? `"${cfg.ostype}"` : 'of unknown type'}, which is neither Debian nor Ubuntu; HyperProx installs only on those.`)
    }
    return { distro }
  })
  return job
}

function newJob(recipe: CatalogueRecipe, owner: string, first: string): InstallJob {
  const job: InstallJob = {
    jobId: randomUUID(), owner, recipeId: recipe.id, status: 'running', log: '', startedAt: Date.now(),
    steps: STEPS(recipe, first),
  }
  JOBS.set(job.jobId, job)
  return job
}

/**
 * The install itself, after the container step. `container` makes or finds the container, sets job.vmid
 * and job.node, and returns its distro and (for a static plan) its address.
 */
async function runJob(
  job: InstallJob, recipe: CatalogueRecipe, deps: InstallDeps,
  container: () => Promise<{ distro: Distro; ip?: string }>,
): Promise<void> {
  try {
    // 1. A container to put it in.
    const s1 = step(job, 'container')
    const { distro, ip: fixedIp } = await container()
    s1.status = 'done'
    s1.detail = `CT ${job.vmid} on ${job.node}`

    // 2. An address, so the health check and the integration have somewhere to point.
    const s2 = step(job, 'network')
    job.ip = await waitAddress(deps, job.node!, job.vmid!) ?? fixedIp
    if (fixedIp && job.ip !== fixedIp) {
      throw new Error(`CT ${job.vmid} came up as ${job.ip}, not the ${fixedIp} it was planned with.`)
    }
    s2.status = job.ip ? 'done' : 'skipped'
    s2.detail = job.ip ?? 'no address yet — DHCP may still be running'

    // 3. The recipe itself, run from the node.
    const s3 = step(job, 'install')
    const cred = await deps.credential(job.node!)
    if (!cred) {
      throw new Error(
        `No SSH login stored for node ${job.node}. HyperProx runs the install with ` +
        `\`pct exec\` from the node, which needs one. Add it under Settings → Nodes.`)
    }
    const nodeIp = await nodeAddress(deps.client, job.node!)
    // A recipe that takes its admin login from the environment gets a generated one. It travels in
    // the script and the job result only; it is not logged, and the output tail below is the
    // script's own output, which never echoes it.
    const admin = recipe.firstRun.kind === 'env-admin'
      ? { user: recipe.firstRun.user, password: randomBytes(18).toString('base64url') } : undefined
    // Before the vault write: a container with no address fails here, leaving nothing saved.
    const env: Record<string, string> = { ...hostEnv(recipe, { ip: job.ip }) }
    if (recipe.firstRun.kind === 'env-admin' && admin) {
      env[recipe.firstRun.passwordEnv] = admin.password
      if (recipe.firstRun.userEnv) env[recipe.firstRun.userEnv] = admin.user
      // Saved before the install runs: a password that exists only in a script that already ran
      // is a lockout. If the vault write fails, nothing is installed.
      await deps.saveSecrets('apps', `${recipe.id}-${job.vmid}`, { admin_user: admin.user, admin_password: admin.password })
    }
    const run = await deps.exec({
      host: nodeIp, cred, vmid: job.vmid!, script: installScript(recipe, distro, env),
      timeoutMs: 20 * 60_000,
      onData: chunk => { job.log = (job.log + chunk).slice(-20_000) },
    })
    if (run.timedOut) throw new Error('The install ran for twenty minutes without finishing.')
    if (run.code !== 0) throw new Error(`The install script exited ${run.code}. See the log below.`)
    s3.status = 'done'

    // 4. Listening is not the same as serving.
    const s4 = step(job, 'verify')
    const url = job.ip ? `http://${job.ip}:${recipe.port}` : ''
    if (url) {
      let ok = false
      for (let i = 0; i < 10 && !ok; i++) {
        await deps.wait(3000)
        const status = await deps.probe(url + recipe.healthPath)
        ok = status !== null && recipe.expectStatus.includes(status)
      }
      s4.status = ok ? 'done' : 'failed'
      s4.detail = ok ? `${url} is answering` : `${url} did not answer yet — it may still be starting`
      job.url = url
    } else {
      s4.status = 'skipped'
      s4.detail = 'no address to check'
    }

    // 5. Hand it to whatever was waiting for it.
    const s5 = step(job, 'wire')
    s5.detail = url ? await wireUp(recipe, url) : 'no address, so nothing was configured'
    s5.status = url ? 'done' : 'skipped'

    if (admin) job.adminCredential = { user: admin.user, vault: { category: 'apps', provider: `${recipe.id}-${job.vmid}`, key: 'admin_password' }, issuedAt: Date.now() }
    job.status = 'completed'
  } catch (e: any) {
    job.status = 'failed'
    job.error  = e.message
    const running = job.steps.find(s => s.status === 'running')
    if (running) { running.status = 'failed'; running.detail = e.message }
  } finally {
    job.finishedAt = Date.now()
  }
}

/** Node name to address. Names are not reliably resolvable from a container. */
async function nodeAddress(client: Pick<CreatePVE, 'fetchNode'>, node: string): Promise<string> {
  const status = await client.fetchNode<any[]>('/cluster/status').catch(() => [])
  const row = (status ?? []).find((r: any) => r.type === 'node' && r.name === node)
  if (!row?.ip) throw new Error(`Could not find an address for node ${node}.`)
  return row.ip
}

// =============================================================================
//  The install wizard: what the cluster looks like, a checked plan, a
//  server-held preview, and an apply that takes only the preview's id
//
//  Nothing here picks a node or an ID behind the person's back. The wizard reads
//  the cluster, recommends, and the person chooses. The plan is checked when it
//  is previewed and again, against a fresh read, when it is applied: an ID or an
//  address taken in between refuses the apply before anything is created.
// =============================================================================

export interface BridgeView { iface: string; cidr?: string; gateway?: string; prefix?: number }

export interface NodeView extends PlacementNode {
  address?:  string
  bridges:   BridgeView[]
  /** The node currently running the HA manager, when HA is in use. */
  haMaster?: boolean
  /** HA-managed guests on this node. */
  haGuests:  number
  /** What the GPU flag rests on, in words, when there is one. */
  gpuSource?: string
}

export interface GuestView {
  vmid: number; node: string; type: 'lxc' | 'qemu'; name: string; status: string
  config: Record<string, unknown> | null
}

export interface ClusterView {
  nodes:    NodeView[]
  storages: PlacementStorage[]
  guests:   GuestView[]
  /** What /cluster/nextid answers: the lowest free ID in the cluster's configured range. */
  nextId?:  number
  /** Sources that could not be read, by name. A check that needed one says so instead of passing. */
  partial:  string[]
}

export interface InstallPlan {
  recipeId: string
  node:     string
  vmid:     number
  hostname: string
  cores:    number
  memoryMb: number
  swapMb:   number
  diskGb:   number
  storage:  string
  bridge:   string
  /** 'dhcp', or a static address in CIDR form. */
  ip:       string
  gateway?: string
  /** Space-separated DNS servers; empty uses the node's. */
  dns?:     string
  /** Resolved when the preview is made: the template volume the container is created from. */
  template: string
  /** The template is not on the node yet and is downloaded first. */
  downloadTemplate?: boolean
  unprivileged: true
}

export type WizardInput = Omit<InstallPlan, 'template' | 'downloadTemplate' | 'unprivileged'>

export interface Preview {
  id:        string
  owner:     string
  plan:      InstallPlan
  /** What was checked, in words, so the review screen can show it. */
  checks:    string[]
  warnings:  string[]
  createdAt: number
  expiresAt: number
  used:      boolean
}

export interface WizardDeps extends InstallDeps {
  /** Does anything answer a ping on `ip`, asked from `node`? null when it could not be asked. */
  ping(node: string, ip: string): Promise<boolean | null>
  readRule(): Promise<VmidRule>
  saveRule(rule: VmidRule): Promise<void>
  now(): number
}

export const PREVIEW_TTL_MS = 10 * 60_000
const PREVIEWS = new Map<string, Preview>()
/** IDs an apply is creating right now, so two applies cannot race to the same one. */
const CREATING = new Set<number>()

const RULE_CATEGORY = 'catalogue', RULE_PROVIDER = 'wizard', RULE_KEY = 'vmid_rule'

export function parseRule(raw: unknown): VmidRule {
  try {
    const r = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (r?.kind === 'pattern' && typeof r.pattern === 'string' && !patternProblem(r.pattern)) return { kind: 'pattern', pattern: r.pattern.trim() }
  } catch { /* fall through */ }
  return { kind: 'next-free' }
}

function wizardDeps(over: Partial<WizardDeps> = {}): WizardDeps {
  return {
    ...realDeps(),
    ping: async (node, ip) => {
      if (!parseCidr(`${ip}/32`)) return null
      const cred = await nodeCredential(node).catch(() => null)
      if (!cred) return null
      const host = await nodeAddress(pve(), node).catch(() => '')
      if (!host) return null
      // The address is checked to be four octets above; nothing else reaches the command line.
      const r = await execOnNode({ host, cred, command: `ping -c 2 -W 1 ${ip} >/dev/null 2>&1 && echo up || echo down`, timeoutMs: 15_000 })
        .catch(() => null)
      if (!r) return null
      return /\bup\b/.test(r.output) ? true : /\bdown\b/.test(r.output) ? false : null
    },
    readRule: async () => parseRule((await getProviderCredentials(RULE_CATEGORY, RULE_PROVIDER).catch(() => ({} as Record<string, string>)))[RULE_KEY]),
    saveRule: async rule => setCredential(RULE_CATEGORY, RULE_PROVIDER, RULE_KEY, JSON.stringify(rule), false),
    now: Date.now,
    ...over,
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]) }
  }))
  return out
}

/**
 * The cluster as placement needs it, read fresh. The node list and the guest list must be read, or
 * nothing can be placed safely; everything else that fails is named in `partial`.
 */
export async function readCluster(
  client: Pick<CreatePVE, 'fetchStrict'>, hasLogin: (node: string) => Promise<boolean>,
): Promise<ClusterView> {
  const enc = encodeURIComponent
  const partial: string[] = []
  const soft = <T>(name: string, p: Promise<T>): Promise<T | null> =>
    p.then(v => v ?? null, () => null).then(v => { if (v == null) partial.push(name); return v })

  const [rawNodes, resources] = await Promise.all([
    client.fetchStrict<any[]>('/nodes'),
    client.fetchStrict<any[]>('/cluster/resources?type=vm'),
  ])
  const [status, ha, nextId] = await Promise.all([
    soft('cluster-status', client.fetchStrict<any[]>('/cluster/status')),
    // No HA configured answers an empty list; a refusal is only a missing extra.
    client.fetchStrict<any[]>('/cluster/ha/status/current').catch(() => [] as any[]),
    client.fetchStrict<number | string>('/cluster/nextid').then(Number).catch(() => undefined),
  ])
  const addr: Record<string, string> = {}
  for (const r of status ?? []) if (r?.type === 'node' && r.name && r.ip) addr[r.name] = r.ip
  const haMaster = (ha ?? []).find((r: any) => r?.type === 'master')?.node as string | undefined
  const haGuests: Record<string, number> = {}
  for (const r of ha ?? []) if (r?.type === 'service' && r.node) haGuests[r.node] = (haGuests[r.node] ?? 0) + 1

  const guestRows = (resources ?? []).filter((r: any) => r?.vmid && (r.type === 'lxc' || r.type === 'qemu'))
  const guests: GuestView[] = await mapLimit(guestRows, 8, async (r: any) => ({
    vmid: Number(r.vmid), node: String(r.node), type: r.type, name: String(r.name ?? ''), status: String(r.status ?? ''),
    config: await soft(`config:${Number(r.vmid)}`, client.fetchStrict<Record<string, unknown>>(`/nodes/${enc(r.node)}/${r.type}/${Number(r.vmid)}/config`)),
  }))

  const storages: PlacementStorage[] = []
  const nodes: NodeView[] = await Promise.all((rawNodes ?? []).map(async (n: any): Promise<NodeView> => {
    const online = n.status === 'online'
    const mine = guests.filter(g => g.node === n.node)
    const gpuGuest = mine.find(g => configUsesGpu(g.config))
    const v: NodeView = {
      node: String(n.node), online, cores: Number(n.maxcpu ?? 0),
      cpuLoad: typeof n.cpu === 'number' ? n.cpu : undefined,
      memTotalMb: Math.round(Number(n.maxmem ?? 0) / 1048576), memUsedMb: Math.round(Number(n.mem ?? 0) / 1048576),
      runningGuests: mine.filter(g => g.status === 'running').length,
      hasGpu: Boolean(gpuGuest), gpuSource: gpuGuest ? `a GPU is passed through to guest ${gpuGuest.vmid}` : undefined,
      address: addr[n.node], bridges: [], haMaster: haMaster ? haMaster === n.node : undefined, haGuests: haGuests[n.node] ?? 0,
    }
    if (!online) return v
    const [stor, net, pci, login] = await Promise.all([
      soft(`storage:${n.node}`, client.fetchStrict<any[]>(`/nodes/${enc(n.node)}/storage`)),
      soft(`network:${n.node}`, client.fetchStrict<any[]>(`/nodes/${enc(n.node)}/network`)),
      // Reading the PCI bus needs more than audit rights on some setups; guest passthrough still counts.
      client.fetchStrict<any[]>(`/nodes/${enc(n.node)}/hardware/pci`).catch(() => null),
      hasLogin(n.node).catch(() => { partial.push(`login:${n.node}`); return false }),
    ])
    v.hasLogin = login
    if (pciHasDiscreteGpu(pci)) { v.hasGpu = true; v.gpuSource = 'an NVIDIA GPU is on its PCI bus' }
    for (const s of stor ?? []) {
      storages.push({
        storage: String(s.storage), node: v.node, type: String(s.type ?? ''),
        content: String(s.content ?? '').split(',').filter(Boolean),
        active: Boolean(s.active) && s.enabled !== 0, shared: Boolean(s.shared),
        freeGb: Math.floor(Number(s.avail ?? 0) / 1073741824), totalGb: Math.floor(Number(s.total ?? 0) / 1073741824),
      })
    }
    v.bridges = (net ?? []).filter((x: any) => x?.type === 'bridge' || x?.type === 'OVSBridge').map((x: any) => {
      const c = typeof x.cidr === 'string' ? parseCidr(x.cidr) : null
      const gw = typeof x.gateway === 'string' && parseCidr(`${x.gateway}/32`) ? x.gateway : undefined
      return { iface: String(x.iface), ...(c ? { cidr: x.cidr, prefix: c.prefix } : {}), ...(gw ? { gateway: gw } : {}) }
    }).sort((a: BridgeView, b: BridgeView) => a.iface.localeCompare(b.iface))
    return v
  }))
  return { nodes, storages, guests, partial, ...(nextId && Number.isSafeInteger(nextId) ? { nextId } : {}) }
}

/** Addresses running guests report: LXC interfaces, and the QEMU guest agent where it is enabled. */
export async function readLiveAddresses(
  client: Pick<CreatePVE, 'fetchStrict'>, guests: GuestView[],
): Promise<Array<{ vmid: number; name: string; addresses: string[] }>> {
  const enc = encodeURIComponent
  const running = guests.filter(g => g.status === 'running' &&
    (g.type === 'lxc' || /^(1|enabled=1)/.test(String(g.config?.agent ?? ''))))
  return mapLimit(running, 8, async g => {
    const path = g.type === 'lxc'
      ? `/nodes/${enc(g.node)}/lxc/${g.vmid}/interfaces`
      : `/nodes/${enc(g.node)}/qemu/${g.vmid}/agent/network-get-interfaces`
    const answer = await client.fetchStrict<unknown>(path, 'GET', undefined, 8000).catch(() => null)
    return { vmid: g.vmid, name: g.name, addresses: liveAddresses(answer) }
  })
}

export interface Need { cores: number; memoryMb: number; diskGb: number; storage?: string }

/** The node table and the recommendation for one recipe at one size. */
export function placementFor(recipe: CatalogueRecipe, need: Need, view: ClusterView): {
  nodes: Array<NodeView & { verdict: NodeVerdict; rootStorages: PlacementStorage[] }>
  recommendation: { node: string; reason: string; storage: string } | null
} {
  const verdicts = scoreNodes(view.nodes, view.storages, { ...need, needsGpu: recipe.needsGpu })
  const byNode = new Map(view.nodes.map(n => [n.node, n]))
  return {
    nodes: verdicts.map(v => ({ ...byNode.get(v.node)!, verdict: v, rootStorages: rootStorages(view.storages, v.node) })),
    recommendation: recommend(verdicts, view.nodes),
  }
}

const usedIds = (view: ClusterView) => view.guests.map(g => g.vmid)
/** The next ID no CT or VM has, from where the cluster's own next-ID range starts. */
export const nextIdOf = (view: ClusterView) => nextFreeVmid(usedIds(view), view.nextId ?? 100)

export interface IdentityAnswer {
  /** The ID to offer: the rule's, or the next free one. */
  suggestedVmid:  number
  rule:           VmidRule
  vmid?:          { value: number; free: boolean; problem?: string }
  /** With the pattern rule: the ID the node and address give. */
  derived?:       { vmid?: number; taken?: boolean; problem?: string }
  /** With the pattern rule and an ID typed in: the node and address it stands for. */
  reverse?:       { node?: string; ip?: string; problem?: string }
  ip?:            { value: string; problems: string[]; pinged: boolean | null }
  bridges:        BridgeView[]
}

/** What the identity step shows as the person types: ID suggestion, the pattern both ways, address checks. */
export async function checkIdentity(input: {
  node: string; bridge?: string; vmid?: number; ip?: string; gateway?: string
}, view: ClusterView, rule: VmidRule, live: Array<{ vmid: number; name: string; addresses: string[] }>,
  ping: (node: string, ip: string) => Promise<boolean | null>,
): Promise<IdentityAnswer> {
  const used = usedIds(view)
  const node = view.nodes.find(n => n.node === input.node)
  const bridge = node?.bridges.find(b => b.iface === input.bridge) ?? node?.bridges[0]
  const staticIp = input.ip && input.ip !== 'dhcp' ? input.ip : undefined
  const out: IdentityAnswer = { suggestedVmid: nextIdOf(view), rule, bridges: node?.bridges ?? [] }

  if (rule.kind === 'pattern') {
    const d = deriveVmid(rule.pattern, { node: input.node, ip: staticIp })
    if ('vmid' in d) {
      out.derived = { vmid: d.vmid, taken: used.includes(d.vmid) }
      if (!out.derived.taken) out.suggestedVmid = d.vmid
      else out.derived.problem = `The pattern gives ${d.vmid}, which another guest already has.`
    } else out.derived = { problem: d.error }
    if (typeof input.vmid === 'number') {
      const r = reverseVmid(rule.pattern, input.vmid, view.nodes.map(n => n.node))
      if ('error' in r) out.reverse = { problem: r.error }
      else {
        const base = staticIp ?? bridge?.gateway ?? bridge?.cidr
        const ip = r.octetDigits && r.width && base ? withOctetDigits(base.split('/')[0], r.octetDigits, r.width) : undefined
        const prefix = bridge?.prefix ?? (staticIp ? parseCidr(staticIp)?.prefix : undefined)
        out.reverse = { node: r.node, ...(ip ? { ip: prefix ? `${ip}/${prefix}` : ip } : {}),
          ...(r.octetDigits && !ip ? { problem: 'The ID gives address digits, but there is no address on the bridge to put them in.' } : {}) }
      }
    }
  }

  if (typeof input.vmid === 'number') out.vmid = idVerdict(input.vmid, used)

  if (staticIp) {
    const problems = addressProblems(staticIp, input.gateway, bridge, view, live)
    const c = parseCidr(staticIp)
    const pinged = c && !problems.length ? await ping(input.node, c.ip).catch(() => null) : null
    if (pinged) problems.push(describeSighting({ ip: c!.ip, source: 'ping' }))
    out.ip = { value: staticIp, problems, pinged }
  }
  return out
}

function idVerdict(vmid: number, used: number[]): { value: number; free: boolean; problem?: string } {
  if (!Number.isSafeInteger(vmid) || vmid < 100 || vmid > 999_999_999) {
    return { value: vmid, free: false, problem: `${vmid} is not a legal ID (Proxmox allows 100 to 999999999).` }
  }
  if (used.includes(vmid)) return { value: vmid, free: false, problem: `ID ${vmid} is already used by another guest (CT or VM). ${nextFreeVmid(used, vmid)} is free.` }
  return { value: vmid, free: true }
}

/** Why a static address cannot be used here, in words. Empty when nothing is wrong with it. */
function addressProblems(
  cidr: string, gateway: string | undefined, bridge: BridgeView | undefined, view: ClusterView,
  live: Array<{ vmid: number; name: string; addresses: string[] }>,
): string[] {
  const c = parseCidr(cidr)
  if (!c) return [`"${cidr}" is not an address with a prefix, like 192.0.2.50/24.`]
  const out: string[] = []
  if (gateway) {
    if (!parseCidr(`${gateway}/32`)) out.push(`"${gateway}" is not an IPv4 address.`)
    else if (!sameSubnet(c.ip, gateway, c.prefix)) out.push(`${gateway} is not on the ${c.ip}/${c.prefix} network.`)
    else if (!isHostAddress(c.ip, gateway, c.prefix)) out.push(`${c.ip} is the network, broadcast or gateway address of that network.`)
  }
  const unread = view.partial.filter(p => p.startsWith('config:'))
  if (unread.length) out.push(`HyperProx could not read every guest's settings (${unread.length} unread), so it cannot promise ${c.ip} is free.`)
  const seen: IpSighting[] = ipConflicts(c.ip, {
    configs: view.guests.map(g => ({ vmid: g.vmid, name: g.name, config: g.config })),
    live, nodes: view.nodes.map(n => ({ node: n.node, ip: n.address })),
  })
  for (const s of seen) out.push(describeSighting(s))
  if (bridge?.cidr && !gateway) {
    const b = parseCidr(bridge.cidr)
    if (b && !sameSubnet(c.ip, b.ip, b.prefix)) out.push(`${c.ip} is not on ${bridge.iface}'s network (${bridge.cidr}).`)
  }
  return out
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const DNS_LIST = /^\s*\d{1,3}(\.\d{1,3}){3}(\s*[ ,]\s*\d{1,3}(\.\d{1,3}){3})*\s*$/

/** Every value of a plan held against the cluster as it is now. Errors refuse; warnings are shown. */
export function checkPlan(
  input: WizardInput, recipe: CatalogueRecipe, view: ClusterView,
  live: Array<{ vmid: number; name: string; addresses: string[] }>, pinged: boolean | null,
): { errors: string[]; warnings: string[]; checks: string[] } {
  const errors: string[] = [], warnings: string[] = [], checks: string[] = []
  const int = (x: unknown) => typeof x === 'number' && Number.isSafeInteger(x)
  const node = view.nodes.find(n => n.node === input.node)

  // Node.
  if (!node) errors.push(`${input.node || 'No node'} is not a node in this cluster.`)
  else if (!node.online) errors.push(`${node.node} is not online.`)
  else if (node.hasLogin === false) errors.push(`${node.node} has no node login stored, so nothing can be installed there.`)
  else checks.push(`${node.node} is online and HyperProx can sign in to it.`)

  // Sizes.
  if (!int(input.cores) || input.cores < 1) errors.push('Cores must be a whole number, at least 1.')
  else if (node && node.cores > 0 && input.cores > node.cores) errors.push(`${node.node} has ${node.cores} cores; ${input.cores} were asked for.`)
  if (!int(input.memoryMb) || input.memoryMb < 64) errors.push('RAM must be a whole number of MB, at least 64.')
  if (!int(input.swapMb) || input.swapMb < 0) errors.push('Swap must be a whole number of MB, 0 or more.')
  if (!int(input.diskGb) || input.diskGb < 1) errors.push('Disk must be a whole number of GB, at least 1.')
  const min = recipe.minimum
  if (int(input.cores) && input.cores < min.cores) warnings.push(`${input.cores} cores is below the ${min.cores} ${recipe.name} needs.`)
  if (int(input.memoryMb) && input.memoryMb < min.memoryMb) warnings.push(`${input.memoryMb} MB RAM is below the ${min.memoryMb} MB ${recipe.name} needs.`)
  if (int(input.diskGb) && input.diskGb < min.diskGb) warnings.push(`${input.diskGb} GB disk is below the ${min.diskGb} GB ${recipe.name} needs.`)
  if (recipe.needsGpu && node && !node.hasGpu) warnings.push(`${recipe.name} wants a GPU and ${node.node} has none HyperProx can see.`)

  // Room on the node and the storage, now.
  if (node?.online && int(input.memoryMb)) {
    const free = node.memTotalMb - node.memUsedMb
    if (free < input.memoryMb) errors.push(`${node.node} has ${free} MB RAM free; this needs ${input.memoryMb} MB.`)
    else {
      checks.push(`${node.node} has ${free} MB RAM free; ${free - input.memoryMb} MB is left after this.`)
      if (free - input.memoryMb < node.memTotalMb * 0.2) warnings.push(`${node.node} would have less than 20% of its RAM free afterwards.`)
    }
  }
  if (node?.online) {
    if (view.partial.includes(`storage:${node.node}`)) errors.push(`HyperProx could not read the storage on ${node.node}.`)
    const s = view.storages.find(x => x.node === node.node && x.storage === input.storage)
    if (!s) errors.push(`${input.storage || 'No storage'} is not a storage on ${node.node}.`)
    else if (!s.active || !s.content.includes('rootdir')) errors.push(`${s.storage} on ${node.node} cannot hold containers.`)
    else if (int(input.diskGb) && s.freeGb < Math.ceil(input.diskGb * 1.2)) errors.push(`${s.storage} has ${s.freeGb} GB free; this needs ${Math.ceil(input.diskGb * 1.2)} GB.`)
    else {
      checks.push(`${s.storage} (${s.shared ? 'shared' : 'local'}, ${s.type}) has ${s.freeGb} GB free.`)
      if (!s.shared) warnings.push(`${s.storage} is local to ${node.node}: HA cannot start this container on another node.`)
    }
  }

  // ID and name.
  const id = idVerdict(Number(input.vmid), usedIds(view))
  if (!int(input.vmid)) errors.push('Container ID must be a whole number.')
  else if (!id.free) errors.push(id.problem!)
  else if (CREATING.has(input.vmid)) errors.push(`ID ${input.vmid} is being created by another install right now.`)
  else checks.push(`ID ${input.vmid} is not used by any CT or VM.`)
  const host = String(input.hostname ?? '')
  if (!LABEL.test(host)) errors.push(`"${host}" is not a usable hostname: lowercase letters, digits and inner hyphens, up to 63.`)
  else {
    const same = view.guests.find(g => g.name.toLowerCase() === host)
    if (same) errors.push(`${host} is already the name of guest ${same.vmid}.`)
  }

  // Network.
  const bridge = node?.bridges.find(b => b.iface === input.bridge)
  if (node?.online) {
    if (view.partial.includes(`network:${node.node}`)) errors.push(`HyperProx could not read the network on ${node.node}.`)
    else if (!bridge) errors.push(`${node.node} has no bridge called ${input.bridge || '(none)'}.`)
  }
  if (input.ip === 'dhcp') {
    if (input.gateway) errors.push('A gateway is set with DHCP; DHCP gives its own.')
    checks.push('The address comes from DHCP.')
  } else {
    const c = parseCidr(String(input.ip ?? ''))
    if (!c) errors.push(`"${input.ip}" is not an address with a prefix, like 192.0.2.50/24.`)
    else {
      if (!input.gateway) warnings.push('No gateway: the container can reach only its own network.')
      const problems = addressProblems(input.ip, input.gateway, bridge, view, live)
      errors.push(...problems)
      if (pinged) errors.push(describeSighting({ ip: c.ip, source: 'ping' }))
      if (!problems.length) {
        checks.push(`${c.ip} is in no guest config, no running guest reports it, and it is no node's address.`)
        checks.push(pinged === false ? `Nothing answered a ping to ${c.ip} from ${input.node} (a firewalled device would not).`
          : pinged === null ? `${c.ip} could not be pinged from ${input.node}; only the cluster's own records were checked.` : '')
      }
    }
  }
  if (input.dns && !DNS_LIST.test(input.dns)) errors.push(`"${input.dns}" is not a list of IPv4 DNS servers.`)
  else if (input.dns && input.dns.split(/[\s,]+/).some(d => !parseCidr(`${d}/32`))) errors.push(`"${input.dns}" holds an address that is not IPv4.`)

  return { errors, warnings, checks: checks.filter(Boolean) }
}

/** The template to create from on `node`: the newest Debian (then Ubuntu) there, or one to download. */
async function resolveTemplate(client: Pick<CreatePVE, 'fetchStrict'>, node: string, view: ClusterView): Promise<{ template: string; download: boolean } | { error: string }> {
  const enc = encodeURIComponent
  const status = await client.fetchStrict<any>(`/nodes/${enc(node)}/status`).catch(() => null)
  const arch = archOfKernel(status?.['current-kernel']?.machine) || 'amd64'
  const stores = view.storages.filter(s => s.node === node && s.active && s.content.includes('vztmpl'))
  const volids: string[] = []
  for (const s of stores) {
    const list = await client.fetchStrict<any[]>(`/nodes/${enc(node)}/storage/${enc(s.storage)}/content?content=vztmpl`).catch(() => [])
    for (const c of list ?? []) if (c?.volid) volids.push(c.volid)
  }
  const local = pickTemplate(volids.filter(v => archOfTemplate(v) === arch), arch)
  if (local) return { template: local, download: false }
  const offered = await client.fetchStrict<any[]>(`/nodes/${enc(node)}/aplinfo`).catch(() => [])
  const dl = pickDownloadable((offered ?? []).filter((a: any) => archOfTemplate(String(a?.template ?? a?.package ?? '')) === arch))
  if (dl && stores[0]) return { template: `${stores[0].storage}:vztmpl/${dl}`, download: true }
  return { error: `No Debian or Ubuntu template on ${node}, and none can be downloaded to it. Download one in Proxmox first — local storage → CT Templates → Templates.` }
}

/** Thrown by applyPreview; `code` says how the route answers. */
export class WizardRefusal extends Error {
  constructor(message: string, public code: 'not-found' | 'expired' | 'used' | 'changed', public problems: string[] = []) { super(message) }
}

/** Check a plan against the cluster now and hold it, server-side, under an id. Nothing is created. */
export async function previewInstall(
  input: WizardInput, owner: string, over: Partial<WizardDeps> = {},
): Promise<{ preview?: Preview; errors: string[]; warnings: string[]; checks: string[] }> {
  const deps = wizardDeps(over)
  const recipe = findRecipe(input.recipeId)
  if (!recipe) return { errors: [`No recipe called ${input.recipeId}.`], warnings: [], checks: [] }
  if (!owner) return { errors: ['Sign in to install.'], warnings: [], checks: [] }
  const { view, live, pinged } = await freshRead(input, deps)
  const r = checkPlan(input, recipe, view, live, pinged)
  if (recipe.firstRun.kind === 'env-admin' && !await deps.vaultOpen()) {
    r.errors.push(`${recipe.name} gets a generated admin password, which is saved in the vault, and the vault is locked. Sign in to unlock it.`)
  }
  if (r.errors.length) return r
  const t = await resolveTemplate(deps.client, input.node, view)
  if ('error' in t) return { ...r, errors: [t.error] }
  if (t.download) r.warnings.push(`The template ${t.template.split('/').pop()} is downloaded to ${input.node} first.`)
  r.checks.push(`Created from ${t.template.split('/').pop()}.`)

  const now = deps.now()
  for (const [k, p] of PREVIEWS) if (p.expiresAt < now - PREVIEW_TTL_MS) PREVIEWS.delete(k)
  const preview: Preview = {
    id: randomUUID(), owner, checks: r.checks, warnings: r.warnings, createdAt: now, expiresAt: now + PREVIEW_TTL_MS, used: false,
    plan: {
      recipeId: recipe.id, node: input.node, vmid: input.vmid, hostname: input.hostname,
      cores: input.cores, memoryMb: input.memoryMb, swapMb: input.swapMb, diskGb: input.diskGb,
      storage: input.storage, bridge: input.bridge, ip: input.ip,
      ...(input.ip !== 'dhcp' && input.gateway ? { gateway: input.gateway } : {}),
      ...(input.dns ? { dns: input.dns.trim().split(/[\s,]+/).join(' ') } : {}),
      template: t.template, ...(t.download ? { downloadTemplate: true } : {}), unprivileged: true,
    },
  }
  PREVIEWS.set(preview.id, preview)
  return { preview, ...r }
}

async function freshRead(input: Pick<WizardInput, 'node' | 'ip'>, deps: WizardDeps) {
  const view = await readCluster(deps.client, async n => Boolean(await deps.credential(n)))
  const staticIp = input.ip && input.ip !== 'dhcp' ? parseCidr(input.ip) : null
  const live = staticIp ? await readLiveAddresses(deps.client, view.guests) : []
  const pinged = staticIp ? await deps.ping(input.node, staticIp.ip).catch(() => null) : null
  return { view, live, pinged }
}

export const getPreview = (id: string, owner: string): Preview | undefined => {
  const p = PREVIEWS.get(id)
  return p && owner && p.owner === owner ? p : undefined
}

/**
 * Create and install exactly what preview `id` holds, after checking it all again against a fresh read.
 * The only input is the id: a plan cannot be edited between the review screen and the create.
 */
export async function applyPreview(id: string, owner: string, over: Partial<WizardDeps> = {}): Promise<InstallJob> {
  const deps = wizardDeps(over)
  const p = PREVIEWS.get(id)
  if (!p || !owner || p.owner !== owner) throw new WizardRefusal('No such preview.', 'not-found')
  if (p.used) throw new WizardRefusal('This preview was already applied. Make a new one.', 'used')
  if (deps.now() > p.expiresAt) throw new WizardRefusal('This preview has expired. Review the plan again.', 'expired')
  p.used = true
  const plan = p.plan
  const recipe = findRecipe(plan.recipeId)!

  const { view, live, pinged } = await freshRead(plan, deps)
  const r = checkPlan(plan, recipe, view, live, pinged)
  if (recipe.firstRun.kind === 'env-admin' && !await deps.vaultOpen()) r.errors.push('The vault is locked, so the generated admin password could not be kept.')
  if (r.errors.length) {
    throw new WizardRefusal('The cluster changed since the preview, so nothing was created.', 'changed', r.errors)
  }
  if (CREATING.has(plan.vmid)) throw new WizardRefusal('Another install is creating that ID now.', 'changed', [`ID ${plan.vmid} is being created.`])
  CREATING.add(plan.vmid)

  const job = newJob(recipe, owner, `Create CT ${plan.vmid} (${plan.hostname}) on ${plan.node}`)
  job.vmid = plan.vmid; job.node = plan.node
  void runJob(job, recipe, deps, async () => {
    try {
      await createFromPlan(plan, recipe, job.jobId, deps.client, () => { job.created = true })
    } finally { CREATING.delete(plan.vmid) }
    await waitRunning(deps, plan.node, plan.vmid)
    const distro = distroOf(plan.template)
    if (!distro) throw new Error(`${plan.template} is neither Debian nor Ubuntu.`)
    return { distro, ...(plan.ip !== 'dhcp' ? { ip: parseCidr(plan.ip)!.ip } : {}) }
  })
  return job
}

/**
 * Remove the container a failed install made. Only a container this job created, still carrying this
 * job's mark, not under HA, and only after the install failed. Anything else is refused.
 */
export async function removeFailedInstall(jobId: string, owner: string, over: Partial<WizardDeps> = {}): Promise<string> {
  const deps = wizardDeps(over)
  const enc = encodeURIComponent
  const job = JOBS.get(jobId)
  if (!job || !owner || job.owner !== owner) throw new WizardRefusal('No such install job.', 'not-found')
  if (job.status !== 'failed') throw new WizardRefusal('Only a failed install can be cleaned up.', 'changed')
  if (job.removed) throw new WizardRefusal('Its container was already removed.', 'used')
  if (!job.created || !job.vmid || !job.node) throw new WizardRefusal('This install did not create a container, so there is nothing of its own to remove.', 'changed')
  const base = `/nodes/${enc(job.node)}/lxc/${job.vmid}`
  const cfg = await deps.client.fetchStrict<Record<string, unknown>>(`${base}/config`)
  if (!String(cfg?.description ?? '').includes(installMark(job.jobId))) {
    throw new WizardRefusal(`CT ${job.vmid} does not carry this install's mark, so HyperProx will not remove it.`, 'changed')
  }
  const ha = await deps.client.fetchStrict<any[]>('/cluster/ha/resources').catch(() => [] as any[])
  if ((ha ?? []).some((h: any) => h?.sid === `ct:${job.vmid}`)) {
    throw new WizardRefusal(`CT ${job.vmid} is managed by HA now; remove it from HA first.`, 'changed')
  }
  const st = await deps.client.fetchStrict<any>(`${base}/status/current`)
  if (st?.status === 'running') {
    await deps.client.waitForTask(job.node, await deps.client.fetchStrict<string>(`${base}/status/stop`, 'POST'), { timeoutMs: 2 * 60_000 })
  }
  await deps.client.waitForTask(job.node,
    await deps.client.fetchStrict<string>(`${base}?purge=1&destroy-unreferenced-disks=1`, 'DELETE'), { timeoutMs: 5 * 60_000 })
  const left = await deps.client.fetchStrict<any[]>('/cluster/resources?type=vm')
  if ((left ?? []).some((r: any) => Number(r?.vmid) === job.vmid)) throw new Error(`CT ${job.vmid} is still listed after the removal.`)
  job.removed = true
  return `CT ${job.vmid} was removed from ${job.node}.`
}

/** The ID rule setting. */
export const readVmidRule = (over: Partial<WizardDeps> = {}) => wizardDeps(over).readRule()
export async function saveVmidRule(raw: unknown, over: Partial<WizardDeps> = {}): Promise<VmidRule> {
  const r: any = raw
  if (r?.kind === 'pattern') {
    const bad = patternProblem(String(r.pattern ?? ''))
    if (bad) throw new Error(bad)
  } else if (r?.kind !== 'next-free') throw new Error('The rule is "next-free" or "pattern".')
  const rule = parseRule(r)
  await wizardDeps(over).saveRule(rule)
  return rule
}

/** Read the cluster for the placement and identity steps, with the deps the routes use. */
export async function wizardView(over: Partial<WizardDeps> = {}) {
  const deps = wizardDeps(over)
  return { deps, view: await readCluster(deps.client, async n => Boolean(await deps.credential(n))) }
}
