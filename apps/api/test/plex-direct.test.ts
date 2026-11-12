// Plex read directly (no Tautulli): session parsing (local or remote, direct play, direct stream, transcode),
// history aggregation, the "something new was added" de-duplication, and an install that only ever had Tautulli
// keeping every reading while it is asked for the Plex server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountNames, historyStats, isLocal, librarySections, plexSessions, sectionCount, streamMode, withTautulliQuality } from '../src/lib/plex-direct'
import { emptyNewState, newMessage, newPass, pickNew, recentItems, type NewState } from '../src/lib/plex-new'
import { plexPlugin, liveFromPlex } from '../src/plugins/plex'
import { endpointReady, missingSettings, type PluginContext } from '../src/lib/plugin-host'
import { visualLines } from '../src/lib/ai/visual-lines'

const SESSIONS = { MediaContainer: { size: 3, Metadata: [
  { type: 'episode', title: 'The Pilot', grandparentTitle: 'Harbour Lights', parentIndex: 2, index: 5, sessionKey: '11',
    thumb: '/library/metadata/501/thumb/9', grandparentThumb: '/library/metadata/77/thumb/8', viewOffset: 600_000, duration: 2_400_000,
    User: { title: 'alex' }, Player: { title: 'Living room TV', state: 'playing', local: true }, Session: { bandwidth: 8000, location: 'lan' },
    Media: [{ videoResolution: '1080' }] },
  { type: 'movie', title: 'Paper Moons', year: 2015, sessionKey: '12', viewOffset: 10, duration: 0,
    User: { title: 'sam' }, Player: { product: 'Plex for Phones', state: 'paused', local: false }, Session: { bandwidth: 3500, location: 'wan' },
    TranscodeSession: { videoDecision: 'transcode', audioDecision: 'copy' }, Media: [{ videoResolution: '4k' }] },
  { type: 'movie', title: 'Glass Orchard', sessionKey: '13', User: { title: 'kai' }, Player: { title: 'Laptop', local: '1' },
    Session: { bandwidth: 2000 }, TranscodeSession: { videoDecision: 'copy', audioDecision: 'copy' } },
] } }

test('sessions: direct play, direct stream and transcode; local and remote bandwidth; progress; posters', () => {
  const m = SESSIONS.MediaContainer.Metadata
  assert.deepEqual(m.map(streamMode), ['direct play', 'transcode', 'copy'])
  assert.deepEqual(m.map(isLocal), [true, false, true], 'Session.location first, then Player.local')
  const v = plexSessions(SESSIONS)
  assert.deepEqual(v.counts, { streams: 3, transcodes: 1, direct: 1 })
  assert.deepEqual(v.bandwidth, { totalMbps: 13.5, lanMbps: 10, wanMbps: 3.5 })
  const [ep, film, third] = v.sessions
  assert.equal(ep.title, 'Harbour Lights'); assert.equal(ep.episode, 'The Pilot'); assert.equal(ep.number, 'S2 · E5')
  assert.equal(ep.progress, 25); assert.equal(ep.quality, '1080p'); assert.equal(ep.user, 'alex'); assert.equal(ep.player, 'Living room TV')
  assert.equal(ep.art, '/api/plugins/plex/art/77/thumb/8', "an episode shows its show's poster")
  assert.equal(film.player, 'Plex for Phones'); assert.equal(film.state, 'paused'); assert.equal(film.quality, '4K'); assert.equal(film.progress, 0)
  assert.equal(third.mode, 'copy')
  assert.deepEqual(plexSessions(null), { sessions: [], counts: { streams: 0, transcodes: 0, direct: 0 }, bandwidth: { totalMbps: 0, lanMbps: 0, wanMbps: 0 } })
})

test('Tautulli adds only its quality wording, matched by session key', () => {
  const v = plexSessions(SESSIONS)
  const out = withTautulliQuality(v.sessions, { response: { data: { sessions: [{ session_key: '12', quality_profile: '4 Mbps 720p' }, { session_key: '99', quality_profile: 'Original' }] } } })
  assert.deepEqual(out.map(s => s.quality), ['1080p', '4 Mbps 720p', '—'])
})

