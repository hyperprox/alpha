// Demo fixtures: the QNAP plug-in. A 4-bay "nas-01" at home and a 1-bay "family-nas" beside the remote server.
import type { FixtureRoute } from './types'
import { REMOTE, TiB, iso, MIN, DAY, wobble } from './data'

const ok = (data: unknown) => ({ success: true, data })
const TB = 1e12

const nas = (id: string, name: string, remote: boolean, url: string) => ({
  id, name, clusterId: remote ? REMOTE.id : null, node: remote ? REMOTE.node.node : null, reach: remote ? 'cluster' : 'direct',
  insecureTLS: false, fingerprint: null, alerts: true, diskTempWarnC: 50, url, username: 'hyperprox', hasPassword: true,
  cluster: remote ? { id: REMOTE.id, name: REMOTE.name, kind: 'remote' } : null, remote, via: remote ? 'cluster' : 'direct', held: null,
  phrases: { restart: `restart ${name}`, shutdown: `shut down ${name}` },
})
export const QNAP_INSTANCES = () => [nas('nas-01', 'nas-01', false, 'https://10.0.0.5:443'), nas('family-nas', 'family-nas', true, 'http://10.0.50.5:8080')]

const disk = (bay: number, model: string, sizeTb: number, tempC: number, serial: string) => ({
  bay, model, capacity: `${sizeTb} TB`, sizeBytes: sizeTb * TB, tempC, smart: 'good' as const, smartText: 'Good',
  lastTest: { status: 'Completed', type: 'Rapid', time: iso((bay + 2) * DAY).slice(0, 10) }, serial, firmware: 'SC60',
})

function reading(id: string) {
  const home = id === 'nas-01'
  const disks = home
    ? [1, 2, 3, 4].map(b => disk(b, 'Seagate IronWolf ST8000VN004', 8, 34 + b, `ZA1DEMO${b}0`))
    : [disk(1, 'WD Red Plus WD60EFPX', 6, 37, 'WXDEMO0001')]
  const total = home ? 21.8 * TiB : 5.4 * TiB
  const used = home ? total * 0.61 : total * 0.35
  return {
    fetchedAt: iso(2 * MIN), generation: 'storage-v2' as const, model: home ? 'TS-464' : 'TS-133', hostname: id, serial: home ? 'Q23DEMO0001' : 'Q23DEMO0002',
    firmware: { version: '5.2.7', build: '20251024', number: '3297' },
    update: { available: false, version: null, checkedAt: iso(6 * 3_600_000) },
    uptimeSec: home ? 37 * 86400 : 64 * 86400, health: 'good' as const, cpuPct: Math.round(wobble(home ? 9 : 4, 3, id)),
    memTotalMB: home ? 8192 : 2048, memFreeMB: home ? 4710 : 1120, sysTempC: home ? 41 : 39, cpuTempC: home ? 47 : 44,
    thresholds: { sysWarnC: 65, sysErrC: 75, diskWarnC: 50, diskErrC: 60, ssdWarnC: 70 },
    fans: home ? [{ index: 1, rpm: 812, ok: true }] : [{ index: 1, rpm: 640, ok: true }],
    disks,
    pools: [{ id: 'pool1', name: 'Storage Pool 1', health: 'good' as const, status: 'Ready', totalBytes: Math.round(total), usedBytes: Math.round(used) }],
    volumes: [{ id: 'vol1', name: home ? 'DataVol1' : 'Vol1', health: 'good' as const, status: 'Ready', degraded: false,
      totalBytes: Math.round(total), usedBytes: Math.round(used), freeBytes: Math.round(total - used), disks: disks.map(d => d.bay), pool: 'pool1' }],
    shares: home
      ? [['media', 9.1], ['backups', 2.6], ['iso', 0.4], ['photos', 1.2], ['documents', 0.08]].map(([n, t]) => ({ name: n as string, volume: 'DataVol1', usedBytes: Math.round((t as number) * TiB) }))
      : [['movies', 1.6], ['photos', 0.3]].map(([n, t]) => ({ name: n as string, volume: 'Vol1', usedBytes: Math.round((t as number) * TiB) })),
    interfaces: home
      ? [{ name: 'Adapter 1', up: true, speedMbps: 2500, ip: '10.0.0.5', mask: '255.255.0.0', mac: '24:5E:BE:00:00:01', mode: 'static', rxBps: Math.round(wobble(42e6, 12e6, 'q1')), txBps: Math.round(wobble(18e6, 6e6, 'q2')) },
         { name: 'Adapter 2', up: false, speedMbps: null, ip: null, mask: null, mac: '24:5E:BE:00:00:02', mode: null, rxBps: null, txBps: null }]
      : [{ name: 'Adapter 1', up: true, speedMbps: 1000, ip: '10.0.50.5', mask: '255.255.255.0', mac: '24:5E:BE:00:00:11', mode: 'dhcp', rxBps: 1_200_000, txBps: 300_000 }],
    missing: [],
  }
}

function detail(id: string) {
  const r = reading(id)
  return {
    ok: true,
    tables: [
      { title: 'Disks', empty: 'No disks reported.', columns: [['bay', 'Bay'], ['model', 'Model'], ['size', 'Size'], ['temp', 'Temp'], ['smart', 'SMART']].map(([key, label]) => ({ key, label })),
        rows: r.disks.map(d => ({ bay: d.bay, model: d.model, size: d.capacity, temp: `${d.tempC} °C`, smart: 'Good' })) },
      { title: 'Shares', empty: 'No shares.', columns: [{ key: 'name', label: 'Share' }, { key: 'used', label: 'Used' }],
        rows: r.shares.map(s => ({ name: s.name, used: `${((s.usedBytes ?? 0) / TiB).toFixed(2)} TiB` })) },
    ],
  }
}

export const QNAP_PLUGIN = {
  id: 'qnap', name: 'QNAP', icon: '🗄️', kind: 'device', coreTransport: true, baseUrlSetting: 'url', auth: { kind: 'none' }, settings: [],
  description: 'Each QNAP NAS: drive bays and SMART health, volumes, shares, temperatures and firmware, with restart and shut down behind the confirm step.',
}
export const QNAP_TILE = { ok: true, headline: '2 NAS healthy', tone: 'good', rows: [{ label: 'nas-01', value: '61% used · 4 disks healthy' }, { label: 'family-nas', value: '35% used · 1 disk healthy' }] }

export const QNAP_ROUTES: FixtureRoute[] = [
  { path: '/api/plugins/qnap/instances', get: () => ok(QNAP_INSTANCES()) },
  { path: '/api/plugins/qnap/instances/:id/reading', get: p => ok({ ok: true, reading: reading(p.id) }) },
  { path: '/api/plugins/qnap/instances/:id/detail', get: p => ok(detail(p.id)) },
]
