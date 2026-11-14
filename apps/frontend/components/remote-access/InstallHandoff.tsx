'use client'

// Remote access the installer set up. While HyperProx has not taken it over yet (lib/vpn/install-handoff.ts in
// the API does that when it is unlocked), the VPN page says what is waiting and why, with Retry. Once a
// WireGuard server is managed and has no peer yet, the page asks for the first phone: that peer is made
// through the normal, vault-backed flow, never by the installer.

// Buttons come in from the page (the shared Btn): this file stays free of styling imports, so it renders on its own.

export interface PendingVpnEntry {
  kind: 'wireguard' | 'tailscale'
  ctid: number
  machineId: string
  address?: string
  endpoint?: string
  ip?: string
  dnsName?: string
  lastError?: string
  attempts?: number
}

export function InstallHandoffNotice({ entries, retry }: { entries: PendingVpnEntry[]; retry: React.ReactNode }) {
  if (!entries.length) return null
  return (
    <div className="rounded-md border px-3 py-2 text-sm" style={{ borderColor: 'var(--border)' }} data-testid="install-handoff">
      <p style={{ color: 'var(--text-bright)' }}>Set up by the installer, waiting for HyperProx to take it over:</p>
      <ul className="mt-1 space-y-1">
        {entries.map(e => (
          <li key={`${e.kind}-${e.machineId}`} style={{ color: 'var(--text-soft)' }}>
            {e.kind === 'wireguard'
              ? `WireGuard server in container ${e.ctid} (${e.address ?? ''}, ${e.endpoint ?? ''})`
              : `Tailscale on this HyperProx (container ${e.ctid}, ${e.dnsName || e.ip})`}
            {e.lastError && <span style={{ color: 'var(--text-dim)' }}> · last try: {e.lastError}</span>}
          </li>
        ))}
      </ul>
      <div className="mt-2">{retry}</div>
    </div>
  )
}

/** The heading of one managed server, with the call to add the first phone when it has no peer yet. */
export function WgServerHeading({ name, iface, address, endpoint, keyBackedUp, peers, add, badge }: {
  name: string; iface: string; address: string; endpoint: string; keyBackedUp?: boolean; peers: number; add: React.ReactNode; badge?: React.ReactNode
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--border)' }}>
        <span className="font-semibold" style={{ color: 'var(--text-bright)' }}>{name} · {iface}</span>
        <span className="font-mono text-xs" style={{ color: 'var(--text-soft)' }}>{address} · {endpoint}</span>
        {keyBackedUp && badge}
        <span className="ml-auto">{add}</span>
      </div>
      {peers === 0 && (
        <p className="px-3 py-2 text-sm" style={{ color: 'var(--text-soft)' }} data-testid="add-first-phone">
          Ready. Add your phone: HyperProx makes its key in your browser, keeps it in the vault and shows a QR code to scan
          in the WireGuard app. Remember to forward UDP {endpoint.split(':').pop()} on your router to this container.
        </p>
      )}
    </>
  )
}
