// =============================================================================
//  HyperProx — HAProxy: the plug-in's service
//
//  Reads one HAProxy (the Runtime API socket and the configuration, inside its
//  guest), acts on it, and connects the ones HyperProx can see by itself.
//
//  Two kinds of change, always labelled as such:
//    runtime only   sent to the Runtime API; takes effect at once and lasts
//                   until HAProxy restarts or reloads
//    saved          written to haproxy.cfg through the Data Plane API, which
//                   validates the whole file with haproxy -c before HAProxy
//                   reloads (lib/haproxy/dataplane.ts). Needs the Proxy page's
//                   instance for this HAProxy: a Catalogue install has one.
//
//  Every action is audited before it runs (an audit that cannot be written
//  stops it) and refused to anyone below admin (lib/roles.ts). Every command
//  into a guest goes through the remote executor, which refuses a guest
//  HyperProx must leave alone (lib/guest-guard.ts); this service checks too,
//  first, so the refusal names the rule.
// =============================================================================

import type { AdapterContext, Outcome } from '../auto-connect/core'
import { RT, RuntimeRefusal, answerProblem, checkName, checkWeight, runtimeScript, splitAnswers, type AdminState } from './runtime'
import { buildReading, cleanCheck, type Reading } from './model'
import {
  ALGORITHMS, checkAlgorithm, type Algorithm, checkHostname, checkNewServer, createLoadBalance, persistAddServer, persistBalance, persistHealth,
  persistMaintenance, persistRemoveServer, persistWeight, CHECK_PATH_RE, type ConfigWriter, type NewServer,
} from './dataplane'
import { HaproxyInstanceStore, type HaproxyGuest, type HaproxyInstance } from './instances'
import { HAPROXY_CONFIG, PUBLIC_FRONTEND, scraperList } from './recipe'

export class HaproxyRefusal extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = 'HaproxyRefusal' }
}

export interface GuestRow {
  kind: 'lxc' | 'qemu'; vmid: number; name: string; node: string; running: boolean
  /** Set when HyperProx must leave it alone (the reason in words). */
  excludedBy: string | null
  /** Its IPv4 addresses (config first, then what it reports). */
  addresses: string[]
}

export interface ExecResult { code: number; output: string; timedOut?: boolean }

export interface ServiceDeps {
  store: HaproxyInstanceStore
  /** A script in the guest, through the remote executor (which refuses a guest HyperProx must leave alone). */
  exec(g: HaproxyGuest, script: string, o?: { timeoutMs?: number }): Promise<ExecResult>
  /** The Data Plane connection of the Proxy page's instance, or null when it has none. */
  writer(proxyInstanceId: string): Promise<ConfigWriter | null>
  audit(action: string, resource: string, details: Record<string, unknown>): Promise<void>
  guests(): Promise<GuestRow[]>
  /** Where HAProxy was seen without looking inside: Catalogue installs and the service scan. */
  sightings(): Promise<Array<{ guest: HaproxyGuest; via: 'catalogue' | 'scan' }>>
  /** The Proxy page's HAProxy instances that run in a container HyperProx manages. */
  proxyInstances(): Promise<Array<{ id: string; name: string; vmid: number }>>
  /** Remember that a person removed one, so auto-connect never adds it back by itself. */
  dismissed(key: string, label: string, by: string): Promise<void>
  now?(): number
}

export interface Actor { email: string; role?: string }

export interface ActionResult { ok: true; message: string; scope: 'runtime' | 'saved' | 'none' }

const key = (g: HaproxyGuest) => `${g.kind}-${g.vmid}`
const RUNTIME_NOTE = 'Runtime only: it lasts until HAProxy restarts or reloads.'
const SAVED_NOTE = 'Saved to the configuration, checked with haproxy -c, and HAProxy reloaded.'

/** The read script: the Runtime API's three answers, the configuration, and haproxy -c. */
export function readScript(socket: string): string {
  return [
    runtimeScript(socket, ['show info', 'show stat', 'show servers state']),
    `CFG=${HAPROXY_CONFIG}; [ -f "$CFG" ] || CFG=/usr/local/etc/haproxy/haproxy.cfg`,
    'echo "### config"; cat "$CFG" 2>/dev/null | head -c 400000',
    'echo "### check"; if command -v haproxy >/dev/null 2>&1; then haproxy -c -f "$CFG" 2>&1 | head -c 4000; echo "HPX_EXIT=${PIPESTATUS[0]}"; else echo "HPX_EXIT=0"; fi',
  ].join('\n')
}

