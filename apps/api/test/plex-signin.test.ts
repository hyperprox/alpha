// Sign in with Plex: PIN creation and polling against a pretend plex.tv (expiry included), the resources parse and
// the preference for a local connection, the server token saved while the account token is dropped (never in the
// vault, the audit log, the log or any answer), the admin and re-confirm guards (API tokens out), and the /identity
// check failing, the fallback never sending a token over plain http to a remote address, and every flow dropped
// at its expiry, on a lock, and after a save even when the audit row cannot be written.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { buildPlexSigninRoutes, plexClientId, savePlexEndpoint, CLIENT_ID_KEY } from '../src/routes/plex-signin'
import { PlexSignin, parseResources, orderConnections, authUrl, POLL_MS, type PlexHttp } from '../src/lib/plex-signin'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { getSettings } from '../src/lib/plugin-host'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken } from '../src/lib/api-tokens'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'

const ACCOUNT = 'ACCOUNT-TOKEN-must-never-be-kept'
const SERVER = 'SERVER-TOKEN-for-the-den'
const MACHINE = 'machine-den-1'

// ── a pretend plex.tv and Plex server ────────────────────────────────────────

const DEN = {
  name: 'Den', product: 'Plex Media Server', productVersion: '1.41.0.1', provides: 'server', owned: true,
  clientIdentifier: MACHINE, accessToken: SERVER,
  connections: [
    { protocol: 'https', address: 'den.example.net', port: 32400, uri: 'https://den-remote.abc.plex.direct:32400', local: false, relay: false },
    { protocol: 'http', address: 'den.lan', port: 32400, uri: 'http://den.lan:32400', local: true, relay: false },
    { protocol: 'https', address: 'den.lan', port: 32400, uri: 'https://den-lan.abc.plex.direct:32400', local: true, relay: false },
    { protocol: 'https', address: 'relay.example.net', port: 443, uri: 'https://relay.example.net:443', local: false, relay: true },
  ],
}
const SHARED = { ...DEN, name: 'A friend', owned: false, clientIdentifier: 'friend', accessToken: 'FRIEND-TOKEN' }
const PHONE = { name: 'Phone', provides: 'client,player', owned: true, clientIdentifier: 'phone', accessToken: 'PHONE', connections: [] }

function plexTv() {
  const st = {
    authorised: false, pinGone: false, resources: [DEN, SHARED, PHONE] as any[],
    identity: new Map<string, { status: number; machine?: string } | 'down'>(),
    calls: [] as Array<{ method: string; url: string; headers: Record<string, string> }>,
    pins: 0,
  }
  const res = (status: number, body: unknown) => ({ status, ok: status < 400, json: async () => body })
  const http: PlexHttp = async (method, url, headers) => {
    st.calls.push({ method, url, headers })
    const u = new URL(url)
    if (u.host === 'plex.tv') {
      assert.equal(headers['X-Plex-Product'], 'HyperProx')
      assert.ok(headers['X-Plex-Client-Identifier'], 'every plex.tv call names the client')
      if (method === 'POST' && u.pathname === '/api/v2/pins') {
        st.pins++
        const strong = u.searchParams.get('strong') === 'true'
        return res(201, { id: strong ? 202 : 101, code: strong ? 'strongcode123' : 'K7QX', expiresIn: strong ? 1800 : 900 })
      }
      if (method === 'GET' && /^\/api\/v2\/pins\/\d+$/.test(u.pathname)) {
        if (st.pinGone) return res(404, {})
        return res(200, { id: 101, code: 'K7QX', authToken: st.authorised && u.pathname.endsWith('/101') ? ACCOUNT : null })
      }
      assert.equal(headers['X-Plex-Token'], ACCOUNT, 'the account token is used only at plex.tv')
      if (u.pathname === '/api/v2/user') return res(200, { username: 'plexfan', email: 'someone@example.com' })
      if (u.pathname === '/api/v2/resources') {
        assert.equal(u.searchParams.get('includeHttps'), '1')
        assert.equal(u.searchParams.get('includeRelay'), '0')
        return res(200, st.resources)
      }
      return res(404, {})
    }
    // A Plex server's /identity.
    assert.notEqual(headers['X-Plex-Token'], ACCOUNT, 'the account token never goes to a server')
    const base = `${u.protocol}//${u.host}`
    const how = st.identity.get(base) ?? { status: 200, machine: MACHINE }
    if (how === 'down') throw new Error('fetch failed')
    if (headers['X-Plex-Token'] !== SERVER) return res(401, {})
    return res(how.status, { MediaContainer: { machineIdentifier: how.machine } })
  }
  return { st, http }
}

