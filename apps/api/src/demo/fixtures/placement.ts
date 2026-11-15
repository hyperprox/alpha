// Demo fixtures: Load balancing (the /balance page and its settings): an uneven invented cluster, a proposed plan,
// a history of moves and plans, and automatic mode in "notify only". Shapes follow apps/frontend/components/placement/types.ts.
import type { FixtureRoute } from './types'
import { NODES, GUESTS, GiB, HOUR, MIN, DAY, wobble, sidOf, type DemoGuest } from './data'

const ok = (data: unknown) => ({ success: true, data })
const THREADS: Record<string, number> = Object.fromEntries(NODES.map(n => [n.node, n.cores]))
const MAXMEM: Record<string, number> = Object.fromEntries(NODES.map(n => [n.node, n.memGiB * GiB]))
const VENDOR: Record<string, string> = { 'pve-a': 'AuthenticAMD', 'pve-b': 'GenuineIntel', 'pve-c': 'AuthenticAMD' }

/** What each node carries over the window, as a share of its own capacity: pve-c is the busy one. */
const LOAD: Record<string, { cpu: [number, number, number]; mem: [number, number, number] }> = {
  'pve-a': { cpu: [0.14, 0.22, 0.12], mem: [0.46, 0.38, 0.36] },
  'pve-b': { cpu: [0.22, 0.31, 0.2], mem: [0.58, 0.55, 0.53] },
  'pve-c': { cpu: [0.31, 0.74, 0.58], mem: [0.52, 0.76, 0.7] },
}

type Goal = 'mem' | 'cpu' | 'both'
const GOALS: Goal[] = ['mem', 'cpu', 'both']
const scoreOf = (nodes: Array<{ cpu: number; mem: number }>, goal: Goal) => {
  const k = nodes.map(n => (goal === 'cpu' ? n.cpu : goal === 'mem' ? n.mem : (n.cpu + n.mem) / 2))
  const spread = Math.max(...k) - Math.min(...k)
  const cpus = nodes.map(n => n.cpu), mems = nodes.map(n => n.mem)
  return { spread, cpuSpread: Math.max(...cpus) - Math.min(...cpus), memSpread: Math.max(...mems) - Math.min(...mems), score: Math.round((1 - spread) * 1000) / 10, k }
}

// -- guests ---------------------------------------------------------------------------------------
const reason = (code: string, level: 'block' | 'unknown' | 'warn' | 'info', words: string) => ({ code, level, words })

/** Why a guest can or cannot move, per node. The GPU, media bind mounts and a local disk pin guests the way a real cluster does. */
function guestRules(g: DemoGuest, target: string) {
  const out: ReturnType<typeof reason>[] = []
  const gpuHome = NODES.find(n => n.gpu?.dedicated)!.node
  if (g.gpu && target !== g.node && !(NODES.find(n => n.node === target)?.gpu)) out.push(reason('gpu', 'block', `${g.name} uses the GPU in ${g.node}; ${target} has none.`))
  if (g.gpu && target !== g.node && NODES.find(n => n.node === target)?.gpu && target !== gpuHome) out.push(reason('gpu', 'block', `${target} has a different GPU, and the container is set up for ${g.node}'s.`))
  if (['arr-stack', 'unmanic', 'plex'].includes(g.name) && target !== g.node) out.push(reason('bind-mount', 'block', `It mounts the media folder from ${g.node}; that path does not exist on ${target}.`))
  if (g.name === 'minecraft' && target !== g.node) out.push(reason('shared-mount', 'unknown', `Whether ${target} has the same world folder (/srv/minecraft) has not been checked.`))
  if (g.ha && target !== g.node && ['plex', 'arr-stack'].includes(g.name)) out.push(reason('prefer-rule', 'info', 'HA rule media-on-pve-c prefers pve-c; a move away is undone by HA.'))
  return out
}

