// =============================================================================
//  HyperProx — placement advisor routes (/api/placement)
//
//  Reads are for anyone signed in, as the guest list is: the map, the advice,
//  one guest, the history, the settings. The move check is admin. A move (now
//  or scheduled) is admin with the master password re-entered, which also keeps
//  API tokens out (lib/roles.ts PLACEMENT_*). Checking bind-mount paths and
//  reading corosync's log use node logins, so they are admin and audited.
//  Home cluster only: a remote cluster's page gets a plain refusal.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { allSessions, currentContext } from '../lib/auth'
import { getBroker } from '../lib/vault/broker'
import { publish } from '../lib/notify'
import { VaultLockedError } from '../lib/credentials'
import { currentRemote } from '../lib/clusters/context'
import { sidOf } from '../lib/ha/parse'
import { nodeAddress } from '../lib/ha'
import { redactText } from '../lib/ha/redact'
import { livePve } from '../lib/pve-env'
import { auditOrThrow } from '../lib/audit'
import { isUnlocked } from '../lib/vault/state'
import { execOnNode, nodeCredential } from '../lib/node-exec'
import { prometheusBase } from '../lib/service-health'
import { PlacementRefusal, PlacementService } from '../lib/placement/service'
import { livePromRange } from '../lib/placement/read'
import { prismaPlacementStore } from '../lib/placement/store'
import type { HaPve } from '../lib/ha/read'

const actor = () => ({ email: currentContext()?.email ?? 'unknown' })

async function wrap(reply: FastifyReply, fn: () => Promise<unknown>) {
  try {
    if (currentRemote()) throw new PlacementRefusal('The placement advisor works on the home cluster only for now.', 400, 'home-only')
    return { success: true, data: await fn() }
  } catch (e: any) {
    if (e instanceof PlacementRefusal) return reply.status(e.status).send({ success: false, code: e.code, error: redactText(e.message), ...e.extra })
    if (e instanceof VaultLockedError || /HyperProx is locked/.test(String(e?.message))) {
      return reply.status(423).send({ success: false, error: 'HyperProx is locked — sign in to see placement.' })
    }
    return reply.status(502).send({ success: false, error: redactText(String(e?.message ?? e)) })
  }
}

const TYPES = new Set(['lxc', 'qemu'])
const NODE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/

function guestSid(p: { type: string; vmid: string }): string {
  if (!TYPES.has(p.type) || !/^\d{1,9}$/.test(p.vmid)) throw new PlacementRefusal('Not a guest: use /lxc/<id> or /qemu/<id>.', 400, 'bad-guest')
  return sidOf(p.type as 'lxc' | 'qemu', Number(p.vmid))
}

let production: PlacementService | null = null

/** The production service: the live Proxmox token, Prometheus, Postgres, the audit log and the node logins. */
export function placementService(prisma: any): PlacementService {
  if (production) return production
  const pve = livePve()
  production = new PlacementService({
    pve: () => pve as unknown as HaPve,
    prom: livePromRange(prometheusBase()),
    store: prismaPlacementStore(prisma),
    audit: (action, resource, details) => auditOrThrow(action, resource, details),
    isUnlocked,
    // The scheduling admin's role now, from the vault's member list (read through any signed-in session).
    approverRole: async email => {
      const b: any = getBroker()
      const sid = allSessions().map(x => x.sid).find(Boolean)
      if (!sid || typeof b.members !== 'function') return 'unverifiable'
      const list: Array<{ email: string; role: string; status: string }> = await b.members(sid)
      const m = list.find(x => x.email.toLowerCase() === email.toLowerCase())
      return m && m.status === 'confirmed' ? m.role : m ? `not confirmed (${m.status})` : null
    },
    alert: async (title, lines) => {
      await publish({ type: 'placement.move.stuck', severity: 'warning', title, lines, link: '/placement', where: 'Placement page', fingerprint: `placement:${title}` }).catch(() => undefined)
    },
    nodeExec: async (node, command) => {
      const cred = await nodeCredential(node).catch(() => null)
      if (!cred) return null
      const r = await execOnNode({ host: await nodeAddress(pve as any, node), cred, command, timeoutMs: 30_000, maxOutputBytes: 2_000_000 })
      return { code: r.timedOut ? 124 : r.code, output: r.output }
    },
  })
  return production
}

