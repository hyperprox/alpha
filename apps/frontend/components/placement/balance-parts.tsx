// The Load balancing page's visual pieces: nodes as columns with CPU and RAM load bars (before and after the plan)
// and a sparkline of the window, the plan as guests travelling between nodes with before/after bars, and a plan's
// progress. Tailwind classes and the theme's CSS variables only, so each piece renders on its own in a test.

import type { ReactNode } from 'react'
import { loadBars, sparkPoints, stepLine, pct, progressWords, GOAL_WORD } from './balance-logic'
import type { BalancePlan, BalanceSuggestion, NodeLoad, PlanRecord, PlanStep } from './types'

const MONO: React.CSSProperties = { fontFamily: 'var(--font-mono)' }
const DISPLAY: React.CSSProperties = { fontFamily: 'var(--font-display)' }
const CPU_COLOR = 'var(--hx-accent)'
const MEM_COLOR = 'var(--violet)'

function Bar({ pct: p, after, over, color }: { pct: number; after: number | null; over: boolean; color: string }) {
  const fill = over ? 'linear-gradient(90deg, var(--warn), var(--crit))' : color
  return (
    <span className="relative block overflow-hidden rounded" style={{ height: 9, background: 'var(--track)' }} aria-hidden>
      <i className="absolute inset-y-0 left-0 rounded" data-over={over ? 'true' : undefined}
        style={{ width: `${p}%`, background: fill, opacity: after !== null ? 0.35 : 1, boxShadow: over ? 'none' : `0 0 8px color-mix(in srgb, ${color} 55%, transparent)` }} />
      {after !== null && <i className="absolute inset-y-0 left-0 rounded" data-after="true" style={{ width: `${after}%`, background: color, boxShadow: `0 0 8px color-mix(in srgb, ${color} 55%, transparent)` }} />}
    </span>
  )
}

export function Sparkline({ n }: { n: NodeLoad }) {
  const cpu = sparkPoints(n.history.cpu), mem = sparkPoints(n.history.mem)
  if (!cpu && !mem) return <p style={{ ...MONO, fontSize: 10, color: 'var(--text-dimmer)' }}>no history</p>
  return (
    <svg viewBox="0 0 120 28" preserveAspectRatio="none" className="block w-full" style={{ height: 28 }} role="img"
      aria-label={`${n.node} over the window: CPU and RAM`}>
      <line x1="0" x2="120" y1="27.5" y2="27.5" stroke="var(--hx-line)" strokeWidth="1" />
      {mem && <polyline points={mem} fill="none" stroke={MEM_COLOR} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />}
      {cpu && <polyline points={cpu} fill="none" stroke={CPU_COLOR} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />}
    </svg>
  )
}

/** One node: its name, its share of the cluster's load, CPU and RAM bars (with the plan's after-value), and its window. */
export function LoadColumn({ n, after, lines, busiest }: { n: NodeLoad; after?: { cpu: number; mem: number } | null; lines?: { cpu: number; mem: number }; busiest?: boolean }) {
  const off = !n.online || n.maintenance
  return (
    <section aria-label={`Node ${n.node} load`} data-busiest={busiest ? 'true' : undefined} className="relative min-w-0 overflow-hidden rounded-xl border p-3"
      style={{ borderColor: off ? 'var(--warn)' : busiest ? 'color-mix(in srgb, var(--warn) 60%, var(--hx-line))' : 'var(--hx-line)', background: 'var(--ground-deep)' }}>
      <div aria-hidden className="absolute inset-x-0 top-0" style={{ height: 2, background: off ? 'var(--warn)' : 'linear-gradient(90deg, transparent, var(--hx-accent), transparent)', opacity: 0.7 }} />
      <div className="flex items-baseline justify-between gap-2">
        <h3 style={{ ...DISPLAY, fontWeight: 700, fontSize: 21, color: 'var(--text-bright)' }}>{n.node}</h3>
        <span style={{ ...MONO, fontSize: 11, color: off ? 'var(--warn)' : 'var(--text-dim)' }}>
          {!n.online ? 'offline' : n.maintenance ? 'maintenance' : !n.counted ? 'no history' : `${pct(n.memShare)} of RAM · ${pct(n.cpuShare)} of CPU`}
        </span>
      </div>
      <ul className="my-2 grid gap-1.5">
        {loadBars(n, after, lines).map(b => (
          <li key={b.key} className="grid items-center gap-x-2" style={{ gridTemplateColumns: '34px 1fr', ...MONO, fontSize: 10.5, color: 'var(--text-dim)' }}>
            <span>{b.label}</span>
            <Bar pct={b.pct} after={b.after} over={b.over} color={b.key === 'cpu' ? CPU_COLOR : MEM_COLOR} />
            <span style={{ gridColumn: 2, fontSize: 10, color: 'var(--text-dimmer)' }}>
              {b.text}{b.after !== null && b.after !== b.pct ? ` → ${b.after}% after the plan` : ''}
            </span>
          </li>
        ))}
      </ul>
      <Sparkline n={n} />
    </section>
  )
}