// ── pure parts ───────────────────────────────────────────────────────────────

test('resources: only servers the account owns, relays dropped, local https first, then local http, then remote', () => {
  const out = parseResources([DEN, SHARED, PHONE])
  assert.equal(out.length, 1)
  assert.equal(out[0].name, 'Den')
  assert.equal(out[0].version, '1.41.0.1')
  assert.deepEqual(out[0].connections.map(c => c.uri), [
    'https://den-lan.abc.plex.direct:32400', 'http://den.lan:32400', 'https://den-remote.abc.plex.direct:32400',
  ])
  assert.equal(out[0].preferred, 'https://den-lan.abc.plex.direct:32400')
  assert.equal(out[0].matchesKnown, false)
})

test('resources: the address discovery already found is preselected', () => {
  const [s] = parseResources([DEN], 'http://den.lan:32400')
  assert.equal(s.preferred, 'http://den.lan:32400')
  assert.equal(s.matchesKnown, true)
  // A different port is a different service.
  assert.equal(parseResources([DEN], 'http://den.lan:8080')[0].matchesKnown, false)
  // The XML-shaped envelope parses too, and junk is ignored.
  assert.equal(parseResources({ MediaContainer: { Device: [DEN] } }).length, 1)
  assert.deepEqual(parseResources(null), [])
  assert.deepEqual(parseResources([{ ...DEN, connections: [{ uri: 'javascript:alert(1)' }, { uri: 'http://x.lan:1/path' }] }])[0].connections, [])
})

test('connections: duplicates are dropped and the order is stable', () => {
  const c = (uri: string, local: boolean) => ({ uri, protocol: uri.startsWith('https') ? 'https' as const : 'http' as const, address: 'a', port: 1, local })
  assert.deepEqual(orderConnections([c('http://r:1', false), c('http://l:1', true), c('http://l:1', true)]).map(x => x.uri), ['http://l:1', 'http://r:1'])
})

test('the new-tab link carries the client id, the strong code and the product name', () => {
  const u = authUrl('client-1', 'strongcode123')
  assert.ok(u.startsWith('https://app.plex.tv/auth#?'))
  const q = new URLSearchParams(u.split('#?')[1])
  assert.equal(q.get('clientID'), 'client-1')
  assert.equal(q.get('code'), 'strongcode123')
  assert.equal(q.get('context[device][product]'), 'HyperProx')
})

test('the role matrix: admin for every method, start and connect re-confirmed', () => {
  const B = '/api/plugins/plex/signin'
  assert.equal(requiredRole('POST', B), 'admin')
  assert.equal(requiredRole('GET', `${B}/abc`), 'admin', 'the status names servers and addresses')
  assert.equal(requiredRole('POST', `${B}/abc/connect`), 'admin')
  assert.equal(requiredRole('DELETE', `${B}/abc`), 'admin')
  assert.equal(needsReconfirm('POST', B), true)
  assert.equal(needsReconfirm('POST', `${B}/`), true)
  assert.equal(needsReconfirm('POST', `${B}/abc/connect`), true)
  assert.equal(needsReconfirm('GET', `${B}/abc`), false)
  assert.equal(needsReconfirm('DELETE', `${B}/abc`), false)
})

// ── through the real gate ────────────────────────────────────────────────────

const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.addUser('op@example.com', 'operator master password', 'operator')
broker.addUser('other@example.com', 'other master password', 'admin')
const tokens = new MemoryApiTokenStore()
const audits: Array<{ action: string; details?: Record<string, unknown> }> = []
const logs: string[] = []
let app: FastifyInstance
let fake = plexTv()
let clock = Date.UTC(2026, 5, 15)
let signin: PlexSignin
let auditFails = false

