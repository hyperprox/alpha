// =============================================================================
//  HyperProx — the one way to list a cluster's guests
//
//  `/cluster/resources?type=vm`, turned into rows. Templates are listed (callers decide whether they count).
// =============================================================================

import type { ProxmoxClient } from '../proxmox-client'
import { parseTags } from '../guest-guard'
import type { GuestKind } from '../guest-id'

export interface ClusterGuest {
  type: GuestKind
  vmid: number
  node: string
  name: string
  running: boolean
  tags: string[]
  template: boolean
  /** The row as Proxmox sent it, for the few callers that read more (status, cpu, mem). */
  raw: any
}

export function guestListings(rows: unknown): ClusterGuest[] {
  return (Array.isArray(rows) ? rows : []).filter((r: any) => r && (r.type === 'lxc' || r.type === 'qemu')).map((r: any) => ({
    type: r.type as GuestKind, vmid: Number(r.vmid), node: String(r.node), name: String(r.name ?? r.vmid),
    running: r.status === 'running', tags: parseTags(r.tags), template: r.template === 1, raw: r,
  }))
}

/**
 * The guests of a cluster. By default a failed read throws (Proxmox's own reason); `{ strict: false }` reads the way
 * `getClusterResources` does, where a non-2xx answer is not an error (it yields whatever data came back).
 */
export async function listGuests(pve: Pick<ProxmoxClient, 'fetchStrict'> & Partial<Pick<ProxmoxClient, 'getClusterResources'>>, opts: { strict?: boolean } = {}): Promise<ClusterGuest[]> {
  if (opts.strict === false && pve.getClusterResources) return guestListings(await pve.getClusterResources('vm'))
  return guestListings(await pve.fetchStrict<any[]>('/cluster/resources?type=vm'))
}
