// Verifying SSH host keys with evidence instead of a person comparing fingerprints (lib/hostkey-verify.ts), and the
// one-step Add a server (lib/clusters/add-server.ts). Everything here runs against mocks: no node is contacted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestContext } from '../src/lib/auth'
import { fingerprintOf } from '../src/lib/ssh-broker'
import {
  verifyNodes, parseKnownHosts, namesHost, recordView, clusterRecordScript, OWN_KEYS_SCRIPT, tailnetIdentity, wireguardIdentity,
  isTailnetAddress, parseTailscaleStatus, SessionKeyRefused, VerifyRefusal, algorithmsFor, parseAnchorOutput, ANCHOR_COMMAND,
  type VerifyDeps, type PresentedKey, type TailnetStatus, type SessionOpts,
} from '../src/lib/hostkey-verify'
import { assertSafeScript } from '../src/lib/clusters/script-guard'
import { evidenceWords, type PinEvidence, type PinSource, type Anchor } from '../src/lib/hostkey-pins'
import { needsReconfirm } from '../src/lib/roles'
import { addServer, nodeAddresses, MANUAL_CERT_WHY, IdentityMismatch, type AddServerDeps } from '../src/lib/clusters/add-server'
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

function world(hosts: Record<string, FakeHost>, pins: Record<string, { fingerprint: string; source: PinSource }> = {}, o: { tailnet?: TailnetStatus | null; anchors?: Record<string, Anchor> } = {}) {
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
    async wireguard() { return [] },
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

const ts = (peers: Partial<TailnetStatus['peers'][number]>[], running = true): TailnetStatus =>
  ({ running, peers: peers.map((p, i) => ({ id: `n${i}`, hostName: '', dnsName: '', ips: [], online: true, sharee: false, ...p })) })

test('tailnet identity: match, wrong hostname, offline, not in the tailnet', () => {
  const status = ts([{ id: 'nAAA', hostName: 'node1', dnsName: 'node1.example-tailnet.ts.net.', ips: ['100.64.0.11'] },
    { hostName: 'laptop', ips: ['100.64.0.12'] }, { hostName: 'node3', ips: ['100.64.0.13'], online: false },
    { hostName: 'node4', ips: ['100.64.0.14'], sharee: true }])
  const ok = tailnetIdentity('100.64.0.11', 'node1', status)
  assert.ok(ok.ok && ok.evidence.kind === 'tailnet' && (ok.evidence as any).nodeId === 'nAAA')
  const wrong = tailnetIdentity('100.64.0.12', 'node2', status)
  assert.ok(!wrong.ok && wrong.block, 'a different name blocks')
  const off = tailnetIdentity('100.64.0.13', 'node3', status)
  assert.ok(!off.ok && !off.block && /offline/.test(off.why))
  const outside = tailnetIdentity('100.64.0.99', 'node9', status)
  assert.ok(!outside.ok && !outside.block && /not a device in your tailnet/.test(outside.why))
  const shared = tailnetIdentity('100.64.0.14', 'node4', status)
  assert.ok(!shared.ok && !shared.block, 'a device shared in from another tailnet is not this tailnet')
  assert.ok(!tailnetIdentity('10.0.0.11', 'node1', status).ok, 'a LAN address is never vouched for')
  assert.ok(!tailnetIdentity('100.64.0.11', 'node1', ts([], false)).ok, 'Tailscale not running: no evidence')
  assert.ok(isTailnetAddress('100.100.1.2') && !isTailnetAddress('100.128.0.1') && isTailnetAddress('fd7a:115c:a1e0::1'))
  const parsed = parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Peer: { k: { ID: 'x', HostName: 'node1', DNSName: 'node1.t.', TailscaleIPs: ['100.64.0.11'], Online: true } } }))
  assert.equal(parsed!.peers[0].hostName, 'node1')
  const wg = wireguardIdentity('10.9.0.2', 'node1', [{ address: '10.9.0.2', iface: 'hp-wg0', peer: 'node1', machine: 'node-node1', up: true }])
  assert.ok(wg.ok)
  assert.ok(!wireguardIdentity('10.9.0.2', 'node2', [{ address: '10.9.0.2', iface: 'hp-wg0', peer: 'node1', machine: 'node-node1', up: true }]).ok)
  assert.ok(!wireguardIdentity('10.9.0.2', 'node1', [{ address: '10.9.0.2', iface: 'hp-wg0', peer: 'node1', machine: 'node-node1', up: false }]).ok, 'only a link up on this machine')
})

