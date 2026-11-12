'use client'

// =============================================================================
//  HyperProx — the side rail
//
//  Grouped navigation with the vault at its foot. On a wide screen it can fold
//  to icons; under 900 px it becomes a fixed bar with a menu button, and the
//  same rail slides in as a drawer, so there is one navigation to keep right.
// =============================================================================

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { SessionBadge } from './SessionBadge'
import { versionLabel, GIT_DESCRIBE } from './version'
import { NAV, isActive } from './nav'
import { useSession } from '@/lib/session'
import { DemoBadge } from './TopBar'
import s from './shell.module.css'

const COLLAPSE_KEY = 'hyperprox-rail'

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const pathname = usePathname()
  const { status, email } = useSession()
  const menuBtn = useRef<HTMLButtonElement>(null)
  const railRef = useRef<HTMLElement>(null)

  useEffect(() => {
    try { setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1') } catch { /* private mode */ }
  }, [])
  const setFold = (v: boolean) => {
    setCollapsed(v)
    try { localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0') } catch { /* private mode */ }
  }

  // Navigating is the end of the drawer's job. Leaving it open over the page
  // someone just chose is the classic mobile-nav annoyance.
  useEffect(() => { setDrawerOpen(false) }, [pathname])

  // An open drawer: Escape closes it and focus goes into it, then back to the menu button.
  useEffect(() => {
    if (!drawerOpen) return
    const back = menuBtn.current
    railRef.current?.querySelector<HTMLElement>('a, button')?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawerOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); back?.focus() }
  }, [drawerOpen])

  const vaultState = status && !status.locked && status.user ? 'unlocked' : 'checking'

  return (
    <>
      <header className={s.phoneBar}>
        <Link href="/dashboard" className={s.logo} aria-label="HyperProx dashboard">HYPER<i>PROX</i></Link>
        {status?.demo && <DemoBadge />}
        <button ref={menuBtn} className={s.iconBtn} onClick={() => setDrawerOpen(true)} aria-label="Open navigation" aria-expanded={drawerOpen} aria-controls="hp-rail">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden><path d="M4 7h16M4 12h16M4 17h16" /></svg>
        </button>
      </header>

      {drawerOpen && <button className={s.veil} aria-label="Close navigation" tabIndex={-1} onClick={() => setDrawerOpen(false)} />}

      <aside id="hp-rail" ref={railRef} className={`${s.rail} ${collapsed ? s.railCollapsed : ''} ${drawerOpen ? s.railOpen : ''}`} aria-label="Sidebar">
        <div className={s.logoRow}>
          {collapsed
            ? <Link href="/dashboard" className={s.logoMark} aria-label="HyperProx dashboard">HP</Link>
            : <Link href="/dashboard" className={s.logo}>HYPER<i>PROX</i><small>CONTROL PLANE</small></Link>}
          <button className={`${s.ghostBtn} ${s.collapseBtn}`} onClick={() => setFold(!collapsed)}
            aria-label={collapsed ? 'Expand the side menu' : 'Fold the side menu to icons'} title={collapsed ? 'Expand' : 'Fold to icons'}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
              <path d={collapsed ? 'M9 5l7 7-7 7' : 'M15 5l-7 7 7 7'} />
            </svg>
          </button>
          {drawerOpen && (
            <button className={s.ghostBtn} onClick={() => setDrawerOpen(false)} aria-label="Close navigation">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          )}
        </div>

        <nav className={s.nav} aria-label="Main">
          {NAV.map((group, gi) => (
            <div key={gi} className={s.nav} role="group" aria-label={group.section ?? 'Overview'}>
              {group.section && (collapsed ? <div className={s.navRule} aria-hidden /> : <div className={s.navHead} aria-hidden>{group.section}</div>)}
              {group.items.map(item => {
                const on = isActive(pathname, item.href)
                return (
                  <Link key={item.href} href={item.href} className={s.navLink} aria-current={on ? 'page' : undefined} title={collapsed ? item.label : undefined}>
                    {item.icon}<span>{item.label}</span>
                  </Link>
                )
              })}
            </div>
          ))}
        </nav>

        <div className={s.vault} aria-live="polite">
          <div className={s.vaultHead}>
            <i className={s.vaultDot} data-state={vaultState} aria-hidden />
            {collapsed
              ? <span className={s.srOnly}>{vaultState === 'unlocked' ? 'Vault unlocked' : 'Checking the vault'}</span>
              : <div style={{ minWidth: 0 }}>
                  <b>{vaultState === 'unlocked' ? 'Vault unlocked' : 'Checking the vault…'}</b>
                  <div className={s.vaultMeta} title={`HyperProx version and build commit${GIT_DESCRIBE ? ` (${GIT_DESCRIBE})` : ''}`}><Link href="/updates#hyperprox" className={s.vaultMetaLink}>{versionLabel()}</Link></div>
                </div>}
          </div>
          {!collapsed && email && <SessionBadge />}
        </div>
      </aside>
    </>
  )
}
