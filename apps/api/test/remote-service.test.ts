// Remote access service on a fake executor and a fake provider: serial installs that stop at the first
// failure, the node guard's automatic rollback, keys revoked on every path and never in a log, status
// matched to the provider's device list, routing, uninstall and the /dev/net/tun change.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RemoteAccessService, RemoteBusyError, RemoteInputError, type RemoteJob } from '../src/lib/remote/service'
import { MemoryRemoteStore } from '../src/lib/remote/store'
import type { RemoteExecutor } from '../src/lib/remote/executor'
import type { Machine, MintedKey, ProviderDevice, RemoteProvider, RoutingRequest } from '../src/lib/remote/types'

const NODE_A: Machine = { id: 'node-pve-a', kind: 'node', name: 'pve-a', node: 'pve-a', running: true, address: '192.0.2.11' }
const NODE_B: Machine = { id: 'node-pve-b', kind: 'node', name: 'pve-b', node: 'pve-b', running: true, address: '192.0.2.12' }
const CT: Machine     = { id: 'lxc-101', kind: 'lxc', name: 'web', node: 'pve-a', vmid: 101, running: true, ostype: 'debian' }
const WIN: Machine    = { id: 'qemu-103', kind: 'qemu', name: 'desk', node: 'pve-a', vmid: 103, running: true, ostype: 'win11' }

const FACTS = (tun = true) => ['HP_OS_ID=debian', 'HP_OS_VERSION=13', 'HP_OS_CODENAME=trixie', 'HP_UNAME=Linux', 'HP_PM=apt',
  'HP_SYSTEMD=1', `HP_TUN=${tun ? 1 : 0}`, 'HP_ROOT=1', 'HP_CURL=1'].join('\n')
const SNAP = (o: { def4?: string; resolv?: string; q?: string } = {}) =>
  [`HP_DEF4=${o.def4 ?? 'default via 192.0.2.1 dev vmbr0 ;'}`, 'HP_DEF6=', 'HP_RESOLV_LINK=/etc/resolv.conf',
   `HP_RESOLV=${o.resolv ?? 'nameserver 192.0.2.1;'}`, `HP_QUORATE=${o.q ?? 'Yes'}`].join('\n')

interface Ran { machine: string; kind: string; script: string }

function classify(script: string): string {
  if (script.includes('HP_OS_ID=')) return 'detect'
  if (script.includes('HP_QUORATE')) return 'snapshot'
  if (script.includes('HP_KEY=')) return 'up'
  if (script.includes('HP_REMOVED')) return 'uninstall'
  if (script.includes('--only-upgrade')) return 'update'
  if (script.includes('--advertise-routes') || script.includes('ip_forward')) return 'routing'
  if (script.includes('apt-get install -y -qq')) return 'install'
  if (script.includes('HP_STATUS_BEGIN')) return 'status'
  return 'other'
}

function world(o: {
  machines?: Machine[]
  /** Override a step's output for a machine: return [code, output] or undefined for the default. */
  answer?: (m: Machine, kind: string, nth: number) => [number, string] | undefined
} = {}) {
  const ran: Ran[] = []
  const machines = o.machines ?? [NODE_A, NODE_B, CT, WIN]
  const counts = new Map<string, number>()
  const lxcConfigs = new Map<number, Record<string, unknown>>([[101, { hostname: 'web' }]])
  const setCalls: Array<{ vmid: number; params: Record<string, string> }> = []
  let ip = 0
  const exec: RemoteExecutor = {
    listMachines: async () => machines,
    run: async (m, script, opt) => {
      const kind = classify(script)
      ran.push({ machine: m.id, kind, script })
      const k = `${m.id}:${kind}`
      const n = (counts.get(k) ?? 0) + 1
      counts.set(k, n)
      const over = o.answer?.(m, kind, n)
      const out = over ?? (
        kind === 'detect' ? [0, FACTS()] :
        kind === 'snapshot' ? [0, SNAP()] :
        kind === 'up' ? [0, `the key was ${/HP_KEY='([^']+)'/.exec(script)?.[1]}\nHP_STATUS_BEGIN\n${JSON.stringify({ BackendState: 'Running', Version: '1.90.1', Self: { ID: `n-${m.id}`, HostName: m.name, TailscaleIPs: [`100.64.0.${++ip}`] } })}\nHP_STATUS_END`] :
        kind === 'uninstall' ? [0, 'HP_REMOVED'] :
        kind === 'status' || kind === 'update' || kind === 'routing' ? [0, `HP_STATUS_BEGIN\n${JSON.stringify({ BackendState: 'Running', Version: '1.92.0', Self: { ID: `n-${m.id}`, TailscaleIPs: ['100.64.0.9'] } })}\nHP_STATUS_END`] :
        [0, 'ok'])
      opt?.onData?.(out[1])
      return { code: out[0], output: out[1], timedOut: false }
    },
    lxcConfig: async m => lxcConfigs.get(m.vmid!) ?? {},
    setLxcConfig: async (m, params) => { setCalls.push({ vmid: m.vmid!, params }) },
  }
  return { exec, ran, setCalls, lxcConfigs }
}

