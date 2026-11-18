// =============================================================================
//  HyperProx — the package cache: its plug-in's service and Updates' setting
//
//  Each cache the Catalogue installed (or any container carrying its helper)
//  is one instance. Readings are the helper's `stats`; every fix is one of its
//  fixed verbs, run through the remote executor, so the leave-alone rule
//  (lib/guest-guard.ts) applies to every command. Every action is refused to an
//  API token, audited first, and not done when the audit cannot be written.
//
//  Updates asks decide() before apt runs on a guest (or, only when turned on,
//  a node): point it at the cache, take HyperProx's drop-in out again, or leave
//  it. The answer comes from the cluster's "Use the package cache" setting:
//    auto (default at home)  on while a cache is connected and healthy
//    on                      on while a cache is connected (the drop-in's own
//                            fallback covers a cache that is down)
//    off (default remote)    taken out again on the next run
//  Which guests and nodes carry the drop-in is kept here, so "off" removes it
//  only where HyperProx put it, and the plug-in can name a client by its guest
//  name without keeping or showing its address.
// =============================================================================

import { parseMaint, parseSelfTest, parseStats, CHECK_TITLE } from './parse'
import { checkNetworks, isPrivateV4 } from './net'
import { NAME, HELPER, PLUGIN_ID, PORT, RECIPE_ID, DEFAULT_USE, type CacheInstance, type CacheReading, type CacheUseMode, type CacheUseSetting, type SelfCheck } from './types'
import { ensureScript, parseEnsure, parseRemove, REMOVE_SCRIPT } from './dropin'
import type { AdapterContext, Outcome } from '../auto-connect/core'
import { exclusionOf, installStillOwns, SYSTEM_ACTOR } from '../auto-connect/core'
import { auditBy, type AuditActor } from '../http/request-actor'

export class AptCacheRefusal extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = 'AptCacheRefusal' }
}

export interface Actor { email: string; role?: string; token?: string | null }

export interface GuestRow { type: 'lxc' | 'qemu'; vmid: number; node: string; name: string; running: boolean; tags: string[] }
export interface InstallRow { recipeId: string; vmid: number; status: string; hostname?: string; ip?: string; vaultItem?: { category: string; provider: string } }

/** Where a guest or node stands with the cache, as the last run left it. */
export interface ClientRecord {
  kind: 'guest' | 'node'
  name: string
  state: 'set' | 'own-proxy' | 'no-apt' | 'removed' | 'failed'
  /** The address it reaches the cache from (kept to name it on the plug-in page; never sent to the page). */
  src: string | null
  reachable?: boolean
  at: number
  detail?: string
}

/** Clients by cluster id, then by target key (lxc-101, qemu-102, node:<name>). */
export type ClientRegistry = Record<string, Record<string, ClientRecord>>

export interface Store {
  get(id: string): Promise<CacheInstance | null>
  put(i: CacheInstance): Promise<void>
  list(): Promise<CacheInstance[]>
  delete(id: string): Promise<void>
  /** The "Use the package cache" setting of one cluster (null: never saved). */
  getUse(clusterId: string): Promise<CacheUseSetting | null>
  putUse(clusterId: string, s: CacheUseSetting): Promise<void>
  getClients(): Promise<ClientRegistry>
  putClients(r: ClientRegistry): Promise<void>
  /** Caches whose last self-check failed: kept, so a HyperProx restart does not make a sick cache look healthy. */
  getFailedChecks(): Promise<string[]>
  putFailedChecks(ids: string[]): Promise<void>
}

/** A guest or node the "repair" and "remove from all" actions reach, through the Updates executor. */
export interface FleetTarget { key: string; kind: 'guest' | 'node'; name: string; run(script: string): Promise<{ code: number; output: string; timedOut?: boolean }> }

export interface AptCacheDeps {
  store: Store
  guests(): Promise<GuestRow[]>
  /** Remote access's "never look inside" list; throws when it cannot be read (then nothing is entered). */
  exclusions(): Promise<string[]>
  /** A script in the cache's container, through the remote executor (which refuses a guest that must be left alone). */
  exec(g: { vmid: number; node: string; name: string }, script: string, timeoutMs?: number): Promise<{ code: number; output: string; timedOut?: boolean }>
  installs(): Promise<InstallRow[]>
  audit(action: string, resource: string, details: Record<string, unknown>): Promise<void>
  dismissed(key: string, label: string, by: string): Promise<void>
  /** The home cluster's guests Updates may put apt on (running, apt on in the policy, not excluded), and its nodes. */
  fleet(opts: { nodes: boolean }): Promise<FleetTarget[]>
  /** True while an Updates job is running or waiting (then nothing is changed in guests from here). */
  updatesBusy(): Promise<boolean>
  /** Is this cluster remote? (Its default is off.) */
  isRemote(clusterId: string): boolean
  /** The container's static IPv4 address from its Proxmox config (net0 ip=), or null (DHCP, none, unreadable). */
  configAddress(g: { vmid: number; node: string }): Promise<string | null>
  now(): number
}