test('history: plays per person by account name, per show (episodes) or film, newest first', () => {
  const names = accountNames({ MediaContainer: { Account: [{ id: 1, name: 'alex' }, { id: 7, name: 'sam' }, { id: 'x', name: 'bad' }] } })
  assert.deepEqual([...names.entries()], [[1, 'alex'], [7, 'sam']])
  const rows = [
    { type: 'episode', title: 'One', grandparentTitle: 'Harbour Lights', accountID: 1, viewedAt: 100 },
    { type: 'episode', title: 'Two', grandparentTitle: 'Harbour Lights', accountID: 1, viewedAt: 300 },
    { type: 'movie', title: 'Paper Moons', accountID: 7, viewedAt: 200 },
    { type: 'movie', title: 'Paper Moons', accountID: 9, viewedAt: 50 },
  ]
  const h = historyStats(rows, names)
  assert.deepEqual(h.topWatchers, [{ user: 'alex', plays: 2, minutes: 0 }, { user: 'account 9', plays: 1, minutes: 0 }, { user: 'sam', plays: 1, minutes: 0 }])
  assert.deepEqual(h.topTitles.map(t => [t.title, t.plays]), [['Harbour Lights', 2], ['Paper Moons', 2]])
  assert.deepEqual(h.recent.map(r => r.title), ['Harbour Lights - Two', 'Paper Moons', 'Harbour Lights - One', 'Paper Moons'])
  assert.equal(h.recent[0].at, 300_000)
  assert.deepEqual(librarySections({ MediaContainer: { Directory: [{ key: '1', title: 'Films', type: 'movie' }, { key: 'x', title: 'Bad' }] } }), [{ key: '1', title: 'Films', kind: 'movie' }])
  assert.equal(sectionCount({ MediaContainer: { totalSize: 1426, size: 0 } }), 1426)
})

// ── "Tell me when something new is added" ────────────────────────────────────

const RECENT = (rows: any[]) => ({ MediaContainer: { Metadata: rows } })
const film = (k: number, at: number, title = `Film ${k}`) => ({ type: 'movie', ratingKey: String(k), title, year: 2020, addedAt: at })

test('new items: the first read is quiet, then one batch per new set, never the same item twice', () => {
  const first = pickNew(recentItems(RECENT([film(1, 1000), film(2, 900)])), emptyNewState())
  assert.equal(first.batch.length, 0, 'switching it on never floods a channel')
  assert.equal(first.next.watermark, 1000)

  const second = pickNew(recentItems(RECENT([film(3, 1200), film(1, 1000), { type: 'season', ratingKey: '40', parentTitle: 'Harbour Lights', title: 'Season 2', leafCount: 8, addedAt: 1100 }])), first.next)
  assert.deepEqual(second.batch.map(i => i.line), ['Harbour Lights: Season 2 (8 episodes)', 'Film 3 (2020)'])
  const msg = newMessage(second.batch)!
  assert.equal(msg.title, 'New in Plex: 2 items')
  assert.equal(msg.type, 'plex.added')
  assert.equal(msg.severity, 'info')
  assert.equal(msg.link, '/plugins/plex')

  const third = pickNew(recentItems(RECENT([film(3, 1200), film(1, 1000)])), second.next)
  assert.equal(third.batch.length, 0, 'nothing new: nothing sent')
  // Plex re-dated an item already announced (a rescan): still not sent again.
  const redated = pickNew(recentItems(RECENT([film(3, 5000)])), third.next)
  assert.equal(redated.batch.length, 0)
  assert.equal(newMessage([]), null)
  assert.equal(newMessage([{ key: 'movie:1', line: 'Paper Moons (2015)', addedAt: 1 }])!.title, 'New in Plex: Paper Moons (2015)')
  assert.deepEqual(recentItems(RECENT([{ type: 'movie', ratingKey: '../x', title: 'Bad' }, { type: 'track', ratingKey: '5', title: 'Song' }])), [])
})

test('the watcher sends one message per pass, waits while locked, and forgets its place when switched off', async () => {
  let state: NewState = emptyNewState()
  const store = { load: () => state, save: (s: NewState) => { state = s } }
  const sent: any[] = []
  let mode: 'on' | 'off' | 'wait' = 'on'
  let rows = [film(1, 1000)]
  const d = { enabled: async () => mode, recentlyAdded: async () => RECENT(rows), publish: async (e: any) => { sent.push(e) }, store }
  assert.equal(await newPass(d), 0)
  rows = [film(2, 1100), film(3, 1150), film(1, 1000)]
  mode = 'wait'
  assert.equal(await newPass(d), 0, 'locked: nothing read')
  assert.equal(state.watermark, 1000, 'and its place kept')
  mode = 'on'
  assert.equal(await newPass(d), 2)
  assert.equal(sent.length, 1, 'one message for the batch')
  assert.equal(await newPass(d), 0)
  mode = 'off'
  await newPass(d)
  assert.equal(state.watermark, null, 'off: the next switch-on starts quiet again')
})

// ── an install that only has Tautulli ───────────────────────────────────────

function ctxWith(opts: { plex?: (p: string) => any; tautulli?: (p: string) => any }): PluginContext {
  const make = (fn?: (p: string) => any): PluginContext => ({
    async get(p) { if (!fn) throw new Error('no address configured'); return fn(p) },
    async post() { throw new Error('no posts') },
    option: () => undefined,
    from: (k: string) => make(k === 'tautulli' ? opts.tautulli : opts.plex),
    has: (k: string) => !!(k === 'tautulli' ? opts.tautulli : opts.plex),
  })
  return make(opts.plex)
}
const TAUTULLI = (p: string) => {
  if (p.includes('get_activity')) return { response: { result: 'success', data: { stream_count: 1, sessions: [{ media_type: 'movie', title: 'Paper Moons', friendly_name: 'alex', transcode_decision: 'direct play', state: 'playing' }] } } }
  if (p.includes('get_history')) return { response: { result: 'success', data: { recordsFiltered: 4, data: [] } } }
  return { response: { result: 'success', data: [{ stat_id: 'top_users', rows: [{ friendly_name: 'alex', total_duration: 7200, total_plays: 3 }] }] } }
}

