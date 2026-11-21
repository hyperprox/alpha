// =============================================================================
//  HyperProx — MikroTik: the plans for fixed addresses, port forwards and device blocks
//
//  Each builder is pure: it takes what the router answered (inputs.ts) and the person's request, and returns a plan
//  (types.ts) or refuses in plain words. Nothing here talks to the router.
// =============================================================================

import { inSubnet, networkOf, ownSubnets } from '../mikrotik-lan'
import {
  BLOCK_PREFIX, HYPERPROX_FORWARD, devicesOf, hasHairpin, isBlock, isForward, isStatic, nameOfAddress, parsePorts, riskText, riskyIn, scopeOf, upperMac,
  type RouterInputs,
} from './inputs'
import { isTrue, settable, tagOf } from './rows'
import { ChangeRefusal, type ChangePlan, type Op, type PlanStep, type Row } from './types'

const refuse = (code: string, text: string, status = 409): never => { throw new ChangeRefusal(status, code, text) }
const bad = (text: string): never => refuse('bad_request', text, 400)

const clean = (v: unknown, max = 40) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

function ipv4(v: unknown): string {
  const s = str(v)
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.split('.').some(x => Number(x) > 255)) bad('That is not an IPv4 address.')
  return s
}
function macOf(v: unknown): string {
  const s = upperMac(str(v))
  if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(s)) bad('That is not a MAC address (like AA:BB:CC:00:11:22).')
  return s
}

const step = (words: string, forward: Op, inverse: Op[]): PlanStep => ({ words, forward, inverse })
const plan = (kind: string, title: string, steps: PlanStep[], extra: Partial<ChangePlan> = {}): ChangePlan =>
  ({ kind, title, steps, warnings: [], needsTick: null, checkWan: false, ...extra })

// ── fixed addresses ──────────────────────────────────────────────────────────

/** The networks a DHCP server hands out addresses from: the router's own networks on its link, else its network entries. */
function serverNetworks(i: RouterInputs, server: Row): string[] {
  const iface = String(server.interface ?? '')
  const onLink = i.addresses.filter(a => !isTrue(a.disabled) && (String(a.interface) === iface || String(a['actual-interface']) === iface)).map(a => networkOf(String(a.address ?? ''))).filter((x): x is string => !!x)
  if (onLink.length) return [...new Set(onLink)]
  return i.dhcpNetworks.map(n => networkOf(String(n.address ?? ''))).filter((x): x is string => !!x)
}

function pickServer(i: RouterInputs, p: { server?: unknown; mac: string; address?: string; existing?: Row | null }): Row {
  const named = str(p.server) || String(p.existing?.server ?? '')
  const servers = i.dhcpServers.filter(s => !isTrue(s.disabled))
  if (named) { const s = servers.find(x => x.name === named); if (s) return s }
  const arp = i.arp.find(a => upperMac(a['mac-address']) === p.mac)
  const byLink = arp && servers.find(s => s.interface === arp.interface)
  if (byLink) return byLink
  if (p.address) { const byNet = servers.filter(s => serverNetworks(i, s).some(n => inSubnet(p.address!, n))); if (byNet.length === 1) return byNet[0] }
  if (servers.length === 1) return servers[0]
  return refuse('no_server', 'HyperProx cannot tell which of the router\'s DHCP servers should hold this address. Pick the device from the list so it can be worked out.')
}

