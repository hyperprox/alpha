// =============================================================================
//  HyperProx — Proxy instances: the registry every caller goes through
//
//  Instances come from two places: the old single NPM login (Settings → Proxy,
//  hyperprox:proxy/npm), shown as the instance "npm" so nothing changes for an
//  existing install; and the instances added on the Proxy page, any kind, any
//  number, two of the same kind included.
//
//  Host lists are cached per instance for 20 s (every write clears its
//  instance), fetched in parallel with a per-instance timeout, so one slow
//  proxy cannot hold the table. Previews and applies always read fresh.
// =============================================================================

import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { KINDS, buildProvider, secretKeys, settingKeys, type BuildDeps } from './kinds'
import { learnHostKey } from './transport'
import type { InstanceSecrets, ProxyStore, StoredInstance } from './store'
import {
  KIND_LABEL, PROXY_KINDS, ProxyRefusal,
  type ManagedRef, type ProxyCertificate, type ProxyHealth, type ProxyHostRecord, type ProxyHostView, type ProxyInstance, type ProxyKind, type ProxyProvider,
} from './types'

export const LEGACY_NPM_ID = 'npm'
const CACHE_MS = 20_000
const INSTANCE_TIMEOUT_MS = 8_000

export interface LegacyNpm { url: string; email: string; password: string }

export interface ServiceDeps extends BuildDeps {
  store:   ProxyStore
  secrets: InstanceSecrets
  /** The old single NPM login, or null when it is not set. Throws while the vault is locked. */
  legacyNpm(): Promise<LegacyNpm | null>
  /** Fetch an SSH server's host key, to pin when an instance is added. */
  learnHostKey?(host: string, port: number): Promise<string>
  /** A hostname's addresses, to refuse loopback and link-local targets. */
  resolve?(host: string): Promise<string[]>
  /** The Catalogue's rule for a container HyperProx may manage: refuses with the reason, or resolves. */
  checkManagedTarget?(ref: ManagedRef): Promise<void>
  now?(): number
  /** How long one instance may take to list its hosts before the table goes on without it. */
  instanceTimeoutMs?: number
}

export interface Actor { email: string }

export interface InstanceInput {
  kind?:     string
  name?:     string
  url?:      string
  mode?:     string
  managed?:  { node?: unknown; vmid?: unknown; recipe?: unknown } | null
  settings?: Record<string, unknown>
  secrets?:  Record<string, unknown>
}

/** An instance as the API returns it to admins: which secrets are set, never their values. */
export interface InstanceView extends ProxyInstance { kindLabel: string; secretsSet: string[] }

export interface HostsResult { hosts: ProxyHostView[]; errors: Array<{ instanceId: string; instanceName: string; error: string }> }

const ID_RE = /^px-[a-z0-9]{10}$/

/** Loopback, link-local and unspecified addresses: HyperProx's own services and cloud metadata live there. */
export function isLocalAddress(addr: string): boolean {
  const a = addr.replace(/^\[|\]$/g, '').toLowerCase()
  if (isIP(a) === 4) {
    const [x, y] = a.split('.').map(Number)
    return x === 127 || x === 0 || (x === 169 && y === 254)
  }
  if (isIP(a) === 6) {
    if (a === '::1' || a === '::') return true
    if (/^fe[89ab][0-9a-f]:/.test(a)) return true
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a)
    return m ? isLocalAddress(m[1]) : false
  }
  return false
}

