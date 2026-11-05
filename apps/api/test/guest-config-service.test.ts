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
  assert.deepEqual(raw.plan.errors, [])
  assert.ok(raw.plan.changes.some(c => /Remove lxc.cgroup2.devices.allow: c 195.*next time the container starts/.test(c.words)))
  await refusal(s.service.apply(OWNER, raw.id), 'confirm')
})

// ── raw lines through the whole-file writer ───────────────────────────────────

function rawSetup(over: any = {}, guest: any = {}) {
  const s = setup(over, guest)
  s.shell.probes['node-a'] = FIX('probe-igpu.txt')
  s.shell.tail['901'] = '\n[before-change]\ncores: 1\nlxc.cgroup2.devices.allow: c 10:200 rwm\nsnaptime: 1700000000\n'
  return s
}
const ADD: [string, string] = ['lxc.mount.entry', '/dev/dri/renderD128 dev/dri/renderD128 none bind,optional,create=file']

test('a raw-line change rewrites the whole file: compare-and-swap, byte-for-byte read back, parsed by the API, history keeps the old file', async () => {
  const s = rawSetup()
  const p = await s.service.preview(OWNER, CT, { kind: 'raw', raw: { add: [ADD] } })
  assert.deepEqual(p.plan.errors, [])
  assert.ok(p.file && p.file.sha.length === 64)
  const r = await s.service.apply(OWNER, p.id, { name: 'web' })
  assert.equal(r.ok, true, JSON.stringify(r.outcome?.problems))
  const file = s.shell.files['901']
  assert.ok(file.includes('lxc.mount.entry: /dev/dri/renderD128 dev/dri/renderD128 none bind,optional,create=file\n\n[before-change]'))
  assert.ok(file.endsWith('[before-change]\ncores: 1\nlxc.cgroup2.devices.allow: c 10:200 rwm\nsnaptime: 1700000000\n'), 'snapshot section untouched')
  assert.deepEqual(s.pve.g('lxc', 901).config.lxc, [['lxc.cgroup2.devices.allow', 'c 10:200 rwm'], ADD])
  const writes = s.shell.commands.filter(c => c.command.includes('HPX-CAS-MISMATCH'))
  assert.equal(writes.length, 1)
  assert.ok(!/>>|sed -i/.test(writes[0].command))
  const h = (await s.history.list('lxc/901'))[0]
  assert.equal(typeof (h.meta as any).fileBefore, 'string')
  assert.ok(!(h.meta as any).fileBefore.includes('renderD128') && (h.meta as any).fileAfter.includes('renderD128'))
  // one-click revert takes the same path back
  const rv = await s.service.preview(OWNER, CT, { kind: 'revert', historyId: h.id, which: 'before' })
  assert.deepEqual(rv.plan.errors, [])
  assert.ok(rv.file)
  assert.equal((await s.service.apply(OWNER, rv.id, { name: 'web' })).ok, true)
  assert.deepEqual(s.pve.g('lxc', 901).config.lxc, [['lxc.cgroup2.devices.allow', 'c 10:200 rwm']])
})

test('the file changed on the node since the preview: refused, nothing written', async () => {
  const s = rawSetup()
  const p = await s.service.preview(OWNER, CT, { kind: 'raw', raw: { add: [ADD] } })
  s.shell.files['901'] += '# edited by hand\n'
  await refusal(s.service.apply(OWNER, p.id, { name: 'web' }), 'changed')
  assert.ok(!s.shell.commands.some(c => c.command.includes('HPX-CAS-MISMATCH')))
})

test('the file changes between the check and the write: the node script refuses (compare and swap)', async () => {
  const s = rawSetup()
  const p = await s.service.preview(OWNER, CT, { kind: 'raw', raw: { add: [ADD] } })
  s.shell.beforeWrite = v => { s.shell.files[v] += '# raced\n' }
  await refusal(s.service.apply(OWNER, p.id, { name: 'web' }), 'changed')
  assert.ok(s.shell.files['901'].endsWith('# raced\n'), 'the racing edit stands')
})

