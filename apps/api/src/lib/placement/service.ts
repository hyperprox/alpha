// =============================================================================
//  HyperProx — placement advisor: the service
//
//  Reads (the map, the advice, one guest), the move check, the move itself,
//  the history and the scheduler for moves held until the next quiet window.
//
//  A move, in order:
//    1. the slot: one move at a time, taken synchronously in this process before
//       anything is awaited, and again in the database (at most one row running
//       or stuck, a partial unique index), so two requests or two processes
//       cannot both start one;
//    2. the check again, server side: the engine's verdict for that target (an
//       unread config or task log is "unknown", which refuses), Proxmox's own
//       migrate preconditions, the quiet window over the move's whole estimated
//       length;
//    3. the audit row (no row, no move);
//    4. the Proxmox call. An HA guest goes through HA
//       (POST /cluster/ha/resources/{sid}/migrate, what ha-manager migrate does):
//       a plain migrate is refused for HA guests, and HA would put it back.
//       Anything else: POST /nodes/{node}/{type}/{vmid}/migrate, form-encoded,
//       with restart=1 for a running container, online=1 for a running VM,
//       with-local-disks=1 when it has local disks, and the bandwidth limit;
//    5. wait for the task to stop, then read the cluster back: the guest must be
//       on the target (and running, if it was). Only then is it "done". A task
//       that outlives the wait, or an HA move still in progress, is "stuck": the
//       slot stays held, an alert goes out, and HyperProx keeps watching until
//       Proxmox shows it finished;
//    6. corosync's log around the move, when a node login is stored.
//
//  Scheduling: a move outside a quiet window can be held for the next one. It
//  is a database row with the settings in force when it was approved, and it
//  runs under those. A timer claims it atomically (scheduled → running), so a
//  cancel and a run cannot both win. Before it runs the whole check is made
//  again, the person who approved it must still be an admin, and the run is
//  audited; otherwise it is skipped with the reason. Locked (a restart locks
//  HyperProx and only a person can unlock), it waits until its window passes.
//
//  Each process has an owner id and beats a heartbeat on the moves it watches.
//  A move whose heartbeat went stale (its process died) is taken over by an
//  atomic claim and watched to its end; a live one is never touched.
// =============================================================================

import { parseSid, sidOf } from '../ha/parse'
import type { HaPve } from '../ha/read'
import type { Sid } from '../ha/types'
import { advise } from './advice'
import { corosyncAround, corosyncWords } from './corosync'
import { checkablePaths, placementMap, type EngineInput } from './engine'
import { copySeconds } from './network'
import { readCluster, readHistory, taskRunning, type ClusterRead, type PromRange } from './read'
import { DEFAULT_SETTINGS, IN_FLIGHT, MoveSlotTaken, mergeSettings, stricterSettings, type PlacementStore } from './store'
import { backupMask, quietStatus, type QuietStatus } from './windows'
import type { Advice, GuestPlacement, MoveRecord, NetworkCost, PlacementMap, PlacementSettings } from './types'

export interface Actor { email: string; role?: string }

export class PlacementRefusal extends Error {
  constructor(message: string, public status = 409, public code = 'refused', public extra: Record<string, unknown> = {}) { super(message) }
}

export interface PlacementDeps {
  pve():      HaPve
  prom:       PromRange
  store:      PlacementStore
  /** The audit row. Throws when it could not be written: the move does not happen without it. */
  audit(action: string, resource: string, details: Record<string, unknown>): Promise<void>
  isUnlocked(): boolean
  /** A read-only command on a node over its stored login; null when there is none. */
  nodeExec(node: string, command: string): Promise<{ code: number; output: string } | null>
  /**
   * Whether the person who approved a scheduled move has been removed or demoted since `sinceMs`, from what
   * HyperProx itself holds (never by borrowing someone else's session). Null: nothing says so. A string: why not.
   */
  approverChanged?(email: string, sinceMs: number): Promise<string | null>
  /** Tells people something needs a look (a stuck move). Never throws. */
  alert?(title: string, lines: string[]): Promise<void>
  /** This process's id for the owner column. */
  ownerId?:   string
  now?():     number
  sleep?(ms: number): Promise<void>
  /** How long to wait for a move's task before calling it stuck (and watching on), ms. */
  taskTimeoutMs?: number
  /** How long a stuck move is watched before HyperProx gives up and says so, ms. */
  watchMs?:   number
  pollMs?:    number
  cacheMs?:   number
}

export interface MovePlan {
  sid: Sid; name: string; type: 'lxc' | 'qemu'; from: string; to: string
  method: 'ha' | 'migrate'
  allowed:   boolean
  refusals:  string[]
  warnings:  string[]
  running:   boolean
  /** Outage in seconds for a container restart; null when it stays up (a live VM move) or is stopped. */
  downtimeSec: number | null
  copyBytes: number
  copySec:   number
  /** It has disks on node-local storage (a VM then needs with-local-disks). */
  localDisks: boolean
  /** The bandwidth limit the move would pass, KiB/s; null for HA (the datacenter limit applies). */
  bwlimitKiB: number | null
  network:   NetworkCost
  quiet:     QuietStatus
  /** Outside a quiet window: "move anyway" or schedule. */
  needsAnyway: boolean
  /** The exact Proxmox call. */
  call:      string
  lastMove:  { at: number; from: string; to: string; words: string } | null
  /** The settings the check used (a scheduled move stores them and runs under them). */
  settings:  PlacementSettings
}

const PATH_OK = /^\/[A-Za-z0-9._/ +-]{0,250}$/
/** A path check is good for this long; after it the verdict is "unknown" again. */
export const PATH_CHECK_TTL_MS = 10 * 60_000
/** A watcher that has not beaten for this long is taken to be dead. */
export const HEARTBEAT_STALE_MS = 5 * 60_000
const HEARTBEAT_EVERY_MS = 30_000
const SYNC_EVERY_MS = 10 * 60_000
/** A scheduled move expires this long after it was approved. */
export const SCHEDULE_TTL_MS = 7 * 24 * 3600_000

