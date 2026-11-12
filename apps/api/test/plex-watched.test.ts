// Plex watched state for every account: Plex's own watched marks (viewCount, viewedLeafCount, lastViewedAt) count
// as well as the play history, the owner's from the library reading and every shared account's with its own token
// (listed by plex.tv's shared_servers), read in the background at most every ten minutes. The tokens never reach a
// response or a log, a viewer gets counts and no names, and a lock forgets them. Plus keep-name matching edge cases.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { buildPlexClearoutRoutes } from '../src/routes/plex-clearout'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { MemoryApiTokenStore, setApiTokenStore } from '../src/lib/api-tokens'
import { DEFAULT_RULES, buildReport, classify, keptBy, nameMatches, parseRules, type LibItem } from '../src/lib/plex-clearout/logic'
import { PlexWatchers, parseSharedServers, viewOf, type ViewMap } from '../src/lib/plex-clearout/watchers'
import { ClearoutService } from '../src/lib/plex-clearout/service'
import { nextUpFor, plexEpisodes } from '../src/lib/plex-library/logic'
import type { CoreEndpointClient } from '../src/lib/plugin-host'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'

const NOW = Date.UTC(2026, 5, 15)
const DAY = 86_400_000
const s = (ms: number) => Math.floor(ms / 1000)
const FRIEND_TOKEN = 'friend-token-Zq81xK'
const BROKEN_TOKEN = 'broken-token-Pw44rT'
const MACHINE = 'a1b2c3d4e5f60718'

function item(over: Partial<LibItem>): LibItem {
  return {
    kind: 'movie', ratingKey: '1', title: 'Untitled', year: 2015, addedAt: NOW - 400 * DAY, section: '1', sectionTitle: 'Films',
    sizeBytes: 1e9, genres: [], path: '/media/films/Untitled', seriesType: null, arr: null, ...over,
  }
}
const base = { now: NOW, rules: { ...DEFAULT_RULES, recentDays: 0 }, cutoffs: { neverMinMonths: 6, idleMonths: 6 },
  sections: [{ key: '1', title: 'Films', kind: 'movie' as const }], arr: { sonarr: false, radarr: false }, sizesFrom: { tv: 'plex' as const, movies: 'plex' as const } }
const views = (rows: Array<[string, number, any]>): ViewMap => {
  const m: ViewMap = new Map()
  for (const [k, acct, raw] of rows) { const v = viewOf(raw); if (!v) continue; if (!m.has(k)) m.set(k, new Map()); m.get(k)!.set(acct, v) }
  return m
}

// ── watched marks count, not only the history ───────────────────────────────

test('marked watched with no play in the history is not "never watched"; a show with one watched episode is not either', () => {
  const r = buildReport({
    ...base,
    sections: [{ key: '1', title: 'Films', kind: 'movie' }, { key: '2', title: 'TV', kind: 'show' }],
    items: [
      item({ ratingKey: '1', title: 'Paper Moons' }),
      item({ ratingKey: '2', title: 'Glass Orchard' }),
      item({ ratingKey: '3', title: 'Harbour Lights', kind: 'show', section: '2', sectionTitle: 'TV' }),
      item({ ratingKey: '4', title: 'Comet Kite', kind: 'show', section: '2', sectionTitle: 'TV' }),
    ],
    plays: [],
    views: views([
      ['1', 1, { viewCount: 1, lastViewedAt: s(NOW - 20 * DAY) }],
      ['3', 1, { viewedLeafCount: 1, leafCount: 40 }],
    ]),
    names: new Map([[1, 'owner']]),
  })
  assert.deepEqual(r.rows.map(x => [x.title, x.list]).sort(), [['Comet Kite', 'never'], ['Glass Orchard', 'never']])
  assert.equal(r.totals.movies.unwatched, 1)
  assert.equal(r.totals.tv.unwatched, 1)
})

