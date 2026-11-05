// A small fake Proxmox for the guest config editor: configs with digests, pending values on running guests,
// volumes that allocate, lxc.* keys refused (as the real API does), HA state, tasks, and a node shell.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GuestPve, NodeShell } from '../../src/lib/guest-config/service'
import { GuestConfigService } from '../../src/lib/guest-config/service'
import { MemoryHistoryStore } from '../../src/lib/guest-config/history/store'
import { sha256 } from '../../src/lib/guest-config/rawfile'
import { pveParseRaw, pveHasLock, pveHasPending } from './pve-conf'

export const FIX = (name: string) => readFileSync(join(__dirname, '..', 'fixtures', 'guest-config', name), 'utf8')

type Cfg = Record<string, any>
interface Guest { node: string; type: 'lxc' | 'qemu'; vmid: number; config: Cfg; pending: Record<string, { value?: string; delete?: boolean }>; status: 'running' | 'stopped'; ha?: string; name: string }

const LXC_PENDING_WHEN_RUNNING = /^(dev\d+|mp\d+|nameserver|searchdomain|hostname)$/
const QEMU_PENDING_WHEN_RUNNING = /^(cores|sockets|memory|boot|agent|hostpci\d+|usb\d+)$/

export class FakePve implements GuestPve {
  guests = new Map<string, Guest>()
  quorate = true
  nodes = [{ node: 'node-a', status: 'online' }, { node: 'node-b', status: 'online' }, { node: 'node-c', status: 'online' }]
  writes: Array<{ path: string; params: Record<string, string> }> = []
  /** The next config PUT answers OK and changes nothing (a task that lies). */
  lieOnce = false
  /** A reboot drops the raw lines (PVE rewriting a pending block). */
  dropRawOnReboot = false
  /** Called before a PUT is applied: lets a test change the config "concurrently". */
  beforePut?: (g: Guest) => void
  private disk = 10

  add(g: Omit<Guest, 'pending' | 'name'> & { pending?: Guest['pending']; name?: string }): Guest {
    const full: Guest = { pending: {}, name: g.config.hostname ?? g.config.name ?? String(g.vmid), ...g }
    delete full.config.digest
    this.guests.set(`${g.type}/${g.vmid}`, full)
    return full
  }
  g(type: string, vmid: number) { return this.guests.get(`${type}/${vmid}`)! }

  /** The config as Proxmox's default read gives it: pending values applied, with a digest of the current one. */
  view(g: Guest): Cfg {
    const c: Cfg = structuredClone(g.config)
    for (const [k, p] of Object.entries(g.pending)) { if (p.delete) delete c[k]; else c[k] = p.value }
    return { ...c, digest: createHash('sha1').update(JSON.stringify(g.config) + JSON.stringify(g.pending)).digest('hex') }
  }

  private find(path: string): Guest | undefined {
    const m = /^\/nodes\/([^/]+)\/(lxc|qemu)\/(\d+)/.exec(path)
    if (!m) return undefined
    const g = this.guests.get(`${m[2]}/${m[3]}`)
    return g && g.node === decodeURIComponent(m[1]) ? g : undefined
  }

  async get(path: string): Promise<any> {
    if (path === '/cluster/status') return [{ type: 'cluster', name: 'test', quorate: this.quorate ? 1 : 0 }, ...this.nodes.map(n => ({ type: 'node', name: n.node, online: 1 }))]
    if (path === '/nodes') return this.nodes
    if (path.startsWith('/cluster/resources')) return [...this.guests.values()].map(g => ({ type: g.type, vmid: g.vmid, node: g.node, name: g.name, status: g.status, tags: g.config.tags, maxmem: 1, mem: 0, cpu: 0, maxcpu: 1 }))
    if (path === '/cluster/ha/resources') return [...this.guests.values()].filter(g => g.ha).map(g => ({ sid: `${g.type === 'qemu' ? 'vm' : 'ct'}:${g.vmid}`, state: g.ha }))
    if (path === '/cluster/ha/status/current') return []
    let m = /^\/nodes\/([^/]+)\/(lxc|qemu)$/.exec(path)
    if (m) return [...this.guests.values()].filter(g => g.node === m![1] && g.type === m![2]).map(g => ({ vmid: g.vmid, name: g.name, status: g.status }))
    m = /^\/nodes\/[^/]+\/tasks\/(.+)\/status$/.exec(path)
    if (m) return { status: 'stopped', exitstatus: 'OK' }
    const g = this.find(path)
    if (!g) throw new Error(`Proxmox GET ${path}: HTTP 500 — no such guest`)
    if (path.endsWith('/config')) return this.view(g)
    if (path.endsWith('/pending')) {
      const v = this.view(g)
      const keys = new Set([...Object.keys(g.config), ...Object.keys(g.pending)])
      return [...keys].filter(k => k !== 'lxc').map(k => ({ key: k, value: g.config[k], ...(g.pending[k]?.delete ? { delete: 1 } : g.pending[k] ? { pending: g.pending[k].value } : {}) })).concat([{ key: 'digest', value: v.digest } as any])
    }
    if (path.endsWith('/status/current')) return { status: g.status, name: g.name }
    throw new Error(`Proxmox GET ${path}: HTTP 501 — not in the fake`)
  }

