// The NGINX, Caddy and Envoy plug-ins: their readings parsed from output recorded on real installs (NGINX 1.31.8,
// Caddy 2.11.7, Envoy 1.40.2; names changed to .hpx.invalid), what each reading says is wrong and which fix it offers,
// auto-connect, and the rules every action keeps (offered now, confirmed, admin, audited).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Fastify from 'fastify'
import { parseCaddy, parseEnvoy, parseNginx, parseCerts, parseReach, sections, PROBES } from '../src/lib/webproxy/probes'
import { WebProxyService, WebProxyRefusal, assess, actionResult, tileRow, type Sighting, type WebProxyInstance } from '../src/lib/webproxy/service'
import { WEB_PROXY_RECIPES, NGINX_SCRIPT, CADDY_SCRIPT, ENVOY_SCRIPT, ENVOY_SHA256 } from '../src/lib/webproxy/recipes'
import { tileOf } from '../src/plugins/web-proxies'
import { PLUGINS } from '../src/plugins'
import { requiredRole } from '../src/lib/roles'
import { DETECT } from '../src/lib/catalogue-detect'
import { findRecipe, healthProblem } from '../src/lib/catalogue'
import { tokenForbidden } from '../src/lib/api-tokens'
import { installScript } from '../src/lib/install-script'
import type { Machine } from '../src/lib/remote/types'

const fx = (k: string) => readFileSync(join(__dirname, 'fixtures', 'webproxy', `${k}-probe.txt`), 'utf8')
// The recordings were taken on 2026-11-16 at about 03:35 UTC.
const AT = Date.parse('2026-11-16T03:45:00Z')

// ── parsing ─────────────────────────────────────────────────────────────────

test('NGINX: version, nginx -t, status page, sites, upstreams, the certificate and five minutes of traffic', () => {
  const r = parseNginx(fx('nginx'), AT)!
  assert.equal(r.version, '1.31.8')
  assert.equal(r.running, true)
  assert.equal(r.configOk, true)
  assert.deepEqual(r.status, { active: 1, accepts: 47, handled: 47, requests: 47, reading: 0, writing: 1, waiting: 0 })
  const shop = r.sites.find(s => s.names.includes('shop.hpx.invalid'))!
  assert.deepEqual([shop.ssl, shop.proxyPass, shop.certificate, shop.kind], [true, 'http://app_pool', '/etc/nginx/certs/shop.crt', 'proxy'])
  assert.ok(r.sites.find(s => s.names.includes('legacy-nginx.hpx.invalid'))?.proxyPass)
  assert.ok(r.sites.some(s => s.defaultServer), 'the default server is listed')
  assert.ok(r.sites.every(s => !s.names.includes('_')), 'the catch-all name is not a name')
  assert.deepEqual(r.upstreams.map(u => [u.name, u.servers]), [['app_pool', ['127.0.0.1:9000', '127.0.0.1:9999']]])
  assert.equal(r.certs.length, 1)
  assert.equal(r.certs[0].name, 'shop.hpx.invalid')
  assert.equal(r.certs[0].daysLeft, 19)
  assert.equal(r.certs[0].ending, true, 'a 20-day certificate is in its last 21 days')
  assert.deepEqual(r.traffic.byClass, { '1': 0, '2': 32, '3': 0, '4': 5, '5': 7 })
  assert.equal(r.traffic.total, 44)
  assert.equal(r.traffic.errorRate!.toFixed(3), (7 / 44).toFixed(3))
  assert.equal(r.certbot, false)
})

test('Caddy: unit, routes and their upstreams, Caddy’s counts with reach, a certificate, and the names still waiting', () => {
  const r = parseCaddy(fx('caddy'), AT)!
  assert.equal(r.version, '2.11.7')
  assert.deepEqual([r.unit, r.running, r.adminOk, r.persist], ['caddy-api', true, true, true])
  assert.deepEqual(r.servers, [{ name: 'srv0', listen: [':80', ':443'] }])
  assert.deepEqual(r.routes.find(x => x.hosts.includes('shop.hpx.invalid'))!.upstreams, ['127.0.0.1:9000', '127.0.0.1:9999'])
  assert.equal(r.routes.find(x => x.id === 'hpx-health')!.handler, 'static')
  assert.deepEqual(r.upstreams.map(u => [u.address, u.reachable]), [['127.0.0.1:9000', true], ['127.0.0.1:9999', false]])
  assert.equal(r.certs.length, 1)
  assert.equal(r.certs[0].name, 'shop.hpx.invalid', 'an internal certificate has no subject: named by its file')
  assert.match(r.certs[0].issuer!, /Caddy Local Authority/)
  assert.deepEqual(r.missingCerts, ['legacy-caddy.hpx.invalid'])
})

