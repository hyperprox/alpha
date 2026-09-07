// =============================================================================
//  HyperProx — CEPH monitor resolution
//
//  Everything under /nodes/{node}/ceph/... needs a node name, and which node is
//  not a static fact: monitors move, nodes go down, and plenty of clusters have
//  no CEPH at all. CEPH_MON_NODE stays supported as an explicit override; with
//  it unset we ask the cluster at runtime and cache the answer.
//
//  The trap this file exists to close: /nodes/{node}/ceph/mon is CLUSTER-WIDE
//  despite the path. PVE builds it from the cluster KV store plus a rados
//  quorum_status, so every node returns every monitor. The old setup-wizard
//  loop took the first node whose call returned anything — i.e. the first entry
//  of /nodes, which is unordered — and never checked it against the monitor
//  list it had just fetched.
// =============================================================================

import { ProxmoxClient, CephMon } from './proxmox-client'

export class CephUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CephUnavailableError'
  }
}

// A monitor that answers stays put for days, so the positive cache is generous.
// The negative cache is short but deliberately non-zero: the websocket slow
// channel ticks every 15s, and a cluster with no CEPH must not re-probe a
// doomed endpoint at that rate.
const OK_TTL   = 300_000   // 5 minutes
const FAIL_TTL = 60_000    // 1 minute

let cached:   { node: string; ts: number }    | null = null
let failed:   { message: string; ts: number } | null = null
let inflight: Promise<string>                 | null = null

function envOverride(): string | null {
  const v = (process.env.CEPH_MON_NODE ?? '').trim()
  return v.length > 0 ? v : null
}

export function invalidateCephMonNode(): void {
  cached = null; failed = null; inflight = null
}

async function detect(pve: ProxmoxClient, avoid?: string): Promise<string> {
  let nodes
  try {
    nodes = await pve.getNodes()
  } catch (e: any) {
    throw new CephUnavailableError(`Cannot reach Proxmox to look for a CEPH monitor: ${e.message}`)
  }
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new CephUnavailableError('Proxmox returned no nodes — cannot locate a CEPH monitor.')
  }

  const online    = nodes.filter(n => n.status === 'online').map(n => n.node)
  const nodeNames = new Set(online)
  if (online.length === 0) {
    throw new CephUnavailableError('No Proxmox node is online — cannot locate a CEPH monitor.')
  }

  for (const probe of online) {
    let mons: CephMon[] | null
    try { mons = await pve.getCephMons(probe) }
    catch { continue }

    // fetchNode does not inspect the HTTP status, and PVE answers an error with
    // {"data":null} — which parses fine and resolves as null. So a non-array
    // means "this node could not tell us", not "the cluster has no monitors".
    if (!Array.isArray(mons)) continue

    if (mons.length === 0) {
      throw new CephUnavailableError(
        'This Proxmox cluster has no CEPH monitors configured, so CEPH status, OSD and pool ' +
        'views are unavailable. If CEPH is installed, set CEPH_MON_NODE in .env.',
      )
    }

    // The URL needs a Proxmox NODE name. A monitor id is conventionally the
    // hostname, but PVE documents it only as "typically" so — take `host` and
    // confirm it is a node we can address. Sort by rank: both lists come back
    // unordered, and an unstable pick defeats the cache.
    let usable = mons
      .filter(m => nodeNames.has(m.host ?? m.name))
      .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))

    if (avoid && usable.some(m => (m.host ?? m.name) !== avoid)) {
      usable = usable.filter(m => (m.host ?? m.name) !== avoid)
    }

    const pick = usable.find(m => m.quorum && m.state === 'running')
              ?? usable.find(m => m.state === 'running')
              ?? usable[0]

    if (pick) return pick.host ?? pick.name

    throw new CephUnavailableError(
      `CEPH reports ${mons.length} monitor(s) (${mons.map(m => m.name).join(', ')}) but none of ` +
      'them run on an online Proxmox node. Set CEPH_MON_NODE in .env to override.',
    )
  }

  throw new CephUnavailableError(
    'Could not read the CEPH monitor list from any online Proxmox node. If this cluster has no ' +
    'CEPH, this is expected and the CEPH panels will stay empty.',
  )
}

export async function resolveCephMonNode(pve: ProxmoxClient): Promise<string> {
  const override = envOverride()
  if (override) return override

  const now = Date.now()
  if (cached && now - cached.ts < OK_TTL)   return cached.node
  if (failed && now - failed.ts < FAIL_TTL) throw new CephUnavailableError(failed.message)

  // /summary fires several CEPH calls inside one allSettled; collapse them so a
  // cold cache does not trigger N simultaneous detections.
  if (inflight) return inflight

  inflight = detect(pve)
    .then(node => { cached = { node, ts: Date.now() }; failed = null; inflight = null; return node })
    .catch((e: any) => {
      failed = { message: e.message, ts: Date.now() }
      cached = null; inflight = null
      throw e instanceof CephUnavailableError ? e : new CephUnavailableError(e.message)
    })

  return inflight
}

async function redetect(pve: ProxmoxClient, avoid: string): Promise<string> {
  invalidateCephMonNode()
  const node = await detect(pve, avoid)
  cached = { node, ts: Date.now() }
  return node
}

/**
 * Run a CEPH query against the current monitor node. If that node stops
 * answering — usually because it went down — forget it, resolve a different one
 * and try once more. This is the part a hardcoded env var cannot do.
 */
export async function withCephMon<T>(
  pve: ProxmoxClient,
  fn: (node: string) => Promise<T>,
): Promise<T> {
  const node = await resolveCephMonNode(pve)

  let firstError: Error
  try {
    const out = await fn(node)
    // null here means "that node did not answer" — see the fetchNode note above.
    if (out !== null && out !== undefined) return out
    firstError = new Error(`node '${node}' returned no data`)
  } catch (e: any) {
    if (e instanceof CephUnavailableError) throw e
    firstError = e
  }

  // An explicit override is an operator instruction. Do not silently route
  // around it — say plainly that it is wrong.
  if (envOverride()) {
    throw new CephUnavailableError(
      `CEPH_MON_NODE is set to '${node}' but the CEPH query failed against it ` +
      `(${firstError.message}). Check that node is online and running a monitor, or remove ` +
      'CEPH_MON_NODE from .env to detect one automatically.',
    )
  }

  const retry = await redetect(pve, node)
  const out   = await fn(retry)
  if (out === null || out === undefined) {
    throw new CephUnavailableError(
      `CEPH query failed against monitor nodes '${node}' and '${retry}' (${firstError.message}).`,
    )
  }
  return out
}
