// =============================================================================
//  HyperProx — Proxy provider: HAProxy (Data Plane API v3)
//
//  A host is a backend named hpx_… with one server, plus a use_backend rule in
//  one frontend matching the Host header. Rules that point anywhere else are
//  shown read-only.
//
//  A bad reload drops every frontend, so every write is one transaction that is
//  checked twice before HAProxy reloads: the transaction's whole configuration
//  is sent to `only_validate` (haproxy -c), and only then committed. After the
//  commit HyperProx waits for the reload to report success and checks that
//  every frontend that existed before still exists. A failed validation
//  deletes the transaction, so nothing is applied.
//
//  "Disabled" puts the host's server into maintenance: HAProxy answers 503.
// =============================================================================

import { ProxyHttp, ProxyHttpError, type FetchLike, type HttpAuth } from '../http'
import { slugFor } from '../spec'
import { ProxyRefusal, type HostSpec, type ProxyCertificate, type ProxyHealth, type ProxyHostRecord, type ProxyProvider } from '../types'

const PREFIX = 'hpx_'
const CFG = '/v3/services/haproxy/configuration'

export interface HaproxyConfig {
  url:       string
  auth:      HttpAuth
  /** The frontend HyperProx adds its rules to; empty = the first frontend. */
  frontend?: string
  reloadTimeoutMs?: number
}

interface Rule { name: string; cond?: string; cond_test?: string }
interface Server { name: string; address: string; port?: number; ssl?: string; maintenance?: string; verify?: string }
interface Frontend { name: string; backend_switching_rule_list?: Rule[] }

/** The names a use_backend condition matches on the Host header, or [] when it is not that simple. */
export function hostsInCond(cond: string | undefined): string[] {
  if (!cond) return []
  const m = /\{\s*(?:req\.hdr\(host\)(?:,field\(1,:\))?|hdr\(host\)|hdr_dom\(host\)|req\.hdr\(host\),lower)\s+-i\s+([^}]+)\}/i.exec(cond)
  if (!m) return []
  return m[1].trim().split(/\s+/).filter(x => x && !x.startsWith('-')).map(x => x.toLowerCase())
}

export function condFor(domains: string[]): string {
  return `{ req.hdr(host),field(1,:) -i ${domains.join(' ')} }`
}

export class HaproxyProvider implements ProxyProvider {
  readonly kind = 'haproxy' as const
  readonly capabilities = { certificates: 'list' as const, requestCertificate: false, multiDomain: true,
    disabledMeans: 'HAProxy keeps the rule and puts the server into maintenance (503).' }
  private http: ProxyHttp

  constructor(private cfg: HaproxyConfig, fetchImpl?: FetchLike, private wait: (ms: number) => Promise<unknown> = ms => new Promise(r => setTimeout(r, ms))) {
    this.http = new ProxyHttp(cfg.url, cfg.auth, fetchImpl, 'HAProxy Data Plane')
  }

  async health(): Promise<ProxyHealth> {
    const checks: ProxyHealth['checks'] = []
    let version: string | undefined
    try {
      const info = await this.http.get<{ api?: { version?: string } }>('/v3/info')
      version = info?.api?.version
      checks.push({ name: 'api', ok: true, detail: `Data Plane API ${version ?? ''} answers`.replace(/\s+/g, ' ') })
    } catch (e: any) { return { ok: false, checks: [{ name: 'api', ok: false, detail: e.message }] } }
    try {
      const fe = await this.frontend()
      checks.push({ name: 'frontend', ok: true, detail: `HyperProx's rules go in frontend "${fe}"` })
    } catch (e: any) { return { ok: false, version, checks: [...checks, { name: 'frontend', ok: false, detail: e.message }] } }
    try {
      await this.http.get('/v3/services/haproxy/runtime/info')
      checks.push({ name: 'runtime', ok: true, detail: 'HAProxy is running (runtime socket answers)' })
    } catch (e: any) { checks.push({ name: 'runtime', ok: false, warn: true, detail: e.message }) }
    return { ok: true, version, checks }
  }

  private async frontends(): Promise<Frontend[]> {
    return (await this.http.get<Frontend[]>(`${CFG}/frontends?full_section=true`)) ?? []
  }

  private async frontend(): Promise<string> {
    const fes = await this.frontends()
    if (this.cfg.frontend) {
      if (!fes.some(f => f.name === this.cfg.frontend)) throw new ProxyRefusal(`HAProxy has no frontend "${this.cfg.frontend}".`)
      return this.cfg.frontend
    }
    if (!fes.length) throw new ProxyRefusal('HAProxy has no frontend to add hosts to; give the instance a frontend name.')
    return fes[0].name
  }

