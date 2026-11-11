// =============================================================================
//  HyperProx — verifying SSH host keys without asking anyone to compare fingerprints
//
//  A pin learned on first use (lib/hostkey-pins.ts) proves nothing: whoever answered first was believed. This
//  module turns such a pin into a `verified` one, but only from an ANCHOR, something trusted before the pass began,
//  and it records which:
//
//    setup-local      The cluster's record of its nodes' keys (/etc/pve/nodes/<node>/ssh_known_hosts, the older
//                     /etc/pve/priv/known_hosts) and that node's own key files, read ON a node: by bootstrap.sh,
//                     which runs there as root, and handed to the API through the one-time setup hand-over; or by
//                     a one-line command the owner runs on any node and pastes back (ANCHOR_COMMAND). A presented
//                     key equal to the anchored one is verified; when the anchor holds only another kind of key,
//                     the node must prove in the SSH handshake that it holds the anchored key first.
//    cluster-record   Growth: the same record, read through nodes that were ALREADY trusted (confirmed, or verified
//                     from an anchor) before this pass started. Two trusted readers that agree are enough; with one,
//                     the node must also prove it holds the recorded key. A node verified in a pass never vouches
//                     in that same pass; the next pass may use it.
//    tailnet          The address itself is a Tailscale IP (never chosen by name), and the local tailscaled says
//                     (whois) it is an online device in this tailnet owned by the same user HyperProx is signed in
//                     as, not shared in and not tagged. The tunnel to that exact IP is authenticated.
//    wireguard        A WireGuard peer address on an interface HyperProx itself set up on this machine, when the
//                     peer is that node.
//    trusted-session  The key is read over a session to the same machine by another, already trusted address.
//
//  With no anchor there is no evidence: the pin stays learned and the Setup checklist offers the manual compare.
//  No login is ever sent to a host whose key is not trusted: readers are trusted nodes only, and a node asked to
//  prove a key gets a login only after its SSH handshake was signed with a key from an anchor or a trusted reader.
//  A key that differs from its pin is never accepted, and any mismatch blocks the whole pass, is audited and
//  raises an alert. Passes run one at a time.
//
//  Every script sent to a node, home or remote, passes the script guard (lib/clusters/script-guard.ts) first. An API
//  token cannot start a pass: the routes that do are re-confirmed with the master password, and the entry points
//  below refuse a token's session as well. The background runs are for HOME nodes, after an owner sign-in or when
//  HyperProx first learns a home node's key.
// =============================================================================

import { createHmac } from 'node:crypto'
import { execFile } from 'node:child_process'
import os from 'node:os'
import { Client, type ConnectConfig } from 'ssh2'
import { assertSafeScript } from './clusters/script-guard'
import { fingerprintOf, type TerminalCredential } from './ssh-broker'
import { pinnedKey, pinSource, isConfirmedSource, recordVerified, evidenceWords, PinVerifyRefusal, getAnchor, saveAnchor, type Anchor, type AnchorSource, type PinEvidence, type PinSource } from './hostkey-pins'
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

/**
 * The one line the owner runs on any node of a cluster (and bootstrap.sh runs on the node it installs from): that
 * node's name, the cluster's record of every node's key, and the node's own public key files, as one base64 line.
 * Public keys only; nothing secret.
 */
export const ANCHOR_COMMAND = `{ echo "${MARK} local $(basename "$(readlink -f /etc/pve/local)")"; for f in /etc/pve/nodes/*/ssh_known_hosts; do [ -f "$f" ] && echo "${MARK} node $(basename "$(dirname "$f")")" && cat -- "$f"; done; echo "${MARK} priv"; cat /etc/pve/priv/known_hosts 2>/dev/null; echo "${MARK} own"; cat /etc/ssh/ssh_host_*_key.pub; echo "${MARK} end"; } | base64 -w0; echo`

export interface AnchorSet { local: string; nodes: Record<string, RecordedKey[]> }

/** Keep what ANCHOR_COMMAND printed as each node's anchor in `scope` ("home" or a remote's id). Returns the nodes. */
export async function saveAnchors(scope: string, output: string, source: AnchorSource): Promise<string[]> {
  const set = parseAnchorOutput(output)
  if (!set) throw new VerifyRefusal('That is not the whole output of the command (it starts and ends with @@hpx lines, or is one long base64 line). Copy all of it and paste it again.')
  const at = new Date().toISOString()
  const done: string[] = []
  for (const [node, keys] of Object.entries(set.nodes)) {
    if (!keys.length) continue
    await saveAnchor(scope, node, { keys, source, at })
    done.push(node)
  }
  return done
}

