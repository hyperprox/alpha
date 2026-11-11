// =============================================================================
//  HyperProx — verifying SSH host keys without asking anyone to compare fingerprints
//
//  A pin learned on first use (lib/hostkey-pins.ts) proves nothing: whoever answered first was believed. This
//  module turns such a pin into a `verified` one, but only with evidence an attacker cannot easily fake, and it
//  records which evidence it used:
//
//    cluster-record   A Proxmox cluster keeps every node's SSH host key in its own replicated record
//                     (/etc/pve/nodes/<node>/ssh_known_hosts, and the older /etc/pve/priv/known_hosts). HyperProx
//                     reads that record through every node it has a login for, each in its own SSH session. Every
//                     copy must agree, and a node's key counts only when at least two OTHER nodes, themselves
//                     verified in the same pass, showed it. To fake it, an attacker would have to sit in front of
//                     every node at once. Needs three nodes or more.
//                     When the cluster records only a different kind of key (say RSA, while the node offers
//                     ed25519 first), HyperProx signs in using the recorded key only, which the node must prove
//                     it holds, and reads the node's own key files over that session.
//    tailnet          The address is a Tailscale address, and the local tailscaled says it belongs to an online
//                     device in this tailnet whose name is the Proxmox node's name. The tunnel itself is
//                     authenticated, so the first key seen over it is the machine's.
//    wireguard        The same for a WireGuard peer address on an interface HyperProx itself set up on this
//                     machine, when the peer is that node.
//    trusted-session  The key is read from the machine over a session to it that is already confirmed or
//                     verified (the same node by another address).
//
//  Never on a plain LAN address with nothing to cross-check: that stays learned, and the Setup checklist can still
//  confirm it by hand. A key that differs from its pin is never accepted here, and any mismatch (a record that
//  disagrees between nodes, a presented key the record contradicts, a tailnet name that is not the node's) blocks
//  the whole pass, is written to the audit log and raises an alert.
//
//  Every script sent to a node, home or remote, passes the script guard (lib/clusters/script-guard.ts) first. An API
//  token cannot start a pass: the routes that do are re-confirmed with the master password, and the entry points
//  below refuse a token's session as well. The one background run is for HOME nodes, after an owner sign-in or when
//  HyperProx first learns a home node's key while a person is signed in.
// =============================================================================

import { createHmac } from 'node:crypto'
import { execFile } from 'node:child_process'
import os from 'node:os'
import { Client, type ConnectConfig } from 'ssh2'
import { assertSafeScript } from './clusters/script-guard'
import { fingerprintOf, type TerminalCredential } from './ssh-broker'
import { pinnedKey, pinSource, isConfirmedSource, recordVerified, evidenceWords, PinVerifyRefusal, type PinEvidence, type PinSource } from './hostkey-pins'
import { auditCredentialUse } from './audit'
import { publish } from './notify'
import { currentContext, requestContext } from './auth'

const NODE_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/

// ---------------------------------------------------------------------------
//  known_hosts
// ---------------------------------------------------------------------------

export interface KnownKey { names: string[]; hashed: string[]; type: string; fingerprint: string; revoked: boolean }

/** The key type written inside an SSH public key blob. */
export function blobType(blob: Buffer): string | null {
  if (blob.length < 4) return null
  const len = blob.readUInt32BE(0)
  if (len <= 0 || len > 64 || 4 + len > blob.length) return null
  return blob.subarray(4, 4 + len).toString('latin1')
}

const TYPE_RE = /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-[a-z0-9@.-]+)$/
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/

