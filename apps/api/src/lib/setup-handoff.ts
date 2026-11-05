// =============================================================================
//  HyperProx — secrets given to the setup wizard before the vault existed
//
//  The setup wizard runs before anyone has created the owner account, so there is no vault to put a node
//  login or a GoDaddy key in yet. It never writes them to a file. When setup finishes, it hands them to
//  this process over loopback (POST /api/auth/setup-handoff, with the setup key), and they are held here,
//  in memory only, until the owner's first sign-in stores them in the vault. Then they are dropped.
//
//  If HyperProx restarts before the owner signs in, they are gone, and Settings → Setup checklist asks for
//  them again. That is the price of never writing them down.
// =============================================================================

import { readFileSync, writeFileSync, renameSync, chmodSync } from 'fs'
import { saveCredential } from './ssh-broker'
import { pinHostKey } from './node-exec'
import { setCredentials } from './credentials'
import { requestContext, type RequestContext } from './auth'
import { auditCredentialUse } from './audit'

export interface HeldNodeLogin {
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  /** The nodes this login was tested on. */
  nodes: string[]
  /** The host key each node showed the wizard on first connection, pinned for the rest of its run. */
  hostKeys?: Record<string, { address: string; fingerprint: string }>
}
export interface HeldSecrets {
  nodeLogin?: HeldNodeLogin
  godaddy?: { key: string; secret: string }
}

let held: HeldSecrets = {}
// The hand-over is accepted once. A second one (or one after the owner exists) is refused: by then the
// way to give HyperProx a login is Settings → Setup checklist, as a signed-in owner.
let accepted = false
export class HandoffRefused extends Error {}

/** Refuse unless this is the first hand-over and no owner exists yet. Marks it accepted. */
export function acceptHandoff(ownerExists: boolean): void {
  if (ownerExists) throw new HandoffRefused('The owner account already exists. Add logins and keys on Settings → Setup checklist.')
  if (accepted) throw new HandoffRefused('The setup wizard has already handed over what it held.')
  accepted = true
}

const str = (v: unknown, max = 16_384) => typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined

/** Validate and hold what the wizard sends. Unknown fields are dropped. Returns what is now held (no values). */
export function holdSetupSecrets(body: unknown): ReturnType<typeof heldSummary> {
  const b = (body ?? {}) as any
  const nl = b.nodeLogin
  if (nl && str(nl.username, 64) && (str(nl.password) || str(nl.privateKey)) && Array.isArray(nl.nodes)) {
    held.nodeLogin = {
      username: nl.username,
      ...(str(nl.password) ? { password: nl.password } : {}),
      ...(str(nl.privateKey) ? { privateKey: nl.privateKey } : {}),
      ...(str(nl.passphrase) ? { passphrase: nl.passphrase } : {}),
      nodes: (nl.nodes as unknown[]).filter((n): n is string => typeof n === 'string' && /^[A-Za-z0-9.-]{1,63}$/.test(n)).slice(0, 64),
    }
    const keys: HeldNodeLogin['hostKeys'] = {}
    for (const [node, k] of Object.entries((nl.hostKeys ?? {}) as Record<string, any>)) {
      if (held.nodeLogin.nodes.includes(node) && typeof k?.address === 'string' && /^SHA256:[A-Za-z0-9+/]{43}$/.test(String(k?.fingerprint ?? ''))) {
        keys[node] = { address: k.address.slice(0, 64), fingerprint: k.fingerprint }
      }
    }
    held.nodeLogin.hostKeys = keys
  }
  const gd = b.godaddy
  if (gd && str(gd.key, 256) && str(gd.secret, 256)) held.godaddy = { key: gd.key, secret: gd.secret }
  return heldSummary()
}

export function heldSummary(): { nodeLogin: { nodes: string[] } | null; godaddy: boolean } {
  return { nodeLogin: held.nodeLogin ? { nodes: [...held.nodeLogin.nodes] } : null, godaddy: Boolean(held.godaddy) }
}

export function clearHeldSecrets(): void { held = {}; accepted = false }

/**
 * The owner exists, so setup is done whatever .env says: record SETUP_COMPLETE=true and remove the setup
 * key. (An install made before setup recorded it can have an owner and no SETUP_COMPLETE line.)
 */
export function markSetupDone(envPath = process.env.ENV_FILE_PATH || '/opt/hyperprox/.env'): boolean {
  let text: string
  try { text = readFileSync(envPath, 'utf8') } catch { return false }
  // Only an install still holding a setup key needs this; anything else is left exactly as it is.
  if (!/^SETUP_SECRET=/m.test(text)) return false
  let next = text.split('\n').filter(l => !/^SETUP_SECRET=/.test(l)).join('\n')
  if (/^SETUP_COMPLETE=/m.test(next)) next = next.replace(/^SETUP_COMPLETE=.*$/m, 'SETUP_COMPLETE=true')
  else next = `${next.replace(/\n?$/, '\n')}SETUP_COMPLETE=true\n`
  if (next === text) return false
  const tmp = `${envPath}.hpx-tmp`
  writeFileSync(tmp, next, { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, envPath)
  delete process.env.SETUP_SECRET
  return true
}

/**
 * Store what is held in the vault, as the owner who just signed in, then forget it. Something that fails
 * to store stays held, so the next owner sign-in tries again.
 */
export async function flushHeldSecrets(as: RequestContext): Promise<{ stored: string[]; failed: string[] }> {
  const stored: string[] = [], failed: string[] = []
  if (!held.nodeLogin && !held.godaddy) return { stored, failed }
  await requestContext.run(as, async () => {
    const nl = held.nodeLogin
    if (nl) {
      let ok = true
      for (const node of nl.nodes) {
        // The host key the wizard saw is pinned with the login. A different key already pinned for that
        // address means something changed since: the login is not stored for it.
        const hk = nl.hostKeys?.[node]
        if (hk) {
          const pin = await pinHostKey(hk.address, hk.fingerprint).catch(() => 'conflict' as const)
          if (pin === 'conflict') { failed.push(`node login for ${node} (its host key does not match the one already pinned)`); continue }
        }
        try {
          await saveCredential(`node-${node}`, { username: nl.username, password: nl.password, privateKey: nl.privateKey, passphrase: nl.passphrase, port: 22 } as any)
          await auditCredentialUse('node_login.save', `node:${node}`, { by: as.email, source: 'setup wizard' })
          stored.push(`node login for ${node}`)
        } catch { ok = false; failed.push(`node login for ${node}`) }
      }
      if (ok) delete held.nodeLogin
    }
    if (held.godaddy) {
      try {
        await setCredentials('dns', 'godaddy', { api_key: held.godaddy.key, api_secret: held.godaddy.secret })
        await auditCredentialUse('dns_key.save', 'dns:godaddy', { by: as.email, source: 'setup wizard' })
        stored.push('GoDaddy key')
        delete held.godaddy
      } catch { failed.push('GoDaddy key') }
    }
  })
  return { stored, failed }
}