export type FixId = 'restart' | 'maint' | 'recheck' | 'repair_guests' | 'grow_disk'
export interface Problem {
  id: string
  severity: 'bad' | 'warn'
  title: string
  detail: string
  fix: { id: FixId; label: string; confirm?: string } | null
}

/** A client as the page sees it: a name, never an address. */
export interface ClientView { name: string; kind: 'guest' | 'node' | 'self' | 'other'; requests: number; bytes: number }
export type CacheView = Omit<CacheReading, 'clients'> & { clients: ClientView[] }

export interface CacheDecision { action: 'ensure' | 'remove' | 'leave'; host?: string; port?: number; reason: string }

const READ_TTL_MS = 20_000
const HEALTH_TTL_MS = 60_000
const GUEST_KEY = /^(lxc|qemu)-\d{2,9}$/
const NODE_KEY = /^node:[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/

export function defaultUse(remote: boolean): CacheUseSetting {
  return remote ? { mode: 'off', nodes: false } : { ...DEFAULT_USE }
}

export class AptCacheService {
  private cache = new Map<string, { at: number; hours: number; reading: CacheReading }>()
  private health = new Map<string, { at: number; ok: boolean; why: string }>()
  /** A self-check that failed (from its page) marks the cache unhealthy until one passes again. */
  private selfTestFailed: Set<string> | null = null
  private busy = new Set<string>()

  constructor(private d: AptCacheDeps) {}

  // ── instances ─────────────────────────────────────────────────────────────

  async instances(): Promise<CacheInstance[]> {
    return (await this.d.store.list()).sort((a, b) => a.vmid - b.vmid)
  }

  private async instance(id: string): Promise<CacheInstance> {
    const i = await this.d.store.get(String(id ?? ''))
    if (!i) throw new AptCacheRefusal('not_found', 'That package cache is not connected.', 404)
    return i
  }

  /** The guest now, refusing one HyperProx must leave alone (fail closed when the list cannot be read). */
  private async guest(i: CacheInstance): Promise<GuestRow> {
    let ids: string[]
    try { ids = await this.d.exclusions() } catch { throw new AptCacheRefusal('exclusions_unknown', "Remote access's exclusion list could not be read, so HyperProx enters no guest until it can.", 503) }
    const g = (await this.d.guests()).find(r => r.type === 'lxc' && r.vmid === i.vmid)
    if (!g) throw new AptCacheRefusal('gone', `Container ${i.vmid} is not on the cluster any more.`, 404)
    const why = exclusionOf({ excludedMachines: new Set(ids), excludedSubnets: [] }, { machineId: i.id, tags: g.tags })
    if (why) throw new AptCacheRefusal('excluded', `${g.name} is left alone (${why}), so HyperProx does not look inside it or change it.`, 409)
    if (!g.running) throw new AptCacheRefusal('stopped', `${g.name} is not running.`, 409)
    return g
  }

  private async run(i: CacheInstance, script: string, timeoutMs = 30_000): Promise<string> {
    const g = await this.guest(i)
    const r = await this.d.exec({ vmid: g.vmid, node: g.node, name: g.name }, script, timeoutMs)
    if (r.timedOut) throw new AptCacheRefusal('timeout', `The package cache on ${g.name} did not answer in time.`, 504)
    if (r.code !== 0) {
      const why = r.output.trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)
      throw new AptCacheRefusal('guest_failed', why || `That did not work on ${g.name}.`, 502)
    }
    return r.output
  }

  // ── readings ──────────────────────────────────────────────────────────────

  private async rawReading(i: CacheInstance, hours: number, fresh: boolean): Promise<CacheReading> {
    const hit = this.cache.get(i.id)
    if (!fresh && hit && hit.hours === hours && this.d.now() - hit.at < READ_TTL_MS) return hit.reading
    await this.failedChecks()
    const reading = parseStats(await this.run(i, `${HELPER} stats ${hours}`, 60_000), this.d.now())
    this.cache.set(i.id, { at: this.d.now(), hours, reading })
    this.health.set(i.id, { at: this.d.now(), ...this.healthOf(i, reading) })
    return reading
  }

  /** The figures, with each client named by its guest (or "another device"), never by its address. */
  async reading(id: string, opts: { hours?: number; fresh?: boolean } = {}): Promise<CacheView> {
    const i = await this.instance(id)
    const hours = Math.min(720, Math.max(1, Math.floor(Number(opts.hours) || 24)))
    const r = await this.rawReading(i, hours, !!opts.fresh)
    return { ...r, clients: this.nameClients(r, await this.d.store.getClients()) }
  }

  nameClients(r: CacheReading, reg: ClientRegistry): ClientView[] {
    const bySrc = new Map<string, ClientRecord>()
    for (const cluster of Object.values(reg)) for (const c of Object.values(cluster)) if (c.src) bySrc.set(c.src, c)
    const out = new Map<string, ClientView>()
    for (const c of r.clients) {
      const known = bySrc.get(c.address)
      const self = c.address === '127.0.0.1' || c.address === '::1' || (r.listen !== null && c.address === r.listen)
      const view: ClientView = self ? { name: 'The cache itself (its own checks)', kind: 'self', requests: 0, bytes: 0 }
        : known ? { name: known.name, kind: known.kind, requests: 0, bytes: 0 }
        : { name: 'Other devices', kind: 'other', requests: 0, bytes: 0 }
      const key = `${view.kind}:${view.name}`
      const acc = out.get(key) ?? view
      acc.requests += c.requests; acc.bytes += c.bytes
      out.set(key, acc)
    }
    return [...out.values()].sort((a, b) => b.bytes - a.bytes)
  }

  /** The plug-in card: one row per cache. */
  async readings(): Promise<Array<{ id: string; name: string; vmid: number; ok: boolean; error?: string; reading?: CacheView }>> {
    const list = await this.instances()
    return Promise.all(list.map(async i => {
      try { return { id: i.id, name: i.name, vmid: i.vmid, ok: true, reading: await this.reading(i.id) } }
      catch (e: any) { return { id: i.id, name: i.name, vmid: i.vmid, ok: false, error: String(e?.message ?? e).slice(0, 200) } }
    }))
  }

  /** What is wrong, each with its fix. A reading that fails is itself the problem. */
  async problems(id: string): Promise<Problem[]> {
    const i = await this.instance(id)
    let r: CacheReading
    try { r = await this.rawReading(i, 24, true) }
    catch (e: any) { return [{ id: 'unreachable', severity: 'bad', title: 'Could not read the package cache', detail: String(e?.message ?? e), fix: { id: 'recheck', label: 'Check again' } }] }
    const out: Problem[] = []
    if (!r.active) out.push({ id: 'stopped', severity: 'bad', title: 'The package cache is not running', detail: 'Guests fetch their packages directly until it runs again (nothing breaks, it just saves nothing).', fix: { id: 'restart', label: 'Start it again', confirm: `Start the package cache on ${i.name} again?` } })
    if (r.disk && r.disk.sizeKb > 0) {
      const used = r.disk.usedKb / r.disk.sizeKb
      if (used >= 0.9) {
        out.push({ id: 'disk_full', severity: used >= 0.97 ? 'bad' : 'warn', title: 'The cache disk is nearly full', detail: `${Math.round(used * 100)}% of ${gb(r.disk.sizeKb)} is used. Clean out old packages first; if it stays full, give the disk more room.`, fix: { id: 'maint', label: 'Clean out old packages', confirm: 'Run apt-cacher-ng\'s clean-up now? It removes packages no index refers to any more.' } })
        out.push({ id: 'disk_grow', severity: 'warn', title: 'Give the cache disk more room', detail: 'A bigger disk keeps more packages, so fewer are fetched twice. It grows while the cache runs; it never shrinks.', fix: { id: 'grow_disk', label: 'Grow the disk' } })
      }
    }
    const day = 24 * 3600_000
    if (r.expiry?.outcome === 'errors') out.push({ id: 'expiry_errors', severity: 'warn', title: 'The last clean-up reported errors', detail: 'apt-cacher-ng\'s clean-up (expiry) ran with errors. Run it again; if it keeps failing, its log on the cache says why.', fix: { id: 'maint', label: 'Run the clean-up again' } })
    else if (!r.expiry || this.d.now() - r.expiry.at > 3 * day) out.push({ id: 'expiry_stale', severity: 'warn', title: 'No clean-up in the last three days', detail: 'apt-cacher-ng cleans out old packages once a day. It has not run lately, so the disk keeps what nothing needs any more.', fix: { id: 'maint', label: 'Run the clean-up now' } })
    // Guests HyperProx set up that could not reach the cache when it last looked, or that failed to take the setting.
    const reg = await this.d.store.getClients()
    const stuck = Object.values(reg.home ?? {}).filter(c => c.state === 'failed' || (c.state === 'set' && c.reachable === false))
    if (stuck.length && (await this.use('home')).mode !== 'off') {
      out.push({ id: 'guests_stuck', severity: 'warn', title: `${stuck.length} guest${stuck.length === 1 ? '' : 's'} could not use the cache`, detail: `${stuck.slice(0, 5).map(c => c.name).join(', ')}${stuck.length > 5 ? ' and more' : ''}: their last update went direct. Repairing writes the setting again and checks each one can reach the cache.`, fix: { id: 'repair_guests', label: 'Repair guests\' cache setting', confirm: 'Write the package cache setting again on every guest Updates looks after, and check each can reach it?' } })
    }
    return out
  }

  // ── actions ───────────────────────────────────────────────────────────────

  private refuseToken(by: Actor): void {
    if (by.token) throw new AptCacheRefusal('token_forbidden', 'An API token cannot change the package cache: sign in and do it on its page.', 403)
  }

  private async once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(key)) throw new AptCacheRefusal('busy', 'Another change to the package cache is still running.', 409)
    this.busy.add(key)
    try { return await fn() } finally { this.busy.delete(key); this.cache.clear(); this.health.clear() }
  }

  private async audit(action: string, resource: string, by: Actor, details: Record<string, unknown> = {}) {
    // Audited first: when the entry cannot be written, nothing is done.
    await this.d.audit(`aptcache.${action}`, resource, { ...auditBy(by as AuditActor), ...details })
  }

  /** Run the clean-up, start it again, or run the self-check. */
  async action(id: string, action: unknown, by: Actor): Promise<{ message: string; checks?: SelfCheck[] }> {
    this.refuseToken(by)
    const i = await this.instance(id)
    const res = `aptcache:${i.vmid}`
    if (action === 'restart') {
      return this.once(i.id, async () => {
        await this.audit('restart', res, by)
        await this.run(i, `${HELPER} restart`, 90_000)
        return { message: 'The package cache started again.' }
      })
    }
    if (action === 'maint') {
      return this.once(i.id, async () => {
        await this.audit('maint', res, by)
        const out = parseMaint(await this.run(i, `${HELPER} maint`, 30 * 60_000))
        return { message: out === 'skipped' ? 'apt-cacher-ng looked and found too little to clean out to be worth it yet.' : 'Old packages were cleaned out.' }
      })
    }
    if (action === 'selftest') {
      await this.audit('selftest', res, by)
      const checks = parseSelfTest(await this.run(i, `${HELPER} selftest`, 3 * 60_000))
      const failed = checks.filter(c => c.state === 'fail')
      const marked = await this.failedChecks()
      if (failed.length || !checks.length) marked.add(i.id); else marked.delete(i.id)
      await this.d.store.putFailedChecks([...marked])
      this.health.delete(i.id)
      return { checks, message: failed.length ? `${failed.length} check${failed.length === 1 ? '' : 's'} failed: ${failed.map(c => CHECK_TITLE[c.id] ?? c.id).join(', ')}.` : 'Every check passed.' }
    }
    if (action === 'recheck') { this.cache.delete(i.id); return { message: 'Read again.' } }
    throw new AptCacheRefusal('bad_action', 'That is not something HyperProx does to the package cache.')
  }

  /** Who may use the cache and whether its admin page is on the network. */
  async saveSettings(id: string, body: Record<string, unknown>, by: Actor): Promise<{ message: string }> {
    this.refuseToken(by)
    const i = await this.instance(id)
    const steps: Array<[string, string]> = []
    if (body.allow !== undefined) {
      const n = checkNetworks(Array.isArray(body.allow) ? body.allow.join(' ') : body.allow, { allowEmpty: false })
      if (n.problems.length) throw new AptCacheRefusal('bad_networks', n.problems.join(' '))
      steps.push(['ALLOW', n.value])
    }
    if (body.report !== undefined) {
      if (typeof body.report !== 'boolean') throw new AptCacheRefusal('bad_value', 'The admin page is on or off.')
      steps.push(['REPORT', body.report ? '1' : '0'])
    }
    if (!steps.length) throw new AptCacheRefusal('nothing', 'Nothing to change.')
    await this.once(i.id, async () => {
      await this.audit('settings', `aptcache:${i.vmid}`, by, Object.fromEntries(steps.map(([k, v]) => [k.toLowerCase(), v])))
      for (const [k, v] of steps) await this.run(i, `${HELPER} set ${k} '${v}'`, 90_000)
    })
    return { message: 'Saved and applied.' }
  }

  async disconnect(id: string, by: Actor): Promise<{ message: string }> {
    this.refuseToken(by)
    const i = await this.instance(id)
    await this.audit('disconnect', `aptcache:${i.vmid}`, by)
    await this.d.dismissed(i.id, `${NAME} on ${i.name}`, by.email)
    await this.d.store.delete(i.id)
    this.cache.delete(i.id); this.health.delete(i.id)
    return { message: `${i.name} is no longer shown here, and Updates stops pointing guests at it on its next run. The cache itself keeps running.` }
  }

  // ── Updates: "Use the package cache" ──────────────────────────────────────

  async use(clusterId: string): Promise<CacheUseSetting> {
    return (await this.d.store.getUse(clusterId)) ?? defaultUse(this.d.isRemote(clusterId))
  }

  /** The setting as the pages show it, with what it means right now. */
  async useView(clusterId: string): Promise<CacheUseSetting & { effective: boolean; why: string; cache: { id: string; name: string } | null; clients: number }> {
    const s = await this.use(clusterId)
    const pick = await this.pick(s)
    const healthy = pick ? await this.healthy(pick) : false
    const effective = s.mode !== 'off' && !!pick && (s.mode === 'on' || healthy)
    const why = s.mode === 'off' ? 'Off: guests fetch directly, and the setting is taken out of any guest that has it on the next run.'
      : !pick ? 'No package cache is connected. Install one from the Catalogue and this turns on by itself.'
      : s.mode === 'auto' && !healthy ? `${pick.name} is skipped (${(await this.health_(pick)).why}), so guests fetch directly until it is healthy again.`
      : `Updates points each guest at ${pick.name} before apt runs. A dead cache never stops an update; a sick one is skipped once HyperProx notices.`
    const clients = Object.values((await this.d.store.getClients())[clusterId] ?? {}).filter(c => c.state === 'set').length
    return { ...s, effective, why, cache: pick ? { id: pick.id, name: pick.name } : null, clients }
  }

  async setUse(clusterId: string, body: Record<string, unknown>, by: Actor): Promise<CacheUseSetting> {
    this.refuseToken(by)
    const cur = await this.use(clusterId)
    const next: CacheUseSetting = { ...cur }
    if (body.mode !== undefined) {
      if (!['auto', 'on', 'off'].includes(String(body.mode))) throw new AptCacheRefusal('bad_value', 'Use the package cache: automatic, on or off.')
      next.mode = body.mode as CacheUseMode
    }
    if (body.nodes !== undefined) {
      if (typeof body.nodes !== 'boolean') throw new AptCacheRefusal('bad_value', 'Nodes are on or off.')
      next.nodes = body.nodes
    }
    if (body.cacheId !== undefined) {
      if (body.cacheId !== null && !(await this.d.store.get(String(body.cacheId)))) throw new AptCacheRefusal('not_found', 'That package cache is not connected.', 404)
      next.cacheId = body.cacheId === null ? null : String(body.cacheId)
    }
    next.updatedAt = this.d.now(); next.updatedBy = by.email
    await this.audit('use', `updates:${clusterId}`, by, { mode: next.mode, nodes: next.nodes, cacheId: next.cacheId ?? null })
    await this.d.store.putUse(clusterId, next)
    return next
  }

  private async pick(s: CacheUseSetting): Promise<CacheInstance | null> {
    const all = await this.instances()
    const usable = (i: CacheInstance) => !!i.listen && isPrivateV4(i.listen)
    const chosen = s.cacheId ? all.find(i => i.id === s.cacheId) : undefined
    return (chosen && usable(chosen) ? chosen : null) ?? all.find(usable) ?? null
  }

  /**
   * Healthy enough for Updates to point guests at it: running, answering on the private address HyperProx recorded,
   * its disk below 97%, and no failed self-check since the last one that passed.
   */
  healthOf(i: CacheInstance, r: CacheReading): { ok: boolean; why: string } {
    if (!r.active) return { ok: false, why: 'it is not running' }
    if (r.listening === false) return { ok: false, why: 'it is not listening on its address' }
    if (!r.listen || !i.listen || r.listen !== i.listen || !isPrivateV4(r.listen)) return { ok: false, why: 'it does not listen on the address HyperProx recorded' }
    if (r.disk && r.disk.sizeKb > 0 && r.disk.usedKb / r.disk.sizeKb >= 0.97) return { ok: false, why: 'its disk is full' }
    if (this.selfTestFailed?.has(i.id)) return { ok: false, why: 'its last self-check failed' }
    return { ok: true, why: '' }
  }

  /** The persisted failed self-checks, read once and kept in step with the store. */
  private async failedChecks(): Promise<Set<string>> {
    if (!this.selfTestFailed) this.selfTestFailed = new Set(await this.d.store.getFailedChecks().catch(() => []))
    return this.selfTestFailed
  }

  private async health_(i: CacheInstance): Promise<{ ok: boolean; why: string }> {
    await this.failedChecks()
    const h = this.health.get(i.id)
    if (h && this.d.now() - h.at < HEALTH_TTL_MS) return h
    try { await this.rawReading(i, 1, true); return this.health.get(i.id)! }
    catch { const out = { ok: false, why: 'it could not be read' }; this.health.set(i.id, { at: this.d.now(), ...out }); return out }
  }

  private async healthy(i: CacheInstance): Promise<boolean> { return (await this.health_(i)).ok }

  /**
   * What Updates does about the cache on one guest or node, just before apt runs there. Never throws for a reason
   * that should stop an update: the caller treats any throw as "leave it".
   */
  async decide(clusterId: string, target: { key: string; kind: 'guest' | 'node' }): Promise<CacheDecision> {
    const s = await this.use(clusterId)
    // Set there, or a removal that did not finish: either way HyperProx's setting may still be in place.
    const st = (await this.d.store.getClients())[clusterId]?.[target.key]?.state
    const had = st === 'set' || st === 'failed'
    const off = (reason: string): CacheDecision => (had ? { action: 'remove', reason } : { action: 'leave', reason })
    if (target.kind === 'node' && !s.nodes) return off('nodes are not pointed at the cache')
    if (s.mode === 'off') return off('the package cache is off for this cluster')
    const c = await this.pick(s)
    if (!c || !c.listen) return off('no package cache is connected')
    if (target.kind === 'guest' && target.key === c.id) return off('the cache does not use itself')
    if (s.mode === 'auto') {
      // A sick cache is skipped: HyperProx's setting is taken out where it was put, and put back once it is healthy.
      const h = await this.health_(c)
      if (!h.ok) return off(`${c.name} is skipped: ${h.why}`)
    }
    return { action: 'ensure', host: c.listen, port: PORT, reason: `using ${c.name}` }
  }

  /** What a run (or a repair) left on one guest or node. */
  async record(clusterId: string, key: string, rec: ClientRecord): Promise<void> {
    if (!GUEST_KEY.test(key) && !NODE_KEY.test(key)) return
    const reg = await this.d.store.getClients()
    const cluster = { ...(reg[clusterId] ?? {}) }
    if (rec.state === 'removed') delete cluster[key]
    else cluster[key] = rec
    await this.d.store.putClients({ ...reg, [clusterId]: cluster })
  }

  /**
   * Write the setting on every guest Updates looks after (home), or take it out of every one ("remove": from all of
   * them, whatever was recorded, and from nodes where it was put). Refused while an Updates job runs.
   */
  async fleetAction(kind: 'repair' | 'remove', by: Actor): Promise<{ message: string; results: Array<{ name: string; outcome: string }> }> {
    this.refuseToken(by)
    if (await this.d.updatesBusy()) throw new AptCacheRefusal('updates_running', 'An Updates job is running. Try again when it has finished.', 409)
    const s = await this.use('home')
    let target: CacheDecision | null = null
    if (kind === 'repair') {
      if (s.mode === 'off') throw new AptCacheRefusal('off', 'Use the package cache is off, so there is nothing to repair. Turn it on first.', 409)
      const c = await this.pick(s)
      if (!c?.listen) throw new AptCacheRefusal('no_cache', 'No package cache is connected.', 409)
      target = { action: 'ensure', host: c.listen, port: PORT, reason: '' }
    }
    return this.once('fleet', async () => {
      const reg = (await this.d.store.getClients()).home ?? {}
      // A node HyperProx set, or one whose removal did not finish: both are reached again.
      const mayHave = (v?: ClientRecord) => v?.state === 'set' || v?.state === 'failed'
      const nodesHad = Object.entries(reg).some(([k, v]) => k.startsWith('node:') && mayHave(v))
      await this.audit(kind === 'repair' ? 'repair_guests' : 'remove_guests', 'updates:home', by, { nodes: kind === 'repair' ? s.nodes : nodesHad })
      const fleet = await this.d.fleet({ nodes: kind === 'repair' ? s.nodes : nodesHad })
      const results: Array<{ name: string; outcome: string }> = []
      const pickId = kind === 'repair' ? (await this.pick(s))?.id : undefined
      for (const t of fleet) {
        if (kind === 'repair' && t.key === pickId) continue
        if (kind === 'remove' && t.kind === 'node' && !mayHave(reg[t.key])) continue
        try {
          const r = await t.run(kind === 'repair' ? ensureScript(target!.host!, target!.port!) : REMOVE_SCRIPT)
          if (kind === 'repair') {
            const e = parseEnsure(r.output)
            const rec = recordOf(t, e, this.d.now())
            await this.record('home', t.key, rec)
            results.push({ name: t.name, outcome: wordsOf(rec) })
          } else {
            const e = parseRemove(r.output)
            if (e) await this.record('home', t.key, { kind: t.kind, name: t.name, state: 'removed', src: null, at: this.d.now() })
            else await this.record('home', t.key, { kind: t.kind, name: t.name, state: 'failed', src: null, at: this.d.now(), detail: 'its cache setting could not be taken out' })
            results.push({ name: t.name, outcome: e === 'removed' ? 'taken out' : e === 'absent' ? 'had none' : 'could not be read: it may still have it' })
          }
        } catch (e: any) {
          if (kind === 'repair') await this.record('home', t.key, { kind: t.kind, name: t.name, state: 'failed', src: null, at: this.d.now(), detail: String(e?.message ?? e).slice(0, 200) })
          results.push({ name: t.name, outcome: `not changed: ${String(e?.message ?? e).slice(0, 160)}` })
        }
      }
      const n = results.length
      const words = (k: number) => `${k} machine${k === 1 ? '' : 's'}`
      const out = results.filter(r => r.outcome === 'taken out').length, none = results.filter(r => r.outcome === 'had none').length
      return {
        message: kind === 'repair' ? `The cache setting was written on ${words(results.filter(r => r.outcome === 'uses the cache').length)} of ${n} checked.`
          : `HyperProx's cache setting was taken out of ${words(out)}; ${words(none)} had none${n - out - none ? `, and ${words(n - out - none)} could not be checked` : ''}.`,
        results,
      }
    })
  }

  // ── auto-connect ──────────────────────────────────────────────────────────

  /** Finished Catalogue installs whose guest is still the one installed. */
  async sightings(): Promise<Array<{ guest: GuestRow; install: InstallRow }>> {
    const guests = await this.d.guests()
    const out: Array<{ guest: GuestRow; install: InstallRow }> = []
    for (const j of await this.d.installs()) {
      if (j.recipeId !== RECIPE_ID || j.status !== 'completed' || !(j.vmid >= 100)) continue
      const g = guests.find(x => x.type === 'lxc' && x.vmid === j.vmid)
      if (!g || !installStillOwns(j, g)) continue
      if (!out.some(o => o.guest.vmid === g.vmid)) out.push({ guest: g, install: j })
    }
    return out
  }

  /**
   * The address to use, or null: what the helper says it listens on must be a private IPv4 address, the same as the
   * static address in the container's Proxmox config, and the same as the install's own record (when it has one).
   * A container on DHCP has no address HyperProx can trust, so it is not used.
   */
  async verifiedListen(g: { vmid: number; node: string }, probed: string | null, installIp?: string): Promise<{ listen: string | null; why?: string }> {
    if (!probed || !isPrivateV4(probed)) return { listen: null, why: 'its helper names no private address' }
    const cfg = await this.d.configAddress(g).catch(() => null)
    if (!cfg) return { listen: null, why: 'its Proxmox config has no fixed address (DHCP)' }
    if (cfg !== probed) return { listen: null, why: `it listens on another address than its Proxmox config gives it` }
    if (installIp && installIp.split('/')[0] !== probed) return { listen: null, why: 'its address is not the one it was installed with' }
    return { listen: probed }
  }

  async autoConnect(ctx: AdapterContext): Promise<Outcome[]> {
    const out: Outcome[] = []
    const have = new Map((await this.instances()).map(i => [i.id, i]))
    for (const { guest: g, install } of await this.sightings()) {
      const key = `lxc-${g.vmid}`
      const label = `${NAME} on ${g.name}`
      const known = have.get(key)
      if (!known && ctx.dismissed(key)) { out.push({ key, label, did: 'dismissed' }); continue }
      const why = exclusionOf(ctx, { machineId: key, tags: g.tags, addresses: install.ip ? [install.ip.split('/')[0]] : [] })
      if (why) { out.push({ key, label, did: known ? 'present' : 'excluded', message: why }); continue }
      if (!g.running) { out.push({ key, label, did: known ? 'present' : 'skipped', message: `${g.name} is not running${known ? '' : ': connected when it starts'}.` }); continue }
      try {
        const r = await this.d.exec({ vmid: g.vmid, node: g.node, name: g.name }, `${HELPER} probe`, 20_000)
        const p = parseProbe(r.output)
        if (r.code !== 0 || !p) {
          if (known) { await this.d.store.put({ ...known, listen: null }); out.push({ key, label, did: 'present', message: `${g.name} no longer answers as the package cache.` }) }
          else out.push({ key, label, did: 'skipped', message: `${g.name} has no HyperProx package cache helper.` })
          continue
        }
        const v = await this.verifiedListen(g, p.listen, install.ip)
        // Each pass refreshes the address of one already connected: a moved or unverifiable one is not used.
        if (known) {
          if (known.listen !== v.listen) { await this.d.store.put({ ...known, listen: v.listen }); this.health.delete(key) }
          out.push({ key, label, did: 'present', ...(v.why ? { message: `Not used by Updates: ${v.why}.` } : {}) })
          continue
        }
        if (!v.listen) { out.push({ key, label, did: 'skipped', message: `${g.name} is not connected: ${v.why}.` }); continue }
        const evidence = [`Catalogue install of the package cache on CT ${g.vmid}`, `its helper answers as apt-cacher-ng on ${v.listen}, its fixed address`]
        const vault = install.vaultItem ?? { category: 'apps', provider: `${RECIPE_ID}-${g.vmid}` }
        await ctx.audit('plugin.auto_connect', `plugin:${PLUGIN_ID}`, { guest: key, evidence, vaultItemName: `hyperprox:${vault.category}/${vault.provider}` })
        if (ctx.dismissed(key)) { out.push({ key, label, did: 'dismissed' }); continue }
        await this.d.store.put({ id: key, vmid: g.vmid, node: g.node, name: g.name, listen: v.listen, vault, addedAt: ctx.now(), addedBy: SYSTEM_ACTOR, autoConnected: { at: ctx.now(), evidence } })
        out.push({ key, label, did: 'connected', evidence })
      } catch (e: any) {
        out.push({ key, label, did: known ? 'present' : 'failed', message: String(e?.message ?? e).slice(0, 300) })
      }
    }
    return out
  }
}

