// Provider-specific rules beyond the shared contract: HAProxy validates before reload and re-checks after,
// Traefik never overwrites a file it did not write, Caddy reports persistence, Pangolin's one-name rule,
// instance validation, plan expiry and ownership, the Managed file transport, the inventory hook.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProxyPlanner } from '../src/lib/proxy/plans'
import { LEGACY_NPM_ID } from '../src/lib/proxy/service'
import { checkHostname, parseHostSpec } from '../src/lib/proxy/spec'
import { hostsInRule, TRAEFIK_HEADER } from '../src/lib/proxy/providers/traefik'
import { hostsInCond } from '../src/lib/proxy/providers/haproxy'
import { GuestFileTransport } from '../src/lib/proxy/transport'
import { setProxyService, inventoryHosts } from '../src/lib/proxy'
import { fixtureWorld } from './fakes/proxy-world'

const actor = { email: 'admin@example.invalid' }
const host = (domains: string[], port = 9000) => ({ domains, forwardScheme: 'http', forwardHost: '192.0.2.50', forwardPort: port, enabled: true })

async function world() {
  const w = fixtureWorld()
  const add = async (kind: string, name: string, url: string, settings: Record<string, string>, secrets: Record<string, string>) =>
    (await w.service.createInstance({ kind, name, url, settings, secrets }, actor)).instance.id
  const ids = {
    traefik: await add('traefik', 'traefik', 'http://192.0.2.38:8282', { api_user: 'hpx', file: '/etc/traefik/dynamic/hyperprox.yml', ssh_host: '192.0.2.38', ssh_user: 'hpx' }, { api_password: 'traefik-test-password', ssh_password: 'x' }),
    caddy: await add('caddy', 'caddy', 'http://192.0.2.38:2019', {}, {}),
    haproxy: await add('haproxy', 'haproxy', 'http://192.0.2.38:5555', { user: 'hpx' }, { password: 'haproxy-test-password' }),
    pangolin: await add('pangolin', 'pangolin', 'http://192.0.2.39:3003/v1', { org_id: 'hpx-test' }, { api_key: 'pangolin-test-key' }),
  }
  return { ...w, ids, planner: new ProxyPlanner(w.service) }
}

// --- HAProxy -----------------------------------------------------------------------------------------------

test('HAProxy: a configuration haproxy -c rejects is never committed; the transaction is deleted', async () => {
  const w = await world()
  w.haproxy.rejectIf = '192.0.2.66'
  const before = { version: w.haproxy.version, state: JSON.stringify(w.haproxy.state) }
  const plan = await w.planner.preview(w.ids.haproxy, { action: 'create', host: { ...host(['bad.hpx.invalid']), forwardHost: '192.0.2.66' } }, actor)
  const rej = await w.planner.apply(plan.id, actor)
  assert.equal(rej.ok, false)
  assert.equal(rej.cleanup, undefined, 'nothing was made, so there is nothing to clean up')
  assert.match(rej.message, /nothing was made .*HAProxy rejected the new configuration .* nothing was applied\. .*bad server/)
  assert.equal(w.haproxy.validations, 1)
  assert.equal(w.haproxy.version, before.version)
  assert.equal(JSON.stringify(w.haproxy.state), before.state)
  assert.equal(w.haproxy.tx.size, 0, 'the transaction was deleted')
  assert.equal(w.haproxy.reloadCount, 0, 'no reload')
  // Nothing was left half-done: the next valid change goes through.
  const ok = await w.planner.apply((await w.planner.preview(w.ids.haproxy, { action: 'create', host: host(['ok.hpx.invalid']) }, actor)).id, actor)
  assert.equal(ok.ok, true, ok.message)
})

