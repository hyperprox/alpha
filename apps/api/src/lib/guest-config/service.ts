// =============================================================================
//  HyperProx — guest config editing: server-held previews, digest-checked
//  writes, the quorum gate, and an outcome read back from Proxmox
//
//  Every write is two calls. preview() reads the guest fresh, builds the plan,
//  and keeps it on the server under an id. apply() takes only that id (and the
//  person's confirmation), checks the cluster is quorate and the config is the
//  one previewed (its digest), writes exactly the plan through the Proxmox API,
//  waits for any task, re-reads, and compares. A task that says OK while the
//  config did not change is reported as failed. Every write is stored in the
//  guest's history (before and after) and in the audit log.
//
//  Nothing here writes a file on a node, and nothing writes /etc/pve directly.
//  The node login is used for read-only probes only (devices, paths, what a
//  container can see after a restart).
// =============================================================================

import { randomUUID } from 'node:crypto'
import { inventory as keyInventory, rawLines, str, type GuestType, type PveConfig } from './keys'
import {
  buildEditPlan, buildRevertPlan, protect, verifyOutcome, pendingKeysOf, emptyPlan,
  type GuestCtx, type Plan, type PlanKind, type StructuredEdit, type PathCheck, type PendingRow, type Outcome,
} from './plan'
import {
  detectGpu, rawChanges, buildGpuGrantPlan, buildGpuRevokePlan, buildGpuOffPlan, buildGpuOnPlan, buildGpuConvertPlan, buildRawEditPlan,
  buildHostpciPlan, buildDeviceGrantPlan, containerNvidiaVersion, driverMatch, sharers, buildPortableGpuPlan, PORTABLE_WHY_RAW, PORTABLE_NO_WRITER,
  type GpuGrant, type GpuOffRecord, type GpuOffInput, type RawEdit, type HostpciEdit, type DeviceGrant,
} from './gpu'
import { PROBE_SCRIPT, parseProbe, attachUsage, type GuestRef, type NodeInventory } from './devices'
import { type HistoryStore, type HistoryRow, type GpuState } from './history/store'
import { createHmac, randomBytes } from 'node:crypto'
import { maskConfig, isSecretKey, redactConfFile, redactText, redactValue, REDACTED } from './secrets'
import { splitConf, rewriteRawLines, readScript, writeScript, parseRead, cleanupScript, rawLineAllowed, rawLineForm, addedSources, verifyScript, parseVerify, DEVICE_DIRS, sha256, type RawAllow } from './rawfile'
import { gpuMajors } from './devices'
import { vpnStatuses, vpnStatusSource, type VpnStatusSource } from './vpn'

// ── what the service reaches ──────────────────────────────────────────────────

/** The Proxmox API, strict: a non-2xx answer throws with Proxmox's own words. */
export interface GuestPve {
  get<T = any>(path: string): Promise<T>
  put<T = any>(path: string, params: Record<string, string>): Promise<T>
  post<T = any>(path: string, params?: Record<string, string>): Promise<T>
}

/** Read-only commands on a node over its login. null: no login for that node. */
export interface NodeShell {
  run(node: string, command: string, timeoutMs?: number): Promise<{ code: number; output: string } | null>
}

export interface GuestConfigDeps {
  /**
   * The key for the HMACs history keeps of raw-line values (so a revert can tell an unchanged secret-bearing
   * line from a changed one without storing either). Read from the vault in production.
   */
  hmacKey?: () => Promise<Buffer>
  pve: GuestPve
  shell: NodeShell
  history: HistoryStore
  audit(action: string, resource: string, details: Record<string, unknown>): Promise<void>
  vpn?: VpnStatusSource
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Task and HA waits; tests shorten them. */
  timeouts?: { taskMs?: number; haMs?: number; pollMs?: number }
}

export class GuestConfigRefusal extends Error {
  constructor(message: string, public code: 'not-found' | 'expired' | 'used' | 'changed' | 'not-quorate' | 'refused' | 'confirm' | 'forbidden', public problems: string[] = []) {
    super(message); this.name = 'GuestConfigRefusal'
  }
}

export const PREVIEW_TTL_MS = 10 * 60_000
export const PREVIEW_CAP = 200
export const INVENTORY_TTL_MS = 60_000

export type PreviewInput =
  | { kind: 'edit'; edit: StructuredEdit }
  | { kind: 'revert'; historyId: string; which?: 'before' | 'after' }
  | { kind: 'gpu-grant'; grant: GpuGrant }
  | { kind: 'gpu-revoke' }
  | { kind: 'gpu-off'; off?: GpuOffInput }
  | { kind: 'gpu-on' }
  | { kind: 'gpu-convert' }
  | { kind: 'raw'; raw: RawEdit }
  | { kind: 'hostpci'; hostpci: HostpciEdit }
  | { kind: 'device'; device: DeviceGrant }
  /** Portable GPU: every eligible node's GPU as optional raw lines (previewed; see gpu.ts for why it is not written). */
  | { kind: 'gpu-portable'; nodes?: string[] }
  /** `after`: the id of an applied preview whose device checks this restart verifies. */
  | { kind: 'restart'; after?: string }

export interface GuestId { node: string; type: GuestType; vmid: number }

export interface Preview {
  id: string
  owner: string
  guest: GuestId & { name: string; running: boolean; haManaged: boolean }
  input: PreviewInput
  kind: PlanKind
  plan: Plan
  digest: string
  before: PveConfig
  /** Raw and unmodelled keys counted at preview time. */
  counts: { raw: number; unknown: number }
  /** "Applies on next restart": keys already pending before this change. */
  pendingBefore: string[]
  /** The whole-file write for raw lines: the file and its hash at preview, and the exact bytes to write. */
  file?: { sha: string; before: string; after: string; sources: string[] }
  quorate: boolean
  createdAt: number
  expiresAt: number
  used: boolean
}

export interface ApplyResult {
  ok: boolean
  outcome: Outcome | null
  /** Keys waiting for a restart now. */
  pendingKeys: string[]
  /** The guest runs and has pending keys: offer a restart. */
  restartOffered: boolean
  historyId: string | null
  /** For kind restart: what was checked after it. */
  restart?: RestartResult
}

export interface RestartResult {
  via: 'ha' | 'direct'
  ok: boolean
  steps: string[]
  pendingAfter: string[]
  rawSurvived: boolean | null
  devices: Array<{ path: string; expected: boolean; seen: boolean | null }>
  problems: string[]
}

const SAFE_DEV_PATH = /^\/dev\/[A-Za-z0-9_./:+-]+$/

export class GuestConfigService {
  private previews = new Map<string, Preview>()
  private applying = new Set<string>()
  private inv = new Map<string, { at: number; inv: NodeInventory }>()
  private d: Required<Omit<GuestConfigDeps, 'vpn' | 'timeouts'>> & { vpn?: VpnStatusSource; timeouts: Required<NonNullable<GuestConfigDeps['timeouts']>> }

