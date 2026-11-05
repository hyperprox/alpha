'use client'

// "Home node", in plain words. The person picks nodes in order; the priority weights PVE wants are
// generated from that order and shown only under Advanced.

import { useState } from 'react'
import { Btn, Note, SELECT, mix } from './ui'
import type { HomeChoice, HomeMode } from './types'

export function weightsOf(tiers: string[][]): string {
  const t = tiers.filter(x => x.length)
  if (t.length <= 1) return (t[0] ?? []).join(',') || '(none)'
  return t.flatMap((x, i) => x.map(n => `${n}:${t.length - i}`)).join(',')
}

const MODES: Array<{ mode: HomeMode; title: string; words: string }> = [
  { mode: 'none', title: 'No home', words: 'After a failover it stays wherever it lands, indefinitely.' },
  { mode: 'prefer', title: 'Prefer a node, but run anywhere if needed', words: 'It runs on your first choice when that is up, moves back to it when it returns, and runs anywhere else rather than staying off.' },
  { mode: 'only', title: 'Only ever run on these nodes, even if that means staying off', words: 'Use this only when the guest is useless anywhere else (it needs that node\'s GPU, disks or USB device). If those nodes are down, it does not start.' },
]

export function HomePicker({ value, nodes, mustBeEqual, onChange }: {
  value: HomeChoice
  nodes: Array<{ node: string; online: boolean; maintenance: boolean }>
  /** The guest is kept together with or apart from another guest: Proxmox allows no first/second choice. */
  mustBeEqual: boolean
  onChange: (v: HomeChoice) => void
}) {
  const [advanced, setAdvanced] = useState(false)
  // Flatten tiers into an ordered list, remembering which entries tie with the one above.
  const order = value.tiers.flat()
  const tieAbove = new Set<string>()
  value.tiers.forEach(t => t.slice(1).forEach(n => tieAbove.add(n)))
  const rebuild = (list: string[], ties: Set<string>): string[][] => {
    const tiers: string[][] = []
    for (const n of list) { if (tiers.length && (ties.has(n) || mustBeEqual)) tiers[tiers.length - 1].push(n); else tiers.push([n]) }
    return tiers
  }
  const set = (list: string[], ties = tieAbove) => onChange({ ...value, tiers: rebuild(list, ties) })
  const unused = nodes.filter(n => !order.includes(n.node))
  const label = (i: number) => {
    if (mustBeEqual) return 'equal choice'
    let rank = 0
    for (let k = 0; k <= i; k++) if (k === 0 || !tieAbove.has(order[k])) rank++
    return ['first choice', 'second choice', 'third choice', 'fourth choice', 'fifth choice'][rank - 1] ?? `choice ${rank}`
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2" role="radiogroup" aria-label="Home node">
        {MODES.map(m => (
          <label key={m.mode} className="flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2"
            style={{ borderColor: value.mode === m.mode ? (m.mode === 'only' ? 'var(--crit)' : 'var(--accent)') : 'var(--border)', background: value.mode === m.mode ? mix(m.mode === 'only' ? 'var(--crit)' : 'var(--accent)', 6) : 'transparent' }}>
            <input type="radio" className="mt-1" checked={value.mode === m.mode}
              onChange={() => onChange({ mode: m.mode, tiers: m.mode === 'none' ? [] : value.tiers.length ? value.tiers : [] })} />
            <span>
              <span className="block text-[15px]" style={{ color: 'var(--text-bright)' }}>{m.title}</span>
              <span className="block text-sm" style={{ color: m.mode === 'only' ? 'var(--crit-soft)' : 'var(--text-muted)' }}>{m.words}</span>
            </span>
          </label>
        ))}
      </div>

      {value.mode !== 'none' && (
        <div className="space-y-2">
          {order.map((n, i) => {
            const info = nodes.find(x => x.node === n)
            return (
              <div key={n} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2" style={{ borderColor: 'var(--border)', background: 'var(--ground-inset)' }}>
                <span className="w-28 font-mono text-xs uppercase" style={{ color: 'var(--accent)' }}>{label(i)}</span>
                <span className="flex-1 text-[15px]" style={{ color: 'var(--text-bright)' }}>
                  {n} {info && !info.online && <span className="text-xs" style={{ color: 'var(--crit-soft)' }}>(offline)</span>}
                  {info?.maintenance && <span className="text-xs" style={{ color: 'var(--warn)' }}> (maintenance)</span>}
                </span>
                {advanced && i > 0 && !mustBeEqual && (
                  <label className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                    <input type="checkbox" checked={tieAbove.has(n)} onChange={e => { const t = new Set(tieAbove); e.target.checked ? t.add(n) : t.delete(n); set(order, t) }} />
                    same as above
                  </label>
                )}
                <Btn small disabled={i === 0} aria-label={`Move ${n} up`} onClick={() => { const l = [...order]; [l[i - 1], l[i]] = [l[i], l[i - 1]]; set(l) }}>↑</Btn>
                <Btn small disabled={i === order.length - 1} aria-label={`Move ${n} down`} onClick={() => { const l = [...order]; [l[i + 1], l[i]] = [l[i], l[i + 1]]; set(l) }}>↓</Btn>
                <Btn small aria-label={`Remove ${n}`} onClick={() => set(order.filter(x => x !== n))}>✕</Btn>
              </div>
            )
          })}
          {unused.length > 0 && (
            <select aria-label="Add a node" value="" style={SELECT} onChange={e => e.target.value && set([...order, e.target.value])}>
              <option value="">{order.length ? 'Add another choice…' : 'Pick a node…'}</option>
              {unused.map(n => <option key={n.node} value={n.node}>{n.node}{n.online ? '' : ' (offline)'}</option>)}
            </select>
          )}
          {mustBeEqual && order.length > 1 && <Note tone="info">This guest is kept together with or apart from another guest, so Proxmox allows no first and second choice: every node you pick is an equal choice.</Note>}
          <button type="button" className="font-mono text-xs underline" style={{ color: 'var(--text-dim)' }} onClick={() => setAdvanced(a => !a)}>
            {advanced ? 'Hide advanced' : 'Advanced'}
          </button>
          {advanced && <p className="font-mono text-xs" style={{ color: 'var(--text-soft)' }}>Proxmox priorities: {weightsOf(value.tiers)} · strict={value.mode === 'only' ? 1 : 0}</p>}
        </div>
      )}
    </div>
  )
}
