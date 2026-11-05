// =============================================================================
//  HyperProx — guest config editor routes (/api/infra/guest-config)
//
//  Reads follow the usual roles (any GET is viewer; device paths and IDs are
//  shown to admins only). Every write is preview then apply: preview is admin,
//  apply is admin with the master password re-entered (lib/roles.ts), and apply
//  takes only a preview id this user made.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import type { PrismaClient } from '@prisma/client'
import { currentContext } from '../lib/auth'
import { ownerOf } from './ai'
import { hasRole } from '../lib/roles'
import { GuestConfigService, GuestConfigRefusal, type GuestId, type PreviewInput, type Preview } from '../lib/guest-config/service'
import { redactForViewer } from '../lib/guest-config/devices'
import { livePveAdapter, liveNodeShell, prismaAudit } from '../lib/guest-config/pve-adapter'
import { PrismaHistoryStore } from '../lib/guest-config/history/store'
import { GpuMoveWatcher } from '../lib/guest-config/gpu-watch'
import { publish } from '../lib/notify'
import { isUnlocked } from '../lib/vault/state'

let shared: GuestConfigService | null = null
export function guestConfigService(db: PrismaClient): GuestConfigService {
  shared ??= new GuestConfigService({ pve: livePveAdapter(), shell: liveNodeShell(prismaAudit(db)), history: new PrismaHistoryStore(db), audit: prismaAudit(db) })
  return shared
}

export interface GuestConfigRouteDeps {
  service: GuestConfigService
  whoami(): string
  isAdmin(): boolean
}

const STATUS: Record<GuestConfigRefusal['code'], number> = { 'not-found': 404, expired: 410, used: 409, changed: 409, 'not-quorate': 503, refused: 422, confirm: 428, forbidden: 401 }

function fail(reply: FastifyReply, e: unknown) {
  // The Proxmox token and node logins come from the vault; while it is locked nothing here can run.
  if (/HyperProx is locked|VaultLocked/i.test(String((e as Error)?.message ?? '')) || (e as Error)?.name === 'VaultLockedError')
    return reply.status(423).send({ success: false, locked: true, error: 'HyperProx is locked — sign in to read or edit guest configs.' })
  if (e instanceof GuestConfigRefusal) return reply.status(STATUS[e.code]).send({ success: false, code: e.code, error: e.message, problems: e.problems })
  return reply.status(500).send({ success: false, error: (e as Error)?.message ?? String(e) })
}

function guestOf(p: { node: string; type: string; vmid: string }): GuestId {
  if (p.type !== 'lxc' && p.type !== 'qemu') throw new GuestConfigRefusal('No such guest type.', 'not-found')
  return { node: p.node, type: p.type, vmid: Number(p.vmid) }
}

/** What the browser sees of a preview: the plan in words, never the stored config. */
export function previewView(p: Preview) {
  return {
    previewId: p.id, kind: p.kind, guest: p.guest, expiresAt: p.expiresAt, quorate: p.quorate,
    changes: p.plan.changes, warnings: p.plan.warnings, errors: p.plan.errors, checks: p.plan.checks,
    restartNeeded: p.plan.changes.some(c => c.restart !== 'live'), pendingBefore: p.pendingBefore,
    counts: p.counts, extraConfirm: p.plan.extraConfirm, confirmName: p.plan.confirmName,
    deviceChecks: p.plan.deviceChecks, canApply: p.plan.errors.length === 0,
  }
}

