// Automatic reboots on the Updates page: the words for the window, a node that waits for its reboot instead of a
// Reboot button, the "Reboot automatically in the next window" tick, and the card itself.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/auto-reboots.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import "./css-stub"
import { renderToStaticMarkup } from 'react-dom/server'
import type { UpdatesRebootStatus } from '@hyperprox/types'
import { daysText, windowText, whenText, summaryText, nodeWaitText, rebootLikely, rollingStages } from '../lib/auto-reboots'
import { RebootsCard } from '../components/updates/RebootsCard'
import { NodesTable } from '../components/updates/NodesTable'

const base = (over: Partial<UpdatesRebootStatus> = {}): UpdatesRebootStatus => ({
  cluster: { id: 'home', name: 'Home', kind: 'home' }, available: true,
  settings: { nodes: true, guests: false, window: { start: '03:00', hours: 3, days: [0, 1, 2, 3, 4, 5, 6] }, timezone: 'UTC', quiet: true },
  inWindow: false, nextWindow: { start: '2027-01-15T03:00:00.000Z', end: '2027-01-15T06:00:00.000Z' }, queued: null,
  waiting: { nodes: [{ node: 'node-b', why: 'a new kernel or a package asks for a reboot' }], guests: [], at: '2027-01-15T03:00:00.000Z', guestsAt: null },
  never: [], active: null, leftOn: null, history: [], ...over,
})

test('the window in words', () => {
  assert.equal(daysText([0, 1, 2, 3, 4, 5, 6]), 'every day')
  assert.equal(daysText([5, 1, 2, 3, 4]), 'weekdays')
  assert.equal(daysText([6, 0]), 'weekends')
  assert.equal(daysText([2, 4]), 'Tue, Thu')
  assert.equal(windowText({ start: '03:00', hours: 3, days: [] }), '03:00–06:00')
  assert.equal(windowText({ start: '23:00', hours: 4, days: [] }), '23:00–03:00')
  assert.equal(whenText('2027-01-15T03:00:00.000Z', 'UTC'), 'Fri 03:00')
  assert.match(summaryText(base()), /^On for nodes\. Window 03:00–06:00 every day \(UTC\), waiting while anyone is watching\.$/)
  assert.match(summaryText(base({ settings: { ...base().settings, nodes: false } , waiting: { ...base().waiting, at: null } })), /^Off\./)
})

test('a waiting node says when it reboots instead of offering a Reboot button', () => {
  assert.equal(nodeWaitText(base(), 'node-b'), 'Waiting for its automatic reboot at Fri 03:00')
  assert.equal(nodeWaitText(base(), 'node-a'), null)
  assert.equal(nodeWaitText(base({ waiting: { ...base().waiting, at: null } }), 'node-b'), null, 'off: the button stays')
  const nodes: any[] = ['node-a', 'node-b'].map(n => ({ node: n, online: true, pending: [], cephPending: false, kernelPending: false, rebootRequired: n === 'node-b', rebootPending: false, policy: { upgrade: 'upgrade', reboot: 'manual' }, holdsOk: null, pinOk: null, isSelf: false }))
  const html = renderToStaticMarkup(<NodesTable nodes={nodes} canReboot onReboot={() => {}} waitText={n => nodeWaitText(base(), n)} />)
  assert.match(html, /Waiting for its automatic reboot at Fri 03:00/)
  assert.equal((html.match(/aria-label="Reboot node-/g) ?? []).length, 1, 'only node-a keeps its Reboot button')
})

test('the next-window tick is on when the run will need a reboot', () => {
  const inv: any = { refreshedAt: '', nodes: [{ node: 'node-a', kernelPending: true, rebootRequired: false, rebootPending: false, pending: [] }, { node: 'node-c', kernelPending: false, rebootRequired: false, rebootPending: false, pending: [] }], guests: [{ vmid: 101, rebootRequired: false, pending: [{ name: 'libc6', from: '1', to: '2' }] }, { vmid: 102, rebootRequired: false, pending: [{ name: 'curl', from: '1', to: '2' }] }] }
  const plan = (steps: any[]): any => ({ steps, warnings: [] })
  assert.equal(rebootLikely(plan([{ seq: 1, target: 'node-a', action: 'node-upgrade' }]), inv), true)
  assert.equal(rebootLikely(plan([{ seq: 1, target: 'node-c', action: 'node-upgrade' }]), inv), false)
  assert.equal(rebootLikely(plan([{ seq: 1, target: '101', action: 'apt' }]), inv), true)
  assert.equal(rebootLikely(plan([{ seq: 1, target: '102', action: 'apt' }]), inv), false)
  const src = fs.readFileSync(path.join(__dirname, '../app/updates/page.tsx'), 'utf8')
  assert.match(src, /Reboot automatically in the next window/)
  assert.match(src, /autoReboot: true/)
})

test('the card: waiting list with its time, a run in progress node by node, Make safe, the history', () => {
  const job: any = {
    id: 'j1', trigger: 'schedule', status: 'running', plan: { steps: [], warnings: [] }, startedAt: '2027-01-15T03:00:00Z', steps: [
      { id: 's1', seq: 1, target: 'cluster', action: 'preflight', status: 'ok' },
      { id: 's2', seq: 2, target: 'node-a', action: 'node-reboot', status: 'ok' },
      { id: 's3', seq: 3, target: 'node-b', action: 'node-reboot', status: 'running' },
      { id: 's4', seq: 4, target: 'node-c', action: 'self', status: 'pending' },
    ],
  }
  assert.deepEqual(rollingStages(job).map(s => `${s.label}:${s.state}:${s.status}`), ['node-a:done:back', 'node-b:warn:rebooting now', 'node-c:ok:waiting its turn'])
  const html = renderToStaticMarkup(<RebootsCard status={base({
    active: job,
    leftOn: { jobId: 'j0', node: 'node-c', maintenance: true, noout: true },
    history: [{ id: 'j0', kind: 'window', status: 'failed', startedAt: '2027-01-14T03:00:00Z', finishedAt: '2027-01-14T03:40:00Z', summary: 'Stopped: node-c did not come back', machines: [] }],
  })} error={null} busy={false} jobActive={false} onSave={() => {}} onRebootNow={() => {}} onMakeSafe={() => {}} />)
  assert.match(html, /Waiting for its automatic reboot at Fri 03:00/)
  assert.match(html, /Rolling reboot in progress/)
  assert.match(html, /Make safe/)
  assert.match(html, /HA maintenance on node-c and Ceph noout/)
  assert.match(html, /Stopped: node-c did not come back/)
  assert.match(html, /Reboot now \(rolling\)/)
})

test('a remote cluster: the card says HyperProx does not reboot its nodes on its own, and offers nothing', () => {
  const html = renderToStaticMarkup(<RebootsCard status={base({ available: false, unavailable: 'HyperProx does not reboot the nodes of a remote cluster on its own.' })} error={null} busy={false} jobActive={false} onSave={() => {}} onRebootNow={() => {}} onMakeSafe={() => {}} />)
  assert.match(html, /does not reboot the nodes of a remote cluster/)
  assert.ok(!/Reboot now/.test(html))
})
