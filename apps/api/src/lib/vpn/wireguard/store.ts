// =============================================================================
//  HyperProx — WireGuard: what HyperProx manages (no keys but public ones)
//
//  Servers and peers. Public keys, addresses and names only: a client's
//  private key and config are vault items, and a server's or machine's private
//  key stays on that machine.
// =============================================================================

import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'

export interface WgServer {
  id: string; machineId: string; iface: string; listenPort: number; address: string; endpoint: string
  publicKey: string; keyBackedUp: boolean; createdAt: Date
}

export type WgPeerKind = 'device' | 'machine'

export interface WgPeer {
  id: string
  /** A HyperProx server, or a router interface (`router:<name>`). */
  serverId: string | null
  routerIface: string | null
  /** The RouterOS .id of the peer HyperProx created there. */
  routerPeerId: string | null
  kind: WgPeerKind
  name: string
  machineId: string | null
  /** The interface on the machine (machine peers). */
  iface: string | null
  publicKey: string
  /** Its tunnel address, e.g. 192.0.2.2/32. */
  address: string
  /** What the server routes to it (its address, plus any site-to-site subnets). */
  allowedIps: string[]
  /** What it routes through the tunnel. */
  clientAllowedIps: string[]
  keepalive: number | null
  /** Rotation: the key it replaced, kept until `previousUntil` so the rotation can be undone. */
  previousPublicKey: string | null
  previousUntil: Date | null
  rotatedAt: Date | null
  createdAt: Date
}

export interface WgStore {
  listServers(): Promise<WgServer[]>
  getServer(id: string): Promise<WgServer | null>
  addServer(s: Omit<WgServer, 'id' | 'createdAt'>): Promise<WgServer>
  updateServer(id: string, patch: Partial<Omit<WgServer, 'id' | 'createdAt'>>): Promise<WgServer>
  removeServer(id: string): Promise<void>
  listPeers(): Promise<WgPeer[]>
  getPeer(id: string): Promise<WgPeer | null>
  addPeer(p: Omit<WgPeer, 'id' | 'createdAt'> & { id?: string }): Promise<WgPeer>
  updatePeer(id: string, patch: Partial<Omit<WgPeer, 'id' | 'createdAt'>>): Promise<WgPeer>
  removePeer(id: string): Promise<void>
  audit(action: string, resource: string, details: Record<string, unknown>): Promise<void>
}

export class MemoryWgStore implements WgStore {
  servers = new Map<string, WgServer>()
  peers = new Map<string, WgPeer>()
  readonly audits: Array<{ action: string; resource: string; details: Record<string, any> }> = []
  async listServers() { return [...this.servers.values()].map(s => ({ ...s })) }
  async getServer(id: string) { const s = this.servers.get(id); return s ? { ...s } : null }
  async addServer(s: Omit<WgServer, 'id' | 'createdAt'>) { const r = { ...s, id: randomUUID(), createdAt: new Date() }; this.servers.set(r.id, r); return { ...r } }
  async updateServer(id: string, patch: Partial<WgServer>) { const x = this.servers.get(id); if (!x) throw new Error(`no server ${id}`); Object.assign(x, patch); return { ...x } }
  async removeServer(id: string) { this.servers.delete(id) }
  async listPeers() { return [...this.peers.values()].map(p => ({ ...p })) }
  async getPeer(id: string) { const p = this.peers.get(id); return p ? { ...p } : null }
  async addPeer(p: Omit<WgPeer, 'id' | 'createdAt'> & { id?: string }) { const r = { ...p, id: p.id ?? randomUUID(), createdAt: new Date() } as WgPeer; this.peers.set(r.id, r); return { ...r } }
  async updatePeer(id: string, patch: Partial<WgPeer>) { const p = this.peers.get(id); if (!p) throw new Error(`no peer ${id}`); Object.assign(p, patch); return { ...p } }
  async removePeer(id: string) { this.peers.delete(id) }
  async audit(action: string, resource: string, details: Record<string, unknown>) { this.audits.push({ action, resource, details: JSON.parse(JSON.stringify(details)) }) }
}

export class PrismaWgStore implements WgStore {
  constructor(private readonly db: PrismaClient) {}
  private get s() { return (this.db as any).wgServer }
  private get p() { return (this.db as any).wgPeer }
  async listServers() { return this.s.findMany({ orderBy: { createdAt: 'asc' } }) }
  async getServer(id: string) { return this.s.findUnique({ where: { id } }) }
  async addServer(x: Omit<WgServer, 'id' | 'createdAt'>) { return this.s.create({ data: x }) }
  async updateServer(id: string, patch: Partial<WgServer>) { return this.s.update({ where: { id }, data: patch }) }
  async removeServer(id: string) { await this.s.deleteMany({ where: { id } }) }
  async listPeers() { return this.p.findMany({ orderBy: { createdAt: 'asc' } }) }
  async getPeer(id: string) { return this.p.findUnique({ where: { id } }) }
  async addPeer(x: Omit<WgPeer, 'id' | 'createdAt'> & { id?: string }) { return this.p.create({ data: x }) }
  async updatePeer(id: string, patch: Partial<WgPeer>) { return this.p.update({ where: { id }, data: patch }) }
  async removePeer(id: string) { await this.p.deleteMany({ where: { id } }) }
  async audit(action: string, resource: string, details: Record<string, unknown>) {
    await this.db.auditLog.create({ data: { action, resource, details: details as any } })
  }
}