export function LoadColumns({ nodes, after, lines, busiest }: { nodes: NodeLoad[]; after?: Map<string, { cpu: number; mem: number }>; lines?: { cpu: number; mem: number }; busiest?: string | null }) {
  return (
    <div>
      <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' }}>
        {nodes.map(n => <LoadColumn key={n.node} n={n} after={after?.get(n.node) ?? null} lines={lines} busiest={busiest === n.node} />)}
      </div>
      <p className="mt-2.5 flex flex-wrap gap-3.5" style={{ ...MONO, fontSize: 11, color: 'var(--text-dim)' }}>
        <span className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block rounded-full" style={{ width: 8, height: 8, background: CPU_COLOR }} />CPU</span>
        <span className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block rounded-full" style={{ width: 8, height: 8, background: MEM_COLOR }} />RAM</span>
        <span>bars: 95th percentile of the window, a share of each node&apos;s own capacity{after?.size ? '; bright part: after the plan' : ''}</span>
      </p>
    </div>
  )
}

function Mini({ label, before, after }: { label: string; before: { cpu: number; mem: number }; after: { cpu: number; mem: number } }) {
  return (
    <div className="min-w-0">
      <b style={{ ...DISPLAY, fontSize: 18, color: 'var(--text-bright)' }}>{label}</b>
      {(['cpu', 'mem'] as const).map(k => (
        <div key={k} className="grid items-center gap-x-1.5" style={{ gridTemplateColumns: '30px 1fr auto', ...MONO, fontSize: 10, color: 'var(--text-dim)' }}>
          <span>{k === 'cpu' ? 'CPU' : 'RAM'}</span>
          <Bar pct={Math.round(before[k] * 100)} after={Math.round(after[k] * 100)} over={false} color={k === 'cpu' ? CPU_COLOR : MEM_COLOR} />
          <span>{pct(before[k])}→{pct(after[k])}</span>
        </div>
      ))}
    </div>
  )
}

/** One move: the guest travelling from one node to the other, both nodes' bars before and after, its cost. */
export function StepCard({ s, status }: { s: PlanStep; status?: ReactNode }) {
  return (
    <li className="space-y-2 rounded-xl border p-3" style={{ borderColor: 'var(--hx-line)', background: 'var(--ground-deep)' }} aria-label={`Move ${s.n}: ${s.name || s.sid} from ${s.from} to ${s.to}`}>
      <div className="grid items-center gap-2.5" style={{ gridTemplateColumns: 'minmax(0,1fr) auto minmax(0,1fr)' }}>
        <Mini label={s.from} before={s.before.from} after={s.after.from} />
        <div className="flex flex-col items-center gap-1" aria-hidden>
          <span className="rounded-lg border px-2 py-0.5" style={{ ...MONO, fontSize: 12, borderColor: 'var(--hx-accent)', color: 'var(--text-bright)', background: 'color-mix(in srgb, var(--hx-accent) 12%, var(--surface))' }}>
            {s.ha ? 'HA · ' : ''}{s.name || s.sid}
          </span>
          <svg width="64" height="10" viewBox="0 0 64 10"><path d="M2 5h56M52 1l6 4-6 4" fill="none" stroke="var(--hx-accent)" strokeWidth="1.6" /></svg>
          <span style={{ ...MONO, fontSize: 10, color: 'var(--hx-accent)' }}>+{Math.round(s.gain)} pts</span>
        </div>
        <Mini label={s.to} before={s.before.to} after={s.after.to} />
      </div>
      <p className="text-sm" style={{ color: 'var(--text-bright)' }}>{stepLine(s)}</p>
      {status}
      <details className="text-[13px]" style={{ color: 'var(--text-soft)' }}>
        <summary className="cursor-pointer" style={{ color: 'var(--text-dim)' }}>Why this move</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">{s.why.map((w, i) => <li key={i}>{w}</li>)}</ul>
      </details>
    </li>
  )
}

