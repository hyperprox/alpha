// =============================================================================
//  HyperProx — API tokens
//  For automation (scripts, coding agents) that must drive admin routes without
//  a browser session. A token is `hpx_` + 32 random bytes (base64url). It is
//  shown once at creation; only its SHA-256 is stored.
//
//  A token is a key to the gate, not a way round it:
//    - while HyperProx is locked a token gets 423 like everything else, and its
//      requests never reset the idle-lock timer (only people keep it unlocked);
//    - it carries a role and the role matrix applies unchanged;
//    - it can never re-confirm, so destroy / reveal / role changes stay out of
//      reach, and the routes in tokenForbidden() refuse it outright.
//  A token never writes to the vault: actingSid() gives a token's request (and
//  any work it starts) no vault session, so it cannot borrow a signed-in
//  person's. Such a write is refused as 403 token_forbidden; reads, from the
//  unlock cache, still work.
//
//  One opt-in exception, off by default: an owner may let one admin token save
//  plug-in settings (PUT /api/plugins/:id/settings), and add or change a PBS,
//  Home Assistant or QNAP instance, without a re-confirmation
//  (pluginSettingsWithoutReconfirm; the exact allowlist is lib/roles.ts
//  tokenPluginScope). That request's vault writes, to that plug-in's own items
//  only, are made with the granting owner's signed-in session.
//  Every such save is audited (plugin.settings.save). Nothing else changes: every
//  other re-confirmed action, every other vault write, Secrets, Send, tokens,
//  users and roles stay out of reach. Only an owner, re-confirmed, can switch it
//  on or off (routes/api-tokens.ts); a token can never reach that route.
//
//  Created and revoked from Settings → API tokens (admin, re-confirmed) or by
//  root on the host with `hyperprox token ...` (cli/api-token.ts).
// =============================================================================

import crypto from 'node:crypto'
import { z } from 'zod'
import { PrismaClient } from '@prisma/client'
import type { Role } from './vault/broker'
import { normalisePath } from './roles'

export const TOKEN_PREFIX = 'hpx_'
const TOKEN_RE = /^hpx_[A-Za-z0-9_-]{43}$/

/** Roles a token may carry. Owner is for people: role management stays with them. */
export const TOKEN_ROLES = ['viewer', 'operator', 'admin'] as const
export type TokenRole = typeof TOKEN_ROLES[number]

export const MAX_EXPIRES_DAYS = 3650

/** How long a looked-up token is trusted from memory. A revoke made here clears it at once; one made
 *  by the host CLI (another process) takes effect within this window. */
export const CACHE_MS = 10_000
/** lastUsedAt is written at most this often per token. */
export const TOUCH_MS = 60_000

export interface ApiTokenRecord {
  id:         string
  name:       string
  role:       string
  tokenHash:  string
  createdBy:  string
  createdAt:  Date
  lastUsedAt: Date | null
  expiresAt:  Date | null
  revokedAt:  Date | null
  /** Owner-granted: may save plug-in settings without a re-confirmation. Default false. */
  pluginSettingsWithoutReconfirm: boolean
  /** The owner who granted it (their signed-in session writes the vault item). */
  pluginSettingsGrantedBy: string | null
  pluginSettingsGrantedAt: Date | null
}

/** What the API and the CLI show: everything but the hash. */
export interface ApiTokenView {
  id:         string
  name:       string
  role:       string
  createdBy:  string
  createdAt:  string
  lastUsedAt: string | null
  expiresAt:  string | null
  revokedAt:  string | null
  /** active | expired | revoked */
  state:      'active' | 'expired' | 'revoked'
  pluginSettingsWithoutReconfirm: boolean
  pluginSettingsGrantedBy: string | null
  pluginSettingsGrantedAt: string | null
}

export class ApiTokenInputError extends Error {
  constructor(message: string) { super(message); this.name = 'ApiTokenInputError' }
}
export class ApiTokenNotFoundError extends Error {
  constructor(what: string) { super(`No API token ${what}`); this.name = 'ApiTokenNotFoundError' }
}

// --- Token material -----------------------------------------------------------------------

export function generateToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex')
}

/** True for anything that claims to be an API token, well formed or not. */
export function looksLikeApiToken(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(TOKEN_PREFIX)
}

/**
 * The API token in an `Authorization: Bearer hpx_...` header, or null. Only the
 * header counts: a cookie never carries an API token (it would go to the JWT
 * check and fail there, as any other garbage would).
 */
