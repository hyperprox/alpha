// Verifying SSH host keys with evidence instead of a person comparing fingerprints (lib/hostkey-verify.ts), and the
// one-step Add a server (lib/clusters/add-server.ts). Everything here runs against mocks: no node is contacted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestContext } from '../src/lib/auth'
import { fingerprintOf } from '../src/lib/ssh-broker'
import {
  verifyNodes, parseKnownHosts, namesHost, recordView, clusterRecordScript, OWN_KEYS_SCRIPT, tailnetIdentity, wireguardIdentity,
  isTailnetAddress, parseTailscaleStatus, SessionKeyRefused, VerifyRefusal, algorithmsFor, parseAnchorOutput, ANCHOR_COMMAND,
  parseWhois, type WgLink, type VerifyDeps, type PresentedKey, type TailnetStatus, type TailnetWhois, type SessionOpts,
} from '../src/lib/hostkey-verify'
import { assertSafeScript } from '../src/lib/clusters/script-guard'
import { evidenceWords, type PinEvidence, type PinSource, type Anchor } from '../src/lib/hostkey-pins'
import { needsReconfirm } from '../src/lib/roles'
import { addServer, inspectAddress, monitoringPreview, startAddJob, addJob, MANUAL_CERT_WHY, IdentityMismatch, type AddServerDeps } from '../src/lib/clusters/add-server'
import { createHmac, randomBytes } from 'node:crypto'
import { utils } from 'ssh2'

/** A real public key of a type: its known_hosts text and fingerprint. */
function key(type: 'ed25519' | 'rsa' = 'ed25519') {
  const kp: any = type === 'rsa' ? (utils as any).generateKeyPairSync('rsa', { bits: 1024 }) : (utils as any).generateKeyPairSync('ed25519')
  const [t, b64] = String(kp.public).trim().split(/\s+/)
  return { type: t, line: `${t} ${b64}`, fp: fingerprintOf(Buffer.from(b64, 'base64')) }
}
type K = ReturnType<typeof key>

interface FakeHost {
  /** What it presents, by key type; the first is what a plain connection gets. */
  keys: K[]
  /** Its copy of the cluster record (known_hosts text per file). */
  record?: { priv?: string; nodes?: Record<string, string> }
  /** Its own ssh_host_*_key.pub lines. */
  own?: K[]
  down?: boolean
}

