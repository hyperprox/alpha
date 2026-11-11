// =============================================================================
//  HyperProx — QNAP: alerts
//
//  Every few minutes (while HyperProx is unlocked: the NAS logins are in the
//  vault) each NAS with alerts on is read, and its conditions compared with
//  what was announced before. A condition is announced once when it starts and
//  once when it clears, the same idea as the Prometheus forwarder (lib/alerts/
//  forwarder.ts), with the same fingerprint for both so a message held in quiet
//  hours and its resolve cancel each other. Events are `alert.qnap.*`, which
//  the notification settings file under "resources".
//
//    - a disk whose SMART (or I/O) health turns warning or bad;
//    - a volume or storage pool that is degraded, rebuilding or failed;
//    - a volume at 90% used or more (clears below 88%);
//    - a disk at or above its warning temperature (the NAS's own threshold, the
//      instance's own setting, or 55 °C), critical at the NAS's error threshold;
//      the system at or above its warning temperature (60 °C when the NAS does
//      not say), the CPU at 85 °C; each clears 3 °C below where it fired;
//    - a fan the NAS reports as stopped.
//
//  A NAS that cannot be read leaves its conditions as they were: not reading a
//  disk is not the disk getting better. What was announced is kept in a small
//  JSON file (names and numbers, no logins), so a restart does not repeat it.
// =============================================================================

import fs from 'node:fs'
import path from 'node:path'
import type { NotifyEventInput, Severity } from '../notify/types'
import type { QnapReading } from './parse'
import type { QnapMeta } from './instances'

export const POLL_MS = 5 * 60_000
export const VOLUME_FULL_PCT = 90
export const VOLUME_CLEAR_PCT = 88
export const DEFAULT_DISK_WARN_C = 55
export const DEFAULT_SYS_WARN_C = 60
export const CPU_WARN_C = 85
export const HYSTERESIS_C = 3

export interface Condition { key: string; severity: Severity; title: string; lines: string[] }

const pct = (used: number, total: number) => Math.round((used / total) * 1000) / 10

/**
 * The conditions true of this reading. `firing` holds the keys already announced, so a temperature or a full
 * volume that is just under its threshold stays announced until it is clearly back (hysteresis).
 */
