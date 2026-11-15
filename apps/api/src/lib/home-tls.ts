// =============================================================================
//  HyperProx — the home Proxmox API's certificate
//
//  The home cluster's Proxmox API usually has its own self-signed certificate, so ordinary verification would
//  refuse it, and HyperProx used to turn verification off for it (rejectUnauthorized: false): anyone able to
//  answer on that address could have read the API token. Now the certificate is pinned, as a remote cluster's is:
//
//    - a certificate that verifies normally (a public CA, the right name) is always accepted, and becomes the pin,
//      so a Let's Encrypt certificate that renews every two months keeps working;
//    - otherwise the first one seen at host:port is pinned, recorded as learned on first use (an install that
//      predates this pins its current certificate the first time it connects after the update);
//    - after that only that certificate is accepted. A different one is refused before a byte of the request
//      (the token included) is sent, with both fingerprints in the message.
//
//  The pins are public facts (fingerprints), kept in a root-only file in the install's data/ folder so they can be
//  read and written while HyperProx is locked: <install dir>/data/home-tls-pins.json. Removing an entry there (or
//  the file) re-pins on the next connection, which is how a certificate replaced on purpose is accepted.
// =============================================================================

import https from 'node:https'
import tls from 'node:tls'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { Duplex } from 'node:stream'
import { normaliseFingerprint } from './clusters/tls-pin'
import { appLog } from './log-once'

export type HomePinSource = 'first-use' | 'ca-verified' | 'confirmed'
export interface HomePin { fingerprint: string; source: HomePinSource; at: string }

/**
 * Where the pins are kept: HPX_HOME_TLS_PINS, else data/ at the root of the checkout this code runs from
 * (src/lib and dist/lib are both four levels down). Under `node --test` with no override, a file per test process
 * in the temp folder, so a test's throwaway server never lands in a real install's pins.
 */
export function homePinFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HPX_HOME_TLS_PINS) return env.HPX_HOME_TLS_PINS
  if (env.NODE_TEST_CONTEXT) return join(tmpdir(), `hpx-home-tls-pins-${process.pid}.json`)
  return resolve(__dirname, '..', '..', '..', '..', 'data', 'home-tls-pins.json')
}

const key = (host: string, port: number) => `${String(host).toLowerCase().replace(/^\[|\]$/g, '')}:${port}`

