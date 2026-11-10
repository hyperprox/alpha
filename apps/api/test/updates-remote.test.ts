// Updates on a remote cluster, against the pretend server (no network): the per-cluster policy, apt's own
// simulation as the preview, preview -> confirm -> read-back, held packages and kernel pins left alone, the kernel
// flag and "reboot needed" with no automatic reboot, the separate standalone reboot, guests with and without a
// snapshot, and a plan for one cluster never applied through another.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UpdatesRunner } from '../src/lib/updates/runner'
import { MemoryStore } from '../src/lib/updates/store'
import { ScopedStore } from '../src/lib/updates/cluster-store'
import { parsePolicy, policyForCluster, remoteDefaultPolicy, nodePolicy, type PolicyLoad } from '../src/lib/updates/policy'
import {
  parseAptSimulation, parseGuestPending, summariseNodeChanges, readBackProblems, parseInstalledVersions,
  REMOTE_NODE_SERVICES_COMMAND, NODE_SERVICES_COMMAND,
} from '../src/lib/updates/commands'
import { assertSafeScript } from '../src/lib/clusters/script-guard'
import { buildPlan } from '../src/lib/updates/planner'
import { readInventory } from '../src/lib/updates/inventory'
import { remoteRouteAllowed } from '../src/lib/clusters/context'
import { FakeCluster, FAST, node as homeNode, guest as homeGuest } from './updates-fake'
import { RemoteFake, standaloneServer, node, guest, pkg } from './updates-remote-fake'

const REMOTE = { id: 'c0123456789', name: 'Remote server', kind: 'remote' as const }
const HOME = { id: 'home', name: 'Home cluster', kind: 'home' as const }

// The home file names a pinned node called pve1, exactly like the remote's only node.
const HOME_YAML = [
  'nodes:',
  '  default: { upgrade: dist-upgrade, reboot: auto }',
  '  pve1: { upgrade: upgrade, reboot: manual, require_holds: [proxmox-default-kernel], require_pin: 7.0.1-1-pve }',
].join('\n')

const fileLoad = (yaml: string | null): PolicyLoad => yaml === null
  ? { loaded: false, missing: true, path: '/test/updates.yaml', error: 'No policy file', policy: parsePolicy('') }
  : { loaded: true, path: '/test/updates.yaml', policy: parsePolicy(yaml) }

function remoteRunner(fake: FakeCluster, opts: { yaml?: string | null; store?: MemoryStore; connection?: () => string; publish?: (e: any) => Promise<void> } = {}) {
  const inner = opts.store ?? new MemoryStore()
  const store = new ScopedStore(inner, { cluster: REMOTE, connection: opts.connection })
  const load = () => policyForCluster(fileLoad(opts.yaml === undefined ? HOME_YAML : opts.yaml), REMOTE)
  const runner = new UpdatesRunner({ store, exec: fake, loadPolicy: load, timing: FAST, cluster: REMOTE, remote: true, checkJob: store.checkJob, publish: opts.publish })
  return { runner, store, inner }
}

function homeRunner(fake: FakeCluster, inner: MemoryStore) {
  const store = new ScopedStore(inner, { cluster: HOME })
  return new UpdatesRunner({ store, exec: fake, loadPolicy: () => fileLoad(HOME_YAML), timing: FAST, checkJob: store.checkJob })
}

async function awaitConfirm(runner: UpdatesRunner, store: { getJob(id: string): Promise<any> }, approvals: string[] = []) {
  const job = await runner.start('run', 'manual', 'admin@example.com', 'all', approvals)
  await runner.idle()
  const j = await store.getJob(job.id)
  assert.equal(j.status, 'awaiting-confirm', j.pauseReason ?? '')
  return j
}

// --- Policy -----------------------------------------------------------------------------------

