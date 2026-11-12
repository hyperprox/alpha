// =============================================================================
//  HyperProx — ASUS router: the service
//
//  Reads: one reading per router, kept 8 seconds so several open pages, the
//  gallery card and the AI page cost one session; limited per person. The
//  router's admin session is reused between readings and logged out once it
//  has been idle for two minutes (ASUS allows one admin session, so HyperProx
//  holds it no longer than it is using it).
//
//  Setup does the chores: the person gives the address, user and password.
//  Adding a router pins its certificate on first use (https), signs in once to
//  prove the login, reads the model and firmware, and names the router after
//  its model when no name is given. A login that fails at setup is not saved.
//
//  One action, reboot, with one way in: POST .../actions, admin, a person
//  (never an API token), the master password re-entered (the gate), the confirm
//  phrase and the router's name typed (here), rate-limited, audited whatever the
//  outcome, a notification after it, and read back afterwards: HyperProx checks
//  the router came back with a fresh uptime and records that too.
//
//  A router that refuses the login is not asked again (not by the page, the
//  card or the AI page) until its login is saved again; one that has locked
//  logins is left alone until its own lockout has passed. Retrying a bad
//  password on a poll is exactly how a router locks its owner out.
// =============================================================================

import crypto from 'node:crypto'
import { hasRole, type Role } from '../roles'
import { probeCertificate } from '../clusters/tls-pin'
import { AsusClient, AsusLoginError } from './client'
import { endpointOf, type AsusInstanceStore, type AsusInput, type AsusMeta, type Prepared } from './instances'
import { FIRMWARE_KEYS, NAME_KEYS, unitNameOf, HOOKS, buildReading, dynamicHooks, firmwareOf, hookKey, looseJson, loosePairs, modeOf, nv, radioCount, sampleOf, staticHooks, type AsusReading, type CounterSample } from './parse'
import { DIAGNOSTIC_HOOKS, MAX_TOTAL_CHARS, MacMasker, redactAnswer } from './diagnostics'
import { DirectTransport, AsusUnreachableError, type AsusTransport } from './transport'
import { portOf, resolveAsusTarget } from './target'
import type { NotifyEventInput } from '../notify/types'

export interface Actor { sid: string; email: string; role: Role; token: string | null }

export class AsusRefusal extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); this.name = 'AsusRefusal' }
}

/** The phrase a reboot is confirmed with. The person also types the router's name. */
export const confirmPhrase = (name: string) => `Reboot ${name}`

export interface ActionRequest { action?: unknown; confirm?: unknown; typed?: unknown }

export interface Limits { readsPerMinute: number; attemptsPerMinute: number; rebootsPerHour: number; setupsPerMinute: number; diagnosticsPerMinute: number }

export type ActionState = { action: 'reboot'; at: string; by: string; state: 'sending' | 'sent' | 'unconfirmed' | 'back' | 'not_back'; detail: string | null }

/** The last reboot as a viewer may see it: not who did it. */
export function viewerAction(a: ActionState | null): Omit<ActionState, 'by'> | ActionState | null {
  if (!a) return null
  const { by: _b, ...rest } = a
  return rest
}

/** What a router's certificate probe shows a person before they confirm a pin. */
export interface PresentedCert { fingerprint: string; subject: string; issuer: string; validTo: string }

export interface ServiceDeps {
  store: AsusInstanceStore
  audit: (action: string, resource: string, details: Record<string, unknown>) => Promise<void>
  publish?: (e: NotifyEventInput) => Promise<void>
  /** Tests replace the transport. */
  transportFor?: (c: { url: string; meta: Pick<AsusMeta, 'insecureTLS' | 'fingerprint'> }) => AsusTransport
  /** The certificate an https address presents (first-use pin, and the probe a person confirms). Tests replace it. */
  probe?: (url: string) => Promise<PresentedCert>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  limits?: Partial<Limits>
  /** When a reboot's read-back looks, in ms after it was sent. */
  readBackAt?: number[]
}

