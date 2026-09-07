'use client'

// =============================================================================
//  Live plug-in readings, as cards
//
//  One component, used on both the Dashboard and the Monitoring overview — the
//  markup was copied into the second place once and would have been copied into
//  every place after that.
//
//  It fetches its own data on the same thirty-second cadence as the Prometheus
//  scrape, so a card and its graph never disagree about what is happening.
// =============================================================================

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface Card {
  id: string; name: string; icon: string; hasDetail: boolean
  headline?: string
  tone?: 'good' | 'warn' | 'bad'
  rows?: Array<{ label: string; value: string; tone?: 'good' | 'warn' | 'bad' }>
  error?: string
}

const TONE = { good: '#22c55e', warn: '#f59e0b', bad: '#ef4444' } as const

export function PluginCards({ heading = 'Plug-ins', rowLimit = 4 }: { heading?: string; rowLimit?: number }) {
  const [cards, setCards] = useState<Card[]>([])

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const list = await fetch('/api/plugins').then(r => r.json())
        if (!list.success) return

        // Only plug-ins that are set up. An unconfigured one is a normal state,
        // not something to occupy space on a dashboard.
        const configured = list.data.filter((p: any) => p.configured)

        const next = await Promise.all(configured.map(async (p: any): Promise<Card> => {
          const base = { id: p.id, name: p.name, icon: p.icon, hasDetail: p.hasDetail }
          try {
            const d = await fetch(`/api/plugins/${p.id}/data`).then(r => r.json())
            const data = d?.data ?? {}
            return data.ok
              ? { ...base, headline: data.headline, tone: data.tone, rows: data.rows }
              : { ...base, error: data.error }
          } catch (e: any) {
            return { ...base, error: e.message }
          }
        }))

        if (!cancelled) setCards(next)
      } catch {
        // Whatever page this sits on has its own job; plug-ins are additive and
        // must never take it down.
      }
    }

    load()
    const timer = setInterval(load, 30_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  if (!cards.length) return null

  return (
    <section>
      <h2 className="mb-3 font-mono text-xs uppercase tracking-widest" style={{ color: '#4b5563' }}>
        {heading}
      </h2>

      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
        {cards.map(p => {
          const tone = p.error ? TONE.bad : TONE[p.tone ?? 'good']
          const body = (
            <>
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm">{p.icon}</span>
                  <span className="font-display text-sm font-bold tracking-[0.08em]" style={{ color: '#e2e8f0' }}>
                    {p.name.toUpperCase()}
                  </span>
                </div>
                <span className="rounded px-1.5 py-0.5 font-mono text-[10px]"
                  style={{ color: tone, border: `1px solid ${tone}30` }}>
                  {p.error ? 'UNREACHABLE' : 'LIVE'}
                </span>
              </div>

              {p.error ? (
                <p className="font-mono text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}>{p.error}</p>
              ) : (
                <>
                  <div className="mb-3 flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full"
                      style={{ background: tone, boxShadow: `0 0 6px ${tone}` }} />
                    <span className="font-display text-base font-semibold" style={{ color: '#e2e8f0' }}>
                      {p.headline}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {(p.rows ?? []).slice(0, rowLimit).map((r, i) => (
                      <div key={i} className="flex justify-between gap-3 font-mono text-[11px]">
                        <span className="truncate" style={{ color: '#4b5563' }}>{r.label}</span>
                        <span className="whitespace-nowrap tabular-nums"
                          style={{ color: r.tone ? TONE[r.tone] : '#9ca3af' }}>{r.value}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )

          const style = { background: '#0d1320', border: '1px solid #1e2d3d', borderRadius: 8, padding: 16 }

          return p.hasDetail
            ? <Link key={p.id} href={`/plugins/${p.id}`} className="block transition-colors hover:bg-white/[0.02]" style={style}>{body}</Link>
            : <div key={p.id} style={style}>{body}</div>
        })}
      </div>
    </section>
  )
}
