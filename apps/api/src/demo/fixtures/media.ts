// Demo fixtures: the media side of the Plex and Arr Stack plug-ins: who is streaming (moving), the Library and Clear-out tabs,
// the grouped download queue and the Upcoming schedule. Posters are never fetched: no row carries an image, so the page
// draws its own title cards. Shapes follow apps/frontend/components/plugins/{plex,arr}/.
import type { FixtureRoute } from './types'
import { iso, HOUR, MIN, DAY, wobble, GiB, PEOPLE, seeded } from './data'

const ok = (data: unknown) => ({ success: true, data })

// ================================================================================ Plex: now streaming
const SESSIONS = [
  { title: 'Severance', episode: 'Who Is Alive?', number: 'S02E04', year: 2025, mediaType: 'episode', user: 'sam', player: 'Living Room TV', quality: '4K', mode: 'direct play', state: 'playing', len: 54 * 60, from: 0.38, bitrate: 22.1, lan: true },
  { title: 'Dune: Part Two', episode: null, number: null, year: 2024, mediaType: 'movie', user: 'jordan', player: 'iPad', quality: '1080p', mode: 'transcode', state: 'playing', len: 166 * 60, from: 0.71, bitrate: 8.0, lan: false },
  { title: 'Bluey', episode: 'Sleepytime', number: 'S02E26', year: 2018, mediaType: 'episode', user: 'casey', player: 'Kids Tablet', quality: '1080p', mode: 'direct stream', state: 'paused', len: 7 * 60, from: 0.52, bitrate: 5.4, lan: true },
]
/** Progress advances with the clock, so a poll a few seconds later shows people further into what they watch. */
export function plexSessions() {
  const t = Date.now() / 1000
  return SESSIONS.map(({ len, from, bitrate, lan, ...x }) => ({
    ...x, progress: x.state === 'paused' ? from * 100 : Math.min(99, (from * len + (t % 3000)) / len * 100), bitrateMbps: bitrate, location: lan ? 'lan' : 'wan',
  }))
}
export function plexLive() {
  const sessions = plexSessions()
  const lan = Math.round(wobble(32.4, 5, 'plan') * 10) / 10, wan = Math.round(wobble(9.2, 2.2, 'pwan') * 10) / 10
  return { ok: true, sessions, counts: { streams: 3, transcodes: 1, direct: 2 }, bandwidth: { totalMbps: Math.round((lan + wan) * 10) / 10, lanMbps: lan, wanMbps: wan } }
}
export const PLEX_LIBRARIES = [{ title: 'Movies', count: 842 }, { title: 'TV Shows', count: 188 }, { title: 'Kids', count: 96 }, { title: 'Music', count: 2310 }]

// ================================================================================ Plex: Library and Clear-out
const SECTIONS = [{ key: '1', title: 'Movies', kind: 'movie' as const }, { key: '2', title: 'TV Shows', kind: 'show' as const }, { key: '3', title: 'Kids', kind: 'show' as const }]
const SHOWS: Array<[string, number, number, number, number, number]> = [
  // title, year, GiB, plays, viewers, last played (days ago)
  ['Severance', 2022, 142, 41, 5, 0], ['The Bear', 2022, 96, 30, 4, 1], ['Andor', 2022, 118, 24, 4, 3], ['Shogun', 2024, 88, 20, 3, 2], ['Slow Horses', 2022, 134, 14, 3, 6],
  ['Bluey', 2018, 61, 88, 2, 0], ['Planet Earth III', 2023, 74, 5, 2, 40], ['The Expanse', 2015, 310, 9, 2, 75], ['Breaking Bad', 2008, 280, 3, 1, 200], ['Fargo', 2014, 205, 0, 0, 0],
  ['Silo', 2023, 70, 0, 0, 0], ['Foundation', 2021, 98, 1, 1, 310], ['Peaky Blinders', 2013, 190, 2, 1, 410], ['Black Mirror', 2011, 85, 0, 0, 0], ['Chernobyl', 2019, 24, 3, 2, 120], ['Wallace & Gromit Shorts', 1989, 6, 0, 0, 0],
]
const MOVIES: Array<[string, number, number, number, number, number]> = [
  ['Dune: Part Two', 2024, 38, 6, 3, 0], ['Arrival', 2016, 14, 4, 3, 12], ['Blade Runner 2049', 2017, 29, 5, 4, 18], ['Interstellar', 2014, 33, 8, 5, 25], ['The Martian', 2015, 19, 4, 3, 40],
  ['Spirited Away', 2001, 9, 7, 3, 9], ['Oppenheimer', 2023, 31, 3, 2, 50], ['Everything Everywhere All at Once', 2022, 22, 2, 2, 130], ['Mad Max: Fury Road', 2015, 27, 2, 1, 260], ['Gladiator', 2000, 18, 1, 1, 380],
  ['The Prestige', 2006, 16, 0, 0, 0], ['Moon', 2009, 8, 0, 0, 0], ['Sunshine', 2007, 12, 0, 0, 0], ['Ex Machina', 2014, 11, 1, 1, 520], ['Ad Astra', 2019, 15, 0, 0, 0], ['Gravity', 2013, 17, 0, 0, 0],
  ['Paddington 2', 2017, 7, 9, 2, 6], ['Coco', 2017, 9, 6, 2, 30], ['Soul', 2020, 8, 0, 0, 0], ['Arrival (Extended Cut)', 2016, 24, 0, 0, 0],
]
const MS = (days: number) => Date.now() - days * DAY