/** Lines of a known_hosts file. Certificate authorities are skipped; @revoked keys are kept, marked. */
export function parseKnownHosts(text: string): KnownKey[] {
  const out: KnownKey[] = []
  for (const raw of String(text ?? '').split('\n')) {
    let t = raw.trim()
    if (!t || t.startsWith('#')) continue
    let revoked = false
    if (t.startsWith('@')) {
      const [marker, ...rest] = t.split(/\s+/)
      if (marker !== '@revoked') continue
      revoked = true
      t = rest.join(' ')
    }
    const [hosts, type, b64] = t.split(/\s+/)
    if (!hosts || !type || !b64 || !TYPE_RE.test(type) || !B64_RE.test(b64)) continue
    const blob = Buffer.from(b64, 'base64')
    if (blobType(blob) !== type) continue
    const names: string[] = [], hashed: string[] = []
    for (const h of hosts.split(',')) {
      if (h.startsWith('|1|')) hashed.push(h)
      else if (h) names.push(h.replace(/^\[([^\]]+)\]:\d+$/, '$1').toLowerCase())
    }
    out.push({ names, hashed, type, fingerprint: fingerprintOf(blob), revoked })
  }
  return out
}

/** Whether a known_hosts entry names `name` (plainly, or hashed as ssh-keygen -H writes it). */
export function namesHost(k: KnownKey, name: string): boolean {
  const n = name.toLowerCase()
  if (k.names.includes(n)) return true
  return k.hashed.some(h => {
    const [, , salt, hash] = h.split('|')
    if (!salt || !hash) return false
    try { return createHmac('sha1', Buffer.from(salt, 'base64')).update(n).digest('base64') === hash } catch { return false }
  })
}

/** One recorded key: its type and fingerprint. */
export interface RecordedKey { type: string; fingerprint: string }
/** What one node's copy of the cluster record says about each node. */
export type RecordView = Record<string, RecordedKey[]>

const MARK = '@@hpx'

/** Read-only: the cluster's record of every node's host key, as this node sees it. Paths are fixed text. */
export function clusterRecordScript(nodes: string[]): string {
  const ok = nodes.filter(n => NODE_RE.test(n))
  return [
    `echo "${MARK} priv"`,
    'cat -- /etc/pve/priv/known_hosts 2>/dev/null',
    ...ok.flatMap(n => [`echo "${MARK} node ${n}"`, `cat -- /etc/pve/nodes/${n}/ssh_known_hosts 2>/dev/null`]),
    `echo "${MARK} end"`,
    'true',
  ].join('\n')
}

/** Read-only: this machine's own host public keys. */
export const OWN_KEYS_SCRIPT = 'cat /etc/ssh/ssh_host_*_key.pub 2>/dev/null\ntrue'

/**
 * A reader's answer as a view: for each node, its keys from that node's own file, or (when it has none) from the
 * older shared file. A key marked @revoked for the node is left out. Null when the answer is cut short.
 */
export function recordView(output: string, nodes: string[]): RecordView | null {
  const sections = new Map<string, string[]>()
  let cur: string | null = null, ended = false
  for (const line of String(output ?? '').split('\n')) {
    if (line.startsWith(`${MARK} `)) {
      const what = line.slice(MARK.length + 1).trim()
      if (what === 'end') { ended = true; cur = null; continue }
      cur = what
      sections.set(cur, [])
      continue
    }
    if (cur) sections.get(cur)!.push(line)
  }
  if (!ended) return null
  const priv = parseKnownHosts((sections.get('priv') ?? []).join('\n'))
  const view: RecordView = {}
  for (const n of nodes) {
    const own = parseKnownHosts((sections.get(`node ${n}`) ?? []).join('\n')).filter(k => namesHost(k, n))
    const fromPriv = priv.filter(k => namesHost(k, n))
    const revoked = new Set([...own, ...fromPriv].filter(k => k.revoked).map(k => k.fingerprint))
    const pick = (own.some(k => !k.revoked) ? own : fromPriv).filter(k => !k.revoked && !revoked.has(k.fingerprint))
    const uniq = new Map(pick.map(k => [k.fingerprint, { type: k.type, fingerprint: k.fingerprint }]))
    view[n] = [...uniq.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint))
  }
  return view
}

/** Fingerprints in a list of public key lines ("type base64 comment"), as ssh_host_*_key.pub holds them. */
export function ownKeyFingerprints(output: string): RecordedKey[] {
  const out: RecordedKey[] = []
  for (const line of String(output ?? '').split('\n')) {
    const [type, b64] = line.trim().split(/\s+/)
    if (!type || !b64 || !TYPE_RE.test(type) || !B64_RE.test(b64)) continue
    const blob = Buffer.from(b64, 'base64')
    if (blobType(blob) === type) out.push({ type, fingerprint: fingerprintOf(blob) })
  }
  return out
}

