// WireGuard service on a fake fleet, a fake vault and a mocked RouterOS REST: servers, phone and laptop
// peers (keys in the vault only), rotation with a seven-day undo, machines connected under the node guard,
// and peers on the MikroTik router that HyperProx marks and never touches otherwise.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { RemoteAccessService } from '../src/lib/remote/service'
import { MemoryRemoteStore } from '../src/lib/remote/store'
import type { RemoteExecutor } from '../src/lib/remote/executor'
import type { Machine } from '../src/lib/remote/types'
import { WireguardService, publicOf, type WgVault } from '../src/lib/vpn/wireguard/service'
import { MemoryWgStore } from '../src/lib/vpn/wireguard/store'
import type { RouterApi } from '../src/lib/vpn/wireguard/routeros'

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  return {
    priv: Buffer.from((privateKey.export({ format: 'jwk' }) as any).d, 'base64url').toString('base64'),
    pub: Buffer.from((publicKey.export({ format: 'jwk' }) as any).x, 'base64url').toString('base64'),
  }
}

const NODE: Machine = { id: 'node-pve-a', kind: 'node', name: 'pve-a', node: 'pve-a', running: true, address: '192.0.2.11' }
const SRV: Machine = { id: 'lxc-120', kind: 'lxc', name: 'wg', node: 'pve-a', vmid: 120, running: true }
const APP: Machine = { id: 'lxc-121', kind: 'lxc', name: 'app', node: 'pve-a', vmid: 121, running: true }
const FACTS = 'HP_OS_ID=debian\nHP_OS_VERSION=13\nHP_OS_CODENAME=trixie\nHP_UNAME=Linux\nHP_PM=apt\nHP_SYSTEMD=1\nHP_TUN=1\nHP_ROOT=1'
const SNAP = (extra = '') => ['HP_ROUTE4 default via 192.0.2.1 dev vmbr0', 'HP_RULE4 32766: from all lookup main', 'HP_RESOLV_LINK=/etc/resolv.conf',
  'HP_RESOLV=nameserver 192.0.2.1;', 'HP_RESOLVED=inactive', 'HP_FWSRC nft present', 'HP_FWL nft table inet filter {', 'HP_FWL nft }',
  'HP_FWD4=0', 'HP_FWD6=0', 'HP_NET corosync 192.0.2.12', 'HP_NET ceph 198.51.100.0/24', 'HP_NET own 192.0.2.11/24', extra, 'HP_QUORATE=Yes', 'HP_SNAPSHOT_END'].join('\n')

/** Each machine keeps its own key, as a real one would; HyperProx only ever sees what the scripts print. */
function fleet() {
  const keys = new Map<string, { priv: string; pub: string }>()
  const confs = new Map<string, string>()
  const ran: Array<{ machine: string; script: string }> = []
  let snapAfter = ''
  const exec: RemoteExecutor = {
    listMachines: async () => [NODE, SRV, APP],
    run: async (m, script, o) => {
      ran.push({ machine: m.id, script })
      const say = (s: string) => { o?.onData?.(s); return { code: 0, output: s, timedOut: false } }
      if (script.includes('HP_BUSY=')) return say('HP_BUSY=')
      // The change shows only once the interface exists on that machine.
      if (script.includes('HP_SNAPSHOT_END')) return say([...confs.keys()].some(k => k.startsWith(`${m.id}/`)) ? SNAP(snapAfter) : SNAP())
      if (script.includes('HP_OS_ID=')) return say(FACTS)
      if (script.includes('HP_WG_VERSION')) return say('HP_WG_VERSION=wireguard-tools v1.0.20210914')
      if (script.includes('hp_k=$(wg genkey)')) { const k = keypair(); return say(`HP_WG_PRIV=${k.priv}\nHP_WG_PUB=${k.pub}`) }
      const iface = /\/etc\/wireguard\/(hp-wg\d+)\./.exec(script)?.[1] ?? /wg show (hp-wg\d+)/.exec(script)?.[1] ?? 'hp-wg0'
      const id = `${m.id}/${iface}`
      if (script.includes('wg genkey >')) { if (!keys.has(id)) keys.set(id, keypair()); return say(`HP_WG_PUB=${keys.get(id)!.pub}`) }
      if (script.includes('HP_WG_PRIV=$(cat')) return say(`HP_WG_PRIV=${keys.get(id)!.priv}`)
      if (script.includes('HP_WG\n')) { confs.set(id, /<<'HP_WG'\n([\s\S]*?)\nHP_WG/.exec(script)?.[1] ?? ''); return say(`HP_WG_PUB=${keys.get(id)?.pub}\nHP_WG_PORT=51820\nHP_WG_DUMP_BEGIN\nHP_WG_DUMP_END`) }
      if (script.includes('wg show')) return say(`HP_WG_PUB=${keys.get(id)?.pub}\nHP_WG_PORT=51820\nHP_WG_DUMP_BEGIN\nHP_WG_DUMP_END`)
      if (script.startsWith('cat /etc/wireguard')) return say('')
      if (script.includes('HP_WG_GONE')) { confs.delete(id); return say('HP_WG_GONE') }
      return say('ok')
    },
    lxcConfig: async () => ({}), setLxcConfig: async () => undefined,
    firewallState: async () => ({ clusterEnabled: false, rules: [] }), addFirewallRule: async () => undefined,
    hostKeyTarget: async () => ({ host: '192.0.2.11', port: 22 }), probeHostKey: async () => 'x', pinnedHostKey: async () => 'x', pinHostKey: async () => undefined,
  }
  return { exec, keys, confs, ran, setSnapAfter: (s: string) => { snapAfter = s } }
}