test('Envoy: state, listeners, clusters with each host’s health, and requests by class (the admin listener left out)', () => {
  const r = parseEnvoy(fx('envoy'))!
  assert.equal(r.version, '1.40.2')
  assert.deepEqual([r.running, r.adminOk, r.state, r.draining, r.admin], [true, true, 'LIVE', false, '127.0.0.1:9901'])
  assert.deepEqual(r.listeners, [{ name: 'http', address: '0.0.0.0:80' }])
  const app = r.clusters.find(c => c.name === 'app')!
  assert.deepEqual(app.hosts.map(h => h.address), ['127.0.0.1:9000', '127.0.0.1:9999'])
  assert.deepEqual(app.hosts.map(h => [h.healthy, h.flags]), [[true, []], [false, ['active health check']]])
  assert.deepEqual(app.hosts.map(h => [h.requests, h.errors]), [[30, 0], [0, 30]])
  assert.ok(r.requests.total > 0)
  assert.ok(r.requests.byClass['5'] > 0, 'the dead host’s 503s are counted')
  assert.ok(r.requests.byClass['2'] > 0)
  assert.deepEqual(r.dynamicFiles, ['/etc/envoy/dynamic/cds.yaml', '/etc/envoy/dynamic/lds.yaml'])
  assert.equal(r.unit, true)
})

test('a container without the proxy reads as missing; framing that does not decode is empty, not an exception', () => {
  for (const p of [parseNginx('===HPX:missing===\n', AT), parseCaddy('===HPX:missing===\n', AT), parseEnvoy('===HPX:missing===\n')]) assert.equal(p, null)
  assert.deepEqual(sections('===HPX:version===\nnot base64!\n'), { version: '' })
  assert.deepEqual(parseReach('a:1 up\nb:2 down\nnonsense\n'), { 'a:1': true, 'b:2': false })
  const c = parseCerts('/x.crt\tnotBefore=Nov  1 00:00:00 2026 GMT|notAfter=Nov 20 00:00:00 2026 GMT|subject=CN=a.hpx.invalid|\n/y.crt\tnotAfter=Jan  1 00:00:00 2026 GMT|subject=CN=b.hpx.invalid|\n', AT)
  // Three days left of a nineteen-day life is past its last quarter: it should have been renewed.
  assert.deepEqual(c.map(x => [x.name, x.expired, x.ending]), [['b.hpx.invalid', true, false], ['a.hpx.invalid', false, true]])
})

// ── what is wrong, and the fix for it ─────────────────────────────────────

