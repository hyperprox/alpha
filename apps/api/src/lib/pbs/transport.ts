// =============================================================================
//  HyperProx — Proxmox Backup Server: how a request reaches one
//
//  HTTPS only (PBS has no plain-HTTP API), straight from HyperProx, to the
//  address checked at that moment (the Home Assistant / QNAP address rules: no
//  loopback, link-local, metadata or HyperProx's own ports; the request goes
//  to the checked address, so DNS rebinding gets nowhere), no redirects, one
//  deadline per request, and a capped answer.
//
//  The certificate, pinned when the server was added:
//    first-use   a PBS's own self-signed certificate. Only that exact
//                certificate is accepted afterwards (PinnedAgent: the check
//                happens after the handshake and before a byte of the request,
//                so the token never reaches a server that presented another).
//    ca          the certificate verified against the public CAs when it was
//                added (a Let's Encrypt one, say): normal verification stays
//                on, so a renewal keeps working, as the home Proxmox pin does.
//
//  The API token travels in the Authorization header only
//  ("PBSAPIToken=<user@realm!name>:<secret>"), never in a URL or a log.
// =============================================================================

import https from 'node:https'
import net from 'node:net'
import dns from 'node:dns/promises'
import { PinnedAgent, CertificateChangedError } from '../clusters/tls-pin'
import { checkHAAddresses, portOf } from '../ha-control/target'

export class PbsUnreachableError extends Error {
  constructor(message: string, readonly code = 'unreachable') { super(message); this.name = 'PbsUnreachableError' }
}

/** PBS answered, with an HTTP error. `status` 401/403 are permission problems, explained by the caller. */
export class PbsHttpError extends Error {
  constructor(readonly status: number, readonly detail: string) { super(`PBS answered HTTP ${status}${detail ? `: ${detail}` : ''}`); this.name = 'PbsHttpError' }
}

export type PinSource = 'first-use' | 'ca'
export interface PbsPin { fingerprint: string; source: PinSource; at: string }

export const MAX_ANSWER_BYTES = 8 * 1024 * 1024
export type TargetResolver = (u: URL) => Promise<string>

/** The Home Assistant address rules, worded for a backup server. Returns the address to connect to. */
export async function resolvePbsTarget(u: URL): Promise<string> {
  const host = u.hostname.replace(/^\[|\]$/g, '')
  let addresses: string[]
  if (net.isIP(host)) addresses = [host]
  else {
    try { addresses = (await dns.lookup(host, { all: true, verbatim: true })).map(a => a.address) }
    catch { throw new PbsUnreachableError('That address does not resolve.', 'bad_target') }
  }
  const v = checkHAAddresses(u.protocol, portOf(u), addresses)
  if (!v.ok) throw new PbsUnreachableError(v.reason.replace(/Home Assistant's/g, "the backup server's").replace(/Home Assistant/g, 'a backup server'), 'bad_target')
  return addresses[0]
}

/** Plain words for a failure, with nothing address- or token-shaped in them. */
export function plainError(e: any): Error {
  if (e instanceof PbsUnreachableError || e instanceof PbsHttpError) return e
  if (e instanceof CertificateChangedError) {
    return new PbsUnreachableError(`The backup server presented a different certificate from the one HyperProx pinned, so it was sent nothing (pinned ${e.expected}, presented ${e.presented}). If it was renewed on purpose, an admin re-pins it in Settings.`, 'cert_changed')
  }
  const code = e?.code ?? e?.cause?.code
  const why = code === 'ECONNREFUSED' ? 'connection refused'
    : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'the address does not resolve'
    : code === 'ETIMEDOUT' || /timed out|abort/i.test(String(e?.message)) ? 'it did not answer in time'
    : code === 'EHOSTUNREACH' || code === 'ENETUNREACH' ? 'no route to it'
    : /too large/i.test(String(e?.message)) ? 'its answer was too large'
    : /certificate|self.signed|CERT_/i.test(String(e?.message ?? code)) ? 'its certificate is not trusted'
    : 'it could not be reached'
  return new PbsUnreachableError(`The backup server is unreachable: ${why}.`)
}

export interface PbsTransportOptions {
  url: string
  /** An API token (every read and action). */
  tokenId?: string
  secret?: string
  /** A signed-in session instead (the catalogue's setup, as root@pam, right after it installed the server). */
  ticket?: { ticket: string; csrf: string }
  pin: PbsPin | null
  resolve?: TargetResolver
}

/** Encode query or form values; booleans as PBS takes them. */
export function encodeParams(p: Record<string, string | number | boolean | undefined> = {}): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(p)) if (v !== undefined) q.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v))
  return q.toString()
}