function checkAddress(i: RouterInputs, server: Row, address: string, mac: string, selfId: string | null): void {
  const nets = serverNetworks(i, server)
  if (!nets.length) refuse('no_network', 'HyperProx cannot read which network this DHCP server hands out, so it cannot check the address.')
  const net = nets.find(n => inSubnet(address, n))
  if (!net) refuse('outside_network', `${address} is outside the network this DHCP server hands out (${nets.join(', ')}). Pick an address from that network.`)
  const [base, pre] = net!.split('/'); const size = 2 ** (32 - Number(pre))
  const first = base.split('.').reduce((a, x) => a * 256 + Number(x), 0)
  const n = address.split('.').reduce((a, x) => a * 256 + Number(x), 0)
  if (size > 2 && (n === first || n === first + size - 1)) refuse('outside_network', `${address} is the network's own or broadcast address and cannot be given to a device.`)
  if (i.addresses.some(a => String(a.address ?? '').split('/')[0] === address)) refuse('duplicate_address', `${address} is the router's own address.`)
  const devs = devicesOf(i)
  for (const l of i.leases) {
    if (String(l['.id']) === selfId || String(l.address ?? '') !== address) continue
    if (isTrue(l.disabled)) continue
    const other = upperMac(l['mac-address'])
    if (other === mac && !isStatic(l)) continue
    if (isStatic(l) || l.status === 'bound') refuse('duplicate_address', `${address} is already ${isStatic(l) ? 'fixed for' : 'in use by'} ${nameOfAddress(devs, address) || String(l['host-name'] || l.comment || other)} (${other}). Pick another address.`)
  }
}

export interface LeaseParams { action: 'make-static' | 'add' | 'edit' | 'remove'; mac?: unknown; address?: unknown; comment?: unknown; server?: unknown; id?: unknown }

export function planLease(i: RouterInputs, p: LeaseParams): ChangePlan {
  const devs = devicesOf(i)
  if (p.action === 'remove' || p.action === 'edit') {
    const row = i.leases.find(l => String(l['.id']) === str(p.id))
    if (!row) return refuse('not_found', 'The router no longer has that fixed address. Reload the page.')
    if (!isStatic(row)) return refuse('not_fixed', 'That is not a fixed address, so there is nothing of yours to change.')
    const mac = upperMac(row['mac-address']), addr = String(row.address)
    const who = clean(row.comment || row['host-name'] || devs.find(d => d.mac === mac)?.name || mac)
    const key = { address: addr, 'mac-address': mac, dynamic: 'false' }
    if (p.action === 'remove') {
      return plan('lease.remove', `Stop fixing ${addr} for ${who}`, [
        step(`Remove the fixed address ${addr} for ${who}. The device will get whatever address is free next time it asks.`, { kind: 'remove', path: '/ip/dhcp-server/lease', where: key }, [{ kind: 'add', path: '/ip/dhcp-server/lease', props: settable(row) }]),
      ])
    }
    const address = p.address === undefined || str(p.address) === addr ? addr : ipv4(p.address)
    const comment = p.comment === undefined ? String(row.comment ?? '') : clean(p.comment, 60)
    if (address === addr && comment === String(row.comment ?? '')) return refuse('nothing_to_do', 'Nothing was changed.')
    const server = pickServer(i, { mac, address, existing: row })
    if (address !== addr) checkAddress(i, server, address, mac, String(row['.id']))
    const props: Record<string, string> = {}
    const back: Record<string, string> = {}
    if (address !== addr) { props.address = address; back.address = addr }
    if (comment !== String(row.comment ?? '')) { props.comment = comment; back.comment = String(row.comment ?? '') }
    const words = [address !== addr ? `Change ${who}'s fixed address from ${addr} to ${address}` : '', comment !== String(row.comment ?? '') ? `Set its note to "${comment}"` : ''].filter(Boolean).join('. ')
    return plan('lease.edit', `Edit the fixed address for ${who}`, [
      step(`${words}.`, { kind: 'set', path: '/ip/dhcp-server/lease', where: key, props }, [{ kind: 'set', path: '/ip/dhcp-server/lease', where: { ...key, address }, props: back }]),
    ])
  }

  // make-static and add
  const mac = macOf(p.mac)
  const dev = devs.find(d => d.mac === mac)
  const dyn = i.leases.find(l => upperMac(l['mac-address']) === mac && !isStatic(l) && !isTrue(l.disabled))
  const already = i.leases.find(l => upperMac(l['mac-address']) === mac && isStatic(l) && !isTrue(l.disabled))
  if (already) return refuse('already_fixed', `That device already has a fixed address (${already.address}). Edit it instead.`)
  const address = p.address !== undefined && str(p.address) !== '' ? ipv4(p.address) : ipv4(dyn?.address ?? dyn?.['active-address'] ?? dev?.address)
  const server = pickServer(i, { server: p.server, mac, address, existing: dyn })
  checkAddress(i, server, address, mac, null)
  const who = clean(p.comment || dev?.name || dyn?.['host-name'] || mac)
  const comment = p.comment === undefined ? '' : clean(p.comment, 60)
  const key = { address, 'mac-address': mac, dynamic: 'false' }
  const sameAsDynamic = dyn && String(dyn.address ?? dyn['active-address']) === address && p.action === 'make-static'
  const steps: PlanStep[] = []
  if (sameAsDynamic) {
    steps.push(step(`Make ${address} permanent for ${who}: the router will always give this device that address.`,
      { kind: 'command', path: '/ip/dhcp-server/lease/make-static', where: { address, 'mac-address': mac, dynamic: 'true' } },
      [{ kind: 'remove', path: '/ip/dhcp-server/lease', where: key }]))
    if (comment) steps.push(step(`Note on it: "${comment}".`, { kind: 'set', path: '/ip/dhcp-server/lease', where: key, props: { comment } }, []))
  } else {
    const props: Record<string, string> = { address, 'mac-address': mac, server: String(server.name) }
    if (comment) props.comment = comment
    steps.push(step(`Give ${who} the fixed address ${address}: the router will always hand this device that address.`,
      { kind: 'add', path: '/ip/dhcp-server/lease', props }, [{ kind: 'remove', path: '/ip/dhcp-server/lease', where: key }]))
  }
  return plan(p.action === 'add' ? 'lease.add' : 'lease.make-static', `Make ${address} permanent for ${who}`, steps)
}

