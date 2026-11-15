// =============================================================================
//  HyperProx — Nextcloud: the service
//
//  Reads: one reading per instance, kept 30 seconds. occ in the guest (one
//  round trip for every read) is the source of truth; the optional OCS login
//  adds what only the web side knows (active users, storage, PHP and database
//  details, and the admin page's own setup checks, which know the request).
//
//  Actions: every one is an admin's, a signed-in person's (an API token is
//  refused by name), audited BEFORE it runs (no audit row, no action), one at a
//  time per instance, and either one allow-listed occ command with checked
//  arguments or a fixed sequence of them (lib/nextcloud/update.ts). Which
//  actions also need the master password re-entered is fixed here (ACTIONS),
//  not chosen by the caller: a secure action on the plain route is refused.
// =============================================================================

import crypto from 'node:crypto'
import { hasRole } from '../roles'
import { ACTIONS, countable, isAction, remedyFor, suggestRegion, suggestServerId, suggestWindow, type ActionId } from './checks'
import { parseDetect, DETECT_SCRIPT, type Deployment } from './detect'
import { OccRefusal, occBatchScript, occScript, REGIONS, SMTP_KEYS, type OccId, type OccTarget, type ReadKey, parseBatch, NC_GROUP_RE, CONTAINER_RE } from './occ'
import type { NcInstanceStore } from './instances'
import { cleanAppPassword, cleanGuest, cleanName, cleanUrl, cleanUser } from './instances'
import {
  compareVersions, configValue, parseActiveCalls, parseSystemConfig, parseAppList, parseAuthTokens, parseExApps, parseLog, parseServerInfo, parseSetupChecks,
  parseStatus, parseTwoFactorState, parseUpdateCheck, parseUserList, parseUserReport, type SetupCheck,
} from './parse'
import type { OcsGet } from './ocs'
import { HPB_STEPS, UPDATE_STEPS, backupDirOf, parseRoom, preflightScript, roomProblem, rollbackWords, runComposeUpdate, runHpbUpdate, type HpbPlan, type RunIO, type UpdatePlan } from './update'
import { NcRefusal, type Actor, type BusyHoursLike, type CheckView, type GuestRef, type Job, type JobStep, type NcMeta, type Reading } from './types'

export interface GuestRow { kind: 'lxc' | 'qemu'; vmid: number; name: string; node: string; running: boolean; ignored: boolean }

export interface ServiceDeps {
  store: NcInstanceStore
  /** Must throw when the row could not be written: an action is never taken unaudited. */
  audit: (action: string, resource: string, details: Record<string, unknown>) => Promise<void>
  /** A script in the guest, as root, through its node's login. */
  exec: (g: GuestRef, script: string, o?: { timeoutMs?: number; onData?: (chunk: string) => void }) => Promise<{ code: number; output: string; timedOut: boolean }>
  guests: () => Promise<GuestRow[]>
  ocs: (l: { url: string; user: string; appPassword: string }) => OcsGet
  /** HyperProx's busy hours (Placement settings) and the cluster's time zone, or null. */
  quietHours: () => Promise<{ busy: BusyHoursLike[]; tz: string | null } | null>
  /** A backup task (vzdump) of this guest running now: true, false, or null when it cannot be told. */
  backupRunning: (g: GuestRef) => Promise<boolean | null>
  /** Why this guest cannot be snapshotted (bind mounts), or null when it can or it cannot be told. */
  snapshotNote: (g: GuestRef) => Promise<string | null>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const CACHE_MS = 30_000
const ACTIVE_WINDOW_S = 10 * 60
const READ_TIMEOUT = 120_000
const MAX_LINES = 400

const READ_KEYS: ReadKey[] = ['maintenance_window_start', 'default_phone_region', 'serverid', 'default_timezone', 'default_locale', 'default_language',
  'mail_smtpmode', 'mail_smtphost', 'mail_smtpport', 'mail_smtpsecure', 'mail_from_address', 'mail_domain', 'upgrade.disable-web', 'dbname', 'dbuser', 'overwrite.cli.url']
const TWO_FACTOR_PROVIDERS = ['twofactor_totp', 'twofactor_webauthn', 'twofactor_nextcloud_notification', 'twofactor_email', 'twofactor_u2f', 'twofactor_gateway']

const hpbMissing = (desc: string) => (/missing features?:\s*([A-Za-z0-9_, -]{1,300})/i.exec(desc)?.[1] ?? '').split(/[,\s]+/).filter(Boolean).slice(0, 20)

export class NextcloudService {
  private cache = new Map<string, { at: number; r: Reading }>()
  private jobs = new Map<string, Job>()
  private busy = new Set<string>()
  private actionTimes = new Map<string, number[]>()
  readonly now: () => number
  private sleep: (ms: number) => Promise<void>