test('HAProxy: validation runs before the commit, and a reload that loses a frontend is an error', async () => {
  const w = await world()
  const order: string[] = []
  const inner = w.haproxy.fetch
  w.haproxy.fetch = (async (u: string, i?: RequestInit) => {
    const url = new URL(u)
    if (url.searchParams.get('only_validate')) order.push('validate')
    if (i?.method === 'PUT' && /\/transactions\//.test(url.pathname)) order.push('commit')
    if (/\/reloads\//.test(url.pathname)) order.push('reload-status')
    return inner(u, i)
  }) as any
  const r = await w.planner.apply((await w.planner.preview(w.ids.haproxy, { action: 'create', host: host(['order.hpx.invalid']) }, actor)).id, actor)
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(order, ['validate', 'commit', 'reload-status'])
  w.haproxy.dropFrontendsOnCommit = true
  const plan = await w.planner.preview(w.ids.haproxy, { action: 'disable', hostId: r.hostId! }, actor)
  await assert.rejects(w.planner.apply(plan.id, actor), /no longer has frontend\(s\) http/)
})

test('HAProxy: Host conditions are parsed; others are shown without names', () => {
  assert.deepEqual(hostsInCond('{ req.hdr(host),field(1,:) -i a.example.invalid b.example.invalid }'), ['a.example.invalid', 'b.example.invalid'])
  assert.deepEqual(hostsInCond('{ hdr(host) -i A.example.invalid }'), ['a.example.invalid'])
  assert.deepEqual(hostsInCond('is_api'), [])
})

// --- Traefik -----------------------------------------------------------------------------------------------

test('Traefik: a file HyperProx did not write is never overwritten', async () => {
  const w = await world()
  w.files.files.set('/etc/traefik/dynamic/hyperprox.yml', 'http:\n  routers: {}\n')
  const health = await w.service.health(w.ids.traefik)
  assert.equal(health.ok, false)
  assert.match(health.checks.find(c => c.name === 'file')!.detail, /not written by HyperProx/)
  const plan = await w.planner.preview(w.ids.traefik, { action: 'create', host: host(['t.hpx.invalid']) }, actor)
  const r = await w.planner.apply(plan.id, actor)
  assert.equal(r.ok, false)
  assert.match(r.message, /not written by HyperProx/)
  assert.equal(w.files.files.get('/etc/traefik/dynamic/hyperprox.yml'), 'http:\n  routers: {}\n')
  assert.equal(w.files.writes, 0)
})

test('Traefik: the file carries the header, routers and services; disabling adds the deny middleware', async () => {
  const w = await world()
  const r = await w.planner.apply((await w.planner.preview(w.ids.traefik, { action: 'create', host: host(['t.hpx.invalid', 'u.hpx.invalid']) }, actor)).id, actor)
  assert.equal(r.ok, true, r.message)
  const text = w.files.files.get('/etc/traefik/dynamic/hyperprox.yml')!
  assert.ok(text.startsWith(TRAEFIK_HEADER))
  assert.match(text, /Host\(`t\.hpx\.invalid`\) \|\| Host\(`u\.hpx\.invalid`\)/)
  assert.match(text, /url: http:\/\/192\.0\.2\.50:9000/)
  await w.planner.apply((await w.planner.preview(w.ids.traefik, { action: 'disable', hostId: r.hostId! }, actor)).id, actor)
  assert.match(w.files.files.get('/etc/traefik/dynamic/hyperprox.yml')!, /hpx-disabled:\n\s+ipAllowList/)
  assert.deepEqual(hostsInRule('Host(`a.example.invalid`) && PathPrefix(`/x`) || Host(`b.example.invalid`, `c.example.invalid`)'), ['a.example.invalid', 'b.example.invalid', 'c.example.invalid'])
})

// --- Caddy -------------------------------------------------------------------------------------------------

test('Caddy: HyperProx routes go first, the hand-made route is kept byte for byte, persistence is reported', async () => {
  const w = await world()
  const original = JSON.stringify(w.caddy.config.apps.http.servers.srv0.routes[0])
  const r = await w.planner.apply((await w.planner.preview(w.ids.caddy, { action: 'create', host: host(['c.hpx.invalid']) }, actor)).id, actor)
  assert.equal(r.ok, true, r.message)
  const routes = w.caddy.config.apps.http.servers.srv0.routes
  assert.equal(routes[0]['@id'], r.hostId)
  assert.equal(JSON.stringify(routes[1]), original)
  assert.equal((await w.service.health(w.ids.caddy)).checks.find(c => c.name === 'persist')!.ok, true)
  w.caddy.persist = false
  const h = await w.service.health(w.ids.caddy)
  const p = h.checks.find(c => c.name === 'persist')!
  assert.equal(p.ok, false)
  assert.match(p.detail, /restart loses every change/)
})

// --- Pangolin ----------------------------------------------------------------------------------------------

test('Pangolin: one name per host, under one of the organisation’s domains', async () => {
  const w = await world()
  await assert.rejects(w.planner.preview(w.ids.pangolin, { action: 'create', host: host(['a.hpx.invalid', 'b.hpx.invalid']) }, actor), /one name each/)
  const plan = await w.planner.preview(w.ids.pangolin, { action: 'create', host: host(['a.other.invalid']) }, actor)
  const r = await w.planner.apply(plan.id, actor)
  assert.equal(r.ok, false)
  assert.match(r.message, /under none of this Pangolin organisation's domains \(hpx\.invalid\)/)
  assert.equal(w.pangolin.resources.length, 1)
})

// --- instances, plans, specs ----------------------------------------------------------------------------------

test('instances: bad input is refused with the reason; the legacy NPM is managed in Settings', async () => {
  const w = await world()
  const bad = async (input: any, re: RegExp) => assert.rejects(w.service.createInstance(input, actor), re)
  await bad({ kind: 'nginx', name: 'x', url: 'http://192.0.2.1' }, /kind is one of/)
  await bad({ kind: 'caddy', name: 'x', url: 'ftp://192.0.2.1' }, /must start with http/)
  await bad({ kind: 'caddy', name: 'x', url: 'http://u:p@192.0.2.1' }, /not in the URL/)
  await bad({ kind: 'haproxy', name: 'x', url: 'http://192.0.2.1:5555', settings: { user: 'a' } }, /Data Plane password is required/)
  await bad({ kind: 'traefik', name: 'x', url: 'http://192.0.2.1', settings: { ssh_host: 'h', ssh_user: 'u' } }, /SSH password or a private key/)
  await bad({ kind: 'caddy', name: 'caddy', url: 'http://192.0.2.1' }, /exists/)
  await bad({ kind: 'caddy', name: 'm', url: 'http://192.0.2.1', mode: 'managed' }, /needs its container/)
  await bad({ kind: 'caddy', name: 'm', url: 'http://192.0.2.1', mode: 'managed', managed: { node: 'node1', vmid: 9404 } }, /is a VM/)
  await bad({ kind: 'caddy', name: 'm', url: 'http://192.0.2.1', mode: 'managed', managed: { node: 'node1', vmid: 9405 } }, /not running/)
  await bad({ kind: 'caddy', name: 'm', url: 'http://192.0.2.1', mode: 'managed', managed: { node: 'node9', vmid: 9406 } }, /not found/)
  await assert.rejects(w.service.deleteInstance(LEGACY_NPM_ID, actor), /Settings → Proxy/)
  await assert.rejects(w.service.updateInstance(LEGACY_NPM_ID, { name: 'x' }, actor), /Settings → Proxy/)
  await assert.rejects(w.service.getInstance('../../etc'), /no proxy instance/)
  const m = await w.service.createInstance({ kind: 'caddy', name: 'managed caddy', url: 'http://192.0.2.38:2019', mode: 'managed', managed: { node: 'node1', vmid: 9999, recipe: 'caddy' } }, actor)
  assert.deepEqual((await w.service.managedInstances()).map(i => i.managed), [{ node: 'node1', vmid: 9999, recipe: 'caddy' }])
  await w.service.deleteInstance(m.instance.id, actor)
  assert.deepEqual(w.store.audits.map(a => a.action).filter(a => a.startsWith('proxy.instance')).slice(-2), ['proxy.instance.create', 'proxy.instance.delete'])
  assert.equal(JSON.stringify(w.store.audits).includes('haproxy-test-password'), false)
})

test('plans: single use, expire after ten minutes, and belong to whoever previewed them', async () => {
  const w = await world()
  let now = Date.parse('2026-11-04T12:00:00Z')
  const planner = new ProxyPlanner(w.service, () => now)
  const p1 = await planner.preview(w.ids.caddy, { action: 'create', host: host(['e.hpx.invalid']) }, actor)
  await assert.rejects(planner.apply(p1.id, { email: 'someone-else@example.invalid' }), /belongs to someone else/)
  now += 11 * 60_000
  await assert.rejects(planner.apply(p1.id, actor), /expired/)
  assert.equal(planner.size, 0)
  await assert.rejects(planner.preview(w.ids.caddy, { action: 'frobnicate' as any }, actor), /action is/)
})

test('specs: names are checked and normalised; forward targets too', () => {
  assert.equal(checkHostname(' Test-A.Example.Invalid. '), 'test-a.example.invalid')
  for (const bad of ['*.example.invalid', 'localhost', 'a..b', '-a.example.invalid', 'http://x.example.invalid']) assert.throws(() => checkHostname(bad))
  assert.throws(() => parseHostSpec({ domains: ['a.example.invalid'], forwardHost: '192.0.2.1', forwardPort: 70000 }), /1 to 65535/)
  assert.throws(() => parseHostSpec({ domains: ['a.example.invalid'], forwardHost: '192.0.2.1;rm -rf', forwardPort: 80 }), /not a hostname or IP/)
  assert.throws(() => parseHostSpec({ domains: ['a.example.invalid'], forwardScheme: 'gopher', forwardHost: '192.0.2.1', forwardPort: 80 }), /http or https/)
  const s = parseHostSpec({ domains: 'a.example.invalid, b.example.invalid', forwardHost: '2001:db8::1', forwardPort: '8080', junk: 1 })
  assert.deepEqual(s.domains, ['a.example.invalid', 'b.example.invalid'])
  assert.equal(s.forwardPort, 8080)
  assert.equal((s as any).junk, undefined)
})

// --- the Managed transport -----------------------------------------------------------------------------------

test('guest transport: the scripts it sends read and replace a file, in a real shell', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-guest-'))
  try {
    const exec = async (script: string) => {
      try { return { code: 0, output: execFileSync('bash', ['-c', script], { encoding: 'utf8' }) } }
      catch (e: any) { return { code: e.status ?? 1, output: String(e.stdout ?? '') } }
    }
    const t = new GuestFileTransport(exec, 'test')
    const f = path.join(dir, "dyn 'quoted'.yml")
    assert.equal(await t.read(f), null)
    const text = `${TRAEFIK_HEADER}\nhttp:\n  routers:\n    a: { rule: "Host(\`x\`)" }\n$HOME 'single' "double" \\ back\n`
    await t.write(f, text)
    assert.equal(fs.readFileSync(f, 'utf8'), text)
    assert.equal(await t.read(f), text)
    assert.deepEqual(fs.readdirSync(dir), ["dyn 'quoted'.yml"], 'no temporary file left behind')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// --- the certificate inventory hook ----------------------------------------------------------------------------

test('inventory hook: every instance’s hosts, certificate ids only from the NPM whose certificates are listed', async () => {
  const w = await world()
  w.npm1.hosts[0].certificate_id = 7
  w.npm1.certs.push({ id: 7, nice_name: 'x', domain_names: ['legacy-npm1.hpx.invalid'], expires_on: '2027-01-01 00:00:00', provider: 'letsencrypt', meta: {} })
  await w.planner.apply((await w.planner.preview(w.ids.caddy, { action: 'create', host: host(['inv.hpx.invalid']) }, actor)).id, actor)
  setProxyService(w.service)
  try {
    const rows = await inventoryHosts()
    assert.ok(rows.some(r => r.domain_names.includes('inv.hpx.invalid') && r.certificate_id === null))
    assert.ok(rows.some(r => r.domain_names.includes('legacy-npm1.hpx.invalid') && r.certificate_id === 7))
    assert.ok(rows.some(r => r.domain_names.includes('legacy-traefik.hpx.invalid')))
  } finally { setProxyService(null) }
})

// --- Managed recipes (not wired into the Catalogue yet; the integrator adds the hook) -------------------------

test('managed recipes: compose files parse, the secret goes only where it is checked, the instance they register is valid', async () => {
  const { managedProxyRecipe, managedProxyFiles, managedInstanceInput, managedSecret } = await import('../src/lib/proxy/managed-recipes')
  const yaml = require('js-yaml')
  const secret = managedSecret()
  for (const kind of ['traefik', 'caddy', 'haproxy'] as const) {
    const r = managedProxyRecipe(kind, secret)
    assert.equal(r.install.kind, 'compose')
    const doc = yaml.load((r.install as any).compose)
    assert.ok(Object.keys(doc.services).length === 1)
    assert.equal((r.install as any).compose.includes(secret), false, 'no secret in the compose file')
  }
  const t = managedProxyFiles('traefik', secret)
  assert.equal(Object.values(t).join('').includes(secret), false, 'Traefik gets a hash, not the secret')
  assert.ok(yaml.load(Object.values(t)[0]).http.middlewares['api-auth'].basicAuth.users[0].startsWith('hyperprox:{SHA}'))
  assert.ok(managedProxyFiles('haproxy', secret)['/opt/haproxy/cfg/dataplaneapi.yml'].includes(`password: ${secret}`))
  assert.throws(() => managedProxyFiles('haproxy', 'short'), /16 URL-safe/)
  const w = await world()
  for (const kind of ['caddy', 'haproxy', 'traefik'] as const) {
    const input = managedInstanceInput(kind, { name: `managed ${kind}`, ip: '192.0.2.70', node: 'node1', vmid: 9100, secret })
    const r = await w.service.createInstance(input, actor)
    assert.equal(r.instance.mode, 'managed')
    assert.deepEqual(r.instance.managed, { node: 'node1', vmid: 9100, recipe: kind })
  }
})
