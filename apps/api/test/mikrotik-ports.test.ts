// MikroTik: a Port column and neighbour line per device, stray addresses, and the LAN guard (one address list and
// one forward rule): idempotent apply, exact undo, audit before the first write, admin + in-page confirmation, and
// API tokens refused. The router is a made-up one; nothing here reaches a real device.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { buildMikrotikRoutes } from '../src/routes/mikrotik'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken } from '../src/lib/api-tokens'
import { needsReconfirm, requiredRole } from '../src/lib/roles'
import { describeAction } from '../src/lib/confirm-text'
import {
  GUARD_ENTRY_COMMENT, GUARD_LIST, GUARD_RULE_COMMENT, GuardRefusal, applyGuard, canWriteFrom, guardView, inSubnet, isSoftwareMac,
  isStrayAddress, neighbourIndex, networkOf, ownSubnets, portIndex, portText, undoGuard, type GuardRouter,
} from '../src/lib/mikrotik-lan'
import { mikrotikPlugin } from '../src/plugins/mikrotik'
import type { PluginContext } from '../src/lib/plugin-host'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'
import { injectConfirmed } from './fakes/confirm'

// ── a made-up router ─────────────────────────────────────────────────────────

const ADDRESSES = [
  { '.id': '*1', address: '10.0.0.1/24', interface: 'bridge-lan', 'actual-interface': 'bridge-lan' },
  { '.id': '*2', address: '10.0.1.1/24', interface: 'bridge-lan', 'actual-interface': 'bridge-lan' },
  { '.id': '*3', address: '203.0.113.5/24', interface: 'ether1', 'actual-interface': 'ether1' },
  { '.id': '*4', address: '169.254.1.1/16', interface: 'bridge-lan', 'actual-interface': 'bridge-lan' },
  { '.id': '*5', address: '10.9.9.1/24', interface: 'bridge-lan', disabled: 'true' },
]
const ARP = [
  { address: '10.0.0.20', 'mac-address': '00:00:5E:00:53:20', interface: 'bridge-lan', complete: 'true' },
  { address: '10.0.0.21', 'mac-address': '00:00:5E:00:53:21', interface: 'bridge-lan', complete: 'true' },
  { address: '198.51.100.7', 'mac-address': '02:00:5E:00:53:07', interface: 'bridge-lan', complete: 'true' },
  { address: '198.51.100.8', 'mac-address': '00:00:5E:00:53:08', interface: 'bridge-lan', complete: 'true', 'last-seen': '4s' },
  { address: '203.0.113.1', 'mac-address': '00:00:5E:00:53:99', interface: 'ether1', complete: 'true' },
  { address: '169.254.3.3', 'mac-address': '00:00:5E:00:53:33', interface: 'bridge-lan', complete: 'true' },
]
const HOSTS = [
  { 'mac-address': '00:00:5E:00:53:20', 'on-interface': 'ether3', bridge: 'bridge-lan', vid: '1', age: '2s' },
  { 'mac-address': '00:00:5E:00:53:21', 'on-interface': 'trunk-switch', bridge: 'bridge-lan', vid: '20' },
  { 'mac-address': '02:00:5E:00:53:07', 'on-interface': 'ether5', bridge: 'bridge-lan', vid: '1', age: '9s' },
]
const NEIGHBORS = [
  { 'mac-address': '00:00:5E:00:53:21', identity: 'core-switch', platform: 'MikroTik', board: 'CRS328', version: '7.20' },
]

