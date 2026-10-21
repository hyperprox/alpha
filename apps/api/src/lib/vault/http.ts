// =============================================================================
//  HyperProx — minimal HTTP(S) client for the bundled vault
//  node:https rather than global fetch, so the vault's self-signed certificate
//  can be trusted per request (`ca`) without touching process-wide TLS settings.
// =============================================================================

import http from 'node:http'
import https from 'node:https'

export interface VaultResponse {
  status: number
  headers: http.IncomingHttpHeaders
  text: string
}

export function vaultRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; ca?: Buffer; timeoutMs?: number } = {},
): Promise<VaultResponse> {
  const u = new URL(url)
  const mod = u.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = mod.request(u, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body !== undefined ? { 'content-length': Buffer.byteLength(opts.body).toString() } : {}),
        ...opts.headers,
      },
      ...(u.protocol === 'https:' && opts.ca ? { ca: opts.ca } : {}),
      timeout: opts.timeoutMs ?? 15_000,
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('vault request timed out')))
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}