export class PlacementService {
  private cache: { at: number; read: Promise<ClusterRead> } | null = null
  private pathChecks: Record<Sid, Record<string, Record<string, boolean | null>>> = {}
  private pathCheckedAt: Record<Sid, number> = {}
  /** The move slot in this process: a token while a request checks, the move's id while it runs. */
  private slot: string | null = null
  private ticking = false
  private lastSync = 0
  private beats = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | null = null
  readonly owner: string
  constructor(private d: PlacementDeps) {
    this.owner = d.ownerId ?? `${process.pid}@${Date.now()}`
  }

  private now() { return this.d.now ? this.d.now() : Date.now() }
  private sleep(ms: number) { return this.d.sleep ? this.d.sleep(ms) : new Promise<void>(r => setTimeout(r, ms)) }
  private poll() { return this.d.pollMs ?? 2000 }

  private read(fresh = false): Promise<ClusterRead> {
    const ttl = this.d.cacheMs ?? 10_000
    if (fresh || !this.cache || this.now() - this.cache.at > ttl) {
      const p = this.d.store.settings().then(s => readCluster(this.d.pve(), { suggestedBwlimit: s.bwlimitKiB, now: this.now() }))
      this.cache = { at: this.now(), read: p }
      p.catch(() => { this.cache = null })
    }
    return this.cache.read
  }

  /** Path checks younger than the TTL only: an old one says nothing about the node now. */
  private freshPathChecks(): EngineInput['pathChecks'] {
    const out: NonNullable<EngineInput['pathChecks']> = {}
    for (const [sid, at] of Object.entries(this.pathCheckedAt)) if (this.now() - at < PATH_CHECK_TTL_MS && this.pathChecks[sid]) out[sid] = this.pathChecks[sid]
    return out
  }

  private engineInput(r: ClusterRead, s: PlacementSettings): EngineInput {
    return { ...r.input, network: r.network, settings: { linkMbps: s.linkMbps, bwlimitKiB: s.bwlimitKiB }, pathChecks: this.freshPathChecks(), now: this.now() }
  }

  async settings(): Promise<PlacementSettings> { return this.d.store.settings() }

  async saveSettings(body: unknown, actor: Actor): Promise<PlacementSettings> {
    const { settings, problems } = mergeSettings(await this.d.store.settings(), body)
    if (problems.length) throw new PlacementRefusal(problems.join(' '), 400, 'invalid')
    await this.d.audit('placement.settings', 'placement', { by: actor.email, avoidBackups: settings.avoidBackups, busyHours: settings.busyHours.length, bwlimitKiB: settings.bwlimitKiB })
    await this.d.store.saveSettings(settings, actor.email)
    this.cache = null
    return settings
  }

  async map(): Promise<{ map: PlacementMap; quiet: QuietStatus; settings: PlacementSettings; jobs: ClusterRead['jobs'] }> {
    const s = await this.d.store.settings()
    const r = await this.read()
    const map = placementMap(this.engineInput(r, s))
    const quiet = quietStatus({ now: this.now(), tz: r.tz, jobs: r.jobs, settings: s, jobsRead: r.jobsRead })
    for (const u of quiet.unread) if (!map.unread.includes(u)) map.unread.push(u)
    return { map, quiet, settings: s, jobs: r.jobs }
  }

  async advice(): Promise<Advice> {
    const s = await this.d.store.settings()
    const r = await this.read()
    const map = placementMap(this.engineInput(r, s))
    let hist: Awaited<ReturnType<typeof readHistory>>
    try { hist = await readHistory(this.d.prom, { hours: s.windowHours, now: this.now(), guests: map.guests.map(g => g.sid) }) }
    catch (e: any) {
      return {
        balanced: false, headline: 'No history: Prometheus could not be read, so HyperProx cannot tell sustained load from a spike.',
        pressure: [], suggestions: [], stuck: [], evidence: [], unread: [`Prometheus (${String(e?.message ?? e).slice(0, 80)})`],
        window: { hours: s.windowHours, stepSec: 0, cpuAbove: s.cpuAbove, memAbove: s.memAbove, minHours: s.minHours, backupHoursSkipped: 0 },
      }
    }
    // Backup windows are always left out here, whatever the move setting says: a nightly backup is not imbalance.
    const mask = backupMask({ tz: r.tz, jobs: r.jobs, backupHours: s.backupHours })
    const memo = new Map<number, boolean>()
    const masked = (t: number) => { let v = memo.get(t); if (v === undefined) { v = mask(t); memo.set(t, v) } return v }
    const a = advise({ map, nodes: hist.nodes, guests: hist.guests, masked, settings: s, stepSec: hist.stepSec, unread: [] })
    a.unread.unshift(...map.unread)
    return a
  }

  /** One guest: its placement, its moves, and the last one in words. Reads only (the history sync runs on the timer). */
  async guest(sid: Sid): Promise<{ placement: GuestPlacement; moves: MoveRecord[]; lastMove: MovePlan['lastMove'] }> {
    const { map } = await this.map()
    const g = map.guests.find(x => x.sid === sid)
    if (!g) throw new PlacementRefusal(`There is no guest ${sid}.`, 404, 'not-found')
    const moves = await this.d.store.list({ sid, limit: 20 })
    return { placement: g, moves, lastMove: lastMoveOf(moves) }
  }

  /**
   * Checks whether each shared=1 bind-mount path and /dev/dri device of the guest exists on every node, over the node
   * logins. Read-only (`test -e`); a node without a login stays "unknown". Good for PATH_CHECK_TTL_MS.
   */
  async checkPaths(sid: Sid, actor: Actor): Promise<Record<string, Record<string, boolean | null>>> {
    const r = await this.read()
    const g = r.input.snap.guests.find(x => x.sid === sid)
    if (!g) throw new PlacementRefusal(`There is no guest ${sid}.`, 404, 'not-found')
    const paths = checkablePaths(g.hardware).filter(p => PATH_OK.test(p) && !p.includes('..'))
    const out: Record<string, Record<string, boolean | null>> = {}
    for (const n of r.input.snap.nodes) {
      out[n.node] = {}
      for (const p of paths) {
        const res = n.online ? await this.d.nodeExec(n.node, `test -e '${p}' && echo present || echo absent`).catch(() => null) : null
        out[n.node][p] = !res || res.code !== 0 ? null : /present/.test(res.output) ? true : /absent/.test(res.output) ? false : null
      }
    }
    await this.d.audit('placement.path-check', sid, { by: actor.email, paths: paths.length, nodes: Object.keys(out) })
    this.pathChecks[sid] = out
    this.pathCheckedAt[sid] = this.now()
    return out
  }