function detailRouter(over: Record<string, any> = {}) {
  const data: Record<string, any> = {
    '/rest/system/resource': { 'board-name': 'RB-test', version: '7.20', uptime: '1d', 'cpu-load': '3', 'total-memory': '100', 'free-memory': '50' },
    '/rest/system/identity': { name: 'edge' },
    '/rest/system/routerboard': { model: 'RB-test' },
    '/rest/system/health': [],
    '/rest/ip/arp': ARP,
    '/rest/ip/dhcp-server/lease': [{ address: '10.0.0.20', 'mac-address': '00:00:5E:00:53:20', 'host-name': 'laptop', status: 'bound' }],
    '/rest/interface': [{ name: 'bridge-lan', type: 'bridge', running: 'true' }, { name: 'ether1', type: 'ether', running: 'true' }],
    '/rest/ip/address': ADDRESSES,
    '/rest/ip/firewall/nat': [], '/rest/ip/firewall/filter': [], '/rest/interface/wireguard/peers': [],
    '/rest/ip/neighbor': NEIGHBORS, '/rest/ip/service': [], '/rest/user': [{ name: 'viewer-login', group: 'read' }],
    '/rest/user/group': [{ name: 'read', policy: 'read,api,rest-api' }],
    '/rest/ip/dns': {}, '/rest/log': [],
    '/rest/interface/list/member': [{ list: 'WAN', interface: 'ether1' }, { list: 'LAN', interface: 'bridge-lan' }],
    '/rest/interface/bridge/host': HOSTS,
    '/rest/interface/wifi/registration-table': [{ 'mac-address': '00:00:5E:00:53:21', interface: 'wifi1', signal: '-61' }],
    '/rest/ip/firewall/address-list': [],
    '/rest/ip/firewall/connection': [
      { 'src-address': '198.51.100.7:4000', 'orig-rate': '10', 'repl-rate': '20', 'orig-bytes': '1', 'repl-bytes': '1' },
      { 'src-address': '198.51.100.7:4001', 'orig-rate': '0', 'repl-rate': '0' },
    ],
    ...over,
  }
  const calls: string[] = []
  const ctx: PluginContext = {
    async get(p) { calls.push(p); if (!(p in data)) throw new Error('MikroTik returned HTTP 404'); const v = data[p]; if (v instanceof Error) throw v; return v },
    async post() { return [] },
    option: k => ({ username: 'viewer-login' } as Record<string, string>)[k],
    from() { return ctx }, has: () => true,
  }
  return { ctx, calls }
}

// ── addresses, MACs, ports, neighbours ───────────────────────────────────────

test('networks: canonical form, membership and the router\'s own networks (no WAN, no link-local, no disabled)', () => {
  assert.equal(networkOf('10.0.0.77/24'), '10.0.0.0/24')
  assert.equal(networkOf('10.0.0.77'), null)
  assert.equal(inSubnet('10.0.1.9', '10.0.1.0/24'), true)
  assert.equal(inSubnet('10.0.2.9', '10.0.1.0/24'), false)
  assert.deepEqual(ownSubnets(ADDRESSES, ['ether1']), ['10.0.0.0/24', '10.0.1.0/24'])
  assert.equal(isStrayAddress('198.51.100.7', ['10.0.0.0/24']), true)
  assert.equal(isStrayAddress('10.0.0.7', ['10.0.0.0/24']), false)
  assert.equal(isStrayAddress('169.254.4.4', ['10.0.0.0/24']), false, 'link-local is never "stray"')
  assert.equal(isStrayAddress('198.51.100.7', []), false, 'unknown networks flag nothing')
})

test('a software-made MAC is the one with the locally-administered bit set', () => {
  assert.equal(isSoftwareMac('02:00:5E:00:53:07'), true)
  assert.equal(isSoftwareMac('DA:A1:19:00:00:01'), true)
  assert.equal(isSoftwareMac('00:00:5E:00:53:08'), false)
  assert.equal(isSoftwareMac('not a mac'), false)
})

test('ports: bridge host, VLAN, this router, Wi-Fi with signal (new and old package), and neighbours by MAC', () => {
  const idx = portIndex(
    [...HOSTS, { 'mac-address': '00:00:5E:00:53:55', local: 'true', 'on-interface': 'bridge-lan' }],
    [{ 'mac-address': '00:00:5E:00:53:21', interface: 'wifi1', signal: '-61' }, { 'mac-address': '00:00:5E:00:53:22', interface: 'wlan2', 'signal-strength': '-70@5GHz' }])
  assert.equal(portText(idx.get('00:00:5E:00:53:20')), 'ether3')
  assert.equal(portText(idx.get('02:00:5E:00:53:07')), 'ether5')
  assert.equal(portText(idx.get('00:00:5E:00:53:21')), 'wifi1 (Wi-Fi, -61 dBm)')
  assert.equal(portText(idx.get('00:00:5E:00:53:22')), 'wlan2 (Wi-Fi, -70 dBm)')
  assert.equal(portText(idx.get('00:00:5E:00:53:55')), 'this router')
  assert.equal(portText(portIndex([HOSTS[1]], []).get('00:00:5E:00:53:21')), 'trunk-switch (VLAN 20)')
  assert.equal(portText(undefined), '—')
  assert.equal(neighbourIndex(NEIGHBORS).get('00:00:5E:00:53:21'), 'core-switch · MikroTik CRS328 · 7.20')
})