export function bearerApiToken(headers: Record<string, any>): string | null {
  const auth = headers['authorization']
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null
  const value = auth.slice(7).trim()
  return looksLikeApiToken(value) ? value : null
}

// --- What a token may never do --------------------------------------------------------------

/**
 * Routes refused to an API token whatever its role (403 token_forbidden):
 *   /api/auth/*        sign-in, sign-out, bootstrap, lock, reconfirm, and token
 *                      management itself; only GET /api/auth/status is allowed
 *   /api/secrets*      the vault's items: listing, reveal, Send (which hands a
 *                      value out) and generate
 *   /api/terminal*     saved SSH logins, host keys and shells (the Deck)
 *   /ws, /ws/*         live status, update progress and terminal sockets
 * Requests that need a re-confirmation (lib/roles.ts needsReconfirm) are refused
 * by the gate as reconfirm_required: a token has no master password.
 */
export function tokenForbidden(method: string, path: string): boolean {
  const m = method.toUpperCase()
  const p = normalisePath(path)
  if (p === '/api/auth' || p.startsWith('/api/auth/')) return !(p === '/api/auth/status' && (m === 'GET' || m === 'HEAD'))
  if (p === '/api/secrets' || p.startsWith('/api/secrets/')) return true
  if (p === '/api/terminal' || p.startsWith('/api/terminal/')) return true
  if (p === '/ws' || p.startsWith('/ws/')) return true
  // Installing a new HyperProx, or changing how it updates itself, is a person's act (routes/self-update.ts).
  if (p === '/api/self-update/install' || p === '/api/self-update/settings') return true
  return false
}

// --- Store ----------------------------------------------------------------------------------

export interface NewApiToken {
  name:      string
  role:      TokenRole
  tokenHash: string
  createdBy: string
  expiresAt: Date | null
}

export interface ApiTokenStore {
  findByHash(tokenHash: string): Promise<ApiTokenRecord | null>
  findByName(name: string): Promise<ApiTokenRecord | null>
  findById(id: string): Promise<ApiTokenRecord | null>
  list(): Promise<ApiTokenRecord[]>
  /** Throws ApiTokenInputError when the name is taken. */
  create(t: NewApiToken): Promise<ApiTokenRecord>
  revoke(id: string, at: Date): Promise<ApiTokenRecord>
  touch(id: string, at: Date): Promise<void>
  /** Switch the plug-in settings permission on (with the granting owner) or off. */
  setPluginSettings(id: string, enabled: boolean, by: string, at: Date): Promise<ApiTokenRecord>
  audit(action: string, resource: string, details?: Record<string, unknown>): Promise<void>
}

export class PrismaApiTokenStore implements ApiTokenStore {
  constructor(private db: PrismaClient) {}
  findByHash(tokenHash: string) { return this.db.apiToken.findUnique({ where: { tokenHash } }) }
  findByName(name: string)      { return this.db.apiToken.findUnique({ where: { name } }) }
  findById(id: string)          { return this.db.apiToken.findUnique({ where: { id } }) }
  list()                        { return this.db.apiToken.findMany({ orderBy: { createdAt: 'desc' } }) }
  async create(t: NewApiToken) {
    try {
      return await this.db.apiToken.create({ data: t })
    } catch (e: any) {
      // P2002: unique constraint. The hash is 256 random bits, so it is the name.
      if (e?.code === 'P2002') throw new ApiTokenInputError(`A token named "${t.name}" already exists (revoked tokens keep their name)`)
      throw e
    }
  }
  revoke(id: string, at: Date) { return this.db.apiToken.update({ where: { id }, data: { revokedAt: at } }) }
  async touch(id: string, at: Date) { await this.db.apiToken.update({ where: { id }, data: { lastUsedAt: at } }) }
  setPluginSettings(id: string, enabled: boolean, by: string, at: Date) {
    return this.db.apiToken.update({ where: { id }, data: enabled
      ? { pluginSettingsWithoutReconfirm: true, pluginSettingsGrantedBy: by, pluginSettingsGrantedAt: at }
      : { pluginSettingsWithoutReconfirm: false, pluginSettingsGrantedBy: null, pluginSettingsGrantedAt: null } })
  }
  async audit(action: string, resource: string, details?: Record<string, unknown>) {
    await this.db.auditLog.create({ data: { action, resource, details: (details ?? undefined) as any } })
  }
}