test('a mark long ago makes it idle, and "last played" is the latest of the history and every account', () => {
  const r = buildReport({
    ...base, items: [item({ ratingKey: '1', title: 'Paper Moons' })],
    plays: [{ ratingKey: '1', type: 'movie', title: 'Paper Moons', viewedAt: s(NOW - 500 * DAY), accountID: 1 }],
    views: views([['1', 22, { viewCount: 1, lastViewedAt: s(NOW - 300 * DAY) }]]),
    names: new Map([[1, 'owner'], [22, 'friend']]),
  })
  assert.equal(r.rows[0].list, 'idle')
  assert.equal(r.rows[0].lastPlayed, s(NOW - 300 * DAY) * 1000)
  assert.equal(r.rows[0].watchers, 2)
  assert.equal(r.rows[0].marked, 1, 'the friend has it watched with no play in the history')
  assert.deepEqual(r.rows[0].watchedBy, [{ name: 'owner', how: 'played' }, { name: 'friend', how: 'marked' }])
  assert.equal(classify({ plays: 0, viewers: 0, lastPlayed: null, watchers: 1 }, NOW - 900 * DAY, NOW, base.cutoffs), null, 'watched with no date is on neither list')
})

test('viewOf: nothing watched or started is no view at all', () => {
  assert.equal(viewOf({ ratingKey: '1' }), null)
  assert.equal(viewOf({ viewCount: 0, viewedLeafCount: 0 }), null)
  assert.deepEqual(viewOf({ viewOffset: 1000 }), { viewCount: 0, viewedLeaves: 0, leaves: 0, lastViewedAt: null, inProgress: true })
})

test('next up and watched episodes use the marks too', () => {
  const eps = plexEpisodes({ MediaContainer: { Metadata: [1, 2, 3].map(n => ({ type: 'episode', ratingKey: String(100 + n), parentIndex: 1, index: n, title: `E${n}` })) } })
  const v = views([['101', 22, { viewCount: 1, lastViewedAt: s(NOW - 2 * DAY) }], ['102', 22, { viewCount: 1, lastViewedAt: s(NOW - DAY) }]])
  const next = nextUpFor(eps, [], new Map([[22, 'friend']]), NOW, 14, v)
  assert.deepEqual([...next.entries()], [['103', ['friend']]], 'marked E1 and E2: E3 is next, E2 is not')
  assert.equal(nextUpFor(eps, [], new Map(), NOW, 14).size, 0, 'without the marks nobody is part-way')
})

// ── keep names ───────────────────────────────────────────────────────────────

test('keep names: case and punctuation do not matter; short names and leading articles are exact', () => {
  assert.equal(nameMatches('K*O*B*A', 'K*O*B*A'), true)
  assert.equal(nameMatches('K*O*B*A', 'KOBA'), true)
  assert.equal(nameMatches('k.o.b.a.', 'K*O*B*A'), true)
  assert.equal(nameMatches('Bench & Gavel', 'Bench & Gavel: Night Shift Unit'), true)
  assert.equal(nameMatches('Bench & Gavel', 'Bench and Gavel'), true)
  assert.equal(nameMatches('bench & gavel', 'BENCH & GAVEL: NSU'), true)
  assert.equal(nameMatches('Bench & Gavel', 'Benchless Gavel'), false)
  assert.equal(nameMatches('OR', 'OR'), true)
  assert.equal(nameMatches('OR', 'O.R.'), true)
  assert.equal(nameMatches('OR', 'Oriel Lane'), false)
  assert.equal(nameMatches('OR', 'OR Nurses'), false, 'two letters: the whole title')
  assert.equal(nameMatches('The Spire', 'The Spire'), true)
  assert.equal(nameMatches('the spire', 'THE SPIRE'), true)
  assert.equal(nameMatches('The Spire', 'Spire in the Mist'), false, 'the article is part of the name')
  assert.equal(nameMatches('The Spire', 'The Spired Ones'), false)
  assert.equal(nameMatches('The Hollow Clerk', 'The Hollow Clerk'), true)
  assert.equal(nameMatches('Brackwater Hall', 'Brackwater Hall'), true)
  assert.equal(nameMatches('Morrow', 'Morrow'), true)
  assert.equal(nameMatches('NCXS', 'NCXS: Harbour'), true)
  assert.equal(nameMatches('Night Desk', 'The Night Desk'), true, 'a name without an article still matches a title with one')
})

