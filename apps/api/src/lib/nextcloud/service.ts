// =============================================================================
//  HyperProx — Nextcloud: the service
//
//  Reads: one reading per instance, kept 30 seconds (a fresh read at most every
//  10). occ in the guest (one round trip for every read) is the source of
//  truth; the optional OCS login adds what only the web side knows (active
//  users, storage, PHP and database details, and the admin page's own setup
//  checks, which know the request).
//
//  Actions: every one is an admin's, a signed-in person's (an API token is
//  refused by name), audited BEFORE it runs (no audit row, no action), one at a
//  time per instance, and either one allow-listed occ command with checked
//  arguments or a fixed sequence of them (lib/nextcloud/update.ts). Which
//  actions also need the master password re-entered is fixed here (ACTIONS),
//  not chosen by the caller: a secure action on the plain route is refused.
//  Adding, changing and removing an instance are audited before they act too.
//
//  Long work is kept in the database (lib/nextcloud/jobs.ts) and registered in
//  lib/long-jobs.ts while it runs, so deploy.sh and the in-app updater do not
//  restart the API under it. The update itself runs detached in the guest; on
//  startup resume() watches it again.
// =============================================================================

import crypto from 'node:crypto'
import { hasRole } from '../roles'
import { busyJobs as realBusyJobs, endLongJob as realEndLongJob, registerLongJob as realRegisterLongJob, type LongJob } from '../long-jobs'
import { ACTIONS, countable, isAction, remedyFor, suggestRegion, suggestServerId, suggestWindow, type ActionId } from './checks'
import { DetectAmbiguous, parseDetect, DETECT_SCRIPT, type Deployment } from './detect'
import { OccRefusal, batch, newNonce, occScript, REGIONS, SMTP_KEYS, type OccId, type OccTarget, type ReadKey, NC_GROUP_RE, CONTAINER_RE } from './occ'
import type { NcInstanceStore } from './instances'
import { cleanAppPassword, cleanGuest, cleanName, cleanUrl, cleanUser, loginChangeProblem } from './instances'
import {
  configValue, parseActiveCalls, parseSystemConfig, parseAppList, parseAuthTokens, parseEnforceState, parseExApps, parseGroupMembers, parseLog,
  parseServerInfo, parseSetupChecks, parseStatus, parseTwoFactorState, parseUpdateCheck, parseUserList, parseUserReport, type EnforceState, type SetupCheck,
} from './parse'
import type { OcsGet } from './ocs'
import {
  HPB_STEPS, JOB_ID_RE, UPDATE_STEPS, backupDirOf, launchScript, parsePoll, parseRoom, pollScript, preflightScript, roomProblem, rollbackWords, runHpbUpdate,
  type HpbPlan, type RunIO, type UpdatePlan,
} from './update'
import { MemoryJobStore, type JobStore } from './jobs'
import { SYSTEM_ACTOR, exclusionOf, type AdapterContext, type Outcome } from '../auto-connect/core'
import { inCidrs, parseIPv4 } from '../net/ip'
import { EXCLUSION_WORDS, IGNORE_TAG } from '../guest-guard'
import { matchVault, pickVault, type VaultChoice } from '../auto-connect/vault-match'
import { NcRefusal, type Actor, type BusyHoursLike, type CheckView, type GuestRef, type Job, type JobStep, type NcMeta, type Reading } from './types'
import { machineId } from '../guest-id'

export interface GuestRow {
  kind: 'lxc' | 'qemu'; vmid: number; name: string; node: string; running: boolean
  /** HyperProx must leave it alone (lib/guest-guard.ts); `excludedBy` says why, in words. */
  ignored: boolean; excludedBy?: string | null
}

export interface LongJobRegistry {
  register(j: { id: string; owner: string; label: string; detached: boolean; guest?: GuestRef | null }): void
  end(id: string): void
  list(owner?: string): LongJob[]
}

export const realLongJobs: LongJobRegistry = { register: realRegisterLongJob, end: realEndLongJob, list: realBusyJobs }

export interface ServiceDeps {
  store: NcInstanceStore
  /** Must throw when the row could not be written: an action is never taken unaudited. */
  audit: (action: string, resource: string, details: Record<string, unknown>) => Promise<void>
  /** A script in the guest, as root, through its node's login. */
  exec: (g: GuestRef, script: string, o?: { timeoutMs?: number; onData?: (chunk: string) => void }) => Promise<{ code: number; output: string; timedOut: boolean }>
  guests: () => Promise<GuestRow[]>
  ocs: (l: { url: string; user: string; appPassword: string }) => OcsGet
  /** HyperProx's busy hours (Load balancing settings) and the cluster's time zone, or null. */
  quietHours: () => Promise<{ busy: BusyHoursLike[]; tz: string | null } | null>
  /** A backup task (vzdump) of this guest running now: true, false, or null when it cannot be told. */
  backupRunning: (g: GuestRef) => Promise<boolean | null>
  /** Why this guest cannot be snapshotted (bind mounts), or null when it can or it cannot be told. */
  snapshotNote: (g: GuestRef) => Promise<string | null>
  /** Where jobs are kept (production: the database). */
  jobs?: JobStore
  /** Where running long work is registered for deploy.sh and the updater (production: lib/long-jobs.ts). */
  longJobs?: LongJobRegistry
  /** How often a detached update is read (ms). */
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Where Nextcloud was seen without looking inside: the shared scan's probe, Catalogue installs (auto-connect). */
  sightings?: () => Promise<Array<{ guest: GuestRef; url: string | null; via: string; admin?: string | null; ip?: string | null }>>
  /** A person removed this instance: auto-connect must never add its guest back by itself. */
  dismissed?: (key: string, label: string, by: string) => Promise<void>
  /** Tell the admins (notifications): an app password HyperProx made could not be revoked, and the like. */
  alert?: (title: string, lines: string[]) => Promise<void>
}

const WEB_LOGIN_RETRY_MS = 6 * 60 * 60_000
const WEB_LOGIN_MAX_MS = 24 * 60 * 60_000

/** The auto-connect key of a guest (Remote access's machine id). */
export const machineKey = (g: GuestRef) => machineId({ type: g.kind, vmid: g.vmid })

const CACHE_MS = 30_000
const FRESH_MS = 10_000
const ACTIVE_WINDOW_S = 10 * 60
const READ_TIMEOUT = 120_000
const MAX_LINES = 400
/** A detached update the guest has not answered about for this long is given up on (its marker is cleared). */
const LOST_CONTACT_MS = 3 * 60 * 60_000

const READ_KEYS: ReadKey[] = ['maintenance_window_start', 'default_phone_region', 'serverid', 'default_timezone', 'default_locale', 'default_language',
  'mail_smtpmode', 'mail_smtphost', 'mail_smtpport', 'mail_smtpsecure', 'mail_from_address', 'mail_domain', 'upgrade.disable-web', 'dbname', 'dbuser', 'overwrite.cli.url']
/** Second factors a user can set up by themselves at the sign-in that enforcement forces (backup codes and the rest cannot). */
const SETUP_PROVIDERS = ['twofactor_totp', 'twofactor_webauthn']

const hpbMissing = (desc: string) => (/missing features?:\s*([A-Za-z0-9_, -]{1,300})/i.exec(desc)?.[1] ?? '').split(/[,\s]+/).filter(Boolean).slice(0, 20)
const APP_PASSWORD_OUT = /^\s*([A-Za-z0-9]{5}(?:-[A-Za-z0-9]{5}){4}|[A-Za-z0-9]{64,128})\s*$/m
const SERVERINFO = '/ocs/v2.php/apps/serverinfo/api/v1/info?format=json' as const

export interface TwoFactorView {
  users: Array<{ uid: string; state: 'on' | 'off' | null }>
  /** User ids HyperProx does not pass to occ (a space, a quote): unknown, so enforcing is refused while there are any. */
  excluded: string[]
  truncated: boolean
  providers: string[]
  enforcement: EnforceState | null
  /** Members of the admin group and whether each has a second factor. */
  admins: Array<{ uid: string; state: 'on' | 'off' | null }>
}

export class NextcloudService {
  private cache = new Map<string, { at: number; r: Reading }>()
  private jobs = new Map<string, Job>()
  private busy = new Set<string>()
  private actionTimes = new Map<string, number[]>()
  private resumed = false
  /** Jobs a person told HyperProx to stop watching: their watch and their in-process completion change nothing. */
  private abandoned = new Set<string>()
  readonly now: () => number
  private sleep: (ms: number) => Promise<void>
  private store: JobStore
  private long: LongJobRegistry

  constructor(private d: ServiceDeps) {
    this.now = d.now ?? Date.now
    this.sleep = d.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
    this.store = d.jobs ?? new MemoryJobStore()
    this.long = d.longJobs ?? realLongJobs
  }

  get instances(): NcInstanceStore { return this.d.store }

  private async meta(id: string): Promise<NcMeta> {
    const m = await this.d.store.get(id)
    if (!m) throw new NcRefusal('no_instance', 'No such Nextcloud.', 404)
    return m
  }

  private async run(g: GuestRef, script: string, timeoutMs = READ_TIMEOUT, onData?: (c: string) => void) {
    const r = await this.d.exec(g, script, { timeoutMs, onData })
    return { code: r.timedOut ? -1 : r.code, output: r.output }
  }

