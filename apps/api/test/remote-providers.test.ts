// Remote access providers against a mocked fetch: request shapes, auth, key rules, and errors that never
// carry a secret.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TailscaleClient, TAG_RE } from '../src/lib/remote/tailscale'
import { NetbirdClient, normaliseManagementUrl } from '../src/lib/remote/netbird'
import { ProviderError } from '../src/lib/remote/types'

interface Call { url: string; method: string; headers: Record<string, string>; body: any }

/** A fetch that answers from a route table: `METHOD path` → [status, body]. Records every call. */
function mockFetch(routes: Record<string, (c: Call) => [number, any]>) {
  const calls: Call[] = []
  const fn = (async (input: any, init: any = {}) => {
    const url = String(input)
    const u = new URL(url)
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v)
    let body: any = init.body
    if (typeof body === 'string' && headers['content-type']?.includes('json')) body = JSON.parse(body)
    if (typeof body === 'string' && headers['content-type']?.includes('form')) body = Object.fromEntries(new URLSearchParams(body))
    const call = { url, method: init.method ?? 'GET', headers, body }
    calls.push(call)
    const key = `${call.method} ${u.pathname}`
    const h = routes[key]
    if (!h) return new Response(JSON.stringify({ message: `no route ${key}` }), { status: 404 })
    const [status, out] = h(call)
    return new Response(out === undefined ? null : JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { fn, calls }
}

// ── Tailscale ────────────────────────────────────────────────────────────────

test('tailscale: an API token is sent as a bearer token, and test() counts devices', async () => {
  const m = mockFetch({ 'GET /api/v2/tailnet/-/devices': () => [200, { devices: [{ id: '1' }, { id: '2' }] }] })
  const c = new TailscaleClient({ apiToken: 'tskey-api-SECRET' }, { fetch: m.fn })
  assert.equal(await c.test(), 'Connected — 2 devices')
  assert.equal(m.calls[0].headers.authorization, 'Bearer tskey-api-SECRET')
  assert.match(m.calls[0].url, /fields=all/)
})

test('tailscale: an OAuth client gets an access token once and reuses it until near expiry', async () => {
  let now = 1_000_000
  let tokens = 0
  const m = mockFetch({
    'POST /api/v2/oauth/token': c => { tokens++; assert.equal(c.body.client_id, 'cid'); assert.equal(c.body.client_secret, 'csecret'); return [200, { access_token: `at-${tokens}`, expires_in: 3600 }] },
    'GET /api/v2/tailnet/-/devices': () => [200, { devices: [] }],
  })
  const c = new TailscaleClient({ oauthClientId: 'cid', oauthClientSecret: 'csecret', apiToken: 'ignored' }, { fetch: m.fn, now: () => now })
  await c.listDevices(); await c.listDevices()
  assert.equal(tokens, 1)
  assert.equal(m.calls[1].headers.authorization, 'Bearer at-1')
  now += 3600_000   // past expiry
  await c.listDevices()
  assert.equal(tokens, 2)
  assert.equal(m.calls.at(-1)!.headers.authorization, 'Bearer at-2')
})

test('tailscale: mintKey asks for a single-use, non-ephemeral, preauthorized key with tags and a short expiry', async () => {
  const m = mockFetch({ 'POST /api/v2/tailnet/example.org/keys': () => [200, { id: 'k123', key: 'tskey-auth-SECRET', expires: '2026-11-03T10:10:00Z' }] })
  const c = new TailscaleClient({ apiToken: 't', tailnet: 'example.org' }, { fetch: m.fn })
  const k = await c.mintKey({ name: 'HyperProx pve-a', tags: ['tag:server', 'tag:hyperprox'] })
  assert.deepEqual(k, { id: 'k123', secret: 'tskey-auth-SECRET', expiresAt: '2026-11-03T10:10:00Z' })
  const body = m.calls[0].body
  assert.deepEqual(body.capabilities.devices.create, { reusable: false, ephemeral: false, preauthorized: true, tags: ['tag:server', 'tag:hyperprox'] })
  assert.ok(body.expirySeconds > 0 && body.expirySeconds <= 900, `short expiry, got ${body.expirySeconds}`)
  assert.match(body.description, /HyperProx/)
  assert.ok(body.description.length <= 50)
})

test('tailscale: an OAuth key without tags is refused before any call; bad tags are refused', async () => {
  const m = mockFetch({})
  const oauth = new TailscaleClient({ oauthClientId: 'a', oauthClientSecret: 'b' }, { fetch: m.fn })
  await assert.rejects(oauth.mintKey({ name: 'x', tags: [] }), /tag/i)
  const tok = new TailscaleClient({ apiToken: 't' }, { fetch: m.fn })
  await assert.rejects(tok.mintKey({ name: 'x', tags: ['server'] }), /tag:/)
  assert.equal(m.calls.length, 0)
  assert.ok(TAG_RE.test('tag:web-1'))
  assert.ok(!TAG_RE.test('tag:'))
  assert.ok(!TAG_RE.test('tag:a b'))
})

test('tailscale: devices map to the common shape; revoke and delete use the right paths', async () => {
  const m = mockFetch({
    'GET /api/v2/tailnet/-/devices': () => [200, { devices: [{
      id: '9001', nodeId: 'nABC', name: 'pve-a.tail0.ts.net', hostname: 'pve-a', addresses: ['100.64.0.7', 'fd7a::7'],
      connectedToControl: true, lastSeen: '2026-11-03T09:00:00Z', clientVersion: '1.90.1-t1234', os: 'linux',
    }] }],
    'DELETE /api/v2/tailnet/-/keys/k1': () => [200, undefined],
    'DELETE /api/v2/device/9001': () => [200, undefined],
  })
  const c = new TailscaleClient({ apiToken: 't' }, { fetch: m.fn })
  const [d] = await c.listDevices()
  assert.deepEqual(d, {
    id: '9001', nodeKey: 'nABC', name: 'pve-a.tail0.ts.net', hostname: 'pve-a', addresses: ['100.64.0.7', 'fd7a::7'],
    online: true, lastSeen: '2026-11-03T09:00:00Z', version: '1.90.1', os: 'linux',
  })
  await c.revokeKey('k1')
  await c.deleteDevice('9001')
  assert.deepEqual(m.calls.slice(1).map(x => `${x.method} ${new URL(x.url).pathname}`), ['DELETE /api/v2/tailnet/-/keys/k1', 'DELETE /api/v2/device/9001'])
})

test('tailscale: setRouting approves exactly the advertised routes, exit node as both defaults', async () => {
  const m = mockFetch({ 'POST /api/v2/device/9001/routes': () => [200, {}] })
  const c = new TailscaleClient({ apiToken: 't' }, { fetch: m.fn })
  const dev = { id: '9001', name: 'x', addresses: [], online: true, lastSeen: null, version: null }
  assert.deepEqual(await c.setRouting(dev, { subnets: ['192.0.2.0/24'], exitNode: true }, []), [])
  assert.deepEqual(m.calls[0].body, { routes: ['192.0.2.0/24', '0.0.0.0/0', '::/0'] })
  await c.setRouting(dev, { subnets: [], exitNode: false }, [])
  assert.deepEqual(m.calls[1].body, { routes: [] })
})

test('tailscale: an error answer becomes a ProviderError with status and message, never the token', async () => {
  const m = mockFetch({ 'GET /api/v2/tailnet/-/devices': () => [403, { message: 'API token tskey-api-SECRET lacks scope' }] })
  const c = new TailscaleClient({ apiToken: 'tskey-api-SECRET' }, { fetch: m.fn })
  await assert.rejects(c.listDevices(), (e: any) => {
    assert.ok(e instanceof ProviderError)
    assert.equal(e.status, 403)
    assert.match(e.message, /403/)
    assert.doesNotMatch(e.message, /SECRET/)
    return true
  })
})

// ── NetBird ──────────────────────────────────────────────────────────────────

test('netbird: management URL defaults to the cloud, strips /api, and is https only, private addresses included', () => {
  assert.equal(normaliseManagementUrl(''), 'https://api.netbird.io')
  assert.equal(normaliseManagementUrl('https://nb.example.com/api/'), 'https://nb.example.com')
  assert.equal(normaliseManagementUrl('https://nb.example.com:33073'), 'https://nb.example.com:33073')
  assert.throws(() => normaliseManagementUrl('http://127.0.0.1:8081'), /https/)
  assert.throws(() => normaliseManagementUrl('http://192.0.2.10'), /https/)
  assert.throws(() => normaliseManagementUrl('http://nb.example.com'), /https/)
  assert.throws(() => normaliseManagementUrl('ftp://x'), /https/)
  assert.throws(() => normaliseManagementUrl('https://user:pw@nb.example.com'), /credentials/)
})

test('netbird: token auth header, test() counts peers', async () => {
  const m = mockFetch({ 'GET /api/peers': () => [200, [{ id: 'p1' }]] })
  const c = new NetbirdClient({ managementUrl: 'https://nb.example.com', apiToken: 'nbp_SECRET' }, { fetch: m.fn })
  assert.equal(await c.test(), 'Connected — 1 peer')
  assert.equal(m.calls[0].headers.authorization, 'Token nbp_SECRET')
  assert.equal(m.calls[0].url, 'https://nb.example.com/api/peers')
})

test('netbird: mintKey makes a one-off, single-use, non-ephemeral key with the minimum lifetime and named groups', async () => {
  const m = mockFetch({
    'GET /api/groups': () => [200, [{ id: 'g-all', name: 'All' }, { id: 'g-srv', name: 'servers' }]],
    'POST /api/setup-keys': () => [200, { id: 'sk1', key: 'A1B2C3D4-SECRET', expires: '2026-11-04T09:00:00Z' }],
  })
  const c = new NetbirdClient({ managementUrl: '', apiToken: 't' }, { fetch: m.fn })
  const k = await c.mintKey({ name: 'HyperProx lxc-101', tags: ['servers'] })
  assert.deepEqual(k, { id: 'sk1', secret: 'A1B2C3D4-SECRET', expiresAt: '2026-11-04T09:00:00Z' })
  const body = m.calls[1].body
  assert.deepEqual(body, { name: 'HyperProx lxc-101', type: 'one-off', expires_in: 86400, auto_groups: ['g-srv'], usage_limit: 1, ephemeral: false })
})

test('netbird: an unknown group is refused before a key is made; no groups means no group lookup', async () => {
  const m = mockFetch({
    'GET /api/groups': () => [200, [{ id: 'g-all', name: 'All' }]],
    'POST /api/setup-keys': () => [200, { id: 'sk', key: 'k', expires: 'x' }],
  })
  const c = new NetbirdClient({ managementUrl: '', apiToken: 't' }, { fetch: m.fn })
  await assert.rejects(c.mintKey({ name: 'x', tags: ['nope'] }), /nope/)
  assert.equal(m.calls.filter(x => x.method === 'POST').length, 0)
  m.calls.length = 0
  await c.mintKey({ name: 'x', tags: [] })
  assert.deepEqual(m.calls.map(x => x.method), ['POST'])
})

test('netbird: peers map to the common shape; delete key and peer', async () => {
  const m = mockFetch({
    'GET /api/peers': () => [200, [{ id: 'p1', name: 'pve-a', hostname: 'pve-a', ip: '100.92.0.4', connected: false, last_seen: '2026-11-02T08:00:00Z', version: '0.59.1', os: 'Debian 13' }]],
    'DELETE /api/setup-keys/sk1': () => [200, undefined],
    'DELETE /api/peers/p1': () => [200, undefined],
  })
  const c = new NetbirdClient({ managementUrl: '', apiToken: 't' }, { fetch: m.fn })
  assert.deepEqual(await c.listDevices(), [{
    id: 'p1', name: 'pve-a', hostname: 'pve-a', addresses: ['100.92.0.4'], online: false, lastSeen: '2026-11-02T08:00:00Z', version: '0.59.1', os: 'Debian 13',
  }])
  await c.revokeKey('sk1')
  await c.deleteDevice('p1')
  assert.equal(m.calls.length, 3)
})

test('netbird: setRouting replaces its earlier routes, sends them to a dedicated group (made once), and never auto-applies an exit node', async () => {
  let n = 0
  let groups: any[] = [{ id: 'g-all', name: 'All' }]
  const m = mockFetch({
    'GET /api/groups': () => [200, groups],
    'POST /api/groups': c => { groups = [...groups, { id: 'g-hp', name: c.body.name }]; return [200, { id: 'g-hp' }] },
    'DELETE /api/routes/old1': () => [200, undefined],
    'POST /api/routes': () => [200, { id: `r${++n}` }],
  })
  const c = new NetbirdClient({ managementUrl: '', apiToken: 't' }, { fetch: m.fn })
  const dev = { id: 'p1', name: 'pve-a', addresses: [], online: true, lastSeen: null, version: null }
  const ids = await c.setRouting(dev, { subnets: ['192.0.2.0/24'], exitNode: true }, ['old1'])
  assert.deepEqual(ids, ['r1', 'r2'])
  assert.deepEqual(m.calls.filter(x => x.method === 'POST' && x.url.endsWith('/api/groups')).map(x => x.body), [{ name: 'hyperprox-routes' }])
  const posts = m.calls.filter(x => x.method === 'POST' && x.url.endsWith('/api/routes')).map(x => x.body)
  assert.deepEqual(posts.map(p => p.network), ['192.0.2.0/24', '0.0.0.0/0'])
  for (const p of posts) {
    assert.equal(p.peer, 'p1'); assert.deepEqual(p.groups, ['g-hp'], 'never All'); assert.equal(p.enabled, true)
    assert.ok(p.network_id.length <= 40)
  }
  assert.equal(posts[0].skip_auto_apply, undefined)
  assert.equal(posts[1].skip_auto_apply, true)
  assert.ok(m.calls.some(x => x.method === 'DELETE' && x.url.endsWith('/api/routes/old1')))
  // A second time the group is found, not made again.
  m.calls.length = 0
  await c.setRouting(dev, { subnets: ['192.0.2.0/24'], exitNode: false }, [])
  assert.equal(m.calls.filter(x => x.method === 'POST' && x.url.endsWith('/api/groups')).length, 0)
  // Off: only deletes.
  m.calls.length = 0
  assert.deepEqual(await c.setRouting(dev, { subnets: [], exitNode: false }, ['r1', 'r2']), [])
  assert.equal(m.calls.filter(x => x.method === 'POST').length, 0)
})

test('revocation is confirmed with the provider: gone, revoked or expired counts; valid does not', async () => {
  const ts = (body: any, status = 200) => new TailscaleClient({ apiToken: 't' }, { fetch: mockFetch({ 'GET /api/v2/tailnet/-/keys/k1': () => [status, body] }).fn })
  assert.equal(await ts({ message: 'not found' }, 404).keyRevoked('k1'), true)
  assert.equal(await ts({ id: 'k1', revoked: '2026-11-03T10:00:00Z' }).keyRevoked('k1'), true)
  assert.equal(await ts({ id: 'k1', expires: '2000-01-01T00:00:00Z' }).keyRevoked('k1'), true)
  assert.equal(await ts({ id: 'k1', expires: '2999-01-01T00:00:00Z' }).keyRevoked('k1'), false)
  const nb = (body: any, status = 200) => new NetbirdClient({ managementUrl: '', apiToken: 't' }, { fetch: mockFetch({ 'GET /api/setup-keys/s1': () => [status, body] }).fn })
  assert.equal(await nb({}, 404).keyRevoked('s1'), true)
  assert.equal(await nb({ id: 's1', revoked: true, valid: false }).keyRevoked('s1'), true)
  assert.equal(await nb({ id: 's1', revoked: false, valid: true, state: 'valid' }).keyRevoked('s1'), false)
})

test('no request follows a redirect: the token goes only to the origin it was configured for', async () => {
  let init: any = null
  const f = (async (_u: any, i: any) => { init = i; return new Response('[]', { status: 200 }) }) as typeof fetch
  await new NetbirdClient({ managementUrl: 'https://nb.example.com', apiToken: 't' }, { fetch: f }).listDevices()
  assert.equal(init.redirect, 'error')
  await new TailscaleClient({ apiToken: 't' }, { fetch: f }).listDevices()
  assert.equal(init.redirect, 'error')
})

test('tailscale: advertisedRoutes reads what the client advertises', async () => {
  const m = mockFetch({ 'GET /api/v2/device/9001/routes': () => [200, { advertisedRoutes: ['198.51.100.0/24'], enabledRoutes: [] }] })
  const c = new TailscaleClient({ apiToken: 't' }, { fetch: m.fn })
  assert.deepEqual(await c.advertisedRoutes({ id: '9001', name: 'x', addresses: [], online: true, lastSeen: null, version: null }), ['198.51.100.0/24'])
})

// ── Built from the vault ─────────────────────────────────────────────────────

test('providers from the vault: null until configured; the Test button says what to add', async () => {
  const { providerFromVault, providerSettingsFromVault, testProvider } = await import('../src/lib/remote/providers')
  const empty = async () => ({})
  assert.equal(await providerFromVault('tailscale', empty), null)
  assert.equal(await providerFromVault('netbird', empty), null)
  await assert.rejects(testProvider('tailscale', empty), /API access token, or an OAuth client/)
  await assert.rejects(testProvider('zerotier', empty), /No remote access provider/)
  const m = mockFetch({ 'GET /api/peers': () => [200, []] })
  const nb = async () => ({ api_token: 't', management_url: 'https://nb.example.com', default_groups: 'servers, lab' })
  assert.equal(await testProvider('netbird', nb, m.fn), 'Connected — 0 peers')
  assert.deepEqual(await providerSettingsFromVault('netbird', nb), { tags: ['servers', 'lab'], managementUrl: 'https://nb.example.com' })
  assert.deepEqual(await providerSettingsFromVault('tailscale', async () => ({ default_tags: 'tag:a,tag:b' })), { tags: ['tag:a', 'tag:b'] })
})