test('policy: a remote with no section gets the safe Proxmox defaults, never the home node rules of a same-named node', () => {
  const r = policyForCluster(fileLoad(HOME_YAML), REMOTE)
  assert.equal(r.loaded, true)
  assert.equal(r.section, null)
  const n = nodePolicy(r.policy, 'pve1')
  assert.equal(n.upgrade, 'dist-upgrade', 'Proxmox recommends dist-upgrade (full-upgrade) for a PVE node')
  assert.equal(n.reboot, 'manual')
  assert.deepEqual(n.requireHolds, [])
  assert.equal(n.requirePin, undefined, 'the home pve1 pin does not follow the name to a remote')
  assert.equal(r.policy.schedule.enabled, false)
  assert.equal(r.policy.apps.enabled, false)
  // Home keeps exactly its own rules.
  const h = nodePolicy(policyForCluster(fileLoad(HOME_YAML), HOME).policy, 'pve1')
  assert.equal(h.upgrade, 'upgrade'); assert.equal(h.requirePin, '7.0.1-1-pve')
})

test('policy: a section by id or by exact name; reboot auto refused; home cannot be a section; a broken file stops remotes too', () => {
  const byId = policyForCluster(fileLoad(`clusters:\n  ${REMOTE.id}:\n    nodes:\n      pve1: { upgrade: upgrade, require_holds: [proxmox-default-kernel] }\n`), REMOTE)
  assert.equal(byId.section, REMOTE.id)
  assert.equal(nodePolicy(byId.policy, 'pve1').upgrade, 'upgrade')
  const byName = policyForCluster(fileLoad(`clusters:\n  "Remote server":\n    guests:\n      exclude: [105]\n`), REMOTE)
  assert.equal(byName.section, 'Remote server')
  assert.deepEqual(byName.policy.exclude, [105])
  assert.throws(() => parsePolicy(`clusters:\n  x:\n    nodes:\n      default: { reboot: auto }\n`), /never rebooted automatically/)
  assert.throws(() => parsePolicy(`clusters:\n  x:\n    schedule: { enabled: true }\n`), /clusters\.x\.schedule: unknown key/)
  assert.throws(() => parsePolicy(`clusters:\n  home:\n    batch_size: 2\n`), /top level/)
  const broken: PolicyLoad = { loaded: false, path: '/x', error: 'Policy file rejected: nodes.x.requre_pin: unknown key', policy: parsePolicy('') }
  assert.equal(policyForCluster(broken, REMOTE).loaded, false)
  assert.equal(policyForCluster(fileLoad(null), REMOTE).loaded, true, 'no file at all: the remote defaults are written for that case')
  assert.equal(remoteDefaultPolicy().nodeDefault.upgrade, 'dist-upgrade')
})

// --- Parsing and the script guard ---------------------------------------------------------------

test('apt simulation: security origin flagged; kernel, firmware, Proxmox and removals summarised', () => {
  const sim = parseAptSimulation([
    'Inst openssl [3.5.1-1] (3.5.4-1 Debian-Security:13/stable-security [amd64])',
    'Inst proxmox-kernel-7.0.2-1-pve-signed (7.0.2-1 Proxmox:9/trixie [amd64])',
    'Inst pve-manager [9.2.1] (9.2.2 Proxmox:9/trixie [amd64])',
    'Inst pve-firmware [3.17-1] (3.17-2 Proxmox:9/trixie [all])',
    'Remv old-tool [1.0]',
    'HP_SIM_END 0',
  ].join('\n'))
  assert.ok(sim.changes)
  assert.equal(sim.changes!.find(c => c.name === 'openssl')!.security, true)
  assert.equal(sim.changes!.find(c => c.name === 'pve-manager')!.security, undefined)
  const sum = summariseNodeChanges(sim.changes!)
  assert.deepEqual(sum, { kernel: true, firmware: true, proxmoxVe: true, rebootAfter: true, removals: ['old-tool'] })
  assert.equal(parseGuestPending('libssl3t64/stable-security 3.5.4-1 amd64 [upgradable from: 3.5.1-1]').pending[0].security, true)
  const rb = readBackProblems(sim.changes!.slice(0, 1), parseInstalledVersions('HP_VERSIONS_BEGIN\nopenssl 3.5.1-1 ii \nHP_VERSIONS_END'))
  assert.deepEqual(rb.map(p => p.detail), ['openssl is at 3.5.1-1, expected 3.5.4-1'])
  assert.deepEqual(rb.map(p => p.words), ['openssl is not at the expected version'], 'the words carry no version')
})