function libRows() {
  const row = (kind: 'show' | 'movie', i: number, [title, year, gib, plays, viewers, ago]: [string, number, number, number, number, number]) => {
    const watchedBy = PEOPLE.slice(0, viewers).map((name, k) => ({ name, how: (k === viewers - 1 && viewers > 1 && plays < 5 ? 'marked' : 'played') as 'played' | 'marked' }))
    const kids = kind === 'show' && ['Bluey', 'Wallace & Gromit Shorts'].includes(title)
    return {
      id: `${kind}:${kind === 'show' ? 1000 + i : 2000 + i}`, kind, ratingKey: String(kind === 'show' ? 1000 + i : 2000 + i), title, year,
      section: kind === 'movie' ? '1' : kids ? '3' : '2', sectionTitle: kind === 'movie' ? 'Movies' : kids ? 'Kids' : 'TV Shows',
      sizeBytes: Math.round(gib * GiB), plays, viewers, lastPlayed: plays ? MS(ago) : null, addedAt: MS(30 + Math.round(seeded(title) * 900)), art: null,
      watchers: viewers, marked: watchedBy.filter(w => w.how === 'marked').length, watchedBy, via: (kind === 'show' ? 'sonarr' : 'radarr') as 'sonarr' | 'radarr', keptBy: title === 'Severance' ? 'currently airing' : null, refused: null,
    }
  }
  return [...SHOWS.map((s, i) => row('show', i, s)), ...MOVIES.map((m, i) => row('movie', i, m))]
}
const watchState = () => ({ accounts: PEOPLE.length, shared: PEOPLE.length - 1, reading: false, done: PEOPLE.length, total: PEOPLE.length, at: Date.now() - 6 * MIN, note: null, ownerOnly: false })

function plexLibrary() {
  return { rows: libRows(), sections: SECTIONS, arr: { sonarr: true, radarr: true }, plexDeletes: true, historySince: MS(400), watchState: watchState() }
}

function plexShow(id: string) {
  const row = libRows().find(r => r.kind === 'show' && r.ratingKey === id) ?? libRows().find(r => r.kind === 'show')!
  const seasonsN = 1 + Math.floor(seeded(row.title + 's') * 3) + (row.sizeBytes > 150 * GiB ? 2 : 0)
  const seasons = Array.from({ length: seasonsN }, (_, s) => {
    const n = 6 + Math.floor(seeded(row.title + s) * 5)
    return {
      season: s + 1, title: `Season ${s + 1}`,
      episodes: Array.from({ length: n }, (_, e) => {
        const watched = s < seasonsN - 1 || e < n - 3
        return {
          ratingKey: `${id}${s + 1}${String(e + 1).padStart(2, '0')}`, season: s + 1, episode: e + 1, title: `Episode ${e + 1}`,
          sizeBytes: Math.round(row.sizeBytes / (seasonsN * n)), quality: row.sizeBytes / (seasonsN * n) > 3 * GiB ? '4K WEB-DL' : '1080p WEB-DL',
          plays: watched ? row.plays > 0 ? 1 + Math.floor(seeded(row.title + s + e) * 3) : 0 : 0, viewers: watched ? row.viewers : 0, lastPlayed: watched && row.plays ? MS(1 + s * 20 + e) : null,
          watched: watched && row.plays > 0, inProgress: false, nextUpFor: !watched && e === n - 3 ? [PEOPLE[0]] : [], nextUpCount: !watched && e === n - 3 ? 1 : 0,
          versions: [{ mediaId: `m${id}${s}${e}`, label: '1080p H.265', sizeBytes: Math.round(row.sizeBytes / (seasonsN * n)), files: [`/media/tv/${row.title}/Season ${s + 1}/E${e + 1}.mkv`] }],
          via: 'sonarr' as const, watchers: watched ? row.watchers : 0, marked: 0, watchedBy: [], refused: null,
        }
      }),
    }
  })
  return { show: { ratingKey: row.ratingKey, title: row.title, year: row.year, art: null, via: 'sonarr' as const, keptBy: row.keptBy, sizeBytes: row.sizeBytes, refused: null }, seasons, plexDeletes: true }
}

