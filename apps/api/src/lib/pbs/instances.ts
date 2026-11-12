// =============================================================================
//  HyperProx — Proxmox Backup Server: the servers HyperProx reads
//
//  Each backup server is an instance, kept in the vault through the credential
//  store, laid out as the QNAP and Home Assistant instances are:
//
//    plugin/pbs        instances   the list: names, stale threshold, pins. No
//                                  address, no token.
//    plugin/pbs.<id>   url, token_id, token_secret (masked): the read-only token,
//                      which every read uses.
//    plugin/pbs.<id>.manage   token_id, token_secret (masked): the manage token,
//                      only when backup management is turned on (lib/pbs/manage.ts),
//                      used by nothing but its delete, prune and clean-up actions.
//
//  The token goes only to the address it was entered for: a save that moves the
//  address to another host or port, or changes the token id, needs the secret
//  again in the same save, and drops the pin (it belongs to one host and port).
// =============================================================================

import crypto from 'node:crypto'
import { normaliseFingerprint } from '../clusters/tls-pin'
import { DEFAULT_STALE_HOURS } from './parse'
import type { PbsPin } from './transport'

export const PLUGIN_ID = 'pbs'
export const CATEGORY = 'plugin'
export const INDEX_KEY = 'instances'
export const MAX_INSTANCES = 20
export const DEFAULT_PORT = 8007
const ID_RE = /^p[0-9a-f]{8}$/
/** user@realm!tokenname, as PBS names an API token. */
export const TOKEN_ID_RE = /^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9._-]{1,32}![A-Za-z0-9._-]{1,64}$/
const SECRET_RE = /^[A-Za-z0-9._~+/=-]{8,256}$/

export interface PbsMeta {
  id:         string
  name:       string
  /** A group whose newest snapshot is older than this many hours is stale. */
  staleHours: number
  pin:        PbsPin | null
  /** Backup management (opt-in): the manage token's id and the datastores it has DatastoreAdmin on. Null: off. */
  manage:     { tokenId: string; stores: string[]; at: string } | null
}

export interface PbsView extends PbsMeta { url: string; tokenId: string; hasSecret: boolean }

export interface CredentialIO {
  get(category: string, provider: string, key: string): Promise<string | null>
  set(category: string, provider: string, key: string, value: string, masked: boolean): Promise<void>
  remove(category: string, provider: string): Promise<void>
}

export class PbsInputError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'PbsInputError' }
}

export const providerFor = (id: string) => `${PLUGIN_ID}.${id}`
export const manageProviderFor = (id: string) => `${PLUGIN_ID}.${id}.manage`
const STORE_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/

function cleanManage(v: any): PbsMeta['manage'] {
  if (!v || typeof v !== 'object' || typeof v.tokenId !== 'string' || !TOKEN_ID_RE.test(v.tokenId) || !Array.isArray(v.stores)) return null
  return { tokenId: v.tokenId, stores: v.stores.filter((s: unknown) => typeof s === 'string' && STORE_RE.test(s)).slice(0, 50), at: typeof v.at === 'string' ? v.at.slice(0, 40) : '' }
}
export const validInstanceId = (id: string) => ID_RE.test(id)

export function cleanName(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim() : ''
  if (!s) throw new PbsInputError('Give the backup server a name, such as "Backups".')
  if (s.length > 40) throw new PbsInputError('Keep the name to 40 characters.')
  return s
}

/** https://host[:port] with nothing else. No port means PBS's own 8007. */
export function cleanUrl(v: unknown): string {
  const s = typeof v === 'string' ? v.trim().replace(/\/+$/, '') : ''
  let u: URL
  try { u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`) } catch { throw new PbsInputError('The address must be the backup server, such as https://10.0.0.30:8007.') }
  if (u.protocol !== 'https:') throw new PbsInputError('A backup server is reached over https:// (its API has no plain http).')
  if (u.username || u.password) throw new PbsInputError('Leave the login out of the address; the token is entered separately.')
  if (u.search || u.hash || (u.pathname && u.pathname !== '/')) throw new PbsInputError('The address is the server itself, with no path (https://10.0.0.30:8007).')
  return `https://${u.hostname.includes(':') && !u.hostname.startsWith('[') ? `[${u.hostname}]` : u.hostname}:${u.port || DEFAULT_PORT}`
}

export function cleanTokenId(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!TOKEN_ID_RE.test(s)) throw new PbsInputError('The token id looks like user@realm!name, for example hyperprox@pbs!readonly.')
  return s
}

export function cleanSecret(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!SECRET_RE.test(s)) throw new PbsInputError('Paste the token secret PBS showed when the token was made.')
  return s
}