test('a [pve:pending] section, no quorum, or no node login refuses a raw-line change', async () => {
  const a = rawSetup(); a.shell.tail['901'] = '\n[pve:pending]\nmemory: 1024\n'
  assert.ok((await a.service.preview(OWNER, CT, { kind: 'raw', raw: { add: [ADD] } })).plan.errors.some(e => /pve:pending/.test(e)))
  const b = rawSetup(); b.pve.quorate = false
  assert.ok((await b.service.preview(OWNER, CT, { kind: 'raw', raw: { add: [ADD] } })).plan.errors.some(e => /not quorate/.test(e)))
  const c = rawSetup(); c.shell.logins.delete('node-a')
  assert.ok((await c.service.preview(OWNER, CT, { kind: 'raw', raw: { add: [ADD] } })).plan.errors.some(e => /node login/.test(e)))
  const d = rawSetup()
  const p = await d.service.preview(OWNER, CT, { kind: 'raw', raw: { add: [ADD] } })
  d.pve.quorate = false
  await refusal(d.service.apply(OWNER, p.id, { name: 'web' }), 'not-quorate')
})

test('on a running container the raw change waits for the next start and the restart verifies the lines and the device', async () => {
  const s = rawSetup({}, { status: 'running', ha: 'started' })
  const p = await s.service.preview(OWNER, CT, { kind: 'raw', raw: { add: [ADD] } })
  assert.ok(p.plan.warnings.some(w => /not changed while it runs/.test(w)))
  const r = await s.service.apply(OWNER, p.id, { name: 'web' })
  assert.equal(r.restartOffered, true)
  s.shell.inside['901'] = ['/dev/dri/renderD128']
  const rs = await s.service.preview(OWNER, CT, { kind: 'restart', after: p.id })
  const rr = await s.service.apply(OWNER, rs.id)
  assert.equal(rr.restart!.via, 'ha')
  assert.equal(rr.restart!.rawSurvived, true)
})

test('revert re-checks shared=1 on every node before putting it back', async () => {
  const s = setup({ mp0: '/mnt/media,mp=/media,shared=1' })
  s.shell.dirs = { 'node-a': { '/mnt/media': 'ceph' }, 'node-b': { '/mnt/media': 'ceph' }, 'node-c': { '/mnt/media': 'ceph' } }
  const rm = await s.service.preview(OWNER, CT, { kind: 'edit', edit: { mounts: { remove: ['mp0'] } } })
  const rr = await s.service.apply(OWNER, rm.id)
  delete s.shell.dirs['node-c']
  const rv = await s.service.preview(OWNER, CT, { kind: 'revert', historyId: rr.historyId!, which: 'before' })
  assert.ok(rv.plan.errors.some(e => /missing on node-c/.test(e)), rv.plan.errors.join())
})

test('a new VM NIC that landed with its MAC is a success', async () => {
  const s = makeService()
  s.pve.add({ node: 'node-a', type: 'qemu', vmid: 921, status: 'stopped', config: { name: 'vm', memory: 1024, net0: 'virtio=BC:24:11:00:09:21,bridge=vmbr0' } })
  const orig = s.pve.put.bind(s.pve)
  s.pve.put = async (path, params) => { if (params.net1) params = { ...params, net1: params.net1.replace(/^virtio,/, 'virtio=BC:24:11:00:00:09,') }; return orig(path, params) }
  const p = await s.service.preview(OWNER, { node: 'node-a', type: 'qemu', vmid: 921 }, { kind: 'edit', edit: { net: { net1: { bridge: 'vmbr1' } } } })
  const r = await s.service.apply(OWNER, p.id)
  assert.equal(r.ok, true, JSON.stringify(r.outcome?.problems))
})

test('DNS servers must be real IPv4 or IPv6 addresses', async () => {
  const s = setup()
  assert.ok((await s.service.preview(OWNER, CT, { kind: 'edit', edit: { nameserver: 'dead beef' } })).plan.errors.some(e => /IPv4 or IPv6/.test(e)))
  assert.deepEqual((await s.service.preview(OWNER, CT, { kind: 'edit', edit: { nameserver: '192.0.2.53 2001:db8::53' } })).plan.errors, [])
})

