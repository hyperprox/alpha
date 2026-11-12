// =============================================================================
//  HyperProx — site metrics routes (/api/site-metrics)
//
//  Reads (gate: any signed-in role, trimmed here):
//    GET /sites               every site's summary: up, visitors today, sparkline, error rate, p95, cert days
//    GET /sites/:id?range=    the Metrics tab; below operator only totals (no paths, referrers, 404s, ids)
//    GET /alerts              site alerts that are firing now, for the Monitoring feed
//  Admin (roles.ts default for writes; the adopt reads are admin in roles.ts too):
//    GET  /adopt/guests                   containers that could be adopted
//    GET  /adopt/candidates?refresh=1     websites HyperProx found (proxy hosts, listening containers), read-only
//    POST /adopt/check                    what HyperProx would read from one (read-only, in the guest)
//    POST /adopt                          record it (master password re-entered)
//    DELETE /adopt/:id                    forget an adopted site and its numbers (re-entered)
//    POST /sites/:id/log-format/preview   the exact nginx lines that would change (read-only; never for LiteSpeed)
//    POST /sites/:id/log-format/apply     make that change (re-entered)
//    PUT  /sites/:id/alerts               alert settings
//    POST /sites/:id/wordpress/refresh    read WordPress again now
//  No route returns a log line, an address or a salt.
// =============================================================================

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { randomBytes } from 'node:crypto'
import { hasRole, type Role } from '../lib/roles'
import { auditCredentialUse } from '../lib/audit'
import { homePve } from '../lib/pve-env'
import { listSites, getSite, recordSite, forgetSite, type SiteRecord } from '../lib/sites'
import { metricsStore, type MetricsStore, type SiteState, type SiteKind } from '../lib/site-metrics/store'
import { summary, detail, isRange } from '../lib/site-metrics/view'
import { containerView, type ContainerView } from '../lib/site-metrics/container'
import { defaultState, isAdopted, realCollectorDeps, refreshWordPress, type CollectorDeps } from '../lib/site-metrics/collector'
import { inspectScript, parseInspect, planLogFormat, planId, applyScript, parseApply, type LogFormatPlan } from '../lib/site-metrics/log-format'
import { isSharedServerLog, SHARED_LOG_NOTE, safeLogPath, safeNginxLogPath, safeWordPressPath, safePhpBin, shq, LOG_RULE, DEFAULT_ACCESS_LOG, DEFAULT_WP_PATH } from '../lib/site-metrics/paths'
import { parseLogLine, isPrivateAddress } from '../lib/site-metrics/log-parser'
import { discover, mapLimit, CandidateCache, LITESPEED_PROXY_NOTE, type DiscoveryDeps, type GuestInfo } from '../lib/site-metrics/discovery'
import { addressesInConfig } from '../lib/guest-names'
import { listHostAddresses } from '../lib/terminal-hosts'
import { liveAddresses } from '../lib/wizard-placement'
import { proxyService } from '../lib/proxy'
import { ownHeaders } from '../lib/own-user-agent'

export interface SiteMetricsRouteDeps {
  store: MetricsStore
  sites(): Promise<SiteRecord[]>
  site(id: string): Promise<SiteRecord | undefined>
  record(s: SiteRecord): Promise<void>
  forget(id: string): Promise<void>
  run: CollectorDeps['run']
  container(node: string, vmid: number): Promise<ContainerView | null>
  /** LXC guests on the home cluster. */
  guests(): Promise<Array<{ vmid: number; name: string; node: string; status: string; type: string }>>
  /** A guest's static IPv4 from its config, when it has one. */
  guestIp(node: string, vmid: number): Promise<string | null>
  audit(action: string, resource: string, details?: Record<string, unknown>): Promise<void>
  now(): Date
  /** What "Add an existing site" lists: proxy hosts, guests and the look inside each container. */
  discovery: Omit<DiscoveryDeps, 'sites' | 'inspect' | 'now'>
}

