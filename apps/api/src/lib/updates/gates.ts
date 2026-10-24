// =============================================================================
//  HyperProx — Updates: gates
//
//  Each gate answers one question with pass or fail and a reason a person can
//  act on. The runner checks them before anything changes and between steps;
//  a failure pauses the run, and nothing retries a health failure on its own.
//  When a gate cannot get an answer at all, that is a failure too: "could not
//  read Ceph health" must never read as "Ceph is healthy".
// =============================================================================

import type { UpdatesExecutor, CephHealth } from './executor'
import type { Policy, NodePolicy } from './policy'
import { nodePolicy } from './policy'
import type { NodeFacts } from './commands'

export interface GateResult { ok: boolean; reason: string }

const pass = (reason: string): GateResult => ({ ok: true, reason })
const fail = (reason: string): GateResult => ({ ok: false, reason })

export async function quorumGate(exec: UpdatesExecutor): Promise<GateResult> {
  try {
    const s = await exec.clusterStatus()
    if (!s.quorate) return fail('the cluster is not quorate')
    const off = s.nodes.filter(n => !n.online).map(n => n.name)
    if (off.length) return fail(`node${off.length > 1 ? 's' : ''} offline: ${off.join(', ')}`)
    return pass(`quorate, ${s.nodes.length} node${s.nodes.length === 1 ? '' : 's'} online`)
  } catch (e: any) { return fail(`could not read cluster status: ${e.message}`) }
}

export function judgeCeph(h: CephHealth | null, accepted: string[]): GateResult {
  if (!h) return pass('no Ceph on this cluster')   // callers pass null only after cephPresent() said so
  const blocking = h.checks.filter(c => !accepted.includes(c))
  if (blocking.length) return fail(`Ceph ${h.status}: ${blocking.join(', ')} (not in ceph.accepted_warnings)`)
  return pass(h.checks.length ? `Ceph ${h.status}, only accepted warnings (${h.checks.join(', ')})` : 'Ceph HEALTH_OK')
}

/** `present` comes from exec.cephPresent(), decided once per job; a failed read is then always a FAIL. */
export async function cephGate(exec: UpdatesExecutor, policy: Policy, present: boolean): Promise<GateResult> {
  if (!present) return pass('no Ceph on this cluster')
  try { return judgeCeph(await exec.cephHealth(), policy.acceptedWarnings) }
  catch (e: any) { return fail(`could not read Ceph health: ${e.message}`) }
}

export async function cephSettledGate(exec: UpdatesExecutor, present: boolean): Promise<GateResult> {
  if (!present) return pass('no Ceph on this cluster')
  try { return judgeCephSettled(await exec.cephHealth()) }
  catch (e: any) { return fail(`could not read Ceph health: ${e.message}`) }
}

/** Scrubbing is a clean PG doing housekeeping; anything else beside active+clean is not settled. */
export function pgsClean(states: Record<string, number>): boolean {
  return Object.entries(states).every(([state, n]) =>
    n === 0 || state.split('+').filter(s => !['scrubbing', 'deep'].includes(s)).sort().join('+') === 'active+clean')
}

/** After a node returns: every OSD up and in, every PG active+clean. */
export function judgeCephSettled(h: CephHealth | null): GateResult {
  if (!h) return pass('no Ceph on this cluster')
  if (h.numUpOsds < h.numOsds) return fail(`${h.numOsds - h.numUpOsds} OSD(s) down`)
  if (h.numInOsds < h.numOsds) return fail(`${h.numOsds - h.numInOsds} OSD(s) out`)
  if (!pgsClean(h.pgStates)) {
    const odd = Object.entries(h.pgStates).filter(([s]) => !pgsClean({ [s]: 1 })).map(([s, n]) => `${n} ${s}`)
    return fail(`PGs not active+clean: ${odd.join(', ')}`)
  }
  return pass('all OSDs up, all PGs active+clean')
}

const SETTLED_HA = new Set(['started', 'stopped', 'disabled', 'ignored'])

