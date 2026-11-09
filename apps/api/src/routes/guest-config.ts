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
import { GuestConfigService, GuestConfigRefusal, PORTABLE_REFRESH_MS, type GuestId, type PreviewInput, type Preview } from '../lib/guest-config/service'
import { redactForViewer } from '../lib/guest-config/devices'
import { redactText, redactValue } from '../lib/guest-config/secrets'

/** Viewers see what a guest has, by name and purpose, never device paths, PCI addresses or raw lines. */
export function redactViewForViewer(v: any): any {
  const DEV = /^(dev|hostpci|usb|serial)\d+$/
  const config = Object.fromEntries(Object.entries(v.config ?? {}).filter(([k]) => k !== 'lxc').map(([k, val]) => [k, DEV.test(k) ? 'set' : val]))
  return {
    ...v, config,
    // Raw lines (and passthrough keys) are counted for a viewer, never listed.
    keys: { ...v.keys, raw: [], unknown: v.keys?.unknown ?? [] },
    gpu: v.gpu ? { ...v.gpu, entries: (v.gpu.entries ?? []).map((e: any) => ({ ...e, value: '', device: '' })), managed: {}, managedRaw: [] } : v.gpu,
    pending: v.pending ? { ...v.pending, rows: (v.pending.rows ?? []).map((r: any) => (DEVICE_KEY.test(r.key) ? { key: r.key, delete: r.delete, value: r.value === undefined ? undefined : 'set', pending: r.pending === undefined ? undefined : 'set' } : r)) } : v.pending,
  }
}
const DEVICE_KEY = /^(dev|hostpci|usb|serial)\d+$|^lxc\./
/** A change line for a viewer: which setting changed, never a device path or a raw line. */
export function changeForViewer(c: { key: string; words: string }): { key: string; words: string } {
  if (DEVICE_KEY.test(c.key)) return { key: c.key, words: c.key.startsWith('lxc.') ? 'A raw lxc line changed (shown to admins)' : `Device entry ${c.key} changed (shown to admins)` }
  return { key: c.key, words: c.words.replace(/\/dev\/[^\s,;)]+/g, '(device)').replace(/\b[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}(\.[0-7])?\b/gi, '(PCI device)') }
}

export function redactGpuForViewer(d: any): any {
  return { ...d, gpu: d.gpu ? { ...d.gpu, entries: (d.gpu.entries ?? []).map((e: any) => ({ ...e, value: '', device: '' })) } : d.gpu, inUse: d.inUse ? { name: d.inUse.name.startsWith('/dev/') ? 'a GPU' : d.inUse.name, device: '' } : null }
}

/** `?refresh=1` on the device list: admins only, and at most once per node every 15 seconds. */
const REFRESH_MS = 15_000
const lastRefresh = new Map<string, number>()
import { livePveAdapter, liveNodeShell, prismaAudit, vaultHmacKey } from '../lib/guest-config/pve-adapter'
import { PrismaHistoryStore } from '../lib/guest-config/history/store'
import { GpuMoveWatcher } from '../lib/guest-config/gpu-watch'
import { publish } from '../lib/notify'
import { isUnlocked, onLock } from '../lib/vault/state'
import { setGpuPortability } from '../lib/ha'
import { ClusterHistoryStore } from '../lib/clusters/history'
import { notAvailableVpn } from '../lib/guest-config/vpn'
import { currentRemote } from '../lib/clusters/context'

let shared: GuestConfigService | null = null
export function guestConfigService(db: PrismaClient): GuestConfigService {
  shared ??= new GuestConfigService({ pve: livePveAdapter(), shell: liveNodeShell(prismaAudit(db)), history: new PrismaHistoryStore(db), audit: prismaAudit(db), hmacKey: vaultHmacKey })
  return shared
}

/**
 * A remote cluster's own service: its previews, device caches and node list never mix with another cluster's,
 * and its history rows are kept under its own prefix (lib/clusters/history.ts). The Proxmox and node adapters
 * are the same ones: they follow the request's cluster. VPN status is the home cluster's feature, so it says
 * "not available" here rather than showing home guests' status against the same IDs.
 */
