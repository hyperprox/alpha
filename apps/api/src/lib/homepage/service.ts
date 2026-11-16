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
//    - a guest tagged hyperprox-ignore or on Remote access's exclusion list is
//      never contacted, and when that list cannot be read nothing is contacted
//    - one write at a time per dashboard, and auto-sync takes the same lock
//    - the audit row is written before anything is changed; no row, no change
//    - an inventory with a source missing is never written by auto-sync, and a
//      person must say "apply anyway" to write one (never without exclusions)
//    - nothing that leaves a secret on the guest (widget keys, the Proxmox
//      token) is done for an API token, and the routes put those behind the
//      master password (lib/roles.ts). Keys go in Homepage's own key file
//      (homepage.env), are taken out again when their widget, token or dashboard
//      goes, and are remembered by a hash so a rotated key is noticed
//    - auto-sync is off until someone turns it on, writes at most once every
//      ten minutes, and only when the content would change
// =============================================================================

import { createHash, randomUUID } from 'node:crypto'
import type { Machine } from '../remote/types'
import type { ExecResult } from '../node-exec'
import { KNOWN, type WidgetSource } from './catalog'
import {
  baseGroup, buildEntries, envNames, valueHash, yaml, groupsOf, lineDiff, mergeEnv, mergeServices, mergeWidgets, parseServices, pruneEnv, safeSecret,
  YamlProblem, varName,
} from './generate'
import { inventoryFingerprint } from './inventory'
import {
  KEY_FILE, backupsScript, composeUpScript, locateScript, parseLocate, parseRead, parseVerify, parseWrite, purgeBackupsScript, readScript,
  safeContainer, safePath, stampOf, verifyScript, writeScript, type Located, type ReadFile, type VerifyResult,
} from './remote'
import { IGNORE_TAG, exclusionReason, guestExcluded } from '../guest-guard'
import { invalidCidrs } from '../net/ip'
import { SYSTEM_ACTOR, exclusionOf, type AdapterContext, type Outcome } from '../auto-connect/core'
import { MANAGED_MARK } from './generate'
import {
  CRITICAL_SOURCES, DEFAULT_OPTIONS, EMPTY_STATE, type Entry, type GenerateOptions, type Inventory, type InventorySourceId, type ManagedState,
  type MergeNotes,
} from './types'
import { changedMessage } from '../log-once'
import { shq } from '../shell'
import { auditBy } from '../http/request-actor'

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
  /** Every file compose was started with; both the read and `compose up` use all of them. */
  composeFiles?: string[]
  port: number | null
  /** Where a person opens it: the public address when one serves it, else the LAN address. */
  url: string | null
  options: Omit<GenerateOptions, 'exportedVars' | 'pluginUrls'>
  autoSync: boolean
  state: ManagedState
  /** HOMEPAGE_VAR_ names in the guest's key file, each with a keyed hash of the value written (never the value). */
  exported: Record<string, string>
  proxmoxToken: ProxmoxTokenRecord | null
  lastSync: { at: number; by: string; ok: boolean; message: string; wrote: string[]; counts: Record<string, number>; backups: string[] } | null
  lastFingerprint: string | null
  addedBy: string
  addedAt: number
  /** Set when HyperProx connected it by itself (lib/auto-connect): when, how it was found, and the first fill if any. */
  autoConnected?: { at: number; evidence: string[]; firstFill: { at: number; reason: string; ok: boolean; message: string } | null } | null
}

export interface Actor { email: string; token: string | null }

/** Who did it, as the audit log and a preview's owner name them: a person, or a person's API token by name. */
export const actorLabel = (a: Actor) => (a.token ? `${a.email} (API token ${a.token})` : a.email)

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
  /** Remote access's "never look inside" machine ids. Throws when it cannot be read: then nothing is contacted. */
  excluded(): Promise<string[]>
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
  /** A person disconnected this guest's dashboard: auto-connect must never add it back by itself (lib/auto-connect). */
  dismissed?(machineId: string, label: string, by: string): Promise<void>
}

// ── constants ────────────────────────────────────────────────────────────────

export const PLAN_TTL_MS = 10 * 60_000
export const AUTO_MIN_GAP_MS = 10 * 60_000
export const AUTO_TICK_MS = 5 * 60_000
const READ_FILES = ['services.yaml', 'widgets.yaml'] as const
/** Proxmox's answer for a token that is not there (deleted by hand, or its user removed). */
const TOKEN_GONE = /no such (token|user)|does not exist|not found|HTTP 404/i

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
  /** Inventory sources that could not be read: applying then needs "apply anyway" (never without exclusions). */
  failed: InventorySourceId[]
}

export interface Problem {
  id: string
  severity: 'bad' | 'warn'
  title: string
  detail: string
  /** `secure`: the fix has its own button behind the master password (export_keys, wire_env). */
  fix: { id: string; label: string; confirm?: string; secure?: boolean } | null
}

/**
 * The rule for writing from an inventory with sources missing. Without the exclusion list, or without the guest list
 * the exclusions are applied through (exclusionOf walks it), never, "apply anyway" or not: either could put a guest
 * that must be left out on the dashboard. With another source missing, only when the person says "apply anyway".
 */
