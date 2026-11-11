// =============================================================================
//  HyperProx — QNAP: the process-wide service, the plug-in's transport and the
//  alert poller
//
//  The plug-in (plugins/qnap.ts: the gallery card, its detail and the switcher
//  dot) declares coreTransport, so a NAS login never passes through the generic
//  plug-in broker. This module is its transport: GET only, two fixed paths, and
//  answers already shaped for a viewer (no serial numbers, addresses or MACs).
// =============================================================================

import { setPluginTransport, type PluginDetail } from '../plugin-host'
import { getCredential, setCredential, deleteProviderCredentials } from '../credentials'
import { auditCredentialUse } from '../audit'
import { publish } from '../notify'
import { getCluster, clusterRow } from '../clusters/registry'
import { isUnlocked } from '../vault/state'
import { QnapInstanceStore, type ClusterFacts } from './instances'
import { QnapService } from './service'
import { liveNodeRunner } from './remote'
import { FileAlertState, QnapAlertPoller } from './alerts'
import type { QnapReading } from './parse'

export function clusterFacts(id: string): ClusterFacts | null {
  const c = getCluster(id)
  if (!c) return null
  const row = clusterRow(id)
  return { kind: c.kind, name: c.name, nodes: c.kind === 'remote' ? { ...(row?.nodeAddresses ?? {}) } : {} }
}

let service: QnapService | null = null

export function productionQnap(): QnapService {
  return new QnapService({
    store: new QnapInstanceStore({ get: getCredential, set: setCredential, remove: deleteProviderCredentials }, clusterFacts),
    audit: auditCredentialUse,
    publish: e => publish(e),
    nodeRunner: liveNodeRunner,
  })
}

export function qnapService(): QnapService { return service ?? (service = productionQnap()) }
/** For tests. */
export function setQnapService(s: QnapService | null): void { service = s }

/** What a viewer may see of a reading: no serial numbers, host name, addresses or MACs. */
export function viewerReading(r: QnapReading): QnapReading {
  return {
    ...r, serial: null, hostname: null,
    disks: r.disks.map(d => ({ ...d, serial: null })),
    interfaces: r.interfaces.map(n => ({ ...n, ip: null, mask: null, mac: null })),
  }
}

const gb = (b: number | null) => (b === null ? '—' : b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(2)} TB` : `${(b / 1024 ** 3).toFixed(1)} GB`)
const days = (s: number | null) => (s === null ? '—' : s >= 86_400 ? `${Math.floor(s / 86_400)} d ${Math.floor((s % 86_400) / 3600)} h` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`)
const c = (v: number | null) => (v === null ? '—' : `${v} °C`)

