// "Is a backup running" is asked by three features, each with its own policy when the answer cannot be read:
//   Updates   - a failed read counts as running (the item waits);
//   Load balancing - an unread task log means "unknown" (neither blocked nor cleared);
//   Nextcloud - null (unknown), and a vzdump that has not named its guest yet blocks every guest.
// These pin each policy; they were written before the shared helper (lib/pve/tasks.ts) replaced the copies.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { UpdatesRunner } from '../src/lib/updates/runner'
import { MemoryStore } from '../src/lib/updates/store'
import { productionExecutor } from '../src/lib/updates/executor'
import { FakeCluster, node, guest, policyLoad, FAST } from './updates-fake'
import { readCluster } from '../src/lib/placement/read'
import { ProxmoxClient } from '../src/lib/proxmox-client'
import { backupRunning } from '../src/lib/nextcloud'
import { placementFixture, fakePve } from './fakes/placement-cluster'

// ── Updates ──────────────────────────────────────────────────────────────────

const POLICY = `
nodes:
  default: { upgrade: dist-upgrade, reboot: auto }
`
async function updatesStep(backupTasks: () => Promise<any[]>) {
  const fake = new FakeCluster({ nodes: [node('node-a', {})], guests: [guest(101, 'node-a')] })
  fake.backupTasks = backupTasks
  const store = new MemoryStore()
  const runner = new UpdatesRunner({ store, exec: fake, loadPolicy: policyLoad(POLICY), timing: FAST, hostname: 'not-a-guest' })
  const job = await runner.start('run', 'manual', 'admin@example.com', 'all', [], ['guest:101'])
  await runner.idle(); await runner.idle()
  await runner.confirm(job.id, 'admin@example.com')
  await runner.idle(); await runner.idle()
  const steps = await store.getSteps(job.id)
  return steps.find(s => s.target === '101' && s.action === 'apt')!
}

test('Updates: a backup read that fails counts as running, with the reason', async () => {
  const s = await updatesStep(async () => { throw new Error('boom') })
  assert.match(s.reason!, /^not run: a backup is running \(whether one is could not be read: boom\)/)
})

test('Updates: a running backup of the guest or on its node waits; a finished one, or another node, does not', async () => {
  assert.match((await updatesStep(async () => [{ node: 'node-a', at: 1, ok: null, vmid: null }])).reason!, /^not run: a backup is running \(on node-a\)/)
  assert.match((await updatesStep(async () => [{ node: 'node-z', at: 1, ok: null, vmid: 101 }])).reason!, /^not run: a backup is running \(on node-z, guest 101\)/)
  assert.doesNotMatch((await updatesStep(async () => [{ node: 'node-a', at: 1, ok: true, vmid: 101 }])).reason ?? '', /backup is running/)
  assert.doesNotMatch((await updatesStep(async () => [{ node: 'node-z', at: 1, ok: null, vmid: 999 }])).reason ?? '', /backup is running/)
})

test('Updates executor: backupTasks reads each online node, keeps the id only when it is a number, and tells running from finished', async () => {
  const seen: string[] = []
  const pve: any = { fetchStrict: async (p: string) => {
    seen.push(p)
    if (p === '/cluster/status') return [{ type: 'cluster', quorate: 1 }, { type: 'node', name: 'a', online: 1, ip: '10.0.0.1' }, { type: 'node', name: 'b', online: 0 }, { type: 'node', name: 'c', online: 1, ip: '10.0.0.3' }]
    if (p.startsWith('/nodes/a/tasks')) return [
      { starttime: 100, id: '105' },                      // no status yet: running, one guest
      { starttime: 200, id: '', status: 'running' },      // running, no guest named
      { starttime: 300, id: '106', status: 'OK' },
      { starttime: 400, id: 'x', status: 'job errors' },
      { starttime: 'junk', id: '1' },                     // unreadable time: dropped
    ]
    if (p.startsWith('/nodes/c/tasks')) throw new Error('node c down')
    throw new Error(`unexpected ${p}`)
  } }
  const rows = await productionExecutor(pve).backupTasks!()
  assert.ok(seen.some(p => p === '/nodes/a/tasks?typefilter=vzdump&limit=20&source=all'))
  assert.ok(!seen.some(p => p.startsWith('/nodes/b')))
  assert.deepEqual(rows, [
    { node: 'a', at: 400000, ok: false, vmid: null },
    { node: 'a', at: 300000, ok: true, vmid: 106 },
    { node: 'a', at: 200000, ok: null, vmid: null },
    { node: 'a', at: 100000, ok: null, vmid: 105 },
  ])
})

// ── Load balancing ───────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 5, 15, 12, 0)
const tasksFixture = (tasks: any[] | Error) => {
  const f = placementFixture()
  const base = fakePve(f)
  return { fetchStrict: async (p: string, ...r: any[]) => {
    if (p === '/cluster/tasks') { if (tasks instanceof Error) throw tasks; return tasks }
    return (base as any).fetchStrict(p, ...r)
  } } as any
}

