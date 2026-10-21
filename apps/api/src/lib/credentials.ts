// =============================================================================
//  HyperProx — Credential Store
//  Source of truth is the vault. Each category/provider is one Secure Note in
//  the HyperProx collection, named `hyperprox:<category>/<provider>`, with one
//  hidden field per key. While unlocked, reads come from the in-memory unlock
//  cache and writes go through to the vault as the requesting user. While
//  locked there is nothing to read: every call throws VaultLockedError.
//
//  The exported functions and signatures are unchanged from the Postgres store
//  they replace, so callers do not change.
//
//  seedFromEnv() is the one-time migration from the old store (encrypted
//  Postgres rows + .env values) into the vault, run on the first Owner unlock.
// =============================================================================

import { PrismaClient } from '@prisma/client'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { decrypt, mask } from './crypto'
import { getBroker, type SecretItem } from './vault/broker'
import { isUnlocked, cachedSecret, putCachedSecret, onLock } from './vault/state'
import { actingSid } from './auth'

export interface CredentialDef {
  category: string
  provider: string
  key:      string
  label:    string
  masked:   boolean
  envKey?:  string   // corresponding .env key to seed from
}

export class VaultLockedError extends Error {
  constructor(what = 'credentials') {
    super(`HyperProx is locked — sign in to unlock the vault before reading ${what}`)
    this.name = 'VaultLockedError'
  }
}

// ---------------------------------------------------------------------------
//  Credential definitions — the full schema of what HyperProx manages
// ---------------------------------------------------------------------------

export const CREDENTIAL_DEFS: CredentialDef[] = [
  // Proxmox
  { category: 'proxmox', provider: 'proxmox', key: 'host',         label: 'Host IP',       masked: false, envKey: 'PROXMOX_HOST' },
  { category: 'proxmox', provider: 'proxmox', key: 'port',         label: 'Port',           masked: false, envKey: 'PROXMOX_PORT' },
  { category: 'proxmox', provider: 'proxmox', key: 'user',         label: 'User',           masked: false, envKey: 'PROXMOX_USER' },
  { category: 'proxmox', provider: 'proxmox', key: 'token_id',     label: 'Token ID',       masked: false, envKey: 'PROXMOX_TOKEN_ID' },
  { category: 'proxmox', provider: 'proxmox', key: 'token_secret', label: 'Token Secret',   masked: true,  envKey: 'PROXMOX_TOKEN_SECRET' },

  // NPM
  { category: 'proxy', provider: 'npm', key: 'url',      label: 'NPM URL',      masked: false, envKey: 'NPM_URL' },
  { category: 'proxy', provider: 'npm', key: 'email',    label: 'Email',        masked: false, envKey: 'NPM_EMAIL' },
  { category: 'proxy', provider: 'npm', key: 'password', label: 'Password',     masked: true,  envKey: 'NPM_PASSWORD' },

  // GoDaddy
  { category: 'dns', provider: 'godaddy', key: 'api_key',    label: 'API Key',    masked: false, envKey: 'GODADDY_API_KEY' },
  { category: 'dns', provider: 'godaddy', key: 'api_secret', label: 'API Secret', masked: true,  envKey: 'GODADDY_API_SECRET' },

  // Cloudflare
  { category: 'dns', provider: 'cloudflare', key: 'api_token', label: 'API Token', masked: true, envKey: 'CLOUDFLARE_API_TOKEN' },
  { category: 'dns', provider: 'cloudflare', key: 'email',     label: 'Email',     masked: false, envKey: 'CLOUDFLARE_EMAIL' },

  // Namecheap
  { category: 'dns', provider: 'namecheap', key: 'api_key',  label: 'API Key',  masked: true,  envKey: 'NAMECHEAP_API_KEY' },
  { category: 'dns', provider: 'namecheap', key: 'username', label: 'Username', masked: false, envKey: 'NAMECHEAP_USERNAME' },

  // Ollama / AI
  { category: 'ai', provider: 'ollama', key: 'url',   label: 'Ollama URL',     masked: false, envKey: 'OLLAMA_URL' },
  { category: 'ai', provider: 'ollama', key: 'model', label: 'Active Model',    masked: false, envKey: 'OLLAMA_MODEL' },

  // Cloud AI providers — optional. Present so a fresh install is useful before
  // anyone has downloaded a local model.
  { category: 'ai', provider: 'anthropic', key: 'api_key',  label: 'Anthropic API Key', masked: true,  envKey: 'ANTHROPIC_API_KEY' },
  { category: 'ai', provider: 'anthropic', key: 'model',    label: 'Anthropic Model',   masked: false, envKey: 'ANTHROPIC_MODEL' },
  { category: 'ai', provider: 'openai',    key: 'api_key',  label: 'OpenAI API Key',    masked: true,  envKey: 'OPENAI_API_KEY' },
  { category: 'ai', provider: 'openai',    key: 'model',    label: 'OpenAI Model',      masked: false, envKey: 'OPENAI_MODEL' },
  { category: 'ai', provider: 'openai',    key: 'base_url', label: 'OpenAI Base URL',   masked: false, envKey: 'OPENAI_BASE_URL' },

  // HyperProx system
  { category: 'system', provider: 'hyperprox', key: 'app_url',   label: 'App URL',   masked: false, envKey: 'NEXT_PUBLIC_API_URL' },
]