export function refusePartial(failed: InventorySourceId[], applyAnyway: boolean): void {
  const hard = failed.filter(f => f === 'exclusions' || f === 'guests')
  if (hard.length) {
    throw new HomepageRefusal('exclusions_unknown', `${hard.includes('exclusions') ? 'Remote access\'s exclusion list' : 'The guest list'} could not be read, so the exclusions cannot be applied and a guest that must be left out could be on the dashboard. Preview again when it can be read.`, 409)
  }
  if (failed.length && !applyAnyway) {
    throw new HomepageRefusal('partial_inventory', `Part of the inventory could not be read (${failed.join(', ')}), so entries could be missing or wrong. Tick "apply anyway" to write it regardless.`, 409)
  }
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : one.endsWith('y') ? `${one.slice(0, -1)}ies` : `${one}s`}`

/** A keyed hash of a key's value: tells a rotated key from the one written, without keeping the value. */
export const keyHash = (instanceId: string, value: string) => createHash('sha256').update(`homepage-key:${instanceId}:${value}`).digest('hex')

/** The secrets a widget needs, field by field. */
const widgetSecrets = (type: string) => KNOWN.find(a => a.widget?.type === type)?.widget?.secrets ?? []

export class HomepageService {
  private plans = new Map<string, Plan>()
  private busy = new Set<string>()
  private autoTimer: ReturnType<typeof setInterval> | null = null
  private soon: ReturnType<typeof setTimeout> | null = null

  constructor(private d: HomepageDeps) {}

  // ── exclusions ───────────────────────────────────────────────────────────

  /** Remote access's list, or a refusal: when it cannot be read, no guest is contacted. */
  private async excludedIds(): Promise<Set<string>> {
    try { return new Set(await this.d.excluded()) }
    catch { throw new HomepageRefusal('exclusions_unknown', 'Remote access\'s exclusion list could not be read, so HyperProx contacts no guest until it can.', 503) }
  }

  // ── finding Homepage ──────────────────────────────────────────────────────

  async detected(): Promise<Detected[]> {
    const [machines, sightings, instances, excluded] = await Promise.all([
      this.d.exec.listMachines().catch(() => [] as Machine[]), this.d.sightings().catch(() => []), this.d.store.list(), this.excludedIds(),
    ])
    const out = new Map<number, Detected>()
    for (const s of sightings) {
      const m = machines.find(x => (x.kind === 'lxc' || x.kind === 'qemu') && x.vmid === s.vmid)
      if (!m || guestExcluded(m, { excludedMachines: excluded })) continue
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

  /** The guest, when it may be contacted: there, running, not tagged, not on the exclusion list (read every time). */
  private async machine(i: Pick<HomepageInstance, 'machineId' | 'name'>): Promise<Machine> {
    const [machines, excluded] = await Promise.all([this.d.exec.listMachines(), this.excludedIds()])
    const m = machines.find(x => x.id === i.machineId)
    if (!m) throw new HomepageRefusal('gone', `${i.name} is not on the cluster any more.`, 409)
    const why = exclusionReason(m, { excludedMachines: excluded })
    if (why === 'tag') throw new HomepageRefusal('excluded', `${m.name} carries the ${IGNORE_TAG} tag, so HyperProx does not look inside it.`, 409)
    if (why) throw new HomepageRefusal('excluded', `${m.name} is on Remote access's "never look inside" list, so HyperProx does not contact it.`, 409)
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

  /** Connect one dashboard: look inside once for the container and its mounted config folder. One at a time per guest. */
  async connect(machineId: string, actor: Actor, container?: string, auto?: { evidence: string[] }): Promise<HomepageInstance> {
    if (!/^(lxc|qemu)-\d{1,9}$/.test(machineId)) throw new HomepageRefusal('bad_input', 'Pick a guest from the list.')
    return this.withLock(`connect:${machineId}`, async () => {
      const existing = (await this.d.store.list()).find(i => i.machineId === machineId && (!container || i.container === container))
      if (existing) return existing
      const m = await this.machine({ machineId, name: machineId })
      if (auto) await this.d.audit('homepage.auto_connect', `homepage:${machineId}`, { by: SYSTEM_ACTOR, evidence: auto.evidence, container: container ?? null })
      else await this.d.audit('homepage.connect', `homepage:${machineId}`, { ...auditBy(actorLabel(actor)) })
      const found = (await this.locate(m)).filter(l => !container || l.container === container)
      if (!found.length) throw new HomepageRefusal('not_found', `No Homepage container on ${m.name}.`, 404)
      if (found.length > 1 && !container) throw new HomepageRefusal('several', `${m.name} runs ${found.length} Homepage containers; pick one: ${found.map(f => f.container).join(', ')}.`, 409)
      const l = found[0]
      if ((await this.d.store.list()).some(i => i.machineId === machineId && i.container === l.container)) {
        return (await this.d.store.list()).find(i => i.machineId === machineId && i.container === l.container)!
      }
      if (!l.configDir) throw new HomepageRefusal('no_mount', `${l.container} has no folder mounted at /app/config, so its config cannot be written from outside it.`, 409)
      const sight = (await this.detected().catch(() => [])).find(x => x.machineId === machineId)
      const i: HomepageInstance = {
        id: randomUUID(), machineId, kind: m.kind as 'lxc' | 'qemu', vmid: m.vmid!, node: m.node!, name: m.name,
        container: safeContainer(l.container), configDir: safePath(l.configDir), composeDir: l.composeDir, composeFile: l.composeFile, composeFiles: l.composeFiles, port: l.port,
        url: sight?.url ?? null,
        options: { excludeSubnets: [], includeBareGuests: false, hiddenGroups: [], hiddenEntries: [], widgets: [] },
        autoSync: false, state: { ...EMPTY_STATE, released: [] }, exported: {}, proxmoxToken: null, lastSync: null, lastFingerprint: null,
        addedBy: auto ? SYSTEM_ACTOR : actorLabel(actor), addedAt: this.d.now(),
        autoConnected: auto ? { at: this.d.now(), evidence: auto.evidence.slice(0, 10), firstFill: null } : null,
      }
      await this.d.store.put(i)
      return i
    })
  }

  // ── auto-connect (lib/auto-connect) ───────────────────────────────────────

  /** Guests whose look-up found no Homepage container: not looked in again for an hour. */
  private noHomepage = new Map<string, number>()

  /**
   * One auto-connect pass. Every Homepage found and not connected yet is connected: the same read-only look-up a
   * person's Connect does, as the system. Never a guest that is excluded, stopped, or that a person disconnected.
   * Two Homepage containers in one guest are not guessed between: that is left as one choice to pick.
   * A dashboard connected this way gets its first fill only when the file is empty, Homepage's sample, or exactly
   * HyperProx's own earlier write (autoFirstFill); anything else waits for a person's Apply.
   */
  async autoConnect(ctx: AdapterContext): Promise<Outcome[]> {
    const out: Outcome[] = []
    const detected = await this.detected()
    const machines = await this.d.exec.listMachines()
    for (const d of detected) {
      const label = d.name
      if (d.connected) { out.push({ key: d.machineId, label, did: 'present' }); continue }
      const m = machines.find(x => x.id === d.machineId)
      const why = exclusionOf(ctx, { machineId: d.machineId, tags: m?.tags, addresses: [d.url, m?.address] })
      if (why) { out.push({ key: d.machineId, label, did: 'excluded', message: why }); continue }
      if (ctx.dismissed(d.machineId)) { out.push({ key: d.machineId, label, did: 'dismissed' }); continue }
      if (!d.running) { out.push({ key: d.machineId, label, did: 'skipped', message: 'not running' }); continue }
      const miss = this.noHomepage.get(d.machineId)
      if (miss && this.d.now() - miss < 60 * 60_000) { out.push({ key: d.machineId, label, did: 'skipped', message: 'no Homepage container' }); continue }
      try {
        const found = (await this.locate(m ?? await this.machine({ machineId: d.machineId, name: d.name }))).filter(l => !!l.configDir)
        if (!found.length) { this.noHomepage.set(d.machineId, this.d.now()); out.push({ key: d.machineId, label, did: 'skipped', message: 'no Homepage container with a mounted config folder' }); continue }
        if (found.length > 1) {
          out.push({ key: d.machineId, label, did: 'ambiguous', choiceKind: 'container', message: `${d.name} runs ${found.length} Homepage containers. Pick the one HyperProx fills.`,
            choices: found.map(f => ({ id: f.container, label: `${f.container} (${f.configDir})` })) })
          continue
        }
        // A person may have disconnected it while the look-up ran: read the dismissal again right before connecting.
        if (ctx.dismissed(d.machineId)) { out.push({ key: d.machineId, label, did: 'dismissed' }); continue }
        const i = await this.connect(d.machineId, { email: SYSTEM_ACTOR, token: null }, found[0].container, { evidence: d.via.map(v => `found by ${v}`) })
        out.push({ key: d.machineId, label, did: 'connected', evidence: d.via.map(v => `found by ${v}`), message: await this.autoFirstFill(i.id).catch((e: any) => `first fill not done: ${e?.message ?? e}`) })
      } catch (e: any) {
        out.push({ key: d.machineId, label, did: 'failed', message: String(e?.message ?? e).slice(0, 300) })
      }
    }
    return out
  }

  /** A person picked which Homepage container of a guest to connect. Excluded and dismissed guests are refused here too. */
  async autoPick(machineId: string, container: string, ctx: AdapterContext): Promise<Outcome> {
    const d = (await this.detected()).find(x => x.machineId === machineId)
    const m = (await this.d.exec.listMachines()).find(x => x.id === machineId)
    if (!d || !m || exclusionOf(ctx, { machineId, tags: m.tags, addresses: [d.url, m.address] }) || ctx.dismissed(machineId)) {
      throw new HomepageRefusal('excluded', 'That guest is not there any more, or HyperProx must leave it alone.', 409)
    }
    const i = await this.connect(machineId, { email: SYSTEM_ACTOR, token: null }, container, { evidence: ['picked by a person'] })
    return { key: machineId, label: i.name, did: 'connected', evidence: ['picked by a person'], message: await this.autoFirstFill(i.id).catch((e: any) => `first fill not done: ${e?.message ?? e}`) }
  }

  /**
   * The first fill of a dashboard HyperProx connected by itself, done by itself only when nothing of a person's can be
   * in the file: services.yaml missing or empty, Homepage's unmodified sample, or a file that is exactly HyperProx's
   * own earlier write (its header, only its groups, no entry a person added or edited). Every file is backed up first
   * (the same write as Apply), never from an inventory with a source missing, and audited as the system. Otherwise
   * nothing is written: the page shows the diff and one Apply.
   */
  async autoFirstFill(id: string): Promise<string> {
    return this.withLock(id, async () => {
      const i = await this.instance(id)
      if (!i.autoConnected || i.autoConnected.firstFill) return 'first fill already decided'
      const m = await this.machine(i)
      const inv = await this.d.inventory(false)
      const missing = (inv.failed ?? []).filter(s => CRITICAL_SOURCES.includes(s))
      if (missing.length) return `first fill waits: ${missing.join(', ')} could not be read`
      const read = await this.readFiles(m, i)
      if (!read.writable) return 'first fill not done: the config folder is not writable'
      const p = await this.planFrom(i, inv, read.files, SYSTEM_ACTOR)
      const reason = firstFillReason(read.files['services.yaml'], p)
      const record = async (fill: { reason: string; ok: boolean; message: string }) => {
        const cur = (await this.d.store.get(i.id)) ?? i
        await this.d.store.put({ ...cur, autoConnected: { ...(cur.autoConnected ?? { at: this.d.now(), evidence: [] }), firstFill: { at: this.d.now(), ...fill } } })
      }
      if (!reason) {
        await record({ reason: 'person', ok: true, message: 'The dashboard already holds your own groups: preview and apply it when you want HyperProx\'s groups added.' })
        return 'left for a person: the file holds their own groups'
      }
      try {
        const r = await this.write(i, p, `${SYSTEM_ACTOR}, first fill (${reason})`)
        await record({ reason, ok: true, message: r.unchanged ? 'Already up to date.' : `Wrote ${r.wrote.join(' and ')}${r.backups.length ? `; backups beside them` : ''}.` })
        return `first fill (${reason})`
      } catch (e: any) {
        await record({ reason, ok: false, message: String(e?.message ?? e).slice(0, 300) })
        throw e
      }
    })
  }

  /**
   * Stop filling a dashboard. Its keys are taken out of the guest's key file first; when the guest cannot be reached
   * that is refused, unless `force` says to leave them (the answer names them). Never while a Proxmox token is live.
   */
  async disconnect(id: string, actor: Actor, force = false): Promise<{ keysRemoved: string[]; keysLeft: string[] }> {
    return this.withLock(id, async () => {
      const i = await this.instance(id)
      if (i.proxmoxToken) throw new HomepageRefusal('token_live', 'Revoke the Proxmox token made for this dashboard first, so it is not left behind.', 409)
      await this.d.audit('homepage.disconnect', `homepage:${i.machineId}`, { ...auditBy(actorLabel(actor)), keys: Object.keys(i.exported).length, force })
      let removed: string[] = [], left: string[] = []
      if (Object.keys(i.exported).length) {
        try { removed = await this.removeKeys(i, Object.keys(i.exported)) }
        catch (e: any) {
          if (!force) throw new HomepageRefusal('keys_remain', `The widget keys could not be taken off ${i.name} (${e.message}). Try again when it answers, or disconnect anyway and remove ${KEY_FILE} there yourself.`, 409)
          left = Object.keys(i.exported)
        }
      }
      // Remembered before the record goes, so auto-connect never puts it straight back; not remembered, not removed.
      await this.d.dismissed?.(i.machineId, i.name, actorLabel(actor))
      await this.d.store.delete(id)
      return { keysRemoved: removed, keysLeft: left }
    })
  }

  /**
   * The guest this dashboard ran in was removed from Proxmox (lib/removed-guests): forget it. Nothing is left on a
   * guest to take off; the Proxmox token made for it is revoked (one already gone counts) and its secret leaves the
   * vault. No dismissal is kept: a new Homepage on that ID is a new install, and connects by itself.
   */
  async forgetRemoved(id: string, by: string): Promise<string> {
    return this.withLock(id, async () => {
      const i = await this.instance(id)
      await this.d.audit('homepage.forget_removed', `homepage:${i.machineId}`, { by, name: i.name, token: i.proxmoxToken?.tokenId ?? null })
      if (i.proxmoxToken) {
        try { await this.d.proxmox.revokeToken(i.proxmoxToken.tokenId) }
        catch (e: any) { if (!TOKEN_GONE.test(String(e?.message ?? e))) throw e }
        await this.d.proxmox.saveSecret(i.id, null)
      }
      await this.d.store.delete(id)
      return `Homepage forgot ${i.name}${i.proxmoxToken ? ', and its Proxmox token was revoked' : ''}.`
    })
  }

  // ── settings ─────────────────────────────────────────────────────────────

  async saveSettings(id: string, body: Record<string, unknown>, actor: Actor): Promise<HomepageInstance> {
    return this.withLock(id, async () => {
      const i = await this.instance(id)
      const o = { ...i.options }
      if (body.excludeSubnets !== undefined) {
        const list = Array.isArray(body.excludeSubnets) ? body.excludeSubnets.map(String).map(s => s.trim()).filter(Boolean) : null
        if (!list || list.length > 32 || invalidCidrs(list, { v4Only: true, minBits: 8 }).length) {
          throw new HomepageRefusal('bad_input', 'Excluded subnets are written like 192.0.2.0/24, at most 32 of them.')
        }
        o.excludeSubnets = [...new Set(list)]
      }
      if (body.includeBareGuests !== undefined) o.includeBareGuests = body.includeBareGuests === true
      for (const k of ['hiddenGroups', 'hiddenEntries'] as const) {
        if (body[k] === undefined) continue
        const list = Array.isArray(body[k]) ? (body[k] as unknown[]).map(String).filter(s => s.length > 0 && s.length <= 200) : null
        if (!list || list.length > 500) throw new HomepageRefusal('bad_input', `${k} must be a list.`)
        o[k] = [...new Set(k === 'hiddenGroups' ? list.map(baseGroup) : list)]
      }
      // The person takes one of HyperProx's groups over: it is theirs from now on, and HyperProx never writes it again.
      let state = i.state
      if (body.takeOver !== undefined) {
        const g = String(body.takeOver)
        if (!i.state.managedGroups.includes(g)) throw new HomepageRefusal('bad_input', 'That is not one of HyperProx\'s groups.')
        const written = { ...i.state.written }
        delete written[g]
        // Remembered by its exact name in the file ("Media (HyperProx)"), so handing it back takes back only it.
        state = { ...i.state, managedGroups: i.state.managedGroups.filter(x => x !== g), written, released: [...new Set([...(i.state.released ?? []), g])],
          parked: (i.state.parked ?? []).filter(x => x !== g), reclaim: (i.state.reclaim ?? []).filter(x => x !== g) }
      }
      // ...and hands it back: HyperProx takes it back on the next write, with only the entries that are exactly its own.
      if (body.manageAgain !== undefined) {
        const g = String(body.manageAgain)
        if (!(state.released ?? []).includes(g)) throw new HomepageRefusal('bad_input', 'That group is not one you took over.')
        state = { ...state, released: (state.released ?? []).filter(x => x !== g), reclaim: [...new Set([...(state.reclaim ?? []), g])] }
      }
      const autoSync = body.autoSync === undefined ? i.autoSync : body.autoSync === true
      const next: HomepageInstance = { ...i, options: o, autoSync, state, lastFingerprint: null }
      await this.d.audit('homepage.settings', `homepage:${i.machineId}`, { ...auditBy(actorLabel(actor)), autoSync, subnets: o.excludeSubnets.length, hiddenGroups: o.hiddenGroups.length,
        hiddenEntries: o.hiddenEntries.length, bareGuests: o.includeBareGuests, takeOver: body.takeOver === undefined ? null : String(body.takeOver),
        manageAgain: body.manageAgain === undefined ? null : String(body.manageAgain) })
      await this.d.store.put(next)
      return next
    })
  }

  /**
   * Which entries get a service widget. Turning one on is what later puts its key on the guest; turning one off takes
   * its key out of the guest's key file again.
   */
  async setWidgets(id: string, entryIds: unknown, actor: Actor, force = false): Promise<HomepageInstance> {
    if (actor.token) throw new HomepageRefusal('token_forbidden', 'API tokens cannot turn on widgets that need keys.', 403)
    const list = Array.isArray(entryIds) ? entryIds.map(String).filter(s => s.length <= 200).slice(0, 100) : null
    if (!list) throw new HomepageRefusal('bad_input', 'Send the list of entries to give a widget.')
    return this.withLock(id, async () => {
      const i = await this.instance(id)
      const wanted = new Set(list)
      const drop = Object.keys(i.exported).filter(v => ![...wanted].some(w => v.startsWith(varName(w, 'X').slice(0, -1))))
      await this.d.audit('homepage.widgets', `homepage:${i.machineId}`, { ...auditBy(actorLabel(actor)), widgets: list, keysRemoved: drop, force })
      // The keys of widgets turned off come off the guest first; only then is the choice saved. A guest that cannot
      // be reached keeps the old choice, unless `force` says to save it and leave those keys there.
      if (drop.length) {
        try { await this.removeKeys(i, drop) } catch (e: any) {
          if (!force) throw new HomepageRefusal('keys_remain', `The keys of the widgets turned off could not be taken off ${i.name} (${e.message}). Nothing was changed. Try again when it answers, or save anyway and remove them from ${KEY_FILE} there yourself.`, 409)
          const now = (await this.d.store.get(id)) ?? i
          const exported = { ...now.exported }
          for (const n of drop) delete exported[n]
          await this.d.store.put({ ...now, exported })
        }
      }
      const cur = (await this.d.store.get(id)) ?? i
      const next: HomepageInstance = { ...cur, options: { ...cur.options, widgets: [...wanted] }, lastFingerprint: null }
      await this.d.store.put(next)
      return next
    })
  }

  // ── keys: what is on the guest, and whether it is still the vault's ─────

  /**
   * For each turned-on widget the entries offer: its variables, whether HyperProx holds each value, whether the
   * guest has that same value. `valid` is the names whose value on the guest is still the vault's.
   */
  private async keyStatus(i: HomepageInstance, inv: Inventory) {
    const entries = buildEntries(inv, { ...DEFAULT_OPTIONS, ...i.options, exportedVars: Object.keys(i.exported) })
    const widgets: Array<{ entryId: string; name: string; type: string; vars: Array<{ field: string; name: string; held: boolean | null; unknown: boolean; exported: boolean; stale: boolean; value: string | null }> }> = []
    for (const e of entries) {
      if (!e.offer?.enabled) continue
      const vars = []
      for (const s of widgetSecrets(e.offer.type)) {
        const name = varName(e.id, s.field)
        // A vault that cannot be read says nothing about the key: what is on the guest is taken as it was (not rotated),
        // and nothing is written from it.
        let value: string | null | undefined
        try { value = await this.d.secret(s.from, i.id) } catch { value = undefined }
        const on = i.exported[name]
        const unknown = value === undefined
        vars.push({ field: s.field, name, held: unknown ? null : !!value, unknown,
          exported: !!on && (unknown || (!!value && on === keyHash(i.id, value))), stale: !unknown && !!on && (!value || on !== keyHash(i.id, value)), value: value ?? null })
      }
      widgets.push({ entryId: e.id, name: e.name, type: e.offer.type, vars })
    }
    const valid = widgets.flatMap(w => w.vars.filter(v => v.exported).map(v => v.name))
    return { widgets, valid }
  }

  /** The variables the turned-on widgets need, and whether HyperProx holds each value. Never the values. */
  async widgetKeys(id: string) {
    const i = await this.instance(id)
    const { widgets } = await this.keyStatus(i, await this.d.inventory(false))
    return widgets.map(w => ({ ...w, vars: w.vars.map(({ value: _v, ...rest }) => rest) }))
  }

  private options(i: HomepageInstance, valid: string[]): GenerateOptions { return { ...DEFAULT_OPTIONS, ...i.options, exportedVars: valid } }

  // ── preview ──────────────────────────────────────────────────────────────

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
    const plan = await this.planFrom(i, inv, read.files, actorLabel(actor))
    if (!read.writable) plan.errors.push('The config folder is not writable from the guest.')
    this.plans.set(plan.id, plan)
    this.prunePlans()
    return plan
  }

  private async planFrom(i: HomepageInstance, inv: Inventory, files: Record<string, ReadFile>, owner: string): Promise<Plan> {
    const { valid } = await this.keyStatus(i, inv)
    const opts = this.options(i, valid)
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
    const releasedBase = new Set((merged.state.released ?? []).map(baseGroup))
    for (const g of groupsOf(entries, opts.hiddenGroups)) if (!releasedBase.has(g.group)) counts[g.group] = g.entries.length
    const now = this.d.now()
    return {
      id: randomUUID(), instanceId: i.id, owner, createdAt: now, expiresAt: now + PLAN_TTL_MS, files: out, entries, state: merged.state, notes: merged.notes,
      fingerprint: inventoryFingerprint(inv), counts, errors: [...inv.errors], failed: [...(inv.failed ?? [])],
    }
  }

  private prunePlans() {
    const now = this.d.now()
    for (const [k, p] of this.plans) if (p.expiresAt < now) this.plans.delete(k)
  }

  // ── apply ────────────────────────────────────────────────────────────────

  /**
   * Write exactly what the preview showed. Refused when it is old, someone else's, or the file changed since; when a
   * source of the inventory could not be read, only with `applyAnyway` (and never when the exclusions are unknown).
   */
  async apply(id: string, planId: unknown, actor: Actor, o: { applyAnyway?: boolean } = {}): Promise<{ wrote: string[]; backups: string[]; verify: VerifyResult; unchanged: boolean }> {
    const p = typeof planId === 'string' ? this.plans.get(planId) : undefined
    if (!p || p.instanceId !== id) throw new HomepageRefusal('no_plan', 'That preview is not here any more. Preview again.', 409)
    if (p.owner !== actorLabel(actor)) throw new HomepageRefusal('not_yours', 'That preview was made by someone else. Preview again.', 403)
    if (p.expiresAt < this.d.now()) { this.plans.delete(p.id); throw new HomepageRefusal('plan_expired', 'That preview is more than ten minutes old. Preview again.', 409) }
    refusePartial(p.failed, o.applyAnyway === true)
    return this.withLock(id, async () => {
      this.plans.delete(p.id)
      return this.write(await this.instance(id), p, actorLabel(actor), o.applyAnyway === true && p.failed.length > 0)
    })
  }

  private async write(i: HomepageInstance, p: Plan, by: string, anyway = false) {
    const m = await this.machine(i)
    const changed = p.files.filter(f => f.changed)
    // Before anything changes: the audit row, or nothing happens.
    await this.d.audit('homepage.write', `homepage:${i.machineId}`, {
      ...auditBy(by), files: changed.map(f => f.name), groups: Object.keys(p.counts), entries: p.entries.length, widgets: p.entries.filter(e => e.widget).length,
      ...(anyway ? { applyAnyway: true, missingSources: p.failed } : {}),
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
    // Homepage reloads by itself; ask it for its list and look for every entry HyperProx wrote.
    let verify: VerifyResult = { ok: true, reached: true, groups: [], missing: [] }
    const expect = Object.entries(p.state.written).flatMap(([group, names]) => Object.keys(names).map(name => ({ group, name })))
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

  private async record(i: HomepageInstance, r: { ok: boolean; by: string; message: string; wrote: string[]; counts: Record<string, number>; backups: string[] }, p: Plan) {
    const cur = (await this.d.store.get(i.id)) ?? i
    const wroteServices = r.wrote.includes('services.yaml')
    // A HyperProx group the person deleted from the file stays gone: remember it as hidden, by its base name.
    const removed = p.notes.userRemovedGroups.map(baseGroup)
    const next: HomepageInstance = {
      ...cur,
      state: wroteServices ? p.state : cur.state,
      options: wroteServices && removed.length ? { ...cur.options, hiddenGroups: [...new Set([...cur.options.hiddenGroups, ...removed])] } : cur.options,
      lastSync: { at: this.d.now(), ...r },
      lastFingerprint: r.ok && !p.failed.length ? p.fingerprint : cur.lastFingerprint,
    }
    await this.d.store.put(next)
  }

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) throw new HomepageRefusal('busy', 'Something is already being written to this dashboard. Try again in a moment.', 409)
    this.busy.add(id)
    try { return await fn() } finally { this.busy.delete(id) }
  }

  // ── auto-sync ────────────────────────────────────────────────────────────

  start(): () => void {
    if (this.autoTimer) return () => {}
    this.autoTimer = setInterval(() => { void this.tick() }, AUTO_TICK_MS)
    this.autoTimer.unref?.()
    return () => { if (this.autoTimer) clearInterval(this.autoTimer); this.autoTimer = null; if (this.soon) clearTimeout(this.soon); this.soon = null }
  }

  /** Something changed (a Catalogue install finished, a proxy host was made): look again in a minute. */
  private invChanged = changedMessage()
  inventoryChanged(): void {
    if (this.soon) return
    this.soon = setTimeout(() => { this.soon = null; void this.tick(true) }, 60_000)
    this.soon.unref?.()
  }

  /** One pass over every dashboard with auto-sync on. Returns what each did (tests read it). */
  async tick(refresh = false): Promise<Array<{ id: string; did: 'off' | 'same' | 'soon' | 'unchanged' | 'wrote' | 'failed' | 'busy' | 'partial'; message?: string }>> {
    type Did = 'off' | 'same' | 'soon' | 'unchanged' | 'wrote' | 'failed' | 'busy' | 'partial'
    const out: Array<{ id: string; did: Did; message?: string }> = []
    const list = await this.d.store.list().catch(() => [] as HomepageInstance[])
    if (!list.some(i => i.autoSync)) return list.map(i => ({ id: i.id, did: 'off' as const }))
    let inv: Inventory
    try { inv = await this.d.inventory(refresh) } catch (e: any) {
      const message = String(e?.message ?? e)
      if (this.invChanged(message)) this.d.log?.(`[homepage] auto-sync could not read the inventory: ${message}`)
      return list.map(i => ({ id: i.id, did: 'failed' as const, message }))
    }
    // Never from a partial inventory: a missing source would take its entries off the dashboard, and missing
    // exclusions could put an excluded guest on it. The next pass tries again.
    const missing = (inv.failed ?? []).filter(s => CRITICAL_SOURCES.includes(s))
    const fp = inventoryFingerprint(inv)
    for (const listed of list) {
      if (!listed.autoSync) { out.push({ id: listed.id, did: 'off' }); continue }
      if (missing.length) { out.push({ id: listed.id, did: 'partial', message: `not read: ${missing.join(', ')}` }); this.d.log?.(`[homepage] auto-sync of ${listed.name} waits: ${missing.join(', ')} could not be read`); continue }
      if (this.busy.has(listed.id)) { out.push({ id: listed.id, did: 'busy' }); continue }
      try {
        const r = await this.withLock(listed.id, async (): Promise<Did> => {
          // What the record says now, not what it said before the lock: it may have been turned off or synced since.
          const i = await this.d.store.get(listed.id)
          if (!i || !i.autoSync) return 'off'
          if (i.lastFingerprint === fp) return 'same'
          if (i.lastSync && this.d.now() - i.lastSync.at < AUTO_MIN_GAP_MS) return 'soon'
          const m = await this.machine(i)
          const read = await this.readFiles(m, i)
          const p = await this.planFrom(i, inv, read.files, 'auto-sync')
          if (!p.files.some(f => f.changed)) { await this.d.store.put({ ...i, lastFingerprint: fp }); return 'unchanged' }
          await this.write(i, p, `auto-sync (turned on for ${i.name})`)
          return 'wrote'
        })
        out.push({ id: listed.id, did: r })
      } catch (e: any) {
        out.push({ id: listed.id, did: 'failed', message: String(e?.message ?? e) })
        this.d.log?.(`[homepage] auto-sync of ${listed.name} failed: ${e?.message ?? e}`)
        const cur = await this.d.store.get(listed.id).catch(() => null)
        if (cur) await this.d.store.put({ ...cur, lastSync: { at: this.d.now(), by: 'auto-sync', ok: false, message: String(e?.message ?? e).slice(0, 300), wrote: [], counts: cur.lastSync?.counts ?? {}, backups: [] } }).catch(() => {})
      }
    }
    return out
  }

  // ── the key file ─────────────────────────────────────────────────────────

  /** The compose file, its Homepage service's name, and whether that service reads homepage.env. */
  /**
   * The project's compose files, exactly as Docker recorded them. None known (a path HyperProx cannot name safely,
   * or no record) is a refusal: a guessed docker-compose.yml could be a different project's file.
   */
  private composeFilesOf(i: HomepageInstance): string[] {
    if (i.composeFiles?.length) return i.composeFiles
    if (i.composeFile && !('composeFiles' in i)) return [i.composeFile]
    throw new HomepageRefusal('compose_unknown', `HyperProx does not know ${i.container}'s compose files (Docker recorded none, or one whose path it will not name in a script), so it changes nothing there. Use "Find Homepage again" after fixing the path.`, 409)
  }

  /**
   * Every compose file the project was started with (read in its own folder), the Homepage service's name, which file
   * defines it (the one a wiring edit goes to), whether any of them gives it homepage.env, and the key file itself.
   */
  private async compose(m: Machine, i: HomepageInstance) {
    if (!i.composeDir) throw new HomepageRefusal('no_compose', `${i.container} was not started with Docker Compose, so there is no key file to put keys in.`, 409)
    const paths = this.composeFilesOf(i).map(safePath)
    const byDir = new Map<string, string[]>()
    for (const p of paths) { const d = p.slice(0, p.lastIndexOf('/')) || '/'; byDir.set(d, [...(byDir.get(d) ?? []), p.slice(p.lastIndexOf('/') + 1)]) }
    if (!byDir.has(i.composeDir)) byDir.set(i.composeDir, [])
    byDir.get(i.composeDir)!.push(KEY_FILE)
    const files: Record<string, ReadFile> = {}
    for (const [d, names] of byDir) {
      const r = parseRead(await this.run(m, readScript(d, [...new Set(names)])))
      for (const [n, f] of Object.entries(r.files)) files[`${d}/${n}`] = f
    }
    const docs: Array<{ path: string; file: ReadFile; doc: unknown }> = []
    for (const p of paths) {
      const f = files[p]
      if (!f?.exists) throw new HomepageRefusal('no_compose', `${p} is not there any more.`, 409)
      try { docs.push({ path: p, file: f, doc: yaml.load(f.text) }) } catch { throw new HomepageRefusal('compose_invalid', `${p} does not read as YAML.`, 409) }
    }
    const def = docs.map(d => ({ ...d, svc: composeService(d.doc, i.container) })).find(d => d.svc)
    if (!def) throw new HomepageRefusal('no_service', 'No compose file of this project has a Homepage service HyperProx can recognise.', 409)
    const service = def.svc!.key
    const wired = docs.some(d => serviceReadsKeyFile((d.doc as any)?.services?.[service]))
    const keyFile = files[`${i.composeDir}/${KEY_FILE}`] ?? { name: KEY_FILE, exists: false, text: '', sha: null, owner: null, mode: null } as ReadFile
    return { name: def.path.slice(def.path.lastIndexOf('/') + 1), dir: def.path.slice(0, def.path.lastIndexOf('/')) || '/', file: def.file, keyFile, service, wired, files: paths }
  }

  private async recreate(m: Machine, i: HomepageInstance, service: string): Promise<boolean> {
    return /^HPX_UP ok$/m.test(await this.run(m, composeUpScript(i.composeDir!, this.composeFilesOf(i), service), 180_000))
  }

  /** Take these variables out of the guest's key file (and out of the record), and recreate Homepage. */
  private async removeKeys(i: HomepageInstance, names: string[]): Promise<string[]> {
    const m = await this.machine(i)
    const c = await this.compose(m, i)
    const keep = Object.keys(i.exported).filter(n => !names.includes(n))
    const pruned = pruneEnv(c.keyFile.text, keep)
    if (c.keyFile.exists && pruned.removed.length) {
      const out = parseWrite(await this.run(m, writeScript({ dir: i.composeDir!, file: KEY_FILE, content: pruned.text, expectSha: c.keyFile.sha, mode: '0600', stamp: stampOf(this.d.now()) })), pruned.text)
      if (!out.ok) throw new HomepageRefusal('write_failed', `${KEY_FILE}: ${out.message}`, 409)
      if (c.wired) await this.recreate(m, i, c.service)
    }
    const cur = (await this.d.store.get(i.id)) ?? i
    const exported = { ...cur.exported }
    for (const n of names) delete exported[n]
    await this.d.store.put({ ...cur, exported, lastFingerprint: null })
    return pruned.removed
  }

  /**
   * Put the turned-on widgets' keys on the guest: into Homepage's own key file (homepage.env beside its compose
   * file, mode 0600 from the moment it exists), as HOMEPAGE_VAR_ values, then recreate the Homepage service only.
   * Keys no widget uses any more are taken out in the same write. Plaintext on the guest: the page says so first.
   */
  async exportKeys(id: string, actor: Actor): Promise<{ written: string[]; removed: string[]; missing: string[]; restarted: boolean }> {
    if (actor.token) throw new HomepageRefusal('token_forbidden', 'API tokens cannot export keys.', 403)
    return this.withLock(id, async () => {
      const i = await this.instance(id)
      const m = await this.machine(i)
      const { widgets } = await this.keyStatus(i, await this.d.inventory(false))
      const values: Record<string, string> = {}
      const missing: string[] = []
      if (widgets.some(w => w.vars.some(v => v.unknown))) throw new HomepageRefusal('vault_unreadable', 'HyperProx\'s vault could not be read, so no key is written. Try again once it is unlocked.', 423)
      for (const w of widgets) for (const v of w.vars) {
        if (!v.value) { missing.push(`${w.name} (${v.field})`); continue }
        if (!safeSecret(v.value)) throw new HomepageRefusal('unsafe_secret', `${w.name}'s ${v.field} holds a quote, a backslash, {{ or a line break, so it cannot be written safely. Change it in that plug-in's settings.`, 409)
        values[v.name] = v.value
      }
      const names = Object.keys(values)
      if (!names.length) throw new HomepageRefusal('nothing', missing.length ? `HyperProx holds none of the keys yet: ${missing.join(', ')}.` : 'No widget that needs a key is turned on.', 409)
      const c = await this.compose(m, i)
      if (!c.wired) throw new HomepageRefusal('env_not_wired', `Homepage's compose file does not pass ${KEY_FILE} to the container. Use "Let Homepage read its key file" first.`, 409)
      const pruned = pruneEnv(c.keyFile.text, names)
      const next = mergeEnv(pruned.text, values)
      await this.d.audit('homepage.export_keys', `homepage:${i.machineId}`, { ...auditBy(actorLabel(actor)), vars: names, removed: pruned.removed, missing: missing.length })
      const out = parseWrite(await this.run(m, writeScript({ dir: i.composeDir!, file: KEY_FILE, content: next, expectSha: c.keyFile.sha, mode: '0600', stamp: stampOf(this.d.now()) })), next)
      if (!out.ok) throw new HomepageRefusal('write_failed', `${KEY_FILE}: ${out.message}`, 409)
      const restarted = await this.recreate(m, i, c.service)
      const cur = (await this.d.store.get(i.id)) ?? i
      const exported: Record<string, string> = {}
      for (const n of envNames(next)) if (values[n]) exported[n] = keyHash(i.id, values[n])
      await this.d.store.put({ ...cur, exported, lastFingerprint: null })
      return { written: names, removed: pruned.removed, missing, restarted }
    })
  }

  /** Let the Homepage service read homepage.env: back up the compose file, add it as an env_file, make the file. */
  async wireEnv(id: string, actor: Actor): Promise<{ message: string }> {
    if (actor.token) throw new HomepageRefusal('token_forbidden', 'API tokens cannot change Homepage\'s compose file.', 403)
    return this.withLock(id, async () => {
      const i = await this.instance(id)
      const m = await this.machine(i)
      const c = await this.compose(m, i)
      if (c.wired) return { message: `Homepage already reads ${KEY_FILE}.` }
      await this.d.audit('homepage.wire_env', `homepage:${i.machineId}`, { ...auditBy(actorLabel(actor)), file: c.name })
      const stamp = stampOf(this.d.now())
      // The edit is worked out (and refused, with the line to add by hand) before anything is written.
      wireEnvText(c.file.text, c.service)
      if (!c.keyFile.exists) {
        const made = parseWrite(await this.run(m, writeScript({ dir: i.composeDir!, file: KEY_FILE, content: '', expectSha: null, mode: '0600', stamp })), '')
        if (!made.ok) throw new HomepageRefusal('write_failed', `${KEY_FILE}: ${made.message}`, 409)
      }
      const next = wireEnvText(c.file.text, c.service)
      if (next === null) return { message: `Homepage already reads ${KEY_FILE}.` }
      const out = parseWrite(await this.run(m, writeScript({ dir: c.dir, file: c.name as any, content: next, expectSha: c.file.sha, mode: '0644', stamp })), next)
      if (!out.ok) throw new HomepageRefusal('write_failed', `${c.name}: ${out.message}`, 409)
      return { message: (await this.recreate(m, i, c.service)) ? `Homepage now reads ${KEY_FILE}; its container was recreated.`
        : `The compose file was changed (backup beside it), but recreating the container failed. Run docker compose up -d ${c.service} there.` }
    })
  }

  // ── the Proxmox widget's token ───────────────────────────────────────────

  async createProxmoxToken(id: string, actor: Actor): Promise<{ tokenId: string }> {
    if (actor.token) throw new HomepageRefusal('token_forbidden', 'API tokens cannot create Proxmox tokens.', 403)
    return this.withLock(id, async () => {
      const i = await this.instance(id)
      if (i.proxmoxToken) throw new HomepageRefusal('exists', `This dashboard already has a token (${i.proxmoxToken.tokenId}). Revoke it to make a new one.`, 409)
      const name = `homepage-${i.vmid}-${i.id.slice(0, 6)}`
      await this.d.audit('homepage.proxmox_token.create', `homepage:${i.machineId}`, { ...auditBy(actorLabel(actor)), name, role: 'PVEAuditor', path: '/' })
      const t = await this.d.proxmox.createAuditorToken(name, `Homepage dashboard on ${i.name}: read-only (PVEAuditor), made by HyperProx`)
      // From here a failure takes the token back again, so none is left that HyperProx has no record of.
      const undo = async () => { await this.d.proxmox.revokeToken(t.tokenId).catch(() => {}); await this.d.proxmox.saveSecret(i.id, null).catch(() => {}) }
      try {
        await this.d.proxmox.saveSecret(i.id, t.secret)
        const proxmoxEntry = (await this.d.inventory(false).then(inv => buildEntries(inv, this.options(i, []))).catch(() => [] as Entry[])).find(e => e.offer?.type === 'proxmox')
        const cur = (await this.d.store.get(i.id)) ?? i
        await this.d.store.put({ ...cur, proxmoxToken: { tokenId: t.tokenId, createdAt: this.d.now(), createdBy: actorLabel(actor) },
          options: proxmoxEntry ? { ...cur.options, widgets: [...new Set([...cur.options.widgets, proxmoxEntry.id])] } : cur.options, lastFingerprint: null })
      } catch (e) { await undo(); throw e }
      return { tokenId: t.tokenId }
    })
  }

  /** Revoke the token (one that is already gone counts as revoked) and take its values off the guest. */
  async revokeProxmoxToken(id: string, actor: Actor): Promise<{ keysLeft: string[] }> {
    if (actor.token) throw new HomepageRefusal('token_forbidden', 'API tokens cannot revoke Proxmox tokens.', 403)
    return this.withLock(id, async () => {
      const i = await this.instance(id)
      if (!i.proxmoxToken) throw new HomepageRefusal('none', 'This dashboard has no Proxmox token.', 404)
      await this.d.audit('homepage.proxmox_token.revoke', `homepage:${i.machineId}`, { ...auditBy(actorLabel(actor)), tokenId: i.proxmoxToken.tokenId })
      try { await this.d.proxmox.revokeToken(i.proxmoxToken.tokenId) }
      catch (e: any) { if (!TOKEN_GONE.test(String(e?.message ?? e))) throw e }
      await this.d.proxmox.saveSecret(i.id, null)
      const proxVars = Object.keys(i.exported).filter(n => /^HOMEPAGE_VAR_PROXMOX_/.test(n))
      let cur: HomepageInstance = { ...((await this.d.store.get(i.id)) ?? i) }
      cur = { ...cur, proxmoxToken: null, options: { ...cur.options, widgets: cur.options.widgets.filter(w => !w.startsWith('proxmox@')) }, lastFingerprint: null }
      await this.d.store.put(cur)
      // The values are dead now; still take them off the guest. If it cannot be reached, the names are dropped anyway
      // (the widget goes back to waiting) and the answer says what is left there.
      let left: string[] = []
      if (proxVars.length) {
        try { await this.removeKeys(cur, proxVars) } catch {
          left = proxVars
          const now = (await this.d.store.get(i.id)) ?? cur
          const exported = { ...now.exported }
          for (const n of proxVars) delete exported[n]
          await this.d.store.put({ ...now, exported })
        }
      }
      return { keysLeft: left }
    })
  }

  // ── problems and their fixes ─────────────────────────────────────────────

  async problems(id: string): Promise<Problem[]> {
    const i = await this.instance(id)
    const out: Problem[] = []
    let m: Machine
    try { m = await this.machine(i) } catch (e: any) {
      return [{ id: e.code === 'excluded' || e.code === 'exclusions_unknown' ? e.code : 'unreachable', severity: 'bad', title: e.code === 'excluded' ? 'The guest is excluded' : 'The guest cannot be reached', detail: e.message,
        fix: e.code === 'stopped' || e.code === 'excluded' ? null : { id: 'recheck', label: 'Check again' } }]
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
    const { widgets } = await this.keyStatus(i, await this.d.inventory(false)).catch(() => ({ widgets: [] as Awaited<ReturnType<HomepageService['keyStatus']>>['widgets'] }))
    const stale = widgets.filter(k => k.vars.some(v => v.stale))
    const unheld = widgets.filter(k => k.vars.some(v => v.held === false))
    const pending = widgets.filter(k => k.vars.some(v => !v.exported && !v.stale))
    if (stale.length) out.push({ id: 'key_mismatch', severity: 'bad', title: `${plural(stale.length, 'widget')} with an old key on the guest`, detail: `${stale.map(k => k.name).join(', ')}: the key on the guest is not the one HyperProx holds now (rotated or removed), so the widget is left out until the keys are written again.`, fix: { id: 'export_keys', label: 'Write the keys to the guest', secure: true } })
    if (unheld.length) out.push({ id: 'widget_no_key', severity: 'warn', title: `${plural(unheld.length, 'widget')} without a key in HyperProx`, detail: `${unheld.map(k => k.name).join(', ')}: add the key in that plug-in's settings, or turn the widget off.`, fix: { id: 'widgets_off', label: 'Turn those widgets off' } })
    else if (pending.length && !stale.length) out.push({ id: 'widget_pending', severity: 'warn', title: `${plural(pending.length, 'widget')} waiting for keys`, detail: `${pending.map(k => k.name).join(', ')} are turned on, but their keys are not on the guest yet, so they are left out of services.yaml.`, fix: { id: 'export_keys', label: 'Write the keys to the guest', secure: true } })
    if ((widgets.length || Object.keys(i.exported).length) && i.composeDir) {
      const c = await this.compose(m, i).catch(() => null)
      if (c && !c.wired) out.push({ id: 'env_not_wired', severity: 'warn', title: `Homepage does not read ${KEY_FILE}`, detail: 'Its compose file does not pass the key file to the container, so keys put there never reach the widgets.', fix: { id: 'wire_env', label: 'Let Homepage read its key file', secure: true, confirm: `Back up the compose file, add ${KEY_FILE} as an env_file of the Homepage service, and recreate that container (a few seconds offline)?` } })
    }
    if (i.composeDir) {
      const n = Number(/^HPX_BACKUPS (\d+)$/m.exec(await this.run(m, backupsScript(i.composeDir, KEY_FILE)).catch(() => ''))?.[1] ?? 0)
      if (n > 0) out.push({ id: 'key_backups', severity: 'warn', title: `${plural(n, 'old copy')} of the key file`, detail: `Each write of ${KEY_FILE} leaves a dated backup beside it, and those hold the keys as they were, revoked ones included.`, fix: { id: 'purge_key_backups', label: 'Delete the old key backups', secure: true, confirm: `Delete the ${plural(n, 'dated backup')} of ${KEY_FILE} on ${i.name}? The current key file stays.` } })
    }
    return out
  }

  async fix(id: string, fixId: unknown, actor: Actor, o: { applyAnyway?: boolean } = {}): Promise<{ message: string }> {
    const known = ['recheck', 'relocate', 'start', 'reset_services', 'widgets_off'] as const
    if (!known.includes(fixId as any)) {
      throw new HomepageRefusal('bad_input', fixId === 'export_keys' || fixId === 'wire_env' || fixId === 'purge_key_backups' ? 'That fix has its own button (it needs the master password).' : 'Not a fix HyperProx knows.')
    }
    const f = fixId as typeof known[number]
    if (f === 'recheck') return { message: 'Checked again.' }
    if (f === 'widgets_off') {
      const keys = await this.widgetKeys(id).catch(() => [])
      const off = new Set(keys.filter(k => k.vars.some(v => v.held === false)).map(k => k.entryId))
      const i = await this.instance(id)
      await this.setWidgets(id, i.options.widgets.filter(w => !off.has(w)), actor)
      return { message: `Turned off ${plural(off.size, 'widget')}. Preview and apply to take them off the dashboard.` }
    }
    return this.withLock(id, async () => {
      const i = await this.instance(id)
      const m = await this.machine(i)
      await this.d.audit('homepage.fix', `homepage:${i.machineId}`, { ...auditBy(actorLabel(actor)), fix: f })
      if (f === 'relocate') {
        const found = await this.locate(m)
        const l = found.find(x => x.container === i.container) ?? (found.length === 1 ? found[0] : undefined)
        if (!l?.configDir) throw new HomepageRefusal('not_found', found.length > 1 ? 'Several Homepage containers run there; disconnect and connect the one you want.' : 'No Homepage container with a mounted config folder was found.', 409)
        await this.d.store.put({ ...i, container: safeContainer(l.container), configDir: safePath(l.configDir), composeDir: l.composeDir, composeFile: l.composeFile, composeFiles: l.composeFiles, port: l.port })
        return { message: `Using ${l.container}, config at ${l.configDir}.` }
      }
      if (f === 'start') {
        const c = safeContainer(i.container)
        const out = await this.run(m, `set -u\nif docker restart ${shq(c)} >/dev/null 2>&1; then echo HPX_OK; else echo HPX_FAIL; fi\n`, 120_000)
        if (!/^HPX_OK$/m.test(out)) throw new HomepageRefusal('start_failed', `Docker could not start ${c}.`, 502)
        return { message: `${c} is starting.` }
      }
      // reset_services: back up the broken file and write HyperProx's groups only.
      const read = await this.readFiles(m, i, ['services.yaml'])
      const cur = read.files['services.yaml']
      const inv = await this.d.inventory(false)
      refusePartial(inv.failed ?? [], o.applyAnyway === true)
      const { valid } = await this.keyStatus(i, inv)
      const merged = mergeServices('', buildEntries(inv, this.options(i, valid)), { ...EMPTY_STATE, released: i.state.released ?? [] }, { hiddenGroups: i.options.hiddenGroups })
      const out = parseWrite(await this.run(m, writeScript({ dir: i.configDir, file: 'services.yaml', content: merged.text, expectSha: cur?.sha ?? null, mode: '0644', stamp: stampOf(this.d.now()) })), merged.text)
      if (!out.ok) throw new HomepageRefusal('write_failed', out.message, 409)
      await this.d.store.put({ ...i, state: merged.state, lastFingerprint: null })
      return { message: `services.yaml started fresh${out.backup ? `; the old one is at ${out.backup}` : ''}.` }
    })
  }

  /** Delete the dated copies of the key file (they hold old keys). Re-confirmed by its route; never for a token. */
  async purgeKeyBackups(id: string, actor: Actor): Promise<{ message: string }> {
    if (actor.token) throw new HomepageRefusal('token_forbidden', 'API tokens cannot delete files on the guest.', 403)
    return this.withLock(id, async () => {
      const i = await this.instance(id)
      if (!i.composeDir) throw new HomepageRefusal('no_compose', 'This container was not started with Docker Compose.', 409)
      const m = await this.machine(i)
      await this.d.audit('homepage.purge_key_backups', `homepage:${i.machineId}`, { ...auditBy(actorLabel(actor)) })
      const n = Number(/^HPX_PURGED (\d+)$/m.exec(await this.run(m, purgeBackupsScript(i.composeDir, KEY_FILE)))?.[1] ?? 0)
      return { message: `Deleted ${plural(n, 'old copy')} of ${KEY_FILE}.` }
    })
  }

  // ── the gallery card ─────────────────────────────────────────────────────

  async readings(): Promise<Array<{ id: string; name: string; url: string | null; autoSync: boolean; lastSync: HomepageInstance['lastSync']; entries: number }>> {
    return (await this.instances()).map(i => ({ id: i.id, name: i.name, url: i.url, autoSync: i.autoSync, lastSync: i.lastSync,
      entries: Object.values(i.lastSync?.counts ?? {}).reduce((a, b) => a + b, 0) }))
  }
}

// ── compose: does Homepage get its key file? ─────────────────────────────────

function composeService(doc: any, container: string): { key: string; svc: any } | null {
  const services = doc && typeof doc === 'object' ? doc.services : null
  if (!services || typeof services !== 'object') return null
  const entries = Object.entries(services) as Array<[string, any]>
  const hit = entries.find(([k, s]) => s?.container_name === container || container.endsWith(`-${k}-1`) || container.endsWith(`_${k}_1`))
    ?? entries.find(([, s]) => /gethomepage\/homepage|benphelps\/homepage/.test(String(s?.image ?? '')))
  return hit ? { key: hit[0], svc: hit[1] } : null
}

const isKeyFile = (p: unknown) => p === KEY_FILE || p === `./${KEY_FILE}`

/** Does this service definition list homepage.env in env_file (plain or long form)? */
function serviceReadsKeyFile(svc: any): boolean {
  const ef = svc?.env_file
  const list = Array.isArray(ef) ? ef : ef ? [ef] : []
  return list.some((x: any) => isKeyFile(typeof x === 'string' ? x : x?.path))
}

/** True when the Homepage service in this compose file passes homepage.env into the container (env_file). */
export function composeReadsEnv(text: string, container: string): boolean {
  let doc: any
  try { doc = yaml.load(text) } catch { return false }
  const s = composeService(doc, container)
  return !!s && serviceReadsKeyFile(s.svc)
}

/** The line a person adds by hand when the file is not simple enough to edit safely. */
export const WIRE_SNIPPET = `env_file: [${KEY_FILE}]`

/**
 * Add `env_file: [homepage.env]` to one service as a one-line text edit: every other byte of the file stays as it
 * was (comments, order, quoting). Only for the simple shape: `services:` at the top, the service as a block key, its
 * settings indented beneath it and no env_file of its own yet. Anything else is refused with the line to add by
 * hand. The result must read back as the same file plus that one setting. Null when it already reads the key file.
 */
export function wireEnvText(text: string, service: string): string | null {
  const manual = (why: string) => new HomepageRefusal('manual_edit', `${why} HyperProx does not edit this file by itself. Add this line under the ${service} service, indented like its other settings: ${WIRE_SNIPPET}`, 409)
  let before: any
  try { before = yaml.load(text) } catch { throw manual('The compose file does not read as YAML.') }
  const svc = before?.services?.[service]
  if (!svc || typeof svc !== 'object') throw manual(`There is no ${service} service in it.`)
  if (serviceReadsKeyFile(svc)) return null
  if (svc.env_file !== undefined) throw manual('The service already has an env_file setting.')
  const lines = text.split('\n')
  const top = lines.findIndex(l => /^services:\s*(#.*)?$/.test(l))
  if (top < 0) throw manual('Its services are not written as a plain block.')
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(service)) throw manual('The service name is not a plain one.')
  const keyRe = new RegExp(`^(\\s+)${service.replace(/\./g, '\\.')}:\\s*(#.*)?$`)
  let at = -1, indent = -1
  for (let n = top + 1; n < lines.length; n++) {
    if (/^\S/.test(lines[n]) && !lines[n].startsWith('#')) break
    const m = keyRe.exec(lines[n])
    if (m) { at = n; indent = m[1].length; break }
  }
  if (at < 0) throw manual(`The ${service} service is not written as a plain block.`)
  let child = -1
  for (let n = at + 1; n < lines.length; n++) {
    if (!lines[n].trim() || /^\s*#/.test(lines[n])) continue
    const w = /^(\s*)/.exec(lines[n])![1].length
    if (w > indent) child = w
    break
  }
  if (child < 0 || /\t/.test(lines.slice(at, at + 2).join(''))) throw manual(`The ${service} service has no settings HyperProx can indent beside.`)
  const out = [...lines.slice(0, at + 1), `${' '.repeat(child)}${WIRE_SNIPPET}`, ...lines.slice(at + 1)].join('\n')
  let after: any
  try { after = yaml.load(out) } catch { throw manual('The edited file would not read as YAML.') }
  const expect = structuredClone(before)
  expect.services[service].env_file = [KEY_FILE]
  if (valueHash(after) !== valueHash(expect)) throw manual('The edited file would not read back as meant.')
  return out
}

/** The compose file wired for the container's Homepage service (wireEnvText); null when it already reads the key file. */
export function wireEnv(text: string, container: string): string | null {
  let doc: any
  try { doc = yaml.load(text) } catch { throw new HomepageRefusal('compose_invalid', 'The compose file does not read as YAML.', 409) }
  const s = composeService(doc, container)
  if (!s) throw new HomepageRefusal('no_service', 'The compose file has no Homepage service HyperProx can recognise.', 409)
  return wireEnvText(text, s.key)
}

/**
 * Why a dashboard connected by itself may get its first fill without a person, or null. Only when nothing of a
 * person's would be touched: no services.yaml (or an empty one), Homepage's own unmodified sample, or a file that is
 * exactly HyperProx's earlier write (its header first, and the merge kept no group, entry or edit of anyone else's).
 */
export function firstFillReason(services: ReadFile | undefined, p: Pick<Plan, 'notes' | 'failed'>): 'missing' | 'sample' | 'own' | null {
  if (p.failed.length) return null
  if (!services?.exists || !services.text.trim()) return 'missing'
  if (p.notes.droppedSamples && !p.notes.keptUserGroups.length && !p.notes.keptUserEntries.length) return 'sample'
  const n = p.notes
  const noneOfTheirs = !n.keptUserGroups.length && !n.keptUserEntries.length && !n.keptEdits.length && !n.userRemovedGroups.length && !n.renamed.length
  if (noneOfTheirs && services.text.replace(/^---\s*\n/, '').startsWith(MANAGED_MARK)) return 'own'
  return null
}
