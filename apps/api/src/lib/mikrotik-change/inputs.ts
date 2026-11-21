// What the plan builders and the page read from the router, and the plain-English views of it. Reads only.

import { inSubnet, networkOf, ownSubnets } from '../mikrotik-lan'
import { arr, isTrue } from './rows'
import type { ChangeRouter, Row } from './types'

export interface RouterInputs {
  leases: Row[]
  dhcpServers: Row[]
  dhcpNetworks: Row[]
  addresses: Row[]
  arp: Row[]
  nat: Row[]
  filter: Row[]
  listMembers: Row[]
  /** The internet-facing links, as the plug-in works them out. */
  wan: string[]
}

export async function readInputs(router: ChangeRouter, wan: string[]): Promise<RouterInputs> {
  const g = (p: string) => router.get(`/rest${p}`, 15_000).then(arr, () => [] as Row[])
  const [leases, dhcpServers, dhcpNetworks, addresses, arp, nat, filter, listMembers] = await Promise.all([
    g('/ip/dhcp-server/lease'), g('/ip/dhcp-server'), g('/ip/dhcp-server/network'), g('/ip/address'), g('/ip/arp'),
    g('/ip/firewall/nat'), g('/ip/firewall/filter'), g('/interface/list/member'),
  ])
  return { leases, dhcpServers, dhcpNetworks, addresses, arp, nat, filter, listMembers, wan }
}

// ── devices ──────────────────────────────────────────────────────────────────

export interface DeviceRow {
  mac: string; address: string; name: string | null
  /** A fixed (static) lease already holds this device's address. */
  fixed: boolean
  leaseId: string | null
  server: string | null
  interface: string | null
}

export const upperMac = (m: unknown) => String(m ?? '').toUpperCase()
export const isStatic = (l: Row) => l.dynamic !== 'true'

/** Every device the router knows on the LAN, once, with whether its address is already fixed. */
export function devicesOf(i: RouterInputs): DeviceRow[] {
  const own = ownSubnets(i.addresses, i.wan)
  const out = new Map<string, DeviceRow>()
  for (const l of i.leases) {
    const mac = upperMac(l['mac-address'] || l['active-mac-address'])
    if (!mac || isTrue(l.disabled)) continue
    const address = String(l.address || l['active-address'] || '')
    const prev = out.get(mac)
    const fixed = isStatic(l)
    if (prev && prev.fixed && !fixed) continue
    out.set(mac, { mac, address: address || prev?.address || '', name: String(l['host-name'] || l.comment || '') || prev?.name || null, fixed, leaseId: String(l['.id'] ?? '') || null, server: String(l.server ?? '') || null, interface: prev?.interface ?? null })
  }
  for (const a of i.arp) {
    const mac = upperMac(a['mac-address'])
    const iface = String(a.interface ?? '')
    if (!mac || i.wan.includes(iface) || isTrue(a.disabled)) continue
    if (own.length && !own.some(n => inSubnet(String(a.address ?? ''), n))) continue
    const prev = out.get(mac)
    if (prev) { prev.interface = prev.interface || iface || null; if (!prev.address) prev.address = String(a.address ?? ''); if (!prev.name && a.comment) prev.name = String(a.comment); continue }
    out.set(mac, { mac, address: String(a.address ?? ''), name: a.comment ? String(a.comment) : null, fixed: false, leaseId: null, server: null, interface: iface || null })
  }
  return [...out.values()].filter(d => d.address).sort((x, y) => (x.name ?? '~').localeCompare(y.name ?? '~') || x.address.localeCompare(y.address, undefined, { numeric: true }))
}

export function nameOfAddress(devs: DeviceRow[], ip: string): string | null {
  return devs.find(d => d.address === ip)?.name ?? null
}

// ── fixed addresses ──────────────────────────────────────────────────────────

export interface LeaseView { id: string; address: string; mac: string; name: string; comment: string; server: string; fixed: boolean; status: string; disabled: boolean; words: string }

export function leaseViews(i: RouterInputs): LeaseView[] {
  return i.leases.filter(isStatic).map(l => {
    const name = String(l['host-name'] || '')
    const comment = String(l.comment ?? '')
    return {
      id: String(l['.id']), address: String(l.address ?? ''), mac: upperMac(l['mac-address']), name, comment, server: String(l.server ?? ''),
      fixed: true, status: String(l.status ?? ''), disabled: isTrue(l.disabled),
      words: `${comment || name || upperMac(l['mac-address'])} always gets ${l.address}`,
    }
  }).sort((a, b) => a.address.localeCompare(b.address, undefined, { numeric: true }))
}

// ── port forwards ────────────────────────────────────────────────────────────

export const RISKY: Record<number, string> = {
  3389: 'Remote Desktop', 22: 'SSH remote login', 23: 'Telnet (unencrypted remote login)', 445: 'Windows file sharing', 139: 'Windows file sharing (NetBIOS)',
  5900: 'VNC screen sharing', 3306: 'a MySQL database', 5432: 'a PostgreSQL database', 8006: 'Proxmox management', 8007: 'Proxmox Backup management',
  2375: 'Docker remote control (unencrypted)', 2376: 'Docker remote control',
}

export function parsePorts(text: unknown): { from: number; to: number } | null {
  const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(String(text ?? '').trim())
  if (!m) return null
  const from = Number(m[1]), to = m[2] ? Number(m[2]) : from
  if (from < 1 || to > 65535 || to < from) return null
  return { from, to }
}