function clearout() {
  const rows = libRows().filter(r => r.plays === 0 || (r.lastPlayed !== null && Date.now() - r.lastPlayed > 180 * DAY)).map(r => ({
    id: r.id, kind: r.kind, title: r.title, year: r.year, section: r.section, sectionTitle: r.sectionTitle, sizeBytes: r.sizeBytes, plays: r.plays, viewers: r.viewers, lastPlayed: r.lastPlayed, addedAt: r.addedAt,
    list: r.plays === 0 ? 'never' as const : 'idle' as const, removable: true, via: r.via, art: null, refused: null, watchers: r.watchers, marked: r.marked, watchedBy: r.watchedBy,
  }))
  const tot = (kind: 'show' | 'movie') => {
    const all = libRows().filter(r => r.kind === kind), mine = rows.filter(r => r.kind === kind)
    return { items: all.length, unwatched: mine.length, unwatchedShare: mine.length / all.length, never: mine.filter(r => r.list === 'never').length, idle: mine.filter(r => r.list === 'idle').length, listBytes: mine.reduce((a, r) => a + (r.sizeBytes ?? 0), 0) }
  }
  return {
    generatedAt: Date.now() - 4 * MIN, historySince: MS(400), historyPlays: 3412, sizesFrom: { tv: 'arr' as const, movies: 'arr' as const }, arr: { sonarr: true, radarr: true }, sections: SECTIONS, rows,
    kept: [{ rule: 'airing', label: 'Still airing', tv: 3, movies: 0 }, { rule: 'recent', label: 'Added in the last 6 months', tv: 4, movies: 6 }, { rule: 'next-up', label: 'Someone’s next episode', tv: 2, movies: 0 }],
    totals: { tv: tot('show'), movies: tot('movie') }, cutoffs: { neverMinMonths: 6, idleMonths: 12 },
    notes: ['Sizes come from Sonarr and Radarr. Nothing is removed without a preview and a confirmation.'], watchState: watchState(),
  }
}

