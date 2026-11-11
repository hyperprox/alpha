// =============================================================================
//  HyperProx — QNAP: NAS instances
//
//  Each NAS HyperProx reads is an instance: a name, an address, a QNAP login,
//  optionally the HyperProx cluster it sits beside, and how it is reached.
//  Everything lives in the vault, through the credential store, laid out the
//  way Home Assistant's instances are (lib/ha-control/instances.ts):
//
//    plugin/qnap        instances   the list: names, cluster links, reach, pins.
//                                   No address, no login.
//    plugin/qnap.<id>   url, username, password (masked) for each NAS.
//
//  The password goes only to the address it was entered for: a save that moves
//  the address to another host or port, or changes the user name, needs the
//  password again in the same save. A certificate pin belongs to one host and
//  port and is cleared when they change.
// =============================================================================

import crypto from 'node:crypto'
import { normaliseFingerprint } from '../clusters/tls-pin'
import { isPrivateLanIp, remoteTargetProblem, resolveQnapTarget, type TargetResolver } from './target'

export const PLUGIN_ID = 'qnap'
export const CATEGORY = 'plugin'
export const INDEX_KEY = 'instances'
export const MAX_INSTANCES = 20
const ID_RE = /^q[0-9a-f]{8}$/

/** auto: through the linked remote cluster when the address is a private LAN address, otherwise direct. */
export type Reach = 'auto' | 'direct' | 'cluster'

export interface QnapMeta {
  id:          string
  name:        string
  /** The HyperProx cluster this NAS sits beside, or null. */
  clusterId:   string | null
  /** Which of that cluster's nodes runs the requests when the NAS is reached through it. Null: the first node. */
  node:        string | null
  reach:       Reach
  insecureTLS: boolean
  fingerprint: string | null
  /** Alerts for this NAS (disk health, degraded or full volumes, high temperatures). On by default. */
  alerts:      boolean
  /** A disk temperature to warn at, in °C. Null: the NAS's own warning threshold, or 55 °C. */
  diskTempWarnC: number | null
}

export interface QnapView extends QnapMeta { url: string; username: string; hasPassword: boolean }

export interface CredentialIO {
  get(category: string, provider: string, key: string): Promise<string | null>
  set(category: string, provider: string, key: string, value: string, masked: boolean): Promise<void>
  remove(category: string, provider: string): Promise<void>
}

/** What the store needs to know about a cluster: whether it is remote, and its nodes' SSH addresses. */
export interface ClusterFacts { kind: 'home' | 'remote'; name: string; nodes: Record<string, string> }

export class QnapInputError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'QnapInputError' }
}

export const providerFor = (id: string) => `${PLUGIN_ID}.${id}`
export function validInstanceId(id: string): boolean { return ID_RE.test(id) }

function cleanName(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim() : ''
  if (!s) throw new QnapInputError('Give the NAS a name, such as "Office NAS".')
  if (s.length > 40) throw new QnapInputError('Keep the name to 40 characters.')
  return s
}

export function cleanUrl(v: unknown): string {
  const s = typeof v === 'string' ? v.trim().replace(/\/+$/, '') : ''
  let u: URL
  try { u = new URL(s) } catch { throw new QnapInputError('The address must be a full URL, such as http://10.0.0.20:8080 or https://nas.example.lan:443.') }
  if (!['http:', 'https:'].includes(u.protocol)) throw new QnapInputError('The address must start with http:// or https://.')
  if (u.username || u.password) throw new QnapInputError('Leave the login out of the address; it is entered separately.')
  if (u.search || u.hash || (u.pathname && u.pathname !== '/')) throw new QnapInputError('The address is the NAS itself, with no path or query (http://10.0.0.20:8080).')
  return `${u.protocol}//${u.host}`
}

function cleanUser(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(s)) throw new QnapInputError('Enter the QNAP user name (letters, digits, dot, dash, underscore, @).')
  return s
}

function cleanPassword(v: unknown): string {
  const s = typeof v === 'string' ? v : ''
  if (!s || s.length > 256 || /[\u0000\r\n]/.test(s)) throw new QnapInputError('Enter the password of that QNAP user.')
  return s
}

function cleanFingerprint(v: unknown, prev: string | null): string | null {
  if (v === undefined) return prev
  if (v === null || v === '') return null
  const f = typeof v === 'string' ? normaliseFingerprint(v) : null
  if (!f) throw new QnapInputError('A pinned certificate is a SHA-256 fingerprint (64 hex characters).')
  return f
}

function cleanReach(v: unknown, prev: Reach): Reach {
  if (v === undefined) return prev
  if (v === 'auto' || v === 'direct' || v === 'cluster') return v
  throw new QnapInputError('Reach is auto, direct or cluster.')
}

function cleanTemp(v: unknown, prev: number | null): number | null {
  if (v === undefined) return prev
  if (v === null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 30 || n > 90) throw new QnapInputError('A disk temperature warning is between 30 and 90 °C.')
  return Math.round(n)
}

