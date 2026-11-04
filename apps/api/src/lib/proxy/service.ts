// =============================================================================
//  HyperProx — Proxy instances: the registry every caller goes through
//
//  Instances come from two places: the old single NPM login (Settings → Proxy,
//  hyperprox:proxy/npm), shown as the instance "npm" so nothing changes for an
//  existing install; and the instances added on the Proxy page, any kind, any
//  number, two of the same kind included.
// =============================================================================

import { randomBytes } from 'node:crypto'
import { KINDS, buildProvider, secretKeys, settingKeys, type BuildDeps } from './kinds'
import { learnHostKey } from './transport'
import type { InstanceSecrets, ProxyStore, StoredInstance } from './store'
import {
  KIND_LABEL, PROXY_KINDS, ProxyRefusal,
  type ManagedRef, type ProxyCertificate, type ProxyHealth, type ProxyHostView, type ProxyInstance, type ProxyKind, type ProxyProvider,
} from './types'

export const LEGACY_NPM_ID = 'npm'

export interface LegacyNpm { url: string; email: string; password: string }

export interface ServiceDeps extends BuildDeps {
  store:   ProxyStore
  secrets: InstanceSecrets
  /** The old single NPM login, or null when it is not set. */
  legacyNpm(): Promise<LegacyNpm | null>
  /** Fetch an SSH server's host key, to pin when an instance is added. */
  learnHostKey?(host: string, port: number): Promise<string>
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

/** An instance as the API returns it: which secrets are set, never their values. */
export interface InstanceView extends ProxyInstance { kindLabel: string; secretsSet: string[] }

const ID_RE = /^px-[a-z0-9]{10}$/

function checkUrl(raw: unknown): string {
  const v = String(raw ?? '').trim().replace(/\/+$/, '')
  let u: URL
  try { u = new URL(v) } catch { throw new ProxyRefusal(`"${v}" is not a URL.`, 400) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ProxyRefusal('The URL must start with http:// or https://.', 400)
  if (u.username || u.password) throw new ProxyRefusal('Put credentials in their own fields, not in the URL.', 400)
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

export class ProxyService {
  constructor(private d: ServiceDeps) {}

  kinds() { return PROXY_KINDS.map(k => ({ ...KINDS[k], fields: KINDS[k].fields.map(f => ({ ...f, required: typeof f.required === 'function' ? 'conditional' : f.required })) })) }

  // --- instances -------------------------------------------------------------------------------------

  private async legacy(): Promise<ProxyInstance | null> {
    const n = await this.d.legacyNpm().catch(() => null)
    if (!n?.url) return null
    return { id: LEGACY_NPM_ID, kind: 'npm', name: 'Nginx Proxy Manager', url: n.url, mode: 'byo', managed: null,
      settings: { email: n.email }, legacy: true, createdBy: 'settings', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }
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
    if (i.legacy) set = ['password']
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

  async provider(id: string): Promise<{ instance: ProxyInstance; provider: ProxyProvider }> {
    const instance = await this.getInstance(id)
    let secrets: Record<string, string>
    if (instance.legacy) {
      const n = await this.d.legacyNpm()
      secrets = { password: n?.password ?? '' }
    } else secrets = await this.d.secrets.get(instance.id)
    return { instance, provider: buildProvider(instance, secrets, this.d) }
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

  /** Pin the SSH host key when the instance is added (the admin sees it in the reply and in the list). */
  private async pinHostKey(settings: Record<string, string>): Promise<void> {
    if (settings.transport !== 'ssh' && settings.transport !== undefined) return
    if (settings.ssh_host_key || !settings.ssh_host) return
    const learn = this.d.learnHostKey ?? learnHostKey
    settings.ssh_host_key = await learn(settings.ssh_host, Number(settings.ssh_port || 22))
  }

  async createInstance(input: InstanceInput, actor: Actor): Promise<{ instance: InstanceView; health: ProxyHealth }> {
    const kind = input.kind as ProxyKind
    if (!PROXY_KINDS.includes(kind)) throw new ProxyRefusal(`The kind is one of ${PROXY_KINDS.join(', ')}.`, 400)
    const name = String(input.name ?? '').trim()
    if (!name || name.length > 80) throw new ProxyRefusal('Give the instance a name (up to 80 characters).', 400)
    const url = checkUrl(input.url)
    const mode = input.mode === 'managed' ? 'managed' : 'byo'
    const managed = mode === 'managed' ? checkManaged(input.managed) : null
    if (mode === 'managed' && !managed) throw new ProxyRefusal('A Managed instance needs its container.', 400)
    const settings = this.cleanSettings(kind, input.settings)
    const secrets = this.cleanSecrets(kind, input.secrets)
    this.checkRequired(kind, settings, secrets)
    if ((await this.listInstances()).some(i => i.name.toLowerCase() === name.toLowerCase())) throw new ProxyRefusal(`An instance called "${name}" exists.`, 409)
    if (kind === 'traefik') await this.pinHostKey(settings)

    const id = 'px-' + randomBytes(8).toString('hex').replace(/[^a-z0-9]/g, '').slice(0, 10).padEnd(10, '0')
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
    if (input.url !== undefined) patch.url = checkUrl(input.url)
    if (input.mode !== undefined) {
      patch.mode = input.mode === 'managed' ? 'managed' : 'byo'
      patch.managed = patch.mode === 'managed' ? checkManaged(input.managed ?? cur.managed) : null
    }
    const settings = this.cleanSettings(cur.kind, input.settings ?? {}, cur.settings)
    // A new SSH address means the old pin no longer applies.
    if (cur.kind === 'traefik' && (settings.ssh_host !== cur.settings.ssh_host || settings.ssh_port !== cur.settings.ssh_port) && !(input.settings && 'ssh_host_key' in input.settings)) delete settings.ssh_host_key
    const secrets = this.cleanSecrets(cur.kind, input.secrets)
    const have = { ...(await this.d.secrets.get(id)), ...secrets }
    this.checkRequired(cur.kind, settings, have)
    if (cur.kind === 'traefik') await this.pinHostKey(settings)
    patch.settings = settings
    if (Object.keys(secrets).length) await this.d.secrets.set(id, secrets)
    const row = await this.d.store.update(id, patch)
    await this.d.store.audit('proxy.instance.update', `proxy:${id}`, { by: actor.email, fields: Object.keys(patch), secrets: Object.keys(secrets) })
    return this.view(row)
  }

  /** Forget an instance. Nothing on the proxy itself changes. */
  async deleteInstance(id: string, actor: Actor): Promise<void> {
    const cur = await this.getInstance(id)
    if (cur.legacy) throw new ProxyRefusal('This instance is the NPM login in Settings → Proxy; remove it there.', 409)
    await this.d.store.remove(id)
    await this.d.secrets.remove(id).catch(() => undefined)
    await this.d.store.audit('proxy.instance.delete', `proxy:${id}`, { by: actor.email, kind: cur.kind, name: cur.name })
  }

  async health(id: string): Promise<ProxyHealth> {
    try {
      const { provider } = await this.provider(id)
      return await provider.health()
    } catch (e: any) {
      return { ok: false, checks: [{ name: 'config', ok: false, detail: e.message }] }
    }
  }

  // --- hosts and certificates ------------------------------------------------------------------------

  private views(inst: ProxyInstance, hosts: Awaited<ReturnType<ProxyProvider['listHosts']>>): ProxyHostView[] {
    return hosts.map(h => ({ ...h, instanceId: inst.id, instanceName: inst.name, kind: inst.kind, readOnly: !h.owned }))
  }

  async hosts(id: string): Promise<ProxyHostView[]> {
    const { instance, provider } = await this.provider(id)
    return this.views(instance, await provider.listHosts())
  }

  /** Every instance's hosts. One instance failing does not hide the others; it is named in `errors`. */
  async allHosts(): Promise<{ hosts: ProxyHostView[]; errors: Array<{ instanceId: string; instanceName: string; error: string }> }> {
    const instances = await this.listInstances()
    const got = await Promise.allSettled(instances.map(i => this.hosts(i.id)))
    const hosts: ProxyHostView[] = []
    const errors: Array<{ instanceId: string; instanceName: string; error: string }> = []
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
    const got = await Promise.allSettled(instances.map(i => this.certificates(i.id)))
    return {
      certificates: got.flatMap(g => (g.status === 'fulfilled' ? g.value : [])),
      errors: got.flatMap((g, n) => (g.status === 'rejected' ? [{ instanceId: instances[n].id, instanceName: instances[n].name, error: g.reason?.message ?? String(g.reason) }] : [])),
    }
  }

  async requestCertificate(id: string, domains: string[], email: string, actor: Actor): Promise<ProxyCertificate> {
    const { instance, provider } = await this.provider(id)
    if (!provider.requestCertificate) throw new ProxyRefusal(`${KIND_LABEL[instance.kind]} gets its own certificates; HyperProx cannot request one there.`, 400)
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
