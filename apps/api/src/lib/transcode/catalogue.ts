// =============================================================================
//  HyperProx — Unmanic and Tdarr as catalogue recipes
//
//  The places the install wizard hands over to them (the same four as the Arr
//  Stack's, in lib/arr/catalogue.ts):
//    preview  the node's hardware is looked at and the choice resolved against
//             it (never a quiet fallback), the library is looked at from the node
//             (a folder is also written to, as the container's user), and a
//             worker's main server is asked to answer;
//    create   after Proxmox makes the container: nesting, keyctl, the hardware
//             devices and the library mountpoint, set over the node's login (an
//             API token cannot set them), then read back;
//    install  the compose file, folders and (NVIDIA) libraries, through the
//             generic script runner;
//    setup    the chores in setup.ts, then the Unmanic plug-in.
//  Clean-up undoes what this install made outside its container: the NAS mount
//  on its node (the Arr Stack's own undo, which removes only the fstab line
//  carrying this container's id) and the one link it added to a main Unmanic.
// =============================================================================

import type { CatalogueRecipe } from '../catalogue'
import { hostPathRefusal, parseProbe, prepareScript, unmountScript, type Layout } from '../arr/storage'
import { configProblems } from '../arr/storage'
import type { ArrDeps } from '../arr/catalogue'
import type { StepRef } from '../arr/setup'
import { HARDWARE_SCRIPT, deviceSettings, groupAdd, hardwareFacts, parseHardware, resolveAccel, type Accel, type NodeHardware } from './hardware'
import { layoutFromOptions, judgeMedia, mediaProbeScript, prepareNoLibraryScript, LAYOUT_LINE } from './media'
import { scriptEnv, TDARR_VERSION, TDARR_SERVER_PORT, TDARR_WEB_PORT, UNMANIC_PORT, type TcKind } from './compose'
import { TRANSCODE_IDS, parseMainUrl } from './recipes'
import {
  linkWorker, tdarrServerVersion, tdarrUrl, unlinkWorker, unmanicUrl, waitForTdarr, waitForTdarrNode, waitForUnmanic,
  setUnmanicLibrary, setUnmanicWorkers, wireUnmanicPlugin, type LinkRecord, type TcSetupDeps,
} from './setup'

export { TRANSCODE_RECIPES, TRANSCODE_IDS } from './recipes'

export const isTranscode = (recipe: Pick<CatalogueRecipe, 'id' | 'stack'>) => recipe.stack === 'transcode'

export function kindOf(recipeId: string): TcKind {
  if (!(TRANSCODE_IDS as readonly string[]).includes(recipeId)) throw new Error(`${recipeId} is not a transcoder recipe.`)
  return recipeId as TcKind
}
const hasLibrary = (k: TcKind) => k !== 'unmanic-worker'
const appName = (k: TcKind) => (k.startsWith('unmanic') ? 'Unmanic' : 'Tdarr')

// ── Preview ─────────────────────────────────────────────────────────────────

/** Did a bare TCP connection from the node to host:port work? Read-only, short. */
export const reachScript = (host: string, port: number) => {
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host) || !Number.isInteger(port)) throw new Error('Bad address.')
  return `if timeout 5 bash -c 'exec 3<>/dev/tcp/${host}/${port}' 2>/dev/null; then echo "@@tc reach"; else echo "@@tc noreach"; fi\n`
}

export interface TcPreviewInput {
  kind: TcKind
  node: string; vmid: number; storage: string; diskGb: number; cores: number
  /** The options after checkOptions. */
  values: Record<string, string>
  storageFreeGb?: number
}

/**
 * The transcoders' part of the preview. Returns the options the plan keeps: the hardware resolved to what the node
 * really has, the NVIDIA version and the Tdarr version read from where they live (never from the request), and a
 * main address in one form. Writes nothing.
 */
