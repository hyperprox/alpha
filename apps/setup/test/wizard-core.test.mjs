// The setup wizard's pure page helpers (apps/setup/wizard-core.js): retry with backoff, the service
// toggles' defaults, the bootstrap wording, the step label. The page runs these same functions' source.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const core = require('../wizard-core.js')

test('retryAsync: retries with the backoff delays, then returns the first success', async () => {
  const waits = []
  let n = 0
  const r = await core.retryAsync(async (attempt) => { n++; if (attempt < 3) throw new Error('slow'); return 'ok' },
    { tries: 4, delays: [10, 20, 40], sleep: async (ms) => { waits.push(ms) } })
  assert.equal(r, 'ok'); assert.equal(n, 3); assert.deepEqual(waits, [10, 20])
})

test('retryAsync: gives up after the last try and throws the last error', async () => {
  let n = 0
  const told = []
  await assert.rejects(core.retryAsync(async () => { n++; throw new Error('boom ' + n) },
    { tries: 3, delays: [1], sleep: async () => {}, onRetry: (e, a, w) => told.push([a, w]) }), /boom 3/)
  assert.equal(n, 3)
  assert.deepEqual(told, [[1, 1], [2, 1]])
})

test('retryAsync: an error that retrying cannot fix is thrown at once', async () => {
  let n = 0
  await assert.rejects(core.retryAsync(async () => { n++; throw new Error('setup key required') },
    { tries: 4, sleep: async () => {}, shouldRetry: (e) => !/setup key/.test(e.message) }), /setup key/)
  assert.equal(n, 1)
})

const scan = [
  { key: 'npm', name: 'Nginx Proxy Manager', host: '192.0.2.30', port: 81, found: true },
  { key: 'ollama', name: 'Ollama', host: '192.0.2.31', port: 11434, found: false },
  { key: 'pbs', name: 'Proxmox Backup Server', host: '192.0.2.41', port: 8007, found: true },
]

test('servicesFromScan: a toggle starts on only for what was found', () => {
  const s = core.servicesFromScan(scan, null)
  assert.deepEqual(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.enabled])), { npm: true, ollama: false, pbs: true })
})

test('servicesFromScan: a saved choice switches a found service off, and cannot switch a missing one on', () => {
  const s = core.servicesFromScan(scan, { npm: false, ollama: true, pbs: true })
  assert.deepEqual(core.serviceToggles(s), { npm: false, ollama: false, pbs: true })
})

test('serviceToggles: plain booleans for the server', () => {
  assert.deepEqual(core.serviceToggles({ a: { enabled: 1 }, b: { enabled: false }, c: null }), { a: true, b: false, c: false })
})

test('bootstrapSummary: says what bootstrap did, from the row statuses', () => {
  const rows = [{ status: 'done' }, { status: 'done' }, { status: 'already' }, { status: 'ok' }, { status: 'ok' }, { status: 'ok' }, { status: 'skipped' }, { status: 'failed' }]
  assert.equal(core.bootstrapSummary(rows, 'taken 2 hours ago'),
    'When you ran bootstrap.sh: 2 set up on your nodes, 1 already in place, 3 checked from here, 1 skipped, 1 failed. Readings taken 2 hours ago.')
  assert.doesNotMatch(core.bootstrapSummary([{ status: 'ok' }], ''), /set up/, 'checks only: nothing claimed as done')
  assert.equal(core.bootstrapSummary([], ''), 'bootstrap.sh ran but recorded no results.')
})

test('statusLabel: a check is "checked", not "done"', () => {
  assert.equal(core.statusLabel('ok'), 'checked')
  assert.equal(core.statusLabel('already'), 'already there')
  assert.equal(core.statusLabel('done'), 'done')
  assert.equal(core.statusLabel('weird'), 'failed')
})

test('takenLabel: how old a reading is', () => {
  const now = Date.parse('2026-01-01T12:00:00Z')
  assert.equal(core.takenLabel('2026-01-01T11:59:30Z', now), 'taken just now')
  assert.equal(core.takenLabel('2026-01-01T11:30:00Z', now), 'taken 30 minutes ago')
  assert.equal(core.takenLabel('2026-01-01T07:00:00Z', now), 'taken 5 hours ago')
  assert.equal(core.takenLabel('2025-12-25T12:00:00Z', now), 'taken 7 days ago')
  assert.equal(core.takenLabel(null, now), '')
})

test('stepLabel: every step is labelled, 1-based', () => {
  assert.equal(core.stepLabel(2, 5), 'Step 3 of 5')
})

test('the helpers run inside the page: every function in the injected source is self-contained', () => {
  const src = Object.values(core).map((f) => f.toString()).join('\n')
  const ctx = vm.createContext({ setTimeout, Date })
  vm.runInContext(src + '\nthis.out = [stepLabel(0, 5), serviceToggles(servicesFromScan([{key:"npm",found:true}], null))]', ctx)
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.out)), ['Step 1 of 5', { npm: true }])
})
