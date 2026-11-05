// End to end, opt-in (HP_E2E_DOCKER=1; Docker, internet and the wireguard kernel module): two throwaway Debian
// containers form a WireGuard tunnel through HyperProx's own flow and ping each other across it. A phone peer
// is added with a keypair made here (as a browser would), and its private key is checked to be in the vault
// item only: not in either container, not in the store, not in any log.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { RemoteAccessService } from '../src/lib/remote/service'
import { MemoryRemoteStore } from '../src/lib/remote/store'
import type { RemoteExecutor } from '../src/lib/remote/executor'
import type { Machine } from '../src/lib/remote/types'
import { WireguardService, type WgVault } from '../src/lib/vpn/wireguard/service'
import { MemoryWgStore } from '../src/lib/vpn/wireguard/store'
import { wgPingScript } from '../src/lib/vpn/wireguard/scripts'

const ENABLED = process.env.HP_E2E_DOCKER === '1'
const TAG = randomBytes(4).toString('hex')
const NET = `hp-wg-e2e-${TAG}`
const A = `hp-wg-e2e-a-${TAG}`, B = `hp-wg-e2e-b-${TAG}`
const IMAGE = process.env.HP_E2E_IMAGE ?? 'debian:trixie'

function docker(args: string[], input?: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { out += d })
    p.on('error', reject); p.on('close', code => resolve({ code: code ?? -1, output: out }))
    p.stdin.end(input ?? '')
  })
}

const NODE_SNAPSHOT = ['HP_ROUTE4 default via 192.0.2.1 dev vmbr0', 'HP_RULE4 32766: from all lookup main', 'HP_RESOLV_LINK=/etc/resolv.conf',
  'HP_RESOLV=nameserver 192.0.2.1;', 'HP_RESOLVED=inactive', 'HP_FWSRC nft present', 'HP_FWL nft table inet filter {', 'HP_FWL nft }',
  'HP_FWD4=0', 'HP_FWD6=0', 'HP_NET corosync 192.0.2.12', 'HP_NET own 192.0.2.11/24', 'HP_QUORATE=Yes', 'HP_SNAPSHOT_END'].join('\n')
const NODE: Machine = { id: 'node-pve-test', kind: 'node', name: 'pve-test', node: 'pve-test', running: true, address: '192.0.2.11' }
const MA: Machine = { id: 'lxc-991', kind: 'lxc', name: 'wg-server', node: 'pve-test', vmid: 991, running: true }
const MB: Machine = { id: 'lxc-992', kind: 'lxc', name: 'wg-client', node: 'pve-test', vmid: 992, running: true }
const NAMES: Record<string, string> = { 'lxc-991': A, 'lxc-992': B }

const exec: RemoteExecutor = {
  listMachines: async () => [NODE, MA, MB],
  run: async (m, script, o) => {
    if (m.kind === 'node') return { code: 0, output: NODE_SNAPSHOT, timedOut: false }
    const r = await docker(['exec', '-i', NAMES[m.id], 'bash', '-s'], script)
    o?.onData?.(r.output)
    return { code: r.code, output: r.output, timedOut: false }
  },
  lxcConfig: async () => ({}), setLxcConfig: async () => undefined,
  firewallState: async () => ({ clusterEnabled: false, rules: [] }), addFirewallRule: async () => undefined,
  hostKeyTarget: async () => ({ host: '127.0.0.1', port: 22 }), probeHostKey: async () => 'x', pinnedHostKey: async () => 'x', pinHostKey: async () => undefined,
}

before(async () => {
  if (!ENABLED) return
  execFileSync('docker', ['pull', '-q', IMAGE], { stdio: 'ignore' })
  execFileSync('docker', ['network', 'create', '--label', 'hyperprox-test=wg-e2e', NET], { stdio: 'ignore' })
  for (const n of [A, B]) {
    execFileSync('docker', ['run', '-d', '--rm', '--name', n, '--network', NET, '--cap-add', 'NET_ADMIN', '--label', 'hyperprox-test=wg-e2e', IMAGE, 'sleep', '3600'], { stdio: 'ignore' })
    const r = await docker(['exec', '-i', n, 'bash', '-s'], 'set -e\nexport DEBIAN_FRONTEND=noninteractive\napt-get update -qq\napt-get install -y -qq iproute2 iputils-ping procps >/dev/null\n# Docker runs no init: a marker for the OS check and a systemctl that does nothing (wg-quick is run directly).\nmkdir -p /run/systemd/system\nprintf "#!/bin/sh\\nexit 0\\n" > /usr/local/sbin/systemctl && chmod +x /usr/local/sbin/systemctl')
    assert.equal(r.code, 0, r.output)
  }
})