export async function tcPreview(i: TcPreviewInput, d: { arr?: () => ArrDeps }): Promise<{ errors: string[]; warnings: string[]; checks: string[]; options: Record<string, string> }> {
  const errors: string[] = [], warnings: string[] = [], checks: string[] = []
  const v = i.values
  // Preview-only fields: a request's own value is never used.
  const options: Record<string, string> = { ...v, TC_NVIDIA_VERSION: '', ...(i.kind === 'tdarr-node' ? { TC_VERSION: '' } : {}) }
  const arr = d.arr?.()
  if (!arr) return { errors: ['HyperProx cannot reach the node to look at it.'], warnings, checks, options }
  const run = (script: string, ms: number) => arr.nodeRun(i.node, script, ms).catch((e: any) => ({ code: -1, output: '', error: e?.message as string }))

  // The node's hardware, and the choice resolved against it.
  let hw: NodeHardware | null = null
  const hr = await run(HARDWARE_SCRIPT, 60_000)
  if (hr.code === -1 || !hr.output) errors.push(`HyperProx could not look at the hardware on ${i.node}.`)
  else {
    hw = parseHardware(i.node, hr.output)
    const r = resolveAccel(v.TC_ACCEL || 'auto', hw, i.node)
    errors.push(...r.errors); warnings.push(...r.warnings); checks.push(...r.checks)
    if (!r.errors.length) { options.TC_ACCEL = r.accel; if (r.accel === 'nvidia') options.TC_NVIDIA_VERSION = hw.nvidia!.driver }
  }

  // The library.
  if (hasLibrary(i.kind)) {
    const lo = layoutFromOptions(v)
    errors.push(...lo.errors)
    const l = lo.layout
    if (l) {
      if (l.media === 'disk') {
        if (i.storageFreeGb !== undefined && i.storageFreeGb < Math.ceil((l.mediaGb! + i.diskGb) * 1.1)) {
          errors.push(`${i.storage} has ${i.storageFreeGb} GB free: not enough for the ${i.diskGb} GB container and a ${l.mediaGb} GB library disk.`)
        } else checks.push(`The library gets a new ${l.mediaGb} GB disk on ${i.storage}, mounted at /data. It is left out of Proxmox backups (media is too big to back up nightly).`)
      } else {
        const r = await run(mediaProbeScript(l, i.vmid), 60_000)
        if (r.code === -1) errors.push(`HyperProx could not run a check on ${i.node}.`)
        else { const j = judgeMedia(r.output, l, i.vmid); errors.push(...j.errors); warnings.push(...j.warnings); checks.push(...j.checks) }
      }
      checks.push(LAYOUT_LINE)
    }
  }

  // Workers and nodes: the main server must answer before anything is made.
  if (i.kind === 'unmanic-worker' || i.kind === 'tdarr-node') {
    const main = parseMainUrl(v.TC_MAIN_URL ?? '', i.kind === 'unmanic-worker' ? UNMANIC_PORT : TDARR_WEB_PORT)
    if (!main) errors.push('The address of the main one is not usable.')
    else {
      const base = `http://${main.host}:${main.port}`
      options.TC_MAIN_URL = base
      if (i.kind === 'unmanic-worker') {
        const r = await arr.http({ method: 'GET', url: `${base}/unmanic/api/v2/workers/status`, timeoutMs: 8000 }).catch(() => null)
        if (!r || r.status !== 200 || !/workers_status/.test(r.body)) errors.push(`No Unmanic answered at ${base}. Install the main Unmanic first, or check the address.`)
        else checks.push(`The main Unmanic answers at ${base}.`)
      } else {
        const r = await arr.http({ method: 'GET', url: `${base}/`, timeoutMs: 8000 }).catch(() => null)
        if (!r || r.status !== 200 || !/Tdarr/i.test(r.body)) errors.push(`No Tdarr server answered at ${base}. Install the Tdarr server first, or check the address.`)
        else {
          checks.push(`The Tdarr server answers at ${base}.`)
          const ver = await tdarrServerVersion(arr, base)
          options.TC_VERSION = ver ?? TDARR_VERSION
          checks.push(ver ? `The node will run Tdarr ${ver}, the server's own version.` : `The server did not say its version, so the node will run ${TDARR_VERSION}. A node of another version is refused by Tdarr; check the Tdarr version on the server.`)
          if (!ver) warnings.push(`The server did not say which version it runs. This node runs ${TDARR_VERSION}; if the server differs, Tdarr will refuse the node.`)
          const rr = await run(reachScript(main.host, TDARR_SERVER_PORT), 20_000)
          if (/@@tc noreach/.test(rr.output)) errors.push(`${i.node} cannot reach the Tdarr server's node port (${main.host}:${TDARR_SERVER_PORT}).`)
          else if (/@@tc reach/.test(rr.output)) checks.push(`${i.node} reaches the server's node port (${TDARR_SERVER_PORT}).`)
        }
      }
    }
  }

  // Workers.
  if (i.kind === 'unmanic' || i.kind === 'unmanic-worker') {
    const w = Number(v.UNMANIC_WORKERS || 1)
    checks.push(`${w} worker${w === 1 ? '' : 's'}.`)
    if (options.TC_ACCEL === 'cpu' && w > 1) warnings.push('On the CPU every worker uses all the cores, so more than one only makes each slower. One is the better start.')
    if (w > i.cores) warnings.push(`${w} workers on ${i.cores} cores: set more cores in step 2, or fewer workers.`)
  }
  if (i.diskGb < 16) warnings.push(`${i.diskGb} GB is little scratch space: conversions write their whole output to the container's disk first.`)
  checks.push('The container gets keyctl as well as nesting (Docker needs both), set on the node through its login.')
  checks.push(`${appName(i.kind)} gets no public name and no port forward: it is on the container's own address only.`)
  return { errors, warnings, checks, options }
}

