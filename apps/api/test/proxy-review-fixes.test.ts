// The security review's findings, one test (or more) each, on fixtures that keep NPM 2.16.0's own rules
// (PUT is a patch, `enabled` is honoured on create, disabling a disabled host is a 400).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFile } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { ProxyPlanner } from '../src/lib/proxy/plans'
import { LEGACY_NPM_ID, isLocalAddress } from '../src/lib/proxy/service'
import { guestFetch } from '../src/lib/proxy/transport'
import { NPMClient, clearNpmTokens } from '../src/lib/npm-client'
import { setProxyService, wizardCreateHost, wizardUpdateHost } from '../src/lib/proxy'
import { fixtureWorld } from './fakes/proxy-world'
import { FakeTraefik } from './fakes/proxy-servers'

const actor = { email: 'admin@example.invalid' }
const host = (domains: string[], extra: Record<string, unknown> = {}) => ({ domains, forwardScheme: 'http', forwardHost: '192.0.2.50', forwardPort: 9000, enabled: true, ...extra })

async function world(extra: Record<string, unknown> = {}) {
  const w = fixtureWorld(extra)
  const add = async (kind: string, name: string, url: string, settings: Record<string, string>, secrets: Record<string, string>) =>
    (await w.service.createInstance({ kind, name, url, settings, secrets }, actor)).instance.id
  const ids = {
    traefik: await add('traefik', 'traefik', 'http://192.0.2.38:8282', { api_user: 'hpx', file: '/etc/traefik/dynamic/hyperprox.yml', ssh_host: '192.0.2.38', ssh_user: 'hpx' }, { api_password: 'traefik-test-password', ssh_password: 'x' }),
    caddy: await add('caddy', 'caddy', 'http://192.0.2.38:2019', {}, {}),
    haproxy: await add('haproxy', 'haproxy', 'http://192.0.2.38:5555', { user: 'hpx' }, { password: 'haproxy-test-password' }),
  }
  return { ...w, ids, planner: new ProxyPlanner(w.service) }
}

/** An NPM host with every option on, made directly on the fake NPM (as a person would in NPM's UI). */
function fullHost(w: Awaited<ReturnType<typeof world>>) {
  w.npm1.certs.push({ id: 5, nice_name: 'main cert', domain_names: ['full.hpx.invalid'], expires_on: '2027-01-01 00:00:00', provider: 'other', meta: { secret_dns_token: 'do-not-leak' } })
  const h = { id: 50, created_on: 'x', modified_on: 'x', owner_user_id: 1, domain_names: ['full.hpx.invalid'], forward_scheme: 'http', forward_host: '192.0.2.60',
    forward_port: 8443, access_list_id: 3, certificate_id: 5, ssl_forced: true, caching_enabled: true, block_exploits: false, advanced_config: 'proxy_set_header Authorization "Bearer s3cret";',
    meta: { nginx_online: true, nginx_err: null }, allow_websocket_upgrade: false, http2_support: true, enabled: true, locations: [{ path: '/x' }],
    hsts_enabled: true, hsts_subdomains: true, trust_forwarded_proto: true }
  w.npm1.hosts.push(h)
  return h
}
const KEEP = ['certificate_id', 'ssl_forced', 'hsts_enabled', 'hsts_subdomains', 'http2_support', 'caching_enabled', 'block_exploits', 'allow_websocket_upgrade',
  'advanced_config', 'access_list_id', 'locations', 'trust_forwarded_proto', 'domain_names', 'forward_host', 'forward_port', 'forward_scheme', 'enabled']
const pick = (h: any) => JSON.parse(JSON.stringify(Object.fromEntries(KEEP.map(k => [k, h[k]]))))

// --- 1. NPM updates merge ----------------------------------------------------------------------------------

