'use client'

// =============================================================================
//  HyperProx — the visual kit
//
//  The pieces HyperProx pages are drawn from (the plug-in pages first): a HUD header, ring and semi
//  gauges, glowing bars, status dots, a flow pipeline, a network topology,
//  progress bars, a timeline, bottom sheets and cards. Each one states its
//  reading in text too (a label, an aria-label or a hidden suffix), so colour is
//  never the only signal, and each one stops moving under
//  prefers-reduced-motion.
// =============================================================================

import { useEffect, useId, useState, type ReactNode } from 'react'
import s from './visual.module.css'

export { s as styles }

export type Tone = 'accent' | 'warm' | 'good' | 'warn' | 'crit' | 'violet' | 'dim'
export const toneClass = (t?: Tone) => (t ? s[`tone-${t}`] : '')
const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0)

/** True when the reader asked for less motion. SVG animation (SMIL) ignores CSS, so the code asks too. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    try {
      const q = window.matchMedia('(prefers-reduced-motion: reduce)')
      setReduced(q.matches)
      const on = () => setReduced(q.matches)
      q.addEventListener?.('change', on)
      return () => q.removeEventListener?.('change', on)
    } catch { return undefined }
  }, [])
  return reduced
}

// ── numbers ──────────────────────────────────────────────────────────────────

/** Bits per second, as Mbps with sensible precision. */
export function mbps(bps: number): string {
  const m = (Number(bps) || 0) / 1_000_000
  return m >= 100 ? m.toFixed(0) : m >= 10 ? m.toFixed(1) : m.toFixed(m ? 2 : 0)
}
/** Bytes per second, as the download client shows it. */
export function rate(Bps: number): string {
  const v = Number(Bps) || 0
  if (v < 1024) return `${Math.round(v)} B/s`
  if (v < 1_048_576) return `${(v / 1024).toFixed(0)} KB/s`
  return `${(v / 1_048_576).toFixed(1)} MB/s`
}
export function bytes(n: number): string {
  const v = Number(n) || 0
  if (!v) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(v) / Math.log(1024)), u.length - 1)
  return `${(v / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`
}
export function duration(sec: number | null): string {
  if (!sec || sec <= 0) return '—'
  if (sec < 60) return `${Math.round(sec)}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  if (sec < 86_400) return `${(sec / 3600).toFixed(1)}h`
  return `${(sec / 86_400).toFixed(1)}d`
}
/** A gauge's full scale: the next round number above what it is showing, never below `floor`. */
export function niceMax(v: number, floor = 10): number {
  const steps = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000]
  return steps.find(x => x >= Math.max(v * 1.1, floor)) ?? Math.ceil(v)
}

// ── icons ────────────────────────────────────────────────────────────────────

const PATHS: Record<string, string> = {
  home: 'M3 11 12 3l9 8v10H3zM9 21v-6h6v6',
  play: 'M8 4l10 8-10 8z',
  arr: 'M12 3v12M6 9l6 6 6-6M4 21h16',
  encode: 'M3 5h18v14H3zM7 9h10M7 13h6',
  router: 'M3 13h18v7H3zM7 17h.01M11 17h.01M8 9a6 6 0 0 1 8 0M5 6a10 10 0 0 1 14 0',
  mesh: 'M12 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM5 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM19 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM12 7v4M7 18l4-6M17 18l-4-6',
  light: 'M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V18h6v-1.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z',
  fan: 'M12 12c0-3 1-7 4-7 2 0 3 1.5 3 3 0 3-4 4-7 4zM12 12c3 0 7 1 7 4 0 2-1.5 3-3 3-3 0-4-4-4-7zM12 12c0 3-1 7-4 7-2 0-3-1.5-3-3 0-3 4-4 7-4zM12 12c-3 0-7-1-7-4 0-2 1.5-3 3-3 3 0 4 4 4 7z',
  speaker: 'M5 2h14v20H5zM12 10a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 5.5v1',
  tv: 'M2 4h20v13H2zM8 21h16M12 17v4',
  lock: 'M4 11h16v10H4zM8 11V7a4 4 0 0 1 8 0v4',
  garage: 'M3 21V9l9-6 9 6v12M7 21v-8h10v8M7 16h10',
  power: 'M12 2v10M6.3 6.3a8 8 0 1 0 11.4 0',
  mute: 'M11 5 6 9H2v6h4l5 4zM23 9l-6 6M17 9l6 6',
  plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4',
  toggle: 'M2 8h20v8H2zM16 12a1 1 0 1 0 0 .01',
  cover: 'M3 4h18M5 4v16M19 4v16M5 9h14M5 14h14',
  alarm: 'M12 2a7 7 0 0 0-7 7v5l-2 3h18l-2-3V9a7 7 0 0 0-7-7zM10 20a2 2 0 0 0 4 0',
  run: 'M5 3l14 9-14 9z',
  vacuum: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  warn: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  check: 'M4 12l5 5L20 6',
  plugin: 'M9 3h6v4h4v6h-4v4H9v-4H5V7h4z',
}

export function Icon({ name, size = 16, className, label }: { name: string; size?: number; className?: string; label?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d={PATHS[name] ?? PATHS.plugin} />
    </svg>
  )
}

// ── rings and gauges ─────────────────────────────────────────────────────────

/**
 * A ring gauge. `value` is 0..1; `sweep` below 1 opens the ring at the bottom (a dial). `text` is what the centre
 * says and `label` names it, both read out together.
 */
export function RingGauge({ value, size = 84, stroke = 6, color = 'var(--hx-accent)', text, label, sweep = 1, spin = false, big = false }: {
  value: number; size?: number; stroke?: number; color?: string; text: ReactNode; label: string; sweep?: number; spin?: boolean; big?: boolean
}) {
  const r = (size - stroke) / 2 - (spin ? 6 : 0)
  const c = 2 * Math.PI * r
  const rot = sweep >= 1 ? -90 : 90 + (360 * (1 - sweep)) / 2
  const mid = size / 2
  return (
    <div className={`${s.ring} ${big ? s.ringBig : ''}`} style={{ width: size, height: size }} role="img" aria-label={`${label}: ${typeof text === 'string' || typeof text === 'number' ? text : Math.round(clamp01(value) * 100) + '%'}`}>
      <svg viewBox={`0 0 ${size} ${size}`} aria-hidden>
        {spin && (
          <>
            <circle cx={mid} cy={mid} r={mid - 2} fill="none" stroke="var(--track)" strokeWidth="1" />
            <g className={s.spin}><circle cx={mid} cy={mid} r={mid - 2} fill="none" stroke={color} strokeWidth="1.5" strokeDasharray="4 10" opacity=".6" /></g>
          </>
        )}
        <g transform={`rotate(${rot} ${mid} ${mid})`}>
          <circle className={s.arcTrack} cx={mid} cy={mid} r={r} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${c * sweep} 9999`} />
          <circle className={s.arc} cx={mid} cy={mid} r={r} stroke={color} strokeWidth={stroke} strokeDasharray={`${c * sweep * clamp01(value)} 9999`}
            style={{ filter: `drop-shadow(0 0 5px color-mix(in srgb, ${color} var(--glow), transparent))` }} />
        </g>
      </svg>
      <div className={s.ringMid} aria-hidden><b>{text}</b><span>{label}</span></div>
    </div>
  )
}

