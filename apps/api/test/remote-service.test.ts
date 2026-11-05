// Remote access service on a fake executor and a fake provider. Behaviour, not structure: what runs on which
// machine in which order, what the provider is asked to do, and what is left in the store afterwards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RemoteAccessService, RemoteBusyError, RemoteInputError, overviewForRole, type RemoteJob, type UndoPlan } from '../src/lib/remote/service'
import { MemoryRemoteStore } from '../src/lib/remote/store'
import { parseSnapshot } from '../src/lib/remote/guard'
import type { RemoteExecutor } from '../src/lib/remote/executor'
import type { Machine, MintedKey, ProviderDevice, RemoteProvider, RoutingRequest } from '../src/lib/remote/types'

const NODE_A: Machine = { id: 'node-pve-a', kind: 'node', name: 'pve-a', node: 'pve-a', running: true, address: '192.0.2.11' }
const NODE_B: Machine = { id: 'node-pve-b', kind: 'node', name: 'pve-b', node: 'pve-b', running: true, address: '192.0.2.12' }
const CT: Machine     = { id: 'lxc-101', kind: 'lxc', name: 'web', node: 'pve-a', vmid: 101, running: true, ostype: 'debian' }
const WIN: Machine    = { id: 'qemu-103', kind: 'qemu', name: 'desk', node: 'pve-a', vmid: 103, running: true, ostype: 'win11' }

const FACTS = (o: { tun?: boolean; has?: string } = {}) => ['HP_OS_ID=debian', 'HP_OS_VERSION=13', 'HP_OS_CODENAME=trixie', 'HP_UNAME=Linux', 'HP_PM=apt',
  'HP_SYSTEMD=1', `HP_TUN=${o.tun === false ? 0 : 1}`, 'HP_ROOT=1', 'HP_CURL=1', ...(o.has ? [`HP_HAS_TAILSCALE=${o.has}`] : [])].join('\n')

function SNAP(o: { def4?: string; resolv?: string; q?: string; fw?: string; fwd4?: string; nets?: string[] } = {}) {
  return [
    `HP_ROUTE4 ${o.def4 ?? 'default via 192.0.2.1 dev vmbr0 proto kernel onlink'}`,
    'HP_ROUTE4 192.0.2.0/24 dev vmbr0 proto kernel scope link src 192.0.2.11',
    'HP_RULE4 32766: from all lookup main',
    'HP_RESOLV_LINK=/etc/resolv.conf', `HP_RESOLV=${o.resolv ?? 'nameserver 192.0.2.1;'}`, 'HP_RESOLVED=inactive',
    'HP_FWSRC nft present', 'HP_FWL nft table inet filter {', 'HP_FWL nft chain input {', 'HP_FWL nft tcp dport 22 counter packets 5 bytes 300 accept',
    ...(o.fw ? [`HP_FWL nft ${o.fw}`] : []), 'HP_FWL nft }', 'HP_FWL nft }', 'HP_FWSRC ipt4 present', 'HP_FWL ipt4 -A INPUT -j PVEFW-INPUT',
    `HP_FWD4=${o.fwd4 ?? '0'}`, 'HP_FWD6=0',
    ...(o.nets ?? ['HP_NET corosync 192.0.2.12', 'HP_NET own 192.0.2.11/24']),
    'HP_PATH 192.0.2.12 192.0.2.12 dev vmbr0 src 192.0.2.11',
    'HP_COROSYNC link0 node1 localhost', 'HP_COROSYNC link0 node2 connected',
    `HP_QUORATE=${o.q ?? 'Yes'}`, 'HP_SNAPSHOT_END',
  ].join('\n')
}

const TS_STATUS = (m: Machine, ip: string) => `HP_STATUS_BEGIN\n${JSON.stringify({ BackendState: 'Running', Version: '1.90.1', Self: { ID: `n-${m.id}`, HostName: m.name, TailscaleIPs: [ip] } })}\nHP_STATUS_END`

interface Ran { machine: string; kind: string; script: string }

function classify(script: string): string {
  if (script.includes('HP_BUSY=')) return 'busy'
  if (script.includes('HP_OS_ID=')) return 'detect'
  if (script.includes('HP_SNAPSHOT_END')) return 'snapshot'
  if (script.includes('HP_KEY=')) return 'up'
  if (script.includes('HP_BACKUP_OK')) return 'backup'
  if (script.includes('HP_RESTORED')) return 'restore'
  if (script.includes('HP_REMOVED')) return 'uninstall'
  if (script.includes('find /var/lib/hyperprox-remote-access')) return 'drop'
  if (script.includes('--only-upgrade')) return 'update'
  if (script.includes('tailscale set') || script.includes('netbird down')) return 'routing'
  if (script.includes('apt-get install -y -qq')) return 'install'
  if (script.includes('HP_STATUS_BEGIN')) return 'status'
  return 'other'
}

type Answer = (m: Machine, kind: string, nth: number, script: string) => [number, string] | undefined

function world(o: { machines?: Machine[]; answer?: Answer; onRun?: (m: Machine, kind: string) => void } = {}) {
  const ran: Ran[] = []
  const machines = o.machines ?? [NODE_A, NODE_B, CT, WIN]
  const counts = new Map<string, number>()
  const lxcConfigs = new Map<number, Record<string, unknown>>([[101, { hostname: 'web', digest: 'd1g3st' }]])
  const setCalls: Array<{ vmid: number; params: Record<string, string>; digest?: string }> = []
  const fw = { clusterEnabled: true, rules: [] as Array<Record<string, unknown>>, added: [] as Array<Record<string, string>> }
  let ip = 0
  const exec: RemoteExecutor = {
    listMachines: async () => machines,
    run: async (m, script, opt) => {
      const kind = classify(script)
      ran.push({ machine: m.id, kind, script })
      o.onRun?.(m, kind)
      const k = `${m.id}:${kind}`
      const n = (counts.get(k) ?? 0) + 1
      counts.set(k, n)
      const out = o.answer?.(m, kind, n, script) ?? (
        kind === 'busy' ? [0, 'HP_BUSY='] :
        kind === 'detect' ? [0, FACTS()] :
        kind === 'snapshot' ? [0, SNAP()] :
        kind === 'up' ? [0, `the key was ${/HP_KEY='([^']+)'/.exec(script)?.[1]}\n${TS_STATUS(m, `100.64.0.${++ip}`)}`] :
        kind === 'backup' ? [0, 'HP_BACKUP_OK'] :
        kind === 'restore' ? [0, `HP_RESTORED\n${TS_STATUS(m, '100.64.0.99')}`] :
        kind === 'uninstall' ? [0, 'HP_REMOVED'] :
        kind === 'routing' ? [0, `HP_FWD_BEFORE=0:0\nHP_NB_CONFIG=/etc/netbird/config.json\nHP_NB_FLAG DisableServerRoutes:${/disable-server-routes=true/.test(script)}\n${TS_STATUS(m, '100.64.0.9')}`] :
        kind === 'status' || kind === 'update' ? [0, TS_STATUS(m, '100.64.0.9').replace('1.90.1', '1.92.0')] :
        [0, 'ok'])
      // Delivered in small pieces, as SSH does, so redaction across chunk boundaries is exercised.
      for (let i = 0; i < out[1].length; i += 5) opt?.onData?.(out[1].slice(i, i + 5))
      return { code: out[0], output: out[1], timedOut: false }
    },
    lxcConfig: async m => lxcConfigs.get(m.vmid!) ?? {},
    setLxcConfig: async (m, params, digest) => { setCalls.push({ vmid: m.vmid!, params, digest }) },
    firewallState: async () => ({ clusterEnabled: fw.clusterEnabled, rules: fw.rules }),
    addFirewallRule: async (_n, rule) => { fw.added.push(rule); fw.rules.push(rule) },
  }
  return { exec, ran, setCalls, lxcConfigs, fw, kinds: (id?: string) => ran.filter(r => !id || r.machine === id).map(r => r.kind) }
}

