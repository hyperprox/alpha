// =============================================================================
//  HyperProx — Proxmox REST API Client
// =============================================================================

import https from 'https'
import { homeTlsAgent } from './home-tls'

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

export interface CephMon {
  name: string; host?: string; addr?: string; rank?: number
  quorum?: number | boolean; state?: string; service?: boolean
  ceph_version?: string; ceph_version_short?: string
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

const DEFAULT_TIMEOUT_MS = 20_000

/**
 * One URL path segment from a value (a node, a guest id, a snapshot name, a storage). Encoded, so a "/", "?" or
 * "#" inside it can never become a second segment or a query, and "." / ".." are refused because the URL parser
 * would resolve them. Every value put into a Proxmox path goes through this.
 */
export function seg(v: string | number): string {
  const s = String(v ?? '')
  if (s === '' || s === '.' || s === '..') throw new Error(`Refused: "${s}" is not a valid Proxmox path part.`)
  return encodeURIComponent(s)
}

/** The path must not walk up or hide a fragment; checked again on the final string as a second line. */
export function assertSafeApiPath(path: string): void {
  const pathPart = path.split('?')[0]
  if (pathPart.split('/').some(p => p === '.' || p === '..') || /[#\\]/.test(pathPart)) throw new Error(`Refused: unsafe Proxmox path ${pathPart}`)
}

export class ProxmoxClient {
  private baseUrl:    string
  private authHeader: string
  private agent:      https.Agent

  /**
   * `opts.agent`: how the connection is made. A remote cluster passes a PinnedAgent (lib/clusters/tls-pin.ts),
   * which accepts only the certificate the owner confirmed. Without one, the home cluster's: a certificate that
   * verifies normally, or the one pinned for that address (on first use if none is yet; lib/home-tls.ts).
   */
  constructor(host: string, port: number, tokenId: string, tokenSecret: string, opts: { agent?: https.Agent } = {}) {
    // An IPv6 address needs brackets in a URL.
    const h = typeof host === 'string' && host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
    this.baseUrl    = `https://${h}:${port}/api2/json`
    this.authHeader = `PVEAPIToken=${tokenId}=${tokenSecret}`
    this.agent      = opts.agent ?? homeTlsAgent()
  }

  /**
   * The `data` of a Proxmox answer, whatever the HTTP status. PVE answers most
   * errors as {"data":null}, so a caller that cannot tell "nothing" from
   * "failed" should use fetchStrict instead. Kept as it is for the many callers
   * that already guard against null.
   */
  fetchNode<T>(path: string, method = 'GET', body?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    return this.request<T>(path, method, body, timeoutMs).then(r => r.data)
  }

  /** Like fetchNode, but a non-2xx answer (or a timeout) rejects with Proxmox's own reason. */
  async fetchStrict<T>(path: string, method = 'GET', body?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const r = await this.request<T>(path, method, body, timeoutMs)
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`Proxmox ${method} ${path}: HTTP ${r.status}${r.message ? ` — ${r.message}` : ''}`)
    }
    return r.data
  }

  private request<T>(path: string, method: string, body: string | undefined, timeoutMs: number): Promise<{ status: number; data: T; message?: string }> {
    return new Promise((resolveP, rejectP) => {
      // Exactly one outcome, whichever way the request ends. Listening only for the body's 'end' left a
      // promise pending forever when a connection was cut mid-answer: no event, no timer, no handle.
      let settled = false
      const resolve = (v: { status: number; data: T; message?: string }) => { if (!settled) { settled = true; resolveP(v) } }
      const reject  = (e: Error) => { if (!settled) { settled = true; rejectP(e) } }
      try { assertSafeApiPath(path) } catch (e) { return reject(e as Error) }
      const url  = new URL(`${this.baseUrl}${path}`)
      const opts: https.RequestOptions = {
        hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port,
        path: url.pathname + url.search, method,
        // Never an unverified connection: the agent checks the certificate before the request is written.
        agent: this.agent,
        headers: {
          Authorization: this.authHeader,
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      }
      const req = https.request(opts, (res) => {
        let data = ''
        res.on('error', reject)
        res.on('aborted', () => reject(new Error(`Proxmox ${method} ${path}: the connection closed mid-answer`)))
        res.on('close', () => reject(new Error(`Proxmox ${method} ${path}: the connection closed before the answer finished`)))
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          const status = res.statusCode ?? 0
          try {
            const j = JSON.parse(data) as { data: T; message?: string; errors?: unknown }
            const message = j.message ?? (j.errors ? JSON.stringify(j.errors) : res.statusMessage)
            resolve({ status, data: j.data, message: typeof message === 'string' ? message.trim() : undefined })
          } catch {
            // Non-JSON error bodies (a proxy's HTML page, say) still carry a status worth reporting.
            if (status >= 300) resolve({ status, data: null as T, message: res.statusMessage })
            else reject(new Error(`Parse error on ${path}: ${data.slice(0, 200)}`))
          }
        })
      })
      // A hung request must fail, not stall whatever is waiting on it.
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`Proxmox ${method} ${path}: no answer within ${Math.round(timeoutMs / 1000)}s`)))
      req.on('error', reject)
      req.on('close', () => reject(new Error(`Proxmox ${method} ${path}: the connection closed without an answer`)))
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
  async getNodeStatus(node: string) { return this.fetchNode<any>(`/nodes/${seg(node)}/status`) }

