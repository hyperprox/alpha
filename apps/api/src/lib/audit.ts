// =============================================================================
//  HyperProx — audit trail for credential use
//
//  Every use of a stored login or key leaves a row: what was used, for what, by whom. Never the value.
//  record() refuses a details object whose values look like secrets: anything under a key named like one
//  (password, secret, key, token, passphrase), so a caller cannot leak one into Postgres by accident.
// =============================================================================

import { PrismaClient } from '@prisma/client'

export interface AuditSink {
  write(row: { action: string; resource: string; details?: Record<string, unknown> }): Promise<void>
}

let sink: AuditSink | null = null

/** For tests, and for index.ts to share the app's Prisma client. */
export function setAuditSink(s: AuditSink | null): void { sink = s }

export function prismaAuditSink(db: PrismaClient): AuditSink {
  return { async write(r) { await db.auditLog.create({ data: { action: r.action, resource: r.resource, details: (r.details ?? undefined) as any } }) } }
}

const SECRET_KEY = /pass(word|phrase)?|secret|token|private.?key|api.?key|^key$/i

/** Drop anything that could be a secret value: only names, ids, counts and outcomes are kept. */
export function scrubDetails(details: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(details)) {
    if (SECRET_KEY.test(k)) continue
    if (v === null || ['number', 'boolean'].includes(typeof v)) out[k] = v
    else if (typeof v === 'string') out[k] = v.slice(0, 200)
    else if (Array.isArray(v)) out[k] = v.filter(x => typeof x === 'string' || typeof x === 'number').slice(0, 50)
  }
  return out
}

/** Record a use of a credential. Never throws: an audit failure is logged, not fatal. */
export async function auditCredentialUse(action: string, resource: string, details?: Record<string, unknown>): Promise<void> {
  try {
    if (!sink) sink = prismaAuditSink(new PrismaClient())
    await sink.write({ action, resource, details: scrubDetails(details) })
  } catch (e: any) {
    console.warn(`[audit] could not record ${action} on ${resource}: ${e?.message ?? e}`)
  }
}
