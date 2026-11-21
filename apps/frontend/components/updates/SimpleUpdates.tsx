'use client'

// The default Updates view, built for a phone: one status line, one big button, one switch, and a plain list of
// machines while it runs. Everything else lives under "Advanced" on the page (nothing was removed).

import type { UpdatesJob } from '@hyperprox/types'
import { Btn, Notice } from './ui'
import { finishedLine, progressOf, type ProgressRow, type StatusLine } from '@/lib/updates-simple'

const TONE: Record<StatusLine['tone'], string> = { good: 'var(--good)', warn: 'var(--warn-2)', crit: 'var(--crit)', muted: 'var(--text-bright)' }
const MARK: Record<ProgressRow['state'], string> = { done: '✓', working: '…', waiting: '·', failed: '!' }

export interface SimpleProps {
  status: StatusLine
  /** The Update now button: its label while a check or a run is under way, and whether it can be pressed. */
  buttonLabel: string
  canUpdate: boolean
  onUpdateNow: () => void
  message: { tone: 'warn' | 'crit' | 'info'; text: string } | null
  /** null when the switch does not apply (a remote cluster) or could not be read. */
  auto: { enabled: boolean; line: string; canChange: boolean } | null
  onToggleAuto: (on: boolean) => void
  job: UpdatesJob | null
  lastJob: UpdatesJob | null
  /** Paused or waiting for an OK: the only controls a simple view needs. */
  onJobAction: (verb: 'confirm' | 'resume' | 'cancel') => void
  busy: boolean
}

export function SimpleUpdates(p: SimpleProps) {
  const rows = progressOf(p.job)
  const done = !p.job ? finishedLine(p.lastJob) : null
  return (
    <section aria-label="Updates" className="space-y-4 rounded-[14px] border p-5" style={{ background: 'var(--surface)', borderColor: 'var(--hx-line)' }}>
      <div role="status" aria-live="polite">
        <p className="font-display font-semibold" style={{ fontSize: 26, lineHeight: 1.15, color: TONE[p.status.tone] }}>{p.status.text}</p>
        {p.status.sub && <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>{p.status.sub}</p>}
      </div>

      <Btn kind="primary" onClick={p.onUpdateNow} disabled={!p.canUpdate || p.busy}>
        <span className="block w-full py-1 text-base">{p.buttonLabel}</span>
      </Btn>

      {p.message && <Notice tone={p.message.tone}>{p.message.text}</Notice>}

      {rows.length > 0 && (
        <ul className="grid gap-1.5 text-sm" aria-label="Machines in this update">
          {rows.map(r => (
            <li key={r.name} className="flex items-center gap-2" style={{ color: r.state === 'failed' ? 'var(--crit)' : r.state === 'waiting' ? 'var(--text-muted)' : 'var(--text)' }}>
              <span className="font-mono" style={{ width: 16, textAlign: 'center' }} aria-hidden>{MARK[r.state]}</span>
              <span>{r.name}</span>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{r.state === 'done' ? 'done' : r.state === 'working' ? 'updating' : r.state === 'failed' ? 'needs a look' : 'waiting'}</span>
            </li>
          ))}
        </ul>
      )}

      {p.job?.status === 'paused' && (
        <div className="flex flex-wrap gap-2">
          <Btn kind="primary" small onClick={() => p.onJobAction('resume')} disabled={p.busy}>Try again</Btn>
          <Btn small onClick={() => p.onJobAction('cancel')} disabled={p.busy}>Stop here</Btn>
        </div>
      )}
      {p.job?.status === 'awaiting-confirm' && (
        <div className="flex flex-wrap gap-2">
          <Btn kind="primary" small onClick={() => p.onJobAction('confirm')} disabled={p.busy}>Go ahead</Btn>
          <Btn small onClick={() => p.onJobAction('cancel')} disabled={p.busy}>Cancel it</Btn>
        </div>
      )}

      {done && <p className="text-sm" style={{ color: 'var(--text-soft)' }}>{done}</p>}

      {p.auto && (
        <div className="flex items-start gap-3 border-t pt-4" style={{ borderColor: 'var(--hx-line)' }}>
          <button type="button" role="switch" aria-checked={p.auto.enabled} aria-label="Install updates automatically"
                  disabled={!p.auto.canChange || p.busy} onClick={() => p.onToggleAuto(!p.auto!.enabled)}
                  className="mt-0.5 h-6 w-11 shrink-0 rounded-full border transition-colors"
                  style={{ background: p.auto.enabled ? 'var(--accent)' : 'transparent', borderColor: 'var(--hx-line)' }}>
            <span className="block h-4 w-4 rounded-full transition-transform" style={{ background: p.auto.enabled ? 'var(--accent-ink, #fff)' : 'var(--text-muted)', transform: `translateX(${p.auto.enabled ? 22 : 3}px)` }} />
          </button>
          <div className="text-sm">
            <p style={{ color: 'var(--text-bright)' }}>Install updates automatically</p>
            <p style={{ color: 'var(--text-muted)' }}>{p.auto.enabled ? p.auto.line : `Off. When on: ${p.auto.line.charAt(0).toLowerCase()}${p.auto.line.slice(1)}`}</p>
          </div>
        </div>
      )}
    </section>
  )
}
