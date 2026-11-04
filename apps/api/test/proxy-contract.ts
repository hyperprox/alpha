// The ProxyProvider contract: every provider, through the service and the preview → apply → re-read path,
// against recorded fixtures (proxy-contract.test.ts) and live test servers (proxy-live.test.ts).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ProxyService } from '../src/lib/proxy/service'
import { ProxyPlanner } from '../src/lib/proxy/plans'
import type { ProxyHostView } from '../src/lib/proxy/types'

export interface ContractCase {
  label:          string
  service:        () => ProxyService
  instanceId:     string
  /** A host on this proxy that HyperProx did not make. */
  externalDomain: string
  /** Names nothing else uses, unique per run. */
  domain:         string
  secondDomain:   string
  forwardHost:    string
  forwardPort:    number
  multiDomain:    boolean
  /**
   * False for NPM: HyperProx has always driven NPM whole, so its hand-made hosts stay editable (today's
   * behaviour). The name clash is still refused, and the delete test still checks the host is untouched.
   */
  externalReadOnly?: boolean
  /**
   * Live runs: what the proxy answers for the host (optional). 200 means the test backend answered; the
   * proxy's own pages (a default site, a catch-all) are not 200 here. Retries until `want` holds or a few
   * seconds pass (proxies apply a moment after their API says so), then returns the last answer.
   */
  probe?:         (domain: string, want: (status: number | null) => boolean) => Promise<number | null>
  /** Expected probe status for a disabled host (403 Traefik, 503 Caddy and HAProxy). */
  disabledStatus?: number
}

const actor = { email: 'contract@example.invalid' }