/** The host key algorithms that make a server sign with a key of this type. */
export function algorithmsFor(types: string[]): string[] {
  const out: string[] = []
  for (const t of types) {
    if (t === 'ssh-rsa') out.push('rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa')
    else if (t === 'ssh-ed25519' || t.startsWith('ecdsa-sha2-')) out.push(t)
  }
  return [...new Set(out)]
}

// ---------------------------------------------------------------------------
//  Private links: Tailscale and WireGuard
// ---------------------------------------------------------------------------

export function isTailnetAddress(a: string): boolean {
  const s = String(a ?? '').trim().toLowerCase()
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s)
  if (m) return Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127
  return s.startsWith('fd7a:115c:a1e0:')
}

export interface TailnetPeer { id: string; hostName: string; dnsName: string; ips: string[]; online: boolean; sharee: boolean }
export interface TailnetStatus { running: boolean; peers: TailnetPeer[] }

/** `tailscale status --json`, reduced to what identity needs. */
export function parseTailscaleStatus(raw: unknown): TailnetStatus | null {
  const j: any = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) } catch { return null } })() : raw
  if (!j || typeof j !== 'object') return null
  const peers: TailnetPeer[] = Object.values(j.Peer ?? {}).map((p: any) => ({
    id: String(p?.ID ?? ''), hostName: String(p?.HostName ?? ''), dnsName: String(p?.DNSName ?? ''),
    ips: Array.isArray(p?.TailscaleIPs) ? p.TailscaleIPs.map(String) : [], online: p?.Online === true, sharee: p?.ShareeNode === true,
  }))
  return { running: j.BackendState === 'Running', peers }
}

export interface WgLink { address: string; iface: string; peer: string; machine: string | null; up: boolean }

export type IdentityResult =
  | { ok: true; evidence: PinEvidence; hostname: string }
  | { ok: false; block: boolean; why: string }

const label = (dns: string) => dns.replace(/\.$/, '').split('.')[0]?.toLowerCase() ?? ''

/** The tailnet device at `address`, when it is one HyperProx may believe: in this tailnet (not shared in) and online. */
export function tailnetPeer(address: string, status: TailnetStatus | null): { peer: TailnetPeer } | { why: string; block: boolean } {
  if (!isTailnetAddress(address)) return { why: 'not a tailnet address', block: false }
  if (!status || !status.running) return { why: 'Tailscale is not running on the HyperProx machine', block: false }
  const peer = status.peers.find(p => p.ips.includes(address))
  if (!peer || peer.sharee) return { why: 'that address is not a device in your tailnet', block: false }
  if (!peer.online) return { why: 'that tailnet device is offline', block: false }
  return { peer }
}

/** Tailnet identity: the device at `address` is online in this tailnet and is called `node`. A different name blocks. */
export function tailnetIdentity(address: string, node: string, status: TailnetStatus | null): IdentityResult {
  const r = tailnetPeer(address, status)
  if (!('peer' in r)) return { ok: false, block: r.block, why: r.why }
  const want = node.toLowerCase()
  const names = [r.peer.hostName.toLowerCase(), label(r.peer.dnsName)]
  if (!names.includes(want)) return { ok: false, block: true, why: `the tailnet device at that address is ${r.peer.hostName || label(r.peer.dnsName)}, not ${node}` }
  return { ok: true, hostname: r.peer.hostName || label(r.peer.dnsName), evidence: { kind: 'tailnet', nodeId: r.peer.id, hostname: r.peer.hostName || label(r.peer.dnsName) } }
}

