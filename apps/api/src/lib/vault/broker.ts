// =============================================================================
//  HyperProx — Vault broker
//
//  The only code that talks to the bundled Vaultwarden. Everyday work (sign-in,
//  items, Sends) goes through the official Bitwarden CLI, so all vault
//  cryptography is Bitwarden's own; one isolated CLI data dir per signed-in
//  session lives on tmpfs under VAULT_SESSION_ROOT (default /dev/shm/hyperprox-vault/<sid>,
//  mode 0700) and is deleted on sign-out or lock. Owner bootstrap (register,
//  organization, TOTP) is the one thing the CLI cannot do; see ./bw-crypto.ts.
//
//  Never logged or persisted: master passwords, CLI session keys, decrypted items.
// =============================================================================

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  COLLECTION_NAME, MEMBER_TYPE, ORG_NAME,
  VaultHttpError, VaultwardenAdmin, VaultwardenApi,
  createOrganization, enableAuthenticator, ensureAccessGroups, makeMasterKey, masterPasswordHash,
  newTotpSecret, normalizeEmail, otpauthUri, registerAccount, totpCode, totpMatches, totpStep,
} from './bw-crypto'
import { bwErrorMessage, encodeJson, runBw } from './bw-cli'
import { sessionRoot, vaultAdminToken, vaultCaCert, vaultPublicUrl, vaultUrl } from './config'

// ---------------------------------------------------------------------------
//  Contract types
// ---------------------------------------------------------------------------

export type Role = 'owner' | 'admin' | 'operator' | 'viewer'
export interface VaultSession { sid: string; email: string; role: Role; userId: string }
export interface SecretItem {
  name: string
  fields: Record<string, string>
  notes?: string
  id: string
  /** Vault revision date (ISO). Additive to the contract, for the Secrets page. */
  revisionDate?: string
}

export type VaultAuthCode = 'bad_credentials' | 'totp_required' | 'totp_invalid' | 'not_member' | 'locked_out'

export class VaultAuthError extends Error {
  constructor(public code: VaultAuthCode, message?: string) {
    super(message ?? code)
    this.name = 'VaultAuthError'
  }
}

/** Thrown when a sid is unknown (signed out, locked, or never existed). Additive to the contract. */
export class VaultSessionError extends Error {
  constructor(message = 'vault session not found') { super(message); this.name = 'VaultSessionError' }
}

const FRESH_SYNC_MS = 30_000

/** confirmOwnerTotp with no bootstrap in memory: HyperProx restarted between the two steps, or it already finished. */
export class BootstrapNotPendingError extends Error {
  constructor() { super('no owner bootstrap in progress for this email; start again') }
}

