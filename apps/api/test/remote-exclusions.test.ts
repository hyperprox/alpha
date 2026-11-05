// Guests HyperProx must never look inside: a setting on the VPN page (kept in Postgres as machine ids only) or
// the Proxmox tag `hyperprox-ignore`. They are never probed, never touched by any VPN action (mesh jobs or
// WireGuard), and show as "excluded". Also: HyperProx finds its own container by its network identity
// before any job runs, the probe's output and fields are capped, and Refresh runs at most once a minute.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RemoteAccessService, type RemoteJob } from '../src/lib/remote/service'
import { MemoryRemoteStore } from '../src/lib/remote/store'
import { ClientDetector, DETECT_CLIENTS_SCRIPT, MAX_PROBE_OUTPUT, parseDetection } from '../src/lib/remote/detect'
import { findSelf } from '../src/lib/remote/self'
import { appendCapped } from '../src/lib/node-exec'
import { WireguardService } from '../src/lib/vpn/wireguard/service'
import { MemoryWgStore } from '../src/lib/vpn/wireguard/store'
import type { RemoteExecutor } from '../src/lib/remote/executor'
import type { Machine } from '../src/lib/remote/types'

const NODE: Machine = { id: 'node-pve-a', kind: 'node', name: 'pve-a', node: 'pve-a', running: true }
const SECRET_CT: Machine = { id: 'lxc-130', kind: 'lxc', name: 'private', node: 'pve-a', vmid: 130, running: true }
const TAGGED: Machine = { id: 'qemu-131', kind: 'qemu', name: 'tagged', node: 'pve-a', vmid: 131, running: true, ostype: 'l26', tags: ['prod', 'hyperprox-ignore'] }
const WEB: Machine = { id: 'lxc-132', kind: 'lxc', name: 'web', node: 'pve-a', vmid: 132, running: true }
const OUT = 'HP_DETECT_BEGIN\nHP_TS_BIN=/usr/bin/tailscale\nHP_TS_DAEMON=active\nHP_TS_STATUS_BEGIN\n{"BackendState":"Running","Self":{"DNSName":"x.tail0000.ts.net.","TailscaleIPs":["100.64.0.9"]}}\nHP_TS_STATUS_END\nHP_NB_BIN=\nHP_DETECT_END'

function rig(o: { now?: () => number; selfId?: () => Promise<string | null> } = {}) {
  const ran: Array<{ m: string; script: string; opts: any }> = []
  const exec: RemoteExecutor = {
    listMachines: async () => [NODE, SECRET_CT, TAGGED, WEB],
    run: async (m, script, opts) => {
      ran.push({ m: m.id, script, opts })
      if (script === DETECT_CLIENTS_SCRIPT) return { code: 0, output: OUT, timedOut: false }
      if (script.includes('HP_OS_ID=')) return { code: 0, output: 'HP_OS_ID=debian\nHP_OS_VERSION=13\nHP_OS_CODENAME=trixie\nHP_UNAME=Linux\nHP_PM=apt\nHP_SYSTEMD=1\nHP_TUN=1\nHP_ROOT=1', timedOut: false }
      return { code: 0, output: 'HP_STATUS_BEGIN\n{"BackendState":"Running","Self":{"TailscaleIPs":["100.64.0.9"]}}\nHP_STATUS_END', timedOut: false }
    },
    lxcConfig: async () => ({}), setLxcConfig: async () => undefined, firewallState: async () => ({ clusterEnabled: false, rules: [] }), addFirewallRule: async () => undefined,
    hostKeyTarget: async () => ({ host: '192.0.2.11', port: 22 }), probeHostKey: async () => 'x', pinnedHostKey: async () => 'x', pinHostKey: async () => undefined,
  }
  const store = new MemoryRemoteStore()
  let svc!: RemoteAccessService
  const detector = new ClientDetector({ listMachines: exec.listMachines, run: exec.run, excluded: m => svc.isExcluded(m), now: o.now })
  svc = new RemoteAccessService({ store, exec, detector, provider: async () => null, providerSettings: async () => ({ tags: [] }), settleMs: 0, sleep: async () => undefined, now: o.now, selfId: o.selfId })
  return { svc, store, exec, ran, detector }
}