test('every problem a reading shows carries a fix when one exists, and every fix is among the actions open now', () => {
  const n = parseNginx(fx('nginx'), AT)!
  const stopped = assess({ ...n, running: false, status: null, configOk: false, configMessage: 'nginx: [emerg] unknown directive' })
  const fixOf = (id: string) => stopped.problems.find(p => p.id === id)?.fix?.id
  assert.deepEqual([fixOf('stopped'), fixOf('status-page'), fixOf('config')], ['start', 'status-page', 'test'])
  assert.ok(!stopped.actions.some(a => a.id === 'reload'), 'no reload of a stopped NGINX')
  // A certificate certbot does not manage is shown, without a button that would not help.
  assert.equal(assess(n).problems.find(p => p.id.startsWith('cert:'))!.fix, undefined)
  assert.equal(assess({ ...n, certbot: true }).problems.find(p => p.id.startsWith('cert:'))!.fix!.id, 'renew')
  const c = parseCaddy(fx('caddy'), AT)!
  assert.equal(assess(c).problems.find(p => p.id === 'nocert:legacy-caddy.hpx.invalid')!.fix!.id, 'retry-certs')
  assert.equal(assess({ ...c, running: false }).problems[0].fix!.id, 'start')
  const e = parseEnvoy(fx('envoy'))!
  assert.deepEqual(assess(e).actions.map(a => a.id), ['drain', 'reload'])
  const drained = assess({ ...e, draining: true })
  assert.equal(drained.problems[0].fix!.id, 'undrain')
  assert.deepEqual(drained.actions.map(a => a.id), ['undrain', 'reload'])
  assert.deepEqual(assess({ ...e, dynamicFiles: [] }).actions.map(a => a.id), ['drain', 'restart'], 'static config: a restart, marked dangerous')
  assert.equal(assess({ ...e, dynamicFiles: [] }).actions[1].danger, true)
  for (const d of [n, c, e, { ...n, running: false, status: null }, { ...e, draining: true }]) {
    const a = assess(d as any)
    for (const p of a.problems) if (p.fix) assert.ok(a.actions.some(x => x.id === p.fix!.id) || p.fix.id === 'test', `${p.id}: its fix is open`)
  }
})

test('what an action printed becomes a plain answer; nginx’s [emerg] line is the reason given', () => {
  assert.deepEqual(actionResult('nginx', 'reload', 'HPX_REFUSED\nnginx: [emerg] unknown directive "x" in /etc/nginx/conf.d/a.conf:1\nnginx: configuration file /etc/nginx/nginx.conf test failed\n'),
    { ok: false, message: 'NGINX refused its configuration, so nothing was changed: [emerg] unknown directive "x" in /etc/nginx/conf.d/a.conf:1' })
  assert.equal(actionResult('nginx', 'test', 'ok\nHPX_RC=0\n').ok, true)
  assert.equal(actionResult('envoy', 'reload', 'HPX_REJECTED\n').ok, false)
  assert.equal(actionResult('caddy', 'retry-certs', 'HPX_HTTP=200\nHPX_DONE\n').ok, true)
  assert.equal(actionResult('caddy', 'reload', 'curl: (7) refused\n').ok, false)
})

// ── the service: auto-connect and actions ─────────────────────────────────

function world(o: { tags?: string[]; sightings?: Sighting[]; output?: Record<string, string>; excluded?: string[] } = {}) {
  const m: Machine = { id: 'lxc-9101', kind: 'lxc', name: 'edge-proxy', node: 'node1', vmid: 9101, running: true, tags: o.tags ?? [] }
  const rows = new Map<string, WebProxyInstance>()
  const audits: Array<[string, string, Record<string, unknown>]> = []
  const scripts: string[] = []
  const out = o.output ?? { nginx: fx('nginx'), caddy: fx('caddy'), envoy: fx('envoy') }
  const svc = new WebProxyService({
    store: { get: async id => rows.get(id) ?? null, put: async i => { rows.set(i.id, i) }, list: async () => [...rows.values()], delete: async id => { rows.delete(id) } },
    exec: {
      listMachines: async () => [m],
      run: async (_m, script) => {
        scripts.push(script)
        const kind = Object.keys(PROBES).find(k => (PROBES as any)[k] === script)
        if (kind) return { code: 0, output: out[kind] ?? '===HPX:missing===\n', timedOut: false }
        return { code: 0, output: 'HPX_DONE\n', timedOut: false }
      },
    },
    sightings: async () => o.sightings ?? [{ kind: 'nginx', vmid: 9101, via: 'catalogue' }],
    excluded: async () => o.excluded ?? [],
    audit: async (a, r, d) => { audits.push([a, r, d]) },
    dismissed: async () => {},
    now: () => AT,
  })
  const ctx = (dismissed: string[] = []) => ({ dismissed: (k: string) => dismissed.includes(k), autoConnectedBefore: () => false, excludedMachines: new Set(o.excluded ?? []), excludedSubnets: [], vaultItems: () => [], audit: async () => {}, now: () => AT })
  return { svc, rows, audits, scripts, ctx }
}
const admin = { email: 'admin@example.invalid', token: null }