export interface VaultBroker {
  status(): Promise<{ reachable: boolean; bootstrapped: boolean }>
  bootstrapOwner(email: string, masterPassword: string): Promise<{ totpSecret: string; otpauthUri: string }>
  /**
   * Enables TOTP for the owner and returns a signed-in session for them
   * (the contract said `void`; the gate needs a session, and the TOTP code the
   * user just typed cannot be replayed into a second login — Vaultwarden refuses
   * a code from a step it has already accepted — so the broker signs the owner in
   * itself with the next step's code while it still holds the new secret).
   */
  confirmOwnerTotp(email: string, masterPassword: string, code: string): Promise<VaultSession>
  signIn(email: string, masterPassword: string, totp: string): Promise<VaultSession>
  verifyPassword(sid: string, masterPassword: string): Promise<boolean>
  signOut(sid: string): Promise<void>
  /** Signs out every session and removes every CLI data dir (used by lock). Additive. */
  signOutAll(): Promise<void>
  listSecrets(sid: string): Promise<SecretItem[]>
  /** Several upserts in one session turn: one sync and one listing for the batch, not one per item. Additive. */
  upsertSecrets(sid: string, items: Array<{ name: string; fields: Record<string, string>; notes?: string }>): Promise<SecretItem[]>
  upsertSecret(sid: string, name: string, fields: Record<string, string>, notes?: string): Promise<SecretItem>
  deleteSecret(sid: string, name: string): Promise<void>
  createSend(sid: string, text: string, opts?: { hours?: number; maxViews?: number; password?: string }): Promise<{ url: string; expiresAt: string }>
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

export function roleFromMemberType(type: number): Role {
  switch (type) {
    case MEMBER_TYPE.Owner: return 'owner'
    case MEMBER_TYPE.Admin: return 'admin'
    case MEMBER_TYPE.Manager: return 'operator'
    default: return 'viewer' // User, Custom, anything unknown
  }
}

/** Maps a CLI / server message to a contract error code; null if it is not an auth failure. */
export function authCodeFromMessage(msg: string): VaultAuthCode | null {
  const m = msg.toLowerCase()
  if (/too many|rate.?limit|429/.test(m)) return 'locked_out'
  if (/has been disabled|account is disabled|user is disabled/.test(m)) return 'locked_out'
  if (/username or password is incorrect|invalid_grant.*password|password is incorrect/.test(m)) return 'bad_credentials'
  if (/invalid totp|totp code is not|two.?step token is invalid|invalid.*(code|token)|code.*invalid/.test(m)) return 'totp_invalid'
  if (/two.?step|two.?factor|2fa|code is required|verification code/.test(m)) return 'totp_required'
  return null
}

const SID_RE = /^[a-f0-9]{32}$/

interface Session extends VaultSession {
  dir: string
  sessionKey: string
  orgId: string
  collectionId?: string
  queue: Promise<unknown>
  /** When this session last synced with the vault (ms); login counts. */
  syncedAt?: number
}

function itemToSecret(it: any): SecretItem {
  const fields: Record<string, string> = {}
  if (it?.login) {
    if (it.login.username) fields.username = String(it.login.username)
    if (it.login.password) fields.password = String(it.login.password)
  }
  for (const f of it?.fields ?? []) {
    if (f?.name) fields[String(f.name)] = f.value == null ? '' : String(f.value)
  }
  return {
    id: String(it.id),
    name: String(it.name ?? ''),
    fields,
    ...(it.notes ? { notes: String(it.notes) } : {}),
    ...(it.revisionDate ? { revisionDate: String(it.revisionDate) } : {}),
  }
}

// ---------------------------------------------------------------------------
//  Implementation
// ---------------------------------------------------------------------------

class CliVaultBroker implements VaultBroker {
  private sessions = new Map<string, Session>()
  private pendingTotp = new Map<string, string>() // email -> secret, between bootstrap and confirm
  private bootstrappedKnown = false
  private adminClient: VaultwardenAdmin | null = null
  private adminKey = ''

  private api(): VaultwardenApi {
    return new VaultwardenApi(vaultUrl(), vaultCaCert())
  }

  private admin(): VaultwardenAdmin | null {
    const token = vaultAdminToken()
    if (!token) return null
    const key = `${vaultUrl()}\n${crypto.createHash('sha256').update(token).digest('hex')}`
    if (!this.adminClient || this.adminKey !== key) {
      this.adminClient = new VaultwardenAdmin(vaultUrl(), token, vaultCaCert())
      this.adminKey = key
    }
    return this.adminClient
  }

  private static hyperproxOwner(users: any[]): any | undefined {
    return users.find(u => (u.organizations ?? []).some((o: any) => o?.name === ORG_NAME && Number(o?.type) === MEMBER_TYPE.Owner))
  }

  // ---- status -------------------------------------------------------------

  async status() {
    const reachable = await this.api().alive()
    if (!reachable) return { reachable, bootstrapped: this.bootstrappedKnown }
    if (this.bootstrappedKnown) return { reachable, bootstrapped: true }
    const admin = this.admin()
    // Without the admin token nothing can be bootstrapped anyway: show sign-in.
    if (!admin) return { reachable, bootstrapped: true }
    try {
      const owner = CliVaultBroker.hyperproxOwner(await admin.users())
      // Bootstrapped only once the owner has 2FA; a half-finished bootstrap can be resumed.
      this.bootstrappedKnown = !!(owner && owner.twoFactorEnabled)
      return { reachable, bootstrapped: this.bootstrappedKnown }
    } catch {
      // Admin API unavailable (e.g. rate-limited): fail towards the sign-in page,
      // never towards an open bootstrap form. bootstrapOwner re-checks for itself.
      return { reachable, bootstrapped: true }
    }
  }

