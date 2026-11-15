// =============================================================================
//  HyperProx — placement advisor: the service
//
//  Reads (the map, the advice, one guest), the move check, the move itself,
//  the history and the scheduler for moves held until the next quiet window.
//
//  A move, in order:
//    1. the check again, server side: the engine's verdict for that target,
//       Proxmox's own migrate preconditions, the quiet window, one move at a time;
//    2. the audit row (no row, no move);
//    3. the Proxmox call. An HA guest goes through HA
//       (POST /cluster/ha/resources/{sid}/migrate, what ha-manager migrate does):
//       a plain migrate is refused for HA guests, and HA would put it back.
//       Anything else: POST /nodes/{node}/{type}/{vmid}/migrate, form-encoded,
//       with restart=1 for a running container, online=1 for a running VM,
//       with-local-disks=1 when it has local disks, and the bandwidth limit;
//    4. wait for the task to finish, then read the cluster back: the guest must
//       be on the target (and running, if it was). Only then is it "done";
//    5. corosync's log around the move, when a node login is stored.
//
//  Scheduling: a move outside a quiet window can be held for the next one. It
//  is a row in the database, so it survives a restart; an in-process timer
//  picks it up. When its time comes the whole check runs again. It is skipped
//  (and says why) if anything changed, if HyperProx is locked (a restart locks
//  it, and only a person can unlock), or if its window passed.
// =============================================================================

import { parseSid, sidOf } from '../ha/parse'
import type { HaPve } from '../ha/read'
import type { Sid } from '../ha/types'
import { advise } from './advice'
import { corosyncAround, corosyncWords } from './corosync'
import { checkablePaths, placementMap, type EngineInput } from './engine'
import { copySeconds } from './network'
import { readCluster, readHistory, taskRunning, type ClusterRead, type PromRange } from './read'
import { mergeSettings, type PlacementStore } from './store'
import { backupMask, quietStatus, type QuietStatus } from './windows'
import type { Advice, GuestPlacement, MoveRecord, NetworkCost, PlacementMap, PlacementSettings } from './types'

export interface Actor { email: string }

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
  now?():     number
  sleep?(ms: number): Promise<void>
  /** How long to wait for a move's task, ms. */
  taskTimeoutMs?: number
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
}

const PATH_OK = /^\/[A-Za-z0-9._/ +-]{0,250}$/

export class PlacementService {
  private cache: { at: number; read: Promise<ClusterRead> } | null = null
  private pathChecks: Record<Sid, Record<string, Record<string, boolean | null>>> = {}
  private pathCheckedAt: Record<Sid, number> = {}
  private active = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  constructor(private d: PlacementDeps) {}

  private now() { return this.d.now ? this.d.now() : Date.now() }
  private sleep(ms: number) { return this.d.sleep ? this.d.sleep(ms) : new Promise<void>(r => setTimeout(r, ms)) }

  private read(fresh = false): Promise<ClusterRead> {
    const ttl = this.d.cacheMs ?? 10_000
    if (fresh || !this.cache || this.now() - this.cache.at > ttl) {
      const p = this.d.store.settings().then(s => readCluster(this.d.pve(), { suggestedBwlimit: s.bwlimitKiB, now: this.now() }))
      this.cache = { at: this.now(), read: p }
      p.catch(() => { this.cache = null })
    }
    return this.cache.read
  }

  private engineInput(r: ClusterRead, s: PlacementSettings): EngineInput {
    return { ...r.input, network: r.network, settings: { linkMbps: s.linkMbps, bwlimitKiB: s.bwlimitKiB }, pathChecks: this.pathChecks, now: this.now() }
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
    const quiet = quietStatus({ now: this.now(), tz: r.tz, jobs: r.jobs, settings: s })
    map.unread.push(...quiet.unread)
    return { map, quiet, settings: s, jobs: r.jobs }
  }

  async advice(): Promise<Advice> {
    const s = await this.d.store.settings()
    const r = await this.read()
    const map = placementMap(this.engineInput(r, s))
    const unread: string[] = []
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
    const a = advise({ map, nodes: hist.nodes, guests: hist.guests, masked, settings: s, stepSec: hist.stepSec, unread })
    a.unread.unshift(...map.unread)
    return a
  }

  /** One guest: its placement, its moves, and the last one in words. */
  async guest(sid: Sid): Promise<{ placement: GuestPlacement; moves: MoveRecord[]; lastMove: MovePlan['lastMove'] }> {
    const { map } = await this.map()
    const g = map.guests.find(x => x.sid === sid)
    if (!g) throw new PlacementRefusal(`There is no guest ${sid}.`, 404, 'not-found')
    await this.syncSeen().catch(() => undefined)
    const moves = await this.d.store.list({ sid, limit: 20 })
    return { placement: g, moves, lastMove: lastMoveOf(moves) }
  }