  async plan(sid: Sid, to: string, opts: { bwlimitKiB?: number; settings?: PlacementSettings } = {}, fresh = true): Promise<MovePlan> {
    const s = opts.settings ?? await this.d.store.settings()
    const r = await this.read(fresh)
    const map = placementMap(this.engineInput(r, s))
    const g = map.guests.find(x => x.sid === sid)
    if (!g) throw new PlacementRefusal(`There is no guest ${sid}.`, 404, 'not-found')
    if (!map.nodes.some(n => n.node === to)) throw new PlacementRefusal(`There is no node ${to}.`, 404, 'not-found')
    const refusals: string[] = [], warnings: string[] = []
    if (g.node === to) refusals.push(`It is already on ${to}.`)
    for (const x of g.everywhere) {
      if (x.level === 'block') refusals.push(x.words)
      else if (x.level === 'unknown') refusals.push(`Not known: ${x.words}`)
      else if (x.level === 'warn') warnings.push(x.words)
    }
    const t = g.targets.find(x => x.node === to)
    for (const x of t?.reasons ?? []) {
      if (x.level === 'block') refusals.push(x.words)
      else if (x.level === 'unknown') refusals.push(`Not checked: ${x.words} Check it first; HyperProx does not move a guest on a guess.`)
      else if (x.level === 'warn') warnings.push(x.words)
    }
    // Proxmox's own answer for this guest, as the last word.
    const p = parseSid(sid)!
    if (!refusals.length) {
      const pre = await this.d.pve().fetchStrict<any>(`/nodes/${encodeURIComponent(g.node)}/${p.type}/${p.vmid}/migrate`).catch((e: any) => ({ __error: String(e?.message ?? e) }))
      if (pre?.__error) refusals.push(`Proxmox's migrate check could not be read: ${pre.__error}`)
      else {
        const na = (pre?.['not-allowed-nodes'] ?? pre?.not_allowed_nodes ?? {})[to]
        if (na) {
          for (const st of na['unavailable-storages'] ?? na.unavailable_storages ?? []) refusals.push(`Proxmox: storage "${st}" is not available on ${to}.`)
          for (const b of na['blocking-ha-resources'] ?? []) refusals.push(`Proxmox: HA ${b.cause ?? 'rules'} block it (${b.sid}).`)
          for (const u of na['unavailable-resources'] ?? na.unavailable_resources ?? []) refusals.push(`Proxmox: mapped device "${u}" is missing on ${to}.`)
          if (!refusals.length) refusals.push(`Proxmox does not allow ${to} for it.`)
        }
      }
    }
    const running = g.status === 'running'
    const localDisks = (t?.reasons ?? []).some(x => x.code === 'local-disk')
    const method: MovePlan['method'] = g.ha ? 'ha' : 'migrate'
    const shared = r.network.shared !== false
    const bw = method === 'ha' ? null : (opts.bwlimitKiB && opts.bwlimitKiB > 0 ? Math.round(opts.bwlimitKiB) : shared ? s.bwlimitKiB : null)
    const effectiveBw = method === 'ha' ? r.network.datacenterBwlimit : bw
    const copySec = copySeconds(g.copyBytes, s.linkMbps, effectiveBw)
    if (shared && g.copyBytes > 0) {
      warnings.push(`${(g.copyBytes / 1024 ** 3).toFixed(1)} GiB crosses the network corosync uses${effectiveBw ? `, at most ${Math.round(effectiveBw / 1024)} MiB/s` : ' at full speed'}: about ${Math.max(1, Math.round(copySec / 60))} min.`)
      if (method === 'ha' && !r.network.datacenterBwlimit) warnings.push('HA moves take no bandwidth limit of their own: only the datacenter "bwlimit: migration=…" setting slows them. It is not set.')
    }
    const needSec = (g.downtimeSec ?? 0) + copySec + 120
    const quiet = quietStatus({ now: this.now(), tz: r.tz, jobs: r.jobs, settings: s, needSec, jobsRead: r.jobsRead })
    const moves = await this.d.store.list({ sid, limit: 10 })
    const lastMove = lastMoveOf(moves)
    if (lastMove) warnings.push(`Last time it moved (${lastMove.from} → ${lastMove.to}): ${lastMove.words}`)
    const call = method === 'ha'
      ? `POST /cluster/ha/resources/${sid}/migrate  node=${to}`
      : `POST /nodes/${g.node}/${p.type}/${p.vmid}/migrate  ${migrateParams({ type: g.type, status: g.status, local: localDisks }, to, bw).toString().replace(/&/g, ' ')}`
    return {
      sid, name: g.name, type: g.type, from: g.node, to, method, allowed: refusals.length === 0, refusals: Array.from(new Set(refusals)),
      warnings: Array.from(new Set(warnings)), running, downtimeSec: g.downtimeSec, copyBytes: g.copyBytes, copySec, localDisks, bwlimitKiB: bw,
      network: r.network, quiet, needsAnyway: !quiet.quietNow, call, lastMove, settings: s,
    }
  }

