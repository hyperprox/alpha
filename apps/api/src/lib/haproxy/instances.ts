// =============================================================================
//  HyperProx — HAProxy: the instances the plug-in looks after
//
//  Kept in the vault through the credential store, as one list (plugin/haproxy
//  instances): a name, the guest HAProxy runs in, its Runtime API socket, and
//  the Proxy page's instance when it has one (a Catalogue install does: its
//  Data Plane login lives there, in the vault, and is never copied here). No
//  address, no password.
// =============================================================================

import crypto from 'node:crypto'
import { SOCKET_RE } from './runtime'

export const PLUGIN_ID = 'haproxy'
export const CATEGORY = 'plugin'
export const INDEX_KEY = 'instances'
export const MAX_INSTANCES = 20
const ID_RE = /^h[0-9a-f]{8}$/

export interface HaproxyGuest { kind: 'lxc' | 'qemu'; vmid: number }

export interface HaproxyInstance {
  id: string
  name: string
  guest: HaproxyGuest
  socket: string
  /** The Proxy page's instance (px-...) whose Data Plane login changes the saved configuration; null: runtime only. */
  proxyInstanceId: string | null
  /** How it was connected: a Catalogue install, the service scan, the Proxy page, or a person. */
  via: 'catalogue' | 'scan' | 'proxy' | 'person'
  addedAt: number
}

export interface CredentialIO {
  get(category: string, provider: string, key: string): Promise<string | null>
  set(category: string, provider: string, key: string, value: string, masked: boolean): Promise<void>
}

export const validInstanceId = (id: string) => ID_RE.test(id)

function clean(raw: unknown): HaproxyInstance | null {
  const r = (raw ?? {}) as Record<string, any>
  const kind = r.guest?.kind === 'qemu' ? 'qemu' : r.guest?.kind === 'lxc' ? 'lxc' : null
  const vmid = Number(r.guest?.vmid)
  if (!validInstanceId(String(r.id)) || !kind || !Number.isInteger(vmid) || vmid < 100) return null
  return {
    id: String(r.id), name: String(r.name ?? `HAProxy ${vmid}`).slice(0, 40), guest: { kind, vmid },
    socket: SOCKET_RE.test(String(r.socket)) ? String(r.socket) : '/run/haproxy/admin.sock',
    proxyInstanceId: typeof r.proxyInstanceId === 'string' && /^px-[a-z0-9]{10}$/.test(r.proxyInstanceId) ? r.proxyInstanceId : null,
    via: ['catalogue', 'scan', 'proxy', 'person'].includes(r.via) ? r.via : 'person',
    addedAt: Number(r.addedAt) || 0,
  }
}

export class HaproxyInstanceStore {
  constructor(private io: CredentialIO) {}

  async list(): Promise<HaproxyInstance[]> {
    const raw = await this.io.get(CATEGORY, PLUGIN_ID, INDEX_KEY)
    if (!raw) return []
    try {
      const arr = JSON.parse(raw)
      return Array.isArray(arr) ? arr.map(clean).filter((x): x is HaproxyInstance => !!x) : []
    } catch { return [] }
  }

  async get(id: string): Promise<HaproxyInstance | null> {
    return (await this.list()).find(i => i.id === id) ?? null
  }

  private async save(list: HaproxyInstance[]): Promise<void> {
    await this.io.set(CATEGORY, PLUGIN_ID, INDEX_KEY, JSON.stringify(list), false)
  }

  async add(i: Omit<HaproxyInstance, 'id' | 'addedAt'>, now = Date.now()): Promise<HaproxyInstance> {
    const list = await this.list()
    if (list.some(x => x.guest.kind === i.guest.kind && x.guest.vmid === i.guest.vmid)) throw new Error(`HAProxy in ${i.guest.vmid} is already connected.`)
    if (list.length >= MAX_INSTANCES) throw new Error(`The plug-in looks after up to ${MAX_INSTANCES} HAProxy instances.`)
    const row: HaproxyInstance = { ...i, id: 'h' + crypto.randomBytes(4).toString('hex'), addedAt: now }
    await this.save([...list, row])
    return row
  }

  async update(id: string, patch: Partial<Pick<HaproxyInstance, 'proxyInstanceId' | 'socket' | 'name'>>): Promise<void> {
    const list = await this.list()
    const i = list.find(x => x.id === id)
    if (!i) return
    Object.assign(i, patch)
    await this.save(list)
  }

  async remove(id: string): Promise<HaproxyInstance | null> {
    const list = await this.list()
    const i = list.find(x => x.id === id) ?? null
    if (i) await this.save(list.filter(x => x.id !== id))
    return i
  }
}
