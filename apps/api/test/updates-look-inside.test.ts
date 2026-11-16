// Updates honours Remote access's "never look inside" list (lib/updates/look-inside.ts): such a guest is shown,
// not read, not selectable, left out of "Update everything", refused in the plan and again by the runner before it
// is touched; the production executor refuses to enter it; an unreadable list keeps every guest out, nodes not.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UpdatesRunner } from '../src/lib/updates/runner'
import { MemoryStore } from '../src/lib/updates/store'
import { readInventory } from '../src/lib/updates/inventory'
import { parsePolicy } from '../src/lib/updates/policy'
import { buildTargets, buildSelectedPlan, everythingSelection } from '../src/lib/updates/targets'
import { productionExecutor } from '../src/lib/updates/executor'
import { classifyFailure, plainReason } from '../src/lib/failure'
import { GuestExcludedRefusal, ExclusionsUnknownRefusal } from '../src/lib/guest-guard'
import { FakeCluster, node, guest, policyLoad, FAST } from './updates-fake'

const POLICY = `
nodes:
  default: { upgrade: dist-upgrade, reboot: auto }
`
const WORDS = "Excluded in Remote access — HyperProx doesn't look inside this guest"

function cluster(list: () => Promise<string[]>): FakeCluster {
  const fake = new FakeCluster({ nodes: [node('node-a')], guests: [guest(101, 'node-a'), guest(102, 'node-a')] })
  fake.ceph = null
  ;(fake as any).lookInsideExclusions = list
  return fake
}
const readIn = (fake: FakeCluster, vmid: number) => fake.calls.some(c => c.where === String(vmid) && c.cmd.startsWith('guest:'))

test('the tree: an excluded guest is listed, marked, not read, not selectable and not in "Update everything"', async () => {
  const fake = cluster(async () => ['lxc-102'])
  const policy = parsePolicy(POLICY)
  const inv = (await readInventory(fake, policy, { hostname: 'x' })).inventory
  assert.equal(inv.guests.find(g => g.vmid === 102)!.unmanagedReason, 'remote-excluded')
  assert.equal(readIn(fake, 102), false, 'nothing was run inside it')
  assert.equal(readIn(fake, 101), true)
  const t = buildTargets(inv, policy, {})
  const row = t.find(x => x.id === 'guest:102')!
  assert.equal(row.selectable, false)
  assert.match(row.blocked!, new RegExp(WORDS))
  assert.ok(!everythingSelection(t).includes('guest:102'))
  assert.ok(everythingSelection(t).includes('guest:101'))
  const plan = buildSelectedPlan(inv, policy, { selection: ['guest:102', 'guest:101'] })
  assert.equal(plan.refused!.find(r => r.id === 'guest:102')!.reason.includes(WORDS), true)
  assert.ok(plan.steps.some(s => s.target === '101'))
})

test('an unreadable list keeps every guest out (fail closed); nodes are unaffected', async () => {
  const fake = cluster(async () => { throw new Error('database down') })
  const policy = parsePolicy(POLICY)
  const inv = (await readInventory(fake, policy, { hostname: 'x' })).inventory
  assert.deepEqual(inv.guests.map(g => g.unmanagedReason), ['exclusions-unknown', 'exclusions-unknown'])
  assert.equal(readIn(fake, 101) || readIn(fake, 102), false)
  const t = buildTargets(inv, policy, {})
  for (const id of ['guest:101', 'guest:102']) {
    const row = t.find(x => x.id === id)!
    assert.equal(row.selectable, false)
    assert.match(row.blocked!, /exclusion list could not be read/)
  }
  assert.equal(t.find(x => x.id === 'node:node-a')!.selectable, true)
})

test('the runner reads the list again before each guest: one added after the plan is not touched', async () => {
  let list: string[] = []
  const fake = cluster(async () => list)
  const store = new MemoryStore()
  const runner = new UpdatesRunner({ store, exec: fake, loadPolicy: policyLoad(POLICY), timing: FAST, hostname: 'not-a-guest' })
  const job = await runner.start('run', 'manual', 'a', 'all', [], ['guest:101', 'guest:102'])
  await runner.idle(); await runner.idle()
  assert.ok((await store.getSteps(job.id)).some(s => s.target === '102' && s.action === 'apt'), 'planned while not excluded')
  list = ['lxc-102']
  const before = fake.calls.length
  await runner.confirm(job.id, 'a'); await runner.idle(); await runner.idle()
  const steps = await store.getSteps(job.id)
  for (const s of steps.filter(x => x.target === '102')) { assert.equal(s.status, 'skipped'); assert.match(s.reason!, new RegExp(WORDS)) }
  assert.equal(steps.find(x => x.target === '101' && x.action === 'apt')!.status, 'ok')
  assert.equal(fake.calls.slice(before).some(c => c.where === '102'), false, 'no snapshot, no apt, nothing')
})

test('the production executor refuses to enter an excluded guest at home, fails closed, and leaves remotes alone', async () => {
  // Proxmox answers the live tag read; any other path fails (that is how the test knows the guard was passed).
  const pve = { fetchStrict: async (p: string) => { if (p === '/cluster/resources?type=vm') return []; throw new Error('no proxmox in this test') } } as any
  const g = { vmid: 102, type: 'lxc' as const, node: 'node-a', name: 'guest-102' }
  await assert.rejects(productionExecutor(pve, { exclusions: async () => ['lxc-102'] }).guestExec(g, 'true'), (e: any) => e instanceof GuestExcludedRefusal)
  await assert.rejects(productionExecutor(pve, { exclusions: async () => { throw new Error('down') } }).guestExec(g, 'true'), (e: any) => e instanceof ExclusionsUnknownRefusal)
  // Not on the list: past the guard (it then fails reaching the fake Proxmox).
  await assert.rejects(productionExecutor(pve, { exclusions: async () => [] }).guestExec(g, 'true'), /no proxmox in this test/)
  const remote = productionExecutor(pve, { remote: true, exclusions: async () => ['lxc-102'] })
  assert.equal(remote.lookInsideExclusions, undefined)
  await assert.rejects(remote.guestExec(g, 'true'), (e: any) => !(e instanceof GuestExcludedRefusal))
})

test('the refusals keep their words and status through the failure path', () => {
  const a = classifyFailure(new GuestExcludedRefusal('guest-102', "Remote access's exclusion list"))
  assert.equal(a.status, 409); assert.equal(a.body.code, 'excluded'); assert.match(a.body.error, /guest-102 is left alone/)
  const b = classifyFailure(new ExclusionsUnknownRefusal())
  assert.equal(b.status, 503); assert.equal(b.body.code, 'exclusions_unknown'); assert.match(b.body.error, /exclusion list could not be read/)
  assert.match(plainReason(new ExclusionsUnknownRefusal(), 'Nextcloud'), /exclusion list could not be read/)
  assert.match(plainReason(new GuestExcludedRefusal('guest-102', 'the hyperprox-ignore tag'), 'Nextcloud'), /left alone \(the hyperprox-ignore tag\)/)
})
