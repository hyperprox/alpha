// =============================================================================
//  HyperProx — AI operator routes (/api/ai/operator)
//
//  Roles (lib/roles.ts: a GET is viewer, anything else admin):
//    GET  /settings        viewer: the tier ladder's settings and whether keys are stored (a viewer does not get the local
//                          server's address or the keep-it-local words, only that they are set)
//    PUT  /settings        admin: change settings. Loosening privacy or spending limits is confirmed on the page
//                          (lib/confirm.ts); everything else saves at once. Audited by field name, never by value.
//    PUT  /key             admin, confirmed: store (or clear) the local tier's key in the vault. Works for a signed-in
//                          session only: an API token is refused (lib/api-tokens.ts tokenForbidden, and again by
//                          lib/credentials.ts). The answer says "stored" or "not stored", never the key.
//    GET  /tiers           viewer: each tier's status
//    GET  /spend           viewer: this month's estimated spend against the cap
//    POST /ask             admin: ask a question; the answer says which tier gave it and which were tried. Opus asks
//                          first (status needs_approval) unless the setting is off.
//                          `item` (optional) is the one Arr Stack download the person pointed at; the answer may then carry `proposals`
//                          (lib/ai/operator/fixes.ts): fixes to show as cards. Nothing is run by the operator.
//    POST /ask/approve     admin: the same question again with the single-use approval token from /ask
//  Every write is a signed-in admin's act: API tokens are refused by name (tokenForbidden).
// =============================================================================

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { sendFailure, sendRefusal } from '../lib/failure'
import { requireConfirm } from '../lib/confirm'
import { auditOrThrow } from '../lib/audit'
import { auditBy, contextActor } from '../lib/http/request-actor'
import { hasRole, type Role } from '../lib/roles'
import { currentOperatorService } from '../lib/ai/operator/production'
import type { OperatorService } from '../lib/ai/operator/service'
import { isTier, type OperatorSettings } from '../lib/ai/operator/types'
import type { AskInput } from '../lib/ai/operator/router'
import { parseItem } from '../lib/ai/operator/fixes'

const MAX_QUESTION = 8000
const MAX_KEY = 600

/** Does this change make the operator less private or less restricted? Those are confirmed. */
export function loosening(cur: OperatorSettings, next: OperatorSettings): string[] {
  const out: string[] = []
  if (cur.redactBeforeCloud && !next.redactBeforeCloud) out.push('stop hiding addresses and host names before cloud calls')
  if (next.localOnlyTopics.length < cur.localOnlyTopics.length || cur.localOnlyTopics.some(t => !next.localOnlyTopics.includes(t))) out.push('remove a keep-it-local topic')
  if (cur.opusNeedsApproval && !next.opusNeedsApproval) out.push('let Opus run without asking each time')
  if (cur.monthlyCapUsd > 0 && (next.monthlyCapUsd === 0 || next.monthlyCapUsd > cur.monthlyCapUsd)) out.push(next.monthlyCapUsd === 0 ? 'remove the monthly cap' : 'raise the monthly cap')
  return out
}

/** Names of the settings that differ: what the audit row records (never values, so a topic keyword stays out). */
function changedFields(a: OperatorSettings, b: OperatorSettings): string[] {
  const out: string[] = []
  for (const k of Object.keys(b) as Array<keyof OperatorSettings>) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(String(k))
  return out
}

