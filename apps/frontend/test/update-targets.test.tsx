// The Updates target tree: every node and guest with its own count, a box per row, a parent's box covering the
// rows below it but never a reboot, the select helpers, blocked rows saying why, and each chosen item's result.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/update-targets.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import "./css-stub"
import { renderToStaticMarkup } from 'react-dom/server'
import type { UpdatesTarget, UpdatesJob, UpdatesPlan } from '@hyperprox/types'
import { forest, cascade, tickState, toggle, helperSelection, approvalsFor, itemViews } from '../lib/update-targets'
import { TargetTree } from '../components/updates/TargetTree'
import { ItemOrder, ItemResults } from '../components/updates/ItemList'

const T = (t: Partial<UpdatesTarget> & Pick<UpdatesTarget, 'id' | 'kind'>): UpdatesTarget =>
  ({ parent: null, label: t.id, pending: 0, security: 0, selectable: true, ...t })

const TARGETS: UpdatesTarget[] = [
  T({ id: 'node:node-a', kind: 'node', label: 'node-a', node: 'node-a', pending: 2, everything: true, needsReboot: true,
      packages: [{ name: 'curl', from: '1', to: '2' }, { name: 'libssl3', from: '3.0-1', to: '3.0-2', security: true }] }),
  T({ id: 'node:node-a:pkg:curl', kind: 'node-pkg', parent: 'node:node-a', label: 'curl', pending: 1 }),
  T({ id: 'node:node-a:pkg:libssl3', kind: 'node-pkg', parent: 'node:node-a', label: 'libssl3', pending: 1, security: 1 }),
  T({ id: 'node:node-a:reboot', kind: 'node-reboot', parent: 'node:node-a', node: 'node-a', label: 'Reboot (with HA maintenance)', needsReboot: true }),
  T({ id: 'node:gpu-node', kind: 'node', label: 'gpu-node', node: 'gpu-node', pending: 1, everything: true }),
  T({ id: 'node:gpu-node:pkg:proxmox-kernel-7.0', kind: 'node-pkg', parent: 'node:gpu-node', label: 'proxmox-kernel-7.0', pending: 1,
      selectable: false, blocked: 'proxmox-kernel-7.0 is held on gpu-node: held packages are never installed or unheld' }),
  T({ id: 'guest:101', kind: 'guest', parent: 'node:node-a', label: '101 web', vmid: 101, pending: 3, security: 1, everything: true }),
  T({ id: 'guest:101:pkg:openssl', kind: 'guest-pkg', parent: 'guest:101', label: 'openssl', pending: 1, security: 1 }),
  T({ id: 'guest:101:compose:/opt/app', kind: 'compose', parent: 'guest:101', label: '/opt/app', pending: 1 }),
  T({ id: 'guest:110', kind: 'guest', parent: 'node:node-a', label: '110 private', vmid: 110, selectable: false, blocked: '110 (private): tagged hyperprox-ignore: HyperProx never looks inside it' }),
  T({ id: 'guest:205', kind: 'guest', parent: 'node:gpu-node', label: '205 remote', vmid: 205, pending: 1, approvals: ['nosnap:205'] }),
]

test('a node box covers its packages and its guests, never its reboot; the reboot is chosen on its own row', () => {
  const f = forest(TARGETS)
  const ids = cascade(f, 'node:node-a')
  assert.ok(ids.includes('guest:101') && ids.includes('guest:101:compose:/opt/app') && ids.includes('node:node-a:pkg:curl'))
  assert.equal(ids.includes('node:node-a:reboot'), false)
  assert.equal(ids.includes('guest:110'), false, 'a blocked row is never chosen')
  assert.deepEqual(cascade(f, 'node:node-a:reboot'), ['node:node-a:reboot'])
  let c = toggle(f, 'node:node-a', new Set())
  assert.equal(tickState(f, 'node:node-a', c), 'on')
  assert.equal(c.has('node:node-a:reboot'), false)
  c = toggle(f, 'guest:101:compose:/opt/app', c)
  assert.equal(tickState(f, 'node:node-a', c), 'some')
  assert.equal(tickState(f, 'guest:110', c), 'none')
  c = toggle(f, 'node:node-a', c)
  assert.equal(tickState(f, 'node:node-a', c), 'on', 'a partly ticked box ticks everything it covers')
  c = toggle(f, 'node:node-a', c)
  assert.equal(c.size, 0)
})

test('select helpers: everything, guests, compose projects, nodes, security only', () => {
  assert.deepEqual(helperSelection(TARGETS, 'everything').sort(), ['guest:101', 'node:gpu-node', 'node:node-a'])
  assert.deepEqual(helperSelection(TARGETS, 'guests').sort(), ['guest:101', 'guest:205'])
  assert.deepEqual(helperSelection(TARGETS, 'containers'), ['guest:101:compose:/opt/app'])
  assert.deepEqual(helperSelection(TARGETS, 'nodes').sort(), ['node:gpu-node', 'node:node-a'])
  assert.deepEqual(helperSelection(TARGETS, 'security').sort(), ['guest:101:pkg:openssl', 'node:node-a:pkg:libssl3'])
  assert.deepEqual(approvalsFor(TARGETS, new Set(['guest:205', 'guest:101'])), ['nosnap:205'])
})

