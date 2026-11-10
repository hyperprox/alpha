// Regression tests for the review of the remote-Updates branch. Each block names its finding.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UpdatesRunner } from '../src/lib/updates/runner'
import { MemoryStore } from '../src/lib/updates/store'
import { ScopedStore } from '../src/lib/updates/cluster-store'
import { parsePolicy, policyForCluster, effectiveUpgrade, renameRefusal, sectionKeyFor, type PolicyLoad } from '../src/lib/updates/policy'
import { readInventory } from '../src/lib/updates/inventory'
import { UpdatesChecker, MemoryCheckState, type CheckClusterHandle } from '../src/lib/updates/check'
import { UpdatesScheduler } from '../src/lib/updates/scheduler'
import { scrub } from '../src/lib/notify/render'
import { looksLikeHome, homeAddresses, setClusterStore, loadClusters, updateCluster, setRenameGuard } from '../src/lib/clusters/registry'
import { MemoryClusterStore } from '../src/lib/clusters/store'
import { FakeCluster, FAST, node as homeNode, guest as homeGuest, pkg as homePkg } from './updates-fake'
import { standaloneServer, pkg } from './updates-remote-fake'

const REMOTE = { id: 'c0123456789', name: 'Remote server', kind: 'remote' as const }
const HOME = { id: 'home', name: 'Home cluster', kind: 'home' as const }
const loaded = (yaml: string): PolicyLoad => ({ loaded: true, path: '/t', policy: parsePolicy(yaml) })
const rejected: PolicyLoad = { loaded: false, path: '/t', error: 'Policy file rejected: guests.exlude: unknown key', policy: parsePolicy('') }
const missing: PolicyLoad = { loaded: false, missing: true, path: '/t', error: 'No policy file', policy: parsePolicy('') }

// ── 1a: a node seen to hold packages or pin a kernel gets `upgrade`, unless named for dist-upgrade ──

test('1a: holds or a pin seen on the node mean upgrade; only a by-name dist-upgrade overrides; unknown facts mean upgrade', () => {
  const p = parsePolicy('nodes:\n  default: { upgrade: dist-upgrade }\n  node-b: { upgrade: dist-upgrade }\n')
  assert.equal(effectiveUpgrade(p, 'node-a', { holds: [], pinned: null }).verb, 'dist-upgrade')
  const held = effectiveUpgrade(p, 'node-a', { holds: ['proxmox-default-kernel'], pinned: null })
  assert.equal(held.verb, 'upgrade')
  assert.match(held.note!, /node-a has held packages \(proxmox-default-kernel\), so it gets apt-get upgrade, not dist-upgrade/)
  assert.match(effectiveUpgrade(p, 'node-a', { holds: [], pinned: '7.0.1-1-pve' }).note!, /a pinned kernel \(7\.0\.1-1-pve\)/)
  assert.equal(effectiveUpgrade(p, 'node-b', { holds: ['x'], pinned: '7.0.1-1-pve' }).verb, 'dist-upgrade', 'named by name for dist-upgrade')
  assert.equal(effectiveUpgrade(p, 'node-a', null).verb, 'upgrade')
})

test('1a: a remote node with a hold gets apt-get upgrade in the preview, the plan and the run, said in words', async () => {
  const fake = standaloneServer({ node: { holds: ['pve-firmware'] }, guest: { config: { hostname: 'media' } } })
  const store = new ScopedStore(new MemoryStore(), { cluster: REMOTE })
  const runner = new UpdatesRunner({ store, exec: fake, loadPolicy: () => policyForCluster(missing, REMOTE), timing: FAST, cluster: REMOTE, remote: true, checkJob: store.checkJob })
  const job = await runner.start('run', 'manual')
  await runner.idle()
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'awaiting-confirm', j.pauseReason ?? '')
  assert.ok(j.plan.steps.some(s => s.action === 'node-upgrade' && /^apt-get upgrade /.test(s.detail ?? '')))
  assert.ok(j.plan.warnings.some(w => /pve1 has held packages \(pve-firmware\), so it gets apt-get upgrade/.test(w)))
  await runner.confirm(job.id); await runner.idle()
  assert.ok(fake.ran(/apt-get -y -q .* upgrade$/) && !fake.ran(/apt-get -y -q .* dist-upgrade$/), 'never dist-upgrade on a held node')
  const up = (await store.getSteps(job.id)).find(s => s.action === 'node-upgrade')!
  assert.match(up.output ?? '', /so it gets apt-get upgrade/)
})

