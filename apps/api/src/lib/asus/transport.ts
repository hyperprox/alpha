// =============================================================================
//  HyperProx — ASUS router: one HTTP request to a router
//
//  Direct only: HyperProx makes the request itself, to the address target.ts
//  checked at that moment, with the certificate pin when one is set, no
//  redirects followed, one deadline and a size cap per answer. The User-Agent
//  is the ASUS phone app's: Asuswrt answers that client with JSON and a token,
//  where a browser would get the HTML login page.
// =============================================================================

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { PinnedAgent, CertificateChangedError } from '../clusters/tls-pin'
import { AsusTargetError, resolveAsusTarget, type TargetResolver } from './target'

export const ASUS_USER_AGENT = 'asusrouter-Android-DUTUtil-1.0.0.245'
/** A client list on a busy network runs to a few hundred KiB; nothing a router says is bigger than this. */
export const MAX_ANSWER_BYTES = 4 * 1024 * 1024

export interface AsusRequest {
  method: 'GET' | 'POST'
  /** A fixed path: "/login.cgi", "/appGet.cgi". */
  path:   string
  body?:  string
  contentType?: string
  /** The session token, sent as the asus_token cookie. */
  token?: string
}

export interface AsusResponse { status: number; text: string }

export interface AsusTransport {
  send(r: AsusRequest, timeoutMs?: number): Promise<AsusResponse>
}

export class AsusUnreachableError extends Error {
  constructor(message: string) { super(message); this.name = 'AsusUnreachableError' }
}

const TOKEN_RE = /^[A-Za-z0-9+/=_-]{1,256}$/

/** Strip anything address-, password- or token-shaped out of an error before it is shown. */
export function plainError(e: any): AsusUnreachableError {
  if (e instanceof AsusUnreachableError) return e
  if (e instanceof AsusTargetError) return new AsusUnreachableError(`Router address refused: ${e.message}`)
  if (e instanceof CertificateChangedError) return new AsusUnreachableError('The router presented a different certificate from the one HyperProx pinned, so HyperProx sent it nothing. If its certificate was renewed on purpose, pin the new one in Settings.')
  const code = e?.code ?? e?.cause?.code
  const msg = String(e?.message ?? '')
  const why = code === 'ECONNREFUSED' ? 'connection refused'
    : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'the address does not resolve'
    : code === 'ETIMEDOUT' || /timed out|abort/i.test(msg) ? 'it did not answer in time'
    : code === 'EHOSTUNREACH' || code === 'ENETUNREACH' ? 'no route to it'
    : /too large/i.test(msg) ? 'its answer was too large'
    : /certificate|self.signed|CERT_/i.test(msg + String(code ?? '')) ? 'its certificate is not trusted (pin it in Settings)'
    : 'it could not be reached'
  return new AsusUnreachableError(`The router is unreachable: ${why}.`)
}

export interface DirectOptions { url: string; insecureTLS: boolean; fingerprint: string | null; resolve?: TargetResolver }

export class DirectTransport implements AsusTransport {
  private base: URL
  constructor(private o: DirectOptions) {
    this.base = new URL(o.url.replace(/\/+$/, '') + '/')
    if (!['http:', 'https:'].includes(this.base.protocol)) throw new AsusUnreachableError('The router address must start with http:// or https://.')
  }

  async send(r: AsusRequest, timeoutMs = 15_000): Promise<AsusResponse> {
    if (r.token !== undefined && !TOKEN_RE.test(r.token)) throw new AsusUnreachableError('Refused: the router\'s session token had unexpected characters.')
    try { return await this.one(r, timeoutMs) } catch (e) { throw plainError(e) }
  }

  private async one(r: AsusRequest, timeoutMs: number): Promise<AsusResponse> {
    const u = new URL(r.path.replace(/^\//, ''), this.base)
    const address = await (this.o.resolve ?? resolveAsusTarget)(u)
    const mod = u.protocol === 'https:' ? https : http
    const headers: Record<string, string> = { Host: u.host, Accept: '*/*', 'User-Agent': ASUS_USER_AGENT }
    if (r.token) headers.Cookie = `asus_token=${r.token}`
    if (r.body !== undefined) {
      headers['Content-Type'] = r.contentType ?? 'application/x-www-form-urlencoded'
      headers['Content-Length'] = String(Buffer.byteLength(r.body))
    }
    const opts: https.RequestOptions = {
      host: address, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: r.method, timeout: timeoutMs, headers,
    }
    if (u.protocol === 'https:') {
      if (!net.isIP(u.hostname.replace(/^\[|\]$/g, ''))) opts.servername = u.hostname
      if (this.o.fingerprint) opts.agent = new PinnedAgent(this.o.fingerprint)
      else opts.rejectUnauthorized = !this.o.insecureTLS
    }
    return new Promise((resolve, reject) => {
      let settled = false
      const done = (err: Error | null, v?: AsusResponse) => {
        if (settled) return
        settled = true; clearTimeout(deadline)
        err ? reject(err) : resolve(v!)
      }
      const req = mod.request(opts, res => {
        const status = res.statusCode ?? 0
        // Never followed: the login goes only to the address in the settings.
        if (status >= 300 && status < 400) { res.resume(); return done(null, { status, text: '' }) }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => { size += c.length; if (size > MAX_ANSWER_BYTES) { req.destroy(new Error('answer too large')); return } chunks.push(c) })
        res.on('end', () => done(null, { status, text: Buffer.concat(chunks).toString('utf8') }))
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
