// =============================================================================
//  HyperProx — 3proxy: the plug-in's service
//
//  Each 3proxy the Catalogue installed is one instance. Readings are the helper's `stats`; every change is one of
//  its fixed verbs with checked arguments, run through the remote executor, so
//  the leave-alone rule (lib/guest-guard.ts) applies to every command. Users'
//  passwords are generated here and written to the vault BEFORE the guest is
//  changed (a password that exists only on the guest is a lockout); a guest
//  change that fails takes the vault entry back out again.
//
//  Auto-connect (lib/auto-connect): a finished Catalogue install of 3proxy,
//  whose guest still carries the install's hostname, is looked at once,
//  read-only (is its helper there), and connected. A
//  guest that is tagged hyperprox-ignore, on Remote access's exclusion list or
//  in an excluded subnet is never entered; a dismissed one is never re-added.
// =============================================================================

import { randomBytes } from 'node:crypto'
import { parseSelfTest, parseStats, CHECK_TITLE } from './parse'
import { checkNetworks, userProblem } from './net'
import { PROXY_ID, PROXY_NAME, type ProxyInstance, type ProxyReading, type SelfCheck } from './types'
import type { AdapterContext, Outcome } from '../auto-connect/core'
import { exclusionOf, installStillOwns, SYSTEM_ACTOR } from '../auto-connect/core'
import { auditBy, type AuditActor } from '../http/request-actor'

export class FwdProxyRefusal extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = 'FwdProxyRefusal' }
}

export interface Actor { email: string; role?: string; token?: string | null }

export interface GuestRow { type: 'lxc' | 'qemu'; vmid: number; node: string; name: string; running: boolean; tags: string[] }

export interface InstallRow { recipeId: string; vmid: number; status: string; hostname?: string; ip?: string; vaultItem?: { category: string; provider: string } }

export interface RecordStore {
  get(id: string): Promise<ProxyInstance | null>
  put(i: ProxyInstance): Promise<void>
  list(): Promise<ProxyInstance[]>
  delete(id: string): Promise<void>
}

export interface FwdDeps {
  store: RecordStore
  guests(): Promise<GuestRow[]>
  /** Remote access's "never look inside" list; throws when it cannot be read (then nothing is entered). */
  exclusions(): Promise<string[]>
  /** A script in the guest, through the remote executor (which refuses a guest that must be left alone, again). */
  exec(g: { vmid: number; node: string; name: string }, script: string, timeoutMs?: number): Promise<{ code: number; output: string; timedOut?: boolean }>
  /** The Catalogue's finished install records. */
  installs(): Promise<InstallRow[]>
  vault: {
    read(category: string, provider: string): Promise<Record<string, string>>
    set(category: string, provider: string, key: string, value: string): Promise<void>
    delete(category: string, provider: string, key: string): Promise<void>
  }
  audit(action: string, resource: string, details: Record<string, unknown>): Promise<void>
  /** Auto-connect's record of a disconnect, so it is never re-added by itself. */
  dismissed(key: string, label: string, by: string): Promise<void>
  now(): number
  /** A new password (default: 24 random characters). */
  password?(): string
}

export type FixId = 'reload' | 'block_lan' | 'reset_user' | 'add_user' | 'recheck'
export interface Problem {
  id: string
  severity: 'bad' | 'warn'
  title: string
  detail: string
  fix: { id: FixId; label: string; confirm?: string; user?: string } | null
}

