// The Load balancing page's "why is each guest here" pieces, rendered to HTML: nodes as capacity bars with their guests on them, each guest's
// verdict in words (never colour alone), a guest's per-node reasons, a move's cost (downtime, data, network), a
// suggestion with its effect, a history row with corosync. Plus the pure logic behind them.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { PlacementMapView, NodeColumn, TargetList, WhyHere, CostList, SuggestionCard, MoveRow } from '../components/placement/parts'
import { verdictOf, pinWord, nodeBars, costLines, moveChoices, quietWords, corosyncLine } from '../components/placement/logic'
import type { GuestPlacement, MovePlan, MoveRecord, PlacementNode } from '../components/placement/types'
import { NAV, EXTRA_PAGES } from '../components/layout/nav'

const G = 1024 ** 3
const node = (name: string, o: Partial<PlacementNode> = {}): PlacementNode => ({
  node: name, online: true, maintenance: false, threads: 4, cpuModel: 'Example CPU', cpuVendor: 'GenuineIntel', cpu: 0.25, mem: 4 * G, maxmem: 16 * G,
  cpusAssigned: 6, memAssigned: 8 * G, guests: [], ...o,
})
const guest = (sid: string, at: string, o: Partial<GuestPlacement> = {}): GuestPlacement => ({
  sid, vmid: Number(sid.split(':')[1]), type: sid.startsWith('ct:') ? 'lxc' : 'qemu', name: `g${sid.split(':')[1]}`, node: at, status: 'running', template: false, ha: false,
  cpus: 2, maxmem: 2 * G, usage: { cores: 0.5, mem: G }, why: [], movable: 'yes', summary: 'Can move to node2.', everywhere: [], copyBytes: 0, downtimeSec: 20,
  targets: [{ node: 'node2', verdict: 'ok', reasons: [] }], ...o,
})
const plan = (o: Partial<MovePlan> = {}): MovePlan => ({
  sid: 'ct:107', name: 'worker', type: 'lxc', from: 'node1', to: 'node2', method: 'migrate', allowed: true, refusals: [], warnings: [], running: true,
  downtimeSec: 25, copyBytes: 0, copySec: 0, localDisks: false, bwlimitKiB: 51200,
  network: { shared: true, migrationNetwork: null, corosyncAddresses: [], redundantRing: false, datacenterBwlimit: null, suggestedBwlimit: 51200, words: [] },
  quiet: { quietNow: true, nowWhy: [], nextQuiet: null, upcoming: [], unread: [], tz: 'UTC' }, needsAnyway: false,
  call: 'POST /nodes/node1/lxc/107/migrate  target=node2 restart=1 bwlimit=51200', lastMove: null, ...o,
})

test('the map: one column per node with CPU, RAM and cores bars, and every guest on its node with its verdict in words', () => {
  const gpu = guest('ct:101', 'node1', { name: 'media', ha: true, movable: 'no', everywhere: [], targets: [{ node: 'node2', verdict: 'no', reasons: [{ code: 'gpu', level: 'block', words: 'GPU' }] }] })
  const html = renderToStaticMarkup(<PlacementMapView nodes={[node('node1', { threads: 24, cpusAssigned: 30 }), node('node2')]}
    guests={[gpu, guest('ct:107', 'node1', { name: 'worker' }), guest('vm:106', 'node2', { name: 'tmpl', template: true, status: 'stopped', movable: 'no' })]} />)
  assert.match(html, /aria-label="Node node1"/)
  assert.match(html, /aria-label="Node node2"/)
  assert.match(html, /CPU/); assert.match(html, /RAM/); assert.match(html, /30 vCPU \/ 24 threads/)
  assert.match(html, /media[\s\S]*HA · GPU/, 'a fixed guest says why, and that HA manages it')
  assert.match(html, /worker[\s\S]*can move/)
  assert.match(html, /tmpl[\s\S]*template/)
  assert.match(html, /, running, stays put/, 'the verdict is in words for a screen reader')
  for (const w of ['can move', 'not checked', 'stays put', 'template']) assert.ok(html.includes(w), `legend: ${w}`)
})

test('a node over its line turns its bar to the warning gradient; an offline node says so', () => {
  const bars = nodeBars(node('n', { cpu: 0.92, mem: 15.5 * G, cpusAssigned: 6 }))
  assert.deepEqual(bars.map(b => b.over), [true, true, true], 'CPU 92%, RAM 97%, 6 vCPU on 4 threads')
  const html = renderToStaticMarkup(<NodeColumn node={node('node3', { online: false })} guests={[]} />)
  assert.match(html, /offline/)
  assert.match(html, /No guests/)
})

