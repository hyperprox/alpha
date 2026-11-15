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
}

const sid = (plugin: string, key: string) => `${plugin}/${key}`

export class AutoConnectError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = 'AutoConnectError' }
}

export class Reconciler {
  private running: Promise<RunResult> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  /** A pass was skipped because the vault was locked: the unlock runs it. */
  waitingForUnlock = false
  private now: () => number

  constructor(private d: ReconcilerDeps) { this.now = d.now ?? Date.now }

  adapter(plugin: string): AutoConnectAdapter | undefined { return this.d.adapters.find(a => a.plugin === plugin) }

  private context(state: AutoConnectState, excluded: string[], plugin: string): AdapterContext {
    return {
      dismissed: k => !!state.dismissed[sid(plugin, k)],
      autoConnectedBefore: k => !!state.connected[sid(plugin, k)],
      excludedMachines: new Set(excluded),
      excludedSubnets: this.d.excludedSubnets(),
      vaultItems: () => (this.d.unlocked() ? this.d.vaultItems() : []),
      // As the system, always; whatever an adapter passes as `by` is replaced.
      audit: (a, r, det) => this.d.audit(a, r, { ...det, by: SYSTEM_ACTOR }),
      now: this.now,
    }
  }

  /** One pass over every plug-in. One at a time; a second call while one runs gets the same answer. */
  run(reason: string): Promise<RunResult> {
    if (this.running) return this.running
    this.running = this.pass(reason).finally(() => { this.running = null })
    return this.running
  }

  private async pass(reason: string): Promise<RunResult> {
    if (!this.d.unlocked()) {
      this.waitingForUnlock = true
      return { waited: 'locked', outcomes: {} }
    }
    let excluded: string[]
    try { excluded = await this.d.excluded() } catch {
      this.d.log?.('[auto-connect] Remote access\'s exclusion list could not be read; nothing is connected until it can')
      return { waited: 'exclusions', outcomes: {} }
    }
    this.waitingForUnlock = false
    const state = await this.d.store.get()
    const outcomes: Record<string, Outcome[]> = {}
    let lockedMidway = false
    for (const a of this.d.adapters) {
      let list: Outcome[]
      try { list = await a.reconcile(this.context(state, excluded, a.plugin)) } catch (e: any) {
        if (e?.name === 'VaultLockedError' || !this.d.unlocked()) { lockedMidway = true; list = [] }
        else { this.d.log?.(`[auto-connect] ${a.plugin}: ${e?.message ?? e}`); list = [{ key: '*', label: a.plugin, did: 'failed', message: String(e?.message ?? e).slice(0, 300) }] }
      }
      outcomes[a.plugin] = list
      this.apply(state, a.plugin, list)
    }
    if (lockedMidway) this.waitingForUnlock = true
    const results: Record<string, Partial<Record<Did, number>>> = {}
    for (const [p, list] of Object.entries(outcomes)) for (const o of list) { results[p] ??= {}; results[p][o.did] = (results[p][o.did] ?? 0) + 1 }
    state.lastRun = { at: this.now(), reason: reason.slice(0, 40), waited: lockedMidway ? 'locked' : null, results }
    await this.d.store.put(state)
    return { waited: lockedMidway ? 'locked' : null, outcomes }
  }

  /** What a pass's outcomes change in the remembered state. */
  private apply(state: AutoConnectState, plugin: string, list: Outcome[]) {
    const seenPending = new Set<string>()
    for (const o of list) {
      if (o.key === '*') continue
      const k = sid(plugin, o.key)
      if (o.did === 'connected' || o.did === 'filled') {
        state.connected[k] = { at: this.now(), label: o.label, evidence: (o.evidence ?? []).slice(0, 10), vaultItem: o.vaultItem ?? null }
        delete state.pending[k]
      } else if (o.did === 'dismissed' && !state.dismissed[k]) {
        // Connected by an earlier pass and taken away by a person since (a setting cleared): remembered as theirs.
        state.dismissed[k] = { at: this.now(), label: o.label, by: 'a person (cleared it)' }
        delete state.connected[k]
      } else if (o.did === 'ambiguous') {
        seenPending.add(k)
        state.pending[k] = { at: state.pending[k]?.at ?? this.now(), label: o.label, message: o.message ?? 'More than one candidate.', choiceKind: o.choiceKind ?? 'container', choices: (o.choices ?? []).slice(0, 20) }
      }
    }
    // A choice that is no longer ambiguous (connected by hand, gone, dismissed) is not left pending.
    for (const k of Object.keys(state.pending)) if (k.startsWith(`${plugin}/`) && !seenPending.has(k)) delete state.pending[k]
  }

  /** A person disconnected or removed it: never add it again until they say so. */
  async dismiss(plugin: string, key: string, label: string, by: string): Promise<void> {
    const state = await this.d.store.get()
    const k = sid(plugin, key)
    state.dismissed[k] = { at: this.now(), label: label.slice(0, 120), by: by.slice(0, 200) }
    delete state.connected[k]
    delete state.pending[k]
    await this.d.store.put(state)
  }