test('tailnet in a pass: the first key seen is verified; a wrong name blocks and alerts; one node is enough', async () => {
  const k = key()
  const hosts = { '100.64.0.11': { keys: [k] } }
  const w = world(hosts, {}, { tailnet: ts([{ id: 'nAAA', hostName: 'node1', ips: ['100.64.0.11'] }]) })
  const v = await asOwner(() => verifyNodes({ cluster: 'Remote server', scope: 'remote', nodes: [{ name: 'node1', address: '100.64.0.11', cred: pwCred }], by: 'x' }, w.deps))
  assert.equal(v[0].state, 'verified')
  assert.deepEqual(w.recorded[0].evidence, { kind: 'tailnet', nodeId: 'nAAA', hostname: 'node1' })
  assert.match(evidenceWords(w.recorded[0].evidence), /online device node1/)
  assert.equal(w.sessions.length, 0, 'verified without signing in')

  const w2 = world(hosts, {}, { tailnet: ts([{ hostName: 'other', ips: ['100.64.0.11'] }]) })
  const v2 = await asOwner(() => verifyNodes({ cluster: 'Remote server', scope: 'remote', nodes: [{ name: 'node1', address: '100.64.0.11', cred: pwCred }], by: 'x' }, w2.deps))
  assert.equal(v2[0].state, 'blocked')
  assert.equal(w2.recorded.length, 0)
  assert.equal(w2.alerts.length, 1)

  const w3 = world(hosts, {}, { tailnet: ts([{ hostName: 'node1', ips: ['100.64.0.11'], online: false }]) })
  const v3 = await asOwner(() => verifyNodes({ cluster: 'Remote server', scope: 'remote', nodes: [{ name: 'node1', address: '100.64.0.11', cred: pwCred }], by: 'x' }, w3.deps))
  assert.equal(v3[0].state, 'no-evidence')
  assert.equal(w3.alerts.length, 0)
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

test('review 6: record reads are allowed only as exact whole lines, never glued by a continuation or a pipe', () => {
  const ok = 'cat -- /etc/pve/priv/known_hosts 2>/dev/null'
  assert.doesNotThrow(() => assertSafeScript(`echo a\n  ${ok}\ntrue`))
  for (const bad of [
    'cat -- /etc/pve/priv/known_hosts',                                  // not the exact form
    `echo x | ${ok}`, `x & ${ok}`, `( ${ok} )`, `y=$(${ok})`, `y=\`${ok}\``, // part of a longer command
    `${ok} > /tmp/x`, `${ok}; rm -f /etc/pve/priv/known_hosts`,
    `tee \\\n${ok}`,                                                     // a continuation glues it to tee
    `echo hi \\\ntrue\n${ok}`,                                           // any continuation in a reading script
  ]) assert.throws(() => assertSafeScript(bad), undefined, bad)
  // Scripts that do not read the record keep their continuations (the monitoring install uses them).
  assert.doesNotThrow(() => assertSafeScript('apt-get -s install x \\\n  >/dev/null'))
})

// ---------------------------------------------------------------------------
//  Add a server, bundled
// ---------------------------------------------------------------------------

function addDeps(o: { tailnet?: TailnetStatus | null; local?: string | null; nodes?: string[]; verdict?: 'verified' | 'no-evidence' } = {}) {
  const nodes = o.nodes ?? ['node1', 'node2', 'node3']
  const calls: string[] = []
  const created: any[] = []
  const savedLogins: string[] = []
  const audits: Array<{ action: string; details: any }> = []
  const alerts: string[] = []
  const deps: AddServerDeps = {
    async probeCertificate() { calls.push('probe'); return { fingerprint: 'AB:'.repeat(31) + 'AB', subject: 'CN=x', issuer: 'CN=x', validFrom: '', validTo: '', altNames: [] } },
    async tryToken() { calls.push('token'); return { version: '9.1', missing: [], nodes, identity: { clusterName: 'remote', nodes: nodes.map((n, i) => ({ name: n, ip: `10.0.0.${21 + i}` })), local: o.local === undefined ? nodes[0] : o.local } } },
    async homeIdentity() { return { addresses: ['10.0.0.1'], fingerprint: null, clusterName: 'home', nodes: [{ name: 'pve' }] } },
    async tailnet() { return o.tailnet ?? null },
    async wireguard() { return [] },
    async createRemote(n) { calls.push('create'); const c = { id: 'c0123456789', name: n.name, kind: 'remote', cert: { verified: n.verified ?? null } } as any; created.push(n); return c },
    async setNodeAddresses(_id, m) { calls.push(`addresses:${JSON.stringify(m)}`); return { id: 'c0123456789', name: 'Remote server', nodeAddresses: m } as any },
    async verifyNodes(_id, input) { calls.push(`verify:${input.nodes.map(n => n.address).join(',')}`); return input.nodes.map(n => ({ node: n.name, host: n.address, port: 22, state: o.verdict ?? 'verified', why: o.verdict === 'no-evidence' ? 'no evidence' : 'verified automatically: x' })) },
    async testLogin() { calls.push('test-login'); return true },
    async saveLogin(_id, node) { savedLogins.push(node) },
    async monitoring() { calls.push('monitoring'); return 'Monitoring installed.' },
    async sending() { calls.push('sending'); return 'Send files is ready.' },
    async audit(action, _r, details) { audits.push({ action, details }) },
    async alert(title) { alerts.push(title) },
  }
  return { deps, calls, created, savedLogins, audits, alerts }
}
const tsNodes = ts(['node1', 'node2', 'node3'].map((n, i) => ({ id: `id${i}`, hostName: n, ips: [`100.64.0.${11 + i}`] })))
const base = { name: 'Remote server', address: '100.64.0.11', port: 8006, tokenId: 'hyperprox@pve!main', tokenSecret: 'abcdef01-2345-6789-abcd-ef0123456789', by: 'owner@example.com' }

test('add a server over the tailnet: one request does the certificate, addresses, keys, logins, monitoring and Send files', async () => {
  const d = addDeps({ tailnet: tsNodes })
  const r = await asOwner(() => addServer({ ...base, login: { username: 'root', password: PW } }, d.deps))
  assert.equal(r.kind, 'added')
  if (r.kind !== 'added') return
  assert.match(String(d.created[0].verified), /online device node1, and named node1 by its own API/)
  assert.match(r.setup.certificate, /verified automatically/)
  assert.ok(d.calls.includes('addresses:{"node1":"100.64.0.11","node2":"100.64.0.12","node3":"100.64.0.13"}'), 'tailnet addresses preferred')
  assert.ok(d.calls.includes('verify:100.64.0.11,100.64.0.12,100.64.0.13'))
  assert.deepEqual(d.savedLogins, ['node1', 'node2', 'node3'])
  assert.ok(d.calls.indexOf('test-login') > d.calls.findIndex(c => c.startsWith('verify:')), 'the login is tested only after the keys are verified')
  assert.ok(d.calls.includes('monitoring') && d.calls.includes('sending'))
  assert.equal(r.setup.monitoring, 'Monitoring installed.')
  assert.ok(d.audits.some(a => a.action === 'cluster.add' && a.details.certificate === 'verified automatically'))
  assert.ok(!JSON.stringify(d.audits).includes(PW) && !JSON.stringify(d.audits).includes(base.tokenSecret), 'no secret in the audit log')
})

test('add a server: no login saved where a key could not be verified; ticks off skip the chores', async () => {
  const d = addDeps({ tailnet: tsNodes, verdict: 'no-evidence' })
  const r = await asOwner(() => addServer({ ...base, login: { username: 'root', password: PW }, monitoring: false, sending: false }, d.deps))
  assert.equal(r.kind, 'added')
  if (r.kind !== 'added') return
  assert.deepEqual(d.savedLogins, [])
  assert.ok(!d.calls.includes('test-login'), 'the login was never sent')
  assert.ok(r.setup.nodes.every(n => n.login === 'not-saved' && n.key === 'no-evidence'))
  assert.equal(r.setup.monitoring, null)
  assert.ok(!d.calls.includes('monitoring') && !d.calls.includes('sending'))
})

test('add a server on a plain LAN address: nothing is saved, and the manual compare is explained in one sentence', async () => {
  const d = addDeps({ tailnet: tsNodes })
  const r = await asOwner(() => addServer({ ...base, address: '10.0.0.21' }, d.deps))
  assert.equal(r.kind, 'manual-certificate')
  if (r.kind === 'manual-certificate') assert.equal(r.why, MANUAL_CERT_WHY)
  assert.deepEqual(d.calls, ['probe'], 'not even the token was sent')
  assert.equal(d.created.length, 0)
  // With the fingerprint the owner compared, it goes ahead (the old path, kept as the fallback).
  const d2 = addDeps()
  const r2 = await asOwner(() => addServer({ ...base, address: '10.0.0.21', fingerprint: 'AB:'.repeat(31) + 'AB' }, d2.deps))
  assert.equal(r2.kind, 'added')
  assert.equal(d2.created[0].verified, null)
})

test('add a server whose tailnet name is not the node its API reports: refused, audited, alerted, nothing saved', async () => {
  const d = addDeps({ tailnet: tsNodes, local: 'somewhere-else' })
  await assert.rejects(asOwner(() => addServer(base, d.deps)), IdentityMismatch)
  assert.equal(d.created.length, 0)
  assert.equal(d.alerts.length, 1)
  assert.ok(d.audits.some(a => a.action === 'cluster.add.blocked'))
})

test('node addresses: tailnet first, then the cluster status, and a one-node server on the address it was added with', () => {
  const id = { clusterName: null, nodes: [{ name: 'node1', ip: '10.0.0.21' }, { name: 'node2', ip: '10.0.0.22' }], local: 'node1' }
  assert.deepEqual(nodeAddresses(id, ['node1', 'node2'], '10.0.0.21', ts([{ hostName: 'node2', ips: ['100.64.0.12', 'fd7a:115c:a1e0::12'] }])), { node1: '10.0.0.21', node2: '100.64.0.12' })
  assert.deepEqual(nodeAddresses({ clusterName: null, nodes: [{ name: 'pve', ip: null }], local: 'pve' }, ['pve'], 'pve1.example', null), { pve: 'pve1.example' })
  // review 4: the other nodes' cluster-network addresses are never filled in.
  assert.deepEqual(nodeAddresses(id, ['node1', 'node2'], '10.0.0.21', null), { node1: '10.0.0.21' })
})
