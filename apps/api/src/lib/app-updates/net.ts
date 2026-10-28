// =============================================================================
//  HyperProx — App updates: network reads made from HyperProx itself
//
//  Three things, each deliberately small:
//    - fetchJson: release metadata (npm registry, GitHub API). https only,
//      size-capped, cached for a quarter of an hour so an inventory refresh
//      does not spend GitHub's 60-an-hour anonymous allowance.
//    - http: load a page the way a browser would, to check an app through the
//      public URL people actually use.
//    - wsProbe: open a websocket with a browser's Origin header and read the
//      first message. No library: the handshake and one frame are all a probe
//      needs, and node:https lets the Origin header be set, which a browser-
//      style WebSocket client does not.
//
//  None of these carries a credential.
// =============================================================================

import http from 'node:http'
import https from 'node:https'
import { randomBytes } from 'node:crypto'
import type { AppHttpResult, AppWsProbe } from '../plugin-host'

const MAX_BODY = 16 * 1024 * 1024
const CACHE_MS = 15 * 60_000
const cache = new Map<string, { at: number; value: unknown }>()

function request(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; insecureTLS?: boolean; maxBody?: number }): Promise<AppHttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null
    if (!lib) return reject(new Error(`unsupported URL scheme: ${u.protocol}`))
    const max = opts.maxBody ?? MAX_BODY
    const req = lib.request(u, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      timeout: opts.timeoutMs ?? 15_000,
      ...(u.protocol === 'https:' ? { rejectUnauthorized: !opts.insecureTLS } : {}),
    }, res => {
      let size = 0
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size > max) { req.destroy(new Error(`response larger than ${max} bytes`)); return }
        chunks.push(c)
      })
      res.on('end', () => {
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : String(v)
        resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8') })
      })
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error(`timed out after ${Math.round((opts.timeoutMs ?? 15_000) / 1000)} s`)))
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

