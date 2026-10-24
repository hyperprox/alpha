// =============================================================================
//  HyperProx — Vault fast path (Vaultwarden API directly, no CLI)
//
//  Through the Bitwarden CLI a sign-in took ~20 s: each `bw` call is a new
//  process that needs ~3 s to start, and a sign-in needs five of them. This
//  makes the same calls the CLI makes (prelogin, identity token, sync) and does
//  the same client-side cryptography (./bw-crypto.ts), so a sign-in is one KDF
//  and three HTTP requests. Items, edits, trash and Sends go the same way.
//
//  The vault's data is unchanged: what this writes is what a Bitwarden client
//  writes (organization ciphers, Sends), and it reads what any client wrote,
//  per-item cipher keys included.
//
//  PBKDF2 accounts only (HyperProx registers PBKDF2). Argon2id needs a library
//  Node 20 does not ship, so such an account raises FastPathUnavailable before
//  any credential is sent, and the broker signs it in through the CLI.
//
//  Per session, in memory only, never logged or persisted: the user key, the
//  organization key, the access and refresh tokens, and the local password
//  check value. close() zeroes the key buffers.
// =============================================================================

import crypto from 'node:crypto'
import {
  COLLECTION_NAME, KDF_PBKDF2, ORG_NAME,
  VaultHttpError, VaultwardenApi,
  base64Url, decRsaEncString, decString2, encString2, localPasswordHash, makeMasterKeyFor, masterPasswordHash,
  sendKeyFromSeed, sendPasswordHash, stretchMasterKey, symKeyFromBytes,
  type IdentityToken, type KdfConfig, type SymKey,
} from './bw-crypto'

const FRESH_SYNC_MS = 30_000
const DEVICE_NAME = 'hyperprox'
/** What `bw list items` prints for an item it cannot decrypt. */
const CANNOT_DECRYPT = '[error: cannot decrypt]'

/** The fast path cannot be used; nothing has been sent to the server yet, so the CLI can try. */
export class FastPathUnavailable extends Error {
  constructor(message: string) { super(message); this.name = 'FastPathUnavailable' }
}

/**
 * The vault accepted the credentials but the session could not be built (a key
 * or item this code cannot read). A TOTP code is spent at this point.
 */
export class FastPathFailed extends Error {
  constructor(message: string) { super(message); this.name = 'FastPathFailed' }
}

/** The account signed in but is not an enabled member of the HyperProx organization. */
export class NotMemberError extends Error {
  constructor() { super('not a member of the HyperProx organization'); this.name = 'NotMemberError' }
}

/** The vault no longer accepts this session's refresh token (signed out elsewhere, revoked). */
export class NativeSessionExpired extends Error {
  constructor() { super('vault session expired'); this.name = 'NativeSessionExpired' }
}

/** A decrypted item in the shape `bw list items` prints, so the broker maps both paths the same way. */
export interface DecryptedItem {
  id: string
  name: string
  notes?: string | null
  login?: { username?: string | null; password?: string | null }
  fields?: Array<{ name: string; value: string | null }>
  revisionDate?: string
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

function zero(k: SymKey | null | undefined): void {
  if (!k) return
  k.enc.fill(0); k.mac.fill(0)
}

export class NativeVaultSession {
  private cache: { at: number; ciphers: any[] } | null = null
  private closed = false

  private constructor(
    private api: VaultwardenApi,
    readonly email: string,
    readonly userId: string,
    readonly orgId: string,
    /** Organization membership type (Owner 0, Admin 1, User 2, Manager 3, Custom 4). */
    readonly memberType: number,
    readonly collectionId: string | undefined,
    private kdf: KdfConfig,
    private localHash: Buffer,
    private userKey: SymKey,
    private orgKey: SymKey,
    private accessToken: string,
    private refreshToken: string | undefined,
    private expiresAt: number,
    ciphers: any[],
  ) {
    this.cache = { at: Date.now(), ciphers }
  }

