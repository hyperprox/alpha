// =============================================================================
//  HyperProx — load balancing: the engine
//
//  For every guest (HA or not) and every other node: could it run there, and
//  if not, why not, in plain words. The facts come from the guest's config
//  (devices, bind mounts, disks, CPU type), the HA rules, each node's CPU and
//  memory, and the task log (a backup running, a move in progress).
//
//  Three verdicts per target: ok, no, unknown. "Unknown" is said when a fact
//  could not be checked (a bind mount path on a node HyperProx cannot log in
//  to, a CPU it could not read); the engine never guesses one way or the other.
//
//  Pure: a function of what read.ts gathered.
// =============================================================================

import { homeOf, list } from '../ha/rules'
import type { GuestHardware, HaGuest, HaRule, HaSnapshot, Sid } from '../ha/types'
import { cpuReason, cpuTypeOf, type NodeCpu } from './cpu'
import { copySeconds } from './network'
import type { GuestPlacement, NetworkCost, PlacementMap, PlacementNode, Reason, TargetCheck } from './types'

export interface EngineInput {
  snap:     HaSnapshot
  configs:  Record<Sid, Record<string, unknown> | null>
  nodeCpu:  Record<string, NodeCpu>
  /** Storage id → nodes it is active on. */
  storageNodes: Record<string, string[]>
  /** Now: cores busy and memory used, per guest. */
  usage:    Record<Sid, { cores: number; mem: number }>
  /** vzdump tasks running now: their node, and the guest when the task names one. */
  backupsRunning: Array<{ node: string; vmid?: number }>
  /** Guests with a migration task running now. */
  migrating: Sid[]
  /** Shared bind-mount paths checked on nodes over a node login: sid → node → path → exists. */
  pathChecks?: Record<Sid, Record<string, Record<string, boolean | null>>>
  network:  NetworkCost
  settings: { linkMbps: number; bwlimitKiB: number }
  /** False when the cluster task log could not be read: whether a backup or a move is running is unknown. */
  tasksRead?: boolean
  /** Seconds the guest's last restart-move took, from the task log, when known. */
  lastMoveSec?: Record<Sid, number>
  unread?:  string[]
  now?:     number
}

const gib = (b: number) => `${(b / 1024 ** 3).toFixed(b >= 10 * 1024 ** 3 ? 0 : 1)} GiB`

/** "32G", "512M", "1T" → bytes. */
export function sizeBytes(v: string | undefined): number {
  const m = /^(\d+(?:\.\d+)?)([KMGT]?)$/i.exec(String(v ?? '').trim())
  if (!m) return 0
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2].toUpperCase() as '' | 'K' | 'M' | 'G' | 'T']
  return Math.round(Number(m[1]) * mult)
}

function volumeSize(config: Record<string, unknown> | null, key: string): number {
  const v = String(config?.[key] ?? '')
  return sizeBytes(/(?:^|,)size=([^,]+)/.exec(v)?.[1])
}

