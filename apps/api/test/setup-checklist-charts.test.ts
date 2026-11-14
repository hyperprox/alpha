// Setup checklist, "charts and dashboards": done only when Prometheus answers a query (/api/v1/query?query=up),
// never just because the compose profile is switched on. Prometheus is a local fake HTTP server here.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { prometheusReadiness, checklistState, type ChecklistDeps } from '../src/lib/setup-checklist'

let mode: 'ok' | 'error' | '503' = 'ok'
const asked: string[] = []
const server = http.createServer((req, res) => {
  asked.push(req.url ?? '')
  if (mode === '503') { res.statusCode = 503; res.end('Service Unavailable'); return }
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(mode === 'ok'
    ? { status: 'success', data: { resultType: 'vector', result: [{ metric: { job: 'node' }, value: [1, '1'] }, { metric: { job: 'pve' }, value: [1, '0'] }] } }
    : { status: 'error', errorType: 'bad_data', error: 'query processing failed' }))
})
const ready = new Promise<string>(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as any).port}`)))
after(() => server.close())

test('prometheusReadiness: a successful `up` query is ready, with how many targets are up', async () => {
  const base = await ready
  mode = 'ok'
  const r = await prometheusReadiness(base)
  assert.equal(r.ok, true)
  assert.match(r.reason, /1 of 2 target\(s\) up/)
  assert.equal(asked.at(-1), '/api/v1/query?query=up')
})

test('prometheusReadiness: an error answer, an HTTP error and no answer at all each fail with the reason', async () => {
  const base = await ready
  mode = 'error'
  const e = await prometheusReadiness(base)
  assert.equal(e.ok, false)
  assert.match(e.reason, /query processing failed/)
  mode = '503'
  const s = await prometheusReadiness(base)
  assert.equal(s.ok, false)
  assert.match(s.reason, /HTTP 503/)
  const closed = await prometheusReadiness('http://127.0.0.1:1')
  assert.equal(closed.ok, false)
  assert.match(closed.reason, /did not answer a query/)
})

const dir = mkdtempSync(path.join(tmpdir(), 'hpx-charts-'))
function deps(profiles: string, promReady?: ChecklistDeps['promReady']): ChecklistDeps {
  const envFile = path.join(dir, `env-${Math.random().toString(36).slice(2)}`)
  writeFileSync(envFile, `COMPOSE_PROFILES=${profiles}\n`, { mode: 0o600 })
  return {
    hardware: { nodes: async () => [], addresses: async () => ({}), pci: async () => [], login: async () => null, exec: async () => ({ code: 1, output: '' }), metrics: async () => null },
    envFile, hyperproxDir: dir,
    promQuery: async () => [], compose: async () => {}, ollamaModels: async () => null, pullModel: async () => {},
    pveExporter: async () => ({ configured: false, readOnly: null }), provisionPveExporter: async () => ({}),
    dnsKey: async () => ({}), saveDnsKey: async () => {}, testDnsKey: async () => 0, setOllamaUrl: async () => {},
    syncTargets: async () => ({}), saveNodeLogin: async () => {}, pins: async () => [], presentedKey: async () => '',
    ...(promReady ? { promReady } : {}),
  }
}
const charts = async (d: ChecklistDeps) => (await checklistState(d)).items.find(i => i.id === 'charts')!

test('checklist: charts switched on and Prometheus answering is done', async () => {
  const base = await ready
  mode = 'ok'
  const item = await charts(deps('monitoring', () => prometheusReadiness(base)))
  assert.equal(item.state, 'done')
  assert.equal(item.action, null)
  assert.match(item.rows[0].reason, /answers queries/)
})

test('checklist: charts switched on but Prometheus not answering is failed, with the reason and a way to fix it', async () => {
  const base = await ready
  mode = '503'
  const item = await charts(deps('monitoring', () => prometheusReadiness(base)))
  assert.equal(item.state, 'failed')
  assert.equal(item.rows[0].state, 'failed')
  assert.match(item.rows[0].reason, /HTTP 503/)
  assert.equal(item.action, 'Start Prometheus and Grafana again')
  const gone = await charts(deps('monitoring', () => prometheusReadiness('http://127.0.0.1:1')))
  assert.equal(gone.state, 'failed')
})

test('checklist: charts switched off is not done, and Prometheus is not asked', async () => {
  let askedReady = false
  const item = await charts(deps('', async () => { askedReady = true; return { ok: true, reason: '' } }))
  assert.equal(item.state, 'not-done')
  assert.equal(askedReady, false)
})
