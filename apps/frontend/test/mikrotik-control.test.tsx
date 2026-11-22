// MikroTik router manager page: the panels rendered to HTML with made-up devices.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import "./css-stub"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { ControlPanels, PlanCard, blockParams, forwardParams, statusWords, type Control, type Pending } from '../components/plugins/visual/RouterControl'

const control = (over: Partial<Control> = {}): Control => ({
  canWrite: true, wans: ['ether1'],
  devices: [
    { mac: '00:00:5E:00:53:31', address: '10.0.0.31', name: 'laptop', fixed: false },
    { mac: '00:00:5E:00:53:20', address: '10.0.0.20', name: 'nas', fixed: true },
  ],
  leases: [{ id: '*l2', address: '10.0.0.20', mac: '00:00:5E:00:53:20', name: '', comment: 'nas', words: 'nas always gets 10.0.0.20' }],
  forwards: [
    { id: '*f1', name: 'web', words: 'Outside port 443 → nas (10.0.0.20) port 443, TCP', disabled: false, mine: false, risky: null, proto: 'TCP', port: '443', toAddress: '10.0.0.20', toPort: '443' },
    { id: '*f2', name: 'rdp', words: 'Outside port 3389 → laptop (10.0.0.31) port 3389, TCP', disabled: false, mine: true, risky: 'Port 3389 (Remote Desktop) is risky.', proto: 'TCP', port: '3389', toAddress: '10.0.0.31', toPort: '3389' },
  ],
  blocks: [{ id: '*b1', name: 'tv', target: '00:00:5E:00:53:40', schedule: 'from 22:00 to 06:00 every day', disabled: false, words: 'tv (00:00:5E:00:53:40) has no internet from 22:00 to 06:00 every day' }],
  hairpin: { present: false, note: 'No "hairpin" rule exists on the router: x.' }, risky: [{ port: 3389, why: 'Remote Desktop' }],
  history: [
    { id: 'a1', at: '2026-11-21T10:00:00Z', by: 'admin@example.com', title: 'Block internet for tv', steps: ['Add a rule'], status: 'applied', canUndo: true, backup: { bytes: 900, truncated: false } },
    { id: 'a2', at: '2026-11-21T09:00:00Z', by: 'admin@example.com', title: 'Forward 80', steps: ['x'], status: 'rolled-back', canUndo: false, note: 'The router stopped answering HyperProx after the change.' },
  ], ...over,
})
const noop = () => {}
const html = (c: Control, extra: Partial<Parameters<typeof ControlPanels>[0]> = {}) =>
  renderToStaticMarkup(<ControlPanels c={c} canAct busy={false} pending={null} tick={false} onPlan={noop} onTick={noop} onApply={noop} onCancel={noop} onUndo={noop} {...extra} />)

test('a device without a fixed address has the "Make this address permanent" button; one with it does not', () => {
  const h = html(control())
  assert.match(h, /laptop<\/b><code>10\.0\.0\.31<\/code>/)
  assert.equal((h.match(/Make this address permanent/g) ?? []).length, 1)
  assert.match(h, /nas always|<b>nas<\/b><code>10\.0\.0\.20/)
})

test('port forwards read in plain English, a risky one is called out, and the hairpin note is shown', () => {
  const h = html(control())
  assert.match(h, /Outside port 443 → nas \(10\.0\.0\.20\) port 443, TCP/)
  assert.match(h, /Port 3389 \(Remote Desktop\) is risky\./)
  assert.match(h, /No &quot;hairpin&quot; rule exists/)
  assert.match(h, /Switch off/); assert.match(h, /Review the forward/)
})

test('blocks show the schedule in words and offer to give the internet back', () => {
  const h = html(control())
  assert.match(h, /has no internet from 22:00 to 06:00 every day/)
  assert.match(h, /Give the internet back/); assert.match(h, /Block all the time/)
})

