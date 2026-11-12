// Arr Stack queue: the quality profile decides what "may replace" and "already have" mean, a pack that says
// "Not a quality revision upgrade" is done once every episode has a file, and a download whose only message is
// "Sample" is a real problem explained in plain words. All titles are made up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupRadarr, groupSonarr, isDone, summarize } from '../src/lib/arr-queue/logic'
import { compileProfile, profileVerdict, whyLidarr, whyRadarr, whySample, whySonarr, type FileInfo } from '../src/lib/arr-queue/why'
import { FileCache, ProfileCache, readAlbumInfo, readEpisodeInfo, readMovieInfo, readProfiles } from '../src/lib/arr-queue/lookup'

const NOW = Date.parse('2026-06-15T12:00:00Z')
const GB = 1e9

// ── quality profiles, in Sonarr's JSON shape ─────────────────────────────────

const q = (id: number, name: string, allowed = true) => ({ quality: { id, name }, items: [], allowed })
/** HDTV-720p < WEBDL-1080p < Bluray-1080p, cutoff and upgrade switch as given. */
const profile = (cutoff: number, upgradeAllowed = true, bluray = true) => ({
  id: 4, name: 'Example 1080p', upgradeAllowed, cutoff, items: [q(4, 'HDTV-720p'), q(3, 'WEBDL-1080p'), q(7, 'Bluray-1080p', bluray)],
})
const F = (quality: string | null, n: number, p: any = null): FileInfo => ({ hasFile: quality !== null, quality, season: 2, number: n, profile: p ? compileProfile(p) : null })

test('profile: items in order, a group shares one place, the cutoff may be a quality or a group', () => {
  const p = compileProfile({
    name: 'G', upgradeAllowed: true, cutoff: 1000,
    items: [q(4, 'HDTV-720p'), { id: 1000, name: 'WEB 1080p', items: [{ quality: { id: 3, name: 'WEBDL-1080p' } }, { quality: { id: 15, name: 'WEBRip-1080p' } }], allowed: true }, q(7, 'Bluray-1080p')],
  })!
  assert.equal(p.order.get('WEBDL-1080p'), 1)
  assert.equal(p.order.get('WEBRip-1080p'), 1)
  assert.equal(p.cutoff, 1)
  assert.equal(compileProfile({ items: [] }), null)
  assert.equal(compileProfile(null), null)
})

test('cutoff: below the cutoff and a higher-ranked release → may replace; at or above → already have; upgrades off → already have', () => {
  const eps = (have: string, p: any, rel = 'Bluray-1080p') => whySonarr([1], new Map([[1, { ...F(have, 1, p), season: 1 }]]), rel, false)
  assert.equal(eps('WEBDL-1080p', profile(7)), 'May replace E01 (WEB-DL → Bluray)')
  assert.equal(eps('WEBDL-1080p', profile(3)), 'Already have E01 (meets your quality target, will be skipped)')
  assert.equal(eps('Bluray-1080p', profile(3), 'WEBDL-1080p'), 'Already have E01 (will be skipped)')
  assert.equal(eps('WEBDL-1080p', profile(7, false)), 'Already have E01 (meets your quality target, will be skipped)')
  assert.equal(eps('HDTV-720p', profile(3), 'WEBDL-1080p'), 'Upgrades E01 (720p → 1080p)')
  assert.equal(eps('WEBDL-1080p', profile(3, true, false)), 'Already have E01 (meets your quality target, will be skipped)', 'a release the profile does not allow is never an upgrade')
  const prof = compileProfile(profile(7))
  assert.equal(profileVerdict(prof, 'WEBDL-1080p', 'Bluray-1080p'), 'upgrade')
  assert.equal(profileVerdict(prof, 'Unlisted-Quality', 'Bluray-1080p'), null, 'a file quality the profile does not know falls back to the generic ranking')
})

test('cutoff: qualities in one group are the same place, so neither replaces the other', () => {
  const p = { name: 'G', upgradeAllowed: true, cutoff: 1000, items: [q(4, 'HDTV-720p'), { id: 1000, name: 'WEB 1080p', items: [{ quality: { id: 3, name: 'WEBDL-1080p' } }, { quality: { id: 15, name: 'WEBRip-1080p' } }], allowed: true }] }
  assert.equal(whySonarr([1], new Map([[1, F('WEBRip-1080p', 1, p)]]), 'WEBDL-1080p', false), 'Already have S02E01 (will be skipped)'.replace('S02E01', 'E01'))
})

