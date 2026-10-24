// =============================================================================
//  HyperProx — Unlock state (process memory only)
//
//  Locked by default: a restart is always locked. The first successful sign-in
//  calls unlock(), which loads the HyperProx collection into memory and makes a
//  fresh random session-signing key. lock() — on idle timeout, on request, or at
//  startup — drops the cache, zeroes the key, signs out every vault session
//  (zeroing a fast session's keys, deleting a CLI session's data dir), so every
//  issued session becomes unverifiable.
// =============================================================================

import crypto from 'node:crypto'
import { getBroker, type SecretItem } from './broker'
import { idleLockMs } from './config'

export type LockReason = 'idle' | 'manual' | 'restart'

let key: Buffer | null = null
let cache = new Map<string, SecretItem>()
let idleTimer: NodeJS.Timeout | null = null
let unlocking: Promise<void> | null = null
const lockCallbacks: Array<(reason: LockReason) => void> = []

export function isUnlocked(): boolean {
  return key !== null
}

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => { void lock('idle') }, idleLockMs())
  idleTimer.unref()
}

/**
 * Unlocks from a signed-in vault session. Idempotent while unlocked: a second
 * user's sign-in does not rotate the key (that would void everyone else's session).
 */
export async function unlock(fromSid: string): Promise<void> {
  if (key) { touch(); return }
  if (unlocking) return unlocking
  unlocking = (async () => {
    const items = await getBroker().listSecrets(fromSid)
    const next = new Map<string, SecretItem>()
    for (const it of items) next.set(it.name, it)
    cache = next
    key = crypto.randomBytes(32)
    armIdleTimer()
  })()
  try { await unlocking } finally { unlocking = null }
}

export async function lock(reason: LockReason): Promise<void> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  const wasUnlocked = key !== null
  if (key) key.fill(0)
  key = null
  cache.clear()
  cache = new Map()
  // Callbacks run as soon as memory is wiped, before the (slow) CLI sign-outs.
  if (wasUnlocked || reason !== 'restart') {
    for (const cb of lockCallbacks) {
      try { cb(reason) } catch { /* a callback must not stop the lock */ }
    }
  }
  try { await getBroker().signOutAll() } catch { /* dirs are best-effort; state is already locked */ }
}

/** The current session-signing key, or null when locked. Do not keep a copy. */
export function signingKey(): Buffer | null {
  return key
}

export function cachedSecret(name: string): SecretItem | undefined {
  return key ? cache.get(name) : undefined
}

export function putCachedSecret(item: SecretItem): void {
  if (key) cache.set(item.name, item)
}

/** Additive to the contract: drop one item from the cache (after a vault delete). */
export function removeCachedSecret(name: string): void {
  cache.delete(name)
}

/** Additive to the contract: every cached item (empty when locked). For the Secrets page. */
export function cachedSecrets(): SecretItem[] {
  return key ? [...cache.values()] : []
}

/** Resets the idle timer. Call on every request from a signed-in session. */
export function touch(): void {
  if (key) armIdleTimer()
}

export function onLock(cb: (reason: LockReason) => void): void {
  lockCallbacks.push(cb)
}
