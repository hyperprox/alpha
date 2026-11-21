// =============================================================================
//  HyperProx — MikroTik: ports, neighbours, stray addresses and the LAN guard
//
//  Everything here that READS is pure: it takes what the router answered and returns what the page shows, so it is
//  tested with made-up answers. The only writes are apply/undo of the "LAN guard": one address list and one forward
//  rule, both marked with HyperProx's own comment, and nothing else on the router is ever read back as ours.
//
//  Why a guard: a device whose address is outside every network the router owns (a laptop with a hard-coded address,
//  a rogue DHCP server) still reaches the router through the bridge, and the router will happily forward it. The
//  rule drops forwarded LAN traffic whose source is not in the list of the router's own networks.
// =============================================================================

export const GUARD_LIST = 'hyperprox-lan'
export const GUARD_RULE_COMMENT = 'HyperProx: drop LAN traffic from addresses that are not yours'
export const GUARD_ENTRY_COMMENT = 'HyperProx: one of your networks'

type Row = Record<string, any>

// ── addresses ────────────────────────────────────────────────────────────────

function toInt(ip: string): number | null {
  const p = String(ip).split('.')
  if (p.length !== 4 || p.some(x => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null
  return ((Number(p[0]) << 24) >>> 0) + (Number(p[1]) << 16) + (Number(p[2]) << 8) + Number(p[3])
}
const toIp = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')

/** "a.b.c.d/p" as its network ("a.b.c.0/24"), or null. */
export function networkOf(cidr: string): string | null {
  const [ip, pre] = String(cidr).split('/')
  const base = toInt(ip), p = Number(pre)
  if (base === null || !Number.isInteger(p) || p < 0 || p > 32 || pre === undefined || pre === '') return null
  const mask = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0
  return `${toIp((base & mask) >>> 0)}/${p}`
}

export function inSubnet(ip: string, cidr: string): boolean {
  const n = toInt(ip), net = networkOf(cidr)
  if (n === null || net === null) return false
  const [b, pre] = net.split('/')
  const p = Number(pre)
  const mask = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0
  return ((n & mask) >>> 0) === toInt(b)
}

export const isLinkLocal = (ip: string) => String(ip).startsWith('169.254.')

/** True when two networks share any address (one contains the other's first address). */
export function overlaps(a: string, b: string): boolean {
  const [ai] = a.split('/'), [bi] = b.split('/')
  return inSubnet(ai, b) || inSubnet(bi, a)
}

/**
 * The networks this router itself is on: every enabled address that is not on an internet-facing interface, as a
 * network. Link-local and loopback are not networks anyone owns.
 */
export function ownSubnets(addresses: Row[], wan: string[]): string[] {
  const out = new Set<string>()
  for (const a of addresses) {
    if (a.disabled === 'true' || a.invalid === 'true') continue
    const iface = String(a['actual-interface'] || a.interface || '')
    if (wan.includes(iface)) continue
    const ip = String(a.address ?? '').split('/')[0]
    if (isLinkLocal(ip) || ip.startsWith('127.')) continue
    const net = networkOf(String(a.address ?? ''))
    if (net) out.add(net)
  }
  return [...out].sort()
}

export interface RoutedSubnet { subnet: string; via: string }

/** The interface a route leaves by: "192.0.2.5%bridge-lan" or "192.0.2.5 reachable via  bridge-lan". */
function routeInterface(r: Row): string | null {
  const imm = String(r['immediate-gw'] ?? '')
  if (imm.includes('%')) return imm.split('%')[1].trim() || null
  const m = /\bvia\s+(\S+)/.exec(String(r['gateway-status'] ?? ''))
  return m ? m[1] : null
}

/**
 * Networks the router reaches through a next hop on the LAN: a second router, a Docker or Kubernetes host, an SDN or
 * VPN/Tailscale subnet router. Every active, enabled, non-default route in the main table whose gateway is on a
 * non-internet interface, and whose destination is not already a connected network. Without these the guard would
 * drop their traffic.
 */
export function routedSubnets(routes: Row[], addresses: Row[], wan: string[]): RoutedSubnet[] {
  const connected = ownSubnets(addresses, wan)
  const out = new Map<string, string>()
  for (const r of routes) {
    if (r.disabled === 'true' || r.active !== 'true' || r.invalid === 'true' || r.connect === 'true') continue
    if (r['routing-table'] && r['routing-table'] !== 'main') continue
    if (r.blackhole === 'true' || r.unreachable === 'true' || r.prohibit === 'true') continue
    const dst = String(r['dst-address'] ?? '')
    const net = networkOf(dst)
    if (!net || net.endsWith('/0')) continue
    const ip = net.split('/')[0]
    if (isLinkLocal(ip) || ip.startsWith('127.')) continue
    const iface = routeInterface(r)
    if (!iface || wan.includes(iface)) continue
    if (connected.includes(net)) continue
    const gw = String(r['immediate-gw'] ?? r.gateway ?? '').split('%')[0].split(' ')[0]
    if (!out.has(net)) out.set(net, gw || iface)
  }
  return [...out.entries()].map(([subnet, via]) => ({ subnet, via })).sort((a, b) => a.subnet.localeCompare(b.subnet))
}

/** An address outside every one of the router's networks. Unknown networks flag nothing. */
export function isStrayAddress(ip: string, own: string[]): boolean {
  if (!own.length || toInt(ip) === null || isLinkLocal(ip)) return false
  return !own.some(n => inSubnet(ip, n))
}

/** The MAC's "locally administered" bit is set: made by software, not burned in by a manufacturer. */
export function isSoftwareMac(mac: string): boolean {
  const first = parseInt(String(mac).split(/[:-]/)[0] ?? '', 16)
  return Number.isFinite(first) && (first & 2) === 2
}

const macKey = (m: unknown) => String(m ?? '').toUpperCase()

// ── ports and neighbours ─────────────────────────────────────────────────────

/** What the router knows of where a MAC sits: bridge host table, and Wi-Fi registrations. */
export function portIndex(hosts: Row[], wifi: Row[]): Map<string, { port: string; signal: string | null; wireless: boolean; age: string | null }> {
  const out = new Map<string, { port: string; signal: string | null; wireless: boolean; age: string | null }>()
  for (const h of hosts) {
    const k = macKey(h['mac-address'])
    if (!k || out.has(k)) continue
    const vid = String(h.vid ?? '')
    const base = h.local === 'true' ? 'this router' : String(h['on-interface'] ?? '').trim()
    if (!base) continue
    out.set(k, { port: vid && vid !== '1' ? `${base} (VLAN ${vid})` : base, signal: null, wireless: false, age: h.age ? String(h.age) : null })
  }
  for (const w of wifi) {
    const k = macKey(w['mac-address'])
    const iface = String(w.interface ?? '').trim()
    if (!k || !iface) continue
    // wifi package: "signal"; older wireless package: "signal-strength" like "-62@5GHz".
    const raw = String(w.signal ?? w['signal-strength'] ?? '')
    const dbm = /^-?\d+/.exec(raw)?.[0] ?? null
    const prev = out.get(k)
    out.set(k, { port: iface, signal: dbm ? `${dbm} dBm` : null, wireless: true, age: prev?.age ?? null })
  }
  return out
}

/** What a neighbour (MNDP, LLDP, CDP) says it is, by MAC. */
export function neighbourIndex(rows: Row[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const n of rows) {
    const k = macKey(n['mac-address'])
    if (!k || out.has(k)) continue
    const what = [n.identity, [n.platform, n.board].filter(Boolean).join(' '), n.version].filter(x => x && String(x).trim()).join(' · ')
    if (what) out.set(k, what.slice(0, 160))
  }
  return out
}

/** "ether3", or "wifi1 · -62 dBm" for a wireless client. */
export function portText(p: { port: string; signal: string | null; wireless: boolean } | undefined): string {
  if (!p) return '—'
  return p.wireless ? `${p.port} (Wi-Fi${p.signal ? `, ${p.signal}` : ''})` : p.port
}

// ── the guard ────────────────────────────────────────────────────────────────

export interface GuardPlan {
  interface: string; list: string
  /** Networks the router is directly on. */
  subnets: string[]
  /** Networks reached through a next hop on the LAN. Also allowed, and listed apart so the person sees them. */
  routed: RoutedSubnet[]
  comment: string
}

export interface GuardView {
  state: 'off' | 'on' | 'partial'
  /** What would be added, or null when it cannot be worked out (and why in `unavailable`). */
  plan: GuardPlan | null
  /** Networks in the plan that the list does not hold yet. */
  missing: string[]
  /** The rule is on the router but is disabled, not first in the forward chain, or on another link. */
  ruleProblem?: string
  /** true / false when the router says whether this login may write; null when it does not say. */
  canWrite: boolean | null
  unavailable?: string
  /** The ids of exactly the two kinds of thing that are ours. */
  ruleIds: string[]
  entryIds: string[]
}

const ours = {
  rule: (f: Row) => f.chain === 'forward' && f.comment === GUARD_RULE_COMMENT,
  entry: (e: Row) => e.list === GUARD_LIST && e.comment === GUARD_ENTRY_COMMENT,
}

/** Whether the router's own user table lets this login write. null when it cannot tell. */
export function canWriteFrom(users: Row[], groups: Row[], username: string | undefined): boolean | null {
  if (!username) return null
  const u = users.find(x => x.name === username)
  const g = u && groups.find(x => x.name === u.group)
  if (!g) return null
  return String(g.policy ?? '').split(',').map(s => s.trim()).includes('write')
}

export function guardView(i: {
  addresses: Row[]; wan: string[]; lan: string | null
  addressList: Row[]; filter: Row[]; users: Row[]; groups: Row[]; username?: string; routes?: Row[]
}): GuardView {
  const subnets = ownSubnets(i.addresses, i.wan)
  const routed = routedSubnets(i.routes ?? [], i.addresses, i.wan)
  const entries = i.addressList.filter(e => e.list === GUARD_LIST && e.disabled !== 'true')
  const ruleRows = i.filter.filter(ours.rule)
  const ruleIds = ruleRows.map(r => String(r['.id'])).filter(Boolean)
  const entryIds = i.addressList.filter(ours.entry).map(e => String(e['.id'])).filter(Boolean)
  const held = new Set(entries.map(e => networkOf(String(e.address ?? '')) ?? String(e.address)))
  const base = { ruleIds, entryIds, canWrite: canWriteFrom(i.users, i.groups, i.username) }
  const iface = i.lan || (ruleRows[0]?.['in-interface'] ? String(ruleRows[0]['in-interface']) : null)
  if (!iface || !subnets.length) {
    return { ...base, state: ruleIds.length || entryIds.length ? 'partial' : 'off', plan: null, missing: [],
      unavailable: !iface ? 'HyperProx could not tell which of the router\'s links is your network.' : 'The router has no network of its own that HyperProx can read.' }
  }
  const plan: GuardPlan = { interface: iface, list: GUARD_LIST, subnets, routed, comment: GUARD_RULE_COMMENT }
  const missing = [...subnets, ...routed.map(r => r.subnet)].filter(n => !held.has(n))
  // "On" means the rule is there, enabled, on this link and first in the forward chain: a rule further down is
  // shadowed by an earlier accept and protects nothing.
  const firstForward = i.filter.find(f => f.chain === 'forward' && f.dynamic !== 'true' && f.disabled !== 'true')
  let ruleProblem: string | undefined
  // Every rule of ours is checked, not only the first: a second, broken copy is a problem too.
  for (const r of ruleRows) {
    if (r.disabled === 'true') ruleProblem = 'The guard\'s rule is on the router but switched off.'
    else if (String(r['in-interface'] ?? '') !== iface) ruleProblem = `The guard's rule is on the router but watches ${r['in-interface'] || 'no link'}, not ${iface}.`
    else if (firstForward !== r) ruleProblem = 'The guard\'s rule is on the router but is not the first rule of the forward chain, so earlier rules let traffic past it.'
    if (ruleProblem) break
  }
  const state = ruleIds.length && !missing.length && !ruleProblem ? 'on' : (ruleIds.length || entryIds.length ? 'partial' : 'off')
  return { ...base, state, plan, missing, ...(ruleProblem ? { ruleProblem } : {}) }
}

/** The routed networks the person saw, as one comparable string. Missing means none were shown. */
function askedRouted(v: unknown): string {
  return (Array.isArray(v) ? v : []).map(x => String((x as any)?.subnet ?? x)).sort().join(',')
}

export class GuardRefusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'GuardRefusal' }
}

