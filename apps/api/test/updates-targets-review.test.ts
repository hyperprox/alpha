// Review fixes for runs of chosen targets: a ticked reboot never reboots a guarded node whose pin or holds are gone
// or unknown (plan, preflight and the reboot itself, with and without Ceph); "forced" survives the Ceph safety note;
// a whole-node run on a guarded node refuses kernel packages apt would move; compose projects keep their own name
// and files; a failed kernel cleanup does not hold back a chosen reboot; and the smaller checks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UpdatesRunner } from '../src/lib/updates/runner'
import { MemoryStore, type StepRecord } from '../src/lib/updates/store'
import { readInventory } from '../src/lib/updates/inventory'
import { parsePolicy } from '../src/lib/updates/policy'
import { buildTargets, buildSelectedPlan, everythingSelection, nodePackageRefusal } from '../src/lib/updates/targets'
import { NODE_FACTS_COMMAND, composeProjectScript, parseComposeLs } from '../src/lib/updates/commands'
import { SAFETY_MARK } from '../src/lib/updates/ceph-checks'
import { FakeCluster, node, guest, pkg, policyLoad, FAST } from './updates-fake'

const POLICY = `
nodes:
  default: { upgrade: dist-upgrade, reboot: auto }
  gpu-node: { upgrade: upgrade, reboot: auto, require_holds: [proxmox-kernel-7.0], require_pin: 7.0.1-1-pve }
`
const PIN = '7.0.1-1-pve'

function cluster(withCeph: boolean): FakeCluster {
  const fake = new FakeCluster({
    nodes: [
      node('node-a'),
      node('node-b', { pending: [pkg('curl', '8.1-2', '8.1-1'), pkg('proxmox-kernel-7.0.2-1-pve-signed', '7.0.2-1', null)] }),
      node('gpu-node', { holds: ['proxmox-kernel-7.0'], pinned: PIN, rebootRequired: true, pending: [pkg('curl', '8.1-2', '8.1-1')] }),
    ],
    guests: [guest(101, 'node-a'), guest(301, 'gpu-node')],
  })
  if (!withCeph) fake.ceph = null
  return fake
}
function setup(fake: FakeCluster, yaml = POLICY) {
  const store = new MemoryStore()
  return { store, runner: new UpdatesRunner({ store, exec: fake, loadPolicy: policyLoad(yaml), timing: FAST, hostname: 'not-a-guest' }) }
}
async function settle(r: UpdatesRunner) { await r.idle(); await r.idle() }
async function planned(runner: UpdatesRunner, store: MemoryStore, selection: string[]) {
  const job = await runner.start('run', 'manual', 'a', 'all', [], selection)
  await settle(runner)
  return job.id
}
async function confirm(runner: UpdatesRunner, store: MemoryStore, id: string) {
  await runner.confirm(id, 'a'); await settle(runner)
  return { job: (await store.getJob(id))!, steps: await store.getSteps(id) }
}
const step = (steps: StepRecord[], t: string, a: string) => steps.find(s => s.target === t && s.action === a)