before(async () => {
  setBroker(broker)
  setApiTokenStore(tokens)
  setAuditSink({ async write(r) { audits.push(r) } })
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  signin = new PlexSignin({
    http: (...a) => fake.http(...a), clientId: plexClientId, save: savePlexEndpoint,
    audit: async (action, details) => { if (auditFails) throw new Error('database down'); audits.push({ action, details }) },
    log: (msg, fields) => { logs.push(msg + ' ' + JSON.stringify(fields ?? {})) },
    now: () => clock,
    schedule: () => undefined, // the test drives tick() itself
    expire: () => undefined,   // and the clock: sweep() drops what is past its time
  })
  app = Fastify({ logger: { level: 'info', stream: { write: (l: string) => { logs.push(l) } } } })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(buildPlexSigninRoutes({ signin, known: async () => null }), { prefix: '/api/plugins/plex/signin' })
  await app.ready()
})
after(async () => { setApiTokenStore(null); setAuditSink(null); if (isUnlocked()) await lock('manual'); await app.close() })

const BASE = '/api/plugins/plex/signin'

async function adminCookie(email = 'admin@example.com', pw = 'admin master password') {
  const { cookie } = await signIn(app, email, pw)
  const rc = await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: pw } })
  assert.equal(rc.statusCode, 200)
  return cookie
}

test('guards: an operator is refused, an admin must re-confirm, an API token is refused', async () => {
  const op = (await signIn(app, 'op@example.com', 'operator master password')).cookie
  const r1 = await app.inject({ method: 'POST', url: BASE, headers: { cookie: op }, payload: {} })
  assert.equal(r1.statusCode, 403)
  assert.equal(r1.json().code, 'forbidden')

  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const r2 = await app.inject({ method: 'POST', url: BASE, headers: { cookie }, payload: {} })
  assert.equal(r2.statusCode, 403)
  assert.equal(r2.json().code, 'reconfirm_required')
  const r3 = await app.inject({ method: 'POST', url: `${BASE}/whatever/connect`, headers: { cookie }, payload: {} })
  assert.equal(r3.json().code, 'reconfirm_required')

  // A token: refused by the gate (it cannot re-confirm) or by the route by name, never served.
  const t = (await createApiToken({ name: 'auto', role: 'admin' }, 'test', tokens)).token
  await adminCookie()
  for (const [method, url] of [['POST', BASE], ['POST', `${BASE}/x/connect`], ['GET', `${BASE}/x`]] as const) {
    const r = await app.inject({ method, url, headers: { authorization: `Bearer ${t}` }, payload: {} })
    assert.equal(r.statusCode, 403, `${method} ${url}`)
    assert.ok(['reconfirm_required', 'token_forbidden'].includes(r.json().code), r.body)
  }
  assert.equal(fake.st.pins, 0, 'no PIN was ever asked for')
})

