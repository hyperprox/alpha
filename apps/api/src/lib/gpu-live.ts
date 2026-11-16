// =============================================================================
//  HyperProx — live figures and guests for each GPU, for the dashboard's GPU card
//
//  Figures come from Prometheus, whatever each vendor's exporter publishes:
//    Intel  intel_gpu_top exporter: engine busy, clock, power
//    AMD    node_exporter drm collector: busy, VRAM, GTT, plus the amdgpu hwmon chip for temperature and power
//    NVIDIA nvidia_gpu_exporter: load, VRAM, temperature
//  Load, VRAM, clock, power and temperature are read by the Command center's gpuFigures; this adds the
//  per-engine split and GTT, and keeps one answer shape for the card.
//
//  A series is tied to a Proxmox node by its `node` label (the scrape config sets it; the Command center and
//  the power card read it the same way). A series without one is tied by the address in `instance`, through
//  the cluster's own address list, never a hard-coded table.
//
//  Guests come from their configs: /dev/dri is the built-in graphics, a passthrough or NVIDIA device is the
//  discrete card (configGpuKind, the same rule the install wizards use).
//
//  Nothing here throws: a missing figure is null, and the card shows "—" for it.
// =============================================================================
import type { ProxmoxClient } from './proxmox-client'
import { gpuFigures, type PromQuery } from './clusters/overview'
import { configGpuKind } from './wizard-placement'

export interface GpuGuest { vmid: number; name: string; type: 'lxc' | 'qemu'; status: string }

export interface GpuLive {
  kind: 'intel' | 'amd' | 'nvidia'
  /** Overall busy, 0-100: the busiest engine on Intel. */
  busy: number | null
  /** Intel only: the busiest engine of each kind, 0-100. */
  engines: { render: number | null; video: number | null; enhance: number | null } | null
  freqMHz: number | null
  powerW: number | null
  vramUsed: number | null
  vramTotal: number | null
  /** AMD only: system memory the GPU maps (GTT). */
  gttUsed: number | null
  gttTotal: number | null
  tempC: number | null
  /** Plain reason when nothing is measured, for the card's tooltip. */
  note: string | null
}

type Row = { metric: Record<string, string>; value: number }
type NodeRows = (node: string) => Row[]

const HOME = { id: '', kind: 'home' }
const cardNo = (c: string | undefined) => Number(/(\d+)$/.exec(c ?? '')?.[1] ?? 1e9)
const round = (v: number | null) => (v === null ? null : Math.round(v))

/** A Prometheus query that fills in `node` from `instance` when a series has none. */
export function withNodeFromAddress(prom: PromQuery, addrToNode: Record<string, string>): PromQuery {
  return async expr => (await prom(expr)).map(r => {
    if (r.metric.node) return r
    const host = (r.metric.instance ?? '').replace(/:\d+$/, '')
    const node = addrToNode[host]
    return node ? { ...r, metric: { ...r.metric, node } } : r
  })
}

export interface LiveFigures { intel(node: string): GpuLive[]; amd(node: string): GpuLive[]; nvidia(node: string): GpuLive[] }

const NO_EXPORTER = 'No figures are coming in from this GPU yet. Check its exporter under Settings, Setup checklist.'

