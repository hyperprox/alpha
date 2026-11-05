// WireGuard config and scripts: what is written to a machine, what a node may route, and that no private
// key is ever in a file HyperProx writes, on a command line, or read back from `wg show`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { checkAllowedIps, checkSpec, nextAddress, parseDump, renderClientConfig, renderInterface } from '../src/lib/vpn/wireguard/config'
import { isWgKey } from '../src/lib/vpn/wireguard/keys'
import { wgApplyScript, wgKeyScript, wgRestoreScript, wgStatusScript, SERVER_KEYGEN_SCRIPT, wgKeyRestoreScript } from '../src/lib/vpn/wireguard/scripts'
import { publicOf } from '../src/lib/vpn/wireguard/service'

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  const d = (privateKey.export({ format: 'jwk' }) as any).d, x = (publicKey.export({ format: 'jwk' }) as any).x
  return { priv: Buffer.from(d, 'base64url').toString('base64'), pub: Buffer.from(x, 'base64url').toString('base64') }
}

test('keys: WireGuard keys are 32-byte base64; a browser keypair is checked to belong together', () => {
  const k = keypair()
  assert.ok(isWgKey(k.priv) && isWgKey(k.pub))
  assert.equal(publicOf(k.priv), k.pub)
  assert.notEqual(publicOf(keypair().priv), k.pub)
  assert.ok(!isWgKey('not-a-key=')); assert.ok(!isWgKey(k.pub.slice(1)))
})

test('the interface file never carries a private key: wg-quick loads it from the machine\'s own key file', () => {
  const k = keypair()
  const f = renderInterface({ iface: 'hp-wg0', address: '192.0.2.1/24', listenPort: 51820, peers: [{ publicKey: k.pub, allowedIps: ['192.0.2.2/32'], keepalive: 25 }] })
  assert.doesNotMatch(f, /PrivateKey/)
  assert.match(f, /PostUp = wg set %i private-key \/etc\/wireguard\/hp-wg0\.key/)
  assert.match(f, /AllowedIPs = 192\.0\.2\.2\/32/); assert.match(f, /PersistentKeepalive = 25/)
  const c = renderClientConfig({ privateKey: k.priv, address: '192.0.2.2/32', serverPublicKey: k.pub, endpoint: 'vpn.example.com:51820', allowedIps: ['192.0.2.0/24'] })
  assert.match(c, /^\[Interface\]\nPrivateKey = /)
  assert.match(c, /Endpoint = vpn\.example\.com:51820/)
})

test('every value that reaches a file is checked', () => {
  const k = keypair()
  const ok = { iface: 'hp-wg0', address: '192.0.2.1/24', listenPort: 51820, peers: [{ publicKey: k.pub, allowedIps: ['192.0.2.2/32'] }] }
  assert.equal(checkSpec(ok), null)
  assert.match(checkSpec({ ...ok, iface: 'eth0' }) ?? '', /hp-wg0/)
  assert.match(checkSpec({ ...ok, iface: 'hp-wg0; reboot' }) ?? '', /hp-wg0/)
  assert.match(checkSpec({ ...ok, address: '192.0.2.1' }) ?? '', /prefix/)
  assert.match(checkSpec({ ...ok, listenPort: 70000 }) ?? '', /port/)
  assert.match(checkSpec({ ...ok, peers: [{ publicKey: 'x', allowedIps: ['192.0.2.2/32'] }] }) ?? '', /key/)
  assert.match(checkSpec({ ...ok, peers: [{ publicKey: k.pub, allowedIps: ['192.0.2.2/32\nPostUp = rm -rf /'] }] }) ?? '', /Allowed IPs/)
  assert.match(checkSpec({ ...ok, peers: [{ publicKey: k.pub, allowedIps: ['192.0.2.2/32'], endpoint: 'host:port;x' }] }) ?? '', /host:port/)
})