test('the remote services check passes the script guard; the home one would be refused there', () => {
  assert.doesNotThrow(() => assertSafeScript(REMOTE_NODE_SERVICES_COMMAND))
  assert.throws(() => assertSafeScript(NODE_SERVICES_COMMAND), /pve-cluster/)
})

test('every Updates route resolves its cluster and is allowed on a remote; others stay home-only', () => {
  for (const [m, p] of [['GET', '/api/updates/inventory'], ['GET', '/api/updates/plan'], ['GET', '/api/updates/jobs/job123'], ['POST', '/api/updates/jobs'],
    ['POST', '/api/updates/jobs/abc/confirm'], ['POST', '/api/updates/nodes/pve1/reboot'], ['GET', '/api/updates/nodes/pve1/reboot-preview'], ['GET', '/api/updates/check'], ['POST', '/api/updates/check']]) {
    assert.equal(remoteRouteAllowed(m, p), true, `${m} ${p}`)
  }
  assert.equal(remoteRouteAllowed('POST', '/api/updates/jobs/../x/confirm'), false)
  assert.equal(remoteRouteAllowed('DELETE', '/api/updates/jobs/abc'), false)
})

// --- Preview, apply, read-back ------------------------------------------------------------------

test('remote node: preview is apt\'s dist-upgrade simulation; apply upgrades, reads back, and never reboots on its own', async () => {
  const fake = standaloneServer()
  const { runner, store } = remoteRunner(fake)
  const inv = await readInventory(fake, policyForCluster(fileLoad(HOME_YAML), REMOTE).policy, runner.inventoryOptions())
  const n = inv.inventory.nodes[0]
  assert.equal(n.preview?.verb, 'dist-upgrade')
  assert.equal(n.preview?.kernel, true)
  assert.equal(n.preview?.proxmoxVe, true)
  assert.equal(n.preview?.rebootAfter, true)
  assert.equal(n.standalone, true)
  assert.ok(fake.ran(/apt-get -s .* dist-upgrade/), 'the preview is apt\'s own simulation')
  assert.ok(!fake.calls.some(c => c.cmd === 'POST apt/update'), 'reading the preview refreshes nothing')

  const job = await awaitConfirm(runner, store, ['nosnap:101'])
  const actions = job.plan.steps.map((s: any) => `${s.action}:${s.target}`)
  assert.ok(actions.includes('node-upgrade:pve1'))
  assert.ok(actions.includes('node-reboot:pve1'))
  assert.ok(!actions.some((a: string) => a.startsWith('ceph:') || a.startsWith('self:')))
  assert.ok(job.plan.warnings.some((w: string) => /new kernel is included.*never does on its own/.test(w)))
  assert.ok(job.plan.warnings.some((w: string) => /one-node server.*gates are skipped/.test(w)))
  assert.equal(job.plan.cluster.id, REMOTE.id)
  const pre = (await store.getSteps(job.id)).find(s => s.action === 'preflight')!
  assert.match(pre.output ?? '', /standalone server: no quorum or HA to check \(skipped\)/)

  await runner.confirm(job.id, 'admin@example.com')
  await runner.idle()
  const done = await store.getJob(job.id)
  assert.equal(done!.status, 'done', done!.pauseReason ?? '')
  const steps = await store.getSteps(job.id)
  const up = steps.find(s => s.action === 'node-upgrade')!
  assert.equal(up.status, 'ok', up.reason ?? '')
  assert.match(up.output ?? '', /read-back: 3 packages at the expected versions; holds and pin unchanged\. A reboot is needed/)
  const rb = steps.find(s => s.action === 'node-reboot')!
  assert.equal(rb.status, 'skipped')
  assert.match(rb.reason ?? '', /reboot pending/)
  assert.ok(!fake.ran(/systemctl reboot/), 'never rebooted automatically')
  assert.ok(fake.ran(/apt-get -y -q .* dist-upgrade$/))
  assert.ok(fake.ran(new RegExp(`^${REMOTE_NODE_SERVICES_COMMAND}$`)))
  assert.ok(!fake.ran(/apt-mark (unhold|hold)\b|kernel (un)?pin|allow-change-held-packages|ha-manager/), 'holds, pins and HA untouched')
  assert.deepEqual(fake.refused, [], 'every command passed the remote script guard')
  assert.deepEqual(done!.report!.rebootsPending, ['pve1'])
})

