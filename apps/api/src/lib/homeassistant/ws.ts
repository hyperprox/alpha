// =============================================================================
//  HyperProx — a small WebSocket client, for Home Assistant's one WebSocket-only command
//
//  Home Assistant makes a long-lived access token only over its WebSocket API (there is no HTTP route for it), and
//  changes the home's name, time zone and units the same way. HyperProx has no WebSocket package, and adding a
//  dependency for two requests during an install is a bigger step than this file: it speaks just enough of RFC 6455 for
//  Home Assistant's JSON messages over plain HTTP on the local network. It is a client only, sends text frames, masks
//  them as the RFC requires, answers pings, and refuses a message larger than 4 MB.
// =============================================================================

import net from 'node:net'
import crypto from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_MESSAGE = 4 * 1024 * 1024

export interface HaSocket {
  /** Send one message and resolve with the answer that carries its id (or reject with the error it carries). */
  call(message: Record<string, unknown>, timeoutMs?: number): Promise<any>
  close(): void
}

export function encodeFrame(text: string, opcode = 0x1, mask = crypto.randomBytes(4)): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const n = payload.length
  const head = n < 126 ? Buffer.from([0x80 | opcode, 0x80 | n]) : n < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, n >> 8, n & 255])
    : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 0x80 | 127; b.writeBigUInt64BE(BigInt(n), 2); return b })()
  const out = Buffer.alloc(head.length + 4 + n)
  head.copy(out); mask.copy(out, head.length)
  for (let i = 0; i < n; i++) out[head.length + 4 + i] = payload[i] ^ mask[i % 4]
  return out
}

/** Pulls whole frames off a growing buffer. Returns what it found and what is left over. */
export function decodeFrames(buf: Buffer): { frames: Array<{ fin: boolean; opcode: number; payload: Buffer }>; rest: Buffer } {
  const frames: Array<{ fin: boolean; opcode: number; payload: Buffer }> = []
  let at = 0
  while (buf.length - at >= 2) {
    const b0 = buf[at], b1 = buf[at + 1]
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f, off = at + 2
    if (len === 126) { if (buf.length - off < 2) break; len = buf.readUInt16BE(off); off += 2 }
    else if (len === 127) { if (buf.length - off < 8) break; const big = buf.readBigUInt64BE(off); if (big > BigInt(MAX_MESSAGE)) throw new Error('The message is too large.'); len = Number(big); off += 8 }
    if (len > MAX_MESSAGE) throw new Error('The message is too large.')
    const maskKey = masked ? buf.subarray(off, off + 4) : null
    if (masked) off += 4
    if (buf.length - off < len) break
    const payload = Buffer.from(buf.subarray(off, off + len))
    if (maskKey) for (let i = 0; i < len; i++) payload[i] ^= maskKey[i % 4]
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload })
    at = off + len
  }
  return { frames, rest: buf.subarray(at) }
}

