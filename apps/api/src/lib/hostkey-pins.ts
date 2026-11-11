// =============================================================================
//  HyperProx — where each SSH host-key pin came from
//
//  A pin is the fingerprint HyperProx accepts for host:port (vault item hyperprox:deck/hostkey). Next to it,
//  hyperprox:deck/hostkey-source records how it got there:
//
//    terminal       a person explicitly accepted the displayed fingerprint in the Terminal (reserved; the
//                   Terminal does not ask yet, so nothing writes it today)
//    confirmed      an admin checked the fingerprint and pressed confirm (Setup checklist, Remote access, HA)
//    verified       HyperProx checked it itself against evidence an attacker cannot easily fake, and recorded
//                   which (hyperprox:deck/hostkey-evidence): the cluster's record of its keys read on a node
//                   (an anchor), that record read through nodes already trusted, the private link's identity
//                   (Tailscale, WireGuard), or a session already proven to be that machine. See lib/hostkey-verify.ts.
//    terminal-auto  the Terminal learned it on first connection; it was shown, but nobody accepted it
//    wizard         the setup wizard saw it on first connection (on screen, not confirmed)
//    api            HyperProx's own node runner learned it on first use, with nobody looking
//
//  Only terminal, confirmed and verified count as confirmed. requirePin callers accept nothing else, and the
//  Setup checklist lists every other pin (and a pin from before provenance was kept, which has no source): it
//  verifies them automatically where evidence exists, and keeps a confirm button (master password) for the rest.
// =============================================================================

import { getCredential, setCredential, deleteCredential, listCredentialKeys } from './credentials'
import { currentRemote } from './clusters/context'
import { homeAddresses } from './clusters/registry'

const CATEGORY = 'deck'
const PIN = 'hostkey'
const SOURCE = 'hostkey-source'
const EVIDENCE = 'hostkey-evidence'
const MIGRATED = 'hostkey-migrated'
export type PinSource = 'terminal' | 'confirmed' | 'verified' | 'terminal-auto' | 'wizard' | 'api'
const CONFIRMED: PinSource[] = ['terminal', 'confirmed', 'verified']
const SOURCES: PinSource[] = ['terminal', 'confirmed', 'verified', 'terminal-auto', 'wizard', 'api']

/** What a `verified` pin was verified with. Public facts only: node names, a tailnet device id, an interface. */
export type PinEvidence =
  | { kind: 'setup-local'; node: string; source: AnchorSource; method: 'presented-key' | 'proof' }
  | { kind: 'cluster-record'; cluster: string; readers: string[]; method: 'two-readers' | 'one-reader-proof' | 'record-key-session' }
  | { kind: 'tailnet'; nodeId: string; owner: string; device: string }
  | { kind: 'wireguard'; iface: string; peer: string }
  | { kind: 'trusted-session'; via: string }

const EVIDENCE_KINDS = ['setup-local', 'cluster-record', 'tailnet', 'wireguard', 'trusted-session']
function parseEvidence(raw: string | null): PinEvidence | null {
  if (!raw) return null
  try { const e = JSON.parse(raw); return e && EVIDENCE_KINDS.includes(e.kind) ? e as PinEvidence : null } catch { return null }
}

const ANCHOR_WORDS: Record<AnchorSource, string> = { installer: 'read on the node itself by the installer', pasted: 'read on a node by the command you ran there' }

/** The evidence in plain words, for the Setup checklist and the audit log. */
export function evidenceWords(e: PinEvidence | null): string {
  if (!e) return 'verified automatically'
  switch (e.kind) {
    case 'setup-local': return `verified automatically: it is the key the cluster records for ${e.node}, ${ANCHOR_WORDS[e.source] ?? 'read on a node'}${e.method === 'proof' ? ' (the node proved it holds that key)' : ''}`
    case 'cluster-record': return `verified automatically: the cluster's record of this node's key, read through ${e.readers.join(' and ')} (already trusted), matches${e.method === 'one-reader-proof' || e.method === 'record-key-session' ? ', and the node proved it holds that key' : ''}`
    case 'tailnet': return `verified automatically: reached over your tailnet at this exact address, which is the device ${e.device} owned by ${e.owner}`
    case 'wireguard': return `verified automatically: reached over HyperProx's own WireGuard link ${e.iface} (peer ${e.peer})`
    case 'trusted-session': return `verified automatically: read from the machine itself over a session already proven to be it (${e.via})`
  }
}

// ── Anchors ──────────────────────────────────────────────────────────────────
//  What HyperProx first trusts a cluster's keys from, before any of its own checks: the cluster's record of its
//  nodes' keys (and the node's own key files) read ON a node, by the installer running there as root or by the
//  command the owner runs there and pastes back. Public keys only. Kept per cluster and node name in
//  hyperprox:deck/hostkey-anchor (`home:<node>`, or `<cluster id>:<node>`).

