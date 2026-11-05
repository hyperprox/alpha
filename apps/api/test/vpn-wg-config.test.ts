// WireGuard config and scripts: what is written to a machine, what a node may route, and that no private
// key is ever in a file HyperProx writes, on a command line, or read back from `wg show`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { checkAllowedIps, checkSpec, nextAddress, parseDump, renderClientConfig, renderInterface } from '../src/lib/vpn/wireguard/config'
import { isWgKey } from '../src/lib/vpn/wireguard/keys'
import { compareSnapshots, ownRouteProblem, parseSnapshot } from '../src/lib/remote/guard'

const SNAP = (extra = '') => ['HP_ROUTE4 default via 192.0.2.1 dev vmbr0', 'HP_RULE4 32766: from all lookup main', 'HP_RESOLV_LINK=/etc/resolv.conf',
  'HP_RESOLV=nameserver 192.0.2.1;', 'HP_RESOLVED=inactive', 'HP_FWSRC nft present', 'HP_FWL nft table inet filter {', 'HP_FWL nft }',
  'HP_FWD4=0', 'HP_FWD6=0', 'HP_NET own 192.0.2.11/24', extra, 'HP_QUORATE=Yes', 'HP_SNAPSHOT_END'].join('\n')
import { wgApplyScript, wgInstallScript, wgKeyScript, wgRestoreScript, wgStatusScript, SERVER_KEYGEN_SCRIPT, wgKeyRestoreScript } from '../src/lib/vpn/wireguard/scripts'
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

test('a node: AllowedIPs are judged by how much of the address space they cover together, not by prefix length', () => {
  const nets = ['192.0.2.12/32', '198.51.100.0/24']
  const node = (a: string[], extra: { pool?: string[]; sites?: string[] } = {}) => checkAllowedIps(a, { node: true, clusterNets: nets, ...extra })
  assert.match(node(['0.0.0.0/2', '64.0.0.0/2', '128.0.0.0/2', '192.0.0.0/2']) ?? '', /default/, 'four /2 make the default route')
  assert.match(node(['0.0.0.0/3']) ?? '', /more than a \/8/)
  assert.match(node(['10.0.0.0/8', '11.0.0.0/8']) ?? '', /more than a \/8/, 'two /8 together are a /7')
  assert.match(node(Array.from({ length: 257 }, (_, i) => `${20 + (i >> 8)}.${i & 255}.0.0/16`)) ?? '', /more than a \/8/, '257 /16s')
  assert.equal(node(['10.0.0.0/8']), null, 'exactly a /8 is allowed')
  assert.equal(node(['10.0.0.0/8', '10.1.0.0/16']), null, 'overlapping entries are counted once')
  assert.equal(node(['100.64.0.0/10', '10.0.0.0/8'], { pool: ['100.64.0.0/10'] }), null, 'the overlay pool does not count')
  assert.equal(node(['20.0.0.0/7'], { sites: ['20.0.0.0/7'] }), null, 'a declared site-to-site subnet does not count')
  assert.match(node(['20.0.0.0/7'], { sites: ['198.51.100.0/24'] }) ?? '', /more than a \/8/)
  assert.match(node(['0.0.0.0/1', '128.0.0.0/1'], { sites: ['0.0.0.0/1', '128.0.0.0/1'] }) ?? '', /default/, 'a site is never the default route')
  assert.match(node(['2000::/3']) ?? '', /more than a \/8/)
  assert.match(node(['::/1', '8000::/1']) ?? '', /default/)
  assert.equal(checkAllowedIps(['0.0.0.0/3', '32.0.0.0/3'], { node: false, clusterNets: [] }), null, 'guests are not limited')
})

