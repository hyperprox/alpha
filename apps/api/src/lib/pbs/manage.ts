// =============================================================================
//  HyperProx — Proxmox Backup Server: managing backups (opt-in)
//
//  Off by default. A server is read with its read-only token (Audit on /), and
//  nothing HyperProx does with that token can remove a backup. Only when an
//  admin turns on "Let HyperProx manage backups" does HyperProx make a SECOND
//  token on the server, hyperprox@pbs!manage, with DatastoreAdmin on each
//  chosen datastore (never on /), kept in its own vault item. That token is
//  used by the actions below and by nothing else: every read, the previews'
//  listings and every read-back still go through the read-only token. Turning
//  management off deletes the manage token on the server (and its permissions),
//  then the vault item. The consequence is stated wherever it is turned on:
//  anyone who gets into HyperProx as an admin, with the master password, could
//  then delete backups on those datastores.
//
//  The actions, each admin only, master password re-entered, never an API
//  token, audited per item and read back afterwards:
//    delete-snapshots  the snapshots picked;
//    delete-group      every snapshot of one group (all of a guest's backups);
//    prune             the datastore's prune job's keep settings (or the
//                      datastore's own), PBS's prune per group with dry-run
//                      first, so the preview lists exactly what goes;
//    gc                clean up now (garbage collection), which removes only
//                      chunks no snapshot uses.
//  The three that remove snapshots go through a preview first: held on the
//  server, for the person who made it, single use, ten minutes. The apply takes
//  only the preview's id (and the extra confirmations it asked for).
//
//  Safety:
//    - a protected snapshot is never deleted; the preview lists it as kept;
//    - removing a group's last remaining snapshot needs a second, explicit
//      confirmation ("last-snapshot"), named group by group in the preview;
//    - nothing is removed from a group while a backup of that group is running
//      (checked at preview and again at apply);
//    - a prune is dry-run again at apply, and refused if what would go has
//      changed since the preview; what PBS then reports removed must match.
// =============================================================================

import crypto from 'node:crypto'
import { hasRole } from '../roles'
import type { PbsApi } from './client'
import { UPID_RE } from './client'
import { PbsHttpError, PbsUnreachableError, type PbsPin } from './transport'
import type { PbsInstanceStore, PbsMeta } from './instances'
import type { Actor } from './service'

export const MANAGE_USER = 'hyperprox@pbs'
export const MANAGE_TOKEN = 'manage'
export const MANAGE_TOKEN_ID = `${MANAGE_USER}!${MANAGE_TOKEN}`
/** The one role the manage token gets, on each chosen datastore only. */
export const MANAGE_ROLE = 'DatastoreAdmin'
export const PREVIEW_TTL_MS = 10 * 60_000
export const MANAGE_CONSEQUENCE =
  'Anyone who gets into HyperProx as an admin, with the master password, could then delete or prune backups on the chosen datastores. ' +
  'HyperProx keeps a second token for this (DatastoreAdmin on those datastores only, never on /); turning management off deletes it on the server.'

export class ManageRefusal extends Error {
  constructor(public code: string, message: string, public status = 400, public problems: string[] = []) { super(message); this.name = 'ManageRefusal' }
}

const enc = encodeURIComponent
const STORE_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/
const NS_RE = /^$|^[A-Za-z0-9_][A-Za-z0-9._-]{0,31}(\/[A-Za-z0-9_][A-Za-z0-9._-]{0,31}){0,7}$/
const TYPE_RE = /^(vm|ct|host)$/
const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/

// ── the manage token on the server ───────────────────────────────────────────

