// =============================================================================
//  HyperProx — DNS providers, and which one serves each domain
//
//  HyperProx can hold credentials for more than one DNS provider (GoDaddy, Cloudflare). Each domain is
//  served by whichever configured provider holds its zone. When two do (a domain registered at GoDaddy
//  whose DNS moved to Cloudflare shows in both), the one where the zone is active wins, and an active
//  Cloudflare zone beats a GoDaddy listing: Cloudflare only calls a zone active once the domain's
//  nameservers point at it, while GoDaddy lists every domain registered there wherever its DNS lives.
//
//  Every caller (the DNS page, the website and catalogue wizards, the AI's read-only facts) goes through
//  DnsRouter, which offers the GoDaddy-shaped calls those callers already used: record names are relative
//  to the zone, '@' at the apex. Before anything reaches a provider:
//    - the domain is a checked hostname (checkedDomain), and must be a zone some provider lists;
//    - the record type is on an allowlist, and the record name is letters, digits, '-', '_' and '.', with
//      an optional leading '*.' label;
//    - a record body is copied field by field from an allowlist; nothing else the browser sends is passed on.
//
//  Cloudflare records HyperProx creates are DNS only (grey cloud) unless `proxied: true` is asked for:
//  proxying breaks Let's Encrypt's HTTP-01 check in the proxy and every port Cloudflare does not forward.
//  An edit that does not say otherwise keeps a record's current proxied setting.
// =============================================================================

import { isIPv4, isIPv6 } from 'node:net'
import { GoDaddyClient, checkedDomain, checkedType, DNSInputError, type DNSRecordType } from './godaddy-client'
import { CloudflareClient, CloudflareError, type CfRecord, type CfRecordBody, type CfZone } from './cloudflare-client'
import { getProviderCredentials } from './credentials'

export type DnsProviderId = 'godaddy' | 'cloudflare'
export const PROVIDER_LABEL: Record<DnsProviderId, string> = { godaddy: 'GoDaddy', cloudflare: 'Cloudflare' }

/** A record as callers see it, whatever the provider: GoDaddy's shape, plus Cloudflare's proxy flag and id. */
export interface ZoneRecord {
  type: string; name: string; data: string; ttl: number
  priority?: number; port?: number; weight?: number; service?: string; protocol?: string
  /** Cloudflare only: traffic goes through Cloudflare (orange cloud). */
  proxied?: boolean
  /** Cloudflare only: whether this record may be proxied at all. */
  proxiable?: boolean
  /** Cloudflare only: the record's id, to edit or delete one value of a name that has several. */
  id?: string
}

export interface RecordInput {
  type: string; name: string; data: string; ttl?: number
  priority?: number; port?: number; weight?: number; service?: string; protocol?: string; proxied?: boolean
}

/** A zone as callers see it; GoDaddy's registrar fields are kept where GoDaddy sends them. */
export interface ProviderZone {
  domain: string; provider: DnsProviderId; status: string; active: boolean
  nameServers?: string[] | null
  [k: string]: unknown
}

export interface ZoneBackend {
  id: DnsProviderId
  zones(): Promise<ProviderZone[]>
  getDomain(zone: string): Promise<Record<string, unknown>>
  getRecords(zone: string, type?: string): Promise<ZoneRecord[]>
  getRecordsByName(zone: string, type: string, name: string): Promise<ZoneRecord[]>
  createRecord(zone: string, rec: RecordInput): Promise<void>
  updateRecord(zone: string, type: string, name: string, rec: Partial<RecordInput>, opts?: { id?: string }): Promise<void>
  replaceRecords(zone: string, type: string, name: string, recs: Array<Omit<RecordInput, 'type' | 'name'>>): Promise<void>
  deleteRecord(zone: string, type: string, name: string, opts?: { id?: string }): Promise<void>
  /** Point one existing record at new data (DDNS). */
  setRecordData(zone: string, rec: ZoneRecord, data: string): Promise<void>
}

// --- Checks shared by every provider -----------------------------------------------------