export async function readGpuLive(prom: PromQuery, nowS: number = Date.now() / 1000): Promise<LiveFigures> {
  const safe = (e: string) => prom(e).catch(() => [] as Row[])
  const [fig, render, video, enhance, gttUsed, gttSize, amdPower] = await Promise.all([
    gpuFigures(HOME, prom, nowS).catch(() => null),
    safe('max by (node, pci) ({__name__=~"igpu_engines_render_3d_[0-9]+_busy"})'),
    safe('max by (node, pci) ({__name__=~"igpu_engines_video_[0-9]+_busy"})'),
    safe('max by (node, pci) ({__name__=~"igpu_engines_video_enhance_[0-9]+_busy"})'),
    safe('node_drm_memory_gtt_used_bytes{hpx_cluster=""}'),
    safe('node_drm_memory_gtt_size_bytes{hpx_cluster=""}'),
    // Not published on every AMD part: null, not zero, when it is missing.
    safe('max by (node) (node_hwmon_power_average_watt{hpx_cluster=""} * on (chip, instance) group_left (chip_name) node_hwmon_chip_names{chip_name="amdgpu",hpx_cluster=""})'),
  ])
  const on = (rows: Row[], node: string) => rows.filter(r => r.metric.node === node)
  const pick = (rows: Row[], node: string, key: string, val: string) => on(rows, node).find(r => (r.metric[key] ?? '') === val)?.value ?? null
  const base = (kind: GpuLive['kind']): GpuLive => ({ kind, busy: null, engines: null, freqMHz: null, powerW: null, vramUsed: null, vramTotal: null, gttUsed: null, gttTotal: null, tempC: null, note: null })

  return {
    intel(node) {
      return (fig?.intel(node) ?? []).map(f => {
        const eng = (rows: Row[]) => (f.stale || f.status !== 'ok' ? null : round(pick(rows, node, 'pci', f.pci)))
        const engines = { render: eng(render), video: eng(video), enhance: eng(enhance) }
        const any = f.load !== null || f.freqMHz !== null || f.powerW !== null
        return { ...base('intel'), busy: f.load, engines, freqMHz: round(f.freqMHz), powerW: f.powerW === null ? null : Math.round(f.powerW * 10) / 10,
          note: any ? null : f.stale ? 'The last reading is more than two minutes old.' : f.reason || NO_EXPORTER }
      })
    },
    amd(node) {
      const cards = [...new Set([...on(gttSize, node)].map(r => r.metric.card ?? ''))].sort((a, b) => cardNo(a) - cardNo(b))
      const f = fig?.amd(node) ?? []
      const w = on(amdPower, node)[0]?.value ?? null
      return f.map((g, i) => {
        const card = cards[i]
        return { ...base('amd'), busy: round(g.load), vramUsed: g.vramUsed, vramTotal: g.vramTotal, tempC: round(g.tempC),
          gttUsed: card === undefined ? null : pick(gttUsed, node, 'card', card), gttTotal: card === undefined ? null : pick(gttSize, node, 'card', card),
          powerW: f.length === 1 && w !== null ? Math.round(w * 10) / 10 : null,
          note: g.load === null && g.vramTotal === null ? NO_EXPORTER : null }
      })
    },
    nvidia(node) {
      return (fig?.nvidia(node) ?? []).map(g => ({ ...base('nvidia'), busy: g.load, vramUsed: g.vramUsed, vramTotal: g.vramTotal, tempC: round(g.tempC),
        note: g.load === null && g.vramTotal === null ? NO_EXPORTER : null }))
    },
  }
}

// ── guests ───────────────────────────────────────────────────────────────────

export interface GuestsByKind { discrete: GpuGuest[]; integrated: GpuGuest[] }

const CACHE_MS = 60_000
let guestCache: { key: string; at: number; value: Record<string, GuestsByKind> } | null = null
export function _resetGpuGuestCache(): void { guestCache = null }

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]) }
  }))
  return out
}

/** For each of `nodes`, the guests that are given its discrete GPU and the ones given its built-in graphics. */
export async function gpuGuests(client: Pick<ProxmoxClient, 'fetchNode'>, nodes: string[], now: number = Date.now()): Promise<Record<string, GuestsByKind>> {
  const key = [...nodes].sort().join(',')
  if (guestCache && guestCache.key === key && now - guestCache.at < CACHE_MS) return guestCache.value
  const out: Record<string, GuestsByKind> = {}
  for (const n of nodes) out[n] = { discrete: [], integrated: [] }
  try {
    const res = await client.fetchNode<any[]>('/cluster/resources')
    const mine = (Array.isArray(res) ? res : []).filter(r => r && (r.type === 'lxc' || r.type === 'qemu') && r.vmid && nodes.includes(String(r.node)))
    await mapLimit(mine, 6, async r => {
      const cfg = await client.fetchNode<Record<string, unknown>>(`/nodes/${encodeURIComponent(String(r.node))}/${r.type}/${Number(r.vmid)}/config`).catch(() => null)
      const kind = configGpuKind(cfg)
      if (kind) out[String(r.node)][kind].push({ vmid: Number(r.vmid), name: String(r.name ?? ''), type: r.type, status: String(r.status ?? 'unknown') })
    })
    for (const n of nodes) for (const k of ['discrete', 'integrated'] as const) out[n][k].sort((a, b) => a.vmid - b.vmid)
  } catch { /* guests are extra detail: the card still shows the GPU */ }
  guestCache = { key, at: now, value: out }
  return out
}

/** Adds each GPU's live figures and guests. Several GPUs of one kind on a node take figures in card order. */
export function withLiveAndGuests<G extends { node: string; type: string; dedicated: boolean }>(
  gpus: G[], live: LiveFigures | null, guests: Record<string, GuestsByKind> | null,
): Array<G & { live: GpuLive | null; guests: GpuGuest[] }> {
  const seen = new Map<string, number>()
  return gpus.map(g => {
    const k = `${g.node}|${g.type}`
    const i = seen.get(k) ?? 0
    seen.set(k, i + 1)
    const kind = g.type === 'nvidia' ? 'nvidia' : g.type === 'amd' ? 'amd' : g.type.startsWith('intel') ? 'intel' : null
    const figs = kind && live ? live[kind](g.node) : []
    const gs = guests?.[g.node]
    return { ...g, live: kind ? figs[i] ?? null : null, guests: gs ? (g.dedicated ? gs.discrete : gs.integrated) : [] }
  })
}

