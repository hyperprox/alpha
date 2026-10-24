// A pretend cluster for the Updates tests. It answers the executor interface the
// way Proxmox and the node shells do, records every command, lets a test fail any
// one of them, and keeps its own clock so a 15-minute wait takes no time.
// Names, addresses and ids are generic on purpose: this repo is public.

import type { UpdatesExecutor, ClusterStatus, HaStatus, CephHealth, GuestListing, GuestRef, ExecResult, LineSink } from '../src/lib/updates/executor'
import type { UpdatesPkgChange } from '../src/lib/updates/types'
import { NODE_FACTS_COMMAND, GUEST_PENDING_SCRIPT, GUEST_UPGRADE_SCRIPT, GUEST_REFRESH_SCRIPT, isKernelPackage } from '../src/lib/updates/commands'
import { parsePolicy, type PolicyLoad } from '../src/lib/updates/policy'

export interface FakeNode {
  name: string
  online: boolean
  pending: UpdatesPkgChange[]
  freeMb: number
  kernel: string
  kernelPkgs: string[]
  rebootRequired: boolean
  holds: string[]
  pinned: string | null
  offlineUntil?: number      // Infinity: never comes back
}

export interface FakeGuest extends GuestListing {
  config: Record<string, any>
  pending: UpdatesPkgChange[]
  noApt?: boolean
  rebootAfterUpgrade?: boolean
}

export interface Call { where: string; cmd: string; t: number }

const ok = (output = ''): ExecResult => ({ code: 0, output, timedOut: false })

export function pkg(name: string, to: string, from: string | null = '1.0'): UpdatesPkgChange { return { name, from, to } }

export function node(name: string, over: Partial<FakeNode> = {}): FakeNode {
  return {
    name, online: true, pending: [pkg('curl', '8.1-2', '8.1-1')], freeMb: 8000,
    kernel: '7.0.1-1-pve', kernelPkgs: ['proxmox-kernel-7.0.1-1-pve-signed'],
    rebootRequired: false, holds: [], pinned: null, ...over,
  }
}

export function guest(vmid: number, nodeName: string, over: Partial<FakeGuest> = {}): FakeGuest {
  return {
    vmid, type: 'lxc', node: nodeName, name: `guest-${vmid}`, running: true, template: false,
    config: { hostname: `guest-${vmid}` }, pending: [pkg('openssl', '3.0-2', '3.0-1')], ...over,
  }
}

export class FakeCluster implements UpdatesExecutor {
  t = 1_800_000_000_000
  calls: Call[] = []
  nodes: FakeNode[] = []
  guests: FakeGuest[] = []
  haSids: string[] = []
  haServices: { sid: string; node: string; state: string }[] = []
  maintenance = new Set<string>()
  noout = false
  ceph: CephHealth | null = { status: 'HEALTH_OK', checks: [], numOsds: 6, numUpOsds: 6, numInOsds: 6, pgStates: { 'active+clean': 128 } }
  /** Plex streams per call, last value repeats. null: no Plex configured. 'error': source down. */
  plex: Array<number | null | 'error'> = [null]
  rebootTakesMs = 4 * 60_000
  /** Return a result to fail (or alter) a command; undefined lets it run normally. */
  inject: (where: string, cmd: string) => ExecResult | Error | undefined = () => undefined
  handoffResults = new Map<string, string>()   // unit -> JSON written by the script
  /** Reads that answer with an error, by executor method name (e.g. 'cephHealth', 'haStatus'). */
  readFail = new Set<string>()
  /** A reboot command that is accepted but does nothing (the node stays up, same boot id). */
  rebootIgnored = false
  bootIds = new Map<string, number>()
  snapshots = new Map<number, { name: string; snaptime: number }[]>()
  concurrentGuests = 0
  maxConcurrentGuests = 0

  constructor(init?: { nodes?: FakeNode[]; guests?: FakeGuest[] }) {
    this.nodes = init?.nodes ?? []
    this.guests = init?.guests ?? []
  }

  // --- helpers for tests --------------------------------------------------------
  cmds(where?: string): string[] { return this.calls.filter(c => !where || c.where === where).map(c => c.cmd) }
  ran(re: RegExp, where?: string): boolean { return this.cmds(where).some(c => re.test(c)) }
  private n(name: string): FakeNode {
    const x = this.nodes.find(n => n.name === name)
    if (!x) throw new Error(`no node ${name}`)
    return x
  }
  private failIf(method: string) {
    if (this.readFail.has(method)) throw new Error(`Proxmox GET for ${method}: HTTP 500 — simulated error answer`)
  }
  private isOnline(n: FakeNode): boolean {
    if (n.offlineUntil !== undefined && this.t >= n.offlineUntil) {
      n.offlineUntil = undefined
      n.online = true
      this.bootIds.set(n.name, (this.bootIds.get(n.name) ?? 0) + 1)
      const newest = [...n.kernelPkgs].sort().at(-1)?.replace(/^proxmox-kernel-/, '').replace(/-signed$/, '')
      if (newest) n.kernel = n.pinned ?? newest
      n.rebootRequired = false
    }
    return n.online
  }

