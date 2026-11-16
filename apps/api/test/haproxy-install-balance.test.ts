// HAProxy's optional install step "Load-balance an app now": the plan checks (the plug-in's own rules, the leave-alone
// rule), the step through the plug-in's real service with the backend read back, and the install unchanged without it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { previewInstall, applyPreview } from '../src/lib/catalogue-installer'
import { HaproxyService, type GuestRow, type ServiceDeps } from '../src/lib/haproxy/service'
import { HaproxyInstanceStore } from '../src/lib/haproxy/instances'
import { backendProblem, type BalanceDeps } from '../src/lib/haproxy/install-balance'
import type { Reading } from '../src/lib/haproxy/model'
import type { ConfigWriter } from '../src/lib/haproxy/dataplane'
import type { DataPlaneTx } from '../src/lib/proxy/providers/haproxy'
import type { PublishDeps } from '../src/lib/sites'
import { FakePve, deps, INPUT, settled } from './fakes/catalogue-pve'

const OWNER = 'admin@example.com'
const ROWS: GuestRow[] = [
  { kind: 'lxc', vmid: 102, name: 'lb', node: 'node-a', running: true, excludedBy: null, addresses: ['192.0.2.50'] },
  { kind: 'lxc', vmid: 151, name: 'app-a', node: 'node-a', running: true, excludedBy: null, addresses: ['10.0.0.51'] },
  { kind: 'lxc', vmid: 152, name: 'app-b', node: 'node-b', running: true, excludedBy: null, addresses: ['10.0.0.52'] },
  { kind: 'lxc', vmid: 153, name: 'secret', node: 'node-b', running: true, excludedBy: 'the hyperprox-ignore tag', addresses: ['10.0.0.53'] },
  { kind: 'lxc', vmid: 154, name: 'asleep', node: 'node-b', running: false, excludedBy: null, addresses: ['10.0.0.54'] },
]
const GOOD = { name: 'Shop', guests: [{ kind: 'lxc', vmid: 151 }, { kind: 'lxc', vmid: 152 }], port: 8080, algorithm: 'leastconn', checkPath: '/health' }
const HAPROXY_INPUT = (o: any = {}) => INPUT({ recipeId: 'haproxy', hostname: 'haproxy', ...o })

function memIO() {
  const m = new Map<string, string>()
  return { get: async (c: string, p: string, k: string) => m.get(`${c}/${p}/${k}`) ?? null, set: async (c: string, p: string, k: string, v: string) => { m.set(`${c}/${p}/${k}`, v) } }
}

function publishFake(): PublishDeps {
  return {
    dns: async () => ({ getDomains: async () => [{ domain: 'example.com', status: 'ACTIVE' }], getRecords: async () => [], createRecord: async () => {}, deleteRecord: async () => {} }),
    proxy: { instances: async () => [{ id: 'npm-1', name: 'Edge NPM', kind: 'npm', status: 'ok', certificates: 'request' }],
      createHost: async () => ({ hostId: '77' }), attachCertificate: async () => {}, deleteHost: async () => {}, requestCertificate: async () => ({ id: '9' }) },
    wanIp: async () => '203.0.113.7', resolve4: async () => ['203.0.113.7'], letsEncryptEmail: () => 'ops@example.com',
    fetchPublic: async () => ({ status: 200, body: '' }), wait: async () => {},
  } as any
}

