// =============================================================================
//  HyperProx — Home Assistant control: the service
//
//  What a tap on a control goes through, in order:
//    1. the instance exists, and (on a cluster's page) belongs to that cluster;
//    2. the person may act: everyday controls need the instance's role (operator
//       by default); the security tier needs admin, a person (never an API
//       token), the master password re-entered (the gate checks that on the
//       secure route), and the confirm phrase naming the device and the house;
//    3. the rate limit for this session;
//    4. the entity is in the instance's CURRENT entity list, in a domain HyperProx
//       controls, and not unavailable;
//    5. the allow-list turns (domain, action, value) into one service call with
//       its value checked against the entity's own range or list;
//    6. the call, then a read-back of the real state, said plainly when the
//       device did not change;
//    7. an audit row (who, instance, entity, action, result — never the token),
//       and for the security tier an optional notification.
// =============================================================================

import {
  ActionRefusal, CONTROLLABLE, ENTITY_ID, actionPhrase, buildServiceCall, confirmPhrase, controlsFor, displayState,
  domainOf, nameOf, readBackMatches, tierOf, type Control, type HAState, type Tier,
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

export interface ActionRequest { entityId?: unknown; action?: unknown; value?: unknown; confirm?: unknown }

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
  state:       string
  unit?:       string
  deviceClass?: string
  controls:    Array<Control & { confirm?: string }>
}

export interface ClusterRef { id: string; name: string; kind: 'home' | 'remote' }

export interface ServiceDeps {
  store:     InstanceStore
  clientFor?: (c: HAConnection) => HAClient
  audit:     (action: string, resource: string, details: Record<string, unknown>) => Promise<void>
  publish?:  (e: { type: string; severity: 'info' | 'warning' | 'critical'; title: string; lines?: string[]; plain?: string[]; link?: string; where?: string; fingerprint?: string }) => Promise<void>
  cluster?:  (id: string) => ClusterRef | null
  now?:      () => number
  sleep?:    (ms: number) => Promise<void>
  /** Read-back: how many times, and how far apart. */
  readBack?: { tries: number; everyMs: number }
  limits?:   { normalPerMinute: number; securityPerMinute: number }
}

export class HAControlService {
  private statesCache = new Map<string, { at: number; states: HAState[] }>()
  private registryCache = new Map<string, { at: number; reg: HARegistry | null }>()
  private hits = new Map<string, number[]>()
  private d: Required<Omit<ServiceDeps, 'publish' | 'cluster'>> & Pick<ServiceDeps, 'publish' | 'cluster'>

