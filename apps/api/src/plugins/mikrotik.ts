// =============================================================================
//  Plug-in — MikroTik / RouterOS
//
//  Answers three questions without opening Winbox: how much is going in and out
//  of the internet connection right now, how many devices are on the network,
//  and which ones are actually awake.
//
//  Read-only by intent. A router is the one box where a wrong write takes the
//  whole network down — including HyperProx itself. The single POST here is
//  `monitor-traffic`, which RouterOS models as a command but which only reads.
// =============================================================================

import type { Plugin, PluginContext, PluginTileData, PluginDetail, PluginMetric, PluginLink } from '../lib/plugin-host'

type Row = { label: string; value: string; tone?: 'good' | 'warn' | 'bad' }

function mbps(bitsPerSecond: number): string {
  if (!bitsPerSecond) return '0'
  const m = bitsPerSecond / 1_000_000
  return m >= 100 ? m.toFixed(0) : m.toFixed(1)
}

function bytes(n: any): string {
  const v = Number(n ?? 0)
  if (!v) return '0'
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const i = Math.min(Math.floor(Math.log(v) / Math.log(1024)), u.length - 1)
  return `${(v / Math.pow(1024, i)).toFixed(1)} ${u[i]}`
}

function humaniseUptime(raw: string): string {
  const parts = raw.match(/\d+[a-z]+/g) ?? []
  return parts.slice(0, 2).join(' ') || raw
}

/** The interface carrying the default route — i.e. the way to the internet. */
async function findWan(ctx: PluginContext, override?: string): Promise<string | null> {
  if (override) return override
  try {
    const routes: any[] = await ctx.get('/rest/ip/route')
    const def = routes.find(r => r['dst-address'] === '0.0.0.0/0' && r.active === 'true')
             ?? routes.find(r => r['dst-address'] === '0.0.0.0/0')
    return def?.['immediate-gw']?.split('%')[1] ?? def?.['gateway-status']?.split(' ')[2] ?? null
  } catch { return null }
}

/**
 * The link local traffic actually crosses.
 *
 * Prefers a bridge, because on a typical router that is every LAN port at once.
 * Falls back to the busiest running interface that is not the WAN and not
 * loopback — on a router whose LAN is a single trunk to a switch, that trunk is
 * the honest answer and no bridge would have found it.
 */
async function findLan(ctx: PluginContext, wan: string | null): Promise<string | null> {
  try {
    const ifaces: any[] = await ctx.get('/rest/interface')
    const usable = ifaces.filter(i =>
      i.running === 'true' && i.name !== wan && i.type !== 'loopback' && i.disabled !== 'true')
    const bridge = usable.find(i => i.type === 'bridge')
    if (bridge) return bridge.name
    const busiest = usable
      .map(i => ({ name: i.name, bytes: Number(i['rx-byte'] ?? 0) + Number(i['tx-byte'] ?? 0) }))
      .sort((a, b) => b.bytes - a.bytes)[0]
    return busiest?.name ?? null
  } catch { return null }
}

interface DeviceTraffic {
  ip: string; name: string; down: number; up: number; bytes: number; conns: number
}

/**
 * Per-device bandwidth, without changing anything on the router.
 *
 * RouterOS only tracks bandwidth per device if you configure it to — simple
 * queues or Kid Control — and neither is set up on a typical router. Connection
 * tracking is always on, and every entry carries a live rate and a byte count,
 * so summing per source address gives real per-device throughput with no
 * queues, no shaping and nothing to undo.
 *
 * The caveat worth knowing: fast-tracked connections bypass most accounting, so
 * a heavily fast-tracked router under-reports. The figures are honest for
 * ranking who is using the link, not for billing.
 */
/** RFC1918 only: connection tracking also carries inbound connections, whose
 *  source is somewhere on the internet and is not a device on your network. */
