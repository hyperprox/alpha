'use client'

// =============================================================================
//  HyperProx — the AI side panel
//
//  On the right of every page: the operator (ask, with the page and any item you pointed at) and the assistant (plan and
//  deploy). It resizes, folds to a rail, and keeps the conversation while you move around. At 768 px and below it is a
//  floating button that opens a full-height sheet. A slow local answer shows a working line with the seconds; the page
//  stays usable meanwhile because the request runs in the background.
// =============================================================================

import { useEffect, useRef, useState, type KeyboardEvent as KE, type PointerEvent as PE } from 'react'
import { AnswerCard } from '@/components/ai/operator/OperatorView'
import { AssistantChat } from '@/components/ai/AssistantChat'
import { FixCards } from './FixCards'
import { useAiPanel, type Msg, type PanelTab } from './PanelProvider'
import { TIERS, spendPercent, spendTone, tierWord, usd, type Tier } from '@/lib/operator-view'
import { ITEM_CHIPS, PANEL_MIN, RAIL_WIDTH, maxWidthFor, workingWords } from '@/lib/ai-panel'
import s from './panel.module.css'

const DEMO = process.env.NEXT_PUBLIC_HYPERPROX_DEMO === '1'

const Sparkle = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M10 2.5l1.7 4.6 4.8 1.7-4.8 1.7L10 15.1l-1.7-4.6L3.5 8.8l4.8-1.7z" /><path d="M15.5 14.5v3M14 16h3" />
  </svg>
)
const Chevron = ({ dir }: { dir: 'left' | 'right' | 'down' }) => (
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={dir === 'left' ? 'M12 4l-6 6 6 6' : dir === 'right' ? 'M8 4l6 6-6 6' : 'M4 8l6 6 6-6'} />
  </svg>
)