function vault(): WgVault & { items: Map<string, Record<string, string>> } {
  const items = new Map<string, Record<string, string>>()
  return {
    items,
    put: async (i, f) => { items.set(i, { ...f }) },
    get: async i => ({ ...(items.get(i) ?? {}) }),
    remove: async i => { items.delete(i) },
  }
}

function router(o: { write?: boolean } = {}) {
  const rif = keypair()
  const state = {
    interfaces: [{ '.id': '*1', name: 'wg-home', 'listen-port': '13231', 'public-key': rif.pub, 'private-key': 'ROUTER-PRIVATE-NEVER', running: 'true', disabled: 'false' }],
    peers: [{ '.id': '*A', interface: 'wg-home', 'public-key': keypair().pub, 'allowed-address': '192.0.2.50/32', comment: 'my laptop', 'preshared-key': 'PSK-NEVER', 'last-handshake': '1m2s', rx: '10', tx: '20' }] as any[],
    rules: [{ '.id': '*10', chain: 'input', action: 'accept', 'connection-state': 'established,related' }, { '.id': '*11', chain: 'input', action: 'drop', 'in-interface-list': '!LAN' }] as any[],
    writes: [] as string[],
  }
  let n = 0
  const api: RouterApi = {
    read: async path => (path.endsWith('/interface/wireguard') ? state.interfaces : path.endsWith('/peers') ? state.peers : state.rules),
    write: o.write ? {
      put: async (path, body) => {
        state.writes.push(`PUT ${path} ${JSON.stringify(body)}`)
        const row = { '.id': `*B${++n}`, ...body }
        if (path.endsWith('/peers')) state.peers.push(row); else { const i = state.rules.findIndex(r => r['.id'] === body['place-before']); state.rules.splice(i < 0 ? state.rules.length : i, 0, row) }
        return row
      },
      del: async path => { state.writes.push(`DELETE ${path}`); state.peers = state.peers.filter(p => !path.endsWith(encodeURIComponent(p['.id']))) },
    } : null,
  }
  return { api, state, routerPub: rif.pub }
}

function rig(o: { write?: boolean; now?: () => number } = {}) {
  const f = fleet()
  const v = vault()
  const r = router(o)
  const store = new MemoryWgStore()
  const remote = new RemoteAccessService({ store: new MemoryRemoteStore(), exec: f.exec, provider: async () => null, providerSettings: async () => ({ tags: [] }), settleMs: 0, sleep: async () => undefined })
  const svc = new WireguardService({ remote, exec: f.exec, store, vault: v, router: async () => r.api, now: o.now })
  return { f, v, r, store, svc }
}

const server = (x: ReturnType<typeof rig>) => x.svc.createServer({ machineId: 'lxc-120', address: '100.64.10.1/24', endpoint: 'vpn.example.com:51820' }, 'admin@example.com')

