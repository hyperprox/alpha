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

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { approverChanged } from '../lib/users/approvals'
import { actorOf } from '../lib/http/request-actor'
import { answerData, type RefusalAnswer } from '../lib/http/answer'
import { VaultLockedError } from '../lib/credentials'
import { currentRemote } from '../lib/clusters/context'
import { isSid, parseGuestPath, sidOf } from '../lib/guest-id'
import { redactText } from '../lib/ha/redact'
import { PlacementRefusal, PlacementService } from '../lib/placement/service'
import { placementService } from '../lib/placement/production'

/** How load balancing's failures are answered. Its refusals keep their words; anything else is reported as Proxmox's answer. */
function placementRefusal(e: any): RefusalAnswer {
  if (e instanceof PlacementRefusal) return { status: e.status, code: e.code, error: redactText(e.message), extra: e.extra }
  if (e instanceof VaultLockedError || /HyperProx is locked/.test(String(e?.message))) {
    return { status: 423, code: 'locked', error: 'HyperProx is locked — sign in to see load balancing.' }
  }
  return { status: 502, code: 'bad_gateway', error: redactText(String(e?.message ?? e)) }
}

function wrap(reply: FastifyReply, fn: () => Promise<unknown>) {
  return answerData(reply, () => {
    if (currentRemote()) throw new PlacementRefusal('Load balancing works on the home cluster only for now.', 400, 'home-only')
    return fn()
  }, { refusal: placementRefusal })
}

const NODE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/

function guestSid(p: { type: string; vmid: string }): string {
  const g = parseGuestPath(p.type, p.vmid)
  if (!g) throw new PlacementRefusal('Not a guest: use /lxc/<id> or /qemu/<id>.', 400, 'bad-guest')
  return sidOf(g.type, g.vmid)
}

// The production service is built in lib/placement/production.ts and its scheduler is started by
// lib/services/bootstrap.ts; these routes only resolve it.
export { placementService }

/** Exported for tests (lib/users/approvals.ts: an owner counts as an admin). */
export { approverChanged }

export function buildPlacementRoutes(deps: { service?: () => PlacementService } = {}): FastifyPluginAsync {
  return async (fastify) => {
    const svc = deps.service ?? (() => placementService((fastify as any).prisma, fastify.log))

    fastify.get('/map', async (_q, r) => wrap(r, () => svc().map()))
    fastify.get('/advice', async (_q, r) => wrap(r, () => svc().advice()))
    fastify.get('/settings', async (_q, r) => wrap(r, () => svc().settings()))
    fastify.put<{ Body: unknown }>('/settings', async (q, r) => wrap(r, () => svc().saveSettings(q.body, actorOf(q))))
    fastify.get<{ Params: { type: string; vmid: string } }>('/guests/:type/:vmid', async (q, r) => wrap(r, () => svc().guest(guestSid(q.params))))
    fastify.post<{ Params: { type: string; vmid: string } }>('/guests/:type/:vmid/paths', async (q, r) => wrap(r, () => svc().checkPaths(guestSid(q.params), actorOf(q))))

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
      return svc().move(guestSid(q.params), b.target, { when, anyway: body.anyway === true, bwlimitKiB: b.bwlimitKiB }, actorOf(q))
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
      if (!expect || !expect.length || expect.some((x: { sid: string; to: string }) => !isSid(x.sid) || !NODE.test(x.to))) {
        throw new PlacementRefusal('Send the moves you approved (expect: [{ sid, to }]), so the server runs exactly those.', 400, 'bad-plan')
      }
      if (b.when !== undefined && b.when !== 'now' && b.when !== 'next-quiet') throw new PlacementRefusal('when must be now or next-quiet.', 400, 'bad-when')
      if (b.goal !== undefined && !goalOf(b.goal)) throw new PlacementRefusal('goal must be mem, cpu or both.', 400, 'bad-goal')
      return svc().createPlan({ when: b.when ?? 'now', goal: goalOf(b.goal), expect }, actorOf(q))
    }))
    fastify.post<{ Params: { id: string } }>('/plans/:id/stop', async (q, r) => wrap(r, () => svc().stopPlan(q.params.id, actorOf(q))))
    fastify.get('/auto', async (_q, r) => wrap(r, () => svc().autoSettings()))
    fastify.put<{ Body: unknown }>('/auto', async (q, r) => wrap(r, () => svc().saveAuto(q.body, actorOf(q))))
    fastify.post('/auto/stop', async (q, r) => wrap(r, () => svc().autoStop(actorOf(q))))

    fastify.get<{ Querystring: { sid?: string } }>('/moves', async (q, r) => wrap(r, () => {
      const sid = q.query?.sid && isSid(q.query.sid) ? q.query.sid : undefined
      return svc().history(sid)
    }))
    fastify.get<{ Params: { id: string } }>('/moves/:id', async (q, r) => wrap(r, async () => {
      const m = await svc().getMove(q.params.id)
      if (!m) throw new PlacementRefusal('No such move.', 404, 'not-found')
      return m
    }))
    fastify.post<{ Params: { id: string } }>('/moves/:id/cancel', async (q, r) => wrap(r, () => svc().cancel(q.params.id, actorOf(q))))
    fastify.post<{ Params: { id: string } }>('/moves/:id/resolve', async (q, r) => wrap(r, () => svc().resolve(q.params.id, actorOf(q))))
    fastify.post<{ Params: { id: string } }>('/moves/:id/corosync', async (q, r) => wrap(r, () => svc().corosyncFor(q.params.id, actorOf(q))))
  }
}

export const placementRoutes: FastifyPluginAsync = buildPlacementRoutes()
