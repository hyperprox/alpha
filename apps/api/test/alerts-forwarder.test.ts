// Prometheus alerts to notifications: one message when an alert starts firing, one when it clears, nothing in
// between; what was announced survives a restart; Prometheus silent for 5 minutes is one warning and one
// recovery; alerts on the not-forwarded list are never sent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AlertForwarder, FileForwarderState, MemoryForwarderState, alertFingerprint, notForwardedFromEnv, placeOf, duration,
  type PromAlert, type ForwarderDeps, type ForwarderStateStore,
} from '../src/lib/alerts/forwarder'
import type { NotifyEventInput } from '../src/lib/notify/types'

const T0 = new Date('2026-11-11T14:00:00Z')
const MIN = 60_000

const gpu = (state = 'firing'): PromAlert => ({
  state, activeAt: '2026-11-11T13:58:00Z', value: '5.11e+02',
  labels: { alertname: 'GPUNotResponding', severity: 'critical', node: 'srv@c0123456789', hpx_cluster: 'c0123456789', hpx_node: 'srv', chip: 'gpu0', chip_name: 'amdgpu', instance: 'a:9100' },
  annotations: { title: 'Graphics card not responding', plain: 'The graphics card reports an impossible 511 °C, so it has hung.', summary: 'GPU on srv@c0123456789 is not responding' },
})
const nodeDown = (node = 'n1'): PromAlert => ({
  state: 'firing', activeAt: '2026-11-11T13:59:00Z',
  labels: { alertname: 'NodeDown', severity: 'critical', node, job: 'node', instance: `${node}:9100` },
  annotations: { summary: `Node ${node} is down`, description: `node_exporter on ${node}:9100 has been unreachable for more than 1 minute.` },
})
const cephWarn = (): PromAlert => ({ state: 'firing', activeAt: '2026-11-08T02:10:00Z', labels: { alertname: 'CephHealthWarning', severity: 'warning', job: 'ceph' }, annotations: {} })

function rig(o: Partial<ForwarderDeps> = {}, store: ForwarderStateStore = new MemoryForwarderState()) {
  let now = T0
  let alerts: PromAlert[] | Error = []
  const sent: NotifyEventInput[] = []
  const f = new AlertForwarder({
    fetchAlerts: async () => { if (alerts instanceof Error) throw alerts; return alerts },
    publish: async e => { sent.push(e) },
    store,
    clusterName: id => (id === 'c0123456789' ? 'Family Server' : null),
    now: () => now,
    timeZone: 'UTC',
    ...o,
  })
  return {
    f, sent, store,
    set(a: PromAlert[] | Error) { alerts = a },
    advance(ms: number) { now = new Date(now.getTime() + ms) },
  }
}

test('an alert is announced once when it fires, never again while it stays, and once when it clears', async () => {
  const r = rig()
  r.set([gpu()])
  assert.deepEqual(await r.f.tick(), { fired: 1, resolved: 0, prometheus: 'ok' })
  assert.equal(r.sent.length, 1)
  const fire = r.sent[0]
  assert.equal(fire.type, 'alert.firing')
  assert.equal(fire.severity, 'critical')
  assert.equal(fire.title, 'Graphics card not responding on srv (Family Server)')
  assert.deepEqual(fire.lines, [
    'The graphics card reports an impossible 511 °C, so it has hung.',
    'Where: srv (Family Server)',
    'Since 11 Nov, 13:58 (2 min ago).',
  ])
  assert.equal(fire.link, '/monitoring')
  assert.equal(fire.fingerprint, alertFingerprint(gpu().labels))

  for (let i = 0; i < 5; i++) { r.advance(MIN); await r.f.tick() }
  assert.equal(r.sent.length, 1, 'no repeat while it keeps firing')

  r.set([])
  r.advance(MIN)
  assert.deepEqual(await r.f.tick(), { fired: 0, resolved: 1, prometheus: 'ok' })
  const res = r.sent[1]
  assert.equal(res.type, 'alert.resolved')
  assert.equal(res.resolved, true)
  assert.equal(res.severity, 'critical', 'a resolve reaches the same channels the alert did')
  assert.equal(res.fingerprint, fire.fingerprint, 'same fingerprint: a held alert and its resolve cancel out')
  assert.equal(res.title, fire.title)
  assert.deepEqual(res.lines, ['This has cleared.', 'Where: srv (Family Server)', 'It lasted 8 min, from 11 Nov, 13:58.'])

  r.advance(MIN); await r.f.tick()
  assert.equal(r.sent.length, 2, 'nothing more once cleared')
})