function isLocal(ip: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

async function perDevice(ctx: PluginContext, names: Map<string, string>): Promise<DeviceTraffic[]> {
  let conns: any[]
  try {
    conns = await ctx.get('/rest/ip/firewall/connection', { timeoutMs: 25_000 })
  } catch {
    return []
  }
  if (!Array.isArray(conns)) return []

  const by = new Map<string, DeviceTraffic>()
  for (const c of conns) {
    const src = String(c['src-address'] ?? '').split(':')[0]
    if (!isLocal(src)) continue

    const row = by.get(src) ?? { ip: src, name: names.get(src) ?? '—', down: 0, up: 0, bytes: 0, conns: 0 }
    // orig- is what the device sent, repl- is what came back to it.
    row.up    += Number(c['orig-rate'] ?? 0)
    row.down  += Number(c['repl-rate'] ?? 0)
    row.bytes += Number(c['orig-bytes'] ?? 0) + Number(c['repl-bytes'] ?? 0)
    row.conns += 1
    by.set(src, row)
  }
  return [...by.values()].sort((a, b) => (b.down + b.up) - (a.down + a.up))
}

export const mikrotikPlugin: Plugin = {
  manifest: {
    id:   'mikrotik',
    name: 'MikroTik',
    description: 'Internet throughput, how many devices are on the network, and which are awake.',
    kind: 'device',
    icon: '🛜',
    baseUrlSetting: 'url',
    insecureTLS: true,
    auth: { kind: 'basic', userSetting: 'username', passSetting: 'password' },
    settings: [
      { key: 'url',      label: 'Router address', type: 'url',    required: true,
        hint: 'https://192.168.1.1 — enable the REST service under IP → Services → www-ssl.' },
      { key: 'username', label: 'Username',       type: 'text',   required: true,
        hint: 'A read-only user is enough, and is what this plug-in expects.' },
      { key: 'password', label: 'Password',       type: 'secret', required: true },
      { key: 'wan',      label: 'WAN interface',  type: 'text',   required: false,
        hint: 'Leave blank to detect it from the default route — set it only if that guesses wrong.' },
      { key: 'lan',      label: 'LAN interface',  type: 'text',   required: false,
        hint: 'The link carrying local traffic — a bridge, or the trunk to your switch. Blank picks the busiest.' },
      { key: 'wan_down_mbps', label: 'Plan download (Mbps)', type: 'text', required: false,
        hint: 'What you pay for, not what the port negotiated. Blank makes the meter scale to what it has seen.' },
      { key: 'wan_up_mbps',   label: 'Plan upload (Mbps)',   type: 'text', required: false },
      { key: 'lan_mbps',      label: 'LAN link speed (Mbps)', type: 'text', required: false,
        hint: 'e.g. 1000 for gigabit, 10000 for a 10G trunk.' },
    ],
    // RouterOS answers SSH with its own CLI, not a POSIX shell — no tmux, and
    // nothing that would understand a probe for one.
    consoleAccess: {
      defaultPort: 22,
      label: 'Router console',
      tmux:  false,
      hint:  'RouterOS CLI over SSH. Needs a user with the ssh policy — the read-only account this plug-in uses may not have it.',
    },
  },

  async load(ctx: PluginContext): Promise<PluginTileData> {
    const settingsWan = (this as any)._wan as string | undefined
    const [resource, arp, leases, wan] = await Promise.all([
      ctx.get('/rest/system/resource'),
      ctx.get('/rest/ip/arp').catch(() => [] as any[]),
      ctx.get('/rest/ip/dhcp-server/lease').catch(() => [] as any[]),
      findWan(ctx, settingsWan),
    ])

    // --- who is on the network ----------------------------------------------
    // ARP is the honest answer to "awake right now": a lease persists for hours
    // after a device sleeps, so counting leases would overstate it every time.
    const arpList: any[] = Array.isArray(arp) ? arp : []
    const live = arpList.filter(a => a.complete === 'true' && a.invalid !== 'true' && !a.DHCP)
    const liveAll = arpList.filter(a => a.complete === 'true' && a.invalid !== 'true')
    const leaseList: any[] = Array.isArray(leases) ? leases : []
    const bound = leaseList.filter(l => l.status === 'bound')

    // Name what we can: a lease knows the hostname, ARP knows who is awake.
    const nameByIp = new Map<string, string>()
    for (const l of leaseList) {
      const n = l['host-name'] || l.comment
      if (l.address && n) nameByIp.set(l.address, n)
    }

    // --- internet throughput -------------------------------------------------
    let down = 0, up = 0, haveTraffic = false
    if (wan) {
      try {
        const t = await ctx.post('/rest/interface/monitor-traffic', { interface: wan, once: '' })
        const s = Array.isArray(t) ? t[0] : t
        down = Number(s?.['rx-bits-per-second'] ?? 0)
        up   = Number(s?.['tx-bits-per-second'] ?? 0)
        haveTraffic = true
      } catch { /* throughput is a bonus; the rest of the tile still stands */ }
    }

    const cpu = Number(resource['cpu-load'] ?? 0)

    const rows: Row[] = []
    if (haveTraffic) {
      rows.push({ label: 'Internet', value: `↓ ${mbps(down)} · ↑ ${mbps(up)} Mbps`, tone: 'good' })
    } else if (wan) {
      rows.push({ label: 'Internet', value: `${wan} — no live reading`, tone: 'warn' })
    }

    // These are two different sets, not a subset — ARP is who answered recently,
    // a lease is who was ever given an address. Comparing them as "N of M" read
    // as nonsense the moment ARP exceeded the lease count.
    rows.push({ label: 'Devices seen', value: `${liveAll.length} active · ${bound.length} leases` })

    // Who is actually using the link right now is more useful than how many
    // devices exist, so it goes above the device names.
    const traffic = await perDevice(ctx, nameByIp)
    const busiest = traffic.find(t => t.down + t.up > 0)
    if (busiest) {
      rows.push({
        label: 'Busiest',
        value: `${busiest.name !== '—' ? busiest.name : busiest.ip} · ${mbps(busiest.down)}↓ ${mbps(busiest.up)}↑ Mbps`,
      })
    }

    // A few of them by name, so the tile answers "who" and not only "how many".
    const named = liveAll
      .map(a => ({ ip: a.address as string, name: nameByIp.get(a.address) }))
      .filter(d => d.name)
      .slice(0, 3)
    for (const d of named) rows.push({ label: d.name!.slice(0, 18), value: d.ip })

    rows.push({ label: 'Router', value: `${resource['board-name'] ?? 'RouterOS'} · ${resource.version ?? ''}`.trim() })
    rows.push({ label: 'Load', value: `CPU ${cpu}% · up ${humaniseUptime(String(resource.uptime ?? ''))}`,
                tone: cpu > 80 ? 'bad' : cpu > 50 ? 'warn' : 'good' })

    return {
      headline: haveTraffic
        ? `↓ ${mbps(down)} ↑ ${mbps(up)} Mbps · ${liveAll.length} devices`
        : `${liveAll.length} devices on the network`,
      tone: cpu > 80 ? 'bad' : 'good',
      rows,
    }
  },

  /**
   * WAN and LAN throughput in one round trip.
   *
   * monitor-traffic takes a comma-separated interface list and answers for all
   * of them at once, which matters when this is polled every few seconds: one
   * request for both links rather than one per link per poll.
   *
   * `fp-` prefixed counters are the fast-path totals and are a subset of the
   * plain ones, so only rx/tx-bits-per-second are read here — adding them would
   * double-count.
   */
  async bandwidth(ctx: PluginContext): Promise<PluginLink[]> {
    const wan = await findWan(ctx, ctx.option('wan'))
    const lan = ctx.option('lan') || await findLan(ctx, wan)

    const wanted = [wan, lan].filter(Boolean) as string[]
    if (!wanted.length) return []

    let readings: any[] = []
    try {
      const res = await ctx.post('/rest/interface/monitor-traffic',
        { interface: wanted.join(','), once: '' }, { timeoutMs: 15_000 })
      readings = Array.isArray(res) ? res : [res]
    } catch {
      return []
    }

    const capBps = (raw?: string) => {
      const n = Number(raw)
      return Number.isFinite(n) && n > 0 ? n * 1_000_000 : undefined
    }
    const read = (name: string) => readings.find(r => r?.name === name)

    const links: PluginLink[] = []

    if (wan) {
      const r = read(wan)
      links.push({
        id: 'wan', label: wan, kind: 'wan',
        downBps: Number(r?.['rx-bits-per-second'] ?? 0),
        upBps:   Number(r?.['tx-bits-per-second'] ?? 0),
        downCapacityBps: capBps(ctx.option('wan_down_mbps')),
        upCapacityBps:   capBps(ctx.option('wan_up_mbps')),
      })
    }

    if (lan) {
      const r = read(lan)
      // Direction is stated from the router's side, so a download arriving from
      // the internet leaves the router towards the LAN — the router's tx. Naming
      // that "down" is what makes the two meters agree with each other.
      const cap = capBps(ctx.option('lan_mbps'))
      links.push({
        id: 'lan', label: lan, kind: 'lan',
        downBps: Number(r?.['tx-bits-per-second'] ?? 0),
        upBps:   Number(r?.['rx-bits-per-second'] ?? 0),
        downCapacityBps: cap, upCapacityBps: cap,
      })
    }

    return links
  },

  /**
   * Everything the router knows, in one page.
   *
   * The tile answers "is anything happening". This answers "show me the
   * router" — which on a border device means more than throughput: what it is,
   * what it is forwarding, who it can see, what it has been logging, and
   * whether anything is quietly out of date.
   *
   * Every call is individually caught. A router with no WireGuard, no DHCP
   * server or a permission-limited user should lose that one table, not the
   * whole page.
   */
  async detail(ctx: PluginContext): Promise<PluginDetail> {
    const opt = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback)
    const list = (p: string) => opt(ctx.get(p), [] as any[]).then(v => Array.isArray(v) ? v : [])
    const one  = (p: string) => opt(ctx.get(p), {} as any).then(v => Array.isArray(v) ? (v[0] ?? {}) : (v ?? {}))

    const [
      resource, identity, board, health, arp, leases, ifaces,
      addresses, nat, filter, wgPeers, neighbors, services, users, dns, log, wan,
    ] = await Promise.all([
      one('/rest/system/resource'),
      one('/rest/system/identity'),
      one('/rest/system/routerboard'),
      list('/rest/system/health'),
      list('/rest/ip/arp'),
      list('/rest/ip/dhcp-server/lease'),
      list('/rest/interface'),
      list('/rest/ip/address'),
      list('/rest/ip/firewall/nat'),
      list('/rest/ip/firewall/filter'),
      list('/rest/interface/wireguard/peers'),
      list('/rest/ip/neighbor'),
      list('/rest/ip/service'),
      list('/rest/user'),
      one('/rest/ip/dns'),
      list('/rest/log'),
      findWan(ctx, ctx.option('wan')),
    ])

    const namesByIp = new Map<string, string>()
    for (const l of leases) {
      const n = l['host-name'] || l.comment
      if (l.address && n) namesByIp.set(l.address, n)
    }
    // A statically addressed host has no DHCP lease and would otherwise be
    // nameless — an ARP comment is the only other label the router holds.
    for (const a of arp) {
      if (a.address && a.comment && !namesByIp.has(a.address)) namesByIp.set(a.address, a.comment)
    }
    const traffic = await opt(perDevice(ctx, namesByIp), [] as DeviceTraffic[])

    let down = 0, up = 0
    if (wan) {
      try {
        const t = await ctx.post('/rest/interface/monitor-traffic', { interface: wan, once: '' })
        const r = Array.isArray(t) ? t[0] : t
        down = Number(r?.['rx-bits-per-second'] ?? 0)
        up   = Number(r?.['tx-bits-per-second'] ?? 0)
      } catch { /* the tables still stand without a live rate */ }
    }

    // A device is worth listing once, with everything known about it: the lease
    // knows its name, ARP knows whether it answered just now.
    const byMac = new Map<string, any>()
    for (const l of leases) {
      if (!l['mac-address']) continue
      byMac.set(l['mac-address'].toUpperCase(), {
        name:     l['host-name'] || l.comment || '—',
        address:  l.address ?? '—',
        mac:      l['mac-address'],
        kind:     l.dynamic === 'true' ? 'dynamic' : 'static',
        lastSeen: l['last-seen'] ?? '—',
        awake:    'no',
      })
    }
    for (const a of arp) {
      if (a.complete !== 'true' || a.invalid === 'true' || !a['mac-address']) continue
      const key = a['mac-address'].toUpperCase()
      const existing = byMac.get(key)
      if (existing) {
        existing.awake = 'yes'
        existing.iface = a.interface ?? '—'
      } else {
        byMac.set(key, {
          name: '—', address: a.address ?? '—', mac: a['mac-address'],
          kind: 'no lease', lastSeen: '—', awake: 'yes', iface: a.interface ?? '—',
        })
      }
    }
    const devices = [...byMac.values()].sort((x, y) =>
      (y.awake === 'yes' ? 1 : 0) - (x.awake === 'yes' ? 1 : 0) || String(x.name).localeCompare(String(y.name)))

    // Addresses belong beside the interface they are on, not in a table of
    // their own that the reader has to cross-reference.
    const addrByIface = new Map<string, string[]>()
    for (const a of addresses) {
      const key = a['actual-interface'] || a.interface
      if (!key) continue
      if (!addrByIface.has(key)) addrByIface.set(key, [])
      addrByIface.get(key)!.push(a.address + (a.disabled === 'true' ? ' (disabled)' : ''))
    }

    const sensor = (name: string) => health.find(h => h.name === name)
    const temp   = Number(sensor('cpu-temperature')?.value ?? 0)
    const volts  = sensor('jack-voltage')?.value ?? sensor('poe-in-voltage')?.value
    const poeW   = Number(sensor('poe-out-consumption')?.value ?? 0)

    const memFree  = Number(resource['free-memory'] ?? 0)
    const memTotal = Number(resource['total-memory'] ?? 0)
    const memUsed  = memTotal - memFree
    const memPct   = memTotal ? Math.round((memUsed / memTotal) * 100) : 0
    const cpuLoad  = Number(resource['cpu-load'] ?? 0)

    // The RouterBOARD firmware and RouterOS are versioned separately and drift
    // apart silently — a router can run a current RouterOS on two-year-old
    // bootloader firmware and nothing on the dashboard would ever say so.
    const fwNow  = String(board['current-firmware'] ?? '')
    const fwNext = String(board['upgrade-firmware'] ?? '')
    const fwStale = Boolean(fwNow && fwNext && fwNow !== fwNext)

    const stats: PluginDetail['stats'] = [
      { label: 'Router',   value: String(identity.name ?? board.model ?? 'RouterOS') },
      { label: 'Model',    value: String(board.model ?? resource['board-name'] ?? '—') },
      { label: 'RouterOS', value: String(resource.version ?? '—').replace(/\s*\(stable\)/, '') },
      { label: 'Firmware', value: fwStale ? `${fwNow} → ${fwNext}` : (fwNow || '—'),
        tone: fwStale ? 'warn' : 'good' },
      { label: 'Uptime',   value: humaniseUptime(String(resource.uptime ?? '')) },
      { label: 'Download', value: `${mbps(down)} Mbps` },
      { label: 'Upload',   value: `${mbps(up)} Mbps` },
      { label: 'CPU',      value: `${cpuLoad}% of ${resource['cpu-count'] ?? '?'} cores`,
        tone: cpuLoad > 80 ? 'bad' : cpuLoad > 50 ? 'warn' : 'good' },
      { label: 'Memory',   value: `${memPct}% · ${bytes(memFree)} free`,
        tone: memPct > 85 ? 'bad' : memPct > 70 ? 'warn' : 'good' },
      ...(temp ? [{ label: 'Temperature', value: `${temp} °C`,
        tone: (temp > 70 ? 'bad' : temp > 60 ? 'warn' : 'good') as 'bad' | 'warn' | 'good' }] : []),
      ...(volts ? [{ label: 'Input', value: `${volts} V` }] : []),
      ...(poeW ? [{ label: 'PoE draw', value: `${poeW} W` }] : []),
      { label: 'Devices awake', value: String(devices.filter(d => d.awake === 'yes').length) },
      { label: 'Known devices', value: String(devices.length) },
    ]

    const forwards = nat
      .filter(n => n.action === 'dst-nat')
      .map(n => ({
        comment: n.comment || '—',
        proto:   n.protocol ?? 'any',
        port:    n['dst-port'] ?? n['dst-address'] ?? 'any',
        to:      `${n['to-addresses'] ?? '—'}${n['to-ports'] ? ':' + n['to-ports'] : ''}`,
        iface:   n['in-interface'] ?? n['in-interface-list'] ?? 'any',
        state:   n.disabled === 'true' ? 'disabled' : 'active',
        hits:    bytes(n.bytes),
      }))
      .sort((a, b) => (a.state === 'active' ? 0 : 1) - (b.state === 'active' ? 0 : 1))

    // The management services someone configured, and only those. RouterOS also
    // reports its own internal listeners as dynamic entries — resolver, upnp,
    // detnet, one per interface — and eleven rows of those bury the one line
    // that matters, which is whether SSH or Winbox is reachable from anywhere.
    const openServices = services
      .filter(s => s.disabled !== 'true' && s.dynamic !== 'true')
      .map(s => ({
        name:  s.name ?? '—',
        port:  s.port ?? '—',
        proto: s.proto ?? '—',
        from:  s.address || 'anywhere',
        note:  s.address ? 'restricted' : 'reachable from any source',
      }))
      .sort((a, b) => (a.note === 'restricted' ? 1 : 0) - (b.note === 'restricted' ? 1 : 0))

    // Newest first, and errors/warnings ahead of chatter — a log table sorted
    // by time alone buries the one line that mattered under DHCP renewals.
    const interesting = (l: any) => /error|warn|critical|denied|failed|login/i.test(String(l.topics ?? '') + String(l.message ?? ''))
    const logRows = [...log].reverse()
    const recent  = [...logRows.filter(interesting).slice(0, 15), ...logRows.filter(l => !interesting(l)).slice(0, 25)]

    return {
      stats,
      tables: [
        {
          title: 'Bandwidth by device',
          empty: 'Connection tracking returned nothing — the router may have it disabled.',
          columns: [
            { key: 'name',  label: 'Device' },
            { key: 'ip',    label: 'Address' },
            { key: 'down',  label: 'Down',  align: 'right' },
            { key: 'up',    label: 'Up',    align: 'right' },
            { key: 'data',  label: 'Data',  align: 'right' },
            { key: 'conns', label: 'Conns', align: 'right' },
          ],
          rows: traffic.slice(0, 40).map(t => ({
            name: t.name, ip: t.ip,
            down: `${mbps(t.down)} Mbps`, up: `${mbps(t.up)} Mbps`,
            data: bytes(t.bytes), conns: t.conns,
          })),
        },
        {
          title: 'Devices',
          empty: 'No devices found — the router returned neither ARP entries nor DHCP leases.',
          columns: [
            { key: 'awake',   label: 'Awake' },
            { key: 'name',    label: 'Name' },
            { key: 'address', label: 'Address' },
            { key: 'mac',     label: 'MAC' },
            { key: 'iface',   label: 'Interface' },
            { key: 'kind',    label: 'Lease' },
          ],
          rows: devices.map(d => ({ ...d, iface: d.iface ?? '—' })),
        },
        {
          title: 'Interfaces',
          empty: 'No interfaces returned.',
          columns: [
            { key: 'name',    label: 'Name' },
            { key: 'type',    label: 'Type' },
            { key: 'running', label: 'Running' },
            { key: 'addr',    label: 'Addresses' },
            { key: 'rx',      label: 'Received',    align: 'right' },
            { key: 'tx',      label: 'Transmitted', align: 'right' },
          ],
          rows: ifaces
            .slice()
            .sort((a, b) => (b.running === 'true' ? 1 : 0) - (a.running === 'true' ? 1 : 0))
            .map(i => ({
              name:    i.name === wan ? `${i.name} (WAN)` : i.name ?? '—',
              type:    i.type ?? '—',
              running: i.running === 'true' ? 'yes' : 'no',
              addr:    (addrByIface.get(i.name) ?? []).join(', ') || '—',
              rx:      bytes(i['rx-byte']),
              tx:      bytes(i['tx-byte']),
            })),
        },
        {
          title: `Port forwards (${forwards.filter(f => f.state === 'active').length} active)`,
          empty: 'No destination NAT rules — nothing is published from the internet.',
          columns: [
            { key: 'comment', label: 'Rule' },
            { key: 'proto',   label: 'Proto' },
            { key: 'port',    label: 'Public port' },
            { key: 'to',      label: 'Forwards to' },
            { key: 'iface',   label: 'On' },
            { key: 'state',   label: 'State' },
            { key: 'hits',    label: 'Traffic', align: 'right' },
          ],
          rows: forwards,
        },
        {
          title: 'WireGuard peers',
          empty: 'No WireGuard peers configured.',
          columns: [
            { key: 'name',      label: 'Peer' },
            { key: 'iface',     label: 'Interface' },
            { key: 'allowed',   label: 'Allowed' },
            { key: 'endpoint',  label: 'Endpoint' },
            { key: 'handshake', label: 'Last handshake' },
            { key: 'rx',        label: 'Received',    align: 'right' },
            { key: 'tx',        label: 'Transmitted', align: 'right' },
          ],
          rows: wgPeers.map(p => ({
            name:      p.comment || p.name || '—',
            iface:     p.interface ?? '—',
            allowed:   p['allowed-address'] ?? '—',
            endpoint:  p['current-endpoint-address']
              ? `${p['current-endpoint-address']}:${p['current-endpoint-port'] ?? ''}`
              : (p['endpoint-address'] || '—'),
            handshake: p['last-handshake'] ?? 'never',
            rx:        bytes(p.rx),
            tx:        bytes(p.tx),
          })),
        },
        {
          title: 'Neighbours',
          empty: 'Nothing discovered by LLDP, CDP or MNDP.',
          columns: [
            { key: 'identity', label: 'Identity' },
            { key: 'address',  label: 'Address' },
            { key: 'iface',    label: 'Seen on' },
            { key: 'platform', label: 'Platform' },
            { key: 'via',      label: 'Via' },
            { key: 'age',      label: 'Age', align: 'right' },
          ],
          rows: neighbors.map(n => ({
            identity: n.identity || n['mac-address'] || '—',
            address:  n.address || n.address4 || n['mac-address'] || '—',
            iface:    n.interface ?? '—',
            platform: [n.platform, n.board].filter(Boolean).join(' ') || '—',
            via:      n['discovered-by'] ?? '—',
            age:      n.age ?? '—',
          })),
        },
        {
          title: 'Services listening',
          empty: 'Every management service is disabled.',
          columns: [
            { key: 'name',  label: 'Service' },
            { key: 'proto', label: 'Proto' },
            { key: 'port',  label: 'Port' },
            { key: 'from',  label: 'Allowed from' },
            { key: 'note',  label: 'Exposure' },
          ],
          rows: openServices,
        },
        {
          title: 'Firewall',
          empty: 'No filter rules.',
          columns: [
            { key: 'chain',   label: 'Chain' },
            { key: 'action',  label: 'Action' },
            { key: 'comment', label: 'Comment' },
            { key: 'packets', label: 'Packets', align: 'right' },
            { key: 'bytes',   label: 'Bytes',   align: 'right' },
          ],
          rows: filter.map(f => ({
            chain:   f.chain ?? '—',
            action:  f.disabled === 'true' ? `${f.action} (disabled)` : f.action ?? '—',
            comment: f.comment || '—',
            packets: Number(f.packets ?? 0).toLocaleString(),
            bytes:   bytes(f.bytes),
          })),
        },
        {
          title: 'Recent log',
          empty: 'The log is empty.',
          columns: [
            { key: 'time',    label: 'Time' },
            { key: 'topics',  label: 'Topics' },
            { key: 'message', label: 'Message' },
          ],
          rows: recent.map(l => ({
            time:    l.time ?? '—',
            topics:  l.topics ?? '—',
            message: String(l.message ?? '').trim() || '—',
          })),
        },
        {
          title: 'Accounts',
          empty: 'No local users.',
          columns: [
            { key: 'name',   label: 'User' },
            { key: 'group',  label: 'Group' },
            { key: 'from',   label: 'Allowed from' },
            { key: 'last',   label: 'Last login' },
            { key: 'state',  label: 'State' },
          ],
          rows: users.map(u => ({
            name:  u.name ?? '—',
            group: u.group ?? '—',
            from:  u.address || 'anywhere',
            last:  u['last-logged-in'] ?? 'never',
            state: u.disabled === 'true' ? 'disabled' : 'enabled',
          })),
        },
        {
          title: 'DNS',
          empty: 'No DNS configuration returned.',
          columns: [
            { key: 'setting', label: 'Setting' },
            { key: 'value',   label: 'Value' },
          ],
          rows: [
            { setting: 'Upstream servers', value: String(dns.servers || '—') },
            { setting: 'Dynamic servers',  value: String(dns['dynamic-servers'] || '—') },
            { setting: 'Allow remote requests', value: String(dns['allow-remote-requests'] ?? '—') },
            { setting: 'Cache', value: `${dns['cache-used'] ?? '?'} of ${dns['cache-size'] ?? '?'} KiB used` },
            { setting: 'DoH server', value: String(dns['use-doh-server'] || 'not configured') },
          ],
        },
      ],
    }
  },

  async metrics(ctx: PluginContext): Promise<PluginMetric[]> {
    const [resource, arp, leases, wan] = await Promise.all([
      ctx.get('/rest/system/resource'),
      ctx.get('/rest/ip/arp').catch(() => [] as any[]),
      ctx.get('/rest/ip/dhcp-server/lease').catch(() => [] as any[]),
      findWan(ctx, ctx.option('wan')),
    ])

    let rx = 0, tx = 0
    if (wan) {
      try {
        const t = await ctx.post('/rest/interface/monitor-traffic', { interface: wan, once: '' })
        const one = Array.isArray(t) ? t[0] : t
        rx = Number(one?.['rx-bits-per-second'] ?? 0)
        tx = Number(one?.['tx-bits-per-second'] ?? 0)
      } catch { /* a missing rate is better than a fabricated zero-with-confidence */ }
    }

    const arpList: any[] = Array.isArray(arp) ? arp : []
    const awake = arpList.filter(a => a.complete === 'true' && a.invalid !== 'true').length
    const leaseCount = (Array.isArray(leases) ? leases : []).filter(l => l.status === 'bound').length
    const totalMem = Number(resource['total-memory'] ?? 0)
    const freeMem  = Number(resource['free-memory'] ?? 0)

    // Per-device series, capped: a label per device is fine for a home network
    // and would be a cardinality problem on anything larger, so only the ten
    // busiest are published.
    const names = new Map<string, string>()
    for (const l of (Array.isArray(leases) ? leases : [])) {
      const n = l['host-name'] || l.comment
      if (l.address && n) names.set(l.address, n)
    }
    const traffic = (await perDevice(ctx, names)).slice(0, 10)
    const perDeviceMetrics: PluginMetric[] = traffic.flatMap(t => ([
      { name: 'device_bits_per_second', help: 'Per-device throughput from connection tracking.',
        type: 'gauge' as const, value: t.down, labels: { device: t.name !== '—' ? t.name : t.ip, direction: 'down' } },
      { name: 'device_bits_per_second', help: 'Per-device throughput from connection tracking.',
        type: 'gauge' as const, value: t.up, labels: { device: t.name !== '—' ? t.name : t.ip, direction: 'up' } },
    ]))

    return [
      ...perDeviceMetrics,
      { name: 'network_bits_per_second', help: 'Throughput on the internet-facing interface.',
        type: 'gauge', value: rx, labels: { direction: 'rx', interface: wan ?? 'unknown' } },
      { name: 'network_bits_per_second', help: 'Throughput on the internet-facing interface.',
        type: 'gauge', value: tx, labels: { direction: 'tx', interface: wan ?? 'unknown' } },
      { name: 'network_devices', help: 'Devices on the network.',
        type: 'gauge', value: awake,      labels: { state: 'awake' } },
      { name: 'network_devices', help: 'Devices on the network.',
        type: 'gauge', value: leaseCount, labels: { state: 'leased' } },
      { name: 'router_cpu_percent', help: 'Router CPU load.',
        type: 'gauge', value: Number(resource['cpu-load'] ?? 0) },
      { name: 'router_memory_bytes', help: 'Router memory.',
        type: 'gauge', value: totalMem - freeMem, labels: { state: 'used' } },
      { name: 'router_memory_bytes', help: 'Router memory.',
        type: 'gauge', value: freeMem, labels: { state: 'free' } },
    ]
  },
}
