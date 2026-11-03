// =============================================================================
//  HyperProx — Remote access: the service
//
//  Jobs run one machine at a time and stop at the first failure. One job runs
//  at a time. On a Proxmox node, every change is wrapped in the guard: the
//  default routes, the resolver and quorum are read before and after, and any
//  difference rolls the change back on the spot.
//
//  A key is minted per machine just before `up`, revoked as soon as `up` ends
//  (used or not), and only ever in memory. Every byte of output passes through
//  a redactor made for that key before it reaches the job log.
// =============================================================================

import { randomUUID } from 'node:crypto'
import type { RemoteExecutor } from './executor'
import type { RemoteRecord, RemoteRecordInput, RemoteStore } from './store'
import {
  DETECT_SCRIPT, SNAPSHOT_SCRIPT, installScript, parseFacts, parseStatus, routingScript, statusScript, uninstallScript, updateScript,
  osSupport, upScript, type ClientStatus, type NetMode, type OsFacts, type Support,
} from './scripts'
import { checkRouting, clientFlags, planInstall, safeHostname, tunFix } from './planner'
import { compareSnapshots, parseSnapshot, snapshotReady, type NodeSnapshot } from './guard'
import { makeRedactor, redactKnownKeyShapes } from './redact'
import { TAG_RE } from './tailscale'
import {
  DOWNLOAD_URL, PROVIDER_IDS, PROVIDER_LABEL, isProviderId,
  type Machine, type ProviderDevice, type ProviderId, type RemoteProvider, type RoutingRequest,
} from './types'

export class RemoteInputError extends Error { constructor(m: string) { super(m); this.name = 'RemoteInputError' } }
export class RemoteBusyError extends Error { constructor(m: string, readonly jobId: string) { super(m); this.name = 'RemoteBusyError' } }
export class RemoteNotFoundError extends Error { constructor(m: string) { super(m); this.name = 'RemoteNotFoundError' } }

export type JobAction = 'install' | 'check' | 'update' | 'routing' | 'uninstall'

export interface JobRequest {
  action:      JobAction
  provider:    ProviderId
  machineIds:  string[]
  /** Tailscale tags or NetBird group names. Omitted: the provider's defaults from Settings. */
  tags?:       string[]
  mode?:       NetMode
  subnets?:    string[]
  exitNode?:   boolean
  acknowledge?: boolean
}

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
export interface JobStep { machineId: string; name: string; status: StepStatus; detail?: string }

export interface RemoteJob {
  id: string; action: JobAction; provider: ProviderId; by: string
  status: 'running' | 'completed' | 'failed'
  steps: JobStep[]; log: string; error?: string
  startedAt: string; finishedAt?: string
}

export type CellState = 'connected' | 'offline' | 'missing' | 'not-installed' | 'manual' | 'unconfigured' | 'unknown'

export interface RemoteCell {
  state: CellState
  /** True when HyperProx installed it (there is a record); false for a device found only by name. */
  managed: boolean
  ip: string | null; version: string | null; lastSeen: string | null; deviceName: string | null
  mode: NetMode | null; routes: string[]; exitNode: boolean; lastError: string | null
}

export interface RemoteMachineRow extends Machine { cells: Record<ProviderId, RemoteCell> }

export interface RemoteOverview {
  providers: Array<{ id: ProviderId; label: string; configured: boolean; error: string | null; devices: number }>
  machines: RemoteMachineRow[]
  activeJobId: string | null
}

export interface ProviderSettings { tags: string[]; managementUrl?: string }

export interface RemoteDeps {
  store:    RemoteStore
  exec:     RemoteExecutor
  /** The provider built from the vault, or null when it is not configured. */
  provider: (id: ProviderId) => Promise<RemoteProvider | null>
  providerSettings: (id: ProviderId) => Promise<ProviderSettings>
  log?:     (m: string) => void
}

const LOG_CAP = 40_000
const MAX_MACHINES = 100
const NB_GROUP_RE = /^[A-Za-z0-9 _.-]{1,64}$/
const MANUAL_KEY_REVOKE_MS = 30 * 60_000
const DEVICE_CACHE_MS = 30_000

class StepFailure extends Error {}