  /** Start (or schedule) a move. The slot is taken before anything is awaited; the audit row comes before Proxmox. */
  async move(sid: Sid, to: string, opts: { when?: 'now' | 'next-quiet'; anyway?: boolean; bwlimitKiB?: number }, actor: Actor): Promise<MoveRecord> {
    // Synchronous: a second request in this process sees the slot taken before either has awaited anything.
    if (this.slot) throw new PlacementRefusal('Another move is running. One at a time: wait for it to finish.', 409, 'busy')
    const token = `pending:${Math.random().toString(36).slice(2)}`
    this.slot = token
    let handedOver = false
    try {
      if (!this.d.isUnlocked()) throw new PlacementRefusal('HyperProx is locked. Sign in to move a guest.', 423, 'locked')
      if ((await this.d.store.list({ status: IN_FLIGHT, limit: 1 })).length) throw new PlacementRefusal('Another move is running. One at a time: wait for it to finish.', 409, 'busy')
      const plan = await this.plan(sid, to, { bwlimitKiB: opts.bwlimitKiB })
      if (!plan.allowed) throw new PlacementRefusal(`Not moved: ${plan.refusals.join(' ')}`, 409, 'refused', { refusals: plan.refusals })
      const when = opts.when ?? 'now'
      if (when === 'now' && !plan.quiet.quietNow && !opts.anyway) {
        throw new PlacementRefusal(`Not a quiet window: ${plan.quiet.nowWhy.join('; ')}. Move anyway, or schedule it for the next quiet window.`, 409, 'not-quiet',
          { nextQuiet: plan.quiet.nextQuiet })
      }
      const at = when === 'next-quiet' && !plan.quiet.quietNow ? plan.quiet.nextQuiet?.start ?? null : null
      if (at && at - this.now() > SCHEDULE_TTL_MS) throw new PlacementRefusal('The next quiet window is more than 7 days away, and scheduled moves expire after 7 days.', 409, 'no-window')
      if (at && actor.role !== 'admin' && actor.role !== 'owner') throw new PlacementRefusal('Only an admin can schedule a move.', 403, 'forbidden')
      if (when === 'next-quiet' && !plan.quiet.quietNow && !at) {
        throw new PlacementRefusal(`There is no known quiet window to schedule it in${plan.quiet.nowWhy.length ? ` (${plan.quiet.nowWhy[0]})` : ''}. Move anyway, or try later.`, 409, 'no-window')
      }
      // The audit row first: no row, no move.
      await this.d.audit(at ? 'placement.move.schedule' : 'placement.move', sid, {
        by: actor.email, from: plan.from, to, method: plan.method, anyway: !!opts.anyway && !plan.quiet.quietNow, scheduledFor: at ? new Date(at).toISOString() : null,
        bwlimitKiB: plan.bwlimitKiB, copyBytes: plan.copyBytes, downtimeSec: plan.downtimeSec,
      })
      let rec: MoveRecord
      try {
        rec = await this.d.store.create({
          sid, name: plan.name, fromNode: plan.from, toNode: to, source: 'hyperprox', method: plan.method, status: at ? 'scheduled' : 'running',
          by: actor.email, scheduledFor: at, startedAt: at ? null : this.now(), bwlimitKiB: plan.bwlimitKiB,
          owner: at ? null : this.owner, heartbeatAt: at ? null : this.now(),
          snapshot: { settings: plan.settings, type: plan.type, running: plan.running, localDisks: plan.localDisks,
            ...(at ? { approver: { email: actor.email, role: String(actor.role), at: this.now() } } : {}) },
        })
      } catch (e) {
        if (e instanceof MoveSlotTaken) throw new PlacementRefusal(e.message, 409, 'busy')
        throw e
      }
      if (!at) { this.slot = rec.id; handedOver = true; void this.run(rec.id, plan) }
      return rec
    } finally {
      if (!handedOver && this.slot === token) this.slot = null
    }
  }

  /** Runs a claimed move to its end and frees the slot only then. */
  private async run(id: string, plan: MovePlan, resume?: { upid: string | null }): Promise<void> {
    try { await this.execute(id, plan, resume) }
    catch { /* execute records its own outcome */ }
    finally { if (this.slot === id) this.slot = null }
  }

  private async beat(id: string, force = false): Promise<void> {
    const last = this.beats.get(id) ?? 0
    if (!force && this.now() - last < HEARTBEAT_EVERY_MS) return
    this.beats.set(id, this.now())
    await this.d.store.transition(id, { status: IN_FLIGHT, owner: this.owner }, { heartbeatAt: this.now() }).catch(() => null)
  }

  /** Writes by the watching process: only while it still owns the row and the row is in flight (never over a resolve). */
  private own(id: string, patch: Partial<Omit<MoveRecord, 'id'>>): Promise<MoveRecord | null> {
    return this.d.store.transition(id, { status: IN_FLIGHT, owner: this.owner }, patch).catch(() => null)
  }

  /** A migration task for this guest that started at or after `sinceSec`, from the cluster task log; one look. */
  private async searchMigrateTask(vmid: number, sinceSec: number): Promise<{ upid: string; running: boolean } | null | 'unread'> {
    const tasks = await this.d.pve().fetchStrict<any[]>('/cluster/tasks').catch(() => null)
    if (!tasks) return 'unread'
    const t = tasks.filter(x => /^(qmigrate|vzmigrate)$/.test(String(x.type)) && String(x.id) === String(vmid) && Number(x.starttime) >= sinceSec - 5)
      .sort((a, b) => Number(b.starttime) - Number(a.starttime))[0]
    return t?.upid ? { upid: String(t.upid), running: taskRunning(t) } : null
  }

