// =============================================================================
//  HyperProx — Updates: the daily check
//
//  Once a day (policy `check:`, default 06:30) and on "Check now", every cluster — home and each remote — is
//  read for what is pending on every node and on every guest HyperProx would update. READ-ONLY: package lists
//  are refreshed (`apt update`, which installs nothing) and apt is asked to SIMULATE the upgrade a run would
//  do; nothing is installed, removed, held, unheld or restarted. Everything goes through the same per-cluster
//  executor as a run (pinned remote logins, the script guard, the cluster's own policy), one machine at a time
//  with a pause between, so it never hammers anything.
//
//  A cluster is skipped, and the result says why, when it does not answer, when a backup is running on it, or
//  while an Updates job is active anywhere. A locked HyperProx has no credentials, so a scheduled check that
//  falls then is skipped and logged.
//
//  What it found is kept (data/updates-check.json, no secrets: names and counts) so the Updates page and the
//  Command center show it without touching any machine on page load. When a check finds something NEW since
//  the last message, one `updates.available` message goes to the channels that take Updates events; the same
//  list is not sent again, except as a reminder at most every `check.reminder_days` (default 7) while it stays.
// =============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { UpdatesCheckCluster, UpdatesCheckStatus, UpdatesCheckTarget, UpdatesClusterRef, UpdatesInventory } from './types'
import type { UpdatesExecutor } from './executor'
import { type PolicyLoad, type Policy, guestPolicy } from './policy'
import { readInventory } from './inventory'
import { GUEST_REFRESH_SCRIPT } from './commands'
import { dueMinutes } from './scheduler'
import { nextRun } from './cron'
import type { NotifyEventInput } from '../notify/types'

// --- Stored state --------------------------------------------------------------------

export interface CheckState {
  lastRun: string | null
  clusters: Record<string, UpdatesCheckCluster>
  /** Hashes of what each cluster offered at its last full read (dedupe survives a skipped run). */
  keys: Record<string, string[]>
  /** What the last message covered, and when it went. */
  notified: { at: string | null; keys: string[] }
}

export interface CheckStateStore { load(): CheckState; save(s: CheckState): void }

export const emptyState = (): CheckState => ({ lastRun: null, clusters: {}, keys: {}, notified: { at: null, keys: [] } })

export const DEFAULT_CHECK_STATE_PATH = '/opt/hyperprox/data/updates-check.json'

/** A JSON file only the API user can read, written atomically. */
export class FileCheckState implements CheckStateStore {
  constructor(private file = process.env.UPDATES_CHECK_STATE_PATH || DEFAULT_CHECK_STATE_PATH) {}
  load(): CheckState {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return { ...emptyState(), ...j, notified: { ...emptyState().notified, ...(j?.notified ?? {}) } }
    } catch { return emptyState() }
  }
  save(s: CheckState): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
}

export class MemoryCheckState implements CheckStateStore {
  state = emptyState()
  load(): CheckState { return structuredClone(this.state) }
  save(s: CheckState): void { this.state = structuredClone(s) }
}

// --- Reading one cluster -------------------------------------------------------------------

/** What the check found on one machine, from an inventory read through apt's simulation. */
export function targetsOf(inv: UpdatesInventory): UpdatesCheckTarget[] {
  const out: UpdatesCheckTarget[] = []
  for (const n of inv.nodes) {
    if (n.error && !n.pending.length) continue
    const held = n.held?.length ?? 0
    if (!n.pending.length && !held) continue
    out.push({
      kind: 'node', name: n.node, packages: n.pending.length,
      security: n.pending.filter(p => p.security).map(p => p.name).sort(),
      kernel: Boolean(n.preview?.kernel || n.kernelPending),
      rebootNeeded: Boolean(n.preview?.rebootAfter || n.rebootRequired),
      held,
    })
  }
  for (const g of inv.guests) {
    if (!g.managed) continue
    const held = g.keptBack?.length ?? 0
    if (!g.pending.length && !held) continue
    out.push({
      kind: g.type, name: g.name || String(g.vmid), vmid: g.vmid, packages: g.pending.length,
      security: g.pending.filter(p => p.security).map(p => p.name).sort(),
      kernel: false, rebootNeeded: g.rebootRequired, held,
    })
  }
  return out
}

