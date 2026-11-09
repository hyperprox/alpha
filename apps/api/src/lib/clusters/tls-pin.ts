// =============================================================================
//  HyperProx — certificate pinning for a remote Proxmox API
//
//  A remote server's Proxmox page uses its own self-signed certificate, so normal certificate checks would
//  refuse it and turning them off would trust anything. Instead HyperProx pins the certificate itself: the
//  owner compares its SHA-256 fingerprint with the one on that server's own page (Node -> System ->
//  Certificates) and confirms it. After that only that certificate is accepted.
//
//  The check happens before a single byte of the request is sent: PinnedAgent hands the socket to the HTTP
//  layer only once the handshake is done and the fingerprint matched, so the API token never reaches a
//  server that presented a different certificate.
// =============================================================================

import https from 'node:https'
import tls from 'node:tls'
import net from 'node:net'
import type { Duplex } from 'node:stream'

/** "AB:CD:..." upper case, 32 pairs. Accepts the same with or without colons, any case. */
export function normaliseFingerprint(raw: string): string | null {
  const hex = String(raw ?? '').replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  if (hex.length !== 64) return null
  return hex.match(/.{2}/g)!.join(':')
}

export class CertificateChangedError extends Error {
  readonly code = 'cert_changed'
  constructor(readonly host: string, readonly port: number, readonly expected: string, readonly presented: string) {
    super(`The certificate at ${host}:${port} is not the one you confirmed, so HyperProx sent it nothing. ` +
      `Confirmed: ${expected}. Presented now: ${presented}. If that server's certificate was renewed on purpose, ` +
      'compare the new fingerprint on its own Proxmox page and confirm it again.')
    this.name = 'CertificateChangedError'
  }
}

/**
 * An HTTPS agent that accepts exactly one certificate. createConnection answers through its callback, after
 * the handshake: the HTTP request (headers, token, body) is written only to a socket that already passed.
 */
export class PinnedAgent extends https.Agent {
  constructor(private readonly fingerprint: string, opts: https.AgentOptions = {}) {
    super({ keepAlive: false, ...opts })
    if (!normaliseFingerprint(fingerprint)) throw new Error('A pinned certificate needs a SHA-256 fingerprint')
  }

  // Node's agent supports a callback here: with no socket returned, it waits for oncreate.
  createConnection(options: any, oncreate?: (err: Error | null, socket: Duplex) => void): Duplex | undefined {
    const expected = normaliseFingerprint(this.fingerprint)!
    const host = options.host ?? options.hostname
    const port = Number(options.port)
    const socket = tls.connect({
      host, port, servername: net.isIP(host) ? undefined : host,
      // The chain is self-signed by design; the fingerprint below is the check.
      rejectUnauthorized: false,
      timeout: options.timeout,
    })
    let done = false
    const finish = (err: Error | null) => {
      if (done) return
      done = true
      if (err) { socket.destroy(); oncreate?.(err, socket) } else oncreate?.(null, socket)
    }
    socket.once('secureConnect', () => {
      const presented = normaliseFingerprint(socket.getPeerCertificate()?.fingerprint256 ?? '') ?? 'none'
      if (presented !== expected) finish(new CertificateChangedError(host, port, expected, presented))
      else finish(null)
    })
    socket.once('error', e => finish(e))
    return undefined
  }
}

export interface PresentedCertificate {
  fingerprint: string
  subject: string
  issuer: string
  validFrom: string
  validTo: string
  /** Names the certificate is for. */
  altNames: string[]
}

/** Address syntax only (a name, IPv4 or IPv6): no scheme, path, user or port. */
export function isServerAddress(a: string): boolean {
  const s = String(a ?? '').trim()
  if (!s || s.length > 253) return false
  if (net.isIP(s)) return true
  return /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(s)
}

/**
 * Ports a Proxmox API may be on: its own 8006, the usual HTTPS ones, or any unprivileged port. A low port that
 * is some other service (22, 25, 53...) is refused, so these checks cannot be used to poke at one.
 */
export function allowedApiPort(port: number): boolean {
  return Number.isInteger(port) && (port === 443 || port === 8006 || port === 8443 || (port >= 1024 && port <= 65535))
}

/** One plain message for any failure to connect: refused, timed out or reset all read the same. */
export const GENERIC_CONNECT_ERROR = 'Could not read a certificate from that address and port. Check the address, the port, and that HyperProx can reach it.'

/**
 * Connect, read the certificate, hang up. Nothing is sent: this is what the owner compares on step 4.
 */
export function probeCertificate(host: string, port: number, timeoutMs = 10_000): Promise<PresentedCertificate> {
  return new Promise((resolve, reject) => {
    if (!isServerAddress(host) || !allowedApiPort(port)) return reject(new Error('That is not a server address and port HyperProx can use (the Proxmox port is normally 8006).'))
    const socket = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false })
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(GENERIC_CONNECT_ERROR)) }, timeoutMs)
    socket.once('secureConnect', () => {
      clearTimeout(timer)
      const c = socket.getPeerCertificate()
      socket.end()
      const fingerprint = normaliseFingerprint(c?.fingerprint256 ?? '')
      if (!fingerprint) return reject(new Error(GENERIC_CONNECT_ERROR))
      const name = (o: any) => (o ? Object.entries(o).map(([k, v]) => `${k}=${v}`).join(', ') : '')
      resolve({
        fingerprint, subject: name(c.subject), issuer: name(c.issuer), validFrom: c.valid_from, validTo: c.valid_to,
        altNames: String(c.subjectaltname ?? '').split(',').map(s => s.trim().replace(/^(DNS|IP Address):/, '')).filter(Boolean),
      })
    })
    socket.once('error', () => { clearTimeout(timer); reject(new Error(GENERIC_CONNECT_ERROR)) })
  })
}