for (const withCeph of [false, true]) {
  const c = withCeph ? 'with Ceph' : 'without Ceph'

  test(`B1 scenario A (${c}): pin lost, reboot required, only the reboot ticked: refused, never rebooted`, async () => {
    const fake = cluster(withCeph)
    fake.nodes[2].pinned = '7.0.2-1-pve'            // the pin moved
    const policy = parsePolicy(POLICY)
    const inv = (await readInventory(fake, policy, { hostname: 'x' })).inventory
    const t = buildTargets(inv, policy, {})
    const row = t.find(x => x.id === 'node:gpu-node:reboot')!
    assert.equal(row.selectable, false)
    assert.match(row.blocked!, /pin/)
    assert.equal(everythingSelection(t).includes('node:gpu-node:reboot'), false)
    const plan = buildSelectedPlan(inv, policy, { selection: ['node:gpu-node:reboot'] })
    assert.equal(plan.steps.length, 0)
    assert.match(plan.refused![0].reason, /pin.*not rebooted/)
    // The run: preflight keeps the node whose reboot was chosen, so it stops before anything.
    const { runner, store } = setup(fake)
    const id = await planned(runner, store, ['node:gpu-node:reboot', 'guest:101'])
    const j = (await store.getJob(id))!
    assert.equal(j.status, 'failed')
    assert.match(j.pauseReason!, /kernel pin is 7\.0\.2-1-pve/)
    assert.equal(fake.ran(/systemctl reboot/), false)
    assert.equal(fake.maintenance.size, 0)
    assert.equal(fake.noout, false)
  })

  test(`B1 scenario A at run time (${c}): the pin is lost after planning: the reboot refuses before any flag`, async () => {
    const fake = cluster(withCeph)
    const { runner, store } = setup(fake)
    const id = await planned(runner, store, ['node:gpu-node:reboot'])
    assert.equal((await store.getJob(id))!.status, 'awaiting-confirm')
    fake.nodes[2].pinned = null
    const { steps } = await confirm(runner, store, id)
    const r = step(steps, 'gpu-node', 'node-reboot')!
    assert.equal(r.status, 'failed')
    assert.match(r.reason!, /refusing to reboot: .*kernel pin is not set/)
    assert.equal(fake.ran(/systemctl reboot/), false)
    assert.equal(fake.ran(/node-maintenance enable/), false)
    assert.equal(fake.ran(/ceph osd set noout/), false)
  })

  test(`B1 scenario E (${c}): the node's facts cannot be read: refused in the plan and at the reboot`, async () => {
    const fake = cluster(withCeph)
    fake.inject = (where, cmd) => (where === 'gpu-node' && cmd === NODE_FACTS_COMMAND ? { code: 1, output: 'denied', timedOut: false } : undefined)
    const policy = parsePolicy(POLICY)
    const inv = (await readInventory(fake, policy, { hostname: 'x' })).inventory
    // Unknown facts: no reboot row can be chosen (there is none, or it is blocked).
    assert.equal(buildTargets(inv, policy, {}).find(x => x.id === 'node:gpu-node:reboot')?.selectable ?? false, false)
    assert.match(buildSelectedPlan(inv, policy, { selection: ['node:gpu-node:reboot'] }).refused![0].reason, /could not be read/)
    const { runner, store } = setup(fake)
    const id = await planned(runner, store, ['node:gpu-node:reboot'])
    assert.equal((await store.getJob(id))!.status, 'failed')
    // The Reboot button (no planner in the way) is refused by the reboot itself.
    fake.inject = () => undefined
    const fake2 = cluster(withCeph)
    fake2.inject = (where, cmd) => (where === 'gpu-node' && cmd === NODE_FACTS_COMMAND ? { code: 0, output: 'HP_FREE 9000', timedOut: false } : undefined)
    const s2 = setup(fake2)
    const job = await s2.runner.rebootNode('gpu-node', 'a')
    await settle(s2.runner)
    const st = await s2.store.getSteps(job.id)
    assert.match(step(st, 'gpu-node', 'node-reboot')!.reason!, /refusing to reboot gpu-node: .*could not be read/)
    assert.equal(fake2.ran(/systemctl reboot/), false)
    assert.equal(fake2.ran(/node-maintenance enable/), false)
  })
}

test('B1: the Reboot button on a node whose pin was lost is refused before any flag', async () => {
  const fake = cluster(true)
  fake.nodes[2].pinned = '7.0.9-9-pve'
  const { runner, store } = setup(fake)
  const job = await runner.rebootNode('gpu-node', 'a')
  await settle(runner)
  const st = await store.getSteps(job.id)
  assert.match(step(st, 'gpu-node', 'node-reboot')!.reason!, /refusing to reboot/)
  assert.equal(fake.ran(/systemctl reboot/), false)
  assert.equal(fake.noout, false)
})

test('B2: a ticked reboot still reboots when Ceph appends its safety note to the step', async () => {
  const fake = cluster(true)
  const { runner, store } = setup(fake)
  // node-a does not need a reboot: only "forced" makes it reboot.
  const id = await planned(runner, store, ['node:node-a:reboot'])
  const j = (await store.getJob(id))!
  assert.equal(j.status, 'awaiting-confirm', j.pauseReason ?? '')
  const detail = j.plan.steps.find(s => s.action === 'node-reboot')!.detail!
  assert.ok(detail.includes(SAFETY_MARK), `Ceph's note is on the step: ${detail}`)
  assert.doesNotMatch(detail, /\(forced\)$/)
  const { steps } = await confirm(runner, store, id)
  assert.equal(step(steps, 'node-a', 'node-reboot')!.status, 'ok', step(steps, 'node-a', 'node-reboot')!.reason ?? '')
  assert.ok(fake.ran(/systemctl reboot/, 'node-a'))
  // The Reboot button too.
  const f2 = cluster(true)
  const s2 = setup(f2)
  const job = await s2.runner.rebootNode('node-a', 'a')
  await settle(s2.runner)
  assert.ok(f2.ran(/systemctl reboot/, 'node-a'))
  assert.equal((await s2.store.getJob(job.id))!.status, 'done')
})

