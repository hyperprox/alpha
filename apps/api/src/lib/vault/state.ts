// =============================================================================
//  HyperProx — Unlock state
//
//  Locked by default. The first successful sign-in calls unlock(), which loads
//  the HyperProx collection into memory and makes a fresh random session-signing
//  key. lock() — on idle timeout, on request, or at startup — drops the cache,
//  zeroes the key, signs out every vault session (zeroing a fast session's keys,
//  deleting a CLI session's data dir), so every issued session becomes unverifiable.
//
//  Two places the unlocked state can live:
//
//    in-process  (VAULT_KEYHOLDER_SOCKET unset) this process's memory only. An
//                API restart locks. The idle timer runs here.
//    keyholder   (VAULT_KEYHOLDER_SOCKET set) also in the hyperprox-keyholder
//                service (./keyholder.ts), a separate long-lived process that
//                deploys do not restart. At unlock the API puts a snapshot there
//                (key, cache, sessions: ./snapshot.ts) and keeps it current; after
//                an API restart it reads it back and carries on unlocked. The
//                keyholder enforces the idle timeout and tells the API when it
//                locks; if it stops or crashes, the API locks too (fail closed).
//                It must be reachable to unlock at all.
// =============================================================================

import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { getBroker, type SecretItem } from './broker'
import { idleLockMs, keyholderSocket, keyholderUnit } from './config'
import { KeyholderClient, KeyholderError, KEYHOLDER_PROTOCOL, type KeyholderLastLock } from './keyholder'
import { loadParts, registerSnapshotPart, saveParts, setSnapshotListener } from './snapshot'

/** `keyholder`: the keyholder stopped, crashed or restarted while unlocked. */
export type LockReason = 'idle' | 'manual' | 'restart' | 'keyholder'

/** Unlock is impossible: keyholder mode is on and the keyholder cannot be reached. */
export class KeyholderUnavailableError extends Error {
  constructor() {
    super('the keyholder service is not running, so HyperProx cannot unlock (systemctl status hyperprox-keyholder)')
    this.name = 'KeyholderUnavailableError'
  }
}

/**
 * Lock asked for, but the keyholder neither confirmed it nor could be restarted: it may still hold the
 * unlocked state. This process has wiped its own copy; HyperProx must not be reported as locked.
 */
export class KeyholderLockError extends Error {
  constructor() {
    super('the keyholder did not confirm the lock and could not be restarted; it may still hold the unlocked state (systemctl restart hyperprox-keyholder)')
    this.name = 'KeyholderLockError'
  }
}

/** Restarting the keyholder wipes it: the last resort when it does not confirm a lock. */
type Restarter = (reason: LockReason) => Promise<void>
const systemctlRestart: Restarter = () => new Promise((resolve, reject) => {
  execFile('systemctl', ['restart', keyholderUnit()], { timeout: 30_000 }, (err) => err ? reject(err) : resolve())
})
let restartKeyholderImpl: Restarter = systemctlRestart
/** Tests swap in their own; null puts systemctl back. */
export function setKeyholderRestarter(fn: Restarter | null): void {
  restartKeyholderImpl = fn ?? systemctlRestart
}

let key: Buffer | null = null
let cache = new Map<string, SecretItem>()
let idleTimer: NodeJS.Timeout | null = null
let unlocking: Promise<void> | null = null
const lockCallbacks: Array<(reason: LockReason) => void> = []
const unlockCallbacks: Array<(how: 'sign-in' | 'restored') => void> = []

// Keyholder mode
let kh: KeyholderClient | null = null
let khEpoch: string | null = null
let khConnecting: Promise<boolean> | null = null
let khRetry: NodeJS.Timeout | null = null
let khLastLock: KeyholderLastLock | null = null
let khAttached = false
let lastTouchSent = 0
let saveQueued = false
let saving: Promise<void> = Promise.resolve()

interface Logger { info(msg: string): void; warn(msg: string): void }
let log: Logger = { info: () => undefined, warn: () => undefined }
/** Where state changes are reported. Messages carry reasons and counts, never a secret. */
export function setStateLogger(l: Logger): void { log = l }

export function isUnlocked(): boolean {
  return key !== null
}