test('a server is made in a container with its own key; never on a node', async () => {
  const x = rig()
  const s = await server(x)
  assert.equal(s.publicKey, x.f.keys.get('lxc-120/hp-wg0')!.pub)
  assert.doesNotMatch(JSON.stringify(await x.store.listServers()), new RegExp(x.f.keys.get('lxc-120/hp-wg0')!.priv.replace(/[+/]/g, '.')))
  await assert.rejects(x.svc.createServer({ machineId: 'node-pve-a', address: '100.64.10.1/24', endpoint: 'vpn.example.com:51820' }, 'a'), /never on a Proxmox node/)
})

test('a phone peer: the browser keypair and config go to one vault item and nowhere else; the config is shown once', async () => {
  const x = rig()
  const s = await server(x)
  const k = keypair()
  const out = await x.svc.addDevice(s.id, { name: 'phone', publicKey: k.pub, privateKey: k.priv }, 'admin@example.com')
  assert.match(out.config, new RegExp(`PrivateKey = ${k.priv.replace(/[+/]/g, '.')}`))
  assert.equal(out.peer.address, '100.64.10.2/32')
  assert.equal(x.v.items.get(`peer-${out.peer.id}`)?.private_key, k.priv)
  const elsewhere = JSON.stringify([await x.store.listPeers(), await x.store.listServers(), x.store.audits, x.f.ran.map(r => r.script)])
  assert.ok(!elsewhere.includes(k.priv), 'the private key is in the vault item only')
  assert.match(x.f.confs.get('lxc-120/hp-wg0') ?? '', new RegExp(k.pub.replace(/[+/]/g, '.')), 'the server knows its public key')
  await assert.rejects(x.svc.addDevice(s.id, { name: 'bad', publicKey: keypair().pub, privateKey: k.priv }, 'a'), /does not belong/)
  const again = await x.svc.revealDevice(out.peer.id, 'admin@example.com')
  assert.equal(again.config, out.config)
  assert.ok(x.store.audits.some(a => a.action === 'wireguard.vault.read' && !JSON.stringify(a).includes(k.priv)))
})

test('a browser that cannot make keys: the server container makes them, in output that is never logged', async () => {
  const x = rig()
  const s = await server(x)
  const out = await x.svc.addDevice(s.id, { name: 'old-tablet', keygen: 'server' }, 'a')
  const priv = x.v.items.get(`peer-${out.peer.id}`)!.private_key
  assert.equal(publicOf(priv), out.peer.publicKey)
  assert.ok(!JSON.stringify([await x.store.listPeers(), x.store.audits]).includes(priv))
})

test('rotation replaces the vault item, keeps the previous key seven days marked rotated, can be undone, then is deleted', async () => {
  let now = Date.parse('2026-11-05T10:00:00Z')
  const x = rig({ now: () => now })
  const s = await server(x)
  const k1 = keypair(), k2 = keypair()
  const { peer } = await x.svc.addDevice(s.id, { name: 'laptop', publicKey: k1.pub, privateKey: k1.priv }, 'a')
  const rot = await x.svc.rotateDevice(peer.id, { publicKey: k2.pub, privateKey: k2.priv }, 'a')
  let item = x.v.items.get(`peer-${peer.id}`)!
  assert.equal(item.private_key, k2.priv); assert.equal(item.previous_private_key, k1.priv); assert.equal(item.status_previous, 'rotated')
  assert.equal(rot.peer.previousPublicKey, k1.pub)
  assert.match(x.f.confs.get('lxc-120/hp-wg0')!, new RegExp(k2.pub.replace(/[+/]/g, '.')))
  assert.doesNotMatch(x.f.confs.get('lxc-120/hp-wg0')!, new RegExp(k1.pub.replace(/[+/]/g, '.')), 'only the new key is accepted')
  await x.svc.rollbackRotation(peer.id, 'a')
  assert.equal(x.v.items.get(`peer-${peer.id}`)!.private_key, k1.priv)
  assert.match(x.f.confs.get('lxc-120/hp-wg0')!, new RegExp(k1.pub.replace(/[+/]/g, '.')))
  await x.svc.rotateDevice(peer.id, { publicKey: k2.pub, privateKey: k2.priv }, 'a')
  now += 6 * 86400_000
  assert.equal(await x.svc.sweepRotations(), 0)
  now += 2 * 86400_000
  assert.equal(await x.svc.sweepRotations(), 1)
  item = x.v.items.get(`peer-${peer.id}`)!
  assert.equal(item.previous_private_key, undefined)
  assert.equal(item.private_key, k2.priv)
  await assert.rejects(x.svc.rollbackRotation(peer.id, 'a'), /no rotation to undo/)
})