const ANCHOR = 'hostkey-anchor'
export type AnchorSource = 'installer' | 'pasted'
export interface Anchor { keys: Array<{ type: string; fingerprint: string }>; source: AnchorSource; at: string }
const anchorId = (scope: string, node: string) => `${scope}:${node}`.replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 120)

export async function saveAnchor(scope: string, node: string, a: Anchor): Promise<void> {
  await setCredential(CATEGORY, ANCHOR, anchorId(scope, node), JSON.stringify(a), false)
}
export async function getAnchor(scope: string, node: string): Promise<Anchor | null> {
  const raw = await getCredential(CATEGORY, ANCHOR, anchorId(scope, node)).catch(() => null)
  if (!raw) return null
  try { const a = JSON.parse(raw); return Array.isArray(a?.keys) ? a as Anchor : null } catch { return null }
}

/** The cluster whose pins apply here: null at home, the remote's id while working for a remote server. */
export function pinScope(): string | null { return currentRemote()?.id ?? null }

/**
 * The vault id of the pin for host:port. At home it is `host:port`, the same id the Terminal uses. For a remote
 * server it starts with that cluster's id (`c0123456789:host:port`), so a remote node whose address happens to be
 * a home node's address (two private networks both using 10.0.0.x, say) never inherits the home node's pin, and
 * the other way round.
 */
export function pinId(host: string, port = 22, scope: string | null = pinScope()): string {
  return (scope ? `${scope}:${host}:${port}` : `${host}:${port}`).replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 120)
}

/** A pin id that belongs to a remote server (shown on that server's pages, not on the home checklist). */
export function isRemotePinId(id: string): boolean { return /^c[0-9a-f]{10}:/.test(id) }

/**
 * Pins kept before remote pins were scoped sat at the plain `host:port` id. The first time a remote's node is looked
 * up, its old pin is COPIED to the scoped id, once, when the address is one of that remote's node addresses and not
 * one of the home addresses HyperProx knows. The plain one is left where it is: it may just as well be a home guest's
 * pin on the same address, which must stay at home. A marker keeps it from being copied again after it is cleared.
 */
async function migrateLegacy(host: string, port: number): Promise<boolean> {
  const r = currentRemote()
  if (!r) return false
  const low = host.toLowerCase()
  if (!Object.values(r.nodeAddresses).map(a => a.toLowerCase()).includes(low)) return false
  if (homeAddresses().includes(low)) return false
  const legacy = pinId(host, port, null), id = pinId(host, port)
  if (await getCredential(CATEGORY, MIGRATED, id).catch(() => null)) return false
  const fp = await getCredential(CATEGORY, PIN, legacy)
  if (!fp) return false
  const [src, ev] = await Promise.all([getCredential(CATEGORY, SOURCE, legacy), getCredential(CATEGORY, EVIDENCE, legacy).catch(() => null)])
  // A pin someone confirmed or HyperProx verified at home is a home machine's: it is never lent to a remote server,
  // where it would let that server's scripts and logins go to whatever answers with the home key.
  if (CONFIRMED.includes(src as PinSource)) return false
  await setCredential(CATEGORY, PIN, id, fp, false)
  if (src) await setCredential(CATEGORY, SOURCE, id, src, false)
  if (ev) await setCredential(CATEGORY, EVIDENCE, id, ev, false)
  await setCredential(CATEGORY, MIGRATED, id, new Date().toISOString(), false)
  console.warn(`[hostkeys] copied the pin for ${host}:${port} to ${r.name}'s own pins; the home copy was left in place, in case a home machine uses that address too`)
  return true
}

export async function pinnedKey(host: string, port = 22): Promise<string | null> {
  const v = await getCredential(CATEGORY, PIN, pinId(host, port))
  if (v !== null && v !== undefined) return v
  return (await migrateLegacy(host, port)) ? getCredential(CATEGORY, PIN, pinId(host, port)) : null
}

export async function pinSource(host: string, port = 22): Promise<PinSource | null> {
  let s = await getCredential(CATEGORY, SOURCE, pinId(host, port))
  if (!s && await migrateLegacy(host, port)) s = await getCredential(CATEGORY, SOURCE, pinId(host, port))
  return SOURCES.includes(s as PinSource) ? (s as PinSource) : null
}

export function isConfirmedSource(s: PinSource | null): boolean { return s !== null && CONFIRMED.includes(s) }

/** Pin host:port to fingerprint and record how. */
export async function recordPin(host: string, port: number, fingerprint: string, source: PinSource): Promise<void> {
  await setCredential(CATEGORY, PIN, pinId(host, port), fingerprint, false)
  await setCredential(CATEGORY, SOURCE, pinId(host, port), source, false)
}

