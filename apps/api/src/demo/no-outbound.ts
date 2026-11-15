// =============================================================================
//  HyperProx demo mode — no outbound connections
//
//  The demo answers from invented data and has no reason to reach any other machine. This guard
//  makes that a property of the process, not a promise of the code: once installed, every TCP or
//  TLS connection (net, http, https, fetch), every UDP send and every DNS lookup is refused unless
//  it goes to this machine's loopback address or a local socket file. A refused attempt fails the
//  way a dead network would (an error on the socket), and is counted and logged once per target.
//
//  The demo API installs it first thing (main.ts). The public demo's frontend process gets it too,
//  through NODE_OPTIONS=--require <compiled no-outbound-register.js> (see docs/demo.md).
// =============================================================================

import net from 'node:net'
import dns from 'node:dns'
import dgram from 'node:dgram'

export class OutboundRefused extends Error {
  code = 'EDEMO_OUTBOUND'
  constructor(target: string) {
    super(`The HyperProx demo makes no outbound connections (refused: ${target}).`)
    this.name = 'OutboundRefused'
  }
}

/** Loopback addresses and the name for them. Everything else is somewhere else. */
export function isLoopback(host: string | undefined | null): boolean {
  if (host === undefined || host === null || host === '') return true   // Node's default is localhost
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

const refused: string[] = []
const logged = new Set<string>()
/** What the guard has refused since it was installed (for tests and the health check). */
export const refusedTargets = (): readonly string[] => refused

function note(target: string): OutboundRefused {
  if (refused.length < 1000) refused.push(target)
  if (!logged.has(target) && logged.size < 100) { logged.add(target); console.error(`[demo] refused an outbound connection to ${target}`) }
  return new OutboundRefused(target)
}

/** Where a Socket#connect call is headed: a socket file, or a host and port. */
function targetOf(args: unknown[]): { path?: string; host?: string; port?: unknown } {
  let a0 = args[0] as any
  // net.connect() hands connect() its already-normalised arguments: [options, callback].
  if (Array.isArray(a0)) a0 = a0[0]
  if (a0 && typeof a0 === 'object') return { path: a0.path, host: a0.host, port: a0.port }
  if (typeof a0 === 'string' && !/^\d+$/.test(a0)) return { path: a0 }
  return { host: typeof args[1] === 'string' ? args[1] : undefined, port: a0 }
}

let installed = false

/** Installs the guard on this process. Idempotent; there is no uninstall. */
export function installNoOutbound(): void {
  if (installed) return
  installed = true

  const connect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const t = targetOf(args)
    // Node treats any truthy path as a local socket file (and ignores host then); http passes path: null.
    if (!t.path && !isLoopback(t.host)) {
      const err = note(`${t.host}:${String(t.port)}`)
      process.nextTick(() => this.destroy(err))
      return this
    }
    return (connect as (...a: unknown[]) => net.Socket).apply(this, args)
  } as typeof net.Socket.prototype.connect

  // Name lookups: only for loopback names, so not even a DNS query leaves the machine.
  const lookup = dns.lookup
  ;(dns as any).lookup = function (hostname: string, ...rest: any[]) {
    const cb = rest[rest.length - 1]
    if (!isLoopback(hostname)) {
      const err = note(`dns:${hostname}`)
      if (typeof cb === 'function') { process.nextTick(() => cb(err)); return {} as any }
      throw err
    }
    return (lookup as any).call(dns, hostname, ...rest)
  }
  const plookup = dns.promises.lookup
  ;(dns.promises as any).lookup = async function (hostname: string, ...rest: any[]) {
    if (!isLoopback(hostname)) throw note(`dns:${hostname}`)
    return (plookup as any).call(dns.promises, hostname, ...rest)
  }
  // Every other resolver call asks a DNS server, which is always somewhere else.
  for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype] as any[]) {
    for (const k of Object.keys(target).concat(Object.getOwnPropertyNames(target))) {
      if (!/^(resolve|reverse)/.test(k) || typeof target[k] !== 'function') continue
      const isPromise = target === dns.promises || target === dns.promises.Resolver.prototype
      target[k] = function (name: string, ...rest: any[]) {
        const err = note(`dns:${String(name)}`)
        if (isPromise) return Promise.reject(err)
        const cb = rest[rest.length - 1]
        if (typeof cb === 'function') { process.nextTick(() => cb(err)); return }
        throw err
      }
    }
  }

  // UDP: sends and connects to anything but loopback.
  const send = dgram.Socket.prototype.send
  dgram.Socket.prototype.send = function (this: dgram.Socket, ...args: any[]) {
    const host = args.find((a, i) => i > 0 && typeof a === 'string')
    const remote = (() => { try { return this.remoteAddress().address } catch { return undefined } })()
    const to = host ?? remote
    if (!isLoopback(to)) {
      const err = note(`udp:${to}`)
      const cb = args[args.length - 1]
      if (typeof cb === 'function') process.nextTick(() => cb(err))
      return
    }
    return (send as any).apply(this, args)
  } as typeof dgram.Socket.prototype.send
  const dconnect = dgram.Socket.prototype.connect
  dgram.Socket.prototype.connect = function (this: dgram.Socket, port: number, ...rest: any[]) {
    const host = typeof rest[0] === 'string' ? rest[0] : undefined
    if (!isLoopback(host)) throw note(`udp:${host}:${port}`)
    return (dconnect as any).call(this, port, ...rest)
  } as typeof dgram.Socket.prototype.connect
}
