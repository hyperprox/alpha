// =============================================================================
//  HyperProx — audit trail for credential use
//
//  Every use of a stored login or key leaves a row: what was used, for what, by whom. Never the value.
//  record() refuses a details object whose values look like secrets: anything under a key named like one
//  (password, secret, key, token, passphrase), so a caller cannot leak one into Postgres by accident.
// =============================================================================

import { PrismaClient } from '@prisma/client'
import { appLog } from './log-once'
import { currentContext } from './auth'

export interface AuditSink {
  write(row: { action: string; resource: string; details?: Record<string, unknown> }): Promise<void>
}

let sink: AuditSink | null = null

/** For tests, and for index.ts to share the app's Prisma client. */
export function setAuditSink(s: AuditSink | null): void { sink = s; sinkWasSet = s !== null }
let sinkWasSet = false

/** Tests: whether a sink was set on purpose (otherwise rows go to a Prisma client opened on first use). */
export function hasAuditSink(): boolean { return sinkWasSet }

export function prismaAuditSink(db: PrismaClient): AuditSink {
  return { async write(r) { await db.auditLog.create({ data: { action: r.action, resource: r.resource, details: (r.details ?? undefined) as any } }) } }
}

const SECRET_KEY = /pass(word|phrase)?|secret|token|private.?key|api.?key|^key$/i
/** Named like a secret but never one: the API token's name that auditBy (lib/http/request-actor.ts) records. */
const NOT_SECRET = new Set(['tokenName'])

/** Drop anything that could be a secret value: only names, ids, counts and outcomes are kept. */
export function scrubDetails(details: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(details)) {
    if (SECRET_KEY.test(k) && !NOT_SECRET.has(k)) continue
    if (v === null || ['number', 'boolean'].includes(typeof v)) out[k] = v
    else if (typeof v === 'string') out[k] = v.slice(0, 200)
    else if (Array.isArray(v)) out[k] = v.filter(x => typeof x === 'string' || typeof x === 'number').slice(0, 50)
  }
  return out
}

/** Rows written for a request that was confirmed on the page (lib/confirm.ts) say so: `confirmed: 'in page'`. */
function withConfirmation(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!currentContext()?.confirmedInPage || (details && 'confirmed' in details)) return details
  return { ...(details ?? {}), confirmed: 'in page' }
}

/** Record a use of a credential. Never throws: an audit failure is logged, not fatal. */
export async function auditCredentialUse(action: string, resource: string, details?: Record<string, unknown>): Promise<void> {
  try {
    if (!sink) sink = prismaAuditSink(new PrismaClient())
    await sink.write({ action, resource, details: scrubDetails(withConfirmation(details)) })
  } catch (e: any) {
    appLog.warn({ err: e, action, resource }, `audit: could not record ${action} on ${resource}`)
  }
}

/** The same row, for a caller that must know when it was not written (it says so to the person). Throws on failure. */
export async function auditOrThrow(action: string, resource: string, details?: Record<string, unknown>): Promise<void> {
  if (!sink) sink = prismaAuditSink(new PrismaClient())
  await sink.write({ action, resource, details: scrubDetails(withConfirmation(details)) })
}