test('the node guard uses the same coverage rule for routes the WireGuard interface adds', () => {
  const subj = { dev: 'hp-wg1', prefixes: ['100.64.10.0/24', '10.0.0.0/7'], pool: ['100.64.10.0/24'] }
  assert.match(ownRouteProblem('4 10.0.0.0/7 dev hp-wg1 scope link', subj) ?? '', /more than a \/8/, 'inside its prefixes, but too large')
  assert.equal(ownRouteProblem('4 100.64.10.0/24 dev hp-wg1 scope link', subj), null)
  assert.equal(ownRouteProblem('4 10.0.0.0/8 dev hp-wg1 scope link', subj), null)
  assert.match(ownRouteProblem('4 0.0.0.0/2 dev hp-wg1 scope link', { dev: 'hp-wg1', prefixes: ['0.0.0.0/2'] }) ?? '', /more than a \/8|default/)
  assert.equal(ownRouteProblem('4 20.0.0.0/7 dev hp-wg1 scope link', { dev: 'hp-wg1', prefixes: ['20.0.0.0/7'], sites: ['20.0.0.0/7'] }), null)
  // Together: two /8 routes, each allowed alone, are refused as a /7.
  const base = parseSnapshot(SNAP())
  const after = parseSnapshot(SNAP('HP_ROUTE4 10.0.0.0/8 dev hp-wg1 scope link\nHP_ROUTE4 11.0.0.0/8 dev hp-wg1 scope link'))
  const out = compareSnapshots(base, after, { dev: 'hp-wg1', prefixes: ['10.0.0.0/8', '11.0.0.0/8'], pool: [] })
  assert.match(out.join('\n'), /more than a \/8/)
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

// ── Installing wireguard-tools: run in real bash against a stand-in apt ──────────────────────────────────────

const APT = { ok: true as const, pm: 'apt' as const, label: 'Debian 13', tsRepo: 'debian/trixie' }

/** Run the install script with stand-in apt-get, apt-cache and wg; returns what was called and the output. */
function runInstall(o: { hasWg?: boolean; inCache?: boolean; sim?: string; dnf?: boolean }): { code: number; out: string; calls: string[] } {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } = require('node:fs')
  const { join } = require('node:path')
  const dir = mkdtempSync(join(require('node:os').tmpdir(), 'hp-wg-apt-'))
  const log = join(dir, 'calls')
  writeFileSync(log, '')
  const stub = (name: string, body: string) => { writeFileSync(join(dir, name), `#!/bin/bash\necho "${name} $*" >> ${log}\n${body}\n`); chmodSync(join(dir, name), 0o755) }
  stub('apt-cache', o.inCache ? 'echo "  Candidate: 1.0.20210914-1"' : 'echo "  Candidate: (none)"')
  writeFileSync(join(dir, 'sim.txt'), (o.sim ?? 'Inst wireguard-tools (1.0.20210914-1 Debian:13/stable [amd64])') + '\n')
  stub('apt-get', `case " $* " in *" -s "*) cat ${join(dir, 'sim.txt')} ;; esac; exit 0`)
  if (o.hasWg) stub('wg', 'echo "wireguard-tools v1.0.20210914"')
  // Only these tools on PATH, so a wg on the test machine does not count.
  for (const t of ['awk', 'grep', 'head', 'sed', 'cat']) {
    const real = require('node:child_process').execFileSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim()
    require('node:fs').symlinkSync(real, join(dir, t))
  }
  try {
    const r = require('node:child_process').spawnSync(require('node:child_process').execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim(), ['-s'], { input: wgInstallScript(APT), env: { PATH: dir }, encoding: 'utf8' })
    return { code: r.status ?? -1, out: r.stdout + r.stderr, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('install: wireguard-tools only, no recommends, nothing else named', () => {
  const sc = wgInstallScript(APT)
  assert.match(sc, /apt-get install -y -qq --no-install-recommends wireguard-tools/)
  assert.doesNotMatch(sc, /iproute|apt-get (dist-|full-)?upgrade|autoremove|--only-upgrade/)
})

test('install: already there, nothing is touched', () => {
  const r = runInstall({ hasWg: true })
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(r.calls.filter(c => c.startsWith('apt')), [])
})

test('install: in the cache, no refresh; simulated first, then installed', () => {
  const r = runInstall({ inCache: true })
  assert.equal(r.code, 0, r.out)
  assert.ok(!r.calls.some(c => c.startsWith('apt-get update')), r.calls.join('\n'))
  const sim = r.calls.findIndex(c => / -s /.test(` ${c} `)), inst = r.calls.findIndex(c => /^apt-get install/.test(c) && !/ -s /.test(` ${c} `))
  assert.ok(sim >= 0 && inst > sim, r.calls.join('\n'))
})

test('install: missing from the cache, refreshed once', () => {
  const r = runInstall({ inCache: false })
  assert.equal(r.code, 0, r.out)
  assert.equal(r.calls.filter(c => c.startsWith('apt-get update')).length, 1)
})

test('install: refused when it would upgrade or remove anything', () => {
  for (const sim of ['Inst libc6 [2.41-11] (2.41-12 Debian:13/stable [amd64])\nInst wireguard-tools (1.0 Debian:13/stable [amd64])', 'Remv ifupdown [0.8.44]\nInst wireguard-tools (1.0 Debian:13/stable [amd64])']) {
    const r = runInstall({ inCache: true, sim })
    assert.notEqual(r.code, 0)
    assert.match(r.out, /HP_WG_REFUSED=/)
    assert.ok(!r.calls.some(c => /^apt-get install/.test(c) && !/ -s /.test(` ${c} `)), 'nothing installed')
  }
})
