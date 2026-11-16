// =============================================================================
//  HyperProx — DNS blockers: the service
//
//  Reads: one reading per instance, kept 20 seconds so several open pages and the card cost one login; limited per
//  session. A blocker that refuses the login is not asked again until its login is saved again (a poller retrying a
//  wrong password is how accounts get locked).
//
//  Actions, in two tiers, each with exactly one way in:
//    normal    pause blocking for 5, 30 or 60 minutes, turn it back on, update the block lists: operator or above (the
//              gate), on POST .../actions.
//    secure    restart the service, allow a domain, switch the upstream DNS servers, and "use for HyperProx-installed
//              guests": on POST .../secure-actions only. Admin, a person (never an API token), the master password
//              re-entered (the gate). Allowing a domain also needs the phrase "Allow <domain>" typed (checked here). Rate-limited.
//  Every attempt gets audit rows (who, which blocker, what; never an address or a login): a "started" row written BEFORE
//  anything is done (if it cannot be written, nothing is done: fail closed), then the outcome, best effort.
//  Each action reads the blocker again afterwards: "done" means the blocker now says so, not that it accepted the call.
//
//  Nothing here deletes data. Nothing here changes another machine's DNS: "use for guests" changes only the DNS list
//  HyperProx gives guests it creates from now on (the naming settings), and says so.
// =============================================================================

import { hasRole, type Role } from '../roles'
import { auditBy } from '../http/request-actor'
import type { AdapterContext, Outcome } from '../auto-connect/core'
import { exclusionOf } from '../auto-connect/core'
import { matchVault, pickVault, type VaultChoice } from '../auto-connect/vault-match'
import { machineId } from '../guest-id'
import { AdguardClient, DirectHttp, DnsLoginError, DnsUnreachableError, PiholeClient, type BlockerHttp, type DnsProbe } from './client'
import { cleanGuest, cleanName, cleanPassword, cleanUrl, cleanUser, type DnsInstanceStore, type Login } from './instances'
import { bare, judgeUpstreams, parseAdguard, parsePihole, problemsOf, type Probe } from './parse'
import { checkBlockerAddresses, dnsAddressOf, type TargetResolver } from './target'
import { isPrivateLanIp } from '../qnap/target'
import { DnsRefusal, KIND_NAME, type Actor, type ActionName, type DnsKind, type DnsMeta, type DnsReading, type GuestRef } from './types'
import net from 'node:net'

export interface GuestRow {
  kind: 'lxc' | 'qemu'; vmid: number; name: string; node: string; running: boolean
  /** HyperProx must leave it alone (lib/guest-guard.ts); `excludedBy` says why, in words. */
  ignored: boolean; excludedBy?: string | null
}

export interface Sighting { guest: GuestRef; url: string | null; via: string; ip?: string | null; admin?: string | null }

export interface NamingPort {
  read(): Promise<{ dns: string[] } & Record<string, unknown> | null>
  save(settings: Record<string, unknown>, who: string): Promise<{ errors: string[] }>
}

export interface ServiceDeps {
  kind: DnsKind
  store: DnsInstanceStore
  audit: (action: string, resource: string, details: Record<string, unknown>) => Promise<void>
  /** The HTTP the blocker is reached with. Production: DirectHttp, address checked on every request. Tests replace it. */
  http?: (login: Login) => BlockerHttp
  probe: DnsProbe
  /** Resolves an address for the test lookup, checked by the same rules. */
  resolve?: TargetResolver
  guests?: () => Promise<GuestRow[]>
  /** Runs a script in a guest through the leave-alone guard (never a way round it). */
  exec?: (g: GuestRef, script: string, o?: { timeoutMs?: number }) => Promise<{ code: number; output: string; timedOut: boolean }>
  tags?: () => Promise<Map<string, string[]>>
  sightings?: () => Promise<Sighting[]>
  /** The generated admin login a Catalogue install saved in the vault (null when there is none). */
  catalogueLogin?: (vmid: number) => Promise<{ username: string | null; password: string } | null>
  naming?: NamingPort
  /** The tied guest's own IPv4 address (its configuration), preferred over what the blocker's web address resolves to. */
  guestAddress?: (g: GuestRef) => Promise<string | null>
  dismissed?: (key: string, label: string, by: string) => Promise<void>
  now?: () => number
  limits?: Partial<Limits>
  /** How long a restart waits for the blocker to answer again. */
  restartWaitMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface Limits { readsPerMinute: number; normalPerMinute: number; securityPerMinute: number }

const CACHE_MS = 20_000
const PROBE_CACHE_MS = 60_000

export const PAUSE_MINUTES = [5, 30, 60] as const
export const PRESETS: Record<string, { label: string; servers: string[] }> = {
  cloudflare: { label: 'Cloudflare', servers: ['1.1.1.1', '1.0.0.1'] },
  quad9: { label: 'Quad9', servers: ['9.9.9.9', '149.112.112.112'] },
  google: { label: 'Google', servers: ['8.8.8.8', '8.8.4.4'] },
}

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z][a-z0-9-]{1,62}$/
export function cleanDomain(v: unknown): string {
  const s = typeof v === 'string' ? v.trim().toLowerCase().replace(/\.$/, '') : ''
  if (!DOMAIN_RE.test(s)) throw new DnsRefusal('bad_input', 'Give one domain name, such as ads.example.com: letters, digits, dots and dashes, with no wildcard, port or path.')
  return s
}