function fakeProvider() {
  const minted: MintedKey[] = []
  const revoked = new Set<string>()
  const deleted: string[] = []
  const routing: Array<{ device: string; r: RoutingRequest; previous: string[] }> = []
  const devices: ProviderDevice[] = []
  const ctl = { revokeFails: false, stillUsable: false, advertised: null as string[] | null, revokeDelay: 0 }
  let n = 0
  const p: RemoteProvider = {
    id: 'tailscale',
    test: async () => 'ok',
    mintKey: async () => { const k = { id: `key${++n}`, secret: `tskey-auth-SECRET${n}abcdefghij`, expiresAt: 'soon' }; minted.push(k); return k },
    revokeKey: async id => {
      if (ctl.revokeDelay) await new Promise(r => setTimeout(r, ctl.revokeDelay))
      if (ctl.revokeFails) throw new Error('HTTP 503')
      revoked.add(id)
    },
    keyRevoked: async id => revoked.has(id) && !ctl.stillUsable,
    listDevices: async () => devices,
    deleteDevice: async id => { deleted.push(id) },
    setRouting: async (d, r, previous) => { routing.push({ device: d.id, r, previous }); return r.subnets.map((_, i) => `route${i}`) },
    advertisedRoutes: async () => ctl.advertised ?? [...(routing.at(-1)?.r.subnets ?? []), ...(routing.at(-1)?.r.exitNode ? ['0.0.0.0/0', '::/0'] : [])],
  }
  return { p, minted, revoked, deleted, routing, devices, ctl }
}

function service(w: ReturnType<typeof world>, prov = fakeProvider(), store = new MemoryRemoteStore(), extra: Partial<ConstructorParameters<typeof RemoteAccessService>[0]> = {}) {
  const svc = new RemoteAccessService({
    store, exec: w.exec,
    provider: async () => prov.p,
    providerSettings: async () => ({ tags: ['tag:hyperprox'] }),
    log: () => undefined, settleMs: 0, sleep: async () => undefined,
    ...extra,
  })
  return { svc, store, prov }
}

async function settle(svc: RemoteAccessService, job: RemoteJob): Promise<RemoteJob> {
  for (let i = 0; i < 400; i++) {
    const j = svc.getJob(job.id)!
    if (j.status !== 'running') return j
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error('job did not settle')
}

/** The device the provider lists once a machine's client has reported in. */
function deviceFor(prov: ReturnType<typeof fakeProvider>, m: Machine, ip: string) {
  prov.devices.push({ id: `dev-${m.id}`, nodeKey: `n-${m.id}`, name: m.name, hostname: m.name, addresses: [ip], online: true, lastSeen: '2026-11-03T09:00:00Z', version: '1.90.1' })
}

const install = (svc: RemoteAccessService, ids: string[], extra: Record<string, unknown> = {}) =>
  settle(svc, svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ids, ...extra } as any, 'admin@example.com'))

// ── Install ──────────────────────────────────────────────────────────────────

test('install runs serially, records each device, and leaves no key unrevoked', async () => {
  const w = world()
  const { svc, store, prov } = service(w)
  deviceFor(prov, NODE_A, '100.64.0.1'); deviceFor(prov, NODE_B, '100.64.0.2')
  const job = await install(svc, ['node-pve-a', 'node-pve-b'])
  assert.equal(job.status, 'completed', job.error)
  const order = w.ran.map(r => r.machine)
  assert.ok(order.lastIndexOf('node-pve-a') < order.indexOf('node-pve-b'), 'all of A before any of B')
  assert.deepEqual(w.kinds('node-pve-a'), ['detect', 'snapshot', 'install', 'up', 'snapshot'])
  const rec = await store.get('node-pve-a', 'tailscale')
  assert.equal(rec?.deviceId, 'dev-node-pve-a'); assert.equal(rec?.address, '100.64.0.1'); assert.equal(rec?.adopted, false)
  assert.equal(prov.minted.length, 2)
  assert.deepEqual([...prov.revoked].sort(), ['key1', 'key2'])
  assert.equal(store.pending.size, 0, 'every pending revoke confirmed and cleared')
  assert.equal(store.inflight.size, 0)
  assert.doesNotMatch(JSON.stringify(store.audits), /SECRET/)
})

test('the node flags are the safe ones: no DNS, no routes, no netfilter rules', async () => {
  const w = world()
  const { svc } = service(w)
  await install(svc, ['node-pve-a'])
  const up = w.ran.find(r => r.kind === 'up')!.script
  for (const f of ["'--accept-dns=false'", "'--accept-routes=false'", "'--netfilter-mode=off'"]) assert.ok(up.includes(f), f)
})

test('the key never reaches the job log, even when the target echoes it in small chunks', async () => {
  const w = world()
  const { svc } = service(w)
  const job = await install(svc, ['lxc-101'])
  assert.equal(job.status, 'completed', job.error)
  assert.match(job.log, /the key was \[redacted\]/)
  assert.doesNotMatch(JSON.stringify(job), /SECRET/)
  assert.match(w.ran.find(r => r.kind === 'up')!.script, /tskey-auth-SECRET1/, 'the up script did carry it (on stdin)')
})