  // ---- bootstrap ----------------------------------------------------------

  async bootstrapOwner(email: string, masterPassword: string) {
    const e = normalizeEmail(email)
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('a valid email address is required')
    if (masterPassword.length < 12) throw new Error('the master password must be at least 12 characters')
    const admin = this.admin()
    if (!admin) throw new Error('VAULT_ADMIN_TOKEN is not set; the owner account cannot be created')
    const api = this.api()

    const users = await admin.users()
    const owner = CliVaultBroker.hyperproxOwner(users)
    if (owner?.twoFactorEnabled) { this.bootstrappedKnown = true; throw new Error('the vault already has a HyperProx owner') }
    if (owner && normalizeEmail(owner.email) !== e) throw new Error('another account has a bootstrap in progress; finish it with that email')

    const existing = users.find(u => normalizeEmail(String(u.email ?? '')) === e)
    if (!existing) {
      await admin.invite(e)
      await registerAccount(api, e, masterPassword)
    } else if (Number(existing._status) === 1) {
      await registerAccount(api, e, masterPassword) // invited, never registered
    }

    const mk = await makeMasterKey(masterPassword, e)
    const hash = await masterPasswordHash(mk, masterPassword)
    mk.fill(0)
    let token
    try {
      token = await api.passwordLogin(e, hash)
    } catch (err) {
      throw this.httpAuthError(err)
    }
    let orgId = owner ? String((owner.organizations ?? []).find((o: any) => o?.name === ORG_NAME)?.id ?? '') : ''
    if (!owner) orgId = await createOrganization(api, token.accessToken, e)
    if (!orgId) throw new Error('could not determine the HyperProx organization id')
    await ensureAccessGroups(api, token.accessToken, orgId)

    const secret = newTotpSecret()
    this.pendingTotp.set(e, secret)
    return { totpSecret: secret, otpauthUri: otpauthUri(secret, e) }
  }

  async confirmOwnerTotp(email: string, masterPassword: string, code: string): Promise<VaultSession> {
    const e = normalizeEmail(email)
    const secret = this.pendingTotp.get(e)
    if (!secret) throw new BootstrapNotPendingError()
    if (!/^\d{6}$/.test(code.trim()) || !totpMatches(secret, code)) throw new VaultAuthError('totp_invalid')

    const api = this.api()
    const mk = await makeMasterKey(masterPassword, e)
    const hash = await masterPasswordHash(mk, masterPassword)
    mk.fill(0)
    let token
    try { token = await api.passwordLogin(e, hash) } catch (err) { throw this.httpAuthError(err) }

    try {
      await enableAuthenticator(api, token.accessToken, hash, secret, code.trim())
    } catch (err) {
      const a = this.httpAuthError(err)
      throw a instanceof VaultAuthError ? a : new VaultAuthError('totp_invalid', (err as Error).message)
    }
    this.pendingTotp.delete(e)
    this.bootstrappedKnown = true

    // The user's code is now spent (Vaultwarden refuses any step <= the last one
    // used), so the CLI login uses the next step, computed from the secret the
    // broker still holds for this one call. The CLI derives its key before it
    // talks to the server, so aim at the current step or later.
    const now = totpStep()
    const used = [now - 1, now, now + 1].find(st => totpCode(secret, st) === code.trim()) ?? now
    let step = Math.max(used + 1, now)
    while (step > totpStep() + 1) await new Promise(r => setTimeout(r, 1000))
    step = Math.max(step, totpStep())
    const session = await this.cliSignIn(e, masterPassword, totpCode(secret, step))
    if (session.role !== 'owner') { await this.signOut(session.sid); throw new VaultAuthError('not_member') }
    return { sid: session.sid, email: session.email, role: session.role, userId: session.userId }
  }

