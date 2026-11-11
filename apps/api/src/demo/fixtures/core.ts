// Demo fixtures: dashboard, infrastructure, storage, monitoring and HA.
import type { FixtureRoute } from './types'
import {
  NODES, GUESTS, GiB, CLUSTER_NAME, DOMAIN, pveNodes, pveGuests, clusterTotals, pveStorage, cephStatus, cephOsds,
  cephPools, pveHa, sidOf, wobble, seeded, iso, HOUR, MIN, nodeOf,
} from './data'

const ok = (data: unknown) => ({ success: true, data })

function gpuFull() {
  return {
    name: 'NVIDIA GeForce RTX 3060', vram_total: 12288, vram_used: 3010, vram_free: 9278, gpu_util: Math.round(wobble(18, 8, 'gpu')),
    temp: 52, power_draw: 41.3, power_limit: 170, vram_pct: 24, power_pct: 24,
    consumers: [
      { pid: 41822, vram_mb: 1840, process: 'Plex Transcoder', ct_id: '301', ct_name: 'plex', vram_pct: 15 },
      { pid: 52210, vram_mb: 1170, process: 'ffmpeg', ct_id: '303', ct_name: 'unmanic', vram_pct: 9 },
    ],
  }
}

export function gpuStatus() {
  return NODES.map(n => ({
    node: n.node, reachable: true, port: n.gpu?.vendor === 'nvidia' ? 9835 : n.gpu?.vendor === 'intel' ? 8081 : 9100, install: null,
    gpus: n.gpu ? [{ node: n.node, type: n.gpu.vendor === 'nvidia' ? 'nvidia' : n.gpu.vendor === 'intel' ? 'intel-igpu' : 'amd-igpu', vendor: n.gpu.vendor,
      vendorName: n.gpu.vendor === 'nvidia' ? 'NVIDIA' : n.gpu.vendor === 'intel' ? 'Intel' : 'AMD', deviceName: n.gpu.name, deviceId: n.gpu.deviceId, pciId: n.gpu.pci, dedicated: n.gpu.dedicated }] : [],
  }))
}

function networkStats() {
  const nodes = NODES.map(n => {
    const netin = wobble(2.4e6 * (n.node === 'pve-c' ? 3 : 1), 6e5, n.node + 'i'), netout = wobble(1.6e6 * (n.node === 'pve-c' ? 4 : 1), 5e5, n.node + 'o')
    return { node: n.node, netin, netout, netin_mb: +(netin / 1048576).toFixed(2), netout_mb: +(netout / 1048576).toFixed(2) }
  })
  return {
    nodes, ceph_io: { read_bps: Math.round(wobble(18e6, 6e6, 'r')), write_bps: Math.round(wobble(9e6, 3e6, 'w')), read_ops: 212, write_ops: 148 },
    total_in: nodes.reduce((a, n) => a + n.netin, 0), total_out: nodes.reduce((a, n) => a + n.netout, 0),
  }
}

function bandwidth() {
  return {
    links: [
      { id: 'wan', label: 'WAN', kind: 'wan', downBps: Math.round(wobble(48e6, 20e6, 'wd')), upBps: Math.round(wobble(9e6, 4e6, 'wu')), downCapacityBps: 1e9, upCapacityBps: 1e8, source: 'mikrotik' },
      { id: 'lan', label: 'LAN bridge', kind: 'lan', downBps: Math.round(wobble(120e6, 40e6, 'ld')), upBps: Math.round(wobble(80e6, 30e6, 'lu')), source: 'mikrotik' },
    ],
    unavailable: [], at: Date.now(),
  }
}

function power() {
  const nodes = NODES.map(n => {
    const cpu = n.node === 'pve-c' ? wobble(62, 6, 'pc') : n.node === 'pve-a' ? wobble(28, 3, 'pa') : wobble(14, 2, 'pb')
    const gpu = n.gpu?.dedicated ? wobble(41, 6, 'pg') : null
    return { node: n.node, cpu, gpu, total: cpu + (gpu ?? 0), source: n.gpu?.dedicated ? 'rapl + nvidia' : 'rapl' }
  })
  return { total: Math.round(nodes.reduce((a, n) => a + n.total, 0)), nodes, silent: [], reporting: 3, of: 3, prometheusUnreachable: false,
    covers: 'CPU package (plus DRAM where the board reports it) and NVIDIA board power. Disks, fans and the power supply are not measured.' }
}

const backupAt = () => Date.now() - 5 * HOUR - 12 * MIN

