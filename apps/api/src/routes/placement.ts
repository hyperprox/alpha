// =============================================================================
//  HyperProx — load balancing routes (/api/placement, the Load balancing page)
//
//  Reads are for anyone signed in, as the guest list is: the balance, the map,
//  the advice, one guest, the move history, the plans, the settings and
//  automatic balancing's settings. The move check is admin. A move (now or
//  scheduled), running or scheduling a balancing plan, and saving automatic
//  balancing (which can turn on applying automatically) are admin with the
//  master password re-entered, and refused to API tokens outright
//  (lib/roles.ts PLACEMENT_*, lib/api-tokens.ts). Stopping a plan and the
//  emergency stop are admin and audited, without the password: stopping is
//  always safe. Checking bind-mount paths and reading corosync's log use node
//  logins, so they are admin and audited. Home cluster only.
//
//  The routes keep the /api/placement prefix (internal); the page is /balance.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { allSessions, currentContext } from '../lib/auth'
import { memberRoles } from '../lib/users/roles'
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

const actor = () => ({ email: currentContext()?.email ?? 'unknown', role: String(currentContext()?.role ?? 'viewer') })

async function wrap(reply: FastifyReply, fn: () => Promise<unknown>) {
  try {
    if (currentRemote()) throw new PlacementRefusal('Load balancing works on the home cluster only for now.', 400, 'home-only')
    return { success: true, data: await fn() }
  } catch (e: any) {
    if (e instanceof PlacementRefusal) return reply.status(e.status).send({ success: false, code: e.code, error: redactText(e.message), ...e.extra })
    if (e instanceof VaultLockedError || /HyperProx is locked/.test(String(e?.message))) {
      return reply.status(423).send({ success: false, error: 'HyperProx is locked — sign in to see load balancing.' })
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
    // Has the approver of a scheduled move been removed or demoted since they approved it? From what HyperProx holds,
    // never by borrowing anyone's session: their own live session (its role is current: a role change signs them
    // out), the audit log (a removal names the email; a role change names only a member id, so any demotion since
    // the approval counts), and the operator record a demotion to operator leaves.
    approverChanged: (email, sinceMs) => approverChanged(prisma, email, sinceMs),
    alert: async (title, lines) => {
      await publish({ type: 'placement.move.stuck', severity: 'warning', title, lines, link: '/balance', where: 'Load balancing page', fingerprint: `placement:${title}` }).catch(() => undefined)
    },
    notify: async (title, lines, fingerprint, severity = 'info') => {
      await publish({ type: 'placement.balance', severity, title, lines, link: '/balance', where: 'Load balancing page', fingerprint }).catch(() => undefined)
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

/** Exported for tests. */
export async function approverChanged(prisma: any, email: string, sinceMs: number, sessions = allSessions, recorded = (e: string) => memberRoles().get(e)): Promise<string | null> {
  const e = email.toLowerCase()
  const own = sessions().find(x => String(x.email).toLowerCase() === e)
  if (own && own.role !== 'admin' && own.role !== 'owner') return `is now ${own.role}, not admin`
  let rec: string | null = null
  try { rec = recorded(e) } catch { rec = null }
  if (rec && rec !== 'admin') return `is now ${rec}, not admin`
  if (!prisma?.auditLog) return null
  const since = new Date(sinceMs)
  const rows: any[] = await prisma.auditLog.findMany({ where: { action: { in: ['users.remove', 'users.role'] }, createdAt: { gte: since } }, take: 200 })
  for (const r of rows) {
    const d = (r.details ?? {}) as Record<string, unknown>
    if (r.action === 'users.remove' && String(d.email ?? '').toLowerCase() === e) return 'was removed after approving it'
    if (r.action === 'users.role' && d.role !== 'admin' && !(own && (own.role === 'admin' || own.role === 'owner'))) {
      return 'may have been demoted: a role was lowered after the approval, and HyperProx cannot tell whose'
    }
  }
  return null
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

    // Load balancing: the balance and its plan, plans, and automatic balancing.
    const goalOf = (v: unknown) => (v === 'mem' || v === 'cpu' || v === 'both' ? v : undefined)
    fastify.get<{ Querystring: { goal?: string } }>('/balance', async (q, r) => wrap(r, () => svc().balanceView(goalOf(q.query?.goal))))
    fastify.get('/plans', async (_q, r) => wrap(r, () => svc().plans()))
    fastify.get<{ Params: { id: string } }>('/plans/:id', async (q, r) => wrap(r, async () => {
      const p = await svc().getPlan(q.params.id)
      if (!p) throw new PlacementRefusal('No such plan.', 404, 'not-found')
      return p
    }))
    fastify.post<{ Body: any }>('/plans', async (q, r) => wrap(r, async () => {
      const b: any = q.body ?? {}
      const expect = Array.isArray(b.expect) ? b.expect.slice(0, 20).map((x: any) => ({ sid: String(x?.sid ?? ''), to: String(x?.to ?? '') })) : null
      if (!expect || !expect.length || expect.some((x: { sid: string; to: string }) => !/^(ct|vm):\d{1,9}$/.test(x.sid) || !NODE.test(x.to))) {
        throw new PlacementRefusal('Send the moves you approved (expect: [{ sid, to }]), so the server runs exactly those.', 400, 'bad-plan')
      }
      if (b.when !== undefined && b.when !== 'now' && b.when !== 'next-quiet') throw new PlacementRefusal('when must be now or next-quiet.', 400, 'bad-when')
      if (b.goal !== undefined && !goalOf(b.goal)) throw new PlacementRefusal('goal must be mem, cpu or both.', 400, 'bad-goal')
      return svc().createPlan({ when: b.when ?? 'now', goal: goalOf(b.goal), expect }, actor())
    }))
    fastify.post<{ Params: { id: string } }>('/plans/:id/stop', async (q, r) => wrap(r, () => svc().stopPlan(q.params.id, actor())))
    fastify.get('/auto', async (_q, r) => wrap(r, () => svc().autoSettings()))
    fastify.put<{ Body: unknown }>('/auto', async (q, r) => wrap(r, () => svc().saveAuto(q.body, actor())))
    fastify.post('/auto/stop', async (_q, r) => wrap(r, () => svc().autoStop(actor())))

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
