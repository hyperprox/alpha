// =============================================================================
//  HyperProx — Updates: the admin sockets on /ws/updates
//
//  The general /ws channel is viewer-level, and these frames carry step output
//  and log lines from hosts, so they go only to sockets an admin opened here.
//  The runner publishes through broadcast(); routes/updates.ts adds sockets.
// =============================================================================

import type { UpdatesWsPayload } from './types'

export interface UpdatesSocket { readyState: number; send(m: string): void; close(): void }

const subscribers = new Set<UpdatesSocket>()

/** Same framing as lib/ws-broadcast.ts: { type: 'updates', payload, ts }. */
export function broadcast(payload: UpdatesWsPayload): void {
  const msg = JSON.stringify({ type: 'updates', payload, ts: Date.now() })
  for (const c of subscribers) if (c.readyState === 1) c.send(msg)
}

export function addSubscriber(s: UpdatesSocket): void { subscribers.add(s) }
export function removeSubscriber(s: UpdatesSocket): void { subscribers.delete(s) }

/** A lock ends every session; the sockets those sessions opened go with them. */
export function closeAllSubscribers(): void {
  for (const c of subscribers) { try { c.close() } catch { /* gone */ } }
  subscribers.clear()
}

/** For tests: how many admin sockets are listening. */
export function subscriberCount(): number { return subscribers.size }