export function guestOverview() {
  return pveGuests().map(v => {
    const x = GUESTS.find(y => y.vmid === v.vmid)!
    const sid = sidOf(x)
    return {
      vmid: v.vmid, type: v.type, node: v.node, name: v.name, status: v.status, template: false, lock: null,
      cpu: v.cpu, maxcpu: v.maxcpu, mem: v.mem, maxmem: v.maxmem, disk: v.disk, maxdisk: v.maxdisk, uptime: v.uptime,
      tags: x.tags ?? [], ip: x.ip,
      ha: x.ha ? { managed: true, state: v.status === 'running' ? 'started' : 'stopped', status: `${sid} (${x.node}, ${v.status === 'running' ? 'started' : 'stopped'})` } : { managed: false },
      gpu: x.gpu ? { vendors: [x.node === 'pve-c' ? 'nvidia' : 'intel'], via: ['lxc cgroup', 'lxc mount'], toggle: 'on' } : { vendors: [], via: [], toggle: 'none' },
      pending: false,
      vpn: x.name === 'hyperprox' ? { state: 'connected', provider: 'tailscale', address: '10.64.0.4', hostname: 'hyperprox.tail0demo.ts.net', lastSeen: iso(2 * MIN), detail: 'Tailscale connected' }
        : x.name === 'wireguard' ? { state: 'connected', provider: 'wireguard', address: '10.8.0.1', detail: 'WireGuard server, 4 peers' } : { state: 'none' },
    }
  })
}

export function haBadges() {
  const out: Record<string, any> = {}
  for (const x of GUESTS) {
    const sid = sidOf(x)
    out[sid] = x.ha
      ? { sid, protected: true, state: x.status === 'running' ? 'started' : 'stopped', home: x.gpu ? 'only' : 'prefer', homeNodes: [x.node], warn: null }
      : { sid, protected: false, state: null, home: 'none', homeNodes: [], warn: null }
  }
  return out
}

function summary() {
  return {
    nodes: pveNodes(), vms: pveGuests(), ceph: cephStatus(), osds: cephOsds(), ha: pveHa(), storage: pveStorage('pve-a'),
    gpu: gpuFull(), clusterName: CLUSTER_NAME, cluster: clusterTotals(),
    services: { npm: { total: 14, enabled: 14, disabled: 0, online: 14, ssl: 14, expiring: 1, expired: 0, state: 'connected', connected: true, url: `https://proxy.${DOMAIN}` } },
  }
}

function storageOverview() {
  const nodes = pveNodes()
  const shared = pveStorage('pve-a').filter(s => s.shared)
  const local = pveStorage('pve-a').filter(s => !s.shared).map(s => ({ ...s, nodeCount: NODES.length, nodes: NODES.map(n => n.node) }))
  return { storage: [...shared, ...local], ceph: cephStatus(), osds: cephOsds(), pools: cephPools(), nodes, warnings: [] }
}

function vmsBreakdown() {
  return GUESTS.map(x => {
    const size = x.diskGiB * GiB
    const st = x.type === 'qemu' && x.name === 'backup-server' ? 'local-lvm' : 'vm-pool'
    return { vmid: x.vmid, name: x.name, type: x.type, node: x.node, status: x.status,
      disks: [{ key: x.type === 'lxc' ? 'rootfs' : 'scsi0', storage: st, size, sizeStr: `${x.diskGiB}G` }],
      totalAllocated: size, diskUsed: Math.round(size * x.diskUse) }
  }).sort((a, b) => b.totalAllocated - a.totalAllocated)
}

function alerts() {
  return [
    { name: 'DiskFillingUp', severity: 'warning', state: 'firing', node: 'pve-c', summary: 'Disk on minecraft is 72% full and growing', description: 'At the current rate the container disk fills in about 9 days.', firedAt: iso(3 * HOUR) },
  ]
}

function promNodes() {
  return NODES.map(n => ({ node: n.node, cpu: wobble(n.cpu * 100, 4, n.node), memory: n.mem * 100, disk: 34 + seeded(n.node) * 10, load: +(n.cpu * n.cores * 1.1).toFixed(2) }))
}

function cpuRange(q: Record<string, string>) {
  const end = Number(q.end) || Math.floor(Date.now() / 1000), start = Number(q.start) || end - 3600, step = Number(q.step) || 60
  return { resultType: 'matrix', result: NODES.map(n => ({
    metric: { node: n.node },
    values: Array.from({ length: Math.floor((end - start) / step) + 1 }, (_, i) => {
      const t = start + i * step
      return [t, String((n.cpu * 100 + 6 * Math.sin(t / 600 + seeded(n.node) * 6) + 3 * Math.sin(t / 97)).toFixed(2))]
    }),
  })) }
}