test('read-back failures are reported plainly: a package left behind, a hold that vanished', async () => {
  const a = standaloneServer({ guest: { config: { hostname: 'media' } } })
  a.leaveBehind = 'openssl'
  const r1 = remoteRunner(a)
  const j1 = await awaitConfirm(r1.runner, r1.store)
  await r1.runner.confirm(j1.id); await r1.runner.idle()
  const s1 = (await r1.store.getSteps(j1.id)).find(s => s.action === 'node-upgrade')!
  assert.equal(s1.status, 'failed')
  assert.match(s1.reason ?? '', /read-back after apt-get dist-upgrade: openssl is not installed$/)
  assert.doesNotMatch(s1.reason ?? '', /3\.5\.4/, 'no versions in the reason (it reaches the pause, the audit log and notifications)')
  assert.match(s1.output ?? '', /openssl is not installed \(expected 3\.5\.4-1\)/, 'the detail stays in the step output')
  assert.equal((await r1.store.getJob(j1.id))!.status, 'paused')

  const b = standaloneServer({ node: { holds: ['pve-firmware'] }, guest: { config: { hostname: 'media' } } })
  b.dropHoldsOnUpgrade = true
  const r2 = remoteRunner(b, { yaml: `clusters:\n  ${REMOTE.id}:\n    nodes:\n      pve1: { upgrade: dist-upgrade }\n` })
  const j2 = await awaitConfirm(r2.runner, r2.store)
  await r2.runner.confirm(j2.id); await r2.runner.idle()
  const s2 = (await r2.store.getSteps(j2.id)).find(s => s.action === 'node-upgrade')!
  assert.equal(s2.status, 'failed')
  assert.match(s2.reason ?? '', /no longer on hold: pve-firmware \(HyperProx never removes a hold/)
  assert.ok(!b.ran(/apt-mark (un)?hold\b/), 'it reports, it never repairs')
})

test('a required hold or pin missing on a remote node stops the run before anything is installed', async () => {
  const fake = standaloneServer({ node: { holds: [] }, guest: { config: { hostname: 'media' } } })
  const { runner, store } = remoteRunner(fake, { yaml: `clusters:\n  "Remote server":\n    nodes:\n      pve1: { require_holds: [proxmox-default-kernel] }\n` })
  const job = await runner.start('run', 'manual')
  await runner.idle()
  const j = await store.getJob(job.id)
  assert.equal(j!.status, 'failed')
  assert.match(j!.pauseReason ?? '', /required hold missing: proxmox-default-kernel/)
  assert.ok(!fake.ran(/apt-get -y/))
})

// --- Guests -------------------------------------------------------------------------------------

test('guest that cannot be snapshotted: not planned without an explicit acknowledgement; the preview names the backup', async () => {
  const fake = standaloneServer()
  fake.backups = [{ node: 'pve1', at: Date.UTC(2026, 10, 9, 2, 0), ok: true, vmid: 101 }]
  const { runner, store } = remoteRunner(fake)
  const inv = await readInventory(fake, remoteDefaultPolicy(), runner.inventoryOptions())
  const g = inv.inventory.guests[0]
  assert.equal(g.snapshotCapable, false)
  assert.equal(g.noSnapshotAckId, 'nosnap:101')
  assert.deepEqual(g.lastBackup, { at: '2026-11-09T02:00:00.000Z', ok: true, thisGuest: true })
  const plan = buildPlan(inv.inventory, remoteDefaultPolicy(), { remote: true })
  assert.ok(!plan.steps.some(s => s.target === '101'))
  assert.ok(plan.warnings.some(w => /101 \(media\) cannot be snapshotted.*Its newest backup is from 2026-11-09 02:00 UTC\..*nosnap:101/.test(w)))

  const job = await awaitConfirm(runner, store, ['nosnap:101'])
  assert.deepEqual(job.plan.approved, ['nosnap:101'])
  await runner.confirm(job.id); await runner.idle()
  const steps = (await store.getSteps(job.id)).filter(s => s.target === '101')
  assert.equal(steps.find(s => s.action === 'snapshot')!.status, 'skipped')
  assert.equal(steps.find(s => s.action === 'apt')!.status, 'ok')
  assert.ok(!fake.ran(/^snapshot /, '101'), 'no snapshot was asked for')
  assert.ok(fake.cmds('101').includes('guest:pending'), 'read back after the upgrade')
})

test('guest that can be snapshotted: snapshot first, then upgrade, then read-back; held packages are kept back', async () => {
  const fake = standaloneServer({ guest: { config: { hostname: 'media', onboot: 1 } } })
  const { runner, store } = remoteRunner(fake)
  const job = await awaitConfirm(runner, store)
  await runner.confirm(job.id); await runner.idle()
  const cmds = fake.cmds('101')
  const snap = cmds.findIndex(c => c.startsWith('snapshot hp-upd-'))
  const apt = cmds.lastIndexOf('guest:apt')
  assert.ok(snap >= 0 && apt > snap)
  assert.equal(cmds.at(-1) === 'guest:pending' || cmds.slice(apt).includes('guest:pending'), true)

  // apt still offering something after the upgrade fails the guest, plainly.
  const f2 = standaloneServer({ guest: { config: { hostname: 'media' } } })
  f2.scripted.set('apt', () => ({ code: 0, output: 'done', timedOut: false }))   // upgrade "ran" but changed nothing
  const r2 = remoteRunner(f2)
  const j2 = await awaitConfirm(r2.runner, r2.store)
  await r2.runner.confirm(j2.id); await r2.runner.idle()
  const s = (await r2.store.getSteps(j2.id)).find(x => x.target === '101' && x.action === 'apt')!
  assert.equal(s.status, 'failed')
  assert.match(s.reason ?? '', /upgraded, but apt still offers 1 package: openssl \(snapshot hp-upd-/)
  assert.match(s.output ?? '', /openssl 3\.0-1 -> 3\.0-2/)
})

// --- Reboot: separate, explicit, standalone only -----------------------------------------------

test('reboot preview names the guests that go down; the reboot runs only on request, then reads back', async () => {
  const fake = standaloneServer({ node: { rebootRequired: true }, guest: { config: { hostname: 'media', onboot: 1, mp0: '/srv/media,mp=/media' } } })
  fake.guests.push(guest(102, 'pve1', { name: 'scratch', config: { hostname: 'scratch' } }))
  const { runner, store } = remoteRunner(fake)
  const pv = await runner.rebootPreview('pve1')
  assert.equal(pv.standalone, true)
  assert.deepEqual(pv.goingDown.map(g => [g.vmid, g.onboot]), [[101, true], [102, false]])
  assert.ok(pv.warnings.some(w => /2 running guests will stop.*no other node/.test(w)))
  assert.ok(pv.warnings.some(w => /stay stopped afterwards: 102 \(scratch\)/.test(w)))
  assert.equal(pv.rebootNeeded, true)
  assert.ok(!fake.ran(/systemctl reboot/), 'a preview reboots nothing')

  const job = await runner.rebootNode('pve1', 'admin@example.com')
  await runner.idle()
  const j = await store.getJob(job.id)
  assert.equal(j!.status, 'done', j!.pauseReason ?? '')
  const step = (await store.getSteps(job.id)).find(s => s.action === 'node-reboot')!
  assert.match(step.output ?? '', /pve1 rebooted \(new boot id\); running kernel .*Running again: 101 \(media\), 102 \(scratch\)/)
  assert.ok(!fake.ran(/ha-manager|noout/), 'no HA maintenance or Ceph flags on a one-node server')
  assert.deepEqual(fake.refused, [])
})

test('a remote node that is part of a cluster is not rebooted by HyperProx', async () => {
  const fake = new RemoteFake({ nodes: [node('pve1'), node('pve2'), node('pve3')], guests: [] })
  const { runner } = remoteRunner(fake)
  await assert.rejects(runner.rebootNode('pve1'), /part of a cluster.*by hand/)
  assert.ok(!fake.ran(/systemctl reboot/))
})

// --- One cluster's plan never applies to another -----------------------------------------------

test('cross-cluster replay refused: a remote job is "No job" to home, and the reverse; a changed connection refuses', async () => {
  const shared = new MemoryStore()
  const remoteFake = standaloneServer({ guest: { config: { hostname: 'media' } } })
  let key = 'conn-1'
  const { runner: remote, store: rstore } = remoteRunner(remoteFake, { store: shared, connection: () => key })
  const home = homeRunner(new FakeCluster({ nodes: [homeNode('pve1', { holds: ['proxmox-default-kernel'], pinned: '7.0.1-1-pve' })], guests: [homeGuest(201, 'pve1')] }), shared)

  const rj = await awaitConfirm(remote, rstore)
  await assert.rejects(home.confirm(rj.id), /No job/)
  await assert.rejects(home.resume(rj.id), /No job/)
  await assert.rejects(home.cancel(rj.id), /No job/)
  await assert.rejects(home.rollbackGuest(rj.id, '101'), /No job/)

  key = 'conn-2'   // the remote was re-pointed (address, certificate or token) after the plan was made
  await assert.rejects(remote.confirm(rj.id), /reached another way/)
  assert.ok(!remoteFake.ran(/apt-get -y/), 'nothing ran on the remote')
  key = 'conn-1'
  await remote.cancel(rj.id)

  // And the other way round.
  const hjob = await home.start('run', 'manual')
  await home.idle()
  await assert.rejects(remote.confirm(hjob.id), /No job/)
  await assert.rejects(remote.resume(hjob.id), /No job/)
  // One job at a time across clusters, with the other cluster named.
  await assert.rejects(remote.start('dry-run', 'manual'), /already active on/)
  assert.ok(shared.audits.some(a => a.action === 'updates.job.start' && (a.details as any).cluster === REMOTE.id))
})

test('notifications name the remote cluster and link to its own Updates page', async () => {
  const sent: any[] = []
  const fake = standaloneServer({ guest: { config: { hostname: 'media' } } })
  const { runner, store } = remoteRunner(fake, { publish: async e => { sent.push(e) } })
  const job = await awaitConfirm(runner, store)
  await runner.confirm(job.id); await runner.idle()
  const fin = sent.find(e => e.type === 'updates.job.finished')
  assert.match(fin.title, /^Remote server \(remote\): Updates finished/)
  assert.equal(fin.link, `/clusters/${REMOTE.id}/updates`)
  assert.ok(fin.lines.some((l: string) => /Reboot pending: pve1/.test(l)))
})

test('home behaviour unchanged: home inventory comes from the Proxmox pending list, not a simulation', async () => {
  const fake = new FakeCluster({ nodes: [homeNode('node-a')], guests: [homeGuest(101, 'node-a')] })
  const inv = await readInventory(fake, parsePolicy(''), {})
  assert.equal(inv.inventory.nodes[0].preview, undefined)
  assert.ok(!fake.ran(/apt-get -s/))
  assert.equal(inv.inventory.guests[0].noSnapshotAckId, undefined)
})
