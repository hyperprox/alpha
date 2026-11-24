// =============================================================================
//  HyperProx — the AI handbook routes (/api/ai/handbook)
//
//  The handbook is what the operator reads before it answers: playbooks (written-down fixes) and house rules.
//
//  Roles (lib/roles.ts: a GET is viewer, anything else admin):
//    GET    /playbooks            viewer: every playbook (?approved=true|false narrows it)
//    GET    /playbooks/:id        viewer: one playbook
//    GET    /playbooks/:id/export viewer: it as markdown (the importer's own format)
//    POST   /playbooks            admin: add one (approved only if the request says so)
//    POST   /playbooks/import     admin: add one from pasted markdown
//    PUT    /playbooks/:id        admin: change one (editing keeps its source and approval)
//    POST   /playbooks/:id/approve admin: approve or un-approve (only approved playbooks reach the operator)
//    DELETE /playbooks/:id        admin, confirmed
//    GET    /rules                viewer: the house rules
//    PUT    /rules                admin: replace them
//    GET    /match?q=             viewer: which approved playbooks a question would use, and why
//  Every write is audited by title and id, never by body. API tokens cannot write (lib/api-tokens.ts).
// =============================================================================

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { sendFailure, sendRefusal } from '../lib/failure'
import { requireConfirm } from '../lib/confirm'
import { auditOrThrow } from '../lib/audit'
import { auditBy, contextActor } from '../lib/http/request-actor'
import { normalizePlaybook, normalizeRules, parsePlaybookMarkdown, playbookToMarkdown, type Playbook } from '../lib/ai/operator/playbook'
import type { PlaybookStore } from '../lib/ai/operator/playbook-store'
import { rankPlaybooks } from '../lib/ai/operator/retrieve'

const view = (p: Playbook) => ({ ...p, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString() })

