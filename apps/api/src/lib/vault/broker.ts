// =============================================================================
//  HyperProx — Vault broker
//
//  The only code that talks to the bundled Vaultwarden. A session is one of two kinds:
//
//    fast  the default. Vaultwarden's API directly (./native.ts): sign-in in
//          about a second instead of ~20 s; items, edits and Sends the same way.
//    cli   the official Bitwarden CLI, one isolated data dir per session on tmpfs
//          under VAULT_SESSION_ROOT (default /dev/shm/hyperprox-vault/<sid>, mode
//          0700), deleted on sign-out or lock. Used when the fast path cannot be
//          (an Argon2id account, an answer it does not understand) or is turned
//          off with VAULT_FAST_SIGNIN=0.
//
//  Owner bootstrap (register, organization, TOTP) is direct API in both cases; see ./bw-crypto.ts.
//
//  Never logged or persisted: master passwords, keys, CLI session keys, decrypted items.
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
import { fastSignInEnabled, sessionRoot, vaultAdminToken, vaultCaCert, vaultPublicUrl, vaultUrl } from './config'
import { FastPathFailed, NativeSessionExpired, NativeVaultSession, NotMemberError, type DecryptedItem, type NativeSessionSnapshot } from './native'
import { snapshotChanged } from './snapshot'
import { GROUP_OPERATORS, GROUP_VIEWERS } from './bw-crypto'
import { VaultOwnerOnlyError, isOwnerOnlyRefusal, keyFingerprint, memberStatus, memberTypeFor, type GrantableRole, type VaultMember } from './members'
import { INVITE_TTL_MS } from '../users/invitations'
import { memberRoles, recordAgrees, resolveRole, roleFromMemberType as rolesFromType } from '../users/roles'

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

/** Where the broker reports which sign-in path ran and why it fell back. Messages never carry secrets. */
export interface VaultLogger { info(msg: string): void; warn(msg: string): void }
let log: VaultLogger = { info: () => undefined, warn: () => undefined }
export function setVaultLogger(l: VaultLogger): void { log = l }

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
  /**
   * Additive, optional: trash exactly one item of the HyperProx collection, by id (Settings → Secrets). Unlike
   * deleteSecret, another item that happens to share its name is left alone. Returns what was trashed.
   */
  deleteSecretById?(sid: string, id: string): Promise<{ id: string; name: string }>
  createSend(sid: string, text: string, opts?: { hours?: number; maxViews?: number; password?: string }): Promise<{ url: string; expiresAt: string }>
  /**
   * Additive, optional: the open sessions as JSON-serialisable data, for the keyholder's snapshot
   * (state.ts), and back after an API restart. Holds session keys: only ever kept in memory.
   */
  exportSessions?(): unknown
  importSessions?(data: unknown): Promise<void>

  // ---- People (Settings → Users, ./members.ts). Additive, optional: a broker without them has no Users page. ----
  /** The HyperProx organization's members, with the session's own rights. */
  members?(sid: string): Promise<VaultMember[]>
  /**
   * Invite an email with a role. The vault sends nothing; the caller hands out a link. An invitation the vault
   * still holds for that email (invited, never joined) is reused, with the new role, instead of refused.
   * A refusal because only the vault's owner may do it is a VaultOwnerOnlyError (members.ts).
   */
  inviteMember?(sid: string, email: string, role: GrantableRole): Promise<{ reused: boolean } | void>
  /** Confirm an accepted member whose key fingerprint the admin compared. */
  confirmMember?(sid: string, memberId: string, fingerprint: string): Promise<void>
  setMemberRole?(sid: string, memberId: string, role: GrantableRole): Promise<void>
  /**
   * A withdrawn or expired invitation: take that email's membership out of the organization, if it never became a
   * confirmed member. False when there was nothing to remove. VaultOwnerOnlyError as for inviteMember.
   */
  removePendingMember?(sid: string, email: string): Promise<boolean>
  /**
   * Take someone who joined (or was confirmed) out of the organization: they can no longer sign in. Never the
   * owner, never yourself. An operator's or admin's removal is the vault owner's (VaultOwnerOnlyError).
   */
  removeMember?(sid: string, memberId: string): Promise<{ email: string }>
  /**
   * The join page, step 1: register an invited email with its master password. No session involved.
   * `onRegistered` runs as soon as the account exists (before the sign-in that follows can fail), so a retry
   * skips registering; an account the vault says already exists counts as registered and the sign-in checks it.
   */
  registerInvitee?(email: string, masterPassword: string, opts?: { alreadyRegistered?: boolean; onRegistered?: () => void }): Promise<{ totpSecret: string; otpauthUri: string; fingerprint: string }>
  /** The join page, step 2: turn on two-step login with the first code. */
  confirmInviteeTotp?(email: string, masterPassword: string, code: string): Promise<void>
}