  /** Read-only: the certificates pveproxy has on this node (the root CA, pve-ssl.pem, and pveproxy-ssl.pem if one is installed). */
  async getNodeCertificates(node: string): Promise<Array<{
    filename: string; issuer: string; subject: string; notbefore: number; notafter: number
    san?: string[]; fingerprint?: string; 'public-key-type'?: string; 'public-key-bits'?: number; pem?: string
  }>> {
    return this.fetchStrict(`/nodes/${encodeURIComponent(node)}/certificates/info`)
  }

  async getClusterResources(type?: string) {
    return this.fetchNode<any[]>(type ? `/cluster/resources?type=${encodeURIComponent(type)}` : '/cluster/resources')
  }

  async getQemuVMs(node: string): Promise<PVEVM[]> {
    const v = await this.fetchNode<any[]>(`/nodes/${seg(node)}/qemu`)
    return v.map(x => ({ ...x, type: 'qemu' as const, node }))
  }

  async getLXCs(node: string): Promise<PVEVM[]> {
    const v = await this.fetchNode<any[]>(`/nodes/${seg(node)}/lxc`)
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
    return this.fetchStrict<string>(`/nodes/${seg(node)}/${seg(type)}/${seg(vmid)}/status/${action}`, 'POST')
  }

  async getVMConfig(node: string, vmid: number, type: 'qemu' | 'lxc') {
    return this.fetchNode<any>(`/nodes/${seg(node)}/${seg(type)}/${seg(vmid)}/config`)
  }

  async getSnapshots(node: string, vmid: number, type: 'qemu' | 'lxc') {
    return this.fetchNode<any[]>(`/nodes/${seg(node)}/${seg(type)}/${seg(vmid)}/snapshot`)
  }

  async createSnapshot(node: string, vmid: number, type: 'qemu' | 'lxc', name: string, description = '') {
    // Form-encoded, as Proxmox reads it (a JSON body is refused with a 400); strict so the refusal reaches the caller.
    const body = new URLSearchParams({ snapname: name })
    if (description) body.set('description', description)
    return this.fetchStrict<string>(`/nodes/${seg(node)}/${seg(type)}/${seg(vmid)}/snapshot`, 'POST', body.toString())
  }

  async deleteSnapshot(node: string, vmid: number, type: 'qemu' | 'lxc', snapname: string) {
    return this.fetchStrict<string>(`/nodes/${seg(node)}/${seg(type)}/${seg(vmid)}/snapshot/${seg(snapname)}`, 'DELETE')
  }

  async rollbackSnapshot(node: string, vmid: number, type: 'qemu' | 'lxc', snapname: string) {
    return this.fetchStrict<string>(`/nodes/${seg(node)}/${seg(type)}/${seg(vmid)}/snapshot/${seg(snapname)}/rollback`, 'POST')
  }

  async migrateVM(node: string, vmid: number, type: 'qemu' | 'lxc', target: string, online = true) {
    // PVE rejects `online` for containers; a running LXC moves with `restart=1` (stop, move, start on the target).
    const body = new URLSearchParams({ target })
    if (type === 'lxc') body.set('restart', '1')
    else body.set('online', online ? '1' : '0')
    return this.fetchStrict<string>(`/nodes/${seg(node)}/${seg(type)}/${seg(vmid)}/migrate`, 'POST', body.toString())
  }

  async getStorage(node: string): Promise<PVEStorage[]> {
    const s = await this.fetchNode<any[]>(`/nodes/${seg(node)}/storage`)
    return s.map(x => ({ ...x, node }))
  }

  async getAllStorage(): Promise<PVEStorage[]> {
    const nodes = await this.getNodes()
    const r = await Promise.allSettled(nodes.map(n => this.getStorage(n.node)))
    return r.filter(x => x.status === 'fulfilled').flatMap(x => (x as any).value)
  }

  async getCephStatus(node: string)  { return this.fetchNode<CephStatus>(`/nodes/${seg(node)}/ceph/status`) }

  // Cluster-scoped, and per PVE's own schema identical to the node-level alias —
  // so status needs no monitor node at all.
  async getClusterCephStatus()       { return this.fetchNode<CephStatus>('/cluster/ceph/status') }