function fakeProvider() {
  const minted: MintedKey[] = []
  const revoked: string[] = []
  const deleted: string[] = []
  const routing: Array<{ device: string; r: RoutingRequest; previous: string[] }> = []
  const devices: ProviderDevice[] = []
  let n = 0
  const p: RemoteProvider = {
    id: 'tailscale',
    test: async () => 'ok',
    mintKey: async ({ name, tags }) => { const k = { id: `key${++n}`, secret: `tskey-auth-SECRET${n}`, expiresAt: 'soon' }; minted.push(k); void name; void tags; return k },
    revokeKey: async id => { revoked.push(id) },
    listDevices: async () => devices,
    deleteDevice: async id => { deleted.push(id) },
    setRouting: async (d, r, previous) => { routing.push({ device: d.id, r, previous }); return [] },
  }
  return { p, minted, revoked, deleted, routing, devices }
}

function service(w: ReturnType<typeof world>, prov = fakeProvider(), store = new MemoryRemoteStore()) {
  const svc = new RemoteAccessService({
    store, exec: w.exec,
    provider: async id => (id === 'tailscale' ? prov.p : null),
    providerSettings: async () => ({ tags: ['tag:hyperprox'] }),
    log: () => undefined,
  })
  return { svc, store, prov }
}

async function settle(svc: RemoteAccessService, job: RemoteJob): Promise<RemoteJob> {
  for (let i = 0; i < 200; i++) {
    const j = svc.getJob(job.id)!
    if (j.status !== 'running') return j
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error('job did not settle')
}

// Make every device the fake provider is asked about exist, as the real provider would after `up`.
function deviceFor(prov: ReturnType<typeof fakeProvider>, m: Machine, ip: string) {
  prov.devices.push({ id: `dev-${m.id}`, nodeKey: `n-${m.id}`, name: m.name, hostname: m.name, addresses: [ip], online: true, lastSeen: '2026-11-03T09:00:00Z', version: '1.90.1' })
}

test('install runs serially, one machine at a time, and records each device', async () => {
  const w = world()
  const { svc, store, prov } = service(w)
  deviceFor(prov, NODE_A, '100.64.0.1'); deviceFor(prov, NODE_B, '100.64.0.2')
  const job = await settle(svc, svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['node-pve-a', 'node-pve-b'] }, 'admin@example.com'))
  assert.equal(job.status, 'completed', job.error)
  // Strictly ordered: all of A before any of B.
  const order = w.ran.map(r => r.machine)
  assert.ok(order.lastIndexOf('node-pve-a') < order.indexOf('node-pve-b'))
  // A node: detect, snapshot, install, up, snapshot.
  assert.deepEqual(w.ran.filter(r => r.machine === 'node-pve-a').map(r => r.kind), ['detect', 'snapshot', 'install', 'up', 'snapshot'])
  const rec = await store.get('node-pve-a', 'tailscale')
  assert.equal(rec?.deviceId, 'dev-node-pve-a')
  assert.equal(rec?.address, '100.64.0.1')
  // One key per machine, each revoked.
  assert.equal(prov.minted.length, 2)
  assert.deepEqual(prov.revoked.sort(), ['key1', 'key2'])
  // Audit names the user and machines, never a key.
  const audit = store.audits.find(a => a.action === 'remote.install')
  assert.equal(audit?.details.by, 'admin@example.com')
  assert.doesNotMatch(JSON.stringify(store.audits), /SECRET/)
})