test('1a: home too: a default dist-upgrade does not reach a node seen with holds', async () => {
  const fake = new FakeCluster({ nodes: [homeNode('node-a', { holds: ['proxmox-kernel-7.0'] })], guests: [] })
  const inv = await readInventory(fake, parsePolicy('nodes:\n  default: { upgrade: dist-upgrade }\n'), {})
  assert.equal(inv.inventory.nodes[0].policy.upgrade, 'upgrade')
  assert.match(inv.inventory.nodes[0].upgradeNote ?? '', /held packages/)
})

// ── 1b: the home cluster cannot be added again as a remote ──

test('1b: the home cluster, or one of its nodes, is refused as a remote', async () => {
  process.env.PROXMOX_HOST = '10.0.0.1'
  setClusterStore(new MemoryClusterStore()); await loadClusters()
  const home = { addresses: homeAddresses(), fingerprint: 'AA', clusterName: 'homelab', nodes: [{ name: 'node1', ip: '10.0.0.1' }, { name: 'node2', ip: '10.0.0.2' }] }
  const other = (o: any) => ({ addresses: ['pve1.example'], fingerprint: 'BB', clusterName: null, nodes: [{ name: 'pve', ip: '10.1.0.5' }], ...o })
  assert.equal(looksLikeHome(other({}), home), false, 'a different one-node server')
  assert.equal(looksLikeHome(other({ addresses: ['10.0.0.1'] }), home), true, 'the home address')
  assert.equal(looksLikeHome(other({ fingerprint: 'AA' }), home), true, 'the home certificate')
  assert.equal(looksLikeHome(other({ clusterName: 'homelab' }), home), true, 'the home cluster name')
  assert.equal(looksLikeHome(other({ nodes: [{ name: 'node2', ip: '10.9.9.9' }, { name: 'node1' }] }), home), true, 'the same node names')
  assert.equal(looksLikeHome(other({ addresses: ['10.0.0.2'] }), home), true, 'a home node address')
  // Two unrelated one-node servers often share the default name "pve": only name AND address together match.
  const lone = { addresses: [], fingerprint: null, clusterName: null, nodes: [{ name: 'pve', ip: '10.0.0.7' }] }
  assert.equal(looksLikeHome(other({}), lone), false)
  assert.equal(looksLikeHome(other({ nodes: [{ name: 'pve', ip: '10.0.0.7' }] }), lone), true)
  const { createRemote } = await import('../src/lib/clusters/registry')
  await assert.rejects(createRemote({ name: 'Again', address: '10.0.0.1', fingerprint: 'AB'.repeat(32), tokenId: 'hyperprox@pve!main', tokenSecret: '12345678-aaaa-bbbb-cccc-1234567890ab', by: 'x' }), /This is your home cluster; it is already managed as Home/)
  delete process.env.PROXMOX_HOST
})

// ── 2: a rejected policy file stops the check; a missing one reads nodes only ──

function checkSetup(file: PolicyLoad) {
  const home = new FakeCluster({ nodes: [homeNode('node-a')], guests: [homeGuest(201, 'node-a')] })
  const remote = standaloneServer({ guest: { config: { hostname: 'media' } } })
  const handles = (): CheckClusterHandle[] => [
    { ref: HOME, exec: home, loadPolicy: () => file, remote: false },
    { ref: REMOTE, exec: remote, loadPolicy: () => policyForCluster(file, REMOTE), remote: true },
  ]
  let active: { id: string } | null = null
  let now = new Date(2026, 10, 10, 6, 30, 0)
  const sent: any[] = []
  const checker = new UpdatesChecker({
    clusters: handles, loadPolicy: () => file, activeJob: async () => active, isUnlocked: () => true,
    state: new MemoryCheckState(), publish: async e => { sent.push(e) }, now: () => now, gapMs: 1000, clusterGapMs: 0,
    sleep: async ms => { now = new Date(now.getTime() + ms) },
  })
  return { checker, home, remote, sent, setActive: (j: any) => { active = j }, setNow: (d: Date) => { now = d } }
}