  // The endpoint is 'pool', singular. '/ceph/pools' returns HTTP 501 and has
  // never worked; it only looked fine because fetchNode resolves errors as null.
  async getCephPools(node: string)   { return this.fetchNode<any[]>(`/nodes/${seg(node)}/ceph/pool`) }

  // Cluster-wide despite the path: any online node returns every monitor.
  async getCephMons(node: string)    { return this.fetchNode<CephMon[]>(`/nodes/${seg(node)}/ceph/mon`) }

  async getCephOSDs(node: string): Promise<CephOSD[]> {
    const data = await this.fetchNode<any>(`/nodes/${seg(node)}/ceph/osd`)
    // fetchNode does not check the HTTP status and PVE returns errors as
    // {"data":null}. Without this guard a failed call renders as "0 OSDs" —
    // a lie rather than an error.
    if (!data || !data.root) throw new Error(`No CEPH OSD tree returned by node '${node}'`)
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
    flatten(data.root)
    return osds.sort((a, b) => Number(a.id) - Number(b.id))
  }

  async getHAStatus()    { return this.fetchNode<HAStatus[]>('/cluster/ha/status/current') }
  async getHAResources() { return this.fetchNode<any[]>('/cluster/ha/resources') }

  async setHAState(sid: string, state: 'started' | 'stopped' | 'disabled') {
    await this.fetchStrict(`/cluster/ha/resources/${encodeURIComponent(sid)}`, 'PUT',
      new URLSearchParams({ state }).toString())
  }

  async getNodeTasks(node: string, limit = 20) {
    return this.fetchNode<any[]>(`/nodes/${seg(node)}/tasks?limit=${Number(limit) | 0}`)
  }

  async getClusterTasks() { return this.fetchNode<any[]>('/cluster/tasks') }

  // ---------------------------------------------------------------------------
  //  VM/CT storage breakdown — parses disk config to extract pool + size
  // ---------------------------------------------------------------------------

  async getNextVMID(): Promise<number> {
    const r = await this.fetchNode<{ data: number }>('/cluster/nextid')
    return r.data ?? r
  }

  async getTemplates(): Promise<Array<{ node: string; storage: string; volid: string; name: string; size: number; ctime: number }>> {
    const nodes = await this.getNodes()
    const results: any[] = []
    await Promise.allSettled(nodes.map(async (n: any) => {
      const storages = await this.getStorage(n.node)
      const templateStorages = storages.filter((s: any) => s.content?.includes('vztmpl'))
      await Promise.allSettled(templateStorages.map(async (s: any) => {
        try {
          const content = await this.fetchNode<any[]>(`/nodes/${seg(n.node)}/storage/${seg(s.storage)}/content?content=vztmpl`)
          const items = Array.isArray(content) ? content : (content as any).data ?? []
          items.forEach((t: any) => {
            const name = t.volid?.split('/').pop()?.replace(/\.tar\.(gz|zst|xz)$/, '') ?? t.volid
            results.push({ node: n.node, storage: s.storage, volid: t.volid, name, size: t.size, ctime: t.ctime })
          })
        } catch {}
      }))
    }))
    // Deduplicate by volid
    const seen = new Set()
    return results.filter(t => { if (seen.has(t.volid)) return false; seen.add(t.volid); return true })
  }

  async createLXC(node: string, params: {
    vmid: number
    hostname: string
    ostemplate: string
    storage: string
    rootfs_size: number
    memory: number
    swap?: number
    cores: number
    net0?: string
    description?: string
    password?: string
    ssh_public_keys?: string
    start?: boolean
    unprivileged?: boolean
    features?: string
    onboot?: boolean
  }) {
    const body: Record<string, any> = {
      vmid:         params.vmid,
      hostname:     params.hostname,
      ostemplate:   params.ostemplate,
      storage:      params.storage,
      rootfs:       `${params.storage}:${params.rootfs_size}`,
      memory:       params.memory,
      swap:         params.swap ?? 512,
      cores:        params.cores,
      net0:         params.net0 ?? 'name=eth0,bridge=vmbr0,ip=dhcp',
      unprivileged: params.unprivileged ? 1 : 0,
      start:        params.start ? 1 : 0,
    }
    if (params.password)        body.password = params.password
    if (params.ssh_public_keys) body.ssh_public_keys = params.ssh_public_keys
    if (params.features)        body.features = params.features
    if (params.onboot !== undefined) body.onboot = params.onboot ? 1 : 0
    if (params.description)     body.description = params.description
    const lxcParams = new URLSearchParams(); Object.entries(body).forEach(([k,v]) => lxcParams.append(k, String(v)))
    // Strict: a refusal (bad rootfs, vmid taken, no such template) must reach the caller as Proxmox's own
    // words. fetchNode resolved it as null, and the wizard then waited ninety seconds for a container
    // that was never going to exist. The answer is the task's UPID; see waitForTask.
    return this.fetchStrict<string>(`/nodes/${seg(node)}/lxc`, 'POST', lxcParams.toString())
  }

