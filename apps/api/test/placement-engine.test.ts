// Placement advisor engine on a fixture cluster (test/fakes/placement-cluster.ts): one big node with a GPU and local
// media, two small nodes, strict and non-strict HA rules, a VM with more vCPUs than the small nodes have, a template,
// a disk on node-local storage, a shared bind mount nobody has checked. Plus the CPU, network and quiet-window rules.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlacementService } from '../src/lib/placement/service'
import { MemoryPlacementStore } from '../src/lib/placement/store'
import { cpuReason, cpuTypeOf } from '../src/lib/placement/cpu'
import { networkCost, inCidr, copySeconds } from '../src/lib/placement/network'
import { parseCalendar, quietStatus, observedDurations, inBusyHours, localParts, busyHoursProblems } from '../src/lib/placement/windows'
import { countJournal, corosyncAround, corosyncWords } from '../src/lib/placement/corosync'
import { guestAnswer, guestIn } from '../src/lib/ai/placement-source'
import { placementFixture, fakePve } from './fakes/placement-cluster'

const NOW = Date.UTC(2026, 5, 15, 12, 0)

function service(fixture = placementFixture()) {
  const pve = fakePve(fixture)
  const svc = new PlacementService({
    pve: () => pve, prom: async () => [], store: new MemoryPlacementStore(), audit: async () => {}, isUnlocked: () => true,
    nodeExec: async () => null, now: () => NOW, cacheMs: 0,
  })
  return { svc, pve }
}
const guest = async (svc: PlacementService, sid: string) => (await svc.map()).map.guests.find(g => g.sid === sid)!
const target = (g: any, node: string) => g.targets.find((t: any) => t.node === node)

test('every guest is on the map, HA or not, with its node', async () => {
  const { svc } = service()
  const { map } = await svc.map()
  assert.deepEqual(map.guests.map(g => `${g.sid}@${g.node}`), ['ct:101@node1', 'ct:102@node2', 'vm:103@node1', 'vm:104@node3', 'ct:105@node2', 'vm:106@node3', 'ct:107@node1', 'ct:108@node2'])
  assert.deepEqual(map.guests.filter(g => g.ha).map(g => g.sid), ['ct:101', 'ct:102', 'ct:108'])
  const n1 = map.nodes.find(n => n.node === 'node1')!
  assert.equal(n1.threads, 24)
  assert.match(n1.cpuModel!, /AMD Example/)
  assert.deepEqual(n1.guests, ['ct:101', 'vm:103', 'ct:107'])
})

test('the GPU container with a plain bind mount and a strict rule cannot move, and says all three reasons', async () => {
  const { svc } = service()
  const g = await guest(svc, 'ct:101')
  assert.equal(g.movable, 'no')
  assert.ok(g.why.some(w => /NVIDIA GPU on node1/.test(w)), g.why.join(' | '))
  assert.ok(g.why.some(w => /bind mount of \/mnt\/media/.test(w)))
  assert.ok(g.why.some(w => /HA rule "gpu-lock" only allows node1/.test(w)))
  for (const node of ['node2', 'node3']) {
    const t = target(g, node)
    assert.equal(t.verdict, 'no')
    const codes = t.reasons.map((r: any) => r.code)
    for (const c of ['bind-mount', 'gpu', 'strict-rule']) assert.ok(codes.includes(c), `${node}: ${codes}`)
  }
  assert.match(g.summary, /^Stays on node1: /)
})

test('a non-strict preferred-node rule: no hand move to a lower-ranked node, and the reason says to change the rule', async () => {
  const { svc } = service()
  const g = await guest(svc, 'ct:102')
  const t = target(g, 'node3')
  assert.equal(t.verdict, 'no')
  const r = t.reasons.find((x: any) => x.code === 'prefer-rule')
  assert.match(r.words, /prefers node2/)
  assert.match(r.words, /change the rule/)
  assert.ok(g.why.some(w => /prefers node2, then node3/.test(w)))
})

test('more vCPUs than a node has threads: a VM cannot go there, and the why names the small nodes', async () => {
  const { svc } = service()
  const g = await guest(svc, 'vm:103')
  for (const node of ['node2', 'node3']) {
    const r = target(g, node).reasons.find((x: any) => x.code === 'cores')
    assert.equal(r.level, 'block')
    assert.match(r.words, /8 vCPUs and .* 4 threads/)
  }
  assert.ok(g.why.some(w => /8 vCPUs: more than node2 and node3 have/.test(w)))
  // cpu=host from an AMD node to an Intel one, live: refused too.
  assert.ok(target(g, 'node2').reasons.some((x: any) => x.code === 'cpu-type' && x.level === 'block'))
  assert.equal(g.movable, 'no')
})

