// Demo fixtures: the Command center (home cluster "homelab" plus the remote "Family Server").
import type { FixtureRoute, FixtureContext } from './types'
import { NODES, GUESTS, REMOTE, CLUSTER_NAME, GiB, TiB, fingerprint, iso, HOUR, MIN, DAY, seeded, wobble, clusterTotals } from './data'
import { backupAt } from './core'

const ok = (data: unknown) => ({ success: true, data })
export const isRemote = (ctx: FixtureContext) => ctx.cluster === REMOTE.id

const COMMANDS = [
  'pveum user add hyperprox@pve --comment "HyperProx"',
  'pveum aclmod / -user hyperprox@pve -role Administrator',
  'pveum user token add hyperprox@pve main --privsep 0',
]

function clusterList() {
  return [
    { id: 'home', name: CLUSTER_NAME, kind: 'home', address: '', port: 8006, note: '', cert: { fingerprint: null, confirmedAt: null, confirmedBy: null, verified: null },
      nodeAddresses: {}, allowedRoots: ['/mnt/media/Movies', '/mnt/media/TV'], monitoring: {}, plexUrl: null, ignoredGuests: [], token: null },
    { id: REMOTE.id, name: REMOTE.name, kind: 'remote', address: REMOTE.address, port: REMOTE.port, note: 'Parents\' house, over WireGuard',
      cert: { fingerprint: fingerprint('family-cert'), confirmedAt: iso(9 * DAY), confirmedBy: 'alex@example.com', verified: iso(2 * HOUR) },
      nodeAddresses: { [REMOTE.node.node]: REMOTE.node.ip }, allowedRoots: ['/mnt/nas/movies'],
      monitoring: { [REMOTE.node.node]: { nodeExporter: { listen: REMOTE.node.ip }, amdGpu: { at: iso(9 * DAY) } } },
      plexUrl: 'http://10.0.50.20:32400', ignoredGuests: [], token: { saved: true, id: 'hyperprox@pve!main' } },
  ]
}

const gpuRow = (node: string, name: string, shortName: string, vendor: string, kind: 'integrated' | 'dedicated', pci: string, load: number, vram: [number | null, number | null], tempC: number | null, powerW: number | null, cap: string, capShort: string) => ({
  node, name, shortName, vendor, kind, pci, load, vramUsed: vram[0], vramTotal: vram[1], memory: kind === 'dedicated' ? 'dedicated' : 'shared',
  tempC, fanPct: kind === 'dedicated' ? 34 : null, freqMHz: kind === 'dedicated' ? 1777 : 450, powerW, state: 'measured', stateNote: null, setupHref: null,
  capability: cap, capabilityShort: capShort, capabilitySource: vendor === 'nvidia' ? 'vainfo' : 'estimate',
})

function overview() {
  const t = clusterTotals()
  const running = GUESTS.filter(x => x.status === 'running').length
  const home = {
    id: 'home', name: CLUSTER_NAME, kind: 'home', reachable: true, latencyMs: 2, nodes: { online: 3, total: 3 }, quorum: 'ok',
    guests: { running, total: GUESTS.length }, cpuPct: t.cpu_pct, memPct: t.mem_pct, storagePct: 48,
    networkStorage: [{ server: '10.0.0.5', shares: 2, volumes: 1, names: ['nas-media', 'nas-iso'], usedBytes: Math.round(7.2 * TiB), totalBytes: 16 * TiB, pct: 45 }],
    gpus: [
      gpuRow('pve-c', 'NVIDIA GeForce RTX 3060', 'RTX 3060', 'nvidia', 'dedicated', '0000:0b:00.0', Math.round(wobble(18, 8, 'g')), [3010 * 1048576, 12288 * 1048576], 52, 41, 'NVENC and NVDEC: H.264, HEVC and AV1 decode, H.264 and HEVC encode (checked with nvidia-smi).', 'HEVC decode: yes'),
      gpuRow('pve-b', 'Intel UHD Graphics 770', 'UHD 770', 'intel', 'integrated', '0000:00:02.0', 7, [null, null], null, 3, 'Intel 12th generation (Quick Sync): H.264, HEVC and AV1 decode (an estimate from the model).', 'HEVC decode: likely yes (estimate)'),
      gpuRow('pve-a', 'AMD Radeon Vega 8 (integrated)', 'Vega 8', 'amd', 'integrated', '0000:07:00.0', 2, [null, null], null, null, 'AMD Vega: H.264 and HEVC decode (an estimate from the model).', 'HEVC decode: likely yes (estimate)'),
    ],
    gpuNote: 'Load: measured on every GPU. HEVC lines marked estimate come from the model name.',
    lastBackup: { at: backupAt(), ok: true, node: 'pve-a' }, attention: [] as any[], monitoring: true,
    updates: { available: 14, packages: 23, security: 3, checkedAt: iso(8 * HOUR), result: 'ok' },
  }
  const remote = {
    id: REMOTE.id, name: REMOTE.name, kind: 'remote', reachable: true, latencyMs: 24, nodes: { online: 1, total: 1 }, quorum: 'standalone',
    guests: { running: 3, total: 4 }, cpuPct: 9, memPct: 47, storagePct: 31,
    networkStorage: [{ server: '10.0.50.5', shares: 1, volumes: 1, names: ['family-nas'], usedBytes: Math.round(2.1 * TiB), totalBytes: 6 * TiB, pct: 35 }],
    gpus: [gpuRow(REMOTE.node.node, 'AMD Radeon RX 6400', 'RX 6400', 'amd', 'dedicated', '0000:03:00.0', 4, [210 * 1048576, 4096 * 1048576], 44, 9, 'AMD RDNA 2: H.264 and HEVC decode, no encoder on this model (an estimate from the model).', 'HEVC decode: likely yes (estimate)')],
    gpuNote: null, lastBackup: { at: Date.now() - 11 * HOUR, ok: true, node: REMOTE.node.node },
    attention: [{ clusterId: REMOTE.id, clusterName: REMOTE.name, kind: 'remote', severity: 'warn', title: 'win10-desk has not been backed up in 12 days', detail: 'It is stopped, so nothing has changed, but its last backup is older than the 7-day rule.' }],
    monitoring: true, updates: { available: 6, packages: 9, security: 1, checkedAt: iso(8 * HOUR), result: 'ok' },
  }
  return { panels: [home, remote], attention: remote.attention }
}