test('history keeps the last 50 versions plus everything from the last 90 days', async () => {
  const { prunable } = await import('../src/lib/guest-config/history/store')
  const day = 86_400_000, now = 1000 * day
  const rows = Array.from({ length: 80 }, (_, i) => ({ id: `r${i}`, createdAt: new Date(now - i * 3 * day) }))   // newest first
  const drop = prunable(rows, now)
  assert.ok(drop.every(id => Number(id.slice(1)) >= 50), 'the newest 50 always stay')
  assert.ok(drop.every(id => Number(id.slice(1)) * 3 > 90), 'nothing from the last 90 days goes')
  assert.equal(drop.length, 80 - 50)
})

// ── round 2: the writer ────────────────────────────────────────────────────────

test('revert never touches a raw line it is not reverting: an unchanged secret-bearing line stays as it is', async () => {
  const s = rawSetup({ lxc: [['lxc.cgroup2.devices.allow', 'c 10:200 rwm'], ['lxc.environment', 'TOKEN=real-secret-value']] })
  const p = await s.service.preview(OWNER, CT, { kind: 'raw', raw: { add: [ADD] } })
  const r = await s.service.apply(OWNER, p.id, { name: 'web' })
  assert.equal(r.ok, true, JSON.stringify(r.outcome?.problems))
  const rv = await s.service.preview(OWNER, CT, { kind: 'revert', historyId: r.historyId!, which: 'before' })
  assert.deepEqual(rv.plan.errors, [])
  assert.deepEqual(rv.plan.rawFile, { remove: [ADD], add: [] }, 'only the line being reverted')
  assert.ok(!rv.file!.after.includes('**redacted**'))
  assert.ok(rv.file!.after.includes('lxc.environment: TOKEN=real-secret-value'))
  assert.equal((await s.service.apply(OWNER, rv.id, { name: 'web' })).ok, true)
  assert.deepEqual(s.pve.g('lxc', 901).config.lxc, [['lxc.cgroup2.devices.allow', 'c 10:200 rwm'], ['lxc.environment', 'TOKEN=real-secret-value']])
})

test('history keeps HMACs of raw lines, never a plain hash of the unredacted file', async () => {
  const s = rawSetup()
  const p = await s.service.preview(OWNER, CT, { kind: 'raw', raw: { add: [ADD] } })
  await s.service.apply(OWNER, p.id, { name: 'web' })
  const h = (await s.history.list('lxc/901'))[0]
  const meta = h.meta as any
  assert.equal(meta.fileSha, undefined)
  assert.ok(!JSON.stringify(h).includes(p.file!.sha), 'the compare-and-swap hash lives only in the preview')
  assert.equal(meta.rawHmac.before.length, 1); assert.equal(meta.rawHmac.after.length, 2)
})

test('a hook line is shown and refused; only device lines are written', async () => {
  const s = rawSetup()
  const p = await s.service.preview(OWNER, CT, { kind: 'raw', raw: { add: [['lxc.hook.start-host', '/bin/sh -c id']] } })
  assert.ok(p.plan.changes.some(c => /lxc.hook.start-host/.test(c.words)))
  assert.ok(p.plan.errors.some(e => /hooks and other raw settings run as root on the node/.test(e)))
  assert.equal(p.file, undefined)
})

test('a guest with a lock: key, or the config lock held too long, writes nothing', async () => {
  const s = rawSetup({ lock: 'backup' })
  const p = await s.service.preview(OWNER, CT, { kind: 'raw', raw: { add: [ADD] } })
  assert.ok(p.plan.errors.some(e => /locked \(backup\)/.test(e)))
  const t = rawSetup()
  const q = await t.service.preview(OWNER, CT, { kind: 'raw', raw: { add: [ADD] } })
  t.shell.beforeWrite = () => { /* a backup starts after the hash check */ }
  const orig = t.shell.run.bind(t.shell)
  t.shell.run = async (n, c) => c.includes('# HPX write config file') ? { code: 4, output: 'HPX-LOCK-TIMEOUT\n' } : orig(n, c)
  await refusal(t.service.apply(OWNER, q.id, { name: 'web' }), 'refused')
})

test('the session drops after the rename: a fresh read showing the planned file is a success, not "write failed"', async () => {
  const s = rawSetup()
  const p = await s.service.preview(OWNER, CT, { kind: 'raw', raw: { add: [ADD] } })
  s.shell.dropAfterWrite = true
  const r = await s.service.apply(OWNER, p.id, { name: 'web' })
  assert.equal(r.ok, true, JSON.stringify(r.outcome?.problems))
  assert.ok((await s.history.list('lxc/901'))[0].outcome === 'ok')
})

