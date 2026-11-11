// =============================================================================
//  HyperProx — QNAP: the service
//
//  Reads: one reading per NAS, kept 20 seconds so several open pages and the
//  alert poller cost one login; limited per session.
//
//  Actions, in two tiers, each with exactly one way in (as for Home Assistant):
//    normal    a quick SMART test of one disk: operator or above (the gate), on
//              POST .../actions. It reads the disk back afterwards.
//    security  restart and shut down: on POST .../secure-actions only, admin, a
//              person (never an API token), the master password re-entered
//              (the gate), the confirm phrase and the NAS's name typed (here),
//              rate-limited, and a notification after it.
//  Every attempt, refused or not, gets an audit row (who, which NAS, what,
//  result; never an address or a login). Nothing here deletes data.
//
//  A NAS that refuses the login is not asked again (not by the page, not by the
//  alert poller) until its login is saved again: QTS can lock an account after
//  repeated failures, and a poller retrying every few minutes would do exactly
//  that.
// =============================================================================

import { hasRole, type Role } from '../roles'
import { QnapClient, QnapLoginError } from './client'
import { effectiveReach, nodeFor, type QnapInstanceStore, type QnapMeta, type ClusterFacts } from './instances'
import type { QnapReading } from './parse'
import { ClusterTransport, DirectTransport, QnapUnreachableError, type NodeScriptRunner, type QnapTransport } from './transport'
import type { NotifyEventInput } from '../notify/types'
import { remoteTargetProblem } from './target'

export interface Actor { sid: string; email: string; role: Role; token: string | null }

export class QnapRefusal extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); this.name = 'QnapRefusal' }
}

export type PowerAction = 'restart' | 'shutdown'
export const POWER_WORD: Record<PowerAction, string> = { restart: 'Restart', shutdown: 'Shut down' }
/** The phrase a security action is confirmed with. The person also types the NAS's name. */
export const confirmPhrase = (a: PowerAction, name: string) => `${POWER_WORD[a]} ${name}`

export interface ActionRequest { action?: unknown; bay?: unknown; confirm?: unknown; typed?: unknown }

export interface ServiceDeps {
  store: QnapInstanceStore
  audit: (action: string, resource: string, details: Record<string, unknown>) => Promise<void>
  publish?: (e: NotifyEventInput) => Promise<void>
  /** Builds the runner for a remote cluster's node. Production: lib/qnap/remote.ts. */
  nodeRunner?: (clusterId: string, node: string, purpose: 'read' | 'action') => NodeScriptRunner
  /** Tests replace the whole transport. */
  transportFor?: (c: { url: string; meta: QnapMeta; cluster: ClusterFacts | null }) => QnapTransport
  now?: () => number
  limits?: Partial<Limits>
}

export interface Limits { readsPerMinute: number; normalPerMinute: number; securityPerMinute: number; attemptsPerMinute: number; probesPerMinute: number }

const CACHE_MS = 20_000

export class QnapService {
  private cache = new Map<string, { at: number; reading: QnapReading }>()
  private inflight = new Map<string, Promise<QnapReading>>()
  private blocked = new Map<string, { at: number; message: string }>()
  private hits = new Map<string, number[]>()
  private d: ServiceDeps & { now: () => number; limits: Limits }

  constructor(deps: ServiceDeps) {
    this.d = {
      now: () => Date.now(), ...deps,
      limits: { readsPerMinute: 30, normalPerMinute: 6, securityPerMinute: 3, attemptsPerMinute: 20, probesPerMinute: 10, ...(deps.limits ?? {}) },
    }
  }

  get instances(): QnapInstanceStore { return this.d.store }

  /** Forget a NAS's refused login and its cached reading: called when its login is saved again. */
  forget(id: string): void { this.blocked.delete(id); this.cache.delete(id) }

  /** Why HyperProx is not asking this NAS, when it is holding back after a refused login. */
  blockedReason(id: string): string | null { return this.blocked.get(id)?.message ?? null }

  limit(actor: Actor, bucket: keyof Limits, message = 'Too many requests; wait a moment.'): void {
    const key = `${actor.sid}:${bucket}`
    const now = this.d.now()
    if (this.hits.size > 1000) for (const [k, v] of this.hits) if (!v.some(t => now - t < 60_000)) this.hits.delete(k)
    const recent = (this.hits.get(key) ?? []).filter(t => now - t < 60_000)
    if (recent.length >= this.d.limits[bucket]) { this.hits.set(key, recent); throw new QnapRefusal('rate_limited', message, 429) }
    recent.push(now); this.hits.set(key, recent)
  }

  private async meta(id: string): Promise<QnapMeta> {
    const m = await this.d.store.get(id)
    if (!m) throw new QnapRefusal('no_instance', 'No such NAS.', 404)
    return m
  }

  /** How this NAS is reached, in words for the page ("direct", "through <cluster>"). */
  async reachOf(id: string): Promise<{ how: 'direct' | 'cluster'; cluster: ClusterFacts | null }> {
    const c = await this.d.store.connection(id)
    const m = c?.meta ?? await this.meta(id)
    const cluster = this.d.store.cluster(m.clusterId)
    return { how: c ? effectiveReach(m, c.url, cluster) : 'direct', cluster }
  }

