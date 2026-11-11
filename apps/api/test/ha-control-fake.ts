// Pretend Home Assistant houses on loopback (REST and WebSocket), shared by the ha-control tests.
import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { HAState } from '../src/lib/ha-control/catalog'
import type { CredentialIO } from '../src/lib/ha-control/instances'
import { HttpHAClient, type HAConnection } from '../src/lib/ha-control/client'

/** The test houses live on loopback, which the real address guard refuses: tests aim through this one. */
export const openResolver = async (u: URL) => u.hostname.replace(/^\[|\]$/g, '')
export const testClient = (c: HAConnection) => new HttpHAClient(c, 10_000, openResolver)

export interface FakeOptions {
  /** Serve https with this key and certificate. */
  tls?: { key: Buffer; cert: Buffer }
  /** Answer /api/config one byte every 100 ms, forever. */
  slow?: boolean
  /** Answer the WebSocket's first command with a frame header claiming 20 MB. */
  hugeFrame?: boolean
}

// ── A pretend Home Assistant ─────────────────────────────────────────────────

export const TOKEN_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.token-for-house-a'
export const TOKEN_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.token-for-house-b'

export interface FakeHA { server: http.Server | https.Server; url: string; token: string; states: Map<string, HAState>; calls: string[]; seenAuth: Set<string>; isAdmin: boolean; up: boolean; statesReads: number; errorLog: string; sni: string[] }

export function st(entity_id: string, state: string, attributes: Record<string, any> = {}): HAState {
  return { entity_id, state, attributes: { friendly_name: attributes.friendly_name ?? entity_id, ...attributes }, last_changed: '2026-01-01T00:00:00Z', last_updated: '2026-01-01T00:00:00Z' }
}

function wsFrame(text: string): Buffer {
  const d = Buffer.from(text)
  const head = d.length < 126 ? Buffer.from([0x81, d.length])
    : d.length < 65536 ? Buffer.from([0x81, 126, d.length >> 8, d.length & 0xff])
    : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(d.length), 2); return b })()
  return Buffer.concat([head, d])
}

function readFrames(buf: Buffer): { msgs: string[]; rest: Buffer } {
  const msgs: string[] = []
  for (;;) {
    if (buf.length < 2) break
    let len = buf[1] & 0x7f, off = 2
    if (len === 126) { len = buf.readUInt16BE(2); off = 4 } else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10 }
    const mask = buf.subarray(off, off + 4); off += 4
    if (buf.length < off + len) break
    msgs.push(Buffer.from(buf.subarray(off, off + len).map((b, i) => b ^ mask[i % 4])).toString())
    buf = buf.subarray(off + len)
  }
  return { msgs, rest: buf }
}

