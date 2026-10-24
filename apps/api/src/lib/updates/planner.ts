// =============================================================================
//  HyperProx — Updates: planner
//
//  A pure function: inventory + policy in, ordered steps out. It executes
//  nothing and reads nothing, so the plan a person confirms is exactly the plan
//  that runs, and every ordering rule can be tested on a fixed inventory.
//
//  Order: guests, then Ceph (only when Ceph packages are pending), then nodes
//  one at a time, then HyperProx itself. A step's `detail` starts with a
//  keyword the runner keys on (see DETAIL below); the rest is for people.
// =============================================================================

import type { UpdatesInventory, UpdatesNode, UpdatesPlan, UpdatesStep } from './types'
import { type Policy, guestPolicy, nodePolicy } from './policy'
import { isCephPackage } from './commands'

export type PlanStep = Omit<UpdatesStep, 'id' | 'status'>

export const DETAIL = {
  snapshotNone:  'not possible',
  cephInstall:   'install',
  cephRestart:   'restart',
  rebootManual:  'manual',
  rebootAuto:    'auto',
  selfGuest:     'guest-apt',
  selfReboot:    'node-reboot',
} as const

/** The first word of a step's detail. */
export function detailKey(step: { detail?: string | null }): string {
  return (step.detail ?? '').split(/[\s—]/)[0]
}

export interface PlanContext {
  selfVmid?: number | null
  /** Shown first when the plan was built without a usable policy file. */
  policyNote?: string
}

/** Node order: `first` nodes, then the rest, then `last` nodes, each alphabetical; HyperProx's node at the very end. */
export function orderNodes(nodes: UpdatesNode[], policy: Policy): UpdatesNode[] {
  const rank = (n: UpdatesNode) => {
    if (n.isSelf) return 3
    const o = nodePolicy(policy, n.node).order
    return o === 'first' ? 0 : o === 'last' ? 2 : 1
  }
  return [...nodes].sort((a, b) => rank(a) - rank(b) || a.node.localeCompare(b.node))
}

/** The one Ceph version every node should land on, or the conflicting versions. */
export function cephTarget(nodes: UpdatesNode[]): { version: string | null; conflict: string[] } {
  const versions = new Set<string>()
  for (const n of nodes) for (const p of n.pending) if (isCephPackage(p.name)) versions.add(p.to)
  const list = [...versions].sort()
  return list.length === 1 ? { version: list[0], conflict: [] } : { version: null, conflict: list }
}