export function buildGuestConfigRoutes(deps: () => GuestConfigRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    type G = { Params: { node: string; type: string; vmid: string } }

    fastify.get('/overview', async (_req, reply) => {
      try { return { success: true, data: await deps().service.overview() } } catch (e) { return fail(reply, e) }
    })

    fastify.get<{ Params: { node: string }; Querystring: { refresh?: string } }>('/nodes/:node/devices', async (req, reply) => {
      try {
        const d = deps()
        const inv = await d.service.inventory(req.params.node, req.query.refresh === '1')
        return { success: true, data: d.isAdmin() ? inv : redactForViewer(inv), redacted: !d.isAdmin() }
      } catch (e) { return fail(reply, e) }
    })

    fastify.get<G>('/guests/:node/:type/:vmid', async (req, reply) => {
      try { return { success: true, data: await deps().service.view(guestOf(req.params)) } } catch (e) { return fail(reply, e) }
    })

    fastify.get<G>('/guests/:node/:type/:vmid/gpu', async (req, reply) => {
      try {
        const d = deps()
        const data = await d.service.gpuDetail(guestOf(req.params))
        return { success: true, data: d.isAdmin() ? data : { ...data, devices: redactForViewer({ node: req.params.node, devices: data.devices, majors: {}, nvidiaNodes: [], collectedAt: 0 }).devices } }
      } catch (e) { return fail(reply, e) }
    })

    fastify.get<G>('/guests/:node/:type/:vmid/history', async (req, reply) => {
      try {
        const g = guestOf(req.params)
        const rows = await deps().service.historyOf(g)
        return { success: true, data: rows.map(r => ({ id: r.id, kind: r.kind, tag: r.tag, actor: r.actor, outcome: r.outcome, createdAt: r.createdAt, changes: r.changes, problems: r.problems })) }
      } catch (e) { return fail(reply, e) }
    })

    // Shows one secret value (a cloud-init password, say). Needs the master password re-entered (lib/roles.ts).
    fastify.post<G & { Body: { key?: string } }>('/guests/:node/:type/:vmid/reveal', async (req, reply) => {
      try {
        const d = deps()
        const value = await d.service.reveal(d.whoami(), guestOf(req.params), String(req.body?.key ?? ''))
        return { success: true, data: { key: req.body?.key, value } }
      } catch (e) { return fail(reply, e) }
    })

    fastify.post<{ Body: { path?: string } }>('/paths/check', async (req, reply) => {
      try { return { success: true, data: await deps().service.checkPath(String(req.body?.path ?? '')) } } catch (e) { return fail(reply, e) }
    })

    fastify.post<{ Body: { node?: string; type?: string; vmid?: number | string; change?: PreviewInput } }>('/preview', async (req, reply) => {
      try {
        const d = deps()
        const owner = d.whoami()
        if (!owner) return reply.status(401).send({ success: false, error: 'Sign in first.' })
        const b = req.body ?? {}
        const g = guestOf({ node: String(b.node ?? ''), type: String(b.type ?? ''), vmid: String(b.vmid ?? '') })
        if (!b.change || typeof b.change !== 'object') return reply.status(400).send({ success: false, error: 'No change given.' })
        const p = await d.service.preview(owner, g, b.change)
        return { success: true, data: previewView(p) }
      } catch (e) { return fail(reply, e) }
    })

    fastify.post<{ Body: { previewId?: string; confirmName?: string; acks?: string[] } }>('/apply', async (req, reply) => {
      try {
        const d = deps()
        const owner = d.whoami()
        if (!owner) return reply.status(401).send({ success: false, error: 'Sign in first.' })
        const b = req.body ?? {}
        const r = await d.service.apply(owner, String(b.previewId ?? ''), { name: b.confirmName, acks: Array.isArray(b.acks) ? b.acks.map(String) : [] })
        return reply.status(r.ok ? 200 : 502).send({ success: r.ok, data: r, error: r.ok ? undefined : 'The change did not land as previewed. See the outcome.' })
      } catch (e) { return fail(reply, e) }
    })
  }
}

export const guestConfigRoutes: FastifyPluginAsync = async (fastify) => {
  const service = guestConfigService(fastify.prisma)
  // After an HA move, check that a GPU guest still sees a GPU and say so. Checks only, every minute, and only
  // while unlocked: the node logins it reads with come from the vault.
  const watcher = new GpuMoveWatcher(service, async e => publish({
    type: e.type, severity: e.severity, title: e.title, where: 'Infrastructure page', link: '/infrastructure',
    subject: { kind: 'guest', name: e.guest.name }, fingerprint: `${e.type}:${e.guest.vmid}:${e.guest.to}`,
  }))
  const timer = setInterval(() => { if (isUnlocked()) watcher.tick().catch(err => fastify.log.warn({ err: err?.message }, '[guest-config] GPU move check failed')) }, 60_000)
  timer.unref()
  fastify.addHook('onClose', async () => clearInterval(timer))
  await fastify.register(buildGuestConfigRoutes(() => ({
    service,
    whoami: () => ownerOf(currentContext()),
    isAdmin: () => { const c = currentContext(); return !!c && hasRole(c.role, 'admin') },
  })))
}
