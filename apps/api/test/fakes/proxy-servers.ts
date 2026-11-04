// Stand-ins for the five proxies' APIs, seeded from responses recorded from real servers
// (test/fixtures/proxy, addresses rewritten to 192.0.2.x). Each keeps the API's own rules where the
// providers depend on them: Caddy inserts on PUT to an index and addresses @id; Traefik loads the
// HyperProx file it is given; HAProxy works in transactions, validates and reloads; NPM issues tokens.

import fs from 'node:fs'
import path from 'node:path'
import type { FetchLike } from '../../src/lib/proxy/http'
import type { FileTransport } from '../../src/lib/proxy/transport'

const FIX = path.join(__dirname, '..', 'fixtures', 'proxy')
export const fixture = (name: string): any => JSON.parse(fs.readFileSync(path.join(FIX, `${name}.json`), 'utf8'))
const clone = <T>(v: T): T => structuredClone(v)

type Handler = (method: string, url: URL, body: any, headers: Record<string, string>) => { status: number; body?: unknown; text?: string; headers?: Record<string, string> }

function server(h: Handler): FetchLike & { calls: Array<{ method: string; path: string }> } {
  const calls: Array<{ method: string; path: string }> = []
  const f = (async (u: string, init: RequestInit = {}) => {
    const url = new URL(u)
    const method = (init.method ?? 'GET').toUpperCase()
    calls.push({ method, path: url.pathname + url.search })
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    let body: any = init.body
    if (typeof body === 'string' && (headers['content-type'] ?? '').includes('json')) body = JSON.parse(body)
    const r = h(method, url, body, headers)
    const text = r.text ?? (r.body === undefined ? '' : JSON.stringify(r.body))
    return new Response(r.status === 204 ? null : text, { status: r.status, headers: r.headers })
  }) as FetchLike & { calls: Array<{ method: string; path: string }> }
  f.calls = calls
  return f
}

const notFound = { status: 404, body: { message: 'not found' } }
const unauth = { status: 401, body: { message: 'unauthorised' } }

// --- NPM -----------------------------------------------------------------------------------------------

export class FakeNpm {
  hosts: any[]
  certs: any[]
  next = 100
  password: string
  constructor(which: 1 | 2 = 1, password = 'npm-test-password') {
    this.hosts = fixture(`npm${which}-proxy-hosts`)
    this.certs = fixture(`npm${which}-certificates`)
    this.password = password
  }
  fetch = server((m, url, body, h) => {
    const p = url.pathname.replace(/^\/api/, '')
    if (m === 'POST' && p === '/tokens') return body?.secret === this.password ? { status: 200, body: { token: 'tok', expires: '2099-01-01' } } : unauth
    if (h.authorization !== 'Bearer tok') return unauth
    if (m === 'GET' && p === '/users/me') return { status: 200, body: { id: 1, roles: ['admin'] } }
    if (m === 'GET' && p === '/nginx/certificates') return { status: 200, body: clone(this.certs) }
    if (m === 'GET' && p === '/nginx/proxy-hosts') return { status: 200, body: clone(this.hosts) }
    if (m === 'POST' && p === '/nginx/proxy-hosts') {
      if (this.hosts.some(x => x.domain_names.some((d: string) => body.domain_names.includes(d)))) return { status: 400, body: { error: { message: 'domain already in use' } } }
      const host = { id: this.next++, created_on: 'now', modified_on: 'now', owner_user_id: 1, access_list_id: 0, locations: [], meta: { nginx_online: true, nginx_err: null }, ...body, enabled: true }
      this.hosts.push(host)
      return { status: 201, body: clone(host) }
    }
    const one = /^\/nginx\/proxy-hosts\/(\d+)(\/(enable|disable))?$/.exec(p)
    if (one) {
      const host = this.hosts.find(x => x.id === Number(one[1]))
      if (!host) return notFound
      if (m === 'GET') return { status: 200, body: clone(host) }
      if (m === 'PUT') { Object.assign(host, body); return { status: 200, body: clone(host) } }
      if (m === 'DELETE') { this.hosts = this.hosts.filter(x => x !== host); return { status: 200, body: true } }
      if (m === 'POST' && one[3]) { host.enabled = one[3] === 'enable'; return { status: 200, body: true } }
    }
    return notFound
  })
}

