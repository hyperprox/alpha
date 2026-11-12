// =============================================================================
//  HyperProx — installing what you do not already run
//
//  Creates a container, runs the recipe inside it from the node, checks the
//  service actually answers, and writes the address into the integration that
//  was waiting for it. The last step is the point: an install that leaves you
//  copying a URL into a settings form has done the easy half.
// =============================================================================

import { ProxmoxClient } from './proxmox-client'
import { ownHeaders } from './own-user-agent'
import { execInGuest, nodeCredential } from './node-exec'
import { randomBytes, randomUUID } from 'node:crypto'
import { findRecipe, checkOptions, healthProblem, type CatalogueRecipe } from './catalogue'
import { installScript, distroOf, hostEnv, type Distro } from './install-script'
import {
  pickTemplate, pickDownloadable, scoreNodes, recommend, rootStorages, excludedRootStorages, configGpuKind, pciGpus, ROOTFS_EXCLUDED,
  nextFreeVmid, deriveVmid, reverseVmid, octetFromDigits, patternProblem, parseCidr, isHostAddress, sameSubnet,
  ipConflicts, liveAddresses, describeSighting,
  type PlacementNode, type PlacementStorage, type NodeVerdict, type VmidRule, type IpSighting,
} from './wizard-placement'
import { archOfKernel, archOfTemplate } from './ai/facts'
import {
  arrPreview, arrPrepare, arrInstallEnv, arrRunSetup, arrJobSteps, arrCleanup, arrFinishSeerr, stopApps, stoppedSentence, realHttp, localAddressTo,
  type ArrDeps, type ArrPublishInput, type ArrPublishPlan,
} from './arr/catalogue'
import { execOnNode } from './node-exec'
import type { CreatePVE } from './wizard-executor'
import type { ExecResult } from './node-exec'
import { setCredential, setCredentials, getProviderCredentials, vaultWritable, deleteProviderCredentials } from './credentials'
import { saveSettings, getSettings } from './plugin-host'
import { PLUGINS } from '../plugins'
import { wizardStore } from './catalogue-store'
import { pbsSetupDeps, pbsSetupNodeRunner } from './pbs/setup-deps'
import { PBS_SETUP_STEPS, pbsPreviewChecks, runPbsSetup, scriptEnv as pbsScriptEnv, type SetupDeps as PbsSetupDeps } from './pbs/catalogue'
import { bindMountpoint, cleanNfsSource, mountScript, unmountScript, DATASTORE_BASE } from './pbs/nfs'
import {
  GHOST_SETUP_STEPS, ghostOverShell, runGhostSetup, ghostPreview, ghostInstallEnv, dropPendingSmtp, type GhostHttp, type Shell,
} from './ghost/setup'
import { mailWanted } from './ghost/recipe'
import {
  planPublish, runPublish, cleanupPublish, recordSite, realPublishDeps, PUBLISH_STEPS,
  type PublishDeps, type PublishPlan, type PublishLedger, type PublishInput,
} from './sites'

export type Phase = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface InstallStep {
  id: string; label: string; status: Phase; detail?: string
}

export interface InstallJob {
  jobId:    string
  /** Who started it, as ownerOf() names them; only they can read it. '' is nobody, and nobody can. */
  owner:    string
  recipeId: string
  /**
   * 'interrupted': HyperProx restarted while its create mark was held, so its container may exist and clean-up
   * is offered (the mark checks decide). 'unknown': the store said running but had no create mark, so how it
   * ended cannot be told; no clean-up is offered, because it may be a finished, working service.
   */
  status:   'running' | 'completed' | 'failed' | 'interrupted' | 'unknown'
  /** Set when the job's final state could not be saved to the store. */
  storeError?: string
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
  /** An Arr Stack's NAS mount on its node, recorded before it is made; clean-up undoes it. */
  arrHostMount?: { node: string; vmid: number }
  /** What an Arr Stack's public names made, per app. Clean-up removes only these. */
  arrLedgers?: Record<string, PublishLedger>
  /** An Arr Stack whose Seerr waits for a Plex server: "Finish Seerr" connects it later. */
  arrSeerrWaiting?: boolean
  /** What was set on an Arr Stack's container over the node login (keyctl, tun, the library), in words. */
  arrPrepared?: string
  /** An Arr Stack's apps and their addresses, for the finished page. */
  arrApps?: Array<{ id: string; name: string; url: string }>
  startedAt: number
  finishedAt?: number
  /** True once Proxmox accepted a create this job asked for: there is a container this job made. */
  created?: boolean
  /** Set once the half-made container was removed on request. */
  removed?: boolean
  /** The vault item holding the generated admin login, and whether this job created it (not merged into one). */
  vaultItem?: { category: string; provider: string; createdByJob: boolean }
  /** The public name this install publishes, as planned. */
  publish?: PublishPlan
  /** What publishing made so far: proxy host, DNS record, certificate. Clean-up removes only these. */
  ledger?: PublishLedger
  /** The Sites entry a finished web install made. */
  siteId?: string
  /** The container's hostname, as planned. */
  hostname?: string
  /** A NAS datastore this job mounted on the container's node (Proxmox Backup Server); clean-up unmounts it. */
  hostMount?: { node: string; vmid: number }
}

const JOBS = new Map<string, InstallJob>()
export const getInstallJob = (id: string) => JOBS.get(id)

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Everything startInstall reaches outside itself for, so a test can stand in for each. */
export interface InstallDeps {
  client:      CreatePVE & Pick<ProxmoxClient, 'getClusterResources'>
  credential:  (node: string) => Promise<any>
  exec:        (o: { host: string; cred: any; vmid: number; script: string; timeoutMs: number; onData: (c: string) => void }) => Promise<ExecResult>
  /** The status at url, or the status and the page (a recipe with healthBody needs the page); null if nothing answered. */
  probe:       (url: string) => Promise<number | { status: number; body: string } | null>
  wait:        (ms: number) => Promise<unknown>
  /** Can the vault be written now (unlocked, with a signed-in session)? Asked before anything is created. */
  vaultOpen:   () => Promise<boolean>
  /** Write several keys of one vault item in a single write. */
  saveSecrets: (category: string, provider: string, values: Record<string, string>) => Promise<void>
  /** Read a vault item's keys, or throw if the vault is locked. */
  readSecrets: (category: string, provider: string) => Promise<Record<string, string>>
  /** The Arr Stack's reach: its apps over HTTP, its node over the login, the plug-in settings (lib/arr). */
  arr?:        () => ArrDeps
  /** Delete a whole vault item. */
  deleteSecrets: (category: string, provider: string) => Promise<void>
  /** DNS, proxy, certificate and the public check, for a plan that publishes. */
  publish:     PublishDeps
  /** Run a script on a node over its saved login (the NFS probe and mount for a backup server's datastore). */
  nodeRun?:    (node: string, script: string, timeoutMs: number) => Promise<{ code: number; output: string }>
  /** Proxmox Backup Server's setup steps reach the new server, the vault, its plug-in and the cluster's storage. */
  pbsSetup?:   () => PbsSetupDeps
  /** Ghost's setup requests, given the site's address and the container's shell (default: curl over pct exec). */
  ghostHttp?:  (url: string, sh: Shell) => GhostHttp
}