test('1: a partial NPM update merges; the full object is sent; every other field keeps its value; read-back covers them', async () => {
  const w = await world()
  const h = fullHost(w)
  const before = pick(h)
  const plan = await w.planner.preview(LEGACY_NPM_ID, { action: 'update', hostId: '50', host: { npm: { block_exploits: true } } }, actor)
  assert.deepEqual(plan.changes, ['block exploits: off → on'])
  assert.deepEqual(plan.warnings, [])
  const r = await w.planner.apply(plan.id, actor)
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(pick(w.npm1.hosts.find(x => x.id === 50)), { ...before, block_exploits: true })
  const put = w.npm1.log.filter(l => l.method === 'PUT').at(-1)!
  for (const k of ['certificate_id', 'hsts_enabled', 'http2_support', 'caching_enabled', 'advanced_config', 'access_list_id', 'locations', 'trust_forwarded_proto']) {
    assert.ok(k in put.body, `the PUT carries ${k}`)
  }
})

test('1: the preview names every field it changes, and warns when a certificate or HTTPS option is taken off', async () => {
  const w = await world()
  fullHost(w)
  const plan = await w.planner.preview(LEGACY_NPM_ID, { action: 'update', hostId: '50', host: { npm: { certificate_id: false, ssl_forced: false, hsts_enabled: false, http2_support: false, advanced_config: '' } } }, actor)
  assert.ok(plan.changes.includes('certificate: #5 full.hpx.invalid → none'), plan.changes.join(' | '))
  for (const c of ['force HTTPS: on → off', 'HSTS: on → off', 'HTTP/2: on → off']) assert.ok(plan.changes.includes(c), c)
  assert.ok(plan.changes.some(c => /^advanced config: replaced to empty/.test(c)))
  for (const re of [/certificate is taken off.*plain HTTP/, /no longer forced/, /HSTS is turned off/, /HTTP\/2 is turned off/]) assert.ok(plan.warnings.some(x => re.test(x)), String(re))
  assert.ok(plan.fields.some(f => f.field === 'npm.certificate_id' && f.from === 5 && f.to === false))
})

test('1: a read-back that lost a field it was not asked to change fails the apply', async () => {
  const w = await world()
  fullHost(w)
  const plan = await w.planner.preview(LEGACY_NPM_ID, { action: 'update', hostId: '50', host: { forwardPort: 8444 } }, actor)
  // An NPM that drops the certificate on every PUT (the bug the review found, done by the server instead).
  const inner = w.npm1.fetch
  w.npm1.fetch = (async (u: string, i?: RequestInit) => {
    const res = await inner(u, i)
    if (i?.method === 'PUT') w.npm1.hosts.find(x => x.id === 50)!.certificate_id = 0
    return res
  }) as any
  const r = await w.planner.apply(plan.id, actor)
  assert.equal(r.ok, false)
  assert.match(r.mismatch.join(' '), /certificate is off, expected 5/)
})

// --- 2. websockets ----------------------------------------------------------------------------------------------

test('2: leaving websockets out keeps it; a websockets-only change works', async () => {
  const w = await world()
  fullHost(w)
  const p1 = await w.planner.preview(LEGACY_NPM_ID, { action: 'update', hostId: '50', host: { forwardPort: 8444 } }, actor)
  assert.deepEqual(p1.changes, ['forward port: 8443 → 8444'])
  assert.equal((await w.planner.apply(p1.id, actor)).ok, true)
  assert.equal(w.npm1.hosts.find(x => x.id === 50)!.allow_websocket_upgrade, false)
  const p2 = await w.planner.preview(LEGACY_NPM_ID, { action: 'update', hostId: '50', host: { websockets: true } }, actor)
  assert.deepEqual(p2.changes, ['websockets: off → on'])
  assert.equal((await w.planner.apply(p2.id, actor)).ok, true)
  assert.equal(w.npm1.hosts.find(x => x.id === 50)!.allow_websocket_upgrade, true)
})

// --- 3. a disabled create, and a create that fails part-way ------------------------------------------------------

test('3: a host created disabled is one call with enabled:false, and no follow-up disable', async () => {
  const w = await world()
  const r = await w.planner.apply((await w.planner.preview(LEGACY_NPM_ID, { action: 'create', host: host(['off.hpx.invalid'], { enabled: false }) }, actor)).id, actor)
  assert.equal(r.ok, true, r.message)
  assert.equal(r.after?.enabled, false)
  const calls = w.npm1.log.filter(l => l.method !== 'GET' && l.path !== '/tokens')
  assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), ['POST /nginx/proxy-hosts'])
  assert.equal(calls[0].body.enabled, false)
})