  /**
   * Checks whether each shared=1 bind-mount path of the guest exists on every node, over the node logins. Read-only
   * (`test -e`); a node without a login stays "unknown".
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

  async plan(sid: Sid, to: string, opts: { bwlimitKiB?: number } = {}, fresh = true): Promise<MovePlan> {
    const s = await this.d.store.settings()
    const r = await this.read(fresh)
    const map = placementMap(this.engineInput(r, s))
    const g = map.guests.find(x => x.sid === sid)
    if (!g) throw new PlacementRefusal(`There is no guest ${sid}.`, 404, 'not-found')
    if (!map.nodes.some(n => n.node === to)) throw new PlacementRefusal(`There is no node ${to}.`, 404, 'not-found')
    const refusals: string[] = [], warnings: string[] = []
    if (g.node === to) refusals.push(`It is already on ${to}.`)
    for (const x of g.everywhere) if (x.level === 'block') refusals.push(x.words); else if (x.level === 'warn') warnings.push(x.words)
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
    const quiet = quietStatus({ now: this.now(), tz: r.tz, jobs: r.jobs, settings: s, needSec })
    const moves = await this.d.store.list({ sid, limit: 10 })
    const lastMove = lastMoveOf(moves)
    if (lastMove) warnings.push(`Last time it moved (${lastMove.from} → ${lastMove.to}): ${lastMove.words}`)
    const call = method === 'ha'
      ? `POST /cluster/ha/resources/${sid}/migrate  node=${to}`
      : `POST /nodes/${g.node}/${p.type}/${p.vmid}/migrate  ${migrateParams({ type: g.type, status: g.status, local: localDisks }, to, bw).toString().replace(/&/g, ' ')}`
    return {
      sid, name: g.name, type: g.type, from: g.node, to, method, allowed: refusals.length === 0, refusals: Array.from(new Set(refusals)),
      warnings: Array.from(new Set(warnings)), running, downtimeSec: g.downtimeSec, copyBytes: g.copyBytes, copySec, localDisks, bwlimitKiB: bw,
      network: r.network, quiet, needsAnyway: !quiet.quietNow, call, lastMove,
    }
  }

  /** Start (or schedule) a move. The audit row is written before anything else; the move runs in the background. */
  async move(sid: Sid, to: string, opts: { when?: 'now' | 'next-quiet'; anyway?: boolean; bwlimitKiB?: number }, actor: Actor): Promise<MoveRecord> {
    if (!this.d.isUnlocked()) throw new PlacementRefusal('HyperProx is locked. Sign in to move a guest.', 423, 'locked')
    const plan = await this.plan(sid, to, { bwlimitKiB: opts.bwlimitKiB })
    if (!plan.allowed) throw new PlacementRefusal(`Not moved: ${plan.refusals.join(' ')}`, 409, 'refused', { refusals: plan.refusals })
    const running = await this.d.store.list({ status: ['running'] })
    if (running.length || this.active.size) throw new PlacementRefusal('Another move is running. One at a time: wait for it to finish.', 409, 'busy')
    const when = opts.when ?? 'now'
    if (when === 'now' && !plan.quiet.quietNow && !opts.anyway) {
      throw new PlacementRefusal(`Not a quiet window: ${plan.quiet.nowWhy.join('; ')}. Move anyway, or schedule it for the next quiet window.`, 409, 'not-quiet',
        { nextQuiet: plan.quiet.nextQuiet })
    }
    const at = when === 'next-quiet' && !plan.quiet.quietNow ? plan.quiet.nextQuiet?.start ?? null : null
    if (when === 'next-quiet' && !plan.quiet.quietNow && !at) throw new PlacementRefusal('There is no quiet window in the next week to schedule it in.', 409, 'no-window')
    // The audit row first: no row, no move.
    await this.d.audit(at ? 'placement.move.schedule' : 'placement.move', sid, {
      by: actor.email, from: plan.from, to, method: plan.method, anyway: !!opts.anyway && !plan.quiet.quietNow, scheduledFor: at ? new Date(at).toISOString() : null,
      bwlimitKiB: plan.bwlimitKiB, copyBytes: plan.copyBytes, downtimeSec: plan.downtimeSec,
    })
    const rec = await this.d.store.create({
      sid, name: plan.name, fromNode: plan.from, toNode: to, source: 'hyperprox', method: plan.method, status: at ? 'scheduled' : 'running',
      by: actor.email, scheduledFor: at, startedAt: at ? null : this.now(), bwlimitKiB: plan.bwlimitKiB,
    })
    if (!at) void this.execute(rec.id, plan).catch(() => undefined)
    return rec
  }