test('temp files an earlier run left behind are reported at the next preview and removed', async () => {
  const s = rawSetup()
  s.shell.leftovers['901'] = ['/etc/pve/nodes/node-a/lxc/901.conf.tmp.hpx.4242']
  const p = await s.service.preview(OWNER, CT, { kind: 'raw', raw: { add: [ADD] } })
  assert.ok(p.plan.warnings.some(w => /901\.conf\.tmp\.hpx\.4242.*were removed/.test(w)), p.plan.warnings.join('\n'))
  assert.deepEqual(s.shell.removed, ['/etc/pve/nodes/node-a/lxc/901.conf.tmp.hpx.4242'])
  assert.ok(s.audits.some(a => a.action === 'guest_config.clean_temp'))
})

test('CRLF config files, "key = value" lines and dashed keys survive a write and read back through PVE’s grammar', async () => {
  const s = setup()
  s.shell.probes['node-a'] = FIX('probe-igpu.txt')
  s.shell.files['901'] = 'arch: amd64\r\nhostname: web\r\nlxc.hook.pre-start: /var/lib/vz/snippets/h.sh\r\nlxc.cgroup2.devices.allow = c 10:200 rwm\r\nmemory: 512\r\n'
  s.pve.g('lxc', 901).config.lxc = [['lxc.hook.pre-start', '/var/lib/vz/snippets/h.sh'], ['lxc.cgroup2.devices.allow', 'c 10:200 rwm']]
  const p = await s.service.preview(OWNER, CT, { kind: 'raw', raw: { add: [ADD], remove: [['lxc.cgroup2.devices.allow', 'c 10:200 rwm']] } })
  assert.deepEqual(p.plan.errors, [])
  const r = await s.service.apply(OWNER, p.id, { name: 'web' })
  assert.equal(r.ok, true, JSON.stringify(r.outcome?.problems))
  assert.equal(s.shell.files['901'], `arch: amd64\r\nhostname: web\r\nlxc.hook.pre-start: /var/lib/vz/snippets/h.sh\r\nmemory: 512\r\n${ADD[0]}: ${ADD[1]}\r\n`)
  assert.deepEqual(s.pve.g('lxc', 901).config.lxc, [['lxc.hook.pre-start', '/var/lib/vz/snippets/h.sh'], ADD])
})

test('retention never drops the open GPU-off row or the rows that record managed entries; the toggle state has its own store', async () => {
  const { prunable, pinned } = await import('../src/lib/guest-config/history/store')
  const day = 86_400_000, now = 1000 * day
  const rows = Array.from({ length: 80 }, (_, i) => ({ id: `r${i}`, createdAt: new Date(now - i * 3 * day), meta: i === 70 ? { gpuOff: { removed: {} } } : i === 75 ? { gpuManaged: { dev0: '/dev/dri/renderD128' } } : null }))
  const drop = prunable(rows, now)
  assert.ok(!drop.includes('r70') && !drop.includes('r75'))
  assert.ok(pinned({ meta: { gpuManagedRaw: [] } }))
  // The toggle comes from the GPU state store, however many other rows there are.
  const s = makeService()
  s.shell.probes['node-b'] = FIX('probe-igpu.txt')
  s.pve.add({ node: 'node-b', type: 'lxc', vmid: 941, status: 'stopped', config: smallCt({ hostname: 'tv' }) })
  const G = { node: 'node-b', type: 'lxc' as const, vmid: 941 }
  const gpu = (await s.service.inventory('node-b')).devices.find(d => d.kind === 'gpu')!
  await s.service.apply(OWNER, (await s.service.preview(OWNER, G, { kind: 'gpu-grant', grant: { deviceId: gpu.id, renderGid: 993 } })).id, { name: 'tv' })
  await s.service.apply(OWNER, (await s.service.preview(OWNER, G, { kind: 'gpu-off' })).id, { name: 'tv' })
  for (let i = 0; i < 60; i++) await s.service.apply(OWNER, (await s.service.preview(OWNER, G, { kind: 'edit', edit: { memory: 600 + i } })).id)
  assert.equal((await s.service.view(G)).gpu.toggle, 'off')
  assert.equal((await s.service.overview()).find(r => r.vmid === 941)!.gpu.toggle, 'off')
  const on = await s.service.preview(OWNER, G, { kind: 'gpu-on' })
  assert.deepEqual(on.plan.errors, [])
})

