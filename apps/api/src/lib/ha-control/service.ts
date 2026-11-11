// =============================================================================
//  HyperProx — Home Assistant control: the service
//
//  What a tap on a control goes through, in order:
//    1. the instance exists, and (on a cluster's page) belongs to that cluster;
//    2. the entity is read FRESH from that house (never from a cache): it must
//       exist, be of a kind HyperProx controls, and its tier is decided from the
//       state and attributes it has right now;
//    3. the person may act: everyday controls need the instance's role (operator
//       by default); the security tier needs admin, a person (never an API
//       token), the master password re-entered (the gate checks that on the
//       secure route);
//    4. the rate limit for this session (before any phrase is compared);
//    5. the allow-list turns (domain, action, value) into one service call with
//       its value checked against the entity's own range or list;
//    6. for the security tier: the confirm phrase, built from the checked value,
//       and the device's name typed by the person, both compared here;
//    7. the call, then a read-back of the real state, said plainly when the
//       device did not change;
//    8. an audit row for every outcome, refusals included (who, instance,
//       entity, action, result — never the token), and for the security tier an
//       optional notification (refusals too, at most one per house per 10 min).
// =============================================================================

import {
  ActionRefusal, CONTROLLABLE, ENTITY_ID, actionPhrase, buildServiceCall, confirmPhrase, confirmTemplate, controlsFor,
  displayState, domainOf, nameOf, readBackMatches, tierOf, typedMatches, type Control, type HAState, type Tier,
} from './catalog'
import { HAUnreachableError, HttpHAClient, type HAClient, type HAConnection, type HARegistry } from './client'
import type { InstanceMeta, InstanceStore } from './instances'
import { hasRole, type Role } from '../roles'
import { buildHealthDetail } from '../../plugins/home-assistant'
import type { PluginDetail } from '../plugin-host'

export interface Actor {
  sid:   string
  email: string
  role:  Role
  /** The API token's name when the request used one. */
  token: string | null
}

export interface ActionRequest { entityId?: unknown; action?: unknown; value?: unknown; confirm?: unknown; typed?: unknown }

export interface ActionResult {
  ok:        boolean
  changed:   boolean
  entityId:  string
  name:      string
  action:    string
  tier:      Tier
  before:    { state: string }
  after:     { state: string } | null
  message:   string
}

export interface DeviceRow {
  entityId:    string
  name:        string
  domain:      string
  tier:        Tier
  unavailable: boolean
  /** Hidden ("hidden") from viewers on security devices. */
  state:       string
  unit?:       string
  deviceClass?: string
  /** On security devices, `confirm` is the phrase to type-check, with "{value}" where a slider or list value goes. */
  controls:    Array<Control & { confirm?: string }>
}

export interface ClusterRef { id: string; name: string; kind: 'home' | 'remote' }

export type PublishFn = (e: { type: string; severity: 'info' | 'warning' | 'critical'; title: string; lines?: string[]; plain?: string[]; link?: string; where?: string; fingerprint?: string }) => Promise<void>

export interface ServiceDeps {
  store:     InstanceStore
  clientFor?: (c: HAConnection) => HAClient
  audit:     (action: string, resource: string, details: Record<string, unknown>) => Promise<void>
  publish?:  PublishFn
  cluster?:  (id: string) => ClusterRef | null
  now?:      () => number
  sleep?:    (ms: number) => Promise<void>
  /** Read-back: how many times, and how far apart. */
  readBack?: { tries: number; everyMs: number }
  limits?:   { normalPerMinute: number; securityPerMinute: number; devicesPerMinute: number }
  /** How long one house's device list is served from memory, so several open pages cost one read. */
  devicesCacheMs?: number
}

const REFUSAL_NOTIFY_MS = 10 * 60_000