// --- Traefik -------------------------------------------------------------------------------------------

/** One machine's files, shared by the fake Traefik (which loads them) and the transport (which writes them). */
export class MemoryFiles implements FileTransport {
  files = new Map<string, string>()
  writes = 0
  describe() { return 'memory' }
  async read(f: string) { return this.files.has(f) ? this.files.get(f)! : null }
  async write(f: string, t: string) { this.writes++; this.files.set(f, t) }
}

export class FakeTraefik {
  base = fixture('traefik-routers')
  baseServices = fixture('traefik-services')
  constructor(readonly files: MemoryFiles, readonly file = '/etc/traefik/dynamic/hyperprox.yml', private user = 'hpx', private password = 'traefik-test-password') {}

  /** What Traefik would have loaded from HyperProx's file. */
  private loaded(): { routers: any[]; services: any[] } {
    const yaml = require('js-yaml')
    const text = this.files.files.get(this.file)
    const doc = text ? (yaml.load(text) ?? {}) : {}
    const routers = Object.entries(doc.http?.routers ?? {}).map(([name, r]: [string, any]) => ({
      entryPoints: r.entryPoints, service: r.service, rule: r.rule, status: 'enabled', name: `${name}@file`, provider: 'file',
      ...(r.middlewares ? { middlewares: r.middlewares.map((x: string) => `${x}@file`) } : {}), ...(r.tls ? { tls: r.tls } : {}),
    }))
    const services = Object.entries(doc.http?.services ?? {}).map(([name, s]: [string, any]) => ({
      loadBalancer: s.loadBalancer, status: 'enabled', name: `${name}@file`, provider: 'file', type: 'loadbalancer',
    }))
    return { routers, services }
  }

  fetch = server((m, url, _b, h) => {
    if (h.authorization !== 'Basic ' + Buffer.from(`${this.user}:${this.password}`).toString('base64')) return unauth
    if (m !== 'GET') return { status: 405 }
    const l = this.loaded()
    if (url.pathname === '/api/version') return { status: 200, body: fixture('traefik-version') }
    if (url.pathname === '/api/http/routers') return { status: 200, body: [...clone(this.base), ...l.routers] }
    if (url.pathname === '/api/http/services') return { status: 200, body: [...clone(this.baseServices), ...l.services] }
    return notFound
  })
}

// --- Caddy ---------------------------------------------------------------------------------------------

export class FakeCaddy {
  config: any = fixture('caddy-config')
  persist: boolean | null = null

  private walk(parts: string[], create = false): { parent: any; key: string | number } | null {
    let cur: any = this.config
    for (let i = 0; i < parts.length - 1; i++) {
      const k = Array.isArray(cur) ? Number(parts[i]) : parts[i]
      if (cur[k] === undefined) { if (!create) return null; cur[k] = {} }
      cur = cur[k]
    }
    const last = parts[parts.length - 1]
    return { parent: cur, key: Array.isArray(cur) ? Number(last) : last }
  }

  private findId(id: string, node: any = this.config, parent: any = null, key: any = null): { parent: any; key: any } | null {
    if (node && typeof node === 'object') {
      if (node['@id'] === id) return { parent, key }
      for (const [k, v] of Object.entries(node)) {
        const r = this.findId(id, v, node, Array.isArray(node) ? Number(k) : k)
        if (r) return r
      }
    }
    return null
  }