test('no profile (or an unreadable one): the generic ranking stands in', () => {
  assert.equal(whySonarr([1], new Map([[1, F('WEBDL-1080p', 1)]]), 'Bluray-1080p', false), 'May replace E01 (WEB-DL → Bluray)')
})

// ── the Supernatural shape, end to end through the lookups ───────────────────

const REV = 'Not a quality revision upgrade for existing episode file(s). Existing: WEBDL-1080p. New: Bluray-1080p'
const ALREADY = 'Episode file already imported at 2026-05-01 10:00:00'
const SUMMARY = 'One or more episodes expected in this release were not imported or missing from the release'

/** A whole-season Bluray release at 100%, import-blocked: 462 "not a quality revision upgrade" and 22 "already imported". */
function cutoffPack() {
  const rows = Array.from({ length: 22 }, (_, i) => ({
    id: 3000 + i, episodeId: 500 + i, seriesId: 3, seasonNumber: 2,
    series: { id: 3, title: 'Example Show', qualityProfileId: 4 }, episode: { id: 500 + i, seasonNumber: 2, episodeNumber: i + 1 },
    title: 'Example.Show.2005.S02.1080p.BluRay.x265', size: 40 * GB, sizeleft: 0, status: 'completed',
    trackedDownloadStatus: 'warning', trackedDownloadState: 'importBlocked', downloadId: 'SN2', protocol: 'torrent',
    quality: { quality: { name: 'Bluray-1080p' } },
    statusMessages: i === 0
      ? [{ title: 'Example.Show.2005.S02.1080p.BluRay.x265', messages: [SUMMARY] }, ...Array.from({ length: 22 }, (_, k) => ({ title: `Example.Show.S02E${String(k + 1).padStart(2, '0')}.mkv`, messages: [...Array.from({ length: 21 }, () => REV), ALREADY] }))]
      : [],
  }))
  const eps = rows.map((r, i) => ({ id: r.episodeId, seasonNumber: 2, episodeNumber: i + 1, hasFile: true, episodeFileId: 900 + i }))
  const get = (calls: string[] = [], profiles: any = [profile(3, true, false)]) => async (p: string) => {
    calls.push(p)
    if (p.startsWith('/api/v3/episode?')) return eps
    if (p.startsWith('/api/v3/episodefile?')) return eps.map(e => ({ id: e.episodeFileId, quality: { quality: { name: e.episodeNumber === 22 ? 'Bluray-1080p' : 'WEBDL-1080p' } } }))
    if (p === '/api/v3/qualityprofile') { if (profiles instanceof Error) throw profiles; return profiles }
    throw new Error('unexpected ' + p)
  }
  return { rows, get }
}

test('Supernatural shape: 462 revision messages + 22 already imported, every episode filed, cutoff reached → done, with its line', async () => {
  const { rows, get } = cutoffPack()
  const info = await readEpisodeInfo(get(), rows, NOW, new FileCache(), new ProfileCache())
  assert.equal(info.size, 22)
  assert.equal(info.get(500)!.profile!.cutoff, 1, 'the series profile was attached from the queue row')
  assert.equal(isDone(rows, info), true)
  const [show] = groupSonarr(rows, NOW, info)
  const d = show.seasons[0].downloads[0]
  assert.equal(d.done, true)
  assert.equal(d.problem, null)
  assert.equal(show.problem, null)
  assert.equal(d.why, 'Imported 1 · kept 21 (already at your quality target); nothing left to import.')
  assert.deepEqual([summarize([show], [], 22).done, summarize([show], [], 22).attention], [1, 0])
})

test('the same pack before it is done reads "already have ... meets your quality target", not "may replace"', async () => {
  const { rows, get } = cutoffPack()
  const info = await readEpisodeInfo(get(), rows, NOW, new FileCache(), new ProfileCache())
  const ids = rows.map(r => r.episodeId)
  assert.equal(whySonarr(ids, info, 'Bluray-1080p', false), 'Already have E22 (will be skipped) · already have E01–E21 (meets your quality target, will be skipped)')
})

test('failed profile lookup: the generic ranking stands in, and the queue still reads', async () => {
  const { rows, get } = cutoffPack()
  const info = await readEpisodeInfo(get([], new Error('HTTP 500')), rows, NOW, new FileCache(), new ProfileCache())
  assert.equal(info.size, 22, 'the episodes were still read')
  assert.equal(info.get(500)!.profile ?? null, null)
  assert.equal(whySonarr(rows.map(r => r.episodeId), info, 'Bluray-1080p', false), 'May replace E01–E21 (WEB-DL → Bluray) · already have E22 (will be skipped)')
  assert.equal(groupSonarr(rows, NOW, info)[0].seasons[0].downloads[0].why, 'Imported 22; nothing left to import.')
})