test('a key is recorded for revocation before it leaves, and the node change is recorded as in flight', async () => {
  let seen: { pending: number; inflight: number } | null = null
  const store = new MemoryRemoteStore()
  const w = world({ onRun: (_m, kind) => { if (kind === 'up') seen = { pending: store.pending.size, inflight: store.inflight.size } } })
  const { svc } = service(w, fakeProvider(), store)
  await install(svc, ['node-pve-a'])
  assert.deepEqual(seen, { pending: 1, inflight: 1 })
  assert.equal(store.pending.size, 0); assert.equal(store.inflight.size, 0)
})

test('the after-check waits for things to settle (15 s by default)', async () => {
  const waits: number[] = []
  const w = world()
  const { svc } = service(w, fakeProvider(), new MemoryRemoteStore(), { settleMs: undefined, sleep: async ms => { waits.push(ms) } })
  await install(svc, ['node-pve-a'])
  assert.deepEqual(waits, [15_000])
})

test('a bulk install stops at the first failure, and the half-done machine is cleaned up', async () => {
  const w = world({ answer: (m, kind) => (m.id === 'node-pve-a' && kind === 'install' ? [100, 'E: Unable to locate package'] : undefined) })
  const { svc, prov } = service(w)
  const job = await install(svc, ['node-pve-a', 'node-pve-b', 'lxc-101'])
  assert.equal(job.status, 'failed')
  assert.deepEqual(job.steps.map(s => s.status), ['failed', 'pending', 'pending'])
  assert.deepEqual(w.kinds(), ['detect', 'snapshot', 'install', 'snapshot', 'uninstall', 'snapshot'])
  assert.match(job.steps[0].detail ?? '', /Cleaned up: removed the client/)
  assert.equal(prov.minted.length, 0, 'no key is minted before the package is in place')
})

test('a node that is not quorate is not touched', async () => {
  const w = world({ answer: (_m, kind) => (kind === 'snapshot' ? [0, SNAP({ q: 'No' })] : undefined) })
  const { svc } = service(w)
  const job = await install(svc, ['node-pve-a'])
  assert.match(job.steps[0].detail ?? '', /quorate/)
  assert.deepEqual(w.kinds(), ['detect', 'snapshot'])
})

for (const [what, after, samples] of [
  ['routing tables', SNAP({ def4: 'default dev tailscale0 proto static' }), 1],
  ['resolver', SNAP({ resolv: 'nameserver 100.100.100.100;' }), 1],
  ['nftables ruleset', SNAP({ fw: 'udp dport 5405 drop' }), 2],
  ['quorum', SNAP({ q: 'No' }), 1],
] as const) {
  test(`node guard: a changed ${what} rolls the install back and deletes the new device by its id`, async () => {
    // A firewall-only difference gets a second sample; the change persists in it, so it is not churn.
    const w = world({ answer: (_m, kind, n) => (kind === 'snapshot' && n >= 2 && n < 2 + samples ? [0, after] : undefined) })
    const { svc, store, prov } = service(w)
    deviceFor(prov, NODE_A, '100.64.0.1')
    const job = await install(svc, ['node-pve-a', 'node-pve-b'])
    assert.equal(job.status, 'failed')
    const d = job.steps[0].detail ?? ''
    assert.match(d, /Rolled back because/); assert.match(d, new RegExp(what)); assert.match(d, /node is back as it was/)
    assert.deepEqual(w.kinds(), ['detect', 'snapshot', 'install', 'up', ...Array(samples).fill('snapshot'), 'uninstall', 'snapshot'])
    assert.deepEqual(prov.deleted, ['dev-node-pve-a'])
    assert.ok(prov.revoked.has('key1'))
    assert.equal(await store.get('node-pve-a', 'tailscale'), null)
    assert.equal(job.steps[1].status, 'pending', 'the next node is never started')
    assert.ok(store.audits.some(a => a.action === 'remote.rollback'))
  })
}

test('node guard: a rollback that does not restore the node says so and leaves a record with the error', async () => {
  const w = world({ answer: (_m, kind, n) => (kind === 'snapshot' && n >= 2 ? [0, SNAP({ resolv: 'nameserver 100.100.100.100;' })] : undefined) })
  const { svc, store } = service(w)
  const job = await install(svc, ['node-pve-a'])
  assert.match(job.steps[0].detail ?? '', /still differs/)
  assert.match((await store.get('node-pve-a', 'tailscale'))?.lastError ?? '', /still differs/, 'the overview must not say "not installed"')
})

test('a cleanup only deletes a device the client itself reported, never one that merely shares its name', async () => {
  const w = world({ answer: (_m, kind) => (kind === 'up' ? [1, 'backend error: invalid key'] : undefined) })
  const { svc, prov } = service(w)
  prov.devices.push({ id: 'someone-elses', name: 'web', hostname: 'web', addresses: ['100.64.9.9'], online: true, lastSeen: null, version: null })
  const job = await install(svc, ['lxc-101'])
  assert.equal(job.status, 'failed')
  assert.deepEqual([...prov.revoked], ['key1'], 'the key is revoked even though up failed')
  assert.deepEqual(prov.deleted, [])
  assert.match(job.steps[0].detail ?? '', /up failed.*Cleaned up: removed the client.*nothing was deleted/s)
  assert.deepEqual(w.kinds(), ['detect', 'install', 'up', 'uninstall'])
})

// ── Revocation that survives a restart ──────────────────────────────────────

test('a revoke that fails stays recorded, and a later sweep revokes and confirms it', async () => {
  const w = world()
  const prov = fakeProvider()
  prov.ctl.revokeFails = true
  let now = Date.parse('2026-11-03T10:00:00Z')
  const { svc, store } = service(w, prov, new MemoryRemoteStore(), { now: () => now })
  const job = await install(svc, ['lxc-101'])
  assert.equal(job.status, 'completed', job.error)
  assert.match(job.log, /Could not confirm the install key is revoked/)
  const [row] = await store.listPendingRevokes()
  assert.equal(row.keyId, 'key1'); assert.equal(row.attempts, 1)
  prov.ctl.revokeFails = false
  await svc.sweep()
  assert.equal(store.pending.size, 1, 'not due yet: a sweep never races an install that is still running')
  now += 16 * 60_000
  await svc.sweep()
  assert.equal(store.pending.size, 0)
  assert.ok(prov.revoked.has('key1'))
})