export interface GuardRouter {
  get(path: string, timeoutMs?: number): Promise<any>
  put(path: string, body: unknown, timeoutMs?: number): Promise<any>
  delete(path: string, timeoutMs?: number): Promise<any>
  post?(path: string, body: Record<string, unknown>, timeoutMs?: number): Promise<any>
}

const arr = (v: any): Row[] => Array.isArray(v) ? v : []
const idOf = (r: any): string | null => {
  const x = Array.isArray(r) ? r[0] : r
  return x && typeof x['.id'] === 'string' ? x['.id'] : null
}

export const READ_ONLY_TEXT = 'The router refused the change: the login HyperProx uses for it can only read. Give that router user a group with the write policy, then try again.'

/** Everything the guard needs, read now. Each read that fails is an empty answer, never a thrown error. */
export async function readGuardInputs(r: GuardRouter) {
  const g = (p: string) => r.get(p, 15_000).then(arr, () => [] as Row[])
  const [addresses, addressList, filter, users, groups, routes] = await Promise.all([
    g('/rest/ip/address'), g('/rest/ip/firewall/address-list'), g('/rest/ip/firewall/filter'), g('/rest/user'), g('/rest/user/group'), g('/rest/ip/route'),
  ])
  return { addresses, addressList, filter, users, groups, routes }
}