  /**
   * Wait for a Proxmox task to finish and say why if it did not succeed. Polls the task status rather than
   * the guest, so a failed create reports its own log tail instead of timing out on a guest that is not there.
   */
  async waitForTask(
    node: string, upid: string,
    opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<void> {
    const timeoutMs  = opts.timeoutMs  ?? 120_000
    const intervalMs = opts.intervalMs ?? 2_000
    const sleep      = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
    const base       = `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}`

    const tail = async (): Promise<string> => {
      const log = await this.fetchNode<Array<{ n: number; t: string }>>(`${base}/log?limit=500`).catch(() => null)
      return (Array.isArray(log) ? log : []).slice(-8).map(l => l.t).join('\n')
    }

    for (let waited = 0; ; waited += intervalMs) {
      const st = await this.fetchStrict<{ status: string; exitstatus?: string }>(`${base}/status`)
      if (st?.status === 'stopped') {
        if (st.exitstatus === 'OK') return
        const log = await tail()
        throw new Error(`Proxmox task failed (${st.exitstatus ?? 'unknown'})${log ? `:\n${log}` : ''}`)
      }
      if (waited >= timeoutMs) {
        const log = await tail()
        throw new Error(`Proxmox task still running after ${Math.round(timeoutMs / 1000)}s${log ? `:\n${log}` : ''}`)
      }
      await sleep(intervalMs)
    }
  }

  async createVM(node: string, params: {
    vmid: number
    name: string
    memory: number
    cores: number
    sockets?: number
    storage: string
    disk_size: number
    iso?: string
    net0?: string
    start?: boolean
    ostype?: string
  }) {
    const body: Record<string, any> = {
      vmid:    params.vmid,
      name:    params.name,
      memory:  params.memory,
      cores:   params.cores,
      sockets: params.sockets ?? 1,
      ostype:  params.ostype ?? 'l26',
      net0:    params.net0 ?? 'virtio,bridge=vmbr0',
      scsihw:  'virtio-scsi-pci',
      scsi0:   `${params.storage}:${params.disk_size}`,
      ide2:    params.iso ? `${params.iso},media=cdrom` : 'none,media=cdrom',
      boot:    'order=scsi0;ide2',
      agent:   1,
      start:   params.start ? 1 : 0,
    }
    const vmParams = new URLSearchParams(); Object.entries(body).forEach(([k,v]) => vmParams.append(k, String(v))); return this.fetchStrict(`/nodes/${seg(node)}/qemu`, 'POST', vmParams.toString())
  }

  async getISOs(): Promise<Array<{ node: string; storage: string; volid: string; name: string; size: number }>> {
    const nodes = await this.getNodes()
    const results: any[] = []
    await Promise.allSettled(nodes.map(async (n: any) => {
      const storages = await this.getStorage(n.node)
      const isoStorages = storages.filter((s: any) => s.content?.includes('iso') && s.active === 1)
      await Promise.allSettled(isoStorages.map(async (s: any) => {
        try {
          const content = await this.fetchNode<any[]>(`/nodes/${seg(n.node)}/storage/${seg(s.storage)}/content?content=iso`)
          const items = Array.isArray(content) ? content : (content as any).data ?? []
          items.forEach((t: any) => {
            const name = t.volid?.split('/').pop() ?? t.volid
            results.push({ node: n.node, storage: s.storage, volid: t.volid, name, size: t.size })
          })
        } catch {}
      }))
    }))
    const seen = new Set()
    return results.filter(t => { if (seen.has(t.volid)) return false; seen.add(t.volid); return true })
  }

  async getDownloadableTemplates(node: string): Promise<any[]> {
    try {
      const data = await this.fetchNode<any[]>(`/nodes/${seg(node)}/aplinfo`)
      return Array.isArray(data) ? data : (data as any).data ?? []
    } catch { return [] }
  }

  async downloadTemplate(node: string, storage: string, template: string): Promise<any> {
    const params = new URLSearchParams()
    params.append('storage', storage)
    params.append('template', template)
    // The appliance-info endpoint is where Proxmox takes template downloads (POST /aplinfo), and it answers
    // with a task id to wait on. Strict, so a refused download says why.
    return this.fetchStrict<string>(`/nodes/${encodeURIComponent(node)}/aplinfo`, 'POST', params.toString())
  }

  async deleteLXC(node: string, vmid: number): Promise<any> {
    return this.fetchStrict(`/nodes/${seg(node)}/lxc/${seg(vmid)}`, 'DELETE')
  }

  async deleteVM(node: string, vmid: number): Promise<any> {
    return this.fetchStrict(`/nodes/${seg(node)}/qemu/${seg(vmid)}`, 'DELETE')
  }

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