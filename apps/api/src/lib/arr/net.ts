// =============================================================================
//  HyperProx — how the Arr Stack's setup reaches its apps: plain HTTP to the
//  container's address, and the local address those requests leave from.
// =============================================================================

import net from 'node:net'
import type { Http } from './setup'

/** One HTTP request, never following redirects, with a timeout. Secrets travel in headers or the body only. */
export const realHttp: Http = async r => {
  const headers: Record<string, string> = { ...(r.headers ?? {}) }
  let body: string | undefined
  if (r.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(r.json) }
  else if (r.form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(r.form).toString() }
  const res = await fetch(r.url, { method: r.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(r.timeoutMs ?? 20_000) })
  const h: Record<string, string> = {}
  res.headers.forEach((v, k) => { h[k] = v })
  const cookies = (res.headers as any).getSetCookie?.() as string[] | undefined
  if (cookies?.length) h['set-cookie'] = cookies[0]
  return { status: res.status, headers: h, body: (await res.text().catch(() => '')).slice(0, 2_000_000) }
}

/** The address this process's packets to ip:port leave from. */
export const localAddressTo = (ip: string, port: number): Promise<string | null> => new Promise(resolve => {
  const sock = net.connect({ host: ip, port, timeout: 4000 })
  const done = (v: string | null) => { sock.destroy(); resolve(v) }
  sock.once('connect', () => done(sock.localAddress && net.isIPv4(sock.localAddress.replace(/^::ffff:/, '')) ? sock.localAddress.replace(/^::ffff:/, '') : null))
  sock.once('timeout', () => done(null))
  sock.once('error', () => done(null))
})