function readOnly(e: any): GuardRefusal | null {
  return /HTTP 40[13]\b/.test(String(e?.message ?? '')) ? new GuardRefusal(409, 'read_only_login', READ_ONLY_TEXT) : null
}

export interface GuardDeps {
  router: GuardRouter
  wan: string[]
  lan: string | null
  username?: string
  /** Written, and awaited, before the first change. A throw stops everything. */
  audit(action: string, details: Record<string, unknown>): Promise<void>
}

/**
 * Add the guard. `asked` is the plan the person saw; it must still be the plan now, or nothing is changed.
 * Order matters: the list first, the rule last, so a failure part-way never leaves a rule that drops everything
 * because its list is empty. A failure undoes what this call added.
 */
export async function applyGuard(d: GuardDeps, asked: { interface?: unknown; subnets?: unknown; routed?: unknown }): Promise<{ changed: boolean; added: string[]; message: string }> {
  const inputs = await readGuardInputs(d.router)
  const v = guardView({ ...inputs, wan: d.wan, lan: d.lan, username: d.username })
  if (!v.plan) throw new GuardRefusal(409, 'no_plan', v.unavailable ?? 'There is nothing to add.')
  if (v.canWrite === false) throw new GuardRefusal(409, 'read_only_login', READ_ONLY_TEXT)
  const same = asked.interface === v.plan.interface && Array.isArray(asked.subnets)
    && [...asked.subnets].map(String).sort().join(',') === v.plan.subnets.join(',')
    && askedRouted(asked.routed) === v.plan.routed.map(r => r.subnet).sort().join(',')
  if (!same) throw new GuardRefusal(409, 'plan_changed', 'The router\'s networks changed since this page was loaded. Reload it and look at the new plan.')
  if (d.wan.includes(v.plan.interface)) throw new GuardRefusal(409, 'wan_interface', 'That link faces the internet; the guard is for your own network.')
  if (v.state === 'on') return { changed: false, added: [], message: 'The guard is already on. Nothing was changed.' }

  await d.audit('mikrotik.lan-guard.apply.start', { interface: v.plan.interface, networks: v.missing, rule: v.ruleIds.length && !v.ruleProblem ? 'present' : 'to add' })
  const addedEntries: string[] = []
  let addedRule: string | null = null
  try {
    for (const net of v.missing) {
      const res = await d.router.put('/rest/ip/firewall/address-list', { list: GUARD_LIST, address: net, comment: GUARD_ENTRY_COMMENT })
      const id = idOf(res)
      if (id) addedEntries.push(id)
    }
    if (v.ruleIds.length && v.ruleProblem) {
      // Our own rule, found by its comment, is wrong: remove it (the list is complete by now, and with the rule gone
      // nothing is dropped) and add a correct one below.
      for (const id of v.ruleIds) await d.router.delete(`/rest/ip/firewall/filter/${id}`)
    }
    if (!v.ruleIds.length || v.ruleProblem) {
      const res = await d.router.put('/rest/ip/firewall/filter', {
        chain: 'forward', action: 'drop', 'in-interface': v.plan.interface, 'src-address-list': `!${GUARD_LIST}`, comment: GUARD_RULE_COMMENT,
      })
      addedRule = idOf(res)
      if (!addedRule) throw new Error('The router did not say which rule it made.')
      const first = idOf(inputs.filter.find(f => f.dynamic !== 'true' && !v.ruleIds.includes(String(f['.id']))) ?? null)
      if (first) {
        if (!d.router.post) throw new Error('This connection cannot move the rule to the top of the forward chain, so it was not left at the bottom.')
        await d.router.post('/rest/ip/firewall/filter/move', { numbers: addedRule, destination: first })
      }
    }
    const after = guardView({ ...(await readGuardInputs(d.router)), wan: d.wan, lan: d.lan, username: d.username })
    if (after.state !== 'on') throw new Error('The router does not show the guard in place and first in the forward chain after the change.')
  } catch (e: any) {
    // Undo exactly what this call made, rule first.
    await removeAdded(d, new Set(v.ruleIds), addedRule, addedEntries)
    await d.audit('mikrotik.lan-guard.apply.failed', { error: String(e?.message ?? e).slice(0, 200) }).catch(() => {})
    throw readOnly(e) ?? e
  }
  await d.audit('mikrotik.lan-guard.apply.done', { interface: v.plan.interface, networks: v.missing }).catch(() => {})
  return { changed: true, added: v.missing, message: `The guard is on: traffic from addresses outside ${v.plan.subnets.join(', ')} is dropped.` }
}

