'use client'

// =============================================================================
//  HyperProx — Arr Stack, Upcoming
//
//  What Sonarr and Radarr expect to grab soon, by day, plus what is overdue.
//  Everything comes from the API (routes/arr-upcoming.ts), which groups by day
//  in this browser's time zone and cross-references the download queue. Posters
//  are HyperProx paths, fetched by the API with the stored key: no Sonarr or
//  Radarr address or key is ever in this page. Read-only throughout.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'
import { Cols, Panel, Pill, styles as s } from '@/components/visual/kit'
import { Poster } from '@/components/plugins/visual/views'
import c from './upcoming.module.css'

type Status = 'have' | 'downloading' | 'waiting' | 'upcoming'
interface Item {
  id: string; kind: 'tv' | 'film'; title: string
  code?: string; episodeTitle?: string; network?: string | null; airUtc?: string
  year?: number | null; releaseKind?: 'cinema' | 'digital' | 'physical'; releaseDate?: string
  when: string; status: Status; statusText: string; progress?: number; art: string | null
}
interface Group { key: string; label: string; items: Item[] }
interface Missing { total: number; items: Array<{ id: string; title: string; detail: string; date: string | null }>; approximate?: boolean }
interface Data {
  at: number; tz: string; days: number
  services: { sonarr: { ok: boolean; error?: string }; radarr: { ok: boolean; error?: string } }
  groups: Group[]
  counts: { tv: number; film: number; tonight: number; downloading: number }
  missing: { sonarr: Missing | null; radarr: Missing | null }
}

type Show = 'both' | 'tv' | 'film'
const RANGES = [7, 14, 30, 60] as const
const RELEASE_WORD = { cinema: 'In cinemas', digital: 'Digital release', physical: 'Physical release' }
const TONE: Record<Status, 'good' | 'accent' | 'warn' | undefined> = { have: 'good', downloading: 'accent', waiting: 'warn', upcoming: undefined }

function remembered<T extends string | number>(key: string, ok: readonly T[], fallback: T): T {
  try { const v = window.localStorage.getItem(key); const hit = ok.find(x => String(x) === v); if (hit !== undefined) return hit } catch { /* no storage */ }
  return fallback
}
const remember = (key: string, v: string | number) => { try { window.localStorage.setItem(key, String(v)) } catch { /* no storage */ } }

export function ArrUpcoming({ onQueue }: { onQueue: () => void }) {
  const [show, setShow] = useState<Show>('both')
  const [days, setDays] = useState<number>(14)
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setShow(remembered('hp.arr.up.show', ['both', 'tv', 'film'] as const, 'both'))
    setDays(remembered('hp.arr.up.days', RANGES, 14))
  }, [])

  const load = useCallback(async () => {
    const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' } })()
    const r = await apiJson<{ data: Data }>(`/api/plugins/arrstack/upcoming?days=${days}&tz=${encodeURIComponent(tz)}`)
    if (!r.ok || !r.body?.data) { setError(r.error ?? 'The schedule could not be read.'); return }
    setError(null); setData(r.body.data)
  }, [days])

  useEffect(() => {
    void load()
    const t = setInterval(() => { if (!document.hidden) void load() }, 60_000)
    return () => clearInterval(t)
  }, [load])

  const pick = (k: Show) => { setShow(k); remember('hp.arr.up.show', k) }
  const range = (n: number) => { setDays(n); remember('hp.arr.up.days', n) }

  const groups = (data?.groups ?? [])
    .map(g => ({ ...g, items: g.items.filter(i => show === 'both' || i.kind === show) }))
    .filter(g => g.items.length)
  const down = data ? (['sonarr', 'radarr'] as const).filter(k => !data.services[k].ok) : []

  return (
    <>
      <Panel title="Upcoming" sub={data ? `${data.counts.tv} EPISODES · ${data.counts.film} FILMS${data.counts.tonight ? ` · ${data.counts.tonight} TONIGHT` : ''}` : undefined}>
        <div className={c.bar}>
          <div className={c.seg} role="group" aria-label="Show">
            {([['both', 'Both'], ['tv', 'TV'], ['film', 'Films']] as const).map(([k, label]) => (
              <button key={k} type="button" aria-pressed={show === k} onClick={() => pick(k)}>{label}</button>
            ))}
          </div>
          <div className={c.seg} role="group" aria-label="Range">
            {RANGES.map(n => <button key={n} type="button" aria-pressed={days === n} onClick={() => range(n)}>{n} days</button>)}
          </div>
        </div>
        {error && <p className={c.err} role="alert">{error}</p>}
        {down.map(k => (
          <p key={k} className={c.err} role="status">{k === 'sonarr' ? 'Sonarr' : 'Radarr'} is not answering{data!.services[k].error ? `: ${data!.services[k].error}` : ''}. Its half of the schedule is missing.</p>
        ))}
        {!data && !error && <p className={s.empty}>Reading the schedule…</p>}
        {data && groups.length === 0 && !error && <p className={s.empty}>Nothing scheduled in the next {days} days.</p>}
      </Panel>

      {groups.map(g => (
        <Panel key={g.key} title={g.label} sub={`${g.items.length}`} level={3}>
          <ul className={c.rows}>
            {g.items.map(i => (
              <li key={i.id} className={c.row} data-status={i.status}>
                <Poster title={i.title} art={i.art} className={c.thumb} />
                <div className={c.body}>
                  <div className={c.head}>
                    <span className={c.title}>{i.title}{i.kind === 'film' && i.year ? <small> ({i.year})</small> : null}</span>
                    <span className={c.when}>{i.kind === 'film' && i.releaseKind ? `${RELEASE_WORD[i.releaseKind]} · ${i.when}` : i.when}</span>
                  </div>
                  <span className={c.meta}>
                    {i.kind === 'tv' ? `${i.code}${i.episodeTitle ? ` · ${i.episodeTitle}` : ''}${i.network ? ` · ${i.network}` : ''}` : 'Film'}
                  </span>
                  <div className={c.state}>
                    <Pill tone={TONE[i.status]}>{i.status === 'have' ? 'Have it' : i.status === 'downloading' ? `Downloading${i.progress ? ` ${i.progress}%` : ''}` : i.status === 'waiting' ? 'Waiting' : 'Scheduled'}</Pill>
                    <span className={c.note}>{i.statusText}</span>
                    {i.status === 'downloading' && <button type="button" className={c.link} onClick={onQueue}>See the queue</button>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      ))}

      {data && (data.missing.sonarr || data.missing.radarr) && (
        <Panel title="Missing, searching" sub="AIRED OR RELEASED, NO FILE">
          <Cols>
            {([['TV', data.missing.sonarr, 'Sonarr'], ['Films', data.missing.radarr, 'Radarr']] as const).map(([label, m]) => m && (
              <div key={label} className={c.miss}>
                <h3 className={c.missHead}>{label} <small>{m.approximate ? `${m.total}+` : m.total} overdue</small></h3>
                {m.items.length === 0 ? <p className={s.empty}>Nothing overdue.</p> : (
                  <ul className={c.missList}>
                    {m.items.map(r => (
                      <li key={r.id}>
                        <b>{r.title}</b>
                        <span>{[r.detail, r.date].filter(Boolean).join(' · ')}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {m.total > m.items.length && <p className={c.note}>Top {m.items.length} of {m.total}.</p>}
              </div>
            ))}
          </Cols>
        </Panel>
      )}
    </>
  )
}
