// Pure logic behind the install-test fixes. Run with the frontend test command (see install-handoff.test.tsx).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { vpnHeadline, vpnTally } from '../lib/vpn-headline'
import { buildAttention, attentionItems, attentionTitle } from '../components/dashboard/attention'
import { summarizeHA, cephHealthWord, isDeliberatelyStopped } from '../components/dashboard/summaries'
import { pluginKind, pluginWord, isNotConfigured } from '../lib/plugin-status'
import { defaultNode, templatesForArch, hostArch, pickRootStorage, storagesFor } from '../lib/lxc-form'
import { monitoringTitle } from '../lib/monitoring-title'
import { chooseClusterName } from '../lib/cluster-name'
import { isNoLoginText, withoutLoginAdvice, unmanagedWords } from '../lib/node-login'
import { deleteNameOk } from '../lib/confirm-name'

const cell = (state: string, extra: object = {}) => ({ state, managed: false, ...extra })
const row = (c: object, running = true) => ({ running, cells: { tailscale: c, netbird: c } }) as any

test('VPN headline counts only checked-and-down tunnels', () => {
  const rows = [row(cell('unchecked')), row(cell('offline'), false), row(cell('offline'))]
  const t = vpnTally(rows, 'tailscale')
  assert.deepEqual(t, { connected: 0, down: 0, notChecked: 1 })
  assert.equal(vpnHeadline({ ...t, notChecked: 10 }), 'Tunnels not checked yet')
  const down = vpnTally([row(cell('offline', { managed: true }))], 'tailscale')
  assert.equal(vpnHeadline(down), '1 tunnel is down or signed out')
})

test('a stopped HA guest is not attention, and the headline count equals the list', () => {
  const ha = [
    { type: 'quorum', id: 'q', quorate: 1 },
    { type: 'service', id: 's1', sid: 'ct:1', crm_state: 'stopped', request_state: 'stopped' },
    { type: 'service', id: 's2', sid: 'ct:2', crm_state: 'error', request_state: 'started' },
    { type: 'service', id: 's3', sid: 'ct:3', crm_state: 'started', request_state: 'started' },
  ]
  assert.equal(isDeliberatelyStopped(ha[1] as any), true)
  const s = summarizeHA(ha) as any
  assert.equal(s.wanted, 2); assert.equal(s.stopped, 1)
  const items = buildAttention({ nodes: [{ node: 'node-a', status: 'online' }], quorate: true, ceph: { status: 'HEALTH_WARN', checks: { POOL_NO_REDUNDANCY: {}, X: {} } }, storagePct: 40, ha, unreachable: [], alerts: [] })
  assert.equal(items.some(i => i.key === 'ha-s1'), false)
  assert.equal(attentionItems(items).length, 2) // ct:2 and Ceph X; the intentional pool note is not counted
  assert.equal(attentionTitle(items), '2 things need attention')
})

test('Ceph health in plain words', () => {
  assert.equal(cephHealthWord('HEALTH_WARN'), 'warning')
  assert.equal(cephHealthWord('HEALTH_OK'), 'healthy')
  assert.equal(cephHealthWord('HEALTH_ERR'), 'error')
})

test('a plug-in that was never set up is not unreachable', () => {
  const p = { error: 'Not configured yet: add a router on the ASUS page.' }
  assert.equal(isNotConfigured(p.error), true)
  assert.equal(pluginKind(p), 'not-set-up'); assert.equal(pluginWord(p), 'Not set up')
  assert.equal(pluginWord({ error: 'connect ECONNREFUSED' }), 'Needs attention: unreachable')
  // One word for not set up: a plug-in with no settings (off) reads the same as one whose answer says so.
  assert.equal(pluginKind({ off: true }), 'not-set-up'); assert.equal(pluginWord({ off: true }), 'Not set up')
})

test('template architecture and node default', () => {
  const t = [{ volid: 's:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst' }, { volid: 's:vztmpl/debian-13-standard_13.1-2_arm64.tar.zst' }, { volid: 's:vztmpl/x.tar.zst' }]
  assert.equal(templatesForArch(t, hostArch('x86_64')).length, 2)
  assert.equal(templatesForArch(t, null).length, 3)
  const nodes = [{ node: 'node-a', status: 'online', cpu: 0.9, mem: 8, maxmem: 10 }, { node: 'node-b', status: 'online', cpu: 0.1, mem: 1, maxmem: 10 }, { node: 'node-c', status: 'offline', cpu: 0, mem: 0, maxmem: 10 }]
  assert.equal(defaultNode(nodes, 'node-a'), 'node-a')
  assert.equal(defaultNode(nodes, 'node-c'), 'node-b')
  assert.equal(defaultNode(nodes, null), 'node-b')
})

test('root storage prefers shared storage that holds rootdir', () => {
  const st = [{ storage: 'local-lvm', node: 'node-a', content: 'rootdir,images', avail: 900 }, { storage: 'shared-rbd', node: 'node-a', shared: 1, content: 'rootdir,images', avail: 100 }, { storage: 'iso', node: 'node-a', shared: 1, content: 'iso' }]
  assert.equal(pickRootStorage(storagesFor('lxc', st, 'node-a')), 'shared-rbd')
})

test('Monitoring never says all clear while Prometheus is down', () => {
  assert.equal(monitoringTitle({ loading: false, promDown: true, critical: 0, warning: 0, firing: 0 }), 'Prometheus is not answering')
  assert.equal(monitoringTitle({ loading: false, promDown: false, critical: 0, warning: 0, firing: 0 }), 'All clear')
})

test('cluster name falls back to the build name', () => {
  assert.equal(chooseClusterName('prod', 'My cluster'), 'prod')
  assert.equal(chooseClusterName(null, 'My cluster'), 'My cluster')
  assert.equal(chooseClusterName('  ', ''), '')
})

test('node login wording is the same everywhere', () => {
  const a = 'No login saved for node node-a. Add one in the Terminal (node logins are never borrowed from guests).'
  assert.equal(isNoLoginText(a), true)
  assert.equal(withoutLoginAdvice(a), 'No login saved for node node-a.')
  assert.equal(withoutLoginAdvice('No login for node-a: add one under Settings → Nodes to list its devices.').includes('Nodes'), false)
  assert.equal(unmanagedWords({ error: a }, {}), 'needs a node login')
  assert.equal(unmanagedWords({ unmanagedReason: 'windows' }, { windows: 'Windows guest' }), 'Windows guest')
})

test('deleting a guest needs its exact name', () => {
  assert.equal(deleteNameOk('web', 'web'), true)
  assert.equal(deleteNameOk('Web', 'web'), false)
  assert.equal(deleteNameOk('', ''), false)
})
