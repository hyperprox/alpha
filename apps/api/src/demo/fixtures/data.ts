// =============================================================================
//  HyperProx demo — the invented world every fixture is drawn from
//
//  One home cluster ("homelab": pve-a, pve-b, pve-c) and one remote server
//  ("Family Server"). Every address is 10.0.x.x, every domain example.com or
//  example.net, every person a generic first name. Nothing here describes a
//  real machine, network or person.
// =============================================================================

export const GiB = 1024 ** 3
export const TiB = 1024 ** 4
export const now = () => Date.now()
export const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString()
export const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000

export const DEMO_OWNER = { email: 'alex@example.com', role: 'owner' as const, name: 'alex' }
export const PEOPLE = ['alex', 'sam', 'jordan', 'casey', 'riley', 'morgan']
export const CLUSTER_NAME = 'homelab'
export const DOMAIN = 'example.com'
export const DOMAIN2 = 'example.net'
export const WAN_IP = '203.0.113.24'   // documentation range (RFC 5737)

export interface DemoNode { node: string; ip: string; cores: number; memGiB: number; diskGiB: number; cpu: number; mem: number; uptimeDays: number; cpuModel: string; gpu?: { name: string; vendor: 'nvidia' | 'intel' | 'amd'; dedicated: boolean; pci: string; deviceId: string } }
export const NODES: DemoNode[] = [
  { node: 'pve-a', ip: '10.0.0.11', cores: 16, memGiB: 64,  diskGiB: 100, cpu: 0.14, mem: 0.46, uptimeDays: 23, cpuModel: 'AMD Ryzen 7 5700G', gpu: { name: 'AMD Radeon Vega 8 (integrated)', vendor: 'amd', dedicated: false, pci: '0000:07:00.0', deviceId: '1638' } },
  { node: 'pve-b', ip: '10.0.0.12', cores: 8,  memGiB: 32,  diskGiB: 100, cpu: 0.22, mem: 0.58, uptimeDays: 23, cpuModel: 'Intel Core i5-12500T', gpu: { name: 'Intel UHD Graphics 770', vendor: 'intel', dedicated: false, pci: '0000:00:02.0', deviceId: '4690' } },
  { node: 'pve-c', ip: '10.0.0.13', cores: 24, memGiB: 128, diskGiB: 200, cpu: 0.31, mem: 0.52, uptimeDays: 9,  cpuModel: 'AMD Ryzen 9 5900X', gpu: { name: 'NVIDIA GeForce RTX 3060', vendor: 'nvidia', dedicated: true, pci: '0000:0b:00.0', deviceId: '2504' } },
]

export interface DemoGuest {
  vmid: number; name: string; type: 'lxc' | 'qemu'; node: string; status: 'running' | 'stopped'
  cores: number; memGiB: number; diskGiB: number; cpu: number; memUse: number; diskUse: number; ip: string
  tags?: string[]; ha?: 'prefer' | 'only'; gpu?: boolean; os?: string; app?: string
}
const g = (vmid: number, name: string, type: 'lxc' | 'qemu', node: string, status: 'running' | 'stopped', cores: number, memGiB: number, diskGiB: number, cpu: number, memUse: number, diskUse: number, extra: Partial<DemoGuest> = {}): DemoGuest =>
  ({ vmid, name, type, node, status, cores, memGiB, diskGiB, cpu, memUse, diskUse, ip: `10.0.${Math.floor(vmid / 100)}.${(vmid % 100) + 10}`, ...extra })

