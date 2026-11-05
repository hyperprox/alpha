// The Infrastructure VPN slot, filled from the VPN overview: one status per guest, the primary provider first and
// the others in `detail`, and "HyperProx is locked" while it is.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { remoteVpnSource } from '../src/lib/remote/vpn-source'
import { vpnStatuses } from '../src/lib/guest-config/vpn'

const cell = (state: string, ip: string | null = null, extra: Record<string, unknown> = {}) => ({
  state, managed: state !== 'not-installed', ip, version: null, lastSeen: null, deviceName: null, mode: null, routes: [], exitNode: false,
  lastError: null, adopted: false, dnsName: null, expiresAt: null, expiryWarning: false, keyExpiryDisabled: false, pending: false, tags: [],
  prefs: null, loginPending: false, ...extra,
})
const ov = {
  providers: [{ id: 'tailscale', label: 'Tailscale', configured: true, error: null, devices: 2 }, { id: 'netbird', label: 'NetBird', configured: true, error: null, devices: 1 }],
  machines: [
    { id: 'lxc-101', kind: 'lxc', name: 'web', node: 'pve-a', vmid: 101, running: true, cells: { tailscale: cell('offline', '100.64.0.5'), netbird: cell('connected', '100.92.0.4', { dnsName: 'web.netbird.cloud', lastSeen: '2026-11-05T09:00:00Z' }) } },
    { id: 'qemu-102', kind: 'qemu', name: 'app', node: 'pve-a', vmid: 102, running: true, cells: { tailscale: cell('not-installed'), netbird: cell('not-installed') } },
  ],
  activeJobId: null, attention: [], pendingRevokes: 0, pendingDevices: [],
} as any

test('one answer per guest: the connected provider is primary, the other is named', async () => {
  const src = remoteVpnSource({ overview: async () => ov }, () => true)
  assert.equal(await src.available(), true)
  const m = await vpnStatuses([{ node: 'pve-a', type: 'lxc', vmid: 101, name: 'web' }, { node: 'pve-a', type: 'qemu', vmid: 102, name: 'app' }, { node: 'pve-a', type: 'lxc', vmid: 999, name: 'x' }], src)
  assert.deepEqual(m.get('lxc/101'), { state: 'connected', provider: 'netbird', address: '100.92.0.4', hostname: 'web.netbird.cloud', lastSeen: '2026-11-05T09:00:00Z', detail: 'NetBird connected; also Tailscale: offline (100.64.0.5)' })
  assert.deepEqual(m.get('qemu/102'), { state: 'none' })
  assert.equal(m.get('lxc/999')?.state, 'none')
})

test('while locked, every guest is unknown and says HyperProx is locked; nothing is read', async () => {
  let read = false
  const src = remoteVpnSource({ overview: async () => { read = true; return ov } }, () => false)
  const m = await vpnStatuses([{ node: 'pve-a', type: 'lxc', vmid: 101, name: 'web' }], src)
  assert.equal(m.get('lxc/101')?.state, 'unknown')
  assert.match(m.get('lxc/101')?.detail ?? '', /HyperProx is locked/)
  assert.equal(read, false)
})

test('nothing configured: the slot says not available', async () => {
  const src = remoteVpnSource({ overview: async () => ({ ...ov, providers: ov.providers.map((p: any) => ({ ...p, configured: false })) }) }, () => true)
  const m = await vpnStatuses([{ node: 'pve-a', type: 'lxc', vmid: 101, name: 'web' }], src)
  assert.equal(m.get('lxc/101')?.state, 'not-available')
})

test('no API key, but the machines were probed: the slot is available and shows what is on each guest', async () => {
  const det = (text: string) => ({ detected: { installed: true }, detectedText: text, managed: false })
  const probed = {
    ...ov,
    providers: ov.providers.map((p: any) => ({ ...p, configured: false })),
    detection: { checkedAt: '2026-11-05T10:00:00Z', running: false },
    machines: [
      { ...ov.machines[0], cells: { tailscale: cell('connected', '100.64.0.21', { dnsName: 'web.tail0000.ts.net', ...det('Tailscale installed, connected as web.tail0000.ts.net (100.64.0.21)') }), netbird: cell('not-installed') } },
      { ...ov.machines[1], cells: { tailscale: cell('signed-out', null, det('Tailscale installed, signed out')), netbird: cell('not-installed') } },
    ],
  }
  const src = remoteVpnSource({ overview: async () => probed }, () => true)
  assert.equal(await src.available(), true)
  const m = await vpnStatuses([{ node: 'pve-a', type: 'lxc', vmid: 101, name: 'web' }, { node: 'pve-a', type: 'qemu', vmid: 102, name: 'app' }], src)
  assert.equal(m.get('lxc/101')?.state, 'connected')
  assert.equal(m.get('lxc/101')?.detail, 'Tailscale installed, connected as web.tail0000.ts.net (100.64.0.21); found, not managed by HyperProx')
  assert.equal(m.get('qemu/102')?.state, 'disconnected')
  assert.match(m.get('qemu/102')?.detail ?? '', /signed out/)
})
