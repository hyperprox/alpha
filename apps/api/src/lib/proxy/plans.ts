// =============================================================================
//  HyperProx — Proxy writes: preview, then apply, then re-read
//
//  A write is two calls. `preview` reads the proxy, refuses what must not be
//  done (a read-only host, a name another host on that proxy already serves),
//  and returns a server-held plan: every change and its consequence in words.
//  `apply` takes only that plan's id. It reads the host again first (a change
//  made in between fails the apply), runs the write, then reads the proxy
//  again and compares what is there with what was planned. A provider that
//  says OK while the host did not change is reported as a failure.
// =============================================================================

import { randomUUID, createHash } from 'node:crypto'
import { differences, parseHostSpec, specOf } from './spec'
import type { ProxyService, Actor } from './service'
import { KIND_LABEL, ProxyRefusal, type HostSpec, type ProxyHostRecord, type ProxyInstance } from './types'

export type PlanAction = 'create' | 'update' | 'delete' | 'enable' | 'disable'

export interface PlanRequest { action: PlanAction; hostId?: string; host?: unknown }

export interface ProxyPlan {
  id:          string
  instanceId:  string
  instanceName: string
  action:      PlanAction
  hostId:      string | null
  spec:        HostSpec | null
  before:      ProxyHostRecord | null
  changes:     string[]
  consequences: string[]
  warnings:    string[]
  createdBy:   string
  createdAt:   string
  expiresAt:   string
}

export interface ApplyResult {
  ok:        boolean
  planId:    string
  hostId:    string | null
  /** The host as read back after the write (null after a delete). */
  after:     ProxyHostRecord | null
  /** Differences between the plan and what the proxy now has; empty when verified. */
  mismatch:  string[]
  message:   string
}

const TTL_MS = 10 * 60_000

function fp(h: ProxyHostRecord | null): string {
  if (!h) return 'none'
  return createHash('sha256').update(JSON.stringify([h.domains.slice().sort(), h.forwardScheme, h.forwardHost, h.forwardPort, h.enabled])).digest('hex')
}

const target = (s: HostSpec) => `${s.forwardScheme}://${s.forwardHost}:${s.forwardPort}`

export class ProxyPlanner {
  private plans = new Map<string, ProxyPlan & { fingerprint: string }>()
  constructor(private svc: ProxyService, private now: () => number = Date.now) {}

  private sweep() { const t = this.now(); for (const [k, p] of this.plans) if (Date.parse(p.expiresAt) < t) this.plans.delete(k) }

  async preview(instanceId: string, req: PlanRequest, actor: Actor): Promise<ProxyPlan> {
    this.sweep()
    const { instance, provider } = await this.svc.provider(instanceId)
    const action = req.action
    if (!['create', 'update', 'delete', 'enable', 'disable'].includes(action)) throw new ProxyRefusal('The action is create, update, delete, enable or disable.', 400)
    const hosts = await provider.listHosts()
    const label = `${KIND_LABEL[instance.kind]} "${instance.name}"`
    let before: ProxyHostRecord | null = null
    let spec: HostSpec | null = null
    const changes: string[] = []
    const consequences: string[] = []
    const warnings: string[] = []

    if (action !== 'create') {
      before = hosts.find(h => h.id === req.hostId) ?? null
      if (!before) throw new ProxyRefusal(`${label} has no host "${req.hostId}".`, 404)
      if (!before.owned) throw new ProxyRefusal(`${before.domains.join(', ') || before.id} on ${label} is read-only: ${before.readOnlyReason ?? 'it was made outside HyperProx'}. HyperProx never rewrites it.`)
    }
    if (action === 'create' || action === 'update') {
      spec = parseHostSpec(req.host)
      if (!provider.capabilities.multiDomain && spec.domains.length > 1) throw new ProxyRefusal(`${KIND_LABEL[instance.kind]} hosts have one name each.`, 400)
      if (spec.npm && instance.kind !== 'npm') delete spec.npm
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
        const diff = differences(s, b)
        if (!diff.length && !s.npm) throw new ProxyRefusal('Nothing would change.', 400)
        for (const line of diff) changes.push(`On ${label}, ${b.domains[0] ?? b.id}: ${line.replace(/, expected /, ' → becomes ')}`)
        if (s.npm) changes.push('NPM options are replaced with the ones in the form.')
        const dropped = b.domains.filter(x => !s.domains.includes(x))
        if (dropped.length) consequences.push(`${dropped.join(', ')} stop${dropped.length === 1 ? 's' : ''} being answered by ${label}.`)
        if (target(s) !== `${b.forwardScheme}://${b.forwardHost}:${b.forwardPort}`) consequences.push(`Traffic moves from ${b.forwardScheme}://${b.forwardHost}:${b.forwardPort} to ${target(s)}.`)
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

    const plan = {
      id: randomUUID(), instanceId: instance.id, instanceName: instance.name, action, hostId: before?.id ?? null, spec, before,
      changes, consequences, warnings, createdBy: actor.email,
      createdAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + TTL_MS).toISOString(),
      fingerprint: action === 'create' ? fp(null) : fp(before),
    }
    this.plans.set(plan.id, plan)
    const { fingerprint: _f, ...pub } = plan
    return pub
  }

  async apply(planId: string, actor: Actor): Promise<ApplyResult> {
    this.sweep()
    const plan = this.plans.get(planId)
    if (!plan) throw new ProxyRefusal('That preview has expired or was already used; preview the change again.', 410)
    if (plan.createdBy !== actor.email) throw new ProxyRefusal('That preview belongs to someone else.', 403)
    this.plans.delete(planId)   // single use, whatever happens next
    const { instance, provider } = await this.svc.provider(plan.instanceId)
    const hosts = await provider.listHosts()

    // Concurrency: the host must still be what the preview saw.
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
        case 'create': hostId = await provider.createHost(plan.spec!); break
        case 'update': await provider.updateHost(plan.hostId!, plan.spec!); break
        case 'delete': await provider.deleteHost(plan.hostId!); expect = null; break
        case 'enable':
        case 'disable':
          await provider.setEnabled(plan.hostId!, plan.action === 'enable')
          expect = { ...specOf(plan.before!), enabled: plan.action === 'enable' }
          break
      }
    } catch (e: any) {
      await this.svc.audit(`proxy.host.${plan.action}`, `proxy:${instance.id}/${hostId ?? 'new'}`, { by: actor.email, ok: false, error: e.message, names: plan.spec?.domains ?? plan.before?.domains })
      throw e
    }

    // Outcome, not self-report: read the proxy again.
    const after = (await provider.listHosts()).find(h => h.id === hostId) ?? null
    let mismatch: string[]
    if (expect === null) mismatch = after ? [`${hostId} is still on ${instance.name}`] : []
    else if (!after) mismatch = [`${instance.name} has no host ${hostId} after the write`]
    else mismatch = differences(expect, after)
    const ok = mismatch.length === 0
    await this.svc.audit(`proxy.host.${plan.action}`, `proxy:${instance.id}/${hostId}`, { by: actor.email, ok, mismatch, names: expect?.domains ?? plan.before?.domains })
    return {
      ok, planId, hostId, after, mismatch,
      message: ok ? `Done, and read back from ${instance.name}: ${plan.changes[0]}.`
        : `The write was sent, but ${instance.name} does not show what was planned: ${mismatch.join('; ')}.`,
    }
  }

  /** For tests. */
  get size() { return this.plans.size }
}

export type { ProxyInstance }