  constructor(deps: ServiceDeps) {
    this.d = {
      clientFor: c => new HttpHAClient(c),
      now: () => Date.now(),
      sleep: ms => new Promise(r => setTimeout(r, ms)),
      readBack: { tries: 6, everyMs: 500 },
      limits: { normalPerMinute: 30, securityPerMinute: 5 },
      ...deps,
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
    this.statesCache.set(m.id, { at: this.d.now(), states })
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

  async devices(id: string, clusterScope: string | null = null) {
    const m = await this.instance(id, clusterScope)
    const ha = await this.client(m)
    const states = await ha.states()
    this.statesCache.set(m.id, { at: this.d.now(), states })
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
      const unavailable = s.state === 'unavailable' || s.state === 'unknown' && !['scene', 'script', 'button'].includes(domain)
      const controls = controlsFor(s).map(c => tier === 'security'
        ? { ...c, confirm: c.kind === 'button' ? confirmPhrase(s, c.action, undefined, m.name) : undefined }
        : c)
      const row: DeviceRow = { entityId: s.entity_id, name: nameOf(s), domain, tier, unavailable, ...displayState(s), controls }
      groups.set(area, [...(groups.get(area) ?? []), row])
    }
    const areas = [...groups.entries()]
      .sort((a, b) => (a[0] === 'No area' ? 1 : 0) - (b[0] === 'No area' ? 1 : 0) || a[0].localeCompare(b[0]))
      .map(([name, devices]) => ({ name, devices: devices.sort((x, y) => x.name.localeCompare(y.name)) }))
    return { areas, areaSource: reg ? 'registry' : 'none', fetchedAt: new Date(this.d.now()).toISOString() }
  }

  // --- Actions ---------------------------------------------------------------------------------

  private rate(actor: Actor, tier: Tier): void {
    const key = `${actor.sid}:${tier}`
    const now = this.d.now()
    const recent = (this.hits.get(key) ?? []).filter(t => now - t < 60_000)
    const max = tier === 'security' ? this.d.limits.securityPerMinute : this.d.limits.normalPerMinute
    if (recent.length >= max) {
      this.hits.set(key, recent)
      throw new ActionRefusal('rate_limited', `That is ${max} ${tier === 'security' ? 'security actions' : 'actions'} in a minute. Wait a moment and try again.`, 429)
    }
    recent.push(now)
    this.hits.set(key, recent)
  }

  /** Fresh state list for the check, never older than ten seconds. */
  private async currentStates(m: InstanceMeta, ha: HAClient): Promise<HAState[]> {
    const hit = this.statesCache.get(m.id)
    if (hit && this.d.now() - hit.at < 10_000) return hit.states
    const states = await ha.states()
    this.statesCache.set(m.id, { at: this.d.now(), states })
    return states
  }

  /**
   * One action. `secure` says which route it came in on: the everyday route refuses security-tier entities,
   * the secure route refuses everything else, so each tier has exactly one way in.
   */
  async act(id: string, req: ActionRequest, actor: Actor, secure: boolean, clusterScope: string | null = null): Promise<ActionResult> {
    const m = await this.instance(id, clusterScope)
    const entityId = typeof req.entityId === 'string' ? req.entityId : ''
    const action = typeof req.action === 'string' ? req.action.slice(0, 40) : ''
    const auditBase = { by: actor.email, via: actor.token ? `api:${actor.token}` : 'session', instance: m.name, instanceId: m.id, entity: entityId.slice(0, 160), action }
    const refuse = async (e: ActionRefusal, tier?: Tier): Promise<never> => {
      await this.d.audit('ha.action', `home-assistant:${m.id}`, { ...auditBase, tier: tier ?? 'unknown', result: `refused:${e.code}` })
      throw e
    }

    if (!ENTITY_ID.test(entityId)) return refuse(new ActionRefusal('bad_entity', 'That is not an entity id.'))
    if (!CONTROLLABLE.has(domainOf(entityId))) return refuse(new ActionRefusal('domain_not_allowed', `HyperProx does not control ${domainOf(entityId)} entities.`))

    let ha: HAClient
    try { ha = await this.client(m) } catch (e: any) { return refuse(e) }
    let states: HAState[]
    try { states = await this.currentStates(m, ha) } catch (e: any) {
      return refuse(new ActionRefusal('unreachable', e instanceof HAUnreachableError ? e.message : `${m.name} could not be read.`, 502))
    }
    const before = states.find(s => s.entity_id === entityId)
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

    let call
    try { call = buildServiceCall(before, action, req.value) } catch (e: any) { return refuse(e, tier) }
    if (before.state === 'unavailable') return refuse(new ActionRefusal('unavailable', `${nameOf(before)} is unavailable in Home Assistant right now.`, 409), tier)

    if (tier === 'security') {
      const phrase = confirmPhrase(before, action, req.value, m.name)
      if (req.confirm !== phrase) return refuse(new ActionRefusal('confirm_required', `Confirm first: "${phrase}".`, 409, { confirm: phrase }), tier)
    }
    try { this.rate(actor, tier) } catch (e: any) { return refuse(e, tier) }

    try { await ha.callService(call) } catch (e: any) {
      const msg = e instanceof HAUnreachableError ? e.message : 'Home Assistant did not accept the command.'
      await this.d.audit('ha.action', `home-assistant:${m.id}`, { ...auditBase, tier, result: 'failed', reason: msg })
      throw new ActionRefusal('call_failed', msg, 502)
    }
    this.statesCache.delete(m.id)

    // Read back the real state.
    let after: HAState | null = null
    let changed = false
    for (let i = 0; i < this.d.readBack.tries; i++) {
      await this.d.sleep(this.d.readBack.everyMs)
      after = await ha.state(entityId).catch(() => null)
      if (after && readBackMatches(before, after, action, req.value)) { changed = true; break }
    }
    const what = actionPhrase(before, action, req.value)
    const message = changed
      ? `${what}: done. ${nameOf(before)} now reads "${after!.state}".`
      : after
        ? `Home Assistant accepted "${what}", but ${nameOf(before)} still reads "${after.state}". The device may be offline or slow to report.`
        : `Home Assistant accepted "${what}", but ${nameOf(before)} could not be read back.`

    await this.d.audit('ha.action', `home-assistant:${m.id}`, {
      ...auditBase, tier, result: changed ? 'done' : 'unconfirmed',
      value: typeof req.value === 'number' || typeof req.value === 'string' ? String(req.value).slice(0, 40) : null,
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
