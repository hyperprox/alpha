// =============================================================================
//  HyperProx — Cloudflare DNS API client (API v4)
//
//  Authentication is a scoped API Token (Bearer), which is what Cloudflare recommends: give it Zone: Read and
//  DNS: Edit on the zones HyperProx should manage. The legacy Global API Key also works when an email is set
//  beside it (X-Auth-Email + X-Auth-Key); it can do anything on the account, so the token is the better choice.
//
//  Every value that goes into a URL path is checked first: zone and record ids are 32 hex characters, and
//  nothing else ever reaches the path. Names, types and filters go in the query string through URLSearchParams.
//  The base URL is fixed; a caller can never point a request anywhere else.
//
//  Cloudflare answers with { success, errors: [{ code, message }], result, result_info }. Errors become one
//  plain sentence; a 429 is retried after its Retry-After (bounded), then reported as a rate limit.
// =============================================================================

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'

const ID_RE = /^[a-f0-9]{32}$/

export class CloudflareError extends Error {
  /** 400 for bad input or a refused credential; 502 for Cloudflare failing. */
  statusCode: number
  codes: number[]
  constructor(message: string, statusCode = 502, codes: number[] = []) {
    super(message); this.statusCode = statusCode; this.codes = codes
  }
}

/** A Cloudflare zone or record id, checked before it goes into a path. */
export function checkedId(id: unknown, what = 'id'): string {
  const s = String(id ?? '').trim().toLowerCase()
  if (!ID_RE.test(s)) throw new CloudflareError(`That is not a Cloudflare ${what}.`, 400)
  return s
}

