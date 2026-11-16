// =============================================================================
//  HyperProx — K3s: how a request reaches a cluster's API
//
//  HTTPS only, straight to the address checked at that moment (the Home
//  Assistant / backup-server address rules: no loopback, link-local, metadata
//  or HyperProx's own ports; the request goes to the checked address), the
//  certificate checked against the cluster's OWN CA (taken from its kubeconfig,
//  never the public CAs, never "insecure"), no redirects, one deadline per
//  request and a capped answer.
//
//  A token travels in the Authorization header only, never in a URL or a log.
//  A client certificate (K3s's admin, used only while HyperProx makes its own
//  accounts) is presented in the TLS handshake.
// =============================================================================

import https from 'node:https'
import net from 'node:net'
import dns from 'node:dns/promises'
import { checkHAAddresses, portOf } from '../ha-control/target'

export class K3sUnreachableError extends Error {
  constructor(message: string, readonly code = 'unreachable') { super(message); this.name = 'K3sUnreachableError' }
}

/** The API answered with an error. 401/403 are permission problems, explained by the caller. */
export class K3sHttpError extends Error {
  constructor(readonly status: number, readonly reason: string, readonly detail: string) {
    super(`The Kubernetes API answered HTTP ${status}${detail ? `: ${detail}` : ''}`); this.name = 'K3sHttpError'
  }
}

export const MAX_ANSWER_BYTES = 16 * 1024 * 1024
export type TargetResolver = (u: URL) => Promise<string>

export async function resolveK3sTarget(u: URL): Promise<string> {
  const host = u.hostname.replace(/^\[|\]$/g, '')
  let addresses: string[]
  if (net.isIP(host)) addresses = [host]
  else {
    try { addresses = (await dns.lookup(host, { all: true, verbatim: true })).map(a => a.address) }
    catch { throw new K3sUnreachableError('That address does not resolve.', 'bad_target') }
  }
  const v = checkHAAddresses(u.protocol, portOf(u), addresses)
  if (!v.ok) throw new K3sUnreachableError(v.reason.replace(/Home Assistant's/g, "the cluster's").replace(/Home Assistant/g, 'a K3s server'), 'bad_target')
  return addresses[0]
}

export function plainError(e: any): Error {
  if (e instanceof K3sUnreachableError || e instanceof K3sHttpError) return e
  const code = e?.code ?? e?.cause?.code
  const why = code === 'ECONNREFUSED' ? 'connection refused'
    : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'the address does not resolve'
    : code === 'ETIMEDOUT' || /timed out|abort/i.test(String(e?.message)) ? 'it did not answer in time'
    : code === 'EHOSTUNREACH' || code === 'ENETUNREACH' ? 'no route to it'
    : /too large/i.test(String(e?.message)) ? 'its answer was too large'
    : /certificate|self.signed|CERT_|altname|IP: /i.test(String(e?.message ?? code))
      ? 'its certificate does not match the cluster\'s CA or its address (was the cluster rebuilt?)'
    : 'it could not be reached'
  return new K3sUnreachableError(`The K3s API is unreachable: ${why}.`)
}

export interface K3sTransportOptions {
  /** https://host:port */
  url: string
  /** PEM of the cluster's CA: the only certificate authority trusted for this cluster. */
  ca: string
  token?: string
  cert?: string
  key?: string
  resolve?: TargetResolver
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export interface Call {
  method?: Method
  path: string
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  /** application/json (default), application/merge-patch+json, application/strategic-merge-patch+json or application/apply-patch+yaml. */
  contentType?: string
  /** Return the raw text (pod logs) instead of parsing JSON. */
  text?: boolean
  timeoutMs?: number
}

export class K3sTransport {
  private base: URL
  constructor(private o: K3sTransportOptions) {
    this.base = new URL(o.url.replace(/\/+$/, '') + '/')
    if (this.base.protocol !== 'https:') throw new K3sUnreachableError('A K3s API is reached over https:// only.', 'bad_target')
    if (!o.ca || !/BEGIN CERTIFICATE/.test(o.ca)) throw new K3sUnreachableError('The cluster\'s CA is not known, so it cannot be checked.', 'no_ca')
    if (!o.token && !(o.cert && o.key)) throw new K3sUnreachableError('No credential for this cluster.', 'no_credential')
  }

  async call<T = any>(c: Call): Promise<T> {
    const method = c.method ?? 'GET'
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(c.query ?? {})) if (v !== undefined) q.set(k, String(v))
    if (!c.path.startsWith('/') || c.path.includes('..')) throw new K3sUnreachableError('Not an API path.', 'bad_path')
    const u = new URL(`${c.path.slice(1)}${q.toString() ? `?${q}` : ''}`, this.base)
    let address: string
    try { address = await (this.o.resolve ?? resolveK3sTarget)(u) } catch (e) { throw plainError(e) }
    const body = c.body === undefined ? undefined : typeof c.body === 'string' ? c.body : JSON.stringify(c.body)
    const timeoutMs = c.timeoutMs ?? 15_000
    const opts: https.RequestOptions = {
      host: address, port: u.port || 443, path: u.pathname + u.search, method, timeout: timeoutMs,
      ca: this.o.ca, rejectUnauthorized: true,
      ...(this.o.cert && this.o.key ? { cert: this.o.cert, key: this.o.key } : {}),
      headers: {
        Host: u.host, Accept: c.text ? '*/*' : 'application/json',
        ...(this.o.token ? { Authorization: `Bearer ${this.o.token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': c.contentType ?? 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } : {}),
      },
      // Each cluster has its own CA: never a pooled connection made under another one.
      agent: false,
    }
    if (!net.isIP(u.hostname.replace(/^\[|\]$/g, ''))) opts.servername = u.hostname
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
        r.on('data', (ch: Buffer) => { size += ch.length; if (size > MAX_ANSWER_BYTES) { req.destroy(new Error('answer too large')); return } chunks.push(ch) })
        r.on('end', () => done(null, { status: r.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
        r.on('error', e => done(e))
      })
      const deadline = setTimeout(() => req.destroy(new Error('timed out')), timeoutMs)
      req.on('timeout', () => req.destroy(new Error('timed out')))
      req.on('error', e => done(e))
      if (body !== undefined) req.write(body)
      req.end()
    }).catch(e => { throw plainError(e) })

    if (res.status >= 300 && res.status < 400) throw new K3sUnreachableError('The API answered with a redirect; HyperProx does not follow one with a credential.')
    let json: any = null
    if (!c.text || res.status >= 400) { try { json = res.text ? JSON.parse(res.text) : null } catch { /* not JSON */ } }
    if (res.status >= 400) {
      const msg = typeof json?.message === 'string' ? json.message : ''
      throw new K3sHttpError(res.status, typeof json?.reason === 'string' ? json.reason : '', msg.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300))
    }
    if (c.text) return res.text as unknown as T
    if (json === null || typeof json !== 'object') throw new K3sUnreachableError('The API did not answer with JSON.')
    return json as T
  }
}
