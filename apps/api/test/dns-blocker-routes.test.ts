// The DNS blocker routes and their gate rules: who may read what (a viewer sees no per-device numbers, no address, no
// guest), which role each action needs and whether it asks for the master password again (so an API token is kept out),
// a blocker that is down is a normal answer, and removing an auto-connected one is remembered. The service is the real one
// over fakes; nothing real is contacted.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { dnsBlockerRoutes } from '../src/lib/dns-blocker/routes'
import { setDnsBlockerService } from '../src/lib/dns-blocker'
import { DnsBlockerService } from '../src/lib/dns-blocker/service'
import { DnsInstanceStore, type CredentialIO } from '../src/lib/dns-blocker/instances'
import { needsReconfirm, requiredRole, tokenPluginScope } from '../src/lib/roles'
import { setAuditSink } from '../src/lib/audit'
import { ADGUARD_PASSWORD, ADGUARD_USER, FakeAdguard, FakePihole, NOW, PIHOLE_PASSWORD } from './fakes/dns-blocker'

function memIO(): CredentialIO {
  const mem = new Map<string, string>()
  return {
    get: async (c, p, k) => mem.get(`${c}/${p}/${k}`) ?? null,
    set: async (c, p, k, v) => { mem.set(`${c}/${p}/${k}`, v) },
    remove: async (c, p) => { for (const k of [...mem.keys()]) if (k.startsWith(`${c}/${p}/`)) mem.delete(k) },
  }
}

const audits: Array<{ action: string; details: any }> = []
const dismissed: Array<[string, string]> = []
let fake: FakePihole | FakeAdguard

async function build(kind: 'pihole' | 'adguard' = 'pihole'): Promise<{ app: FastifyInstance; id: string; svc: DnsBlockerService }> {
  setAuditSink({ write: async r => { audits.push({ action: r.action, details: r.details ?? {} }) } })
  fake = kind === 'pihole' ? new FakePihole() : new FakeAdguard()
  const svc = new DnsBlockerService({
    kind, store: new DnsInstanceStore(kind, memIO()), audit: async (action, _r, details) => { audits.push({ action, details }) },
    http: () => fake, probe: async () => ({ ok: true, ms: 4 }), resolve: async u => u.hostname, now: () => NOW, sleep: async () => {},
    dismissed: async (key, label) => { dismissed.push([key, label]) },
    guests: async () => [{ kind: 'lxc', vmid: 411, name: 'dns-box', node: 'n1', running: true, ignored: false }],
  })
  setDnsBlockerService(kind, svc)
  const app = Fastify({ logger: false })
  // Stands in for the gate: who is asking comes from headers.
  app.addHook('onRequest', async req => {
    const role = String(req.headers['x-role'] ?? '')
    if (role) (req as any).session = { role, email: `${role}@example.test`, sid: `sid-${role}` }
    if (req.headers['x-token']) (req as any).apiToken = { name: String(req.headers['x-token']) }
  })
  await app.register(dnsBlockerRoutes(kind), { prefix: `/api/plugins/${kind}` })
  const admin = { sid: 'a', email: 'admin@example.test', role: 'admin' as const, token: null }
  const meta = await svc.add({ name: 'Home DNS', url: 'http://192.0.2.10', guest: { kind: 'lxc', vmid: 411 }, ...(kind === 'adguard' ? { username: ADGUARD_USER, password: ADGUARD_PASSWORD } : { password: PIHOLE_PASSWORD }) }, admin)
  return { app, id: meta.id, svc }
}
afterEach(() => { setAuditSink(null); audits.length = 0; dismissed.length = 0; setDnsBlockerService('pihole', null); setDnsBlockerService('adguard', null) })

const as = (role: string, extra: Record<string, string> = {}) => ({ 'x-role': role, ...extra })

test('the instance list: a viewer sees names, an operator the guest, only an admin the address', async () => {
  const { app } = await build()
  const get = async (role: string) => (await app.inject({ method: 'GET', url: '/api/plugins/pihole/instances', headers: as(role) })).json().data[0]
  const v = await get('viewer'), o = await get('operator'), a = await get('admin')
  assert.deepEqual(Object.keys(v).sort(), ['addedAt', 'hasPassword', 'held', 'hideClients', 'id', 'kind', 'name'])
  assert.deepEqual(o.guest, { kind: 'lxc', vmid: 411 }); assert.equal(o.url, undefined)
  assert.equal(a.url, 'http://192.0.2.10')
  for (const x of [v, o, a]) assert.ok(!JSON.stringify(x).includes(PIHOLE_PASSWORD), 'no password in any view')
})