const NAME_LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/
/** The record name relative to its zone: '@', or labels, optionally starting with a '*' label. */
export function checkedRecordName(name: unknown): string {
  const n = String(name ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (n === '@' || n === '*') return n
  if (!n || n.length > 253) throw new DNSInputError('That is not a record name.')
  const labels = n.split('.')
  if (!labels.every((l, i) => (i === 0 && l === '*') || NAME_LABEL.test(l))) throw new DNSInputError('That is not a record name.')
  return n
}

/** Plain domain, lowercased and unencoded (checkedDomain returns it encoded for a URL path). */
export function plainDomain(d: unknown): string { return decodeURIComponent(checkedDomain(d)) }

const intIn = (v: unknown, lo: number, hi: number, what: string): number => {
  const n = Number(v)
  if (!Number.isInteger(n) || n < lo || n > hi) throw new DNSInputError(`${what} must be a whole number from ${lo} to ${hi}.`)
  return n
}

/** Copy only the record fields HyperProx knows; type and name checked. Whatever else was sent is dropped. */
export function pickRecord(raw: any): RecordInput {
  if (!raw || typeof raw !== 'object') throw new DNSInputError('A record needs a type, a name and a value.')
  const out: RecordInput = { type: checkedType(raw.type), name: checkedRecordName(raw.name), data: String(raw.data ?? '') }
  if (raw.ttl !== undefined) out.ttl = intIn(raw.ttl, 1, 604800, 'TTL')
  if (raw.priority !== undefined) out.priority = intIn(raw.priority, 0, 65535, 'Priority')
  if (raw.port !== undefined) out.port = intIn(raw.port, 0, 65535, 'Port')
  if (raw.weight !== undefined) out.weight = intIn(raw.weight, 0, 65535, 'Weight')
  if (raw.service !== undefined) out.service = checkedRecordName(raw.service)
  if (raw.protocol !== undefined) out.protocol = checkedRecordName(raw.protocol)
  if (raw.proxied !== undefined) out.proxied = raw.proxied === true
  return out
}

/** The same, for an edit: the type and name come from the path, so neither is required in the body. */
export function pickRecordPatch(raw: any): Partial<RecordInput> {
  const r = raw && typeof raw === 'object' ? raw : {}
  const out: Partial<RecordInput> = {}
  if (r.data !== undefined) out.data = String(r.data)
  if (r.ttl !== undefined) out.ttl = intIn(r.ttl, 1, 604800, 'TTL')
  if (r.priority !== undefined) out.priority = intIn(r.priority, 0, 65535, 'Priority')
  if (r.port !== undefined) out.port = intIn(r.port, 0, 65535, 'Port')
  if (r.weight !== undefined) out.weight = intIn(r.weight, 0, 65535, 'Weight')
  if (r.proxied !== undefined) out.proxied = r.proxied === true
  return out
}

// --- GoDaddy -----------------------------------------------------------------------------

export function godaddyBackend(gd: Pick<GoDaddyClient, 'getDomains' | 'getDomain' | 'getRecords' | 'getRecordsByName' | 'createRecord' | 'updateRecord' | 'replaceRecords' | 'deleteRecord'>): ZoneBackend {
  const strip = ({ proxied: _p, ...r }: any) => r
  return {
    id: 'godaddy',
    async zones() {
      return ((await gd.getDomains()) ?? []).map(d => ({ ...d, domain: String(d.domain).toLowerCase(), provider: 'godaddy' as const, status: d.status, active: /^active$/i.test(String(d.status)) }))
    },
    getDomain: async zone => ({ ...(await gd.getDomain(zone)), provider: 'godaddy' }),
    getRecords: async (zone, type) => ((await gd.getRecords(zone, type as DNSRecordType | undefined)) ?? []) as ZoneRecord[],
    getRecordsByName: async (zone, type, name) => ((await gd.getRecordsByName(zone, type as DNSRecordType, name)) ?? []) as ZoneRecord[],
    async createRecord(zone, rec) {
      if (rec.proxied) throw new DNSInputError('GoDaddy has no proxy setting; only Cloudflare records can be proxied.')
      await gd.createRecord(zone, strip({ ...rec, ttl: rec.ttl ?? 600 }))
    },
    async updateRecord(zone, type, name, rec) {
      if (rec.proxied) throw new DNSInputError('GoDaddy has no proxy setting; only Cloudflare records can be proxied.')
      await gd.updateRecord(zone, type as DNSRecordType, name, strip(rec))
    },
    replaceRecords: (zone, type, name, recs) => gd.replaceRecords(zone, type as DNSRecordType, name, recs.map(r => strip({ ...r, ttl: r.ttl ?? 600 })) as any),
    deleteRecord: (zone, type, name) => gd.deleteRecord(zone, type as DNSRecordType, name),
    setRecordData: (zone, rec, data) => gd.updateRecord(zone, rec.type as DNSRecordType, rec.name, { ...strip(rec), data }),
  }
}

// --- Cloudflare --------------------------------------------------------------------------

/** The record types HyperProx writes at Cloudflare. Others in a zone are listed, never written. */
export const CLOUDFLARE_WRITE_TYPES = new Set(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'SRV', 'CAA'])
const PROXIABLE = new Set(['A', 'AAAA', 'CNAME'])
const HOSTNAME = /^(?=.{1,253}\.?$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.?$/i
const CAA_RE = /^(\d{1,3})\s+(issue|issuewild|iodef)\s+"?([^"]*)"?$/i