test('profiles: read once, kept five minutes, read again after; a failure is not cached', async () => {
  const calls: string[] = []
  const pc = new ProfileCache()
  const get = async (p: string) => { calls.push(p); return [profile(3)] }
  assert.equal((await readProfiles(get, 'sonarr', 0, pc)).size, 1)
  await readProfiles(get, 'sonarr', 4 * 60_000, pc)
  assert.deepEqual(calls, ['/api/v3/qualityprofile'])
  await readProfiles(get, 'sonarr', 5 * 60_000 + 1, pc)
  assert.equal(calls.length, 2)
  const bad = new ProfileCache(), badCalls: number[] = []
  const boom = async () => { badCalls.push(1); throw new Error('HTTP 500') }
  assert.equal((await readProfiles(boom, 'radarr', 0, bad)).size, 0)
  await readProfiles(boom, 'radarr', 1000, bad)
  assert.equal(badCalls.length, 2)
})

test('the other "not an upgrade" wordings count as handled: revision, Custom Format, plain', () => {
  const rowsWith = (msg: string) => cutoffPack().rows.map(r => ({ ...r, statusMessages: [{ title: 'x', messages: [ALREADY, msg] }] }))
  const have = (rows: any[]) => new Map<number, FileInfo>(rows.map(r => [r.episodeId, F('WEBDL-1080p', r.episode.episodeNumber)]))
  for (const m of [REV, 'Not a Custom Format upgrade for existing episode file(s). Existing: 10. New: 5', 'Not an upgrade for existing episode file(s). Existing quality: WEBDL-1080p. New Quality HDTV-1080p.', 'not a quality revision upgrade for existing movie file(s)']) {
    const rows = rowsWith(m)
    assert.equal(isDone(rows, have(rows)), true, m)
  }
  const rows = rowsWith('No files found are eligible for import')
  assert.equal(isDone(rows, have(rows)), false)
})

// ── Radarr and Lidarr use the profile too ────────────────────────────────────

test('radarr: the film profile decides upgrade, already have (target) and the done line', async () => {
  const f = (have: string, p: any) => ({ hasFile: true, quality: have, season: null, number: null, profile: compileProfile(p) })
  assert.equal(whyRadarr(f('WEBDL-1080p', profile(7)), 'Bluray-1080p', false), 'Upgrades 1080p WEB-DL → 1080p Bluray.')
  assert.equal(whyRadarr(f('WEBDL-1080p', profile(3)), 'Bluray-1080p', false), 'Already have 1080p WEB-DL (meets your quality target): this will be skipped.')
  assert.equal(whyRadarr(f('WEBDL-1080p', profile(3)), 'Bluray-1080p', true), 'Kept your copy (already at your quality target); nothing left to import.')
  const calls: string[] = []
  const get = async (p: string) => { calls.push(p); return p === '/api/v3/qualityprofile' ? [profile(3)] : [{ id: 77, quality: { quality: { name: 'WEBDL-1080p' } } }] }
  const row = { movieId: 5, movie: { id: 5, title: 'Example Movie', movieFileId: 77, qualityProfileId: 4 }, title: 'Example.Movie.2160p', size: GB, sizeleft: GB, quality: { quality: { name: 'Bluray-1080p' } }, downloadId: 'M', statusMessages: [] }
  const info = await readMovieInfo(get, [row], NOW, new FileCache(), new ProfileCache())
  assert.ok(calls.includes('/api/v3/qualityprofile'))
  assert.equal(groupRadarr([row], NOW, info)[0].why, 'Already have 1080p WEB-DL (meets your quality target): this will be skipped.')
})

const lprofile = (cutoff: number) => ({ id: 3, name: 'Example Music', upgradeAllowed: true, cutoff, items: [q(2, 'MP3-320'), q(6, 'FLAC')] })