  // --- reads --------------------------------------------------------------------------
  async clusterStatus(): Promise<ClusterStatus> {
    this.failIf('clusterStatus')
    const nodes = this.nodes.map(n => ({ name: n.name, online: this.isOnline(n), ip: `10.0.0.${this.nodes.indexOf(n) + 1}` }))
    return { quorate: nodes.filter(n => n.online).length * 2 > nodes.length, nodes }
  }
  async haStatus(): Promise<HaStatus> {
    this.failIf('haStatus')
    return { services: this.haServices.map(s => ({ ...s })), maintenanceNodes: [...this.maintenance] }
  }
  async haResources() { this.failIf('haResources'); return [...this.haSids] }
  async cephPresent() { this.failIf('cephPresent'); return this.ceph !== null }
  async cephHealth(): Promise<CephHealth> {
    this.failIf('cephHealth')
    if (!this.ceph) throw new Error('Proxmox GET /cluster/ceph/status: HTTP 500 — binary not installed')
    const down = this.nodes.filter(n => !this.isOnline(n)).length
    return { ...this.ceph, numUpOsds: this.ceph.numUpOsds - down * 2, checks: this.noout ? [...this.ceph.checks, 'OSDMAP_FLAGS'] : this.ceph.checks }
  }
  async listGuests() { this.failIf('listGuests'); return this.guests.map(({ vmid, type, node, name, running, template }) => ({ vmid, type, node, name, running, template })) }
  async guestConfig(g: GuestRef) { this.failIf('guestConfig'); return { ...(this.guests.find(x => x.vmid === g.vmid)?.config ?? {}) } }
  async nodeAptPending(name: string) { this.failIf('nodeAptPending'); return this.n(name).pending.map(p => ({ ...p })) }
  async plexStreams(): Promise<number | null> {
    const v = this.plex.length > 1 ? this.plex.shift()! : this.plex[0]
    if (v === 'error') throw new Error('Tautulli returned HTTP 502')
    return v
  }

  // --- actions ---------------------------------------------------------------------------
  async nodeAptRefresh(name: string) {
    this.calls.push({ where: name, cmd: 'POST apt/update', t: this.t })
    const r = this.inject(name, 'POST apt/update')
    if (r instanceof Error) throw r
    if (r && r.code !== 0) throw new Error(r.output)
  }

