// =============================================================================
//  HyperProx — Proxmox Backup Server: the service
//
//  Adding a server does the chores: the address and token are checked, the
//  certificate is read and pinned (first use, or CA-verified), and a real
//  authenticated read is made through that pin before anything is stored. A
//  token that cannot read the server is never saved.
//
//  Reads: one reading per server, kept 30 seconds, limited per session.
//
//  The one action: run verify now (GC is left to its own weekly schedule, whose
//  last and next run the page shows). It is admin, a person (never an
//  API token: the gate's master-password re-confirmation already keeps tokens
//  out, and this service refuses one again by name), names a datastore the
//  server reports, is rate-limited, audited (every attempt, refused or not), and
//  read back: the task's status is fetched after the start. There is no delete,
//  prune or forget.
// =============================================================================

import { hasRole, type Role } from '../roles'
import { normaliseFingerprint } from '../clusters/tls-pin'
import { PbsClient, UPID_RE, type PbsApi } from './client'
import { ACTION_PRIVILEGE, type PbsReading } from './parse'
import { PbsHttpError, PbsUnreachableError, type PbsPin } from './transport'
import { cleanName, cleanSecret, cleanStaleHours, cleanTokenId, cleanUrl, PbsInputError, type PbsInput, type PbsInstanceStore, type PbsMeta } from './instances'
import { DEFAULT_STALE_HOURS } from './parse'
import { PbsManager } from './manage'

export interface Actor { sid: string; email: string; role: Role; token: string | null }

export class PbsRefusal extends Error {
  /** `extra` goes to the page as it is: never a secret (a presented and a pinned fingerprint, say). */
  constructor(public code: string, message: string, public status = 400, public extra: Record<string, unknown> = {}) { super(message); this.name = 'PbsRefusal' }
}

export type PbsAction = 'verify'
export const ACTION_WORD: Record<PbsAction, string> = { verify: 'Verify' }

export interface Presented { fingerprint: string; caVerified: boolean; subject?: string; issuer?: string; validTo?: string }

export interface ServiceDeps {
  store: PbsInstanceStore
  audit: (action: string, resource: string, details: Record<string, unknown>) => Promise<void>
  /** Reads the certificate the address presents, after the address checks. Production: lib/pbs/index.ts. */
  probe: (url: string) => Promise<Presented>
  /** The API for a connection, through its pin. */
  api: (c: { url: string; tokenId: string; secret: string; pin: PbsPin }) => PbsApi
  /** A signed-in session through the pin (the sign-in way of adding a server). The password goes nowhere else. */
  login?: (url: string, pin: PbsPin, userid: string, password: string) => Promise<PbsApi>
  now?: () => number
  wait?: (ms: number) => Promise<unknown>
  limits?: Partial<Limits>
}

export interface Limits { readsPerMinute: number; actionsPerMinute: number; attemptsPerMinute: number; addsPerMinute: number; signinsPerMinute: number; probesPerMinute: number }

const CACHE_MS = 30_000

export function pinFrom(p: Presented, at: Date): PbsPin {
  return { fingerprint: p.fingerprint, source: p.caVerified ? 'ca' : 'first-use', at: at.toISOString() }
}

/** The words for a refused or failed call, with the privilege PBS wants when it is a permission problem. */
export function refusalWords(e: unknown, action?: PbsAction, store?: string): string {
  if (e instanceof PbsHttpError && (e.status === 401 || e.status === 403)) {
    if (action) return `PBS refused: this token lacks ${ACTION_PRIVILEGE[action]} on /datastore/${store}. HyperProx's read-only token (Audit) cannot start a verify; give it the DatastoreReader role on /datastore/${store} (Datastore.Verify, with Datastore.Read and Datastore.Audit, and nothing that prunes or deletes) to allow it.`
    return 'PBS refused the token. Check the token id and secret, and that the token has the Audit role on / (Datastore.Audit and Sys.Audit).'
  }
  if (e instanceof PbsUnreachableError || e instanceof PbsHttpError || e instanceof PbsRefusal) return e.message
  return 'The backup server did not accept the request.'
}