async function checkUrl(raw: unknown, managed: boolean, resolve: (h: string) => Promise<string[]>): Promise<string> {
  const v = String(raw ?? '').trim().replace(/\/+$/, '')
  let u: URL
  try { u = new URL(v) } catch { throw new ProxyRefusal(`"${v}" is not a URL.`, 400) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ProxyRefusal('The URL must start with http:// or https://.', 400)
  if (u.username || u.password) throw new ProxyRefusal('Put credentials in their own fields, not in the URL.', 400)
  if (!managed) {
    const host = u.hostname.replace(/^\[|\]$/g, '')
    const local = 'is a loopback or link-local address; only a Managed instance, reached through its own container, may use one.'
    if (host === 'localhost' || host.endsWith('.localhost')) throw new ProxyRefusal(`${host} ${local}`, 400)
    if (isIP(host)) { if (isLocalAddress(host)) throw new ProxyRefusal(`${host} ${local}`, 400) }
    else {
      const addrs = await resolve(host).catch(() => [] as string[])
      const bad = addrs.find(isLocalAddress)
      if (bad) throw new ProxyRefusal(`${host} resolves to ${bad}, which ${local.slice(3)}`, 400)
    }
  }
  return v
}

function checkManaged(m: InstanceInput['managed']): ManagedRef | null {
  if (!m) return null
  const node = String(m.node ?? '').trim()
  const vmid = Number(m.vmid)
  const recipe = String(m.recipe ?? '').trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$/.test(node)) throw new ProxyRefusal('A Managed instance needs the node its container is on.', 400)
  if (!Number.isInteger(vmid) || vmid < 100 || vmid > 999_999_999) throw new ProxyRefusal('A Managed instance needs its container id.', 400)
  return { node, vmid, recipe: recipe || 'unknown' }
}

