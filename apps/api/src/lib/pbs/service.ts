// =============================================================================
//  HyperProx — Proxmox Backup Server: the service
//
//  Adding a server does the chores: the address and token are checked, the
//  certificate is read and pinned (first use, or CA-verified), and a real
//  authenticated read is made through that pin before anything is stored. A
//  token that cannot read the server is never saved.
//
//  Reads: one reading per server, kept 30 seconds, limited per session.
//
//  Actions: run verify now, run GC now. Each one is admin, a person (never an
//  API token: the gate's master-password re-confirmation already keeps tokens
//  out, and this service refuses one again by name), names a datastore the
//  server reports, is rate-limited, audited (every attempt, refused or not), and
//  read back: the task's status is fetched after the start. There is no delete,
//  prune or forget.
// =============================================================================

import { hasRole, type Role } from '../roles'
import { PbsClient, UPID_RE, type PbsApi } from './client'
import { ACTION_PRIVILEGE, type PbsReading } from './parse'
import { PbsHttpError, PbsUnreachableError, type PbsPin } from './transport'
import { cleanName, cleanSecret, cleanStaleHours, cleanTokenId, cleanUrl, PbsInputError, type PbsInput, type PbsInstanceStore, type PbsMeta } from './instances'
import { DEFAULT_STALE_HOURS } from './parse'

export interface Actor { sid: string; email: string; role: Role; token: string | null }

export class PbsRefusal extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); this.name = 'PbsRefusal' }
}

export type PbsAction = 'verify' | 'gc'
export const ACTION_WORD: Record<PbsAction, string> = { verify: 'Verify', gc: 'Garbage collection' }

export interface Presented { fingerprint: string; caVerified: boolean }

export interface ServiceDeps {
  store: PbsInstanceStore
  audit: (action: string, resource: string, details: Record<string, unknown>) => Promise<void>
  /** Reads the certificate the address presents, after the address checks. Production: lib/pbs/index.ts. */
  probe: (url: string) => Promise<Presented>
  /** The API for a connection, through its pin. */
  api: (c: { url: string; tokenId: string; secret: string; pin: PbsPin }) => PbsApi
  now?: () => number
  wait?: (ms: number) => Promise<unknown>
  limits?: Partial<Limits>
}

export interface Limits { readsPerMinute: number; actionsPerMinute: number; attemptsPerMinute: number; addsPerMinute: number }

const CACHE_MS = 30_000

export function pinFrom(p: Presented, at: Date): PbsPin {
  return { fingerprint: p.fingerprint, source: p.caVerified ? 'ca' : 'first-use', at: at.toISOString() }
}

/** The words for a refused or failed call, with the privilege PBS wants when it is a permission problem. */
export function refusalWords(e: unknown, action?: PbsAction, store?: string): string {
  if (e instanceof PbsHttpError && (e.status === 401 || e.status === 403)) {
    if (action) return `PBS refused: this token lacks ${ACTION_PRIVILEGE[action]} on /datastore/${store}. HyperProx's read-only token (Audit) cannot run ${action === 'gc' ? 'GC' : 'a verify'}; give the token ${ACTION_PRIVILEGE[action]} on that datastore (for example the DatastoreAdmin role on /datastore/${store}) to allow it.`
    return 'PBS refused the token. Check the token id and secret, and that the token has the Audit role on / (Datastore.Audit and Sys.Audit).'
  }
  if (e instanceof PbsUnreachableError || e instanceof PbsHttpError || e instanceof PbsRefusal) return e.message
  return 'The backup server did not accept the request.'
}

export class PbsService {
  private cache = new Map<string, { at: number; reading: PbsReading }>()
  private inflight = new Map<string, Promise<PbsReading>>()
  private hits = new Map<string, number[]>()
  private d: ServiceDeps & { now: () => number; wait: (ms: number) => Promise<unknown>; limits: Limits }

  constructor(deps: ServiceDeps) {
    this.d = {
      now: () => Date.now(), wait: ms => new Promise(r => setTimeout(r, ms)), ...deps,
      limits: { readsPerMinute: 30, actionsPerMinute: 3, attemptsPerMinute: 20, addsPerMinute: 6, ...(deps.limits ?? {}) },
    }
  }

  get instances(): PbsInstanceStore { return this.d.store }

  forget(id: string): void { this.cache.delete(id) }

  limit(actor: Actor, bucket: keyof Limits, message = 'Too many requests; wait a moment.'): void {
    const key = `${actor.sid}:${bucket}`
    const now = this.d.now()
    if (this.hits.size > 1000) for (const [k, v] of this.hits) if (!v.some(t => now - t < 60_000)) this.hits.delete(k)
    const recent = (this.hits.get(key) ?? []).filter(t => now - t < 60_000)
    if (recent.length >= this.d.limits[bucket]) { this.hits.set(key, recent); throw new PbsRefusal('rate_limited', message, 429) }
    recent.push(now); this.hits.set(key, recent)
  }

