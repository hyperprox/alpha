// Guest actions read back, the Command center panel, the hardware words, and monitoring's plan/apply, all
// against in-process fakes (no Proxmox, no SSH, nothing outside this process).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { power, snapshot, destroy, backupNow, checkGuest, GuestActionRefusal } from '../src/lib/clusters/guest-actions'
import { readPanel, clusterSelector, remoteNodeLabel } from '../src/lib/clusters/overview'
import { parseVainfo, gpuCapability } from '../src/lib/hardware'
import { setClusterStore, loadClusters } from '../src/lib/clusters/registry'
import { MemoryClusterStore } from '../src/lib/clusters/store'
import { setAuditSink } from '../src/lib/audit'
import {
  parseScan, installScript, removeScript, assertSafeScript, writeRemoteTargets, previewMonitoring, applyMonitoring,
  clearMonitoringPlans, SCAN_SCRIPT, MonitoringRefusal, type MonitoringDeps,
} from '../src/lib/clusters/monitoring'

setAuditSink({ write: async () => {} })

/** A pretend Proxmox: guests with a status, tasks that finish at once, a call log. */
function fakePve(state: { status: Record<number, string>; names: Record<number, string>; ha?: string[]; snaps?: string[] }) {
  const calls: string[] = []
  const pve: any = {
    calls,
    async fetchStrict(path: string, method = 'GET', body?: string) {
      calls.push(`${method} ${path}${body ? ` ${body}` : ''}`)
      const m = /\/(lxc|qemu)\/(\d+)/.exec(path); const id = m ? Number(m[2]) : 0
      if (path.endsWith('/status/current')) return state.status[id] ? { status: state.status[id], name: state.names[id] } : null
      if (/\/status\/(start|reboot)$/.test(path)) { state.status[id] = 'running'; return 'UPID:pve:1:2:3:x:y:z:' }
      if (/\/status\/(stop|shutdown)$/.test(path)) { state.status[id] = 'stopped'; return 'UPID:pve:1:2:3:x:y:z:' }
      if (path.endsWith('/config')) return state.status[id] ? { hostname: state.names[id] } : null
      if (path.endsWith('/snapshot') && method === 'POST') { state.snaps = [...(state.snaps ?? []), new URLSearchParams(body).get('snapname')!]; return 'UPID:pve:snap:' }
      if (path.endsWith('/snapshot')) return (state.snaps ?? []).map(name => ({ name }))
      if (path === '/cluster/ha/resources') return (state.ha ?? []).map(sid => ({ sid }))
      if (method === 'DELETE') { delete state.status[id]; return 'UPID:pve:del:' }
      if (path === '/cluster/resources?type=vm') return Object.keys(state.status).map(v => ({ vmid: Number(v) }))
      if (path.includes('/storage?content=backup')) return [{ storage: 'backups', type: 'dir', active: 1, avail: 1e12 }]
      if (path.endsWith('/vzdump')) return 'UPID:pve:vzdump:'
      throw new Error(`unexpected ${method} ${path}`)
    },
    async waitForTask() { calls.push('wait') },
  }
  return pve
}