/** .env keys that grant access and are blanked once their value is in the vault. */
export const SECRET_ENV_KEYS: string[] = CREDENTIAL_DEFS
  .filter(d => d.envKey && (d.masked || d.key === 'api_key'))
  .map(d => d.envKey!)

/** Keys that stop existing as stored values once the vault gate is in place. */
export const RETIRED_ENV_KEYS = ['ENCRYPTION_KEY', 'JWT_SECRET']

/** Rows of the old store that are dropped, not migrated (the retired HyperProx password). */
const RETIRED_ROWS = new Set([
  'system/hyperprox/admin_password_hash',
  'system/hyperprox/admin_setup_hash',
  'system/hyperprox/jwt_secret',
])

// ---------------------------------------------------------------------------
//  Vault item layout
// ---------------------------------------------------------------------------

export const ITEM_PREFIX = 'hyperprox:'

export function itemName(category: string, provider: string): string {
  return `${ITEM_PREFIX}${category}/${provider}`
}

const META_MARK = 'hyperprox-meta:'
const NOTE_HEAD = 'Managed by HyperProx. Each hidden field is one setting; edit values here or in HyperProx.'

interface ItemMeta { updatedAt: Record<string, string> }

function readMeta(item: SecretItem | undefined): ItemMeta {
  const line = item?.notes?.split('\n').find(l => l.startsWith(META_MARK))
  if (line) {
    try {
      const m = JSON.parse(line.slice(META_MARK.length))
      if (m && typeof m.updatedAt === 'object') return { updatedAt: { ...m.updatedAt } }
    } catch { /* hand-edited — start again */ }
  }
  return { updatedAt: {} }
}

function writeMeta(meta: ItemMeta): string {
  return `${NOTE_HEAD}\n${META_MARK}${JSON.stringify(meta)}`
}

function requireUnlocked(what?: string): void {
  if (!isUnlocked()) throw new VaultLockedError(what)
}

function requireSid(): string {
  requireUnlocked()
  const sid = actingSid()
  if (!sid) throw new VaultLockedError('credentials (no signed-in session to write with)')
  return sid
}

// One vault write per item at a time, always sending the latest cached fields,
// so concurrent setCredential calls on one provider cannot drop each other's keys.
const writeQueues = new Map<string, Promise<unknown>>()

function writeThrough(name: string, sid: string): Promise<void> {
  const prev = writeQueues.get(name) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(async () => {
    const item = cachedSecret(name)
    if (!item) return
    const broker = getBroker()
    if (Object.keys(item.fields).length === 0) {
      if (item.id) await broker.deleteSecret(sid, name)
      putCachedSecret({ ...item, id: '' })
      return
    }
    const saved = await broker.upsertSecret(sid, name, { ...item.fields }, item.notes)
    const latest = cachedSecret(name)
    if (latest) putCachedSecret({ ...latest, id: saved.id })
  })
  writeQueues.set(name, next)
  next.finally(() => { if (writeQueues.get(name) === next) writeQueues.delete(name) }).catch(() => undefined)
  return next
}

// ---------------------------------------------------------------------------
//  Process environment bridge
//  Many routes still build their hypervisor/NPM clients from process.env. Once
//  the values live only in the vault, they are put into process.env at unlock
//  and taken out again at lock, so those callers keep working and nothing is
//  left in the environment while locked.
// ---------------------------------------------------------------------------

const envOriginals = new Map<string, string | undefined>()

function setEnvFromVault(def: CredentialDef, value: string | undefined): void {
  if (!def.envKey) return
  if (!envOriginals.has(def.envKey)) envOriginals.set(def.envKey, process.env[def.envKey])
  if (value === undefined || value === '') {
    const orig = envOriginals.get(def.envKey)
    if (orig === undefined || SECRET_ENV_KEYS.includes(def.envKey)) delete process.env[def.envKey]
    else process.env[def.envKey] = orig
  } else {
    process.env[def.envKey] = value
  }
}