export function keyholderMode(): boolean {
  return !!keyholderSocket()
}

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => { void lock('idle') }, idleLockMs())
  idleTimer.unref()
}

// ---------------------------------------------------------------------------
//  Snapshot (keyholder mode)
// ---------------------------------------------------------------------------

const SNAPSHOT_VERSION = 1

// The vault sessions, through whichever broker is current (tests swap a fake in).
registerSnapshotPart('broker', {
  save: () => getBroker().exportSessions?.() ?? null,
  load: async (data) => { if (data != null) await getBroker().importSessions?.(data) },
})

function buildSnapshot(k: Buffer, items: Map<string, SecretItem>): string {
  const doc = { v: SNAPSHOT_VERSION, key: k.toString('base64'), secrets: [...items.values()], parts: saveParts() }
  return Buffer.from(JSON.stringify(doc), 'utf8').toString('base64')
}

async function restoreSnapshot(b64: string): Promise<void> {
  const doc = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
  if (doc?.v !== SNAPSHOT_VERSION) throw new Error(`snapshot version ${doc?.v} is not ${SNAPSHOT_VERSION}`)
  const k = Buffer.from(String(doc.key ?? ''), 'base64')
  if (k.length !== 32) throw new Error('snapshot has no signing key')
  const next = new Map<string, SecretItem>()
  for (const it of Array.isArray(doc.secrets) ? doc.secrets : []) if (it?.name) next.set(String(it.name), it)
  await loadParts(doc.parts ?? {})
  cache = next
  key = k
}

function queueSave(): void {
  if (!key || !khEpoch || !kh || saveQueued) return
  saveQueued = true
  setImmediate(() => {
    saveQueued = false
    saving = saving.then(async () => {
      if (!key || !khEpoch || !kh) return
      try { await kh.update(khEpoch, buildSnapshot(key, cache)) }
      catch (e) {
        // 'locked': the keyholder locked first; its event (sent before this answer) has already locked us.
        if (e instanceof KeyholderError && e.code !== 'locked' && e.code !== 'gone') log.warn(`[vault] keyholder update failed (${e.code})`)
      }
    })
  })
}

setSnapshotListener(() => queueSave())

function onKeyholderLocked(reason: string): void {
  if (!key) return
  const r: LockReason = reason === 'idle' || reason === 'manual' || reason === 'restart' ? reason : 'keyholder'
  log.info(`[vault] the keyholder locked HyperProx (${reason})`)
  void lockLocal(r)
}

function onKeyholderGone(): void {
  kh = null
  khEpoch = null
  if (key) {
    log.warn('[vault] the keyholder stopped or restarted: HyperProx is locked')
    void lockLocal('keyholder')
  }
  scheduleReconnect()
}

let khBackoff = 1000

/** Retries with backoff (1 s doubling to 60 s), so a refused or missing keyholder does not flood the journal. */
function scheduleReconnect(): void {
  if (khRetry || !khAttached) return
  khRetry = setTimeout(async () => {
    khRetry = null
    if (await connectKeyholder()) { khBackoff = 1000; return }
    khBackoff = Math.min(khBackoff * 2, 60_000)
    scheduleReconnect()
  }, khBackoff)
  khRetry.unref()
}

/**
 * Connects (if not connected) and brings this process in line with the keyholder:
 * restores its snapshot when it holds one and this process is locked.
 * False when the keyholder is not reachable.
 */