test('the keep lists as saved (comma lists) really take items off both lists and count them', () => {
  const opts: Record<string, string> = {
    keep_names: 'Morrow, The Hollow Clerk, The Spire, Brackwater Hall, OR, NCXS, Bench & Gavel, K*O*B*A',
    keep_folders: '/media/Curated Films (1080p),/media/Finished Series', keep_added_days: 'none',
  }
  const { rules, cutoffs } = parseRules(k => opts[k])
  assert.deepEqual(rules.folders, ['/media/Curated Films (1080p)', '/media/Finished Series'])
  const show = (ratingKey: string, title: string, path = `/media/TV/${title}`) => item({ kind: 'show', ratingKey, title, path, section: '2', sectionTitle: 'TV' })
  const items = [
    show('1', 'Morrow'), show('2', 'The Hollow Clerk'), show('3', 'The Spire'), show('4', 'Brackwater Hall'), show('5', 'OR'),
    show('6', 'NCXS: Coast'), show('7', 'Bench & Gavel: NSU'), show('8', 'K*O*B*A'),
    show('9', 'Oriel Lane'), show('10', 'Spire in the Mist'),
    show('11', 'Harbour Lights', '/media/Finished Series/Harbour Lights'),
    item({ ratingKey: '12', title: 'Paper Moons', path: '/media/Curated Films (1080p)/Paper Moons (2015)' }),
    item({ ratingKey: '13', title: 'Glass Orchard', path: '/media/Curated Films (1080p) extra/Glass Orchard' }),
  ]
  const r = buildReport({ ...base, rules, cutoffs, sections: [{ key: '1', title: 'Films', kind: 'movie' }, { key: '2', title: 'TV', kind: 'show' }], items, plays: [] })
  assert.deepEqual(r.rows.map(x => x.title).sort(), ['Glass Orchard', 'Oriel Lane', 'Spire in the Mist'])
  const kept = Object.fromEntries(r.kept.map(k => [k.rule, k.tv + k.movies]))
  assert.equal(kept.names, 8)
  assert.equal(kept.folders, 2, 'a kept folder and everything under it, not a folder that only starts the same')
  assert.equal(keptBy(show('3', 'The Spire'), rules, NOW), 'names')
})

test('shared_servers: one account per user, each with its own token; the owner and rows without a token are skipped', () => {
  const xml = `<?xml version="1.0"?><MediaContainer size="3">
    <SharedServer id="9" username="friend &amp; co" userID="22" accessToken="${FRIEND_TOKEN}" owned="1"><Section key="1"/></SharedServer>
    <SharedServer id="10" username="" name="kid" userID="23" accessToken="${BROKEN_TOKEN}"></SharedServer>
    <SharedServer id="13" username="" email="someone@example.com" userID="25" accessToken="other-token-9"></SharedServer>
    <SharedServer id="11" username="nobody" userID="24" accessToken=""></SharedServer>
    <SharedServer id="12" username="self" userID="1" accessToken="x"></SharedServer>
  </MediaContainer>`
  assert.deepEqual(parseSharedServers(xml).map(a => [a.account, a.name]), [[22, 'friend & co'], [23, 'kid'], [25, 'account 25']], 'never the e-mail address')
})

// ── the background reading ──────────────────────────────────────────────────

