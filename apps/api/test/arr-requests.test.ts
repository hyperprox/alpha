// The Arr Stack's Requests tab, API side: Seerr's requests shaped into where each one is now (with the folder sorter's
// "sorted into"), who asked shown to admins only, the poster path checked, stale quality profile and root folder
// detection with the fix, retry, approve and decline, the health of Seerr's links, the reconnect fix, and the routes
// through the real gate (viewer reads, admin acts with a confirmation, never an API token, audit before each change).
// Titles, people and addresses are made up; Seerr, Radarr and Sonarr are fakes, nothing real is called.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { requiredRole, needsConfirm, needsPassword } from '../src/lib/roles'
import { injectConfirmed } from './fakes/confirm'
import { buildArrRequestsRoutes } from '../src/routes/arr-requests'
import { RequestsRefusal, RequestsService, isThatApp, type RequestsDeps } from '../src/lib/arr-requests/service'
import { buildRows, classify, countsOf, describeFix, planFix, posterFile, sortedFor, staleId, staleServers, titleOf, wantedFolder, wantedProfile, whyFailed, FAMILY, type TitleInfo } from '../src/lib/arr-requests/logic'
import { imageType } from '../src/lib/plugin-host'
import type { CoreEndpointClient } from '../src/lib/plugin-host'
import { signIn } from './fakes/app'
import { FakeBroker } from './fakes/fake-broker'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken, tokenForbidden } from '../src/lib/api-tokens'
import { MissLimiter } from '../src/lib/plex-art'

const broker = new FakeBroker()
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')
broker.addUser('admin@example.com', 'admin master password', 'admin')
let tokens: MemoryApiTokenStore
before(() => {
  setBroker(broker)
  tokens = new MemoryApiTokenStore(); setApiTokenStore(tokens)
  setAuditSink({ async write() {} })
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
})
after(async () => { setApiTokenStore(null); setAuditSink(null); if (isUnlocked()) await lock('manual') })

const NOW = Date.parse('2026-11-20T12:00:00Z')

// ── What Seerr answers ───────────────────────────────────────────────────────
const user = (name: string) => ({ id: 2, displayName: name, email: `${name.toLowerCase()}@example.com` })
const req = (id: number, o: Record<string, any> = {}) => ({
  id, status: 2, createdAt: `2026-11-${10 + id}T10:00:00.000Z`, requestedBy: user('Robin'), is4k: false,
  media: { mediaType: 'movie', tmdbId: 100 + id, status: 3, downloadStatus: [] }, ...o,
})
const LIST = [
  req(1, { status: 1 }),                                                                                  // waiting
  req(2),                                                                                                 // approved, nothing yet
  req(3, { media: { mediaType: 'movie', tmdbId: 103, status: 3, downloadStatus: [{ size: 1000, sizeLeft: 250 }] } }), // downloading 75%
  req(4, { status: 5, media: { mediaType: 'movie', tmdbId: 104, status: 5 } }),                          // available
  req(5, { status: 4 }),                                                                                  // failed
  req(6, { status: 3 }),                                                                                  // declined
  req(7, { media: { mediaType: 'tv', tmdbId: 207, status: 3, downloadStatus: [] }, seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }] }),
]
const NAMES: Record<string, any> = {
  'movie/101': { title: 'Paper Lanterns', releaseDate: '2011-05-04', posterPath: '/pl1aaa.jpg' },
  'movie/102': { title: 'Quiet Harbour', releaseDate: '2019-01-01', posterPath: '/qh22222.jpg' },
  'movie/103': { title: 'Night Ferry', releaseDate: '2020-03-03', posterPath: '/../../etc/passwd' },
  'movie/104': { title: 'Copper Hills', releaseDate: '2018-09-09', posterPath: '/ch104a.jpg' },
  'movie/105': { title: 'Glass Orchard', releaseDate: '2022-02-02', posterPath: '/go105a.jpg' },
  'movie/106': { title: 'Salt Road', releaseDate: '2015-06-06', posterPath: '/sr106a.jpg' },
  'tv/207': { name: 'Harbour Lights', firstAirDate: '2021-10-01', posterPath: '/hl207a.jpg' },
}