test('auto-connect: a Catalogue install is connected by itself after a look inside, as the system, with its evidence', async () => {
  const w = world()
  const out = await w.svc.autoConnect('nginx', w.ctx() as any)
  assert.deepEqual(out.map(x => [x.key, x.did]), [['lxc-9101', 'connected']])
  assert.deepEqual(out[0].evidence, ['found by catalogue'])
  const [i] = await w.svc.instances('nginx')
  assert.equal(i.addedBy, 'system (auto-connect)')
  assert.deepEqual(w.audits[0].slice(0, 2), ['webproxy.nginx.auto_connect', 'webproxy:nginx:lxc-9101'])
  // A second pass: already there.
  assert.deepEqual((await w.svc.autoConnect('nginx', w.ctx() as any)).map(x => x.did), ['present'])
  // Another kind's sighting does not connect this kind.
  assert.deepEqual(await w.svc.autoConnect('caddy', w.ctx() as any), [])
})

test('auto-connect leaves alone: the ignore tag, the exclusion list, a disconnect, and a guest without the proxy', async () => {
  assert.deepEqual((await world({ tags: ['hyperprox-ignore'] }).svc.autoConnect('nginx', world().ctx() as any)).map(x => x.did), [])
  const ex = world({ excluded: ['lxc-9101'] })
  assert.deepEqual((await ex.svc.autoConnect('nginx', ex.ctx() as any)).map(x => x.did), [])
  const d = world()
  assert.deepEqual((await d.svc.autoConnect('nginx', d.ctx(['lxc-9101']) as any)).map(x => x.did), ['dismissed'])
  assert.equal(d.rows.size, 0)
  const none = world({ output: {}, sightings: [{ kind: 'envoy', vmid: 9101, via: 'detect' }] })
  const r = await none.svc.autoConnect('envoy', none.ctx() as any)
  assert.deepEqual([r[0].did, r[0].message], ['skipped', 'Envoy is not installed in edge-proxy.'])
  assert.equal(none.rows.size, 0)
})

test('an action runs only when confirmed and offered by a reading taken now; it is audited before and after', async () => {
  const w = world()
  await w.svc.autoConnect('nginx', w.ctx() as any)
  const [i] = await w.svc.instances('nginx')
  await assert.rejects(w.svc.act(i.id, 'reload', false, admin), (e: any) => e instanceof WebProxyRefusal && e.code === 'not_confirmed')
  await assert.rejects(w.svc.act(i.id, 'renew', true, admin), (e: any) => e.code === 'not_offered', 'no certbot here, so no renew')
  await assert.rejects(w.svc.act(i.id, 'rm -rf /', true, admin), (e: any) => e.code === 'bad_input')
  const before = w.scripts.length
  const r = await w.svc.act(i.id, 'reload', true, admin)
  assert.equal(r.ok, true)
  assert.equal(r.message, 'NGINX reloaded.')
  assert.ok(w.scripts.slice(before).some(s => s.includes('nginx -t') && s.includes('systemctl reload nginx')))
  assert.deepEqual(w.audits.filter(a => a[0] === 'webproxy.nginx.reload').map(a => [a[2].phase, a[2].by]), [['start', 'admin@example.invalid'], ['done', 'admin@example.invalid']])
})

test('a reading of an unreachable or excluded proxy says why instead of failing; the card shows it', async () => {
  const w = world()
  await w.svc.autoConnect('caddy', world({ sightings: [{ kind: 'caddy', vmid: 9101, via: 'detect' }] }).ctx() as any)
  const c = world({ sightings: [{ kind: 'caddy', vmid: 9101, via: 'detect' }] })
  await c.svc.autoConnect('caddy', c.ctx() as any)
  const [i] = await c.svc.instances('caddy')
  const ok = await c.svc.reading(i.id)
  assert.equal(tileRow(ok).tone, 'warn')
  assert.match(tileRow(ok).value, /No certificate yet for legacy-caddy/)
  const tagged = world({ tags: ['hyperprox-ignore'], sightings: [] })
  tagged.rows.set(i.id, { ...(await c.svc.instance(i.id)) })
  const r = await tagged.svc.reading(i.id)
  assert.equal(r.ok, false)
  assert.match(r.error!, /hyperprox-ignore/)
  assert.equal(tileRow(r).tone, 'bad')
  assert.equal(tileOf('Caddy', [tileRow(ok) as any]).tone, 'warn')
  assert.throws(() => tileOf('Envoy', []), /Not configured yet: HyperProx connects an Envoy/)
})