test('the tree draws every row with its count and box; a held kernel package shows why it is not offered', () => {
  const h = renderToStaticMarkup(<TargetTree targets={TARGETS} clusterName="Home cluster" chosen={new Set(['guest:101', 'guest:101:pkg:openssl', 'guest:101:compose:/opt/app'])} onChange={() => {}} onUpdate={() => {}} />)
  assert.match(h, /role="tree"/)
  assert.match(h, /Home cluster/)
  assert.match(h, /2 nodes · 7 updates pending/)
  for (const id of ['node:node-a', 'node:gpu-node', 'guest:101', 'node:node-a:reboot']) assert.match(h, new RegExp(`data-target="${id}"`))
  assert.match(h, /aria-label="Choose guest 101 web"[^>]*checked=""/)
  assert.match(h, /aria-label="Choose node node-a"[^>]*aria-checked="mixed"/)
  assert.match(h, /needs reboot/)
  assert.doesNotMatch(h, /<div class="space-y-2"><\/div>/, 'no empty preview under a row')
  assert.match(h, /Reboot node-a with HA maintenance/)
  assert.match(h, /tagged hyperprox-ignore/)
  assert.match(h, /3 chosen/)
  assert.match(h, /Update selected/)
  // The guarded node's held kernel: listed, no box, the reason in words (the node is open by default).
  assert.match(h, /data-target="node:gpu-node:pkg:proxmox-kernel-7\.0"/)
  assert.doesNotMatch(h, /aria-label="Choose package proxmox-kernel-7\.0"/)
  assert.match(h, /held packages are never installed or unheld/)
})

test('disabled while a job is active: no box or button can be used', () => {
  const h = renderToStaticMarkup(<TargetTree targets={TARGETS} clusterName="c" chosen={new Set()} onChange={() => {}} onUpdate={() => {}} disabled />)
  assert.doesNotMatch(h, /<input type="checkbox"(?![^>]*disabled)/)
  assert.match(h, /<button[^>]*disabled=""[^>]*>Update selected/)
})

const PLAN: UpdatesPlan = {
  steps: [
    { seq: 1, target: '101', action: 'snapshot', detail: 'before updating' },
    { seq: 2, target: '101', action: 'apt', detail: 'apt-get upgrade (3 packages)' },
    { seq: 3, target: 'node-a', action: 'node-packages', detail: 'only-upgrade (1 package): curl' },
    { seq: 4, target: 'node-a', action: 'node-reboot', detail: 'auto — chosen by a person (forced)' },
  ],
  warnings: ['Not planned: node:gpu-node:pkg:proxmox-kernel-7.0 — held'],
  items: [
    { id: 'guest:101', label: '101 web: 3 packages', kind: 'guest', ids: ['guest:101'], seqs: [1, 2], dependsOn: [] },
    { id: 'node:node-a:pkgs', label: 'node-a: curl', kind: 'node-pkg', ids: ['node:node-a:pkg:curl'], seqs: [3], dependsOn: [] },
    { id: 'node:node-a:reboot', label: 'Reboot node-a', kind: 'node-reboot', ids: ['node:node-a:reboot'], seqs: [4], dependsOn: ['guest:101', 'node:node-a:pkgs'] },
  ],
  refused: [{ id: 'node:gpu-node:pkg:proxmox-kernel-7.0', reason: 'held on gpu-node' }],
  stepOffset: 2,
}

test('the order before confirming: numbered items, their steps, what each waits for, and what was refused', () => {
  const h = renderToStaticMarkup(<ItemOrder plan={PLAN} />)
  assert.match(h, /data-order/)
  assert.ok(h.indexOf('101 web') < h.indexOf('node-a: curl') && h.indexOf('node-a: curl') < h.indexOf('Reboot node-a'))
  assert.match(h, /Snapshot → apt upgrade/)
  assert.match(h, /only if 101 web: 3 packages, node-a: curl finish/)
  assert.match(h, /Not planned \(1\)/)
  assert.match(h, /held on gpu-node/)
})

test('live results per item: a failure, the reboot that waited for it skipped, an unrelated item done', () => {
  const s = (seq: number, status: string, reason: string | null = null) => ({ id: `s${seq}`, seq: seq + 2, target: 'x', action: 'apt' as const, status: status as any, reason })
  const job: Pick<UpdatesJob, 'plan' | 'steps' | 'report'> = {
    plan: PLAN, report: null,
    steps: [s(1, 'ok'), s(2, 'failed', 'apt failed (snapshot hp-upd-1)'), s(3, 'running'), s(4, 'skipped', 'not run: it waits for 101 web: 3 packages, which did not finish')],
  }
  const v = itemViews(job)
  assert.deepEqual(v.map(x => [x.id, x.status]), [['guest:101', 'failed'], ['node:node-a:pkgs', 'running'], ['node:node-a:reboot', 'skipped']])
  const h = renderToStaticMarkup(<ItemResults job={job} />)
  assert.match(h, /data-item="guest:101" data-status="failed"/)
  assert.match(h, /apt failed \(snapshot hp-upd-1\)/)
  assert.match(h, /data-item="node:node-a:reboot" data-status="skipped"/)
  // Once the report is written its outcomes are what the history shows, steps loaded or not.
  const done = itemViews({ plan: PLAN, steps: [], report: { summary: '', changed: [], skipped: [], rebootsPending: [], items: [{ id: 'guest:101', label: 'x', status: 'ok' }, { id: 'node:node-a:pkgs', label: 'y', status: 'ok' }, { id: 'node:node-a:reboot', label: 'z', status: 'ok' }] } })
  assert.deepEqual(done.map(x => x.status), ['ok', 'ok', 'ok'])
})
