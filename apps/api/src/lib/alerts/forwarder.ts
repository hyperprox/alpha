// =============================================================================
//  HyperProx — Prometheus alerts to notifications
//
//  Prometheus evaluates the alert rules (config/prometheus/rules); nothing used
//  to tell anyone when one fired, so a hung graphics card or a dead exporter
//  was noticed only by someone looking at the Monitoring page. This polls
//  Prometheus's /api/v1/alerts once a minute and publishes each change through
//  the notification bus (lib/notify):
//    - alert.firing once, when an alert starts firing;
//    - alert.resolved once, when it is gone (same fingerprint, so a message
//      held in quiet hours and its resolve cancel each other);
//    - one warning when Prometheus has not answered for 5 minutes, and one
//      message when it answers again.
//  What it has announced is kept in a small JSON file (data/alerts-forward.json,
//  alert names and labels only, no secrets), so an API restart does not
//  announce again everything that is still firing. It needs no vault secret, so
//  it runs while HyperProx is locked; vault-only channels hold the messages
//  until the next sign-in, as for every other event.
// =============================================================================

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { getCluster } from '../clusters/registry'
import { publish as busPublish } from '../notify'
import type { NotifyEventInput, Severity } from '../notify/types'
import { prometheusBase } from '../service-health'

export const POLL_MS = 60_000
/** How long Prometheus may stay silent before "monitoring is down" is sent. */
export const PROMETHEUS_DOWN_MS = 5 * 60_000

/**
 * Alerts that are never forwarded (they still show on the Monitoring page). CephHealthWarning is here because
 * a Ceph cluster can sit in HEALTH_WARN for good on purpose (a pool kept at one copy, for example), and a
 * message that never clears teaches people to ignore the channel. Change the list with ALERTS_NOT_FORWARDED
 * in .env: alert names separated by commas; set it empty to forward everything.
 */
export const DEFAULT_NOT_FORWARDED = ['CephHealthWarning']

export function notForwardedFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const v = env.ALERTS_NOT_FORWARDED
  if (v === undefined) return [...DEFAULT_NOT_FORWARDED]
  return v.split(',').map(s => s.trim()).filter(Boolean)
}

/** One alert as Prometheus's /api/v1/alerts lists it. */
export interface PromAlert {
  labels: Record<string, string>
  annotations?: Record<string, string>
  state: string            // 'firing' | 'pending' (| 'inactive' on newer versions)
  activeAt?: string
  value?: string
}

export interface AnnouncedAlert {
  alertname: string
  severity: Severity
  /** The headline as sent, place included. */
  title: string
  place: string
  since: string
}

export interface ForwarderState {
  /** fingerprint -> what was announced as firing. */
  firing: Record<string, AnnouncedAlert>
  prometheus: {
    /** Prometheus has answered at least once. Until then an install without it is not "down". */
    seenOk: boolean
    failingSince: string | null
    announced: boolean
  }
}

export const emptyForwarderState = (): ForwarderState => ({ firing: {}, prometheus: { seenOk: false, failingSince: null, announced: false } })

export interface ForwarderStateStore { load(): ForwarderState; save(s: ForwarderState): void }

export const DEFAULT_FORWARDER_STATE_PATH = '/opt/hyperprox/data/alerts-forward.json'

/** A JSON file only the API user can read, written atomically (as lib/updates/check.ts does). */
export class FileForwarderState implements ForwarderStateStore {
  constructor(private file = process.env.ALERTS_FORWARD_STATE_PATH || DEFAULT_FORWARDER_STATE_PATH) {}
  load(): ForwarderState {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      const e = emptyForwarderState()
      return { firing: j?.firing && typeof j.firing === 'object' ? j.firing : {}, prometheus: { ...e.prometheus, ...(j?.prometheus ?? {}) } }
    } catch { return emptyForwarderState() }
  }
  save(s: ForwarderState): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
}

export class MemoryForwarderState implements ForwarderStateStore {
  state = emptyForwarderState()
  load(): ForwarderState { return structuredClone(this.state) }
  save(s: ForwarderState): void { this.state = structuredClone(s) }
}

export interface ForwarderDeps {
  /** The alerts Prometheus has now. Throws when it cannot be reached or does not answer properly. */
  fetchAlerts: () => Promise<PromAlert[]>
  publish: (e: NotifyEventInput) => Promise<void>
  store: ForwarderStateStore
  notForwarded?: () => string[]
  /** A remote cluster's display name, or null when it is not known. */
  clusterName?: (id: string) => string | null
  now?: () => Date
  /** Time zone for "since" times (IANA); default the server's. */
  timeZone?: string
  log?: (m: string) => void
}