/** Copy vault values for env-backed settings into process.env (call after unlock). */
export function hydrateEnvFromVault(): void {
  if (!isUnlocked()) return
  for (const def of CREDENTIAL_DEFS) {
    const v = cachedSecret(itemName(def.category, def.provider))?.fields[def.key]
    if (v !== undefined && v !== '') setEnvFromVault(def, v)
  }
}

/** Put process.env back as it was before the unlock (secrets removed). */
export function restoreEnvAfterLock(): void {
  for (const [key, orig] of envOriginals) {
    if (orig === undefined || SECRET_ENV_KEYS.includes(key) || RETIRED_ENV_KEYS.includes(key)) delete process.env[key]
    else process.env[key] = orig
  }
  envOriginals.clear()
}

let lockListener = false
function ensureLockListener(): void {
  if (lockListener) return
  lockListener = true
  onLock(() => restoreEnvAfterLock())
}
ensureLockListener()

// ---------------------------------------------------------------------------
//  Get a single credential
// ---------------------------------------------------------------------------

export async function getCredential(category: string, provider: string, key: string): Promise<string | null> {
  requireUnlocked(`${category}/${provider}/${key}`)
  const v = cachedSecret(itemName(category, provider))?.fields[key]
  return v === undefined ? null : v
}

// ---------------------------------------------------------------------------
//  Get all credentials for a provider (map)
// ---------------------------------------------------------------------------

export async function getProviderCredentials(category: string, provider: string): Promise<Record<string, string>> {
  requireUnlocked(`${category}/${provider}`)
  return { ...(cachedSecret(itemName(category, provider))?.fields ?? {}) }
}

// ---------------------------------------------------------------------------
//  Set a credential (cache + write-through to the vault)
// ---------------------------------------------------------------------------

export async function setCredential(category: string, provider: string, key: string, value: string, _masked = true): Promise<void> {
  const sid  = requireSid()
  const name = itemName(category, provider)
  const prev = cachedSecret(name)
  const meta = readMeta(prev)
  meta.updatedAt[key] = new Date().toISOString()

  const fields = { ...(prev?.fields ?? {}), [key]: value }
  putCachedSecret({ name, id: prev?.id ?? '', fields, notes: writeMeta(meta) })

  try {
    await writeThrough(name, sid)
  } catch (e) {
    // Put the old value back unless something newer has replaced ours meanwhile.
    const now = cachedSecret(name)
    if (now && now.fields[key] === value) {
      const restored = { ...now.fields }
      if (prev && key in prev.fields) restored[key] = prev.fields[key]
      else delete restored[key]
      putCachedSecret({ ...now, fields: restored })
    }
    throw e
  }

  const def = CREDENTIAL_DEFS.find(d => d.category === category && d.provider === provider && d.key === key)
  if (def) setEnvFromVault(def, value)
}

// ---------------------------------------------------------------------------
//  Get all for a category — returns masked values for UI
// ---------------------------------------------------------------------------

export async function getCategoryForUI(category: string): Promise<Array<{
  provider: string; key: string; label: string; value: string; masked: boolean; isSet: boolean
  decryptFailed: boolean
}>> {
  requireUnlocked(`the ${category} settings`)
  const defs = CREDENTIAL_DEFS.filter(d => d.category === category)

  return defs.map(def => {
    const plain = cachedSecret(itemName(def.category, def.provider))?.fields[def.key]
    const isSet = plain !== undefined && plain !== ''
    return {
      provider: def.provider,
      key:      def.key,
      label:    def.label,
      value:    isSet ? (def.masked ? mask(plain!) : plain!) : '',
      masked:   def.masked,
      isSet,
      // Kept for the settings page: values in the vault cannot be "stored but unreadable".
      decryptFailed: false,
    }
  })
}

// ---------------------------------------------------------------------------
//  Delete a credential
// ---------------------------------------------------------------------------

export async function deleteCredential(category: string, provider: string, key: string): Promise<void> {
  const sid  = requireSid()
  const name = itemName(category, provider)
  const prev = cachedSecret(name)
  if (!prev || !(key in prev.fields)) return

  const fields = { ...prev.fields }
  delete fields[key]
  const meta = readMeta(prev)
  delete meta.updatedAt[key]
  putCachedSecret({ ...prev, fields, notes: writeMeta(meta) })

  try {
    await writeThrough(name, sid)
  } catch (e) {
    const now = cachedSecret(name)
    if (now && !(key in now.fields)) putCachedSecret({ ...now, fields: { ...now.fields, [key]: prev.fields[key] } })
    throw e
  }

  const def = CREDENTIAL_DEFS.find(d => d.category === category && d.provider === provider && d.key === key)
  if (def) setEnvFromVault(def, undefined)
}