/** A Plex with an owner, a friend who watched a film and an episode, and a managed user whose token fails. */
/** `ctl.hold`: plex.tv answers only once this resolves (set it again to hold the next reading). */
function fakePlex(o: { plexTv?: 'ok' | 'refused' | 'down'; ctl?: { hold: Promise<void> | null } } = {}) {
  const calls = { textAt: 0, getAs: 0, seen: [] as string[] }
  const films = [
    { ratingKey: '1', title: 'Paper Moons', year: 2015, addedAt: s(NOW - 400 * DAY), Guid: [{ id: 'tmdb://111' }], viewCount: 1, lastViewedAt: s(NOW - 30 * DAY) },
    { ratingKey: '2', title: 'Glass Orchard', year: 2016, addedAt: s(NOW - 400 * DAY), Guid: [{ id: 'tmdb://222' }] },
    { ratingKey: '3', title: 'Old Lantern', year: 2017, addedAt: s(NOW - 400 * DAY), Guid: [{ id: 'tmdb://333' }] },
  ]
  const shows = [{ ratingKey: '50', title: 'Harbour Lights', year: 2018, addedAt: s(NOW - 400 * DAY), leafCount: 3, viewedLeafCount: 0 }]
  const leaves = [1, 2, 3].map(n => ({ type: 'episode', ratingKey: String(500 + n), parentRatingKey: '60', parentIndex: 1, index: n, title: `Episode ${n}` }))
  const plex: CoreEndpointClient = {
    async get(p) {
      if (p === '/identity') return { MediaContainer: { machineIdentifier: MACHINE } }
      if (p === '/status/sessions') return { MediaContainer: { Metadata: [] } }
      if (p === '/:/prefs') return { MediaContainer: { Setting: [{ id: 'allowMediaDeletion', value: true }] } }
      if (p === '/accounts') return { MediaContainer: { Account: [{ id: 1, name: 'owner' }, { id: 22, name: 'friend' }] } }
      if (p.startsWith('/status/sessions/history/all')) return { MediaContainer: { totalSize: 0, Metadata: [] } }
      if (p.startsWith('/library/sections/1/all')) return { MediaContainer: { totalSize: films.length, Metadata: films } }
      if (p.startsWith('/library/sections/2/all')) return { MediaContainer: { totalSize: 1, Metadata: shows } }
      if (p === '/library/sections') return { MediaContainer: { Directory: [{ key: '1', type: 'movie', title: 'Films' }, { key: '2', type: 'show', title: 'TV' }] } }
      if (p === '/library/metadata/50/allLeaves') return { MediaContainer: { Metadata: leaves } }
      throw new Error(`unexpected ${p}`)
    },
    async getAs(p, token) {
      calls.getAs++
      calls.seen.push(p)
      if (token === BROKEN_TOKEN) throw new Error('Plex activity returned HTTP 401')
      assert.equal(token, FRIEND_TOKEN)
      if (p.startsWith('/library/sections/1/all')) return { MediaContainer: { Metadata: [{ ratingKey: '3', viewCount: 2, lastViewedAt: s(NOW - 10 * DAY) }, { ratingKey: '2' }] } }
      if (p.startsWith('/library/sections/2/all')) return { MediaContainer: { Metadata: [{ ratingKey: '50', viewedLeafCount: 2, leafCount: 3, lastViewedAt: s(NOW - DAY) }] } }
      if (p === '/library/metadata/50/allLeaves') return { MediaContainer: { Metadata: [
        { ratingKey: '501', viewCount: 1, lastViewedAt: s(NOW - 2 * DAY) }, { ratingKey: '502', viewCount: 1, lastViewedAt: s(NOW - DAY) }, { ratingKey: '503' },
      ] } }
      throw new Error(`unexpected ${p}`)
    },
    async textAt(origin, p) {
      calls.textAt++
      if (o.ctl?.hold) await o.ctl.hold
      assert.equal(origin, 'https://plex.tv')
      assert.equal(p, `/api/servers/${MACHINE}/shared_servers`)
      if (o.plexTv === 'refused') throw new Error('plex.tv returned HTTP 401')
      if (o.plexTv === 'down') throw new Error('fetch failed')
      return `<MediaContainer><SharedServer userID="22" username="friend" accessToken="${FRIEND_TOKEN}"/><SharedServer userID="23" name="kid" accessToken="${BROKEN_TOKEN}"/></MediaContainer>`
    },
    async delete() { throw new Error('no deletes here') },
    async image() { throw new Error('no art') },
    async put() { throw new Error('no edits') },
    async trigger() {},
  }
  return { plex, calls }
}

const service = (plex: CoreEndpointClient, now = () => NOW) =>
  new ClearoutService({ plex: async () => plex, sonarr: async () => null, radarr: async () => null, option: async k => (k === 'keep_added_days' ? 'none' : undefined), now })

test("a shared account's watched marks count once read; until then nothing is removed from Clear-out", async () => {
  let open!: () => void
  const { plex } = fakePlex({ ctl: { hold: new Promise<void>(r => { open = r }) } })
  const svc = service(plex)
  const first = await svc.report()
  // Before the reading is in: the owner's own mark already counts (from the library reading itself).
  assert.ok(!first.report.rows.some(r => r.title === 'Paper Moons'), "the owner's mark, with no history, is not never watched")
  assert.equal(svc.watchers.pending(), true)
  const blocked = await svc.preview(['movie:2'], 'sid')
  assert.equal(blocked.items.length, 0)
  assert.match(blocked.skipped[0].reason, /Still reading who has watched what/)

  open()
  await svc.watchers.kick(plex).done
  const { report, library } = await svc.report()
  assert.deepEqual(report.rows.map(r => r.title), ['Glass Orchard'], "the friend's film and show are watched now")
  assert.deepEqual(report.watchState, { accounts: 2, shared: 2, reading: false, done: 2, total: 2, at: NOW, ownerOnly: false,
    note: '1 of 2 shared accounts could not be read, so their watched marks are not counted this time.' })
  const lantern = library.find(r => r.title === 'Old Lantern')!
  assert.deepEqual([lantern.watchers, lantern.marked, lantern.watchedBy], [1, 1, [{ name: 'friend', how: 'marked' }]])
  assert.equal(lantern.lastPlayed, s(NOW - 10 * DAY) * 1000)
  assert.equal(svc.watchers.pending(), false)
  assert.equal((await svc.preview(['movie:2'], 'sid')).items.length, 1, 'removal works once the reading is in')
})