/** Make (or make again) the manage token with DatastoreAdmin on exactly these datastores, through an admin sign-in. */
export async function createManageToken(admin: PbsApi, stores: string[]): Promise<{ tokenId: string; secret: string }> {
  if (!stores.length || stores.some(s => !STORE_RE.test(s))) throw new ManageRefusal('bad_input', 'Choose at least one datastore to manage.')
  const users = (await admin.call('GET', '/access/users')) as any[]
  if (!(users ?? []).some(u => u?.userid === MANAGE_USER)) await admin.call('POST', '/access/users', { userid: MANAGE_USER, comment: 'HyperProx' })
  const tokens = (await admin.call('GET', `/access/users/${enc(MANAGE_USER)}/token`)) as any[]
  if ((tokens ?? []).some(t => t?.tokenid === MANAGE_TOKEN_ID || t?.['token-name'] === MANAGE_TOKEN)) await removeManageToken(admin, await manageStoresOnServer(admin))
  const made = await admin.call('POST', `/access/users/${enc(MANAGE_USER)}/token/${enc(MANAGE_TOKEN)}`, { comment: 'HyperProx backup management (delete, prune, clean up)' })
  if (typeof made?.value !== 'string' || !made.value) throw new PbsUnreachableError('The server did not return a secret for the manage token.')
  // A token's privileges are the intersection of its own and its user's: both get the role, on these datastores.
  for (const s of stores) for (const who of [MANAGE_USER, MANAGE_TOKEN_ID]) await admin.call('PUT', '/access/acl', { path: `/datastore/${s}`, role: MANAGE_ROLE, 'auth-id': who })
  const acl = (await admin.call('GET', '/access/acl')) as any[]
  for (const s of stores) if (!(acl ?? []).some(r => r?.path === `/datastore/${s}` && r?.roleid === MANAGE_ROLE && r?.ugid === MANAGE_TOKEN_ID)) throw new PbsUnreachableError(`the manage permission on ${s} did not read back`)
  if ((acl ?? []).some(r => r?.path === '/' && r?.roleid === MANAGE_ROLE)) throw new PbsUnreachableError('a manage permission on / was found; refusing')
  return { tokenId: MANAGE_TOKEN_ID, secret: made.value }
}

/** The manage permissions HyperProx gave (the manage role, to its user or token, on a datastore), as listed now. */
async function manageAcl(admin: PbsApi): Promise<Array<{ path: string; ugid: string }>> {
  const acl = (await admin.call('GET', '/access/acl')) as any[]
  return (acl ?? []).filter(r => r?.roleid === MANAGE_ROLE && (r?.ugid === MANAGE_TOKEN_ID || r?.ugid === MANAGE_USER) && /^\/datastore\/[^/]+$/.test(String(r?.path)))
    .map(r => ({ path: String(r.path), ugid: String(r.ugid) }))
}
async function manageStoresOnServer(admin: PbsApi): Promise<string[]> {
  return [...new Set((await manageAcl(admin)).map(r => r.path.slice('/datastore/'.length)))]
}

/** Delete the manage token and every manage permission HyperProx gave, then check none is left. */
export async function removeManageToken(admin: PbsApi, _stores: string[]): Promise<void> {
  // Exactly the entries the server lists: nothing else is touched (another role on the same path stays).
  for (const r of await manageAcl(admin)) await admin.call('PUT', '/access/acl', { path: r.path, role: MANAGE_ROLE, 'auth-id': r.ugid, delete: true })
  const tokens = (await admin.call('GET', `/access/users/${enc(MANAGE_USER)}/token`)) as any[]
  if ((tokens ?? []).some(t => t?.tokenid === MANAGE_TOKEN_ID || t?.['token-name'] === MANAGE_TOKEN)) await admin.call('DELETE', `/access/users/${enc(MANAGE_USER)}/token/${enc(MANAGE_TOKEN)}`)
  const after = (await admin.call('GET', `/access/users/${enc(MANAGE_USER)}/token`)) as any[]
  if ((after ?? []).some(t => t?.tokenid === MANAGE_TOKEN_ID || t?.['token-name'] === MANAGE_TOKEN)) throw new PbsUnreachableError('the manage token is still listed on the server')
  if ((await manageStoresOnServer(admin)).length) throw new PbsUnreachableError('a manage permission is still listed on the server')
}

// ── previews and actions ─────────────────────────────────────────────────────

export interface SnapRef { type: string; id: string; time: number }
export interface PreviewItem extends SnapRef { protected: boolean; size: number | null }

export type ManageAction = 'delete-snapshots' | 'delete-group' | 'prune'

export interface ManagePreview {
  id: string
  owner: string
  serverId: string
  action: ManageAction
  store: string
  ns: string
  /** Exactly what would be removed. */
  remove: PreviewItem[]
  /** What stays, and why: protected, or kept by the prune settings. */
  kept: Array<PreviewItem & { why: 'protected' | 'kept' }>
  /** Groups whose last remaining snapshot this removes: each needs the "last-snapshot" confirmation. */
  lastSnapshot: string[]
  /** Confirmations the apply must carry. */
  acks: string[]
  /** For a prune: the keep settings, and where they came from. */
  keep?: { from: string; settings: Record<string, number> }
  warnings: string[]
  createdAt: number
  expiresAt: number
  used: boolean
}