export function conditionsOf(m: Pick<QnapMeta, 'name' | 'diskTempWarnC'>, r: QnapReading, firing: Set<string> = new Set()): Condition[] {
  const out: Condition[] = []
  const at = m.name
  for (const d of r.disks) {
    const what = `Disk ${d.bay}${d.model ? ` (${d.model})` : ''}`
    if (d.smart === 'bad' || d.smart === 'warning') {
      out.push({ key: `disk:${d.bay}:smart`, severity: d.smart === 'bad' ? 'critical' : 'warning',
        title: `${what} on ${at}: SMART says ${d.smartText ?? d.smart}`,
        lines: [d.smart === 'bad' ? 'The NAS reports this disk as failing. Back up what is on it and plan to replace it.' : 'The NAS reports a SMART warning on this disk. Keep an eye on it and check its backups.'] })
    }
    if (d.tempC !== null) {
      const warn = m.diskTempWarnC ?? r.thresholds.diskWarnC ?? DEFAULT_DISK_WARN_C
      const key = `disk:${d.bay}:temp`
      const limit = firing.has(key) ? warn - HYSTERESIS_C : warn
      if (d.tempC >= limit) {
        const crit = r.thresholds.diskErrC !== null && d.tempC >= r.thresholds.diskErrC
        out.push({ key, severity: crit ? 'critical' : 'warning', title: `${what} on ${at} is hot: ${d.tempC} °C`,
          lines: [`Its warning level is ${warn} °C${r.thresholds.diskErrC !== null ? ` and the NAS's error level ${r.thresholds.diskErrC} °C` : ''}. Check the fans and the air around the NAS.`] })
      }
    }
  }
  for (const v of r.volumes) {
    if (v.health === 'bad' || v.health === 'warning') {
      out.push({ key: `vol:${v.id}:state`, severity: v.health === 'bad' ? 'critical' : 'warning',
        title: `${v.name} on ${at} is ${v.status ?? (v.health === 'bad' ? 'failed' : 'degraded')}`,
        lines: [v.health === 'bad' ? 'The NAS reports this volume as not working. Its data may be unreachable.' : 'The volume is degraded or rebuilding: it has less protection than usual until that finishes.'] })
    }
    if (v.totalBytes && v.usedBytes !== null) {
      const p = pct(v.usedBytes, v.totalBytes)
      const key = `vol:${v.id}:full`
      if (p >= (firing.has(key) ? VOLUME_CLEAR_PCT : VOLUME_FULL_PCT)) {
        out.push({ key, severity: p >= 97 ? 'critical' : 'warning', title: `${v.name} on ${at} is ${p}% full`,
          lines: [`Free space is getting low. Above ${VOLUME_FULL_PCT}% a NAS slows down and snapshots and updates can fail.`] })
      }
    }
  }
  for (const p of r.pools) {
    if (p.health === 'bad' || p.health === 'warning') {
      out.push({ key: `pool:${p.id}:state`, severity: p.health === 'bad' ? 'critical' : 'warning',
        title: `${p.name} on ${at} is ${p.status ?? (p.health === 'bad' ? 'failed' : 'degraded')}`, lines: ['The NAS reports a problem with this storage pool.'] })
    }
  }
  const temp = (key: string, value: number | null, warn: number, label: string) => {
    if (value === null) return
    if (value >= (firing.has(key) ? warn - HYSTERESIS_C : warn)) {
      out.push({ key, severity: 'warning', title: `${label} on ${at} is hot: ${value} °C`, lines: [`Its warning level is ${warn} °C.`] })
    }
  }
  temp('sys:temp', r.sysTempC, r.thresholds.sysWarnC ?? DEFAULT_SYS_WARN_C, 'The system')
  temp('cpu:temp', r.cpuTempC, CPU_WARN_C, 'The CPU')
  for (const f of r.fans) if (f.ok === false) out.push({ key: `fan:${f.index}`, severity: 'warning', title: `Fan ${f.index} on ${at} has stopped`, lines: ['A stopped fan lets the disks and the system run hot.'] })
  return out
}

// ── state ────────────────────────────────────────────────────────────────────

export interface Announced { instanceId: string; key: string; severity: Severity; title: string; since: string }
export interface AlertState { firing: Record<string, Announced> }
export interface AlertStateStore { load(): AlertState; save(s: AlertState): void }

export const DEFAULT_STATE_PATH = '/opt/hyperprox/data/qnap-alerts.json'

export class FileAlertState implements AlertStateStore {
  constructor(private file = process.env.QNAP_ALERTS_STATE_PATH || DEFAULT_STATE_PATH) {}
  load(): AlertState {
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); return { firing: j?.firing && typeof j.firing === 'object' ? j.firing : {} } }
    catch { return { firing: {} } }
  }
  save(s: AlertState): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
}

export class MemoryAlertState implements AlertStateStore {
  state: AlertState = { firing: {} }
  load(): AlertState { return structuredClone(this.state) }
  save(s: AlertState): void { this.state = structuredClone(s) }
}

export const fingerprintOf = (instanceId: string, key: string) => `qnap:${instanceId}:${key}`

// ── the poller ───────────────────────────────────────────────────────────────

export interface PollerDeps {
  /** Every NAS, and whether its alerts are on. */
  instances: () => Promise<QnapMeta[]>
  /** A reading of one NAS. Throws when it cannot be read. */
  read: (id: string) => Promise<QnapReading>
  publish: (e: NotifyEventInput) => Promise<void>
  store: AlertStateStore
  /** False while HyperProx is locked: the logins cannot be read, so nothing is polled. */
  ready?: () => boolean
  now?: () => Date
  log?: (m: string) => void
}

export class QnapAlertPoller {
  private timer: NodeJS.Timeout | null = null
  private first: NodeJS.Timeout | null = null
  private running = false
  constructor(private d: PollerDeps) {}

  private log(m: string) { this.d.log?.(`[qnap-alerts] ${m}`) }

  async tick(): Promise<{ fired: number; resolved: number; skipped: number }> {
    if (this.running || (this.d.ready && !this.d.ready())) return { fired: 0, resolved: 0, skipped: 0 }
    this.running = true
    try { return await this.poll() } finally { this.running = false }
  }

  private async poll() {
    const now = this.d.now ? this.d.now() : new Date()
    const state = this.d.store.load()
    let changed = false
    let fired = 0, resolved = 0, skipped = 0
    const list = await this.d.instances()
    const known = new Set(list.map(m => m.id))
    // A NAS removed, or with alerts turned off: forget what it had, quietly (nothing was fixed).
    for (const [fp, a] of Object.entries(state.firing)) {
      if (!known.has(a.instanceId) || !list.find(m => m.id === a.instanceId)!.alerts) { delete state.firing[fp]; changed = true }
    }
    for (const m of list) {
      if (!m.alerts) continue
      let r: QnapReading
      try { r = await this.d.read(m.id) } catch (e: any) { skipped++; this.log(`${m.id} not read: ${e?.name ?? 'error'}`); continue }
      const mine = new Set(Object.values(state.firing).filter(a => a.instanceId === m.id).map(a => a.key))
      const now_ = conditionsOf(m, r, mine)
      for (const c of now_) {
        const fp = fingerprintOf(m.id, c.key)
        if (state.firing[fp]) continue
        if (await this.send({ type: c.key.startsWith('disk') ? 'alert.qnap.disk' : c.key.startsWith('vol') || c.key.startsWith('pool') ? 'alert.qnap.volume' : 'alert.qnap.temperature',
          severity: c.severity, title: c.title, lines: c.lines, plain: [m.name], link: '/plugins/qnap', where: 'QNAP plug-in', fingerprint: fp,
          subject: { kind: 'nas', name: m.name } })) {
          state.firing[fp] = { instanceId: m.id, key: c.key, severity: c.severity, title: c.title, since: now.toISOString() }
          fired++; changed = true
        }
      }
      const present = new Set(now_.map(c => c.key))
      for (const [fp, a] of Object.entries(state.firing)) {
        if (a.instanceId !== m.id || present.has(a.key)) continue
        if (await this.send({ type: a.key.startsWith('disk') ? 'alert.qnap.disk' : a.key.startsWith('vol') || a.key.startsWith('pool') ? 'alert.qnap.volume' : 'alert.qnap.temperature',
          severity: a.severity, resolved: true, title: a.title, lines: ['This has cleared.', `It started ${a.since.slice(0, 16).replace('T', ' ')} UTC.`],
          plain: [m.name], link: '/plugins/qnap', where: 'QNAP plug-in', fingerprint: fp, subject: { kind: 'nas', name: m.name } })) {
          delete state.firing[fp]
          resolved++; changed = true
        }
      }
    }
    if (changed) { try { this.d.store.save(state) } catch (e: any) { this.log(`could not save state: ${e?.code ?? 'error'}`) } }
    return { fired, resolved, skipped }
  }

  private async send(e: NotifyEventInput): Promise<boolean> {
    try { await this.d.publish(e); return true } catch (err: any) { this.log(`could not publish ${e.type}: ${err?.name ?? 'error'}`); return false }
  }

  start(intervalMs = POLL_MS, firstDelayMs = 60_000): void {
    if (this.timer) return
    const run = () => { this.tick().catch(e => this.log(`poll failed: ${e?.message ?? 'error'}`)) }
    this.first = setTimeout(run, firstDelayMs); this.first.unref?.()
    this.timer = setInterval(run, intervalMs); this.timer.unref?.()
  }

  stop(): void {
    if (this.first) clearTimeout(this.first)
    if (this.timer) clearInterval(this.timer)
    this.first = null; this.timer = null
  }
}
