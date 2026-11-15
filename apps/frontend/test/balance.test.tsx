// The Load balancing page's pieces, rendered to HTML: nodes as columns with CPU and RAM load bars before and after the
// plan and a sparkline of the window, the plan as guests travelling between nodes with both nodes' bars, a plan's
// progress, automatic balancing in words, the plan's buttons, and the redirects from the old Placement addresses.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { LoadColumns, LoadColumn, PlanView, PlanProgress, StepCard } from '../components/placement/balance-parts'
import { loadBars, sparkPoints, planChoices, progressWords, autoWords, scoreTone, orderNodes, afterOf, stepLine, stopWords } from '../components/placement/balance-logic'
import type { BalancePlan, NodeLoad, PlanRecord, PlanStep, QuietStatus } from '../components/placement/types'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const movedPages = require('../redirects') as Array<{ source: string; destination: string; permanent: boolean }>

const G = 1024 ** 3
const T = 1_790_000_000
const hist = (v: number) => Array.from({ length: 24 }, (_, i) => [T + i * 3600, v] as [number, number])
const node = (name: string, o: Partial<NodeLoad> = {}): NodeLoad => ({
  node: name, online: true, maintenance: false, counted: true, threads: 8, maxmem: 32 * G,
  cpu: { now: 0.3, p95: 0.35, mean: 0.3 }, mem: { now: 0.5, p95: 0.55, mean: 0.5 }, cpuShare: 0.33, memShare: 0.33,
  history: { cpu: hist(0.3), mem: hist(0.5) }, ...o,
})
const step = (o: Partial<PlanStep> = {}): PlanStep => ({
  n: 1, sid: 'ct:107', name: 'worker', type: 'lxc', ha: false, from: 'node1', to: 'node2', method: 'migrate', load: { cores: 0.5, mem: 4 * G },
  before: { from: { cpu: 0.3, mem: 0.85 }, to: { cpu: 0.2, mem: 0.3 } }, after: { from: { cpu: 0.28, mem: 0.6 }, to: { cpu: 0.22, mem: 0.55 } },
  gain: 35, scoreAfter: 80, downtimeSec: 20, copyBytes: 0, copySec: 0, bwlimitKiB: 51200, why: ['worker uses 0.5 cores and 4.0 GiB at its 95th percentile.'], ...o,
})
const score = (s: number) => ({ score: s, spread: (100 - s) / 100, cpuSpread: 0.1, memSpread: (100 - s) / 100, busiest: 'node1', idlest: 'node2' })
const plan = (o: Partial<BalancePlan> = {}): BalancePlan => ({
  goal: 'mem', score: score(45), target: score(80), steps: [step()], suggestions: [], nodesAfter: [{ node: 'node1', cpu: 0.28, mem: 0.6 }, { node: 'node2', cpu: 0.22, mem: 0.55 }],
  needSec: 140, left: ['After these, no further move gains at least 3 points.'], words: [], ...o,
})
const quiet = (o: Partial<QuietStatus> = {}): QuietStatus => ({ quietNow: true, nowWhy: [], nextQuiet: { start: T, end: T + 3600_000 }, upcoming: [], unread: [], tz: 'UTC', ...o })

test('a node column: CPU and RAM bars at the p95, its share of the cluster, a sparkline, and the after-plan bar', () => {
  const html = renderToStaticMarkup(<LoadColumn n={node('node1', { mem: { now: 0.8, p95: 0.85, mean: 0.8 }, memShare: 0.62 })} after={{ cpu: 0.28, mem: 0.6 }} busiest />)
  assert.match(html, /aria-label="Node node1 load"/)
  assert.match(html, /62% of RAM/)
  assert.match(html, /85% p95/)
  assert.match(html, /→ 60% after the plan/)
  assert.match(html, /data-after="true"/)
  assert.match(html, /data-busiest="true"/)
  assert.match(html, /<polyline/)
  assert.match(html, /aria-label="node1 over the window: CPU and RAM"/)
})

