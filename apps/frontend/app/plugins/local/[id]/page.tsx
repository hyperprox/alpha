'use client'

// =============================================================================
//  HyperProx — a local plug-in's page
//
//  The page itself lives in the git-ignored apps/frontend/local-plugins/<id> and is listed by
//  scripts/local-plugins.js; this only finds it and loads it. Its API is /api/local/<id>, which is admin
//  only (the page says so plainly when the signed-in person is not).
// =============================================================================

import { useEffect, useState, type ComponentType } from 'react'
import Link from 'next/link'
import { LOCAL_PLUGINS } from '@local-plugins'
import { Page, Panel } from '@/components/visual/kit'

export default function LocalPluginPage({ params }: { params: { id: string } }) {
  const plugin = LOCAL_PLUGINS.find(p => p.id === params.id)
  const [View, setView] = useState<ComponentType | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!plugin) return
    let live = true
    plugin.load().then(m => { if (live) setView(() => m.default) }).catch(e => { if (live) setError(String(e?.message ?? e)) })
    return () => { live = false }
  }, [plugin])

  if (!plugin) {
    return (
      <Page>
        <Panel title="No such plug-in">
          <p style={{ color: 'var(--text-soft)' }}>There is no local plug-in called “{params.id}” on this install. <Link href="/plugins">Back to Plug-ins</Link></p>
        </Panel>
      </Page>
    )
  }
  if (error) return <Page><Panel title={plugin.name}><p style={{ color: 'var(--crit)' }}>The page could not be loaded: {error}</p></Panel></Page>
  if (!View) return <Page><Panel title={plugin.name}><p style={{ color: 'var(--text-dim)' }}>Loading…</p></Panel></Page>
  return <View />
}