test('a disk on node-local storage is copied: a warning with its size, and counted in the bytes to move', async () => {
  const { svc } = service()
  const g = await guest(svc, 'vm:104')
  const t = target(g, 'node1')
  assert.equal(t.verdict, 'ok')
  assert.match(t.reasons.find((x: any) => x.code === 'local-disk').words, /32 GiB is copied/)
  assert.equal(g.copyBytes, 32 * 1024 ** 3 + 2 * 1024 ** 3, 'the disk plus the running VM\'s memory')
  assert.equal(g.downtimeSec, null, 'a VM moves live')
})

test('a shared=1 bind mount is "unknown" until its path is checked on the target, never guessed', async () => {
  const { svc } = service()
  const g = await guest(svc, 'ct:105')
  assert.equal(g.movable, 'unknown')
  const r = target(g, 'node1').reasons.find((x: any) => x.code === 'shared-mount')
  assert.equal(r.level, 'unknown')
  assert.match(r.words, /has not been checked/)
  // With a node login the path is checked: present on node1, missing on node3.
  const pve = fakePve(placementFixture())
  const svc2 = new PlacementService({
    pve: () => pve, prom: async () => [], store: new MemoryPlacementStore(), audit: async () => {}, isUnlocked: () => true, now: () => NOW, cacheMs: 0,
    nodeExec: async (node, cmd) => { assert.match(cmd, /^test -e '\/mnt\/shared' && echo present \|\| echo absent$/); return { code: 0, output: node === 'node3' ? 'absent\n' : 'present\n' } },
  })
  await svc2.checkPaths('ct:105', { email: 'a@example.com' })
  const g2 = await guest(svc2, 'ct:105')
  assert.equal(target(g2, 'node1').verdict, 'ok')
  assert.equal(target(g2, 'node3').verdict, 'no')
  assert.equal(g2.movable, 'yes')
})

test('a template stays put everywhere; a running container shows its restart; a free guest can go anywhere', async () => {
  const { svc } = service()
  const t = await guest(svc, 'vm:106')
  assert.equal(t.movable, 'no')
  assert.ok(t.targets.every((x: any) => x.verdict === 'no' && x.reasons.some((r: any) => r.code === 'template')))
  const w = await guest(svc, 'ct:107')
  assert.equal(w.movable, 'yes')
  assert.deepEqual(w.targets.map((x: any) => x.verdict), ['ok', 'ok'])
  assert.ok(w.everywhere.some(r => r.code === 'restart'))
  assert.ok((w.downtimeSec ?? 0) >= 10)
  assert.deepEqual(w.why, [], 'nothing ties it to node1')
})

test('an HA guest the dynamic CRS balances is marked so; a backup running now blocks moves on that node', async () => {
  const f = placementFixture()
  f['/cluster/tasks'] = [{ type: 'vzdump', node: 'node1', id: '', starttime: NOW / 1000 - 60, upid: 'UPID:node1:1:2:3:vzdump::root@pam:' }]
  const { svc } = service(f)
  const h = await guest(svc, 'ct:108')
  assert.ok(h.everywhere.some(r => r.code === 'crs'))
  assert.ok(h.everywhere.some(r => r.code === 'ha'))
  assert.equal(target(h, 'node1').verdict, 'no')
  assert.match(target(h, 'node1').reasons.find((r: any) => r.code === 'backup-running').words, /backup is running on node1/)
  assert.equal(target(h, 'node3').verdict, 'ok')
})

test('CPU types: host needs the same model; x86-64 levels need their flags; generic and stopped are fine', () => {
  const amd = { model: 'AMD X', vendor: 'AuthenticAMD', flags: ['avx2', 'cx16', 'lahf_lm', 'popcnt', 'sse4_1', 'sse4_2', 'ssse3', 'aes'] }
  const intel = { model: 'Intel Y', vendor: 'GenuineIntel', flags: ['cx16', 'lahf_lm', 'popcnt', 'sse4_1', 'sse4_2', 'ssse3'] }
  assert.equal(cpuTypeOf({}), 'kvm64')
  assert.equal(cpuTypeOf({ cpu: 'cputype=host,flags=+aes' }), 'host')
  assert.equal(cpuReason('host', true, amd, intel, 'n2')?.level, 'block')
  assert.equal(cpuReason('host', true, amd, { ...amd }, 'n2'), null)
  assert.equal(cpuReason('host', false, amd, intel, 'n2'), null, 'stopped moves offline')
  assert.match(cpuReason('x86-64-v2-AES', true, amd, intel, 'n2')!.words, /needs aes/)
  assert.equal(cpuReason('x86-64-v2', true, amd, intel, 'n2'), null)
  assert.equal(cpuReason('kvm64', true, amd, intel, 'n2'), null)
  assert.equal(cpuReason('EPYC', true, amd, intel, 'n2')?.level, 'block')
  assert.equal(cpuReason('host', true, amd, { model: null, vendor: null, flags: null }, 'n2')?.level, 'unknown')
})