export class HAControlService {
  private devicesCache = new Map<string, { at: number; states: HAState[] }>()
  private registryCache = new Map<string, { at: number; reg: HARegistry | null }>()
  private hits = new Map<string, number[]>()
  private hitCalls = 0
  private refusalNotified = new Map<string, number>()
  private d: Required<Omit<ServiceDeps, 'publish' | 'cluster'>> & Pick<ServiceDeps, 'publish' | 'cluster'>

  constructor(deps: ServiceDeps) {
    this.d = {
      clientFor: c => new HttpHAClient(c),
      now: () => Date.now(),
      sleep: ms => new Promise(r => setTimeout(r, ms)),
      readBack: { tries: 6, everyMs: 500 },
      devicesCacheMs: 2_000,
      ...deps,
      limits: { normalPerMinute: 30, securityPerMinute: 5, devicesPerMinute: 40, ...(deps.limits ?? {}) },
    }
  }

  // --- Instances -------------------------------------------------------------------------------

  get instances(): InstanceStore { return this.d.store }

  private async instance(id: string, clusterScope: string | null): Promise<InstanceMeta> {
    const m = await this.d.store.get(id)
    if (!m) throw new ActionRefusal('no_instance', 'No such Home Assistant instance.', 404)
    // A cluster's page acts only on the houses linked to that cluster.
    if (clusterScope && m.clusterId !== clusterScope) {
      throw new ActionRefusal('wrong_cluster', `${m.name} is not linked to this cluster.`, 409)
    }
    return m
  }

  private async client(m: InstanceMeta): Promise<HAClient> {
    const c = await this.d.store.connection(m.id)
    if (!c) throw new ActionRefusal('not_configured', `${m.name} has no address or token yet.`, 409)
    return this.d.clientFor(c)
  }

  clusterOf(m: InstanceMeta): ClusterRef | null {
    return m.clusterId && this.d.cluster ? this.d.cluster(m.clusterId) : null
  }

  async status(id: string, clusterScope: string | null = null) {
    const m = await this.instance(id, clusterScope)
    let ha: HAClient
    try { ha = await this.client(m) } catch (e: any) { return { reachable: false, error: e.message, version: null, location: null, user: null } }
    try {
      const cfg = await ha.config()
      const user = await ha.currentUser().catch(() => null)
      return {
        reachable: true, error: null,
        version:  typeof cfg?.version === 'string' ? cfg.version.slice(0, 32) : null,
        location: typeof cfg?.location_name === 'string' ? cfg.location_name.slice(0, 80) : null,
        // Long-lived tokens carry the whole user. An admin user here can change Home Assistant itself.
        user,
      }
    } catch (e: any) {
      return { reachable: false, error: e instanceof HAUnreachableError ? e.message : 'Home Assistant could not be read.', version: null, location: null, user: null }
    }
  }

  async health(id: string, warn = 20, clusterScope: string | null = null): Promise<PluginDetail> {
    const m = await this.instance(id, clusterScope)
    const ha = await this.client(m)
    const [states, config, log] = await Promise.all([ha.states(), ha.config().catch(() => ({})), ha.errorLog()])
    return buildHealthDetail(states, config, log, warn)
  }

  // --- Devices ---------------------------------------------------------------------------------

  private async registry(m: InstanceMeta, ha: HAClient): Promise<HARegistry | null> {
    const hit = this.registryCache.get(m.id)
    if (hit && this.d.now() - hit.at < 60_000) return hit.reg
    const reg = await ha.registry().catch(() => null)
    this.registryCache.set(m.id, { at: this.d.now(), reg })
    return reg
  }

