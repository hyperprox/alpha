'use client'

// =============================================================================
//  HyperProx — the Ghost card on a site
//
//  Version, published posts and members, read by the server with the Admin API
//  key Ghost's setup made (kept in the vault). Read-only; the key never reaches
//  the browser. Refreshes on request, otherwise the server keeps it 5 minutes.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'
import { Tiles, styles } from '@/components/visual/kit'

interface Stats { version: string | null; posts: number | null; members: number | null; checkedAt: number }

export function GhostCard({ siteId, name }: { siteId: string; name: string }) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (refresh = false) => {
    setBusy(true)
    const r = await apiJson<{ data: Stats }>(`/api/sites/${encodeURIComponent(siteId)}/ghost${refresh ? '?refresh=1' : ''}`)
    setBusy(false)
    if (r.ok && r.body) { setStats(r.body.data); setError('') } else setError(r.error ?? 'Ghost could not be read.')
  }, [siteId])
  useEffect(() => { void load() }, [load])

  const n = (v: number | null) => (v === null ? '—' : v.toLocaleString())
  return (
    <section aria-label={`${name}: Ghost`} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className={styles.row} style={{ gap: 8, flexWrap: 'wrap' }}>
        <span className="font-mono" style={{ fontSize: 10, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--accent)' }}>Ghost · Admin API</span>
        <button type="button" className={styles.btn} style={{ marginLeft: 'auto', padding: '2px 10px', fontSize: 12 }} disabled={busy} onClick={() => void load(true)}>
          {busy ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      {stats && (
        <Tiles label={`${name} Ghost facts`} items={[
          { label: 'version', value: stats.version ?? '—' },
          { label: 'posts', value: n(stats.posts), title: 'Published posts' },
          { label: 'members', value: n(stats.members) },
        ]} />
      )}
      {error && <p style={{ margin: 0, fontSize: 12, color: 'var(--crit-soft)' }}>{error}</p>}
    </section>
  )
}