const realDeps = (): InstallDeps => ({
  client:     pve(),
  credential: node => nodeCredential(node),
  exec:       o => execInGuest(o),
  probe:      url => fetch(url, { headers: ownHeaders('install-check'), signal: AbortSignal.timeout(4000) })
    .then(async r => ({ status: r.status, body: (await r.text().catch(() => '')).slice(0, 200_000) })).catch(() => null),
  wait:       sleep,
  arr:        realArrDeps,
  // A read works whenever the vault is unlocked; the save at the install step also needs a session.
  vaultOpen:   async () => vaultWritable(),
  saveSecrets: (c, p, v) => setCredentials(c, p, v),
  readSecrets: (c, p) => getProviderCredentials(c, p),
  deleteSecrets: (c, p) => deleteProviderCredentials(c, p),
  nodeRun:     pbsSetupNodeRunner,
  pbsSetup:    () => pbsSetupDeps(pve()),
  publish: realPublishDeps(),
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
  void persistJob(job).catch(() => {})
  return s
}

/** How long a finished job is kept, in the store and in memory, so its result and clean-up stay reachable. */
export const JOB_KEEP_MS = 7 * 24 * 3600_000

/** Each job's writes, chained so they reach the store in the order they were made. */
const CHAINS = new Map<string, Promise<void>>()

/**
 * Whether a job's row may be pruned after JOB_KEEP_MS: only when nothing it made can still be out there.
 * Finished jobs, cleaned or confirmed-gone ones, and failed ones that created nothing. A job whose container
 * may exist (running, interrupted, failed after creating, or of unknown outcome) is kept until it is cleaned up.
 */
export function jobPrunable(job: Pick<InstallJob, 'status' | 'created' | 'removed'>): boolean {
  if (job.removed) return true
  if (job.status === 'completed') return true
  return job.status === 'failed' && !job.created
}

/**
 * Write the job to the store. Writes for one job are chained, so a slow early write can never land after a
 * later one. The log is kept short there; the live tail stays in memory. The promise rejects when the write
 * fails: the final write is awaited and its failure recorded on the job, never swallowed.
 */
export function persistJob(job: InstallJob): Promise<void> {
  const data = structuredClone({ ...job, log: job.log.slice(-4000) })
  const expiresAt = jobPrunable(job) ? new Date(job.startedAt + JOB_KEEP_MS) : null
  const prev = CHAINS.get(job.jobId) ?? Promise.resolve()
  const write = prev.then(() => wizardStore().put({ id: job.jobId, kind: 'job', owner: job.owner, data, expiresAt }))
  const tail = write.catch(() => {})
  CHAINS.set(job.jobId, tail)
  void tail.then(() => { if (CHAINS.get(job.jobId) === tail) CHAINS.delete(job.jobId) })
  return write
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
  // Proxmox Backup Server's datastore: a disk of its own on the same storage (left out of vzdump: backups of
  // backups), or a NAS export the node mounts, given to the container after the create, before its first start.
  const pbs = recipe.setup === 'pbs' ? plan.options ?? {} : null
  if (pbs?.PBS_LOCATION === 'disk') set('mp0', `${plan.storage}:${Number(pbs.PBS_SIZE_GB)},mp=${DATASTORE_BASE}/${pbs.PBS_DATASTORE},backup=0`)
  set('unprivileged', 1); set('features', 'nesting=1'); set('onboot', 1); set('start', pbs?.PBS_LOCATION === 'nas' ? 0 : 1)
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

/** Exported for tests. */
export async function wireUp(recipe: CatalogueRecipe, url: string): Promise<string> {
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
  // Only the non-secret settings go back in: passing a stored secret back would make every save look like it
  // re-entered the credential, which is exactly what settingsChangeProblem refuses to assume.
  const existing = await getSettings(id).catch(() => ({} as Record<string, string>))
  const secrets = new Set(plugin.manifest.settings.filter(x => x.type === 'secret').map(x => x.key))
  const plain = Object.fromEntries(Object.entries(existing).filter(([k]) => !secrets.has(k)))
  await saveSettings(plugin.manifest, { ...plain, [setting]: url })
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

const STEPS = (recipe: CatalogueRecipe, first: string, publish?: PublishPlan): InstallStep[] => [
  { id: 'container', label: first, status: 'pending' },
  { id: 'network',   label: 'Wait for an address',   status: 'pending' },
  { id: 'install',   label: `Install ${recipe.name}`, status: 'pending' },
  ...(recipe.setup === 'pbs' ? PBS_SETUP_STEPS.map(x => ({ ...x, status: 'pending' as Phase })) : [
    ...(recipe.setup === 'ghost' ? GHOST_SETUP_STEPS.map(x => ({ id: x.id, label: x.label, status: 'pending' as Phase })) : []),
    { id: 'verify',    label: 'Check it answers',       status: 'pending' as Phase },
    { id: 'wire',      label: 'Configure the integration', status: 'pending' as Phase },
  ]),
  ...(publish ? PUBLISH_STEPS.map(s => ({ id: s.id, label: s.label, status: 'pending' as Phase })) : []),
]

/** Install a recipe into a container that already exists. */
export async function startInstall(opts: {
  recipeId: string
  /** The container to install into. New containers are made through previewInstall and applyPreview. */
  intoVmid?: number
  /** ownerOf() the request; the job is readable by this owner only. */
  owner?: string
  /** The recipe's options, checked here like the wizard checks them. */
  options?: Record<string, unknown>
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
  const opt = checkOptions(recipe, opts.options)
  if (opt.errors.length) throw new Error(opt.errors.join(' '))
  // Only a wizard preview puts an SMTP password in the vault; a reference sent here is never used.
  if (recipe.setup === 'ghost') opt.values.GHOST_SMTP_REF = ''
  const target = await preflight(deps, opts.intoVmid)
  const job = newJob(recipe, opts.owner ?? '', `Use CT ${opts.intoVmid}`)
  void persistJob(job).catch(() => {})
  void runJob(job, recipe, deps, async () => {
    job.vmid = target.vmid; job.node = target.node
    const cfg = await deps.client.fetchNode<any>(`/nodes/${target.node}/lxc/${target.vmid}/config`).catch(() => null)
    const distro = distroOf(String(cfg?.ostype ?? ''))
    if (!distro) {
      throw new Error(`CT ${target.vmid} is ${cfg?.ostype ? `"${cfg.ostype}"` : 'of unknown type'}, which is neither Debian nor Ubuntu; HyperProx installs only on those.`)
    }
    return { distro }
  }, () => {}, { options: opt.values })
  return job
}

function newJob(recipe: CatalogueRecipe, owner: string, first: string, publish?: PublishPlan): InstallJob {
  const job: InstallJob = {
    jobId: randomUUID(), owner, recipeId: recipe.id, status: 'running', log: '', startedAt: Date.now(),
    steps: STEPS(recipe, first, publish), ...(publish ? { publish, ledger: {} } : {}),
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
  onSettled: () => Promise<void> | void = () => {},
  ctx: { options?: Record<string, string>; publish?: PublishPlan; arrPublish?: ArrPublishPlan[] } = {},
): Promise<void> {
  const options = ctx.options ?? {}
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
    const fr = recipe.firstRun
    const admin = fr.kind === 'env-admin'
      ? { user: (fr.userOption && options[fr.userOption]) || fr.user, password: randomBytes(18).toString('base64url') } : undefined
    // More generated secrets (a database password, say): into the script and the vault, never onto the page.
    const extra = fr.kind === 'env-admin'
      ? (fr.secrets ?? []).map(x => ({ ...x, value: randomBytes(24).toString('base64url') })) : []
    // Before the vault write: a container with no address fails here, leaving nothing saved.
    // Options first, so nothing the installer sets can be replaced by one.
    const env: Record<string, string> = { ...options, ...hostEnv(recipe, { ip: job.ip }), ...(recipe.setup === 'pbs' ? pbsScriptEnv() : {}) }
    // Ghost: its url (the public https:// name, or the container's own address), ghost.env and the SMTP password,
    // which moves from the preview's vault item into the site's own.
    const ghost = recipe.setup === 'ghost' ? await ghostInstallEnv({ options, domain: ctx.publish?.domain, ip: job.ip }, deps) : null
    if (ghost) Object.assign(env, ghost.env)
    if (fr.kind === 'env-admin' && admin) {
      env[fr.passwordEnv] = admin.password
      if (fr.userEnv) env[fr.userEnv] = admin.user
      for (const x of extra) env[x.env] = x.value
      // Saved before the install runs: a password that exists only in a script that already ran
      // is a lockout. If the vault write fails, nothing is installed. Whether the item already existed is
      // recorded first, so a clean-up deletes only an item this job made.
      const provider = `${recipe.id}-${job.vmid}`
      const before = await deps.readSecrets('apps', provider).catch(() => null)
      const createdByJob = before !== null && Object.keys(before).length === 0
      await deps.saveSecrets('apps', provider, {
        admin_user: admin.user, admin_password: admin.password,
        ...Object.fromEntries(extra.map(x => [x.vaultKey, x.value])),
        ...(ghost?.vault ?? {}),
      })
      job.vaultItem = { category: 'apps', provider, createdByJob }
      await persistJob(job).catch(() => {})
      if (ghost?.pendingRef) await dropPendingSmtp(ghost.pendingRef, deps)
    }
    // The Arr Stack's compose file, folders and VPN login (moved from the preview's vault item to the stack's own).
    if (recipe.stack === 'arr') Object.assign(env, await arrInstallEnv({ owner: job.owner, options, vault: job.vaultItem }, deps))
    // The Arr Stack's shell in its container, and the stop that every failure after `docker compose up` runs first:
    // an app Compose already started may have no sign-in yet.
    const arrSh = (script: string, timeoutMs: number) => deps.exec({ host: nodeIp, cred, vmid: job.vmid!, script, timeoutMs, onData: () => {} })
    const arrStopContainer = async () => {
      const base = `/nodes/${encodeURIComponent(job.node!)}/lxc/${job.vmid}`
      await deps.client.waitForTask(job.node!, await deps.client.fetchStrict<string>(`${base}/status/stop`, 'POST'), { timeoutMs: 2 * 60_000 })
      return (await deps.client.fetchStrict<any>(`${base}/status/current`))?.status === 'stopped'
    }
    const arrFail = async (msg: string): Promise<never> => { throw new Error(`${msg} ${stoppedSentence(await stopApps(arrSh, arrStopContainer))}`) }
    const run = await deps.exec({
      host: nodeIp, cred, vmid: job.vmid!, script: installScript(recipe, distro, env),
      timeoutMs: 20 * 60_000,
      onData: chunk => { job.log = (job.log + chunk).slice(-20_000) },
    })
    if (run.timedOut) { const m = 'The install ran for twenty minutes without finishing.'; if (recipe.stack === 'arr') return await arrFail(m); throw new Error(m) }
    if (run.code !== 0) { const m = `The install script exited ${run.code}. See the log below.`; if (recipe.stack === 'arr') return await arrFail(m); throw new Error(m) }
    s3.status = 'done'

    // Proxmox Backup Server: its own setup steps (certificate pin, health, tokens, plug-in, optional storage).
    if (recipe.setup === 'pbs') {
      if (!job.ip) throw new Error('The backup server has no address, so its setup cannot reach it.')
      if (!admin || !deps.pbsSetup) throw new Error('The backup server\'s setup is not available here.')
      const out = await runPbsSetup({
        ip: job.ip, vmid: job.vmid!, hostname: `PBS ${job.vmid}`,
        datastore: options.PBS_DATASTORE, rootPassword: admin.password, installLog: job.log, addStorage: options.PBS_ADD_STORAGE === '1',
        vault: { category: 'apps', provider: `${recipe.id}-${job.vmid}` },
      }, id => step(job, id), deps.pbsSetup())
      job.url = out.url
      job.adminCredential = { user: admin.user, vault: { category: 'apps', provider: `${recipe.id}-${job.vmid}`, key: 'admin_password' }, issuedAt: Date.now() }
      job.status = 'completed'
      return
    }

    // 4. Listening is not the same as serving.
    // The Arr Stack proves each app itself, then does its setup chores (lib/arr/setup.ts) in place of the wiring.
    if (recipe.stack === 'arr') {
      if (!job.ip || !admin || !job.vaultItem) return await arrFail('The Arr Stack needs its address and its vault item to be set up.')
      const s0 = job.steps.find(x => x.id === 'container')
      if (s0 && job.arrPrepared) s0.detail = `${s0.detail}: ${job.arrPrepared}`
      const out = await arrRunSetup({
        ip: job.ip, owner: job.owner, options, admin, vault: { category: job.vaultItem.category, provider: job.vaultItem.provider },
        publish: ctx.arrPublish, recipe, ledgers: (job.arrLedgers ??= {}), save: () => { void persistJob(job).catch(() => {}) },
      }, id => step(job, id), {
        arr: deps.arr, wait: deps.wait, publish: deps.publish, saveSecrets: deps.saveSecrets, readSecrets: deps.readSecrets,
        sh: arrSh, stopContainer: arrStopContainer,
      })
      job.url = out.url
      job.arrApps = out.apps
      if (job.steps.find(x => x.id === 'arr-seerr')?.status === 'skipped') job.arrSeerrWaiting = true
      job.adminCredential = { user: admin.user, vault: { category: job.vaultItem.category, provider: job.vaultItem.provider, key: 'admin_password' }, issuedAt: Date.now() }
      job.status = 'completed'
      return
    }
    // Ghost: the owner, the title, HyperProx's Admin API key and mail, over the container's loopback. A failure stops
    // Ghost and nginx (lib/ghost/setup.ts), so its setup is never left waiting.
    if (recipe.setup === 'ghost') {
      if (!admin || !job.vaultItem || !ghost) throw new Error('Ghost needs its generated owner password and its vault item to be set up.')
      const sh: Shell = (script, timeoutMs) => deps.exec({ host: nodeIp, cred, vmid: job.vmid!, script, timeoutMs, onData: () => {} })
      const base = `/nodes/${encodeURIComponent(job.node!)}/lxc/${job.vmid}`
      await runGhostSetup({
        url: ghost.env.GHOST_URL, owner: { name: options.GHOST_OWNER_NAME, email: admin.user, password: admin.password },
        title: options.GHOST_TITLE, description: options.GHOST_DESCRIPTION ?? '', mail: mailWanted(options),
        vault: { category: job.vaultItem.category, provider: job.vaultItem.provider },
      }, id => step(job, id), {
        http: (deps.ghostHttp ?? ghostOverShell)(ghost.env.GHOST_URL, sh), sh, wait: deps.wait, saveSecrets: deps.saveSecrets, now: Date.now,
        stopContainer: async () => {
          await deps.client.waitForTask(job.node!, await deps.client.fetchStrict<string>(`${base}/status/stop`, 'POST'), { timeoutMs: 2 * 60_000 })
          return (await deps.client.fetchStrict<any>(`${base}/status/current`))?.status === 'stopped'
        },
      })
    }

    const s4 = step(job, 'verify')
    const url = job.ip ? `http://${job.ip}:${recipe.port}` : ''
    if (url) {
      let ok = false, why = 'did not answer'
      for (let i = 0; i < 10 && !ok; i++) {
        await deps.wait(3000)
        const r = await deps.probe(url + recipe.healthPath)
        const problem = r === null ? healthProblem(recipe, null)
          : typeof r === 'number' ? healthProblem(recipe, r) : healthProblem(recipe, r.status, r.body)
        ok = problem === null
        if (problem) why = problem
      }
      s4.status = ok ? 'done' : 'failed'
      s4.detail = ok ? `${url}${recipe.healthPath} is answering` : `${url}${recipe.healthPath} ${why} — it may still be starting`
      job.url = url
    } else {
      s4.status = 'skipped'
      s4.detail = 'no address to check'
    }

    // 5. Hand it to whatever was waiting for it.
    const s5 = step(job, 'wire')
    s5.detail = url ? await wireUp(recipe, url) : 'no address, so nothing was configured'
    s5.status = url ? 'done' : 'skipped'

    // 6. Publishing: only a service that answers on its own address gets a public name.
    if (ctx.publish) {
      if (s4.status !== 'done' || !job.ip) throw new Error(`${recipe.name} did not answer on its own address, so it was not published.`)
      job.ledger ??= {}
      job.url = await runPublish(ctx.publish, recipe, job.ip, job.owner, job.ledger,
        { step: id => step(job, id), save: () => { void persistJob(job).catch(() => {}) } }, deps.publish)
    }

    if (admin) job.adminCredential = { user: admin.user, vault: { category: 'apps', provider: `${recipe.id}-${job.vmid}`, key: 'admin_password' }, issuedAt: Date.now() }
    if (recipe.category === 'web' && job.vmid && job.node) {
      job.siteId = job.jobId
      await recordSite({
        id: job.jobId, recipeId: recipe.id, name: ctx.publish?.domain ?? `${recipe.name} on CT ${job.vmid}`,
        vmid: job.vmid, node: job.node, ip: job.ip,
        ...(ctx.publish ? { domain: ctx.publish.domain, url: `https://${ctx.publish.domain}` } : {}),
        ...(url ? { localUrl: url } : {}),
        ...(job.vaultItem ? { vault: { category: job.vaultItem.category, provider: job.vaultItem.provider } } : {}),
        ...(admin ? { adminUser: admin.user } : {}),
        jobId: job.jobId, owner: job.owner, createdAt: Date.now(),
        ...(job.hostname ? { hostname: job.hostname } : {}),
        ...(job.ledger && ctx.publish ? { published: structuredClone(job.ledger) } : {}),
      }).catch(e => { job.storeError = `The site was installed but could not be listed under Sites: ${e.message}` })
    }
    job.status = 'completed'
  } catch (e: any) {
    job.status = 'failed'
    job.error  = e.message
    const running = job.steps.find(s => s.status === 'running')
    if (running) { running.status = 'failed'; running.detail = e.message }
  } finally {
    job.finishedAt = Date.now()
    try { await persistJob(job) }
    catch (e: any) {
      job.storeError = `The result of this install could not be saved: ${e.message}. After a restart HyperProx will not know how it ended.`
      console.error(`[catalogue] job ${job.jobId}: ${job.storeError}`)
    }
    await Promise.resolve(onSettled()).catch(() => {})
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
  igpuSource?: string
}

export interface GuestView {
  vmid: number; node: string; type: 'lxc' | 'qemu'; name: string; status: string
  /** The RAM the guest may use, as configured. */
  maxmemMb?: number
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
  /**
   * The person ticked "I checked this address" for exactly these unknowns (live:<vmid>, cluster-status): some
   * sources could not be read, so the static address could not be proven free by HyperProx alone. A tick
   * covers only what it lists; anything more unknown at apply is refused and asked again.
   */
  addressAck?: string[]
  /** The recipe's options, checked and with defaults filled in. Not secrets: those are generated at install. */
  options?: Record<string, string>
  /** The public name, DNS record, proxy host and certificate this install makes, exactly as checked. */
  publish?: PublishPlan
  /** An Arr Stack's public names, one per app, each checked like a website's. */
  arrPublish?: ArrPublishPlan[]
  unprivileged: true
}

export type WizardInput = Omit<InstallPlan, 'template' | 'downloadTemplate' | 'unprivileged' | 'publish' | 'options' | 'arrPublish'> & {
  options?: Record<string, unknown>
  /** An Arr Stack's VPN login. Never kept in the plan: the preview puts it in the vault. */
  arrVpn?: Record<string, unknown>
  /** An Arr Stack's public names: one zone, one proxy, a name per app. Checked into `arrPublish` by the preview. */
  arrNames?: ArrPublishInput
  /** Publish it: the zone, the name in it and the proxy. Checked into a PublishPlan by the preview. */
  publish?: PublishInput
  /** Ghost's SMTP password. Never kept in the plan: the preview puts it in the vault. */
  ghostSmtpPassword?: unknown
}

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
/** Open previews kept at once, across everyone. Beyond it a new preview is refused until some expire. */
export const PREVIEW_CAP = 200
/** Swap ceiling: twice the RAM, and never more than 8 GB. */
export const swapCeiling = (memoryMb: number) => Math.min(Math.max(0, memoryMb) * 2, 8192)
/**
 * IDs an apply is creating, held from the create until its job settles, so two applies cannot race to one.
 * Mirrored in the store (kind "creating"), so after a restart an interrupted job is known to have maybe created.
 */
const CREATING = new Set<number>()
/** Preview ids being applied right now: checked and set with no await between, so a preview applies once. */
const APPLYING = new Set<string>()

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
    maxmemMb: Math.round(Number(r.maxmem ?? 0) / 1048576),
    config: await soft(`config:${Number(r.vmid)}`, client.fetchStrict<Record<string, unknown>>(`/nodes/${enc(r.node)}/${r.type}/${Number(r.vmid)}/config`)),
  }))

  const storages: PlacementStorage[] = []
  const nodes: NodeView[] = await Promise.all((rawNodes ?? []).map(async (n: any): Promise<NodeView> => {
    const online = n.status === 'online'
    const mine = guests.filter(g => g.node === n.node)
    const gpuGuest = mine.find(g => configGpuKind(g.config) === 'discrete')
    const igpuGuest = mine.find(g => configGpuKind(g.config) === 'integrated')
    const running = mine.filter(g => g.status === 'running')
    const v: NodeView = {
      node: String(n.node), online, cores: Number(n.maxcpu ?? 0),
      cpuLoad: typeof n.cpu === 'number' ? n.cpu : undefined,
      memTotalMb: Math.round(Number(n.maxmem ?? 0) / 1048576), memUsedMb: Math.round(Number(n.mem ?? 0) / 1048576),
      memCommittedMb: running.reduce((t, g) => t + (g.maxmemMb ?? 0), 0),
      runningGuests: running.length,
      hasGpu: Boolean(gpuGuest), gpuSource: gpuGuest ? `a GPU is passed through to guest ${gpuGuest.vmid}` : undefined,
      hasIgpu: Boolean(igpuGuest), igpuSource: igpuGuest ? `/dev/dri is given to guest ${igpuGuest.vmid}` : undefined,
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
    const bus = pciGpus(pci)
    if (bus.discrete) { v.hasGpu = true; v.gpuSource = 'a GPU card is on its PCI bus' }
    if (bus.integrated) { v.hasIgpu = true; v.igpuSource = 'integrated graphics are on its PCI bus' }
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

/** What running guests report, and which could not be asked. */
export interface LiveRead {
  seen:    Array<{ vmid: number; name: string; addresses: string[] }>
  /** Running guests whose live address is unknown: the read failed, or a VM has no guest agent. */
  unknown: Array<{ vmid: number; name: string; why: 'no guest agent' | 'read failed' }>
}

/**
 * Addresses running guests report: LXC interfaces, and the QEMU guest agent where it is enabled. A read that
 * fails, and a running VM with no agent, are unknown, never "no address": either may hold the address.
 */
export async function readLiveAddresses(client: Pick<CreatePVE, 'fetchStrict'>, guests: GuestView[]): Promise<LiveRead> {
  const enc = encodeURIComponent
  const out: LiveRead = { seen: [], unknown: [] }
  const running = guests.filter(g => g.status === 'running')
  for (const g of running) {
    if (g.type === 'qemu' && !/^(1|enabled=1)/.test(String(g.config?.agent ?? ''))) out.unknown.push({ vmid: g.vmid, name: g.name, why: 'no guest agent' })
  }
  const asked = running.filter(g => g.type === 'lxc' || /^(1|enabled=1)/.test(String(g.config?.agent ?? '')))
  await mapLimit(asked, 8, async g => {
    const path = g.type === 'lxc'
      ? `/nodes/${enc(g.node)}/lxc/${g.vmid}/interfaces`
      : `/nodes/${enc(g.node)}/qemu/${g.vmid}/agent/network-get-interfaces`
    const answer = await client.fetchStrict<unknown>(path, 'GET', undefined, 8000).catch(() => null)
    if (answer == null) out.unknown.push({ vmid: g.vmid, name: g.name, why: 'read failed' })
    else out.seen.push({ vmid: g.vmid, name: g.name, addresses: liveAddresses(answer) })
  })
  out.unknown.sort((a, b) => a.vmid - b.vmid)
  return out
}

/** Name the unknown live reads in `view.partial` as live:<vmid>, so every source that was not read is listed. */
export function notePartial(view: ClusterView, live: LiveRead): void {
  for (const u of live.unknown) if (!view.partial.includes(`live:${u.vmid}`)) view.partial.push(`live:${u.vmid}`)
}

export interface Need { cores: number; memoryMb: number; diskGb: number; storage?: string }

/** The node table and the recommendation for one recipe at one size. */
export function placementFor(recipe: CatalogueRecipe, need: Need, view: ClusterView): {
  nodes: Array<NodeView & { verdict: NodeVerdict; rootStorages: PlacementStorage[]; excludedStorages: Array<PlacementStorage & { reason: string }> }>
  recommendation: { node: string; reason: string; storage: string } | null
} {
  const verdicts = scoreNodes(view.nodes, view.storages, { ...need, needsGpu: recipe.needsGpu, wantsGpu: recipe.wantsGpu })
  const byNode = new Map(view.nodes.map(n => [n.node, n]))
  return {
    nodes: verdicts.map(v => ({ ...byNode.get(v.node)!, verdict: v, rootStorages: rootStorages(view.storages, v.node),
      excludedStorages: excludedRootStorages(view.storages, v.node) })),
    recommendation: recommend(verdicts, view.nodes),
  }
}

const usedIds = (view: ClusterView) => view.guests.map(g => g.vmid)
/** The next ID no CT or VM has, from where the cluster's own next-ID range starts. */
export const nextIdOf = (view: ClusterView) => nextFreeVmid(usedIds(view), view.nextId ?? 100)

export interface AddressCheck {
  value:    string
  /** Reasons the address cannot be used. */
  problems: string[]
  /** What could not be checked, in words. Non-empty means "unknown", never "free". */
  unknowns: string[]
  /** The same, as keys (live:<vmid>, cluster-status): what a tick is given for. */
  unknownKeys: string[]
  /** true: something answered a ping. false: nothing did. null: no ping was sent. */
  pinged:   boolean | null
}

export interface IdentityAnswer {
  /** The ID to offer: the rule's, or the next free one. */
  suggestedVmid:  number
  rule:           VmidRule
  vmid?:          { value: number; free: boolean; problem?: string }
  /** With the pattern rule: the ID the node and address give. */
  derived?:       { vmid?: number; taken?: boolean; problem?: string }
  /**
   * With the pattern rule and an ID typed in: the node and address it stands for. `nodes` lists every node the
   * ID fits; with more than one, `node` is left unset and the person picks.
   */
  reverse?:       { node?: string; nodes?: string[]; ip?: string; problem?: string }
  ip?:            AddressCheck
  bridges:        BridgeView[]
}

/**
 * What the identity step shows as the person types: ID suggestion, the pattern both ways, address checks.
 * `ping` is passed only when the person pressed "Check address"; typing never sends one.
 */
export async function checkIdentity(input: {
  node: string; bridge?: string; vmid?: number; ip?: string; gateway?: string
}, view: ClusterView, rule: VmidRule, live: LiveRead,
  ping?: (node: string, ip: string) => Promise<boolean | null>,
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
        // The digits go into the bridge's own address (its network), not the gateway's: a gateway at .1 would
        // turn ID x42 into .42 when the network's guests are at .2xx.
        const base = staticIp ?? bridge?.cidr ?? bridge?.gateway
        const prefix = bridge?.prefix ?? (staticIp ? parseCidr(staticIp)?.prefix : undefined)
        let ip: string | undefined, problem: string | undefined
        if (r.octetDigits && r.width) {
          if (!base) problem = 'The ID gives address digits, but the bridge has no address to put them in.'
          else {
            const o = octetFromDigits(base.split('/')[0], r.octetDigits, r.width)
            if ('ip' in o) ip = prefix ? `${o.ip}/${prefix}` : o.ip
            else problem = o.error
          }
        }
        if (!problem && r.nodes && r.nodes.length > 1) problem = `ID ${input.vmid} fits more than one node (${r.nodes.join(', ')}). Pick the node.`
        out.reverse = { ...(r.node ? { node: r.node } : {}), ...(r.nodes ? { nodes: r.nodes } : {}), ...(ip ? { ip } : {}), ...(problem ? { problem } : {}) }
      }
    }
  }

  if (typeof input.vmid === 'number') out.vmid = idVerdict(input.vmid, used)

  if (staticIp) {
    const a = addressProblems(staticIp, input.gateway, bridge, view, live)
    const c = parseCidr(staticIp)
    const pinged = ping && c && !a.problems.length ? await ping(input.node, c.ip).catch(() => null) : null
    if (pinged) a.problems.push(describeSighting({ ip: c!.ip, source: 'ping' }))
    out.ip = { value: staticIp, problems: a.problems, unknowns: a.unknowns, unknownKeys: a.unknownKeys, pinged }
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

/** "101 (web, no guest agent), 102 (read failed)" — at most eight named. */
function nameGuests(list: Array<{ vmid: number; name: string; why: string }>): string {
  const shown = list.slice(0, 8).map(u => `${u.vmid}${u.name ? ` (${u.name}, ${u.why})` : ` (${u.why})`}`).join(', ')
  return list.length > 8 ? `${shown} and ${list.length - 8} more` : shown
}

/**
 * Why a static address cannot be used here, and what could not be checked. A source that was not read is
 * an unknown: it never counts as "nobody has it".
 */
function addressProblems(
  cidr: string, gateway: string | undefined, bridge: BridgeView | undefined, view: ClusterView, live: LiveRead,
): { problems: string[]; unknowns: string[]; unknownKeys: string[] } {
  const c = parseCidr(cidr)
  if (!c) return { problems: [`"${cidr}" is not an address with a prefix, like 192.0.2.50/24.`], unknowns: [], unknownKeys: [] }
  const out: string[] = [], unknowns: string[] = [], unknownKeys: string[] = []
  if (gateway) {
    if (!parseCidr(`${gateway}/32`)) out.push(`"${gateway}" is not an IPv4 address.`)
    else if (!sameSubnet(c.ip, gateway, c.prefix)) out.push(`${gateway} is not on the ${c.ip}/${c.prefix} network.`)
    else if (!isHostAddress(c.ip, gateway, c.prefix)) out.push(`${c.ip} is the network, broadcast or gateway address of that network.`)
  }
  const unread = view.partial.filter(p => p.startsWith('config:'))
  if (unread.length) out.push(`HyperProx could not read every guest's settings (${unread.length} unread), so it cannot promise ${c.ip} is free.`)
  if (view.partial.includes('cluster-status')) {
    unknowns.push(`The nodes' own addresses could not be read, so ${c.ip} may be a node's address.`)
    unknownKeys.push('cluster-status')
  }
  if (live.unknown.length) {
    unknowns.push(`These running guests could not be asked which address they hold: ${nameGuests(live.unknown)}.`)
    unknownKeys.push(...live.unknown.map(u => `live:${u.vmid}`))
  }
  const seen: IpSighting[] = ipConflicts(c.ip, {
    configs: view.guests.map(g => ({ vmid: g.vmid, name: g.name, config: g.config })),
    live: live.seen, nodes: view.nodes.map(n => ({ node: n.node, ip: n.address })),
  })
  for (const s of seen) out.push(describeSighting(s))
  if (bridge?.cidr && !gateway) {
    const b = parseCidr(bridge.cidr)
    if (b && !sameSubnet(c.ip, b.ip, b.prefix)) out.push(`${c.ip} is not on ${bridge.iface}'s network (${bridge.cidr}).`)
  }
  return { problems: out, unknowns, unknownKeys }
}

/** The address facts that were proven, in words that claim no more than was checked. */
function addressChecks(ip: string, node: string, view: ClusterView, live: LiveRead, pinged: boolean | null): string[] {
  const out = [`${ip} is in no guest config.`]
  out.push(live.unknown.length
    ? `Of the running guests HyperProx could ask, none reports ${ip}; ${live.unknown.length} could not be asked.`
    : `No running guest reports ${ip}.`)
  out.push(view.partial.includes('cluster-status') ? 'The nodes\' own addresses could not be read.' : `${ip} is no node's address.`)
  out.push(pinged === false ? `Nothing answered a ping to ${ip} from ${node} (a firewalled device would not).`
    : `${ip} was not pinged from ${node}.`)
  return out
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const DNS_LIST = /^\s*\d{1,3}(\.\d{1,3}){3}(\s*[ ,]\s*\d{1,3}(\.\d{1,3}){3})*\s*$/

/** Every value of a plan held against the cluster as it is now. Errors refuse; warnings are shown. */
export function checkPlan(
  input: WizardInput & { addressAck?: string[] }, recipe: CatalogueRecipe, view: ClusterView,
  live: LiveRead, pinged: boolean | null,
): { errors: string[]; warnings: string[]; checks: string[]; unknowns: string[] } {
  const errors: string[] = [], warnings: string[] = [], checks: string[] = [], unknowns: string[] = []
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
  else if (int(input.memoryMb) && input.swapMb > swapCeiling(input.memoryMb)) {
    errors.push(`Swap can be at most ${swapCeiling(input.memoryMb)} MB here: twice the RAM, and never more than 8 GB.`)
  }
  if (!int(input.diskGb) || input.diskGb < 1) errors.push('Disk must be a whole number of GB, at least 1.')
  const min = recipe.minimum
  if (int(input.cores) && input.cores < min.cores) warnings.push(`${input.cores} cores is below the ${min.cores} ${recipe.name} needs.`)
  if (int(input.memoryMb) && input.memoryMb < min.memoryMb) warnings.push(`${input.memoryMb} MB RAM is below the ${min.memoryMb} MB ${recipe.name} needs.`)
  if (int(input.diskGb) && input.diskGb < min.diskGb) warnings.push(`${input.diskGb} GB disk is below the ${min.diskGb} GB ${recipe.name} needs.`)
  // The same rule placement greys a node out by: a recipe that needs a GPU is refused on a node without one.
  if (recipe.needsGpu && node && !node.hasGpu && !node.hasIgpu) errors.push(`${recipe.name} needs a GPU and ${node.node} has none HyperProx can see.`)

  // Room on the node and the storage, now.
  if (node?.online && int(input.memoryMb)) {
    const free = node.memTotalMb - node.memUsedMb
    if (free < input.memoryMb) errors.push(`${node.node} has ${free} MB RAM free; this needs ${input.memoryMb} MB.`)
    else {
      checks.push(`${node.node} has ${free} MB RAM free right now; ${free - input.memoryMb} MB is left after this.`)
      const promised = node.memCommittedMb ?? 0
      if (free - input.memoryMb < node.memTotalMb * 0.2) warnings.push(`${node.node} would have less than 20% of its RAM free afterwards.`)
      else if (node.memTotalMb - Math.max(promised, node.memUsedMb) - input.memoryMb < node.memTotalMb * 0.2) {
        warnings.push(`${node.node} has promised ${promised} MB of its ${node.memTotalMb} MB to running guests; with this one, less than 20% is left if they all use what they are allowed.`)
      }
    }
  }
  if (node?.online) {
    if (view.partial.includes(`storage:${node.node}`)) errors.push(`HyperProx could not read the storage on ${node.node}.`)
    const s = view.storages.find(x => x.node === node.node && x.storage === input.storage)
    if (!s) errors.push(`${input.storage || 'No storage'} is not a storage on ${node.node}.`)
    else if (ROOTFS_EXCLUDED[s.type]) errors.push(`${s.storage}: ${ROOTFS_EXCLUDED[s.type]}`)
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
      const a = addressProblems(input.ip, input.gateway, bridge, view, live)
      errors.push(...a.problems)
      if (pinged) errors.push(describeSighting({ ip: c.ip, source: 'ping' }))
      unknowns.push(...a.unknowns)
      const acked = Array.isArray(input.addressAck) ? input.addressAck : []
      const fresh = a.unknownKeys.filter(k => !acked.includes(k))
      if (a.unknownKeys.length && !acked.length) {
        errors.push(`HyperProx could not check everything about ${c.ip}. ${a.unknowns.join(' ')} ` +
                    'Check it yourself, then tick "I checked this address" to go ahead.')
      } else if (fresh.length) {
        errors.push(`HyperProx found more could not be checked than when you ticked (${fresh.join(', ')}). ${a.unknowns.join(' ')} ` +
                    'Look at the address again, and tick again if it is still free.')
      } else if (a.unknowns.length) {
        warnings.push(`You confirmed you checked ${c.ip} yourself. Not checked by HyperProx: ${a.unknowns.join(' ')}`)
      }
      if (!a.problems.length) checks.push(...addressChecks(c.ip, input.node, view, live, pinged))
    }
  }
  if (recipe.options?.length) errors.push(...checkOptions(recipe, input.options).errors)
  if (input.dns && !DNS_LIST.test(input.dns)) errors.push(`"${input.dns}" is not a list of IPv4 DNS servers.`)
  else if (input.dns && input.dns.split(/[\s,]+/).some(d => !parseCidr(`${d}/32`))) errors.push(`"${input.dns}" holds an address that is not IPv4.`)

  return { errors, warnings, checks: checks.filter(Boolean), unknowns }
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
  input: WizardInput & { addressAck?: string[] }, owner: string, over: Partial<WizardDeps> = {},
): Promise<{ preview?: Preview; errors: string[]; warnings: string[]; checks: string[]; unknowns?: string[] }> {
  const deps = wizardDeps(over)
  const recipe = findRecipe(input.recipeId)
  if (!recipe) return { errors: [`No recipe called ${input.recipeId}.`], warnings: [], checks: [] }
  if (!owner) return { errors: ['Sign in to install.'], warnings: [], checks: [] }
  // Before anything is read: a plan that cannot keep its generated password is not worth placing.
  if (recipe.firstRun.kind === 'env-admin' && !await deps.vaultOpen()) {
    return { errors: [`${recipe.name} gets a generated admin password, which is saved in the vault, and the vault is locked. Sign in to unlock it.`], warnings: [], checks: [] }
  }
  const store = wizardStore()
  const now = deps.now()
  await store.pruneExpired(new Date(now))
  if (await store.count('preview') >= PREVIEW_CAP) {
    return { errors: [`There are already ${PREVIEW_CAP} open install previews. Wait ten minutes for them to expire.`], warnings: [], checks: [] }
  }
  const { view, live, pinged } = await freshRead(input, deps)
  const r = checkPlan(input, recipe, view, live, pinged)
  // The Arr Stack: its apps, its library (looked at from the node), its VPN login (to the vault) and public names.
  const arr = recipe.stack === 'arr' && !r.errors.length ? await arrPreview({
    node: input.node, vmid: input.vmid, owner, storage: input.storage, diskGb: input.diskGb, values: checkOptions(recipe, input.options).values,
    vpnSecrets: input.arrVpn, publish: input.arrNames,
    storageFreeGb: view.storages.find(x => x.node === input.node && x.storage === input.storage)?.freeGb,
  }, deps, () => randomBytes(6).toString('hex')) : null
  if (arr) { r.errors.push(...arr.errors); r.warnings.push(...arr.warnings); r.checks.push(...arr.checks); input = { ...input, options: arr.options } }
  // Ghost: the SMTP password into the vault (only this preview names its item), and what mail will do.
  if (recipe.setup === 'ghost') {
    const o = checkOptions(recipe, input.options)
    const g = o.errors.length || r.errors.length ? null : await ghostPreview(o.values, input.ghostSmtpPassword, deps)
    if (g) { r.errors.push(...g.errors); r.warnings.push(...g.warnings); r.checks.push(...g.checks) }
    // The reference is the preview's own, or empty: one sent in the request is never used.
    input = { ...input, options: g?.options ?? { ...o.values, GHOST_SMTP_REF: '' } }
  }
  let publish: PublishPlan | undefined
  if (input.publish) {
    if (recipe.category !== 'web') r.errors.push(`${recipe.name} is not published by the wizard; only websites are.`)
    else {
      const pp = await planPublish(input.publish, deps.publish)
      r.errors.push(...pp.errors); r.warnings.push(...pp.warnings); r.checks.push(...pp.checks)
      publish = pp.plan
    }
  }
  if (!r.errors.length && recipe.setup === 'pbs') {
    const pc = await pbsPreview(input, recipe, deps)
    r.errors.push(...pc.errors); r.warnings.push(...pc.warnings); r.checks.push(...pc.checks)
  }
  if (r.errors.length) return r
  const t = await resolveTemplate(deps.client, input.node, view)
  if ('error' in t) return { ...r, errors: [t.error] }
  if (t.download) r.warnings.push(`The template ${t.template.split('/').pop()} is downloaded to ${input.node} first.`)
  r.checks.push(`Created from ${t.template.split('/').pop()}.`)

  const preview: Preview = {
    id: randomUUID(), owner, checks: r.checks, warnings: r.warnings, createdAt: now, expiresAt: now + PREVIEW_TTL_MS, used: false,
    plan: {
      recipeId: recipe.id, node: input.node, vmid: input.vmid, hostname: input.hostname,
      cores: input.cores, memoryMb: input.memoryMb, swapMb: input.swapMb, diskGb: input.diskGb,
      storage: input.storage, bridge: input.bridge, ip: input.ip,
      ...(input.ip !== 'dhcp' && input.gateway ? { gateway: input.gateway } : {}),
      ...(input.dns ? { dns: input.dns.trim().split(/[\s,]+/).join(' ') } : {}),
      ...(input.ip !== 'dhcp' && input.addressAck?.length ? { addressAck: [...input.addressAck].sort() } : {}),
      ...(recipe.options?.length ? { options: checkOptions(recipe, input.options).values } : {}),
      ...(publish ? { publish } : {}),
      ...(arr?.publish?.length ? { arrPublish: arr.publish } : {}),
      template: t.template, ...(t.download ? { downloadTemplate: true } : {}), unprivileged: true,
    },
  }
  await store.put({ id: preview.id, kind: 'preview', owner, data: preview, expiresAt: new Date(preview.expiresAt) })
  return { preview, ...r }
}

/** A fresh read for preview and apply: never cached, and the ping is always sent for a static address. */
async function freshRead(input: Pick<WizardInput, 'node' | 'ip'>, deps: WizardDeps) {
  const view = await readCluster(deps.client, async n => Boolean(await deps.credential(n)))
  const staticIp = input.ip && input.ip !== 'dhcp' ? parseCidr(input.ip) : null
  const live: LiveRead = staticIp ? await readLiveAddresses(deps.client, view.guests) : { seen: [], unknown: [] }
  notePartial(view, live)
  const pinged = staticIp ? await deps.ping(input.node, staticIp.ip).catch(() => null) : null
  return { view, live, pinged }
}

export async function getPreview(id: string, owner: string): Promise<Preview | undefined> {
  const r = await wizardStore().get(id).catch(() => null)
  const p = r?.kind === 'preview' ? (r.data as Preview) : undefined
  return p && owner && p.owner === owner ? p : undefined
}

/**
 * Create and install exactly what preview `id` holds, after checking it all again against a fresh read.
 * The only input is the id: a plan cannot be edited between the review screen and the create.
 */
export async function applyPreview(id: string, owner: string, over: Partial<WizardDeps> = {}): Promise<InstallJob> {
  const deps = wizardDeps(over)
  const store = wizardStore()
  // Taken synchronously, before any await, so the same preview cannot be applied twice at once.
  if (APPLYING.has(id)) throw new WizardRefusal('This preview is being applied already.', 'used')
  APPLYING.add(id)
  try {
    const rec = await store.get(id)
    const p = rec?.kind === 'preview' ? (rec.data as Preview) : undefined
    if (!p || !owner || p.owner !== owner) throw new WizardRefusal('No such preview.', 'not-found')
    if (p.used) throw new WizardRefusal('This preview was already applied. Make a new one.', 'used')
    if (deps.now() > p.expiresAt) throw new WizardRefusal('This preview has expired. Review the plan again.', 'expired')
    p.used = true
    await store.put({ id, kind: 'preview', owner, data: p, expiresAt: new Date(p.expiresAt) })
    const plan = p.plan
    const recipe = findRecipe(plan.recipeId)!

    const { view, live, pinged } = await freshRead(plan, deps)
    const r = checkPlan(plan, recipe, view, live, pinged)
    if (recipe.firstRun.kind === 'env-admin' && !await deps.vaultOpen()) r.errors.push('The vault is locked, so the generated admin password could not be kept.')
    if (plan.publish) {
      // The name is checked again: a record or a proxy change since the preview refuses the apply.
      const again = await planPublish({ zone: plan.publish.zone, name: plan.publish.name, instanceId: plan.publish.instanceId }, deps.publish)
      r.errors.push(...again.errors)
      if (again.plan && again.plan.record.data !== plan.publish.record.data) r.errors.push(`The public address changed from ${plan.publish.record.data} to ${again.plan.record.data} since the preview.`)
    }
    for (const ap of plan.arrPublish ?? []) {
      const again = await planPublish({ zone: ap.plan.zone, name: ap.plan.name, instanceId: ap.plan.instanceId }, deps.publish)
      r.errors.push(...again.errors.map(e => `${ap.plan.domain}: ${e}`))
      if (again.plan && again.plan.record.data !== ap.plan.record.data) r.errors.push(`The public address changed from ${ap.plan.record.data} to ${again.plan.record.data} since the preview.`)
    }
    if (r.errors.length) {
      throw new WizardRefusal('The cluster changed since the preview, so nothing was created.', 'changed', r.errors)
    }
    if (CREATING.has(plan.vmid)) throw new WizardRefusal('Another install is creating that ID now.', 'changed', [`ID ${plan.vmid} is being created.`])
    CREATING.add(plan.vmid)

    const job = newJob(recipe, owner, `Create CT ${plan.vmid} (${plan.hostname}) on ${plan.node}`, plan.publish)
    job.vmid = plan.vmid; job.node = plan.node; job.hostname = plan.hostname
    if (recipe.stack === 'arr') job.steps = arrJobSteps(job.steps, plan.options ?? {}, plan.arrPublish)
    const markId = `creating:${plan.vmid}`
    // The job row first, then the mark, then the create. After a restart the mark says this job may have
    // made a container, and there is always a job row for it to point at.
    try {
      await persistJob(job)
      await store.put({ id: markId, kind: 'creating', owner, data: { jobId: job.jobId, vmid: plan.vmid, node: plan.node }, expiresAt: null })
    } catch (e: any) {
      CREATING.delete(plan.vmid)
      JOBS.delete(job.jobId)
      throw new WizardRefusal(`HyperProx could not record the install, so nothing was created: ${e.message}`, 'changed')
    }
    void runJob(job, recipe, deps, async () => {
      await createFromPlan(plan, recipe, job.jobId, deps.client, () => { job.created = true; void persistJob(job).catch(() => {}) })
      if (recipe.setup === 'pbs' && plan.options?.PBS_LOCATION === 'nas') await mountNasDatastore(job, plan, deps)
      await waitRunning(deps, plan.node, plan.vmid)
      if (recipe.stack === 'arr') {
        // keyctl, the VPN's tun device and the library, which an API token cannot set; then it starts again.
        job.arrPrepared = await arrPrepare(plan, deps, async () => { job.arrHostMount = { node: plan.node, vmid: plan.vmid }; await persistJob(job).catch(() => {}) })
        await waitRunning(deps, plan.node, plan.vmid)
      }
      const distro = distroOf(plan.template)
      if (!distro) throw new Error(`${plan.template} is neither Debian nor Ubuntu.`)
      return { distro, ...(plan.ip !== 'dhcp' ? { ip: parseCidr(plan.ip)!.ip } : {}) }
    }, async () => {
      // Held until the whole job settles, not just the create: an apply that read the cluster before this
      // container showed up must still be refused.
      CREATING.delete(plan.vmid)
      await store.delete(markId).catch(() => {})
    }, { options: plan.options ?? {}, publish: plan.publish, arrPublish: plan.arrPublish })
    return job
  } finally {
    APPLYING.delete(id)
  }
}

/** True while an apply holds this ID. */
export const isCreating = (vmid: number) => CREATING.has(vmid)

/**
 * After an API restart. A job the store says was running is marked interrupted, and offered for clean-up, only
 * when its create mark survived: the mark is held from before the create until the job settles, so it is the
 * one record that says the job was really cut off. A running row without a mark (a final write that was lost)
 * may be a finished, working service: it comes back as "outcome unknown", with no clean-up. Expired previews
 * and prunable old jobs are deleted. Call once at start-up, before routes serve.
 */
export async function restoreWizardState(now = Date.now()): Promise<{ interrupted: number; unknown: number; restored: number }> {
  const store = wizardStore()
  await store.pruneExpired(new Date(now))
  const marks = new Map((await store.list('creating')).map(m => [String(m.data?.jobId), m]))
  let interrupted = 0, unknown = 0
  const jobs = await store.list('job')
  for (const r of jobs) {
    const job = r.data as InstallJob
    if (job.status === 'running') {
      for (const st of job.steps) if (st.status === 'running') { st.status = 'failed'; st.detail = 'interrupted by a restart' }
      job.finishedAt = now
      if (marks.has(job.jobId)) {
        job.status = 'interrupted'
        job.created = true
        job.error = 'HyperProx restarted while this install was running. Its container may exist half-made.'
        interrupted++
      } else {
        job.status = 'unknown'
        job.error = `HyperProx restarted and could not tell how this install ended${job.vmid ? `. Check CT ${job.vmid} on ${job.node} yourself` : ''}.`
        unknown++
      }
      await persistJob(job)
    }
    JOBS.set(job.jobId, job)
  }
  // No job is running after a restart, so no ID is being created.
  for (const m of marks.values()) await store.delete(m.id).catch(() => {})
  return { interrupted, unknown, restored: jobs.length }
}

/** The caller's installs that left a container behind and can be cleaned up: failed or interrupted, not removed. */
export function cleanupCandidates(owner: string): InstallJob[] {
  if (!owner) return []
  return [...JOBS.values()].filter(j => j.owner === owner && (j.status === 'failed' || j.status === 'interrupted') && j.created && !j.removed)
    .sort((a, b) => b.startedAt - a.startedAt)
}

/**
 * Remove the container a failed install made. Only a container this job created, still carrying this
 * job's mark, not under HA (and HA must be readable to say so), and only after the install failed or was
 * interrupted. Anything else is refused. The delete purges the container's own config and referenced disks;
 * it never sweeps other volumes that happen to carry the same ID.
 */
export async function removeFailedInstall(jobId: string, owner: string, over: Partial<WizardDeps> = {}): Promise<string> {
  const deps = wizardDeps(over)
  const enc = encodeURIComponent
  const job = JOBS.get(jobId)
  if (!job || !owner || job.owner !== owner) throw new WizardRefusal('No such install job.', 'not-found')
  if (job.status !== 'failed' && job.status !== 'interrupted') throw new WizardRefusal('Only a failed or interrupted install can be cleaned up.', 'changed')
  if (job.removed) throw new WizardRefusal('Its container was already removed.', 'used')
  if (!job.created || !job.vmid || !job.node) throw new WizardRefusal('This install did not create a container, so there is nothing of its own to remove.', 'changed')
  const base = `/nodes/${enc(job.node)}/lxc/${job.vmid}`
  // A create whose task failed is usually rolled back by Proxmox itself; then there is nothing to remove.
  const listed = await deps.client.fetchStrict<any[]>('/cluster/resources?type=vm')
  const here = (listed ?? []).find((r: any) => Number(r?.vmid) === job.vmid)
  if (!here) {
    job.removed = true
    const msg = `CT ${job.vmid} no longer exists, so there was nothing to remove.${await removePublished(job, deps)}${await removeHostMount(job, deps)}${await removeVaultItem(job, deps)}`
    await persistJob(job).catch(() => {})
    return msg
  }
  if (here.node !== job.node || here.type !== 'lxc') {
    throw new WizardRefusal(`ID ${job.vmid} is now a ${here.type === 'qemu' ? 'VM' : 'container'} on ${here.node}, not this install's container.`, 'changed')
  }
  const cfg = await deps.client.fetchStrict<Record<string, unknown>>(`${base}/config`)
  if (!String(cfg?.description ?? '').includes(installMark(job.jobId))) {
    throw new WizardRefusal(`CT ${job.vmid} does not carry this install's mark, so HyperProx will not remove it.`, 'changed')
  }
  let ha: any[]
  try { ha = (await deps.client.fetchStrict<any[]>('/cluster/ha/resources')) ?? [] }
  catch { throw new WizardRefusal(`HyperProx could not confirm whether CT ${job.vmid} is under HA, so it was not removed. Try again.`, 'changed') }
  if (ha.some((h: any) => h?.sid === `ct:${job.vmid}`)) {
    throw new WizardRefusal(`CT ${job.vmid} is managed by HA now; remove it from HA first.`, 'changed')
  }
  // What publishing made goes first, while the container it points at still exists to be named.
  const published = await removePublished(job, deps)
  await persistJob(job).catch(() => {})
  const st = await deps.client.fetchStrict<any>(`${base}/status/current`)
  if (st?.status === 'running') {
    await deps.client.waitForTask(job.node, await deps.client.fetchStrict<string>(`${base}/status/stop`, 'POST'), { timeoutMs: 2 * 60_000 })
  }
  // purge=1 only: it removes the container, its referenced disks and its job/HA entries. Never
  // destroy-unreferenced-disks, which also deletes any older volume named for this ID that this install did not make.
  await deps.client.waitForTask(job.node,
    await deps.client.fetchStrict<string>(`${base}?purge=1`, 'DELETE'), { timeoutMs: 5 * 60_000 })
  const left = await deps.client.fetchStrict<any[]>('/cluster/resources?type=vm')
  if ((left ?? []).some((r: any) => Number(r?.vmid) === job.vmid)) throw new Error(`CT ${job.vmid} is still listed after the removal.`)
  job.removed = true
  const msg = `CT ${job.vmid} was removed from ${job.node}.${published}${await removeHostMount(job, deps)}${await removeVaultItem(job, deps)}`
  await persistJob(job).catch(() => {})
  return msg
}

// ── Proxmox Backup Server: the NAS datastore on the node ─────────────────────

/** The preview's checks of where the backups will live (lib/pbs/catalogue.ts), with the NFS look run on the node. */
async function pbsPreview(input: WizardInput, recipe: CatalogueRecipe, deps: WizardDeps): Promise<{ errors: string[]; warnings: string[]; checks: string[] }> {
  const v = checkOptions(recipe, input.options).values
  if (!deps.nodeRun) return { errors: ['HyperProx cannot reach the node to check the NAS export.'], warnings: [], checks: [] }
  return pbsPreviewChecks(input.node, v, { runOnNode: deps.nodeRun })
}

/**
 * Mount the NAS export on the container's node only (fstab line marked with the container's id), give the
 * container its bind mountpoint, then start it. Recorded on the job first, so a clean-up undoes it.
 */
async function mountNasDatastore(job: InstallJob, plan: InstallPlan, deps: WizardDeps): Promise<void> {
  const o = plan.options!
  const src = cleanNfsSource(o.PBS_NFS_HOST, o.PBS_NFS_EXPORT)
  if (!deps.nodeRun) throw new Error('HyperProx cannot reach the node to mount the NAS export.')
  job.hostMount = { node: plan.node, vmid: plan.vmid }
  await persistJob(job).catch(() => {})
  const r = await deps.nodeRun(plan.node, mountScript(src, plan.vmid, o.PBS_DATASTORE), 90_000)
  if (r.code !== 0 || !/@@pbs mounted/.test(r.output)) throw new Error(`${src.source} could not be mounted on ${plan.node} for CT ${plan.vmid}.`)
  // Read back: the container's config carries the mountpoint exactly.
  const cfg = await deps.client.fetchStrict<Record<string, unknown>>(`/nodes/${encodeURIComponent(plan.node)}/lxc/${plan.vmid}/config`)
  if (String(cfg?.mp0 ?? '') !== bindMountpoint(plan.vmid, o.PBS_DATASTORE)) throw new Error(`CT ${plan.vmid}'s datastore mountpoint did not read back.`)
  const step0 = job.steps.find(x => x.id === 'container')
  if (step0) step0.detail = `${src.source} mounted on ${plan.node} and passed in at ${DATASTORE_BASE}/${o.PBS_DATASTORE}`
  await deps.client.waitForTask(plan.node, await deps.client.fetchStrict<string>(`/nodes/${encodeURIComponent(plan.node)}/lxc/${plan.vmid}/status/start`, 'POST'), { timeoutMs: 2 * 60_000 })
}

/** Undo a NAS mount this job made (its fstab line, mount and folder). The NAS's data is never touched. */
async function removeHostMount(job: InstallJob, deps: WizardDeps): Promise<string> {
  if (!job.hostMount || !deps.nodeRun) return ''
  const r = await deps.nodeRun(job.hostMount.node, unmountScript(job.hostMount.vmid), 60_000).catch(() => null)
  if (!r || !/@@pbs (unmounted|nomount)/.test(r.output)) return ` The NAS mount for CT ${job.hostMount.vmid} on ${job.hostMount.node} could not be undone; remove its "# hyperprox-pbs ${job.hostMount.vmid}" line from /etc/fstab there.`
  const where = job.hostMount
  job.hostMount = undefined
  return ` The NAS mount on ${where.node} was undone (the NAS's files were not touched).`
}

/** Remove the proxy host and DNS record this job's ledger says it made. Returns sentences to append. */
async function removePublished(job: InstallJob, deps: WizardDeps): Promise<string> {
  // An Arr Stack's public names and its NAS mount on the node go the same way, in the same message.
  const arr = job.arrLedgers || job.arrHostMount ? await arrCleanup(job, deps).catch((e: any) => [`The Arr Stack's clean-up failed: ${e.message}`]) : []
  if (!job.ledger) return arr.length ? ' ' + arr.join(' ') : ''
  const lines = await cleanupPublish(job.ledger, job.owner, deps.publish).catch((e: any) => [`Publishing clean-up failed: ${e.message}`])
  return [...lines, ...arr].length ? ' ' + [...lines, ...arr].join(' ') : ''
}

/** Delete the generated-login vault item, only when this job created it. Returns a sentence to append. */
async function removeVaultItem(job: InstallJob, deps: WizardDeps): Promise<string> {
  const item = job.vaultItem
  if (!item) return ''
  if (!item.createdByJob) return ` The vault item ${item.category}/${item.provider} existed before this install, so it was kept.`
  try {
    await deps.deleteSecrets(item.category, item.provider)
    job.vaultItem = undefined
    return ` Its generated login (${item.category}/${item.provider}) was removed from the vault.`
  } catch (e: any) {
    return ` Its generated login (${item.category}/${item.provider}) could not be removed from the vault: ${e.message}`
  }
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

/** How long the identity step reuses one read of the cluster while the person types. */
export const IDENTITY_CACHE_MS = 10_000
const VIEW_CACHE = new Map<string, { at: number; view: ClusterView; live?: LiveRead }>()

/**
 * The cluster read for as-you-type identity checks, reused for about ten seconds per signed-in person, with
 * live addresses read only when a static address is being checked. Preview and apply never use this.
 */
export async function identityView(key: string, wantLive: boolean, over: Partial<WizardDeps> = {}): Promise<{ deps: WizardDeps; view: ClusterView; live: LiveRead }> {
  const deps = wizardDeps(over)
  const now = deps.now()
  for (const [k, v] of VIEW_CACHE) if (now - v.at > IDENTITY_CACHE_MS) VIEW_CACHE.delete(k)
  let hit = key ? VIEW_CACHE.get(key) : undefined
  if (!hit) {
    hit = { at: now, view: await readCluster(deps.client, async n => Boolean(await deps.credential(n))) }
    if (key) VIEW_CACHE.set(key, hit)
  }
  if (wantLive && !hit.live) { hit.live = await readLiveAddresses(deps.client, hit.view.guests); notePartial(hit.view, hit.live) }
  return { deps, view: hit.view, live: hit.live ?? { seen: [], unknown: [] } }
}

/** Tests: forget cached reads. */
export const clearIdentityCache = () => VIEW_CACHE.clear()

// ── The Arr Stack's reach (lib/arr) ──────────────────────────────────────────

/** Its apps over HTTP, its node over the saved login, HyperProx's plug-in settings and a Plex server it knows. */
function realArrDeps(): ArrDeps {
  return {
    http: realHttp,
    nodeRun: async (node, script, timeoutMs) => {
      const cred = await nodeCredential(node).catch(() => null)
      if (!cred) throw new Error(`No login is stored for ${node}.`)
      const host = await nodeAddress(pve(), node)
      const r = await execOnNode({ host, cred, command: 'bash -s', input: script, timeoutMs })
      return { code: r.code, output: r.output }
    },
    pluginSettings: id => getSettings(id),
    savePluginSettings: async (id, values) => {
      const plugin = PLUGINS.find(p => p.manifest.id === id)
      if (!plugin) throw new Error(`No ${id} plug-in is present.`)
      await saveSettings(plugin.manifest, values)
    },
    localAddressTo,
    // The Plex plug-in's own server and token, when it has them: Seerr signs in with that Plex account.
    mediaServer: async () => {
      const p = await getSettings('plex').catch(() => ({} as Record<string, string>))
      return p.plex_url && p.plex_token ? { kind: 'plex' as const, url: p.plex_url, token: p.plex_token } : null
    },
  }
}

/** The caller's finished Arr Stacks whose Seerr waits for a Plex server. */
export function seerrWaiting(owner: string): InstallJob[] {
  if (!owner) return []
  return [...JOBS.values()].filter(j => j.owner === owner && j.status === 'completed' && j.arrSeerrWaiting && !j.removed)
}

/**
 * "Finish Seerr": start this stack's Seerr, sign it in with the Plex account the Plex plug-in knows, and connect it
 * to Sonarr and Radarr, at once. Only the job's owner, only a finished Arr Stack whose Seerr is still waiting.
 */
export async function finishSeerr(jobId: string, owner: string, over: Partial<WizardDeps> = {}): Promise<string> {
  const deps = wizardDeps(over)
  const job = JOBS.get(jobId)
  if (!job || !owner || job.owner !== owner) throw new WizardRefusal('No such install job.', 'not-found')
  if (job.status !== 'completed' || !job.arrSeerrWaiting) throw new WizardRefusal('This install has no Seerr waiting to be finished.', 'changed')
  if (!job.ip || !job.vmid || !job.node || !job.vaultItem) throw new WizardRefusal('This install has no address or vault item to finish Seerr with.', 'changed')
  // Still the container this job made: a reused ID is never touched.
  const cfg = await deps.client.fetchStrict<Record<string, unknown>>(`/nodes/${encodeURIComponent(job.node)}/lxc/${job.vmid}/config`).catch(() => null)
  if (!String(cfg?.description ?? '').includes(installMark(job.jobId))) throw new WizardRefusal(`CT ${job.vmid} no longer carries this install's mark.`, 'changed')
  const cred = await deps.credential(job.node)
  if (!cred) throw new Error(`No node login is stored for ${job.node}.`)
  const host = await nodeAddress(deps.client, job.node)
  const detail = await arrFinishSeerr({ ip: job.ip, vault: { category: job.vaultItem.category, provider: job.vaultItem.provider } }, {
    arr: deps.arr, wait: deps.wait, readSecrets: deps.readSecrets, saveSecrets: deps.saveSecrets,
    sh: (script, timeoutMs) => deps.exec({ host, cred, vmid: job.vmid!, script, timeoutMs, onData: () => {} }),
  })
  const st = job.steps.find(x => x.id === 'arr-seerr')
  if (st) { st.status = 'done'; st.detail = detail }
  job.arrSeerrWaiting = false
  await persistJob(job).catch(() => {})
  return detail
}
