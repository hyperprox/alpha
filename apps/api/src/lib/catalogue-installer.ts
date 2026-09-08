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
import { findRecipe, type CatalogueRecipe } from './catalogue'
import { setCredential } from './credentials'
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
  startedAt: number
  finishedAt?: number
}

const JOBS = new Map<string, InstallJob>()
export const getInstallJob = (id: string) => JOBS.get(id)

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

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

async function createContainer(
  recipe: CatalogueRecipe,
  res: { cores: number; memoryMb: number; diskGb: number },
  preferNode?: string,
): Promise<{ vmid: number; node: string }> {
  const client = pve()
  const vmid   = Number(await client.fetchNode<number>('/cluster/nextid'))

  const nodes  = (await client.getNodes()).filter((n: any) => n.status === 'online')
  if (!nodes.length) throw new Error('No online Proxmox node to place this on.')
  const node = preferNode
    ? (nodes.find((n: any) => n.node === preferNode)?.node
       ?? (() => { throw new Error(`Node ${preferNode} is not online.`) })())
    : nodes.sort((a: any, b: any) => (b.maxmem - b.mem) - (a.maxmem - a.mem))[0].node

  // A template, preferring the newest Debian on offer.
  const stores = await client.fetchNode<any[]>(`/nodes/${node}/storage?content=vztmpl`).catch(() => [])
  let template = ''
  for (const s of stores) {
    const contents = await client
      .fetchNode<any[]>(`/nodes/${node}/storage/${s.storage}/content?content=vztmpl`).catch(() => [])
    const found = contents
      .filter((c: any) => /debian-1[23]|ubuntu-2[24]/.test(c.volid ?? ''))
      .sort((a: any, b: any) => String(b.volid).localeCompare(String(a.volid)))[0]
    if (found) { template = found.volid; break }
  }
  if (!template) {
    throw new Error(`No Debian or Ubuntu template on ${node}. Download one in Proxmox first — ` +
                    `local storage → CT Templates → Templates.`)
  }

  // Same ranking the AI wizard uses: a container rootfs does not belong on a
  // network share just because the share is emptiest.
  const RANK: Record<string, number> = { rbd: 0, zfspool: 0, lvmthin: 1, lvm: 1, btrfs: 1, dir: 2, nfs: 3, cifs: 4 }
  const roots = (await client.fetchNode<any[]>(`/nodes/${node}/storage?content=rootdir`).catch(() => []))
    .filter((s: any) => s.enabled && s.active && s.avail > res.diskGb * 1024 ** 3 * 1.2)
    .sort((a: any, b: any) => (RANK[a.type] ?? 5) - (RANK[b.type] ?? 5) || b.avail - a.avail)
  if (!roots.length) throw new Error(`No storage on ${node} has ${res.diskGb} GB free for the rootfs.`)

  // Docker in LXC needs a privileged container with nesting and keyctl. An
  // unprivileged one fails at the first overlay mount, with an error that reads
  // like a broken image rather than a container feature flag.
  const docker = recipe.needsDocker

  await client.createLXC(node, {
    vmid,
    hostname:     recipe.id.slice(0, 60),
    ostemplate:   template,
    memory:       res.memoryMb,
    cores:        res.cores,
    storage:      roots[0].storage,
    rootfs:       `${roots[0].storage}:${res.diskGb}`,
    net0:         'name=eth0,bridge=vmbr0,ip=dhcp,firewall=1',
    unprivileged: docker ? 0 : 1,
    features:     docker ? 'nesting=1,keyctl=1' : 'nesting=1',
    start:        1,
    password:     Math.random().toString(36).slice(-14) + 'Aa1',
    description:  `${recipe.name}, installed by HyperProx on ${new Date().toISOString().slice(0, 10)}`,
  } as any)

  return { vmid, node }
}