test('plex.tv refusing the token: only the owner counts, and the page says how to fix it', async () => {
  const { plex } = fakePlex({ plexTv: 'refused' })
  const svc = service(plex)
  await svc.report()
  await svc.watchers.kick(plex).done
  const { report } = await svc.report()
  assert.deepEqual(report.rows.map(r => r.title).sort(), ['Glass Orchard', 'Harbour Lights', 'Old Lantern'])
  assert.equal(report.watchState.accounts, 1)
  assert.match(report.watchState.note!, /Sign in with Plex/)
  assert.equal(report.watchState.ownerOnly, true)
  assert.equal(svc.watchers.heldTokens, 0)
  const p = await svc.preview(['movie:2'], 'sid')
  assert.equal(p.items.length, 1, 'removal is not blocked for ever')
  assert.match(p.notice!, /Shared users' watched marks couldn't be read; only yours are counted/)
})

test('after a lock and unlock nothing is removed until a new reading has finished, even from a cached list', async () => {
  const ctl: { hold: Promise<void> | null } = { hold: null }
  const { plex } = fakePlex({ ctl })
  let now = NOW
  const svc = service(plex, () => now)
  await svc.report()
  await svc.watchers.kick(plex).done
  const ok = await svc.preview(['movie:2'], 'sid')
  assert.equal(ok.items.length, 1)
  assert.equal(ok.notice, undefined, 'every account was read: no notice')

  let open!: () => void
  ctl.hold = new Promise<void>(r => { open = r })
  svc.dropWatchers()                         // locked
  now += 30_000                              // unlocked; the library reading is still cached
  const blocked = await svc.preview(['movie:2'], 'sid')
  assert.equal(blocked.items.length, 0, 'fails closed straight after the unlock')
  assert.match(blocked.skipped[0].reason, /Still reading who has watched what/)
  open()
  await svc.watchers.kick(plex).done
  assert.equal((await svc.preview(['movie:2'], 'sid')).items.length, 1)
})

test('a lock mid-reading stops every further request with the dropped tokens', async () => {
  const ctl: { hold: Promise<void> | null } = { hold: null }
  const { plex, calls } = fakePlex({ ctl })
  const w = new PlexWatchers(() => NOW)
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  let first = true
  const slow: CoreEndpointClient = { ...plex, async getAs(p, t, ms) { if (first) { first = false; await gate } return plex.getAs!(p, t, ms) } }
  const run = w.kick(slow)
  while (calls.textAt === 0 || first) await new Promise(r => setImmediate(r))
  w.drop()
  const before = calls.getAs
  release()
  await run.done
  assert.equal(calls.getAs - before, 1, 'only the request already in flight; no next page, library or account')
  assert.equal(w.heldTokens, 0)
  assert.equal(w.views().size, 0)
})

test('a client without plex.tv access is owner-only straight away, and never blocks removal', async () => {
  const { plex } = fakePlex()
  const { getAs: _a, textAt: _t, ...bare } = plex
  const svc = service(bare as CoreEndpointClient)
  const { report } = await svc.report()
  assert.equal(svc.watchers.pending(), false)
  assert.equal((await svc.preview(['movie:2'], 'sid')).items.length, 1)
  assert.equal(report.rows.some(r => r.title === 'Paper Moons'), false)
})

test('the reading runs at most once every ten minutes, one at a time; a lock drops the tokens and what they read', async () => {
  const { plex, calls } = fakePlex()
  let now = NOW
  const w = new PlexWatchers(() => now)
  const a = w.kick(plex)
  const b = w.kick(plex)
  assert.equal(a.started, true)
  assert.equal(b.started, false, 'one reading at a time')
  await a.done
  assert.equal(calls.textAt, 1)
  now += 9 * 60_000
  assert.equal(w.kick(plex).started, false, 'inside ten minutes')
  now += 61_000
  const c = w.kick(plex)
  assert.equal(c.started, true, 'after ten minutes')
  await c.done
  assert.equal(calls.textAt, 2)
  assert.equal(w.heldTokens, 1)
  assert.equal((await w.episodes(plex, '50')).get('501')?.get(22)?.viewCount, 1)
  const before = calls.getAs
  await w.episodes(plex, '50')
  assert.equal(calls.getAs, before, "a show's episodes are kept ten minutes")
  w.drop()
  assert.equal(w.heldTokens, 0)
  assert.equal(w.views().size, 0)
  assert.equal((await w.episodes(plex, '50')).size, 0, 'nothing is read with a dropped token')
  assert.equal(w.kick(plex).started, true, 'after a lock the next unlock reads again straight away')
})