// ================================================================================ Arr Stack: queue
const prog = (base: number, key: string) => Math.min(99.5, Math.round((base + (((Date.now() / 1000) + seeded(key) * 900) % 900) / 900 * 22) * 10) / 10)
function dl(id: string, name: string, sizeGiB: number, progress: number, extra: Record<string, unknown> = {}) {
  const size = Math.round(sizeGiB * GiB), left = Math.round(size * (1 - progress / 100))
  return { id, name, size, sizeLeft: left, progress, etaSec: progress >= 100 ? null : Math.max(30, Math.round(left / 6.2e6)), status: 'downloading', state: 'downloading', quality: 'WEBDL-1080p', protocol: 'torrent', client: 'qBittorrent', indexer: 'EZTV',
    episodes: 1, episodeRange: null, problem: null, messages: [] as string[], ...extra }
}
function arrQueue() {
  const shogun = dl('q1', 'Shogun.2024.S01E05.1080p.WEB.h264', 2.9, prog(55, 'q1'), { episodeRange: 'E05' })
  const bear = dl('q2', 'The.Bear.S03.1080p.WEB.h264-GRP', 14.6, prog(31, 'q2'), { episodes: 10, episodeRange: 'E01-E10', indexer: 'YTS' })
  const horses = dl('q3', 'Slow.Horses.S04E02.1080p.WEB.h264', 1.8, 12, { status: 'warning', state: 'stalled', problem: 'stalled', etaSec: null, messages: ['No seeders have been seen for 2 hours.'], hint: 'Another release of this episode may be available; Fix stalled searches for it.', episodeRange: 'E02' })
  const andor = dl('q4', 'Andor.S02.2160p.WEB-DL.DV', 41, 100, { sizeLeft: 0, status: 'completed', state: 'importBlocked', quality: 'WEBDL-2160p', problem: 'blocked', etaSec: null, episodes: 12, episodeRange: 'E01-E12',
    messages: ['Episode S02E07 was not imported: a better quality file already exists.', 'Not an upgrade for existing episode file(s).'], hint: 'Clear it from the queue, or delete the library episode and import this one.' })
  const planet = dl('q5', 'Planet.Earth.III.S01E06.1080p.WEB.h264', 3.4, 100, { sizeLeft: 0, status: 'completed', state: 'imported', done: true, etaSec: null, messages: ['Imported two minutes ago.'], episodeRange: 'E06' })
  const season = (key: string, label: string, downloads: ReturnType<typeof dl>[]) => {
    const size = downloads.reduce((a, d) => a + d.size, 0), left = downloads.reduce((a, d) => a + d.sizeLeft, 0)
    return { key, label, downloads, episodes: downloads.reduce((a, d) => a + d.episodes, 0), size, sizeLeft: left, progress: Math.round((1 - left / size) * 100), etaSec: left ? Math.round(left / 6.2e6) : null,
      problem: downloads.map(d => d.problem).find(Boolean) ?? null, done: downloads.every(d => (d as any).done) }
  }
  const show = (key: string, title: string, seasons: ReturnType<typeof season>[]) => {
    const size = seasons.reduce((a, s) => a + s.size, 0), left = seasons.reduce((a, s) => a + s.sizeLeft, 0)
    return { key, title, seasons, downloads: seasons.reduce((a, s) => a + s.downloads.length, 0), episodes: seasons.reduce((a, s) => a + s.episodes, 0), size, sizeLeft: left, progress: Math.round((1 - left / size) * 100),
      etaSec: left ? Math.round(left / 6.2e6) : null, problem: seasons.map(s => s.problem).find(Boolean) ?? null, done: seasons.every(s => s.done) }
  }
  const shows = [
    show('shogun', 'Shogun', [season('s1', 'Season 1', [shogun])]), show('bear', 'The Bear', [season('s3', 'Season 3', [bear])]), show('horses', 'Slow Horses', [season('s4', 'Season 4', [horses])]),
    show('andor', 'Andor', [season('s2', 'Season 2', [andor])]), show('earth', 'Planet Earth III', [season('s1', 'Season 1', [planet])]),
  ]
  const film = (id: string, title: string, year: number, gib: number, p: number, extra: Record<string, unknown> = {}) => ({ ...dl(id, `${title.replace(/ /g, '.')}.${year}.1080p.BluRay.x265`, gib, p, { quality: 'Bluray-1080p', indexer: 'YTS', episodes: 0 }), title, year, ...extra })
  const movies = [film('m1', 'The Martian', 2015, 6.1, 100, { sizeLeft: 0, status: 'completed', state: 'seeding', done: true, etaSec: null, messages: ['Already in the library; seeding only.'] }), film('m2', 'Arrival', 2016, 7.4, prog(8, 'm2'))]
  const album = (key: string, title: string, d: ReturnType<typeof dl>) => ({ key, title, downloads: [d], tracks: 11, size: d.size, sizeLeft: d.sizeLeft, progress: Math.round(d.progress), etaSec: d.etaSec, problem: d.problem, done: false })
  const lp = dl('l1', 'The.Paper.Lanterns-Night.Market-2024-FLAC', 0.42, prog(40, 'l1'), { quality: 'FLAC', indexer: 'Nyaa', episodes: 0, albums: 1, tracks: 11 })
  const artists = [{ key: 'lanterns', title: 'The Paper Lanterns', albums: [album('nm', 'Night Market', lp)], downloads: 1, albumCount: 1, tracks: 11, size: lp.size, sizeLeft: lp.sizeLeft, progress: Math.round(lp.progress), etaSec: lp.etaSec, problem: null, done: false }]
  const all = [shogun, bear, horses, andor, planet, ...movies, lp]
  return {
    at: Date.now(), services: { sonarr: { ok: true, configured: true }, radarr: { ok: true, configured: true }, lidarr: { ok: true, configured: true } },
    summary: { downloads: all.length, shows: shows.length, movies: movies.length, artists: 1, albums: 1, rows: 24, sizeLeft: all.reduce((a, d) => a + d.sizeLeft, 0), attention: 2, stalled: 1, warnings: 1, done: 2 },
    shows, movies, artists, capabilities: { prioritise: true },
  }
}

