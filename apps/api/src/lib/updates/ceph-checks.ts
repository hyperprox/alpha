// =============================================================================
//  HyperProx — Updates: Ceph safety checks against a live cluster
//
//  The same read-only checks run twice: when a plan is built (so the preview
//  and a dry run say what each Ceph step and node reboot would do) and again
//  when the step executes (the cluster may have changed in between).
//
//  The check is deliberately strict: every OSD on the node is assessed as if
//  all of them were down at once, for an OSD restart as much as for a reboot.
// =============================================================================

import type { UpdatesExecutor } from './executor'
import type { UpdatesPlan } from './types'
import { CEPH_LAYOUT_COMMAND, cephUnitsCommand, cephOsdOkToStopCommand, cephDaemonOkToStopCommand } from './commands'
import {
  parseCephLayout, nodeOsdSet, assessOsdRestart, describeBlockers, parseOsdOkToStop, parseDaemonOkToStop, parseUnitListing,
} from './ceph-safety'

/** How a Ceph step or reboot that would have been unsafe begins its reason. Counted apart from successes. */
export const SAFETY_SKIP = 'skipped for safety:'

export type OsdVerdict =
  | { kind: 'none'; reason: string }
  | { kind: 'safe'; osds: number[]; reason: string }
  | { kind: 'unsafe'; osds: number[]; reason: string }
  | { kind: 'unreadable'; reason: string }

export const osdNames = (osds: number[]) => osds.map(o => `osd.${o}`).join(', ')

/** Another online node to run cluster commands from. */
export async function peerFor(exec: UpdatesExecutor, node: string): Promise<string> {
  const s = await exec.clusterStatus()
  const peer = s.nodes.filter(n => n.online && n.name !== node).map(n => n.name).sort()[0]
  if (!peer) throw new Error(`no other online node to coordinate ${node} from`)
  return peer
}

/**
 * Could every OSD on `node` be down at the same time without data going offline or I/O stopping?
 * No when a size=1 pool has PGs there, when any PG would fall below min_size, or when
 * `ceph osd ok-to-stop` for all of them is not a clear yes.
 */
export async function osdVerdict(exec: UpdatesExecutor, node: string, peer: string, action: 'restarting' | 'rebooting'): Promise<OsdVerdict> {
  // Anything that throws on the way is an unreadable layout: never a "safe", and never a safety skip either.
  try { return await osdVerdictInner(exec, node, peer, action) }
  catch (e: any) { return { kind: 'unreadable', reason: `the Ceph layout is unreadable: ${e?.message ?? e}` } }
}

async function osdVerdictInner(exec: UpdatesExecutor, node: string, peer: string, action: 'restarting' | 'rebooting'): Promise<OsdVerdict> {
  let layout
  try { layout = parseCephLayout((await exec.nodeExec(peer, CEPH_LAYOUT_COMMAND, undefined, 120_000)).output) }
  catch (e: any) { return { kind: 'unreadable', reason: `the Ceph layout is unreadable: could not read the Ceph pool layout: ${e.message}` } }
  let listing
  try { listing = parseUnitListing('osd', (await exec.nodeExec(node, cephUnitsCommand('osd'), undefined, 60_000)).output) }
  catch (e: any) { listing = { ok: false, ids: [] as string[], reason: e.message } }
  const set = nodeOsdSet(layout, node, listing)
  if (!set.ok) return { kind: 'unreadable', reason: set.reason }
  const osds = set.osds
  // Empty only when CRUSH, OSD metadata and the node's units all say so.
  if (!osds.length) return { kind: 'none', reason: `no OSDs on ${node} (CRUSH, OSD metadata and systemd units agree)` }

  const blockers = assessOsdRestart(layout, osds)
  const together = parseOsdOkToStop((await exec.nodeExec(peer, cephOsdOkToStopCommand(osds), undefined, 60_000)).output)
  if (blockers.length || !together.ok) {
    const why = [
      ...(blockers.length ? [`${action === 'rebooting' ? `rebooting ${node}` : `restarting ${osdNames(osds)} on ${node}`} would take data out of service — ${describeBlockers(blockers)}`] : []),
      ...(!together.ok ? [together.reason] : []),
    ].join('; ')
    return { kind: 'unsafe', osds, reason: why }
  }
  return { kind: 'safe', osds, reason: together.reason }
}