  private async servers(backend: string, tx?: string): Promise<Server[]> {
    const q = tx ? `?transaction_id=${tx}` : ''
    return (await this.http.get<Server[]>(`${CFG}/backends/${encodeURIComponent(backend)}/servers${q}`)) ?? []
  }

  async listHosts(): Promise<ProxyHostRecord[]> {
    const [fes, mine] = [await this.frontends(), await this.frontend().catch(() => null)]
    const out: ProxyHostRecord[] = []
    for (const fe of fes) {
      for (const [i, rule] of (fe.backend_switching_rule_list ?? []).entries()) {
        const owned = fe.name === mine && rule.name.startsWith(PREFIX)
        let srv: Server | undefined
        try { srv = (await this.servers(rule.name))[0] } catch { /* a backend with no servers */ }
        const domains = hostsInCond(rule.cond_test)
        out.push({
          id: owned ? rule.name : `${fe.name}#${i}`,
          domains, forwardScheme: srv?.ssl === 'enabled' ? 'https' : 'http',
          forwardHost: srv?.address ?? '', forwardPort: Number(srv?.port ?? 0),
          enabled: srv?.maintenance !== 'enabled', owned,
          readOnlyReason: owned ? undefined : `Made outside HyperProx (frontend "${fe.name}" → backend "${rule.name}")`,
          tls: { kind: 'none' }, online: null,
          detail: `use_backend ${rule.name} ${rule.cond ?? ''} ${rule.cond_test ?? ''}`.replace(/\s+/g, ' ').trim(),
        })
      }
    }
    return out
  }

  // --- the transaction ---------------------------------------------------------------------------------

  /** Open a transaction, run `fn`, validate the whole result, commit, wait for the reload, re-check. */
  private async transact(what: string, fn: (tx: string, fe: string) => Promise<void>): Promise<void> {
    const fe = await this.frontend()
    const before = (await this.frontends()).map(f => f.name)
    const version = await this.http.get<number>(`${CFG}/version`)
    const tx = (await this.http.json<{ id: string }>('POST', `/v3/services/haproxy/transactions?version=${version}`)).body.id
    try {
      await fn(tx, fe)
      // 1. Validate: the transaction's full configuration through haproxy -c, before anything reloads.
      const raw = (await this.http.raw('GET', `${CFG}/raw?transaction_id=${tx}`, { headers: { Accept: 'text/plain' } })).body
      const text = raw.trim().startsWith('"') ? JSON.parse(raw) : raw
      try {
        await this.http.raw('POST', `${CFG}/raw?only_validate=true&skip_version=true`, { text: text.endsWith('\n') ? text : text + '\n' })
      } catch (e) {
        const why = e instanceof ProxyHttpError ? validationReason(e.body) : String((e as Error).message)
        throw new ProxyRefusal(`HAProxy rejected the new configuration (${what}); nothing was applied. ${why}`, 422)
      }
    } catch (e) {
      await this.http.raw('DELETE', `/v3/services/haproxy/transactions/${tx}`).catch(() => undefined)
      throw e
    }
    // 2. Commit: Data Plane validates again and reloads.
    const commit = await this.http.raw('PUT', `/v3/services/haproxy/transactions/${tx}`, { okStatuses: [200, 202] })
    const reloadId = commit.headers.get('reload-id')
    if (reloadId) await this.waitReload(reloadId, what)
    // 3. Re-check: every frontend that existed before still exists.
    const after = new Set((await this.frontends()).map(f => f.name))
    const lost = before.filter(n => !after.has(n))
    if (lost.length) throw new Error(`After ${what}, HAProxy no longer has frontend(s) ${lost.join(', ')}.`)
  }

  private async waitReload(id: string, what: string): Promise<void> {
    const deadline = Date.now() + (this.cfg.reloadTimeoutMs ?? 20_000)
    for (;;) {
      const r = await this.http.get<{ status?: string; response?: string }>(`/v3/services/haproxy/reloads/${encodeURIComponent(id)}`)
      if (r?.status === 'succeeded') return
      if (r?.status === 'failed') throw new Error(`HAProxy's reload after ${what} failed: ${(r.response ?? '').slice(0, 300)}`)
      if (Date.now() > deadline) throw new Error(`HAProxy's reload after ${what} did not finish within ${(this.cfg.reloadTimeoutMs ?? 20_000) / 1000}s (reload ${id})`)
      await this.wait(500)
    }
  }

  private server(spec: HostSpec): Server & Record<string, unknown> {
    const s: Server & Record<string, unknown> = {
      name: 's1', address: spec.forwardHost, port: spec.forwardPort,
      maintenance: spec.enabled ? 'disabled' : 'enabled', check: 'disabled',
    }
    if (spec.forwardScheme === 'https') { s.ssl = 'enabled'; s.verify = 'none' }
    return s
  }