/** A promise that gives up after `ms` with a plain reason. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`no answer within ${ms / 1000}s`)), ms)
    p.then(v => { clearTimeout(t); res(v) }, e => { clearTimeout(t); rej(e) })
  })
}

export class ProxyService {
  private cache = new Map<string, { at: number; hosts: ProxyHostView[] }>()
  constructor(private d: ServiceDeps) {}
  private now() { return this.d.now ? this.d.now() : Date.now() }

  kinds() { return PROXY_KINDS.map(k => ({ ...KINDS[k], fields: KINDS[k].fields.map(f => ({ ...f, required: typeof f.required === 'function' ? 'conditional' : f.required })) })) }

  // --- instances -------------------------------------------------------------------------------------

  private async legacy(): Promise<ProxyInstance | null> {
    const base = { id: LEGACY_NPM_ID, kind: 'npm' as const, name: 'Nginx Proxy Manager', mode: 'byo' as const, managed: null,
      legacy: true, createdBy: 'settings', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }
    let n: LegacyNpm | null
    try { n = await this.d.legacyNpm() }
    catch (e: any) {
      // Locked (or unreadable): still listed, so it does not look as if the proxy has gone.
      return { ...base, url: '', settings: {}, status: e?.name === 'VaultLockedError' ? 'locked' : 'unavailable' }
    }
    if (!n?.url) return null
    return { ...base, url: n.url, settings: { email: n.email }, status: 'ok' }
  }

  async listInstances(): Promise<ProxyInstance[]> {
    const legacy = await this.legacy()
    return [...(legacy ? [legacy] : []), ...(await this.d.store.list())]
  }

  async viewInstances(): Promise<InstanceView[]> {
    const all = await this.listInstances()
    return Promise.all(all.map(i => this.view(i)))
  }

  private async view(i: ProxyInstance): Promise<InstanceView> {
    let set: string[] = []
    if (i.legacy) set = i.status === 'ok' ? ['password'] : []
    else try { const s = await this.d.secrets.get(i.id); set = Object.keys(s).filter(k => s[k]) } catch { /* locked: none shown */ }
    return { ...i, kindLabel: KIND_LABEL[i.kind], secretsSet: set }
  }

  async getInstance(id: string): Promise<ProxyInstance> {
    if (id === LEGACY_NPM_ID) {
      const l = await this.legacy()
      if (l) return l
    } else if (ID_RE.test(id)) {
      const r = await this.d.store.get(id)
      if (r) return r
    }
    throw new ProxyRefusal(`There is no proxy instance "${id}".`, 404)
  }

  /** The instance, its provider, and the live set of hosts HyperProx recorded making there. */
  async provider(id: string): Promise<{ instance: ProxyInstance; provider: ProxyProvider; owned: Set<string> }> {
    const instance = await this.getInstance(id)
    let secrets: Record<string, string>
    if (instance.legacy) {
      if (instance.status !== 'ok') throw new ProxyRefusal(instance.status === 'locked' ? 'HyperProx is locked: the NPM login cannot be read until someone signs in.' : 'The NPM login in Settings cannot be read.', 423)
      const n = await this.d.legacyNpm()
      secrets = { password: n?.password ?? '' }
    } else secrets = await this.d.secrets.get(instance.id)
    const owned = new Set(instance.owned ?? [])
    return { instance, provider: buildProvider(instance, secrets, this.d, owned), owned }
  }

  /** Record that HyperProx made (or removed) a host on an instance: ownership is this record plus the name prefix. */
  async recordOwned(id: string, hostId: string, owned: boolean): Promise<void> {
    if (id === LEGACY_NPM_ID) return
    const cur = await this.d.store.get(id)
    if (!cur) return
    const set = new Set(cur.owned)
    if (owned) set.add(hostId); else set.delete(hostId)
    await this.d.store.update(id, { owned: [...set] })
  }

  private cleanSettings(kind: ProxyKind, raw: Record<string, unknown> = {}, prev: Record<string, string> = {}): Record<string, string> {
    const out: Record<string, string> = { ...prev }
    for (const f of KINDS[kind].fields.filter(x => !x.secret)) {
      if (f.key in raw) {
        const v = String(raw[f.key] ?? '').trim()
        if (v.length > 2000) throw new ProxyRefusal(`${f.label} is too long.`, 400)
        if (f.options && v && !f.options.includes(v)) throw new ProxyRefusal(`${f.label} is one of ${f.options.join(', ')}.`, 400)
        if (v) out[f.key] = v; else delete out[f.key]
      } else if (!(f.key in out) && f.default) out[f.key] = f.default
    }
    return out
  }

  private cleanSecrets(kind: ProxyKind, raw: Record<string, unknown> = {}): Record<string, string> {
    const out: Record<string, string> = {}
    for (const k of secretKeys(kind)) {
      const v = raw[k]
      if (typeof v === 'string' && v !== '') {
        if (v.length > 20_000) throw new ProxyRefusal(`${k} is too long.`, 400)
        out[k] = v
      }
    }
    return out
  }

  private checkRequired(kind: ProxyKind, settings: Record<string, string>, secrets: Record<string, string>): void {
    for (const f of KINDS[kind].fields) {
      const req = typeof f.required === 'function' ? f.required(settings) : f.required
      const has = f.secret ? !!secrets[f.key] : !!settings[f.key]
      if (req && !has) throw new ProxyRefusal(`${KINDS[kind].label}: ${f.label} is required.`, 400)
    }
    if (kind === 'traefik' && (settings.transport ?? 'ssh') === 'ssh' && !secrets.ssh_password && !secrets.ssh_private_key) {
      throw new ProxyRefusal('Traefik over SSH needs an SSH password or a private key.', 400)
    }
  }

  private learn(host: string, port: number): Promise<string> {
    return (this.d.learnHostKey ?? learnHostKey)(host, port)
  }

  private async checkTarget(mode: 'byo' | 'managed', managed: ManagedRef | null): Promise<void> {
    if (mode !== 'managed') return
    if (!managed) throw new ProxyRefusal('A Managed instance needs its container.', 400)
    if (!this.d.checkManagedTarget) throw new ProxyRefusal('HyperProx cannot check the container here, so it cannot be Managed.', 400)
    await this.d.checkManagedTarget(managed)
  }

  async createInstance(input: InstanceInput, actor: Actor): Promise<{ instance: InstanceView; health: ProxyHealth }> {
    const kind = input.kind as ProxyKind
    if (!PROXY_KINDS.includes(kind)) throw new ProxyRefusal(`The kind is one of ${PROXY_KINDS.join(', ')}.`, 400)
    const name = String(input.name ?? '').trim()
    if (!name || name.length > 80) throw new ProxyRefusal('Give the instance a name (up to 80 characters).', 400)
    const mode = input.mode === 'managed' ? 'managed' : 'byo'
    const managed = mode === 'managed' ? checkManaged(input.managed) : null
    const url = await checkUrl(input.url, mode === 'managed', this.resolver())
    const settings = this.cleanSettings(kind, input.settings)
    const secrets = this.cleanSecrets(kind, input.secrets)
    this.checkRequired(kind, settings, secrets)
    if ((await this.listInstances()).some(i => i.name.toLowerCase() === name.toLowerCase())) throw new ProxyRefusal(`An instance called "${name}" exists.`, 409)
    await this.checkTarget(mode, managed)
    // First add: the key the server offers now is pinned, and shown in the reply and the list.
    if (kind === 'traefik' && (settings.transport ?? 'ssh') === 'ssh' && !settings.ssh_host_key) {
      settings.ssh_host_key = await this.learn(settings.ssh_host, Number(settings.ssh_port || 22))
    }

    const id = 'px-' + randomBytes(5).toString('hex')
    // Secrets first: an instance row without its secrets would be listed and fail; secrets without a row are invisible.
    if (Object.keys(secrets).length) await this.d.secrets.set(id, secrets)
    const row = await this.d.store.create({ id, kind, name, url, mode, managed, settings, createdBy: actor.email })
    await this.d.store.audit('proxy.instance.create', `proxy:${id}`, { kind, name, url, mode, by: actor.email, secrets: Object.keys(secrets) })
    return { instance: await this.view(row), health: await this.health(id) }
  }

  async updateInstance(id: string, input: InstanceInput, actor: Actor): Promise<InstanceView> {
    const cur = await this.getInstance(id)
    if (cur.legacy) throw new ProxyRefusal('This instance is the NPM login in Settings → Proxy; change it there.', 409)
    const patch: Partial<StoredInstance> = {}
    if (input.name !== undefined) {
      const name = String(input.name).trim()
      if (!name || name.length > 80) throw new ProxyRefusal('Give the instance a name (up to 80 characters).', 400)
      patch.name = name
    }
    const mode = input.mode !== undefined ? (input.mode === 'managed' ? 'managed' : 'byo') : cur.mode
    const managed = mode === 'managed' ? (input.managed !== undefined ? checkManaged(input.managed) : cur.managed) : null
    if (input.mode !== undefined || input.managed !== undefined) { patch.mode = mode; patch.managed = managed; await this.checkTarget(mode, managed) }
    if (input.url !== undefined || patch.mode !== undefined) patch.url = await checkUrl(input.url ?? cur.url, mode === 'managed', this.resolver())
    const settings = this.cleanSettings(cur.kind, input.settings ?? {}, cur.settings)
    if (cur.kind === 'traefik' && (settings.transport ?? 'ssh') === 'ssh') {
      const moved = settings.ssh_host !== cur.settings.ssh_host || (settings.ssh_port || '22') !== (cur.settings.ssh_port || '22')
      const given = input.settings && 'ssh_host_key' in input.settings
      if (moved && !given) {
        // A new SSH address is a new server: its key is shown, and trusted only when sent back explicitly.
        const offered = await this.learn(settings.ssh_host, Number(settings.ssh_port || 22))
        throw new ProxyRefusal(`The SSH server at ${settings.ssh_host}:${settings.ssh_port || 22} offers host key ${offered}. Nothing was saved. ` +
          `To trust it, save again with ssh_host_key set to ${offered}.`, 409)
      }
    }
    const secrets = this.cleanSecrets(cur.kind, input.secrets)
    const have = { ...(await this.d.secrets.get(id)), ...secrets }
    this.checkRequired(cur.kind, settings, have)
    patch.settings = settings
    if (Object.keys(secrets).length) await this.d.secrets.set(id, secrets)
    const row = await this.d.store.update(id, patch)
    this.invalidate(id)
    await this.d.store.audit('proxy.instance.update', `proxy:${id}`, { by: actor.email, fields: Object.keys(patch), secrets: Object.keys(secrets) })
    return this.view(row)
  }

  /** Forget an instance. Nothing on the proxy itself changes. */
  async deleteInstance(id: string, actor: Actor): Promise<void> {
    const cur = await this.getInstance(id)
    if (cur.legacy) throw new ProxyRefusal('This instance is the NPM login in Settings → Proxy; remove it there.', 409)
    await this.d.store.remove(id)
    await this.d.secrets.remove(id).catch(() => undefined)
    this.invalidate(id)
    await this.d.store.audit('proxy.instance.delete', `proxy:${id}`, { by: actor.email, kind: cur.kind, name: cur.name })
  }

  private resolver(): (h: string) => Promise<string[]> {
    return this.d.resolve ?? (async h => (await lookup(h, { all: true })).map(a => a.address))
  }

  async health(id: string): Promise<ProxyHealth> {
    try {
      const { provider } = await this.provider(id)
      return await within(provider.health(), INSTANCE_TIMEOUT_MS * 2)
    } catch (e: any) {
      return { ok: false, checks: [{ name: 'config', ok: false, detail: e.message }] }
    }
  }

  // --- hosts and certificates ------------------------------------------------------------------------

  private views(inst: ProxyInstance, hosts: ProxyHostRecord[]): ProxyHostView[] {
    return hosts.map(h => ({ ...h, instanceId: inst.id, instanceName: inst.name, kind: inst.kind, readOnly: !h.owned }))
  }

  /** Forget the cached host list of an instance (after every write to it). */
  invalidate(id: string): void { this.cache.delete(id) }

  /** An instance's hosts, from a cache at most 20 s old. Previews and applies read the provider directly. */
  async hosts(id: string): Promise<ProxyHostView[]> {
    const hit = this.cache.get(id)
    if (hit && this.now() - hit.at < CACHE_MS) return hit.hosts
    const { instance, provider } = await this.provider(id)
    const hosts = this.views(instance, await provider.listHosts())
    this.cache.set(id, { at: this.now(), hosts })
    return hosts
  }

  /** Every instance's hosts, in parallel. One instance slow or down does not hide the others; it is named in `errors`. */
  async allHosts(): Promise<HostsResult> {
    const instances = await this.listInstances()
    const got = await Promise.allSettled(instances.map(i => within(this.hosts(i.id), this.d.instanceTimeoutMs ?? INSTANCE_TIMEOUT_MS)))
    const hosts: ProxyHostView[] = []
    const errors: HostsResult['errors'] = []
    got.forEach((g, n) => {
      if (g.status === 'fulfilled') hosts.push(...g.value)
      else errors.push({ instanceId: instances[n].id, instanceName: instances[n].name, error: g.reason?.message ?? String(g.reason) })
    })
    return { hosts, errors }
  }

  async certificates(id: string): Promise<Array<ProxyCertificate & { instanceId: string; instanceName: string }>> {
    const { instance, provider } = await this.provider(id)
    return (await provider.listCertificates()).map(c => ({ ...c, instanceId: instance.id, instanceName: instance.name }))
  }

  async allCertificates() {
    const instances = await this.listInstances()
    const got = await Promise.allSettled(instances.map(i => within(this.certificates(i.id), this.d.instanceTimeoutMs ?? INSTANCE_TIMEOUT_MS)))
    return {
      certificates: got.flatMap(g => (g.status === 'fulfilled' ? g.value : [])),
      errors: got.flatMap((g, n) => (g.status === 'rejected' ? [{ instanceId: instances[n].id, instanceName: instances[n].name, error: g.reason?.message ?? String(g.reason) }] : [])),
    }
  }

  async requestCertificate(id: string, domains: string[], email: string, actor: Actor): Promise<ProxyCertificate> {
    const { instance, provider } = await this.provider(id)
    if (!provider.requestCertificate) throw new ProxyRefusal(`${KIND_LABEL[instance.kind]} gets its own certificates; HyperProx cannot request one there.`, 400)
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new ProxyRefusal('Let’s Encrypt needs an email address.', 400)
    const c = await provider.requestCertificate(domains, email)
    await this.d.store.audit('proxy.certificate.request', `proxy:${instance.id}`, { by: actor.email, names: domains })
    return c
  }

  /** Managed instances, for Updates to list (node, container and what was installed). */
  async managedInstances(): Promise<Array<{ id: string; name: string; kind: ProxyKind; managed: ManagedRef }>> {
    return (await this.d.store.list()).filter(i => i.mode === 'managed' && i.managed).map(i => ({ id: i.id, name: i.name, kind: i.kind, managed: i.managed! }))
  }

  audit(action: string, resource: string, details?: Record<string, unknown>) { return this.d.store.audit(action, resource, details) }
}

export { settingKeys, secretKeys }
