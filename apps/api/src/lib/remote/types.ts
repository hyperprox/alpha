// =============================================================================
//  HyperProx — Remote access: shared types
//
//  Two providers (Tailscale, NetBird) behind one interface, deployed onto four
//  kinds of machine. See docs/superpowers/specs/2026-11-03-remote-access-design.md.
// =============================================================================

export type ProviderId = 'tailscale' | 'netbird'
export const PROVIDER_IDS: readonly ProviderId[] = ['tailscale', 'netbird']
export const isProviderId = (v: unknown): v is ProviderId => v === 'tailscale' || v === 'netbird'

export const PROVIDER_LABEL: Record<ProviderId, string> = { tailscale: 'Tailscale', netbird: 'NetBird' }

/** Official download pages, for machines HyperProx does not install on itself (Windows, macOS). */
export const DOWNLOAD_URL: Record<ProviderId, string> = {
  tailscale: 'https://tailscale.com/download',
  netbird:   'https://docs.netbird.io/get-started/install',
}

export type MachineKind = 'node' | 'lxc' | 'qemu' | 'host'

/** A node, a guest, or a host added by hand in the Terminal. `id` is `<kind>-<name or vmid>`. */
export interface Machine {
  id:       string
  kind:     MachineKind
  name:     string
  /** The node a guest lives on (and a node's own name). */
  node?:    string
  vmid?:    number
  running:  boolean
  /** Proxmox `ostype` for guests (`l26`, `win11`, `debian`...). */
  ostype?:  string
  /** An address HyperProx knows for the machine (a node's cluster address, a guest's LAN address). */
  address?: string
}

/** A device (Tailscale) or peer (NetBird), in one shape. */
export interface ProviderDevice {
  id:        string
  /** Tailscale's stable node id (`n...`), which the client reports as Self.ID. */
  nodeKey?:  string
  name:      string
  hostname?: string
  addresses: string[]
  online:    boolean
  lastSeen:  string | null
  version:   string | null
  os?:       string
}

export interface MintedKey { id: string; secret: string; expiresAt: string }

export interface RoutingRequest { subnets: string[]; exitNode: boolean }

export interface RemoteProvider {
  readonly id: ProviderId
  /** One line for the Settings Test button. Throws ProviderError on failure. */
  test(): Promise<string>
  /** A key for exactly one install. `tags` are Tailscale tags or NetBird group names. */
  mintKey(o: { name: string; tags: string[] }): Promise<MintedKey>
  revokeKey(id: string): Promise<void>
  listDevices(): Promise<ProviderDevice[]>
  deleteDevice(id: string): Promise<void>
  /**
   * Make the provider route `r` through `device`. `previous` are route ids this function returned last time
   * (NetBird); they are removed first. Returns the ids to remember (empty for Tailscale).
   */
  setRouting(device: ProviderDevice, r: RoutingRequest, previous: string[]): Promise<string[]>
}

/** A provider API failure. The message carries the status and the provider's own message, never a credential. */
export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'ProviderError' }
}