  /**
   * The Devices view. `viewer` hides the live state and controls of security devices. `actor` rate-limits
   * polling per session; one house's list is read at most once per devicesCacheMs however many pages are open.
   */
  async devices(id: string, clusterScope: string | null = null, opts: { viewer?: boolean; actor?: Actor } = {}) {
    const m = await this.instance(id, clusterScope)
    if (opts.actor) this.rate(opts.actor, 'devices', this.d.limits.devicesPerMinute, 'Too many refreshes; wait a moment.')
    const ha = await this.client(m)
    let hit = this.devicesCache.get(m.id)
    if (!hit || this.d.now() - hit.at >= this.d.devicesCacheMs) {
      hit = { at: this.d.now(), states: await ha.states() }
      this.devicesCache.set(m.id, hit)
    }
    const states = hit.states
    const reg = await this.registry(m, ha)

    const areaName = new Map(reg?.areas.map(a => [a.area_id, a.name]) ?? [])
    const deviceArea = new Map(reg?.devices.map(d => [d.id, d.area_id]) ?? [])
    const entityReg = new Map(reg?.entities.map(e => [e.entity_id, e]) ?? [])

    const groups = new Map<string, DeviceRow[]>()
    for (const s of states) {
      const domain = domainOf(s.entity_id)
      if (!CONTROLLABLE.has(domain) || !ENTITY_ID.test(s.entity_id)) continue
      const er = entityReg.get(s.entity_id)
      if (er?.hidden) continue
      const areaId = er?.area_id ?? (er?.device_id ? deviceArea.get(er.device_id) ?? null : null)
      const area = (areaId && areaName.get(areaId)) || 'No area'
      const tier = tierOf(s, m.policy)
      const unavailable = s.state === 'unavailable' || (s.state === 'unknown' && !['scene', 'script', 'button'].includes(domain))
      const hide = opts.viewer && tier === 'security'
      const controls = hide ? [] : controlsFor(s).map(c => tier === 'security' ? { ...c, confirm: confirmTemplate(s, c.action, m.name) } : c)
      const shown = displayState(s)
      const row: DeviceRow = {
        entityId: s.entity_id, name: nameOf(s), domain, tier, unavailable,
        ...(hide ? { state: 'hidden', ...(shown.deviceClass ? { deviceClass: shown.deviceClass } : {}) } : shown), controls,
      }
      groups.set(area, [...(groups.get(area) ?? []), row])
    }
    const areas = [...groups.entries()]
      .sort((a, b) => (a[0] === 'No area' ? 1 : 0) - (b[0] === 'No area' ? 1 : 0) || a[0].localeCompare(b[0]))
      .map(([name, devices]) => ({ name, devices: devices.sort((x, y) => x.name.localeCompare(y.name)) }))

    // A protected device that was renamed in Home Assistant silently stops being protected: say so.
    const ids = new Set(states.map(s => s.entity_id))
    const warnings = opts.viewer ? [] : [
      ...m.policy.protected.filter(e => !ids.has(e)).map(e => `Protected device ${e} no longer exists in ${m.name}; it may have been renamed. Protect its new id in Settings.`),
      ...m.policy.everyday.filter(e => !ids.has(e)).map(e => `Everyday device ${e} no longer exists in ${m.name}; remove it from Settings.`),
    ]
    return { areas, warnings, areaSource: reg ? 'registry' : 'none', fetchedAt: new Date(hit.at).toISOString() }
  }

  // --- Actions ---------------------------------------------------------------------------------

  /** Sliding one-minute window per session and bucket. Old sessions are pruned as the map grows. */
  private rate(actor: Actor, bucket: string, max: number, message: string): void {
    const key = `${actor.sid}:${bucket}`
    const now = this.d.now()
    if (++this.hitCalls % 100 === 0 || this.hits.size > 1000) {
      for (const [k, v] of this.hits) if (!v.some(t => now - t < 60_000)) this.hits.delete(k)
    }
    const recent = (this.hits.get(key) ?? []).filter(t => now - t < 60_000)
    if (recent.length >= max) {
      this.hits.set(key, recent)
      throw new ActionRefusal('rate_limited', message, 429)
    }
    recent.push(now)
    this.hits.set(key, recent)
  }