  fetch = server((m, url, body) => {
    const p = decodeURIComponent(url.pathname)
    if (p.startsWith('/id/')) {
      const at = this.findId(p.slice(4))
      if (!at) return { status: 404, body: { error: 'unknown object ID' } }
      if (m === 'GET') return { status: 200, body: clone(at.parent[at.key]) }
      if (m === 'PATCH') { at.parent[at.key] = clone(body); return { status: 200 } }
      if (m === 'DELETE') { if (Array.isArray(at.parent)) at.parent.splice(at.key, 1); else delete at.parent[at.key]; return { status: 200 } }
    }
    if (!p.startsWith('/config/')) return notFound
    if (p === '/config/admin/config/persist' && m === 'GET') return { status: 200, body: this.persist }
    const parts = p.slice('/config/'.length).split('/').filter(Boolean)
    if (!parts.length) return m === 'GET' ? { status: 200, body: clone(this.config) } : { status: 405 }
    const at = this.walk(parts, m !== 'GET')
    if (!at) return m === 'GET' ? { status: 200, text: 'null' } : notFound
    const cur = at.parent[at.key]
    if (m === 'GET') return { status: 200, text: JSON.stringify(cur === undefined ? null : cur) }
    if (m === 'PUT') {
      if (Array.isArray(at.parent)) { at.parent.splice(at.key as number, 0, clone(body)); return { status: 200 } }
      if (cur !== undefined) return { status: 409, body: { error: 'key already exists' } }
      at.parent[at.key] = clone(body); return { status: 200 }
    }
    if (m === 'PATCH') { if (cur === undefined) return notFound; at.parent[at.key] = clone(body); return { status: 200 } }
    if (m === 'POST') { if (Array.isArray(cur)) cur.push(clone(body)); else at.parent[at.key] = clone(body); return { status: 200 } }
    if (m === 'DELETE') { if (Array.isArray(at.parent)) at.parent.splice(at.key as number, 1); else delete at.parent[at.key]; return { status: 200 } }
    return { status: 405 }
  })
}

// --- HAProxy Data Plane ----------------------------------------------------------------------------------

interface HaState { frontends: Array<{ name: string; rules: any[] }>; backends: Array<{ name: string; mode?: string; servers: any[] }> }

export class FakeHaproxy {
  version = 1
  state: HaState
  tx = new Map<string, { version: number; state: HaState }>()
  reloads = new Map<string, string>()
  reloadCount = 0
  /** Tests: make haproxy -c reject a configuration containing this text. */
  rejectIf: string | null = null
  /** Tests: make the commit drop every frontend (a broken reload). */
  dropFrontendsOnCommit = false
  validations = 0
  constructor(private user = 'hpx', private password = 'haproxy-test-password') {
    const fes = fixture('haproxy-frontends')
    this.state = {
      frontends: fes.map((f: any) => ({ name: f.name, rules: clone(f.backend_switching_rule_list ?? []) })),
      backends: fixture('haproxy-backends').map((b: any) => ({ name: b.name, servers: b.name === 'legacy' ? fixture('haproxy-legacy-servers') : [] })),
    }
  }

  render(s: HaState): string {
    const out = ['global', '  master-worker', '', 'defaults', '  mode http', '']
    for (const f of s.frontends) {
      out.push(`frontend ${f.name}`, '  bind :80')
      for (const r of f.rules) out.push(`  use_backend ${r.name} ${r.cond} ${r.cond_test}`)
      out.push('')
    }
    for (const b of s.backends) {
      out.push(`backend ${b.name}`)
      for (const v of b.servers) out.push(`  server ${v.name} ${v.address}:${v.port}${v.ssl === 'enabled' ? ' ssl verify none' : ''}${v.maintenance === 'enabled' ? ' disabled' : ''}`)
      out.push('')
    }
    return out.join('\n')
  }