/** For tests. */
export class MemoryApiTokenStore implements ApiTokenStore {
  rows: ApiTokenRecord[] = []
  audits: Array<{ action: string; resource: string; details?: Record<string, unknown> }> = []
  lookups = 0
  private n = 0
  async findByHash(h: string) {
    this.lookups++
    const r = this.rows.find(x => x.tokenHash === h)
    return r ? { ...r } : null   // a copy, as a database read would be
  }
  async findByName(name: string) { return this.rows.find(r => r.name === name) ?? null }
  async findById(id: string) { return this.rows.find(r => r.id === id) ?? null }
  async list() { return [...this.rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()) }
  async create(t: NewApiToken) {
    if (this.rows.some(r => r.name === t.name)) throw new ApiTokenInputError(`A token named "${t.name}" already exists (revoked tokens keep their name)`)
    const row: ApiTokenRecord = {
      id: `tok${++this.n}`, ...t, createdAt: new Date(), lastUsedAt: null, revokedAt: null,
      pluginSettingsWithoutReconfirm: false, pluginSettingsGrantedBy: null, pluginSettingsGrantedAt: null,
    }
    this.rows.push(row)
    return row
  }
  async revoke(id: string, at: Date) {
    const r = this.rows.find(x => x.id === id)
    if (!r) throw new ApiTokenNotFoundError(id)
    r.revokedAt = at
    return r
  }
  async touch(id: string, at: Date) { const r = this.rows.find(x => x.id === id); if (r) r.lastUsedAt = at }
  async setPluginSettings(id: string, enabled: boolean, by: string, at: Date) {
    const r = this.rows.find(x => x.id === id)
    if (!r) throw new ApiTokenNotFoundError(id)
    r.pluginSettingsWithoutReconfirm = enabled
    r.pluginSettingsGrantedBy = enabled ? by : null
    r.pluginSettingsGrantedAt = enabled ? at : null
    return r
  }
  async audit(action: string, resource: string, details?: Record<string, unknown>) { this.audits.push({ action, resource, details }) }
}

let store: ApiTokenStore | null = null

/** The store the gate and the routes use. index.ts sets the Prisma one; tests set a memory one. */
export function setApiTokenStore(s: ApiTokenStore | null): void {
  store = s
  cache.clear()
  touched.clear()
}

export function apiTokenStore(): ApiTokenStore {
  if (!store) store = new PrismaApiTokenStore(new PrismaClient())
  return store
}

// --- Views and validation -------------------------------------------------------------------

const iso = (d: Date | null) => (d ? d.toISOString() : null)

export function tokenState(r: ApiTokenRecord, now = Date.now()): ApiTokenView['state'] {
  if (r.revokedAt) return 'revoked'
  if (r.expiresAt && r.expiresAt.getTime() <= now) return 'expired'
  return 'active'
}

export function tokenView(r: ApiTokenRecord, now = Date.now()): ApiTokenView {
  return {
    id: r.id, name: r.name, role: r.role, createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(), lastUsedAt: iso(r.lastUsedAt), expiresAt: iso(r.expiresAt), revokedAt: iso(r.revokedAt),
    state: tokenState(r, now),
    pluginSettingsWithoutReconfirm: r.pluginSettingsWithoutReconfirm === true,
    pluginSettingsGrantedBy: r.pluginSettingsWithoutReconfirm ? r.pluginSettingsGrantedBy ?? null : null,
    pluginSettingsGrantedAt: r.pluginSettingsWithoutReconfirm ? iso(r.pluginSettingsGrantedAt ?? null) : null,
  }
}

export const createTokenInput = z.object({
  name:        z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'name: 1-64 letters, digits, dot, dash or underscore, starting with a letter or digit'),
  role:        z.enum(TOKEN_ROLES).default('admin'),
  expiresDays: z.number().int().min(1).max(MAX_EXPIRES_DAYS).optional(),
}).strict()

export type CreateTokenInput = z.input<typeof createTokenInput>

/**
 * Create a token. Returns the plaintext once; only its hash is kept. `createdBy`
 * is the creator's email, or "host-cli" for `hyperprox token create`.
 */