// ── port forwards ────────────────────────────────────────────────────────────

const PROTOS = ['tcp', 'udp']

function natKey(r: Row): Record<string, string> {
  const k: Record<string, string> = { chain: 'dstnat', action: 'dst-nat' }
  for (const f of ['protocol', 'dst-port', 'to-addresses', 'to-ports', 'in-interface', 'in-interface-list', 'dst-address', 'comment']) if (r[f] !== undefined && r[f] !== '') k[f] = String(r[f])
  return k
}

function findForward(i: RouterInputs, id: unknown): Row {
  const row = i.nat.find(r => String(r['.id']) === str(id) && isForward(r))
  if (!row) return refuse('not_found', 'The router no longer has that port forward. Reload the page.')
  const key = natKey(row)
  if (i.nat.filter(r => Object.entries(key).every(([k, v]) => String(r[k] ?? '') === v)).length > 1) refuse('ambiguous', 'Two identical forwards exist on the router, so HyperProx cannot tell which one you mean. Remove one on the router first.')
  return row
}

function wanChoice(i: RouterInputs, wan: unknown): Record<string, string> {
  if (i.listMembers.some(m => String(m.list).toUpperCase() === 'WAN' && !isTrue(m.disabled))) return { 'in-interface-list': 'WAN' }
  const w = str(wan)
  if (w && i.wan.includes(w)) return { 'in-interface': w }
  if (i.wan.length === 1) return { 'in-interface': i.wan[0] }
  return refuse('wan_needed', i.wan.length ? `The router has several internet links (${i.wan.join(', ')}) and no interface list named WAN. Say which one the forward is on.` : 'HyperProx cannot tell which of the router\'s links faces the internet, so it cannot make a forward.')
}

function overlap(a: { from: number; to: number }, b: { from: number; to: number }) { return a.from <= b.to && b.from <= a.to }

export interface ForwardParams {
  action: 'add' | 'edit' | 'toggle' | 'remove'
  id?: unknown; address?: unknown; proto?: unknown; extPort?: unknown; toPort?: unknown; name?: unknown; wan?: unknown; disabled?: unknown
}