export function cleanStaleHours(v: unknown, prev: number): number {
  if (v === undefined || v === null || v === '') return prev
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 24 * 60) throw new PbsInputError('Stale after is a whole number of hours, 1 to 1440.')
  return n
}

function cleanPin(v: any): PbsPin | null {
  if (!v || typeof v !== 'object') return null
  const f = typeof v.fingerprint === 'string' ? normaliseFingerprint(v.fingerprint) : null
  if (!f) return null
  return { fingerprint: f, source: v.source === 'ca' ? 'ca' : 'first-use', at: typeof v.at === 'string' ? v.at.slice(0, 40) : new Date(0).toISOString() }
}

function parseIndex(raw: string | null): PbsMeta[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter(x => x && typeof x.id === 'string' && validInstanceId(x.id) && typeof x.name === 'string').map(x => ({
      id: x.id, name: String(x.name).slice(0, 40),
      staleHours: Number.isInteger(x.staleHours) && x.staleHours >= 1 && x.staleHours <= 1440 ? x.staleHours : DEFAULT_STALE_HOURS,
      pin: cleanPin(x.pin),
      manage: cleanManage(x.manage),
    }))
  } catch { return [] }
}

const endpointOf = (url: string) => { const u = new URL(url); return `${u.hostname}:${u.port || DEFAULT_PORT}`.toLowerCase() }

export interface PbsInput { name?: unknown; url?: unknown; tokenId?: unknown; secret?: unknown; staleHours?: unknown }