/** Open a connection to ws://host:port/path. Home Assistant sends {type:"auth_required"} first: see authenticate(). */
export function connect(host: string, port: number, path: string, timeoutMs = 15_000): Promise<{ send(text: string): void; onMessage(fn: (text: string) => void): void; onClose(fn: () => void): void; close(): void }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port })
    const key = crypto.randomBytes(16).toString('base64')
    let head = Buffer.alloc(0), upgraded = false, rest: Buffer = Buffer.alloc(0), assembled: Buffer[] = []
    const msgFns: Array<(t: string) => void> = [], closeFns: Array<() => void> = []
    // A message that arrives before anyone listens (Home Assistant speaks first, in the same packet as the upgrade) is held.
    const early: string[] = []
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('The WebSocket did not open in time.')) }, timeoutMs)
    const api = {
      send: (t: string) => { sock.write(encodeFrame(t)) },
      onMessage: (fn: (t: string) => void) => { msgFns.push(fn); while (early.length) fn(early.shift()!) },
      onClose: (fn: () => void) => { closeFns.push(fn) },
      close: () => { try { sock.write(encodeFrame('', 0x8)) } catch { /* already closed */ } sock.destroy() },
    }
    sock.once('error', e => { clearTimeout(timer); reject(e) })
    sock.once('close', () => closeFns.forEach(f => f()))
    sock.once('connect', () => {
      sock.write([`GET ${path} HTTP/1.1`, `Host: ${host}:${port}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', '', ''].join('\r\n'))
    })
    sock.on('data', chunk => {
      try {
        if (!upgraded) {
          head = Buffer.concat([head, chunk])
          const end = head.indexOf('\r\n\r\n')
          if (end < 0) return
          const text = head.subarray(0, end).toString('latin1')
          const accept = crypto.createHash('sha1').update(key + GUID).digest('base64')
          if (!/^HTTP\/1\.1 101/.test(text) || !new RegExp(`sec-websocket-accept:\\s*${accept.replace(/[+/=]/g, m => `\\${m}`)}`, 'i').test(text)) {
            clearTimeout(timer); sock.destroy(); reject(new Error('That address did not accept a WebSocket.')); return
          }
          upgraded = true; clearTimeout(timer)
          rest = head.subarray(end + 4)
          resolve(api)
          chunk = Buffer.alloc(0)
        }
        const got = decodeFrames(Buffer.concat([rest, chunk]))
        rest = got.rest
        for (const f of got.frames) {
          if (f.opcode === 0x9) sock.write(encodeFrame(f.payload.toString('utf8'), 0xA))
          else if (f.opcode === 0x8) sock.end()
          else if (f.opcode === 0x1 || f.opcode === 0x0) {
            assembled.push(f.payload)
            if (assembled.reduce((a, b) => a + b.length, 0) > MAX_MESSAGE) throw new Error('The message is too large.')
            if (f.fin) { const text = Buffer.concat(assembled).toString('utf8'); assembled = []; if (msgFns.length) msgFns.forEach(fn => fn(text)); else early.push(text) }
          }
        }
      } catch (e: any) { clearTimeout(timer); sock.destroy(); reject(e) }
    })
  })
}

/**
 * Sign in to Home Assistant's WebSocket API with an access token and return a socket that answers calls by id. The
 * token is sent once, in the auth message, and is not kept here.
 */
export async function haSocket(host: string, port: number, accessToken: string, timeoutMs = 20_000): Promise<HaSocket> {
  const ws = await connect(host, port, '/api/websocket', timeoutMs)
  const waiting = new Map<number, { ok: (v: any) => void; no: (e: Error) => void }>()
  let phase: 'start' | 'auth' | 'ready' = 'start'
  let id = 0
  let onReady: ((e?: Error) => void) | null = null
  ws.onMessage(text => {
    let m: any
    try { m = JSON.parse(text) } catch { return }
    if (m.type === 'auth_required' && phase === 'start') { phase = 'auth'; ws.send(JSON.stringify({ type: 'auth', access_token: accessToken })) }
    else if (m.type === 'auth_ok') { phase = 'ready'; onReady?.() }
    else if (m.type === 'auth_invalid') onReady?.(new Error('Home Assistant refused the access token.'))
    else if (m.type === 'result' && waiting.has(m.id)) {
      const w = waiting.get(m.id)!; waiting.delete(m.id)
      if (m.success) w.ok(m.result); else w.no(new Error(String(m.error?.message ?? 'Home Assistant refused the request.').slice(0, 200)))
    }
  })
  ws.onClose(() => { for (const w of waiting.values()) w.no(new Error('The connection to Home Assistant closed.')); waiting.clear(); onReady?.(new Error('The connection to Home Assistant closed.')) })
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('Home Assistant did not finish signing in.')), timeoutMs)
    onReady = e => { clearTimeout(t); e ? rej(e) : res() }
  }).catch(e => { ws.close(); throw e })
  return {
    call: (message, ms = timeoutMs) => new Promise((ok, no) => {
      const mid = ++id
      const t = setTimeout(() => { waiting.delete(mid); no(new Error('Home Assistant did not answer in time.')) }, ms)
      waiting.set(mid, { ok: v => { clearTimeout(t); ok(v) }, no: e => { clearTimeout(t); no(e) } })
      ws.send(JSON.stringify({ ...message, id: mid }))
    }),
    close: () => ws.close(),
  }
}
