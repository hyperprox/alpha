'use client'

import { useEffect, useRef, useState } from 'react'
import type { UpdatesJob, UpdatesStep } from '@hyperprox/types'
import { ACTION_LABEL, Badge, Btn, Notice, Panel, StepIcon, fmtTime } from './ui'
import { PlanList } from './PlanList'

export type LogLine = { stepId: string; line: string }

const STATUS_TONE: Record<string, 'accent' | 'good' | 'warn' | 'crit' | 'muted'> = {
  'planned': 'muted', 'awaiting-confirm': 'warn', 'running': 'accent', 'paused': 'warn', 'failed': 'crit', 'done': 'good', 'cancelled': 'muted',
}

export function StepList({ steps }: { steps: UpdatesStep[] }) {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <ol className="divide-y rounded-md border" style={{ borderColor: 'var(--border)' }}>
      {steps.map(s => {
        const more = !!(s.output || s.reason)
        return (
          <li key={s.id} style={{ borderColor: 'var(--border-dim)' }}>
            <div className="flex items-center gap-3 px-3 py-1.5 text-sm">
              <StepIcon status={s.status} />
              <span className="w-7 shrink-0 text-right font-mono text-xs" style={{ color: 'var(--text-dimmer)' }}>{s.seq}</span>
              <span className="w-24 shrink-0 truncate font-mono text-xs" style={{ color: 'var(--text-bright)' }} title={s.target}>{s.target}</span>
              <span className="w-32 shrink-0 text-xs" style={{ color: 'var(--accent)' }}>{ACTION_LABEL[s.action] ?? s.action}</span>
              <span className="min-w-0 flex-1 truncate text-xs" style={{ color: s.status === 'failed' ? 'var(--crit-soft)' : 'var(--text-muted)' }} title={s.reason ?? s.detail}>
                {s.reason ?? s.detail}
              </span>
              {s.output && (
                <button type="button" onClick={() => setOpen(open === s.id ? null : s.id)} aria-expanded={open === s.id}
                        className="shrink-0 text-xs underline-offset-2 hover:underline" style={{ color: 'var(--text-soft)' }}>
                  output
                </button>
              )}
            </div>
            {more && open === s.id && s.output && (
              <pre className="max-h-64 overflow-auto px-3 py-2 font-mono text-xs" style={{ background: 'var(--ground-inset)', color: 'var(--text)' }}>{s.output}</pre>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function LogTail({ lines, steps }: { lines: LogLine[]; steps: UpdatesStep[] }) {
  const el = useRef<HTMLPreElement>(null)
  const pinned = useRef(true)
  // Follow the tail only while the reader is at the bottom; scrolling up to read must not be yanked back.
  useEffect(() => { const e = el.current; if (e && pinned.current) e.scrollTop = e.scrollHeight }, [lines])
  const label = (id: string) => { const s = steps.find(x => x.id === id); return s ? `${s.target}` : '' }
  return (
    <pre ref={el} tabIndex={0} aria-label="Live log" aria-live="off"
         onScroll={e => { const t = e.currentTarget; pinned.current = t.scrollHeight - t.scrollTop - t.clientHeight < 24 }}
         className="h-56 overflow-auto rounded-md border px-3 py-2 font-mono text-xs"
         style={{ background: 'var(--ground-inset)', borderColor: 'var(--border)', color: 'var(--text)' }}>
      {lines.length === 0
        ? <span style={{ color: 'var(--text-dimmer)' }}>Waiting for output...</span>
        : lines.map((l, i) => <div key={i}><span style={{ color: 'var(--text-dimmer)' }}>{label(l.stepId)} </span>{l.line}</div>)}
    </pre>
  )
}

export function JobPanel({ job, logs, busy, onConfirm, onCancel, onResume }: {
  job: UpdatesJob
  logs: LogLine[]
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
  onResume: () => void
}) {
  const awaiting = job.status === 'awaiting-confirm'
  const done = job.steps.filter(s => s.status === 'ok' || s.status === 'skipped').length
  return (
    <Panel
      title={awaiting ? 'Confirm this run' : 'Active job'}
      right={
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[job.status] ?? 'muted'}>{job.status}</Badge>
          <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>{job.trigger} · started {fmtTime(job.startedAt)}</span>
          {!awaiting && job.steps.length > 0 && <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>{done}/{job.steps.length} steps</span>}
        </div>
      }
    >
      <div className="space-y-4 p-5">
        {job.status === 'paused' && (
          <Notice tone="warn">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span><strong>Paused.</strong> {job.pauseReason ?? 'A gate failed between steps.'} Nothing further runs until you resume.</span>
              <Btn small onClick={onResume} disabled={busy}>Resume</Btn>
            </div>
          </Notice>
        )}
        {awaiting ? (
          <>
            <p className="text-sm" style={{ color: 'var(--text-soft)' }}>Preflight and refresh passed. This is the plan; nothing has been changed yet.</p>
            <PlanList plan={job.plan} />
            <div className="flex gap-2">
              <Btn kind="primary" onClick={onConfirm} disabled={busy}>Confirm and run</Btn>
              <Btn onClick={onCancel} disabled={busy}>Cancel</Btn>
            </div>
          </>
        ) : (
          <>
            {job.steps.length > 0 ? <StepList steps={job.steps} /> : <PlanList plan={job.plan} />}
            <LogTail lines={logs} steps={job.steps} />
            {(job.status === 'running' || job.status === 'paused') && (
              <div className="flex items-center gap-3">
                <Btn kind="danger" onClick={onCancel} disabled={busy}>Cancel</Btn>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Stops after the current step finishes; it does not roll anything back.</span>
              </div>
            )}
          </>
        )}
      </div>
    </Panel>
  )
}