/** What a person types to confirm allowing a domain. */
export const allowPhrase = (domain: string) => `Allow ${domain}`

export interface ActionRequest { action?: unknown; minutes?: unknown; domain?: unknown; to?: unknown; confirm?: unknown }

const sleepMs = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** The command that restarts the blocker inside its guest: a Docker container of that name, else the systemd unit. Nothing is a parameter. */
export function restartScript(kind: DnsKind): string {
  const container = kind === 'pihole' ? 'pihole' : 'adguardhome'
  const unit = kind === 'pihole' ? 'pihole-FTL' : 'AdGuardHome'
  return [
    'set -e',
    `if command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' | grep -qix '${container}'; then`,
    `  docker restart '${container}' >/dev/null && echo "@@restarted docker"`,
    `elif systemctl cat '${unit}' >/dev/null 2>&1; then`,
    `  systemctl restart '${unit}' && echo "@@restarted service"`,
    'else echo "@@none"; exit 3; fi',
  ].join('\n')
}

export class DnsBlockerService {
  private cache = new Map<string, { at: number; reading: DnsReading }>()
  private probeCache = new Map<string, { at: number; value: Map<string, Probe | null> }>()
  private inflight = new Map<string, Promise<DnsReading>>()
  private blocked = new Map<string, { at: number; message: string }>()
  private hits = new Map<string, number[]>()
  private autoMiss = new Map<string, { at: number; outcome: Outcome }>()
  private d: ServiceDeps & { now: () => number; limits: Limits; sleep: (ms: number) => Promise<void> }

  constructor(deps: ServiceDeps) {
    this.d = { now: () => Date.now(), sleep: sleepMs, ...deps, limits: { readsPerMinute: 30, normalPerMinute: 10, securityPerMinute: 4, ...(deps.limits ?? {}) } }
  }

  get kind(): DnsKind { return this.d.kind }
  get name(): string { return KIND_NAME[this.d.kind] }
  get instances(): DnsInstanceStore { return this.d.store }

  /** Forget a blocker's refused login and its cached reading: called when its login is saved again. */
  forget(id: string): void { this.blocked.delete(id); this.cache.delete(id); this.probeCache.delete(id) }
  blockedReason(id: string): string | null { return this.blocked.get(id)?.message ?? null }

  limit(actor: Actor, bucket: keyof Limits, message = 'Too many requests; wait a moment.'): void {
    const key = `${actor.sid}:${bucket}`
    const now = this.d.now()
    if (this.hits.size > 1000) for (const [k, v] of this.hits) if (!v.some(t => now - t < 60_000)) this.hits.delete(k)
    const recent = (this.hits.get(key) ?? []).filter(t => now - t < 60_000)
    if (recent.length >= this.d.limits[bucket]) { this.hits.set(key, recent); throw new DnsRefusal('rate_limited', message, 429) }
    recent.push(now); this.hits.set(key, recent)
  }

  private httpFor(login: Login): BlockerHttp {
    return this.d.http ? this.d.http(login) : new DirectHttp({ url: login.url, insecureTLS: login.insecureTLS, ...(this.d.resolve ? { resolve: this.d.resolve } : {}) })
  }

  private async connection(id: string): Promise<{ meta: DnsMeta; login: Login }> {
    const meta = await this.d.store.get(id)
    if (!meta) throw new DnsRefusal('no_instance', 'No such blocker.', 404)
    const login = await this.d.store.login(id)
    if (!login) throw new DnsRefusal('not_configured', 'This blocker has no address or password yet.', 409)
    if (this.d.kind === 'adguard' && !login.username) throw new DnsRefusal('not_configured', 'AdGuard Home needs the user name too.', 409)
    return { meta, login }
  }

  private async answering(login: Login): Promise<DnsReading['answering']> {
    const ip = await dnsAddressOf(login.url, this.d.resolve)
    if (!ip) return { ok: null, ms: null, detail: 'its address could not be worked out for a test lookup' }
    const p = await this.d.probe(ip, 53)
    return p.ok ? { ok: true, ms: p.ms, detail: `answered a test lookup in ${p.ms} ms` } : { ok: false, ms: null, detail: 'did not answer a test lookup in 4 seconds' }
  }