export function placementGuest(g: DemoGuest) {
  const on = g.status === 'running'
  const targets = NODES.filter(n => n.node !== g.node).map(n => {
    const reasons = guestRules(g, n.node)
    const blocked = reasons.some(r => r.level === 'block')
    const unknown = reasons.some(r => r.level === 'unknown')
    if (!blocked && !unknown && n.cores < g.cores) reasons.push(reason('cores', 'block', `${n.node} has ${n.cores} threads; the guest is set to ${g.cores}.`))
    const verdict = reasons.some(r => r.level === 'block') ? 'no' as const : unknown ? 'unknown' as const : 'ok' as const
    return { node: n.node, verdict, reasons }
  })
  const everywhere = g.name === 'backup-server' ? [reason('local-disk', 'warn', 'Its disk is on local-lvm, so it is copied to the other node (about 13 GiB used).')] : []
  const allBlocked = targets.every(t => t.verdict === 'no')
  const anyUnknown = targets.some(t => t.verdict === 'unknown') && !targets.some(t => t.verdict === 'ok')
  const movable = allBlocked ? 'no' as const : anyUnknown ? 'unknown' as const : 'yes' as const
  const why = allBlocked ? [...new Set(targets.flatMap(t => t.reasons.filter(r => r.level === 'block').map(r => r.words)))].slice(0, 2)
    : [g.ha ? `HA keeps it on ${g.node} while it is up.` : `Placed on ${g.node} by hand; no rule keeps it here.`]
  const copy = g.name === 'backup-server' ? Math.round(13 * GiB) : 0
  return {
    sid: sidOf(g), vmid: g.vmid, type: g.type, name: g.name, node: g.node, status: g.status, template: false, ha: !!g.ha,
    cpus: g.cores, maxmem: g.memGiB * GiB, usage: { cores: on ? +(wobble(g.cpu * g.cores, g.cores * 0.02, g.name)).toFixed(2) : 0, mem: on ? Math.round(g.memUse * g.memGiB * GiB) : 0 },
    why, movable,
    summary: movable === 'no' ? `Stays on ${g.node}: ${why[0]}` : movable === 'unknown' ? 'Could move, but a path on the other nodes has not been checked.' : `Can move to ${targets.filter(t => t.verdict === 'ok').map(t => t.node).join(' or ')}.`,
    everywhere, targets,
    copyBytes: copy, downtimeSec: g.type === 'lxc' ? (on ? 25 : null) : on ? 1 : null,
  }
}

function mapView() {
  const guests = GUESTS.map(placementGuest)
  const nodes = NODES.map(n => {
    const mine = GUESTS.filter(g => g.node === n.node)
    return {
      node: n.node, online: true, maintenance: false, threads: n.cores, cpuModel: n.cpuModel, cpuVendor: VENDOR[n.node],
      cpu: wobble(n.cpu, 0.03, n.node), mem: Math.round(wobble(n.mem, 0.01, n.node + 'm') * n.memGiB * GiB), maxmem: n.memGiB * GiB,
      cpusAssigned: mine.reduce((a, g) => a + g.cores, 0), memAssigned: mine.reduce((a, g) => a + g.memGiB * GiB, 0), guests: mine.map(sidOf),
    }
  })
  return {
    map: {
      nodes, guests,
      network: { shared: true, migrationNetwork: null, corosyncAddresses: NODES.map(n => n.ip), redundantRing: false, datacenterBwlimit: null, suggestedBwlimit: 51200,
        words: ['Moves share the 1 Gbit network the cluster heartbeat (corosync) uses, so HyperProx limits each copy to 50 MiB/s.', 'Guests on shared storage (vm-pool) copy almost nothing: only the configuration moves.'] },
      crs: { mode: 'static', autoRebalance: false }, unread: [], at: Date.now(),
    },
    quiet: quiet(), settings: settings(),
    jobs: [{ id: 'backup-nightly', schedule: '02:00', enabled: true, durationSec: 5400 }, { id: 'backup-weekly', schedule: 'sun 01:00', enabled: true, durationSec: 9000 }],
  }
}

function settings() {
  return {
    avoidBackups: true, backupHours: 3, backupMarginMin: 30,
    busyHours: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '18:00', end: '23:30', label: 'Evening viewing' }],
    bwlimitKiB: 51200, linkMbps: 1000, cpuAbove: 0.8, memAbove: 0.9, minHours: 4, windowHours: 72,
    balanceGoal: 'both' as Goal, unevenAbove: 0.25, minGain: 5, maxPlanMoves: 4,
  }
}