  constructor(private d: ServiceDeps) {
    this.now = d.now ?? Date.now
    this.sleep = d.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
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
    if (row.ignored) throw new NcRefusal('ignored', `${row.name} has the Proxmox tag hyperprox-ignore, so HyperProx never looks inside it.`, 403)
    if (!row.running) throw new NcRefusal('not_running', `${row.name} is not running.`, 409)
    const r = await this.run(g, DETECT_SCRIPT, 90_000)
    let dep: Deployment | null
    try { dep = parseDetect(r.output) } catch (e: any) { throw new NcRefusal('detect_failed', e?.message ?? 'The detection did not finish.', 502) }
    if (!dep) throw new NcRefusal('not_found', `No Nextcloud was found in ${row.name}: no running container with occ, and no occ in the usual places.`, 404)
    return dep
  }

  // ── instances ──────────────────────────────────────────────────────────────

  /**
   * Add: the guest is checked and Nextcloud detected in it before anything is saved; an OCS login, when given, is
   * tested with a real read first. `createAppPassword` makes HyperProx's own app password (named HyperProx) for
   * `user` through occ instead of one being pasted.
   */
  async add(body: Record<string, unknown>, actor: Actor): Promise<NcMeta> {
    this.mustPerson(actor)
    const name = cleanName(body.name)
    const guest = cleanGuest(body.guest)
    const dep = await this.detect(guest, actor)
    let url: string | null = body.url ? cleanUrl(body.url) : null
    const user = body.user ? cleanUser(body.user) : null
    let appPassword: string | null = body.appPassword ? cleanAppPassword(body.appPassword) : null
    if (body.createAppPassword === true) {
      if (!user) throw new NcRefusal('bad_input', 'Name the admin user HyperProx should make its app password for.')
      await this.d.audit('nextcloud.app_password.create', `guest:${guest.kind}-${guest.vmid}`, { by: actor.email, user })
      const r = await this.run(guest, occScript(dep.occ, 'add-app-password', { uid: user }), 60_000)
      appPassword = (/^\s*([A-Za-z0-9]{5}(?:-[A-Za-z0-9]{5}){4}|[A-Za-z0-9]{64,128})\s*$/m.exec(r.output)?.[1]) ?? null
      if (r.code !== 0 || !appPassword) throw new NcRefusal('app_password_failed', 'Nextcloud did not make the app password (is that user an admin?).', 502)
      if (!url) {
        const c = parseBatch((await this.run(guest, occBatchScript(dep.occ, [{ key: 'u', id: 'config-get', params: { key: 'overwrite.cli.url' } }]))).output)
        const cli = configValue(c.u)
        if (cli) { try { url = cleanUrl(cli) } catch { /* not usable */ } }
      }
    }
    if ((url || user || appPassword) && !(url && user && appPassword)) throw new NcRefusal('bad_input', 'The optional web login needs all three: the address, the admin user and an app password.')
    if (url && user && appPassword) {
      try { if (!parseServerInfo(await this.d.ocs({ url, user, appPassword })('/ocs/v2.php/apps/serverinfo/api/v1/info?format=json'))) throw new Error('Nextcloud answered, but not with server info (is the serverinfo app on?).') }
      catch (e: any) { throw new NcRefusal('ocs_failed', `The web login did not work: ${e?.message ?? 'no answer'}`, 400) }
    }
    const meta = await this.d.store.create({ name, guest, deployment: dep, url, user, appPassword })
    await this.d.audit('nextcloud.instance.create', `nextcloud:${meta.id}`, { by: actor.email, name, guest: `${guest.kind}-${guest.vmid}`, deployment: dep.kind, ocs: !!appPassword })
    return meta
  }