/**
 * What ANCHOR_COMMAND printed (base64, or the plain text), as each node's anchored keys: for the node it ran on, its
 * own key files (every type); for the others, the cluster record. Null when it is not that command's whole output.
 */
export function parseAnchorOutput(raw: string): AnchorSet | null {
  let text = String(raw ?? '').trim()
  if (!text.startsWith(MARK) && /^[A-Za-z0-9+/=\s]+$/.test(text)) text = Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8')
  if (text.length > 1_000_000) return null
  const lines = text.split('\n')
  const localLine = lines.find(l => l.startsWith(`${MARK} local `))
  const local = localLine?.slice(MARK.length + 7).trim() ?? ''
  if (!NODE_RE.test(local)) return null
  const names = [...new Set(lines.filter(l => l.startsWith(`${MARK} node `)).map(l => l.slice(MARK.length + 6).trim()).filter(n => NODE_RE.test(n)))]
  if (!names.includes(local)) names.push(local)
  const ownStart = lines.findIndex(l => l === `${MARK} own`), end = lines.findIndex(l => l === `${MARK} end`)
  if (ownStart < 0 || end < ownStart) return null
  const view = recordView(lines.filter((l, i) => !(i > ownStart && i < end) && l !== `${MARK} own` && !l.startsWith(`${MARK} local `)).join('\n'), names)
  if (!view) return null
  const own = ownKeyFingerprints(lines.slice(ownStart + 1, end).join('\n'))
  if (!own.length) return null
  view[local] = own.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint))
  return { local, nodes: view }
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

export interface TailnetPeer { id: string; ips: string[]; online: boolean; sharee: boolean }
/** `selfUser`: the tailnet user the HyperProx machine itself is logged in as. */
export interface TailnetStatus { running: boolean; selfUser: string | null; peers: TailnetPeer[] }

/** `tailscale status --json`, reduced to what identity needs. Device names are deliberately not kept. */
export function parseTailscaleStatus(raw: unknown): TailnetStatus | null {
  const j: any = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) } catch { return null } })() : raw
  if (!j || typeof j !== 'object') return null
  const peers: TailnetPeer[] = Object.values(j.Peer ?? {}).map((p: any) => ({
    id: String(p?.ID ?? ''), ips: Array.isArray(p?.TailscaleIPs) ? p.TailscaleIPs.map(String) : [], online: p?.Online === true, sharee: p?.ShareeNode === true,
  }))
  const selfUser = j.Self?.UserID !== undefined && j.Self?.UserID !== null ? String(j.Self.UserID) : null
  return { running: j.BackendState === 'Running', selfUser, peers }
}

/** `tailscale whois --json <ip>`: who owns the device at that address. */
export interface TailnetWhois { nodeId: string; user: string; owner: string; device: string; tags: string[] }
export function parseWhois(raw: unknown): TailnetWhois | null {
  const j: any = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) } catch { return null } })() : raw
  if (!j?.Node) return null
  const n = j.Node
  return {
    nodeId: String(n.StableID ?? n.ID ?? ''), user: n.User !== undefined && n.User !== null ? String(n.User) : '',
    owner: String(j.UserProfile?.LoginName ?? ''), device: String(n.ComputedName ?? n.Name ?? '').replace(/\.$/, '').split('.')[0],
    tags: Array.isArray(n.Tags) ? n.Tags.map(String) : [],
  }
}

export interface WgLink { address: string; iface: string; peer: string; machine: string | null; up: boolean }

export type IdentityResult =
  | { ok: true; evidence: PinEvidence; device: string; owner: string | null }
  | { ok: false; block: boolean; why: string }

/**
 * Tailnet identity of EXACTLY this address: a tailnet IP (never a name), an online device in this tailnet (not shared
 * in from another), owned by the same tailnet user the HyperProx machine is logged in as, and not a tagged device
 * (a tag means someone else's policy owns it). The connection is then made to this IP and nothing else.
 */
