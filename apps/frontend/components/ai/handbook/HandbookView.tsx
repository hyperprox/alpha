// The Handbook's read-only pieces: a playbook as a card. The page (app/ai/handbook) adds the buttons and the editor.
import type { ReactNode } from 'react'
import s from './handbook.module.css'
import { SECTIONS, severityWord, sourceWord, statusWord, type Playbook } from '@/lib/handbook-view'

export function PlaybookBadges({ p }: { p: Playbook }) {
  return (
    <div className={s.badges}>
      <span className={`${s.badge} ${p.approved ? s.ok : s.wait}`}>{statusWord(p)}</span>
      <span className={`${s.badge} ${p.severity === 'high' ? s.sevHigh : p.severity === 'medium' ? s.sevMedium : s.sevLow}`}>{severityWord(p.severity)}</span>
      {p.area && <span className={s.badge}>{p.area}</span>}
      <span className={s.badge}>{sourceWord(p.source)}</span>
    </div>
  )
}

/** The whole playbook, section by section. Empty sections are left out. */
export function PlaybookBody({ p }: { p: Playbook }) {
  return (
    <>
      {p.symptoms.length > 0 && (
        <div className={s.section}>
          <span className={s.sectionName}>What it looks like</span>
          <ul className={s.symptoms}>{p.symptoms.map(x => <li key={x}>{x}</li>)}</ul>
        </div>
      )}
      {SECTIONS.filter(x => p[x.key]).map(x => (
        <div key={x.key} className={s.section}>
          <span className={s.sectionName}>{x.label}</span>
          <p className={s.sectionBody}>{p[x.key]}</p>
        </div>
      ))}
      {p.tags.length > 0 && <p className={s.sectionName}>{`Tags: ${p.tags.join(', ')}`}</p>}
    </>
  )
}

export function PlaybookCard({ p, open, onToggle, children }: { p: Playbook; open: boolean; onToggle?: () => void; children?: ReactNode }) {
  return (
    <li className={`${s.card} ${p.approved ? '' : s.cardWait}`}>
      <div className={s.cardHead}>
        <button type="button" className={s.toggle} onClick={onToggle} aria-expanded={open}>
          <h3 className={s.title}>{p.title}</h3>
        </button>
        <PlaybookBadges p={p} />
      </div>
      {open && <PlaybookBody p={p} />}
      {open && children}
    </li>
  )
}