function emptyCell(state: CellState): RemoteCell {
  return { state, managed: false, ip: null, version: null, lastSeen: null, deviceName: null, mode: null, routes: [], exitNode: false, lastError: null }
}

export class RemoteAccessService {
  private jobs = new Map<string, RemoteJob>()
  private active: string | null = null
  private devices = new Map<ProviderId, { at: number; list: ProviderDevice[] }>()
  private pendingRevokes = new Set<{ timer: NodeJS.Timeout; run: () => void }>()

  constructor(private readonly d: RemoteDeps) {}

  getJob(id: string): RemoteJob | undefined { return this.jobs.get(id) }
  get activeJobId(): string | null { return this.active }

  /** Revoke every outstanding manual key now and clear the timers. */
  close(): void {
    for (const p of this.pendingRevokes) { clearTimeout(p.timer); p.run() }
    this.pendingRevokes.clear()
  }

  // ── Overview ──────────────────────────────────────────────────────────────

  private async deviceList(id: ProviderId, p: RemoteProvider, fresh = false): Promise<ProviderDevice[]> {
    const c = this.devices.get(id)
    if (!fresh && c && Date.now() - c.at < DEVICE_CACHE_MS) return c.list
    const list = await p.listDevices()
    this.devices.set(id, { at: Date.now(), list })
    return list
  }

  async overview(): Promise<RemoteOverview> {
    const [machines, records] = await Promise.all([this.d.exec.listMachines(), this.d.store.list()])
    const providers: RemoteOverview['providers'] = []
    const lists = new Map<ProviderId, ProviderDevice[] | null>()
    for (const id of PROVIDER_IDS) {
      let p: RemoteProvider | null = null
      let error: string | null = null
      try { p = await this.d.provider(id) } catch (e: any) { error = redactKnownKeyShapes(e?.message ?? String(e)) }
      let list: ProviderDevice[] | null = null
      if (p) { try { list = await this.deviceList(id, p) } catch (e: any) { error = redactKnownKeyShapes(e?.message ?? String(e)) } }
      lists.set(id, p ? list : null)
      providers.push({ id, label: PROVIDER_LABEL[id], configured: !!p, error, devices: list?.length ?? 0 })
    }

    const rows: RemoteMachineRow[] = machines.map(m => {
      const cells = {} as Record<ProviderId, RemoteCell>
      for (const id of PROVIDER_IDS) {
        const conf = providers.find(x => x.id === id)!.configured
        const rec = records.find(r => r.machineId === m.id && r.provider === id)
        const list = lists.get(id)
        if (!conf && !rec) { cells[id] = emptyCell('unconfigured'); continue }
        const dev = rec ? this.matchRecord(rec, list ?? []) : (list ?? []).find(x => (x.hostname ?? x.name).toLowerCase() === safeHostname(m.name))
        if (!rec && !dev) {
          cells[id] = emptyCell(m.kind === 'qemu' && /^win/i.test(m.ostype ?? '') ? 'manual' : 'not-installed')
          continue
        }
        const state: CellState = dev ? (dev.online ? 'connected' : 'offline') : list ? 'missing' : 'unknown'
        cells[id] = {
          state, managed: !!rec,
          ip: dev?.addresses[0] ?? rec?.address ?? null,
          version: dev?.version ?? rec?.version ?? null,
          lastSeen: dev?.lastSeen ?? null,
          deviceName: dev?.name ?? rec?.hostname ?? null,
          mode: rec?.mode ?? null, routes: rec?.routes ?? [], exitNode: rec?.exitNode ?? false, lastError: rec?.lastError ?? null,
        }
      }
      return { ...m, cells }
    })
    return { providers, machines: rows, activeJobId: this.active }
  }

  private matchRecord(rec: RemoteRecord, list: ProviderDevice[]): ProviderDevice | undefined {
    return list.find(x => rec.deviceId && x.id === rec.deviceId)
      ?? list.find(x => rec.nodeKey && x.nodeKey === rec.nodeKey)
      ?? list.find(x => rec.address && x.addresses.includes(rec.address))
  }