/** A half-circle gauge with its value and unit underneath. */
export function SemiGauge({ value, max, label, unit, color = 'var(--hx-accent)' }: { value: number; max: number; label: string; unit: string; color?: string }) {
  const len = Math.PI * 60
  return (
    <div className={s.semi} role="img" aria-label={`${label}: ${value} ${unit} of ${max}`}>
      <svg viewBox="0 0 150 96" aria-hidden>
        <path d="M15 85a60 60 0 0 1 120 0" fill="none" stroke="var(--track)" strokeWidth="12" strokeLinecap="round" />
        <path d="M15 85a60 60 0 0 1 120 0" fill="none" stroke={color} strokeWidth="12" strokeLinecap="round" strokeDasharray={`${len * clamp01(value / max)} 999`}
          style={{ filter: `drop-shadow(0 0 6px color-mix(in srgb, ${color} var(--glow), transparent))`, transition: 'stroke-dasharray .6s' }} />
      </svg>
      <div aria-hidden><b>{value}<small> {unit}</small></b><span>{label}</span></div>
    </div>
  )
}

// ── HUD ──────────────────────────────────────────────────────────────────────

export interface StatChip { label: string; value: ReactNode; tone?: Tone }

/** The header every plug-in page opens with: brackets, a scan line, a ring or an icon, the title and its chips. */
export function HudHeader({ eyebrow, title, icon, ring, chips, actions, label, level = 1 }: {
  eyebrow?: ReactNode; title: ReactNode; icon?: string; ring?: { value: number; text: ReactNode; label: string }
  chips?: StatChip[]; actions?: ReactNode; label?: string
  /** The heading level: 1 when the HUD heads the page, 2 under a page that already has its own title. */
  level?: 1 | 2
}) {
  const H = level === 1 ? 'h1' : 'h2'
  return (
    <section className={s.hud} aria-label={label ?? 'Overview'}>
      <div className={s.scan} aria-hidden />
      {ring ? <RingGauge value={ring.value} text={ring.text} label={ring.label} size={150} stroke={6} spin big />
        : <div className={s.hudIcon}><Icon name={icon ?? 'plugin'} size={44} /></div>}
      <div className={s.hudRight}>
        <H className={s.hudTitle}>{eyebrow && <small className={s.hudEyebrow}>{eyebrow}</small>}{title}</H>
        {!!chips?.length && (
          <dl className={s.chips} style={{ margin: 0 }}>
            {chips.map(c => (
              <div key={c.label} className={s.chip}>
                <dt className={s.srOnly}>{c.label}</dt>
                <dd style={{ margin: 0 }}><b className={toneClass(c.tone)}>{c.value}</b><span aria-hidden>{c.label}</span></dd>
              </div>
            ))}
          </dl>
        )}
        {actions && <div className={s.hudActions}>{actions}</div>}
      </div>
    </section>
  )
}

