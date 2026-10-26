// =============================================================================
//  HyperProx — certificate probe
//
//  Checks an endpoint the way a client would: connect, STARTTLS where the
//  protocol needs it, TLS handshake with SNI, then read what was actually
//  served. A valid certificate on disk proves nothing if the daemon serves
//  another one, so this is the only check whose answer counts.
// =============================================================================

import net from 'node:net'
import tls from 'node:tls'
import { X509Certificate } from 'node:crypto'
import type { CertsStartTls, CertsVerdict } from './types'

export interface ProbeTarget {
  host:        string
  port:        number
  starttls:    CertsStartTls
  servername?: string
  internal?:   boolean
  /**
   * Where to connect, when it is not `host`: split DNS, or a router that does not loop public names back
   * inside. `host` stays the name sent as SNI and verified against the certificate.
   */
  connect?:    string | null
}

export interface ProbeResult {
  ok:     boolean
  error?: string
  leaf?: {
    subject:        string
    issuer:         string
    names:          string[]
    notBefore:      Date
    notAfter:       Date
    serial:         string
    fingerprint256: string
    selfSigned:     boolean
  }
  trusted:             boolean | null
  authorizationError?: string
  namesMatch:          boolean | null
}

/** Extra trust anchors, added to the system roots. Tests use it; so could a network with its own CA. */
export interface ProbeOptions { ca?: string | string[] }

export const DEFAULT_PROBE_TIMEOUT_MS = 10_000

// Let's Encrypt staging issuers carry "(STAGING)"; Pebble's are "Pebble Intermediate CA ...".
export const STAGING_ISSUERS = /\(STAGING\)|\bPebble\b/i

const EHLO_NAME = 'hyperprox.invalid'

/**
 * One step of a STARTTLS dialogue: what to send (nothing for the greeting), and how to judge each reply line.
 * 'more' waits for the next line (multi-line SMTP replies), 'ok' moves on, a string fails with that reason.
 */
type Step = { send?: string; judge: (line: string) => 'more' | 'ok' | string }

function smtpReply(code: string, what: string) {
  return (line: string) => {
    if (!line.startsWith(code)) return `the SMTP server answered ${what} with "${line.slice(0, 120)}"`
    return line.charAt(3) === '-' ? 'more' : 'ok'
  }
}

const DIALOGUES: Record<Exclude<CertsStartTls, 'none'>, Step[]> = {
  smtp: [
    { judge: smtpReply('220', 'the connection') },
    { send: `EHLO ${EHLO_NAME}\r\n`, judge: smtpReply('250', 'EHLO') },
    { send: 'STARTTLS\r\n', judge: smtpReply('220', 'STARTTLS') },
  ],
  imap: [
    { judge: l => l.startsWith('* OK') ? 'ok' : `the IMAP server greeted with "${l.slice(0, 120)}"` },
    // Untagged lines (a capability list, say) may come before the tagged answer.
    { send: 'a1 STARTTLS\r\n', judge: l => l.startsWith('* ') ? 'more' : /^a1 OK/i.test(l) ? 'ok' : `the IMAP server answered STARTTLS with "${l.slice(0, 120)}"` },
  ],
  pop3: [
    { judge: l => l.startsWith('+OK') ? 'ok' : `the POP3 server greeted with "${l.slice(0, 120)}"` },
    { send: 'STLS\r\n', judge: l => l.startsWith('+OK') ? 'ok' : `the POP3 server answered STLS with "${l.slice(0, 120)}"` },
  ],
}

function describeError(e: NodeJS.ErrnoException): string {
  switch (e.code) {
    case 'ENOTFOUND':    return 'host not found'
    case 'EAI_AGAIN':    return 'host name could not be resolved'
    case 'ECONNREFUSED': return 'connection refused'
    case 'ECONNRESET':   return 'connection reset by the server'
    case 'EHOSTUNREACH': return 'host unreachable'
    case 'ENETUNREACH':  return 'network unreachable'
    default:             return e.message || String(e)
  }
}