  constructor(deps: GuestConfigDeps) {
    this.d = {
      now: () => Date.now(), sleep: (ms: number) => new Promise(r => setTimeout(r, ms)), ...deps,
      timeouts: { taskMs: 120_000, haMs: 180_000, pollMs: 2_000, ...(deps.timeouts ?? {}) },
    } as any
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  private base(g: GuestId) { return `/nodes/${encodeURIComponent(g.node)}/${g.type}/${g.vmid}` }

  async quorum(): Promise<{ quorate: boolean; why: string }> {
    try {
      const rows = await this.d.pve.get<any[]>('/cluster/status')
      const c = (rows ?? []).find(r => r?.type === 'cluster')
      if (!c) return { quorate: true, why: 'Standalone node (no cluster).' }
      return Number(c.quorate) === 1 ? { quorate: true, why: 'The cluster is quorate.' } : { quorate: false, why: 'The cluster is not quorate: cluster configuration cannot be written safely until it is.' }
    } catch (e: any) {
      return { quorate: false, why: `Could not read the cluster status, so quorum is unknown: ${e?.message ?? e}` }
    }
  }

  async readGuest(g: GuestId): Promise<GuestCtx & { pending: PendingRow[] }> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(g.node) || !Number.isInteger(g.vmid) || (g.type !== 'lxc' && g.type !== 'qemu'))
      throw new GuestConfigRefusal('No such guest.', 'not-found')
    const [config, pending, status, ha] = await Promise.all([
      this.d.pve.get<PveConfig>(`${this.base(g)}/config`),
      this.d.pve.get<PendingRow[]>(`${this.base(g)}/pending`).catch(() => [] as PendingRow[]),
      this.d.pve.get<any>(`${this.base(g)}/status/current`).catch(() => null),
      this.d.pve.get<any[]>('/cluster/ha/resources').catch(() => [] as any[]),
    ])
    if (!config) throw new GuestConfigRefusal('No such guest.', 'not-found')
    const sid = `${g.type === 'qemu' ? 'vm' : 'ct'}:${g.vmid}`
    return {
      ...g, config, pending: pending ?? [], pendingKeys: pendingKeysOf(pending),
      name: str(config.hostname ?? config.name ?? status?.name ?? g.vmid),
      running: status?.status === 'running',
      haManaged: (ha ?? []).some(r => r?.sid === sid),
    }
  }

  /** The node's device inventory, from one read-only probe, cached a minute. */
  private nodeList: { at: number; names: string[] } | null = null
  /** Node names Proxmox knows, cached a minute: nothing is probed, or cached, for a name it does not know. */
  async knownNode(node: string): Promise<boolean> {
    if (!this.nodeList || this.d.now() - this.nodeList.at > INVENTORY_TTL_MS) {
      const rows = await this.d.pve.get<any[]>('/nodes').catch(() => null)
      if (rows) this.nodeList = { at: this.d.now(), names: rows.map(r => String(r.node)) }
    }
    return !!this.nodeList?.names.includes(node)
  }

  /**
   * The node's device inventory, from one read-only probe, cached a minute. `cachedOnly` never runs a node
   * command (viewers): it answers from the cache, or with a note that nothing has been read yet.
   */
  async inventory(node: string, refresh = false, opts: { cachedOnly?: boolean } = {}): Promise<NodeInventory> {
    if (!(await this.knownNode(node))) throw new GuestConfigRefusal('No such node.', 'not-found')
    const hit = this.inv.get(node)
    if (!refresh && hit && this.d.now() - hit.at < INVENTORY_TTL_MS) return hit.inv
    if (opts.cachedOnly) return hit?.inv ?? { node, devices: [], majors: {}, nvidiaNodes: [], collectedAt: this.d.now(), problem: `${node}’s devices have not been read yet; an admin can refresh them.` }
    let inv: NodeInventory
    const r = await this.d.shell.run(node, PROBE_SCRIPT, 30_000).catch((e: any) => ({ code: -1, output: '', err: String(e?.message ?? e) }) as any)
    if (!r) inv = { node, devices: [], majors: {}, nvidiaNodes: [], collectedAt: this.d.now(), problem: `No login for ${node}: add one under Settings → Nodes to list its devices.` }
    else if (r.code !== 0 && !r.output) inv = { node, devices: [], majors: {}, nvidiaNodes: [], collectedAt: this.d.now(), problem: `The device probe on ${node} failed${(r as any).err ? `: ${(r as any).err}` : ''}.` }
    else inv = parseProbe(node, r.output, this.d.now())
    // Proxmox's own PCI list fills in names when lspci is missing.
    const guests = await this.guestsOn(node).catch(() => [] as GuestRef[])
    attachUsage(inv, guests)
    this.inv.set(node, { at: this.d.now(), inv })
    return inv
  }

  async guestsOn(node: string): Promise<GuestRef[]> {
    const out: GuestRef[] = []
    for (const type of ['lxc', 'qemu'] as const) {
      const list = await this.d.pve.get<any[]>(`/nodes/${encodeURIComponent(node)}/${type}`).catch(() => [] as any[])
      for (const x of list ?? []) {
        const vmid = Number(x.vmid)
        const config = await this.d.pve.get<PveConfig>(`/nodes/${encodeURIComponent(node)}/${type}/${vmid}/config`).catch(() => null)
        if (config) out.push({ vmid, type, node, name: str(x.name ?? config.hostname ?? config.name), running: x.status === 'running', config })
      }
    }
    return out
  }

  /** The guest drill-down's Config tab: fields, raw and unknown keys, pending keys, GPU, who shares its devices. */
  async view(g: GuestId, opts: { cachedOnly?: boolean } = {}) {
    const ctx = await this.readGuest(g)
    const inv = await this.inventory(g.node, false, opts).catch(() => null)
    const gpu = detectGpu(g.type, ctx.config, inv)
    const keys = keyInventory(g.type, maskConfig(ctx.config))
    const rows = await this.d.history.list(`${g.type}/${g.vmid}`, 50).catch(() => [] as HistoryRow[])
    const st = await this.d.history.getGpu(gpuKey(g, ctx.config)).catch(() => null)
    return {
      guest: { ...g, name: ctx.name, running: ctx.running, haManaged: ctx.haManaged },
      config: maskConfig(ctx.config), digest: ctx.config.digest ?? '',
      secretKeys: Object.keys(ctx.config).filter(isSecretKey),
      keys: { modelled: keys.modelled, raw: keys.raw, unknown: keys.unknown, rawCount: keys.raw.length, unknownCount: keys.unknown.length },
      pending: { keys: ctx.pendingKeys, rows: ctx.pending.filter(r => r.pending !== undefined || r.delete).map(r => ({ ...r, value: r.value === undefined ? undefined : redactValue(r.key, str(r.value)), pending: r.pending === undefined ? undefined : redactValue(r.key, str(r.pending)) })) },
      gpu: {
        ...gpu, toggle: st?.off ? 'off' : gpu.entries.length ? 'on' : 'none', offSince: st?.offAt ?? null,
        managed: st?.dev ?? {}, managedRaw: st?.raw ?? [],
      },
      sharers: inv ? sharers(g, inv.devices) : [],
      historyCount: rows.length,
    }
  }

  /** Read-only GPU detail, with the NVIDIA userland check for a running container. */
  async gpuDetail(g: GuestId, opts: { cachedOnly?: boolean } = {}) {
    const ctx = await this.readGuest(g)
    const inv = await this.inventory(g.node, false, opts).catch(() => null)
    const gpu = detectGpu(g.type, ctx.config, inv)
    if (opts.cachedOnly) {
      // A viewer never makes HyperProx log in to a node: no looking inside, no driver check.
      return { gpu, driver: null, groups: null, inUse: null, portable: { whyRaw: PORTABLE_WHY_RAW, noWriter: PORTABLE_NO_WRITER }, devices: inv?.devices.filter(d => d.kind === 'gpu') ?? [], inventoryProblem: inv?.problem ?? null, sharers: inv ? sharers(g, inv.devices) : [] }
    }
    let driver: ReturnType<typeof driverMatch> | null = null
    if (g.type === 'lxc' && gpu.vendors.includes('nvidia')) {
      let guestVer: string | null = null
      if (ctx.running) {
        const r = await this.d.shell.run(g.node, `pct exec ${g.vmid} -- sh -c 'ls /usr/lib/x86_64-linux-gnu/libnvidia-ml.so.* /usr/lib64/libnvidia-ml.so.* /usr/lib/libnvidia-ml.so.* 2>/dev/null'`, 20_000).catch(() => null)
        guestVer = r ? containerNvidiaVersion(r.output) : null
      }
      driver = driverMatch(inv?.nvidiaDriver ?? null, guestVer)
    }
    let groups: { render?: number; video?: number } | null = null
    if (g.type === 'lxc' && ctx.running) {
      const r = await this.d.shell.run(g.node, `pct exec ${g.vmid} -- getent group render video`, 15_000).catch(() => null)
      if (r) { groups = {}; for (const l of r.output.split('\n')) { const [n, , gid] = l.split(':'); if (n === 'render' || n === 'video') groups[n] = Number(gid) } }
    }
    // The GPU it is using now: the first GPU device node visible inside, named from this node's inventory.
    let inUse: { device: string; name: string } | null = null
    if (g.type === 'lxc' && ctx.running && gpu.entries.length) {
      const r = await this.d.shell.run(g.node, `pct exec ${g.vmid} -- sh -c 'for p in /dev/nvidia0 /dev/dri/renderD*; do [ -c "$p" ] && echo "$p"; done; echo HPX-LOOKED'`, 15_000).catch(() => null)
      const dev = r?.output.split('\n').map(l => l.trim()).find(l => l && l !== 'HPX-LOOKED')
      if (dev) inUse = { device: dev, name: inv?.devices.find(d => d.kind === 'gpu' && d.paths.includes(dev))?.name ?? dev }
    }
    return { gpu, driver, groups, inUse, portable: { whyRaw: PORTABLE_WHY_RAW, noWriter: PORTABLE_NO_WRITER }, devices: inv?.devices.filter(d => d.kind === 'gpu') ?? [], inventoryProblem: inv?.problem ?? null, sharers: inv ? sharers(g, inv.devices) : [] }
  }

  /** Check one host path on every online node, for shared=1. Read-only. */
  async checkPath(path: string): Promise<PathCheck> {
    if (!/^\/[A-Za-z0-9_./ -]*$/.test(path) || path.includes('..') || path === '/') throw new GuestConfigRefusal('That is not a path that can be checked.', 'refused')
    const nodes = await this.d.pve.get<any[]>('/nodes')
    const out: PathCheck = { path, ok: false, missing: [], unverified: [], detail: [] }
    const fsTypes = new Map<string, string>()
    for (const n of nodes ?? []) {
      if (n.status !== 'online') { out.unverified.push(`${n.node} (offline: cannot verify on ${n.node})`); continue }
      const r = await this.d.shell.run(n.node, `if [ -d '${path}' ]; then stat -f -c %T '${path}'; else echo MISSING; fi`, 15_000).catch(() => null)
      if (!r) { out.unverified.push(`${n.node} (no node login: cannot verify on ${n.node})`); continue }
      const t = r.output.trim().split('\n')[0] ?? ''
      if (!t || t === 'MISSING') out.missing.push(n.node)
      else { fsTypes.set(n.node, t); out.detail.push(`${n.node}: ${t}`) }
    }
    if (new Set(fsTypes.values()).size > 1) {
      const counts = [...fsTypes.values()].reduce((m, t) => m.set(t, (m.get(t) ?? 0) + 1), new Map<string, number>())
      const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
      for (const [n, t] of fsTypes) if (t !== common) out.missing.push(`${n} (a different filesystem: ${t}, not ${common})`)
    }
    out.ok = !out.missing.length && !out.unverified.length
    return out
  }

  // ── preview ────────────────────────────────────────────────────────────────

  async preview(owner: string, g: GuestId, input: PreviewInput): Promise<Preview> {
    if (!owner) throw new GuestConfigRefusal('Nobody to own this preview.', 'forbidden')
    this.prune()
    if (this.previews.size >= PREVIEW_CAP) throw new GuestConfigRefusal(`There are already ${PREVIEW_CAP} open previews. Wait for them to expire.`, 'refused')
    const ctx = await this.readGuest(g)
    const q = await this.quorum()
    let plan: Plan
    let kind: PlanKind
    /** The inventories an added raw line is checked against: the guest's node, or every Portable GPU node. */
    let rawInvs: NodeInventory[] | null = null
    const rows = () => this.d.history.list(`${g.type}/${g.vmid}`, 200)
    switch (input.kind) {
      case 'edit': {
        const checks: Record<string, PathCheck> = {}
        const m = input.edit?.mounts
        const paths = [
          ...(m?.add ?? []).filter(a => a.kind === 'bind' && a.shared && a.source).map(a => a.source!),
          ...(m?.shared ?? []).filter(s => s.shared).map(s => (str(ctx.config[s.key]).split(',')[0])).filter(p => p.startsWith('/')),
        ]
        for (const p of new Set(paths)) checks[p] = await this.checkPath(p).catch((e: any) => ({ path: p, ok: false, missing: [], unverified: [String(e?.message ?? e)], detail: [] }))
        plan = buildEditPlan(ctx, input.edit ?? {}, checks); kind = 'edit'; break
      }
      case 'revert': {
        const row = await this.d.history.get(input.historyId)
        if (!row || row.guest !== `${g.type}/${g.vmid}`) throw new GuestConfigRefusal('No such version for this guest.', 'not-found')
        const target = input.which === 'after' ? row.after : row.before
        if (!target) throw new GuestConfigRefusal('That version has no config to revert to.', 'not-found')
        // Putting shared=1 back is checked on every node, exactly as setting it is.
        const checks: Record<string, PathCheck> = {}
        for (const [k, v] of Object.entries(target)) {
          if (!/^mp\d+$/.test(k)) continue
          const head = str(v).split(',')[0]
          if (head.startsWith('/') && /(^|,)shared=1(,|$)/.test(str(v))) checks[head] ??= await this.checkPath(head).catch((e: any) => ({ path: head, ok: false, missing: [], unverified: [String(e?.message ?? e)], detail: [] }))
        }
        plan = buildRevertPlan(ctx, target, checks); kind = 'revert'
        plan.checks.push(`Reverting to the config ${input.which === 'after' ? 'after' : 'before'} the change of ${row.createdAt.toISOString()} by ${row.actor}`)
        if (g.type === 'lxc') {
          // Raw lines come back through the whole-file writer. A line is matched by key plus an HMAC of its real
          // value (kept in history instead of the value), so an unchanged secret-bearing line is left exactly as
          // it is, and only device lines are ever written.
          const which = input.which === 'after' ? 'after' : 'before'
          const fileText = (row.meta as any)?.[which === 'after' ? 'fileAfter' : 'fileBefore']
          const stored = typeof fileText === 'string' ? splitConf(fileText).rawMain : rawLines(target)
          const storedH: string[] | null = Array.isArray((row.meta as any)?.rawHmac?.[which]) && (row.meta as any).rawHmac[which].length === stored.length ? (row.meta as any).rawHmac[which] : null
          const have = rawLines(ctx.config)
          const haveH = await this.hmacs(have)
          const used = new Set<number>()
          const unmatched: Array<[string, string]> = []
          stored.forEach((e, i) => {
            const j = have.findIndex((h, jj) => !used.has(jj) && h[0] === e[0] && (storedH ? haveH[jj] === storedH[i] : h[1] === e[1]))
            if (j >= 0) used.add(j); else unmatched.push(e)
          })
          const notReverted: string[] = []
          const add: Array<[string, string]> = []
          for (const e of unmatched) {
            if (e[1].includes(REDACTED)) notReverted.push(`${e[0]} (its value held a secret, which history does not keep)`)
            else if (rawLineForm(e)) notReverted.push(`${e[0]} (HyperProx only edits device lines)`)
            else add.push(e)
          }
          const keepKeys = new Set(unmatched.filter(e => e[1].includes(REDACTED)).map(e => e[0]))
          const remove: Array<[string, string]> = []
          have.forEach((h, j) => {
            if (used.has(j)) return
            if (keepKeys.has(h[0])) return
            if (rawLineForm(h)) { notReverted.push(`${h[0]} (HyperProx only edits device lines)`); return }
            remove.push(h)
          })
          if (notReverted.length) plan.warnings.push(`Raw lines not reverted: ${[...new Set(notReverted)].join(', ')}.`)
          if (remove.length || add.length) { rawChanges(plan, ctx, remove, add); plan.errors = plan.errors.filter(e => !/^Nothing to revert/.test(e)) }
        }
        break
      }
      case 'gpu-grant': plan = buildGpuGrantPlan(ctx, await this.inventory(g.node, true), input.grant, await this.guestsOn(g.node)); kind = 'device'; break
      case 'gpu-revoke': plan = buildGpuRevokePlan(ctx, (await this.gpuState(g, ctx.config)).dev); kind = 'device'; break
      case 'gpu-off': { const st = await this.gpuState(g, ctx.config); plan = buildGpuOffPlan(ctx, { dev: st.dev, raw: st.raw }, input.off ?? {}, await this.inventory(g.node).catch(() => null)); kind = 'gpu-off'; break }
      case 'gpu-on': {
        const st = await this.gpuState(g, ctx.config)
        plan = buildGpuOnPlan(ctx, st.off as GpuOffRecord | null); kind = 'gpu-on'
        if (st.offRow) (plan.meta ??= {}).fromHistory = st.offRow
        break
      }
      case 'gpu-convert': plan = buildGpuConvertPlan(ctx, await this.inventory(g.node, true)); kind = 'device'; break
      case 'raw': plan = buildRawEditPlan(ctx, input.raw ?? {}); kind = 'raw'; break
      case 'hostpci': plan = buildHostpciPlan(ctx, await this.inventory(g.node, true), input.hostpci ?? {}, await this.guestsOn(g.node)); kind = 'device'; break
      case 'gpu-portable': {
        const all = ((await this.d.pve.get<any[]>('/nodes').catch(() => [])) ?? []).filter(n => n.status === 'online').map(n => String(n.node))
        const eligible = (input.nodes?.length ? input.nodes.filter(n => all.includes(n)) : all)
        const targets = await Promise.all(eligible.map(async n => ({ node: n, inv: await this.inventory(n, true) })))
        rawInvs = targets.map(t => t.inv)
        const det = ctx.running ? await this.gpuDetail(g).catch(() => null) : null
        plan = buildPortableGpuPlan(ctx, targets.filter(t => t.inv.problem || t.inv.devices.some(d => d.kind === 'gpu')), det?.groups ?? null); kind = 'device'
        break
      }
      case 'device': plan = buildDeviceGrantPlan(ctx, await this.inventory(g.node, true), input.device ?? ({} as any)); kind = 'device'; break
      case 'restart': {
        plan = emptyPlan(); kind = 'restart'
        if (!ctx.running) plan.errors.push('The guest is not running; its pending changes apply when it starts.')
        plan.checks.push(ctx.haManaged
          ? 'HA-managed: restarted through HA (requested state stopped, then started), never by a direct stop and start.'
          : 'Restarted with a reboot through the Proxmox API.')
        if (ctx.pendingKeys.length) plan.checks.push(`Applies the pending ${ctx.pendingKeys.join(', ')}`)
        plan.warnings.push(`${ctx.name} is unreachable while it restarts.`)
        // What to verify comes from the server-held preview that was applied, never from the browser.
        const prior = input.after ? this.previews.get(input.after) : undefined
        if (input.after && (!prior || prior.owner !== owner || !prior.used || prior.guest.vmid !== g.vmid)) plan.errors.push('The change this restart should verify is not known (expired, or not applied).')
        plan.deviceChecks = (prior?.plan.deviceChecks ?? []).filter(c => SAFE_DEV_PATH.test(c.path))
        plan.meta = { rawLines: rawLines(ctx.config), after: input.after ?? null }
        break
      }
      default: throw new GuestConfigRefusal('Unknown change kind.', 'refused')
    }
    protect(plan, kind, g.type)
    if (!q.quorate) plan.errors.unshift(q.why)
    // Raw lines: read the file over the node login, refuse a pending section, and hold the exact new bytes.
    let file: Preview['file']
    const rf = plan.rawFile
    if (rf && (rf.remove.length || rf.add.length)) {
      if (g.type !== 'lxc') plan.errors.push('Raw lines are a container feature.')
      else {
        const r = await this.d.shell.run(g.node, readScript(g.node, g.vmid), 20_000).catch(() => null)
        if (!r) plan.errors.push(`Raw lines are written over ${g.node}’s node login, and there is none (or HyperProx is locked). Add one under Settings → Nodes.`)
        else if (r.code !== 0) plan.errors.push(`The config file could not be read on ${g.node}.`)
        else {
          try {
            const { text, sha, leftovers } = parseRead(r.output)
            if (leftovers.length) {
              // An earlier write was interrupted before its trap ran: report it, and remove exactly those files.
              const c = await this.d.shell.run(g.node, cleanupScript(g.node, g.vmid, leftovers), 20_000).catch(() => null)
              const ok = !!c && /HPX-CLEANED/.test(c.output)
              plan.warnings.push(`An earlier interrupted write left ${leftovers.length} temp file(s) beside this guest’s config (${leftovers.map(x => x.split('/').pop()).join(', ')}); ${ok ? 'they were removed' : 'they could not be removed and are still there'}.`)
              await this.d.audit('guest_config.clean_temp', `${g.type}/${g.vmid}`, { node: g.node, files: leftovers.length, removed: ok }).catch(() => {})
            }
            if (splitConf(text).hasPending) plan.errors.push('The config file has a [pve:pending] section; restart the guest (so it applies) before changing raw lines.')
            else {
              const sources = addedSources(rf.add)
              if (rf.add.length) await this.checkAddedRaw(g, rf.add, sources, rawInvs, plan)
              const after = rewriteRawLines(text, rf)
              file = { sha, before: text, after, sources }
              plan.expectRaw = splitConf(after).rawMain
            }
          } catch (e: any) { plan.errors.push(String(e?.message ?? e)) }
        }
      }
    }
    if (ctx.config.lock) plan.errors.push(`The guest is locked (${str(ctx.config.lock)}); Proxmox refuses config changes until that finishes.`)
    if (kind !== 'restart' && !plan.ops.length && !file && !plan.errors.length) plan.errors.push('Nothing to change.')
    const keys = keyInventory(g.type, ctx.config)
    plan.checks.unshift(`${keys.raw.length} raw line(s) and ${keys.unknown.length} unmodelled key(s) are kept as they are and counted again after the write`)
    if (ctx.pendingKeys.length && kind !== 'restart') plan.checks.push(`Already waiting for a restart: ${ctx.pendingKeys.join(', ')}`)
    const now = this.d.now()
    const p: Preview = {
      id: randomUUID(), owner, guest: { ...g, name: ctx.name, running: ctx.running, haManaged: ctx.haManaged }, input, kind, plan,
      digest: str(ctx.config.digest), before: ctx.config, counts: { raw: keys.raw.length, unknown: keys.unknown.length },
      pendingBefore: ctx.pendingKeys, file, quorate: q.quorate, createdAt: now, expiresAt: now + PREVIEW_TTL_MS, used: false,
    }
    this.previews.set(p.id, p)
    return p
  }

  shell(): NodeShell { return this.d.shell }

  /** HA-managed containers with GPU entries, where they run now. For the move watcher. */
  async haGpuGuests(): Promise<Array<{ vmid: number; name: string; node: string; status: string }>> {
    const [res, ha] = await Promise.all([this.d.pve.get<any[]>('/cluster/resources?type=vm'), this.d.pve.get<any[]>('/cluster/ha/resources').catch(() => [] as any[])])
    const sids = new Set((ha ?? []).map(r => r.sid))
    const cts = (res ?? []).filter(r => r.type === 'lxc' && sids.has(`ct:${r.vmid}`))
    const out: Array<{ vmid: number; name: string; node: string; status: string }> = []
    for (const r of cts) {
      const cfg = await this.d.pve.get<PveConfig>(`/nodes/${encodeURIComponent(r.node)}/lxc/${r.vmid}/config`).catch(() => null)
      if (cfg && detectGpu('lxc', cfg).entries.length) out.push({ vmid: Number(r.vmid), name: str(r.name), node: r.node, status: r.status })
    }
    return out
  }

  async historyOf(g: GuestId, limit = 100): Promise<HistoryRow[]> { return this.d.history.list(`${g.type}/${g.vmid}`, limit) }

  /** One secret value of a guest config (the route needs the master password re-entered). Audited, never the value. */
  async reveal(actor: string, g: GuestId, key: string): Promise<string | null> {
    if (!isSecretKey(key)) throw new GuestConfigRefusal('Only secret keys are revealed here; the rest are shown already.', 'refused')
    if (g.type === 'qemu' && key === 'cipassword') throw new GuestConfigRefusal('Proxmox never returns a VM’s cloud-init password (its API answers with a mask), so it cannot be shown. It can only be set again.', 'refused')
    const cfg = await this.d.pve.get<PveConfig>(`${this.base(g)}/config`)
    await this.d.audit('guest_config.reveal', `${g.type}/${g.vmid}`, { by: actor, node: g.node, key }).catch(() => {})
    const v = cfg?.[key] === undefined ? null : str(cfg[key])
    if (v !== null && /^\*+$/.test(v)) throw new GuestConfigRefusal('Proxmox returns this value masked, so it cannot be shown.', 'refused')
    return v
  }

  getPreview(owner: string, id: string): Preview | null {
    const p = this.previews.get(id)
    return p && p.owner === owner ? p : null
  }

  private prune() { const now = this.d.now(); for (const [k, p] of this.previews) if (p.expiresAt < now) this.previews.delete(k) }

  // ── apply ──────────────────────────────────────────────────────────────────

  async apply(owner: string, id: string, confirm: { name?: string; acks?: string[] } = {}): Promise<ApplyResult> {
    if (this.applying.has(id)) throw new GuestConfigRefusal('This preview is being applied already.', 'used')
    this.applying.add(id)
    try {
      const p = this.previews.get(id)
      if (!p || !owner || p.owner !== owner) throw new GuestConfigRefusal('No such preview.', 'not-found')
      if (p.used) throw new GuestConfigRefusal('This preview was already applied. Make a new one.', 'used')
      if (this.d.now() > p.expiresAt) throw new GuestConfigRefusal('This preview has expired. Review the change again.', 'expired')
      if (p.plan.errors.length) throw new GuestConfigRefusal('This preview has problems, so nothing was written.', 'refused', p.plan.errors)
      const missing = p.plan.extraConfirm.filter(a => !(confirm.acks ?? []).includes(a))
      if (missing.length) throw new GuestConfigRefusal(`This change needs an extra confirmation: ${missing.join(', ')}.`, 'confirm', missing)
      if (p.plan.confirmName && confirm.name !== p.guest.name && confirm.name !== String(p.guest.vmid))
        throw new GuestConfigRefusal(`Type the guest’s name (${p.guest.name}) to confirm.`, 'confirm')
      p.used = true

      const q = await this.quorum()
      if (!q.quorate) throw new GuestConfigRefusal(q.why, 'not-quorate')
      const fresh = await this.d.pve.get<PveConfig>(`${this.base(p.guest)}/config`)
      if (str(fresh?.digest) !== p.digest) throw new GuestConfigRefusal('The config changed since the preview (someone or something else edited it), so nothing was written. Review it again.', 'changed')

      if (p.kind === 'restart') return await this.applyRestart(p, owner)

      let digest = p.digest
      const steps: string[] = []
      let failed: string | null = null
      let fileAfter: string | null = null
      if (p.file) {
        // Compare and swap: the file must still be the one previewed, checked here and again on the node.
        const r = await this.d.shell.run(p.guest.node, readScript(p.guest.node, p.guest.vmid), 20_000).catch(() => null)
        if (!r || r.code !== 0) throw new GuestConfigRefusal('The config file could not be read on the node, so nothing was written.', 'refused')
        const now = parseRead(r.output)
        if (now.sha !== p.file.sha) throw new GuestConfigRefusal('The config file changed since the preview, so nothing was written. Review it again.', 'changed')
        if (splitConf(now.text).hasPending) throw new GuestConfigRefusal('The config file now has a [pve:pending] section, so nothing was written.', 'changed')
        const q2 = await this.quorum()
        if (!q2.quorate) throw new GuestConfigRefusal(q2.why, 'not-quorate')
        let w: { code: number; output: string } | null = null
        let dropped: string | null = null
        try { w = await this.d.shell.run(p.guest.node, writeScript(p.guest.node, p.guest.vmid, p.file.sha, p.file.after, p.file.sources), 30_000) }
        catch (e: any) { dropped = String(e?.message ?? e) }
        if (w && /HPX-CAS-MISMATCH/.test(w.output)) throw new GuestConfigRefusal('The config file changed at the last moment, so nothing was written. Review it again.', 'changed')
        if (w && /HPX-GUEST-LOCKED/.test(w.output)) throw new GuestConfigRefusal('The guest was locked (a backup, migration or snapshot) at the last moment, so nothing was written.', 'changed')
        if (w && /HPX-PENDING/.test(w.output)) throw new GuestConfigRefusal('The config file gained a [pve:pending] section at the last moment, so nothing was written.', 'changed')
        if (w && /HPX-BAD-DEVICE/.test(w.output)) throw new GuestConfigRefusal(`On ${p.guest.node}, ${/HPX-BAD-DEVICE (\S+)/.exec(w.output)?.[1] ?? 'a device'} is no longer a plain character device (a symlink, or something else), so nothing was written.`, 'refused')
        if (w && /HPX-LOCK-TIMEOUT/.test(w.output)) throw new GuestConfigRefusal('Proxmox held this guest’s config lock for more than 10 seconds, so nothing was written. Try again.', 'refused')
        let back: { text: string } | null = null
        if (w && w.code === 0) { try { back = parseRead(w.output) } catch { back = null } }
        if (!back) {
          // The session dropped, or the answer was cut off: what is on the node now decides, not the error.
          // Under the config lock, so a write still running on the node finishes (or gives up) before this read.
          const rr = await this.d.shell.run(p.guest.node, readScript(p.guest.node, p.guest.vmid, { locked: true }), 30_000).catch(() => null)
          try { if (rr && rr.code === 0) back = parseRead(rr.output) } catch { back = null }
          if (back && sha256(back.text) === sha256(p.file.after)) steps.push(`the node session ${dropped ? 'dropped' : 'ended badly'} after the write; a fresh read shows the planned file`)
        }
        if (!back) failed = `the config file could not be read back on ${p.guest.node}${dropped ? ` (${dropped})` : ''}`
        else {
          fileAfter = back.text
          if (back.text !== p.file.after) failed = sha256(back.text) === p.file.sha ? `the config file write failed on ${p.guest.node}; the file is unchanged` : 'the config file read back is not byte for byte the planned file'
          else {
            steps.push('raw lines written (whole file, compared and swapped under the config lock)')
            // GPU off: what was removed from the file is recorded now, before any devN step can fail, so GPU on can
            // always put it back.
            if (p.kind === 'gpu-off') await this.recordGpuOff(p, null, true).catch(() => {})
          }
        }
        // Proxmox must still parse it, and the API's digest moves on.
        const parsed = await this.d.pve.get<PveConfig>(`${this.base(p.guest)}/config`).catch(() => null)
        if (!parsed) failed ??= 'Proxmox could not read the config after the write'
        digest = str(parsed?.digest)
      }
      for (const op of failed ? [] : p.plan.ops) {
        try {
          let res: unknown
          if (op.kind === 'config') {
            const params: Record<string, string> = { ...op.set, digest }
            if (op.delete.length) params.delete = op.delete.join(',')
            res = await this.d.pve.put(`${this.base(p.guest)}/config`, params)
          } else {
            res = await this.d.pve.put(`${this.base(p.guest)}/resize`, { disk: op.disk, size: op.size, digest })
          }
          if (typeof res === 'string' && res.startsWith('UPID:')) await this.waitTask(res)
          steps.push(op.kind === 'config' ? 'config written' : `${op.disk} resized`)
          digest = str((await this.d.pve.get<PveConfig>(`${this.base(p.guest)}/config`))?.digest)
        } catch (e: any) { failed = String(e?.message ?? e); break }
      }

      const after = await this.d.pve.get<PveConfig>(`${this.base(p.guest)}/config`).catch(() => null)
      const pending = await this.d.pve.get<PendingRow[]>(`${this.base(p.guest)}/pending`).catch(() => [] as PendingRow[])
      const outcome = after ? verifyOutcome(p.guest.type, p.before, after, pending ?? [], p.plan) : null
      const problems = [...(failed ? [`Proxmox refused a step: ${failed}`] : []), ...(outcome?.problems ?? []), ...(after ? [] : ['The config could not be read back after the write'])]
      const ok = !failed && !!outcome?.ok
      const row = await this.record(p, owner, after, ok, problems, steps, fileAfter)
      if (ok) await this.updateGpuState(p, row?.id ?? null).catch(e => problems.push(`The GPU toggle state could not be stored: ${e?.message ?? e}`))
      const pendingKeys = outcome?.pendingKeys ?? []
      return {
        ok, outcome: outcome ? { ...outcome, problems, ok } : null, pendingKeys,
        restartOffered: p.guest.running && (pendingKeys.length > 0 || !!p.file), historyId: row?.id ?? null,
      }
    } finally { this.applying.delete(id) }
  }

  private async record(p: Preview, owner: string, after: PveConfig | null, ok: boolean, problems: string[], steps: string[], fileAfter: string | null = null): Promise<HistoryRow | null> {
    const tag = p.kind === 'gpu-off' ? 'GPU off' : p.kind === 'gpu-on' ? 'GPU on' : p.kind === 'revert' ? 'Revert' : p.kind === 'restart' ? 'Restart' : null
    const resource = `${p.guest.type}/${p.guest.vmid}`
    let row: HistoryRow | null = null
    try {
      row = await this.d.history.add({
        guest: resource, node: p.guest.node, kind: p.kind, tag, actor: owner, previewId: p.id,
        before: p.before, after, changes: p.plan.changes.map(c => ({ key: c.key, words: redactText(c.words) })),
        outcome: ok ? 'ok' : 'failed', problems: problems.map(redactText),
        meta: await this.historyMeta(p, after, fileAfter),
      })
    } catch (e: any) { problems.push(`The change was made but its history row could not be stored: ${e?.message ?? e}`) }
    await this.d.audit('guest_config.apply', resource, {
      by: owner, node: p.guest.node, kind: p.kind, previewId: p.id, outcome: ok ? 'ok' : 'failed',
      keys: p.plan.touched, steps, problems,
    }).catch(() => { /* the history row is the record; an audit outage must not hide the outcome */ })
    return row
  }

  /**
   * The meta a history row keeps: the plan's own, the redacted config files for a whole-file write, and HMACs of
   * every raw line before and after (never a plain hash of anything unredacted).
   */
  private async historyMeta(p: Preview, after: PveConfig | null, fileAfter: string | null): Promise<Record<string, unknown> | null> {
    const m: Record<string, unknown> = { ...(p.plan.meta ?? {}) }
    if (p.guest.type === 'lxc') {
      const b = p.file ? splitConf(p.file.before).rawMain : rawLines(p.before)
      const a = fileAfter ? splitConf(fileAfter).rawMain : after ? rawLines(after) : null
      m.rawHmac = { before: await this.hmacs(b), after: a ? await this.hmacs(a) : null }
    }
    if (p.file) { m.fileBefore = redactConfFile(p.file.before); m.fileAfter = redactConfFile(fileAfter ?? p.file.after) }
    return Object.keys(m).length ? m : null
  }

  private hmacKeyCache: Buffer | null = null
  private hmacKeyLoading: Promise<Buffer> | null = null
  /** Drop key material held in memory (called when the vault locks). */
  forgetKeys(): void { this.hmacKeyCache = null; this.hmacKeyLoading = null }
  private async hmacs(lines: Array<[string, string]>): Promise<string[]> {
    if (!this.hmacKeyCache) {
      // One load at a time: concurrent first uses share it instead of each creating a key.
      this.hmacKeyLoading ??= (this.d.hmacKey ? this.d.hmacKey() : Promise.resolve(randomBytes(32))).finally(() => { this.hmacKeyLoading = null })
      this.hmacKeyCache = await this.hmacKeyLoading
    }
    return lines.map(([k, v]) => createHmac('sha256', this.hmacKeyCache!).update(`${k}\u0000${v}`).digest('hex'))
  }

  async gpuState(g: GuestId, cfg: PveConfig): Promise<GpuState> { return this.d.history.getGpu(gpuKey(g, cfg)) }

  /** Record a GPU off: `partial` when only the raw-line step has landed so far (the devN step is still to come). */
  private async recordGpuOff(p: Preview, rowId: string | null, partial: boolean): Promise<void> {
    const rec = (p.plan.meta as any)?.gpuOff
    if (!rec) return
    await this.d.history.updateGpu(gpuKey(p.guest, p.before), st => {
      st.off = partial ? { removed: {}, rawRemoved: rec.rawRemoved ?? [], kept: rec.kept ?? [] } : rec
      st.offAt = new Date(this.d.now()); if (rowId) st.offRow = rowId
      return st
    })
  }

  /** Keep the GPU toggle state in step with a successful write, in one transaction. */
  private async updateGpuState(p: Preview, rowId: string | null): Promise<void> {
    const m = (p.plan.meta ?? {}) as any
    if (!m.gpuManaged && !m.gpuManagedRaw && p.kind !== 'gpu-off' && p.kind !== 'gpu-on') return
    if (p.kind === 'gpu-off') return this.recordGpuOff(p, rowId, false)
    await this.d.history.updateGpu(gpuKey(p.guest, p.before), st => {
      if (m.gpuManaged) Object.assign(st.dev, m.gpuManaged)
      for (const l of (m.gpuManagedRaw ?? []) as Array<[string, string]>) if (!st.raw.some(r => r[0] === l[0] && r[1] === l[1])) st.raw.push([l[0], l[1]])
      if (p.kind === 'gpu-on') { st.off = null; st.offAt = null; st.offRow = null }
      return st
    })
  }

  /**
   * Added raw lines: each must pass the allowlist against the node inventories (character devices that are not
   * symlinks, their majors), and every mount source is looked at on the node itself: a character device whose
   * realpath is itself, or one of the GPU device directories. A device the node lacks may only be named by an
   * optional entry, and only if another eligible node's inventory has it.
   */
  private async checkAddedRaw(g: GuestId, add: Array<[string, string]>, sources: string[], invs: NodeInventory[] | null, plan: Plan): Promise<void> {
    const list = invs ?? [await this.inventory(g.node).catch(() => null)].filter((x): x is NodeInventory => !!x)
    const allow = allowFrom(list)
    for (const l of add) { const why = rawLineAllowed(l, allow); if (why) plan.errors.push(why) }
    if (!sources.length || plan.errors.length) return
    const r = await this.d.shell.run(g.node, verifyScript(sources), 20_000).catch(() => null)
    if (!r) { plan.errors.push(`The devices could not be checked on ${g.node} (no node login).`); return }
    const v = parseVerify(r.output)
    const here = list.find(i => i.node === g.node)
    for (const src of sources) {
      const x = v[src]
      const line = add.find(([k, val]) => k === 'lxc.mount.entry' && val.trim().split(/\s+/)[0] === src)!
      const optional = /(^|,)optional(,|$)/.test(line[1].trim().split(/\s+/)[3] ?? '')
      if (!x) plan.errors.push(`${src} could not be checked on ${g.node}.`)
      else if (x.kind === 'symlink') plan.errors.push(`${src} is a symlink on ${g.node}; only the device node itself may be bound.`)
      else if (x.kind === 'other') plan.errors.push(`${src} on ${g.node} is not a character device (a block device or a file), so it is refused.`)
      else if (x.kind === 'char' && x.real !== src) plan.errors.push(`${src} resolves to ${x.real} on ${g.node}; only the device node itself may be bound.`)
      else if (x.kind === 'char' && here?.charDevices && here.charDevices[src] === undefined) plan.errors.push(`${src} is not in ${g.node}’s device inventory, so it is refused.`)
      else if (x.kind === 'dir' && (!DEVICE_DIRS.includes(src) || x.real !== src)) plan.errors.push(`${src} is a directory; only ${DEVICE_DIRS.join(' and ')} may be bound.`)
      else if (x.kind === 'missing' && !optional) plan.errors.push(`${src} does not exist on ${g.node}; only an optional entry may name a device another node has.`)
    }
    plan.checks.push(`Every added device was checked on ${g.node}: a character device (or GPU device directory), not a symlink, its own real path`)
  }

  /** Poll a task by UPID until it stops; its exit status is read, a task that never finishes is reported. */
  async waitTask(upid: string): Promise<void> {
    const node = upid.split(':')[1]
    const path = `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`
    for (let waited = 0; ; waited += this.d.timeouts.pollMs) {
      const st = await this.d.pve.get<{ status: string; exitstatus?: string }>(path)
      if (st?.status === 'stopped') {
        if (st.exitstatus === 'OK' || /^WARNINGS: /.test(st.exitstatus ?? '')) return
        throw new Error(`task ${upid} failed: ${st.exitstatus ?? 'unknown'}`)
      }
      if (waited >= this.d.timeouts.taskMs) throw new Error(`task ${upid} did not finish within ${Math.round(this.d.timeouts.taskMs / 1000)}s`)
      await this.d.sleep(this.d.timeouts.pollMs)
    }
  }

  private async waitStatus(g: GuestId, want: 'running' | 'stopped'): Promise<boolean> {
    for (let waited = 0; waited <= this.d.timeouts.haMs; waited += this.d.timeouts.pollMs) {
      const st = await this.d.pve.get<any>(`${this.base(g)}/status/current`).catch(() => null)
      if (st?.status === want) return true
      await this.d.sleep(this.d.timeouts.pollMs)
    }
    return false
  }

  private async applyRestart(p: Preview, owner: string): Promise<ApplyResult> {
    const g = p.guest
    const r: RestartResult = { via: g.haManaged ? 'ha' : 'direct', ok: false, steps: [], pendingAfter: [], rawSurvived: null, devices: [], problems: [] }
    try {
      if (g.haManaged) {
        const sid = `${g.type === 'qemu' ? 'vm' : 'ct'}:${g.vmid}`
        await this.d.pve.put(`/cluster/ha/resources/${encodeURIComponent(sid)}`, { state: 'stopped' })
        r.steps.push(`HA ${sid}: requested state stopped`)
        if (!(await this.waitStatus(g, 'stopped'))) throw new Error('HA did not stop the guest in time; its requested state is left at stopped, start it from HA once it settles')
        r.steps.push('stopped')
        await this.d.pve.put(`/cluster/ha/resources/${encodeURIComponent(sid)}`, { state: 'started' })
        r.steps.push(`HA ${sid}: requested state started`)
        if (!(await this.waitStatus(g, 'running'))) throw new Error('HA did not start the guest in time')
        r.steps.push('running')
      } else {
        const upid = await this.d.pve.post<string>(`${this.base(g)}/status/reboot`, {})
        if (typeof upid === 'string' && upid.startsWith('UPID:')) await this.waitTask(upid)
        r.steps.push('rebooted')
        if (!(await this.waitStatus(g, 'running'))) throw new Error('The guest did not come back up in time')
      }
    } catch (e: any) { r.problems.push(String(e?.message ?? e)) }

    // Outcome, not self-report: the pending block is gone, the raw lines are the same lines, the devices are (not) there.
    const after = await this.d.pve.get<PveConfig>(`${this.base(g)}/config`).catch(() => null)
    const pending = await this.d.pve.get<PendingRow[]>(`${this.base(g)}/pending`).catch(() => [] as PendingRow[])
    r.pendingAfter = pendingKeysOf(pending)
    if (r.pendingAfter.length) r.problems.push(`Still pending after the restart: ${r.pendingAfter.join(', ')}`)
    const expectRaw = ((p.plan.meta as any)?.rawLines ?? []) as Array<[string, string]>
    if (after) {
      r.rawSurvived = JSON.stringify(rawLines(after)) === JSON.stringify(expectRaw)
      if (!r.rawSurvived) r.problems.push(`The raw lxc.* lines changed across the restart: ${expectRaw.length} before, ${rawLines(after).length} after`)
    } else r.problems.push('The config could not be read back after the restart')
    if (p.plan.deviceChecks.length && g.type === 'lxc') {
      const list = p.plan.deviceChecks.map(c => `'${c.path}'`).join(' ')
      const out = await this.d.shell.run(g.node, `pct exec ${g.vmid} -- sh -c 'for p in "$@"; do if [ -c "$p" ]; then echo "Y $p"; else echo "N $p"; fi; done' sh ${list}`, 20_000).catch(() => null)
      for (const c of p.plan.deviceChecks) {
        const seen = out ? (out.output.includes(`Y ${c.path}`) ? true : out.output.includes(`N ${c.path}`) ? false : null) : null
        r.devices.push({ path: c.path, expected: c.present, seen })
        if (seen === null) r.problems.push(`Could not look inside the container for ${c.path}${out ? '' : ' (no node login)'}`)
        else if (seen !== c.present) r.problems.push(`${c.path} is ${seen ? 'still visible' : 'not visible'} inside the container`)
      }
    }
    r.ok = r.problems.length === 0
    const row = await this.record(p, owner, after, r.ok, r.problems, r.steps)
    return { ok: r.ok, outcome: null, pendingKeys: r.pendingAfter, restartOffered: false, historyId: row?.id ?? null, restart: r }
  }

  // ── the Infrastructure list ────────────────────────────────────────────────

  async overview() {
    const [res, haRes, haStatus] = await Promise.all([
      this.d.pve.get<any[]>('/cluster/resources?type=vm'),
      this.d.pve.get<any[]>('/cluster/ha/resources').catch(() => [] as any[]),
      this.d.pve.get<any[]>('/cluster/ha/status/current').catch(() => [] as any[]),
    ])
    const guests = (res ?? []).filter(r => r.type === 'lxc' || r.type === 'qemu')
    const configs = await Promise.all(guests.map(x => this.d.pve.get<PveConfig>(`/nodes/${encodeURIComponent(x.node)}/${x.type}/${x.vmid}/config`).catch(() => null)))
    const invs = new Map<string, NodeInventory | null>()
    for (const n of new Set(guests.map(x => x.node as string))) { const hit = this.inv.get(n); invs.set(n, hit ? hit.inv : null) }
    // The GPU toggle state needs the guest's history: an "off" with nothing turned back on since.
    const states = new Map((await this.d.history.listGpu().catch(() => [] as GpuState[])).map(st => [st.guest, st]))
    const offs = guests.map((x, i) => !!states.get(gpuKey({ type: x.type, vmid: Number(x.vmid) }, configs[i] ?? {}))?.off)
    const vpn = await vpnStatuses(guests.map(x => ({ node: x.node, type: x.type, vmid: Number(x.vmid), name: x.name })), this.d.vpn ?? vpnStatusSource())
    return guests.map((x, i) => {
      const cfg = configs[i] ?? {}
      const sid = `${x.type === 'qemu' ? 'vm' : 'ct'}:${x.vmid}`
      const ha = (haRes ?? []).find(r => r.sid === sid)
      const hs = (haStatus ?? []).find(r => r.sid === sid || r.id === `service:${sid}`)
      const gpu = configs[i] ? detectGpu(x.type, cfg, invs.get(x.node)) : { vendors: [], entries: [], rawCount: 0 }
      return {
        vmid: Number(x.vmid), type: x.type, node: x.node, name: x.name ?? str(cfg.hostname ?? cfg.name), status: x.status,
        template: Number(x.template ?? 0) === 1, lock: x.lock ?? null,
        cpu: x.cpu ?? 0, maxcpu: x.maxcpu ?? 0, mem: x.mem ?? 0, maxmem: x.maxmem ?? 0, disk: x.disk ?? 0, maxdisk: x.maxdisk ?? 0, uptime: x.uptime ?? 0,
        tags: str(x.tags ?? cfg.tags).split(/[;, ]+/).filter(Boolean),
        ip: ipOf(x.type, cfg),
        ha: ha ? { managed: true, state: ha.state ?? 'started', status: hs?.status ?? hs?.state ?? null } : { managed: false },
        gpu: {
          vendors: gpu.vendors, via: [...new Set(gpu.entries.map(e => e.via))],
          toggle: gpu.entries.some(e => e.via === 'devN') ? 'on' : offs[i] ? 'off' : gpu.entries.length ? 'raw-only' : 'none',
        },
        pending: false,
        vpn: vpn.get(`${x.type}/${x.vmid}` as any) ?? { state: 'not-available' },
      }
    })
  }
}

