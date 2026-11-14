// The VPN page's headline and counts. A tunnel is "down" only when it was checked and found down: a machine
// that was never looked at (or is stopped) is "not checked yet", never a tunnel that is down.
import type { RemoteMachineRow, RemoteProviderId } from '@hyperprox/types'

const DOWN = new Set(['offline', 'signed-out', 'missing'])

export interface VpnProviderLite { id: RemoteProviderId; error?: string | null }
export interface VpnTally { connected: number; down: number; notChecked: number }

/** One provider's tunnels: connected, checked-and-down (a running machine with a client HyperProx manages or has looked inside), not checked yet. */
export function vpnTally(rows: RemoteMachineRow[], provider: RemoteProviderId): VpnTally {
  let connected = 0, down = 0, notChecked = 0
  for (const r of rows) {
    const c = r.cells[provider]
    if (!c) continue
    if (c.state === 'connected') connected++
    else if (c.state === 'unchecked' && r.running !== false) notChecked++
    else if (DOWN.has(c.state) && r.running !== false && (c.managed || !!c.checkedAt)) down++
  }
  return { connected, down, notChecked }
}

export function vpnTotals<P extends VpnProviderLite>(rows: RemoteMachineRow[], providers: P[]) {
  const per = providers.map(p => ({ p, ...vpnTally(rows, p.id) }))
  const connected = per.reduce((n, x) => n + x.connected, 0)
  const down = per.reduce((n, x) => n + x.down, 0) + providers.filter(p => p.error).length
  const notChecked = per.reduce((n, x) => n + x.notChecked, 0)
  return { per, connected, down, notChecked }
}

export function vpnHeadline(t: { connected: number; down: number; notChecked: number }): string {
  const s = (n: number) => (n === 1 ? ' is' : 's are')
  if (t.down) return `${t.down} tunnel${s(t.down)} down or signed out`
  if (t.connected) return `${t.connected} tunnel${s(t.connected)} connected`
  if (t.notChecked) return 'Tunnels not checked yet'
  return 'No tunnels connected yet'
}
