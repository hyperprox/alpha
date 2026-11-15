// =============================================================================
//  HyperProx — load balancing: the service
//
//  Reads (the map, the advice, the balance, one guest), the move check, the
//  move itself, balancing plans, automatic balancing, the history and the
//  scheduler for moves and plans held until the next quiet window.
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
//
//  A balancing plan is a list of moves approved once (the master password),
//  run one at a time, each through move() above: its own audit row, its own
//  server-side check, its own quiet-window check. Before each move the plan
//  checks again that the cluster has not changed since it was approved
//  (quorum, every node that was online still online, no Ceph warning that was
//  not there then, the approver still an admin), that the guest is still where
//  the plan found it, and that the move still evens the load out against the
//  history with the plan's finished moves replayed. Anything else stops the
//  plan; a failed or stuck move stops it too. A plan whose process died is
//  stopped, never resumed: the move it was on is watched to its end as above.
//
//  Automatic balancing is off by default. On, it checks every so often; when
//  the cluster has been uneven for a sustained time, in a quiet window, it
//  notifies. With "apply automatically" (turned on with the master password,
//  which records who approved it) it also runs one move at a time as a
//  one-move plan: only guests HA does not manage, never one with disks to copy,
//  within its own limits (moves per day, hours between moves). Emergency stop
//  turns applying off and stops any plan after the move under way.
// =============================================================================

import { parseSid, sidOf } from '../ha/parse'
import type { HaPve } from '../ha/read'
import type { Sid } from '../ha/types'
import { advise } from './advice'
import { balance, checkStep, planSignature, type BalanceInput } from './balance'
import { corosyncAround, corosyncWords } from './corosync'
import { checkablePaths, placementMap, type EngineInput } from './engine'
import { copySeconds } from './network'
import { readCluster, readHistory, taskRunning, type ClusterRead, type PromRange } from './read'
import { DEFAULT_SETTINGS, IN_FLIGHT, MoveSlotTaken, PlanSlotTaken, mergeAuto, mergeSettings, stricterAuto, stricterSettings, type PlacementStore } from './store'
import { backupMask, quietStatus, type QuietStatus } from './windows'
import type {
  Advice, AutoSettings, AutoState, BalanceGoal, BalanceResult, GuestPlacement, MoveRecord, NetworkCost, PlacementMap, PlacementSettings,
  AutoConfig, PlanRecord, PlanSnapshot, PlanStatus, PlanStepRecord,
} from './types'

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
  /** Tells people about balancing (a plan proposed, run or stopped), through the notification channels. Never throws. */
  notify?(title: string, lines: string[], fingerprint: string, severity?: 'info' | 'warning'): Promise<void>
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

/** What a plan's move gets on top of a plain move: its plan, where the guest must still be, the settings it runs under. */
export interface MoveContext { planId: string; step: number; expectFrom: string; auto?: boolean; settings?: PlacementSettings }

export interface BalanceView extends BalanceResult {
  quiet:    QuietStatus
  crs:      PlacementMap['crs']
  network:  NetworkCost
  window:   { hours: number; stepSec: number }
  settings: Pick<PlacementSettings, 'balanceGoal' | 'unevenAbove' | 'minGain' | 'maxPlanMoves' | 'cpuAbove' | 'memAbove'>
  auto:     AutoConfig & { state: AutoState }
  running:  PlanRecord | null
  plans:    PlanRecord[]
}

const APPROVER_ROLES = new Set(['admin', 'owner'])
/** An approval to apply automatically lasts 30 days; then it notifies only until renewed. */
export const AUTO_APPROVAL_TTL_MS = 30 * 24 * 3600_000
/**
 * Ceph warnings accepted when applying was approved are good for 7 days. A person saw them and said "go on despite
 * these"; a week later they have to look again (save once more). A baseline of HEALTH_OK has no such limit beyond
 * the approval's own 30 days, since nothing was accepted. Chosen over a hand-kept "accepted checks" list because
 * there is nothing to misconfigure, and over refreshing the baseline on its own because that would accept a new
 * warning with no person looking.
 */