export function runContract(c: ContractCase): void {
  const host = (extra: Record<string, unknown> = {}) => ({ domains: [c.domain], forwardScheme: 'http', forwardHost: c.forwardHost, forwardPort: c.forwardPort, enabled: true, ...extra })
  const find = (hosts: ProxyHostView[], d: string) => hosts.find(h => h.domains.includes(d))
  let planner: ProxyPlanner
  let external: ProxyHostView | undefined
  let id = ''

  test(`${c.label}: health answers`, async () => {
    planner = new ProxyPlanner(c.service())
    const h = await c.service().health(c.instanceId)
    assert.equal(h.ok, true, JSON.stringify(h.checks))
  })

  test(`${c.label}: a host made outside HyperProx is listed read-only, with its instance`, async () => {
    const hosts = await c.service().hosts(c.instanceId)
    external = find(hosts, c.externalDomain)
    assert.ok(external, `expected ${c.externalDomain} in ${hosts.map(h => h.domains.join(',')).join(' | ')}`)
    assert.equal(external.readOnly, c.externalReadOnly !== false)
    assert.equal(external.instanceId, c.instanceId)
    if (c.externalReadOnly !== false) assert.ok(external.readOnlyReason)
    assert.equal(find(hosts, c.domain), undefined, 'the test name must be unused')
  })

  test(`${c.label}: writes to the read-only host and its name are refused at preview`, async () => {
    if (c.externalReadOnly !== false) for (const action of ['update', 'delete', 'disable'] as const) {
      await assert.rejects(planner.preview(c.instanceId, { action, hostId: external!.id, host: host() }, actor), /read-only/)
    }
    await assert.rejects(planner.preview(c.instanceId, { action: 'create', host: host({ domains: [c.externalDomain] }) }, actor), /already served/)
  })

  test(`${c.label}: create is previewed, applied, and read back`, async () => {
    const plan = await planner.preview(c.instanceId, { action: 'create', host: host() }, actor)
    assert.equal(plan.action, 'create')
    assert.match(plan.changes[0], new RegExp(c.domain.replace(/\./g, '\\.')))
    assert.ok(plan.consequences.length)
    const before = await c.service().hosts(c.instanceId)
    assert.equal(find(before, c.domain), undefined, 'preview changed nothing')
    const r = await planner.apply(plan.id, actor)
    assert.equal(r.ok, true, r.message)
    assert.deepEqual(r.mismatch, [])
    id = r.hostId!
    const h = find(await c.service().hosts(c.instanceId), c.domain)
    assert.ok(h)
    assert.equal(h.id, id)
    assert.equal(h.readOnly, false)
    assert.equal(h.forwardPort, c.forwardPort)
    await assert.rejects(planner.apply(plan.id, actor), /expired or was already used/)
    if (c.probe) assert.equal(await c.probe(c.domain, x => x === 200), 200)
  })

  test(`${c.label}: update is applied and read back`, async () => {
    const domains = c.multiDomain ? [c.domain, c.secondDomain] : [c.domain]
    const plan = await planner.preview(c.instanceId, { action: 'update', hostId: id, host: host({ domains, forwardPort: c.forwardPort + 1 }) }, actor)
    assert.ok(plan.changes.some(x => x.includes('forward port')))
    const r = await planner.apply(plan.id, actor)
    assert.equal(r.ok, true, r.message)
    const h = (await c.service().hosts(c.instanceId)).find(x => x.id === id)!
    assert.equal(h.forwardPort, c.forwardPort + 1)
    assert.deepEqual([...h.domains].sort(), [...domains].sort())
    // Back to the real backend, so traffic checks below reach it.
    const back = await planner.apply((await planner.preview(c.instanceId, { action: 'update', hostId: id, host: host({ domains }) }, actor)).id, actor)
    assert.equal(back.ok, true, back.message)
  })

  test(`${c.label}: disable and enable are applied and read back`, async () => {
    const off = await planner.apply((await planner.preview(c.instanceId, { action: 'disable', hostId: id }, actor)).id, actor)
    assert.equal(off.ok, true, off.message)
    assert.equal(off.after?.enabled, false)
    if (c.probe && c.disabledStatus) assert.equal(await c.probe(c.domain, x => x === c.disabledStatus), c.disabledStatus)
    await assert.rejects(planner.preview(c.instanceId, { action: 'disable', hostId: id }, actor), /already disabled/)
    const on = await planner.apply((await planner.preview(c.instanceId, { action: 'enable', hostId: id }, actor)).id, actor)
    assert.equal(on.ok, true, on.message)
    assert.equal(on.after?.enabled, true)
    if (c.probe) assert.equal(await c.probe(c.domain, x => x === 200), 200)
  })

  test(`${c.label}: a change made after the preview fails the apply`, async () => {
    const plan = await planner.preview(c.instanceId, { action: 'update', hostId: id, host: host({ forwardPort: c.forwardPort + 2 }) }, actor)
    const sneaky = await planner.preview(c.instanceId, { action: 'disable', hostId: id }, actor)
    assert.equal((await planner.apply(sneaky.id, actor)).ok, true)
    await assert.rejects(planner.apply(plan.id, actor), /changed .* after the preview/)
    await planner.apply((await planner.preview(c.instanceId, { action: 'enable', hostId: id }, actor)).id, actor)
  })

  test(`${c.label}: delete is applied and read back; the outside host is untouched`, async () => {
    const plan = await planner.preview(c.instanceId, { action: 'delete', hostId: id }, actor)
    assert.match(plan.consequences.join(' '), /cannot be undone/)
    const r = await planner.apply(plan.id, actor)
    assert.equal(r.ok, true, r.message)
    const hosts = await c.service().hosts(c.instanceId)
    assert.equal(hosts.find(h => h.id === id), undefined)
    const ext = find(hosts, c.externalDomain)!
    const pick = (h: ProxyHostView) => ({ id: h.id, domains: h.domains, host: h.forwardHost, port: h.forwardPort, enabled: h.enabled, readOnly: h.readOnly })
    assert.deepEqual(pick(ext), pick(external!))
    if (c.probe) assert.notEqual(await c.probe(c.domain, x => x !== 200), 200)
  })
}