  /** "Connect again": forget the dismissal, then run a pass so it is connected now. */
  async connectAgain(plugin: string, key: string, by: string): Promise<RunResult> {
    const state = await this.d.store.get()
    const k = sid(plugin, key)
    if (!state.dismissed[k]) throw new AutoConnectError('not_dismissed', 'That one was not disconnected.', 404)
    await this.d.audit('autoconnect.connect_again', k, { by, label: state.dismissed[k].label })
    delete state.dismissed[k]
    await this.d.store.put(state)
    return this.run('connect-again')
  }

  /** A person picked one of a pending choice's options. */
  async pick(plugin: string, key: string, choiceId: string, by: string): Promise<Outcome> {
    if (!this.d.unlocked()) throw new AutoConnectError('locked', 'HyperProx is locked. Sign in, then pick again.', 423)
    const a = this.adapter(plugin)
    const state = await this.d.store.get()
    const k = sid(plugin, key)
    const p = state.pending[k]
    if (!a?.pick || !p) throw new AutoConnectError('no_choice', 'There is nothing to pick there any more.', 404)
    if (!p.choices.some(c => c.id === choiceId)) throw new AutoConnectError('bad_choice', 'Pick one of the listed options.', 400)
    let excluded: string[]
    try { excluded = await this.d.excluded() } catch { throw new AutoConnectError('exclusions_unknown', 'Remote access\'s exclusion list could not be read, so nothing is connected until it can.', 503) }
    // The person's pick, audited as theirs; the connecting itself is the adapter's read-only connect.
    await this.d.audit('autoconnect.pick', k, { by, choice: choiceId, choiceKind: p.choiceKind })
    const ctx = this.context(state, excluded, plugin)
    const o = await a.pick(key, choiceId, { ...ctx, audit: (ac, r, det) => this.d.audit(ac, r, { ...det, by }) }, by)
    this.apply(state, plugin, [o])
    if (o.did !== 'ambiguous') delete state.pending[k]
    await this.d.store.put(state)
    return o
  }

  async state(): Promise<AutoConnectState> { return this.d.store.get() }

  /** The timer (discovery cadence) and the unlock hook. Returns a stop function. */
  start(onUnlock: (cb: () => void) => void): () => void {
    if (this.timer) return () => {}
    this.timer = setInterval(() => { void this.run('timer').catch(() => {}) }, AUTO_TICK_MS)
    this.timer.unref?.()
    // Right after an unlock, and at start-up in case the vault is already open.
    onUnlock(() => { void this.run('unlock').catch(() => {}) })
    const first = setTimeout(() => { void this.run('start').catch(() => {}) }, 30_000)
    first.unref?.()
    return () => { if (this.timer) clearInterval(this.timer); this.timer = null; clearTimeout(first) }
  }
}

export interface RunResult { waited: 'locked' | 'exclusions' | null; outcomes: Record<string, Outcome[]> }

// ── shared checks ───────────────────────────────────────────────────────────

const ipv4 = (s: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m || m.slice(1).some(x => Number(x) > 255)) return null
  return ((Number(m[1]) << 24) >>> 0) + (Number(m[2]) << 16) + (Number(m[3]) << 8) + Number(m[4])
}

/** Is this address (a URL, host:port or bare IPv4) inside one of these CIDRs? A name (not an IP) is never inside. */
export function inSubnets(address: string, cidrs: string[]): boolean {
  let host = String(address ?? '').trim()
  try { host = new URL(/^[a-z]+:\/\//i.test(host) ? host : `http://${host}`).hostname } catch { /* as given */ }
  const ip = ipv4(host)
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

/** The CIDRs auto-connect never connects into (HYPERPROX_AUTOCONNECT_EXCLUDE_SUBNETS, comma-separated). */
export function envExcludedSubnets(env: NodeJS.ProcessEnv = process.env): string[] {
  return String(env.HYPERPROX_AUTOCONNECT_EXCLUDE_SUBNETS ?? '').split(/[,\s]+/).map(s => s.trim()).filter(s => /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(s)).slice(0, 64)
}

/** Why a guest or address must be left alone, or null. */
export function exclusionOf(ctx: Pick<AdapterContext, 'excludedMachines' | 'excludedSubnets'>, o: { machineId?: string | null; tags?: string[]; addresses?: Array<string | null | undefined> }): string | null {
  if (o.tags?.includes('hyperprox-ignore')) return 'the hyperprox-ignore tag'
  if (o.machineId && ctx.excludedMachines.has(o.machineId)) return 'Remote access\'s exclusion list'
  if ((o.addresses ?? []).some(a => a && inSubnets(a, ctx.excludedSubnets))) return 'an excluded subnet'
  return null
}
