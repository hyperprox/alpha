// =============================================================================
//  HyperProx — auto-connect: plug-ins connect what they already found
//
//  A plug-in that has found an install (the shared service scan, a Catalogue
//  install, its own read-only look inside a guest) connects it by itself. A
//  person is never sent to press "Connect" on something HyperProx can see.
//
//  One background pass (reconcile) runs on the discovery cadence and right after
//  the vault unlocks. Each plug-in's adapter does its own connecting; this module
//  holds the rules every adapter shares:
//
//    - the vault locked: nothing runs; the pass after the unlock does it
//    - Remote access's exclusion list unreadable: nothing runs (fail closed)
//    - a guest tagged hyperprox-ignore, on the exclusion list, or an address in
//      an excluded subnet is never connected
//    - an install a person disconnected is remembered ("dismissed") and never
//      added again until they say "connect again"
//    - two candidates for one place are never guessed between: the pass leaves
//      one pending choice, and a person picks
//    - every auto-connect is audited as "system" with the evidence (and the
//      vault item's id and name when one was used, never its value)
//    - an auto-connect does only what a read-only connect does; writes and fixes
//      keep their own admin and master-password rules
// =============================================================================

import type { SecretItem } from '../vault/broker'
import type { VaultChoice } from './vault-match'
import { appLog } from '../log-once'

export const SYSTEM_ACTOR = 'system (auto-connect)'
export const AUTO_TICK_MS = 5 * 60_000

export type Did = 'connected' | 'present' | 'dismissed' | 'excluded' | 'ambiguous' | 'needs_credential' | 'skipped' | 'failed' | 'filled'

export interface Outcome {
  /** Stable per plug-in: a machine id (lxc-101), or `setting@origin` for an address setting. */
  key: string
  label: string
  did: Did
  evidence?: string[]
  vaultItem?: VaultChoice | null
  /** For `ambiguous`: what the person picks from (ids and names only). */
  choices?: Array<{ id: string; label: string }>
  /** For `ambiguous`: which kind of choice it is (a container, a vault item). */
  choiceKind?: 'container' | 'vault-item' | 'address'
  message?: string
}

export interface AdapterContext {
  dismissed(key: string): boolean
  /** Connected by an earlier pass (so its absence now means a person took it away). */
  autoConnectedBefore(key: string): boolean
  excludedMachines: Set<string>
  excludedSubnets: string[]
  /** The vault's items as the unlock cache holds them (empty when locked). Never logged. */
  vaultItems(): SecretItem[]
  /** Writes an audit row as the system, or throws (then the adapter does not connect). */
  audit(action: string, resource: string, details: Record<string, unknown>): Promise<void>
  now(): number
}

export interface AutoConnectAdapter {
  plugin: string
  reconcile(ctx: AdapterContext): Promise<Outcome[]>
  /** A person picked one choice of a pending outcome. Returns what that did. */
  pick?(key: string, choiceId: string, ctx: AdapterContext, by: string): Promise<Outcome>
}

export interface StateEntry { at: number; label: string }
export interface AutoConnectState {
  dismissed: Record<string, StateEntry & { by: string }>
  connected: Record<string, StateEntry & { evidence: string[]; vaultItem: VaultChoice | null }>
  pending: Record<string, StateEntry & { message: string; choiceKind: string; choices: Array<{ id: string; label: string }> }>
  lastRun: { at: number; reason: string; waited: string | null; results: Record<string, Partial<Record<Did, number>>> } | null
}

export const EMPTY: AutoConnectState = { dismissed: {}, connected: {}, pending: {}, lastRun: null }

export interface StateStore { get(): Promise<AutoConnectState>; put(s: AutoConnectState): Promise<void> }

export class MemoryStateStore implements StateStore {
  s: AutoConnectState = structuredClone(EMPTY)
  async get() { return structuredClone(this.s) }
  async put(s: AutoConnectState) { this.s = structuredClone(s) }
}

