// =============================================================================
//  HyperProx — the VPN slot on Infrastructure
//
//  The list's badge column and the guest drill-down's VPN tab read from one
//  interface. Until a remote-access service is wired in, the stub answers
//  "not available" for every guest, and the UI says so rather than guessing.
// =============================================================================

export type GuestKey = `${'lxc' | 'qemu'}/${number}`

export interface VpnGuestRef { node: string; type: 'lxc' | 'qemu'; vmid: number; name: string }

export interface VpnGuestStatus {
  /** not-available: no VPN service is configured in HyperProx. none: configured, this guest is not on it. */
  state: 'not-available' | 'none' | 'connected' | 'disconnected' | 'unknown'
  /** e.g. 'tailscale', 'netbird'. */
  provider?: string
  /** The guest's address on the VPN. */
  address?: string
  /** Its name on the VPN. */
  hostname?: string
  /** ISO time it was last seen by the VPN's control plane. */
  lastSeen?: string
  /** One line for the badge's tooltip or the tab. */
  detail?: string
}

export interface VpnStatusSource {
  /** Shown in the VPN tab, e.g. "Tailscale". */
  readonly name: string
  /** Whether a VPN service is configured at all. */
  available(): Promise<boolean>
  /** Status per guest, keyed `${type}/${vmid}`. Guests it does not know may be left out (read as 'none'). */
  statusFor(guests: VpnGuestRef[]): Promise<Map<GuestKey, VpnGuestStatus>>
}

export const notAvailableVpn: VpnStatusSource = {
  name: 'VPN',
  async available() { return false },
  async statusFor(guests) {
    return new Map(guests.map(g => [`${g.type}/${g.vmid}` as GuestKey, { state: 'not-available', detail: 'No VPN service is set up in HyperProx yet.' }]))
  },
}

let current: VpnStatusSource = notAvailableVpn

export function setVpnStatusSource(s: VpnStatusSource): void { current = s }
export function vpnStatusSource(): VpnStatusSource { return current }

/** Every guest gets an answer: a source that throws or leaves a guest out never blanks the list. */
export async function vpnStatuses(guests: VpnGuestRef[], source = current): Promise<Map<GuestKey, VpnGuestStatus>> {
  const out = new Map<GuestKey, VpnGuestStatus>()
  let got: Map<GuestKey, VpnGuestStatus> | null = null
  let available = false
  try { available = await source.available(); got = available ? await source.statusFor(guests) : await notAvailableVpn.statusFor(guests) }
  catch (e: any) { got = null; available = true; for (const g of guests) out.set(`${g.type}/${g.vmid}`, { state: 'unknown', detail: `Could not ask ${source.name}: ${e?.message ?? e}` }) ; return out }
  for (const g of guests) {
    const k = `${g.type}/${g.vmid}` as GuestKey
    out.set(k, got?.get(k) ?? (available ? { state: 'none', provider: source.name } : { state: 'not-available' }))
  }
  return out
}
