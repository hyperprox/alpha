// The redesigned Updates page: the hero's numbers and banners, node and guest rows (no red Reboot on every row, no
// per-package wall), the one Schedule card, and the page's shape (everything else under a collapsed Advanced).
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/updates-redesign.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import "./css-stub"
import { renderToStaticMarkup } from 'react-dom/server'
import { NodeRows } from '../components/updates/NodeRows'
import { GuestRows } from '../components/updates/GuestRows'
import { ScheduleCard } from '../components/updates/ScheduleCard'
import { UpdatesHero } from '../components/updates/UpdatesHero'
import { cadence, guestChips, guestOrder, guestSelection, heldBanner, heroNumbers, nextRunText, nodeChips, pkgSummary, rebootBanner, scheduleLines } from '../lib/updates-overview'

const pkg = (name: string, security = false): any => ({ name, from: '1', to: '2', ...(security ? { security } : {}) })
const node = (name: string, over: object = {}): any => ({ node: name, online: true, pending: [], cephPending: false, kernelPending: false, rebootRequired: false, rebootPending: false, policy: { upgrade: 'dist-upgrade', reboot: 'manual' }, holdsOk: null, pinOk: null, isSelf: false, ...over })
const guest = (vmid: number, over: object = {}): any => ({ vmid, type: 'lxc', name: `g${vmid}`, node: 'node-a', running: true, managed: true, pending: [], rebootRequired: false, haManaged: false, snapshotCapable: true, docker: 'none', ...over })
const row = (over: object = {}): any => ({ cluster: { id: 'home', name: 'Home', kind: 'home' }, at: '2026-11-21T12:00:00Z', result: 'ok', lastOkAt: '2026-11-21T12:00:00Z', targets: [], unread: [], available: 0, packages: 0, security: 0, ...over })
const reboots = (over: object = {}): any => ({ available: true, settings: { nodes: true, guests: false, window: { start: '03:00', hours: 2, days: [2] }, timezone: 'UTC', quiet: true }, waiting: { nodes: [], guests: [], at: null, guestsAt: null }, ...over })

test('numbers count machines; the security-package count is its own, labelled number', () => {
  const r = row({ available: 25, packages: 307, security: 105, targets: [
    { kind: 'node', name: 'a', packages: 4, security: ['x', 'y'], kernel: false, rebootNeeded: false, held: 0 },
    { kind: 'lxc', name: 'b', packages: 2, security: [], kernel: false, rebootNeeded: false, held: 0 },
    { kind: 'lxc', name: 'c', packages: 0, security: ['z'], kernel: false, rebootNeeded: false, held: 0 }] })
  const n = heroNumbers(r, null)
  assert.deepEqual([n.behind, n.securityMachines, n.securityPackages], [25, 1, 105])
  const html = renderToStaticMarkup(<UpdatesHero eyebrow="Updates" status={{ text: 't', sub: '', tone: 'warn' }} numbers={n} nextRun="Sat 08:00" reading={false} heldBanner={null} rebootBanner={null}
    buttonLabel="Update now" canUpdate message={null} onUpdateNow={() => {}} job={null} lastJob={null} onJobAction={() => {}} busy={false} />)
  assert.match(html, /machines behind/); assert.match(html, /machines with security fixes/); assert.match(html, /105 security packages/); assert.match(html, /next automatic install/)
})

test('an incomplete check falls back to the inventory counts', () => {
  const inv: any = { nodes: [node('a', { pending: [pkg('p', true)] }), node('b')], guests: [guest(1, { pending: [pkg('q')] }), guest(2, { managed: false })] }
  const n = heroNumbers(row({ result: 'partial', unread: ['x'], available: 99 }), inv)
  assert.deepEqual([n.behind, n.securityMachines, n.securityPackages, n.total], [2, 1, null, 3])
  assert.equal(heroNumbers(null, null).total, 0)
})

test('the hero shows a dash, not a zero, while the machines are unread', () => {
  const html = renderToStaticMarkup(<UpdatesHero eyebrow="Updates" status={{ text: 'Reading the last check…', sub: '', tone: 'muted' }} numbers={heroNumbers(null, null)} nextRun="…" reading heldBanner={null} rebootBanner={null}
    buttonLabel="Update now" canUpdate message={null} onUpdateNow={() => {}} job={null} lastJob={null} onJobAction={() => {}} busy={false} />)
  assert.match(html, /…/); assert.ok(!/Held by policy/.test(html) && !/Reboots needed/.test(html))
})