test('a revoke the provider does not confirm is kept for the next sweep', async () => {
  const w = world()
  const prov = fakeProvider()
  prov.ctl.stillUsable = true
  const { svc, store } = service(w, prov)
  await install(svc, ['lxc-101'])
  assert.equal(store.pending.size, 1)
  assert.match((await store.listPendingRevokes())[0].lastError ?? '', /still lists the key/)
})

test('at start, every leftover install key is revoked at once; a manual key waits for its time', async () => {
  const store = new MemoryRemoteStore()
  const now = Date.parse('2026-11-03T10:00:00Z')
  await store.addPendingRevoke({ provider: 'tailscale', keyId: 'left-by-a-crash', revokeAfter: new Date(now + 10 * 60_000), reason: 'install' })
  await store.addPendingRevoke({ provider: 'tailscale', keyId: 'manual-later', revokeAfter: new Date(now + 20 * 60_000), reason: 'manual' })
  const prov = fakeProvider()
  const { svc } = service(world(), prov, store, { now: () => now })
  svc.start()
  await svc.sweep()
  await svc.close()
  assert.deepEqual([...prov.revoked], ['left-by-a-crash'])
  assert.deepEqual((await store.listPendingRevokes()).map(r => r.keyId), ['manual-later'])
})

test('a sweep while the vault is locked keeps every row for later', async () => {
  const store = new MemoryRemoteStore()
  await store.addPendingRevoke({ provider: 'tailscale', keyId: 'k', revokeAfter: new Date(0), reason: 'manual' })
  const svc = new RemoteAccessService({
    store, exec: world().exec, provider: async () => { throw Object.assign(new Error('locked'), { name: 'VaultLockedError' }) },
    providerSettings: async () => ({ tags: [] }), settleMs: 0, sleep: async () => undefined,
  })
  await svc.sweep()
  assert.equal(store.pending.size, 1)
})

test('close waits for revokes already on their way, but not forever', async () => {
  const prov = fakeProvider()
  prov.ctl.revokeDelay = 60
  const store = new MemoryRemoteStore()
  await store.addPendingRevoke({ provider: 'tailscale', keyId: 'slow', revokeAfter: new Date(0), reason: 'manual' })
  const { svc } = service(world(), prov, store)
  void svc.sweep()
  await new Promise(r => setTimeout(r, 5))
  await svc.close(2000)
  assert.ok(prov.revoked.has('slow'), 'close waited for the revoke')

  prov.ctl.revokeDelay = 10_000
  await store.addPendingRevoke({ provider: 'tailscale', keyId: 'stuck', revokeAfter: new Date(0), reason: 'manual' })
  void svc.sweep()
  await new Promise(r => setTimeout(r, 5))
  const t0 = Date.now()
  await svc.close(50)
  assert.ok(Date.now() - t0 < 2000, 'close gave up at its limit')
})

test('manual key: recorded for revocation before it is shown, revoked by a sweep after 30 minutes', async () => {
  let now = Date.parse('2026-11-03T10:00:00Z')
  const prov = fakeProvider()
  const { svc, store } = service(world(), prov, new MemoryRemoteStore(), { now: () => now })
  const k = await svc.manualKey('qemu-103', 'tailscale', [], 'admin@example.com')
  assert.equal(k.secret, 'tskey-auth-SECRET1abcdefghij')
  assert.match(k.note, /--auth-key=file:\/dev\/stdin/)
  assert.doesNotMatch(k.note, /--auth-key=</)
  assert.equal(store.pending.size, 1)
  assert.doesNotMatch(JSON.stringify(store.audits), /SECRET/)
  await svc.sweep()
  assert.equal(prov.revoked.size, 0)
  now += 31 * 60_000
  await svc.sweep()
  assert.ok(prov.revoked.has('key1')); assert.equal(store.pending.size, 0)
})

// ── A restart in the middle of a node change ────────────────────────────────

function leftover(store: MemoryRemoteStore, plan: UndoPlan, before = SNAP()) {
  return store.addInflight({ machineId: 'node-pve-a', provider: 'tailscale', action: 'install', jobId: 'old', by: 'admin@example.com', owner: 'a-dead-process', before: parseSnapshot(before), undo: plan })
}
const SUPPORT = { ok: true as const, pm: 'apt' as const, label: 'debian trixie', tsRepo: 'https://pkgs.tailscale.com/stable/debian/trixie' }

test('after a restart, an interrupted node change whose node now differs is rolled back and reported', async () => {
  const store = new MemoryRemoteStore()
  await leftover(store, { kind: 'remove', provider: 'tailscale', support: SUPPORT, deviceId: 'dev-x' })
  const w = world({ answer: (_m, kind, n) => (kind === 'snapshot' && n === 1 ? [0, SNAP({ resolv: 'nameserver 100.100.100.100;' })] : undefined) })
  const prov = fakeProvider()
  const { svc } = service(w, prov, store)
  await svc.sweep()
  assert.deepEqual(w.kinds(), ['busy', 'snapshot', 'uninstall', 'snapshot'])
  assert.deepEqual(prov.deleted, ['dev-x'])
  assert.equal(store.inflight.size, 0)
  const rec = store.audits.find(a => a.action === 'remote.recovered')!
  assert.match(String(rec.details.detail), /A restart interrupted install.*rolled back.*back as it was/s)
})

test('after a restart, an interrupted install is always undone, even when the node looks unchanged', async () => {
  const store = new MemoryRemoteStore()
  await leftover(store, { kind: 'remove', provider: 'tailscale', support: SUPPORT, deviceId: null, nodeKey: 'n-node-pve-a', address: '100.64.0.1' })
  const w = world()
  const prov = fakeProvider()
  deviceFor(prov, NODE_A, '100.64.0.1')
  prov.devices.push({ id: 'same-name', name: 'pve-a', hostname: 'pve-a', addresses: ['100.64.9.9'], online: true, lastSeen: null, version: null })
  const { svc } = service(w, prov, store)
  await svc.sweep()
  assert.deepEqual(w.kinds(), ['busy', 'snapshot', 'uninstall', 'snapshot'])
  assert.deepEqual(prov.deleted, ['dev-node-pve-a'], 'found by the identity up reported, never by name')
  assert.equal(store.inflight.size, 0)
  assert.match(String(store.audits.find(a => a.action === 'remote.recovered')!.details.detail), /never reached its guard verdict, so it was undone/)
})