  /** The call, the wait, the read-back, the corosync count. Exposed for tests. */
  async execute(id: string, plan: MovePlan, resume?: { upid: string | null }): Promise<MoveRecord | null> {
    const pve = this.d.pve()
    const p = parseSid(plan.sid)!
    const row = await this.d.store.get(id)
    const startedSec = Math.floor((row?.startedAt ?? this.now()) / 1000)
    try {
      let upid: string | null = resume ? resume.upid : null
      if (!resume) {
        let postError: string | null = null
        try {
          if (plan.method === 'ha') {
            await pve.fetchStrict(`/cluster/ha/resources/${encodeURIComponent(plan.sid)}/migrate`, 'POST', new URLSearchParams({ node: plan.to }).toString())
            upid = await this.findMigrateTask(id, p.vmid, startedSec)
          } else {
            const body = migrateParams({ type: plan.type, status: plan.running ? 'running' : 'stopped', local: plan.localDisks }, plan.to, plan.bwlimitKiB)
            upid = await pve.fetchStrict<string>(`/nodes/${encodeURIComponent(plan.from)}/${p.type}/${p.vmid}/migrate`, 'POST', body.toString())
          }
        } catch (e: any) { postError = String(e?.message ?? e).slice(0, 300) }
        if (postError !== null) {
          // An error does not prove nothing started (a timeout, a dropped connection): look for the task first.
          upid = await this.findMigrateTask(id, p.vmid, startedSec)
          if (!upid) {
            await this.markStuck(id, plan, `The request to Proxmox failed (${postError}) and no task for it appeared, so whether the move started is unknown. Check the guest in Proxmox, then use Resolve.`)
            return this.d.store.get(id)
          }
        }
        if (upid) {
          // Never silently: a failure here is said in the row, and the wait goes on regardless (the move is under way).
          try { await this.d.store.attachUpid(id, upid) }
          catch (e: any) { await this.own(id, { error: `Its task id could not be saved: ${String(e?.message ?? e).slice(0, 160)}` }) }
        }
      }
      if (upid) {
        const node = /^UPID:([^:]+):/.exec(upid)?.[1] ?? plan.from
        await this.waitTask(id, plan, node, upid)
      } else if (plan.method === 'migrate') {
        throw new Error('Proxmox did not answer with a task id.')
      }
      // Read back: where is it now, and is it running if it was? An HA move still under way is waited out.
      let ok = await this.verify(plan, upid === null)
      if (!ok.ok && plan.method === 'ha' && await this.haBusy(plan.sid)) {
        await this.markStuck(id, plan, 'HA has not finished moving it yet.')
        ok = await this.watchHa(id, plan)
      }
      const done = await this.own(id, { status: ok.ok ? 'done' : 'failed', endedAt: this.now(), error: ok.ok ? null : ok.why })
      if (!done) return this.d.store.get(id)   // resolved by a person, or taken over, in the meantime: not ours to write
      await this.d.audit('placement.move.result', plan.sid, { ok: ok.ok, to: plan.to, why: ok.ok ? null : ok.why }).catch(() => undefined)
      await this.recordCorosync(id, [plan.from, plan.to], startedSec, Math.floor(this.now() / 1000)).catch(() => undefined)
      return done
    } catch (e: any) {
      // Still running in Proxmox when the watch ran out: it stays stuck (never "failed"), and says so.
      if (e instanceof StuckForGood) return this.d.store.get(id)
      const why = String(e?.message ?? e).slice(0, 500)
      await this.d.audit('placement.move.result', plan.sid, { ok: false, to: plan.to, why }).catch(() => undefined)
      return (await this.own(id, { status: 'failed', endedAt: this.now(), error: why })) ?? this.d.store.get(id)
    } finally {
      this.beats.delete(id)
      this.cache = null
    }
  }

  private async markStuck(id: string, plan: MovePlan, why: string): Promise<void> {
    await this.own(id, { status: 'stuck', error: why })
    await this.d.alert?.(`A move of ${plan.name || plan.sid} has not finished`, [
      `${plan.name || plan.sid} (${plan.from} → ${plan.to}): ${why}`,
      'HyperProx keeps watching it and starts no other move until Proxmox shows it finished. Check it in Proxmox if it stays like this.',
    ]).catch(() => undefined)
  }

  /** The migration task HA starts for a guest after a request, or null when none appears in time. */
  private async findMigrateTask(id: string, vmid: number, sinceSec: number): Promise<string | null> {
    // About two minutes at the usual 2 s poll: sixty looks.
    for (let i = 0; i < 60; i++) {
      await this.beat(id)
      const t = await this.searchMigrateTask(vmid, sinceSec)
      if (t && t !== 'unread') return t.upid
      await this.sleep(this.poll())
    }
    return null
  }

  /**
   * Waits for the task to stop. Past taskTimeoutMs the move is marked stuck (and an alert sent) and the wait goes on,
   * slower, until Proxmox shows the task stopped or watchMs passes: the slot is never freed while it may still run.
   */
  private async waitTask(id: string, plan: MovePlan, node: string, upid: string): Promise<void> {
    const timeout = this.d.taskTimeoutMs ?? 2 * 3600_000
    const watch = this.d.watchMs ?? 24 * 3600_000
    const base = `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}`
    let stuck = false
    for (let waited = 0; ; ) {
      await this.beat(id)
      // A busy node can be slow to answer during a migration: that is "still running", not a failure.
      const st = await this.d.pve().fetchStrict<{ status: string; exitstatus?: string }>(`${base}/status`).catch(() => null)
      if (st?.status === 'stopped') {
        if (stuck) await this.own(id, { status: 'running', error: null })
        if (st.exitstatus === 'OK') return
        const log = await this.d.pve().fetchStrict<Array<{ t: string }>>(`${base}/log?limit=500`).catch(() => null)
        const tail = (Array.isArray(log) ? log : []).slice(-6).map(l => l.t).join(' / ')
        throw new Error(`The Proxmox task failed (${st.exitstatus ?? 'unknown'})${tail ? `: ${tail}` : ''}`)
      }
      if (!stuck && waited >= timeout) {
        stuck = true
        await this.markStuck(id, plan, `Proxmox's task is still running after ${Math.round(timeout / 60_000)} min.`)
      }
      if (waited >= timeout + watch) {
        await this.own(id, { status: 'stuck', error: `Proxmox's task was still running when HyperProx stopped watching (${Math.round((timeout + watch) / 3600_000)} h). Check it in Proxmox; this move stays stuck until you do.` })
        throw new StuckForGood()
      }
      const step = stuck ? Math.max(this.poll(), 30_000) : this.poll()
      await this.sleep(step)
      waited += step
    }
  }

