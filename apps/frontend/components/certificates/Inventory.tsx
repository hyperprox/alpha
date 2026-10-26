'use client'

import { useMemo, useState } from 'react'
import type { CertsInventoryEntry } from '@hyperprox/types'
import { Empty, SOURCE_LABEL, StagingBadge, TH, THEAD_STYLE, VERDICT_RANK, VerdictBadge, Reason, fmtDate, fmtDays } from './ui'

type Filter = 'all' | 'problems' | CertsInventoryEntry['source']

/** Share of the lifetime still left: green above a third, amber to a tenth, red below. */
function barColour(e: CertsInventoryEntry): string {
  if (e.daysLeft === null) return 'var(--text-dimmer)'
  if (e.daysLeft <= 7) return 'var(--crit-2)'
  const f = e.lifetimeDays ? e.daysLeft / e.lifetimeDays : 1
  return f > 0.33 ? 'var(--good)' : f > 0.1 ? 'var(--warn)' : 'var(--crit-2)'
}

function DaysBar({ e }: { e: CertsInventoryEntry }) {
  const f = e.daysLeft !== null && e.lifetimeDays ? Math.max(0, Math.min(1, e.daysLeft / e.lifetimeDays)) : 0
  return (
    <div className="min-w-[96px]">
      <div className="font-mono text-xs" style={{ color: 'var(--text-bright)' }}>{fmtDays(e.daysLeft)}</div>
      <div className="mt-1 h-1.5 w-24 overflow-hidden rounded-full" style={{ background: 'var(--ground-inset)' }}
           title={e.lifetimeDays ? `${fmtDays(e.daysLeft)} of ${e.lifetimeDays} days left, expires ${fmtDate(e.notAfter)}` : `expires ${fmtDate(e.notAfter)}`}>
        <div className="h-full rounded-full" style={{ width: `${f * 100}%`, background: barColour(e) }} />
      </div>
    </div>
  )
}

export function Inventory({ entries }: { entries: CertsInventoryEntry[] }) {
  const [filter, setFilter] = useState<Filter>('all')

  const sources = useMemo(() => Array.from(new Set(entries.map(e => e.source))), [entries])
  const problems = entries.filter(e => e.verdict !== 'ok').length

  const rows = useMemo(() => {
    const list = entries.filter(e => filter === 'all' ? true : filter === 'problems' ? e.verdict !== 'ok' : e.source === filter)
    return [...list].sort((a, b) =>
      VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] ||
      (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity))
  }, [entries, filter])

  const chips: { v: Filter; label: string; n: number }[] = [
    { v: 'all', label: 'All', n: entries.length },
    { v: 'problems', label: 'Problems', n: problems },
    ...sources.map(s => ({ v: s as Filter, label: SOURCE_LABEL[s], n: entries.filter(e => e.source === s).length })),
  ]

  if (!entries.length) return <Empty>No certificates found yet. Check now probes the proxy hosts and nodes.</Empty>

  return (
    <div>
      <div role="group" aria-label="Filter certificates" className="flex flex-wrap gap-2 px-5 py-3">
        {chips.map(c => (
          <button key={c.v} type="button" aria-pressed={filter === c.v} onClick={() => setFilter(c.v)}
                  className="rounded-md border px-2.5 py-1 font-mono text-xs transition-colors"
                  style={filter === c.v
                    ? { background: 'var(--accent)', color: 'var(--accent-ink)', borderColor: 'var(--accent)', fontWeight: 600 }
                    : { background: 'transparent', color: 'var(--text-muted)', borderColor: 'var(--border)' }}>
            {c.label} {c.n}
          </button>
        ))}
      </div>
      {rows.length === 0 ? <Empty>Nothing matches this filter.</Empty> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={THEAD_STYLE}>
                <th scope="col" className={TH}>NAMES</th>
                <th scope="col" className={TH}>SOURCE</th>
                <th scope="col" className={TH}>ISSUER</th>
                <th scope="col" className={TH}>DAYS LEFT</th>
                <th scope="col" className={TH}>RENEWS</th>
                <th scope="col" className={TH}>STATUS</th>
                <th scope="col" className={TH}>USED BY</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(e => (
                <tr key={e.id} className="align-top" style={{ borderBottom: '1px solid var(--border-dim)' }}>
                  <td className="px-4 py-2.5">
                    <div className="font-mono text-xs" style={{ color: 'var(--text-bright)' }} title={e.names.join('\n')}>
                      {e.names[0] ?? '(no names)'}
                      {e.names.length > 1 && <span style={{ color: 'var(--text-muted)' }}> +{e.names.length - 1}</span>}
                    </div>
                    {e.staging && <div className="mt-1"><StagingBadge /></div>}
                  </td>
                  <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-soft)' }}>{SOURCE_LABEL[e.source]}</td>
                  <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-soft)' }}>
                    {e.issuer ?? '—'}{e.selfSigned && <span style={{ color: 'var(--warn)' }}> (self-signed)</span>}
                  </td>
                  <td className="px-4 py-2.5"><DaysBar e={e} /></td>
                  <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-soft)' }}>{e.renewal}</td>
                  <td className="px-4 py-2.5" style={{ minWidth: 200 }}>
                    <VerdictBadge verdict={e.verdict} />
                    {e.reason && <Reason>{e.reason}</Reason>}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
                    {e.usedBy.length === 0 ? '—' : (
                      <span title={e.usedBy.join('\n')}>
                        {e.usedBy.slice(0, 2).join(', ')}{e.usedBy.length > 2 && ` +${e.usedBy.length - 2}`}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