test('lidarr: the artist profile (from /api/v1/qualityprofile) decides upgrade vs already at target', async () => {
  const album = (p: any) => ({ title: 'Example Album', total: 10, have: 10, files: [{ quality: 'MP3-320', count: 10 }], profile: compileProfile(p) })
  assert.equal(whyLidarr([album(lprofile(6))], 'FLAC', false), 'Upgrades MP3 320 → FLAC')
  assert.equal(whyLidarr([album(lprofile(2))], 'FLAC', false), 'Already have MP3 320 (meets your quality target, will be skipped)')
  assert.equal(whyLidarr([album(lprofile(2))], 'FLAC', true), 'Kept your copy (already at your quality target); nothing left to import.')
  const calls: string[] = []
  const get = async (p: string) => {
    calls.push(p)
    if (p === '/api/v1/qualityprofile') return [lprofile(2)]
    if (p.startsWith('/api/v1/album?')) return [{ id: 8, title: 'Example Album', statistics: { trackCount: 10, trackFileCount: 10, sizeOnDisk: 1 } }]
    if (p.startsWith('/api/v1/trackfile?')) return Array.from({ length: 10 }, () => ({ albumId: 8, quality: { quality: { name: 'MP3-320' } } }))
    throw new Error('unexpected ' + p)
  }
  const rows = [{ id: 1, albumId: 8, album: { id: 8 }, artist: { id: 2, qualityProfileId: 3 }, quality: { quality: { name: 'FLAC' } } }]
  const info = await readAlbumInfo(get, rows, NOW, new FileCache(), new ProfileCache())
  assert.ok(calls.includes('/api/v1/qualityprofile'), 'Lidarr profiles are on /api/v1')
  assert.ok(!calls.includes('/api/v3/qualityprofile'))
  assert.equal(whyLidarr([info.get(8)!], 'FLAC', false), 'Already have MP3 320 (meets your quality target, will be skipped)')
  const failing = await readAlbumInfo(async (p: string) => { if (p === '/api/v1/qualityprofile') throw new Error('HTTP 500'); return get(p) }, rows, NOW + 1, new FileCache(), new ProfileCache())
  assert.equal(whyLidarr([failing.get(8)!], 'FLAC', false), 'Upgrades MP3 320 → FLAC', 'generic fallback when the profile cannot be read')
})

// ── Sample ───────────────────────────────────────────────────────────────────

const sampleRow = (over: any = {}) => ({
  id: 41, episodeId: 41, seriesId: 6, seasonNumber: 1, series: { id: 6, title: 'Example Show', runtime: 11 }, episode: { id: 41, seasonNumber: 1, episodeNumber: 1, runtime: 11 },
  title: 'Example.Show.S01E01.720p', size: 64e6, sizeleft: 0, status: 'completed', trackedDownloadStatus: 'warning', trackedDownloadState: 'importBlocked',
  downloadId: 'SMP1', protocol: 'torrent', quality: { quality: { name: 'HDTV-720p' } }, statusMessages: [{ title: 'Example.Show.S01E01.720p.mkv', messages: ['Sample'] }], ...over,
})

test('sample: the only message "Sample" is a real problem, never done, explained with the runtime and size', () => {
  const rows = [sampleRow()]
  const info = new Map<number, FileInfo>([[41, { hasFile: true, quality: 'HDTV-720p', season: 1, number: 1 }]])
  for (const i of [undefined, info]) {
    const [show] = groupSonarr(rows, NOW, i)
    const d = show.seasons[0].downloads[0]
    assert.equal(d.problem, 'sample')
    assert.equal(d.done, false)
    assert.equal(d.why, 'Sonarr thinks this is a preview clip, not the episode: episodes of this show run about 11 min, and this download is only 64 MB.')
    assert.equal(summarize([show], [], 1).attention, 1)
    assert.equal(show.problem, 'sample')
  }
  assert.equal(isDone(rows, info), false)
})

test('sample: without a runtime it uses the size; a film says film; any other message keeps it an ordinary blocked import', () => {
  assert.equal(whySample([sampleRow({ episode: { id: 41 }, series: { id: 6 } })], true), "Sonarr thinks this is a preview clip, not the episode: 64 MB, much smaller than this show's other episodes.")
  assert.equal(whySample([{ movie: { runtime: 120 }, size: 80e6 }], false), 'Radarr thinks this is a preview clip, not the film: this film runs about 120 min, and this download is only 80 MB.')
  const mixed = sampleRow({ statusMessages: [{ title: 'x', messages: ['Sample', 'No files found are eligible for import'] }] })
  const d = groupSonarr([mixed], NOW)[0].seasons[0].downloads[0]
  assert.equal(d.problem, 'blocked')
  assert.notEqual(d.why, null === d.why ? 'x' : '', 'no sample explanation for a mixed set')
  assert.ok(!/preview clip/.test(d.why ?? ''))
})