const READ_TTL_MS = 20_000
const vaultItemOf = (i: ProxyInstance) => `hyperprox:${i.vault.category}/${i.vault.provider}`
/** The vault key a user's password is kept under; the first user keeps the installer's admin_password. */
const keyFor = (name: string, adminUser: string | undefined) => (name === adminUser ? 'admin_password' : `user_${name}`)
const sq = (v: string) => `'${String(v).replace(/'/g, `'\\''`)}'`
const HELPER = '/usr/local/sbin/hpx-fwdproxy'

export class FwdProxyService {
  private cache = new Map<string, { at: number; minutes: number; reading: ProxyReading }>()
  private busy = new Set<string>()

  constructor(private d: FwdDeps) {}

  private pw(): string { return this.d.password ? this.d.password() : randomBytes(18).toString('base64url') }

  async instances(): Promise<ProxyInstance[]> {
    return (await this.d.store.list()).sort((a, b) => a.vmid - b.vmid)
  }

  private async instance(id: string): Promise<ProxyInstance> {
    const i = await this.d.store.get(String(id ?? ''))
    if (!i) throw new FwdProxyRefusal('not_found', 'That proxy is not connected.', 404)
    return i
  }

  /** The guest now, refusing one HyperProx must leave alone (fail closed when the list cannot be read). */
  private async guest(i: ProxyInstance): Promise<GuestRow> {
    let ids: string[]
    try { ids = await this.d.exclusions() } catch { throw new FwdProxyRefusal('exclusions_unknown', "Remote access's exclusion list could not be read, so HyperProx enters no guest until it can.", 503) }
    const g = (await this.d.guests()).find(r => r.type === 'lxc' && r.vmid === i.vmid)
    if (!g) throw new FwdProxyRefusal('gone', `Container ${i.vmid} is not on the cluster any more.`, 404)
    const why = exclusionOf({ excludedMachines: new Set(ids), excludedSubnets: [] }, { machineId: i.id, tags: g.tags })
    if (why) throw new FwdProxyRefusal('excluded', `${g.name} is left alone (${why}), so HyperProx does not look inside it or change it.`, 409)
    if (!g.running) throw new FwdProxyRefusal('stopped', `${g.name} is not running.`, 409)
    return g
  }

  private async run(i: ProxyInstance, script: string, timeoutMs = 30_000): Promise<string> {
    const g = await this.guest(i)
    const r = await this.d.exec({ vmid: g.vmid, node: g.node, name: g.name }, script, timeoutMs)
    if (r.timedOut) throw new FwdProxyRefusal('timeout', `${PROXY_NAME} on ${g.name} did not answer in time.`, 504)
    if (r.code !== 0) {
      const why = r.output.trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)
      throw new FwdProxyRefusal('guest_failed', why || `The change did not work on ${g.name}.`, 502)
    }
    return r.output
  }

  // ── readings ──────────────────────────────────────────────────────────────

  async reading(id: string, opts: { minutes?: number; fresh?: boolean } = {}): Promise<ProxyReading> {
    const i = await this.instance(id)
    const minutes = Math.min(1440, Math.max(5, Math.floor(Number(opts.minutes) || 60)))
    const hit = this.cache.get(i.id)
    if (!opts.fresh && hit && hit.minutes === minutes && this.d.now() - hit.at < READ_TTL_MS) return hit.reading
    const reading = parseStats(await this.run(i, `${HELPER} stats ${minutes}`, 30_000), this.d.now())
    this.cache.set(i.id, { at: this.d.now(), minutes, reading })
    return reading
  }

  /** The plug-in card: one row per proxy. */
  async readings(): Promise<Array<{ id: string; name: string; vmid: number; listen: string | null; ok: boolean; error?: string; reading?: ProxyReading }>> {
    const list = await this.instances()
    return Promise.all(list.map(async i => {
      try { const r = await this.reading(i.id); return { id: i.id, name: i.name, vmid: i.vmid, listen: r.listen ?? i.listen, ok: true, reading: r } }
      catch (e: any) { return { id: i.id, name: i.name, vmid: i.vmid, listen: i.listen, ok: false, error: String(e?.message ?? e).slice(0, 200) } }
    }))
  }

  /** What is wrong, each with its fix. A reading that fails is itself the problem. */
  async problems(id: string): Promise<Problem[]> {
    const i = await this.instance(id)
    let r: ProxyReading
    try { r = await this.reading(id, { fresh: true }) }
    catch (e: any) { return [{ id: 'unreachable', severity: 'bad', title: 'Could not read the proxy', detail: String(e?.message ?? e), fix: { id: 'recheck', label: 'Check again' } }] }
    const out: Problem[] = []
    const name = PROXY_NAME
    if (!r.active) out.push({ id: 'stopped', severity: 'bad', title: `${name} is not running`, detail: 'Nobody can use the proxy until it runs again.', fix: { id: 'reload', label: 'Start it again', confirm: `Start ${name} on ${i.name} again?` } })
    if (!r.users.length) out.push({ id: 'no_users', severity: 'bad', title: 'No users', detail: 'Sign-in is required, so with no users nobody can use the proxy.', fix: { id: 'add_user', label: 'Add a user' } })
    if (r.lanTargets) out.push({ id: 'lan_open', severity: 'warn', title: 'It can reach your own network', detail: 'Anyone with a proxy login can reach services on your LAN through it. Turn it off unless you need it.', fix: { id: 'block_lan', label: 'Block my network again', confirm: 'Refuse addresses on your own network (10.x, 172.16–31.x, 192.168.x) from now on?' } })
    // A password change that timed out: the guest may have the new one or the old one. Only a new one settles it.
    for (const u of (i.uncertain ?? []).filter(x => r.users.includes(x))) {
      out.push({ id: `uncertain_${u}`, severity: 'warn', title: `${u}'s password may have changed`, detail: 'A password change did not finish in time, so the proxy may still have the old one. The vault has the new one. Set a new password to be sure they match.', fix: { id: 'reset_user', label: `New password for ${u}`, user: u, confirm: `Give ${u} a new password? Apps signed in with the old one stop working until they use the new one.` } })
    }
    // A user with no password in the vault (made by hand, or the vault item was removed): nobody can hand it out.
    const vault = await this.d.vault.read(i.vault.category, i.vault.provider).catch(() => null)
    if (vault) {
      for (const u of r.users) {
        if (!vault[keyFor(u, vault.admin_user)]) out.push({ id: `no_vault_${u}`, severity: 'warn', title: `${u} has no password in the vault`, detail: 'HyperProx cannot show this user\'s password. Give it a new one and it is kept in the vault.', fix: { id: 'reset_user', label: `New password for ${u}`, user: u, confirm: `Give ${u} a new password? Apps signed in with the old one stop working until they use the new one.` } })
      }
    }
    return out
  }

  // ── actions ───────────────────────────────────────────────────────────────

  private async once<T>(i: ProxyInstance, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(i.id)) throw new FwdProxyRefusal('busy', 'Another change to this proxy is still running.', 409)
    this.busy.add(i.id)
    try { return await fn() } finally { this.busy.delete(i.id); this.cache.delete(i.id) }
  }

  private async audit(action: string, i: ProxyInstance, by: Actor, details: Record<string, unknown> = {}) {
    await this.d.audit(`fwdproxy.${action}`, `fwdproxy:${PROXY_ID}:${i.vmid}`, { ...auditBy(by as AuditActor), ...details })
  }

  private async markUncertain(id: string, user: string, on: boolean): Promise<void> {
    const cur = await this.d.store.get(id)
    if (!cur) return
    const set = new Set(cur.uncertain ?? [])
    if (on === set.has(user)) return
    if (on) set.add(user); else set.delete(user)
    await this.d.store.put({ ...cur, uncertain: [...set] })
  }

  /** Restart on its config, or prove the rules. */
  async action(id: string, action: unknown, by: Actor): Promise<{ message: string; checks?: SelfCheck[] }> {
    const i = await this.instance(id)
    if (action === 'reload') {
      return this.once(i, async () => {
        await this.audit('reload', i, by)
        await this.run(i, `${HELPER} reload`, 60_000)
        return { message: `${PROXY_NAME} started again on its config.` }
      })
    }
    if (action === 'selftest') return this.selfTest(i, by)
    throw new FwdProxyRefusal('bad_action', 'That is not something HyperProx does to a proxy.')
  }

  /** The install's self-check, run again with the first user's password from the vault (it never leaves HyperProx). */
  private async selfTest(i: ProxyInstance, by: Actor): Promise<{ message: string; checks: SelfCheck[] }> {
    const v = await this.d.vault.read(i.vault.category, i.vault.provider)
    // The first user, or (once that one is removed) any user the proxy still has whose password is in the vault.
    const users = (await this.reading(i.id, { fresh: true }).catch(() => null))?.users
    const candidates: Array<[string, string | undefined]> = [
      [v.admin_user, v.admin_password],
      ...Object.keys(v).filter(k => k.startsWith('user_')).sort().map((k): [string, string | undefined] => [k.slice(5), v[k]]),
    ]
    const pick = candidates.find(([u, p]) => u && p && !userProblem(u) && (!users || users.includes(u)))
    if (!pick) throw new FwdProxyRefusal('no_login', 'No proxy user has its password in the vault, so the check cannot sign in. Give a user a new password first.', 409)
    const [user, pw] = pick as [string, string]
    await this.audit('selftest', i, by, { user })
    const checks = parseSelfTest(await this.run(i, selfTestScript(user, pw), 2 * 60_000))
    const failed = checks.filter(c => c.state === 'fail')
    return { checks, message: failed.length ? `${failed.length} check${failed.length === 1 ? '' : 's'} failed: ${failed.map(c => CHECK_TITLE[c.id] ?? c.id).join(', ')}.` : 'Every check passed.' }
  }

  /** A new user, or a new password for one. The password goes to the vault first, then to the guest. */
  async setUser(id: string, name: unknown, by: Actor, opts: { reset?: boolean } = {}): Promise<{ user: string; vaultItem: string; field: string; message: string }> {
    const i = await this.instance(id)
    const user = String(name ?? '').trim()
    const bad = userProblem(user)
    if (bad) throw new FwdProxyRefusal('bad_user', bad)
    return this.once(i, async () => {
      const r = await this.reading(i.id, { fresh: true }).catch(() => null)
      const exists = !!r?.users.includes(user)
      if (opts.reset && !exists) throw new FwdProxyRefusal('no_user', `There is no proxy user called ${user}.`, 404)
      if (!opts.reset && exists) throw new FwdProxyRefusal('exists', `${user} already exists. Give it a new password instead.`, 409)
      if (!opts.reset && (r?.users.length ?? 0) >= 50) throw new FwdProxyRefusal('too_many', 'A proxy here has at most 50 users.')
      const vault = await this.d.vault.read(i.vault.category, i.vault.provider)
      const field = keyFor(user, vault.admin_user)
      const before = vault[field] ?? null
      const pw = this.pw()
      await this.audit(opts.reset ? 'user_reset' : 'user_add', i, by, { user, vaultItem: vaultItemOf(i), field })
      await this.d.vault.set(i.vault.category, i.vault.provider, field, pw)
      try { await this.run(i, `${HELPER} user-add ${sq(user)} <<'HPX_PW'\n${pw}\nHPX_PW`, 60_000) }
      catch (e) {
        // Timed out: the guest may already have the new password, so the vault keeps it and the page offers a reset.
        if (e instanceof FwdProxyRefusal && e.code === 'timeout') {
          await this.markUncertain(i.id, user, true)
          throw new FwdProxyRefusal('timeout', `The proxy did not answer in time, so ${user}'s password may or may not have changed. The vault has the new one; set a new password to be sure.`, 504)
        }
        // The guest kept its old password (or never had the user): the vault says the same again.
        if (before === null) await this.d.vault.delete(i.vault.category, i.vault.provider, field).catch(() => {})
        else await this.d.vault.set(i.vault.category, i.vault.provider, field, before).catch(() => {})
        throw e
      }
      await this.markUncertain(i.id, user, false)
      return { user, vaultItem: vaultItemOf(i), field, message: opts.reset ? `${user} has a new password, kept in the vault.` : `${user} can now use the proxy. The password is in the vault.` }
    })
  }

  async removeUser(id: string, name: unknown, by: Actor): Promise<{ message: string }> {
    const i = await this.instance(id)
    const user = String(name ?? '').trim()
    if (userProblem(user)) throw new FwdProxyRefusal('bad_user', 'Not a user name.')
    return this.once(i, async () => {
      await this.audit('user_remove', i, by, { user })
      await this.run(i, `${HELPER} user-del ${sq(user)}`, 60_000)
      const vault = await this.d.vault.read(i.vault.category, i.vault.provider).catch(() => ({} as Record<string, string>))
      await this.d.vault.delete(i.vault.category, i.vault.provider, keyFor(user, vault.admin_user)).catch(() => {})
      await this.markUncertain(i.id, user, false)
      return { message: `${user} can no longer use the proxy.` }
    })
  }

  /** Who may use it, whether it may reach the LAN, and whether figures are kept per user and device. */
  async saveSettings(id: string, body: Record<string, unknown>, by: Actor): Promise<{ message: string; reading: ProxyReading }> {
    const i = await this.instance(id)
    const steps: Array<[string, string]> = []
    if (body.allow !== undefined) {
      const n = checkNetworks(Array.isArray(body.allow) ? body.allow.join(' ') : body.allow, { allowEmpty: false })
      if (n.problems.length) throw new FwdProxyRefusal('bad_networks', n.problems.join(' '))
      steps.push(['ALLOW', n.value])
    }
    if (body.lanTargets !== undefined) {
      if (typeof body.lanTargets !== 'boolean') throw new FwdProxyRefusal('bad_value', 'Reaching your network is on or off.')
      steps.push(['LAN_TARGETS', body.lanTargets ? '1' : '0'])
    }
    if (body.perClient !== undefined) {
      if (typeof body.perClient !== 'boolean') throw new FwdProxyRefusal('bad_value', 'Per-user figures are on or off.')
      steps.push(['PER_CLIENT', body.perClient ? '1' : '0'])
    }
    if (!steps.length) throw new FwdProxyRefusal('nothing', 'Nothing to change.')
    await this.once(i, async () => {
      await this.audit('settings', i, by, Object.fromEntries(steps.map(([k, v]) => [k.toLowerCase(), v])))
      for (const [k, v] of steps) await this.run(i, `${HELPER} set ${k} ${sq(v)}`, 60_000)
    })
    return { message: 'Saved, checked and reloaded.', reading: await this.reading(i.id, { fresh: true }) }
  }

  /** Stop looking after it. The proxy keeps running; auto-connect will not add it back by itself. */
  async disconnect(id: string, by: Actor): Promise<{ message: string }> {
    const i = await this.instance(id)
    await this.audit('disconnect', i, by)
    await this.d.dismissed(i.id, `${PROXY_NAME} on ${i.name}`, by.email)
    await this.d.store.delete(i.id)
    this.cache.delete(i.id)
    return { message: `${i.name} is no longer shown here. The proxy itself keeps running.` }
  }

  // ── auto-connect ──────────────────────────────────────────────────────────

  /** Finished Catalogue installs of 3proxy whose guest is still the one installed. */
  async sightings(): Promise<Array<{ guest: GuestRow; install: InstallRow }>> {
    const guests = await this.d.guests()
    const out: Array<{ guest: GuestRow; install: InstallRow }> = []
    for (const j of await this.d.installs()) {
      if (j.recipeId !== PROXY_ID || j.status !== 'completed' || !(j.vmid >= 100)) continue
      const g = guests.find(x => x.type === 'lxc' && x.vmid === j.vmid)
      if (!g || !installStillOwns(j, g)) continue
      if (!out.some(o => o.guest.vmid === g.vmid)) out.push({ guest: g, install: j })
    }
    return out
  }

  async autoConnect(ctx: AdapterContext): Promise<Outcome[]> {
    const out: Outcome[] = []
    const have = new Set((await this.instances()).map(i => i.id))
    for (const { guest: g, install } of await this.sightings()) {
      const key = `lxc-${g.vmid}`
      const label = `${PROXY_NAME} on ${g.name}`
      if (have.has(key)) { out.push({ key, label, did: 'present' }); continue }
      if (ctx.dismissed(key)) { out.push({ key, label, did: 'dismissed' }); continue }
      const why = exclusionOf(ctx, { machineId: key, tags: g.tags, addresses: install.ip ? [install.ip.split('/')[0]] : [] })
      if (why) { out.push({ key, label, did: 'excluded', message: why }); continue }
      if (!g.running) { out.push({ key, label, did: 'skipped', message: `${g.name} is not running: connected when it starts.` }); continue }
      try {
        const r = await this.d.exec({ vmid: g.vmid, node: g.node, name: g.name }, PROBE_SCRIPT, 20_000)
        const found = /^kind=(\S+)$/m.exec(r.output)?.[1]
        const listen = /^listen=(\d{1,3}(?:\.\d{1,3}){3})$/m.exec(r.output)?.[1] ?? null
        if (r.code !== 0 || found !== PROXY_ID) { out.push({ key, label, did: 'skipped', message: `${g.name} has no HyperProx ${PROXY_NAME} helper.` }); continue }
        const evidence = [`Catalogue install of ${PROXY_NAME} on CT ${g.vmid}`, `its helper answers${listen ? ` on ${listen}` : ''}`]
        const vault = install.vaultItem ?? { category: 'apps', provider: `${PROXY_ID}-${g.vmid}` }
        await ctx.audit('plugin.auto_connect', `plugin:${PROXY_ID}`, { guest: key, evidence, vaultItemName: `hyperprox:${vault.category}/${vault.provider}` })
        if (ctx.dismissed(key)) { out.push({ key, label, did: 'dismissed' }); continue }
        await this.d.store.put({ id: key, vmid: g.vmid, node: g.node, name: g.name, listen, vault, addedAt: ctx.now(), addedBy: SYSTEM_ACTOR, autoConnected: { at: ctx.now(), evidence } })
        out.push({ key, label, did: 'connected', evidence })
      } catch (e: any) {
        out.push({ key, label, did: 'failed', message: String(e?.message ?? e).slice(0, 300) })
      }
    }
    return out
  }
}

/** Read-only: is the helper there, which proxy it serves, and on which address. */
export const PROBE_SCRIPT = `f=/etc/hyperprox/fwdproxy.env
[ -r "$f" ] && [ -x ${HELPER} ] || exit 3
sed -n -e 's/^KIND=\\(.*\\)$/kind=\\1/p' -e 's/^LISTEN_IP=\\(.*\\)$/listen=\\1/p' "$f"`

/** The helper's self-check with the user's password on standard input (in the script, which travels on stdin). */
export function selfTestScript(user: string, password: string): string {
  if (userProblem(user)) throw new FwdProxyRefusal('bad_user', 'Not a user name.')
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(password)) throw new FwdProxyRefusal('bad_password', 'The stored password is not one HyperProx made.')
  return `${HELPER} selftest ${sq(user)} <<'HPX_PW'\n${password}\nHPX_PW`
}