const fqdnOf = (zone: string, rel: string) => (rel === '@' ? zone : `${rel}.${zone}`)
const relOf = (zone: string, fqdn: string) => {
  const n = String(fqdn ?? '').toLowerCase().replace(/\.$/, '')
  return n === zone ? '@' : n.endsWith('.' + zone) ? n.slice(0, -(zone.length + 1)) : n
}
const unquote = (s: string) => (s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s)

function fromCf(zone: string, r: CfRecord): ZoneRecord {
  const name = relOf(zone, r.name)
  const out: ZoneRecord = { type: r.type, name, data: String(r.content ?? ''), ttl: Number(r.ttl) || 1, id: r.id }
  if (typeof r.proxied === 'boolean') out.proxied = r.proxied
  if (typeof r.proxiable === 'boolean') out.proxiable = r.proxiable
  if (r.type === 'MX' && r.priority !== undefined) out.priority = r.priority
  if (r.type === 'SRV' && r.data) {
    const d = r.data as any
    out.data = String(d.target ?? ''); out.priority = Number(d.priority); out.weight = Number(d.weight); out.port = Number(d.port)
    const [svc, proto] = name.split('.')
    if (svc?.startsWith('_')) out.service = svc
    if (proto?.startsWith('_')) out.protocol = proto
  }
  if (r.type === 'CAA' && r.data && !r.content) {
    const d = r.data as any
    out.data = `${d.flags ?? 0} ${d.tag ?? ''} "${d.value ?? ''}"`
  }
  if (r.type === 'TXT') out.data = unquote(out.data)
  return out
}

/** A Cloudflare record body from a checked record; the value is checked for its type. */
function toCf(zone: string, rec: RecordInput | (Partial<RecordInput> & { type: string; name: string }), keepProxied?: boolean): CfRecordBody {
  const type = rec.type
  if (!CLOUDFLARE_WRITE_TYPES.has(type)) throw new DNSInputError(`HyperProx writes ${[...CLOUDFLARE_WRITE_TYPES].join(', ')} records at Cloudflare, not ${type}.`)
  let rel = rec.name
  if (type === 'SRV' && rec.service && rec.protocol && !rel.startsWith('_')) rel = `${rec.service}.${rec.protocol}${rel === '@' ? '' : `.${rel}`}`
  const name = fqdnOf(zone, rel)
  const data = String(rec.data ?? '').trim()
  const proxied = rec.proxied ?? keepProxied ?? false
  if (proxied && !PROXIABLE.has(type)) throw new DNSInputError(`A ${type} record cannot be proxied through Cloudflare; only A, AAAA and CNAME can.`)
  // TTL 1 is Cloudflare's "Auto"; a proxied record is always Auto.
  let ttl = rec.ttl ?? 1
  if (ttl !== 1 && (ttl < 60 || ttl > 86400)) throw new DNSInputError('A Cloudflare TTL is Auto (1) or 60 to 86400 seconds.')
  if (proxied) ttl = 1
  const body: CfRecordBody = { type, name, ttl, proxied: PROXIABLE.has(type) ? proxied : undefined }
  switch (type) {
    case 'A': if (!isIPv4(data)) throw new DNSInputError('An A record needs an IPv4 address.'); body.content = data; break
    case 'AAAA': if (!isIPv6(data)) throw new DNSInputError('An AAAA record needs an IPv6 address.'); body.content = data; break
    case 'CNAME': if (!HOSTNAME.test(data)) throw new DNSInputError('A CNAME record needs a hostname.'); body.content = data.replace(/\.$/, ''); break
    case 'MX':
      if (!HOSTNAME.test(data)) throw new DNSInputError('An MX record needs a mail server hostname.')
      body.content = data.replace(/\.$/, ''); body.priority = rec.priority ?? 10; break
    case 'TXT':
      if (!data || data.length > 4096 || /[\u0000-\u001f\u007f]/.test(data)) throw new DNSInputError('A TXT record needs a value of printable text, up to 4096 characters.')
      body.content = data; break
    case 'SRV':
      if (!HOSTNAME.test(data)) throw new DNSInputError('An SRV record needs a target hostname.')
      if (!/^_[a-z0-9-]+\._(tcp|udp|tls)(\.|$)/.test(rel)) throw new DNSInputError('An SRV record name starts with _service._protocol (for example _sip._tcp).')
      body.data = { priority: rec.priority ?? 0, weight: rec.weight ?? 0, port: intIn(rec.port, 0, 65535, 'Port'), target: data.replace(/\.$/, '') }
      break
    case 'CAA': {
      const m = CAA_RE.exec(data)
      if (!m) throw new DNSInputError('A CAA record looks like: 0 issue "letsencrypt.org".')
      body.data = { flags: intIn(m[1], 0, 255, 'CAA flags'), tag: m[2].toLowerCase(), value: m[3] }
      break
    }
  }
  return body
}