/** The reasons that hold wherever the guest would go. */
function everywhereReasons(g: HaGuest, hw: GuestHardware, input: EngineInput, ha: boolean): Reason[] {
  const out: Reason[] = []
  // Facts that could not be read make every verdict unknown: no hardware seen is not the same as no hardware.
  if (input.configs[g.sid] === null || input.configs[g.sid] === undefined) out.push({ code: 'unread', level: 'unknown', words: "Its configuration could not be read, so its devices, mounts, disks and CPU type are unknown. HyperProx does not move a guest it cannot see." })
  if (input.tasksRead === false) out.push({ code: 'unread', level: 'unknown', words: 'The cluster task log could not be read, so whether a backup or another move is running now is unknown.' })
  if (g.template) out.push({ code: 'template', level: 'block', words: 'It is a template: it never runs, so where it sits does not change any load. Clone it where you need it.' })
  for (const b of hw.bindMounts) out.push({ code: 'bind-mount', level: 'block', words: `A bind mount (${b.path}) without shared=1: Proxmox refuses to migrate it. If HA recovers it on another node after a failure, it cannot come back by a migration.` })
  if (input.migrating.includes(g.sid)) out.push({ code: 'migrating', level: 'block', words: 'It is being moved right now.' })
  if (input.backupsRunning.some(b => b.vmid === g.vmid)) out.push({ code: 'backup-running', level: 'block', words: 'It is being backed up right now.' })
  if (ha) out.push({ code: 'ha', level: 'info', words: 'HA manages it: a move goes through HA (the same as ha-manager migrate), so HA does not move it straight back.' })
  if (ha && input.snap.crs.mode === 'dynamic' && input.snap.crs.autoRebalance) {
    const res = input.snap.resources.find(r => r.sid === g.sid)
    if (res?.autoRebalance !== false) out.push({ code: 'crs', level: 'info', words: "Proxmox's own scheduler (dynamic CRS with auto-rebalance) already moves it when its node is busy; HyperProx does not suggest moves that compete with it." })
  }
  if (g.status === 'running' && g.type === 'lxc') {
    out.push({ code: 'restart', level: 'warn', words: 'A running container moves by restarting: it is stopped, moved and started again.' })
  }
  if (g.status !== 'running' && !g.template) out.push({ code: 'stopped', level: 'info', words: 'It is stopped: it moves offline, with no live copy.' })
  return out
}