test('a node never routes its default through WireGuard, and nothing overlaps a cluster network', () => {
  const nets = ['192.0.2.12/32', '198.51.100.0/24', '192.0.2.11/24']
  assert.match(checkAllowedIps(['0.0.0.0/0'], { node: true, clusterNets: nets }) ?? '', /never routes its default/)
  assert.match(checkAllowedIps(['0.0.0.0/1'], { node: true, clusterNets: nets }) ?? '', /never routes its default/)
  assert.match(checkAllowedIps(['198.51.100.0/25'], { node: false, clusterNets: nets }) ?? '', /overlaps the cluster network 198\.51\.100\.0\/24/)
  assert.equal(checkAllowedIps(['203.0.113.0/24'], { node: true, clusterNets: nets }), null)
  assert.equal(checkAllowedIps(['0.0.0.0/0'], { node: false, clusterNets: [] }), null, 'a guest may send everything through the tunnel')
})

test('tunnel addresses are handed out from the server\'s pool, never twice', () => {
  assert.equal(nextAddress('192.0.2.1/24', ['192.0.2.1/24']), '192.0.2.2/32')
  assert.equal(nextAddress('192.0.2.1/24', ['192.0.2.1/24', '192.0.2.2/32', '192.0.2.3/32']), '192.0.2.4/32')
  assert.equal(nextAddress('192.0.2.1/30', ['192.0.2.1/30', '192.0.2.2/32']), null)
})

test('scripts: keys are made on the machine; the status read never touches the dump line with the private key', () => {
  assert.match(wgKeyScript('hp-wg0'), /\[ -s \/etc\/wireguard\/hp-wg0\.key \] \|\| wg genkey > \/etc\/wireguard\/hp-wg0\.key/)
  assert.match(wgKeyScript('hp-wg0'), /umask 077/)
  assert.match(wgStatusScript('hp-wg0'), /wg show hp-wg0 dump \| tail -n \+2/)
  assert.doesNotMatch(wgStatusScript('hp-wg0'), /\$2/, 'the preshared-key column is never printed')
  const k = keypair()
  const apply = wgApplyScript({ iface: 'hp-wg0', address: '192.0.2.1/24', listenPort: 51820, peers: [{ publicKey: k.pub, allowedIps: ['192.0.2.2/32'] }] })
  assert.match(apply, /cat > \/etc\/wireguard\/hp-wg0\.conf\.new <<'HP_WG'/)
  assert.match(apply, /wg syncconf hp-wg0 <\(wg-quick strip hp-wg0 \| awk -v kf=\/etc\/wireguard\/hp-wg0\.key/, 'live update, other peers stay up, and the key is kept')
  assert.doesNotMatch(apply, /\$\(cat [^)]*\.key\)/, 'the key is never expanded onto a command line')
  assert.doesNotMatch(apply, />>/)
  assert.match(wgRestoreScript('hp-wg1', null), /wg-quick down hp-wg1/)
  assert.throws(() => wgKeyScript('../../etc/passwd'))
  // The two scripts that do carry a private key keep it off every command line.
  assert.match(SERVER_KEYGEN_SCRIPT, /hp_k=\$\(wg genkey\)/); assert.match(SERVER_KEYGEN_SCRIPT, /printf %s "\$hp_k" \| wg pubkey/)
  assert.match(wgKeyRestoreScript('hp-wg0', k.priv), /^set \+x$/m)
})

test('the status dump is parsed from peer lines only', () => {
  const k = keypair()
  const out = `HP_WG_PUB=${k.pub}\nHP_WG_PORT=51820\nHP_WG_DUMP_BEGIN\n${k.pub} 203.0.113.9:40000 192.0.2.2/32 1762336800 1024 2048 25\nHP_WG_DUMP_END\n`
  assert.deepEqual(parseDump(out), [{ publicKey: k.pub, endpoint: '203.0.113.9:40000', allowedIps: ['192.0.2.2/32'], latestHandshake: '2025-11-05T10:00:00.000Z', rx: 1024, tx: 2048, keepalive: 25 }])
})

test('the server keygen script runs in real bash and prints a matching pair', { skip: !hasWg() }, () => {
  const out = execFileSync('bash', ['-s'], { input: SERVER_KEYGEN_SCRIPT }).toString()
  const priv = /HP_WG_PRIV=(\S+)/.exec(out)![1], pub = /HP_WG_PUB=(\S+)/.exec(out)![1]
  assert.equal(publicOf(priv), pub)
})

function hasWg(): boolean { try { execFileSync('bash', ['-c', 'command -v wg']); return true } catch { return false } }
