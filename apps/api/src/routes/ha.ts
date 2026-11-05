// =============================================================================
//  HyperProx — HA management routes (/api/ha)
//
//  Reads are for anyone signed in: the HA page, one guest's panel, the
//  migration grid and the list badges. Every write is a preview, then an
//  apply of that preview's id (lib/ha/plans.ts). Preview and check are admin;
//  apply is admin with the master password re-entered (lib/roles.ts, HA_*).
// =============================================================================

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { currentContext } from '../lib/auth'
import { VaultLockedError } from '../lib/credentials'
import {
  HaRefusal, badges, guestView, haPlanner, overview, preflightGrid, readConfig, readMigratePreconditions, readSnapshot, sidOf,
  type HaPlanner, type HaPve, type HaSnapshot,
} from '../lib/ha'
import { livePve } from '../lib/pve-env'
import { normaliseRule } from '../lib/ha/plans'
import { redactText } from '../lib/ha/redact'

function actor() {
  const c = currentContext()
  return { email: c?.email ?? 'unknown', role: String(c?.role ?? 'viewer') }
}

async function wrap(reply: FastifyReply, fn: () => Promise<unknown>) {
  try { return { success: true, data: await fn() } }
  catch (e: any) {
    if (e instanceof HaRefusal) return reply.status(e.status).send({ success: false, error: redactText(e.message), problems: e.problems })
    // Locked: the Proxmox token is in the vault, so there is no status to show without it.
    if (e instanceof VaultLockedError || /HyperProx is locked/.test(String(e?.message))) {
      return reply.status(423).send({ success: false, error: 'HyperProx is locked — sign in to see HA status.' })
    }
    return reply.status(502).send({ success: false, error: redactText(e?.message ?? String(e)) })
  }
}

const TYPES = new Set(['lxc', 'qemu'])

export function buildHaRoutes(deps: { planner?: () => HaPlanner; pve?: () => HaPve; cacheMs?: number } = {}): FastifyPluginAsync {
  return async (fastify) => {
    const plans = deps.planner ?? (() => haPlanner((fastify as any).prisma))
    // Wire the power hook's dependencies now, not on the first HA request.
    if (!deps.planner) haPlanner((fastify as any).prisma)
    const pve = deps.pve ?? (() => livePve() as unknown as HaPve)
    const cacheMs = deps.cacheMs ?? 4000

    // A short cache for the cluster-wide reads: a list of guests asks for badges once per render.
    let cached: { at: number; snap: Promise<HaSnapshot> } | null = null
    const clusterSnap = () => {
      if (!cached || Date.now() - cached.at > cacheMs) {
        const snap = readSnapshot(pve(), { configs: 'ha' })
        cached = { at: Date.now(), snap }
        snap.catch(() => { cached = null })
      }
      return cached.snap
    }
    const guestParams = (p: { type: string; vmid: string }) => {
      if (!TYPES.has(p.type) || !/^\d{1,9}$/.test(p.vmid)) throw new HaRefusal('Not a guest: use /lxc/<id> or /qemu/<id>.', 400)
      return sidOf(p.type as 'lxc' | 'qemu', Number(p.vmid))
    }

    fastify.get('/overview', async (_q, r) => wrap(r, async () => overview(await clusterSnap())))
    fastify.get('/badges', async (_q, r) => wrap(r, async () => badges(await clusterSnap())))

    fastify.get<{ Params: { type: string; vmid: string } }>('/guests/:type/:vmid', async (q, r) => wrap(r, async () => {
      const sid = guestParams(q.params)
      const snap = await readSnapshot(pve(), { configs: 'none', extra: [sid] })
      const v = guestView(snap, sid)
      if (!v) throw new HaRefusal(`There is no guest ${sid}.`, 404)
      return {
        ...v,
        nodes: snap.nodes.map(n => ({ node: n.node, online: n.online, maintenance: n.maintenance })),
        // Candidates for "keep apart from / together with": other HA guests (PVE takes only HA guests in rules).
        others: snap.resources.filter(x => x.sid !== sid).map(x => {
          const g = snap.guests.find(y => y.sid === x.sid)
          return { sid: x.sid, name: g?.name ?? x.sid, node: g?.node ?? '' }
        }),
        quorate: snap.quorate, fencing: snap.fencing,
      }
    }))

    fastify.get<{ Params: { type: string; vmid: string } }>('/guests/:type/:vmid/preflight', async (q, r) => wrap(r, async () => {
      const sid = guestParams(q.params)
      const snap = await readSnapshot(pve(), { configs: 'none' })
      const g = snap.guests.find(x => x.sid === sid)
      if (!g) throw new HaRefusal(`There is no guest ${sid}.`, 404)
      const [pre, config] = await Promise.all([readMigratePreconditions(pve(), g.node, sid), readConfig(pve(), g.node, sid)])
      return preflightGrid(snap, g, pre, config)
    }))

    fastify.post<{ Body: any }>('/preview', async (q, r) => wrap(r, async () => {
      const plan = await plans().preview((q.body ?? {}) as any, actor())
      cached = null
      return plan
    }))
    fastify.post<{ Body: any }>('/check', async (q, r) => wrap(r, async () => {
      const b: any = q.body ?? {}
      return plans().check(normaliseRule(b.rule), b.replacing ? String(b.replacing) : null)
    }))
    fastify.post<{ Params: { id: string } }>('/plans/:id/apply', async (q, r) => wrap(r, async () => {
      cached = null
      return plans().apply(q.params.id, actor())
    }))
  }
}

export const haRoutes: FastifyPluginAsync = buildHaRoutes()