interface Rig { svc: RequestsService; seerr: any; calls: string[]; audits: Array<{ action: string; details: any }>; state: any }
function rig(o: { requests?: any[]; seerrSettings?: Record<string, any[]>; radarr?: { profiles: any[]; roots: any[] }; failTest?: Record<string, string>; sonarrFacts?: { profiles: any[]; roots: any[] }; sonarrSettings?: any[]; urls?: any; failLibrary?: boolean; auditFails?: boolean; keys?: any; media?: any; moves?: any[]; mediaType?: number } = {}): Rig {
  const calls: string[] = []
  const audits: Array<{ action: string; details: any }> = []
  const state: any = {
    requests: structuredClone(o.requests ?? LIST),
    settings: structuredClone(o.seerrSettings ?? { radarr: [{ id: 0, name: 'Radarr', hostname: 'radarr', port: 7878, apiKey: 'old-radarr-key', useSsl: false, baseUrl: '', activeProfileId: 4, activeProfileName: 'HD-1080p', activeDirectory: '/library/films' }], sonarr: [] }),
    retryBecomes: 2,
  }
  const radarrFacts = o.radarr ?? { profiles: [{ id: 4, name: 'HD-1080p' }], roots: [{ path: '/library/films' }] }
  const find = (id: number) => state.requests.find((r: any) => r.id === id)
  const seerr: any = {
    async get(path: string) {
      calls.push(`GET ${path}`)
      let m: RegExpExecArray | null
      if (/^\/api\/v1\/request\?/.test(path)) return { pageInfo: { results: state.requests.length }, results: state.requests }
      if ((m = /^\/api\/v1\/request\/(\d+)$/.exec(path))) { const r = find(Number(m[1])); if (!r) throw new Error('HTTP 404'); return r }
      if ((m = /^\/api\/v1\/(movie|tv)\/(\d+)$/.exec(path))) { const n = NAMES[`${m[1]}/${m[2]}`]; if (!n) throw new Error('HTTP 404'); return n }
      if ((m = /^\/api\/v1\/settings\/(radarr|sonarr)$/.exec(path))) return state.settings[m[1]]
      if (path === '/api/v1/settings/main') return { mediaServerType: o.mediaType ?? 1 }
      // What really contacts the media server: Jellyfin's user list, Plex's server list. A library sync is never a read.
      if (path === '/api/v1/settings/jellyfin/users' || path === '/api/v1/settings/plex/devices/servers') { if (o.failLibrary) throw new Error('Arr Stack returned HTTP 500'); return [] }
      throw new Error(`unexpected GET ${path}`)
    },
    async post(path: string, body: any) {
      calls.push(`POST ${path} ${JSON.stringify(body)}`)
      let m: RegExpExecArray | null
      if ((m = /^\/api\/v1\/request\/(\d+)\/(approve|decline|retry)$/.exec(path))) {
        const r = find(Number(m[1]))
        if (m[2] === 'approve') r.status = 2
        if (m[2] === 'decline') { r.status = 3; r.declineReason = body.reason }
        if (m[2] === 'retry') r.status = state.retryBecomes
        return null
      }
      if ((m = /^\/api\/v1\/settings\/(radarr|sonarr)\/test$/.exec(path))) { if (o.failTest?.[m[1]]) throw new Error(o.failTest[m[1]]); return { profiles: [] } }
      if (/^\/api\/v1\/settings\/(plex|jellyfin)$/.test(path)) return {}
      throw new Error(`unexpected POST ${path}`)
    },
    async put(path: string, body: any) {
      calls.push(`PUT ${path} ${JSON.stringify(body)}`)
      const m = /^\/api\/v1\/settings\/(radarr|sonarr)\/(\d+)$/.exec(path)!
      const i = state.settings[m[1]].findIndex((s: any) => s.id === Number(m[2]))
      state.settings[m[1]][i] = body
      return body
    },
    // The client has already turned Seerr's image/jpg into image/jpeg (imageType).
    async image(path: string) { calls.push(`IMG ${path}`); return { contentType: 'image/jpeg', body: Buffer.from('jpeg') } },
  }
  const arr = (facts: any): CoreEndpointClient => ({
    async get(path: string) { return path === '/api/v3/qualityprofile' ? facts.profiles : path === '/api/v3/rootfolder' ? facts.roots : [] },
  } as any)
  const deps: RequestsDeps = {
    seerr: async () => seerr, radarr: async () => arr(radarrFacts), sonarr: async () => (o.sonarrFacts ? arr(o.sonarrFacts) : null), urls: async () => o.urls ?? {},
    moves: async () => o.moves ?? [], keys: async () => o.keys ?? { radarr: 'current-radarr-key' }, media: async () => o.media ?? null,
    audit: async (action, details) => { if (o.auditFails) throw new Error('audit down'); calls.push(`AUDIT ${action}`); audits.push({ action, details }) },
    now: () => NOW,
  }
  return { svc: new RequestsService(deps), seerr, calls, audits, state }
}

// ── reading ─────────────────────────────────────────────────────────────────

test('where each request is: waiting, approved, downloading with its percentage, available, failed, declined', () => {
  assert.deepEqual(LIST.map(r => classify({ ...r, media: { ...r.media } }).group), ['pending', 'approved', 'downloading', 'available', 'failed', 'declined', 'approved'])
  assert.equal(classify(LIST[2]).progress, 0.75); assert.match(classify(LIST[2]).where, /75% done/)
  assert.match(classify(LIST[1]).where, /Radarr is looking for a copy/); assert.match(classify(LIST[6]).where, /Sonarr is looking/)
  assert.match(classify(LIST[4]).where, /could not send it to Radarr/)
  assert.equal(classify({ status: 2, media: { mediaType: 'tv', status: 4 } }).group, 'available', 'partly in the library counts as in the library')
})

test('rows: poster file names are checked, titles and years read, newest first, counts per group; a bad poster path is dropped', async () => {
  const { svc } = rig()
  const l = await svc.list(true)
  assert.equal(l.configured, true); assert.equal(l.rows.length, 7)
  assert.deepEqual(l.rows.map(r => r.id), [7, 6, 5, 4, 3, 2, 1])
  const r1 = l.rows.find(r => r.id === 1)!
  assert.equal(r1.title, 'Paper Lanterns'); assert.equal(r1.year, 2011); assert.equal(r1.poster, 'pl1aaa.jpg'); assert.equal(r1.kind, 'movie')
  assert.equal(l.rows.find(r => r.id === 3)!.poster, null, 'a path with .. is not a poster')
  assert.equal(l.rows.find(r => r.id === 7)!.seasons, 2); assert.equal(l.rows.find(r => r.id === 7)!.title, 'Harbour Lights')
  assert.deepEqual(l.counts, { pending: 1, approved: 2, downloading: 1, available: 1, failed: 1, declined: 1 })
  assert.equal(posterFile('/abc12.jpg'), 'abc12.jpg'); assert.equal(posterFile('/ab.jpg'), null); assert.equal(posterFile('/a/b.jpg'), null); assert.equal(posterFile('https://x.example/a.jpg'), null); assert.equal(posterFile('abc12.exe'), null)
})

