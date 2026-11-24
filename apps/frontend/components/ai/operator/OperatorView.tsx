'use client'

// =============================================================================
//  HyperProx — the AI operator's tier ladder, spend meter and answer card
//
//  Four tiers as a connected, softly lit ladder: the status is said in words as well as colour. Nothing here
//  moves when the person prefers reduced motion (operator.module.css). Stroke icons only.
// =============================================================================

import s from './operator.module.css'
import {
  TIERS, TIER_BLURB, chainText, ladderState, ladderWord, spendPercent, spendSentence, spendTone, tierWord, usd, usedSentence,
  type OperatorResult, type Spend, type Tier, type TierStatus,
} from '@/lib/operator-view'

function TierIcon({ tier }: { tier: Tier }) {
  const p = { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  if (tier === 'local') return <svg {...p}><rect x="3" y="4" width="14" height="5" rx="1.5" /><rect x="3" y="11" width="14" height="5" rx="1.5" /><path d="M6 6.5h.01M6 13.5h.01" /></svg>
  if (tier === 'haiku') return <svg {...p}><path d="M3 12c3-6 6-6 14-7-1 7-5 10-10 10" /><path d="M3 17l5-6" /></svg>
  if (tier === 'sonnet') return <svg {...p}><path d="M10 2.5v15M4 6l12 8M16 6L4 14" /></svg>
  return <svg {...p}><path d="M10 2.5l2.3 4.8 5.2.7-3.8 3.6.9 5.2L10 14.3 5.4 16.8l.9-5.2L2.5 8l5.2-.7z" /></svg>
}

export function Ladder({ tiers }: { tiers: TierStatus[] }) {
  const byTier = new Map(tiers.map(t => [t.tier, t]))
  return (
    <ol className={s.ladder} aria-label="The four tiers, cheapest first">
      {TIERS.map((t, i) => {
        const st = byTier.get(t)
        const state = st ? ladderState(st) : 'off'
        return (
          <li key={t} className={`${s.rung} ${s[`rung-${state}`]}`}>
            {i > 0 && <span className={s.link} aria-hidden />}
            <span className={s.node}><TierIcon tier={t} /></span>
            <span className={s.rungText}>
              <b className={s.rungName}>{tierWord(t)}</b>
              <span className={s.rungState}>{st ? ladderWord(st) : 'Loading'}</span>
              <span className={s.rungModel}>{st?.model ?? ''}</span>
              <span className={s.rungBlurb}>{TIER_BLURB[t]}</span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

export function SpendMeter({ spend }: { spend: Spend }) {
  const pct = spendPercent(spend)
  return (
    <div className={s.meter}>
      <div className={s.meterTop}>
        <span className={s.label}>Spent this month (estimate)</span>
        <b className={s.meterFigure}>{usd(spend.monthUsd)}</b>
      </div>
      {pct !== null && (
        <div className={`${s.bar} ${s[`bar-${spendTone(pct)}`]}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Share of the monthly cap used">
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
      <p className={s.hint}>{spendSentence(spend)}</p>
    </div>
  )
}

export function AnswerCard({ result, onApprove, busy }: { result: OperatorResult; onApprove?: () => void; busy?: boolean }) {
  if (result.status === 'refused') {
    return (
      <div className={`${s.answer} ${s.answerWarn}`} role="alert">
        <p className={s.answerText}>{result.message}</p>
        {result.notes.map(n => <p key={n} className={s.hint}>{n}</p>)}
      </div>
    )
  }
  if (result.status === 'needs_approval') {
    return (
      <div className={`${s.answer} ${s.answerWarn}`}>
        <span className={s.badge}>Opus is waiting for your OK</span>
        {result.partial && <p className={s.hint}>{`${tierWord(result.partial.tier)} said (not sure): ${result.partial.answer}`}</p>}
        <p className={s.answerText}>{result.reason}</p>
        <p className={s.label}>What would be sent</p>
        <pre className={s.preview}>{result.promptPreview}</pre>
        <button type="button" className={s.primary} onClick={onApprove} disabled={busy}>Approve and ask Opus</button>
        <p className={s.hint}>{`This approval works once and expires in five minutes. Tried so far: ${chainText(result.chain)}.`}</p>
      </div>
    )
  }
  return (
    <div className={s.answer}>
      <div className={s.badges}>
        <span className={s.badge}>{tierWord(result.tier)}</span>
        <span className={s.badgeDim}>{result.model}</span>
        <span className={s.badgeDim}>confidence {result.confidence}</span>
      </div>
      <p className={s.answerText}>{result.answer}</p>
      <p className={s.hint}>{`Tried: ${chainText(result.chain)}. ${result.costUsd > 0 ? `Cost about ${usd(result.costUsd)}.` : 'No cost.'}${result.redacted ? ' Addresses and host names were hidden before it was sent.' : ''}`}</p>
      {usedSentence(result.used) && <p className={s.hint}>{usedSentence(result.used)}</p>}
      {result.drafted && <p className={s.hint}>{`A draft playbook, "${result.drafted.title}", was saved in the Handbook. It waits for your approval.`}</p>}
      {result.notes.map(n => <p key={n} className={s.hint}>{n}</p>)}
    </div>
  )
}
