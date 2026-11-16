// =============================================================================
//  HyperProx — HAProxy: the Catalogue install's optional "Proxy load balancing"
//
//  Pick two or more guests running the same app and, after HAProxy is installed,
//  set up and connected, HyperProx balances them through the very service the
//  plug-in's "Proxy load balancing" button uses (lib/haproxy/service.ts
//  loadBalance, with lib/haproxy/publish.ts for a public name): nothing here
//  builds a backend, a rule or a DNS record of its own.
//
//  Installed is not done. The step finishes as done only once the backend reads
//  back from HAProxy with every server present and at least one healthy, and,
//  when a web address was asked for, once that address is published. The same
//  rules as the plug-in apply to every pick, the leave-alone rule included.
//  Skipped, the install behaves exactly as before.
// =============================================================================

import type { PublishDeps, PublishLedger } from '../sites'
import type { PublishJob } from './index'
import type { Reading } from './model'
import { ALGORITHMS } from './dataplane'
import { HaproxyRefusal, parseLoadBalance, pickLoadBalanceServers, serverNameFor, type ActionResult, type Actor, type GuestRow } from './service'

export const BALANCE_STEP = { id: 'haproxy-balance', label: 'Proxy load balancing' } as const

/** The step as the preview holds it: the plug-in's own request body, checked and with nothing else in it. */
export interface InstallBalance {
  name: string
  guests: Array<{ kind: 'lxc' | 'qemu'; vmid: number }>
  port: number
  algorithm: string
  checkPath: string
  hostname?: string
  /** Also publish the host name: its domain and the proxy that serves it. */
  publish?: { zone: string; proxyInstanceId: string }
}

export interface BalanceCheckDeps {
  /** The cluster's guests with their addresses, each marked when HyperProx must leave it alone. */
  guests(): Promise<GuestRow[]>
  /** DNS, proxy and certificate, for a name to publish. */
  publish: PublishDeps
}

/** The body the plug-in's route takes, from a held step. */
export function bodyOf(b: InstallBalance): Record<string, unknown> {
  return { name: b.name, guests: b.guests, port: b.port, algorithm: b.algorithm, checkPath: b.checkPath,
    ...(b.hostname ? { hostname: b.hostname } : {}),
    ...(b.publish ? { publish: true, zone: b.publish.zone, proxyInstanceId: b.publish.proxyInstanceId } : {}) }
}

const refusal = (e: unknown): string => e instanceof HaproxyRefusal || (e as any)?.name === 'RuntimeRefusal' ? (e as Error).message : String((e as any)?.message ?? e)

/**
 * Checks the step against the plug-in's rules (the same functions) and the cluster as it is now. Returns the step to
 * hold and what was checked, or the problems, in words.
 */
export async function balancePreview(raw: unknown, d: BalanceCheckDeps): Promise<{ value?: InstallBalance; errors: string[]; checks: string[] }> {
  const errors: string[] = [], checks: string[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: ['The app to load-balance is missing.'], checks }
  const r = raw as Record<string, unknown>
  let parsed
  try { parsed = parseLoadBalance(r) } catch (e) { return { errors: [refusal(e)], checks } }
  // Picks become plain kind/vmid pairs: nothing else a request carried is kept.
  const guests = parsed.list.map(g => ({ kind: (g?.kind === 'qemu' ? 'qemu' : 'lxc') as 'lxc' | 'qemu', vmid: Number(g?.vmid) }))
  let servers
  try { servers = pickLoadBalanceServers(guests, await d.guests(), parsed.port) } catch (e) { return { errors: [refusal(e)], checks } }
  const value: InstallBalance = { name: parsed.name, guests, port: parsed.port, algorithm: parsed.algorithm, checkPath: parsed.checkPath, ...(parsed.hostname ? { hostname: parsed.hostname } : {}) }
  if (r.publish === true) {
    const host = parsed.hostname, zone = String(r.zone ?? '').trim().toLowerCase()
    if (!host) errors.push('Publishing needs the host name visitors will use.')
    else if (!zone || !(host === zone || host.endsWith(`.${zone}`))) errors.push('The public name must be in the domain you picked, such as app.example.com in example.com.')
    else {
      const { planPublish } = await import('../sites')
      const pp = await planPublish({ zone, name: host === zone ? '@' : host.slice(0, -(zone.length + 1)), instanceId: String(r.proxyInstanceId ?? '') }, d.publish)
      if (!pp.plan || pp.errors.length) errors.push(...(pp.errors.length ? pp.errors : ['The public name could not be planned.']))
      else { value.publish = { zone, proxyInstanceId: String(r.proxyInstanceId) }; checks.push(...pp.checks) }
    }
  }
  if (errors.length) return { errors, checks }
  const where = parsed.hostname ? `visitors to ${parsed.hostname}` : 'every visitor no other rule matches'
  checks.push(`Once HAProxy is up, it will spread ${where} across ${servers.length} guests (${servers.map(s => `${s.name} on port ${parsed.port}`).join(', ')}) by ${parsed.algorithm}: ${ALGORITHMS[parsed.algorithm]}`)
  return { value, errors, checks }
}