test('B3 scenario C: proxmox-kernel-helper pending on the guarded node: the whole-node run refuses it', async () => {
  const fake = cluster(false)
  fake.nodes[2].pending.push(pkg('proxmox-kernel-helper', '9.0.5', '9.0.4'))
  const policy = parsePolicy(POLICY)
  const inv = (await readInventory(fake, policy, { hostname: 'x' })).inventory
  const plan = buildSelectedPlan(inv, policy, { selection: ['node:gpu-node'] })
  assert.match(plan.refused![0].reason, /kernel packages are pending \(proxmox-kernel-helper\)/)
  const row = buildTargets(inv, policy, {}).find(x => x.id === 'node:gpu-node')!
  assert.equal(row.selectable, false)
  assert.equal(everythingSelection(buildTargets(inv, policy, {})).includes('node:gpu-node'), false)
  // At run time: planned with curl only, then apt's simulation brings the helper along.
  fake.nodes[2].pending = [pkg('curl', '8.1-2', '8.1-1')]
  const { runner, store } = setup(fake)
  const id = await planned(runner, store, ['node:gpu-node'])
  fake.nodes[2].simExtra = [pkg('proxmox-kernel-helper', '9.0.5', '9.0.4')]
  const { steps } = await confirm(runner, store, id)
  const u = step(steps, 'gpu-node', 'node-upgrade')!
  assert.equal(u.status, 'failed')
  assert.match(u.reason!, /refusing: .*proxmox-kernel-helper moves the kernel/)
  assert.equal(fake.cmds('gpu-node').some(c => /apt-get -y -q .* upgrade$/m.test(c)), false, 'nothing was installed')
})

test('B4: two compose projects in one directory stay apart, each with its own name and every file', async () => {
  const lsOut = ['HP_COMPOSE_BEGIN', JSON.stringify([
    { Name: 'app', Status: 'running(2)', ConfigFiles: '/opt/app/compose.yaml' },
    { Name: 'app-dev', Status: 'running(1)', ConfigFiles: '/opt/app/compose.dev.yaml,/opt/app/override.yaml' },
    { Name: 'bad;name', Status: 'running(1)', ConfigFiles: '/opt/x/compose.yaml' },
  ]), 'HP_COMPOSE_END'].join('\n')
  const ls = parseComposeLs(lsOut)
  assert.deepEqual(ls.projects.map(p => [p.name, p.dir, p.files]), [
    ['app', '/opt/app', ['/opt/app/compose.yaml']],
    ['app-dev', '/opt/app', ['/opt/app/compose.dev.yaml', '/opt/app/override.yaml']],
  ])
  assert.match(composeProjectScript(ls.projects[1]), /docker compose -p 'app-dev' -f '\/opt\/app\/compose\.dev\.yaml' -f '\/opt\/app\/override\.yaml' pull -q/)

  const fake = cluster(false)
  fake.guests[0].compose = [
    { dir: '/opt/app', name: 'app', files: ['/opt/app/compose.yaml'], images: [] },
    { dir: '/opt/app', name: 'app-dev', files: ['/opt/app/compose.dev.yaml', '/opt/app/override.yaml'], images: [{ image: 'web:dev', current: 'sha256:1', latest: 'sha256:2' }] },
  ]
  const policy = parsePolicy(POLICY)
  const inv = (await readInventory(fake, policy, { hostname: 'x', discoverCompose: 'all' })).inventory
  const rows = buildTargets(inv, policy, {}).filter(x => x.kind === 'compose').map(x => [x.id, x.pending])
  assert.deepEqual(rows, [['guest:101:compose:app', 0], ['guest:101:compose:app-dev', 1]])
  const seen: string[] = []
  fake.scripted.set('docker', script => { seen.push(script); return { code: 0, output: 'all containers running', timedOut: false } })
  const { runner, store } = setup(fake)
  const id = await planned(runner, store, ['guest:101:compose:app-dev'])
  const { steps } = await confirm(runner, store, id)
  assert.equal(step(steps, '101', 'docker')!.status, 'ok')
  assert.equal(seen.length, 1)
  assert.match(seen[0], /-p 'app-dev' -f '\/opt\/app\/compose\.dev\.yaml' -f '\/opt\/app\/override\.yaml'/)
  assert.doesNotMatch(seen[0], /-p 'app' /)
})

