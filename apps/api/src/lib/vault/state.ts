// STUB — replaced by vg-broker at merge
// Unlock state per the build contract: decrypted secrets and the session-signing key live in process
// memory only, and are wiped on lock.

import { randomBytes } from 'crypto'
import { getBroker, type SecretItem } from './broker'

let key: Buffer | null = null
const cache = new Map<string, SecretItem>()
const lockCallbacks: Array<() => void> = []
let idleTimer: NodeJS.Timeout | null = null

function idleMs(): number {
  const minutes = Number(process.env.VAULT_IDLE_LOCK_MINUTES ?? 30)
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60_000
}

export function isUnlocked(): boolean {
  return key !== null
}

export async function unlock(fromSid: string): Promise<void> {
  const items = await getBroker().listSecrets(fromSid)
  cache.clear()
  for (const item of items) cache.set(item.name, item)
  key = randomBytes(32)
  touch()
}

export async function lock(_reason: 'idle' | 'manual' | 'restart'): Promise<void> {
  if (key) key.fill(0)
  key = null
  cache.clear()
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  for (const cb of lockCallbacks) {
    try { cb() } catch { /* a failing listener must not keep the vault unlocked */ }
  }
}

export function signingKey(): Buffer | null {
  return key
}

export function cachedSecret(name: string): SecretItem | undefined {
  return cache.get(name)
}

export function putCachedSecret(item: SecretItem): void {
  cache.set(item.name, item)
}

export function touch(): void {
  if (!key) return
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => { void lock('idle') }, idleMs())
  idleTimer.unref()
}

export function onLock(cb: () => void): void {
  lockCallbacks.push(cb)
}