/** The helper's probe: it is the package cache's helper, and the address it serves. */
export function parseProbe(output: string): { listen: string | null } | null {
  if (!/^kind=apt-cacher-ng$/m.test(String(output ?? ''))) return null
  return { listen: /^listen=((?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3})$/m.exec(output)?.[1] ?? null }
}

export function recordOf(t: { kind: 'guest' | 'node'; name: string }, e: ReturnType<typeof parseEnsure>, at: number): ClientRecord {
  if (!e) return { kind: t.kind, name: t.name, state: 'failed', src: null, at, detail: 'the setting could not be written' }
  if (e.result === 'own-proxy') return { kind: t.kind, name: t.name, state: 'own-proxy', src: null, at, detail: e.own ? `its own proxy is set in ${e.own}` : 'it has its own proxy' }
  if (e.result === 'no-apt') return { kind: t.kind, name: t.name, state: 'no-apt', src: null, at }
  if (e.result === 'unusable') return { kind: t.kind, name: t.name, state: 'failed', src: null, at, detail: 'apt could not run the cache check, so the setting was taken out and this guest updates directly' }
  return { kind: t.kind, name: t.name, state: 'set', src: e.src, reachable: e.reachable, at }
}

export function wordsOf(r: ClientRecord): string {
  switch (r.state) {
    case 'set': return r.reachable === false ? 'set, but it cannot reach the cache (it fetches directly)' : 'uses the cache'
    case 'own-proxy': return `left alone: ${r.detail ?? 'it has its own proxy'}`
    case 'no-apt': return 'no apt (not Debian or Ubuntu)'
    case 'removed': return 'taken out'
    default: return `not changed: ${r.detail ?? 'unknown'}`
  }
}

function gb(kb: number): string { return `${(kb / 1024 / 1024).toFixed(kb >= 10 * 1024 * 1024 ? 0 : 1)} GB` }
