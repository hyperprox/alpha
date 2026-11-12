// =============================================================================
//  HyperProx — site metrics: reading nginx access log lines
//
//  Three shapes are understood, and told apart line by line:
//    common    $remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent
//    combined  common + "$http_referer" "$http_user_agent"            (nginx's default)
//    extended  combined + $request_time "$http_x_forwarded_for"       (HyperProx's hyperprox_metrics)
//  nginx's own "main" example (combined + "$http_x_forwarded_for") and other
//  orders of those two extras are read too. A line that fits none of them is
//  counted as malformed and otherwise ignored.
//
//  LiteSpeed writes the same combined shape (Apache's %h %l %u %t "%r" %>s %b
//  "%{Referer}i" "%{User-Agent}i"). CyberPanel's vhost template sets that as a
//  logFormat wrapped in one more pair of quotes, and LiteSpeed writes those
//  quotes too: the line starts with " and ends with "". That outer pair is
//  taken off before the line is read.
//
//  The address is only ever used to make the day's visitor hash and is then
//  dropped: a parsed line never leaves the collector.
// =============================================================================

import net from 'node:net'

export type LogFormat = 'common' | 'combined' | 'extended'

export interface LogLine {
  /** The address the request came from: the proxy's, when there is one in front. */
  remote: string
  /** The visitor's address: the last public one in X-Forwarded-For when a private proxy sent the request. */
  client: string
  time: Date
  method: string
  /** Path only: the query string is dropped here, because it can carry tokens and personal data. */
  path: string
  status: number
  bytes: number
  referer: string
  ua: string
  /** Seconds, when the line has $request_time. */
  requestTime: number | null
  format: LogFormat
}

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }

/** "11/Nov/2026:20:10:14 +0000" → Date, or null. */
export function parseNginxTime(s: string): Date | null {
  const m = /^(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(s)
  if (!m || MONTHS[m[2]] === undefined) return null
  const off = (Number(m[8]) * 60 + Number(m[9])) * (m[7] === '-' ? -1 : 1)
  const t = Date.UTC(Number(m[3]), MONTHS[m[2]], Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - off * 60_000
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? null : d
}

const HEAD = /^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d{3}) (\d+|-)(.*)$/
const TOKEN = /\s+(?:"([^"]*)"|(\d+(?:\.\d+)?)|(-))/y

/** True for loopback, private, link-local and unique-local addresses: a proxy in front, not a visitor. */
export function isPrivateAddress(a: string): boolean {
  const v = net.isIP(a)
  if (v === 4) {
    const [x, y] = a.split('.').map(Number)
    return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) ||
      (x === 100 && y >= 64 && y <= 127) || x === 0
  }
  if (v === 6) {
    const l = a.toLowerCase()
    if (l.startsWith('::ffff:') && net.isIP(l.slice(7)) === 4) return isPrivateAddress(l.slice(7))
    return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80')
  }
  return false
}

/**
 * The visitor's address. X-Forwarded-For is believed only when the request came from a private address (the
 * proxy in front); its last public entry is the one that proxy saw, so a visitor cannot pick their own.
 */
export function clientAddress(remote: string, xff: string | null): string {
  if (!xff || xff === '-' || !isPrivateAddress(remote)) return remote
  const parts = xff.split(',').map(s => s.trim()).filter(s => net.isIP(s))
  for (let i = parts.length - 1; i >= 0; i--) if (!isPrivateAddress(parts[i])) return parts[i]
  return remote
}

/** One line, or null when it fits no known format. */
/** A line wrapped in one extra pair of quotes, as LiteSpeed writes a quoted logFormat: '"203.0.113.7 - - [..] "GET / HTTP/1.1" 200 5 "-" "UA""'. */
const WRAPPED = /^"([^\s"]+ \S+ \S+ \[[^\]]+\] "[\s\S]*)"$/

export function parseLogLine(line: string): LogLine | null {
  let text = line.replace(/\r$/, '')
  const w = WRAPPED.exec(text)
  if (w) text = w[1]
  const m = HEAD.exec(text)
  if (!m) return null
  const time = parseNginxTime(m[2])
  if (!time) return null
  const req = m[3].split(' ')
  // "-" or a TLS handshake sent to a plain port: a request line that is not a request.
  const method = req.length >= 2 && /^[A-Z]{3,10}$/.test(req[0]) ? req[0] : ''
  const target = method ? req[1] : ''
  let path = target.split('?')[0].split('#')[0]
  if (/^https?:\/\//i.test(path)) { try { path = new URL(path).pathname } catch { path = '' } }
  if (path && !path.startsWith('/')) path = ''
  const tail = m[6]
  const quoted: string[] = []
  const numbers: number[] = []
  TOKEN.lastIndex = 0
  let pos = 0
  while (pos < tail.length) {
    TOKEN.lastIndex = pos
    const t = TOKEN.exec(tail)
    if (!t) break
    if (t[1] !== undefined) quoted.push(t[1])
    else if (t[2] !== undefined) numbers.push(Number(t[2]))
    else quoted.push('-')
    pos = TOKEN.lastIndex
  }
  if (tail.slice(pos).trim() !== '') return null
  let format: LogFormat = 'common'
  let referer = '-', ua = '-', xff: string | null = null, requestTime: number | null = null
  if (quoted.length >= 2) {
    format = 'combined'
    referer = quoted[0]; ua = quoted[1]
    if (quoted.length >= 3) xff = quoted[2]
    if (numbers.length) { requestTime = numbers[0]; format = 'extended' }
  } else if (quoted.length || numbers.length) return null
  const remote = m[1]
  return {
    remote, client: clientAddress(remote, xff), time, method, path, status: Number(m[4]),
    bytes: m[5] === '-' ? 0 : Number(m[5]), referer, ua: ua === '-' ? '' : ua, requestTime, format,
  }
}

/** Split a chunk into whole lines. `rest` is the unfinished last line, `consumed` the bytes the whole lines took. */
export function splitLines(buf: Buffer, final = false): { lines: string[]; consumed: number } {
  const lastNl = buf.lastIndexOf(0x0a)
  const end = final ? buf.length : lastNl + 1
  if (end <= 0) return { lines: [], consumed: 0 }
  const text = buf.subarray(0, end).toString('utf8')
  const lines = text.split('\n').filter(l => l.length > 0)
  return { lines, consumed: end }
}