// ================================================================================ Arr Stack: upcoming
function arrUpcoming(q: Record<string, string>) {
  const days = [7, 14, 30, 60].includes(Number(q.days)) ? Number(q.days) : 14
  const day = (n: number) => { const d = new Date(Date.now() + n * DAY); return d }
  const label = (n: number) => n === 0 ? 'Tonight' : n === 1 ? 'Tomorrow' : day(n).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' })
  const tv = (id: string, title: string, code: string, ep: string, network: string, hour: number, n: number, status: 'have' | 'downloading' | 'waiting' | 'upcoming', words: string, progress?: number) =>
    ({ id, kind: 'tv' as const, title, code, episodeTitle: ep, network, airUtc: new Date(Date.UTC(day(n).getUTCFullYear(), day(n).getUTCMonth(), day(n).getUTCDate(), hour)).toISOString(), when: `${String(hour).padStart(2, '0')}:00`, status, statusText: words, art: null, ...(progress ? { progress } : {}) })
  const film = (id: string, title: string, year: number, kind: 'cinema' | 'digital' | 'physical', when: string, status: 'have' | 'downloading' | 'waiting' | 'upcoming', words: string) =>
    ({ id, kind: 'film' as const, title, year, releaseKind: kind, releaseDate: when, when, status, statusText: words, art: null })
  const groups: Array<{ key: string; label: string; items: any[] }> = [
    { key: 'd0', label: label(0), items: [tv('u1', 'The Bear', 'S03E04', 'Forks', 'FX', 21, 0, 'downloading', 'Sonarr found a release and it is downloading.', 31), tv('u2', 'Slow Horses', 'S04E03', 'Hello Goodbye', 'Apple TV+', 23, 0, 'waiting', 'Aired; no release found yet, searching every hour.')] },
    { key: 'd1', label: label(1), items: [tv('u3', 'Shogun', 'S01E06', 'Broken to the Fist', 'FX', 22, 1, 'upcoming', 'Monitored; it will be grabbed when it airs.'), film('u4', 'Paddington 2', 2017, 'digital', 'Digital release', 'have', 'Already in the library.')] },
    { key: 'd3', label: label(3), items: [tv('u5', 'Andor', 'S03E01', 'New Arrivals', 'Disney+', 8, 3, 'upcoming', 'Monitored; it will be grabbed when it airs.')] },
    { key: 'd5', label: label(5), items: [film('u6', 'Dune: Part Three', 2026, 'cinema', 'In cinemas', 'upcoming', 'Monitored; Radarr waits for a digital release.'), tv('u7', 'Silo', 'S02E08', 'The Harder They Fall', 'Apple TV+', 20, 5, 'upcoming', 'Monitored.')] },
    { key: 'd9', label: label(9), items: [{ id: 'u8', kind: 'music' as const, title: 'Night Market', artist: 'The Paper Lanterns', albumType: 'Album', when: 'Release day', status: 'upcoming' as const, statusText: 'Monitored by Lidarr.', art: null }] },
  ].filter(g => Number(g.key.slice(1)) < days)
  const flat = groups.flatMap(g => g.items)
  return {
    at: Date.now(), tz: q.tz || 'UTC', days, services: { sonarr: { ok: true }, radarr: { ok: true }, lidarr: { ok: true } }, groups,
    counts: { tv: flat.filter(i => i.kind === 'tv').length, film: flat.filter(i => i.kind === 'film').length, tonight: groups[0]?.items.length ?? 0, downloading: flat.filter(i => i.status === 'downloading').length, music: flat.filter(i => i.kind === 'music').length },
    missing: {
      sonarr: { total: 5, items: [{ id: 'ms1', title: 'Fargo', detail: 'S05E03', date: iso(6 * DAY).slice(0, 10) }, { id: 'ms2', title: 'Foundation', detail: 'S03E01', date: iso(11 * DAY).slice(0, 10) }, { id: 'ms3', title: 'Peaky Blinders', detail: 'S02E04', date: iso(19 * DAY).slice(0, 10) }] },
      radarr: { total: 2, items: [{ id: 'mr1', title: 'Sunshine', detail: '2007', date: iso(2 * DAY).slice(0, 10) }, { id: 'mr2', title: 'Moon', detail: '2009', date: null }] },
      lidarr: { total: 1, items: [{ id: 'ml1', title: 'Lantern Light', detail: 'The Paper Lanterns', date: iso(30 * DAY).slice(0, 10) }] },
    },
  }
}