async function settle(svc: RemoteAccessService, job: RemoteJob): Promise<RemoteJob> {
  for (let i = 0; i < 400; i++) { const j = svc.getJob(job.id)!; if (j.status !== 'running') return j; await new Promise(r => setTimeout(r, 5)) }
  throw new Error('job did not settle')
}

test('excluded by the setting or by the hyperprox-ignore tag: never probed, shown as excluded', async () => {
  const r = rig()
  await r.svc.setExclusions(['lxc-130'], 'admin@example.com')
  assert.deepEqual(await r.store.listExclusions(), ['lxc-130'])
  await r.svc.refreshDetection()
  const probed = r.ran.filter(x => x.script === DETECT_CLIENTS_SCRIPT).map(x => x.m).sort()
  assert.deepEqual(probed, ['lxc-132', 'node-pve-a'])
  const ov = await r.svc.overview()
  for (const id of ['lxc-130', 'qemu-131']) {
    const row = ov.machines.find(m => m.id === id)!
    assert.equal(row.excluded, true)
    assert.equal(row.cells.tailscale.state, 'excluded'); assert.equal(row.cells.netbird.state, 'excluded')
    assert.equal(row.cells.tailscale.detectedText, null)
  }
  assert.equal(ov.machines.find(m => m.id === 'qemu-131')!.excludedBy, 'tag')
  assert.equal(ov.machines.find(m => m.id === 'lxc-130')!.excludedBy, 'setting')
  assert.ok(r.store.audits.some(a => a.action === 'remote.exclusions' && JSON.stringify(a.details).includes('lxc-130')))
})

test('excluded guests are refused by every VPN action, mesh or WireGuard, before anything runs on them', async () => {
  const r = rig()
  await r.svc.setExclusions(['lxc-130'], 'a')
  for (const id of ['lxc-130', 'qemu-131']) {
    for (const req of [{ action: 'check' }, { action: 'install', existing: 'adopt' }, { action: 'configure', prefs: { acceptDns: false } }] as const) {
      const job = await settle(r.svc, r.svc.startJob({ provider: 'tailscale', machineIds: [id], ...req } as any, 'a'))
      assert.equal(job.status, 'failed'); assert.match(job.error ?? '', /excluded/i)
    }
  }
  const wg = new WireguardService({ remote: r.svc, exec: r.exec, store: new MemoryWgStore(), vault: { put: async () => undefined, get: async () => ({}), remove: async () => undefined } })
  await assert.rejects(wg.createServer({ machineId: 'lxc-130', address: '100.64.10.1/24', endpoint: 'vpn.example.com:51820' }, 'a'), /excluded/i)
  assert.ok(!r.ran.some(x => x.m === 'lxc-130' || x.m === 'qemu-131'), 'nothing ran on an excluded guest')
  // Taken off the list, it can be probed again.
  await r.svc.setExclusions([], 'a')
  await r.svc.refreshDetection({ force: true })
  assert.ok(r.ran.some(x => x.m === 'lxc-130'))
  await assert.rejects(r.svc.setExclusions(['nope; rm -rf /'], 'a'), /machine id/)
})

test('Refresh runs at most once a minute; a second press returns what is cached and says how old it is', async () => {
  let t = 1_000_000
  const r = rig({ now: () => t })
  const first = await r.svc.refreshDetection()
  assert.equal(first.refreshed, true)
  const n = r.ran.length
  t += 20_000
  const second = await r.svc.refreshDetection()
  assert.equal(second.refreshed, false); assert.equal(r.ran.length, n)
  assert.equal(second.note, 'Refreshed 20 s ago; you can refresh again in 40 s.')
  t += 41_000
  assert.equal((await r.svc.refreshDetection()).refreshed, true)
})