  /** Run `fn` holding the per-instance (or per-guest) lock; refused while something else holds it. */
  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(key)) throw new NcRefusal('busy', 'Another Nextcloud action is still running here; wait for it to finish.', 409)
    this.busy.add(key)
    try { return await fn() } finally { this.busy.delete(key) }
  }

  // ── finding it ─────────────────────────────────────────────────────────────

  /** Running guests a Nextcloud could be in (admin; for the add form). */
  async candidates(): Promise<GuestRow[]> {
    return (await this.d.guests()).filter(g => !g.ignored)
  }

  /** Read-only: how Nextcloud is installed in this guest. */
  async detect(guest: unknown, actor: Actor): Promise<Deployment> {
    this.mustAdmin(actor)
    const g = cleanGuest(guest)
    const row = (await this.d.guests()).find(x => x.kind === g.kind && x.vmid === g.vmid)
    if (!row) throw new NcRefusal('no_guest', `There is no ${g.kind === 'lxc' ? 'container' : 'VM'} ${g.vmid}.`, 404)
    if (row.ignored) throw new NcRefusal('ignored', `${row.name} is left alone (${row.excludedBy ?? 'the hyperprox-ignore tag'}), so HyperProx never looks inside it.`, 403)
    if (!row.running) throw new NcRefusal('not_running', `${row.name} is not running.`, 409)
    return this.detectIn(g, row.name)
  }

  private async detectIn(g: GuestRef, name = 'the guest', prefer?: string): Promise<Deployment> {
    const r = await this.run(g, DETECT_SCRIPT, 90_000)
    let dep: Deployment | null
    try { dep = parseDetect(r.output, prefer) } catch (e: any) {
      if (e instanceof DetectAmbiguous) throw new NcRefusal('ambiguous', e.message, 409, { containers: e.names })
      throw new NcRefusal('detect_failed', e?.message ?? 'The detection did not finish.', 502)
    }
    if (!dep) throw new NcRefusal('not_found', `No Nextcloud was found in ${name}: no running container with occ, and no occ in the usual places.`, 404)
    return dep
  }

  // ── instances ──────────────────────────────────────────────────────────────

  private async testLogin(url: string, user: string, appPassword: string): Promise<void> {
    try { if (!parseServerInfo(await this.d.ocs({ url, user, appPassword })(SERVERINFO))) throw new Error('Nextcloud answered, but not with server info (is the serverinfo app on?).') }
    catch (e: any) { throw new NcRefusal('ocs_failed', `The web login did not work: ${e?.message ?? 'no answer'}`, 400) }
  }

  /** The id of the permanent token `user` used at or after `since` (the read just made with it), when exactly one did. */
  private async tokenIdFor(g: GuestRef, occ: OccTarget, user: string, since: number, known: number[] = []): Promise<number | null> {
    const b = batch(occ, [{ key: 't', id: 'auth-tokens', params: { uid: user } }])
    const t = b.parse((await this.run(g, b.script)).output).t
    const list = t ? parseAuthTokens(t.output).filter(k => k.type === 1 && k.id > 0) : []
    const fresh = known.length ? list.filter(k => !known.includes(k.id)) : list.filter(k => k.lastActivity >= Math.floor(since / 1000) - 5)
    return fresh.length === 1 ? fresh[0].id : null
  }

  /**
   * Add. Everything is checked before anything is made or saved: the name, the guest and Nextcloud in it, that it is
   * not added already, the address and the login. Only then, with `createAppPassword`, is HyperProx's own app password
   * made; it is revoked again if anything after that fails. The audit row is written before the instance is saved.
   */
  async add(body: Record<string, unknown>, actor: Actor): Promise<NcMeta> {
    this.mustPerson(actor)
    const name = cleanName(body.name)
    const guest = cleanGuest(body.guest)
    const create = body.createAppPassword === true
    let url: string | null = body.url ? cleanUrl(body.url) : null
    const user = body.user ? cleanUser(body.user) : null
    const pasted: string | null = body.appPassword ? cleanAppPassword(body.appPassword) : null
    if (create && pasted) throw new NcRefusal('bad_input', 'Paste an app password or let HyperProx make one, not both.')
    if (create && !user) throw new NcRefusal('bad_input', 'Name the admin user HyperProx should make its app password for.')
    return this.locked(`guest:${machineKey(guest)}`, async () => {
      const dep = await this.detect(guest, actor)
      if ((await this.d.store.list()).some(m => m.guest.kind === guest.kind && m.guest.vmid === guest.vmid)) throw new NcRefusal('duplicate', 'That guest is already added.', 409)
      if (create && !url) {
        const b = batch(dep.occ, [{ key: 'u', id: 'config-get', params: { key: 'overwrite.cli.url' } }])
        const cli = configValue(b.parse((await this.run(guest, b.script)).output).u)
        if (cli) { try { url = cleanUrl(cli) } catch { /* not usable */ } }
        if (!url) throw new NcRefusal('bad_input', 'Enter the address people use for Nextcloud: HyperProx tests the app password there.')
      }
      if (!create && (url || user || pasted) && !(url && user && pasted)) throw new NcRefusal('bad_input', 'The optional web login needs all three: the address, the admin user and an app password.')

      let appPassword = pasted
      let tokenId: number | null = null
      let made: { uid: string; id: number | null } | null = null
      const revoke = async (why: string) => {
        if (!made) return
        if (made.id) {
          await this.d.audit('nextcloud.app_password.revoke', `guest:${machineKey(guest)}`, { by: actor.email, user: made.uid, token: made.id, why }).catch(() => {})
          await this.run(guest, occScript(dep.occ, 'delete-app-password', { uid: made.uid, id: made.id }), 60_000).catch(() => {})
        }
      }
      try {
        if (create) {
          const b = batch(dep.occ, [{ key: 't', id: 'auth-tokens', params: { uid: user } }])
          const t0 = b.parse((await this.run(guest, b.script)).output).t
          const known = t0 ? parseAuthTokens(t0.output).map(k => k.id) : []
          await this.d.audit('nextcloud.app_password.create', `guest:${machineKey(guest)}`, { by: actor.email, user })
          const r = await this.run(guest, occScript(dep.occ, 'add-app-password', { uid: user }), 60_000)
          appPassword = APP_PASSWORD_OUT.exec(r.output)?.[1] ?? null
          if (r.code !== 0 || !appPassword) throw new NcRefusal('app_password_failed', 'Nextcloud did not make the app password (is that user an admin?).', 502)
          made = { uid: user!, id: null }
          made.id = tokenId = await this.tokenIdFor(guest, dep.occ, user!, this.now(), known.length ? known : [-1])
          if (!made.id) {
            // Without its id HyperProx could neither revoke it nor tell its activity from a person's: undo by name is not safe.
            throw new NcRefusal('app_password_failed', 'Nextcloud made the app password, but HyperProx could not tell which token it is. Delete the "HyperProx" app password under that user\'s Security settings and try again.', 502)
          }
        }
        if (url && user && appPassword) {
          const since = this.now()
          await this.testLogin(url, user, appPassword)
          if (!create) tokenId = await this.tokenIdFor(guest, dep.occ, user, since).catch(() => null)
        }
        await this.d.audit('nextcloud.instance.create', `guest:${machineKey(guest)}`, { by: actor.email, name, guest: machineKey(guest), deployment: dep.kind, ocs: !!appPassword })
        return await this.d.store.create({ name, guest, deployment: dep, url, user, appPassword, tokenId, made: create })
      } catch (e: any) {
        await revoke(String(e?.message ?? 'the add failed').slice(0, 200))
        throw e
      }
    })
  }

  /**
   * Change the name or the web login. The guard (a stored app password goes only to the origin and user it was
   * entered for) runs before anything is sent; a test read is made only with a password given in this same request.
   */
  async update(id: string, body: Record<string, unknown>, actor: Actor): Promise<NcMeta> {
    this.mustPerson(actor)
    const prev = await this.meta(id)
    const login = await this.d.store.login(id)
    if (body.name !== undefined) cleanName(body.name)
    const url = body.url === undefined ? login.url : body.url === '' ? null : cleanUrl(body.url)
    const user = body.user === undefined || body.user === '' ? login.user : cleanUser(body.user)
    const newPw = body.appPassword === undefined || body.appPassword === '' ? null : cleanAppPassword(body.appPassword)
    const problem = loginChangeProblem(login, { url, user, appPassword: newPw })
    if (problem) throw new NcRefusal('bad_input', problem)
    const work = async () => {
      let tokenId: number | null | undefined
      if (newPw && url && user) {
        const since = this.now()
        await this.testLogin(url, user, newPw)
        tokenId = prev.deployment ? await this.tokenIdFor(prev.guest, prev.deployment.occ, user, since).catch(() => null) : null
      }
      const dep = body.redetect === true ? await this.detectIn(prev.guest) : undefined
      // The app password HyperProx made is replaced (or the login removed): revoke it in Nextcloud first.
      if (login.made && (newPw || body.url === '')) await this.revokeMade(prev, login, actor.email)
      await this.d.audit('nextcloud.instance.update', `nextcloud:${id}`, { by: actor.email, changed: Object.keys(body).filter(k => ['name', 'url', 'user', 'appPassword', 'redetect'].includes(k)).map(k => (k === 'appPassword' ? 'credential' : k)) })
      // The web login cleared by a person: auto-connect must not make it again by itself.
      if (body.url === '' && login.appPassword && prev.autoConnected) await this.d.dismissed?.(`${machineKey(prev.guest)}#web-login`, `${prev.name}: web login`, actor.email)
      const meta = await this.d.store.update(id, { ...body, ...(tokenId !== undefined ? { tokenId } : {}) })
      if (dep) await this.d.store.setDeployment(id, dep)
      this.cache.delete(id)
      return (await this.d.store.get(id)) ?? meta
    }
    return body.redetect === true ? this.locked(id, work) : work()
  }

  /**
   * Remove. An app password HyperProx made is revoked in Nextcloud first; when the guest cannot be reached that is
   * refused, unless `force` says to remove anyway (the answer says what is left). Remembered as dismissed, so
   * auto-connect never adds the guest back by itself.
   */
  async remove(id: string, actor: Actor, force = false): Promise<{ appPasswordLeft: boolean }> {
    this.mustPerson(actor)
    const m = await this.meta(id)
    if (this.busy.has(id)) throw new NcRefusal('busy', 'A Nextcloud action is still running here; remove it when that has finished.', 409)
    const login = await this.d.store.login(id)
    await this.d.audit('nextcloud.instance.remove', `nextcloud:${id}`, { by: actor.email, force })
    let left = false
    if (login.made) {
      try { await this.revokeMade(m, login, actor.email) } catch (e: any) {
        if (!force) throw new NcRefusal('revoke_failed', `HyperProx could not revoke the app password it made for ${login.user} (${String(e?.message ?? e).slice(0, 160)}). Try again when the guest answers, or remove anyway and delete the "HyperProx" app password under that user's Security settings.`, 409)
        left = true
        await this.orphanAlert(m, login.user ?? '?', login.tokenId, String(e?.message ?? e), actor.email)
      }
    }
    await this.d.dismissed?.(machineKey(m.guest), m.name, actor.email)
    await this.d.store.remove(id)
    this.cache.delete(id)
    return { appPasswordLeft: left }
  }

  /** Revoke the app password HyperProx made (by its token id, never by name). Throws when it could not. */
  private async revokeMade(m: NcMeta, login: { user: string | null; tokenId: number | null; made: boolean }, by: string): Promise<void> {
    if (!login.made) return
    if (!login.user || !login.tokenId) throw new Error('its token id is not known')
    const dep = m.deployment ?? await this.detectIn(m.guest, m.name)
    await this.d.audit('nextcloud.app_password.revoke', `nextcloud:${m.id}`, { by, user: login.user, credentialId: login.tokenId, why: 'removed or replaced' })
    const r = await this.run(m.guest, occScript(dep.occ, 'delete-app-password', { uid: login.user, id: login.tokenId }), 60_000)
    // Already gone (deleted by hand) counts as revoked.
    if (r.code !== 0 && !/not found|does not exist|no such/i.test(r.output)) throw new Error(`occ exited ${r.code}`)
  }

  // ── auto-connect (lib/auto-connect) ───────────────────────────────────────

  /** Guests whose detection found no Nextcloud, or two candidates: not detected again for an hour (the pick stays). */
  private autoMiss = new Map<string, { at: number; outcome: Outcome }>()

  /**
   * Why auto-connect leaves this guest alone, or null: the ignore tag, Remote access's exclusion list, or an excluded
   * subnet, judged on every address HyperProx saw it at (the scan's, the Catalogue's) and the guest's own IP. Checked
   * before anything is run in the guest, for a new guest and for one added already alike.
   */
  private autoExcluded(ctx: AdapterContext, key: string, row: GuestRow | undefined, s: { urls: string[]; ips: string[] }): string | null {
    return exclusionOf(ctx, { machineId: key, tags: row?.ignored && (!row.excludedBy || row.excludedBy === EXCLUSION_WORDS.tag) ? [IGNORE_TAG] : [], addresses: [...s.urls, ...s.ips] })
      ?? (row?.ignored ? row.excludedBy ?? EXCLUSION_WORDS.tag : null)
  }

  /** When the background pass may try the web login again: never before the persisted time (it survives a restart). */
  private webLoginDue(m: NcMeta): boolean {
    const a = m.autoConnected
    if (a?.webLoginStopped) return false
    if (!a?.webLoginTriedAt) return true
    const f = a.webLoginFailures ?? 0
    // Nothing to use (no vault login, several admins): every 6 hours. A login that failed its test: 1 h, 2 h, 4 h... at most once a day.
    const wait = f > 0 ? Math.min(60 * 60_000 * 2 ** (f - 1), WEB_LOGIN_MAX_MS) : WEB_LOGIN_RETRY_MS
    return this.now() - Date.parse(a.webLoginTriedAt) >= wait
  }

  private async noteWebLoginTry(m: NcMeta, failed: boolean): Promise<void> {
    const cur = (await this.d.store.get(m.id))?.autoConnected
    if (!cur) return
    await this.d.store.setAutoConnected(m.id, { ...cur, webLoginTriedAt: new Date(this.now()).toISOString(), webLoginFailures: failed ? (cur.webLoginFailures ?? 0) + 1 : 0 })
  }

  /**
   * One auto-connect pass. Every guest where Nextcloud was seen and that is not added yet is detected (read-only, the
   * same script "Detect" runs) and added with occ through the node login: no password, health and setup checks work
   * at once. Never a guest that is excluded, stopped, or that a person removed. Two candidate containers are not
   * guessed between: that is left as one choice to pick. Then the optional web login (autoWebLogin).
   */
  async autoConnect(ctx: AdapterContext): Promise<Outcome[]> {
    const out: Outcome[] = []
    if (!this.d.sightings) return out
    const [sightings, rows, list] = await Promise.all([this.d.sightings(), this.d.guests(), this.d.store.list()])
    const byGuest = new Map<string, { guest: GuestRef; urls: string[]; ips: string[]; via: string[]; admins: string[] }>()
    for (const s of sightings) {
      const k = machineKey(s.guest)
      const e = byGuest.get(k) ?? { guest: s.guest, urls: [], ips: [], via: [], admins: [] }
      if (s.admin && !e.admins.includes(s.admin)) e.admins.push(s.admin)
      if (s.url && !e.urls.includes(s.url)) e.urls.push(s.url)
      if (s.ip && !e.ips.includes(s.ip)) e.ips.push(s.ip)
      if (!e.via.includes(s.via)) e.via.push(s.via)
      byGuest.set(k, e)
    }
    for (const [key, s] of byGuest) {
      const row = rows.find(r => r.kind === s.guest.kind && r.vmid === s.guest.vmid)
      const label = row?.name ?? key
      const have = list.find(m => m.guest.kind === s.guest.kind && m.guest.vmid === s.guest.vmid)
      // Excluded: nothing is run in the guest at all, added already or not.
      const why = this.autoExcluded(ctx, key, row, s)
      if (why) { out.push({ key, label, did: 'excluded', message: why }); continue }
      if (have) {
        out.push({ key, label, did: 'present' })
        // Connected earlier with occ only: the web login is tried again (a vault item may have been added since),
        // on a back-off that survives a restart, and never after a person cleared it.
        if (have.autoConnected && row?.running && this.webLoginDue(have) && !ctx.dismissed(`${key}#web-login`) && !(await this.d.store.login(have.id)).appPassword) {
          const w = await this.autoWebLogin(have, s.urls, ctx, undefined, s.admins).catch((e: any) => ({ key: `${key}#web-login`, label, did: 'failed' as const, message: String(e?.message ?? e).slice(0, 200) }))
          if (w) out.push(w)
        }
        continue
      }
      if (!row) { out.push({ key, label, did: 'skipped', message: 'not on the cluster' }); continue }
      if (ctx.dismissed(key)) { out.push({ key, label, did: 'dismissed' }); continue }
      if (!row.running) { out.push({ key, label, did: 'skipped', message: 'not running' }); continue }
      const miss = this.autoMiss.get(key)
      if (miss && this.now() - miss.at < 60 * 60_000) { out.push(miss.outcome); continue }
      try {
        const o = await this.autoAdd(s.guest, row.name, s.via, s.urls, ctx, undefined, s.admins)
        out.push(...o)
      } catch (e: any) {
        let o: Outcome
        if (e instanceof NcRefusal && e.code === 'ambiguous') {
          const names = ((e.extra?.containers as string[]) ?? []).slice(0, 20)
          o = { key, label, did: 'ambiguous', choiceKind: 'container', message: `${row.name} has ${names.length} containers that could be Nextcloud. Pick the one HyperProx looks after.`, choices: names.map(n => ({ id: n, label: n })) }
          this.autoMiss.set(key, { at: this.now(), outcome: o })
        } else if (e instanceof NcRefusal && e.code === 'not_found') {
          o = { key, label, did: 'skipped', message: 'no Nextcloud in it' }
          this.autoMiss.set(key, { at: this.now(), outcome: o })
        } else o = { key, label, did: 'failed', message: String(e?.message ?? e).slice(0, 300) }
        out.push(o)
      }
    }
    return out
  }

  private async autoAdd(guest: GuestRef, name: string, via: string[], urls: string[], ctx: AdapterContext, prefer?: string, admins: string[] = []): Promise<Outcome[]> {
    const key = machineKey(guest)
    return this.locked(`guest:${key}`, async () => {
      const dep = await this.detectIn(guest, name, prefer)
      if ((await this.d.store.list()).some(m => m.guest.kind === guest.kind && m.guest.vmid === guest.vmid)) return [{ key, label: name, did: 'present' as const }]
      // A person may have removed it while the detection ran: the dismissal is read again right before adding.
      if (ctx.dismissed(key)) return [{ key, label: name, did: 'dismissed' as const }]
      const evidence = [...via.map(v => `found by ${v}`), `occ in ${dep.kind === 'bare' ? 'a plain install' : `container ${dep.occ.mode === 'docker' ? dep.occ.container : ''}`}`]
      await ctx.audit('nextcloud.instance.auto_connect', `guest:${key}`, { guest: key, deployment: dep.kind, evidence })
      const meta = await this.d.store.create({ name: cleanName(name.slice(0, 40)), guest, deployment: dep, url: null, user: null, appPassword: null,
        autoConnected: { at: new Date(this.now()).toISOString(), evidence, webLogin: null } })
      const out: Outcome[] = [{ key, label: name, did: 'connected', evidence }]
      const w = await this.autoWebLogin(meta, urls, ctx, undefined, admins).catch((e: any) => ({ key: `${key}#web-login`, label: name, did: 'failed' as const, message: String(e?.message ?? e).slice(0, 200) }))
      if (w) out.push(w)
      return out
    })
  }

  /**
   * The addresses a vault login may be matched against and the web login may be sent to: only ones HyperProx saw
   * itself (the service scan's, a Catalogue install's), never one the guest reports about itself (overwrite.cli.url
   * is the guest's to set, so it is a display hint at most), and never one in an excluded subnet. Names before IPs:
   * Nextcloud's trusted domains usually list its name.
   */
  private observedUrls(seen: string[], ctx: AdapterContext): string[] {
    const out: string[] = []
    for (const u of seen) {
      try { const c = cleanUrl(u); if (!out.includes(c) && !inCidrs(c, ctx.excludedSubnets)) out.push(c) } catch { /* not usable */ }
    }
    return out.sort((a, b) => Number(parseIPv4(a) !== null) - Number(parseIPv4(b) !== null))
  }

  /**
   * The optional web login, made without a person when it can be done safely:
   *   - a vault item whose login URI is one of the addresses HyperProx saw Nextcloud at (exactly one; several are a
   *     pick): an app password in it is used as it is, against that same address only; an ordinary password is never
   *     sent anywhere, its user name says which admin HyperProx makes its own app password for;
   *   - no vault item: the admin the Catalogue made, else the admin group's only member gets HyperProx's own app
   *     password, tested against an observed address.
   * HyperProx's own app password is kept in the vault and revoked when the instance is removed. Anything else is
   * left: occ already gives the health and setup checks.
   */
  private async autoWebLogin(m: NcMeta, seen: string[], ctx: AdapterContext, pickedItem?: string, admins: string[] = []): Promise<Outcome | null> {
    const key = `${machineKey(m.guest)}#web-login`
    if (!m.deployment || (await this.d.store.login(m.id)).appPassword) return null
    const urls = this.observedUrls(seen, ctx)
    let failed = false
    try {
      const o = await this.webLoginFrom(m, urls, ctx, key, pickedItem, admins)
      failed = o.did === 'failed'
      return o
    } catch (e) { failed = true; throw e }
    finally { if (!pickedItem) await this.noteWebLoginTry(m, failed).catch(() => {}) }
  }

  private async webLoginFrom(m: NcMeta, urls: string[], ctx: AdapterContext, key: string, pickedItem: string | undefined, admins: string[]): Promise<Outcome> {
    if (!urls.length) return { key, label: m.name, did: 'needs_credential', message: 'HyperProx has not seen Nextcloud at an address it may send a login to.' }
    const items = ctx.vaultItems()
    let hit: { url: string; item: VaultChoice; user: string | null; secret: string } | null = null
    if (pickedItem) {
      for (const u of urls) { const p = pickVault(items, pickedItem, u, 'login'); if (p) { hit = { url: u, item: p.item, user: p.value.username, secret: p.value.secret }; break } }
      if (!hit) return { key, label: m.name, did: 'failed', message: 'That vault item is not for an address HyperProx saw this Nextcloud at.' }
    } else {
      const found = new Map<string, { url: string; item: VaultChoice; user: string | null; secret: string }>()
      for (const u of urls) {
        const r = matchVault(items, u, 'login')
        if (r.kind === 'one' && !found.has(r.item.id)) found.set(r.item.id, { url: u, item: r.item, user: r.value.username, secret: r.value.secret })
        if (r.kind === 'several') for (const it of r.items) if (!found.has(it.id)) found.set(it.id, { url: u, item: it, user: null, secret: '' })
      }
      if (found.size > 1) {
        return { key, label: m.name, did: 'ambiguous', choiceKind: 'vault-item', message: `${found.size} vault items are logins for ${m.name}'s address. Pick the one HyperProx uses for the web login.`,
          choices: [...found.values()].map(f => ({ id: f.item.id, label: f.item.name })) }
      }
      hit = [...found.values()][0] ?? null
    }
    const isAppPassword = (v: string) => { try { cleanAppPassword(v); return true } catch { return false } }
    let url: string, user: string, appPassword: string, tokenId: number | null = null, made = false, how: string
    if (hit && isAppPassword(hit.secret) && hit.user) {
      url = hit.url; user = cleanUser(hit.user); appPassword = hit.secret
      await ctx.audit('nextcloud.web_login.auto', `nextcloud:${m.id}`, { from: 'vault', vaultItemId: hit.item.id, vaultItemName: hit.item.name, address: url, user })
      const since = this.now()
      try { await this.testLogin(url, user, appPassword) } catch (e: any) { return { key, label: m.name, did: 'failed', message: String(e?.message ?? e).slice(0, 200) } }
      tokenId = await this.tokenIdFor(m.guest, m.deployment!.occ, user, since).catch(() => null)
      how = `the app password in the vault item "${hit.item.name}"`
    } else {
      // Which admin: the vault item's user, else the one admin the Catalogue made, else the admin group's only member.
      let admin: string | null = hit?.user ?? (admins.length === 1 ? admins[0] : null)
      if (!admin) {
        const b = batch(m.deployment!.occ, [{ key: 'groups', id: 'group-list' }])
        const g = b.parse((await this.run(m.guest, b.script)).output).groups
        const list = g ? parseGroupMembers(g.output, 'admin') ?? [] : []
        if (list.length !== 1) return { key, label: m.name, did: 'needs_credential', message: list.length ? `The admin group has ${list.length} members, so HyperProx does not pick whose app password to make. Add the web login in Settings if you want the extra details.` : 'No admin user was found.' }
        admin = list[0]
      }
      try { user = cleanUser(admin) } catch { return { key, label: m.name, did: 'needs_credential', message: 'The admin user\'s name is not one HyperProx passes to occ.' } }
      const made1 = await this.makeAppPassword(m, user, ctx, hit?.item ?? null)
      appPassword = made1.appPassword; tokenId = made1.tokenId; made = true
      // Tested against the vault item's address, or each address HyperProx saw, until one answers.
      const targets = hit ? [hit.url] : urls
      let ok: string | null = null, last: any = null
      for (const t of targets) { try { await this.testLogin(t, user, appPassword); ok = t; break } catch (e) { last = e } }
      if (!ok) {
        await this.revokeOrRecord(m, user, tokenId)
        return { key, label: m.name, did: 'failed', message: String(last?.message ?? 'the web login did not work').slice(0, 200) }
      }
      url = ok
      how = hit ? `an app password HyperProx made for ${user} (the user of the vault item "${hit.item.name}")` : admins.length === 1 ? `an app password HyperProx made for ${user}, the admin the Catalogue made` : `an app password HyperProx made for ${user}, the only admin`
    }
    try { await this.d.store.setLogin(m.id, { url, user, appPassword, tokenId, made }) } catch (e) {
      if (made) await this.revokeOrRecord(m, user, tokenId)
      throw e
    }
    const cur = await this.d.store.get(m.id)
    await this.d.store.setAutoConnected(m.id, { ...(cur?.autoConnected ?? { at: new Date(this.now()).toISOString(), evidence: [] }), webLogin: how })
    this.cache.delete(m.id)
    return { key, label: m.name, did: 'connected', evidence: [`web login: ${how}`], vaultItem: hit?.item ?? null }
  }

  /** HyperProx's own app password for `user` (occ), with its token id. */
  private async makeAppPassword(m: NcMeta, user: string, ctx: AdapterContext, fromItem: VaultChoice | null): Promise<{ appPassword: string; tokenId: number }> {
    const dep = m.deployment!
    const b = batch(dep.occ, [{ key: 't', id: 'auth-tokens', params: { uid: user } }])
    const t0 = b.parse((await this.run(m.guest, b.script)).output).t
    const known = t0 ? parseAuthTokens(t0.output).map(k => k.id) : []
    await ctx.audit('nextcloud.app_password.create', `nextcloud:${m.id}`, { user, auto: true, ...(fromItem ? { vaultItemId: fromItem.id, vaultItemName: fromItem.name } : {}) })
    const r = await this.run(m.guest, occScript(dep.occ, 'add-app-password', { uid: user }), 60_000)
    const appPassword = APP_PASSWORD_OUT.exec(r.output)?.[1] ?? null
    if (r.code !== 0 || !appPassword) throw new NcRefusal('app_password_failed', 'Nextcloud did not make the app password (is that user an admin?).', 502)
    const tokenId = await this.tokenIdFor(m.guest, dep.occ, user, this.now(), known.length ? known : [-1])
    if (!tokenId) {
      // Which token it is cannot be told. Take back every new token named HyperProx for this user (all made by
      // HyperProx since the list above); if that cannot be done, stop trying for good and tell a person.
      const b2 = batch(dep.occ, [{ key: 't', id: 'auth-tokens', params: { uid: user } }])
      const t1 = b2.parse((await this.run(m.guest, b2.script)).output).t
      const fresh = (t1 ? parseAuthTokens(t1.output) : []).filter(k => k.id > 0 && !known.includes(k.id) && k.name === 'HyperProx')
      let undone = fresh.length > 0
      for (const k of fresh) { try { await this.revokeMade(m, { user, tokenId: k.id, made: true }, SYSTEM_ACTOR) } catch { undone = false } }
      const why = undone ? 'Nextcloud made an app password HyperProx could not identify; it was revoked by name.' : 'Nextcloud made an app password HyperProx could not identify or revoke.'
      await this.stopWebLogin(m, why)
      if (!undone) await this.orphanAlert(m, user, null, why, SYSTEM_ACTOR)
      throw new NcRefusal('app_password_failed', `${why} HyperProx stops making web logins for ${m.name} until you add one in Settings.`, 502)
    }
    return { appPassword, tokenId }
  }

  /** Revoke an app password HyperProx just made; when that fails, record it as left over and tell a person. */
  private async revokeOrRecord(m: NcMeta, user: string, tokenId: number | null): Promise<void> {
    try { await this.revokeMade(m, { user, tokenId, made: true }, SYSTEM_ACTOR) }
    catch (e: any) { await this.orphanAlert(m, user, tokenId, String(e?.message ?? e), SYSTEM_ACTOR) }
  }

  /** Remember an app password that is left in Nextcloud, audit it, and tell the admins. Never throws. */
  private async orphanAlert(m: NcMeta, user: string, id: number | null, why: string, by: string): Promise<void> {
    try {
      const cur = (await this.d.store.get(m.id))?.autoConnected
      if (cur) await this.d.store.setAutoConnected(m.id, { ...cur, orphans: [...(cur.orphans ?? []), { user, id, at: new Date(this.now()).toISOString() }].slice(-20) })
    } catch { /* the instance may be gone (a forced remove): the audit row and the alert still say it */ }
    await this.d.audit('nextcloud.app_password.left', `nextcloud:${m.id}`, { by, user, credentialId: id, why: why.slice(0, 200) }).catch(() => {})
    await this.d.alert?.(`An app password HyperProx made in ${m.name} is still there`, [
      `HyperProx could not revoke the app password named HyperProx for ${user}${id ? ` (token ${id})` : ''}: ${why.slice(0, 160)}`,
      `Delete it under that user's Security settings in Nextcloud.`,
    ]).catch(() => {})
  }

  private async stopWebLogin(m: NcMeta, why: string): Promise<void> {
    const cur = (await this.d.store.get(m.id))?.autoConnected
    if (cur) await this.d.store.setAutoConnected(m.id, { ...cur, webLoginStopped: why.slice(0, 300) })
  }

  /** A person picked a container (two candidates in one guest) or a vault item (two logins for one address). */
  async autoPick(key: string, choiceId: string, ctx: AdapterContext): Promise<Outcome> {
    const web = /^(lxc|qemu)-(\d{1,9})#web-login$/.exec(key)
    const g = /^(lxc|qemu)-(\d{1,9})$/.exec(web ? `${web[1]}-${web[2]}` : key)
    if (!g) throw new NcRefusal('bad_input', 'Not a Nextcloud choice.')
    const guest: GuestRef = { kind: g[1] as 'lxc' | 'qemu', vmid: Number(g[2]) }
    const sightings = this.d.sightings ? (await this.d.sightings()).filter(s => s.guest.kind === guest.kind && s.guest.vmid === guest.vmid) : []
    const urls = sightings.map(s => s.url).filter((u): u is string => !!u)
    const ips = sightings.map(s => s.ip).filter((u): u is string => !!u)
    const row = (await this.d.guests()).find(r => r.kind === guest.kind && r.vmid === guest.vmid)
    if (!row || !row.running || this.autoExcluded(ctx, machineKey(guest), row, { urls, ips })) throw new NcRefusal('no_guest', 'That guest is not there, not running, or excluded.', 409)
    if (web) {
      const m = (await this.d.store.list()).find(x => x.guest.kind === guest.kind && x.guest.vmid === guest.vmid)
      if (!m) throw new NcRefusal('no_instance', 'That Nextcloud is not added any more.', 404)
      return (await this.autoWebLogin(m, urls, ctx, choiceId)) ?? { key, label: m.name, did: 'present' }
    }
    if (!CONTAINER_RE.test(choiceId)) throw new NcRefusal('bad_input', 'Pick one of the listed containers.')
    const out = await this.autoAdd(guest, row.name, ['a person\'s pick'], urls, ctx, choiceId)
    this.autoMiss.delete(machineKey(guest))
    return out[0]
  }

  async snooze(id: string, check: unknown, days: unknown, actor: Actor): Promise<NcMeta> {
    this.mustAdmin(actor)
    if (typeof check !== 'string' || !/^[A-Za-z0-9_\\:-]{1,160}$/.test(check)) throw new NcRefusal('bad_input', 'Which check?')
    const until = days === 0 ? null : days === null || days === 'forever' ? 'forever' : [1, 7, 30, 90].includes(Number(days)) ? new Date(this.now() + Number(days) * 86_400_000).toISOString() : undefined
    if (until === undefined) throw new NcRefusal('bad_input', 'Snooze for 1, 7, 30 or 90 days, or dismiss it.')
    await this.d.audit('nextcloud.check.snooze', `nextcloud:${id}`, { by: actor.email, check, until })
    const m = await this.d.store.snooze(id, check, until)
    this.cache.delete(id)
    return m
  }

  // ── reading ────────────────────────────────────────────────────────────────

  private extraReads(dep: Deployment | null): Array<[string, string]> {
    if (!dep || dep.occ.mode !== 'docker' || !CONTAINER_RE.test(dep.occ.container)) return []
    const out: Array<[string, string]> = [['php', `docker exec -u www-data '${dep.occ.container}' php -r 'echo PHP_VERSION;'`]]
    if (dep.db && CONTAINER_RE.test(dep.db.container)) out.push(['dbv', `docker exec '${dep.db.container}' sh -c 'postgres --version 2>/dev/null || mariadbd --version 2>/dev/null || mysqld --version'`])
    return out
  }

  async reading(id: string, o: { fresh?: boolean } = {}): Promise<Reading> {
    const hit = this.cache.get(id)
    // A fresh read is honoured at most every FRESH_MS: a page (or a person) asking again and again cannot keep the guest busy.
    if (hit && this.now() - hit.at < (o.fresh ? FRESH_MS : CACHE_MS)) return hit.r
    const m = await this.meta(id)
    let dep = m.deployment
    const missing: string[] = []
    if (!dep) {
      const r = await this.run(m.guest, DETECT_SCRIPT, 90_000)
      try { dep = parseDetect(r.output) } catch { dep = null }
      if (!dep) throw new NcRefusal('not_found', 'Nextcloud was not found in its guest any more. Check the guest, then re-detect in Settings.', 502)
      await this.d.store.setDeployment(id, dep)
    }
    const login = await this.d.store.login(id)
    const items: Array<{ key: string; id: OccId; params?: unknown }> = [
      { key: 'status', id: 'status' }, { key: 'checks', id: 'setupchecks' }, { key: 'update', id: 'update-check' },
      { key: 'apps', id: 'app-list' }, { key: 'report', id: 'user-report' }, { key: 'log', id: 'log-tail' },
      { key: 'calls', id: 'active-calls' }, { key: 'exapps', id: 'appapi-list' }, { key: 'bgmode', id: 'bg-mode' }, { key: 'lastcron', id: 'bg-lastcron' },
      { key: 'push', id: 'push-endpoint' },
      { key: 'config', id: 'config-list' },
      ...(login.user ? [{ key: 'adminlocale', id: 'user-locale' as const, params: { uid: login.user } }] : []),
    ]
    const ocs = login.url && login.user && login.appPassword ? this.d.ocs({ url: login.url, user: login.user, appPassword: login.appPassword }) : null
    const b = batch(dep.occ, items, this.extraReads(dep))
    const [res, info, web, quiet] = await Promise.all([
      this.run(m.guest, b.script, READ_TIMEOUT),
      ocs ? ocs('/ocs/v2.php/apps/serverinfo/api/v1/info?format=json').then(parseServerInfo, (e: any) => { missing.push(`server info (${e?.message ?? 'no answer'})`); return null }) : Promise.resolve(null),
      ocs ? ocs('/index.php/settings/setupcheck').then(parseSetupChecks, () => null) : Promise.resolve(null),
      this.d.quietHours().catch(() => null),
    ])
    const p = b.parse(res.output)
    const sys = p.config?.code === 0 ? parseSystemConfig(p.config.output, READ_KEYS) : {}
    const cfg = (k: ReadKey): string | null => sys[k] ?? null
    const status = p.status ? parseStatus(p.status.output) : null
    if (!status) missing.push('occ status')
    // occ setupchecks exits non-zero whenever a check warns, so its answer is read whatever the exit code.
    const occChecks = p.checks ? parseSetupChecks(p.checks.output) : []
    if (!occChecks.length && !web?.length) missing.push('setup checks')
    const fromWeb = !!web?.length
    const checksRaw: SetupCheck[] = fromWeb ? web! : occChecks
    const apps = p.apps ? parseAppList(p.apps.output) : { enabled: {}, disabled: [] }
    const exApps = p.exapps && p.exapps.code === 0 ? parseExApps(p.exapps.output) : null
    const up = p.update ? parseUpdateCheck(p.update.output) : { core: null, apps: [] }

    const tz = cfg('default_timezone')
    const win = suggestWindow(quiet?.busy ?? null, quiet?.tz ?? null, this.now())
    const reg = suggestRegion({ locale: cfg('default_locale'), language: cfg('default_language'), adminLocale: configValue(p.adminlocale), timezone: tz ?? quiet?.tz ?? null }, r => REGIONS.includes(r))
    const suggest = { windowHour: win.hour, windowWhy: win.why, region: reg.region, regionWhy: reg.why, serverId: suggestServerId(m.id) }
    const ctx = { deployment: dep, exApps, suggest, fromCli: !fromWeb }

    const snoozedFor = (cid: string) => {
      const t = m.snoozed[cid]
      if (!t) return null
      if (t === 'forever') return t
      return Date.parse(t) > this.now() ? t : null
    }
    const checks: CheckView[] = checksRaw.filter(c => c.severity !== 'success').map(c => ({ ...c, remedy: remedyFor(c, ctx), snoozed: snoozedFor(c.id) }))
    // Problems HyperProx sees itself, shown and acted on the same way.
    if (up.core && status) {
      const compose = dep.kind === 'compose'
      checks.unshift({ id: 'hyperprox:update', category: 'update', name: 'Nextcloud update available', severity: 'warning', doc: null, snoozed: snoozedFor('hyperprox:update'),
        description: `Nextcloud ${up.core} is available; this server runs ${status.versionString}.${cfg('upgrade.disable-web') === 'true' ? ' The web updater is turned off here, so the update is a new image.' : ''}`,
        remedy: compose
          ? { kind: 'fix', action: 'update', label: `Update to ${up.core}`, secure: true, long: true, confirm: 'Opens the update check first: who is online, the backup location, every step.' }
          : { kind: 'guided', flow: 'update-manual', label: 'How to update it', why: dep.kind === 'bare' ? 'A plain install updates with its command-line updater; the steps are below.' : 'This container is not managed by Docker Compose, so HyperProx cannot recreate it safely; the steps are below.' } })
    }
    if (up.apps.length) {
      checks.push({ id: 'hyperprox:app-updates', category: 'update', name: `${up.apps.length} app update${up.apps.length === 1 ? '' : 's'} available`, severity: 'info', doc: null, snoozed: snoozedFor('hyperprox:app-updates'),
        description: up.apps.map(a => `${a.app} ${a.version}`).join(', '),
        remedy: { kind: 'fix', action: 'update-apps', label: 'Update the apps', secure: true, long: true, confirm: `Runs occ app:update --all: ${up.apps.map(a => `${a.app} to ${a.version}`).join(', ')}. Each app is updated in turn; Nextcloud stays up.` } })
    }
    const bgMode = (configValue(p.bgmode) ?? 'ajax').toLowerCase()
    if (bgMode !== 'cron') {
      checks.push({ id: 'hyperprox:cron', category: 'system', name: 'Background jobs run on page loads', severity: 'info', doc: 'https://docs.nextcloud.com/server/latest/admin_manual/configuration_server/background_jobs_configuration.html', snoozed: snoozedFor('hyperprox:cron'),
        description: `Background jobs are in ${bgMode.toUpperCase()} mode: they only run while someone has Nextcloud open. Cron runs them every five minutes whether anyone is there or not.`,
        remedy: { kind: 'guided', flow: 'cron', label: 'Switch to cron', why: 'Add a runner that calls cron.php every five minutes, then switch the mode to Cron in Basic settings.' } })
    }
    const counts = { error: 0, warning: 0, info: 0 }
    for (const c of checks) if (!c.snoozed && countable(c.severity, c.remedy) && c.severity !== 'success') counts[c.severity]++

    const hpbCheck = checksRaw.find(c => c.id === 'OCA\\Talk\\SetupCheck\\HighPerformanceBackend')
    const twoFactorCheck = checksRaw.find(c => c.id === 'OCA\\Settings\\SetupChecks\\TwoFactorConfiguration')
    const log = p.log ? parseLog(p.log.output).filter(e => e.level >= 2).reverse() : null
    const r: Reading = {
      fetchedAt: new Date(this.now()).toISOString(),
      status,
      update: { ...up, webUpdaterDisabled: cfg('upgrade.disable-web') === 'true' },
      checksFrom: checksRaw.length ? (fromWeb ? 'web' : 'occ') : null,
      checks, counts,
      background: { mode: bgMode, lastRun: Number(configValue(p.lastcron)) || null },
      config: {
        maintenanceWindowStart: cfg('maintenance_window_start') !== null ? Number(cfg('maintenance_window_start')) : null,
        phoneRegion: cfg('default_phone_region'), serverId: cfg('serverid') !== null ? Number(cfg('serverid')) : null,
        timezone: tz, locale: cfg('default_locale'), language: cfg('default_language'),
        mail: { mode: cfg('mail_smtpmode'), host: cfg('mail_smtphost'), port: cfg('mail_smtpport'), secure: cfg('mail_smtpsecure'), from: cfg('mail_from_address'), domain: cfg('mail_domain') },
      },
      users: (() => { const u = p.report ? parseUserReport(p.report.output) : { total: null, disabled: null }; return { total: u.total, disabled: u.disabled } })(),
      twoFactor: {
        enforced: twoFactorCheck ? (twoFactorCheck.severity === 'success' ? (/enforced/i.test(twoFactorCheck.description) ? true : null) : false) : null,
        checked: 0, without: null,
        providers: SETUP_PROVIDERS.filter(a => apps.enabled[a]),
      },
      log,
      server: info, serverError: null,
      talk: {
        installed: !!apps.enabled.spreed,
        hpb: dep.signaling || hpbCheck ? {
          version: dep.signaling?.version ?? (/Running version:\s*(\S{1,60});/.exec(hpbCheck?.description ?? '')?.[1] ?? null),
          image: dep.signaling?.image ?? null, container: dep.signaling?.container ?? null, missing: hpbMissing(hpbCheck?.description ?? ''),
        } : null,
        activeCalls: p.calls && p.calls.code === 0 ? parseActiveCalls(p.calls.output) : null,
        push: { app: apps.enabled.notify_push ? 'enabled' : apps.disabled.includes('notify_push') ? 'disabled' : 'missing', daemon: dep.notifyPush ? (dep.notifyPush.running ? 'running' : 'stopped') : 'missing', endpoint: configValue(p.push) },
      },
      apps: { enabled: Object.keys(apps.enabled).length, exApps },
      deployment: dep,
      suggest,
      php: info?.php.version ?? (p.php?.code === 0 ? (/^\d+\.\d+\.\d+/.exec(p.php.output.trim())?.[0] ?? null) : null),
      dbVersion: info?.db.version ?? (p.dbv?.code === 0 ? (/(\d+\.\d+(?:\.\d+)?)/.exec(p.dbv.output)?.[1] ?? null) : null),
      missing,
    }
    if (res.code !== 0 && !status) throw new NcRefusal('unreachable', 'HyperProx could not run occ in the guest. Check that it is running and that its node has a login saved (Settings → Setup checklist).', 502)
    this.cache.set(id, { at: this.now(), r })
    return r
  }

  /**
   * Who has no second factor yet (admin; read-only, one occ call per user, up to 100 users), the enforcement as it
   * stands, the second factors a user can set up at sign-in, and the members of the admin group.
   */
  async twoFactorUsers(id: string, actor: Actor): Promise<TwoFactorView> {
    this.mustAdmin(actor)
    const m = await this.meta(id)
    return this.twoFactorOf(m, await this.dep(m))
  }

  private async twoFactorOf(m: NcMeta, dep: Deployment): Promise<TwoFactorView> {
    const b = batch(dep.occ, [{ key: 'users', id: 'user-list' }, { key: 'apps', id: 'app-list' }, { key: 'state', id: 'twofactor-enforce-state' }, { key: 'groups', id: 'group-list' }])
    const lr = b.parse((await this.run(m.guest, b.script)).output)
    const ul = lr.users ? parseUserList(lr.users.output) : { uids: [], excluded: [], ok: false }
    if (!ul.ok) throw new NcRefusal('unreadable', 'Nextcloud\'s user list could not be read.', 502)
    const list = ul.uids.slice(0, 100)
    const sb = batch(dep.occ, list.map((u, i) => ({ key: `u${i}`, id: 'twofactor-state' as const, params: { uid: u } })))
    const states = list.length ? sb.parse((await this.run(m.guest, sb.script, 5 * 60_000)).output) : {}
    const apps = lr.apps ? parseAppList(lr.apps.output) : { enabled: {}, disabled: [] }
    const users = list.map((uid, i) => ({ uid, state: states[`u${i}`] ? parseTwoFactorState(states[`u${i}`].output) : null }))
    const adminIds = (lr.groups ? parseGroupMembers(lr.groups.output, 'admin') : null) ?? []
    return {
      users, excluded: ul.excluded, truncated: ul.uids.length > list.length,
      providers: SETUP_PROVIDERS.filter(a => apps.enabled[a]),
      enforcement: lr.state ? parseEnforceState(lr.state.output) : null,
      admins: adminIds.map(uid => users.find(u => u.uid === uid) ?? { uid, state: null }),
    }
  }

  private async dep(m: NcMeta): Promise<Deployment> {
    if (m.deployment) return m.deployment
    const d = await this.detectIn(m.guest)
    await this.d.store.setDeployment(m.id, d)
    return d
  }

  // ── who may act ────────────────────────────────────────────────────────────

  private mustAdmin(actor: Actor) {
    if (!hasRole(actor.role, 'admin')) throw new NcRefusal('forbidden', 'This needs the admin role.', 403)
  }
  /** Admin, and a person: an API token never changes a Nextcloud. */
  private mustPerson(actor: Actor) {
    this.mustAdmin(actor)
    if (actor.token) throw new NcRefusal('token_forbidden', 'API tokens cannot change Nextcloud; a signed-in admin does.', 403)
  }

  private limit(id: string) {
    const t = this.now()
    const list = (this.actionTimes.get(id) ?? []).filter(x => t - x < 60_000)
    if (list.length >= 10) throw new NcRefusal('rate_limited', 'Too many actions in a minute; wait a moment.', 429)
    list.push(t); this.actionTimes.set(id, list)
  }

  // ── actions ────────────────────────────────────────────────────────────────

  /**
   * One action. `secureRoute` is true on the re-confirmed route: an action whose tier is secure is refused on the
   * plain one, so the tier is HyperProx's decision and never the caller's.
   */
  async act(id: string, action: unknown, body: Record<string, unknown>, actor: Actor, secureRoute: boolean): Promise<{ message: string; jobId?: string }> {
    this.mustPerson(actor)
    if (!isAction(action)) throw new NcRefusal('unknown_action', 'HyperProx has no such Nextcloud action.', 404)
    const spec = ACTIONS[action]
    if (spec.secure && !secureRoute) throw new NcRefusal('needs_reconfirm', `${spec.label} needs the master password re-entered.`, 403)
    if (this.busy.has(id)) throw new NcRefusal('busy', 'Another Nextcloud action is still running here; wait for it to finish.', 409)
    this.limit(id)
    // Held from here (through the preflight of an update, which takes a while) until the action or its job ends.
    this.busy.add(id)
    let handedToJob = false
    try {
      const m = await this.meta(id)
      const dep = await this.dep(m)
      const params = this.checkParams(action, body, dep)
      if (action === 'update' || action === 'hpb-update') {
        const r = action === 'update' ? await this.startUpdate(m, actor, body) : await this.startHpbUpdate(m, actor)
        handedToJob = true
        return r
      }
      // Checks that read the instance first (2FA), then the audit: no row, no action.
      if (action === 'enforce-2fa') params.values = { ...params.values, ...(await this.enforcePlan(m, dep, body, params.values.exclude as string[])) }
      await this.d.audit(`nextcloud.action.${action}`, `nextcloud:${id}`, { by: actor.email, via: 'session', params: params.audit })
      if (spec.long) { handedToJob = true; return await this.startJob(m, action, actor, params.audit, async (io) => this.runLong(m, dep, action, io)) }
      const msg = await this.runShort(m, dep, action, params, actor)
      this.cache.delete(id)
      return { message: msg }
    } finally { if (!handedToJob) this.busy.delete(id) }
  }

  /**
   * Enforcing 2FA, read first: the groups it is already enforced for and left out of are kept, only second factors a
   * user can set up at sign-in count, every user must have been read, and an admin with no second factor must be
   * acknowledged separately (they would be asked for one at their next sign-in, like everyone else).
   */
  private async enforcePlan(m: NcMeta, dep: Deployment, body: Record<string, unknown>, exclude: string[]): Promise<{ groups: string[]; exclude: string[] }> {
    const v = await this.twoFactorOf(m, dep)
    if (!v.providers.length) throw new NcRefusal('no_provider', 'No second factor a user can set up at sign-in (TOTP or WebAuthn) is enabled, so nobody could set one up. Enable one under Apps first.', 409)
    if (!v.enforcement) throw new NcRefusal('unreadable', 'The current two-factor enforcement could not be read, so it was not changed.', 502)
    const unknown = [...v.excluded, ...v.users.filter(u => u.state === null).map(u => u.uid)]
    if (unknown.length) throw new NcRefusal('unknown_users', `HyperProx could not check ${unknown.length} user${unknown.length === 1 ? '' : 's'} (${unknown.slice(0, 5).join(', ')}), so it does not enforce two-factor authentication from here.`, 409)
    if (v.truncated) throw new NcRefusal('unknown_users', 'There are more than 100 users; HyperProx checks at most 100, so it does not enforce two-factor authentication from here.', 409)
    const lacking = v.admins.filter(a => a.state !== 'on').map(a => a.uid)
    if (lacking.length && body.adminWithout2fa !== true) {
      throw new NcRefusal('admin_without_2fa', `Admin${lacking.length === 1 ? '' : 's'} ${lacking.join(', ')} ha${lacking.length === 1 ? 's' : 've'} no second factor. Set one up first, or confirm that they will be made to set one up at their next sign-in.`, 409, { admins: lacking })
    }
    for (const g of [...v.enforcement.groups, ...v.enforcement.excluded]) {
      if (!NC_GROUP_RE.test(g) || /\s/.test(g)) throw new NcRefusal('bad_group', `The current enforcement names group "${g.slice(0, 40)}", which HyperProx cannot pass on; change it with occ by hand.`, 409)
    }
    return { groups: v.enforcement.groups, exclude: [...new Set([...v.enforcement.excluded, ...exclude])] }
  }

  /** Checked parameters for an action, and what of them may be audited (never a password). */
  private checkParams(action: ActionId, b: Record<string, unknown>, dep: Deployment): { values: Record<string, unknown>; audit: Record<string, unknown> } {
    const bad = (msg: string) => new NcRefusal('bad_input', msg)
    switch (action) {
      case 'maintenance-window': {
        const hour = Number(b.hour)
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw bad('Pick an hour from 0 to 23 (UTC).')
        return { values: { hour }, audit: { hour } }
      }
      case 'phone-region': {
        const region = String(b.region ?? '').toUpperCase()
        if (!REGIONS.includes(region)) throw bad('Pick a country from the list.')
        return { values: { region }, audit: { region } }
      }
      case 'server-id': {
        const sid = Number(b.id)
        if (!Number.isInteger(sid) || sid < 0 || sid > 1023) throw bad('The server id is a whole number from 0 to 1023.')
        return { values: { id: sid }, audit: { id: sid } }
      }
      case 'enforce-2fa': {
        if (b.acknowledged !== true) throw bad('Confirm that you read who has no second factor yet.')
        const exclude = Array.isArray(b.exclude) ? b.exclude.map(String).filter(Boolean).slice(0, 10) : []
        for (const g of exclude) if (!NC_GROUP_RE.test(g) || /\s/.test(g)) throw bad(`"${g.slice(0, 40)}" is not a group name HyperProx passes on (no spaces).`)
        return { values: { exclude }, audit: { exclude, adminWithout2fa: b.adminWithout2fa === true } }
      }
      case 'notify-push-setup': {
        const url = String(b.url ?? '')
        return { values: { url }, audit: { url } }
      }
      case 'smtp': {
        const v = cleanSmtp(b)
        return { values: v as any, audit: { mode: v.mode, host: v.host, port: v.port, secure: v.secure, auth: v.auth, from: `${v.fromUser}@${v.domain}`, password: v.password ? 'new' : 'kept' } }
      }
      case 'update':
        if (dep.kind !== 'compose') throw new NcRefusal('not_compose', 'HyperProx updates Nextcloud only when it runs under Docker Compose; this one shows the manual steps instead.', 409)
        return { values: {}, audit: {} }
      default:
        return { values: {}, audit: {} }
    }
  }

  private occ(m: NcMeta, dep: Deployment, id: OccId, params?: unknown, timeoutMs = 10 * 60_000, onData?: (c: string) => void) {
    return this.run(m.guest, occScript(dep.occ, id, params), timeoutMs, onData)
  }

  private async runShort(m: NcMeta, dep: Deployment, action: ActionId, p: { values: Record<string, unknown> }, actor: Actor): Promise<string> {
    void actor
    const must = async (r: { code: number; output: string }, what: string) => {
      if (r.code !== 0) throw new NcRefusal('occ_failed', `${what} failed: ${r.output.trim().split('\n').slice(-3).join(' ').slice(0, 300) || 'no output'}`, 502)
      return r
    }
    switch (action) {
      case 'maintenance-window':
        await must(await this.occ(m, dep, 'set-maintenance-window', p.values), 'Setting the maintenance window')
        return `The maintenance window now starts at ${String(p.values.hour).padStart(2, '0')}:00 UTC.`
      case 'phone-region':
        await must(await this.occ(m, dep, 'set-phone-region', p.values), 'Setting the phone region')
        return `The default phone region is now ${p.values.region}.`
      case 'server-id':
        await must(await this.occ(m, dep, 'set-server-id', p.values), 'Setting the server id')
        return `The server id is now ${p.values.id}.`
      case 'disable-app-api': {
        const n = parseExApps((await this.occ(m, dep, 'appapi-list')).output)
        if (n !== 0) throw new NcRefusal('in_use', n === null ? 'HyperProx could not tell whether any External Apps are installed, so AppAPI stays on.' : `${n} External App${n === 1 ? ' is' : 's are'} installed, so AppAPI stays on.`, 409)
        await must(await this.occ(m, dep, 'disable-app-api'), 'Turning AppAPI off')
        return 'AppAPI is off. Turn it back on under Apps any time.'
      }
      case 'install-notify-push': {
        const apps = parseAppList((await this.occ(m, dep, 'app-list')).output)
        if (apps.enabled.notify_push) return 'Client Push is already installed. Next: run its daemon and route /push to it.'
        await must(await this.occ(m, dep, apps.disabled.includes('notify_push') ? 'enable-notify-push' : 'install-notify-push', undefined, 5 * 60_000), 'Installing Client Push')
        return 'Client Push is installed. Next: run its daemon and route /push to it (the steps are below).'
      }
      case 'notify-push-setup': {
        const login = await this.d.store.login(m.id)
        let own = login.url
        if (!own) {
          const b = batch(dep.occ, [{ key: 'u', id: 'config-get', params: { key: 'overwrite.cli.url' } }])
          own = configValue(b.parse((await this.run(m.guest, b.script)).output).u)
        }
        let ownOrigin: string | null = null
        try { ownOrigin = own ? new URL(own).origin : null } catch { ownOrigin = null }
        if (!ownOrigin) throw new NcRefusal('bad_input', 'Nextcloud\'s own address is not set (or not a full address): add it in Settings first.', 400)
        let want: URL
        try { want = new URL(String(p.values.url || `${own}/push`)) } catch { throw new NcRefusal('bad_input', 'The push address is not a full address.', 400) }
        if (ownOrigin !== want.origin) throw new NcRefusal('bad_input', 'Client Push must be served from Nextcloud\'s own address (the same https:// host, at /push).', 400)
        const r = await this.occ(m, dep, 'notify-push-setup', { url: want.toString() }, 2 * 60_000)
        if (r.code !== 0) throw new NcRefusal('push_test_failed', `Nextcloud tested ${want.toString()} and it did not work yet: ${r.output.trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)}`, 502)
        return `Client Push is set up at ${want.toString()}.`
      }
      case 'enforce-2fa':
        await must(await this.occ(m, dep, 'enforce-2fa', { groups: p.values.groups, exclude: p.values.exclude }), 'Enforcing two-factor authentication')
        return `Two-factor authentication is enforced${(p.values.groups as string[]).length ? ` for ${(p.values.groups as string[]).join(', ')}` : ''}${(p.values.exclude as string[]).length ? `, except ${(p.values.exclude as string[]).join(', ')}` : ''}. Users without one are asked to set it up at their next sign-in. Undo: Stop enforcing.`
      case 'unenforce-2fa':
        await must(await this.occ(m, dep, 'unenforce-2fa'), 'Turning two-factor enforcement off')
        return 'Two-factor authentication is no longer enforced. Second factors people already set up keep working.'
      case 'smtp': {
        const v = p.values as unknown as Smtp
        let password = v.password
        if (v.auth && !password) {
          // A saved password is only reused for the server, port and login it was saved with.
          const saved = await this.d.store.smtp(m.id)
          if (saved.password && (saved.host !== v.host.toLowerCase() || saved.port !== v.port || saved.user !== v.user)) {
            throw new NcRefusal('bad_input', 'The mail server, port or login changed, so enter the password again in the same save.')
          }
          password = saved.password
        }
        if (v.auth && !password) throw new NcRefusal('bad_input', 'Enter the mail server password (it is kept in the vault).')
        if (v.auth && v.password) await this.d.store.saveSmtp(m.id, { host: v.host, port: v.port, user: v.user, password: v.password })
        const system: Record<string, unknown> = {
          mail_smtpmode: v.mode, mail_from_address: v.fromUser, mail_domain: v.domain,
          ...(v.mode === 'smtp' ? { mail_smtphost: v.host, mail_smtpport: v.port, mail_smtpsecure: v.secure === 'ssl' ? 'ssl' : '', mail_smtpauth: v.auth, ...(v.auth ? { mail_smtpname: v.user, mail_smtppassword: password } : {}) } : {}),
        }
        for (const k of Object.keys(system)) if (!(k in SMTP_KEYS)) throw new NcRefusal('bad_input', 'Not a mail setting.')
        // The JSON (with the password) goes to occ on stdin (config:import /dev/stdin, inside the script's quoted
        // heredoc): never a command line, never a log.
        const r = await this.run(m.guest, occScript(dep.occ, 'import-smtp', undefined, JSON.stringify({ system })), 60_000)
        if (r.code !== 0) throw new NcRefusal('occ_failed', 'Nextcloud did not take the mail settings.', 502)
        return `Mail goes through ${v.mode === 'smtp' ? `${v.host}:${v.port}` : 'sendmail'} as ${v.fromUser}@${v.domain}. Now send a test mail from Nextcloud (Administration → Basic settings → Send email): that clears the warning.`
      }
      default:
        throw new NcRefusal('unknown_action', 'Not a short action.', 400)
    }
  }

  private async runLong(m: NcMeta, dep: Deployment, action: ActionId, io: RunIO): Promise<{ message: string; rollback?: string }> {
    const stream = (c: string) => { for (const l of c.split('\n')) if (l.trim()) io.log(l.slice(0, 400)) }
    const step = async (key: string, id: OccId, timeoutMs: number) => {
      io.step(key, 'running')
      const r = await this.occ(m, dep, id, undefined, timeoutMs, stream)
      io.step(key, r.code === 0 ? 'done' : 'failed', r.code === 0 ? undefined : r.output.trim().split('\n').slice(-2).join(' ').slice(0, 200))
      return r.code === 0
    }
    if (action === 'add-indices') {
      const ok = [await step('indices', 'add-indices', 3 * 60 * 60_000), await step('columns', 'add-columns', 60 * 60_000), await step('keys', 'add-primary-keys', 60 * 60_000)]
      if (ok.some(x => !x)) throw new Error('One of the database steps failed; its last lines are above.')
      return { message: 'The missing indices, columns and primary keys are added.' }
    }
    if (action === 'mimetype-repair') {
      if (!await step('repair', 'repair-expensive', 6 * 60 * 60_000)) throw new Error('The repair did not finish; its last lines are above.')
      return { message: 'The mimetype migrations are done.' }
    }
    if (action === 'update-apps') {
      if (!await step('apps', 'update-apps', 60 * 60_000)) throw new Error('Some apps did not update; the lines above say which.')
      return { message: 'The apps are up to date.' }
    }
    throw new Error('Not a background action.')
  }

  // ── jobs ───────────────────────────────────────────────────────────────────

  private stepsFor(action: ActionId): JobStep[] {
    const s = (key: string, label: string): JobStep => ({ key, label, state: 'pending' })
    if (action === 'add-indices') return [s('indices', 'Add missing indices'), s('columns', 'Add missing columns'), s('keys', 'Add missing primary keys')]
    if (action === 'mimetype-repair') return [s('repair', 'occ maintenance:repair --include-expensive')]
    if (action === 'update-apps') return [s('apps', 'occ app:update --all')]
    if (action === 'update') return UPDATE_STEPS.map(x => s(x.key, x.label))
    if (action === 'hpb-update') return HPB_STEPS.map(x => s(x.key, x.label))
    return []
  }

  private newJob(m: NcMeta, action: ActionId, actor: Actor, rollback: string | null, detached: Job['detached']): Job {
    return {
      id: `j${crypto.randomBytes(6).toString('hex')}`, instanceId: m.id, action, by: actor.email, state: 'running',
      steps: this.stepsFor(action), lines: [], startedAt: new Date(this.now()).toISOString(), endedAt: null, result: null, rollback,
      detached, maintenance: null,
    }
  }

  private async persist(j: Job): Promise<void> {
    try { await this.store.save(j) } catch { /* the page still has it in memory; the next save tries again */ }
  }

  /** Keep running jobs, and per instance the 5 newest finished ones of the last day. */
  private prune(): void {
    const cut = this.now() - 86_400_000
    const byInst = new Map<string, Job[]>()
    for (const j of this.jobs.values()) if (j.state !== 'running') byInst.set(j.instanceId, [...(byInst.get(j.instanceId) ?? []), j])
    for (const list of byInst.values()) {
      list.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      list.forEach((j, i) => { if (i >= 5 || Date.parse(j.endedAt ?? j.startedAt) < cut) this.jobs.delete(j.id) })
    }
  }

  private async finishJob(j: Job, audit: Record<string, unknown>): Promise<void> {
    j.endedAt = new Date(this.now()).toISOString()
    for (const st of j.steps) if (st.state === 'running') st.state = 'failed'
    // A rollback is only worth reading when the container was recreated; before that nothing changed for good.
    const recreate = j.steps.find(st => st.key === 'recreate')
    if (j.state === 'failed' && recreate && recreate.state === 'pending') j.rollback = null
    if (j.state === 'done' || j.state === 'problems') j.rollback = j.action === 'update' ? j.rollback : null
    await this.persist(j)
    this.long.end(j.id)
    this.busy.delete(j.instanceId)
    this.cache.delete(j.instanceId)
    await this.d.audit(`nextcloud.action.${j.action}.${j.state}`, `nextcloud:${j.instanceId}`, { by: j.by, job: j.id, ...(j.state === 'failed' ? { error: (j.result ?? '').slice(0, 200) } : {}), ...audit }).catch(() => {})
    this.prune()
  }

  /** Work run from HyperProx itself (it ends with this process; deploy.sh waits for it while it runs). */
  private async startJob(m: NcMeta, action: ActionId, actor: Actor, audit: Record<string, unknown>, work: (io: RunIO) => Promise<{ message: string; rollback?: string }>, rollback: string | null = null): Promise<{ message: string; jobId: string }> {
    const job = this.newJob(m, action, actor, rollback, null)
    this.long.register({ id: job.id, owner: 'nextcloud', label: `Nextcloud ${m.name}: ${ACTIONS[action].label.toLowerCase()}`, detached: false, guest: m.guest })
    this.jobs.set(job.id, job)
    this.busy.add(m.id)
    await this.persist(job)
    const io: RunIO = {
      run: (script, timeoutMs) => this.run(m.guest, script, timeoutMs),
      step: (key, state, detail) => { const st = job.steps.find(x => x.key === key); if (st) { st.state = state; if (detail !== undefined) st.detail = detail.slice(0, 300) } void this.persist(job) },
      log: line => { job.lines.push(line.slice(0, 400)); if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES) },
      sleep: ms => this.sleep(ms),
      now: () => this.now(),
    }
    void (async () => {
      let state: Job['state'], result: string, rb: string | undefined
      try { const r = await work(io); state = 'done'; result = r.message; rb = r.rollback }
      catch (e: any) { state = 'failed'; result = String(e?.message ?? 'It failed.').slice(0, 600) }
      if (this.abandoned.has(job.id)) return
      job.state = state; job.result = result; if (rb) job.rollback = rb
      await this.finishJob(job, audit)
    })()
    return { message: `${ACTIONS[action].label}: started.`, jobId: job.id }
  }

  async job(id: string, jobId: string): Promise<Job> {
    const j = this.jobs.get(jobId) ?? (JOB_ID_RE.test(jobId) ? await this.store.get(jobId).catch(() => null) : null)
    if (!j || j.instanceId !== id) throw new NcRefusal('no_job', 'No such job.', 404)
    return j
  }

  /** The newest job of an instance, so a page that was reloaded (or an API that restarted) finds a running update again. */
  async latestJob(id: string): Promise<Job | null> {
    let best: Job | null = null
    for (const j of this.jobs.values()) if (j.instanceId === id && (!best || j.startedAt > best.startedAt)) best = j
    if (best) return best
    return this.store.latest(id).catch(() => null)
  }

  /**
   * On startup: a detached update is watched again (and stays registered, so no deploy restarts the API under it);
   * work that ran inside the old process is marked failed (it was cut short), and stale markers are cleared.
   */
  async resume(): Promise<void> {
    if (this.resumed) return
    this.resumed = true
    const running = await this.store.running()
    for (const j of running) {
      if (j.detached) {
        this.jobs.set(j.id, j)
        this.busy.add(j.instanceId)
        try { this.long.register({ id: j.id, owner: 'nextcloud', label: `Nextcloud update (${j.instanceId})`, detached: true, guest: j.detached.guest }) } catch { /* the marker dir is gone; the watch still runs */ }
        void this.watch(j)
      } else {
        j.state = 'failed'
        j.result = 'HyperProx restarted while this ran, so it may have been cut short. Check Nextcloud, then run it again if it is still needed.'
        j.endedAt = new Date(this.now()).toISOString()
        await this.persist(j)
        this.long.end(j.id)
      }
    }
    for (const mk of this.long.list('nextcloud')) if (!running.some(j => j.id === mk.id && j.detached) && !this.jobs.has(mk.id)) this.long.end(mk.id)
  }

  /**
   * After the script says done: one occ status from HyperProx. Done only when it reports the version the job put in
   * place (`next`), with maintenance mode off and no upgrade pending; otherwise "finished with problems", with both.
   */
  private async verifyDone(j: Job, next: string | null): Promise<void> {
    let seen = 'occ status did not answer'
    let ok = false
    try {
      const m = await this.meta(j.instanceId)
      const dep = await this.dep(m)
      const b = batch(dep.occ, [{ key: 'status', id: 'status' }])
      const st = b.parse((await this.run(j.detached!.guest, b.script, 60_000)).output).status
      const s = st ? parseStatus(st.output) : null
      if (s) {
        seen = `version ${s.versionString || 'unknown'}, maintenance mode ${s.maintenance ? 'ON' : 'off'}${s.needsDbUpgrade ? ', a database upgrade still pending' : ''}`
        ok = !!next && s.versionString === next && !s.maintenance && !s.needsDbUpgrade
        j.maintenance = s.maintenance ? 'on' : 'off'
      }
    } catch (e: any) { seen = `occ status could not be read (${String(e?.message ?? e).slice(0, 120)})` }
    if (ok) return
    j.state = 'problems'
    j.result = `Finished with problems. The update script reported: ${j.result ?? 'done'} HyperProx then read occ status: ${seen}${next ? `; it expected ${next} with maintenance mode off` : '; the script did not say which version it installed'}.`
  }

  /**
   * Stop watching a job (admin, master password, audited first). For a job HyperProx can no longer reach: it ends
   * the job record and clears its busy marker, so deploys and HyperProx's own update are allowed again. It does not
   * touch the guest: a detached update may still be running there.
   */
  async stopWatching(id: string, jobId: string, actor: Actor): Promise<Job> {
    this.mustPerson(actor)
    const j = await this.job(id, jobId)
    if (j.state !== 'running') throw new NcRefusal('not_running', 'That job is not running.', 409)
    await this.d.audit('nextcloud.job.stop_watching', `nextcloud:${id}`, { by: actor.email, job: j.id, action: j.action })
    this.abandoned.add(j.id)
    this.jobs.set(j.id, j)
    j.state = 'failed'
    j.result = j.detached
      ? `${actor.email} told HyperProx to stop watching this update. It may still be running inside the guest: check ${j.detached.backupDir}/jobs/${j.id}/state and log there before doing anything else. Maintenance mode was last ${j.maintenance ?? 'unknown'}.`
      : `${actor.email} told HyperProx to stop watching this job. It may still be running in the guest.`
    await this.finishJob(j, { stoppedBy: actor.email })
    return j
  }

  /** Read a detached job's state file until it says it finished (or its process is gone without saying so). */
  private async watch(j: Job): Promise<void> {
    const d = j.detached!
    let lastContact = this.now()
    let noted = false
    for (;;) {
      await this.sleep(this.d.pollMs ?? 5_000)
      if (this.abandoned.has(j.id) || j.state !== 'running') return
      let out: string
      const nonce = newNonce()
      try {
        const r = await this.run(d.guest, pollScript(d.backupDir, j.id, nonce), 60_000)
        out = r.output
        lastContact = this.now()
        noted = false
      } catch (e: any) {
        if (!noted) { j.lines.push(`HyperProx cannot reach the guest right now (${String(e?.message ?? e).slice(0, 120)}); the update keeps running there, and HyperProx keeps trying.`); noted = true; await this.persist(j) }
        if (this.now() - lastContact > LOST_CONTACT_MS) {
          j.state = 'failed'
          j.result = `HyperProx has not reached the guest for 3 hours, so it stopped watching. Check the update there: ${d.backupDir}/jobs/${j.id}/state and log. Maintenance mode was last ${j.maintenance ?? 'unknown'}.`
          await this.finishJob(j, {})
          return
        }
        continue
      }
      if (this.abandoned.has(j.id) || j.state !== 'running') return
      const p = parsePoll(out, nonce)
      let changed = false
      for (const st of j.steps) {
        const s = p.steps[st.key]
        if (s && (s.state !== st.state || s.detail !== (st.detail ?? ''))) { st.state = s.state; st.detail = s.detail || undefined; changed = true }
      }
      if (p.maint && p.maint !== j.maintenance) { j.maintenance = p.maint; changed = true }
      if (p.lines.join('\n') !== j.lines.slice(-40).join('\n')) { j.lines = p.lines; changed = true }
      if (p.result) {
        j.state = p.result.state
        j.result = p.result.message
        if (p.dump && j.rollback) j.rollback = j.rollback.replace(/\S*nextcloud-db-\d{8}T\d{6}Z\.(?:dump|sql\.gz)/, p.dump)
        // "Done" is the script's word; HyperProx checks it itself before saying so.
        if (j.state === 'done') await this.verifyDone(j, p.next)
        await this.finishJob(j, {})
        return
      }
      const age = this.now() - Date.parse(j.startedAt)
      if (!p.alive && (p.started || age > 120_000)) {
        j.state = 'failed'
        j.result = `The update stopped without finishing (the guest restarted, or it was killed). Maintenance mode is ${p.maint === 'on' ? 'still ON: turn it off with occ maintenance:mode --off once Nextcloud is checked' : p.maint === 'off' ? 'off' : 'unknown'}. Its log: ${d.backupDir}/jobs/${j.id}/log.`
        await this.finishJob(j, {})
        return
      }
      if (changed) await this.persist(j)
    }
  }

  // ── the update ─────────────────────────────────────────────────────────────

  /** Read-only: what an update would do, and every reason it would be refused right now. */
  async updatePreview(id: string, actor: Actor): Promise<{
    ok: boolean; problems: string[]; warnings: string[]; from: string | null; to: string | null; source: 'build' | 'pull' | null
    backupDir: string | null; steps: string[]; snapshotNote: string | null; rollback: string | null; deployment: Deployment | null; activeUsers: number | null; activeCalls: number | null
  }> {
    this.mustAdmin(actor)
    const res = await this.locked(id, async () => this.preflight(await this.meta(id)))
    return {
      ok: res.problems.length === 0, problems: res.problems, warnings: res.warnings, from: res.plan?.from ?? null, to: res.plan?.offered ?? null, source: res.plan?.source ?? null,
      backupDir: res.plan?.backupDir ?? null, steps: UPDATE_STEPS.map(s => s.label), snapshotNote: res.snapshotNote, rollback: res.plan ? rollbackWords(res.plan, null) : null,
      deployment: res.dep, activeUsers: res.activeUsers, activeCalls: res.activeCalls,
    }
  }

  /**
   * Users with any session or app password active in the last ten minutes. HyperProx's own app password is left out
   * by its token id (never by its name: anyone can name a token HyperProx). Null (unknown, which blocks the update)
   * when the list cannot be read, has a user HyperProx cannot pass to occ, or has more than 200 users.
   */
  private async activeUsers(m: NcMeta, dep: Deployment): Promise<number | null> {
    const b = batch(dep.occ, [{ key: 'users', id: 'user-list' }])
    const lr = b.parse((await this.run(m.guest, b.script)).output)
    const ul = lr.users ? parseUserList(lr.users.output) : { uids: [], excluded: [], ok: false }
    if (!ul.ok || ul.excluded.length || !ul.uids.length || ul.uids.length > 200) return null
    const own = await this.d.store.login(m.id)
    const tb = batch(dep.occ, ul.uids.map((u, i) => ({ key: `t${i}`, id: 'auth-tokens' as const, params: { uid: u } })))
    const t = tb.parse((await this.run(m.guest, tb.script, 5 * 60_000)).output)
    const since = Math.floor(this.now() / 1000) - ACTIVE_WINDOW_S
    let n = 0
    for (let i = 0; i < ul.uids.length; i++) {
      if (!t[`t${i}`]) return null
      const mine = (k: { id: number }) => own.tokenId !== null && own.user === ul.uids[i] && k.id === own.tokenId
      if (parseAuthTokens(t[`t${i}`].output).some(k => k.lastActivity >= since && !mine(k))) n++
    }
    return n
  }

  private async preflight(m: NcMeta): Promise<{ problems: string[]; warnings: string[]; plan: UpdatePlan | null; dep: Deployment | null; snapshotNote: string | null; activeUsers: number | null; activeCalls: number | null }> {
    const problems: string[] = []
    const warnings: string[] = []
    // Detected again: the container may have been recreated since it was added.
    let dep: Deployment | null = null
    try { dep = await this.detectIn(m.guest) } catch (e: any) {
      return { problems: [e instanceof NcRefusal ? e.message : 'Nextcloud was not found in its guest.'], warnings, plan: null, dep: null, snapshotNote: null, activeUsers: null, activeCalls: null }
    }
    await this.d.store.setDeployment(m.id, dep)
    if (dep.kind !== 'compose' || !dep.app) {
      problems.push(dep.kind === 'bare' ? 'This is a plain install; it updates with its command-line updater (the steps are on the page).' : 'This container is not managed by Docker Compose, so HyperProx cannot recreate it safely.')
      return { problems, warnings, plan: null, dep, snapshotNote: null, activeUsers: null, activeCalls: null }
    }
    const b = batch(dep.occ, [
      { key: 'status', id: 'status' }, { key: 'update', id: 'update-check' }, { key: 'calls', id: 'active-calls' }, { key: 'apps', id: 'app-list' },
      { key: 'dbname', id: 'config-get', params: { key: 'dbname' } }, { key: 'dbuser', id: 'config-get', params: { key: 'dbuser' } },
    ])
    const p = b.parse((await this.run(m.guest, b.script)).output)
    const st = p.status ? parseStatus(p.status.output) : null
    const up = p.update ? parseUpdateCheck(p.update.output) : { core: null, apps: [] }
    if (!st) problems.push('occ status did not answer.')
    else {
      if (st.maintenance) problems.push('Nextcloud is already in maintenance mode: something else may be working on it. Turn it off (occ maintenance:mode --off) once that is done.')
      if (st.needsDbUpgrade) problems.push('A database upgrade is already pending: finish it (occ upgrade) before starting another update.')
    }
    if (!up.core) problems.push('Nextcloud reports no update.')
    const apps = p.apps ? parseAppList(p.apps.output) : { enabled: {}, disabled: [] }
    let activeCalls: number | null = null
    if (apps.enabled.spreed) {
      activeCalls = p.calls && p.calls.code === 0 ? parseActiveCalls(p.calls.output) : null
      if (activeCalls === null) problems.push('HyperProx could not tell whether a Talk call is running.')
      else if (activeCalls > 0) problems.push(`${activeCalls} Talk call${activeCalls === 1 ? ' is' : 's are'} running. Update when nobody is in a call.`)
    }
    const activeUsers = await this.activeUsers(m, dep).catch(() => null)
    if (activeUsers === null) problems.push('HyperProx could not tell who is using Nextcloud right now (it checks each user\'s sessions; it cannot with more than 200 users, or with a user id it does not pass to occ).')
    else if (activeUsers > 0) problems.push(`${activeUsers} user${activeUsers === 1 ? ' was' : 's were'} active in the last 10 minutes. Update when nobody is using it (HyperProx's own app password is not counted).`)
    const backup = await this.d.backupRunning(m.guest).catch(() => null)
    if (backup === true) problems.push('A backup of this guest is running. Update after it finishes.')
    else if (backup === null) warnings.push('HyperProx could not read whether a backup is running.')
    if (!dep.db) problems.push('The database container was not found in the same Compose project, so it cannot be dumped first.')
    const dbName = configValue(p.dbname), dbUser = configValue(p.dbuser)
    const a = dep.app
    const plan: UpdatePlan | null = dep.db && st && a.service && a.workdir && a.configFile && a.project ? {
      from: st.versionString, offered: up.core ?? '', source: a.built ? 'build' : 'pull', backupDir: backupDirOf(dep), stamp: stampOf(this.now()),
      db: { engine: dep.db.engine, container: dep.db.container, name: dbName, user: dbUser },
      app: { container: a.container, service: a.service, image: a.image, imageId: a.imageId, workdir: a.workdir, configFile: a.configFile, project: a.project },
    } : null
    if (plan) {
      if (plan.db.engine === 'postgres' && (!dbName || !dbUser)) problems.push('Nextcloud\'s config does not name its database and user, so it cannot be dumped.')
      else {
        try {
          const room = parseRoom((await this.run(m.guest, preflightScript(plan))).output)
          const rp = roomProblem(room)
          if (rp) problems.push(rp)
          if (!room.compose) problems.push('docker compose is not available in the guest.')
          if (!room.configFile) problems.push(`The Compose file ${plan.app.configFile} is not there any more.`)
          if (room.imageId && room.imageId !== plan.app.imageId) warnings.push('The container\'s image changed since it was detected.')
        } catch (e: any) { problems.push(e?.message ?? 'The preflight could not run.') }
      }
      if (plan.source === 'build') warnings.push('The image is built from a Dockerfile here, so HyperProx rebuilds it with --pull (a plain pull would change nothing).')
      if (plan.app.image.includes('@')) warnings.push('The image is referenced by digest; HyperProx cannot keep a rollback tag of it.')
    }
    const snapshotNote = await this.d.snapshotNote(m.guest).catch(() => null)
    return { problems, warnings, plan, dep, snapshotNote, activeUsers, activeCalls }
  }

  /** The update: checked again, audited, then started detached in the guest and watched from here. */
  private async startUpdate(m: NcMeta, actor: Actor, body: Record<string, unknown>): Promise<{ message: string; jobId: string }> {
    const pre = await this.preflight(m)
    if (pre.problems.length || !pre.plan) throw new NcRefusal('preflight', pre.problems[0] ?? 'The update cannot run now.', 409, { problems: pre.problems })
    if (body.confirmBackupDir !== pre.plan.backupDir) throw new NcRefusal('confirm', 'Confirm the update from its check screen (it shows where the database dump goes).', 400)
    const plan = pre.plan
    await this.d.audit('nextcloud.action.update', `nextcloud:${m.id}`, { by: actor.email, via: 'session', from: plan.from, offered: plan.offered, source: plan.source, backupDir: plan.backupDir })
    const job = this.newJob(m, 'update', actor, rollbackWords(plan, null), { guest: m.guest, backupDir: plan.backupDir })
    // Registered before it starts: from here until it is seen to finish, no deploy restarts the API.
    this.long.register({ id: job.id, owner: 'nextcloud', label: `Nextcloud ${m.name}: update ${plan.from} to ${plan.offered}`, detached: true, guest: m.guest })
    this.jobs.set(job.id, job)
    this.busy.add(m.id)
    job.steps.find(s => s.key === 'preflight')!.state = 'done'
    job.steps.find(s => s.key === 'preflight')!.detail = 'nobody active, no call, no backup running, room for the dump'
    // Mandatory: a detached update nobody could find again after a restart must not start.
    try { await this.store.save(job) } catch (e: any) {
      this.jobs.delete(job.id); this.long.end(job.id); this.busy.delete(m.id)
      throw new NcRefusal('job_store', `The job could not be saved, so the update was not started (${String(e?.message ?? e).slice(0, 120)}).`, 503)
    }
    let launched = false
    try {
      const r = await this.run(m.guest, launchScript(plan, job.id), 120_000)
      launched = r.code === 0 && /^LAUNCHED\|(systemd|setsid)$/m.test(r.output)
      if (!launched) job.result = `The update could not be started in the guest: ${r.output.trim().split('\n').slice(-2).join(' ').slice(0, 300)}. Nothing was changed; maintenance mode is off.`
    } catch (e: any) {
      job.result = `The update could not be started in the guest (${String(e?.message ?? e).slice(0, 200)}). If it did start, its state is in ${plan.backupDir}/jobs/${job.id}.`
      // It may have started: watch it anyway rather than drop it.
      launched = true
    }
    if (!launched) { job.state = 'failed'; await this.finishJob(job, {}); throw new NcRefusal('launch_failed', job.result!, 502) }
    void this.watch(job)
    return { message: 'Update to Nextcloud ' + plan.offered + ': started in the guest. It keeps running there if HyperProx restarts.', jobId: job.id }
  }

  private async startHpbUpdate(m: NcMeta, actor: Actor): Promise<{ message: string; jobId: string }> {
    const dep = await this.detectIn(m.guest)
    const s = dep.signaling
    if (!s) throw new NcRefusal('no_hpb', 'The Talk signalling server was not found in this guest.', 404)
    await this.d.store.setDeployment(m.id, dep)
    if (!s.service || !s.workdir || !s.configFile || !s.project) throw new NcRefusal('not_compose', 'The signalling server is not managed by Docker Compose, so HyperProx cannot recreate it safely.', 409)
    const b = batch(dep.occ, [{ key: 'calls', id: 'active-calls' }])
    const calls = b.parse((await this.run(m.guest, b.script)).output).calls
    const n = calls && calls.code === 0 ? parseActiveCalls(calls.output) : null
    if (n === null) throw new NcRefusal('preflight', 'HyperProx could not tell whether a Talk call is running, so it did not touch the signalling server.', 409)
    if (n > 0) throw new NcRefusal('preflight', `${n} Talk call${n === 1 ? ' is' : 's are'} running. Update the signalling server when nobody is in a call.`, 409)
    const plan: HpbPlan = { container: s.container, service: s.service, image: s.image, imageId: s.imageId, workdir: s.workdir, configFile: s.configFile, project: s.project, from: s.version }
    await this.d.audit('nextcloud.action.hpb-update', `nextcloud:${m.id}`, { by: actor.email, via: 'session', image: s.image, from: s.version })
    return this.startJob(m, 'hpb-update', actor, { from: s.version }, async io => {
      io.step('preflight', 'done', 'no call running')
      const r = await runHpbUpdate(plan, io)
      return { message: r.changed ? `The signalling server is on ${r.version}.` : `The newest ${s.image} is the one already running (${r.version ?? 'unknown version'}); a newer release will fix the missing features when it is published.` }
    }, `The previous image is tagged ${s.image.replace(/:[^/:]*$/, '')}:hyperprox-pre-<version>. To go back: docker tag that image ${s.image}, then docker compose up -d --no-deps ${s.service} in ${s.workdir}.`)
  }
}