export function buildPlacementRoutes(deps: { service?: () => PlacementService; startScheduler?: boolean } = {}): FastifyPluginAsync {
  return async (fastify) => {
    const svc = deps.service ?? (() => placementService((fastify as any).prisma))
    if (deps.startScheduler) {
      let stop: (() => void) | null = null
      fastify.addHook('onReady', async () => { stop = await svc().start().catch(() => null) })
      fastify.addHook('onClose', async () => { stop?.() })
    }

    fastify.get('/map', async (_q, r) => wrap(r, () => svc().map()))
    fastify.get('/advice', async (_q, r) => wrap(r, () => svc().advice()))
    fastify.get('/settings', async (_q, r) => wrap(r, () => svc().settings()))
    fastify.put<{ Body: unknown }>('/settings', async (q, r) => wrap(r, () => svc().saveSettings(q.body, actor())))
    fastify.get<{ Params: { type: string; vmid: string } }>('/guests/:type/:vmid', async (q, r) => wrap(r, () => svc().guest(guestSid(q.params))))
    fastify.post<{ Params: { type: string; vmid: string } }>('/guests/:type/:vmid/paths', async (q, r) => wrap(r, () => svc().checkPaths(guestSid(q.params), actor())))

    const moveBody = (b: any) => {
      const target = String(b?.target ?? '')
      if (!NODE.test(target)) throw new PlacementRefusal('Say which node to move it to.', 400, 'bad-target')
      const bw = b?.bwlimitKiB === undefined || b?.bwlimitKiB === null || b?.bwlimitKiB === '' ? undefined : Number(b.bwlimitKiB)
      if (bw !== undefined && (!Number.isFinite(bw) || bw < 1024 || bw > 10_000_000)) throw new PlacementRefusal('The bandwidth limit must be between 1024 and 10000000 KiB/s.', 400, 'bad-bwlimit')
      return { target, bwlimitKiB: bw }
    }
    fastify.post<{ Params: { type: string; vmid: string }; Body: any }>('/guests/:type/:vmid/check', async (q, r) => wrap(r, async () => {
      const b = moveBody(q.body)
      return svc().plan(guestSid(q.params), b.target, { bwlimitKiB: b.bwlimitKiB })
    }))
    fastify.post<{ Params: { type: string; vmid: string }; Body: any }>('/guests/:type/:vmid/move', async (q, r) => wrap(r, async () => {
      const body: any = q.body ?? {}
      const b = moveBody(body)
      const when = body.when === 'next-quiet' ? 'next-quiet' : 'now'
      return svc().move(guestSid(q.params), b.target, { when, anyway: body.anyway === true, bwlimitKiB: b.bwlimitKiB }, actor())
    }))

    fastify.get<{ Querystring: { sid?: string } }>('/moves', async (q, r) => wrap(r, () => {
      const sid = q.query?.sid && /^(ct|vm):\d{1,9}$/.test(q.query.sid) ? q.query.sid : undefined
      return svc().history(sid)
    }))
    fastify.get<{ Params: { id: string } }>('/moves/:id', async (q, r) => wrap(r, async () => {
      const m = await svc().getMove(q.params.id)
      if (!m) throw new PlacementRefusal('No such move.', 404, 'not-found')
      return m
    }))
    fastify.post<{ Params: { id: string } }>('/moves/:id/cancel', async (q, r) => wrap(r, () => svc().cancel(q.params.id, actor())))
    fastify.post<{ Params: { id: string } }>('/moves/:id/resolve', async (q, r) => wrap(r, () => svc().resolve(q.params.id, actor())))
    fastify.post<{ Params: { id: string } }>('/moves/:id/corosync', async (q, r) => wrap(r, () => svc().corosyncFor(q.params.id, actor())))
  }
}

export const placementRoutes: FastifyPluginAsync = buildPlacementRoutes({ startScheduler: true })