  async update(id: string, body: Record<string, unknown>, actor: Actor): Promise<NcMeta> {
    this.mustPerson(actor)
    const prev = await this.meta(id)
    const login = await this.d.store.login(id)
    const url = body.url === undefined ? login.url : body.url === '' ? null : cleanUrl(body.url)
    const user = body.user === undefined || body.user === '' ? login.user : cleanUser(body.user)
    const pw = body.appPassword === undefined || body.appPassword === '' ? login.appPassword : cleanAppPassword(body.appPassword)
    // A changed login is tested before it is saved.
    if (url && user && pw && (url !== login.url || user !== login.user || pw !== login.appPassword)) {
      try { if (!parseServerInfo(await this.d.ocs({ url, user, appPassword: pw })('/ocs/v2.php/apps/serverinfo/api/v1/info?format=json'))) throw new Error('no server info') }
      catch (e: any) { throw new NcRefusal('ocs_failed', `The web login did not work: ${e?.message ?? 'no answer'}`, 400) }
    }
    const meta = await this.d.store.update(id, body)
    if (body.redetect === true) await this.d.store.setDeployment(id, await this.detect(prev.guest, actor))
    this.cache.delete(id)
    await this.d.audit('nextcloud.instance.update', `nextcloud:${id}`, { by: actor.email, changed: Object.keys(body).filter(k => ['name', 'url', 'user', 'appPassword', 'redetect'].includes(k)).map(k => (k === 'appPassword' ? 'credential' : k)) })
    return (await this.d.store.get(id)) ?? meta
  }

