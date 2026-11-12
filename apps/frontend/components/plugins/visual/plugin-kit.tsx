'use client'

// =============================================================================
//  HyperProx — plug-in page parts: the switcher bar, plug-in icons and the
//  folded-away Details section. Built on the general visual kit.
// =============================================================================

import Link from 'next/link'
import { useEffect, useState, type ReactNode } from 'react'
import { Icon, styles as s } from '@/components/visual/kit'

/** Which icon a plug-in id gets in the switcher and the HUD. */
export const PLUGIN_ICON: Record<string, string> = {
  'home-assistant': 'home', plex: 'play', arrstack: 'arr', unmanic: 'encode', mikrotik: 'router', meshcentral: 'mesh',
  qnap: 'encode', pbs: 'lock', asus: 'router',
}

// ── plug-in switcher ─────────────────────────────────────────────────────────

interface SwitchItem { id: string; name: string; tone: 'good' | 'warn' | 'bad' | 'unknown' }
let switchCache: { at: number; items: SwitchItem[] } | null = null
const TONE_WORD = { good: 'healthy', warn: 'needs a look', bad: 'not working', unknown: 'not checked yet' }

/**
 * The bar of plug-ins across the top of each plug-in page, with a health dot each. Read once a minute at most:
 * each dot is one plug-in's tile reading, and a router's costs a connection-table read.
 */
export function PluginSwitcher({ current }: { current: string }) {
  const [items, setItems] = useState<SwitchItem[]>(switchCache?.items ?? [])
  useEffect(() => {
    let cancelled = false
    if (switchCache && Date.now() - switchCache.at < 60_000) { setItems(switchCache.items); return }
    ;(async () => {
      try {
        const list = await fetch('/api/plugins').then(r => r.json())
        if (!list?.success) return
        const shown = (list.data as any[]).filter(p => p.configured && p.hasDetail)
        const base: SwitchItem[] = shown.map(p => ({ id: p.id, name: p.name, tone: 'unknown' }))
        if (!cancelled) setItems(base)
        const toned = await Promise.all(shown.map(async (p): Promise<SwitchItem> => {
          try {
            const d = await fetch(`/api/plugins/${p.id}/data`).then(r => r.json())
            const data = d?.data ?? {}
            return { id: p.id, name: p.name, tone: data.ok ? (data.tone ?? 'good') : 'bad' }
          } catch { return { id: p.id, name: p.name, tone: 'unknown' } }
        }))
        switchCache = { at: Date.now(), items: toned }
        if (!cancelled) setItems(toned)
      } catch { /* the switcher is a convenience; the page works without it */ }
    })()
    return () => { cancelled = true }
  }, [])
  if (!items.length) return null
  return (
    <nav className={s.switcher} aria-label="Plug-ins">
      {items.map(p => (
        <Link key={p.id} href={`/plugins/${p.id}`} aria-current={p.id === current ? 'page' : undefined} title={`${p.name}: ${TONE_WORD[p.tone]}`}>
          <Icon name={PLUGIN_ICON[p.id] ?? 'plugin'} />{p.name}
          <i className={s.hdot} data-tone={p.tone} aria-hidden /><span className={s.srOnly}>, {TONE_WORD[p.tone]}</span>
        </Link>
      ))}
    </nav>
  )
}

/** The old stat tiles and tables, folded away at the bottom of a page. */
export function DetailsSection({ children, count }: { children: ReactNode; count: number }) {
  return (
    <details className={s.panel}>
      <summary className={s.panelTitle} style={{ cursor: 'pointer', margin: 0, minHeight: 32, alignItems: 'center' }}>
        Details <small>{count} table{count === 1 ? '' : 's'} · every row, filterable</small>
      </summary>
      <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 16 }}>{children}</div>
    </details>
  )
}
