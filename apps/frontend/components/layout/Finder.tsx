'use client'

// =============================================================================
//  HyperProx — "Find anything": a quick jump to any page by name or by what it
//  is about. Arrow keys move, Enter goes, Escape closes and hands focus back.
// =============================================================================

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { NAV, EXTRA_PAGES } from './nav'
import s from './shell.module.css'

interface Entry { href: string; label: string; section: string; keywords: string; icon?: React.ReactNode }

const ENTRIES: Entry[] = [
  ...NAV.flatMap(g => g.items.map(i => ({ href: i.href, label: i.label, section: g.section ?? 'Overview', keywords: i.keywords ?? '', icon: i.icon }))),
  ...EXTRA_PAGES.map(p => ({ ...p, keywords: p.keywords ?? '' })),
]

export function Finder({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('')
  const [on, setOn] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const opener = useRef<Element | null>(null)
  const router = useRouter()

  useEffect(() => {
    opener.current = document.activeElement
    input.current?.focus()
    return () => { (opener.current as HTMLElement | null)?.focus?.() }
  }, [])

  const hits = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return ENTRIES
    return ENTRIES.filter(e => `${e.label} ${e.section} ${e.keywords}`.toLowerCase().includes(t))
  }, [q])

  useEffect(() => { setOn(0) }, [q])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setOn(i => Math.min(i + 1, hits.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setOn(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter' && hits[on]) { e.preventDefault(); router.push(hits[on].href); onClose() }
  }

  return (
    <div className={s.finderVeil} onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={s.finder} role="dialog" aria-modal="true" aria-label="Find a page" onKeyDown={onKey}>
        <input ref={input} value={q} onChange={e => setQ(e.target.value)} placeholder="Find a page…" aria-label="Find a page"
          role="combobox" aria-expanded="true" aria-controls="hp-finder-list" aria-activedescendant={hits[on] ? `hp-find-${on}` : undefined} />
        {hits.length ? (
          <ul id="hp-finder-list" role="listbox" aria-label="Pages">
            {hits.map((h, i) => (
              <li key={h.href} role="option" id={`hp-find-${i}`} aria-selected={i === on}>
                <Link href={h.href} data-on={i === on} onClick={onClose} onMouseEnter={() => setOn(i)} tabIndex={-1}>
                  {h.icon}{h.label}<small>{h.section}</small>
                </Link>
              </li>
            ))}
          </ul>
        ) : <div className={s.finderEmpty}>No page matches “{q}”.</div>}
      </div>
    </div>
  )
}