/** The plug-in's real service over a fake Data Plane writer; the reading is built from what the writer was given. */
function rig(o: { upAfter?: number; dropServer?: boolean } = {}) {
  const store = new HaproxyInstanceStore(memIO())
  const saved: Record<string, Array<{ name: string; address: string; port: number }>> = {}
  const calls: string[] = []
  const audits: string[] = []
  const w: ConfigWriter = {
    async configRead<T>(p: string) { return ({ '/frontends/http': { name: 'http', mode: 'http' }, '/frontends/http/backend_switching_rules': [], '/backends': [] } as any)[p] as T },
    async configChange(what, fn) {
      calls.push(`begin ${what}`)
      const tx: DataPlaneTx = { get: async <T>(p: string) => ((p === '/backends' ? [] : p.endsWith('/backend_switching_rules') ? [] : { name: 'http', mode: 'http' }) as any) as T,
        send: async (m, p, body: any) => {
          calls.push(`${m} ${p}`)
          const sv = /^\/backends\/([^/]+)\/servers$/.exec(p)
          if (m === 'POST' && sv) (saved[sv[1]] ??= []).push({ name: body.name, address: body.address, port: body.port })
          return null as any
        } }
      await fn(tx); calls.push('commit')
    },
  }
  const svcDeps: ServiceDeps = {
    store, exec: async () => ({ code: 0, output: '' }), writer: async () => w, audit: async (a) => { audits.push(a) },
    guests: async () => ROWS, sightings: async () => [], proxyInstances: async () => [], dismissed: async () => {}, now: () => 1_800_000_000_000,
  }
  const svc = new HaproxyService(svcDeps)
  let reads = 0, waits = 0, balanceCalls = 0
  const balance: BalanceDeps = {
    loadBalance: (id, body, actor, publish) => { balanceCalls++; return svc.loadBalance(id, body, actor, publish) },
    planPublish: async () => async () => ({ jobId: 'none' }),
    reading: async () => {
      reads++
      const reading = { backends: Object.entries(saved).map(([name, servers]) => ({ name, status: 'UP', algorithm: null, sessions: 0, rate: 0, errors: 0, http5xx: 0, responseMs: null, healthy: 0, internal: false,
        servers: (o.dropServer ? servers.slice(1) : servers).map(s => ({ name: s.name, address: `${s.address}:${s.port}`, state: reads > (o.upAfter ?? 0) ? 'up' : 'down', status: reads > (o.upAfter ?? 0) ? 'UP' : 'DOWN' })) })) }
      return reading as unknown as Reading
    },
    guests: async () => ROWS,
    publishJob: () => undefined,
    wait: async () => { waits++ },
  }
  return { store, balance, calls, audits, saved, stats: () => ({ reads, waits, balanceCalls }) }
}

function installDeps(f: FakePve, r: ReturnType<typeof rig>, over: any = {}) {
  const proxyMade: string[] = []
  return {
    proxyMade,
    d: deps(f, {
      publish: publishFake(),
      probe: async () => ({ status: 503, body: 'No server is available to handle this request.' }),
      saveSecrets: async () => {},
      haproxySetup: () => ({
        createProxyInstance: async (_i: any, owner: string) => { proxyMade.push(owner); return 'px-0123456789' },
        store: r.store, audit: async () => {}, syncTargets: async () => true, deleteSecrets: async () => {},
      }),
      scrapers: () => ['10.0.0.9'],
      haproxyBalance: async () => r.balance,
      haproxyBalanceCheck: async () => ({ guests: async () => ROWS, publish: publishFake() }),
      ...over,
    } as any),
  }
}

test('with the step: the plan holds the plug-in\'s own checked values, the backend is created through its service and read back healthy', async () => {
  const f = new FakePve(), r = rig({ upAfter: 2 })
  const { d } = installDeps(f, r)
  const p = await previewInstall(HAPROXY_INPUT({ balance: { ...GOOD, evil: 'x', guests: [{ kind: 'lxc', vmid: 151, address: '1.2.3.4' }, { kind: 'lxc', vmid: 152 }] } }), OWNER, d)
  assert.deepEqual(p.errors, [])
  assert.deepEqual(p.preview!.plan.balance, { name: 'shop', guests: [{ kind: 'lxc', vmid: 151 }, { kind: 'lxc', vmid: 152 }], port: 8080, algorithm: 'leastconn', checkPath: '/health' })
  assert.ok(p.checks.some(c => /spread every visitor no other rule matches across 2 guests \(app-a-151 on port 8080, app-b-152 on port 8080\) by leastconn: Sends each visitor to the server with the fewest/.test(c)))
  const job = await settled((await applyPreview(p.preview!.id, OWNER, d)).jobId)
  assert.equal(job.status, 'completed', job.error)
  assert.deepEqual(job.steps.map(s => s.id), ['container', 'network', 'install', 'verify', 'haproxy-proxy', 'haproxy-plugin', 'haproxy-metrics', 'haproxy-balance'])
  assert.ok(job.steps.every(s => s.status === 'done'), JSON.stringify(job.steps))
  assert.match(job.steps.at(-1)!.detail!, /hpx_lb_shop: 2 servers, 2 healthy/)
  assert.deepEqual(r.saved.hpx_lb_shop.map(s => `${s.name}=${s.address}:${s.port}`), ['app-a-151=10.0.0.51:8080', 'app-b-152=10.0.0.52:8080'])
  assert.ok(r.audits.includes('haproxy.load-balance'), 'audited by the plug-in\'s service')
  assert.ok(r.stats().reads >= 3 && r.stats().waits >= 2, 'it waited until a server was healthy')
})

