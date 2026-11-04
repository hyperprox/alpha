// =============================================================================
//  HyperProx — Proxy writes: preview, then apply, then re-read
//
//  A write is two calls. `preview` reads the proxy, refuses what must not be
//  done (a read-only host, a name another host on that proxy already serves,
//  a change that changes nothing), and returns a server-held plan: every field
//  that changes and what that means, in words. An update is a patch: the
//  fields given are laid over the host as it is, and nothing else changes.
//  `apply` takes only that plan's id. It reads the host again first; if
//  anything about it changed since the preview, nothing is done. Then the
//  write, then a re-read compared field by field with the plan. A provider
//  that says OK while the host is not what was planned is a failure.
// =============================================================================

import { randomUUID, createHash } from 'node:crypto'
import { fieldChanges, differences, mergeSpec, parseHostPatch, parseHostSpec, specOf, words } from './spec'
import type { ProxyService, Actor } from './service'
import { KIND_LABEL, ProxyRefusal, type FieldChange, type HostSpec, type ProxyHostRecord, type ProxyInstance } from './types'

export type PlanAction = 'create' | 'update' | 'delete' | 'enable' | 'disable'

export interface PlanRequest { action: PlanAction; hostId?: string; host?: unknown }

export interface ProxyPlan {
  id:           string
  instanceId:   string
  instanceName: string
  action:       PlanAction
  hostId:       string | null
  spec:         HostSpec | null
  before:       ProxyHostRecord | null
  /** Field by field, for an update: from = the host now, to = the plan. */
  fields:       FieldChange[]
  changes:      string[]
  consequences: string[]
  warnings:     string[]
  createdBy:    string
  createdAt:    string
  expiresAt:    string
}

export interface ApplyResult {
  ok:        boolean
  planId:    string
  hostId:    string | null
  /** The host as read back after the write (null after a delete, or when nothing was made). */
  after:     ProxyHostRecord | null
  /** Differences between the plan and what the proxy now has; empty when verified. */
  mismatch:  string[]
  message:   string
  /** When a create failed part-way and left a host behind: a preview that removes exactly that host. */
  cleanup?:  ProxyPlan
}

const TTL_MS = 10 * 60_000

/** Keys sorted, so the same object always hashes the same. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().filter(k => (v as any)[k] !== undefined).map(k => `${JSON.stringify(k)}:${stable((v as any)[k])}`).join(',')}}`
  return JSON.stringify(v ?? null)
}

/** The whole host as the proxy holds it (its `state`), or every compared field when a provider gives none. */
function fp(h: ProxyHostRecord | null): string {
  if (!h) return 'none'
  const basis = h.state ?? { domains: [...h.domains].sort(), s: h.forwardScheme, h: h.forwardHost, p: h.forwardPort, e: h.enabled, w: h.websockets, o: h.options }
  return createHash('sha256').update(stable(basis)).digest('hex')
}

const target = (s: { forwardScheme: string; forwardHost: string; forwardPort: number }) => `${s.forwardScheme}://${s.forwardHost}:${s.forwardPort}`

export class ProxyPlanner {
  private plans = new Map<string, ProxyPlan & { fingerprint: string }>()
  constructor(private svc: ProxyService, private now: () => number = Date.now) {}

  private sweep() { const t = this.now(); for (const [k, p] of this.plans) if (Date.parse(p.expiresAt) < t) this.plans.delete(k) }