test('power is read back: the answer is what Proxmox reports afterwards', async () => {
  const pve = fakePve({ status: { 100: 'stopped' }, names: { 100: 'plex' } })
  const r = await power({ pve, sleep: async () => {} }, checkGuest('pve', 'lxc', 100), 'start')
  assert.equal(r.ok, true)
  assert.match(r.words, /plex is running now \(read back/)
  assert.ok(pve.calls.includes('wait'))
})

test('snapshot names are checked and the snapshot is read back', async () => {
  const pve = fakePve({ status: { 100: 'running' }, names: { 100: 'plex' } })
  await assert.rejects(snapshot({ pve }, checkGuest('pve', 'lxc', 100), '1bad name'), GuestActionRefusal)
  const r = await snapshot({ pve }, checkGuest('pve', 'lxc', 100), 'before-update')
  assert.equal(r.ok, true)
  assert.ok(pve.calls.some((c: string) => c.startsWith('POST /nodes/pve/lxc/100/snapshot snapname=before-update')), 'sent as a form, not JSON')
})

test('delete needs the exact name, a stopped guest, no HA; then it must be gone', async () => {
  const pve = fakePve({ status: { 100: 'running', 101: 'stopped', 102: 'stopped' }, names: { 100: 'plex', 101: 'old', 102: 'ha-guest' }, ha: ['ct:102'] })
  await assert.rejects(destroy({ pve }, checkGuest('pve', 'lxc', 101), 'Old'), (e: any) => e.code === 'confirm')
  await assert.rejects(destroy({ pve }, checkGuest('pve', 'lxc', 100), 'plex'), (e: any) => e.code === 'state')
  await assert.rejects(destroy({ pve }, checkGuest('pve', 'lxc', 102), 'ha-guest'), /managed by HA/)
  const r = await destroy({ pve }, checkGuest('pve', 'lxc', 101), 'old')
  assert.equal(r.ok, true)
  assert.ok(pve.calls.some((c: string) => c === 'DELETE /nodes/pve/lxc/101?purge=1&destroy-unreferenced-disks=1'))
})

test('backup only to a storage that takes backups on that node', async () => {
  const pve = fakePve({ status: { 100: 'running' }, names: { 100: 'plex' } })
  await assert.rejects(backupNow({ pve }, checkGuest('pve', 'lxc', 100), 'local-lvm'), /does not take backups/)
  const r = await backupNow({ pve }, checkGuest('pve', 'lxc', 100), 'backups')
  assert.match(r.upid, /^UPID:/)
})

test('guest ids and node names are checked before anything is sent', () => {
  assert.throws(() => checkGuest('../x', 'lxc', 100))
  assert.throws(() => checkGuest('pve', 'docker', 100))
  assert.throws(() => checkGuest('pve', 'lxc', '1;rm'))
})

test('the panel: an unreachable cluster says so on its own panel', async () => {
  const c: any = { id: 'c0123456789', name: 'Remote server', kind: 'remote', monitoring: {} }
  const p = await readPanel(c, { pve: () => ({ fetchStrict: async () => { throw new Error('connect ETIMEDOUT') } }) as any, prom: async () => [], now: Date.now })
  assert.equal(p.reachable, false)
  assert.match(p.attention[0].title, /Not answering/)
})

test('the panel: counts, bars, backup age and attention from Proxmox; GPU figures by the remote label', async () => {
  const c: any = { id: 'c0123456789', name: 'Remote server', kind: 'remote', monitoring: { pve: { nodeExporter: { listen: '10.0.0.5' } } } }
  const now = Date.now()
  const pve: any = {
    async fetchStrict(path: string) {
      if (path === '/version') return { version: '9.1' }
      if (path === '/nodes') return [{ node: 'pve', status: 'online', cpu: 0.1, maxcpu: 8, mem: 4, maxmem: 32 }]
      if (path === '/cluster/status') return [{ type: 'node', name: 'pve' }]
      if (path === '/cluster/resources?type=vm') return [{ type: 'lxc', status: 'running' }, { type: 'qemu', status: 'stopped' }, { type: 'qemu', template: 1, status: 'stopped' }]
      if (path === '/cluster/resources?type=storage') return [{ storage: 'local', node: 'pve', status: 'available', disk: 95, maxdisk: 100, shared: 0 }]
      return []
    },
    async fetchNode(path: string) {
      if (path.includes('hardware/pci')) return [{ class: '0x030000', vendor: '0x1002', device: '0x6939', device_name: 'Tonga PRO [Radeon R9 285/380]' }]
      if (path.includes('typefilter=vzdump')) return [{ starttime: Math.round((now - 4 * 86_400_000) / 1000), status: 'OK' }]
      return []
    },
  }
  const prom = async (expr: string) => expr.startsWith('node_drm_gpu_busy_percent') && expr.includes('hpx_cluster="c0123456789"')
    ? [{ metric: { node: remoteNodeLabel('c0123456789', 'pve'), hpx_node: 'pve' }, value: 14 }] : []
  const p = await readPanel(c, { pve: () => pve, prom, now: () => now })
  assert.equal(p.reachable, true)
  assert.deepEqual(p.nodes, { online: 1, total: 1 })
  assert.equal(p.quorum, 'standalone')
  assert.deepEqual(p.guests, { running: 1, total: 2 })
  assert.equal(p.storagePct, 95)
  assert.equal(p.gpus.length, 1)
  assert.equal(p.gpus[0].load, 14)
  assert.match(p.gpus[0].capability, /older generation: good for H\.264, likely not HEVC/)
  assert.ok(p.attention.some(a => /Storage local is 95% full/.test(a.title)))
  assert.ok(p.attention.some(a => /No backup in 3 days/.test(a.title)))
  assert.equal(clusterSelector({ id: 'home', kind: 'home' }), 'hpx_cluster=""')
})

test('vainfo is parsed into what the card really decodes and encodes', () => {
  const out = ['HPX-VAINFO-BEGIN /dev/dri/renderD128', 'vainfo: Driver version: Mesa Gallium driver for AMD Radeon R9 380', '      VAProfileMPEG2Main              :	VAEntrypointVLD', '      VAProfileH264Main               :	VAEntrypointVLD', '      VAProfileH264High               :	VAEntrypointEncSlice', 'HPX-VAINFO-END'].join('\n')
  const v = parseVainfo(out)
  assert.equal(v.installed, true)
  assert.deepEqual(v.devices[0].decode, ['MPEG-2', 'H.264'])
  assert.deepEqual(v.devices[0].encode, ['H.264'])
  const cap = gpuCapability({ vendor: 'amd', kind: 'dedicated', id: '1002:6939', name: 'Radeon R9 380' }, v.devices[0])
  assert.equal(cap.source, 'vainfo')
  assert.match(cap.summary, /decodes MPEG-2, H\.264; encodes H\.264 \(checked with vainfo/)
  assert.equal(parseVainfo('HPX-VAINFO-ABSENT').installed, false)
  assert.match(gpuCapability({ vendor: 'amd', kind: 'dedicated', id: 'x', name: 'Ellesmere [Radeon RX 470/480/570/580]' }).summary, /H\.264 and HEVC/)
})

test('monitoring scripts listen on the private link only, and never name corosync', () => {
  const s = installScript({ amdGpu: true })
  assert.match(s, /--web\.listen-address=\$\{LISTEN_HP\} --collector\.drm/)
  assert.match(s, /tailscale\*\|wg\*/)
  assert.ok(s.indexOf('hp_write_file "$DEF"') < s.indexOf('hp_safe_apt_install prometheus-node-exporter'), 'the listen address is written before the package can start')
  assert.doesNotThrow(() => assertSafeScript(s))
  assert.doesNotThrow(() => assertSafeScript(removeScript()))
  assert.doesNotThrow(() => assertSafeScript(SCAN_SCRIPT))
  assert.throws(() => assertSafeScript('systemctl restart corosync'), /never touches/)
  assert.throws(() => assertSafeScript('cat /etc/pve/corosync.conf'))
  assert.throws(() => assertSafeScript('systemctl restart pve-cluster'))
})

test('a scan on a LAN address is refused for metrics; on a tailnet address it is offered', () => {
  const lan = parseScan('pve', '10.0.0.5', 'listen=10.0.0.5\niface=vmbr0\npackage=absent\nservice=inactive\nlistening=\namd=yes\nours=no\ninstalled_by_us=no')
  assert.equal(lan.privateLink, false)
  const ts = parseScan('pve', 'pve1.example', 'listen=10.0.0.7\niface=tailscale0\npackage=absent\nservice=inactive\nlistening=\namd=yes\nours=no\ninstalled_by_us=no')
  assert.equal(ts.privateLink, true)
  assert.equal(ts.amd, true)
})

test('Prometheus targets: this cluster\'s entries are replaced, everything else is kept exactly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hpx-targets-'))
  const home = [{ targets: ['10.0.0.1:9100'], labels: { node: 'node1' } }]
  writeFileSync(join(dir, 'nodes.json'), JSON.stringify(home))
  writeRemoteTargets('c0123456789', [{ node: 'pve', listen: '10.0.0.7' }], dir)
  writeRemoteTargets('c0123456789', [{ node: 'pve', listen: '10.0.0.8' }], dir)
  const after = JSON.parse(readFileSync(join(dir, 'nodes.json'), 'utf8'))
  assert.deepEqual(after[0], home[0])
  assert.equal(after.length, 2)
  assert.deepEqual(after[1], { targets: ['10.0.0.8:9100'], labels: { node: 'pve@c0123456789', hpx_cluster: 'c0123456789', hpx_node: 'pve' } })
  writeRemoteTargets('c0123456789', [], dir)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'nodes.json'), 'utf8')), home)
})