function targetCheck(g: HaGuest, hw: GuestHardware, to: PlacementNode, input: EngineInput, rules: HaRule[]): TargetCheck {
  const reasons: Reason[] = []
  const add = (r: Reason) => reasons.push(r)
  const n = input.snap.nodes.find(x => x.node === to.node)
  if (!to.online) add({ code: 'offline', level: 'block', words: `${to.node} is offline.` })
  if (to.maintenance) add({ code: 'maintenance', level: 'block', words: `${to.node} is in HA maintenance mode.` })
  // Passed-through devices: fine where the device is known to exist too (a resource mapping), else not.
  // A /dev/dri render node exists on any node with an Intel or AMD GPU: checked over a node login, else unknown.
  for (const d of hw.devices) {
    if ((d.nodes ?? [g.node]).includes(to.node)) continue
    const dri = driPath(d.what)
    if (dri) {
      const seen = input.pathChecks?.[g.sid]?.[to.node]?.[dri]
      if (seen === true) continue
      if (seen === false) add({ code: 'gpu', level: 'block', words: `It uses ${dri} on ${g.node}; ${to.node} has no ${dri}.` })
      else add({ code: 'gpu', level: 'unknown', words: `It uses ${dri} on ${g.node}; whether ${to.node} has it has not been checked (it needs a login to ${to.node}).` })
      continue
    }
    if (d.kind === 'gpu') add({ code: 'gpu', level: 'block', words: `It uses ${d.what} on ${g.node}${d.required ? `; it will not start on ${to.node} without it` : `; on ${to.node} it would start without it`}.` })
    else if (d.required) add({ code: 'device', level: 'block', words: `It uses ${d.what} on ${g.node}; it will not start on ${to.node} without it.` })
    else add({ code: 'device', level: 'warn', words: `It uses ${d.what} on ${g.node}; on ${to.node} it runs without it.` })
  }
  // Shared bind mounts: the path must exist on the target. Checked over a node login, else unknown.
  for (const m of hw.sharedMounts) {
    const seen = input.pathChecks?.[g.sid]?.[to.node]?.[m.path]
    if (seen === true) continue
    if (seen === false) add({ code: 'shared-mount', level: 'block', words: `Its shared bind mount ${m.path} does not exist on ${to.node}.` })
    else add({ code: 'shared-mount', level: 'unknown', words: `Its bind mount ${m.path} is marked shared=1; whether that path exists on ${to.node} has not been checked (it needs a login to ${to.node}).` })
  }
  // Disks on node-local storage: copied across when the same storage exists there, else impossible.
  for (const l of hw.localVolumes) {
    const where = input.storageNodes[l.storage]
    const size = volumeSize(input.configs[g.sid] ?? null, l.key)
    if (where && !where.includes(to.node)) add({ code: 'local-disk', level: 'block', words: `Its disk ${l.key} is on "${l.storage}", which ${to.node} does not have.` })
    else if (!where) add({ code: 'local-disk', level: 'unknown', words: `Its disk ${l.key} is on "${l.storage}"; whether ${to.node} has that storage could not be read.` })
    else add({ code: 'local-disk', level: 'warn', words: `Its disk ${l.key} is on node-local "${l.storage}": ${size ? gib(size) : 'all of it'} is copied across the network.` })
  }
  // HA rules: the guest's node-affinity rule, and keep-apart / keep-together rules.
  const home = homeOf(rules, g.sid)
  if (home.rule && !home.rule.disabled) {
    if (home.avoid.length && home.avoid.includes(to.node)) add({ code: 'strict-rule', level: 'block', words: `Its HA rule "${home.rule.id}" keeps it off ${to.node}.` })
    const allowed = home.choice.tiers.flat()
    if (home.choice.mode === 'only' && !allowed.includes(to.node)) add({ code: 'strict-rule', level: 'block', words: `Its strict HA rule "${home.rule.id}" only allows ${list(allowed, 'or')}.` })
    if (home.choice.mode === 'prefer') {
      const top = home.choice.tiers[0] ?? []
      if (!top.includes(to.node)) {
        add({ code: 'prefer-rule', level: 'block', words: `Its HA rule "${home.rule.id}" prefers ${list(top, 'or')}: Proxmox only moves an HA guest by hand to its highest-ranked online nodes, and failback would bring it back. To run it elsewhere, change the rule.` })
      }
    }
  }
  for (const r of rules) {
    if (r.type !== 'resource-affinity' || r.disabled || !r.resources.includes(g.sid)) continue
    const others = r.resources.filter(s => s !== g.sid)
    if (r.affinity === 'negative') {
      const clash = others.filter(s => input.snap.guests.find(x => x.sid === s)?.node === to.node)
      if (clash.length) add({ code: 'apart-rule', level: 'block', words: `HA rule "${r.id}" keeps it apart from ${list(clash.map(s => nameOf(input.snap, s)))}, which ${clash.length === 1 ? 'runs' : 'run'} on ${to.node}.` })
    } else {
      add({ code: 'together-rule', level: 'warn', words: `HA rule "${r.id}" keeps it together with ${list(others.map(s => nameOf(input.snap, s)))}: HA moves ${others.length === 1 ? 'that one' : 'those'} too.` })
    }
  }
  // CPU: more vCPUs than the target has threads.
  if (g.cpus && to.threads && g.cpus > to.threads) {
    if (g.type === 'qemu') add({ code: 'cores', level: 'block', words: `It has ${g.cpus} vCPUs and ${to.node} has ${to.threads} threads: it will not start there.` })
    else add({ code: 'cores', level: 'warn', words: `It is allowed ${g.cpus} cores; ${to.node} has ${to.threads} threads, so it would get at most ${to.threads}.` })
  }
  // CPU type for a live VM move.
  if (g.type === 'qemu') {
    const r = cpuReason(cpuTypeOf(input.configs[g.sid]), g.status === 'running', input.nodeCpu[g.node] ?? { model: null, vendor: null, flags: null }, input.nodeCpu[to.node] ?? { model: null, vendor: null, flags: null }, to.node)
    if (r) add(r)
  }
  // Memory: what it uses must fit now; its limit should.
  if (!n || !(n.maxmem > 0)) {
    if (to.online) add({ code: 'memory', level: 'unknown', words: `${to.node}'s memory could not be read, so whether it has room is unknown.` })
  } else {
    const free = Math.max(0, n.maxmem - n.mem)
    const used = input.usage[g.sid]?.mem ?? 0
    const need = g.status === 'running' ? used : 0
    if (need && free < need) add({ code: 'memory', level: 'block', words: `It uses ${gib(need)} of memory; ${to.node} has ${gib(free)} free.` })
    else if (g.maxmem && free < g.maxmem && g.status === 'running') add({ code: 'memory', level: 'warn', words: `It may use up to ${gib(g.maxmem)}; ${to.node} has ${gib(free)} free now.` })
  }
  if (input.backupsRunning.some(b => b.node === to.node)) add({ code: 'backup-running', level: 'block', words: `A backup is running on ${to.node} right now.` })
  if (input.backupsRunning.some(b => b.node === g.node && b.vmid === undefined)) add({ code: 'backup-running', level: 'block', words: `A backup is running on ${g.node} right now.` })
  const verdict = reasons.some(r => r.level === 'block') ? 'no' : reasons.some(r => r.level === 'unknown') ? 'unknown' : 'ok'
  return { node: to.node, verdict, reasons: dedupe(reasons) }
}