test('after a restart, an interrupted update on an unchanged node is reported and nothing is undone', async () => {
  const store = new MemoryRemoteStore()
  await store.addInflight({ machineId: 'node-pve-a', provider: 'tailscale', action: 'update', jobId: 'old', by: 'a', owner: 'gone', before: parseSnapshot(SNAP()), undo: { kind: 'restart', provider: 'tailscale' } })
  const w = world()
  const { svc } = service(w, fakeProvider(), store)
  await svc.sweep()
  assert.deepEqual(w.kinds(), ['busy', 'snapshot'])
  assert.match(String(store.audits.find(a => a.action === 'remote.recovered')!.details.detail), /nothing was undone/)
})

test('recovery waits for the dead job\'s script and apt to finish, then settles before the after-check', async () => {
  const store = new MemoryRemoteStore()
  await leftover(store, { kind: 'remove', provider: 'tailscale', support: SUPPORT, deviceId: null })
  const waits: number[] = []
  let now = 0
  const w = world({ answer: (_m, kind, n) => (kind === 'busy' && n <= 2 ? [0, `HP_BUSY= hyperprox-job apt-get`] : undefined) })
  const { svc } = service(w, fakeProvider(), store, { settleMs: 15_000, now: () => now, sleep: async ms => { waits.push(ms); now += ms } })
  await svc.sweep()
  assert.deepEqual(w.kinds().slice(0, 4), ['busy', 'busy', 'busy', 'snapshot'])
  assert.deepEqual(waits.slice(0, 3), [10_000, 10_000, 15_000], 'polled while busy, then settled before the after-check')
})

test('recovery that is still blocked after its time limit reports it once, undoes nothing, and keeps the record', async () => {
  const store = new MemoryRemoteStore()
  await leftover(store, { kind: 'remove', provider: 'tailscale', support: SUPPORT, deviceId: null })
  let now = 0
  const w = world({ answer: (_m, kind) => (kind === 'busy' ? [0, 'HP_BUSY= dpkg'] : undefined) })
  const { svc } = service(w, fakeProvider(), store, { recoveryWaitMs: 60_000, now: () => now, sleep: async ms => { now += ms } })
  await svc.sweep()
  await svc.sweep()
  assert.ok(!w.kinds().includes('uninstall'))
  assert.equal(store.inflight.size, 1)
  const notes = store.audits.filter(a => a.action === 'remote.recovered')
  assert.equal(notes.length, 1, 'reported once')
  assert.match(String(notes[0].details.detail), /dpkg is still running on the node, so nothing was undone/)
})

test('a node script records its pid for the job, so a later process can see whether it still runs', async () => {
  const w = world()
  const { svc } = service(w)
  const job = await install(svc, ['node-pve-a'])
  for (const r of w.ran.filter(r => r.machine === 'node-pve-a' && !['snapshot'].includes(r.kind))) {
    assert.match(r.script, new RegExp(`^hp_run=/run;.*\\n echo \\$\\$ > "\\$hp_run/hyperprox-remote-access-${job.id}\\.pid"`.replace('\\n ', '\\n')), r.kind)
  }
  assert.doesNotMatch(w.ran.find(r => r.machine === 'node-pve-a' && r.kind === 'detect')!.script, /tskey/)
})

test('the identity up reports is saved to the in-flight record before anything else happens', async () => {
  const store = new MemoryRemoteStore()
  let undo: any = null
  const w = world({ onRun: (_m, kind) => { if (kind === 'snapshot' && store.inflight.size) undo = [...store.inflight.values()][0].undo } })
  const { svc } = service(w, fakeProvider(), store)
  await install(svc, ['node-pve-a'])
  assert.equal(undo?.nodeKey, 'n-node-pve-a')
  assert.match(undo?.address ?? '', /^100\.64\.0\./)
})

test('an unlock sweep never revokes the key of an install running in this process', async () => {
  let release!: () => void
  const hold = new Promise<void>(r => { release = r })
  let reached!: () => void
  const atUp = new Promise<void>(r => { reached = r })
  const w = world()
  const run = w.exec.run
  w.exec.run = async (m, script, o) => { if (script.includes('HP_KEY=')) { reached(); await hold } return run(m, script, o) }
  const prov = fakeProvider()
  const { svc, store } = service(w, prov)
  const job = svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['lxc-101'] }, 'a')
  await atUp
  assert.equal(store.pending.size, 1)
  await svc.sweep({ startup: true })
  assert.equal(prov.revoked.size, 0, 'the running install\'s key was left alone')
  release()
  const done = await settle(svc, job)
  assert.equal(done.status, 'completed', done.error)
  assert.deepEqual([...prov.revoked], ['key1'])
})

test('a restore that fails keeps the copy root-only and says where it is and how to remove it', async () => {
  const w = world({ answer: (m, kind, n, script) => HAS(m, kind) ?? (kind === 'up' ? [1, 'failed'] : kind === 'restore' ? [1, 'HP_RESTORE_FAILED /var/lib/hyperprox-remote-access/tailscale'] : undefined) })
  const { svc } = service(w)
  const job = await install(svc, ['lxc-101'], { existing: 'replace' })
  assert.equal(job.status, 'failed')
  assert.match(job.steps[0].detail ?? '', /kept, root-only, at \/var\/lib\/hyperprox-remote-access\/tailscale.*shred -u/s)
})

test('an interrupted change on a node that cannot be read yet is kept for the next sweep, and shown', async () => {
  const store = new MemoryRemoteStore()
  await leftover(store, { kind: 'restart', provider: 'tailscale' })
  const w = world({ answer: (_m, kind) => (kind === 'busy' ? [255, 'ssh: connect refused'] : undefined) })
  const { svc } = service(w, fakeProvider(), store)
  await svc.sweep()
  assert.equal(store.inflight.size, 1)
  const ov = await svc.overview()
  assert.deepEqual(ov.attention.map(a => [a.machineId, a.interrupted]), [['node-pve-a', true]])
})

// ── An existing client ──────────────────────────────────────────────────────

const HAS = (m: Machine, kind: string): [number, string] | undefined => (kind === 'detect' ? [0, FACTS({ has: '1.80.0' })] : undefined)

