// =============================================================================
//  HyperProx — DNS blockers: how a request reaches Pi-hole or AdGuard Home
//
//  HyperProx makes the request itself, to the address checked at that moment (target.ts), with no redirects, one deadline
//  per request and a cap on the answer. A login goes only to the address it was saved for (instances.ts), and nothing
//  here logs a password, a session id or an answer body.
//
//  Pi-hole v6 signs in with its password and gets a session id; every reading and every action opens a session and closes
//  it again (Pi-hole keeps a limited number open). AdGuard Home takes HTTP basic auth on every request.
// =============================================================================

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { resolveBlockerTarget, type TargetResolver } from './target'
import { DnsRefusal } from './types'
import type { Probe } from './parse'

/** The most HyperProx reads from one answer. */
export const MAX_ANSWER_BYTES = 2 * 1024 * 1024

export class DnsUnreachableError extends Error {
  constructor(message: string) { super(message); this.name = 'DnsUnreachableError' }
}
/** The blocker refused the login. Not tried again until the login is saved again. */
export class DnsLoginError extends Error {
  constructor(message: string) { super(message); this.name = 'DnsLoginError' }
}

export interface HttpRequest { method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; path: string; headers?: Record<string, string>; body?: string }
export interface HttpResponse { status: number; text: string }

export interface BlockerHttp {
  request(r: HttpRequest, timeoutMs?: number): Promise<HttpResponse>
}

/** What a person is told, never the address or the raw error. */
export function plainError(e: any): DnsUnreachableError {
  if (e instanceof DnsUnreachableError) return e
  if (e?.name === 'DnsTargetError') return new DnsUnreachableError(`The address was refused: ${e.message}`)
  const code = e?.code ?? e?.cause?.code
  const why = code === 'ECONNREFUSED' ? 'connection refused'
    : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'the address does not resolve'
    : code === 'ETIMEDOUT' || /timed out|abort/i.test(String(e?.message)) ? 'it did not answer in time'
    : code === 'EHOSTUNREACH' || code === 'ENETUNREACH' ? 'no route to it'
    : /too large/i.test(String(e?.message)) ? 'its answer was too large'
    : /certificate|self.signed|CERT_/i.test(String(e?.message ?? code)) ? 'its certificate is not trusted'
    : 'it could not be reached'
  return new DnsUnreachableError(`The DNS blocker is unreachable: ${why}.`)
}

export interface DirectOptions { url: string; insecureTLS: boolean; resolve?: TargetResolver }

export class DirectHttp implements BlockerHttp {
  private base: URL
  constructor(private o: DirectOptions) {
    this.base = new URL(o.url.replace(/\/+$/, '') + '/')
    if (!['http:', 'https:'].includes(this.base.protocol)) throw new DnsUnreachableError('The address must start with http:// or https://.')
  }

  async request(r: HttpRequest, timeoutMs = 15_000): Promise<HttpResponse> {
    try { return await this.one(r, timeoutMs) } catch (e) { throw plainError(e) }
  }

