// =============================================================================
//  HyperProx — Homepage: find dashboards, preview, write, keep in sync, fix
//
//  The flow a person sees: HyperProx finds each Homepage (its own Catalogue
//  installs, the shared service scan's Homepage probe, and the install marker in
//  a container's description); they connect one, which looks inside it once for
//  the Homepage container and the folder Docker mounts at /app/config (never a
//  guessed path). Then Preview shows the dashboard it would build and the line
//  diff of every file; Apply writes exactly what was previewed, each file backed
//  up first and refused if it changed in between, and checks Homepage's own
//  /api/services for every entry afterwards. Homepage reloads its config by
//  itself, so nothing is restarted.
//
//  Rules kept here, not in the routes:
//    - one write at a time per dashboard, and auto-sync takes the same lock
//    - the audit row is written before anything is changed; no row, no change
//    - nothing that leaves a secret on the guest (widget keys, the Proxmox
//      token) is done for an API token, and the routes put those behind the
//      master password (lib/roles.ts)
//    - auto-sync is off until someone turns it on, writes at most once every
//      ten minutes, and only when the content would change
// =============================================================================

import { randomUUID } from 'node:crypto'
import type { Machine } from '../remote/types'
import type { ExecResult } from '../node-exec'
import { KNOWN, type WidgetSource } from './catalog'
import {
  buildEntries, envNames, yaml, groupsOf, lineDiff, mergeEnv, mergeServices, mergeWidgets, parseServices, YamlProblem, varName,
} from './generate'
import { inventoryFingerprint } from './inventory'
import {
  composeUpScript, locateScript, sq, parseLocate, parseRead, parseVerify, parseWrite, readScript, safeContainer, safePath, sha256, stampOf,
  verifyScript, writeScript, type Located, type ReadFile, type VerifyResult,
} from './remote'
import { DEFAULT_OPTIONS, EMPTY_STATE, type Entry, type GenerateOptions, type Inventory, type ManagedState, type MergeNotes } from './types'

// ── records ──────────────────────────────────────────────────────────────────

export interface ProxmoxTokenRecord { tokenId: string; createdAt: number; createdBy: string }

export interface HomepageInstance {
  id: string
  machineId: string
  kind: 'lxc' | 'qemu'
  vmid: number
  node: string
  name: string
  container: string
  configDir: string
  composeDir: string | null
  composeFile: string | null
  port: number | null
  /** Where a person opens it: the public address when one serves it, else the LAN address. */
  url: string | null
  options: Omit<GenerateOptions, 'exportedVars'>
  autoSync: boolean
  state: ManagedState
  exportedVars: string[]
  proxmoxToken: ProxmoxTokenRecord | null
  lastSync: { at: number; by: string; ok: boolean; message: string; wrote: string[]; counts: Record<string, number>; backups: string[] } | null
  lastFingerprint: string | null
  addedBy: string
  addedAt: number
}

export interface Actor { email: string; token: string | null }

export interface Detected {
  machineId: string; kind: 'lxc' | 'qemu'; vmid: number; node: string; name: string
  url: string | null
  via: Array<'catalogue' | 'scan' | 'marker' | 'proxy'>
  running: boolean
  connected: string | null
}

export class HomepageRefusal extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = 'HomepageRefusal' }
}

// ── what the service reaches for ─────────────────────────────────────────────

export interface RecordStore {
  get(id: string): Promise<HomepageInstance | null>
  put(i: HomepageInstance): Promise<void>
  list(): Promise<HomepageInstance[]>
  delete(id: string): Promise<void>
}

export interface HomepageDeps {
  store: RecordStore
  exec: { listMachines(): Promise<Machine[]>; run(m: Machine, script: string, o?: { timeoutMs?: number; maxOutputBytes?: number }): Promise<ExecResult> }
  inventory(refresh: boolean): Promise<Inventory>
  /** Where Homepage was found: Catalogue install records, the shared scan, the install marker in a guest's notes. */
  sightings(): Promise<Array<{ vmid: number; url: string | null; via: 'catalogue' | 'scan' | 'marker' | 'proxy' }>>
  /** A widget's secret, from HyperProx's vault. null when it is not stored. */
  secret(src: WidgetSource, instanceId: string): Promise<string | null>
  proxmox: {
    /** Create a privilege-separated token with PVEAuditor on /. Returns its full id and its secret (shown once). */
    createAuditorToken(name: string, comment: string): Promise<{ tokenId: string; secret: string }>
    revokeToken(tokenId: string): Promise<void>
    /** Keep the token's secret in the vault. */
    saveSecret(instanceId: string, secret: string | null): Promise<void>
  }
  audit(action: string, resource: string, details: Record<string, unknown>): Promise<void>
  now(): number
  log?(m: string): void
}

// ── constants ────────────────────────────────────────────────────────────────

export const PLAN_TTL_MS = 10 * 60_000
export const AUTO_MIN_GAP_MS = 10 * 60_000
export const AUTO_TICK_MS = 5 * 60_000
const READ_FILES = ['services.yaml', 'widgets.yaml'] as const
const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/

export interface FilePlan { name: string; before: string; after: string; expectSha: string | null; diff: ReturnType<typeof lineDiff>; changed: boolean }

export interface Plan {
  id: string
  instanceId: string
  owner: string
  createdAt: number
  expiresAt: number
  files: FilePlan[]
  entries: Entry[]
  state: ManagedState
  notes: MergeNotes
  fingerprint: string
  counts: Record<string, number>
  errors: string[]
}