export const GUESTS: DemoGuest[] = [
  g(101, 'proxy',          'lxc',  'pve-a', 'running', 2, 2,  8,   0.03, 0.31, 0.42, { ha: 'prefer', app: 'Nginx Proxy Manager', tags: ['network'] }),
  g(102, 'adguard',        'lxc',  'pve-a', 'running', 1, 1,  4,   0.02, 0.22, 0.30, { ha: 'prefer', app: 'AdGuard Home', tags: ['network'] }),
  g(103, 'vaultwarden',    'lxc',  'pve-a', 'running', 1, 1,  8,   0.01, 0.18, 0.21, { ha: 'prefer', app: 'Vaultwarden' }),
  g(104, 'hyperprox',      'lxc',  'pve-a', 'running', 4, 8,  32,  0.08, 0.44, 0.38, { ha: 'prefer', app: 'HyperProx' }),
  g(105, 'meshcentral',    'lxc',  'pve-a', 'running', 2, 2,  8,   0.02, 0.27, 0.33, { app: 'MeshCentral' }),
  g(106, 'backup-server',  'qemu', 'pve-a', 'running', 4, 8,  64,  0.05, 0.61, 0.20, { app: 'Proxmox Backup Server', os: 'Debian 13' }),
  g(201, 'home-assistant', 'qemu', 'pve-b', 'running', 2, 4,  32,  0.06, 0.55, 0.36, { ha: 'prefer', app: 'Home Assistant OS', os: 'Home Assistant OS 16' }),
  g(202, 'nextcloud',      'lxc',  'pve-b', 'running', 4, 6,  64,  0.07, 0.48, 0.57, { app: 'Nextcloud' }),
  g(203, 'immich',         'lxc',  'pve-b', 'running', 4, 8,  48,  0.12, 0.63, 0.44, { gpu: true, app: 'Immich' }),
  g(204, 'gitea',          'lxc',  'pve-b', 'running', 2, 2,  16,  0.01, 0.29, 0.25, { app: 'Gitea' }),
  g(205, 'wireguard',      'lxc',  'pve-b', 'running', 1, 1,  4,   0.01, 0.12, 0.18, { ha: 'prefer', app: 'WireGuard', tags: ['network'] }),
  g(206, 'grafana-lab',    'lxc',  'pve-b', 'stopped', 2, 2,  8,   0,    0,    0.22, { app: 'Grafana' }),
  g(207, 'www',            'lxc',  'pve-b', 'running', 1, 1,  4,   0.03, 0.18, 0.21, { app: 'Static site', tags: ['web'] }),
  g(208, 'blog',           'lxc',  'pve-b', 'running', 2, 2,  10,  0.11, 0.46, 0.38, { app: 'WordPress', tags: ['web'] }),
  g(301, 'plex',           'lxc',  'pve-c', 'running', 6, 8,  64,  0.18, 0.41, 0.52, { ha: 'prefer', gpu: true, app: 'Plex Media Server', tags: ['media'] }),
  g(302, 'arr-stack',      'lxc',  'pve-c', 'running', 4, 6,  32,  0.09, 0.57, 0.61, { ha: 'prefer', app: 'Sonarr, Radarr, Prowlarr, qBittorrent', tags: ['media'] }),
  g(303, 'unmanic',        'lxc',  'pve-c', 'running', 8, 8,  32,  0.46, 0.38, 0.29, { gpu: true, app: 'Unmanic', tags: ['media'] }),
  g(304, 'jellyfin',       'lxc',  'pve-c', 'stopped', 4, 4,  32,  0,    0,    0.40, { app: 'Jellyfin', tags: ['media'] }),
  g(305, 'minecraft',      'lxc',  'pve-c', 'running', 4, 8,  24,  0.21, 0.72, 0.48, { app: 'Minecraft (Paper)', tags: ['games'] }),
  g(306, 'ubuntu-dev',     'qemu', 'pve-c', 'running', 8, 16, 120, 0.04, 0.34, 0.31, { os: 'Ubuntu 24.04' }),
  g(307, 'windows-11',     'qemu', 'pve-c', 'stopped', 8, 16, 256, 0,    0,    0.47, { os: 'Windows 11' }),
]

export const nodeOf = (name: string) => NODES.find(n => n.node === name)!
export const guestByVmid = (vmid: number) => GUESTS.find(x => x.vmid === vmid)
export const sidOf = (x: DemoGuest) => `${x.type === 'lxc' ? 'ct' : 'vm'}:${x.vmid}`