/** One-way keys of what is offered: target + package + version. Versions never leave the state file. */
export function findingKeys(clusterId: string, inv: UpdatesInventory): string[] {
  const keys: string[] = []
  const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24)
  for (const n of inv.nodes) for (const p of n.pending) keys.push(h(`${clusterId}|node:${n.node}|${p.name}@${p.to}`))
  for (const g of inv.guests) if (g.managed) for (const p of g.pending) keys.push(h(`${clusterId}|guest:${g.vmid}|${p.name}@${p.to}`))
  return [...new Set(keys)].sort()
}

function unreadOf(inv: UpdatesInventory): string[] {
  return [
    ...inv.nodes.filter(n => n.error).map(n => `node ${n.node}: ${shortReason(n.error!)}`),
    ...inv.guests.filter(g => g.error && g.unmanagedReason !== 'excluded').map(g => `${g.type === 'lxc' ? 'container' : 'VM'} ${g.name || g.vmid}: ${shortReason(g.error!)}`),
  ]
}

/** A reason short enough for the page, without addresses. */
export function shortReason(s: string): string {
  return stripAddresses(String(s)).replace(/\s+/g, ' ').trim().slice(0, 140)
}

/** Remove anything that looks like an address, URL or host:port from text that may reach a channel or page. */
export function stripAddresses(s: string): string {
  return s
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[link]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[address]')
    // IPv6: hex groups with colons, holding a "::" or a hex letter (so a time such as 06:30:00 is left alone).
    .replace(/\b[0-9a-f]{1,4}(?::{1,2}[0-9a-f]{0,4}){2,7}/gi, m => (/::|[a-f]/i.test(m) ? '[address]' : m))
}

/** Guests worth refreshing lists in: running, not excluded, apt on, and (VMs) Linux with the agent. */
async function refreshGuests(exec: UpdatesExecutor, policy: Policy, gap: () => Promise<void>): Promise<void> {
  const guests = (await exec.listGuests()).filter(g => g.running && !g.template).sort((a, b) => a.vmid - b.vmid)
  for (const g of guests) {
    const pol = guestPolicy(policy, g.vmid)
    if (pol.excluded || !pol.apt) continue
    if (g.type === 'qemu') {
      const cfg = await exec.guestConfig(g).catch(() => null)
      if (!cfg || /^(win|w2k|wxp|wvista)/.test(String(cfg.ostype ?? '')) || !/^(1|enabled=1)/.test(String(cfg.agent ?? ''))) continue
    }
    // A guest whose lists did not refresh is still read; it is simply read from older lists.
    await exec.guestExec(g, GUEST_REFRESH_SCRIPT, undefined, 10 * 60_000).catch(() => undefined)
    await gap()
  }
}

// --- The message --------------------------------------------------------------------------

const KIND_WORD: Record<UpdatesCheckTarget['kind'], string> = { node: 'node', lxc: 'container', qemu: 'VM' }

/** "Remote server (remote)" / "Home cluster (home)": the teal and amber, as words. */
export const clusterWords = (c: UpdatesClusterRef) => `${safeName(c.name)} (${c.kind === 'remote' ? 'remote' : 'home'})`