export function parseReadOutput(output: string, now = new Date()): Reading {
  if (output.includes('HPX_NO_SOCKET')) throw new HaproxyRefusal('no_socket', 'HAProxy\'s Runtime API socket is not there: HAProxy may be stopped, or its socket moved.', 502)
  if (output.includes('HPX_NO_CLIENT')) throw new HaproxyRefusal('no_client', 'Neither socat nor python3 is installed in the guest, so HyperProx cannot read HAProxy\'s socket.', 502)
  const a = splitAnswers(output)
  const check = a.get('check') ?? ''
  const m = /HPX_EXIT=(\d+)/.exec(check)
  return buildReading({
    info: a.get('show info') ?? '', stat: a.get('show stat') ?? '', state: a.get('show servers state') ?? '',
    config: a.get('config') ?? '', configCheck: { code: m ? Number(m[1]) : 0, output: check.replace(/HPX_EXIT=\d+/, '') },
  }, now)
}

/** Finds HAProxy's admin socket inside a guest; read-only. */
export const DETECT_SCRIPT = [
  'for f in /etc/haproxy/haproxy.cfg /usr/local/etc/haproxy/haproxy.cfg; do',
  '  [ -f "$f" ] || continue',
  '  grep -E "^[[:space:]]*stats socket[[:space:]]+/[^[:space:]]+\\.sock[[:space:]].*level admin" "$f" | awk \'{ print $3 }\' | while read -r s; do',
  '    [ -S "$s" ] && echo "SOCKET=$s"',
  '  done',
  'done',
  'command -v socat >/dev/null 2>&1 && echo "CLIENT=socat" || { command -v python3 >/dev/null 2>&1 && echo "CLIENT=python3"; }',
].join('\n')

export function parseDetect(output: string): { sockets: string[]; client: boolean } {
  const sockets = [...new Set([...output.matchAll(/^SOCKET=(\S+)$/gm)].map(m => m[1]))]
  return { sockets, client: /^CLIENT=/m.test(output) }
}

/** What "Load-balance this app" takes, checked: the rules the plug-in's button and the install's optional step share. */
export interface LoadBalanceInput {
  list: Record<string, unknown>[]; port: number; algorithm: Algorithm; hostname: string | undefined
  checkPath: string; name: string; backend: string
}