/** The wizard's picker: what a node offers, in words. */
export async function nodeHardwareFacts(node: string, d: { arr?: () => ArrDeps }) {
  const arr = d.arr?.()
  if (!arr) throw new Error('HyperProx cannot reach the node.')
  const r = await arr.nodeRun(node, HARDWARE_SCRIPT, 60_000)
  if (!r.output) throw new Error(`HyperProx could not look at the hardware on ${node}.`)
  return hardwareFacts(parseHardware(node, r.output))
}

// ── After the create ────────────────────────────────────────────────────────

export interface TcPrepareDeps {
  arr?: () => ArrDeps
  client: { fetchStrict<T>(path: string, method?: string, body?: string): Promise<T> }
}

/**
 * Set what an API token cannot: keyctl, the hardware devices, and the library mountpoint (a NAS mounted on this node
 * first). The container is stopped, changed and started again, and its config is read back. The hardware is looked
 * at again here and must still be what the plan says. `onMount` fires before a NAS is mounted, so clean-up knows to undo it.
 */
export async function tcPrepare(plan: { node: string; vmid: number; storage: string; options?: Record<string, string> }, kind: TcKind, d: TcPrepareDeps, onMount: () => Promise<void> | void = () => {}): Promise<{ detail: string; groups: number[] }> {
  const o = plan.options ?? {}
  const arr = d.arr?.()
  if (!arr) throw new Error('HyperProx cannot reach the node to finish the container.')
  const accel = o.TC_ACCEL as Accel
  if (!['vaapi', 'nvidia', 'cpu'].includes(accel)) throw new Error('The plan has no resolved hardware choice. Check the plan again.')
  // The hardware is read again, so a node that changed since the preview refuses here, before anything is changed.
  const hr = await arr.nodeRun(plan.node, HARDWARE_SCRIPT, 60_000)
  const hw = parseHardware(plan.node, hr.output)
  const rv = resolveAccel(accel, hw, plan.node)
  if (rv.errors.length) throw new Error(`${plan.node} changed since the preview: ${rv.errors.join(' ')}`)
  if (accel === 'nvidia' && hw.nvidia!.driver !== o.TC_NVIDIA_VERSION) throw new Error(`${plan.node}'s NVIDIA driver is now ${hw.nvidia!.driver}, not ${o.TC_NVIDIA_VERSION} as planned. Check the plan again.`)
  const extra = deviceSettings(accel, hw)
  const groups = groupAdd(accel, hw)

  if (!hasLibrary(kind)) {
    const r = await arr.nodeRun(plan.node, prepareNoLibraryScript({ vmid: plan.vmid, extra }), 5 * 60_000)
    if (r.code !== 0 || !/@@arr prepared/.test(r.output)) throw new Error(`The container could not be given keyctl and its hardware on ${plan.node} (exit ${r.code}).`)
    const cfg = await d.client.fetchStrict<Record<string, unknown>>(`/nodes/${encodeURIComponent(plan.node)}/lxc/${plan.vmid}/config`)
    const bad: string[] = []
    const features = String(cfg?.features ?? '')
    if (!/(^|,)nesting=1(,|$)/.test(features) || !/(^|,)keyctl=1(,|$)/.test(features)) bad.push(`features read back as "${features || 'none'}", not nesting=1,keyctl=1.`)
    for (const [flag, value] of extra) { const k = flag.replace(/^--/, ''); if (String(cfg?.[k] ?? '').split(',')[0] !== value.split(',')[0]) bad.push(`${k} did not read back.`) }
    if (bad.length) throw new Error(`CT ${plan.vmid}'s settings did not read back: ${bad.join(' ')}`)
    return { detail: `nesting and keyctl on; hardware: ${accel === 'cpu' ? 'CPU only' : accel === 'vaapi' ? 'Intel/AMD graphics (VAAPI)' : 'NVIDIA'}`, groups }
  }

  const lo = layoutFromOptions(o)
  const layout: Layout | undefined = lo.layout
  if (!layout) throw new Error(`The settings are not usable: ${lo.errors.join(' ')}`)
  if (layout.media === 'nfs') await onMount()
  const so = { vmid: plan.vmid, layout, storage: plan.storage, tun: false, extra }
  const r = await arr.nodeRun(plan.node, prepareScript(so), 5 * 60_000)
  if (layout.media === 'nfs' && !/@@arr mounted/.test(r.output)) throw new Error(`${layout.nfs!.source} could not be mounted on ${plan.node}.`)
  if (!/@@arr refused /.test(r.output) && (r.code !== 0 || !/@@arr prepared/.test(r.output))) throw new Error(`The container could not be given its library and hardware on ${plan.node} (exit ${r.code}).`)
  const p = parseProbe(r.output)
  const resolved = layout.media === 'path' ? p.resolved ?? undefined : undefined
  if (p.refused !== null) throw new Error(`${layout.hostPath} is ${p.refused} on ${plan.node}, which cannot hold a library. Nothing was handed to the container.`)
  if (layout.media === 'path') {
    const why = resolved ? hostPathRefusal(resolved, plan.vmid) : 'it did not resolve on the node.'
    if (why) throw new Error(`${layout.hostPath} cannot be used: ${why}`)
  }
  const cfg = await d.client.fetchStrict<Record<string, unknown>>(`/nodes/${encodeURIComponent(plan.node)}/lxc/${plan.vmid}/config`)
  const bad = configProblems(cfg, { ...so, resolved })
  if (bad.length) throw new Error(`CT ${plan.vmid}'s settings did not read back: ${bad.join(' ')}`)
  const where = layout.media === 'disk' ? `a new ${layout.mediaGb} GB disk on ${plan.storage}` : layout.media === 'nfs' ? `${layout.nfs!.source} (mounted on ${plan.node})` : resolved
  return { detail: `nesting and keyctl on; hardware: ${accel === 'cpu' ? 'CPU only' : accel === 'vaapi' ? 'Intel/AMD graphics (VAAPI)' : 'NVIDIA'}; library on ${where} at /data`, groups }
}

