// =============================================================================
//  HyperProx — Admin Authentication
//  Single-admin model: one password, stored as a scrypt hash in the credential
//  store (which encrypts it at rest on top of the hash).
//  Uses node:crypto rather than bcrypt/argon2 — no native dependency needed.
// =============================================================================

import { pbkdf2Sync, randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { getCredential, setCredential } from './credentials'

const KEYLEN = 64
const PREFIX = 'scrypt'
const CRED   = { category: 'system', provider: 'hyperprox', key: 'admin_password_hash' }
// The setup wizard's hash most recently adopted, so a later password change is not undone on restart.
const SETUP  = { category: 'system', provider: 'hyperprox', key: 'admin_setup_hash' }

/** Produce `scrypt$<salt>$<derived>` — salt is unique per call. */
export function hashPassword(password: string): string {
  const salt    = randomBytes(16).toString('hex')
  const derived = scryptSync(password, salt, KEYLEN).toString('hex')
  return `${PREFIX}$${salt}$${derived}`
}

/** Constant-time comparison. Returns false for any malformed stored value. */
export function verifyPassword(password: string, stored: string): boolean {
  // The setup wizard hashes with PBKDF2 (`pbkdf2:<salt>:<hash>`, sha512, 310000 rounds).
  if ((stored ?? '').startsWith('pbkdf2:')) {
    const [, salt, expected] = stored.split(':')
    if (!salt || !expected) return false
    const expectedBuf = Buffer.from(expected, 'hex')
    const derived     = pbkdf2Sync(password, salt, 310000, expectedBuf.length || 64, 'sha512')
    if (expectedBuf.length !== derived.length) return false
    return timingSafeEqual(derived, expectedBuf)
  }

  const [scheme, salt, expected] = (stored ?? '').split('$')
  if (scheme !== PREFIX || !salt || !expected) return false

  const derived     = scryptSync(password, salt, KEYLEN)
  const expectedBuf = Buffer.from(expected, 'hex')
  if (expectedBuf.length !== derived.length) return false

  return timingSafeEqual(derived, expectedBuf)
}

export async function getAdminHash(): Promise<string | null> {
  return getCredential(CRED.category, CRED.provider, CRED.key)
}

export async function setAdminPassword(password: string): Promise<void> {
  await setCredential(CRED.category, CRED.provider, CRED.key, hashPassword(password), true)
}

/**
 * Ensure an admin password exists before the server accepts traffic.
 * Seeds from ADMIN_PASSWORD if set, otherwise generates one and logs it once.
 */
export async function ensureAdminPassword(log: (msg: string) => void): Promise<void> {
  // The password chosen in the setup wizard wins over anything generated before it. Adopt each wizard
  // hash once: afterwards a password change through the API stands until the wizard sets a new one.
  const fromSetup = process.env.SETUP_ADMIN_HASH
  if (fromSetup && fromSetup !== await getCredential(SETUP.category, SETUP.provider, SETUP.key)) {
    await setCredential(CRED.category, CRED.provider, CRED.key, fromSetup, true)
    await setCredential(SETUP.category, SETUP.provider, SETUP.key, fromSetup, true)
    log('[auth] Admin password set from the setup wizard')
    return
  }

  const existing = await getAdminHash()
  if (existing) return

  const fromEnv  = process.env.ADMIN_PASSWORD
  const password = fromEnv || randomBytes(12).toString('base64url')

  await setAdminPassword(password)

  if (fromEnv) {
    log('[auth] Admin password initialised from ADMIN_PASSWORD')
  } else {
    log(
      '[auth] ==================================================================\n' +
      '[auth]  No admin password was configured, so one has been generated:\n' +
      `[auth]      ${password}\n` +
      '[auth]  This is shown once. Change it via POST /api/auth/password.\n' +
      '[auth] =================================================================='
    )
  }
}

// ── Token extraction ─────────────────────────────────────────────────────────

export const COOKIE_NAME = 'hyperprox_token'

/**
 * Pull the JWT from the auth cookie, falling back to a Bearer header so curl and
 * scripts still work. The cookie is what the browser uses: the frontend proxies
 * /api/* through Next rewrites, so a same-host cookie rides along automatically
 * and no fetch call site needs to change.
 */
export function extractToken(headers: Record<string, any>): string | null {
  const auth = headers['authorization']
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim()

  const raw = headers['cookie']
  if (typeof raw !== 'string') return null

  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === COOKIE_NAME) return part.slice(eq + 1).trim()
  }
  return null
}

/** Serialise the auth cookie. Max-Age 0 clears it. */
export function buildAuthCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ')
}