test('3: a create that fails after making the host says exactly what exists and offers to remove only that', async () => {
  const w = await world()
  const others = w.npm1.hosts.map(h => h.id)
  w.npm1.failAfterCreate = true
  const r = await w.planner.apply((await w.planner.preview(LEGACY_NPM_ID, { action: 'create', host: host(['half.hpx.invalid']) }, actor)).id, actor)
  assert.equal(r.ok, false)
  assert.match(r.message, /failed part-way .*now has half\.hpx\.invalid → http:\/\/192\.0\.2\.50:9000 \(\d+, enabled\)/)
  assert.ok(r.cleanup)
  assert.equal(r.cleanup!.action, 'delete')
  assert.equal(r.cleanup!.hostId, r.hostId)
  const c = await w.planner.apply(r.cleanup!.id, actor)
  assert.equal(c.ok, true, c.message)
  assert.deepEqual(w.npm1.hosts.map(h => h.id), others, 'only the leftover was removed')
})

// --- 4. the fingerprint covers the whole host ------------------------------------------------------------------

test('4: any change to the host after the preview (advanced config, certificate, websockets) fails the apply', async () => {
  for (const change of [{ advanced_config: '# changed' }, { certificate_id: 0 }, { allow_websocket_upgrade: true }, { access_list_id: 9 }, { locations: [] }]) {
    const w = await world()
    fullHost(w)
    const plan = await w.planner.preview(LEGACY_NPM_ID, { action: 'update', hostId: '50', host: { forwardPort: 8444 } }, actor)
    Object.assign(w.npm1.hosts.find(x => x.id === 50)!, change)
    await assert.rejects(w.planner.apply(plan.id, actor), /changed .* after the preview/, JSON.stringify(change))
    assert.equal(w.npm1.log.filter(l => l.method === 'PUT').length, 0, 'nothing was sent')
  }
})

test('4: NPM’s own bookkeeping (modified_on, nginx_online) does not count as a change', async () => {
  const w = await world()
  fullHost(w)
  const plan = await w.planner.preview(LEGACY_NPM_ID, { action: 'update', hostId: '50', host: { forwardPort: 8444 } }, actor)
  Object.assign(w.npm1.hosts.find(x => x.id === 50)!, { modified_on: 'later', meta: { nginx_online: false, nginx_err: 'reload' } })
  assert.equal((await w.planner.apply(plan.id, actor)).ok, true)
})

// --- 5. Traefik: one write at a time, and the file's other keys survive ------------------------------------------

test('5: two applies on one Traefik instance at once both land', async () => {
  const w = await world()
  // Slow file reads, so the two read-modify-writes would interleave without the lock.
  const read = w.files.read.bind(w.files)
  w.files.read = async f => { const t = await read(f); await new Promise(r => setTimeout(r, 30)); return t }
  const [a, b] = await Promise.all([
    w.planner.preview(w.ids.traefik, { action: 'create', host: host(['a.hpx.invalid']) }, actor),
    w.planner.preview(w.ids.traefik, { action: 'create', host: host(['b.hpx.invalid']) }, actor),
  ])
  const [ra, rb] = await Promise.all([w.planner.apply(a.id, actor), w.planner.apply(b.id, actor)])
  assert.equal(ra.ok, true, ra.message)
  assert.equal(rb.ok, true, rb.message)
  const text = w.files.files.get('/etc/traefik/dynamic/hyperprox.yml')!
  assert.match(text, /a\.hpx\.invalid/)
  assert.match(text, /b\.hpx\.invalid/)
})

