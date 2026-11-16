// A fake Pi-hole and a fake AdGuard Home that answer from the recorded fixtures (test/fixtures/dns-blocker, captured from
// real installs with their addresses and names replaced), and keep the state an action changes, so a test can do
// something and read it back the way the service does. Nothing here opens a socket.
import fs from 'node:fs'
import path from 'node:path'
import { DnsUnreachableError, type BlockerHttp, type HttpRequest, type HttpResponse } from '../../src/lib/dns-blocker/client'

const FIX = path.join(__dirname, '..', 'fixtures', 'dns-blocker')
export const fixture = (kind: 'pihole' | 'adguard', name: string): any => JSON.parse(fs.readFileSync(path.join(FIX, kind, name), 'utf8'))
export const fixtureText = (kind: 'pihole' | 'adguard', name: string): string => fs.readFileSync(path.join(FIX, kind, name), 'utf8')

const json = (status: number, body: unknown): HttpResponse => ({ status, text: typeof body === 'string' ? body : JSON.stringify(body) })

export const PIHOLE_PASSWORD = 'pihole-test-password'
export const ADGUARD_USER = 'admin'
export const ADGUARD_PASSWORD = 'adguard-test-password'
/** A "now" just after the fixtures were recorded (inside the last hour's bucket), so the 24-hour chart has its busy bucket in range. */
export const NOW = 1794801300_000

export interface FakeLog { requests: Array<{ method: string; path: string; sid?: string; body?: any }>; sessions: number; closed: number }

export class FakePihole implements BlockerHttp {
  /** The password it accepts (the generated one, in a test that installs it first). */
  constructor(public password: string = PIHOLE_PASSWORD) {}
  log: FakeLog = { requests: [], sessions: 0, closed: 0 }
  blocking: 'enabled' | 'disabled' = 'enabled'
  timer: number | null = null
  upstreams: string[] = fixture('pihole', 'upstream-config.json').config.dns.upstreams
  allowed = new Set<string>()
  gravityRuns = 0
  /** Set to make every request fail the way an unreachable server does. */
  down = false
  /** Pi-hole refuses a domain it already has, with this hint. */
  refuseAdd: string | null = null
  private sids = new Set<string>()

  async request(r: HttpRequest): Promise<HttpResponse> {
    if (this.down) throw new DnsUnreachableError('The DNS blocker is unreachable: connection refused.')
    const sid = r.headers?.sid
    const body = r.body ? JSON.parse(r.body) : undefined
    this.log.requests.push({ method: r.method, path: r.path, ...(sid ? { sid } : {}), ...(body ? { body } : {}) })
    if (r.path === '/api/auth' && r.method === 'POST') {
      if (body?.password !== this.password) return json(401, fixture('pihole', 'auth-refused.json'))
      const s = `sid-${++this.log.sessions}`
      this.sids.add(s)
      return json(200, { session: { valid: true, totp: false, sid: s, csrf: 'c', validity: 1800, message: 'password correct' }, took: 0.1 })
    }
    if (r.path === '/api/auth' && r.method === 'DELETE') { this.log.closed++; this.sids.delete(String(sid)); return { status: 204, text: '' } }
    if (!sid || !this.sids.has(sid)) return json(401, { error: { key: 'unauthorized', message: 'Unauthorized', hint: null } })
    const g = (name: string) => fixture('pihole', name)
    const [p, q] = r.path.split('?')
    if (r.method === 'GET') {
      switch (p) {
        case '/api/stats/summary': return json(200, g('summary.json'))
        case '/api/dns/blocking': return json(200, { blocking: this.blocking, timer: this.timer, took: 0 })
        case '/api/info/version': return json(200, g('version.json'))
        case '/api/stats/top_domains': return json(200, g(q?.includes('blocked=true') ? 'top-blocked.json' : 'top-domains.json'))
        case '/api/stats/top_clients': return json(200, g('top-clients.json'))
        case '/api/stats/upstreams': return json(200, g('upstreams.json'))
        case '/api/config/dns/upstreams': return json(200, { config: { dns: { upstreams: this.upstreams } }, took: 0 })
        case '/api/history': return json(200, g('history.json'))
        case '/api/lists': return json(200, g('lists.json'))
      }
      const m = /^\/api\/domains\/allow\/exact\/(.+)$/.exec(p)
      if (m) return json(200, { domains: this.allowed.has(decodeURIComponent(m[1])) ? [{ domain: decodeURIComponent(m[1]), type: 'allow', kind: 'exact', enabled: true }] : [], took: 0 })
      return json(404, { error: { key: 'not_found', message: 'Not found', hint: p } })
    }
    if (p === '/api/dns/blocking' && r.method === 'POST') {
      this.blocking = body.blocking ? 'enabled' : 'disabled'; this.timer = body.blocking ? null : body.timer ?? null
      return json(200, { blocking: this.blocking, timer: this.timer, took: 0 })
    }
    if (p === '/api/action/gravity') { this.gravityRuns++; return { status: 200, text: '  [✓] Done.\n' } }
    if (p === '/api/domains/allow/exact' && r.method === 'POST') {
      if (this.refuseAdd) return json(400, { error: { key: 'database_error', message: 'Could not add to gravity database', hint: this.refuseAdd } })
      this.allowed.add(body.domain); return json(201, { processed: { errors: [], success: [{ item: body.domain }] } })
    }
    if (p === '/api/config' && r.method === 'PATCH') { this.upstreams = body.config.dns.upstreams; return json(200, { config: body.config }) }
    return json(404, { error: { key: 'not_found', message: 'Not found', hint: p } })
  }
}

