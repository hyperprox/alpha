// A fake Proxmox for the HA tests: the HA endpoints with PVE 9.2's behaviour where it matters to us.
// It keeps resources and rules, answers status, enforces `digest` on sets, refuses a rule naming a
// guest that is not HA-managed (as PVE does), applies purge=1 on resource delete, and records every
// call so a test can assert that a refused preview sent nothing.

import { createHash } from 'node:crypto'

export interface FakeNode { node: string; status?: 'online' | 'offline'; mem?: number; maxmem?: number; cpu?: number; maxcpu?: number; maintenance?: boolean }
export interface FakeGuest { vmid: number; type: 'lxc' | 'qemu'; node: string; name?: string; status?: string; maxmem?: number; maxcpu?: number; template?: number; config?: Record<string, unknown> }

const GiB = 1024 ** 3

export class FakeHaPve {
  nodes: FakeNode[]
  guests: FakeGuest[]
  resources: any[] = []
  rules: any[] = []
  quorate = true
  fencing = 'armed'
  crs = 'ha=basic'
  storage: Array<{ storage: string; shared: number }> = [{ storage: 'shared-rbd', shared: 1 }, { storage: 'local-lvm', shared: 0 }]
  migrate: Record<string, any> = {}
  calls: Array<{ method: string; path: string; body?: string }> = []
  /** Set to make the next write "succeed" without changing anything (a PVE that says OK and did nothing). */
  ignoreWrites = false
  /** Set to make every write fail with this message. */
  failWrites: string | null = null

  constructor(o: { nodes: FakeNode[]; guests: FakeGuest[] }) {
    this.nodes = o.nodes.map(n => ({ status: 'online', mem: 4 * GiB, maxmem: 32 * GiB, cpu: 0.1, maxcpu: 8, ...n }))
    this.guests = o.guests.map(g => ({ status: 'running', maxmem: 2 * GiB, maxcpu: 1, name: `g${g.vmid}`, ...g }))
  }

  get writes() { return this.calls.filter(c => c.method !== 'GET') }
  private digest(x: unknown) { return createHash('sha1').update(JSON.stringify(x)).digest('hex') }
  get resDigest() { return this.digest(this.resources) }
  get ruleDigest() { return this.digest(this.rules) }

  addResource(sid: string, extra: Record<string, unknown> = {}) { this.resources.push({ sid, type: sid.slice(0, 2), state: 'started', ...extra }) }
  addRule(r: Record<string, unknown>) { this.rules.push({ affinity: 'positive', order: this.rules.length + 1, ...r }) }

  private guestOfSid(sid: string) { return this.guests.find(g => `${g.type === 'lxc' ? 'ct' : 'vm'}:${g.vmid}` === sid) }

