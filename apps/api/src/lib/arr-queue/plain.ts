// =============================================================================
//  HyperProx — Arr Stack, the queue in plain words (pure)
//
//  One reading, three readers. The dashboard tile, the page header and the Advanced tab all take their numbers from
//  what this builds, so they cannot disagree. It takes the grouped queue (logic.ts) and, when qBittorrent is set up,
//  its torrent list, and answers:
//
//    items    one entry per show, film or artist, in the order the downloads really run (qBittorrent's queue order,
//             which is where "requests first, then the reserved slots, then everything else" is decided), each with a plain status:
//             "downloading · 3.9 h" or "waiting · 4th in line". A wait is never turned into an estimate: a torrent
//             that has not started has no ETA, whatever the client guesses.
//    needs    the items that need a person, one entry each with the fix that fits, in plain words.
//    summary  "56 shows · 3 films · 15 downloading now · 9.2 MB/s · 1 stuck" and the unit it counts in.
//
//  Counted per show, film and artist, never per episode, queue row or torrent: a season pack, or twenty single
//  episodes of one show, is one show. Release names and client state names stay in the download's own details.
//  Pure: no network, no clock.
// =============================================================================

import type { Problem, QueueData, QueueDownload } from './logic'

export type ItemKind = 'show' | 'film' | 'artist'
export type Instance = 'sonarr' | 'radarr' | 'lidarr'
export type LiveState = 'downloading' | 'waiting' | 'paused' | 'stuck' | 'problem' | 'done'

/** The few fields of a qBittorrent torrent this reads. */
export interface Torrent { hash?: unknown; state?: unknown; priority?: unknown; dlspeed?: unknown; eta?: unknown }
export interface QbitReading { torrents: Torrent[] | null; transfer: { dl_info_speed?: unknown; up_info_speed?: unknown } | null }

export interface PlainDownload {
  id: string
  state: LiveState
  /** "downloading · 3.9 h", "waiting", "needs you: failed". */
  text: string
  progress: number
  size: number
  sizeLeft: number
  episodes: number
  problem: Problem | null
  /** A torrent that can be moved to the top of the queue. */
  torrent: boolean
}
export interface PlainChild {
  key: string
  /** "Season 2 · 24 episodes", "Album name". */
  label: string
  state: LiveState
  text: string
  progress: number
  sizeLeft: number
  downloads: PlainDownload[]
}
export interface PlainItem {
  key: string
  kind: ItemKind
  instance: Instance
  title: string
  /** "2 seasons · 25 episodes", "2021", "3 albums". */
  detail: string
  /** 1 = first to download. */
  order: number
  state: LiveState
  text: string
  /** For a waiting item: its place among the waiting ones. */
  line: number | null
  progress: number
  sizeLeft: number
  etaSec: number | null
  problem: Problem | null
  /** Every download's id, and the ones with a problem. */
  downloadIds: string[]
  problemIds: string[]
  torrentIds: string[]
  children: PlainChild[]
}
export interface NeedItem {
  key: string
  kind: ItemKind
  instance: Instance
  title: string
  severity: 'bad' | 'warn'
  /** One plain sentence. */
  what: string
  /** Downloads with a problem (the Fix works on these). */
  problemIds: string[]
  /** Blocked imports among them: the import can be tried again before a new copy is looked for. */
  retryIds: string[]
  /** A finished download Sonarr or Radarr cannot import. */
  blocked: boolean
}
export interface PlainSummary {
  shows: number
  films: number
  artists: number
  downloading: number
  waiting: number
  /** Items that need a person: stuck, failed or blocked in the queue, plus failed requests and Seerr faults. */
  stuck: number
  /** The part of `stuck` that comes from requests (failed ones and Seerr faults). */
  requestsStuck: number
  done: number
  sizeLeft: number
  speedBps: number | null
  text: string
  unit: string
}
export interface PlainData { summary: PlainSummary; items: PlainItem[]; needs: NeedItem[] }

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const ACTIVE = new Set(['downloading', 'forcedDL', 'metaDL', 'forcedMetaDL'])
const QUEUED = new Set(['queuedDL', 'checkingDL', 'checkingResumeData', 'allocating'])
const PAUSED = /^(?:paused|stopped)DL$/
const TORRENT_ID = /^d:(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$/
const BAD: Problem[] = ['failed', 'blocked', 'incomplete', 'sample']

/** "9.2 MB/s". */
export function rateWord(bps: number): string {
  if (!(bps > 0)) return '0 KB/s'
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(bps >= 10_000_000 ? 0 : 1)} MB/s`
  return `${Math.max(1, Math.round(bps / 1000))} KB/s`
}

/** "45 min", "3.9 h". Null for no estimate, or one longer than two days (that is a guess, not an ETA). */
export function etaWord(sec: number | null): string | null {
  if (sec === null || !(sec > 0)) return null
  if (sec >= 48 * 3600) return null
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} min`
  return `${(sec / 3600).toFixed(1)} h`
}