/** The home cluster's guests with the addresses their configs state (and remembered Terminal addresses). */
async function clusterGuests(): Promise<GuestInfo[]> {
  const pve = homePve()
  const rows = ((await pve.getClusterResources('vm')) as any[])
    .filter(r => (r.type === 'lxc' || r.type === 'qemu') && !r.template).slice(0, 400)
  const remembered = await listHostAddresses().catch(() => ({} as Record<string, string>))
  const out: GuestInfo[] = []
  await mapLimit(rows, 8, async r => {
    const type = r.type as 'lxc' | 'qemu', vmid = Number(r.vmid)
    const config = await pve.getVMConfig(String(r.node), vmid, type).catch(() => null) as Record<string, unknown> | null
    const addresses = addressesInConfig(config)
    const rem = remembered[`${type}-${vmid}`]
    if (rem && /^\d{1,3}(\.\d{1,3}){3}$/.test(rem) && !addresses.includes(rem)) addresses.push(rem)
    out.push({ vmid, name: String(r.name ?? vmid), node: String(r.node), type, status: String(r.status), addresses,
      agent: type === 'qemu' && /^(1|enabled=1)/.test(String(config?.agent ?? '')) })
  })
  return out
}

const realDiscovery = (): SiteMetricsRouteDeps['discovery'] => ({
  hosts: async () => {
    const r = await proxyService().allHosts()
    return { hosts: r.hosts, errors: r.errors.map(e => ({ instanceName: e.instanceName, error: e.error })) }
  },
  guests: clusterGuests,
  liveAddresses: async guests => {
    const pve = homePve()
    const out = new Map<number, string[]>()
    await mapLimit(guests.filter(g => g.type === 'lxc' || g.agent), 8, async g => {
      const path = g.type === 'lxc' ? `/nodes/${encodeURIComponent(g.node)}/lxc/${g.vmid}/interfaces` : `/nodes/${encodeURIComponent(g.node)}/qemu/${g.vmid}/agent/network-get-interfaces`
      const answer = await pve.fetchStrict<unknown>(path, 'GET', undefined, 5000).catch(() => null)
      if (answer != null) out.set(g.vmid, liveAddresses(answer))
    })
    return out
  },
  nodes: async () => ((await homePve().fetchNode<any[]>('/cluster/status').catch(() => [])) ?? [])
    .filter((r: any) => r.type === 'node').map((r: any) => ({ name: String(r.name), ip: r.ip ? String(r.ip) : undefined })),
  head: async url => {
    const r = await fetch(url, { method: 'HEAD', headers: ownHeaders('site-discovery'), redirect: 'manual', signal: AbortSignal.timeout(5000) }).catch(() => null)
    return r ? r.status < 500 : false
  },
})

const realDeps = (): SiteMetricsRouteDeps => ({
  store: metricsStore(),
  sites: listSites,
  site: getSite,
  record: recordSite,
  forget: forgetSite,
  run: realCollectorDeps().run,
  container: (node, vmid) => containerView(node, vmid),
  guests: async () => ((await homePve().getClusterResources('vm').catch(() => [])) ?? [])
    .filter((r: any) => r.type === 'lxc' && !r.template).map((r: any) => ({ vmid: Number(r.vmid), name: String(r.name ?? ''), node: String(r.node), status: String(r.status), type: 'lxc' })),
  guestIp: async (node, vmid) => {
    const c = await homePve().getVMConfig(node, vmid, 'lxc').catch(() => null)
    const m = /(?:^|,)ip=(\d{1,3}(?:\.\d{1,3}){3})\//.exec(String(c?.net0 ?? ''))
    return m ? m[1] : null
  },
  audit: auditCredentialUse,
  now: () => new Date(),
  discovery: realDiscovery(),
})

const roleOf = (req: FastifyRequest): Role => (req.session?.role ?? 'viewer') as Role
function need(req: FastifyRequest, reply: FastifyReply, role: Role): boolean {
  if (hasRole(roleOf(req), role)) return true
  void reply.status(403).send({ ok: false, code: 'forbidden', error: `This needs the ${role} role`, required: role })
  return false
}

const KINDS: SiteKind[] = ['static', 'wordpress', 'other']
const PLAN_TTL_MS = 10 * 60_000