test('verdicts and pin words', () => {
  assert.equal(verdictOf(guest('ct:1', 'a')), 'free')
  assert.equal(verdictOf(guest('ct:1', 'a', { movable: 'unknown' })), 'unknown')
  assert.equal(verdictOf(guest('ct:1', 'a', { template: true, movable: 'no' })), 'template')
  const bind = guest('ct:1', 'a', { movable: 'no', everywhere: [{ code: 'bind-mount', level: 'block', words: 'x' }] })
  assert.equal(pinWord(bind), 'bind mount')
  assert.equal(pinWord(guest('ct:1', 'a', { movable: 'no', targets: [{ node: 'b', verdict: 'no', reasons: [{ code: 'prefer-rule', level: 'block', words: 'x' }] }] })), 'HA rule')
  assert.equal(pinWord(guest('ct:1', 'a')), null)
})

test('a guest card: why it is there, and each node with its verdict and reasons; the page\'s button only where it can go', () => {
  const g = guest('vm:103', 'node1', {
    name: 'big', movable: 'no', summary: 'Stays on node1: 8 vCPUs.', why: ['8 vCPUs: more than node2 and node3 have.'],
    targets: [
      { node: 'node2', verdict: 'no', reasons: [{ code: 'cores', level: 'block', words: 'It has 8 vCPUs and node2 has 4 threads: it will not start there.' }] },
      { node: 'node3', verdict: 'unknown', reasons: [{ code: 'shared-mount', level: 'unknown', words: 'not checked on node3' }, { code: 'ha', level: 'info', words: 'hidden info' }] },
    ],
  })
  const why = renderToStaticMarkup(<WhyHere g={g} />)
  assert.match(why, /Stays on node1/)
  assert.match(why, /8 vCPUs: more than node2 and node3 have/)
  const list = renderToStaticMarkup(<TargetList g={g} action={n => (n === 'node2' ? <button>Move here</button> : null)} />)
  assert.match(list, /data-v="no"[\s\S]*node2[\s\S]*will not start there/)
  assert.match(list, /data-v="unknown"[\s\S]*node3[\s\S]*not checked on node3/)
  assert.doesNotMatch(list, /hidden info/, 'info lines are not reasons')
  const free = renderToStaticMarkup(<WhyHere g={guest('ct:7', 'node1')} />)
  assert.match(free, /Nothing ties it to node1/)
})

test('the move dialog\'s cost: downtime for a container restart, data to copy, and the corosync network warning', () => {
  const html = renderToStaticMarkup(<CostList plan={plan()} />)
  assert.match(html, /Downtime: about 25 s/)
  assert.match(html, /Data to copy: almost none/)
  assert.match(html, /heartbeat \(corosync\).*50 MiB\/s/)
  assert.match(html, /restart=1 bwlimit=51200/)
  const vm = costLines(plan({ type: 'qemu', copyBytes: 34 * G, copySec: 700, localDisks: true, method: 'ha', bwlimitKiB: null }))
  assert.match(vm[0], /moves live/)
  assert.match(vm[1], /34 GiB \(its local disks and its memory\), about 12 min/)
  assert.match(vm[2], /Nothing limits it/)
  const refused = renderToStaticMarkup(<CostList plan={plan({ allowed: false, refusals: ['A bind mount (/mnt/media) without shared=1.'] })} />)
  assert.match(refused, /aria-label="Why it cannot move"[\s\S]*bind mount/)
})

test('the move buttons follow the quiet window: now; or schedule and anyway; nothing when refused', () => {
  assert.deepEqual(moveChoices(plan()), ['now'])
  const loud = plan({ quiet: { quietNow: false, nowWhy: ['backup job (02:00)'], nextQuiet: { start: Date.UTC(2026, 5, 15, 5), end: Date.UTC(2026, 5, 15, 9) }, upcoming: [], unread: [], tz: 'UTC' } })
  assert.deepEqual(moveChoices(loud), ['schedule', 'anyway'])
  assert.match(quietWords(loud.quiet), /^Not a quiet window: backup job \(02:00\)\. Next quiet window: Mon 05:00\.$/)
  assert.deepEqual(moveChoices(plan({ allowed: false })), [])
})