export interface ReconcilerDeps {
  store: StateStore
  adapters: AutoConnectAdapter[]
  unlocked(): boolean
  /** Remote access's "never look inside" machine ids. Throws when unreadable: then nothing is connected. */
  excluded(): Promise<string[]>
  excludedSubnets(): string[]
  vaultItems(): SecretItem[]
  audit(action: string, resource: string, details: Record<string, unknown>): Promise<void>
  now?(): number
  log?(m: string): void
  /** The same, with the error itself so its stack is logged. Optional; `log` is used alone without it. */
  logError?(m: string, err: unknown, level?: 'warn' | 'error'): void
}

const sid = (plugin: string, key: string) => `${plugin}/${key}`

export class AutoConnectError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = 'AutoConnectError' }
}

export class Reconciler {
  private running: Promise<RunResult> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  /** Every change to the remembered state goes through this one queue: read fresh, change in place, write. */
  private queue: Promise<unknown> = Promise.resolve()
  /** The state as the last change left it: what a running pass reads (dismissals made during it included). */
  private live: AutoConnectState | null = null
  /** A pass was skipped because the vault was locked: the unlock runs it. */
  waitingForUnlock = false
  private now: () => number

  constructor(private d: ReconcilerDeps) { this.now = d.now ?? Date.now }

  adapter(plugin: string): AutoConnectAdapter | undefined { return this.d.adapters.find(a => a.plugin === plugin) }