/** The plain tables behind the visual page ("Details"), for one NAS. */
export function detailOf(name: string, r: QnapReading): PluginDetail {
  const used = r.volumes.reduce((n, v) => n + (v.usedBytes ?? 0), 0)
  const total = r.volumes.reduce((n, v) => n + (v.totalBytes ?? 0), 0)
  const badDisks = r.disks.filter(d => d.smart === 'bad' || d.smart === 'warning').length
  return {
    stats: [
      { label: 'NAS', value: name },
      { label: 'Model', value: r.model ?? '—' },
      { label: 'Firmware', value: r.firmware.version ? `${r.firmware.version}${r.firmware.build ? ` (${r.firmware.build})` : ''}` : '—' },
      { label: 'Update', value: r.update.available === null ? 'unknown' : r.update.available ? (r.update.version ?? 'available') : 'up to date', tone: r.update.available ? 'warn' : r.update.available === false ? 'good' : undefined },
      { label: 'Uptime', value: days(r.uptimeSec) },
      { label: 'Used', value: total ? `${gb(used)} of ${gb(total)}` : '—' },
      { label: 'Disks', value: `${r.disks.length}${badDisks ? `, ${badDisks} with a warning` : ''}`, tone: badDisks ? 'bad' : 'good' },
      { label: 'System temp', value: c(r.sysTempC) },
    ],
    tables: [
      { title: 'Disks', empty: 'No disks reported.', columns: [
        { key: 'bay', label: 'Bay' }, { key: 'model', label: 'Model' }, { key: 'size', label: 'Size', align: 'right' },
        { key: 'temp', label: 'Temp', align: 'right' }, { key: 'smart', label: 'SMART' }, { key: 'test', label: 'Last test' }],
        rows: r.disks.map(d => ({ bay: d.bay, model: d.model ?? '—', size: d.capacity ?? '—', temp: c(d.tempC), smart: d.smartText ?? '—', test: [d.lastTest.type, d.lastTest.status, d.lastTest.time].filter(Boolean).join(' · ') || '—' })) },
      { title: 'Volumes', empty: 'No volumes reported.', columns: [
        { key: 'name', label: 'Volume' }, { key: 'status', label: 'Status' }, { key: 'used', label: 'Used', align: 'right' }, { key: 'total', label: 'Size', align: 'right' }, { key: 'pct', label: '%', align: 'right' }],
        rows: r.volumes.map(v => ({ name: v.name, status: v.status ?? '—', used: gb(v.usedBytes), total: gb(v.totalBytes), pct: v.totalBytes && v.usedBytes !== null ? `${Math.round((v.usedBytes / v.totalBytes) * 100)}%` : '—' })) },
      ...(r.pools.length ? [{ title: 'Storage pools', columns: [{ key: 'name', label: 'Pool' }, { key: 'status', label: 'Status' }, { key: 'used', label: 'Used', align: 'right' as const }, { key: 'total', label: 'Size', align: 'right' as const }],
        rows: r.pools.map(p => ({ name: p.name, status: p.status ?? '—', used: gb(p.usedBytes), total: gb(p.totalBytes) })) }] : []),
      { title: 'Shares', empty: 'No shares reported.', columns: [{ key: 'name', label: 'Share' }, { key: 'volume', label: 'Volume' }, { key: 'used', label: 'Used', align: 'right' }],
        rows: r.shares.map(s => ({ name: s.name, volume: s.volume ?? '—', used: gb(s.usedBytes) })) },
      { title: 'Network', empty: 'No interfaces reported.', columns: [{ key: 'name', label: 'Interface' }, { key: 'link', label: 'Link' }, { key: 'speed', label: 'Speed', align: 'right' }, { key: 'ip', label: 'Address' }, { key: 'mode', label: 'Mode' }],
        rows: r.interfaces.map(n => ({ name: n.name, link: n.up === null ? '—' : n.up ? 'up' : 'down', speed: n.speedMbps ? `${n.speedMbps} Mb/s` : '—', ip: n.ip ?? '—', mode: n.mode ?? '—' })) },
      { title: 'Sensors', empty: 'No sensors reported.', columns: [{ key: 'name', label: 'Sensor' }, { key: 'value', label: 'Reading', align: 'right' }],
        rows: [
          ...(r.sysTempC !== null ? [{ name: 'System', value: c(r.sysTempC) }] : []),
          ...(r.cpuTempC !== null ? [{ name: 'CPU', value: c(r.cpuTempC) }] : []),
          ...r.fans.map(f => ({ name: `Fan ${f.index}`, value: f.rpm === null ? (f.ok === false ? 'stopped' : '—') : `${f.rpm} rpm` })),
          ...(r.cpuPct !== null ? [{ name: 'CPU use', value: `${r.cpuPct}%` }] : []),
          ...(r.memTotalMB !== null ? [{ name: 'Memory', value: `${Math.round((r.memTotalMB - (r.memFreeMB ?? 0)))} of ${Math.round(r.memTotalMB)} MB used` }] : []),
        ] },
    ],
  }
}

/** The card's reading of every NAS: names, whether remote, and each one's reading or why there is none. */
export async function allReadings(): Promise<Array<{ id: string; name: string; remote: boolean; reading: QnapReading | null; error: string | null }>> {
  const svc = qnapService()
  const list = await svc.instances.list()
  return Promise.all(list.map(async m => {
    const remote = svc.instances.cluster(m.clusterId)?.kind === 'remote'
    try { return { id: m.id, name: m.name, remote, reading: viewerReading(await svc.reading(m.id)), error: null } }
    catch (e: any) { return { id: m.id, name: m.name, remote, reading: null, error: String(e?.message ?? 'Could not be read.').slice(0, 300) } }
  }))
}

export function installQnapPluginTransport(): void {
  setPluginTransport('qnap', async (method, path) => {
    if (method !== 'GET') throw new Error('The QNAP plug-in only reads.')
    if (path === '/readings') return allReadings()
    throw new Error('That is not something the QNAP plug-in may read.')
  })
}

installQnapPluginTransport()

let poller: QnapAlertPoller | null = null

/** Start the alert poller once. Its reads go through the same service (cache, held logins) as the page. */
export function startQnapAlerts(log?: (m: string) => void): () => void {
  if (poller) return () => {}
  const svc = qnapService()
  poller = new QnapAlertPoller({
    instances: () => svc.instances.list(),
    read: id => svc.reading(id),
    publish: e => publish(e),
    store: new FileAlertState(),
    ready: () => isUnlocked(),
    log,
  })
  poller.start()
  return () => { poller?.stop(); poller = null }
}