const stampOf = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')

// ── SMTP form ────────────────────────────────────────────────────────────────

export interface Smtp { mode: 'smtp' | 'sendmail'; host: string; port: number; secure: 'ssl' | 'starttls' | 'none'; auth: boolean; user: string; password: string | null; fromUser: string; domain: string }

const HOST_RE = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$|^\d{1,3}(?:\.\d{1,3}){3}$/

export function cleanSmtp(b: Record<string, unknown>): Smtp {
  const bad = (msg: string) => new NcRefusal('bad_input', msg)
  const mode = b.mode === 'sendmail' ? 'sendmail' : 'smtp'
  const host = String(b.host ?? '').trim()
  const port = Number(b.port)
  const secure = b.secure === 'ssl' || b.secure === 'none' ? b.secure : 'starttls'
  const auth = b.auth === true
  const user = String(b.user ?? '').trim()
  const password = typeof b.password === 'string' && b.password !== '' ? b.password : null
  const fromUser = String(b.fromUser ?? '').trim()
  const domain = String(b.domain ?? '').trim().toLowerCase()
  if (mode === 'smtp') {
    if (!HOST_RE.test(host)) throw bad('The mail server is a host name such as smtp.example.com.')
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad('The port is a number, usually 587 (STARTTLS) or 465 (SSL).')
    if (auth && (!user || user.length > 200 || /[\r\n\0]/.test(user))) throw bad('Enter the mail account\'s login.')
  }
  if (password !== null && (password.length > 500 || /[\r\n\0]/.test(password))) throw bad('That password cannot be used (no line breaks).')
  if (!/^[A-Za-z0-9._%+-]{1,64}$/.test(fromUser)) throw bad('The sender is the part before the @, such as cloud or noreply.')
  if (!HOST_RE.test(domain) || !domain.includes('.')) throw bad('The sender domain is the part after the @, such as example.com.')
  return { mode, host, port, secure, auth, user, password, fromUser, domain }
}

export { OccRefusal }
export type { OccTarget }