// ---------------------------------------------------------------------------
//  List the keys under a provider — without exposing the values.
// ---------------------------------------------------------------------------

export async function listCredentialKeys(
  category: string,
  provider: string,
): Promise<Array<{ key: string; updatedAt: Date }>> {
  requireUnlocked(`${category}/${provider}`)
  const item = cachedSecret(itemName(category, provider))
  if (!item) return []
  const meta = readMeta(item)
  return Object.keys(item.fields)
    .sort()
    .map(key => ({ key, updatedAt: meta.updatedAt[key] ? new Date(meta.updatedAt[key]) : new Date(0) }))
}

// =============================================================================
//  Migration: Postgres + .env → vault (first Owner unlock)
// =============================================================================

interface CredentialRow { id: string; category: string; provider: string; key: string; value: string; updatedAt: Date }

/** The slice of Prisma the migration uses — so tests can pass a fake. */
export interface CredentialTable {
  credential: {
    findMany(args?: any): Promise<CredentialRow[]>
    deleteMany(args: { where: { id: { in: string[] } } }): Promise<unknown>
  }
}

let prismaClient: CredentialTable | null = null

function table(): CredentialTable {
  if (!prismaClient) prismaClient = new PrismaClient() as unknown as CredentialTable
  return prismaClient
}

/** Test seam: replace the Postgres client the migration reads from. */
export function setCredentialTable(t: CredentialTable | null): void {
  prismaClient = t
}

export function envFilePath(): string {
  return process.env.ENV_FILE_PATH || '/opt/hyperprox/.env'
}

export interface MigrationResult {
  migrated: number        // values written to the vault
  rowsDeleted: number
  envBlanked: string[]    // .env keys blanked
  backup?: string         // path of the .env backup written this run
}

/** Parse KEY=value lines (no expansion). Comments and blanks are ignored. */
function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1)
    out.set(m[1], v)
  }
  return out
}

/** Blank `KEY=...` lines for the given keys, keeping every other line exactly. */
function blankEnv(text: string, keys: Set<string>): { text: string; blanked: string[] } {
  const blanked: string[] = []
  const lines = text.split('\n').map(line => {
    const m = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=)(.*)$/.exec(line)
    if (!m || !keys.has(m[2])) return line
    const v = m[4].trim()
    if (v === '' || v === '""' || v === "''") return line
    blanked.push(m[2])
    return `${m[1]}${m[2]}${m[3]}`
  })
  return { text: lines.join('\n'), blanked }
}

/**
 * One-time migration into the vault, run on the first Owner unlock. Safe to run again:
 *  1. Collect every Postgres `credential` row (decrypted with the old ENCRYPTION_KEY) and every
 *     env-seeded value that has no row. A value already in the vault wins over both.
 *  2. Write them to the vault, then read the vault back and compare every value.
 *  3. Only then: delete the migrated rows, back up `.env` to `.env.pre-vault` (0600) and blank
 *     ENCRYPTION_KEY, JWT_SECRET and the seeded secrets in `.env`.
 * Any failure before step 3 leaves the old store untouched.
 */