test('round 3: an added line must name an inventory character device on the node; symlinks, host memory and every-device allows are refused', async () => {
  const s = rawSetup()
  for (const [line, re] of [
    [['lxc.mount.entry', '/dev/mem dev/mem none bind,create=file'], /host memory/],
    [['lxc.mount.entry', '/dev/. dev/. none bind,create=dir'], /“\.”/],
    [['lxc.mount.entry', '/dev/fd dev/fd none bind,create=dir'], /not a device/],
    [['lxc.mount.entry', '/dev/nvidia0 dev/nvidia0 none bind,create=file'], /not in the node’s device inventory/],
    [['lxc.cgroup2.devices.allow', 'c *:* rwm'], /every device/],
    [['lxc.cgroup2.devices.allow', 'c 195:* rwm'], /only for GPU majors/],
    [['lxc.cgroup2.devices.allow', 'c 10:* rwm'], /only for GPU majors/],
    [['lxc.cgroup2.devices.allow', 'c 10:232 rwm'], /not an inventory device/],
    [['lxc.mount.entry', '/dev/uinput dev/uinput none bind,optional,create=file'], /not in the node’s device inventory/],
    [['lxc.mount.entry', '/dev/fuse dev/fuse none bind,optional,create=file'], /not in the node’s device inventory/],
    [['lxc.mount.entry', '/dev/dri/renderD128 dev/dri/renderD128 none bind,optional,create=file,mode=0666'], /mode=, uid= and gid=/],
  ] as Array<[[string, string], RegExp]>) {
    const p = await s.service.preview(OWNER, CT, { kind: 'raw', raw: { add: [line] } })
    assert.ok(p.plan.errors.some(e => re.test(e)), `${line[1]} → ${p.plan.errors.join(' | ')}`)
  }
  s.shell.symlinks['node-a'] = ['/dev/dri/renderD128']
  const sym = await s.service.preview(OWNER, CT, { kind: 'raw', raw: { add: [ADD] } })
  assert.ok(sym.plan.errors.some(e => /symlink/.test(e)), sym.plan.errors.join(' | '))
})

test('round 3: the node re-checks added devices at write time; a device that became a symlink stops the write', async () => {
  const s = rawSetup()
  const p = await s.service.preview(OWNER, CT, { kind: 'raw', raw: { add: [ADD] } })
  assert.deepEqual(p.plan.errors, [])
  assert.deepEqual(p.file!.sources, [{ path: '/dev/dri/renderD128', expect: 'e2:80' }])
  s.shell.symlinks['node-a'] = ['/dev/dri/renderD128']
  await refusal(s.service.apply(OWNER, p.id, { name: 'web' }), 'refused')
})

test('round 3: a pending section that appears on the node at the last moment is refused by the script', async () => {
  const s = rawSetup()
  const p = await s.service.preview(OWNER, CT, { kind: 'raw', raw: { add: [ADD] } })
  s.shell.beforeWrite = v => { s.shell.files[v] = s.shell.files[v] }   // same bytes, so the CAS passes…
  const orig = s.shell.run.bind(s.shell)
  s.shell.run = async (n, c) => c.includes('# HPX write config file') ? { code: 7, output: 'HPX-PENDING\n' } : orig(n, c)
  await refusal(s.service.apply(OWNER, p.id, { name: 'web' }), 'changed')
})

test('round 3: the re-read after a dropped session takes the config lock', async () => {
  const s = rawSetup()
  const p = await s.service.preview(OWNER, CT, { kind: 'raw', raw: { add: [ADD] } })
  s.shell.dropAfterWrite = true
  await s.service.apply(OWNER, p.id, { name: 'web' })
  const reads = s.shell.commands.filter(c => c.command.includes('# HPX read config file'))
  assert.ok(reads.at(-1)!.command.includes('flock -w'))
})

