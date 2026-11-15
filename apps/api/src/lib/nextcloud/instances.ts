// =============================================================================
//  HyperProx — Nextcloud: the instances HyperProx looks after
//
//  Kept in the vault through the credential store, laid out like the PBS and
//  QNAP instances:
//
//    plugin/nextcloud           instances   the list: names, which guest, the
//                                           detected deployment, snoozes. No
//                                           address, no login.
//    plugin/nextcloud.<id>      url, user, app_password (masked): the optional
//                               OCS login (an admin's app password), used only
//                               for read-only calls to that address.
//    plugin/nextcloud.<id>.smtp password (masked): the mail server password the
//                               SMTP form saved, kept so it can be written again.
//
//  The app password goes only to the address it was entered for: a save that
//  moves the address needs the password again in the same save.
// =============================================================================

import crypto from 'node:crypto'
import { NcRefusal, type GuestRef, type NcMeta, type NcView } from './types'
import type { Deployment } from './detect'

export const PLUGIN_ID = 'nextcloud'
export const CATEGORY = 'plugin'
export const INDEX_KEY = 'instances'
export const MAX_INSTANCES = 10
const ID_RE = /^n[0-9a-f]{8}$/
/** Nextcloud app passwords: five groups of five letters and digits, dash-separated (or a raw 72-char token). */
const APP_PASSWORD_RE = /^(?:[A-Za-z0-9]{5}-){4}[A-Za-z0-9]{5}$|^[A-Za-z0-9]{32,128}$/
const USER_RE = /^[A-Za-z0-9_.@-]{1,64}$/

export interface CredentialIO {
  get(category: string, provider: string, key: string): Promise<string | null>
  set(category: string, provider: string, key: string, value: string, masked: boolean): Promise<void>
  remove(category: string, provider: string): Promise<void>
}

export const providerFor = (id: string) => `${PLUGIN_ID}.${id}`
export const smtpProviderFor = (id: string) => `${PLUGIN_ID}.${id}.smtp`
export const validInstanceId = (id: string) => ID_RE.test(id)

const bad = (msg: string) => new NcRefusal('bad_input', msg, 400)

export function cleanName(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim() : ''
  if (!s) throw bad('Give it a name, such as "Cloud".')
  if (s.length > 40) throw bad('Keep the name to 40 characters.')
  return s
}

export function cleanGuest(v: unknown): GuestRef {
  const g = (v ?? {}) as Record<string, unknown>
  const kind = g.kind === 'lxc' || g.kind === 'qemu' ? g.kind : null
  const vmid = Number(g.vmid)
  if (!kind || !Number.isInteger(vmid) || vmid < 100 || vmid > 999_999_999) throw bad('Pick the container or VM Nextcloud runs in.')
  return { kind, vmid }
}

/** The address people use for Nextcloud: http(s)://host[:port][/path], no login, query or fragment. */
export function cleanUrl(v: unknown): string {
  const s = typeof v === 'string' ? v.trim().replace(/\/+$/, '') : ''
  let u: URL
  try { u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`) } catch { throw bad('The address is where you open Nextcloud, such as https://cloud.example.com.') }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad('The address starts with https:// (or http:// on your own network).')
  if (u.username || u.password) throw bad('Leave the login out of the address; it is entered separately.')
  if (u.search || u.hash) throw bad('The address has no ? or # part.')
  if (!/^(\/[A-Za-z0-9._~-]+)*\/?$/.test(u.pathname)) throw bad('That path is not one Nextcloud is served under.')
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`
}

export function cleanUser(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!USER_RE.test(s)) throw bad('The admin user is the Nextcloud login name, such as admin.')
  return s
}

export function cleanAppPassword(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!APP_PASSWORD_RE.test(s)) throw bad('Paste an app password (Personal settings → Security → Create new app password); it looks like abcde-fghij-klmno-pqrst-uvwxy.')
  return s
}

const originOf = (url: string) => { try { return new URL(url).origin.toLowerCase() } catch { return url.toLowerCase() } }

function parseIndex(raw: string | null): NcMeta[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter(x => x && typeof x.id === 'string' && validInstanceId(x.id) && typeof x.name === 'string').map(x => {
      let guest: GuestRef
      try { guest = cleanGuest(x.guest) } catch { guest = { kind: 'lxc', vmid: 0 } }
      const snoozed: Record<string, string> = {}
      for (const [k, t] of Object.entries(x.snoozed ?? {})) if (/^[A-Za-z0-9_\\:-]{1,160}$/.test(k) && typeof t === 'string' && (t === 'forever' || !Number.isNaN(Date.parse(t)))) snoozed[k] = t
      return { id: x.id, name: String(x.name).slice(0, 40), guest, deployment: (x.deployment ?? null) as Deployment | null, snoozed, addedAt: typeof x.addedAt === 'string' ? x.addedAt.slice(0, 40) : '' }
    }).filter(m => m.guest.vmid > 0)
  } catch { return [] }
}

export interface NcInput { name?: unknown; guest?: unknown; url?: unknown; user?: unknown; appPassword?: unknown }