  /** Audit a refusal that happened before the house was known (or that the gate made). */
  async auditRefusal(instanceId: string, actor: Actor | null, req: ActionRequest, code: string): Promise<void> {
    await this.d.audit('ha.action', `home-assistant:${String(instanceId).replace(/[^a-z0-9]/gi, '').slice(0, 20)}`, {
      by: actor?.email ?? 'anonymous', via: actor?.token ? `api:${actor.token}` : actor ? 'session' : 'none',
      entity: typeof req.entityId === 'string' ? req.entityId.slice(0, 160) : '', action: typeof req.action === 'string' ? req.action.slice(0, 40) : '',
      tier: 'unknown', result: `refused:${code}`,
    })
  }

  private async notifyRefusal(m: InstanceMeta, actor: Actor, entity: string, code: string): Promise<void> {
    if (!m.policy.notifySecurity || !this.d.publish) return
    const now = this.d.now()
    if (now - (this.refusalNotified.get(m.id) ?? -Infinity) < REFUSAL_NOTIFY_MS) return
    this.refusalNotified.set(m.id, now)
    await this.d.publish({
      type: 'ha.security.refused', severity: 'warning',
      title: `A security action at ${m.name} was refused`,
      lines: [`${entity} (${code}), by ${actor.token ? `API token ${actor.token}` : actor.email}.`, 'Further refusals at this house are not sent for 10 minutes; all of them are in the audit log.'],
      plain: [m.name, entity], link: '/plugins/home-assistant', where: 'Home Assistant plug-in',
    }).catch(() => {})
  }