/** A stable pseudo-random number in [0,1) for a key, so the same page always shows the same figures. */
export function seeded(key: string): number {
  let h = 2166136261
  for (const c of key) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) }
  return ((h >>> 0) % 10000) / 10000
}
/** A slow wobble around a value, so live panels move a little between polls. */
export const wobble = (base: number, spread: number, key = '') => Math.max(0, base + spread * Math.sin(Date.now() / 7000 + seeded(key) * 6.28))

// -- Proxmox-shaped rows --------------------------------------------------------------------------
export function pveNodes() {
  return NODES.map(n => ({
    node: n.node, id: `node/${n.node}`, type: 'node', status: 'online', level: '',
    cpu: wobble(n.cpu, 0.04, n.node), maxcpu: n.cores,
    mem: Math.round(n.mem * n.memGiB * GiB), maxmem: n.memGiB * GiB,
    disk: Math.round(0.34 * n.diskGiB * GiB), maxdisk: n.diskGiB * GiB,
    uptime: n.uptimeDays * 86400 + 3721,
    ssl_fingerprint: fingerprint(n.node),
  }))
}

export function fingerprint(key: string, bytes = 32): string {
  const out: string[] = []
  for (let i = 0; i < bytes; i++) out.push(Math.floor(seeded(`${key}:${i}`) * 256).toString(16).padStart(2, '0').toUpperCase())
  return out.join(':')
}

export function pveGuests() {
  return GUESTS.map(x => {
    const on = x.status === 'running'
    return {
      vmid: x.vmid, name: x.name, type: x.type, node: x.node, status: x.status,
      cpus: x.cores, maxcpu: x.cores, cpu: on ? wobble(x.cpu, 0.02, x.name) : 0,
      mem: on ? Math.round(x.memUse * x.memGiB * GiB) : 0, maxmem: x.memGiB * GiB,
      disk: Math.round(x.diskUse * x.diskGiB * GiB), maxdisk: x.diskGiB * GiB,
      uptime: on ? (x.node === 'pve-c' ? 9 : 23) * 86400 - x.vmid * 37 : 0,
      netin: on ? Math.round(seeded(x.name + 'in') * 40 * GiB) : 0, netout: on ? Math.round(seeded(x.name + 'out') * 25 * GiB) : 0,
      template: 0, tags: (x.tags ?? []).join(';'),
      ...(x.ha ? { hastate: on ? 'started' : 'stopped' } : {}),
    }
  })
}

export function clusterTotals() {
  const ns = pveNodes()
  const t = ns.reduce((a, n) => ({
    cpu_used: a.cpu_used + n.cpu * n.maxcpu, cpu_total: a.cpu_total + n.maxcpu,
    mem_used: a.mem_used + n.mem, mem_total: a.mem_total + n.maxmem,
    disk_used: a.disk_used + n.disk, disk_total: a.disk_total + n.maxdisk,
  }), { cpu_used: 0, cpu_total: 0, mem_used: 0, mem_total: 0, disk_used: 0, disk_total: 0 })
  return { ...t, cpu_pct: Math.round(t.cpu_used / t.cpu_total * 100), mem_pct: Math.round(t.mem_used / t.mem_total * 100), disk_pct: Math.round(t.disk_used / t.disk_total * 100) }
}