export function tailnetIdentity(address: string, status: TailnetStatus | null, whois: TailnetWhois | null): IdentityResult {
  if (!isTailnetAddress(address)) return { ok: false, block: false, why: 'not a tailnet address' }
  if (!status || !status.running || !status.selfUser) return { ok: false, block: false, why: 'Tailscale is not running on the HyperProx machine' }
  const peer = status.peers.find(p => p.ips.includes(address))
  if (!peer || peer.sharee) return { ok: false, block: false, why: 'that address is not a device in your tailnet' }
  if (!peer.online) return { ok: false, block: false, why: 'that tailnet device is offline' }
  if (!whois || !whois.nodeId) return { ok: false, block: false, why: 'Tailscale could not say who owns that address' }
  if (whois.tags.length) return { ok: false, block: false, why: `that device is tagged (${whois.tags.join(', ')}), so it is not owned by your own account` }
  if (whois.user !== status.selfUser) return { ok: false, block: false, why: `that device belongs to ${whois.owner || 'another user'}, not to the account HyperProx is signed in to Tailscale with` }
  return { ok: true, device: whois.device, owner: whois.owner, evidence: { kind: 'tailnet', nodeId: whois.nodeId, owner: whois.owner, device: whois.device } }
}

/** WireGuard identity: a peer address on an interface HyperProx set up, up on this machine, and the peer is `node`. */
export function wireguardIdentity(address: string, node: string, links: WgLink[]): IdentityResult {
  const l = links.find(x => x.address === address && x.up)
  if (!l) return { ok: false, block: false, why: 'not a WireGuard peer on a HyperProx link' }
  const want = node.toLowerCase()
  if (l.machine !== `node-${node}` && l.peer.toLowerCase() !== want) return { ok: false, block: true, why: `the WireGuard peer at that address is ${l.peer}, not ${node}` }
  return { ok: true, device: l.peer, owner: null, evidence: { kind: 'wireguard', iface: l.iface, peer: l.peer } }
}

export function linkIdentity(address: string, node: string, status: TailnetStatus | null, links: WgLink[], whois: TailnetWhois | null): IdentityResult {
  const wg = wireguardIdentity(address, node, links)
  if (wg.ok || wg.block) return wg
  return tailnetIdentity(address, status, whois)
}

// ---------------------------------------------------------------------------
//  SSH: probe, proof of a key, and a read-only session
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
  /**
   * Make the host sign an SSH handshake with a key of one of these algorithms, and accept only a key `accept` allows.
   * No login is sent: the connection ends once the handshake (and its signature) has checked out.
   */
  prove(host: string, port: number, algorithms: string[], accept: (k: PresentedKey) => boolean): Promise<PresentedKey>
  session(o: SessionOpts): Promise<SessionResult>
  pin(host: string, port: number): Promise<{ fingerprint: string | null; source: PinSource | null }>
  record(host: string, port: number, fingerprint: string, evidence: PinEvidence): Promise<'pinned' | 'verified' | 'already'>
  anchor(scope: string, node: string): Promise<Anchor | null>
  tailnet(): Promise<TailnetStatus | null>
  whois(ip: string): Promise<TailnetWhois | null>
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

