// =============================================================================
//  HyperProx — a changed SSH host key in the Deck, checked with Proxmox
//
//  When a Terminal pane meets a key that differs from the one pinned for host:port, nobody should have to judge
//  two fingerprints. HyperProx asks the hypervisor instead:
//
//    1. Which cluster guest is configured with that address? A container by the IP in its net config, a VM by the
//       addresses its guest agent reports. Only a RUNNING guest can be answering; stopped ones that carry the same
//       address are named as context ("VM 150 (stopped) is also configured with this address").
//    2. That guest's own host keys, read ON its node over HyperProx's pinned node login: `pct exec` for a container,
//       `qm guest exec` for a VM whose agent answers. Never over the network to the address itself: the thing being
//       judged is never asked to vouch for itself.
//    3. A verdict:
//         verified  the key offered (same type) is one of the guest's own keys: it was rebuilt, restored or
//                   renumbered. One button re-pins exactly that fingerprint for that host:port.
//         mismatch  the guest's own keys do not include it: something else is answering at its address. No one-tap
//                   trust; an admin can still trust it behind a typed confirmation.
//         unknown   no running guest has the address, its agent is down, or the read failed. The fingerprints and
//                   the old manual path (admin, behind a confirm) remain.
//
//  The offered key is read by HyperProx itself (a probe that sends no login), never taken from the browser. A
//  verdict is kept on the server, bound to the session and the pane's host id, for a few minutes; trusting it pins
//  the fingerprint the verdict holds, after a fresh probe shows the host still offers it and the old pin is still
//  the one the verdict replaced. Every re-pin is audited with its verdict. API tokens are refused here as on every
//  Terminal route, and the check itself is rate-limited per session.
// =============================================================================

import { randomBytes } from 'node:crypto'
import { getCredential } from './credentials'
import { currentContext, isTokenContext } from './auth'
import { hasRole } from './roles'
import { auditOrThrow } from './audit'
import { AttemptLimiter } from './auth-limits'
import { repinHostKey, credentialId, CREDENTIAL_CATEGORY } from './ssh-broker'
import { evidenceWords, type PinEvidence, type PinSource } from './hostkey-pins'
import { probeKey, type PresentedKey } from './hostkey-verify'
import type { Role } from './vault/broker'

const NODE_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/
const FP_RE = /^SHA256:[A-Za-z0-9+/]{43}$/

/** Read-only, inside the guest: each host public key's fingerprint, as ssh-keygen prints it. */
export const GUEST_KEYS_SCRIPT = `for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done`

// ---------------------------------------------------------------------------
//  Parsing
// ---------------------------------------------------------------------------

export interface GuestKey { type: string; fingerprint: string }

/** ssh-keygen's name for a key type, with its bit count, as the SSH wire name the handshake uses. */
export function sshKeyType(label: string, bits: number): string | null {
  switch (label.toUpperCase()) {
    case 'ED25519': return 'ssh-ed25519'
    case 'RSA': return 'ssh-rsa'
    case 'DSA': return 'ssh-dss'
    case 'ECDSA': return bits === 256 || bits === 384 || bits === 521 ? `ecdsa-sha2-nistp${bits}` : null
    case 'ED25519-SK': return 'sk-ssh-ed25519@openssh.com'
    case 'ECDSA-SK': return 'sk-ecdsa-sha2-nistp256@openssh.com'
    default: return null
  }
}

/** `256 SHA256:abc… root@host (ED25519)` lines, as key types and fingerprints. Anything else is ignored. */
export function parseKeygenFingerprints(output: string): GuestKey[] {
  const out: GuestKey[] = []
  for (const raw of String(output ?? '').split('\n')) {
    const m = /^\s*(\d{3,5})\s+(SHA256:[A-Za-z0-9+/]{43})\s.*\(([A-Z0-9-]+)\)\s*$/.exec(raw.replace(/\r$/, ''))
    if (!m) continue
    const type = sshKeyType(m[3], Number(m[1]))
    if (type && !out.some(k => k.fingerprint === m[2] && k.type === type)) out.push({ type, fingerprint: m[2] })
  }
  return out
}

