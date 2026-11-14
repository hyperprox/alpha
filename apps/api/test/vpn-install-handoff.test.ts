// Remote access the installer set up, taken over by HyperProx: a marker (data/setup/vpn-pending.json) is fed in,
// the WireGuard server is adopted through WireguardService.adoptServer (status from `wg show` in its container),
// HyperProx's own Tailscale client is recorded in remote access, a second pickup changes nothing, a failure stays
// pending with its error, and a marker that holds a secret is refused whole.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { RemoteAccessService } from '../src/lib/remote/service'
import { MemoryRemoteStore } from '../src/lib/remote/store'
import type { RemoteExecutor } from '../src/lib/remote/executor'
import type { Machine } from '../src/lib/remote/types'
import { WireguardService } from '../src/lib/vpn/wireguard/service'
import { MemoryWgStore } from '../src/lib/vpn/wireguard/store'
import { consumeInstallMarker, parseMarker, pendingEntries, type InstallHandoffDeps } from '../src/lib/vpn/install-handoff'
import { guestStatus } from '../src/lib/remote/vpn-source'

const pub = () => Buffer.from((generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }) as any).x, 'base64url').toString('base64')
const WG_CT: Machine = { id: 'lxc-161', kind: 'lxc', name: 'hyperprox-wg', node: 'pve-a', vmid: 161, running: true }
const SELF: Machine = { id: 'lxc-160', kind: 'lxc', name: 'hyperprox', node: 'pve-a', vmid: 160, running: true }
const NODE: Machine = { id: 'node-pve-a', kind: 'node', name: 'pve-a', node: 'pve-a', running: true, address: '192.0.2.11' }
/** The node's snapshot, as remote access reads it: the cluster's networks are what a tunnel must not overlap. */
const SNAP = (ceph: string) => ['HP_ROUTE4 default via 192.0.2.1 dev vmbr0', 'HP_RULE4 32766: from all lookup main', 'HP_RESOLV_LINK=/etc/resolv.conf',
  'HP_RESOLV=nameserver 192.0.2.1;', 'HP_RESOLVED=inactive', 'HP_FWSRC nft present', 'HP_FWL nft table inet filter {', 'HP_FWL nft }',
  'HP_FWD4=0', 'HP_FWD6=0', 'HP_NET corosync 192.0.2.12', `HP_NET ceph ${ceph}`, 'HP_NET own 192.0.2.11/24', 'HP_QUORATE=Yes', 'HP_SNAPSHOT_END'].join('\n')

