'use client'

// =============================================================================
//  HyperProx — the dashboard's visual vocabulary
//
//  Four primitives, used everywhere, so a number means the same thing wherever
//  it appears: a Speedometer for a bounded percentage, a Sparkline for where
//  that number has been, a StreamChart for a rate with a direction, and a Meter
//  for a quantity out of a total.
//
//  The colour scale is shared and is the whole point: cyan is fine, amber is
//  worth a look, red needs a person. A panel that invents its own thresholds
//  teaches the reader that colour means nothing.
// =============================================================================

import { useEffect, useRef, useState } from 'react'
import { alpha } from '@/lib/theme'

export const ACCENT = 'var(--accent)'
export const WARN   = 'var(--warn-2)'
export const CRIT   = 'var(--crit-2)'
export const GOOD   = 'var(--good)'

export function zoneColor(pct: number, base: string = ACCENT): string {
  if (pct >= 90) return CRIT
  if (pct >= 75) return WARN
  return base
}

// ── Rolling history ──────────────────────────────────────────────────────────
//  Keyed on the sample stamp rather than the value, so a metric that happens to
//  read the same twice still advances the trace instead of flatlining.

export function useHistory(value: number | null | undefined, stamp: number | null, len = 48): number[] {
  const [hist, setHist] = useState<number[]>([])
  const latest = useRef<number>(0)
  latest.current = Number.isFinite(value as number) ? (value as number) : latest.current

  useEffect(() => {
    if (stamp == null) return
    setHist(h => {
      const next = [...h, latest.current]
      return next.length > len ? next.slice(-len) : next
    })
  }, [stamp, len])

  return hist
}

// ── Speedometer ──────────────────────────────────────────────────────────────

const SWEEP = 240          // degrees of travel; the gap sits at the bottom
const START = -120

/** Clockwise from twelve o'clock, which is how a dial is actually read. */
function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) }
}

function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const a = polar(cx, cy, r, from)
  const b = polar(cx, cy, r, to)
  const large = Math.abs(to - from) > 180 ? 1 : 0
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${large} 1 ${b.x} ${b.y}`
}

export function Speedometer({
  value, label, unit = '%', size = 128, color, caption, max = 100,
}: {
  value: number
  label: string
  unit?: string
  size?: number
  color?: string
  caption?: string
  max?: number
}) {
  const safe   = Number.isFinite(value) ? Math.max(0, Math.min(value, max)) : 0
  const t      = max > 0 ? safe / max : 0
  const pct    = t * 100
  const c      = color ?? zoneColor(pct)
  const cx     = size / 2
  const cy     = size / 2 + size * 0.06        // the dial sits high; the gap is at the bottom
  const r      = size * 0.38
  const stroke = Math.max(5, size * 0.075)
  const needle = START + SWEEP * t
  // The needle sweeps through the space the readout occupies at both ends of
  // the scale. Rather than shrink one to miss the other, the digits are painted
  // last with a ground-coloured outline, so the needle passes behind them.
  const needleLen = r - stroke * 2.2

  // Ticks every 30°, longer every 60°.
  const ticks = Array.from({ length: 9 }, (_, i) => {
    const deg   = START + (SWEEP / 8) * i
    const major = i % 2 === 0
    const outer = polar(cx, cy, r - stroke * 0.85, deg)
    const inner = polar(cx, cy, r - stroke * (major ? 1.75 : 1.35), deg)
    return { deg, major, outer, inner }
  })

  return (
    <div className="flex flex-col items-center" style={{ width: size }}>
      <svg width={size} height={size * 0.86} viewBox={`0 0 ${size} ${size * 0.86}`} role="img"
        aria-label={`${label} ${Math.round(pct)}${unit}`}>
        {/* Zone track — dim, so the live arc reads as the foreground */}
        <path d={arcPath(cx, cy, r, START, START + SWEEP * 0.75)} fill="none" stroke="var(--border-strong)" strokeWidth={stroke} strokeLinecap="round" />
        <path d={arcPath(cx, cy, r, START + SWEEP * 0.75, START + SWEEP * 0.9)} fill="none" stroke={`${alpha(WARN, 15)}`} strokeWidth={stroke} />
        <path d={arcPath(cx, cy, r, START + SWEEP * 0.9, START + SWEEP)} fill="none" stroke={`${alpha(CRIT, 19)}`} strokeWidth={stroke} strokeLinecap="round" />

        {/* Live arc. pathLength normalises the dash maths to 0–100 regardless of radius. */}
        <path d={arcPath(cx, cy, r, START, START + SWEEP)} fill="none" stroke={c} strokeWidth={stroke}
          strokeLinecap="round" pathLength={100} strokeDasharray={100}
          strokeDashoffset={100 - pct}
          style={{ transition: 'stroke-dashoffset .6s cubic-bezier(.22,1,.36,1), stroke .3s', filter: `drop-shadow(0 0 ${size * 0.04}px ${alpha(c, 44)})` }} />

        {ticks.map((tk, i) => (
          <line key={i} x1={tk.outer.x} y1={tk.outer.y} x2={tk.inner.x} y2={tk.inner.y}
            stroke={tk.major ? 'color-mix(in srgb, var(--text-dimmer) 50%, transparent)' : 'color-mix(in srgb, var(--text-faint) 50%, transparent)'} strokeWidth={tk.major ? 1.5 : 1} strokeLinecap="round" />
        ))}

        {/* Needle */}
        <g transform={`rotate(${needle} ${cx} ${cy})`} style={{ transition: 'transform .6s cubic-bezier(.22,1,.36,1)' }}>
          <polygon
            points={`${cx - size * 0.02},${cy} ${cx},${cy - needleLen} ${cx + size * 0.02},${cy}`}
            fill={c} opacity={0.9} />
        </g>
        <circle cx={cx} cy={cy} r={size * 0.035} fill="var(--surface-notice)" stroke={c} strokeWidth={1.5} />

        {/* Readout sits in the dial's open bottom, where the sweep leaves room */}
        <text x={cx} y={cy + r * 0.58} textAnchor="middle" fill={c}
          fontSize={size * 0.19} fontWeight={700} fontFamily="IBM Plex Mono, monospace"
          stroke="var(--ground)" strokeWidth={size * 0.035} paintOrder="stroke"
          style={{ fontVariantNumeric: 'tabular-nums' }}>
          {Math.round(safe)}<tspan fontSize={size * 0.1} fill={`${alpha(c, 56)}`}>{unit}</tspan>
        </text>
      </svg>
      <div className="font-mono uppercase tracking-widest text-gray-500" style={{ fontSize: Math.max(9, size * 0.075), marginTop: -2 }}>
        {label}
      </div>
      {caption && (
        <div className="font-mono text-gray-600 text-center" style={{ fontSize: Math.max(8, size * 0.068), marginTop: 2 }}>
          {caption}
        </div>
      )}
    </div>
  )
}

// ── Sparkline ────────────────────────────────────────────────────────────────

export function Sparkline({
  data, color = ACCENT, width = 120, height = 26, fill = true, baseline = 'min',
}: {
  data: number[]
  color?: string
  width?: number
  height?: number
  fill?: boolean
  /** 'zero' keeps the scale honest for rates; 'min' shows shape for slow-moving levels. */
  baseline?: 'zero' | 'min'
}) {
  if (data.length < 2) {
    return <div style={{ width, height }} className="flex items-end">
      <div className="w-full border-b border-dashed" style={{ borderColor: 'var(--text-faint)' }} />
    </div>
  }

  const lo   = baseline === 'zero' ? 0 : Math.min(...data)
  const hi   = Math.max(...data, lo + 1e-9)
  const span = hi - lo || 1
  const step = width / (data.length - 1)
  const y    = (v: number) => height - 2 - ((v - lo) / span) * (height - 4)

  const pts  = data.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const id   = `sg-${color.replace('#', '')}-${width}-${height}`

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity={0.35} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {fill && <polygon points={`0,${height} ${pts} ${width},${height}`} fill={`url(#${id})`} />}
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={width} cy={y(data[data.length - 1])} r={2} fill={color} />
    </svg>
  )
}

