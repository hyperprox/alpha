// =============================================================================
//  HyperProx — the WebSockets each signed-in session has open
//
//  A socket is authenticated once, at its upgrade. Without this, a live-status feed, an update log or a
//  terminal opened before a sign-out, a lock or a session the vault ended would carry on for as long as the
//  browser kept it open. Every socket route registers its socket here with the session that opened it; when
//  that session ends (sign-out, removal, or a lock, which ends them all) its sockets are closed.
// =============================================================================

import { onSessionEnd } from './auth'
import { onLock } from './vault/state'

export interface TrackedSocket { readyState: number; close(code?: number, reason?: string): void; send(m: string): void; on(ev: 'close', fn: () => void): unknown }

/** Which route opened it: the live-status feed (/ws), a terminal, the update log. */
export type SocketKind = 'live' | 'terminal' | 'updates'
interface Entry { socket: TrackedSocket; sid: string; email: string; kind: SocketKind }
const entries = new Set<Entry>()

/** Close code sent when the session behind a socket has ended (4401: application-defined, "sign in again"). */
export const SESSION_ENDED = 4401

function closeEntry(e: Entry): void {
  entries.delete(e)
  try { e.socket.close(SESSION_ENDED, 'session ended') } catch { /* already gone */ }
}

/** Register a socket opened by `session`; it is closed when that session ends. */
export function trackSocket(session: { sid: string; email: string }, socket: TrackedSocket, kind: SocketKind): void {
  const e: Entry = { socket, sid: session.sid, email: session.email, kind }
  entries.add(e)
  socket.on('close', () => entries.delete(e))
}

/** Close every socket of one session (sign-out, the session removed). */
export function closeSessionSockets(sid: string): number {
  let n = 0
  for (const e of [...entries]) if (e.sid === sid) { closeEntry(e); n++ }
  return n
}

/** Close every tracked socket (a lock ends every session). */
export function closeAllSockets(): number {
  const n = entries.size
  for (const e of [...entries]) closeEntry(e)
  return n
}

/** The open sockets of one kind, optionally only those of whoever signed in as `email` (all their sessions). */
export function openSockets(kind: SocketKind, email?: string): TrackedSocket[] {
  const want = email?.toLowerCase()
  return [...entries]
    .filter(e => e.kind === kind && e.socket.readyState === 1 && (want === undefined || e.email.toLowerCase() === want))
    .map(e => e.socket)
}

export function trackedSocketCount(): number { return entries.size }

onSessionEnd(sid => { if (sid === null) closeAllSockets(); else closeSessionSockets(sid) })
onLock(() => { closeAllSockets() })