  /** Runs a move that was checked and audited: the call, the wait, the read-back, the corosync count. */
  async execute(id: string, plan: MovePlan): Promise<MoveRecord | null> {
    this.active.add(id)
    const pve = this.d.pve()
    const p = parseSid(plan.sid)!
    const startedSec = Math.floor(this.now() / 1000)
    try {
      let upid: string | null = null
      let node = plan.from
      if (plan.method === 'ha') {
        await pve.fetchStrict(`/cluster/ha/resources/${encodeURIComponent(plan.sid)}/migrate`, 'POST', new URLSearchParams({ node: plan.to }).toString())
        upid = await this.findMigrateTask(p.vmid, startedSec)
      } else {
        const body = migrateParams({ type: plan.type, status: plan.running ? 'running' : 'stopped', local: plan.localDisks }, plan.to, plan.bwlimitKiB)
        upid = await pve.fetchStrict<string>(`/nodes/${encodeURIComponent(plan.from)}/${p.type}/${p.vmid}/migrate`, 'POST', body.toString())
      }
      if (upid) {
        node = /^UPID:([^:]+):/.exec(upid)?.[1] ?? plan.from
        await this.d.store.update(id, { upid })
        await this.waitTask(node, upid)
      }
      // Read back: where is it now, and is it running if it was?
      const ok = await this.verify(plan, upid === null)
      const done = await this.d.store.update(id, { status: ok.ok ? 'done' : 'failed', endedAt: this.now(), error: ok.ok ? null : ok.why })
      await this.d.audit('placement.move.result', plan.sid, { ok: ok.ok, to: plan.to, why: ok.ok ? null : ok.why }).catch(() => undefined)
      await this.recordCorosync(id, [plan.from, plan.to], startedSec, Math.floor(this.now() / 1000)).catch(() => undefined)
      return done
    } catch (e: any) {
      const why = String(e?.message ?? e).slice(0, 500)
      await this.d.audit('placement.move.result', plan.sid, { ok: false, to: plan.to, why }).catch(() => undefined)
      return this.d.store.update(id, { status: 'failed', endedAt: this.now(), error: why })
    } finally {
      this.active.delete(id)
      this.cache = null
    }
  }

  /** The migration task HA starts for a guest after a request, or null when none appears in time. */
  private async findMigrateTask(vmid: number, sinceSec: number): Promise<string | null> {
    for (let waited = 0; waited < 120_000; waited += this.d.pollMs ?? 2000) {
      const tasks = await this.d.pve().fetchStrict<any[]>('/cluster/tasks').catch(() => [])
      const t = (tasks ?? []).filter(x => /^(qmigrate|vzmigrate)$/.test(String(x.type)) && String(x.id) === String(vmid) && Number(x.starttime) >= sinceSec - 5)
        .sort((a, b) => Number(b.starttime) - Number(a.starttime))[0]
      if (t?.upid) return String(t.upid)
      await this.sleep(this.d.pollMs ?? 2000)
    }
    return null
  }