test('the fingerprint is per alert name and labels, whatever order the labels come in', () => {
  const a = alertFingerprint({ alertname: 'NodeDown', node: 'n1', job: 'node' })
  assert.equal(a, alertFingerprint({ job: 'node', node: 'n1', alertname: 'NodeDown' }))
  assert.notEqual(a, alertFingerprint({ alertname: 'NodeDown', node: 'n2', job: 'node' }))
  assert.notEqual(a, alertFingerprint({ alertname: 'CPUHot', node: 'n1', job: 'node' }))
  assert.match(a, /^alert:NodeDown:[0-9a-f]{16}$/)
})

test('pending alerts are not announced; a firing one that drops back to pending (Prometheus restarted) is not "fixed"', async () => {
  const r = rig()
  r.set([gpu('pending')])
  await r.f.tick()
  assert.equal(r.sent.length, 0)
  r.set([gpu('firing')])
  await r.f.tick()
  assert.equal(r.sent.length, 1)
  r.set([gpu('pending')])
  await r.f.tick()
  assert.equal(r.sent.length, 1, 'pending again is still there')
  r.set([gpu('firing')])
  await r.f.tick()
  assert.equal(r.sent.length, 1, 'and firing again is not new')
})

test('a restart keeps what was announced: nothing still firing is announced again, and what cleared meanwhile resolves', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-alerts-'))
  const file = path.join(dir, 'alerts-forward.json')
  try {
    const a = rig({}, new FileForwarderState(file))
    a.set([gpu(), nodeDown('n1'), nodeDown('n2')])
    await a.f.tick()
    assert.equal(a.sent.length, 3)
    assert.equal((fs.statSync(file).mode & 0o777), 0o600)
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(Object.keys(saved.firing).length, 3)

    // A new process: same file, n2 cleared while the API was down.
    const b = rig({}, new FileForwarderState(file))
    b.set([gpu(), nodeDown('n1')])
    assert.deepEqual(await b.f.tick(), { fired: 0, resolved: 1, prometheus: 'ok' })
    assert.equal(b.sent.length, 1)
    assert.equal(b.sent[0].type, 'alert.resolved')
    assert.equal(b.sent[0].title, 'Node n2 is down', 'the summary already names the place, so nothing is added')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a corrupt or missing state file starts empty instead of failing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-alerts-'))
  try {
    const file = path.join(dir, 'alerts-forward.json')
    assert.deepEqual(new FileForwarderState(file).load().firing, {})
    fs.writeFileSync(file, '{not json')
    assert.deepEqual(new FileForwarderState(file).load().firing, {})
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('Prometheus silent for 5 minutes: one warning, then one recovery; alerts are not resolved while it is silent', async () => {
  const r = rig()
  r.set([nodeDown()])
  await r.f.tick()
  assert.equal(r.sent.length, 1)

  r.set(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
  for (let i = 0; i < 5; i++) {
    r.advance(MIN)
    assert.equal((await r.f.tick()).prometheus, 'down')
  }
  assert.equal(r.sent.length, 1, 'under 5 minutes: nothing yet')
  r.advance(MIN)
  await r.f.tick()
  assert.equal(r.sent.length, 2)
  const down = r.sent[1]
  assert.equal(down.type, 'alert.firing')
  assert.equal(down.severity, 'warning')
  assert.equal(down.title, 'Monitoring is down')
  assert.deepEqual(down.lines, ["HyperProx cannot reach Prometheus, so alerts can't be checked.", 'Since 11 Nov, 14:01 (5 min ago).'])
  assert.equal(down.fingerprint, 'alert:monitoring-down')

  for (let i = 0; i < 30; i++) { r.advance(MIN); await r.f.tick() }
  assert.equal(r.sent.length, 2, 'said once')

  r.set([nodeDown()])
  r.advance(MIN)
  await r.f.tick()
  assert.equal(r.sent.length, 3, 'the recovery, and no resolve or repeat of the node alert')
  const up = r.sent[2]
  assert.equal(up.type, 'alert.resolved')
  assert.equal(up.resolved, true)
  assert.equal(up.fingerprint, 'alert:monitoring-down')
  assert.equal(up.lines![1], 'It was down for 36 min, from 11 Nov, 14:01.')
})

test('a short Prometheus blip says nothing either way', async () => {
  const r = rig()
  r.set([])
  await r.f.tick()
  r.set(new Error('timeout'))
  for (let i = 0; i < 3; i++) { r.advance(MIN); await r.f.tick() }
  r.set([])
  r.advance(MIN); await r.f.tick()
  assert.equal(r.sent.length, 0)
})

test('an install whose Prometheus has never answered is not "down"', async () => {
  const r = rig()
  r.set(new Error('connect ECONNREFUSED'))
  for (let i = 0; i < 20; i++) { r.advance(MIN); await r.f.tick() }
  assert.equal(r.sent.length, 0)
})

test('the not-forwarded list: CephHealthWarning by default, editable, and never announced', async () => {
  assert.deepEqual(notForwardedFromEnv({}), ['CephHealthWarning'])
  assert.deepEqual(notForwardedFromEnv({ ALERTS_NOT_FORWARDED: ' NodeHighCPU , CephHealthWarning,' }), ['NodeHighCPU', 'CephHealthWarning'])
  assert.deepEqual(notForwardedFromEnv({ ALERTS_NOT_FORWARDED: '' }), [], 'empty forwards everything')

  const r = rig()
  r.set([cephWarn(), nodeDown()])
  await r.f.tick()
  assert.deepEqual(r.sent.map(e => e.title), ['Node n1 is down'])
  r.set([nodeDown()])
  await r.f.tick()
  assert.equal(r.sent.length, 1, 'its clearing is not announced either')

  let list = ['CephHealthWarning']
  const all = rig({ notForwarded: () => list })
  all.set([cephWarn()])
  list = []
  await all.f.tick()
  assert.equal(all.sent.length, 1, 'with an empty list it is forwarded')
  // Put on the list while firing: forgotten quietly, not reported as fixed.
  list = ['CephHealthWarning']
  all.set([])
  await all.f.tick()
  assert.equal(all.sent.length, 1)
  assert.deepEqual(all.store.load().firing, {})
})

test('a publish that throws is retried on the next poll, not lost', async () => {
  let fail = true
  const sent: NotifyEventInput[] = []
  const r = rig({ publish: async e => { if (fail) throw new Error('db down'); sent.push(e) } })
  r.set([nodeDown()])
  assert.equal((await r.f.tick()).fired, 0)
  fail = false
  assert.equal((await r.f.tick()).fired, 1)
  assert.equal(sent.length, 1)
})

test('severity labels map to notification severities', async () => {
  const r = rig()
  const mk = (alertname: string, severity?: string): PromAlert => ({ state: 'firing', labels: { alertname, node: 'n1', ...(severity ? { severity } : {}) } })
  r.set([mk('A', 'critical'), mk('B', 'warning'), mk('C', 'info'), mk('D')])
  await r.f.tick()
  assert.deepEqual(r.sent.map(e => [e.title, e.severity]), [['A on n1', 'critical'], ['B on n1', 'warning'], ['C on n1', 'info'], ['D on n1', 'warning']])
})

test('where an alert is, in words', () => {
  const names = (id: string) => (id === 'c0123456789' ? 'Family Server' : null)
  assert.equal(placeOf({ node: 'srv@c0123456789', hpx_cluster: 'c0123456789', hpx_node: 'srv' }, names), 'srv (Family Server)')
  assert.equal(placeOf({ node: 'srv@cfffffffff0', hpx_cluster: 'cfffffffff0' }, names), 'srv (a remote cluster)')
  assert.equal(placeOf({ node: 'n1' }, names), 'n1')
  assert.equal(placeOf({ job: 'prometheus' }, names), 'the prometheus monitoring job')
  assert.equal(placeOf({}, names), 'HyperProx')
})

test('without title/plain annotations, the summary and description are used with the place in place of the raw node label', async () => {
  const r = rig()
  r.set([{ ...gpu(), annotations: { summary: 'GPU on srv@c0123456789 is not responding', description: 'srv@c0123456789 card hung' } }])
  await r.f.tick()
  assert.equal(r.sent[0].title, 'GPU on srv (Family Server) is not responding')
  assert.equal(r.sent[0].lines![0], 'srv (Family Server) card hung.')
})

test('durations read naturally', () => {
  assert.equal(duration(0), '0 min')
  assert.equal(duration(59 * MIN), '59 min')
  assert.equal(duration(60 * MIN), '1 h')
  assert.equal(duration(125 * MIN), '2 h 5 min')
  assert.equal(duration(28 * 60 * MIN), '1 day 4 h')
  assert.equal(duration(48 * 60 * MIN), '2 days')
})
