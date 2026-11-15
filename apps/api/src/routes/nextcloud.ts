// =============================================================================
//  HyperProx — Nextcloud routes (/api/plugins/nextcloud)
//
//  Roles (lib/roles.ts): the reading is viewer, trimmed below admin (no log
//  text, no user names, no paths or container names). Everything else is
//  admin: the guest list and detection (they map containers), the 2FA user
//  list, the update check, snoozes, every action. Adding, changing or removing
//  an instance stores a login, and the secure actions (lib/nextcloud/checks.ts
//  ACTIONS: the update, the HPB update, long database work, 2FA, mail) are on
//  /secure-actions/, which the gate re-confirms (master password); that also
//  keeps API tokens out, and the service refuses a token by name on every
//  action anyway. No route takes a command, a path or a container name.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { auditCredentialUse } from '../lib/audit'
import { hasRole } from '../lib/roles'
import { nextcloudService } from '../lib/nextcloud'
import { NcRefusal, type Actor, type Reading } from '../lib/nextcloud/types'
import { OccRefusal } from '../lib/nextcloud/occ'
import { UpdateRefusal } from '../lib/nextcloud/update'

function actor(req: FastifyRequest): Actor {
  const s = req.session!
  return { sid: s.sid, email: s.email, role: s.role, token: req.apiToken?.name ?? null }
}

const isAdmin = (req: FastifyRequest) => hasRole(req.session?.role ?? 'viewer', 'admin')

function fail(reply: FastifyReply, e: any) {
  if (e instanceof NcRefusal) return reply.status(e.status).send({ success: false, code: e.code, error: e.message, ...e.extra })
  if (e instanceof OccRefusal || e instanceof UpdateRefusal) return reply.status(400).send({ success: false, code: 'refused', error: e.message })
  if (e?.name === 'TransportError') return reply.status(502).send({ success: false, code: 'unreachable', error: e.message })
  throw e
}

/** Paths, container names and image names out of a text a viewer reads. */
export function redactFor(text: string, r: Reading): string {
  const d = r.deployment
  const known = [d?.app?.container, d?.app?.image, d?.app?.workdir, d?.app?.configFile, d?.db?.container, d?.db?.image, d?.signaling?.container, d?.signaling?.image, d?.notifyPush?.container, d?.bareDir]
    .filter((x): x is string => !!x && x.length > 2).sort((a, b) => b.length - a.length)
  let out = text
  for (const k of known) out = out.split(k).join('[hidden]')
  return out.replace(/(?:\/[A-Za-z0-9._@+-]+){2,}\/?/g, '[path]')
}

/** Below admin: the health, without log text, user names, paths, container or image names, or the confirm texts. */
export function viewerReading(r: Reading): Partial<Reading> {
  return {
    fetchedAt: r.fetchedAt, status: r.status, update: r.update, checksFrom: r.checksFrom, counts: r.counts, background: r.background,
    checks: r.checks.map(c => ({
      ...c, description: redactFor(c.description, r),
      remedy: c.remedy.kind === 'fix' ? { ...c.remedy, params: undefined, confirm: '', note: c.remedy.note ? redactFor(c.remedy.note, r) : undefined }
        : c.remedy.kind === 'guided' ? { ...c.remedy, why: redactFor(c.remedy.why, r) } : c.remedy,
    })),
    users: r.users, apps: r.apps, php: r.php, dbVersion: r.dbVersion, missing: r.missing, suggest: r.suggest, config: { ...r.config, mail: { ...r.config.mail, host: null, from: null } },
    talk: { ...r.talk, hpb: r.talk.hpb ? { ...r.talk.hpb, container: null, image: null } : null, push: { ...r.talk.push, endpoint: r.talk.push.endpoint ? '[set]' : null } },
    server: r.server ? { ...r.server, activeUsers: r.server.activeUsers } : null,
    twoFactor: { ...r.twoFactor, without: null },
    log: null, deployment: r.deployment ? ({ kind: r.deployment.kind } as any) : null,
  }
}

type P = { Params: { iid: string } }