export async function fetchJson(url: string, body?: unknown): Promise<any> {
  if (!url.startsWith('https://')) throw new Error('release metadata is fetched over https only')
  const key = body === undefined ? url : `${url}\n${JSON.stringify(body)}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value
  // The registry's abbreviated document has every version and the dist-tags at a fraction of the size.
  const accept = body === undefined && new URL(url).host === 'registry.npmjs.org' ? 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' : 'application/json'
  const headers: Record<string, string> = { Accept: accept, 'User-Agent': 'HyperProx-updates' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const r = await request(url, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs: 20_000 })
  if (r.status < 200 || r.status >= 300) throw new Error(`${new URL(url).host} answered HTTP ${r.status}`)
  let value: unknown
  try { value = JSON.parse(r.body) } catch { throw new Error(`${new URL(url).host} did not return JSON`) }
  cache.set(key, { at: Date.now(), value })
  if (cache.size > 500) cache.delete(cache.keys().next().value as string)
  return value
}

/** GET, following up to three redirects — to the same host only, and never from https down to http. */
export async function httpGet(url: string, opts: { headers?: Record<string, string>; timeoutMs?: number; insecureTLS?: boolean } = {}): Promise<AppHttpResult> {
  let current = url
  for (let hop = 0; hop < 4; hop++) {
    const r = await request(current, { headers: { 'User-Agent': 'Mozilla/5.0 (HyperProx update check)', Accept: 'text/html,*/*', ...opts.headers }, timeoutMs: opts.timeoutMs, insecureTLS: opts.insecureTLS, maxBody: 1024 * 1024 })
    if (r.status >= 300 && r.status < 400 && r.headers.location && hop < 3) {
      const next = new URL(r.headers.location, current)
      const prev = new URL(current)
      if (next.host !== prev.host || (prev.protocol === 'https:' && next.protocol !== 'https:') || (next.protocol !== 'https:' && next.protocol !== 'http:')) return r
      current = next.toString()
      continue
    }
    return r
  }
  throw new Error('too many redirects')
}

/** Parse one server frame (unmasked) from the start of `buf`; null when incomplete. */
export function parseFrame(buf: Buffer): { opcode: number; payload: Buffer; length: number } | null {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let len = buf[1] & 0x7f
  let off = 2
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4 }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10 }
  let mask: Buffer | null = null
  if (masked) { if (buf.length < off + 4) return null; mask = buf.subarray(off, off + 4); off += 4 }
  if (buf.length < off + len) return null
  const payload = Buffer.from(buf.subarray(off, off + len))
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
  return { opcode, payload, length: off + len }
}

/** A masked client close frame (status 1000). */
function closeFrame(): Buffer {
  const mask = randomBytes(4)
  const body = Buffer.from([0x03, 0xe8])
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4]
  return Buffer.concat([Buffer.from([0x88, 0x80 | body.length]), mask, body])
}

export function wsProbe(url: string, opts: { origin?: string; timeoutMs?: number; insecureTLS?: boolean } = {}): Promise<AppWsProbe> {
  return new Promise(resolve => {
    let u: URL
    try { u = new URL(url) } catch { return resolve({ upgraded: false, status: 0, firstMessage: null, error: 'not a URL' }) }
    const secure = u.protocol === 'wss:' || u.protocol === 'https:'
    if (!secure && u.protocol !== 'ws:' && u.protocol !== 'http:') return resolve({ upgraded: false, status: 0, firstMessage: null, error: `unsupported scheme ${u.protocol}` })
    u.protocol = secure ? 'https:' : 'http:'
    const timeoutMs = opts.timeoutMs ?? 15_000
    let done = false
    const finish = (r: AppWsProbe) => { if (!done) { done = true; clearTimeout(timer); resolve(r) } }
    const headers: Record<string, string> = {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      'User-Agent': 'Mozilla/5.0 (HyperProx update check)',
    }
    if (opts.origin) headers.Origin = opts.origin
    const req = (secure ? https : http).request(u, { headers, ...(secure ? { rejectUnauthorized: !opts.insecureTLS } : {}) })
    const timer = setTimeout(() => { req.destroy(); finish({ upgraded: false, status: 0, firstMessage: null, error: `no answer within ${Math.round(timeoutMs / 1000)} s` }) }, timeoutMs)
    req.on('response', res => { res.resume(); finish({ upgraded: false, status: res.statusCode ?? 0, firstMessage: null, error: `HTTP ${res.statusCode} instead of a websocket` }) })
    req.on('upgrade', (res, socket, head) => {
      let buf = Buffer.from(head)
      const end = (r: AppWsProbe) => { try { socket.write(closeFrame()) } catch { /* gone */ } socket.destroy(); finish(r) }
      const take = () => {
        for (;;) {
          const f = parseFrame(buf)
          if (!f) return
          buf = buf.subarray(f.length)
          if (f.opcode === 0x1) return end({ upgraded: true, status: res.statusCode ?? 101, firstMessage: f.payload.toString('utf8').slice(0, 2000) })
          if (f.opcode === 0x8) return end({ upgraded: true, status: res.statusCode ?? 101, firstMessage: f.payload.length > 2 ? f.payload.subarray(2).toString('utf8') : null })
        }
      }
      socket.on('data', (c: Buffer) => {
        buf = Buffer.concat([buf, c])
        if (buf.length > 64 * 1024) return end({ upgraded: true, status: res.statusCode ?? 101, firstMessage: null, error: 'first message larger than 64 KB' })
        take()
      })
      socket.on('close', () => finish({ upgraded: true, status: res.statusCode ?? 101, firstMessage: null }))
      socket.on('error', () => finish({ upgraded: true, status: res.statusCode ?? 101, firstMessage: null }))
      take()
    })
    req.on('error', e => finish({ upgraded: false, status: 0, firstMessage: null, error: e.message }))
    req.end()
  })
}