// ── the plug-ins, routes and roles ────────────────────────────────────────

test('the three plug-ins are bundled, read through their own transport and never take settings', () => {
  for (const id of ['nginx', 'caddy', 'envoy']) {
    const p = PLUGINS.find(x => x.manifest.id === id)!
    assert.equal(p.manifest.coreTransport, true)
    assert.deepEqual(p.manifest.settings, [])
  }
})

test('roles: reads are for any signed-in person; connecting, every action and disconnecting are admin', () => {
  for (const k of ['nginx', 'caddy', 'envoy']) {
    assert.equal(requiredRole('GET', `/api/plugins/${k}/instances`), 'viewer')
    assert.equal(requiredRole('GET', `/api/plugins/${k}/instances/0b0c0d0e-0000-4000-8000-000000000000`), 'viewer')
    assert.equal(requiredRole('POST', `/api/plugins/${k}/instances`), 'admin')
    assert.equal(requiredRole('POST', `/api/plugins/${k}/instances/0b0c0d0e-0000-4000-8000-000000000000/actions/reload`), 'admin')
    assert.equal(requiredRole('DELETE', `/api/plugins/${k}/instances/0b0c0d0e-0000-4000-8000-000000000000`), 'admin')
  }
})

test('routes: an API token cannot connect, act or disconnect; a fresh read and the found list are an admin’s', async () => {
  const { setWebProxyService } = await import('../src/lib/webproxy')
  const { webProxyRoutes } = await import('../src/routes/webproxy')
  const w = world()
  await w.svc.autoConnect('nginx', w.ctx() as any)
  const [i] = await w.svc.instances('nginx')
  setWebProxyService(w.svc)
  try {
    const as = (who: { role: string; token?: string }) => {
      const a = Fastify()
      a.addHook('onRequest', async req => { (req as any).session = { role: who.role, email: 'admin@example.invalid' }; if (who.token) (req as any).apiToken = { name: who.token } })
      return a.register(webProxyRoutes('nginx'), { prefix: '/n' }).then(() => a)
    }
    const token = await as({ role: 'admin', token: 'nightly' })
    for (const [method, url, payload] of [['POST', '/n/instances', { machineId: 'lxc-9101' }], ['POST', `/n/instances/${i.id}/actions/reload`, { confirm: true }], ['DELETE', `/n/instances/${i.id}`, undefined]] as const) {
      const r = await token.inject({ method, url, payload: payload as any })
      assert.equal(r.statusCode, 403, `${method} ${url}`)
      assert.equal(r.json().code, 'token_forbidden')
      assert.match(r.json().error, /An API token cannot connect, act on or disconnect a proxy/)
    }
    assert.equal(w.audits.filter(a => a[0] === 'webproxy.nginx.reload').length, 0, 'nothing ran')
    assert.equal(w.rows.size, 1, 'nothing was disconnected')
    // Reads stay open to a token, as every read is.
    assert.equal((await token.inject({ url: '/n/instances' })).statusCode, 200)
    // A viewer's ?fresh=1 is served from the last reading: no script runs in the guest for it.
    const viewer = await as({ role: 'viewer' })
    await w.svc.reading(i.id)
    const before = w.scripts.length
    assert.equal((await viewer.inject({ url: `/n/instances/${i.id}?fresh=1` })).statusCode, 200)
    assert.equal(w.scripts.length, before)
    const admin = await as({ role: 'admin' })
    await admin.inject({ url: `/n/instances/${i.id}?fresh=1` })
    assert.equal(w.scripts.length, before + 1)
    // What was found but not connected is an admin's list (names and container ids of guests).
    const found = world({ sightings: [{ kind: 'nginx', vmid: 9101, via: 'catalogue' }] })
    setWebProxyService(found.svc)
    assert.equal((await viewer.inject({ url: '/n/instances' })).json().data.found.length, 0)
    assert.equal((await admin.inject({ url: '/n/instances' })).json().data.found.length, 1)
  } finally { setWebProxyService(null) }
})