/** The handshake must complete (ssh2 checks the host's signature over it) with an accepted key. No login is offered. */
export function proveKey(host: string, port: number, algorithms: string[], accept: (k: PresentedKey) => boolean, timeoutMs = 15_000): Promise<PresentedKey> {
  return new Promise((resolve, reject) => {
    const c = new Client()
    let presented: PresentedKey | null = null, refused = false, settled = false
    const end = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); try { c.end() } catch { /* gone */ } fn() }
    const timer = setTimeout(() => end(() => reject(new Error('timed out'))), timeoutMs)
    c.on('handshake', () => { if (presented && !refused) end(() => resolve(presented!)) })
    c.on('error', e => end(() => reject(refused && presented ? new SessionKeyRefused(presented) : e)))
    try {
      c.connect({
        host, port, username: 'hyperprox-probe', readyTimeout: timeoutMs, algorithms: { serverHostKey: algorithms as any },
        hostVerifier: (key: Buffer) => { presented = keyOf(key); refused = !accept(presented); return !refused },
        // Never authenticate: the handshake is the proof.
        authHandler: (_m: unknown, _p: unknown, cb: (next: false) => void) => cb(false),
      } as any)
    } catch (e: any) { end(() => reject(e)) }
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

async function tailscaleWhois(ip: string): Promise<TailnetWhois | null> {
  if (!isTailnetAddress(ip)) return null
  return new Promise(resolve => {
    execFile('tailscale', ['whois', '--json', ip], { timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? null : parseWhois(stdout)))
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
    prove: (h, p, algs, accept) => proveKey(h, p, algs, accept),
    session: o => runSession(o),
    async pin(h, p) { const [fingerprint, source] = await Promise.all([pinnedKey(h, p), pinSource(h, p)]); return { fingerprint, source } },
    record: (h, p, fp, ev) => recordVerified(h, p, fp, ev),
    anchor: (scope, node) => getAnchor(scope, node),
    tailnet: () => tailscaleStatus(),
    whois: ip => tailscaleWhois(ip),
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
  /** Where its anchors are kept: "home", or the remote's cluster id. */
  anchorScope?: string
  scope: 'home' | 'remote'
  nodes: NodeInput[]
  by: string
}

export class VerifyRefusal extends Error {}

/** API tokens never verify host keys: only a person with the master password, or HyperProx's home run. */
export function refuseTokenContext(): void {
  if (String(currentContext()?.sid ?? '').startsWith('token:')) throw new VerifyRefusal('An API token cannot verify or change host keys. Sign in and use the Setup checklist.')
}

const same = (a: RecordedKey[], b: RecordedKey[]) => a.length === b.length && a.every((k, i) => k.fingerprint === b[i].fingerprint && k.type === b[i].type)

const CHANGED_ADVICE = "If you did not rebuild or reinstall that node, treat it as an attack: check the key on the node's own console (for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf $f; done) before anything else. If you did, clear its old pin in the Terminal, then verify again."

// One pass at a time: two passes for the same nodes must not race each other's pins.
let chain: Promise<unknown> = Promise.resolve()

/**
 * Verify these nodes' keys. Runs in rounds: each round trusts only what was trusted when it started, so a node
 * verified in a round can vouch for others only in the next one. Stops at the first mismatch, or when a round adds
 * nothing.
 */
export function verifyNodes(input: VerifyInput, deps: VerifyDeps = productionVerifyDeps()): Promise<NodeVerdict[]> {
  try { refuseTokenContext() } catch (e) { return Promise.reject(e) }
  const run = chain.then(() => verifyRounds(input, deps))
  chain = run.catch(() => undefined)
  return run
}

async function verifyRounds(input: VerifyInput, deps: VerifyDeps): Promise<NodeVerdict[]> {
  const verified = new Map<string, NodeVerdict>()
  let last: NodeVerdict[] = []
  for (let round = 0; round < 4; round++) {
    const r = await oneRound(input, deps)
    last = r.verdicts
    for (const v of r.verdicts) if (v.state === 'verified') verified.set(v.node, v)
    // Another round only helps when this one verified something AND something is still without evidence.
    if (r.blocked || !r.verdicts.some(v => v.state === 'verified') || !r.verdicts.some(v => v.state === 'no-evidence')) break
  }
  // A node verified in an earlier round shows as verified, with its evidence, not merely "already".
  return last.map(v => (v.state === 'already' && verified.has(v.node) ? verified.get(v.node)! : v))
}

async function oneRound(input: VerifyInput, deps: VerifyDeps): Promise<{ verdicts: NodeVerdict[]; blocked: boolean }> {
  const nodes = input.nodes.filter(n => NODE_RE.test(n.name) && n.address)
  const scope = input.anchorScope ?? (input.scope === 'home' ? 'home' : input.cluster)
  const port = (n: NodeInput) => n.port ?? 22
  const v = new Map<string, NodeVerdict>()
  const problems: string[] = []
  const block = (n: NodeInput, why: string, fp?: string) => { v.set(n.name, { node: n.name, host: n.address, port: port(n), state: 'blocked', why, fingerprint: fp }); problems.push(`${n.name}: ${why}`) }

  // 1. What each node presents now, and which nodes were trusted BEFORE this round. Only those may be read
  //    through or vouch, and only those are ever sent a login while evidence is gathered.
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
  const open = (n: NodeInput) => presented.has(n.name) && !v.has(n.name) && !candidates.has(n.name)
  const candidates = new Map<string, { fp: string; evidence: PinEvidence }>()

  /**
   * The node must sign its handshake with one of `keys` (from an anchor or a trusted reader). Then: the presented key
   * is one of them, or (another type) the node's own key files, read over a session signed with one of them, list it.
   * Returns the method, 'no-login' when a login would be needed and there is none, or throws a mismatch.
   */
  const proveAgainst = async (n: NodeInput, p: PresentedKey, keys: RecordedKey[]): Promise<'presented' | 'own-files' | 'no-login'> => {
    const fps = new Set(keys.map(k => k.fingerprint))
    if (fps.has(p.fingerprint)) {
      const k = await deps.prove(n.address, port(n), algorithmsFor([p.type]), x => fps.has(x.fingerprint))
      if (k.fingerprint !== p.fingerprint) throw new Error(`it signed with ${k.fingerprint}, not the ${p.fingerprint} it presents`)
      return 'presented'
    }
    if (keys.some(k => k.type === p.type)) throw new Error(`it presents ${p.fingerprint}, but the trusted record holds a different ${p.type} key for it`)
    if (!n.cred) return 'no-login'
    // The login goes only to a host that has just signed the handshake with a trusted key.
    const res = await deps.session({ host: n.address, port: port(n), cred: n.cred, script: OWN_KEYS_SCRIPT, algorithms: algorithmsFor(keys.map(k => k.type)), accept: x => fps.has(x.fingerprint) })
    if (!ownKeyFingerprints(res.output).some(k => k.fingerprint === p.fingerprint)) throw new Error(`signed in with the trusted key, it does not list the ${p.fingerprint} it presents`)
    return 'own-files'
  }
  const mismatch = (n: NodeInput, p: PresentedKey, e: any) => block(n, e instanceof SessionKeyRefused ? `asked for its trusted key, it presented ${e.presented.fingerprint}` : String(e?.message ?? e), p.fingerprint)

  // 2. Anchors: the record read on a node (installer or pasted command).
  for (const n of nodes) {
    const p = presented.get(n.name)
    if (!p || v.get(n.name)?.state === 'blocked') continue
    const a = await deps.anchor(scope, n.name).catch(() => null)
    if (!a?.keys.length) continue
    if (trusted.has(n.name)) {
      // A trusted key the anchor contradicts is still a mismatch worth stopping for.
      if (!a.keys.some(k => k.fingerprint === p.fingerprint) && a.keys.some(k => k.type === p.type)) block(n, `the anchored record holds a different ${p.type} key than the trusted one it presents`, p.fingerprint)
      continue
    }
    try {
      if (a.keys.some(k => k.fingerprint === p.fingerprint)) { candidates.set(n.name, { fp: p.fingerprint, evidence: { kind: 'setup-local', node: n.name, source: a.source, method: 'presented-key' } }); continue }
      const how = await proveAgainst(n, p, a.keys)
      if (how !== 'no-login') candidates.set(n.name, { fp: p.fingerprint, evidence: { kind: 'setup-local', node: n.name, source: a.source, method: 'proof' } })
    } catch (e) { mismatch(n, p, e) }
  }

  // 3. Private links: the tunnel vouches for the machine.
  const [status, links] = await Promise.all([
    nodes.some(n => isTailnetAddress(n.address)) ? deps.tailnet().catch(() => null) : Promise.resolve(null),
    deps.wireguard().catch(() => [] as WgLink[]),
  ])
  for (const n of nodes) {
    if (!open(n)) continue
    const who = isTailnetAddress(n.address) ? await deps.whois(n.address).catch(() => null) : null
    const id = linkIdentity(n.address, n.name, status, links, who)
    if (id.ok) candidates.set(n.name, { fp: presented.get(n.name)!.fingerprint, evidence: id.evidence })
    else if (id.block) block(n, id.why, presented.get(n.name)!.fingerprint)
  }

  // 4. Growth: the record read through nodes trusted before this round, with their logins (sent only to them).
  const readers = nodes.filter(r => trusted.has(r.name) && r.cred)
  if (readers.length && nodes.some(n => open(n))) {
    const names = nodes.map(n => n.name)
    const views = new Map<string, RecordView>()
    for (const r of readers) {
      const p = presented.get(r.name)!
      try {
        const res = await deps.session({ host: r.address, port: port(r), cred: r.cred!, script: clusterRecordScript(names), accept: k => k.fingerprint === p.fingerprint })
        const view = recordView(res.output, names)
        if (view) views.set(r.name, view)
      } catch (e) {
        if (e instanceof SessionKeyRefused) block(r, `it presented ${e.presented.fingerprint} when HyperProx signed in, not its trusted ${p.fingerprint}`, e.presented.fingerprint)
      }
    }
    const rs = [...views.keys()]
    for (let i = 1; i < rs.length; i++) {
      const a = views.get(rs[0])!, b = views.get(rs[i])!
      const differs = names.filter(n => !same(a[n] ?? [], b[n] ?? []))
      if (differs.length) problems.push(`the cluster record read through ${rs[0]} and through ${rs[i]} disagree about ${differs.join(', ')}`)
    }
    const agreed = problems.length === 0 && rs.length ? views.get(rs[0])! : null
    if (agreed) for (const n of nodes) {
      const p = presented.get(n.name)
      const rec = agreed[n.name] ?? []
      if (!p || !rec.length || v.get(n.name)?.state === 'blocked') continue
      // A trusted node the record contradicts: stop.
      if (trusted.has(n.name)) {
        if (!rec.some(k => k.fingerprint === p.fingerprint) && rec.some(k => k.type === p.type)) block(n, `the cluster record holds a different ${p.type} key than the trusted one it presents`, p.fingerprint)
        continue
      }
      if (!open(n)) continue
      const others = rs.filter(r => r !== n.name)
      try {
        if (others.length >= 2 && rec.some(k => k.fingerprint === p.fingerprint)) {
          candidates.set(n.name, { fp: p.fingerprint, evidence: { kind: 'cluster-record', cluster: input.cluster, readers: others, method: 'two-readers' } })
          continue
        }
        const how = await proveAgainst(n, p, rec)
        if (how !== 'no-login') candidates.set(n.name, { fp: p.fingerprint, evidence: { kind: 'cluster-record', cluster: input.cluster, readers: others, method: how === 'presented' ? 'one-reader-proof' : 'record-key-session' } })
      } catch (e) { mismatch(n, p, e) }
    }
  }

  // 5. The same machine by another address, already trusted: read its key files there.
  for (const n of nodes) {
    const p = presented.get(n.name)
    if (!p || !n.cred || !open(n)) continue
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

  // 6. Any mismatch anywhere: nothing is recorded, and someone is told.
  if (problems.length) {
    for (const n of nodes) {
      if (v.get(n.name)?.state === 'blocked' || v.get(n.name)?.state === 'already') continue
      v.set(n.name, { node: n.name, host: n.address, port: port(n), state: 'blocked', fingerprint: presented.get(n.name)?.fingerprint, why: 'not verified: a mismatch was found in this cluster, so nothing was accepted' })
    }
    await deps.audit('host_key.verify.blocked', `cluster:${input.cluster}`, { by: input.by, scope: input.scope, problems })
    await deps.alert(`Host key check failed on ${input.cluster}`, [...problems, `HyperProx accepted no key. ${CHANGED_ADVICE}`])
    return { verdicts: nodes.map(n => v.get(n.name)!), blocked: true }
  }

  for (const n of nodes) {
    if (v.has(n.name)) continue
    const c = candidates.get(n.name)
    if (!c) {
      v.set(n.name, { node: n.name, host: n.address, port: port(n), state: 'no-evidence', fingerprint: presented.get(n.name)?.fingerprint, why: noEvidenceWords(trusted.size > 0, n) })
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
        await deps.alert(`Host key check failed on ${input.cluster}`, [`${n.name}: ${why}`, CHANGED_ADVICE])
      }
    }
  }
  return { verdicts: nodes.map(n => v.get(n.name)!), blocked: false }
}

function noEvidenceWords(anyTrusted: boolean, n: NodeInput): string {
  if (!anyTrusted) return "HyperProx has nothing trusted to check this key against yet: no node of this cluster is verified, and this address is not on a private link (Tailscale or WireGuard). Run the one-line command shown on the Setup checklist on any node and paste what it prints, or compare the fingerprint by hand once."
  if (!n.cred) return 'HyperProx could not verify it on its own: the trusted nodes do not record a key it can check, and proving the key needs a node login.'
  return 'HyperProx could not verify it on its own: the trusted nodes do not record a key for it. Compare the fingerprint by hand once, or try again when they are all online.'
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
 * once make one pass). Never for a token's request: the next sign-in or the Setup checklist covers those. The pass
 * acts as the signed-in session it was learned in (vault writes need one) and is audited as HyperProx's own.
 */
export function scheduleHomeVerify(delayMs = 20_000): boolean {
  if (!homeRunner || String(currentContext()?.sid ?? '').startsWith('token:')) return false
  if (homeTimer || homeRunning) return true
  const ctx = currentContext()
  homeTimer = setTimeout(() => {
    homeTimer = null
    homeRunning = true
    const go = () => homeRunner!(`system: a new home node key was learned${ctx?.email ? ` (vault session of ${ctx.email})` : ''}`)
    void Promise.resolve().then(() => (ctx ? requestContext.run(ctx, go) : go()))
      .catch(() => undefined).finally(() => { homeRunning = false })
  }, delayMs)
  homeTimer.unref?.()
  return true
}