/** `qm guest exec` answers in JSON: the command's stdout is its out-data. Null when it did not run to the end. */
export function agentExecOutput(raw: string): { exitcode: number; out: string } | null {
  try {
    const j = JSON.parse(String(raw ?? '').trim())
    if (!j || j.exited !== 1 && j.exited !== true) return null
    return { exitcode: Number(j.exitcode ?? 0), out: String(j['out-data'] ?? '') }
  } catch { return null }
}

const cleanIp = (s: string) => s.trim().split('/')[0].toLowerCase()
const usableIp = (ip: string) => !!ip && ip !== '0.0.0.0' && !ip.startsWith('127.') && ip !== '::1' && !ip.startsWith('fe80:')

/** Every static address in a container's netN lines (ip= and ip6=), without the prefix length. */
export function lxcConfigAddresses(config: Record<string, unknown> | null): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(config ?? {})) {
    if (!/^net\d+$/.test(k) || typeof v !== 'string') continue
    for (const m of v.matchAll(/(?:^|,)ip6?=([^,]+)/g)) {
      const ip = cleanIp(m[1])
      if (/^[0-9a-f.:]+$/.test(ip) && usableIp(ip)) out.push(ip)
    }
  }
  return [...new Set(out)]
}

/** A VM's cloud-init addresses (ipconfigN ip= / ip6=). Context only: they say what the VM is set up to use. */
export function vmConfigAddresses(config: Record<string, unknown> | null): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(config ?? {})) {
    if (!/^ipconfig\d+$/.test(k) || typeof v !== 'string') continue
    for (const m of v.matchAll(/(?:^|,)ip6?=([^,]+)/g)) {
      const ip = cleanIp(m[1])
      if (/^[0-9a-f.:]+$/.test(ip) && usableIp(ip)) out.push(ip)
    }
  }
  return [...new Set(out)]
}

/** Addresses in a guest agent `network-get-interfaces` answer (IPv4 and IPv6, not loopback or link-local). */
export function agentAddresses(answer: unknown): string[] {
  const list: any[] = Array.isArray(answer) ? answer : Array.isArray((answer as any)?.result) ? (answer as any).result : []
  const out: string[] = []
  for (const f of list) {
    for (const a of Array.isArray(f?.['ip-addresses']) ? f['ip-addresses'] : []) {
      if (typeof a?.['ip-address'] === 'string') out.push(cleanIp(a['ip-address']))
    }
  }
  return [...new Set(out.filter(usableIp))]
}

const agentEnabled = (config: Record<string, unknown> | null) => /^(1|enabled=1)/.test(String(config?.agent ?? ''))

// ---------------------------------------------------------------------------
//  The check
// ---------------------------------------------------------------------------

export interface GuestRef { type: 'lxc' | 'qemu'; vmid: number; node: string; name: string; status: string }

export type CheckState = 'verified' | 'mismatch' | 'unknown' | 'unchanged'
export type UnknownReason = 'no-guest' | 'agent-down' | 'several-guests' | 'read-failed'

export interface HostKeyVerdict {
  state: CheckState
  host: string
  port: number
  /** The pin the check started from, or null. */
  pinned: string | null
  /** The key HyperProx read from host:port itself. */
  offered: PresentedKey
  /** The guest the address belongs to, when one was found. */
  guest?: GuestRef
  /** How its keys were read. */
  via?: 'pct' | 'guest-agent'
  /** The guest's own keys, as read through the hypervisor. */
  guestKeys?: GuestKey[]
  reason?: UnknownReason
  /** Plain sentences: why it could not check, and anything else worth knowing about this address. */
  why?: string
  context: string[]
}