  /**
   * One change to the state: serialised with every other change, made on a fresh read, and written back with only
   * what `fn` changed. Never a snapshot from before a slow step written back over someone else's change.
   */
  private mutate<T>(fn: (s: AutoConnectState) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const s = await this.d.store.get()
      const out = await fn(s)
      await this.d.store.put(s)
      this.live = s
      return out
    })
    this.queue = run.catch(() => {})
    return run
  }

  private context(excluded: string[], subnets: string[], plugin: string): AdapterContext {
    return {
      // Read live, at the moment the adapter asks: a dismissal made while the pass runs counts at once.
      dismissed: k => !!this.live?.dismissed[sid(plugin, k)],
      autoConnectedBefore: k => !!this.live?.connected[sid(plugin, k)],
      excludedMachines: new Set(excluded),
      excludedSubnets: subnets,
      vaultItems: () => (this.d.unlocked() ? this.d.vaultItems() : []),
      // As the system, always; whatever an adapter passes as `by` is replaced.
      audit: (a, r, det) => this.d.audit(a, r, { ...det, by: SYSTEM_ACTOR }),
      now: this.now,
    }
  }

  /** One line in the log for a problem; the same problem again and again (the timer) is logged once until it changes. */
  private lastReported = ''
  private report(m: string, e: unknown, level: 'warn' | 'error' = 'warn'): void {
    const key = `${m}|${(e as any)?.message ?? e}`
    if (key === this.lastReported) return
    this.lastReported = key
    if (this.d.logError) this.d.logError(m, e, level)
    else if (this.d.log) this.d.log(`${m}: ${(e as any)?.message ?? e}`)
    else appLog[level]({ err: e }, m)
  }

  /** One pass over every plug-in. One at a time; a second call while one runs gets the same answer. */
  run(reason: string): Promise<RunResult> {
    if (this.running) return this.running
    this.running = this.pass(reason).finally(() => { this.running = null })
    return this.running
  }

  /** A pass that starts after any pass already running: it sees every change made before this call. */
  async runFresh(reason: string): Promise<RunResult> {
    const prev = this.running
    if (prev) await prev.catch(() => {})
    // Another fresh caller may have started one in between; it too started after our change.
    return this.run(reason)
  }

  private async pass(reason: string): Promise<RunResult> {
    if (!this.d.unlocked()) {
      this.waitingForUnlock = true
      return { waited: 'locked', outcomes: {} }
    }
    let subnets: string[]
    try { subnets = this.d.excludedSubnets() } catch (e: any) {
      // Loud: a list that cannot be read could let an excluded subnet through, so nothing runs until it is fixed.
      this.report(`[auto-connect] REFUSING TO RUN: excluded subnets unreadable`, e, 'error')
      return { waited: 'subnets', outcomes: {} }
    }
    let excluded: string[]
    try { excluded = await this.d.excluded() } catch (e) {
      this.report('[auto-connect] Remote access\'s exclusion list could not be read; nothing is connected until it can', e)
      return { waited: 'exclusions', outcomes: {} }
    }
    this.waitingForUnlock = false
    const startedAt = this.now()
    await this.mutate(() => undefined)
    const outcomes: Record<string, Outcome[]> = {}
    let lockedMidway = false
    for (const a of this.d.adapters) {
      let list: Outcome[]
      try { list = await a.reconcile(this.context(excluded, subnets, a.plugin)) } catch (e: any) {
        if (e?.name === 'VaultLockedError' || !this.d.unlocked()) { lockedMidway = true; list = [] }
        else { this.report(`[auto-connect] ${a.plugin} failed`, e); list = [{ key: '*', label: a.plugin, did: 'failed', message: String(e?.message ?? e).slice(0, 300) }] }
      }
      outcomes[a.plugin] = list
      await this.mutate(s => this.apply(s, a.plugin, list, startedAt))
    }
    if (lockedMidway) this.waitingForUnlock = true
    const results: Record<string, Partial<Record<Did, number>>> = {}
    for (const [p, list] of Object.entries(outcomes)) for (const o of list) { results[p] ??= {}; results[p][o.did] = (results[p][o.did] ?? 0) + 1 }
    await this.mutate(s => { s.lastRun = { at: this.now(), reason: reason.slice(0, 40), waited: lockedMidway ? 'locked' : null, results } })
    return { waited: lockedMidway ? 'locked' : null, outcomes }
  }

  /**
   * What outcomes change, merged into a fresh state key by key. A dismissal always wins: an outcome never connects
   * or re-opens something a person dismissed, even one dismissed while the pass ran. `since`: pending choices from
   * before then that this pass did not report again are gone; ones added since (a pick, another pass) are kept.
   */
  private apply(state: AutoConnectState, plugin: string, list: Outcome[], since: number | null) {
    const seenPending = new Set<string>()
    for (const o of list) {
      if (o.key === '*') continue
      const k = sid(plugin, o.key)
      if (state.dismissed[k]) { delete state.pending[k]; continue }
      if (o.did === 'connected' || o.did === 'filled') {
        state.connected[k] = { at: this.now(), label: o.label, evidence: (o.evidence ?? []).slice(0, 10), vaultItem: o.vaultItem ?? null }
        delete state.pending[k]
      } else if (o.did === 'dismissed') {
        // Connected by an earlier pass and taken away by a person since (a setting cleared): remembered as theirs.
        state.dismissed[k] = { at: this.now(), label: o.label, by: 'a person (cleared it)' }
        delete state.connected[k]
        delete state.pending[k]
      } else if (o.did === 'ambiguous') {
        // Picked while this pass ran: its stale "ambiguous" does not re-open the choice.
        if (since !== null && state.connected[k] && state.connected[k].at >= since) continue
        seenPending.add(k)
        state.pending[k] = { at: state.pending[k]?.at ?? this.now(), label: o.label, message: o.message ?? 'More than one candidate.', choiceKind: o.choiceKind ?? 'container', choices: (o.choices ?? []).slice(0, 20) }
      }
    }
    if (since === null) return
    // A choice that is no longer ambiguous (connected by hand, gone, dismissed) is not left pending.
    for (const [k, p] of Object.entries(state.pending)) if (k.startsWith(`${plugin}/`) && !seenPending.has(k) && p.at < since) delete state.pending[k]
  }

  /** A person disconnected or removed it: never add it again until they say so. */
  async dismiss(plugin: string, key: string, label: string, by: string): Promise<void> {
    const k = sid(plugin, key)
    await this.mutate(s => {
      s.dismissed[k] = { at: this.now(), label: label.slice(0, 120), by: by.slice(0, 200) }
      delete s.connected[k]
      delete s.pending[k]
    })
  }

  /** "Connect again": forget the dismissal, then run a fresh pass (never one that started before this). */
  async connectAgain(plugin: string, key: string, by: string): Promise<RunResult> {
    const k = sid(plugin, key)
    await this.mutate(async s => {
      if (!s.dismissed[k]) throw new AutoConnectError('not_dismissed', 'That one was not disconnected.', 404)
      await this.d.audit('autoconnect.connect_again', k, { by, label: s.dismissed[k].label })
      delete s.dismissed[k]
      delete s.connected[k]
    })
    return this.runFresh('connect-again')
  }

  /** A person picked one of a pending choice's options. Only that choice is resolved; others stay as they are. */
  async pick(plugin: string, key: string, choiceId: string, by: string): Promise<Outcome> {
    if (!this.d.unlocked()) throw new AutoConnectError('locked', 'HyperProx is locked. Sign in, then pick again.', 423)
    const a = this.adapter(plugin)
    const k = sid(plugin, key)
    const p = (await this.d.store.get()).pending[k]
    if (!a?.pick || !p) throw new AutoConnectError('no_choice', 'There is nothing to pick there any more.', 404)
    if (!p.choices.some(c => c.id === choiceId)) throw new AutoConnectError('bad_choice', 'Pick one of the listed options.', 400)
    let subnets: string[]
    try { subnets = this.d.excludedSubnets() } catch { throw new AutoConnectError('subnets_unknown', 'The excluded subnets could not be read, so nothing is connected until they can.', 503) }
    let excluded: string[]
    try { excluded = await this.d.excluded() } catch { throw new AutoConnectError('exclusions_unknown', 'Remote access\'s exclusion list could not be read, so nothing is connected until it can.', 503) }
    if (!this.live) await this.mutate(() => undefined)
    // The person's pick, audited as theirs; the connecting itself is the adapter's read-only connect.
    await this.d.audit('autoconnect.pick', k, { by, choice: choiceId, choiceKind: p.choiceKind })
    const ctx = this.context(excluded, subnets, plugin)
    const o = await a.pick(key, choiceId, { ...ctx, audit: (ac, r, det) => this.d.audit(ac, r, { ...det, by }) }, by)
    await this.mutate(s => {
      this.apply(s, plugin, [o], null)
      if (o.did !== 'ambiguous' || o.key !== key) delete s.pending[k]
    })
    return o
  }

  async state(): Promise<AutoConnectState> { return this.d.store.get() }

  /** The timer (discovery cadence) and the unlock hook. Returns a stop function. */
  start(onUnlock: (cb: () => void) => void): () => void {
    if (this.timer) return () => {}
    this.timer = setInterval(() => { void this.run('timer').catch(e => this.report('[auto-connect] timed pass failed', e)) }, AUTO_TICK_MS)
    this.timer.unref?.()
    // Right after an unlock, and at start-up in case the vault is already open.
    onUnlock(() => { void this.runFresh('unlock').catch(e => this.report('[auto-connect] pass after unlock failed', e)) })
    const first = setTimeout(() => { void this.run('start').catch(e => this.report('[auto-connect] first pass failed', e)) }, 30_000)
    first.unref?.()
    return () => { if (this.timer) clearInterval(this.timer); this.timer = null; clearTimeout(first) }
  }
}

