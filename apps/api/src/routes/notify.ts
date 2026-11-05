// =============================================================================
//  HyperProx — Settings → Notifications API
//  /api/settings/notifications/*: admin only (lib/roles.ts makes every
//  /api/settings route admin, reads included). Turning "usable while locked"
//  on or off is owner only: it moves a secret out of or into the vault.
//  Responses carry masks and result codes, never a URL, token or body.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { currentContext, isReconfirmed } from '../lib/auth'
import { getNotifyService } from '../lib/notify'
import {
  NotifyForbiddenError, NotifyInputError, NotifyNotFoundError, NotifyUnavailableError, publicUrlFrom,
  type Actor, type ChannelInput, type NotifyService,
} from '../lib/notify/service'
import { CHANNEL_KINDS, FAMILIES, LOCKED_OK, SELF_HOSTABLE } from '../lib/notify/types'

const INPUT_KEYS: Array<keyof ChannelInput> = [
  'name', 'kind', 'enabled', 'minSeverity', 'eventFilter', 'quietHours', 'lanOverride', 'usableWhileLocked', 'private', 'chatId',
  'url', 'token', 'botToken', 'signingSecret', 'clearToken', 'clearSigningSecret',
]

function pick(body: unknown): ChannelInput {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of INPUT_KEYS) if (k in b) out[k] = b[k]
  return out as ChannelInput
}

function fail(reply: FastifyReply, e: unknown) {
  if (e instanceof NotifyInputError) return reply.status(400).send({ ok: false, error: e.message })
  if (e instanceof NotifyForbiddenError) return reply.status(403).send({ ok: false, error: e.message })
  if (e instanceof NotifyNotFoundError) return reply.status(404).send({ ok: false, error: e.message })
  if (e instanceof NotifyUnavailableError) return reply.status(409).send({ ok: false, error: e.message })
  if ((e as Error)?.name === 'VaultLockedError') return reply.status(409).send({ ok: false, error: 'The vault cannot be written right now; sign in again and retry.' })
  // Anything else could carry an address or a token in its message: say nothing specific.
  reply.log?.warn?.(`[notify] request failed: ${(e as any)?.code ?? (e as Error)?.name ?? 'error'}`)
  return reply.status(500).send({ ok: false, error: 'Could not complete that; nothing was sent.' })
}

export function buildNotifyRoutes(deps: { service?: NotifyService } = {}): FastifyPluginAsync {
  return async (fastify) => {
    const svc = (): NotifyService => {
      const s = deps.service ?? getNotifyService()
      if (!s) throw new NotifyUnavailableError('Notifications are not running.')
      return s
    }
    const actor = (): Actor => {
      const c = currentContext()
      if (!c) throw new NotifyForbiddenError('Sign in first.')
      return { email: c.email, role: c.role }
    }

    fastify.get('/channels', async (_req, reply) => {
      try {
        return {
          ok: true,
          channels: await svc().listChannels(),
          meta: {
            kinds: CHANNEL_KINDS, families: FAMILIES, selfHostable: SELF_HOSTABLE, lockedOk: LOCKED_OK,
            canSetUsableWhileLocked: actor().role === 'owner', publicUrlSet: !!publicUrlFrom(process.env),
          },
        }
      } catch (e) { return fail(reply, e) }
    })

    /**
     * Marking a channel private lets sign-in links reach it, so it needs the master password again (an API
     * token can never do it). Other edits do not.
     */
    const privateNeedsReconfirm = async (body: unknown, id: string | null): Promise<boolean> => {
      if ((body as any)?.private !== true) return false
      if (id) { const cur = (await svc().listChannels()).find(c => c.id === id); if (cur?.private) return false }
      const c = currentContext()
      return !c || !isReconfirmed(c.sid)
    }
    const RECONFIRM = { ok: false, code: 'reconfirm_required', error: 'Re-enter your master password to mark a channel private' }

    fastify.post('/channels', async (req, reply) => {
      if (await privateNeedsReconfirm(req.body, null)) return reply.status(403).send(RECONFIRM)
      try { return reply.status(201).send({ ok: true, channel: await svc().createChannel(pick(req.body), actor()) }) }
      catch (e) { return fail(reply, e) }
    })

    fastify.put<{ Params: { id: string } }>('/channels/:id', async (req, reply) => {
      try { if (await privateNeedsReconfirm(req.body, req.params.id)) return reply.status(403).send(RECONFIRM) } catch (e) { return fail(reply, e) }
      try { return { ok: true, channel: await svc().updateChannel(req.params.id, pick(req.body), actor()) } }
      catch (e) { return fail(reply, e) }
    })

    fastify.delete<{ Params: { id: string } }>('/channels/:id', async (req, reply) => {
      try { await svc().deleteChannel(req.params.id, actor()); return { ok: true } }
      catch (e) { return fail(reply, e) }
    })

    fastify.post<{ Params: { id: string } }>('/channels/:id/test', async (req, reply) => {
      try { return { ok: true, result: await svc().testChannel(req.params.id, actor()) } }
      catch (e) { return fail(reply, e) }
    })

    fastify.get<{ Querystring: { channelId?: string; limit?: string } }>('/deliveries', async (req, reply) => {
      try { return { ok: true, deliveries: await svc().deliveries(req.query.channelId || undefined, Number(req.query.limit) || 50) } }
      catch (e) { return fail(reply, e) }
    })
  }
}

export const notifyRoutes = buildNotifyRoutes()