test('tokenForbidden refuses connecting, actions and disconnecting on the three plug-ins, and nothing else of theirs', () => {
  for (const k of ['nginx', 'caddy', 'envoy']) {
    assert.equal(tokenForbidden('POST', `/api/plugins/${k}/instances`), true)
    assert.equal(tokenForbidden('POST', `/api/plugins/${k}/instances/0b0c0d0e-0000-4000-8000-000000000000/actions/reload`), true)
    assert.equal(tokenForbidden('DELETE', `/api/plugins/${k}/instances/0b0c0d0e-0000-4000-8000-000000000000`), true)
    assert.equal(tokenForbidden('GET', `/api/plugins/${k}/instances`), false)
    assert.equal(tokenForbidden('GET', `/api/plugins/${k}/data`), false)
  }
})

test('readings taken at the same moment share one look inside the guest', async () => {
  const e = world({ sightings: [{ kind: 'envoy', vmid: 9101, via: 'detect' }] })
  await e.svc.autoConnect('envoy', e.ctx() as any)
  const [i] = await e.svc.instances('envoy')
  const before = e.scripts.length
  const [a, b, c] = await Promise.all([e.svc.reading(i.id, true), e.svc.reading(i.id, true), e.svc.reading(i.id)])
  assert.equal(e.scripts.length, before + 1)
  assert.ok(a === b && b === c)
})

test('routes: an unconfirmed action is refused in words; another kind’s proxy is not found under this one', async () => {
  const { setWebProxyService } = await import('../src/lib/webproxy')
  const { webProxyRoutes } = await import('../src/routes/webproxy')
  const w = world()
  await w.svc.autoConnect('nginx', w.ctx() as any)
  const [i] = await w.svc.instances('nginx')
  setWebProxyService(w.svc)
  try {
    const a = Fastify()
    await a.register(webProxyRoutes('nginx'), { prefix: '/n' })
    await a.register(webProxyRoutes('caddy'), { prefix: '/c' })
    const list = (await a.inject({ url: '/n/instances' })).json()
    assert.equal(list.data.readings.length, 1)
    assert.equal(list.data.readings[0].detail.version, '1.31.8')
    const r = await a.inject({ method: 'POST', url: `/n/instances/${i.id}/actions/reload`, payload: {} })
    assert.equal(r.statusCode, 409)
    assert.match(r.json().error, /Confirm the action first/)
    assert.equal((await a.inject({ method: 'POST', url: `/n/instances/${i.id}/actions/reload`, payload: { confirm: true } })).json().data.ok, true)
    assert.equal((await a.inject({ url: `/c/instances/${i.id}` })).statusCode, 404)
  } finally { setWebProxyService(null) }
})

// ── recipes ───────────────────────────────────────────────────────────────