export interface AdoptInput {
  vmid: number; url: string; logPath: string; kind: SiteKind; wpPath: string | null; name: string
  /** The site's own error log (LiteSpeed's per-site error_log); null keeps nginx's default. */
  errorLog: string | null
  /** LiteSpeed's lsphp for WP-CLI (WordPress only); null uses the php on the PATH. */
  phpBin: string | null
}

/** Check what an admin typed for an adoption. Returns the clean values or the reasons it is refused. */
export function checkAdoptInput(raw: any): { input?: AdoptInput; errors: string[] } {
  const errors: string[] = []
  const vmid = Number(raw?.vmid)
  if (!Number.isSafeInteger(vmid) || vmid < 100 || vmid > 999_999_999) errors.push('Pick a container.')
  let url = String(raw?.url ?? '').trim().replace(/\/+$/, '')
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') errors.push('The address must start with https:// or http://.')
    else if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) errors.push('Give just the site\'s address, like https://www.example.com, with no path or login.')
    url = `${u.protocol}//${u.host}`
  } catch { errors.push('The public address is not a URL.') }
  const logPath = safeLogPath(raw?.logPath === undefined || raw?.logPath === '' ? DEFAULT_ACCESS_LOG : raw.logPath)
  if (!logPath) errors.push(`The log path must be ${LOG_RULE}.`)
  let errorLog: string | null = null
  if (raw?.errorLog !== undefined && raw?.errorLog !== null && raw?.errorLog !== '') {
    errorLog = safeLogPath(raw.errorLog)
    if (!errorLog) errors.push(`The error log must be ${LOG_RULE}.`)
  }
  const kind = KINDS.includes(raw?.kind) ? raw.kind as SiteKind : null
  if (!kind) errors.push('Pick the kind of site: static, WordPress or other.')
  let wpPath: string | null = null
  if (kind === 'wordpress') {
    wpPath = safeWordPressPath(raw?.wpPath === undefined || raw?.wpPath === '' ? DEFAULT_WP_PATH : raw.wpPath)
    if (!wpPath) errors.push('The WordPress folder must be under /var/www, /srv or /home/<site>/public_html, with no "..".')
  }
  let phpBin: string | null = null
  if (kind === 'wordpress' && raw?.phpBin !== undefined && raw?.phpBin !== null && raw?.phpBin !== '') {
    phpBin = safePhpBin(raw.phpBin)
    if (!phpBin) errors.push('The PHP for WP-CLI must be one of LiteSpeed\'s, /usr/local/lsws/lsphpNN/bin/php.')
  }
  const name = String(raw?.name ?? '').trim().slice(0, 80)
  if (name && !/^[\p{L}\p{N} ._'()-]+$/u.test(name)) errors.push('The name may hold letters, digits, spaces and . _ \' ( ) - only.')
  if (errors.length) return { errors }
  return { input: { vmid, url, logPath: logPath!, kind: kind!, wpPath, name, errorLog, phpBin }, errors }
}

/** The read-only look inside a container before it is adopted. Sends back facts and at most 50 log lines, as base64. */
export function adoptProbeScript(i: AdoptInput): string {
  const lines = [
    'set -u', 'export LC_ALL=C',
    `LOG=${shq(i.logPath)}`,
    'if [ -f "$LOG" ]; then echo "HPXA1 log yes"; else echo "HPXA1 log no"; fi',
    'if [ -r "$LOG" ]; then echo "HPXA1 readable yes"; echo "HPXA1 tail $(tail -n 50 -- "$LOG" | base64 -w0)"; fi',
    'if command -v nginx >/dev/null 2>&1; then echo "HPXA1 nginx yes"; fi',
    'if [ -x /usr/local/lsws/bin/openlitespeed ] || [ -x /usr/local/lsws/bin/lshttpd ] || [ -x /usr/local/lsws/bin/litespeed ]; then echo "HPXA1 litespeed yes"; fi',
  ]
  if (i.wpPath) {
    lines.push(`WPP=${shq(i.wpPath)}`, 'if [ -f "$WPP/wp-load.php" ]; then echo "HPXA1 wordpress yes"; fi',
      'if command -v wp >/dev/null 2>&1 || [ -x /usr/local/bin/wp ]; then echo "HPXA1 wpcli yes"; fi')
    if (i.phpBin) lines.push(`if [ -x ${shq(i.phpBin)} ]; then echo "HPXA1 php yes"; fi`)
  }
  lines.push('echo "HPXA1 end"')
  return lines.join('\n')
}