/** WireGuard identity: a peer address on an interface HyperProx set up, up on this machine, and the peer is `node`. */
export function wireguardIdentity(address: string, node: string, links: WgLink[]): IdentityResult {
  const l = links.find(x => x.address === address && x.up)
  if (!l) return { ok: false, block: false, why: 'not a WireGuard peer on a HyperProx link' }
  const want = node.toLowerCase()
  if (l.machine !== `node-${node}` && l.peer.toLowerCase() !== want) return { ok: false, block: true, why: `the WireGuard peer at that address is ${l.peer}, not ${node}` }
  return { ok: true, hostname: l.peer, evidence: { kind: 'wireguard', iface: l.iface, peer: l.peer } }
}

export function linkIdentity(address: string, node: string, status: TailnetStatus | null, links: WgLink[]): IdentityResult {
  const wg = wireguardIdentity(address, node, links)
  if (wg.ok || wg.block) return wg
  return tailnetIdentity(address, node, status)
}

// ---------------------------------------------------------------------------
//  SSH: probe and a read-only session
// ---------------------------------------------------------------------------

export interface PresentedKey { fingerprint: string; type: string }

export interface SessionOpts {
  host: string; port: number; cred: TerminalCredential; script: string
  /** Whether to go on with the key the host presents. Called before any login is sent. */
  accept(key: PresentedKey): boolean
  /** Host key algorithms to offer (to make the host sign with a key of a given type). */
  algorithms?: string[]
  timeoutMs?: number
}
export interface SessionResult { output: string; presented: PresentedKey }

export class SessionKeyRefused extends Error {
  constructor(readonly presented: PresentedKey) { super(`host presented ${presented.fingerprint}, which was not accepted`); this.name = 'SessionKeyRefused' }
}

export interface VerifyDeps {
  probe(host: string, port: number): Promise<PresentedKey>
  session(o: SessionOpts): Promise<SessionResult>
  pin(host: string, port: number): Promise<{ fingerprint: string | null; source: PinSource | null }>
  record(host: string, port: number, fingerprint: string, evidence: PinEvidence): Promise<'pinned' | 'verified' | 'already'>
  tailnet(): Promise<TailnetStatus | null>
  wireguard(): Promise<WgLink[]>
  audit(action: string, resource: string, details: Record<string, unknown>): Promise<void>
  alert(title: string, lines: string[]): Promise<void>
}

const keyOf = (key: Buffer): PresentedKey => ({ fingerprint: fingerprintOf(key), type: blobType(key) ?? 'unknown' })

function probeKey(host: string, port: number, timeoutMs = 10_000): Promise<PresentedKey> {
  return new Promise((resolve, reject) => {
    const c = new Client()
    let got: PresentedKey | null = null
    const done = (e?: Error) => { try { c.end() } catch { /* gone */ } got ? resolve(got) : reject(e ?? new Error('no host key')) }
    c.on('error', e => done(e as Error))
    try {
      c.connect({ host, port, username: 'hyperprox-probe', readyTimeout: timeoutMs,
        hostVerifier: (key: Buffer) => { got = keyOf(key); setImmediate(() => done()); return false } } as ConnectConfig)
    } catch (e: any) { done(e) }
  })
}

/** One read-only script over SSH. The guard checks it first; the key is checked before the login is sent. */
export function runSession(o: SessionOpts): Promise<SessionResult> {
  try { assertSafeScript(o.script) } catch (e) { return Promise.reject(e) }
  return new Promise((resolve, reject) => {
    const c = new Client()
    let presented: PresentedKey | null = null, refused = false, out = '', settled = false
    const end = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); try { c.end() } catch { /* gone */ } fn() }
    const timer = setTimeout(() => end(() => reject(new Error('timed out'))), o.timeoutMs ?? 30_000)
    c.on('error', e => end(() => reject(refused && presented ? new SessionKeyRefused(presented) : e)))
    c.on('ready', () => c.exec('bash -s', (err, stream) => {
      if (err) return end(() => reject(err))
      stream.on('data', (d: Buffer) => { out += d.toString(); if (out.length > 512_000) end(() => reject(new Error('answer too long'))) })
      stream.stderr?.on('data', () => undefined)
      stream.on('close', () => end(() => resolve({ output: out, presented: presented! })))
      stream.end(o.script)
    }))
    const config: ConnectConfig = {
      host: o.host, port: o.port, username: o.cred.username, readyTimeout: 15_000,
      ...(o.algorithms?.length ? { algorithms: { serverHostKey: o.algorithms as any } } : {}),
      hostVerifier: (key: Buffer) => { presented = keyOf(key); const ok = o.accept(presented); refused = !ok; return ok },
    }
    if (o.cred.privateKey) { config.privateKey = o.cred.privateKey; if (o.cred.passphrase) config.passphrase = o.cred.passphrase }
    else if (o.cred.password) config.password = o.cred.password
    else return end(() => reject(new Error('no password or key in this login')))
    try { c.connect(config) } catch (e: any) { end(() => reject(e)) }
  })
}