export class PbsInstanceStore {
  private chain: Promise<unknown> = Promise.resolve()
  constructor(private io: CredentialIO) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }

  async list(): Promise<PbsMeta[]> { return parseIndex(await this.io.get(CATEGORY, PLUGIN_ID, INDEX_KEY)) }

  async get(id: string): Promise<PbsMeta | null> {
    if (!validInstanceId(id)) return null
    return (await this.list()).find(i => i.id === id) ?? null
  }

  async views(): Promise<PbsView[]> {
    const out: PbsView[] = []
    for (const m of await this.list()) {
      const p = providerFor(m.id)
      out.push({ ...m, url: (await this.io.get(CATEGORY, p, 'url')) ?? '', tokenId: (await this.io.get(CATEGORY, p, 'token_id')) ?? '', hasSecret: !!(await this.io.get(CATEGORY, p, 'token_secret')) })
    }
    return out
  }

  /** Address and token, for the connection only. Never returned by a route. */
  async connection(id: string): Promise<{ meta: PbsMeta; url: string; tokenId: string; secret: string } | null> {
    const meta = await this.get(id)
    if (!meta) return null
    const p = providerFor(id)
    const [url, tokenId, secret] = await Promise.all([this.io.get(CATEGORY, p, 'url'), this.io.get(CATEGORY, p, 'token_id'), this.io.get(CATEGORY, p, 'token_secret')])
    if (!url || !tokenId || !secret) return null
    return { meta, url, tokenId, secret }
  }

  /** The server already stored at this address (host and port), if any. */
  async findByEndpoint(url: string): Promise<PbsMeta | null> {
    const want = endpointOf(url)
    for (const m of await this.list()) {
      const u = await this.io.get(CATEGORY, providerFor(m.id), 'url')
      if (u && endpointOf(u) === want) return m
    }
    return null
  }

  /** Store a server whose address, token and pin the caller has already checked by connecting. */
  async create(v: { name: string; url: string; tokenId: string; secret: string; staleHours: number; pin: PbsPin }): Promise<PbsMeta> {
    return this.serial(async () => {
      const list = await this.list()
      if (list.length >= MAX_INSTANCES) throw new PbsInputError(`HyperProx holds up to ${MAX_INSTANCES} backup servers.`)
      if (list.some(i => i.name.toLowerCase() === v.name.toLowerCase())) throw new PbsInputError('Another backup server already has that name.', 409)
      const meta: PbsMeta = { id: `p${crypto.randomBytes(4).toString('hex')}`, name: v.name, staleHours: v.staleHours, pin: v.pin, manage: null }
      const p = providerFor(meta.id)
      await this.io.set(CATEGORY, p, 'url', v.url, false)
      await this.io.set(CATEGORY, p, 'token_id', v.tokenId, false)
      await this.io.set(CATEGORY, p, 'token_secret', v.secret, true)
      await this.io.set(CATEGORY, PLUGIN_ID, INDEX_KEY, JSON.stringify([...list, meta]), false)
      return meta
    })
  }

  /**
   * What an update would change, checked before anything is written: whether it moves the token to another
   * address (then the secret must come again, and the pin is dropped for a new one).
   */
  async planUpdate(id: string, input: PbsInput): Promise<{ prev: PbsMeta; name: string; url: string; tokenId: string; secret: string | null; staleHours: number; moved: boolean; credentialChanged: boolean }> {
    const list = await this.list()
    const prev = list.find(i => i.id === id)
    if (!prev) throw new PbsInputError('No such backup server.', 404)
    const name = input.name === undefined ? prev.name : cleanName(input.name)
    if (list.some(i => i.id !== id && i.name.toLowerCase() === name.toLowerCase())) throw new PbsInputError('Another backup server already has that name.', 409)
    const p = providerFor(id)
    const oldUrl = (await this.io.get(CATEGORY, p, 'url')) ?? ''
    const oldToken = (await this.io.get(CATEGORY, p, 'token_id')) ?? ''
    const url = input.url === undefined ? oldUrl : cleanUrl(input.url)
    const tokenId = input.tokenId === undefined ? oldToken : cleanTokenId(input.tokenId)
    const moved = !oldUrl || endpointOf(url) !== endpointOf(oldUrl)
    const secret = input.secret === undefined || input.secret === '' ? null : cleanSecret(input.secret)
    if ((moved || tokenId !== oldToken) && !secret) throw new PbsInputError('The address or token id changed, so paste the token secret again in the same save.')
    return { prev, name, url, tokenId, secret, staleHours: cleanStaleHours(input.staleHours, prev.staleHours), moved, credentialChanged: moved || tokenId !== oldToken || !!secret }
  }

  async write(id: string, v: { name: string; url: string; tokenId: string; secret: string | null; staleHours: number; pin: PbsPin | null }): Promise<PbsMeta> {
    return this.serial(async () => {
      const list = await this.list()
      if (!list.some(i => i.id === id)) throw new PbsInputError('No such backup server.', 404)
      const p = providerFor(id)
      const next: PbsMeta = { id, name: v.name, staleHours: v.staleHours, pin: v.pin, manage: list.find(i => i.id === id)!.manage }
      if ((await this.io.get(CATEGORY, p, 'url')) !== v.url) await this.io.set(CATEGORY, p, 'url', v.url, false)
      if ((await this.io.get(CATEGORY, p, 'token_id')) !== v.tokenId) await this.io.set(CATEGORY, p, 'token_id', v.tokenId, false)
      if (v.secret) await this.io.set(CATEGORY, p, 'token_secret', v.secret, true)
      await this.io.set(CATEGORY, PLUGIN_ID, INDEX_KEY, JSON.stringify(list.map(i => (i.id === id ? next : i))), false)
      return next
    })
  }

  /** The manage token, for the manage actions only. Never returned by a route. */
  async manageConnection(id: string): Promise<{ tokenId: string; secret: string; stores: string[] } | null> {
    const meta = await this.get(id)
    if (!meta?.manage) return null
    const [tokenId, secret] = await Promise.all([this.io.get(CATEGORY, manageProviderFor(id), 'token_id'), this.io.get(CATEGORY, manageProviderFor(id), 'token_secret')])
    if (!tokenId || !secret || tokenId !== meta.manage.tokenId) return null
    return { tokenId, secret, stores: meta.manage.stores }
  }

  /** Turn backup management on (store the manage token in its own vault item) or off (delete that item). */
  async setManage(id: string, v: { tokenId: string; secret: string; stores: string[]; at: string } | null): Promise<PbsMeta> {
    return this.serial(async () => {
      const list = await this.list()
      const prev = list.find(i => i.id === id)
      if (!prev) throw new PbsInputError('No such backup server.', 404)
      const mp = manageProviderFor(id)
      if (v) {
        await this.io.set(CATEGORY, mp, 'token_id', v.tokenId, false)
        await this.io.set(CATEGORY, mp, 'token_secret', v.secret, true)
      } else await this.io.remove(CATEGORY, mp)
      const next: PbsMeta = { ...prev, manage: v ? { tokenId: v.tokenId, stores: [...v.stores], at: v.at } : null }
      await this.io.set(CATEGORY, PLUGIN_ID, INDEX_KEY, JSON.stringify(list.map(i => (i.id === id ? next : i))), false)
      return next
    })
  }

  async remove(id: string): Promise<void> {
    return this.serial(async () => {
      const list = await this.list()
      const m = list.find(i => i.id === id)
      if (!m) throw new PbsInputError('No such backup server.', 404)
      // A manage token left behind on the server would be a delete key nobody is watching: turn it off first.
      if (m.manage) throw new PbsInputError('Backup management is on for this server. Turn it off first (that deletes its manage token on the server), then remove the server.', 409)
      await this.io.remove(CATEGORY, providerFor(id))
      await this.io.set(CATEGORY, PLUGIN_ID, INDEX_KEY, JSON.stringify(list.filter(i => i.id !== id)), false)
    })
  }
}