export async function createApiToken(
  input: CreateTokenInput, createdBy: string, s: ApiTokenStore = apiTokenStore(), now = Date.now(),
  /** Host-side callers only (never a request body): an expiry shorter than a day, in milliseconds. */
  opts: { expiresInMs?: number } = {},
): Promise<{ token: string; record: ApiTokenRecord }> {
  const parsed = createTokenInput.safeParse(input)
  if (!parsed.success) throw new ApiTokenInputError(parsed.error.issues.map(i => i.message).join('; '))
  const { name, role, expiresDays } = parsed.data
  if (opts.expiresInMs !== undefined && !(opts.expiresInMs > 0)) throw new ApiTokenInputError('expiresInMs must be positive')
  const token = generateToken()
  const record = await s.create({
    name, role, tokenHash: hashToken(token), createdBy,
    expiresAt: opts.expiresInMs !== undefined ? new Date(now + opts.expiresInMs)
      : expiresDays ? new Date(now + expiresDays * 86_400_000) : null,
  })
  await s.audit('api_token.create', name, { id: record.id, role, by: createdBy, expiresAt: iso(record.expiresAt) })
  return { token, record }
}

/** Revoke by id or by name. Revoking a revoked token is a no-op that still answers with it. */
export async function revokeApiToken(idOrName: string, by: string, s: ApiTokenStore = apiTokenStore()): Promise<ApiTokenRecord> {
  const row = (await s.findById(idOrName)) ?? (await s.findByName(idOrName))
  if (!row) throw new ApiTokenNotFoundError(`"${idOrName}"`)
  forgetToken(row.id)
  if (row.revokedAt) return row
  const out = await s.revoke(row.id, new Date())
  await s.audit('api_token.revoke', row.name, { id: row.id, by })
  return out
}

/**
 * Switch a token's plug-in settings permission on or off. The caller has already checked that `by` is a
 * signed-in owner who re-confirmed (routes/api-tokens.ts), or root on the host (cli/api-token.ts, by "host-cli"). Only an active admin token can have it switched on: a token
 * below admin could not save settings anyway. The change reaches the gate on the next request.
 */
export async function setTokenPluginSettings(
  id: string, enabled: boolean, by: string, s: ApiTokenStore = apiTokenStore(), now = Date.now(),
  /** The host CLI's own audit entry (cli/api-token.ts); the browser route keeps the default. */
  audit?: { action: string; details: Record<string, unknown> },
): Promise<ApiTokenRecord> {
  const row = await s.findById(id)
  if (!row) throw new ApiTokenNotFoundError(`"${id}"`)
  if (enabled) {
    if (tokenState(row, now) !== 'active') throw new ApiTokenInputError(`Token "${row.name}" is ${tokenState(row, now)}`)
    if (row.role !== 'admin') throw new ApiTokenInputError(`Token "${row.name}" has the ${row.role} role; saving plug-in settings needs an admin token`)
  }
  forgetToken(row.id)
  const out = await s.setPluginSettings(row.id, enabled, by, new Date(now))
  forgetToken(row.id)
  if (audit) await s.audit(audit.action, row.name, { id: row.id, ...audit.details })
  else await s.audit(enabled ? 'api_token.plugin_settings.grant' : 'api_token.plugin_settings.remove', row.name, { id: row.id, by })
  return out
}

// --- Verification (the gate's side) ---------------------------------------------------------

const cache = new Map<string, { row: ApiTokenRecord; at: number }>()
const touched = new Map<string, number>()
const CACHE_MAX = 1000

/** Drop a token from memory (after a revoke). */
export function forgetToken(id: string): void {
  for (const [h, v] of cache) if (v.row.id === id) cache.delete(h)
}

/**
 * The live token record for a presented token, or null when it is malformed,
 * unknown, revoked or expired. Records a use (lastUsedAt, at most once a minute).
 */
export async function verifyApiToken(token: string, now = Date.now()): Promise<ApiTokenRecord | null> {
  if (!TOKEN_RE.test(token)) return null
  const h = hashToken(token)
  let row: ApiTokenRecord | null
  const hit = cache.get(h)
  if (hit && now - hit.at < CACHE_MS) {
    row = hit.row
  } else {
    row = await apiTokenStore().findByHash(h)
    if (row) {
      if (cache.size >= CACHE_MAX) cache.clear()
      cache.set(h, { row, at: now })
    } else {
      cache.delete(h)
    }
  }
  if (!row || tokenState(row, now) !== 'active') return null

  const last = touched.get(row.id) ?? row.lastUsedAt?.getTime() ?? 0
  if (now - last >= TOUCH_MS) {
    touched.set(row.id, now)
    row.lastUsedAt = new Date(now)
    apiTokenStore().touch(row.id, new Date(now)).catch(() => { /* bookkeeping only */ })
  }
  return row
}
