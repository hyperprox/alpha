// =============================================================================
//  HyperProx — Secrets (Settings → Secrets)
//  Names only by default. Reveal needs owner/admin and a fresh re-confirmation
//  (enforced by the gate). Send creates an expiring, view-limited Bitwarden
//  Send. Generate creates a password and stores it in the vault without
//  showing it.
// =============================================================================

import type { FastifyPluginAsync } from 'fastify'
import { randomInt } from 'crypto'
import { getBroker, type SecretItem } from '../lib/vault/broker'
import { cachedSecret, cachedSecrets, putCachedSecret } from '../lib/vault/state'
import { ITEM_PREFIX } from '../lib/credentials'

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!@#%^*+='

export function generatePassword(length = 24): string {
  let out = ''
  for (let i = 0; i < length; i++) out += CHARSET[randomInt(CHARSET.length)]
  return out
}

function updatedAtOf(item: SecretItem): string | null {
  if (item.revisionDate) return item.revisionDate
  const line = item.notes?.split('\n').find(l => l.startsWith('hyperprox-meta:'))
  if (line) {
    try {
      const dates = Object.values(JSON.parse(line.slice('hyperprox-meta:'.length)).updatedAt ?? {}) as string[]
      if (dates.length) return dates.sort().at(-1)!
    } catch { /* ignore */ }
  }
  return null
}

export const secretsRoutes: FastifyPluginAsync = async (fastify) => {

  async function find(sid: string, name: string): Promise<SecretItem | undefined> {
    return cachedSecret(name) ?? (await getBroker().listSecrets(sid)).find(i => i.name === name)
  }

  // GET /api/secrets — names, field names, last change. Never values.
  // From the unlock cache (a vault round-trip takes seconds); ?refresh=1 asks the vault.
  fastify.get<{ Querystring: { refresh?: string } }>('/', async (req, reply) => {
    const s = req.session!
    try {
      const items = req.query?.refresh ? await getBroker().listSecrets(s.sid) : cachedSecrets()
      if (req.query?.refresh) for (const i of items) putCachedSecret(i)
      return {
        ok: true,
        data: items
          .map(i => ({
            name:      i.name,
            managed:   i.name.startsWith(ITEM_PREFIX),
            fields:    Object.keys(i.fields),
            updatedAt: updatedAtOf(i),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }
    } catch (e: any) {
      return reply.status(502).send({ ok: false, error: e?.message ?? 'Vault request failed' })
    }
  })

  // POST /api/secrets/reveal { name } — owner/admin, re-confirmed (gate)
  fastify.post<{ Body: { name?: string } }>('/reveal', async (req, reply) => {
    const name = typeof req.body?.name === 'string' ? req.body.name : ''
    if (!name) return reply.status(400).send({ ok: false, error: 'name is required' })
    const item = await find(req.session!.sid, name)
    if (!item) return reply.status(404).send({ ok: false, error: 'No such secret' })
    req.log.info({ name, by: req.session!.email }, '[secrets] revealed')
    return { ok: true, data: { name: item.name, fields: item.fields } }
  })

  // POST /api/secrets/send { name, field?, hours?, maxViews?, password? } — owner/admin
  fastify.post<{ Body: { name?: string; field?: string; hours?: number; maxViews?: number; password?: string } }>(
    '/send', async (req, reply) => {
      const b = req.body ?? {}
      const name = typeof b.name === 'string' ? b.name : ''
      if (!name) return reply.status(400).send({ ok: false, error: 'name is required' })
      const item = await find(req.session!.sid, name)
      if (!item) return reply.status(404).send({ ok: false, error: 'No such secret' })

      const keys = Object.keys(item.fields)
      let text: string
      if (b.field) {
        if (!(b.field in item.fields)) return reply.status(400).send({ ok: false, error: `No field "${b.field}" in ${name}` })
        text = item.fields[b.field]
      } else if (keys.length === 1) {
        text = item.fields[keys[0]]
      } else {
        return reply.status(400).send({ ok: false, error: 'This secret has several fields — choose one', fields: keys })
      }

      const hours    = Math.min(Math.max(Number(b.hours) || 24, 1), 24 * 30)
      const maxViews = Math.min(Math.max(Number(b.maxViews) || 1, 1), 100)
      const password = typeof b.password === 'string' && b.password ? b.password : undefined
      try {
        const sent = await getBroker().createSend(req.session!.sid, text, { hours, maxViews, password })
        req.log.info({ name, field: b.field, by: req.session!.email, hours, maxViews }, '[secrets] sent')
        return { ok: true, data: sent }
      } catch (e: any) {
        return reply.status(502).send({ ok: false, error: e?.message ?? 'Could not create the Send' })
      }
    })

  // POST /api/secrets/generate { name, purpose, length? } — owner/admin. The value is never returned.
  fastify.post<{ Body: { name?: string; purpose?: string; length?: number } }>('/generate', async (req, reply) => {
    const b = req.body ?? {}
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    const purpose = typeof b.purpose === 'string' ? b.purpose.trim() : ''
    if (!name || !purpose) return reply.status(400).send({ ok: false, error: 'name and purpose are required' })
    if (name.startsWith(ITEM_PREFIX)) {
      return reply.status(400).send({ ok: false, error: `Names starting with "${ITEM_PREFIX}" are reserved for HyperProx settings` })
    }
    const length = b.length === undefined ? 24 : Number(b.length)
    if (!Number.isInteger(length) || length < 16 || length > 128) {
      return reply.status(400).send({ ok: false, error: 'length must be a whole number from 16 to 128' })
    }
    if (await find(req.session!.sid, name)) return reply.status(409).send({ ok: false, error: 'A secret with that name already exists' })

    const notes = `${purpose}\nGenerated by HyperProx ${new Date().toISOString()} for ${req.session!.email}`
    try {
      const saved = await getBroker().upsertSecret(req.session!.sid, name, { password: generatePassword(length) }, notes)
      putCachedSecret(saved)
      return { ok: true, data: { name: saved.name, fields: Object.keys(saved.fields) } }
    } catch (e: any) {
      return reply.status(502).send({ ok: false, error: e?.message ?? 'Could not save to the vault' })
    }
  })
}