  async remove(id: string, actor: Actor): Promise<void> {
    this.mustPerson(actor)
    await this.d.store.remove(id)
    this.cache.delete(id)
    await this.d.audit('nextcloud.instance.remove', `nextcloud:${id}`, { by: actor.email })
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

  private extraReads(dep: Deployment | null): string {
    if (!dep || dep.occ.mode !== 'docker') return ''
    const lines: string[] = []
    const add = (key: string, line: string) => lines.push(`echo '@@HPX-BEGIN ${key}@@'`, `${line} 2>&1 | head -c 2000; _rc=\${PIPESTATUS[0]}`, `echo ''`, `echo "@@HPX-END ${key} $_rc@@"`)
    if (!CONTAINER_RE.test(dep.occ.container)) return ''
    add('php', `docker exec -u www-data '${dep.occ.container}' php -r 'echo PHP_VERSION;'`)
    if (dep.db && CONTAINER_RE.test(dep.db.container)) add('dbv', `docker exec '${dep.db.container}' sh -c 'postgres --version 2>/dev/null || mariadbd --version 2>/dev/null || mysqld --version'`)
    return lines.join('\n') + '\n'
  }

  async reading(id: string, o: { fresh?: boolean } = {}): Promise<Reading> {
    const hit = this.cache.get(id)
    if (hit && !o.fresh && this.now() - hit.at < CACHE_MS) return hit.r
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
    const [batch, info, web, quiet] = await Promise.all([
      this.run(m.guest, occBatchScript(dep.occ, items) + this.extraReads(dep), READ_TIMEOUT),
      ocs ? ocs('/ocs/v2.php/apps/serverinfo/api/v1/info?format=json').then(parseServerInfo, (e: any) => { missing.push(`server info (${e?.message ?? 'no answer'})`); return null }) : Promise.resolve(null),
      ocs ? ocs('/index.php/settings/setupcheck').then(parseSetupChecks, () => null) : Promise.resolve(null),
      this.d.quietHours().catch(() => null),
    ])
    const p = parseBatch(batch.output)
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
        providers: TWO_FACTOR_PROVIDERS.filter(a => apps.enabled[a]),
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
    if (batch.code !== 0 && !status) throw new NcRefusal('unreachable', 'HyperProx could not run occ in the guest. Check that it is running and that its node has a login saved (Settings → Setup checklist).', 502)
    this.cache.set(id, { at: this.now(), r })
    return r
  }

  /** Who has no second factor yet (admin; read-only, one occ call per user, up to 100 users). */
  async twoFactorUsers(id: string, actor: Actor): Promise<{ users: Array<{ uid: string; state: 'on' | 'off' | null }>; truncated: boolean; providers: string[] }> {
    this.mustAdmin(actor)
    const m = await this.meta(id)
    const dep = await this.dep(m)
    const lr = parseBatch((await this.run(m.guest, occBatchScript(dep.occ, [{ key: 'users', id: 'user-list' }, { key: 'apps', id: 'app-list' }]))).output)
    const uids = lr.users ? parseUserList(lr.users.output) : []
    const list = uids.slice(0, 100)
    const states = list.length ? parseBatch((await this.run(m.guest, occBatchScript(dep.occ, list.map((u, i) => ({ key: `u${i}`, id: 'twofactor-state' as const, params: { uid: u } }))), 5 * 60_000)).output) : {}
    const apps = lr.apps ? parseAppList(lr.apps.output) : { enabled: {}, disabled: [] }
    return { users: list.map((uid, i) => ({ uid, state: states[`u${i}`] ? parseTwoFactorState(states[`u${i}`].output) : null })), truncated: uids.length > list.length, providers: TWO_FACTOR_PROVIDERS.filter(a => apps.enabled[a]) }
  }

  private async dep(m: NcMeta): Promise<Deployment> {
    if (m.deployment) return m.deployment
    const r = await this.run(m.guest, DETECT_SCRIPT, 90_000)
    const d = parseDetect(r.output)
    if (!d) throw new NcRefusal('not_found', 'Nextcloud was not found in its guest.', 502)
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
      // Audit first: no row, no action.
      await this.d.audit(`nextcloud.action.${action}`, `nextcloud:${id}`, { by: actor.email, via: 'session', params: params.audit })
      if (spec.long) { handedToJob = true; return this.startJob(m, action, actor, params.audit, async (io) => this.runLong(m, dep, action, io)) }
      const msg = await this.runShort(m, dep, action, params, actor)
      this.cache.delete(id)
      return { message: msg }
    } finally { if (!handedToJob) this.busy.delete(id) }
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
        return { values: { exclude }, audit: { exclude } }
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
        const own = login.url ?? configValue(parseBatch((await this.run(m.guest, occBatchScript(dep.occ, [{ key: 'u', id: 'config-get', params: { key: 'overwrite.cli.url' } }]))).output).u)
        let want: URL
        try { want = new URL(String(p.values.url || `${own}/push`)) } catch { throw new NcRefusal('bad_input', 'The push address is not a full address.') }
        if (!own || new URL(own).origin !== want.origin) throw new NcRefusal('bad_input', 'Client Push must be served from Nextcloud\'s own address (the same https:// host, at /push).')
        const r = await this.occ(m, dep, 'notify-push-setup', { url: want.toString() }, 2 * 60_000)
        if (r.code !== 0) throw new NcRefusal('push_test_failed', `Nextcloud tested ${want.toString()} and it did not work yet: ${r.output.trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)}`, 502)
        return `Client Push is set up at ${want.toString()}.`
      }
      case 'enforce-2fa': {
        const apps = parseAppList((await this.occ(m, dep, 'app-list')).output)
        if (!TWO_FACTOR_PROVIDERS.some(a => apps.enabled[a])) throw new NcRefusal('no_provider', 'No second-factor app is enabled (such as TOTP), so nobody could set one up. Enable one under Apps first.', 409)
        await must(await this.occ(m, dep, 'enforce-2fa', p.values), 'Enforcing two-factor authentication')
        return 'Two-factor authentication is enforced. Users without one are asked to set it up at their next sign-in.'
      }
      case 'smtp': {
        const v = p.values as unknown as Smtp
        let password = v.password
        if (v.auth && password) await this.d.store.saveSmtpPassword(m.id, password)
        if (v.auth && !password) password = await this.d.store.smtpPassword(m.id)
        if (v.auth && !password) throw new NcRefusal('bad_input', 'Enter the mail server password (it is kept in the vault).')
        const system: Record<string, unknown> = {
          mail_smtpmode: v.mode, mail_from_address: v.fromUser, mail_domain: v.domain,
          ...(v.mode === 'smtp' ? { mail_smtphost: v.host, mail_smtpport: v.port, mail_smtpsecure: v.secure === 'ssl' ? 'ssl' : '', mail_smtpauth: v.auth, ...(v.auth ? { mail_smtpname: v.user, mail_smtppassword: password } : {}) } : {}),
        }
        for (const k of Object.keys(system)) if (!(k in SMTP_KEYS)) throw new NcRefusal('bad_input', 'Not a mail setting.')
        // The JSON (with the password) goes to occ on stdin, inside the script's quoted heredoc: never a command line, never a log.
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

  private stepsFor(action: ActionId): JobStep[] {
    const s = (key: string, label: string): JobStep => ({ key, label, state: 'pending' })
    if (action === 'add-indices') return [s('indices', 'Add missing indices'), s('columns', 'Add missing columns'), s('keys', 'Add missing primary keys')]
    if (action === 'mimetype-repair') return [s('repair', 'occ maintenance:repair --include-expensive')]
    if (action === 'update-apps') return [s('apps', 'occ app:update --all')]
    if (action === 'update') return UPDATE_STEPS.map(x => s(x.key, x.label))
    if (action === 'hpb-update') return HPB_STEPS.map(x => s(x.key, x.label))
    return []
  }

  private startJob(m: NcMeta, action: ActionId, actor: Actor, audit: Record<string, unknown>, work: (io: RunIO) => Promise<{ message: string; rollback?: string }>, rollback: string | null = null): { message: string; jobId: string } {
    const job: Job = {
      id: `j${crypto.randomBytes(6).toString('hex')}`, instanceId: m.id, action, by: actor.email, state: 'running',
      steps: this.stepsFor(action), lines: [], startedAt: new Date(this.now()).toISOString(), endedAt: null, result: null, rollback,
    }
    this.jobs.set(job.id, job)
    this.busy.add(m.id)
    const io: RunIO = {
      run: (script, timeoutMs) => this.run(m.guest, script, timeoutMs),
      step: (key, state, detail) => { const st = job.steps.find(x => x.key === key); if (st) { st.state = state; if (detail !== undefined) st.detail = detail.slice(0, 300) } },
      log: line => { job.lines.push(line.slice(0, 400)); if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES) },
      sleep: ms => this.sleep(ms),
      now: () => this.now(),
    }
    void (async () => {
      try {
        const r = await work(io)
        job.state = 'done'; job.result = r.message; if (r.rollback) job.rollback = r.rollback
        await this.d.audit(`nextcloud.action.${action}.done`, `nextcloud:${m.id}`, { by: actor.email, job: job.id, ...audit }).catch(() => {})
      } catch (e: any) {
        job.state = 'failed'; job.result = String(e?.message ?? 'It failed.').slice(0, 600)
        for (const st of job.steps) if (st.state === 'running') st.state = 'failed'
        // A rollback is only worth reading when the container was recreated; before that nothing changed for good.
        const recreate = job.steps.find(st => st.key === 'recreate')
        if (recreate && recreate.state === 'pending') job.rollback = null
        await this.d.audit(`nextcloud.action.${action}.failed`, `nextcloud:${m.id}`, { by: actor.email, job: job.id, error: job.result.slice(0, 200) }).catch(() => {})
      } finally {
        job.endedAt = new Date(this.now()).toISOString()
        this.busy.delete(m.id)
        this.cache.delete(m.id)
      }
    })()
    return { message: `${ACTIONS[action].label}: started.`, jobId: job.id }
  }