/** "DNS:a, IP Address:1.2.3.4" → ['a', '1.2.3.4']. Other SAN kinds (email, URI) are not host names. */
function sanNames(san: string | undefined): string[] {
  if (!san) return []
  return san.split(/,\s*/).flatMap(part => {
    const m = /^(DNS|IP Address):(.+)$/.exec(part.trim())
    return m ? [m[2].trim()] : []
  })
}

function commonName(dn: string): string | null {
  const m = /(?:^|\n)CN=([^\n]+)/.exec(dn)
  return m ? m[1].trim() : null
}

function oneLine(dn: string): string {
  return dn.split('\n').filter(Boolean).join(', ')
}

/** Never throws: every failure, including the timeout, comes back as ok:false with a reason. */
export function probeEndpoint(t: ProbeTarget, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, opts: ProbeOptions = {}): Promise<ProbeResult> {
  return new Promise<ProbeResult>(resolve => {
    let settled = false
    let plain:  net.Socket | null = null
    let secure: tls.TLSSocket | null = null
    // The SNI name; an IP address is not allowed as SNI, but is still what the certificate must cover.
    const servername = t.servername ?? (net.isIP(t.host) ? undefined : t.host)
    const identity   = servername ?? t.host

    const finish = (r: ProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      secure?.destroy()
      plain?.destroy()
      resolve(r)
    }
    const fail = (error: string) => finish({ ok: false, error, trusted: null, namesMatch: null })

    // One deadline for the whole exchange: connect, STARTTLS dialogue and handshake together.
    const timer = setTimeout(() => fail(`no answer within ${Math.round(timeoutMs / 100) / 10}s`), timeoutMs)

    const handshake = (socket?: net.Socket) => {
      const extra = opts.ca === undefined ? [] : Array.isArray(opts.ca) ? opts.ca : [opts.ca]
      secure = tls.connect({
        ...(socket ? { socket } : { host: t.connect ?? t.host, port: t.port }),
        servername,
        // Accept anything so that an untrusted certificate can still be inspected; trust is reported, not enforced.
        rejectUnauthorized: false,
        ...(extra.length ? { ca: [...tls.rootCertificates, ...extra] } : {}),
      })
      secure.on('error', e => fail(describeError(e)))
      secure.once('secureConnect', () => {
        const s = secure!
        const peer = s.getPeerCertificate(false)
        if (!peer || !peer.raw) return fail('the server sent no certificate')
        let x: X509Certificate
        try { x = new X509Certificate(peer.raw) } catch (e) { return fail(`the served certificate could not be parsed: ${(e as Error).message}`) }

        let selfSigned = false
        try { selfSigned = x.subject === x.issuer && x.checkIssued(x) && x.verify(x.publicKey) } catch { /* not self-signed */ }
        const names = sanNames(x.subjectAltName)
        if (!names.length) { const cn = commonName(x.subject); if (cn) names.push(cn) }

        const mismatch = tls.checkServerIdentity(identity, peer)
        finish({
          ok: true,
          leaf: {
            subject:        oneLine(x.subject),
            issuer:         oneLine(x.issuer),
            names,
            notBefore:      new Date(x.validFrom),
            notAfter:       new Date(x.validTo),
            serial:         x.serialNumber,
            fingerprint256: x.fingerprint256,
            selfSigned,
          },
          trusted:    s.authorized,
          ...(s.authorized ? {} : { authorizationError: String(s.authorizationError ?? 'unknown') }),
          namesMatch: mismatch === undefined,
        })
      })
    }

    if (t.starttls === 'none') return handshake()

    const steps = DIALOGUES[t.starttls]
    if (!steps) return fail(`unknown STARTTLS protocol "${t.starttls}"`)
    const sock = net.connect({ host: t.connect ?? t.host, port: t.port })
    plain = sock
    let step = 0
    let buf  = ''
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('latin1')
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        const verdict = steps[step].judge(line)
        if (verdict === 'more') continue
        if (verdict !== 'ok') return fail(verdict)
        step++
        if (step === steps.length) {
          // The plain socket now belongs to TLS; nothing more may be read from it as text.
          sock.removeListener('data', onData)
          plain = null
          return handshake(sock)
        }
        if (steps[step].send) sock.write(steps[step].send!)
      }
      if (buf.length > 64 * 1024) fail('the server sent an over-long line before TLS')
    }
    sock.on('data', onData)
    sock.on('error', e => fail(describeError(e)))
    sock.once('close', () => { if (plain) fail('the server closed the connection before TLS started') })
    sock.once('connect', () => { if (steps[0].send) sock.write(steps[0].send) })
  })
}