export function cloudflareBackend(cf: Pick<CloudflareClient, 'listZones' | 'listRecords' | 'createRecord' | 'updateRecord' | 'deleteRecord'>): ZoneBackend {
  let zonesP: Promise<CfZone[]> | null = null
  const zones = () => (zonesP ??= cf.listZones().catch(e => { zonesP = null; throw e }))
  async function zoneId(zone: string): Promise<string> {
    const z = (await zones()).find(x => String(x.name).toLowerCase() === zone)
    if (!z) throw new DNSInputError(`${zone} is not a zone on this Cloudflare account.`)
    return z.id
  }
  async function named(zone: string, type: string, rel: string): Promise<{ id: string; recs: CfRecord[] }> {
    const id = await zoneId(zone)
    const fq = fqdnOf(zone, rel)
    const recs = (await cf.listRecords(id, { type, name: fq })).filter(r => r.type === type && String(r.name).toLowerCase() === fq)
    return { id, recs }
  }
  return {
    id: 'cloudflare',
    async zones() {
      return (await zones()).map(z => ({ domain: String(z.name).toLowerCase(), provider: 'cloudflare' as const, status: z.status,
        active: z.status === 'active', nameServers: z.name_servers ?? null, createdAt: z.created_on, paused: z.paused === true }))
    },
    async getDomain(zone) {
      const z = (await zones()).find(x => String(x.name).toLowerCase() === zone)
      if (!z) throw new DNSInputError(`${zone} is not a zone on this Cloudflare account.`)
      return { domain: zone, provider: 'cloudflare', status: z.status, active: z.status === 'active', nameServers: z.name_servers ?? null, createdAt: z.created_on, paused: z.paused === true }
    },
    async getRecords(zone, type) {
      return (await cf.listRecords(await zoneId(zone), type ? { type } : {})).map(r => fromCf(zone, r))
    },
    async getRecordsByName(zone, type, name) {
      return (await named(zone, type, name)).recs.map(r => fromCf(zone, r))
    },
    async createRecord(zone, rec) {
      await cf.createRecord(await zoneId(zone), toCf(zone, rec))
    },
    async updateRecord(zone, type, name, rec, opts = {}) {
      const { id, recs } = await named(zone, type, name)
      const target = opts.id ? recs.find(r => r.id === opts.id) : recs.length === 1 ? recs[0] : undefined
      if (opts.id && !target) throw new DNSInputError(`No ${type} record ${name} with that id in ${zone}.`)
      if (!target && recs.length > 1) throw new DNSInputError(`${name} has ${recs.length} ${type} records in ${zone}; edit one of them by its id.`)
      const current = target ? fromCf(zone, target) : undefined
      const merged = { ...(current ?? {}), ...rec, type, name } as RecordInput
      if (merged.data === undefined) throw new DNSInputError('A record needs a value.')
      // A record already proxied stays proxied unless the edit says otherwise.
      const body = toCf(zone, merged, target?.proxied)
      if (target) await cf.updateRecord(id, target.id, body)
      else await cf.createRecord(id, body)
    },
    async replaceRecords(zone, type, name, wanted) {
      if (!wanted.length) throw new Error('replaceRecords needs at least one record; use deleteRecord to remove a name')
      const { id, recs } = await named(zone, type, name)
      const have = recs.map(r => ({ r, z: fromCf(zone, r) }))
      const keep = new Set<string>()
      for (const w of wanted) {
        const same = have.find(h => !keep.has(h.r.id) && h.z.data === String(w.data))
        if (same) { keep.add(same.r.id); continue }
        await cf.createRecord(id, toCf(zone, { ...w, type, name } as RecordInput))
      }
      for (const h of have) if (!keep.has(h.r.id)) await cf.deleteRecord(id, h.r.id)
    },
    async deleteRecord(zone, type, name, opts = {}) {
      const { id, recs } = await named(zone, type, name)
      const doomed = opts.id ? recs.filter(r => r.id === opts.id) : recs
      if (opts.id && !doomed.length) throw new DNSInputError(`No ${type} record ${name} with that id in ${zone}.`)
      for (const r of doomed) await cf.deleteRecord(id, r.id)
    },
    async setRecordData(zone, rec, data) {
      if (!rec.id) throw new DNSInputError('That Cloudflare record has no id.')
      await cf.updateRecord(await zoneId(zone), rec.id, toCf(zone, { ...rec, data } as RecordInput, rec.proxied))
    },
  }
}