  private async ruleIndex(fe: string, backend: string, tx?: string): Promise<number> {
    const q = tx ? `?transaction_id=${tx}` : ''
    const rules = (await this.http.get<Rule[]>(`${CFG}/frontends/${encodeURIComponent(fe)}/backend_switching_rules${q}`)) ?? []
    return rules.findIndex(r => r.name === backend)
  }

  private async ownedOrRefuse(id: string): Promise<{ fe: string; index: number }> {
    if (!id.startsWith(PREFIX)) throw new ProxyRefusal(`HAProxy rule ${id} was not made by HyperProx; it is read-only.`)
    const fe = await this.frontend()
    const index = await this.ruleIndex(fe, id)
    if (index < 0) throw new ProxyRefusal(`HAProxy frontend "${fe}" has no HyperProx rule for ${id}.`, 404)
    return { fe, index }
  }

  async createHost(spec: HostSpec): Promise<string> {
    const backends = ((await this.http.get<{ name: string }[]>(`${CFG}/backends`)) ?? []).map(b => b.name)
    const id = slugFor(spec, new Set(backends), PREFIX, '_')
    await this.transact(`adding ${spec.domains[0]}`, async (tx, fe) => {
      const q = `?transaction_id=${tx}`
      await this.http.json('POST', `${CFG}/backends${q}`, { name: id, mode: 'http', balance: { algorithm: 'roundrobin' } })
      await this.http.json('POST', `${CFG}/backends/${id}/servers${q}`, this.server(spec))
      const rules = (await this.http.get<Rule[]>(`${CFG}/frontends/${encodeURIComponent(fe)}/backend_switching_rules${q}`)) ?? []
      await this.http.json('POST', `${CFG}/frontends/${encodeURIComponent(fe)}/backend_switching_rules/${rules.length}${q}`,
        { name: id, cond: 'if', cond_test: condFor(spec.domains) })
    })
    return id
  }

  async updateHost(id: string, spec: HostSpec): Promise<void> {
    const { fe } = await this.ownedOrRefuse(id)
    await this.transact(`changing ${spec.domains[0]}`, async tx => {
      const q = `?transaction_id=${tx}`
      await this.http.json('PUT', `${CFG}/backends/${id}/servers/s1${q}`, this.server(spec))
      const index = await this.ruleIndex(fe, id, tx)
      await this.http.json('PUT', `${CFG}/frontends/${encodeURIComponent(fe)}/backend_switching_rules/${index}${q}`,
        { name: id, cond: 'if', cond_test: condFor(spec.domains) })
    })
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.ownedOrRefuse(id)
    const cur = (await this.servers(id))[0]
    if (!cur) throw new ProxyRefusal(`HAProxy backend ${id} has no server.`)
    await this.transact(`${enabled ? 'enabling' : 'disabling'} ${id}`, async tx => {
      await this.http.json('PUT', `${CFG}/backends/${id}/servers/${encodeURIComponent(cur.name)}?transaction_id=${tx}`,
        { ...cur, maintenance: enabled ? 'disabled' : 'enabled' })
    })
  }

  async deleteHost(id: string): Promise<void> {
    const { fe } = await this.ownedOrRefuse(id)
    await this.transact(`removing ${id}`, async tx => {
      const q = `?transaction_id=${tx}`
      const index = await this.ruleIndex(fe, id, tx)
      if (index >= 0) await this.http.json('DELETE', `${CFG}/frontends/${encodeURIComponent(fe)}/backend_switching_rules/${index}${q}`)
      await this.http.json('DELETE', `${CFG}/backends/${id}${q}`)
    })
  }

  async listCertificates(): Promise<ProxyCertificate[]> {
    const certs = (await this.http.get<any[]>('/v3/services/haproxy/storage/ssl_certificates')) ?? []
    return certs.map(c => ({
      id: String(c.storage_name ?? c.file ?? c.description),
      names: Array.isArray(c.domains) ? c.domains : String(c.domains ?? c.subject ?? '').split(/[ ,]+/).filter(Boolean),
      expiresAt: c.not_after ?? null, issuer: String(c.issuers ?? c.issuer ?? ''),
    }))
  }
}

/** The useful lines of a validation error, without file paths HyperProx wrote. */
function validationReason(body: string): string {
  let msg = body
  try { msg = JSON.parse(body).message ?? body } catch { /* plain text */ }
  return String(msg).replace(/\/tmp\/\S+/g, 'config').replace(/msg="/g, '').replace(/"\n?/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400)
}
