'use client'

// =============================================================================
//  HyperProx — Arr Stack, Queue
//
//  What Sonarr and Radarr are downloading right now, grouped Show → Season →
//  download. The API collapses the queue (a 23-episode pack is 23 rows but one
//  download) and sends the grouped shape, so 200+ rows stay light here. The
//  reading comes from /api/plugins/arrstack/queue every few seconds, shared by
//  every open page, and pauses while the tab is hidden — the same rule the
//  Plex page follows. Admins also get buttons for what to do about a problem
//  (QueueActions.tsx); everyone else sees none.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiJson } from '@/lib/api'
import { Panel, Pill, ProgressBar, RingGauge, Tiles, bytes, duration, styles as s } from '@/components/visual/kit'
import { ActionResults, ActionsProvider, DownloadActions, FixStalled, SeasonActions, type Instance } from './QueueActions'
import c from './queue.module.css'

export type Problem = 'failed' | 'blocked' | 'stalled' | 'warning'
export interface QDownload {
  id: string; name: string; size: number; sizeLeft: number; progress: number; etaSec: number | null
  status: string; state: string; quality: string | null; protocol: string | null; client: string | null; indexer: string | null
  episodes: number; episodeRange: string | null; problem: Problem | null; messages: string[]; hint?: string | null
}
export interface QSeason { key: string; label: string; downloads: QDownload[]; episodes: number; size: number; sizeLeft: number; progress: number; etaSec: number | null; problem: Problem | null }
export interface QShow { key: string; title: string; seasons: QSeason[]; downloads: number; episodes: number; size: number; sizeLeft: number; progress: number; etaSec: number | null; problem: Problem | null }
export interface QMovie extends QDownload { title: string; year: number | null }
export interface QueueData {
  at: number
  services: { sonarr: { ok: boolean; configured: boolean; error?: string }; radarr: { ok: boolean; configured: boolean; error?: string } }
  summary: { downloads: number; shows: number; movies: number; rows: number; sizeLeft: number; attention: number; stalled: number; warnings: number }
  shows: QShow[]
  movies: QMovie[]
  capabilities?: { prioritise: boolean }
}

/**
 * The grouped queue, kept fresh. Reads at once, then every `everyMs` while `enabled` and the tab is visible;
 * a poll never stacks on a slow one, and a failed poll keeps the last good reading (it only sets `error`).
 */