async function waitRunning(node: string, vmid: number): Promise<void> {
  const client = pve()
  for (let i = 0; i < 24; i++) {
    await sleep(5000)
    const st = await client.fetchNode<any>(`/nodes/${node}/lxc/${vmid}/status/current`).catch(() => null)
    if (st?.status === 'running') return
  }
  throw new Error(`CT ${vmid} did not start within two minutes.`)
}

async function waitAddress(node: string, vmid: number): Promise<string | undefined> {
  const client = pve()
  for (let i = 0; i < 12; i++) {
    await sleep(5000)
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
async function preflight(opts: { intoVmid?: number; node?: string }): Promise<{ node: string; vmid?: number }> {
  const client = pve()

  if (typeof opts.intoVmid === 'number') {
    const all = await client.getClusterResources('vm')
    const g = (all as any[]).find(r => Number(r.vmid) === opts.intoVmid && r.type === 'lxc')
    if (!g) throw new Error(`CT ${opts.intoVmid} was not found. Only containers can be used, not VMs.`)
    if (g.status !== 'running') throw new Error(`CT ${opts.intoVmid} is not running.`)
    if (!await nodeCredential(g.node).catch(() => null)) {
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
    if (!await nodeCredential(opts.node).catch(() => null)) {
      throw new Error(`Node ${opts.node} has no SSH login stored, so the install could not be run there. ` +
                      `Add one on the Catalogue page and try again.`)
    }
    return { node: opts.node }
  }

  // Auto-placement only considers nodes the install can actually run on. The
  // roomiest node is no use if nothing can execute there.
  const usable = (await Promise.all(online.map(async (n: any) =>
    (await nodeCredential(n.node).catch(() => null)) ? n : null))).filter(Boolean) as any[]

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
}): Promise<InstallJob> {
  const recipe = findRecipe(opts.recipeId)
  if (!recipe) throw new Error(`No recipe called ${opts.recipeId}`)

  // Throws before a job exists, so a refusal is an error the caller sees rather
  // than a job that fails asynchronously three minutes later.
  const target = await preflight(opts)

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
      const s1 = step(job, 'container')
      if (reuse) {
        job.vmid = target.vmid; job.node = target.node
      } else {
        const made = await createContainer(recipe, opts.resources ?? {
          cores: recipe.defaults.cores, memoryMb: recipe.defaults.memoryMb, diskGb: recipe.defaults.diskGb,
        }, target.node)
        job.vmid = made.vmid; job.node = made.node
        await waitRunning(made.node, made.vmid)
      }
      s1.status = 'done'
      s1.detail = `CT ${job.vmid} on ${job.node}`

      // 2. An address, so the health check and the integration have somewhere to point.
      const s2 = step(job, 'network')
      job.ip = await waitAddress(job.node!, job.vmid!)
      s2.status = job.ip ? 'done' : 'skipped'
      s2.detail = job.ip ?? 'no address yet — DHCP may still be running'

      // 3. The recipe itself, run from the node.
      const s3 = step(job, 'install')
      const cred = await nodeCredential(job.node!)
      if (!cred) {
        throw new Error(
          `No SSH login stored for node ${job.node}. HyperProx runs the install with ` +
          `\`pct exec\` from the node, which needs one. Add it under Settings → Nodes.`)
      }
      const nodeIp = await nodeAddress(job.node!)
      const run = await execInGuest({
        host: nodeIp, cred, vmid: job.vmid!, script: recipe.script,
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
          await sleep(3000)
          ok = await fetch(url + recipe.healthPath, { signal: AbortSignal.timeout(4000) })
            .then(r => r.status < 500).catch(() => false)
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
async function nodeAddress(node: string): Promise<string> {
  const status = await pve().fetchNode<any[]>('/cluster/status').catch(() => [])
  const row = (status ?? []).find((r: any) => r.type === 'node' && r.name === node)
  if (!row?.ip) throw new Error(`Could not find an address for node ${node}.`)
  return row.ip
}