export function Panel({ title, sub, children, wide, label }: { title?: ReactNode; sub?: ReactNode; children: ReactNode; wide?: boolean; label?: string }) {
  return (
    <section className={`${s.panel} ${wide ? s.panelWide : ''}`} aria-label={label}>
      {title && <h2 className={s.panelTitle}>{title}{sub && <small>{sub}</small>}</h2>}
      {children}
    </section>
  )
}

export function Cols({ children }: { children: ReactNode }) {
  return <div className={s.cols}>{children}</div>
}

// ── bars ─────────────────────────────────────────────────────────────────────

/** Horizontal glowing bars. Each row says its value in text; the bar is the picture of it. */
export function GlowBars({ items, warm, label }: { items: Array<{ key?: string; label: string; value: number; text: string }>; warm?: boolean; label: string }) {
  const max = Math.max(...items.map(i => i.value), 1)
  return (
    <ul className={`${s.bars} ${warm ? s.barWarm : ''}`} aria-label={label}>
      {items.map((it, i) => (
        <li key={it.key ?? `${it.label}-${i}`} className={s.bar}>
          <span title={it.label}>{it.label}</span>
          <span className={s.barTrack} aria-hidden><i className={s.barFill} style={{ width: `${(it.value / max) * 100}%`, animationDelay: `${i * 60}ms` }} /></span>
          <em>{it.text}</em>
        </li>
      ))}
    </ul>
  )
}

export type ProgressVariant = 'normal' | 'seed' | 'stall'

