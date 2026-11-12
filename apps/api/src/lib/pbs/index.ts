// =============================================================================
//  HyperProx — Proxmox Backup Server: the process-wide service, the plug-in's
//  transport, and the plain tables behind the visual page
//
//  The plug-in (plugins/pbs.ts) declares coreTransport, so a PBS token never
//  passes through the generic plug-in broker: this module is its only
//  transport, GET only, one fixed path.
// =============================================================================

import tls from 'node:tls'
import net from 'node:net'
import { setPluginTransport, type PluginDetail } from '../plugin-host'
import { getCredential, setCredential, deleteProviderCredentials } from '../credentials'
import { auditCredentialUse } from '../audit'
import { probeCertificate } from '../clusters/tls-pin'
import { portOf } from '../ha-control/target'
import { listClusters } from '../clusters/registry'
import { runInCluster } from '../clusters/context'
import { pveFromEnv } from '../pve-env'
import { PbsInstanceStore } from './instances'
import { PbsService, type Presented } from './service'
import { PbsTransport, resolvePbsTarget } from './transport'
import { coverageFor, type ClusterCoverage } from './coverage'
import type { PbsReading } from './parse'

/** Does the certificate at address:port verify against the public CAs for this name? */
export function caVerifies(address: string, port: number, servername: string | undefined, timeoutMs = 8000): Promise<boolean> {
  return new Promise(resolve => {
    const s = tls.connect({ host: address, port, servername, rejectUnauthorized: true })
    const t = setTimeout(() => { s.destroy(); resolve(false) }, timeoutMs)
    s.once('secureConnect', () => { clearTimeout(t); const ok = s.authorized; s.end(); resolve(ok) })
    s.once('error', () => { clearTimeout(t); resolve(false) })
  })
}

/** Read the certificate the backup server presents, after the address checks. */
export async function probePbs(url: string): Promise<Presented> {
  const u = new URL(url)
  const address = await resolvePbsTarget(u)
  const name = net.isIP(u.hostname.replace(/^\[|\]$/g, '')) ? undefined : u.hostname
  const cert = await probeCertificate(address, portOf(u), 10_000, name)
  return { fingerprint: cert.fingerprint, caVerified: name ? await caVerifies(address, portOf(u), name) : false }
}

export function productionPbs(): PbsService {
  return new PbsService({
    store: new PbsInstanceStore({ get: getCredential, set: setCredential, remove: deleteProviderCredentials }),
    audit: auditCredentialUse,
    probe: probePbs,
    api: c => new PbsTransport(c),
  })
}

let service: PbsService | null = null
export function pbsService(): PbsService { return service ?? (service = productionPbs()) }
/** For tests. */
export function setPbsService(s: PbsService | null): void { service = s }

/** The cluster cross-check for one server, through each cluster's own pinned client. */
export async function coverageOf(id: string): Promise<ClusterCoverage[]> {
  const svc = pbsService()
  const c = await svc.instances.connection(id)
  if (!c) return []
  const r = await svc.reading(id)
  return coverageFor(c.url, c.meta.pin?.fingerprint ?? null, r.groups, {
    clusters: () => listClusters().map(x => ({ id: x.id, name: x.name })),
    pve: (clusterId, path) => runInCluster(clusterId, () => pveFromEnv().fetchStrict<any>(path)),
  })
}

