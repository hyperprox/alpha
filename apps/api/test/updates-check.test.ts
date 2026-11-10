// The daily updates check: read-only on every cluster, staggered, skips a cluster that does not answer or is
// backing up, never runs during a job, notifies only about NEW findings (a weekly reminder at most), reports held
// packages as held, follows each cluster's own policy, and sends counts and names only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UpdatesChecker, MemoryCheckState, buildMessage, stripAddresses, type CheckClusterHandle } from '../src/lib/updates/check'
import { parsePolicy, policyForCluster, type PolicyLoad } from '../src/lib/updates/policy'
import { matches } from '../src/lib/notify/dispatcher'
import { FakeCluster, node as homeNode, guest as homeGuest, pkg as homePkg } from './updates-fake'
import { standaloneServer, pkg } from './updates-remote-fake'

const HOME = { id: 'home', name: 'Home cluster', kind: 'home' as const }
const REMOTE = { id: 'c0123456789', name: "Remote server 10.0.0.9", kind: 'remote' as const }
const HOME_YAML = 'nodes:\n  node-a: { upgrade: upgrade, require_holds: [proxmox-default-kernel] }\ncheck:\n  cron: "30 6 * * *"\n  reminder_days: 7\n'

function setup(opts: { yaml?: string; unlocked?: boolean; active?: boolean } = {}) {
  const file: PolicyLoad = { loaded: true, path: '/t', policy: parsePolicy(opts.yaml ?? HOME_YAML) }
  const home = new FakeCluster({
    nodes: [homeNode('node-a', { holds: ['proxmox-default-kernel'], pending: [homePkg('curl', '8.1-2', '8.1-1')] })],
    guests: [homeGuest(201, 'node-a'), homeGuest(202, 'node-a', { name: 'quiet', pending: [] })],
  })
  home.ceph = null
  const remote = standaloneServer({ guest: { name: 'media', config: { hostname: 'media' } } })
  const handles = (): CheckClusterHandle[] => [
    { ref: HOME, exec: home, loadPolicy: () => file, remote: false },
    { ref: REMOTE, exec: remote, loadPolicy: () => policyForCluster(file, REMOTE), remote: true },
  ]
  const sent: any[] = []
  const state = new MemoryCheckState()
  let now = new Date('2026-11-10T06:30:00Z')
  const slept: number[] = []
  const checker = new UpdatesChecker({
    clusters: handles, loadPolicy: () => file,
    activeJob: async () => (opts.active ? { id: 'job1' } : null),
    isUnlocked: () => opts.unlocked ?? true,
    state, publish: async e => { sent.push(e) },
    now: () => now, gapMs: 5, clusterGapMs: 7, sleep: async ms => { slept.push(ms) },
  })
  return { checker, home, remote, sent, state, slept, setNow: (d: Date) => { now = d } }
}

test('read-only: lists are refreshed and apt only simulates; nothing is installed, held or rebooted', async () => {
  const { checker, home, remote } = setup()
  await checker.run('manual')
  for (const f of [home, remote]) {
    assert.ok(f.ran(/apt-get -s /), 'a simulation ran')
    assert.ok(!f.ran(/apt-get -y|apt-mark (un)?hold\b|proxmox-boot-tool kernel (un)?pin|systemctl reboot|dist-upgrade$|snapshot/), 'nothing changed')
    assert.ok(!f.cmds().some(c => c === 'guest:apt' || c.startsWith('snapshot ')))
  }
  assert.ok(home.ran(/apt-get -s .* upgrade 2>&1/) && !home.ran(/apt-get -s .* dist-upgrade/), 'the home node policy (upgrade only) decides what is simulated')
  assert.ok(remote.ran(/apt-get -s .* dist-upgrade/), 'the remote gets its own (dist-upgrade) policy')
  assert.deepEqual(remote.refused, [], 'every remote command passed the script guard')
})

test('staggered: one machine at a time with a pause between, and between clusters', async () => {
  const { checker, slept } = setup()
  await checker.run('manual')
  assert.ok(slept.filter(ms => ms === 5).length >= 4, `pauses between machines: ${slept}`)
  assert.equal(slept.filter(ms => ms === 7).length, 1, 'one pause between the two clusters')
})

test('results per cluster: counts, kernel and reboot flags, held reported as held, security first', async () => {
  const { checker, remote } = setup()
  remote.nodes[0].pending.push(pkg('libssl3t64', '3.5.4-1', '3.5.1-1'))
  const st = await checker.run('manual')
  const h = st.clusters.find(c => c.cluster.id === 'home')!
  const r = st.clusters.find(c => c.cluster.id === REMOTE.id)!
  assert.equal(h.result, 'ok')
  const hn = h.targets.find(t => t.kind === 'node')!
  assert.equal(hn.packages, 1)
  assert.equal(hn.held, 1, 'the held kernel package is counted as held, not offered')
  assert.equal(h.targets.find(t => t.name === 'quiet'), undefined)
  const rn = r.targets.find(t => t.kind === 'node')!
  assert.equal(rn.packages, 4)
  assert.equal(rn.kernel, true)
  assert.equal(rn.rebootNeeded, true)
  assert.equal(rn.held, 1)
  assert.equal(r.available, 2)
  assert.equal(checker.summary(REMOTE.id)!.available, 2, 'stored for the Command center')
})

