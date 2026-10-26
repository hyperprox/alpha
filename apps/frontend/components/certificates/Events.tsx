'use client'

import type { CertsEvent } from '@hyperprox/types'
import { Badge, Empty, TH, THEAD_STYLE, fmtDateTime } from './ui'

export function EventsList({ events, labels, label, onLabel, error }: {
  events: CertsEvent[]; labels: string[]; label: string; onLabel: (l: string) => void; error: string | null
}) {
  return (
    <div>
      <div className="flex items-center gap-2 px-5 py-3">
        <label htmlFor="cert-event-filter" className="font-mono text-xs" style={{ color: 'var(--text-dimmer)' }}>CERTIFICATE</label>
        <select id="cert-event-filter" value={label} onChange={e => onLabel(e.target.value)}
                className="rounded-md border px-2 py-1 text-sm"
                style={{ background: 'var(--ground-inset)', borderColor: 'var(--border)', color: 'var(--text)' }}>
          <option value="">All</option>
          {labels.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      </div>
      {error ? <p className="px-5 pb-5 text-sm" style={{ color: 'var(--warn)' }}>{error}</p>
        : events.length === 0 ? <Empty>No events yet.</Empty> : (
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
      )}
    </div>
  )
}
