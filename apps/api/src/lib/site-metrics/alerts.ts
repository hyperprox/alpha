// =============================================================================
//  HyperProx — site metrics: alerts through the notification bus
//
//  Four conditions per site, each told once when it starts and once when it
//  clears (family "resources", the same as Prometheus's alerts, with a stable
//  fingerprint so quiet hours can cancel a pair):
//    down      the public check failed `downChecks` times in a row
//    errors    5xx responses above `errorRatePct` of the last hour's requests
//              (at least 20 requests, so one failure on a quiet site is not news)
//    cert      the certificate has fewer than `certDays` days left
//    spike     the last hour had `spikeFactor` times the usual hourly requests
//              (the average of the 7 days before it, and at least 100 requests)
//  Settings are per site (Metrics tab → Alerts), with the defaults in store.ts.
// =============================================================================

import type { NotifyEventInput } from '../notify/types'
import type { SiteRecord } from '../sites'
import type { Agg } from './aggregate'
import { certDaysLeft } from './health'
import type { SiteState } from './store'

export type AlertKind = 'down' | 'errors' | 'cert' | 'spike'
export const ALERT_KINDS: AlertKind[] = ['down', 'errors', 'cert', 'spike']
export const MIN_REQUESTS_FOR_RATE = 20
export const MIN_REQUESTS_FOR_SPIKE = 100

export interface AlertInputs {
  /** The hour in progress when it already has enough requests, else the last complete hour: for the error rate. */
  recent: Agg | null
  /** The last complete hour: for the spike. */
  lastHour: Agg | null
  /** Average requests per hour over the 7 days before the last hour, or null without enough history. */
  usualPerHour: number | null
  now: number
}

/** Which conditions hold now, each with a sentence saying why. */
export function evaluate(st: SiteState, i: AlertInputs): Partial<Record<AlertKind, string>> {
  const a = st.alerts, out: Partial<Record<AlertKind, string>> = {}
  if (!a.enabled) return out
  if (a.downChecks > 0 && st.health.failsInRow >= a.downChecks) {
    out.down = `The public check failed ${st.health.failsInRow} times in a row (${st.health.lastProblem ?? 'no answer'}).`
  }
  const r = i.recent
  if (r && r.requests >= MIN_REQUESTS_FOR_RATE && a.errorRatePct > 0) {
    const pct = (r.s5xx / r.requests) * 100
    if (pct > a.errorRatePct) out.errors = `${pct.toFixed(1)}% of the last ${r.requests} requests were server errors (5xx); the limit is ${a.errorRatePct}%.`
  }
  const h = i.lastHour
  const days = certDaysLeft(st.health, i.now)
  if (days !== null && a.certDays > 0 && days < a.certDays) out.cert = days < 0 ? 'The certificate has expired.' : `The certificate expires in ${days} day${days === 1 ? '' : 's'}.`
  if (h && a.spikeFactor > 0 && i.usualPerHour !== null && h.requests >= MIN_REQUESTS_FOR_SPIKE && h.requests > a.spikeFactor * Math.max(1, i.usualPerHour)) {
    out.spike = `${h.requests} requests in the last hour, ${Math.round(h.requests / Math.max(1, i.usualPerHour))}× the usual ${Math.round(i.usualPerHour)}.`
  }
  return out
}

const TITLES: Record<AlertKind, [string, string]> = {
  down: ['is down', 'is back up'],
  errors: ['is answering with server errors', 'server errors are back to normal'],
  cert: ['certificate expires soon', 'certificate renewed'],
  spike: ['has a traffic spike', 'traffic is back to normal'],
}
const SEVERITY: Record<AlertKind, NotifyEventInput['severity']> = { down: 'critical', errors: 'warning', cert: 'warning', spike: 'info' }

export function fingerprint(siteId: string, kind: AlertKind): string { return `site:${siteId}:${kind}` }

/**
 * Compare with what was announced, publish each change, and return the new alert state. A publish that fails
 * leaves that alert as it was, so it is tried again next time.
 */
export async function announce(site: SiteRecord, st: SiteState, now: Partial<Record<AlertKind, string>>, publish: (e: NotifyEventInput) => Promise<void>, at: number): Promise<SiteState['alertState']> {
  const state = { ...st.alertState }
  const link = `/sites/${encodeURIComponent(site.id)}`
  const name = site.domain ?? site.name
  for (const kind of ALERT_KINDS) {
    const was = state[kind], is = now[kind]
    if (is && !was) {
      try {
        await publish({ type: 'alert.firing', severity: SEVERITY[kind], title: `${name} ${TITLES[kind][0]}`, lines: [is],
          link, where: 'Sites page', fingerprint: fingerprint(site.id, kind), subject: { kind: 'site', name }, plain: [name] })
        state[kind] = { since: at, detail: is }
      } catch { /* retried next tick */ }
    } else if (!is && was) {
      try {
        const mins = Math.max(1, Math.round((at - was.since) / 60_000))
        await publish({ type: 'alert.resolved', resolved: true, severity: SEVERITY[kind], title: `${name} ${TITLES[kind][1]}`,
          lines: [`This has cleared after ${mins} min.`], link, where: 'Sites page', fingerprint: fingerprint(site.id, kind),
          subject: { kind: 'site', name }, plain: [name] })
        delete state[kind]
      } catch { /* retried next tick */ }
    } else if (is && was) state[kind] = { ...was, detail: is }
  }
  return state
}