export const nextcloudRoutes: FastifyPluginAsync = async (fastify) => {
  const svc = () => nextcloudService((fastify as any).prisma)
  // Created now (not at the first request), so a detached update from before a restart is watched again at once.
  if ((fastify as any).prisma) svc()

  // Refusals the gate makes (role, re-confirmation, token) never reach a handler: record those too.
  fastify.addHook('onResponse', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || reply.statusCode < 400 || !req.session || reply.statusCode === 401 || reply.statusCode === 423) return
    const m = /\/instances\/([^/]+)\/(actions|secure-actions)\/([a-z0-9-]{1,40})$/.exec(req.url.split('?')[0])
    if (!m) return
    await auditCredentialUse('nextcloud.action.refused', `nextcloud:${m[1].replace(/[^a-z0-9]/gi, '').slice(0, 20)}`, {
      by: req.session.email, via: req.apiToken ? `api:${req.apiToken.name}` : 'session', action: m[3], result: `refused:http_${reply.statusCode}`,
    }).catch(() => {})
  })

  fastify.get('/instances', async (req, reply) => {
    try {
      const views = await svc().instances.views()
      return { success: true, data: isAdmin(req) ? views : views.map(v => ({ id: v.id, name: v.name, addedAt: v.addedAt, hasAppPassword: v.hasAppPassword })) }
    } catch (e) { return fail(reply, e) }
  })

  // The guests a Nextcloud could be in, for the add form (admin: it maps guests).
  fastify.get('/candidates', async (_req, reply) => {
    try { return { success: true, data: await svc().candidates() } } catch (e) { return fail(reply, e) }
  })

  // Read-only detection in one guest (admin, POST because it runs a script there; not re-confirmed: it changes nothing).
  fastify.post<{ Body: { guest?: unknown } }>('/detect', async (req, reply) => {
    try { return { success: true, data: await svc().detect(req.body?.guest, actor(req)) } } catch (e) { return fail(reply, e) }
  })

  fastify.post<{ Body: Record<string, unknown> }>('/instances', async (req, reply) => {
    try { return reply.status(201).send({ success: true, data: await svc().add(req.body ?? {}, actor(req)) }) } catch (e) { return fail(reply, e) }
  })

  fastify.put<P & { Body: Record<string, unknown> }>('/instances/:iid', async (req, reply) => {
    try { return { success: true, data: await svc().update(req.params.iid, req.body ?? {}, actor(req)) } } catch (e) { return fail(reply, e) }
  })

  fastify.delete<P>('/instances/:iid', async (req, reply) => {
    try { await svc().remove(req.params.iid, actor(req)); return { success: true } } catch (e) { return fail(reply, e) }
  })

  // The whole reading. One that cannot be read is a normal state: 200 with ok:false and the reason.
  fastify.get<P & { Querystring: { fresh?: string } }>('/instances/:iid/reading', async (req, reply) => {
    try {
      // A fresh read (it runs occ in the guest again) is an admin's, and throttled by the service.
      const r = await svc().reading(req.params.iid, { fresh: req.query.fresh === '1' && isAdmin(req) })
      return { success: true, data: { ok: true, reading: isAdmin(req) ? r : viewerReading(r), job: isAdmin(req) ? await svc().latestJob(req.params.iid) : null } }
    } catch (e: any) {
      if (e instanceof NcRefusal && e.status === 404 && e.code === 'no_instance') return fail(reply, e)
      return { success: true, data: { ok: false, code: e?.code ?? null, error: e instanceof NcRefusal || e?.name === 'TransportError' ? e.message : 'Nextcloud could not be read.' } }
    }
  })

  fastify.get<P>('/instances/:iid/two-factor', async (req, reply) => {
    try { return { success: true, data: await svc().twoFactorUsers(req.params.iid, actor(req)) } } catch (e) { return fail(reply, e) }
  })

  fastify.post<P>('/instances/:iid/update/preview', async (req, reply) => {
    try { return { success: true, data: await svc().updatePreview(req.params.iid, actor(req)) } } catch (e) { return fail(reply, e) }
  })

  fastify.post<P & { Body: { check?: unknown; days?: unknown } }>('/instances/:iid/snooze', async (req, reply) => {
    try { return { success: true, data: await svc().snooze(req.params.iid, req.body?.check, req.body?.days, actor(req)) } } catch (e) { return fail(reply, e) }
  })

  fastify.post<P & { Params: { action: string }; Body: Record<string, unknown> }>('/instances/:iid/actions/:action', async (req, reply) => {
    try { return { success: true, data: await svc().act(req.params.iid, req.params.action, req.body ?? {}, actor(req), false) } } catch (e) { return fail(reply, e) }
  })

  fastify.post<P & { Params: { action: string }; Body: Record<string, unknown> }>('/instances/:iid/secure-actions/:action', async (req, reply) => {
    try { return { success: true, data: await svc().act(req.params.iid, req.params.action, req.body ?? {}, actor(req), true) } } catch (e) { return fail(reply, e) }
  })

  fastify.get<P & { Params: { jobId: string } }>('/instances/:iid/jobs/:jobId', async (req, reply) => {
    try { return { success: true, data: await svc().job(req.params.iid, req.params.jobId) } } catch (e) { return fail(reply, e) }
  })
}
