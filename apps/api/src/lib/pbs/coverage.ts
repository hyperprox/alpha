// =============================================================================
//  HyperProx — Proxmox Backup Server: which cluster guests have no backup here
//
//  Optional and read-only. For every cluster HyperProx already manages, its
//  storage list is read (GET /storage) and a `pbs` storage that points at this
//  server is found: by the certificate fingerprint Proxmox stores for it (the
//  same one HyperProx pinned), or by the same host and port. Then every guest
//  of that cluster (not templates) is compared with the backup groups in that
//  storage's datastore and namespace: a guest with no group at all has never
//  been backed up to this server. Where the cluster answers
//  /cluster/backup-info/not-backed-up, the guests no backup job covers are
//  listed too.
// =============================================================================

import { normaliseFingerprint } from '../clusters/tls-pin'
import type { PbsGroup } from './parse'

export interface PveStorage { storage: string; type: string; server?: string; port?: number | string; datastore?: string; namespace?: string; fingerprint?: string; disable?: number | boolean }
export interface PveGuest { vmid: number; name?: string; type: string; template?: number | boolean; node?: string }

export interface ClusterCoverage {
  clusterId: string
  cluster:   string
  /** The PVE storage ids that point at this server. */
  storages:  Array<{ storage: string; datastore: string; ns: string }>
  /** Guests with no snapshot group in any of those datastores/namespaces. */
  noGroup:   Array<{ vmid: number; name: string; type: 'vm' | 'ct' }>
  /** Guests no backup job includes (null: the cluster did not say). */
  notInJob:  Array<{ vmid: number; name: string; type: 'vm' | 'ct' }> | null
  error?:    string
}

const hostKey = (h: string) => h.toLowerCase().replace(/^\[|\]$/g, '')

/** The cluster's PBS storages that point at the server at `url` with certificate `fingerprint`. */
export function matchingStorages(storages: PveStorage[], url: string, fingerprint: string | null): PveStorage[] {
  let host = '', port = 8007
  try { const u = new URL(url); host = hostKey(u.hostname); port = Number(u.port || 8007) } catch { return [] }
  const fp = fingerprint ? normaliseFingerprint(fingerprint) : null
  return (storages ?? []).filter(s => {
    if (s?.type !== 'pbs' || !s.datastore || s.disable) return false
    const sfp = s.fingerprint ? normaliseFingerprint(s.fingerprint) : null
    if (fp && sfp) return sfp === fp
    return !!s.server && hostKey(s.server) === host && Number(s.port || 8007) === port
  })
}

const kindOf = (t: string): 'vm' | 'ct' | null => (t === 'qemu' ? 'vm' : t === 'lxc' ? 'ct' : null)

/** Guests that have no group in the matched datastores and namespaces. */
export function guestsWithoutGroup(guests: PveGuest[], groups: PbsGroup[], storages: PveStorage[]): ClusterCoverage['noGroup'] {
  const places = storages.map(s => ({ store: s.datastore!, ns: s.namespace ?? '' }))
  const have = new Set(groups.filter(g => places.some(p => p.store === g.store && p.ns === g.ns)).map(g => `${g.type}/${g.id}`))
  return (guests ?? [])
    .filter(g => !g.template && kindOf(g.type) && Number.isInteger(Number(g.vmid)))
    .map(g => ({ vmid: Number(g.vmid), name: String(g.name ?? '').slice(0, 64), type: kindOf(g.type)! }))
    .filter(g => !have.has(`${g.type}/${g.vmid}`))
    .sort((a, b) => a.vmid - b.vmid)
}

export interface CoverageDeps {
  clusters(): Array<{ id: string; name: string }>
  /** A GET on that cluster's Proxmox API, resolving with `data`. */
  pve(clusterId: string, path: string): Promise<any>
}

export async function coverageFor(url: string, fingerprint: string | null, groups: PbsGroup[], d: CoverageDeps): Promise<ClusterCoverage[]> {
  const out: ClusterCoverage[] = []
  for (const c of d.clusters()) {
    let storages: PveStorage[]
    try { storages = matchingStorages(await d.pve(c.id, '/storage'), url, fingerprint) } catch { continue }
    if (!storages.length) continue
    const row: ClusterCoverage = { clusterId: c.id, cluster: c.name, storages: storages.map(s => ({ storage: s.storage, datastore: s.datastore!, ns: s.namespace ?? '' })), noGroup: [], notInJob: null }
    try { row.noGroup = guestsWithoutGroup(await d.pve(c.id, '/cluster/resources?type=vm'), groups, storages) }
    catch { row.error = 'Its guest list could not be read.' }
    try {
      const nb = await d.pve(c.id, '/cluster/backup-info/not-backed-up')
      row.notInJob = Array.isArray(nb) ? nb.filter((g: any) => kindOf(g?.type)).map((g: any) => ({ vmid: Number(g.vmid), name: String(g.name ?? '').slice(0, 64), type: kindOf(g.type)! })) : null
    } catch { row.notInJob = null }
    out.push(row)
  }
  return out
}