export const CACHE_MS = 8_000
export const IDLE_LOGOUT_MS = 120_000
/** No counter sample this recent: take a second one 1.5 s later so the first reading already has rates. */
const SAMPLE_FRESH_MS = 60_000
const LOCK_DEFAULT_S = 15 * 60
/** Firmware, mode and radio settings change when someone reconfigures the unit: read them every 5 minutes. */
const STATIC_MS = 5 * 60_000

/**
 * Several hooks, as few requests as the firmware allows. Most Asuswrt builds answer a semicolon list in one go;
 * 388 builds answer only its first hook. So a list is sent once, every hook is checked for its answer, and any
 * that came back unanswered are asked one at a time; `multi` remembers which kind of firmware this is, so a
 * one-hook firmware is not sent lists again. Login refusals always propagate; after the first request, a single
 * hook that fails costs that value only.
 */
export async function readHooks(client: AsusClient, hooks: string[], multi: boolean | undefined): Promise<{ values: Record<string, any>; multi: boolean | undefined }> {
  const parse = (t: string | null) => looseJson(t) ?? loosePairs(t) ?? {}
  const answered = (v: Record<string, any>, h: string) => { const k = hookKey(h); return !k || k in v }
  if (!hooks.length) return { values: {}, multi }
  let values: Record<string, any> = {}
  let todo = hooks
  if (multi !== false) {
    // The first request carries the failure if the router is not there at all.
    values = parse(await client.hook(hooks.join(';')))
    todo = hooks.filter(h => !answered(values, h))
    if (hooks.length === 1) return { values, multi }
    if (hooks.length > 1) {
      if (!todo.length) multi = true
      // Exactly the first answered and nothing else: the one-hook kind.
      else if (answered(values, hooks[0]) && todo.length === hooks.length - 1) multi = false
      else if (todo.length < hooks.length - 1) multi = true
    }
  }
  for (const h of todo) {
    try { Object.assign(values, parse(await client.hook(h))) }
    catch (e) { if (e instanceof AsusLoginError) throw e }
  }
  return { values, multi }
}

/** "Not an ASUS router" is held for 15 minutes, doubling each time it repeats, up to 4 hours. */
const NOT_ASUS_FIRST_MS = 15 * 60_000
const NOT_ASUS_MAX_MS = 4 * 3_600_000

async function liveProbe(url: string): Promise<PresentedCert> {
  const u = new URL(url)
  const address = await resolveAsusTarget(u)
  const c = await probeCertificate(address, portOf(u), 10_000, u.hostname)
  return { fingerprint: c.fingerprint, subject: c.subject, issuer: c.issuer, validTo: c.validTo }
}

export class AsusService {
  private cache = new Map<string, { at: number; reading: AsusReading }>()
  private inflight = new Map<string, Promise<AsusReading>>()
  private blocked = new Map<string, { until: number | null; message: string }>()
  /** Consecutive "not an ASUS router" answers, for the back-off. Cleared by a good reading or a save. */
  private notAsus = new Map<string, number>()
  /** Per router: does its firmware answer a list of hooks in one call (readHooks)? Unknown until first asked. */
  private multi = new Map<string, boolean>()
  /** Per router: the slow-changing values (firmware, mode, radio settings), and whether it leads a mesh. */
  private statics = new Map<string, { at: number; values: Record<string, any>; mesh: boolean | null }>()
  private clients = new Map<string, { sig: string; client: AsusClient }>()
  private samples = new Map<string, CounterSample>()
  private actions = new Map<string, ActionState>()
  private hits = new Map<string, number[]>()
  /** Read-backs in flight, by router: tests await them. */
  readonly readBacks = new Map<string, Promise<void>>()
  private d: ServiceDeps & { now: () => number; sleep: (ms: number) => Promise<void>; limits: Limits; readBackAt: number[] }