const ordinal = (n: number): string => {
  const m100 = n % 100
  if (m100 >= 11 && m100 <= 13) return `${n}th`
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`
}

/** One sentence for what is wrong, with no client words. */
export function problemSentence(p: Problem, n = 1): string {
  const many = n > 1
  switch (p) {
    case 'failed': return many ? `${n} downloads failed.` : 'The download failed.'
    case 'blocked': return many ? `${n} downloads finished but can't be added to your library.` : "It finished downloading but can't be added to your library."
    case 'incomplete': return many ? `${n} packs are missing some episodes.` : 'The pack is missing some episodes.'
    case 'sample': return many ? `${n} downloads are only short sample clips.` : 'Only a short sample clip came down.'
    case 'stalled': return many ? `${n} downloads are stuck. Nobody is sharing them.` : 'The download is stuck. Nobody is sharing it.'
    case 'warning': return many ? `${n} downloads have a problem the download client reported.` : 'The download client reported a problem with it.'
  }
}

const SEVERITY: Record<Problem, number> = { failed: 0, blocked: 1, incomplete: 1, sample: 1, stalled: 2, warning: 3 }

interface Live { priority: number | null; state: string; dlspeed: number; eta: number | null }

function liveOf(t: Torrent | undefined): Live | null {
  if (!t) return null
  const pr = num(t.priority)
  const eta = num(t.eta)
  return { priority: pr > 0 ? pr : null, state: String(t.state ?? ''), dlspeed: num(t.dlspeed), eta: eta > 0 && eta < 8_640_000 ? eta : null }
}

function downloadState(d: QueueDownload, live: Live | null): { state: LiveState; eta: number | null } {
  if (d.done) return { state: 'done', eta: null }
  if (d.problem && BAD.includes(d.problem)) return { state: 'problem', eta: null }
  if (d.problem === 'stalled' || d.problem === 'warning') return { state: 'stuck', eta: null }
  if (live) {
    if (ACTIVE.has(live.state) || live.dlspeed > 0) return { state: 'downloading', eta: live.eta ?? d.etaSec }
    if (PAUSED.test(live.state)) return { state: 'paused', eta: null }
    return { state: 'waiting', eta: null }
  }
  const s = d.status.toLowerCase()
  if (s === 'paused') return { state: 'paused', eta: null }
  if (s === 'queued' || s === 'delay' || s.startsWith('pending')) return { state: 'waiting', eta: null }
  return { state: d.progress > 0 || d.etaSec ? 'downloading' : 'waiting', eta: d.etaSec }
}

/** The state of a group of downloads: what is happening beats what is not. */
function groupState(states: LiveState[]): LiveState {
  for (const s of ['downloading', 'waiting', 'paused'] as const) if (states.includes(s)) return s
  if (states.includes('problem')) return 'problem'
  if (states.includes('stuck')) return 'stuck'
  return 'done'
}