  /** True while HA reports the guest as moving. */
  private async haBusy(sid: Sid): Promise<boolean> {
    const rows = await this.d.pve().fetchStrict<any[]>('/cluster/ha/status/current').catch(() => null)
    const svc = (rows ?? []).find(r => r.type === 'service' && String(r.sid) === sid)
    return !!svc && /^(migrate|relocate)$/.test(String(svc.state ?? svc.crm_state ?? ''))
  }

  private async watchHa(id: string, plan: MovePlan): Promise<{ ok: boolean; why: string }> {
    const watch = this.d.watchMs ?? 24 * 3600_000
    for (let waited = 0; waited < watch; waited += Math.max(this.poll(), 30_000)) {
      await this.beat(id)
      if (!(await this.haBusy(plan.sid))) {
        await this.own(id, { status: 'running' })
        return this.verify(plan, false)
      }
      await this.sleep(Math.max(this.poll(), 30_000))
    }
    await this.own(id, { error: 'HA was still moving it when HyperProx stopped watching. Check it in Proxmox.' })
    throw new StuckForGood()
  }

  /** The guest really is on the target (and running, if it was). For an HA move with no task seen, it waits a while. */
  private async verify(plan: MovePlan, patient: boolean): Promise<{ ok: boolean; why: string }> {
    const tries = patient ? 60 : 10
    let last = ''
    for (let i = 0; i < tries; i++) {
      const vms = await this.d.pve().fetchStrict<any[]>('/cluster/resources?type=vm').catch(() => null)
      const p = parseSid(plan.sid)!
      const v = (vms ?? []).find(x => Number(x.vmid) === p.vmid)
      if (v) {
        const on = String(v.node), st = String(v.status)
        if (on === plan.to && (!plan.running || st === 'running')) return { ok: true, why: '' }
        last = on !== plan.to ? `The task finished, but ${plan.name || plan.sid} is on ${on}, not ${plan.to}.` : `It is on ${plan.to} but ${st}, not running.`
      } else last = 'The guest could not be found after the move.'
      await this.sleep(this.poll())
    }
    return { ok: false, why: last }
  }

  async recordCorosync(id: string, nodes: string[], startSec: number, endSec: number): Promise<MoveRecord | null> {
    const c = await corosyncAround({ exec: (n, cmd) => this.d.nodeExec(n, cmd) }, nodes, startSec, endSec)
    return this.d.store.update(id, { corosync: c })
  }

  /** Corosync around one recorded move, on request (it reads node journals over the stored logins). */
  async corosyncFor(id: string, actor: Actor): Promise<MoveRecord> {
    const m = await this.d.store.get(id)
    if (!m) throw new PlacementRefusal('No such move.', 404, 'not-found')
    if (!m.startedAt) throw new PlacementRefusal('That move has not run.', 409, 'not-run')
    await this.d.audit('placement.corosync-read', m.sid, { by: actor.email, nodes: [m.fromNode, m.toNode] })
    const r = await this.recordCorosync(id, [m.fromNode, m.toNode].filter(Boolean), Math.floor(m.startedAt / 1000), Math.floor((m.endedAt ?? m.startedAt + 60_000) / 1000))
    return r!
  }

  /** Cancels a scheduled move: an atomic scheduled → cancelled, so it cannot also be claimed by the scheduler. */
  async cancel(id: string, actor: Actor): Promise<MoveRecord> {
    const m = await this.d.store.get(id)
    if (!m) throw new PlacementRefusal('No such move.', 404, 'not-found')
    await this.d.audit('placement.move.cancel', m.sid, { by: actor.email, id })
    const done = await this.d.store.transition(id, { status: ['scheduled'] }, { status: 'cancelled', endedAt: this.now() })
    if (!done) {
      const now = await this.d.store.get(id)
      throw new PlacementRefusal(`It is ${now?.status ?? 'gone'}; only a scheduled move can be cancelled.`, 409, 'not-scheduled')
    }
    return done
  }

