// =============================================================================
//  HyperProx — ASUS router: router instances
//
//  Each router HyperProx reads is an instance: a name, an address, the router's
//  admin login, and its certificate pin. Everything lives in the vault through
//  the credential store, laid out the way QNAP's and Home Assistant's
//  instances are:
//
//    plugin/asus        instances   the list: names, pins, what setup found
//                                   (model, firmware). No address, no login.
//    plugin/asus.<id>   url, username, password (masked) for each router.
//
//  The password goes only to the address it was entered for: a save that moves
//  the address to another host or port, or changes the user name, needs the
//  password again in the same save. A certificate pin belongs to one host and
//  port and is cleared when they change (and taken again on first use).
// =============================================================================

import crypto from 'node:crypto'
import { normaliseFingerprint } from '../clusters/tls-pin'
import { resolveAsusTarget, type TargetResolver } from './target'

export const PLUGIN_ID = 'asus'
export const CATEGORY = 'plugin'
export const INDEX_KEY = 'instances'
export const MAX_INSTANCES = 10
const ID_RE = /^a[0-9a-f]{8}$/

export interface AsusMeta {
  id:          string
  name:        string
  insecureTLS: boolean
  fingerprint: string | null
  /** What setup read from the router itself, so the list can say it without a login. */
  model:       string | null
  firmware:    string | null
  /**
   * Where `name` came from. `user`: typed by a person, and never changed by HyperProx. `device`: the unit's own
   * name (its AiMesh location or host name), kept in step with the unit. `model`: no better name was known yet.
   */
  nameSource:  'user' | 'device' | 'model'
  /** The unit's own name, as last read from it. */
  deviceName:  string | null
}

/** A name HyperProx made from the model ("ET-X", "ET-X 2", "ASUS router"), which a device name may replace. */
export function looksModelMade(name: string, model: string | null): boolean {
  const n = name.trim().toLowerCase()
  const bases = ['asus router', ...(model ? [model.toLowerCase()] : [])]
  return bases.some(b => n === b || new RegExp(`^${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\d{1,2}$`).test(n))
}

export interface AsusView extends AsusMeta { url: string; username: string; hasPassword: boolean }

export interface CredentialIO {
  get(category: string, provider: string, key: string): Promise<string | null>
  set(category: string, provider: string, key: string, value: string, masked: boolean): Promise<void>
  remove(category: string, provider: string): Promise<void>
}

export class AsusInputError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'AsusInputError' }
}

export const providerFor = (id: string) => `${PLUGIN_ID}.${id}`
export function validInstanceId(id: string): boolean { return ID_RE.test(id) }

export function cleanName(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim() : ''
  if (!s) throw new AsusInputError('Give the router a name, such as "Living room router".')
  if (s.length > 40) throw new AsusInputError('Keep the name to 40 characters.')
  return s
}

/** A router address: http(s), the router itself (no path), no login inside. A bare address gets http://. */
export function cleanUrl(v: unknown): string {
  let s = typeof v === 'string' ? v.trim().replace(/\/+$/, '') : ''
  if (s && !/^[a-z]+:\/\//i.test(s)) s = `http://${s}`
  let u: URL
  try { u = new URL(s) } catch { throw new AsusInputError('The address is the router\'s web page, such as http://10.0.0.1 or https://router.example.lan:8443.') }
  if (!['http:', 'https:'].includes(u.protocol)) throw new AsusInputError('The address must start with http:// or https://.')
  if (u.username || u.password) throw new AsusInputError('Leave the login out of the address; it is entered separately.')
  if (u.search || u.hash || (u.pathname && u.pathname !== '/')) throw new AsusInputError('The address is the router itself, with no path (http://10.0.0.1).')
  return `${u.protocol}//${u.host}`
}

export function cleanUser(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  // ':' would split the user from the password in login_authorization.
  if (!/^[A-Za-z0-9._@-]{1,32}$/.test(s)) throw new AsusInputError('Enter the router\'s admin user name (letters, digits, dot, dash, underscore, @).')
  return s
}

export function cleanPassword(v: unknown): string {
  const s = typeof v === 'string' ? v : ''
  if (!s || s.length > 128 || /[\u0000\r\n]/.test(s)) throw new AsusInputError('Enter the router\'s admin password.')
  return s
}

export function cleanFingerprint(v: unknown, prev: string | null): string | null {
  if (v === undefined) return prev
  if (v === null || v === '') return null
  const f = typeof v === 'string' ? normaliseFingerprint(v) : null
  if (!f) throw new AsusInputError('A pinned certificate is a SHA-256 fingerprint (64 hex characters).')
  return f
}

const short = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n) : null)

