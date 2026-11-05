// A pretend cluster for the Updates tests. It answers the executor interface the
// way Proxmox and the node shells do, records every command, lets a test fail any
// one of them, and keeps its own clock so a 15-minute wait takes no time.
// Names, addresses and ids are generic on purpose: this repo is public.

import type { UpdatesExecutor, ClusterStatus, HaStatus, CephHealth, GuestListing, GuestRef, ExecResult, LineSink } from '../src/lib/updates/executor'
import type { UpdatesPkgChange } from '../src/lib/updates/types'
import { NODE_FACTS_COMMAND, GUEST_PENDING_SCRIPT, GUEST_UPGRADE_SCRIPT, GUEST_REFRESH_SCRIPT, CEPH_LAYOUT_COMMAND, CEPH_STATE_COMMAND, CEPH_OSD_DUMP_COMMAND, isKernelPackage } from '../src/lib/updates/commands'
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
  goDownAt?: number          // still up (old boot) until then, then down for good
}

export interface FakeGuest extends GuestListing {
  config: Record<string, any>
  pending: UpdatesPkgChange[]
  noApt?: boolean
  rebootAfterUpgrade?: boolean
}

export interface Call { where: string; cmd: string; t: number }

/** A Ceph pool in the pretend cluster. `hosts` limits where its PGs land (default: every node with OSDs). */
export interface FakePool {
  id: number; name: string; size: number; minSize: number; pgNum: number; storedBytes: number; hosts?: string[]
  /** Erasure-coded with this profile (size = k + m). */
  ec?: { profile: string; k: number; m: number }
}
export interface FakeCephLayout { pools: FakePool[]; osdsByNode: Record<string, number[]> }
export interface FakePg { pgid: string; pool: number; osds: number[] }

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
  /** A reboot that keeps the node up on its old boot for this long, then takes it down for good. */
  slowShutdownThenDeadMs: number | null = null
  bootIds = new Map<string, number>()
  snapshots = new Map<number, { name: string; snaptime: number }[]>()
  /** Answers for tagged scripts (`# fake:<tag>` on the first line), by tag. */
  scripted = new Map<string, (script: string) => ExecResult>()
  concurrentGuests = 0
  maxConcurrentGuests = 0
  /** Pools and OSD placement. null: two OSDs per node and one replicated pool across all of them. */
  cephLayout: FakeCephLayout | null = null
  /** Overrides the computed `ceph osd ok-to-stop` answer when it returns a boolean. */
  okToStopOverride: (ids: number[]) => boolean | undefined = () => undefined
  monOkToStop = true
  /** OSDs that never come back up after a restart. */
  osdStuck = new Set<number>()
  restartedOsds: number[] = []
  private osdDownPolls = new Map<number, number>()
  /** Hostname each OSD reports in `ceph osd metadata`; default: the node whose bucket holds it. */
  osdHostOverride: Record<number, string> = {}
  /** CRUSH host buckets to report instead of `osdsByNode` (e.g. per-device-class buckets). */
  crushOverride: Record<string, number[]> | null = null
  /** ceph-osd unit ids per node instead of the layout's; null makes the listing fail. */
  unitsOverride: Record<string, string[] | null> = {}
  /** Rows to drop from the PG map, and whether it reports pg_ready. */
  pgRowsDropped = 0
  pgReady = true
  /** Extra OSD map flags (besides noout) that appear once an OSD has been restarted. */
  flagsAfterRestart: string[] = []

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
    if (n.goDownAt !== undefined && this.t >= n.goDownAt) {
      n.goDownAt = undefined
      n.online = false
      n.offlineUntil = Infinity
    }
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

  layout(): FakeCephLayout {
    if (this.cephLayout) return this.cephLayout
    const osdsByNode = Object.fromEntries(this.nodes.map((n, i) => [n.name, [2 * i, 2 * i + 1]]))
    const size = Math.min(3, this.nodes.length)
    return { osdsByNode, pools: [{ id: 1, name: 'vm-disks', size, minSize: size >= 3 ? 2 : 1, pgNum: 32, storedBytes: 100e9 }] }
  }
  /** Each PG on `size` distinct hosts, round robin: deterministic, so tests can count. */
  pgs(): FakePg[] {
    const l = this.layout()
    const out: FakePg[] = []
    for (const p of l.pools) {
      const hosts = (p.hosts ?? Object.keys(l.osdsByNode)).filter(h => l.osdsByNode[h]?.length)
      for (let i = 0; i < p.pgNum; i++) {
        const osds: number[] = []
        for (let k = 0; k < Math.min(p.size, hosts.length); k++) {
          const ids = l.osdsByNode[hosts[(i + k) % hosts.length]]
          osds.push(ids[i % ids.length])
        }
        out.push({ pgid: `${p.id}.${i.toString(16)}`, pool: p.id, osds })
      }
    }
    return this.pgRowsDropped ? out.slice(0, out.length - this.pgRowsDropped) : out
  }
  /** OSDs down right now: offline nodes', stuck ones after their restart, and ones still rejoining. */
  downSet(tick: boolean): Set<number> {
    const l = this.layout()
    const down = new Set<number>([...this.osdStuck].filter(id => this.restartedOsds.includes(id)))
    for (const n of this.nodes) if (!this.isOnline(n)) for (const id of l.osdsByNode[n.name] ?? []) down.add(id)
    for (const [id, polls] of this.osdDownPolls) {
      if (polls <= 0) continue
      down.add(id)
      if (tick) this.osdDownPolls.set(id, polls - 1)
    }
    return down
  }
  private flags(): string[] {
    return [...(this.noout ? ['noout'] : []), ...(this.restartedOsds.length ? this.flagsAfterRestart : []), 'sortbitwise']
  }
  private stateOutput(): string {
    const down = this.downSet(true)
    const l = this.layout()
    const ids = Object.values(l.osdsByNode).flat()
    return [
      'HP_OSDS', JSON.stringify({ flags: this.flags().join(','), flags_set: this.flags(), osds: ids.map(id => ({ osd: id, up: down.has(id) ? 0 : 1, in: 1 })) }),
      'HP_PGS', JSON.stringify({ pg_ready: true, pg_stats: this.pgs().map(p => ({
        pgid: p.pgid, state: p.osds.some(o => down.has(o)) ? 'active+undersized+degraded' : 'active+clean', up: p.osds, acting: p.osds,
      })) }),
      'HP_END',
    ].join('\n')
  }
  okToStop(ids: number[]): { ok: boolean; bad: number } {
    const forced = this.okToStopOverride(ids)
    const l = this.layout()
    const down = new Set(ids)
    let bad = 0
    for (const pg of this.pgs()) {
      const pool = l.pools.find(p => p.id === pg.pool)!
      if (!pg.osds.some(o => down.has(o))) continue
      if (pg.osds.filter(o => !down.has(o)).length < Math.max(1, pool.minSize)) bad++
    }
    return { ok: forced ?? bad === 0, bad: forced === false && !bad ? 1 : bad }
  }
  private layoutOutput(): string {
    const l = this.layout()
    const buckets = this.crushOverride ?? l.osdsByNode
    const hosts = Object.keys(buckets)
    const nodes: any[] = [{ id: -1, name: 'default', type: 'root', children: hosts.map((_, i) => -2 - i) }]
    hosts.forEach((h, i) => {
      nodes.push({ id: -2 - i, name: h, type: 'host', children: buckets[h] })
      for (const o of buckets[h]) nodes.push({ id: o, name: `osd.${o}`, type: 'osd', status: 'up' })
    })
    const meta = Object.entries(l.osdsByNode).flatMap(([h, ids]) => ids.map(id => ({ id, hostname: this.osdHostOverride[id] ?? h })))
    const ec = l.pools.filter(p => p.ec).map(p => `${p.ec!.profile} ${JSON.stringify({ k: String(p.ec!.k), m: String(p.ec!.m), plugin: 'jerasure' })}`)
    return [
      'HP_POOLS', JSON.stringify(l.pools.map(p => ({
        pool_id: p.id, pool_name: p.name, size: p.size, min_size: p.minSize, pg_num: p.pgNum,
        type: p.ec ? 3 : 1, erasure_code_profile: p.ec?.profile ?? '',
      }))),
      'HP_TREE', JSON.stringify({ nodes, stray: [] }),
      'HP_PGS', JSON.stringify({ pg_ready: this.pgReady, pg_stats: this.pgs().map(p => ({ pgid: p.pgid, state: 'active+clean', up: p.osds, acting: p.osds })) }),
      'HP_DF', JSON.stringify({ pools: l.pools.map(p => ({ name: p.name, id: p.id, stats: { stored: p.storedBytes, bytes_used: p.storedBytes * p.size } })) }),
      'HP_META', JSON.stringify(meta),
      'HP_EC', ...ec,
      'HP_END',
    ].join('\n')
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
    const offlineIds = new Set(this.nodes.filter(n => !this.isOnline(n)).flatMap(n => this.layout().osdsByNode[n.name] ?? []))
    const osdsDown = [...this.downSet(false)].filter(id => !offlineIds.has(id)).length
    const checks = [...this.ceph.checks, ...(this.flags().length > 1 ? ['OSDMAP_FLAGS'] : []), ...(osdsDown ? ['OSD_DOWN', 'PG_DEGRADED'] : [])]
    const total = Object.values(this.ceph.pgStates).reduce((a, b) => a + b, 0)
    const pgStates = osdsDown ? { 'active+clean': total - 8, 'active+undersized+degraded': 8 } : this.ceph.pgStates
    return { ...this.ceph, numUpOsds: this.ceph.numUpOsds - down * 2 - osdsDown, checks, pgStates }
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
      if (this.slowShutdownThenDeadMs !== null) {
        n.goDownAt = this.t + this.slowShutdownThenDeadMs
        return ok()
      }
      n.online = false
      n.offlineUntil = this.t + this.rebootTakesMs
      return ok()
    }
    if (cmd === CEPH_LAYOUT_COMMAND) return ok(this.layoutOutput())
    if (cmd === CEPH_STATE_COMMAND) return ok(this.stateOutput())
    if (cmd === CEPH_OSD_DUMP_COMMAND) return ok(JSON.stringify({ flags: this.flags().join(','), flags_set: this.flags(), osds: [] }))
    let u = /^systemctl list-units 'ceph-(osd|mon|mgr|mds)@\*'/.exec(cmd)
    if (u) {
      const over = u[1] === 'osd' ? this.unitsOverride[name] : undefined
      if (over === null) return ok('Failed to connect to bus: No such file or directory\nHP_RC 1')
      const ids = u[1] === 'osd' ? (over ?? (this.layout().osdsByNode[name] ?? []).map(String)) : u[1] === 'mds' ? [] : [name]
      return ok([...ids.map(i => `ceph-${u![1]}@${i}.service loaded active running Ceph daemon`), 'HP_RC 0'].join('\n'))
    }
    u = /^ceph osd ok-to-stop ([\d ]+) -f json/.exec(cmd)
    if (u) {
      const ids = u[1].trim().split(/\s+/).map(Number)
      const r = this.okToStop(ids)
      return ok(`${JSON.stringify({ ok_to_stop: r.ok, osds: ids, num_ok_pgs: 10, num_not_ok_pgs: r.bad })}\nHP_RC ${r.ok ? 0 : 16}`)
    }
    if (/^ceph mon ok-to-stop/.test(cmd)) {
      return ok(this.monOkToStop ? `quorum should be preserved (others) after stopping [${name}]\nHP_RC 0` : `Error EBUSY: not enough monitors would be available after stopping mons [${name}]\nHP_RC 16`)
    }
    u = /^systemctl restart ceph-osd@(\d+)\.service$/.exec(cmd)
    if (u) {
      const id = Number(u[1])
      this.restartedOsds.push(id)
      if (!this.osdStuck.has(id)) this.osdDownPolls.set(id, 1)
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
      : /docker compose pull/.test(script) ? 'docker' : /check answered/.test(script) ? 'check' : script === 'true' ? 'ping'
      : /^# fake:(\S+)/.exec(script)?.[1] ?? 'other'
    this.calls.push({ where: String(g.vmid), cmd: `guest:${tag}`, t: this.t })
    const r = this.inject(String(g.vmid), `guest:${tag}`)
    if (r instanceof Error) throw r
    if (r) return r
    if (tag === 'pending') {
      if (fg.noApt) return ok('HP_NO_APT')
      return ok(fg.pending.map(p => `${p.name}/stable ${p.to} amd64 [upgradable from: ${p.from}]`).join('\n'))
    }
    if (this.scripted.has(tag)) return this.scripted.get(tag)!(script)
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
    const cfg = this.guests.find(x => x.vmid === g.vmid)?.config ?? {}
    if (Object.entries(cfg).some(([k, v]) => /^mp\d+$/.test(k) && String(v).startsWith('/'))) {
      throw new Error(`task UPID:fake:vzsnapshot:${g.vmid}: ended: snapshot feature is not available`)
    }
    const list = this.snapshots.get(g.vmid) ?? []
    list.push({ name, snaptime: Math.floor(this.t / 1000) })
    this.snapshots.set(g.vmid, list)
  }
  async listSnapshots(g: GuestRef) { this.failIf('listSnapshots'); return [...(this.snapshots.get(g.vmid) ?? [])] }
  async deleteSnapshot(g: GuestRef, name: string) {
    this.calls.push({ where: String(g.vmid), cmd: `delete-snapshot ${name}`, t: this.t })
    this.snapshots.set(g.vmid, (this.snapshots.get(g.vmid) ?? []).filter(s => s.name !== name))
  }

  async rollbackSnapshot(g: GuestRef, name: string) {
    this.calls.push({ where: String(g.vmid), cmd: `rollback ${name}`, t: this.t })
    const r = this.inject(String(g.vmid), 'rollback')
    if (r instanceof Error) throw r
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