// ── Install ─────────────────────────────────────────────────────────────────

/** The install script's variables: the compose file, the folders, the hardware. */
export function tcInstallEnv(kind: TcKind, o: { options: Record<string, string>; groups: number[]; ip: string; hostname: string }): Record<string, string> {
  const accel = o.options.TC_ACCEL as Accel
  if (!['vaapi', 'nvidia', 'cpu'].includes(accel)) throw new Error('The plan has no resolved hardware choice.')
  const main = kind === 'tdarr-node' ? parseMainUrl(o.options.TC_MAIN_URL ?? '', TDARR_WEB_PORT) : null
  if (kind === 'tdarr-node' && !main) throw new Error('The Tdarr server\'s address is missing.')
  return scriptEnv({
    kind, accel, groups: o.groups, library: hasLibrary(kind), name: appName(kind), nvidiaVersion: o.options.TC_NVIDIA_VERSION || undefined,
    nodeName: o.hostname,
    ...(kind === 'tdarr-node' ? { server: { host: main!.host, port: TDARR_SERVER_PORT }, nodeIp: o.ip, version: o.options.TC_VERSION || TDARR_VERSION } : {}),
  })
}

export function tcJobSteps<T extends { id: string; label: string; status: string }>(steps: T[], kind: TcKind): T[] {
  const at = steps.findIndex(x => x.id === 'install')
  const mine: Array<{ id: string; label: string }> = kind === 'unmanic'
    ? [{ id: 'tc-ready', label: 'Wait for Unmanic to answer' }, { id: 'tc-library', label: 'Set the library' }, { id: 'tc-workers', label: 'Set the workers' }, { id: 'tc-plugin', label: 'Connect the Unmanic plug-in' }]
    : kind === 'unmanic-worker'
      ? [{ id: 'tc-ready', label: 'Wait for Unmanic to answer' }, { id: 'tc-workers', label: 'Set the workers' }, { id: 'tc-link', label: 'Link it to the main Unmanic' }, { id: 'tc-plugin', label: 'Connect the Unmanic plug-in' }]
      : kind === 'tdarr'
        ? [{ id: 'tc-ready', label: 'Wait for the Tdarr server' }, { id: 'tc-node', label: 'Wait for its node to register' }, { id: 'tc-plugin', label: 'Tdarr plug-in' }]
        : [{ id: 'tc-node', label: 'Wait for the node to register with the server' }]
  const rest = steps.slice(at + 1).filter(x => x.id !== 'verify' && x.id !== 'wire')
  return [...steps.slice(0, at + 1), ...mine.map(x => ({ ...x, status: 'pending' }) as T), ...rest]
}

