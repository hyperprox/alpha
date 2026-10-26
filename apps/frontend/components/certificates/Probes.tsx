'use client'

import type { CertsProbe } from '@hyperprox/types'
import { Badge, Btn, Empty, Icon, Reason, TH, THEAD_STYLE, VerdictBadge, fmtDate, fmtDateTime } from './ui'

const SOURCE: Record<CertsProbe['source'], string> = { policy: 'policy', proxy: 'proxy host', node: 'node', managed: 'deploy target' }

export function Probes({ probes, checking, onCheck }: { probes: CertsProbe[]; checking: Set<string>; onCheck: (p: CertsProbe) => void }) {
  if (!probes.length) return <Empty>No endpoints are being probed yet.</Empty>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr style={THEAD_STYLE}>
            <th scope="col" className={TH}>ENDPOINT</th>
            <th scope="col" className={TH}>STATUS</th>
            <th scope="col" className={TH}>ISSUER</th>
            <th scope="col" className={TH}>EXPIRES</th>
            <th scope="col" className={TH}>TRUSTED</th>
            <th scope="col" className={TH}>CHECKED</th>
            <th scope="col" className={TH}><span className="sr-only">Action</span></th>
          </tr>
        </thead>
        <tbody>
          {probes.map(p => {
            const key = `${p.host}:${p.port}`
            return (
              <tr key={key} className="align-top" style={{ borderBottom: '1px solid var(--border-dim)' }}>
                <td className="px-4 py-2.5">
                  <div className="font-mono text-xs" style={{ color: 'var(--text-bright)' }}>{key}</div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {p.starttls !== 'none' && <Badge tone="muted">STARTTLS {p.starttls}</Badge>}
                    <Badge tone="muted">{SOURCE[p.source]}</Badge>
                    {p.internal && <Badge tone="muted" title="Self-signed is expected here">internal</Badge>}
                  </div>
                </td>
                <td className="px-4 py-2.5" style={{ minWidth: 200 }}>
                  <VerdictBadge verdict={p.verdict} />
                  {p.reason && <Reason>{p.reason}</Reason>}
                </td>
                <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-soft)' }}>{p.issuer ?? '—'}</td>
                <td className="px-4 py-2.5 font-mono text-xs" style={{ color: 'var(--text-soft)' }}>{fmtDate(p.notAfter)}</td>
                <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-soft)' }}>
                  {p.trusted === null ? '—' : p.trusted ? 'yes' : <span style={{ color: 'var(--crit-2)' }}>no</span>}
                  {p.namesMatch === false && <div style={{ color: 'var(--crit-2)' }}>name mismatch</div>}
                </td>
                <td className="px-4 py-2.5 font-mono text-xs" style={{ color: 'var(--text-muted)' }}>{fmtDateTime(p.checkedAt)}</td>
                <td className="px-4 py-2.5 text-right">
                  <Btn small onClick={() => onCheck(p)} disabled={checking.has(key)} aria-label={`Check ${key}`}>
                    <Icon name="check" />{checking.has(key) ? 'Checking...' : 'Check'}
                  </Btn>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
