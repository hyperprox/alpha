// =============================================================================
//  HyperProx — Updates: inventory
//
//  What is pending, everywhere, and whether HyperProx may touch it. Read-only by
//  construction: nodes are read through the Proxmox API (the pending list the
//  node's last `apt update` produced) and one shell round trip of read-only
//  facts; guests through `apt list --upgradable`. Nothing here runs
//  `apt update` — that is the run's `refresh` step, never a page load.
// =============================================================================

import os from 'node:os'
import type { UpdatesGuest, UpdatesInventory, UpdatesNode } from './types'
import type { UpdatesExecutor, GuestListing } from './executor'
import { type Policy, guestPolicy, nodePolicy, nodePolicyView } from './policy'
import {
  GUEST_PENDING_SCRIPT, NODE_FACTS_COMMAND, guestDockerImagesScript, isCephPackage, isKernelPackage,
  parseDockerImages, parseGuestPending, parseNodeFacts, type NodeFacts,
} from './commands'
import { type AppEnv, readGuestApps } from './apps'

export interface InventoryOptions {
  /** Nodes whose reboot an earlier run deferred. */
  rebootPending?: Set<string>
  /** How HyperProx recognises its own guest when the policy does not say. */
  hostname?: string
  /** Longest one node or one guest may take before its row reports it and the read moves on. */
  itemDeadlineMs?: number
  /** App-update providers. Without it, no app is looked for. */
  apps?: AppEnv
}

const ITEM_DEADLINE_MS = 4 * 60_000

/** The read's own answer, or `late` once the deadline passes, so one stuck machine cannot hold the page. */
function withDeadline<R>(work: Promise<R>, ms: number, late: () => R): Promise<R> {
  let timer: NodeJS.Timeout
  const deadline = new Promise<R>(resolve => { timer = setTimeout(() => resolve(late()), ms) })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

/** Facts from the node shell, kept beside the inventory for the gates. */
export type NodeFactsMap = Record<string, NodeFacts | null>

export interface InventoryResult { inventory: UpdatesInventory; facts: NodeFactsMap }

/** Bind-mounted (host path) mount points cannot be snapshotted. */
export function lxcSnapshotCapable(config: Record<string, any>): boolean {
  return !Object.entries(config).some(([k, v]) => /^mp\d+$/.test(k) && typeof v === 'string' && v.startsWith('/'))
}

/** HyperProx's own guest: the policy says, or exactly one running container carries this host's name. */
export function findSelfGuest(guests: GuestListing[], policy: Policy, hostname = os.hostname()): GuestListing | null {
  if (policy.selfVmid) return guests.find(g => g.vmid === policy.selfVmid) ?? null
  const named = guests.filter(g => g.type === 'lxc' && g.running && g.name === hostname)
  return named.length === 1 ? named[0] : null
}

async function readNode(exec: UpdatesExecutor, policy: Policy, node: { name: string; online: boolean },
                        selfNode: string | null, rebootPending: Set<string>): Promise<{ node: UpdatesNode; facts: NodeFacts | null }> {
  const pol = nodePolicy(policy, node.name)
  const out: UpdatesNode = {
    node: node.name, online: node.online, pending: [], cephPending: false, kernelPending: false,
    rebootRequired: false, rebootPending: rebootPending.has(node.name),
    policy: nodePolicyView(policy, node.name),
    holdsOk: pol.requireHolds.length ? false : null,
    pinOk: pol.requirePin ? false : null,
    isSelf: node.name === selfNode,
  }
  if (!node.online) { out.error = 'node is offline'; return { node: out, facts: null } }

  const errors: string[] = []
  try {
    out.pending = await exec.nodeAptPending(node.name)
    out.cephPending = out.pending.some(p => isCephPackage(p.name))
    out.kernelPending = out.pending.some(p => isKernelPackage(p.name))
  } catch (e: any) { errors.push(`pending list: ${e.message}`) }

  let facts: NodeFacts | null = null
  try {
    const r = await exec.nodeExec(node.name, NODE_FACTS_COMMAND, undefined, 60_000)
    facts = parseNodeFacts(r.output)
    out.rebootRequired = facts.rebootRequired
    if (pol.requireHolds.length) out.holdsOk = pol.requireHolds.every(h => facts!.holds.includes(h))
    if (pol.requirePin) out.pinOk = facts.pinned === pol.requirePin
  } catch (e: any) {
    // Unknown is not OK: a node whose holds could not be read must not look safe.
    errors.push(`node shell: ${e.message}`)
  }
  if (errors.length) out.error = errors.join('; ')
  return { node: out, facts }
}

async function readApps(apps: AppEnv | undefined, exec: UpdatesExecutor, policy: Policy, g: GuestListing, out: UpdatesGuest): Promise<void> {
  if (!apps || !apps.providers.length || !policy.apps.enabled || !guestPolicy(policy, g.vmid).apps) return
  try {
    const r = await readGuestApps(apps, exec, policy, g, out.snapshotCapable)
    if (r.apps.length) out.apps = r.apps
    if (r.errors.length) out.error = [out.error, `apps: ${r.errors.join('; ')}`].filter(Boolean).join('; ')
  } catch (e: any) { out.error = [out.error, `apps: ${e.message}`].filter(Boolean).join('; ') }
}

async function readGuest(exec: UpdatesExecutor, policy: Policy, g: GuestListing, haSids: Set<string>, apps?: AppEnv): Promise<UpdatesGuest> {
  const pol = guestPolicy(policy, g.vmid)
  const out: UpdatesGuest = {
    vmid: g.vmid, type: g.type, name: g.name, node: g.node, running: g.running,
    managed: false, pending: [], rebootRequired: false,
    haManaged: haSids.has(`${g.type === 'lxc' ? 'ct' : 'vm'}:${g.vmid}`),
    snapshotCapable: false, docker: pol.docker,
  }
  if (pol.excluded) { out.unmanagedReason = 'excluded'; return out }
  if (!g.running)   { out.unmanagedReason = 'not-running'; return out }

  let config: Record<string, any> = {}
  // Without its config there is no telling whether it can be snapshotted or has an agent: leave it alone.
  try { config = await exec.guestConfig(g) } catch (e: any) { out.error = `config could not be read: ${e.message}`; return out }

  if (g.type === 'qemu') {
    if (/^(win|w2k|wxp|wvista)/.test(String(config.ostype ?? ''))) { out.unmanagedReason = 'windows'; return out }
    if (!/^(1|enabled=1)/.test(String(config.agent ?? ''))) { out.unmanagedReason = 'no-agent'; return out }
    out.snapshotCapable = true
  } else {
    out.snapshotCapable = lxcSnapshotCapable(config)
  }

  try {
    const r = await exec.guestExec(g, GUEST_PENDING_SCRIPT, undefined, 120_000)
    if (r.code !== 0 && g.type === 'qemu') { out.unmanagedReason = 'no-agent'; out.error = r.output.slice(0, 300); return out }
    const parsed = parseGuestPending(r.output)
    // No apt, but an app a provider manages may still be there.
    if (parsed.noApt) { out.unmanagedReason = 'no-apt'; await readApps(apps, exec, policy, g, out); return out }
    out.pending = parsed.pending
    if (parsed.keptBack.length) out.keptBack = parsed.keptBack
    out.rebootRequired = parsed.rebootRequired
    out.managed = true
  } catch (e: any) {
    out.error = `apt list: ${e.message}`
    return out
  }

  if (pol.docker !== 'none' && pol.composeDirs.length) {
    try {
      const r = await exec.guestExec(g, guestDockerImagesScript(pol.composeDirs), undefined, 180_000)
      out.dockerImages = parseDockerImages(r.output)
    } catch (e: any) { out.error = `docker images: ${e.message}` }
  }
  await readApps(apps, exec, policy, g, out)
  return out
}

// Rows for a machine that did not answer in time: unmanaged and flagged, never "nothing pending".
function unansweredNode(policy: Policy, node: { name: string; online: boolean }, selfNode: string | null,
                        rebootPending: Set<string>, error: string): UpdatesNode {
  const pol = nodePolicy(policy, node.name)
  return {
    node: node.name, online: node.online, pending: [], cephPending: false, kernelPending: false,
    rebootRequired: false, rebootPending: rebootPending.has(node.name),
    policy: nodePolicyView(policy, node.name),
    holdsOk: pol.requireHolds.length ? false : null,
    pinOk: pol.requirePin ? false : null,
    isSelf: node.name === selfNode, error,
  }
}

function unansweredGuest(policy: Policy, g: GuestListing, haSids: Set<string>, error: string): UpdatesGuest {
  return {
    vmid: g.vmid, type: g.type, name: g.name, node: g.node, running: g.running,
    managed: false, pending: [], rebootRequired: false,
    haManaged: haSids.has(`${g.type === 'lxc' ? 'ct' : 'vm'}:${g.vmid}`),
    snapshotCapable: false, docker: guestPolicy(policy, g.vmid).docker, error,
  }
}

async function inBatches<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)))
  return out
}