test('an existing client HyperProx did not install is refused without a choice, and nothing changes', async () => {
  const w = world({ answer: HAS })
  const { svc, prov } = service(w)
  const job = await install(svc, ['node-pve-a'])
  assert.equal(job.status, 'failed')
  assert.match(job.steps[0].detail ?? '', /already runs Tailscale \(1\.80\.0\).*adopt.*replace/s)
  assert.deepEqual(w.kinds(), ['detect'])
  assert.equal(prov.minted.length, 0)
})

test('adopt records the client as it is, without a key, a package or up --reset', async () => {
  const w = world({ answer: HAS })
  const { svc, store, prov } = service(w)
  deviceFor(prov, NODE_A, '100.64.0.9')
  const job = await install(svc, ['node-pve-a'], { existing: 'adopt' })
  assert.equal(job.status, 'completed', job.error)
  assert.deepEqual(w.kinds(), ['detect', 'status'])
  assert.equal(prov.minted.length, 0)
  const rec = await store.get('node-pve-a', 'tailscale')
  assert.equal(rec?.adopted, true); assert.equal(rec?.deviceId, 'dev-node-pve-a')
})

test('adopt refuses a client signed in to another account', async () => {
  const w = world({ answer: HAS })
  const { svc, store } = service(w)
  const job = await install(svc, ['node-pve-a'], { existing: 'adopt' })
  assert.match(job.steps[0].detail ?? '', /not in the configured Tailscale account/)
  assert.equal(await store.get('node-pve-a', 'tailscale'), null)
})

test('replace keeps the old state aside; a guard trip puts it back instead of uninstalling', async () => {
  const w = world({ answer: (m, kind, n) => HAS(m, kind) ?? (kind === 'snapshot' && (n === 2 || n === 3) ? [0, SNAP({ fw: 'udp dport 5405 drop' })] : undefined) })
  const { svc, prov } = service(w)
  deviceFor(prov, NODE_A, '100.64.0.1')
  const job = await install(svc, ['node-pve-a'], { existing: 'replace' })
  assert.equal(job.status, 'failed')
  assert.deepEqual(w.kinds(), ['detect', 'snapshot', 'backup', 'install', 'up', 'snapshot', 'snapshot', 'restore', 'snapshot'])
  assert.ok(!w.kinds().includes('uninstall'))
  assert.match(job.steps[0].detail ?? '', /put the previous client and its state back/)
})

test('replace that succeeds drops the backup', async () => {
  const w = world({ answer: HAS })
  const { svc } = service(w)
  const job = await install(svc, ['lxc-101'], { existing: 'replace' })
  assert.equal(job.status, 'completed', job.error)
  assert.deepEqual(w.kinds(), ['detect', 'backup', 'install', 'up', 'drop'])
})

// ── Uninstall ───────────────────────────────────────────────────────────────

test('node uninstall is guarded, deletes the device by its recorded id, and forgets the record', async () => {
  const w = world()
  const { svc, store, prov } = service(w)
  deviceFor(prov, NODE_A, '100.64.0.1')
  await install(svc, ['node-pve-a'])
  w.ran.length = 0
  prov.devices.push({ id: 'same-name-elsewhere', name: 'pve-a', hostname: 'pve-a', addresses: ['100.64.7.7'], online: true, lastSeen: null, version: null })
  const job = await settle(svc, svc.startJob({ action: 'uninstall', provider: 'tailscale', machineIds: ['node-pve-a'] }, 'a'))
  assert.equal(job.status, 'completed', job.error)
  assert.deepEqual(w.kinds(), ['detect', 'snapshot', 'backup', 'uninstall', 'snapshot', 'drop'])
  assert.deepEqual(prov.deleted, ['dev-node-pve-a'])
  assert.equal(await store.get('node-pve-a', 'tailscale'), null)
})

test('a node uninstall that trips the guard puts the client back and keeps the device', async () => {
  const w = world({ answer: (_m, kind, n) => (kind === 'snapshot' && (n === 4 || n === 5) ? [0, SNAP({ fw: 'udp dport 5405 drop' })] : undefined) })
  const { svc, store, prov } = service(w)
  deviceFor(prov, NODE_A, '100.64.0.1')
  await install(svc, ['node-pve-a'])
  const job = await settle(svc, svc.startJob({ action: 'uninstall', provider: 'tailscale', machineIds: ['node-pve-a'] }, 'a'))
  assert.equal(job.status, 'failed')
  assert.ok(w.kinds().includes('restore'))
  assert.deepEqual(prov.deleted, [])
  assert.ok(await store.get('node-pve-a', 'tailscale'))
})

test('uninstall refuses a client HyperProx neither installed nor adopted', async () => {
  const w = world()
  const { svc } = service(w)
  const job = await settle(svc, svc.startJob({ action: 'uninstall', provider: 'tailscale', machineIds: ['lxc-101'] }, 'a'))
  assert.match(job.steps[0].detail ?? '', /has not installed or adopted/)
  assert.deepEqual(w.kinds(), [])
})

// ── Routing ─────────────────────────────────────────────────────────────────

async function installed(w: ReturnType<typeof world>, m: Machine, prov = fakeProvider(), store = new MemoryRemoteStore()) {
  const s = service(w, prov, store)
  deviceFor(prov, m, '100.64.0.1')
  await install(s.svc, [m.id])
  w.ran.length = 0
  return s
}
const routing = (svc: RemoteAccessService, id: string, r: { subnets: string[]; exitNode: boolean }, provider: 'tailscale' | 'netbird' = 'tailscale') =>
  settle(svc, svc.startJob({ action: 'routing', provider, machineIds: [id], ...r, acknowledge: true }, 'a'))

test('routing: no exit node on a node, ever', async () => {
  const w = world()
  const { svc } = await installed(w, NODE_A)
  const j = await routing(svc, 'node-pve-a', { subnets: [], exitNode: true })
  assert.match(j.steps[0].detail ?? '', /never made an exit node/)
  assert.deepEqual(w.kinds(), [])
})

test('routing on a node: refused over any cluster network read from the node, and when forwarding is off', async () => {
  const w = world({ answer: (_m, kind) => (kind === 'snapshot' ? [0, SNAP({ nets: ['HP_NET corosync 192.0.2.12', 'HP_NET ceph 198.51.100.0/24', 'HP_NET own 2001:db8::11/64'] })] : undefined) })
  const { svc } = await installed(w, NODE_A)
  const ceph = await routing(svc, 'node-pve-a', { subnets: ['198.51.100.0/25'], exitNode: false })
  assert.match(ceph.steps[0].detail ?? '', /overlaps the cluster network 198\.51\.100\.0\/24/)
  const v6 = await routing(svc, 'node-pve-a', { subnets: ['2001:db8::/48'], exitNode: false })
  assert.match(v6.steps[0].detail ?? '', /2001:db8::11\/64/)
  const fwd = await routing(svc, 'node-pve-a', { subnets: ['203.0.113.0/24'], exitNode: false })
  assert.match(fwd.steps[0].detail ?? '', /forwarding is off on this node/)
  assert.ok(!w.kinds().includes('routing'), 'nothing was changed')
})

