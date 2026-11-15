// =============================================================================
//  HyperProx — Nextcloud: the read-only OCS channel
//
//  An admin's app password, kept in the vault, reads two things and nothing
//  else, both GETs:
//    /ocs/v2.php/apps/serverinfo/api/v1/info   PHP, database, storage, active users
//    /index.php/settings/setupcheck             the admin page's own setup checks
//                                               (it knows the request, so it does
//                                               not show the command-line-only ones)
//  The request goes to the address checked at that moment (the Home Assistant
//  address rules: no loopback, link-local, metadata or HyperProx's own ports),
//  certificates are verified normally, no redirect is followed (it would carry
//  the password), there is one deadline and the answer is capped.
// =============================================================================

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import dns from 'node:dns/promises'
import { checkHAAddresses, portOf } from '../ha-control/target'

export const MAX_ANSWER_BYTES = 4 * 1024 * 1024

export class OcsError extends Error {
  constructor(message: string, readonly status = 0) { super(message); this.name = 'OcsError' }
}

export type OcsGet = (path: '/ocs/v2.php/apps/serverinfo/api/v1/info?format=json' | '/index.php/settings/setupcheck') => Promise<unknown>

async function checkedAddress(u: URL): Promise<string> {
  const host = u.hostname.replace(/^\[|\]$/g, '')
  let addresses: string[]
  if (net.isIP(host)) addresses = [host]
  else {
    try { addresses = (await dns.lookup(host, { all: true, verbatim: true })).map(a => a.address) }
    catch { throw new OcsError('The Nextcloud address does not resolve.') }
  }
  const v = checkHAAddresses(u.protocol, portOf(u), addresses)
  if (!v.ok) throw new OcsError(v.reason.replace(/Home Assistant's/g, "Nextcloud's").replace(/Home Assistant/g, 'Nextcloud'))
  return addresses[0]
}

function words(e: any): string {
  const code = e?.code ?? e?.cause?.code
  if (e instanceof OcsError) return e.message
  return code === 'ECONNREFUSED' ? 'Nextcloud refused the connection.'
    : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'The Nextcloud address does not resolve.'
    : /timed out/i.test(String(e?.message)) ? 'Nextcloud did not answer in time.'
    : /certificate|self.signed|CERT_|UNABLE_TO_VERIFY/i.test(String(e?.message ?? code)) ? 'Nextcloud\'s certificate is not trusted (HyperProx verifies it; use the public https address).'
    : 'Nextcloud could not be reached.'
}

/** One GET with the app password, as JSON. */
export function ocsClient(o: { url: string; user: string; appPassword: string; timeoutMs?: number }): OcsGet {
  return async (path) => {
    const base = new URL(o.url.replace(/\/+$/, '') + '/')
    const u = new URL(path.replace(/^\//, ''), base)
    let address: string
    try { address = await checkedAddress(u) } catch (e) { throw new OcsError(words(e)) }
    const mod = u.protocol === 'https:' ? https : http
    const timeoutMs = o.timeoutMs ?? 15_000
    const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = mod.request({
        host: address, port: portOf(u), path: u.pathname + u.search, method: 'GET', timeout: timeoutMs,
        ...(u.protocol === 'https:' && !net.isIP(u.hostname.replace(/^\[|\]$/g, '')) ? { servername: u.hostname } : {}),
        headers: {
          Host: u.host, Accept: 'application/json', 'OCS-APIRequest': 'true',
          Authorization: 'Basic ' + Buffer.from(`${o.user}:${o.appPassword}`).toString('base64'),
        },
      }, r => {
        const chunks: Buffer[] = []
        let size = 0
        r.on('data', (c: Buffer) => { size += c.length; if (size > MAX_ANSWER_BYTES) { req.destroy(new Error('answer too large')); return } chunks.push(c) })
        r.on('end', () => resolve({ status: r.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
        r.on('error', reject)
      })
      const deadline = setTimeout(() => req.destroy(new Error('timed out')), timeoutMs)
      req.on('timeout', () => req.destroy(new Error('timed out')))
      req.on('error', e => { clearTimeout(deadline); reject(e) })
      req.on('close', () => clearTimeout(deadline))
      req.end()
    }).catch(e => { throw new OcsError(words(e)) })
    if (res.status >= 300 && res.status < 400) throw new OcsError('Nextcloud answered with a redirect; HyperProx does not follow one with a password. Use the address Nextcloud redirects to.', res.status)
    if (res.status === 401 || res.status === 403) throw new OcsError('Nextcloud refused the app password (it needs an admin\'s).', res.status)
    if (res.status >= 400) throw new OcsError(`Nextcloud answered HTTP ${res.status}.`, res.status)
    try { return JSON.parse(res.text) } catch { throw new OcsError('Nextcloud did not answer with JSON.') }
  }
}