test('12b: keys HyperProx does not edit in its own Traefik file are kept', async () => {
  const w = await world()
  const { TRAEFIK_HEADER } = await import('../src/lib/proxy/providers/traefik')
  w.files.files.set('/etc/traefik/dynamic/hyperprox.yml', `${TRAEFIK_HEADER}\nhttp:\n  middlewares:\n    gzip:\n      compress: {}\ntls:\n  options:\n    modern:\n      minVersion: VersionTLS13\ntcp:\n  routers: {}\n`)
  const r = await w.planner.apply((await w.planner.preview(w.ids.traefik, { action: 'create', host: host(['k.hpx.invalid']) }, actor)).id, actor)
  assert.equal(r.ok, true, r.message)
  const yaml = require('js-yaml')
  const doc = yaml.load(w.files.files.get('/etc/traefik/dynamic/hyperprox.yml')!)
  assert.deepEqual(doc.http.middlewares.gzip, { compress: {} })
  assert.equal(doc.tls.options.modern.minVersion, 'VersionTLS13')
  assert.ok(doc.tcp)
  void FakeTraefik
})

// --- 6. what viewers get is tested in proxy-routes.test.ts ------------------------------------------------------

// --- 7. Managed APIs on loopback, reached through the container -------------------------------------------------

test('7: guestFetch reaches a loopback API through a shell: method, headers, body, status, headers back, no redirects', async () => {
  const seen: any[] = []
  const srv = http.createServer((req, res) => {
    let b = ''
    req.on('data', d => { b += d })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, ct: req.headers['content-type'], body: b })
      if (req.url === '/redirect') { res.writeHead(307, { location: 'http://192.0.2.200/' }); return res.end() }
      res.writeHead(202, { 'Reload-ID': 'r-9', 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: "it's \"quoted\"" }))
    })
  })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as AddressInfo).port
  try {
    // Asynchronous: the server answering is in this process.
    const exec = (script: string) => new Promise<{ code: number; output: string }>(res =>
      execFile('bash', ['-c', script], { encoding: 'utf8' }, (e: any, out) => res({ code: e ? (e.code ?? 1) : 0, output: String(out ?? '') })))
    const f = guestFetch(exec)
    const res = await f(`http://127.0.0.1:${port}/v3/x?transaction_id=1`, { method: 'PUT', headers: { Authorization: 'Basic aHB4OnBhc3MnIjsk', 'Content-Type': 'application/json' }, body: '{"a":"$HOME \'q\'"}' })
    assert.equal(res.status, 202)
    assert.equal(res.headers.get('reload-id'), 'r-9')
    assert.deepEqual(await res.json(), { ok: "it's \"quoted\"" })
    assert.deepEqual(seen[0], { method: 'PUT', url: '/v3/x?transaction_id=1', auth: 'Basic aHB4OnBhc3MnIjsk', ct: 'application/json', body: '{"a":"$HOME \'q\'"}' })
    const red = await f(`http://127.0.0.1:${port}/redirect`)
    assert.equal(red.status, 307, 'the redirect is returned, not followed')
    assert.equal(seen.length, 2)
    await assert.rejects(f('http://192.0.2.1:2019/config/'), /loopback addresses only/)
  } finally { srv.close() }
})

test('7: the Managed Caddy and HAProxy recipes bind their APIs to loopback and register as reached-through-the-container', async () => {
  const { managedProxyRecipe, managedProxyFiles, managedInstanceInput, managedSecret } = await import('../src/lib/proxy/managed-recipes')
  const secret = managedSecret()
  assert.equal(JSON.parse(managedProxyFiles('caddy', secret)['/opt/caddy/initial.json']).admin.listen, '127.0.0.1:2019')
  assert.match(managedProxyFiles('haproxy', secret)['/opt/haproxy/cfg/dataplaneapi.yml'], /host: 127\.0\.0\.1/)
  for (const k of ['caddy', 'haproxy'] as const) {
    const compose = (managedProxyRecipe(k, secret).install as any).compose
    assert.match(compose, /network_mode: host/)
    assert.doesNotMatch(compose, /2019|5555/, 'the API port is not published')
    const i = managedInstanceInput(k, { name: k, ip: '192.0.2.70', node: 'node1', vmid: 9100, secret })
    assert.match(i.url!, /^http:\/\/127\.0\.0\.1:/)
    assert.equal(i.settings!.api_via, 'guest')
  }
})