test('routing on a node with forwarding on: guarded, no sysctl, advertised routes verified', async () => {
  const w = world({ answer: (_m, kind) => (kind === 'snapshot' ? [0, SNAP({ fwd4: '1' })] : undefined) })
  const { svc, store, prov } = await installed(w, NODE_A)
  const j = await routing(svc, 'node-pve-a', { subnets: ['203.0.113.0/24'], exitNode: false })
  assert.equal(j.status, 'completed', j.error)
  assert.deepEqual(w.kinds(), ['snapshot', 'routing', 'snapshot'])
  assert.doesNotMatch(w.ran.find(r => r.kind === 'routing')!.script, /sysctl|ip_forward/)
  assert.deepEqual(prov.routing.at(-1)!.r, { subnets: ['203.0.113.0/24'], exitNode: false })
  assert.deepEqual((await store.get('node-pve-a', 'tailscale'))?.routes, ['203.0.113.0/24'])
})

test('routing: when the client does not advertise what was asked, it is undone and reported', async () => {
  const w = world()
  const prov = fakeProvider()
  const { svc, store } = await installed(w, CT, prov)
  prov.ctl.advertised = []
  const j = await routing(svc, 'lxc-101', { subnets: ['203.0.113.0/24'], exitNode: false })
  assert.equal(j.status, 'failed')
  assert.match(j.steps[0].detail ?? '', /advertising nothing/)
  assert.equal(w.kinds().filter(k => k === 'routing').length, 2, 'the change and its undo')
  assert.deepEqual((await store.get('lxc-101', 'tailscale'))?.routes, [])
})

test('routing on a guest: checked against its node\'s cluster networks; forwarding recorded, then restored', async () => {
  const w = world({ answer: (_m, kind) => (kind === 'snapshot' ? [0, SNAP({ nets: ['HP_NET ceph 198.51.100.0/24'] })] : undefined) })
  const { svc, store } = await installed(w, CT)
  const bad = await routing(svc, 'lxc-101', { subnets: ['198.51.100.0/24'], exitNode: false })
  assert.match(bad.steps[0].detail ?? '', /overlaps the cluster network/)
  assert.deepEqual(w.ran.map(r => `${r.machine}:${r.kind}`), ['node-pve-a:snapshot'], 'read from the guest\'s node; nothing changed')
  const on = await routing(svc, 'lxc-101', { subnets: ['203.0.113.0/24'], exitNode: true })
  assert.equal(on.status, 'completed', on.error)
  assert.equal((await store.get('lxc-101', 'tailscale'))?.forwardingBefore, '0:0')
  w.ran.length = 0
  const off = await routing(svc, 'lxc-101', { subnets: [], exitNode: false })
  assert.equal(off.status, 'completed', off.error)
  assert.match(w.ran.find(r => r.kind === 'routing')!.script, /sysctl -q -w net\.ipv4\.ip_forward=0 net\.ipv6\.conf\.all\.forwarding=0/)
  assert.equal((await store.get('lxc-101', 'tailscale'))?.forwardingBefore, null)
})

test('NetBird routing is confirmed from the client\'s own config, never from the flag', async () => {
  const w = world({ answer: (_m, kind) => (kind === 'routing' ? [0, 'HP_NB_CONFIG=/var/lib/netbird/default.json\nHP_NB_FLAG DisableServerRoutes:true\nHP_STATUS_BEGIN\n{}\nHP_STATUS_END'] : undefined) })
  const prov = fakeProvider()
  const store = new MemoryRemoteStore()
  await store.upsert({ machineId: 'lxc-101', provider: 'netbird', deviceId: 'peer1', nodeKey: null, hostname: 'web', address: '100.92.0.4', mode: 'kernel', version: '0.82.0', routes: [], exitNode: false, routeIds: [], adopted: false, forwardingBefore: null, connected: true, checkedAt: null, lastError: null })
  const { svc } = service(w, prov, store)
  const j = await routing(svc, 'lxc-101', { subnets: ['203.0.113.0/24'], exitNode: false }, 'netbird')
  assert.equal(j.status, 'failed')
  assert.match(j.steps[0].detail ?? '', /NetBird did not take the change/)
  assert.match(w.ran.find(r => r.kind === 'routing')!.script, /'--disable-server-routes=false'/)
})

// ── Containers, firewall, overview, input ───────────────────────────────────

test('tun: through the Proxmox API with the config digest; already configured is not repeated', async () => {
  const w = world()
  const { svc, store } = service(w)
  const r = await svc.applyTun('lxc-101', 'admin@example.com')
  assert.equal(r.applied, true)
  assert.deepEqual(w.setCalls, [{ vmid: 101, params: { dev0: '/dev/net/tun' }, digest: 'd1g3st' }])
  assert.ok(store.audits.some(a => a.action === 'remote.tun'))
  w.lxcConfigs.set(101, { lxc: [['lxc.mount.entry', '/dev/net/tun dev/net/tun none bind,create=file']] })
  assert.equal((await svc.applyTun('lxc-101', 'a')).applied, false)
  assert.equal(w.setCalls.length, 1)
  await assert.rejects(svc.applyTun('node-pve-a', 'a'), RemoteInputError)
})

test('tun: when Proxmox refuses the API change, the exact command is returned instead', async () => {
  const w = world()
  w.exec.setLxcConfig = async () => { throw new Error('Proxmox API 403: only root@pam may set dev0') }
  const { svc } = service(w)
  const r = await svc.applyTun('lxc-101', 'a')
  assert.equal(r.applied, false)
  assert.equal(r.command, 'pct set 101 --dev0 /dev/net/tun')
})