export async function readInventory(exec: UpdatesExecutor, policy: Policy, opts: InventoryOptions = {}): Promise<InventoryResult> {
  const [status, listing, haSids] = await Promise.all([
    exec.clusterStatus(),
    exec.listGuests(),
    exec.haResources(),
  ])
  const guests = listing.filter(g => !g.template)
  const self = findSelfGuest(guests, policy, opts.hostname)
  const haSet = new Set(haSids)

  const limit = opts.itemDeadlineMs ?? ITEM_DEADLINE_MS
  const lateNote = `no answer within ${Math.round(limit / 1000)} s`
  const pendingSet = opts.rebootPending ?? new Set<string>()
  const nodeRows = await Promise.all(status.nodes.map(n => withDeadline(
    readNode(exec, policy, n, self?.node ?? null, pendingSet), limit,
    () => ({ node: unansweredNode(policy, n, self?.node ?? null, pendingSet, lateNote), facts: null }),
  )))
  const onlineNodes = new Set(status.nodes.filter(n => n.online).map(n => n.name))
  const guestRows = await inBatches(guests.sort((a, b) => a.vmid - b.vmid), 6, async g => {
    if (!onlineNodes.has(g.node)) {
      const row = await readGuest(exec, policy, { ...g, running: false }, haSet, opts.apps)
      return { ...row, error: 'its node is offline' }
    }
    return withDeadline(readGuest(exec, policy, g, haSet, opts.apps), limit, () => unansweredGuest(policy, g, haSet, lateNote))
  })

  return {
    inventory: {
      refreshedAt: new Date(exec.now()).toISOString(),
      nodes: nodeRows.map(r => r.node).sort((a, b) => a.node.localeCompare(b.node)),
      guests: guestRows,
    },
    facts: Object.fromEntries(nodeRows.map(r => [r.node.node, r.facts])),
  }
}

export function selfVmidOf(inv: UpdatesInventory, policy: Policy, hostname?: string): number | null {
  const listing: GuestListing[] = inv.guests.map(g => ({ vmid: g.vmid, type: g.type, node: g.node, name: g.name, running: g.running, template: false }))
  return findSelfGuest(listing, policy, hostname)?.vmid ?? null
}