test('2: a policy file that exists but was rejected: the schedule is off and says why; Check now reads nothing', async () => {
  const c = checkSetup(rejected)
  ;(c.checker as any).last = new Date(2026, 10, 10, 6, 29, 0)
  c.setNow(new Date(2026, 10, 10, 6, 30, 30))
  assert.equal(await c.checker.tick(), 'off')
  assert.match(c.checker.status().blocked ?? '', /policy file was rejected.*daily check is off/)
  assert.equal(c.checker.status().nextRun, null)
  const st = await c.checker.run('manual')
  assert.ok(st.clusters.every(x => x.result === 'skipped' && /policy file rejected/.test(x.reason ?? '')))
  assert.equal(c.home.calls.length + c.remote.calls.length, 0, 'not even apt update in a guest the broken file may exclude')
})

test('2: no policy file at all: nodes are simulated, no guest is refreshed or read', async () => {
  const c = checkSetup(missing)
  const st = await c.checker.run('manual')
  for (const f of [c.home, c.remote]) {
    assert.ok(f.ran(/apt-get -s /))
    assert.ok(!f.cmds().some(x => x.startsWith('guest:')), 'no guest touched')
  }
  assert.ok(st.clusters.every(x => /No policy file: nodes only/.test(x.note ?? '')))
})

// ── 3 and 4: the check gives way to jobs; a time cap per cluster ──

test('3: a job that starts mid-check stops it before the next machine; what was read is kept', async () => {
  const c = checkSetup(loaded(''))
  let reads = 0
  const orig = c.remote.nodeExec.bind(c.remote)
  c.remote.nodeExec = async (n: string, cmd: string, l?: any) => { if (/apt-get -s/.test(cmd) && ++reads === 1) c.setActive({ id: 'job9' }); return orig(n, cmd, l) }
  const st = await c.checker.run('manual')
  const r = st.clusters.find(x => x.cluster.id === REMOTE.id)!
  assert.equal(r.result, 'partial')
  assert.match(r.reason ?? '', /stopped early: an Updates job started/)
  assert.ok(r.unread.some(u => /not checked: an Updates job started/.test(u)))
  assert.ok(!c.remote.cmds('101').includes('guest:pending'), 'the guest after the node was not read')
})

test('3: the scheduled run waits while the check reads', async () => {
  let started = 0
  const s = new UpdatesScheduler({
    runner: { start: async () => { started++; return {} as any } }, isUnlocked: () => true, busy: () => true,
    loadPolicy: () => loaded('schedule:\n  enabled: true\n  cron: "* * * * *"\n'), now: () => new Date(2026, 10, 10, 8, 0, 30),
  })
  ;(s as any).last = new Date(2026, 10, 10, 7, 59, 0)
  assert.equal(await s.tick(), 'busy')
  assert.equal(started, 0)
})

test('4: one cluster gets at most the time cap; the rest is reported not checked. abort() stops at the next machine', async () => {
  const c = checkSetup(loaded(''))
  ;(c.checker as any).deps.clusterCapMs = 1500   // two pauses of 1 s pass it
  const st = await c.checker.run('manual')
  const h = st.clusters.find(x => x.cluster.id === 'home')!
  assert.equal(h.result, 'partial')
  assert.match(h.reason ?? '', /minute limit for one cluster was reached/)

  const d = checkSetup(loaded(''))
  const orig = d.home.nodeExec.bind(d.home)
  d.home.nodeExec = async (n: string, cmd: string, l?: any) => { if (/apt-get -s/.test(cmd)) d.checker.abort('an Updates run was started'); return orig(n, cmd, l) }
  const st2 = await d.checker.run('manual')
  assert.ok(st2.clusters.every(x => /an Updates run was started/.test(x.reason ?? '') || x.result === 'partial'))
  assert.ok(!d.remote.ran(/apt-get -s/), 'the next cluster was not read')
})

