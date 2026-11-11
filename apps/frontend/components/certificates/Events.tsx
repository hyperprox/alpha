'use client'

import type { CertsEvent } from '@hyperprox/types'
import type { ReactNode } from 'react'
import { Badge, Empty, TH, THEAD_STYLE, fmtDateTime } from './ui'
import { Details, Feed, type FeedTone } from '@/components/visual/kit'

export function EventsList({ events, labels, label, onLabel, error, feed }: {
  events: CertsEvent[]; labels: string[]; label: string; onLabel: (l: string) => void; error: string | null
  /** The newest events as feed rows; the full table sits folded underneath. */
  feed: Array<{ key: string; title: ReactNode; detail?: ReactNode; meta?: ReactNode; tone?: FeedTone }>
}) {
  return (
    <div>
      <div className="flex items-center gap-2 pb-3">
        <label htmlFor="cert-event-filter" className="font-mono text-xs" style={{ color: 'var(--text-dim)' }}>CERTIFICATE</label>
        <select id="cert-event-filter" value={label} onChange={e => onLabel(e.target.value)}
                className="rounded-md border px-2 py-1 text-sm"
                style={{ background: 'var(--ground-deep)', borderColor: 'var(--border)', color: 'var(--text)' }}>
          <option value="">All</option>
          {labels.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      </div>
      {error ? <p className="text-sm" style={{ color: 'var(--warn)' }}>{error}</p>
        : events.length === 0 ? <Empty>No events yet.</Empty> : (
        <>
        <Feed items={feed} label="Recent certificate events" />
        <div className="mt-3" />
        <Details summary="Event table" sub={`${events.length} events`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={THEAD_STYLE}>
                <th scope="col" className={TH}>WHEN</th>
                <th scope="col" className={TH}>CERTIFICATE</th>
                <th scope="col" className={TH}>KIND</th>
                <th scope="col" className={TH}>RESULT</th>
                <th scope="col" className={TH}>DETAIL</th>
              </tr>
            </thead>
            <tbody>
              {events.map(e => (
                <tr key={e.id} className="align-top" style={{ borderBottom: '1px solid var(--border-dim)' }}>
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs" style={{ color: 'var(--text-soft)' }}>{fmtDateTime(e.at)}</td>
                  <td className="px-4 py-2.5 font-mono text-xs" style={{ color: 'var(--text-bright)' }}>{e.label ?? '—'}</td>
                  <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-soft)' }}>{e.kind}</td>
                  <td className="px-4 py-2.5"><Badge tone={e.ok ? 'good' : 'crit'}>{e.ok ? 'ok' : 'failed'}</Badge></td>
                  <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </Details>
        </>
      )}
    </div>
  )
}