  fetch = server((m, url, body, h) => {
    if (h.authorization !== 'Basic ' + Buffer.from(`${this.user}:${this.password}`).toString('base64')) return unauth
    const p = url.pathname.replace(/^\/v3/, '')
    const txId = url.searchParams.get('transaction_id')
    const t = txId ? this.tx.get(txId) : null
    if (txId && !t) return { status: 404, body: { message: 'transaction not found' } }
    const s = t ? t.state : this.state
    const write = (fn: () => any) => { if (!t) return { status: 400, body: { message: 'use a transaction' } }; return fn() }
    if (p === '/info') return { status: 200, body: fixture('haproxy-info') }
    if (p === '/services/haproxy/runtime/info') return { status: 200, body: { info: { uptime: 10 } } }
    if (p === '/services/haproxy/configuration/version') return { status: 200, text: String(this.version) }
    if (p === '/services/haproxy/storage/ssl_certificates') return { status: 200, body: [] }
    if (p === '/services/haproxy/transactions' && m === 'POST') {
      if (Number(url.searchParams.get('version')) !== this.version) return { status: 409, body: { message: 'version mismatch' } }
      const id = `tx-${this.tx.size + 1}-${Date.now()}`
      this.tx.set(id, { version: this.version, state: clone(this.state) })
      return { status: 201, body: { _version: this.version, id, status: 'in_progress' } }
    }
    const txm = /^\/services\/haproxy\/transactions\/([^/]+)$/.exec(p)
    if (txm) {
      const tr = this.tx.get(txm[1])
      if (!tr) return notFound
      if (m === 'DELETE') { this.tx.delete(txm[1]); return { status: 204 } }
      if (m === 'PUT') {
        this.tx.delete(txm[1])
        if (this.rejectIf && this.render(tr.state).includes(this.rejectIf)) return { status: 400, body: { message: 'validation error' } }
        this.state = tr.state
        if (this.dropFrontendsOnCommit) this.state.frontends = []
        this.version++
        const rid = `r-${++this.reloadCount}`
        this.reloads.set(rid, 'succeeded')
        return { status: 202, body: { status: 'success' }, headers: { 'Reload-ID': rid } }
      }
    }
    const rl = /^\/services\/haproxy\/reloads\/(.+)$/.exec(p)
    if (rl) return this.reloads.has(rl[1]) ? { status: 200, body: { id: rl[1], status: this.reloads.get(rl[1]) } } : notFound
    if (p === '/services/haproxy/configuration/raw') {
      if (m === 'GET') return { status: 200, text: this.render(s), headers: { 'content-type': 'text/plain' } }
      if (m === 'POST' && url.searchParams.get('only_validate') === 'true') {
        this.validations++
        if (this.rejectIf && String(body).includes(this.rejectIf)) return { status: 400, body: { message: `validation error: msg="config parsing [/tmp/onlyvalidate1:9] bad server '${this.rejectIf}'."` } }
        return { status: 202, text: '' }
      }
    }
    const C = '/services/haproxy/configuration'
    if (p === `${C}/frontends`) return { status: 200, body: s.frontends.map(f => ({ name: f.name, from: 'unnamed_defaults_1', backend_switching_rule_list: clone(f.rules) })) }
    if (p === `${C}/backends`) {
      if (m === 'GET') return { status: 200, body: s.backends.map(b => ({ name: b.name, from: 'unnamed_defaults_1' })) }
      if (m === 'POST') return write(() => { if (s.backends.some(b => b.name === body.name)) return { status: 409, body: { message: 'exists' } }; s.backends.push({ name: body.name, mode: body.mode, servers: [] }); return { status: 201, body } })
    }
    const be = new RegExp(`^${C}/backends/([^/]+)(/servers(/([^/]+))?)?$`).exec(p)
    if (be) {
      const b = s.backends.find(x => x.name === be[1])
      if (!b) return notFound
      if (!be[2]) { if (m === 'DELETE') return write(() => { s.backends = s.backends.filter(x => x !== b); return { status: 204 } }); return { status: 200, body: { name: b.name } } }
      if (!be[4]) {
        if (m === 'GET') return { status: 200, body: clone(b.servers) }
        if (m === 'POST') return write(() => { b.servers.push(clone(body)); return { status: 201, body } })
      } else {
        const i = b.servers.findIndex(v => v.name === be[4])
        if (i < 0) return notFound
        if (m === 'PUT') return write(() => { b.servers[i] = clone(body); return { status: 200, body } })
        if (m === 'GET') return { status: 200, body: clone(b.servers[i]) }
      }
    }
    const fr = new RegExp(`^${C}/frontends/([^/]+)/backend_switching_rules(/(\\d+))?$`).exec(p)
    if (fr) {
      const f = s.frontends.find(x => x.name === fr[1])
      if (!f) return notFound
      if (!fr[2]) return { status: 200, body: clone(f.rules) }
      const i = Number(fr[3])
      if (m === 'POST') return write(() => { f.rules.splice(i, 0, clone(body)); return { status: 201, body } })
      if (m === 'PUT') return write(() => { if (!f.rules[i]) return notFound; f.rules[i] = clone(body); return { status: 200, body } })
      if (m === 'DELETE') return write(() => { if (!f.rules[i]) return notFound; f.rules.splice(i, 1); return { status: 204 } })
    }
    return notFound
  })
}

