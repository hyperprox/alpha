// =============================================================================
//  HyperProx — where each SSH host-key pin came from
//
//  A pin is the fingerprint HyperProx accepts for host:port (vault item hyperprox:deck/hostkey). Next to it,
//  hyperprox:deck/hostkey-source records how it got there:
//
//    terminal   learned when someone opened the host in the Terminal, which shows the key it learned
//    confirmed  an admin checked the fingerprint and pressed confirm (Setup checklist, Remote access, HA)
//    wizard     the setup wizard saw it on first connection (its fingerprints were on screen, not confirmed)
//    api        HyperProx's own node runner learned it on first use, with nobody looking
//
//  Only terminal and confirmed count as confirmed. requirePin callers accept nothing else, and the Setup
//  checklist lists every other pin (and a pin from before provenance was kept, which has no source) with a
//  confirm button that needs the master password.
// =============================================================================

import { getCredential, setCredential, deleteCredential, listCredentialKeys } from './credentials'

const CATEGORY = 'deck'
const PIN = 'hostkey'
const SOURCE = 'hostkey-source'
export type PinSource = 'terminal' | 'confirmed' | 'wizard' | 'api'
const CONFIRMED: PinSource[] = ['terminal', 'confirmed']
const SOURCES: PinSource[] = ['terminal', 'confirmed', 'wizard', 'api']

/** Same id the Terminal and node-exec use for host:port. */
export function pinId(host: string, port = 22): string {
  return `${host}:${port}`.replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 120)
}

export async function pinnedKey(host: string, port = 22): Promise<string | null> {
  return getCredential(CATEGORY, PIN, pinId(host, port))
}

export async function pinSource(host: string, port = 22): Promise<PinSource | null> {
  const s = await getCredential(CATEGORY, SOURCE, pinId(host, port))
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

export async function forgetPin(host: string, port = 22): Promise<void> {
  await deleteCredential(CATEGORY, PIN, pinId(host, port))
  await deleteCredential(CATEGORY, SOURCE, pinId(host, port)).catch(() => undefined)
}

/** Every pin with its source (null: pinned before sources were recorded). */
export async function listPins(): Promise<Array<{ id: string; fingerprint: string; source: PinSource | null; confirmed: boolean }>> {
  const rows = await listCredentialKeys(CATEGORY, PIN)
  const out = []
  for (const r of rows) {
    const fingerprint = (await getCredential(CATEGORY, PIN, r.key)) ?? ''
    const s = await getCredential(CATEGORY, SOURCE, r.key)
    const source = SOURCES.includes(s as PinSource) ? (s as PinSource) : null
    out.push({ id: r.key, fingerprint, source, confirmed: isConfirmedSource(source) })
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