const size = (b: number | null) => (b === null ? '—' : b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(2)} TiB` : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(b / 1024 ** 2)} MiB`)
const when = (s: number | null) => (s ? new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 16) : '—')
const age = (h: number | null) => (h === null ? '—' : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`)

/** The plain tables behind the visual page ("Details"), for one server. */
export function detailOf(name: string, r: PbsReading): PluginDetail {
  const stale = r.groups.filter(g => g.stale).length
  return {
    stats: [
      { label: 'Server', value: name, hint: r.version ? `PBS ${r.version}` : undefined },
      { label: 'Health', value: r.health.state === 'active' ? 'Active' : 'Needs attention', hint: r.health.reason ?? undefined, tone: r.health.state === 'active' ? 'good' : 'warn' },
      { label: 'Datastores', value: String(r.datastores.length) },
      { label: 'Backup groups', value: String(r.groups.length), hint: stale ? `${stale} stale` : undefined, tone: stale ? 'bad' : 'good' },
      { label: 'Failed tasks', value: String(r.failedTasks.length), hint: 'last 24 h', tone: r.failedTasks.length ? 'warn' : 'good' },
    ],
    tables: [
      { title: 'Datastores', empty: 'No datastores the token can see.', columns: [
        { key: 'store', label: 'Datastore' }, { key: 'used', label: 'Used', align: 'right' }, { key: 'total', label: 'Size', align: 'right' },
        { key: 'pct', label: '%', align: 'right' }, { key: 'dedup', label: 'Dedup', align: 'right' }, { key: 'gc', label: 'Last GC' }],
        rows: r.datastores.map(d => ({ store: d.store, used: size(d.used), total: size(d.total), pct: d.usedFrac === null ? '—' : `${Math.round(d.usedFrac * 100)}%`,
          dedup: d.dedup === null ? '—' : `${d.dedup.toFixed(2)}x`, gc: d.gc.lastState ? `${d.gc.lastState} · ${when(d.gc.lastEnd)}` : 'never' })) },
      { title: 'Backup groups', empty: 'No backups yet.', total: r.groups.length, columns: [
        { key: 'group', label: 'Group' }, { key: 'where', label: 'Datastore' }, { key: 'newest', label: 'Newest' }, { key: 'age', label: 'Age', align: 'right' },
        { key: 'count', label: 'Snapshots', align: 'right' }, { key: 'size', label: 'Size', align: 'right' }, { key: 'verify', label: 'Verify' }],
        rows: r.groups.slice(0, 500).map(g => ({ group: `${g.type}/${g.id}`, where: g.ns ? `${g.store} / ${g.ns}` : g.store, newest: when(g.newest), age: `${age(g.ageHours)}${g.stale ? ' (stale)' : ''}`,
          count: g.count, size: size(g.size), verify: g.verify === 'none' ? 'not verified' : g.verify })) },
      { title: 'Jobs', empty: 'No prune, GC, verify or sync jobs.', columns: [
        { key: 'kind', label: 'Kind' }, { key: 'id', label: 'Job' }, { key: 'store', label: 'Datastore' }, { key: 'last', label: 'Last run' }, { key: 'result', label: 'Result' }, { key: 'next', label: 'Next run' }],
        rows: r.jobs.map(j => ({ kind: j.kind, id: j.id, store: j.store, last: when(j.lastEnd), result: j.result === 'failed' ? `failed: ${j.detail ?? ''}` : j.result, next: when(j.next) })) },
      { title: 'Failed tasks (24 h)', empty: 'No failed tasks in the last 24 hours.', columns: [
        { key: 'type', label: 'Task' }, { key: 'target', label: 'On' }, { key: 'start', label: 'Started' }, { key: 'status', label: 'Status' }],
        rows: r.failedTasks.map(t => ({ type: t.type, target: t.target ?? '—', start: when(t.start), status: t.status })) },
    ],
  }
}

export type ReadingRow = { id: string; name: string; reading: PbsReading | null; error: string | null }

export async function allReadings(): Promise<ReadingRow[]> {
  const svc = pbsService()
  const list = await svc.instances.list()
  return Promise.all(list.map(async m => {
    try { return { id: m.id, name: m.name, reading: await svc.reading(m.id), error: null } }
    catch (e: any) { return { id: m.id, name: m.name, reading: null, error: String(e?.message ?? 'Could not be read.').slice(0, 300) } }
  }))
}

export function installPbsPluginTransport(): void {
  setPluginTransport('pbs', async (method, path) => {
    if (method !== 'GET') throw new Error('The backup server plug-in only reads.')
    if (path === '/readings') return allReadings()
    throw new Error('That is not something the backup server plug-in may read.')
  })
}

installPbsPluginTransport()