  /** One test lookup per upstream, from HyperProx (Pi-hole) or from the blocker itself (AdGuard); kept 60 seconds. */
  private async upstreamProbes(id: string, kind: DnsKind, addrs: string[], adguard: AdguardClient | null): Promise<Map<string, Probe | null>> {
    const hit = this.probeCache.get(id)
    if (hit && this.d.now() - hit.at < PROBE_CACHE_MS && addrs.every(a => hit.value.has(a))) return hit.value
    const out = new Map<string, Probe | null>()
    if (kind === 'adguard' && adguard) {
      try {
        const tested = await adguard.testUpstreams(addrs)
        for (const a of addrs) out.set(a, tested.get(a) ?? tested.get(a.includes(':') ? a : `${a}:53`) ?? null)
      } catch (e) { if (e instanceof DnsLoginError) throw e }
    } else {
      await Promise.all(addrs.map(async a => {
        const m = /^(\d{1,3}(?:\.\d{1,3}){3}|[0-9A-Fa-f:]+?)(?:#(\d{1,5}))?$/.exec(a)
        if (!m || !net.isIP(m[1])) { out.set(a, null); return }
        const port = m[2] ? Number(m[2]) : 53
        // Same address rules as the blocker's own: never loopback, link-local, a metadata service or HyperProx's own services.
        if (!checkBlockerAddresses('https:', port, [m[1]]).ok) { out.set(a, null); return }
        out.set(a, await this.d.probe(m[1], port))
      }))
    }
    this.probeCache.set(id, { at: this.d.now(), value: out })
    return out
  }

  /** The whole reading. Cached 20 seconds; the answer is never trimmed here (the route trims it for a viewer). */
  async reading(id: string, o: { actor?: Actor; fresh?: boolean } = {}): Promise<DnsReading> {
    if (o.actor) this.limit(o.actor, 'readsPerMinute', 'Too many reads; wait a moment.')
    const held = this.blocked.get(id)
    if (held) throw new DnsLoginError(held.message)
    const hit = this.cache.get(id)
    if (hit && !o.fresh && this.d.now() - hit.at < CACHE_MS) return hit.reading
    // A fresh read never joins one already running: that one may have started before the change being read back.
    const joined = o.fresh ? undefined : this.inflight.get(id)
    if (joined) return joined
    const run = this.read(id).finally(() => { if (this.inflight.get(id) === run) this.inflight.delete(id) })
    this.inflight.set(id, run)
    return run
  }

  private async read(id: string): Promise<DnsReading> {
    const { meta, login } = await this.connection(id)
    const http = this.httpFor(login)
    const now = this.d.now()
    try {
      const reading = this.d.kind === 'pihole' ? await this.readPihole(meta, login, http, now) : await this.readAdguard(meta, login, http, now)
      this.cache.set(id, { at: now, reading })
      return reading
    } catch (e) {
      if (e instanceof DnsLoginError) this.blocked.set(id, { at: now, message: e.message })
      throw e
    }
  }

  private async readPihole(meta: DnsMeta, login: Login, http: BlockerHttp, now: number): Promise<DnsReading> {
    const hide = meta.hideClients
    const parts = await new PiholeClient(http, login.password).session(async s => {
      const names = ['summary', 'blocking', 'version', 'topBlocked', 'topDomains', 'upstreams', 'upstreamConfig', 'history', 'lists', ...(hide ? [] : ['topClients'])] as const
      const paths: Record<string, string> = {
        summary: '/api/stats/summary', blocking: '/api/dns/blocking', version: '/api/info/version',
        topBlocked: '/api/stats/top_domains?blocked=true&count=10', topDomains: '/api/stats/top_domains?count=10',
        topClients: '/api/stats/top_clients?count=10', upstreams: '/api/stats/upstreams', upstreamConfig: '/api/config/dns/upstreams', history: '/api/history', lists: '/api/lists',
      }
      const got = await Promise.all(names.map(async n => [n, await s.get(paths[n])] as const))
      return Object.fromEntries(got) as Record<string, { ok: true; json: any } | { ok: false; why: string }>
    })
    if (!parts.summary.ok) throw new DnsUnreachableError('Pi-hole answered, but not with its statistics. It may still be starting.')
    const failed: string[] = []
    const val = (n: string) => { const p = parts[n]; if (!p) return null; if (p.ok) return p.json; failed.push(`${n} (${p.why})`); return null }
    const base = parsePihole({
      summary: val('summary'), blocking: val('blocking'), version: val('version'), topBlocked: val('topBlocked'), topDomains: val('topDomains'),
      topClients: hide ? null : val('topClients'), upstreams: val('upstreams'), upstreamConfig: val('upstreamConfig'), history: val('history'), lists: val('lists'), failed,
    }, now, hide)
    return this.finish(meta, login, base, null)
  }

  private async readAdguard(meta: DnsMeta, login: Login, http: BlockerHttp, now: number): Promise<DnsReading> {
    const c = new AdguardClient(http, login.username ?? '', login.password)
    const [status, stats, filtering, dnsInfo, clients] = await Promise.all([
      c.get('/control/status'), c.get('/control/stats'), c.get('/control/filtering/status'), c.get('/control/dns_info'),
      meta.hideClients ? Promise.resolve({ ok: true as const, json: null }) : c.get('/control/clients'),
    ])
    if (!status.ok || !stats.ok) throw new DnsUnreachableError('AdGuard Home answered, but not with its statistics. It may still be starting.')
    const failed: string[] = []
    const val = (n: string, p: { ok: true; json: any } | { ok: false; why: string }) => { if (p.ok) return p.json; failed.push(`${n} (${p.why})`); return null }
    const base = parseAdguard({
      status: val('status', status), stats: val('stats', stats), filtering: val('filtering', filtering), dnsInfo: val('upstreams', dnsInfo),
      clients: meta.hideClients ? null : val('clients', clients), failed,
    }, now, meta.hideClients)
    return this.finish(meta, login, base, c)
  }

  private async finish(meta: DnsMeta, login: Login, base: ReturnType<typeof parsePihole>, adguard: AdguardClient | null): Promise<DnsReading> {
    const addrs = base.upstreams.map(u => u.address)
    const [answering, probes] = await Promise.all([
      this.answering(login),
      addrs.length ? this.upstreamProbes(meta.id, this.d.kind, addrs, adguard).catch(e => { if (e instanceof DnsLoginError) throw e; return new Map<string, Probe | null>() }) : Promise.resolve(new Map<string, Probe | null>()),
    ])
    const upstreams = judgeUpstreams(base.upstreams, probes)
    const partial = { ...base, upstreams, answering }
    return { ...partial, problems: problemsOf(partial, KIND_NAME[this.d.kind]) }
  }

  /** The guests a blocker could be tied to (the restart needs one): running, and not left alone. */
  async guestChoices(): Promise<Array<{ kind: 'lxc' | 'qemu'; vmid: number; name: string }>> {
    const rows = await (this.d.guests?.() ?? Promise.resolve([] as GuestRow[]))
    return rows.filter(r => !r.ignored).map(r => ({ kind: r.kind, vmid: r.vmid, name: r.name })).sort((a, b) => a.vmid - b.vmid)
  }

  /** Remember that a person removed one that auto-connect found, so it is not added back by itself. */
  async dismiss(key: string, label: string, by: string): Promise<void> { await this.d.dismissed?.(key, label, by) }

  // ── adding one ────────────────────────────────────────────────────────────

  /** Check an address and login by signing in (read-only), then keep it. The password is checked, never echoed. */
  async add(body: Record<string, unknown>, actor: Actor): Promise<DnsMeta> {
    const name = cleanName(body.name ?? KIND_NAME[this.d.kind])
    const url = cleanUrl(body.url)
    const username = this.d.kind === 'adguard' ? cleanUser(body.username) : null
    const password = cleanPassword(body.password)
    const guest = cleanGuest(body.guest)
    const login: Login = { url, username, password, insecureTLS: body.insecureTLS === true }
    await this.verify(login)
    await this.d.audit(`${this.d.kind}.instance.create`, `${this.d.kind}:new`, { ...auditBy({ email: actor.email, token: actor.token }), name, result: 'started' })
    return this.d.store.create({ name, guest, url, username, password, insecureTLS: login.insecureTLS })
  }

  /** Signs in once and reads the statistics, so a wrong address or password is refused before it is saved. */
  async verify(login: Login): Promise<void> {
    const http = this.httpFor(login)
    if (this.d.kind === 'pihole') {
      const ok = await new PiholeClient(http, login.password).session(async s => (await s.get('/api/stats/summary')).ok)
      if (!ok) throw new DnsRefusal('not_a_blocker', 'That address answered, but not like Pi-hole.', 400)
    } else {
      const r = await new AdguardClient(http, login.username ?? '', login.password).get('/control/status')
      if (!r.ok) throw new DnsRefusal('not_a_blocker', 'That address answered, but not like AdGuard Home.', 400)
    }
  }

  // ── actions ───────────────────────────────────────────────────────────────

  private async audited<T>(actor: Actor, meta: DnsMeta, action: string, details: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    const res = `${this.d.kind}:${meta.id}`
    const by = auditBy({ email: actor.email, token: actor.token })
    const tried = `${this.d.kind}.action`
    // Fail closed: no row, no action.
    await this.d.audit(tried, res, { ...by, action, name: meta.name, ...details, result: 'started' })
    try {
      const out = await fn()
      await this.d.audit(tried, res, { ...by, action, name: meta.name, ...details, result: 'ok' }).catch(() => {})
      return out
    } catch (e: any) {
      await this.d.audit(tried, res, { ...by, action, name: meta.name, ...details, result: `refused:${String(e?.code ?? e?.name ?? 'failed').slice(0, 40)}` }).catch(() => {})
      throw e
    }
  }

  /** The audit row for an attempt the service refuses before it runs (role, token, phrase). */
  async auditRefusal(id: string, actor: Pick<Actor, 'email' | 'token'>, body: Record<string, unknown>, why: string): Promise<void> {
    const a = typeof body.action === 'string' ? body.action.replace(/[^a-z_]/g, '').slice(0, 30) : 'unknown'
    await this.d.audit(`${this.d.kind}.action`, `${this.d.kind}:${String(id).replace(/[^a-z0-9]/gi, '').slice(0, 20)}`, { ...auditBy({ email: actor.email, token: actor.token }), action: a, result: `refused:${why}` }).catch(() => {})
  }

  async act(id: string, body: ActionRequest, actor: Actor, secure: boolean): Promise<{ message: string }> {
    const action = typeof body.action === 'string' ? body.action : ''
    const NORMAL: ActionName[] = ['pause', 'resume', 'update_lists']
    const SECURE: ActionName[] = ['restart_service', 'allow_domain', 'switch_upstream', 'use_for_guests', 'stop_using_for_guests']
    const known = (secure ? SECURE : NORMAL) as string[]
    if (!known.includes(action)) throw new DnsRefusal('unknown_action', 'That is not an action this page can take.', 400)
    const meta = await this.d.store.get(id)
    if (!meta) throw new DnsRefusal('no_instance', 'No such blocker.', 404)
    if (secure) {
      if (actor.token) { await this.auditRefusal(id, actor, body as Record<string, unknown>, 'token'); throw new DnsRefusal('person_only', 'This needs a person signed in; an API token cannot do it.', 403) }
      if (!hasRole(actor.role as Role, 'admin')) { await this.auditRefusal(id, actor, body as Record<string, unknown>, 'role'); throw new DnsRefusal('forbidden', 'Only an admin can do this.', 403) }
      this.limit(actor, 'securityPerMinute', 'Too many of these in a minute; wait and try again.')
    } else {
      if (!hasRole(actor.role as Role, 'operator')) { await this.auditRefusal(id, actor, body as Record<string, unknown>, 'role'); throw new DnsRefusal('forbidden', 'Only an operator or admin can do this.', 403) }
      this.limit(actor, 'normalPerMinute', 'Too many actions in a minute; wait and try again.')
    }
    switch (action as ActionName) {
      case 'pause': return this.pause(meta, body, actor)
      case 'resume': return this.resume(meta, actor)
      case 'update_lists': return this.updateLists(meta, actor)
      case 'restart_service': return this.restart(meta, actor)
      case 'allow_domain': return this.allow(meta, body, actor)
      case 'switch_upstream': return this.switchUpstream(meta, body, actor)
      case 'use_for_guests': return this.useForGuests(meta, actor)
      default: return this.stopUsingForGuests(meta, actor)
    }
  }

  private async ready(meta: DnsMeta): Promise<{ login: Login; http: BlockerHttp }> {
    const { login } = await this.connection(meta.id)
    return { login, http: this.httpFor(login) }
  }

  private async protectionNow(meta: DnsMeta): Promise<DnsReading['protection']> {
    this.cache.delete(meta.id)
    return (await this.reading(meta.id, { fresh: true })).protection
  }

  private async setBlocking(meta: DnsMeta, enabled: boolean, seconds: number | null): Promise<void> {
    const { login, http } = await this.ready(meta)
    if (this.d.kind === 'pihole') await new PiholeClient(http, login.password).session(s => s.setBlocking(enabled, seconds))
    else await new AdguardClient(http, login.username ?? '', login.password).setProtection(enabled, seconds)
  }

  private async pause(meta: DnsMeta, body: ActionRequest, actor: Actor) {
    const minutes = Number(body.minutes)
    if (!(PAUSE_MINUTES as readonly number[]).includes(minutes)) throw new DnsRefusal('bad_input', 'Pause for 5, 30 or 60 minutes.', 400)
    return this.audited(actor, meta, 'pause', { minutes }, async () => {
      await this.setBlocking(meta, false, minutes * 60)
      const p = await this.protectionNow(meta)
      if (p.on) throw new DnsRefusal('not_confirmed', `${this.name} accepted the pause but still reports blocking as on.`, 502)
      return { message: `Blocking is paused for ${minutes} minutes. It turns itself back on after that.` }
    })
  }

  private async resume(meta: DnsMeta, actor: Actor) {
    return this.audited(actor, meta, 'resume', {}, async () => {
      await this.setBlocking(meta, true, null)
      const p = await this.protectionNow(meta)
      if (!p.on) throw new DnsRefusal('not_confirmed', `${this.name} accepted that but still reports blocking as off.`, 502)
      return { message: 'Blocking is on again.' }
    })
  }

  private async updateLists(meta: DnsMeta, actor: Actor) {
    return this.audited(actor, meta, 'update_lists', {}, async () => {
      const { login, http } = await this.ready(meta)
      if (this.d.kind === 'pihole') await new PiholeClient(http, login.password).session(s => s.updateLists())
      else await new AdguardClient(http, login.username ?? '', login.password).updateLists()
      this.cache.delete(meta.id)
      const r = await this.reading(meta.id, { fresh: true })
      const age = r.blocklists.ageHours
      if (age !== null && age > 1) throw new DnsRefusal('not_confirmed', `${this.name} ran the update but its lists still show as ${age} hours old. A list source may be unreachable; try again later.`, 502)
      return { message: `The block lists are up to date${r.blocklists.domains ? `: ${r.blocklists.domains.toLocaleString('en')} entries` : ''}.` }
    })
  }

  private async restart(meta: DnsMeta, actor: Actor) {
    return this.audited(actor, meta, 'restart_service', {}, async () => {
      if (!meta.guest) throw new DnsRefusal('no_guest', `HyperProx does not know which container ${this.name} runs in, so it cannot restart it. Edit this blocker and pick the guest.`, 409)
      if (!this.d.exec) throw new DnsRefusal('no_exec', 'Restarting is not available here.', 409)
      const run = await this.d.exec(meta.guest, restartScript(this.d.kind), { timeoutMs: 90_000 })
      if (run.timedOut) throw new DnsRefusal('timed_out', 'The restart did not finish in time.', 504)
      if (run.output.includes('@@none')) throw new DnsRefusal('not_found', `Neither a Docker container nor a service for ${this.name} was found in that guest.`, 409)
      if (run.code !== 0) throw new DnsRefusal('failed', 'The restart command failed inside the guest.', 502)
      // Done means it answers again, not that the command returned.
      const { login } = await this.ready(meta)
      const wait = this.d.restartWaitMs ?? 60_000
      const t0 = this.d.now()
      this.forget(meta.id)
      for (;;) {
        const a = await this.answering(login)
        if (a.ok) return { message: `${this.name} restarted and answers again (${a.ms} ms).` }
        if (this.d.now() - t0 >= wait) throw new DnsRefusal('not_confirmed', `${this.name} was restarted but is not answering yet. Give it a minute and refresh.`, 504)
        await this.d.sleep(2_000)
      }
    })
  }

  private async allow(meta: DnsMeta, body: ActionRequest, actor: Actor) {
    const domain = cleanDomain(body.domain)
    if (body.confirm !== allowPhrase(domain)) {
      await this.auditRefusal(meta.id, actor, body as Record<string, unknown>, 'confirm')
      throw new DnsRefusal('confirm_wrong', `Type exactly "${allowPhrase(domain)}" to confirm.`, 400)
    }
    return this.audited(actor, meta, 'allow_domain', { domain }, async () => {
      const { login, http } = await this.ready(meta)
      if (this.d.kind === 'pihole') {
        await new PiholeClient(http, login.password).session(s => s.allowDomain(domain, 'Allowed from HyperProx'))
      } else {
        const c = new AdguardClient(http, login.username ?? '', login.password)
        const cur = await c.get('/control/filtering/status')
        if (!cur.ok) throw new DnsRefusal('failed', 'AdGuard Home did not give its current rules, so nothing was changed.', 502)
        const rules: string[] = Array.isArray(cur.json.user_rules) ? cur.json.user_rules.map(String) : []
        const rule = `@@||${domain}^`
        if (!rules.includes(rule)) await c.setUserRules([...rules, rule])
        const back = await c.get('/control/filtering/status')
        if (!back.ok || !(back.json.user_rules ?? []).includes(rule)) throw new DnsRefusal('not_confirmed', 'AdGuard Home did not keep the allow rule.', 502)
      }
      this.cache.delete(meta.id)
      return { message: `${domain} is allowed. It will no longer be blocked.` }
    })
  }

  private async switchUpstream(meta: DnsMeta, body: ActionRequest, actor: Actor) {
    const to = typeof body.to === 'string' ? body.to : ''
    return this.audited(actor, meta, 'switch_upstream', { to }, async () => {
      this.cache.delete(meta.id); this.probeCache.delete(meta.id)
      const r = await this.reading(meta.id, { fresh: true })
      let servers: string[]
      let words: string
      if (to === 'healthy') {
        const ok = r.upstreams.filter(u => u.state === 'ok' || u.state === 'slow')
        if (!ok.length) throw new DnsRefusal('none_healthy', 'None of the current upstream servers answered, so there is nothing to keep. Pick a provider instead.', 409)
        if (ok.length === r.upstreams.length) throw new DnsRefusal('nothing_to_do', 'Every upstream server is answering; nothing to switch.', 409)
        servers = ok.map(u => u.address)
        words = `Now using only ${servers.join(', ')}.`
      } else if (PRESETS[to]) {
        servers = PRESETS[to].servers
        words = `Now using ${PRESETS[to].label} (${servers.join(', ')}).`
      } else throw new DnsRefusal('bad_input', 'Pick Cloudflare, Quad9, Google, or "use only the ones that answer".', 400)
      const { login, http } = await this.ready(meta)
      if (this.d.kind === 'pihole') await new PiholeClient(http, login.password).session(s => s.setUpstreams(servers))
      else await new AdguardClient(http, login.username ?? '', login.password).setUpstreams(servers)
      this.cache.delete(meta.id); this.probeCache.delete(meta.id)
      const back = await this.readAfterChange(meta.id)
      const have = new Set(back.upstreams.map(u => bare(u.address)))
      if (!servers.every(s => have.has(bare(s)))) throw new DnsRefusal('not_confirmed', `${this.name} did not report the new servers back. Check its settings.`, 502)
      const failing = back.upstreams.filter(u => u.state === 'failing').length
      return { message: `${words}${failing ? ` ${failing} of them did not answer a test lookup yet.` : ''}` }
    })
  }

  /** Reads again after a change that makes the blocker restart its DNS (Pi-hole does for new upstreams): a few tries, not one. */
  private async readAfterChange(id: string): Promise<DnsReading> {
    let last: unknown
    for (let i = 0; i < 10; i++) {
      try { this.cache.delete(id); return await this.reading(id, { fresh: true }) }
      catch (e) { if (!(e instanceof DnsUnreachableError)) throw e; last = e; await this.d.sleep(1_500) }
    }
    throw last
  }

  /** The blocker's own IPv4 address for the guest DNS list: the tied guest's own address first, else what its web address gives. */
  private async ownAddress(meta: DnsMeta, login: Login): Promise<string | null> {
    const fromGuest = meta.guest && this.d.guestAddress ? await this.d.guestAddress(meta.guest).catch(() => null) : null
    if (fromGuest && net.isIPv4(fromGuest)) return fromGuest
    const ip = await dnsAddressOf(login.url, this.d.resolve)
    return ip && net.isIPv4(ip) ? ip : null
  }

  private async useForGuests(meta: DnsMeta, actor: Actor) {
    return this.audited(actor, meta, 'use_for_guests', {}, async () => {
      if (!this.d.naming) throw new DnsRefusal('no_naming', 'Guest DNS is not available here.', 409)
      const { login } = await this.ready(meta)
      const ip = await this.ownAddress(meta, login)
      if (!ip) throw new DnsRefusal('no_address', `${this.name} is not on an IPv4 address HyperProx can give to guests.`, 409)
      if (!isPrivateLanIp(ip)) throw new DnsRefusal('not_private', `${ip} is not a private network address, and guests are only pointed at a blocker on your own network.`, 409)
      // Saved only once it answers a DNS lookup at that very address: guests must not lose DNS because of this.
      const test = await this.d.probe(ip, 53)
      if (!test.ok) throw new DnsRefusal('not_answering', `${this.name} did not answer a test lookup at ${ip}, so guests were not pointed at it.`, 409)
      const settings = await this.d.naming.read()
      if (!settings) throw new DnsRefusal('no_naming', 'HyperProx has no naming settings yet (Settings, Naming). That is where the DNS servers it gives new guests live; save them there first.', 409)
      const previous = settings.dns.slice(0, 3)
      if (previous[0] === ip) throw new DnsRefusal('nothing_to_do', 'Guests HyperProx installs already use this blocker first.', 409)
      const next = [ip, ...previous.filter(x => x !== ip)].slice(0, 3)
      const r = await this.d.naming.save({ ...settings, dns: next }, actor.email)
      if (r.errors.length) throw new DnsRefusal('refused', r.errors[0], 400)
      await this.d.store.setGuestDns(meta.id, { address: ip, previous })
      return { message: `Guests HyperProx installs from now on will use ${meta.name} first${previous.length ? `, then ${previous.join(', ')}` : ''}. Guests that already exist are not changed.` }
    })
  }

  /**
   * Called before a blocker is removed: if guests were pointed at it, the DNS list goes back first. A list a person has
   * changed since is left alone. When it cannot be put back, the removal is refused (409) unless `force` is given.
   */
  async releaseGuestDns(id: string, actor: Actor, force = false): Promise<void> {
    const meta = await this.d.store.get(id)
    if (!meta?.guestDns) return
    try { await this.stopUsingForGuests(meta, actor) }
    catch (e: any) {
      if (force) return
      throw new DnsRefusal('guest_dns', `Guests HyperProx installs are still pointed at this blocker and the DNS list could not be put back (${e?.message ?? 'unknown'}). Remove it anyway only if you will fix Settings, Naming yourself.`, 409)
    }
  }

  private async stopUsingForGuests(meta: DnsMeta, actor: Actor) {
    return this.audited(actor, meta, 'stop_using_for_guests', {}, async () => {
      if (!this.d.naming) throw new DnsRefusal('no_naming', 'Guest DNS is not available here.', 409)
      const g = meta.guestDns
      if (!g) throw new DnsRefusal('nothing_to_do', 'Guests are not set to use this blocker.', 409)
      const settings = await this.d.naming.read()
      if (settings && settings.dns[0] === g.address) {
        const r = await this.d.naming.save({ ...settings, dns: g.previous }, actor.email)
        if (r.errors.length) throw new DnsRefusal('refused', r.errors[0], 400)
      }
      await this.d.store.setGuestDns(meta.id, null)
      return { message: 'Guests HyperProx installs from now on go back to the DNS servers they had before. Guests that already exist are not changed.' }
    })
  }

  // ── auto-connect ──────────────────────────────────────────────────────────

  /**
   * One auto-connect pass. Every place this blocker was seen (the service scan, a finished Catalogue install) that is not
   * added yet is connected by itself, with the credential from the vault: the generated one a Catalogue install saved, or
   * exactly one vault item whose login address is that very address. It signs in once first (read-only) so a wrong
   * password is never saved. None: left for a person ("needs a login"). Several: one pick. Never a guest that is excluded,
   * or one a person removed.
   */
  async autoConnect(ctx: AdapterContext): Promise<Outcome[]> {
    const out: Outcome[] = []
    if (!this.d.sightings) return out
    const [seen, rows, list, tags] = await Promise.all([this.d.sightings(), this.d.guests?.() ?? Promise.resolve([] as GuestRow[]), this.d.store.list(), this.d.tags?.() ?? Promise.resolve(new Map<string, string[]>())])
    const byGuest = new Map<string, Sighting[]>()
    for (const s of seen) { const k = machineId({ type: s.guest.kind, vmid: s.guest.vmid }); byGuest.set(k, [...(byGuest.get(k) ?? []), s]) }
    const logins = new Map<string, string>()
    for (const m of list) { const l = await this.d.store.login(m.id); if (l) logins.set(m.id, originOf(l.url)) }
    for (const [key, ss] of byGuest) {
      const row = rows.find(r => r.kind === ss[0].guest.kind && r.vmid === ss[0].guest.vmid)
      const url = bestUrl(ss)
      const label = `${this.name}: ${row?.name ?? key}`
      const have = list.find(m => (m.guest && machineId({ type: m.guest.kind, vmid: m.guest.vmid }) === key) || (url && logins.get(m.id) === originOf(url)))
      if (have) { out.push({ key, label, did: 'present' }); continue }
      const why = exclusionOf(ctx, { machineId: key, tags: tags.get(key) ?? [], addresses: [url] })
      if (why || row?.ignored) { out.push({ key, label, did: 'excluded', message: why ?? row?.excludedBy ?? 'left alone' }); continue }
      if (ctx.dismissed(key)) { out.push({ key, label, did: 'dismissed' }); continue }
      if (!url) { out.push({ key, label, did: 'skipped', message: 'no address to connect to' }); continue }
      const miss = this.autoMiss.get(key)
      if (miss && this.d.now() - miss.at < 10 * 60_000) { out.push(miss.outcome); continue }
      try { out.push(await this.autoAdd(key, label, url, ss, row?.name ?? null, ctx)) }
      catch (e: any) {
        const o: Outcome = { key, label, did: 'failed', message: String(e?.message ?? e).slice(0, 300) }
        this.autoMiss.set(key, { at: this.d.now(), outcome: o })
        out.push(o)
      }
    }
    return out
  }

  private async autoAdd(key: string, label: string, url: string, ss: Sighting[], guestName: string | null, ctx: AdapterContext, picked?: string): Promise<Outcome> {
    const evidence = ss.map(s => `found by ${s.via === 'catalogue' ? 'the Catalogue install' : 'the service scan'}`)
    let cred: { username: string | null; password: string } | null = null
    let item: VaultChoice | null = null
    const cat = ss.find(s => s.via === 'catalogue')
    if (cat && this.d.catalogueLogin) {
      const c = await this.d.catalogueLogin(cat.guest.vmid)
      if (c) { cred = c; evidence.push('the generated login the Catalogue install saved in the vault') }
    }
    if (!cred) {
      const kind = this.d.kind === 'adguard' ? 'login' : 'password'
      const r = picked ? pickVault(ctx.vaultItems(), picked, url, kind) : matchVault(ctx.vaultItems(), url, kind)
      if (!r || r.kind === 'none') return { key, label, did: 'needs_credential', message: `${this.name} was found at ${url}, but no vault item has a login for that address. Add it on the ${this.name} page, or save its login in the vault with that address.` }
      if (r.kind === 'several') return { key, label, did: 'ambiguous', choiceKind: 'vault-item', message: `${r.items.length} vault items have a login for ${url}. Pick the one for ${this.name}.`, choices: r.items.map(i => ({ id: i.id, label: i.name })) }
      cred = { username: r.value.username, password: r.value.secret }
      item = r.item
      evidence.push(`the vault item "${r.item.name}"`)
    }
    const login: Login = { url, username: this.d.kind === 'adguard' ? (cred.username ?? 'admin') : null, password: cred.password, insecureTLS: false }
    // A read-only sign-in first: a password that does not work is never saved.
    try { await this.verify(login) }
    catch (e: any) {
      if (e instanceof DnsLoginError) return { key, label, did: 'needs_credential', message: `${this.name} refused the saved login at ${url}. Enter its current login on the ${this.name} page.` }
      throw e
    }
    const guest = ss[0].guest
    if (ctx.dismissed(key)) return { key, label, did: 'dismissed' }
    await ctx.audit('plugin.auto_connect', `plugin:${this.d.kind}`, { guest: key, address: url, evidence, ...(item ? { vaultItemId: item.id, vaultItemName: item.name } : {}) })
    await this.d.store.create({
      name: cleanName((guestName ?? this.name).slice(0, 40)), guest, url, username: login.username, password: login.password,
      autoConnected: { at: new Date(this.d.now()).toISOString(), evidence, vaultItem: item?.name ?? null },
    })
    return { key, label, did: 'connected', evidence, vaultItem: item }
  }

  /** A person picked one vault item of an ambiguous outcome. */
  async autoPick(key: string, choiceId: string, ctx: AdapterContext): Promise<Outcome> {
    if (!this.d.sightings) throw new Error('Not a choice of this plug-in.')
    const ss = (await this.d.sightings()).filter(s => machineId({ type: s.guest.kind, vmid: s.guest.vmid }) === key)
    if (!ss.length) throw new Error('That blocker is not found on a guest any more.')
    const rows = await (this.d.guests?.() ?? Promise.resolve([] as GuestRow[]))
    const row = rows.find(r => r.kind === ss[0].guest.kind && r.vmid === ss[0].guest.vmid)
    const url = bestUrl(ss)
    if (!url) throw new Error('That blocker has no address.')
    if (row?.ignored) throw new Error('That guest is excluded.')
    return this.autoAdd(key, `${this.name}: ${row?.name ?? key}`, url, ss, row?.name ?? null, ctx, choiceId)
  }
}

const originOf = (v: string) => { try { return new URL(v).origin.toLowerCase() } catch { return v.toLowerCase() } }

/**
 * The address to connect to: the container's own address first (HyperProx reaches it directly, whatever name or certificate
 * the web page was published under), else the address the scan or the install gave.
 */
function bestUrl(ss: Sighting[]): string | null {
  for (const s of ss) {
    for (const cand of [s.ip ? `http://${s.ip}` : null, s.url]) {
      if (!cand) continue
      try { return cleanUrl(cand) } catch { /* try the next */ }
    }
  }
  return null
}
