'use client'

import { useState } from 'react'
import type { UpdatesJob, UpdatesPlan } from '@hyperprox/types'
import { itemViews } from '@/lib/update-targets'
import { ACTION_LABEL, Notice, StepIcon } from './ui'
import { StepList } from './JobPanel'

/** The order a selection runs in: each chosen item, numbered, with its steps and what it waits for. */
export function ItemOrder({ plan }: { plan: UpdatesPlan }) {
  const items = plan.items ?? []
  return (
    <div className="space-y-3">
      {!!plan.refused?.length && (
        <Notice tone="warn">
          <p className="mb-1 font-semibold">Not planned ({plan.refused.length}):</p>
          <ul className="space-y-1" data-refused>{plan.refused.map(r => <li key={r.id}><span className="font-mono text-xs">{r.id}</span> — {r.reason}</li>)}</ul>
        </Notice>
      )}
      {plan.warnings.filter(w => !w.startsWith('Not planned: ')).length > 0 && (
        <Notice tone="info"><ul className="space-y-1">{plan.warnings.filter(w => !w.startsWith('Not planned: ')).map((w, i) => <li key={i}>{w}</li>)}</ul></Notice>
      )}
      {items.length === 0 ? <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Nothing chosen can run.</p> : (
        <ol className="divide-y rounded-md border" style={{ borderColor: 'var(--border)' }} aria-label="Order of the run" data-order>
          {items.map((it, n) => (
            <li key={it.id} className="px-3 py-2" style={{ borderColor: 'var(--border-dim)' }} data-item={it.id}>
              <div className="flex items-baseline gap-3 text-sm">
                <span className="w-6 shrink-0 text-right font-mono text-xs" style={{ color: 'var(--text-dimmer)' }}>{n + 1}</span>
                <span className="min-w-0 flex-1" style={{ color: 'var(--text-bright)' }}>{it.label}</span>
              </div>
              <div className="ml-9 mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                {it.seqs.map(q => plan.steps.find(s => s.seq === q)).filter(Boolean).map(s => ACTION_LABEL[s!.action] ?? s!.action).join(' → ')}
                {it.dependsOn.length > 0 && <span> · only if {it.dependsOn.map(d => items.find(i => i.id === d)?.label ?? d).join(', ')} finish{it.dependsOn.length === 1 ? 'es' : ''}</span>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

/** A run of chosen targets, item by item: live status, why one stopped, and its steps and log on request. */
export function ItemResults({ job, onRollback }: { job: Pick<UpdatesJob, 'plan' | 'steps' | 'report'>; onRollback?: (target: string) => void }) {
  const views = itemViews(job)
  const [open, setOpen] = useState<string | null>(null)
  if (!views.length) return null
  return (
    <ol className="divide-y rounded-md border" style={{ borderColor: 'var(--border)' }} aria-label="Each chosen item" data-items>
      {views.map(v => (
        <li key={v.id} style={{ borderColor: 'var(--border-dim)' }} data-item={v.id} data-status={v.status}>
          <div className="flex items-center gap-3 px-3 py-1.5 text-sm">
            <StepIcon status={v.status} />
            <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text-bright)' }} title={v.label}>{v.label}</span>
            <span className="sr-only">, {v.status}</span>
            {v.reason && <span className="min-w-0 max-w-[50%] truncate text-xs" style={{ color: v.status === 'failed' ? 'var(--crit-soft)' : 'var(--text-muted)' }} title={v.reason}>{v.reason}</span>}
            {v.steps.length > 0 && (
              <button type="button" onClick={() => setOpen(open === v.id ? null : v.id)} aria-expanded={open === v.id}
                      className="shrink-0 text-xs underline-offset-2 hover:underline" style={{ color: 'var(--text-soft)' }}>
                {open === v.id ? 'hide' : `${v.steps.length} step${v.steps.length === 1 ? '' : 's'}`}
              </button>
            )}
          </div>
          {open === v.id && <div className="px-3 pb-2"><StepList steps={v.steps} onRollback={onRollback} /></div>}
        </li>
      ))}
    </ol>
  )
}