  /**
   * Signs in: prelogin → master key → identity token (with the TOTP code, if any)
   * → sync → user key → private key → organization key. Auth failures surface
   * as the VaultHttpError from the token call, for the broker to map.
   */
  static async open(api: VaultwardenApi, email: string, password: string, totp: string): Promise<NativeVaultSession> {
    let kdf: KdfConfig
    try { kdf = await api.prelogin(email) }
    catch (e) { throw new FastPathUnavailable(`prelogin failed: ${(e as Error).message}`) }
    if (kdf.kdf !== KDF_PBKDF2) throw new FastPathUnavailable(`account uses KDF type ${kdf.kdf} (Argon2id); only PBKDF2 is built in`)

    let masterKey: Buffer
    try { masterKey = await makeMasterKeyFor(password, email, kdf) }
    catch (e) { throw new FastPathUnavailable((e as Error).message) }

    let token: IdentityToken
    let localHash: Buffer
    try {
      const hash = await masterPasswordHash(masterKey, password)
      localHash = await localPasswordHash(masterKey, password)
      try {
        token = await api.passwordLogin(email, hash, totp || undefined, DEVICE_NAME)
      } catch (e) {
        // A 4xx is the vault's verdict on the credentials; anything else (5xx, network) is not, and the CLI may fare better.
        if (e instanceof VaultHttpError && e.status >= 400 && e.status < 500) throw e
        throw new FastPathUnavailable(`identity request failed: ${(e as Error).message}`)
      }
    } catch (e) {
      masterKey.fill(0)
      throw e
    }

    // From here on the credentials (and a TOTP code) are spent.
    let userKey: SymKey | null = null
    let orgKey: SymKey | null = null
    let privateDer: Buffer | null = null
    try {
      if (!str(token.key)) throw new Error('identity answer has no user key')
      const stretched = stretchMasterKey(masterKey)
      try { userKey = symKeyFromBytes(decString2(token.key, stretched)) }
      finally { zero(stretched); masterKey.fill(0) }

      const sync = await api.api('GET', '/api/sync?excludeDomains=true', token.accessToken)
      const profile = sync?.profile ?? {}
      const org = (profile.organizations ?? []).find((o: any) => o?.name === ORG_NAME && o?.enabled !== false)
      if (!org) throw new NotMemberError()
      const wrappedPrivate = str(token.privateKey) ?? str(profile.privateKey)
      if (!wrappedPrivate) throw new Error('account has no private key')
      if (!str(org.key)) throw new Error('organization key missing from sync')
      privateDer = decString2(wrappedPrivate, userKey)
      orgKey = symKeyFromBytes(decRsaEncString(org.key, privateDer))

      const orgId = String(org.id)
      const ok = orgKey
      const collectionId = (sync.collections ?? []).find((c: any) => {
        if (String(c?.organizationId) !== orgId || !str(c?.name)) return false
        try { return decString2(c.name, ok).toString('utf8') === COLLECTION_NAME } catch { return false }
      })?.id

      const session = new NativeVaultSession(
        api, email, String(profile.id ?? ''), orgId, Number(org.type), collectionId ? String(collectionId) : undefined,
        kdf, localHash, userKey, orgKey, token.accessToken, token.refreshToken,
        Date.now() + (token.expiresIn ?? 3600) * 1000, Array.isArray(sync.ciphers) ? sync.ciphers : [],
      )
      if (!session.userId) throw new Error('sync answer has no user id')
      return session
    } catch (e) {
      masterKey.fill(0); zero(userKey); zero(orgKey); localHash.fill(0)
      if (e instanceof NotMemberError) throw e
      throw new FastPathFailed((e as Error).message)
    } finally {
      privateDer?.fill(0)
    }
  }

  // ---- transport ----------------------------------------------------------