/** Prometheus's alerts, from the bundled Prometheus (or PROMETHEUS_URL). */
export async function fetchPrometheusAlerts(base = prometheusBase(), timeoutMs = 5000): Promise<PromAlert[]> {
  const r = await fetch(`${base}/api/v1/alerts`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const j = await r.json() as any
  if (j?.status !== 'success' || !Array.isArray(j?.data?.alerts)) throw new Error('unexpected answer')
  return j.data.alerts as PromAlert[]
}

// --- Wording -------------------------------------------------------------------------------------

/** Stable per alert name + labels: the same alert on the same thing always gets the same fingerprint. */
export function alertFingerprint(labels: Record<string, string>): string {
  const canon = Object.keys(labels).sort().map(k => [k, labels[k]])
  const h = crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 16)
  return `alert:${labels.alertname ?? 'unknown'}:${h}`
}

export function toSeverity(label: string | undefined): Severity {
  const s = (label ?? '').toLowerCase()
  if (s === 'critical' || s === 'page' || s === 'error') return 'critical'
  if (s === 'info' || s === 'none') return 'info'
  return 'warning'
}

/**
 * Where an alert is, in words. A remote cluster's node carries hpx_node and hpx_cluster (its `node` label is
 * "name@clusterId", which means nothing to a person): "name (Cluster name)". A home node is its own name.
 */
export function placeOf(labels: Record<string, string>, clusterName: (id: string) => string | null = () => null): string {
  const cid = labels.hpx_cluster
  if (cid) {
    const node = labels.hpx_node || (labels.node ?? '').split('@')[0] || 'a server'
    return `${node} (${clusterName(cid) ?? 'a remote cluster'})`
  }
  if (labels.node) return labels.node
  if (labels.job) return `the ${labels.job} monitoring job`
  return 'HyperProx'
}

function humanise(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase())
}

function sentence(s: string): string {
  const t = s.trim()
  return t && !/[.!?]$/.test(t) ? `${t}.` : t
}

/** "11 Nov, 14:03". */
export function clock(d: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(d)
}

/** "3 min", "2 h 5 min", "1 day 4 h". */
export function duration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000))
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60), m = min % 60
  if (h < 24) return m ? `${h} h ${m} min` : `${h} h`
  const d = Math.floor(h / 24), hh = h % 24
  return `${d} day${d === 1 ? '' : 's'}${hh ? ` ${hh} h` : ''}`
}

/**
 * An alert's headline and its plain-English line. The rules carry both as annotations (`title` and `plain`)
 * so a rule's wording lives next to the rule, and the headline gets "on <place>" after it. An alert without
 * them falls back to its summary and description, with the raw node label swapped for the place.
 */
function wording(a: PromAlert, place: string): { title: string; plain: string } {
  const ann = a.annotations ?? {}
  const swap = (s: string) => (a.labels.node ? s.split(a.labels.node).join(place) : s).trim()
  const head = ann.title?.trim() || (ann.summary ? swap(ann.summary) : '') || humanise(a.labels.alertname ?? 'Alert')
  const title = head.includes(place) ? head : `${head} on ${place}`
  const plain = ann.plain?.trim() || (ann.description ? swap(ann.description) : '') || (ann.summary ? swap(ann.summary) : '') || head
  return { title, plain: sentence(plain) }
}

// --- The forwarder --------------------------------------------------------------------------------

export class AlertForwarder {
  private timer: NodeJS.Timeout | null = null
  private first: NodeJS.Timeout | null = null
  private running = false

  constructor(private d: ForwarderDeps) {}

  private now(): Date { return this.d.now ? this.d.now() : new Date() }
  private log(m: string): void { this.d.log?.(`[alerts] ${m}`) }

  /** One poll. Returns what happened, for tests and logs. */
  async tick(): Promise<{ fired: number; resolved: number; prometheus: 'ok' | 'down' }> {
    if (this.running) return { fired: 0, resolved: 0, prometheus: 'ok' }
    this.running = true
    try { return await this.poll() } finally { this.running = false }
  }