/** Quiet by day (09:00–17:00 UTC), busy in the evening and through the nightly backup. */
function quiet() {
  const now = Date.now(), d = new Date(now), h = d.getUTCHours() + d.getUTCMinutes() / 60
  const day0 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  const win = (dayOffset: number) => ({ start: day0 + dayOffset * DAY + 9 * HOUR, end: day0 + dayOffset * DAY + 17 * HOUR })
  const quietNow = h >= 9 && h < 17
  const next = quietNow ? win(0) : h < 9 ? win(0) : win(1)
  return {
    quietNow,
    nowWhy: quietNow ? [] : h >= 17.5 && h < 23.5 ? ['It is evening viewing time (18:00 to 23:30)'] : h >= 1.5 && h < 5 ? ['Nightly backups run from 02:00'] : ['Outside the quiet window (09:00 to 17:00)'],
    nextQuiet: next, upcoming: [0, 1, 2, 3, 4].map(i => ({ ...win(i), reason: 'no backup, and CPU and RAM low on every node' })).filter(w => w.end > now),
    unread: [], tz: 'UTC',
  }
}

// -- balance --------------------------------------------------------------------------------------
const GUEST_LOAD: Record<string, { cores: number; mem: number }> = { 'ct:305': { cores: 2.6, mem: 6.2 * GiB }, 'vm:306': { cores: 1.9, mem: 9 * GiB } }
const PLAN_MOVES: Array<{ sid: string; to: string }> = [{ sid: 'ct:305', to: 'pve-a' }, { sid: 'vm:306', to: 'pve-a' }]

function history(node: string, kind: 'cpu' | 'mem') {
  const [now, p95, mean] = LOAD[node][kind]
  const t1 = Date.now(), n = 72
  return Array.from({ length: n }, (_, i) => {
    const t = t1 - (n - 1 - i) * HOUR, wave = Math.sin(i / 4 + node.length) * 0.5 + Math.sin(i * 1.7) * 0.2
    const evening = ((new Date(t).getUTCHours() + 24 - 18) % 24) < 5 ? 1 : 0
    return [t, Math.max(0.02, Math.min(0.98, mean + (p95 - mean) * (0.35 * wave + 0.65 * evening) + (i === n - 1 ? now - mean : 0)))] as [number, number]
  })
}

function nodeLoads() {
  return NODES.map(n => {
    const L = LOAD[n.node]
    return {
      node: n.node, online: true, maintenance: false, counted: true, threads: n.cores, maxmem: n.memGiB * GiB,
      cpu: { now: wobble(L.cpu[0], 0.03, n.node), p95: L.cpu[1], mean: L.cpu[2] }, mem: { now: wobble(L.mem[0], 0.01, n.node + 'm'), p95: L.mem[1], mean: L.mem[2] },
      cpuShare: 0, memShare: 0, history: { cpu: history(n.node, 'cpu'), mem: history(n.node, 'mem') },
    }
  }).map((x, _i, all) => {
    const tc = all.reduce((a, y) => a + y.cpu.p95 * y.threads, 0), tm = all.reduce((a, y) => a + y.mem.p95 * y.maxmem, 0)
    return { ...x, cpuShare: x.cpu.p95 * x.threads / tc, memShare: x.mem.p95 * x.maxmem / tm }
  })
}

