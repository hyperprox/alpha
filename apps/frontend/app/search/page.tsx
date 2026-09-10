'use client'

// =============================================================================
//  HyperProx — Search
//
//  A plain query across every indexer at once, showing raw results.
//
//  Sonarr and Radarr cannot do this and are not meant to: they search by scene
//  naming for one episode or season, then silently drop anything that fails a
//  quality profile, a seeder floor or a cutoff rule. That is right for
//  automation and useless when you know a complete-series pack exists and just
//  want to find it. Nothing here is filtered or hidden — ranking is a person's
//  job, and the grab is always deliberate.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'

interface Result {
  title: string; indexer: string; size: number
  seeders: number; leechers: number; published: string
  categories: string[]; guid: string; indexerId: number
}

const ACCENT = 'var(--accent)'
const BORDER = 'var(--border)'
const PANEL  = 'var(--surface)'

function size(bytes: number): string {
  if (!bytes) return '—'
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(0)} MB`
}

function age(iso: string): string {
  if (!iso) return '—'
  const days = (Date.now() - new Date(iso).getTime()) / 86_400_000
  if (!isFinite(days)) return '—'
  if (days < 1)   return 'today'
  if (days < 30)  return `${Math.round(days)}d`
  if (days < 365) return `${Math.round(days / 30)}mo`
  return `${(days / 365).toFixed(1)}y`
}

// A pack is the thing worth spotting at a glance, so it gets called out.
function isPack(title: string): boolean {
  const t = title.toLowerCase()
  if (/s\d{1,2}e\d{1,2}|\b\d{1,2}x\d{2}\b/.test(t)) return false
  return /\bs\d{1,2}\b|season|complete|collection|s\d{2}\s*-\s*s\d{2}/.test(t)
}

export default function SearchPage() {
  const [query,    setQuery]    = useState('')
  const [results,  setResults]  = useState<Result[] | null>(null)
  const [busy,     setBusy]     = useState(false)
  const [notice,   setNotice]   = useState<string | null>(null)
  const [ready,    setReady]    = useState<boolean | null>(null)
  const [sort,     setSort]     = useState<'seeders' | 'size' | 'age'>('seeders')
  const [packsOnly, setPacksOnly] = useState(false)
  const [grabbed,  setGrabbed]  = useState<Set<string>>(new Set())

  useEffect(() => {
    fetch('/api/plugins').then(r => r.json()).then(res => {
      const p = res?.data?.find((x: any) => x.id === 'arrstack')
      setReady(Boolean(p?.configured))
    }).catch(() => setReady(false))
  }, [])

  const run = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault()
    const q = query.trim()
    if (!q) return
    setBusy(true); setNotice(null); setResults(null)
    try {
      const res = await fetch(`/api/plugins/arrstack/search?q=${encodeURIComponent(q)}`).then(r => r.json())
      if (!res.success) { setNotice(res.error); return }
      setResults(res.data)
      if (!res.data.length) setNotice(`Nothing found for “${q}”.`)
    } catch (err: any) {
      setNotice(err.message)
    } finally {
      setBusy(false)
    }
  }, [query])

  const grab = async (r: Result) => {
    setNotice(null)
    const res = await fetch('/api/plugins/arrstack/grab', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid: r.guid, indexerId: r.indexerId, title: r.title }),
    }).then(x => x.json())
    if (!res.success) return setNotice(res.error)
    setGrabbed(prev => new Set(prev).add(r.guid))
    setNotice(`Sent to the download client: ${r.title.slice(0, 70)}`)
  }

  const shown = (results ?? [])
    .filter(r => !packsOnly || isPack(r.title))
    .sort((a, b) =>
      sort === 'size' ? b.size - a.size
      : sort === 'age' ? (new Date(b.published).getTime() || 0) - (new Date(a.published).getTime() || 0)
      : b.seeders - a.seeders)

  return (
    <div className="flex h-full flex-col" style={{ background: 'var(--ground)' }}>
      <header className="flex flex-shrink-0 items-baseline gap-3 border-b px-6"
        style={{ height: 56, borderColor: BORDER, background: 'var(--surface-raised)' }}>
        <h1 className="font-display text-lg font-light tracking-[0.18em] text-white">SEARCH</h1>
        <p className="font-mono text-[11px]" style={{ color: 'var(--text-dimmer)' }}>
          every indexer at once · nothing filtered
        </p>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {ready === false && (
          <div className="mb-5 rounded-lg border px-4 py-3" style={{ borderColor: 'color-mix(in srgb, var(--warn) 25%, transparent)', background: 'var(--ground)' }}>
            <p className="font-display text-[12px] uppercase tracking-[0.14em]" style={{ color: 'var(--warn)' }}>
              Search is not configured
            </p>
            <p className="mt-1 font-mono text-[11.5px]" style={{ color: 'var(--text-soft)' }}>
              Add a Prowlarr address and API key to the Arr Stack plug-in, or press Scan for services.
            </p>
          </div>
        )}

        <form onSubmit={run} className="mb-5 flex gap-2">
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="macgyver complete series"
            autoFocus
            className="flex-1 rounded border px-3 py-2 font-mono text-[13px] outline-none transition-colors focus:border-cyan"
            style={{ background: PANEL, borderColor: 'var(--border-strong)', color: 'var(--text-bright)' }}
          />
          <button type="submit" disabled={busy}
            className="rounded px-5 py-2 font-display text-sm font-semibold tracking-wide transition-opacity hover:opacity-85 disabled:opacity-40"
            style={{ background: ACCENT, color: 'var(--accent-ink)' }}>
            {busy ? 'Searching…' : 'Search'}
          </button>
        </form>

        {notice && (
          <div className="mb-4 flex items-center gap-3 rounded border px-3 py-2 font-mono text-[11.5px]"
            style={{ borderColor: BORDER, background: 'var(--surface-notice)', color: 'var(--text-soft)' }}>
            <span className="flex-1">{notice}</span>
            <button onClick={() => setNotice(null)} style={{ color: 'var(--text-dim)' }}>dismiss</button>
          </div>
        )}

        {results && results.length > 0 && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <span className="font-mono text-[11px]" style={{ color: 'var(--text-dim)' }}>
                {shown.length}{shown.length !== results.length && ` of ${results.length}`} results
              </span>
              <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
                <input type="checkbox" checked={packsOnly} onChange={e => setPacksOnly(e.target.checked)}
                  className="h-3 w-3 accent-cyan" />
                packs only
              </label>
              <div className="ml-auto flex rounded border" style={{ borderColor: 'var(--border-strong)' }}>
                {(['seeders', 'size', 'age'] as const).map(k => (
                  <button key={k} onClick={() => setSort(k)}
                    className="px-2.5 py-1 font-mono text-[11px] transition-colors first:rounded-l last:rounded-r"
                    style={sort === k ? { background: 'color-mix(in srgb, var(--accent) 8%, transparent)', color: ACCENT } : { color: 'var(--text-dim)' }}>
                    {k}
                  </button>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto rounded-lg border" style={{ background: PANEL, borderColor: BORDER }}>
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    {['', 'Release', 'Indexer', 'Size', 'Seed', 'Age', ''].map((h, i) => (
                      <th key={i}
                        className="whitespace-nowrap border-b px-3 py-2 text-left font-display text-[10px] uppercase tracking-[0.14em]"
                        style={{ borderColor: BORDER, color: 'var(--text-dim)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.slice(0, 200).map(r => {
                    const pack = isPack(r.title)
                    const done = grabbed.has(r.guid)
                    return (
                      <tr key={r.guid} className="transition-colors hover:bg-white/[0.03]">
                        <td className="border-b px-3 py-1.5" style={{ borderColor: 'var(--surface-notice)' }}>
                          {pack && (
                            <span className="rounded px-1.5 py-0.5 font-mono text-[9.5px]"
                              style={{ background: 'color-mix(in srgb, var(--accent) 7%, transparent)', color: ACCENT, border: '1px solid color-mix(in srgb, var(--accent) 16%, transparent)' }}>
                              PACK
                            </span>
                          )}
                        </td>
                        <td className="border-b px-3 py-1.5 font-mono text-[12px]"
                          style={{ borderColor: 'var(--surface-notice)', color: 'var(--text)', maxWidth: 620 }}>
                          <span className="block truncate" title={r.title}>{r.title}</span>
                        </td>
                        <td className="whitespace-nowrap border-b px-3 py-1.5 font-mono text-[11px]"
                          style={{ borderColor: 'var(--surface-notice)', color: 'var(--text-dim)' }}>{r.indexer}</td>
                        <td className="whitespace-nowrap border-b px-3 py-1.5 text-right font-mono text-[11px] tabular-nums"
                          style={{ borderColor: 'var(--surface-notice)', color: 'var(--text-soft)' }}>{size(r.size)}</td>
                        <td className="whitespace-nowrap border-b px-3 py-1.5 text-right font-mono text-[11px] tabular-nums"
                          style={{ borderColor: 'var(--surface-notice)',
                                   color: r.seeders >= 5 ? 'var(--good)' : r.seeders > 0 ? 'var(--warn)' : 'var(--crit)' }}>
                          {r.seeders}
                        </td>
                        <td className="whitespace-nowrap border-b px-3 py-1.5 text-right font-mono text-[11px]"
                          style={{ borderColor: 'var(--surface-notice)', color: 'var(--text-dimmer)' }}>{age(r.published)}</td>
                        <td className="border-b px-3 py-1.5 text-right" style={{ borderColor: 'var(--surface-notice)' }}>
                          <button onClick={() => grab(r)} disabled={done}
                            className="rounded px-2.5 py-1 font-display text-[11px] font-semibold tracking-wide transition-opacity hover:opacity-85 disabled:opacity-40"
                            style={done
                              ? { background: 'transparent', color: 'var(--good)', border: '1px solid color-mix(in srgb, var(--good) 19%, transparent)' }
                              : { background: 'color-mix(in srgb, var(--accent) 7%, transparent)', color: ACCENT, border: '1px solid color-mix(in srgb, var(--accent) 19%, transparent)' }}>
                            {done ? 'sent' : 'Download'}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
