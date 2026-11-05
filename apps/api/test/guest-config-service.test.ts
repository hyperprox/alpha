// Guest config editor service: server-held previews, digest conflicts, quorum, pending, revert, HA restarts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeService, smallCt, OWNER, FIX } from './fakes/guest-pve'
import { GuestConfigRefusal } from '../src/lib/guest-config/service'

const CT = { node: 'node-a', type: 'lxc' as const, vmid: 901 }

function setup(over: any = {}, guest: any = {}) {
  const s = makeService()
  s.pve.add({ node: 'node-a', type: 'lxc', vmid: 901, status: 'stopped', config: smallCt(over), ...guest })
  return s
}

async function refusal(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: any) => { assert.ok(e instanceof GuestConfigRefusal, String(e)); assert.equal(e.code, code, e.message); return true })
}

test('preview then apply: the write carries the digest, lands, and is re-read, recorded and audited', async () => {
  const { service, pve, history, audits } = setup()
  const p = await service.preview(OWNER, CT, { kind: 'edit', edit: { cores: 2, memory: 1024, tags: ['test', 'web'] } })
  assert.deepEqual(p.plan.errors, [])
  const r = await service.apply(OWNER, p.id)
  assert.equal(r.ok, true, JSON.stringify(r.outcome?.problems))
  const put = pve.writes.find(w => w.path.endsWith('/config'))!
  assert.equal(put.params.digest, p.digest)
  assert.equal(pve.g('lxc', 901).config.cores, 2)
  assert.deepEqual(pve.g('lxc', 901).config.lxc, [['lxc.cgroup2.devices.allow', 'c 10:200 rwm']], 'the raw line survived')
  assert.equal(r.outcome!.rawBefore, 1); assert.equal(r.outcome!.rawAfter, 1)
  const rows = await history.list('lxc/901')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].before.cores, 1); assert.equal((rows[0].after as any).cores, 2)
  assert.equal(audits[0].action, 'guest_config.apply'); assert.equal(audits[0].details.outcome, 'ok')
})

test('a change made between preview and apply fails the apply with nothing written', async () => {
  const { service, pve } = setup()
  const p = await service.preview(OWNER, CT, { kind: 'edit', edit: { cores: 2 } })
  pve.g('lxc', 901).config.memory = 4096   // someone else edits it
  await refusal(service.apply(OWNER, p.id), 'changed')
  assert.equal(pve.writes.length, 0)
  assert.equal(pve.g('lxc', 901).config.cores, 1)
})

test('a change racing the write itself is refused by Proxmox on the digest', async () => {
  const { service, pve } = setup()
  const p = await service.preview(OWNER, CT, { kind: 'edit', edit: { cores: 2 } })
  pve.beforePut = g => { g.config.memory = 4096; pve.beforePut = undefined }
  const r = await service.apply(OWNER, p.id)
  assert.equal(r.ok, false)
  assert.ok(r.outcome!.problems.some(x => /modified configuration/.test(x)))
  assert.equal(pve.g('lxc', 901).config.cores, 1)
})

test('not quorate: the preview says so and the apply refuses before any write', async () => {
  const { service, pve } = setup()
  pve.quorate = false
  const p = await service.preview(OWNER, CT, { kind: 'edit', edit: { cores: 2 } })
  assert.match(p.plan.errors[0], /not quorate/)
  await refusal(service.apply(OWNER, p.id), 'refused')
  pve.quorate = true
  const q = await service.preview(OWNER, CT, { kind: 'edit', edit: { cores: 2 } })
  pve.quorate = false
  await refusal(service.apply(OWNER, q.id), 'not-quorate')
  assert.equal(pve.writes.length, 0)
})

test('a preview applies once, only for its owner, and not after it expires', async () => {
  const { service, tick } = setup()
  const p = await service.preview(OWNER, CT, { kind: 'edit', edit: { cores: 2 } })
  await refusal(service.apply('someone@else', p.id), 'not-found')
  await service.apply(OWNER, p.id)
  await refusal(service.apply(OWNER, p.id), 'used')
  const q = await service.preview(OWNER, CT, { kind: 'edit', edit: { cores: 3 } })
  tick(11 * 60_000)
  await refusal(service.apply(OWNER, q.id), 'expired')
})

test('a Proxmox task that says OK while the config did not change is reported as failed', async () => {
  const { service, pve, history } = setup()
  const p = await service.preview(OWNER, CT, { kind: 'edit', edit: { cores: 2 } })
  pve.lieOnce = true
  const r = await service.apply(OWNER, p.id)
  assert.equal(r.ok, false)
  assert.ok(r.outcome!.problems.some(x => /cores/.test(x)))
  assert.equal((await history.list('lxc/901'))[0].outcome, 'failed')
})