  async put(path: string, params: Record<string, string>): Promise<any> {
    this.writes.push({ path, params })
    const ha = /^\/cluster\/ha\/resources\/(.+)$/.exec(path)
    if (ha) {
      const sid = decodeURIComponent(ha[1]); const [t, id] = sid.split(':')
      const g = this.g(t === 'vm' ? 'qemu' : 'lxc', Number(id))
      g.ha = params.state
      if (params.state === 'stopped') { g.status = 'stopped'; this.applyPending(g) }
      if (params.state === 'started') g.status = 'running'
      return null
    }
    const g = this.find(path)
    if (!g) throw new Error(`Proxmox PUT ${path}: HTTP 500 — no such guest`)
    this.beforePut?.(g)
    const cur = this.view(g)
    if (params.digest && params.digest !== cur.digest) throw new Error(`Proxmox PUT ${path}: HTTP 500 — detected modified configuration - file changed by other user? Try again.`)
    if (path.endsWith('/resize')) {
      const key = params.disk
      const v = String(cur[key]); g.config[key] = v.replace(/size=[^,]+/, `size=${params.size}`)
      return `UPID:${g.node}:0001:resize:${g.vmid}:root@pam:`
    }
    for (const k of Object.keys(params)) if (k.startsWith('lxc')) throw new Error(`Proxmox PUT ${path}: HTTP 400 — Parameter verification failed. ${k}: property is not defined in schema`)
    if ((params.delete ?? '').split(',').some(k => k.startsWith('lxc'))) throw new Error(`Proxmox PUT ${path}: HTTP 400 — delete: unknown option 'lxc'`)
    if (this.lieOnce) { this.lieOnce = false; return null }
    const pendRe = g.type === 'lxc' ? LXC_PENDING_WHEN_RUNNING : QEMU_PENDING_WHEN_RUNNING
    for (const [k, raw] of Object.entries(params)) {
      if (k === 'digest' || k === 'delete') continue
      let v = raw
      const alloc = /^([\w.-]+):(\d+)(,.*)?$/.exec(v)
      if (alloc && /^mp\d+$/.test(k)) v = `${alloc[1]}:vm-${g.vmid}-disk-${this.disk++}${alloc[3] ?? ''},size=${alloc[2]}G`
      if (g.type === 'lxc' && /^net\d+$/.test(k) && !/hwaddr=/.test(v)) v = `${v},hwaddr=BC:24:11:00:00:01`
      if (g.status === 'running' && pendRe.test(k)) g.pending[k] = { value: v }
      else { g.config[k] = /^\d+$/.test(v) && !/^(description|tags|nameserver|name|hostname)$/.test(k) ? Number(v) : v; delete g.pending[k] }
    }
    for (const k of (params.delete ?? '').split(',').filter(Boolean)) {
      if (g.status === 'running' && pendRe.test(k)) { g.pending[k] = { delete: true }; continue }
      const old = g.config[k]
      delete g.config[k]
      if (/^mp\d+$/.test(k) && typeof old === 'string' && !old.startsWith('/')) {
        let i = 0; while (g.config[`unused${i}`] !== undefined) i++
        g.config[`unused${i}`] = old.split(',')[0]
      }
    }
    return null
  }

