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

import { saveCredential } from './ssh-broker'
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
}
export interface HeldSecrets {
  nodeLogin?: HeldNodeLogin
  godaddy?: { key: string; secret: string }
}

let held: HeldSecrets = {}

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
  }
  const gd = b.godaddy
  if (gd && str(gd.key, 256) && str(gd.secret, 256)) held.godaddy = { key: gd.key, secret: gd.secret }
  return heldSummary()
}

export function heldSummary(): { nodeLogin: { nodes: string[] } | null; godaddy: boolean } {
  return { nodeLogin: held.nodeLogin ? { nodes: [...held.nodeLogin.nodes] } : null, godaddy: Boolean(held.godaddy) }
}

export function clearHeldSecrets(): void { held = {} }

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