/**
 * Roll back what one apply made. A rule create that failed or timed out client-side may still have happened on the
 * router, so the rule is not trusted to be "ours" by id alone: after any failure the filter table is read again and
 * every rule carrying the guard's comment that was not there before this call is removed by its id. The list entries
 * go only once a final read shows no such rule remains: a drop rule with an empty list would cut off the whole LAN,
 * so otherwise the entries stay and the error says how to remove the rule.
 */
async function removeAdded(d: GuardDeps, before: Set<string>, rule: string | null, entries: string[]): Promise<void> {
  const maybeOurs = (rows: Row[]) => rows.filter(r => (ours.rule(r) && !before.has(String(r['.id']))) || (rule !== null && String(r['.id']) === rule))
  const read = () => d.router.get('/rest/ip/firewall/filter', 15_000).then(arr)
  let clear = false
  try {
    for (const r of maybeOurs(await read())) await d.router.delete(`/rest/ip/firewall/filter/${r['.id']}`).catch(() => {})
    clear = maybeOurs(await read()).length === 0
  } catch { clear = false }
  if (!clear) {
    throw new Error(`The guard's rule is STILL on the router and HyperProx could not remove it, so its address list was left in place (without it the rule would block your whole network). Remove the rule by hand: in the router's firewall, Filter rules, delete the rule commented "${GUARD_RULE_COMMENT}", then delete the list "${GUARD_LIST}" entries commented "${GUARD_ENTRY_COMMENT}".`)
  }
  for (const id of entries) await d.router.delete(`/rest/ip/firewall/address-list/${id}`).catch(() => {})
}