test('removing a peer removes it from the server and its vault item', async () => {
  const x = rig()
  const s = await server(x)
  const k = keypair()
  const { peer } = await x.svc.addDevice(s.id, { name: 'phone', publicKey: k.pub, privateKey: k.priv }, 'a')
  await x.svc.removePeer(peer.id, 'a')
  assert.equal(x.v.items.has(`peer-${peer.id}`), false)
  assert.doesNotMatch(x.f.confs.get('lxc-120/hp-wg0')!, new RegExp(k.pub.replace(/[+/]/g, '.')))
})

test('the opt-in server key backup goes to the vault, and only then is it marked', async () => {
  const x = rig()
  const s = await server(x)
  await x.svc.backupServerKey(s.id, 'a')
  assert.equal(x.v.items.get(`server-${s.id}`)?.private_key, x.f.keys.get('lxc-120/hp-wg0')!.priv)
  assert.equal((await x.store.getServer(s.id))?.keyBackedUp, true)
  assert.ok(!JSON.stringify([await x.store.listServers(), x.store.audits]).includes(x.f.keys.get('lxc-120/hp-wg0')!.priv))
})

test('a node is connected under the guard: never its default route, never a cluster network', async () => {
  const x = rig()
  const s = await server(x)
  await assert.rejects(x.svc.connectMachine({ machineId: 'node-pve-a', serverId: s.id, allowedIps: ['0.0.0.0/0'] }, 'a'), /never routes its default/)
  await assert.rejects(x.svc.connectMachine({ machineId: 'node-pve-a', serverId: s.id, allowedIps: ['198.51.100.0/24'] }, 'a'), /overlaps the cluster network/)
  const ok = await x.svc.connectMachine({ machineId: 'node-pve-a', serverId: s.id, allowedIps: ['100.64.10.0/24'] }, 'a')
  assert.equal(ok.peer.kind, 'machine')
  const node = x.f.ran.filter(r => r.machine === 'node-pve-a').map(r => r.script)
  assert.ok(node.filter(sc => sc.includes('HP_SNAPSHOT_END')).length >= 2, 'snapshot before and after')
  assert.match(x.f.confs.get('lxc-120/hp-wg0')!, new RegExp(x.f.keys.get('node-pve-a/hp-wg1')!.pub.replace(/[+/]/g, '.')))
  assert.ok(!JSON.stringify(await x.store.listPeers()).includes(x.f.keys.get('node-pve-a/hp-wg1')!.priv))
})

test('a node never routes a large share through WireGuard; a declared remote site may be larger, and must pass the overlap checks', async () => {
  const x = rig()
  const s = await server(x)
  await assert.rejects(x.svc.connectMachine({ machineId: 'node-pve-a', serverId: s.id, allowedIps: ['100.64.10.0/24', '0.0.0.0/2', '64.0.0.0/2', '128.0.0.0/2', '192.0.0.0/2'] }, 'a'), /default route/)
  await assert.rejects(x.svc.connectMachine({ machineId: 'node-pve-a', serverId: s.id, allowedIps: ['100.64.10.0/24', '10.0.0.0/8', '11.0.0.0/8'] }, 'a'), /more than a \/8/)
  await assert.rejects(x.svc.connectMachine({ machineId: 'node-pve-a', serverId: s.id, allowedIps: ['100.64.10.0/24'], remoteSubnets: ['198.51.100.0/23'] }, 'a'), /overlaps the cluster network/)
  assert.ok(!x.f.ran.some(r => r.machine === 'node-pve-a' && /wg genkey|<<'HP_WG'|wg-quick up/.test(r.script)), 'refused before anything changed on the node')
  const ok = await x.svc.connectMachine({ machineId: 'node-pve-a', serverId: s.id, allowedIps: ['100.64.10.0/24'], remoteSubnets: ['20.0.0.0/7'] }, 'a')
  assert.deepEqual(ok.peer.clientAllowedIps, ['100.64.10.0/24', '20.0.0.0/7'])
  assert.match(x.f.confs.get('node-pve-a/hp-wg1')!, /AllowedIPs = 100\.64\.10\.0\/24, 20\.0\.0\.0\/7/)
})