test('Load balancing: an unread task log is "unknown", not "no backup"', async () => {
  const r = await readCluster(tasksFixture(new Error('no tasks')), { now: NOW })
  assert.equal(r.input.tasksRead, false)
  assert.deepEqual(r.input.backupsRunning, [])
  assert.ok(r.input.unread.includes('the cluster task log'))
  assert.deepEqual(r.tasks, [])
})

test('Load balancing: running vzdump rows keep their node, and their guest only when the id is a number', async () => {
  const r = await readCluster(tasksFixture([
    { type: 'vzdump', node: 'node1', id: '', starttime: 1, upid: 'u1' },
    { type: 'vzdump', node: 'node2', id: '105', starttime: 2, upid: 'u2', status: 'running' },
    { type: 'vzdump', node: 'node3', id: '106', starttime: 3, endtime: 9, status: 'OK', upid: 'u3' },
    { type: 'qmigrate', node: 'node3', id: '103', starttime: 4, upid: 'u4' },
  ]), { now: NOW })
  assert.equal(r.input.tasksRead, true)
  assert.deepEqual(r.input.backupsRunning, [{ node: 'node1' }, { node: 'node2', vmid: 105 }])
})

// ── Nextcloud ────────────────────────────────────────────────────────────────

const saved = { fetchStrict: (ProxmoxClient.prototype as any).fetchStrict, env: { ...process.env } }
beforeEach(() => { Object.assign(process.env, { PROXMOX_HOST: 'pve.invalid', PROXMOX_PORT: '8006', PROXMOX_USER: 'u@pve', PROXMOX_TOKEN_ID: 't', PROXMOX_TOKEN_SECRET: 's' }) })
afterEach(() => { (ProxmoxClient.prototype as any).fetchStrict = saved.fetchStrict; process.env = { ...saved.env } })
const tasksAre = (v: any[] | Error) => { (ProxmoxClient.prototype as any).fetchStrict = async () => { if (v instanceof Error) throw v; return v } }

test('Nextcloud: an unreadable task list is null (unknown)', async () => {
  tasksAre(new Error('down'))
  assert.equal(await backupRunning({ kind: 'lxc', vmid: 105 }), null)
})

test('Nextcloud: the guest\'s own running vzdump blocks, another guest\'s does not, an unnamed one blocks every guest', async () => {
  const g = { kind: 'lxc' as const, vmid: 105 }
  tasksAre([{ type: 'vzdump', id: '105' }]); assert.equal(await backupRunning(g), true)
  tasksAre([{ type: 'vzdump', id: '106' }]); assert.equal(await backupRunning(g), false)
  tasksAre([{ type: 'vzdump', id: '' }]); assert.equal(await backupRunning(g), true)
  tasksAre([{ type: 'vzdump' }]); assert.equal(await backupRunning(g), true)
  tasksAre([{ type: 'vzdump', id: '105', endtime: 5, status: 'OK' }, { type: 'qmigrate', id: '' }]); assert.equal(await backupRunning(g), false)
  tasksAre([{ type: 'vzdump', id: '105', status: 'running' }]); assert.equal(await backupRunning(g), true)
  tasksAre([]); assert.equal(await backupRunning(g), false)
})

// ── the shared helper ────────────────────────────────────────────────────────

import { runningBackups, backupRowsOf, taskRunning, taskVmid } from '../src/lib/pve/tasks'

test('runningBackups: rows of running vzdump tasks; a failed or odd read says so', async () => {
  const ok = await runningBackups({ fetchStrict: async () => [{ type: 'vzdump', node: 'a', id: '7' }, { type: 'vzdump', node: 'b', id: '' }, { type: 'vzdump', node: 'c', id: '9', endtime: 1, status: 'OK' }, { type: 'aptupdate', node: 'a' }] } as any)
  assert.deepEqual(ok, { read: true, rows: [{ node: 'a', id: '7', vmid: 7 }, { node: 'b', id: '', vmid: null }] })
  assert.deepEqual(await runningBackups({ fetchStrict: async () => { throw new Error('x') } } as any), { read: false, rows: [] })
  assert.deepEqual(await runningBackups({ fetchStrict: async () => ({ not: 'a list' }) } as any), { read: false, rows: [] })
  assert.deepEqual(await runningBackups({ fetchStrict: async () => null } as any), { read: true, rows: [] })
  assert.deepEqual(backupRowsOf(undefined), [])
  assert.equal(taskRunning({ status: 'running' }), true)
  assert.equal(taskRunning({ status: 'OK', endtime: 1 }), false)
  assert.equal(taskVmid('0042'), 42)
  assert.equal(taskVmid('a'), null)
})