  /** Proxmox migrations from the cluster task log, kept so they outlive it. Runs on the timer, never on a read. */
  async syncSeen(): Promise<void> {
    const r = await this.read(true)
    const ours = await this.d.store.list({ limit: 500 })
    const known = new Set(ours.map(m => m.upid).filter(Boolean))
    // A move of ours that is in flight may not have its task id yet: leave that guest's tasks for the next pass.
    const busy = new Set(ours.filter(m => m.source === 'hyperprox' && IN_FLIGHT.includes(m.status)).map(m => m.sid))
    for (const t of r.tasks) {
      if (!/^(qmigrate|vzmigrate)$/.test(String(t.type)) || taskRunning(t) || !t.upid || known.has(t.upid)) continue
      const type = t.type === 'qmigrate' ? 'qemu' : 'lxc'
      const sid = sidOf(type, t.id)
      if (busy.has(sid)) continue
      const node = String(t.node)
      const log = await this.d.pve().fetchStrict<Array<{ t: string }>>(`/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(t.upid)}/log?limit=40`).catch(() => null)
      const text = (Array.isArray(log) ? log : []).map(l => l.t).join('\n')
      const to = /to node '([^']+)'/.exec(text)?.[1] ?? /migrat\w* .* to (\S+)/.exec(text)?.[1]?.replace(/['".]/g, '') ?? ''
      const g = r.input.snap.guests.find(x => x.sid === sid)
      await this.d.store.upsertSeen({
        upid: String(t.upid), sid, name: g?.name ?? '', fromNode: node, toNode: to, source: 'proxmox', method: null,
        status: t.status === 'OK' ? 'done' : 'failed', by: String(t.user ?? ''), startedAt: Number(t.starttime) * 1000,
        endedAt: Number(t.endtime) * 1000, error: t.status === 'OK' ? null : String(t.status ?? '').slice(0, 200),
      })
    }
  }

  /** Reads only: the recorded moves. The task-log sync runs on the scheduler's timer. */
  async history(sid?: Sid): Promise<MoveRecord[]> {
    return this.d.store.list({ sid, limit: 200 })
  }

  async getMove(id: string): Promise<MoveRecord | null> { return this.d.store.get(id) }

  /** Moves whose watcher died: claimed atomically by heartbeat, then watched to their end here. */
  async takeOverStale(): Promise<void> {
    const rows = await this.d.store.list({ status: IN_FLIGHT })
    for (const m of rows) {
      if (m.owner === this.owner || this.slot === m.id) continue
      if (m.heartbeatAt !== null && this.now() - m.heartbeatAt < HEARTBEAT_STALE_MS) continue
      if (this.slot) return   // this process is busy with its own move; another pass will come
      this.slot = m.id
      const claimed = await this.d.store.transition(m.id, { status: IN_FLIGHT, heartbeatBefore: this.now() - HEARTBEAT_STALE_MS }, { owner: this.owner, heartbeatAt: this.now() })
      if (!claimed) { if (this.slot === m.id) this.slot = null; continue }
      const p = parseSid(m.sid)
      const plan = this.resumePlan(claimed)
      // No task id saved (the process died between the call and saving it): recover it from the task log.
      if (p && !claimed.upid && claimed.startedAt) {
        const t = await this.searchMigrateTask(p.vmid, Math.floor(claimed.startedAt / 1000))
        if (t && t !== 'unread') {
          try { await this.d.store.attachUpid(m.id, t.upid); claimed.upid = t.upid }
          catch (e: any) { await this.own(m.id, { error: `Its task id could not be saved: ${String(e?.message ?? e).slice(0, 160)}` }); claimed.upid = t.upid }
        }
      }
      if (!p || (!claimed.upid && claimed.method !== 'ha')) {
        await this.own(m.id, { status: 'stuck', error: "HyperProx stopped before it knew this move's task, and none is in the task log. Check where the guest is in Proxmox, then use Resolve: it stays stuck until someone does." })
        await this.d.alert?.(`A move of ${m.name || m.sid} lost its watcher`, [`${m.name || m.sid} (${m.fromNode} → ${m.toNode}): HyperProx restarted before the move's task was known.`]).catch(() => undefined)
        if (this.slot === m.id) this.slot = null
        continue
      }
      // No new Proxmox call: only the wait (on its task, or on HA) and the read-back.
      void this.run(m.id, plan, { upid: claimed.upid })
      return
    }
  }

  /**
   * A stuck move, settled by a person once Proxmox is done with it: refused while its task (or HA) is still moving it,
   * otherwise read back and marked done or failed. Frees the move slot.
   */
  async resolve(id: string, actor: Actor): Promise<MoveRecord> {
    const m = await this.d.store.get(id)
    if (!m) throw new PlacementRefusal('No such move.', 404, 'not-found')
    if (m.status !== 'stuck') throw new PlacementRefusal(`It is ${m.status}; only a stuck move is resolved by hand.`, 409, 'not-stuck')
    if (this.slot === id) throw new PlacementRefusal('HyperProx is still watching this move; it settles it itself when Proxmox finishes.', 409, 'watching')
    if (m.owner !== this.owner && m.heartbeatAt !== null && this.now() - m.heartbeatAt < HEARTBEAT_STALE_MS) {
      throw new PlacementRefusal('Another HyperProx process is still watching this move; it settles it itself.', 409, 'watching')
    }
    const p = parseSid(m.sid)!
    if (m.upid) {
      const node = /^UPID:([^:]+):/.exec(m.upid)?.[1] ?? m.fromNode
      const st = await this.d.pve().fetchStrict<any>(`/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(m.upid)}/status`).catch(() => null)
      if (!st) throw new PlacementRefusal("Its task's state could not be read from Proxmox; try again.", 502, 'unread')
      if (st.status !== 'stopped') throw new PlacementRefusal('Its Proxmox task is still running. Wait for it, or stop it in Proxmox.', 409, 'still-running')
    } else {
      // No task id: any migration of this guest since the move started, and the guest's own migrate lock.
      const t = await this.searchMigrateTask(p.vmid, Math.floor((m.startedAt ?? this.now()) / 1000))
      if (t === 'unread') throw new PlacementRefusal('The cluster task log could not be read, so whether a migration is still running is unknown; try again.', 502, 'unread')
      if (t?.running) throw new PlacementRefusal('A migration of it is still running in Proxmox. Wait for it, or stop it in Proxmox.', 409, 'still-running')
      const vms = await this.d.pve().fetchStrict<any[]>('/cluster/resources?type=vm').catch(() => null)
      const v = (vms ?? []).find(x => Number(x.vmid) === p.vmid)
      if (!v) throw new PlacementRefusal('The guest could not be found in Proxmox just now; try again.', 502, 'unread')
      const cfg = await this.d.pve().fetchStrict<any>(`/nodes/${encodeURIComponent(String(v.node))}/${p.type}/${p.vmid}/config`).catch(() => null)
      if (!cfg) throw new PlacementRefusal("Its configuration could not be read, so whether it is still locked for a migration is unknown; try again.", 502, 'unread')
      if (String(cfg.lock ?? '') === 'migrate') throw new PlacementRefusal('Proxmox still has it locked for a migration.', 409, 'still-running')
    }
    // An HA move is over only when HA says so too, task or no task.
    if ((m.method === 'ha' || !m.upid) && await this.haBusy(m.sid)) throw new PlacementRefusal('HA is still moving it.', 409, 'still-running')
    await this.d.audit('placement.move.resolve', m.sid, { by: actor.email, id })
    const ok = await this.verify(this.resumePlan(m), false)
    const done = await this.d.store.transition(id, { status: ['stuck'] }, { status: ok.ok ? 'done' : 'failed', endedAt: this.now(), error: ok.ok ? null : ok.why })
    if (!done) throw new PlacementRefusal('It changed while being resolved; read it again.', 409, 'changed')
    return done
  }

  private resumePlan(m: MoveRecord): MovePlan {
    const s = m.snapshot ?? {}
    const p = parseSid(m.sid)
    const settings: PlacementSettings = { ...DEFAULT_SETTINGS, ...(s.settings ?? {}) }
    const quiet: QuietStatus = { quietNow: true, nowWhy: [], nextQuiet: null, upcoming: [], unread: [], tz: 'UTC' }
    const plan: MovePlan = {
      sid: m.sid, name: m.name, type: s.type ?? p?.type ?? 'lxc', from: m.fromNode, to: m.toNode, method: m.method ?? 'migrate', allowed: true,
      refusals: [], warnings: [], running: s.running ?? true, downtimeSec: null, copyBytes: 0, copySec: 0, localDisks: s.localDisks ?? false,
      bwlimitKiB: m.bwlimitKiB, network: { shared: null, migrationNetwork: null, corosyncAddresses: [], redundantRing: false, datacenterBwlimit: null, suggestedBwlimit: 0, words: [] },
      quiet, needsAnyway: false, call: '', lastMove: null, settings,
    }
    return plan
  }

  /** One pass of the scheduler. Never overlaps itself. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.takeOverStale().catch(() => undefined)
      if (this.now() - this.lastSync >= SYNC_EVERY_MS) { this.lastSync = this.now(); await this.syncSeen().catch(() => undefined) }
      const due = (await this.d.store.list({ status: ['scheduled'] })).filter(m => (m.scheduledFor ?? Infinity) <= this.now())
      for (const stale of due) {
        // Re-read: a cancel may have landed since the list.
        const m = await this.d.store.get(stale.id)
        if (!m || m.status !== 'scheduled') continue
        const skip = (error: string) => this.d.store.transition(m.id, { status: ['scheduled'] }, { status: 'skipped', endedAt: this.now(), error })
        if (this.now() - (m.scheduledFor ?? 0) > 30 * 60_000) { await skip('Its quiet window passed without it running (HyperProx was locked or restarting). Schedule it again.'); continue }
        // Locked: the Proxmox token is in the vault. Try again next minute, until the window passes.
        if (!this.d.isUnlocked() || this.slot) continue
        // The approval: recorded at scheduling (with the master password just re-entered), an admin's, under 7 days old,
        // and nothing HyperProx holds says the approver was removed or demoted since.
        const ap = m.snapshot?.approver
        if (!ap || (ap.role !== 'admin' && ap.role !== 'owner')) { await skip('Not run: no admin approval is recorded for it. Schedule it again.'); continue }
        if (this.now() - ap.at > SCHEDULE_TTL_MS) { await skip('Not run: it was approved more than 7 days ago, and scheduled moves expire after 7 days. Schedule it again.'); continue }
        const changed = this.d.approverChanged ? await this.d.approverChanged(ap.email, ap.at).catch(() => 'their role could not be checked') : null
        if (changed) { await skip(`Not run: ${ap.email} ${changed}.`); continue }
        // Under the stricter of what was approved and what is set now: a later change can only make it safer.
        const settings = stricterSettings(m.snapshot?.settings, await this.d.store.settings())
        let plan: MovePlan
        try { plan = await this.plan(m.sid, m.toNode, { bwlimitKiB: m.bwlimitKiB ? Math.min(m.bwlimitKiB, settings.bwlimitKiB) : undefined, settings }) }
        catch (e: any) { await skip(`Not run: ${String(e?.message ?? e).slice(0, 300)}`); continue }
        const why = !plan.allowed ? plan.refusals.join(' ') : !plan.quiet.quietNow ? `it is not a quiet window for the whole move (${plan.quiet.nowWhy.join('; ')})` : plan.from !== m.fromNode ? `it moved to ${plan.from} in the meantime` : null
        if (why) { await skip(`Not run: ${why}`); continue }
        try { await this.d.audit('placement.move.scheduled-run', m.sid, { id: m.id, by: m.by, to: m.toNode }) }
        catch { await skip('Not run: the audit row could not be written.'); continue }
        // Claim: the slot here, then scheduled → running in the database. Losing either is "someone else has it".
        if (this.slot) continue
        this.slot = m.id
        const claimed = await this.d.store.transition(m.id, { status: ['scheduled'] }, { status: 'running', startedAt: this.now(), owner: this.owner, heartbeatAt: this.now() })
        if (!claimed) { if (this.slot === m.id) this.slot = null; continue }
        void this.run(m.id, plan)
        break
      }
    } finally {
      this.ticking = false
    }
  }

  /** Every minute; the first pass right away takes over moves a dead process left behind. */
  async start(): Promise<() => void> {
    await this.tick().catch(() => undefined)
    if (!this.timer) this.timer = setInterval(() => { void this.tick().catch(() => undefined) }, 60_000)
    ;(this.timer as any).unref?.()
    return () => { if (this.timer) clearInterval(this.timer); this.timer = null }
  }
}

