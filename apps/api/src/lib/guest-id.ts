// =============================================================================
//  HyperProx — the one place a guest's identity is spelled
//
//  A guest has three spellings in use: Remote access's machine id (`lxc-101`), the
//  HA service id (`ct:101`) and the URL path (`/lxc/101`). Build and read them here.
// =============================================================================

export type GuestKind = 'lxc' | 'qemu'

/** A guest by its type and Proxmox id. */
export interface GuestRef { type: GuestKind; vmid: number }

/** Remote access's machine id: `lxc-<vmid>` or `qemu-<vmid>`. */
export const machineId = (g: { type: string; vmid: number | string }): string => `${g.type}-${g.vmid}`

/** The HA service id: `ct:<vmid>` for a container, `vm:<vmid>` for a virtual machine. */
export function sidOf(type: GuestKind, vmid: number | string): string { return `${type === 'lxc' ? 'ct' : 'vm'}:${vmid}` }

/** A service id as it may arrive from a client. */
export const SID_PATTERN = /^(ct|vm):\d{1,9}$/
export const isSid = (v: unknown): v is string => typeof v === 'string' && SID_PATTERN.test(v)

/** `/lxc/101` or `/qemu/101` (the two path parameters), or null when it is not a guest. */
export function parseGuestPath(type: string, vmid: string): GuestRef | null {
  if ((type !== 'lxc' && type !== 'qemu') || !/^\d{1,9}$/.test(vmid)) return null
  return { type, vmid: Number(vmid) }
}
