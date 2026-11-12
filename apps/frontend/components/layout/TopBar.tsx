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
import { UpdateChip } from './UpdateChip'
import { pageMeta } from './nav'
import Link from 'next/link'
import { pluginIdOf, resolvePageMeta } from '@/lib/page-title'
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

/** Shown on every page while the demo API answers: the data is invented and nothing can be changed. */
export function DemoBadge() {
  return <span className={s.demo} title="Demo: invented data, and every change is refused">Demo</span>
}

// The plug-in list, read once per page load and only on a plug-in page, for the page's title.
let pluginNames: Record<string, string> | null = null
function usePluginNames(pathname: string): Record<string, string> | null {
  const [names, setNames] = useState(pluginNames)
  const want = pluginIdOf(pathname) !== null
  useEffect(() => {
    if (!want || pluginNames) return
    let alive = true
    fetch('/api/plugins').then(r => r.json()).then(j => {
      if (!j?.success || !Array.isArray(j.data)) return
      pluginNames = Object.fromEntries(j.data.map((p: { id: string; name: string }) => [p.id, p.name]))
      if (alive) setNames(pluginNames)
    }).catch(() => { /* the built-in names stand in */ })
    return () => { alive = false }
  }, [want])
  return names
}

export function TopBar({ full = false }: { full?: boolean }) {
  const pathname = usePathname()
  const { crumb, title, crumbHref } = resolvePageMeta(pageMeta(pathname), pathname, usePluginNames(pathname))
  const live = useLive()
  const { status } = useSession()
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
        {crumbHref
          ? <Link href={crumbHref} className={s.crumb}>← {crumb}</Link>
          : <span className={s.crumb}>{crumb}{CLUSTER ? ` · ${CLUSTER}` : ''}</span>}
        <h1 className={s.title}>{title}</h1>
      </div>
      <div className={s.tools}>
        {status?.demo && <DemoBadge />}
        {!status?.demo && <UpdateChip />}
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
