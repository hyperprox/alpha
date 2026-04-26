// =============================================================================
//  HyperProx — Proxmox REST API Client
// =============================================================================

import https from 'https'

export interface PVENode {
  node: string; status: string; cpu: number; maxcpu: number
  mem: number; maxmem: number; disk: number; maxdisk: number; uptime: number; level: string
}

export interface PVEVM {
  vmid: number; name: string; status: string; type: 'qemu' | 'lxc'; node: string
  cpu: number; cpus: number; mem: number; maxmem: number; disk: number; maxdisk: number
  uptime: number; netin: number; netout: number; diskread: number; diskwrite: number
  hastate?: string; tags?: string; template?: number
}

export interface PVEStorage {
  storage: string; node: string; type: string; status: string
  total: number; used: number; avail: number; enabled: number; shared: number; plugintype?: string
}

export interface CephOSD {
  id: string; name: string; host: string; status: string; in: number; pgs: number
  percent_used: number; bytes_used: number; total_space: number; device_class: string
  commit_latency_ms: number; apply_latency_ms: number; reweight: number; osdtype: string
}

export interface CephStatus {
  health: { status: string; checks: Record<string, { detail: { message: string }[] }> }
  osdmap: { num_osds: number; num_up_osds: number; num_in_osds: number }
  fsmap:  { up: number; in: number; 'up:standby': number }
  quorum: number[]; quorum_age: number
  pgmap?: { num_pgs: number; num_pools: number; bytes_total: number; bytes_used: number; bytes_avail: number; data_bytes: number }
}

export interface HAStatus {
  id: string; type: string; status: string; node: string; quorate?: number; timestamp?: number
}

export class ProxmoxClient {
  private baseUrl:    string
  private authHeader: string

  constructor(host: string, port: number, tokenId: string, tokenSecret: string) {
    this.baseUrl    = `https://${host}:${port}/api2/json`
    this.authHeader = `PVEAPIToken=${tokenId}=${tokenSecret}`
  }

