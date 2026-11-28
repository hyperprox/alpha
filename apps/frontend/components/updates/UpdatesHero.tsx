'use client'

// The top card of the Updates page, one per cluster: the verdict, three numbers, the two banners that only appear
// when they matter, ONE Update now button (it opens the ordered plan and asks before anything changes), the
// machines of a run while it goes, and the last run. Everything else sits below it or under Advanced.

import type { UpdatesJob } from '@hyperprox/types'
import { Btn, Notice } from './ui'
import { finishedLine, progressOf, type ProgressRow, type StatusLine } from '@/lib/updates-simple'
import type { HeroNumbers } from '@/lib/updates-overview'

const TONE: Record<StatusLine['tone'], string> = { good: 'var(--good)', warn: 'var(--warn-2)', crit: 'var(--crit)', muted: 'var(--text-bright)' }
const MARK: Record<ProgressRow['state'], string> = { done: '✓', working: '…', waiting: '·', failed: '!' }

export interface HeroProps {
  /** "Updates · <cluster name>", with the cluster tag beside it. */
  eyebrow: string
  tag?: React.ReactNode
  status: StatusLine
  numbers: HeroNumbers
  /** What the third number says: the next automatic install, "off" or "by hand". */
  nextRun: string
  /** The machines have not been read yet (the numbers show a dash, not zero). */
  reading: boolean
  heldBanner: string | null
  rebootBanner: string | null
  /** The Update now button: its label while a check or a run is under way, and whether it can be pressed. */
  buttonLabel: string
  canUpdate: boolean
  onUpdateNow: () => void
  message: { tone: 'warn' | 'crit' | 'info'; text: string } | null
  job: UpdatesJob | null
  lastJob: UpdatesJob | null
  /** Paused or waiting for an OK: the only controls the hero needs. */
  onJobAction: (verb: 'confirm' | 'resume' | 'cancel') => void
  busy: boolean
}

function Stat({ value, label, sub, tone, text }: { value: React.ReactNode; label: string; sub?: string; tone?: 'warn' | 'crit' | 'good'; text?: boolean }) {
  const color = tone === 'crit' ? 'var(--crit)' : tone === 'warn' ? 'var(--warn-2)' : tone === 'good' ? 'var(--good)' : 'var(--text-bright)'
  return (
    <div className="min-w-0 rounded-[10px] border p-2.5" style={{ background: 'var(--ground-inset)', borderColor: 'var(--hx-line)' }}>
      <dd className="m-0 break-words font-display font-bold" style={{ fontSize: text ? 16 : 24, lineHeight: 1.2, color }}>{value}</dd>
      <dt className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</dt>
      {sub && <span className="block text-[11px]" style={{ color: 'var(--text-dim)' }}>{sub}</span>}
    </div>
  )
}

export function UpdatesHero(p: HeroProps) {
  const rows = progressOf(p.job)
  const done = !p.job ? finishedLine(p.lastJob) : null
  const n = p.numbers
  const dash = p.reading ? '…' : undefined
  return (
    <section aria-label="Updates" className="space-y-4 rounded-[14px] border p-4 sm:p-5" style={{ background: 'var(--surface)', borderColor: 'var(--hx-line)' }}>
      <p className="flex flex-wrap items-center gap-2 font-mono uppercase" style={{ fontSize: 11, letterSpacing: '0.14em', color: 'var(--accent)' }}>{p.eyebrow}{p.tag}</p>
      <div role="status" aria-live="polite">
        <p className="mt-1 font-display font-semibold" style={{ fontSize: 28, lineHeight: 1.12, color: TONE[p.status.tone] }}>{p.status.text}</p>
        {p.status.sub && <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>{p.status.sub}</p>}
      </div>

      <dl className="grid grid-cols-3 gap-2" aria-label="Where this cluster stands">
        <Stat value={dash ?? n.behind} label="machines behind" sub={!p.reading && n.total ? `of ${n.total}` : undefined} tone={p.reading ? undefined : n.behind ? 'warn' : 'good'} />
        <Stat value={dash ?? n.securityMachines} label="machines with security fixes" sub={!p.reading && n.securityPackages ? `${n.securityPackages} security packages` : undefined} tone={p.reading ? undefined : n.securityMachines ? 'crit' : 'good'} />
        <Stat value={p.nextRun} label={p.nextRun === 'by hand' ? 'installs' : 'next automatic install'} text />
      </dl>

      {p.heldBanner && (
        <div className="rounded-[10px] border px-3 py-2 text-sm" style={{ background: 'var(--surface-notice)', borderColor: 'var(--warn)', color: 'var(--warn-2)' }}>
          <b>Held by policy:</b> {p.heldBanner}
        </div>
      )}
      {p.rebootBanner && (
        <div className="rounded-[10px] border px-3 py-2 text-sm" style={{ background: 'var(--ground-inset)', borderColor: 'var(--accent)', color: 'var(--text)' }}>
          <b>Reboots needed:</b> {p.rebootBanner}
        </div>
      )}

      <div className="space-y-2">
        <Btn kind="primary" onClick={p.onUpdateNow} disabled={!p.canUpdate || p.busy} className="w-full">
          <span className="block w-full py-1 text-base">{p.buttonLabel}</span>
        </Btn>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Shows the order and asks you to confirm before anything changes. Guests get a snapshot first where possible.</p>
      </div>

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

      {done && <p className="border-t pt-3 text-sm" style={{ color: 'var(--text-soft)', borderColor: 'var(--hx-line)' }}>{done}</p>}
    </section>
  )
}