/** The probe's answer as facts only: the log lines are parsed for their format and dropped here. */
export function parseAdoptProbe(out: string) {
  const has = (k: string) => new RegExp(`^HPXA1 ${k} yes$`, 'm').test(out)
  const tail = /^HPXA1 tail ([A-Za-z0-9+/=]*)$/m.exec(out)?.[1] ?? ''
  const formats: Record<string, number> = {}
  let malformed = 0, proxied = 0, lines = 0
  for (const l of Buffer.from(tail, 'base64').toString('utf8').split('\n').filter(Boolean)) {
    lines++
    const p = parseLogLine(l)
    if (!p) { malformed++; continue }
    formats[p.format] = (formats[p.format] ?? 0) + 1
    if (isPrivateAddress(p.remote) && p.client === p.remote) proxied++
  }
  return {
    complete: /^HPXA1 end$/m.test(out), logExists: has('log'), logReadable: has('readable'), nginx: has('nginx'), litespeed: has('litespeed'),
    wordpress: has('wordpress'), wpCli: has('wpcli'), php: has('php'), sample: { lines, formats, malformed },
    /** Lines from a private address with no X-Forwarded-For: behind a proxy, every visitor looks like the proxy. */
    behindProxyWithoutForwardedFor: proxied > 0 && proxied === lines - malformed,
  }
}

/** The discovery behind "Add an existing site", over one set of route deps. */
function candidateCache(d: SiteMetricsRouteDeps): CandidateCache {
  return new CandidateCache(() => discover({
    ...d.discovery,
    sites: async () => (await d.sites()).map(s => ({ id: s.id, vmid: s.vmid, domain: s.domain, recipeId: s.recipeId })),
    inspect: async (g, script) => {
      const fake: SiteRecord = { id: 'discover', recipeId: 'adopted-other', name: g.name, vmid: g.vmid, node: g.node, jobId: 'adopted', owner: '', createdAt: 0 }
      return (await d.run(fake, script, 1024 * 1024)).output
    },
    now: () => d.now().getTime(),
  }), () => d.now().getTime())
}

let shared: CandidateCache | null = null
/** The production candidate list, shared by the adopt picker and the catalogue's "already running" detection. */
export function sharedCandidateCache(): CandidateCache {
  return (shared ??= candidateCache(realDeps()))
}