export function parseLoadBalance(body: Record<string, unknown>): LoadBalanceInput {
  const list = Array.isArray(body.guests) ? body.guests as Record<string, unknown>[] : []
  if (list.length < 2) throw new HaproxyRefusal('bad_input', 'Pick at least two guests running the same app.')
  if (list.length > 16) throw new HaproxyRefusal('bad_input', 'Up to 16 guests at a time.')
  const port = Number(body.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HaproxyRefusal('bad_input', 'The port the app answers on is a number from 1 to 65535.')
  let algorithm: Algorithm, hostname: string | undefined
  try { algorithm = checkAlgorithm(body.algorithm ?? 'roundrobin'); hostname = checkHostname(body.hostname) ?? undefined } catch (e: any) { throw new HaproxyRefusal('bad_input', e.message) }
  const checkPath = typeof body.checkPath === 'string' && body.checkPath ? body.checkPath : '/'
  if (!CHECK_PATH_RE.test(checkPath)) throw new HaproxyRefusal('bad_input', 'The health check path starts with / and has no spaces or query.')
  const name = String(body.name ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  if (!name) throw new HaproxyRefusal('bad_input', 'Give the app a short name, such as web.')
  return { list, port, algorithm, hostname, checkPath, name, backend: `hpx_lb_${name.replace(/-/g, '_')}` }
}

/** A guest named by a pick ({ kind, vmid }), refused when it is not on the cluster or HyperProx must leave it alone. */
export function findPickGuest(rows: GuestRow[], g: Record<string, unknown>): GuestRow {
  const kind = g.kind === 'qemu' ? 'qemu' : 'lxc', vmid = Number(g.vmid)
  const row = rows.find(r => r.kind === kind && r.vmid === vmid)
  if (!row) throw new HaproxyRefusal('bad_input', `Guest ${vmid} was not found.`, 404)
  if (row.excludedBy) throw new HaproxyRefusal('excluded', `${row.name} carries ${row.excludedBy}, so HyperProx leaves it alone.`, 409)
  return row
}

/**
 * The servers for "Load-balance this app": every pick checked (on the cluster, not left alone, once, running, with an
 * address). `self` is HAProxy's own guest when it is one of them (reached on its loopback). Shared by the plug-in's
 * button and the install's optional step, so the two cannot disagree.
 */
export function pickLoadBalanceServers(list: Record<string, unknown>[], rows: GuestRow[], port: number, self?: { kind: string; vmid: number }): NewServer[] {
  const servers: NewServer[] = []
  const seen = new Set<string>()
  for (const g of list) {
    const row = findPickGuest(rows, g)
    const k = `${row.kind}-${row.vmid}`
    if (seen.has(k)) throw new HaproxyRefusal('bad_input', `${row.name} is picked twice.`)
    seen.add(k)
    if (!row.running) throw new HaproxyRefusal('bad_input', `${row.name} is not running.`)
    const address = self && row.kind === self.kind && row.vmid === self.vmid ? '127.0.0.1' : row.addresses[0]
    if (!address) throw new HaproxyRefusal('bad_input', `${row.name} has no address HyperProx can see.`)
    servers.push(checkNewServer({ name: serverNameFor(row.name, row.vmid), address, port, weight: 100, check: true }))
  }
  return servers
}

export class HaproxyService {
  private busy = new Map<string, Promise<unknown>>()
  constructor(private d: ServiceDeps) {}
  get store() { return this.d.store }
  private now() { return this.d.now ? this.d.now() : Date.now() }

  async list(): Promise<Array<HaproxyInstance & { saves: boolean }>> {
    return (await this.d.store.list()).map(i => ({ ...i, saves: !!i.proxyInstanceId }))
  }

  private async instance(id: string): Promise<HaproxyInstance> {
    const i = await this.d.store.get(String(id))
    if (!i) throw new HaproxyRefusal('no_instance', 'That HAProxy is not connected.', 404)
    return i
  }

  /** The guest, checked: on the cluster, running, and not one HyperProx must leave alone. */
  private async guestOf(i: HaproxyInstance): Promise<GuestRow> {
    const row = (await this.d.guests()).find(r => r.kind === i.guest.kind && r.vmid === i.guest.vmid)
    if (!row) throw new HaproxyRefusal('gone', `The guest HAProxy ran in (${i.guest.vmid}) is no longer on the cluster.`, 404)
    if (row.excludedBy) throw new HaproxyRefusal('excluded', `${row.name} carries ${row.excludedBy}, so HyperProx does not look inside it.`, 409)
    if (!row.running) throw new HaproxyRefusal('stopped', `${row.name} is not running.`, 409)
    return row
  }

  async reading(id: string): Promise<Reading> {
    const i = await this.instance(id)
    await this.guestOf(i)
    const r = await this.d.exec(i.guest, readScript(i.socket), { timeoutMs: 30_000 })
    if (r.timedOut) throw new HaproxyRefusal('timeout', 'HAProxy did not answer within 30 seconds.', 504)
    return parseReadOutput(r.output, new Date(this.now()))
  }

  private async runtime(i: HaproxyInstance, commands: string[]): Promise<void> {
    const r = await this.d.exec(i.guest, runtimeScript(i.socket, commands), { timeoutMs: 30_000 })
    if (r.output.includes('HPX_NO_SOCKET')) throw new HaproxyRefusal('no_socket', 'HAProxy\'s Runtime API socket is not there: HAProxy may be stopped.', 502)
    for (const [cmd, answer] of splitAnswers(r.output)) {
      const p = answerProblem(answer)
      if (p) throw new HaproxyRefusal('refused', `HAProxy refused "${cmd}": ${p}`, 422)
    }
  }

  private async writer(i: HaproxyInstance): Promise<ConfigWriter> {
    const w = i.proxyInstanceId ? await this.d.writer(i.proxyInstanceId) : null
    if (!w) throw new HaproxyRefusal('runtime_only', 'This HAProxy has no Data Plane API connected, so HyperProx can only make runtime changes to it (they last until it restarts). A HAProxy installed from the Catalogue has one.', 409)
    return w
  }

  /** One action at a time per HAProxy: two writes racing on one configuration are refused, not queued. */
  private async once<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) throw new HaproxyRefusal('busy', 'Another change to this HAProxy is still running. Try again in a moment.', 409)
    const p = fn()
    this.busy.set(id, p)
    try { return await p } finally { this.busy.delete(id) }
  }

  async act(id: string, action: string, body: Record<string, unknown>, actor: Actor): Promise<ActionResult> {
    const i = await this.instance(id)
    const row = await this.guestOf(i)
    const persist = body.persist === true
    const b = () => checkName(body.backend, 'The backend')
    const s = () => checkName(body.server, 'The server')
    const audit = (details: Record<string, unknown>) => this.d.audit(`haproxy.${action}`, `haproxy:${i.id}`, { ...details, guest: i.guest.vmid, by: actor.email, saved: persist })
    return this.once(i.id, async () => {
      try {
        switch (action) {
          case 'state': {
            const state = String(body.state) as AdminState
            if (!['ready', 'drain', 'maint'].includes(state)) throw new HaproxyRefusal('bad_input', 'The state is ready, drain or maint.')
            const [bb, ss] = [b(), s()]
            if (persist && state === 'drain') throw new HaproxyRefusal('bad_input', 'Drain is runtime only: HAProxy has no saved drain state. Use maintenance to keep a server out across restarts.')
            await audit({ backend: bb, server: ss, state })
            if (persist) { await persistMaintenance(await this.writer(i), bb, ss, state === 'maint'); return { ok: true, scope: 'saved', message: `${ss} is ${state === 'maint' ? 'in maintenance' : 'back in service'}. ${SAVED_NOTE}` } }
            await this.runtime(i, [RT.setState(bb, ss, state)])
            const words = { ready: 'back in service', drain: 'draining: it finishes its current visitors and gets no new ones', maint: 'in maintenance: it gets no traffic' }[state]
            return { ok: true, scope: 'runtime', message: `${ss} is ${words}. ${RUNTIME_NOTE}` }
          }
          case 'drain': case 'ready': {
            const [bb, ss] = [b(), s()]
            await audit({ backend: bb, server: ss })
            await this.runtime(i, [RT.setState(bb, ss, action)])
            return { ok: true, scope: 'runtime', message: action === 'drain' ? `${ss} is draining and gets no new visitors while you look at it. ${RUNTIME_NOTE}` : `${ss} is back in service. ${RUNTIME_NOTE}` }
          }
          case 'weight': {
            const [bb, ss, w] = [b(), s(), checkWeight(body.weight)]
            await audit({ backend: bb, server: ss, weight: w })
            if (persist) { await persistWeight(await this.writer(i), bb, ss, w); return { ok: true, scope: 'saved', message: `${ss}'s weight is ${w}. ${SAVED_NOTE}` } }
            await this.runtime(i, [RT.setWeight(bb, ss, w)])
            return { ok: true, scope: 'runtime', message: `${ss}'s weight is ${w}${w === 0 ? ' (no new traffic)' : ''}. ${RUNTIME_NOTE}` }
          }
          case 'health': case 'enable-health': {
            const on = action === 'enable-health' ? true : body.on === true
            const [bb, ss] = [b(), s()]
            await audit({ backend: bb, server: ss, on })
            if (persist) { await persistHealth(await this.writer(i), bb, ss, on); return { ok: true, scope: 'saved', message: `${ss}'s health check is ${on ? 'on' : 'off'}. ${SAVED_NOTE}` } }
            await this.runtime(i, [RT.health(bb, ss, on)])
            return { ok: true, scope: 'runtime', message: `${ss}'s health check is ${on ? 'on' : 'off'}. ${RUNTIME_NOTE}` }
          }
          case 'retry': {
            const bb = b()
            const reading = await this.reading(i.id)
            const be = reading.backends.find(x => x.name === bb)
            if (!be) throw new HaproxyRefusal('bad_input', `${bb} is not a backend of this HAProxy.`, 404)
            const only = body.server !== undefined ? s() : null
            const targets = be.servers.filter(x => (only ? x.name === only : true) && x.check.enabled)
            if (!targets.length) throw new HaproxyRefusal('bad_input', 'None of those servers has a health check to run again. Turn one on first.')
            await audit({ backend: bb, servers: targets.map(x => x.name) })
            // HAProxy has no "check now": stopping and starting the check starts a new one at once.
            await this.runtime(i, targets.flatMap(x => [RT.health(bb, x.name, false), RT.health(bb, x.name, true)]))
            return { ok: true, scope: 'runtime', message: `A new health check started for ${targets.map(x => x.name).join(', ')}. The result shows in a few seconds.` }
          }
          case 'add-server': {
            const bb = b()
            const ns = await this.newServer(body, row)
            await audit({ backend: bb, server: ns.name, address: ns.address, port: ns.port, weight: ns.weight })
            if (persist) { await persistAddServer(await this.writer(i), bb, ns); return { ok: true, scope: 'saved', message: `${ns.name} (${ns.address}:${ns.port}) is in ${bb}. ${SAVED_NOTE}` } }
            // A server added at runtime starts in maintenance: it is enabled, and its check started, once it exists.
            await this.runtime(i, [RT.addServer(bb, ns.name, ns.address, ns.port, ns.weight, ns.check), ...(ns.check ? [RT.health(bb, ns.name, true)] : []), RT.enableServer(bb, ns.name)])
            return { ok: true, scope: 'runtime', message: `${ns.name} (${ns.address}:${ns.port}) is in ${bb}. ${RUNTIME_NOTE}` }
          }
          case 'remove-server': {
            const [bb, ss] = [b(), s()]
            await audit({ backend: bb, server: ss })
            if (persist) { await persistRemoveServer(await this.writer(i), bb, ss); return { ok: true, scope: 'saved', message: `${ss} is no longer in ${bb}. ${SAVED_NOTE}` } }
            // HAProxy deletes only a server in maintenance with no sessions left: put it there, close them, delete.
            await this.runtime(i, [RT.setState(bb, ss, 'maint'), RT.shutdownSessions(bb, ss), RT.delServer(bb, ss)])
            return { ok: true, scope: 'runtime', message: `${ss} is no longer in ${bb}; its open connections were closed. ${RUNTIME_NOTE}` }
          }
          case 'balance': {
            const [bb, algo] = [b(), checkAlgorithm(body.algorithm)]
            await audit({ backend: bb, algorithm: algo })
            await persistBalance(await this.writer(i), bb, algo)
            return { ok: true, scope: 'saved', message: `${bb} now balances by ${algo}: ${ALGORITHMS[algo]} ${SAVED_NOTE}` }
          }
          case 'check-config': {
            const r = await this.reading(i.id)
            return { ok: true, scope: 'none', message: r.config.ok ? 'The configuration passes haproxy -c.' : `The configuration still fails haproxy -c: ${r.config.error}` }
          }
          default: throw new HaproxyRefusal('bad_action', 'That is not something the HAProxy plug-in does.', 404)
        }
      } catch (e) { throw plainError(e) }
    })
  }

  /** A new server from the request: a guest from the picker (its address looked up), or an address typed in. */
  private async newServer(body: Record<string, unknown>, self: GuestRow): Promise<NewServer> {
    const g = body.guest as Record<string, unknown> | undefined
    if (g) {
      const row = await this.pickGuest(g)
      const address = row.addresses[0]
      if (!address) throw new HaproxyRefusal('bad_input', `${row.name} has no address HyperProx can see.`)
      const sameBox = row.kind === self.kind && row.vmid === self.vmid
      return checkNewServer({ ...body, name: body.name || serverNameFor(row.name, row.vmid), address: sameBox ? '127.0.0.1' : address })
    }
    return checkNewServer(body)
  }

  private async pickGuest(g: Record<string, unknown>): Promise<GuestRow> {
    return findPickGuest(await this.d.guests(), g)
  }

  /** The guests the picker offers: running, not left alone, with an address. */
  async pickable(): Promise<Array<{ kind: 'lxc' | 'qemu'; vmid: number; name: string; node: string; address: string }>> {
    return (await this.d.guests()).filter(r => r.running && !r.excludedBy && r.addresses.length)
      .map(r => ({ kind: r.kind, vmid: r.vmid, name: r.name, node: r.node, address: r.addresses[0] }))
  }

  /**
   * "Load-balance this app": 2 or more guests running the same app on the same port become one backend with HTTP
   * health checks, and a rule in the public frontend sends visitors to it (by host name, or everything else when no
   * name is given). `publish` (planned by the caller before anything changes) then publishes the host name through the
   * Proxy page and DNS, pointed at HAProxy, in the background.
   */
  async loadBalance(id: string, body: Record<string, unknown>, actor: Actor, publish?: (ip: string) => Promise<{ jobId: string }>): Promise<ActionResult & { backend: string; publishJob?: string; publishProblem?: string }> {
    const i = await this.instance(id)
    const self = await this.guestOf(i)
    const { list, port, algorithm, hostname, checkPath, backend } = parseLoadBalance(body)
    const servers = pickLoadBalanceServers(list, await this.d.guests(), port, self)
    if (publish && !hostname) throw new HaproxyRefusal('bad_input', 'Publishing needs the host name visitors will use.')
    // Everything that can be refused is checked before anything is saved: a refusal after the save would hide it.
    const lbIp = self.addresses[0]
    if (publish && !lbIp) throw new HaproxyRefusal('bad_input', 'HAProxy\'s guest has no address to point the public name at.')
    const w = await this.writer(i)
    return this.once(i.id, async () => {
      await this.d.audit('haproxy.load-balance', `haproxy:${i.id}`, { backend, servers: servers.map(x => `${x.name}=${x.address}:${x.port}`), hostname, algorithm, publish: !!publish, guest: i.guest.vmid, by: actor.email })
      try {
        await createLoadBalance(w, { backend, algorithm: algorithm!, servers, frontend: PUBLIC_FRONTEND, hostname: hostname ?? null, checkPath })
      } catch (e) { throw plainError(e) }
      const target = hostname ? `visitors to ${hostname}` : 'every visitor no other rule matches'
      const saved = `HAProxy now spreads ${target} across ${servers.length} servers by ${algorithm}, checking each with GET ${checkPath}. ${SAVED_NOTE}`
      // Saved from here on: a publish that cannot start is reported beside what was saved, never in its place.
      let publishJob: string | undefined
      if (publish) {
        try { publishJob = (await publish(lbIp!)).jobId } catch (e: any) {
          return { ok: true, scope: 'saved', backend, publishProblem: String(e?.message ?? e).slice(0, 300),
            message: `${saved} Publishing ${hostname} did not start, so no DNS record, proxy host or certificate was made: ${String(e?.message ?? e).slice(0, 300)}` }
        }
      }
      return { ok: true, scope: 'saved', backend, ...(publishJob ? { publishJob } : {}),
        message: `${saved}${publishJob ? ' The public name, proxy host and certificate are being set up now.' : ''}` }
    })
  }

  /**
   * Keep the metrics allow-list current: HyperProx's own addresses, written to the guest's hyperprox-scrapers.lst.
   * Nothing changes when the list is the same; otherwise the new file is checked with haproxy -c (the old one is put
   * back if that fails) and HAProxy reloads. A HAProxy without the list (not a Catalogue install) is left alone.
   */
  async refreshScrapers(id: string, addresses: string[]): Promise<'same' | 'reloaded' | 'not-managed'> {
    const i = await this.instance(id)
    await this.guestOf(i)
    const list = scraperList(addresses)
    if (!list.length) throw new HaproxyRefusal('bad_input', 'HyperProx has no network address to allow, so the list was left as it is.')
    const r = await this.d.exec(i.guest, scrapersScript(list), { timeoutMs: 60_000 })
    if (/HPX_NO_LIST/.test(r.output)) return 'not-managed'
    if (/HPX_SAME/.test(r.output)) return 'same'
    if (r.code !== 0 || !/HPX_RELOADED/.test(r.output)) throw new HaproxyRefusal('refused', `HAProxy's metrics allow-list could not be updated: ${cleanCheck(r.output)}`, 422)
    await this.d.audit('haproxy.metrics-allow-list', `haproxy:${i.id}`, { guest: i.guest.vmid, addresses: list, by: 'system' })
    return 'reloaded'
  }

  /** A person disconnects one: it is remembered, so auto-connect never adds it back by itself. */
  async remove(id: string, actor: Actor): Promise<{ removed: string }> {
    const i = await this.instance(id)
    await this.d.audit('haproxy.disconnect', `haproxy:${i.id}`, { guest: i.guest.vmid, by: actor.email })
    await this.d.dismissed(key(i.guest), i.name, actor.email)
    await this.d.store.remove(i.id)
    return { removed: i.name }
  }

  // ── auto-connect ───────────────────────────────────────────────────────────

  async autoConnect(ctx: AdapterContext): Promise<Outcome[]> {
    const out: Outcome[] = []
    const [rows, sightings, proxies, list] = await Promise.all([this.d.guests(), this.d.sightings().catch(() => []), this.d.proxyInstances().catch(() => []), this.d.store.list()])
    const found = new Map<string, { guest: HaproxyGuest; via: Array<'catalogue' | 'scan' | 'proxy'>; proxyInstanceId: string | null }>()
    const note = (guest: HaproxyGuest, via: 'catalogue' | 'scan' | 'proxy', proxyInstanceId: string | null = null) => {
      const e = found.get(key(guest)) ?? { guest, via: [], proxyInstanceId: null }
      if (!e.via.includes(via)) e.via.push(via)
      e.proxyInstanceId ??= proxyInstanceId
      found.set(key(guest), e)
    }
    for (const p of proxies) note({ kind: 'lxc', vmid: p.vmid }, 'proxy', p.id)
    for (const s of sightings) note(s.guest, s.via)
    for (const [k, f] of found) {
      const row = rows.find(r => r.kind === f.guest.kind && r.vmid === f.guest.vmid)
      const label = row?.name ?? k
      if (ctx.excludedMachines.has(k) || row?.excludedBy) { out.push({ key: k, label, did: 'excluded', message: row?.excludedBy ?? 'Remote access\'s exclusion list' }); continue }
      const have = list.find(i => i.guest.kind === f.guest.kind && i.guest.vmid === f.guest.vmid)
      if (have) {
        // Connected before its Proxy page instance existed: the Data Plane login is linked now (an id, not the login).
        if (!have.proxyInstanceId && f.proxyInstanceId) {
          await ctx.audit('haproxy.autoconnect.link', `haproxy:${have.id}`, { guest: f.guest.vmid, proxyInstance: f.proxyInstanceId })
          await this.d.store.update(have.id, { proxyInstanceId: f.proxyInstanceId })
          out.push({ key: k, label, did: 'filled', message: 'linked to its Data Plane API, so changes can be saved' })
        } else out.push({ key: k, label, did: 'present' })
        continue
      }
      if (!row) { out.push({ key: k, label, did: 'skipped', message: 'not on the cluster' }); continue }
      if (ctx.dismissed(k)) { out.push({ key: k, label, did: 'dismissed' }); continue }
      if (!row.running) { out.push({ key: k, label, did: 'skipped', message: 'not running' }); continue }
      try {
        const r = await this.d.exec(f.guest, DETECT_SCRIPT, { timeoutMs: 20_000 })
        const det = parseDetect(r.output)
        if (!det.sockets.length) { out.push({ key: k, label, did: 'skipped', message: 'no HAProxy admin socket found in it' }); continue }
        if (det.sockets.length > 1) {
          out.push({ key: k, label, did: 'ambiguous', choiceKind: 'container', message: `${row.name} has ${det.sockets.length} HAProxy admin sockets. Pick the one HyperProx uses.`, choices: det.sockets.map(s => ({ id: s, label: s })) })
          continue
        }
        if (!det.client) { out.push({ key: k, label, did: 'skipped', message: 'neither socat nor python3 is installed in it' }); continue }
        const evidence = [...f.via.map(v => (v === 'proxy' ? 'the Proxy page has it' : v === 'catalogue' ? 'installed from the Catalogue' : 'the service scan found it')), `admin socket ${det.sockets[0]}`]
        await ctx.audit('haproxy.autoconnect', `haproxy:${k}`, { guest: f.guest.vmid, evidence, proxyInstance: f.proxyInstanceId })
        if ((await this.d.store.list()).some(i => i.guest.kind === f.guest.kind && i.guest.vmid === f.guest.vmid)) { out.push({ key: k, label, did: 'present' }); continue }
        await this.d.store.add({ name: row.name, guest: f.guest, socket: det.sockets[0], proxyInstanceId: f.proxyInstanceId, via: f.via.includes('catalogue') ? 'catalogue' : f.via.includes('scan') ? 'scan' : f.via[0] }, this.now())
        out.push({ key: k, label, did: 'connected', evidence })
      } catch (e: any) {
        out.push({ key: k, label, did: 'failed', message: String(e?.message ?? e).slice(0, 300) })
      }
    }
    return out
  }

  /** A person picked which socket, for a guest with more than one. */
  async autoPick(k: string, socket: string, ctx: AdapterContext): Promise<Outcome> {
    const m = /^(lxc|qemu)-(\d+)$/.exec(k)
    if (!m) throw new HaproxyRefusal('bad_input', 'That is not a guest.')
    const guest: HaproxyGuest = { kind: m[1] as 'lxc' | 'qemu', vmid: Number(m[2]) }
    const row = (await this.d.guests()).find(r => r.kind === guest.kind && r.vmid === guest.vmid)
    if (!row || row.excludedBy || ctx.excludedMachines.has(k)) throw new HaproxyRefusal('excluded', 'HyperProx leaves that guest alone.', 409)
    const det = parseDetect((await this.d.exec(guest, DETECT_SCRIPT, { timeoutMs: 20_000 })).output)
    if (!det.sockets.includes(socket)) throw new HaproxyRefusal('bad_input', 'That socket is not one HAProxy has there now.')
    await ctx.audit('haproxy.autoconnect', `haproxy:${k}`, { guest: guest.vmid, evidence: [`picked admin socket ${socket}`] })
    await this.d.store.add({ name: row.name, guest, socket, proxyInstanceId: null, via: 'person' }, this.now())
    return { key: k, label: row.name, did: 'connected', evidence: [`admin socket ${socket}`] }
  }
}