test('an offline node or one without history says so, and draws no sparkline', () => {
  assert.match(renderToStaticMarkup(<LoadColumn n={node('node3', { online: false, counted: false, history: { cpu: [], mem: [] } })} />), /offline[\s\S]*no history/)
  assert.match(renderToStaticMarkup(<LoadColumn n={node('node4', { counted: false })} />), /no history/)
})

test('the columns carry a legend, and over-the-line bars turn to the warning gradient', () => {
  const html = renderToStaticMarkup(<LoadColumns nodes={[node('node1'), node('node2')]} after={afterOf(plan())} />)
  assert.match(html, /bright part: after the plan/)
  const bars = loadBars(node('n', { cpu: { now: 0.9, p95: 0.92, mean: 0.9 }, mem: { now: 0.95, p95: 0.95, mean: 0.9 } }))
  assert.deepEqual(bars.map(b => b.over), [true, true])
})

test('the plan: score now and after, each move as a guest travelling between nodes with both nodes before and after', () => {
  const html = renderToStaticMarkup(<PlanView plan={plan({ suggestions: [{ kind: 'edit-rule', sid: 'ct:101', name: 'media', from: 'node1', to: 'node3', rule: 'home', gain: 5, words: 'media is held on node1 by its HA rule "home".' }] })} />)
  assert.match(html, /SCORE NOW[\s\S]*45[\s\S]*AFTER THE PLAN[\s\S]*80/)
  assert.match(html, /1 move, \+35 points, by RAM/)
  assert.match(html, /aria-label="Move 1: worker from node1 to node2"/)
  assert.match(html, /\+35 pts/)
  assert.match(html, /85%→60%/, 'the source before and after')
  assert.match(html, /30%→55%/, 'the target before and after')
  assert.match(html, /about 20 s offline \(a container restarts\)/)
  assert.match(html, /at most 50 MiB\/s/)
  assert.match(html, /HA rule change[\s\S]*held on node1/)
  assert.match(html, /no further move gains/)
})

test('a move line: a VM moves live, copied disks are shown with their time', () => {
  assert.match(stepLine(step({ type: 'qemu', downtimeSec: null, copyBytes: 32 * G, copySec: 700, method: 'migrate' })), /no outage expected[\s\S]*32 GiB to copy, about 12 min/)
  assert.match(renderToStaticMarkup(<StepCard s={step({ ha: true, method: 'ha', bwlimitKiB: null })} />), /HA · worker/)
})

test('the plan buttons: run now only in a quiet window, schedule when there is a next one, nothing while a plan runs', () => {
  const running: PlanRecord = { id: 'pl1', source: 'manual', status: 'running', by: 'a', goal: 'mem', scoreBefore: 45, scoreTarget: 80, steps: [], scheduledFor: null, startedAt: T, endedAt: null, error: null, stopRequested: false }
  assert.deepEqual(planChoices({ plan: plan(), quiet: quiet(), running: null }), ['now', 'schedule'])
  assert.deepEqual(planChoices({ plan: plan(), quiet: quiet({ quietNow: false }), running: null }), ['schedule'])
  assert.deepEqual(planChoices({ plan: plan(), quiet: quiet({ quietNow: false, nextQuiet: null }), running: null }), [])
  assert.deepEqual(planChoices({ plan: plan(), quiet: quiet(), running }), [])
  assert.deepEqual(planChoices({ plan: plan({ steps: [] }), quiet: quiet(), running: null }), [])
})

