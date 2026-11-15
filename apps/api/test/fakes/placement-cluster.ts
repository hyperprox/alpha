// A fixture cluster for the placement advisor: one big node (24 threads, a GPU, local media) and two small ones
// (4 threads each), served as the Proxmox API answers it. Guests cover every reason a guest stays put:
//   ct:101 media    node1  HA, strict rule to node1, NVIDIA GPU lines, a plain bind mount
//   ct:102 web      node2  HA, non-strict rule preferring node2 then node3
//   vm:103 big      node1  8 vCPUs, cpu=host
//   vm:104 app      node3  x86-64-v3, a 32 GiB disk on node-local storage
//   ct:105 tools    node2  a shared=1 bind mount
//   vm:106 tmpl     node3  a template
//   ct:107 worker   node1  nothing ties it: free to move
//   ct:108 hafree   node2  HA with no rule

const G = 1024 ** 3
const FLAGS_AMD = 'fpu sse4_1 sse4_2 ssse3 cx16 lahf_lm popcnt aes avx avx2 bmi1 bmi2 f16c fma movbe xsave'
const FLAGS_INTEL = 'fpu sse4_1 sse4_2 ssse3 cx16 lahf_lm popcnt aes avx avx2 bmi1 bmi2 f16c fma movbe xsave'