export async function fakeHA(token: string, states: HAState[], areas: { area: string; entities: string[] }[] = [], opts: FakeOptions = {}): Promise<FakeHA> {
  const f: FakeHA = { server: null as any, url: '', token, states: new Map(states.map(s => [s.entity_id, s])), calls: [], seenAuth: new Set(), isAdmin: false, up: true, statesReads: 0, errorLog: '', sni: [] }
  let tick = 0
  const touch = (s: HAState) => { s.last_updated = new Date(Date.UTC(2026, 0, 2, 0, 0, ++tick)).toISOString() }
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    f.seenAuth.add(String(req.headers.authorization))
    if (!f.up) { req.socket.destroy(); return }
    res.setHeader('content-type', 'application/json')
    if (req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; return res.end('{"message":"401: Unauthorized"}') }
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const url = req.url ?? ''
      if (opts.slow && url === '/api/config') {
        const t = setInterval(() => { if (res.destroyed) return clearInterval(t); res.write(' ') }, 100)
        res.on('close', () => clearInterval(t))
        return
      }
      if (req.method === 'GET' && url === '/api/states') f.statesReads++
      if (req.method === 'GET' && url === '/api/states') return res.end(JSON.stringify([...f.states.values()]))
      if (req.method === 'GET' && url.startsWith('/api/states/')) {
        const s = f.states.get(decodeURIComponent(url.slice('/api/states/'.length)))
        if (!s) { res.statusCode = 404; return res.end('{}') }
        return res.end(JSON.stringify(s))
      }
      if (req.method === 'GET' && url === '/api/config') return res.end(JSON.stringify({ version: '2026.11.0', location_name: 'Test house', components: [] }))
      if (req.method === 'GET' && url === '/api/error_log') { res.setHeader('content-type', 'text/plain'); return res.end(f.errorLog) }
      const m = /^\/api\/services\/([a-z_]+)\/([a-z_]+)$/.exec(url)
      if (req.method === 'POST' && m) {
        f.calls.push(`${m[1]}.${m[2]} ${body}`)
        const data = JSON.parse(body || '{}')
        const s = f.states.get(data.entity_id)
        if (s && s.entity_id !== 'switch.stuck') {
          const svc = m[2]
          if (svc === 'turn_on') { s.state = s.entity_id.startsWith('scene.') || s.entity_id.startsWith('script.') ? s.state : 'on'; if (data.brightness_pct !== undefined) { s.attributes.brightness = Math.round(data.brightness_pct * 2.55); if (data.brightness_pct === 0) s.state = 'off' } }
          if (svc === 'turn_off') s.state = 'off'
          if (svc === 'lock') s.state = 'locked'
          if (svc === 'unlock') s.state = 'unlocked'
          if (svc === 'open_cover') s.state = 'open'
          if (svc === 'close_cover') s.state = 'closed'
          if (svc === 'set_temperature') s.attributes.temperature = data.temperature
          if (svc === 'set_cover_position') s.attributes.current_position = data.position
          if (svc === 'set_hvac_mode') s.state = data.hvac_mode
          touch(s)
        }
        return res.end('[]')
      }
      res.statusCode = 404; res.end('{}')
    })
  }
  f.server = opts.tls ? https.createServer({ key: opts.tls.key, cert: opts.tls.cert }, handler) : http.createServer(handler)
  f.server.on('secureConnection', (t: any) => { f.sni.push(String(t.servername ?? '')) })
  f.server.on('upgrade', (req, socket) => {
    if (req.url !== '/api/websocket') return socket.destroy()
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC11B65').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const send = (o: unknown) => socket.write(wsFrame(JSON.stringify(o)))
    send({ type: 'auth_required', ha_version: '2026.11.0' })
    let buf = Buffer.alloc(0)
    socket.on('data', (d: Buffer) => {
      const r = readFrames(Buffer.concat([buf, d])); buf = r.rest
      for (const t of r.msgs) {
        const m = JSON.parse(t)
        if (m.type === 'auth') { send(m.access_token === token ? { type: 'auth_ok' } : { type: 'auth_invalid' }); continue }
        if (opts.hugeFrame) {
          const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(20 * 1024 * 1024), 2)
          socket.write(h); socket.write(Buffer.alloc(64 * 1024)); continue
        }
        const result = m.type === 'config/area_registry/list' ? areas.map((a, i) => ({ area_id: `a${i}`, name: a.area }))
          : m.type === 'config/device_registry/list' ? []
          : m.type === 'config/entity_registry/list' ? areas.flatMap((a, i) => a.entities.map(e => ({ entity_id: e, area_id: `a${i}`, device_id: null })))
          : m.type === 'auth/current_user' ? { id: 'u1', name: 'hyperprox', is_owner: false, is_admin: f.isAdmin }
          : null
        send({ id: m.id, type: 'result', success: result !== null, result })
      }
    })
    socket.on('error', () => {})
  })
  await new Promise<void>(r => f.server.listen(0, '127.0.0.1', r))
  f.url = `${opts.tls ? 'https' : 'http'}://127.0.0.1:${(f.server.address() as AddressInfo).port}`
  return f
}

export function memIO(seed: Record<string, string> = {}): CredentialIO & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed))
  return {
    data,
    async get(c, p, k) { return data.get(`${c}/${p}/${k}`) ?? null },
    async set(c, p, k, v) { data.set(`${c}/${p}/${k}`, v) },
    async remove(c, p) { for (const k of [...data.keys()]) if (k.startsWith(`${c}/${p}/`)) data.delete(k) },
  }
}

export const HOUSE_A = () => [
  st('light.kitchen', 'off', { friendly_name: 'Kitchen', supported_color_modes: ['color_temp'], min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6500 }),
  st('switch.stuck', 'off', { friendly_name: 'Stuck plug', device_class: 'outlet' }),
  st('scene.goodnight', '2026-01-01T00:00:00Z', { friendly_name: 'Goodnight' }),
  st('button.doorbell_test', 'unknown', { friendly_name: 'Doorbell test' }),
  st('lock.front_door', 'locked', { friendly_name: 'Front door' }),
  st('cover.garage', 'closed', { friendly_name: 'Garage', device_class: 'garage' }),
  st('cover.blind', 'closed', { friendly_name: 'Blind', device_class: 'blind', current_position: 0 }),
  st('climate.lounge', 'heat', { friendly_name: 'Lounge', hvac_modes: ['off', 'heat'], min_temp: 7, max_temp: 30, temperature: 20 }),
  st('sensor.temp', '21', { friendly_name: 'Temperature', unit_of_measurement: '°C' }),
  st('switch.gone', 'unavailable', { friendly_name: 'Gone plug', device_class: 'outlet' }),
]