test('migration: a Tautulli-only install is still set up, keeps its readings, and is asked for the Plex server', async () => {
  const m = plexPlugin.manifest
  assert.deepEqual(missingSettings(m, { url: 'http://192.0.2.5:8181', apikey: 'k' }), [], 'the old settings still count as set up')
  assert.deepEqual(missingSettings(m, { plex_url: 'http://192.0.2.6:32400', plex_token: 't' }), [])
  assert.deepEqual(missingSettings(m, {}), ['Plex server address', 'Plex token'], 'a new install is asked for Plex, not Tautulli')
  assert.equal(m.baseUrlSetting, 'plex_url')
  assert.equal(m.endpoints?.find(e => e.key === 'tautulli')?.baseUrlSetting, 'url', 'the stored Tautulli settings keep their keys')

  const ctx = ctxWith({ tautulli: TAUTULLI })
  const tile = await plexPlugin.load(ctx)
  assert.equal(tile.headline, 'Needs attention: add your Plex server for live data')
  assert.equal(tile.tone, 'warn')
  assert.ok(tile.rows?.some(r => r.value.includes('Paper Moons')), 'what Tautulli showed is still shown')
  const d = await plexPlugin.detail!(ctx)
  assert.equal(d.visual?.kind, 'plex')
  if (d.visual?.kind !== 'plex') return
  assert.equal(d.visual.needsPlex, true)
  assert.equal(d.visual.sessions[0].title, 'Paper Moons')
  assert.equal(d.visual.topWatchers[0].minutes, 120)
  assert.ok(visualLines(d.visual).some(l => /add the Plex server/i.test(l)))
})

test('with Plex set, the plug-in reads Plex; Tautulli only adds hours watched', async () => {
  const plex = (p: string) => {
    if (p === '/status/sessions') return SESSIONS
    if (p.startsWith('/status/sessions/history/all')) return { MediaContainer: { Metadata: [{ type: 'movie', title: 'Paper Moons', accountID: 1, viewedAt: 100 }] } }
    if (p === '/accounts') return { MediaContainer: { Account: [{ id: 1, name: 'alex' }] } }
    if (p === '/library/sections') return { MediaContainer: { Directory: [{ key: '1', title: 'Films', type: 'movie' }] } }
    if (p.startsWith('/library/sections/1/all')) return { MediaContainer: { totalSize: 42 } }
    throw new Error(`unexpected ${p}`)
  }
  const alone = await plexPlugin.detail!(ctxWith({ plex }))
  assert.equal(alone.visual?.kind, 'plex')
  if (alone.visual?.kind !== 'plex') return
  assert.equal(alone.visual.source, 'plex')
  assert.equal(alone.visual.topBy, 'plays')
  assert.deepEqual(alone.visual.topWatchers, [{ user: 'alex', plays: 1, minutes: 0 }])
  assert.deepEqual(alone.visual.libraries, [{ title: 'Films', kind: 'movie', count: 42 }])
  assert.equal(alone.visual.needsPlex, undefined)
  const tile = await plexPlugin.load(ctxWith({ plex }))
  assert.equal(tile.headline, '3 watching · 1 transcoding')

  const both = await plexPlugin.detail!(ctxWith({ plex, tautulli: TAUTULLI }))
  if (both.visual?.kind !== 'plex') return assert.fail('no visual')
  assert.equal(both.visual.source, 'both')
  assert.equal(both.visual.topBy, 'minutes')
  assert.equal(both.visual.topWatchers[0].minutes, 120)
  assert.equal(both.visual.counts.streams, 3, 'now streaming still comes from Plex')
  const live = await liveFromPlex({ get: async p => plex(p) })
  assert.equal(live.counts.streams, 3)
})

test('a half-entered Plex (address, no token) is not "set": the Tautulli-only path keeps working', () => {
  const m = plexPlugin.manifest
  assert.equal(endpointReady(m, { plex_url: 'http://plex.local:32400' }), false)
  assert.equal(endpointReady(m, { plex_url: 'http://plex.local:32400', plex_token: 't' }), true)
  assert.equal(endpointReady(m, { url: 'http://tautulli.local:8181', apikey: 'k' }, 'tautulli'), true)
  assert.equal(endpointReady(m, { url: 'http://tautulli.local:8181' }, 'tautulli'), false)
  assert.equal(endpointReady(m, {}, 'nope'), false)
})
