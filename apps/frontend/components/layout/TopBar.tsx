'use client'

// =============================================================================
//  HyperProx — the top bar: where you are (crumb and page title), whether the
//  browser can reach HyperProx (the live dot), the finder and the theme switch.
// =============================================================================

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useSession } from '@/lib/session'
import { ThemeToggle } from './ThemeToggle'
import { Finder } from './Finder'
import { pageMeta } from './nav'
import s from './shell.module.css'

const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER_NAME ?? ''

/** Live while the browser is online and the last vault status read came back; it says which in words too. */
function useLive(): 'live' | 'offline' | 'connecting' {
  const { status } = useSession()
  const [online, setOnline] = useState(true)
  useEffect(() => {
    const on = () => setOnline(navigator.onLine)
    on()
    window.addEventListener('online', on)
    window.addEventListener('offline', on)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', on) }
  }, [])
  if (!online) return 'offline'
  return status ? 'live' : 'connecting'
}

export function TopBar({ full = false }: { full?: boolean }) {
  const pathname = usePathname()
  const { crumb, title } = pageMeta(pathname)
  const live = useLive()
  const [finder, setFinder] = useState(false)

  // "/" opens the finder from anywhere that is not a text box (a terminal's input counts as one).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      e.preventDefault()
      setFinder(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className={`${s.top} ${full ? s.topFull : ''}`}>
      <div className={s.titleBlock}>
        <span className={s.crumb}>{crumb}{CLUSTER ? ` · ${CLUSTER}` : ''}</span>
        <h1 className={s.title}>{title}</h1>
      </div>
      <div className={s.tools}>
        <span className={s.live} data-state={live} role="status">
          <i aria-hidden />{live === 'live' ? 'Live' : live === 'offline' ? 'Offline' : 'Connecting'}
        </span>
        <button type="button" className={s.search} onClick={() => setFinder(true)} aria-haspopup="dialog" aria-label="Find a page (shortcut: slash)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          Find anything<kbd aria-hidden>/</kbd>
        </button>
        <ThemeToggle />
      </div>
      {finder && <Finder onClose={() => setFinder(false)} />}
    </div>
  )
}