  private async waitTask(node: string, upid: string): Promise<void> {
    const timeout = this.d.taskTimeoutMs ?? 2 * 3600_000
    const base = `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}`
    for (let waited = 0; ; waited += this.d.pollMs ?? 2000) {
      // A busy node can be slow to answer during a migration: that is "still running", not a failure.
      const st = await this.d.pve().fetchStrict<{ status: string; exitstatus?: string }>(`${base}/status`).catch(() => null)
      if (st?.status === 'stopped') {
        if (st.exitstatus === 'OK') return
        const log = await this.d.pve().fetchStrict<Array<{ t: string }>>(`${base}/log?limit=500`).catch(() => null)
        const tail = (Array.isArray(log) ? log : []).slice(-6).map(l => l.t).join(' / ')
        throw new Error(`The Proxmox task failed (${st.exitstatus ?? 'unknown'})${tail ? `: ${tail}` : ''}`)
      }
      if (waited >= timeout) throw new Error(`The Proxmox task is still running after ${Math.round(timeout / 60_000)} min; check its log in Proxmox.`)
      await this.sleep(this.d.pollMs ?? 2000)
    }
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
      await this.sleep(this.d.pollMs ?? 2000)
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

  async cancel(id: string, actor: Actor): Promise<MoveRecord> {
    const m = await this.d.store.get(id)
    if (!m) throw new PlacementRefusal('No such move.', 404, 'not-found')
    if (m.status !== 'scheduled') throw new PlacementRefusal(`It is ${m.status}; only a scheduled move can be cancelled.`, 409, 'not-scheduled')
    await this.d.audit('placement.move.cancel', m.sid, { by: actor.email, id })
    return (await this.d.store.update(id, { status: 'cancelled', endedAt: this.now() }))!
  }

  /** Proxmox migrations from the cluster task log, kept so they outlive it. Target nodes come from each task's log. */
  async syncSeen(): Promise<void> {
    const r = await this.read()
    const ours = new Set((await this.d.store.list({ limit: 500 })).map(m => m.upid).filter(Boolean))
    for (const t of r.tasks) {
      if (!/^(qmigrate|vzmigrate)$/.test(String(t.type)) || taskRunning(t) || !t.upid || ours.has(t.upid)) continue
      const node = String(t.node)
      const log = await this.d.pve().fetchStrict<Array<{ t: string }>>(`/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(t.upid)}/log?limit=40`).catch(() => null)
      const text = (Array.isArray(log) ? log : []).map(l => l.t).join('\n')
      const to = /to node '([^']+)'/.exec(text)?.[1] ?? /migrat\w* .* to (\S+)/.exec(text)?.[1]?.replace(/['".]/g, '') ?? ''
      const type = t.type === 'qmigrate' ? 'qemu' : 'lxc'
      const g = r.input.snap.guests.find(x => x.sid === sidOf(type, t.id))
      await this.d.store.upsertSeen({
        upid: String(t.upid), sid: sidOf(type, t.id), name: g?.name ?? '', fromNode: node, toNode: to, source: 'proxmox', method: null,
        status: t.status === 'OK' ? 'done' : 'failed', by: String(t.user ?? ''), startedAt: Number(t.starttime) * 1000,
        endedAt: Number(t.endtime) * 1000, error: t.status === 'OK' ? null : String(t.status ?? '').slice(0, 200),
      })
    }
  }

  async history(sid?: Sid): Promise<MoveRecord[]> {
    await this.syncSeen().catch(() => undefined)
    return this.d.store.list({ sid, limit: 200 })
  }

  async getMove(id: string): Promise<MoveRecord | null> { return this.d.store.get(id) }

  /** One pass of the scheduler: run what is due, skip what can no longer run. Exposed for tests. */
  async tick(): Promise<void> {
    const due = (await this.d.store.list({ status: ['scheduled'] })).filter(m => (m.scheduledFor ?? Infinity) <= this.now())
    for (const m of due) {
      if (this.now() - (m.scheduledFor ?? 0) > 30 * 60_000) {
        await this.d.store.update(m.id, { status: 'skipped', endedAt: this.now(), error: 'Its quiet window passed without it running (HyperProx was locked or restarting). Schedule it again.' })
        continue
      }
      // Locked: the Proxmox token is in the vault. Try again next minute, until the window passes.
      if (!this.d.isUnlocked() || this.active.size) continue
      let plan: MovePlan
      try { plan = await this.plan(m.sid, m.toNode, { bwlimitKiB: m.bwlimitKiB ?? undefined }) }
      catch (e: any) { await this.d.store.update(m.id, { status: 'skipped', endedAt: this.now(), error: `Not run: ${String(e?.message ?? e).slice(0, 300)}` }); continue }
      const why = !plan.allowed ? plan.refusals.join(' ') : !plan.quiet.quietNow ? `it is no longer quiet (${plan.quiet.nowWhy.join('; ')})` : plan.from !== m.fromNode ? `it moved to ${plan.from} in the meantime` : null
      if (why) { await this.d.store.update(m.id, { status: 'skipped', endedAt: this.now(), error: `Not run: ${why}` }); continue }
      await this.d.audit('placement.move.scheduled-run', m.sid, { id: m.id, by: m.by, to: m.toNode }).catch(() => undefined)
      await this.d.store.update(m.id, { status: 'running', startedAt: this.now() })
      await this.execute(m.id, plan)
    }
  }

  /** Every minute. A move marked running by a process that died is failed on start: nobody is waiting on it. */
  async start(): Promise<() => void> {
    for (const m of await this.d.store.list({ status: ['running'] }).catch(() => [] as MoveRecord[])) {
      if (!this.active.has(m.id)) await this.d.store.update(m.id, { status: 'failed', endedAt: this.now(), error: 'HyperProx restarted while it was waiting on this move. Check where the guest is in Proxmox.' })
    }
    if (!this.timer) this.timer = setInterval(() => { void this.tick().catch(() => undefined) }, 60_000)
    ;(this.timer as any).unref?.()
    return () => { if (this.timer) clearInterval(this.timer); this.timer = null }
  }
}

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