export class NcInstanceStore {
  private chain: Promise<unknown> = Promise.resolve()
  constructor(private io: CredentialIO) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }

  async list(): Promise<NcMeta[]> { return parseIndex(await this.io.get(CATEGORY, PLUGIN_ID, INDEX_KEY)) }
  async get(id: string): Promise<NcMeta | null> { return validInstanceId(id) ? (await this.list()).find(m => m.id === id) ?? null : null }
  private async write(list: NcMeta[]): Promise<void> { await this.io.set(CATEGORY, PLUGIN_ID, INDEX_KEY, JSON.stringify(list), false) }

  /** The OCS login; null parts when none is set. The password never leaves the service. */
  async login(id: string): Promise<{ url: string | null; user: string | null; appPassword: string | null }> {
    const p = providerFor(id)
    const [url, user, appPassword] = await Promise.all([this.io.get(CATEGORY, p, 'url'), this.io.get(CATEGORY, p, 'user'), this.io.get(CATEGORY, p, 'app_password')])
    return { url, user, appPassword }
  }

  async view(m: NcMeta): Promise<NcView> {
    const l = await this.login(m.id)
    return { ...m, url: l.url, user: l.user, hasAppPassword: !!l.appPassword }
  }

  async views(): Promise<NcView[]> { return Promise.all((await this.list()).map(m => this.view(m))) }

  async create(input: { name: string; guest: GuestRef; deployment: Deployment | null; url: string | null; user: string | null; appPassword: string | null }): Promise<NcMeta> {
    return this.serial(async () => {
      const list = await this.list()
      if (list.length >= MAX_INSTANCES) throw bad(`HyperProx looks after up to ${MAX_INSTANCES} Nextcloud instances.`)
      if (list.some(m => m.guest.kind === input.guest.kind && m.guest.vmid === input.guest.vmid)) throw new NcRefusal('duplicate', 'That guest is already added.', 409)
      const meta: NcMeta = { id: `n${crypto.randomBytes(4).toString('hex')}`, name: input.name, guest: input.guest, deployment: input.deployment, snoozed: {}, addedAt: new Date().toISOString() }
      await this.writeLogin(meta.id, input)
      await this.write([...list, meta])
      return meta
    })
  }

  private async writeLogin(id: string, l: { url: string | null; user: string | null; appPassword: string | null }): Promise<void> {
    const p = providerFor(id)
    if (l.url !== null) await this.io.set(CATEGORY, p, 'url', l.url, false)
    if (l.user !== null) await this.io.set(CATEGORY, p, 'user', l.user, false)
    if (l.appPassword !== null) await this.io.set(CATEGORY, p, 'app_password', l.appPassword, true)
  }

  /**
   * Change the name or the OCS login. A new address (another origin) needs the app password again in the same save,
   * so a stored password is never sent to an address it was not entered for.
   */
  async update(id: string, input: NcInput): Promise<NcMeta> {
    return this.serial(async () => {
      const list = await this.list()
      const i = list.findIndex(m => m.id === id)
      if (i < 0) throw new NcRefusal('no_instance', 'No such Nextcloud.', 404)
      const prev = await this.login(id)
      const url = input.url === undefined ? null : input.url === '' ? '' : cleanUrl(input.url)
      const user = input.user === undefined || input.user === '' ? null : cleanUser(input.user)
      const pw = input.appPassword === undefined || input.appPassword === '' ? null : cleanAppPassword(input.appPassword)
      if (url && prev.url && originOf(url) !== originOf(prev.url) && !pw && prev.appPassword) throw bad('The address now points somewhere else, so enter the app password again in the same save.')
      if (user && prev.user && user !== prev.user && !pw && prev.appPassword) throw bad('A different user needs its own app password: enter it in the same save.')
      const name = input.name === undefined ? list[i].name : cleanName(input.name)
      if (url === '') {
        // Removing the address removes the OCS login with it.
        await this.io.remove(CATEGORY, providerFor(id))
      } else await this.writeLogin(id, { url, user, appPassword: pw })
      list[i] = { ...list[i], name }
      await this.write(list)
      return list[i]
    })
  }

  async setDeployment(id: string, d: Deployment | null): Promise<void> {
    await this.serial(async () => {
      const list = await this.list()
      const i = list.findIndex(m => m.id === id)
      if (i < 0) return
      list[i] = { ...list[i], deployment: d }
      await this.write(list)
    })
  }

  async snooze(id: string, check: string, until: string | null): Promise<NcMeta> {
    return this.serial(async () => {
      const list = await this.list()
      const i = list.findIndex(m => m.id === id)
      if (i < 0) throw new NcRefusal('no_instance', 'No such Nextcloud.', 404)
      const s = { ...list[i].snoozed }
      if (until === null) delete s[check]; else s[check] = until
      list[i] = { ...list[i], snoozed: s }
      await this.write(list)
      return list[i]
    })
  }

  async remove(id: string): Promise<void> {
    await this.serial(async () => {
      const list = await this.list()
      if (!list.some(m => m.id === id)) throw new NcRefusal('no_instance', 'No such Nextcloud.', 404)
      await this.io.remove(CATEGORY, providerFor(id))
      await this.io.remove(CATEGORY, smtpProviderFor(id))
      await this.write(list.filter(m => m.id !== id))
    })
  }

  async saveSmtpPassword(id: string, password: string): Promise<void> {
    await this.io.set(CATEGORY, smtpProviderFor(id), 'password', password, true)
  }
  async smtpPassword(id: string): Promise<string | null> { return this.io.get(CATEGORY, smtpProviderFor(id), 'password') }
}