/** Cloudflare's error array as one plain sentence: "Invalid API Token (code 1000)". */
export function cfErrorMessage(body: any, status?: number): string {
  const list: any[] = Array.isArray(body?.errors) ? body.errors : []
  const parts = list.map(e => {
    const msg = String(e?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
    const chain = Array.isArray(e?.error_chain) ? e.error_chain.map((c: any) => String(c?.message ?? '').trim()).filter(Boolean) : []
    const text = [msg, ...chain].filter(Boolean).join(': ')
    return text ? (e?.code ? `${text} (code ${e.code})` : text) : ''
  }).filter(Boolean)
  if (parts.length) return parts.join('; ')
  return status ? `Cloudflare answered HTTP ${status}` : 'Cloudflare gave no answer'
}

export type CloudflareAuth = { token: string } | { globalKey: string; email: string }

export interface CloudflareOpts {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<unknown>
  /** Retries after a 429; default 2. */
  maxRetries?: number
}

export interface CfZone {
  id: string; name: string; status: string; paused?: boolean; type?: string
  name_servers?: string[]; original_registrar?: string | null; created_on?: string; activated_on?: string | null
}

export interface CfRecord {
  id: string; type: string; name: string; content?: string; ttl: number; proxied?: boolean; proxiable?: boolean
  priority?: number; data?: Record<string, unknown>; comment?: string | null
}

export interface CfRecordBody {
  type: string; name: string; content?: string; ttl: number; proxied?: boolean; priority?: number
  data?: Record<string, unknown>
}

export interface TokenStatus {
  id: string | null; status: string; expires_on?: string | null; not_before?: string | null
  /** A user's token (My Profile → API Tokens) or an account-owned token (Manage Account → API Tokens). */
  owner?: 'user' | 'account'
  account?: { id: string; name: string }
}

type Query = Record<string, string | number | undefined>

export class CloudflareClient {
  private headers: Record<string, string>
  private f: typeof fetch
  private sleep: (ms: number) => Promise<unknown>
  private maxRetries: number
  readonly authKind: 'token' | 'global-key'

  constructor(auth: CloudflareAuth, opts: CloudflareOpts = {}) {
    if ('token' in auth) {
      const t = String(auth.token ?? '').trim()
      if (!t || /\s/.test(t)) throw new CloudflareError('The Cloudflare API token is empty or malformed.', 400)
      this.headers = { Authorization: `Bearer ${t}` }
      this.authKind = 'token'
    } else {
      const k = String(auth.globalKey ?? '').trim(), e = String(auth.email ?? '').trim()
      if (!k || /\s/.test(k) || !e || /[\s\r\n]/.test(e)) throw new CloudflareError('The Cloudflare Global API Key or email is empty or malformed.', 400)
      this.headers = { 'X-Auth-Email': e, 'X-Auth-Key': k }
      this.authKind = 'global-key'
    }
    this.f = opts.fetch ?? fetch
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
    this.maxRetries = opts.maxRetries ?? 2
  }

  /** `segments` are joined as the path; each is encoded, and callers pass only fixed words and checked ids. */
  private async req<T = any>(method: string, segments: string[], opts: { query?: Query; body?: unknown } = {}): Promise<{ result: T; result_info?: any }> {
    const path = segments.map(s => encodeURIComponent(s)).join('/')
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== '') qs.set(k, String(v))
    const q = qs.toString()
    const url = `${CLOUDFLARE_API}/${path}${q ? `?${q}` : ''}`
    for (let attempt = 0; ; attempt++) {
      let res: Response
      try {
        res = await this.f(url, {
          method,
          headers: { ...this.headers, Accept: 'application/json', ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
          signal: AbortSignal.timeout(15_000),
        })
      } catch (e: any) {
        throw new CloudflareError(`Cloudflare could not be reached: ${e?.message ?? e}`)
      }
      if (res.status === 429) {
        if (attempt < this.maxRetries) {
          const after = Number(res.headers.get('retry-after'))
          await this.sleep(Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * (attempt + 1), 10_000))
          continue
        }
        throw new CloudflareError('Cloudflare rate limit reached. Wait a minute and try again.', 502, [429])
      }
      let body: any = null
      try { body = await res.json() } catch { /* not JSON */ }
      if (!res.ok || !body || body.success === false) {
        const codes = Array.isArray(body?.errors) ? body.errors.map((e: any) => Number(e?.code)).filter(Number.isFinite) : []
        // A refused credential or a bad request is the caller's to fix; anything else is Cloudflare's.
        const status = [400, 401, 403, 404].includes(res.status) ? 400 : 502
        throw new CloudflareError(cfErrorMessage(body, res.status), status, codes)
      }
      return { result: body.result as T, result_info: body.result_info }
    }
  }

  /** Every page of a list endpoint. Bounded, so a misbehaving answer cannot loop forever. */
  private async paged<T>(segments: string[], query: Query, perPage: number): Promise<T[]> {
    const out: T[] = []
    for (let page = 1; page <= 200; page++) {
      const { result, result_info } = await this.req<T[]>('GET', segments, { query: { ...query, page, per_page: perPage } })
      out.push(...(Array.isArray(result) ? result : []))
      const total = Number(result_info?.total_pages)
      if (!Number.isFinite(total) || page >= total || !Array.isArray(result) || result.length === 0) break
    }
    return out
  }

  // --- The credential -------------------------------------------------------------------

  /**
   * A token's status. A user's token verifies at /user/tokens/verify; an account-owned token gets "Invalid API
   * Token" (code 1000) there and verifies at /accounts/{id}/tokens/verify instead, so on a refusal the accounts
   * the token can see are tried one by one. The first error is thrown only when neither way verifies it.
   * With a Global API Key there is no token to verify; the account answering is the check.
   */
  async verify(): Promise<TokenStatus> {
    if (this.authKind === 'global-key') {
      await this.req('GET', ['user'])
      return { id: null, status: 'active' }
    }
    const status = (result: any, extra: Partial<TokenStatus>): TokenStatus => ({ id: result?.id ? String(result.id) : null,
      status: String(result?.status ?? 'unknown'), expires_on: result?.expires_on ?? null, not_before: result?.not_before ?? null, ...extra })
    try {
      const { result } = await this.req<any>('GET', ['user', 'tokens', 'verify'])
      return status(result, { owner: 'user' })
    } catch (e) {
      // Only a refused credential is worth a second way; an outage or a rate limit is reported as it is.
      if (!(e instanceof CloudflareError) || e.statusCode !== 400) throw e
      const accounts = await this.listAccounts().catch(() => null)
      if (!accounts?.length) throw e
      let fallback: TokenStatus | null = null
      for (const a of accounts) {
        let id: string
        try { id = checkedId(a.id, 'account id') } catch { continue }
        try {
          const { result } = await this.req<any>('GET', ['accounts', id, 'tokens', 'verify'])
          const s = status(result, { owner: 'account', account: { id, name: String(a.name ?? id) } })
          if (s.status === 'active') return s
          fallback ??= s
        } catch { /* not this account's token */ }
      }
      if (fallback) return fallback
      throw e
    }
  }

  /** The accounts this credential can see. */
  async listAccounts(): Promise<Array<{ id: string; name: string }>> {
    return this.paged<{ id: string; name: string }>(['accounts'], {}, 50)
  }

  /**
   * The names of a token's permission groups. Needs "API Tokens: Read" (on the account, for an account-owned
   * token), which most DNS tokens lack: null then.
   */
  async tokenPermissions(id: string | null, accountId?: string): Promise<string[] | null> {
    if (!id) return null
    try {
      const path = accountId ? ['accounts', checkedId(accountId, 'account id'), 'tokens', checkedId(id, 'token id')] : ['user', 'tokens', checkedId(id, 'token id')]
      const { result } = await this.req<any>('GET', path)
      const names = (Array.isArray(result?.policies) ? result.policies : [])
        .flatMap((p: any) => (Array.isArray(p?.permission_groups) ? p.permission_groups : []).map((g: any) => String(g?.name ?? '')))
        .filter(Boolean)
      return [...new Set<string>(names)]
    } catch { return null }
  }

  // --- Zones ----------------------------------------------------------------------------

  async listZones(): Promise<CfZone[]> {
    return this.paged<CfZone>(['zones'], {}, 50)
  }

  /** The zone of exactly this name, or null. `name` must already be a checked domain. */
  async zoneByName(name: string): Promise<CfZone | null> {
    const { result } = await this.req<CfZone[]>('GET', ['zones'], { query: { name } })
    return (Array.isArray(result) ? result : []).find(z => String(z.name).toLowerCase() === name.toLowerCase()) ?? null
  }

  // --- Records --------------------------------------------------------------------------

  async listRecords(zoneId: string, filter: { type?: string; name?: string } = {}): Promise<CfRecord[]> {
    return this.paged<CfRecord>(['zones', checkedId(zoneId, 'zone id'), 'dns_records'], { type: filter.type, name: filter.name }, 100)
  }

  async createRecord(zoneId: string, body: CfRecordBody): Promise<CfRecord> {
    return (await this.req<CfRecord>('POST', ['zones', checkedId(zoneId, 'zone id'), 'dns_records'], { body })).result
  }

  async updateRecord(zoneId: string, recordId: string, body: Partial<CfRecordBody>): Promise<CfRecord> {
    return (await this.req<CfRecord>('PATCH', ['zones', checkedId(zoneId, 'zone id'), 'dns_records', checkedId(recordId, 'record id')], { body })).result
  }

  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    await this.req('DELETE', ['zones', checkedId(zoneId, 'zone id'), 'dns_records', checkedId(recordId, 'record id')])
  }
}

