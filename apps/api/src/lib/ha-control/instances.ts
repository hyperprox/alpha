// =============================================================================
//  HyperProx — Home Assistant control: instances
//
//  Each Home Assistant HyperProx talks to is an instance: a name, an address, a
//  token, optionally the HyperProx cluster it sits beside, and its safety
//  policy. Everything lives in the vault, through the credential store:
//
//    plugin/home-assistant            url, token, battery_warn — the plug-in's own
//                                     settings, exactly as before. This IS
//                                     instance #1 ("default"): its address and token
//                                     are never copied anywhere else.
//    plugin/home-assistant  instances the list of instances: names, cluster links,
//                                     policies. No address, no token.
//    plugin/home-assistant.<id>       url, token for every other instance.
//
//  Migration is therefore a read, not a move: with no list saved yet and the
//  plug-in configured, instance #1 is the plug-in's settings under the name
//  "Home". Nothing is written until someone edits an instance, so the plug-in's
//  card, its health page, its metrics and the assistant's summary behave
//  exactly as they did.
// =============================================================================

import crypto from 'node:crypto'
import { DEFAULT_POLICY, ENTITY_ID, type TierPolicy } from './catalog'

export const PLUGIN_ID = 'home-assistant'
export const CATEGORY = 'plugin'
export const DEFAULT_ID = 'default'
export const INDEX_KEY = 'instances'
const ID_RE = /^h[0-9a-f]{8}$/

export interface InstanceMeta {
  id:          string
  name:        string
  /** The HyperProx cluster this house sits beside (its panel shows the Devices view), or null. */
  clusterId:   string | null
  insecureTLS: boolean
  policy:      TierPolicy
}

export interface InstanceView extends InstanceMeta {
  url:      string
  hasToken: boolean
}

/** The credential store's calls, injected so tests run without a vault. */
export interface CredentialIO {
  get(category: string, provider: string, key: string): Promise<string | null>
  set(category: string, provider: string, key: string, value: string, masked: boolean): Promise<void>
  remove(category: string, provider: string): Promise<void>
}

export class InstanceInputError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'InstanceInputError' }
}

const providerFor = (id: string) => id === DEFAULT_ID ? PLUGIN_ID : `${PLUGIN_ID}.${id}`

export function validInstanceId(id: string): boolean { return id === DEFAULT_ID || ID_RE.test(id) }

function cleanName(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim() : ''
  if (!s) throw new InstanceInputError('Give the instance a name, such as "Home" or "Second home".')
  if (s.length > 40) throw new InstanceInputError('Keep the name to 40 characters.')
  return s
}

export function cleanUrl(v: unknown): string {
  const s = typeof v === 'string' ? v.trim().replace(/\/+$/, '') : ''
  let u: URL
  try { u = new URL(s) } catch { throw new InstanceInputError('The address must be a full URL, such as http://homeassistant.local:8123.') }
  if (!['http:', 'https:'].includes(u.protocol)) throw new InstanceInputError('The address must start with http:// or https://.')
  if (u.username || u.password) throw new InstanceInputError('Leave the login out of the address; the token is entered separately.')
  if (u.search || u.hash) throw new InstanceInputError('The address should not carry a query string.')
  return s
}

function cleanToken(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!/^[A-Za-z0-9._-]{20,1024}$/.test(s)) throw new InstanceInputError('That does not look like a Home Assistant long-lived access token.')
  return s
}

export function cleanPolicy(v: any, prev: TierPolicy = DEFAULT_POLICY): TierPolicy {
  if (v === undefined) return prev
  if (!v || typeof v !== 'object') throw new InstanceInputError('Safety settings must be an object.')
  const ids = (x: unknown, what: string): string[] => {
    if (x === undefined) return []
    if (!Array.isArray(x) || x.length > 500) throw new InstanceInputError(`${what} must be a list.`)
    for (const e of x) if (typeof e !== 'string' || !ENTITY_ID.test(e)) throw new InstanceInputError(`${what}: "${String(e).slice(0, 60)}" is not an entity id.`)
    return [...new Set(x as string[])]
  }
  const domains = (x: unknown): string[] => {
    if (x === undefined) return []
    if (!Array.isArray(x) || x.length > 30) throw new InstanceInputError('Extra security domains must be a list.')
    for (const e of x) if (typeof e !== 'string' || !/^[a-z_]{1,40}$/.test(e)) throw new InstanceInputError(`"${String(e).slice(0, 40)}" is not a domain.`)
    return [...new Set(x as string[])]
  }
  const role = v.normalRole ?? prev.normalRole
  if (role !== 'operator' && role !== 'admin') throw new InstanceInputError('Everyday controls are for operators or admins.')
  return {
    protected:       v.protected !== undefined ? ids(v.protected, 'Protected devices') : prev.protected,
    securityDomains: v.securityDomains !== undefined ? domains(v.securityDomains) : prev.securityDomains,
    normalRole:      role,
    notifySecurity:  v.notifySecurity === undefined ? prev.notifySecurity : v.notifySecurity === true,
  }
}

function parseIndex(raw: string | null): InstanceMeta[] | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return null
    return v.filter(x => x && typeof x.id === 'string' && validInstanceId(x.id) && typeof x.name === 'string').map(x => ({
      id: x.id, name: String(x.name).slice(0, 40),
      clusterId: typeof x.clusterId === 'string' ? x.clusterId : null,
      insecureTLS: x.id === DEFAULT_ID ? true : x.insecureTLS === true,
      policy: (() => { try { return cleanPolicy(x.policy ?? {}) } catch { return { ...DEFAULT_POLICY } } })(),
    }))
  } catch { return null }
}