/**
 * Errors in words: a checked value is the person's to fix; the Data Plane API refusing a change (its own schema check,
 * before haproxy -c) means nothing was applied, said without the request's path or transaction id.
 */
export function plainError(e: unknown): unknown {
  if (e instanceof RuntimeRefusal) return new HaproxyRefusal('bad_input', e.message)
  if (e instanceof Error && e.name === 'ProxyHttpError') {
    const status = (e as any).status as number
    const why = /answered \d{3}:\s*(.*)$/s.exec(e.message)?.[1]?.trim()
    if (status >= 400 && status < 500) return new HaproxyRefusal('rejected', `HAProxy's Data Plane API refused the change, so nothing was applied${why ? `: ${why.slice(0, 300)}` : '.'}`, 422)
    return new HaproxyRefusal('unreachable', `HAProxy's Data Plane API did not take the change (it answered ${status}). Nothing was applied.`, 502)
  }
  return e
}

/** Rewrites hyperprox-scrapers.lst to exactly `list` (checked IPv4 addresses) when it differs, validated, then reloads. */
export function scrapersScript(list: string[]): string {
  const ok = scraperList(list)
  if (ok.length !== list.length || !ok.length) throw new RuntimeRefusal('Only IPv4 addresses go in the metrics allow-list.')
  return [
    'F=/etc/haproxy/hyperprox-scrapers.lst',
    '[ -f "$F" ] || { echo HPX_NO_LIST; exit 0; }',
    "NEW=$(cat <<'HPX_LIST'", ...ok, 'HPX_LIST', ')',
    '[ "$(cat "$F")" = "$NEW" ] && { echo HPX_SAME; exit 0; }',
    'cp -p "$F" "$F.prev" && printf \'%s\\n\' "$NEW" > "$F.new" && chmod 644 "$F.new" && mv "$F.new" "$F"',
    'if ! haproxy -c -q -f /etc/haproxy/haproxy.cfg 2>&1; then mv "$F.prev" "$F"; echo HPX_CHECK_FAILED; exit 1; fi',
    'rm -f "$F.prev"; systemctl reload haproxy && echo HPX_RELOADED',
  ].join('\n')
}

/** A server name HAProxy accepts, from a guest's name and id. */
export function serverNameFor(name: string, vmid: number): string {
  const base = String(name ?? '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return `${base || 'guest'}-${vmid}`
}
