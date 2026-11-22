// =============================================================================
//  HyperProx — MikroTik change engine: the lockout guard
//
//  Refuses, before anything is written, a plan that would cut HyperProx off from the router or the router's own
//  management from the LAN: the link, address, route, service or user HyperProx signs in with, anything on the
//  internet link HyperProx is reached through, and a firewall rule that would drop LAN traffic to the router's
//  management services. A refusal says in plain words what would have been cut. Pure: it reads a snapshot.
// =============================================================================

import { inSubnet, networkOf, ownSubnets } from '../mikrotik-lan'
import { ChangeRefusal, type ChangePlan, type Management, type Op, type Row, type Where } from './types'

/** What the guard needs to know about the router now. */
export interface Snapshot {
  addresses: Row[]
  routes: Row[]
  services: Row[]
  users: Row[]
  interfaces: Row[]
  filter: Row[]
  /** What the router knows about who has which MAC: used to see that a block does not name HyperProx by another way. */
  arp: Row[]
  leases: Row[]
}

export const MANAGEMENT_SERVICES = ['www', 'www-ssl', 'api', 'api-ssl', 'winbox', 'ssh']
/** Ports the management services listen on by default, plus HyperProx's own. */
const MGMT_PORTS = [80, 443, 8728, 8729, 8291, 22]
export const HYPERPROX_MARK = 'HyperProx'

const matches = (row: Row, where: Where) => Object.entries(where).every(([k, v]) => String(row[k] ?? '') === String(v))
const isTrue = (v: unknown) => v === 'true' || v === 'yes'

function refuse(text: string): never { throw new ChangeRefusal(409, 'lockout_guard', text) }

/** Port text ("80", "8000-8010", "80,443") as numbers that could be named. */
export function portSet(text: unknown): Set<number> | null {
  const t = String(text ?? '').trim()
  if (!t) return null
  const out = new Set<number>()
  for (const part of t.split(',')) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part.trim())
    if (!m) return null
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a
    for (let p = a; p <= Math.min(b, a + 70000); p++) out.add(p)
  }
  return out
}

export function managementPorts(m: Management, services: Row[]): Set<number> {
  const out = new Set<number>(MGMT_PORTS)
  if (m.port) out.add(m.port)
  for (const s of services) { const p = Number(s.port); if (MANAGEMENT_SERVICES.includes(String(s.name)) && Number.isInteger(p)) out.add(p) }
  return out
}

/** The link HyperProx's address sits on (the address row whose network holds the host), and whether it faces the internet. */
export function reachedThrough(m: Management, addresses: Row[]): { iface: string | null; address: string | null; viaWan: boolean } {
  for (const a of addresses) {
    if (isTrue(a.disabled)) continue
    const ip = String(a.address ?? '').split('/')[0]
    if (ip === m.host) {
      const iface = String(a['actual-interface'] || a.interface || '')
      return { iface: iface || null, address: String(a.address), viaWan: m.wan.includes(iface) }
    }
  }
  for (const a of addresses) {
    if (isTrue(a.disabled)) continue
    const net = networkOf(String(a.address ?? ''))
    if (net && inSubnet(m.host, net)) {
      const iface = String(a['actual-interface'] || a.interface || '')
      return { iface: iface || null, address: String(a.address), viaWan: m.wan.includes(iface) }
    }
  }
  return { iface: null, address: null, viaWan: false }
}

const dropsInput = (a: unknown) => a === 'drop' || a === 'reject'
const disables = (o: Op) => o.kind === 'remove' || (o.kind === 'set' && isTrue(o.props.disabled))