function balance(goal: Goal) {
  const loads = nodeLoads()
  const start = loads.map(n => ({ node: n.node, cpu: n.cpu.p95, mem: n.mem.p95 }))
  const before = scoreOf(start, goal)
  const cur = start.map(n => ({ ...n }))
  const steps = PLAN_MOVES.map((m, i) => {
    const g = GUESTS.find(x => sidOf(x) === m.sid)!, l = GUEST_LOAD[m.sid]
    const f = cur.find(n => n.node === g.node)!, t = cur.find(n => n.node === m.to)!
    const bf = { cpu: f.cpu, mem: f.mem }, bt = { cpu: t.cpu, mem: t.mem }
    f.cpu -= l.cores / THREADS[f.node]; f.mem -= l.mem / MAXMEM[f.node]
    t.cpu += l.cores / THREADS[t.node]; t.mem += l.mem / MAXMEM[t.node]
    const sc = scoreOf(cur, goal)
    return {
      n: i + 1, sid: m.sid, name: g.name, type: g.type, ha: !!g.ha, from: g.node, to: m.to, method: 'migrate' as const, load: l,
      before: { from: bf, to: bt }, after: { from: { cpu: f.cpu, mem: f.mem }, to: { cpu: t.cpu, mem: t.mem } },
      gain: 0, scoreAfter: sc.score,
      downtimeSec: g.type === 'lxc' ? 25 : 1, copyBytes: 0, copySec: 0, bwlimitKiB: 51200,
      why: [`${g.node} is the busiest node; ${m.to} has the most room.`, g.type === 'lxc' ? 'A container restarts on the other node (about 25 s offline).' : 'A VM moves live; its disks stay on shared storage.'],
    }
  })
  let prev = before.score
  steps.forEach(s => { s.gain = Math.round((s.scoreAfter - prev) * 10) / 10; prev = s.scoreAfter })
  const after = scoreOf(cur, goal)
  const busiest = loads.slice().sort((a, b) => b.cpu.p95 + b.mem.p95 - a.cpu.p95 - a.mem.p95)[0].node
  const idlest = loads.slice().sort((a, b) => a.cpu.p95 + a.mem.p95 - b.cpu.p95 - b.mem.p95)[0].node
  const sc = (s: ReturnType<typeof scoreOf>) => ({ score: s.score, spread: s.spread, cpuSpread: s.cpuSpread, memSpread: s.memSpread, busiest, idlest })
  const unevenAbove = settings().unevenAbove
  const uneven = before.spread > unevenAbove
  const pc = (v: number) => `${Math.round(v * 100)}%`
  const b = loads.find(n => n.node === busiest)!, i = loads.find(n => n.node === idlest)!
  return {
    goal, uneven,
    headline: uneven ? `${busiest} is carrying the cluster: ${pc(b.cpu.p95)} CPU and ${pc(b.mem.p95)} RAM at its busiest, against ${pc(i.cpu.p95)} and ${pc(i.mem.p95)} on ${idlest}.` : 'The cluster is evenly loaded.',
    nodes: loads, score: sc(before),
    plan: {
      goal, score: sc(before), target: sc(after), steps,
      suggestions: [{ kind: 'edit-rule' as const, sid: 'ct:302', name: 'arr-stack', from: 'pve-c', to: 'pve-a', rule: 'media-on-pve-c', gain: 6.5,
        words: 'arr-stack (302) is held on pve-c by the HA rule media-on-pve-c. Letting it prefer pve-a as well would even the cluster by about 6 points; that is a change to the rule on the HA page, not a move.' }],
      nodesAfter: cur.map(n => ({ node: n.node, cpu: n.cpu, mem: n.mem })), needSec: 4 * 60,
      left: ['plex (301) and unmanic (303) use the GPU in pve-c, so they stay.'],
      words: [`Two moves lift the score from ${Math.round(before.score)} to ${Math.round(after.score)}.`, 'Only guests that HA does not manage are moved by the plan; HA guests get a suggestion instead.'],
    },
    recent: { hours: 72, covered: 69 }, unread: [],
    quiet: quiet(), crs: { mode: 'static', autoRebalance: false }, network: mapView().map.network, window: { hours: 72, stepSec: 3600 },
    settings: { balanceGoal: settings().balanceGoal, unevenAbove, minGain: 5, maxPlanMoves: 4, cpuAbove: 0.8, memAbove: 0.9 },
    auto: auto(), running: null, plans: plans(),
  }
}

function auto() {
  return {
    settings: { enabled: true, apply: false, sustainHours: 6, checkEveryMin: 30, maxMovesPerDay: 2, minHoursBetween: 6 },
    approval: null, epoch: 3,
    state: { lastCheckAt: Date.now() - 11 * MIN, lastWhy: 'pve-c has been the busiest node for 9 of the last 12 hours, but the last plan ran 2 days ago and the minimum gap is 6 hours of quiet time.', lastNotifiedAt: Date.now() - 2 * DAY, lastNotifiedSig: 'pve-c>pve-a' },
  }
}

