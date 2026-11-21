// /api/updates/reboots over HTTP: reading the card, changing the settings, Reboot now and Make safe. Every change is
// admin-only, confirmed on the page (an API token is refused outright), and audited before it takes effect. The
// cluster is the fake; the session is set by a hook standing in for the gate.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { buildUpdatesRoutes } from '../src/routes/updates'
import { MemoryStore } from '../src/lib/updates/store'
import { MemoryRebootState } from '../src/lib/updates/reboots'
import type { UpdatesRunner } from '../src/lib/updates/runner'
import { setAuditSink } from '../src/lib/audit'
import { FakeCluster, node, guest, policyLoad, FAST } from './updates-fake'

let app: FastifyInstance
let runner: UpdatesRunner
const store = new MemoryStore()
const state = new MemoryRebootState()
const fake = new FakeCluster({
  nodes: [node('node-a', { pending: [] }), node('node-b', { pending: [], kernelPkgs: ['proxmox-kernel-7.0.1-1-pve-signed', 'proxmox-kernel-7.0.2-1-pve-signed'] }), node('node-c', { pending: [] })],
  guests: [guest(101, 'node-a')],
})
let session: { sid: string; role: string; email: string } = { sid: 's1', role: 'admin', email: 'admin@example.com' }
const confirmations: string[] = []

before(async () => {
  setAuditSink({ async write(a: any) { confirmations.push(String(a?.action ?? a)) } } as any)
  app = Fastify({ logger: false })
  app.addHook('onRequest', async req => { (req as any).session = { ...session } })
  await app.register(buildUpdatesRoutes({
    store, exec: fake, loadPolicy: policyLoad('nodes:\n  default: { upgrade: upgrade, reboot: auto }\n'), timing: FAST,
    rebootState: state, isUnlocked: () => true, now: () => fake.t, hostname: 'not-a-guest',
    onRunner: r => { runner = r },
  }), { prefix: '/api/updates' })
  await app.ready()
})
after(async () => { setAuditSink(null); await app.close() })

/** Sent as a person who presses Confirm: the first answer asks, the second carries the token. */
async function confirmed(method: 'PUT' | 'POST', url: string, payload?: unknown) {
  const first = await app.inject({ method, url, payload: payload as any })
  if (first.statusCode !== 403 || first.json().code !== 'confirm_required') return { first, res: first }
  const res = await app.inject({ method, url, payload: payload as any, headers: { 'x-hyperprox-confirm': first.json().confirm.token } })
  return { first, res }
}

test('the card: off by default, 03:00 for 3 hours, the node waiting, no run and no history', async () => {
  await app.inject({ method: 'GET', url: '/api/updates/inventory?refresh=1' })
  const r = await app.inject({ method: 'GET', url: '/api/updates/reboots' })
  assert.equal(r.statusCode, 200)
  const s = r.json()
  assert.equal(s.available, true)
  assert.deepEqual([s.settings.nodes, s.settings.guests, s.settings.window.start, s.settings.window.hours], [false, false, '03:00', 3])
  assert.deepEqual(s.waiting.nodes.map((n: any) => n.node), ['node-b'])
  assert.equal(s.waiting.at, null, 'off: nothing reboots on its own, so no time is promised')
  assert.equal(s.active, null)
  assert.deepEqual(s.history, [])
})

test('an API token can change nothing: settings, Reboot now and Make safe all refuse it', async () => {
  session = { sid: 'token:t1', role: 'admin', email: 'bot@example.com' }
  try {
    for (const [method, url, payload] of [['PUT', '/api/updates/reboots/settings', { nodes: true }], ['POST', '/api/updates/reboots/now', {}], ['POST', '/api/updates/reboots/make-safe', undefined]] as const) {
      const r = await app.inject({ method, url, payload: payload as any })
      assert.equal(r.statusCode, 403, url)
      assert.equal(r.json().code, 'token_forbidden', url)
    }
    assert.equal(state.get('home').settings, undefined, 'nothing was saved')
  } finally { session = { sid: 's1', role: 'admin', email: 'admin@example.com' } }
})