function connectKeyholder(): Promise<boolean> {
  if (kh?.connected) return Promise.resolve(true)
  if (khConnecting) return khConnecting
  khConnecting = (async () => {
    const path = keyholderSocket()
    if (!path) return false
    // Events count only from the connection in use (not from a failed handshake, or one already dropped).
    const client: KeyholderClient = new KeyholderClient(path, {
      locked: (r) => { if (kh === client) onKeyholderLocked(r) },
      gone:   () => { if (kh === client) onKeyholderGone() },
    })
    try {
      await client.connect()
      const hello = await client.hello()
      if (hello.v !== KEYHOLDER_PROTOCOL) {
        log.warn(`[vault] keyholder speaks protocol ${hello.v}, this API ${KEYHOLDER_PROTOCOL}; not using it`)
        client.close()
        return false
      }
      kh = client
      khLastLock = hello.lastLock
      if (hello.unlocked && !key) {
        const got = await client.get()
        try {
          if (!got.unlocked || !got.snapshot || !got.epoch) throw new Error('keyholder locked in between')
          await restoreSnapshot(got.snapshot)
          khEpoch = got.epoch
          log.info('[vault] unlocked state restored from the keyholder')
          for (const cb of unlockCallbacks) { try { cb('restored') } catch { /* a callback must not stop it */ } }
        } catch (e) {
          // A snapshot this API cannot read (a format change, a half-written state) must not leave the
          // keyholder unlocked with no way to sign in again: lock both.
          log.warn(`[vault] could not restore the keyholder's state (${(e as Error).message}); locking`)
          await client.lock('restart').catch(() => undefined)
          await lockLocal('restart', true)
        }
      }
      // Not here: "nothing held anywhere" cleanup. A sign-in may be using its new vault session right now.
      return true
    } catch {
      if (kh === client) kh = null
      client.close()
      return false
    }
  })()
  return khConnecting.finally(() => { khConnecting = null })
}

/**
 * Startup. In-process mode: always locked (and clears CLI dirs a previous process left).
 * Keyholder mode: attaches, restoring the unlocked state if the keyholder holds one; keeps
 * trying in the background if it is not up yet (waits up to `waitMs` for the first answer).
 */
export async function attachUnlockState(waitMs = 10_000): Promise<{ mode: 'in-process' | 'keyholder'; reachable: boolean }> {
  if (!keyholderMode()) {
    await lock('restart')
    return { mode: 'in-process', reachable: true }
  }
  khAttached = true
  const until = Date.now() + waitMs
  for (;;) {
    if (await connectKeyholder()) {
      // Nothing held anywhere: clear what a previous process may have left (CLI dirs in tmpfs).
      if (!key) await lockLocal('restart')
      return { mode: 'keyholder', reachable: true }
    }
    if (Date.now() >= until) break
    await new Promise(r => setTimeout(r, 250))
  }
  log.warn('[vault] the keyholder is not reachable; HyperProx stays locked until it is')
  await lockLocal('restart')
  scheduleReconnect()
  return { mode: 'keyholder', reachable: false }
}

/** Why the keyholder last locked (from its hello), for the lock alert after an API restart. */
export function keyholderLastLock(): KeyholderLastLock | null {
  return khLastLock
}

/** Tests: drop this process's memory and connection as an API crash would, without telling the keyholder. */
export function detachForTests(): void {
  khAttached = false
  if (khRetry) { clearTimeout(khRetry); khRetry = null }
  const c = kh
  kh = null
  khEpoch = null
  khLastLock = null
  c?.close()   // kh is already null, so its 'gone' changes nothing here
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  key = null
  cache = new Map()
}

// ---------------------------------------------------------------------------
//  Unlock / lock
// ---------------------------------------------------------------------------

/**
 * Unlocks from a signed-in vault session. Idempotent while unlocked: a second
 * user's sign-in does not rotate the key (that would void everyone else's session).
 * Keyholder mode: unlocked only once the keyholder holds the state; if it cannot be
 * reached, throws KeyholderUnavailableError and stays locked.
 */
export async function unlock(fromSid: string): Promise<void> {
  if (key) { touch(); return }
  if (unlocking) return unlocking
  unlocking = (async () => {
    const items = await getBroker().listSecrets(fromSid)
    const next = new Map<string, SecretItem>()
    for (const it of items) next.set(it.name, it)
    const k = crypto.randomBytes(32)
    if (keyholderMode()) {
      if (!(await connectKeyholder()) || !kh) { k.fill(0); throw new KeyholderUnavailableError() }
      const snap = buildSnapshot(k, next)
      let rolledBack = false
      try {
        try {
          khEpoch = await kh.unlock(snap, idleLockMs())
        } catch (e) {
          if (!(e instanceof KeyholderError && e.code === 'already_unlocked')) throw e
          // Held by an unlock this process does not know about (it could not restore it): replace it.
          if (!(await ensureKeyholderLocked('restart'))) { rolledBack = true; throw e }
          if (!kh && !(await connectKeyholder())) { rolledBack = true; throw e }
          khEpoch = await kh!.unlock(snap, idleLockMs())
        }
      } catch {
        // A timeout or error does not prove it took nothing: lock it (or restart it) before giving up.
        k.fill(0)
        khEpoch = null
        if (!rolledBack) await ensureKeyholderLocked('restart')
        throw new KeyholderUnavailableError()
      }
      lastTouchSent = Date.now()
    } else {
      armIdleTimer()
    }
    cache = next
    key = k
    for (const cb of unlockCallbacks) { try { cb('sign-in') } catch { /* a callback must not stop the unlock */ } }
    // Sessions registered right after this (addSession) reach the keyholder through snapshotChanged().
  })()
  try { await unlocking } finally { unlocking = null }
}