// --- verdicts -------------------------------------------------------------------

export interface VerdictContext {
  now:                Date
  warnFraction:       number
  criticalDays:       number
  expectFingerprint?: string
  internal?:          boolean
  stagingIssuers?:    RegExp
}

const DAY_MS = 86_400_000
const CLOCK_SKEW_MS = 5 * 60_000

export function normalizeFingerprint(f: string): string {
  return f.replace(/[^0-9a-f]/gi, '').toUpperCase()
}

export function daysPhrase(ms: number): string {
  const days = Math.floor(Math.abs(ms) / DAY_MS)
  if (days === 0) return ms >= 0 ? 'within a day' : 'less than a day ago'
  const n = `${days} day${days === 1 ? '' : 's'}`
  return ms >= 0 ? `in ${n}` : `${n} ago`
}

export function fractionPhrase(f: number): string {
  if (Math.abs(f - 1 / 3) < 0.01) return 'a third'
  if (Math.abs(f - 1 / 4) < 0.01) return 'a quarter'
  if (Math.abs(f - 1 / 2) < 0.01) return 'half'
  return `${Math.round(f * 100)}%`
}

/**
 * The verdict on one served certificate, with a one-line reason. The order matters: the first, most serious
 * finding is the one reported.
 */
export function verdictFor(r: ProbeResult, ctx: VerdictContext): { verdict: CertsVerdict; reason: string | null } {
  if (!r.ok || !r.leaf) return { verdict: 'error', reason: `the probe failed: ${r.error ?? 'no certificate was served'}` }
  const leaf     = r.leaf
  const now      = ctx.now.getTime()
  const left     = leaf.notAfter.getTime() - now
  const lifetime = leaf.notAfter.getTime() - leaf.notBefore.getTime()
  const staging  = (ctx.stagingIssuers ?? STAGING_ISSUERS).test(leaf.issuer)

  if (left <= 0) return { verdict: 'critical', reason: `serves a certificate that expired ${daysPhrase(left)}` }
  // A few minutes of grace: a certificate issued just now, read by a clock running slightly behind, is fine.
  if (leaf.notBefore.getTime() > now + CLOCK_SKEW_MS) return { verdict: 'critical', reason: 'serves a certificate that is not valid yet' }
  if (ctx.expectFingerprint && normalizeFingerprint(ctx.expectFingerprint) !== normalizeFingerprint(leaf.fingerprint256)) {
    return { verdict: 'critical', reason: 'serves a different certificate from the one HyperProx deployed' }
  }
  if (r.namesMatch === false) {
    return { verdict: 'critical', reason: `serves a certificate for ${leaf.names.slice(0, 3).join(', ') || 'another name'}, which does not cover this host` }
  }
  if (left < ctx.criticalDays * DAY_MS) return { verdict: 'critical', reason: `serves a certificate that expires ${daysPhrase(left)}` }
  if (r.trusted === false && !ctx.internal && !staging) {
    return { verdict: 'critical', reason: leaf.selfSigned
      ? 'serves a self-signed certificate where a public one is expected'
      : `serves an untrusted certificate (${r.authorizationError ?? 'chain not trusted'})` }
  }
  if (lifetime > 0 && left / lifetime < ctx.warnFraction) {
    return { verdict: 'warn', reason: `expires ${daysPhrase(left)}, with less than ${fractionPhrase(ctx.warnFraction)} of its ${Math.round(lifetime / DAY_MS)}-day lifetime left` }
  }
  if (staging) return { verdict: 'warn', reason: 'serves a staging certificate, which clients do not trust' }
  // An internal endpoint (a node console, say) is expected to serve a self-signed or private-CA certificate;
  // that alone is not worth a warning, but the reason still says why an untrusted chain passed.
  if (r.trusted === false && ctx.internal) return { verdict: 'ok', reason: 'private certificate, expected here' }
  return { verdict: 'ok', reason: null }
}