function textOf(state: LiveState, eta: number | null, problem: Problem | null, line: number | null): string {
  switch (state) {
    case 'downloading': { const w = etaWord(eta); return w ? `downloading · ${w}` : 'downloading' }
    case 'waiting': return line ? `waiting · ${ordinal(line)} in line` : 'waiting'
    case 'paused': return 'paused'
    case 'stuck': return 'stuck'
    case 'problem': return problem === 'failed' ? 'failed' : problem === 'blocked' ? "can't be added" : 'needs you'
    case 'done': return 'finished, ready to clear'
  }
}

const worst = (ps: Array<Problem | null>): Problem | null => ps.reduce<Problem | null>((a, p) => (p === null ? a : a === null || SEVERITY[p] < SEVERITY[a] ? p : a), null)

export function buildPlain(q: QueueData, qbit: QbitReading | null, requestsStuck = 0): PlainData {
  const byHash = new Map<string, Torrent>()
  for (const t of qbit?.torrents ?? []) { const h = String(t.hash ?? '').toLowerCase(); if (h) byHash.set(h, t) }
  const liveFor = (id: string): Live | null => (TORRENT_ID.test(id) ? liveOf(byHash.get(id.slice(2).toLowerCase())) : null)

  interface Raw { item: PlainItem; prio: number; index: number; all: QueueDownload[] }
  const raws: Raw[] = []
  let index = 0

  const dlOf = (d: QueueDownload) => {
    const live = liveFor(d.id)
    const st = downloadState(d, live)
    const pd: PlainDownload = {
      id: d.id, state: st.state, text: textOf(st.state, st.eta, d.problem, null), progress: d.progress, size: d.size, sizeLeft: d.sizeLeft,
      episodes: d.episodes, problem: d.problem, torrent: TORRENT_ID.test(d.id) && live !== null,
    }
    return { pd, prio: live?.priority ?? null, eta: st.eta }
  }
  const childOf = (key: string, label: string, ds: QueueDownload[]) => {
    const parts = ds.map(dlOf)
    const state = groupState(parts.map(x => x.pd.state))
    const etas = parts.filter(x => x.pd.state === 'downloading' && x.eta !== null).map(x => x.eta as number)
    const eta = etas.length ? Math.max(...etas) : null
    const problem = worst(ds.map(d => (d.done ? null : d.problem)))
    const prios = parts.map(x => x.prio).filter((n): n is number => n !== null)
    const sizeLeft = ds.reduce((t, d) => t + d.sizeLeft, 0), size = ds.reduce((t, d) => t + d.size, 0)
    const child: PlainChild = {
      key, label, state, text: textOf(state, eta, problem, null), progress: size > 0 ? Math.round(((size - sizeLeft) / size) * 1000) / 10 : 0,
      sizeLeft, downloads: parts.map(x => x.pd),
    }
    return { child, prio: prios.length ? Math.min(...prios) : null, eta, problem }
  }
  const itemOf = (key: string, kind: ItemKind, instance: Instance, title: string, detail: string, kids: Array<{ key: string; label: string; ds: QueueDownload[] }>) => {
    const parts = kids.map(k => childOf(k.key, k.label, k.ds))
    const all = kids.flatMap(k => k.ds)
    const state = groupState(parts.map(p => p.child.state))
    const etas = parts.filter(p => p.child.state === 'downloading' && p.eta !== null).map(p => p.eta as number)
    const eta = etas.length ? Math.max(...etas) : null
    const problem = worst(parts.map(p => p.problem))
    const prios = parts.map(p => p.prio).filter((n): n is number => n !== null)
    const sizeLeft = all.reduce((t, d) => t + d.sizeLeft, 0), size = all.reduce((t, d) => t + d.size, 0)
    const plainDls = parts.flatMap(p => p.child.downloads)
    const item: PlainItem = {
      key, kind, instance, title, detail, order: 0, state, text: textOf(state, eta, problem, null), line: null,
      progress: size > 0 ? Math.round(((size - sizeLeft) / size) * 1000) / 10 : 0, sizeLeft, etaSec: eta, problem,
      downloadIds: all.map(d => d.id),
      problemIds: plainDls.filter(x => x.state === 'problem' || x.state === 'stuck').map(x => x.id),
      torrentIds: plainDls.filter(x => x.torrent && x.state !== 'done').map(x => x.id),
      children: parts.map(p => p.child),
    }
    raws.push({ item, prio: prios.length ? Math.min(...prios) : Infinity, index: index++, all })
  }

  for (const sh of q.shows) {
    const eps = sh.episodes
    itemOf(sh.key, 'show', 'sonarr', sh.title, `${plural(sh.seasons.length, 'season')} · ${plural(eps, 'episode')}`,
      sh.seasons.map(se => ({ key: se.key, label: `${se.label} · ${plural(se.episodes, 'episode')}`, ds: se.downloads })))
  }
  for (const m of q.movies) {
    itemOf(m.id, 'film', 'radarr', m.title, m.year ? String(m.year) : 'film', [{ key: m.id, label: m.title, ds: [m] }])
  }
  for (const ar of q.artists ?? []) {
    itemOf(ar.key, 'artist', 'lidarr', ar.title, plural(ar.albumCount || ar.albums.length, 'album'),
      ar.albums.map(al => ({ key: al.key, label: al.title, ds: al.downloads })))
  }

  // The real order: qBittorrent's own queue position. Anything it does not know of follows, in the order the page had before.
  raws.sort((a, b) => a.prio - b.prio || a.index - b.index)
  let line = 0
  raws.forEach((r, i) => {
    r.item.order = i + 1
    if (r.item.state === 'waiting') { line++; r.item.line = line; r.item.text = textOf('waiting', null, r.item.problem, line) }
    for (const ch of r.item.children) {
      // A season's own place in line is not shown: the item carries it.
      if (ch.state === 'waiting') ch.text = 'waiting'
    }
  })
  const items = raws.map(r => r.item)

  const needs: NeedItem[] = []
  for (const r of raws) {
    const it = r.item
    if (!it.problem) continue
    const mine = r.all.filter(d => !d.done && d.problem !== null)
    const worstP = worst(mine.map(d => d.problem))!
    const sameWorst = mine.filter(d => d.problem === worstP).length
    needs.push({
      key: it.key, kind: it.kind, instance: it.instance, title: it.title,
      severity: BAD.includes(worstP) ? 'bad' : 'warn',
      what: new Set(mine.map(d => d.problem)).size > 1 ? `${mine.length} downloads have a problem.` : problemSentence(worstP, sameWorst),
      problemIds: mine.map(d => d.id),
      retryIds: mine.filter(d => d.problem === 'blocked' && (d.state === 'importBlocked' || d.state === 'importFailed' || d.state === 'importPending')).map(d => d.id),
      blocked: mine.some(d => d.problem === 'blocked'),
    })
  }
  needs.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'bad' ? -1 : 1))

  const count = (k: ItemKind) => items.filter(i => i.kind === k).length
  const downloading = items.filter(i => i.state === 'downloading').length
  const stuck = needs.length + requestsStuck
  const sizeLeft = items.reduce((t, i) => t + i.sizeLeft, 0)
  const speedBps = qbit?.transfer ? num(qbit.transfer.dl_info_speed) : null
  const shows = count('show'), films = count('film'), artists = count('artist')
  const parts: string[] = []
  if (shows) parts.push(plural(shows, 'show'))
  if (films) parts.push(plural(films, 'film'))
  if (artists) parts.push(plural(artists, 'artist'))
  const text = parts.length === 0
    ? (stuck ? `Nothing downloading · ${stuck} stuck` : 'Nothing downloading')
    : [...parts, `${downloading} downloading now`, ...(speedBps !== null && speedBps > 0 ? [rateWord(speedBps)] : []), stuck ? `${stuck} stuck` : 'nothing stuck'].join(' · ')
  return {
    summary: {
      shows, films, artists, downloading, waiting: items.filter(i => i.state === 'waiting').length, stuck, requestsStuck,
      done: items.filter(i => i.state === 'done').length, sizeLeft, speedBps, text,
      unit: `Counted as ${q.services.lidarr.configured ? 'shows, films and artists' : 'shows and films'}. A season pack, or twenty single episodes of one show, is one show.`,
    },
    items, needs,
  }
}