/** Remove exactly the guard's rule and its address-list entries, matched by HyperProx's own comment. */
export async function undoGuard(d: GuardDeps): Promise<{ changed: boolean; message: string }> {
  const inputs = await readGuardInputs(d.router)
  const v = guardView({ ...inputs, wan: d.wan, lan: d.lan, username: d.username })
  if (v.canWrite === false) throw new GuardRefusal(409, 'read_only_login', READ_ONLY_TEXT)
  if (!v.ruleIds.length && !v.entryIds.length) return { changed: false, message: 'There was nothing of HyperProx\'s to remove.' }
  await d.audit('mikrotik.lan-guard.undo.start', { rules: v.ruleIds.length, entries: v.entryIds.length })
  try {
    // The rule first: with the list gone first, the rule would drop everything for a moment.
    for (const id of v.ruleIds) await d.router.delete(`/rest/ip/firewall/filter/${id}`)
    for (const id of v.entryIds) await d.router.delete(`/rest/ip/firewall/address-list/${id}`)
    const after = await readGuardInputs(d.router)
    if (after.filter.some(ours.rule) || after.addressList.some(ours.entry)) throw new Error('The router still shows part of the guard.')
  } catch (e: any) {
    await d.audit('mikrotik.lan-guard.undo.failed', { error: String(e?.message ?? e).slice(0, 200) }).catch(() => {})
    throw readOnly(e) ?? e
  }
  await d.audit('mikrotik.lan-guard.undo.done', { rules: v.ruleIds.length, entries: v.entryIds.length }).catch(() => {})
  return { changed: true, message: 'The guard is removed. The router is as it was.' }
}
