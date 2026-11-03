// Prometheus listens on 127.0.0.1:9090 only and Grafana on 127.0.0.1:3003 only. Everything in HyperProx
// that talks to them has to use loopback: HOST_IP no longer answers, and `localhost` may resolve to ::1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { prometheusBase, prometheusCandidates, grafanaCandidates } from '../src/lib/service-health'

test('the API queries Prometheus on 127.0.0.1, whatever HOST_IP says', () => {
  assert.equal(prometheusBase({}), 'http://127.0.0.1:9090')
  assert.equal(prometheusBase({ HOST_IP: '192.0.2.10' }), 'http://127.0.0.1:9090')
  assert.equal(prometheusBase({ PROMETHEUS_URL: 'http://192.0.2.20:9090/' }), 'http://192.0.2.20:9090', 'an explicit override still wins')
})

test('health probes try loopback first', () => {
  assert.equal(prometheusCandidates({ HOST_IP: '192.0.2.10' })[0], 'http://127.0.0.1:9090')
  assert.equal(grafanaCandidates({ HOST_IP: '192.0.2.10' })[0], 'http://127.0.0.1:3003')
})

test('no API source reaches Prometheus through localhost or HOST_IP', () => {
  const root = path.join(__dirname, '..', 'src')
  const files: string[] = []
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p)
  } }
  walk(root)
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    assert.doesNotMatch(src, /localhost:9090/, path.relative(root, f))
    assert.doesNotMatch(src, /HOST_IP[^\n]*:9090/, path.relative(root, f))
  }
})