test('banners appear only when relevant and say what happens', () => {
  assert.equal(heldBanner([node('a')]), null)
  const held = heldBanner([node('node-c', { held: ['p1', 'p2', 'p3'], pinned: '7.0.1-pve', policy: { upgrade: 'upgrade', reboot: 'manual' } })]) ?? ''
  assert.match(held, /node-c: upgrades only/); assert.match(held, /3 packages held/); assert.match(held, /kernel pinned/); assert.match(held, /kernel will not change/)
  assert.equal(rebootBanner([node('a')], reboots(), false), null)
  const auto = rebootBanner([node('a', { rebootRequired: true })], reboots(), false) ?? ''
  assert.match(auto, /1 node need a reboot/); assert.match(auto, /one at a time/); assert.match(auto, /waiting while anyone is watching/)
  assert.match(rebootBanner([node('a', { rebootRequired: true })], reboots({ settings: { ...reboots().settings, nodes: false } }), false) ?? '', /off, so reboot each by hand/)
  assert.match(rebootBanner([node('a', { rebootRequired: true })], null, true) ?? '', /does not reboot a remote server by itself/)
  const rb = renderToStaticMarkup(<UpdatesHero eyebrow="Updates" status={{ text: 't', sub: '', tone: 'warn' }} numbers={heroNumbers(null, null)} nextRun="x" reading={false} heldBanner={held} rebootBanner={auto}
    buttonLabel="Update now" canUpdate message={null} onUpdateNow={() => {}} job={null} lastJob={null} onJobAction={() => {}} busy={false} />)
  assert.match(rb, /Held by policy:/); assert.match(rb, /Reboots needed:/)
})

test('node rows: chips, a package summary, and a quiet Reboot only inside the row', () => {
  const nodes = [node('node-a', { pending: ['a', 'b', 'c', 'd', 'e'].map(n => pkg(n, n === 'e')), kernelPending: true, rebootRequired: true }), node('node-b')]
  const html = renderToStaticMarkup(<NodeRows nodes={nodes} canReboot onReboot={() => {}} />)
  assert.match(html, /security/); assert.match(html, /kernel/); assert.match(html, /reboot needed/); assert.match(html, /5 pkgs/); assert.match(html, /current/)
  assert.match(html, /\+2 more/, 'the first three, then a count')
  assert.ok(!html.includes('>f<'))
  assert.equal((html.match(/Reboot this node…/g) ?? []).length, 2)
  assert.ok(!/btnDanger|danger/i.test(html), 'no red Reboot button on the rows')
  assert.match(html, /<details/)
  // security packages are listed first in the short list
  assert.ok(html.indexOf('>e<') < html.indexOf('>a<'))
})

test('node rows: offline and holds problems are chips; reboot is disabled when it cannot run', () => {
  const chips = nodeChips(node('n', { online: false, holdsOk: false, pinOk: false })).map(c => c.label)
  assert.ok(['offline', 'holds missing', 'pin missing'].every(l => chips.includes(l)))
  const html = renderToStaticMarkup(<NodeRows nodes={[node('n')]} canReboot={false} rebootWhy="A job is already active." onReboot={() => {}} />)
  assert.match(html, /disabled/); assert.match(html, /A job is already active\./)
})

test('guest rows: behind first, skipped guests collapsed with their reason, Update just this only inside the row', () => {
  const guests = [guest(1), guest(2, { pending: [pkg('a')] }), guest(3, { pending: [pkg('b', true)] }), guest(4, { managed: false, unmanagedReason: 'excluded' })]
  assert.deepEqual([...guests].filter(g => g.managed).sort(guestOrder).map(g => g.vmid), [3, 2, 1])
  const targets: any[] = [{ id: 'guest:3', kind: 'guest', vmid: 3, selectable: true, everything: true }]
  const html = renderToStaticMarkup(<GuestRows guests={guests} targets={targets} disabled={false} onUpdate={() => {}} />)
  assert.ok(html.indexOf('g3') < html.indexOf('g2') && html.indexOf('g2') < html.indexOf('g1'))
  assert.match(html, /Skipped \(1\)/); assert.match(html, /excluded by policy/)
  assert.equal((html.match(/Update just this/g) ?? []).length, 3)
  assert.match(html, /snapshot first/)
})

test('"Update just this" picks one guest\'s own rows, and says why when it cannot', () => {
  const t: any[] = [
    { id: 'guest:1', kind: 'guest', vmid: 1, selectable: true, everything: true },
    { id: 'guest:1:pkg:x', kind: 'guest-pkg', vmid: 1, selectable: true, everything: false },
    { id: 'app:1:a', kind: 'app', vmid: 1, selectable: true, everything: true },
    { id: 'compose:1:c', kind: 'compose', vmid: 1, selectable: true, everything: false },
    { id: 'guest:2', kind: 'guest', vmid: 2, selectable: false, blocked: 'an app has a blocking issue' },
  ]
  assert.deepEqual(guestSelection(t, 1).ids, ['guest:1', 'app:1:a'])
  assert.deepEqual(guestSelection(t, 2), { ids: [], blocked: 'an app has a blocking issue' })
  assert.equal(guestSelection(t, 9).ids.length, 0)
  const html = renderToStaticMarkup(<GuestRows guests={[guest(2, { pending: [pkg('a')] })]} targets={t} disabled={false} onUpdate={() => {}} />)
  assert.match(html, /an app has a blocking issue/); assert.match(html, /disabled/)
})

