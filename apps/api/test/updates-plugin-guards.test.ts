// Updates leaves a plug-in's compose projects to the plug-in's own guarded update (lib/compose-owners.ts), and leaves a
// guest alone while a plug-in's long job runs in it (lib/long-jobs.ts): in the tree, in the plan, and in the runner.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { UpdatesRunner } from '../src/lib/updates/runner'
import { MemoryStore, type StepRecord } from '../src/lib/updates/store'
import { readInventory } from '../src/lib/updates/inventory'
import { parsePolicy } from '../src/lib/updates/policy'
import { buildTargets, buildSelectedPlan, everythingSelection, type GuardContext } from '../src/lib/updates/targets'
import { guardsFrom } from '../src/lib/updates/guards'
import { composeOwnerRefusal, composeOwnership, registerComposeOwner, resetComposeOwners } from '../src/lib/compose-owners'
import { busyJobs, endLongJob, registerLongJob } from '../src/lib/long-jobs'
import { nextcloudComposeProjects } from '../src/lib/nextcloud'
import { FakeCluster, node, guest, policyLoad, FAST } from './updates-fake'

const POLICY = `
nodes:
  default: { upgrade: dist-upgrade, reboot: auto }
guests:
  "101": { docker: auto, compose_dirs: [/opt/cloud, /opt/other] }
`
const MANAGED = 'Managed by the Nextcloud page — update it there'

function cluster(): FakeCluster {
  const fake = new FakeCluster({ nodes: [node('node-a')], guests: [guest(101, 'node-a'), guest(102, 'node-a')] })
  fake.ceph = null
  fake.guests[0].compose = [
    { dir: '/opt/cloud', name: 'cloud', files: ['/opt/cloud/compose.yaml'], images: [{ image: 'nextcloud:34', current: 'sha256:1', latest: 'sha256:2' }] },
    { dir: '/opt/other', name: 'other', files: ['/opt/other/compose.yaml'], images: [{ image: 'web:1', current: 'sha256:3', latest: 'sha256:4' }] },
  ]
  return fake
}
const owned = (vmid: number, project: string | null, dir: string | null) => guardsFrom({ entries: [{ owner: 'nextcloud', page: 'the Nextcloud page', vmid, project, dir }], unknown: [] }, [])
const step = (steps: StepRecord[], t: string, a: string) => steps.filter(s => s.target === t && s.action === a)

function setup(fake: FakeCluster, guards: () => Promise<GuardContext>) {
  const store = new MemoryStore()
  return { store, runner: new UpdatesRunner({ store, exec: fake, loadPolicy: policyLoad(POLICY), timing: FAST, hostname: 'not-a-guest', guards }) }
}
async function settle(r: UpdatesRunner) { await r.idle(); await r.idle() }

test('the registry: by project name, by directory, a whole guest, and fail closed when an owner cannot be read', async () => {
  resetComposeOwners()
  const off = registerComposeOwner('nextcloud', 'the Nextcloud page', async () => [{ vmid: 101, project: 'cloud', dir: '/opt/cloud/' }, { vmid: 103, project: null, dir: null }])
  const o = await composeOwnership()
  assert.equal(composeOwnerRefusal(o, 101, { name: 'cloud', dir: '/somewhere' }), MANAGED)
  assert.equal(composeOwnerRefusal(o, 101, { dir: '/opt/cloud' }), MANAGED)
  assert.equal(composeOwnerRefusal(o, 101, { name: 'other', dir: '/opt/other' }), null)
  assert.equal(composeOwnerRefusal(o, 102, { name: 'cloud', dir: '/opt/cloud' }), null, 'another guest')
  assert.equal(composeOwnerRefusal(o, 103, { name: 'anything', dir: '/x' }), MANAGED, 'not detected yet: the whole guest')
  off()
  registerComposeOwner('nextcloud', 'the Nextcloud page', async () => { throw new Error('locked') })
  const bad = await composeOwnership()
  assert.match(composeOwnerRefusal(bad, 102, { name: 'web', dir: '/opt/web' })!, /could not read which compose projects the Nextcloud page manages/)
  resetComposeOwners()
})

test('Nextcloud registers its app and signaling projects; an instance not detected yet covers its guest', async () => {
  const list = nextcloudComposeProjects(async () => [
    { id: 'a', name: 'A', guest: { kind: 'lxc', vmid: 101 }, snoozed: {}, addedAt: '', deployment: { kind: 'compose', app: { project: 'cloud', workdir: '/opt/cloud' }, signaling: { project: 'hpb', workdir: '/opt/hpb' } } as any },
    { id: 'b', name: 'B', guest: { kind: 'lxc', vmid: 104 }, snoozed: {}, addedAt: '', deployment: null },
    { id: 'c', name: 'C', guest: { kind: 'qemu', vmid: 105 }, snoozed: {}, addedAt: '', deployment: { kind: 'bare', app: null, signaling: null } as any },
  ])
  assert.deepEqual(await list(), [
    { vmid: 101, project: 'cloud', dir: '/opt/cloud' }, { vmid: 101, project: 'hpb', dir: '/opt/hpb' },
    { vmid: 104, project: null, dir: null },
  ])
})