  private async one(r: HttpRequest, timeoutMs: number): Promise<HttpResponse> {
    const u = new URL(r.path.replace(/^\//, ''), this.base)
    const address = await (this.o.resolve ?? resolveBlockerTarget)(u)
    const mod = u.protocol === 'https:' ? https : http
    const opts: https.RequestOptions = {
      host: address, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: r.method, timeout: timeoutMs,
      headers: { Host: u.host, Accept: 'application/json', ...(r.headers ?? {}), ...(r.body !== undefined ? { 'Content-Length': String(Buffer.byteLength(r.body)) } : {}) },
    }
    if (u.protocol === 'https:') {
      if (!net.isIP(u.hostname.replace(/^\[|\]$/g, ''))) opts.servername = u.hostname
      opts.rejectUnauthorized = !this.o.insecureTLS
    }
    return new Promise((resolve, reject) => {
      let settled = false
      const done = (err: Error | null, v?: HttpResponse) => {
        if (settled) return
        settled = true; clearTimeout(deadline)
        err ? reject(err) : resolve(v!)
      }
      const req = mod.request(opts, res => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => { size += c.length; if (size > MAX_ANSWER_BYTES) { req.destroy(new Error('answer too large')); return } chunks.push(c) })
        res.on('end', () => done(null, { status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', e => done(e))
      })
      const deadline = setTimeout(() => req.destroy(new Error('timed out')), timeoutMs)
      req.on('timeout', () => req.destroy(new Error('timed out')))
      req.on('error', e => done(e))
      if (r.body !== undefined) req.write(r.body)
      req.end()
    })
  }
}

const parse = (text: string): any => { try { return JSON.parse(text) } catch { return null } }

// ── Pi-hole v6 ──────────────────────────────────────────────────────────────

export class PiholeClient {
  constructor(private h: BlockerHttp, private password: string) {}

  /** Signs in, runs `fn` with the session, and signs out again whatever happens. */
  async session<T>(fn: (s: PiholeSession) => Promise<T>): Promise<T> {
    const r = await this.h.request({ method: 'POST', path: '/api/auth', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: this.password }) })
    const j = parse(r.text)
    if (r.status === 401 || j?.session?.valid === false) throw new DnsLoginError('Pi-hole refused the password. Save the password again on the Pi-hole page.')
    const sid = j?.session?.sid
    if (r.status !== 200 || typeof sid !== 'string' || !sid) throw new DnsUnreachableError(r.status === 429 ? 'Pi-hole is limiting sign-ins right now; wait a minute.' : 'Pi-hole did not sign HyperProx in.')
    try { return await fn(new PiholeSession(this.h, sid)) }
    finally { await this.h.request({ method: 'DELETE', path: '/api/auth', headers: { sid } }, 5_000).catch(() => {}) }
  }
}

export class PiholeSession {
  constructor(private h: BlockerHttp, private sid: string) {}

  /** One GET, as JSON; null when that one thing is not available (older version, no permission), with a reason. */
  async get(path: string): Promise<{ ok: true; json: any } | { ok: false; why: string }> {
    const r = await this.h.request({ method: 'GET', path, headers: { sid: this.sid } })
    if (r.status === 200) { const j = parse(r.text); return j ? { ok: true, json: j } : { ok: false, why: 'unreadable answer' } }
    return { ok: false, why: r.status === 401 || r.status === 403 ? 'not permitted' : r.status === 404 ? 'not in this version' : `answered ${r.status}` }
  }

