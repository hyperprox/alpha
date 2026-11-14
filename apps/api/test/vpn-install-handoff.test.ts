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

function rig(o: { wgUp?: boolean } = {}) {
  const key = pub()
  const ran: string[] = []
  const exec: RemoteExecutor = {
    listMachines: async () => [SELF, WG_CT],
    run: async (m, script) => {
      ran.push(`${m.id}: ${script.split('\n')[0]}`)
      if (script.includes('wg show') && o.wgUp !== false) return { code: 0, output: `HP_WG_PUB=${key}\nHP_WG_PORT=51820\nHP_WG_DUMP_BEGIN\nHP_WG_DUMP_END`, timedOut: false }
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
