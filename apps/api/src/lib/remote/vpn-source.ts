// =============================================================================
//  HyperProx — the Infrastructure VPN slot, filled by remote access
//
//  Adapts the VPN page's overview to lib/guest-config/vpn.ts's VpnStatusSource:
//  one answer per guest. A guest on both Tailscale and NetBird gets the
//  connected one (Tailscale first when both are) and the other in `detail`.
//  While HyperProx is locked, every guest is "unknown — HyperProx is locked".
// =============================================================================

import type { GuestKey, VpnGuestRef, VpnGuestStatus, VpnStatusSource } from '../guest-config/vpn'
import type { RemoteAccessService, RemoteCell, RemoteMachineRow } from './service'
import { PROVIDER_IDS, PROVIDER_LABEL, type ProviderId } from './types'

const LOCKED = 'HyperProx is locked — sign in to see VPN status.'

function stateOf(c: RemoteCell): VpnGuestStatus['state'] {
  if (c.state === 'connected') return 'connected'
  if (c.state === 'offline' || c.state === 'missing' || c.state === 'signed-out') return 'disconnected'
  if (c.state === 'unknown') return 'unknown'
  return 'none'
}

/** The status for one machine row: the primary provider, the others named in `detail`. */
export function guestStatus(row: RemoteMachineRow): VpnGuestStatus {
  const on = PROVIDER_IDS.map(p => [p, row.cells[p]] as [ProviderId, RemoteCell]).filter(([, c]) => stateOf(c) !== 'none')
  if (!on.length) return { state: 'none' }
  const rank = (c: RemoteCell) => ({ connected: 0, disconnected: 1, unknown: 2, none: 3, 'not-available': 4 })[stateOf(c)]
  on.sort((a, b) => rank(a[1]) - rank(b[1]))
  const [[p, c], ...rest] = on
  const others = rest.map(([q, d]) => `${PROVIDER_LABEL[q]}: ${d.state}${d.ip ? ` (${d.ip})` : ''}`)
  return {
    state: stateOf(c), provider: p,
    ...(c.ip ? { address: c.ip } : {}), ...(c.dnsName || c.deviceName ? { hostname: c.dnsName ?? c.deviceName ?? undefined } : {}),
    ...(c.lastSeen ? { lastSeen: c.lastSeen } : {}),
    detail: [
      `${c.detectedText ?? `${PROVIDER_LABEL[p]} ${c.state}`}${c.expiryWarning ? ', key expires soon' : ''}`,
      ...(!c.managed && c.detected?.installed ? ['found, not managed by HyperProx'] : []),
      ...(others.length ? [`also ${others.join('; ')}`] : []),
    ].join('; '),
  }
}

export function remoteVpnSource(service: Pick<RemoteAccessService, 'overview'>, isUnlocked: () => boolean): VpnStatusSource {
  return {
    name: 'VPN',
    async available() {
      if (!isUnlocked()) return true    // say "locked" per guest rather than "not set up"
      // Available with no API key too: clients already on the machines are found and shown.
      try { const ov = await service.overview(); return ov.providers.some(p => p.configured) || !!ov.detection?.checkedAt } catch { return true }
    },
    async statusFor(guests: VpnGuestRef[]) {
      const out = new Map<GuestKey, VpnGuestStatus>()
      const key = (g: VpnGuestRef) => `${g.type}/${g.vmid}` as GuestKey
      if (!isUnlocked()) { for (const g of guests) out.set(key(g), { state: 'unknown', detail: LOCKED }); return out }
      let rows: RemoteMachineRow[]
      try { rows = (await service.overview()).machines }
      catch (e: any) {
        const locked = /locked/i.test(String(e?.message))
        for (const g of guests) out.set(key(g), { state: 'unknown', detail: locked ? LOCKED : `Could not read VPN status: ${String(e?.message ?? e).slice(0, 160)}` })
        return out
      }
      for (const g of guests) {
        const row = rows.find(r => r.id === `${g.type}-${g.vmid}`)
        out.set(key(g), row ? guestStatus(row) : { state: 'none' })
      }
      return out
    },
  }
}
