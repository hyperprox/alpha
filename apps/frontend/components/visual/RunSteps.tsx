'use client'

// =============================================================================
//  HyperProx — the run-steps checklist
//
//  Every multi-step run (the New website wizard, catalogue installs) shows its steps here. Six steps or fewer
//  read well as a row of stages; more than that is a vertical checklist inside a box that scrolls, one row per
//  step: a state icon, the label in plain words, the time it took, and a live line while it runs. A failed step
//  stays open with its error. The row of stages is the existing FlowPipeline, unchanged.
// =============================================================================

import { useEffect, useRef, useState } from 'react'
import { FlowPipeline, useReducedMotion } from './kit'
import s from './run-steps.module.css'

/** The statuses a run reports. The wizard says `done` and the install says `completed`; both mean the same. */
export type RunStepStatus = 'pending' | 'running' | 'done' | 'completed' | 'failed' | 'skipped' | (string & {})
export interface RunStep {
  id: string
  label: string
  status: RunStepStatus
  /** A live line while running, the result when done, the error when failed. */
  detail?: string
  /** Optional wall-clock times in ms, when the API reports them. Otherwise they are measured here. */
  startedAt?: number
  endedAt?: number
}

type Norm = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
export const HORIZONTAL_MAX = 6

export function normStatus(st: RunStepStatus): Norm {
  if (st === 'done' || st === 'completed') return 'done'
  if (st === 'running' || st === 'failed' || st === 'skipped') return st as Norm
  return 'pending'
}

/** 45s, 2m 10s, 1h 02m. */
export function fmtElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m ${String(sec % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

const WORD: Record<Norm, string> = { pending: 'waiting', running: 'running', done: 'done', failed: 'failed', skipped: 'skipped' }

/** What the summary line says, from the steps alone. */
export function summarise(steps: RunStep[]): { n: number; text: string; done: number; failed: boolean } {
  const st = steps.map(x => normStatus(x.status))
  const total = steps.length
  const done = st.filter(x => x === 'done' || x === 'skipped').length
  const fi = st.indexOf('failed')
  if (fi >= 0) return { n: fi + 1, text: `Step ${fi + 1} of ${total} failed · ${steps[fi].label}`, done, failed: true }
  const ri = st.indexOf('running')
  if (ri >= 0) return { n: ri + 1, text: `Step ${ri + 1} of ${total} · ${steps[ri].label}`, done, failed: false }
  if (done === total && total > 0) return { n: total, text: `All ${total} steps done`, done, failed: false }
  return { n: Math.min(done + 1, total), text: `Step ${Math.min(done + 1, total)} of ${total} · ${steps[done]?.label ?? 'starting'}`, done, failed: false }
}

/** Times per step: the API's when it gives them, else the moments this view first saw the step start and stop. */
function useStepClock(steps: RunStep[], now?: number) {
  const seen = useRef(new Map<string, { start?: number; end?: number }>())
  const [tick, setTick] = useState(() => now ?? Date.now())
  const running = steps.some(x => normStatus(x.status) === 'running')
  const t = now ?? Date.now()
  for (const x of steps) {
    const n = normStatus(x.status)
    const e = seen.current.get(x.id) ?? {}
    if (n !== 'pending' && e.start === undefined) e.start = x.startedAt ?? t
    if ((n === 'done' || n === 'failed') && e.end === undefined) e.end = x.endedAt ?? t
    seen.current.set(x.id, e)
  }
  useEffect(() => {
    if (!running || now !== undefined) return
    const i = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(i)
  }, [running, now])
  const at = now ?? Math.max(tick, t)
  const elapsed = (x: RunStep): number | null => {
    const e = seen.current.get(x.id)
    const n = normStatus(x.status)
    if (!e || e.start === undefined || n === 'pending' || n === 'skipped') return null
    return (e.end ?? at) - e.start
  }
  const starts = steps.map(x => seen.current.get(x.id)?.start).filter((v): v is number => v !== undefined)
  const ends = steps.map(x => seen.current.get(x.id)?.end)
  const finished = steps.length > 0 && ends.every((v, i) => v !== undefined || normStatus(steps[i].status) === 'skipped')
  const total = starts.length ? (finished ? Math.max(...ends.filter((v): v is number => v !== undefined)) : at) - Math.min(...starts) : 0
  return { elapsed, total }
}

function Icon({ state }: { state: Norm }) {
  return (
    <span className={s.icon} data-state={state} aria-hidden>
      {state === 'running' ? <i className={s.spin} /> : state === 'done' ? '✓' : state === 'failed' ? '✕' : state === 'skipped' ? '–' : ''}
    </span>
  )
}

export function RunSteps({ steps, label, now, horizontalMax = HORIZONTAL_MAX }: {
  steps: RunStep[]; label: string
  /** Fixes the clock (tests and screenshots). */
  now?: number
  horizontalMax?: number
}) {
  const { elapsed, total } = useStepClock(steps, now)
  const reduced = useReducedMotion()
  const rowRefs = useRef(new Map<string, HTMLLIElement>())
  const active = steps.find(x => normStatus(x.status) === 'running')?.id ?? steps.find(x => normStatus(x.status) === 'failed')?.id
  useEffect(() => {
    if (!active) return
    const el = rowRefs.current.get(active)
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
  }, [active, reduced])

  if (steps.length <= horizontalMax) {
    return (
      <div data-layout="row">
        <FlowPipeline label={label} stages={steps.map(x => {
          const n = normStatus(x.status)
          return { key: x.id, label: x.label, value: n === 'done' ? '✓' : n === 'failed' ? '✕' : n === 'running' ? '…' : n === 'skipped' ? '–' : '·',
            sub: x.detail, status: WORD[n], state: n === 'done' ? 'done' as const : n === 'failed' ? 'bad' as const : n === 'running' ? 'ok' as const : undefined }
        })} />
      </div>
    )
  }

  const sum = summarise(steps)
  const pct = Math.round((sum.done / steps.length) * 100)
  return (
    <div className={s.wrap} data-layout="list">
      <p className={s.summary} role="status" aria-live="polite" data-failed={sum.failed || undefined}>
        <span>{sum.text}</span>{total > 0 && <span className={s.total}> · {fmtElapsed(total)}</span>}
      </p>
      <div className={s.bar} role="progressbar" aria-label={`${label}: ${sum.done} of ${steps.length} steps done`} aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={sum.done}>
        <span style={{ width: `${pct}%` }} data-failed={sum.failed || undefined} />
      </div>
      <ol className={s.list} aria-label={label}>
        {steps.map(x => {
          const n = normStatus(x.status)
          const ms = elapsed(x)
          return (
            <li key={x.id} className={s.row} data-state={n} data-testid={`run-step-${x.id}`}
              ref={el => { if (el) rowRefs.current.set(x.id, el); else rowRefs.current.delete(x.id) }}
              aria-current={n === 'running' ? 'step' : undefined}>
              <Icon state={n} />
              <div className={s.body}>
                <b>{x.label}<span className={s.srOnly}>, {WORD[n]}</span></b>
                {x.detail && <small className={n === 'failed' ? s.err : s.line}>{x.detail}</small>}
              </div>
              <time className={s.time}>{ms !== null ? fmtElapsed(ms) : ''}</time>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