// ── tokens never leave the API; names only for operators ────────────────────

const broker = new FakeBroker()
broker.addUser('op@example.com', 'operator master password', 'operator')
broker.addUser('viewer@example.com', 'viewer master password', 'viewer')
const logs: string[] = []
let app: FastifyInstance
let f = fakePlex()
let svc: ClearoutService

before(async () => {
  setBroker(broker)
  setApiTokenStore(new MemoryApiTokenStore())
  setAuditSink({ async write() {} })
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  svc = service(f.plex)
  app = Fastify({ logger: { level: 'trace', stream: new Writable({ write(c, _e, cb) { logs.push(String(c)); cb() } }) } })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(buildPlexClearoutRoutes({ service: () => svc }), { prefix: '/api/plugins/plex' })
  await app.ready()
})
after(async () => { setApiTokenStore(null); setAuditSink(null); if (isUnlocked()) await lock('manual'); await app.close() })

test('per-account tokens are never in a response or a log; a viewer sees counts, an operator names', async () => {
  const op = (await signIn(app, 'op@example.com', 'operator master password')).cookie
  const viewer = (await signIn(app, 'viewer@example.com', 'viewer master password')).cookie
  await app.inject({ method: 'GET', url: '/api/plugins/plex/clearout', headers: { cookie: op } })
  await svc.watchers.kick(f.plex).done
  const bodies: string[] = []
  for (const cookie of [op, viewer]) {
    for (const url of ['/api/plugins/plex/clearout', '/api/plugins/plex/library', '/api/plugins/plex/library/show/50']) {
      const r = await app.inject({ method: 'GET', url, headers: { cookie } })
      assert.equal(r.statusCode, 200, `${url}: ${r.body}`)
      bodies.push(r.body)
    }
  }
  const [opList, opLib, opShow, vList, vLib, vShow] = bodies.map(b => JSON.parse(b).data)
  for (const text of [...bodies, ...logs, JSON.stringify(svc.watchers), JSON.stringify(svc.watchers.status())]) {
    assert.ok(!text.includes(FRIEND_TOKEN) && !text.includes(BROKEN_TOKEN), 'no per-account token anywhere')
  }
  assert.ok(logs.length > 0, 'the logger did run')

  assert.deepEqual(opLib.rows.find((r: any) => r.title === 'Old Lantern').watchedBy, [{ name: 'friend', how: 'marked' }])
  assert.equal(vLib.rows.find((r: any) => r.title === 'Old Lantern').watchedBy, undefined)
  assert.equal(vLib.rows.find((r: any) => r.title === 'Old Lantern').watchers, 1, 'a viewer still gets the count')
  assert.ok(vList.rows.every((r: any) => r.watchedBy === undefined))
  assert.ok(opList.rows.every((r: any) => Array.isArray(r.watchedBy)))
  assert.equal(opList.watchState.accounts, 2)

  const ep = (d: any, k: string) => d.seasons[0].episodes.find((e: any) => e.ratingKey === k)
  assert.equal(ep(opShow, '501').watched, true, 'marked by the friend, no history')
  assert.deepEqual(ep(opShow, '502').watchedBy, [{ name: 'friend', how: 'marked' }])
  assert.equal(ep(vShow, '502').watchedBy, undefined)
  assert.equal(ep(vShow, '502').watchers, 1)
  assert.equal(ep(opShow, '503').watched, false)
  assert.deepEqual(ep(opShow, '503').nextUpFor, ['friend'], 'next up from the marks')
  assert.equal(ep(vShow, '503').nextUpFor, undefined, 'a viewer gets no names for next up')
  assert.equal(ep(vShow, '503').nextUpCount, 1, '…only how many')
  assert.ok(!bodies.slice(3).some(b => b.includes('"friend"')), 'no name anywhere in what a viewer gets')
})

test('locking HyperProx drops the tokens the marks were read with', async () => {
  assert.ok(svc.watchers.heldTokens > 0)
  svc.dropWatchers()
  assert.equal(svc.watchers.heldTokens, 0)
  const { report } = await svc.report()
  assert.equal(report.watchState.accounts, 1)
})
