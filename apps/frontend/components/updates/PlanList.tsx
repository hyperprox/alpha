'use client'

import type { UpdatesPlan } from '@hyperprox/types'
import { ACTION_LABEL, Notice } from './ui'

export function PlanList({ plan }: { plan: UpdatesPlan }) {
  return (
    <div className="space-y-3">
      {plan.warnings.length > 0 && (
        <Notice tone="warn">
          <ul className="space-y-1">{plan.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </Notice>
      )}
      {plan.steps.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Nothing to do: every managed machine is current.</p>
      ) : (
        <ol className="divide-y rounded-md border" style={{ borderColor: 'var(--border)' }}>
          {plan.steps.map(s => (
            <li key={s.seq} className="flex items-baseline gap-3 px-3 py-1.5 text-sm" style={{ borderColor: 'var(--border-dim)' }}>
              <span className="w-8 shrink-0 text-right font-mono text-xs" style={{ color: 'var(--text-dimmer)' }}>{s.seq}</span>
              <span className="w-28 shrink-0 truncate font-mono text-xs" style={{ color: 'var(--text-bright)' }} title={s.target}>{s.target}</span>
              <span className="w-32 shrink-0 text-xs" style={{ color: 'var(--accent)' }}>{ACTION_LABEL[s.action] ?? s.action}</span>
              <span className="min-w-0 flex-1 truncate text-xs" style={{ color: 'var(--text-muted)' }} title={s.detail}>{s.detail}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