export function remoteNodes() {
  const n = REMOTE.node
  return [{ node: n.node, id: `node/${n.node}`, type: 'node', status: 'online', level: '', cpu: wobble(n.cpu, 0.03, 'rn'), maxcpu: n.cores, mem: Math.round(n.mem * n.memGiB * GiB), maxmem: n.memGiB * GiB, disk: 21 * GiB, maxdisk: 94 * GiB, uptime: 41 * 86400, ssl_fingerprint: fingerprint('family-cert') }]
}
export function remoteGuestOverview() {
  return REMOTE.guests.map(x => {
    const on = x.status === 'running'
    return { vmid: x.vmid, type: x.type, node: REMOTE.node.node, name: x.name, status: x.status, template: false, lock: null,
      cpu: on ? 0.03 + seeded(x.name) * 0.05 : 0, maxcpu: x.cores, mem: on ? Math.round(x.memGiB * GiB * 0.45) : 0, maxmem: x.memGiB * GiB,
      disk: Math.round(x.diskGiB * GiB * 0.4), maxdisk: x.diskGiB * GiB, uptime: on ? 41 * 86400 : 0, tags: [], ip: `10.0.50.${20 + x.vmid - 100}`,
      ha: { managed: false }, gpu: x.name === 'plex' ? { vendors: ['amd'], via: ['lxc cgroup', 'lxc mount'], toggle: 'on' } : { vendors: [], via: [], toggle: 'none' }, pending: false, vpn: { state: 'none' } }
  })
}
export function remoteStorage() {
  const n = REMOTE.node.node
  return [
    { storage: 'local', type: 'dir', content: 'iso,vztmpl,backup', shared: 0, enabled: 1, active: 1, total: 94 * GiB, used: 21 * GiB, avail: 73 * GiB, used_fraction: 0.22, node: n },
    { storage: 'local-lvm', type: 'lvmthin', content: 'images,rootdir', shared: 0, enabled: 1, active: 1, total: 800 * GiB, used: 214 * GiB, avail: 586 * GiB, used_fraction: 0.27, node: n },
    { storage: 'family-nas', type: 'nfs', content: 'backup,iso', shared: 1, enabled: 1, active: 1, total: 6 * TiB, used: Math.round(2.1 * TiB), avail: Math.round(3.9 * TiB), used_fraction: 0.35, node: n },
  ]
}

