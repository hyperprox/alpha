// =============================================================================
//  HyperProx — one place that says how healthy a cluster is
//
//  The cluster line, the Status answer and the "how is everything" roll-call all
//  read health from here, so they cannot disagree: one says Ceph warns while
//  another says nothing needs attention. A Ceph warning the person has accepted
//  elsewhere in HyperProx (the Updates policy's ceph.accepted_warnings, or a
//  check muted in Ceph itself) is a "known warning" everywhere, never a problem
//  in one answer and fine in the next. Pure: no I/O.
// =============================================================================

import type { ClusterPanel } from '../clusters/overview'

/** One Ceph health check: its code, Ceph's own one-line summary, and whether the person has accepted it. */
export interface CephCheck { code: string; message: string; known: boolean }

/** What health needs from the cluster summary (lib/ai/ask-sources.ts ClusterSummary). */
export interface HealthFacts {
  nodes: Array<{ node: string; online: boolean }>
  ceph: string | null
  cephChecks?: CephCheck[]
  ha: { total: number; problems: string[] } | null
  partial: string[]
}

export interface Health {
  /** Things that need the person's attention, in plain words, most serious first. */
  problems: string[]
  /** Warnings the person already accepted, in plain words. */
  known: string[]
  /** Ceph in a few words: "Ceph healthy", "Ceph has a known warning", "Ceph HEALTH_WARN"; null with no Ceph. */
  ceph: string | null
  /** Ceph's warnings are all accepted ones (so a Ceph health alert is a known one too). */
  cephKnownOnly: boolean
}

const BACKUP_WORDS = /\bbackup\b/i

/** Ceph's checks from /cluster/ceph/status, each marked known when accepted in HyperProx or muted in Ceph. */
export function cephChecksOf(status: any, accepted: string[]): CephCheck[] {
  const checks = status?.health?.checks
  if (!checks || typeof checks !== 'object') return []
  const mutes = new Set((Array.isArray(status?.health?.mutes) ? status.health.mutes : []).map((m: any) => String(m?.code ?? '')))
  return Object.entries(checks).map(([code, c]: [string, any]) => ({
    code,
    message: String(c?.summary?.message ?? code).replace(/\s+/g, ' ').trim().slice(0, 120),
    known: accepted.includes(code) || c?.muted === true || mutes.has(code),
  }))
}

/**
 * The cluster's health from the summary and, when there is one, the Command center panel. `skipBackups`: leave the
 * panel's backup items out (the roll-call has its own Backups line).
 */
export function clusterHealth(s: HealthFacts | null, panel?: ClusterPanel | null, o: { skipBackups?: boolean } = {}): Health {
  const problems: string[] = []
  const known: string[] = []
  const offline = new Set<string>()
  const haveNodes = !!s && !s.partial.includes('resources')
  if (haveNodes) for (const n of s!.nodes) if (!n.online) offline.add(n.node)
  if (offline.size) problems.push(`${offline.size === 1 ? 'node' : 'nodes'} ${[...offline].join(', ')} ${offline.size === 1 ? 'is' : 'are'} offline`)
  if (s?.ha?.problems.length) problems.push(`HA reports trouble with ${s.ha.problems.join(', ')}`)

  let ceph: string | null = null
  let cephKnownOnly = false
  if (s?.ceph) {
    const checks = s.cephChecks ?? []
    const open = checks.filter(c => !c.known)
    if (s.ceph === 'HEALTH_OK') ceph = 'Ceph healthy'
    else if (checks.length && !open.length) {
      ceph = 'Ceph has a known warning'
      cephKnownOnly = true
      known.push(...checks.map(c => c.message))
    } else {
      ceph = `Ceph ${s.ceph}`
      for (const c of checks.filter(c => c.known)) known.push(c.message)
      problems.push(open.length ? `Ceph: ${open.map(c => c.message).join('; ')}` : `Ceph reports ${s.ceph}`)
    }
  }

  for (const a of panel?.attention ?? []) {
    if (a.severity === 'info') continue
    if (o.skipBackups && BACKUP_WORDS.test(a.title)) continue
    // Already said from the summary: an offline node.
    if (haveNodes && /^Node .+ is offline$/.test(a.title)) continue
    const t = a.title.charAt(0).toLowerCase() + a.title.slice(1)
    if (!problems.includes(t)) problems.push(t)
  }
  return { problems, known, ceph, cephKnownOnly }
}

/** "nothing needs attention", "2 things need attention: …", with any known warning named after. */
export function healthWords(h: Health): string {
  const head = h.problems.length
    ? `${h.problems.length === 1 ? '1 thing needs' : `${h.problems.length} things need`} attention: ${h.problems.join('; ')}`
    : 'nothing needs attention'
  return h.known.length ? `${head} (known warning: ${h.known.join('; ')})` : head
}