  /** Probe, pin and prove a connection, before anything is stored. */
  private async connect(url: string, tokenId: string, secret: string): Promise<PbsPin> {
    let presented: Presented
    try { presented = await this.d.probe(url) } catch (e: any) { throw new PbsRefusal('unreachable', e instanceof PbsUnreachableError ? e.message : 'Could not read a certificate from that address. Check it, and that HyperProx can reach port 8007.', 400) }
    const pin = pinFrom(presented, new Date(this.d.now()))
    try { await this.d.api({ url, tokenId, secret, pin }).call('GET', '/status/datastore-usage') }
    catch (e) { throw new PbsRefusal('connect_failed', `HyperProx reached the server but could not read it, so nothing was saved. ${refusalWords(e)}`, 400) }
    return pin
  }

  /** Add a server: check, pin, prove, then store. */
  async add(input: PbsInput, actor: Actor): Promise<PbsMeta> {
    this.limit(actor, 'addsPerMinute', 'Too many attempts to add a server; wait a moment.')
    const name = cleanName(input.name), url = cleanUrl(input.url), tokenId = cleanTokenId(input.tokenId), secret = cleanSecret(input.secret)
    const staleHours = cleanStaleHours(input.staleHours, DEFAULT_STALE_HOURS)
    if ((await this.d.store.list()).some(i => i.name.toLowerCase() === name.toLowerCase())) throw new PbsInputError('Another backup server already has that name.', 409)
    const pin = await this.connect(url, tokenId, secret)
    return this.d.store.create({ name, url, tokenId, secret, staleHours, pin })
  }

  /**
   * Change a server. A new address or token is proved again before it is stored (and a new address is pinned
   * afresh). `repin` reads the certificate again and pins what is presented now: the deliberate way to accept a
   * renewed certificate, admin and re-confirmed like every change here.
   */
  async update(id: string, input: PbsInput & { repin?: unknown }, actor: Actor): Promise<{ meta: PbsMeta; credentialChanged: boolean }> {
    this.limit(actor, 'addsPerMinute', 'Too many changes; wait a moment.')
    const plan = await this.d.store.planUpdate(id, input)
    let pin = plan.prev.pin
    if (plan.credentialChanged || input.repin === true || !pin) {
      const secret = plan.secret ?? (await this.d.store.connection(id))?.secret
      if (!secret) throw new PbsInputError('Paste the token secret again.')
      pin = await this.connect(plan.url, plan.tokenId, secret)
    }
    const meta = await this.d.store.write(id, { name: plan.name, url: plan.url, tokenId: plan.tokenId, secret: plan.secret, staleHours: plan.staleHours, pin })
    this.forget(id)
    return { meta, credentialChanged: plan.credentialChanged || input.repin === true }
  }

  private async meta(id: string): Promise<PbsMeta> {
    const m = await this.d.store.get(id)
    if (!m) throw new PbsRefusal('no_instance', 'No such backup server.', 404)
    return m
  }

  private async client(id: string): Promise<{ client: PbsClient; meta: PbsMeta }> {
    const c = await this.d.store.connection(id)
    if (!c) throw new PbsRefusal('not_configured', 'This backup server has no address or token yet.', 409)
    if (!c.meta.pin) throw new PbsRefusal('no_pin', 'This backup server has no pinned certificate; an admin saves it again to pin one.', 409)
    return { client: new PbsClient(this.d.api({ url: c.url, tokenId: c.tokenId, secret: c.secret, pin: c.meta.pin })), meta: c.meta }
  }

  async reading(id: string, o: { actor?: Actor; fresh?: boolean } = {}): Promise<PbsReading> {
    const m = await this.meta(id)
    if (o.actor) this.limit(o.actor, 'readsPerMinute')
    const hit = this.cache.get(id)
    const age = hit ? this.d.now() - hit.at : Infinity
    if (hit && age < (o.fresh ? 5_000 : CACHE_MS)) return hit.reading
    const running = this.inflight.get(id)
    if (running) return running
    const p = (async () => {
      const { client } = await this.client(id)
      try {
        const reading = await client.read(new Date(this.d.now()), m.staleHours)
        this.cache.set(id, { at: this.d.now(), reading })
        return reading
      } catch (e) { throw new PbsRefusal(e instanceof PbsUnreachableError ? e.code : 'read_failed', refusalWords(e), 502) }
    })()
    this.inflight.set(id, p)
    try { return await p } finally { this.inflight.delete(id) }
  }

  // ── actions ────────────────────────────────────────────────────────────────