export function useArrQueue(enabled: boolean, everyMs = 4000) {
  const [data, setData] = useState<QueueData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [at, setAt] = useState<number | null>(null)
  const busy = useRef(false)
  const kick = useRef<() => void>(() => {})

  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let gone = false
    let fails = 0
    // Repeated errors double the wait (up to 30 s); one good reading puts it back.
    const delay = () => Math.min(30_000, everyMs * 2 ** Math.min(fails, 6))
    const schedule = () => { if (!gone && !document.hidden && !timer) timer = setTimeout(() => { timer = null; void tick() }, delay()) }
    const tick = async () => {
      if (gone) return
      if (busy.current || document.hidden) { schedule(); return }
      busy.current = true
      try {
        const r = await apiJson<{ data: QueueData }>('/api/plugins/arrstack/queue')
        if (gone) return
        if (r.ok && r.body?.data) { setData(r.body.data); setError(null); setAt(Date.now()); fails = 0 }
        else { setError(r.error ?? 'The queue could not be read.'); fails++ }
      } catch (e: any) { fails++; if (!gone) setError(String(e?.message ?? e)) } finally { busy.current = false; schedule() }
    }
    const stop = () => { if (timer) { clearTimeout(timer); timer = null } }
    kick.current = () => { stop(); fails = 0; void tick() }
    const onVisibility = () => { if (document.hidden) stop(); else { stop(); void tick() } }
    void tick()
    document.addEventListener('visibilitychange', onVisibility)
    return () => { gone = true; stop(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [enabled, everyMs])

  const refresh = useCallback(() => kick.current(), [])
  return { data, error, at, refresh }
}

const PROBLEM_WORD: Record<Problem, string> = { failed: 'Failed', blocked: 'Import blocked', stalled: 'Stalled', warning: 'Warning' }
const PROBLEM_TONE: Record<Problem, 'bad' | 'warn'> = { failed: 'bad', blocked: 'bad', stalled: 'warn', warning: 'warn' }
const variantOf = (p: Problem | null) => (p === 'stalled' ? 'stall' as const : 'normal' as const)

/** "importPending" → "import pending". */
const words = (v: string) => v.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function Chevron({ open }: { open: boolean }) {
  return <span aria-hidden className={c.chev} data-open={open}>▶</span>
}

function DownloadRow({ d, name, instance }: { d: QDownload; name?: string; instance: Instance }) {
  const meta = [d.quality, d.protocol, d.client, d.indexer].filter(Boolean).join(' · ')
  const state = d.state && d.state !== 'downloading' ? words(d.state) : words(d.status)
  return (
    <li className={c.dl} data-problem={d.problem ?? undefined}>
      <div className={c.dlHead}>
        <span className={c.dlName} title={d.name}>{name ?? d.name}</span>
        <span className={c.dlNum}>{d.progress}%</span>
      </div>
      <ProgressBar value={d.progress} variant={variantOf(d.problem)} label={`${name ?? d.name}: ${d.progress}%`} />
      <div className={c.dlMeta}>
        <span>{bytes(d.sizeLeft)} left of {bytes(d.size)}</span>
        <span>{d.etaSec ? `${duration(d.etaSec)} left` : 'no ETA'}</span>
        <span>{state}</span>
        {d.episodes > 0 && <span>{plural(d.episodes, 'episode')}{d.episodeRange ? ` · ${d.episodeRange}` : ''}</span>}
      </div>
      {meta && <div className={c.dlMeta}><span>{meta}</span></div>}
      {d.problem && (
        <div className={c.warn} role={d.problem === 'failed' || d.problem === 'blocked' ? 'alert' : 'status'}>
          <Pill tone={PROBLEM_TONE[d.problem]}>{PROBLEM_WORD[d.problem]}</Pill>
          {d.messages.map((m, i) => <p key={i}>{m}</p>)}
          {d.hint && <p className={c.hint}>{d.hint}</p>}
        </div>
      )}
      <DownloadActions instance={instance} d={d} />
    </li>
  )
}

function Totals({ left, eta, progress, problem }: { left: number; eta: number | null; progress: number; problem: Problem | null }) {
  return (
    <>
      <span>{progress}%</span><span>{bytes(left)} left</span><span>{eta ? `${duration(eta)} left` : 'no ETA'}</span>
      {problem && <Pill tone={PROBLEM_TONE[problem]}>{PROBLEM_WORD[problem]}</Pill>}
    </>
  )
}

function ShowCard({ show, open, onToggle, isOpen, toggleKey }: {
  show: QShow; open: boolean; onToggle: () => void; isOpen: (k: string, dflt: boolean) => boolean; toggleKey: (k: string, current: boolean) => void
}) {
  const stalledItems = show.seasons.flatMap(se => se.downloads).filter(d => d.problem === 'stalled').map(d => ({ instance: 'sonarr' as const, id: d.id }))
  const stalledIn = stalledItems.length
  const tone = show.problem ? (PROBLEM_TONE[show.problem] === 'bad' ? 'var(--crit)' : 'var(--warn)') : 'var(--hx-accent)'
  return (
    <li className={c.group} data-problem={show.problem ?? undefined}>
      <button type="button" className={c.groupHead} aria-expanded={open} onClick={onToggle}>
        <Chevron open={open} />
        <RingGauge value={show.progress / 100} size={44} stroke={5} color={tone} text={`${Math.round(show.progress)}`} label={`${show.title} progress`} />
        <span className={c.groupTitle}>
          <b>{show.title}</b>
          <small>{plural(show.seasons.length, 'season')} · {plural(show.downloads, 'download')} · {plural(show.episodes, 'episode')}</small>
        </span>
        <span className={c.groupStats}><Totals left={show.sizeLeft} eta={show.etaSec} progress={show.progress} problem={show.problem} /></span>
      </button>
      {open && (
        <>
        <FixStalled keyName={show.key} label={`Fix ${stalledIn} stalled`} items={stalledItems} />
        <ul className={c.seasons}>
          {show.seasons.map(se => {
            const k = `${show.key}|${se.key}`
            const seOpen = isOpen(k, true)
            return (
              <li key={se.key} className={c.season} data-problem={se.problem ?? undefined}>
                <button type="button" className={c.seasonHead} aria-expanded={seOpen} onClick={() => toggleKey(k, seOpen)}>
                  <Chevron open={seOpen} />
                  <span className={c.seasonTitle}>{se.label} · {plural(se.episodes, 'episode')}{se.downloads.length === 1 && se.downloads[0].episodeRange ? ` · ${se.downloads[0].episodeRange}` : ''}</span>
                  <span className={c.groupStats}><Totals left={se.sizeLeft} eta={se.etaSec} progress={se.progress} problem={se.problem} /></span>
                </button>
                {seOpen && (
                  <>
                    <SeasonActions showKey={show.key} seasonKey={se.key} singles={se.downloads.filter(x => x.episodes === 1 && x.sizeLeft > 0).length} />
                    <ul className={c.dls}>{se.downloads.map(d => <DownloadRow key={d.id} d={d} instance="sonarr" />)}</ul>
                  </>
                )}
              </li>
            )
          })}
        </ul>
        </>
      )}
    </li>
  )
}

type QState = { data: QueueData | null; error: string | null; at: number | null; refresh?: () => void }

export function ArrQueue({ q }: { q: QState }) {
  return (
    <ActionsProvider refresh={q.refresh} canPrioritise={!!q.data?.capabilities?.prioritise}>
      <ArrQueueView q={q} />
    </ActionsProvider>
  )
}

function ArrQueueView({ q }: { q: QState }) {
  const { data, error } = q
  const [only, setOnly] = useState<'all' | 'problems'>('all')
  // Anything the reader opened or closed by hand. Everything else follows the default (problems open).
  const [manual, setManual] = useState<Record<string, boolean>>({})
  const [allOverride, setAllOverride] = useState<boolean | null>(null)

  const dflt = (k: string, fallback: boolean) => (k in manual ? manual[k] : allOverride !== null ? allOverride : fallback)
  const toggle = (k: string, current: boolean) => setManual(m => ({ ...m, [k]: !current }))

  const sm = data?.summary
  const shows = useMemo(() => (data?.shows ?? []).filter(x => only === 'all' || x.problem), [data, only])
  const movies = useMemo(() => (data?.movies ?? []).filter(x => only === 'all' || x.problem), [data, only])
  const allStalled = useMemo(() => [
    ...(data?.shows ?? []).flatMap(sh => sh.seasons.flatMap(se => se.downloads)).filter(d => d.problem === 'stalled').map(d => ({ instance: 'sonarr' as const, id: d.id })),
    ...(data?.movies ?? []).filter(m => m.problem === 'stalled').map(m => ({ instance: 'radarr' as const, id: m.id })),
  ], [data])
  const few = (data?.shows.length ?? 0) <= 3
  const down = data ? (['sonarr', 'radarr'] as const).filter(k => data.services[k].configured && !data.services[k].ok) : []
  const movieOpen = dflt('movies', true)

  return (
    <div className={c.root}>
      <Panel title="Queue" sub={sm ? `${plural(sm.downloads, 'DOWNLOAD')} · ${plural(sm.shows, 'SHOW')}${sm.movies ? ` · ${plural(sm.movies, 'MOVIE')}` : ''}` : undefined}>
        {sm && (
          <Tiles label="Queue summary" items={[
            { label: 'downloads', value: sm.downloads, tone: 'accent' },
            { label: 'shows', value: sm.shows },
            { label: 'left to fetch', value: bytes(sm.sizeLeft) },
            { label: 'needs you', value: sm.attention, tone: sm.attention ? 'crit' : 'good', title: 'Failed downloads and blocked imports' },
            { label: 'stalled or warning', value: sm.stalled + sm.warnings, tone: sm.stalled + sm.warnings ? 'warn' : undefined },
          ]} />
        )}
        {sm && sm.rows > sm.downloads && (
          <p className={c.fold}>{sm.rows} queue rows folded into {plural(sm.downloads, 'download')}: a season pack is one download, not one per episode.</p>
        )}
        <div className={c.bar}>
          <div className={c.seg} role="group" aria-label="Filter">
            <button type="button" aria-pressed={only === 'all'} onClick={() => setOnly('all')}>All</button>
            <button type="button" aria-pressed={only === 'problems'} onClick={() => setOnly('problems')}>Problems</button>
          </div>
          <div className={c.seg} role="group" aria-label="Groups">
            <button type="button" onClick={() => { setManual({}); setAllOverride(true) }}>Expand all</button>
            <button type="button" onClick={() => { setManual({}); setAllOverride(false) }}>Collapse all</button>
          </div>
        </div>
        <FixStalled keyName="all" label={`Fix all stalled (${allStalled.length})`} items={allStalled} />
        <ActionResults />
        {error && <p className={c.err} role="alert">{data ? `Showing the last reading. ${error}` : error}</p>}
        {down.map(k => (
          <p key={k} className={c.err} role="status">{k === 'sonarr' ? 'Sonarr' : 'Radarr'} is not answering{data!.services[k].error ? `: ${data!.services[k].error}` : ''}. Its queue is missing.</p>
        ))}
        {!data && !error && <p className={s.empty}>Reading the queue…</p>}
        {data && sm!.downloads === 0 && !error && !down.length && <p className={s.empty}>Both queues are empty.</p>}
        {data && sm!.downloads > 0 && shows.length + movies.length === 0 && <p className={s.empty}>No problems in the queue.</p>}
      </Panel>

      {shows.length > 0 && (
        <Panel title="Shows" sub={`${shows.length}`} level={3}>
          <ul className={c.groups}>
            {shows.map(sh => {
              const open = dflt(sh.key, few || !!sh.problem)
              return <ShowCard key={sh.key} show={sh} open={open} onToggle={() => toggle(sh.key, open)}
                isOpen={(k, f) => dflt(k, f)} toggleKey={toggle} />
            })}
          </ul>
        </Panel>
      )}

      {movies.length > 0 && (
        <Panel title="Movies" sub={`${movies.length}`} level={3}>
          <button type="button" className={c.moviesHead} aria-expanded={movieOpen} onClick={() => toggle('movies', movieOpen)}>
            <Chevron open={movieOpen} /> {movieOpen ? 'Hide' : 'Show'} {plural(movies.length, 'movie')}
          </button>
          {movieOpen && (
            <ul className={c.dls}>
              {movies.map(m => <DownloadRow key={m.id} d={m} instance="radarr" name={`${m.title}${m.year ? ` (${m.year})` : ''}`} />)}
            </ul>
          )}
        </Panel>
      )}
    </div>
  )
}
