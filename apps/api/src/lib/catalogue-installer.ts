// =============================================================================
//  HyperProx — installing what you do not already run
//
//  Creates a container, runs the recipe inside it from the node, checks the
//  service actually answers, and writes the address into the integration that
//  was waiting for it. The last step is the point: an install that leaves you
//  copying a URL into a settings form has done the easy half.
// =============================================================================

import { appLog, type LogLike } from './log-once'
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
  arrPreview, arrPrepare, arrInstallEnv, arrRunSetup, arrJobSteps, arrCleanup, arrFinishSeerr, mediaPreferOf, stopApps, stoppedSentence, realHttp, localAddressTo,
  type ArrDeps, type ArrPublishInput, type ArrPublishPlan,
} from './arr/catalogue'
import { isTranscode, kindOf, nodeHardwareFacts, tcPreview, tcPrepare, tcInstallEnv, tcJobSteps, tcRunSetup, tcCleanup } from './transcode/catalogue'
import type { LinkRecord } from './transcode/setup'
import { sharedPlexSignin } from './plex-signin-shared'
import { pickMediaServer, serversFromSettings } from './arr/media-server'
import { managedSecret, type ManagedProxyRegistration } from './proxy/managed-recipes'
import { execOnNode } from './node-exec'
import type { CreatePVE } from './wizard-executor'
import type { ExecResult } from './node-exec'
import { setCredential, setCredentials, getProviderCredentials, vaultWritable, deleteProviderCredentials, getCredential } from './credentials'
import { saveSettings, getSettings } from './plugin-host'
import { PLUGINS } from '../plugins'
import { wizardStore } from './catalogue-store'
import { auditCredentialUse, auditOrThrow } from './audit'
import { installStillOwns } from './auto-connect/core'
import {
  validateNaming, detectConvention, pickNext, managementFallback, namingPolicy, takenAddresses, schemeLabel, bareIp, readSavedNaming, NAMING_ID,
  type NamingSettings, type Detection,
} from './naming'
import { pbsSetupDeps, pbsSetupNodeRunner } from './pbs/setup-deps'
import { PBS_SETUP_STEPS, pbsPreviewChecks, runPbsSetup, scriptEnv as pbsScriptEnv, type SetupDeps as PbsSetupDeps } from './pbs/catalogue'
import { bindMountpoint, cleanNfsSource, mountScript, unmountScript, DATASTORE_BASE } from './pbs/nfs'
import {
  GHOST_SETUP_STEPS, ghostOverShell, runGhostSetup, ghostPreview, ghostInstallEnv, dropPendingSmtp, type GhostHttp, type Shell,
} from './ghost/setup'
import { mailWanted } from './ghost/recipe'
import { HAPROXY_SETUP_STEPS, runHaproxySetup, type HaproxySetupDeps } from './haproxy/setup'
import { HaproxyInstanceStore } from './haproxy/instances'
import { ownScrapers } from './haproxy/recipe'
import { FWDPROXY_SETUP_STEPS, runFwdProxySetup } from './fwdproxy/setup'
import { isPrivateV4 } from './fwdproxy/net'
import { BALANCE_STEP, balancePreview, runInstallBalance, realBalanceDeps, realBalanceCheckDeps, type InstallBalance, type BalanceDeps, type BalanceCheckDeps } from './haproxy/install-balance'
import { isK3s, k3sPrepare, k3sPreview, k3sInstallEnv, k3sRunSetup, k3sSteps } from './k3s/catalogue'
import type { K3sService } from './k3s/service'
import { k3sService } from './k3s'
import { APTCACHE_SETUP_STEPS, runAptCacheSetup } from './aptcache/setup'
import { IMMICH_SETUP_STEPS, immichScriptEnv, accelOf } from './immich/recipe'
import { immichPreview, immichPrepare } from './immich/preview'
import { runImmichSetup } from './immich/setup'
import { OPENWEBUI_SETUP_STEPS } from './openwebui/recipe'
import { openwebuiPreview } from './openwebui/preview'
import { runOpenWebuiSetup } from './openwebui/setup'
import { HA_SETUP_STEPS, usbList } from './homeassistant/recipe'
import { createHaVm, imageFor, runHaSetup, type HaSetupDeps } from './homeassistant/job'
import { haSocket } from './homeassistant/ws'
import { HAVM_USB_SCRIPT, parseUsb, resolveUsb } from './homeassistant/usb'
import { InstanceStore as HaInstanceStore } from './ha-control/instances'
import { deleteCredential } from './credentials'
import { isPrivateV4 as aptCachePrivate } from './aptcache/net'
import { DEFAULT_CACHE_GB } from './aptcache/recipe'
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
  /** Set when a progress save failed: the saved copy may be behind what happened. */
  progressNotSaved?: boolean
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
  /** The media server the owner chose for Seerr (blank: Plex first), kept for "Finish Seerr". */
  arrMediaPrefer?: 'plex' | 'jellyfin' | ''
  /** What was set on an Arr Stack's container over the node login (keyctl, tun, the library), in words. */
  arrPrepared?: string
  /** An Arr Stack's apps and their addresses, for the finished page. (A transcoder's link to open uses it too.) */
  arrApps?: Array<{ id: string; name: string; url: string }>
  /** What was set on a transcoder's container over the node login (keyctl, hardware devices, the library), in words. */
  tcPrepared?: string
  /** The numeric groups that let a transcoder's app open the GPU's device files. */
  tcGroups?: number[]
  /** The one link an Unmanic worker install added to its main Unmanic; clean-up removes only this. */
  tcLink?: LinkRecord
  /** What to offer on the finished page next (an extra worker or node), with the options to fill in for it. */
  tcFollowUp?: { recipeId: string; label: string; url: string; options?: Record<string, string> }
  /** What was set on a K3s container over the node login (keyctl), in words. */
  k3sPrepared?: string
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
  /** HAProxy's optional step: the publish job (lib/haproxy PUBLISH_JOBS) making its public name, so clean-up can read what it made. */
  balancePublishJob?: string
  /** The Sites entry a finished web install made. */
  siteId?: string
  /** The container's hostname, as planned. */
  hostname?: string
  /** A NAS datastore this job mounted on the container's node (Proxmox Backup Server); clean-up unmounts it. */
  hostMount?: { node: string; vmid: number }
  /** 'vm': what this job made is a virtual machine (Home Assistant OS), so clean-up uses the machine's API, not the container's. */
  guest?: 'vm'
  /** The plug-in this install connected by itself, so clean-up can disconnect it again (Immich, Open WebUI: its settings; Home Assistant: the instance it added). */
  connected?: { plugin: string; instanceId?: string }
  /** Home Assistant: what happened with the proxy's trust (the lines to add by hand when HyperProx could not), for the finished page. */
  haTrustNote?: string
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
  /** HAProxy's setup: the Proxy page, its plug-in and Prometheus (lib/haproxy/setup.ts). */
  haproxySetup?: () => HaproxySetupDeps
  /** HyperProx's own addresses, which may read HAProxy's /metrics. */
  scrapers?:   () => string[]
  /**
   * A recipe with registersProxy: add the finished install to the Proxy page as a Managed instance. Returns what it did,
   * in words. Default: lib/proxy registerManagedProxy (the proxy service, as the person who started the install).
   */
  registerProxy?: (o: ManagedProxyRegistration) => Promise<string>
  /** The 3proxy plug-in connects the new container (auto-connect, at once); true when it did. */
  fwdConnect?: (vmid: number) => Promise<boolean>
  /** HAProxy's optional "Load-balance an app now": the plug-in's own service and publish (lib/haproxy/install-balance.ts). */
  haproxyBalance?: () => Promise<BalanceDeps>
  /** What the preview checks that step's guests and public name against. */
  haproxyBalanceCheck?: () => Promise<BalanceCheckDeps>
  /** The K3s page's service: an agent's server and join token, and connecting a new server (lib/k3s). */
  k3s?:        () => K3sService
  /** The package cache's plug-in connects the new container (auto-connect, at once); true when it did. */
  aptCacheConnect?: (vmid: number) => Promise<boolean>
  /** Home Assistant's reach beyond the generic installer's: its WebSocket, its plug-in, the machine's files, the node's time zone. */
  ha?: () => HaDeps
  /** The Ollama address the AI page is connected to (Open WebUI is pointed at it), or null. */
  knownOllama?: () => Promise<string | null>
  /** The plug-in settings in the vault, for undoing the connection an install made (default: the credential store). */
  pluginCreds?: PluginCreds
}

export interface PluginCreds {
  get(provider: string, key: string): Promise<string | null>
  set(provider: string, key: string, value: string): Promise<void>
  del(provider: string, key: string): Promise<void>
  delProvider(provider: string): Promise<void>
}
const realPluginCreds: PluginCreds = {
  get: (p, k) => getCredential('plugin', p, k), set: (p, k, v) => setCredential('plugin', p, k, v, false),
  del: (p, k) => deleteCredential('plugin', p, k), delProvider: p => deleteProviderCredentials('plugin', p),
}

/** What Home Assistant's install reaches outside itself for. */
export interface HaDeps {
  socket: HaSetupDeps['socket']
  connect: HaSetupDeps['connect']
  agentFile?: HaSetupDeps['agentFile']
  timeZone(node: string): Promise<string>
}