test('the change history lists newest first with Undo only where it can work, and says when the router put a change back itself', () => {
  const h = html(control())
  assert.equal((h.match(/>Undo</g) ?? []).length, 1)
  assert.match(h, /In place/); assert.match(h, /Put back automatically/)
  assert.match(h, /The router stopped answering HyperProx after the change/)
  assert.match(h, /settings were saved first/)
  assert.ok(h.indexOf('Block internet for tv') < h.indexOf('Forward 80'))
  assert.deepEqual(statusWords({ status: 'applied', undoOf: 'x' }), { text: 'Undo', tone: 'accent' })
})

test('the plan is shown in words with the safety-switch sentence; a risky port needs its tick before Apply is enabled', () => {
  const pending: Pending = { action: 'forward.add', params: {}, plan: { hash: 'h', title: 'Forward outside port 3389 to laptop', steps: ['Add the forward: Outside port 3389 → laptop, TCP.'], warnings: ['Port 3389 (Remote Desktop) is scanned.'], needsTick: 'Port 3389 (Remote Desktop) is scanned.' } }
  const off = renderToStaticMarkup(<PlanCard pending={pending} busy={false} tick={false} onTick={noop} onApply={noop} onCancel={noop} />)
  assert.match(off, /Forward outside port 3389 to laptop/); assert.match(off, /safety switch/); assert.match(off, /within 90 seconds/)
  assert.match(off, /<button[^>]*disabled=""[^>]*>Apply this change/)
  const on = renderToStaticMarkup(<PlanCard pending={pending} busy={false} tick={true} onTick={noop} onApply={noop} onCancel={noop} />)
  assert.doesNotMatch(on, /<button[^>]*disabled=""[^>]*>Apply this change/)
  const safe = renderToStaticMarkup(<PlanCard pending={{ ...pending, plan: { ...pending.plan, needsTick: null } }} busy={false} tick={false} onTick={noop} onApply={noop} onCancel={noop} />)
  assert.doesNotMatch(safe, /type="checkbox"/); assert.doesNotMatch(safe, /<button[^>]*disabled=""[^>]*>Apply this change/)
})

test('a read-only login or a non-admin sees why every button is off', () => {
  const ro = html(control({ canWrite: false }))
  assert.match(ro, /can only read/); assert.match(ro, /<button[^>]*disabled=""[^>]*>Make this address permanent/)
  const nonAdmin = html(control(), { canAct: false })
  assert.match(nonAdmin, /Only an admin can change the router/)
})

test('form parameters: a forward needs a device and a port; a schedule is sent only when ticked', () => {
  assert.equal(forwardParams({ address: '', proto: 'tcp', extPort: '80', toPort: '', name: '' }), null)
  assert.deepEqual(forwardParams({ address: '10.0.0.31', proto: 'udp', extPort: ' 51820 ', toPort: '', name: ' vpn ' }), { address: '10.0.0.31', proto: 'udp', extPort: '51820', name: 'vpn' })
  assert.equal(blockParams({ mac: '', scheduled: false, from: '', to: '', days: [] }), null)
  assert.deepEqual(blockParams({ mac: 'AA', scheduled: false, from: '22:00', to: '06:00', days: ['mon'] }), { mac: 'AA' })
  assert.deepEqual(blockParams({ mac: 'AA', scheduled: true, from: '22:00', to: '06:00', days: ['mon'] }), { mac: 'AA', schedule: { from: '22:00', to: '06:00', days: ['mon'] } })
})

test('blocks say they do not cut connections already running; an undo that needs a tick asks for it before it goes ahead', () => {
  assert.match(html(control()), /already has open[^<]*carry on until they end/)
  const ask = html(control(), { undoAsk: { id: 'a1', text: 'Port 3389 (Remote Desktop) is risky.' }, tick: false })
  assert.match(ask, /Putting this back needs your OK/); assert.match(ask, /Port 3389 \(Remote Desktop\) is risky\./)
  assert.match(ask, /<button[^>]*disabled=""[^>]*>Undo anyway/)
  assert.doesNotMatch(html(control(), { undoAsk: { id: 'a1', text: 'x' }, tick: true }), /<button[^>]*disabled=""[^>]*>Undo anyway/)
  assert.doesNotMatch(html(control()), /Putting this back needs your OK/)
})