function conflict(i: RouterInputs, scope: Record<string, string>, proto: string, ext: { from: number; to: number }, selfId: string | null): void {
  const devs = devicesOf(i)
  for (const r of i.nat) {
    if (!isForward(r) || isTrue(r.disabled) || String(r['.id']) === selfId) continue
    const rp = parsePorts(String(r['dst-port'] ?? '')); if (!rp || !overlap(rp, ext)) continue
    if (r.protocol && r.protocol !== proto) continue
    const theirs = scopeOf(r), mine = scope['in-interface'] || scope['in-interface-list'] || ''
    if (theirs && mine && theirs !== mine && !(theirs.toUpperCase() === 'WAN' || mine.toUpperCase() === 'WAN')) continue
    const to = String(r['to-addresses'] ?? '')
    refuse('port_conflict', `Outside port ${r['dst-port']} (${String(r.protocol || 'tcp').toUpperCase()}) already goes to ${nameOfAddress(devs, to) ? `${nameOfAddress(devs, to)} (${to})` : to}. Change or remove that forward first.`)
  }
}

export function planForward(i: RouterInputs, p: ForwardParams): ChangePlan {
  const devs = devicesOf(i)
  if (p.action === 'remove' || p.action === 'toggle') {
    const row = findForward(i, p.id)
    const key = natKey(row)
    const where = `outside port ${row['dst-port']}`
    if (p.action === 'remove') {
      return plan('forward.remove', `Remove the port forward for ${where}`, [
        step(`Remove the forward from ${where} to ${row['to-addresses']} port ${row['to-ports'] || row['dst-port']}. Nothing from the internet reaches that device on this port any more.`, { kind: 'remove', path: '/ip/firewall/nat', where: key }, [{ kind: 'add', path: '/ip/firewall/nat', props: settable(row) }]),
      ], { checkWan: true })
    }
    const off = p.disabled === true || p.disabled === 'true'
    if (off === isTrue(row.disabled)) return refuse('nothing_to_do', `That forward is already switched ${off ? 'off' : 'on'}.`)
    const risk = !off ? riskyIn(row['dst-port'], row['to-ports']) : []
    return plan('forward.toggle', `${off ? 'Switch off' : 'Switch on'} the port forward for ${where}`, [
      step(`${off ? 'Switch off' : 'Switch on'} the forward from ${where} to ${row['to-addresses']} port ${row['to-ports'] || row['dst-port']}.`, { kind: 'set', path: '/ip/firewall/nat', where: key, props: { disabled: off ? 'true' : 'false' } }, [{ kind: 'set', path: '/ip/firewall/nat', where: key, props: { disabled: off ? 'false' : 'true' } }]),
    ], { checkWan: true, needsTick: risk.length ? riskText(risk) : null })
  }

  const existing = p.action === 'edit' ? findForward(i, p.id) : null
  const address = ipv4(p.address ?? existing?.['to-addresses'])
  const proto = str(p.proto ?? existing?.protocol ?? 'tcp').toLowerCase()
  if (!PROTOS.includes(proto)) bad('Pick TCP or UDP.')
  const ext = parsePorts(p.extPort ?? existing?.['dst-port'])
  if (!ext) bad('The outside port must be a number from 1 to 65535, or a range like 8000-8010.')
  const toText = p.toPort === undefined || str(p.toPort) === '' ? (ext!.from === ext!.to ? String(ext!.from) : '') : String(p.toPort).trim()
  const to = toText ? parsePorts(toText) : null
  if (toText && (!to || to.from !== to.to)) bad('The port on the device must be one number.')
  const lanNets = ownSubnets(i.addresses, i.wan)
  if (!lanNets.some(n => inSubnet(address, n))) refuse('not_on_lan', `${address} is not on one of your networks (${lanNets.join(', ') || 'none found'}). Pick a device from the list.`)
  if (i.addresses.some(a => String(a.address ?? '').split('/')[0] === address)) refuse('is_router', `${address} is the router itself. A forward to it would expose the router's own services.`)
  const scope = existing ? (existing['in-interface-list'] ? { 'in-interface-list': String(existing['in-interface-list']) } : existing['in-interface'] ? { 'in-interface': String(existing['in-interface']) } : wanChoice(i, p.wan)) : wanChoice(i, p.wan)
  const extText = ext!.from === ext!.to ? String(ext!.from) : `${ext!.from}-${ext!.to}`
  conflict(i, scope, proto, ext!, existing ? String(existing['.id']) : null)
  const devName = nameOfAddress(devs, address)
  const label = clean(p.name) || devName || address
  const tag = tagOf('fwd', proto, extText, address, toText, scope)
  const comment = existing && p.name === undefined ? String(existing.comment ?? '') : `${HYPERPROX_FORWARD} ${label} [hpx-${tag}]`
  const props: Record<string, string> = { chain: 'dstnat', action: 'dst-nat', protocol: proto, 'dst-port': extText, 'to-addresses': address, ...(toText ? { 'to-ports': toText } : {}), ...scope, comment }
  const risk = riskyIn(extText, toText)
  const needsTick = risk.length ? riskText(risk) : null
  const words = `Outside port ${extText} → ${devName ? `${devName} (${address})` : address} port ${toText || extText}, ${proto.toUpperCase()}`
  const warnings = needsTick ? [needsTick] : []
  if (!hasHairpinFor(i)) warnings.push('No "hairpin" rule exists on the router: devices on your own network that open this forward through the router\'s public address will not get through (they can use the device\'s own address). HyperProx does not add one.')
  if (!existing) {
    return plan('forward.add', `Forward outside port ${extText} to ${label}`, [
      step(`Add the forward: ${words}.`, { kind: 'add', path: '/ip/firewall/nat', props }, [{ kind: 'remove', path: '/ip/firewall/nat', where: { chain: 'dstnat', comment } }]),
    ], { warnings, needsTick, checkWan: true })
  }
  const old = natKey(existing)
  const changed: Record<string, string> = {}
  const back: Record<string, string> = {}
  for (const k of ['protocol', 'dst-port', 'to-addresses', 'to-ports', 'comment']) {
    const nv = props[k] ?? '', ov = String(existing[k] ?? '')
    if (nv !== ov) { changed[k] = nv; back[k] = ov }
  }
  if (!Object.keys(changed).length) return refuse('nothing_to_do', 'Nothing was changed.')
  const after = { ...old, ...changed }
  return plan('forward.edit', `Change the port forward for outside port ${String(existing['dst-port'])}`, [
    step(`Change the forward to: ${words}.`, { kind: 'set', path: '/ip/firewall/nat', where: old, props: changed }, [{ kind: 'set', path: '/ip/firewall/nat', where: after, props: back }]),
  ], { warnings, needsTick, checkWan: true })
}