async function tailscaleStatus(): Promise<TailnetStatus | null> {
  return new Promise(resolve => {
    execFile('tailscale', ['status', '--json'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : parseTailscaleStatus(stdout)))
  })
}

async function wireguardLinks(): Promise<WgLink[]> {
  try {
    const { PrismaClient } = await import('@prisma/client')
    const { PrismaWgStore } = await import('./vpn/wireguard/store')
    type Server = import('./vpn/wireguard/store').WgServer
    type Peer = import('./vpn/wireguard/store').WgPeer
    const store = new PrismaWgStore(new PrismaClient() as any)
    const [servers, peers]: [Server[], Peer[]] = await Promise.all([store.listServers(), store.listPeers()])
    const local = os.networkInterfaces()
    return peers.filter(p => p.kind === 'machine' && p.serverId).flatMap(p => {
      const s = servers.find(x => x.id === p.serverId)
      if (!s) return []
      const ip = s.address.split('/')[0]
      const up = (local[s.iface] ?? []).some(a => a.address === ip)
      return [{ address: p.address.split('/')[0], iface: s.iface, peer: p.name, machine: p.machineId, up }]
    })
  } catch { return [] }
}

export function productionVerifyDeps(): VerifyDeps {
  return {
    probe: (h, p) => probeKey(h, p),
    session: o => runSession(o),
    async pin(h, p) { const [fingerprint, source] = await Promise.all([pinnedKey(h, p), pinSource(h, p)]); return { fingerprint, source } },
    record: (h, p, fp, ev) => recordVerified(h, p, fp, ev),
    tailnet: () => tailscaleStatus(),
    wireguard: () => wireguardLinks(),
    audit: (a, r, d) => auditCredentialUse(a, r, d),
    async alert(title, lines) {
      await publish({ type: 'hostkey.mismatch', severity: 'critical', title, lines, where: 'Setup checklist', link: '/settings/setup-checklist', fingerprint: `hostkey:${title}` }).catch(() => undefined)
    },
  }
}

// ---------------------------------------------------------------------------
//  The pass
// ---------------------------------------------------------------------------

export interface NodeInput {
  name: string
  address: string
  port?: number
  cred: TerminalCredential | null
  /** Other addresses the same machine is reached on (its name, say), whose pin may already be trusted. */
  alsoKnownAs?: string[]
}

export type VerdictState = 'verified' | 'already' | 'no-evidence' | 'blocked'
export interface NodeVerdict {
  node: string; host: string; port: number; state: VerdictState
  fingerprint?: string; evidence?: PinEvidence; why: string
}

export interface VerifyInput {
  /** A name for the cluster, for evidence and alerts ("Home cluster", or the remote's name). */
  cluster: string
  scope: 'home' | 'remote'
  nodes: NodeInput[]
  by: string
}

export class VerifyRefusal extends Error {}

/** API tokens never verify host keys: only a person with the master password, or HyperProx's home run. */
export function refuseTokenContext(): void {
  if (String(currentContext()?.sid ?? '').startsWith('token:')) throw new VerifyRefusal('An API token cannot verify or change host keys. Sign in and use the Setup checklist.')
}

/**
 * Whether a login may be sent to a host whose key is not yet trusted, to read the cluster record through it.
 * At home the node logins already go to learned keys (that is how HyperProx works there). On a remote server a
 * password is never sent to an unverified machine; a private key may be, since signing in with one gives a
 * machine-in-the-middle nothing it could use.
 */
