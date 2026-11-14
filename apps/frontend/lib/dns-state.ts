// The DNS page's state from GET /api/dns/domains: domains, "no provider connected yet" (an empty state with a
// way to connect one), or a real failure to reach a provider. Kept free of CSS so it can be tested in Node.

export type DnsLoad =
  | { kind: 'domains'; domains: any[] }
  | { kind: 'not-configured'; message: string }
  | { kind: 'error'; message: string }

export const CONNECT_DNS_HREF = '/settings?tab=dns'

export function dnsLoadState(status: number, body: any): DnsLoad {
  const notConfigured = body?.configured === false || body?.code === 'not_configured'
  if (notConfigured && (!Array.isArray(body?.data) || body.data.length === 0)) {
    return { kind: 'not-configured', message: typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? body.error : 'No DNS provider is connected yet.' }
  }
  if (body?.success && Array.isArray(body.data)) return { kind: 'domains', domains: body.data }
  return { kind: 'error', message: (typeof body?.error === 'string' && body.error) || `The DNS providers could not be read (HTTP ${status})` }
}