/** A progress bar. `value` null draws a moving stripe: running, amount unknown. */
export function ProgressBar({ value, variant = 'normal', label }: { value: number | null; variant?: ProgressVariant; label: string }) {
  const known = value !== null && Number.isFinite(value)
  return (
    <div className={s.prog} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={known ? Math.round(value!) : undefined} aria-valuetext={known ? `${Math.round(value!)}%` : 'in progress'}>
      <i className={`${s.progFill} ${variant === 'seed' ? s.progSeed : variant === 'stall' ? s.progStall : ''} ${known ? '' : s.progUnknown}`}
        style={{ width: known ? `${Math.max(0, Math.min(100, value!))}%` : undefined }} />
    </div>
  )
}

export type DotState = 'ok' | 'warn' | 'bad' | 'off'
const DOT_WORD: Record<DotState, string> = { ok: 'working', warn: 'warning', bad: 'failing', off: 'off' }

/** Status dots: a dot and a name each, with the state in words for a screen reader and on hover. */
export function StatusDots({ items, label }: { items: Array<{ label: string; state: DotState }>; label: string }) {
  return (
    <ul className={s.dots} aria-label={label}>
      {items.map((it, i) => (
        <li key={`${it.label}-${i}`} className={s.dot} data-state={it.state} title={`${it.label}: ${DOT_WORD[it.state]}`}>
          <i aria-hidden />{it.label}{it.state === 'bad' ? ' !' : ''}<span className={s.srOnly}>, {DOT_WORD[it.state]}</span>
        </li>
      ))}
    </ul>
  )
}

export function Timeline({ items, label }: { items: Array<{ key: string; title: ReactNode; meta: string }>; label: string }) {
  return (
    <ol className={s.tl} aria-label={label}>
      {items.map(it => <li key={it.key}>{it.title}<small>{it.meta}</small></li>)}
    </ol>
  )
}

// ── flow pipeline ────────────────────────────────────────────────────────────

export interface FlowStage { key: string; label: string; value: ReactNode; sub?: ReactNode; state?: 'ok' | 'warn' | 'bad' | 'done'; status?: string }

/** Stages joined by a moving wire. A stage in trouble pulses; its `status` says why in words. */
export function FlowPipeline({ stages, label }: { stages: FlowStage[]; label: string }) {
  return (
    <ol className={s.pipe} style={{ ['--stages' as any]: stages.length }} aria-label={label}>
      <div className={s.wire} aria-hidden />
      {stages.map(st => (
        <li key={st.key} className={s.stage}>
          <div className={s.node} data-state={st.state ?? 'ok'} aria-hidden>{st.value}</div>
          <div>
            <b>{st.label}</b>
            <span className={s.srOnly}>: {typeof st.value === 'string' || typeof st.value === 'number' ? st.value : ''}{st.status ? `, ${st.status}` : ''}</span>
            {st.sub && <small>{st.sub}</small>}
          </div>
        </li>
      ))}
    </ol>
  )
}

// ── topology ─────────────────────────────────────────────────────────────────

export interface TopoNode { key: string; name: string; sub?: string; active?: boolean; tone?: 'accent' | 'violet' }

function linkColor(i: number) { return i % 2 ? 'var(--hx-violet)' : 'var(--hx-accent)' }

/**
 * The network as a picture: the internet, each uplink, the router, each subnet. Wide screens draw it left to
 * right, a phone top to bottom, from the same nodes. Packets move along links that carry traffic, unless the
 * reader asked for less motion.
 */
export function Topology({ internet, wans, core, subnets, label }: {
  internet: { name: string; sub?: string }; wans: TopoNode[]; core: { name: string; lines: string[] }; subnets: TopoNode[]; label: string
}) {
  const reduced = useReducedMotion()
  const id = useId().replace(/:/g, '')
  const summary = `${label}. Internet, ${wans.length} uplink${wans.length === 1 ? '' : 's'} (${wans.map(w => `${w.name}${w.sub ? ' ' + w.sub : ''}`).join('; ')}), ` +
    `router ${core.name}, ${subnets.length} network${subnets.length === 1 ? '' : 's'} (${subnets.map(n => `${n.name}${n.sub ? ' ' + n.sub : ''}`).join('; ')}).`
  return (
    <div role="img" aria-label={summary}>
      <TopoWide id={`w${id}`} reduced={reduced} internet={internet} wans={wans} core={core} subnets={subnets} />
      <TopoTall id={`t${id}`} reduced={reduced} internet={internet} wans={wans} core={core} subnets={subnets} />
    </div>
  )
}