export function placementFixture(): Record<string, any> {
  const vm = (vmid: number, type: 'lxc' | 'qemu', name: string, node: string, o: Record<string, any> = {}) => ({
    id: `${type}/${vmid}`, vmid, type, name, node, status: 'running', maxcpu: 2, cpu: 0.1, mem: 1 * G, maxmem: 2 * G, template: 0, ...o,
  })
  const f: Record<string, any> = {
    '/cluster/resources?type=vm': [
      vm(101, 'lxc', 'media', 'node1', { maxcpu: 4, hastate: 'started' }),
      vm(102, 'lxc', 'web', 'node2', { hastate: 'started' }),
      vm(103, 'qemu', 'big', 'node1', { maxcpu: 8, maxmem: 8 * G, mem: 4 * G }),
      vm(104, 'qemu', 'app', 'node3', { mem: 2 * G, maxmem: 4 * G }),
      vm(105, 'lxc', 'tools', 'node2', { maxcpu: 1 }),
      vm(106, 'qemu', 'tmpl', 'node3', { status: 'stopped', template: 1, mem: 0 }),
      vm(107, 'lxc', 'worker', 'node1'),
      vm(108, 'lxc', 'hafree', 'node2', { hastate: 'started' }),
    ],
    '/cluster/ha/resources': [
      { sid: 'ct:101', state: 'started', digest: 'd1' }, { sid: 'ct:102', state: 'started' }, { sid: 'ct:108', state: 'started' },
    ],
    '/cluster/ha/rules': [
      { rule: 'gpu-lock', type: 'node-affinity', nodes: 'node1', strict: 1, resources: 'ct:101', digest: 'r1' },
      { rule: 'web-home', type: 'node-affinity', nodes: 'node2:2,node3:1', strict: 0, resources: 'ct:102' },
    ],
    '/cluster/ha/status/current': [
      { type: 'quorum', id: 'quorum', quorate: 1 }, { type: 'master', node: 'node1' }, { type: 'fencing', 'armed-state': 'armed' },
      { type: 'service', sid: 'ct:101', node: 'node1', state: 'started' }, { type: 'service', sid: 'ct:102', node: 'node2', state: 'started' },
      { type: 'service', sid: 'ct:108', node: 'node2', state: 'started' },
    ],
    '/cluster/ha/status/manager_status': null,
    '/nodes': [
      { node: 'node1', status: 'online', cpu: 0.3, maxcpu: 24, mem: 30 * G, maxmem: 96 * G },
      { node: 'node2', status: 'online', cpu: 0.2, maxcpu: 4, mem: 6 * G, maxmem: 16 * G },
      { node: 'node3', status: 'online', cpu: 0.2, maxcpu: 4, mem: 6 * G, maxmem: 16 * G },
    ],
    '/cluster/resources?type=storage': [
      ...['node1', 'node2', 'node3'].flatMap(n => [
        { storage: 'shared-rbd', node: n, shared: 1, status: 'available' },
        { storage: 'local-lvm', node: n, shared: 0, status: 'available' },
      ]),
      { storage: 'media-local', node: 'node1', shared: 0, status: 'available' },
    ],
    '/cluster/options': { crs: { ha: 'dynamic', 'ha-auto-rebalance': 1, 'ha-rebalance-on-start': 1 } },
    '/cluster/tasks': [],
    '/cluster/config/nodes': [
      { node: 'node1', ring0_addr: '192.0.2.11' }, { node: 'node2', ring0_addr: '192.0.2.12' }, { node: 'node3', ring0_addr: '192.0.2.13' },
    ],
    '/cluster/backup': [{ id: 'nightly', type: 'vzdump', schedule: '02:00', enabled: 1 }],
    '/cluster/status': [
      { type: 'cluster', name: 'lab' },
      { type: 'node', name: 'node1', ip: '192.0.2.11' }, { type: 'node', name: 'node2', ip: '192.0.2.12' }, { type: 'node', name: 'node3', ip: '192.0.2.13' },
    ],
    '/nodes/node1/status': { cpuinfo: { model: 'AMD Example 24-thread CPU', vendor: 'AuthenticAMD', cpus: 24, flags: FLAGS_AMD } },
    '/nodes/node2/status': { cpuinfo: { model: 'Intel Example 4-thread CPU', vendor: 'GenuineIntel', cpus: 4, flags: FLAGS_INTEL } },
    '/nodes/node3/status': { cpuinfo: { model: 'Intel Example 4-thread CPU', vendor: 'GenuineIntel', cpus: 4, flags: FLAGS_INTEL } },
    '/nodes/node1/time': { timezone: 'UTC' },
    // configs
    '/nodes/node1/lxc/101/config': {
      cores: 4, memory: 2048, rootfs: 'shared-rbd:vm-101-disk-0,size=8G', mp0: '/mnt/media,mp=/media',
      lxc: [['lxc.cgroup2.devices.allow', 'c 195:* rwm'], ['lxc.mount.entry', '/dev/nvidia0 dev/nvidia0 none bind,create=file']],
    },
    '/nodes/node2/lxc/102/config': { cores: 2, memory: 2048, rootfs: 'shared-rbd:vm-102-disk-0,size=8G' },
    '/nodes/node1/qemu/103/config': { cores: 8, sockets: 1, memory: 8192, cpu: 'host', scsi0: 'shared-rbd:vm-103-disk-0,size=64G' },
    '/nodes/node3/qemu/104/config': { cores: 2, memory: 4096, cpu: 'x86-64-v3', scsi0: 'local-lvm:vm-104-disk-0,size=32G' },
    '/nodes/node2/lxc/105/config': { cores: 1, memory: 1024, rootfs: 'shared-rbd:vm-105-disk-0,size=4G', mp0: '/mnt/shared,mp=/shared,shared=1' },
    '/nodes/node3/qemu/106/config': { cores: 2, memory: 2048, template: 1, scsi0: 'shared-rbd:base-106-disk-0,size=10G' },
    '/nodes/node1/lxc/107/config': { cores: 2, memory: 2048, rootfs: 'shared-rbd:vm-107-disk-0,size=8G' },
    '/nodes/node2/lxc/108/config': { cores: 2, memory: 2048, rootfs: 'shared-rbd:vm-108-disk-0,size=8G' },
  }
  for (const x of f['/cluster/resources?type=vm'] as any[]) f[`/nodes/${x.node}/${x.type}/${x.vmid}/migrate`] = {}
  return f
}

/** A fake Proxmox: GETs from the fixture, every write recorded and answered by `onWrite`. */
export function fakePve(fixture: Record<string, any>, onWrite: (method: string, path: string, body: string) => any = () => null) {
  const writes: Array<{ method: string; path: string; body: string }> = []
  const reads: string[] = []
  return {
    writes, reads, fixture,
    async fetchStrict<T>(path: string, method = 'GET', body = ''): Promise<T> {
      if (method !== 'GET') { writes.push({ method, path, body }); return onWrite(method, path, body) as T }
      reads.push(path)
      if (/\/tasks\/[^/]+\/status$/.test(path)) return (fixture[path] ?? { status: 'stopped', exitstatus: 'OK' }) as T
      if (/\/tasks\/[^/]+\/log/.test(path)) return (fixture[path] ?? []) as T
      if (!(path in fixture)) throw new Error(`Proxmox GET ${path}: HTTP 500`)
      return fixture[path] as T
    },
  }
}