export interface TcRunInput {
  kind: TcKind; ip: string; hostname: string; options: Record<string, string>
  /** Recorded the moment a link exists on the main Unmanic, so a failure after it can still undo it. */
  onLink: (r: LinkRecord) => void
}

/** The setup chores. Returns the address to show, the links to offer and the follow-up. */
export async function tcRunSetup(o: TcRunInput, step: (id: string) => StepRef, d: { arr?: () => ArrDeps; wait(ms: number): Promise<unknown> }): Promise<{ url: string; apps: Array<{ id: string; name: string; url: string }>; followUp?: { recipeId: string; label: string; url: string } }> {
  const arr = d.arr?.()
  if (!arr) throw new Error('The setup is not available here.')
  const sd: TcSetupDeps = { http: arr.http, wait: d.wait, pluginSettings: arr.pluginSettings, savePluginSettings: arr.savePluginSettings }
  const t = (id: string, run: () => Promise<{ status?: 'done' | 'skipped'; detail: string } | string>) => run().then(r => {
    const s = step(id); const x = typeof r === 'string' ? { detail: r } : r
    s.status = x.status ?? 'done'; s.detail = x.detail
  })

  if (o.kind === 'unmanic' || o.kind === 'unmanic-worker') {
    const base = unmanicUrl(o.ip)
    await t('tc-ready', async () => { await waitForUnmanic(sd, base); return `Unmanic answers at ${base}.` })
    if (o.kind === 'unmanic') await t('tc-library', () => setUnmanicLibrary(sd, base, o.options.UNMANIC_SCAN !== '0'))
    await t('tc-workers', () => setUnmanicWorkers(sd, base, Number(o.options.UNMANIC_WORKERS || 1)))
    if (o.kind === 'unmanic-worker') {
      const main = parseMainUrl(o.options.TC_MAIN_URL ?? '', UNMANIC_PORT)!
      await t('tc-link', async () => (await linkWorker(sd, {
        main: `http://${main.host}:${main.port}`, mainAddress: `${main.host}:${main.port}`, worker: base, workerAddress: `${o.ip}:${UNMANIC_PORT}`,
      }, o.onLink)).detail)
    }
    await t('tc-plugin', () => wireUnmanicPlugin(sd, base, o.hostname))
    return {
      url: base, apps: [{ id: 'unmanic', name: 'Open Unmanic', url: base }],
      ...(o.kind === 'unmanic' ? { followUp: { recipeId: 'unmanic-worker', label: 'Add a worker on another node', url: base } } : {}),
    }
  }

  const base = o.kind === 'tdarr' ? tdarrUrl(o.ip) : o.options.TC_MAIN_URL
  if (o.kind === 'tdarr') {
    await t('tc-ready', async () => { await waitForTdarr(sd, base); return `The Tdarr server answers at ${base}.` })
    const s = step('tc-node')
    await waitForTdarrNode(sd, base, o.hostname, s)
    await t('tc-plugin', async () => ({ status: 'skipped', detail: `HyperProx has no Tdarr plug-in yet, so it only links to Tdarr: ${base}. Add your library folders (such as /data/media/tv) under Libraries there.` }))
    return { url: base, apps: [{ id: 'tdarr', name: 'Open Tdarr', url: base }], followUp: { recipeId: 'tdarr-node', label: 'Add a node on another cluster node', url: base } }
  }
  const s = step('tc-node')
  await waitForTdarrNode(sd, base, o.hostname, s)
  return { url: base, apps: [{ id: 'tdarr', name: 'Open Tdarr', url: base }] }
}

/** Undo what a transcoder install made outside its container: the one link it added to a main Unmanic. (The NAS mount is undone by the Arr Stack's clean-up, which is the same code.) */
export async function tcCleanup(job: { tcLink?: LinkRecord }, d: { arr?: () => ArrDeps; wait(ms: number): Promise<unknown> }): Promise<string[]> {
  if (!job.tcLink) return []
  const arr = d.arr?.()
  if (!arr) return [`The link on ${job.tcLink.mainUrl} could not be undone: HyperProx cannot reach it.`]
  const line = await unlinkWorker({ http: arr.http, wait: d.wait, pluginSettings: arr.pluginSettings, savePluginSettings: arr.savePluginSettings }, job.tcLink)
  if (/was undone/.test(line)) job.tcLink = undefined
  return [line]
}

export { unmountScript }