export function SuggestionLine({ x, action }: { x: BalanceSuggestion; action?: ReactNode }) {
  return (
    <li className="border-l-[3px] py-1 pl-2.5 text-sm" style={{ borderColor: 'var(--violet)', color: 'var(--text-soft)' }}>
      <span style={{ ...MONO, fontSize: 11, color: 'var(--violet)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{x.kind === 'edit-rule' ? 'HA rule change' : 'HA guest'}</span>{' '}
      {x.words} {action}
    </li>
  )
}

/** The plan: score now and after, the moves in order, what it leaves to others, and why it stops there. */
export function PlanView({ plan, actions, suggestionAction }: { plan: BalancePlan; actions?: ReactNode; suggestionAction?: (x: BalanceSuggestion) => ReactNode }) {
  const gain = plan.target.score - plan.score.score
  return (
    <div className="space-y-3" data-testid="balance-plan">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div><p style={{ ...MONO, fontSize: 11, color: 'var(--text-dim)' }}>SCORE NOW</p><b style={{ ...DISPLAY, fontSize: 34, color: 'var(--text-bright)' }}>{Math.round(plan.score.score)}</b></div>
        <svg width="40" height="12" viewBox="0 0 40 12" aria-hidden><path d="M2 6h32M28 1l7 5-7 5" fill="none" stroke="var(--hx-accent)" strokeWidth="1.8" /></svg>
        <div><p style={{ ...MONO, fontSize: 11, color: 'var(--text-dim)' }}>AFTER THE PLAN</p><b style={{ ...DISPLAY, fontSize: 34, color: 'var(--hx-accent)' }}>{Math.round(plan.target.score)}</b></div>
        <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
          {plan.steps.length ? `${plan.steps.length} move${plan.steps.length === 1 ? '' : 's'}, +${Math.round(gain)} points, by ${GOAL_WORD[plan.goal]}.` : `No moves, by ${GOAL_WORD[plan.goal]}.`}
        </p>
      </div>
      {plan.steps.length > 0 && <ol className="grid gap-2.5" aria-label="The moves, in order">{plan.steps.map(s => <StepCard key={s.sid} s={s} />)}</ol>}
      {actions}
      {plan.suggestions.length > 0 && (
        <div className="space-y-1">
          <p style={{ ...MONO, fontSize: 11, color: 'var(--text-dim)' }}>NOT IN THE PLAN, FOR YOU TO DECIDE</p>
          <ul className="space-y-1.5">{plan.suggestions.map(x => <SuggestionLine key={x.sid} x={x} action={suggestionAction?.(x)} />)}</ul>
        </div>
      )}
      {[...plan.words, ...plan.left].length > 0 && <ul className="list-disc space-y-0.5 pl-5 text-[13px]" style={{ color: 'var(--text-dim)' }}>{[...plan.words, ...plan.left].map((w, i) => <li key={i}>{w}</li>)}</ul>}
    </div>
  )
}

const STEP_DOT: Record<PlanRecord['steps'][number]['status'], string> = {
  pending: 'var(--text-dimmer)', running: 'var(--hx-accent)', done: 'var(--good, var(--hx-accent))', failed: 'var(--crit)', skipped: 'var(--warn)',
}

/** A plan's progress: one line per move with its state. */
export function PlanProgress({ p, tz, action }: { p: PlanRecord; tz?: string; action?: ReactNode }) {
  return (
    <article className="space-y-2 rounded-xl border p-3" style={{ borderColor: p.status === 'failed' ? 'var(--crit)' : 'var(--hx-line)', background: 'var(--ground-deep)' }} aria-label={`Balancing plan, ${p.status}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span style={{ ...MONO, fontSize: 12, color: 'var(--text-bright)' }}>{progressWords(p, tz)}</span>
        {action}
      </div>
      <ol className="grid gap-1">
        {p.steps.map((s, i) => (
          <li key={i} data-step={s.status} className="flex flex-wrap items-center gap-2 text-sm" style={{ color: 'var(--text-soft)' }}>
            <i aria-hidden className="inline-block rounded-full" style={{ width: 8, height: 8, background: STEP_DOT[s.status], boxShadow: s.status === 'running' ? `0 0 8px ${STEP_DOT.running}` : 'none' }} />
            <span>{i + 1}. {s.name || s.sid}: {s.from} → {s.to}</span>
            <span style={{ ...MONO, fontSize: 11, color: 'var(--text-dim)' }}>{s.status}</span>
            {s.error && <span className="w-full pl-4 text-[13px]" style={{ color: s.status === 'failed' ? 'var(--crit-soft)' : 'var(--text-dim)' }}>{s.error}</span>}
          </li>
        ))}
      </ol>
      {p.error && <p className="text-[13px]" style={{ color: p.status === 'done' ? 'var(--text-soft)' : 'var(--warn)' }}>{p.error}</p>}
    </article>
  )
}