// --- 8. HAProxy rollback -------------------------------------------------------------------------------------

test('8: a commit that loses a frontend is rolled back through the Data Plane, reloaded, re-checked and reported', async () => {
  const w = await world()
  const r0 = await w.planner.apply((await w.planner.preview(w.ids.haproxy, { action: 'create', host: host(['rb.hpx.invalid']) }, actor)).id, actor)
  assert.equal(r0.ok, true, r0.message)
  const before = JSON.stringify(w.haproxy.state)
  w.haproxy.dropFrontendsOnCommit = true
  await assert.rejects(w.planner.apply((await w.planner.preview(w.ids.haproxy, { action: 'disable', hostId: r0.hostId! }, actor)).id, actor),
    /no longer has frontend\(s\) http\. HyperProx put the previous configuration back, reloaded HAProxy and checked that every frontend is there again\./)
  assert.equal(w.haproxy.rollbacks, 1)
  assert.equal(JSON.stringify(w.haproxy.state), before, 'the configuration from before the change is back')
})

test('8: a failed reload is rolled back too', async () => {
  const w = await world()
  const inner = w.haproxy.fetch
  let failNext = true
  w.haproxy.fetch = (async (u: string, i?: RequestInit) => {
    const url = new URL(u)
    const m = /\/reloads\/(.+)$/.exec(url.pathname)
    if (m && failNext) { failNext = false; return new Response(JSON.stringify({ id: m[1], status: 'failed', response: 'haproxy exited' }), { status: 200 }) }
    return inner(u, i)
  }) as any
  const plan = await w.planner.preview(w.ids.haproxy, { action: 'create', host: host(['rl.hpx.invalid']) }, actor)
  const r = await w.planner.apply(plan.id, actor)
  assert.equal(r.ok, false)
  assert.match(r.message, /reload after adding rl\.hpx\.invalid failed: haproxy exited\. HyperProx put the previous configuration back/)
  assert.equal(w.haproxy.rollbacks, 1)
  assert.equal((await w.service.hosts(w.ids.haproxy)).some(h => h.domains.includes('rl.hpx.invalid')), false)
})

// --- 9. the AI wizard through the service ---------------------------------------------------------------------

test('9: the wizard creates through preview/apply and attaches its certificate as a patch that keeps everything else', async () => {
  const w = await world()
  setProxyService(w.service)
  try {
    const { hostId } = await wizardCreateHost({ domains: ['wiz.hpx.invalid'], forwardScheme: 'http', forwardHost: '192.0.2.71', forwardPort: 3000, enabled: true, websockets: true,
      npm: { advanced_config: '# kept', caching_enabled: true } }, { email: 'owner@example.invalid' })
    w.npm1.certs.push({ id: 8, nice_name: 'wiz', domain_names: ['wiz.hpx.invalid'], expires_on: '2027-01-01 00:00:00', provider: 'letsencrypt', meta: {} })
    await wizardUpdateHost(hostId, { npm: { certificate_id: 8, ssl_forced: true, http2_support: true, hsts_enabled: true } }, { email: 'owner@example.invalid' })
    const h = w.npm1.hosts.find(x => String(x.id) === hostId)!
    assert.equal(h.certificate_id, 8)
    assert.equal(h.ssl_forced, true)
    assert.equal(h.advanced_config, '# kept')
    assert.equal(h.caching_enabled, true)
    assert.deepEqual(w.store.audits.filter(a => a.action.startsWith('proxy.host')).map(a => [a.action, (a.details as any).ok, (a.details as any).by]),
      [['proxy.host.create', true, 'owner@example.invalid'], ['proxy.host.update', true, 'owner@example.invalid']])
  } finally { setProxyService(null) }
})