test('firewall: a preview, then exactly one rule for 22 and 8006 on the overlay interface from the overlay', async () => {
  const w = world()
  const { svc, store } = service(w)
  const pv = await svc.firewallPreview('node-pve-a', 'tailscale')
  assert.equal(pv.exists, false)
  assert.deepEqual({ ...pv.rule, comment: undefined }, { type: 'in', action: 'ACCEPT', iface: 'tailscale0', source: '100.64.0.0/10', proto: 'tcp', dport: '22,8006', enable: '1', comment: undefined })
  assert.deepEqual(w.fw.added, [], 'a preview changes nothing')
  assert.equal((await svc.addFirewallRule('node-pve-a', 'tailscale', 'admin@example.com')).added, true)
  assert.equal((await svc.addFirewallRule('node-pve-a', 'tailscale', 'admin@example.com')).added, false, 'not added twice')
  assert.equal(w.fw.added.length, 1)
  assert.equal((await svc.firewallPreview('node-pve-a', 'netbird')).rule.iface, 'wt0')
  assert.ok(store.audits.some(a => a.action === 'remote.firewall'))
  w.fw.clusterEnabled = false
  await assert.rejects(svc.addFirewallRule('node-pve-b', 'tailscale', 'a'), /firewall is off/)
  await assert.rejects(svc.firewallPreview('lxc-101', 'tailscale'), RemoteInputError)
})

test('overview: status matched by recorded identity; below admin, no LAN or cluster addresses', async () => {
  const w = world()
  const { svc, store, prov } = service(w)
  deviceFor(prov, CT, '100.64.0.1')
  await install(svc, ['lxc-101'])
  prov.devices.push({ id: 'stray', name: 'pve-b', hostname: 'pve-b', addresses: ['100.64.0.50'], online: false, lastSeen: '2026-11-01T00:00:00Z', version: '1.80.0' })
  await store.upsert({ machineId: 'node-pve-a', provider: 'tailscale', deviceId: 'gone', nodeKey: null, hostname: 'pve-a', address: '100.64.0.9', mode: 'kernel', version: '1.90.1', routes: ['203.0.113.0/24'], exitNode: false, routeIds: [], adopted: false, forwardingBefore: null, lastError: null, connected: true, checkedAt: null })
  const ov = await svc.overview()
  const row = (o: typeof ov, id: string) => o.machines.find(m => m.id === id)!
  assert.equal(row(ov, 'lxc-101').cells.tailscale.state, 'connected')
  assert.equal(row(ov, 'node-pve-a').cells.tailscale.state, 'missing')
  assert.equal(row(ov, 'node-pve-b').cells.tailscale.managed, false)
  assert.equal(row(ov, 'qemu-103').cells.tailscale.state, 'manual')
  assert.equal(row(ov, 'node-pve-a').address, '192.0.2.11')
  const viewer = overviewForRole(ov, false)
  assert.doesNotMatch(JSON.stringify(viewer), /192\.0\.2\./)
  assert.doesNotMatch(JSON.stringify(viewer), /203\.0\.113\./, 'routes are not shown below admin')
  assert.equal(row(viewer, 'lxc-101').cells.tailscale.ip, '100.64.0.1')
  assert.equal(row(viewer, 'lxc-101').cells.tailscale.version, '1.90.1')
})

test('input checks, one job at a time, and finished jobs are pruned', async () => {
  const w = world()
  let now = Date.parse('2026-11-03T10:00:00Z')
  const { svc } = service(w, fakeProvider(), new MemoryRemoteStore(), { now: () => now })
  assert.throws(() => svc.startJob({ action: 'install', provider: 'zerotier' as any, machineIds: ['lxc-101'] }, 'a'), RemoteInputError)
  assert.throws(() => svc.startJob({ action: 'install', provider: 'tailscale', machineIds: [] }, 'a'), RemoteInputError)
  assert.throws(() => svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['lxc-101'], tags: ['bad tag'] }, 'a'), RemoteInputError)
  assert.throws(() => svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['lxc-101'], existing: 'steal' as any }, 'a'), RemoteInputError)
  assert.throws(() => svc.startJob({ action: 'uninstall', provider: 'tailscale', machineIds: ['lxc-101', 'node-pve-a'] }, 'a'), RemoteInputError)
  const first = await settle(svc, svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['lxc-999'] }, 'a'))
  assert.match(first.error ?? '', /lxc-999/)
  const j = svc.startJob({ action: 'check', provider: 'tailscale', machineIds: ['lxc-101'] }, 'a')
  assert.throws(() => svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['node-pve-a'] }, 'a'), RemoteBusyError)
  await settle(svc, j)
  now += 7 * 3600_000
  await settle(svc, svc.startJob({ action: 'check', provider: 'tailscale', machineIds: ['lxc-101'] }, 'a'))
  assert.equal(svc.getJob(first.id), undefined, 'a job finished hours ago is gone')
})

// ── Host keys ───────────────────────────────────────────────────────────────

function pins(w: ReturnType<typeof world>, presented = 'SHA256:' + 'A'.repeat(43), pinned: string | null = null) {
  const saved: Array<[string, number, string]> = []
  w.exec.hostKeyTarget = async m => ({ host: m.kind === 'host' ? '192.0.2.50' : '192.0.2.11', port: 22 })
  w.exec.probeHostKey = async () => presented
  w.exec.pinnedHostKey = async () => pinned
  w.exec.pinHostKey = async (h, p, f) => { saved.push([h, p, f]) }
  return saved
}

test('host key: the admin pins exactly the key presented now, in the Terminal\'s store', async () => {
  const w = world()
  const fp = 'SHA256:' + 'A'.repeat(43)
  const saved = pins(w, fp)
  const { svc, store } = service(w)
  const pv = await svc.hostKeyPreview('lxc-101')
  assert.deepEqual(pv, { host: '192.0.2.11', port: 22, fingerprint: fp, pinned: null })
  await assert.rejects(svc.pinHostKey('lxc-101', 'SHA256:' + 'B'.repeat(43), 'a'), /presents SHA256:A+ now/)
  await assert.rejects(svc.pinHostKey('lxc-101', 'not a fingerprint', 'a'), RemoteInputError)
  assert.equal((await svc.pinHostKey('lxc-101', fp, 'admin@example.com')).pinned, true)
  assert.deepEqual(saved, [['192.0.2.11', 22, fp]])
  assert.ok(store.audits.some(a => a.action === 'remote.pin-host-key'))
})

test('host key: a different existing pin is never replaced from here', async () => {
  const w = world()
  const fp = 'SHA256:' + 'A'.repeat(43)
  const saved = pins(w, fp, 'SHA256:' + 'C'.repeat(43))
  const { svc } = service(w)
  await assert.rejects(svc.pinHostKey('node-pve-a', fp, 'a'), /different key is pinned.*Terminal/)
  assert.deepEqual(saved, [])
})