// -- Storage --------------------------------------------------------------------------------------
export interface DemoStorage { storage: string; type: string; content: string; shared: 0 | 1; total: number; used: number; server?: string; export?: string }
export const STORAGES: DemoStorage[] = [
  { storage: 'vm-pool',     type: 'rbd',    content: 'images,rootdir',          shared: 1, total: 3.4 * TiB, used: 1.43 * TiB },
  { storage: 'media',       type: 'cephfs', content: 'backup,iso,vztmpl',       shared: 1, total: 21.8 * TiB, used: 12.9 * TiB },
  { storage: 'nas-media',   type: 'nfs',    content: 'images,backup',           shared: 1, total: 16 * TiB, used: 7.2 * TiB, server: '10.0.0.5', export: '/volume1/media' },
  { storage: 'nas-iso',     type: 'cifs',   content: 'iso,vztmpl',              shared: 1, total: 16 * TiB, used: 7.2 * TiB, server: '10.0.0.5', export: 'iso' },
  { storage: 'pbs',         type: 'pbs',    content: 'backup',                  shared: 1, total: 8 * TiB, used: 2.6 * TiB, server: '10.0.1.16' },
  { storage: 'local',       type: 'dir',    content: 'iso,vztmpl,backup,snippets', shared: 0, total: 94 * GiB, used: 31 * GiB },
  { storage: 'local-lvm',   type: 'lvmthin', content: 'images,rootdir',         shared: 0, total: 140 * GiB, used: 18 * GiB },
]
export function pveStorage(node?: string) {
  const rows: any[] = []
  for (const n of node ? [nodeOf(node)] : NODES) {
    for (const s of STORAGES) {
      rows.push({
        storage: s.storage, type: s.type, content: s.content, shared: s.shared, enabled: 1, active: 1,
        total: Math.round(s.total), used: Math.round(s.used), avail: Math.round(s.total - s.used), used_fraction: s.used / s.total, node: n.node,
      })
    }
  }
  return rows
}

// -- Ceph -----------------------------------------------------------------------------------------
export const OSDS = [
  { id: 0, host: 'pve-a', cls: 'nvme', size: 1.82 * TiB, pct: 41.2, lat: 2 },
  { id: 1, host: 'pve-b', cls: 'nvme', size: 1.82 * TiB, pct: 43.8, lat: 3 },
  { id: 2, host: 'pve-c', cls: 'nvme', size: 1.82 * TiB, pct: 40.6, lat: 2 },
  { id: 3, host: 'pve-c', cls: 'hdd',  size: 7.28 * TiB, pct: 58.9, lat: 11 },
  { id: 4, host: 'pve-c', cls: 'hdd',  size: 7.28 * TiB, pct: 60.1, lat: 13 },
  { id: 5, host: 'pve-a', cls: 'hdd',  size: 7.28 * TiB, pct: 57.4, lat: 12 },
]
export function cephOsds() {
  return OSDS.map(o => ({
    id: String(o.id), name: `osd.${o.id}`, host: o.host, status: 'up', in: 1, pgs: o.cls === 'nvme' ? 43 : 86,
    percent_used: o.pct, bytes_used: Math.round(o.size * o.pct / 100), total_space: Math.round(o.size), device_class: o.cls,
    commit_latency_ms: o.lat, apply_latency_ms: o.lat, reweight: 1, osdtype: 'bluestore',
  }))
}
export function cephStatus() {
  const total = OSDS.reduce((a, o) => a + o.size, 0)
  const used = OSDS.reduce((a, o) => a + o.size * o.pct / 100, 0)
  return {
    fsid: '6f1d2c3b-0a9e-4c7d-8b5a-1e2f3a4b5c6d',
    health: {
      status: 'HEALTH_OK', checks: {}, mutes: [],
    },
    quorum_names: NODES.map(n => n.node), quorum: [0, 1, 2], quorum_age: 1_987_200,
    osdmap: { epoch: 4211, num_osds: OSDS.length, num_up_osds: OSDS.length, num_in_osds: OSDS.length, num_remapped_pgs: 0 },
    pgmap: {
      pgs_by_state: [{ state_name: 'active+clean', count: 385 }], num_pgs: 385, num_pools: 4, num_objects: 2_418_311,
      data_bytes: Math.round(used / 2.1), bytes_used: Math.round(used), bytes_avail: Math.round(total - used), bytes_total: Math.round(total),
      read_bytes_sec: Math.round(wobble(18e6, 6e6, 'cr')), write_bytes_sec: Math.round(wobble(9e6, 3e6, 'cw')), read_op_per_sec: 212, write_op_per_sec: 148,
    },
    fsmap: { epoch: 31, by_rank: [{ filesystem_id: 1, rank: 0, name: 'pve-a', status: 'up:active' }], up: 1, in: 1, max: 1 },
    mgrmap: { available: true, active_name: 'pve-b', num_standbys: 2, modules: ['iostat', 'prometheus', 'restful'] },
    monmap: { epoch: 3, mons: NODES.map((n, rank) => ({ rank, name: n.node, addr: `${n.ip}:6789/0`, public_addr: `${n.ip}:6789/0` })) },
    servicemap: { epoch: 1, services: {} }, progress_events: {},
  }
}
export function cephPools() {
  return [
    { pool: 1, pool_name: '.mgr', size: 3, min_size: 2, pg_num: 1, crush_rule: 0, crush_rule_name: 'replicated_rule', type: 'replicated', application_metadata: { mgr: {} }, bytes_used: 41_943_040, percent_used: 0.00001, pg_autoscale_mode: 'on' },
    { pool: 2, pool_name: 'vm-pool', size: 3, min_size: 2, pg_num: 128, crush_rule: 1, crush_rule_name: 'nvme-only', type: 'replicated', application_metadata: { rbd: {} }, bytes_used: Math.round(1.43 * TiB * 3), percent_used: 0.42, pg_autoscale_mode: 'on' },
    { pool: 3, pool_name: 'media_data', size: 2, min_size: 1, pg_num: 128, crush_rule: 2, crush_rule_name: 'hdd-only', type: 'replicated', application_metadata: { cephfs: { data: 'media' } }, bytes_used: Math.round(12.9 * TiB), percent_used: 0.59, pg_autoscale_mode: 'on' },
    { pool: 4, pool_name: 'media_metadata', size: 3, min_size: 2, pg_num: 32, crush_rule: 1, crush_rule_name: 'nvme-only', type: 'replicated', application_metadata: { cephfs: { metadata: 'media' } }, bytes_used: 1_610_612_736, percent_used: 0.0009, pg_autoscale_mode: 'on' },
  ]
}

