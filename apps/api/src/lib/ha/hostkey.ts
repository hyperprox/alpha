// =============================================================================
//  HyperProx — HA: node SSH host keys for maintenance mode
//
//  Maintenance mode has no PVE API, so it runs `ha-manager` over the node's
//  stored login. node-exec accepts a host whose key was never pinned, and then
//  sends that login to whoever answered. Maintenance mode refuses that: the
//  node's key must be pinned first. These helpers check, probe and pin, in the
//  same store the Terminal pins to (category "deck", provider "hostkey",
//  key "<address>:22"). The probe connects, reads the key the host presents,
//  and closes before authenticating: no credential is sent.
// =============================================================================

import { Client } from 'ssh2'
import { CREDENTIAL_CATEGORY, credentialId, fingerprintOf } from '../ssh-broker'
import { getCredential, setCredential } from '../credentials'

const HOSTKEY_PROVIDER = 'hostkey'
const pinKey = (host: string, port = 22) => credentialId(`${host}:${port}`)

export async function pinnedFingerprint(host: string, port = 22): Promise<string | null> {
  return getCredential(CREDENTIAL_CATEGORY, HOSTKEY_PROVIDER, pinKey(host, port))
}

/** The key `host` presents, as an OpenSSH SHA256 fingerprint. Nothing is authenticated or sent. */
export function probeFingerprint(host: string, port = 22, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = new Client()
    let seen: string | null = null
    const done = (e?: Error) => { try { c.end() } catch { /* closed */ } if (seen) resolve(seen); else reject(e ?? new Error(`${host} presented no host key`)) }
    const t = setTimeout(() => done(new Error(`${host}:${port} did not answer within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)
    c.on('error', e => { clearTimeout(t); done(seen ? undefined : e) })
    c.on('close', () => { clearTimeout(t); done() })
    c.connect({
      host, port, username: 'hyperprox-hostkey-probe', readyTimeout: timeoutMs,
      // Refuse every key: the handshake stops here, before any authentication.
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => { seen = fingerprintOf(key); verify(false) },
    } as any)
  })
}

/**
 * Pin `host` to `fingerprint`, only if the host presents exactly that key now (the admin checked the value
 * shown in the preview; a different key since then is refused). Never replaces an existing different pin.
 */
export async function pinFingerprint(host: string, fingerprint: string, deps: {
  probe?: (host: string) => Promise<string>
  pinned?: (host: string) => Promise<string | null>
  save?: (host: string, fp: string) => Promise<void>
} = {}): Promise<{ pinned: string; already: boolean }> {
  const probe = deps.probe ?? (h => probeFingerprint(h))
  const pinned = deps.pinned ?? (h => pinnedFingerprint(h))
  const save = deps.save ?? ((h, fp) => setCredential(CREDENTIAL_CATEGORY, HOSTKEY_PROVIDER, pinKey(h), fp, false))
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) throw new Error('That is not an SSH SHA256 fingerprint.')
  const cur = await pinned(host)
  if (cur && cur !== fingerprint) throw new Error(`${host} is already pinned to a different key (${cur}). Clear that pin in Terminal settings first if the node was rebuilt.`)
  if (cur === fingerprint) return { pinned: fingerprint, already: true }
  const now = await probe(host)
  if (now !== fingerprint) throw new Error(`${host} now presents ${now}, not the key you checked (${fingerprint}). Nothing was pinned.`)
  await save(host, fingerprint)
  return { pinned: fingerprint, already: false }
}