interface TopoProps { id: string; reduced: boolean; internet: { name: string; sub?: string }; wans: TopoNode[]; core: { name: string; lines: string[] }; subnets: TopoNode[] }

const cut = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + '…' : t)

function Packet({ path, color, dur, begin, reverse, reduced }: { path: string; color: string; dur: number; begin?: number; reverse?: boolean; reduced: boolean }) {
  if (reduced) return null
  return (
    <circle r="3.2" fill={color}>
      <animateMotion dur={`${dur}s`} begin={begin ? `${begin}s` : undefined} repeatCount="indefinite" path={path}
        {...(reverse ? { keyPoints: '1;0', keyTimes: '0;1', calcMode: 'linear' } : {})} />
    </circle>
  )
}

function TopoWide({ id, reduced, internet, wans, core, subnets }: TopoProps) {
  const rows = Math.max(wans.length, subnets.length, 1)
  const H = Math.max(230, rows * 70 + 40)
  const cy = H / 2
  const ys = (n: number) => Array.from({ length: n }, (_, i) => (n === 1 ? cy : 40 + (i * (H - 80)) / (n - 1)))
  const wy = ys(wans.length), sy = ys(subnets.length)
  return (
    <svg className={`${s.topo} ${s.topoWide}`} viewBox={`0 0 640 ${H}`} aria-hidden>
      <circle cx="60" cy={cy} r="34" className={s.topoNode} />
      <text x="60" y={cy - 3} textAnchor="middle" className={s.topoName}>{cut(internet.name.toUpperCase(), 10)}</text>
      {internet.sub && <text x="60" y={cy + 12} textAnchor="middle" className={s.topoText}>{cut(internet.sub, 12)}</text>}
      {wans.map((w, i) => {
        const y = wy[i]; const color = linkColor(i)
        const d = `M94 ${cy + (y - cy) * 0.25} C150 ${y} 200 ${y} 262 ${cy + (y - cy) * 0.3}`
        return (
          <g key={w.key}>
            <path id={`${id}w${i}`} d={d} className={`${s.topoLink} ${w.active ? '' : s.topoLinkIdle}`} stroke={color} />
            <text x="178" y={y - 8} textAnchor="middle" className={s.topoText} style={{ fill: color }}>{cut(w.name, 18)}</text>
            {w.sub && <text x="178" y={y + 16} textAnchor="middle" className={s.topoText}>{cut(w.sub, 22)}</text>}
            {w.active && <><Packet path={d} color={color} dur={1.6 + i * 0.6} reduced={reduced} /><Packet path={d} color={color} dur={1.6 + i * 0.6} begin={0.8} reverse reduced={reduced} /></>}
          </g>
        )
      })}
      <rect x="262" y={cy - 37} width="116" height="74" rx="12" className={s.topoCore} />
      <rect x="262" y={cy - 37} width="116" height="74" rx="12" className={s.topoGlow} />
      <text x="320" y={cy - 11} textAnchor="middle" className={s.topoName} style={{ fontSize: 16 }}>{cut(core.name.toUpperCase(), 13)}</text>
      {core.lines.slice(0, 2).map((l, i) => <text key={i} x="320" y={cy + 7 + i * 16} textAnchor="middle" className={s.topoText}>{cut(l, 22)}</text>)}
      {subnets.map((n, i) => {
        const y = sy[i]; const color = linkColor(i)
        const d = `M378 ${cy + (y - cy) * 0.3} C430 ${cy + (y - cy) * 0.3} 450 ${y} 500 ${y}`
        return (
          <g key={n.key}>
            <path d={d} className={`${s.topoLink} ${n.active ? '' : s.topoLinkIdle}`} stroke={color} />
            {n.active && <Packet path={d} color={color} dur={1.3 + i * 0.7} reduced={reduced} />}
            <rect x="500" y={y - 26} width="132" height="52" rx="10" className={s.topoNode} style={{ stroke: color }} />
            <text x="566" y={y - 6} textAnchor="middle" className={s.topoName}>{cut(n.name, 16)}</text>
            {n.sub && <text x="566" y={y + 10} textAnchor="middle" className={s.topoText}>{cut(n.sub, 22)}</text>}
          </g>
        )
      })}
    </svg>
  )
}