function haOverview() {
  const prot = GUESTS.filter(x => x.ha), unprot = GUESTS.filter(x => !x.ha)
  const other = (n: string) => n === 'pve-a' ? 'pve-b' : 'pve-a'
  return {
    cluster: { quorate: true, fencing: 'armed', headline: 'HA is armed: a node that loses contact with the others is restarted (fenced) and its protected guests start elsewhere.',
      detail: ['3 of 3 nodes online, quorate.', `${prot.length} guests are protected by HA.`, 'Fencing uses the hardware watchdog on every node.', 'Static load scheduling (CRS) picks where a guest goes.'] },
    nodes: NODES.map(n => ({ node: n.node, online: true, maintenance: false, haGuests: prot.filter(x => x.node === n.node).length })),
    protected: prot.map(x => ({ sid: sidOf(x), vmid: x.vmid, type: x.type === 'lxc' ? 'ct' : 'vm', name: x.name, node: x.node, state: x.status === 'running' ? 'started' : 'stopped',
      home: `Prefers ${x.node}, but runs anywhere if needed.`, homeless: false, failover: `If ${x.node} fails it will most likely move to ${other(x.node)}.`, to: other(x.node) })),
    unprotected: unprot.map(x => ({ sid: sidOf(x), vmid: x.vmid, type: x.type, name: x.name, node: x.node, status: x.status, words: `Stays down after a failure of ${x.node} until someone starts it.` })),
    homeless: [], hardware: [],
    hardwareNotes: [{ sid: 'ct:301', name: 'plex', node: 'pve-c', words: 'plex (301): If pve-c fails this will run on pve-a without its GPU, so transcoding falls back to the CPU.' }],
    headroom: [],
    rules: [
      { rule: { id: 'media-on-pve-c', resources: ['ct:301', 'ct:302'], disabled: false, order: 1, type: 'node-affinity', affinity: 'positive', strict: false, nodes: [{ node: 'pve-c', priority: 5 }, { node: 'pve-a', priority: 1 }] },
        words: 'plex (301), arr-stack (302): Prefer pve-c, then pve-a.', problems: [] },
      { rule: { id: 'network-core', resources: ['ct:101', 'ct:102', 'ct:205'], disabled: false, order: 2, type: 'node-affinity', affinity: 'positive', strict: false, nodes: [{ node: 'pve-a', priority: 5 }, { node: 'pve-b', priority: 1 }] },
        words: 'proxy (101), adguard (102), wireguard (205): Prefer pve-a, then pve-b.', problems: [] },
    ],
    problems: [], counts: { protected: prot.length, unprotected: unprot.length, homeless: 0, hardware: 0, tightHeadroom: 0 },
  }
}

function tasks() {
  const types = [['vzdump', 'Backup'], ['vzsnapshot', 'Snapshot'], ['qmstart', 'Start'], ['vzmigrate', 'Migrate'], ['aptupdate', 'Update package database']]
  return Array.from({ length: 14 }, (_, i) => {
    const n = NODES[i % 3], [type] = types[i % types.length], x = GUESTS[(i * 5) % GUESTS.length]
    const start = Math.floor((Date.now() - (i + 1) * 47 * MIN) / 1000)
    return { upid: `UPID:${n.node}:000${(4000 + i * 37).toString(16).toUpperCase()}:00${i}:${start.toString(16).toUpperCase()}:${type}:${x.vmid}:root@pam:`, node: n.node, type, id: String(x.vmid), user: 'root@pam',
      starttime: start, endtime: start + 40 + i * 11, status: 'OK' }
  })
}

