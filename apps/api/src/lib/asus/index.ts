// =============================================================================
//  HyperProx — ASUS router: the process-wide service and the plug-in's transport
//
//  The plug-in (plugins/asus.ts: the gallery card, its detail and the AI
//  summary) declares coreTransport, so a router login never passes through the
//  generic plug-in broker. This module is its transport: GET only, one fixed
//  path, and answers already shaped for a viewer (no MAC addresses, no client
//  addresses, no WAN address), whoever is asking.
// =============================================================================

import { setPluginTransport, type PluginDetail } from '../plugin-host'
import { getCredential, setCredential, deleteProviderCredentials } from '../credentials'
import { auditCredentialUse } from '../audit'
import { publish } from '../notify'
import { AsusInstanceStore } from './instances'
import { AsusService } from './service'
import { viewerReading, type AsusReading } from './parse'

export { viewerReading }

let service: AsusService | null = null
let sweeper: NodeJS.Timeout | null = null

export function productionAsus(): AsusService {
  return new AsusService({
    store: new AsusInstanceStore({ get: getCredential, set: setCredential, remove: deleteProviderCredentials }),
    audit: auditCredentialUse,
    publish: e => publish(e),
  })
}

export function asusService(): AsusService {
  if (!service) {
    service = productionAsus()
    // Idle sessions are logged out: ASUS allows one admin session, so HyperProx never sits on it.
    sweeper = setInterval(() => { void service?.sweep() }, 30_000)
    sweeper.unref?.()
  }
  return service
}

/** For tests. */
export function setAsusService(s: AsusService | null): void { service = s }

export async function stopAsus(): Promise<void> {
  if (sweeper) { clearInterval(sweeper); sweeper = null }
  await service?.closeAll().catch(() => {})
}

export const mbps = (bps: number | null) => (bps === null ? '—' : `${(bps / 1_000_000).toFixed(bps >= 100_000_000 ? 0 : 1)} Mbps`)
export const duration = (s: number | null) => (s === null ? '—'
  : s >= 86_400 ? `${Math.floor(s / 86_400)} d ${Math.floor((s % 86_400) / 3600)} h`
  : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
  : `${Math.floor(s / 60)} min`)

/** The plain tables behind the visual page ("Details"), for one router. Shape what the role may see before calling. */
export function detailOf(name: string, r: AsusReading): PluginDetail {
  return {
    stats: [
      { label: 'Router', value: name },
      { label: 'Model', value: r.model ?? '—' },
      { label: 'Firmware', value: r.firmware.version ? `${r.firmware.version}${r.firmware.flavour === 'merlin' ? ' (Merlin)' : ''}` : '—' },
      { label: 'Update', value: r.update.available === null ? 'not reported' : r.update.available ? (r.update.version ?? 'available') : 'up to date', tone: r.update.available ? 'warn' : r.update.available === false ? 'good' : undefined },
      { label: 'Uptime', value: duration(r.uptimeSec) },
      { label: 'CPU', value: r.cpuPct === null ? '—' : `${r.cpuPct}%`, tone: r.cpuPct !== null && r.cpuPct >= 90 ? 'bad' : undefined },
      { label: 'Memory', value: r.mem ? `${r.mem.pct}%` : '—', tone: r.mem && r.mem.pct >= 92 ? 'bad' : undefined },
      { label: 'Internet', value: r.wan.up === null ? 'unknown' : r.wan.up ? 'connected' : 'down', tone: r.wan.up === false ? 'bad' : r.wan.up ? 'good' : undefined },
      { label: 'Download', value: mbps(r.wan.downBps) },
      { label: 'Upload', value: mbps(r.wan.upBps) },
    ],
    tables: [
      { title: 'Internet', columns: [{ key: 'k', label: 'Setting' }, { key: 'v', label: 'Value' }], rows: [
        { k: 'Status', v: r.wan.status ?? (r.wan.up === null ? '—' : r.wan.up ? 'Connected' : 'Disconnected') },
        { k: 'Connection type', v: r.wan.type ?? '—' },
        { k: 'Address', v: r.wan.ip ?? '—' },
        { k: 'Gateway', v: r.wan.gateway ?? '—' },
        { k: 'WAN unit', v: r.wan.unit ?? '—' },
      ] },
      { title: 'Wi-Fi', empty: 'The router reported no radios.', columns: [
        { key: 'band', label: 'Band' }, { key: 'ssid', label: 'SSID' }, { key: 'channel', label: 'Channel' }, { key: 'width', label: 'Width' }, { key: 'state', label: 'Radio' }, { key: 'clients', label: 'Clients', align: 'right' }],
        rows: r.bands.map(b => ({ band: b.label, ssid: b.ssid ?? '—', channel: b.channel ?? '—', width: b.widthMhz ? `${b.widthMhz} MHz` : '—', state: b.enabled ? 'on' : 'off', clients: b.clients })) },
      { title: 'Connected devices', empty: 'No devices are online.', total: r.devices.length, columns: [
        { key: 'name', label: 'Name' }, { key: 'via', label: 'Connection' }, { key: 'ip', label: 'Address' }, { key: 'mac', label: 'MAC' },
        { key: 'signal', label: 'Signal', align: 'right' }, { key: 'online', label: 'Online', align: 'right' }],
        rows: r.devices.map(d => ({ name: d.name, via: d.connection === 'wired' ? 'wired' : d.band ?? 'Wi-Fi', ip: d.ip ?? '—', mac: d.mac ?? '—',
          signal: d.rssi === null ? '—' : `${d.rssi} dBm`, online: duration(d.onlineSec) })) },
      { title: 'Health', empty: 'Nothing needs attention.', columns: [{ key: 'reason', label: 'Needs attention' }], rows: r.health.reasons.map(reason => ({ reason })) },
    ],
  }
}

export type ReadingRow = { id: string; name: string; reading: AsusReading | null; error: string | null }

/** The card's reading of every router: names, and each one's viewer-safe reading or why there is none. */
export async function allReadings(): Promise<ReadingRow[]> {
  const svc = asusService()
  const list = await svc.instances.list()
  return Promise.all(list.map(async m => {
    try { return { id: m.id, name: m.name, reading: viewerReading(await svc.reading(m.id)), error: null } }
    // Generic words only: this feeds the gallery card and the AI page, whoever is reading them, and a router's own
    // error text (or a refused address) is for the router's page, where the role decides what is shown.
    catch (e: any) { return { id: m.id, name: m.name, reading: null, error: e?.code === 'login_held' ? 'waiting before it signs in again' : 'not reachable right now' } }
  }))
}

export function installAsusPluginTransport(): void {
  setPluginTransport('asus', async (method, path) => {
    if (method !== 'GET') throw new Error('The ASUS plug-in only reads.')
    if (path === '/readings') return allReadings()
    throw new Error('That is not something the ASUS plug-in may read.')
  })
}

installAsusPluginTransport()