function parseIndex(raw: string | null): QnapMeta[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter(x => x && typeof x.id === 'string' && validInstanceId(x.id) && typeof x.name === 'string').map(x => ({
      id: x.id, name: String(x.name).slice(0, 40),
      clusterId: typeof x.clusterId === 'string' ? x.clusterId : null,
      node: typeof x.node === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/.test(x.node) ? x.node : null,
      reach: x.reach === 'direct' || x.reach === 'cluster' ? x.reach : 'auto',
      insecureTLS: x.insecureTLS === true,
      fingerprint: typeof x.fingerprint === 'string' ? normaliseFingerprint(x.fingerprint) : null,
      alerts: x.alerts !== false,
      diskTempWarnC: typeof x.diskTempWarnC === 'number' && x.diskTempWarnC >= 30 && x.diskTempWarnC <= 90 ? x.diskTempWarnC : null,
    }))
  } catch { return [] }
}

export interface QnapInput {
  name?: unknown; url?: unknown; username?: unknown; password?: unknown; clusterId?: unknown; node?: unknown; reach?: unknown
  insecureTLS?: unknown; fingerprint?: unknown; alerts?: unknown; diskTempWarnC?: unknown
}

const endpointOf = (url: string) => { const u = new URL(url); return `${u.protocol}//${u.host}`.toLowerCase() }

/** How this NAS is reached, given its address and its cluster. */
export function effectiveReach(m: Pick<QnapMeta, 'reach' | 'clusterId'>, url: string, cluster: ClusterFacts | null): 'direct' | 'cluster' {
  if (!cluster || cluster.kind !== 'remote') return 'direct'
  if (m.reach === 'cluster') return 'cluster'
  if (m.reach === 'direct') return 'direct'
  try { return isPrivateLanIp(new URL(url).hostname) ? 'cluster' : 'direct' } catch { return 'direct' }
}

/** The node a cluster-reached NAS is asked through, and its SSH address. */
export function nodeFor(m: Pick<QnapMeta, 'node'>, cluster: ClusterFacts): { node: string; address: string } | null {
  const names = Object.keys(cluster.nodes).sort()
  const node = m.node && cluster.nodes[m.node] ? m.node : names[0]
  return node ? { node, address: cluster.nodes[node] } : null
}