  private matchStatus(st: ClientStatus, list: ProviderDevice[], hostname: string): ProviderDevice | undefined {
    return list.find(x => st.nodeKey && x.nodeKey === st.nodeKey)
      ?? list.find(x => st.ip && x.addresses.includes(st.ip))
      ?? list.find(x => (x.hostname ?? x.name).toLowerCase() === hostname)
  }

  // ── Jobs ──────────────────────────────────────────────────────────────────

  startJob(req: JobRequest, by: string): RemoteJob {
    if (!isProviderId(req.provider)) throw new RemoteInputError('provider must be tailscale or netbird')
    const actions: JobAction[] = ['install', 'check', 'update', 'routing', 'uninstall']
    if (!actions.includes(req.action)) throw new RemoteInputError(`action must be one of ${actions.join(', ')}`)
    const ids = Array.isArray(req.machineIds) ? [...new Set(req.machineIds.map(String))] : []
    if (!ids.length) throw new RemoteInputError('Choose at least one machine')
    if (ids.length > MAX_MACHINES) throw new RemoteInputError(`At most ${MAX_MACHINES} machines per job`)
    if (req.action !== 'install' && ids.length !== 1) throw new RemoteInputError(`${req.action} works on one machine at a time`)
    if (ids.some(i => !/^(node|lxc|qemu|host)-[A-Za-z0-9._-]{1,120}$/.test(i))) throw new RemoteInputError('Unknown machine id format')
    if (req.mode !== undefined && req.mode !== 'kernel' && req.mode !== 'userspace') throw new RemoteInputError('mode must be kernel or userspace')
    if (req.tags !== undefined) {
      if (!Array.isArray(req.tags) || req.tags.length > 20) throw new RemoteInputError('tags must be a list of at most 20')
      const re = req.provider === 'tailscale' ? TAG_RE : NB_GROUP_RE
      const bad = req.tags.filter(t => typeof t !== 'string' || !re.test(t))
      if (bad.length) throw new RemoteInputError(req.provider === 'tailscale' ? `Not a Tailscale tag: ${bad.join(', ')} (tags look like tag:server)` : `Not a NetBird group name: ${bad.join(', ')}`)
    }
    if (req.action === 'routing') {
      if (!Array.isArray(req.subnets ?? []) || typeof (req.exitNode ?? false) !== 'boolean') throw new RemoteInputError('routing needs subnets (a list) and exitNode (true or false)')
    }
    if (this.active) throw new RemoteBusyError('A remote access job is already running', this.active)

    const job: RemoteJob = {
      id: randomUUID(), action: req.action, provider: req.provider, by, status: 'running',
      steps: ids.map(machineId => ({ machineId, name: machineId, status: 'pending' as StepStatus })),
      log: '', startedAt: new Date().toISOString(),
    }
    this.jobs.set(job.id, job)
    this.active = job.id
    void this.runJob(job, { ...req, machineIds: ids })
    return job
  }

  private append(job: RemoteJob, redact: (s: string) => string, chunk: string) {
    job.log = (job.log + redact(chunk)).slice(-LOG_CAP)
  }

  private async runJob(job: RemoteJob, req: JobRequest): Promise<void> {
    const plain = (s: string) => redactKnownKeyShapes(s)
    try {
      const provider = await this.d.provider(req.provider)
      if (!provider) throw new Error(`${PROVIDER_LABEL[req.provider]} is not configured. Add it under Settings → Credentials → Remote access.`)
      const settings = await this.d.providerSettings(req.provider)
      const machines = await this.d.exec.listMachines()
      const unknown = req.machineIds.filter(id => !machines.some(m => m.id === id))
      if (unknown.length) throw new Error(`No such machine: ${unknown.join(', ')}`)

      for (const step of job.steps) {
        const m = machines.find(x => x.id === step.machineId)!
        step.name = m.name
        step.status = 'running'
        this.append(job, plain, `\n── ${m.name} (${m.id}) ──\n`)
        try {
          step.detail = await this.runStep(job, req, provider, settings, m)
          step.status = 'done'
        } catch (e: any) {
          step.status = 'failed'
          step.detail = plain(e?.message ?? String(e))
          throw new StepFailure(`${m.name}: ${step.detail}`)
        }
      }
      job.status = 'completed'
    } catch (e: any) {
      job.status = 'failed'
      job.error = plain(e?.message ?? String(e))
    } finally {
      job.finishedAt = new Date().toISOString()
      // Released in the same tick the job's status settles, so a caller that sees it finished can start the next.
      if (this.active === job.id) this.active = null
      this.devices.delete(req.provider)
      await this.d.store.audit(`remote.${req.action}`, req.machineIds.join(','), {
        by: job.by, provider: req.provider, status: job.status, error: job.error ?? null,
        ...(req.action === 'routing' ? { subnets: req.subnets ?? [], exitNode: !!req.exitNode } : {}),
      }).catch(err => this.d.log?.(`[remote] audit write failed: ${err?.message}`))
    }
  }