export interface Problem {
  id: string
  severity: 'bad' | 'warn'
  title: string
  detail: string
  fix: { id: string; label: string; confirm?: string; secure?: boolean } | null
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : one.endsWith('y') ? `${one.slice(0, -1)}ies` : `${one}s`}`

export class HomepageService {
  private plans = new Map<string, Plan>()
  private locks = new Map<string, Promise<unknown>>()
  private busy = new Set<string>()
  private autoTimer: ReturnType<typeof setInterval> | null = null
  private soon: ReturnType<typeof setTimeout> | null = null

  constructor(private d: HomepageDeps) {}

  // ── finding Homepage ──────────────────────────────────────────────────────

  async detected(): Promise<Detected[]> {
    const [machines, sightings, instances] = await Promise.all([
      this.d.exec.listMachines().catch(() => [] as Machine[]), this.d.sightings().catch(() => []), this.d.store.list(),
    ])
    const out = new Map<number, Detected>()
    for (const s of sightings) {
      const m = machines.find(x => (x.kind === 'lxc' || x.kind === 'qemu') && x.vmid === s.vmid)
      if (!m || m.tags?.includes('hyperprox-ignore')) continue
      const d = out.get(s.vmid) ?? { machineId: m.id, kind: m.kind as 'lxc' | 'qemu', vmid: s.vmid, node: m.node!, name: m.name, url: null, via: [], running: m.running, connected: null }
      if (!d.via.includes(s.via)) d.via.push(s.via)
      if (s.url && (!d.url || s.via === 'proxy')) d.url = s.url
      out.set(s.vmid, d)
    }
    for (const i of instances) {
      const d = out.get(i.vmid)
      if (d) d.connected = i.id
    }
    return [...out.values()].sort((a, b) => a.vmid - b.vmid)
  }

  async instances(): Promise<HomepageInstance[]> { return (await this.d.store.list()).sort((a, b) => a.vmid - b.vmid) }

  async instance(id: string): Promise<HomepageInstance> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HomepageRefusal('no_instance', 'No such dashboard.', 404)
    const i = await this.d.store.get(id)
    if (!i) throw new HomepageRefusal('no_instance', 'No such dashboard.', 404)
    return i
  }

  private async machine(i: Pick<HomepageInstance, 'machineId' | 'name'>): Promise<Machine> {
    const m = (await this.d.exec.listMachines()).find(x => x.id === i.machineId)
    if (!m) throw new HomepageRefusal('gone', `${i.name} is not on the cluster any more.`, 409)
    if (m.tags?.includes('hyperprox-ignore')) throw new HomepageRefusal('excluded', `${m.name} carries the hyperprox-ignore tag, so HyperProx does not look inside it.`, 409)
    if (!m.running) throw new HomepageRefusal('stopped', `${m.name} is not running.`, 409)
    return m
  }

  private async run(m: Machine, script: string, timeoutMs = 60_000): Promise<string> {
    const r = await this.d.exec.run(m, script, { timeoutMs, maxOutputBytes: 4 * 1024 * 1024 })
    if (r.timedOut) throw new HomepageRefusal('timeout', `${m.name} did not answer in time.`, 504)
    if (r.code !== 0) throw new HomepageRefusal('exec_failed', `Could not run the check on ${m.name} (exit ${r.code}).`, 502)
    return r.output
  }

  /** Look inside the guest for its Homepage container(s). */
  async locate(m: Machine): Promise<Located[]> {
    const r = parseLocate(await this.run(m, locateScript()))
    if (!r.ok) throw new HomepageRefusal(r.error ?? 'no_answer', r.error === 'no_docker' ? `${m.name} has no Docker, so no Homepage container to fill.` : `${m.name} did not answer the look-up.`, 409)
    return r.found
  }

  /** Connect one dashboard: look inside once for the container and its mounted config folder. */
  async connect(machineId: string, actor: Actor, container?: string): Promise<HomepageInstance> {
    if (!/^(lxc|qemu)-\d{1,9}$/.test(machineId)) throw new HomepageRefusal('bad_input', 'Pick a guest from the list.')
    const existing = (await this.d.store.list()).find(i => i.machineId === machineId && (!container || i.container === container))
    if (existing) return existing
    const m = await this.machine({ machineId, name: machineId })
    await this.d.audit('homepage.connect', `homepage:${machineId}`, { by: actor.email, via: actor.token ? `token ${actor.token}` : 'session' })
    const found = (await this.locate(m)).filter(l => !container || l.container === container)
    if (!found.length) throw new HomepageRefusal('not_found', `No Homepage container on ${m.name}.`, 404)
    if (found.length > 1 && !container) throw new HomepageRefusal('several', `${m.name} runs ${found.length} Homepage containers; pick one: ${found.map(f => f.container).join(', ')}.`, 409)
    const l = found[0]
    if (!l.configDir) throw new HomepageRefusal('no_mount', `${l.container} has no folder mounted at /app/config, so its config cannot be written from outside it.`, 409)
    const sight = (await this.detected().catch(() => [])).find(x => x.machineId === machineId)
    const i: HomepageInstance = {
      id: randomUUID(), machineId, kind: m.kind as 'lxc' | 'qemu', vmid: m.vmid!, node: m.node!, name: m.name,
      container: safeContainer(l.container), configDir: safePath(l.configDir), composeDir: l.composeDir, composeFile: l.composeFile, port: l.port,
      url: sight?.url ?? null,
      options: { excludeSubnets: [], includeBareGuests: false, hiddenGroups: [], hiddenEntries: [], widgets: [] },
      autoSync: false, state: { ...EMPTY_STATE }, exportedVars: [], proxmoxToken: null, lastSync: null, lastFingerprint: null,
      addedBy: actor.email, addedAt: this.d.now(),
    }
    await this.d.store.put(i)
    return i
  }

  async disconnect(id: string, actor: Actor): Promise<void> {
    const i = await this.instance(id)
    if (i.proxmoxToken) throw new HomepageRefusal('token_live', 'Revoke the Proxmox token made for this dashboard first, so it is not left behind.', 409)
    await this.d.audit('homepage.disconnect', `homepage:${i.machineId}`, { by: actor.email })
    await this.d.store.delete(id)
  }

  // ── settings ─────────────────────────────────────────────────────────────

  async saveSettings(id: string, body: Record<string, unknown>, actor: Actor): Promise<HomepageInstance> {
    return this.withLock(id, async () => {
      const i = await this.instance(id)
      const o = { ...i.options }
      if (body.excludeSubnets !== undefined) {
        const list = Array.isArray(body.excludeSubnets) ? body.excludeSubnets.map(String).map(s => s.trim()).filter(Boolean) : null
        if (!list || list.length > 32 || list.some(c => { const m = CIDR.exec(c); return !m || m.slice(1, 5).some(x => Number(x) > 255) || Number(m[5]) < 8 || Number(m[5]) > 32 })) {
          throw new HomepageRefusal('bad_input', 'Excluded subnets are written like 192.0.2.0/24, at most 32 of them.')
        }
        o.excludeSubnets = [...new Set(list)]
      }
      if (body.includeBareGuests !== undefined) o.includeBareGuests = body.includeBareGuests === true
      for (const k of ['hiddenGroups', 'hiddenEntries'] as const) {
        if (body[k] === undefined) continue
        const list = Array.isArray(body[k]) ? (body[k] as unknown[]).map(String).filter(s => s.length > 0 && s.length <= 200) : null
        if (!list || list.length > 500) throw new HomepageRefusal('bad_input', `${k} must be a list.`)
        o[k] = [...new Set(list)]
      }
      const autoSync = body.autoSync === undefined ? i.autoSync : body.autoSync === true
      const next = { ...i, options: o, autoSync }
      await this.d.audit('homepage.settings', `homepage:${i.machineId}`, { by: actor.email, autoSync, subnets: o.excludeSubnets.length, hiddenGroups: o.hiddenGroups.length, hiddenEntries: o.hiddenEntries.length, bareGuests: o.includeBareGuests })
      await this.d.store.put(next)
      return next
    })
  }

  /** Which entries get a service widget. Turning one on is what later puts its key on the guest. */
  async setWidgets(id: string, entryIds: unknown, actor: Actor): Promise<HomepageInstance> {
    if (actor.token) throw new HomepageRefusal('token_forbidden', 'API tokens cannot turn on widgets that need keys.', 403)
    const list = Array.isArray(entryIds) ? entryIds.map(String).filter(s => s.length <= 200).slice(0, 100) : null
    if (!list) throw new HomepageRefusal('bad_input', 'Send the list of entries to give a widget.')
    return this.withLock(id, async () => {
      const i = await this.instance(id)
      await this.d.audit('homepage.widgets', `homepage:${i.machineId}`, { by: actor.email, widgets: list })
      const next = { ...i, options: { ...i.options, widgets: [...new Set(list)] } }
      await this.d.store.put(next)
      return next
    })
  }

  // ── preview ──────────────────────────────────────────────────────────────

  private options(i: HomepageInstance): GenerateOptions { return { ...DEFAULT_OPTIONS, ...i.options, exportedVars: i.exportedVars } }

  private async readFiles(m: Machine, i: HomepageInstance, files: readonly string[] = READ_FILES) {
    const r = parseRead(await this.run(m, readScript(i.configDir, files)))
    if (!r.ok) throw new HomepageRefusal('no_answer', `${m.name} did not answer the read.`, 502)
    if (r.dirMissing) throw new HomepageRefusal('no_dir', `The config folder Homepage had is not there any more. Use "Find the config folder again".`, 409)
    return r
  }

  /** The dashboard this would write, and the diff of each file. Nothing is changed. */
  async preview(id: string, actor: Actor, refresh = false): Promise<Plan> {
    const i = await this.instance(id)
    const m = await this.machine(i)
    const [inv, read] = await Promise.all([this.d.inventory(refresh), this.readFiles(m, i)])
    const plan = this.planFrom(i, inv, read.files, actor.email)
    if (!read.writable) plan.errors.push('The config folder is not writable from the guest.')
    this.plans.set(plan.id, plan)
    this.prunePlans()
    return plan
  }

  private planFrom(i: HomepageInstance, inv: Inventory, files: Record<string, ReadFile>, owner: string): Plan {
    const opts = this.options(i)
    const entries = buildEntries(inv, opts)
    const services = files['services.yaml'] ?? { name: 'services.yaml', exists: false, text: '', sha: null, owner: null, mode: null }
    const widgets = files['widgets.yaml'] ?? { name: 'widgets.yaml', exists: false, text: '', sha: null, owner: null, mode: null }
    const merged = mergeServices(services.text, entries, i.state, { hiddenGroups: opts.hiddenGroups })
    const w = mergeWidgets(widgets.text)
    const out: FilePlan[] = [
      { name: 'services.yaml', before: services.text, after: merged.text, expectSha: services.sha, diff: lineDiff(services.text, merged.text), changed: merged.changed },
      { name: 'widgets.yaml', before: widgets.text, after: w.text, expectSha: widgets.sha, diff: w.changed ? lineDiff(widgets.text, w.text) : [], changed: w.changed },
    ]
    const counts: Record<string, number> = {}
    for (const g of groupsOf(entries, opts.hiddenGroups)) counts[g.group] = g.entries.length
    const now = this.d.now()
    return {
      id: randomUUID(), instanceId: i.id, owner, createdAt: now, expiresAt: now + PLAN_TTL_MS, files: out, entries, state: merged.state, notes: merged.notes,
      fingerprint: inventoryFingerprint(inv), counts, errors: [...inv.errors],
    }
  }

  private prunePlans() {
    const now = this.d.now()
    for (const [k, p] of this.plans) if (p.expiresAt < now) this.plans.delete(k)
  }

  // ── apply ────────────────────────────────────────────────────────────────

  /** Write exactly what the preview showed. Refused when it is old, someone else's, or the file changed since. */
  async apply(id: string, planId: unknown, actor: Actor): Promise<{ wrote: string[]; backups: string[]; verify: VerifyResult; unchanged: boolean }> {
    const p = typeof planId === 'string' ? this.plans.get(planId) : undefined
    if (!p || p.instanceId !== id) throw new HomepageRefusal('no_plan', 'That preview is not here any more. Preview again.', 409)
    if (p.owner !== actor.email) throw new HomepageRefusal('not_yours', 'That preview was made by someone else. Preview again.', 403)
    if (p.expiresAt < this.d.now()) { this.plans.delete(p.id); throw new HomepageRefusal('plan_expired', 'That preview is more than ten minutes old. Preview again.', 409) }
    return this.withLock(id, async () => {
      this.plans.delete(p.id)
      return this.write(await this.instance(id), p, actor.email)
    })
  }

  private async write(i: HomepageInstance, p: Plan, by: string) {
    const m = await this.machine(i)
    const changed = p.files.filter(f => f.changed)
    // Before anything changes: the audit row, or nothing happens.
    await this.d.audit('homepage.write', `homepage:${i.machineId}`, {
      by, files: changed.map(f => f.name), groups: Object.keys(p.counts), entries: p.entries.length, widgets: p.entries.filter(e => e.widget).length,
    })
    const wrote: string[] = [], backups: string[] = []
    const stamp = stampOf(this.d.now())
    for (const f of changed) {
      const out = parseWrite(await this.run(m, writeScript({ dir: i.configDir, file: f.name, content: f.after, expectSha: f.expectSha, mode: '0644', stamp })), f.after)
      if (!out.ok) {
        await this.record(i, { ok: false, by, message: `${f.name}: ${out.message}`, wrote, counts: p.counts, backups }, p)
        throw new HomepageRefusal(out.code === 'changed' ? 'changed' : 'write_failed', `${f.name}: ${out.message}${wrote.length ? ` (${wrote.join(', ')} was written already; its backup is beside it.)` : ''}`, 409)
      }
      wrote.push(f.name)
      if (out.backup) backups.push(out.backup)
    }
    // Homepage reloads by itself; ask it for its list and look for every entry.
    let verify: VerifyResult = { ok: true, reached: true, groups: [], missing: [] }
    const expect = groupsOf(p.entries, i.options.hiddenGroups).flatMap(g => g.entries.map(e => ({ group: this.fileGroupName(p, g.group), name: e.name })))
      .filter(e => p.state.managedGroups.includes(e.group) && (p.state.written[e.group]?.[e.name] !== undefined))
    if (wrote.includes('services.yaml') || !changed.length) {
      verify = parseVerify(await this.run(m, verifyScript(i.container, i.port)).catch(() => ''), expect)
    }
    const message = !changed.length ? 'Already up to date.'
      : verify.ok ? `Wrote ${wrote.join(' and ')}; Homepage shows all ${plural(expect.length, 'entry')}.`
      : verify.reached ? `Wrote ${wrote.join(' and ')}, but Homepage does not show ${verify.missing.slice(0, 5).join(', ')}${verify.missing.length > 5 ? '…' : ''}${verify.error ? ` (${verify.error})` : ''}.`
      : `Wrote ${wrote.join(' and ')}, but Homepage did not answer to confirm.`
    await this.record(i, { ok: verify.ok, by, message, wrote, counts: p.counts, backups }, p)
    return { wrote, backups, verify, unchanged: !changed.length }
  }

  private fileGroupName(p: Plan, group: string): string {
    const r = p.notes.renamed.find(x => x.from === group)
    return r ? r.to : group
  }

  private async record(i: HomepageInstance, r: { ok: boolean; by: string; message: string; wrote: string[]; counts: Record<string, number>; backups: string[] }, p: Plan) {
    const cur = (await this.d.store.get(i.id)) ?? i
    const wroteServices = r.wrote.includes('services.yaml')
    const next: HomepageInstance = {
      ...cur,
      state: wroteServices ? p.state : cur.state,
      // A HyperProx group the person deleted from the file stays gone: remember it as hidden.
      options: wroteServices && p.notes.userRemovedGroups.length
        ? { ...cur.options, hiddenGroups: [...new Set([...cur.options.hiddenGroups, ...p.notes.userRemovedGroups])] } : cur.options,
      lastSync: { at: this.d.now(), ...r },
      lastFingerprint: r.ok ? p.fingerprint : cur.lastFingerprint,
    }
    await this.d.store.put(next)
  }

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) throw new HomepageRefusal('busy', 'Something is already being written to this dashboard. Try again in a moment.', 409)
    this.busy.add(id)
    const run = fn()
    this.locks.set(id, run)
    try { return await run } finally { this.busy.delete(id); this.locks.delete(id) }
  }

  // ── auto-sync ────────────────────────────────────────────────────────────

  start(): () => void {
    if (this.autoTimer) return () => {}
    this.autoTimer = setInterval(() => { void this.tick() }, AUTO_TICK_MS)
    this.autoTimer.unref?.()
    return () => { if (this.autoTimer) clearInterval(this.autoTimer); this.autoTimer = null; if (this.soon) clearTimeout(this.soon); this.soon = null }
  }

  /** Something changed (a Catalogue install finished, a proxy host was made): look again in a minute. */
  inventoryChanged(): void {
    if (this.soon) return
    this.soon = setTimeout(() => { this.soon = null; void this.tick(true) }, 60_000)
    this.soon.unref?.()
  }

  /** One pass over every dashboard with auto-sync on. Returns what each did (tests read it). */
  async tick(refresh = false): Promise<Array<{ id: string; did: 'off' | 'same' | 'soon' | 'unchanged' | 'wrote' | 'failed' | 'busy'; message?: string }>> {
    const out: Array<{ id: string; did: 'off' | 'same' | 'soon' | 'unchanged' | 'wrote' | 'failed' | 'busy'; message?: string }> = []
    const list = await this.d.store.list().catch(() => [] as HomepageInstance[])
    if (!list.some(i => i.autoSync)) return list.map(i => ({ id: i.id, did: 'off' as const }))
    let inv: Inventory
    try { inv = await this.d.inventory(refresh) } catch (e: any) { return list.map(i => ({ id: i.id, did: 'failed' as const, message: String(e?.message ?? e) })) }
    const fp = inventoryFingerprint(inv)
    for (const i of list) {
      if (!i.autoSync) { out.push({ id: i.id, did: 'off' }); continue }
      if (i.lastFingerprint === fp) { out.push({ id: i.id, did: 'same' }); continue }
      if (i.lastSync && this.d.now() - i.lastSync.at < AUTO_MIN_GAP_MS) { out.push({ id: i.id, did: 'soon' }); continue }
      if (this.busy.has(i.id)) { out.push({ id: i.id, did: 'busy' }); continue }
      try {
        const r = await this.withLock(i.id, async () => {
          const m = await this.machine(i)
          const read = await this.readFiles(m, i)
          const p = this.planFrom(i, inv, read.files, 'auto-sync')
          if (!p.files.some(f => f.changed)) { await this.d.store.put({ ...i, lastFingerprint: fp }); return 'unchanged' as const }
          await this.write(i, p, `auto-sync (turned on for ${i.name})`)
          return 'wrote' as const
        })
        out.push({ id: i.id, did: r })
      } catch (e: any) {
        out.push({ id: i.id, did: 'failed', message: String(e?.message ?? e) })
        this.d.log?.(`[homepage] auto-sync of ${i.name} failed: ${e?.message ?? e}`)
        const cur = await this.d.store.get(i.id).catch(() => null)
        if (cur) await this.d.store.put({ ...cur, lastSync: { at: this.d.now(), by: 'auto-sync', ok: false, message: String(e?.message ?? e).slice(0, 300), wrote: [], counts: cur.lastSync?.counts ?? {}, backups: [] } }).catch(() => {})
      }
    }
    return out
  }

  // ── widget keys ──────────────────────────────────────────────────────────

  /** The variables the turned-on widgets need, and whether HyperProx holds each value. Never the values. */
  async widgetKeys(id: string): Promise<Array<{ entryId: string; name: string; type: string; vars: Array<{ field: string; name: string; held: boolean; exported: boolean }> }>> {
    const i = await this.instance(id)
    const inv = await this.d.inventory(false)
    const entries = buildEntries(inv, { ...this.options(i), widgets: i.options.widgets })
    const out = []
    for (const e of entries) {
      if (!e.offer?.enabled) continue
      const app = KNOWN.find(a => a.widget?.type === e.offer!.type)
      const vars = []
      for (const s of app?.widget?.secrets ?? []) {
        const v = await this.d.secret(s.from, i.id).catch(() => null)
        vars.push({ field: s.field, name: varName(e.id, s.field), held: !!v, exported: i.exportedVars.includes(varName(e.id, s.field)) })
      }
      out.push({ entryId: e.id, name: e.name, type: e.offer.type, vars })
    }
    return out
  }

  /**
   * Put the turned-on widgets' keys on the guest: into the compose .env (mode 0600), as HOMEPAGE_VAR_ values,
   * then recreate the Homepage container so it reads them. Plaintext on the guest: the page says so before this.
   */
  async exportKeys(id: string, actor: Actor): Promise<{ written: string[]; missing: string[]; restarted: boolean }> {
    if (actor.token) throw new HomepageRefusal('token_forbidden', 'API tokens cannot export keys.', 403)
    const plan = await this.widgetKeys(id)
    return this.withLock(id, async () => {
      const i = await this.instance(id)
      if (!i.composeDir) throw new HomepageRefusal('no_compose', `${i.container} was not started with Docker Compose, so there is no .env to put keys in.`, 409)
      const m = await this.machine(i)
      const values: Record<string, string> = {}
      const missing: string[] = []
      for (const w of plan) {
        const app = KNOWN.find(a => a.widget?.type === w.type)
        for (const s of app?.widget?.secrets ?? []) {
          const v = await this.d.secret(s.from, i.id)
          if (v) values[varName(w.entryId, s.field)] = v; else missing.push(`${w.name} (${s.field})`)
        }
      }
      const names = Object.keys(values)
      if (!names.length) throw new HomepageRefusal('nothing', missing.length ? `HyperProx holds none of the keys yet: ${missing.join(', ')}.` : 'No widget that needs a key is turned on.', 409)
      const read = parseRead(await this.run(m, readScript(i.composeDir, ['.env', i.composeFile?.split('/').pop() ?? 'docker-compose.yml'])))
      const composeName = i.composeFile?.split('/').pop() ?? 'docker-compose.yml'
      const compose = read.files[composeName]
      if (compose?.exists && !composeReadsEnv(compose.text, i.container)) {
        throw new HomepageRefusal('env_not_wired', 'Homepage\'s compose file does not pass the .env to the container. Use the "Let Homepage read its key file" fix first.', 409)
      }
      const env = read.files['.env'] ?? { exists: false, text: '', sha: null } as ReadFile
      const next = mergeEnv(env.text, values)
      await this.d.audit('homepage.export_keys', `homepage:${i.machineId}`, { by: actor.email, vars: names, missing: missing.length })
      const out = parseWrite(await this.run(m, writeScript({ dir: i.composeDir, file: '.env', content: next, expectSha: env.sha, mode: '0600', stamp: stampOf(this.d.now()) })), next)
      if (!out.ok) throw new HomepageRefusal('write_failed', `.env: ${out.message}`, 409)
      const up = await this.run(m, composeUpScript(i.composeDir, i.composeFile), 180_000)
      const restarted = /^HPX_UP ok$/m.test(up)
      const cur = (await this.d.store.get(i.id)) ?? i
      await this.d.store.put({ ...cur, exportedVars: [...new Set([...envNames(next)])], lastFingerprint: null })
      return { written: names, missing, restarted }
    })
  }

  // ── the Proxmox widget's token ───────────────────────────────────────────

  async createProxmoxToken(id: string, actor: Actor): Promise<{ tokenId: string }> {
    if (actor.token) throw new HomepageRefusal('token_forbidden', 'API tokens cannot create Proxmox tokens.', 403)
    return this.withLock(id, async () => {
      const i = await this.instance(id)
      if (i.proxmoxToken) throw new HomepageRefusal('exists', `This dashboard already has a token (${i.proxmoxToken.tokenId}). Revoke it to make a new one.`, 409)
      const name = `homepage-${i.vmid}-${i.id.slice(0, 6)}`
      await this.d.audit('homepage.proxmox_token.create', `homepage:${i.machineId}`, { by: actor.email, name, role: 'PVEAuditor', path: '/' })
      const t = await this.d.proxmox.createAuditorToken(name, `Homepage dashboard on ${i.name}: read-only (PVEAuditor), made by HyperProx`)
      try { await this.d.proxmox.saveSecret(i.id, t.secret) }
      catch (e) { await this.d.proxmox.revokeToken(t.tokenId).catch(() => {}); throw e }
      const proxmoxEntry = (await this.d.inventory(false).then(inv => buildEntries(inv, this.options(i))).catch(() => [] as Entry[])).find(e => e.id.startsWith('proxmox@'))
      const cur = (await this.d.store.get(i.id)) ?? i
      await this.d.store.put({ ...cur, proxmoxToken: { tokenId: t.tokenId, createdAt: this.d.now(), createdBy: actor.email },
        options: proxmoxEntry ? { ...cur.options, widgets: [...new Set([...cur.options.widgets, proxmoxEntry.id])] } : cur.options })
      return { tokenId: t.tokenId }
    })
  }

  async revokeProxmoxToken(id: string, actor: Actor): Promise<void> {
    if (actor.token) throw new HomepageRefusal('token_forbidden', 'API tokens cannot revoke Proxmox tokens.', 403)
    return this.withLock(id, async () => {
      const i = await this.instance(id)
      if (!i.proxmoxToken) throw new HomepageRefusal('none', 'This dashboard has no Proxmox token.', 404)
      await this.d.audit('homepage.proxmox_token.revoke', `homepage:${i.machineId}`, { by: actor.email, tokenId: i.proxmoxToken.tokenId })
      await this.d.proxmox.revokeToken(i.proxmoxToken.tokenId)
      await this.d.proxmox.saveSecret(i.id, null)
      const cur = (await this.d.store.get(i.id)) ?? i
      await this.d.store.put({ ...cur, proxmoxToken: null, options: { ...cur.options, widgets: cur.options.widgets.filter(w => !w.startsWith('proxmox@')) } })
    })
  }

  // ── problems and their fixes ─────────────────────────────────────────────

  async problems(id: string): Promise<Problem[]> {
    const i = await this.instance(id)
    const out: Problem[] = []
    let m: Machine
    try { m = await this.machine(i) } catch (e: any) {
      return [{ id: 'unreachable', severity: 'bad', title: 'The guest cannot be reached', detail: e.message, fix: e.code === 'stopped' ? null : { id: 'recheck', label: 'Check again' } }]
    }
    let located: Located | undefined
    try { located = (await this.locate(m)).find(l => l.container === i.container) } catch (e: any) {
      out.push({ id: 'unreachable', severity: 'bad', title: 'HyperProx cannot look inside the guest', detail: e.message, fix: { id: 'recheck', label: 'Check again' } })
      return out
    }
    if (!located) { out.push({ id: 'container_gone', severity: 'bad', title: `No container named ${i.container}`, detail: 'The Homepage container was removed or renamed.', fix: { id: 'relocate', label: 'Find Homepage again' } }); return out }
    if (located.configDir !== i.configDir) out.push({ id: 'config_moved', severity: 'bad', title: 'The config folder moved', detail: `Docker now mounts ${located.configDir ?? 'nothing'} at /app/config.`, fix: { id: 'relocate', label: 'Use the folder Docker mounts now' } })
    if (located.state !== 'running') out.push({ id: 'stopped', severity: 'bad', title: 'Homepage is not running', detail: `The container is ${located.state}.`, fix: { id: 'start', label: 'Start Homepage', confirm: `Start the ${i.container} container on ${i.name}?` } })
    let files: Record<string, ReadFile> = {}
    try {
      const r = await this.readFiles(m, i, [...READ_FILES])
      files = r.files
      if (!r.writable) out.push({ id: 'not_writable', severity: 'bad', title: 'The config folder is not writable', detail: 'Root on the guest cannot create a file in it (a read-only mount or file system). Make it writable on the guest, then check again.', fix: { id: 'recheck', label: 'Check again' } })
    } catch (e: any) { out.push({ id: 'unreadable', severity: 'bad', title: 'The config files cannot be read', detail: e.message, fix: { id: 'relocate', label: 'Find the config folder again' } }) }
    const svc = files['services.yaml']
    if (svc?.exists) {
      try { parseServices(svc.text) } catch (e: any) {
        out.push({ id: 'yaml_invalid', severity: 'bad', title: 'services.yaml is not valid', detail: `${e.message} Homepage shows no services until it is fixed.`,
          fix: { id: 'reset_services', label: 'Back it up and start it fresh', confirm: 'Copy services.yaml to a dated backup and replace it with HyperProx\'s groups only? Your groups stay in the backup.' } })
      }
    }
    if (files['widgets.yaml']?.exists) {
      try { mergeWidgets(files['widgets.yaml'].text) } catch (e: any) { out.push({ id: 'widgets_invalid', severity: 'warn', title: 'widgets.yaml is not valid', detail: e.message, fix: null }) }
    }
    if (located.state === 'running') {
      const v = parseVerify(await this.run(m, verifyScript(i.container, i.port)).catch(() => ''), [])
      if (!v.reached) out.push({ id: 'homepage_silent', severity: 'bad', title: 'Homepage does not answer', detail: v.error ?? 'No answer on /api/services.', fix: { id: 'start', label: 'Restart Homepage', confirm: `Restart the ${i.container} container on ${i.name}?` } })
      else if (v.error) out.push({ id: 'homepage_error', severity: 'warn', title: 'Homepage answered with an error', detail: v.error, fix: null })
    }
    // Widgets turned on whose keys are not on the guest yet, or that HyperProx does not hold.
    const keys = await this.widgetKeys(id).catch(() => [])
    const pending = keys.filter(k => k.vars.some(v => !v.exported))
    const unheld = keys.filter(k => k.vars.some(v => !v.held))
    if (unheld.length) out.push({ id: 'widget_no_key', severity: 'warn', title: `${plural(unheld.length, 'widget')} without a key in HyperProx`, detail: `${unheld.map(k => k.name).join(', ')}: add the key in that plug-in's settings, or turn the widget off.`, fix: { id: 'widgets_off', label: 'Turn those widgets off' } })
    else if (pending.length) out.push({ id: 'widget_pending', severity: 'warn', title: `${plural(pending.length, 'widget')} waiting for keys`, detail: `${pending.map(k => k.name).join(', ')} are turned on, but their keys are not on the guest yet, so they are left out of services.yaml.`, fix: { id: 'export_keys', label: 'Write the keys to the guest', secure: true } })
    if (keys.length && i.composeDir) {
      const name = i.composeFile?.split('/').pop() ?? 'docker-compose.yml'
      const r = await this.run(m, readScript(i.composeDir, [name])).then(parseRead).catch(() => null)
      const c = r?.files[name]
      if (c?.exists && !composeReadsEnv(c.text, i.container)) out.push({ id: 'env_not_wired', severity: 'warn', title: 'Homepage does not read its .env', detail: 'Its compose file uses the .env only for its own settings, so keys put there never reach the widgets.', fix: { id: 'wire_env', label: 'Let Homepage read its key file', confirm: 'Back up the compose file, add `env_file: .env` to the Homepage service, and recreate the container (a few seconds offline)?' } })
    }
    return out
  }

  async fix(id: string, fixId: unknown, actor: Actor): Promise<{ message: string }> {
    const known = ['recheck', 'relocate', 'start', 'reset_services', 'widgets_off', 'wire_env'] as const
    if (!known.includes(fixId as any)) throw new HomepageRefusal('bad_input', fixId === 'export_keys' ? 'Writing keys has its own button (it needs the master password).' : 'Not a fix HyperProx knows.')
    const f = fixId as typeof known[number]
    if (f === 'recheck') return { message: 'Checked again.' }
    return this.withLock(id, async () => {
      const i = await this.instance(id)
      const m = await this.machine(i)
      await this.d.audit('homepage.fix', `homepage:${i.machineId}`, { by: actor.email, fix: f })
      if (f === 'relocate') {
        const found = await this.locate(m)
        const l = found.find(x => x.container === i.container) ?? (found.length === 1 ? found[0] : undefined)
        if (!l?.configDir) throw new HomepageRefusal('not_found', found.length > 1 ? 'Several Homepage containers run there; disconnect and connect the one you want.' : 'No Homepage container with a mounted config folder was found.', 409)
        await this.d.store.put({ ...i, container: safeContainer(l.container), configDir: safePath(l.configDir), composeDir: l.composeDir, composeFile: l.composeFile, port: l.port })
        return { message: `Using ${l.container}, config at ${l.configDir}.` }
      }
      if (f === 'start') {
        const c = safeContainer(i.container)
        const out = await this.run(m, `set -u\nif docker restart ${sq(c)} >/dev/null 2>&1; then echo HPX_OK; else echo HPX_FAIL; fi\n`, 120_000)
        if (!/^HPX_OK$/m.test(out)) throw new HomepageRefusal('start_failed', `Docker could not start ${c}.`, 502)
        return { message: `${c} is starting.` }
      }
      if (f === 'widgets_off') {
        const keys = await this.widgetKeys(id).catch(() => [])
        const off = new Set(keys.filter(k => k.vars.some(v => !v.held)).map(k => k.entryId))
        await this.d.store.put({ ...i, options: { ...i.options, widgets: i.options.widgets.filter(w => !off.has(w)) } })
        return { message: `Turned off ${plural(off.size, 'widget')}. Preview and apply to take them off the dashboard.` }
      }
      if (f === 'wire_env') {
        if (!i.composeDir) throw new HomepageRefusal('no_compose', 'This container was not started with Docker Compose.', 409)
        const name = i.composeFile?.split('/').pop() ?? 'docker-compose.yml'
        const r = parseRead(await this.run(m, readScript(i.composeDir, [name])))
        const c = r.files[name]
        if (!c?.exists) throw new HomepageRefusal('no_compose', `No ${name} in ${i.composeDir}.`, 409)
        const next = wireEnv(c.text, i.container)
        if (next === null) return { message: 'Homepage already reads its .env.' }
        const out = parseWrite(await this.run(m, writeScript({ dir: i.composeDir, file: name as any, content: next, expectSha: c.sha, mode: '0644', stamp: stampOf(this.d.now()) })), next)
        if (!out.ok) throw new HomepageRefusal('write_failed', `${name}: ${out.message}`, 409)
        const up = await this.run(m, composeUpScript(i.composeDir, i.composeFile), 180_000)
        return { message: /^HPX_UP ok$/m.test(up) ? 'Homepage now reads its .env; the container was recreated.' : 'The compose file was changed (backup beside it), but recreating the container failed. Run docker compose up -d there.' }
      }
      // reset_services: back up the broken file and write HyperProx's groups only.
      const read = await this.readFiles(m, i, ['services.yaml'])
      const cur = read.files['services.yaml']
      const inv = await this.d.inventory(false)
      const merged = mergeServices('', buildEntries(inv, this.options(i)), EMPTY_STATE, { hiddenGroups: i.options.hiddenGroups })
      const out = parseWrite(await this.run(m, writeScript({ dir: i.configDir, file: 'services.yaml', content: merged.text, expectSha: cur?.sha ?? null, mode: '0644', stamp: stampOf(this.d.now()) })), merged.text)
      if (!out.ok) throw new HomepageRefusal('write_failed', out.message, 409)
      await this.d.store.put({ ...i, state: merged.state, lastFingerprint: null })
      return { message: `services.yaml started fresh${out.backup ? `; the old one is at ${out.backup}` : ''}.` }
    })
  }

  // ── the gallery card ─────────────────────────────────────────────────────

  async readings(): Promise<Array<{ id: string; name: string; url: string | null; autoSync: boolean; lastSync: HomepageInstance['lastSync']; entries: number }>> {
    return (await this.instances()).map(i => ({ id: i.id, name: i.name, url: i.url, autoSync: i.autoSync, lastSync: i.lastSync,
      entries: Object.values(i.lastSync?.counts ?? {}).reduce((a, b) => a + b, 0) }))
  }
}