test('plan progress: each move with its state, the reason a plan stopped, and a scheduled plan\'s time', () => {
  const p: PlanRecord = {
    id: 'pl1', source: 'manual', status: 'stopped', by: 'a', goal: 'mem', scoreBefore: 45, scoreTarget: 92, scheduledFor: null, startedAt: T, endedAt: T, stopRequested: false,
    error: 'Stopped before move 2: node3 is offline.',
    steps: [
      { sid: 'ct:107', name: 'worker', from: 'node1', to: 'node2', method: 'migrate', status: 'done', moveId: 'mv1', error: null, startedAt: T, endedAt: T },
      { sid: 'ct:109', name: 'worker2', from: 'node1', to: 'node3', method: 'migrate', status: 'skipped', moveId: null, error: 'Stopped before move 2: node3 is offline.', startedAt: null, endedAt: null },
    ],
  }
  const html = renderToStaticMarkup(<PlanProgress p={p} />)
  assert.match(html, /Plan · stopped · 1 of 2 moves done · score 45 → 92/)
  assert.match(html, /data-step="done"[\s\S]*data-step="skipped"/)
  assert.match(html, /node3 is offline/)
  assert.match(progressWords({ ...p, status: 'scheduled', scheduledFor: Date.UTC(2026, 5, 16, 5) }, 'UTC'), /scheduled[\s\S]*runs Tue 05:00/)
  assert.match(progressWords({ ...p, status: 'running', stopRequested: true }), /stopping after the move under way/)
  assert.match(progressWords({ ...p, source: 'auto' }), /^Automatic/)
})

test('automatic balancing in words: off by default, notify only, or applying within the stricter limits', () => {
  const state = { lastCheckAt: null, lastWhy: null, lastNotifiedAt: null, lastNotifiedSig: null }
  const s = { enabled: false, apply: false, sustainHours: 6, checkEveryMin: 60, maxMovesPerDay: 2, minHoursBetween: 6 }
  assert.match(autoWords({ settings: s, approval: null, state }), /^Off\./)
  assert.match(autoWords({ settings: { ...s, enabled: true }, approval: null, state }), /notifying only/)
  const approval = { email: 'a@example.com', role: 'admin', at: Date.UTC(2026, 5, 15), limits: { ...s, enabled: true, apply: true, maxMovesPerDay: 1 }, ceph: { checks: ['POOL_NO_REDUNDANCY'] } }
  assert.match(autoWords({ settings: { ...s, enabled: true, apply: true, maxMovesPerDay: 5 }, approval, state: { ...state, lastWhy: 'Balanced.' } }),
    /up to 1 move a day, at least 6 h apart, in quiet windows only, approved by a@example\.com on 2026-06-15 \(good for 30 days; the Ceph warnings accepted then, for 7\)\. Last check: Balanced\./)
})

test('the emergency stop says what it stopped, scheduled single moves included', () => {
  assert.equal(stopWords(0, 0), 'Stopped: applying is off.')
  assert.match(stopWords(1, 2), /1 plan is stopped or cancelled .*; 2 scheduled moves are cancelled\./)
  assert.match(stopWords(0, 0, [{ name: 'worker', sid: 'ct:107', status: 'running' }]), /Not cancelled, because it had already started: worker \(running\)/)
})

test('score tones, node order and sparkline points', () => {
  assert.equal(scoreTone(0.1, 0.25), 'good')
  assert.equal(scoreTone(0.4, 0.25), 'warn')
  assert.equal(scoreTone(0.6, 0.25), 'crit')
  const order = orderNodes([node('a', { mem: { now: 0, p95: 0.2, mean: 0 } }), node('b', { counted: false }), node('c', { mem: { now: 0, p95: 0.9, mean: 0 } })], 'mem')
  assert.deepEqual(order.map(n => n.node), ['c', 'a', 'b'])
  assert.equal(sparkPoints([]), '')
  assert.equal(sparkPoints([[0, 0], [10, 1]], 100, 20), '0,20 100,0')
})

test('the old Placement addresses redirect to Load balancing', () => {
  assert.deepEqual(movedPages.map(r => [r.source, r.destination]), [['/placement', '/balance'], ['/settings/placement', '/settings/balance']])
})