function realHaDeps(): HaDeps {
  const store = () => new HaInstanceStore({ get: getCredential, set: setCredential, remove: deleteProviderCredentials })
  const enc = encodeURIComponent
  return {
    socket: (ip, token) => haSocket(ip, 8123, token),
    connect: async o => {
      const st = store()
      try { const m = await st.create({ name: o.name, url: o.url, token: o.token }); return { id: m.id, name: m.name } }
      catch (e: any) {
        // Another instance already has the name: this one is told apart by its machine.
        if (e?.status === 409) { const m = await st.create({ name: `${o.name.slice(0, 30)} (HyperProx)`, url: o.url, token: o.token }); return { id: m.id, name: m.name } }
        throw e
      }
    },
    agentFile: {
      read: async (node, vmid, path) => { const r = await pve().fetchStrict<any>(`/nodes/${enc(node)}/qemu/${vmid}/agent/file-read?file=${enc(path)}`); return { content: String(r?.content ?? ''), truncated: !!r?.truncated } },
      write: async (node, vmid, path, content) => { await pve().fetchStrict(`/nodes/${enc(node)}/qemu/${vmid}/agent/file-write`, 'POST', new URLSearchParams({ file: path, content }).toString()) },
    },
    timeZone: async node => String((await pve().fetchStrict<any>(`/nodes/${enc(node)}/time`))?.timezone ?? 'UTC'),
  }
}

/** HAProxy's setup as it runs for real: the Proxy service, the plug-in's store, the audit log and Prometheus. */
function realHaproxySetupDeps(): HaproxySetupDeps {
  return {
    createProxyInstance: async (input, owner) => {
      const { proxyService } = await import('./proxy')
      return (await proxyService().createInstance(input, { email: owner })).instance.id
    },
    store: new HaproxyInstanceStore({ get: getCredential, set: setCredential }),
    audit: (a, r, d) => auditOrThrow(a, r, d),
    syncTargets: async () => (await import('./haproxy')).syncHaproxyTargets(),
    deleteSecrets: (c, p) => deleteProviderCredentials(c, p),
  }
}