test('the tree: a managed project is shown, says where to update it, and cannot be chosen or swept up by "everything"', async () => {
  const fake = cluster()
  const policy = parsePolicy(POLICY)
  const inv = (await readInventory(fake, policy, { hostname: 'x', discoverCompose: 'all' })).inventory
  const t = buildTargets(inv, policy, owned(101, 'cloud', '/opt/cloud'))
  const cloud = t.find(x => x.id === 'guest:101:compose:cloud')!
  assert.equal(cloud.selectable, false)
  assert.equal(cloud.blocked, MANAGED)
  assert.equal(everythingSelection(t).includes('guest:101:compose:cloud'), false)
  const other = t.find(x => x.id === 'guest:101:compose:other')!
  assert.equal(other.selectable, true)
  const plan = buildSelectedPlan(inv, policy, { ...owned(101, 'cloud', '/opt/cloud'), selection: ['guest:101:compose:cloud', 'guest:101:compose:other'] })
  assert.deepEqual(plan.refused, [{ id: 'guest:101:compose:cloud', reason: MANAGED }])
  assert.equal(plan.steps.filter(s => s.action === 'docker').length, 1)
})

test('the runner refuses a managed project even when the plan did not know (ownership read again before the pull)', async () => {
  const fake = cluster()
  const seen: string[] = []
  fake.scripted.set('docker', script => { seen.push(script); return { code: 0, output: 'all containers running', timedOut: false } })
  let guards: GuardContext = {}
  const { runner, store } = setup(fake, async () => guards)
  const job = await runner.start('run', 'manual', 'a', 'all', [], ['guest:101:compose:cloud'])
  await settle(runner)
  // Nextcloud is connected between the plan and the run.
  guards = owned(101, 'cloud', '/opt/cloud')
  await runner.confirm(job.id, 'a'); await settle(runner)
  const steps = await store.getSteps(job.id)
  const d = step(steps, '101', 'docker')[0]
  assert.equal(d.status, 'skipped')
  assert.match(d.reason!, /Managed by the Nextcloud page — update it there; nothing was pulled/)
  assert.equal(seen.length, 0, 'nothing was pulled')
})

test('a policy-wide docker step leaves the managed directory out and pulls the rest', async () => {
  const fake = cluster()
  fake.guests[0].compose = undefined
  const seen: string[] = []
  fake.scripted.set('docker', script => { seen.push(script); return { code: 0, output: 'all containers running', timedOut: false } })
  const { runner, store } = setup(fake, async () => owned(101, null, '/opt/cloud'))
  const job = await runner.start('run', 'manual', 'a', 'guests')
  await settle(runner)
  await runner.confirm(job.id, 'a').catch(() => undefined); await settle(runner)
  const d = step(await store.getSteps(job.id), '101', 'docker')[0]
  assert.ok(d, 'the docker step was planned')
  assert.equal(d.status, 'ok', d.reason ?? '')
  assert.equal(seen.length, 1)
  assert.match(seen[0], /\/opt\/other/)
  assert.doesNotMatch(seen[0], /\/opt\/cloud/)
  assert.match(d.output ?? '', /left alone: \/opt\/cloud: Managed by the Nextcloud page/)
})

test('a guest a plug-in\'s long job is busy in: refused in the tree and the plan, and skipped by the runner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-busy-'))
  const before = process.env.HYPERPROX_BUSY_DIR
  process.env.HYPERPROX_BUSY_DIR = dir
  try {
    registerLongJob({ id: 'nc1', owner: 'nextcloud', label: 'Nextcloud Cloud: update 34.0.3 to 34.0.6', detached: true, guest: { kind: 'lxc', vmid: 102 } })
    assert.deepEqual(busyJobs()[0].guest, { kind: 'lxc', vmid: 102 })
    const fake = cluster()
    const policy = parsePolicy(POLICY)
    const inv = (await readInventory(fake, policy, { hostname: 'x' })).inventory
    const g = guardsFrom({ entries: [], unknown: [] }, busyJobs())
    const row = buildTargets(inv, policy, g).find(x => x.id === 'guest:102')!
    assert.equal(row.selectable, false)
    assert.match(row.blocked!, /102 is busy \(Nextcloud Cloud: update 34\.0\.3 to 34\.0\.6\)/)
    const plan = buildSelectedPlan(inv, policy, { ...g, selection: ['guest:102'] })
    assert.equal(plan.steps.length, 0)
    assert.match(plan.refused![0].reason, /busy/)

    // The job started after the plan: the runner checks again before it touches the guest.
    endLongJob('nc1')
    const { runner, store } = setup(fake, async () => guardsFrom({ entries: [], unknown: [] }, busyJobs()))
    const job = await runner.start('run', 'manual', 'a', 'all', [], ['guest:102'])
    await settle(runner)
    registerLongJob({ id: 'nc2', owner: 'nextcloud', label: 'Nextcloud Cloud: database repair', detached: false, guest: { kind: 'lxc', vmid: 102 } })
    await runner.confirm(job.id, 'a'); await settle(runner)
    const steps = (await store.getSteps(job.id)).filter(s => s.target === '102')
    assert.ok(steps.length > 0)
    for (const s of steps) { assert.equal(s.status, 'skipped'); assert.match(s.reason!, /busy \(Nextcloud Cloud: database repair\)/) }
    assert.equal(fake.calls.some(c => c.where === '102' && /apt|snapshot/.test(c.cmd)), false, 'nothing ran in the busy guest')
    endLongJob('nc2')
  } finally {
    if (before === undefined) delete process.env.HYPERPROX_BUSY_DIR; else process.env.HYPERPROX_BUSY_DIR = before
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