test('B5: a failed kernel cleanup does not hold back the chosen reboot', async () => {
  const fake = cluster(false)
  fake.inject = (where, cmd) => (where === 'node-b' && /apt-get clean/.test(cmd) ? { code: 1, output: 'E: purge refused', timedOut: false } : undefined)
  const { runner, store } = setup(fake)
  const id = await planned(runner, store, ['node:node-b', 'node:node-b:reboot'])
  const { job, steps } = await confirm(runner, store, id)
  assert.equal(step(steps, 'node-b', 'kernel-cleanup')!.status, 'failed')
  assert.equal(step(steps, 'node-b', 'node-reboot')!.status, 'ok')
  assert.deepEqual(job.report!.items!.map(i => [i.id, i.status]), [['node:node-b', 'ok'], ['node:node-b:reboot', 'ok']])
})

test('minor: the ignore tag and the exclusions are checked again when a guest item runs', async () => {
  const fake = cluster(false)
  const { runner, store } = setup(fake)
  const id = await planned(runner, store, ['guest:101'])
  fake.guests[0].tags = ['hyperprox-ignore']
  const { steps } = await confirm(runner, store, id)
  assert.equal(step(steps, '101', 'apt')!.reason, 'not run: 101 is tagged hyperprox-ignore')
  assert.equal(fake.ran(/^snapshot/, '101'), false)
})

test('minor: a node with only a pinned kernel (no holds, nothing in the policy) is guarded at plan time', async () => {
  const fake = cluster(false)
  fake.nodes[0].pinned = '7.0.1-1-pve'
  fake.nodes[0].pending.push(pkg('proxmox-kernel-7.0', '7.0.2-1'))
  const policy = parsePolicy(POLICY)
  const inv = (await readInventory(fake, policy, { hostname: 'x' })).inventory
  const a = inv.nodes.find(n => n.node === 'node-a')!
  assert.equal(a.pinned, '7.0.1-1-pve')
  assert.match(nodePackageRefusal(policy, a, 'proxmox-kernel-7.0')!, /keeps its kernel held or pinned/)
  assert.match(buildTargets(inv, policy, {}).find(x => x.id === 'node:node-a')!.sub!, /apt-get upgrade/)
})

test('minor: a chosen node the cluster does not have is refused, not dropped', async () => {
  const fake = cluster(false)
  const policy = parsePolicy(POLICY)
  const inv = (await readInventory(fake, policy, { hostname: 'x' })).inventory
  const plan = buildSelectedPlan(inv, policy, { selection: ['node:ghost', 'node:ghost:reboot', 'guest:101'] })
  assert.deepEqual(plan.refused!.map(r => r.id).sort(), ['node:ghost', 'node:ghost:reboot'])
  assert.match(plan.refused![0].reason, /no node ghost/)
})

test('minor: compose projects are not looked for unless the policy turns docker on, or a person asks', async () => {
  const fake = cluster(false)
  fake.guests[0].compose = [{ dir: '/opt/app', name: 'app', images: [] }]
  const policy = parsePolicy(POLICY)
  const quiet = (await readInventory(fake, policy, { hostname: 'x', discoverCompose: 'policy' })).inventory
  assert.equal(quiet.guests.find(g => g.vmid === 101)!.compose, undefined)
  assert.equal(fake.calls.some(c => c.cmd === 'guest:compose-ls' || c.cmd === 'guest:compose-images'), false)
  const asked = (await readInventory(fake, policy, { hostname: 'x', discoverCompose: 'all' })).inventory
  assert.equal(asked.guests.find(g => g.vmid === 101)!.compose![0].name, 'app')
  const on = (await readInventory(fake, parsePolicy(POLICY + 'guests:\n  "101": { docker: manual, compose_dirs: [/opt/app] }\n'), { hostname: 'x', discoverCompose: 'policy' })).inventory
  assert.equal(on.guests.find(g => g.vmid === 101)!.compose![0].source, 'policy')
})

test("minor: HyperProx's own upgrade waits while its guest is being backed up", async () => {
  const fake = cluster(false)
  fake.nodes[2].rebootRequired = false
  const { runner, store } = setup(fake, POLICY + 'self: { vmid: 301 }\n')
  const id = await planned(runner, store, ['guest:301'])
  // The backup of HyperProx's guest starts after its snapshot was taken, before its own upgrade.
  fake.backupTasks = async () => (fake.snapshots.get(301)?.length ? [{ node: 'other-node', at: fake.t, ok: null, vmid: 301 }] : [])
  const { steps } = await confirm(runner, store, id)
  assert.equal(step(steps, '301', 'snapshot')!.status, 'ok')
  const self = step(steps, '301', 'self')!
  assert.equal(self.status, 'skipped')
  assert.match(self.reason!, /^not run: a backup is running \(on other-node, guest 301\)/)
  assert.equal(fake.ran(/systemd-run/), false)
})