test('round 3: a GPU off whose devN step fails still records the raw lines it removed, so GPU on can restore them', async () => {
  const s = makeService()
  s.shell.probes['node-a'] = FIX('probe-nvidia.txt')
  s.pve.add({ node: 'node-a', type: 'lxc', vmid: 911, status: 'stopped', config: { ...JSON.parse(FIX('ct-nvidia.json')), dev0: '/dev/nvidia0' } })
  const G = { node: 'node-a', type: 'lxc' as const, vmid: 911 }
  const raw = ['lxc.cgroup2.devices.allow', 'c 510:* rwm']
  const p = await s.service.preview(OWNER, G, { kind: 'gpu-off', off: { alsoRemove: [{ key: raw[0], value: raw[1] }, { key: 'dev0', value: '/dev/nvidia0' }] } })
  assert.deepEqual(p.plan.errors, [])
  const orig = s.pve.put.bind(s.pve)
  s.pve.put = async (path, params) => { if (params.delete) throw new Error('Proxmox PUT: HTTP 500 — boom'); return orig(path, params) }
  const r = await s.service.apply(OWNER, p.id, { name: 'coder' })
  assert.equal(r.ok, false)
  s.pve.put = orig
  const st = await s.service.gpuState(G, s.pve.view(s.pve.g('lxc', 911)))
  assert.deepEqual(st.off?.rawRemoved, [raw])
  const on = await s.service.preview(OWNER, G, { kind: 'gpu-on' })
  assert.deepEqual(on.plan.errors, [])
  assert.deepEqual(on.plan.rawFile?.add, [raw])
})

test('round 4: GPU state is keyed by a hidden HyperProx marker in the description, written with the first GPU change and kept by every edit', async () => {
  const { markerOf } = await import('../src/lib/guest-config/service')
  const s = makeService()
  s.shell.probes['node-b'] = FIX('probe-igpu.txt')
  s.pve.add({ node: 'node-b', type: 'lxc', vmid: 941, status: 'stopped', config: smallCt({ hostname: 'tv', description: 'Media box' }) })
  const G = { node: 'node-b', type: 'lxc' as const, vmid: 941 }
  const gpu = (await s.service.inventory('node-b')).devices.find(d => d.kind === 'gpu')!
  const p = await s.service.preview(OWNER, G, { kind: 'gpu-grant', grant: { deviceId: gpu.id, renderGid: 993 } })
  assert.deepEqual(p.plan.errors, [])
  assert.ok(p.plan.checks.some(c => /hidden HyperProx marker/.test(c)))
  assert.equal((await s.service.apply(OWNER, p.id, { name: 'tv' })).ok, true)
  const id = markerOf(s.pve.g('lxc', 941).config)
  assert.match(id ?? '', /^[0-9a-f-]{36}$/)
  assert.ok(String(s.pve.g('lxc', 941).config.description).startsWith('Media box'))
  // The editor never shows it, and an edit of the description keeps it.
  const v = await s.service.view(G)
  assert.equal(v.config.description, 'Media box')
  await s.service.apply(OWNER, (await s.service.preview(OWNER, G, { kind: 'edit', edit: { description: 'Living-room media box' } })).id)
  assert.equal(markerOf(s.pve.g('lxc', 941).config), id)
  assert.deepEqual(Object.values((await s.service.view(G)).gpu.managed), ['/dev/dri/renderD128,gid=993'])
  // A new guest reusing the VMID has no marker, so no inherited state.
  s.pve.g('lxc', 941).config = smallCt({ hostname: 'tv' })
  assert.deepEqual((await s.service.view(G)).gpu.managed, {})
})

test('round 4: state under an old key is adopted once by the marked guest, then the old key is gone', async () => {
  const { MemoryHistoryStore, emptyGpuState } = await import('../src/lib/guest-config/history/store')
  const h = new MemoryHistoryStore()
  await h.setGpu({ ...emptyGpuState('lxc/941/0123456789abcdef'), dev: { dev0: '/dev/dri/renderD128' } })
  const key = 'lxc/941/11111111-2222-3333-4444-555555555555'
  assert.equal(await h.adoptLegacyGpu('lxc', 941, key), true)
  assert.deepEqual((await h.getGpu(key)).dev, { dev0: '/dev/dri/renderD128' })
  assert.equal(await h.adoptLegacyGpu('lxc', 941, key), false, 'once')
  assert.deepEqual((await h.listGpu()).map(x => x.guest), [key])
})

