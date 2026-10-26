'use client'

import type { CertsHousekeepingItem } from '@hyperprox/types'
import { Btn, Empty, TH, THEAD_STYLE, fmtDate } from './ui'

export const KIND_LABEL: Record<CertsHousekeepingItem['kind'], string> = {
  'proxy-expired-unused': 'Expired, unused proxy certificate',
  'proxy-orphan-files': 'Renewal files the proxy no longer knows',
}

/** What applying does, in plain words; the confirm dialog shows the same text. */
export const KIND_EFFECT: Record<CertsHousekeepingItem['kind'], string> = {
  'proxy-expired-unused': 'Deletes it from the proxy. It is expired and attached to no host, so it can only fail to renew.',
  'proxy-orphan-files': 'Archives the files on the proxy. Nothing is deleted outright; they are moved aside and can be put back.',
}

export function HousekeepingList({ items, busy, onApply }: { items: CertsHousekeepingItem[]; busy: boolean; onApply: (i: CertsHousekeepingItem) => void }) {
  if (!items.length) return <Empty>Nothing to tidy. No expired, unattached proxy certificates were found.</Empty>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr style={THEAD_STYLE}>
            <th scope="col" className={TH}>ITEM</th>
            <th scope="col" className={TH}>DETAIL</th>
            <th scope="col" className={TH}>APPLYING WILL</th>
            <th scope="col" className={TH}><span className="sr-only">Action</span></th>
          </tr>
        </thead>
        <tbody>
          {items.map(i => (
            <tr key={i.id} className="align-top" style={{ borderBottom: '1px solid var(--border-dim)' }}>
              <td className="px-4 py-2.5">
                <div className="text-xs" style={{ color: 'var(--text-soft)' }}>{KIND_LABEL[i.kind]}</div>
                <div className="mt-0.5 font-mono text-xs" style={{ color: 'var(--text-bright)' }}>{i.names.join(', ') || '(no names)'}</div>
                {i.expiredAt && <div className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>expired {fmtDate(i.expiredAt)}</div>}
              </td>
              <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-muted)' }}>{i.detail}</td>
              <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-soft)' }}>{KIND_EFFECT[i.kind]}</td>
              <td className="px-4 py-2.5 text-right"><Btn small kind="danger" onClick={() => onApply(i)} disabled={busy}>Apply</Btn></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
