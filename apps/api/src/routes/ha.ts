// =============================================================================
//  HyperProx — HA management routes (/api/ha)
//
//  Reads are for anyone signed in: the HA page, one guest's panel, the
//  migration grid and the list badges. Every write is a preview, then an
//  apply of that preview's id (lib/ha/plans.ts). Preview and check are admin;
//  apply is admin with the master password re-entered (lib/roles.ts, HA_*).
// =============================================================================

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { contextActor } from '../lib/http/request-actor'
import { answerData, type RefusalAnswer } from '../lib/http/answer'
import { VaultLockedError } from '../lib/credentials'
import {
  HaRefusal, badges, guestView, haPlanner, overview, preflightGrid, readConfig, readMigratePreconditions, readSnapshot, sidOf,
  nodeAddress, pinFingerprint, pinnedFingerprint, probeFingerprint,
  type HaPlanner, type HaPve, type HaSnapshot,
} from '../lib/ha'
import { livePve } from '../lib/pve-env'
import { normaliseRule } from '../lib/ha/plans'
import { redactText } from '../lib/ha/redact'

/** How HA's failures are answered. Its refusals keep their words; anything else is reported as Proxmox's answer. */
function haRefusal(e: any): RefusalAnswer {
  if (e instanceof HaRefusal) return { status: e.status, code: 'refused', error: redactText(e.message), extra: { problems: e.problems } }
  // Locked: the Proxmox token is in the vault, so there is no status to show without it.
  if (e instanceof VaultLockedError || /HyperProx is locked/.test(String(e?.message))) {
    return { status: 423, code: 'locked', error: 'HyperProx is locked — sign in to see HA status.' }
  }
  return { status: 502, code: 'bad_gateway', error: redactText(e?.message ?? String(e)) }
}

const wrap = (reply: FastifyReply, fn: () => Promise<unknown>) => answerData(reply, fn, { refusal: haRefusal })

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
        quorate: snap.quorate, fencing: snap.fencing, disarmMode: snap.disarmMode,
      }
    }))

    fastify.get<{ Params: { type: string; vmid: string } }>('/guests/:type/:vmid/preflight', async (q, r) => wrap(r, async () => {
      const sid = guestParams(q.params)
      const snap = await readSnapshot(pve(), { configs: 'none', extra: [sid] })
      const g = snap.guests.find(x => x.sid === sid)
      if (!g) throw new HaRefusal(`There is no guest ${sid}.`, 404)
      const [pre, config] = await Promise.all([readMigratePreconditions(pve(), g.node, sid), readConfig(pve(), g.node, sid)])
      return preflightGrid(snap, g, pre, config, g.hardware)
    }))

    // Node SSH host keys, for maintenance mode: see what the node presents, then pin exactly that key.
    const nodeHost = async (node: string) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/.test(node)) throw new HaRefusal(`There is no node ${node}.`, 404)
      const snap = await readSnapshot(pve(), { configs: 'none' })
      if (!snap.nodes.some(n => n.node === node)) throw new HaRefusal(`There is no node ${node}.`, 404)
      return nodeAddress(pve() as any, node)
    }
    fastify.post<{ Params: { node: string } }>('/nodes/:node/hostkey/check', async (q, r) => wrap(r, async () => {
      const host = await nodeHost(q.params.node)
      const [pinned, presented] = await Promise.all([pinnedFingerprint(host).catch(() => null), probeFingerprint(host)])
      return { node: q.params.node, pinned, presented, matches: pinned ? pinned === presented : null,
        words: pinned ? (pinned === presented ? 'Pinned, and the node still presents that key.' : 'The node presents a DIFFERENT key from the pinned one. Do not pin it unless you know the node was rebuilt.')
          : `Not pinned. Compare ${presented} with \`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub\` on the node's own console before pinning.` }
    }))
    fastify.post<{ Params: { node: string }; Body: any }>('/nodes/:node/hostkey/pin', async (q, r) => wrap(r, async () => {
      const host = await nodeHost(q.params.node)
      try { return await pinFingerprint(host, String((q.body as any)?.fingerprint ?? '')) }
      catch (e: any) { throw new HaRefusal(e?.message ?? String(e), 409) }
    }))

    fastify.post<{ Body: any }>('/preview', async (q, r) => wrap(r, async () => {
      const plan = await plans().preview((q.body ?? {}) as any, contextActor())
      cached = null
      return plan
    }))
    fastify.post<{ Body: any }>('/check', async (q, r) => wrap(r, async () => {
      const b: any = q.body ?? {}
      return plans().check(normaliseRule(b.rule), b.replacing ? String(b.replacing) : null)
    }))
    fastify.post<{ Params: { id: string } }>('/plans/:id/apply', async (q, r) => wrap(r, async () => {
      cached = null
      return plans().apply(q.params.id, contextActor())
    }))
  }
}

export const haRoutes: FastifyPluginAsync = buildHaRoutes()