test('the key never reaches the job log, even when the target echoes it', async () => {
  const w = world()
  const { svc } = service(w)
  const job = await settle(svc, svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['lxc-101'] }, 'a'))
  assert.equal(job.status, 'completed', job.error)
  assert.match(job.log, /the key was \[redacted\]/)
  assert.doesNotMatch(job.log, /SECRET/)
  assert.doesNotMatch(JSON.stringify(job), /SECRET/)
  // The up script did carry it (on stdin): otherwise this test proves nothing.
  assert.match(w.ran.find(r => r.kind === 'up')!.script, /tskey-auth-SECRET1/)
})

test('a bulk install stops at the first failure and leaves the rest untouched', async () => {
  const w = world({ answer: (m, kind) => (m.id === 'node-pve-a' && kind === 'install' ? [100, 'E: Unable to locate package'] : undefined) })
  const { svc, prov } = service(w)
  const job = await settle(svc, svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['node-pve-a', 'node-pve-b', 'lxc-101'] }, 'a'))
  assert.equal(job.status, 'failed')
  assert.deepEqual(job.steps.map(s => s.status), ['failed', 'pending', 'pending'])
  assert.ok(!w.ran.some(r => r.machine !== 'node-pve-a'))
  assert.equal(prov.minted.length, 0, 'no key is minted before the package is in place')
})

test('a node that is not quorate is not touched', async () => {
  const w = world({ answer: (m, kind) => (kind === 'snapshot' ? [0, SNAP({ q: 'No' })] : undefined) })
  const { svc } = service(w)
  const job = await settle(svc, svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['node-pve-a'] }, 'a'))
  assert.equal(job.status, 'failed')
  assert.match(job.steps[0].detail ?? '', /quorate/)
  assert.deepEqual(w.ran.map(r => r.kind), ['detect', 'snapshot'])
})

for (const [what, after] of [
  ['default route', SNAP({ def4: 'default dev tailscale0 ;' })],
  ['resolver', SNAP({ resolv: 'nameserver 100.100.100.100;' })],
  ['quorum', SNAP({ q: 'No' })],
] as const) {
  test(`node guard: a changed ${what} rolls the install back automatically and says so`, async () => {
    const w = world({ answer: (m, kind, n) => (kind === 'snapshot' && n === 2 ? [0, after] : undefined) })
    const { svc, store, prov } = service(w)
    deviceFor(prov, NODE_A, '100.64.0.1')
    const job = await settle(svc, svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['node-pve-a', 'node-pve-b'] }, 'a'))
    assert.equal(job.status, 'failed')
    assert.match(job.steps[0].detail ?? '', /rolled back/i)
    assert.match(job.steps[0].detail ?? '', new RegExp(what === 'default route' ? 'default route' : what))
    assert.match(job.steps[0].detail ?? '', /node is back as it was/)
    assert.deepEqual(w.ran.map(r => r.kind), ['detect', 'snapshot', 'install', 'up', 'snapshot', 'uninstall', 'snapshot'])
    assert.deepEqual(prov.deleted, ['dev-node-pve-a'], 'the device is removed from the provider')
    assert.deepEqual(prov.revoked, ['key1'])
    assert.equal(await store.get('node-pve-a', 'tailscale'), null)
    assert.equal(job.steps[1].status, 'pending', 'and the next node is never started')
  })
}

test('node guard: a rollback that does not restore the node is reported as such', async () => {
  const w = world({ answer: (m, kind, n) => (kind === 'snapshot' && n >= 2 ? [0, SNAP({ resolv: 'nameserver 100.100.100.100;' })] : undefined) })
  const { svc } = service(w)
  const job = await settle(svc, svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['node-pve-a'] }, 'a'))
  assert.match(job.steps[0].detail ?? '', /still differs/)
})

test('a failed up still revokes the key', async () => {
  const w = world({ answer: (m, kind) => (kind === 'up' ? [1, 'backend error: invalid key'] : undefined) })
  const { svc, prov } = service(w)
  const job = await settle(svc, svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['lxc-101'] }, 'a'))
  assert.equal(job.status, 'failed')
  assert.deepEqual(prov.revoked, ['key1'])
})