/**
 * The only roles HyperProx ever grants on a backup server: Audit on / (read-only) and, when asked, this on a
 * datastore. Checked in the tests: none of them carries Datastore.Modify or Datastore.Prune.
 */
export const VERIFY_ROLE = 'DatastoreReader'
export const GRANTED_ROLES = ['Audit', VERIFY_ROLE, 'DatastoreBackup'] as const

export class PbsService {
  private cache = new Map<string, { at: number; reading: PbsReading }>()
  private inflight = new Map<string, Promise<PbsReading>>()
  private hits = new Map<string, number[]>()
  private d: ServiceDeps & { now: () => number; wait: (ms: number) => Promise<unknown>; limits: Limits }
  /** Backup management (opt-in): the only code that uses a server's manage token. */
  readonly manager: PbsManager

  constructor(deps: ServiceDeps) {
    this.d = {
      now: () => Date.now(), wait: ms => new Promise(r => setTimeout(r, ms)), ...deps,
      limits: { readsPerMinute: 30, actionsPerMinute: 3, attemptsPerMinute: 20, addsPerMinute: 6, signinsPerMinute: 3, probesPerMinute: 10, ...(deps.limits ?? {}) },
    }
    this.manager = new PbsManager({ store: deps.store, audit: deps.audit, api: deps.api, login: deps.login, now: this.d.now, wait: this.d.wait })
  }

  get instances(): PbsInstanceStore { return this.d.store }

  forget(id: string): void { this.cache.delete(id) }

  limit(actor: Actor, bucket: keyof Limits, message = 'Too many requests; wait a moment.'): void {
    const key = `${actor.sid}:${bucket}`
    const now = this.d.now()
    if (this.hits.size > 1000) for (const [k, v] of this.hits) if (!v.some(t => now - t < 60_000)) this.hits.delete(k)
    const recent = (this.hits.get(key) ?? []).filter(t => now - t < 60_000)
    if (recent.length >= this.d.limits[bucket]) { this.hits.set(key, recent); throw new PbsRefusal('rate_limited', message, 429) }
    recent.push(now); this.hits.set(key, recent)
  }

  /** Probe, pin and prove a connection, before anything is stored. */
  /** What the address presents now (after the address checks). Nothing else is sent. */
  async presented(url: string, actor?: Actor): Promise<Presented> {
    if (actor) this.limit(actor, 'probesPerMinute', 'Too many certificate reads; wait a moment.')
    try { return await this.d.probe(url) }
    catch (e: any) { throw new PbsRefusal('unreachable', e instanceof PbsUnreachableError ? e.message : 'Could not read a certificate from that address. Check it, and that HyperProx can reach port 8007.', 400) }
  }

  /**
   * The pin to use, decided BEFORE any token or password is sent:
   *   - a server already pinned at this address keeps its pin: the certificate presented must be that one (or,
   *     for a CA-verified pin, verify against the public CAs again, which is how a renewal keeps working). A
   *     different one is refused, unless `repin` is set and the admin confirmed exactly the fingerprint presented
   *     now (they were shown it, and compared it with the server's dashboard);
   *   - a new server: a CA-verified certificate is pinned as such; otherwise the admin must have confirmed exactly
   *     the presented fingerprint first (the probe-certificate step), as for a remote cluster or a Home Assistant.
   */
  async decidePin(url: string, existing: PbsPin | null, confirm: unknown, repin: boolean): Promise<PbsPin> {
    const p = await this.presented(url)
    const confirmed = typeof confirm === 'string' ? normaliseFingerprint(confirm) : null
    const fresh = pinFrom(p, new Date(this.d.now()))
    if (existing) {
      if (existing.source === 'ca' && p.caVerified) return fresh
      if (existing.fingerprint === p.fingerprint) return { ...existing }
      if (repin && confirmed === p.fingerprint) return { ...fresh, source: p.caVerified ? 'ca' : 'first-use' }
      throw new PbsRefusal('cert_changed', `The server presents a different certificate (${p.fingerprint}) from the one pinned (${existing.fingerprint}), so nothing was sent to it. If it was replaced on purpose, compare the new fingerprint with the one on the server's dashboard and re-pin it.`, 409, { presented: p.fingerprint, pinned: existing.fingerprint })
    }
    if (p.caVerified) return fresh
    if (confirmed === p.fingerprint) return fresh
    throw new PbsRefusal('confirm_fingerprint', `Confirm the server's certificate first: compare ${p.fingerprint} with the fingerprint on its dashboard (Dashboard → Show Fingerprint), then confirm it. Nothing was sent to the server.`, 409, { presented: p.fingerprint, subject: p.subject ?? null, validTo: p.validTo ?? null })
  }