test('round 4: a GPU off whose partial record cannot be stored stops before the devN step and says so', async () => {
  const s = makeService()
  s.shell.probes['node-a'] = FIX('probe-nvidia.txt')
  s.pve.add({ node: 'node-a', type: 'lxc', vmid: 911, status: 'stopped', config: { ...JSON.parse(FIX('ct-nvidia.json')), dev0: '/dev/nvidia0' } })
  const G = { node: 'node-a', type: 'lxc' as const, vmid: 911 }
  const p = await s.service.preview(OWNER, G, { kind: 'gpu-off', off: { alsoRemove: [{ key: 'lxc.cgroup2.devices.allow', value: 'c 510:* rwm' }, { key: 'dev0', value: '/dev/nvidia0' }] } })
  assert.deepEqual(p.plan.errors, [])
  s.history.updateGpu = async () => { throw new Error('database unavailable') }
  const r = await s.service.apply(OWNER, p.id, { name: 'coder' })
  assert.equal(r.ok, false)
  assert.ok(r.outcome!.problems.some(x => /could not be recorded \(database unavailable\)/.test(x)), JSON.stringify(r.outcome!.problems))
  assert.equal(s.pve.g('lxc', 911).config.dev0, '/dev/nvidia0', 'the devN step did not run')
})

test('round 4: Portable GPU tells HA which GPU each node would give the guest', async () => {
  const s = makeService()
  s.shell.probes['node-a'] = FIX('probe-nvidia.txt'); s.shell.probes['node-b'] = FIX('probe-igpu.txt'); s.shell.probes['node-c'] = FIX('probe-homelab.txt')
  s.pve.add({ node: 'node-b', type: 'lxc', vmid: 961, status: 'running', ha: 'started', config: smallCt({ hostname: 'media', lxc: [
    ['lxc.cgroup2.devices.allow', 'c 226:* rwm'], ['lxc.cgroup2.devices.allow', 'c 195:* rwm'],
    ['lxc.mount.entry', '/dev/dri/renderD128 dev/dri/renderD128 none bind,optional,create=file'],
    ['lxc.mount.entry', '/dev/nvidia0 dev/nvidia0 none bind,optional,create=file'],
  ] }) })
  s.pve.add({ node: 'node-a', type: 'lxc', vmid: 911, status: 'running', ha: 'started', config: JSON.parse(FIX('ct-nvidia.json')) })
  await s.service.refreshPortability()
  const p = s.service.portabilityOf('ct:961') as any
  assert.equal(p.portable, true)
  assert.equal(p.perNode['node-a'], 'NVIDIA GeForce GTX 1070 Ti')
  assert.equal(p.perNode['node-b'], 'Intel HD Graphics 630')
  assert.deepEqual(s.service.portabilityOf('ct:911'), { portable: false }, 'hand-written non-optional lines are not portable')
  const { gpuPortability, setGpuPortability } = await import('../src/lib/ha/gpu')
  setGpuPortability(g => s.service.portabilityOf(g.sid))
  try { assert.equal((gpuPortability({ sid: 'ct:961' } as any) as any).perNode['node-b'], 'Intel HD Graphics 630') } finally { setGpuPortability(null) }
})

test('round 3: the HMAC key is loaded once for concurrent first uses, and forgotten on lock', async () => {
  let loads = 0
  const { GuestConfigService } = await import('../src/lib/guest-config/service')
  const { MemoryHistoryStore } = await import('../src/lib/guest-config/history/store')
  const s2 = new GuestConfigService({ pve: {} as any, shell: {} as any, history: new MemoryHistoryStore(), audit: async () => {}, hmacKey: async () => { loads++; await new Promise(r => setTimeout(r, 10)); return Buffer.alloc(32, 1) } })
  await Promise.all([1, 2, 3].map(() => (s2 as any).hmacs([['lxc.mount.entry', 'x']])))
  assert.equal(loads, 1)
  s2.forgetKeys()
  await (s2 as any).hmacs([['lxc.mount.entry', 'x']])
  assert.equal(loads, 2)
})