  async fetchStrict<T>(path: string, method = 'GET', body?: string): Promise<T> {
    this.calls.push({ method, path, ...(body ? { body } : {}) })
    const [p, qs] = path.split('?')
    const q = new URLSearchParams(qs ?? '')
    const b = new URLSearchParams(body ?? '')
    const fail = (m: string) => { throw new Error(`Proxmox ${method} ${path}: HTTP 400 — ${m}`) }
    if (method !== 'GET') {
      if (this.failWrites) fail(this.failWrites)
      if (this.ignoreWrites) return null as T
    }
    if (method === 'GET') {
      if (p === '/cluster/ha/resources') return this.resources.map(r => ({ ...r, digest: this.resDigest })) as T
      if (p === '/cluster/ha/rules') return this.rules.map(r => ({ ...r, digest: this.ruleDigest })) as T
      if (p === '/cluster/ha/status/current') return this.status() as T
      if (p === '/cluster/ha/status/manager_status') return {
        lrm_status: Object.fromEntries(this.nodes.map(n => [n.node, { mode: n.maintenance ? 'maintenance' : 'active' }])),
        node_status: Object.fromEntries(this.nodes.map(n => [n.node, n.status === 'online' ? (n.maintenance ? 'maintenance' : 'online') : 'unknown'])),
      } as T
      if (p === '/nodes') return this.nodes.map(n => ({ node: n.node, status: n.status, mem: n.mem, maxmem: n.maxmem, cpu: n.cpu, maxcpu: n.maxcpu })) as T
      if (p === '/cluster/resources' && q.get('type') === 'vm') return this.guests.map(g => ({ vmid: g.vmid, type: g.type, node: g.node, name: g.name, status: g.status, maxmem: g.maxmem, maxcpu: g.maxcpu, template: g.template ?? 0 })) as T
      if (p === '/cluster/resources' && q.get('type') === 'storage') return this.storage as T
      if (p === '/cluster/options') return { crs: this.crs } as T
      if (p === '/cluster/status') return this.nodes.map((n, i) => ({ type: 'node', name: n.node, ip: `10.0.0.${i + 1}` })) as T
      const cfg = /^\/nodes\/([^/]+)\/(lxc|qemu)\/(\d+)\/config$/.exec(p)
      if (cfg) { const g = this.guests.find(x => x.vmid === Number(cfg[3])); if (!g) fail('no such guest'); return (g!.config ?? {}) as T }
      const mig = /^\/nodes\/([^/]+)\/(lxc|qemu)\/(\d+)\/migrate$/.exec(p)
      if (mig) return (this.migrate[mig[3]] ?? { 'allowed-nodes': this.nodes.filter(n => n.node !== mig[1]).map(n => n.node), 'not-allowed-nodes': {}, running: 1 }) as T
      fail(`fake has no GET ${p}`)
    }
    if (p === '/cluster/ha/resources' && method === 'POST') {
      const sid = b.get('sid')!
      if (this.resources.some(r => r.sid === sid)) fail(`resource ID '${sid}' already defined`)
      const r: any = { sid, type: sid.slice(0, 2), state: b.get('state') ?? 'started' }
      for (const k of ['max_restart', 'max_relocate', 'failback', 'comment']) if (b.has(k)) r[k] = b.get(k)
      this.resources.push(r)
      return null as T
    }
    const res = /^\/cluster\/ha\/resources\/(.+)$/.exec(p)
    if (res) {
      const sid = decodeURIComponent(res[1])
      const i = this.resources.findIndex(r => r.sid === sid)
      if (i < 0) fail(`no such resource '${sid}'`)
      if (method === 'PUT') {
        if (b.has('digest') && b.get('digest') !== this.resDigest) fail('detected modified configuration - file changed by other user? Try again.')
        for (const [k, v] of b) if (k !== 'digest' && k !== 'delete') this.resources[i][k] = v
        for (const k of (b.get('delete') ?? '').split(',').filter(Boolean)) delete this.resources[i][k]
        return null as T
      }
      if (method === 'DELETE') {
        this.resources.splice(i, 1)
        if (q.get('purge') !== '0') {
          for (const r of this.rules) r.resources = String(r.resources).split(',').filter(s => s !== sid).join(',')
          this.rules = this.rules.filter(r => r.resources)
        }
        return null as T
      }
    }
    if (p === '/cluster/ha/rules' && method === 'POST') {
      const id = b.get('rule')!
      if (this.rules.some(r => r.rule === id)) fail(`HA rule '${id}' already defined`)
      this.checkRuleResources(b.get('resources') ?? '')
      const r: any = { rule: id, order: this.rules.length + 1 }
      for (const [k, v] of b) if (k !== 'rule') r[k] = v
      this.rules.push(r)
      return null as T
    }
    const rule = /^\/cluster\/ha\/rules\/(.+)$/.exec(p)
    if (rule) {
      const id = decodeURIComponent(rule[1])
      const i = this.rules.findIndex(r => r.rule === id)
      if (i < 0) fail(`no such ha rule '${id}'`)
      if (method === 'PUT') {
        if (b.has('digest') && b.get('digest') !== this.ruleDigest) fail('detected modified configuration - file changed by other user? Try again.')
        if (b.has('resources')) this.checkRuleResources(b.get('resources')!)
        for (const [k, v] of b) if (!['digest', 'delete'].includes(k)) this.rules[i][k] = v
        for (const k of (b.get('delete') ?? '').split(',').filter(Boolean)) delete this.rules[i][k]
        return null as T
      }
      if (method === 'DELETE') { this.rules.splice(i, 1); return null as T }
    }
    fail(`fake has no ${method} ${p}`)
    return null as T
  }

  private checkRuleResources(list: string) {
    const bad = list.split(',').filter(s => s && !this.resources.some(r => r.sid === s))
    if (bad.length) throw new Error(`Proxmox: HTTP 400 — cannot use unmanaged resource(s) ${bad.join(', ')}.`)
  }

  private status() {
    const rows: any[] = [{ id: 'quorum', type: 'quorum', node: this.nodes[0].node, quorate: this.quorate ? 1 : 0, status: this.quorate ? 'OK' : 'No quorum' }]
    rows.push({ id: 'master', type: 'master', node: this.nodes[0].node, status: 'active' })
    rows.push({ id: 'fencing', type: 'fencing', node: this.nodes[0].node, 'armed-state': this.fencing })
    for (const n of this.nodes) rows.push({ id: `lrm:${n.node}`, type: 'lrm', node: n.node, status: `${n.node} (${n.maintenance ? 'maintenance mode' : 'active'})` })
    for (const r of this.resources) {
      const g = this.guestOfSid(r.sid)
      rows.push({ id: `service:${r.sid}`, type: 'service', sid: r.sid, node: g?.node ?? this.nodes[0].node, state: r.state === 'started' ? 'started' : r.state, request_state: r.state })
    }
    return rows
  }
}

export const lxcGpuConfig = { rootfs: 'shared-rbd:vm-1-disk-0,size=8G', lxc: [['lxc.cgroup2.devices.allow', 'c 195:* rwm'], ['lxc.mount.entry', '/dev/nvidia0 dev/nvidia0 none bind,optional,create=file']] }
export const lxcBindConfig = { rootfs: 'shared-rbd:vm-1-disk-0,size=8G', mp0: '/mnt/media,mp=/media' }
export const lxcPlainConfig = { rootfs: 'shared-rbd:vm-1-disk-0,size=8G' }

export function threeNodes() {
  return new FakeHaPve({
    nodes: [{ node: 'node-a' }, { node: 'node-b' }, { node: 'node-c' }],
    guests: [
      { vmid: 901, type: 'lxc', node: 'node-a', config: lxcPlainConfig },
      { vmid: 902, type: 'lxc', node: 'node-b', config: lxcPlainConfig },
      { vmid: 903, type: 'lxc', node: 'node-c', config: lxcGpuConfig },
      { vmid: 904, type: 'qemu', node: 'node-a', config: { scsi0: 'shared-rbd:vm-904-disk-0,size=32G' } },
      { vmid: 905, type: 'lxc', node: 'node-b', config: lxcBindConfig },
    ],
  })
}
