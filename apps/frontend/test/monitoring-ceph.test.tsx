// Monitoring counts Ceph's health warnings as the dashboard lists them, cluster-wide (no node), once.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cephAlerts, withCephAlerts, monitoringTitle } from '../lib/monitoring-title'

const WARN = { health: { status: 'HEALTH_WARN', checks: {
  POOL_NO_REDUNDANCY: { severity: 'HEALTH_WARN', summary: { message: '1 pool(s) have no replicas configured' } },
  BLUESTORE_SLOW_OP_ALERT: { severity: 'HEALTH_WARN', summary: { message: '2 OSD(s) experiencing slow operations' } },
} } }

test('Ceph warnings are Monitoring warnings, with no node, the intentional one left out', () => {
  const c = cephAlerts(WARN)
  assert.deepEqual(c.map(a => [a.name, a.severity, a.node]), [['Ceph: BLUESTORE_SLOW_OP_ALERT', 'warning', '']])
  assert.equal(cephAlerts({ health: { status: 'HEALTH_OK', checks: {} } }).length, 0)
  assert.equal(cephAlerts(null).length, 0)
  const all = withCephAlerts([{ name: 'CephHealthWarning' }, { name: 'NodeHighCPU' }], c)
  assert.deepEqual(all.map(a => a.name), ['NodeHighCPU', 'Ceph: BLUESTORE_SLOW_OP_ALERT'], 'the whole-cluster alert is not counted twice')
  assert.notEqual(monitoringTitle({ loading: false, promDown: false, critical: 0, warning: c.length, firing: c.length }), 'All clear')
})