export async function haGate(exec: UpdatesExecutor): Promise<GateResult> {
  try {
    const s = await exec.haStatus()
    const moving = s.services.filter(x => !SETTLED_HA.has(x.state))
    if (moving.length) return fail(`HA not settled: ${moving.map(x => `${x.sid} ${x.state}`).join(', ')}`)
    if (s.maintenanceNodes.length) return fail(`HA maintenance is on for ${s.maintenanceNodes.join(', ')} — clear it first`)
    return pass('HA settled')
  } catch (e: any) { return fail(`could not read HA status: ${e.message}`) }
}

export function freeSpaceGate(node: string, facts: NodeFacts | null | undefined, policy: Policy): GateResult {
  if (!facts || facts.rootFreeMb === null) return fail(`${node}: could not read root free space`)
  if (facts.rootFreeMb < policy.minRootFreeMb) return fail(`${node}: ${facts.rootFreeMb} MB free on /, policy wants ${policy.minRootFreeMb} MB`)
  return pass(`${node}: ${facts.rootFreeMb} MB free on /`)
}

/** Required holds and pin present. Missing is a stop, never something to repair. */
/** Policy keys that name nodes the cluster does not have: a typo would silently fall back to the defaults. */
export function unknownPolicyNodes(policy: Policy, clusterNodes: string[]): GateResult {
  const unknown = Object.keys(policy.nodes).filter(n => !clusterNodes.includes(n)).sort()
  return unknown.length
    ? fail(`the policy names node${unknown.length > 1 ? 's' : ''} not in this cluster: ${unknown.join(', ')} (a typo would apply nodes.default instead)`)
    : pass('every node named in the policy exists')
}

export function holdsPinGate(node: string, facts: NodeFacts | null | undefined, pol: NodePolicy): GateResult {
  if (!pol.requireHolds.length && !pol.requirePin) return pass(`${node}: no holds or pin required`)
  if (!facts) return fail(`${node}: could not read holds and pin`)
  const missing = pol.requireHolds.filter(h => !facts.holds.includes(h))
  if (missing.length) return fail(`${node}: required hold${missing.length > 1 ? 's' : ''} missing: ${missing.join(', ')}`)
  if (pol.requirePin && facts.pinned !== pol.requirePin) {
    return fail(`${node}: kernel pin is ${facts.pinned ?? 'not set'}, policy requires ${pol.requirePin}`)
  }
  return pass(`${node}: holds and pin in place`)
}

export interface StreamGate extends GateResult { /** true when the reason is viewers, so waiting can help */ waiting: boolean }

export async function streamGate(exec: UpdatesExecutor, policy: Policy): Promise<StreamGate> {
  if (!policy.plexBlocksReboots) return { ok: true, waiting: false, reason: 'streams do not block reboots (policy)' }
  try {
    const n = await exec.plexStreams()
    if (n === null) return { ok: true, waiting: false, reason: 'no Plex source configured' }
    if (n > 0) return { ok: false, waiting: true, reason: `${n} Plex stream${n === 1 ? '' : 's'} active` }
    return { ok: true, waiting: false, reason: 'no Plex streams' }
  } catch (e: any) {
    // Not knowing whether anyone is watching is treated like someone watching.
    return { ok: false, waiting: true, reason: `the Plex source did not answer (${e.message})` }
  }
}

/** Everything before a run changes anything. All gates run, so the report lists every problem at once. */
export async function preflight(exec: UpdatesExecutor, policy: Policy, facts: Record<string, NodeFacts | null>, cephPresent: boolean): Promise<GateResult> {
  const results: GateResult[] = [
    await quorumGate(exec), await cephGate(exec, policy, cephPresent), await haGate(exec),
    unknownPolicyNodes(policy, Object.keys(facts)),
  ]
  for (const node of Object.keys(facts).sort()) {
    results.push(freeSpaceGate(node, facts[node], policy))
    results.push(holdsPinGate(node, facts[node], nodePolicy(policy, node)))
  }
  const bad = results.filter(r => !r.ok)
  return bad.length
    ? fail(bad.map(r => r.reason).join('; '))
    : pass(results.map(r => r.reason).join('; '))
}