function world(hosts: Record<string, FakeHost>, pins: Record<string, { fingerprint: string; source: PinSource }> = {}, o: { tailnet?: TailnetStatus | null; anchors?: Record<string, Anchor>; routeDev?: string | null; wg?: WgLink[] } = {}) {
  const recorded: Array<{ host: string; fp: string; evidence: PinEvidence }> = []
  const sessions: Array<{ host: string; script: string; cred: any; algorithms?: string[]; key: string }> = []
  const proofs: Array<{ host: string; key: string }> = []
  const audits: Array<{ action: string; resource: string; details: Record<string, unknown> }> = []
  const alerts: Array<{ title: string; lines: string[] }> = []
  const present = (h: FakeHost, algorithms?: string[]): K => {
    if (!algorithms?.length) return h.keys[0]
    return h.keys.find(k => algorithmsFor([k.type]).some(a => algorithms.includes(a))) ?? h.keys[0]
  }
  const deps: VerifyDeps = {
    async probe(host) { const h = hosts[host]; if (!h || h.down) throw new Error('no answer'); return { fingerprint: h.keys[0].fp, type: h.keys[0].type } },
    async prove(host, _port, algorithms, accept) {
      const h = hosts[host]
      if (!h || h.down) throw new Error('no answer')
      const k = present(h, algorithms)
      const p: PresentedKey = { fingerprint: k.fp, type: k.type }
      if (!accept(p)) throw new SessionKeyRefused(p)
      proofs.push({ host, key: k.fp })
      return p
    },
    async session(s: SessionOpts) {
      assertSafeScript(s.script)
      const h = hosts[s.host]
      if (!h || h.down) throw new Error('no answer')
      const k = present(h, s.algorithms)
      const p: PresentedKey = { fingerprint: k.fp, type: k.type }
      // The login is offered only after the key was accepted: a refused key never gets it.
      if (!s.accept(p)) throw new SessionKeyRefused(p)
      sessions.push({ host: s.host, script: s.script, cred: s.cred, algorithms: s.algorithms, key: k.fp })
      if (s.script === OWN_KEYS_SCRIPT) return { output: (h.own ?? h.keys).map(x => `${x.line} root@host`).join('\n') + '\n', presented: p }
      const nodes = [...s.script.matchAll(/@@hpx node ([^"\s]+)/g)].map(m => m[1])
      const out = ['@@hpx priv', h.record?.priv ?? '', ...nodes.flatMap(n => [`@@hpx node ${n}`, h.record?.nodes?.[n] ?? '']), '@@hpx end'].join('\n')
      return { output: out, presented: p }
    },
    async pin(host) { const p = pins[host]; return { fingerprint: p?.fingerprint ?? null, source: p?.source ?? null } },
    async record(host, _port, fp, evidence) {
      const p = pins[host]
      if (p && p.fingerprint !== fp) throw new Error('different pin')
      recorded.push({ host, fp, evidence }); pins[host] = { fingerprint: fp, source: 'verified' }
      return p ? 'verified' : 'pinned'
    },
    async anchor(_scope, node) { return o.anchors?.[node] ?? null },
    async tailnet() { return o.tailnet ?? null },
    async whois() { return null },
    async route(ip) { return o.routeDev === undefined ? 'tailscale0' : o.routeDev },
    async wireguard() { return o.wg ?? [] },
    async audit(action, resource, details) { audits.push({ action, resource, details }) },
    async alert(title, lines) { alerts.push({ title, lines }) },
  }
  /** Every login went to a host that had just shown a trusted key (pinned and trusted, or from an anchor/record). */
  const loginsOnlyToTrusted = (trustedFps: Set<string>) => sessions.every(x => trustedFps.has(x.key))
  return { deps, recorded, sessions, proofs, audits, alerts, pins, loginsOnlyToTrusted }
}

const PW = 'node-password-not-for-logs'
const pwCred = { username: 'root', password: PW } as any
const asOwner = <T>(fn: () => Promise<T>) => requestContext.run({ sid: 'sess-1', email: 'owner@example.com', role: 'owner' }, fn)
const asToken = <T>(fn: () => Promise<T>) => requestContext.run({ sid: 'token:abc', email: 'token:robot', role: 'admin' }, fn)

/** A healthy three-node cluster: each node's record lists every node's real key. */
function cluster(names = ['node1', 'node2', 'node3']) {
  const keys = Object.fromEntries(names.map(n => [n, key()])) as Record<string, K>
  const record = { nodes: Object.fromEntries(names.map(n => [n, `${n} ${keys[n].line}\n`])) }
  const addr = (n: string) => `10.0.0.${names.indexOf(n) + 11}`
  const hosts: Record<string, FakeHost> = Object.fromEntries(names.map(n => [addr(n), { keys: [keys[n]], record: structuredClone(record) }]))
  const nodes = (cred: any = pwCred) => names.map(n => ({ name: n, address: addr(n), cred }))
  const anchor = (n: string, ks: K[] = [keys[n]]): Anchor => ({ keys: ks.map(k => ({ type: k.type, fingerprint: k.fp })), source: 'installer', at: '2026-01-01T00:00:00Z' })
  const confirmed = (...ns: string[]) => Object.fromEntries(ns.map(n => [addr(n), { fingerprint: keys[n].fp, source: 'confirmed' as PinSource }]))
  return { keys, record, hosts, nodes, addr, anchor, confirmed }
}
const run = (c: ReturnType<typeof cluster>, w: ReturnType<typeof world>, scope: 'home' | 'remote' = 'home') =>
  asOwner(() => verifyNodes({ cluster: 'Home cluster', anchorScope: 'home', scope, nodes: c.nodes(), by: 'owner@example.com' }, w.deps))

// ---------------------------------------------------------------------------
//  Review 1: nothing vouches for itself; evidence starts from an anchor
// ---------------------------------------------------------------------------

test('review 1: with no anchor and nothing trusted, a healthy cluster is NOT verified, and no login goes anywhere', async () => {
  const c = cluster()
  const w = world(c.hosts)
  const v = await run(c, w)
  assert.deepEqual(v.map(x => x.state), ['no-evidence', 'no-evidence', 'no-evidence'])
  assert.match(v[0].why, /nothing trusted to check this key against yet/)
  assert.equal(w.sessions.length, 0, 'no session, so no login was sent to an untrusted node')
  assert.equal(w.recorded.length, 0)
})

test('review 1: an installer anchor verifies every node it covers, with no login and no session', async () => {
  const c = cluster()
  const w = world(c.hosts, {}, { anchors: { node1: c.anchor('node1'), node2: c.anchor('node2'), node3: c.anchor('node3') } })
  const v = await run(c, w)
  assert.deepEqual(v.map(x => x.state), ['verified', 'verified', 'verified'])
  assert.deepEqual(w.recorded[0].evidence, { kind: 'setup-local', node: 'node1', source: 'installer', method: 'presented-key' })
  assert.equal(w.sessions.length + w.proofs.length, 0)
  const a = w.audits.filter(x => x.action === 'host_key.verify')
  assert.equal(a.length, 3)
  assert.equal(a[0].details.evidence, 'setup-local')
  assert.equal(a[0].details.by, 'owner@example.com')
  assert.ok(!JSON.stringify(w.audits).includes(PW), 'no password in the audit log')
})

test('review 1: an anchor holding only another key type: the node proves the anchored key before any login, then lists its own', async () => {
  const c = cluster()
  const rsa = key('rsa')
  const h = c.hosts[c.addr('node2')]
  h.keys = [c.keys.node2, rsa]
  const w = world(c.hosts, {}, { anchors: { node2: c.anchor('node2', [rsa]) } })
  const v = await run(c, w)
  assert.equal(v[1].state, 'verified', v[1].why)
  assert.equal((w.recorded.find(r => r.host === c.addr('node2'))!.evidence as any).method, 'proof')
  const s = w.sessions.find(x => x.host === c.addr('node2'))!
  assert.equal(s.key, rsa.fp, 'the login went only to a session signed with the anchored key')
  assert.ok(!s.algorithms!.includes('ssh-ed25519'))
  // The same without a login: no evidence, and nothing sent.
  const w2 = world(c.hosts, {}, { anchors: { node2: c.anchor('node2', [rsa]) } })
  const v2 = await asOwner(() => verifyNodes({ cluster: 'Home cluster', scope: 'home', nodes: c.nodes(null), by: 'x' }, w2.deps))
  assert.equal(v2[1].state, 'no-evidence')
  assert.equal(w2.sessions.length, 0)
})

test('review 1: growth with two trusted readers: a new node is verified from their agreeing record, no login to it', async () => {
  const c = cluster()
  const w = world(c.hosts, c.confirmed('node1', 'node2'))
  const v = await run(c, w)
  assert.deepEqual(v.map(x => x.state), ['already', 'already', 'verified'])
  assert.deepEqual((w.recorded[0].evidence as any).readers.sort(), ['node1', 'node2'])
  assert.equal((w.recorded[0].evidence as any).method, 'two-readers')
  assert.ok(w.sessions.every(s => s.host !== c.addr('node3')), 'node3 was never signed in to')
  assert.ok(w.loginsOnlyToTrusted(new Set([c.keys.node1.fp, c.keys.node2.fp])))
})

test('review 1: growth with one trusted reader: each new node must prove the recorded key in its handshake (no login)', async () => {
  const c = cluster()
  const w = world(c.hosts, c.confirmed('node1'))
  const v = await run(c, w)
  assert.equal(v[1].state, 'verified')
  assert.equal(v[2].state, 'verified')
  assert.equal((w.recorded.find(r => r.host === c.addr('node2'))!.evidence as any).method, 'one-reader-proof')
  assert.deepEqual(w.proofs.map(p => p.host).sort(), [c.addr('node2'), c.addr('node3')])
  assert.ok(w.sessions.every(s => s.host === c.addr('node1')), 'logins went to the trusted reader only')
})

test('review 1: a node verified in a pass vouches only in the next one (installer anchor for one node grows to all)', async () => {
  const c = cluster()
  const w = world(c.hosts, {}, { anchors: { node1: c.anchor('node1') } })
  const v = await run(c, w)
  assert.deepEqual(v.map(x => x.state), ['verified', 'verified', 'verified'])
  assert.equal(w.recorded[0].evidence.kind, 'setup-local')
  // The record was read through node1 only after node1 was recorded (the next round).
  const firstRead = w.sessions.findIndex(s => s.script.includes('known_hosts'))
  assert.ok(firstRead >= 0)
  assert.ok(w.recorded.slice(1).every(r => r.evidence.kind === 'cluster-record' && (r.evidence as any).readers.join() === 'node1'))
})

test('review 1: untrusted nodes that agree with each other still vouch for nobody (no circular vouching)', async () => {
  // An attacker in front of every node with a self-consistent forged record: nothing is trusted, so nothing passes.
  const c = cluster()
  const forged = Object.fromEntries(['node1', 'node2', 'node3'].map(n => [n, key()])) as Record<string, K>
  for (const n of ['node1', 'node2', 'node3']) {
    c.hosts[c.addr(n)].keys = [forged[n]]
    c.hosts[c.addr(n)].record = { nodes: Object.fromEntries(['node1', 'node2', 'node3'].map(m => [m, `${m} ${forged[m].line}\n`])) }
  }
  const w = world(c.hosts)
  const v = await run(c, w)
  assert.ok(v.every(x => x.state === 'no-evidence'))
  assert.equal(w.recorded.length, 0)
  assert.equal(w.sessions.length, 0)
})

test('cluster record: trusted readers that disagree block every node, alert, and record nothing', async () => {
  const c = cluster()
  c.hosts[c.addr('node2')].record!.nodes!.node3 = `node3 ${key().line}\n`
  const w = world(c.hosts, c.confirmed('node1', 'node2'))
  const v = await run(c, w)
  assert.equal(v[2].state, 'blocked')
  assert.equal(w.recorded.length, 0)
  assert.equal(w.alerts.length, 1)
  assert.match(w.alerts[0].lines.join(' '), /disagree about node3/)
  assert.match(w.alerts[0].lines.join(' '), /node.s own console/, 'the alert says to check the console first')
  assert.ok(w.audits.some(a => a.action === 'host_key.verify.blocked'))
})

test('cluster record: an attacker answering for one node is caught by the trusted record; nothing is accepted', async () => {
  const c = cluster()
  c.hosts[c.addr('node3')].keys = [key()]
  const w = world(c.hosts, c.confirmed('node1'))
  const v = await run(c, w)
  assert.equal(v[2].state, 'blocked')
  assert.match(v[2].why, /trusted record holds a different ssh-ed25519 key/)
  assert.equal(w.recorded.length, 0, 'not node2 either: a mismatch anywhere blocks')
  assert.equal(w.alerts.length, 1)
})

test('cluster record: a node that cannot prove the recorded key in its handshake is refused', async () => {
  const c = cluster()
  // Presents node2's real public key but signs with another (what a machine in the middle without the private key gets).
  const real = c.keys.node2, other = key()
  c.hosts[c.addr('node2')].keys = [real]
  const w = world(c.hosts, c.confirmed('node1'))
  w.deps.prove = async () => { throw new SessionKeyRefused({ fingerprint: other.fp, type: other.type }) }
  const v = await run(c, w)
  assert.equal(v[1].state, 'blocked')
  assert.equal(w.recorded.length, 0)
})

test('a changed key is never accepted automatically, even with an anchor that would match the new key', async () => {
  const c = cluster()
  const old = key()
  const w = world(c.hosts, { [c.addr('node1')]: { fingerprint: old.fp, source: 'api' } }, { anchors: { node1: c.anchor('node1') } })
  const v = await run(c, w)
  assert.equal(v[0].state, 'blocked')
  assert.match(v[0].why, /key changed, and a changed key is never accepted automatically/)
  assert.equal(w.recorded.length, 0)
  assert.equal(w.alerts.length, 1)
})

test('two nodes and an anchor: a small cluster is verified too (the anchor needs no quorum)', async () => {
  const c = cluster(['node1', 'node2'])
  const w = world(c.hosts, {}, { anchors: { node1: c.anchor('node1') } })
  const v = await run(c, w)
  assert.deepEqual(v.map(x => x.state), ['verified', 'verified'])
})

test('anchor command output: parsed from base64, the install node keeps every own key; anything else is refused', () => {
  const c = cluster()
  const rsa = key('rsa')
  const text = ['@@hpx local node1', '@@hpx node node1', `node1 ${rsa.line}`, '@@hpx node node2', `node2 ${c.keys.node2.line}`, '@@hpx priv', '',
    '@@hpx own', `${c.keys.node1.line} root@node1`, `${rsa.line} root@node1`, '@@hpx end', ''].join('\n')
  const set = parseAnchorOutput(Buffer.from(text).toString('base64'))!
  assert.equal(set.local, 'node1')
  assert.deepEqual(set.nodes.node1.map(k => k.fingerprint).sort(), [c.keys.node1.fp, rsa.fp].sort())
  assert.deepEqual(set.nodes.node2.map(k => k.fingerprint), [c.keys.node2.fp])
  assert.equal(parseAnchorOutput(text.replace('@@hpx end', '')), null, 'cut short')
  assert.equal(parseAnchorOutput('hello'), null)
  assert.match(ANCHOR_COMMAND, /readlink -f \/etc\/pve\/local/)
})

// ---------------------------------------------------------------------------
//  Tailnet identity
// ---------------------------------------------------------------------------

const ts = (peers: Partial<TailnetStatus['peers'][number]>[], running = true, selfUser: string | null = 'u1', tun = true): TailnetStatus =>
  ({ running, selfUser, tun, peers: peers.map((p, i) => ({ id: `n${i}`, ips: [], online: true, sharee: false, ...p })) })
const who = (o: Partial<TailnetWhois> = {}): TailnetWhois => ({ nodeId: 'nStable1', user: 'u1', owner: 'owner@example.com', device: 'node1', tags: [], ...o })

test('review 2: tailnet identity is the exact IP and its owner, never a name', () => {
  const status = ts([{ ips: ['100.64.0.11'] }, { ips: ['100.64.0.13'], online: false }, { ips: ['100.64.0.14'], sharee: true }])
  const R = ['tailscale0', 'tailscale0']
  const ok = tailnetIdentity('100.64.0.11', status, who(), R)
  assert.ok(ok.ok && ok.evidence.kind === 'tailnet')
  assert.deepEqual(ok.ok && ok.evidence, { kind: 'tailnet', nodeId: 'nStable1', owner: 'owner@example.com', device: 'node1' })
  assert.ok(!tailnetIdentity('100.64.0.11', status, who({ user: 'u2', owner: 'someone@else.example' }), R).ok, 'owned by another user')
  assert.ok(!tailnetIdentity('100.64.0.11', status, who({ tags: ['tag:server'] }), R).ok, 'a tagged device is not owned by this account')
  assert.ok(!tailnetIdentity('100.64.0.13', status, who(), R).ok, 'offline')
  assert.ok(!tailnetIdentity('100.64.0.14', status, who(), R).ok, 'shared in from another tailnet')
  assert.ok(!tailnetIdentity('100.64.0.99', status, who(), R).ok, 'not in the tailnet')
  assert.ok(!tailnetIdentity('100.64.0.11', status, null, R).ok, 'no whois answer')
  assert.ok(!tailnetIdentity('node1.example-tailnet.ts.net', status, who(), R).ok, 'a name is never used')
  assert.ok(!tailnetIdentity('10.0.0.11', status, who(), R).ok, 'a LAN address is never vouched for')
  assert.ok(!tailnetIdentity('100.64.0.11', ts([{ ips: ['100.64.0.11'] }], false), who(), R).ok, 'Tailscale not running')
  assert.ok(isTailnetAddress('100.100.1.2') && !isTailnetAddress('100.128.0.1') && isTailnetAddress('fd7a:115c:a1e0::1'))
  const parsed = parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { UserID: 42 }, Peer: { k: { ID: 'x', HostName: 'node1', TailscaleIPs: ['100.64.0.11'], Online: true } } }))
  assert.equal(parsed!.selfUser, '42')
  assert.ok(!('hostName' in parsed!.peers[0]), 'device names are not kept for matching')
  const w = parseWhois(JSON.stringify({ Node: { ID: 7, StableID: 'nS', Name: 'node1.t.ts.net.', User: 42, Tags: [] }, UserProfile: { LoginName: 'a@b.example' } }))
  assert.deepEqual(w, { nodeId: 'nS', user: '42', owner: 'a@b.example', device: 'node1', tags: [] })
  assert.ok(wireguardIdentity('10.9.0.2', 'node1', [{ address: '10.9.0.2', iface: 'hp-wg0', peer: 'node1', machine: 'node-node1', up: true }]).ok)
  // review N2: a peer merely NAMED like the node is not that node.
  assert.ok(!wireguardIdentity('10.9.0.2', 'node1', [{ address: '10.9.0.2', iface: 'hp-wg0', peer: 'node1', machine: 'lxc-105', up: true }]).ok)
  // review N1: userspace networking, or a route that does not go into the tunnel, is no evidence.
  assert.ok(!tailnetIdentity('100.64.0.11', ts([{ ips: ['100.64.0.11'] }], true, 'u1', false), who(), R).ok, 'tailscaled in userspace networking')
  assert.ok(!tailnetIdentity('100.64.0.11', status, who(), ['tailscale0', 'eth0']).ok, 'the route left the tunnel between checks')
  assert.ok(!tailnetIdentity('100.64.0.11', status, who(), ['eth0']).ok, 'default route')
  assert.ok(!tailnetIdentity('100.64.0.11', status, who(), []).ok, 'no route read')
  assert.equal(parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', TUN: false, Self: { UserID: 1 }, Peer: {} }))!.tun, false)
  assert.ok(!wireguardIdentity('10.9.0.2', 'node1', [{ address: '10.9.0.2', iface: 'hp-wg0', peer: 'node1', machine: 'node-node1', up: false }]).ok, 'only a link up on this machine')
})

test('review 2: in a pass, a tailnet IP owned by this account is verified (first key seen); anyone else\'s is not', async () => {
  const k = key()
  const hosts = { '100.64.0.11': { keys: [k] } }
  const node = [{ name: 'node1', address: '100.64.0.11', cred: pwCred }]
  const mk = (w: TailnetWhois | null) => { const x = world(hosts, {}, { tailnet: ts([{ ips: ['100.64.0.11'] }]) }); x.deps.whois = async () => w; return x }
  const w = mk(who())
  const v = await asOwner(() => verifyNodes({ cluster: 'Remote server', scope: 'remote', nodes: node, by: 'x' }, w.deps))
  assert.equal(v[0].state, 'verified')
  assert.deepEqual(w.recorded[0].evidence, { kind: 'tailnet', nodeId: 'nStable1', owner: 'owner@example.com', device: 'node1' })
  assert.match(evidenceWords(w.recorded[0].evidence), /device node1 owned by owner@example.com/)
  assert.equal(w.sessions.length, 0, 'verified without signing in')
  for (const bad of [who({ user: 'u2' }), who({ tags: ['tag:x'] }), null]) {
    const w2 = mk(bad)
    const v2 = await asOwner(() => verifyNodes({ cluster: 'Remote server', scope: 'remote', nodes: node, by: 'x' }, w2.deps))
    assert.equal(v2[0].state, 'no-evidence')
    assert.equal(w2.recorded.length, 0)
  }
})

// ---------------------------------------------------------------------------
//  Who may run it
// ---------------------------------------------------------------------------

test('an API token cannot verify or change pins on its own', async () => {
  const c = cluster()
  const w = world(c.hosts)
  await assert.rejects(asToken(() => verifyNodes({ cluster: 'Home cluster', scope: 'home', nodes: c.nodes(), by: 'token:robot' }, w.deps)), VerifyRefusal)
  assert.equal(w.recorded.length, 0)
  await assert.rejects(asToken(() => addServer({ name: 'Remote server', address: '100.64.0.11', port: 8006, tokenId: 'a@pve!b', tokenSecret: 'x', by: 'token:robot' }, {} as any)), VerifyRefusal)
  // The routes that start a pass need the master password re-entered, which a token cannot do.
  assert.equal(needsReconfirm('POST', '/api/setup-checklist/host-keys/run'), true)
  assert.equal(needsReconfirm('POST', '/api/clusters/c0123456789/verify-keys'), true)
  assert.equal(needsReconfirm('POST', '/api/clusters'), true)
  assert.equal(needsReconfirm('POST', '/api/clusters/c0123456789/certificate'), true)
})

// ---------------------------------------------------------------------------
//  Pieces
// ---------------------------------------------------------------------------

test('known_hosts: plain and hashed names, ports, revoked keys, and the per-node file first', () => {
  const a = key(), b = key(), r = key()
  const salt = randomBytes(20)
  const hashed = `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update('node2').digest('base64')}`
  const text = [`# comment`, `node1,10.0.0.11 ${a.line}`, `${hashed} ${b.line}`, `[node3]:2222 ${r.line}`, `@cert-authority * ${a.line}`, `garbage line`].join('\n')
  const ks = parseKnownHosts(text)
  assert.equal(ks.length, 3)
  assert.ok(namesHost(ks[0], 'NODE1') && namesHost(ks[0], '10.0.0.11'))
  assert.ok(namesHost(ks[1], 'node2') && !namesHost(ks[1], 'node1'))
  assert.ok(namesHost(ks[2], 'node3'))
  // The node's own file wins over the shared one; a revoked key is dropped.
  const out = ['@@hpx priv', `node1 ${b.line}`, `node2 ${b.line}`, `@revoked node2 ${b.line}`, '@@hpx node node1', `node1 ${a.line}`, '@@hpx node node2', '', '@@hpx end'].join('\n')
  const view = recordView(out, ['node1', 'node2'])!
  assert.deepEqual(view.node1.map(k => k.fingerprint), [a.fp])
  assert.deepEqual(view.node2, [], 'revoked')
  assert.equal(recordView(out.replace('@@hpx end', ''), ['node1']), null, 'a cut-short answer is not used')
})

test('script guard: reading the cluster record is allowed; writing it, or anything else under /etc/pve, is not', () => {
  assert.doesNotThrow(() => assertSafeScript(clusterRecordScript(['node1', 'node2', 'bad;name'])))
  assert.ok(!clusterRecordScript(['bad;name']).includes('bad;name'))
  assert.doesNotThrow(() => assertSafeScript(OWN_KEYS_SCRIPT))
  assert.throws(() => assertSafeScript('echo x > /etc/pve/priv/known_hosts'))
  assert.throws(() => assertSafeScript('echo x | tee cat -- /etc/pve/priv/known_hosts'))
  assert.throws(() => assertSafeScript('cat -- /etc/pve/priv/authkey.pub'))
  assert.throws(() => assertSafeScript('cat -- /etc/pve/priv/known_hosts; cp x /etc/pve/nodes/a/ssh_known_hosts'))
})

test('review N3: a record-reading script may hold nothing but the reads, its markers and true (no cat shadowing)', () => {
  const ok = 'cat -- /etc/pve/priv/known_hosts 2>/dev/null'
  for (const bad of [`alias cat=evil`, `cat() { echo forged; }`, `PATH=/tmp/x:$PATH`, `enable -n cat`, `echo forged`, `echo "@@hpx own"`, `source /tmp/x`])
    assert.throws(() => assertSafeScript(`${bad}\n${ok}`), undefined, bad)
  assert.doesNotThrow(() => assertSafeScript(clusterRecordScript(['node1', 'node-2.lan'])))
  assert.doesNotThrow(() => assertSafeScript('cat -- /etc/pve/priv/known_hosts 2>/dev/\\\nnull'), 'joined, it is the exact read')
})

test('review 6: record reads are allowed only as exact whole lines, never glued by a continuation or a pipe', () => {
  const ok = 'cat -- /etc/pve/priv/known_hosts 2>/dev/null'
  assert.doesNotThrow(() => assertSafeScript(`echo "@@hpx priv"\n  ${ok}\ntrue`))
  for (const bad of [
    'cat -- /etc/pve/priv/known_hosts',                                  // not the exact form
    `echo x | ${ok}`, `x & ${ok}`, `( ${ok} )`, `y=$(${ok})`, `y=\`${ok}\``, // part of a longer command
    `${ok} > /tmp/x`, `${ok}; rm -f /etc/pve/priv/known_hosts`,
    `tee \\\n${ok}`,                                                     // a continuation glues it to tee
    `echo hi \\\ntrue\n${ok}`,                                           // joined as bash reads it: "echo hi true" is not allowed
  ]) assert.throws(() => assertSafeScript(bad), undefined, bad)
  // Scripts that do not read the record keep their continuations (the monitoring install uses them); they are
  // checked joined, as bash reads them.
  assert.throws(() => assertSafeScript('echo /etc/p\\\nve/priv/authkey.key'), undefined, 'a path split over a continuation is still seen')
  assert.doesNotThrow(() => assertSafeScript('apt-get -s install x \\\n  >/dev/null'))
})

// ---------------------------------------------------------------------------
//  Add a server, bundled
// ---------------------------------------------------------------------------

function addDeps(o: { tailnet?: TailnetStatus | null; whois?: Record<string, TailnetWhois>; local?: string | null; nodes?: string[]; ips?: string[]; verdict?: 'verified' | 'no-evidence'; certNames?: string[]; routeDev?: string | null } = {}) {
  const nodes = o.nodes ?? ['node1', 'node2', 'node3']
  const calls: string[] = []
  const created: any[] = []
  const savedLogins: string[] = []
  const audits: Array<{ action: string; details: any }> = []
  const alerts: string[] = []
  const deps: AddServerDeps = {
    async probeCertificate() { calls.push('probe'); return { fingerprint: 'AB:'.repeat(31) + 'AB', subject: `CN=${(o.certNames ?? ['node1'])[0]}.example`, issuer: 'CN=x', validFrom: '', validTo: '', altNames: [...(o.certNames ?? ['node1']), '100.64.0.11'] } },
    async tryToken() { calls.push('token'); return { version: '9.1', missing: [], nodes, identity: { clusterName: 'remote', nodes: nodes.map((n, i) => ({ name: n, ip: o.ips?.[i] ?? `10.0.0.${21 + i}` })), local: o.local === undefined ? nodes[0] : o.local } } },
    async homeIdentity() { return { addresses: ['10.0.0.1'], fingerprint: null, clusterName: 'home', nodes: [{ name: 'pve' }] } },
    async tailnet() { return o.tailnet ?? null },
    async whois(ip) { return o.whois?.[ip] ?? null },
    async route() { return o.routeDev === undefined ? 'tailscale0' : o.routeDev },
    findRemote: () => null,
    async replaceToken() { calls.push('replace-token') },
    async createRemote(n) { calls.push('create'); const c = { id: 'c0123456789', name: n.name, kind: 'remote', cert: { verified: n.verified ?? null } } as any; created.push(n); return c },
    async setNodeAddresses(_id, m) { calls.push(`addresses:${JSON.stringify(m)}`); return { id: 'c0123456789', name: 'Remote server', nodeAddresses: m } as any },
    async verifyNodes(_id, input) { calls.push(`verify:${input.nodes.map(n => n.address).join(',')}`); return input.nodes.map(n => ({ node: n.name, host: n.address, port: 22, state: o.verdict ?? 'verified', why: o.verdict === 'no-evidence' ? 'no evidence' : 'verified automatically: x' })) },
    async testLogin() { calls.push('test-login'); return true },
    async saveLogin(_id, node) { savedLogins.push(node) },
    async monitoring(_id, _by, hash) { calls.push(`monitoring:${hash}`); return 'Monitoring installed.' },
    async sending() { calls.push('sending'); return 'Send files is ready.' },
    async audit(action, _r, details) { audits.push({ action, details }) },
    async alert(title) { alerts.push(title) },
  }
  return { deps, calls, created, savedLogins, audits, alerts }
}
const tsNodes = ts([{ ips: ['100.64.0.11'] }, { ips: ['100.64.0.12'] }, { ips: ['100.64.0.13'] }])
const owned = { '100.64.0.11': who(), '100.64.0.12': who({ nodeId: 'n2', device: 'node2' }), '100.64.0.13': who({ nodeId: 'n3', device: 'node3' }) }
const base = { name: 'Remote server', address: '100.64.0.11', port: 8006, tokenId: 'hyperprox@pve!main', tokenSecret: 'abcdef01-2345-6789-abcd-ef0123456789', by: 'owner@example.com' }

test('add a server over the tailnet: the typed IP is vouched for; other nodes only by tailnet IPs their own status reports', async () => {
  const d = addDeps({ tailnet: tsNodes, whois: owned, ips: ['100.64.0.11', '100.64.0.12', '10.0.0.23'] })
  const shown = await inspectAddress(base.address, base.port, d.deps)
  d.calls.length = 0
  const r = await asOwner(() => addServer({ ...base, previewHash: shown.hash, login: { username: 'root', password: PW } }, d.deps))
  assert.equal(r.kind, 'added')
  if (r.kind !== 'added') return
  assert.match(String(d.created[0].verified), /this exact address, the device node1 owned by owner@example.com; its certificate is for node1, which its own API confirms/)
  assert.ok(d.calls.includes('addresses:{"node1":"100.64.0.11","node2":"100.64.0.12"}'), 'node3 reports only a cluster-network address: left empty')
  assert.ok(d.calls.includes('verify:100.64.0.11,100.64.0.12'))
  assert.deepEqual(d.savedLogins, ['node1', 'node2'])
  assert.ok(d.calls.indexOf('test-login') > d.calls.findIndex(c => c.startsWith('verify:')), 'the login is tested only after the keys are verified')
  assert.ok(d.calls.includes(`monitoring:${monitoringPreview().hash}`), 'review 5: monitoring is applied only with the script that was shown')
  assert.ok(d.calls.includes('sending'))
  assert.ok(d.audits.some(a => a.action === 'cluster.add' && a.details.certificate === 'verified automatically'))
  assert.ok(!JSON.stringify(d.audits).includes(PW) && !JSON.stringify(d.audits).includes(base.tokenSecret), 'no secret in the audit log')
})

test('review 2: a tailnet IP owned by someone else, or tagged, gets the manual compare; nothing is sent', async () => {
  for (const w of [who({ user: 'u2' }), who({ tags: ['tag:server'] })]) {
    const d = addDeps({ tailnet: tsNodes, whois: { '100.64.0.11': w } })
    const r = await asOwner(() => addServer(base, d.deps))
    assert.equal(r.kind, 'manual-certificate')
    assert.deepEqual(d.calls, ['probe'])
  }
})

test('add a server: no login saved where a key could not be verified; ticks off skip the chores', async () => {
  const d = addDeps({ tailnet: tsNodes, whois: owned, verdict: 'no-evidence' })
  const r = await asOwner(() => addServer({ ...base, login: { username: 'root', password: PW }, monitoring: false, sending: false }, d.deps))
  assert.equal(r.kind, 'added')
  if (r.kind !== 'added') return
  assert.deepEqual(d.savedLogins, [])
  assert.ok(!d.calls.includes('test-login'), 'the login was never sent')
  assert.equal(r.setup.monitoring, null)
  assert.ok(!d.calls.some(c => c.startsWith('monitoring')) && !d.calls.includes('sending'))
})

test('add a server on a plain LAN address: nothing is saved, and the manual compare is explained in one sentence', async () => {
  const d = addDeps({ tailnet: tsNodes, whois: owned })
  const r = await asOwner(() => addServer({ ...base, address: '10.0.0.21' }, d.deps))
  assert.equal(r.kind, 'manual-certificate')
  if (r.kind === 'manual-certificate') assert.equal(r.why, MANUAL_CERT_WHY)
  assert.deepEqual(d.calls, ['probe'], 'not even the token was sent')
  assert.equal(d.created.length, 0)
  const d2 = addDeps()
  const r2 = await asOwner(() => addServer({ ...base, address: '10.0.0.21', fingerprint: 'AB:'.repeat(31) + 'AB' }, d2.deps))
  assert.equal(r2.kind, 'added')
  assert.equal(d2.created[0].verified, null)
  assert.ok(d2.calls.includes('addresses:{"node1":"10.0.0.21"}'), 'review 4: the other nodes\' cluster addresses are not filled in')
})

test('review 3: before any token is sent, the certificate must be for the tailnet device at that address', async () => {
  const d = addDeps({ tailnet: tsNodes, whois: owned, certNames: ['elsewhere'] })
  const shown = await inspectAddress(base.address, base.port, d.deps)
  assert.equal(shown.link, null)
  assert.match(String(shown.why), /certificate at that address is for elsewhere, not for the device node1/)
  d.calls.length = 0
  const r = await asOwner(() => addServer(base, d.deps))
  assert.equal(r.kind, 'manual-certificate')
  assert.deepEqual(d.calls, ['probe'], 'the token was never sent')
})

test('review 3: the add dialog learns who it connects to before the password; a server whose API name is not in its certificate is refused', async () => {
  const d = addDeps({ tailnet: tsNodes, whois: owned })
  const shown = await inspectAddress(base.address, base.port, d.deps)
  assert.deepEqual({ device: shown.link?.device, owner: shown.link?.owner }, { device: 'node1', owner: 'owner@example.com' })
  const bad = addDeps({ tailnet: tsNodes, whois: owned, local: 'other-node' })
  await assert.rejects(asOwner(() => addServer(base, bad.deps)), IdentityMismatch)
  assert.equal(bad.created.length, 0)
  assert.equal(bad.alerts.length, 1)
  assert.ok(bad.audits.some(a => a.action === 'cluster.add.blocked'))
})

test('review 5: the add applies only what was previewed; anything changed since is refused, and no preview means no monitoring', async () => {
  const d = addDeps({ tailnet: tsNodes, whois: owned })
  const shown = await inspectAddress(base.address, base.port, d.deps)
  assert.match(shown.monitoring.steps[0], /prometheus-node-exporter/)
  // The tailnet device changed owner between the preview and Connect.
  d.calls.length = 0
  const moved = addDeps({ tailnet: tsNodes, whois: { '100.64.0.11': who({ owner: 'new@example.com', nodeId: 'nOther' }) } })
  await assert.rejects(asOwner(() => addServer({ ...base, previewHash: shown.hash }, moved.deps)), /changed since you looked/)
  assert.ok(!moved.calls.includes('token'))
  const noPreview = addDeps({ tailnet: tsNodes, whois: owned })
  const r = await asOwner(() => addServer({ ...base, login: { username: 'root', password: PW } }, noPreview.deps))
  assert.ok(r.kind === 'added' && /only after its preview is shown/.test(String(r.setup.monitoring)))
  assert.ok(!noPreview.calls.some(c => c.startsWith('monitoring')))
})

test('review 7: a second request for the same add while it runs joins the same job, and only its owner sees it', async () => {
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  let runs = 0
  const run = async () => { runs++; await gate; return { kind: 'manual-certificate', certificate: {} as any, why: 'x' } as any }
  const answer = (r: any) => ({ status: r ? 409 : 500, body: {} })
  const a = startAddJob('owner:s1', base as any, run, answer), b = startAddJob('owner:s1', base as any, run, answer)
  assert.equal(a.id, b.id)
  assert.equal(runs, 1)
  assert.equal(addJob('someone:s2', a.id), null)
  release(); await new Promise(r => setTimeout(r, 10))
  assert.equal(addJob('owner:s1', a.id)!.status, 'failed')
  assert.equal(startAddJob('owner:s1', base as any, run, answer).id === a.id, false, 'a finished add can be retried')
})

test('review 7: a retry of an add that stopped part way resumes the saved server instead of refusing it', async () => {
  const d = addDeps({ tailnet: tsNodes, whois: owned })
  d.deps.findRemote = () => ({ id: 'c0123456789', name: 'remote server', cert: { fingerprint: 'AB:'.repeat(31) + 'AB' } } as any)
  const r = await asOwner(() => addServer(base, d.deps))
  assert.equal(r.kind, 'added')
  assert.ok(d.calls.includes('replace-token') && !d.calls.includes('create'))
  assert.ok(d.audits.some(a => a.action === 'cluster.add.resume'))
})

test('review N1: a tailnet address the kernel does not route into the tunnel is no evidence, in a pass and when adding', async () => {
  const k = key()
  const node = [{ name: 'node1', address: '100.64.0.11', cred: pwCred }]
  const w = world({ '100.64.0.11': { keys: [k] } }, {}, { tailnet: ts([{ ips: ['100.64.0.11'] }]), routeDev: 'eth0' })
  w.deps.whois = async () => who()
  const v = await asOwner(() => verifyNodes({ cluster: 'Remote server', scope: 'remote', nodes: node, by: 'x' }, w.deps))
  assert.equal(v[0].state, 'no-evidence')
  const d = addDeps({ tailnet: tsNodes, whois: owned, routeDev: 'eth0' })
  const r = await asOwner(() => addServer(base, d.deps))
  assert.equal(r.kind, 'manual-certificate')
  assert.deepEqual(d.calls, ['probe'], 'no token sent')
  const d2 = addDeps({ tailnet: ts([{ ips: ['100.64.0.11'] }], true, 'u1', false), whois: owned })
  assert.equal((await asOwner(() => addServer(base, d2.deps))).kind, 'manual-certificate', 'userspace networking')
})

test('review N2: WireGuard evidence only for a home node HyperProx made the peer for; never for a remote', async () => {
  const k = key()
  const hosts = { '10.9.0.2': { keys: [k] } }
  const link = { address: '10.9.0.2', iface: 'hp-wg0', peer: 'node1', machine: 'node-node1', up: true }
  const node = [{ name: 'node1', address: '10.9.0.2', cred: pwCred }]
  const home = world(hosts, {}, { wg: [link] })
  assert.equal((await asOwner(() => verifyNodes({ cluster: 'Home cluster', scope: 'home', nodes: node, by: 'x' }, home.deps)))[0].state, 'verified')
  const remote = world(hosts, {}, { wg: [link] })
  assert.equal((await asOwner(() => verifyNodes({ cluster: 'Remote server', scope: 'remote', nodes: node, by: 'x' }, remote.deps)))[0].state, 'no-evidence')
  const named = world(hosts, {}, { wg: [{ ...link, machine: 'lxc-105' }] })
  assert.equal((await asOwner(() => verifyNodes({ cluster: 'Home cluster', scope: 'home', nodes: node, by: 'x' }, named.deps)))[0].state, 'blocked', 'a peer named like the node but made for something else')
})

test('review N5: an anchor or record of a type HyperProx cannot ask for (DSA) is no evidence, not a mismatch', async () => {
  const c = cluster()
  // node2 offers ed25519; the anchor holds only a DSA key, which ssh2 cannot be asked to sign with.
  const dss: K = { type: 'ssh-dss', line: 'ssh-dss AAAA', fp: 'SHA256:' + 'D'.repeat(43) }
  const w = world(c.hosts, {}, { anchors: { node2: c.anchor('node2', [dss]) } })
  const v = await run(c, w)
  assert.equal(v[1].state, 'no-evidence')
  assert.equal(w.alerts.length, 0)
  assert.equal(w.sessions.length + w.proofs.length, 0, 'nothing was asked of the node')
})
