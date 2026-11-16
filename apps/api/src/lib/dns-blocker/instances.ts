// =============================================================================
//  HyperProx — DNS blockers: the instances HyperProx looks after
//
//  Kept in the vault through the credential store, laid out like the QNAP and Nextcloud instances, once per product
//  (plugin/pihole and plugin/adguard):
//
//    plugin/<kind>          instances   the list: names, which guest, flags. No address, no login.
//    plugin/<kind>.<id>     url, username (AdGuard), password (masked), insecure_tls
//
//  The password goes only to the address it was entered for: a save that moves the address needs the password again in
//  the same save. Nothing here returns a password; the service reads it only to sign in.
// =============================================================================

import crypto from 'node:crypto'
import { DnsRefusal, type AutoConnected, type DnsKind, type DnsMeta, type DnsView, type GuestRef } from './types'

export const CATEGORY = 'plugin'
export const INDEX_KEY = 'instances'
export const MAX_INSTANCES = 5
const ID_RE = /^d[0-9a-f]{8}$/
const USER_RE = /^[A-Za-z0-9_.@-]{1,64}$/

export interface CredentialIO {
  get(category: string, provider: string, key: string): Promise<string | null>
  set(category: string, provider: string, key: string, value: string, masked: boolean): Promise<void>
  remove(category: string, provider: string): Promise<void>
}

export const providerFor = (kind: DnsKind, id: string) => `${kind}.${id}`
export const validInstanceId = (id: string) => ID_RE.test(id)

const bad = (msg: string) => new DnsRefusal('bad_input', msg, 400)

export function cleanName(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim() : ''
  if (!s) throw bad('Give it a name, such as "Pi-hole".')
  if (s.length > 40) throw bad('Keep the name to 40 characters.')
  return s
}

export function cleanGuest(v: unknown): GuestRef | null {
  if (v === null || v === undefined || v === '') return null
  const g = (v ?? {}) as Record<string, unknown>
  const kind = g.kind === 'lxc' || g.kind === 'qemu' ? g.kind : null
  const vmid = Number(g.vmid)
  if (!kind || !Number.isInteger(vmid) || vmid < 100 || vmid > 999_999_999) throw bad('Pick the container or VM it runs in, or leave it blank.')
  return { kind, vmid }
}

/** The address people use for the blocker's web page: http(s)://host[:port], no login, path, query or fragment. */
export function cleanUrl(v: unknown): string {
  const s = typeof v === 'string' ? v.trim().replace(/\/+$/, '') : ''
  let u: URL
  try { u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `http://${s}`) } catch { throw bad('The address is where you open its web page, such as http://192.0.2.10.') }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad('The address starts with http:// or https://.')
  if (u.username || u.password) throw bad('Leave the login out of the address; it is entered separately.')
  if (u.search || u.hash) throw bad('The address has no ? or # part.')
  if (u.pathname !== '/' && u.pathname !== '') throw bad('Use the address of the web page itself, with no path after the port.')
  return `${u.protocol}//${u.host}`
}

export function cleanUser(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!USER_RE.test(s)) throw bad('The user name is the one you sign in to AdGuard Home with, such as admin.')
  return s
}

export function cleanPassword(v: unknown): string {
  const s = typeof v === 'string' ? v : ''
  if (!s || s.length > 256 || /[\u0000-\u001f\u007f]/.test(s)) throw bad('Enter the password you sign in to the blocker with.')
  return s
}

const originOf = (url: string) => { try { return new URL(url).origin.toLowerCase() } catch { return url.toLowerCase() } }

function parseIndex(kind: DnsKind, raw: string | null): DnsMeta[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter(x => x && typeof x.id === 'string' && validInstanceId(x.id) && typeof x.name === 'string').map(x => {
      let guest: GuestRef | null = null
      try { guest = cleanGuest(x.guest) } catch { guest = null }
      const ac = x.autoConnected && typeof x.autoConnected === 'object' ? x.autoConnected : null
      const autoConnected: AutoConnected | undefined = ac ? {
        at: String(ac.at ?? '').slice(0, 40), evidence: (Array.isArray(ac.evidence) ? ac.evidence : []).map(String).map((e: string) => e.slice(0, 120)).slice(0, 10),
        vaultItem: typeof ac.vaultItem === 'string' ? ac.vaultItem.slice(0, 120) : null,
      } : undefined
      const gd = x.guestDns && typeof x.guestDns === 'object' ? x.guestDns : null
      const guestDns = gd && typeof gd.address === 'string' && Array.isArray(gd.previous)
        ? { address: gd.address.slice(0, 64), previous: gd.previous.map(String).slice(0, 3) } : null
      const meta: DnsMeta = {
        id: x.id, kind, name: String(x.name).slice(0, 40), guest, hideClients: x.hideClients === true,
        addedAt: typeof x.addedAt === 'string' ? x.addedAt.slice(0, 40) : '', ...(autoConnected ? { autoConnected } : {}), ...(guestDns ? { guestDns } : {}),
      }
      return meta
    })
  } catch { return [] }
}

/** Why a login change must be refused before anything is sent, or null: a stored password goes only to the origin it was entered for. */
export function loginChangeProblem(prev: { url: string | null; password: string | null }, next: { url: string | null; password: string | null }): string | null {
  if (!prev.password || next.password) return null
  if (next.url && prev.url && originOf(next.url) !== originOf(prev.url)) return 'The address now points somewhere else, so enter the password again in the same save.'
  if (next.url && !prev.url) return 'A new address needs the password again in the same save.'
  return null
}

export interface DnsInput {
  name?: unknown; guest?: unknown; url?: unknown; username?: unknown; password?: unknown; hideClients?: unknown; insecureTLS?: unknown
}