// -- history --------------------------------------------------------------------------------------
const stepRec = (sid: string, name: string, from: string, to: string, ago: number, status: 'done' | 'failed' | 'skipped' = 'done') =>
  ({ sid, name, from, to, method: 'migrate' as const, status, moveId: `mv-${sid.replace(':', '')}-${Math.round(ago / HOUR)}`, error: status === 'failed' ? 'the guest did not stop within 60 s' : null, startedAt: Date.now() - ago, endedAt: Date.now() - ago + 3 * MIN })
function plans() {
  return [
    { id: 'plan-3', source: 'auto' as const, status: 'done' as const, by: null, goal: 'both' as Goal, scoreBefore: 61.2, scoreTarget: 80.4, steps: [stepRec('ct:305', 'minecraft', 'pve-c', 'pve-a', 2 * DAY + 3 * HOUR)], scheduledFor: null, startedAt: Date.now() - 2 * DAY - 3 * HOUR, endedAt: Date.now() - 2 * DAY - 3 * HOUR + 4 * MIN, error: null, stopRequested: false },
    { id: 'plan-2', source: 'manual' as const, status: 'done' as const, by: 'alex@example.com', goal: 'mem' as Goal, scoreBefore: 54.8, scoreTarget: 78.0, steps: [stepRec('vm:306', 'ubuntu-dev', 'pve-c', 'pve-b', 9 * DAY), stepRec('ct:204', 'gitea', 'pve-b', 'pve-a', 9 * DAY - 6 * MIN)], scheduledFor: null, startedAt: Date.now() - 9 * DAY, endedAt: Date.now() - 9 * DAY + 11 * MIN, error: null, stopRequested: false },
    { id: 'plan-1', source: 'manual' as const, status: 'stopped' as const, by: 'sam@example.com', goal: 'cpu' as Goal, scoreBefore: 66.0, scoreTarget: 82.0, steps: [stepRec('ct:208', 'blog', 'pve-b', 'pve-a', 21 * DAY), { ...stepRec('ct:203', 'immich', 'pve-b', 'pve-a', 21 * DAY - 5 * MIN, 'skipped'), error: 'stopped before this step' }], scheduledFor: null, startedAt: Date.now() - 21 * DAY, endedAt: Date.now() - 21 * DAY + 5 * MIN, error: null, stopRequested: true },
  ]
}

const corosync = (r: number) => ({ checked: NODES.map(n => n.node), retransmits: r, linkDown: 0, tokenLost: 0, membership: 0 })
const move = (id: string, sid: string, name: string, from: string, to: string, ago: number, status: 'done' | 'failed' | 'scheduled' | 'skipped', source: 'hyperprox' | 'proxmox', by: string | null, extra: Record<string, unknown> = {}) => ({
  id, sid, name, fromNode: from, toNode: to, source, method: source === 'proxmox' ? null : 'migrate' as const, status, upid: `UPID:${from}:0001A2B${id.length}:0:0:vzmigrate:${sid.split(':')[1]}:hyperprox@pve:`, by,
  scheduledFor: status === 'scheduled' ? Date.now() + ago : null, startedAt: status === 'scheduled' ? null : Date.now() - ago, endedAt: status === 'scheduled' ? null : Date.now() - ago + (status === 'failed' ? 90_000 : 190_000),
  error: status === 'failed' ? 'migration aborted: target storage local-lvm has too little free space' : null, bwlimitKiB: source === 'hyperprox' ? 51200 : null,
  corosync: status === 'done' && source === 'hyperprox' ? corosync(4) : null, ...extra,
})
function moves() {
  return [
    move('mv-sched', 'ct:208', 'blog', 'pve-b', 'pve-a', 9 * HOUR, 'scheduled', 'hyperprox', 'alex@example.com'),
    move('mv-305-51', 'ct:305', 'minecraft', 'pve-c', 'pve-a', 2 * DAY + 3 * HOUR, 'done', 'hyperprox', null),
    move('mv-306-216', 'vm:306', 'ubuntu-dev', 'pve-c', 'pve-b', 9 * DAY, 'done', 'hyperprox', 'alex@example.com'),
    move('mv-204-216b', 'ct:204', 'gitea', 'pve-b', 'pve-a', 9 * DAY - 6 * MIN, 'done', 'hyperprox', 'alex@example.com'),
    move('mv-px-1', 'ct:205', 'wireguard', 'pve-a', 'pve-b', 12 * DAY, 'done', 'proxmox', 'root@pam'),
    move('mv-208-500', 'ct:208', 'blog', 'pve-b', 'pve-a', 21 * DAY, 'done', 'hyperprox', 'sam@example.com'),
    move('mv-307-fail', 'vm:307', 'windows-11', 'pve-c', 'pve-b', 26 * DAY, 'failed', 'hyperprox', 'alex@example.com', { corosync: null }),
    move('mv-px-2', 'vm:106', 'backup-server', 'pve-a', 'pve-b', 40 * DAY, 'done', 'proxmox', 'root@pam'),
  ]
}

