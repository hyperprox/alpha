'use client'

// =============================================================================
//  HyperProx — site metrics: the drawn pieces
//
//  A sparkline, the traffic chart (people and bots, crosshair and tooltip on
//  hover or touch, values labelled at the line ends, a legend, and the same
//  numbers as a table underneath), bar lists, a 100% stacked bar with a
//  labelled legend, response rows with an icon and a word for each status, and
//  ring gauges. Series are --chart-1/2/3; text never takes a series colour.
// =============================================================================

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useReducedMotion } from '@/components/visual/kit'
import s from './metrics.module.css'

export const SERIES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)']

export function SparkLine({ data, label }: { data: number[]; label?: string }) {
  const w = 120, h = 34
  const m = Math.max(1, ...data)
  const pts = data.map((y, i) => `${((i / Math.max(1, data.length - 1)) * w).toFixed(1)},${(h - 2 - (y / m) * (h - 6)).toFixed(1)}`).join(' ')
  return (
    <svg className={s.spark} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <polyline points={pts} fill="none" stroke="var(--chart-1)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

function niceTop(v: number): number {
  if (v <= 0) return 4
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  const top = Math.ceil(v / p) * p
  return top < 4 ? 4 : top
}

export interface TrafficPoint { at: number; people: number; bots: number }

export function TrafficChart({ points, label, when }: { points: TrafficPoint[]; label: string; when: (at: number) => string }) {
  const wrap = useRef<HTMLDivElement>(null)
  const [W, setW] = useState(800)
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const on = () => setW(Math.max(280, el.clientWidth))
    on()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(on) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [])
  const H = 240, L = 40, R = 12, T = 14, B = 28
  const n = points.length
  const people = points.map(p => p.people), bots = points.map(p => p.bots)
  const top = niceTop(Math.max(...people, ...bots, 0) * 1.15)
  const x = (i: number) => L + (n <= 1 ? 0 : (i / (n - 1)) * (W - L - R))
  const y = (v: number) => T + (1 - v / top) * (H - T - B)
  const line = (v: number[]) => v.map((d, i) => `${x(i)},${y(d)}`).join(' ')
  const step = Math.max(1, Math.ceil(n / 7))
  const pick = (clientX: number) => {
    const el = wrap.current
    if (!el || !n) return
    const b = el.getBoundingClientRect()
    const px = ((clientX - b.left) * W) / b.width
    setHover(Math.max(0, Math.min(n - 1, Math.round(((px - L) / (W - L - R)) * (n - 1)))))
  }
  if (!n) return <p className={s.note}>No traffic counted yet.</p>
  const last = n - 1
  return (
    <>
      <div className={s.chart} ref={wrap}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}
          onPointerMove={e => pick(e.clientX)} onPointerDown={e => pick(e.clientX)} onPointerLeave={() => setHover(null)}>
          {[0, 0.25, 0.5, 0.75, 1].map(f => (
            <g key={f}>
              <line x1={L} x2={W - R} y1={y(top * f)} y2={y(top * f)} stroke="var(--border)" strokeOpacity=".6" />
              <text x={L - 6} y={y(top * f) + 4} textAnchor="end" fontFamily="var(--font-mono)" fontSize="10" fill="var(--text-muted)">{Math.round(top * f)}</text>
            </g>
          ))}
          {points.map((p, i) => (i % step === 0 || i === last) && (
            <text key={p.at} x={x(i)} y={H - 8} textAnchor="middle" fontFamily="var(--font-mono)" fontSize="10" fill="var(--text-muted)">{when(p.at)}</text>
          ))}
          <path d={`M${x(0)},${y(0)} ${people.map((d, i) => `L${x(i)},${y(d)}`).join(' ')} L${x(last)},${y(0)} Z`} fill="var(--chart-1)" opacity=".12" />
          <polyline points={line(bots)} fill="none" stroke="var(--chart-2)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          <polyline points={line(people)} fill="none" stroke="var(--chart-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          <text x={x(last) - 6} y={y(people[last]) - 8} textAnchor="end" fontFamily="var(--font-mono)" fontSize="11" fill="var(--text)">People {people[last]}</text>
          <text x={x(last) - 6} y={Math.min(H - B - 4, y(bots[last]) + 16)} textAnchor="end" fontFamily="var(--font-mono)" fontSize="11" fill="var(--text-soft)">Bots {bots[last]}</text>
          {hover !== null && (
            <g aria-hidden>
              <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="var(--border-strong)" strokeDasharray="3 3" />
              <circle cx={x(hover)} cy={y(bots[hover])} r="5" fill="var(--chart-2)" stroke="var(--surface)" strokeWidth="2" />
              <circle cx={x(hover)} cy={y(people[hover])} r="5" fill="var(--chart-1)" stroke="var(--surface)" strokeWidth="2" />
            </g>
          )}
        </svg>
        {hover !== null && (
          <div className={s.tip} style={{ left: `${(x(hover) / W) * 100}%`, top: `${(Math.min(y(people[hover]), y(bots[hover])) / H) * 100}%` }} aria-hidden>
            <div>{when(points[hover].at)}</div>
            <span><i style={{ background: 'var(--chart-1)' }} />People {people[hover]}</span><br />
            <span><i style={{ background: 'var(--chart-2)' }} />Bots {bots[hover]}</span>
          </div>
        )}
      </div>
      <details className={s.tbl}>
        <summary>Show as a table</summary>
        <div className={s.tw}>
          <table>
            <thead><tr><th>When</th><th>People</th><th>Bots</th></tr></thead>
            <tbody>{points.map(p => <tr key={p.at}><td>{when(p.at)}</td><td>{p.people}</td><td>{p.bots}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
    </>
  )
}

export function Bars({ items, label, empty = 'Nothing yet.', color = 'var(--chart-1)' }: { items: Array<{ key: string; value: number; text?: string }>; label: string; empty?: string; color?: string }) {
  const reduced = useReducedMotion()
  if (!items.length) return <p className={s.note}>{empty}</p>
  const m = Math.max(1, ...items.map(i => i.value))
  return (
    <ul className={s.bars} aria-label={label}>
      {items.map((it, i) => (
        <li key={it.key} className={s.bar}>
          <span title={it.key}>{it.key}</span>
          <em>{it.text ?? it.value}</em>
          <div className={s.track} aria-hidden><u style={{ width: `${(it.value / m) * 100}%`, background: color, animationDelay: reduced ? undefined : `${i * 50}ms` }} /></div>
        </li>
      ))}
    </ul>
  )
}

export function StackBar({ items, label }: { items: Array<{ key: string; pct: number }>; label: string }) {
  if (!items.length) return <p className={s.note}>No people counted yet.</p>
  const shown = items.slice(0, 3)
  return (
    <>
      <div className={s.stack} role="img" aria-label={`${label}: ${shown.map(i => `${i.key} ${i.pct}%`).join(', ')}`}>
        {shown.map((it, i) => <i key={it.key} style={{ width: `${it.pct}%`, background: SERIES[i] }} title={`${it.key} ${it.pct}%`} />)}
      </div>
      <ul className={s.slegend} aria-hidden>
        {shown.map((it, i) => <li key={it.key}><i style={{ background: SERIES[i] }} />{it.key}<b>{it.pct}%</b></li>)}
      </ul>
    </>
  )
}

const ICONS: Record<'good' | 'info' | 'warn' | 'crit', ReactNode> = {
  good: <path d="M5 12l4 4 10-10" />,
  info: <path d="M5 12h14M13 6l6 6-6 6" />,
  warn: <path d="M12 8v5M12 17h.01" />,
  crit: <path d="M6 6l12 12M18 6 6 18" />,
}
export const TONE_COLOR = { good: 'var(--good)', info: 'var(--text-muted)', warn: 'var(--warn)', crit: 'var(--crit)' }

export function StatusIcon({ tone }: { tone: keyof typeof ICONS }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden style={{ color: TONE_COLOR[tone] }}>{ICONS[tone]}</svg>
}

export function StatusRows({ rows, label }: { rows: Array<{ key: string; word: string; pct: number; tone: keyof typeof ICONS }>; label: string }) {
  return (
    <ul className={s.status} aria-label={label}>
      {rows.map(r => (
        <li key={r.key} className={s.stRow}>
          <span className={s.badge}><StatusIcon tone={r.tone} /><span>{r.key} {r.word}</span></span>
          <div className={s.track} aria-hidden><u style={{ width: `${r.pct > 0 ? Math.max(1, r.pct) : 0}%`, background: TONE_COLOR[r.tone] }} /></div>
          <em>{r.pct}%</em>
        </li>
      ))}
    </ul>
  )
}

export function Gauge({ value, label, text }: { value: number; label: string; text: string }) {
  const c = 2 * Math.PI * 40
  const v = Math.max(0, Math.min(100, value))
  const color = v >= 85 ? 'var(--crit)' : v >= 70 ? 'var(--warn)' : 'var(--chart-1)'
  return (
    <div role="img" aria-label={`${label} ${text}${v >= 85 ? ', high' : v >= 70 ? ', worth a look' : ''}`}>
      <div className={s.g}>
        <svg viewBox="0 0 96 96" aria-hidden>
          <circle cx="48" cy="48" r="40" fill="none" stroke="var(--track)" strokeWidth="7" />
          <circle cx="48" cy="48" r="40" fill="none" stroke={color} strokeWidth="7" strokeLinecap="round" strokeDasharray={`${(c * v) / 100} 999`} />
        </svg>
        <div aria-hidden><b>{text}</b><span>{label.toUpperCase()}</span></div>
      </div>
    </div>
  )
}

export function UptimeRing({ pct, caption }: { pct: number | null; caption: string }) {
  const c = 2 * Math.PI * 60
  const v = pct ?? 0
  const color = pct === null ? 'var(--track)' : v >= 99 ? 'var(--good)' : v >= 95 ? 'var(--warn)' : 'var(--crit)'
  return (
    <div className={s.core} role="img" aria-label={`Uptime ${pct === null ? 'not measured yet' : `${v}%`}, ${caption}`}>
      <svg viewBox="0 0 140 140" aria-hidden>
        <circle cx="70" cy="70" r="60" fill="none" stroke="var(--track)" strokeWidth="9" />
        <circle cx="70" cy="70" r="60" fill="none" stroke={color} strokeWidth="9" strokeLinecap="round" transform="rotate(-90 70 70)" strokeDasharray={`${(c * v) / 100} 999`} />
      </svg>
      <div aria-hidden><b>{pct === null ? '—' : `${v}%`}</b><span>UPTIME · {caption.toUpperCase()}</span></div>
    </div>
  )
}

export function UpState({ up }: { up: boolean | null }) {
  const tone = up === null ? 'info' : up ? 'good' : 'crit'
  return <span className={s.state}><StatusIcon tone={tone} />{up === null ? 'not checked' : up ? 'up' : 'down'}</span>
}