  /** Prove a token through a pin, before anything is stored. */
  private async prove(url: string, tokenId: string, secret: string, pin: PbsPin): Promise<void> {
    try { await this.d.api({ url, tokenId, secret, pin }).call('GET', '/status/datastore-usage') }
    catch (e) { throw new PbsRefusal('connect_failed', `HyperProx reached the server but could not read it, so nothing was saved. ${refusalWords(e)}`, 400) }
  }

  /** Add a server: check, pin, prove, then store. */
  async add(input: PbsInput & { confirmFingerprint?: unknown }, actor: Actor): Promise<PbsMeta> {
    this.limit(actor, 'addsPerMinute', 'Too many attempts to add a server; wait a moment.')
    const name = cleanName(input.name), url = cleanUrl(input.url), tokenId = cleanTokenId(input.tokenId), secret = cleanSecret(input.secret)
    const staleHours = cleanStaleHours(input.staleHours, DEFAULT_STALE_HOURS)
    if ((await this.d.store.list()).some(i => i.name.toLowerCase() === name.toLowerCase())) throw new PbsInputError('Another backup server already has that name.', 409)
    if (await this.d.store.findByEndpoint(url)) throw new PbsInputError('That server is added already; change its token under its Settings.', 409)
    const pin = await this.decidePin(url, null, input.confirmFingerprint, false)
    await this.prove(url, tokenId, secret, pin)
    return this.d.store.create({ name, url, tokenId, secret, staleHours, pin })
  }

  /**
   * Add a server by signing in once with a PBS admin login (the recommended way in): HyperProx makes its own
   * user and read-only token there and keeps only the token.
   *
   *   1. the certificate is read and pinned BEFORE the password is sent; the sign-in goes through that pin;
   *   2. user hyperprox@pbs is made if missing; its token "readonly" is made, or deleted and made again (so
   *      adding the same server twice is safe and leaves one working token); Audit on / for the user and the
   *      token (a token's privileges are the intersection of its own and its user's);
   *   3. only with `allowVerify` (off by default): DatastoreReader on /datastore/<each> (never on /). In PBS
   *      4.x that role is Datastore.Audit, Datastore.Read and Datastore.Verify: the token can start a verify
   *      and read (restore) backup contents there, and still cannot prune, forget, delete or garbage-collect.
   *      No role HyperProx grants has Datastore.Modify or Datastore.Prune;
   *   4. the permissions are read back and the token is proved with a read through the pin;
   *   5. the token is stored (an instance already at this address gets the new token, not a second entry).
   *
   * The password is used for the one sign-in and dropped: it is never stored, audited, logged or returned,
   * and no error message carries it. Sign-ins are rate-limited per session (3 a minute) and every attempt is
   * audited with the user name only.
   */
  async addWithLogin(input: PbsInput & { username?: unknown; realm?: unknown; password?: unknown; allowVerify?: unknown; manage?: unknown; confirmFingerprint?: unknown; repin?: unknown }, actor: Actor): Promise<PbsMeta & { allowVerify: boolean; manageError?: string }> {
    const user = typeof input.username === 'string' ? input.username.trim() : ''
    const realm = typeof input.realm === 'string' && input.realm.trim() ? input.realm.trim() : 'pam'
    const audit = (result: string, extra: Record<string, unknown> = {}) =>
      this.d.audit('pbs.instance.signin', 'pbs:signin', { by: actor.email, via: actor.token ? `api:${actor.token}` : 'session', login: /^[A-Za-z0-9._-]{1,64}$/.test(user) ? `${user}@${realm.slice(0, 32)}` : 'invalid', result, ...extra })
    try { this.limit(actor, 'signinsPerMinute', 'Too many sign-ins in a minute; wait a moment.') } catch (e) { await audit('refused:rate_limited'); throw e }
    if (actor.token) { await audit('refused:token_forbidden'); throw new PbsRefusal('token_forbidden', 'API tokens cannot sign in to a backup server.', 403) }
    if (!hasRole(actor.role, 'admin')) { await audit('refused:forbidden'); throw new PbsRefusal('forbidden', 'Adding a backup server needs the admin role.', 403) }
    let name: string, url: string, staleHours: number
    try {
      name = cleanName(input.name); url = cleanUrl(input.url); staleHours = cleanStaleHours(input.staleHours, DEFAULT_STALE_HOURS)
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(user)) throw new PbsInputError('Enter the PBS user name, such as root.')
      if (!/^[A-Za-z0-9._-]{1,32}$/.test(realm)) throw new PbsInputError('The realm is pam, pbs or the name of another realm on that server.')
      if (typeof input.password !== 'string' || !input.password || input.password.length > 1024) throw new PbsInputError('Enter that user\'s password.')
    } catch (e) { await audit('refused:bad_input'); throw e }
    const allowVerify = input.allowVerify === true
    const existing = await this.d.store.findByEndpoint(url)
    if (!existing && (await this.d.store.list()).some(i => i.name.toLowerCase() === name.toLowerCase())) { await audit('refused:name_taken'); throw new PbsInputError('Another backup server already has that name.', 409) }