function TopoTall({ id, reduced, internet, wans, core, subnets }: TopoProps) {
  const W = 360
  const xs = (n: number) => Array.from({ length: n }, (_, i) => (n === 1 ? W / 2 : 50 + (i * (W - 100)) / (n - 1)))
  const wx = xs(wans.length), sx = xs(subnets.length)
  const colW = Math.min(150, (W - 20) / Math.max(subnets.length, 1) - 8)
  return (
    <svg className={`${s.topo} ${s.topoTall}`} viewBox={`0 0 ${W} 420`} aria-hidden>
      <circle cx={W / 2} cy="40" r="30" className={s.topoNode} />
      <text x={W / 2} y="38" textAnchor="middle" className={s.topoName} style={{ fontSize: 12 }}>{cut(internet.name.toUpperCase(), 9)}</text>
      {internet.sub && <text x={W / 2} y="52" textAnchor="middle" className={s.topoText}>{cut(internet.sub, 11)}</text>}
      {wans.map((w, i) => {
        const x = wx[i]; const color = linkColor(i)
        const d = `M${W / 2} 70 C${W / 2} 100 ${x} 110 ${x} 130 C${x} 150 ${W / 2} 160 ${W / 2} 180`
        return (
          <g key={w.key}>
            <path id={`${id}w${i}`} d={d} className={`${s.topoLink} ${w.active ? '' : s.topoLinkIdle}`} stroke={color} />
            <text x={x} y="126" textAnchor="middle" className={s.topoText} style={{ fill: color, paintOrder: 'stroke', stroke: 'var(--hx-panel)', strokeWidth: 4 }}>{cut(w.name, 14)}</text>
            {w.sub && <text x={x} y="140" textAnchor="middle" className={s.topoText} style={{ paintOrder: 'stroke', stroke: 'var(--hx-panel)', strokeWidth: 4 }}>{cut(w.sub, 16)}</text>}
            {w.active && <Packet path={d} color={color} dur={1.8 + i * 0.6} reduced={reduced} />}
          </g>
        )
      })}
      <rect x={W / 2 - 75} y="180" width="150" height="64" rx="12" className={s.topoCore} />
      <rect x={W / 2 - 75} y="180" width="150" height="64" rx="12" className={s.topoGlow} />
      <text x={W / 2} y="204" textAnchor="middle" className={s.topoName} style={{ fontSize: 15 }}>{cut(core.name.toUpperCase(), 16)}</text>
      {core.lines.slice(0, 2).map((l, i) => <text key={i} x={W / 2} y={220 + i * 14} textAnchor="middle" className={s.topoText}>{cut(l, 26)}</text>)}
      {subnets.map((n, i) => {
        const x = sx[i]; const color = linkColor(i)
        const d = `M${W / 2} 244 C${W / 2} 280 ${x} 290 ${x} 330`
        return (
          <g key={n.key}>
            <path d={d} className={`${s.topoLink} ${n.active ? '' : s.topoLinkIdle}`} stroke={color} />
            {n.active && <Packet path={d} color={color} dur={1.4 + i * 0.6} reduced={reduced} />}
            <rect x={x - colW / 2} y="330" width={colW} height="56" rx="10" className={s.topoNode} style={{ stroke: color }} />
            <text x={x} y="352" textAnchor="middle" className={s.topoName} style={{ fontSize: 12 }}>{cut(n.name, Math.floor(colW / 8))}</text>
            {n.sub && <text x={x} y="370" textAnchor="middle" className={s.topoText}>{cut(n.sub, Math.floor(colW / 6.2))}</text>}
          </g>
        )
      })}
    </svg>
  )
}