export interface BalanceDeps {
  /** The plug-in's service: loadBalance(), exactly as its button calls it. */
  loadBalance(pluginInstanceId: string, body: Record<string, unknown>, actor: Actor, publish?: (ip: string) => Promise<{ jobId: string }>): Promise<ActionResult & { backend: string; publishJob?: string; publishProblem?: string }>
  /** Plans the public name and returns what starts its publish (lib/haproxy/publish.ts). */
  planPublish(body: Record<string, unknown>, actor: Actor): Promise<(ip: string) => Promise<{ jobId: string }>>
  /** HAProxy read back, as the plug-in's page reads it. */
  reading(pluginInstanceId: string): Promise<Reading>
  guests(): Promise<GuestRow[]>
  publishJob(id: string): PublishJob | undefined
  wait(ms: number): Promise<unknown>
}

type Step = { status: string; detail?: string }

export const READBACK_TRIES = 20
export const READBACK_MS = 3000
export const PUBLISH_TRIES = 200

/** What reading shows of the backend, or why it is not as it should be yet. */
export function backendProblem(reading: Reading, backend: string, expected: string[]): { problem: string | null; healthy: number; present: number } {
  const b = reading.backends.find(x => x.name === backend)
  if (!b) return { problem: `${backend} is not in HAProxy's reading yet.`, healthy: 0, present: 0 }
  const names = new Set(b.servers.map(s => s.name))
  const missing = expected.filter(n => !names.has(n))
  const healthy = b.servers.filter(s => s.state === 'up').length
  if (missing.length) return { problem: `${backend} is missing ${missing.join(', ')}.`, healthy, present: b.servers.length }
  if (healthy < 1) return { problem: `no server in ${backend} answers its health check yet (${b.servers.map(s => `${s.name} ${s.status}`).join(', ')}).`, healthy, present: b.servers.length }
  return { problem: null, healthy, present: b.servers.length }
}

/**
 * Runs the step. Throws, in words, when the backend could not be made, did not read back healthy or its name could
 * not be published; HAProxy itself stays installed and connected either way.
 */