// ================================================================================ Arr Stack: the VPN panel
function arrVpn() {
  const now = Date.now()
  return {
    present: true, guest: 'media', tunnel: 'up', health: 'healthy', provider: 'example vpn', vpnType: 'WireGuard', location: 'Amsterdam, North Holland, Netherlands',
    chosen: 'Netherlands', publicIp: null, publicIpHidden: true, portForwarding: true, forwardedPort: 40123, listenPort: 40123, portMatch: 'ok',
    downBps: 8_400_000, upBps: 1_200_000, connection: 'connected', startedAt: new Date(now - 2 * DAY).toISOString(), uptimeSec: Math.round(2 * DAY / 1000),
    problems: [], readAt: new Date(now).toISOString(),
  }
}

// ================================================================================ Arr Stack: the Requests tab
function arrRequests() {
  const now = Date.now()
  const row = (id: number, kind: 'movie' | 'tv', title: string, year: number, group: string, where: string, ago: number, extra: Record<string, unknown> = {}) =>
    ({ id, kind, title, year, poster: null, group, where, progress: null, who: 'a family member', at: new Date(now - ago * DAY).toISOString(), seasons: kind === 'tv' ? 2 : null, sortedInto: null, reason: null, is4k: false, ...extra })
  const rows = [
    row(5, 'movie', 'Paper Lanterns', 2011, 'pending', 'Waiting for an admin to approve it.', 0.2),
    row(4, 'tv', 'Harbour Lights', 2021, 'downloading', 'Downloading, 62% done.', 1, { progress: 0.62 }),
    row(3, 'movie', 'Quiet Harbour', 2019, 'available', 'In the library, ready to watch.', 3, { sortedInto: 'Dramas' }),
    row(2, 'movie', 'Night Ferry', 2020, 'failed', 'Seerr could not send it to Radarr.', 4),
    row(1, 'movie', 'Copper Hills', 2018, 'approved', 'Approved. Radarr is looking for a copy.', 5),
  ]
  const counts: Record<string, number> = { pending: 0, approved: 0, downloading: 0, available: 0, failed: 0, declined: 0 }
  for (const r of rows) counts[r.group]++
  return { configured: true, rows, counts, readAt: new Date(now).toISOString(), capped: false }
}

void HOUR
export const MEDIA_ROUTES: FixtureRoute[] = [
  { path: '/api/plugins/arrstack/vpn', get: () => ok(arrVpn()) },
  { path: '/api/plugins/arrstack/requests', get: () => ok(arrRequests()) },
  { path: '/api/plugins/arrstack/requests/health', get: () => ok({ configured: true, problems: [], stale: [], staleId: '0000000000000000', readAt: new Date().toISOString() }) },
  { path: '/api/plugins/plex/live', get: () => ok(plexLive()) },
  { path: '/api/plugins/plex/library', get: () => ok(plexLibrary()) },
  { path: '/api/plugins/plex/library/show/:id', get: p => ok(plexShow(p.id)) },
  { path: '/api/plugins/plex/clearout', get: () => ok(clearout()) },
  { path: '/api/plugins/arrstack/queue', get: () => ok(arrQueue()) },
  { path: '/api/plugins/arrstack/upcoming', get: (_p, q) => ok(arrUpcoming(q)) },
  { path: '/api/plugins/arrstack/lidarr/test', get: () => ok({ ok: true, version: '2.8.4.4631' }) },
]