export const CORE: FixtureRoute[] = [
  { path: '/api/proxmox/summary', get: () => ok(summary()) },
  { path: '/api/proxmox/nodes', get: () => ok(pveNodes()) },
  { path: '/api/proxmox/nodes/:node', get: p => ok({ ...pveNodes().find(n => n.node === p.node), cpuinfo: { model: nodeOf(p.node)?.cpuModel ?? 'CPU', cpus: nodeOf(p.node)?.cores ?? 8, sockets: 1 }, pveversion: 'pve-manager/9.1.2', kversion: 'Linux 6.17.2-1-pve' }) },
  { path: '/api/proxmox/vms', get: () => ok(pveGuests()) },
  { path: '/api/proxmox/resources', get: () => ok([...pveNodes(), ...pveGuests().map(v => ({ ...v, id: `${v.type}/${v.vmid}` }))]) },
  { path: '/api/proxmox/storage', get: () => ok(pveStorage()) },
  { path: '/api/proxmox/ha', get: () => ok(pveHa()) },
  { path: '/api/proxmox/ha/resources', get: () => ok(GUESTS.filter(x => x.ha).map(x => ({ sid: sidOf(x), state: x.status === 'running' ? 'started' : 'stopped', type: x.type === 'lxc' ? 'ct' : 'vm' }))) },
  { path: '/api/proxmox/ceph/status', get: () => ok(cephStatus()) },
  { path: '/api/proxmox/ceph/osds', get: () => ok(cephOsds()) },
  { path: '/api/proxmox/ceph/pools', get: () => ok(cephPools()) },
  { path: '/api/proxmox/nextid', get: () => ok(308) },
  { path: '/api/proxmox/gpu', get: () => ok(gpuStatus()) },
  { path: '/api/proxmox/isos', get: () => ok(['debian-13.1.0-amd64-netinst.iso', 'ubuntu-24.04.3-live-server-amd64.iso', 'Win11_24H2_English_x64.iso', 'TrueNAS-SCALE-25.04.iso'].map(f => ({ volid: `nas-iso:iso/${f}`, format: 'iso', size: Math.round((0.6 + seeded(f) * 5) * GiB), storage: 'nas-iso', node: 'pve-a' }))) },
  { path: '/api/proxmox/templates', get: () => ok(['debian-13-standard_13.1-2_amd64.tar.zst', 'ubuntu-24.04-standard_24.04-2_amd64.tar.zst', 'alpine-3.22-default_20250617_amd64.tar.xz'].map(f => ({ volid: `nas-iso:vztmpl/${f}`, format: 'tzst', size: Math.round(0.12 * GiB), storage: 'nas-iso', node: 'pve-a' }))) },
  { path: '/api/proxmox/nodes/:node/tasks', get: p => ok(tasks().filter(t => t.node === p.node)) },
  { path: '/api/proxmox/ping', get: () => ok({ reachable: true, latencyMs: 2 }) },
  { path: '/api/infra/tasks', get: () => ok(tasks()) },
  { path: '/api/infra/nodes/:node/tasks', get: p => ok(tasks().filter(t => t.node === p.node)) },
  { path: '/api/infra/guest-config/overview', get: () => ok(guestOverview()) },
  { path: '/api/ha/badges', get: () => ok(haBadges()) },
  { path: '/api/ha/overview', get: () => ok(haOverview()) },
  { path: '/api/services/grafana', get: () => ok({ state: 'connected', connected: true, url: 'http://127.0.0.1:3003', message: 'ok', version: '12.2.1' }) },
  { path: '/api/services/prometheus', get: () => ok({ state: 'connected', connected: true, url: 'http://127.0.0.1:9090', message: 'healthy', version: '3.7.3' }) },
  { path: '/api/gpu/all/metrics-status', get: () => ok(gpuStatus()) },
  { path: '/api/gpu', get: () => ok(gpuStatus().flatMap(n => n.gpus)) },
  { path: '/api/gpu/badges', get: () => ok(NODES.map(n => ({ node: n.node, gpus: n.gpu ? [{ vendor: n.gpu.vendor, kind: n.gpu.dedicated ? 'dedicated' : 'integrated', id: `10de:${n.gpu.deviceId}`, name: n.gpu.name }] : [] }))) },
  { path: '/api/network/stats', get: () => ok(networkStats()) },
  { path: '/api/network/bandwidth', get: () => ok(bandwidth()) },
  { path: '/api/prometheus/power', get: () => ok(power()) },
  { path: '/api/prometheus/alerts', get: () => ok(alerts()) },
  { path: '/api/prometheus/nodes', get: () => ok(promNodes()) },
  { path: '/api/prometheus/range', get: (_p, q) => ok(cpuRange(q)) },
  { path: '/api/monitoring/pve-exporter', get: () => ok({ configured: true, tokenId: 'hyperprox@pve!exporter', readOnly: true, reasons: [] }) },
  { path: '/api/targets/status', get: () => ok({
    nodes: NODES.map(n => ({ targets: [`${n.ip}:9100`], labels: { node: n.node } })), pve: NODES.map(n => ({ targets: [n.ip], labels: { node: n.node } })),
    intelGpu: [{ targets: ['10.0.0.12:8081'], labels: { node: 'pve-b' } }], nvidiaGpu: [{ targets: ['10.0.0.13:9835'], labels: { node: 'pve-c' } }],
    ceph: NODES.map(n => ({ targets: [`${n.ip}:9283`], labels: { node: n.node } })) }) },
  { path: '/api/storage/overview', get: () => ok(storageOverview()) },
  { path: '/api/storage/vms-breakdown', get: () => ok(vmsBreakdown()) },
  { path: '/api/storage/ceph/status', get: () => ok(cephStatus()) },
  { path: '/api/storage/ceph/osds', get: () => ok(cephOsds()) },
  { path: '/api/storage/ceph/pools', get: () => ok(cephPools()) },
  { path: '/api/storage/nodes/:node', get: p => ok(pveStorage(p.node)) },
]

export { backupAt }