  async auditRefusal(id: string, actor: Actor | null, action: string, code: string): Promise<void> {
    await this.d.audit('pbs.action', `pbs:${String(id).replace(/[^a-z0-9]/gi, '').slice(0, 20)}`, {
      by: actor?.email ?? 'anonymous', via: actor?.token ? `api:${actor.token}` : actor ? 'session' : 'none',
      action: String(action).replace(/[^a-z]/g, '').slice(0, 10), result: `refused:${code}`,
    })
  }

  async act(id: string, action: string, body: { store?: unknown }, actor: Actor): Promise<{ ok: true; message: string; action: PbsAction; upid: string; state: 'running' | 'ok' | 'failed' }> {
    let m: PbsMeta
    try { m = await this.meta(id) } catch (e: any) { await this.auditRefusal(id, actor, action, e?.code ?? 'error'); throw e }
    const store = typeof body.store === 'string' ? body.store.slice(0, 64) : ''
    const base = { by: actor.email, via: actor.token ? `api:${actor.token}` : 'session', server: m.name, serverId: m.id, action: action.slice(0, 10), store }
    const refuse = async (e: PbsRefusal): Promise<never> => {
      await this.d.audit('pbs.action', `pbs:${m.id}`, { ...base, result: `refused:${e.code}` })
      throw e
    }
    try { this.limit(actor, 'attemptsPerMinute', 'Too many attempts in a minute; wait a moment.') } catch (e: any) { return refuse(e) }
    if (action !== 'verify' && action !== 'gc') return refuse(new PbsRefusal('action_not_allowed', 'HyperProx can run a verify or GC now. It never deletes, prunes or forgets a backup.'))
    if (actor.token) return refuse(new PbsRefusal('token_forbidden', 'API tokens can never start a verify or GC: it needs a person with the master password.', 403))
    if (!hasRole(actor.role, 'admin')) return refuse(new PbsRefusal('forbidden', `${ACTION_WORD[action]} now needs the admin role.`, 403))
    try { this.limit(actor, 'actionsPerMinute', 'That is the most actions allowed in a minute.') } catch (e: any) { return refuse(e) }
    // The datastore must be one the server reports now.
    let r: PbsReading
    try { r = await this.reading(m.id) } catch (e: any) { return refuse(new PbsRefusal('unreachable', e?.message ?? 'The backup server could not be read.', 502)) }
    if (!r.datastores.some(d => d.store === store)) return refuse(new PbsRefusal('bad_input', `${m.name} reports no datastore called "${store}".`, 404))

    const { client } = await this.client(m.id)
    let upid: string
    try { upid = action === 'verify' ? await client.verify(store) : await client.gc(store) }
    catch (e) {
      const msg = refusalWords(e, action, store)
      const code = e instanceof PbsHttpError && (e.status === 401 || e.status === 403) ? 'pbs_permission' : 'call_failed'
      await this.d.audit('pbs.action', `pbs:${m.id}`, { ...base, result: code === 'pbs_permission' ? 'refused:pbs_permission' : 'failed', reason: msg.slice(0, 200) })
      throw new PbsRefusal(code, msg, code === 'pbs_permission' ? 403 : 502)
    }
    if (!UPID_RE.test(upid)) {
      await this.d.audit('pbs.action', `pbs:${m.id}`, { ...base, result: 'unconfirmed' })
      throw new PbsRefusal('unconfirmed', `${m.name} did not return a task id, so HyperProx cannot tell whether ${ACTION_WORD[action].toLowerCase()} started. Check its task list.`, 502)
    }
    // Read after write: the task must exist on the server and be running or finished.
    await this.d.wait(1500)
    let state: 'running' | 'ok' | 'failed' = 'running'
    let exit: string | null = null
    try {
      const s = await client.taskStatus(upid)
      exit = s.exit
      state = s.running ? 'running' : s.exit === 'OK' || /^WARNINGS?:/i.test(s.exit ?? '') ? 'ok' : 'failed'
    } catch (e) {
      await this.d.audit('pbs.action', `pbs:${m.id}`, { ...base, upid, result: 'unconfirmed' })
      throw new PbsRefusal('unconfirmed', `${ACTION_WORD[action]} was accepted, but its task could not be read back (${refusalWords(e)}). Check the server's task list.`, 502)
    }
    this.forget(m.id)
    await this.d.audit('pbs.action', `pbs:${m.id}`, { ...base, upid, result: state === 'failed' ? 'failed' : 'done', exit })
    const what = `${ACTION_WORD[action]} of ${store} on ${m.name}`
    const message = state === 'running' ? `${what} is running. It can take a while on a large datastore; the job list shows its result.`
      : state === 'ok' ? `${what} finished: ${exit}.` : `${what} stopped with an error: ${exit}.`
    return { ok: true, message, action, upid, state }
  }
}