after(async () => {
  if (!ENABLED) return
  for (const n of [A, B]) { try { execFileSync('docker', ['rm', '-f', n], { stdio: 'ignore' }) } catch { /* gone */ } }
  try { execFileSync('docker', ['network', 'rm', NET], { stdio: 'ignore' }) } catch { /* gone */ }
})

test('e2e: a server and a client form a tunnel through HyperProx and ping each other; a phone key lives only in the vault', { skip: !ENABLED, timeout: 15 * 60_000 }, async () => {
  const ipA = (await docker(['inspect', '-f', `{{(index .NetworkSettings.Networks "${NET}").IPAddress}}`, A])).output.trim()
  const items = new Map<string, Record<string, string>>()
  const vault: WgVault = { put: async (i, f) => { items.set(i, { ...f }) }, get: async i => ({ ...(items.get(i) ?? {}) }), remove: async i => { items.delete(i) } }
  const store = new MemoryWgStore()
  const remote = new RemoteAccessService({ store: new MemoryRemoteStore(), exec, provider: async () => null, providerSettings: async () => ({ tags: [] }), settleMs: 0 })
  const svc = new WireguardService({ remote, exec, store, vault })

  const server = await svc.createServer({ machineId: 'lxc-991', address: '100.64.30.1/24', endpoint: `${ipA}:51820` }, 'e2e')
  const client = await svc.connectMachine({ machineId: 'lxc-992', serverId: server.id, allowedIps: ['100.64.30.0/24'], keepalive: 5 }, 'e2e')

  const pingB = await docker(['exec', '-i', B, 'bash', '-s'], wgPingScript('100.64.30.1'))
  const diag = async () => (await Promise.all([A, B].map(async n => `== ${n}\n${(await docker(['exec', n, 'bash', '-c', 'wg show; ip -br addr; ip route; cat /etc/wireguard/*.conf'])).output}`))).join('\n')
  assert.match(pingB.output, /HP_WG_PING_OK/, `client reaches the server across the tunnel\n${pingB.output.includes('OK') ? '' : await diag()}`)
  const pingA = await docker(['exec', '-i', A, 'bash', '-s'], wgPingScript(client.peer.address.split('/')[0]))
  assert.match(pingA.output, /HP_WG_PING_OK/, 'server reaches the client across the tunnel')
  const st = await svc.serverStatus(server.id)
  assert.equal(st.up, true)
  assert.ok(st.peers.find(p => p.id === client.peer.id)?.live?.latestHandshake, 'a handshake happened')

  // A phone: keypair made here, as the browser does.
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  const priv = Buffer.from((privateKey.export({ format: 'jwk' }) as any).d, 'base64url').toString('base64')
  const pub = Buffer.from((publicKey.export({ format: 'jwk' }) as any).x, 'base64url').toString('base64')
  const phone = await svc.addDevice(server.id, { name: 'phone', publicKey: pub, privateKey: priv }, 'e2e')
  assert.equal(items.get(`peer-${phone.peer.id}`)?.private_key, priv)
  for (const n of [A, B]) {
    const g = await docker(['exec', n, 'bash', '-c', `grep -rIl --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev -F '${priv}' / 2>/dev/null; true`])
    assert.equal(g.output.trim(), '', `the phone's private key is not on ${n}`)
  }
  assert.ok(!JSON.stringify([await store.listPeers(), await store.listServers(), store.audits]).includes(priv))
  // The machines' own private keys never came back to HyperProx.
  for (const [n, i] of [[A, 'hp-wg0'], [B, 'hp-wg1']] as const) {
    const k = (await docker(['exec', n, 'cat', `/etc/wireguard/${i}.key`])).output.trim()
    assert.ok(k.length === 44)
    assert.ok(!JSON.stringify([await store.listPeers(), await store.listServers(), store.audits, client.log, [...items.values()]]).includes(k), `${n}'s key stayed on ${n}`)
  }
  // The other peers stay up while one is removed.
  await svc.removePeer(phone.peer.id, 'e2e')
  assert.match((await docker(['exec', '-i', B, 'bash', '-s'], wgPingScript('100.64.30.1'))).output, /HP_WG_PING_OK/)
})