test('9/12e: a certificate request carries the Let’s Encrypt email to NPM', async () => {
  const w = await world()
  await w.service.requestCertificate(LEGACY_NPM_ID, ['le.hpx.invalid'], 'certs@example.invalid', actor).catch(() => undefined)
  const post = w.npm1.log.find(l => l.method === 'POST' && l.path === '/nginx/certificates')!
  assert.deepEqual(post.body.meta, { letsencrypt_email: 'certs@example.invalid', letsencrypt_agree: true, dns_challenge: false })
})

// --- 10. URLs, redirects ------------------------------------------------------------------------------------------

test('10: loopback and link-local instance URLs are refused unless the instance is Managed', async () => {
  const w = await world()
  for (const url of ['http://127.0.0.1:2019', 'http://localhost:2019', 'http://[::1]:2019', 'http://169.254.169.254/', 'http://[fe80::1]:81', 'http://0.0.0.0:81', 'http://loop.example.invalid:81']) {
    await assert.rejects(w.service.createInstance({ kind: 'caddy', name: `x${url.length}`, url }, actor), /loopback or link-local/, url)
  }
  const m = await w.service.createInstance({ kind: 'caddy', name: 'managed loop', url: 'http://127.0.0.1:2019', mode: 'managed', managed: { node: 'node1', vmid: 9100 } }, actor)
  assert.equal(m.instance.url, 'http://127.0.0.1:2019')
  for (const a of ['127.0.0.5', '::ffff:127.0.0.1', '169.254.1.1', 'fe80::2']) assert.equal(isLocalAddress(a), true, a)
  for (const a of ['192.0.2.1', '10.0.0.1', '2001:db8::1']) assert.equal(isLocalAddress(a), false, a)
})

test('10: NPM’s sign-in is never redirected (the password is sent once, to the URL given)', async () => {
  const w = await world()
  clearNpmTokens()
  w.npm1.redirectTokens = true
  const h = await w.service.health(LEGACY_NPM_ID)
  assert.equal(h.ok, false)
  assert.match(h.checks[0].detail, /redirect \(307\); HyperProx does not follow it/)
  assert.equal(w.npm1.log.filter(l => l.path === '/tokens').length, 1)
  clearNpmTokens()
})

// --- 11. polling cost -----------------------------------------------------------------------------------------------

test('11: host lists are cached for 20 s per instance and cleared by a write; NPM signs in once', async () => {
  let now = 1_000_000
  const w = await world({ now: () => now })
  clearNpmTokens()
  await w.service.allHosts()
  const count = () => w.npm1.log.filter(l => l.method === 'GET' && l.path === '/nginx/proxy-hosts').length
  const n1 = count()
  await w.service.allHosts()
  assert.equal(count(), n1, 'served from the cache')
  now += 21_000
  await w.service.allHosts()
  assert.equal(count(), n1 + 1)
  await w.planner.apply((await w.planner.preview(LEGACY_NPM_ID, { action: 'create', host: host(['cache.hpx.invalid']) }, actor)).id, actor)
  assert.ok((await w.service.allHosts()).hosts.some(h => h.domains.includes('cache.hpx.invalid')), 'a write clears the cache')
  assert.equal(w.npm1.log.filter(l => l.path === '/tokens').length, 1, 'one sign-in for every client')
  clearNpmTokens()
  void NPMClient
})

test('11: one slow instance does not hold the table', async () => {
  const w = await world({ instanceTimeoutMs: 200 })
  const inner = w.caddy.fetch
  w.caddy.fetch = (async (u: string, i?: RequestInit) => { await new Promise(r => setTimeout(r, 1000)); return inner(u, i) }) as any
  const t0 = Date.now()
  const r = await w.service.allHosts()
  assert.ok(Date.now() - t0 < 900, 'did not wait for the slow one')
  assert.deepEqual(r.errors.map(e => [e.instanceName, e.error]), [['caddy', 'no answer within 0.2s']])
  assert.ok(r.hosts.some(h => h.kind === 'haproxy'))
})

test('11: an unchanged edit is refused, and no PUT is sent', async () => {
  const w = await world()
  fullHost(w)
  await assert.rejects(w.planner.preview(LEGACY_NPM_ID, { action: 'update', hostId: '50', host: { forwardPort: 8443, npm: { ssl_forced: true, certificate_id: 5 }, websockets: false } }, actor), /Nothing would change/)
  assert.equal(w.npm1.log.filter(l => l.method === 'PUT').length, 0)
})