  job(id: string, jobId: string): Job {
    const j = this.jobs.get(jobId)
    if (!j || j.instanceId !== id) throw new NcRefusal('no_job', 'No such job.', 404)
    return j
  }

  /** The newest job of an instance, so a page that was reloaded finds a running update again. */
  latestJob(id: string): Job | null {
    let best: Job | null = null
    for (const j of this.jobs.values()) if (j.instanceId === id && (!best || j.startedAt > best.startedAt)) best = j
    return best
  }

  // ── the update ─────────────────────────────────────────────────────────────

  /** Read-only: what an update would do, and every reason it would be refused right now. */
  async updatePreview(id: string, actor: Actor): Promise<{
    ok: boolean; problems: string[]; warnings: string[]; from: string | null; to: string | null; source: 'build' | 'pull' | null
    backupDir: string | null; steps: string[]; snapshotNote: string | null; rollback: string | null; deployment: Deployment | null; activeUsers: number | null; activeCalls: number | null
  }> {
    this.mustAdmin(actor)
    const m = await this.meta(id)
    const res = await this.preflight(m)
    return {
      ok: res.problems.length === 0, problems: res.problems, warnings: res.warnings, from: res.plan?.from ?? null, to: res.plan?.offered ?? null, source: res.plan?.source ?? null,
      backupDir: res.plan?.backupDir ?? null, steps: UPDATE_STEPS.map(s => s.label), snapshotNote: res.snapshotNote, rollback: res.plan ? rollbackWords(res.plan, null) : null,
      deployment: res.dep, activeUsers: res.activeUsers, activeCalls: res.activeCalls,
    }
  }