export const CEPH_BASELINE_TTL_MS = 7 * 24 * 3600_000
const DAY_MS = 24 * 3600_000

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
  /** Moves started here, until they settle: a plan waits on its move through this. */
  private runs = new Map<string, Promise<void>>()
  /** The plan slot in this process, as `slot` is for moves. */
  private planSlot: string | null = null
  private planBeats = new Map<string, number>()
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
  async move(sid: Sid, to: string, opts: { when?: 'now' | 'next-quiet'; anyway?: boolean; bwlimitKiB?: number }, actor: Actor, ctx?: MoveContext): Promise<MoveRecord> {
    // Synchronous: a second request in this process sees the slot taken before either has awaited anything.
    if (this.slot) throw new PlacementRefusal('Another move is running. One at a time: wait for it to finish.', 409, 'busy')
    const token = `pending:${Math.random().toString(36).slice(2)}`
    this.slot = token
    let handedOver = false
    try {
      if (!this.d.isUnlocked()) throw new PlacementRefusal('HyperProx is locked. Sign in to move a guest.', 423, 'locked')
      if ((await this.d.store.list({ status: IN_FLIGHT, limit: 1 })).length) throw new PlacementRefusal('Another move is running. One at a time: wait for it to finish.', 409, 'busy')
      // A plan's move runs now, in a quiet window, never "anyway": the plan was approved for a quiet window.
      if (ctx && (opts.when === 'next-quiet' || opts.anyway)) throw new PlacementRefusal('A plan runs its moves now, in a quiet window.', 400, 'bad-plan-move')
      const plan = await this.plan(sid, to, { bwlimitKiB: opts.bwlimitKiB, settings: ctx?.settings })
      if (!plan.allowed) throw new PlacementRefusal(`Not moved: ${plan.refusals.join(' ')}`, 409, 'refused', { refusals: plan.refusals })
      if (ctx && plan.from !== ctx.expectFrom) throw new PlacementRefusal(`Not moved: it is on ${plan.from} now, not ${ctx.expectFrom} where the plan found it.`, 409, 'changed')
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
      await this.d.audit(ctx ? (ctx.auto ? 'placement.auto.move' : 'placement.plan.move') : at ? 'placement.move.schedule' : 'placement.move', sid, {
        by: actor.email, from: plan.from, to, method: plan.method, anyway: !!opts.anyway && !plan.quiet.quietNow, scheduledFor: at ? new Date(at).toISOString() : null,
        bwlimitKiB: plan.bwlimitKiB, copyBytes: plan.copyBytes, downtimeSec: plan.downtimeSec,
        ...(ctx ? { planId: ctx.planId, step: ctx.step } : {}),
      })
      let rec: MoveRecord
      try {
        rec = await this.d.store.create({
          sid, name: plan.name, fromNode: plan.from, toNode: to, source: 'hyperprox', method: plan.method, status: at ? 'scheduled' : 'running',
          by: actor.email, scheduledFor: at, startedAt: at ? null : this.now(), bwlimitKiB: plan.bwlimitKiB,
          owner: at ? null : this.owner, heartbeatAt: at ? null : this.now(),
          snapshot: { settings: plan.settings, type: plan.type, running: plan.running, localDisks: plan.localDisks,
            ...(at ? { approver: { email: actor.email, role: String(actor.role), at: this.now() } } : {}),
            ...(ctx ? { planId: ctx.planId, ...(ctx.auto ? { auto: true } : {}) } : {}) },
        })
      } catch (e) {
        if (e instanceof MoveSlotTaken) throw new PlacementRefusal(e.message, 409, 'busy')
        throw e
      }
      if (!at) {
        this.slot = rec.id; handedOver = true
        const p = this.run(rec.id, plan)
        this.runs.set(rec.id, p)
        void p.finally(() => this.runs.delete(rec.id))
      }
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

  // --- load balancing -------------------------------------------------------------------------------

  /** Finished moves inside the window, oldest first: replayed onto the history so the score is the cluster as it is now. */
  private async pastMoves(sinceSec: number): Promise<BalanceInput['past']> {
    const rows = await this.d.store.list({ status: ['done'], limit: 500 }).catch(() => [] as MoveRecord[])
    return rows.filter(m => m.endedAt && m.endedAt / 1000 >= sinceSec && m.fromNode && m.toNode && m.fromNode !== m.toNode)
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
      .map(m => ({ sid: m.sid, from: m.fromNode, to: m.toNode, at: Math.floor((m.endedAt ?? 0) / 1000) }))
  }

  /** The cluster, its history and the balance worked out from them. Throws when Prometheus cannot be read. */
  private async balanceRead(opts: { goal?: BalanceGoal; auto?: boolean; fresh?: boolean; settings?: PlacementSettings; recentHours?: number } = {}) {
    const s = opts.settings ?? await this.d.store.settings()
    const r = await this.read(opts.fresh)
    const map = placementMap(this.engineInput(r, s))
    const hist = await readHistory(this.d.prom, { hours: s.windowHours, now: this.now(), guests: map.guests.map(g => g.sid) })
    // Backup windows are always left out of the history, whatever the move setting says: a nightly backup is not imbalance.
    const mask = backupMask({ tz: r.tz, jobs: r.jobs, backupHours: s.backupHours })
    const memo = new Map<number, boolean>()
    const masked = (t: number) => { let v = memo.get(t); if (v === undefined) { v = mask(t); memo.set(t, v) } return v }
    const input: BalanceInput = {
      map, nodes: hist.nodes, guests: hist.guests, masked, stepSec: hist.stepSec, settings: s, goal: opts.goal,
      past: await this.pastMoves(hist.start), auto: opts.auto, recentHours: opts.recentHours, endSec: hist.end,
      locations: hist.locations ?? undefined,
    }
    const result = balance(input)
    if (!hist.locations) result.unread.push('where each guest ran over the window (a guest HA moved after a failure cannot be told apart)')
    return { s, r, map, hist, input, result }
  }

  /** The balance page: load per node, the score, the plan that would even it out, and what is running. */
  async balanceView(goal?: BalanceGoal): Promise<BalanceView> {
    const s = await this.d.store.settings()
    const auto = await this.d.store.auto()
    const plans = await this.d.store.listPlans({ limit: 10 })
    const running = plans.find(p => p.status === 'running') ?? null
    let b: Awaited<ReturnType<PlacementService['balanceRead']>> | null = null
    let unreadHistory: string | null = null
    try { b = await this.balanceRead({ goal, settings: s }) }
    catch (e: any) { if (e instanceof PlacementRefusal) throw e; unreadHistory = String(e?.message ?? e).slice(0, 80) }
    const r = b?.r ?? await this.read()
    const map = b?.map ?? placementMap(this.engineInput(r, s))
    const result: BalanceResult = b?.result ?? balance({
      map, nodes: [], guests: [], masked: () => false, stepSec: 300, settings: s, goal,
    })
    if (unreadHistory) result.unread.unshift(`Prometheus (${unreadHistory})`)
    for (const u of map.unread) if (!result.unread.includes(u)) result.unread.push(u)
    const quiet = quietStatus({ now: this.now(), tz: r.tz, jobs: r.jobs, settings: s, needSec: result.plan.needSec || 600, jobsRead: r.jobsRead })
    return {
      ...result, quiet, crs: map.crs, network: map.network, window: { hours: s.windowHours, stepSec: b?.hist.stepSec ?? 0 },
      settings: { balanceGoal: s.balanceGoal, unevenAbove: s.unevenAbove, minGain: s.minGain, maxPlanMoves: s.maxPlanMoves, cpuAbove: s.cpuAbove, memAbove: s.memAbove },
      auto, running, plans,
    }
  }

  async plans(): Promise<PlanRecord[]> { return this.d.store.listPlans({ limit: 50 }) }
  async getPlan(id: string): Promise<PlanRecord | null> { return this.d.store.getPlan(id) }

  /**
   * Ceph's health now. "none": the cluster has no Ceph of its own (no rbd or cephfs storage without an external
   * monhost, and no status). "unread": Ceph is in use, or might be, and its health or OSD count could not be read;
   * that is never taken as healthy.
   */
  private async cephNow(): Promise<CephNow> {
    const storage = await this.d.pve().fetchStrict<any[]>('/storage').catch(() => null)
    if (!Array.isArray(storage)) return { kind: 'unread', why: 'the storage list could not be read, so whether Ceph is in use is unknown' }
    const ours = storage.some(x => (x?.type === 'rbd' || x?.type === 'cephfs') && !x?.monhost)
    const st = await this.d.pve().fetchStrict<any>('/cluster/ceph/status').catch(() => null)
    if (!st?.health?.status) return ours ? { kind: 'unread', why: 'Ceph is in use but its health could not be read' } : { kind: 'none' }
    const num = Number(st.osdmap?.num_osds), up = Number(st.osdmap?.num_up_osds)
    if (!Number.isFinite(num) || !Number.isFinite(up) || num <= 0) return { kind: 'unread', why: "Ceph's OSD count could not be read" }
    return { kind: 'ok', status: String(st.health.status), checks: Object.keys(st.health.checks ?? {}).sort(), osds: num, up }
  }

  /** The Ceph baseline a person approves: refused when Ceph cannot be read, or shows a warning that always blocks. */
  private async approvalCeph(): Promise<{ checks: string[] } | null> {
    const h = await this.cephNow()
    if (h.kind === 'none') return null
    if (h.kind === 'unread') throw new PlacementRefusal(`Not approved: ${h.why}. HyperProx does not move guests while it cannot see Ceph.`, 409, 'ceph-unread')
    const why = cephProblem(h, h.checks)
    if (why) throw new PlacementRefusal(`Not approved: ${why}.`, 409, 'ceph-not-ok')
    return { checks: h.checks }
  }

  /** Has the cluster changed since the plan was approved? Null when it has not; otherwise why, in words. */
  async gate(snap: PlanSnapshot | null): Promise<string | null> {
    const st = await this.d.pve().fetchStrict<any[]>('/cluster/status').catch(() => null)
    if (!Array.isArray(st)) return 'the cluster status could not be read'
    const c = st.find(x => x?.type === 'cluster')
    if (c && Number(c.quorate) !== 1) return 'the cluster has lost quorum'
    for (const n of snap?.nodes ?? []) {
      const e = st.find(x => x?.type === 'node' && String(x.name) === n)
      if (!e || Number(e.online) !== 1) return `${n} is offline`
    }
    // Ceph is always looked at: no baseline (no Ceph at approval) means any warning now is new.
    const h = await this.cephNow()
    if (h.kind === 'unread') return h.why
    if (h.kind === 'ok') return cephProblem(h, snap?.ceph?.checks ?? [])
    return null
  }

  private async moveInFlight(): Promise<boolean> {
    return !!this.slot || (await this.d.store.list({ status: IN_FLIGHT, limit: 1 })).length > 0
  }

  /**
   * Approve and start (or schedule) a balancing plan. The server works the plan out again and refuses when it differs
   * from the one the person saw (`expect`): what runs is what was approved. Audited before anything is stored.
   */
  async createPlan(opts: { when?: 'now' | 'next-quiet'; goal?: BalanceGoal; expect: Array<{ sid: string; to: string }> }, actor: Actor): Promise<PlanRecord> {
    if (this.planSlot) throw new PlacementRefusal('Another balancing plan is running. One at a time: wait for it, or stop it.', 409, 'busy')
    const token = `pending:${Math.random().toString(36).slice(2)}`
    this.planSlot = token
    let handedOver = false
    try {
      if (!this.d.isUnlocked()) throw new PlacementRefusal('HyperProx is locked. Sign in to balance the cluster.', 423, 'locked')
      if (!APPROVER_ROLES.has(String(actor.role))) throw new PlacementRefusal('Only an admin can run a balancing plan.', 403, 'forbidden')
      if ((await this.d.store.listPlans({ status: ['running'], limit: 1 })).length) throw new PlacementRefusal('Another balancing plan is running. One at a time: wait for it, or stop it.', 409, 'busy')
      if (await this.moveInFlight()) throw new PlacementRefusal('A move is running. Wait for it to finish, then run the plan.', 409, 'busy')
      let b: Awaited<ReturnType<PlacementService['balanceRead']>>
      try { b = await this.balanceRead({ goal: opts.goal, fresh: true }) }
      catch (e: any) { throw new PlacementRefusal(`No history: Prometheus could not be read (${String(e?.message ?? e).slice(0, 80)}), so HyperProx cannot work out a plan.`, 502, 'no-history') }
      const plan = b.result.plan
      if (!plan.steps.length) throw new PlacementRefusal(`Nothing to run: ${plan.left[0] ?? 'no move would even the load out.'}`, 409, 'nothing')
      if (planSignature(plan.steps) !== planSignature(opts.expect ?? [])) {
        throw new PlacementRefusal('The plan changed since you looked at it. Look at the new one and run that.', 409, 'changed', { plan })
      }
      const quiet = quietStatus({ now: this.now(), tz: b.r.tz, jobs: b.r.jobs, settings: b.s, needSec: plan.needSec, jobsRead: b.r.jobsRead })
      const when = opts.when ?? 'now'
      if (when === 'now' && !quiet.quietNow) {
        throw new PlacementRefusal(`Not a quiet window for the whole plan: ${quiet.nowWhy.join('; ')}. Schedule it for the next quiet window instead.`, 409, 'not-quiet', { nextQuiet: quiet.nextQuiet })
      }
      const at = when === 'next-quiet' && !quiet.quietNow ? quiet.nextQuiet?.start ?? null : null
      if (when === 'next-quiet' && !quiet.quietNow && !at) throw new PlacementRefusal(`There is no known quiet window long enough for the plan${quiet.nowWhy.length ? ` (${quiet.nowWhy[0]})` : ''}.`, 409, 'no-window')
      if (at && at - this.now() > SCHEDULE_TTL_MS) throw new PlacementRefusal('The next quiet window is more than 7 days away, and scheduled plans expire after 7 days.', 409, 'no-window')
      const ceph = await this.approvalCeph()
      const snapshot: PlanSnapshot = {
        settings: b.s, approver: { email: actor.email, role: String(actor.role), at: this.now() },
        ceph, nodes: b.map.nodes.filter(n => n.online && !n.maintenance).map(n => n.node), needSec: plan.needSec,
      }
      // The audit row first: no row, no plan.
      await this.d.audit(at ? 'placement.plan.schedule' : 'placement.plan.create', 'balance', {
        by: actor.email, goal: plan.goal, scoreBefore: Math.round(plan.score.score), scoreTarget: Math.round(plan.target.score),
        moves: plan.steps.map(x => `${x.sid} ${x.from}>${x.to}`), scheduledFor: at ? new Date(at).toISOString() : null,
      })
      let rec: PlanRecord
      try {
        rec = await this.d.store.createPlan({
          source: 'manual', status: at ? 'scheduled' : 'running', by: actor.email, goal: plan.goal,
          scoreBefore: plan.score.score, scoreTarget: plan.target.score, steps: plan.steps.map(stepRecord),
          scheduledFor: at, startedAt: at ? null : this.now(), owner: at ? null : this.owner, heartbeatAt: at ? null : this.now(), snapshot,
        })
      } catch (e) {
        if (e instanceof PlanSlotTaken) throw new PlacementRefusal(e.message, 409, 'busy')
        throw e
      }
      if (!at) { this.planSlot = rec.id; handedOver = true; void this.runPlan(rec.id) }
      return rec
    } finally {
      if (!handedOver && this.planSlot === token) this.planSlot = null
    }
  }

  /** Stops a plan: a scheduled one is cancelled; a running one stops after the move under way (a migration is never cut off). */
  async stopPlan(id: string, actor: Actor): Promise<PlanRecord> {
    const p = await this.d.store.getPlan(id)
    if (!p) throw new PlacementRefusal('No such plan.', 404, 'not-found')
    await this.d.audit('placement.plan.stop', 'balance', { by: actor.email, id, status: p.status })
    const done = await this.stopOne(p, `Cancelled by ${actor.email}.`)
    if (!done) {
      const now = await this.d.store.getPlan(id)
      throw new PlacementRefusal(`It is ${now?.status ?? 'gone'}; only a scheduled or running plan can be stopped.`, 409, 'not-running')
    }
    return done
  }

  /**
   * Cancel a scheduled plan, or ask a running one to stop. A scheduled plan the scheduler claimed in the meantime is
   * running by then: the stop is tried again as running → stop requested, so it is never lost in that race.
   */
  private async stopOne(p: PlanRecord, why: string): Promise<PlanRecord | null> {
    if (p.status === 'scheduled') {
      const r = await this.d.store.transitionPlan(p.id, { status: ['scheduled'] }, { status: 'cancelled', endedAt: this.now(), error: why })
      if (r) return r
    }
    return this.d.store.transitionPlan(p.id, { status: ['running'] }, { stopRequested: true })
  }

  private async beatPlan(id: string, force = false): Promise<void> {
    const last = this.planBeats.get(id) ?? 0
    if (!force && this.now() - last < HEARTBEAT_EVERY_MS) return
    this.planBeats.set(id, this.now())
    await this.d.store.transitionPlan(id, { status: ['running'], owner: this.owner }, { heartbeatAt: this.now() }).catch(() => null)
  }

  /** Waits for a move started here to settle, beating the plan's heartbeat meanwhile; then the row as it ended. */
  private async waitMove(moveId: string, planId: string): Promise<MoveRecord | null> {
    const p = this.runs.get(moveId)
    if (p) {
      let settled = false
      void p.finally(() => { settled = true })
      while (!settled) { await Promise.race([p, this.sleep(HEARTBEAT_EVERY_MS)]); await this.beatPlan(planId) }
    }
    return this.d.store.get(moveId)
  }

  private async runPlan(id: string): Promise<void> {
    try { await this.executePlan(id) }
    catch (e: any) { await this.finishPlan(id, 'failed', `The plan stopped on an error: ${String(e?.message ?? e).slice(0, 300)}`).catch(() => undefined) }
    finally { this.planBeats.delete(id); if (this.planSlot === id) this.planSlot = null }
  }

  private async finishPlan(id: string, status: PlanStatus, error: string | null, steps?: PlanStepRecord[]): Promise<PlanRecord | null> {
    const done = await this.d.store.transitionPlan(id, { status: ['running'], owner: this.owner }, { status, endedAt: this.now(), error, ...(steps ? { steps } : {}) })
    if (!done) return null
    await this.d.audit('placement.plan.result', 'balance', { id, status, error, source: done.source }).catch(() => undefined)
    const moved = done.steps.filter(x => x.status === 'done')
    const what = moved.length ? `Moved: ${moved.map(x => `${x.name || x.sid} ${x.from} → ${x.to}`).join('; ')}.` : 'Nothing was moved.'
    if (status !== 'done' || done.source === 'auto') {
      await this.d.notify?.(
        status === 'done' ? 'Automatic balancing moved a guest' : `A balancing plan ${status === 'failed' ? 'failed' : 'stopped'}`,
        [what, ...(error ? [error] : []), ...(done.source === 'auto' ? ['Automatic balancing moves only guests HA does not manage, one at a time, within its limits.'] : [])],
        `placement:plan:${id}:${status}`, status === 'done' ? 'info' : 'warning',
      ).catch(() => undefined)
    }
    return done
  }

  /** Runs a claimed plan's moves in order, one at a time; any change, refusal or failed move stops it. Exposed for tests. */
  async executePlan(id: string): Promise<PlanRecord | null> {
    const first = await this.d.store.getPlan(id)
    if (!first) return null
    const steps = first.steps.map(x => ({ ...x }))
    const save = () => this.d.store.transitionPlan(id, { status: ['running'], owner: this.owner }, { steps, heartbeatAt: this.now() })
    const skipRest = (from: number, why: string) => { for (let j = from; j < steps.length; j++) if (steps[j].status === 'pending') { steps[j].status = 'skipped'; steps[j].error = why } }
    const stop = (i: number, status: PlanStatus, why: string) => { skipRest(i, why); return this.finishPlan(id, status, why, steps) }
    for (let i = 0; i < steps.length; i++) {
      const row = await this.d.store.getPlan(id)
      if (!row || row.status !== 'running' || row.owner !== this.owner) return row
      const step = steps[i]
      if (step.status === 'done') continue
      if (row.stopRequested) return stop(i, 'stopped', `Stopped on request before move ${i + 1}.`)
      if (row.source === 'auto') {
        // Automatic balancing as a person left it, read now: still on, still applying, the same approval, no stop since.
        const c = await this.d.store.auto()
        const a = row.snapshot?.auto
        if (!c.settings.enabled || !c.settings.apply || !c.approval || !a || c.approval.at !== a.approvedAt || c.epoch !== a.epoch) {
          return stop(i, 'stopped', `Stopped before move ${i + 1}: automatic balancing was stopped or changed.`)
        }
      }
      const ap = row.snapshot?.approver
      if (!ap || !APPROVER_ROLES.has(ap.role)) return stop(i, 'stopped', 'No admin approval is recorded for it.')
      const changed = this.d.approverChanged ? await this.d.approverChanged(ap.email, ap.at).catch(() => 'their role could not be checked') : null
      if (changed) return stop(i, 'stopped', `Stopped before move ${i + 1}: ${ap.email} ${changed}.`)
      if (!this.d.isUnlocked()) return stop(i, 'stopped', `Stopped before move ${i + 1}: HyperProx was locked.`)
      const why = await this.gate(row.snapshot)
      if (why) return stop(i, 'stopped', `Stopped before move ${i + 1}: ${why}.`)
      const settings = stricterSettings(row.snapshot?.settings, await this.d.store.settings())
      let b: Awaited<ReturnType<PlacementService['balanceRead']>>
      try { b = await this.balanceRead({ goal: row.goal, fresh: true, auto: row.source === 'auto', settings }) }
      catch (e: any) { return stop(i, 'stopped', `Stopped before move ${i + 1}: the history could not be read (${String(e?.message ?? e).slice(0, 80)}).`) }
      const g = b.map.guests.find(x => x.sid === step.sid)
      if (!g || g.node !== step.from) return stop(i, 'stopped', `Stopped before move ${i + 1}: ${step.name || step.sid} is ${g ? `on ${g.node} now` : 'gone'}, not on ${step.from} where the plan found it.`)
      const c = checkStep(b.input, step.sid, step.to)
      if (!c.ok) return stop(i, 'stopped', `Stopped before move ${i + 1}: the cluster changed (${c.why}).`)
      step.status = 'running'; step.startedAt = this.now(); step.error = null
      await save()
      let rec: MoveRecord
      try {
        rec = await this.move(step.sid, step.to, { when: 'now' }, { email: ap.email, role: ap.role },
          { planId: id, step: i + 1, expectFrom: step.from, auto: row.source === 'auto', settings })
      } catch (e: any) {
        step.status = 'failed'; step.endedAt = this.now(); step.error = String(e?.message ?? e).slice(0, 400)
        return stop(i + 1, 'stopped', `Move ${i + 1} (${step.name || step.sid}) was not started: ${step.error}`)
      }
      step.moveId = rec.id
      await save()
      const end = await this.waitMove(rec.id, id)
      step.endedAt = this.now()
      if (!end || end.status !== 'done') {
        step.status = 'failed'; step.error = end?.error ?? `it is ${end?.status ?? 'gone'}`
        return stop(i + 1, 'failed', `Move ${i + 1} (${step.name || step.sid}) ${end?.status === 'stuck' ? 'is still running in Proxmox' : 'failed'}: ${step.error}. The rest of the plan did not run.`)
      }
      step.status = 'done'
      await save()
    }
    return this.finishPlan(id, 'done', null, steps)
  }

  // --- automatic balancing --------------------------------------------------------------------------
  //
  // Two records. The config (settings, the approval, the stop epoch) is written only by a person: saveAuto and
  // autoStop, plus the one deliberate write of the check itself, turning applying off when the approver changed.
  // The check's own state (when it last looked, what it said, what it last notified) is a separate row it merges
  // into. So a check that was already running when someone pressed the emergency stop can never write the old
  // settings back. Before it creates a plan the check reads the config again and gives up if applying is off, the
  // approval changed, or the stop epoch moved; each move of an automatic plan checks the same again.

  async autoSettings(): Promise<AutoConfig & { state: AutoState }> { return this.d.store.auto() }

  /** Saves automatic balancing. Turning "apply automatically" on (or saving with it on) records a fresh approval. */
  async saveAuto(body: unknown, actor: Actor): Promise<AutoConfig & { state: AutoState }> {
    const cur = await this.d.store.auto()
    const { settings, problems } = mergeAuto(cur.settings, body)
    if (problems.length) throw new PlacementRefusal(problems.join(' '), 400, 'invalid')
    let approval = cur.approval
    let epoch = cur.epoch
    if (settings.apply) {
      if (!APPROVER_ROLES.has(String(actor.role))) throw new PlacementRefusal('Only an admin can turn on applying automatically.', 403, 'forbidden')
      if (!this.d.isUnlocked()) throw new PlacementRefusal('HyperProx is locked. Sign in first.', 423, 'locked')
      // Saved with applying on, re-confirmed: a fresh approval, with today's limits, settings and Ceph health.
      approval = { email: actor.email, role: String(actor.role), at: this.now(), limits: { ...settings }, placement: await this.d.store.settings(), ceph: await this.approvalCeph() }
    } else {
      if (cur.settings.apply || cur.approval) epoch++
      approval = null
    }
    await this.d.audit('placement.auto.settings', 'balance', {
      by: actor.email, enabled: settings.enabled, apply: settings.apply, sustainHours: settings.sustainHours,
      maxMovesPerDay: settings.maxMovesPerDay, minHoursBetween: settings.minHoursBetween, checkEveryMin: settings.checkEveryMin,
    })
    await this.d.store.saveAutoConfig({ settings, approval, epoch }, actor.email)
    return this.d.store.auto()
  }

  /**
   * The emergency stop: applying turns off and the stop epoch moves (a check under way gives up), scheduled plans and
   * scheduled single moves are cancelled, running plans stop after the move under way.
   */
  async autoStop(actor: Actor): Promise<AutoConfig & { state: AutoState; stopped: number; cancelledMoves: number }> {
    await this.d.audit('placement.auto.stop', 'balance', { by: actor.email })
    const cur = await this.d.store.auto()
    await this.d.store.saveAutoConfig({ settings: { ...cur.settings, apply: false }, approval: null, epoch: cur.epoch + 1 }, actor.email)
    await this.d.store.patchAutoState({ lastWhy: `Emergency stop by ${actor.email}.` })
    const why = `Emergency stop by ${actor.email}.`
    let stopped = 0, cancelledMoves = 0
    for (const p of await this.d.store.listPlans({ status: ['running', 'scheduled'], limit: 50 })) if (await this.stopOne(p, why)) stopped++
    for (const m of await this.d.store.list({ status: ['scheduled'], limit: 200 })) {
      if (await this.d.store.transition(m.id, { status: ['scheduled'] }, { status: 'cancelled', endedAt: this.now(), error: why })) cancelledMoves++
    }
    return { ...(await this.d.store.auto()), stopped, cancelledMoves }
  }

  /** HyperProx's automatic moves, from the move history (never from the check's own memory). */
  private async autoMoves(): Promise<MoveRecord[]> {
    return (await this.d.store.list({ limit: 500 })).filter(m => m.source === 'hyperprox' && m.snapshot?.auto)
  }

  /** One automatic check, when it is due. Exposed for tests. */
  async autoTick(): Promise<void> {
    const c0 = await this.d.store.auto()
    if (!c0.settings.enabled) return
    const ap0 = c0.settings.apply ? c0.approval : null
    // Under the stricter of what was approved and what is set now.
    const a = ap0 ? stricterAuto(ap0.limits, c0.settings) : c0.settings
    if (c0.state.lastCheckAt && this.now() - c0.state.lastCheckAt < a.checkEveryMin * 60_000) return
    const epoch = c0.epoch
    const patch: Partial<AutoState> = { lastCheckAt: this.now() }
    const done = async (why: string) => { patch.lastWhy = why; await this.d.store.patchAutoState(patch) }
    if (!this.d.isUnlocked()) return done('HyperProx is locked: nothing is read or moved until someone signs in.')
    const current = await this.d.store.settings()
    const settings = ap0 ? stricterSettings(ap0.placement, current) : current
    let b: Awaited<ReturnType<PlacementService['balanceRead']>>
    try { b = await this.balanceRead({ fresh: true, auto: true, recentHours: a.sustainHours, settings }) }
    catch (e: any) { return done(`The history could not be read (${String(e?.message ?? e).slice(0, 80)}).`) }
    const r = b.result
    if (!r.uneven) return done(`${r.headline.replace(/\.$/, '')} (score ${Math.round(r.score.score)}).`)
    const sustained = r.recent.covered >= a.sustainHours * 0.5 && r.recent.hours >= r.recent.covered * 0.9
    if (!sustained) return done(`Uneven now, but not for ${a.sustainHours} h in a row yet (${Math.round(r.recent.hours * 10) / 10} h of the last ${Math.round(r.recent.covered * 10) / 10} h).`)
    const plan = r.plan
    const need = plan.steps[0] ? (plan.steps[0].downtimeSec ?? 0) + plan.steps[0].copySec + 120 : 600
    const quiet = quietStatus({ now: this.now(), tz: b.r.tz, jobs: b.r.jobs, settings: b.s, needSec: need, jobsRead: b.r.jobsRead })
    if (!quiet.quietNow) return done(`Uneven, but not a quiet window (${quiet.nowWhy.join('; ')}).`)
    if (!plan.steps.length && !plan.suggestions.length) return done(`Uneven, but nothing can usefully move. ${plan.left[0] ?? ''}`.trim())
    const sig = `${planSignature(plan.steps)}|${plan.suggestions.map(x => `${x.kind}:${x.sid}>${x.to}`).join(',')}`
    const lines = [
      r.headline,
      ...plan.steps.map(x => `Move ${x.name || x.sid} from ${x.from} to ${x.to} (+${Math.round(x.gain)} points${x.downtimeSec ? `, about ${x.downtimeSec} s offline` : ''}).`),
      ...plan.suggestions.map(x => x.words),
      `Score ${Math.round(plan.score.score)} now, ${Math.round(plan.target.score)} after.`,
      'Automatic balancing applies only to guests HA does not manage; for HA guests it suggests a move or a rule change.',
    ]
    const notifyOnce = async (title: string, key = sig, extra: string[] = []) => {
      if (c0.state.lastNotifiedSig === key && c0.state.lastNotifiedAt && this.now() - c0.state.lastNotifiedAt < DAY_MS) return
      await this.d.notify?.(title, [...extra, ...lines], `placement:auto:${key}`, extra.length ? 'warning' : 'info').catch(() => undefined)
      patch.lastNotifiedSig = key; patch.lastNotifiedAt = this.now()
    }
    if (!ap0 || !plan.steps.length) {
      await notifyOnce('The cluster has been uneven: a balancing plan is ready')
      return done(ap0 ? 'Uneven: only suggestions for HA guests, nothing to apply.' : c0.settings.apply ? 'Uneven: applying is on but no approval is recorded; notify only.' : 'Uneven: a plan was proposed (notify only).')
    }
    // The approval: young enough, its Ceph baseline young enough, the approver still an admin.
    if (this.now() - ap0.at > AUTO_APPROVAL_TTL_MS) {
      await notifyOnce('Automatic balancing needs a new approval', `renew:${ap0.at}`, [`Applying was approved by ${ap0.email} more than 30 days ago. Save automatic balancing again (with your master password) to renew it; until then it only notifies.`])
      return done('Uneven, but the approval to apply is more than 30 days old: notify only until it is renewed.')
    }
    if (ap0.ceph?.checks.length && this.now() - ap0.at > CEPH_BASELINE_TTL_MS) {
      await notifyOnce('Automatic balancing needs a new approval', `ceph:${ap0.at}`, [`Ceph had warnings when applying was approved (${ap0.ceph.checks.join(', ')}). Accepted warnings are good for 7 days: look at Ceph and save automatic balancing again to go on applying.`])
      return done('Uneven, but the Ceph warnings accepted at approval are more than 7 days old: notify only until it is approved again.')
    }
    const changed = !APPROVER_ROLES.has(ap0.role) ? 'no admin approval is recorded'
      : this.d.approverChanged ? await this.d.approverChanged(ap0.email, ap0.at).catch(() => 'their role could not be checked') : null
    if (changed) {
      // The one write of the config the check makes: applying off, into the config as it is now, and only if it is
      // still the same approval.
      const fresh = await this.d.store.auto()
      if (fresh.approval?.at === ap0.at) await this.d.store.saveAutoConfig({ settings: { ...fresh.settings, apply: false }, approval: null, epoch: fresh.epoch + 1 }, 'automatic balancing')
      await this.d.notify?.('Automatic balancing stopped applying', [`Applying automatically was turned off: ${ap0.email} ${changed}. It notifies only until an admin turns applying on again.`], 'placement:auto:approver', 'warning').catch(() => undefined)
      return done(`Applying was turned off: ${ap0.email} ${changed}.`)
    }
    // Its own limits, from the move history.
    if (this.planSlot || (await this.d.store.listPlans({ status: ['running'], limit: 1 })).length || await this.moveInFlight()) return done('Uneven, but a move or a plan is running.')
    const mine = await this.autoMoves()
    const today = mine.filter(m => (m.startedAt ?? 0) > this.now() - DAY_MS && m.status !== 'cancelled' && m.status !== 'skipped').length
    if (today >= a.maxMovesPerDay) { await notifyOnce('The cluster is uneven: automatic balancing reached its daily limit'); return done(`Uneven, but ${today} automatic move${today === 1 ? '' : 's'} in the last 24 h is the limit.`) }
    const lastEnd = Math.max(0, ...mine.filter(m => m.status === 'done' || m.status === 'failed').map(m => m.endedAt ?? 0))
    if (lastEnd && this.now() - lastEnd < a.minHoursBetween * 3600_000) return done(`Uneven, but the last automatic move was less than ${a.minHoursBetween} h ago.`)
    const nodes = b.map.nodes.filter(n => n.online && !n.maintenance).map(n => n.node)
    const why = await this.gate({ ceph: ap0.ceph, nodes })
    if (why) return done(`Uneven, but not now: ${why}.`)
    const step = plan.steps[0]
    // The network cost: a move that shares corosync's network runs under the bandwidth limit, or not at all.
    if (b.map.network.shared !== false && step.method === 'migrate' && !step.bwlimitKiB) return done('Uneven, but the move would run without a bandwidth limit on the network corosync uses.')
    if (step.ha || step.method !== 'migrate') return done('Uneven, but the only move is of an HA guest, which automatic balancing never moves.')
    // Right before acting: the config as a person left it now. A stop or a change since the check began wins.
    const stillOn = async () => {
      const c = await this.d.store.auto()
      return c.epoch === epoch && c.settings.enabled && c.settings.apply && c.approval?.at === ap0.at
    }
    if (!(await stillOn())) return done('Stopped or changed while checking: nothing was moved.')
    try {
      await this.d.audit('placement.auto.plan', 'balance', { approver: ap0.email, sid: step.sid, from: step.from, to: step.to, scoreBefore: Math.round(plan.score.score), scoreAfter: Math.round(step.scoreAfter) })
    } catch { return done('Uneven, but the audit row could not be written, so nothing moved.') }
    if (this.planSlot) return done('Uneven, but a plan is running.')
    this.planSlot = 'auto'
    let rec: PlanRecord
    try {
      rec = await this.d.store.createPlan({
        source: 'auto', status: 'running', by: ap0.email, goal: plan.goal, scoreBefore: plan.score.score, scoreTarget: step.scoreAfter,
        steps: [stepRecord(step)], startedAt: this.now(), owner: this.owner, heartbeatAt: this.now(),
        snapshot: { settings: b.s, approver: { email: ap0.email, role: ap0.role, at: ap0.at }, ceph: ap0.ceph, nodes, auto: { approvedAt: ap0.at, epoch } },
      })
    } catch (e: any) { if (this.planSlot === 'auto') this.planSlot = null; return done(`Uneven, but the plan could not be stored (${String(e?.message ?? e).slice(0, 80)}).`) }
    this.planSlot = rec.id
    const abandon = async (error: string) => {
      await this.d.store.transitionPlan(rec.id, { status: ['running'], owner: this.owner }, {
        status: 'failed', endedAt: this.now(), error, steps: rec.steps.map(x => ({ ...x, status: 'skipped' as const, error })),
      }).catch(() => null)
      if (this.planSlot === rec.id) this.planSlot = null
    }
    try { await done(`Moving ${step.name || step.sid} from ${step.from} to ${step.to}.`) }
    catch (e: any) {
      await abandon(`Not run: automatic balancing could not record its own state (${String(e?.message ?? e).slice(0, 120)}).`)
      await this.d.notify?.('Automatic balancing could not record its state', ['A move was about to start and was not run: HyperProx could not save the check\'s state. Nothing moved.'], `placement:auto:state:${rec.id}`, 'warning').catch(() => undefined)
      return
    }
    if (!(await stillOn())) { await abandon('Not run: automatic balancing was stopped or changed just before the move.'); return }
    void this.runPlan(rec.id)
  }

  /** Scheduled plans whose time has come, and running plans whose process died (stopped, never resumed). */
  async planTick(): Promise<void> {
    for (const p of await this.d.store.listPlans({ status: ['running'], limit: 20 })) {
      if (p.owner === this.owner || this.planSlot === p.id) continue
      if (p.heartbeatAt !== null && this.now() - p.heartbeatAt < HEARTBEAT_STALE_MS) continue
      const steps = p.steps.map(x => (x.status === 'pending' ? { ...x, status: 'skipped' as const, error: 'HyperProx restarted during the plan.' } : x))
      const done = await this.d.store.transitionPlan(p.id, { status: ['running'], heartbeatBefore: this.now() - HEARTBEAT_STALE_MS }, {
        status: 'stopped', endedAt: this.now(), steps,
        error: 'HyperProx stopped while this plan was running (a restart). The moves that had not started did not run; a move under way is watched to its end in the move history.',
      })
      if (done) await this.d.notify?.('A balancing plan stopped', [done.error!], `placement:plan:${p.id}:stale`, 'warning').catch(() => undefined)
    }
    const due = (await this.d.store.listPlans({ status: ['scheduled'], limit: 20 })).filter(p => (p.scheduledFor ?? Infinity) <= this.now())
    for (const p0 of due) {
      const p = await this.d.store.getPlan(p0.id)
      if (!p || p.status !== 'scheduled') continue
      const skip = (error: string) => this.d.store.transitionPlan(p.id, { status: ['scheduled'] }, { status: 'skipped', endedAt: this.now(), error })
      if (this.now() - (p.scheduledFor ?? 0) > 30 * 60_000) { await skip('Its quiet window passed without it running (HyperProx was locked or restarting). Run it again.'); continue }
      if (!this.d.isUnlocked() || this.planSlot || this.slot) continue
      const ap = p.snapshot?.approver
      if (!ap || !APPROVER_ROLES.has(ap.role)) { await skip('Not run: no admin approval is recorded for it.'); continue }
      if (this.now() - ap.at > SCHEDULE_TTL_MS) { await skip('Not run: it was approved more than 7 days ago, and scheduled plans expire after 7 days.'); continue }
      const changed = this.d.approverChanged ? await this.d.approverChanged(ap.email, ap.at).catch(() => 'their role could not be checked') : null
      if (changed) { await skip(`Not run: ${ap.email} ${changed}.`); continue }
      const r = await this.read(true).catch(() => null)
      if (!r) continue
      const s = stricterSettings(p.snapshot?.settings, await this.d.store.settings())
      const needSec = Number(p.snapshot?.needSec) || 600
      const quiet = quietStatus({ now: this.now(), tz: r.tz, jobs: r.jobs, settings: s, needSec, jobsRead: r.jobsRead })
      if (!quiet.quietNow) { await skip(`Not run: it is not a quiet window for the whole plan (${quiet.nowWhy.join('; ')}).`); continue }
      try { await this.d.audit('placement.plan.scheduled-run', 'balance', { id: p.id, by: p.by }) }
      catch { await skip('Not run: the audit row could not be written.'); continue }
      if (this.planSlot) continue
      this.planSlot = p.id
      const claimed = await this.d.store.transitionPlan(p.id, { status: ['scheduled'] }, { status: 'running', startedAt: this.now(), owner: this.owner, heartbeatAt: this.now() })
      if (!claimed) { if (this.planSlot === p.id) this.planSlot = null; continue }
      void this.runPlan(p.id)
      break
    }
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
      await this.planTick().catch(() => undefined)
      await this.autoTick().catch(() => undefined)
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

type CephNow = { kind: 'none' } | { kind: 'unread'; why: string } | { kind: 'ok'; status: string; checks: string[]; osds: number; up: number }

/** Ceph checks that stop a move whatever was accepted when it was approved. */
export const CEPH_ALWAYS_BLOCK = ['PG_DEGRADED', 'PG_AVAILABILITY', 'OSD_DOWN', 'MON_DOWN']

/** Why Ceph's health stops a move, against the checks accepted at approval, or null. */
export function cephProblem(h: { status: string; checks: string[]; osds: number; up: number }, accepted: string[]): string | null {
  if (h.status === 'HEALTH_ERR') return 'Ceph is in HEALTH_ERR'
  if (h.up < h.osds) return `${h.osds - h.up} Ceph OSD${h.osds - h.up === 1 ? ' is' : 's are'} down`
  const always = h.checks.filter(x => CEPH_ALWAYS_BLOCK.includes(x))
  if (always.length) return `Ceph reports ${always.join(', ')}`
  const fresh = h.checks.filter(x => !accepted.includes(x))
  if (fresh.length) return `Ceph has a warning it did not have when the plan was approved (${fresh.join(', ')})`
  return null
}

/** A plan step as stored, from the step as planned. */
function stepRecord(x: { sid: string; name: string; from: string; to: string; method: 'ha' | 'migrate' }): PlanStepRecord {
  return { sid: x.sid, name: x.name, from: x.from, to: x.to, method: x.method, status: 'pending', moveId: null, error: null, startedAt: null, endedAt: null }
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