test('planner refusals: Windows gets the manual flow, a container without tun gets the exact fix', async () => {
  const w = world({ answer: (m, kind) => (m.id === 'lxc-101' && kind === 'detect' ? [0, FACTS(false)] : undefined) })
  const { svc } = service(w)
  const a = await settle(svc, svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['qemu-103'] }, 'a'))
  assert.match(a.steps[0].detail ?? '', /download/i)
  const b = await settle(svc, svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['lxc-101'] }, 'a'))
  assert.match(b.steps[0].detail ?? '', /\/dev\/net\/tun/)
  assert.match(b.steps[0].detail ?? '', /pct set 101 --dev0 \/dev\/net\/tun/)
  assert.match(b.steps[0].detail ?? '', /userspace/)
  const c = await settle(svc, svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['lxc-101'], mode: 'userspace' }, 'a'))
  assert.equal(c.status, 'completed', c.error)
  assert.match(w.ran.filter(r => r.kind === 'install').at(-1)!.script, /userspace-networking/)
})

test('input checks: unknown provider, unknown machine, unconfigured provider, one job at a time', async () => {
  const w = world()
  const { svc } = service(w)
  assert.throws(() => svc.startJob({ action: 'install', provider: 'zerotier' as any, machineIds: ['lxc-101'] }, 'a'), RemoteInputError)
  assert.throws(() => svc.startJob({ action: 'install', provider: 'tailscale', machineIds: [] }, 'a'), RemoteInputError)
  assert.throws(() => svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['lxc-101'], tags: ['bad tag'] }, 'a'), RemoteInputError)
  assert.throws(() => svc.startJob({ action: 'uninstall', provider: 'tailscale', machineIds: ['lxc-101', 'node-pve-a'] }, 'a'), RemoteInputError)
  const unknown = await settle(svc, svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['lxc-999'] }, 'a'))
  assert.match(unknown.error ?? '', /lxc-999/)
  const nb = await settle(svc, svc.startJob({ action: 'install', provider: 'netbird', machineIds: ['lxc-101'] }, 'a'))
  assert.match(nb.error ?? '', /not configured/)
  const j = svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['lxc-101'] }, 'a')
  assert.throws(() => svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['node-pve-a'] }, 'a'), RemoteBusyError)
  await settle(svc, j)
})

test('overview: every machine, a cell per provider, status matched to the provider device list', async () => {
  const w = world()
  const { svc, store, prov } = service(w)
  deviceFor(prov, CT, '100.64.0.1')
  await settle(svc, svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['lxc-101'] }, 'a'))
  prov.devices.push({ id: 'stray', name: 'pve-b', hostname: 'pve-b', addresses: ['100.64.0.50'], online: false, lastSeen: '2026-11-01T00:00:00Z', version: '1.80.0' })
  await store.upsert({ machineId: 'node-pve-a', provider: 'tailscale', deviceId: 'gone', nodeKey: null, hostname: 'pve-a', address: '100.64.0.9', mode: 'kernel', version: '1.90.1', routes: [], exitNode: false, routeIds: [], lastError: null, connected: true, checkedAt: null })
  const ov = await svc.overview()
  assert.deepEqual(ov.providers.map(p => [p.id, p.configured]), [['tailscale', true], ['netbird', false]])
  const row = (id: string) => ov.machines.find(m => m.id === id)!
  assert.equal(ov.machines.length, 4)
  assert.equal(row('lxc-101').cells.tailscale.state, 'connected')
  assert.equal(row('lxc-101').cells.tailscale.ip, '100.64.0.1')
  assert.equal(row('lxc-101').cells.tailscale.managed, true)
  assert.equal(row('node-pve-a').cells.tailscale.state, 'missing')
  assert.equal(row('node-pve-b').cells.tailscale.state, 'offline')
  assert.equal(row('node-pve-b').cells.tailscale.managed, false)
  assert.equal(row('qemu-103').cells.tailscale.state, 'manual')
  assert.equal(row('lxc-101').cells.netbird.state, 'unconfigured')
})

test('uninstall removes the client, deletes the device at the provider and forgets the record', async () => {
  const w = world()
  const { svc, store, prov } = service(w)
  deviceFor(prov, CT, '100.64.0.1')
  await settle(svc, svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['lxc-101'] }, 'a'))
  const job = await settle(svc, svc.startJob({ action: 'uninstall', provider: 'tailscale', machineIds: ['lxc-101'] }, 'a'))
  assert.equal(job.status, 'completed', job.error)
  assert.deepEqual(prov.deleted, ['dev-lxc-101'])
  assert.equal(await store.get('lxc-101', 'tailscale'), null)
  assert.ok(store.audits.some(a => a.action === 'remote.uninstall'))
})