export class FakeAdguard implements BlockerHttp {
  log: FakeLog = { requests: [], sessions: 0, closed: 0 }
  enabled = true
  until: number | null = null
  upstreams: string[] = fixture('adguard', 'dns-info.json').upstream_dns
  userRules: string[] = []
  refreshes = 0
  down = false
  /** Upstream addresses the blocker's own test says fail. */
  failing = new Set<string>()

  async request(r: HttpRequest): Promise<HttpResponse> {
    if (this.down) throw new DnsUnreachableError('The DNS blocker is unreachable: connection refused.')
    const body = r.body ? JSON.parse(r.body) : undefined
    this.log.requests.push({ method: r.method, path: r.path, ...(body ? { body } : {}) })
    const expect = `Basic ${Buffer.from(`${ADGUARD_USER}:${ADGUARD_PASSWORD}`).toString('base64')}`
    if (r.headers?.Authorization !== expect) return { status: 401, text: '' }
    const g = (name: string) => fixture('adguard', name)
    switch (`${r.method} ${r.path}`) {
      case 'GET /control/status': return json(200, { ...g(this.enabled ? 'status.json' : 'status-paused.json'), protection_enabled: this.enabled, protection_disabled_duration: this.until ?? 0 })
      case 'GET /control/stats': return json(200, g('stats.json'))
      case 'GET /control/filtering/status': return json(200, { ...g('filtering-status.json'), user_rules: this.userRules })
      case 'GET /control/dns_info': return json(200, { ...g('dns-info.json'), upstream_dns: this.upstreams })
      case 'GET /control/clients': return json(200, g('clients.json'))
      case 'POST /control/protection': this.enabled = body.enabled; this.until = body.enabled ? null : body.duration ?? null; return json(200, 'OK')
      case 'POST /control/filtering/refresh': this.refreshes++; return json(200, { updated: 0 })
      case 'POST /control/filtering/set_rules': this.userRules = body.rules; return json(200, '')
      case 'POST /control/dns_config': this.upstreams = body.upstream_dns; return json(200, '')
      case 'POST /control/test_upstream_dns': {
        const out: Record<string, string> = {}
        for (const u of body.upstream_dns as string[]) { const k = /:\d+$/.test(u) ? u : `${u}:53`; out[k] = this.failing.has(u) ? 'couldn\'t communicate with upstream: i/o timeout' : 'OK' }
        return json(200, out)
      }
    }
    return { status: 404, text: '404 page not found' }
  }
}
