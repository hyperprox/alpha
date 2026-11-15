'use client'

// Running a balancing plan: the moves as the server worked them out, what each costs, and the quiet window. "Run now"
// is offered only in a quiet window long enough for the whole plan; otherwise "Schedule for the next quiet window".
// The master password is asked once for the whole plan (403 reconfirm_required); the server then runs the moves one
// at a time, checking each again right before it runs, and stops on any change or failure. The moves sent back are
// the ones shown: if the server's plan differs, nothing runs and the new plan is shown instead.

import { useCallback, useState } from 'react'
import { apiJson } from '@/lib/api'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { Btn, Dialog, Note } from '@/components/ha/ui'
import { quietWords, seconds } from './logic'
import { planChoices, stepLine, GOAL_WORD } from './balance-logic'
import type { BalancePlan, BalanceView, PlanRecord } from './types'

export function PlanDialog({ view, onClose, onStarted }: { view: BalanceView; onClose: () => void; onStarted: (p: PlanRecord) => void }) {
  const [plan, setPlan] = useState<BalancePlan>(view.plan)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reconfirm, setReconfirm] = useState<null | 'now' | 'next-quiet'>(null)
  const choices = planChoices({ plan, quiet: view.quiet, running: view.running })

  const go = useCallback(async (when: 'now' | 'next-quiet') => {
    setBusy(true); setError('')
    const r = await apiJson<{ data: PlanRecord }>('/api/placement/plans', 'POST', { when, goal: plan.goal, expect: plan.steps.map(s => ({ sid: s.sid, to: s.to })) })
    setBusy(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(when); return }
    if (r.status === 409 && r.code === 'changed' && (r.body as any)?.plan) {
      setPlan((r.body as any).plan); setError('The plan changed since the page was read. This is the new one: look it over and run it again.'); return
    }
    if (!r.ok || !r.body) { setError(r.error ?? 'The plan did not start.'); return }
    onStarted(r.body.data)
  }, [plan, onStarted])

  return (
    <Dialog title={`Balance the cluster by ${GOAL_WORD[plan.goal]}`} onClose={onClose} wide>
      <div className="space-y-3">
        <p className="text-sm" style={{ color: 'var(--text-bright)' }}>
          Score {Math.round(plan.score.score)} → {Math.round(plan.target.score)} with {plan.steps.length} move{plan.steps.length === 1 ? '' : 's'}, one at a time, about {seconds(plan.needSec)} in all.
        </p>
        <ol className="list-decimal space-y-1 pl-5 text-sm" style={{ color: 'var(--text-soft)' }}>{plan.steps.map(s => <li key={s.sid}>{stepLine(s)}</li>)}</ol>
        <Note tone={view.quiet.quietNow ? 'good' : 'warn'}>{quietWords(view.quiet)}</Note>
        <ul className="list-disc space-y-0.5 pl-5 text-[13px]" style={{ color: 'var(--text-dim)' }}>
          <li>Each move goes through the same checks as a single move, again right before it runs, and is recorded in the audit log.</li>
          <li>The plan stops if a move fails, or if the cluster changes: a node goes down, quorum is lost, Ceph shows a warning it did not have now, or a move no longer evens the load out.</li>
          <li>A running container restarts when it moves. A VM moves live.</li>
        </ul>
        {error && <Note tone="crit">{error}</Note>}
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Btn onClick={onClose}>Cancel</Btn>
          {choices.includes('schedule') && <Btn kind={choices.includes('now') ? 'ghost' : 'primary'} disabled={busy} onClick={() => go('next-quiet')}>Schedule for the next quiet window</Btn>}
          {choices.includes('now') && <Btn kind="primary" disabled={busy} onClick={() => go('now')}>{busy ? 'Starting…' : 'Run now'}</Btn>}
        </div>
        {!choices.length && <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{view.running ? 'A plan is already running.' : 'No quiet window is known in the next week, so the plan cannot run.'}</p>}
      </div>
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const w = reconfirm; setReconfirm(null); void go(w) }} />}
    </Dialog>
  )
}