test('probe output is capped at 512 KB and the read is aborted past it; parsed fields are capped too', async () => {
  assert.equal(MAX_PROBE_OUTPUT, 512 * 1024)
  const r = rig()
  await r.svc.refreshDetection()
  for (const x of r.ran.filter(y => y.script === DETECT_CLIENTS_SCRIPT)) assert.equal(x.opts?.maxOutputBytes, MAX_PROBE_OUTPUT)
  // The cap itself: it keeps what fits and says it went over.
  let acc = appendCapped('', 'a'.repeat(10), 16)
  assert.deepEqual(acc, { out: 'a'.repeat(10), over: false })
  acc = appendCapped(acc.out, 'b'.repeat(10), 16)
  assert.equal(acc.out.length, 16); assert.equal(acc.over, true)
  // A probe that came back cut off is an error, not a half-read result.
  const det = new ClientDetector({ listMachines: async () => [NODE], run: async () => ({ code: -1, output: OUT.slice(0, 50), timedOut: false, truncated: true }) })
  await det.refresh()
  assert.match(det.cached().get('node-pve-a')!.error!, /more than 512 KB/)
  // Fields: no string longer than 255, no list longer than 64.
  const huge = OUT.replace('x.tail0000.ts.net.', `${'x'.repeat(5000)}.ts.net.`)
  const d = parseDetection(huge).tailscale
  assert.ok(d.dnsName!.length <= 255)
  const routes = OUT.replace('HP_TS_STATUS_END', `HP_TS_STATUS_END\nHP_PREFS_BEGIN\n\t"AdvertiseRoutes": ${JSON.stringify(Array.from({ length: 500 }, (_, i) => `10.${i >> 8}.${i & 255}.0/24`))},\nHP_PREFS_END`)
  assert.ok(parseDetection(routes).tailscale.advertisedRoutes.length <= 64)
})

test('its own container is found by its MAC or address in the guest configs, not by name', () => {
  const machines: Machine[] = [NODE, { ...SECRET_CT, name: 'hyperprox' }, { ...WEB, name: 'renamed-anything' }, { id: 'qemu-140', kind: 'qemu', name: 'vm', node: 'pve-a', vmid: 140, running: true }]
  const configs: Record<string, Record<string, unknown>> = {
    'lxc-130': { net0: 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:01,ip=192.0.2.30/24,type=veth' },
    'lxc-132': { net0: 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:02,ip=dhcp,type=veth' },
    'qemu-140': { net0: 'virtio=BC:24:11:00:00:03,bridge=vmbr0' },
  }
  const cfg = async (m: Machine) => configs[m.id] ?? {}
  return Promise.all([
    findSelf(machines, cfg, { macs: ['bc:24:11:00:00:02'], ips: ['172.17.0.1'] }).then(id => assert.equal(id, 'lxc-132', 'the MAC decides, whatever the names')),
    findSelf(machines, cfg, { macs: ['02:42:ac:11:00:02'], ips: ['192.0.2.30'] }).then(id => assert.equal(id, 'lxc-130', 'a static address when no MAC matches')),
    findSelf(machines, cfg, { macs: ['bc:24:11:00:00:03'], ips: [] }).then(id => assert.equal(id, 'qemu-140', 'a VM too')),
    findSelf(machines, cfg, { macs: ['00:00:00:00:00:00'], ips: ['198.51.100.9'] }).then(id => assert.equal(id, null, 'no match: nothing assumed')),
    findSelf([...machines, { ...WEB, id: 'lxc-133', vmid: 133 }], async m => (m.id === 'lxc-133' ? configs['lxc-132'] : cfg(m)), { macs: ['bc:24:11:00:00:02'], ips: [] }).then(id => assert.equal(id, null, 'two matches: nothing assumed')),
  ]).then(() => undefined)
})

test('no job runs before HyperProx knows which container is its own, and then never on it', async () => {
  let release!: (v: string | null) => void
  const r = rig({ selfId: () => new Promise(res => { release = res }) })
  const job = r.svc.startJob({ action: 'check', provider: 'tailscale', machineIds: ['lxc-132'] }, 'a')
  await new Promise(res => setTimeout(res, 30))
  assert.equal(r.svc.getJob(job.id)!.status, 'running')
  assert.ok(!r.ran.some(x => x.m === 'lxc-132'), 'waiting for the self check')
  release('lxc-132')
  const done = await settle(r.svc, job)
  assert.equal(done.status, 'failed'); assert.match(done.error ?? '', /this HyperProx/)
  assert.ok(!r.ran.some(x => x.m === 'lxc-132'))
  const ov = await r.svc.overview()
  assert.equal(ov.machines.find(m => m.id === 'lxc-132')!.self, true)
})