  /** Users with any session or app password active in the last ten minutes, HyperProx's own app password left out. */
  private async activeUsers(m: NcMeta, dep: Deployment): Promise<number | null> {
    const lr = parseBatch((await this.run(m.guest, occBatchScript(dep.occ, [{ key: 'users', id: 'user-list' }]))).output)
    const uids = lr.users ? parseUserList(lr.users.output) : []
    if (!uids.length || uids.length > 200) return null
    const t = parseBatch((await this.run(m.guest, occBatchScript(dep.occ, uids.map((u, i) => ({ key: `t${i}`, id: 'auth-tokens' as const, params: { uid: u } }))), 5 * 60_000)).output)
    const since = Math.floor(this.now() / 1000) - ACTIVE_WINDOW_S
    let n = 0
    for (let i = 0; i < uids.length; i++) {
      if (!t[`t${i}`]) return null
      if (parseAuthTokens(t[`t${i}`].output).some(k => k.lastActivity >= since && !/^HyperProx\b/i.test(k.name))) n++
    }
    return n
  }

  private async preflight(m: NcMeta): Promise<{ problems: string[]; warnings: string[]; plan: UpdatePlan | null; dep: Deployment | null; snapshotNote: string | null; activeUsers: number | null; activeCalls: number | null }> {
    const problems: string[] = []
    const warnings: string[] = []
    // Detected again: the container may have been recreated since it was added.
    const r0 = await this.run(m.guest, DETECT_SCRIPT, 90_000)
    let dep: Deployment | null = null
    try { dep = parseDetect(r0.output) } catch { dep = null }
    if (!dep) return { problems: ['Nextcloud was not found in its guest.'], warnings, plan: null, dep: null, snapshotNote: null, activeUsers: null, activeCalls: null }
    await this.d.store.setDeployment(m.id, dep)
    if (dep.kind !== 'compose' || !dep.app) {
      problems.push(dep.kind === 'bare' ? 'This is a plain install; it updates with its command-line updater (the steps are on the page).' : 'This container is not managed by Docker Compose, so HyperProx cannot recreate it safely.')
      return { problems, warnings, plan: null, dep, snapshotNote: null, activeUsers: null, activeCalls: null }
    }
    const items: Array<{ key: string; id: OccId; params?: unknown }> = [
      { key: 'status', id: 'status' }, { key: 'update', id: 'update-check' }, { key: 'calls', id: 'active-calls' }, { key: 'apps', id: 'app-list' },
      { key: 'dbname', id: 'config-get', params: { key: 'dbname' } }, { key: 'dbuser', id: 'config-get', params: { key: 'dbuser' } },
    ]
    const p = parseBatch((await this.run(m.guest, occBatchScript(dep.occ, items))).output)
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
    if (activeUsers === null) problems.push('HyperProx could not tell who is using Nextcloud right now (it checks each user\'s sessions; with more than 200 users it cannot).')
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
      if (!/^[a-z0-9]/.test(plan.app.image) || plan.app.image.includes('@')) warnings.push('The image is referenced by digest; HyperProx cannot keep a rollback tag of it.')
    }
    const snapshotNote = await this.d.snapshotNote(m.guest).catch(() => null)
    return { problems, warnings, plan, dep, snapshotNote, activeUsers, activeCalls }
  }