test('who asked: a name for an admin, "a family member" for everyone else, and no email in either', async () => {
  const { svc } = rig()
  const adm = await svc.list(true), view = await svc.list(false)
  assert.ok(adm.rows.every(r => r.who === 'Robin'))
  assert.ok(view.rows.every(r => r.who === FAMILY)); assert.doesNotMatch(JSON.stringify(view), /Robin|robin@example/)
  assert.doesNotMatch(JSON.stringify(adm), /robin@example/)
})

test('"sorted into": the folder the sorter put a finished or arriving title in, matched by title and year; none for waiting or failed', () => {
  const moves = [{ app: 'radarr' as const, title: 'Paper Lanterns', year: 2011, to: '/library/Scary Films/', ok: true }, { app: 'radarr' as const, title: 'Quiet Harbour', year: 2019, to: '/library/Dramas', ok: false }]
  assert.equal(sortedFor('movie', 'paper lanterns (2011)', 2011, moves), 'Scary Films')
  assert.equal(sortedFor('movie', 'Paper Lanterns', 1999, moves), null, 'another year is another film')
  assert.equal(sortedFor('movie', 'Quiet Harbour', 2019, moves), null, 'a move that failed is not "sorted into"')
  assert.equal(sortedFor('tv', 'Paper Lanterns', 2011, moves), null, 'films and shows are kept apart')
  const titles = new Map<string, TitleInfo>([['movie:101', { title: 'Paper Lanterns', year: 2011, poster: null }], ['movie:104', { title: 'Paper Lanterns', year: 2011, poster: null }]])
  const rows = buildRows([LIST[0], LIST[3]], titles, moves, true)
  assert.equal(rows.find(r => r.id === 1)!.sortedInto, null, 'still waiting for approval'); assert.equal(rows.find(r => r.id === 4)!.sortedInto, 'Scary Films')
})

test('a title Seerr cannot name still shows, with a plain placeholder; names are cached between readings', async () => {
  const r = rig({ requests: [req(8, { media: { mediaType: 'movie', tmdbId: 999, status: 3, downloadStatus: [] } }), req(1, { status: 1 })] })
  const l = await r.svc.list(true)
  assert.equal(l.rows.find(x => x.id === 8)!.title, 'A film')
  const first = r.calls.filter(c => c.startsWith('GET /api/v1/movie/101')).length
  ;(r.svc as any).memo = null
  await r.svc.list(true)
  assert.equal(r.calls.filter(c => c.startsWith('GET /api/v1/movie/101')).length, first, 'looked up once')
  assert.deepEqual(titleOf('movie', { title: 'X\u0000Y', releaseDate: '2001-01-01' }), { title: 'X\u0000Y'.replace(/[\u0000-\u001f]/g, ''), year: 2001, poster: null })
  assert.deepEqual(countsOf([]), { pending: 0, approved: 0, downloading: 0, available: 0, failed: 0, declined: 0 })
})

test('Seerr not set up: the list says so and the actions are refused plainly', async () => {
  const svc = new RequestsService({ ...({} as any), seerr: async () => null, radarr: async () => null, sonarr: async () => null, keys: async () => ({}), media: async () => null, audit: async () => {}, now: () => NOW })
  const l = await svc.list(true); assert.equal(l.configured, false); assert.deepEqual(l.rows, [])
  await assert.rejects(svc.act({ action: 'approve', id: 1 }, 'a@example.com'), (e: any) => e instanceof RequestsRefusal && e.code === 'seerr_not_set')
  assert.equal((await svc.health()).configured, false)
})

// ── approve, decline, retry ──────────────────────────────────────────────────

test('approve: only a waiting request, audited before Seerr is asked, read back; the result says it was sent, not that it is downloading', async () => {
  const r = rig(); await r.svc.list(true)
  const done = await r.svc.act({ action: 'approve', id: 1 }, 'admin@example.com')
  assert.equal(done.done, true); assert.equal(done.summary, 'Sent to Seerr. It will show as downloading once Radarr or Sonarr accept it.')
  const ai = r.calls.findIndex(c => c === 'AUDIT arr.requests.approve'), pi = r.calls.findIndex(c => c.startsWith('POST /api/v1/request/1/approve'))
  assert.ok(ai >= 0 && pi > ai, 'audit first')
  assert.deepEqual(r.audits[0].details, { by: 'admin@example.com', request: 1, title: 'Paper Lanterns' })
  await assert.rejects(r.svc.act({ action: 'approve', id: 4 }, 'admin@example.com'), (e: any) => e.code === 'not_in_state' && /already available/.test(e.message))
  const r2 = rig({ requests: [req(1, { status: 1 })] }); await r2.svc.list(true)
  const dec = await r2.svc.act({ action: 'decline', id: 1 }, 'admin@example.com')
  assert.equal(dec.done, true); assert.equal(dec.summary, 'Declined.')
  assert.ok(r2.calls.includes('POST /api/v1/request/1/decline {}'), 'Seerr keeps no decline reason, so none is sent')
  assert.deepEqual(r2.audits[0].details, { by: 'admin@example.com', request: 1, title: 'Paper Lanterns' })
})