function SpendLine() {
  const { spend } = useAiPanel()
  if (!spend) return null
  const pct = spendPercent(spend)
  return (
    <div className={s.spend} title="Estimated from token counts, not billed.">
      <span>{spend.capUsd > 0 ? `${usd(spend.monthUsd)} of ${usd(spend.capUsd)} this month` : `${usd(spend.monthUsd)} this month (no cap)`}</span>
      {pct !== null && <span className={`${s.spendBar} ${s[`spend-${spendTone(pct)}`]}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Share of the monthly cap used"><i style={{ width: `${pct}%` }} /></span>}
    </div>
  )
}

function Working() {
  const { pending } = useAiPanel()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { if (!pending) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [pending])
  if (!pending) return null
  return (
    <div className={s.working} role="status" aria-live="polite">
      <span className={s.dots} aria-hidden><i /><i /><i /></span>
      <span>{workingWords((now - pending.startedAt) / 1000, pending.tier)}</span>
    </div>
  )
}

function Message({ m }: { m: Msg }) {
  const p = useAiPanel()
  if (m.role === 'user') {
    return (
      <div className={s.userMsg}>
        {m.item && <span className={s.userItem}>{m.item.title}</span>}
        <span>{m.text}</span>
      </div>
    )
  }
  if (!m.result) return <div className={s.errMsg} role="alert">{m.text}</div>
  const r = m.result
  return (
    <AnswerCard result={r} busy={!!p.pending || !!m.used}
      onApprove={r.status === 'needs_approval' && !m.used ? () => void p.approve(m) : undefined}
      onRetry={r.status === 'refused' && !m.used ? t => void p.retry(m, t) : undefined}
      extra={r.status === 'answered' ? <FixCards proposals={r.proposals} canAct={p.canAsk} /> : undefined} />
  )
}

function AskTab() {
  const p = useAiPanel()
  const [text, setText] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => { if (list.current) list.current.scrollTop = list.current.scrollHeight }, [p.messages, p.pending])
  useEffect(() => { if (p.focusTick) box.current?.focus() }, [p.focusTick])
  const submit = () => { const t = text.trim(); if (!t || p.pending || !p.canAsk) return; setText(''); void p.send(t) }
  const onKey = (e: KE<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }
  return (
    <div className={s.askTab}>
      <div className={s.list} ref={list}>
        {p.messages.length === 0 && (
          <div className={s.empty}>
            <b>Ask about anything on this page.</b>
            <span>The AI knows which page you are on. Point it at one item with &quot;Ask about this&quot; where you see it.</span>
          </div>
        )}
        {p.messages.map(m => <Message key={m.id} m={m} />)}
        <Working />
      </div>
      {!p.canAsk && <p className={s.notice} role="status">Asking the AI needs the admin role.</p>}
      <div className={s.context} aria-label="What the question is about">
        <span className={s.ctxChip}>On: {p.page}</span>
        {p.item && <span className={`${s.ctxChip} ${s.ctxItem}`}>{p.item.title}<button type="button" onClick={p.clearItem} aria-label="Stop asking about this item">×</button></span>}
      </div>
      {p.item && p.canAsk && !p.pending && (
        <div className={s.chips}>{ITEM_CHIPS.map(c => <button key={c} type="button" onClick={() => void p.send(c)}>{c}</button>)}</div>
      )}
      <div className={s.composer}>
        <textarea ref={box} rows={2} maxLength={7000} value={text} onChange={e => setText(e.target.value)} onKeyDown={onKey} disabled={!p.canAsk}
          placeholder={p.item ? `Ask about ${p.item.title}...` : 'Ask the AI...'} aria-label="Your question" />
        <div className={s.composerRow}>
          <label className={s.force}>
            <span>Tier</span>
            <select value={p.force} onChange={e => p.setForce(e.target.value as 'auto' | Tier)} aria-label="Force a tier">
              <option value="auto">Automatic</option>
              {TIERS.map(t => <option key={t} value={t}>Always {tierWord(t)}</option>)}
            </select>
          </label>
          <button type="button" className={s.send} onClick={submit} disabled={!text.trim() || !!p.pending || !p.canAsk}>{p.pending ? 'Working...' : 'Ask'}</button>
        </div>
      </div>
    </div>
  )
}

function Body({ onClose, onCollapse }: { onClose?: () => void; onCollapse?: () => void }) {
  const p = useAiPanel()
  const tabs: Array<[PanelTab, string]> = [['ask', 'Ask'], ['assistant', 'Assistant']]
  return (
    <>
      <header className={s.head}>
        <span className={s.title}><Sparkle /> AI</span>
        <div className={s.tabs} role="tablist" aria-label="AI panel">
          {tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={p.tab === id} onClick={() => p.setTab(id)}>{label}</button>)}
        </div>
        {p.messages.length > 0 && p.tab === 'ask' && <button type="button" className={s.textBtn} onClick={p.clear} disabled={!!p.pending}>Clear</button>}
        {onCollapse && <button type="button" className={s.iconBtn} onClick={onCollapse} aria-label="Fold the AI panel to the side"><Chevron dir="right" /></button>}
        {onClose && <button type="button" className={s.iconBtn} onClick={onClose} aria-label="Close the AI panel"><Chevron dir="down" /></button>}
      </header>
      <SpendLine />
      <div className={s.body}>{p.tab === 'ask' ? <AskTab /> : <AssistantChat />}</div>
    </>
  )
}

/** The grip on the panel's left edge: drag, or use the arrow keys. The width is saved when the drag ends. */
function Grip({ width, onLive, onCommit }: { width: number; onLive: (w: number) => void; onCommit: (w: number) => void }) {
  const drag = useRef<{ x: number; w: number } | null>(null)
  const down = (e: PE) => { drag.current = { x: e.clientX, w: width }; (e.target as HTMLElement).setPointerCapture(e.pointerId) }
  const move = (e: PE) => {
    if (!drag.current) return
    onLive(Math.max(PANEL_MIN, Math.min(maxWidthFor(window.innerWidth), drag.current.w + (drag.current.x - e.clientX))))
  }
  const up = (e: PE) => { if (!drag.current) return; const w = drag.current.w + (drag.current.x - e.clientX); drag.current = null; onCommit(w) }
  const key = (e: KE) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault(); onCommit(width + (e.key === 'ArrowLeft' ? 24 : -24))
  }
  return <div className={s.grip} role="separator" aria-orientation="vertical" aria-label="Resize the AI panel" aria-valuenow={width} aria-valuemin={PANEL_MIN}
    tabIndex={0} onPointerDown={down} onPointerMove={move} onPointerUp={up} onKeyDown={key} />
}

export function AiPanel() {
  const p = useAiPanel()
  const [live, setLive] = useState<number | null>(null)
  if (DEMO) return null

  if (p.isPhone) {
    return (
      <>
        {!p.sheetOpen && (
          <button type="button" className={s.fab} onClick={() => p.setSheetOpen(true)} aria-label="Open the AI panel">
            <Sparkle size={22} />{p.pending && <i className={s.fabDot} aria-hidden />}
          </button>
        )}
        {p.sheetOpen && (
          <div className={s.sheet} role="dialog" aria-label="AI panel"><Body onClose={() => p.setSheetOpen(false)} /></div>
        )}
      </>
    )
  }
  if (!p.prefs.open) {
    return (
      <aside className={s.rail} style={{ width: RAIL_WIDTH }} aria-label="AI panel, folded">
        <button type="button" className={s.railBtn} onClick={() => p.setOpen(true)} aria-label="Open the AI panel" aria-expanded={false}>
          <Sparkle /><span>AI</span>{p.pending && <i className={s.fabDot} aria-hidden />}
        </button>
      </aside>
    )
  }
  const width = live ?? p.prefs.width
  return (
    <aside className={s.panel} style={{ width }} aria-label="AI panel">
      <Grip width={width} onLive={setLive} onCommit={w => { setLive(null); p.setWidth(w) }} />
      <Body onCollapse={() => p.setOpen(false)} />
    </aside>
  )
}