export interface HostKeyCheckDeps {
  resources(): Promise<any[]>
  guestConfig(node: string, vmid: number, type: 'lxc' | 'qemu'): Promise<Record<string, unknown> | null>
  agentPing(node: string, vmid: number): Promise<boolean>
  agentInterfaces(node: string, vmid: number): Promise<unknown>
  /** Addresses saved with Terminal logins (`qemu-150` → address). Context only. */
  hostAddresses(): Promise<Record<string, string>>
  /** Run one command on a node over its pinned node login. Null when there is no login or no address for it. */
  nodeRun(node: string, command: string): Promise<{ code: number; output: string } | null>
  probe(host: string, port: number): Promise<PresentedKey>
  pin(host: string, port: number): Promise<{ fingerprint: string | null; source: string | null; evidence: PinEvidence | null }>
  repin(host: string, port: number, fingerprint: string, source: PinSource, evidence: PinEvidence | null): Promise<void>
  /** Throws when the row was not written: a re-pin that cannot be audited does not happen. */
  audit(action: string, resource: string, details: Record<string, unknown>): Promise<void>
}

const label = (g: GuestRef) => `${g.type === 'lxc' ? 'container' : 'VM'} ${g.vmid}`
const shortType = (g: GuestRef) => (g.type === 'lxc' ? 'LXC' : 'VM')

async function mapLimit<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]) }))
}

interface Sighting { guest: GuestRef; how: 'config' | 'agent' | 'cloud-init' | 'saved'; agentOn: boolean }

/** Every guest that has `host` as an address, and how it is known to. */
async function sightings(host: string, deps: HostKeyCheckDeps): Promise<Sighting[]> {
  const want = cleanIp(host)
  const guests: GuestRef[] = (await deps.resources())
    .filter(r => (r?.type === 'lxc' || r?.type === 'qemu') && r.template !== 1 && Number.isInteger(Number(r.vmid)) && NODE_RE.test(String(r.node ?? '')))
    .map(r => ({ type: r.type, vmid: Number(r.vmid), node: String(r.node), name: String(r.name ?? r.vmid), status: String(r.status ?? 'unknown') }))
  const saved = await deps.hostAddresses().catch(() => ({} as Record<string, string>))
  const out: Sighting[] = []
  await mapLimit(guests, 8, async g => {
    const config = await deps.guestConfig(g.node, g.vmid, g.type).catch(() => null)
    if (g.type === 'lxc') {
      if (lxcConfigAddresses(config).includes(want)) out.push({ guest: g, how: 'config', agentOn: false })
      return
    }
    const agentOn = agentEnabled(config)
    if (g.status === 'running' && agentOn) {
      const answer = await deps.agentInterfaces(g.node, g.vmid).catch(() => null)
      if (answer && agentAddresses(answer).includes(want)) { out.push({ guest: g, how: 'agent', agentOn }); return }
    }
    if (vmConfigAddresses(config).includes(want)) { out.push({ guest: g, how: 'cloud-init', agentOn }); return }
    const s = saved[`qemu-${g.vmid}`]
    if (s && cleanIp(s) === want) out.push({ guest: g, how: 'saved', agentOn })
  })
  return out.sort((a, b) => a.guest.vmid - b.guest.vmid)
}