test('the whole sign-in: code, polling, servers, the server token saved and the account token gone', async () => {
  fake = plexTv()
  logs.length = 0; audits.length = 0
  const cookie = await adminCookie()
  const start = await app.inject({ method: 'POST', url: BASE, headers: { cookie }, payload: { known: 'http://den.lan:32400' } })
  assert.equal(start.statusCode, 200, start.body)
  const v = start.json().data
  assert.equal(v.state, 'waiting')
  assert.equal(v.code, 'K7QX')
  assert.equal(v.linkUrl, 'https://plex.tv/link')
  const client = (await getSettings('plex'))[CLIENT_ID_KEY]
  assert.match(client, /^[0-9a-f-]{36}$/)
  assert.ok(v.authUrl.includes(`clientID=${client}`) && v.authUrl.includes('code=strongcode123'))
  const pinPost = fake.st.calls.find(c => c.method === 'POST')!
  assert.ok(pinPost.url.includes('strong=false'))
  assert.equal(pinPost.headers['X-Plex-Client-Identifier'], client)

  // Not confirmed yet: still waiting, and the poll repeats.
  await signin.tick(v.id)
  assert.equal((await app.inject({ method: 'GET', url: `${BASE}/${v.id}`, headers: { cookie } })).json().data.state, 'waiting')
  assert.equal(POLL_MS, 2000)

  // Another admin cannot see or use this sign-in.
  const other = await adminCookie('other@example.com', 'other master password')
  assert.equal((await app.inject({ method: 'GET', url: `${BASE}/${v.id}`, headers: { cookie: other } })).statusCode, 404)

  fake.st.authorised = true
  await signin.tick(v.id)
  const s = await app.inject({ method: 'GET', url: `${BASE}/${v.id}`, headers: { cookie } })
  const sv = s.json().data
  assert.equal(sv.state, 'signed-in')
  assert.equal(sv.user, 'plexfan')
  assert.equal(sv.servers.length, 1, 'shared servers and players are left out')
  assert.equal(sv.suggested, MACHINE)
  assert.equal(sv.servers[0].preferred, 'http://den.lan:32400', 'the address discovery found is preselected')
  assert.ok(!s.body.includes(ACCOUNT) && !s.body.includes(SERVER), 'no token reaches the browser')
  assert.ok(!s.body.includes('someone@example.com'))

  // The chosen address is down: the next one listed answers and is the one saved.
  fake.st.identity.set('http://den.lan:32400', 'down')
  const c = await app.inject({ method: 'POST', url: `${BASE}/${v.id}/connect`, headers: { cookie }, payload: { server: MACHINE, uri: 'http://den.lan:32400' } })
  assert.equal(c.statusCode, 200, c.body)
  const out = c.json().data
  assert.equal(out.url, 'https://den-lan.abc.plex.direct:32400')
  assert.deepEqual(out.tried, [{ uri: 'http://den.lan:32400', error: 'could not connect' }])
  assert.ok(!c.body.includes(SERVER) && !c.body.includes(ACCOUNT))

  const stored = await getSettings('plex')
  assert.equal(stored.plex_url, 'https://den-lan.abc.plex.direct:32400')
  assert.equal(stored.plex_token, SERVER, 'the server token, not the account token')
  assert.ok(!Object.values(stored).includes(ACCOUNT), 'the account token never reaches the vault')
  assert.ok(!JSON.stringify([...broker.items.values(), broker.calls]).includes(ACCOUNT), 'nor anything written to the vault')

  const row = audits.find(a => a.action === 'plex.signin')!
  assert.equal(row.details!.message, 'Plex signed in as plexfan, server Den')
  const everything = JSON.stringify(audits) + logs.join('\n')
  assert.ok(!everything.includes(ACCOUNT), 'never audited or logged')
  assert.ok(!everything.includes(SERVER))

  // Done: the flow (and its in-memory server token) is gone.
  assert.equal((await app.inject({ method: 'GET', url: `${BASE}/${v.id}`, headers: { cookie } })).statusCode, 404)
  // The client identifier is stable: a second sign-in uses the same one.
  const again = (await app.inject({ method: 'POST', url: BASE, headers: { cookie }, payload: {} })).json().data
  assert.ok(again.authUrl.includes(`clientID=${client}`))
  assert.equal((await getSettings('plex'))[CLIENT_ID_KEY], client)
})

test('the PIN expires: by time, or when plex.tv forgets it; a new code can be asked for', async () => {
  fake = plexTv()
  const cookie = await adminCookie()
  const v = (await app.inject({ method: 'POST', url: BASE, headers: { cookie }, payload: {} })).json().data
  clock += 901_000
  await signin.tick(v.id)
  // Past its time the flow is gone, whatever its state (the page then offers a new code).
  const e = await app.inject({ method: 'GET', url: `${BASE}/${v.id}`, headers: { cookie } })
  assert.equal(e.statusCode, 404)
  assert.equal(e.json().code, 'no_signin')
  const nope = await app.inject({ method: 'POST', url: `${BASE}/${v.id}/connect`, headers: { cookie }, payload: { server: MACHINE } })
  assert.equal(nope.statusCode, 404)

  const v2 = (await app.inject({ method: 'POST', url: BASE, headers: { cookie }, payload: {} })).json().data
  assert.notEqual(v2.id, v.id)
  fake.st.pinGone = true
  await signin.tick(v2.id)
  const e2 = (await app.inject({ method: 'GET', url: `${BASE}/${v2.id}`, headers: { cookie } })).json().data
  assert.equal(e2.state, 'expired')
  assert.match(e2.error, /expired.*new code/i)
})