  constructor(deps: ServiceDeps) {
    this.d = {
      now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)), readBackAt: [60_000, 120_000, 240_000], ...deps,
      limits: { readsPerMinute: 30, attemptsPerMinute: 10, rebootsPerHour: 3, setupsPerMinute: 5, diagnosticsPerMinute: 2, ...(deps.limits ?? {}) },
    }
  }

  get instances(): AsusInstanceStore { return this.d.store }

  /** Forget a router's held login, session, counters and cached reading: called when its login is saved again. */
  forget(id: string): void {
    this.blocked.delete(id); this.notAsus.delete(id); this.cache.delete(id); this.samples.delete(id); this.multi.delete(id); this.statics.delete(id)
    const c = this.clients.get(id)
    this.clients.delete(id)
    void c?.client.logout()
  }

  /** Why HyperProx is not asking this router, while it holds back after a refused login. */
  blockedReason(id: string): string | null {
    const b = this.blocked.get(id)
    if (!b) return null
    if (b.until !== null && this.d.now() >= b.until) { this.blocked.delete(id); return null }
    return b.message
  }

  lastAction(id: string): ActionState | null { return this.actions.get(id) ?? null }

  limit(actor: Actor, bucket: keyof Limits, message = 'Too many requests; wait a moment.', windowMs = 60_000): void {
    this.limitKeys([`sid:${actor.sid}`], bucket, message, windowMs)
  }

  /** One hit against every key, or none: all are checked before any is counted. */
  private limitKeys(keys: string[], bucket: keyof Limits, message: string, windowMs: number): void {
    const now = this.d.now()
    if (this.hits.size > 1000) for (const [k, v] of this.hits) if (!v.some(t => now - t < 3_600_000)) this.hits.delete(k)
    const rows = keys.map(k => [`${k}:${bucket}`, (this.hits.get(`${k}:${bucket}`) ?? []).filter(t => now - t < windowMs)] as const)
    for (const [k, recent] of rows) this.hits.set(k, recent)
    if (rows.some(([, recent]) => recent.length >= this.d.limits[bucket])) throw new AsusRefusal('rate_limited', message, 429)
    for (const [k, recent] of rows) this.hits.set(k, [...recent, now])
  }

  private transport(url: string, meta: Pick<AsusMeta, 'insecureTLS' | 'fingerprint'>): AsusTransport {
    return this.d.transportFor ? this.d.transportFor({ url, meta }) : new DirectTransport({ url, insecureTLS: meta.insecureTLS, fingerprint: meta.fingerprint })
  }

  private async meta(id: string): Promise<AsusMeta> {
    const m = await this.d.store.get(id)
    if (!m) throw new AsusRefusal('no_instance', 'No such router.', 404)
    return m
  }

  /** The router's client, reused while its address, login and pin are unchanged (so the session is reused too). */
  private async client(id: string): Promise<{ client: AsusClient; meta: AsusMeta }> {
    const c = await this.d.store.connection(id)
    if (!c) throw new AsusRefusal('not_configured', 'This router has no address or login yet.', 409)
    const sig = crypto.createHash('sha256').update([endpointOf(c.url), c.username, c.password, c.meta.fingerprint ?? '', c.meta.insecureTLS].join('\u0000')).digest('hex')
    const have = this.clients.get(id)
    if (have && have.sig === sig) return { client: have.client, meta: c.meta }
    if (have) void have.client.logout()
    const client = new AsusClient(this.transport(c.url, c.meta), { username: c.username, password: c.password }, { now: this.d.now })
    this.clients.set(id, { sig, client })
    return { client, meta: c.meta }
  }

  /** Turn a refused login into a hold, so nothing asks again before it can work. */
  private hold(id: string, e: unknown): never {
    if (e instanceof AsusLoginError) {
      const now = this.d.now()
      if (e.kind === 'locked') {
        const s = e.retryAfterSec ?? LOCK_DEFAULT_S
        this.blocked.set(id, { until: now + s * 1000, message: `${e.message} HyperProx will not try again until then.` })
      } else if (e.kind === 'busy') {
        this.blocked.set(id, { until: now + (e.retryAfterSec ?? 60) * 1000, message: `${e.message} HyperProx tries again in a minute.` })
      } else if (e.kind === 'not-asus') {
        // Not a password problem (nothing was refused), so not held for good: a router mid-boot or a firmware
        // page in the way answers like this. Backed off, so a wrong address is not asked every 10 seconds.
        const n = (this.notAsus.get(id) ?? 0) + 1
        this.notAsus.set(id, n)
        const ms = Math.min(NOT_ASUS_MAX_MS, NOT_ASUS_FIRST_MS * 2 ** (n - 1))
        this.blocked.set(id, { until: now + ms, message: `${e.message} HyperProx tries again in ${Math.round(ms / 60_000)} min, or as soon as the login is saved again.` })
      } else {
        this.blocked.set(id, { until: null, message: `${e.message} HyperProx will not try again until the login is saved again (so the router does not lock the account).` })
      }
      this.clients.delete(id)
    }
    throw e
  }

  /** A reading, from the last 8 seconds when there is one. `fresh` asks again when the cached one is over 3 seconds old. */
  async reading(id: string, o: { actor?: Actor; fresh?: boolean } = {}): Promise<AsusReading> {
    await this.meta(id)
    if (o.actor) this.limit(o.actor, 'readsPerMinute')
    const held = this.blockedReason(id)
    if (held) throw new AsusRefusal('login_held', held, 409)
    const hit = this.cache.get(id)
    const age = hit ? this.d.now() - hit.at : Infinity
    if (hit && age < (o.fresh ? 3_000 : CACHE_MS)) return hit.reading
    const running = this.inflight.get(id)
    if (running) return running
    const p = this.readNow(id)
    this.inflight.set(id, p)
    try { return await p } finally { this.inflight.delete(id) }
  }

  private async readNow(id: string): Promise<AsusReading> {
    const { client, meta } = await this.client(id)
    try {
      // A login refusal anywhere stops the whole reading; any other failure costs only that part.
      const part = (h: string) => client.hook(h).catch(e => { if (e instanceof AsusLoginError) throw e; return null })
      const read = async (hooks: string[]) => {
        const r = await readHooks(client, hooks, this.multi.get(id))
        if (r.multi !== undefined) this.multi.set(id, r.multi)
        return r.values
      }
      let st = this.statics.get(id)
      const slowCycle = !st || this.d.now() - st.at > STATIC_MS
      if (!st || slowCycle) {
        // The radio count first (wl_ifnames), so a one-hook firmware is not asked about radios it does not have.
        const base = await read(staticHooks(0))
        if (base.productid === undefined && base.firmver === undefined && base.sw_mode === undefined) {
          throw new AsusUnreachableError('The router answered, but not with its status. Is this an ASUS router on Asuswrt or Asuswrt-Merlin?')
        }
        const radios = await read(staticHooks(radioCount(base)).slice(staticHooks(0).length))
        st = { at: this.d.now(), values: { ...base, ...radios }, mesh: null }
        this.statics.set(id, st)
      }
      const routes = (() => { const k = modeOf(st.values).kind; return k === null || k === 'router' })()
      const dyn = await read(dynamicHooks(routes))
      const sys = { ...st.values, ...dyn }
      const system = JSON.stringify(sys)
      const wan = routes ? await part(HOOKS.wan) : null
      const clients = await part(HOOKS.clients)
      const channels = await part(HOOKS.channels)
      // A mesh list is asked for until it comes back empty, then again at the next slow refresh.
      let meshNodes: string | null = null, meshClients: string | null = null
      if (st.mesh !== false) {
        meshNodes = await part(HOOKS.meshNodes)
        const list = looseJson(meshNodes)?.get_cfg_clientlist
        st.mesh = Array.isArray(list) && list.length > 0
        if (st.mesh) meshClients = await part(HOOKS.meshClients)
      }
      let cur = sampleOf(sys, this.d.now())
      let prev = this.samples.get(id) ?? null
      if (!prev || cur.at - prev.at > SAMPLE_FRESH_MS) {
        await this.d.sleep(1_500)
        const again = await read(['cpu_usage(appobj)', 'netdev(appobj)']).catch(e => { if (e instanceof AsusLoginError) throw e; return null })
        if (again) { prev = cur; cur = sampleOf(again, this.d.now()) }
      }
      this.samples.set(id, cur)
      const reading = buildReading({ system, wan, clients, channels, mode: null, meshNodes, meshClients }, { instanceId: id, prev, cur, now: new Date(this.d.now()) })
      this.cache.set(id, { at: this.d.now(), reading })
      this.notAsus.delete(id)
      if (reading.model !== meta.model || reading.firmware.version !== meta.firmware) {
        await this.d.store.noteFound(id, { model: reading.model, firmware: reading.firmware.version }).catch(() => {})
      }
      // The unit's own name follows the unit (unless a person typed one), on the same 5-minute cycle as its settings.
      if (slowCycle) await this.d.store.adoptDeviceName(id, reading.unitName).catch(() => null)
      return reading
    } catch (e) { return this.hold(id, e) }
  }

  /** Log out every session that has sat unused. Production runs this every 30 seconds. */
  async sweep(idleMs = IDLE_LOGOUT_MS): Promise<void> {
    for (const { client } of this.clients.values()) await client.endIfIdle(idleMs).catch(() => {})
  }

  async closeAll(): Promise<void> {
    for (const { client } of this.clients.values()) await client.logout().catch(() => {})
    this.clients.clear()
  }

  // ── setup ──────────────────────────────────────────────────────────────────

  /**
   * Pin an https router's certificate on first use, then sign in once and read what it is. Throws AsusRefusal
   * with the router's own reason; one login attempt, never a retry.
   *
   * "First use" means a new address only: a router being added, or one whose address moved (both need the
   * password in the same save). An existing router never gets "whatever it presents now": a changed
   * certificate is pinned through probeCertificate(), shown to a person and confirmed by its fingerprint.
   */
  private async setUp(p: Prepared): Promise<{ fingerprint: string | null; pinnedNow: boolean; model: string | null; firmware: string | null; deviceName?: string | null }> {
    let fingerprint = p.fingerprint, pinnedNow = false
    if (p.moved && p.url.startsWith('https:') && !fingerprint && !p.insecureTLS) {
      try { fingerprint = (await (this.d.probe ?? liveProbe)(p.url)).fingerprint; pinnedNow = true }
      catch (e: any) { throw new AsusRefusal('unreachable', `HyperProx could not read the router's certificate to pin it: ${String(e?.message ?? 'no answer').slice(0, 160)}`, 400) }
    }
    if (!p.password) return { fingerprint, pinnedNow, model: null, firmware: null }
    const client = new AsusClient(this.transport(p.url, { insecureTLS: p.insecureTLS, fingerprint }), { username: p.username, password: p.password }, { now: this.d.now })
    try {
      const sys = (await readHooks(client, [...FIRMWARE_KEYS, ...NAME_KEYS].map(nv), undefined)).values
      if (sys.productid === undefined && sys.firmver === undefined) throw new AsusRefusal('not_asus', 'The router signed HyperProx in, but did not answer with its status.', 400)
      const fw = firmwareOf(sys)
      const model = (typeof sys.odmpid === 'string' && sys.odmpid.trim()) || (typeof sys.productid === 'string' && sys.productid.trim()) || null
      const m40 = model ? model.slice(0, 40) : null
      return { fingerprint, pinnedNow, model: m40, firmware: fw.version, deviceName: unitNameOf(sys, null, typeof sys.productid === 'string' ? sys.productid : null) }
    } catch (e: any) {
      if (e instanceof AsusRefusal) throw e
      if (e instanceof AsusLoginError) throw new AsusRefusal(`login_${e.kind}`, `${e.message} Nothing was saved.`, 400)
      throw new AsusRefusal('unreachable', `${e instanceof AsusUnreachableError ? e.message : 'The router could not be reached.'} Nothing was saved.`, 400)
    } finally { await client.logout() }
  }

  async add(input: AsusInput, actor: Actor): Promise<{ meta: AsusMeta; pinnedNow: boolean }> {
    this.limit(actor, 'setupsPerMinute', 'Too many routers tried in a minute; wait a moment.')
    const p = await this.d.store.prepare(null, input)
    const found = await this.setUp(p)
    const meta = await this.d.store.create({ ...p, fingerprint: found.fingerprint }, input.name, found)
    return { meta, pinnedNow: found.pinnedNow }
  }

  async edit(id: string, input: AsusInput, actor: Actor): Promise<{ meta: AsusMeta; pinnedNow: boolean; loginChanged: boolean }> {
    this.limit(actor, 'setupsPerMinute', 'Too many changes in a minute; wait a moment.')
    const p = await this.d.store.prepare(id, input)
    // A new address or login is proved before it is saved, as at setup (a moved https address is pinned again on
    // that first use). Removing the pin or accepting any certificate needs the password too (instances.ts), and
    // is proved the same way. A rename, or a pin a person confirmed from probeCertificate(), is not.
    const found = p.loginChanged ? await this.setUp(p) : null
    const meta = await this.d.store.update(id, { ...p, fingerprint: found ? found.fingerprint : p.fingerprint }, input.name, found && found.model ? found : null)
    this.forget(id)
    return { meta, pinnedNow: !!found?.pinnedNow, loginChanged: p.loginChanged }
  }

  // ── the action ─────────────────────────────────────────────────────────────

  /**
   * Every hook the plug-in calls and the candidates in diagnostics.ts, each sent on its own, with secrets and MACs
   * taken out (diagnostics.ts). Reads only. Refused while a login is held, so it can never be the call that locks
   * the account; audited, since an admin (or an admin's API token) is reading the router's raw answers.
   */
  async diagnostics(id: string, actor: Actor): Promise<{ router: string; at: string; calls: Array<{ name: string; hook: string; status: 'ok' | 'no-answer' | 'error'; json: boolean; chars: number; truncated: boolean; body: string | null }>; truncated: boolean }> {
    const m = await this.meta(id)
    this.limitKeys([`sid:${actor.sid}`, `router:${m.id}`], 'diagnosticsPerMinute', 'One diagnostics read at a time; wait a moment.', 60_000)
    const held = this.blockedReason(m.id)
    if (held) throw new AsusRefusal('login_held', held, 409)
    await this.d.audit('asus.diagnostics', `asus:${m.id}`, { by: actor.email, via: actor.token ? `api:${actor.token}` : 'session', router: m.name })
    const { client } = await this.client(m.id)
    const masks = new MacMasker()
    const calls = []
    let total = 0, truncated = false
    for (const [name, hook] of DIAGNOSTIC_HOOKS) {
      if (total >= MAX_TOTAL_CHARS) { truncated = true; break }
      try {
        const text = await client.hook(hook)
        const r = redactAnswer(text, masks)
        const room = MAX_TOTAL_CHARS - total
        const body = r.body && r.body.length > room ? r.body.slice(0, room) : r.body
        total += body?.length ?? 0
        calls.push({ name, hook, status: (text === null ? 'no-answer' : 'ok') as 'ok' | 'no-answer', json: r.json, chars: r.chars, truncated: r.truncated || body !== r.body, body })
      } catch (e: any) {
        if (e instanceof AsusLoginError) return this.hold(m.id, e)
        calls.push({ name, hook, status: 'error' as const, json: false, chars: 0, truncated: false, body: masks.text(String(e?.message ?? 'failed').slice(0, 200)) })
      }
    }
    return { router: m.name, at: new Date(this.d.now()).toISOString(), calls, truncated }
  }

  /** The certificate an https address presents now, for a person to compare and confirm. Nothing is sent to it. */
  async probeCertificate(url: unknown, actor: Actor): Promise<PresentedCert> {
    this.limit(actor, 'setupsPerMinute', 'Too many certificate reads; wait a moment.')
    let u: URL
    try { u = new URL(String(url ?? '')) } catch { throw new AsusRefusal('bad_input', 'Enter the router\'s https:// address first.') }
    if (u.protocol !== 'https:') throw new AsusRefusal('bad_input', 'Only an https:// address has a certificate to pin.')
    try { return await (this.d.probe ?? liveProbe)(`${u.protocol}//${u.host}`) }
    catch (e: any) { throw new AsusRefusal('bad_input', e?.name === 'AsusTargetError' ? e.message : 'Could not read a certificate from that address.') }
  }

  async auditRefusal(id: string, actor: Actor | null, req: ActionRequest, code: string): Promise<void> {
    await this.d.audit('asus.action', `asus:${String(id).replace(/[^a-z0-9]/gi, '').slice(0, 20)}`, {
      by: actor?.email ?? 'anonymous', via: actor?.token ? `api:${actor.token}` : actor ? 'session' : 'none',
      action: typeof req.action === 'string' ? req.action.slice(0, 20) : '', result: `refused:${code}`,
    })
  }

  async act(id: string, req: ActionRequest, actor: Actor): Promise<{ ok: true; message: string; action: string }> {
    let m: AsusMeta
    try { m = await this.meta(id) } catch (e: any) { await this.auditRefusal(id, actor, req, e?.code ?? 'error'); throw e }
    const action = typeof req.action === 'string' ? req.action.slice(0, 20) : ''
    const base = { by: actor.email, via: actor.token ? `api:${actor.token}` : 'session', router: m.name, routerId: m.id, action }
    const refuse = async (e: AsusRefusal): Promise<never> => {
      await this.d.audit('asus.action', `asus:${m.id}`, { ...base, result: `refused:${e.code}` })
      throw e
    }
    try { this.limit(actor, 'attemptsPerMinute', 'Too many attempts in a minute; wait a moment.') } catch (e: any) { return refuse(e) }
    if (action !== 'reboot') return refuse(new AsusRefusal('action_not_allowed', 'The ASUS plug-in offers one action: reboot the router.'))
    if (actor.token) return refuse(new AsusRefusal('token_forbidden', 'API tokens can never reboot a router.', 403))
    if (!hasRole(actor.role, 'admin')) return refuse(new AsusRefusal('forbidden', 'Rebooting a router needs the admin role.', 403))
    const typed = typeof req.typed === 'string' ? req.typed.trim().toLowerCase() : ''
    if (req.confirm !== confirmPhrase(m.name) || typed !== m.name.toLowerCase()) {
      return refuse(new AsusRefusal('confirm_required', 'Confirm the reboot and type the router\'s name exactly as shown.', 409))
    }
    // From here to the 'sending' mark there is no await, so two requests cannot both pass the checks.
    const held = this.blockedReason(m.id)
    if (held) return refuse(new AsusRefusal('login_held', held, 409))
    const pending = this.actions.get(m.id)
    if ((pending && (pending.state === 'sending' || pending.state === 'sent')) || this.readBacks.has(m.id)) {
      return refuse(new AsusRefusal('in_progress', `${m.name} is still coming back from the last reboot.`, 409))
    }
    // Per router and per person, not per browser session: signing in again does not buy another reboot.
    try { this.limitKeys([`router:${m.id}`, `email:${actor.email.toLowerCase()}`], 'rebootsPerHour', 'That is the most reboots allowed in an hour.', 3_600_000) } catch (e: any) { return refuse(e) }
    this.actions.set(m.id, { action: 'reboot', at: new Date(this.d.now()).toISOString(), by: actor.email, state: 'sending', detail: null })

    let answer
    try { const { client } = await this.client(m.id); answer = await client.reboot() }
    catch (e: any) {
      if (pending) this.actions.set(m.id, pending); else this.actions.delete(m.id)
      const msg = e instanceof AsusUnreachableError || e instanceof AsusLoginError || e instanceof AsusRefusal ? e.message : 'The router did not accept the request.'
      await this.d.audit('asus.action', `asus:${m.id}`, { ...base, result: 'failed', reason: msg })
      await this.notify(m, actor, 'failed')
      if (e instanceof AsusLoginError) { try { this.hold(m.id, e) } catch { /* held */ } }
      throw new AsusRefusal('call_failed', msg, 502)
    }
    const startedAt = this.d.now()
    const before = this.cache.get(m.id)?.reading.uptimeSec ?? null
    this.cache.delete(m.id); this.samples.delete(m.id); this.clients.delete(m.id)
    const state: ActionState = { action: 'reboot', at: new Date(startedAt).toISOString(), by: actor.email, state: answer.accepted ? 'sent' : 'unconfirmed', detail: answer.detail }
    this.actions.set(m.id, state)
    await this.d.audit('asus.action', `asus:${m.id}`, { ...base, result: answer.accepted ? 'sent' : 'unconfirmed', detail: answer.detail })
    await this.notify(m, actor, answer.accepted ? 'sent' : 'unconfirmed')
    this.readBacks.set(m.id, this.readBack(m, actor, startedAt, before).finally(() => this.readBacks.delete(m.id)))
    const message = answer.accepted
      ? `${m.name} is rebooting. Wi-Fi and the internet drop for 2 to 4 minutes; HyperProx checks it came back and records the result.`
      : `${m.name} did not confirm the reboot (${answer.detail}). HyperProx checks in a minute whether it restarted anyway.`
    return { ok: true, message, action }
  }

  /** After a reboot: read the router again and decide from its uptime whether it really restarted and came back. */
  private async readBack(m: AsusMeta, actor: Actor, startedAt: number, uptimeBefore: number | null): Promise<void> {
    let waited = 0
    for (const at of this.d.readBackAt) {
      await this.d.sleep(Math.max(0, at - waited)); waited = at
      if (!(await this.d.store.get(m.id))) return
      let r: AsusReading
      try { r = await this.readNow(m.id) } catch (e) { if (e instanceof AsusLoginError) break; continue }
      const since = (this.d.now() - startedAt) / 1000
      const restarted = r.uptimeSec !== null && r.uptimeSec <= since + 30 && (uptimeBefore === null || r.uptimeSec < uptimeBefore)
      const state = this.actions.get(m.id)
      if (restarted) {
        if (state) this.actions.set(m.id, { ...state, state: 'back', detail: `up again, uptime ${Math.round(r.uptimeSec!)} s` })
        await this.d.audit('asus.action.verify', `asus:${m.id}`, { by: actor.email, router: m.name, routerId: m.id, action: 'reboot', result: 'back', uptimeSec: r.uptimeSec })
        return
      }
      if (r.uptimeSec !== null && state?.state === 'unconfirmed') {
        this.actions.set(m.id, { ...state, state: 'not_back', detail: 'it answered without having restarted' })
        await this.d.audit('asus.action.verify', `asus:${m.id}`, { by: actor.email, router: m.name, routerId: m.id, action: 'reboot', result: 'not_restarted', uptimeSec: r.uptimeSec })
        return
      }
    }
    const state = this.actions.get(m.id)
    if (state) this.actions.set(m.id, { ...state, state: 'not_back', detail: 'not answering since the reboot' })
    await this.d.audit('asus.action.verify', `asus:${m.id}`, { by: actor.email, router: m.name, routerId: m.id, action: 'reboot', result: 'not_back' })
    await this.notify(m, actor, 'not_back')
  }

  private async notify(m: AsusMeta, actor: Actor, what: 'sent' | 'unconfirmed' | 'failed' | 'not_back'): Promise<void> {
    if (!this.d.publish) return
    const title = what === 'sent' ? `Reboot: ${m.name}` : what === 'unconfirmed' ? `Reboot of ${m.name} not confirmed`
      : what === 'failed' ? `Reboot of ${m.name} did not go through` : `${m.name} has not come back after a reboot`
    await this.d.publish({
      type: 'alert.asus.power', severity: what === 'not_back' ? 'critical' : 'warning', title,
      lines: [`By ${actor.email}.`], plain: [m.name], link: '/plugins/asus', where: 'ASUS plug-in', subject: { kind: 'router', name: m.name },
    } as NotifyEventInput).catch(() => {})
  }
}