  private async exec(job: RemoteJob, m: Machine, script: string, redact: (s: string) => string, timeoutMs = 15 * 60_000) {
    const r = await this.d.exec.run(m, script, { timeoutMs, onData: c => this.append(job, redact, c) })
    if (r.timedOut) throw new Error('timed out')
    return r
  }

  private async detect(job: RemoteJob, m: Machine): Promise<OsFacts> {
    const r = await this.exec(job, m, DETECT_SCRIPT, redactKnownKeyShapes, 60_000)
    if (r.code !== 0) throw new Error(`could not read the operating system (exit ${r.code})`)
    return parseFacts(r.output)
  }

  private async snapshot(job: RemoteJob, m: Machine): Promise<NodeSnapshot> {
    const r = await this.exec(job, m, SNAPSHOT_SCRIPT, redactKnownKeyShapes, 60_000)
    return r.code === 0 ? parseSnapshot(r.output) : parseSnapshot('')
  }

  /**
   * Run `change` on a node between two snapshots. Anything different afterwards runs `undo`, snapshots again
   * and fails with what changed and whether the undo restored the node. Not a node: just runs `change`.
   */
  private async guarded<T>(job: RemoteJob, m: Machine, change: () => Promise<T>, undo: () => Promise<void>): Promise<T> {
    if (m.kind !== 'node') return change()
    const before = await this.snapshot(job, m)
    const notReady = snapshotReady(before)
    if (notReady) throw new Error(`${notReady}; nothing was changed`)
    let result: T | undefined
    let failure: unknown = null
    try { result = await change() } catch (e) { failure = e }
    const diff = compareSnapshots(before, await this.snapshot(job, m))
    if (diff.length) {
      let undoNote = ''
      try { await undo() } catch (e: any) { undoNote = ` The rollback itself failed: ${e?.message ?? e}.` }
      const left = compareSnapshots(before, await this.snapshot(job, m))
      throw new Error(`Rolled back because ${diff.join('; ')}.${undoNote} ` +
        (left.length ? `After the rollback the node still differs: ${left.join('; ')}. Check it by hand now.` : 'The node is back as it was.'))
    }
    if (failure) throw failure
    return result as T
  }

  private async runStep(job: RemoteJob, req: JobRequest, p: RemoteProvider, settings: ProviderSettings, m: Machine): Promise<string> {
    switch (req.action) {
      case 'install':   return this.install(job, req, p, settings, m)
      case 'check':     return this.check(job, req.provider, p, m)
      case 'update':    return this.update(job, req.provider, m)
      case 'routing':   return this.routing(job, req, p, settings, m)
      case 'uninstall': return this.uninstall(job, req.provider, p, m)
    }
  }

