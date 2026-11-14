// A Ceph health alert is about the cluster, never the node whose exporter happened to report it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { alertNode } from '../src/routes/prometheus'
import { placeOf } from '../src/lib/alerts/forwarder'

test('a cluster-scope alert has no node; a node alert keeps its node', () => {
  assert.equal(alertNode({ alertname: 'CephHealthWarning', instance: 'node-b:9221', scope: 'cluster' }), '')
  assert.equal(alertNode({ alertname: 'CephHealthWarning', instance: 'node-b:9221' }), '', 'even from an older rule without scope')
  assert.equal(alertNode({ alertname: 'NodeHighCPU', node: 'node-c' }), 'node-c')
  assert.equal(placeOf({ alertname: 'CephHealthWarning', scope: 'cluster' }), 'the cluster')
})

test('the Ceph health rules aggregate away the reporting node', () => {
  const rules = fs.readFileSync(path.join(__dirname, '../../../config/prometheus/rules/cluster.yml'), 'utf8')
  assert.match(rules, /alert: CephHealthWarning\n\s+expr: max\(ceph_health_status\) == 1/)
  assert.match(rules, /alert: CephHealthError\n\s+expr: max\(ceph_health_status\) == 2/)
})