  private httpAuthError(err: unknown): Error {
    if (err instanceof VaultHttpError) {
      if (err.status === 429) return new VaultAuthError('locked_out')
      const body = err.body
      if (body && typeof body === 'object' && (body.TwoFactorProviders || body.TwoFactorProviders2)) return new VaultAuthError('totp_required')
      const code = authCodeFromMessage(err.message)
      if (code) return new VaultAuthError(code)
    }
    return err as Error
  }

  // ---- sign-in ------------------------------------------------------------

  async signIn(email: string, masterPassword: string, totp: string): Promise<VaultSession> {
    const s = await this.cliSignIn(normalizeEmail(email), masterPassword, (totp ?? '').trim())
    return { sid: s.sid, email: s.email, role: s.role, userId: s.userId }
  }

  private async cliSignIn(email: string, masterPassword: string, totp: string): Promise<Session> {
    if (totp && !/^\d{6}$/.test(totp)) throw new VaultAuthError('totp_invalid')
    const sid = crypto.randomBytes(16).toString('hex')
    const root = sessionRoot()
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    fs.chmodSync(root, 0o700)
    const dir = path.join(root, sid)
    fs.mkdirSync(dir, { mode: 0o700 })

    const fail = async (err: Error): Promise<never> => {
      fs.rmSync(dir, { recursive: true, force: true })
      throw err
    }

    const cfg = await runBw(['config', 'server', vaultUrl()], { dir })
    if (cfg.code !== 0) return fail(new Error(`vault CLI config failed: ${bwErrorMessage(cfg)}`))

    // --code on argv is unavoidable (no env/stdin form); it is a single-use 6-digit code.
    const args = ['login', email, '--passwordenv', 'BW_PASSWORD', '--raw']
    if (totp) args.push('--method', '0', '--code', totp)
    const login = await runBw(args, { dir, password: masterPassword })
    const sessionKey = login.stdout.trim()
    if (login.code !== 0 || !sessionKey) {
      const msg = bwErrorMessage(login)
      return fail(new VaultAuthError(authCodeFromMessage(msg) ?? (totp ? 'totp_invalid' : 'totp_required'), msg))
    }

    // Every `bw` call is a new CLI process (~3 s to start), so the user id comes from the CLI's own state file
    // when it is there (pinned CLI version), and from `bw status` only as a fallback.
    let userId = ''
    try { userId = String(JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8')).global_account_activeAccountId ?? '') } catch { /* fallback */ }
    if (!userId) {
      const st = await runBw(['status'], { dir, session: sessionKey })
      try { userId = String(JSON.parse(st.stdout).userId ?? '') } catch { /* below */ }
    }
    if (!userId) return fail(new Error('vault CLI status unreadable after login'))

    const orgs = await runBw(['list', 'organizations'], { dir, session: sessionKey })
    let org: any
    try { org = (JSON.parse(orgs.stdout) as any[]).find(o => o?.name === ORG_NAME && o?.enabled !== false) } catch { /* below */ }
    if (!org) {
      await runBw(['logout'], { dir })
      return fail(new VaultAuthError('not_member'))
    }
    const role = roleFromMemberType(Number(org.type))

    // The owner holds every key: 2FA is mandatory for them, even if it was later
    // removed from the vault side (e.g. through the admin panel).
    if (role === 'owner') {
      const admin = this.admin()
      if (admin) {
        const u = await admin.userByEmail(email).catch(() => null)
        if (u && !u.twoFactorEnabled) {
          await runBw(['logout'], { dir })
          return fail(new VaultAuthError('totp_required', 'two-step login must be enabled for the owner'))
        }
      }
    }

    const cols = await runBw(['list', 'collections', '--organizationid', String(org.id)], { dir, session: sessionKey })
    let collectionId: string | undefined
    try { collectionId = (JSON.parse(cols.stdout) as any[]).find(c => c?.name === COLLECTION_NAME)?.id } catch { /* none visible */ }

    const s: Session = { sid, email, role, userId, dir, sessionKey, orgId: String(org.id), collectionId, queue: Promise.resolve(), syncedAt: Date.now() /* login syncs */ }
    this.sessions.set(sid, s)
    return s
  }

  /** Serialises CLI calls per session (the CLI's data file is not safe for concurrent writers). */
  private withSession<T>(sid: string, fn: (s: Session) => Promise<T>): Promise<T> {
    const s = SID_RE.test(sid) ? this.sessions.get(sid) : undefined
    if (!s) return Promise.reject(new VaultSessionError())
    const run = s.queue.then(() => {
      if (!this.sessions.has(sid)) throw new VaultSessionError()
      return fn(s)
    })
    s.queue = run.catch(() => undefined)
    return run
  }

  async verifyPassword(sid: string, masterPassword: string): Promise<boolean> {
    return this.withSession(sid, async s => {
      // Local check by the CLI against its stored key material; no server call, no TOTP.
      const r = await runBw(['unlock', '--passwordenv', 'BW_PASSWORD', '--raw'], { dir: s.dir, password: masterPassword })
      const key = r.stdout.trim()
      if (r.code !== 0 || !key) return false
      s.sessionKey = key // unlock re-wraps the local key; the new session key replaces the old one
      return true
    })
  }

  async signOut(sid: string): Promise<void> {
    const s = SID_RE.test(sid) ? this.sessions.get(sid) : undefined
    if (!s) return
    this.sessions.delete(sid)
    await s.queue.catch(() => undefined)
    await runBw(['logout'], { dir: s.dir, timeoutMs: 15_000 }).catch(() => undefined)
    fs.rmSync(s.dir, { recursive: true, force: true })
    s.sessionKey = ''
  }

  async signOutAll(): Promise<void> {
    const sids = [...this.sessions.keys()]
    await Promise.all(sids.map(sid => this.signOut(sid)))
    // Also anything left over from a previous process (restart = locked).
    const root = sessionRoot()
    if (fs.existsSync(root)) {
      for (const name of fs.readdirSync(root)) fs.rmSync(path.join(root, name), { recursive: true, force: true })
    }
  }

  // ---- items --------------------------------------------------------------

  // A sync costs one CLI start (~3 s). Login has just synced, so the unlock and the first-unlock migration
  // right after it skip theirs; anything later syncs as before.
  private async sync(s: Session): Promise<void> {
    if (s.syncedAt && Date.now() - s.syncedAt < FRESH_SYNC_MS) return
    const r = await runBw(['sync'], { dir: s.dir, session: s.sessionKey })
    if (r.code !== 0) throw new Error(`vault sync failed: ${bwErrorMessage(r)}`)
    s.syncedAt = Date.now()
  }

  private async rawItems(s: Session): Promise<any[]> {
    if (!s.collectionId) return []
    const r = await runBw(['list', 'items', '--collectionid', s.collectionId], { dir: s.dir, session: s.sessionKey })
    if (r.code !== 0) throw new Error(`vault list failed: ${bwErrorMessage(r)}`)
    return (JSON.parse(r.stdout) as any[]).filter(it => it?.organizationId === s.orgId && !it?.deletedDate)
  }

  async listSecrets(sid: string): Promise<SecretItem[]> {
    return this.withSession(sid, async s => {
      await this.sync(s)
      return (await this.rawItems(s)).map(itemToSecret)
    })
  }

  async upsertSecret(sid: string, name: string, fields: Record<string, string>, notes?: string): Promise<SecretItem> {
    return (await this.upsertSecrets(sid, [{ name, fields, notes }]))[0]
  }

  // Each `bw` call is a fresh CLI process that refreshes its token (~3 s), so a sync and a listing per item
  // made the 18-item first-unlock migration take minutes. A batch syncs and lists once.
  async upsertSecrets(sid: string, items: Array<{ name: string; fields: Record<string, string>; notes?: string }>): Promise<SecretItem[]> {
    if (items.some(i => !i.name)) throw new Error('secret name is required')
    return this.withSession(sid, async s => {
      if (!s.collectionId) throw new Error(`collection "${COLLECTION_NAME}" is not visible to this account`)
      await this.sync(s)
      const current = await this.rawItems(s)
      const out: SecretItem[] = []
      // After a write the next listing syncs, so a read-back checks the server, not the CLI cache.
      s.syncedAt = 0
      for (const { name, fields, notes } of items) out.push(await this.writeItem(s, current.find(it => it.name === name), name, fields, notes))
      return out
    })
  }

  private async writeItem(s: Session, existing: any, name: string, fields: Record<string, string>, notes?: string): Promise<SecretItem> {
      const customFields = Object.entries(fields).map(([k, v]) => ({ name: k, value: String(v ?? ''), type: 1, linkedId: null }))
      let r
      if (existing) {
        const updated = { ...existing, fields: customFields, notes: notes ?? existing.notes ?? null }
        r = await runBw(['edit', 'item', String(existing.id)], { dir: s.dir, session: s.sessionKey, stdin: encodeJson(updated) })
      } else {
        const item = {
          organizationId: s.orgId,
          collectionIds: [s.collectionId],
          folderId: null,
          type: 2,
          name,
          notes: notes ?? null,
          favorite: false,
          reprompt: 0,
          secureNote: { type: 0 },
          fields: customFields,
        }
        r = await runBw(['create', 'item'], { dir: s.dir, session: s.sessionKey, stdin: encodeJson(item) })
      }
      if (r.code !== 0) throw new Error(`vault write failed: ${bwErrorMessage(r)}`)
      return itemToSecret(JSON.parse(r.stdout))
  }

  async deleteSecret(sid: string, name: string): Promise<void> {
    return this.withSession(sid, async s => {
      await this.sync(s)
      const matches = (await this.rawItems(s)).filter(it => it.name === name)
      for (const it of matches) {
        // Moves to the vault's trash (recoverable from a Bitwarden client), not a hard delete.
        const r = await runBw(['delete', 'item', String(it.id)], { dir: s.dir, session: s.sessionKey })
        if (r.code !== 0) throw new Error(`vault delete failed: ${bwErrorMessage(r)}`)
      }
    })
  }

  async createSend(sid: string, text: string, opts: { hours?: number; maxViews?: number; password?: string } = {}) {
    const hours = opts.hours && opts.hours > 0 ? Math.min(opts.hours, 24 * 31) : 24
    const maxViews = opts.maxViews && opts.maxViews > 0 ? Math.floor(opts.maxViews) : 1
    return this.withSession(sid, async s => {
      const expires = new Date(Date.now() + hours * 3600_000).toISOString()
      const send = {
        name: 'HyperProx',
        notes: null,
        type: 0,
        text: { text, hidden: true },
        file: null,
        maxAccessCount: maxViews,
        deletionDate: expires,
        expirationDate: expires,
        password: opts.password || null, // stdin JSON; the CLI hashes it before upload
        emails: null,
        disabled: false,
        hideEmail: true,
      }
      const r = await runBw(['send', 'create'], { dir: s.dir, session: s.sessionKey, stdin: encodeJson(send) })
      if (r.code !== 0) throw new Error(`vault send failed: ${bwErrorMessage(r)}`)
      const out = JSON.parse(r.stdout)
      let url = String(out.accessUrl ?? '')
      if (!url) throw new Error('vault send returned no link')
      const pub = vaultPublicUrl()
      if (pub) {
        const u = new URL(url)
        url = `${pub}${u.pathname === '/' ? '/' : u.pathname}${u.search}${u.hash}`
      }
      return { url, expiresAt: String(out.expirationDate ?? expires) }
    })
  }
}

let broker: VaultBroker | null = null

export function getBroker(): VaultBroker {
  if (!broker) broker = new CliVaultBroker()
  return broker
}

/** Replaces the shared broker (tests swap a fake in). */
export function setBroker(b: VaultBroker): void {
  broker = b
}