function readPins(): Record<string, HomePin> {
  try {
    const raw = JSON.parse(readFileSync(homePinFile(), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch { return {} }
}

function writePins(pins: Record<string, HomePin>): void {
  const file = homePinFile()
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(pins, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

export function homeTlsPin(host: string, port: number): HomePin | null {
  return readPins()[key(host, port)] ?? null
}

export function recordHomeTlsPin(host: string, port: number, fingerprint: string, source: HomePinSource): void {
  const fp = normaliseFingerprint(fingerprint)
  if (!fp) throw new Error('Not a SHA-256 certificate fingerprint')
  const pins = readPins()
  pins[key(host, port)] = { fingerprint: fp, source, at: new Date().toISOString() }
  writePins(pins)
}

export function forgetHomeTlsPin(host: string, port: number): void {
  const pins = readPins()
  if (delete pins[key(host, port)]) writePins(pins)
}

export class HomeCertificateChangedError extends Error {
  readonly code = 'home_cert_changed'
  constructor(readonly host: string, readonly port: number, readonly expected: string, readonly presented: string) {
    super(`The certificate of your Proxmox API at ${host}:${port} is not the one HyperProx pinned, so it sent nothing (not even the API token). ` +
      `Pinned: ${expected}. Presented now: ${presented}. If you replaced that certificate on purpose, check the new fingerprint on the node ` +
      `(Node -> System -> Certificates), then remove the "${key(host, port)}" entry from ${homePinFile()} on the HyperProx machine; the next connection pins the new one.`)
    this.name = 'HomeCertificateChangedError'
  }
}

/**
 * What to do with the certificate a home Proxmox presented: accept (and pin it when there was no pin, or when it
 * verifies normally), or refuse. Pure, for the tests: `authorized` is Node's verdict (chain and name).
 */
export function homeCertDecision(pin: HomePin | null, presented: string, authorized: boolean): { accept: boolean; record?: HomePinSource } {
  if (authorized) return { accept: true, ...(pin?.fingerprint === presented && pin.source === 'ca-verified' ? {} : { record: 'ca-verified' as const }) }
  if (!pin) return { accept: true, record: 'first-use' }
  return { accept: pin.fingerprint === presented }
}

/** How long connecting (TCP and the TLS handshake together) may take before the attempt is given up. */
export const HOME_CONNECT_TIMEOUT_MS = 20_000

/** Proxmox accepted no connection, or never finished the handshake, within the connect timeout. */
export class HomeConnectTimeoutError extends Error {
  readonly code = 'ETIMEDOUT'
  constructor(readonly host: string, readonly port: number, ms: number) {
    super(`Proxmox did not answer within ${Math.round(ms / 1000)} seconds`)
    this.name = 'HomeConnectTimeoutError'
  }
}

/**
 * An agent for one home host:port that applies the rule above before handing the socket to the request.
 * Connecting has its own limit (`connectTimeoutMs`, 20 s): the request's own timer only starts once the socket is
 * handed over, so without this an address that never answers held a request for the system's TCP timeout (minutes).
 */
export class HomePinAgent extends https.Agent {
  private connectTimeoutMs: number
  constructor(opts: https.AgentOptions & { connectTimeoutMs?: number } = {}) {
    const { connectTimeoutMs, ...rest } = opts
    super({ keepAlive: false, ...rest })
    this.connectTimeoutMs = connectTimeoutMs ?? HOME_CONNECT_TIMEOUT_MS
  }

  createConnection(options: any, oncreate?: (err: Error | null, socket: Duplex) => void): Duplex | undefined {
    const host = String(options.host ?? options.hostname ?? '')
    const port = Number(options.port)
    const socket = tls.connect({
      host, port, servername: options.servername || (net.isIP(host) ? undefined : host),
      // Verified below: normally when it can be, otherwise by the pin.
      rejectUnauthorized: false,
      timeout: options.timeout,
    })
    let done = false
    const timer = setTimeout(() => finish(new HomeConnectTimeoutError(host, port, this.connectTimeoutMs)), this.connectTimeoutMs)
    timer.unref?.()
    const finish = (err: Error | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (err) { socket.destroy(); oncreate?.(err, socket) } else oncreate?.(null, socket)
    }
    socket.once('secureConnect', () => {
      const presented = normaliseFingerprint(socket.getPeerCertificate()?.fingerprint256 ?? '') ?? 'none'
      try {
        const pin = homeTlsPin(host, port)
        const d = homeCertDecision(pin, presented, socket.authorized === true)
        if (!d.accept) return finish(new HomeCertificateChangedError(host, port, pin!.fingerprint, presented))
        if (d.record && presented !== 'none') {
          // A pin file that cannot be written must not take the cluster away: this connection is accepted under
          // the same rule either way, and the next one tries to record it again.
          try {
            recordHomeTlsPin(host, port, presented, d.record)
            if (d.record === 'first-use') appLog.warn({ host, port }, `home-tls: pinned the certificate of ${host}:${port} on first use`)
          } catch (e: any) { appLog.warn({ err: e, host, port }, `home-tls: could not record the certificate pin for ${host}:${port}`) }
        }
        finish(null)
      } catch (e) { finish(e as Error) }
    })
    socket.once('error', e => finish(e))
    return undefined
  }
}

let shared: HomePinAgent | null = null
/** The one agent every home Proxmox connection uses. */
export function homeTlsAgent(): HomePinAgent {
  if (!shared) shared = new HomePinAgent()
  return shared
}