/** Record how an existing pin is known, without changing the pin. */
export async function setPinSource(host: string, port: number, source: PinSource): Promise<void> {
  await setCredential(CATEGORY, SOURCE, pinId(host, port), source, false)
}

/** The pin is this fingerprint, and an admin confirmed it. What requirePin accepts. */
export async function confirmedPin(host: string, port: number, fingerprint: string): Promise<boolean> {
  const [pin, src] = await Promise.all([pinnedKey(host, port), pinSource(host, port)])
  return pin === fingerprint && isConfirmedSource(src)
}

export async function forgetPin(host: string, port = 22, scope: string | null = pinScope()): Promise<void> {
  if (scope === pinScope()) await migrateLegacy(host, port).catch(() => false)   // copied first, so the marker keeps it from coming back
  await deleteCredential(CATEGORY, PIN, pinId(host, port, scope))
  await deleteCredential(CATEGORY, SOURCE, pinId(host, port, scope)).catch(() => undefined)
  await deleteCredential(CATEGORY, EVIDENCE, pinId(host, port, scope)).catch(() => undefined)
}

export async function pinEvidence(host: string, port = 22): Promise<PinEvidence | null> {
  return parseEvidence(await getCredential(CATEGORY, EVIDENCE, pinId(host, port)).catch(() => null))
}

export class PinVerifyRefusal extends Error {}

/**
 * Record that HyperProx verified `fingerprint` for host:port with `evidence`. A different key already pinned is
 * never replaced: a key that changed is refused here as everywhere else. A pin someone confirmed stays as it is.
 */
export async function recordVerified(host: string, port: number, fingerprint: string, evidence: PinEvidence): Promise<'pinned' | 'verified' | 'already'> {
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) throw new PinVerifyRefusal('That is not an SSH SHA256 fingerprint.')
  const [pin, src] = await Promise.all([pinnedKey(host, port), pinSource(host, port)])
  if (pin && pin !== fingerprint) throw new PinVerifyRefusal(`A different key is pinned for ${host}:${port} (${pin}); a changed key is never accepted automatically.`)
  if (pin && isConfirmedSource(src)) return 'already'
  await setCredential(CATEGORY, EVIDENCE, pinId(host, port), JSON.stringify(evidence), false)
  if (pin) { await setPinSource(host, port, 'verified'); return 'verified' }
  await recordPin(host, port, fingerprint, 'verified')
  return 'pinned'
}

export interface PinRow { id: string; fingerprint: string; source: PinSource | null; confirmed: boolean; evidence?: PinEvidence | null }

/** Every pin with its source (null: pinned before sources were recorded), and the evidence of a verified one. */
export async function listPins(): Promise<PinRow[]> {
  const rows = await listCredentialKeys(CATEGORY, PIN)
  const out: PinRow[] = []
  for (const r of rows) {
    const fingerprint = (await getCredential(CATEGORY, PIN, r.key)) ?? ''
    const s = await getCredential(CATEGORY, SOURCE, r.key)
    const source = SOURCES.includes(s as PinSource) ? (s as PinSource) : null
    const evidence = source === 'verified' ? parseEvidence(await getCredential(CATEGORY, EVIDENCE, r.key).catch(() => null)) : null
    out.push({ id: r.key, fingerprint, source, confirmed: isConfirmedSource(source), evidence })
  }
  return out
}

export class PinConfirmRefusal extends Error {}

/**
 * An admin confirms the fingerprint they checked on the machine. It must be the key the host presents now,
 * and the same as any pin already there: a different pin is replaced only in the Terminal, deliberately.
 */
export async function confirmPin(host: string, port: number, fingerprint: string, presented: (host: string, port: number) => Promise<string>): Promise<'pinned' | 'confirmed' | 'already'> {
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) throw new PinConfirmRefusal('That is not an SSH SHA256 fingerprint.')
  const now = await presented(host, port)
  if (now !== fingerprint) throw new PinConfirmRefusal(`${host}:${port} presents ${now} now, not the key you confirmed. Nothing was changed.`)
  const [pin, src] = await Promise.all([pinnedKey(host, port), pinSource(host, port)])
  if (pin && pin !== fingerprint) throw new PinConfirmRefusal(`A different key is pinned for ${host}:${port} (${pin}). If the machine was rebuilt, clear that pin in the Terminal first.`)
  if (pin && isConfirmedSource(src)) return 'already'
  if (pin) { await setPinSource(host, port, 'confirmed'); return 'confirmed' }
  await recordPin(host, port, fingerprint, 'confirmed')
  return 'pinned'
}