const hasHairpinFor = hasHairpin

// ── device blocks ────────────────────────────────────────────────────────────

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
export interface Schedule { from: string; to: string; days?: string[] }

export function timeValue(s: unknown): string {
  const o = (s ?? {}) as Schedule
  const t = (x: unknown) => { const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(str(x)); if (!m) return bad('Times look like 22:00.'); return `${m[1].padStart(2, '0')}:${m[2]}:00` }
  const days = Array.isArray(o.days) && o.days.length ? o.days.map(d => str(d).toLowerCase()) : DAYS
  if (days.some(d => !DAYS.includes(d))) bad('Days are mon, tue, wed, thu, fri, sat, sun.')
  const from = t(o.from), to = t(o.to)
  if (from === to) bad('The start and end time are the same.')
  return `${from}-${to},${DAYS.filter(d => days.includes(d)).join(',')}`
}

export interface BlockParams { action: 'block' | 'unblock' | 'schedule'; mac?: unknown; address?: unknown; name?: unknown; schedule?: unknown; id?: unknown }

function blockOut(i: RouterInputs): Record<string, string> {
  if (i.listMembers.some(m => String(m.list).toUpperCase() === 'WAN' && !isTrue(m.disabled))) return { 'out-interface-list': 'WAN' }
  if (i.wan.length === 1) return { 'out-interface': i.wan[0] }
  return refuse('wan_needed', 'HyperProx cannot tell which router link faces the internet (several, and no interface list named WAN), so it cannot block only the internet.')
}