export interface Login { url: string; username: string | null; password: string; insecureTLS: boolean }

export class DnsInstanceStore {
  private chain: Promise<unknown> = Promise.resolve()
  constructor(readonly kind: DnsKind, private io: CredentialIO) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }

  async list(): Promise<DnsMeta[]> { return parseIndex(this.kind, await this.io.get(CATEGORY, this.kind, INDEX_KEY)) }
  async get(id: string): Promise<DnsMeta | null> { return validInstanceId(id) ? (await this.list()).find(m => m.id === id) ?? null : null }
  private async write(list: DnsMeta[]): Promise<void> {
    await this.io.set(CATEGORY, this.kind, INDEX_KEY, JSON.stringify(list.map(({ kind: _k, ...m }) => m)), false)
  }

  /** The stored login for one instance; null when it has none. The password never leaves the service. */
  async login(id: string): Promise<Login | null> {
    const p = providerFor(this.kind, id)
    const [url, username, password, insecure] = await Promise.all([this.io.get(CATEGORY, p, 'url'), this.io.get(CATEGORY, p, 'username'), this.io.get(CATEGORY, p, 'password'), this.io.get(CATEGORY, p, 'insecure_tls')])
    if (!url || !password) return null
    return { url, username: username || null, password, insecureTLS: insecure === '1' }
  }

  async view(m: DnsMeta): Promise<DnsView> {
    const l = await this.login(m.id)
    return { ...m, url: l?.url ?? null, hasPassword: !!l?.password, insecureTLS: l?.insecureTLS ?? false }
  }
  async views(): Promise<DnsView[]> { return Promise.all((await this.list()).map(m => this.view(m))) }

  private async writeLogin(id: string, l: { url: string | null; username: string | null; password: string | null; insecureTLS: boolean | null }): Promise<void> {
    const p = providerFor(this.kind, id)
    if (l.url !== null) await this.io.set(CATEGORY, p, 'url', l.url, false)
    if (l.username !== null) await this.io.set(CATEGORY, p, 'username', l.username, false)
    if (l.password !== null) await this.io.set(CATEGORY, p, 'password', l.password, true)
    if (l.insecureTLS !== null) await this.io.set(CATEGORY, p, 'insecure_tls', l.insecureTLS ? '1' : '', false)
  }

  async create(input: { name: string; guest: GuestRef | null; url: string; username: string | null; password: string; insecureTLS?: boolean; autoConnected?: AutoConnected }): Promise<DnsMeta> {
    return this.serial(async () => {
      const list = await this.list()
      if (list.length >= MAX_INSTANCES) throw bad(`HyperProx looks after up to ${MAX_INSTANCES} of these.`)
      if (input.guest && list.some(m => m.guest && m.guest.kind === input.guest!.kind && m.guest.vmid === input.guest!.vmid)) throw new DnsRefusal('duplicate', 'That guest is already added.', 409)
      const meta: DnsMeta = {
        id: `d${crypto.randomBytes(4).toString('hex')}`, kind: this.kind, name: input.name, guest: input.guest, hideClients: false,
        addedAt: new Date().toISOString(), ...(input.autoConnected ? { autoConnected: input.autoConnected } : {}),
      }
      await this.writeLogin(meta.id, { url: input.url, username: input.username, password: input.password, insecureTLS: input.insecureTLS ?? false })
      await this.write([...list, meta])
      return meta
    })
  }

  /** Change the name, the guest, the privacy setting or the login. A new address needs the password again in the same save. */
  async update(id: string, input: DnsInput): Promise<{ meta: DnsMeta; loginChanged: boolean }> {
    return this.serial(async () => {
      const list = await this.list()
      const i = list.findIndex(m => m.id === id)
      if (i < 0) throw new DnsRefusal('no_instance', 'No such blocker.', 404)
      const prev = await this.login(id)
      const url = input.url === undefined || input.url === '' ? null : cleanUrl(input.url)
      const username = input.username === undefined || input.username === '' ? null : cleanUser(input.username)
      const pw = input.password === undefined || input.password === '' ? null : cleanPassword(input.password)
      const problem = loginChangeProblem({ url: prev?.url ?? null, password: prev?.password ?? null }, { url, password: pw })
      if (problem) throw bad(problem)
      const insecure = input.insecureTLS === undefined ? null : input.insecureTLS === true
      if (url !== null || username !== null || pw !== null || insecure !== null) await this.writeLogin(id, { url, username, password: pw, insecureTLS: insecure })
      const guest = input.guest === undefined ? list[i].guest : cleanGuest(input.guest)
      list[i] = {
        ...list[i], guest,
        name: input.name === undefined ? list[i].name : cleanName(input.name),
        hideClients: input.hideClients === undefined ? list[i].hideClients : input.hideClients === true,
      }
      await this.write(list)
      return { meta: list[i], loginChanged: url !== null || username !== null || pw !== null }
    })
  }

  async setGuestDns(id: string, v: DnsMeta['guestDns']): Promise<void> {
    await this.serial(async () => {
      const list = await this.list()
      const i = list.findIndex(m => m.id === id)
      if (i < 0) return
      const { guestDns: _g, ...rest } = list[i]
      list[i] = v ? { ...rest, guestDns: v } : rest
      await this.write(list)
    })
  }

  async remove(id: string): Promise<void> {
    await this.serial(async () => {
      const list = await this.list()
      if (!list.some(m => m.id === id)) throw new DnsRefusal('no_instance', 'No such blocker.', 404)
      await this.io.remove(CATEGORY, providerFor(this.kind, id))
      await this.write(list.filter(m => m.id !== id))
    })
  }
}