function mayReadThrough(scope: 'home' | 'remote', cred: TerminalCredential, trusted: boolean): boolean {
  if (trusted || scope === 'home') return true
  return !!cred.privateKey && !cred.password
}

const same = (a: RecordedKey[], b: RecordedKey[]) => a.length === b.length && a.every((k, i) => k.fingerprint === b[i].fingerprint && k.type === b[i].type)

export async function verifyNodes(input: VerifyInput, deps: VerifyDeps = productionVerifyDeps()): Promise<NodeVerdict[]> {
  refuseTokenContext()
  const nodes = input.nodes.filter(n => NODE_RE.test(n.name) && n.address)
  const port = (n: NodeInput) => n.port ?? 22
  const v = new Map<string, NodeVerdict>()
  const problems: string[] = []
  const block = (n: NodeInput, why: string, fp?: string) => { v.set(n.name, { node: n.name, host: n.address, port: port(n), state: 'blocked', why, fingerprint: fp }); problems.push(`${n.name}: ${why}`) }

  // 1. What each node presents now, and what is pinned for it.
  const presented = new Map<string, PresentedKey>()
  const trusted = new Set<string>()
  for (const n of nodes) {
    const p = await deps.probe(n.address, port(n)).catch(() => null)
    if (!p) { v.set(n.name, { node: n.name, host: n.address, port: port(n), state: 'no-evidence', why: 'it did not answer on its SSH port' }); continue }
    presented.set(n.name, p)
    const pin = await deps.pin(n.address, port(n))
    if (pin.fingerprint && pin.fingerprint !== p.fingerprint) { block(n, `it presents ${p.fingerprint}, not the pinned ${pin.fingerprint}: the key changed, and a changed key is never accepted automatically`, p.fingerprint); continue }
    if (pin.fingerprint && isConfirmedSource(pin.source)) {
      trusted.add(n.name)
      v.set(n.name, { node: n.name, host: n.address, port: port(n), state: 'already', fingerprint: p.fingerprint, why: pin.source === 'verified' ? 'already verified' : 'already confirmed' })
    }
  }

  const candidates = new Map<string, { fp: string; evidence: PinEvidence }>()

  // 2. Private links: the tunnel vouches for the machine.
  const [status, links] = await Promise.all([
    nodes.some(n => isTailnetAddress(n.address)) ? deps.tailnet().catch(() => null) : Promise.resolve(null),
    deps.wireguard().catch(() => [] as WgLink[]),
  ])
  for (const n of nodes) {
    const p = presented.get(n.name)
    if (!p || v.has(n.name)) continue
    const id = linkIdentity(n.address, n.name, status, links)
    if (id.ok) candidates.set(n.name, { fp: p.fingerprint, evidence: id.evidence })
    else if (id.block) block(n, id.why, p.fingerprint)
  }

  // 3. The cluster's own record, read through every node HyperProx can sign in to.
  if (nodes.length >= 3) {
    const names = nodes.map(n => n.name)
    const views = new Map<string, RecordView>()
    for (const r of nodes) {
      const p = presented.get(r.name)
      if (!r.cred || !p || v.get(r.name)?.state === 'blocked') continue
      const pin = await deps.pin(r.address, port(r))
      if (!mayReadThrough(input.scope, r.cred, trusted.has(r.name) || candidates.has(r.name))) continue
      try {
        const res = await deps.session({
          host: r.address, port: port(r), cred: r.cred, script: clusterRecordScript(names),
          // The key it showed a moment ago (and its pin, if any): anything else is someone else.
          accept: k => k.fingerprint === p.fingerprint && (!pin.fingerprint || pin.fingerprint === k.fingerprint),
        })
        const view = recordView(res.output, names)
        if (view) views.set(r.name, view)
      } catch (e) {
        if (e instanceof SessionKeyRefused) block(r, `it presented ${e.presented.fingerprint} when HyperProx signed in, not the ${p.fingerprint} it showed a moment before`, e.presented.fingerprint)
      }
    }
    // Every copy must say the same thing about every node.
    const readers = [...views.keys()]
    for (let i = 1; i < readers.length; i++) {
      const a = views.get(readers[0])!, b = views.get(readers[i])!
      const differs = names.filter(n => !same(a[n] ?? [], b[n] ?? []))
      if (differs.length) problems.push(`the cluster record read through ${readers[0]} and through ${readers[i]} disagree about ${differs.join(', ')}`)
    }
    const agreed = problems.length === 0 && readers.length >= 2 ? views.get(readers[0])! : null
    if (agreed) {
      const sessionVerified = new Set<string>()
      for (const n of nodes) {
        const p = presented.get(n.name)
        if (!p || v.get(n.name)?.state === 'blocked') continue
        const others = readers.filter(r => r !== n.name)
        const rec = agreed[n.name] ?? []
        if (!rec.length) continue
        if (rec.some(k => k.fingerprint === p.fingerprint)) {
          if (others.length >= 2 && !candidates.has(n.name) && !trusted.has(n.name)) candidates.set(n.name, { fp: p.fingerprint, evidence: { kind: 'cluster-record', cluster: input.cluster, readers: others, method: 'presented-key' } })
          continue
        }
        if (rec.some(k => k.type === p.type)) { block(n, `it presents ${p.fingerprint}, but the cluster records a different ${p.type} key for it`, p.fingerprint); continue }
        // The record holds another kind of key: sign in with that kind only, and read the node's own key files.
        if (!n.cred || others.length < 2 || trusted.has(n.name) || candidates.has(n.name)) continue
        try {
          const res = await deps.session({
            host: n.address, port: port(n), cred: n.cred, script: OWN_KEYS_SCRIPT, algorithms: algorithmsFor(rec.map(k => k.type)),
            accept: k => rec.some(x => x.fingerprint === k.fingerprint),
          })
          if (ownKeyFingerprints(res.output).some(k => k.fingerprint === p.fingerprint)) {
            candidates.set(n.name, { fp: p.fingerprint, evidence: { kind: 'cluster-record', cluster: input.cluster, readers: others, method: 'record-key-session' } })
            sessionVerified.add(n.name)
          } else block(n, `signed in with the key the cluster records for it, it does not list the ${p.fingerprint} it presents`, p.fingerprint)
        } catch (e) {
          if (e instanceof SessionKeyRefused) block(n, `asked for the ${rec.map(k => k.type).join('/')} key the cluster records, it presented ${e.presented.fingerprint}`, e.presented.fingerprint)
        }
      }
      // A reader only vouches for others when it is itself verified in this pass (or already trusted).
      let changed = true
      while (changed) {
        changed = false
        for (const [name, c] of candidates) {
          if (c.evidence.kind !== 'cluster-record') continue
          const vouch = c.evidence.readers.filter(r => trusted.has(r) || (candidates.has(r) && r !== name))
          if (vouch.length < 2) { candidates.delete(name); changed = true }
          else if (vouch.length !== c.evidence.readers.length) c.evidence = { ...c.evidence, readers: vouch }
        }
      }
    }
  }

  // 4. The same machine by another address, already trusted: read its key files there.
  for (const n of nodes) {
    const p = presented.get(n.name)
    if (!p || !n.cred || v.has(n.name) || candidates.has(n.name)) continue
    for (const alt of n.alsoKnownAs ?? []) {
      if (!alt || alt === n.address) continue
      const pin = await deps.pin(alt, port(n))
      if (!pin.fingerprint || !isConfirmedSource(pin.source)) continue
      try {
        const res = await deps.session({ host: alt, port: port(n), cred: n.cred, script: OWN_KEYS_SCRIPT, accept: k => k.fingerprint === pin.fingerprint })
        if (ownKeyFingerprints(res.output).some(k => k.fingerprint === p.fingerprint)) { candidates.set(n.name, { fp: p.fingerprint, evidence: { kind: 'trusted-session', via: `${alt}:${port(n)}` } }); break }
      } catch { /* no evidence from this one */ }
    }
  }

  // 5. Any mismatch anywhere: nothing is recorded, and someone is told.
  if (problems.length) {
    for (const n of nodes) {
      if (v.get(n.name)?.state === 'blocked' || v.get(n.name)?.state === 'already') continue
      v.set(n.name, { node: n.name, host: n.address, port: port(n), state: 'blocked', fingerprint: presented.get(n.name)?.fingerprint, why: 'not verified: a mismatch was found in this cluster, so nothing was accepted' })
    }
    await deps.audit('host_key.verify.blocked', `cluster:${input.cluster}`, { by: input.by, scope: input.scope, problems })
    await deps.alert(`Host key check failed on ${input.cluster}`, [...problems, 'HyperProx accepted no key. If a node was rebuilt on purpose, clear its old pin in the Terminal, then verify again.'])
    return nodes.map(n => v.get(n.name)!)
  }

  for (const n of nodes) {
    if (v.has(n.name)) continue
    const c = candidates.get(n.name)
    if (!c) {
      v.set(n.name, { node: n.name, host: n.address, port: port(n), state: 'no-evidence', fingerprint: presented.get(n.name)?.fingerprint, why: noEvidenceWords(nodes.length, n) })
      continue
    }
    try {
      await deps.record(n.address, port(n), c.fp, c.evidence)
      const how = evidenceWords(c.evidence)
      await deps.audit('host_key.verify', `host:${n.address}:${port(n)}`, { by: input.by, scope: input.scope, node: n.name, fingerprint: c.fp, evidence: c.evidence.kind, how })
      v.set(n.name, { node: n.name, host: n.address, port: port(n), state: 'verified', fingerprint: c.fp, evidence: c.evidence, why: how })
    } catch (e: any) {
      const why = e instanceof PinVerifyRefusal ? e.message : `could not record it: ${e?.message ?? e}`
      v.set(n.name, { node: n.name, host: n.address, port: port(n), state: 'blocked', fingerprint: c.fp, why })
      if (e instanceof PinVerifyRefusal) {
        await deps.audit('host_key.verify.blocked', `host:${n.address}:${port(n)}`, { by: input.by, scope: input.scope, node: n.name, problems: [why] })
        await deps.alert(`Host key check failed on ${input.cluster}`, [`${n.name}: ${why}`])
      }
    }
  }
  return nodes.map(n => v.get(n.name)!)
}