/** Throws a ChangeRefusal when any step of the plan would cut the way in. */
export function checkLockout(plan: Pick<ChangePlan, 'steps'>, m: Management, snap: Snapshot): void {
  const via = reachedThrough(m, snap.addresses)
  const mgmtPorts = managementPorts(m, snap.services)
  const lanNets = ownSubnets(snap.addresses, m.wan)

  for (const step of plan.steps) {
    const op = step.forward
    const P: Record<string, string> = op.kind === 'add' || op.kind === 'set' ? op.props : {}
    const rows = (table: Row[]) => op.kind === 'add' ? [] : table.filter(r => matches(r, op.where))

    switch (op.path) {
      case '/ip/service': {
        if (op.kind === 'add' || op.kind === 'command') break
        for (const r of rows(snap.services)) {
          if (!MANAGEMENT_SERVICES.includes(String(r.name))) continue
          const changesWay = op.kind === 'remove' || isTrue(P.disabled) || ('port' in P && String(P.port) !== String(r.port))
            || ('address' in P && String(P.address) !== String(r.address ?? ''))
          if (changesWay) refuse(`This would turn off or move the router's "${r.name}" service, which is how the router is managed. HyperProx will not do that: it could lock everyone out.`)
        }
        break
      }
      case '/ip/address': {
        if (op.kind === 'add' || op.kind === 'command') break
        const touching = rows(snap.addresses).filter(r => disables(op) || ('address' in P && P.address !== r.address) || ('interface' in P && P.interface !== r.interface))
        for (const r of touching) {
          const ip = String(r.address ?? '').split('/')[0]
          const iface = String(r['actual-interface'] || r.interface || '')
          if (ip === m.host || (via.iface && iface === via.iface && via.address === r.address)) refuse(`This would remove or change the router address ${r.address}, the one HyperProx reaches the router on. HyperProx will not cut itself off.`)
        }
        break
      }
      case '/interface': case '/interface/bridge': case '/interface/vlan': case '/interface/ethernet': {
        if (op.kind === 'add' || op.kind === 'command') break
        for (const r of rows(snap.interfaces)) {
          if (!disables(op) && !('name' in P)) continue
          const name = String(r.name ?? '')
          if (name && (name === via.iface || (via.viaWan && m.wan.includes(name) && name === via.iface))) refuse(`This would switch off or rename the link "${name}", which is how HyperProx reaches the router. HyperProx will not cut itself off.`)
        }
        break
      }
      case '/ip/route': {
        if (op.kind === 'add' || op.kind === 'command') break
        for (const r of rows(snap.routes)) {
          if (!disables(op)) continue
          const dst = String(r['dst-address'] ?? '')
          const conn = isTrue(r.connect)
          if (conn && via.address && networkOf(via.address) === networkOf(dst)) refuse(`This would remove the route for ${dst}, the network HyperProx reaches the router through.`)
          if (dst === '0.0.0.0/0' && via.viaWan) refuse('This would remove the default route, and HyperProx reaches the router through the internet link. HyperProx will not cut itself off.')
        }
        break
      }
      case '/user': {
        if (op.kind === 'add' || op.kind === 'command') break
        for (const r of rows(snap.users)) {
          if (m.username && r.name === m.username && (disables(op) || 'group' in P || 'password' in P || 'name' in P || 'address' in P)) {
            refuse(`This would change or switch off the router user "${r.name}", which is the login HyperProx uses. HyperProx will not cut itself off.`)
          }
        }
        break
      }
      case '/ip/firewall/filter': {
        // Turning off or deleting an input rule that lets management traffic in.
        if (op.kind === 'set' || op.kind === 'remove') {
          for (const r of rows(snap.filter)) {
            if (r.chain !== 'input' || r.action !== 'accept' || String(r.comment ?? '').startsWith(HYPERPROX_MARK)) continue
            if (!disables(op)) continue
            const ports = portSet(r['dst-port'])
            if (ports === null || [...mgmtPorts].some(p => ports.has(p))) refuse('This would turn off or delete a firewall rule that lets traffic reach the router\'s management services. HyperProx will not do that.')
          }
        }
        if (op.kind === 'add') {
          const p = op.props
          if (p.chain === 'input' && dropsInput(p.action) && !String(p.disabled) .match(/^(true|yes)$/)) {
            const ports = portSet(p['dst-port'])
            const hits = ports === null || [...mgmtPorts].some(x => ports.has(x))
            const proto = String(p.protocol ?? '')
            const tcpish = !proto || proto === 'tcp'
            const inIf = String(p['in-interface'] ?? '')
            const inList = String(p['in-interface-list'] ?? '')
            const wanOnly = (inIf && m.wan.includes(inIf)) || /^wan$/i.test(inList)
            const src = String(p['src-address'] ?? '')
            const srcCoversLan = !src || lanNets.some(n => inSubnet(src.split('/')[0], n) || (src.includes('/') && networkOf(src) === n))
            if (hits && tcpish && !wanOnly && srcCoversLan) refuse('This rule would drop traffic from your own network to the router\'s management services (the web page, API, Winbox and SSH). HyperProx will not add it.')
          }
        }
        break
      }
      case '/ip/firewall/nat': {
        if (op.kind === 'add' && P.chain === 'dstnat' && P.action === 'dst-nat' && via.viaWan) {
          const ports = portSet(P['dst-port'])
          const mine = m.port ?? (m.service === 'www-ssl' ? 443 : 80)
          const onWay = P['in-interface'] === via.iface || /^wan$/i.test(P['in-interface-list'] ?? '') || (!P['in-interface'] && !P['in-interface-list'])
          if (ports && ports.has(mine) && onWay) refuse(`Port ${mine} on the internet link is the one HyperProx reaches the router on. Forwarding it would send HyperProx's own traffic to another device.`)
        }
        break
      }
    }
    checkSelfBlock(op, m, snap)
  }
}