function rig(o: { wgUp?: boolean; reportKey?: string; reportPort?: number; reportAddr?: string; ceph?: string } = {}) {
  const key = pub()
  const ran: string[] = []
  const exec: RemoteExecutor = {
    listMachines: async () => [NODE, SELF, WG_CT],
    run: async (m, script) => {
      ran.push(`${m.id}: ${script.split('\n')[0]}`)
      if (script.includes('HP_SNAPSHOT_END')) return { code: 0, output: SNAP(o.ceph ?? '198.51.100.0/24'), timedOut: false }
      if (script.includes('wg show') && o.wgUp !== false) {
        return { code: 0, output: `HP_WG_PUB=${o.reportKey ?? key}\nHP_WG_PORT=${o.reportPort ?? 51820}\nHP_WG_ADDR=${o.reportAddr ?? '10.99.0.1/24'}\nHP_WG_DUMP_BEGIN\nHP_WG_DUMP_END`, timedOut: false }
      }
      return { code: 1, output: '', timedOut: false }
    },
  } as unknown as RemoteExecutor
  const remoteStore = new MemoryRemoteStore()
  const wgStore = new MemoryWgStore()
  const remote = new RemoteAccessService({ store: remoteStore, exec, provider: async () => null, providerSettings: async () => ({ tags: [] }), settleMs: 0, sleep: async () => undefined })
  const wg = new WireguardService({ remote, exec, store: wgStore, vault: { put: async () => undefined, get: async () => ({}), remove: async () => undefined } })
  const dir = mkdtempSync(join(tmpdir(), 'hpx-handoff-'))
  const file = join(dir, 'vpn-pending.json')
  let statusCalls = 0
  const deps: InstallHandoffDeps = {
    file, remote: remoteStore,
    wg: { listServers: () => wgStore.listServers(), adoptServer: (x, by) => wg.adoptServer(x, by) },
    tailscaleStatus: async () => { statusCalls++; return { installed: true, connected: true, ip: '100.101.102.103', version: '1.90.1', nodeKey: 'nTEST1CNTRL', hostname: 'hyperprox' } },
  }
  const marker = (entries: unknown[]) => writeFileSync(file, JSON.stringify({ version: 1, source: 'bootstrap', entries }), { mode: 0o600 })
  return { key, ran, remoteStore, wgStore, deps, file, marker, statusCalls: () => statusCalls, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const wgEntry = (key: string) => ({ kind: 'wireguard', ctid: 161, machineId: 'lxc-161', iface: 'hp-wg0', address: '10.99.0.1/24', listenPort: 51820, endpoint: 'vpn.example.com:51820', publicKey: key })
const tsEntry = { kind: 'tailscale', ctid: 160, machineId: 'lxc-160', hostname: 'hyperprox', ip: '100.101.102.103', dnsName: 'hyperprox.example-tailnet.ts.net' }

test('the WireGuard server and HyperProx\'s own tailnet client in the marker become managed entries', async () => {
  const r = rig()
  try {
    r.marker([wgEntry(r.key), tsEntry])
    const res = await consumeInstallMarker(r.deps)
    assert.deepEqual(res.adopted.sort(), ['tailscale on lxc-160', 'wireguard on lxc-161'])
    const servers = await r.wgStore.listServers()
    assert.equal(servers.length, 1)
    assert.equal(servers[0].machineId, 'lxc-161')
    assert.equal(servers[0].publicKey, r.key, 'read from the interface with wg show')
    assert.equal(servers[0].endpoint, 'vpn.example.com:51820')
    assert.ok(r.ran.some(l => l.startsWith('lxc-161')), 'status came from the WireGuard container itself')
    const ts = await r.remoteStore.get('lxc-160', 'tailscale')
    assert.ok(ts)
    assert.equal(ts!.adopted, true)
    assert.equal(ts!.address, '100.101.102.103')
    assert.equal(ts!.connected, true)
    assert.equal(existsSync(r.file), false, 'a marker that is fully taken over is gone')
  } finally { r.cleanup() }
})

test('a second pickup is a no-op, including when the marker comes back', async () => {
  const r = rig()
  try {
    r.marker([wgEntry(r.key), tsEntry])
    await consumeInstallMarker(r.deps)
    const before = { servers: await r.wgStore.listServers(), ts: await r.remoteStore.get('lxc-160', 'tailscale'), calls: r.statusCalls() }
    assert.deepEqual(await consumeInstallMarker(r.deps), { adopted: [], already: [], failed: [], left: 0 }, 'no marker: nothing to do')
    r.marker([wgEntry(r.key), tsEntry])
    const again = await consumeInstallMarker(r.deps)
    assert.deepEqual(again.adopted, [])
    assert.deepEqual(again.already.sort(), ['tailscale on lxc-160', 'wireguard on lxc-161'])
    assert.deepEqual(await r.wgStore.listServers(), before.servers)
    assert.deepEqual(await r.remoteStore.get('lxc-160', 'tailscale'), before.ts)
    assert.equal(r.statusCalls(), before.calls, 'an entry already managed is not even looked at again')
  } finally { r.cleanup() }
})

test('two pickups at once adopt once', async () => {
  const r = rig()
  try {
    r.marker([wgEntry(r.key)])
    await Promise.all([consumeInstallMarker(r.deps), consumeInstallMarker(r.deps)])
    assert.equal((await r.wgStore.listServers()).length, 1)
  } finally { r.cleanup() }
})

test('a server that is not up yet stays pending with its error, to be tried again', async () => {
  const r = rig({ wgUp: false })
  try {
    r.marker([wgEntry(r.key), tsEntry])
    const res = await consumeInstallMarker(r.deps)
    assert.equal(res.failed.length, 1)
    assert.match(res.failed[0].error, /hp-wg0 is not up/)
    assert.equal(res.left, 1)
    const left = pendingEntries(r.file)
    assert.equal(left.length, 1)
    assert.equal(left[0].kind, 'wireguard')
    assert.match(left[0].lastError ?? '', /not up/)
    assert.equal(left[0].attempts, 1)
    assert.equal((await r.wgStore.listServers()).length, 0)
  } finally { r.cleanup() }
})

test('a marker holding a secret, or a malformed entry, is refused', () => {
  const k = pub()
  assert.deepEqual(parseMarker(JSON.stringify({ version: 1, entries: [{ ...wgEntry(k), privateKey: k }] })).entries, [])
  assert.deepEqual(parseMarker(JSON.stringify({ version: 1, entries: [{ ...tsEntry, note: 'tskey-auth-abc' }] })).entries, [])
  const bad = parseMarker(JSON.stringify({ version: 1, entries: [{ ...wgEntry(k), machineId: 'node-pve-a' }, { ...tsEntry, ip: 'x' }, wgEntry(k)] }))
  assert.equal(bad.entries.length, 1, 'only the well-formed entry')
  assert.equal(bad.rejected.length, 2)
})

test('without a Tailscale API key, the VPN view shows HyperProx\'s own tailnet entry: managed, address, MagicDNS name, online', async () => {
  const r = rig()
  try {
    r.marker([tsEntry])
    await consumeInstallMarker(r.deps)
    const exec = { listMachines: async () => [SELF, WG_CT] } as unknown as RemoteExecutor
    const remote = new RemoteAccessService({ store: r.remoteStore, exec, provider: async () => null, providerSettings: async () => ({ tags: [] }), settleMs: 0, sleep: async () => undefined })
    const ov = await remote.overview()
    const row = ov.machines.find(m => m.id === 'lxc-160')!
    const cell = row.cells.tailscale
    assert.equal(cell.managed, true)
    assert.equal(cell.state, 'connected')
    assert.equal(cell.ip, '100.101.102.103')
    assert.equal(cell.dnsName, 'hyperprox.example-tailnet.ts.net')
    const st = guestStatus(row)
    assert.equal(st.state, 'connected')
    assert.doesNotMatch(st.detail ?? '', /not managed/)
    await remote.close()
  } finally { r.cleanup() }
})

for (const [what, o, why] of [
  ['another public key', { reportKey: pub() }, /another public key/],
  ['another port', { reportPort: 51821 }, /listens on port 51821, not 51820/],
  ['another address', { reportAddr: '10.98.0.1/24' }, /has the address 10\.98\.0\.1\/24, not 10\.99\.0\.1\/24/],
] as const) {
  test(`an interface that reports ${what} than the marker is not adopted, and stays pending with the reason`, async () => {
    const r = rig(o)
    try {
      r.marker([wgEntry(r.key)])
      const res = await consumeInstallMarker(r.deps)
      assert.deepEqual(res.adopted, [])
      assert.match(res.failed[0].error, why)
      assert.equal((await r.wgStore.listServers()).length, 0)
      assert.match(pendingEntries(r.file)[0].lastError ?? '', why)
    } finally { r.cleanup() }
  })
}

test('a tunnel address that overlaps a cluster network is refused before anything is recorded', async () => {
  const r = rig({ ceph: '10.99.0.0/16' })
  try {
    r.marker([wgEntry(r.key)])
    const res = await consumeInstallMarker(r.deps)
    assert.match(res.failed[0].error, /10\.99\.0\.1\/24 overlaps the cluster network 10\.99\.0\.0\/16/)
    assert.ok(!r.ran.some(l => l.startsWith('lxc-161')), 'refused before the container is even read')
    assert.equal((await r.wgStore.listServers()).length, 0)
  } finally { r.cleanup() }
})

test('a marker with nothing usable in it is kept as it is, not deleted', async () => {
  const r = rig()
  try {
    const bad = JSON.stringify({ version: 1, entries: [{ ...tsEntry, ip: 'not-an-ip' }] })
    writeFileSync(r.file, bad)
    const res = await consumeInstallMarker(r.deps)
    assert.equal(res.failed.length, 1)
    assert.equal(readFileSync(r.file, 'utf8'), bad)
  } finally { r.cleanup() }
})

test('a record\'s own last check stands in only while fresh and while the guest runs; older than a day it is unknown', async () => {
  const r = rig()
  try {
    r.marker([tsEntry])
    await consumeInstallMarker(r.deps)
    const rec = (await r.remoteStore.get('lxc-160', 'tailscale'))!
    const at = rec.checkedAt!.getTime()
    const overview = async (now: number, running = true) => {
      const exec = { listMachines: async () => [{ ...SELF, running }, WG_CT] } as unknown as RemoteExecutor
      const remote = new RemoteAccessService({ store: r.remoteStore, exec, provider: async () => null, providerSettings: async () => ({ tags: [] }), settleMs: 0, sleep: async () => undefined, now: () => now })
      const cell = (await remote.overview()).machines.find(m => m.id === 'lxc-160')!.cells.tailscale
      await remote.close()
      return cell
    }
    const fresh = await overview(at + 60_000)
    assert.equal(fresh.state, 'connected')
    assert.equal(fresh.checkedAt, new Date(at).toISOString(), 'the check\'s own time, so its age shows')
    assert.match(fresh.detectedText ?? '', /last checked: connected/)
    const stale = await overview(at + 25 * 3600_000)
    assert.equal(stale.state, 'unknown')
    assert.match(stale.detectedText ?? '', /last known, over a day ago: connected/)
    assert.equal((await overview(at + 60_000, false)).state, 'unknown', 'a stopped guest is not shown connected')
  } finally { r.cleanup() }
})