test('uninstall that leaves the client in place does not delete the device', async () => {
  const w = world({ answer: (m, kind) => (kind === 'uninstall' ? [0, 'HP_STILL_INSTALLED'] : undefined) })
  const { svc, prov } = service(w)
  deviceFor(prov, CT, '100.64.0.1')
  await settle(svc, svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['lxc-101'] }, 'a'))
  const job = await settle(svc, svc.startJob({ action: 'uninstall', provider: 'tailscale', machineIds: ['lxc-101'] }, 'a'))
  assert.equal(job.status, 'failed')
  assert.deepEqual(prov.deleted, [])
})

test('routing: refused without acknowledgement or over the cluster network; on a node it is guarded', async () => {
  const w = world()
  const { svc, store, prov } = service(w)
  deviceFor(prov, NODE_A, '100.64.0.1')
  await settle(svc, svc.startJob({ action: 'install', provider: 'tailscale', machineIds: ['node-pve-a'] }, 'a'))
  const noAck = await settle(svc, svc.startJob({ action: 'routing', provider: 'tailscale', machineIds: ['node-pve-a'], subnets: ['198.51.100.0/24'], exitNode: false }, 'a'))
  assert.match(noAck.steps[0].detail ?? '', /acknowledged/)
  const cluster = await settle(svc, svc.startJob({ action: 'routing', provider: 'tailscale', machineIds: ['node-pve-a'], subnets: ['192.0.2.0/24'], exitNode: false, acknowledge: true }, 'a'))
  assert.match(cluster.steps[0].detail ?? '', /cluster address/)
  w.ran.length = 0
  const ok = await settle(svc, svc.startJob({ action: 'routing', provider: 'tailscale', machineIds: ['node-pve-a'], subnets: ['198.51.100.0/24'], exitNode: true, acknowledge: true }, 'a'))
  assert.equal(ok.status, 'completed', ok.error)
  assert.deepEqual(w.ran.map(r => r.kind), ['snapshot', 'routing', 'snapshot'])
  assert.deepEqual(prov.routing.at(-1)!.r, { subnets: ['198.51.100.0/24'], exitNode: true })
  const rec = await store.get('node-pve-a', 'tailscale')
  assert.deepEqual(rec?.routes, ['198.51.100.0/24']); assert.equal(rec?.exitNode, true)
})

test('tun: applied through the Proxmox API with the first free devN; already configured is not repeated', async () => {
  const w = world()
  const { svc, store } = service(w)
  const r = await svc.applyTun('lxc-101', 'admin@example.com')
  assert.equal(r.applied, true)
  assert.deepEqual(w.setCalls, [{ vmid: 101, params: { dev0: '/dev/net/tun' } }])
  assert.match(r.message, /restart/i)
  assert.ok(store.audits.some(a => a.action === 'remote.tun'))
  w.lxcConfigs.set(101, { dev0: '/dev/net/tun' })
  const again = await svc.applyTun('lxc-101', 'a')
  assert.equal(again.applied, false)
  assert.equal(w.setCalls.length, 1)
  await assert.rejects(svc.applyTun('node-pve-a', 'a'), RemoteInputError)
})

test('tun: when Proxmox refuses the API change, the exact command is returned instead', async () => {
  const w = world()
  w.exec.setLxcConfig = async () => { throw Object.assign(new Error('Proxmox API 403: only root@pam may set dev0'), { status: 403 }) }
  const { svc } = service(w)
  const r = await svc.applyTun('lxc-101', 'a')
  assert.equal(r.applied, false)
  assert.equal(r.command, 'pct set 101 --dev0 /dev/net/tun')
})

test('manual key: minted for the machine, revoked later, audited without the secret', async () => {
  const w = world()
  const { svc, store, prov } = service(w)
  const k = await svc.manualKey('qemu-103', 'tailscale', [], 'admin@example.com')
  assert.equal(k.secret, 'tskey-auth-SECRET1')
  assert.equal(k.downloadUrl, 'https://tailscale.com/download')
  const a = store.audits.find(x => x.action === 'remote.manual-key')
  assert.ok(a)
  assert.doesNotMatch(JSON.stringify(a), /SECRET/)
  svc.close()   // clears the pending revoke timer, revoking now
  assert.deepEqual(prov.revoked, ['key1'])
})