test('without the step: the install is exactly as before and nothing of the step is touched', async () => {
  const f = new FakePve(), r = rig()
  const { d } = installDeps(f, r, { haproxyBalance: async () => { throw new Error('must not be asked') }, haproxyBalanceCheck: async () => { throw new Error('must not be asked') } })
  const p = await previewInstall(HAPROXY_INPUT(), OWNER, d)
  assert.deepEqual(p.errors, [])
  assert.equal(p.preview!.plan.balance, undefined)
  const job = await settled((await applyPreview(p.preview!.id, OWNER, d)).jobId)
  assert.equal(job.status, 'completed', job.error)
  assert.deepEqual(job.steps.map(s => s.id), ['container', 'network', 'install', 'verify', 'haproxy-proxy', 'haproxy-plugin', 'haproxy-metrics'])
  assert.equal(r.stats().balanceCalls, 0)
})

test('refusals: one guest, a guest HyperProx leaves alone, a stopped or unknown guest, a duplicate, a bad port or path, another recipe', async () => {
  const f = new FakePve(), r = rig()
  const { d } = installDeps(f, r)
  const ask = async (balance: unknown, o: any = {}) => (await previewInstall(HAPROXY_INPUT({ balance, ...o }), OWNER, d))
  const one = await ask({ ...GOOD, guests: [{ kind: 'lxc', vmid: 151 }] })
  assert.equal(one.preview, undefined); assert.match(one.errors.join(' '), /at least two guests/)
  const left = await ask({ ...GOOD, guests: [{ kind: 'lxc', vmid: 151 }, { kind: 'lxc', vmid: 153 }] })
  assert.match(left.errors.join(' '), /secret carries the hyperprox-ignore tag, so HyperProx leaves it alone/)
  assert.match((await ask({ ...GOOD, guests: [{ kind: 'lxc', vmid: 151 }, { kind: 'lxc', vmid: 154 }] })).errors.join(' '), /asleep is not running/)
  assert.match((await ask({ ...GOOD, guests: [{ kind: 'lxc', vmid: 151 }, { kind: 'lxc', vmid: 999 }] })).errors.join(' '), /Guest 999 was not found/)
  assert.match((await ask({ ...GOOD, guests: [{ kind: 'lxc', vmid: 151 }, { kind: 'lxc', vmid: 151 }] })).errors.join(' '), /picked twice/)
  for (const port of [0, 70000, 'x', 80.5]) assert.match((await ask({ ...GOOD, port })).errors.join(' '), /number from 1 to 65535/)
  assert.match((await ask({ ...GOOD, checkPath: '/a b' })).errors.join(' '), /health check path/)
  assert.match((await ask({ ...GOOD, algorithm: 'nope' })).errors.join(' '), /balance algorithm is one of/)
  assert.match((await ask({ ...GOOD, hostname: 'bad host' })).errors.join(' '), /full host name/)
  assert.match((await ask({ ...GOOD, name: '' })).errors.join(' '), /short name/)
  assert.match((await ask('nope')).errors.join(' '), /missing/)
  assert.match((await previewInstall(INPUT({ recipeId: 'uptime-kuma', balance: GOOD }), OWNER, d)).errors.join(' '), /only HAProxy does/)
  assert.equal(f.creates.length, 0, 'a refusal creates nothing')
})

test('a public name: checked in its domain, needs a fixed address, and is held with its domain and proxy', async () => {
  const f = new FakePve(), r = rig()
  const { d } = installDeps(f, r)
  const named = { ...GOOD, hostname: 'shop.example.com', publish: true, zone: 'example.com', proxyInstanceId: 'npm-1' }
  const p = await previewInstall(HAPROXY_INPUT({ balance: named }), OWNER, d)
  assert.deepEqual(p.errors, [])
  assert.deepEqual(p.preview!.plan.balance!.publish, { zone: 'example.com', proxyInstanceId: 'npm-1' })
  assert.equal(p.preview!.plan.balance!.hostname, 'shop.example.com')
  assert.match((await previewInstall(HAPROXY_INPUT({ balance: { ...named, zone: 'example.org' } }), OWNER, d)).errors.join(' '), /must be in the domain you picked/)
  assert.match((await previewInstall(HAPROXY_INPUT({ balance: { ...named, hostname: undefined } }), OWNER, d)).errors.join(' '), /needs the host name/)
  assert.match((await previewInstall(HAPROXY_INPUT({ balance: named, ip: 'dhcp' }), OWNER, d)).errors.join(' '), /needs a fixed address/)
})