// ── compose: does Homepage get the .env? ─────────────────────────────────────

function composeService(doc: any, container: string): { key: string; svc: any } | null {
  const services = doc && typeof doc === 'object' ? doc.services : null
  if (!services || typeof services !== 'object') return null
  const entries = Object.entries(services) as Array<[string, any]>
  const hit = entries.find(([k, s]) => s?.container_name === container || container.endsWith(`-${k}-1`) || container.endsWith(`_${k}_1`))
    ?? entries.find(([, s]) => /gethomepage\/homepage|benphelps\/homepage/.test(String(s?.image ?? '')))
  return hit ? { key: hit[0], svc: hit[1] } : null
}

/** True when the Homepage service in this compose file passes .env into the container (env_file). */
export function composeReadsEnv(text: string, container: string): boolean {
  let doc: any
  try { doc = yaml.load(text) } catch { return false }
  const s = composeService(doc, container)
  if (!s) return false
  const ef = s.svc?.env_file
  const list = Array.isArray(ef) ? ef : ef ? [ef] : []
  return list.some((x: any) => { const p = typeof x === 'string' ? x : x?.path; return p === '.env' || p === './.env' })
}

/** The compose file with `env_file: [.env]` on the Homepage service; null when it already has it. Read back before use. */
export function wireEnv(text: string, container: string): string | null {
  const doc: any = yaml.load(text)
  const s = composeService(doc, container)
  if (!s) throw new HomepageRefusal('no_service', 'The compose file has no Homepage service HyperProx can recognise.', 409)
  if (composeReadsEnv(text, container)) return null
  const ef = s.svc.env_file
  s.svc.env_file = [...(Array.isArray(ef) ? ef : ef ? [ef] : []), '.env']
  const out = yaml.dump(doc, { lineWidth: -1, noRefs: true })
  if (!composeReadsEnv(out, container)) throw new HomepageRefusal('roundtrip', 'The changed compose file did not read back as meant.', 500)
  return out
}