  fetchNode<T>(path: string, method = 'GET', body?: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const url  = new URL(`${this.baseUrl}${path}`)
      const opts: https.RequestOptions = {
        hostname: url.hostname, port: url.port,
        path: url.pathname + url.search, method,
        rejectUnauthorized: false,
        headers: {
          Authorization: this.authHeader,
          ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      }
      const req = https.request(opts, (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          try { resolve((JSON.parse(data) as { data: T }).data) }
          catch (e) { reject(new Error(`Parse error on ${path}: ${data.slice(0, 200)}`)) }
        })
      })
      req.on('error', reject)
      if (body) req.write(body)
      req.end()
    })
  }

  async ping() {
    try {
      const s = await this.fetchNode<any[]>('/cluster/status')
      return { ok: true, cluster: s.find(x => x.type === 'cluster')?.name }
    } catch (e: any) { return { ok: false, error: e.message } }
  }

  async getNodes()                  { return this.fetchNode<PVENode[]>('/nodes') }
  async getNodeStatus(node: string) { return this.fetchNode<any>(`/nodes/${node}/status`) }

  async getClusterResources(type?: string) {
    return this.fetchNode<any[]>(type ? `/cluster/resources?type=${type}` : '/cluster/resources')
  }

  async getQemuVMs(node: string): Promise<PVEVM[]> {
    const v = await this.fetchNode<any[]>(`/nodes/${node}/qemu`)
    return v.map(x => ({ ...x, type: 'qemu' as const, node }))
  }

  async getLXCs(node: string): Promise<PVEVM[]> {
    const v = await this.fetchNode<any[]>(`/nodes/${node}/lxc`)
    return v.map(x => ({ ...x, type: 'lxc' as const, node }))
  }

  async getAllVMs(): Promise<PVEVM[]> {
    const nodes = await this.getNodes()
    const r = await Promise.allSettled(nodes.map(async n => {
      const [vms, cts] = await Promise.all([this.getQemuVMs(n.node), this.getLXCs(n.node)])
      return [...vms, ...cts]
    }))
    return r.filter(x => x.status === 'fulfilled').flatMap(x => (x as any).value)
  }

  async vmAction(node: string, vmid: number, type: 'qemu' | 'lxc', action: 'start' | 'stop' | 'reboot' | 'shutdown') {
    return this.fetchNode<string>(`/nodes/${node}/${type}/${vmid}/status/${action}`, 'POST')
  }

  async getVMConfig(node: string, vmid: number, type: 'qemu' | 'lxc') {
    return this.fetchNode<any>(`/nodes/${node}/${type}/${vmid}/config`)
  }

  async updateVMConfig(node: string, vmid: number, type: 'qemu' | 'lxc', config: Record<string, any>) {
    await this.fetchNode(`/nodes/${node}/${type}/${vmid}/config`, 'PUT', JSON.stringify(config))
  }

  async getVNCTicket(node: string, vmid: number, type: 'qemu' | 'lxc'): Promise<{
    ticket: string; port: string; cert: string; user: string
  }> {
    return this.fetchNode(`/nodes/${node}/${type}/${vmid}/vncproxy`, 'POST')
  }

  async getSnapshots(node: string, vmid: number, type: 'qemu' | 'lxc') {
    return this.fetchNode<any[]>(`/nodes/${node}/${type}/${vmid}/snapshot`)
  }

  async createSnapshot(node: string, vmid: number, type: 'qemu' | 'lxc', name: string, description = '') {
    return this.fetchNode<string>(`/nodes/${node}/${type}/${vmid}/snapshot`, 'POST',
      JSON.stringify({ snapname: name, description }))
  }

  async deleteSnapshot(node: string, vmid: number, type: 'qemu' | 'lxc', snapname: string) {
    return this.fetchNode<string>(`/nodes/${node}/${type}/${vmid}/snapshot/${snapname}`, 'DELETE')
  }

  async rollbackSnapshot(node: string, vmid: number, type: 'qemu' | 'lxc', snapname: string) {
    return this.fetchNode<string>(`/nodes/${node}/${type}/${vmid}/snapshot/${snapname}/rollback`, 'POST')
  }

  async migrateVM(node: string, vmid: number, type: 'qemu' | 'lxc', target: string, online = true) {
    return this.fetchNode<string>(`/nodes/${node}/${type}/${vmid}/migrate`, 'POST',
      JSON.stringify({ target, online: online ? 1 : 0 }))
  }

  async getStorage(node: string): Promise<PVEStorage[]> {
    const s = await this.fetchNode<any[]>(`/nodes/${node}/storage`)
    return s.map(x => ({ ...x, node }))
  }

  async getAllStorage(): Promise<PVEStorage[]> {
    const nodes = await this.getNodes()
    const r = await Promise.allSettled(nodes.map(n => this.getStorage(n.node)))
    return r.filter(x => x.status === 'fulfilled').flatMap(x => (x as any).value)
  }

  async getCephStatus(node: string)  { return this.fetchNode<CephStatus>(`/nodes/${node}/ceph/status`) }
  async getCephPools(node: string)   { return this.fetchNode<any[]>(`/nodes/${node}/ceph/pools`) }

  async getCephOSDs(node: string): Promise<CephOSD[]> {
    const data = await this.fetchNode<any>(`/nodes/${node}/ceph/osd`)
    const osds: CephOSD[] = []
    const flatten = (n: any) => {
      if (!n) return
      if (n.type === 'osd' && n.leaf === 1) osds.push({
        id: n.id, name: n.name, host: n.host, status: n.status, in: n.in, pgs: n.pgs,
        percent_used: n.percent_used, bytes_used: n.bytes_used, total_space: n.total_space,
        device_class: n.device_class, commit_latency_ms: n.commit_latency_ms,
        apply_latency_ms: n.apply_latency_ms, reweight: n.reweight, osdtype: n.osdtype,
      })
      if (n.children) n.children.forEach(flatten)
    }
    if (data && data.root) flatten(data.root)
    return osds.sort((a, b) => Number(a.id) - Number(b.id))
  }

  async getHAStatus()    { return this.fetchNode<HAStatus[]>('/cluster/ha/status/current') }
  async getHAResources() { return this.fetchNode<any[]>('/cluster/ha/resources') }

  async setHAState(sid: string, state: 'started' | 'stopped' | 'disabled') {
    await this.fetchNode(`/cluster/ha/resources/${encodeURIComponent(sid)}`, 'PUT',
      JSON.stringify({ state }))
  }

  async getNodeTasks(node: string, limit = 20) {
    return this.fetchNode<any[]>(`/nodes/${node}/tasks?limit=${limit}`)
  }

  async getClusterTasks() { return this.fetchNode<any[]>('/cluster/tasks') }

  // ---------------------------------------------------------------------------
  //  VM/CT storage breakdown — parses disk config to extract pool + size
  // ---------------------------------------------------------------------------

  async getVMStorageBreakdown(): Promise<Array<{
    vmid:    number
    name:    string
    type:    'qemu' | 'lxc'
    node:    string
    status:  string
    disks:   Array<{ key: string; storage: string; size: number; sizeStr: string }>
    totalAllocated: number
    diskUsed: number
  }>> {
    const vms = await this.getAllVMs()

    function parseSize(sizeStr: string): number {
      const m = sizeStr.match(/(\d+(?:\.\d+)?)\s*([KMGT]?)/)
      if (!m) return 0
      const n = parseFloat(m[1])
      const u = m[2]
      if (u === 'T') return n * 1024 * 1024 * 1024 * 1024
      if (u === 'G') return n * 1024 * 1024 * 1024
      if (u === 'M') return n * 1024 * 1024
      if (u === 'K') return n * 1024
      return n
    }

    function extractDisks(config: Record<string, any>, type: 'qemu' | 'lxc') {
      const disks: Array<{ key: string; storage: string; size: number; sizeStr: string }> = []
      const diskKeys = type === 'lxc'
        ? Object.keys(config).filter(k => k === 'rootfs' || k.match(/^mp\d+$/))
        : Object.keys(config).filter(k => k.match(/^(scsi|virtio|sata|ide)\d+$/))

      for (const key of diskKeys) {
        const val = config[key] as string
        if (!val || val.includes('media=cdrom') || val.includes('none')) continue

        // Format: "storage:vm-ID-disk-N,size=XG" or "storage:SIZE"
        const storageMatch = val.match(/^([^:]+):/)
        const sizeMatch    = val.match(/size=(\d+(?:\.\d+)?[KMGT]?)/)

        if (!storageMatch) continue
        const storage = storageMatch[1]
        const sizeStr = sizeMatch ? sizeMatch[1] : '0'
        const size    = parseSize(sizeStr)

        disks.push({ key, storage, size, sizeStr })
      }
      return disks
    }

    const results = await Promise.allSettled(
      vms.filter(v => v.template !== 1).map(async vm => {
        try {
          const config = await this.getVMConfig(vm.node, vm.vmid, vm.type)
          const disks  = extractDisks(config, vm.type)
          const totalAllocated = disks.reduce((s, d) => s + d.size, 0)
          return {
            vmid:   vm.vmid,
            name:   vm.name,
            type:   vm.type,
            node:   vm.node,
            status: vm.status,
            disks,
            totalAllocated,
            diskUsed: vm.disk ?? 0,
          }
        } catch {
          return {
            vmid:   vm.vmid,
            name:   vm.name,
            type:   vm.type,
            node:   vm.node,
            status: vm.status,
            disks:  [],
            totalAllocated: vm.maxdisk ?? 0,
            diskUsed: vm.disk ?? 0,
          }
        }
      })
    )

    return results
      .filter(r => r.status === 'fulfilled')
      .map(r => (r as any).value)
      .sort((a, b) => b.totalAllocated - a.totalAllocated)
  }

}