const realDeps = (): InstallDeps => ({
  ha:         realHaDeps,
  knownOllama: () => getCredential('ai', 'ollama', 'url').catch(() => null),
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
  // Loaded when used: the proxy service is set up at start-up, after this module.
  registerProxy: async o => (await import('./proxy')).registerManagedProxy(o),
  fwdConnect:  async vmid => {
    // Late-bound: auto-connect reads the plug-ins, which read this module.
    await (await import('./auto-connect')).autoConnect().runFresh('catalogue-install')
    return (await (await import('./fwdproxy')).fwdProxyService().instances()).some(i => i.vmid === vmid)
  },
  k3s:         () => k3sService(),
  aptCacheConnect: async vmid => {
    // Late-bound: auto-connect reads the plug-ins, which read this module.
    await (await import('./auto-connect')).autoConnect().runFresh('catalogue-install')
    return (await (await import('./aptcache')).aptCacheService().instances()).some(i => i.vmid === vmid)
  },
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

let installerLog: LogLike = appLog
/** Where the installer reports problems it cannot show to the person installing. Never given a secret. */
export function setInstallerLogger(l: LogLike): void { installerLog = l }

/** A progress save failed. Logged once per job; the job itself says so, so its page shows it too. */
function persistFailed(job: InstallJob, e: unknown): void {
  if (job.progressNotSaved) return
  job.progressNotSaved = true
  job.log += '\nProgress could not be saved. If HyperProx restarts now, this install may not show its latest state.\n'
  try { installerLog.error({ err: e, jobId: job.jobId, recipe: job.recipeId }, 'install progress could not be saved') } catch { /* logging must not break an install */ }
}

function step(job: InstallJob, id: string): InstallStep {
  const s = job.steps.find(x => x.id === id)!
  s.status = 'running'
  void persistJob(job).catch(e => persistFailed(job, e))
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
export function planNet0(plan: Pick<InstallPlan, 'bridge' | 'ip' | 'gateway' | 'vlan'>): string {
  const ip = plan.ip === 'dhcp' ? 'ip=dhcp' : `ip=${plan.ip}${plan.gateway ? `,gw=${plan.gateway}` : ''}`
  return `name=eth0,bridge=${plan.bridge},${ip},firewall=1${plan.vlan ? `,tag=${plan.vlan}` : ''}`
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
  // The package cache: its cache on a disk of its own, left out of backups (everything on it can be fetched again).
  if (recipe.setup === 'aptcache') set('mp0', `${plan.storage}:${Number(plan.options?.ACNG_CACHE_GB || DEFAULT_CACHE_GB)},mp=/var/cache/apt-cacher-ng,backup=0`)
  set('unprivileged', 1); if (recipe.id !== 'plex') set('features', 'nesting=1'); set('onboot', 1); set('start', pbs?.PBS_LOCATION === 'nas' ? 0 : 1)
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

const STEPS = (recipe: CatalogueRecipe, first: string, publish?: PublishPlan, balance?: boolean): InstallStep[] => recipe.install.kind === 'vm' ? [
  { id: 'container', label: first, status: 'pending' },
  ...HA_SETUP_STEPS.map(x => ({ id: x.id, label: x.label, status: 'pending' as Phase })),
  ...(publish ? PUBLISH_STEPS.map(s => ({ id: s.id, label: s.label, status: 'pending' as Phase })) : []),
] : [
  { id: 'container', label: first, status: 'pending' },
  { id: 'network',   label: 'Wait for an address',   status: 'pending' },
  { id: 'install',   label: `Install ${recipe.name}`, status: 'pending' },
  ...(recipe.setup === 'pbs' ? PBS_SETUP_STEPS.map(x => ({ ...x, status: 'pending' as Phase }))
    : recipe.setup === 'fwdproxy' ? FWDPROXY_SETUP_STEPS.map(x => ({ ...x, status: 'pending' as Phase }))
    : isK3s(recipe) ? k3sSteps(recipe.id).map(x => ({ ...x, status: 'pending' as Phase }))
    : recipe.setup === 'aptcache' ? APTCACHE_SETUP_STEPS.map(x => ({ ...x, status: 'pending' as Phase })) : [
    ...(recipe.setup === 'ghost' ? GHOST_SETUP_STEPS.map(x => ({ id: x.id, label: x.label, status: 'pending' as Phase })) : []),
    { id: 'verify',    label: 'Check it answers',       status: 'pending' as Phase },
    // HAProxy's own setup takes the place of the generic wiring.
    ...(recipe.setup === 'haproxy' ? HAPROXY_SETUP_STEPS.map(x => ({ id: x.id, label: x.label, status: 'pending' as Phase }))
      : recipe.setup === 'immich' ? IMMICH_SETUP_STEPS.map(x => ({ id: x.id, label: x.label, status: 'pending' as Phase }))
      : recipe.setup === 'openwebui' ? OPENWEBUI_SETUP_STEPS.map(x => ({ id: x.id, label: x.label, status: 'pending' as Phase }))
      : [{ id: 'wire',      label: 'Configure the integration', status: 'pending' as Phase }]),
    ...(recipe.registersProxy ? [{ id: 'proxy', label: 'Add it to the Proxy page', status: 'pending' as Phase }] : []),
    ...(balance && recipe.setup === 'haproxy' ? [{ ...BALANCE_STEP, status: 'pending' as Phase }] : []),
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
  if (isTranscode(recipe)) throw new Error(`${recipe.name} needs its container's hardware and library set up on the node, which only the install wizard does. Make a new container with the wizard.`)
  if (isK3s(recipe)) throw new Error(`${recipe.name} needs keyctl set on its container from the node, which only the install wizard does. Make a new container with the wizard.`)

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
  void persistJob(job).catch(e => persistFailed(job, e))
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

function newJob(recipe: CatalogueRecipe, owner: string, first: string, publish?: PublishPlan, balance?: boolean): InstallJob {
  const job: InstallJob = {
    jobId: randomUUID(), owner, recipeId: recipe.id, status: 'running', log: '', startedAt: Date.now(),
    steps: STEPS(recipe, first, publish, balance), ...(publish ? { publish, ledger: {} } : {}),
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
  ctx: { options?: Record<string, string>; publish?: PublishPlan; arrPublish?: ArrPublishPlan[]; balance?: InstallBalance } = {},
): Promise<void> {
  const options = ctx.options ?? {}
  const tc = isTranscode(recipe) ? kindOf(recipe.id) : null
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
        `\`pct exec\` from the node, which needs one. Add it under Settings → Setup checklist (Add node login).`)
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
    // HAProxy: the Data Plane password, saved in the vault before the script runs (a password that exists only in a
    // script that already ran is a lockout), and the addresses that may read its metrics.
    let haproxySecret: string | null = null
    if (recipe.setup === 'haproxy') {
      if (!await deps.vaultOpen()) throw new Error('HAProxy\'s Data Plane API gets a generated password, which is saved in the vault, and the vault is locked. Sign in to unlock it and try again.')
      haproxySecret = randomBytes(24).toString('base64url')
      // Whether the item already existed is recorded first, so a clean-up after a failure deletes only an item this job made.
      const provider = `${recipe.id}-${job.vmid}`
      const before = await deps.readSecrets('apps', provider).catch(() => null)
      await deps.saveSecrets('apps', provider, { dataplane_user: 'hyperprox', dataplane_password: haproxySecret })
      job.vaultItem = { category: 'apps', provider, createdByJob: before !== null && Object.keys(before).length === 0 }
      await persistJob(job).catch(e => persistFailed(job, e))
      env.HPX_DP_PASSWORD = haproxySecret
      env.HPX_SCRAPERS = (deps.scrapers ?? ownScrapers)().join(',')
    }
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
      await persistJob(job).catch(e => persistFailed(job, e))
      if (ghost?.pendingRef) await dropPendingSmtp(ghost.pendingRef, deps)
    }
    // The Arr Stack's compose file, folders and VPN login (moved from the preview's vault item to the stack's own).
    if (recipe.stack === 'arr') Object.assign(env, await arrInstallEnv({ owner: job.owner, options, vault: job.vaultItem }, deps))
    // Unmanic and Tdarr: the compose file, the folders and (NVIDIA) the libraries. No secret is made.
    // A proxy HyperProx will drive: a fresh secret for the API login the script sets up (unused by a kind with none).
    // It reaches the vault with the Proxy instance, after the install answers.
    const proxySecret = recipe.registersProxy ? managedSecret() : ''
    if (proxySecret) env.HPX_PROXY_SECRET = proxySecret
    if (tc) Object.assign(env, tcInstallEnv(tc, { options, groups: job.tcGroups ?? [], ip: job.ip ?? '', hostname: job.hostname ?? recipe.id }))
    // Immich: the compose file for the hardware the node was found to have, and its private database password.
    if (recipe.setup === 'immich') {
      Object.assign(env, immichScriptEnv({ accel: accelOf(options), groups: job.tcGroups ?? [], intel: options.IMMICH_INTEL === '1', nvidiaVersion: options.TC_NVIDIA_VERSION || undefined }))
    }
    // K3s: the server's own address for its certificate; an agent's server and join token (from the vault, into the script only).
    if (isK3s(recipe)) {
      if (!deps.k3s) throw new Error('The K3s page is not available here.')
      Object.assign(env, await k3sInstallEnv(recipe.id, { ip: job.ip, options }, { service: deps.k3s }))
    }
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

    // 3proxy: its self-check of the safety rules in place of the web check, then its plug-in connects it.
    if (recipe.setup === 'fwdproxy') {
      if (!job.ip) throw new Error(`${recipe.name} has no address, so its safety check cannot run.`)
      if (!admin) throw new Error(`${recipe.name} needs its generated first user to be checked.`)
      const out = await runFwdProxySetup(
        { vmid: job.vmid!, ip: job.ip.split('/')[0], user: admin.user, password: admin.password },
        id => step(job, id),
        {
          sh: (script, timeoutMs) => deps.exec({ host: nodeIp, cred, vmid: job.vmid!, script, timeoutMs, onData: () => {} }),
          connect: deps.fwdConnect ?? (async () => false),
        })
      job.url = out.url
      job.adminCredential = { user: admin.user, vault: { category: 'apps', provider: `${recipe.id}-${job.vmid}`, key: 'admin_password' }, issuedAt: Date.now() }
      job.status = 'completed'
      return
    }

    // K3s: its admin login into the vault, HyperProx's own two accounts, the K3s page connected (lib/k3s/catalogue.ts);
    // an agent: it joined and is Ready. In place of the generic check and wiring.
    if (isK3s(recipe)) {
      if (!job.ip) throw new Error(`${recipe.name} has no address, so its setup cannot reach it.`)
      if (!deps.k3s) throw new Error('The K3s page is not available here.')
      const s0 = job.steps.find(x => x.id === 'container')
      if (s0 && job.k3sPrepared) s0.detail = `${s0.detail}: ${job.k3sPrepared}`
      const out = await k3sRunSetup({ recipeId: recipe.id, ip: job.ip, vmid: job.vmid!, hostname: job.hostname ?? recipe.id, owner: job.owner, options },
        id => step(job, id), { service: deps.k3s, sh: (script, timeoutMs) => deps.exec({ host: nodeIp, cred, vmid: job.vmid!, script, timeoutMs, onData: () => {} }) })
      job.url = out.url
      if (out.followUp) job.tcFollowUp = out.followUp
      job.status = 'completed'
      return
    }

    // The package cache: its self-check in place of the web check, then its plug-in (and Updates) connect it.
    if (recipe.setup === 'aptcache') {
      if (!job.ip) throw new Error(`${recipe.name} has no address, so its check cannot run.`)
      const out = await runAptCacheSetup(
        { vmid: job.vmid!, ip: job.ip.split('/')[0] },
        id => step(job, id),
        {
          sh: (script, timeoutMs) => deps.exec({ host: nodeIp, cred, vmid: job.vmid!, script, timeoutMs, onData: () => {} }),
          connect: deps.aptCacheConnect ?? (async () => false),
        })
      job.url = out.url
      if (admin) job.adminCredential = { user: admin.user, vault: { category: 'apps', provider: `${recipe.id}-${job.vmid}`, key: 'admin_password' }, issuedAt: Date.now() }
      job.status = 'completed'
      return
    }

    // Unmanic and Tdarr: each proves itself and does its setup chores (lib/transcode/setup.ts) in place of the wiring.
    if (tc) {
      if (!job.ip) throw new Error(`${recipe.name} has no address, so its setup cannot reach it.`)
      const s0 = job.steps.find(x => x.id === 'container')
      if (s0 && job.tcPrepared) s0.detail = `${s0.detail}: ${job.tcPrepared}`
      const out = await tcRunSetup({
        kind: tc, ip: job.ip, hostname: job.hostname ?? recipe.id, options, owner: job.owner,
        // Recorded the moment the main Unmanic has the link, so a failure after it can still be undone.
        onLink: r => { job.tcLink = r; void persistJob(job).catch(e => persistFailed(job, e)) },
      }, id => step(job, id), { arr: deps.arr, wait: deps.wait })
      job.url = out.url
      job.arrApps = out.apps
      if (out.followUp) job.tcFollowUp = out.followUp
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
        publish: ctx.arrPublish, recipe, ledgers: (job.arrLedgers ??= {}), save: () => { void persistJob(job).catch(e => persistFailed(job, e)) },
      }, id => step(job, id), {
        arr: deps.arr, wait: deps.wait, publish: deps.publish, saveSecrets: deps.saveSecrets, readSecrets: deps.readSecrets,
        sh: arrSh, stopContainer: arrStopContainer,
      })
      job.url = out.url
      job.arrApps = out.apps
      if (job.steps.find(x => x.id === 'arr-seerr')?.status === 'skipped') { job.arrSeerrWaiting = true; job.arrMediaPrefer = mediaPreferOf(options) }
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

    // Immich and Open WebUI: the administrator, HyperProx's own key, the plug-in and the checks, over the container's own address.
    const appSetup = recipe.setup === 'immich' || recipe.setup === 'openwebui'
    if (appSetup) {
      const arr = deps.arr?.()
      if (!job.ip || !admin || !job.vaultItem || !arr) throw new Error(`${recipe.name} needs its address, its generated login and the vault to be set up.`)
      const sd = { sh: arrSh, http: arr.http, wait: deps.wait, saveSecrets: deps.saveSecrets, savePluginSettings: async (id: string, v: Record<string, string>) => { await arr.savePluginSettings(id, v); job.connected = { plugin: id }; await persistJob(job).catch(e => persistFailed(job, e)) }, pluginSettings: arr.pluginSettings }
      const vault = { category: job.vaultItem.category, provider: job.vaultItem.provider }
      const ip = job.ip.split('/')[0]
      if (recipe.setup === 'immich') {
        const out = await runImmichSetup({ ip, admin: { email: admin.user, name: options.IMMICH_ADMIN_NAME || 'Administrator', password: admin.password }, ffmpeg: (options.IMMICH_FFMPEG as any) || 'disabled', vault }, id => step(job, id), sd)
        void out
      } else {
        const out = await runOpenWebuiSetup({ ip, admin: { email: admin.user, password: admin.password }, ollama: options.OWUI_OLLAMA_ENABLED === 'true', vault }, id => step(job, id), sd)
        void out
        // No Ollama to use yet: the finished page offers to install one, and the plug-in connects it once it is there.
        if (options.OWUI_OLLAMA === 'auto' && options.OWUI_OLLAMA_ENABLED !== 'true') {
          job.tcFollowUp = { recipeId: 'ollama', label: 'Install Ollama next', url: '', options: {} }
        }
      }
      // The setup waited for the service far longer than the quick check above did.
      if (s4.status !== 'done') { s4.status = 'done'; s4.detail = `${url}${recipe.healthPath} is answering` }
      await persistJob(job).catch(e => persistFailed(job, e))
    }

    // 5. Hand it to whatever was waiting for it. HAProxy: the Proxy page, its plug-in and Prometheus.
    if (recipe.setup === 'haproxy') {
      if (s4.status !== 'done' || !job.ip || !haproxySecret) throw new Error('HAProxy did not answer on port 80, so it was not added to the Proxy page or the plug-in. Its Data Plane password is in the vault under ' + `apps/${recipe.id}-${job.vmid}.`)
      const out = await runHaproxySetup({
        name: `HAProxy ${job.vmid}`, ip: job.ip.split('/')[0], node: job.node!, vmid: job.vmid!, secret: haproxySecret, owner: job.owner || 'hyperprox',
        vault: { category: 'apps', provider: `${recipe.id}-${job.vmid}` },
      }, id => step(job, id), (deps.haproxySetup ?? realHaproxySetupDeps)())
      // The Proxy page's instance holds the login now; the install's own copy is gone (or the step said why not).
      if (out.vaultCopyRemoved) job.vaultItem = undefined
      // The optional step: an app balanced now, through the plug-in's own service. Done only once it reads back healthy.
      if (ctx.balance) {
        const sb = step(job, BALANCE_STEP.id)
        const lb = await runInstallBalance({ pluginInstanceId: out.pluginInstanceId, balance: ctx.balance, owner: job.owner || 'hyperprox', haproxyIp: job.ip.split('/')[0] }, sb, await (deps.haproxyBalance ?? realBalanceDeps)(),
          async r => {
            if (r.publishJob) job.balancePublishJob = r.publishJob
            if (r.ledger) job.ledger = { ...(job.ledger ?? {}), ...r.ledger }
            await persistJob(job).catch(e => persistFailed(job, e))
          })
        if (lb.url) job.url = lb.url
      }
    } else if (!appSetup) {
      const s5 = step(job, 'wire')
      s5.detail = url ? await wireUp(recipe, url) : 'no address, so nothing was configured'
      s5.status = url ? 'done' : 'skipped'
    }

    // 5b. A proxy goes on the Proxy page, so apps can be published through it. Only one that answers; a failure here
    // leaves the install standing and says what to do, like a check that did not pass.
    if (recipe.registersProxy) {
      const sp = step(job, 'proxy')
      if (s4.status !== 'done' || !job.ip) { sp.status = 'skipped'; sp.detail = `${recipe.name} did not answer, so it was not added to the Proxy page.` }
      else {
        try {
          if (!deps.registerProxy) throw new Error('the Proxy page is not available here')
          sp.detail = await deps.registerProxy({
            kind: recipe.registersProxy, recipeId: recipe.id, name: `${recipe.name} on CT ${job.vmid}`,
            ip: job.ip.split('/')[0], node: job.node!, vmid: job.vmid!, secret: proxySecret, owner: job.owner,
          })
          sp.status = 'done'
        } catch (e: any) {
          sp.status = 'failed'
          sp.detail = `It is installed and answering, but could not be added to the Proxy page: ${e?.message ?? e}. Add it there as a Managed instance.`
        }
      }
    }

    // 6. Publishing: only a service that answers on its own address gets a public name.
    if (ctx.publish) {
      if (s4.status !== 'done' || !job.ip) throw new Error(`${recipe.name} did not answer on its own address, so it was not published.`)
      job.ledger ??= {}
      job.url = await runPublish(ctx.publish, recipe, job.ip, job.owner, job.ledger,
        { step: id => step(job, id), save: () => { void persistJob(job).catch(e => persistFailed(job, e)) } }, deps.publish)
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
      installerLog.error({ err: e, jobId: job.jobId }, 'install result could not be saved')
    }
    await Promise.resolve(onSettled()).catch(() => {})
    if (job.status === 'completed') for (const fn of INSTALL_LISTENERS) { try { fn(job) } catch { /* a listener never fails an install */ } }
  }
}

/** Told about every install that finished (the Homepage plug-in's auto-sync listens). Read-only use only. */
const INSTALL_LISTENERS = new Set<(job: Readonly<InstallJob>) => void>()
export function onInstallCompleted(fn: (job: Readonly<InstallJob>) => void): () => void {
  INSTALL_LISTENERS.add(fn)
  return () => { INSTALL_LISTENERS.delete(fn) }
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
  /** 802.1Q tag on the guest's interface, from the naming settings or the person. */
  vlan?:    number
  /** Space-separated DNS servers; empty uses the node's. */
  dns?:     string
  /**
   * What the person typed to go against the naming settings: the word DHCP, or the address itself when it is
   * outside the range. Checked again at apply, and the override is written to the audit log there.
   */
  namingConfirm?: string
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
  /** HAProxy's optional step: the app to load-balance once it is installed, exactly as checked. */
  balance?: InstallBalance
  /** Open WebUI with no Ollama to use: the finished page offers to install one next. */
  offerOllama?: boolean
  unprivileged: true
}

export type WizardInput = Omit<InstallPlan, 'template' | 'downloadTemplate' | 'unprivileged' | 'publish' | 'options' | 'arrPublish' | 'balance'> & {
  options?: Record<string, unknown>
  /** An Arr Stack's VPN login. Never kept in the plan: the preview puts it in the vault. */
  arrVpn?: Record<string, unknown>
  /** An Arr Stack's public names: one zone, one proxy, a name per app. Checked into `arrPublish` by the preview. */
  arrNames?: ArrPublishInput
  /** Publish it: the zone, the name in it and the proxy. Checked into a PublishPlan by the preview. */
  publish?: PublishInput
  /** Ghost's SMTP password. Never kept in the plan: the preview puts it in the vault. */
  ghostSmtpPassword?: unknown
  /** HAProxy's optional "Load-balance an app now", as the plug-in's button sends it. Checked into `balance` by the preview. */
  balance?: unknown
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
  /** The saved naming settings, or null when none are saved. */
  readNaming(): Promise<NamingSettings | null>
  saveNaming(s: NamingSettings): Promise<void>
  /** An override of the naming settings, at apply. */
  audit(action: string, resource: string, details: Record<string, unknown>): Promise<void>
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
    ping: async (node, raw) => {
      // Only the normalised address (four octets, nothing else) ever reaches the command line.
      const ip = parseCidr(`${String(raw ?? '').trim()}/32`)?.ip
      if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null
      const cred = await nodeCredential(node).catch(() => null)
      if (!cred) return null
      const host = await nodeAddress(pve(), node).catch(() => '')
      if (!host) return null
      // A device that drops pings still answers ARP, so after the ping the node's neighbour table is asked too.
      const command = `if ping -c 2 -W 1 ${ip} >/dev/null 2>&1; then echo up; ` +
        `elif ip neigh show ${ip} 2>/dev/null | grep -q lladdr && ! ip neigh show ${ip} | grep -Eq 'FAILED|INCOMPLETE'; then echo up; else echo down; fi`
      const r = await execOnNode({ host, cred, command, timeoutMs: 15_000 })
        .catch(() => null)
      if (!r) return null
      return /\bup\b/.test(r.output) ? true : /\bdown\b/.test(r.output) ? false : null
    },
    readRule: async () => parseRule((await getProviderCredentials(RULE_CATEGORY, RULE_PROVIDER).catch(() => ({} as Record<string, string>)))[RULE_KEY]),
    saveRule: async rule => setCredential(RULE_CATEGORY, RULE_PROVIDER, RULE_KEY, JSON.stringify(rule), false),
    readNaming: readSavedNaming,
    saveNaming: async s => wizardStore().put({ id: NAMING_ID, kind: 'setting', owner: s.updatedBy ?? '', data: s, expiresAt: null }),
    audit: (action, resource, details) => auditCredentialUse(action, resource, details),
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
/**
 * The nodes that already run a guest of one of `recipe.spreadWith` (a finished Catalogue install whose guest is still
 * the one it made), for placement to count against. Empty for a recipe that does not spread.
 */
export async function spreadNodes(recipe: Pick<CatalogueRecipe, 'spreadWith'>, view: Pick<ClusterView, 'guests'>): Promise<string[]> {
  if (!recipe.spreadWith?.length) return []
  const out = new Set<string>()
  for (const r of await wizardStore().list('job').catch(() => [])) {
    const j: any = r.data
    if (!recipe.spreadWith.includes(j?.recipeId) || j?.status !== 'completed') continue
    const g = view.guests.find(x => Number(x.vmid) === Number(j.vmid))
    if (g && installStillOwns(j, g)) out.add(g.node)
  }
  return [...out]
}

export function placementFor(recipe: CatalogueRecipe, need: Need & { avoidNodes?: string[] }, view: ClusterView): {
  nodes: Array<NodeView & { verdict: NodeVerdict; rootStorages: PlacementStorage[]; excludedStorages: Array<PlacementStorage & { reason: string }> }>
  recommendation: { node: string; reason: string; storage: string } | null
} {
  const avoid = need.avoidNodes?.length ? { nodes: need.avoidNodes, what: `part of this ${recipe.spreadWith?.some(id => id.startsWith('k3s')) ? 'K3s cluster' : 'cluster'}` } : undefined
  const verdicts = scoreNodes(view.nodes, view.storages, { ...need, avoidNodes: avoid, needsGpu: recipe.needsGpu, wantsGpu: recipe.wantsGpu })
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
  live: LiveRead, pinged: boolean | null, naming: NamingSettings | null = null,
): { errors: string[]; warnings: string[]; checks: string[]; unknowns: string[]; override?: { kind: 'dhcp' | 'outside-range'; value: string } } {
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
    else if (recipe.install.kind !== 'vm' && ROOTFS_EXCLUDED[s.type]) errors.push(`${s.storage}: ${ROOTFS_EXCLUDED[s.type]}`)
    else if (!s.active || !s.content.includes(recipe.install.kind === 'vm' ? 'images' : 'rootdir')) errors.push(`${s.storage} on ${node.node} cannot hold ${recipe.install.kind === 'vm' ? 'virtual machine disks' : 'containers'}.`)
    else if (int(input.diskGb) && s.freeGb < Math.ceil(input.diskGb * 1.2)) errors.push(`${s.storage} has ${s.freeGb} GB free; this needs ${Math.ceil(input.diskGb * 1.2)} GB.`)
    else {
      checks.push(`${s.storage} (${s.shared ? 'shared' : 'local'}, ${s.type}) has ${s.freeGb} GB free.`)
      if (!s.shared) warnings.push(`${s.storage} is local to ${node.node}: HA cannot start this ${recipe.install.kind === 'vm' ? 'machine' : 'container'} on another node.`)
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
  if (input.vlan !== undefined && (!Number.isInteger(input.vlan) || input.vlan < 1 || input.vlan > 4094)) {
    errors.push('The VLAN tag must be a whole number from 1 to 4094.')
  }
  // The naming settings: DHCP and an address outside the range need the person's typed confirmation.
  const policy = namingPolicy(naming, { node: input.node, vmid: Number(input.vmid), ip: String(input.ip ?? ''), bridge: input.bridge }, input.namingConfirm)
  errors.push(...policy.errors); warnings.push(...policy.warnings)
  if (naming && input.ip !== 'dhcp' && !policy.errors.length && !policy.override) checks.push(`${bareIp(String(input.ip))} is inside your range ${naming.rangeStart}–${naming.rangeEnd}.`)
  if (recipe.options?.length) errors.push(...checkOptions(recipe, input.options, { trustHidden: true }).errors)
  if (input.dns && !DNS_LIST.test(input.dns)) errors.push(`"${input.dns}" is not a list of IPv4 DNS servers.`)
  else if (input.dns && input.dns.split(/[\s,]+/).some(d => !parseCidr(`${d}/32`))) errors.push(`"${input.dns}" holds an address that is not IPv4.`)

  return { errors, warnings, checks: checks.filter(Boolean), unknowns, ...(policy.override ? { override: policy.override } : {}) }
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
  const { view, live, pinged, naming } = await freshRead(input, deps)
  const r = checkPlan(input, recipe, view, live, pinged, naming)
  // The package cache needs a fixed, private address: guests are pointed at it by address, and HyperProx checks that
  // address against the container's Proxmox config before using it (its script refuses a public one too).
  if (recipe.setup === 'aptcache') {
    if (!input.ip || input.ip === 'dhcp') r.errors.push('The package cache needs a fixed address, not DHCP: your guests are pointed at it by its address.')
    else if (!aptCachePrivate(String(input.ip).split('/')[0])) r.errors.push(`The package cache is installed only on a private address (in 10/8, 172.16/12 or 192.168/16). ${String(input.ip).split('/')[0]} is not one.`)
  }
  // A forward proxy only ever listens on a private address: on a public one it would be an open proxy (its script
  // refuses that too, and a DHCP address is checked there).
  if (recipe.setup === 'fwdproxy' && input.ip && input.ip !== 'dhcp' && !isPrivateV4(String(input.ip).split('/')[0])) {
    r.errors.push(`${recipe.name} is installed only on a private address (10.x, 172.16–31.x or 192.168.x), so it can never be an open proxy on the internet. ${String(input.ip).split('/')[0]} is not one.`)
  }
  // The Arr Stack: its apps, its library (looked at from the node), its VPN login (to the vault) and public names.
  const arr = recipe.stack === 'arr' && !r.errors.length ? await arrPreview({
    node: input.node, vmid: input.vmid, owner, storage: input.storage, diskGb: input.diskGb, values: checkOptions(recipe, input.options).values,
    vpnSecrets: input.arrVpn, publish: input.arrNames,
    storageFreeGb: view.storages.find(x => x.node === input.node && x.storage === input.storage)?.freeGb,
  }, deps, () => randomBytes(6).toString('hex')) : null
  if (arr) { r.errors.push(...arr.errors); r.warnings.push(...arr.warnings); r.checks.push(...arr.checks); input = { ...input, options: arr.options } }
  // Unmanic and Tdarr: the node's hardware, the library, and (for a worker or node) the main server it joins.
  const tcp = isTranscode(recipe) && !r.errors.length ? await tcPreview({
    kind: kindOf(recipe.id), node: input.node, vmid: input.vmid, storage: input.storage, diskGb: input.diskGb, cores: input.cores,
    values: checkOptions(recipe, input.options).values, owner,
    storageFreeGb: view.storages.find(x => x.node === input.node && x.storage === input.storage)?.freeGb,
  }, deps) : null
  if (tcp) { r.errors.push(...tcp.errors); r.warnings.push(...tcp.warnings); r.checks.push(...tcp.checks); input = { ...input, options: tcp.options } }
  // K3s: its logins go to the vault, so it must be writable; an agent names a server HyperProx looks after.
  if (isK3s(recipe)) {
    if (!await deps.vaultOpen()) r.errors.push(`${recipe.name}'s admin login and HyperProx's tokens are kept in the vault, and the vault is locked. Sign in to unlock it.`)
    else if (!r.errors.length && deps.k3s) {
      const kp = await k3sPreview(recipe.id, checkOptions(recipe, input.options).values, { service: deps.k3s })
      r.errors.push(...kp.errors); r.checks.push(...kp.checks)
    }
  }
  // Ghost: the SMTP password into the vault (only this preview names its item), and what mail will do.
  if (recipe.setup === 'ghost') {
    const o = checkOptions(recipe, input.options)
    const g = o.errors.length || r.errors.length ? null : await ghostPreview(o.values, input.ghostSmtpPassword, deps)
    if (g) { r.errors.push(...g.errors); r.warnings.push(...g.warnings); r.checks.push(...g.checks) }
    // The reference is the preview's own, or empty: one sent in the request is never used.
    input = { ...input, options: g?.options ?? { ...o.values, GHOST_SMTP_REF: '' } }
  }
  // Immich: the node's hardware and the photo library, looked at from the node.
  let offerOllama = false
  if (recipe.setup === 'immich' && !r.errors.length) {
    const o = checkOptions(recipe, input.options)
    const ip = await immichPreview({
      node: input.node, vmid: input.vmid, storage: input.storage, diskGb: input.diskGb, values: o.values,
      storageFreeGb: view.storages.find(x => x.node === input.node && x.storage === input.storage)?.freeGb,
    }, deps)
    r.errors.push(...ip.errors); r.warnings.push(...ip.warnings); r.checks.push(...ip.checks); input = { ...input, options: ip.options }
  }
  // Open WebUI: which Ollama it is pointed at, asked to list its models before anything is made.
  if (recipe.setup === 'openwebui' && !r.errors.length) {
    const o = checkOptions(recipe, input.options)
    const arr = deps.arr?.()
    const op = await openwebuiPreview(o.values, { http: arr?.http ?? (async () => { throw new Error('no http') }), knownOllama: deps.knownOllama ?? (async () => null) })
    r.errors.push(...op.errors); r.warnings.push(...op.warnings); r.checks.push(...op.checks); input = { ...input, options: op.options }
    offerOllama = op.offerOllama
  }
  // Home Assistant OS: the processor decides the image, the USB devices must be plugged into the node, the node needs room to unpack it.
  if (recipe.setup === 'homeassistant' && !r.errors.length) {
    const hp = await haPreview(input, recipe, deps)
    r.errors.push(...hp.errors); r.warnings.push(...hp.warnings); r.checks.push(...hp.checks)
  }
  let publish: PublishPlan | undefined
  if (input.publish) {
    if (recipe.category !== 'web' && recipe.category !== 'network' && !recipe.publishable) r.errors.push(`${recipe.name} is not published by the wizard; only websites are.`)
    else {
      const pp = await planPublish(input.publish, deps.publish)
      r.errors.push(...pp.errors); r.warnings.push(...pp.warnings); r.checks.push(...pp.checks)
      publish = pp.plan
    }
  }
  // HAProxy's optional step: the plug-in's own checks, against the cluster as it is now.
  let balance: InstallBalance | undefined
  if (input.balance !== undefined && input.balance !== null) {
    if (recipe.setup !== 'haproxy') r.errors.push(`${recipe.name} has no "Load-balance an app now" step; only HAProxy does.`)
    else {
      const b = await balancePreview(input.balance, await (deps.haproxyBalanceCheck ?? realBalanceCheckDeps)())
      r.errors.push(...b.errors); r.checks.push(...b.checks)
      // A public name points at HAProxy's address, which a fixed address (not DHCP) gives it.
      if (b.value?.publish && input.ip === 'dhcp') r.errors.push('A public name points at HAProxy\'s address, so HAProxy needs a fixed address, not DHCP.')
      balance = b.value
    }
  }
  if (!r.errors.length && recipe.setup === 'pbs') {
    const pc = await pbsPreview(input, recipe, deps)
    r.errors.push(...pc.errors); r.warnings.push(...pc.warnings); r.checks.push(...pc.checks)
  }
  if (r.errors.length) return r
  // A virtual machine is made from the vendor's image, not a container template.
  const isVm = recipe.install.kind === 'vm'
  const vmImage = isVm ? imageFor(archOfKernel((await deps.client.fetchStrict<any>(`/nodes/${encodeURIComponent(input.node)}/status`).catch(() => null))?.['current-kernel']?.machine) || 'amd64') : null
  if (isVm && !vmImage) return { ...r, errors: [`${input.node} is not an x86 machine, and HyperProx makes Home Assistant OS machines for x86 only.`] }
  const t = isVm ? { template: vmImage!.file, download: false } : await resolveTemplate(deps.client, input.node, view)
  if ('error' in t) return { ...r, errors: [t.error] }
  if (t.download) r.warnings.push(`The template ${t.template.split('/').pop()} is downloaded to ${input.node} first.`)
  r.checks.push(isVm ? `Created from the official ${t.template}, checked against its published SHA-256.` : `Created from ${t.template.split('/').pop()}.`)

  const preview: Preview = {
    id: randomUUID(), owner, checks: r.checks, warnings: r.warnings, createdAt: now, expiresAt: now + PREVIEW_TTL_MS, used: false,
    plan: {
      recipeId: recipe.id, node: input.node, vmid: input.vmid, hostname: input.hostname,
      cores: input.cores, memoryMb: input.memoryMb, swapMb: input.swapMb, diskGb: input.diskGb,
      storage: input.storage, bridge: input.bridge, ip: input.ip,
      ...(input.ip !== 'dhcp' && input.gateway ? { gateway: input.gateway } : {}),
      ...(input.dns ? { dns: input.dns.trim().split(/[\s,]+/).join(' ') } : {}),
      ...(input.vlan ? { vlan: input.vlan } : {}),
      ...(r.override && input.namingConfirm ? { namingConfirm: input.namingConfirm.trim() } : {}),
      ...(input.ip !== 'dhcp' && input.addressAck?.length ? { addressAck: [...input.addressAck].sort() } : {}),
      ...(recipe.options?.length ? { options: checkOptions(recipe, input.options, { trustHidden: true }).values } : {}),
      ...(publish ? { publish } : {}),
      ...(balance ? { balance } : {}),
      ...(arr?.publish?.length ? { arrPublish: arr.publish } : {}),
      template: t.template, ...(t.download ? { downloadTemplate: true } : {}), unprivileged: true,
      ...(offerOllama ? { offerOllama: true } : {}),
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
  // Settings that cannot be read are not "no settings": the plan is refused rather than let DHCP through.
  const naming = await deps.readNaming()
  return { view, live, pinged, naming }
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

    const { view, live, pinged, naming } = await freshRead(plan, deps)
    const r = checkPlan(plan, recipe, view, live, pinged, naming)
    if (recipe.firstRun.kind === 'env-admin' && !await deps.vaultOpen()) r.errors.push('The vault is locked, so the generated admin password could not be kept.')
    if (isK3s(recipe) && !await deps.vaultOpen()) r.errors.push('The vault is locked, so K3s\'s admin login and HyperProx\'s tokens could not be kept.')
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
    if (plan.balance) {
      // The guests and the public name are checked again, so a guest that is now left alone or gone refuses the apply.
      const again = await balancePreview({ ...plan.balance, ...(plan.balance.publish ? { publish: true, zone: plan.balance.publish.zone, proxyInstanceId: plan.balance.publish.proxyInstanceId } : {}) }, await (deps.haproxyBalanceCheck ?? realBalanceCheckDeps)())
      r.errors.push(...again.errors)
    }
    if (r.errors.length) {
      throw new WizardRefusal('The cluster changed since the preview, so nothing was created.', 'changed', r.errors)
    }
    if (CREATING.has(plan.vmid)) throw new WizardRefusal('Another install is creating that ID now.', 'changed', [`ID ${plan.vmid} is being created.`])
    if (r.override) {
      // Going against the naming settings is allowed, typed and recorded: who, what, and for which guest.
      await deps.audit('naming.override', `ct/${plan.vmid}`, { kind: r.override.kind, value: r.override.value, node: plan.node, owner, recipe: plan.recipeId })
    }
    CREATING.add(plan.vmid)

    const isVm = recipe.install.kind === 'vm'
    const job = newJob(recipe, owner, `Create ${isVm ? 'VM' : 'CT'} ${plan.vmid} (${plan.hostname}) on ${plan.node}`, plan.publish, !!plan.balance)
    job.vmid = plan.vmid; job.node = plan.node; job.hostname = plan.hostname
    if (isVm) job.guest = 'vm'
    if (recipe.stack === 'arr') job.steps = arrJobSteps(job.steps, plan.options ?? {}, plan.arrPublish)
    if (isTranscode(recipe)) job.steps = tcJobSteps(job.steps, kindOf(recipe.id))
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
    const settle = async () => {
      // Held until the whole job settles, not just the create: an apply that read the cluster before this
      // container showed up must still be refused.
      CREATING.delete(plan.vmid)
      await store.delete(markId).catch(e => installerLog.warn({ err: e }, 'could not remove an install create mark'))
    }
    if (isVm) {
      void runVmJob(job, recipe, deps, plan, settle)
      return job
    }
    void runJob(job, recipe, deps, async () => {
      await createFromPlan(plan, recipe, job.jobId, deps.client, () => { job.created = true; void persistJob(job).catch(e => persistFailed(job, e)) })
      if (recipe.setup === 'pbs' && plan.options?.PBS_LOCATION === 'nas') await mountNasDatastore(job, plan, deps)
      await waitRunning(deps, plan.node, plan.vmid)
      if (recipe.stack === 'arr') {
        // keyctl, the VPN's tun device and the library, which an API token cannot set; then it starts again.
        job.arrPrepared = await arrPrepare(plan, deps, async () => { job.arrHostMount = { node: plan.node, vmid: plan.vmid }; await persistJob(job).catch(e => persistFailed(job, e)) })
        await waitRunning(deps, plan.node, plan.vmid)
      }
      if (isTranscode(recipe)) {
        // keyctl, the hardware devices and the library, which an API token cannot set; then it starts again.
        const prep = await tcPrepare(plan, kindOf(recipe.id), deps, async () => { job.arrHostMount = { node: plan.node, vmid: plan.vmid }; await persistJob(job).catch(e => persistFailed(job, e)) })
        job.tcPrepared = prep.detail; job.tcGroups = prep.groups
        await persistJob(job).catch(e => persistFailed(job, e))
        await waitRunning(deps, plan.node, plan.vmid)
      }
      if (isK3s(recipe)) {
        // keyctl, which an API token cannot set; then it starts again.
        job.k3sPrepared = await k3sPrepare(plan, { service: deps.k3s!, nodeRun: deps.nodeRun, client: deps.client })
        await persistJob(job).catch(e => persistFailed(job, e))
        await waitRunning(deps, plan.node, plan.vmid)
      }
      if (recipe.setup === 'immich') {
        // keyctl, the hardware devices and the photo library, which an API token cannot set; then it starts again.
        const prep = await immichPrepare(plan, { ...deps, arr: deps.arr, client: deps.client }, async () => { job.arrHostMount = { node: plan.node, vmid: plan.vmid }; await persistJob(job).catch(e => persistFailed(job, e)) })
        job.tcPrepared = prep.detail; job.tcGroups = prep.groups
        await persistJob(job).catch(e => persistFailed(job, e))
        await waitRunning(deps, plan.node, plan.vmid)
      }
      const distro = distroOf(plan.template)
      if (!distro) throw new Error(`${plan.template} is neither Debian nor Ubuntu.`)
      return { distro, ...(plan.ip !== 'dhcp' ? { ip: parseCidr(plan.ip)!.ip } : {}) }
    }, settle, { options: plan.options ?? {}, publish: plan.publish, arrPublish: plan.arrPublish, balance: plan.balance })
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
  for (const m of marks.values()) await store.delete(m.id).catch(e => installerLog.warn({ err: e }, 'could not remove a stale install create mark'))
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
  const isVm = job.guest === 'vm'
  const kind = isVm ? 'VM' : 'CT'
  const base = `/nodes/${enc(job.node)}/${isVm ? 'qemu' : 'lxc'}/${job.vmid}`
  // A create whose task failed is usually rolled back by Proxmox itself; then there is nothing to remove.
  const listed = await deps.client.fetchStrict<any[]>('/cluster/resources?type=vm')
  const here = (listed ?? []).find((r: any) => Number(r?.vmid) === job.vmid)
  if (!here) {
    job.removed = true
    const msg = `${kind} ${job.vmid} no longer exists, so there was nothing to remove.${await removePublished(job, deps)}${await removeHostMount(job, deps)}${await removeConnection(job, deps)}${await removeVaultItem(job, deps)}`
    await persistJob(job).catch(e => persistFailed(job, e))
    return msg
  }
  if (here.node !== job.node || here.type !== (isVm ? 'qemu' : 'lxc')) {
    throw new WizardRefusal(`ID ${job.vmid} is now a ${here.type === 'qemu' ? 'VM' : 'container'} on ${here.node}, not this install's container.`, 'changed')
  }
  const cfg = await deps.client.fetchStrict<Record<string, unknown>>(`${base}/config`)
  if (!String(cfg?.description ?? '').includes(installMark(job.jobId))) {
    throw new WizardRefusal(`${kind} ${job.vmid} does not carry this install's mark, so HyperProx will not remove it.`, 'changed')
  }
  let ha: any[]
  try { ha = (await deps.client.fetchStrict<any[]>('/cluster/ha/resources')) ?? [] }
  catch { throw new WizardRefusal(`HyperProx could not confirm whether ${kind} ${job.vmid} is under HA, so it was not removed. Try again.`, 'changed') }
  if (ha.some((h: any) => h?.sid === `${isVm ? 'vm' : 'ct'}:${job.vmid}`)) {
    throw new WizardRefusal(`${kind} ${job.vmid} is managed by HA now; remove it from HA first.`, 'changed')
  }
  // What publishing made goes first, while the container it points at still exists to be named.
  const published = await removePublished(job, deps)
  await persistJob(job).catch(e => persistFailed(job, e))
  const st = await deps.client.fetchStrict<any>(`${base}/status/current`)
  if (st?.status === 'running') {
    await deps.client.waitForTask(job.node, await deps.client.fetchStrict<string>(`${base}/status/stop`, 'POST'), { timeoutMs: 2 * 60_000 })
  }
  // purge=1 only: it removes the container, its referenced disks and its job/HA entries. Never
  // destroy-unreferenced-disks, which also deletes any older volume named for this ID that this install did not make.
  await deps.client.waitForTask(job.node,
    await deps.client.fetchStrict<string>(`${base}?purge=1`, 'DELETE'), { timeoutMs: 5 * 60_000 })
  const left = await deps.client.fetchStrict<any[]>('/cluster/resources?type=vm')
  if ((left ?? []).some((r: any) => Number(r?.vmid) === job.vmid)) throw new Error(`${kind} ${job.vmid} is still listed after the removal.`)
  job.removed = true
  const msg = `${kind} ${job.vmid} was removed from ${job.node}.${published}${await removeHostMount(job, deps)}${await removeConnection(job, deps)}${await removeVaultItem(job, deps)}`
  await persistJob(job).catch(e => persistFailed(job, e))
  return msg
}

/**
 * The container this install made was removed from Proxmox (lib/removed-guests): forget the install's record, and the
 * login vault item it made itself (one that existed before the install is kept). What it published is not touched
 * here; the removed-guest clean-up offers that separately.
 */
export async function forgetInstallRecord(jobId: string, over: Partial<WizardDeps> = {}): Promise<string> {
  const row = await wizardStore().get(jobId)
  const job = JOBS.get(jobId) ?? (row?.kind === 'job' ? (row.data as InstallJob) : null)
  if (!job) return 'The install record is already gone.'
  if (job.status === 'running') throw new WizardRefusal('That install is still running, so its record is kept.', 'changed')
  const conn = await removeConnection(job, wizardDeps(over))
  const vault = await removeVaultItem(job, wizardDeps(over))
  JOBS.delete(jobId)
  await wizardStore().delete(jobId)
  return `Forgot the ${job.recipeId} install record.${conn}${vault}`
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
  await persistJob(job).catch(e => persistFailed(job, e))
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
  // A transcoder's NAS mount goes the same way (above); the one link it added to a main Unmanic goes here.
  if (job.tcLink) arr.push(...await tcCleanup(job, deps).catch((e: any) => [`The Unmanic link clean-up failed: ${e.message}`]))
  // A public name still being made by HAProxy's optional step: what it has made so far is read now.
  // Read through the same deps the step used, merged once and then forgotten, so a retried clean-up does not
  // see removed items again. A failed publish removed its own.
  if (job.balancePublishJob) {
    const live = (await (deps.haproxyBalance ?? realBalanceDeps)().catch(() => null))?.publishJob(job.balancePublishJob)
    if (live && live.status !== 'failed') job.ledger = { ...(job.ledger ?? {}), ...structuredClone(live.ledger) }
    job.balancePublishJob = undefined
  }
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

// ---------------------------------------------------------------------------
//  Naming and addresses: the saved settings, what the cluster already does, and the next ID and address
// ---------------------------------------------------------------------------

export const readNamingSettings = (over: Partial<WizardDeps> = {}) => wizardDeps(over).readNaming()

/** Check and save the naming settings. The route has already had it confirmed on the page. */
export async function saveNamingSettings(raw: unknown, who: string, over: Partial<WizardDeps> = {}): Promise<{ settings?: NamingSettings; errors: string[] }> {
  const deps = wizardDeps(over)
  const v = validateNaming(raw)
  if (!v.settings) return v
  const settings: NamingSettings = { ...v.settings, updatedAt: new Date(deps.now()).toISOString(), updatedBy: who }
  await deps.saveNaming(settings)
  await deps.audit('naming.saved', 'settings/naming', {
    subnet: settings.subnet, range: `${settings.rangeStart}-${settings.rangeEnd}`, idScheme: settings.idScheme, dhcp: settings.dhcp, owner: who,
  })
  return { settings, errors: [] }
}

/** Does this cluster's numbering follow node + address? Read from the guests it has. */
export function detectFromView(view: ClusterView): Detection {
  return detectConvention(
    view.guests.map(g => ({ vmid: g.vmid, node: g.node, config: g.config })),
    view.nodes.map(n => ({ node: n.node, address: n.address, bridges: n.bridges })),
  )
}

export type NamingSource = 'settings' | 'detected' | 'subnet' | 'none'

export interface Proposal {
  source:   NamingSource
  /** "CT 3xx ↔ 192.0.2.2xx (your numbering)", or what the address is based on. */
  label:    string
  vmid:     number
  /** A static address with its prefix, or 'dhcp' when none could be picked. */
  ip:       string
  gateway?: string
  bridge:   string
  dns:      string[]
  vlan?:    number
  /** true: nothing answered a ping or ARP from the node. null: not asked. */
  quiet?:   boolean | null
  /** Shown beside the proposal: why it is DHCP, or what to look at. */
  warnings: string[]
  /** The settings it came from: saved, detected, or the node's own subnet. Absent with 'none'. */
  settings?: NamingSettings
  detection: Pick<Detection, 'verdict' | 'matching' | 'considered' | 'total'>
  skipped:  Array<{ ip: string; why: string }>
}

/**
 * The ID and address to offer for a new guest on `node`. Saved settings win; with none, a convention the guests
 * already follow; with none, a fixed address at the top of the node's own subnet; and only when nothing can be
 * picked safely, DHCP with a warning. Every candidate address is in no guest config (stopped guests included),
 * no running guest reports it, it is no node's and not the gateway, and (with `ping`) nothing answers it.
 */
export async function proposeFor(
  node: string, view: ClusterView, live: LiveRead, saved: NamingSettings | null,
  ping?: (node: string, ip: string) => Promise<boolean | null>,
): Promise<Proposal> {
  const detection = detectFromView(view)
  const det = { verdict: detection.verdict, matching: detection.matching, considered: detection.considered, total: detection.total }
  const n = view.nodes.find(x => x.node === node)
  const nextId = nextIdOf(view)
  const firstBridge = n?.bridges.find(b => b.gateway)?.iface ?? n?.bridges[0]?.iface ?? ''
  const base: Proposal = { source: 'none', label: 'next free ID', vmid: nextId, ip: 'dhcp', bridge: firstBridge, dns: [], warnings: [], detection: det, skipped: [] }

  let source: NamingSource = 'none'
  let settings: NamingSettings | null = null
  if (saved) { settings = saved; source = 'settings' }
  else if (detection.verdict === 'follows' && detection.proposal) { settings = detection.proposal; source = 'detected' }
  else if (n) { settings = managementFallback({ node: n.node, address: n.address, bridges: n.bridges }); if (settings) source = 'subnet' }
  if (!settings) {
    base.warnings.push(view.partial.includes('cluster-status')
      ? 'The node\'s own address could not be read, so no fixed address could be picked safely. DHCP may hand out an address on another network.'
      : 'No naming settings are saved and no fixed address could be picked safely, so this uses DHCP. DHCP may hand out an address on another network; set a range under Settings → Naming & addresses.')
    return base
  }

  const unread = view.partial.filter(p => p.startsWith('config:'))
  const taken = takenAddresses({
    configs: view.guests.map(g => ({ config: g.config })), live: live.seen,
    nodes: view.nodes.map(x => ({ address: x.address })),
  })
  const ctx = { node, usedIds: usedIds(view), nextId, taken, ...(ping ? { ping: (ip: string) => ping(node, ip) } : {}) }
  let r = await pickNext(settings, ctx)
  const warnings: string[] = []
  if (!r.pick && settings.idScheme === 'node-ip' && r.problem && !Number.isInteger(settings.nodeIndex[node])) {
    // A node with no index: an address from the range, and the next free ID.
    warnings.push(r.problem)
    r = await pickNext({ ...settings, idScheme: 'next-free' }, ctx)
  }
  if (!r.pick) {
    return { ...base, source, settings, skipped: r.skipped, warnings: [...warnings, `${r.problem ?? 'No address could be picked.'} This uses DHCP, which may hand out an address on another network.`] }
  }
  if (unread.length) warnings.push(`HyperProx could not read every guest's settings (${unread.length} unread), so the address must be checked again before install.`)
  if (live.unknown.length) warnings.push(`${live.unknown.length} running guest${live.unknown.length === 1 ? '' : 's'} could not be asked which address they hold.`)
  const bridge = n?.bridges.some(b => b.iface === settings!.bridge) ? settings.bridge : firstBridge
  if (bridge !== settings.bridge) warnings.push(`${node} has no bridge ${settings.bridge}; ${bridge || 'none'} is offered instead.`)
  const label = source === 'settings' ? `${schemeLabel(settings, node)} (your numbering)`
    : source === 'detected' ? `${schemeLabel(settings, node)} (follows your numbering: ${detection.matching} of ${detection.considered} guests with a fixed address)`
      : `a free address at the top of ${settings.subnet}, ${node}'s own network`
  return {
    source, label, vmid: r.pick.vmid, ip: r.pick.ip, gateway: r.pick.gateway || undefined, bridge, dns: r.pick.dns,
    ...(r.pick.vlan ? { vlan: r.pick.vlan } : {}), quiet: r.pick.quiet, warnings, settings, detection: det, skipped: r.skipped,
  }
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
    plexClaim: sharedPlexSignin(),
    // The Plex plug-in's own server and token, or the Jellyfin plug-in's address, API key and administrator sign-in (all in
    // the vault), when it has them: Seerr signs in with that account. The owner's choice wins; with none, Plex.
    mediaServer: async prefer => {
      const none = {} as Record<string, string>
      const [p, j] = await Promise.all([getSettings('plex').catch(() => none), getSettings('jellyfin').catch(() => none)])
      const k = serversFromSettings(p, j)
      return pickMediaServer(prefer, k.plex, k.jellyfin)
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
  const detail = await arrFinishSeerr({ prefer: job.arrMediaPrefer, ip: job.ip, vault: { category: job.vaultItem.category, provider: job.vaultItem.provider } }, {
    arr: deps.arr, wait: deps.wait, readSecrets: deps.readSecrets, saveSecrets: deps.saveSecrets,
    sh: (script, timeoutMs) => deps.exec({ host, cred, vmid: job.vmid!, script, timeoutMs, onData: () => {} }),
  })
  const st = job.steps.find(x => x.id === 'arr-seerr')
  if (st) { st.status = 'done'; st.detail = detail }
  job.arrSeerrWaiting = false
  await persistJob(job).catch(e => persistFailed(job, e))
  return detail
}

/** What a node can give a transcoder (Intel/AMD graphics, an NVIDIA card with its driver loaded), for the wizard's picker. */
export async function transcodeHardware(node: string, over: Partial<WizardDeps> = {}) {
  return nodeHardwareFacts(node, wizardDeps(over))
}

// ── Home Assistant OS: a virtual machine, not a container (lib/homeassistant) ─────────────────────────────

/** The preview's checks for Home Assistant OS: the USB devices are plugged into the node, and it has room to unpack the image. */
async function haPreview(input: WizardInput, recipe: CatalogueRecipe, deps: WizardDeps): Promise<{ errors: string[]; warnings: string[]; checks: string[] }> {
  const errors: string[] = [], warnings: string[] = [], checks: string[] = []
  const o = checkOptions(recipe, input.options).values
  const arr = deps.arr?.()
  if (!arr) return { errors: ['HyperProx cannot reach the node to look at it.'], warnings, checks }
  const run = (script: string, ms: number) => arr.nodeRun(input.node, script, ms).catch(() => null)
  const space = await run('df --output=avail -k /var/tmp | tail -1', 20_000)
  const free = Number(String(space?.output ?? '').trim().split(/\s+/).pop())
  if (!Number.isFinite(free)) errors.push(`HyperProx could not look at the free space on ${input.node}.`)
  else if (free < 4194304) errors.push(`${input.node} has ${Math.floor(free / 1048576)} GB free in /var/tmp, and the image needs about 4 GB while it is unpacked. Free some space there or pick another node.`)
  else checks.push(`${input.node} has room to unpack the image (it is removed again after the import).`)
  const usb = usbList(o.HA_USB ?? '')
  if (usb.length) {
    const devices = parseUsb((await run(HAVM_USB_SCRIPT, 30_000))?.output ?? '')
    const r = resolveUsb(devices, usb, input.node)
    errors.push(...r.errors)
    for (const h of r.hosts) checks.push(`USB device ${h} is plugged into ${input.node}, is not one the node needs, and will be passed in.`)
    warnings.push(`Passing a USB device in ties the machine to ${input.node}: Proxmox cannot move it or restart it on another node while it holds the device.`)
  }
  if (input.diskGb < 32) warnings.push('Home Assistant OS\'s disk image is 32 GB, so the machine\'s disk is 32 GB whatever is asked for here.')
  checks.push('The machine is UEFI (q35) with VirtIO disk and network, the guest agent on, and it starts when the node does.')
  if (input.ip === 'dhcp') warnings.push('Home Assistant OS starts on an address from DHCP and keeps it. Give it a reservation on your router, or choose a fixed address so it stays where you expect it.')
  else checks.push('The machine starts on a DHCP address and is then set to the fixed address you chose, through Home Assistant\'s own network settings.')
  return { errors, warnings, checks }
}

/** USB devices plugged into a node, for the wizard's picker (read-only). */
export async function homeAssistantUsb(node: string, over: Partial<WizardDeps> = {}) {
  const arr = wizardDeps(over).arr?.()
  if (!arr) throw new Error('HyperProx cannot reach the node.')
  const r = await arr.nodeRun(node, HAVM_USB_SCRIPT, 30_000)
  return parseUsb(r.output)
}

/**
 * The Home Assistant OS install. The virtual machine is made through Proxmox's API; the disk is imported over the node's
 * login; Home Assistant's own onboarding does the rest (lib/homeassistant/job.ts). A public name is made only once Home
 * Assistant is proved to trust the proxy, otherwise the finished page says what to add and where.
 */
async function runVmJob(job: InstallJob, recipe: CatalogueRecipe, deps: WizardDeps, plan: InstallPlan, onSettled: () => Promise<void> | void): Promise<void> {
  const options = plan.options ?? {}
  try {
    const ha = deps.ha?.(), arr = deps.arr?.()
    if (!ha || !arr) throw new Error('Home Assistant\'s setup is not available here.')
    // The owner's generated password is in the vault before anything is made, and before anything else runs: a password that exists only in a running machine is a lockout, and a locked vault must not leave a machine behind.
    if (!await deps.vaultOpen()) throw new Error('Home Assistant\'s owner gets a generated password, which is saved in the vault, and the vault is locked. Sign in to unlock it and try again.')
    const owner = { name: options.HA_OWNER_NAME || 'Owner', username: options.HA_OWNER_USER || 'owner', password: randomBytes(18).toString('base64url') }
    const provider = `${recipe.id}-${job.vmid}`
    const before = await deps.readSecrets('apps', provider).catch(() => null)
    await deps.saveSecrets('apps', provider, { admin_user: owner.username, admin_password: owner.password })
    job.vaultItem = { category: 'apps', provider, createdByJob: before !== null && Object.keys(before).length === 0 }
    await persistJob(job).catch(e => persistFailed(job, e))
    const s1 = step(job, 'container')
    const image = imageFor('amd64')!
    await createHaVm(plan, `${recipe.name}, installed by HyperProx on ${new Date().toISOString().slice(0, 10)}.\n${installMark(job.jobId)}`, deps.client,
      () => { job.created = true; void persistJob(job).catch(e => persistFailed(job, e)) })
    s1.status = 'done'; s1.detail = `VM ${job.vmid} on ${job.node}`
    const proxyIp = plan.publish ? await deps.publish.proxy.instanceAddress?.(plan.publish.instanceId).catch(() => null) ?? undefined : undefined

    const res = await runHaSetup({
      node: plan.node, vmid: plan.vmid,
      plan: { storage: plan.storage, diskGb: plan.diskGb, ip: plan.ip, gateway: plan.gateway, dns: plan.dns },
      image, name: options.HA_NAME || 'Home', units: options.HA_UNITS === 'us_customary' ? 'us_customary' : 'metric', timeZone: await ha.timeZone(plan.node).catch(() => 'UTC'),
      owner, usb: usbList(options.HA_USB ?? ''), vault: { category: 'apps', provider }, publishing: !!plan.publish, proxyIp,
    }, id => step(job, id), {
      client: deps.client, nodeRun: arr.nodeRun, http: arr.http, socket: ha.socket, wait: deps.wait, saveSecrets: deps.saveSecrets,
      connect: async o => { const r = await ha.connect(o); job.connected = { plugin: 'home-assistant', instanceId: r.id }; await persistJob(job).catch(e => persistFailed(job, e)); return r },
      agentFile: ha.agentFile,
    }, ip => { job.ip = ip })
    job.ip = res.ip; job.url = res.url; job.haTrustNote = res.trustNote

    // A public name only when Home Assistant trusts the proxy: without that every request through the proxy is refused with a 400.
    if (plan.publish) {
      if (res.trusted) {
        job.ledger ??= {}
        try {
          job.url = await runPublish(plan.publish, recipe, res.ip, job.owner, job.ledger,
            { step: id => step(job, id), save: () => { void persistJob(job).catch(e => persistFailed(job, e)) } }, deps.publish)
        } catch (e: any) {
          // The public check goes through the proxy, so it is the proof that Home Assistant accepts it.
          throw new Error(`${e.message} Home Assistant was told to trust ${proxyIp ?? 'the proxy'} only. If the proxy reaches Home Assistant from another address, put that address in trusted_proxies in Home Assistant's configuration.yaml.`)
        }
      } else {
        for (const st of PUBLISH_STEPS) { const x = job.steps.find(y => y.id === st.id); if (x) { x.status = 'skipped'; x.detail = 'Not made: Home Assistant does not trust the proxy yet.' } }
      }
    }
    job.adminCredential = { user: owner.username, vault: { category: 'apps', provider, key: 'admin_password' }, issuedAt: Date.now() }
    job.status = 'completed'
  } catch (e: any) {
    job.status = 'failed'
    job.error = e.message
    const running = job.steps.find(x => x.status === 'running')
    if (running) { running.status = 'failed'; running.detail = e.message }
  } finally {
    job.finishedAt = Date.now()
    try { await persistJob(job) }
    catch (e: any) {
      job.storeError = `The result of this install could not be saved: ${e.message}. After a restart HyperProx will not know how it ended.`
      installerLog.error({ err: e, jobId: job.jobId }, 'install result could not be saved')
    }
    await Promise.resolve(onSettled()).catch(() => {})
    if (job.status === 'completed') for (const fn of INSTALL_LISTENERS) { try { fn(job) } catch { /* a listener never fails an install */ } }
  }
}

/**
 * Disconnect the plug-in this install connected, and only that: Immich and Open WebUI's own settings (the install did not
 * replace a connection that was already there), or the Home Assistant instance it added. Returns a sentence to append.
 */
async function removeConnection(job: InstallJob, deps: WizardDeps): Promise<string> {
  const c = job.connected
  const pc = deps.pluginCreds ?? realPluginCreds
  if (!c) return ''
  const port = c.plugin === 'immich' ? 2283 : c.plugin === 'openwebui' ? 8080 : 8123
  const mine = job.ip ? `http://${job.ip.split('/')[0]}:${port}` : null
  const label = c.plugin === 'home-assistant' ? 'Home Assistant' : c.plugin === 'immich' ? 'Immich' : 'Open WebUI'
  try {
    // Only a connection that still points at THIS install is removed: the plug-in may have been moved to another one since.
    const now = (await pc.get(c.plugin, 'url').catch(() => null))?.replace(/\/+$/, '') ?? null
    const ownInstance = c.plugin === 'home-assistant' && !!c.instanceId && c.instanceId !== 'default'
    if (!ownInstance && (!mine || now !== mine)) {
      job.connected = undefined
      return ` The ${label} plug-in no longer points at this install, so its connection was left as it is.`
    }
    if (c.plugin === 'home-assistant') {
      if (c.instanceId && c.instanceId !== 'default') await new HaInstanceStore({ get: getCredential, set: setCredential, remove: deleteProviderCredentials }).remove(c.instanceId)
      else {
        // The first instance is the plug-in's own settings: this install's address and token go, and only its entry leaves the list.
        await pc.del('home-assistant', 'url'); await pc.del('home-assistant', 'token')
        const raw = await pc.get('home-assistant', 'instances').catch(() => null)
        if (raw) {
          const list = (() => { try { const v = JSON.parse(raw); return Array.isArray(v) ? v : null } catch { return null } })()
          if (list) { const rest = list.filter((x: any) => x?.id !== 'default'); if (rest.length) await pc.set('home-assistant', 'instances', JSON.stringify(rest)); else await pc.del('home-assistant', 'instances') }
        }
      }
    } else await pc.delProvider(c.plugin)
    job.connected = undefined
    return ` The ${label} plug-in connection this install made was removed.`
  } catch (e: any) {
    return ` The plug-in connection this install made could not be removed: ${e.message}`
  }
}