test('no owned server: said in plain words, nothing saved', async () => {
  fake = plexTv()
  fake.st.resources = [SHARED, PHONE]
  fake.st.authorised = true
  const cookie = await adminCookie()
  const before = (await getSettings('plex')).plex_url
  const v = (await app.inject({ method: 'POST', url: BASE, headers: { cookie }, payload: {} })).json().data
  await signin.tick(v.id)
  const e = (await app.inject({ method: 'GET', url: `${BASE}/${v.id}`, headers: { cookie } })).json().data
  assert.equal(e.state, 'error')
  assert.match(e.error, /owns no Plex server/)
  assert.equal(e.servers, undefined)
  assert.equal((await getSettings('plex')).plex_url, before)
})

test('the identity check fails everywhere: every address tried is named, and nothing is saved', async () => {
  fake = plexTv()
  fake.st.authorised = true
  const cookie = await adminCookie()
  const before = await getSettings('plex')
  const v = (await app.inject({ method: 'POST', url: BASE, headers: { cookie }, payload: {} })).json().data
  await signin.tick(v.id)
  fake.st.identity.set('https://den-lan.abc.plex.direct:32400', { status: 200, machine: 'someone-else' })
  fake.st.identity.set('http://den.lan:32400', { status: 500 })
  fake.st.identity.set('https://den-remote.abc.plex.direct:32400', 'down')

  // An address plex.tv did not list for that server is refused before anything is sent to it.
  const odd = await app.inject({ method: 'POST', url: `${BASE}/${v.id}/connect`, headers: { cookie }, payload: { server: MACHINE, uri: 'http://evil.example:32400' } })
  assert.equal(odd.statusCode, 400)
  assert.ok(!fake.st.calls.some(c => c.url.includes('evil.example')))

  const r = await app.inject({ method: 'POST', url: `${BASE}/${v.id}/connect`, headers: { cookie }, payload: { server: MACHINE } })
  assert.equal(r.statusCode, 502)
  const b = r.json()
  assert.equal(b.code, 'unreachable')
  assert.match(b.error, /could not reach Den at any of its addresses/)
  assert.deepEqual(b.tried, [
    { uri: 'https://den-lan.abc.plex.direct:32400', error: 'a different Plex server answered at that address' },
    { uri: 'http://den.lan:32400', error: 'the server answered HTTP 500' },
    { uri: 'https://den-remote.abc.plex.direct:32400', error: 'could not connect' },
  ])
  assert.deepEqual(await getSettings('plex'), before, 'nothing saved')
  // Still signed in: the person can pick again once the server is back.
  assert.equal((await app.inject({ method: 'GET', url: `${BASE}/${v.id}`, headers: { cookie } })).json().data.state, 'signed-in')
})

test('polling: plex.tv is asked every 2 seconds while waiting, and not again once signed in', async () => {
  const f = plexTv()
  const timers: Array<{ fn: () => void; ms: number }> = []
  const sv = new PlexSignin({
    http: f.http, clientId: async () => 'client-1', save: async () => {}, audit: async () => {},
    schedule: (fn, ms) => { timers.push({ fn, ms }); return undefined },
  })
  const v = await sv.start('sid-1', null)
  assert.deepEqual(timers.map(t => t.ms), [2000])
  await sv.tick(v.id)
  assert.equal(timers.length, 2, 'still waiting: checked again in 2 seconds')
  f.st.authorised = true
  await sv.tick(v.id)
  assert.equal(sv.status(v.id, 'sid-1').state, 'signed-in')
  assert.equal(timers.length, 2, 'no more polling')
  const polls = f.st.calls.filter(c => c.method === 'GET' && c.url.includes('/api/v2/pins/')).length
  await sv.tick(v.id)
  assert.equal(f.st.calls.filter(c => c.method === 'GET' && c.url.includes('/api/v2/pins/')).length, polls)
  sv.cancel(v.id, 'sid-1')
  assert.equal(sv.size, 0)
})

// ── fallback over plain http, expiry, lock, audit failure ────────────────────

const REMOTE_HTTP = { protocol: 'http', address: 'den.example.net', port: 32400, uri: 'http://den.example.net:32400', local: false, relay: false }
const DEN_HTTP = { ...DEN, connections: [...DEN.connections, REMOTE_HTTP] }