function parseIndex(raw: string | null): AsusMeta[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter(x => x && typeof x.id === 'string' && validInstanceId(x.id) && typeof x.name === 'string').map(x => ({
      id: x.id, name: String(x.name).slice(0, 40),
      insecureTLS: x.insecureTLS === true,
      fingerprint: typeof x.fingerprint === 'string' ? normaliseFingerprint(x.fingerprint) : null,
      model: short(x.model, 40), firmware: short(x.firmware, 40),
      // Instances from before names were read: a name equal to the model (or "model 2") was HyperProx's, not a person's.
      nameSource: x.nameSource === 'user' || x.nameSource === 'device' || x.nameSource === 'model' ? x.nameSource
        : looksModelMade(String(x.name), short(x.model, 40)) ? 'model' : 'user',
      deviceName: short(x.deviceName, 40),
    }))
  } catch { return [] }
}

export interface AsusInput {
  name?: unknown; url?: unknown; username?: unknown; password?: unknown; insecureTLS?: unknown; fingerprint?: unknown
}

export const endpointOf = (url: string) => { const u = new URL(url); return `${u.protocol}//${u.host}`.toLowerCase() }

/** A save, checked and ready, before anything is written. */
export interface Prepared {
  url: string; username: string; password: string | null
  insecureTLS: boolean; fingerprint: string | null
  moved: boolean; loginChanged: boolean
}