// ── the detail page ──────────────────────────────────────────────────────────

test('detail: a Port column, a neighbour column, Wi-Fi signal, and strays flagged with what is known about them', async () => {
  const { ctx } = detailRouter()
  const d = await mikrotikPlugin.detail!(ctx)
  const tables = d.tables.filter(t => t.title.startsWith('Devices'))
  const yours = tables.find(t => t.title.includes('10.0.0.0/24'))!
  assert.ok(yours.columns.some(c => c.key === 'port'), 'Port column')
  assert.ok(yours.columns.some(c => c.key === 'neighbour'), 'neighbour column when any neighbour is known')
  assert.equal(yours.rows.find(r => r.address === '10.0.0.20')!.port, 'ether3')
  const sw = yours.rows.find(r => r.address === '10.0.0.21')!
  assert.equal(sw.port, 'wifi1 (Wi-Fi, -61 dBm)')
  assert.equal(sw.neighbour, 'core-switch · MikroTik CRS328 · 7.20')
  assert.equal(sw.warning, '—')

  const bad = tables.find(t => t.title === 'Devices · Not one of your networks (198.51.100.0/24)')!
  assert.ok(bad, tables.map(t => t.title).join(' | '))
  assert.equal(bad.rows.length, 2)
  const soft = bad.rows.find(r => r.address === '198.51.100.7')!
  assert.equal(soft.warning, 'Address outside your networks')
  assert.equal(soft.port, 'ether5')
  assert.match(String(soft.detail), /Software-made address/)
  assert.match(String(soft.detail), /2 live connections/)
  const hard = bad.rows.find(r => r.address === '198.51.100.8')!
  assert.match(String(hard.detail), /burned into the hardware/i)
  assert.match(String(hard.detail), /No live connections/)
  assert.match(String(hard.detail), /last seen 4s/)
  assert.ok(!tables.some(t => t.rows.some(r => r.address === '169.254.3.3')), 'link-local is not a device')
  assert.ok(!tables.some(t => t.rows.some(r => r.address === '203.0.113.1')), 'the upstream gateway is not a device')

  const subnetsTable = d.tables.find(t => t.title === 'Subnets')!
  assert.ok(subnetsTable.rows.some(r => String(r.net) === '198.51.100.0/24 (not one of your networks)'))

  const v: any = d.visual
  assert.deepEqual(v.subnets.filter((s: any) => s.own === false).map((s: any) => s.net), ['198.51.100.0/24'])
  assert.equal(v.lan.strays.length, 2)
  const s7 = v.lan.strays.find((s: any) => s.address === '198.51.100.7')
  assert.deepEqual([s7.mac, s7.port, s7.softwareMade, s7.connections], ['02:00:5E:00:53:07', 'ether5', true, 2])
  assert.equal(v.lan.guard.state, 'off')
  assert.deepEqual(v.lan.guard.subnets, ['10.0.0.0/24', '10.0.1.0/24'])
  assert.equal(v.lan.guard.interface, 'bridge-lan')
  assert.equal(v.lan.guard.canWrite, false, 'the page says the login cannot write')
})

test('detail: routers without bridge hosts, Wi-Fi or neighbours simply lose those columns\' values', async () => {
  const gone = new Error('MikroTik returned HTTP 404')
  const { ctx } = detailRouter({
    '/rest/interface/bridge/host': gone, '/rest/interface/wifi/registration-table': gone, '/rest/interface/wireless/registration-table': gone,
    '/rest/ip/neighbor': gone, '/rest/ip/firewall/address-list': gone, '/rest/user/group': gone,
  })
  const d = await mikrotikPlugin.detail!(ctx)
  const t = d.tables.find(x => x.title.includes('10.0.0.0/24'))!
  assert.equal(t.rows[0].port, '—')
  assert.ok(!t.columns.some(c => c.key === 'neighbour'))
  assert.equal((d.visual as any).lan.guard.canWrite, null, 'unknown, not guessed')
})