// --- 12. ownership records, SSH re-trust, Managed targets, a locked vault ---------------------------------------------

test('12a: an hpx- route, backend or resource HyperProx has no record of making is read-only', async () => {
  const w = await world()
  w.caddy.config.apps.http.servers.srv0.routes.unshift({ '@id': 'hpx-hand-made', match: [{ host: ['hand.hpx.invalid'] }], handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '192.0.2.9:80' }] }] })
  const h = (await w.service.hosts(w.ids.caddy)).find(x => x.id.includes('hpx-hand-made'))!
  assert.equal(h.readOnly, true)
  await assert.rejects(w.planner.preview(w.ids.caddy, { action: 'delete', hostId: h.id }, actor), /read-only/)
  const r = await w.planner.apply((await w.planner.preview(w.ids.caddy, { action: 'create', host: host(['mine.hpx.invalid']) }, actor)).id, actor)
  assert.deepEqual((await w.store.get(w.ids.caddy))!.owned, [r.hostId])
  await w.planner.apply((await w.planner.preview(w.ids.caddy, { action: 'delete', hostId: r.hostId! }, actor)).id, actor)
  assert.deepEqual((await w.store.get(w.ids.caddy))!.owned, [])
})

test('12c: a new SSH address shows the key it offers and is trusted only when that key is sent back', async () => {
  const w = await world({ learnHostKey: async (h: string) => (h === '192.0.2.39' ? 'SHA256:new-server' : 'SHA256:fixture-host-key') })
  await assert.rejects(w.service.updateInstance(w.ids.traefik, { settings: { ssh_host: '192.0.2.39' } }, actor), /offers host key SHA256:new-server\. Nothing was saved\./)
  assert.equal((await w.store.get(w.ids.traefik))!.settings.ssh_host, '192.0.2.38')
  const v = await w.service.updateInstance(w.ids.traefik, { settings: { ssh_host: '192.0.2.39', ssh_host_key: 'SHA256:new-server' } }, actor)
  assert.equal(v.settings.ssh_host_key, 'SHA256:new-server')
})

test('12: the Settings NPM is listed as locked when its login cannot be read, not dropped', async () => {
  const locked = Object.assign(new Error('locked'), { name: 'VaultLockedError' })
  const w = await world({ legacyNpm: async () => { throw locked } })
  const list = await w.service.viewInstances()
  assert.deepEqual(list.filter(i => i.legacy).map(i => [i.id, i.status]), [['npm', 'locked']])
  const r = await w.service.allHosts()
  assert.match(r.errors.find(e => e.instanceId === 'npm')!.error, /locked/)
})

// --- final round: hosts made before this branch have locations: null ---------------------------------------------

test('locations: null (every host made before the provider layer) updates, keeps null, and sends no locations', async () => {
  const w = await world()
  w.npm1.hosts.push({ id: 70, created_on: 'x', modified_on: 'x', owner_user_id: 1, domain_names: ['old.hpx.invalid'], forward_scheme: 'http', forward_host: '192.0.2.62',
    forward_port: 80, access_list_id: 0, certificate_id: 0, ssl_forced: false, caching_enabled: false, block_exploits: true, advanced_config: '',
    meta: { nginx_online: true, nginx_err: null }, allow_websocket_upgrade: false, http2_support: false, enabled: true, locations: null,
    hsts_enabled: false, hsts_subdomains: false })
  const r = await w.planner.apply((await w.planner.preview(LEGACY_NPM_ID, { action: 'update', hostId: '70', host: { forwardPort: 81 } }, actor)).id, actor)
  assert.equal(r.ok, true, r.message)
  const h = w.npm1.hosts.find(x => x.id === 70)!
  assert.equal(h.forward_port, 81)
  assert.equal(h.locations, null)
  const put = w.npm1.log.filter(l => l.method === 'PUT').at(-1)!
  assert.equal('locations' in put.body, false)
})
