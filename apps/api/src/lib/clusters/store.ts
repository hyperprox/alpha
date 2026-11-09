// =============================================================================
//  HyperProx — the cluster registry's table (ManagedCluster), and an in-memory one for tests
// =============================================================================

import type { PrismaClient } from '@prisma/client'

export type ClusterKind = 'home' | 'remote'

/** What HyperProx installed on one node of a remote cluster for monitoring. */
export interface NodeMonitoring {
  nodeExporter?: { listen: string; installedByHyperProx: boolean; at: string }
  amdGpu?: { at: string }
}

export interface ClusterRow {
  id: string
  name: string
  kind: ClusterKind
  address: string
  port: number
  note: string
  certFingerprint: string | null
  certConfirmedAt: Date | null
  certConfirmedBy: string | null
  nodeAddresses: Record<string, string>
  allowedRoots: string[]
  monitoring: Record<string, NodeMonitoring>
  plexUrl: string | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

export interface ClusterStore {
  list(): Promise<ClusterRow[]>
  upsert(row: Omit<ClusterRow, 'createdAt' | 'updatedAt'>): Promise<ClusterRow>
  remove(id: string): Promise<void>
}

export class MemoryClusterStore implements ClusterStore {
  rows = new Map<string, ClusterRow>()
  async list() { return [...this.rows.values()].map(r => structuredClone(r)) }
  async upsert(row: Omit<ClusterRow, 'createdAt' | 'updatedAt'>) {
    const prev = this.rows.get(row.id)
    const next: ClusterRow = { ...structuredClone(row), createdAt: prev?.createdAt ?? new Date(), updatedAt: new Date() }
    this.rows.set(row.id, next)
    return structuredClone(next)
  }
  async remove(id: string) { this.rows.delete(id) }
}

function fromDb(r: any): ClusterRow {
  return {
    id: r.id, name: r.name, kind: r.kind === 'home' ? 'home' : 'remote', address: r.address, port: r.port, note: r.note,
    certFingerprint: r.certFingerprint ?? null, certConfirmedAt: r.certConfirmedAt ?? null, certConfirmedBy: r.certConfirmedBy ?? null,
    nodeAddresses: (r.nodeAddresses && typeof r.nodeAddresses === 'object') ? r.nodeAddresses : {},
    allowedRoots: Array.isArray(r.allowedRoots) ? r.allowedRoots : [],
    monitoring: (r.monitoring && typeof r.monitoring === 'object') ? r.monitoring : {},
    plexUrl: r.plexUrl ?? null, createdBy: r.createdBy, createdAt: r.createdAt, updatedAt: r.updatedAt,
  }
}

export class PrismaClusterStore implements ClusterStore {
  constructor(private db: PrismaClient) {}
  async list() { return ((await (this.db as any).managedCluster.findMany({ orderBy: { createdAt: 'asc' } })) as any[]).map(fromDb) }
  async upsert(row: Omit<ClusterRow, 'createdAt' | 'updatedAt'>) {
    const data = { ...row, nodeAddresses: row.nodeAddresses as any, monitoring: row.monitoring as any }
    const { id, ...rest } = data
    return fromDb(await (this.db as any).managedCluster.upsert({ where: { id }, create: data, update: rest }))
  }
  async remove(id: string) { await (this.db as any).managedCluster.deleteMany({ where: { id } }) }
}