test('a node change that moves its routes is rolled back and the interface removed', async () => {
  const x = rig()
  const s = await server(x)
  x.f.setSnapAfter('HP_ROUTE4 0.0.0.0/1 dev hp-wg1')
  await assert.rejects(x.svc.connectMachine({ machineId: 'node-pve-a', serverId: s.id, allowedIps: ['100.64.10.0/24'] }, 'a'), /Rolled back/)
  assert.ok(x.f.ran.some(r => r.machine === 'node-pve-a' && r.script.includes('HP_WG_GONE')))
})

test('a rebuilt machine gets a new key, and its server peer is updated, keeping its address', async () => {
  const x = rig()
  const s = await server(x)
  const first = await x.svc.connectMachine({ machineId: 'lxc-121', serverId: s.id, allowedIps: ['100.64.10.0/24'] }, 'a')
  const old = x.f.keys.get('lxc-121/hp-wg1')!.pub
  x.f.keys.delete('lxc-121/hp-wg1')   // rebuilt: the key file is gone
  const again = await x.svc.connectMachine({ machineId: 'lxc-121', serverId: s.id, allowedIps: ['100.64.10.0/24'] }, 'a')
  assert.equal(again.peer.id, first.peer.id); assert.equal(again.peer.address, first.peer.address)
  assert.notEqual(again.peer.publicKey, old)
  const conf = x.f.confs.get('lxc-120/hp-wg0')!
  assert.match(conf, new RegExp(again.peer.publicKey.replace(/[+/]/g, '.'))); assert.doesNotMatch(conf, new RegExp(old.replace(/[+/]/g, '.')))
})

// ── The router ───────────────────────────────────────────────────────────────

test('router view: interfaces and peers with handshakes; private and preshared keys never come back', async () => {
  const x = rig()
  const v = await x.svc.routerView()
  assert.equal(v.interfaces[0].name, 'wg-home'); assert.equal(v.interfaces[0].listenPort, 13231)
  assert.equal(v.peers[0].lastHandshake, '1m2s'); assert.equal(v.peers[0].managed, false)
  assert.doesNotMatch(JSON.stringify(v), /NEVER/)
  assert.equal(v.writable, false)
  assert.match(v.setup!.join('\n'), /\/user group add name=hyperprox-wg policy=read,write,api,rest-api/)
  assert.doesNotMatch(v.setup!.join('\n'), /full|policy=.*(ssh|ftp|policy|sensitive)/)
  assert.equal(v.interfaces[0].firewallOk, false)
  assert.match(v.interfaces[0].firewallCommand!, /\/ip firewall filter add chain="input" action="accept" protocol="udp" dst-port="13231" comment="wg-wg-home"/)
})

test('router without the limited write login: read-only, and says how to get it', async () => {
  const x = rig()
  await assert.rejects(x.svc.addRouterPeer({ iface: 'wg-home', publicKey: keypair().pub, allowedAddress: ['100.64.20.60/32'], id: 'x', name: 'n' }, 'a'), /no write access.*commands shown/)
  assert.equal(x.r.state.writes.length, 0)
})