export function ipOf(type: GuestType, cfg: PveConfig): string | null {
  for (const [k, v] of Object.entries(cfg)) {
    if (type === 'lxc' && /^net\d+$/.test(k)) { const ip = /(?:^|,)ip=([^,]+)/.exec(str(v))?.[1]; if (ip && ip !== 'dhcp' && ip !== 'manual') return ip.split('/')[0]; if (ip === 'dhcp') return 'dhcp' }
    if (type === 'qemu' && /^ipconfig\d+$/.test(k)) { const ip = /(?:^|,)ip=([^,]+)/.exec(str(v))?.[1]; if (ip && ip !== 'dhcp') return ip.split('/')[0] }
  }
  return null
}

/**
 * The GPU state key: type, VMID and the guest's creation identity (a container's NIC MACs, a VM's SMBIOS UUID or
 * generation ID), so a reused VMID never inherits another guest's GPU state.
 */
export function gpuKey(g: { type: GuestType; vmid: number }, cfg: PveConfig): string {
  let id = ''
  if (g.type === 'qemu') id = /uuid=([0-9a-f-]+)/i.exec(str(cfg.smbios1))?.[1] ?? str(cfg.vmgenid) ?? ''
  else id = Object.keys(cfg).filter(k => /^net\d+$/.test(k)).sort().map(k => /hwaddr=([0-9A-Fa-f:]+)/.exec(str(cfg[k]))?.[1] ?? '').join(',')
  if (!id) id = str(cfg.rootfs ?? cfg.scsi0 ?? '').split(',')[0]
  return `${g.type}/${g.vmid}/${sha256(id).slice(0, 16)}`
}

/** What an added raw line may name: inventory character devices (not symlinks) and their majors, plus GPU majors. */
export function allowFrom(invs: NodeInventory[]): RawAllow {
  const devices = new Set<string>(), majors = new Set<number>()
  for (const inv of invs) {
    const chars = inv.charDevices ?? {}
    const listed = new Set([...inv.devices.flatMap(d => d.paths), ...inv.nvidiaNodes])
    for (const [p, maj] of Object.entries(chars)) if (listed.has(p)) { devices.add(p); majors.add(maj) }
    if (Object.keys(inv.majors).length) for (const [maj, x] of gpuMajors(inv.majors)) if (!x.assumed) majors.add(maj)
  }
  return { devices, majors }
}