function remoteTasks() {
  const n = REMOTE.node.node
  return Array.from({ length: 10 }, (_, i) => {
    const x = REMOTE.guests[i % REMOTE.guests.length], type = i % 3 === 0 ? 'vzdump' : i % 3 === 1 ? 'vzstart' : 'aptupdate'
    const st = Math.floor((Date.now() - (i + 1) * 3 * HOUR) / 1000)
    return { upid: `UPID:${n}:0000${(1000 + i).toString(16).toUpperCase()}:00${i}:${st.toString(16).toUpperCase()}:${type}:${x.vmid}:hyperprox@pve!main:`, node: n, type, id: type === 'aptupdate' ? '' : String(x.vmid), user: 'hyperprox@pve!main', starttime: st, endtime: st + 60 + i * 7, status: 'OK' }
  })
}

function hardware() {
  return {
    nodes: [{ node: REMOTE.node.node, address: REMOTE.node.ip, source: 'proxmox-api', nodeExporter: 'running', amdMetrics: 'on', vainfo: 'checked',
      gpus: [{ name: 'AMD Radeon RX 6400', vendor: 'amd', kind: 'dedicated', capability: 'AMD RDNA 2: H.264 and HEVC decode; this model has no hardware encoder.', capabilityShort: 'HEVC decode: yes', checkedWith: 'vainfo', decode: ['H.264', 'HEVC', 'VP9', 'AV1'], encode: [] }] }],
    summary: `Found 1 node. ${REMOTE.node.node}: AMD Radeon RX 6400 (dedicated); health monitoring is running.`, note: null,
  }
}

function filesBrowse(q: Record<string, string>) {
  const path = q.path || '/mnt/media'
  const dirs = ['Movies', 'TV', 'Music', 'Photos']
  const movies = ['Arrival (2016)', 'Blade Runner 2049 (2017)', 'Dune (2021)', 'Interstellar (2014)', 'The Martian (2015)', 'Spirited Away (2001)']
  const entries = path.endsWith('/Movies') ? movies.map((m, i) => ({ name: m, type: 'dir', size: 0, mtime: Date.now() - i * 9 * DAY }))
    : dirs.map((d, i) => ({ name: d, type: 'dir', size: 0, mtime: Date.now() - i * DAY }))
  return { path, entries, up: path === '/mnt/media' ? null : path.replace(/\/[^/]+$/, '') || '/' }
}

export const CLUSTERS: FixtureRoute[] = [
  { path: '/api/clusters', get: () => ({ success: true, data: clusterList(), commands: COMMANDS }) },
  { path: '/api/clusters/overview', get: () => ok(overview()) },
  { path: '/api/clusters/files/jobs', get: () => ok([
    { id: 'fj1', state: 'done', from: { cluster: 'home', node: 'pve-c', path: '/mnt/media/Movies/Arrival (2016)' }, to: { cluster: REMOTE.id, node: REMOTE.node.node, path: '/mnt/nas/movies' }, bytes: Math.round(14.2 * GiB), total: Math.round(14.2 * GiB), startedAt: iso(2 * DAY), finishedAt: iso(2 * DAY - 31 * MIN), by: 'alex@example.com' },
  ]) },
  { path: '/api/clusters/files/keys', get: () => ok([]) },
  { path: '/api/clusters/:id/nodes', get: p => ok(p.id === REMOTE.id ? [{ node: REMOTE.node.node, status: 'online', address: REMOTE.node.ip, login: true }] : NODES.map(n => ({ node: n.node, status: 'online', address: n.ip, login: true }))) },
  { path: '/api/clusters/:id/tasks', get: () => ok(remoteTasks()) },
  { path: '/api/clusters/:id/tasks/:node/:upid', get: () => ok({ running: false, ok: true, exitstatus: 'OK' }) },
  { path: '/api/clusters/:id/hardware', get: () => ok(hardware()) },
  { path: '/api/clusters/:id/monitoring/scan', get: () => ok({ nodes: [{ node: REMOTE.node.node, nodeExporter: 'running', gpu: 'amd', amdMetrics: 'on' }], questions: [] }) },
  { path: '/api/clusters/:id/nodes/:node/backup-storages', get: () => ok([{ storage: 'family-nas', type: 'nfs', avail: Math.round(3.9 * TiB) }]) },
  { path: '/api/clusters/:id/files/browse', get: (_p, q) => ok(filesBrowse(q)) },
  { path: '/api/clusters/:id/send/browse', get: (_p, q) => ok(filesBrowse(q)) },
  { path: '/api/clusters/:id/send/search', get: (_p, q) => ok(['Arrival (2016)', 'Dune (2021)', 'Dune: Part Two (2024)'].filter(t => t.toLowerCase().includes(String(q.q ?? '').toLowerCase())).map(t => ({ name: t, type: 'dir', path: `/mnt/media/Movies/${t}`, size: 0 }))) },
  { path: '/api/clusters/add-jobs/:jobId', get: () => ok({ state: 'done' }) },
]

