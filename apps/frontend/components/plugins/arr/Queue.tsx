'use client'

// =============================================================================
//  HyperProx — Arr Stack, Downloading
//
//  What is downloading, one line per show, film or artist, in the order the downloads really run (qBittorrent's queue
//  order, which is where requests, the reserved slots and the rest are sorted). The status is plain: "downloading ·
//  3.9 h" or "waiting · 4th in line", never an estimate for something that has not started. Tap a row for its seasons
//  (or albums), tap a season for its files; release names, quality and the download client's own state words live only
//  under that last level's "Technical details". Everything shown comes from the queue route's `plain` reading
//  (lib/arr-queue/plain.ts), the same one the dashboard tile and the header use. One "⋯" menu per row: Fix, Find
//  better copy, Move to top, Remove (QueueActions.tsx; admins only). The reading comes from
//  /api/plugins/arrstack/queue every few seconds, shared by every open page, and pauses while the tab is hidden.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { apiJson, failureText } from '@/lib/api'
import { Panel, ProgressBar, styles as s } from '@/components/visual/kit'
import { ActionBox, ActionResults, ActionsProvider, ClearDone, FixChoices, ItemMenu, SeasonActions, itemKey, useFix, type FixTarget, type Instance } from './QueueActions'
import { KIND_WORD, findableId, leftWord, sizeWord, type PlainChild, type PlainData, type PlainDownload, type PlainItem } from './arr-plain'
import c from './queue.module.css'

export type Problem = 'failed' | 'blocked' | 'incomplete' | 'sample' | 'stalled' | 'warning'
export interface QDownload {
  id: string; name: string; size: number; sizeLeft: number; progress: number; etaSec: number | null
  status: string; state: string; quality: string | null; protocol: string | null; client: string | null; indexer: string | null
  episodes: number; episodeRange: string | null; /** Lidarr only. */ albums?: number; tracks?: number
  problem: Problem | null; done?: boolean; why?: string | null; messages: string[]; hint?: string | null
}
export interface QSeason { key: string; label: string; downloads: QDownload[]; episodes: number; size: number; sizeLeft: number; progress: number; etaSec: number | null; problem: Problem | null; done?: boolean }
export interface QShow { key: string; title: string; seasons: QSeason[]; downloads: number; episodes: number; size: number; sizeLeft: number; progress: number; etaSec: number | null; problem: Problem | null; done?: boolean }
export interface QMovie extends QDownload { title: string; year: number | null }
export interface QAlbum { key: string; title: string; downloads: QDownload[]; tracks: number; size: number; sizeLeft: number; progress: number; etaSec: number | null; problem: Problem | null; done?: boolean }
export interface QArtist { key: string; title: string; albums: QAlbum[]; downloads: number; albumCount: number; tracks: number; size: number; sizeLeft: number; progress: number; etaSec: number | null; problem: Problem | null; done?: boolean }
export interface QueueData {
  at: number
  services: { sonarr: { ok: boolean; configured: boolean; error?: string }; radarr: { ok: boolean; configured: boolean; error?: string }; lidarr?: { ok: boolean; configured: boolean; error?: string } }
  summary: { downloads: number; shows: number; movies: number; artists?: number; albums?: number; rows: number; sizeLeft: number; attention: number; stalled: number; warnings: number; done?: number }
  shows: QShow[]
  movies: QMovie[]
  /** Music (Lidarr). Empty, and every music field absent from the page, when Lidarr is not set up. */
  artists?: QArtist[]
  capabilities?: { prioritise: boolean }
  /** The queue in plain words (lib/arr-queue/plain.ts): the summary, the rows in download order, and what needs a person. */
  plain: PlainData
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
      } catch (e: any) { fails++; if (!gone) setError(failureText(e, 'The queue could not be read.')) } finally { busy.current = false; schedule() }
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


/** Everything the page shows is built from this one reading; `data` is null until the first one arrives. */
export type QState = { data: QueueData | null; error: string | null; at: number | null; refresh?: () => void }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function Chevron({ open }: { open: boolean }) {
  return <span aria-hidden className={c.chev} data-open={open}>▶</span>
}

/** Every download in the reading by id, for the details level (release name, quality and the like). */
function detailMap(data: QueueData): Map<string, QDownload> {
  const m = new Map<string, QDownload>()
  for (const sh of data.shows) for (const se of sh.seasons) for (const d of se.downloads) m.set(d.id, d)
  for (const mv of data.movies) m.set(mv.id, mv)
  for (const ar of data.artists ?? []) for (const al of ar.albums) for (const d of al.downloads) m.set(d.id, d)
  return m
}

const words = (v: string) => v.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()