// --- Routing -----------------------------------------------------------------------------

export interface ProviderStatus { id: DnsProviderId; label: string; ok: boolean; zones: number; active: number; error?: string }

const rank = (z: ProviderZone) => (z.active ? (z.provider === 'cloudflare' ? 3 : 2) : 1)

export class DnsRouter {
  private discovered: Promise<{ chosen: Map<string, { backend: ZoneBackend; zone: ProviderZone }>; status: ProviderStatus[] }> | null = null
  constructor(readonly backends: ZoneBackend[]) {}

  /** Ask every provider for its zones once; a provider that fails is reported, and the others still serve. */
  private discover() {
    return (this.discovered ??= (async () => {
      const settled = await Promise.allSettled(this.backends.map(b => b.zones()))
      const chosen = new Map<string, { backend: ZoneBackend; zone: ProviderZone }>()
      const status: ProviderStatus[] = []
      settled.forEach((s, i) => {
        const b = this.backends[i]
        if (s.status === 'rejected') { status.push({ id: b.id, label: PROVIDER_LABEL[b.id], ok: false, zones: 0, active: 0, error: String(s.reason?.message ?? s.reason) }); return }
        status.push({ id: b.id, label: PROVIDER_LABEL[b.id], ok: true, zones: s.value.length, active: s.value.filter(z => z.active).length })
        for (const z of s.value) {
          const cur = chosen.get(z.domain)
          if (!cur || rank(z) > rank(cur.zone)) chosen.set(z.domain, { backend: b, zone: z })
        }
      })
      return { chosen, status }
    })())
  }

  async providers(): Promise<ProviderStatus[]> { return (await this.discover()).status }

  /** Every zone from every provider, each once, at the provider that serves it. */
  async getDomains(): Promise<ProviderZone[]> {
    const { chosen, status } = await this.discover()
    if (status.length && status.every(s => !s.ok)) throw new Error(status.map(s => `${s.label}: ${s.error}`).join('; '))
    return [...chosen.values()].map(c => c.zone).sort((a, b) => a.domain.localeCompare(b.domain))
  }

  /** The provider that serves `zone`; a domain no provider holds is refused, never guessed. */
  async route(zone: string): Promise<{ zone: string; backend: ZoneBackend }> {
    const z = plainDomain(zone)
    const { chosen, status } = await this.discover()
    const hit = chosen.get(z)
    if (!hit) {
      const failed = status.filter(x => !x.ok)
      throw new DNSInputError(`${z} is not a domain any configured DNS provider holds` +
        (failed.length ? ` (not answering: ${failed.map(x => `${x.label}: ${x.error}`).join('; ')}).` : '.'))
    }
    return { zone: z, backend: hit.backend }
  }

  async providerOf(zone: string): Promise<DnsProviderId> { return (await this.route(zone)).backend.id }