test('the fallback never sends the token over plain http to a remote address; picking one yourself does', async () => {
  fake = plexTv()
  fake.st.resources = [DEN_HTTP]
  fake.st.authorised = true
  const cookie = await adminCookie()
  const v = (await app.inject({ method: 'POST', url: BASE, headers: { cookie }, payload: {} })).json().data
  await signin.tick(v.id)
  for (const u of ['https://den-lan.abc.plex.direct:32400', 'http://den.lan:32400', 'https://den-remote.abc.plex.direct:32400']) fake.st.identity.set(u, 'down')

  const r = await app.inject({ method: 'POST', url: `${BASE}/${v.id}/connect`, headers: { cookie }, payload: { server: MACHINE } })
  assert.equal(r.statusCode, 502)
  assert.deepEqual(r.json().tried.map((t: any) => t.uri), ['https://den-lan.abc.plex.direct:32400', 'http://den.lan:32400', 'https://den-remote.abc.plex.direct:32400'])
  assert.deepEqual(r.json().skipped, ['http://den.example.net:32400'])
  assert.ok(!fake.st.calls.some(c => c.url.startsWith('http://den.example.net')), 'the token never went there')

  // Picked explicitly: tried (first), and saved when it answers.
  fake.st.calls.length = 0
  const ok = await app.inject({ method: 'POST', url: `${BASE}/${v.id}/connect`, headers: { cookie }, payload: { server: MACHINE, uri: 'http://den.example.net:32400' } })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.equal(ok.json().data.url, 'http://den.example.net:32400')
  assert.ok(fake.st.calls[0].url.startsWith('http://den.example.net:32400/identity'))
})

test('a flow is dropped at its expiresAt by its timer, whatever its state, server tokens included', async () => {
  const f = plexTv()
  f.st.authorised = true
  let t = 1_000_000
  const ends: Array<{ fn: () => void; ms: number }> = []
  const sv = new PlexSignin({
    http: f.http, clientId: async () => 'client-1', save: async () => {}, audit: async () => {},
    now: () => t, schedule: () => undefined, expire: (fn, ms) => { ends.push({ fn, ms }); return undefined },
  })
  const v = await sv.start('sid-1', null)
  assert.equal(ends.length, 1)
  assert.equal(ends[0].ms, 900_000, 'armed for the code’s life')
  await sv.tick(v.id)
  assert.equal(sv.status(v.id, 'sid-1').state, 'signed-in')
  assert.equal(ends.length, 2)
  assert.equal(ends[1].ms, 15 * 60_000, 're-armed for the time to choose')
  ends[0].fn() // a stale timer from before: still drops only its own flow, which is this one
  assert.equal(sv.size, 0, 'dropped while signed in, with its server tokens')
  assert.throws(() => sv.status(v.id, 'sid-1'), /ended/)
})

test('a failed audit row: the save stands, the person is told, and the flow ends', async () => {
  fake = plexTv()
  fake.st.authorised = true
  const cookie = await adminCookie()
  const v = (await app.inject({ method: 'POST', url: BASE, headers: { cookie }, payload: {} })).json().data
  await signin.tick(v.id)
  auditFails = true
  try {
    const r = await app.inject({ method: 'POST', url: `${BASE}/${v.id}/connect`, headers: { cookie }, payload: { server: MACHINE } })
    assert.equal(r.statusCode, 200, r.body)
    assert.match(r.json().data.note, /audit log row .* could not be written/)
    assert.equal((await getSettings('plex')).plex_token, SERVER)
    assert.equal((await app.inject({ method: 'GET', url: `${BASE}/${v.id}`, headers: { cookie } })).statusCode, 404)
  } finally { auditFails = false }
})

test('locking HyperProx drops every sign-in, server tokens included', async () => {
  fake = plexTv()
  fake.st.authorised = true
  const cookie = await adminCookie()
  const v = (await app.inject({ method: 'POST', url: BASE, headers: { cookie }, payload: {} })).json().data
  await signin.tick(v.id)
  assert.ok(signin.size >= 1)
  await lock('manual')
  assert.equal(signin.size, 0)
})