test('a suggestion shows both nodes before and after, and its reasons; a rule change says so', () => {
  const html = renderToStaticMarkup(<SuggestionCard s={{ kind: 'move', sid: 'ct:107', name: 'worker', from: 'node1', to: 'node2', why: ['node1 was above 80% CPU for 10 of the last 72 hours.'],
    effect: { metric: 'cpu', from: { before: 10, after: 0 }, to: { before: 0, after: 0 } } }} />)
  assert.match(html, /node1[\s\S]*busy 10 h → 0 h[\s\S]*node2[\s\S]*busy 0 h → 0 h/)
  assert.match(html, /Move worker from node1 to node2/)
  const rule = renderToStaticMarkup(<SuggestionCard s={{ kind: 'edit-rule', rule: 'web-home', sid: 'ct:102', name: 'web', from: 'node2', to: 'node3', why: [], effect: { metric: 'cpu', from: { before: 8, after: 1 }, to: { before: 0, after: 0 } } }} />)
  assert.match(rule, /Change the HA rule &quot;web-home&quot; so web prefers node3/)
})

test('a history row: who, where, and what corosync did, or that it could not be read', () => {
  const m: MoveRecord = { id: 'mv1', sid: 'ct:107', name: 'worker', fromNode: 'node1', toNode: 'node2', source: 'hyperprox', method: 'migrate', status: 'done', upid: null, by: 'a@example.com',
    scheduledFor: null, startedAt: Date.UTC(2026, 5, 15, 12), endedAt: null, error: null, bwlimitKiB: 51200,
    corosync: { checked: ['node1', 'node2'], retransmits: 36, linkDown: 2, tokenLost: 0, membership: 1 } }
  const html = renderToStaticMarkup(<MoveRow m={m} />)
  assert.match(html, /worker: node1 → node2 · moved/)
  assert.match(html, /36 retransmits, link down 2×/)
  assert.match(corosyncLine({ ...m, corosync: { checked: [], retransmits: 0, linkDown: 0, tokenLost: 0, membership: 0, unavailable: 'No node login.' } }), /No node login/)
  assert.match(renderToStaticMarkup(<MoveRow m={{ ...m, source: 'proxmox', status: 'failed', error: 'migration aborted', corosync: null }} />), /seen in Proxmox[\s\S]*migration aborted/)
})

test('the page is in the rail as Load balancing and its settings in the palette; "placement" still finds both', () => {
  const item = NAV.flatMap(g => g.items).find(i => i.href === '/balance')
  assert.equal(item?.label, 'Load balancing')
  assert.match(item!.keywords ?? '', /placement/)
  assert.ok(!NAV.flatMap(g => g.items).some(i => i.href === '/placement'), 'the old address is a redirect, not a page')
  const settings = EXTRA_PAGES.find(p => p.href === '/settings/balance')
  assert.equal(settings?.label, 'Load balancing & quiet windows')
  assert.match(settings!.keywords ?? '', /placement/)
})

test('a stuck move says it is still running in Proxmox, never "failed"', () => {
  const m: MoveRecord = { id: 'mv2', sid: 'ct:107', name: 'worker', fromNode: 'node1', toNode: 'node2', source: 'hyperprox', method: 'migrate', status: 'stuck', upid: null, by: null,
    scheduledFor: null, startedAt: Date.UTC(2026, 5, 15, 12), endedAt: null, error: "Proxmox's task is still running after 120 min.", bwlimitKiB: null, corosync: null }
  const html = renderToStaticMarkup(<MoveRow m={m} action={<button>Resolve</button>} />)
  assert.match(html, /worker: node1 → node2 · still running in Proxmox/)
  assert.doesNotMatch(html, /failed/)
  assert.match(html, /Resolve/)
})

test('a scheduled move says it expires after 7 days', () => {
  const m: MoveRecord = { id: 'mv3', sid: 'ct:107', name: 'worker', fromNode: 'node1', toNode: 'node2', source: 'hyperprox', method: 'migrate', status: 'scheduled', upid: null, by: 'a@example.com',
    scheduledFor: Date.UTC(2026, 5, 16, 5), startedAt: null, endedAt: null, error: null, bwlimitKiB: 51200, corosync: null }
  assert.match(renderToStaticMarkup(<MoveRow m={m} />), /Scheduled moves expire after 7 days/)
})