export interface ManagerDeps {
  store: PbsInstanceStore
  audit: (action: string, resource: string, details: Record<string, unknown>) => Promise<void>
  api: (c: { url: string; tokenId: string; secret: string; pin: PbsPin }) => PbsApi
  login?: (url: string, pin: PbsPin, userid: string, password: string) => Promise<PbsApi>
  now?: () => number
  wait?: (ms: number) => Promise<unknown>
}

const KEEP_KEYS = ['keep-last', 'keep-hourly', 'keep-daily', 'keep-weekly', 'keep-monthly', 'keep-yearly'] as const
const groupKey = (x: { type: string; id: string }) => `${x.type}/${x.id}`
const itemKey = (x: SnapRef) => `${x.type}/${x.id}/${x.time}`
const when = (t: number) => new Date(t * 1000).toISOString().replace('.000Z', 'Z')

export function keepFrom(row: any): Record<string, number> {
  const out: Record<string, number> = {}
  for (const k of KEEP_KEYS) { const n = Number(row?.[k]); if (Number.isInteger(n) && n > 0 && n <= 10_000) out[k] = n }
  return out
}

/** A running backup task's group, from its worker id ("store:ns:vm/100" or "store:vm/100"), or null. */
export function runningGroups(tasks: unknown, store: string): Set<string> {
  const out = new Set<string>()
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (t?.worker_type !== 'backup' || t?.endtime) continue
    const w = String(t?.worker_id ?? '').replace(/\\x3a/g, ':').replace(/\\x2f/g, '/')
    const parts = w.split(':')
    if (parts[0] !== store) continue
    const g = parts[parts.length - 1]
    if (/^(vm|ct|host)\/[^/]+$/.test(g)) out.add(g)
  }
  return out
}

export class PbsManager {
  private previews = new Map<string, ManagePreview>()
  private applying = new Set<string>()
  private d: ManagerDeps & { now: () => number; wait: (ms: number) => Promise<unknown> }

  constructor(deps: ManagerDeps) {
    this.d = { now: () => Date.now(), wait: ms => new Promise(r => setTimeout(r, ms)), ...deps }
  }

  // ── turning it on and off ──────────────────────────────────────────────────

  private guard(actor: Actor): void {
    if (actor.token) throw new ManageRefusal('token_forbidden', 'API tokens can never manage backups: it needs a person with the master password.', 403)
    if (!hasRole(actor.role, 'admin')) throw new ManageRefusal('forbidden', 'Managing backups needs the admin role.', 403)
  }

  private async audit(serverId: string, actor: Actor, details: Record<string, unknown>): Promise<void> {
    await this.d.audit('pbs.manage', `pbs:${serverId.replace(/[^a-z0-9]/gi, '').slice(0, 20)}`, { by: actor.email, via: actor.token ? `api:${actor.token}` : 'session', ...details })
  }