export interface RunResult { waited: 'locked' | 'exclusions' | 'subnets' | null; outcomes: Record<string, Outcome[]> }

// ── shared checks ───────────────────────────────────────────────────────────

const ipv4 = (s: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m || m.slice(1).some(x => Number(x) > 255)) return null
  return ((Number(m[1]) << 24) >>> 0) + (Number(m[2]) << 16) + (Number(m[3]) << 8) + Number(m[4])
}

/** The host of an address as an IPv4, when it is one: an IPv4-mapped IPv6 (::ffff:a.b.c.d) counts as its IPv4. */
export function hostIPv4(address: string): number | null {
  const a = String(address ?? '').trim()
  let host = a
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) { try { host = new URL(a).hostname } catch { return null } }
  else if (/^\[[^\]]+\](:\d+)?$/.test(a)) host = a.slice(1, a.indexOf(']'))
  else if (/^[^:]+:\d+$/.test(a)) host = a.slice(0, a.indexOf(':'))
  host = host.replace(/^\[|\]$/g, '').toLowerCase()
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host)
  if (mapped) return ipv4(mapped[1])
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (hex) return ((parseInt(hex[1], 16) << 16) >>> 0) + parseInt(hex[2], 16)
  return ipv4(host)
}

/** Is this address (a URL, host:port or bare IP) inside one of these CIDRs? A name (not an IP) is never inside. */
export function inSubnets(address: string, cidrs: string[]): boolean {
  const ip = hostIPv4(address)
  if (ip === null) return false
  return cidrs.some(c => {
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(c.trim())
    if (!m) return false
    const base = ipv4(m[1]); const bits = Number(m[2])
    if (base === null || bits > 32) return false
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
    return ((ip & mask) >>> 0) === ((base & mask) >>> 0)
  })
}

