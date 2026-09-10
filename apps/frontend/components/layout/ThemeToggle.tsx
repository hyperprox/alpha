'use client'

// =============================================================================
//  Three states, not two.
//
//  "System" is the honest default — it is what someone who has never opened
//  this control wants, and a two-way toggle silently takes that choice away the
//  first time it is touched. Picking it again has to be possible, so it is a
//  first-class option rather than "clear my preference" hidden somewhere.
// =============================================================================

import { useEffect, useState } from 'react'
import { alpha, applyTheme, readTheme, type ThemeChoice } from '@/lib/theme'

const OPTIONS: Array<{ id: ThemeChoice; label: string; icon: React.ReactNode }> = [
  {
    id: 'system', label: 'Follow the system',
    icon: <><rect x="2" y="3" width="12" height="8" rx="1" /><path d="M6 13h4" strokeLinecap="round" /></>,
  },
  {
    id: 'light', label: 'Light',
    icon: <><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" strokeLinecap="round" /></>,
  },
  {
    id: 'dark', label: 'Dark',
    icon: <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" strokeLinejoin="round" />,
  },
]

export function ThemeToggle({ collapsed }: { collapsed: boolean }) {
  // Starts as null so the first render matches what the server produced. The
  // stored choice is already on <html> by then — the inline script in the
  // layout puts it there before paint — so reading it here is only about
  // showing which button is lit, never about applying it.
  const [choice, setChoice] = useState<ThemeChoice | null>(null)
  useEffect(() => { setChoice(readTheme()) }, [])

  const pick = (id: ThemeChoice) => { setChoice(id); applyTheme(id) }

  if (collapsed) {
    const next: ThemeChoice = choice === 'dark' ? 'light' : choice === 'light' ? 'system' : 'dark'
    return (
      <button
        onClick={() => pick(next)}
        title={`Theme: ${choice ?? 'system'} — click for ${next}`}
        className="flex h-7 w-7 items-center justify-center rounded transition-colors hover:bg-white/5"
        style={{ color: 'var(--text-dim)' }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
          {OPTIONS.find(o => o.id === (choice ?? 'system'))!.icon}
        </svg>
      </button>
    )
  }

  return (
    <div className="flex rounded border" style={{ borderColor: 'var(--border-strong)' }}>
      {OPTIONS.map(o => {
        const on = choice === o.id
        return (
          <button
            key={o.id}
            onClick={() => pick(o.id)}
            title={o.label}
            aria-label={o.label}
            aria-pressed={on}
            className="flex h-6 w-7 items-center justify-center transition-colors first:rounded-l last:rounded-r hover:bg-white/5"
            style={on
              ? { background: alpha('var(--accent)', 12), color: 'var(--accent)' }
              : { color: 'var(--text-faint)' }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
              {o.icon}
            </svg>
          </button>
        )
      })}
    </div>
  )
}