/** Where a row's own status sits: a dot in its state's colour, then the words. */
function Status({ state, text }: { state: PlainItem['state']; text: string }) {
  return <span className={c.status} data-state={state}><i aria-hidden />{text}</span>
}

/** One download: what it is for, how far along, any problem in plain words, then its technical details folded away. */
export function FileRow({ pd, d, instance, title, canFindBetter }: { pd: PlainDownload; d: QDownload | undefined; instance: Instance; title: string; canFindBetter: boolean }) {
  const target: FixTarget = {
    id: pd.id, title, instance, downloadIds: [pd.id],
    problemIds: pd.state === 'problem' || pd.state === 'stuck' ? [pd.id] : [],
    retryIds: pd.problem === 'blocked' && d && (d.state === 'importBlocked' || d.state === 'importFailed' || d.state === 'importPending') ? [pd.id] : [],
    torrentIds: pd.torrent && pd.state !== 'done' ? [pd.id] : [],
    findable: canFindBetter ? findableId({ downloadIds: [pd.id] }) : null,
    done: pd.state === 'done',
  }
  const fix = useFix(target)
  const tech = d ? [d.name, d.quality, d.protocol, d.client, d.indexer, d.state ? words(d.state) : null].filter(Boolean) : []
  return (
    <li className={c.file} data-state={pd.state}>
      <div className={c.fileHead}>
        <span className={c.fileLeft}>{leftWord(pd.sizeLeft) || 'nothing left to fetch'} of {sizeWord(pd.size)}{pd.episodes > 1 ? ` · ${plural(pd.episodes, 'episode')}${d?.episodeRange ? ` (${d.episodeRange})` : ''}` : ''}</span>
        <Status state={pd.state} text={pd.text} />
        <ItemMenu t={target} fix={fix} />
      </div>
      <ProgressBar value={pd.progress} variant={pd.state === 'stuck' ? 'stall' : 'normal'} label={`${title}: ${pd.progress}%`} />
      {d?.why && <p className={c.why}><b>Why this download:</b> {d.why}</p>}
      {d && d.problem && d.messages.length > 0 && (
        <div className={c.warn} role={pd.state === 'problem' ? 'alert' : 'status'}>
          {d.messages.slice(0, 2).map((m, i) => <p key={i}>{m}</p>)}
          {d.hint && <p className={c.hint}>{d.hint}</p>}
        </div>
      )}
      <FixChoices fix={fix} />
      <ActionBox k={itemKey(target)} />
      {tech.length > 0 && (
        <details className={c.details}>
          <summary>Technical details</summary>
          <p><b>Release:</b> {tech[0]}</p>
          <p>{tech.slice(1).join(' · ')}</p>
          {d && d.messages.length > 0 && d.messages.map((m, i) => <p key={i}>{m}</p>)}
        </details>
      )}
    </li>
  )
}

export function ChildRow({ ch, instance, title, dmap, single, swap }: { ch: PlainChild; instance: Instance; title: string; dmap: Map<string, QDownload>; single: boolean; swap: string | null }) {
  const [open, setOpen] = useState(single || ch.state === 'problem' || ch.state === 'stuck')
  return (
    <li className={c.child} data-state={ch.state}>
      {!single && (
        <button type="button" className={c.childHead} aria-expanded={open} onClick={() => setOpen(o => !o)}>
          <Chevron open={open} />
          <span className={c.childTitle}>{ch.label}</span>
          <span className={c.childMeta}><span>{ch.progress}%</span><Status state={ch.state} text={ch.text} /></span>
        </button>
      )}
      {open && swap && <SwapForPack showKey={swap} childKey={ch.key} downloads={ch.downloads} />}
      {open && <ul className={c.files}>{ch.downloads.map(pd => <FileRow key={pd.id} pd={pd} d={dmap.get(pd.id)} instance={instance} title={single ? title : `${title} · ${ch.label}`} canFindBetter={ch.downloads.length === 1} />)}</ul>}
    </li>
  )
}