  private async refresh(): Promise<void> {
    if (!this.refreshToken) throw new NativeSessionExpired()
    let t: IdentityToken
    try { t = await this.api.refreshLogin(this.refreshToken) }
    catch (e) {
      if (e instanceof VaultHttpError && e.status >= 400 && e.status < 500) throw new NativeSessionExpired()
      throw e
    }
    this.accessToken = t.accessToken
    if (t.refreshToken) this.refreshToken = t.refreshToken
    this.expiresAt = Date.now() + (t.expiresIn ?? 3600) * 1000
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    if (this.closed) throw new NativeSessionExpired()
    if (Date.now() > this.expiresAt - 60_000) await this.refresh()
    try {
      return await this.api.api(method, path, this.accessToken, body)
    } catch (e) {
      if (!(e instanceof VaultHttpError) || e.status !== 401) throw e
      await this.refresh()
      return this.api.api(method, path, this.accessToken, body)
    }
  }

  // ---- crypto helpers -----------------------------------------------------

  /** The key an item's strings are encrypted with: its own cipher key if it has one, else the org key. */
  private itemKey(cipher: any): SymKey {
    return str(cipher?.key) ? symKeyFromBytes(decString2(cipher.key, this.orgKey)) : this.orgKey
  }

  private static dec(v: unknown, key: SymKey): string | null {
    return str(v) ? decString2(v as string, key).toString('utf8') : null
  }

  private static enc(v: string, key: SymKey): string {
    return encString2(Buffer.from(v, 'utf8'), key)
  }

  /** Decrypts one item; one that cannot be read shows as the CLI shows it instead of failing the listing. */
  private decrypt(c: any): DecryptedItem {
    let key: SymKey
    try { key = this.itemKey(c) } catch { return { id: String(c?.id), name: CANNOT_DECRYPT, fields: [] } }
    try {
      const D = (v: unknown) => NativeVaultSession.dec(v, key)
      return {
        id: String(c.id),
        name: D(c.name) ?? '',
        notes: D(c.notes),
        ...(c.login ? { login: { username: D(c.login.username), password: D(c.login.password) } } : {}),
        fields: (c.fields ?? []).map((f: any) => ({ name: D(f?.name) ?? '', value: D(f?.value) })),
        ...(c.revisionDate ? { revisionDate: String(c.revisionDate) } : {}),
      }
    } catch {
      return { id: String(c?.id), name: CANNOT_DECRYPT, fields: [] }
    } finally {
      if (key !== this.orgKey) zero(key)
    }
  }

  // ---- items --------------------------------------------------------------

  private async ciphers(force: boolean): Promise<any[]> {
    if (!force && this.cache && Date.now() - this.cache.at < FRESH_SYNC_MS) return this.cache.ciphers
    const sync = await this.call('GET', '/api/sync?excludeDomains=true')
    this.cache = { at: Date.now(), ciphers: Array.isArray(sync?.ciphers) ? sync.ciphers : [] }
    return this.cache.ciphers
  }

  /** Encrypted items of the HyperProx collection, not in the trash. */
  private async collectionCiphers(force = false): Promise<any[]> {
    if (!this.collectionId) return []
    const cid = this.collectionId
    return (await this.ciphers(force)).filter(c =>
      String(c?.organizationId) === this.orgId && !c?.deletedDate && (c?.collectionIds ?? []).map(String).includes(cid))
  }

  async listItems(): Promise<DecryptedItem[]> {
    return (await this.collectionCiphers()).map(c => this.decrypt(c))
  }