test('when the audit log cannot be written nothing is sent to Seerr', async () => {
  const r = rig({ auditFails: true })
  await assert.rejects(r.svc.act({ action: 'approve', id: 1 }, 'admin@example.com'), /audit down/)
  assert.ok(!r.calls.some(c => c.startsWith('POST')))
})

test('retry: only a failed request; Seerr is told to send it again; the answer is "sent", with a note if it still reads failed', async () => {
  const r = rig(); await r.svc.list(true)
  await assert.rejects(r.svc.act({ action: 'retry', id: 1 }, 'a@example.com'), (e: any) => e.code === 'not_in_state')
  r.state.retryBecomes = 2
  const ok = await r.svc.act({ action: 'retry', id: 5 }, 'a@example.com')
  assert.equal(ok.done, true); assert.ok(r.calls.includes('POST /api/v1/request/5/retry {}'))
  const r2 = rig(); r2.state.retryBecomes = 4
  const again = await r2.svc.act({ action: 'retry', id: 5 }, 'a@example.com')
  assert.equal(again.done, true, 'Seerr retries in the background: what was done is that it was sent'); assert.match(again.summary, /^Sent to Seerr/); assert.match(again.notes.join(' '), /still marked failed for now.*Seerr's settings/)
  await assert.rejects(r2.svc.act({ action: 'retry', id: 404 }, 'a@example.com'), (e: any) => e.code === 'not_found')
  await assert.rejects(r2.svc.act({ action: 'approve' }, 'a@example.com'), (e: any) => e.code === 'bad_request')
})

// ── stale settings ───────────────────────────────────────────────────────────

const GONE = { id: 0, name: 'Radarr', hostname: 'radarr', port: 7878, apiKey: 'old-radarr-key', useSsl: false, baseUrl: '', activeProfileId: 9, activeProfileName: 'HD-1080p', activeDirectory: '/old/films' }
const NEWFACTS = { profiles: [{ id: 4, name: 'HD-1080p' }, { id: 5, name: 'Any' }], roots: [{ path: '/library/films' }, { path: '/library/Holiday Films' }] }
const facts = (f: typeof NEWFACTS) => ({ profiles: f.profiles, roots: f.roots.map(x => x.path) })

test('stale detection: only what the arr no longer has; a name match is the proposal, no match is none, never the first one', () => {
  const [s] = staleServers('radarr', [GONE], facts(NEWFACTS))
  assert.equal(s.profile!.now, 'HD-1080p'); assert.deepEqual(s.profile!.want, { id: 4, name: 'HD-1080p' }, 'same name as before')
  assert.equal(s.folder!.want, '/library/films', 'same last folder name')
  const odd = staleServers('radarr', [{ ...GONE, activeProfileName: 'Old HD', activeDirectory: '/old/cinema' }], facts(NEWFACTS))[0]
  assert.equal(odd.profile!.want, null); assert.equal(odd.folder!.want, null, 'nothing is guessed')
  assert.equal(odd.profile!.options.length, 2); assert.equal(odd.folder!.options.length, 2, 'the admin chooses from what the arr has')
  assert.equal(wantedProfile(NEWFACTS.profiles, 'gone'), null); assert.equal(wantedFolder(['/x/a'], '/y/other'), null)
  assert.deepEqual(staleServers('radarr', [{ ...GONE, activeProfileId: 4, activeDirectory: '/library/films/' }], facts(NEWFACTS)), [], 'a trailing slash is the same folder')
  const only = staleServers('radarr', [{ ...GONE, activeProfileId: 4 }], facts(NEWFACTS))[0]
  assert.equal(only.profile, undefined); assert.ok(only.folder)
})

const SONARR_GONE = { id: 1, name: 'Sonarr', hostname: 'sonarr', port: 8989, apiKey: 'old-sonarr-key', useSsl: false, baseUrl: '', activeProfileId: 4, activeProfileName: 'HD-1080p', activeDirectory: '/library/shows', activeAnimeProfileId: 8, activeAnimeProfileName: 'Anime', activeAnimeDirectory: '/old/anime' }
const SONARR_FACTS = { profiles: [{ id: 4, name: 'HD-1080p' }, { id: 6, name: 'Anime' }], roots: [{ path: '/library/shows' }, { path: '/library/anime' }] }

test('Sonarr\'s anime profile and folder are checked and fixed like the main ones; an unset anime profile is not stale', () => {
  const [s] = staleServers('sonarr', [SONARR_GONE], facts(SONARR_FACTS))
  assert.equal(s.profile, undefined); assert.equal(s.folder, undefined)
  assert.deepEqual(s.animeProfile!.want, { id: 6, name: 'Anime' }); assert.equal(s.animeFolder!.want, '/library/anime')
  assert.deepEqual(staleServers('sonarr', [{ ...SONARR_GONE, activeAnimeProfileId: null, activeAnimeDirectory: '' }], facts(SONARR_FACTS)), [])
  assert.deepEqual(staleServers('radarr', [SONARR_GONE], facts(SONARR_FACTS)).map(x => Object.keys(x).includes('animeProfile')), [], 'Radarr has no anime settings')
})

test('the plan: exact old to new lines, one sentence from the same code the action uses; choices fill what has no match and are checked', () => {
  const stale = staleServers('radarr', [{ ...GONE, activeProfileName: 'Old HD' }], facts(NEWFACTS))
  const open = planFix(stale)
  assert.deepEqual(open.unresolved.map(u => u.field), ['profile'], 'the folder matched by name, the profile did not'); assert.equal(open.items[0].lines.length, 1)
  const done = planFix(stale, [{ app: 'radarr', serverId: 0, field: 'profile', value: '5' }])
  assert.deepEqual(done.unresolved, []); assert.deepEqual(done.items[0].lines, [{ field: 'profile', from: 'Old HD', to: 'Any', toId: 5 }, { field: 'folder', from: '/old/films', to: '/library/films' }])
  assert.equal(describeFix(done.items), 'Change Seerr\'s settings? Radarr (Radarr): quality profile "Old HD" → "Any", folder "/old/films" → "/library/films". Only Seerr\'s own settings change; nothing in Radarr or Sonarr is touched.')
  assert.deepEqual(planFix(stale, [{ app: 'radarr', serverId: 0, field: 'profile', value: '77' }]).invalid, ['radarr 0 profile'], 'a profile the arr does not have')
  assert.deepEqual(planFix(stale, [{ app: 'radarr', serverId: 3, field: 'folder', value: '/library/films' }]).invalid, ['radarr 3 folder'])
  assert.equal(staleId(stale), staleId(structuredClone(stale))); assert.notEqual(staleId(stale), staleId([]))
})

test('"Fix Seerr\'s settings": needs the id of what was looked at, audited per server with old and new, the whole entry kept, read back, and the result says what changed', async () => {
  const r = rig({ seerrSettings: { radarr: [GONE], sonarr: [] }, radarr: NEWFACTS })
  const h = await r.svc.health()
  assert.equal(h.stale.length, 1); assert.equal(h.staleId, staleId(h.stale))
  assert.equal(r.svc.describeFix([]), 'Change Seerr\'s settings? Radarr (Radarr): quality profile "HD-1080p" → "HD-1080p", folder "/old/films" → "/library/films". Only Seerr\'s own settings change; nothing in Radarr or Sonarr is touched.')
  const out = await r.svc.act({ action: 'fix-settings', baseId: h.staleId, choices: [] }, 'admin@example.com')
  assert.equal(out.done, true); assert.match(out.summary, /1 server/)
  const put = r.calls.find(c => c.startsWith('PUT /api/v1/settings/radarr/0'))!
  assert.deepEqual(JSON.parse(put.slice(put.indexOf('{'))), { ...GONE, activeProfileId: 4, activeProfileName: 'HD-1080p', activeDirectory: '/library/films' })
  assert.ok(r.calls.findIndex(c => c === 'AUDIT arr.requests.fix-settings') < r.calls.findIndex(c => c.startsWith('PUT')))
  assert.deepEqual(r.audits[0].details, { by: 'admin@example.com', app: 'radarr', server: 0, changes: [{ field: 'profile', from: 'HD-1080p', to: 'HD-1080p' }, { field: 'folder', from: '/old/films', to: '/library/films' }] })
  assert.doesNotMatch(JSON.stringify(r.audits), /old-radarr-key/)
  await assert.rejects(r.svc.act({ action: 'fix-settings', baseId: staleId([]) }, 'a@example.com'), (e: any) => e.code === 'nothing_stale')
})

test('fix: refused when what is stale now is not what was looked at; refused while a choice is still open, with no quiet fallback; a bad choice is refused', async () => {
  const r = rig({ seerrSettings: { radarr: [{ ...GONE, activeProfileName: 'Old HD' }], sonarr: [] }, radarr: NEWFACTS })
  const h = await r.svc.health()
  await assert.rejects(r.svc.act({ action: 'fix-settings', baseId: '0'.repeat(16) }, 'a@example.com'), (e: any) => e.code === 'changed' && /changed since you looked/.test(e.message))
  await assert.rejects(r.svc.act({ action: 'fix-settings', baseId: h.staleId, choices: [] }, 'a@example.com'), (e: any) => e.code === 'needs_choice' && /nothing in Radarr has the same name/.test(e.message))
  await assert.rejects(r.svc.act({ action: 'fix-settings', baseId: h.staleId, choices: [{ app: 'radarr', serverId: 0, field: 'profile', value: '99' }] }, 'a@example.com'), (e: any) => e.code === 'bad_choice')
  assert.ok(!r.calls.some(c => c.startsWith('PUT')) && r.audits.length === 0, 'nothing was written or audited')
  const ok = await r.svc.act({ action: 'fix-settings', baseId: h.staleId, choices: [{ app: 'radarr', serverId: 0, field: 'profile', value: '5' }] }, 'a@example.com')
  assert.equal(ok.done, true); assert.equal(JSON.parse(r.calls.find(c => c.startsWith('PUT'))!.replace(/^PUT \S+ /, '')).activeProfileName, 'Any')
  // Something changed in Radarr between the look and the click: the arr now has another profile, so the old id no longer fits.
  const r2 = rig({ seerrSettings: { radarr: [GONE], sonarr: [] }, radarr: NEWFACTS })
  const seen = (await r2.svc.health()).staleId
  r2.state.settings.radarr[0] = { ...GONE, activeProfileId: 4, activeDirectory: '/library/Holiday Films' }
  await assert.rejects(r2.svc.act({ action: 'fix-settings', baseId: seen }, 'a@example.com'), (e: any) => e.code === 'nothing_stale' || e.code === 'changed')
})

test('fix: Sonarr\'s anime profile and folder are written with the rest; an arr with nothing to choose from lists no options; a change Seerr did not keep is reported', async () => {
  const r = rig({ seerrSettings: { radarr: [], sonarr: [SONARR_GONE] }, sonarrFacts: SONARR_FACTS })
  const h = await r.svc.health()
  const out = await r.svc.act({ action: 'fix-settings', baseId: h.staleId }, 'a@example.com')
  assert.equal(out.done, true)
  const put = JSON.parse(r.calls.find(c => c.startsWith('PUT /api/v1/settings/sonarr/1'))!.replace(/^PUT \S+ /, ''))
  assert.equal(put.activeAnimeProfileId, 6); assert.equal(put.activeAnimeProfileName, 'Anime'); assert.equal(put.activeAnimeDirectory, '/library/anime'); assert.equal(put.activeDirectory, '/library/shows')
  const k = rig({ seerrSettings: { radarr: [GONE], sonarr: [] }, radarr: NEWFACTS })
  const hk = await k.svc.health()
  k.seerr.put = async () => null
  const bad = await k.svc.act({ action: 'fix-settings', baseId: hk.staleId }, 'a@example.com')
  assert.equal(bad.done, false); assert.match(bad.notes.join(' '), /did not keep the change/)
})

// ── health and reconnect ─────────────────────────────────────────────────────

test('health: a link Seerr cannot use is a problem with a plain sentence, no address and no key; all well is no problem; one reading is shared for a minute', async () => {
  const good = await rig().svc.health(); assert.deepEqual(good.problems, [])
  const r = rig({ failTest: { radarr: 'Arr Stack returned HTTP 401' }, failLibrary: true })
  const h = await r.svc.health()
  assert.deepEqual(h.problems.map(p => [p.kind, p.why]), [['radarr', 'key'], ['media', 'down']])
  assert.match(h.problems[0].text, /Seerr cannot sign in to Radarr/); assert.match(h.problems[1].text, /cannot reach Plex/)
  assert.doesNotMatch(JSON.stringify(h), /old-radarr-key|192\.|radarr:7878/)
  assert.ok(r.calls.includes('GET /api/v1/settings/plex/devices/servers'), 'a read that really asks the media server')
  assert.ok(!r.calls.some(c => /library/.test(c)), 'a library sync is never part of a health read')
  const before = r.calls.length
  await r.svc.health(); await r.svc.health()
  assert.equal(r.calls.length, before, 'cached: open pages do not each ask Radarr, Sonarr and the media server')
  const j = rig({ mediaType: 2, failLibrary: true })
  assert.equal((await j.svc.health()).problems[0].kind, 'media'); assert.ok(j.calls.includes('GET /api/v1/settings/jellyfin/users'))
  assert.equal(whyFailed('radarr', new Error('Arr Stack returned HTTP 500')), 'down'); assert.equal(whyFailed('radarr', new Error('weird')), 'other')
})

test('which Seerr entries are the app HyperProx holds the key for: the same port and the plug-in\'s address or the app\'s own name', () => {
  assert.equal(isThatApp({ hostname: 'radarr', port: 7878 }, 'radarr', 'http://192.0.2.5:7878'), true, 'the container-network name Setup uses')
  assert.equal(isThatApp({ hostname: '192.0.2.5', port: 7878 }, 'radarr', 'http://192.0.2.5:7878'), true)
  assert.equal(isThatApp({ hostname: 'radarr4k', port: 7879 }, 'radarr', 'http://192.0.2.5:7878'), false, 'a second Radarr (4K) is another entry')
  assert.equal(isThatApp({ hostname: 'other.example', port: 7878 }, 'radarr', 'http://192.0.2.5:7878'), false)
  assert.equal(isThatApp({ hostname: 'radarr', port: 1 }, 'radarr', undefined), true); assert.equal(isThatApp({ hostname: 'x', port: 1 }, 'radarr', undefined), false)
})

test('reconnect Radarr: the stored key is tested first and Seerr is written only when it passes; a key that fails changes nothing; other entries are left alone; no stored key is refused', async () => {
  const other = { ...GONE, id: 3, hostname: 'radarr4k', port: 7879, apiKey: 'other-key' }
  const r = rig({ seerrSettings: { radarr: [GONE, other], sonarr: [] }, urls: { radarr: 'http://192.0.2.5:7878' } })
  const out = await r.svc.act({ action: 'reconnect', target: 'radarr' }, 'admin@example.com')
  assert.equal(out.done, true)
  const ti = r.calls.findIndex(c => c.startsWith('POST /api/v1/settings/radarr/test')), pi = r.calls.findIndex(c => c.startsWith('PUT /api/v1/settings/radarr/0'))
  assert.ok(ti >= 0 && pi > ti, 'tested, then written')
  assert.equal(JSON.parse(r.calls[pi].replace(/^PUT \S+ /, '')).apiKey, 'current-radarr-key')
  assert.equal(r.calls.filter(c => c.startsWith('PUT')).length, 1, 'the other Radarr entry was not touched'); assert.equal(r.state.settings.radarr[1].apiKey, 'other-key')
  assert.doesNotMatch(JSON.stringify(r.audits), /current-radarr-key|old-radarr-key/)
  const bad = rig({ failTest: { radarr: 'Arr Stack returned HTTP 401' } })
  const still = await bad.svc.act({ action: 'reconnect', target: 'radarr' }, 'a@example.com')
  assert.equal(still.done, false); assert.match(still.notes[0], /sign in to Radarr/); assert.match(still.notes[0], /nothing was changed/)
  assert.ok(!bad.calls.some(c => c.startsWith('PUT')) && bad.audits.length === 0)
  await assert.rejects(rig({ keys: {} }).svc.act({ action: 'reconnect', target: 'radarr' }, 'a@example.com'), (e: any) => e.code === 'no_key')
  await assert.rejects(rig({ seerrSettings: { radarr: [], sonarr: [] } }).svc.act({ action: 'reconnect', target: 'radarr' }, 'a@example.com'), (e: any) => e.code === 'not_in_seerr')
})

test('reconnect the media server: the one Seerr is set up for, with what HyperProx has saved, then read; a different kind is not used', async () => {
  const plex = { kind: 'plex', url: 'http://192.0.2.10:32400', token: 't' }
  const r = rig({ media: plex })
  const out = await r.svc.act({ action: 'reconnect', target: 'media' }, 'a@example.com')
  assert.equal(out.done, true); assert.match(out.summary, /Plex again/)
  assert.ok(r.calls.includes('POST /api/v1/settings/plex {"ip":"192.0.2.10","port":32400,"useSsl":false}'))
  const jelly = { kind: 'jellyfin', url: 'http://192.0.2.20:8096', apiKey: 'jk' }
  const j = rig({ media: jelly, mediaType: 2 })
  assert.equal((await j.svc.act({ action: 'reconnect', target: 'media' }, 'a@example.com')).done, true)
  assert.ok(j.calls.some(c => c.startsWith('POST /api/v1/settings/jellyfin') && c.includes('"apiKey":"jk"')))
  await assert.rejects(rig({ media: jelly, mediaType: 1 }).svc.act({ action: 'reconnect', target: 'media' }, 'a@example.com'), (e: any) => e.code === 'no_media_server')
  await assert.rejects(rig().svc.act({ action: 'reconnect', target: 'media' }, 'a@example.com'), (e: any) => e.code === 'no_media_server')
  const dead = rig({ media: plex, failLibrary: true })
  assert.equal((await dead.svc.act({ action: 'reconnect', target: 'media' }, 'a@example.com')).done, false)
})

// ── roles and the routes through the real gate ───────────────────────────────

test('roles: the tab is a read; every change is admin, confirmed on the page, refused to API tokens, no master password', () => {
  assert.equal(requiredRole('GET', '/api/plugins/arrstack/requests'), 'viewer')
  assert.equal(requiredRole('GET', '/api/plugins/arrstack/requests/health'), 'viewer')
  assert.equal(requiredRole('POST', '/api/plugins/arrstack/requests/actions'), 'admin')
  assert.equal(tokenForbidden('POST', '/api/plugins/arrstack/requests/actions'), true)
  assert.equal(tokenForbidden('POST', '/api/plugins/arrstack/requests/anything'), true)
  assert.equal(tokenForbidden('GET', '/api/plugins/arrstack/requests'), false)
  assert.equal(needsPassword('POST', '/api/plugins/arrstack/requests/actions'), false)
  assert.equal(needsConfirm('POST', '/api/plugins/arrstack/requests/actions'), true)
  assert.equal(needsConfirm('GET', '/api/plugins/arrstack/requests'), false)
})

test('routes: a viewer reads without names; an admin sees them; actions need an admin, the server\'s confirmation (with the title) and never a token', async () => {
  const { svc, calls } = rig({ seerrSettings: { radarr: [GONE], sonarr: [] }, radarr: NEWFACTS })
  const a = Fastify({ logger: false })
  await registerGate(a)
  await a.register(authRoutes, { prefix: '/api/auth' })
  await a.register(buildArrRequestsRoutes({ service: () => svc, limiter: new MissLimiter(50), artLimiter: new MissLimiter(50) }), { prefix: '/api/plugins/arrstack' })
  await a.ready()
  const url = '/api/plugins/arrstack/requests/actions'
  try {
    const viewer = await signIn(a, 'viewer@example.com', 'viewer master password')
    const v = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/requests', headers: { cookie: viewer.cookie } })
    assert.equal(v.statusCode, 200, v.body); assert.doesNotMatch(v.body, /Robin/); assert.match(v.body, /a family member/)
    const vh = JSON.parse((await a.inject({ method: 'GET', url: '/api/plugins/arrstack/requests/health', headers: { cookie: viewer.cookie } })).body).data
    assert.deepEqual(vh.stale, [], 'what Seerr is set to is for admins')
    assert.equal((await a.inject({ method: 'POST', url, headers: { cookie: viewer.cookie }, payload: { action: 'approve', id: 1 } })).statusCode, 403)
    const tok = (await createApiToken({ name: 'bot', role: 'admin' }, 'test', tokens)).token
    const tp = await a.inject({ method: 'POST', url, headers: { authorization: `Bearer ${tok}` }, payload: { action: 'approve', id: 1 } })
    assert.equal(tp.statusCode, 403); assert.equal(JSON.parse(tp.body).code, 'token_forbidden')
    const tl = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/requests', headers: { authorization: `Bearer ${tok}` } })
    assert.doesNotMatch(tl.body, /Robin/, 'a token with an admin role still sees no names')

    const adm = await signIn(a, 'admin@example.com', 'admin master password')
    const list = await a.inject({ method: 'GET', url: '/api/plugins/arrstack/requests', headers: { cookie: adm.cookie } })
    assert.match(list.body, /Robin/)
    const post = (payload: any) => a.inject({ method: 'POST', url, headers: { cookie: adm.cookie }, payload })
    const ask = await post({ action: 'approve', id: 1 })
    assert.equal(JSON.parse(ask.body).code, 'confirm_required')
    assert.equal(JSON.parse(ask.body).confirm.summary, 'Approve "Paper Lanterns"? Seerr sends it to Radarr or Sonarr to download.')
    const flag = await post({ action: 'approve', id: 1, confirmed: true })
    assert.equal(JSON.parse(flag.body).code, 'confirm_required', 'the page\'s own flag is not a confirmation')
    assert.equal(JSON.parse((await post({ action: 'decline', id: 1 })).body).confirm.summary, 'Decline "Paper Lanterns"? It will not be downloaded.')
    assert.match(JSON.parse((await post({ action: 'retry', id: 5 })).body).confirm.summary, /Send "Copper Hills"|Send "Glass Orchard"|Send "[^"]+" to Radarr or Sonarr again\?/)
    // The page's health read comes first; the confirmation then names exactly what changes, from the same plan the action uses.
    const hr = JSON.parse((await a.inject({ method: 'GET', url: '/api/plugins/arrstack/requests/health', headers: { cookie: adm.cookie } })).body).data
    assert.match(hr.staleId, /^[0-9a-f]{16}$/); assert.equal(hr.stale.length, 1)
    const fixAsk = JSON.parse((await post({ action: 'fix-settings', baseId: hr.staleId, choices: [] })).body)
    assert.equal(fixAsk.confirm.summary, 'Change Seerr\'s settings? Radarr (Radarr): quality profile "HD-1080p" → "HD-1080p", folder "/old/films" → "/library/films". Only Seerr\'s own settings change; nothing in Radarr or Sonarr is touched.')
    assert.match(JSON.parse((await post({ action: 'reconnect', target: 'radarr' })).body).confirm.summary, /Radarr key HyperProx has saved/)
    // A bad body is refused by the route itself once confirmed (the gate asks for the confirmation first).
    for (const bad of [{}, { action: 'nuke' }, { action: 'approve' }, { action: 'approve', id: '1' }, { action: 'approve', id: -2 }, { action: 'reconnect', target: 'qbit' }, { action: 'decline', id: 1, reason: 'x' }, { action: 'fix-settings' }, { action: 'fix-settings', baseId: 'nope' }, { action: 'fix-settings', baseId: '0123456789abcdef', choices: [{ app: 'qbit' }] }, { action: 'approve', id: 1, baseId: '0123456789abcdef' }]) {
      assert.equal((await injectConfirmed(a, { method: 'POST', url, headers: { cookie: adm.cookie }, payload: bad })).statusCode, 400, JSON.stringify(bad))
    }
    const before = calls.filter(c => c.startsWith('POST /api/v1/request')).length
    const done = await injectConfirmed(a, { method: 'POST', url, headers: { cookie: adm.cookie }, payload: { action: 'approve', id: 1 } })
    assert.equal(done.statusCode, 200, done.body); assert.equal(JSON.parse(done.body).data.done, true)
    assert.equal(calls.filter(c => c.startsWith('POST /api/v1/request')).length, before + 1)
    const gone = await injectConfirmed(a, { method: 'POST', url, headers: { cookie: adm.cookie }, payload: { action: 'approve', id: 4 } })
    assert.equal(gone.statusCode, 409); assert.equal(JSON.parse(gone.body).code, 'not_in_state')
  } finally { await a.close() }
})

test('the poster route: only a checked file name, fetched through Seerr\'s image proxy at a fixed path, cached', async () => {
  const { svc, calls } = rig()
  const a = Fastify({ logger: false })
  await registerGate(a)
  await a.register(authRoutes, { prefix: '/api/auth' })
  await a.register(buildArrRequestsRoutes({ service: () => svc }), { prefix: '/api/plugins/arrstack' })
  await a.ready()
  try {
    const viewer = await signIn(a, 'viewer@example.com', 'viewer master password')
    const get = (f: string) => a.inject({ method: 'GET', url: `/api/plugins/arrstack/requests/poster/${f}`, headers: { cookie: viewer.cookie } })
    const ok = await get('pl1aaa.jpg')
    assert.equal(ok.statusCode, 200); assert.equal(ok.headers['content-type'], 'image/jpeg'); assert.equal(ok.headers['x-content-type-options'], 'nosniff')
    await get('pl1aaa.jpg')
    assert.deepEqual(calls.filter(c => c.startsWith('IMG')), ['IMG /imageproxy/tmdb/t/p/w185/pl1aaa.jpg'])
    for (const bad of ['..%2F..%2Fetc%2Fpasswd', 'a.exe', 'x.jpg%3Fw%3D1', 'a%2Fb.jpg']) assert.equal((await get(bad)).statusCode, 400, bad)
  } finally { await a.close() }
})

test('Seerr\'s image proxy answers image/jpg: it is accepted and served as a JPEG; anything that is not an image is still refused', () => {
  assert.equal(imageType('image/jpg'), 'image/jpeg'); assert.equal(imageType('image/jpg; charset=binary'), 'image/jpeg'); assert.equal(imageType('IMAGE/JPEG'), 'image/jpeg')
  assert.equal(imageType('image/png'), 'image/png'); assert.equal(imageType('image/webp'), 'image/webp')
  for (const bad of ['text/html', 'image/svg+xml', 'application/octet-stream', '', undefined]) assert.equal(imageType(bad), null, String(bad))
})