test('the reading: an operator sees the devices, a viewer does not', async () => {
  const { app, id } = await build()
  const read = async (role: string) => (await app.inject({ method: 'GET', url: `/api/plugins/pihole/instances/${id}/reading`, headers: as(role) })).json().data
  const op = await read('operator'), vw = await read('viewer')
  assert.equal(op.ok, true); assert.ok(op.reading.clients.length >= 1); assert.equal(op.reading.clientsHidden, false)
  assert.equal(vw.reading.clients, null); assert.equal(vw.reading.clientsHidden, true)
  assert.equal(vw.reading.totals.queries, op.reading.totals.queries, 'the totals are the same')
  assert.ok(!JSON.stringify(vw).includes('192.0.2.205'), 'no device address reaches a viewer')
})

test('a blocker that is down is a normal answer with the reason in words, and an unknown one is a 404', async () => {
  const { app, id } = await build()
  fake.down = true
  const r = await app.inject({ method: 'GET', url: `/api/plugins/pihole/instances/${id}/reading?fresh=1`, headers: as('admin') })
  assert.equal(r.statusCode, 200)
  assert.equal(r.json().data.ok, false)
  assert.match(r.json().data.error, /unreachable: connection refused/)
  assert.ok(!r.body.includes('192.0.2.10'), 'the address is not in the error')
  assert.equal((await app.inject({ method: 'GET', url: '/api/plugins/pihole/instances/d00000000/reading', headers: as('admin') })).statusCode, 404)
})

test('actions: the normal tier is operator, the secure tier is admin and a person; the service says so itself too', async () => {
  const { app, id } = await build()
  const post = (path: string, body: object, headers: Record<string, string>) => app.inject({ method: 'POST', url: `/api/plugins/pihole/instances/${id}/${path}`, headers, payload: body })
  assert.equal((await post('actions', { action: 'pause', minutes: 5 }, as('viewer'))).statusCode, 403)
  const ok = await post('actions', { action: 'pause', minutes: 5 }, as('operator'))
  assert.equal(ok.statusCode, 200); assert.match(ok.json().data.message, /paused for 5 minutes/)
  assert.equal((await post('secure-actions', { action: 'switch_upstream', to: 'quad9' }, as('operator'))).statusCode, 403)
  const tok = await post('secure-actions', { action: 'switch_upstream', to: 'quad9' }, as('admin', { 'x-token': 'ci' }))
  assert.equal(tok.statusCode, 403); assert.equal(tok.json().code, 'person_only')
  const done = await post('secure-actions', { action: 'switch_upstream', to: 'quad9' }, as('admin'))
  assert.equal(done.statusCode, 200)
  assert.deepEqual(fake.upstreams, ['9.9.9.9', '149.112.112.112'])
  const bad = await post('actions', { action: 'format-disk' }, as('admin'))
  assert.equal(bad.statusCode, 400); assert.equal(bad.json().code, 'unknown_action')
  const phrase = await post('secure-actions', { action: 'allow_domain', domain: 'a.example.net', confirm: 'no' }, as('admin'))
  assert.equal(phrase.statusCode, 400); assert.equal(phrase.json().code, 'confirm_wrong')
  assert.ok(audits.some(a => a.details.action === 'pause' && a.details.result === 'ok'))
  assert.ok(audits.some(a => a.details.action === 'pause' && a.details.result === 'refused:role'))
})

test('AdGuard Home: the same routes under its own prefix', async () => {
  const { app, id } = await build('adguard')
  const r = await app.inject({ method: 'POST', url: `/api/plugins/adguard/instances/${id}/actions`, headers: as('operator'), payload: { action: 'pause', minutes: 30 } })
  assert.equal(r.statusCode, 200)
  assert.equal((fake as FakeAdguard).enabled, false)
  assert.equal((await app.inject({ method: 'GET', url: '/api/plugins/pihole/instances', headers: as('admin') })).statusCode, 404, 'the other product has no routes here')
})

