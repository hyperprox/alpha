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
import { randomBytes } from 'node:crypto'
import { findRecipe, type CatalogueRecipe } from './catalogue'
import { installScript, distroOf, type Distro } from './install-script'
import { pickTemplate } from './wizard-placement'
import type { CreatePVE } from './wizard-executor'
import type { ExecResult } from './node-exec'
import { setCredential, setCredentials, getProviderCredentials } from './credentials'
import { saveSettings, getSettings } from './plugin-host'
import { PLUGINS } from '../plugins'

export type Phase = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface InstallStep {
  id: string; label: string; status: Phase; detail?: string
}

export interface InstallJob {
  jobId:    string
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
  /** Is the vault open for writing? Asked before anything is created. */
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
  vaultOpen:   () => getProviderCredentials('apps', 'vault-probe').then(() => true, () => false),
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
//  Container creation
// ---------------------------------------------------------------------------

export async function createContainer(
  recipe: CatalogueRecipe,
  res: { cores: number; memoryMb: number; diskGb: number },
  preferNode?: string,
  client: CreatePVE = pve(),
): Promise<{ vmid: number; node: string; distro: Distro }> {
  const vmid   = Number(await client.fetchStrict<number>('/cluster/nextid'))

  const nodes  = (await client.getNodes()).filter((n: any) => n.status === 'online')
  if (!nodes.length) throw new Error('No online Proxmox node to place this on.')
  const node = preferNode
    ? (nodes.find((n: any) => n.node === preferNode)?.node
       ?? (() => { throw new Error(`Node ${preferNode} is not online.`) })())
    : [...nodes].sort((a: any, b: any) => (b.maxmem - b.mem) - (a.maxmem - a.mem))[0].node

  // A template, preferring the newest Debian on offer.
  const stores = await client.fetchNode<any[]>(`/nodes/${node}/storage?content=vztmpl`).catch(() => []) ?? []
  const volids: string[] = []
  for (const s of stores) {
    const contents = await client
      .fetchNode<any[]>(`/nodes/${node}/storage/${s.storage}/content?content=vztmpl`).catch(() => []) ?? []
    for (const c of contents) if (c.volid) volids.push(c.volid)
  }
  const template = pickTemplate(volids)
  if (!template) {
    throw new Error(`No Debian or Ubuntu template on ${node}. Download one in Proxmox first — ` +
                    `local storage → CT Templates → Templates.`)
  }
  const distro = distroOf(template)
  if (!distro) throw new Error(`${template} is neither Debian nor Ubuntu; HyperProx installs only on those.`)

  // Same ranking the AI wizard uses: a container rootfs does not belong on a
  // network share just because the share is emptiest.
  const RANK: Record<string, number> = { rbd: 0, zfspool: 0, lvmthin: 1, lvm: 1, btrfs: 1, dir: 2, nfs: 3, cifs: 4 }
  const roots = ((await client.fetchNode<any[]>(`/nodes/${node}/storage?content=rootdir`).catch(() => [])) ?? [])
    .filter((s: any) => s.enabled && s.active && s.avail > res.diskGb * 1024 ** 3 * 1.2)
    .sort((a: any, b: any) => (RANK[a.type] ?? 5) - (RANK[b.type] ?? 5) || b.avail - a.avail)
  if (!roots.length) throw new Error(`No storage on ${node} has ${res.diskGb} GB free for the rootfs.`)

  // Docker runs in an unprivileged container with nesting. HyperProx signs in with an API
  // token, and Proxmox lets only root@pam set any feature flag other than nesting or create a
  // privileged container, so asking for either fails the create with a 403 before anything exists.
  const upid = await client.createLXC(node, {
    vmid,
    hostname:     recipe.id.slice(0, 60),
    ostemplate:   template,
    memory:       res.memoryMb,
    cores:        res.cores,
    storage:      roots[0].storage,
    rootfs_size:  res.diskGb,
    net0:         'name=eth0,bridge=vmbr0,ip=dhcp,firewall=1',
    unprivileged: true,
    features:     'nesting=1',
    onboot:       true,
    start:        true,
    password:     randomBytes(12).toString('base64url') + 'Aa1',
    description:  `${recipe.name}, installed by HyperProx on ${new Date().toISOString().slice(0, 10)}`,
  })
  await client.waitForTask(node, upid, { timeoutMs: 5 * 60_000 })

  return { vmid, node, distro }
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
 * Decide where this goes, and prove we can finish it, before anything exists.
 *
 * The first version of this checked for a node login at the install step —
 * which is to say, after creating a container. A missing login then cost the
 * user a stray guest to clean up, for a job that could never have succeeded.
 * The check that matters is the one that happens before the side effect.
 */
async function preflight(d: InstallDeps, opts: { intoVmid?: number; node?: string }): Promise<{ node: string; vmid?: number }> {
  const client = d.client

  if (typeof opts.intoVmid === 'number') {
    const all = await client.getClusterResources('vm')
    const g = (all as any[]).find(r => Number(r.vmid) === opts.intoVmid && r.type === 'lxc')
    if (!g) throw new Error(`CT ${opts.intoVmid} was not found. Only containers can be used, not VMs.`)
    if (g.status !== 'running') throw new Error(`CT ${opts.intoVmid} is not running.`)
    if (!await d.credential(g.node).catch(() => null)) {
      throw new Error(`CT ${opts.intoVmid} is on ${g.node}, which has no SSH login stored. ` +
                      `Add one on the Catalogue page and try again.`)
    }
    return { node: g.node, vmid: Number(g.vmid) }
  }

  const online = (await client.getNodes()).filter((n: any) => n.status === 'online')
  if (!online.length) throw new Error('No online Proxmox node to place this on.')

  if (opts.node) {
    const n = online.find((x: any) => x.node === opts.node)
    if (!n) throw new Error(`Node ${opts.node} is not online.`)
    if (!await d.credential(opts.node).catch(() => null)) {
      throw new Error(`Node ${opts.node} has no SSH login stored, so the install could not be run there. ` +
                      `Add one on the Catalogue page and try again.`)
    }
    return { node: opts.node }
  }

  // Auto-placement only considers nodes the install can actually run on. The
  // roomiest node is no use if nothing can execute there.
  const usable = (await Promise.all(online.map(async (n: any) =>
    (await d.credential(n.node).catch(() => null)) ? n : null))).filter(Boolean) as any[]

  if (!usable.length) {
    throw new Error('No node has an SSH login stored, so nothing can be installed yet. ' +
                    'Add one on the Catalogue page — installs run with pct exec from the node.')
  }
  return { node: usable.sort((a, b) => (b.maxmem - b.mem) - (a.maxmem - a.mem))[0].node }
}

export async function startInstall(opts: {
  recipeId: string
  /** Omit to create a container; give a vmid to install into one you already have. */
  intoVmid?: number
  node?: string
  resources?: { cores: number; memoryMb: number; diskGb: number }
}, deps: InstallDeps = realDeps()): Promise<InstallJob> {
  const recipe = findRecipe(opts.recipeId)
  if (!recipe) throw new Error(`No recipe called ${opts.recipeId}`)

  // Throws before a job exists, so a refusal is an error the caller sees rather
  // than a job that fails asynchronously three minutes later.
  if (recipe.firstRun.kind === 'env-admin' && !await deps.vaultOpen()) {
    throw new Error(`${recipe.name} gets a generated admin password, which is saved in the vault, and the vault is locked. Sign in to unlock it and try again.`)
  }
  const target = await preflight(deps, opts)

  const reuse = typeof opts.intoVmid === 'number'
  const job: InstallJob = {
    jobId: `inst_${Date.now()}_${Math.random().toString(36).slice(-4)}`,
    recipeId: recipe.id,
    status: 'running',
    log: '',
    startedAt: Date.now(),
    steps: [
      { id: 'container', label: reuse ? `Use CT ${opts.intoVmid}` : `Create a container for ${recipe.name}`, status: 'pending' },
      { id: 'network',   label: 'Wait for an address',   status: 'pending' },
      { id: 'install',   label: `Install ${recipe.name}`, status: 'pending' },
      { id: 'verify',    label: 'Check it answers',       status: 'pending' },
      { id: 'wire',      label: 'Configure the integration', status: 'pending' },
    ],
  }
  JOBS.set(job.jobId, job)

  ;(async () => {
    try {
      // 1. A container to put it in.
      let distro: Distro | null = null
      const s1 = step(job, 'container')
      if (reuse) {
        job.vmid = target.vmid; job.node = target.node
        const cfg = await deps.client.fetchNode<any>(`/nodes/${target.node}/lxc/${target.vmid}/config`).catch(() => null)
        distro = distroOf(String(cfg?.ostype ?? ''))
        if (!distro) {
          throw new Error(`CT ${target.vmid} is ${cfg?.ostype ? `"${cfg.ostype}"` : 'of unknown type'}, which is neither Debian nor Ubuntu; HyperProx installs only on those.`)
        }
      } else {
        const made = await createContainer(recipe, opts.resources ?? {
          cores: recipe.defaults.cores, memoryMb: recipe.defaults.memoryMb, diskGb: recipe.defaults.diskGb,
        }, target.node, deps.client)
        job.vmid = made.vmid; job.node = made.node; distro = made.distro
        await waitRunning(deps, made.node, made.vmid)
      }
      s1.status = 'done'
      s1.detail = `CT ${job.vmid} on ${job.node}`

      // 2. An address, so the health check and the integration have somewhere to point.
      const s2 = step(job, 'network')
      job.ip = await waitAddress(deps, job.node!, job.vmid!)
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
      const env: Record<string, string> = {}
      if (recipe.firstRun.kind === 'env-admin' && admin) {
        env[recipe.firstRun.passwordEnv] = admin.password
        if (recipe.firstRun.userEnv) env[recipe.firstRun.userEnv] = admin.user
        // Saved before the install runs: a password that exists only in a script that already ran
        // is a lockout. If the vault write fails, nothing is installed.
        await deps.saveSecrets('apps', `${recipe.id}-${job.vmid}`, { admin_user: admin.user, admin_password: admin.password })
      }
      const run = await deps.exec({
        host: nodeIp, cred, vmid: job.vmid!, script: installScript(recipe, distro!, env),
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
  })()

  return job
}

/** Node name to address. Names are not reliably resolvable from a container. */
async function nodeAddress(client: Pick<CreatePVE, 'fetchNode'>, node: string): Promise<string> {
  const status = await client.fetchNode<any[]>('/cluster/status').catch(() => [])
  const row = (status ?? []).find((r: any) => r.type === 'node' && r.name === node)
  if (!row?.ip) throw new Error(`Could not find an address for node ${node}.`)
  return row.ip
}