  private async startUpdate(m: NcMeta, actor: Actor, body: Record<string, unknown>): Promise<{ message: string; jobId: string }> {
    const pre = await this.preflight(m)
    if (pre.problems.length || !pre.plan) throw new NcRefusal('preflight', pre.problems[0] ?? 'The update cannot run now.', 409, { problems: pre.problems })
    if (body.confirmBackupDir !== pre.plan.backupDir) throw new NcRefusal('confirm', 'Confirm the update from its check screen (it shows where the database dump goes).', 400)
    const plan = pre.plan
    await this.d.audit('nextcloud.action.update', `nextcloud:${m.id}`, { by: actor.email, via: 'session', from: plan.from, offered: plan.offered, source: plan.source, backupDir: plan.backupDir })
    const rollback = rollbackWords(plan, null)
    return this.startJob(m, 'update', actor, { from: plan.from }, async io => {
      io.step('preflight', 'done', 'nobody active, no call, no backup running')
      const r = await runComposeUpdate(plan, io)
      return { message: `Nextcloud is on ${r.version}. The database dump is at ${r.dump}.${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}`, rollback: rollbackWords(plan, r.dump) }
    }, rollback)
  }

  private async startHpbUpdate(m: NcMeta, actor: Actor): Promise<{ message: string; jobId: string }> {
    const r0 = await this.run(m.guest, DETECT_SCRIPT, 90_000)
    let dep: Deployment | null = null
    try { dep = parseDetect(r0.output) } catch { dep = null }
    const s = dep?.signaling
    if (!dep || !s) throw new NcRefusal('no_hpb', 'The Talk signalling server was not found in this guest.', 404)
    await this.d.store.setDeployment(m.id, dep)
    if (!s.service || !s.workdir || !s.configFile || !s.project) throw new NcRefusal('not_compose', 'The signalling server is not managed by Docker Compose, so HyperProx cannot recreate it safely.', 409)
    const calls = parseBatch((await this.run(m.guest, occBatchScript(dep.occ, [{ key: 'calls', id: 'active-calls' }]))).output).calls
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