/** `ceph mon ok-to-stop` for the mons on `node`. A node without a mon is a yes. */
export async function daemonVerdict(exec: UpdatesExecutor, daemon: 'mon' | 'mds', node: string, peer: string): Promise<{ ok: boolean; ids: string[]; reason: string }> {
  const listing = parseUnitListing(daemon, (await exec.nodeExec(node, cephUnitsCommand(daemon), undefined, 60_000)).output)
  if (!listing.ok) return { ok: false, ids: [], reason: `could not list the ceph-${daemon} units on ${node}: ${listing.reason}` }
  const ids = listing.ids
  if (!ids.length) return { ok: true, ids, reason: `no ${daemon} on ${node}` }
  const v = parseDaemonOkToStop(daemon, (await exec.nodeExec(peer, cephDaemonOkToStopCommand(daemon, ids), undefined, 60_000)).output)
  return { ok: v.ok, ids, reason: v.reason }
}
export const monVerdict = (exec: UpdatesExecutor, node: string, peer: string) => daemonVerdict(exec, 'mon', node, peer)

/** What the plan preview appends to a step's detail. The runner keys only on the words before it. */
export const SAFETY_MARK = ' · safety: '

/**
 * Plan time: say, per Ceph restart and node reboot, whether it would run or be skipped for safety and why.
 * Read-only. The same checks run again when each step executes.
 */
export async function annotatePlanSafety(exec: UpdatesExecutor, plan: UpdatesPlan, cephPresent: boolean): Promise<UpdatesPlan> {
  if (!cephPresent) return plan
  const cache = new Map<string, Promise<string>>()
  const once = (key: string, f: () => Promise<string>) => {
    if (!cache.has(key)) cache.set(key, f().catch((e: any) => `the step would refuse: the Ceph layout is unreadable: ${e?.message ?? e}`))
    return cache.get(key)!
  }
  const warnings: string[] = []
  for (const s of plan.steps) {
    const words = (s.detail ?? '').split(/\s+/)
    const isReboot = (s.action === 'node-reboot' && words[0] === 'auto') || (s.action === 'self' && words[0] === 'node-reboot')
    const daemon = s.action === 'ceph' && words[0] === 'restart' ? words[1] : null
    if (!isReboot && !daemon) continue
    const verdict = await once(`${isReboot ? 'reboot' : daemon}:${s.target}`, async () => {
      const peer = await peerFor(exec, s.target)
      if (daemon === 'mgr') return 'will restart (Ceph has no ok-to-stop check for mgrs)'
      if (daemon === 'mon' || daemon === 'mds') {
        const m = await daemonVerdict(exec, daemon, s.target, peer)
        return m.ok ? `will restart (${m.reason})` : `${SAFETY_SKIP} ${m.reason}`
      }
      if (daemon !== null && daemon !== 'osd') return `the step would refuse: HyperProx has no safety check for ceph-${daemon}`
      const v = await osdVerdict(exec, s.target, peer, isReboot ? 'rebooting' : 'restarting')
      if (v.kind === 'none') return isReboot ? `will reboot if needed (${v.reason})` : `nothing to restart (${v.reason})`
      if (v.kind === 'unreadable') return `the step would refuse: ${v.reason}`
      if (v.kind === 'unsafe') return `${SAFETY_SKIP} ${v.reason}${isReboot ? ' — the reboot would be left pending' : ''}`
      return isReboot ? `will reboot if needed (${osdNames(v.osds)} can all be down at once)`
        : `will restart ${osdNames(v.osds)} one at a time under noout`
    })
    s.detail = `${s.detail ?? ''}${SAFETY_MARK}${verdict}`
    if (!verdict.startsWith('will ') && !verdict.startsWith('nothing ')) warnings.push(`${s.target}: ${isReboot ? 'reboot' : `restart ${daemon}`} ${verdict}`)
  }
  plan.warnings = [...plan.warnings, ...warnings]
  return plan
}

/** A step's detail without the plan-time safety note. */
export const withoutSafetyNote = (detail: string | null | undefined) => (detail ?? '').split(SAFETY_MARK)[0]