test('detail: a flat network with no strays is unchanged apart from the Port column', async () => {
  const { ctx } = detailRouter({ '/rest/ip/arp': ARP.slice(0, 2), '/rest/ip/neighbor': [] })
  const d = await mikrotikPlugin.detail!(ctx)
  const t = d.tables.filter(x => x.title.startsWith('Devices'))
  assert.equal(t.length, 1)
  assert.equal(t[0].title, 'Devices')
  assert.deepEqual(t[0].columns.map(c => c.key), ['awake', 'name', 'address', 'mac', 'port', 'iface', 'kind'])
  assert.equal((d.visual as any).lan.strays.length, 0)
})

test('detail makes no write calls to the router', async () => {
  const { ctx } = detailRouter()
  let posts = 0
  ;(ctx as any).post = async (p: string) => { posts++; assert.match(p, /monitor-traffic$/); return [] }
  await mikrotikPlugin.detail!(ctx)
  assert.ok(posts <= 1)
})

// ── the guard, against a router that keeps its tables ────────────────────────

function fakeRouter(opts: { group?: string; failOn?: string; users?: any[]; groups?: any[]; extraFilter?: any[]; extraList?: any[] } = {}) {
  let n = 100
  const filter: any[] = opts.extraFilter ?? [
    { '.id': '*A', chain: 'input', action: 'accept', comment: 'existing input' },
    { '.id': '*B', chain: 'forward', action: 'accept', comment: 'existing forward' },
  ]
  const list: any[] = opts.extraList ?? [{ '.id': '*L1', list: 'other-list', address: '192.0.2.5', comment: 'not ours' }]
  const writes: string[] = []
  const r: GuardRouter & { filter: any[]; list: any[]; writes: string[]; moved: string[] } = {
    filter, list, writes, moved: [],
    async get(p) {
      if (p === '/rest/ip/address') return ADDRESSES
      if (p === '/rest/ip/firewall/address-list') return list.map(x => ({ ...x }))
      if (p === '/rest/ip/firewall/filter') return filter.map(x => ({ ...x }))
      if (p === '/rest/user') return opts.users ?? [{ name: 'hp', group: 'writers' }]
      if (p === '/rest/user/group') return opts.groups ?? [{ name: 'writers', policy: 'read,write,api,rest-api' }]
      throw new Error(`unexpected GET ${p}`)
    },
    async put(p, body: any) {
      writes.push(`PUT ${p}`)
      if (opts.failOn && p.includes(opts.failOn)) throw new Error('MikroTik returned HTTP 500')
      const row = { '.id': `*N${n++}`, ...body }
      if (p === '/rest/ip/firewall/address-list') list.push(row)
      else if (p === '/rest/ip/firewall/filter') filter.push(row)
      else throw new Error(`unexpected PUT ${p}`)
      return row
    },
    async delete(p) {
      writes.push(`DELETE ${p}`)
      const id = p.split('/').pop()!
      const t = p.includes('/address-list/') ? list : filter
      const i = t.findIndex(x => x['.id'] === id); if (i < 0) throw new Error('MikroTik returned HTTP 404')
      t.splice(i, 1); return null
    },
    async post(p, body: any) {
      writes.push(`POST ${p}`)
      assert.equal(p, '/rest/ip/firewall/filter/move')
      const i = filter.findIndex(x => x['.id'] === body.numbers), j = filter.findIndex(x => x['.id'] === body.destination)
      const [row] = filter.splice(i, 1); filter.splice(j, 0, row); r.moved.push(String(body.numbers)); return null
    },
  }
  return r
}