test('a viewer cannot even read the card', async () => {
  session = { sid: 's2', role: 'viewer', email: 'viewer@example.com' }
  try { assert.equal((await app.inject({ method: 'GET', url: '/api/updates/reboots' })).statusCode, 403) }
  finally { session = { sid: 's1', role: 'admin', email: 'admin@example.com' } }
})

test('settings: confirmed on the page, audited with before and after, then saved; bad values are 400 and save nothing', async () => {
  const bad = await confirmed('PUT', '/api/updates/reboots/settings', { window: { start: '3am' } })
  assert.equal(bad.res.statusCode, 400)
  assert.equal(state.get('home').settings, undefined)
  const { first, res } = await confirmed('PUT', '/api/updates/reboots/settings', { nodes: true, window: { start: '02:00', hours: 2 } })
  assert.equal(first.json().code, 'confirm_required')
  assert.match(first.json().confirm.summary, /restart on their own in the window, one at a time/)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(state.get('home').settings!.nodes, true)
  const a = store.audits.find(x => x.action === 'updates.reboots.settings')!
  assert.equal((a.details as any).before.nodes, false)
  assert.equal((a.details as any).after.window.start, '02:00')
  assert.ok(confirmations.includes('action.confirmed'))
})

test('Reboot now: confirmed, audited, the rolling reboot runs; Make safe has nothing to clear afterwards', async () => {
  const { first, res } = await confirmed('POST', '/api/updates/reboots/now', {})
  assert.match(first.json().confirm.summary, /one at a time/)
  assert.equal(res.statusCode, 202, res.body)
  await runner.idle(); await runner.idle()
  const job = await store.getJob(res.json().job.id)
  assert.equal(job!.status, 'done', job!.pauseReason ?? '')
  assert.equal(job!.trigger, 'manual')
  assert.ok(store.audits.some(x => x.action === 'updates.reboots.start' && (x.details as any).by === 'admin@example.com'))
  const card = (await app.inject({ method: 'GET', url: '/api/updates/reboots' })).json()
  assert.equal(card.history.length, 1)
  assert.equal(card.history[0].machines[0].status, 'ok')
  const safe = await confirmed('POST', '/api/updates/reboots/make-safe')
  assert.equal(safe.res.statusCode, 409)
  // Nothing waits any more.
  const again = await confirmed('POST', '/api/updates/reboots/now', {})
  assert.equal(again.res.statusCode, 409)
  assert.match(again.res.json().error, /Nothing needs a reboot/)
})

test('an update run can ask for the next window; it is confirmed with the run and audited', async () => {
  const r = await confirmed('POST', '/api/updates/jobs', { mode: 'run', select: ['guest:101'], autoReboot: true })
  assert.notEqual(r.first.statusCode, 201, 'never without a confirmation')
  assert.equal(r.res.statusCode, 201, r.res.body)
  assert.match(r.first.json().confirm.summary, /in the next reboot window, whatever this run leaves needing a reboot restarts on its own/)
  await runner.idle()
  assert.equal(state.get('home').queued ?? null, null, 'nothing is queued while the plan only waits for Go ahead')
  const go = await confirmed('POST', `/api/updates/jobs/${r.res.json().job.id}/confirm`)
  assert.equal(go.res.statusCode, 200, go.res.body)
  await runner.idle()
  assert.deepEqual(state.get('home').queued!.only, { nodes: [], guests: [101] }, 'only this run\'s own targets, queued once it ran')
  assert.equal(state.get('home').queued!.by, 'admin@example.com')
  assert.ok(store.audits.some(x => x.action === 'updates.reboots.queued'))
  const bad = await app.inject({ method: 'POST', url: '/api/updates/jobs', payload: { mode: 'dry-run', autoReboot: true } })
  assert.equal(bad.statusCode, 400)
})