export function riskyIn(...texts: unknown[]): Array<{ port: number; why: string }> {
  const out = new Map<number, string>()
  for (const t of texts) {
    const r = parsePorts(t); if (!r) continue
    for (const [p, why] of Object.entries(RISKY)) if (Number(p) >= r.from && Number(p) <= r.to) out.set(Number(p), why)
  }
  return [...out.entries()].map(([port, why]) => ({ port, why })).sort((a, b) => a.port - b.port)
}

export function riskText(r: Array<{ port: number; why: string }>): string {
  const names = r.map(x => `${x.port} (${x.why})`).join(', ')
  return `Port ${names} is one that attackers scan for all day once it faces the internet. Tick the box only if you need it open and the device behind it is kept up to date with a strong login.`
}

export const isForward = (r: Row) => r.chain === 'dstnat' && r.action === 'dst-nat'

export function scopeOf(r: Row): string { return String(r['in-interface'] || r['in-interface-list'] || '') }

export interface ForwardView {
  id: string; name: string; proto: string; port: string; toAddress: string; toPort: string; toName: string | null; disabled: boolean
  wan: string; mine: boolean; words: string; risky: string | null
}

export const HYPERPROX_FORWARD = 'HyperProx forward:'

export function forwardViews(i: RouterInputs): ForwardView[] {
  const devs = devicesOf(i)
  return i.nat.filter(isForward).map(r => {
    const proto = String(r.protocol || 'tcp').toUpperCase()
    const port = String(r['dst-port'] ?? '')
    const toAddress = String(r['to-addresses'] ?? '')
    const toPort = String(r['to-ports'] || port)
    const toName = nameOfAddress(devs, toAddress)
    const disabled = isTrue(r.disabled)
    const risk = riskyIn(port, toPort)
    const comment = String(r.comment ?? '')
    return {
      id: String(r['.id']), name: comment.replace(/\s*\[hpx-[0-9a-f]{6}\]$/, '').replace(/^HyperProx forward:\s*/, '') || (toName ?? toAddress),
      proto, port, toAddress, toPort, toName, disabled, wan: scopeOf(r), mine: comment.startsWith(HYPERPROX_FORWARD),
      words: `Outside port ${port || 'any'} → ${toName ? `${toName} (${toAddress})` : toAddress} port ${toPort || 'any'}, ${proto}${disabled ? ' (switched off)' : ''}`,
      risky: risk.length && !disabled ? riskText(risk) : null,
    }
  })
}

/** A hairpin rule lets devices on the LAN reach a forward through the router's public address. Shown only. */
export function hasHairpin(i: RouterInputs): boolean {
  const own = ownSubnets(i.addresses, i.wan)
  const lanIfaces = new Set(i.addresses.map(a => String(a.interface ?? '')).filter(x => x && !i.wan.includes(x)))
  return i.nat.some(r => r.chain === 'srcnat' && !isTrue(r.disabled) && (r.action === 'masquerade' || r.action === 'src-nat') && (
    (r['dst-address'] && own.some(n => networkOf(String(r['dst-address'])) === n || inSubnet(String(r['dst-address']).split('/')[0], n)))
    || lanIfaces.has(String(r['out-interface'] ?? ''))
    || (r['src-address'] && r['dst-address'])))
}

export const HAIRPIN_NOTE = 'No "hairpin" rule exists on the router: devices on your own network that open this forward through the router\'s public address will not get through (they can use the device\'s own address instead). HyperProx does not add one.'

// ── device blocks ────────────────────────────────────────────────────────────

export const BLOCK_PREFIX = 'HyperProx block:'
export const isBlock = (r: Row) => r.chain === 'forward' && r.action === 'drop' && String(r.comment ?? '').startsWith(BLOCK_PREFIX)

export interface BlockView { id: string; target: string; name: string; schedule: string | null; disabled: boolean; words: string }

/** "22:00:00-06:00:00,mon,tue" in words. The router may write the time as "22h-6h". */
export function scheduleWords(time: string): string | null {
  const t = String(time || '').trim()
  if (!t) return null
  const [range, ...days] = t.split(',')
  const clock = (x: string) => { const m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?h?$/.exec(x.trim()); return m ? `${m[1].padStart(2, '0')}:${m[2] ?? '00'}` : x }
  const [from, to] = range.split('-')
  const everyDay = days.length === 0 || days.length === 7
  return `from ${clock(from ?? '')} to ${clock(to ?? '')}${everyDay ? ' every day' : ` on ${days.join(', ')}`}`
}

export function blockViews(i: RouterInputs): BlockView[] {
  const devs = devicesOf(i)
  return i.filter.filter(isBlock).map(r => {
    const mac = upperMac(r['src-mac-address'])
    const target = mac || String(r['src-address'] ?? '')
    const dev = devs.find(d => (mac && d.mac === mac) || (!mac && d.address === target))
    const name = String(r.comment).replace(BLOCK_PREFIX, '').replace(/\s*\[hpx-[0-9a-f]{6}\]$/, '').trim() || dev?.name || target
    const schedule = scheduleWords(String(r.time ?? ''))
    const disabled = isTrue(r.disabled)
    return { id: String(r['.id']), target, name, schedule, disabled, words: `${name} (${target}) ${disabled ? 'has its block switched off' : schedule ? `has no internet ${schedule}` : 'has no internet'}` }
  })
}