export function buildSiteMetricsRoutes(over: Partial<SiteMetricsRouteDeps> = {}): FastifyPluginAsync {
  const d: SiteMetricsRouteDeps = { ...realDeps(), ...over }
  const plans = new Map<string, { siteId: string; plan: LogFormatPlan; expires: number; by: string }>()
  const stateFor = async (s: SiteRecord): Promise<SiteState> => (await d.store.getState(s.id)) ?? defaultState(s)
  const who = (req: FastifyRequest) => req.session?.email ?? 'unknown'
  const candidateList = Object.keys(over).length ? candidateCache(d) : sharedCandidateCache()

  return async (fastify) => {
    fastify.get('/sites', async (_req, reply) => {
      const now = d.now()
      const sites = await d.sites()
      const out = await Promise.all(sites.map(async s => summary(s, await d.store.getState(s.id), d.store, now)))
      return reply.send({ success: true, data: { sites: out } })
    })

    fastify.get('/alerts', async (_req, reply) => {
      const sites = await d.sites()
      const alerts: Array<{ siteId: string; site: string; kind: string; since: number; detail: string }> = []
      for (const s of sites) {
        const st = await d.store.getState(s.id)
        for (const [kind, a] of Object.entries(st?.alertState ?? {})) alerts.push({ siteId: s.id, site: s.domain ?? s.name, kind, since: a.since, detail: a.detail })
      }
      return reply.send({ success: true, data: { alerts: alerts.sort((a, b) => b.since - a.since) } })
    })

    fastify.get<{ Params: { id: string }; Querystring: { range?: string } }>('/sites/:id', async (req, reply) => {
      const site = await d.site(req.params.id)
      if (!site) return reply.status(404).send({ success: false, error: 'No such site' })
      const range = isRange(req.query.range) ? req.query.range : '7d'
      const full = hasRole(roleOf(req), 'operator')
      const st = await d.store.getState(site.id)
      const out = await detail(site, st, d.store, d.now(), range, full)
      const container = await d.container(site.node, site.vmid).catch(() => null)
      return reply.send({ success: true, data: { ...out, container, canAdmin: hasRole(roleOf(req), 'admin') } })
    })

    fastify.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/sites/:id/alerts', async (req, reply) => {
      if (!need(req, reply, 'admin')) return
      const site = await d.site(req.params.id)
      if (!site) return reply.status(404).send({ success: false, error: 'No such site' })
      const b = req.body ?? {}
      const num = (v: unknown, lo: number, hi: number, dflt: number) => {
        if (v === undefined) return dflt
        const n = Number(v)
        if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`must be between ${lo} and ${hi}`)
        return n
      }
      const st = await stateFor(site)
      try {
        st.alerts = {
          enabled: b.enabled === undefined ? st.alerts.enabled : b.enabled === true,
          errorRatePct: num(b.errorRatePct, 0, 100, st.alerts.errorRatePct),
          downChecks: Math.round(num(b.downChecks, 0, 100, st.alerts.downChecks)),
          certDays: Math.round(num(b.certDays, 0, 90, st.alerts.certDays)),
          spikeFactor: num(b.spikeFactor, 0, 1000, st.alerts.spikeFactor),
        }
      } catch (e: any) { return reply.status(400).send({ success: false, error: `An alert setting ${e.message}.` }) }
      await d.store.putState(st)
      return reply.send({ success: true, data: { alerts: st.alerts } })
    })

    fastify.post<{ Params: { id: string } }>('/sites/:id/wordpress/refresh', async (req, reply) => {
      if (!need(req, reply, 'admin')) return
      const site = await d.site(req.params.id)
      if (!site) return reply.status(404).send({ success: false, error: 'No such site' })
      const st = await stateFor(site)
      if (st.kind !== 'wordpress') return reply.status(400).send({ success: false, error: 'This is not a WordPress site.' })
      if (st.wordpress && d.now().getTime() - st.wordpress.checkedAt < 60_000) return reply.send({ success: true, data: { wordpress: st.wordpress } })
      try { await refreshWordPress(site, st, { run: d.run, now: d.now }) } catch (e: any) { return reply.status(502).send({ success: false, error: e.message }) }
      await d.store.putState(st)
      return reply.send({ success: true, data: { wordpress: st.wordpress } })
    })

    // ── Adopting an existing site ───────────────────────────────────────────

    fastify.get('/adopt/guests', async (req, reply) => {
      if (!need(req, reply, 'admin')) return
      const taken = new Set((await d.sites()).map(s => s.vmid))
      const guests = (await d.guests()).filter(g => !taken.has(g.vmid)).sort((a, b) => a.vmid - b.vmid)
      return reply.send({ success: true, data: { guests, defaults: { logPath: DEFAULT_ACCESS_LOG, wpPath: DEFAULT_WP_PATH } } })
    })

    fastify.get<{ Querystring: { refresh?: string } }>('/adopt/candidates', async (req, reply) => {
      if (!need(req, reply, 'admin')) return
      const r = await candidateList.get(req.query.refresh === '1')
      // A site added since the list was built shows as added without waiting for the next build.
      const sites = await d.sites()
      const candidates = r.candidates.map(c => {
        const s = (c.guest ? sites.find(x => x.vmid === c.guest!.vmid) : undefined) ?? sites.find(x => !!x.domain && c.domains.includes(x.domain.toLowerCase()))
        if (!s || c.siteId === s.id) return c
        const adopted = isAdopted(s)
        return { ...c, alreadyASite: true, alreadyAdopted: adopted, siteId: s.id, adoptable: false, whyNot: adopted ? 'Already added.' : 'Already a site HyperProx made.' }
      })
      return reply.send({ success: true, data: { ...r, candidates, defaults: { logPath: DEFAULT_ACCESS_LOG, wpPath: DEFAULT_WP_PATH } } })
    })

    const probe = async (raw: any) => {
      const c = checkAdoptInput(raw)
      if (!c.input) return { errors: c.errors }
      const i = c.input
      const g = (await d.guests()).find(x => x.vmid === i.vmid)
      if (!g) return { errors: [`Container ${i.vmid} was not found (only containers can be adopted).`] }
      if (g.status !== 'running') return { errors: [`Container ${i.vmid} is ${g.status}; start it first, HyperProx reads it while it runs.`] }
      if ((await d.sites()).some(s => s.vmid === i.vmid)) return { errors: [`Container ${i.vmid} is already a site.`] }
      const fake: SiteRecord = { id: 'probe', recipeId: `adopted-${i.kind}`, name: g.name, vmid: g.vmid, node: g.node, jobId: 'adopted', owner: '', createdAt: 0 }
      let facts: ReturnType<typeof parseAdoptProbe>
      try {
        const r = await d.run(fake, adoptProbeScript(i), 256 * 1024)
        facts = parseAdoptProbe(r.output)
        if (!facts.complete) throw new Error(`the check exited ${r.code}`)
      } catch (e: any) { return { errors: [`Could not look inside container ${i.vmid}: ${e.message}`] } }
      const errors: string[] = [], warnings: string[] = []
      if (!facts.logExists) errors.push(`${i.logPath} does not exist in container ${i.vmid}.`)
      else if (!facts.logReadable) errors.push(`${i.logPath} cannot be read.`)
      if (facts.sample.lines && !Object.keys(facts.sample.formats).length) errors.push(`The last lines of ${i.logPath} are not in a format HyperProx reads (nginx common, combined or extended).`)
      const litespeed = facts.litespeed && !facts.nginx
      if (isSharedServerLog(i.logPath)) warnings.push(SHARED_LOG_NOTE)
      if (litespeed) warnings.push('LiteSpeed serves this site. HyperProx reads its log as it is and does not change LiteSpeed or CyberPanel, so no logging change is offered.')
      else if (!facts.nginx) warnings.push('nginx is not installed here; the log is read as nginx format anyway, and the request-time change is not offered.')
      if (facts.sample.lines && !facts.sample.formats.extended) {
        warnings.push(litespeed ? 'The log has no request time, so p50/p95 stay empty.'
          : 'The log has no request time, so p50/p95 stay empty until the log format includes $request_time (offered after adopting).')
      }
      if (facts.behindProxyWithoutForwardedFor) {
        warnings.push(litespeed ? LITESPEED_PROXY_NOTE
          : 'Every request comes from the proxy in front and the log has no X-Forwarded-For, so visitors cannot be told apart until the log format includes it (the same change adds it).')
      }
      if (i.kind === 'wordpress' && !facts.wordpress) errors.push(`${i.wpPath} has no wp-load.php, so it is not a WordPress folder.`)
      if (i.kind === 'wordpress' && !facts.wpCli) warnings.push('WP-CLI is not installed, so WordPress versions and updates cannot be read.')
      if (i.phpBin && !facts.php) errors.push(`${i.phpBin} does not exist in container ${i.vmid}.`)
      return { errors, warnings, input: i, guest: g, facts: { ...facts, complete: undefined } }
    }

    fastify.post('/adopt/check', async (req, reply) => {
      if (!need(req, reply, 'admin')) return
      const r = await probe(req.body)
      return reply.send({ success: true, data: { ok: !r.errors.length, ...r } })
    })

    fastify.post('/adopt', async (req, reply) => {
      if (!need(req, reply, 'admin')) return
      const r = await probe(req.body)
      if (r.errors.length || !r.input || !r.guest) return reply.status(400).send({ success: false, error: r.errors.join(' '), data: r })
      const i = r.input, g = r.guest
      const u = new URL(i.url)
      const isPublic = u.protocol === 'https:' && !/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) && !/\.(local|lan|internal|home\.arpa)$/.test(u.hostname)
      const site: SiteRecord = {
        id: `a${randomBytes(6).toString('hex')}`, recipeId: `adopted-${i.kind}`, name: i.name || g.name || u.hostname,
        vmid: g.vmid, node: g.node, ip: (await d.guestIp(g.node, g.vmid)) ?? undefined,
        domain: isPublic ? u.hostname : undefined, url: isPublic ? i.url : undefined, localUrl: isPublic ? undefined : i.url,
        jobId: 'adopted', owner: who(req), createdAt: d.now().getTime(),
      }
      await d.record(site)
      const st = defaultState(site)
      st.logPath = i.logPath; st.wpPath = i.wpPath; st.kind = i.kind; st.adopted = true
      if (i.errorLog) st.errorLog = i.errorLog
      st.phpBin = i.phpBin
      await d.store.putState(st)
      await d.audit('site.adopt', `site:${site.id}`, { by: who(req), vmid: site.vmid, node: site.node, kind: i.kind, logPath: i.logPath, errorLog: i.errorLog, phpBin: i.phpBin })
      return reply.send({ success: true, data: { id: site.id } })
    })

    fastify.delete<{ Params: { id: string } }>('/adopt/:id', async (req, reply) => {
      if (!need(req, reply, 'admin')) return
      const site = await d.site(req.params.id)
      if (!site) return reply.status(404).send({ success: false, error: 'No such site' })
      if (!isAdopted(site)) return reply.status(400).send({ success: false, error: 'Only an adopted site is forgotten here; a site HyperProx made is removed with its install.' })
      await d.forget(site.id)
      await d.store.deleteSite(site.id)
      await d.audit('site.forget', `site:${site.id}`, { by: who(req), vmid: site.vmid })
      return reply.send({ success: true })
    })

    // ── The request-time log format ─────────────────────────────────────────

    fastify.post<{ Params: { id: string } }>('/sites/:id/log-format/preview', async (req, reply) => {
      if (!need(req, reply, 'admin')) return
      const site = await d.site(req.params.id)
      if (!site) return reply.status(404).send({ success: false, error: 'No such site' })
      const st = await stateFor(site)
      if (!safeNginxLogPath(st.logPath)) {
        return reply.send({ success: true, data: { planId: null, plan: planLogFormat({ nginx: false, configOk: false, defined: false, includeFileExists: false, files: [] }, st.logPath), expiresAt: null } })
      }
      let plan: LogFormatPlan
      try {
        const r = await d.run(site, inspectScript(st.logPath), 512 * 1024)
        plan = planLogFormat(parseInspect(r.output), st.logPath)
      } catch (e: any) { return reply.status(502).send({ success: false, error: `Could not read nginx's configuration: ${e.message}` }) }
      const now = d.now().getTime()
      for (const [k, v] of plans) if (v.expires < now) plans.delete(k)
      const id = plan.refusal ? null : planId(plan)
      if (id) plans.set(id, { siteId: site.id, plan, expires: now + PLAN_TTL_MS, by: who(req) })
      return reply.send({ success: true, data: { planId: id, plan, expiresAt: id ? now + PLAN_TTL_MS : null } })
    })

    fastify.post<{ Params: { id: string }; Body: { planId?: string } }>('/sites/:id/log-format/apply', async (req, reply) => {
      if (!need(req, reply, 'admin')) return
      const site = await d.site(req.params.id)
      if (!site) return reply.status(404).send({ success: false, error: 'No such site' })
      const p = plans.get(String(req.body?.planId ?? ''))
      if (!p || p.siteId !== site.id || p.expires < d.now().getTime()) return reply.status(409).send({ success: false, error: 'That preview has expired or is not for this site. Preview again.' })
      plans.delete(String(req.body!.planId))
      let script: string
      try { script = applyScript(p.plan) } catch (e: any) { return reply.status(400).send({ success: false, error: e.message }) }
      let res
      try {
        const r = await d.run(site, script, 64 * 1024)
        res = parseApply(r.output, r.code)
      } catch (e: any) { res = { ok: false, backups: [], message: e.message } }
      await d.audit('site.log-format', `site:${site.id}`, { by: who(req), ok: res.ok, files: Object.keys(p.plan.hashes), message: res.message })
      return reply.status(res.ok ? 200 : 502).send({ success: res.ok, data: res, ...(res.ok ? {} : { error: res.message }) })
    })
  }
}

