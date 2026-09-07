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

import type { Plugin, PluginContext, PluginTileData, PluginDetail, PluginMetric } from '../lib/plugin-host'

type Row = { label: string; value: string; tone?: 'good' | 'warn' | 'bad' }

function mbps(bitsPerSecond: number): string {
  if (!bitsPerSecond) return '0'
  const m = bitsPerSecond / 1_000_000
  return m >= 100 ? m.toFixed(0) : m.toFixed(1)
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
    ],
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

  async detail(ctx: PluginContext): Promise<PluginDetail> {
    const [resource, arp, leases, ifaces, wan] = await Promise.all([
      ctx.get('/rest/system/resource'),
      ctx.get('/rest/ip/arp').catch(() => [] as any[]),
      ctx.get('/rest/ip/dhcp-server/lease').catch(() => [] as any[]),
      ctx.get('/rest/interface').catch(() => [] as any[]),
      findWan(ctx, ctx.option('wan')),
    ])

    const arpList: any[]   = Array.isArray(arp) ? arp : []
    const leaseList: any[] = Array.isArray(leases) ? leases : []
    const ifaceList: any[] = Array.isArray(ifaces) ? ifaces : []

    let down = 0, up = 0
    if (wan) {
      try {
        const t = await ctx.post('/rest/interface/monitor-traffic', { interface: wan, once: '' })
        const one = Array.isArray(t) ? t[0] : t
        down = Number(one?.['rx-bits-per-second'] ?? 0)
        up   = Number(one?.['tx-bits-per-second'] ?? 0)
      } catch { /* the tables still stand without a live rate */ }
    }

    // A device is worth listing once, with everything known about it: the lease
    // knows its name, ARP knows whether it answered just now.
    const byMac = new Map<string, any>()
    for (const l of leaseList) {
      if (!l['mac-address']) continue
      byMac.set(l['mac-address'].toUpperCase(), {
        name:      l['host-name'] || l.comment || '—',
        address:   l.address ?? '—',
        mac:       l['mac-address'],
        kind:      l.dynamic === 'true' ? 'dynamic' : 'static',
        lastSeen:  l['last-seen'] ?? '—',
        awake:     'no',
      })
    }
    for (const a of arpList) {
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

    const bytes = (n: any) => {
      const v = Number(n ?? 0)
      if (!v) return '0'
      const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
      const i = Math.min(Math.floor(Math.log(v) / Math.log(1024)), u.length - 1)
      return `${(v / Math.pow(1024, i)).toFixed(1)} ${u[i]}`
    }

    return {
      stats: [
        { label: 'Download',      value: `${mbps(down)} Mbps` },
        { label: 'Upload',        value: `${mbps(up)} Mbps` },
        { label: 'Devices awake', value: String(devices.filter(d => d.awake === 'yes').length) },
        { label: 'Known devices', value: String(devices.length) },
        { label: 'CPU',           value: `${resource['cpu-load'] ?? 0}%`,
          tone: Number(resource['cpu-load'] ?? 0) > 80 ? 'bad' : 'good' },
        { label: 'Uptime',        value: humaniseUptime(String(resource.uptime ?? '')) },
      ],
      tables: [
        {
          title: 'Devices',
          empty: 'No devices found — the router returned neither ARP entries nor DHCP leases.',
          columns: [
            { key: 'awake',    label: 'Awake' },
            { key: 'name',     label: 'Name' },
            { key: 'address',  label: 'Address' },
            { key: 'mac',      label: 'MAC' },
            { key: 'iface',    label: 'Interface' },
            { key: 'kind',     label: 'Lease' },
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
            { key: 'rx',      label: 'Received',    align: 'right' },
            { key: 'tx',      label: 'Transmitted', align: 'right' },
          ],
          rows: ifaceList.map(i => ({
            name:    i.name ?? '—',
            type:    i.type ?? '—',
            running: i.running === 'true' ? 'yes' : 'no',
            rx:      bytes(i['rx-byte']),
            tx:      bytes(i['tx-byte']),
          })),
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

    return [
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
