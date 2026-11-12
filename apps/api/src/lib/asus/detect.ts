// =============================================================================
//  HyperProx — ASUS router: finding one on the LAN
//
//  A router is not a cluster guest, so the guest discovery scan
//  (lib/discovery.ts) can never see it. It is, almost always, the default
//  gateway: of HyperProx's own container and of the network around it. So the
//  Add form's "Find my router" reads this machine's routing table for its
//  default gateways and asks each one for its login page.
//
//  Every probe: GET only, no credentials, no cookies, redirects not followed,
//  3 seconds, at most 64 KiB read, and only to an address the router address
//  rules allow (a private address for http). The ASUS login page is matched by
//  what only Asuswrt serves: login.cgi as the form's target and the ASUS name,
//  and the model is read from the page when it shows one.
// =============================================================================

import fs from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { checkAsusAddresses } from './target'

export interface AsusFinding { url: string; model: string | null; source: string }

/** Default gateways from /proc/net/route text (little-endian hex addresses). Pure. */
export function defaultGateways(routeTable: string): string[] {
  const out: string[] = []
  for (const line of routeTable.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/)
    if (f.length < 3 || f[1] !== '00000000' || !/^[0-9A-F]{8}$/i.test(f[2]) || f[2] === '00000000') continue
    const hex = f[2]
    const ip = [6, 4, 2, 0].map(i => parseInt(hex.slice(i, i + 2), 16)).join('.')
    if (!out.includes(ip)) out.push(ip)
  }
  return out
}

/** Is this the Asuswrt (or Merlin) login page? Returns the model when the page names it. Pure. */
export function asusLoginPage(status: number, body: string): { model: string | null } | null {
  if (status !== 200) return null
  if (!/login\.cgi/i.test(body) || !/\basus/i.test(body)) return null
  const m = /class=["']prod_madelName["'][^>]*>\s*([A-Za-z0-9_+-]{2,30})\s*</.exec(body) ?? /<title>\s*ASUS\s+(?:Wireless Router\s+)?([A-Z]{2,4}-[A-Za-z0-9_+-]{2,24})\s*/i.exec(body)
  return { model: m ? m[1] : null }
}

export type Getter = (url: string) => Promise<{ status: number; body: string } | null>

export function probeGet(url: string): Promise<{ status: number; body: string } | null> {
  return new Promise(resolve => {
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(u, { method: 'GET', timeout: 3_000, rejectUnauthorized: false, headers: { Accept: 'text/html' } }, res => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400) { res.resume(); return resolve({ status, body: '' }) }
      const chunks: Buffer[] = []
      let n = 0
      res.on('data', (c: Buffer) => { n += c.length; if (n > 64 * 1024) { req.destroy(); return } chunks.push(c) })
      res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', () => resolve(null))
      res.on('close', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }))
    })
    const t = setTimeout(() => req.destroy(), 3_000)
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
    req.on('close', () => clearTimeout(t))
    req.end()
  })
}

export async function findAsusRouters(o: { gateways?: string[]; get?: Getter } = {}): Promise<AsusFinding[]> {
  const gateways = o.gateways ?? defaultGateways(await fs.readFile('/proc/net/route', 'utf8').catch(() => ''))
  const get = o.get ?? probeGet
  const out: AsusFinding[] = []
  for (const ip of gateways.slice(0, 4)) {
    if (net.isIP(ip) !== 4) continue
    for (const base of [`http://${ip}`, `https://${ip}`]) {
      const u = new URL(base)
      if (!checkAsusAddresses(u.protocol, u.protocol === 'https:' ? 443 : 80, [ip]).ok) continue
      const a = await get(`${base}/Main_Login.asp`).catch(() => null)
      const hit = a ? asusLoginPage(a.status, a.body) : null
      if (hit) { out.push({ url: base, model: hit.model, source: 'default gateway' }); break }
    }
  }
  return out
}