test('network: no migration network means moves share corosync; a separate one does not; a second ring is noted', () => {
  const nodes = [{ node: 'a', ring0_addr: '192.0.2.11' }, { node: 'b', ring0_addr: '192.0.2.12' }]
  const shared = networkCost({ corosyncNodes: nodes, options: {} })
  assert.equal(shared.shared, true)
  assert.equal(shared.suggestedBwlimit, 51200)
  assert.ok(shared.words.some(w => /single link/.test(w)))
  assert.equal(networkCost({ corosyncNodes: nodes, options: { migration: 'type=secure,network=198.51.100.0/24' } }).shared, false)
  assert.equal(networkCost({ corosyncNodes: nodes, options: { migration: { type: 'insecure', network: '192.0.2.0/24' } } }).shared, true)
  const two = networkCost({ corosyncNodes: nodes.map((n, i) => ({ ...n, ring1_addr: `198.51.100.${i + 1}` })), options: { bwlimit: 'migration=20480' } })
  assert.equal(two.redundantRing, true)
  assert.equal(two.datacenterBwlimit, 20480)
  assert.equal(networkCost({ corosyncNodes: null, options: {} }).shared, null, 'unknown, not guessed')
  assert.equal(inCidr('192.0.2.200', '192.0.2.0/25'), false)
  assert.equal(inCidr('node-a.example', '192.0.2.0/24'), null)
  assert.equal(copySeconds(1000 * 1024 * 1024, 1000, 51200), 20, '1000 MiB at 50 MiB/s')
})

test('calendar events: the forms Proxmox backup jobs use, and an unreadable one is null', () => {
  const d = parseCalendar('02:00')!
  assert.deepEqual([d.days.size, [...d.hours], [...d.minutes]], [7, [2], [0]])
  assert.deepEqual([...parseCalendar('sun 01:00')!.days], [0])
  assert.deepEqual([...parseCalendar('mon..fri 22:30')!.days].sort(), [1, 2, 3, 4, 5])
  assert.deepEqual([...parseCalendar('sat,sun 03:00')!.days].sort(), [0, 6])
  assert.deepEqual([...parseCalendar('*/15')!.minutes], [0, 15, 30, 45])
  assert.deepEqual([...parseCalendar('daily')!.hours], [0])
  assert.equal(parseCalendar('2026-12-24 02:00'), null)
  assert.equal(parseCalendar('whenever'), null)
})

test('quiet windows: a backup job and the margin before it are not quiet; the next quiet stretch comes after it', () => {
  const settings = { avoidBackups: true, backupHours: 1, backupMarginMin: 30, busyHours: [] }
  const jobs = [{ id: 'nightly', schedule: '02:00', enabled: true }]
  const at = (h: number, m = 0) => Date.UTC(2026, 5, 15, h, m)
  assert.equal(quietStatus({ now: at(1, 0), tz: 'UTC', jobs, settings, needSec: 600 }).quietNow, true)
  const before = quietStatus({ now: at(1, 45), tz: 'UTC', jobs, settings, needSec: 600 })
  assert.equal(before.quietNow, false)
  assert.match(before.nowWhy[0], /starts at 02:00/)
  assert.equal(before.nextQuiet!.start, at(3, 1), 'after the hour-long job')
  assert.equal(quietStatus({ now: at(2, 30), tz: 'UTC', jobs, settings }).quietNow, false)
  assert.equal(quietStatus({ now: at(2, 30), tz: 'UTC', jobs, settings: { ...settings, avoidBackups: false } }).quietNow, true, 'the setting turns it off')
  const odd = quietStatus({ now: at(12), tz: 'UTC', jobs: [{ id: 'x', schedule: '2026-12-24 02:00', enabled: true }], settings })
  assert.equal(odd.unread.length, 1, 'an unreadable schedule is reported')
})