export async function runInstallBalance(
  o: { pluginInstanceId: string; balance: InstallBalance; owner: string; haproxyIp: string }, s: Step, d: BalanceDeps,
  /** Told what the publish made, before anything can throw, so the install job's clean-up knows it (see runJob). */
  record: (r: { publishJob?: string; ledger?: PublishLedger }) => Promise<void> | void = () => {},
): Promise<{ backend: string; url?: string; ledger?: PublishLedger }> {
  const actor: Actor = { email: o.owner }
  const body = bodyOf(o.balance)
  const publish = body.publish === true ? await d.planPublish(body, actor) : undefined
  const saved = await d.loadBalance(o.pluginInstanceId, body, actor, publish)
  if (saved.publishProblem) throw new Error(`HAProxy is balancing ${saved.backend}, but publishing ${o.balance.hostname} did not start: ${saved.publishProblem}`)

  // The publish is on the install job from here on, whatever happens next.
  if (saved.publishJob) await record({ publishJob: saved.publishJob })

  let rows: GuestRow[] = [], unread = ''
  try { rows = await d.guests() } catch (e) { unread = `The cluster's guests could not be read: ${String((e as any)?.message ?? e).slice(0, 200)}` }
  const gone: string[] = [], expected: string[] = []
  for (const g of unread ? [] : o.balance.guests) {
    const r = rows.find(x => x.kind === g.kind && x.vmid === g.vmid)
    if (r) expected.push(serverNameFor(r.name, r.vmid)); else gone.push(`${g.kind === 'qemu' ? 'VM' : 'CT'} ${g.vmid}`)
  }
  let last = `${saved.backend} was not read back.`, found = { healthy: 0, present: 0 }, ok = false
  if (gone.length) last = `${gone.join(', ')} is no longer on the cluster`
  if (unread) last = unread
  for (let i = 0; i < READBACK_TRIES && !ok && !gone.length && !unread; i++) {
    if (i) await d.wait(READBACK_MS)
    try {
      const r = backendProblem(await d.reading(o.pluginInstanceId), saved.backend, expected)
      found = r; ok = r.problem === null; if (r.problem) last = r.problem
    } catch (e) { last = `HAProxy could not be read: ${String((e as any)?.message ?? e).slice(0, 200)}` }
  }

  // A name being published is waited for either way, so nothing is left running after the step ends.
  let url: string | undefined, ledger: PublishLedger | undefined, publishFailure: string | undefined
  if (saved.publishJob) {
    let job = d.publishJob(saved.publishJob)
    for (let i = 0; i < PUBLISH_TRIES && job?.status === 'running'; i++) { await d.wait(READBACK_MS); job = d.publishJob(saved.publishJob) }
    // A finished publish, or one still running, has made things the clean-up must know; a failed one removed its own.
    if (job && job.status !== 'failed') { ledger = structuredClone(job.ledger); await record({ publishJob: saved.publishJob, ledger }) }
    if (job?.status === 'done') url = job.url
    else publishFailure = job?.status === 'failed' ? `${job.error ?? 'it failed'}${job.cleanup?.length ? ` ${job.cleanup.join(' ')}` : ''}` : 'it did not finish in time'
  }
  if (!ok) throw new Error(`HAProxy was installed and ${saved.backend} was saved, but it is not done: ${last}`)
  if (publishFailure) throw new Error(`HAProxy is balancing ${saved.backend} (${found.healthy} of ${found.present} servers healthy), but publishing ${o.balance.hostname} failed: ${publishFailure}`)
  s.status = 'done'
  s.detail = `${saved.backend}: ${found.present} servers, ${found.healthy} healthy${url ? `; published at ${url}` : o.balance.hostname ? '' : `, on ${o.haproxyIp}`}`
  return { backend: saved.backend, ...(url ? { url } : {}), ...(ledger ? { ledger } : {}) }
}

/** The step as it runs for real: the plug-in's own service, its publish, its reading and the cluster's guests. */
export async function realBalanceDeps(): Promise<BalanceDeps> {
  const idx = await import('./index')
  const { planLoadBalancePublish } = await import('./publish')
  const svc = idx.haproxyService()
  return {
    loadBalance: (id, body, actor, publish) => svc.loadBalance(id, body, actor, publish),
    planPublish: (body, actor) => planLoadBalancePublish(body, actor),
    reading: id => svc.reading(id),
    guests: () => idx.guestRows(),
    publishJob: id => idx.PUBLISH_JOBS.get(id),
    wait: ms => new Promise(r => setTimeout(r, ms)),
  }
}

/** The preview's checks as they run for real. */
export async function realBalanceCheckDeps(): Promise<BalanceCheckDeps> {
  const { guestRows } = await import('./index')
  const { realPublishDeps } = await import('../sites')
  return { guests: guestRows, publish: realPublishDeps() }
}