export function makeOperatorRoutes(deps: { service?: () => OperatorService | null; audit?: typeof auditOrThrow } = {}): FastifyPluginAsync {
  const svc = deps.service ?? currentOperatorService
  const audit = deps.audit ?? auditOrThrow

  const need = (reply: FastifyReply): OperatorService | null => {
    const s = svc()
    if (!s) { sendRefusal(reply, 503, 'not_ready', 'The AI operator is not available yet. Try again in a minute.'); return null }
    return s
  }
  const fail = (req: FastifyRequest, reply: FastifyReply, e: unknown) =>
    sendFailure(req, reply, e, 'The AI operator could not do that. The details are in the log.', { status: 502 })
  const who = () => auditBy(contextActor()).by

  return async fastify => {
    fastify.get('/settings', async (req, reply) => {
      const s = need(reply); if (!s) return
      try {
        const settings = await s.settings()
        // A viewer sees the switches and limits, not the local server's address or the keep-it-local words.
        const admin = hasRole((req.session?.role ?? 'viewer') as Role, 'admin')
        return reply.send({ ok: true, settings: admin ? settings : { ...settings, localBaseUrl: settings.localBaseUrl ? 'set' : '', localOnlyTopics: settings.localOnlyTopics.map(() => '') }, keys: await s.keyStatus() })
      } catch (e) { return fail(req, reply, e) }
    })

    fastify.put<{ Body: Record<string, unknown> }>('/settings', async (req, reply) => {
      const s = need(reply); if (!s) return
      try {
        const body = req.body ?? {}
        const { current: cur, next: preview } = await s.preview(body)
        const loose = loosening(cur, preview)
        if (loose.length && !(await requireConfirm(req, reply, `This will ${loose.join(' and ')}.`))) return
        const next = await s.saveSettings(body, String(who() ?? ''))
        await audit('ai.operator.settings', 'ai:operator', { by: who(), changed: changedFields(cur, next) })
        return reply.send({ ok: true, settings: next })
      } catch (e) { return fail(req, reply, e) }
    })

    fastify.put<{ Body: { key?: unknown } }>('/key', async (req, reply) => {
      const s = need(reply); if (!s) return
      const key = req.body?.key
      if (typeof key !== 'string' || key.length > MAX_KEY || /[\r\n]/.test(key)) return sendRefusal(reply, 400, 'invalid', 'Paste the key as a single line of text.')
      const value = key.trim()
      if ((await s.keyStatus()).locked) return sendRefusal(reply, 423, 'vault_locked', 'HyperProx is locked. Sign in to unlock it, then save the key.')
      const summary = value ? "This will store the local model's key in HyperProx's vault, replacing any key already there." : "This will remove the local model's key from HyperProx's vault."
      if (!(await requireConfirm(req, reply, summary))) return
      try {
        await s.setLocalKey(value)
        await audit('ai.operator.key', 'ai:operator', { by: who(), action: value ? 'stored' : 'cleared' })
        return reply.send({ ok: true, stored: value !== '' })
      } catch (e) { return fail(req, reply, e) }
    })

    fastify.get('/tiers', async (req, reply) => {
      const s = need(reply); if (!s) return
      try { return reply.send({ ok: true, tiers: await s.tiers(), keys: await s.keyStatus() }) } catch (e) { return fail(req, reply, e) }
    })

    fastify.get('/spend', async (req, reply) => {
      const s = need(reply); if (!s) return
      try { return reply.send({ ok: true, ...(await s.spend()) }) } catch (e) { return fail(req, reply, e) }
    })

    const ask = async (req: FastifyRequest<{ Body: any }>, reply: FastifyReply, approving: boolean) => {
      const s = need(reply); if (!s) return
      const b: any = req.body ?? {}
      if (typeof b.text !== 'string' || !b.text.trim()) return sendRefusal(reply, 400, 'invalid', 'Type a question first.')
      if (b.text.length > MAX_QUESTION) return sendRefusal(reply, 400, 'invalid', 'That question is too long. Keep it under 8,000 characters.')
      if (b.force !== undefined && b.force !== null && b.force !== '' && b.force !== 'auto' && !isTier(b.force)) return sendRefusal(reply, 400, 'invalid', 'Pick local, haiku, sonnet or opus, or leave the tier on automatic.')
      if (approving && (typeof b.approval !== 'string' || !b.approval)) return sendRefusal(reply, 400, 'invalid', 'This needs the approval from the first answer.')
      const item = b.item === undefined || b.item === null ? null : parseItem(b.item)
      if (b.item !== undefined && b.item !== null && !item) return sendRefusal(reply, 400, 'invalid', 'That item could not be read. Ask again from the page.')
      const sid = req.session?.sid
      if (!sid) return sendRefusal(reply, 401, 'signed_out', 'Sign in to ask the operator.')
      const input: AskInput = {
        text: b.text, source: 'ui', userRef: sid, actor: String(who() ?? ''), role: String(req.session?.role ?? ''),
        force: isTier(b.force) ? b.force : null,
        ...(item ? { item } : {}),
        ...(approving ? { approval: b.approval } : {}),
        ...(b.attempt && typeof b.attempt.verified === 'boolean' ? { attempt: { verified: b.attempt.verified, ...(isTier(b.attempt.tier) ? { tier: b.attempt.tier } : {}) } } : {}),
        ...(typeof b.fingerprint === 'string' && b.fingerprint ? { fingerprint: b.fingerprint.slice(0, 80) } : {}),
      }
      try { return reply.send({ ok: true, result: await s.ask(input) }) } catch (e) { return fail(req, reply, e) }
    }
    fastify.post('/ask', (req, reply) => ask(req as any, reply, false))
    fastify.post('/ask/approve', (req, reply) => ask(req as any, reply, true))
  }
}

export const operatorRoutes: FastifyPluginAsync = makeOperatorRoutes()