test('apply checks the guests again: one that is left alone since the preview refuses before anything is created', async () => {
  const f = new FakePve(), r = rig()
  let rows = ROWS
  const { d } = installDeps(f, r, { haproxyBalanceCheck: async () => ({ guests: async () => rows, publish: publishFake() }) })
  const p = await previewInstall(HAPROXY_INPUT({ balance: GOOD }), OWNER, d)
  assert.deepEqual(p.errors, [])
  rows = ROWS.map(x => x.vmid === 152 ? { ...x, excludedBy: 'the hyperprox-ignore tag' } : x)
  await assert.rejects(applyPreview(p.preview!.id, OWNER, d), /cluster changed since the preview/)
  assert.equal(f.creates.length, 0)
})

test('installed is not done: a backend with no healthy server, or one missing a server, fails the step in words', async () => {
  for (const o of [{ upAfter: 1_000_000 }, { dropServer: true }]) {
    const f = new FakePve(), r = rig(o)
    const { d } = installDeps(f, r)
    const p = await previewInstall(HAPROXY_INPUT({ balance: GOOD }), OWNER, d)
    const job = await settled((await applyPreview(p.preview!.id, OWNER, d)).jobId)
    assert.equal(job.status, 'failed')
    assert.match(job.error!, /HAProxy was installed and hpx_lb_shop was saved, but it is not done: /)
    assert.match(job.error!, o.dropServer ? /missing app-a-151/ : /no server in hpx_lb_shop answers its health check yet/)
    assert.equal(job.steps.find(s => s.id === 'haproxy-balance')!.status, 'failed')
  }
})

test('a public name that fails to publish fails the step, naming what failed and what was cleaned up', async () => {
  const f = new FakePve(), r = rig()
  const job0 = { id: 'j1', status: 'failed', error: 'The certificate could not be issued.', cleanup: ['Removed the DNS record.'], steps: [], domain: 'shop.example.com', owner: OWNER, startedAt: 0, ledger: {} }
  const bal: BalanceDeps = { ...r.balance, planPublish: async () => async () => ({ jobId: 'j1' }), publishJob: () => job0 as any,
    loadBalance: (id, body, actor, publish) => r.balance.loadBalance(id, body, actor, async ip => { await publish!(ip); return { jobId: 'j1' } }) }
  const { d } = installDeps(f, r, { haproxyBalance: async () => bal })
  const p = await previewInstall(HAPROXY_INPUT({ balance: { ...GOOD, hostname: 'shop.example.com', publish: true, zone: 'example.com', proxyInstanceId: 'npm-1' } }), OWNER, d)
  assert.deepEqual(p.errors, [])
  const job = await settled((await applyPreview(p.preview!.id, OWNER, d)).jobId)
  assert.equal(job.status, 'failed')
  assert.match(job.error!, /balancing hpx_lb_shop \(2 of 2 servers healthy\), but publishing shop\.example\.com failed: The certificate could not be issued\. Removed the DNS record\./)
})

test('backendProblem: absent backend, missing server, none healthy, healthy', () => {
  const rd = (servers: Array<[string, string]>) => ({ backends: [{ name: 'b', servers: servers.map(([name, state]) => ({ name, state, status: state.toUpperCase() })) }] }) as unknown as Reading
  assert.match(backendProblem(rd([]), 'x', ['a']).problem!, /not in HAProxy's reading yet/)
  assert.match(backendProblem(rd([['a', 'up']]), 'b', ['a', 'c']).problem!, /missing c/)
  assert.match(backendProblem(rd([['a', 'down']]), 'b', ['a']).problem!, /no server in b answers/)
  assert.deepEqual(backendProblem(rd([['a', 'up'], ['c', 'down']]), 'b', ['a', 'c']), { problem: null, healthy: 1, present: 2 })
})