test('recipes: pinned versions from the projects’ own sources, keys and downloads checked, admin on loopback, no Docker', () => {
  assert.deepEqual(WEB_PROXY_RECIPES.map(r => [r.id, r.category, r.needsDocker, r.registersProxy ?? null]),
    [['nginx', 'proxy', false, 'nginx'], ['caddy', 'proxy', false, 'caddy'], ['envoy', 'proxy', false, null]])
  assert.match(NGINX_SCRIPT, /apt-get install -y -qq "nginx=1\.31\.8-1~trixie"/)
  assert.match(NGINX_SCRIPT, /https:\/\/nginx\.org\/packages\/mainline\/debian trixie nginx/)
  assert.match(NGINX_SCRIPT, /hpx_key https:\/\/nginx\.org\/keys\/nginx_signing\.key 573BFD6B3D8FBC641079A6ABABF5BD827BD9BF62 /)
  assert.match(NGINX_SCRIPT, /listen 127\.0\.0\.1:8081;/)
  assert.match(CADDY_SCRIPT, /apt-get install -y -qq "caddy=2\.11\.7"/)
  assert.match(CADDY_SCRIPT, /hpx_key https:\/\/dl\.cloudsmith\.io\/public\/caddy\/stable\/gpg\.key 65760C51EDEA2017CEA2CA15155B6D79CA56EA34/)
  assert.match(CADDY_SCRIPT, /"admin":\{"listen":"127\.0\.0\.1:2019"\}/)
  assert.match(CADDY_SCRIPT, /systemctl enable caddy-api/)
  assert.match(ENVOY_SCRIPT, /releases\/download\/v1\.40\.2\/envoy-1\.40\.2-linux-\$a/)
  assert.match(ENVOY_SCRIPT, new RegExp(`sum=${ENVOY_SHA256.amd64}`))
  assert.match(ENVOY_SCRIPT, /sha256sum -c --quiet -/)
  assert.match(ENVOY_SCRIPT, /address: 127\.0\.0\.1, port_value: 9901/)
  for (const s of [NGINX_SCRIPT, CADDY_SCRIPT, ENVOY_SCRIPT]) {
    assert.doesNotMatch(s, /latest|docker/i)
    assert.match(s, /VERSION_CODENAME" != trixie/)
    assert.doesNotMatch(s, /\$\{/, 'no shell ${...} left for JavaScript to have eaten')
  }
  for (const r of WEB_PROXY_RECIPES) {
    assert.equal(r.healthPath, '/hpx-healthz')
    assert.ok(r.detect?.length, `${r.id} can be detected`)
    // The script the installer builds: set -e first, the generated secret exported only for a proxy that registers.
    const s = installScript(findRecipe(r.id)!, 'debian', r.registersProxy ? { HPX_PROXY_SECRET: 'x'.repeat(20) } : {})
    assert.equal(s.split('\n')[0], 'set -e')
  }
})

test('each recipe’s health check passes on the answer its real install gave, and fails on a wrong one', () => {
  // Recorded from the test installs: NGINX and Caddy answer "ok"; Envoy's health-check filter answers 200 with no body.
  const real: Record<string, { status: number; body: string }> = { nginx: { status: 200, body: 'ok\n' }, caddy: { status: 200, body: 'ok\n' }, envoy: { status: 200, body: '' } }
  for (const r of WEB_PROXY_RECIPES) {
    assert.equal(healthProblem(r, real[r.id].status, real[r.id].body), null, r.id)
    assert.notEqual(healthProblem(r, 503, ''), null, `${r.id}: a drained or broken proxy is not serving`)
    assert.notEqual(healthProblem(r, null), null)
  }
  assert.notEqual(healthProblem(findRecipe('nginx')!, 200, '<html>Welcome</html>'), null, 'another page at that path is not the Catalogue’s NGINX')
})

test('the repository key check refuses a key file with a key nobody listed', () => {
  assert.match(NGINX_SCRIPT, /hpx_key https:\/\/nginx\.org\/keys\/nginx_signing\.key 573BFD6B3D8FBC641079A6ABABF5BD827BD9BF62 \S+ 8540A6F1[0-9A-F]+ 573BFD6B[0-9A-F]+ 9E9BE90E[0-9A-F]+$/m)
  assert.match(CADDY_SCRIPT, /holds a key HyperProx does not know/)
  assert.match(ENVOY_SCRIPT, /CapabilityBoundingSet=CAP_NET_BIND_SERVICE\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes/)
})

test('detection: Caddy and Envoy by their Server header, NGINX only by the health answer the Catalogue’s NGINX gives', () => {
  const a = (headers: Record<string, string>, body = '', status = 200) => ({ status, headers, body })
  assert.deepEqual(DETECT.caddy[0].match(a({ server: 'Caddy' })), { version: null })
  assert.equal(DETECT.caddy[0].match(a({ server: 'nginx' })), null)
  assert.deepEqual(DETECT.envoy[0].match(a({ server: 'envoy' }, '', 404)), { version: null })
  assert.deepEqual(DETECT.nginx[0].match(a({ server: 'nginx/1.31.8' }, 'ok\n')), { version: '1.31.8' })
  assert.equal(DETECT.nginx[0].match(a({ server: 'nginx/1.31.8' }, '<html>404</html>', 404)), null, 'any other nginx is not taken for a proxy')
  assert.equal(DETECT.nginx[0].path, '/hpx-healthz')
})