const ASKED = { interface: 'bridge-lan', subnets: ['10.0.0.0/24', '10.0.1.0/24'] }
const mkDeps = (router: GuardRouter, audit: string[] = []) => ({
  router, wan: ['ether1'], lan: 'bridge-lan', username: 'hp',
  audit: async (a: string) => { audit.push(a) },
})
const OTHERS = (r: { filter: any[]; list: any[] }) => JSON.stringify([r.filter.filter(x => x.comment !== GUARD_RULE_COMMENT), r.list.filter(x => x.comment !== GUARD_ENTRY_COMMENT)])

test('apply adds the list entries and one drop rule at the very top, and nothing else; audit comes first', async () => {
  const r = fakeRouter(); const audit: string[] = []
  const before = OTHERS(r)
  const out = await applyGuard({ ...mkDeps(r, audit), audit: async a => { assert.equal(r.writes.length === 0 || audit.length > 0, true, 'audit before any write'); audit.push(a) } }, ASKED)
  assert.equal(out.changed, true)
  assert.deepEqual(out.added, ['10.0.0.0/24', '10.0.1.0/24'])
  assert.equal(r.filter[0].comment, GUARD_RULE_COMMENT, 'at the top')
  assert.deepEqual(
    { chain: r.filter[0].chain, action: r.filter[0].action, in: r.filter[0]['in-interface'], src: r.filter[0]['src-address-list'] },
    { chain: 'forward', action: 'drop', in: 'bridge-lan', src: `!${GUARD_LIST}` })
  assert.deepEqual(r.list.filter(x => x.list === GUARD_LIST).map(x => x.address), ['10.0.0.0/24', '10.0.1.0/24'])
  assert.equal(OTHERS(r), before, 'every other rule and entry is exactly as it was')
  assert.deepEqual(r.writes.filter(w => w.startsWith('PUT')).map(w => w.replace('PUT /rest/ip/firewall/', '')), ['address-list', 'address-list', 'filter'], 'list first, rule last')
  assert.equal(audit[0], 'mikrotik.lan-guard.apply.start')
  assert.equal(audit.at(-1), 'mikrotik.lan-guard.apply.done')
})

test('apply is idempotent: a second run changes nothing and writes nothing', async () => {
  const r = fakeRouter()
  await applyGuard(mkDeps(r), ASKED)
  const w = r.writes.length
  const again = await applyGuard(mkDeps(r), ASKED)
  assert.equal(again.changed, false)
  assert.equal(r.writes.length, w)
  assert.equal(r.filter.filter(x => x.comment === GUARD_RULE_COMMENT).length, 1)
})

test('a network added to the router later makes the guard "partial", and apply adds only the missing entry', async () => {
  const r = fakeRouter()
  await applyGuard(mkDeps(r), ASKED)
  r.list.splice(r.list.findIndex(x => x.address === '10.0.1.0/24'), 1)
  const v = guardView({ addresses: ADDRESSES, wan: ['ether1'], lan: 'bridge-lan', addressList: r.list, filter: r.filter, users: [], groups: [] })
  assert.equal(v.state, 'partial'); assert.deepEqual(v.missing, ['10.0.1.0/24'])
  const out = await applyGuard(mkDeps(r), ASKED)
  assert.deepEqual(out.added, ['10.0.1.0/24'])
  assert.equal(r.filter.filter(x => x.comment === GUARD_RULE_COMMENT).length, 1, 'no second rule')
})

test('undo removes exactly the rule and the entries HyperProx added, even beside look-alikes', async () => {
  const lookalike = { '.id': '*L2', list: GUARD_LIST, address: '192.0.2.77', comment: 'someone else\'s entry in the same list' }
  const r = fakeRouter({ extraList: [{ '.id': '*L1', list: 'other-list', address: '192.0.2.5', comment: 'not ours' }, lookalike] })
  const before = OTHERS(r)
  await applyGuard(mkDeps(r), ASKED)
  const audit: string[] = []
  const out = await undoGuard(mkDeps(r, audit))
  assert.equal(out.changed, true)
  assert.equal(OTHERS(r), before, 'back to exactly what it was, look-alike included')
  assert.ok(!r.filter.some(x => x.comment === GUARD_RULE_COMMENT))
  assert.deepEqual(audit, ['mikrotik.lan-guard.undo.start', 'mikrotik.lan-guard.undo.done'])
  const deletes = r.writes.filter(w => w.startsWith('DELETE'))
  assert.ok(deletes[0].includes('/filter/'), 'the rule goes first, so an empty list never drops everything')
  assert.equal((await undoGuard(mkDeps(r))).changed, false, 'undo twice is harmless')
})

