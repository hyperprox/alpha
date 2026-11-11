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
import { alpha } from '@/lib/theme'
import { Icon, styles as vs } from '@/components/visual/kit'
import { PLUGIN_ICON } from './visual/plugin-kit'

interface Card {
  id: string; name: string; icon: string; hasDetail: boolean
  headline?: string
  tone?: 'good' | 'warn' | 'bad'
  rows?: Array<{ label: string; value: string; tone?: 'good' | 'warn' | 'bad' }>
  error?: string
}

const TONE = { good: 'var(--good)', warn: 'var(--warn)', bad: 'var(--crit)' } as const

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
      <h2 className="mb-4 font-display text-[20px] font-semibold" style={{ color: 'var(--text-bright)' }}>
        {heading}
      </h2>

      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))' }}>
        {cards.map(p => {
          const tone = p.error ? TONE.bad : TONE[p.tone ?? 'good']
          const body = (
            <>
              <div className="mb-3 flex items-center justify-between">
                <div className="flex min-w-0 items-center gap-2">
                  <span style={{ color: 'var(--accent)', display: 'flex' }}>
                    {PLUGIN_ICON[p.id] ? <Icon name={PLUGIN_ICON[p.id]} size={18} /> : <span className="text-sm">{p.icon}</span>}
                  </span>
                  <span className="truncate font-display text-[20px] font-semibold uppercase" style={{ color: 'var(--text-bright)', letterSpacing: '0.06em' }}>
                    {p.name}
                  </span>
                </div>
                <span className="flex items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wider"
                  style={{ color: tone, border: `1px solid ${alpha(tone, 19)}` }}>
                  <i className={vs.hdot} data-tone={p.error ? 'bad' : p.tone ?? 'good'} aria-hidden />
                  {p.error ? 'UNREACHABLE' : p.tone === 'bad' ? 'NEEDS YOU' : p.tone === 'warn' ? 'CHECK' : 'LIVE'}
                </span>
              </div>

              {p.error ? (
                <p className="text-sm leading-relaxed" style={{ color: 'var(--text-soft)' }}>{p.error}</p>
              ) : (
                <>
                  <div className="mb-3 flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full"
                      style={{ background: tone, boxShadow: `0 0 6px ${tone}` }} />
                    <span className="text-[15px] font-semibold" style={{ color: 'var(--text-bright)' }}>
                      {p.headline}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {(p.rows ?? []).slice(0, rowLimit).map((r, i) => (
                      // A value can be long (a Plex session is title · mode · progress): it truncates with
                      // an ellipsis and shows in full on hover, instead of running out of the card.
                      <div key={i} className="flex min-w-0 justify-between gap-3 font-mono text-xs" title={r.label ? `${r.label}: ${r.value}` : r.value}>
                        {r.label && <span className="shrink-0 truncate" style={{ color: 'var(--text-dim)', maxWidth: '45%' }}>{r.label}</span>}
                        <span className={`min-w-0 truncate tabular-nums ${r.label ? 'text-right' : ''}`}
                          style={{ color: r.tone ? TONE[r.tone] : 'var(--text-soft)' }}>{r.value}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )

          return p.hasDetail
            ? <Link key={p.id} href={`/plugins/${p.id}`} className={`${vs.card} transition-colors`}>{body}</Link>
            : <div key={p.id} className={vs.card}>{body}</div>
        })}
      </div>
    </section>
  )
}