/** One vault session in the keyholder's snapshot. */
type SessionSnapshot =
  | { kind: 'fast'; sid: string; email: string; role: Role; userId: string; vault: NativeSessionSnapshot }
  | { kind: 'cli'; sid: string; email: string; role: Role; userId: string; dir: string; sessionKey: string; orgId: string; collectionId?: string }

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

/** The vault's "only Owners can ..." refusal of a people change, as the error the routes answer 403 with. */
async function ownerOnly<T>(p: Promise<T>): Promise<T> {
  try { return await p } catch (err) {
    if (err instanceof VaultHttpError && isOwnerOnlyRefusal(err.message)) throw new VaultOwnerOnlyError()
    throw err
  }
}

/** A vault membership type as a role, from the vault alone (lib/users/roles.ts; a 4 is at most a viewer). */
export function roleFromMemberType(type: number): Role {
  return rolesFromType(type)
}

/**
 * The role someone signs in with or is listed as: the vault's type decides; HyperProx's record only settles
 * whether a type 4 (Custom) is an operator (lib/users/roles.ts resolveRole). It never raises anyone.
 */
function memberRole(type: number, email: string, permissions?: unknown): Role {
  let recorded = null
  try { recorded = memberRoles().get(email) } catch { /* unreadable record: the vault alone */ }
  return resolveRole(type, recorded, { permissions })
}

