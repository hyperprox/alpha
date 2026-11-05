'use client'

// Every HA change: ask the server for a preview, show it in words, and apply only that preview's id.
// Applying asks for the master password when the server says so (403 reconfirm_required).

import { useCallback, useState } from 'react'
import { apiJson } from '@/lib/api'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { Btn, Bullets, Dialog, Label, Note } from './ui'
import type { HaApplyResult, HaPlan, RuleProblem } from './types'

export interface Refusal { error: string; problems: RuleProblem[] }

/**
 * const ha = useHaChange(onDone)
 * ha.preview({ action: 'protect', sid })   → opens the dialog, or returns the refusal (with fixes)
 * {ha.dialog}                              → render once
 */
export function useHaChange(onDone?: (r: HaApplyResult) => void) {
  const [plan, setPlan] = useState<HaPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<HaApplyResult | null>(null)
  const [error, setError] = useState('')
  const [reconfirm, setReconfirm] = useState(false)
  const [refusal, setRefusal] = useState<Refusal | null>(null)

  const preview = useCallback(async (change: Record<string, unknown>): Promise<Refusal | null> => {
    setBusy(true); setError(''); setResult(null); setRefusal(null)
    const r = await apiJson<{ data: HaPlan; problems?: RuleProblem[] }>('/api/ha/preview', 'POST', change)
    setBusy(false)
    if (!r.ok) {
      const ref = { error: r.error ?? 'The change could not be checked.', problems: ((r.body as any)?.problems ?? []) as RuleProblem[] }
      setRefusal(ref)
      return ref
    }
    setPlan(r.body!.data)
    return null
  }, [])

  const apply = useCallback(async () => {
    if (!plan) return
    setBusy(true); setError('')
    const r = await apiJson<{ data: HaApplyResult }>(`/api/ha/plans/${encodeURIComponent(plan.id)}/apply`, 'POST', {})
    setBusy(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(true); return }
    if (!r.ok) { setError(r.error ?? 'Not applied.'); return }
    setResult(r.body!.data)
    onDone?.(r.body!.data)
  }, [plan, onDone])

  const close = useCallback(() => { setPlan(null); setResult(null); setError('') }, [])

  const dialog = (
    <>
      {plan && <PlanDialog plan={plan} busy={busy} error={error} result={result} onApply={apply} onClose={close} />}
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(false)} onDone={() => { setReconfirm(false); void apply() }} />}
    </>
  )
  return { preview, dialog, busy, refusal, clearRefusal: () => setRefusal(null) }
}

function PlanDialog({ plan, busy, error, result, onApply, onClose }: { plan: HaPlan; busy: boolean; error: string; result: HaApplyResult | null; onApply: () => void; onClose: () => void }) {
  const [advanced, setAdvanced] = useState(false)
  return (
    <Dialog title={plan.title} onClose={onClose} wide>
      <div className="space-y-1.5"><Label>What changes</Label><Bullets items={plan.changes} /></div>
      <div className="space-y-1.5"><Label>What happens when you apply it</Label><Bullets items={plan.effects} color="var(--text-bright)" /></div>
      {plan.strict && <Note tone="crit">This makes a guest strict: when its nodes are down it does not start anywhere. Only choose this when running on the wrong node is worse than not running at all.</Note>}
      {plan.warnings.map((w, i) => <Note key={i} tone="warn">{w}</Note>)}
      {plan.existing.length > 0 && (
        <div className="space-y-1.5"><Label>Already wrong in the rules (not changed by this)</Label><Bullets items={plan.existing.map(p => p.message)} color="var(--text-muted)" /></div>
      )}
      <button type="button" className="font-mono text-xs underline" style={{ color: 'var(--text-dim)' }} onClick={() => setAdvanced(a => !a)}>
        {advanced ? 'Hide' : 'Advanced: show'} the exact Proxmox calls
      </button>
      {advanced && <pre className="overflow-x-auto rounded-md border p-3 font-mono text-xs" style={{ background: 'var(--ground-inset)', borderColor: 'var(--border)', color: 'var(--text-soft)' }}>{plan.calls.join('\n')}</pre>}
      {error && <Note tone="crit">{error}</Note>}
      {result && <Note tone={result.ok ? 'good' : 'crit'}>{result.message}</Note>}
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <Btn onClick={onClose}>{result ? 'Close' : 'Cancel'}</Btn>
        {!result && <Btn kind={plan.strict ? 'danger' : 'primary'} disabled={busy} onClick={onApply}>{busy ? 'Applying…' : 'Apply'}</Btn>}
      </div>
      {!result && <p className="text-xs" style={{ color: 'var(--text-dim)' }}>The preview is held by HyperProx for ten minutes. If anything in HA changes before you apply it, nothing is done and you are asked to preview again.</p>}
    </Dialog>
  )
}

/** A refused change: the reasons, and a button for each fix HyperProx can preview. */
export function RefusalNote({ refusal, onFix }: { refusal: Refusal; onFix?: (rule: string) => void }) {
  return (
    <Note tone="warn">
      <p>{refusal.problems.length ? 'Proxmox would refuse this, so it was not sent:' : refusal.error}</p>
      {refusal.problems.length > 0 && <ul className="mt-1 list-disc space-y-1 pl-5">{refusal.problems.map((p, i) => (
        <li key={i}>{p.message}{p.fix && onFix && <> <button type="button" className="ml-1 underline" style={{ color: 'var(--accent)' }} onClick={() => onFix(p.fix!.rule)}>Fix: {p.fix.words}</button></>}</li>
      ))}</ul>}
    </Note>
  )
}