export class QnapInstanceStore {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private io: CredentialIO,
    private clusterFacts: (id: string) => ClusterFacts | null = () => null,
    private checkTarget: TargetResolver = resolveQnapTarget,
  ) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }

  cluster(id: string | null): ClusterFacts | null { return id ? this.clusterFacts(id) : null }

  async list(): Promise<QnapMeta[]> { return parseIndex(await this.io.get(CATEGORY, PLUGIN_ID, INDEX_KEY)) }

  async get(id: string): Promise<QnapMeta | null> {
    if (!validInstanceId(id)) return null
    return (await this.list()).find(i => i.id === id) ?? null
  }

  async views(): Promise<QnapView[]> {
    const out: QnapView[] = []
    for (const m of await this.list()) {
      const p = providerFor(m.id)
      out.push({ ...m, url: (await this.io.get(CATEGORY, p, 'url')) ?? '', username: (await this.io.get(CATEGORY, p, 'username')) ?? '', hasPassword: !!(await this.io.get(CATEGORY, p, 'password')) })
    }
    return out
  }

  /** Address and login, for the connection only. Never returned by a route. */
  async connection(id: string): Promise<{ meta: QnapMeta; url: string; username: string; password: string } | null> {
    const meta = await this.get(id)
    if (!meta) return null
    const p = providerFor(id)
    const [url, username, password] = await Promise.all([this.io.get(CATEGORY, p, 'url'), this.io.get(CATEGORY, p, 'username'), this.io.get(CATEGORY, p, 'password')])
    if (!url || !username || !password) return null
    return { meta, url, username, password }
  }

  private clusterId(v: unknown, prev: string | null): string | null {
    if (v === undefined) return prev
    if (v === null || v === '') return null
    if (typeof v !== 'string' || !this.clusterFacts(v)) throw new QnapInputError('That cluster is not one HyperProx manages.')
    return v
  }

  private nodeName(v: unknown, prev: string | null, cluster: ClusterFacts | null): string | null {
    const n = v === undefined ? prev : v === null || v === '' ? null : v
    if (n === null) return null
    if (typeof n !== 'string' || !cluster || !cluster.nodes[n]) throw new QnapInputError('That node is not one of the linked cluster\'s nodes with a saved address.')
    return n
  }

  /** The address rules for how this NAS will be reached. */
  private async checkAddress(m: QnapMeta, url: string): Promise<void> {
    const cluster = this.cluster(m.clusterId)
    if (m.reach === 'cluster' && (!cluster || cluster.kind !== 'remote')) throw new QnapInputError('"Through the cluster" needs the NAS linked to a remote cluster.')
    const how = effectiveReach(m, url, cluster)
    if (how === 'cluster') {
      const n = nodeFor(m, cluster!)
      if (!n) throw new QnapInputError(`${cluster!.name} has no node with a saved address to ask the NAS through.`)
      const why = remoteTargetProblem(new URL(url), n.address)
      if (why) throw new QnapInputError(why)
      // curl on the node cannot check a certificate fingerprint, so a pin would silently mean nothing.
      if (m.fingerprint) throw new QnapInputError('A pinned certificate can only be checked when HyperProx reaches the NAS directly. Through a remote server, use http:// on its LAN (the SSH session is the encryption) or remove the pin.')
      return
    }
    try { await this.checkTarget(new URL(url)) } catch (e: any) { throw new QnapInputError(e?.message ?? 'That address is not allowed.') }
  }

  async create(input: QnapInput): Promise<QnapMeta> {
    return this.serial(async () => {
      const list = await this.list()
      if (list.length >= MAX_INSTANCES) throw new QnapInputError(`HyperProx holds up to ${MAX_INSTANCES} NAS.`)
      const name = cleanName(input.name)
      if (list.some(i => i.name.toLowerCase() === name.toLowerCase())) throw new QnapInputError('Another NAS already has that name.', 409)
      const url = cleanUrl(input.url)
      const username = cleanUser(input.username)
      const password = cleanPassword(input.password)
      const clusterId = this.clusterId(input.clusterId, null)
      const meta: QnapMeta = {
        id: `q${crypto.randomBytes(4).toString('hex')}`, name, clusterId,
        node: this.nodeName(input.node, null, this.cluster(clusterId)),
        reach: cleanReach(input.reach, 'auto'),
        insecureTLS: input.insecureTLS === true,
        fingerprint: cleanFingerprint(input.fingerprint, null),
        alerts: input.alerts !== false,
        diskTempWarnC: cleanTemp(input.diskTempWarnC, null),
      }
      await this.checkAddress(meta, url)
      const p = providerFor(meta.id)
      await this.io.set(CATEGORY, p, 'url', url, false)
      await this.io.set(CATEGORY, p, 'username', username, false)
      await this.io.set(CATEGORY, p, 'password', password, true)
      await this.io.set(CATEGORY, PLUGIN_ID, INDEX_KEY, JSON.stringify([...list, meta]), false)
      return meta
    })
  }

  /** Returns the new meta and whether the login (address, user or password) changed. */
  async update(id: string, input: QnapInput): Promise<{ meta: QnapMeta; loginChanged: boolean }> {
    return this.serial(async () => {
      const list = await this.list()
      const prev = list.find(i => i.id === id)
      if (!prev) throw new QnapInputError('No such NAS.', 404)
      const name = input.name === undefined ? prev.name : cleanName(input.name)
      if (list.some(i => i.id !== id && i.name.toLowerCase() === name.toLowerCase())) throw new QnapInputError('Another NAS already has that name.', 409)
      const p = providerFor(id)
      const oldUrl = (await this.io.get(CATEGORY, p, 'url')) ?? ''
      const oldUser = (await this.io.get(CATEGORY, p, 'username')) ?? ''
      const url = input.url === undefined ? oldUrl : cleanUrl(input.url)
      const username = input.username === undefined ? oldUser : cleanUser(input.username)
      const moved = !oldUrl || endpointOf(url) !== endpointOf(oldUrl)
      const newPassword = input.password === undefined || input.password === '' ? null : cleanPassword(input.password)
      if ((moved || username !== oldUser) && !newPassword) throw new QnapInputError('The address or user name changed, so enter the password again in the same save.')
      const clusterId = this.clusterId(input.clusterId, prev.clusterId)
      const next: QnapMeta = {
        id, name, clusterId,
        node: this.nodeName(input.node, clusterId === prev.clusterId ? prev.node : null, this.cluster(clusterId)),
        reach: cleanReach(input.reach, prev.reach),
        insecureTLS: input.insecureTLS === undefined ? prev.insecureTLS : input.insecureTLS === true,
        fingerprint: cleanFingerprint(input.fingerprint, moved ? null : prev.fingerprint),
        alerts: input.alerts === undefined ? prev.alerts : input.alerts !== false,
        diskTempWarnC: cleanTemp(input.diskTempWarnC, prev.diskTempWarnC),
      }
      await this.checkAddress(next, url)
      if (url !== oldUrl) await this.io.set(CATEGORY, p, 'url', url, false)
      if (username !== oldUser) await this.io.set(CATEGORY, p, 'username', username, false)
      if (newPassword) await this.io.set(CATEGORY, p, 'password', newPassword, true)
      await this.io.set(CATEGORY, PLUGIN_ID, INDEX_KEY, JSON.stringify(list.map(i => i.id === id ? next : i)), false)
      return { meta: next, loginChanged: moved || username !== oldUser || !!newPassword }
    })
  }

  async remove(id: string): Promise<void> {
    return this.serial(async () => {
      const list = await this.list()
      if (!list.some(i => i.id === id)) throw new QnapInputError('No such NAS.', 404)
      await this.io.remove(CATEGORY, providerFor(id))
      await this.io.set(CATEGORY, PLUGIN_ID, INDEX_KEY, JSON.stringify(list.filter(i => i.id !== id)), false)
    })
  }
}