// -- HA -------------------------------------------------------------------------------------------
export function pveHa() {
  const rows: any[] = [
    { id: 'quorum', type: 'quorum', node: 'pve-a', status: 'OK', quorate: 1 },
    { id: 'master', type: 'master', node: 'pve-b', status: 'pve-b (active, static load CRS)', timestamp: Math.floor(Date.now() / 1000) },
    ...NODES.map(n => ({ id: `lrm:${n.node}`, type: 'lrm', node: n.node, status: `${n.node} (active, watchdog active)`, timestamp: Math.floor(Date.now() / 1000) })),
  ]
  for (const x of GUESTS.filter(x => x.ha)) {
    const sid = sidOf(x), st = x.status === 'running' ? 'started' : 'stopped'
    rows.push({ id: `service:${sid}`, sid, type: 'service', node: x.node, status: `${sid} (${x.node}, ${st})`, state: st, crm_state: st, request_state: st, max_restart: 1, max_relocate: 1, failback: 1 })
  }
  return rows
}

// -- Remote cluster ("Family Server") -------------------------------------------------------------
export const REMOTE = {
  id: 'c3f1a2b4c5d', name: 'Family Server', address: '10.0.50.10', port: 8006,
  node: { node: 'family-pve', ip: '10.0.50.10', cores: 8, memGiB: 32, cpu: 0.09, mem: 0.47, gpu: 'AMD Radeon RX 6400' },
  guests: [
    { vmid: 100, name: 'plex',       type: 'lxc' as const, status: 'running' as const, cores: 4, memGiB: 4, diskGiB: 32 },
    { vmid: 101, name: 'pihole',     type: 'lxc' as const, status: 'running' as const, cores: 1, memGiB: 1, diskGiB: 4 },
    { vmid: 102, name: 'photos',     type: 'lxc' as const, status: 'running' as const, cores: 2, memGiB: 4, diskGiB: 64 },
    { vmid: 103, name: 'win10-desk', type: 'qemu' as const, status: 'stopped' as const, cores: 4, memGiB: 8, diskGiB: 128 },
  ],
}