test('pending: on a running guest a mount point waits for a restart, and the apply names the pending keys', async () => {
  const { service } = setup({}, { status: 'running' })
  const p = await service.preview(OWNER, CT, { kind: 'edit', edit: { cores: 2, mounts: { add: [{ kind: 'volume', storage: 'fast-ssd', sizeGb: 2, mp: '/data' }] } } })
  const r = await service.apply(OWNER, p.id)
  assert.equal(r.ok, true, JSON.stringify(r.outcome?.problems))
  assert.deepEqual(r.pendingKeys, ['mp0'])
  assert.equal(r.restartOffered, true)
  const v = await service.view(CT)
  assert.deepEqual(v.pending.keys, ['mp0'])
})

test('restart of a plain guest reboots it; of an HA guest goes through HA state, never a direct stop/start', async () => {
  const plain = setup({}, { status: 'running' })
  let p = await plain.service.preview(OWNER, CT, { kind: 'edit', edit: { mounts: { add: [{ kind: 'volume', storage: 'fast-ssd', sizeGb: 2, mp: '/data' }] } } })
  await plain.service.apply(OWNER, p.id)
  let rs = await plain.service.preview(OWNER, CT, { kind: 'restart', after: p.id })
  let r = await plain.service.apply(OWNER, rs.id)
  assert.equal(r.ok, true, JSON.stringify(r.restart))
  assert.equal(r.restart!.via, 'direct')
  assert.ok(plain.pve.writes.some(w => w.path.endsWith('/status/reboot')))
  assert.deepEqual(r.restart!.pendingAfter, [])

  const ha = setup({}, { status: 'running', ha: 'started' })
  p = await ha.service.preview(OWNER, CT, { kind: 'edit', edit: { mounts: { add: [{ kind: 'volume', storage: 'fast-ssd', sizeGb: 2, mp: '/data' }] } } })
  await ha.service.apply(OWNER, p.id)
  rs = await ha.service.preview(OWNER, CT, { kind: 'restart', after: p.id })
  assert.ok(rs.plan.checks.some(c => /through HA/.test(c)))
  r = await ha.service.apply(OWNER, rs.id)
  assert.equal(r.ok, true, JSON.stringify(r.restart))
  assert.equal(r.restart!.via, 'ha')
  const states = ha.pve.writes.filter(w => w.path.startsWith('/cluster/ha/resources/')).map(w => w.params.state)
  assert.deepEqual(states, ['stopped', 'started'])
  assert.ok(!ha.pve.writes.some(w => /\/status\/(stop|start|reboot|shutdown)$/.test(w.path)), 'no direct power call on an HA guest')
  assert.equal(ha.pve.g('lxc', 901).ha, 'started')
})

test('a restart that loses the raw lines is reported, even though the guest came back', async () => {
  const s = setup({}, { status: 'running' })
  const p = await s.service.preview(OWNER, CT, { kind: 'edit', edit: { mounts: { add: [{ kind: 'volume', storage: 'fast-ssd', sizeGb: 2, mp: '/data' }] } } })
  await s.service.apply(OWNER, p.id)
  s.pve.dropRawOnReboot = true
  const rs = await s.service.preview(OWNER, CT, { kind: 'restart', after: p.id })
  const r = await s.service.apply(OWNER, rs.id)
  assert.equal(r.ok, false)
  assert.equal(r.restart!.rawSurvived, false)
})

test('revert: a stored version comes back through its own previewed, digest-checked write', async () => {
  const { service, pve } = setup()
  const p1 = await service.preview(OWNER, CT, { kind: 'edit', edit: { cores: 2, memory: 1024, tags: ['test', 'web'] } })
  const r1 = await service.apply(OWNER, p1.id)
  const p2 = await service.preview(OWNER, CT, { kind: 'edit', edit: { cores: 3 } })
  await service.apply(OWNER, p2.id)
  const rv = await service.preview(OWNER, CT, { kind: 'revert', historyId: r1.historyId!, which: 'before' })
  assert.deepEqual(rv.plan.errors, [])
  assert.ok(rv.plan.changes.some(c => c.words === 'CPU cores: 3 → 1'))
  pve.g('lxc', 901).config.swap = 128
  await refusal(service.apply(OWNER, rv.id), 'changed')
  const rv2 = await service.preview(OWNER, CT, { kind: 'revert', historyId: r1.historyId!, which: 'before' })
  const r = await service.apply(OWNER, rv2.id)
  assert.equal(r.ok, true, JSON.stringify(r.outcome?.problems))
  const c = pve.g('lxc', 901).config
  assert.equal(c.cores, 1); assert.equal(c.memory, 512); assert.equal(c.tags, 'test')
  assert.equal(c.swap, 256, 'swap is reverted too: the whole editable state of that version comes back')
  assert.deepEqual(c.lxc, [['lxc.cgroup2.devices.allow', 'c 10:200 rwm']])
  const h = await service.historyOf(CT)
  assert.equal(h[0].tag, 'Revert')
})

