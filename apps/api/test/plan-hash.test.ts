// What makes two plans "the same plan" for Update now's one confirmation: step, machine and how it runs, refused,
// approved, forced, item dependencies and the selection all count; counts and versions that move on refresh do not.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planHash, normaliseDetail } from '../src/lib/updates/plan-hash'

const step = (target: string, action: string, detail: string): any => ({ seq: 1, target, action, detail })
const base = (): any => ({
  steps: [
    step('101', 'snapshot', 'before updating'),
    step('101', 'apt', 'apt-get upgrade (3 packages)'),
    step('node-a', 'node-upgrade', 'apt-get upgrade (5 packages)'),
    step('node-b', 'node-packages', 'only-upgrade (2 packages): curl openssl'),
    step('node-a', 'ceph', 'install 19.2.7'),
  ],
  refused: [{ id: 'node:b:pkg:x', reason: 'held' }], approved: ['a1'], forced: [3, 1],
  items: [{ id: 'i1', label: 'a', kind: 'node', ids: [], seqs: [], dependsOn: [] }, { id: 'i2', label: 'b', kind: 'node', ids: [], seqs: [], dependsOn: ['i1'] }],
  selection: ['node:node-b', 'guest:101'],
})
const h = (mut?: (p: any) => void) => { const p = base(); mut?.(p); return planHash(p) }

test('the same plan hashes the same, whatever the order of what is only a set', () => {
  assert.equal(h(), h())
  assert.equal(h(p => { p.selection.reverse(); p.forced.reverse(); p.items.reverse() }), h())
})

test('version-only and count-only churn does not change the hash', () => {
  assert.equal(h(p => { p.steps[1].detail = 'apt-get upgrade (4 packages)' }), h())
  assert.equal(h(p => { p.steps[2].detail = 'apt-get upgrade (1 package)' }), h())
  assert.equal(h(p => { p.steps[4].detail = 'install 19.2.8' }), h())
  assert.equal(h(p => { p.steps[0].detail = 'before updating. The newest backup is 3 hours old.' }), h())
  assert.equal(normaliseDetail('snapshot', 'not possible — bind-mounted storage; updating without a snapshot was approved. Newest backup 2d'), 'not possible')
})

test('each thing a person would call the plan changes the hash', () => {
  const was = h()
  assert.notEqual(h(p => { p.steps[2].detail = 'apt-get dist-upgrade (5 packages)' }), was, 'upgrade mode')
  assert.notEqual(h(p => { p.steps[3].detail = 'only-upgrade (2 packages): curl libssl3' }), was, 'package names')
  assert.notEqual(h(p => { p.steps.push(step('102', 'apt', 'apt-get upgrade (1 package)')) }), was, 'a machine added')
  assert.notEqual(h(p => { p.steps[0].detail = 'not possible — bind-mounted storage' }), was, 'a guest that cannot be snapshotted')
  assert.notEqual(h(p => { p.refused = [] }), was, 'refused')
  assert.notEqual(h(p => { p.approved = [] }), was, 'approved')
  assert.notEqual(h(p => { p.forced = [3] }), was, 'forced')
  assert.notEqual(h(p => { p.items[1].dependsOn = [] }), was, 'dependsOn')
  assert.notEqual(h(p => { p.selection = ['node:node-b'] }), was, 'selection')
})