  private async install(job: RemoteJob, req: JobRequest, p: RemoteProvider, settings: ProviderSettings, m: Machine): Promise<string> {
    const facts = m.kind === 'qemu' && /^win/i.test(m.ostype ?? '') ? null : await this.detect(job, m)
    const plan = planInstall({ machine: m, provider: req.provider, facts, mode: req.mode })
    if (plan.kind === 'manual') {
      throw new Error(`${plan.os === 'windows' ? 'Windows' : 'macOS'} is not installed automatically. Download ${PROVIDER_LABEL[req.provider]} from ${DOWNLOAD_URL[req.provider]} and use “One-time key” on this machine.`)
    }
    if (plan.kind === 'refuse') throw new Error(plan.reason)
    if (plan.kind === 'needs-tun') {
      const fix = tunFix(await this.d.exec.lxcConfig(m).catch(() => ({})), m.vmid!)
      throw new Error(fix.configured
        ? `This container is configured with /dev/net/tun but cannot open it yet: restart it, or install in userspace mode.`
        : `This container has no /dev/net/tun. Either give it the device (“Add /dev/net/tun”, the same as \`${fix.command}\` on the node, then restart the container), or install in userspace mode.`)
    }

    const hostname = safeHostname(m.name)
    const flags = clientFlags(req.provider, { hostname, managementUrl: settings.managementUrl })
    const undo = async () => {
      await this.exec(job, m, uninstallScript(req.provider, plan.support), redactKnownKeyShapes, 5 * 60_000).catch(() => undefined)
      const dev = (await this.deviceList(req.provider, p, true).catch(() => [] as ProviderDevice[])).find(x => (x.hostname ?? x.name).toLowerCase() === hostname)
      if (dev) await p.deleteDevice(dev.id)
      await this.d.store.remove(m.id, req.provider)
    }

    const status = await this.guarded(job, m, async () => {
      const inst = await this.exec(job, m, installScript(req.provider, plan.support, plan.mode), redactKnownKeyShapes)
      if (inst.code !== 0) throw new Error(`installing the ${PROVIDER_LABEL[req.provider]} package failed (exit ${inst.code}); see the log`)
      const key = await p.mintKey({ name: `HyperProx ${m.id}`, tags: req.tags ?? settings.tags })
      const redact = makeRedactor([key.secret])
      try {
        const up = await this.exec(job, m, upScript(req.provider, { secret: key.secret, flags }), redact, 5 * 60_000)
        if (up.code !== 0) throw new Error(`${req.provider} up failed (exit ${up.code}); see the log`)
        return parseStatus(req.provider, up.output)
      } finally {
        await p.revokeKey(key.id).catch(e => this.append(job, redact, `\nCould not revoke the install key: ${e?.message ?? e}\n`))
      }
    }, undo)

    const dev = this.matchStatus(status, await this.deviceList(req.provider, p, true).catch(() => []), hostname)
    const prev = await this.d.store.get(m.id, req.provider)
    await this.d.store.upsert({
      machineId: m.id, provider: req.provider, deviceId: dev?.id ?? null, nodeKey: status.nodeKey ?? dev?.nodeKey ?? null,
      hostname: status.hostname ?? hostname, address: status.ip ?? dev?.addresses[0] ?? null, mode: plan.mode,
      version: status.version, routes: prev?.routes ?? [], exitNode: prev?.exitNode ?? false, routeIds: prev?.routeIds ?? [],
      connected: status.connected, checkedAt: new Date(), lastError: null,
    })
    const where = status.ip ? ` as ${status.ip}` : ''
    return `${status.connected ? 'Connected' : 'Installed, not connected yet'}${where} (${PROVIDER_LABEL[req.provider]} ${status.version ?? '?'}${plan.mode === 'userspace' ? ', userspace networking' : ''})` +
      (dev ? '' : '. Not found in the provider\'s device list yet.')
  }

  private async record(m: Machine, provider: ProviderId): Promise<RemoteRecord> {
    const r = await this.d.store.get(m.id, provider)
    if (!r) throw new Error(`HyperProx has not installed ${PROVIDER_LABEL[provider]} on ${m.name}`)
    return r
  }

  private async saveStatus(m: Machine, provider: ProviderId, st: ClientStatus, extra: Partial<RemoteRecordInput> = {}) {
    const prev = await this.d.store.get(m.id, provider)
    if (!prev) return
    const { installedAt: _i, updatedAt: _u, ...base } = prev
    await this.d.store.upsert({ ...base, address: st.ip ?? prev.address, version: st.version ?? prev.version, connected: st.connected, checkedAt: new Date(), lastError: null, ...extra })
  }

