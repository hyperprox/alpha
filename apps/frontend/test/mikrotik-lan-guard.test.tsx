// MikroTik: the stray-address panel and the guard card's words, rendered to HTML with made-up devices.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import "./css-stub"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RouterVisual } from '@hyperprox/types'
import { StrayPanel, guardCard, strayFacts } from '../components/plugins/visual/LanGuard'

type Lan = NonNullable<RouterVisual['lan']>
const guard = (over: Partial<Lan['guard']> = {}): Lan['guard'] => ({
  state: 'off', canWrite: true, interface: 'bridge-lan', subnets: ['10.0.0.0/24', '10.0.1.0/24'], missing: ['10.0.0.0/24', '10.0.1.0/24'],
  listName: 'hyperprox-lan', ruleComment: 'x', ...over,
})
const stray: Lan['strays'][number] = {
  address: '198.51.100.7', mac: '02:00:5E:00:53:07', net: '198.51.100.0/24', name: null, port: 'ether5',
  firstSeen: null, lastSeen: '9s', softwareMade: true, connections: 2,
}
const noop = () => {}
const html = (lan: Lan, canAct = true, extra: Partial<Parameters<typeof StrayPanel>[0]> = {}) =>
  renderToStaticMarkup(<StrayPanel lan={lan} canAct={canAct} busy={false} onApply={noop} onUndo={noop} {...extra} />)

test('a stray device says what is known: warning, MAC, port, software-made, live connections, last seen', () => {
  const h = html({ strays: [stray], guard: guard() })
  assert.match(h, /Address outside your networks/)
  assert.match(h, /Not one of your networks: 198\.51\.100\.0\/24/)
  assert.deepEqual(strayFacts(stray), ['MAC 02:00:5E:00:53:07', 'Port ether5', 'Software-made address', '2 live connections', 'Last seen 9s'])
  assert.deepEqual(strayFacts({ ...stray, softwareMade: false, connections: 0, lastSeen: null }).slice(2), ['Hardware address', 'No live connections'])
})

test('the fix button names the action; an admin can press it, anyone else is told it is for admins', () => {
  const lan = { strays: [stray], guard: guard() }
  assert.match(html(lan), /Block addresses that are not yours/)
  assert.doesNotMatch(html(lan), /<button[^>]*disabled=""[^>]*>Block addresses/)
  assert.match(html(lan, false), /<button[^>]*disabled=""[^>]*>Block addresses/)
  assert.match(html(lan, false), /Only an admin can do this/)
  assert.match(guardCard(guard(), true).detail, /address list "hyperprox-lan" with 10\.0\.0\.0\/24, 10\.0\.1\.0\/24.*top of the forward chain.*coming in on bridge-lan.*Undo removes exactly those two things/)
})

test('a read-only router login: the button is off and the page says why in plain words', () => {
  const h = html({ strays: [stray], guard: guard({ canWrite: false }) })
  assert.match(h, /can only read/)
  assert.match(h, /<button[^>]*disabled=""[^>]*>Block addresses/)
})

test('guard on: shown as Blocked with Undo; partly in place: offers to finish; no plan: says so', () => {
  const on = guardCard(guard({ state: 'on', missing: [] }), true)
  assert.equal(on.headline, 'Blocked'); assert.equal(on.apply, null); assert.equal(on.undo, true)
  assert.match(html({ strays: [], guard: guard({ state: 'on', missing: [] }) }), /Undo: remove the guard/)
  assert.match(html({ strays: [], guard: guard({ state: 'on', missing: [] }) }), /No device is using an address outside your networks/)
  const part = guardCard(guard({ state: 'partial', missing: ['10.0.1.0/24'] }), true)
  assert.equal(part.apply?.label, 'Finish the guard'); assert.match(part.detail, /missing 10\.0\.1\.0\/24/)
  const none = guardCard(guard({ interface: null, subnets: [], unavailable: 'No link found.' }), true)
  assert.equal(none.apply, null); assert.equal(none.detail, 'No link found.')
})

test('the result of pressing it is shown: a message or a plain error', () => {
  assert.match(html({ strays: [stray], guard: guard() }, true, { msg: 'The guard is on.' }), /role="status"[^>]*>The guard is on\./)
  assert.match(html({ strays: [stray], guard: guard() }, true, { err: 'Cancelled. Nothing was done.' }), /role="alert"[^>]*>Cancelled/)
})