/** The watch ran out with the task still going: the row says stuck, and so it stays. */
class StuckForGood extends Error { constructor() { super('still running in Proxmox') } }

/** The form body for a plain migrate. */
export function migrateParams(g: { type: 'lxc' | 'qemu'; status: string; local?: boolean }, to: string, bwlimitKiB: number | null): URLSearchParams {
  const b = new URLSearchParams({ target: to })
  const running = g.status === 'running'
  if (g.type === 'lxc') { if (running) b.set('restart', '1') }
  else {
    if (running) b.set('online', '1')
    if (g.local) b.set('with-local-disks', '1')
  }
  if (bwlimitKiB) b.set('bwlimit', String(Math.round(bwlimitKiB)))
  return b
}

export function lastMoveOf(moves: MoveRecord[]): MovePlan['lastMove'] {
  const m = moves.find(x => (x.status === 'done' || x.status === 'failed') && x.startedAt)
  if (!m) return null
  const when = new Date(m.startedAt!).toISOString().slice(0, 16).replace('T', ' ')
  const how = m.status === 'failed' ? `it failed${m.error ? ` (${m.error.slice(0, 120)})` : ''}. ` : ''
  return { at: m.startedAt!, from: m.fromNode, to: m.toNode || '?', words: `${when} UTC: ${how}${corosyncWords(m.corosync)}` }
}