  async getDomain(zone: string) { const r = await this.route(zone); return r.backend.getDomain(r.zone) }
  async getRecords(zone: string, type?: string): Promise<ZoneRecord[]> {
    const r = await this.route(zone)
    return r.backend.getRecords(r.zone, type === undefined ? undefined : checkedType(type))
  }
  async getRecordsByName(zone: string, type: string, name: string): Promise<ZoneRecord[]> {
    const r = await this.route(zone)
    return r.backend.getRecordsByName(r.zone, checkedType(type), checkedRecordName(name))
  }
  async createRecord(zone: string, rec: unknown): Promise<void> {
    const r = await this.route(zone)
    await r.backend.createRecord(r.zone, pickRecord(rec))
  }
  async updateRecord(zone: string, type: string, name: string, rec: unknown, opts: { id?: string } = {}): Promise<void> {
    const r = await this.route(zone)
    await r.backend.updateRecord(r.zone, checkedType(type), checkedRecordName(name), pickRecordPatch(rec), opts.id ? { id: checkedCfId(opts.id) } : {})
  }
  async replaceRecords(zone: string, type: string, name: string, recs: Array<{ data: string; ttl: number; priority?: number }>): Promise<void> {
    const r = await this.route(zone)
    await r.backend.replaceRecords(r.zone, checkedType(type), checkedRecordName(name), recs.map(x => pickRecordPatch(x) as any))
  }
  async deleteRecord(zone: string, type: string, name: string, opts: { id?: string } = {}): Promise<void> {
    const r = await this.route(zone)
    await r.backend.deleteRecord(r.zone, checkedType(type), checkedRecordName(name), opts.id ? { id: checkedCfId(opts.id) } : {})
  }

  /** Every A record of the zone pointed at `wanIP`, except the names excluded. */
  async updateDDNS(zone: string, wanIP: string, excludeNames: string[] = []): Promise<{ updated: string[]; skipped: string[]; wanIP: string }> {
    const r = await this.route(zone)
    const updated: string[] = [], skipped: string[] = []
    for (const rec of await r.backend.getRecords(r.zone, 'A')) {
      if (excludeNames.includes(rec.name) || rec.data === wanIP) { skipped.push(rec.name); continue }
      await r.backend.setRecordData(r.zone, rec, wanIP)
      updated.push(rec.name)
    }
    return { updated, skipped, wanIP }
  }

  async getStats(zone: string): Promise<{ total: number; byType: Record<string, number>; proxied: number }> {
    const records = await this.getRecords(zone)
    const byType: Record<string, number> = {}
    for (const rec of records) byType[rec.type] = (byType[rec.type] ?? 0) + 1
    return { total: records.length, byType, proxied: records.filter(x => x.proxied).length }
  }
}

function checkedCfId(id: string): string {
  const s = String(id).trim().toLowerCase()
  if (!/^[a-f0-9]{32}$/.test(s)) throw new DNSInputError('That is not a record id.')
  return s
}

/** The sentence for a record proxied through Cloudflare, which no Let's Encrypt HTTP check or WAN lookup gets past. */
export function proxiedProblem(domain: string, wan: string): string {
  return `${domain} is proxied through Cloudflare (orange cloud), so it resolves to Cloudflare instead of ${wan} and Let's Encrypt's HTTP check cannot reach the proxy. ` +
    `Set the record to DNS only on the DNS page, then run this again.`
}

// --- From the vault ----------------------------------------------------------------------

/** A Global API Key is 37 hex characters; an API token is 40 characters of letters, digits, '-' and '_'. */
export const GLOBAL_KEY_RE = /^[a-f0-9]{37}$/i

/**
 * A Cloudflare client from the stored credential. The API token is the normal case. A Global API Key is used
 * only when the stored value has a Global API Key's shape AND an email is set: an email saved beside an
 * ordinary token is ignored, so it can never turn a token into the wrong kind of login.
 */
export function cloudflareFrom(creds: Record<string, string>, opts?: ConstructorParameters<typeof CloudflareClient>[1]): CloudflareClient | null {
  const token = String(creds.api_token ?? '').trim()
  if (!token) return null
  const email = String(creds.email ?? '').trim()
  return new CloudflareClient(email && GLOBAL_KEY_RE.test(token) ? { globalKey: token, email } : { token }, opts)
}

/** The providers with a credential stored. A locked vault throws, as every credential read does. */
export async function configuredBackends(): Promise<ZoneBackend[]> {
  const out: ZoneBackend[] = []
  const gd = await getProviderCredentials('dns', 'godaddy')
  if (gd.api_key && gd.api_secret) out.push(godaddyBackend(new GoDaddyClient(gd.api_key, gd.api_secret)))
  const cf = cloudflareFrom(await getProviderCredentials('dns', 'cloudflare'))
  if (cf) out.push(cloudflareBackend(cf))
  return out
}

/** A router over every configured provider, or null when none is set up. */
export async function dnsRouter(): Promise<DnsRouter | null> {
  const b = await configuredBackends()
  return b.length ? new DnsRouter(b) : null
}

export { CloudflareError, DNSInputError }
