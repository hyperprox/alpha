// =============================================================================
//  HyperProx — "how is everything": the status roll-call, said by code
//
//  What needs attention first, then everything else at one line per area, then
//  what could not be read and why. The cluster is said once, with its health
//  from lib/ai/health.ts, so no line contradicts another; a warning the person
//  accepted is a "known warning" here as everywhere. Areas that repeat another
//  (the per-guest load balancing view beside the balance) or are lists rather
//  than health (site figures, the hardware scan) are not in it. Pure: no I/O.
// =============================================================================

import type { AskSource, SourceSummary } from './ask'
import type { ClusterSummary } from './ask-sources'
import type { ClusterPanel } from '../clusters/overview'
import type { AlertRow } from './home-sources'
import { clusterHealth, healthWords } from './health'

export interface LoadedSource {
  s: AskSource
  sum: SourceSummary
  /** ok: read now; cached: an earlier reading, the source was slow; pending: slow, nothing earlier; failed: a real failure. */
  state: 'ok' | 'cached' | 'pending' | 'failed'
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`
const clock = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
const stop = (s: string) => s.replace(/[.\s]+$/, '')

/**
 * Words in a headline that mean a problem, for areas that do not say it themselves: "1 needs attention", "2 failing",
 * "3 errors", "not answering". A zero count never is.
 */
export function headlineNeedsAttention(headline: string): boolean {
  const h = headline.toLowerCase()
  if (/\b(needs?|need) attention\b|\bhas a problem\b|\bnot answering\b|\bnot reachable\b|\bunreachable\b|\bover 90% full\b|\bcannot be read\b/.test(h)) return true
  const re = /\b(\d+)\s+(errors?|failed|failing|unavailable|offline|down|critical|not answering)\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(h))) if (Number(m[1]) > 0) return true
  return false
}

/** The roll-call text. `now` for the "as of" of a cached reading. */
export function rollCallText(loaded: LoadedSource[], now = Date.now()): string {
  const byId = (id: string) => loaded.find(l => l.s.id === id)
  const cluster = byId('cluster'), status = byId('status')
  const summary = cluster && cluster.state !== 'pending' && cluster.state !== 'failed' && !cluster.sum.locked ? (cluster.sum.data as ClusterSummary | undefined) ?? null : null
  const panel = status && status.state !== 'pending' && status.state !== 'failed' ? (status.sum.data as ClusterPanel | undefined) ?? null : null
  const usablePanel = panel && panel.reachable ? panel : null
  const health = clusterHealth(summary && !summary.partial.includes('resources') ? summary : null, usablePanel, { skipBackups: true })

  const attention: string[] = []
  const rest: string[] = []
  const locked: string[] = [], quiet: string[] = [], pending: string[] = [], failed: string[] = []
  const asOf = (l: LoadedSource) => (l.sum.asOf && now - l.sum.asOf > 3 * 60_000 ? ` (as of ${clock(l.sum.asOf)})` : '')

  // The cluster, once.
  if (summary && !summary.partial.includes('resources')) {
    const parts = [`${summary.nodes.filter(n => n.online).length}/${summary.nodes.length} nodes online`, `${summary.guests.filter(g => g.running).length}/${summary.guests.length} guests running`]
    if (health.ceph) parts.push(health.ceph)
    ;(health.problems.length ? attention : rest).push(`Cluster: ${parts.join(', ')}; ${healthWords(health)}.`)
  } else if (usablePanel) {
    const line = `Cluster: ${usablePanel.nodes.online}/${usablePanel.nodes.total} nodes online, ${usablePanel.guests.running}/${usablePanel.guests.total} guests running; ${healthWords(health)}.`
    ;(health.problems.length ? attention : rest).push(line)
  } else if (cluster || status) {
    const why = [cluster, status].filter(Boolean).map(l => l!.sum.unread?.[0]).find(Boolean)
    failed.push(`the cluster${why ? ` (${why.replace(/^[^(]*\(/, '').replace(/\)$/, '')})` : ''}`)
  }

  for (const l of loaded) {
    if (l.s.id === 'cluster' || l.s.id === 'status' || l.s.overview === false) continue
    const { s, sum } = l
    if (sum.locked) { locked.push(s.title); continue }
    if (l.state === 'pending') { pending.push(s.title); continue }
    if (l.state === 'failed') { failed.push(`${s.title}${sum.unread?.[0] ? ` (${sum.unread[0].replace(/^[^(]*\(/, '').replace(/\)$/, '')})` : ''}`); continue }
    if (sum.noSummary) { quiet.push(s.title); continue }

    // Alerts: a Ceph health alert for a warning the person accepted is a known one, as on the cluster line.
    let problems = sum.attention
    if (s.id === 'alerts') {
      const rows = ((sum.data as { rows?: AlertRow[] })?.rows ?? []).filter(r => r.state === 'firing')
      const open = rows.filter(r => !r.muted && !(health.cephKnownOnly && /^CephHealth/i.test(r.name)))
      const knownN = rows.length - open.length
      if (rows.length) {
        const line = open.length
          ? `Alerts: ${plural(open.length, 'alert')} firing: ${open.slice(0, 4).map(r => stop(r.title)).join('; ')}${knownN ? ` (and ${knownN} known)` : ''}.`
          : `Alerts: ${plural(knownN, 'known alert')} firing, nothing new.`
        ;(open.length ? attention : rest).push(line)
        continue
      }
      problems = []
    }
    const bad = problems ? problems.length > 0 : headlineNeedsAttention(sum.headline)
    const line = `${stop(sum.headline)}${asOf(l)}.`
    if (bad) attention.push(problems?.length ? `${stop(sum.headline)}: ${problems.map(stop).join('; ')}${asOf(l)}.` : line)
    else rest.push(line)
  }

  const out: string[] = []
  if (attention.length) out.push('Needs attention:', ...attention.map(a => `- ${a}`), '', 'Everything else:')
  else out.push(failed.length || pending.length ? 'Nothing needs attention in what I could read.' : 'Nothing needs attention.', '')
  out.push(...[...new Set(rest)])
  if (quiet.length) out.push(`Connected, with nothing to report: ${quiet.join(', ')}.`)
  if (locked.length) out.push(`Locked (unlock HyperProx to read): ${locked.join(', ')}.`)
  if (pending.length) out.push(`Still being read, because ${pending.length === 1 ? 'it is' : 'they are'} slow to answer: ${pending.join(', ')}. Ask again in a minute.`)
  if (failed.length) out.push(`Could not read: ${failed.join('; ')}.`)
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