test('guest chips count packages and apps; the per-package list is a short summary', () => {
  const c = guestChips(guest(1, { pending: [pkg('a', true), pkg('b')], dockerImages: [{ image: 'i', current: 'x', latest: 'y' }] })).map(x => x.label)
  assert.deepEqual(c, ['security', '2', '1 app'])
  assert.deepEqual(guestChips(guest(1)).map(x => x.label), ['current'])
  const s = pkgSummary(Array.from({ length: 40 }, (_, i) => pkg(`p${i}`)))
  assert.equal(s.head.length, 3); assert.equal(s.more, 37)
})

test('the schedule is written once, in plain lines, and a remote never installs or reboots by itself', () => {
  const policy: any = { loaded: true, schedule: { enabled: true, cron: '0 8 * * *', nextRun: '2026-11-28T13:00:00.000Z', windowHours: 4 }, check: { enabled: true, cron: '30 6 * * *', nextRun: '2026-11-28T06:30:00.000Z', reminderDays: 7 } }
  const l = scheduleLines({ policy, auto: { enabled: true }, reboots: reboots(), remote: false })
  assert.deepEqual(l.map(x => x.key), ['check', 'install', 'reboot'])
  assert.match(l[0].value, /^daily · next .* · read only$/); assert.match(l[1].value, /4 h window/); assert.match(l[2].value, /03:00–05:00 Tue · waits while anyone is watching/)
  const r = scheduleLines({ policy, auto: null, reboots: null, remote: true })
  assert.match(r[1].value, /never on a remote server/); assert.match(r[2].value, /by hand/)
  assert.match(scheduleLines({ policy: { ...policy, schedule: { ...policy.schedule, enabled: false } }, auto: { enabled: false }, reboots: reboots({ settings: { ...reboots().settings, nodes: false } }), remote: false }).map(x => x.value).join('|'), /off\|off: reboots wait for you/)
  assert.equal(nextRunText(policy, false).length > 0, true); assert.equal(nextRunText(policy, true), 'by hand')
  assert.equal(nextRunText({ ...policy, schedule: { ...policy.schedule, enabled: false } }, false), 'off')
  assert.equal(cadence('0 8 * * *'), 'daily'); assert.equal(cadence('0 8 * * 1,3'), 'Mon, Wed'); assert.equal(cadence('*/5 * * * *'), 'on a schedule')
})

test('the Schedule card: every line, one Edit schedule and one Check now', () => {
  const html = renderToStaticMarkup(<ScheduleCard lines={[{ key: 'check', label: 'Check for updates', value: 'daily' }, { key: 'install', label: 'Install automatically', value: 'off' }]}
    showSelf={false} checkLabel="Check now" canCheck checkWhy={undefined} onCheck={() => {}} canEdit auto={{ enabled: false, line: 'Every morning at 08:00.' }} onToggleAuto={() => {}}
    reboots={reboots()} busy={false} onSaveReboots={() => {}} />)
  assert.match(html, /Check for updates/); assert.equal((html.match(/Edit schedule…/g) ?? []).length, 1); assert.equal((html.match(/Check now/g) ?? []).length, 1)
  assert.ok(!/role="switch"/.test(html), 'the switch opens in the dialog')
})

test('the page: no duplicate controls, nothing removed from the safety path, Advanced collapsed', () => {
  const src = fs.readFileSync(path.join(__dirname, '../app/updates/page.tsx'), 'utf8')
  for (const gone of ['HudHeader', '<Tiles', '<GlowBars', '<NodesTable', 'SimpleUpdates', 'onRefresh']) assert.ok(!src.includes(gone), gone)
  assert.equal((src.match(/<ScheduleCard/g) ?? []).length, 1)
  assert.match(src, /<details open=\{advanced\}/); assert.match(src, /useState\(false\)/)
  // every confirmation and the plan preview are still on the page
  for (const keep of ['simpleConfirm &&', 'confirmRun &&', 'reboot &&', 'rollback && active', 'approvalsFor', 'planHash', 'IN_PAGE', 'autoReboot']) assert.ok(src.includes(keep), keep)
  assert.match(src, /onUpdate=\{ids => void askToRun\(ids\)\}/, 'Update just this goes through the same order-then-confirm path')
  assert.match(src, /onReboot=\{n => void openReboot\(n\)\}/, 'a node reboot still opens its confirmation')
})