/** A name from outside HyperProx, made safe for a message: no addresses, no markup, short. */
export function safeName(s: string): string {
  return stripAddresses(String(s).replace(/[`*_~|<>[\]()]/g, '')).replace(/\s+/g, ' ').trim().slice(0, 48) || '?'
}

function targetWords(t: UpdatesCheckTarget): string {
  const flags = [t.kernel ? 'kernel update' : '', t.rebootNeeded ? 'reboot needed' : ''].filter(Boolean)
  const pk = t.packages ? `${t.packages} package${t.packages === 1 ? '' : 's'}` : 'nothing to apply'
  return `${KIND_WORD[t.kind]} ${safeName(t.name)} ${pk}${flags.length ? ` (${flags.join(', ')})` : ''}`
}

const SKIP_WORDS: Array<[RegExp, string]> = [
  [/backup/i, 'a backup was running'],
  [/job/i, 'an Updates job was running'],
  [/locked/i, 'HyperProx was locked'],
]
function skipWords(reason?: string): string {
  for (const [re, w] of SKIP_WORDS) if (re.test(reason ?? '')) return w
  return 'it did not answer'
}

/**
 * The `updates.available` message: security fixes first (package names only), then per cluster the machines
 * with updates as counts and kernel/reboot flags, then held packages and clusters that were not read. No
 * versions, addresses, tokens or command output: names and counts only.
 */
export function buildMessage(results: UpdatesCheckCluster[], reminder: boolean): Omit<NotifyEventInput, 'fingerprint'> {
  const lines: string[] = []
  const plain: string[] = []
  const withSec = results.flatMap(r => r.targets.filter(t => t.security.length).map(t => ({ r, t })))
  if (withSec.length) {
    const parts = withSec.map(({ r, t }) => {
      const names = t.security.slice(0, 8).map(safeName)
      return `${clusterWords(r.cluster)} ${KIND_WORD[t.kind]} ${safeName(t.name)}: ${names.join(', ')}${t.security.length > 8 ? ` and ${t.security.length - 8} more` : ''}`
    })
    lines.push(`Security fixes: ${parts.join('; ')}.`)
  }
  for (const r of results) {
    plain.push(safeName(r.cluster.name))
    if (r.result === 'skipped') { lines.push(`${clusterWords(r.cluster)}: not checked this time (${skipWords(r.reason)}).`); continue }
    const offered = r.targets.filter(t => t.packages > 0)
    const held = r.targets.reduce((a, t) => a + t.held, 0)
    if (!offered.length && !held) continue
    const nodes = offered.filter(t => t.kind === 'node')
    const guests = offered.filter(t => t.kind !== 'node')
    const parts = nodes.map(targetWords)
    if (guests.length > 4) parts.push(`${guests.length} guests with updates (${guests.reduce((a, t) => a + t.packages, 0)} packages)`)
    else parts.push(...guests.map(targetWords))
    for (const t of offered) plain.push(safeName(t.name))
    if (held) parts.push(`${held} held or kept back, not offered`)
    lines.push(`${clusterWords(r.cluster)}: ${parts.join('; ')}.`)
  }
  return {
    type: 'updates.available',
    // A warning, so a channel on the default "warnings and critical" gets it; it is sent only for new findings
    // (and a weekly reminder), so it stays rare.
    severity: 'warning',
    title: reminder ? 'Updates still waiting (weekly reminder)' : withSec.length ? 'Security updates available' : 'Updates available',
    lines,
    link: '/updates',
    linkLabel: 'Open Updates',
    where: 'Updates page',
    plain,
  }
}

// --- The checker ------------------------------------------------------------------------------

export interface CheckClusterHandle {
  ref: UpdatesClusterRef
  exec: UpdatesExecutor
  loadPolicy: () => PolicyLoad
  /** Read the inventory as a run would for this cluster (remote: no self, etc.); the check adds simulation. */
  remote: boolean
}

export interface CheckDeps {
  clusters: () => CheckClusterHandle[]
  /** The policy file's own load: the `check:` section is read from its top level. */
  loadPolicy: () => PolicyLoad
  /** Any Updates job active anywhere (the shared lock). */
  activeJob: () => Promise<{ id: string } | null>
  isUnlocked: () => boolean
  state: CheckStateStore
  publish?: (e: NotifyEventInput) => Promise<void>
  log?: (msg: string) => void
  now?: () => Date
  /** Pause between machines (default 3 s) and between clusters (default 10 s). */
  gapMs?: number
  clusterGapMs?: number
  sleep?: (ms: number) => Promise<void>
  /** Longest one cluster may take to answer its status read. */
  reachMs?: number
}

const sleepReal = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export class UpdatesChecker {
  private timer: ReturnType<typeof setInterval> | null = null
  private last: Date
  private current: Promise<UpdatesCheckStatus> | null = null

  constructor(private deps: CheckDeps) { this.last = this.now() }

  private now(): Date { return this.deps.now ? this.deps.now() : new Date() }
  private sleep(ms: number): Promise<void> { return ms > 0 ? (this.deps.sleep ?? sleepReal)(ms) : Promise.resolve() }
  get running(): boolean { return this.current !== null }

  status(): UpdatesCheckStatus {
    const s = this.deps.state.load()
    const pol = this.deps.loadPolicy().policy.check
    let next: string | null = null
    if (pol.enabled) { try { next = nextRun(pol.cron, this.now())?.toISOString() ?? null } catch { next = null } }
    const order = this.deps.clusters().map(c => c.ref.id)
    const clusters = Object.values(s.clusters)
      .filter(c => order.includes(c.cluster.id))
      .sort((a, b) => order.indexOf(a.cluster.id) - order.indexOf(b.cluster.id))
    return { running: this.running, lastRun: s.lastRun, nextRun: next, clusters, lastNotified: s.notified.at }
  }

  /** The stored result for one cluster, for the Command center. No machine is touched. */
  summary(id: string): UpdatesCheckCluster | null {
    return this.deps.state.load().clusters[id] ?? null
  }

  /** One check of every cluster. A second call while one runs gets the same run. */
  run(trigger: 'schedule' | 'manual'): Promise<UpdatesCheckStatus> {
    if (this.current) return this.current
    this.current = this.runOnce(trigger).finally(() => { this.current = null })
    return this.current
  }

  private async runOnce(trigger: 'schedule' | 'manual'): Promise<UpdatesCheckStatus> {
    const state = this.deps.state.load()
    const at = this.now().toISOString()
    const gap = () => this.sleep(this.deps.gapMs ?? 3000)
    const fresh: UpdatesCheckCluster[] = []
    const handles = this.deps.clusters()
    for (let i = 0; i < handles.length; i++) {
      const h = handles[i]
      if (i) await this.sleep(this.deps.clusterGapMs ?? 10_000)
      const prev = state.clusters[h.ref.id]
      const skip = (reason: string): UpdatesCheckCluster => ({
        cluster: { ...h.ref }, at, result: 'skipped', reason, lastOkAt: prev?.result === 'skipped' ? prev.lastOkAt ?? null : prev?.at ?? null,
        targets: prev?.targets ?? [], unread: [], available: prev?.available ?? 0, packages: prev?.packages ?? 0, security: prev?.security ?? 0,
      })
      let r: UpdatesCheckCluster
      try {
        if (!this.deps.isUnlocked()) r = skip('HyperProx is locked, so it has no credentials to read with')
        else if (await this.deps.activeJob()) r = skip('an Updates job is running')
        else r = await this.checkCluster(h, at, gap, skip, state)
      } catch (e: any) { r = skip(`not reachable: ${shortReason(e?.message ?? String(e))}`) }
      state.clusters[h.ref.id] = r
      fresh.push(r)
      this.deps.log?.(`[updates] check ${h.ref.name}: ${r.result}${r.reason ? ` (${r.reason})` : ''}, ${r.available} with updates`)
    }
    // Clusters that were removed leave the state.
    for (const id of Object.keys(state.clusters)) if (!handles.some(h => h.ref.id === id)) { delete state.clusters[id]; delete state.keys[id] }
    state.lastRun = at
    await this.notify(state, fresh)
    this.deps.state.save(state)
    this.deps.log?.(`[updates] ${trigger} check finished`)
    return this.status()
  }

  private async checkCluster(h: CheckClusterHandle, at: string, gap: () => Promise<void>,
                             skip: (reason: string) => UpdatesCheckCluster, state: CheckState): Promise<UpdatesCheckCluster> {
    const exec = h.exec
    const reach = await Promise.race([
      exec.clusterStatus().then(s => ({ s })),
      new Promise<{ s: null }>(res => setTimeout(() => res({ s: null }), this.deps.reachMs ?? 30_000).unref?.()),
    ])
    if (!reach.s) return skip('not reachable: no answer within 30 s')
    if (exec.backupTasks) {
      const running = (await exec.backupTasks().catch(() => [])).some(t => t.ok === null)
      if (running) return skip('a backup is running on it')
    }
    const load = h.loadPolicy()
    const policy = load.policy
    for (const n of reach.s.nodes.filter(x => x.online)) {
      await exec.nodeAptRefresh(n.name).catch(e => this.deps.log?.(`[updates] check: apt update on ${n.name} failed: ${e.message}`))
      await gap()
    }
    await refreshGuests(exec, policy, gap)
    const inv = (await readInventory(exec, policy, {
      nodePreview: 'apt-simulation', nodeBatch: 1, guestBatch: 1, gap,
      noSelf: h.remote, rebootPending: new Set(),
    })).inventory
    const targets = targetsOf(inv)
    const unread = unreadOf(inv)
    const offered = targets.filter(t => t.packages > 0)
    state.keys[h.ref.id] = findingKeys(h.ref.id, inv)
    return {
      cluster: { ...h.ref }, at, result: unread.length ? 'partial' : 'ok', lastOkAt: at,
      targets, unread, available: offered.length,
      packages: offered.reduce((a, t) => a + t.packages, 0),
      security: offered.reduce((a, t) => a + t.security.length, 0),
    }
  }

  /** New findings since the last message: send. Same findings: nothing, or a reminder once `reminder_days` passed. */
  private async notify(state: CheckState, results: UpdatesCheckCluster[]): Promise<void> {
    const current = [...new Set(Object.values(state.keys).flat())]
    const told = new Set(state.notified.keys)
    const isNew = current.some(k => !told.has(k))
    const days = this.deps.loadPolicy().policy.check.reminderDays
    const last = state.notified.at ? Date.parse(state.notified.at) : 0
    const due = current.length > 0 && this.now().getTime() - last >= days * 86_400_000
    if (!current.length) { state.notified.keys = []; return }
    if (!isNew && !due) {
      // Applied updates drop out, so the same version coming back later counts as new again.
      state.notified.keys = state.notified.keys.filter(k => current.includes(k))
      return
    }
    const withNews = results.filter(r => r.result === 'skipped' || r.targets.some(t => t.packages > 0 || t.held > 0))
    const msg = buildMessage(withNews, !isNew)
    if (!msg.lines?.length) return
    if (this.deps.publish) {
      try { await this.deps.publish({ ...msg, fingerprint: 'updates.available' }) }
      catch (e: any) { this.deps.log?.(`[updates] could not send the check message: ${e?.name ?? 'error'}`); return }
    }
    state.notified = { at: this.now().toISOString(), keys: current }
  }

  // --- schedule -------------------------------------------------------------------------------

  start(intervalMs = 30_000): void {
    if (this.timer) return
    this.timer = setInterval(() => { this.tick().catch(e => this.deps.log?.(`[updates] check scheduler: ${e.message}`)) }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null }

  /** One scheduler tick: runs the check once when its time fell since the last tick. */
  async tick(): Promise<'off' | 'idle' | 'locked' | 'busy' | 'ran' | 'error'> {
    const now = this.now()
    const since = this.last
    this.last = now
    const pol = this.deps.loadPolicy().policy.check
    if (!pol.enabled) return 'off'
    let due: Date[]
    try { due = dueMinutes(pol.cron, since, now) } catch (e: any) { this.deps.log?.(`[updates] check schedule not understood: ${e.message}`); return 'error' }
    if (!due.length) return 'idle'
    if (!this.deps.isUnlocked()) { this.deps.log?.('[updates] daily check skipped: HyperProx is locked, so it has no credentials to read with'); return 'locked' }
    if (this.running) return 'busy'
    await this.run('schedule')
    return 'ran'
  }
}