test('dedupe: the same findings are not sent twice; something new is; a reminder at most weekly', async () => {
  const { checker, sent, remote, setNow } = setup()
  await checker.run('manual')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'updates.available')
  setNow(new Date('2026-11-11T06:30:00Z'))
  await checker.run('schedule')
  assert.equal(sent.length, 1, 'same list the next day: no message')
  remote.guests[0].pending.push(pkg('bash', '5.2-2', '5.2-1'))
  setNow(new Date('2026-11-12T06:30:00Z'))
  await checker.run('schedule')
  assert.equal(sent.length, 2, 'something new: one message')
  assert.equal(sent[1].title, 'Updates available')
  for (const d of ['2026-11-13', '2026-11-15', '2026-11-18']) { setNow(new Date(`${d}T06:30:00Z`)); await checker.run('schedule') }
  assert.equal(sent.length, 2, 'still waiting, under a week: quiet')
  setNow(new Date('2026-11-19T06:30:00Z'))
  await checker.run('schedule')
  assert.equal(sent.length, 3)
  assert.match(sent[2].title, /weekly reminder/)
})

test('a cluster that does not answer is skipped and said so; the other is still checked', async () => {
  const { checker, remote, sent } = setup()
  remote.readFail.add('clusterStatus')
  const st = await checker.run('manual')
  const r = st.clusters.find(c => c.cluster.id === REMOTE.id)!
  assert.equal(r.result, 'skipped')
  assert.match(r.reason ?? '', /not reachable/)
  assert.equal(st.clusters.find(c => c.cluster.id === 'home')!.result, 'ok')
  assert.ok(sent[0].lines.some((l: string) => /Remote server.*\(remote\): not checked this time \(it did not answer\)/.test(l)))
})

test('a running backup, an active Updates job or a lock skips the check', async () => {
  const a = setup()
  a.remote.backups = [{ node: 'pve1', at: Date.now(), ok: null, vmid: 101 }]
  const st = await a.checker.run('manual')
  assert.match(st.clusters.find(c => c.cluster.id === REMOTE.id)!.reason ?? '', /backup is running/)
  assert.ok(!a.remote.ran(/apt-get -s/), 'nothing read while it backs up')

  const b = setup({ active: true })
  const sb = await b.checker.run('manual')
  assert.ok(sb.clusters.every(c => c.result === 'skipped' && /Updates job/.test(c.reason ?? '')))
  assert.equal(b.home.calls.length + b.remote.calls.length, 0)

  const c = setup({ unlocked: false })
  const fresh = new UpdatesChecker({ ...(c.checker as any).deps, now: () => new Date(2026, 10, 10, 6, 30, 20) })
  ;(fresh as any).last = new Date(2026, 10, 10, 6, 29, 50)
  assert.equal(await fresh.tick(), 'locked')
  assert.equal(c.home.calls.length, 0)
})

test('schedule: fires once per window, never twice for the same minute', async () => {
  const { checker, setNow } = setup()
  let ran = 0
  ;(checker as any).run = async () => { ran++ }
  // The schedule is local time, like every HyperProx schedule.
  const at = (s: string) => { const [h, m, sec] = s.split(':').map(Number); setNow(new Date(2026, 10, 10, h, m, sec)) }
  ;(checker as any).last = new Date(2026, 10, 10, 6, 29, 0)
  at('06:29:40'); assert.equal(await checker.tick(), 'idle')
  at('06:30:10'); assert.equal(await checker.tick(), 'ran')
  at('06:30:40'); assert.equal(await checker.tick(), 'idle')
  at('06:31:10'); assert.equal(await checker.tick(), 'idle')
  at('06:31:40'); await checker.tick()
  assert.equal(ran, 1)
  const off = setup({ yaml: 'check:\n  enabled: false\n' })
  assert.equal(await off.checker.tick(), 'off')
})

test('the message: names and counts only — no versions, addresses or secrets; security named first', async () => {
  const { checker, remote, sent } = setup()
  // A security-suite line, as apt prints it in the guest.
  remote.inject = (where, cmd) => (where === '101' && cmd === 'guest:pending'
    ? { code: 0, timedOut: false, output: 'openssl/stable-security 3.5.4-1 amd64 [upgradable from: 3.5.1-1]' } : undefined)
  await checker.run('manual')
  const m = sent[0]
  assert.equal(m.severity, 'warning')
  assert.equal(m.title, 'Security updates available')
  assert.match(m.lines[0], /^Security fixes: Remote server \[address\] \(remote\) container media: openssl\./)
  const text = JSON.stringify(m)
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(text), 'no addresses')
  assert.ok(!/3\.5\.4-1|8\.1-2/.test(text), 'no versions')
  assert.ok(!/token|password|secret/i.test(text))
  assert.match(text, /node pve1 3 packages \(kernel update, reboot needed\)/)
  assert.match(text, /kernel update, reboot needed/)
  assert.match(text, /Home cluster \(home\): node node-a 1 package; container guest-201 1 package; 1 held or kept back, not offered\./)
  assert.equal(m.link, '/updates')
  assert.equal(stripAddresses('reach https://pve1.example:8006 or 10.0.0.9:22 or fe80::1:2:3'), 'reach [link] or [address] or [address]')
})

test('the event goes only to channels that take Updates events', () => {
  const m = { type: 'updates.available', severity: 'info' as const }
  assert.equal(matches({ enabled: true, minSeverity: 'info', eventFilter: ['updates'] }, m), true)
  assert.equal(matches({ enabled: true, minSeverity: 'info', eventFilter: ['certs', 'vault'] }, m), false)
  assert.equal(matches({ enabled: true, minSeverity: 'info', eventFilter: 'all' }, m), true)
  assert.equal(matches({ enabled: false, minSeverity: 'info', eventFilter: ['updates'] }, m), false)
  assert.equal(buildMessage([], false).lines!.length, 0)
})