  private async check(job: RemoteJob, provider: ProviderId, p: RemoteProvider, m: Machine): Promise<string> {
    const r = await this.exec(job, m, statusScript(provider), redactKnownKeyShapes, 60_000)
    const st = parseStatus(provider, r.output)
    if (!st.installed) return `${PROVIDER_LABEL[provider]} is not installed`
    await this.saveStatus(m, provider, st)
    const dev = this.matchStatus(st, await this.deviceList(provider, p, true).catch(() => []), safeHostname(m.name))
    return `${st.connected ? 'Connected' : 'Not connected'}${st.ip ? ` as ${st.ip}` : ''}, version ${st.version ?? '?'}` +
      (dev ? `, matched to “${dev.name}” (last seen ${dev.lastSeen ?? 'never'})` : ', not in the provider\'s device list')
  }

  private async support(job: RemoteJob, m: Machine): Promise<Extract<Support, { ok: true }>> {
    const s = osSupport(await this.detect(job, m))
    if (!s.ok) throw new Error(s.reason)
    return s
  }

  private async update(job: RemoteJob, provider: ProviderId, m: Machine): Promise<string> {
    await this.record(m, provider)
    const s = await this.support(job, m)
    const r = await this.guarded(job, m, () => this.exec(job, m, updateScript(provider, s), redactKnownKeyShapes), async () => {
      // An update cannot be un-installed to the old version safely; restarting the client reapplies its flags.
      await this.exec(job, m, provider === 'tailscale' ? 'systemctl restart tailscaled' : 'netbird service restart', redactKnownKeyShapes, 60_000)
    })
    if (r.code !== 0) throw new Error(`the update failed (exit ${r.code}); see the log`)
    const st = parseStatus(provider, r.output)
    await this.saveStatus(m, provider, st)
    return `Now ${PROVIDER_LABEL[provider]} ${st.version ?? '?'}, ${st.connected ? 'connected' : 'not connected'}`
  }

  private async routing(job: RemoteJob, req: JobRequest, p: RemoteProvider, settings: ProviderSettings, m: Machine): Promise<string> {
    const r: RoutingRequest = { subnets: [...new Set((req.subnets ?? []).map(s => String(s).trim()).filter(Boolean))], exitNode: !!req.exitNode }
    const refusal = checkRouting(m, r, req.acknowledge === true)
    if (refusal) throw new Error(refusal)
    const rec = await this.record(m, req.provider)
    const flagsFor = (rr: RoutingRequest) => clientFlags(req.provider, { hostname: safeHostname(m.name), managementUrl: settings.managementUrl, routing: rr })
    const previous: RoutingRequest = { subnets: rec.routes, exitNode: rec.exitNode }
    const out = await this.guarded(job, m,
      () => this.exec(job, m, routingScript(req.provider, { ...r, flags: flagsFor(r) }), redactKnownKeyShapes, 2 * 60_000),
      async () => { await this.exec(job, m, routingScript(req.provider, { ...previous, flags: flagsFor(previous) }), redactKnownKeyShapes, 2 * 60_000) })
    if (out.code !== 0) throw new Error(`changing routing failed (exit ${out.code}); see the log`)
    const st = parseStatus(req.provider, out.output)
    const dev = this.matchRecord(rec, await this.deviceList(req.provider, p, true)) ?? this.matchStatus(st, await this.deviceList(req.provider, p), safeHostname(m.name))
    if (!dev) throw new Error('the machine is not in the provider\'s device list, so its routes cannot be approved there')
    const routeIds = await p.setRouting(dev, r, rec.routeIds)
    await this.saveStatus(m, req.provider, st, { routes: r.subnets, exitNode: r.exitNode, routeIds, deviceId: dev.id })
    const on = [...(r.subnets.length ? [`subnets ${r.subnets.join(', ')}`] : []), ...(r.exitNode ? ['exit node'] : [])]
    return on.length ? `Routing on: ${on.join(' and ')}` : 'Routing off'
  }

