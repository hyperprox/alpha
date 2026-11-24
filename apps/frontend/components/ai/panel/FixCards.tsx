'use client'

// Proposed fixes, as cards. The operator proposes; it never acts. A card's button calls the Arr Stack queue's own action
// route (which checks the role, asks for the confirmation and writes the audit row), and only after a click here.
// A fix that removes and re-searches is previewed first, so the card says exactly what it would do before the second click.

import { useState } from 'react'
import { apiJson } from '@/lib/api'
import { FIX_URL, DESTRUCTIVE_FIX, fixBody, planWords, type FixProposal } from '@/lib/ai-panel'
import s from './panel.module.css'

type Phase = 'idle' | 'checking' | 'confirm' | 'running' | 'done' | 'error'

function FixCard({ p, canAct }: { p: FixProposal; canAct: boolean }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [words, setWords] = useState('')
  const needsReview = DESTRUCTIVE_FIX(p.action)

  const run = async () => {
    setPhase('running')
    const r = await apiJson<{ data: { summary?: string } }>(FIX_URL, 'POST', fixBody(p, 'run'))
    if (!r.ok) { setWords(r.error ?? 'That did not work.'); setPhase('error'); return }
    setWords(r.body?.data?.summary ?? 'Done.'); setPhase('done')
  }
  const start = async () => {
    if (!needsReview) { await run(); return }
    setPhase('checking')
    const r = await apiJson<{ data: { plan?: any } }>(FIX_URL, 'POST', fixBody(p, 'preview'))
    if (!r.ok) { setWords(r.error ?? 'It could not be checked.'); setPhase('error'); return }
    setWords(planWords(r.body?.data?.plan)); setPhase('confirm')
  }

  return (
    <div className={s.fix} data-phase={phase}>
      <b className={s.fixTitle}>{p.title}</b>
      <span className={s.fixItem}>{p.item}</span>
      {phase === 'idle' && (canAct
        ? <button type="button" className={s.fixBtn} onClick={() => void start()}>{needsReview ? 'Review this fix' : p.title}</button>
        : <span className={s.fixNote}>Needs the admin role.</span>)}
      {phase === 'checking' && <span className={s.fixNote} role="status">Checking what it would do...</span>}
      {phase === 'confirm' && (
        <>
          <p className={s.fixWords}>{words}</p>
          <div className={s.fixRow}>
            <button type="button" className={s.fixBtn} onClick={() => void run()}>Confirm: {p.title.toLowerCase()}</button>
            <button type="button" className={s.fixGhost} onClick={() => setPhase('idle')}>Cancel</button>
          </div>
        </>
      )}
      {phase === 'running' && <span className={s.fixNote} role="status">Working...</span>}
      {phase === 'done' && <p className={s.fixWords} role="status">{words}</p>}
      {phase === 'error' && <p className={s.fixWords} role="alert">{words} <button type="button" className={s.fixGhost} onClick={() => setPhase('idle')}>Try again</button></p>}
    </div>
  )
}

export function FixCards({ proposals, canAct }: { proposals: FixProposal[] | undefined; canAct: boolean }) {
  if (!proposals?.length) return null
  return (
    <div className={s.fixes} aria-label="Proposed fixes">
      <span className={s.fixesLabel}>Proposed fixes. Nothing runs until you confirm.</span>
      {proposals.map(p => <FixCard key={p.action} p={p} canAct={canAct} />)}
    </div>
  )
}