test('busy hours cross midnight; their days are the start day; malformed ones are refused', () => {
  const late = [{ days: [6], start: '22:00', end: '06:00', label: 'viewing' }]   // Saturday night into Sunday
  const sat2300 = localParts(Date.UTC(2026, 5, 13, 23, 0), 'UTC')   // 2026-06-13 is a Saturday
  const sun0559 = localParts(Date.UTC(2026, 5, 14, 5, 59), 'UTC')
  const sun0601 = localParts(Date.UTC(2026, 5, 14, 6, 1), 'UTC')
  assert.ok(inBusyHours(sat2300, late))
  assert.ok(inBusyHours(sun0559, late))
  assert.equal(inBusyHours(sun0601, late), null)
  const q = quietStatus({ now: Date.UTC(2026, 5, 13, 23, 0), tz: 'UTC', jobs: [], settings: { avoidBackups: true, backupHours: 1, backupMarginMin: 0, busyHours: late } })
  assert.equal(q.quietNow, false)
  assert.match(q.nowWhy[0], /busy hours \(viewing\)/)
  assert.equal(q.nextQuiet!.start, Date.UTC(2026, 5, 14, 6, 0))
  assert.equal(busyHoursProblems([{ days: [], start: '25:00', end: '06:00' }]).length, 2)
})

test('time zones: a 02:00 job in the cluster zone is 06:00 UTC in summer for UTC-4', () => {
  const q = quietStatus({ now: Date.UTC(2026, 5, 15, 6, 10), tz: 'America/New_York', jobs: [{ id: 'n', schedule: '02:00', enabled: true }], settings: { avoidBackups: true, backupHours: 1, backupMarginMin: 0, busyHours: [] } })
  assert.equal(q.quietNow, false)
})

test('a job\'s length comes from its last runs in the task log, from the first start to the last end', () => {
  const t0 = Date.UTC(2026, 5, 14, 2, 0) / 1000
  const tasks = [
    { type: 'vzdump', starttime: t0 + 5, endtime: t0 + 1800, node: 'a' },
    { type: 'vzdump', starttime: t0 + 60, endtime: t0 + 5400, node: 'b' },
    { type: 'vzdump', starttime: t0 + 7 * 3600, endtime: t0 + 8 * 3600, node: 'a' },   // not at the job's minute
  ]
  assert.deepEqual(observedDurations([{ id: 'n', schedule: '02:00', enabled: true }], tasks, 'UTC'), { n: 5395 })
})

test('corosync: counts from the journal around a move, a baseline before it, and "unavailable" without a login', async () => {
  assert.deepEqual(countJournal([
    '[KNET  ] link: host: 2 link: 0 is down', '[TOTEM ] Retransmit List: 1a 1b', '[TOTEM ] Retransmit List: 1c',
    '[TOTEM ] Token has not been received in 3000 ms', '[QUORUM] Sync members[4]: 1 2 3 4', '[TOTEM ] A new membership (1.2b) was formed.',
  ].join('\n')), { retransmits: 2, linkDown: 1, tokenLost: 1, membership: 1 })
  const T = 1_790_000_000
  const none = await corosyncAround({ exec: async () => null }, ['a', 'b'], T, T + 1000)
  assert.deepEqual(none.checked, [])
  assert.match(none.unavailable!, /no working login/)
  assert.match(corosyncWords(none), /node login/)
  const cmds: string[] = []
  const some = await corosyncAround({ exec: async (_n, c) => { cmds.push(c); return { code: 0, output: c.includes(`--since @${T - 300} `) ? 'Retransmit List: 1\n' : '' } } }, ['a'], T, T + 1000)
  assert.equal(some.retransmits, 1)
  assert.equal(some.before!.retransmits, 0, 'the stretch before was quiet')
  assert.equal(cmds.length, 2)
  assert.ok(cmds.every(c => /^journalctl -u corosync --since @\d+ --until @\d+ /.test(c)))
  assert.match(corosyncWords(some), /1 retransmit/)
})

test('the assistant: "why is X on node1" and "where should X run" come from the engine, with no model', async () => {
  const { svc } = service()
  const { map } = await svc.map()
  assert.equal(guestIn('where should worker run?', map.guests)?.sid, 'ct:107')
  assert.equal(guestIn('can 103 move', map.guests)?.sid, 'vm:103')
  const why = guestAnswer('why is media on node1?', map)!
  assert.match(why, /media \(ct:101\) is on node1\. .*NVIDIA GPU/)
  const where = guestAnswer('where should worker run', map)!
  assert.match(where, /could run on node2, node3/)
  assert.match(where, /I cannot move anything/)
  assert.equal(guestAnswer('where should nothing-here run', map), null)
})