/** The one line for a show, film or artist. */
export function ItemRow({ it, dmap, swapSingles }: { it: PlainItem; dmap: Map<string, QDownload>; swapSingles: boolean }) {
  const [open, setOpen] = useState(false)
  const film = it.kind === 'film'
  const target: FixTarget = {
    id: it.key, title: it.title, instance: it.instance, downloadIds: it.downloadIds, problemIds: it.problemIds,
    retryIds: it.problemIds.filter(id => { const d = dmap.get(id); return d?.problem === 'blocked' && (d.state === 'importBlocked' || d.state === 'importFailed' || d.state === 'importPending') }),
    torrentIds: it.torrentIds, findable: findableId(it), done: it.state === 'done',
  }
  const fix = useFix(target)
  return (
    <li className={c.item} data-state={it.state} data-problem={it.problem ?? undefined}>
      <div className={c.itemHead}>
        <button type="button" className={c.itemMain} aria-expanded={open} onClick={() => setOpen(o => !o)}>
          <span className={c.ord} aria-label={`Number ${it.order} in the queue`}>{it.order}</span>
          <Chevron open={open} />
          <span className={c.itemTitle}>
            <b>{it.title}</b>
            <small>{KIND_WORD[it.kind]} · {it.detail}{leftWord(it.sizeLeft) ? ` · ${leftWord(it.sizeLeft)}` : ''}</small>
          </span>
          <Status state={it.state} text={it.text} />
        </button>
        <ItemMenu t={target} fix={fix} />
      </div>
      <div className={c.thin} aria-hidden><i style={{ width: `${Math.max(0, Math.min(100, it.progress))}%` }} /></div>
      <FixChoices fix={fix} />
      <ActionBox k={itemKey(target)} />
      {open && (
        <ul className={c.children}>
          {it.children.map(ch => (
            <ChildRow key={ch.key} ch={ch} instance={it.instance} title={it.title} dmap={dmap} single={film || (it.children.length === 1 && it.kind !== 'show')}
              swap={swapSingles && it.kind === 'show' ? it.key : null} />
          ))}
        </ul>
      )}
    </li>
  )
}

/** "Swap N singles for a season pack", offered under a season that still has two or more single episodes downloading. */
function SwapForPack({ showKey, childKey, downloads }: { showKey: string; childKey: string; downloads: PlainDownload[] }) {
  const singles = downloads.filter(d => d.episodes === 1 && d.sizeLeft > 0).length
  return <SeasonActions showKey={showKey} seasonKey={childKey} singles={singles} />
}

const PAGE = 100

/** The buttons' state, shared by every tab of the page, so a result or a confirmation survives a tab change. */
export function ArrActions({ q, children }: { q: QState; children: ReactNode }) {
  return <ActionsProvider refresh={q.refresh} canPrioritise={!!q.data?.capabilities?.prioritise}>{children}</ActionsProvider>
}

export function ArrQueue({ q }: { q: QState }) { return <ArrDownloadingView q={q} /> }

export function ArrDownloadingView({ q }: { q: QState }) {
  const { data, error } = q
  const [shown, setShown] = useState(PAGE)
  const plain = data?.plain
  const dmap = useMemo(() => (data ? detailMap(data) : new Map<string, QDownload>()), [data])
  const done = useMemo(() => {
    const out: Array<{ instance: Instance; id: string }> = []
    for (const sh of data?.shows ?? []) for (const se of sh.seasons) for (const d of se.downloads) if (d.done) out.push({ instance: 'sonarr', id: d.id })
    for (const m of data?.movies ?? []) if (m.done) out.push({ instance: 'radarr', id: m.id })
    for (const ar of data?.artists ?? []) for (const al of ar.albums) for (const d of al.downloads) if (d.done) out.push({ instance: 'lidarr', id: d.id })
    return out
  }, [data])
  const down = data ? (['sonarr', 'radarr', 'lidarr'] as const).filter(k => data.services[k]?.configured && !data.services[k]?.ok) : []
  const items = plain?.items ?? []
  return (
    <div className={c.root}>
      <Panel title="Downloading" sub={plain ? `${items.length} IN LINE` : undefined} className={c.panel}>
        {plain && <p className={c.unit}>{plain.summary.unit}</p>}
        <ClearDone items={done} />
        <ActionResults />
        {error && <p className={c.err} role="alert">{data ? `Showing the last reading. ${error}` : error}</p>}
        {down.map(k => (
          <p key={k} className={c.err} role="status">{k === 'sonarr' ? 'Sonarr' : k === 'lidarr' ? 'Lidarr' : 'Radarr'} is not answering{data!.services[k]?.error ? `: ${data!.services[k]!.error}` : ''}. Its downloads are missing here.</p>
        ))}
        {!data && !error && <p className={s.empty}>Reading the queue…</p>}
        {data && items.length === 0 && !error && !down.length && <p className={s.empty}>Nothing is downloading.</p>}
        {items.length > 0 && (
          <ul className={c.items} aria-label="Downloads, in the order they run">
            {items.slice(0, shown).map(it => <ItemRow key={`${it.instance}:${it.key}`} it={it} dmap={dmap} swapSingles />)}
          </ul>
        )}
        {items.length > shown && <button type="button" className={c.more} onClick={() => setShown(n => n + PAGE)}>Show {Math.min(PAGE, items.length - shown)} more ({items.length - shown} not shown)</button>}
      </Panel>
    </div>
  )
}