  /**
   * One action. `secure` says which route it came in on: the everyday route refuses security-tier entities,
   * the secure route refuses everything else, so each tier has exactly one way in.
   */
  async act(id: string, req: ActionRequest, actor: Actor, secure: boolean, clusterScope: string | null = null): Promise<ActionResult> {
    let m: InstanceMeta
    try { m = await this.instance(id, clusterScope) } catch (e: any) {
      await this.auditRefusal(id, actor, req, e?.code ?? 'error')
      throw e
    }
    const entityId = typeof req.entityId === 'string' ? req.entityId : ''
    const action = typeof req.action === 'string' ? req.action.slice(0, 40) : ''
    const auditBase = { by: actor.email, via: actor.token ? `api:${actor.token}` : 'session', instance: m.name, instanceId: m.id, entity: entityId.slice(0, 160), action }
    const refuse = async (e: ActionRefusal, tier?: Tier): Promise<never> => {
      await this.d.audit('ha.action', `home-assistant:${m.id}`, { ...auditBase, tier: tier ?? 'unknown', result: `refused:${e.code}` })
      if ((tier === 'security' || secure) && ['forbidden', 'token_forbidden', 'confirm_required', 'rate_limited'].includes(e.code)) {
        await this.notifyRefusal(m, actor, entityId.slice(0, 160), e.code)
      }
      throw e
    }

    if (!ENTITY_ID.test(entityId)) return refuse(new ActionRefusal('bad_entity', 'That is not an entity id.'))
    if (!CONTROLLABLE.has(domainOf(entityId))) return refuse(new ActionRefusal('domain_not_allowed', `HyperProx does not control ${domainOf(entityId)} entities.`))

    let ha: HAClient
    try { ha = await this.client(m) } catch (e: any) { return refuse(e) }
    // Read fresh: the tier depends on attributes (a cover's class, a switch's name) that a cache could hold stale.
    let before: HAState | null
    try { before = await ha.state(entityId) } catch (e: any) {
      return refuse(new ActionRefusal('unreachable', e instanceof HAUnreachableError ? e.message : `${m.name} could not be read.`, 502))
    }
    if (!before) return refuse(new ActionRefusal('unknown_entity', `${m.name} has no entity ${entityId}.`, 404))
    const tier = tierOf(before, m.policy)

    // Who may do this, on which route.
    if (tier === 'security') {
      if (!secure) return refuse(new ActionRefusal('security_action', `${nameOf(before)} is a security device: it needs the confirm step.`, 409), tier)
      if (actor.token) return refuse(new ActionRefusal('token_forbidden', 'API tokens can never use security controls.', 403), tier)
      if (!hasRole(actor.role, 'admin')) return refuse(new ActionRefusal('forbidden', 'Security controls need the admin role.', 403), tier)
    } else {
      if (secure) return refuse(new ActionRefusal('not_security', `${nameOf(before)} is an everyday control; use the normal route.`, 409), tier)
      if (!hasRole(actor.role, m.policy.normalRole)) return refuse(new ActionRefusal('forbidden', `Controls on ${m.name} need the ${m.policy.normalRole} role.`, 403), tier)
    }
    // Before any phrase comparison, so the confirm step cannot be guessed at speed.
    try {
      this.rate(actor, tier, tier === 'security' ? this.d.limits.securityPerMinute : this.d.limits.normalPerMinute,
        `That is the most ${tier === 'security' ? 'security actions' : 'actions'} allowed in a minute. Wait a moment and try again.`)
    } catch (e: any) { return refuse(e, tier) }

    let call
    try { call = buildServiceCall(before, action, req.value) } catch (e: any) { return refuse(e, tier) }
    if (before.state === 'unavailable') return refuse(new ActionRefusal('unavailable', `${nameOf(before)} is unavailable in Home Assistant right now.`, 409), tier)

    if (tier === 'security') {
      // Both checks, and neither answer says what the phrase should have been.
      if (req.confirm !== confirmPhrase(before, action, call.shown, m.name) || !typedMatches(before, req.typed)) {
        return refuse(new ActionRefusal('confirm_required', 'Confirm the action and type the device\'s name exactly as shown.', 409), tier)
      }
    }
    const { shown, ...serviceCall } = call

    try { await ha.callService(serviceCall) } catch (e: any) {
      const msg = e instanceof HAUnreachableError ? e.message : 'Home Assistant did not accept the command.'
      await this.d.audit('ha.action', `home-assistant:${m.id}`, { ...auditBase, tier, result: 'failed', reason: msg })
      throw new ActionRefusal('call_failed', msg, 502)
    }
    this.devicesCache.delete(m.id)

    // Read back the real state.
    let after: HAState | null = null
    let changed = false
    for (let i = 0; i < this.d.readBack.tries; i++) {
      await this.d.sleep(this.d.readBack.everyMs)
      after = await ha.state(entityId).catch(() => null)
      if (after && readBackMatches(before, after, action, req.value)) { changed = true; break }
    }
    const what = actionPhrase(before, action, shown)
    const message = changed
      ? `${what}: done. ${nameOf(before)} now reads "${after!.state}".`
      : after
        ? `Home Assistant accepted "${what}", but ${nameOf(before)} still reads "${after.state}". The device may be offline or slow to report.`
        : `Home Assistant accepted "${what}", but ${nameOf(before)} could not be read back.`

    await this.d.audit('ha.action', `home-assistant:${m.id}`, {
      ...auditBase, tier, result: changed ? 'done' : 'unconfirmed',
      value: shown === undefined ? null : String(shown).slice(0, 40),
      stateBefore: before.state.slice(0, 40), stateAfter: after?.state?.slice(0, 40) ?? null,
    })

    if (tier === 'security' && m.policy.notifySecurity && this.d.publish) {
      const cl = this.clusterOf(m)
      await this.d.publish({
        type: 'ha.security.action', severity: 'warning',
        title: `${what} ${nameOf(before)} at ${m.name}`,
        lines: [`By ${actor.email}.`, changed ? `It now reads "${after!.state}".` : 'The device did not confirm the change.', ...(cl ? [`Linked to ${cl.name}.`] : [])],
        plain: [nameOf(before), m.name], link: '/plugins/home-assistant', where: 'Home Assistant plug-in',
      }).catch(() => {})
    }

    return {
      ok: true, changed, entityId, name: nameOf(before), action, tier,
      before: { state: before.state }, after: after ? { state: after.state } : null, message,
    }
  }
}