test('changing one: the privacy switch, a new address needing the password again, and a password never coming back', async () => {
  const { app, id, svc } = await build()
  const put = (body: object) => app.inject({ method: 'PUT', url: `/api/plugins/pihole/instances/${id}`, headers: as('admin'), payload: body })
  const hide = await put({ hideClients: true })
  assert.equal(hide.statusCode, 200); assert.equal(hide.json().data.hideClients, true)
  const read = (await app.inject({ method: 'GET', url: `/api/plugins/pihole/instances/${id}/reading?fresh=1`, headers: as('admin') })).json().data
  assert.equal(read.reading.clients, null, 'hidden for everyone, an admin included')
  const moved = await put({ url: 'http://192.0.2.99' })
  assert.equal(moved.statusCode, 400); assert.match(moved.json().error, /password again/)
  assert.ok(!hide.body.includes(PIHOLE_PASSWORD) && !moved.body.includes(PIHOLE_PASSWORD))
  assert.equal((await svc.instances.login(id))?.url, 'http://192.0.2.10')
  assert.ok(audits.some(a => a.action === 'pihole.instance.update' && a.details.result === 'started'), 'a row written before the change')
})

test('removing an auto-connected one is remembered so it is not added back; a hand-made one is not', async () => {
  const { app, id, svc } = await build()
  await svc.instances.create({ name: 'Found', guest: { kind: 'lxc', vmid: 412 }, url: 'http://192.0.2.12', username: null, password: PIHOLE_PASSWORD, autoConnected: { at: 'now', evidence: ['found by the service scan'], vaultItem: null } })
  const found = (await svc.instances.list()).find(m => m.name === 'Found')!
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/plugins/pihole/instances/${found.id}`, headers: as('admin') })).statusCode, 200)
  assert.deepEqual(dismissed, [['lxc-412', 'Pi-hole: Found']])
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/plugins/pihole/instances/${id}`, headers: as('admin') })).statusCode, 200)
  assert.equal(dismissed.length, 1, 'a hand-made one is just removed')
  assert.equal((await svc.instances.list()).length, 0)
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/plugins/pihole/instances/${id}`, headers: as('admin') })).statusCode, 404)
})

test('adding by hand: the guest list is an admin\'s, a wrong login is refused and saves nothing', async () => {
  const { app, svc } = await build()
  const g = await app.inject({ method: 'GET', url: '/api/plugins/pihole/guests', headers: as('admin') })
  assert.deepEqual(g.json().data, [{ kind: 'lxc', vmid: 411, name: 'dns-box' }])
  const bad = await app.inject({ method: 'POST', url: '/api/plugins/pihole/instances', headers: as('admin'), payload: { name: 'Other', url: 'http://192.0.2.11', password: 'wrong' } })
  assert.equal(bad.statusCode, 400); assert.equal(bad.json().code, 'login_refused')
  assert.equal((await svc.instances.list()).length, 1)
  const good = await app.inject({ method: 'POST', url: '/api/plugins/pihole/instances', headers: as('admin'), payload: { name: 'Other', url: 'http://192.0.2.11', password: PIHOLE_PASSWORD } })
  assert.equal(good.statusCode, 201)
  assert.ok(!good.body.includes(PIHOLE_PASSWORD))
})

// ── the gate's rules (lib/roles.ts) ─────────────────────────────────────────

test('gate: reads are viewer; pausing, resuming and updating the lists are operator; everything that changes a blocker is admin and asks for the master password again', () => {
  for (const kind of ['pihole', 'adguard']) {
    const base = `/api/plugins/${kind}/instances`
    assert.equal(requiredRole('GET', base), 'viewer')
    assert.equal(requiredRole('GET', `${base}/dabc12345/reading`), 'viewer')
    assert.equal(requiredRole('GET', `/api/plugins/${kind}/guests`), 'admin', 'the guest list maps the cluster')
    assert.equal(requiredRole('POST', `${base}/dabc12345/actions`), 'operator')
    assert.equal(needsReconfirm('POST', `${base}/dabc12345/actions`), false)
    assert.equal(requiredRole('POST', `${base}/dabc12345/secure-actions`), 'admin')
    assert.equal(needsReconfirm('POST', `${base}/dabc12345/secure-actions`), true)
    for (const [m, p] of [['POST', base], ['PUT', `${base}/dabc12345`], ['DELETE', `${base}/dabc12345`]] as const) {
      assert.equal(requiredRole(m, p), 'admin', `${m} ${p}`)
      assert.equal(needsReconfirm(m, p), true, `${m} ${p} is re-confirmed`)
    }
    assert.equal(needsReconfirm('GET', `${base}/dabc12345/reading`), false)
    // An API token can re-confirm nothing, and is on no allowlist for these (adding a blocker stores a login).
    assert.equal(tokenPluginScope('POST', base), null)
    assert.equal(tokenPluginScope('PUT', `${base}/dabc12345`), null)
  }
})