test('monitoring: preview is server-held, applied once by its owner, and read back', async () => {
  const store = new MemoryClusterStore()
  await store.upsert({ id: 'c0123456789', name: 'Remote server', kind: 'remote', address: 'pve1.example', port: 8006, note: '', certFingerprint: 'AA', certConfirmedAt: null, certConfirmedBy: null, nodeAddresses: { pve: 'pve1.example' }, allowedRoots: [], monitoring: {}, plexUrl: null, createdBy: 'x' })
  setClusterStore(store); await loadClusters(); clearMonitoringPlans()
  const ran: string[] = []
  let written: any[] = []
  const deps: MonitoringDeps = {
    nodes: async () => ['pve'], hasLogin: async () => true, reachable: async () => true,
    async run(_h, script) {
      if (script === SCAN_SCRIPT) return { code: 0, output: 'listen=10.0.0.7\niface=tailscale0\npackage=absent\nservice=inactive\nlistening=\namd=yes\nours=no\ninstalled_by_us=no' }
      ran.push(script.includes('--collector.drm') ? 'install+amd' : 'install')
      return { code: 0, output: 'HPX-RESULT\tdone\tlistening on 10.0.0.7:9100 only, with AMD GPU figures' }
    },
    metrics: async () => 'node_exporter_build_info{} 1', writeTargets: (_id, e) => { written = e }, reload: async () => {},
    up: async () => ({ pve: 1 }), sleep: async () => {},
  }
  const prev = await previewMonitoring('c0123456789', 'owner@example.com', 'install', { 'server-metrics': true, 'amd-gpu': true }, deps)
  assert.equal(prev.steps.length, 1)
  assert.match(prev.steps[0], /listening on 10\.0\.0\.7:9100 only \(tailscale0\), with the AMD GPU collector on/)
  assert.equal(ran.length, 0, 'a preview installs nothing')
  await assert.rejects(applyMonitoring(prev.planId, 'someone-else@example.com', deps), MonitoringRefusal)
  const r = await applyMonitoring(prev.planId, 'owner@example.com', deps)
  assert.equal(r.ok, true)
  assert.deepEqual(ran, ['install+amd'])
  // Scraped at the address HyperProx saved for the node, not the one the node's output names.
  assert.deepEqual(written, [{ node: 'pve', listen: 'pve1.example' }])
  assert.equal((await store.list())[0].monitoring.pve.nodeExporter?.listen, 'pve1.example')
  await assert.rejects(applyMonitoring(prev.planId, 'owner@example.com', deps), /already applied/)
  setClusterStore(new MemoryClusterStore())
})