// --- Pangolin ------------------------------------------------------------------------------------------

export class FakePangolin {
  resources: any[] = fixture('pangolin-resources').data.resources
  sites: any[] = fixture('pangolin-sites').data.sites
  domains: any[] = fixture('pangolin-domains').data.domains
  org = fixture('pangolin-org').data
  next = 50
  constructor(private key = 'pangolin-test-key', private orgId = 'hpx-test') {}
  private ok(data: unknown) { return { status: 200, body: { data, success: true, error: false, message: 'ok', status: 200 } } }
  fetch = server((m, url, body, h) => {
    if (h.authorization !== `Bearer ${this.key}`) return unauth
    const p = url.pathname.replace(/^\/v1/, '') || '/'
    if (p === '/' && m === 'GET') return { status: 200, body: { message: 'Healthy' } }
    const O = `/org/${this.orgId}`
    if (p === O && m === 'GET') return this.ok(this.org)
    if (p === `${O}/sites`) return this.ok({ sites: this.sites, pagination: {} })
    if (p === `${O}/domains`) return this.ok({ domains: this.domains, pagination: {} })
    if (p === `${O}/resources`) return this.ok({ resources: clone(this.resources), pagination: {} })
    if (p === `${O}/resource` && m === 'PUT') {
      const d = this.domains.find(x => x.domainId === body.domainId)
      if (!d) return { status: 400, body: { message: 'domain not found' } }
      const fullDomain = body.subdomain ? `${body.subdomain}.${d.baseDomain}` : d.baseDomain
      if (this.resources.some(r => r.fullDomain === fullDomain)) return { status: 409, body: { message: 'Resource with that domain already exists' } }
      const r = { resourceId: this.next++, niceId: `random-${this.next}`, name: body.name, ssl: true, fullDomain, mode: 'http', enabled: true, domainId: d.domainId, health: 'unknown', targets: [] as any[] }
      this.resources.push(r)
      return this.ok(clone(r))
    }
    const rs = /^\/resource\/(\d+)(\/target)?$/.exec(p)
    if (rs) {
      const r = this.resources.find(x => x.resourceId === Number(rs[1]))
      if (!r) return notFound
      if (rs[2] && m === 'PUT') { const t = { targetId: this.next++, resourceId: r.resourceId, enabled: true, ...body }; r.targets.push(t); return this.ok(clone(t)) }
      if (m === 'GET') return this.ok(clone(r))
      if (m === 'DELETE') { this.resources = this.resources.filter(x => x !== r); return this.ok(null) }
      if (m === 'POST') {
        if (body.domainId) { const d = this.domains.find(x => x.domainId === body.domainId); r.fullDomain = body.subdomain ? `${body.subdomain}.${d.baseDomain}` : d.baseDomain }
        for (const k of ['niceId', 'enabled', 'name']) if (k in body) r[k] = body[k]
        return this.ok(clone(r))
      }
    }
    const tg = /^\/target\/(\d+)$/.exec(p)
    if (tg && m === 'POST') {
      for (const r of this.resources) for (const t of r.targets ?? []) if (t.targetId === Number(tg[1])) { Object.assign(t, body); return this.ok(clone(t)) }
      return notFound
    }
    return notFound
  })
}