export function buildPlan(inv: UpdatesInventory, policy: Policy, ctx: PlanContext = {}): UpdatesPlan {
  const steps: PlanStep[] = []
  const warnings: string[] = []
  if (ctx.policyNote) warnings.push(ctx.policyNote)
  const add = (target: string, action: PlanStep['action'], detail: string) =>
    steps.push({ seq: steps.length + 1, target, action, detail })

  // --- Guests ---------------------------------------------------------------------
  let selfGuestWork = 0
  for (const g of [...inv.guests].sort((a, b) => a.vmid - b.vmid)) {
    if (!g.managed) {
      if (g.error && g.unmanagedReason !== 'excluded') warnings.push(`${g.vmid} (${g.name}): not read — ${g.error}`)
      continue
    }
    const pol = guestPolicy(policy, g.vmid)
    const aptWork = pol.apt && g.pending.length > 0
    const dockerWork = pol.docker === 'auto' && pol.composeDirs.length > 0
    if (pol.docker === 'manual') {
      const stale = (g.dockerImages ?? []).filter(i => i.latest && i.latest !== i.current)
      if (stale.length) warnings.push(`${g.vmid} (${g.name}): new images available, not pulled (docker: manual): ${stale.map(i => i.image).join(', ')}`)
    }
    if (!aptWork && !dockerWork) continue

    const t = String(g.vmid)
    if (g.vmid === ctx.selfVmid) {
      // HyperProx's own guest: an apt run here can restart the API mid-step, so it goes through the handoff, last.
      if (aptWork) {
        selfGuestWork = g.pending.length
        // Taken in the guest phase, so the rollback point exists before the handoff upgrades it.
        if (g.snapshotCapable) add(t, 'snapshot', 'before updating HyperProx itself')
      }
      if (dockerWork) warnings.push(`${g.vmid} is HyperProx itself: its own images are updated by deploying HyperProx, not by this run`)
      continue
    }
    add(t, 'snapshot', g.snapshotCapable ? 'before updating' : `${DETAIL.snapshotNone} — bind-mounted storage`)
    if (aptWork) {
      const reboot = g.type === 'qemu' && pol.reboot === 'if-required' ? ', then reboot if the guest asks for one' : ''
      add(t, 'apt', `apt-get upgrade (${g.pending.length} package${g.pending.length === 1 ? '' : 's'})${reboot}`)
    }
    if (dockerWork) add(t, 'docker', `compose pull + up in ${pol.composeDirs.join(', ')}`)
    if (pol.check) add(t, 'check', pol.check)
  }

  // --- Nodes: what can be planned at all -----------------------------------------------
  const ordered = orderNodes(inv.nodes, policy)
  let nodePhase = true
  for (const n of ordered) {
    if (!n.online) { warnings.push(`${n.node} is offline — the run's preflight will stop`); nodePhase = false }
    else if (n.error) warnings.push(`${n.node}: ${n.error}`)
    if (n.holdsOk === false) warnings.push(`${n.node}: required package holds are missing — the run stops before touching it`)
    if (n.pinOk === false) warnings.push(`${n.node}: the required kernel pin is not in place — the run stops before touching it`)
  }

  const ceph = cephTarget(inv.nodes)
  if (ceph.conflict.length > 1) {
    warnings.push(`Ceph candidate versions differ between nodes (${ceph.conflict.join(', ')}). The Ceph and node phases are not planned; align the repositories first.`)
    nodePhase = false
  }

  // --- Ceph -------------------------------------------------------------------------
  if (nodePhase && ceph.version) {
    const cephNodes = ordered.filter(n => n.cephPending)
    for (const n of cephNodes) add(n.node, 'ceph', `${DETAIL.cephInstall} ${ceph.version}`)
    for (const d of ['mon', 'mgr', 'osd'] as const) {
      for (const n of cephNodes) add(n.node, 'ceph', `${DETAIL.cephRestart} ${d}`)
    }
  }

  // --- Nodes, one at a time -----------------------------------------------------------
  let selfNodeReboot: string | null = null
  if (nodePhase) {
    for (const n of ordered) {
      const pol = nodePolicy(policy, n.node)
      const nonCeph = n.pending.filter(p => !isCephPackage(p.name))
      if (nonCeph.length) add(n.node, 'node-upgrade', `apt-get ${pol.upgrade} (${nonCeph.length} package${nonCeph.length === 1 ? '' : 's'})`)
      if (n.kernelPending || n.rebootRequired) {
        if (pol.reboot === 'manual') add(n.node, 'node-reboot', `${DETAIL.rebootManual} — left pending for a person`)
        else if (n.isSelf) selfNodeReboot = n.node
        else add(n.node, 'node-reboot', `${DETAIL.rebootAuto} — if a new kernel or library needs it`)
      }
      if (n.kernelPending) add(n.node, 'kernel-cleanup', 'keep the running kernel, the pinned one and one fallback; apt clean')
    }
  }

  // --- HyperProx itself, last ---------------------------------------------------------
  if (selfGuestWork && ctx.selfVmid) {
    add(String(ctx.selfVmid), 'self', `${DETAIL.selfGuest} (${selfGuestWork} package${selfGuestWork === 1 ? '' : 's'}) — through a handoff, the API may restart`)
  }
  if (selfNodeReboot) add(selfNodeReboot, 'self', `${DETAIL.selfReboot} — HyperProx's own node, through a handoff from another node`)

  if (!steps.length) warnings.push('Nothing to do: every managed machine is current.')
  return { steps, warnings }
}