  private async client(id: string, purpose: 'read' | 'action'): Promise<{ client: QnapClient; meta: QnapMeta }> {
    const c = await this.d.store.connection(id)
    if (!c) throw new QnapRefusal('not_configured', 'This NAS has no address or login yet.', 409)
    const cluster = this.d.store.cluster(c.meta.clusterId)
    let t: QnapTransport
    if (this.d.transportFor) t = this.d.transportFor({ url: c.url, meta: c.meta, cluster })
    else if (effectiveReach(c.meta, c.url, cluster) === 'cluster') {
      const n = nodeFor(c.meta, cluster!)
      if (!n || !this.d.nodeRunner) throw new QnapRefusal('no_route', `${cluster!.name} has no node HyperProx can ask the NAS through.`, 409)
      // Checked on every use as well as on save: the cluster's node addresses can change after the NAS was saved.
      const why = remoteTargetProblem(new URL(c.url), n.address)
      if (why) throw new QnapRefusal('bad_target', why, 409)
      t = new ClusterTransport({ url: c.url, insecureTLS: c.meta.insecureTLS, clusterName: cluster!.name, run: this.d.nodeRunner(c.meta.clusterId!, n.node, purpose) })
    } else t = new DirectTransport({ url: c.url, insecureTLS: c.meta.insecureTLS, fingerprint: c.meta.fingerprint })
    return { client: new QnapClient(t, { username: c.username, password: c.password }), meta: c.meta }
  }

  /** Turn a refused login into a hold, so nothing asks again until the login is saved. */
  private hold(id: string, e: unknown): never {
    if (e instanceof QnapLoginError && e.kind !== 'no-answer') {
      this.blocked.set(id, { at: this.d.now(), message: `${e.message} HyperProx will not try again until the login is saved again (so the NAS does not lock the account).` })
    }
    throw e
  }

  /** A reading, from the last 20 seconds when there is one. `fresh` asks again if the cached one is over 5 seconds old. */
  async reading(id: string, o: { actor?: Actor; fresh?: boolean } = {}): Promise<QnapReading> {
    await this.meta(id)
    if (o.actor) this.limit(o.actor, 'readsPerMinute')
    const held = this.blocked.get(id)
    if (held) throw new QnapRefusal('login_held', held.message, 409)
    const hit = this.cache.get(id)
    const age = hit ? this.d.now() - hit.at : Infinity
    if (hit && age < (o.fresh ? 5_000 : CACHE_MS)) return hit.reading
    const running = this.inflight.get(id)
    if (running) return running
    const p = (async () => {
      const { client } = await this.client(id, 'read')
      try {
        const reading = await client.read(new Date(this.d.now()))
        this.cache.set(id, { at: this.d.now(), reading })
        return reading
      } catch (e) { return this.hold(id, e) }
    })()
    this.inflight.set(id, p)
    try { return await p } finally { this.inflight.delete(id) }
  }

  // ── actions ────────────────────────────────────────────────────────────────

  async auditRefusal(id: string, actor: Actor | null, req: ActionRequest, code: string): Promise<void> {
    await this.d.audit('qnap.action', `qnap:${String(id).replace(/[^a-z0-9]/gi, '').slice(0, 20)}`, {
      by: actor?.email ?? 'anonymous', via: actor?.token ? `api:${actor.token}` : actor ? 'session' : 'none',
      action: typeof req.action === 'string' ? req.action.slice(0, 20) : '', result: `refused:${code}`,
    })
  }