  private async admin(meta: PbsMeta, url: string, login: { username?: unknown; realm?: unknown; password?: unknown }): Promise<PbsApi> {
    const user = typeof login.username === 'string' ? login.username.trim() : ''
    const realm = typeof login.realm === 'string' && login.realm.trim() ? login.realm.trim() : 'pam'
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(user) || !/^[A-Za-z0-9._-]{1,32}$/.test(realm)) throw new ManageRefusal('bad_input', 'Enter a PBS admin user name and realm.')
    if (typeof login.password !== 'string' || !login.password || login.password.length > 1024) throw new ManageRefusal('bad_input', 'Enter that user\'s password.')
    if (!meta.pin || !this.d.login) throw new ManageRefusal('no_pin', 'This server has no pinned certificate.', 409)
    try { return await this.d.login(url, meta.pin, `${user}@${realm}`, login.password) }
    catch (e) { throw new ManageRefusal('signin_failed', e instanceof PbsHttpError && (e.status === 401 || e.status === 403) ? 'The backup server refused that user name and password.' : 'The sign-in did not work.', 400) }
  }

  /**
   * Turn management on with an admin sign-in (the password is used for that one sign-in and dropped), for these
   * datastores, or with an api already signed in (the add-a-server flow). Making it again replaces the token.
   */
  async enable(id: string, stores: string[], actor: Actor, via: { login?: { username?: unknown; realm?: unknown; password?: unknown }; api?: PbsApi }): Promise<PbsMeta> {
    this.guard(actor)
    const c = await this.d.store.connection(id)
    if (!c) throw new ManageRefusal('no_instance', 'No such backup server.', 404)
    const known = await this.datastores(c)
    const chosen = [...new Set(stores)].filter(s => STORE_RE.test(s))
    if (!chosen.length || chosen.some(s => !known.includes(s))) { await this.audit(id, actor, { action: 'manage.on', result: 'refused:bad_input' }); throw new ManageRefusal('bad_input', 'Choose datastores this server has.') }
    const admin = via.api ?? await this.admin(c.meta, c.url, via.login ?? {}).catch(async e => { await this.audit(id, actor, { action: 'manage.on', result: `refused:${e.code}` }); throw e })
    let tok: { tokenId: string; secret: string }
    try { tok = await createManageToken(admin, chosen) }
    catch (e: any) { await this.audit(id, actor, { action: 'manage.on', result: 'failed' }); throw new ManageRefusal('setup_failed', `The manage token could not be made: ${e instanceof PbsHttpError && (e.status === 401 || e.status === 403) ? 'that login may not manage users and permissions (root@pam can)' : String(e?.message ?? 'error').slice(0, 160)}. Management stays off.`, 400) }
    // Proved before it is kept: the new token reads a chosen datastore.
    try { await this.d.api({ url: c.url, tokenId: tok.tokenId, secret: tok.secret, pin: c.meta.pin! }).call('GET', `/admin/datastore/${enc(chosen[0])}/status`) }
    catch { await removeManageToken(admin, chosen).catch(() => {}); await this.audit(id, actor, { action: 'manage.on', result: 'failed:readback' }); throw new ManageRefusal('setup_failed', 'The manage token was made but could not read the datastore, so it was deleted again. Management stays off.', 400) }
    const meta = await this.d.store.setManage(id, { tokenId: tok.tokenId, secret: tok.secret, stores: chosen, at: new Date(this.d.now()).toISOString() })
    await this.audit(id, actor, { action: 'manage.on', result: 'done', token: tok.tokenId, stores: chosen })
    return meta
  }

  /** Turn management off: the manage token and its permissions are deleted on the server first, then the vault item. */
  async disable(id: string, actor: Actor, login: { username?: unknown; realm?: unknown; password?: unknown }): Promise<PbsMeta> {
    this.guard(actor)
    const c = await this.d.store.connection(id)
    if (!c) throw new ManageRefusal('no_instance', 'No such backup server.', 404)
    if (!c.meta.manage) return c.meta
    // The read-only token cannot delete a token (that needs user management), and the manage token cannot either,
    // so this takes an admin sign-in, used once and dropped.
    const admin = await this.admin(c.meta, c.url, login).catch(async e => { await this.audit(id, actor, { action: 'manage.off', result: `refused:${e.code}` }); throw e })
    try { await removeManageToken(admin, c.meta.manage.stores) }
    catch (e: any) { await this.audit(id, actor, { action: 'manage.off', result: 'failed' }); throw new ManageRefusal('call_failed', `The manage token could not be deleted on the server (${String(e?.message ?? 'error').slice(0, 160)}), so management is still on.`, 502) }
    const meta = await this.d.store.setManage(id, null)
    this.previews.forEach((p, k) => { if (p.serverId === id) this.previews.delete(k) })
    await this.audit(id, actor, { action: 'manage.off', result: 'done', token: MANAGE_TOKEN_ID })
    return meta
  }

  // ── the two tokens ─────────────────────────────────────────────────────────

  private async datastores(c: { url: string; tokenId: string; secret: string; meta: PbsMeta }): Promise<string[]> {
    const usage = await this.read(c).call('GET', '/status/datastore-usage')
    return (Array.isArray(usage) ? usage : []).map((u: any) => String(u?.store ?? '')).filter(s => STORE_RE.test(s))
  }

  /** The read-only token: every read, listing and read-back. */
  private read(c: { url: string; tokenId: string; secret: string; meta: PbsMeta }): PbsApi {
    return this.d.api({ url: c.url, tokenId: c.tokenId, secret: c.secret, pin: c.meta.pin! })
  }

  /** Both tokens, for an action on `store`; refused unless management is on for that datastore. */
  private async both(id: string, store: string): Promise<{ meta: PbsMeta; read: PbsApi; manage: PbsApi }> {
    const c = await this.d.store.connection(id)
    if (!c) throw new ManageRefusal('no_instance', 'No such backup server.', 404)
    if (!c.meta.pin) throw new ManageRefusal('no_pin', 'This server has no pinned certificate.', 409)
    const mc = await this.d.store.manageConnection(id)
    if (!mc) throw new ManageRefusal('manage_off', 'Backup management is off for this server. An admin turns it on under Settings.', 409)
    if (!mc.stores.includes(store)) throw new ManageRefusal('manage_off', `Backup management is not on for the datastore "${store}".`, 409)
    return { meta: c.meta, read: this.read(c), manage: this.d.api({ url: c.url, tokenId: mc.tokenId, secret: mc.secret, pin: c.meta.pin }) }
  }

  private async snapshots(read: PbsApi, store: string, ns: string, group?: { type: string; id: string }): Promise<PreviewItem[]> {
    const rows = await read.call('GET', `/admin/datastore/${enc(store)}/snapshots`, { ...(ns ? { ns } : {}), ...(group ? { 'backup-type': group.type, 'backup-id': group.id } : {}) })
    return (Array.isArray(rows) ? rows : [])
      .filter((s: any) => TYPE_RE.test(String(s?.['backup-type'])) && ID_RE.test(String(s?.['backup-id'])) && Number.isInteger(s?.['backup-time']))
      .filter((s: any) => !group || (s['backup-type'] === group.type && s['backup-id'] === group.id))
      .map((s: any) => ({ type: s['backup-type'], id: s['backup-id'], time: s['backup-time'], protected: s.protected === true, size: typeof s.size === 'number' ? s.size : null }))
  }

  private async running(read: PbsApi, store: string): Promise<Set<string>> {
    return runningGroups(await read.call('GET', '/nodes/localhost/tasks', { running: true, limit: 200 }), store)
  }

  /** The prune job's keep settings for this datastore and namespace, or the datastore's own. */
  private async keepSettings(read: PbsApi, store: string, ns: string, jobId?: string): Promise<{ from: string; settings: Record<string, number> }> {
    const jobs = (await read.call('GET', '/admin/prune')) as any[]
    const mine = (jobs ?? []).filter(j => j?.store === store && (j?.ns ?? '') === ns && (!jobId || j?.id === jobId))
    const job = mine.find(j => Object.keys(keepFrom(j)).length)
    if (job) return { from: `prune job ${String(job.id).slice(0, 64)}`, settings: keepFrom(job) }
    const cfg = await read.call('GET', `/config/datastore/${enc(store)}`).catch(() => null)
    const own = keepFrom(cfg)
    if (Object.keys(own).length) return { from: `datastore ${store}`, settings: own }
    throw new ManageRefusal('no_keep', `${store}${ns ? `/${ns}` : ''} has no prune job or keep settings, so there is nothing to prune by. Make a prune job in PBS first.`, 409)
  }

  /** What one group's prune would remove, from PBS's own dry-run. */
  private async dryRun(manage: PbsApi, store: string, ns: string, g: { type: string; id: string }, keep: Record<string, number>): Promise<Array<{ time: number; keep: boolean; protected: boolean }>> {
    const r = await manage.call('POST', `/admin/datastore/${enc(store)}/prune`, { 'backup-type': g.type, 'backup-id': g.id, ...(ns ? { ns } : {}), ...keep, 'dry-run': true })
    return (Array.isArray(r) ? r : []).filter((x: any) => Number.isInteger(x?.['backup-time'])).map((x: any) => ({ time: x['backup-time'], keep: x.keep === true, protected: x.protected === true }))
  }

  /** Make a preview. Nothing is removed. */
  async preview(id: string, actor: Actor, req: { action?: unknown; store?: unknown; ns?: unknown; items?: unknown; group?: unknown; job?: unknown }): Promise<ManagePreview> {
    this.guard(actor)
    const action = req.action as ManageAction
    if (action !== 'delete-snapshots' && action !== 'delete-group' && action !== 'prune') throw new ManageRefusal('bad_input', 'Choose delete snapshots, delete a group, or prune.')
    const store = typeof req.store === 'string' && STORE_RE.test(req.store) ? req.store : ''
    const ns = typeof req.ns === 'string' && NS_RE.test(req.ns) ? req.ns : ''
    if (!store) throw new ManageRefusal('bad_input', 'Name the datastore.')
    const { read, manage } = await this.both(id, store)
    this.prunePreviews()
    const all = await this.snapshots(read, store, ns)
    const busy = await this.running(read, store)
    let remove: PreviewItem[] = [], kept: ManagePreview['kept'] = [], keep: ManagePreview['keep']
    const warnings: string[] = []

    if (action === 'delete-snapshots') {
      const want = Array.isArray(req.items) ? req.items.slice(0, 500) : []
      if (!want.length) throw new ManageRefusal('bad_input', 'Pick at least one snapshot.')
      for (const w of want as any[]) {
        const hit = all.find(s => s.type === w?.type && s.id === w?.id && s.time === Number(w?.time))
        if (!hit) throw new ManageRefusal('bad_input', `${w?.type}/${w?.id} at ${Number.isInteger(Number(w?.time)) ? when(Number(w.time)) : '?'} is not on the server (any more).`, 404)
        if (hit.protected) kept.push({ ...hit, why: 'protected' }); else if (!remove.some(r => itemKey(r) === itemKey(hit))) remove.push(hit)
      }
    } else if (action === 'delete-group') {
      const g = req.group as any
      if (!TYPE_RE.test(String(g?.type)) || !ID_RE.test(String(g?.id))) throw new ManageRefusal('bad_input', 'Name the group, such as vm/100.')
      const snaps = all.filter(s => s.type === g.type && s.id === g.id)
      if (!snaps.length) throw new ManageRefusal('bad_input', `${g.type}/${g.id} has no snapshots here.`, 404)
      remove = snaps.filter(s => !s.protected)
      kept = snaps.filter(s => s.protected).map(s => ({ ...s, why: 'protected' as const }))
      if (kept.length) warnings.push(`${kept.length} protected snapshot${kept.length === 1 ? '' : 's'} of ${g.type}/${g.id} stay, so the group stays too.`)
    } else {
      keep = await this.keepSettings(read, store, ns, typeof req.job === 'string' ? req.job.slice(0, 64) : undefined)
      const groups = [...new Map(all.map(s => [groupKey(s), { type: s.type, id: s.id }])).values()]
      for (const g of groups) {
        const res = await this.dryRun(manage, store, ns, g, keep.settings)
        for (const x of res) {
          const s = all.find(a => a.type === g.type && a.id === g.id && a.time === x.time) ?? { ...g, time: x.time, protected: x.protected, size: null }
          if (x.protected || s.protected) kept.push({ ...s, protected: true, why: 'protected' })
          else if (x.keep) kept.push({ ...s, why: 'kept' })
          else remove.push(s)
        }
      }
    }

    // Nothing in a group whose backup is running now.
    const blocked = [...new Set(remove.map(groupKey))].filter(g => busy.has(g))
    if (blocked.length) throw new ManageRefusal('backup_running', `A backup of ${blocked.join(', ')} is running now. Try again when it has finished.`, 409, blocked)
    // A group left with no snapshot at all after this.
    const lastSnapshot = [...new Set(remove.map(groupKey))].filter(g => {
      const left = all.filter(s => groupKey(s) === g && !remove.some(r => itemKey(r) === itemKey(s)))
      return left.length === 0
    })
    if (lastSnapshot.length) warnings.push(`This removes the last remaining snapshot of ${lastSnapshot.join(', ')}: ${lastSnapshot.length === 1 ? 'that guest has' : 'those guests have'} no backup here afterwards.`)
    if (!remove.length) warnings.push('Nothing would be removed.')
    const now = this.d.now()
    const p: ManagePreview = {
      id: crypto.randomUUID(), owner: actor.email, serverId: id, action, store, ns, remove, kept, lastSnapshot,
      acks: lastSnapshot.length ? ['last-snapshot'] : [], ...(keep ? { keep } : {}), warnings, createdAt: now, expiresAt: now + PREVIEW_TTL_MS, used: false,
    }
    this.previews.set(p.id, p)
    await this.audit(id, actor, { action: `${action}.preview`, store, ns, remove: remove.length, kept: kept.length, preview: p.id })
    return p
  }

  private prunePreviews(): void { const now = this.d.now(); for (const [k, p] of this.previews) if (p.expiresAt < now) this.previews.delete(k) }

  /** Remove exactly what preview `pid` lists, after checking it all again. */
  async apply(id: string, actor: Actor, pid: string, acks: unknown): Promise<{ removed: string[]; skipped: string[]; message: string }> {
    this.guard(actor)
    if (this.applying.has(pid)) throw new ManageRefusal('used', 'This preview is being applied already.', 409)
    this.applying.add(pid)
    try {
      const p = this.previews.get(pid)
      if (!p || p.owner !== actor.email || p.serverId !== id) throw new ManageRefusal('not_found', 'No such preview.', 404)
      if (p.used) throw new ManageRefusal('used', 'This preview was already applied. Make a new one.', 409)
      if (this.d.now() > p.expiresAt) throw new ManageRefusal('expired', 'This preview has expired. Look again.', 410)
      const given = Array.isArray(acks) ? acks.filter(a => typeof a === 'string') : []
      const missing = p.acks.filter(a => !given.includes(a))
      if (missing.length) throw new ManageRefusal('confirm', `This removes the last snapshot of ${p.lastSnapshot.join(', ')}. Tick the second confirmation to go ahead.`, 409, missing)
      p.used = true
      const { read, manage } = await this.both(id, p.store)
      // Again, now: still there, still unprotected, no backup running.
      const all = await this.snapshots(read, p.store, p.ns)
      const busy = await this.running(read, p.store)
      const blocked = [...new Set(p.remove.map(groupKey))].filter(g => busy.has(g))
      if (blocked.length) throw new ManageRefusal('backup_running', `A backup of ${blocked.join(', ')} started since the preview. Nothing was removed.`, 409, blocked)
      const removed: string[] = [], skipped: string[] = []
      const audit = (item: string, result: string, extra: Record<string, unknown> = {}) => this.audit(id, actor, { action: p.action, store: p.store, ns: p.ns, item, result, preview: p.id, ...extra })

      if (p.action === 'prune') {
        // Dry-run again: if what would go has changed, nothing is removed.
        const groups = [...new Set(p.remove.map(groupKey))].map(k => { const [type, ...rest] = k.split('/'); return { type, id: rest.join('/') } })
        const now: string[] = []
        for (const g of groups) for (const x of await this.dryRun(manage, p.store, p.ns, g, p.keep!.settings)) if (!x.keep && !x.protected) now.push(itemKey({ ...g, time: x.time }))
        const planned = p.remove.map(itemKey)
        if (now.sort().join('\n') !== [...planned].sort().join('\n')) throw new ManageRefusal('changed', 'What the prune would remove has changed since the preview (a new backup, say). Nothing was removed; look again.', 409)
        for (const g of groups) {
          const res = await manage.call('POST', `/admin/datastore/${enc(p.store)}/prune`, { 'backup-type': g.type, 'backup-id': g.id, ...(p.ns ? { ns: p.ns } : {}), ...p.keep!.settings, 'dry-run': false })
          const gone = (Array.isArray(res) ? res : []).filter((x: any) => x?.keep === false && x?.protected !== true).map((x: any) => itemKey({ ...g, time: x['backup-time'] }))
          for (const k of planned.filter(k => k.startsWith(`${groupKey(g)}/`))) {
            if (gone.includes(k)) { removed.push(k); await audit(k, 'removed') } else { skipped.push(k); await audit(k, 'not_removed') }
          }
        }
      } else if (p.action === 'delete-group' && p.kept.length === 0) {
        const [first] = p.remove
        const fresh = all.filter(s => s.type === first.type && s.id === first.id)
        if (fresh.some(s => s.protected)) throw new ManageRefusal('changed', `A snapshot of ${groupKey(first)} was protected since the preview. Nothing was removed; look again.`, 409)
        if (fresh.length !== p.remove.length) throw new ManageRefusal('changed', `${groupKey(first)} has a different number of snapshots than in the preview. Nothing was removed; look again.`, 409)
        await manage.call('DELETE', `/admin/datastore/${enc(p.store)}/groups`, { 'backup-type': first.type, 'backup-id': first.id, ...(p.ns ? { ns: p.ns } : {}) })
        for (const s of p.remove) { removed.push(itemKey(s)); await audit(itemKey(s), 'removed') }
      } else {
        // Snapshot by snapshot (and a group with protected snapshots: every unprotected one).
        for (const s of p.remove) {
          const now = all.find(a => itemKey(a) === itemKey(s))
          if (!now) { skipped.push(itemKey(s)); await audit(itemKey(s), 'gone_already'); continue }
          if (now.protected) { skipped.push(itemKey(s)); await audit(itemKey(s), 'kept:protected'); continue }
          try {
            await manage.call('DELETE', `/admin/datastore/${enc(p.store)}/snapshots`, { 'backup-type': s.type, 'backup-id': s.id, 'backup-time': s.time, ...(p.ns ? { ns: p.ns } : {}) })
            removed.push(itemKey(s)); await audit(itemKey(s), 'removed')
          } catch (e: any) { skipped.push(itemKey(s)); await audit(itemKey(s), 'failed', { reason: String(e?.message ?? '').slice(0, 160) }) }
        }
      }
      // Read back: nothing claimed removed is still listed, and every protected one is still there.
      const after = await this.snapshots(read, p.store, p.ns)
      const still = removed.filter(k => after.some(a => itemKey(a) === k))
      const lostProtected = all.filter(s => s.protected && !after.some(a => itemKey(a) === itemKey(s)))
      if (still.length || lostProtected.length) {
        await this.audit(id, actor, { action: p.action, store: p.store, result: 'readback_mismatch', still: still.length, protectedMissing: lostProtected.length })
        throw new ManageRefusal('readback', `The server still lists ${still.length} snapshot${still.length === 1 ? '' : 's'} HyperProx removed${lostProtected.length ? `, and ${lostProtected.length} protected snapshot${lostProtected.length === 1 ? ' is' : 's are'} missing` : ''}. Check the server.`, 502)
      }
      const message = `Removed ${removed.length} snapshot${removed.length === 1 ? '' : 's'} from ${p.store}${p.ns ? `/${p.ns}` : ''}${skipped.length ? `; ${skipped.length} not removed (see the audit log)` : ''}. Their space returns at the next clean-up (GC).`
      return { removed, skipped, message }
    } finally { this.applying.delete(pid) }
  }

  /** Clean up now: garbage collection, with the manage token; its task status is read back. */
  async gc(id: string, actor: Actor, store: unknown): Promise<{ upid: string; state: 'running' | 'ok' | 'failed'; message: string }> {
    this.guard(actor)
    const s = typeof store === 'string' && STORE_RE.test(store) ? store : ''
    if (!s) throw new ManageRefusal('bad_input', 'Name the datastore.')
    const { read, manage } = await this.both(id, s)
    let upid: string
    try { upid = String(await manage.call('POST', `/admin/datastore/${enc(s)}/gc`)) }
    catch (e: any) { await this.audit(id, actor, { action: 'gc', store: s, result: 'failed' }); throw new ManageRefusal('call_failed', `The server did not start the clean-up: ${String(e?.message ?? '').slice(0, 160)}`, 502) }
    if (!UPID_RE.test(upid)) { await this.audit(id, actor, { action: 'gc', store: s, result: 'unconfirmed' }); throw new ManageRefusal('unconfirmed', 'The server did not return a task id for the clean-up.', 502) }
    await this.d.wait(1500)
    const st = await read.call('GET', `/nodes/localhost/tasks/${enc(upid)}/status`)
    const state: 'running' | 'ok' | 'failed' = st?.status === 'running' ? 'running' : st?.exitstatus === 'OK' || /^WARNINGS?:/i.test(String(st?.exitstatus ?? '')) ? 'ok' : 'failed'
    await this.audit(id, actor, { action: 'gc', store: s, upid, result: state === 'failed' ? 'failed' : 'done' })
    return { upid, state, message: state === 'running' ? `Clean-up of ${s} is running. It frees the space of deleted snapshots; on a large datastore it takes a while.` : state === 'ok' ? `Clean-up of ${s} finished.` : `Clean-up of ${s} stopped with an error: ${String(st?.exitstatus ?? '').slice(0, 160)}` }
  }

  getPreview(owner: string, pid: string): ManagePreview | null {
    const p = this.previews.get(pid)
    return p && p.owner === owner && this.d.now() <= p.expiresAt ? p : null
  }
}