function advice() {
  const L = LOAD
  const pressure = NODES.map(n => ({ node: n.node, cpuHours: n.node === 'pve-c' ? 11 : 0, memHours: n.node === 'pve-c' ? 14 : 0, covered: 69, busy: n.node === 'pve-c', cpuP95: L[n.node].cpu[1], memP95: L[n.node].mem[1],
    words: n.node === 'pve-c' ? 'CPU over 80% for 11 hours and RAM over 90% for 14 hours of the last 69 read.' : 'Under the lines the whole window.' }))
  return {
    balanced: false, headline: 'pve-c has been under pressure for most of the last three days.', pressure,
    suggestions: [
      { kind: 'move' as const, sid: 'ct:305', name: 'minecraft', from: 'pve-c', to: 'pve-a', why: ['It is the heaviest guest that is free to move.', 'pve-a has the most room on both CPU and RAM.'], effect: { from: { before: 0.74, after: 0.63 }, to: { before: 0.22, after: 0.38 }, metric: 'cpu' as const } },
      { kind: 'edit-rule' as const, sid: 'ct:302', name: 'arr-stack', from: 'pve-c', to: 'pve-a', rule: 'media-on-pve-c', why: ['HA keeps it on pve-c while pve-c is up.'], effect: { from: { before: 0.76, after: 0.7 }, to: { before: 0.38, after: 0.44 }, metric: 'mem' as const } },
    ],
    stuck: ['plex (301) stays on pve-c: it uses the GPU, which no other node has.', 'unmanic (303) stays on pve-c for the same reason.'],
    evidence: ['pve-c: CPU p95 74%, RAM p95 76% over the last 72 hours.', 'pve-a: CPU p95 22%, RAM p95 38%.', 'Backup windows (02:00–03:30) are left out of every figure.'],
    unread: [], window: { hours: 72, stepSec: 3600, cpuAbove: 0.8, memAbove: 0.9, minHours: 4, backupHoursSkipped: 3 },
  }
}

export const PLACEMENT_ROUTES: FixtureRoute[] = [
  { path: '/api/placement/map', get: () => ok(mapView()) },
  { path: '/api/placement/advice', get: () => ok(advice()) },
  { path: '/api/placement/balance', get: (_p, q) => ok(balance(GOALS.includes(q.goal as Goal) ? q.goal as Goal : 'both')) },
  { path: '/api/placement/moves', get: () => ok(moves()) },
  { path: '/api/placement/moves/:id', get: p => ok(moves().find(m => m.id === p.id) ?? moves()[1]) },
  { path: '/api/placement/plans', get: () => ok(plans()) },
  { path: '/api/placement/plans/:id', get: p => ok(plans().find(x => x.id === p.id) ?? plans()[0]) },
  { path: '/api/placement/settings', get: () => ok(settings()) },
  { path: '/api/placement/auto', get: () => ok(auto()) },
  { path: '/api/placement/guests/:type/:vmid/paths', get: () => ok({ checked: NODES.map(n => n.node), paths: [] }) },
]
