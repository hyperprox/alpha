// =============================================================================
//  HyperProx — Home Assistant control: one instance's connection
//
//  Built for exactly one instance, from that instance's own address and token,
//  so a call meant for one house can never carry the other's token or reach the
//  other's address. The token goes into the Authorization header and nowhere
//  else: never into an error, a log line or an answer.
//
//  The only write is callService(), and only the service layer calls it, with a
//  call the allow-list built (catalog.ts). The WebSocket is used for reads that
//  have no REST endpoint: the area, device and entity registries, and which
//  Home Assistant user the token belongs to.
// =============================================================================

import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import type { HAState, ServiceCall } from './catalog'

export interface HAConnection { url: string; token: string; insecureTLS: boolean }

export class HAUnreachableError extends Error {
  constructor(message: string) { super(message); this.name = 'HAUnreachableError' }
}

export interface HAUser { name: string; isAdmin: boolean; isOwner: boolean }
export interface HARegistry {
  areas:    Array<{ area_id: string; name: string }>
  devices:  Array<{ id: string; area_id: string | null }>
  entities: Array<{ entity_id: string; area_id: string | null; device_id: string | null; hidden?: boolean }>
}

/** The calls the service layer makes. An interface so tests can count what reached which instance. */
export interface HAClient {
  states(): Promise<HAState[]>
  state(entityId: string): Promise<HAState | null>
  config(): Promise<Record<string, any>>
  errorLog(): Promise<string>
  callService(call: ServiceCall): Promise<void>
  registry(): Promise<HARegistry>
  currentUser(): Promise<HAUser>
}

/** Strip anything address- or token-shaped out of an error before it is shown. */
function plainError(e: any, what: string): HAUnreachableError {
  const code = e?.code ?? e?.cause?.code
  const why = code === 'ECONNREFUSED' ? 'connection refused'
    : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'the address does not resolve'
    : code === 'ETIMEDOUT' || /timed out|abort/i.test(String(e?.message)) ? 'it did not answer in time'
    : code === 'EHOSTUNREACH' || code === 'ENETUNREACH' ? 'no route to it'
    : /certificate|self.signed|CERT_/i.test(String(e?.message ?? code)) ? 'its certificate is not trusted (turn on "Accept a self-signed certificate" if that is expected)'
    : 'it could not be reached'
  return new HAUnreachableError(`Home Assistant ${what}: ${why}.`)
}

export class HttpHAClient implements HAClient {
  private base: URL
  constructor(private c: HAConnection, private timeoutMs = 10_000) {
    this.base = new URL(c.url.replace(/\/+$/, '') + '/')
    if (!['http:', 'https:'].includes(this.base.protocol)) throw new HAUnreachableError('The Home Assistant address must start with http:// or https://.')
  }