export async function seedFromEnv(sidArg?: string): Promise<MigrationResult> {
  const result: MigrationResult = { migrated: 0, rowsDeleted: 0, envBlanked: [] }
  requireUnlocked('the credential store (migration)')
  const sid = sidArg ?? actingSid()
  if (!sid) throw new VaultLockedError('the credential store (migration needs a signed-in Owner)')

  const broker  = getBroker()
  const envPath = envFilePath()
  const envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : null
  const fileEnv = envText !== null ? parseEnv(envText) : new Map<string, string>()
  const envValue = (k: string): string | undefined => {
    const v = process.env[k] || fileEnv.get(k)
    return v ? v : undefined
  }

  // 1. Old store
  let rows: CredentialRow[] = []
  try {
    rows = await table().credential.findMany()
  } catch (e: any) {
    throw new Error(`Migration: cannot read the old credential table (${e?.message ?? e})`)
  }

  // ENCRYPTION_KEY may already be gone from process.env if a previous run blanked .env and this run
  // still has rows left (e.g. a failed delete); fall back to the backup's copy.
  if (rows.length && !process.env.ENCRYPTION_KEY) {
    const backup = envPath + '.pre-vault'
    const k = existsSync(backup) ? parseEnv(readFileSync(backup, 'utf8')).get('ENCRYPTION_KEY') : undefined
    if (k) process.env.ENCRYPTION_KEY = k
  }

  const pending = new Map<string, Record<string, string>>()   // item name → fields to add
  const migratedRowIds: string[] = []
  const add = (category: string, provider: string, key: string, value: string) => {
    const name = itemName(category, provider)
    const inVault = cachedSecret(name)?.fields[key]
    if (inVault !== undefined && inVault !== '') return      // vault already has it: vault wins
    const p = pending.get(name) ?? {}
    p[key] = value
    pending.set(name, p)
  }

  const undecryptable: string[] = []
  for (const row of rows) {
    const id3 = `${row.category}/${row.provider}/${row.key}`
    if (RETIRED_ROWS.has(id3)) { migratedRowIds.push(row.id); continue }
    let plain: string
    try { plain = decrypt(row.value) } catch { undecryptable.push(id3); continue }
    add(row.category, row.provider, row.key, plain)
    migratedRowIds.push(row.id)
  }
  if (undecryptable.length) {
    throw new Error(
      `Migration stopped: ${undecryptable.length} stored credential(s) cannot be decrypted with ENCRYPTION_KEY ` +
      `(${undecryptable.join(', ')}). Nothing was changed.`,
    )
  }

  const haveRow = new Set(rows.map(r => `${r.category}/${r.provider}/${r.key}`))
  for (const def of CREDENTIAL_DEFS) {
    if (!def.envKey || haveRow.has(`${def.category}/${def.provider}/${def.key}`)) continue
    const v = envValue(def.envKey)
    if (v) add(def.category, def.provider, def.key, v)
  }

  // 2. Write, then verify by reading the vault back.
  const now = new Date().toISOString()
  for (const [name, adds] of pending) {
    const prev = cachedSecret(name)
    const meta = readMeta(prev)
    for (const k of Object.keys(adds)) meta.updatedAt[k] = now
    const fields = { ...(prev?.fields ?? {}), ...adds }
    const saved = await broker.upsertSecret(sid, name, fields, writeMeta(meta))
    putCachedSecret({ name, id: saved.id, fields, notes: writeMeta(meta) })
    result.migrated += Object.keys(adds).length
  }

  if (pending.size) {
    const back = new Map((await broker.listSecrets(sid)).map(i => [i.name, i]))
    for (const [name, adds] of pending) {
      for (const [k, v] of Object.entries(adds)) {
        if (back.get(name)?.fields[k] !== v) {
          throw new Error(`Migration stopped: read-back of ${name} field "${k}" did not match. The old store was left in place.`)
        }
      }
    }
  }

  // 3. Retire the old store.
  if (migratedRowIds.length) {
    await table().credential.deleteMany({ where: { id: { in: migratedRowIds } } })
    result.rowsDeleted = migratedRowIds.length
  }

  if (envText !== null) {
    const keys = new Set([...RETIRED_ENV_KEYS, ...SECRET_ENV_KEYS])
    // Only blank a seeded secret the vault now really holds.
    for (const def of CREDENTIAL_DEFS) {
      if (!def.envKey || !keys.has(def.envKey) || RETIRED_ENV_KEYS.includes(def.envKey)) continue
      const v = cachedSecret(itemName(def.category, def.provider))?.fields[def.key]
      if (v === undefined || v === '') keys.delete(def.envKey)
    }
    const { text, blanked } = blankEnv(envText, keys)
    if (blanked.length) {
      const backup = envPath + '.pre-vault'
      const target = existsSync(backup) ? `${backup}.${Date.now()}` : backup
      writeFileSync(target, envText, { mode: 0o600 })
      chmodSync(target, 0o600)
      writeFileSync(envPath, text)
      result.backup = target
      result.envBlanked = blanked
    }
  }

  for (const k of RETIRED_ENV_KEYS) delete process.env[k]
  hydrateEnvFromVault()

  if (result.migrated || result.rowsDeleted || result.envBlanked.length) {
    console.log(
      `[credentials] Vault migration: ${result.migrated} value(s) moved, ${result.rowsDeleted} row(s) deleted, ` +
      `${result.envBlanked.length} .env key(s) blanked` + (result.backup ? ` (backup: ${result.backup} — delete it once you have checked HyperProx works)` : ''),
    )
  }
  return result
}