/** The guest's own host keys, read on its node. Null (with why) when they could not be read. */
async function readGuestKeys(g: GuestRef, deps: HostKeyCheckDeps): Promise<{ keys: GuestKey[]; via: 'pct' | 'guest-agent' } | { keys: null; why: string; agentDown?: boolean }> {
  if (!NODE_RE.test(g.node) || !Number.isInteger(g.vmid)) return { keys: null, why: 'its node or id is not one HyperProx can use' }
  const sq = GUEST_KEYS_SCRIPT.replace(/'/g, `'\\''`)
  if (g.type === 'lxc') {
    const r = await deps.nodeRun(g.node, `pct exec ${g.vmid} -- sh -c '${sq}'`).catch((e: any) => ({ code: -1, output: '', err: String(e?.message ?? e) }))
    if (!r) return { keys: null, why: `HyperProx has no login for node ${g.node}, so it could not look inside the container` }
    const keys = parseKeygenFingerprints(r.output)
    if (!keys.length) return { keys: null, why: (r as any).err ? `reading its keys on node ${g.node} failed: ${(r as any).err}` : 'the container lists no SSH host keys HyperProx could read' }
    return { keys, via: 'pct' }
  }
  if (!(await deps.agentPing(g.node, g.vmid).catch(() => false))) return { keys: null, why: 'its guest agent is not running, so HyperProx could not look inside the VM', agentDown: true }
  const r = await deps.nodeRun(g.node, `qm guest exec ${g.vmid} --timeout 20 -- sh -c '${sq}'`).catch((e: any) => ({ code: -1, output: '', err: String(e?.message ?? e) }))
  if (!r) return { keys: null, why: `HyperProx has no login for node ${g.node}, so it could not ask the VM's agent` }
  const ans = agentExecOutput(r.output)
  const keys = ans ? parseKeygenFingerprints(ans.out) : []
  if (!keys.length) return { keys: null, why: (r as any).err ? `asking the VM's agent on node ${g.node} failed: ${(r as any).err}` : 'the VM\'s agent did not list any SSH host keys HyperProx could read' }
  return { keys, via: 'guest-agent' }
}

function pinContext(pin: { source: string | null; evidence: PinEvidence | null }): string | null {
  if (pin.evidence?.kind === 'guest-keys') return `The old key was checked the same way, as the key of ${pin.evidence.guest}.`
  switch (pin.source) {
    case 'terminal-auto': return 'The old key was learned the first time this address was opened, and nobody checked it then.'
    case 'terminal': return 'The old key was accepted by hand in the Terminal.'
    case 'confirmed': return 'The old key was confirmed by an admin.'
    case 'verified': return `The old key was ${evidenceWords(pin.evidence)}.`
    case 'wizard': return 'The old key was learned by the setup wizard.'
    case 'api': return 'The old key was learned by HyperProx\'s own node runner.'
    default: return null
  }
}

/**
 * Check the key host:port offers now against its pin and, when it differs, against the guest that address belongs
 * to. `paneGuest` is the guest the pane was opened for (`lxc-101`), when it is one.
 */
export async function checkHostKey(host: string, port: number, deps: HostKeyCheckDeps, paneGuest?: { type: 'lxc' | 'qemu'; vmid: number } | null): Promise<HostKeyVerdict> {
  const [offered, pin] = await Promise.all([deps.probe(host, port), deps.pin(host, port)])
  const base = { host, port, pinned: pin.fingerprint, offered }
  if (!pin.fingerprint || pin.fingerprint === offered.fingerprint) return { ...base, state: 'unchanged', context: [] }

  const seen = await sightings(host, deps)
  const context: string[] = []
  const pc = pinContext(pin)
  if (pc) context.push(pc)

  // Only a running guest can be the one answering; the rest are what the address used to be, or is set aside for.
  const running = seen.filter(s => s.guest.status === 'running')
  for (const s of seen.filter(x => x.guest.status !== 'running')) {
    context.push(`${s.guest.type === 'lxc' ? 'Container' : 'VM'} ${s.guest.vmid} (${s.guest.name}, ${s.guest.status}) is also ${s.how === 'saved' ? 'remembered with' : 'configured with'} this address.`)
  }
  const unknown = (reason: UnknownReason, why: string, guest?: GuestRef): HostKeyVerdict => ({ ...base, state: 'unknown', reason, why, guest, context })

  // A VM running without an answering agent cannot say which addresses it has; one known to use this address
  // (cloud-init, or saved with its login) might be the one answering.
  const unverifiable = running.filter(s => s.guest.type === 'qemu' && s.how !== 'agent')
  const candidates = running.filter(s => s.guest.type === 'lxc' || s.how === 'agent')

  if (candidates.length > 1) {
    return unknown('several-guests', `More than one running guest is configured with this address (${candidates.map(s => `${label(s.guest)} ${s.guest.name}`).join(', ')}), so HyperProx cannot tell which one is answering.`)
  }
  if (!candidates.length) {
    if (unverifiable.length) {
      const g = unverifiable[0].guest
      return unknown('agent-down', `This address belongs to ${g.name} (${shortType(g)} ${g.vmid}), but its guest agent is not running, so HyperProx could not check its key with Proxmox.`, g)
    }
    return unknown('no-guest', 'No running guest in this cluster is configured with this address, so there is nothing for HyperProx to check the key against.')
  }

  const s = candidates[0]
  const g = s.guest
  if (unverifiable.length) context.push(`${unverifiable.map(u => `${label(u.guest)} (${u.guest.name})`).join(', ')} may also use this address; its agent could not say.`)
  if (paneGuest && (paneGuest.type !== g.type || paneGuest.vmid !== g.vmid)) {
    context.push(`This pane was opened for ${paneGuest.type === 'lxc' ? 'container' : 'VM'} ${paneGuest.vmid}, but the guest at this address is ${g.name} (${shortType(g)} ${g.vmid}).`)
  }

  const read = await readGuestKeys(g, deps)
  if (!read.keys) return unknown(read.agentDown ? 'agent-down' : 'read-failed', `This address belongs to ${g.name} (${shortType(g)} ${g.vmid}), but HyperProx could not check its key: ${read.why}.`, g)

  const match = read.keys.some(k => k.fingerprint === offered.fingerprint && k.type === offered.type)
  return { ...base, state: match ? 'verified' : 'mismatch', guest: g, via: read.via, guestKeys: read.keys, context }
}

// ---------------------------------------------------------------------------
//  Verdicts held for a trust, and the trust itself
// ---------------------------------------------------------------------------

interface Held { verdict: HostKeyVerdict; sid: string; terminalId: string; expires: number }
const VERDICT_TTL_MS = 10 * 60_000
const held = new Map<string, Held>()

function sweep(now = Date.now()) {
  for (const [k, v] of held) if (v.expires <= now) held.delete(k)
  while (held.size > 500) held.delete(held.keys().next().value as string)
}

/** Checks per signed-in session: 10 a minute. Each one probes a host and reads every guest's config. */
export const verifyLimiter = new AttemptLimiter(10, 60_000)

export class HostKeyCheckRefusal extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter?: number) { super(message); this.name = 'HostKeyCheckRefusal' }
}