/** Keep HyperProx's role record to what HyperProx made: an operator on a 3 or 4. Stores only that. */
function recordRole(email: string, role: GrantableRole): void {
  if (role === 'operator') memberRoles().set(email, role)
  else memberRoles().remove(email)
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

interface CliSession extends VaultSession {
  kind: 'cli'
  dir: string
  sessionKey: string
  orgId: string
  collectionId?: string
  queue: Promise<unknown>
  /** When this session last synced with the vault (ms); login counts. */
  syncedAt?: number
}

interface FastSession extends VaultSession {
  kind: 'fast'
  vault: NativeVaultSession
  queue: Promise<unknown>
}

type Session = CliSession | FastSession

function itemToSecret(it: any | DecryptedItem): SecretItem {
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

export class CliVaultBroker implements VaultBroker {
  private sessions = new Map<string, Session>()
  private pendingTotp = new Map<string, string>() // email -> secret, between bootstrap and confirm
  /** Emails whose fast sign-in failed after the vault accepted them: the CLI for the rest of this process. */
  private cliOnly = new Set<string>()
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
    // used), so the sign-in uses the next step, computed from the secret the
    // broker still holds for this one call. The key is derived before the server
    // sees the code, so aim at the current step or later.
    const now = totpStep()
    const used = [now - 1, now, now + 1].find(st => totpCode(secret, st) === code.trim()) ?? now
    let step = Math.max(used + 1, now)
    while (step > totpStep() + 1) await new Promise(r => setTimeout(r, 1000))
    step = Math.max(step, totpStep())
    const session = await this.openSession(e, masterPassword, totpCode(secret, step))
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
    const s = await this.openSession(normalizeEmail(email), masterPassword, (totp ?? '').trim())
    return { sid: s.sid, email: s.email, role: s.role, userId: s.userId }
  }

  /** Fast path first; the CLI when the fast path cannot run, or failed in a way that leaves the code unspent. */
  private async openSession(email: string, masterPassword: string, totp: string): Promise<Session> {
    if (totp && !/^\d{6}$/.test(totp)) throw new VaultAuthError('totp_invalid')
    if (fastSignInEnabled() && !this.cliOnly.has(email)) {
      const t0 = Date.now()
      try {
        const s = await this.fastSignIn(email, masterPassword, totp)
        log.info(`[vault] signed in via fast path in ${Date.now() - t0} ms`)
        return s
      } catch (err) {
        if (err instanceof VaultAuthError) throw err
        if (err instanceof FastPathFailed && totp) {
          // The vault has accepted this TOTP step and will refuse it again, so the CLI cannot retry it now.
          this.cliOnly.add(email)
          log.warn(`[vault] fast sign-in failed after the vault accepted the login (${err.message}); next attempt uses the CLI`)
          throw new VaultAuthError('totp_invalid', 'fast sign-in failed after login; sign in again with the next code')
        }
        log.warn(`[vault] fast sign-in not possible (${(err as Error).message}); using the CLI`)
      }
    }
    const t0 = Date.now()
    const s = await this.cliSignIn(email, masterPassword, totp)
    log.info(`[vault] signed in via CLI in ${Date.now() - t0} ms`)
    return s
  }

  private async fastSignIn(email: string, masterPassword: string, totp: string): Promise<FastSession> {
    let vault: NativeVaultSession
    try {
      vault = await NativeVaultSession.open(this.api(), email, masterPassword, totp)
    } catch (err) {
      if (err instanceof NotMemberError) throw new VaultAuthError('not_member')
      throw this.httpAuthError(err)
    }
    const role = memberRole(vault.memberType, email)
    if (role === 'owner' && !(await this.ownerHasTwoFactor(email))) {
      vault.close()
      throw new VaultAuthError('totp_required', 'two-step login must be enabled for the owner')
    }
    const s: FastSession = { kind: 'fast', sid: crypto.randomBytes(16).toString('hex'), email, role, userId: vault.userId, vault, queue: Promise.resolve() }
    this.sessions.set(s.sid, s)
    snapshotChanged()
    return s
  }

  /**
   * The owner holds every key: 2FA is mandatory for them, even if it was later
   * removed from the vault side (e.g. through the admin panel). Fails closed: when the vault's admin API cannot
   * answer, or does not know the account, the owner is not signed in. Only an install with no admin token at all
   * (one that predates it) cannot check, and is let through with a warning, as before.
   */
  private async ownerHasTwoFactor(email: string): Promise<boolean> {
    const admin = this.admin()
    if (!admin) { log.warn('[vault] VAULT_ADMIN_TOKEN is not set, so the owner\'s two-step login cannot be checked'); return true }
    let u: { twoFactorEnabled?: boolean } | null
    try { u = await admin.userByEmail(email) } catch (e: any) {
      log.warn(`[vault] could not check the owner's two-step login (${e?.message ?? e}); refusing the sign-in`)
      return false
    }
    return !!u && u.twoFactorEnabled === true
  }

  private async cliSignIn(email: string, masterPassword: string, totp: string): Promise<CliSession> {
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
    const role = memberRole(Number(org.type), email)

    if (role === 'owner' && !(await this.ownerHasTwoFactor(email))) {
      await runBw(['logout'], { dir })
      return fail(new VaultAuthError('totp_required', 'two-step login must be enabled for the owner'))
    }

    const cols = await runBw(['list', 'collections', '--organizationid', String(org.id)], { dir, session: sessionKey })
    let collectionId: string | undefined
    try { collectionId = (JSON.parse(cols.stdout) as any[]).find(c => c?.name === COLLECTION_NAME)?.id } catch { /* none visible */ }

    const s: CliSession = { kind: 'cli', sid, email, role, userId, dir, sessionKey, orgId: String(org.id), collectionId, queue: Promise.resolve(), syncedAt: Date.now() /* login syncs */ }
    this.sessions.set(sid, s)
    snapshotChanged()
    return s
  }

  /**
   * Serialises calls per session (the CLI's data file is not safe for concurrent
   * writers; a fast session's token refresh and sync cache are simpler serial).
   * A fast session the vault no longer accepts ends here, as a VaultSessionError.
   */
  private withSession<T>(sid: string, fn: (s: Session) => Promise<T>): Promise<T> {
    const s = SID_RE.test(sid) ? this.sessions.get(sid) : undefined
    if (!s) return Promise.reject(new VaultSessionError())
    const run = s.queue.then(async () => {
      if (!this.sessions.has(sid)) throw new VaultSessionError()
      try {
        return await fn(s)
      } catch (err) {
        if (err instanceof NativeSessionExpired) {
          this.sessions.delete(sid)
          snapshotChanged()
          if (s.kind === 'fast') s.vault.close()
          throw new VaultSessionError()
        }
        throw err
      }
    })
    s.queue = run.catch(() => undefined)
    return run
  }

  // ---- people (Settings → Users) ----------------------------------------------------

  /** Organization management runs on the fast session, which holds the organization key confirmation needs. */
  private withFast<T>(sid: string, fn: (v: NativeVaultSession, s: FastSession) => Promise<T>): Promise<T> {
    return this.withSession(sid, async s => {
      if (s.kind !== 'fast') throw new Error('Managing people needs the fast vault session. Sign out and sign in again, then retry.')
      return fn(s.vault, s)
    })
  }

  private async groupsFor(v: NativeVaultSession, role: GrantableRole): Promise<string[]> {
    if (role === 'admin') return []
    const want = role === 'operator' ? GROUP_OPERATORS : GROUP_VIEWERS
    const g = (await v.orgGroups()).find(x => x.name === want)
    if (!g) throw new Error(`the vault has no "${want}" group; the owner's setup did not finish`)
    return [g.id]
  }

  async members(sid: string): Promise<VaultMember[]> {
    return this.withFast(sid, async v => {
      const out: VaultMember[] = []
      const list = await v.orgMembers()
      for (const m of list) {
        const status = memberStatus(Number(m.status))
        const userId = m.userId ? String(m.userId) : null
        let fingerprint: string | null = null
        if (status === 'accepted' && userId) fingerprint = await v.userPublicKey(userId).then(keyFingerprint).catch(() => null)
        out.push({ id: String(m.id), userId, email: String(m.email ?? ''), name: m.name ? String(m.name) : null,
          role: memberRole(Number(m.type), String(m.email ?? ''), m.permissions), status, twoFactor: m.twoFactorEnabled === true, fingerprint })
      }
      // Records for people no longer in the organisation, or whose vault type no longer fits one, are dropped.
      try {
        const types = new Map(out.map((x, i) => [normalizeEmail(x.email), Number(list[i].type)]))
        memberRoles().retain((e, r) => types.has(e) && recordAgrees(types.get(e)!, r))
      } catch { /* the record is advisory; the listing stands */ }
      return out.sort((a, b) => a.email.localeCompare(b.email))
    })
  }

  async inviteMember(sid: string, email: string, role: GrantableRole): Promise<{ reused: boolean }> {
    const e = normalizeEmail(email)
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('a valid email address is required')
    return this.withFast(sid, async v => {
      const existing = (await v.orgMembers()).find(m => normalizeEmail(String(m.email ?? '')) === e)
      const type = memberTypeFor(role)
      if (existing) {
        // Invited before and never joined (a lost or expired link): the same membership, with the role asked for now.
        if (memberStatus(Number(existing.status)) !== 'invited') throw new Error(`${e} is already a member`)
        if (role !== 'operator') memberRoles().remove(e)
        if (Number(existing.type) !== type) await ownerOnly(v.orgEdit(String(existing.id), type, await this.groupsFor(v, role)))
        recordRole(e, role)
        return { reused: true }
      }
      if (role !== 'operator') memberRoles().remove(e)
      await ownerOnly(v.orgInvite(e, type, await this.groupsFor(v, role)))
      recordRole(e, role)
      return { reused: false }
    })
  }

  async removePendingMember(sid: string, email: string): Promise<boolean> {
    const e = normalizeEmail(email)
    return this.withFast(sid, async v => {
      const m = (await v.orgMembers()).find(x => normalizeEmail(String(x.email ?? '')) === e)
      if (!m) return false
      // A confirmed member is a real user now; the owner is never removed. Neither goes with an invitation.
      const status = memberStatus(Number(m.status))
      if (Number(m.type) === MEMBER_TYPE.Owner || (status !== 'invited' && status !== 'accepted')) return false
      await ownerOnly(v.orgRemove(String(m.id)))
      try { memberRoles().remove(e) } catch { /* nothing recorded */ }
      return true
    })
  }

  async removeMember(sid: string, memberId: string): Promise<{ email: string }> {
    return this.withFast(sid, async (v, s) => {
      const m = (await v.orgMembers()).find(x => String(x.id) === memberId)
      if (!m) throw new Error('no such member')
      if (Number(m.type) === MEMBER_TYPE.Owner) throw new Error('the owner cannot be removed')
      if (String(m.userId ?? '') === s.userId) throw new Error('you cannot remove yourself')
      const email = normalizeEmail(String(m.email ?? ''))
      await ownerOnly(v.orgRemove(memberId))
      try { memberRoles().remove(email) } catch { /* nothing recorded */ }
      return { email }
    })
  }

  async confirmMember(sid: string, memberId: string, fingerprint: string): Promise<void> {
    return this.withFast(sid, async v => {
      const m = (await v.orgMembers()).find(x => String(x.id) === memberId)
      if (!m) throw new Error('no such member')
      if (memberStatus(Number(m.status)) !== 'accepted') throw new Error('only a member who has joined and is waiting can be confirmed')
      if (m.twoFactorEnabled !== true) throw new Error('this person has not turned on two-step login yet; they finish it on the join page')
      await ownerOnly(v.orgConfirm(memberId, String(m.userId), fingerprint))
    })
  }

  async setMemberRole(sid: string, memberId: string, role: GrantableRole): Promise<void> {
    return this.withFast(sid, async (v, s) => {
      const m = (await v.orgMembers()).find(x => String(x.id) === memberId)
      if (!m) throw new Error('no such member')
      if (Number(m.type) === MEMBER_TYPE.Owner) throw new Error('the owner\'s role is not changed here')
      if (String(m.userId ?? '') === s.userId) throw new Error('you cannot change your own role')
      const email = normalizeEmail(String(m.email ?? ''))
      // Anything but operator: the record goes before the vault changes, so no old "operator" can outlive it.
      if (role !== 'operator') memberRoles().remove(email)
      await v.orgEdit(memberId, memberTypeFor(role), await this.groupsFor(v, role))
      if (role !== 'operator') return
      // Operator: recorded only if they are still a member of that type now (a removal can race the change).
      // Without the record a 4 reads as viewer, never higher, so a write that fails leaves them lower, not higher.
      const now = (await v.orgMembers()).find(x => String(x.id) === memberId && normalizeEmail(String(x.email ?? '')) === email)
      if (!now || !recordAgrees(Number(now.type), 'operator')) return
      try { memberRoles().set(email, 'operator') }
      catch (e: any) { throw new Error(`the vault made ${email} a Manager, but HyperProx could not record it, so they read as a viewer until it can: ${e?.message ?? e}`) }
    })
  }

  // email -> TOTP secret, between join steps 1 and 2. An entry lives no longer than the invitation it came from.
  private pendingInvitee = new Map<string, { secret: string; at: number }>()

  private pendingInviteeSecret(e: string): string | undefined {
    const now = Date.now()
    for (const [k, v] of this.pendingInvitee) if (now - v.at > INVITE_TTL_MS) this.pendingInvitee.delete(k)
    return this.pendingInvitee.get(e)?.secret
  }

  async registerInvitee(email: string, masterPassword: string, opts: { alreadyRegistered?: boolean; onRegistered?: () => void } = {}) {
    const e = normalizeEmail(email)
    if (masterPassword.length < 12) throw new Error('the master password must be at least 12 characters')
    const api = this.api()
    // Already registered (HyperProx restarted between the two steps, or the sign-in below failed last time):
    // the sign-in checks the password.
    if (!opts.alreadyRegistered) {
      try {
        await registerAccount(api, e, masterPassword)
      } catch (err) {
        if (!(err instanceof VaultHttpError && /already exists/i.test(err.message))) throw err
      }
      opts.onRegistered?.()
    }
    const mk = await makeMasterKey(masterPassword, e)
    const hash = await masterPasswordHash(mk, masterPassword)
    mk.fill(0)
    let token
    try { token = await api.passwordLogin(e, hash) } catch (err) { throw this.httpAuthError(err) }
    const keys = await api.api('GET', '/api/accounts/keys', token.accessToken)
    const pub = keys?.publicKey ?? keys?.PublicKey
    if (!pub) throw new Error('the new account has no public key')
    const secret = newTotpSecret()
    this.pendingInviteeSecret(e) // prunes stale entries
    this.pendingInvitee.set(e, { secret, at: Date.now() })
    return { totpSecret: secret, otpauthUri: otpauthUri(secret, e), fingerprint: keyFingerprint(Buffer.from(String(pub), 'base64')) }
  }

  async confirmInviteeTotp(email: string, masterPassword: string, code: string): Promise<void> {
    const e = normalizeEmail(email)
    const secret = this.pendingInviteeSecret(e)
    if (!secret) throw new BootstrapNotPendingError()
    if (!/^\d{6}$/.test(code.trim()) || !totpMatches(secret, code)) throw new VaultAuthError('totp_invalid')
    const api = this.api()
    const mk = await makeMasterKey(masterPassword, e)
    const hash = await masterPasswordHash(mk, masterPassword)
    mk.fill(0)
    let token
    try { token = await api.passwordLogin(e, hash) } catch (err) { throw this.httpAuthError(err) }
    await enableAuthenticator(api, token.accessToken, hash, secret, code.trim())
    this.pendingInvitee.delete(e)
  }

  async verifyPassword(sid: string, masterPassword: string): Promise<boolean> {
    return this.withSession(sid, async s => {
      if (s.kind === 'fast') return s.vault.verifyPassword(masterPassword)
      // Local check by the CLI against its stored key material; no server call, no TOTP.
      const r = await runBw(['unlock', '--passwordenv', 'BW_PASSWORD', '--raw'], { dir: s.dir, password: masterPassword })
      const key = r.stdout.trim()
      if (r.code !== 0 || !key) return false
      s.sessionKey = key // unlock re-wraps the local key; the new session key replaces the old one
      snapshotChanged()
      return true
    })
  }

  async signOut(sid: string): Promise<void> {
    const s = SID_RE.test(sid) ? this.sessions.get(sid) : undefined
    if (!s) return
    this.sessions.delete(sid)
    snapshotChanged()
    await s.queue.catch(() => undefined)
    if (s.kind === 'fast') { s.vault.close(); return }
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

  // ---- keyholder snapshot -------------------------------------------------

  exportSessions(): SessionSnapshot[] {
    const out: SessionSnapshot[] = []
    for (const s of this.sessions.values()) {
      const base = { sid: s.sid, email: s.email, role: s.role, userId: s.userId }
      if (s.kind === 'fast') out.push({ kind: 'fast', ...base, vault: s.vault.toSnapshot() })
      else out.push({ kind: 'cli', ...base, dir: s.dir, sessionKey: s.sessionKey, orgId: s.orgId, collectionId: s.collectionId })
    }
    return out
  }

  async importSessions(data: unknown): Promise<void> {
    if (!Array.isArray(data)) throw new Error('broker part is not a list')
    for (const s of this.sessions.values()) if (s.kind === 'fast') s.vault.close()
    this.sessions.clear()
    const root = path.resolve(sessionRoot())
    for (const d of data as SessionSnapshot[]) {
      if (!d || typeof d.sid !== 'string' || !SID_RE.test(d.sid)) continue
      const base = { sid: d.sid, email: String(d.email), role: d.role, userId: String(d.userId ?? ''), queue: Promise.resolve() as Promise<unknown> }
      if (d.kind === 'fast') {
        this.sessions.set(d.sid, { kind: 'fast', ...base, vault: NativeVaultSession.fromSnapshot(this.api(), d.vault) })
      } else if (d.kind === 'cli') {
        // The CLI's data dir is on tmpfs and outlives an API restart; a session without it is gone.
        const dir = path.resolve(String(d.dir))
        if (path.dirname(dir) !== root || !fs.existsSync(dir)) continue
        this.sessions.set(d.sid, { kind: 'cli', ...base, dir, sessionKey: String(d.sessionKey), orgId: String(d.orgId), collectionId: d.collectionId })
      }
    }
  }

  // ---- items --------------------------------------------------------------

  // A sync costs one CLI start (~3 s). Login has just synced, so the unlock and the first-unlock migration
  // right after it skip theirs; anything later syncs as before.
  private async sync(s: CliSession): Promise<void> {
    if (s.syncedAt && Date.now() - s.syncedAt < FRESH_SYNC_MS) return
    const r = await runBw(['sync'], { dir: s.dir, session: s.sessionKey })
    if (r.code !== 0) throw new Error(`vault sync failed: ${bwErrorMessage(r)}`)
    s.syncedAt = Date.now()
  }

  private async rawItems(s: CliSession): Promise<any[]> {
    if (!s.collectionId) return []
    const r = await runBw(['list', 'items', '--collectionid', s.collectionId], { dir: s.dir, session: s.sessionKey })
    if (r.code !== 0) throw new Error(`vault list failed: ${bwErrorMessage(r)}`)
    return (JSON.parse(r.stdout) as any[]).filter(it => it?.organizationId === s.orgId && !it?.deletedDate)
  }

  async listSecrets(sid: string): Promise<SecretItem[]> {
    return this.withSession(sid, async s => {
      if (s.kind === 'fast') return (await s.vault.listItems()).map(itemToSecret)
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
      if (s.kind === 'fast') return (await s.vault.upsertItems(items)).map(itemToSecret)
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

  private async writeItem(s: CliSession, existing: any, name: string, fields: Record<string, string>, notes?: string): Promise<SecretItem> {
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
      if (s.kind === 'fast') return s.vault.deleteItems(name)
      await this.sync(s)
      const matches = (await this.rawItems(s)).filter(it => it.name === name)
      for (const it of matches) {
        // Moves to the vault's trash (recoverable from a Bitwarden client), not a hard delete.
        const r = await runBw(['delete', 'item', String(it.id)], { dir: s.dir, session: s.sessionKey })
        if (r.code !== 0) throw new Error(`vault delete failed: ${bwErrorMessage(r)}`)
      }
    })
  }

  async deleteSecretById(sid: string, id: string): Promise<{ id: string; name: string }> {
    return this.withSession(sid, async s => {
      if (s.kind === 'fast') return s.vault.deleteItem(id)
      await this.sync(s)
      const it = (await this.rawItems(s)).find(x => String(x?.id) === id)
      if (!it) throw new Error('no such item in the HyperProx collection')
      // Moves to the vault's trash (recoverable from a Bitwarden client), not a hard delete.
      const r = await runBw(['delete', 'item', String(it.id)], { dir: s.dir, session: s.sessionKey })
      if (r.code !== 0) throw new Error(`vault delete failed: ${bwErrorMessage(r)}`)
      return { id, name: String(it.name ?? '') }
    })
  }

  async createSend(sid: string, text: string, opts: { hours?: number; maxViews?: number; password?: string } = {}) {
    const hours = opts.hours && opts.hours > 0 ? Math.min(opts.hours, 24 * 31) : 24
    const maxViews = opts.maxViews && opts.maxViews > 0 ? Math.floor(opts.maxViews) : 1
    return this.withSession(sid, async s => {
      const expires = new Date(Date.now() + hours * 3600_000).toISOString()
      if (s.kind === 'fast') {
        const r = await s.vault.createTextSend(text, { expires, maxViews, password: opts.password || undefined })
        // The link the CLI prints: <web vault>/#/send/<access id>/<seed>; the seed never reaches the server.
        return { url: `${vaultPublicUrl() ?? vaultUrl()}/#/send/${r.accessId}/${r.keyFragment}`, expiresAt: r.expirationDate }
      }
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