export class AsusInstanceStore {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private io: CredentialIO, private checkTarget: TargetResolver = resolveAsusTarget) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }

  async list(): Promise<AsusMeta[]> { return parseIndex(await this.io.get(CATEGORY, PLUGIN_ID, INDEX_KEY)) }

  async get(id: string): Promise<AsusMeta | null> {
    if (!validInstanceId(id)) return null
    return (await this.list()).find(i => i.id === id) ?? null
  }

  async views(): Promise<AsusView[]> {
    const out: AsusView[] = []
    for (const m of await this.list()) {
      const p = providerFor(m.id)
      out.push({ ...m, url: (await this.io.get(CATEGORY, p, 'url')) ?? '', username: (await this.io.get(CATEGORY, p, 'username')) ?? '', hasPassword: !!(await this.io.get(CATEGORY, p, 'password')) })
    }
    return out
  }

  /** Address and login, for the connection only. Never returned by a route. */
  async connection(id: string): Promise<{ meta: AsusMeta; url: string; username: string; password: string } | null> {
    const meta = await this.get(id)
    if (!meta) return null
    const p = providerFor(id)
    const [url, username, password] = await Promise.all([this.io.get(CATEGORY, p, 'url'), this.io.get(CATEGORY, p, 'username'), this.io.get(CATEGORY, p, 'password')])
    if (!url || !username || !password) return null
    return { meta, url, username, password }
  }

  private async checkAddress(url: string): Promise<void> {
    try { await this.checkTarget(new URL(url)) } catch (e: any) { throw new AsusInputError(e?.message ?? 'That address is not allowed.') }
  }

  /** Check a save without writing it: a new router (id null) or a change to one. */
  async prepare(id: string | null, input: AsusInput): Promise<Prepared> {
    if (id === null) {
      const url = cleanUrl(input.url)
      await this.checkAddress(url)
      return {
        url, username: cleanUser(input.username), password: cleanPassword(input.password),
        insecureTLS: input.insecureTLS === true, fingerprint: cleanFingerprint(input.fingerprint, null), moved: true, loginChanged: true,
      }
    }
    const prev = await this.get(id)
    if (!prev) throw new AsusInputError('No such router.', 404)
    const p = providerFor(id)
    const oldUrl = (await this.io.get(CATEGORY, p, 'url')) ?? ''
    const oldUser = (await this.io.get(CATEGORY, p, 'username')) ?? ''
    const url = input.url === undefined ? oldUrl : cleanUrl(input.url)
    const username = input.username === undefined ? oldUser : cleanUser(input.username)
    const moved = !oldUrl || endpointOf(url) !== endpointOf(oldUrl)
    const password = input.password === undefined || input.password === '' ? null : cleanPassword(input.password)
    if ((moved || username !== oldUser) && !password) throw new AsusInputError('The address or user name changed, so enter the password again in the same save.')
    const insecureTLS = input.insecureTLS === undefined ? prev.insecureTLS : input.insecureTLS === true
    const fingerprint = cleanFingerprint(input.fingerprint, moved ? null : prev.fingerprint)
    // Loosening how the router is recognised is as weighty as entering its login: removing the pin or accepting any
    // certificate needs the password in the same save (and the save proves it, through the new rule).
    const pinCleared = !moved && !!prev.fingerprint && fingerprint === null
    const insecureOn = insecureTLS && !prev.insecureTLS
    if ((pinCleared || insecureOn) && !password) throw new AsusInputError(`${pinCleared ? 'Removing the certificate pin' : 'Accepting any certificate'} needs the router's password again in the same save.`)
    await this.checkAddress(url)
    return { url, username, password, insecureTLS, fingerprint, moved, loginChanged: moved || username !== oldUser || !!password }
  }

  private uniqueName(list: AsusMeta[], want: string, except: string | null): string {
    const taken = (n: string) => list.some(i => i.id !== except && i.name.toLowerCase() === n.toLowerCase())
    if (!taken(want)) return want
    for (let i = 2; i < 100; i++) { const n = `${want.slice(0, 36)} ${i}`; if (!taken(n)) return n }
    throw new AsusInputError('Another router already has that name.', 409)
  }

  /** Write a new router. `name` blank: the unit's own name, else the model setup found, else "ASUS router". */
  async create(p: Prepared, name: unknown, found: { model: string | null; firmware: string | null; deviceName?: string | null }): Promise<AsusMeta> {
    return this.serial(async () => {
      const list = await this.list()
      if (list.length >= MAX_INSTANCES) throw new AsusInputError(`HyperProx holds up to ${MAX_INSTANCES} routers.`)
      const explicit = typeof name === 'string' && name.trim() !== ''
      const own = short(found.deviceName ?? null, 40)
      const base = explicit ? cleanName(name) : (own ?? found.model ?? 'ASUS router')
      if (explicit && list.some(i => i.name.toLowerCase() === base.toLowerCase())) throw new AsusInputError('Another router already has that name.', 409)
      const meta: AsusMeta = {
        id: `a${crypto.randomBytes(4).toString('hex')}`, name: explicit ? base : this.deviceLabel(list, base, short(found.model, 40), null),
        insecureTLS: p.insecureTLS, fingerprint: p.fingerprint, model: short(found.model, 40), firmware: short(found.firmware, 40),
        nameSource: explicit ? 'user' : own ? 'device' : 'model', deviceName: own,
      }
      const prov = providerFor(meta.id)
      await this.io.set(CATEGORY, prov, 'url', p.url, false)
      await this.io.set(CATEGORY, prov, 'username', p.username, false)
      await this.io.set(CATEGORY, prov, 'password', p.password!, true)
      await this.io.set(CATEGORY, PLUGIN_ID, INDEX_KEY, JSON.stringify([...list, meta]), false)
      return meta
    })
  }

  async update(id: string, p: Prepared, name: unknown, found: { model: string | null; firmware: string | null } | null): Promise<AsusMeta> {
    return this.serial(async () => {
      const list = await this.list()
      const prev = list.find(i => i.id === id)
      if (!prev) throw new AsusInputError('No such router.', 404)
      // A typed name is the person's. A blank one hands naming back to the unit (its own name, else its model).
      const model = found ? short(found.model, 40) : prev.model
      const cleared = typeof name === 'string' && name.trim() === ''
      const typed = name !== undefined && !cleared ? cleanName(name) : null
      if (typed && list.some(i => i.id !== id && i.name.toLowerCase() === typed.toLowerCase())) throw new AsusInputError('Another router already has that name.', 409)
      const own = prev.deviceName
      const nm = typed ?? (cleared ? this.deviceLabel(list, own ?? model ?? 'ASUS router', model, id) : prev.name)
      const next: AsusMeta = {
        id, name: nm, insecureTLS: p.insecureTLS, fingerprint: p.fingerprint,
        model, firmware: found ? short(found.firmware, 40) : prev.firmware,
        nameSource: typed ? (typed === prev.name ? prev.nameSource : 'user') : cleared ? (own ? 'device' : 'model') : prev.nameSource,
        deviceName: own,
      }
      const prov = providerFor(id)
      await this.io.set(CATEGORY, prov, 'url', p.url, false)
      await this.io.set(CATEGORY, prov, 'username', p.username, false)
      if (p.password) await this.io.set(CATEGORY, prov, 'password', p.password, true)
      await this.io.set(CATEGORY, PLUGIN_ID, INDEX_KEY, JSON.stringify(list.map(i => i.id === id ? next : i)), false)
      return next
    })
  }

  /**
   * A name for a unit that is not taken by another router: its own name, then "Living Room (ET-X)" when another
   * router already has it (two units of one mesh, say), then a number.
   */
  private deviceLabel(list: AsusMeta[], base: string, model: string | null, except: string | null): string {
    const taken = (n: string) => list.some(i => i.id !== except && i.name.toLowerCase() === n.toLowerCase())
    if (!taken(base)) return base.slice(0, 40)
    const withModel = model && !base.toLowerCase().includes(model.toLowerCase()) ? `${base.slice(0, 40 - model.length - 3)} (${model})` : base
    return this.uniqueName(list, withModel.slice(0, 40), except)
  }

  /**
   * The unit's own name, read on the 5-minute settings cycle. A name a person typed is never touched; any other
   * follows the unit, so renaming it in the ASUS app renames it here.
   */
  async adoptDeviceName(id: string, deviceName: string | null): Promise<AsusMeta | null> {
    return this.serial(async () => {
      const list = await this.list()
      const prev = list.find(i => i.id === id)
      if (!prev) return null
      const own = short(deviceName, 40)
      if (prev.nameSource === 'user' || !own) {
        if (own === prev.deviceName) return prev
        const next = { ...prev, deviceName: own ?? prev.deviceName }
        await this.io.set(CATEGORY, PLUGIN_ID, INDEX_KEY, JSON.stringify(list.map(i => i.id === id ? next : i)), false)
        return next
      }
      const current = prev.nameSource === 'device' && prev.deviceName === own ? prev.name : this.deviceLabel(list, own, prev.model, id)
      if (current === prev.name && prev.nameSource === 'device' && prev.deviceName === own) return prev
      const next: AsusMeta = { ...prev, name: current, nameSource: 'device', deviceName: own }
      await this.io.set(CATEGORY, PLUGIN_ID, INDEX_KEY, JSON.stringify(list.map(i => i.id === id ? next : i)), false)
      return next
    })
  }

  /** What a later reading learned (a firmware update installed), kept so the list stays current. */
  async noteFound(id: string, found: { model: string | null; firmware: string | null }): Promise<void> {
    return this.serial(async () => {
      const list = await this.list()
      const prev = list.find(i => i.id === id)
      if (!prev) return
      const model = short(found.model, 40) ?? prev.model, firmware = short(found.firmware, 40) ?? prev.firmware
      if (model === prev.model && firmware === prev.firmware) return
      await this.io.set(CATEGORY, PLUGIN_ID, INDEX_KEY, JSON.stringify(list.map(i => i.id === id ? { ...i, model, firmware } : i)), false)
    })
  }

  async remove(id: string): Promise<void> {
    return this.serial(async () => {
      const list = await this.list()
      if (!list.some(i => i.id === id)) throw new AsusInputError('No such router.', 404)
      await this.io.remove(CATEGORY, providerFor(id))
      await this.io.set(CATEGORY, PLUGIN_ID, INDEX_KEY, JSON.stringify(list.filter(i => i.id !== id)), false)
    })
  }
}