function sessionOrRefuse(): { sid: string; email: string; role: Role } {
  const ctx = currentContext()
  if (!ctx || isTokenContext(ctx)) throw new HostKeyCheckRefusal('An API token cannot check or trust host keys. Sign in and use the Deck.', 403)
  return ctx
}

export interface PublicVerdict extends HostKeyVerdict { verdictId: string | null }

/** Run a check for the pane `terminalId` (its host and port already resolved on the server) and hold the verdict. */
export async function verifyForPane(terminalId: string, host: string, port: number, deps: HostKeyCheckDeps): Promise<PublicVerdict> {
  const ctx = sessionOrRefuse()
  const wait = verifyLimiter.retryAfter(ctx.sid)
  if (wait) throw new HostKeyCheckRefusal(`Too many host key checks. Try again in ${wait} s.`, 429, wait)
  verifyLimiter.fail(ctx.sid)
  const m = /^(lxc|qemu)-(\d{1,9})$/.exec(terminalId)
  const v = await checkHostKey(host, port, deps, m ? { type: m[1] as 'lxc' | 'qemu', vmid: Number(m[2]) } : null)
  sweep()
  if (v.state === 'unchanged') return { ...v, verdictId: null }
  const verdictId = randomBytes(18).toString('base64url')
  held.set(verdictId, { verdict: v, sid: ctx.sid, terminalId, expires: Date.now() + VERDICT_TTL_MS })
  return { ...v, verdictId }
}