// ── Stream chart — a rate with a direction ───────────────────────────────────
//  In above the axis, out below it. Both share one scale, so the two halves are
//  comparable rather than each being normalised to its own peak.

export function StreamChart({
  inData, outData, width = 260, height = 72, inColor = GOOD, outColor = WARN,
}: {
  inData: number[]
  outData: number[]
  width?: number
  height?: number
  inColor?: string
  outColor?: string
}) {
  const n    = Math.max(inData.length, outData.length)
  const peak = Math.max(...inData, ...outData, 1)
  const mid  = height / 2
  const step = n > 1 ? width / (n - 1) : width

  const trace = (d: number[], up: boolean) => {
    if (d.length < 2) return null
    const pts = d.map((v, i) => {
      const h = (v / peak) * (mid - 3)
      return `${(i * step).toFixed(1)},${(up ? mid - h : mid + h).toFixed(1)}`
    }).join(' ')
    const color = up ? inColor : outColor
    return (
      <g>
        <polygon points={`0,${mid} ${pts} ${((d.length - 1) * step).toFixed(1)},${mid}`} fill={color} opacity={0.18} />
        <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      </g>
    )
  }

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <line x1={0} y1={mid} x2={width} y2={mid} stroke="var(--text-faint)" strokeWidth={1} />
      {trace(inData, true)}
      {trace(outData, false)}
    </svg>
  )
}

// ── Meter — a quantity out of a total ────────────────────────────────────────

export function Meter({
  label, used, total, p, fmt, color = ACCENT, spark,
}: {
  label: string
  used: number
  total: number
  p: number
  fmt: (v: number) => string
  color?: string
  spark?: number[]
}) {
  const c = zoneColor(p, color)
  return (
    <div>
      <div className="flex items-baseline justify-between font-mono mb-1" style={{ fontSize: 11 }}>
        <span className="text-gray-500 uppercase tracking-wider">{label}</span>
        <span className="text-gray-600" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {fmt(used ?? 0)} <span className="text-gray-700">/ {fmt(total ?? 0)}</span>
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div className="h-1.5 rounded-full overflow-hidden flex-1" style={{ background: 'var(--border-strong)' }}>
          <div className="h-full rounded-full" style={{ width: `${Math.min(p, 100)}%`, background: c, boxShadow: `0 0 8px ${alpha(c, 38)}`, transition: 'width .6s cubic-bezier(.22,1,.36,1)' }} />
        </div>
        <span className="font-mono font-semibold" style={{ color: c, fontSize: 11, width: 32, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{p}%</span>
      </div>
      {spark && spark.length > 1 && (
        <div className="mt-1"><Sparkline data={spark} color={c} width={240} height={18} /></div>
      )}
    </div>
  )
}