/** Wipes this process's unlocked state. Does not tell the keyholder (see lock()). */
async function lockLocal(reason: LockReason, force = false): Promise<void> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  const wasUnlocked = key !== null
  if (key) key.fill(0)
  key = null
  khEpoch = null
  cache.clear()
  cache = new Map()
  // Callbacks run as soon as memory is wiped, before the (slow) CLI sign-outs.
  // `force`: a restore that failed half-way may have loaded sessions; the callbacks clear them.
  if (wasUnlocked || reason !== 'restart' || force) {
    for (const cb of lockCallbacks) {
      try { cb(reason) } catch { /* a callback must not stop the lock */ }
    }
  }
  try { await getBroker().signOutAll() } catch { /* dirs are best-effort; state is already locked */ }
}

/**
 * Makes sure the keyholder holds nothing: asks it to lock, and if it does not answer ok, restarts it
 * (a restart wipes it). True once one of the two is confirmed. The connection is dropped before a
 * restart, so its closing is not taken for a crash (no "keyholder restarted" alert for this).
 */
async function ensureKeyholderLocked(reason: LockReason): Promise<boolean> {
  const client = kh
  if (client?.connected) {
    try { await client.lock(reason); return true } catch { /* not confirmed: restart below */ }
  }
  if (kh === client) { kh = null; khEpoch = null }
  client?.close()
  try {
    await restartKeyholderImpl(reason)
    return true
  } catch (e) {
    log.warn(`[vault] the keyholder did not confirm the lock and its restart failed (${(e as Error).name})`)
    return false
  } finally {
    scheduleReconnect()
  }
}

/**
 * Locks. With a keyholder it is told FIRST, and HyperProx counts as locked only once the keyholder
 * confirmed (or was restarted); otherwise this throws KeyholderLockError after wiping this process.
 */
export async function lock(reason: LockReason): Promise<void> {
  const tell = keyholderMode() && reason !== 'keyholder'
  const confirmed = tell ? await ensureKeyholderLocked(reason) : true
  await lockLocal(reason)
  if (!confirmed) throw new KeyholderLockError()
}

/** The current session-signing key, or null when locked. Do not keep a copy. */
export function signingKey(): Buffer | null {
  return key
}

export function cachedSecret(name: string): SecretItem | undefined {
  return key ? cache.get(name) : undefined
}

export function putCachedSecret(item: SecretItem): void {
  if (key) { cache.set(item.name, item); queueSave() }
}

/** Additive to the contract: drop one item from the cache (after a vault delete). */
export function removeCachedSecret(name: string): void {
  if (cache.delete(name)) queueSave()
}

/** Additive to the contract: every cached item (empty when locked). For the Secrets page. */
export function cachedSecrets(): SecretItem[] {
  return key ? [...cache.values()] : []
}

/**
 * Resets the idle timer. Call on every request from a signed-in session. With a keyholder,
 * at most one touch per few seconds goes over the socket (the timeout is minutes long).
 */
export function touch(): void {
  if (!key) return
  if (!keyholderMode()) { armIdleTimer(); return }
  const now = Date.now()
  const gap = Math.min(10_000, Math.floor(idleLockMs() / 10))
  if (now - lastTouchSent < gap) return
  lastTouchSent = now
  kh?.touch().catch(() => undefined)
}

export function onLock(cb: (reason: LockReason) => void): void {
  lockCallbacks.push(cb)
}

/** Runs after an unlock by sign-in, or after the state was restored from the keyholder at startup. */
export function onUnlock(cb: (how: 'sign-in' | 'restored') => void): void {
  unlockCallbacks.push(cb)
}