  private async poll(): Promise<{ fired: number; resolved: number; prometheus: 'ok' | 'down' }> {
    const now = this.now()
    const state = this.d.store.load()
    let alerts: PromAlert[]
    try {
      alerts = await this.d.fetchAlerts()
    } catch (e: any) {
      await this.prometheusDown(state, now, e?.name === 'TimeoutError' ? 'timed out' : (e?.code ?? e?.message ?? 'error'))
      this.save(state)
      return { fired: 0, resolved: 0, prometheus: 'down' }
    }

    let changed = false
    const p = state.prometheus
    if (p.announced && p.failingSince) {
      const since = new Date(p.failingSince)
      const ok = await this.send({
        type: 'alert.resolved', severity: 'warning', resolved: true, title: 'Monitoring is down',
        lines: ['Prometheus answers again, so alerts are being checked again.', `It was down for ${duration(now.getTime() - since.getTime())}, from ${clock(since, this.d.timeZone)}.`],
        link: '/monitoring', where: 'Monitoring page', fingerprint: 'alert:monitoring-down',
      })
      if (!ok) { this.save(state); return { fired: 0, resolved: 0, prometheus: 'ok' } }
    }
    if (!p.seenOk || p.failingSince || p.announced) changed = true
    state.prometheus = { seenOk: true, failingSince: null, announced: false }

    const skip = new Set(this.d.notForwarded ? this.d.notForwarded() : DEFAULT_NOT_FORWARDED)
    const names = this.d.clusterName ?? (() => null)
    // Pending counts as still there: after a Prometheus restart a firing alert comes back as pending until its
    // `for` passes again, and that is not a fix.
    const present = new Map<string, PromAlert>()
    for (const a of alerts) {
      if (!a?.labels || (a.state !== 'firing' && a.state !== 'pending')) continue
      const fp = alertFingerprint(a.labels)
      if (a.state === 'firing' || !present.has(fp)) present.set(fp, a)
    }

    let fired = 0, resolved = 0
    for (const [fp, a] of present) {
      if (a.state !== 'firing' || state.firing[fp] || skip.has(a.labels.alertname)) continue
      const place = placeOf(a.labels, names)
      const { title, plain } = wording(a, place)
      const severity = toSeverity(a.labels.severity)
      const since = a.activeAt && !Number.isNaN(Date.parse(a.activeAt)) ? new Date(a.activeAt) : now
      const ok = await this.send({
        type: 'alert.firing', severity, title,
        lines: [plain, `Where: ${place}`, `Since ${clock(since, this.d.timeZone)} (${duration(now.getTime() - since.getTime())} ago).`],
        plain: [place], link: '/monitoring', where: 'Monitoring page', fingerprint: fp,
        subject: { kind: 'alert', name: a.labels.alertname ?? 'alert' },
      })
      if (!ok) continue
      state.firing[fp] = { alertname: a.labels.alertname ?? 'alert', severity, title, place, since: since.toISOString() }
      fired++; changed = true
    }

    for (const [fp, was] of Object.entries(state.firing)) {
      if (present.has(fp)) continue
      // Put on the not-forwarded list while firing: forget it quietly rather than call it fixed.
      if (skip.has(was.alertname)) { delete state.firing[fp]; changed = true; continue }
      const since = new Date(was.since)
      const ok = await this.send({
        type: 'alert.resolved', severity: was.severity, resolved: true, title: was.title,
        lines: ['This has cleared.', `Where: ${was.place}`, `It lasted ${duration(now.getTime() - since.getTime())}, from ${clock(since, this.d.timeZone)}.`],
        plain: [was.place], link: '/monitoring', where: 'Monitoring page', fingerprint: fp,
        subject: { kind: 'alert', name: was.alertname },
      })
      if (!ok) continue
      delete state.firing[fp]
      resolved++; changed = true
    }

    if (changed) this.save(state)
    return { fired, resolved, prometheus: 'ok' }
  }

  private async prometheusDown(state: ForwarderState, now: Date, why: string): Promise<void> {
    const p = state.prometheus
    // An install without Prometheus (charts answered no) has never had it answer: nothing is down.
    if (!p.seenOk) return
    if (!p.failingSince) { p.failingSince = now.toISOString(); this.log(`Prometheus did not answer (${why})`); return }
    if (p.announced) return
    const since = new Date(p.failingSince)
    if (now.getTime() - since.getTime() < PROMETHEUS_DOWN_MS) return
    const ok = await this.send({
      type: 'alert.firing', severity: 'warning', title: 'Monitoring is down',
      lines: ["HyperProx cannot reach Prometheus, so alerts can't be checked.", `Since ${clock(since, this.d.timeZone)} (${duration(now.getTime() - since.getTime())} ago).`],
      link: '/monitoring', where: 'Monitoring page', fingerprint: 'alert:monitoring-down',
    })
    if (ok) p.announced = true
  }

  /** True when the bus took it. A failure is retried on the next poll, because nothing was recorded. */
  private async send(e: NotifyEventInput): Promise<boolean> {
    try { await this.d.publish(e); return true }
    catch (err: any) { this.log(`could not publish ${e.type}: ${err?.name ?? 'error'}`); return false }
  }

  private save(s: ForwarderState): void {
    try { this.d.store.save(s) } catch (e: any) { this.log(`could not save its state: ${e?.code ?? e?.name ?? 'error'}`) }
  }

  start(intervalMs = POLL_MS, firstDelayMs = 15_000): void {
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

/** The production forwarder: the bundled Prometheus, the notification bus, the cluster registry for names. */
export function productionAlertForwarder(log?: (m: string) => void): AlertForwarder {
  return new AlertForwarder({
    fetchAlerts: () => fetchPrometheusAlerts(),
    publish: e => busPublish(e),
    store: new FileForwarderState(),
    notForwarded: () => notForwardedFromEnv(),
    clusterName: id => getCluster(id)?.name ?? null,
    log,
  })
}