  private store(p: Omit<ProxyPlan, 'id' | 'createdAt' | 'expiresAt'>, fingerprint: string): ProxyPlan {
    const plan = { ...p, id: randomUUID(), createdAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + TTL_MS).toISOString(), fingerprint }
    this.plans.set(plan.id, plan)
    const { fingerprint: _f, ...pub } = plan
    return pub
  }

  async preview(instanceId: string, req: PlanRequest, actor: Actor): Promise<ProxyPlan> {
    this.sweep()
    const { instance, provider } = await this.svc.provider(instanceId)
    const action = req.action
    if (!['create', 'update', 'delete', 'enable', 'disable'].includes(action)) throw new ProxyRefusal('The action is create, update, delete, enable or disable.', 400)
    const hosts = await provider.listHosts()
    const label = `${KIND_LABEL[instance.kind]} "${instance.name}"`
    let before: ProxyHostRecord | null = null
    let spec: HostSpec | null = null
    let fields: FieldChange[] = []
    const changes: string[] = []
    const consequences: string[] = []
    const warnings: string[] = []

    if (action !== 'create') {
      before = hosts.find(h => h.id === req.hostId) ?? null
      if (!before) throw new ProxyRefusal(`${label} has no host "${req.hostId}".`, 404)
      if (!before.owned) throw new ProxyRefusal(`${before.domains.join(', ') || before.id} on ${label} is read-only: ${before.readOnlyReason ?? 'it was made outside HyperProx'}. HyperProx never rewrites it.`)
    }
    if (action === 'create') spec = parseHostSpec(req.host)
    if (action === 'update') {
      const patch = parseHostPatch(req.host)
      if (instance.kind !== 'npm') delete patch.npm
      spec = mergeSpec(before!, patch)
    }
    if (spec) {
      if (instance.kind !== 'npm') delete spec.npm
      if (!provider.capabilities.multiDomain && spec.domains.length > 1) throw new ProxyRefusal(`${KIND_LABEL[instance.kind]} hosts have one name each.`, 400)
      for (const d of spec.domains) {
        const clash = hosts.find(h => h.id !== before?.id && h.domains.includes(d))
        if (clash) throw new ProxyRefusal(`${d} is already served by ${clash.owned ? 'another host' : 'a read-only host'} on ${label} (${clash.id}).`)
      }
      // The same name on another instance is allowed (a second proxy may serve it on the LAN), but said.
      const elsewhere = await this.svc.allHosts().catch(() => ({ hosts: [], errors: [] }))
      for (const d of spec.domains) {
        const other = elsewhere.hosts.find(h => h.instanceId !== instance.id && h.domains.includes(d))
        if (other) warnings.push(`${d} is also on ${KIND_LABEL[other.kind]} "${other.instanceName}". Only the proxy its DNS points at will answer for it.`)
      }
    }

    switch (action) {
      case 'create':
        changes.push(`Add a host on ${label}: ${spec!.domains.join(', ')} → ${target(spec!)}${spec!.enabled ? '' : ' (disabled)'}`)
        consequences.push(spec!.enabled ? `${label} starts answering for ${spec!.domains.join(', ')}.` : 'Nothing is served until the host is enabled.')
        break
      case 'update': {
        const b = before!, s = spec!
        fields = fieldChanges(s, b)
        if (!fields.length) throw new ProxyRefusal('Nothing would change.', 400)
        const certs = fields.some(f => f.field === 'npm.certificate_id') ? await provider.listCertificates().catch(() => []) : []
        const certWords = (v: unknown) => {
          if (v === false || v === 0 || v === null) return 'none'
          const c = certs.find(x => x.id === String(v))
          return c ? `#${v} ${c.names[0] ?? ''}`.trim() : `#${v}`
        }
        for (const f of fields) {
          if (f.field === 'npm.certificate_id') changes.push(`certificate: ${certWords(f.from)} → ${certWords(f.to)}`)
          else if (f.field === 'npm.advanced_config') changes.push(`advanced config: ${f.from ? 'replaced' : 'set'}${f.to ? '' : ' to empty'}`)
          else changes.push(`${f.label}: ${words(f.from)} → ${words(f.to)}`)
        }
        const lost = (k: string) => fields.some(f => f.field === k && f.from !== false && f.from !== '' && f.to === false)
        if (lost('npm.certificate_id')) warnings.push(`The certificate is taken off: ${b.domains.join(', ')} will be served over plain HTTP, and browsers that remember HSTS will refuse it.`)
        if (lost('npm.ssl_forced')) warnings.push('HTTPS is no longer forced: visitors can reach the site over plain HTTP.')
        if (lost('npm.hsts_enabled')) warnings.push('HSTS is turned off for this host.')
        if (lost('npm.http2_support')) warnings.push('HTTP/2 is turned off for this host.')
        if (fields.some(f => f.field === 'npm.advanced_config')) warnings.push('The advanced configuration is replaced as a whole.')
        const dropped = b.domains.filter(x => !s.domains.includes(x))
        if (dropped.length) consequences.push(`${dropped.join(', ')} stop${dropped.length === 1 ? 's' : ''} being answered by ${label}.`)
        if (target(s) !== target(b)) consequences.push(`Traffic moves from ${target(b)} to ${target(s)}.`)
        consequences.push(`Only the fields listed change on ${label}; everything else about the host stays as it is.`)
        break
      }
      case 'delete':
        changes.push(`Remove ${before!.domains.join(', ')} from ${label}`)
        consequences.push(`${before!.domains.join(', ')} stop${before!.domains.length === 1 ? 's' : ''} being answered by ${label}. This cannot be undone; the host would have to be created again.`)
        break
      case 'enable':
      case 'disable':
        if (before!.enabled === (action === 'enable')) throw new ProxyRefusal(`The host is already ${before!.enabled ? 'enabled' : 'disabled'}.`, 400)
        changes.push(`${action === 'enable' ? 'Enable' : 'Disable'} ${before!.domains.join(', ')} on ${label}`)
        consequences.push(action === 'enable' ? `${label} serves ${before!.domains.join(', ')} again.` : provider.capabilities.disabledMeans)
        break
    }

    return this.store({
      instanceId: instance.id, instanceName: instance.name, action, hostId: before?.id ?? null, spec, before,
      fields, changes, consequences, warnings, createdBy: actor.email,
    }, action === 'create' ? fp(null) : fp(before))
  }

  async apply(planId: string, actor: Actor): Promise<ApplyResult> {
    this.sweep()
    const plan = this.plans.get(planId)
    if (!plan) throw new ProxyRefusal('That preview has expired or was already used; preview the change again.', 410)
    if (plan.createdBy !== actor.email) throw new ProxyRefusal('That preview belongs to someone else.', 403)
    this.plans.delete(planId)   // single use, whatever happens next
    const { instance, provider, owned } = await this.svc.provider(plan.instanceId)
    const hosts = await provider.listHosts()

    // Concurrency: the host must still be exactly what the preview saw, every field of it.
    if (plan.action === 'create') {
      for (const d of plan.spec!.domains) if (hosts.some(h => h.domains.includes(d))) {
        throw new ProxyRefusal(`${d} appeared on ${instance.name} after the preview; nothing was changed.`)
      }
    } else {
      const now = hosts.find(h => h.id === plan.hostId) ?? null
      if (fp(now) !== plan.fingerprint) throw new ProxyRefusal(`The host changed on ${instance.name} after the preview; nothing was changed. Preview again.`)
      if (now && !now.owned) throw new ProxyRefusal('The host is read-only; nothing was changed.')
    }

    let hostId = plan.hostId
    let expect: HostSpec | null = plan.spec
    try {
      switch (plan.action) {
        case 'create':
          hostId = await provider.createHost(plan.spec!)
          owned.add(hostId)
          await this.svc.recordOwned(instance.id, hostId, true)
          break
        case 'update': await provider.updateHost(plan.hostId!, plan.spec!); break
        case 'delete': await provider.deleteHost(plan.hostId!); expect = null; break
        case 'enable':
        case 'disable':
          await provider.setEnabled(plan.hostId!, plan.action === 'enable')
          expect = { ...specOf(plan.before!), enabled: plan.action === 'enable' }
          break
      }
    } catch (e: any) {
      this.svc.invalidate(instance.id)
      await this.svc.audit(`proxy.host.${plan.action}`, `proxy:${instance.id}/${hostId ?? 'new'}`, { by: actor.email, ok: false, error: e.message, names: plan.spec?.domains ?? plan.before?.domains })
      if (plan.action === 'create') return this.afterFailedCreate(plan, instance, hosts, e, actor)
      throw e
    }
    this.svc.invalidate(instance.id)
    if (plan.action === 'delete') await this.svc.recordOwned(instance.id, plan.hostId!, false)

    // Outcome, not self-report: read the proxy again and compare every planned field.
    const after = (await provider.listHosts()).find(h => h.id === hostId) ?? null
    let mismatch: string[]
    if (expect === null) mismatch = after ? [`${hostId} is still on ${instance.name}`] : []
    else if (!after) mismatch = [`${instance.name} has no host ${hostId} after the write`]
    else mismatch = differences(expect, after)
    const ok = mismatch.length === 0
    await this.svc.audit(`proxy.host.${plan.action}`, `proxy:${instance.id}/${hostId}`, { by: actor.email, ok, mismatch, names: expect?.domains ?? plan.before?.domains })
    return {
      ok, planId, hostId, after, mismatch,
      message: ok ? `Done, and read back from ${instance.name}: ${plan.changes.join('; ')}.`
        : `The write was sent, but ${instance.name} does not show what was planned: ${mismatch.join('; ')}.`,
    }
  }

  /**
   * A create that failed: say exactly what now exists on the proxy for the planned names, and if something was
   * made, offer a preview that removes that host and nothing else.
   */
  private async afterFailedCreate(plan: ProxyPlan, instance: ProxyInstance, before: ProxyHostRecord[], e: any, actor: Actor): Promise<ApplyResult> {
    const { provider, owned } = await this.svc.provider(instance.id)
    const known = new Set(before.map(h => h.id))
    let now: ProxyHostRecord[] = []
    try { now = await provider.listHosts() }
    catch (le: any) {
      return { ok: false, planId: plan.id, hostId: null, after: null, mismatch: [],
        message: `The create failed (${e.message}), and ${instance.name} could not be read afterwards (${le.message}): check it for ${plan.spec!.domains.join(', ')}.` }
    }
    const made = now.find(h => !known.has(h.id) && h.domains.some(d => plan.spec!.domains.includes(d))) ?? null
    if (!made) {
      return { ok: false, planId: plan.id, hostId: null, after: null, mismatch: [], message: `The create failed and nothing was made on ${instance.name}: ${e.message}` }
    }
    // It was not there before this apply, so HyperProx made it: record it, so the clean-up may remove it.
    if (!made.owned) { owned.add(made.id); await this.svc.recordOwned(instance.id, made.id, true) }
    const after = (await provider.listHosts().catch(() => now)).find(h => h.id === made.id) ?? made
    if (!after.owned) {
      return { ok: false, planId: plan.id, hostId: made.id, after, mismatch: [],
        message: `The create failed part-way (${e.message}). ${instance.name} now has ${made.domains.join(', ')} (${made.id}); HyperProx cannot remove it from here.` }
    }
    const cleanup = this.store({
      instanceId: instance.id, instanceName: instance.name, action: 'delete', hostId: after.id, spec: null, before: after, fields: [],
      changes: [`Remove ${after.domains.join(', ')} (${after.id}) from ${KIND_LABEL[instance.kind]} "${instance.name}": the host the failed create left behind`],
      consequences: ['Only that host is removed; nothing else on the proxy changes.'], warnings: [], createdBy: actor.email,
    }, fp(after))
    return {
      ok: false, planId: plan.id, hostId: after.id, after, mismatch: [], cleanup,
      message: `The create failed part-way (${e.message}). ${instance.name} now has ${after.domains.join(', ')} → ${target(after)} ` +
        `(${after.id}, ${after.enabled ? 'enabled' : 'disabled'}). Apply the clean-up to remove only that host.`,
    }
  }

  /** For tests. */
  get size() { return this.plans.size }
}