    // 1. The pin, before the password goes anywhere: an existing server's pin must match what is presented now
    //    (a changed certificate is refused unless the admin re-pins it, having seen the new fingerprint), and a new
    //    server's certificate must have been confirmed by the admin (or verify against the public CAs).
    let pin: PbsPin
    try { pin = await this.decidePin(url, existing?.pin ?? null, input.confirmFingerprint, input.repin === true) }
    catch (e: any) { await audit(`refused:${e?.code ?? 'unreachable'}`); throw e }
    let api: PbsApi
    try {
      if (!this.d.login) throw new PbsUnreachableError('Signing in is not available here.')
      api = await this.d.login(url, pin, `${user}@${realm}`, input.password as string)
    }
    catch (e) {
      await audit('failed:signin')
      throw new PbsRefusal('signin_failed', e instanceof PbsHttpError && (e.status === 401 || e.status === 403) ? 'The backup server refused that user name and password.' : refusalWords(e), 400)
    }
    const step = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
      try { return await fn() } catch (e) {
        await audit(`failed:${what}`)
        throw new PbsRefusal('setup_failed', `Signed in, but HyperProx could not ${what.replace(/_/g, ' ')}: ${e instanceof PbsHttpError && (e.status === 401 || e.status === 403) ? 'that login is not allowed to (it needs to manage users and permissions; root@pam can)' : refusalWords(e)}. Nothing was saved.`, 400)
      }
    }
    const U = 'hyperprox@pbs', T = 'readonly', TID = `${U}!${T}`
    const enc = encodeURIComponent
    // 2. The user and its token.
    await step('make_the_user', async () => {
      const users = await api.call('GET', '/access/users')
      if (!(Array.isArray(users) ? users : []).some((x: any) => x?.userid === U)) await api.call('POST', '/access/users', { userid: U, comment: 'HyperProx (read-only)' })
    })
    const secret = await step('make_the_token', async () => {
      const tokens = await api.call('GET', `/access/users/${enc(U)}/token`)
      if ((Array.isArray(tokens) ? tokens : []).some((t: any) => t?.tokenid === TID || t?.['token-name'] === T)) {
        // The old token's ACL lines first, so none outlives it; the new token is granted its own below.
        const acl = await api.call('GET', '/access/acl')
        // Token lines only (PBS lists them as ugid_type "token"): the user's own lines are not this token's.
        const mine = (x: any) => x?.ugid === TID && (x?.ugid_type ?? x?.type) === 'token'
        for (const r of (Array.isArray(acl) ? acl : []).filter(mine)) await api.call('PUT', '/access/acl', { path: r.path, role: r.roleid, 'auth-id': TID, delete: true })
        await api.call('DELETE', `/access/users/${enc(U)}/token/${enc(T)}`)
      }
      const made = await api.call('POST', `/access/users/${enc(U)}/token/${enc(T)}`, { comment: 'HyperProx read-only' })
      if (typeof made?.value !== 'string' || !made.value) throw new PbsUnreachableError('The server did not return a token secret.')
      return made.value as string
    })
    await step('grant_audit', async () => { for (const who of [U, TID]) await api.call('PUT', '/access/acl', { path: '/', role: 'Audit', 'auth-id': who }) })
    // 3. Optional: the two actions, on the datastores only.
    let stores: string[] = []
    if (allowVerify) {
      stores = await step('list_the_datastores', async () => ((await api.call('GET', '/admin/datastore')) as any[] ?? []).map(d => String(d?.store ?? d?.name ?? '')).filter(s => /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(s)))
      await step('grant_verify', async () => { for (const s of stores) for (const who of [U, TID]) await api.call('PUT', '/access/acl', { path: `/datastore/${s}`, role: VERIFY_ROLE, 'auth-id': who }) })
    }
    // 4. Read back.
    await step('read_the_permissions_back', async () => {
      const acl = (await api.call('GET', '/access/acl')) as any[] ?? []
      const has = (path: string, role: string, who: string) => acl.some(r => r?.path === path && r?.roleid === role && r?.ugid === who)
      if (!has('/', 'Audit', TID) || !has('/', 'Audit', U)) throw new PbsUnreachableError('the Audit permission did not read back')
      for (const s of stores) if (!has(`/datastore/${s}`, VERIFY_ROLE, TID)) throw new PbsUnreachableError(`the ${s} permission did not read back`)
    })
    await step('read_with_the_new_token', async () => { await this.d.api({ url, tokenId: TID, secret, pin }).call('GET', '/status/datastore-usage') })
    // 5. Keep the token, and only the token.
    const meta = existing
      ? await this.d.store.write(existing.id, { name: existing.name, url, tokenId: TID, secret, staleHours: existing.staleHours, pin })
      : await this.d.store.create({ name, url, tokenId: TID, secret, staleHours, pin })
    this.forget(meta.id)
    await audit(existing ? 'done:token_replaced' : 'done', { server: meta.name, serverId: meta.id, token: TID, verify: allowVerify ? stores.length : 0, pin: pin.source })
    // 6. Only when ticked (off by default): the second, manage token, on every datastore, through the same sign-in.
    if (input.manage === true) {
      try {
        const all = ((await api.call('GET', '/admin/datastore')) as any[] ?? []).map(d => String(d?.store ?? d?.name ?? '')).filter(x => /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(x))
        return { ...(await this.manager.enable(meta.id, all, actor, { api })), allowVerify }
      } catch (e: any) {
        return { ...meta, allowVerify, manageError: `The server was added read-only, but backup management could not be turned on: ${String(e?.message ?? 'error').slice(0, 400)}` }
      }
    }
    return { ...meta, allowVerify }
  }

  /**
   * Change a server. A new address or token is proved again before it is stored (and a new address is pinned
   * afresh). `repin` reads the certificate again and pins what is presented now: the deliberate way to accept a
   * renewed certificate, admin and re-confirmed like every change here.
   */
  async update(id: string, input: PbsInput & { repin?: unknown; confirmFingerprint?: unknown }, actor: Actor): Promise<{ meta: PbsMeta; credentialChanged: boolean }> {
    this.limit(actor, 'addsPerMinute', 'Too many changes; wait a moment.')
    const plan = await this.d.store.planUpdate(id, input)
    let pin = plan.prev.pin
    if (plan.credentialChanged || input.repin === true || !pin) {
      const secret = plan.secret ?? (await this.d.store.connection(id))?.secret
      if (!secret) throw new PbsInputError('Paste the token secret again.')
      // A moved address is a new server: its certificate is confirmed afresh. Otherwise the pin stands.
      pin = await this.decidePin(plan.url, plan.moved ? null : plan.prev.pin, input.confirmFingerprint, input.repin === true)
      await this.prove(plan.url, plan.tokenId, secret, pin)
    }
    const meta = await this.d.store.write(id, { name: plan.name, url: plan.url, tokenId: plan.tokenId, secret: plan.secret, staleHours: plan.staleHours, pin })
    this.forget(id)
    return { meta, credentialChanged: plan.credentialChanged || input.repin === true }
  }

  private async meta(id: string): Promise<PbsMeta> {
    const m = await this.d.store.get(id)
    if (!m) throw new PbsRefusal('no_instance', 'No such backup server.', 404)
    return m
  }

  private async client(id: string): Promise<{ client: PbsClient; meta: PbsMeta }> {
    const c = await this.d.store.connection(id)
    if (!c) throw new PbsRefusal('not_configured', 'This backup server has no address or token yet.', 409)
    if (!c.meta.pin) throw new PbsRefusal('no_pin', 'This backup server has no pinned certificate; an admin saves it again to pin one.', 409)
    return { client: new PbsClient(this.d.api({ url: c.url, tokenId: c.tokenId, secret: c.secret, pin: c.meta.pin })), meta: c.meta }
  }

  async reading(id: string, o: { actor?: Actor; fresh?: boolean } = {}): Promise<PbsReading> {
    const m = await this.meta(id)
    if (o.actor) this.limit(o.actor, 'readsPerMinute')
    const hit = this.cache.get(id)
    const age = hit ? this.d.now() - hit.at : Infinity
    if (hit && age < (o.fresh ? 5_000 : CACHE_MS)) return hit.reading
    const running = this.inflight.get(id)
    if (running) return running
    const p = (async () => {
      const { client } = await this.client(id)
      try {
        const reading = await client.read(new Date(this.d.now()), m.staleHours)
        this.cache.set(id, { at: this.d.now(), reading })
        return reading
      } catch (e) { throw new PbsRefusal(e instanceof PbsUnreachableError ? e.code : 'read_failed', refusalWords(e), 502) }
    })()
    this.inflight.set(id, p)
    try { return await p } finally { this.inflight.delete(id) }
  }

  /** The snapshots of one group (read-only token), for picking which to delete: time, size, verify, protected. */
  async groupSnapshots(id: string, g: { store: string; ns: string; type: string; id: string }, actor: Actor): Promise<Array<{ time: number; size: number | null; verify: string; protected: boolean; comment: string | null }>> {
    this.limit(actor, 'readsPerMinute')
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(g.store) || !/^(vm|ct|host)$/.test(g.type) || !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(g.id) || !/^$|^[A-Za-z0-9_][A-Za-z0-9._/-]{0,255}$/.test(g.ns)) throw new PbsInputError('Not a datastore and group.')
    const c = await this.d.store.connection(id)
    if (!c?.meta.pin) throw new PbsRefusal('not_configured', 'This backup server has no address, token or pin.', 409)
    const rows = await this.d.api({ url: c.url, tokenId: c.tokenId, secret: c.secret, pin: c.meta.pin })
      .call('GET', `/admin/datastore/${encodeURIComponent(g.store)}/snapshots`, { 'backup-type': g.type, 'backup-id': g.id, ...(g.ns ? { ns: g.ns } : {}) })
      .catch(e => { throw new PbsRefusal('read_failed', refusalWords(e), 502) })
    return (Array.isArray(rows) ? rows : []).filter((s: any) => s?.['backup-type'] === g.type && s?.['backup-id'] === g.id && Number.isInteger(s?.['backup-time']))
      .map((s: any) => ({ time: s['backup-time'], size: typeof s.size === 'number' ? s.size : null, verify: String(s?.verification?.state ?? 'none').slice(0, 16), protected: s.protected === true, comment: typeof s.comment === 'string' ? s.comment.slice(0, 120) : null }))
      .sort((a, b) => b.time - a.time)
  }

  // ── actions ────────────────────────────────────────────────────────────────

  async auditRefusal(id: string, actor: Actor | null, action: string, code: string): Promise<void> {
    await this.d.audit('pbs.action', `pbs:${String(id).replace(/[^a-z0-9]/gi, '').slice(0, 20)}`, {
      by: actor?.email ?? 'anonymous', via: actor?.token ? `api:${actor.token}` : actor ? 'session' : 'none',
      action: String(action).replace(/[^a-z]/g, '').slice(0, 10), result: `refused:${code}`,
    })
  }

  async act(id: string, action: string, body: { store?: unknown }, actor: Actor): Promise<{ ok: true; message: string; action: PbsAction; upid: string; state: 'running' | 'ok' | 'failed' }> {
    let m: PbsMeta
    try { m = await this.meta(id) } catch (e: any) { await this.auditRefusal(id, actor, action, e?.code ?? 'error'); throw e }
    const store = typeof body.store === 'string' ? body.store.slice(0, 64) : ''
    const base = { by: actor.email, via: actor.token ? `api:${actor.token}` : 'session', server: m.name, serverId: m.id, action: action.slice(0, 10), store }
    const refuse = async (e: PbsRefusal): Promise<never> => {
      await this.d.audit('pbs.action', `pbs:${m.id}`, { ...base, result: `refused:${e.code}` })
      throw e
    }
    try { this.limit(actor, 'attemptsPerMinute', 'Too many attempts in a minute; wait a moment.') } catch (e: any) { return refuse(e) }
    if (action !== 'verify') return refuse(new PbsRefusal('action_not_allowed', 'HyperProx can start a verify. GC runs on its own schedule, and HyperProx never deletes, prunes or forgets a backup.'))
    if (actor.token) return refuse(new PbsRefusal('token_forbidden', 'API tokens can never start a verify or GC: it needs a person with the master password.', 403))
    if (!hasRole(actor.role, 'admin')) return refuse(new PbsRefusal('forbidden', `${ACTION_WORD[action]} now needs the admin role.`, 403))
    try { this.limit(actor, 'actionsPerMinute', 'That is the most actions allowed in a minute.') } catch (e: any) { return refuse(e) }
    // The datastore must be one the server reports now.
    let r: PbsReading
    try { r = await this.reading(m.id) } catch (e: any) { return refuse(new PbsRefusal('unreachable', e?.message ?? 'The backup server could not be read.', 502)) }
    if (!r.datastores.some(d => d.store === store)) return refuse(new PbsRefusal('bad_input', `${m.name} reports no datastore called "${store}".`, 404))

    const { client } = await this.client(m.id)
    let upid: string
    try { upid = await client.verify(store) }
    catch (e) {
      const msg = refusalWords(e, action, store)
      const code = e instanceof PbsHttpError && (e.status === 401 || e.status === 403) ? 'pbs_permission' : 'call_failed'
      await this.d.audit('pbs.action', `pbs:${m.id}`, { ...base, result: code === 'pbs_permission' ? 'refused:pbs_permission' : 'failed', reason: msg.slice(0, 200) })
      throw new PbsRefusal(code, msg, code === 'pbs_permission' ? 403 : 502)
    }
    if (!UPID_RE.test(upid)) {
      await this.d.audit('pbs.action', `pbs:${m.id}`, { ...base, result: 'unconfirmed' })
      throw new PbsRefusal('unconfirmed', `${m.name} did not return a task id, so HyperProx cannot tell whether ${ACTION_WORD[action].toLowerCase()} started. Check its task list.`, 502)
    }
    // Read after write: the task must exist on the server and be running or finished.
    await this.d.wait(1500)
    let state: 'running' | 'ok' | 'failed' = 'running'
    let exit: string | null = null
    try {
      const s = await client.taskStatus(upid)
      exit = s.exit
      state = s.running ? 'running' : s.exit === 'OK' || /^WARNINGS?:/i.test(s.exit ?? '') ? 'ok' : 'failed'
    } catch (e) {
      await this.d.audit('pbs.action', `pbs:${m.id}`, { ...base, upid, result: 'unconfirmed' })
      throw new PbsRefusal('unconfirmed', `${ACTION_WORD[action]} was accepted, but its task could not be read back (${refusalWords(e)}). Check the server's task list.`, 502)
    }
    this.forget(m.id)
    await this.d.audit('pbs.action', `pbs:${m.id}`, { ...base, upid, result: state === 'failed' ? 'failed' : 'done', exit })
    const what = `${ACTION_WORD[action]} of ${store} on ${m.name}`
    const message = state === 'running' ? `${what} is running. It can take a while on a large datastore; the job list shows its result.`
      : state === 'ok' ? `${what} finished: ${exit}.` : `${what} stopped with an error: ${exit}.`
    return { ok: true, message, action, upid, state }
  }
}