function noEvidenceWords(count: number, n: NodeInput): string {
  if (count < 3) return "HyperProx could not verify it on its own: a server with fewer than three nodes cannot vouch for itself, and this address is not on a private link (Tailscale or WireGuard). Compare the fingerprint by hand once."
  if (!n.cred) return 'HyperProx could not verify it on its own: it needs a node login to read the cluster record, and this address is not on a private link.'
  return 'HyperProx could not verify it on its own: not enough other nodes could be read to cross-check it. Compare the fingerprint by hand once, or try again when they are all online.'
}

// ---------------------------------------------------------------------------
//  Learning a home key: verify soon after, in the background
// ---------------------------------------------------------------------------

let homeRunner: ((by: string) => Promise<unknown>) | null = null
let homeTimer: NodeJS.Timeout | null = null
let homeRunning = false

/** Set at start-up: what a background home pass runs (lib/setup-checklist.ts verifyHomeHostKeys). */
export function setHomeVerifier(fn: typeof homeRunner): void { homeRunner = fn }

/**
 * Called when HyperProx first learns a home node's key. Runs one home pass a little later (several new keys at
 * once make one pass). Never for a token's request: the next sign-in or the Setup checklist covers those.
 */
export function scheduleHomeVerify(delayMs = 20_000): boolean {
  if (!homeRunner || String(currentContext()?.sid ?? '').startsWith('token:')) return false
  if (homeTimer || homeRunning) return true
  const ctx = currentContext()
  homeTimer = setTimeout(() => {
    homeTimer = null
    homeRunning = true
    const go = () => homeRunner!('HyperProx (automatic, home nodes)')
    void Promise.resolve().then(() => (ctx ? requestContext.run(ctx, go) : go()))
      .catch(() => undefined).finally(() => { homeRunning = false })
  }, delayMs)
  homeTimer.unref?.()
  return true
}