  async act(id: string, req: ActionRequest, actor: Actor, secure: boolean): Promise<{ ok: true; message: string; action: string }> {
    let m: QnapMeta
    try { m = await this.meta(id) } catch (e: any) { await this.auditRefusal(id, actor, req, e?.code ?? 'error'); throw e }
    const action = typeof req.action === 'string' ? req.action.slice(0, 20) : ''
    const base = { by: actor.email, via: actor.token ? `api:${actor.token}` : 'session', nas: m.name, nasId: m.id, action }
    const refuse = async (e: QnapRefusal): Promise<never> => {
      await this.d.audit('qnap.action', `qnap:${m.id}`, { ...base, result: `refused:${e.code}` })
      throw e
    }
    try { this.limit(actor, 'attemptsPerMinute', 'Too many attempts in a minute; wait a moment.') } catch (e: any) { return refuse(e) }

    if (action === 'smart_test') {
      if (secure) return refuse(new QnapRefusal('not_security', 'A SMART test is an everyday action; use the normal route.', 409))
      if (!hasRole(actor.role, 'operator')) return refuse(new QnapRefusal('forbidden', 'SMART tests need the operator role.', 403))
      const bay = Number(req.bay)
      if (!Number.isInteger(bay) || bay < 1 || bay > 255) return refuse(new QnapRefusal('bad_input', 'Name the disk by its bay number.'))
      try { this.limit(actor, 'normalPerMinute', 'That is the most SMART tests allowed in a minute.') } catch (e: any) { return refuse(e) }
      if (this.blocked.has(m.id)) return refuse(new QnapRefusal('login_held', this.blocked.get(m.id)!.message, 409))
      // The bay must be one the NAS reports: a reading from the last 20 seconds, or a new one.
      let r: QnapReading
      try { r = await this.reading(m.id) } catch (e: any) { return refuse(new QnapRefusal('unreachable', e?.message ?? 'The NAS could not be read.', 502)) }
      if (!r.disks.some(d => d.bay === bay && (d.model || d.sizeBytes))) return refuse(new QnapRefusal('bad_input', `${m.name} reports no disk in bay ${bay}.`, 404))
      let out
      try { const { client } = await this.client(m.id, 'action'); out = await client.smartTest(bay) }
      catch (e: any) {
        const msg = e instanceof QnapUnreachableError || e instanceof QnapLoginError ? e.message : 'The NAS did not accept the request.'
        await this.d.audit('qnap.action', `qnap:${m.id}`, { ...base, bay, result: 'failed', reason: msg })
        if (e instanceof QnapLoginError) this.hold(m.id, e)
        throw new QnapRefusal('call_failed', msg, 502)
      }
      this.cache.delete(m.id)
      const status = out.disk?.lastTest.status
      const message = !out.answer.accepted
        ? `${m.name} did not accept the SMART test on disk ${bay} (${out.answer.detail}). This firmware may not offer it through its API; Storage Manager on the NAS can run one.`
        : `Quick SMART test started on disk ${bay} of ${m.name}. It takes a few minutes; ${status ? `the NAS now reports "${status}".` : 'refresh to see its result.'}`
      await this.d.audit('qnap.action', `qnap:${m.id}`, { ...base, bay, result: out.answer.accepted ? 'done' : 'unconfirmed', detail: out.answer.detail })
      return { ok: true, message, action }
    }

    if (action === 'restart' || action === 'shutdown') {
      if (!secure) return refuse(new QnapRefusal('security_action', `${POWER_WORD[action]} is a security action: it needs the confirm step.`, 409))
      if (actor.token) return refuse(new QnapRefusal('token_forbidden', 'API tokens can never restart or shut down a NAS.', 403))
      if (!hasRole(actor.role, 'admin')) return refuse(new QnapRefusal('forbidden', 'Restarting or shutting down a NAS needs the admin role.', 403))
      try { this.limit(actor, 'securityPerMinute', 'That is the most power actions allowed in a minute.') } catch (e: any) { return refuse(e) }
      const typed = typeof req.typed === 'string' ? req.typed.trim().toLowerCase() : ''
      if (req.confirm !== confirmPhrase(action, m.name) || typed !== m.name.toLowerCase()) {
        return refuse(new QnapRefusal('confirm_required', 'Confirm the action and type the NAS\'s name exactly as shown.', 409))
      }
      if (this.blocked.has(m.id)) return refuse(new QnapRefusal('login_held', this.blocked.get(m.id)!.message, 409))
      const { how, cluster } = await this.reachOf(m.id)
      let answer
      try { const { client } = await this.client(m.id, 'action'); answer = await client.power(action) }
      catch (e: any) {
        const msg = e instanceof QnapUnreachableError || e instanceof QnapLoginError ? e.message : 'The NAS did not accept the request.'
        await this.d.audit('qnap.action', `qnap:${m.id}`, { ...base, result: 'failed', reason: msg })
        await this.notify(m, action, actor, false, how === 'cluster' ? cluster?.name ?? null : null)
        if (e instanceof QnapLoginError) this.hold(m.id, e)
        throw new QnapRefusal('call_failed', msg, 502)
      }
      this.cache.delete(m.id)
      await this.d.audit('qnap.action', `qnap:${m.id}`, { ...base, result: answer.accepted ? 'done' : 'unconfirmed', detail: answer.detail })
      await this.notify(m, action, actor, answer.accepted, how === 'cluster' ? cluster?.name ?? null : null)
      const message = answer.accepted
        ? (action === 'restart' ? `${m.name} is restarting. It is usually back in 3 to 10 minutes.` : `${m.name} is shutting down. Someone has to press its power button to start it again.`)
        : `${m.name} did not confirm the ${action} (${answer.detail}). Check it before trying again.`
      return { ok: true, message, action }
    }

    return refuse(new QnapRefusal('action_not_allowed', 'HyperProx offers refresh, a quick SMART test, restart and shut down. Nothing that deletes data.'))
  }

  private async notify(m: QnapMeta, action: PowerAction, actor: Actor, ok: boolean, remote: string | null): Promise<void> {
    if (!this.d.publish) return
    await this.d.publish({
      type: 'alert.qnap.power', severity: 'warning',
      title: ok ? `${POWER_WORD[action]}: ${m.name}` : `${POWER_WORD[action]} of ${m.name} did not go through`,
      lines: [`By ${actor.email}.`, ...(remote ? [`Beside ${remote}.`] : [])],
      plain: [m.name], link: '/plugins/qnap', where: 'QNAP plug-in', subject: { kind: 'nas', name: m.name },
    }).catch(() => {})
  }
}