  async post(path: string): Promise<any> {
    this.writes.push({ path, params: {} })
    const g = this.find(path)
    if (!g) throw new Error(`Proxmox POST ${path}: HTTP 500`)
    if (path.endsWith('/status/reboot')) { this.applyPending(g); return `UPID:${g.node}:0002:reboot:${g.vmid}:root@pam:` }
    throw new Error(`Proxmox POST ${path}: not in the fake`)
  }

  private applyPending(g: Guest) {
    for (const [k, p] of Object.entries(g.pending)) { if (p.delete) delete g.config[k]; else g.config[k] = p.value }
    g.pending = {}
    if (this.dropRawOnReboot) delete g.config.lxc
  }
}

export class FakeShell implements NodeShell {
  probes: Record<string, string> = {}
  /** Paths that exist (as directories) per node, for shared=1. */
  dirs: Record<string, Record<string, string>> = {}
  /** Device paths visible inside a container: `${vmid}` → paths. */
  inside: Record<string, string[]> = {}
  groups: Record<string, string> = {}
  libs: Record<string, string> = {}
  logins = new Set(['node-a', 'node-b', 'node-c'])
  commands: Array<{ node: string; command: string }> = []
  /** Config files as the node has them, by vmid; made from the fake's config when first read. */
  files: Record<string, string> = {}
  /** Snapshot sections or other text after the main section, by vmid. */
  tail: Record<string, string> = {}
  /** Change the file between read and write (a concurrent edit on the node). */
  beforeWrite?: (vmid: string) => void
  /** The session drops after the rename: the write lands, the answer never arrives. */
  dropAfterWrite = false
  /** Temp files left by an earlier, interrupted run, by vmid. */
  leftovers: Record<string, string[]> = {}
  removed: string[] = []
  /** Device paths that are symlinks on a node (for the device check), by node. */
  symlinks: Record<string, string[]> = {}
  /** Character devices on a node: from the node's probe fixture (##chardev), unless set. */
  chars(node: string): Record<string, string> {
    const sec = (this.probes[node] ?? '').split('##chardev')[1]?.split('##end')[0] ?? ''
    return Object.fromEntries(sec.split('\n').filter(l => l.includes('|')).map(l => l.trim().split('|') as [string, string]))
  }
  constructor(private pve?: FakePve) {}
  fileOf(vmid: string): string {
    if (this.files[vmid] !== undefined) return this.files[vmid]
    const g = this.pve?.g('lxc', Number(vmid))
    const c = g ? g.config : {}
    const main = Object.entries(c).filter(([k]) => k !== 'lxc').sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}: ${v}`)
    const raw = ((c as any).lxc ?? []).map(([k, v]: [string, string]) => `${k}: ${v}`)
    this.files[vmid] = [...main, ...raw].join('\n') + '\n' + (this.tail[vmid] ?? '')
    return this.files[vmid]
  }
  async run(node: string, command: string) {
    this.commands.push({ node, command })
    if (!this.logins.has(node)) return null
    let w = /f='\/etc\/pve\/nodes\/[^/]+\/lxc\/(\d+)\.conf'/.exec(command)
    if (w && command.includes('# HPX write config file')) {
      const vmid = w[1]
      if (!command.includes('flock -w')) throw new Error('fake: a write without the config lock')
      this.beforeWrite?.(vmid)
      const cur = this.fileOf(vmid)
      const expect = /if \[ "\$cur" != '([0-9a-f]{64})' \]/.exec(command)![1]
      if (sha256(cur) !== expect) return { code: 3, output: `HPX-CAS-MISMATCH ${sha256(cur)}\n` }
      if (pveHasLock(cur)) return { code: 5, output: 'HPX-GUEST-LOCKED\n' }
      if (pveHasPending(cur)) return { code: 7, output: 'HPX-PENDING\n' }
      for (const p of [...command.matchAll(/^for p in (.*); do$/gm)].flatMap(m => [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1])))
        if ((this.symlinks[node] ?? []).includes(p)) return { code: 6, output: `HPX-BAD-DEVICE ${p}\n` }
      const text = Buffer.from(/printf '%s' '([^']*)'/.exec(command)![1], 'base64').toString('utf8')
      this.files[vmid] = text
      // Proxmox re-parses the file (its own grammar, not the writer's): its main-section raw lines are what the API reads.
      const g = this.pve?.g('lxc', Number(vmid))
      if (g) { const raw = pveParseRaw(text); if (raw.length) g.config.lxc = raw; else delete g.config.lxc }
      if (this.dropAfterWrite) { this.dropAfterWrite = false; throw new Error('fake: connection reset by peer') }
      return { code: 0, output: `${Buffer.from(text).toString('base64')}\n${sha256(text)}\n` }
    }
    if (command.includes('# HPX verify devices')) {
      const paths = [...(/^for p in (.*); do$/m.exec(command)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(x => x[1])
      const ch = this.chars(node)
      const dirs = new Set(Object.keys(ch).filter(p => p.startsWith('/dev/dri/') || p.startsWith('/dev/nvidia-caps/')).map(p => p.split('/').slice(0, 3).join('/')))
      return { code: 0, output: paths.map(p => (this.symlinks[node] ?? []).includes(p) ? `L ${p}` : ch[p] ? `C ${p} ${ch[p]} ${p}` : dirs.has(p) ? `D ${p} ${p}` : `M ${p}`).join('\n') + '\n' }
    }
    if (w && command.includes('# HPX clean config temp files')) {
      const files = [...command.matchAll(/rm -f '([^']+)'/g)].map(m => m[1])
      this.removed.push(...files)
      this.leftovers[w[1]] = (this.leftovers[w[1]] ?? []).filter(x => !files.includes(x))
      return { code: 0, output: 'HPX-CLEANED\n' }
    }
    if (w) {
      const t = this.fileOf(w[1])
      return { code: 0, output: `${Buffer.from(t).toString('base64')}\n${sha256(t)}\n${(this.leftovers[w[1]] ?? []).map(x => `HPX-LEFTOVER ${x}\n`).join('')}` }
    }
    if (command.includes("echo '##lspci'")) return { code: 0, output: this.probes[node] ?? '##end\n' }
    let m = /if \[ -d '([^']+)' \]/.exec(command)
    if (m) { const t = this.dirs[node]?.[m[1]]; return { code: 0, output: t ? `${t}\n` : 'MISSING\n' } }
    m = /^pct exec (\d+) -- sh -c 'for p in .* sh (.*)$/.exec(command)
    if (m) {
      const vm = m[1]; const paths = [...m[2].matchAll(/'([^']+)'/g)].map(x => x[1])
      const g = this.pve?.g('lxc', Number(vm))
      const seen = this.inside[vm] ?? (g ? Object.entries(this.pve!.view(g)).filter(([k]) => /^dev\d+$/.test(k)).map(([, v]) => String(v).split(',')[0]) : [])
      return { code: 0, output: paths.map(p => `${seen.includes(p) ? 'Y' : 'N'} ${p}`).join('\n') }
    }
    m = /^pct exec (\d+) -- getent group/.exec(command)
    if (m) return { code: 0, output: this.groups[m[1]] ?? 'video:x:44:\nrender:x:993:\n' }
    m = /^pct exec (\d+) -- sh -c 'ls \/usr\/lib/.exec(command)
    if (m) return { code: 0, output: this.libs[m[1]] ?? '' }
    return { code: 1, output: '' }
  }
}

export function makeService(pve = new FakePve(), shell = new FakeShell(pve)) {
  const history = new MemoryHistoryStore()
  const audits: Array<{ action: string; resource: string; details: any }> = []
  let now = 1_000_000
  const service = new GuestConfigService({
    pve, shell, history, audit: async (action, resource, details) => { audits.push({ action, resource, details }) },
    now: () => now, sleep: async () => {}, timeouts: { taskMs: 10, haMs: 10, pollMs: 1 },
  })
  return { service, pve, shell, history, audits, tick: (ms: number) => { now += ms } }
}

export const OWNER = 'admin@example.com'

export function smallCt(over: Cfg = {}): Cfg {
  return {
    arch: 'amd64', cores: 1, memory: 512, swap: 256, hostname: 'web', ostype: 'debian', unprivileged: 1,
    rootfs: 'fast-ssd:vm-901-disk-0,size=4G', net0: 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:09:01,ip=192.0.2.10/24,gw=192.0.2.1,type=veth',
    tags: 'test', timezone: 'host', tty: 3,
    lxc: [['lxc.cgroup2.devices.allow', 'c 10:200 rwm']],
    ...over,
  }
}
