// Guest config routes: roles, re-confirmation, the VPN slot, and no secret value anywhere it should not be.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { buildGuestConfigRoutes } from '../src/routes/guest-config'
import { PrismaHistoryStore } from '../src/lib/guest-config/history/store'
import { vpnStatuses, notAvailableVpn, type VpnStatusSource } from '../src/lib/guest-config/vpn'
import { makeService, smallCt, OWNER, FIX } from './fakes/guest-pve'

test('roles: reads are viewer, previews admin, apply and reveal admin with the master password', () => {
  const base = '/api/infra/guest-config'
  assert.equal(requiredRole('GET', `${base}/overview`), 'viewer')
  assert.equal(requiredRole('GET', `${base}/nodes/node-a/devices`), 'viewer')
  assert.equal(requiredRole('GET', `${base}/guests/node-a/lxc/901`), 'viewer')
  assert.equal(requiredRole('POST', `${base}/preview`), 'admin')
  assert.equal(requiredRole('POST', `${base}/apply`), 'admin')
  assert.equal(needsReconfirm('POST', `${base}/apply`), true)
  assert.equal(needsReconfirm('POST', `${base}/guests/node-a/qemu/921/reveal`), true)
  assert.equal(needsReconfirm('POST', `${base}/preview`), false)
})

