// =============================================================================
//  HyperProx — HA management: reading the cluster
//
//  Every read the HA feature makes, through one small interface so tests run
//  against a fake. Reads only: the writes live in plans.ts and power.ts.
// =============================================================================

import { buildSnapshot, parseSid, type RawHa } from './parse'
import type { HaSnapshot, Sid } from './types'

/** The slice of ProxmoxClient HA needs. fetchStrict rejects on any non-2xx answer with PVE's own reason. */
export interface HaPve {
  fetchStrict<T>(path: string, method?: string, body?: string, timeoutMs?: number): Promise<T>
}

const enc = encodeURIComponent

/** Config of one guest, or null when it cannot be read (the guest is gone, or the node is down). */
export async function readConfig(pve: HaPve, node: string, sid: Sid): Promise<Record<string, unknown> | null> {
  const p = parseSid(sid)
  if (!p) return null
  return pve.fetchStrict<Record<string, unknown>>(`/nodes/${enc(node)}/${p.type}/${p.vmid}/config`).catch(() => null)
}

export interface ReadOptions {
  /** Whose configs to read for hardware facts: every HA guest (default), these sids as well, or none. */
  configs?: 'ha' | 'none'
  extra?:   Sid[]
}

export async function readRaw(pve: HaPve, opts: ReadOptions = {}): Promise<RawHa> {
  const [resources, rules, status, manager, nodes, vms, storage, options] = await Promise.all([
    pve.fetchStrict<any[]>('/cluster/ha/resources'),
    pve.fetchStrict<any[]>('/cluster/ha/rules'),
    pve.fetchStrict<any[]>('/cluster/ha/status/current'),
    pve.fetchStrict<any>('/cluster/ha/status/manager_status').catch(() => null),
    pve.fetchStrict<any[]>('/nodes'),
    pve.fetchStrict<any[]>('/cluster/resources?type=vm'),
    pve.fetchStrict<any[]>('/cluster/resources?type=storage').catch(() => []),
    pve.fetchStrict<any>('/cluster/options').catch(() => null),
  ])
  const raw: RawHa = { resources: resources ?? [], rules: rules ?? [], status: status ?? [], manager, nodes: nodes ?? [], vms: vms ?? [], storage: storage ?? [], options }
  if (opts.configs !== 'none' || opts.extra?.length) {
    const want = new Set<Sid>([...(opts.configs === 'none' ? [] : raw.resources.map((r: any) => String(r.sid))), ...(opts.extra ?? [])])
    const configs: Record<string, Record<string, unknown> | null> = {}
    await Promise.all([...want].map(async sid => {
      const p = parseSid(sid)
      const v = p && raw.vms.find((x: any) => Number(x.vmid) === p.vmid)
      if (v) configs[sid] = await readConfig(pve, String(v.node), sid)
    }))
    raw.configs = configs
  }
  return raw
}

export async function readSnapshot(pve: HaPve, opts: ReadOptions = {}): Promise<HaSnapshot> {
  return buildSnapshot(await readRaw(pve, opts))
}

/** The migrate preconditions PVE computes for a guest (all target nodes at once). */
export async function readMigratePreconditions(pve: HaPve, node: string, sid: Sid): Promise<any> {
  const p = parseSid(sid)
  if (!p) throw new Error(`Not a guest id: ${sid}`)
  return pve.fetchStrict<any>(`/nodes/${enc(node)}/${p.type}/${p.vmid}/migrate`)
}