/** The MAC the router has for an address (ARP first, then the lease table). */
function macFor(address: string, snap: Snapshot): string {
  const a = snap.arp.find(r => r.address === address && r['mac-address'])
  if (a) return String(a['mac-address']).toUpperCase()
  const l = snap.leases.find(r => (r.address === address || r['active-address'] === address) && (r['mac-address'] || r['active-mac-address']))
  return l ? String(l['mac-address'] || l['active-mac-address']).toUpperCase() : ''
}

/**
 * A device block must never name the router, HyperProx, or an address the router answers on, by address or by MAC:
 * a block by MAC for HyperProx's own card cuts it off as surely as one by address.
 */
function checkSelfBlock(op: Op, m: Management, snap: Snapshot): void {
  if (op.kind !== 'add' || op.path !== '/ip/firewall/filter' || op.props.chain !== 'forward' || !dropsInput(op.props.action)) return
  const src = String(op.props['src-address'] ?? '').split('/')[0]
  const mac = String(op.props['src-mac-address'] ?? '').toUpperCase()
  const selfMac = String(m.selfMac ?? '').toUpperCase()
  const ownMacs = new Set(snap.interfaces.map(r => String(r['mac-address'] ?? '').toUpperCase()).filter(Boolean))
  if (src) {
    const own = snap.addresses.map(a => String(a.address ?? '').split('/')[0])
    if (own.includes(src) || src === m.host) refuse('That address is the router itself. HyperProx will not block it.')
    if (m.selfAddress && src === m.selfAddress) refuse('That address is HyperProx. Blocking it would cut HyperProx off from the internet.')
    const theirMac = macFor(src, snap)
    if (selfMac && theirMac === selfMac) refuse('That address belongs to the same device as HyperProx. Blocking it would cut HyperProx off from the internet.')
    if (theirMac && ownMacs.has(theirMac)) refuse('That address belongs to the router itself. HyperProx will not block it.')
  }
  if (mac) {
    if (selfMac && mac === selfMac) refuse('That device is HyperProx. Blocking it would cut HyperProx off from the internet.')
    if (ownMacs.has(mac)) refuse('That is one of the router\'s own network ports. HyperProx will not block it.')
    if (m.selfAddress && macFor(m.selfAddress, snap) === mac) refuse('That device is HyperProx. Blocking it would cut HyperProx off from the internet.')
  }
}