export function planBlock(i: RouterInputs, p: BlockParams): ChangePlan {
  const devs = devicesOf(i)
  if (p.action === 'unblock' || p.action === 'schedule') {
    const row = i.filter.find(r => String(r['.id']) === str(p.id) && isBlock(r))
    if (!row) return refuse('not_found', 'The router no longer has that block. Reload the page.')
    const comment = String(row.comment)
    const target = String(row['src-mac-address'] || row['src-address'])
    const label = clean(comment.replace(BLOCK_PREFIX, '').replace(/\s*\[hpx-[0-9a-f]{6}\]$/, '')) || target
    if (p.action === 'unblock') {
      return plan('block.unblock', `Give ${label} its internet back`, [
        step(`Remove the block on ${label} (${target}). It can reach the internet again.`, { kind: 'remove', path: '/ip/firewall/filter', where: { chain: 'forward', comment } }, [{ kind: 'add', path: '/ip/firewall/filter', props: settable(row), top: true }]),
      ], { checkWan: true })
    }
    const time = p.schedule === null || p.schedule === undefined ? '' : timeValue(p.schedule)
    if (time === String(row.time ?? '')) return refuse('nothing_to_do', 'The schedule is already like that.')
    return plan('block.schedule', `Change when ${label} is blocked`, [
      step(time ? `Block ${label} only ${time.replace(/^(\d\d:\d\d):00-(\d\d:\d\d):00,(.*)$/, 'from $1 to $2 on $3')}.` : `Block ${label} all the time.`,
        { kind: 'set', path: '/ip/firewall/filter', where: { chain: 'forward', comment }, props: { time } }, [{ kind: 'set', path: '/ip/firewall/filter', where: { chain: 'forward', comment }, props: { time: String(row.time ?? '') } }]),
    ], { checkWan: true })
  }

  let mac = str(p.mac) ? macOf(p.mac) : ''
  let address = str(p.address) ? ipv4(p.address) : ''
  if (!mac && !address) bad('Pick the device to block.')
  const dev = devs.find(d => (mac && d.mac === mac) || (!mac && d.address === address))
  if (!mac && dev) mac = dev.mac
  if (!address && dev) address = dev.address
  if (address && i.addresses.some(a => String(a.address ?? '').split('/')[0] === address)) refuse('is_router', 'That address is the router itself. HyperProx will not block it.')
  const own = ownSubnets(i.addresses, i.wan)
  if (address && own.length && !own.some(n => inSubnet(address, n))) refuse('not_on_lan', `${address} is not on one of your networks, so HyperProx cannot block it here.`)
  const target = mac || address
  for (const r of i.filter) if (isBlock(r) && ((mac && upperMac(r['src-mac-address']) === mac) || (!mac && r['src-address'] === address))) refuse('already_blocked', `${clean(dev?.name) || target} is already blocked. Remove that block first, or change its schedule.`)
  const label = clean(p.name) || dev?.name || target
  const time = p.schedule ? timeValue(p.schedule) : ''
  const comment = `${BLOCK_PREFIX} ${label} [hpx-${tagOf('block', target, time)}]`
  const props: Record<string, string> = { chain: 'forward', action: 'drop', ...(mac ? { 'src-mac-address': mac } : { 'src-address': address }), ...blockOut(i), ...(time ? { time } : {}), comment }
  const when = time ? ` ${time.replace(/^(\d\d:\d\d):00-(\d\d:\d\d):00,(.*)$/, 'from $1 to $2 on $3')}` : ''
  return plan('block.add', `Block internet for ${label}`, [
    step(`Add a firewall rule that drops internet traffic from ${label} (${target})${when}. Its own network and the router stay reachable.`, { kind: 'add', path: '/ip/firewall/filter', props, top: true }, [{ kind: 'remove', path: '/ip/firewall/filter', where: { chain: 'forward', comment } }]),
  ], { checkWan: true })
}
