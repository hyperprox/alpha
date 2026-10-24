// =============================================================================
//  HyperProx — dashboard summaries
//
//  The small pieces of arithmetic behind the dashboard's numbers, kept apart
//  from the components so each can be tested without a browser. No imports:
//  the API's test runner loads this file directly.
// =============================================================================

/** Binary units with binary names. `formatBytes` in lib/utils divides by 1024 but prints "TB". */
export function formatBinary(bytes: number, decimals = 1): string {
  if (!bytes || !Number.isFinite(bytes)) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  const i = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024))))
  return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(decimals))} ${units[i]}`
}

// ── Storage ──────────────────────────────────────────────────────────────────

export interface StorageSummary { used: number; total: number; pct: number; count: number }

/**
 * Capacity of the storages Proxmox itself manages (the sum of what Datacenter ->
 * Storage lists), as opposed to Ceph's raw device capacity.
 *
 * PVE reports every storage once per node. A shared one (Ceph pools, NFS, PBS)
 * is the same bytes seen from each node and counts once; a node-local one
 * (local, local-lvm) is different bytes on each node and counts per node. The
 * old code de-duplicated by name alone, so a cluster's five `local` disks
 * counted as one.
 */
export function summarizeStorage(storage: unknown): StorageSummary {
  const seen = new Set<string>()
  let used = 0, total = 0
  for (const s of Array.isArray(storage) ? storage : []) {
    if (!s || typeof s.storage !== 'string') continue
    if (s.active === 0 || s.enabled === 0) continue
    const t = Number(s.total)
    if (!(t > 0)) continue
    const key = s.shared ? `shared:${s.storage}` : `${s.node ?? ''}:${s.storage}`
    if (seen.has(key)) continue
    seen.add(key)
    total += t
    used += Number(s.used) || 0
  }
  return { used, total, pct: total > 0 ? Math.round((used / total) * 100) : 0, count: seen.size }
}

// ── High availability ────────────────────────────────────────────────────────

export type HaSummary =
  | { state: 'ok'; services: number; started: number }
  | { state: 'unavailable' }

/**
 * Guests under HA, from /cluster/ha/status/current: one `service` entry per
 * resource. The dashboard used to count guests carrying a `hastate` field, but
 * the per-node guest lists Proxmox returns never include it (only
 * /cluster/resources does), so the count was always 0.
 *
 * An empty or missing list is "unavailable", not "zero": PVE answers a token
 * that lacks Sys.Audit on / with data:null, and a cluster that is reachable
 * always has at least its quorum entry. Zero HA guests is `ok` with services 0.
 */
export function summarizeHA(ha: unknown): HaSummary {
  if (!Array.isArray(ha) || ha.length === 0) return { state: 'unavailable' }
  const services = ha.filter(h => h && h.type === 'service')
  return {
    state: 'ok',
    services: services.length,
    started: services.filter(h => h.crm_state === 'started').length,
  }
}

// ── Power ────────────────────────────────────────────────────────────────────

export interface PowerLike { reporting: number; of: number; prometheusUnreachable?: boolean }

/** Whether the POWER tile has anything to show, and if not, the sentence that says why. */
export function powerStatus(power: PowerLike | null | undefined): { show: boolean; note?: string } {
  if (!power) return { show: false }
  if (power.reporting > 0) return { show: true }
  return {
    show: false,
    note: power.prometheusUnreachable
      ? 'Power: Prometheus is not answering, so no wattage can be read.'
      : 'Power: no node reports watts. Enable RAPL in node_exporter, or add an intel_gpu_top or nvidia_smi exporter to Prometheus.',
  }
}

// ── Services ─────────────────────────────────────────────────────────────────

export type ServiceState = 'connected' | 'unreachable' | 'not-configured'

/**
 * A pill state for any service payload, whichever channel it came from. The
 * live WebSocket feed predates `state` and sends only `connected`; for that
 * shape a service the last HTTP read called not-configured stays so, since a
 * missing credential does not heal itself between ticks.
 */
export function serviceState(info: { state?: ServiceState; connected?: boolean } | null | undefined, previous?: ServiceState): ServiceState {
  if (info?.state) return info.state
  if (info?.connected) return 'connected'
  return previous === 'not-configured' ? 'not-configured' : 'unreachable'
}

/** "27.2 of 44.4 TiB": one shared unit, chosen from the total, so a pair reads as a ratio. */
export function formatBinaryPair(used: number, total: number, decimals = 1): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  if (!total || !Number.isFinite(total)) return `${formatBinary(used, decimals)} of 0 B`
  const i = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log(total) / Math.log(1024))))
  const div = Math.pow(1024, i)
  const n = (v: number) => parseFloat((v / div).toFixed(decimals))
  return `${n(used || 0)} of ${n(total)} ${units[i]}`
}