// ── 5: no addresses in what leaves HyperProx ──

test('5: notification text loses bare addresses and host:port', () => {
  const s = scrub('connect ECONNREFUSED 10.0.0.9:8006 via pve1.example:8006 and fe80::1:2:3 at 06:30:00 on [2001:db8::1]:22')
  assert.doesNotMatch(s, /10\.0\.0\.9|pve1\.example:8006|fe80::|2001:db8/)
  assert.match(s, /06:30:00/, 'a time is not an address')
})

// ── 7: dedupe ignores version bumps; info unless security, kernel or reboot ──

test('7: a newer version of the same pending package is not news; plain updates are info', async () => {
  const c = checkSetup(loaded(''))
  c.remote.nodes[0].pending = [pkg('curl', '8.1-2', '8.1-1')]
  c.home.nodes[0].pending = [homePkg('jq', '1.7-2', '1.7-1')]
  await c.checker.run('manual')
  assert.equal(c.sent.length, 1)
  assert.equal(c.sent[0].severity, 'info')
  c.remote.nodes[0].pending = [pkg('curl', '8.1-3', '8.1-1')]
  c.setNow(new Date(2026, 10, 11, 6, 30))
  await c.checker.run('schedule')
  assert.equal(c.sent.length, 1, 'same package, newer version: no message')
  c.remote.nodes[0].pending.push(pkg('proxmox-kernel-7.0.2-1-pve-signed', '7.0.2-1', null))
  c.setNow(new Date(2026, 10, 12, 6, 30))
  await c.checker.run('schedule')
  assert.equal(c.sent.length, 2)
  assert.equal(c.sent[1].severity, 'warning', 'a kernel means a reboot: worth a warning')
})

// ── 8: sections by id first; a rename cannot attach someone else's section ──

test('8: an id-keyed section wins over a name-keyed one; a rename onto a name-keyed section is refused', async () => {
  const p = parsePolicy(`clusters:\n  ${REMOTE.id}:\n    batch_size: 2\n  "Remote server":\n    batch_size: 5\n  "Other site":\n    batch_size: 7\n`)
  assert.equal(sectionKeyFor(p, REMOTE), REMOTE.id)
  const r = policyForCluster({ loaded: true, path: '/t', policy: p }, REMOTE)
  assert.equal(r.policy.batchSize, 2)
  assert.ok(r.notes!.some(n => /clusters\.Remote server is not used/.test(n)))
  const plain = { id: 'c0000000001', name: 'Second', kind: 'remote' as const }
  assert.match(renameRefusal(p, plain, 'Other site')!, /section clusters\.Other site, which would then apply to this server/)
  assert.equal(renameRefusal(p, plain, 'Third'), null)
  assert.equal(renameRefusal(p, REMOTE, 'Other site'), null, 'its own id-keyed section applies whatever its name')

  const cs = new MemoryClusterStore()
  await cs.upsert({ id: plain.id, name: 'Second', kind: 'remote', address: 'pve2.example', port: 8006, note: '', certFingerprint: 'AA', certConfirmedAt: null, certConfirmedBy: null, nodeAddresses: {}, allowedRoots: [], monitoring: {}, plexUrl: null, createdBy: 'x' })
  setClusterStore(cs); await loadClusters()
  setRenameGuard((c, n) => renameRefusal(p, c, n))
  await assert.rejects(updateCluster(plain.id, { name: 'Other site' }), /would then apply to this server/)
  assert.equal((await updateCluster(plain.id, { name: 'Third' })).name, 'Third')
  setRenameGuard(null)
})