export function makeHandbookRoutes(deps: { store: () => PlaybookStore | null; audit?: typeof auditOrThrow }): FastifyPluginAsync {
  const audit = deps.audit ?? auditOrThrow
  const who = () => String(auditBy(contextActor()).by ?? '')
  const need = (reply: FastifyReply): PlaybookStore | null => {
    const s = deps.store()
    if (!s) { sendRefusal(reply, 503, 'not_ready', 'The handbook is not available yet. Try again in a minute.'); return null }
    return s
  }
  const fail = (req: FastifyRequest, reply: FastifyReply, e: unknown) =>
    sendFailure(req, reply, e, 'The handbook could not do that. The details are in the log.', { status: 502 })
  const missing = (reply: FastifyReply) => sendRefusal(reply, 404, 'not_found', 'There is no such playbook.')

  return async fastify => {
    fastify.get<{ Querystring: { approved?: string } }>('/playbooks', async (req, reply) => {
      const s = need(reply); if (!s) return
      try {
        const a = req.query?.approved
        const list = await s.list(a === 'true' ? { approved: true } : a === 'false' ? { approved: false } : {})
        return reply.send({ ok: true, playbooks: list.map(view) })
      } catch (e) { return fail(req, reply, e) }
    })

    fastify.get<{ Params: { id: string } }>('/playbooks/:id', async (req, reply) => {
      const s = need(reply); if (!s) return
      try { const p = await s.get(req.params.id); return p ? reply.send({ ok: true, playbook: view(p) }) : missing(reply) } catch (e) { return fail(req, reply, e) }
    })

    fastify.get<{ Params: { id: string } }>('/playbooks/:id/export', async (req, reply) => {
      const s = need(reply); if (!s) return
      try { const p = await s.get(req.params.id); return p ? reply.send({ ok: true, markdown: playbookToMarkdown(p), key: p.key }) : missing(reply) } catch (e) { return fail(req, reply, e) }
    })

    fastify.post<{ Body: Record<string, unknown> }>('/playbooks', async (req, reply) => {
      const s = need(reply); if (!s) return
      const n = normalizePlaybook({ ...(req.body ?? {}), source: 'user', key: undefined })
      if (!n.ok) return sendRefusal(reply, 400, 'invalid', n.error)
      try {
        const p = await s.create(n.value)
        await audit('ai.playbook.create', 'ai:playbook', { by: who(), id: p.id, title: p.title, approved: p.approved })
        return reply.code(201).send({ ok: true, playbook: view(p) })
      } catch (e) { return fail(req, reply, e) }
    })

    fastify.post<{ Body: { markdown?: unknown } }>('/playbooks/import', async (req, reply) => {
      const s = need(reply); if (!s) return
      const md = req.body?.markdown
      if (typeof md !== 'string' || !md.trim() || md.length > 60_000) return sendRefusal(reply, 400, 'invalid', 'Paste one playbook as markdown (up to 60,000 characters).')
      const parsed = parsePlaybookMarkdown(md)
      if (!parsed.ok) return sendRefusal(reply, 400, 'invalid', parsed.error)
      try {
        // A pasted playbook is a person's, and waits for approval like any other new one.
        const p = await s.create({ ...parsed.value, source: 'user', approved: false })
        await audit('ai.playbook.import', 'ai:playbook', { by: who(), id: p.id, title: p.title })
        return reply.code(201).send({ ok: true, playbook: view(p) })
      } catch (e) { return fail(req, reply, e) }
    })

    fastify.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/playbooks/:id', async (req, reply) => {
      const s = need(reply); if (!s) return
      try {
        const have = await s.get(req.params.id)
        if (!have) return missing(reply)
        // Editing keeps the source and the approval it had: only the approve route changes that.
        const n = normalizePlaybook({ ...have, ...(req.body ?? {}), key: have.key, source: have.source, approved: have.approved })
        if (!n.ok) return sendRefusal(reply, 400, 'invalid', n.error)
        const { key: _k, source: _s, approved: _a, ...patch } = n.value
        const p = await s.update(have.id, patch)
        if (!p) return missing(reply)
        await audit('ai.playbook.update', 'ai:playbook', { by: who(), id: p.id, title: p.title })
        return reply.send({ ok: true, playbook: view(p) })
      } catch (e) { return fail(req, reply, e) }
    })

    fastify.post<{ Params: { id: string }; Body: { approved?: unknown } }>('/playbooks/:id/approve', async (req, reply) => {
      const s = need(reply); if (!s) return
      if (typeof req.body?.approved !== 'boolean') return sendRefusal(reply, 400, 'invalid', 'Say whether to approve or withdraw approval.')
      try {
        const p = await s.update(req.params.id, { approved: req.body.approved })
        if (!p) return missing(reply)
        await audit(req.body.approved ? 'ai.playbook.approve' : 'ai.playbook.unapprove', 'ai:playbook', { by: who(), id: p.id, title: p.title })
        return reply.send({ ok: true, playbook: view(p) })
      } catch (e) { return fail(req, reply, e) }
    })

    fastify.delete<{ Params: { id: string } }>('/playbooks/:id', async (req, reply) => {
      const s = need(reply); if (!s) return
      try {
        const p = await s.get(req.params.id)
        if (!p) return missing(reply)
        if (!(await requireConfirm(req, reply, `This will delete the playbook "${p.title}". It cannot be undone.`))) return
        await s.remove(p.id)
        await audit('ai.playbook.delete', 'ai:playbook', { by: who(), id: p.id, title: p.title })
        return reply.send({ ok: true })
      } catch (e) { return fail(req, reply, e) }
    })

    fastify.get('/rules', async (req, reply) => {
      const s = need(reply); if (!s) return
      try { const r = await s.getRules(); return reply.send({ ok: true, rules: { ...r, updatedAt: r.updatedAt?.toISOString() ?? null } }) } catch (e) { return fail(req, reply, e) }
    })

    fastify.put<{ Body: Record<string, unknown> }>('/rules', async (req, reply) => {
      const s = need(reply); if (!s) return
      const b = req.body ?? {}
      if (typeof b.text !== 'string' || !Array.isArray(b.rules)) return sendRefusal(reply, 400, 'invalid', 'Send the house rules as text and a list of rules.')
      try {
        const n = normalizeRules(b)
        const r = await s.saveRules(n, who())
        await audit('ai.houserules.update', 'ai:houserules', { by: who(), rules: r.rules.length, chars: r.text.length })
        return reply.send({ ok: true, rules: { ...r, updatedAt: r.updatedAt?.toISOString() ?? null } })
      } catch (e) { return fail(req, reply, e) }
    })

    fastify.get<{ Querystring: { q?: string } }>('/match', async (req, reply) => {
      const s = need(reply); if (!s) return
      const q = String(req.query?.q ?? '').slice(0, 2000)
      if (!q.trim()) return sendRefusal(reply, 400, 'invalid', 'Type a question to test.')
      try {
        const ranked = rankPlaybooks(q, await s.list({ approved: true })).slice(0, 5)
        return reply.send({ ok: true, matches: ranked.map(r => ({ id: r.playbook.id, title: r.playbook.title, score: r.score, words: r.why })) })
      } catch (e) { return fail(req, reply, e) }
    })
  }
}

export const handbookRoutes = (store: () => PlaybookStore | null): FastifyPluginAsync => makeHandbookRoutes({ store })