// --- The Settings test ------------------------------------------------------------------

export interface CloudflareTestResult {
  ok: boolean
  message: string
  /** Extra lines for the Settings page: status, expiry, what the token was seen to do. */
  details: string[]
  zones: string[]
  permissions: string[] | null
}

/**
 * Verify the token, then list the zones it can see. A working token with no zones is a success: a fresh
 * account has none until a domain is added in Cloudflare.
 */
export async function testCloudflare(client: CloudflareClient, now = Date.now()): Promise<CloudflareTestResult> {
  let v: TokenStatus
  try { v = await client.verify() } catch (e) {
    // The DNS page lists zones with this same token; the Test must not call it invalid when that works.
    const zones = await client.listZones().catch(() => null)
    if (!zones) throw e
    return result(client, zones, null, [`Cloudflare would not verify the token itself (${(e as Error).message}), but it lists zones, so DNS works with it.`], 'Token works')
  }
  const expired = v.status === 'expired' || (v.expires_on ? Date.parse(v.expires_on) <= now : false)
  if (expired) throw new CloudflareError(`The Cloudflare token has expired${v.expires_on ? ` (${v.expires_on.slice(0, 10)})` : ''}. Make a new one in Cloudflare and save it here.`, 400)
  if (v.status !== 'active') throw new CloudflareError(`The Cloudflare token is ${v.status}, not active. Re-enable it or make a new one.`, 400)
  if (v.not_before && Date.parse(v.not_before) > now) throw new CloudflareError(`The Cloudflare token is not valid until ${v.not_before.slice(0, 10)}.`, 400)

  const zones = await client.listZones()
  const permissions = await client.tokenPermissions(v.id, v.owner === 'account' ? v.account?.id : undefined)
  const label = v.owner === 'account' ? `Account token works (account ${v.account?.name})` : 'Token works'
  const first = client.authKind === 'token'
    ? `${v.owner === 'account' ? 'Account-owned token' : 'Token'} is active${v.expires_on ? `, expires ${v.expires_on.slice(0, 10)}` : ', no expiry'}.`
    : 'Global API Key accepted. A scoped API token (Zone: Read, DNS: Edit) is safer.'
  return result(client, zones, permissions, [first], label)
}

function result(client: CloudflareClient, zones: CfZone[], permissions: string[] | null, lead: string[], label: string): CloudflareTestResult {
  const names = zones.map(z => String(z.name).toLowerCase())
  const details: string[] = [...lead, `Zone: Read works (${names.length} zone${names.length === 1 ? '' : 's'} listed).`]
  if (permissions?.length) details.push(`Permissions: ${permissions.join(', ')}.`)
  else if (client.authKind === 'token') details.push('Cloudflare does not show this token its own permissions (that needs "API Tokens: Read"). Give it Zone: Read and DNS: Edit.')
  const inactive = zones.filter(z => z.status !== 'active')
  if (inactive.length) details.push(`Not active yet: ${inactive.map(z => `${z.name} (${z.status})`).join(', ')}. Point the domain's nameservers at Cloudflare.`)

  if (!names.length) {
    details.push('If you expected domains here, check the token is allowed to read the zones (Zone: Read on all zones or the ones you want).')
    return { ok: true, message: `${label}, but this account has no domains yet.`, details, zones: [], permissions }
  }
  const shown = names.slice(0, 5).join(', ') + (names.length > 5 ? `, and ${names.length - 5} more` : '')
  return { ok: true, message: `${label}: ${names.length} zone${names.length === 1 ? '' : 's'} (${shown}).`, details, zones: names, permissions }
}