/** The text an admin types to trust a key the guest's own keys contradict. */
export const OVERRIDE_PHRASE = 'trust anyway'

export interface TrustRequest { verdictId: string; confirmed?: boolean; phrase?: string }

/**
 * Pin the fingerprint a held verdict names, for the host:port it was checked on, and nothing else.
 *   verified  the role the Terminal needs (operator)
 *   unknown   admin, and `confirmed`
 *   mismatch  admin, and `phrase` typed exactly
 * The host must still offer that key and the old pin must still be the one the check replaced.
 */
export async function trustVerdict(terminalId: string, target: { host: string; port: number }, req: TrustRequest, deps: HostKeyCheckDeps): Promise<{ fingerprint: string; state: CheckState }> {
  const ctx = sessionOrRefuse()
  sweep()
  const h = held.get(String(req?.verdictId ?? ''))
  if (!h || h.sid !== ctx.sid || h.terminalId !== terminalId) throw new HostKeyCheckRefusal('That check has expired or is not yours. Check the key again.', 409)
  const v = h.verdict
  if (v.host !== target.host || v.port !== target.port) throw new HostKeyCheckRefusal('This pane now connects somewhere else. Check the key again.', 409)
  if (!FP_RE.test(v.offered.fingerprint)) throw new HostKeyCheckRefusal('That is not an SSH SHA256 fingerprint.', 400)

  const admin = hasRole(ctx.role, 'admin')
  if (v.state === 'mismatch') {
    if (!admin) throw new HostKeyCheckRefusal('Only an admin can trust a key that does not belong to the guest at this address.', 403)
    if (String(req.phrase ?? '').trim().toLowerCase() !== OVERRIDE_PHRASE) throw new HostKeyCheckRefusal(`Type "${OVERRIDE_PHRASE}" to trust this key.`, 400)
  } else if (v.state === 'unknown') {
    if (!admin) throw new HostKeyCheckRefusal('HyperProx could not check this key, so only an admin can trust it.', 403)
    if (req.confirmed !== true) throw new HostKeyCheckRefusal('Confirm that you want to trust this key.', 400)
  } else if (v.state !== 'verified') {
    throw new HostKeyCheckRefusal('Nothing to trust: the key has not changed.', 409)
  }

  const [now, pin] = await Promise.all([deps.probe(v.host, v.port), deps.pin(v.host, v.port)])
  if (now.fingerprint !== v.offered.fingerprint || now.type !== v.offered.type) {
    held.delete(req.verdictId)
    throw new HostKeyCheckRefusal(`${v.host}:${v.port} now offers ${now.fingerprint}, not the key that was checked. Nothing was changed; check again.`, 409)
  }
  if (pin.fingerprint !== v.pinned) {
    held.delete(req.verdictId)
    throw new HostKeyCheckRefusal('The pinned key changed since the check. Nothing was changed; check again.', 409)
  }

  const evidence: PinEvidence | null = v.state === 'verified' && v.guest && v.via
    ? { kind: 'guest-keys', guest: `${v.guest.name} (${shortType(v.guest)} ${v.guest.vmid})`, node: v.guest.node, via: v.via }
    : null
  const source: PinSource = v.state === 'verified' ? 'verified' : 'terminal'

  // The audit row first: a re-pin that cannot be recorded does not happen.
  await deps.audit('host_key.repin', `host:${v.host}:${v.port}`, {
    by: ctx.email, verdict: v.state, fingerprint: v.offered.fingerprint, keyType: v.offered.type, previous: v.pinned,
    terminalId, guest: v.guest ? `${v.guest.type}:${v.guest.vmid}` : null, guestName: v.guest?.name ?? null,
    via: v.via ?? null, override: v.state !== 'verified', reason: v.reason ?? null,
  })
  await deps.repin(v.host, v.port, v.offered.fingerprint, source, evidence)
  held.delete(req.verdictId)
  return { fingerprint: v.offered.fingerprint, state: v.state }
}

