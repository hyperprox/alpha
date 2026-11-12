// A pretend Cloudflare API v4, as a fetch stand-in. It answers only https://api.cloudflare.com/client/v4 and
// records every request, so a test can assert what was (and was not) sent. No real network is ever used.
import { randomBytes } from 'node:crypto'

export interface FakeZone { id: string; name: string; status: string; name_servers?: string[] }
export interface FakeRec { id: string; zone_id: string; type: string; name: string; content?: string; ttl: number; proxied?: boolean; proxiable?: boolean; priority?: number; data?: any }

export const hexId = () => randomBytes(16).toString('hex')

export class FakeCloudflare {
  zones: FakeZone[] = []
  records: FakeRec[] = []
  calls: Array<{ method: string; url: string; body?: any; auth: string }> = []
  token = { id: hexId(), status: 'active', expires_on: null as string | null, not_before: null as string | null }
  /** The token's permission groups, or null when it may not read itself (the usual case). */
  permissions: string[] | null = null
  validToken = 'cf-token-good-0000000000000000000000000'
  /** Zones per page Cloudflare returns, small so pagination is exercised. */
  pageSize = 2
  /** Answer the next N requests with 429. */
  rateLimit = 0
  retryAfter = '0'

  addZone(name: string, status = 'active'): FakeZone {
    const z = { id: hexId(), name, status, name_servers: ['ns1.example.net', 'ns2.example.net'] }
    this.zones.push(z); return z
  }
  addRecord(zone: FakeZone, r: Omit<FakeRec, 'id' | 'zone_id'>): FakeRec {
    const rec = { id: hexId(), zone_id: zone.id, proxiable: ['A', 'AAAA', 'CNAME'].includes(r.type), ...r }
    this.records.push(rec); return rec
  }

  private page<T>(all: T[], q: URLSearchParams) {
    const per = Math.min(Number(q.get('per_page') ?? 20), this.pageSize)
    const page = Number(q.get('page') ?? 1)
    const total_pages = Math.max(1, Math.ceil(all.length / per))
    return { result: all.slice((page - 1) * per, page * per), result_info: { page, per_page: per, total_pages, count: all.length } }
  }

  fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input))
    const method = String(init.method ?? 'GET')
    const body = init.body ? JSON.parse(init.body) : undefined
    const h = init.headers ?? {}
    const auth = String(h.Authorization ?? (h['X-Auth-Key'] ? `key:${h['X-Auth-Email']}:${h['X-Auth-Key']}` : ''))
    this.calls.push({ method, url: url.toString(), body, auth })
    if (url.origin !== 'https://api.cloudflare.com' || !url.pathname.startsWith('/client/v4/')) throw new Error(`unexpected host ${url}`)
    if (this.rateLimit > 0) { this.rateLimit--; return json(429, { success: false, errors: [{ code: 10000, message: 'Rate limited' }] }, { 'retry-after': this.retryAfter }) }
    const okAuth = auth === `Bearer ${this.validToken}` || auth.startsWith('key:')
    if (!okAuth) return json(401, { success: false, errors: [{ code: 1000, message: 'Invalid API Token' }], messages: [], result: null })
    const p = url.pathname.slice('/client/v4/'.length).split('/').map(decodeURIComponent)
    const q = url.searchParams

    if (p[0] === 'user' && p.length === 1) return json(200, { success: true, result: { id: 'u', email: 'admin@example.com' } })
    if (p[0] === 'user' && p[1] === 'tokens' && p[2] === 'verify') return json(200, { success: true, errors: [], result: { id: this.token.id, status: this.token.status, expires_on: this.token.expires_on, not_before: this.token.not_before } })
    if (p[0] === 'user' && p[1] === 'tokens' && p.length === 3) {
      if (!this.permissions) return json(403, { success: false, errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }] })
      return json(200, { success: true, result: { id: p[2], policies: [{ permission_groups: this.permissions.map(name => ({ id: hexId(), name })) }] } })
    }
    if (p[0] === 'zones' && p.length === 1) {
      const name = q.get('name')
      return json(200, { success: true, ...this.page(this.zones.filter(z => !name || z.name === name), q) })
    }
    if (p[0] === 'zones' && p[2] === 'dns_records') {
      const zone = this.zones.find(z => z.id === p[1])
      if (!zone) return json(404, { success: false, errors: [{ code: 7003, message: 'Could not route to /zones/x, perhaps your object identifier is invalid?' }] })
      if (p.length === 3 && method === 'GET') {
        const type = q.get('type'), name = q.get('name')
        return json(200, { success: true, ...this.page(this.records.filter(r => r.zone_id === zone.id && (!type || r.type === type) && (!name || r.name === name)), q) })
      }
      if (p.length === 3 && method === 'POST') {
        if (body.proxied && !['A', 'AAAA', 'CNAME'].includes(body.type)) return json(400, { success: false, errors: [{ code: 9004, message: 'This record type cannot be proxied.' }] })
        const rec = this.addRecord(zone, { ...body, proxied: ['A', 'AAAA', 'CNAME'].includes(body.type) ? body.proxied === true : undefined })
        return json(200, { success: true, result: rec })
      }
      const rec = this.records.find(r => r.zone_id === zone.id && r.id === p[3])
      if (!rec) return json(404, { success: false, errors: [{ code: 81044, message: 'Record does not exist.' }] })
      if (method === 'PATCH') { Object.assign(rec, body); return json(200, { success: true, result: rec }) }
      if (method === 'DELETE') { this.records = this.records.filter(r => r !== rec); return json(200, { success: true, result: { id: rec.id } }) }
    }
    return json(404, { success: false, errors: [{ code: 7000, message: 'No route for that URI' }] })
  }) as unknown as typeof fetch
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}