test('a changed plan is refused and nothing is written', async () => {
  const r = fakeRouter()
  for (const asked of [{ interface: 'bridge-lan', subnets: ['10.0.0.0/24'] }, { interface: 'ether9', subnets: ASKED.subnets }, {}]) {
    await assert.rejects(applyGuard(mkDeps(r), asked), (e: any) => e instanceof GuardRefusal && e.code === 'plan_changed')
  }
  assert.equal(r.writes.length, 0)
})

test('a router with no network of its own is never given an empty allow list', async () => {
  const r = fakeRouter()
  r.get = async p => (p === '/rest/ip/address' ? [] : p.endsWith('address-list') || p.endsWith('filter') ? [] : [])
  await assert.rejects(applyGuard(mkDeps(r), ASKED), (e: any) => e.code === 'no_plan')
})

test('a read-only login is told so plainly, before and after trying', async () => {
  const ro = fakeRouter({ groups: [{ name: 'writers', policy: 'read,api,rest-api' }] })
  await assert.rejects(applyGuard(mkDeps(ro), ASKED), (e: any) => e.code === 'read_only_login' && /can only read/.test(e.message))
  assert.equal(ro.writes.length, 0)
  // The router does not say which policy the login has, then refuses the write.
  const unknown = fakeRouter({ users: [], groups: [], failOn: 'address-list' })
  unknown.put = async () => { throw new Error('MikroTik returned HTTP 403') }
  await assert.rejects(applyGuard(mkDeps(unknown), ASKED), (e: any) => e.code === 'read_only_login')
  assert.equal(canWriteFrom([{ name: 'a', group: 'g' }], [{ name: 'g', policy: 'read,write' }], 'a'), true)
  assert.equal(canWriteFrom([], [], 'a'), null)
})

test('a failure part-way undoes what this call added, and leaves the rest alone', async () => {
  const r = fakeRouter({ failOn: '/filter' })
  const before = OTHERS(r)
  await assert.rejects(applyGuard(mkDeps(r), ASKED))
  assert.equal(OTHERS(r), before)
  assert.ok(!r.list.some(x => x.list === GUARD_LIST), 'the list entries it added are gone again')
})

// ── the routes, behind the real gate ─────────────────────────────────────────

const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.addUser('op@example.com', 'operator master password', 'operator')
const tokens = new MemoryApiTokenStore()
const audits: Array<{ action: string; resource?: string; details?: Record<string, unknown> }> = []
let app: FastifyInstance
let router = fakeRouter()
const BASE = '/api/plugins/mikrotik/lan-guard'

before(async () => {
  setBroker(broker); setApiTokenStore(tokens)
  setAuditSink({ async write(r) { audits.push(r) } })
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  app = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(buildMikrotikRoutes({
    router: async () => router,
    options: async () => ({ username: 'hp', wan: 'ether1', lan: 'bridge-lan' }),
    audit: async (action, details) => { audits.push({ action, details }) },
  }), { prefix: '/api/plugins/mikrotik' })
  await app.ready()
})
after(async () => { setApiTokenStore(null); setAuditSink(null); if (isUnlocked()) await lock('manual'); await app.close() })

test('role matrix: admin, in-page confirmation, and the summary names exactly what will be added', () => {
  assert.equal(requiredRole('POST', `${BASE}/apply`), 'admin')
  assert.equal(requiredRole('POST', `${BASE}/undo`), 'admin')
  assert.equal(needsReconfirm('POST', `${BASE}/apply`), true)
  assert.equal(needsReconfirm('POST', `${BASE}/undo`), true)
  const say = describeAction('POST', `${BASE}/apply`, `${BASE}/apply`, {}, ASKED)
  assert.match(say, /address list "hyperprox-lan" with 10\.0\.0\.0\/24, 10\.0\.1\.0\/24/)
  assert.match(say, /top of the forward chain/)
  assert.match(say, /coming in on bridge-lan/)
  assert.match(say, /Undo removes exactly those two things/)
  assert.match(describeAction('POST', `${BASE}/undo`, `${BASE}/undo`, {}, {}), /Exactly the address list "hyperprox-lan"/)
})