  private async write(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, timeoutMs?: number): Promise<HttpResponse> {
    const r = await this.h.request({ method, path, headers: { sid: this.sid, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, timeoutMs)
    if (r.status >= 200 && r.status < 300) return r
    const j = parse(r.text)
    throw new DnsRefusal('blocker_refused', `Pi-hole refused that: ${String(j?.error?.message ?? `it answered ${r.status}`).slice(0, 200)}`, 502, { hint: typeof j?.error?.hint === 'string' ? j.error.hint.slice(0, 120) : null })
  }

  setBlocking(enabled: boolean, seconds: number | null): Promise<HttpResponse> {
    return this.write('POST', '/api/dns/blocking', enabled ? { blocking: true } : { blocking: false, ...(seconds ? { timer: seconds } : {}) })
  }
  /** Rebuilds the block lists from their sources (Pi-hole calls this gravity). Takes a while. */
  updateLists(): Promise<HttpResponse> { return this.write('POST', '/api/action/gravity', undefined, 5 * 60_000) }
  /** Allows one domain, and reads it back: done means Pi-hole lists it as allowed and enabled (already there counts). */
  async allowDomain(domain: string, comment: string): Promise<void> {
    try { await this.write('POST', '/api/domains/allow/exact', { domain, comment, groups: [0], enabled: true }) }
    catch (e) { if (!(e instanceof DnsRefusal) || !/already present/i.test(String(e.extra.hint ?? ''))) throw e }
    const back = await this.get(`/api/domains/allow/exact/${encodeURIComponent(domain)}`)
    const rows: any[] = back.ok && Array.isArray(back.json.domains) ? back.json.domains : []
    if (!rows.some(d => d?.domain === domain && d?.enabled !== false)) throw new DnsRefusal('not_confirmed', 'Pi-hole did not keep the allow rule.', 502)
  }
  setUpstreams(list: string[]): Promise<HttpResponse> { return this.write('PATCH', '/api/config', { config: { dns: { upstreams: list } } }) }
}

// ── AdGuard Home ────────────────────────────────────────────────────────────

export class AdguardClient {
  private auth: string
  constructor(private h: BlockerHttp, username: string, password: string) {
    this.auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  }

  async get(path: string): Promise<{ ok: true; json: any } | { ok: false; why: string }> {
    const r = await this.h.request({ method: 'GET', path, headers: { Authorization: this.auth } })
    if (r.status === 401) throw new DnsLoginError('AdGuard Home refused the login. Save the user name and password again on the AdGuard Home page.')
    if (r.status === 429) throw new DnsUnreachableError('AdGuard Home is limiting sign-ins right now; wait a few minutes.')
    if (r.status === 200) { const j = parse(r.text); return j ? { ok: true, json: j } : { ok: false, why: 'unreadable answer' } }
    return { ok: false, why: r.status === 403 ? 'not permitted' : r.status === 404 ? 'not in this version' : `answered ${r.status}` }
  }

  private async post(path: string, body: unknown, timeoutMs?: number): Promise<HttpResponse> {
    const r = await this.h.request({ method: 'POST', path, headers: { Authorization: this.auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, timeoutMs)
    if (r.status === 401) throw new DnsLoginError('AdGuard Home refused the login. Save the user name and password again on the AdGuard Home page.')
    if (r.status >= 200 && r.status < 300) return r
    throw new DnsRefusal('blocker_refused', `AdGuard Home refused that: ${r.text.trim().slice(0, 160) || `it answered ${r.status}`}`, 502)
  }

  /** `seconds` null turns blocking off until it is turned on again. */
  setProtection(enabled: boolean, seconds: number | null): Promise<HttpResponse> {
    return this.post('/control/protection', enabled ? { enabled: true } : { enabled: false, ...(seconds ? { duration: seconds * 1000 } : {}) })
  }
  updateLists(): Promise<HttpResponse> { return this.post('/control/filtering/refresh', { whitelist: false }, 5 * 60_000) }
  setUserRules(rules: string[]): Promise<HttpResponse> { return this.post('/control/filtering/set_rules', { rules }) }
  setUpstreams(list: string[]): Promise<HttpResponse> { return this.post('/control/dns_config', { upstream_dns: list }) }

  /** AdGuard's own test of each upstream, from the blocker: "OK" or the reason it failed. */
  async testUpstreams(list: string[]): Promise<Map<string, Probe>> {
    const r = await this.post('/control/test_upstream_dns', { upstream_dns: list, bootstrap_dns: [] }, 40_000)
    const j = parse(r.text) ?? {}
    const out = new Map<string, Probe>()
    for (const [addr, v] of Object.entries(j)) out.set(addr, { ok: v === 'OK', ms: null })
    return out
  }
}

// ── a test lookup, from HyperProx ──────────────────────────────────────────

/** One A lookup of a fixed name against one DNS server, with a deadline. Injectable so tests need no network. */
export type DnsProbe = (server: string, port: number) => Promise<Probe>

export const PROBE_NAME = 'example.com'

export const productionProbe: DnsProbe = async (server, port) => {
  const { Resolver } = await import('node:dns')
  const res = new Resolver({ timeout: 4_000, tries: 1 })
  res.setServers([net.isIPv6(server) ? `[${server}]:${port}` : `${server}:${port}`])
  const t0 = process.hrtime.bigint()
  return new Promise<Probe>(resolve => {
    res.resolve4(PROBE_NAME, err => {
      const ms = Math.max(1, Math.round(Number(process.hrtime.bigint() - t0) / 1e6))
      resolve(err ? { ok: false, ms: null } : { ok: true, ms })
    })
  })
}