export interface InstanceInput {
  name?: unknown; url?: unknown; token?: unknown; clusterId?: unknown; insecureTLS?: unknown; policy?: unknown
}

export class InstanceStore {
  constructor(private io: CredentialIO, private clusterExists: (id: string) => boolean = () => false) {}

  /** Every instance. Instance #1 is synthesised from the plug-in's own settings until the list is first saved. */
  async list(): Promise<InstanceMeta[]> {
    const saved = parseIndex(await this.io.get(CATEGORY, PLUGIN_ID, INDEX_KEY))
    const list = saved ?? []
    if (!list.some(i => i.id === DEFAULT_ID) && await this.io.get(CATEGORY, PLUGIN_ID, 'url')) {
      list.unshift({ id: DEFAULT_ID, name: 'Home', clusterId: null, insecureTLS: true, policy: { ...DEFAULT_POLICY } })
    }
    return list
  }

  async get(id: string): Promise<InstanceMeta | null> {
    if (!validInstanceId(id)) return null
    return (await this.list()).find(i => i.id === id) ?? null
  }

  async views(): Promise<InstanceView[]> {
    const out: InstanceView[] = []
    for (const m of await this.list()) {
      const p = providerFor(m.id)
      out.push({ ...m, url: (await this.io.get(CATEGORY, p, 'url')) ?? '', hasToken: !!(await this.io.get(CATEGORY, p, 'token')) })
    }
    return out
  }

  /** The address and token, for the connection only. Never returned by a route. */
  async connection(id: string): Promise<{ url: string; token: string; insecureTLS: boolean } | null> {
    const m = await this.get(id)
    if (!m) return null
    const p = providerFor(id)
    const url = await this.io.get(CATEGORY, p, 'url')
    const token = await this.io.get(CATEGORY, p, 'token')
    if (!url || !token) return null
    return { url, token, insecureTLS: m.insecureTLS }
  }

  private async saveIndex(list: InstanceMeta[]): Promise<void> {
    await this.io.set(CATEGORY, PLUGIN_ID, INDEX_KEY, JSON.stringify(list), false)
  }

  private cluster(v: unknown, prev: string | null): string | null {
    if (v === undefined) return prev
    if (v === null || v === '') return null
    if (typeof v !== 'string' || !this.clusterExists(v)) throw new InstanceInputError('That cluster is not one HyperProx manages.')
    return v
  }

  async create(input: InstanceInput): Promise<InstanceMeta> {
    const list = await this.list()
    if (list.length >= 20) throw new InstanceInputError('HyperProx holds up to 20 Home Assistant instances.')
    const name = cleanName(input.name)
    if (list.some(i => i.name.toLowerCase() === name.toLowerCase())) throw new InstanceInputError('Another instance already has that name.', 409)
    const url = cleanUrl(input.url)
    const token = cleanToken(input.token)
    // The first instance is the plug-in's own settings, so the card and the health page keep working from it.
    const id = list.some(i => i.id === DEFAULT_ID) ? `h${crypto.randomBytes(4).toString('hex')}` : DEFAULT_ID
    const meta: InstanceMeta = {
      id, name, clusterId: this.cluster(input.clusterId, null),
      insecureTLS: id === DEFAULT_ID ? true : input.insecureTLS === true,
      policy: cleanPolicy(input.policy),
    }
    const p = providerFor(id)
    await this.io.set(CATEGORY, p, 'url', url, false)
    await this.io.set(CATEGORY, p, 'token', token, true)
    await this.saveIndex([...list, meta])
    return meta
  }

  async update(id: string, input: InstanceInput): Promise<InstanceMeta> {
    const list = await this.list()
    const prev = list.find(i => i.id === id)
    if (!prev) throw new InstanceInputError('No such Home Assistant instance.', 404)
    const name = input.name === undefined ? prev.name : cleanName(input.name)
    if (list.some(i => i.id !== id && i.name.toLowerCase() === name.toLowerCase())) throw new InstanceInputError('Another instance already has that name.', 409)
    const next: InstanceMeta = {
      id, name, clusterId: this.cluster(input.clusterId, prev.clusterId),
      insecureTLS: id === DEFAULT_ID ? true : input.insecureTLS === undefined ? prev.insecureTLS : input.insecureTLS === true,
      policy: cleanPolicy(input.policy, prev.policy),
    }
    const p = providerFor(id)
    if (input.url !== undefined) await this.io.set(CATEGORY, p, 'url', cleanUrl(input.url), false)
    // An empty token means "keep the one stored", as every masked form in HyperProx does.
    if (input.token !== undefined && input.token !== '') await this.io.set(CATEGORY, p, 'token', cleanToken(input.token), true)
    await this.saveIndex(list.map(i => i.id === id ? next : i))
    return next
  }

  async remove(id: string): Promise<void> {
    const list = await this.list()
    if (!list.some(i => i.id === id)) throw new InstanceInputError('No such Home Assistant instance.', 404)
    if (id === DEFAULT_ID) throw new InstanceInputError('The first instance is the plug-in\'s own settings: clear them on the plug-in card instead.', 409)
    await this.io.remove(CATEGORY, providerFor(id))
    await this.saveIndex(list.filter(i => i.id !== id))
  }
}
