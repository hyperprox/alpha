// =============================================================================
//  HyperProx — K3s: the clusters HyperProx looks after
//
//  Kept in the vault through the credential store, laid out as the PBS and
//  QNAP instances are:
//
//    plugin/k3s            instances   the list: names, where it runs, the CA
//                                      fingerprint, how it was connected. No
//                                      address, no credential.
//    plugin/k3s.<id>       url, ca, reader_token (masked): every read.
//    plugin/k3s.<id>.admin operator_token (masked): the confirmed actions only.
//                          kubeconfig (masked): K3s's admin login, for the person
//                          (and for removing HyperProx's accounts again).
//                          node_token (masked): what an agent joins with.
//
//  Nothing here is ever written to disk outside the vault, the database the
//  vault already uses, or the K3s nodes themselves.
// =============================================================================

import crypto from 'node:crypto'

export const PLUGIN_ID = 'k3s'
export const CATEGORY = 'plugin'
export const INDEX_KEY = 'instances'
export const MAX_INSTANCES = 20
const ID_RE = /^k[0-9a-f]{8}$/

export interface GuestRef { kind: 'lxc' | 'qemu'; vmid: number }

export interface K3sMeta {
  id: string
  name: string
  /** The guest the server runs in, when it is on this cluster. */
  guest: GuestRef | null
  /** Agents the Catalogue added, by guest. */
  agents: GuestRef[]
  /** SHA-256 of the cluster CA: two sightings with the same one are the same cluster. */
  caFingerprint: string
  via: 'catalogue' | 'auto-connect' | 'person'
  at: string
}

export interface K3sSecrets { url: string; ca: string; readerToken: string }
export interface K3sAdminSecrets { operatorToken: string; kubeconfig: string; nodeToken: string | null }

export interface CredentialIO {
  get(category: string, provider: string, key: string): Promise<string | null>
  set(category: string, provider: string, key: string, value: string, masked: boolean): Promise<void>
  setMany?(category: string, provider: string, values: Record<string, string>): Promise<void>
  remove(category: string, provider: string): Promise<void>
}

export class K3sInputError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'K3sInputError' }
}

export const providerFor = (id: string) => `${PLUGIN_ID}.${id}`
export const adminProviderFor = (id: string) => `${PLUGIN_ID}.${id}.admin`
export const validInstanceId = (id: string) => ID_RE.test(id)

export function cleanName(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim() : ''
  if (!s) throw new K3sInputError('Give the cluster a name, such as "K3s".')
  if (s.length > 40) throw new K3sInputError('Keep the name to 40 characters.')
  return s
}

const guestOf = (g: any): GuestRef | null =>
  g && (g.kind === 'lxc' || g.kind === 'qemu') && Number.isInteger(g.vmid) && g.vmid >= 100 && g.vmid <= 999_999_999 ? { kind: g.kind, vmid: g.vmid } : null

export function parseIndex(raw: string | null): K3sMeta[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter(x => x && typeof x.id === 'string' && validInstanceId(x.id) && typeof x.name === 'string').map((x): K3sMeta => ({
      id: x.id, name: String(x.name).slice(0, 40), guest: guestOf(x.guest),
      agents: Array.isArray(x.agents) ? x.agents.map(guestOf).filter(Boolean).slice(0, 50) as GuestRef[] : [],
      caFingerprint: typeof x.caFingerprint === 'string' ? x.caFingerprint.slice(0, 100) : '',
      via: x.via === 'catalogue' || x.via === 'auto-connect' ? x.via : 'person',
      at: typeof x.at === 'string' ? x.at.slice(0, 40) : '',
    })).slice(0, MAX_INSTANCES)
  } catch { return [] }
}

export class K3sInstanceStore {
  /** One index write at a time, so two adds never lose each other. */
  private chain: Promise<unknown> = Promise.resolve()
  constructor(private io: CredentialIO) {}

  async list(): Promise<K3sMeta[]> { return parseIndex(await this.io.get(CATEGORY, PLUGIN_ID, INDEX_KEY)) }
  async get(id: string): Promise<K3sMeta | null> { return validInstanceId(id) ? (await this.list()).find(m => m.id === id) ?? null : null }

  private mutate<T>(fn: (list: K3sMeta[]) => T | Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const list = await this.list()
      const out = await fn(list)
      await this.io.set(CATEGORY, PLUGIN_ID, INDEX_KEY, JSON.stringify(list), false)
      return out
    })
    this.chain = run.catch(() => {})
    return run
  }

  async create(m: Omit<K3sMeta, 'id' | 'at'>, s: K3sSecrets, a: K3sAdminSecrets): Promise<K3sMeta> {
    const id = `k${crypto.randomBytes(4).toString('hex')}`
    // Credentials first: an index row whose item is missing would be a cluster that cannot be read.
    await this.writeSecrets(id, s, a)
    return this.mutate(list => {
      if (list.length >= MAX_INSTANCES) throw new K3sInputError(`HyperProx looks after at most ${MAX_INSTANCES} K3s clusters.`, 409)
      const meta: K3sMeta = { ...m, id, at: new Date().toISOString() }
      list.push(meta)
      return meta
    })
  }

  async update(id: string, patch: Partial<Pick<K3sMeta, 'name' | 'agents' | 'guest'>>): Promise<K3sMeta> {
    return this.mutate(list => {
      const m = list.find(x => x.id === id)
      if (!m) throw new K3sInputError('No such K3s cluster.', 404)
      Object.assign(m, patch)
      return { ...m }
    })
  }

  async writeSecrets(id: string, s: K3sSecrets, a: K3sAdminSecrets): Promise<void> {
    const w = async (provider: string, values: Record<string, string>) => {
      if (this.io.setMany) return this.io.setMany(CATEGORY, provider, values)
      for (const [k, v] of Object.entries(values)) await this.io.set(CATEGORY, provider, k, v, k !== 'url' && k !== 'ca')
    }
    await w(providerFor(id), { url: s.url, ca: s.ca, reader_token: s.readerToken })
    await w(adminProviderFor(id), { operator_token: a.operatorToken, kubeconfig: a.kubeconfig, ...(a.nodeToken ? { node_token: a.nodeToken } : {}) })
  }

  async secrets(id: string): Promise<K3sSecrets | null> {
    const p = providerFor(id)
    const [url, ca, readerToken] = await Promise.all([this.io.get(CATEGORY, p, 'url'), this.io.get(CATEGORY, p, 'ca'), this.io.get(CATEGORY, p, 'reader_token')])
    return url && ca && readerToken ? { url, ca, readerToken } : null
  }

  async adminSecrets(id: string): Promise<K3sAdminSecrets | null> {
    const p = adminProviderFor(id)
    const [operatorToken, kubeconfig, nodeToken] = await Promise.all([this.io.get(CATEGORY, p, 'operator_token'), this.io.get(CATEGORY, p, 'kubeconfig'), this.io.get(CATEGORY, p, 'node_token')])
    return operatorToken && kubeconfig ? { operatorToken, kubeconfig, nodeToken: nodeToken || null } : null
  }

  async remove(id: string): Promise<void> {
    await this.mutate(list => { const i = list.findIndex(x => x.id === id); if (i >= 0) list.splice(i, 1) })
    await this.io.remove(CATEGORY, adminProviderFor(id)).catch(() => {})
    await this.io.remove(CATEGORY, providerFor(id)).catch(() => {})
  }
}