test('viewers: no raw paths or PCI addresses anywhere, never a node command, no refresh; unknown nodes are refused', async () => {
  const s = makeService()
  s.shell.probes['node-a'] = FIX('probe-nvidia.txt')
  s.pve.add({ node: 'node-a', type: 'lxc', vmid: 911, status: 'running', config: JSON.parse(FIX('ct-nvidia.json')) })
  const a = Fastify()
  a.register(buildGuestConfigRoutes(() => ({ service: s.service, whoami: () => 'viewer@example.com', isAdmin: () => false })))
  const before = s.shell.commands.length
  const bodies = [
    (await a.inject({ method: 'GET', url: '/guests/node-a/lxc/911' })).body,
    (await a.inject({ method: 'GET', url: '/guests/node-a/lxc/911/gpu' })).body,
    (await a.inject({ method: 'GET', url: '/nodes/node-a/devices' })).body,
  ]
  assert.equal(s.shell.commands.length, before, 'a viewer never makes HyperProx log in to a node')
  for (const b of bodies) assert.ok(!/\/dev\/nvidia|0000:42:00|lxc\.mount\.entry: \//.test(b), b.slice(0, 300))
  assert.equal((await a.inject({ method: 'GET', url: '/nodes/node-a/devices?refresh=1' })).statusCode, 403)
  assert.equal((await a.inject({ method: 'GET', url: '/nodes/no-such-node/devices' })).statusCode, 404)
  const admin = Fastify()
  admin.register(buildGuestConfigRoutes(() => ({ service: s.service, whoami: () => OWNER, isAdmin: () => true })))
  assert.equal((await admin.inject({ method: 'GET', url: '/nodes/node-a/devices?refresh=1' })).statusCode, 200)
  assert.equal((await admin.inject({ method: 'GET', url: '/nodes/node-a/devices?refresh=1' })).statusCode, 429, 'rate-limited')
})

test('a VM cloud-init password is not pretended to be revealed', async () => {
  const s = makeService()
  s.pve.add({ node: 'node-a', type: 'qemu', vmid: 921, status: 'stopped', config: { name: 'vm', cipassword: '**********' } })
  await assert.rejects(s.service.reveal(OWNER, { node: 'node-a', type: 'qemu', vmid: 921 }, 'cipassword'), /never returns a VM’s cloud-init password/)
})

async function app(admin = true, owner = OWNER) {
  const s = makeService()
  s.pve.add({ node: 'node-a', type: 'lxc', vmid: 901, status: 'stopped', config: smallCt() })
  const a = Fastify()
  a.register(buildGuestConfigRoutes(() => ({ service: s.service, whoami: () => owner, isAdmin: () => admin })))
  await a.ready()
  return { a, ...s }
}

test('preview then apply over HTTP; the browser gets the plan in words, never the stored config', async () => {
  const { a, pve } = await app()
  const pv = await a.inject({ method: 'POST', url: '/preview', payload: { node: 'node-a', type: 'lxc', vmid: 901, change: { kind: 'edit', edit: { cores: 2 } } } })
  assert.equal(pv.statusCode, 200, pv.body)
  const d = pv.json().data
  assert.equal(d.changes[0].words, 'CPU cores: 1 → 2')
  assert.ok(!('before' in d) && !('plan' in d))
  const ap = await a.inject({ method: 'POST', url: '/apply', payload: { previewId: d.previewId } })
  assert.equal(ap.statusCode, 200, ap.body)
  assert.equal(pve.g('lxc', 901).config.cores, 2)
  const again = await a.inject({ method: 'POST', url: '/apply', payload: { previewId: d.previewId } })
  assert.equal(again.statusCode, 409)
})

test('a locked HyperProx says so and does nothing', async () => {
  const s = makeService()
  s.pve.get = async () => { throw new Error('Proxmox is not configured, or HyperProx is locked (sign in to unlock)') }
  const a = Fastify()
  a.register(buildGuestConfigRoutes(() => ({ service: s.service, whoami: () => OWNER, isAdmin: () => true })))
  const r = await a.inject({ method: 'GET', url: '/guests/node-a/lxc/901' })
  assert.equal(r.statusCode, 423)
  assert.match(r.json().error, /HyperProx is locked — sign in/)
})

test('the VPN slot: the stub says not available for every guest; a source that throws reads as unknown, never blank', async () => {
  const g = [{ node: 'node-a', type: 'lxc' as const, vmid: 901, name: 'web' }]
  assert.equal((await vpnStatuses(g, notAvailableVpn)).get('lxc/901')!.state, 'not-available')
  const broken: VpnStatusSource = { name: 'Mesh', available: async () => true, statusFor: async () => { throw new Error('down') } }
  assert.equal((await vpnStatuses(g, broken)).get('lxc/901')!.state, 'unknown')
  const partial: VpnStatusSource = { name: 'Mesh', available: async () => true, statusFor: async () => new Map() }
  assert.equal((await vpnStatuses(g, partial)).get('lxc/901')!.state, 'none')
  const { a } = await app()
  const ov = await a.inject({ method: 'GET', url: '/overview' })
  assert.equal(ov.json().data[0].vpn.state, 'not-available')
})

test('planted marker: a secret in a guest config never reaches history (memory or Postgres), the stored file, the audit log, a view or a preview', async () => {
  const MARKER = 'PLANTED-SECRET-7f3e9c'
  const s = makeService()
  s.pve.add({ node: 'node-a', type: 'qemu', vmid: 921, status: 'stopped', config: { name: 'vm', memory: 1024, cores: 1, cipassword: MARKER, sshkeys: `ssh-ed25519%20${MARKER}`, ipconfig0: 'ip=dhcp', description: `db password=${MARKER}` } })
  s.pve.add({ node: 'node-a', type: 'lxc', vmid: 901, status: 'stopped', config: smallCt({ env: `DB_PASSWORD=${MARKER}\u0000TZ=UTC`, lxc: [['lxc.cgroup2.devices.allow', 'c 10:200 rwm'], ['lxc.environment', `API_TOKEN=${MARKER}`]] }) })
  const G = { node: 'node-a', type: 'qemu' as const, vmid: 921 }
  const C = { node: 'node-a', type: 'lxc' as const, vmid: 901 }
  const logs: string[] = []
  const origLog = console.log, origErr = console.error, origWarn = console.warn
  console.log = (...x: any[]) => logs.push(x.join(' ')); console.error = console.log; console.warn = console.log
  try {
    const p = await s.service.preview(OWNER, G, { kind: 'edit', edit: { cores: 2 } })
    const r = await s.service.apply(OWNER, p.id)
    assert.equal(r.ok, true, JSON.stringify(r.outcome?.problems))
    const view = await s.service.view(G)
    assert.equal(view.config.cipassword, 'set')
    // The container: an edit, then a raw-line change through the whole-file writer (its file goes into history).
    const c1 = await s.service.preview(OWNER, C, { kind: 'edit', edit: { cores: 2 } })
    assert.equal((await s.service.apply(OWNER, c1.id)).ok, true)
    const c2 = await s.service.preview(OWNER, C, { kind: 'raw', raw: { add: [['lxc.mount.entry', '/dev/net/tun dev/net/tun none bind,optional,create=file']] } })
    const c2r = await s.service.apply(OWNER, c2.id, { name: 'web' })
    assert.equal(c2r.ok, true, JSON.stringify(c2r.outcome?.problems))
    const fileRow = (await s.history.list('lxc/901'))[0]
    assert.ok(typeof (fileRow.meta as any).fileBefore === 'string' && (fileRow.meta as any).fileBefore.includes('API_TOKEN=**redacted**'))
    const a = Fastify()
    a.register(buildGuestConfigRoutes(() => ({ service: s.service, whoami: () => OWNER, isAdmin: () => true })))
    const http = [
      (await a.inject({ method: 'GET', url: '/guests/node-a/qemu/921' })).body,
      (await a.inject({ method: 'GET', url: '/guests/node-a/qemu/921/history' })).body,
      (await a.inject({ method: 'GET', url: '/guests/node-a/lxc/901' })).body,
      (await a.inject({ method: 'GET', url: '/guests/node-a/lxc/901/history' })).body,
      (await a.inject({ method: 'POST', url: '/preview', payload: { ...G, change: { kind: 'edit', edit: { cores: 3 } } } })).body,
      (await a.inject({ method: 'POST', url: '/preview', payload: { ...C, change: { kind: 'raw', raw: { add: [['lxc.environment', `X_SECRET=${MARKER}`]] } } } })).body,
    ]
    const rv = await s.service.preview(OWNER, G, { kind: 'revert', historyId: r.historyId!, which: 'before' })
    // The Postgres store, through a fake client that records exactly what would be written.
    const written: any[] = []
    const pg = new PrismaHistoryStore({ guestConfigVersion: { create: async (q: any) => { written.push(q.data); return { ...q.data, id: 'x', createdAt: new Date() } } } } as any)
    await pg.add({ ...(await s.history.list('qemu/921'))[0], before: s.pve.view(s.pve.g('qemu', 921)) })
    await pg.add({ ...fileRow, before: s.pve.view(s.pve.g('lxc', 901)), meta: { fileBefore: `lxc.environment: API_TOKEN=${MARKER}\n` } })
    const everything = JSON.stringify([s.history.rows, s.audits, view, http, written, logs, rv.plan.changes, rv.plan.warnings, r])
    assert.ok(!everything.includes(MARKER), 'the planted secret leaked')
    assert.ok(JSON.stringify(written).includes('**redacted**'))
    assert.ok(!JSON.stringify(s.audits).includes(MARKER), 'audited without values')
  } finally { console.log = origLog; console.error = origErr; console.warn = origWarn }
})

test('viewers: history and pending rows carry no device paths or raw lines', async () => {
  const s = makeService()
  s.shell.probes['node-b'] = FIX('probe-igpu.txt')
  s.pve.add({ node: 'node-b', type: 'lxc', vmid: 941, status: 'running', config: smallCt({ hostname: 'tv' }) })
  const G = { node: 'node-b', type: 'lxc' as const, vmid: 941 }
  const gpu = (await s.service.inventory('node-b')).devices.find(d => d.kind === 'gpu')!
  await s.service.apply(OWNER, (await s.service.preview(OWNER, G, { kind: 'gpu-grant', grant: { deviceId: gpu.id, renderGid: 993 } })).id, { name: 'tv' })
  const a = Fastify()
  a.register(buildGuestConfigRoutes(() => ({ service: s.service, whoami: () => 'viewer@example.com', isAdmin: () => false })))
  const hist = (await a.inject({ method: 'GET', url: '/guests/node-b/lxc/941/history' })).body
  const view = (await a.inject({ method: 'GET', url: '/guests/node-b/lxc/941' })).body
  for (const b of [hist, view]) assert.ok(!/\/dev\/dri|renderD128|lxc\.cgroup|10:200/.test(b), b.slice(0, 400))
  assert.match(hist, /Device entry dev0 changed \(shown to admins\)/)
  assert.ok(JSON.parse(view).data.pending.rows.some((r: any) => r.key === 'dev0' && r.pending === 'set'))
})