  /**
   * Creates or edits items by name. An edit replaces the custom fields (and the
   * notes, when given) and carries every other encrypted value through as it is.
   */
  async upsertItems(items: Array<{ name: string; fields: Record<string, string>; notes?: string }>): Promise<DecryptedItem[]> {
    if (!this.collectionId) throw new Error(`collection "${COLLECTION_NAME}" is not visible to this account`)
    const current = await this.collectionCiphers()
    const byName = new Map<string, any>()
    for (const c of current) {
      const n = this.decrypt(c).name
      if (n !== CANNOT_DECRYPT && !byName.has(n)) byName.set(n, c)
    }
    // After a write the next listing syncs, so a read-back checks the server.
    this.cache = null
    const out: DecryptedItem[] = []
    for (const { name, fields, notes } of items) {
      const existing = byName.get(name)
      const key = existing ? this.itemKey(existing) : this.orgKey
      try {
        const E = (v: string) => NativeVaultSession.enc(v, key)
        const encFields = Object.entries(fields).map(([k, v]) => ({ name: E(k), value: E(String(v ?? '')), type: 1, linkedId: null }))
        let saved: any
        if (existing) {
          saved = await this.call('PUT', `/api/ciphers/${existing.id}`, {
            type: existing.type,
            organizationId: this.orgId,
            folderId: existing.folderId ?? null,
            name: existing.name,
            notes: notes != null ? E(notes) : existing.notes ?? null,
            favorite: existing.favorite ?? false,
            reprompt: existing.reprompt ?? 0,
            key: existing.key ?? null,
            login: existing.login ?? null,
            secureNote: existing.secureNote ?? null,
            card: existing.card ?? null,
            identity: existing.identity ?? null,
            sshKey: existing.sshKey ?? null,
            fields: encFields,
            passwordHistory: existing.passwordHistory ?? null,
            lastKnownRevisionDate: existing.revisionDate ?? null,
            encryptedFor: this.userId,
          })
        } else {
          saved = await this.call('POST', '/api/ciphers/create', {
            cipher: {
              type: 2,
              organizationId: this.orgId,
              folderId: null,
              name: E(name),
              notes: notes != null ? E(notes) : null,
              favorite: false,
              reprompt: 0,
              key: null,
              secureNote: { type: 0 },
              fields: encFields,
              // Vaultwarden 1.37 refuses a cipher without it: the account whose keys encrypted it.
              encryptedFor: this.userId,
            },
            collectionIds: [this.collectionId],
          })
        }
        out.push(this.decrypt(saved))
      } finally {
        if (key !== this.orgKey) zero(key)
      }
    }
    return out
  }

  /** Moves every item with this name to the vault's trash (recoverable from a Bitwarden client), like `bw delete item`. */
  async deleteItems(name: string): Promise<void> {
    const matches = (await this.collectionCiphers(true)).filter(c => this.decrypt(c).name === name)
    this.cache = null
    for (const c of matches) await this.call('PUT', `/api/ciphers/${c.id}/delete`)
  }

  // ---- Sends --------------------------------------------------------------

  /** A text Send, encrypted as Bitwarden clients do; returns the access id and the secret URL fragment. */
  async createTextSend(text: string, opts: { expires: string; maxViews: number; password?: string }): Promise<{ accessId: string; keyFragment: string; expirationDate: string }> {
    const seed = crypto.randomBytes(16)
    const key = sendKeyFromSeed(seed)
    try {
      const out = await this.call('POST', '/api/sends', {
        type: 0,
        name: NativeVaultSession.enc('HyperProx', key),
        notes: null,
        key: encString2(seed, this.userKey),
        text: { text: NativeVaultSession.enc(text, key), hidden: true },
        file: null,
        maxAccessCount: opts.maxViews,
        expirationDate: opts.expires,
        deletionDate: opts.expires,
        password: opts.password ? await sendPasswordHash(opts.password, seed) : null,
        disabled: false,
        hideEmail: true,
      })
      const accessId = str(out?.accessId)
      if (!accessId) throw new Error('vault send returned no access id')
      return { accessId, keyFragment: base64Url(seed), expirationDate: String(out?.expirationDate ?? opts.expires) }
    } finally {
      seed.fill(0); zero(key)
    }
  }

  // ---- password check / end -----------------------------------------------

  /** Offline: derives the local check value again and compares. No server call, no TOTP. */
  async verifyPassword(password: string): Promise<boolean> {
    if (this.closed) return false
    const mk = await makeMasterKeyFor(password, this.email, this.kdf)
    try {
      const h = await localPasswordHash(mk, password)
      return h.length === this.localHash.length && crypto.timingSafeEqual(h, this.localHash)
    } finally { mk.fill(0) }
  }

  close(): void {
    this.closed = true
    zero(this.userKey); zero(this.orgKey); this.localHash.fill(0)
    this.accessToken = ''
    this.refreshToken = undefined
    this.cache = null
  }
}