  private request(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<{ status: number; text: string }> {
    const url = new URL(path.replace(/^\//, ''), this.base)
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const mod = url.protocol === 'https:' ? https : http
    return new Promise((resolve, reject) => {
      const req = mod.request(url, {
        method, timeout: timeoutMs,
        headers: { Authorization: `Bearer ${this.c.token}`, Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json' } : {}) },
        ...(url.protocol === 'https:' ? { rejectUnauthorized: !this.c.insecureTLS } : {}),
      }, res => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', ch => { text += ch; if (text.length > 32 * 1024 * 1024) req.destroy(new Error('answer too large')) })
        res.on('end', () => resolve({ status: res.statusCode ?? 500, text }))
      })
      req.on('timeout', () => req.destroy(new Error('timed out')))
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }

  private async json(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number): Promise<any> {
    let r: { status: number; text: string }
    try { r = await this.request(method, path, body, timeoutMs) } catch (e) { throw plainError(e, 'is unreachable') }
    if (r.status === 401 || r.status === 403) throw new HAUnreachableError('Home Assistant refused the token (it may have been deleted, or belong to a user without access).')
    if (r.status === 404) return null
    if (r.status >= 400) throw new HAUnreachableError(`Home Assistant answered HTTP ${r.status}.`)
    if (!r.text) return null
    try { return JSON.parse(r.text) } catch { return r.text }
  }

  async states(): Promise<HAState[]> {
    const s = await this.json('GET', '/api/states', undefined, 20_000)
    return Array.isArray(s) ? s.filter(x => x && typeof x.entity_id === 'string') : []
  }
  async state(entityId: string): Promise<HAState | null> {
    const s = await this.json('GET', `/api/states/${encodeURIComponent(entityId)}`)
    return s && typeof s === 'object' && s.entity_id === entityId ? s : null
  }
  async config(): Promise<Record<string, any>> { return (await this.json('GET', '/api/config')) ?? {} }
  async errorLog(): Promise<string> {
    try { const t = await this.json('GET', '/api/error_log', undefined, 15_000); return typeof t === 'string' ? t : '' } catch { return '' }
  }
  async callService(call: ServiceCall): Promise<void> {
    // Validated by the allow-list before it gets here; checked again so a bad name can never become a path.
    if (!/^[a-z_]+$/.test(call.domain) || !/^[a-z_]+$/.test(call.service)) throw new Error('refused: not a service name')
    await this.json('POST', `/api/services/${call.domain}/${call.service}`, call.data, 15_000)
  }

  async registry(): Promise<HARegistry> {
    const [areas, devices, entities] = await this.ws([
      { type: 'config/area_registry/list' },
      { type: 'config/device_registry/list' },
      { type: 'config/entity_registry/list' },
    ])
    const arr = (v: any) => Array.isArray(v) ? v : []
    return {
      areas:    arr(areas).filter((a: any) => typeof a?.area_id === 'string').map((a: any) => ({ area_id: a.area_id, name: String(a.name ?? a.area_id).slice(0, 80) })),
      devices:  arr(devices).filter((d: any) => typeof d?.id === 'string').map((d: any) => ({ id: d.id, area_id: typeof d.area_id === 'string' ? d.area_id : null })),
      entities: arr(entities).filter((e: any) => typeof e?.entity_id === 'string').map((e: any) => ({
        entity_id: e.entity_id, area_id: typeof e.area_id === 'string' ? e.area_id : null,
        device_id: typeof e.device_id === 'string' ? e.device_id : null, hidden: !!e.hidden_by,
      })),
    }
  }

  async currentUser(): Promise<HAUser> {
    const [u] = await this.ws([{ type: 'auth/current_user' }])
    return { name: String(u?.name ?? '').slice(0, 80), isAdmin: !!u?.is_admin, isOwner: !!u?.is_owner }
  }

  /** Open the WebSocket, authenticate, send each command, collect each result, close. */
  private ws(commands: Array<Record<string, unknown>>): Promise<any[]> {
    const url = new URL('api/websocket', this.base)
    return wsExchange(url, this.c.token, this.c.insecureTLS, commands, this.timeoutMs)
      .catch(e => { throw e instanceof HAUnreachableError ? e : plainError(e, 'did not answer on its WebSocket') })
  }
}

// ---------------------------------------------------------------------------
//  A minimal WebSocket client (RFC 6455): text frames, client masking, one
//  connection per exchange. Node 20 has no global WebSocket, and this keeps the
//  dependency list as it is.
// ---------------------------------------------------------------------------

function encodeFrame(text: string): Buffer {
  const data = Buffer.from(text, 'utf8')
  const mask = crypto.randomBytes(4)
  const len = data.length
  const head = len < 126 ? Buffer.from([0x81, 0x80 | len])
    : len < 65536 ? Buffer.from([0x81, 0x80 | 126, len >> 8, len & 0xff])
    : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 0x80 | 127; b.writeBigUInt64BE(BigInt(len), 2); return b })()
  const body = Buffer.alloc(len)
  for (let i = 0; i < len; i++) body[i] = data[i] ^ mask[i % 4]
  return Buffer.concat([head, mask, body])
}

export function wsExchange(url: URL, token: string, insecureTLS: boolean, commands: Array<Record<string, unknown>>, timeoutMs: number): Promise<any[]> {
  const secure = url.protocol === 'https:'
  const key = crypto.randomBytes(16).toString('base64')
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (err: Error | null, value?: any[]) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { sock?.destroy() } catch { /* closed */ }
      err ? reject(err) : resolve(value!)
    }
    const timer = setTimeout(() => finish(new HAUnreachableError('Home Assistant did not answer on its WebSocket in time.')), timeoutMs)
    let sock: import('node:net').Socket | null = null
    const req = (secure ? https : http).request(url, {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
      ...(secure ? { rejectUnauthorized: !insecureTLS } : {}),
    })
    req.on('error', e => finish(e))
    req.on('response', res => { res.resume(); finish(new HAUnreachableError(`Home Assistant refused the WebSocket (HTTP ${res.statusCode}).`)) })
    req.on('upgrade', (res, socket, head) => {
      sock = socket
      const expect = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC11B65').digest('base64')
      if (res.headers['sec-websocket-accept'] !== expect) return finish(new HAUnreachableError('Home Assistant answered the WebSocket oddly.'))
      let buf: Buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0)
      let partial: Buffer[] = []
      const results: any[] = new Array(commands.length)
      let got = 0
      const send = (o: unknown) => socket.write(encodeFrame(JSON.stringify(o)))
      const onMessage = (text: string) => {
        let m: any
        try { m = JSON.parse(text) } catch { return }
        if (m.type === 'auth_required') return send({ type: 'auth', access_token: token })
        if (m.type === 'auth_invalid') return finish(new HAUnreachableError('Home Assistant refused the token.'))
        if (m.type === 'auth_ok') { commands.forEach((c, i) => send({ ...c, id: i + 1 })); return }
        if (m.type === 'result' && typeof m.id === 'number' && m.id >= 1 && m.id <= commands.length) {
          results[m.id - 1] = m.success ? m.result : null
          if (++got === commands.length) finish(null, results)
        }
      }
      const parse = () => {
        for (;;) {
          if (buf.length < 2) return
          const fin = (buf[0] & 0x80) !== 0
          const op = buf[0] & 0x0f
          const masked = (buf[1] & 0x80) !== 0
          let len = buf[1] & 0x7f
          let off = 2
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
          if (len > 64 * 1024 * 1024) return finish(new HAUnreachableError('Home Assistant sent too much.'))
          const mOff = off
          if (masked) off += 4
          if (buf.length < off + len) return
          let payload = buf.subarray(off, off + len)
          if (masked) { const mk = buf.subarray(mOff, mOff + 4); payload = Buffer.from(payload.map((b, i) => b ^ mk[i % 4])) }
          buf = buf.subarray(off + len)
          if (op === 0x8) return finish(new HAUnreachableError('Home Assistant closed the WebSocket.'))
          if (op === 0x9) { continue }      // ping: Home Assistant does not require a pong within one short exchange
          if (op === 0x1 || op === 0x0) {
            partial.push(Buffer.from(payload))
            if (fin) { const t = Buffer.concat(partial).toString('utf8'); partial = []; onMessage(t) }
          }
        }
      }
      socket.on('data', (d: Buffer) => { buf = Buffer.concat([buf, d]); parse() })
      socket.on('error', e => finish(e))
      socket.on('close', () => finish(new HAUnreachableError('Home Assistant closed the WebSocket.')))
      parse()
    })
    req.end()
  })
}