  private async uninstall(job: RemoteJob, provider: ProviderId, p: RemoteProvider, m: Machine): Promise<string> {
    const rec = await this.d.store.get(m.id, provider)
    let s: Extract<Support, { ok: true }> | null = null
    try { const x = osSupport(await this.detect(job, m)); s = x.ok ? x : null } catch { s = null }
    const r = await this.exec(job, m, uninstallScript(provider, s), redactKnownKeyShapes, 5 * 60_000)
    if (/HP_STILL_INSTALLED/.test(r.output) || !/HP_REMOVED/.test(r.output)) {
      throw new Error(`the client is still installed on ${m.name}; the device was left at ${PROVIDER_LABEL[provider]} so nothing is orphaned`)
    }
    const list = await this.deviceList(provider, p, true)
    const dev = rec ? this.matchRecord(rec, list) : list.find(x => (x.hostname ?? x.name).toLowerCase() === safeHostname(m.name))
    if (dev) {
      if (rec?.routeIds.length) await p.setRouting(dev, { subnets: [], exitNode: false }, rec.routeIds).catch(() => [])
      await p.deleteDevice(dev.id)
    }
    await this.d.store.remove(m.id, provider)
    return `Removed from ${m.name}${dev ? ` and deleted “${dev.name}” from ${PROVIDER_LABEL[provider]}` : '; no matching device was left at the provider'}`
  }

  // ── Containers: /dev/net/tun ──────────────────────────────────────────────

  async applyTun(machineId: string, by: string): Promise<{ applied: boolean; message: string; command?: string }> {
    const m = (await this.d.exec.listMachines()).find(x => x.id === machineId)
    if (!m) throw new RemoteNotFoundError(`No such machine: ${machineId}`)
    if (m.kind !== 'lxc') throw new RemoteInputError('Only containers need /dev/net/tun added')
    const fix = tunFix(await this.d.exec.lxcConfig(m), m.vmid!)
    if (fix.configured) return { applied: false, message: 'This container already has /dev/net/tun configured. Restart it if the device is not there yet.' }
    try {
      await this.d.exec.setLxcConfig(m, { [fix.param!]: fix.value! })
    } catch (e: any) {
      await this.d.store.audit('remote.tun', m.id, { by, applied: false, param: fix.param })
      return {
        applied: false, command: fix.command,
        message: `Proxmox did not accept the change from HyperProx (${redactKnownKeyShapes(String(e?.message ?? e)).slice(0, 200)}). Run this on node ${m.node} instead, then restart the container: ${fix.command}`,
      }
    }
    await this.d.store.audit('remote.tun', m.id, { by, applied: true, param: fix.param })
    return { applied: true, message: `Added ${fix.param}: /dev/net/tun. It takes effect when the container next restarts; HyperProx does not restart it for you.` }
  }

  // ── Manual flow (Windows, macOS) ──────────────────────────────────────────

  async manualKey(machineId: string, provider: ProviderId, tags: string[] | undefined, by: string): Promise<{ secret: string; expiresAt: string; downloadUrl: string; note: string }> {
    if (!isProviderId(provider)) throw new RemoteInputError('provider must be tailscale or netbird')
    const m = (await this.d.exec.listMachines()).find(x => x.id === machineId)
    if (!m) throw new RemoteNotFoundError(`No such machine: ${machineId}`)
    const p = await this.d.provider(provider)
    if (!p) throw new RemoteInputError(`${PROVIDER_LABEL[provider]} is not configured`)
    const settings = await this.d.providerSettings(provider)
    const key = await p.mintKey({ name: `HyperProx manual ${m.id}`, tags: tags ?? settings.tags })
    const entry = {
      timer: setTimeout(() => { entry.run(); this.pendingRevokes.delete(entry) }, MANUAL_KEY_REVOKE_MS),
      run: () => { void p.revokeKey(key.id).catch(() => undefined) },
    }
    entry.timer.unref?.()
    this.pendingRevokes.add(entry)
    await this.d.store.audit('remote.manual-key', m.id, { by, provider, expiresAt: key.expiresAt })
    return {
      secret: key.secret, expiresAt: key.expiresAt, downloadUrl: DOWNLOAD_URL[provider],
      note: provider === 'tailscale'
        ? 'Single use, expires in 10 minutes. In the app, sign in with an auth key, or run: tailscale up --auth-key=<key> --accept-dns=false --accept-routes=false'
        : 'Single use. HyperProx deletes it in 30 minutes. Run: netbird up --setup-key <key>' + (settings.managementUrl ? ` --management-url ${settings.managementUrl}` : ''),
    }
  }
}