test('an operator cannot touch the router', async () => {
  router = fakeRouter()
  const { cookie } = await signIn(app, 'op@example.com', 'operator master password')
  const r = await app.inject({ method: 'POST', url: `${BASE}/apply`, headers: { cookie }, payload: ASKED })
  assert.equal(r.statusCode, 403)
  assert.equal(router.writes.length, 0)
})

test('an API token, even an admin one, is refused by name and nothing is written', async () => {
  router = fakeRouter()
  const t = (await createApiToken({ name: 'auto', role: 'admin' }, 'test', tokens)).token
  for (const u of [`${BASE}/apply`, `${BASE}/undo`]) {
    const r = await app.inject({ method: 'POST', url: u, headers: { authorization: `Bearer ${t}` }, payload: ASKED })
    assert.equal(r.statusCode, 403, u)
    assert.equal(r.json().code, 'token_forbidden')
  }
  assert.equal(router.writes.length, 0)
})

test('admin: no confirmation, no change; confirmed, it is audited first, applied, then undone exactly', async () => {
  router = fakeRouter(); audits.length = 0
  const before = OTHERS(router)
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const ask = await app.inject({ method: 'POST', url: `${BASE}/apply`, headers: { cookie }, payload: ASKED })
  assert.equal(ask.statusCode, 403)
  assert.equal(ask.json().code, 'confirm_required')
  assert.match(ask.json().confirm.summary, /hyperprox-lan/)
  assert.equal(router.writes.length, 0, 'nothing ran')

  const done = await injectConfirmed(app, { method: 'POST', url: `${BASE}/apply`, headers: { cookie }, payload: ASKED })
  assert.equal(done.statusCode, 200, done.body)
  assert.equal(done.json().data.changed, true)
  assert.equal(router.filter[0].comment, GUARD_RULE_COMMENT)
  const names = audits.map(a => a.action)
  assert.ok(names.indexOf('action.confirmed') < names.indexOf('mikrotik.lan-guard.apply.start'))
  assert.ok(names.indexOf('mikrotik.lan-guard.apply.start') < names.indexOf('mikrotik.lan-guard.apply.done'))
  assert.equal(audits.find(a => a.action === 'mikrotik.lan-guard.apply.start')!.details?.by, 'admin@example.com')

  const again = await injectConfirmed(app, { method: 'POST', url: `${BASE}/apply`, headers: { cookie }, payload: ASKED })
  assert.equal(again.json().data.changed, false, 'idempotent through the route too')

  const undo = await injectConfirmed(app, { method: 'POST', url: `${BASE}/undo`, headers: { cookie }, payload: {} })
  assert.equal(undo.statusCode, 200, undo.body)
  assert.equal(OTHERS(router), before)
  assert.ok(!router.filter.some(x => x.comment === GUARD_RULE_COMMENT) && !router.list.some(x => x.comment === GUARD_ENTRY_COMMENT))
})

test('an audit log that cannot be written stops the change', async () => {
  router = fakeRouter()
  setAuditSink({ async write() { throw new Error('disk full') } })
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const ask = await app.inject({ method: 'POST', url: `${BASE}/apply`, headers: { cookie }, payload: ASKED })
  const res = await app.inject({ method: 'POST', url: `${BASE}/apply`, headers: { cookie, 'x-hyperprox-confirm': ask.json().confirm.token }, payload: ASKED })
  assert.equal(res.statusCode, 503)
  assert.equal(router.writes.length, 0)
  setAuditSink({ async write(r) { audits.push(r) } })
})

test('a read-only router login: the page is told plainly (409), nothing is written', async () => {
  router = fakeRouter({ groups: [{ name: 'writers', policy: 'read,api' }] })
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const res = await injectConfirmed(app, { method: 'POST', url: `${BASE}/apply`, headers: { cookie }, payload: ASKED })
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().code, 'read_only_login')
  assert.match(res.json().error, /can only read/)
  assert.equal(router.writes.length, 0)
})