test('add then remove a mount point, then revert the removal: the same volume is mounted again', async () => {
  const { service, pve } = setup()
  const a = await service.preview(OWNER, CT, { kind: 'edit', edit: { mounts: { add: [{ kind: 'volume', storage: 'fast-ssd', sizeGb: 1, mp: '/data' }] } } })
  assert.equal((await service.apply(OWNER, a.id)).ok, true)
  const vol = String(pve.g('lxc', 901).config.mp0)
  const rm = await service.preview(OWNER, CT, { kind: 'edit', edit: { mounts: { remove: ['mp0'] } } })
  const rr = await service.apply(OWNER, rm.id)
  assert.equal(rr.ok, true, JSON.stringify(rr.outcome?.problems))
  assert.equal(pve.g('lxc', 901).config.unused0, vol.split(',')[0])
  const rv = await service.preview(OWNER, CT, { kind: 'revert', historyId: rr.historyId!, which: 'before' })
  assert.deepEqual(rv.plan.errors, [])
  assert.ok(!(rv.plan.ops[0] as any).delete.includes('unused0'))
})

test('shared=1 is checked on every node by the service before it is planned', async () => {
  const { service, shell } = setup()
  shell.dirs = { 'node-a': { '/mnt/media': 'ceph' }, 'node-b': { '/mnt/media': 'ceph' } }
  const p = await service.preview(OWNER, CT, { kind: 'edit', edit: { mounts: { add: [{ kind: 'bind', source: '/mnt/media', mp: '/media', shared: true }] } } })
  assert.ok(p.plan.errors.some(e => /missing on node-c/.test(e)), p.plan.errors.join('\n'))
  shell.dirs['node-c'] = { '/mnt/media': 'ext2/ext3' }
  const q = await service.preview(OWNER, CT, { kind: 'edit', edit: { mounts: { add: [{ kind: 'bind', source: '/mnt/media', mp: '/media', shared: true }] } } })
  assert.ok(q.plan.errors.some(e => /node-c \(a different filesystem/.test(e)), q.plan.errors.join('\n'))
  shell.dirs['node-c'] = { '/mnt/media': 'ceph' }
  shell.logins.delete('node-b')
  const r = await service.preview(OWNER, CT, { kind: 'edit', edit: { mounts: { add: [{ kind: 'bind', source: '/mnt/media', mp: '/media', shared: true }] } } })
  assert.ok(r.plan.errors.some(e => /cannot verify on node-b/.test(e)))
  shell.logins.add('node-b')
  const ok = await service.preview(OWNER, CT, { kind: 'edit', edit: { mounts: { add: [{ kind: 'bind', source: '/mnt/media', mp: '/media', shared: true }] } } })
  assert.deepEqual(ok.plan.errors, [])
})

test('the NVIDIA fixture: an edit keeps all twelve raw lines, and a raw-line edit is previewed but never written', async () => {
  const s = makeService()
  s.pve.add({ node: 'node-a', type: 'lxc', vmid: 911, status: 'stopped', config: JSON.parse(FIX('ct-nvidia.json')) })
  const g = { node: 'node-a', type: 'lxc' as const, vmid: 911 }
  const p = await s.service.preview(OWNER, g, { kind: 'edit', edit: { memory: 16384 } })
  const r = await s.service.apply(OWNER, p.id)
  assert.equal(r.ok, true, JSON.stringify(r.outcome?.problems))
  assert.equal(r.outcome!.rawBefore, 12); assert.equal(r.outcome!.rawAfter, 12)
  const raw = await s.service.preview(OWNER, g, { kind: 'raw', raw: { remove: [['lxc.cgroup2.devices.allow', 'c 195:* rwm']] } })
  assert.ok(raw.plan.changes.some(c => /Remove lxc.cgroup2.devices.allow: c 195/.test(c.words)))
  assert.ok(raw.plan.errors.some(e => /does not accept lxc/.test(e)))
  await refusal(s.service.apply(OWNER, raw.id, { name: 'coder' }), 'refused')
})