const remoteServices = new Map<string, GuestConfigService>()
export function remoteGuestConfigService(db: PrismaClient, clusterId: string): GuestConfigService {
  let s = remoteServices.get(clusterId)
  if (!s) {
    s = new GuestConfigService({
      pve: livePveAdapter(), shell: liveNodeShell(prismaAudit(db)), history: new ClusterHistoryStore(new PrismaHistoryStore(db), clusterId),
      audit: async (action, resource, details) => prismaAudit(db)(action, resource, { ...details, cluster: clusterId }), hmacKey: vaultHmacKey, vpn: notAvailableVpn,
    })
    remoteServices.set(clusterId, s)
  }
  return s
}
export function forgetRemoteGuestConfigService(clusterId: string): void { remoteServices.get(clusterId)?.forgetKeys(); remoteServices.delete(clusterId) }

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
    changes: p.plan.changes.map(c => ({ ...c, before: c.before === null ? null : redactValue(c.key, c.before), after: c.after === null ? null : redactValue(c.key, c.after), words: redactText(c.words) })),
    warnings: p.plan.warnings, errors: p.plan.errors.map(redactText), checks: p.plan.checks.map(redactText),
    options: p.plan.options ?? [], rawFile: !!p.file,
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
        const admin = d.isAdmin()
        let refresh = false
        if (req.query.refresh === '1') {
          if (!admin) return reply.status(403).send({ success: false, error: 'Refreshing a node’s devices needs the admin role.' })
          if (!(await d.service.knownNode(req.params.node))) return reply.status(404).send({ success: false, error: 'No such node.' })
          const last = lastRefresh.get(req.params.node) ?? 0
          if (Date.now() - last < REFRESH_MS) return reply.status(429).send({ success: false, error: 'Refreshed a moment ago; try again in a few seconds.' })
          lastRefresh.set(req.params.node, Date.now()); refresh = true
        }
        // A viewer is answered from the cache: a viewer's request never logs in to a node.
        const inv = await d.service.inventory(req.params.node, refresh, { cachedOnly: !admin })
        return { success: true, data: admin ? inv : redactForViewer(inv), redacted: !admin }
      } catch (e) { return fail(reply, e) }
    })

    fastify.get<G>('/guests/:node/:type/:vmid', async (req, reply) => {
      try {
        const d = deps(); const admin = d.isAdmin()
        const v = await d.service.view(guestOf(req.params), { cachedOnly: !admin })
        return { success: true, data: admin ? v : redactViewForViewer(v), redacted: !admin }
      } catch (e) { return fail(reply, e) }
    })

    fastify.get<G>('/guests/:node/:type/:vmid/gpu', async (req, reply) => {
      try {
        const d = deps()
        const admin = d.isAdmin()
        const data = await d.service.gpuDetail(guestOf(req.params), { cachedOnly: !admin })
        return { success: true, data: admin ? data : { ...redactGpuForViewer(data), devices: redactForViewer({ node: req.params.node, devices: data.devices, majors: {}, nvidiaNodes: [], collectedAt: 0 }).devices } }
      } catch (e) { return fail(reply, e) }
    })

    fastify.get<G>('/guests/:node/:type/:vmid/history', async (req, reply) => {
      try {
        const g = guestOf(req.params)
        const d = deps(); const admin = d.isAdmin()
        const rows = await d.service.historyOf(g)
        return { success: true, redacted: !admin, data: rows.map(r => ({
          id: r.id, kind: r.kind, tag: r.tag, actor: r.actor, outcome: r.outcome, createdAt: r.createdAt,
          changes: admin ? r.changes : r.changes.map(changeForViewer),
          problems: admin ? r.problems : r.problems.map(x => changeForViewer({ key: '', words: x }).words),
        })) }
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
  // Key material is not held past a lock.
  onLock(() => { service.forgetKeys(); for (const s of remoteServices.values()) s.forgetKeys() })
  // After an HA move, check that a GPU guest still sees a GPU and say so. Checks only, every minute, and only
  // while unlocked: the node logins it reads with come from the vault.
  const watcher = new GpuMoveWatcher(service, async e => publish({
    type: e.type, severity: e.severity, title: e.title, where: 'Infrastructure page', link: '/infrastructure',
    subject: { kind: 'guest', name: e.guest.name }, fingerprint: `${e.type}:${e.guest.vmid}:${e.guest.to}`,
  }), () => Date.now(), () => !isUnlocked())
  // HA's failover note asks how a guest's GPU follows it: Portable GPU answers from its last refresh.
  setGpuPortability(g => service.portabilityOf(g.sid))
  // Every node's devices are re-read every 15 minutes (a node login each); in between, only the cache is read.
  let lastProbe = 0
  let migrated = false
  const refreshPortable = () => {
    const probe = Date.now() - lastProbe >= PORTABLE_REFRESH_MS
    if (probe) lastProbe = Date.now()
    return service.refreshPortability({ probe }).catch(err => fastify.log.warn({ err: err?.message }, '[guest-config] portability refresh failed'))
  }
  // Start-up: GPU state kept under an older key moves to the marker key once, on the first unlocked pass.
  const migrateOnce = async () => {
    if (migrated) return
    migrated = true
    try { const n = await service.migrateLegacyGpuState(); if (n) fastify.log.info(`[guest-config] moved GPU state of ${n} guest(s) to their marker keys`) }
    catch (err: any) { migrated = false; fastify.log.warn({ err: err?.message }, '[guest-config] GPU state migration failed; retrying on the next pass') }
  }
  const timer = setInterval(() => { if (isUnlocked()) { void migrateOnce(); void refreshPortable(); watcher.tick().catch(err => fastify.log.warn({ err: err?.message }, '[guest-config] GPU move check failed')) } }, 60_000)
  timer.unref()
  fastify.addHook('onClose', async () => { clearInterval(timer); setGpuPortability(null) })
  await fastify.register(buildGuestConfigRoutes(() => ({
    // The request's cluster (lib/clusters/context.ts); home unless a remote cluster's page asked.
    service: (() => { const r = currentRemote(); return r ? remoteGuestConfigService(fastify.prisma, r.id) : service })(),
    whoami: () => ownerOf(currentContext()),
    isAdmin: () => { const c = currentContext(); return !!c && hasRole(c.role, 'admin') },
  })))
}