test('router with write access: a phone peer is added marked hyperprox:, read back, and its config kept in the vault', async () => {
  const x = rig({ write: true })
  const k = keypair()
  const pv = await x.svc.routerPeerPreview({ iface: 'wg-home', publicKey: k.pub, allowedAddress: ['100.64.20.60/32'], name: 'phone' })
  assert.match(pv.command, /\/interface wireguard peers add interface="wg-home"/); assert.equal(x.r.state.writes.length, 0, 'a preview writes nothing')
  const out = await x.svc.addRouterDevice({ iface: 'wg-home', endpoint: 'home.example.com:13231', address: '100.64.20.60/32', allowedIps: ['100.64.10.0/24'], name: 'phone', publicKey: k.pub, privateKey: k.priv }, 'a')
  assert.equal(x.r.state.writes.length, 1)
  assert.match(x.r.state.writes[0], /"comment":"hyperprox:/)
  assert.doesNotMatch(x.r.state.writes[0], new RegExp(k.priv.replace(/[+/]/g, '.')), 'the router never gets the private key')
  assert.match(out.config, new RegExp(`PublicKey = ${x.r.routerPub.replace(/[+/]/g, '.')}`))
  assert.equal(x.v.items.get(`peer-${out.peer.id}`)?.private_key, k.priv)
  await x.svc.removePeer(out.peer.id, 'a')
  assert.match(x.r.state.writes.at(-1)!, /^DELETE /)
  await assert.rejects(x.svc.removeRouterPeer('*A', 'a'), /was not created by HyperProx/)
  assert.ok(x.r.state.peers.some(p => p['.id'] === '*A'), 'the owner\'s own peer is untouched')
})

test('connect this machine to the router: key on the machine, peer on the router, site-to-site checked', async () => {
  const x = rig({ write: true })
  await assert.rejects(x.svc.connectMachine({ machineId: 'lxc-121', router: { iface: 'wg-home', endpoint: 'home.example.com:13231', address: '100.64.20.61/32' }, allowedIps: ['100.64.10.0/24'], siteSubnets: ['198.51.100.0/25'] }, 'a'), /overlaps the cluster network/)
  const out = await x.svc.connectMachine({ machineId: 'lxc-121', router: { iface: 'wg-home', endpoint: 'home.example.com:13231', address: '100.64.20.61/32' }, allowedIps: ['100.64.10.0/24'], siteSubnets: ['203.0.113.0/24'] }, 'a')
  const added = x.r.state.peers.find(p => p['.id'] === out.peer.routerPeerId)
  assert.equal(added['public-key'], x.f.keys.get('lxc-121/hp-wg1')!.pub)
  assert.equal(added['allowed-address'], '100.64.20.61/32,203.0.113.0/24')
})

test('router firewall: HyperProx never writes it; a missing input rule is shown as a command for the owner', async () => {
  const x = rig({ write: true })
  assert.equal((x.svc as any).routerFirewallAdd, undefined, 'no firewall write exists')
  assert.equal((x.svc as any).routerFirewallPreview, undefined)
  const v = await x.svc.routerView()
  assert.match(v.interfaces[0].firewallCommand!, /^\/ip firewall filter add .*dst-port="13231"/)
  // Every router flow, with write access: only WireGuard peers are ever written.
  const k = keypair()
  const d = await x.svc.addRouterDevice({ iface: 'wg-home', endpoint: 'home.example.com:13231', address: '100.64.20.60/32', allowedIps: ['100.64.10.0/24'], name: 'phone', publicKey: k.pub, privateKey: k.priv }, 'a')
  await x.svc.connectMachine({ machineId: 'lxc-121', router: { iface: 'wg-home', endpoint: 'home.example.com:13231', address: '100.64.20.61/32' }, allowedIps: ['100.64.10.0/24'], siteSubnets: ['203.0.113.0/24'] }, 'a')
  await x.svc.removePeer(d.peer.id, 'a')
  assert.ok(x.r.state.writes.length >= 3)
  for (const w of x.r.state.writes) assert.match(w, /^(PUT|DELETE) \/rest\/interface\/wireguard\/peers(\/| |$)/, w)
})

test('router setup is honest: the write policy is broader than peers, and HyperProx is what limits it', async () => {
  const x = rig()
  const v = await x.svc.routerView()
  assert.match(v.setupNote!, /RouterOS cannot limit a login to WireGuard peers/)
  assert.match(v.setupNote!, /enforced by HyperProx/)
})

test('the REST writer refuses any path but WireGuard peers before it sends anything', async () => {
  const { restWriter } = await import('../src/lib/vpn/wireguard/routeros')
  const w = restWriter({ url: 'http://127.0.0.1:9', insecureTLS: false }, { username: 'u', password: 'p' })
  await assert.rejects(w.put('/rest/ip/firewall/filter', { chain: 'input' }), /only writes WireGuard peers/)
  await assert.rejects(w.put('/rest/ip/address', {}), /only writes WireGuard peers/)
  await assert.rejects(w.del('/rest/ip/route/*1'), /only writes WireGuard peers/)
  await assert.rejects(w.put('/rest/interface/wireguard', {}), /only writes WireGuard peers/)
  await assert.rejects(w.del('/rest/interface/wireguard/peers/../../ip/route/*1'), /only writes WireGuard peers/)
})
