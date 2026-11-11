'use client'

// =============================================================================
//  Three states, not two.
//
//  "Auto" (follow the system) is the honest default — it is what someone who
//  has never opened this control wants, and a two-way toggle silently takes
//  that choice away the first time it is touched. Picking it again has to be
//  possible, so it is a first-class option rather than "clear my preference"
//  hidden somewhere. The choice is stamped on <html> as data-theme (or the
//  stamp removed for Auto) and remembered in localStorage.
// =============================================================================

import { useEffect, useState } from 'react'
import { applyTheme, readTheme, type ThemeChoice } from '@/lib/theme'
import s from './shell.module.css'

const OPTIONS: Array<{ id: ThemeChoice; short: string; label: string; icon: React.ReactNode }> = [
  {
    id: 'system', short: 'Auto', label: 'Follow the system',
    icon: <><rect x="2" y="3" width="12" height="8" rx="1" /><path d="M6 13h4" strokeLinecap="round" /></>,
  },
  {
    id: 'light', short: 'Light', label: 'Light',
    icon: <><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" strokeLinecap="round" /></>,
  },
  {
    id: 'dark', short: 'Dark', label: 'Dark',
    icon: <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" strokeLinejoin="round" />,
  },
]

export function ThemeToggle() {
  // Starts as null so the first render matches what the server produced. The
  // stored choice is already on <html> by then — the inline script in the
  // layout puts it there before paint — so reading it here is only about
  // showing which button is lit, never about applying it.
  const [choice, setChoice] = useState<ThemeChoice | null>(null)
  useEffect(() => { setChoice(readTheme()) }, [])

  const pick = (id: ThemeChoice) => { setChoice(id); applyTheme(id) }

  return (
    <div className={s.seg} role="group" aria-label="Theme">
      {OPTIONS.map(o => (
        <button key={o.id} type="button" onClick={() => pick(o.id)} title={o.label} aria-pressed={choice === o.id}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>{o.icon}</svg>
          <span>{o.short}</span>
        </button>
      ))}
    </div>
  )
}