/** Tests: forget held verdicts and rate-limit counts. */
export function resetHostKeyChecks(): void { held.clear(); verifyLimiter.reset() }

// ---------------------------------------------------------------------------
//  Production wiring
// ---------------------------------------------------------------------------

export function productionHostKeyCheckDeps(): HostKeyCheckDeps {
  const pve = async () => (await import('./pve-env')).livePve()
  const enc = encodeURIComponent
  return {
    resources: async () => ((await (await pve()).getClusterResources()) as any[]) ?? [],
    guestConfig: async (node, vmid, type) => ((await (await pve()).getVMConfig(node, vmid, type)) as Record<string, unknown>) ?? null,
    agentPing: async (node, vmid) => {
      try { await (await pve()).fetchStrict(`/nodes/${enc(node)}/qemu/${vmid}/agent/ping`, 'POST', '', 8000); return true } catch { return false }
    },
    agentInterfaces: async (node, vmid) => (await pve()).fetchStrict(`/nodes/${enc(node)}/qemu/${vmid}/agent/network-get-interfaces`, 'GET', undefined, 8000),
    hostAddresses: async () => (await import('./terminal-hosts')).listHostAddresses(),
    nodeRun: async (node, command) => {
      const { nodeCredential, execOnNode } = await import('./node-exec')
      const { nodeAddressInContext } = await import('./clusters/nodes')
      const cred = await nodeCredential(node).catch(() => null)
      if (!cred) return null
      const host = await nodeAddressInContext(node, async () => {
        const rows = await (await pve()).fetchStrict<any[]>('/cluster/status').catch(() => [])
        return (rows ?? []).find((r: any) => r?.type === 'node' && r.name === node)?.ip ?? null
      })
      if (!host) return null
      const { auditCredentialUse } = await import('./audit')
      await auditCredentialUse('node_login.use', node, { purpose: 'read a guest\'s SSH host keys' })
      // Only a node whose own key is confirmed or verified is sent the login (execOnNode refuses any other).
      const r = await execOnNode({ host, cred, command: 'bash -s', input: command, timeoutMs: 45_000, requirePin: true, maxOutputBytes: 64_000 })
      return { code: r.code, output: r.output }
    },
    probe: (host, port) => probeKey(host, port),
    pin: async (host, port) => {
      const id = credentialId(`${host}:${port}`)
      const [fingerprint, source, ev] = await Promise.all([
        getCredential(CREDENTIAL_CATEGORY, 'hostkey', id),
        getCredential(CREDENTIAL_CATEGORY, 'hostkey-source', id).catch(() => null),
        getCredential(CREDENTIAL_CATEGORY, 'hostkey-evidence', id).catch(() => null),
      ])
      let evidence: PinEvidence | null = null
      try { evidence = ev ? JSON.parse(ev) : null } catch { /* unreadable: none */ }
      return { fingerprint: fingerprint ?? null, source: source ?? null, evidence }
    },
    repin: (host, port, fp, source, evidence) => repinHostKey(host, port, fp, source, evidence),
    audit: (action, resource, details) => auditOrThrow(action, resource, details),
  }
}

let depsOverride: Partial<HostKeyCheckDeps> | null = null
/** Tests stand in for Proxmox, the nodes and the probe; anything not given is the production one. */
export function setHostKeyCheckDeps(d: Partial<HostKeyCheckDeps> | null): void { depsOverride = d }
export function hostKeyCheckDeps(): HostKeyCheckDeps { return { ...productionHostKeyCheckDeps(), ...(depsOverride ?? {}) } }
