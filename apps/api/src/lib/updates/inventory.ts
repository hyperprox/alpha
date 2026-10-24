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

export interface InventoryOptions {
  /** Nodes whose reboot an earlier run deferred. */
  rebootPending?: Set<string>
  /** How HyperProx recognises its own guest when the policy does not say. */
  hostname?: string
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

async function readGuest(exec: UpdatesExecutor, policy: Policy, g: GuestListing, haSids: Set<string>): Promise<UpdatesGuest> {
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
  try { config = await exec.guestConfig(g) } catch (e: any) { out.error = `config: ${e.message}` }

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
    if (parsed.noApt) { out.unmanagedReason = 'no-apt'; return out }
    out.pending = parsed.pending
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
  return out
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
    exec.haResources().catch(() => [] as string[]),
  ])
  const guests = listing.filter(g => !g.template)
  const self = findSelfGuest(guests, policy, opts.hostname)
  const haSet = new Set(haSids)

  const nodeRows = await Promise.all(status.nodes.map(n => readNode(exec, policy, n, self?.node ?? null, opts.rebootPending ?? new Set())))
  const onlineNodes = new Set(status.nodes.filter(n => n.online).map(n => n.name))
  const guestRows = await inBatches(guests.sort((a, b) => a.vmid - b.vmid), 6, async g => {
    if (!onlineNodes.has(g.node)) {
      const row = await readGuest(exec, policy, { ...g, running: false }, haSet)
      return { ...row, error: 'its node is offline' }
    }
    return readGuest(exec, policy, g, haSet)
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