const dedupe = (rs: Reason[]) => rs.filter((r, i) => rs.findIndex(x => x.words === r.words) === i)
const nameOf = (snap: HaSnapshot, sid: Sid) => { const g = snap.guests.find(x => x.sid === sid); return g?.name ? `${g.name} (${sid})` : sid }

/** Why the guest is on this node, as a person would put it. */
function whyHere(g: HaGuest, hw: GuestHardware, rules: HaRule[], nodes: PlacementNode[], everywhere: Reason[]): string[] {
  const out: string[] = []
  for (const d of hw.devices) out.push(`${d.what[0].toUpperCase()}${d.what.slice(1)} on ${g.node}.`)
  for (const b of hw.bindMounts) out.push(`A bind mount of ${b.path} from ${g.node}.`)
  if (hw.localVolumes.length) out.push(`${hw.localVolumes.length === 1 ? 'A disk' : `${hw.localVolumes.length} disks`} on ${g.node}'s own storage (${Array.from(new Set(hw.localVolumes.map(l => l.storage))).join(', ')}).`)
  const home = homeOf(rules, g.sid)
  if (home.rule && !home.rule.disabled && home.choice.tiers.length) {
    out.push(`HA rule "${home.rule.id}" ${home.choice.mode === 'only' ? 'only allows' : 'prefers'} ${list(home.choice.tiers[0], 'or')}${home.choice.mode === 'prefer' && home.choice.tiers.length > 1 ? `, then ${list(home.choice.tiers.slice(1).flat(), 'or')}` : ''}.`)
  }
  const small = nodes.filter(n => n.node !== g.node && n.threads && g.cpus > n.threads).map(n => n.node)
  if (g.type === 'qemu' && small.length) out.push(`${g.cpus} vCPUs: more than ${list(small)} ${small.length === 1 ? 'has' : 'have'}.`)
  if (everywhere.some(r => r.code === 'template')) out.push('A template: it never runs.')
  return out
}

/** The /dev/dri path a device line names, if any. */
export function driPath(what: string): string | null {
  return /\((\/dev\/dri(?:\/[A-Za-z0-9_-]+)?)\)/.exec(what)?.[1] ?? null
}

/** Paths that a node login can check on other nodes: shared bind mounts and /dev/dri devices. */
export function checkablePaths(hw: GuestHardware | undefined): string[] {
  if (!hw) return []
  return Array.from(new Set([...hw.sharedMounts.map(m => m.path), ...hw.devices.map(d => driPath(d.what)).filter((x): x is string => !!x)]))
}