  async nodeExec(name: string, cmd: string, onLine?: LineSink): Promise<ExecResult> {
    const n = this.n(name)
    if (!this.isOnline(n)) throw new Error(`connect ECONNREFUSED ${name}`)
    this.calls.push({ where: name, cmd, t: this.t })
    const r = this.inject(name, cmd)
    if (r instanceof Error) throw r
    if (r) return r
    onLine?.(`ran on ${name}`)

    if (cmd === NODE_FACTS_COMMAND) {
      return ok([
        `HP_FREE ${n.freeMb}`, `HP_KERNEL ${n.kernel}`, ...(n.rebootRequired ? ['HP_REBOOT_REQUIRED'] : []),
        'HP_HOLDS_BEGIN', ...n.holds, 'HP_HOLDS_END',
        'HP_PIN_BEGIN', ...(n.pinned ? ['Pinned kernel:', n.pinned] : []), 'HP_PIN_END',
        'HP_KPKG_BEGIN', ...n.kernelPkgs.map(p => `${p} install ok installed`), 'HP_KPKG_END',
      ].join('\n'))
    }
    if (/apt-get .* (dist-)?upgrade$/.test(cmd) || /--only-upgrade install/.test(cmd)) {
      const ceph = /--only-upgrade install/.test(cmd)
      for (const p of n.pending.filter(p => ceph ? cmd.includes(`${p.name}=`) : true)) {
        if (isKernelPackage(p.name) && p.name.startsWith('proxmox-kernel-') && /\d/.test(p.name)) {
          n.kernelPkgs.push(p.name); n.rebootRequired = true
        }
      }
      n.pending = ceph ? n.pending.filter(p => !cmd.includes(`${p.name}=`)) : []
      return ok('upgraded')
    }
    if (cmd === 'cat /proc/sys/kernel/random/boot_id') {
      const b = this.bootIds.get(name) ?? 0
      return ok(`00000000-0000-4000-8000-${String(b).padStart(12, '0')}`)
    }
    if (cmd === 'systemctl reboot') {
      if (this.rebootIgnored) return ok()
      n.online = false
      n.offlineUntil = this.t + this.rebootTakesMs
      return ok()
    }
    if (cmd === 'ceph osd set noout') { this.noout = true; return ok() }
    if (cmd === 'ceph osd unset noout') { this.noout = false; return ok() }
    let m = /node-maintenance (enable|disable) '([^']+)'/.exec(cmd)
    if (m) {
      if (m[1] === 'enable') {
        this.maintenance.add(m[2])
        const other = this.nodes.find(x => x.name !== m![2])!.name
        for (const s of this.haServices) if (s.node === m[2]) s.node = other
      } else this.maintenance.delete(m[2])
      return ok()
    }
    m = /ha-manager set '([^']+)' --state (\w+)/.exec(cmd)
    if (m) { const s = this.haServices.find(x => x.sid === m![1]); if (s) s.state = m[2]; return ok() }
    m = /systemd-run --unit=(\S+)/.exec(cmd)
    if (m) return ok()
    m = /cat (\S+hyperprox-handoff-[^ ;]+\.json)/.exec(cmd)
    if (m) {
      const unit = /(hyperprox-handoff-[A-Za-z0-9_-]+)\.json/.exec(m[1])![1]
      const res = this.handoffResults.get(unit) ?? this.handoffResults.get('*')
      return ok(res ?? 'HP_RUNNING')
    }
    return ok('ok')
  }

  async guestExec(g: GuestRef, script: string, onLine?: LineSink): Promise<ExecResult> {
    const fg = this.guests.find(x => x.vmid === g.vmid)!
    const tag = script === GUEST_PENDING_SCRIPT ? 'pending' : script === GUEST_UPGRADE_SCRIPT ? 'apt' : script === GUEST_REFRESH_SCRIPT ? 'refresh'
      : /docker compose pull/.test(script) ? 'docker' : /check answered/.test(script) ? 'check' : script === 'true' ? 'ping' : 'other'
    this.calls.push({ where: String(g.vmid), cmd: `guest:${tag}`, t: this.t })
    const r = this.inject(String(g.vmid), `guest:${tag}`)
    if (r instanceof Error) throw r
    if (r) return r
    if (tag === 'pending') {
      if (fg.noApt) return ok('HP_NO_APT')
      return ok(fg.pending.map(p => `${p.name}/stable ${p.to} amd64 [upgradable from: ${p.from}]`).join('\n'))
    }
    if (tag === 'apt') {
      this.concurrentGuests++
      this.maxConcurrentGuests = Math.max(this.maxConcurrentGuests, this.concurrentGuests)
      await new Promise(res => setImmediate(res))
      this.concurrentGuests--
      fg.pending = []
      onLine?.('Setting up openssl')
      return ok(fg.rebootAfterUpgrade ? 'done\nHP_REBOOT_REQUIRED' : 'done')
    }
    return ok('ok')
  }

  async snapshot(g: GuestRef, name: string) {
    this.calls.push({ where: String(g.vmid), cmd: `snapshot ${name}`, t: this.t })
    const r = this.inject(String(g.vmid), 'snapshot')
    if (r instanceof Error) throw r
    const list = this.snapshots.get(g.vmid) ?? []
    list.push({ name, snaptime: Math.floor(this.t / 1000) })
    this.snapshots.set(g.vmid, list)
  }
  async listSnapshots(g: GuestRef) { this.failIf('listSnapshots'); return [...(this.snapshots.get(g.vmid) ?? [])] }
  async deleteSnapshot(g: GuestRef, name: string) {
    this.calls.push({ where: String(g.vmid), cmd: `delete-snapshot ${name}`, t: this.t })
    this.snapshots.set(g.vmid, (this.snapshots.get(g.vmid) ?? []).filter(s => s.name !== name))
  }

  now() { return this.t }
  async sleep(ms: number) { this.t += ms }
}

export function policyLoad(yaml: string | null): () => PolicyLoad {
  if (yaml === null) return () => ({ loaded: false, path: '/test/updates.yaml', error: 'No policy file', policy: parsePolicy('') })
  const policy = parsePolicy(yaml)
  return () => ({ loaded: true, path: '/test/updates.yaml', policy })
}

/** Fast timings: the fake clock jumps on sleep, so these only bound loop counts. */
export const FAST = {
  nodeReturnMs: 15 * 60_000, rebootSettleMs: 60_000, pollMs: 15_000, streamRecheckMs: 5 * 60_000,
  haDrainMs: 10 * 60_000, cephSettleMs: 10 * 60_000, guestBootMs: 5 * 60_000, handoffPollMs: 10_000, handoffMaxMs: 40 * 60_000,
}