/**
 * The CIDRs auto-connect never connects into (HYPERPROX_AUTOCONNECT_EXCLUDE_SUBNETS, separated by commas, semicolons
 * or spaces). Fails closed: one entry that is not a valid IPv4 CIDR throws, and auto-connect does not run at all.
 */
export function envExcludedSubnets(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = String(env.HYPERPROX_AUTOCONNECT_EXCLUDE_SUBNETS ?? '')
  const list = raw.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean)
  const bad = list.filter(c => {
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(c)
    return !m || ipv4(m[1]) === null || Number(m[2]) > 32
  })
  if (bad.length) throw new Error(`HYPERPROX_AUTOCONNECT_EXCLUDE_SUBNETS has entries that are not IPv4 CIDRs (${bad.slice(0, 5).join(', ')}); auto-connect does not run until it is fixed.`)
  if (list.length > 256) throw new Error('HYPERPROX_AUTOCONNECT_EXCLUDE_SUBNETS has more than 256 entries.')
  return list
}

/** Why a guest or address must be left alone, or null. */
export function exclusionOf(ctx: Pick<AdapterContext, 'excludedMachines' | 'excludedSubnets'>, o: { machineId?: string | null; tags?: string[]; addresses?: Array<string | null | undefined> }): string | null {
  if (o.tags?.includes('hyperprox-ignore')) return 'the hyperprox-ignore tag'
  if (o.machineId && ctx.excludedMachines.has(o.machineId)) return 'Remote access\'s exclusion list'
  if ((o.addresses ?? []).some(a => a && inSubnets(a, ctx.excludedSubnets))) return 'an excluded subnet'
  return null
}

/**
 * Whether a finished Catalogue install still describes the guest now at its VMID. A VMID is reused after a guest is
 * destroyed: the install record then points at someone else's guest. It counts only while that guest is there and
 * carries the hostname the install gave it (an install with no recorded hostname counts on the VMID alone).
 */
export function installStillOwns(job: { hostname?: unknown }, guest: { name?: unknown } | undefined | null): boolean {
  if (!guest) return false
  const want = typeof job.hostname === 'string' ? job.hostname.trim().toLowerCase() : ''
  return !want || String(guest.name ?? '').trim().toLowerCase() === want
}