export function placementMap(input: EngineInput): PlacementMap {
  const { snap } = input
  const rules = snap.rules
  const haSids = new Set(snap.resources.map(r => r.sid))
  const nodes: PlacementNode[] = snap.nodes.map(n => {
    const here = snap.guests.filter(g => g.node === n.node)
    const running = here.filter(g => g.status === 'running')
    const cpu = input.nodeCpu[n.node]
    return {
      node: n.node, online: n.online, maintenance: n.maintenance, threads: n.maxcpu,
      cpuModel: cpu?.model ?? null, cpuVendor: cpu?.vendor ?? null,
      cpu: n.cpu, mem: n.mem, maxmem: n.maxmem,
      cpusAssigned: running.reduce((a, g) => a + (g.cpus || 0), 0),
      memAssigned: running.reduce((a, g) => a + (g.maxmem || 0), 0),
      guests: here.map(g => g.sid),
    }
  })
  const guests: GuestPlacement[] = snap.guests.map(g => {
    const hw: GuestHardware = g.hardware ?? { bindMounts: [], sharedMounts: [], devices: [], localVolumes: [] }
    const ha = haSids.has(g.sid)
    const everywhere = everywhereReasons(g, hw, input, ha)
    // A reason that holds everywhere (a template, a plain bind mount) makes every target a no; one that could not
    // be checked anywhere (an unread config, an unread task log) makes every target at best unknown.
    const blocks = everywhere.filter(r => r.level === 'block')
    const unknowns = everywhere.filter(r => r.level === 'unknown')
    const targets = nodes.filter(n => n.node !== g.node).map(n => {
      const t = targetCheck(g, hw, n, input, rules)
      if (blocks.length) return { ...t, verdict: 'no' as const, reasons: dedupe([...blocks, ...unknowns, ...t.reasons]) }
      if (unknowns.length) return { ...t, verdict: t.verdict === 'no' ? 'no' as const : 'unknown' as const, reasons: dedupe([...unknowns, ...t.reasons]) }
      return t
    })
    const blockedEverywhere = everywhere.some(r => r.level === 'block')
    const ok = blockedEverywhere ? [] : targets.filter(t => t.verdict === 'ok').map(t => t.node)
    const unknown = blockedEverywhere ? [] : targets.filter(t => t.verdict === 'unknown').map(t => t.node)
    const movable = ok.length ? 'yes' : unknown.length ? 'unknown' : 'no'
    const cfg = input.configs[g.sid] ?? null
    const localBytes = hw.localVolumes.reduce((a, l) => a + volumeSize(cfg, l.key), 0)
    const memBytes = g.type === 'qemu' && g.status === 'running' ? (input.usage[g.sid]?.mem ?? g.maxmem) : 0
    const copyBytes = localBytes + memBytes
    const downtimeSec = g.type === 'lxc' && g.status === 'running'
      // Its last restart-move from the task log when there is one (never under 10 s: a stop and a start), else 20 s plus the copy.
      ? Math.max(10, input.lastMoveSec?.[g.sid] ?? 0) + (input.lastMoveSec?.[g.sid] ? 0 : 10 + copySeconds(localBytes, input.settings.linkMbps, input.settings.bwlimitKiB))
      : null
    // The reason that stops it, as a sentence: one that holds everywhere, else the one most targets share.
    const tally = new Map<string, { r: Reason; n: number }>()
    for (const t of targets) for (const r of t.reasons) if (r.level === 'block') {
      const k = r.code === 'gpu' || r.code === 'device' || r.code === 'local-disk' || r.code === 'cores' ? r.code + r.words.split(' on ')[0] : r.words
      const e = tally.get(k) ?? { r, n: 0 }; e.n++; tally.set(k, e)
    }
    const common = [...tally.values()].sort((a, b) => b.n - a.n)[0]?.r
    const firstBlock = everywhere.find(r => r.level === 'block') ?? common
    const summary = movable === 'yes'
      ? `Can move to ${list(ok, 'or')}${unknown.length ? `; ${list(unknown, 'and')} not checked` : ''}.`
      : movable === 'unknown'
        ? `Might move to ${list(unknown, 'or')}: not everything could be checked.`
        : firstBlock ? `Stays on ${g.node}: ${firstBlock.words}` : `Stays on ${g.node}: no other node fits right now.`
    return {
      sid: g.sid, vmid: g.vmid, type: g.type, name: g.name, node: g.node, status: g.status, template: g.template, ha,
      cpus: g.cpus, maxmem: g.maxmem, usage: input.usage[g.sid] ?? { cores: 0, mem: 0 },
      why: whyHere(g, hw, rules, nodes, everywhere), movable, summary, everywhere, targets, copyBytes, downtimeSec,
    }
  })
  return { nodes, guests, network: input.network, crs: snap.crs, unread: input.unread ?? [], at: input.now ?? Date.now() }
}