export class PbsTransport {
  private base: URL
  constructor(private o: PbsTransportOptions) {
    this.base = new URL(o.url.replace(/\/+$/, '') + '/')
    if (this.base.protocol !== 'https:') throw new PbsUnreachableError('A backup server is reached over https:// only.', 'bad_target')
    if (!o.pin) throw new PbsUnreachableError('No certificate is pinned for this backup server yet.', 'no_pin')
  }

  /**
   * Sign in with a user name and password (POST /access/ticket, no credential in the URL) and return a transport
   * for that session. Used once, by the catalogue's setup, with the root password it generated.
   */
  static async login(o: { url: string; pin: PbsPin; resolve?: TargetResolver }, username: string, password: string): Promise<PbsTransport> {
    const anon = new PbsTransport({ url: o.url, pin: o.pin, resolve: o.resolve })
    const t = await anon.call('POST', '/access/ticket', { username, password })
    if (typeof t?.ticket !== 'string' || typeof t?.CSRFPreventionToken !== 'string') throw new PbsUnreachableError('The backup server did not accept the sign-in.')
    return new PbsTransport({ url: o.url, pin: o.pin, resolve: o.resolve, ticket: { ticket: t.ticket, csrf: t.CSRFPreventionToken } })
  }

  /** One API call; resolves with the answer's `data`. `path` is under /api2/json. */
  async call(method: 'GET' | 'POST' | 'PUT', path: string, params?: Record<string, string | number | boolean | undefined>, timeoutMs = 15_000): Promise<any> {
    const qs = encodeParams(params)
    const u = new URL(`api2/json${path.startsWith('/') ? path : `/${path}`}${method === 'GET' && qs ? `?${qs}` : ''}`, this.base)
    let address: string
    try { address = await (this.o.resolve ?? resolvePbsTarget)(u) } catch (e) { throw plainError(e) }
    const body = method !== 'GET' ? qs : undefined
    const opts: https.RequestOptions = {
      host: address, port: u.port || 443, path: u.pathname + u.search, method, timeout: timeoutMs,
      headers: {
        Host: u.host, Accept: 'application/json',
        ...(this.o.tokenId ? { Authorization: `PBSAPIToken=${this.o.tokenId}:${this.o.secret}` } : {}),
        ...(this.o.ticket ? { Cookie: `PBSAuthCookie=${encodeURIComponent(this.o.ticket.ticket)}`, ...(method !== 'GET' ? { CSRFPreventionToken: this.o.ticket.csrf } : {}) } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(Buffer.byteLength(body)) } : {}),
      },
    }
    if (!net.isIP(u.hostname.replace(/^\[|\]$/g, ''))) opts.servername = u.hostname
    if (this.o.pin!.source === 'ca') opts.rejectUnauthorized = true
    else opts.agent = new PinnedAgent(this.o.pin!.fingerprint)

    const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      let settled = false
      const done = (err: Error | null, v?: { status: number; text: string }) => {
        if (settled) return
        settled = true; clearTimeout(deadline)
        err ? reject(err) : resolve(v!)
      }
      const req = https.request(opts, r => {
        const chunks: Buffer[] = []
        let size = 0
        r.on('data', (c: Buffer) => { size += c.length; if (size > MAX_ANSWER_BYTES) { req.destroy(new Error('answer too large')); return } chunks.push(c) })
        r.on('end', () => done(null, { status: r.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
        r.on('error', e => done(e))
      })
      const deadline = setTimeout(() => req.destroy(new Error('timed out')), timeoutMs)
      req.on('timeout', () => req.destroy(new Error('timed out')))
      req.on('error', e => done(e))
      if (body !== undefined) req.write(body)
      req.end()
    }).catch(e => { throw plainError(e) })

    if (res.status >= 300 && res.status < 400) throw new PbsUnreachableError('The backup server answered with a redirect; HyperProx does not follow one with a token.')
    let json: any = null
    try { json = res.text ? JSON.parse(res.text) : null } catch { /* an error page */ }
    if (res.status >= 400) {
      const msg = typeof json?.message === 'string' ? json.message : typeof json?.errors === 'object' ? JSON.stringify(json.errors) : ''
      throw new PbsHttpError(res.status, msg.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200))
    }
    if (!json || typeof json !== 'object') throw new PbsUnreachableError('The backup server did not answer with JSON.')
    return json.data
  }
}
