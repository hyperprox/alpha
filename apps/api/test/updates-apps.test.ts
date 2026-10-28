// App updates as the third kind of update: the provider registry and the context a provider is handed,
// the policy keys, inventory rows, the planner (approval, auto/manual/off, blocking pre-flight, config
// fixes) and the runner (order with snapshot and apt, dry run, failure and rollback) — against the
// pretend cluster and a pretend provider. Every name and id is generic.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AppContext, AppInstall, AppIssue, AppUpdateProvider, Plugin } from '../src/lib/plugin-host'
import { appUpdateProviders, pluginOptions } from '../src/lib/plugin-host'
import { APPROVAL_ID, type AppEnv, appContext, fixApprovalId, parseAppDetail, readGuestApps, updateApprovalId } from '../src/lib/updates/apps'
import { parsePolicy, appMode, defaultPolicy } from '../src/lib/updates/policy'
import { buildPlan } from '../src/lib/updates/planner'
import { readInventory } from '../src/lib/updates/inventory'
import { UpdatesRunner } from '../src/lib/updates/runner'
import { MemoryStore } from '../src/lib/updates/store'
import type { UpdatesGuest, UpdatesInventory } from '../src/lib/updates/types'
import { meshcentralPlugin } from '../src/plugins/meshcentral'
import { PLUGINS } from '../src/plugins'
import { FakeCluster, node, guest, policyLoad, FAST } from './updates-fake'

// --- a pretend provider ------------------------------------------------------------------------------

interface DemoState {
  installed: Record<number, string>     // vmid → version installed
  latest: string
  security: boolean
  issues: AppIssue[]
  applyFails?: boolean
  verifyFails?: boolean
  applied: string[]
  fixed: string[]
}

function demoProvider(st: DemoState): AppUpdateProvider {
  const inst = (ctx: AppContext): AppInstall | null => {
    const v = st.installed[ctx.guest.vmid]
    return v ? { key: 'abc123abc123', name: 'Demo', installed: v, location: '/opt/demo', runAs: 'demo', service: 'demo.service', running: true, how: 'npm', facts: {} } : null
  }
  return {
    id: 'demoapp', name: 'Demo',
    async detect(ctx) { await ctx.run('# fake:app-detect'); const i = inst(ctx); return i ? [i] : [] },
    async latest() { return { latest: st.latest, notes: [{ version: st.latest, text: 'notes' }], isSecurity: st.security, ...(st.security ? { securityNote: 'advisory X' } : {}) } },
    async preflight() { return st.issues },
    async apply(i, v, ctx) {
      const r = await ctx.run('# fake:app-apply')
      if (r.code !== 0 || st.applyFails) return { ok: false, message: 'npm install exited 1; demo.service is left STOPPED' }
      st.installed[ctx.guest.vmid] = v; st.applied.push(`${ctx.guest.vmid}@${v}`)
      return { ok: true, message: `installed ${v}` }
    },
    async verify(i, v, ctx) { await ctx.run('# fake:app-verify'); return st.verifyFails ? { ok: false, message: 'control.ashx refused the origin' } : { ok: true, message: 'verified' } },
    async applyFix(i, fixId, ctx) { await ctx.run('# fake:app-fix'); st.fixed.push(fixId); st.issues = []; return { ok: true, message: 'fixed' } },
    rollback(i, snap) { return snap ? `Roll the guest back to snapshot ${snap}.` : 'No snapshot; by hand.' },
  }
}

function env(st: DemoState): AppEnv {
  return {
    providers: [{ pluginId: 'demo', provider: demoProvider(st) }],
    fetchJson: async () => { throw new Error('offline') },
    http: async () => { throw new Error('offline') },
    wsProbe: async () => ({ upgraded: false, status: 0, firstMessage: null }),
    options: async () => ({}),
    proxyHosts: async () => [
      { domains: ['demo.example.com'], forwardHost: '10.0.1.5', forwardPort: 8080, ssl: true, enabled: true },
      { domains: ['other.example.com'], forwardHost: '10.0.1.9', forwardPort: 8080, ssl: true, enabled: true },
    ],
  }
}

const state = (over: Partial<DemoState> = {}): DemoState => ({ installed: { 101: '1.0.0' }, latest: '1.2.0', security: true, issues: [], applied: [], fixed: [], ...over })
const FIX: AppIssue = { message: 'browsers on demo.example.com would be refused', blocking: true, fix: { id: 'f1f1f1f1f1f1', description: 'add demo.example.com to allowedOrigin', file: '/opt/demo/config.json', change: 'allowedOrigin = [...]' } }

// --- registry and context ---------------------------------------------------------------------------

test('providers: the bundled MeshCentral one is registered; duplicate or odd ids are refused', () => {
  const ids = appUpdateProviders(PLUGINS).map(r => `${r.pluginId}/${r.provider.id}`)
  assert.ok(ids.includes('meshcentral/meshcentral'))
  const dup: Plugin = { ...meshcentralPlugin, manifest: { ...meshcentralPlugin.manifest, id: 'copy' } }
  assert.throws(() => appUpdateProviders([meshcentralPlugin, dup]), /two plug-ins declare an app provider "meshcentral"/)
  const odd: Plugin = { ...meshcentralPlugin, appUpdates: [{ ...meshcentralPlugin.appUpdates![0], id: 'Mesh Central' }] }
  assert.throws(() => appUpdateProviders([odd]), /not a plain lowercase id/)
})

test('pluginOptions never hands a provider a secret', () => {
  const manifest = { ...meshcentralPlugin.manifest, settings: [...meshcentralPlugin.manifest.settings, { key: 'token', label: 'Token', type: 'secret' as const, required: false }] }
  assert.deepEqual(pluginOptions(manifest, { public_url: 'https://x.example.com', token: 's3cret', stray: 'y' }), { public_url: 'https://x.example.com' })
})

test('appContext: commands go to the guest it was made for; proxied URLs match its address and port', async () => {
  const fake = new FakeCluster({ nodes: [node('node-a')], guests: [guest(101, 'node-a'), guest(102, 'node-a')] })
  fake.scripted.set('other', script => ({ code: 0, output: /hostname -I/.test(script) ? '10.0.1.5 fd00::5\nguest-101\n' : '', timedOut: false }))
  const ctx = appContext(env(state()), fake, { vmid: 101, type: 'lxc', node: 'node-a', name: 'guest-101' }, { public_url: 'https://a.example.com' }, () => {})
  await ctx.run('# fake:probe')
  assert.deepEqual(fake.calls.filter(c => c.cmd === 'guest:probe').map(c => c.where), ['101'])
  assert.equal(ctx.option('public_url'), 'https://a.example.com')
  assert.deepEqual(await ctx.proxiedUrls([8080]), ['https://demo.example.com/'])
  assert.deepEqual(await ctx.proxiedUrls([443]), [])
})

test('approval ids: the shapes the inventory hands out, and nothing else', () => {
  assert.ok(APPROVAL_ID.test(updateApprovalId(101, 'demoapp', 'abc123abc123', '1.2.0')))
  assert.ok(APPROVAL_ID.test(fixApprovalId(101, 'demoapp', 'abc123abc123', 'f1f1f1f1f1f1')))
  for (const bad of ['app:101:demoapp:abc123abc123@1.2.0;id', 'app:101:Demo:abc123abc123@1.2.0', 'fix:101:demoapp:abc123abc123:zz', '']) assert.equal(APPROVAL_ID.test(bad), false, bad)
  assert.deepEqual(parseAppDetail('demoapp 1.2.0 abc123abc123 — Demo 1.0.0 → 1.2.0'), { provider: 'demoapp', arg: '1.2.0', key: 'abc123abc123' })
  assert.equal(parseAppDetail('demoapp 1.2.0'), null)
})

// --- policy -------------------------------------------------------------------------------------

test('policy: apps default to detected and manual; modes per app; per-guest off; typos fail the load', () => {
  const d = defaultPolicy()
  assert.deepEqual(d.apps, { enabled: true, default: 'manual', providers: {} })
  const p = parsePolicy('apps:\n  enabled: true\n  default: off\n  meshcentral: auto\nguests:\n  "205": { apps: false }\n')
  assert.equal(appMode(p, 'meshcentral'), 'auto')
  assert.equal(appMode(p, 'other'), 'off')
  assert.equal(p.guests['205'].apps, false)
  assert.throws(() => parsePolicy('apps:\n  meshcentral: yes\n'), /apps\.meshcentral: expected auto, manual or off/)
  assert.throws(() => parsePolicy('apps:\n  Mesh_Central: auto\n'), /apps\.Mesh_Central: unknown key/)
  assert.throws(() => parsePolicy('apps:\n  enabled: maybe\n'), /apps\.enabled/)
  assert.throws(() => parsePolicy('guests:\n  "205": { apps: auto }\n'), /guests\.205\.apps/)
})

// --- inventory ----------------------------------------------------------------------------------

function cluster() {
  return new FakeCluster({
    nodes: [node('node-a', { pending: [] })],
    guests: [guest(101, 'node-a'), guest(102, 'node-a', { pending: [] }), guest(150, 'node-a', { pending: [] })],
  })
}

test('inventory: an app row per install, with latest, security, mode, issues and the ids to approve', async () => {
  const st = state({ issues: [FIX] })
  const { inventory } = await readInventory(cluster(), parsePolicy(''), { apps: env(st) })
  const g = inventory.guests.find(x => x.vmid === 101)!
  assert.equal(g.apps?.length, 1)
  const a = g.apps![0]
  assert.deepEqual([a.provider, a.installed, a.latest, a.mode, a.isSecurity, a.securityNote], ['demoapp', '1.0.0', '1.2.0', 'manual', true, 'advisory X'])
  assert.equal(a.approvalId, 'app:101:demoapp:abc123abc123@1.2.0')
  assert.equal(a.issues[0].fix!.id, 'fix:101:demoapp:abc123abc123:f1f1f1f1f1f1')
  assert.match(a.rollback, /snapshot hp-upd-\*/)
  assert.equal(inventory.guests.find(x => x.vmid === 102)!.apps, undefined)
  // Off for one guest, or globally: not even looked for.
  const off = await readInventory(cluster(), parsePolicy('guests:\n  "101": { apps: false }\n'), { apps: env(st) })
  assert.equal(off.inventory.guests.find(x => x.vmid === 101)!.apps, undefined)
  const none = await readInventory(cluster(), parsePolicy('apps:\n  enabled: false\n'), { apps: env(st) })
  assert.equal(none.inventory.guests.find(x => x.vmid === 101)!.apps, undefined)
})

test('inventory: a provider that throws is reported on the guest, not fatal', async () => {
  const e = env(state())
  e.providers[0].provider.detect = async () => { throw new Error('base64: command not found') }
  const { inventory } = await readInventory(cluster(), parsePolicy(''), { apps: e })
  assert.match(inventory.guests.find(x => x.vmid === 101)!.error!, /apps: Demo: base64: command not found/)
})

// --- planner ------------------------------------------------------------------------------------

async function inv(st: DemoState, yaml = '') {
  const policy = parsePolicy(yaml)
  return { policy, inventory: (await readInventory(cluster(), policy, { apps: env(st) })).inventory }
}
const steps = (p: ReturnType<typeof buildPlan>) => p.steps.map(s => `${s.target}:${s.action}`)
const APPROVE = 'app:101:demoapp:abc123abc123@1.2.0'

test('planner: manual waits for approval, named in a warning (security first); approved runs after apt', async () => {
  const { policy, inventory } = await inv(state())
  const waiting = buildPlan(inventory, policy)
  assert.deepEqual(steps(waiting), ['101:snapshot', '101:apt'])
  assert.ok(waiting.warnings.some(w => /101 \(guest-101\): Demo 1\.0\.0 → 1\.2\.0 — SECURITY UPDATE waits for approval \(manual\)/.test(w)), waiting.warnings.join('\n'))
  const approved = buildPlan(inventory, policy, { approvals: [APPROVE] })
  assert.deepEqual(steps(approved), ['101:snapshot', '101:apt', '101:app'])
  assert.match(approved.steps[2].detail!, /^demoapp 1\.2\.0 abc123abc123 — Demo 1\.0\.0 → 1\.2\.0 \(security\)$/)
  assert.deepEqual(approved.approved, [APPROVE])
})

test('planner: auto needs no approval; off never plans; a guest with nothing else gets snapshot + app', async () => {
  const auto = await inv(state({ installed: { 102: '1.0.0' } }), 'apps:\n  demoapp: auto\n')
  assert.deepEqual(steps(buildPlan(auto.inventory, auto.policy)), ['101:snapshot', '101:apt', '102:snapshot', '102:app'])
  const off = await inv(state(), 'apps:\n  demoapp: off\n')
  const p = buildPlan(off.inventory, off.policy, { approvals: [APPROVE] })
  assert.deepEqual(steps(p), ['101:snapshot', '101:apt'])
  assert.ok(p.warnings.some(w => /not planned \(apps\.demoapp: off\)/.test(w)))
})

test('planner: a blocking issue keeps the update out until its fix is approved; then the fix goes first', async () => {
  const { policy, inventory } = await inv(state({ issues: [FIX] }), 'apps:\n  demoapp: auto\n')
  const blocked = buildPlan(inventory, policy)
  assert.deepEqual(steps(blocked), ['101:snapshot', '101:apt'])
  assert.ok(blocked.warnings.some(w => /not planned: browsers on demo\.example\.com would be refused \(approve the offered config change/.test(w)))
  const fixed = buildPlan(inventory, policy, { approvals: ['fix:101:demoapp:abc123abc123:f1f1f1f1f1f1'] })
  assert.deepEqual(steps(fixed), ['101:snapshot', '101:apt', '101:app-config', '101:app'])
  assert.match(fixed.steps[2].detail!, /^demoapp f1f1f1f1f1f1 abc123abc123 — add demo\.example\.com/)
})

test('planner: a stale approval is reported; HyperProx itself is left alone; an unknown app in the policy is named', async () => {
  const { policy, inventory } = await inv(state({ installed: { 101: '1.0.0', 150: '1.0.0' } }), 'apps:\n  demoap: auto\n')
  const p = buildPlan(inventory, policy, { approvals: ['app:101:demoapp:abc123abc123@1.1.0', 'app:150:demoapp:abc123abc123@1.2.0'], selfVmid: 150, appProviders: ['demoapp'] })
  assert.deepEqual(steps(p), ['101:snapshot', '101:apt'])
  assert.ok(p.warnings.some(w => /Approval app:101:demoapp:abc123abc123@1\.1\.0 matches nothing/.test(w)))
  assert.ok(p.warnings.some(w => /150 is HyperProx itself: apps inside it are not updated/.test(w)))
  assert.ok(p.warnings.some(w => /no plug-in provides: apps\.demoap/.test(w)))
})

test('planner: a guest without apt but with an app is planned for the app alone', () => {
  const g: UpdatesGuest = {
    vmid: 120, type: 'lxc', name: 'alpine', node: 'node-a', running: true, managed: false, unmanagedReason: 'no-apt', pending: [],
    rebootRequired: false, haManaged: false, snapshotCapable: true, docker: 'none',
    apps: [{ provider: 'demoapp', name: 'Demo', key: 'abc123abc123', installed: '1.0.0', latest: '1.2.0', location: '/opt/demo', runAs: 'demo',
      service: 'demo.service', running: true, how: '', mode: 'auto', isSecurity: false, notes: [], issues: [], rollback: '', approvalId: 'app:120:demoapp:abc123abc123@1.2.0' }],
  }
  const i: UpdatesInventory = { refreshedAt: '', nodes: [], guests: [g] }
  assert.deepEqual(steps(buildPlan(i, parsePolicy(''))), ['120:snapshot', '120:app'])
})

// --- runner ---------------------------------------------------------------------------------------

function setup(st: DemoState, yaml = 'nodes:\n  default: { upgrade: upgrade, reboot: manual }\n', fake = cluster()) {
  const store = new MemoryStore()
  const runner = new UpdatesRunner({ store, exec: fake, loadPolicy: policyLoad(yaml), timing: FAST, hostname: 'not-a-guest', apps: env(st) })
  return { store, runner, fake }
}
const settle = async (r: UpdatesRunner) => { await r.idle(); await r.idle() }

test('runner: an approved manual run snapshots, upgrades apt, then updates the app; the report counts it', async () => {
  const st = state()
  const { runner, store, fake } = setup(st)
  const job = await runner.start('run', 'manual', 'admin@example.com', 'guests', [APPROVE])
  await settle(runner)
  assert.equal((await store.getJob(job.id))!.status, 'awaiting-confirm')
  assert.deepEqual((await store.getJob(job.id))!.plan.approved, [APPROVE])
  await runner.confirm(job.id); await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'done', j.pauseReason ?? '')
  const s = await store.getSteps(job.id)
  assert.deepEqual(s.filter(x => x.target === '101').map(x => `${x.action}:${x.status}`), ['snapshot:ok', 'apt:ok', 'app:ok'])
  const order = fake.calls.filter(c => c.where === '101').map(c => c.cmd)
  assert.ok(order.findIndex(c => c.startsWith('snapshot')) < order.indexOf('guest:apt'))
  assert.ok(order.indexOf('guest:apt') < order.indexOf('guest:app-apply'))
  assert.ok(order.indexOf('guest:app-apply') < order.lastIndexOf('guest:app-verify'))
  assert.deepEqual(st.applied, ['101@1.2.0'])
  assert.ok(j.report!.changed.some(c => c.target === '101' && c.packages === 2))
  assert.ok(store.audits.some(a => a.action === 'updates.job.start' && JSON.stringify(a.details).includes(APPROVE)))
})

test('runner: a dry run plans the approved app and executes nothing', async () => {
  const st = state()
  const { runner, store, fake } = setup(st)
  const job = await runner.start('dry-run', 'manual', 'admin@example.com', 'all', [APPROVE])
  await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'done')
  assert.ok(j.plan.steps.some(s => s.action === 'app'))
  assert.equal(fake.calls.some(c => /guest:(app-apply|app-fix|apt)|snapshot/.test(c.cmd)), false)
  assert.deepEqual(st.applied, [])
})

test('runner: a scheduled run ignores approvals and applies only auto apps', async () => {
  const manual = setup(state())
  await manual.runner.start('run', 'schedule', undefined, 'guests', [APPROVE]); await settle(manual.runner)
  assert.equal(manual.fake.calls.some(c => c.cmd === 'guest:app-apply'), false)
  const st = state()
  const auto = setup(st, 'apps:\n  demoapp: auto\n')
  await auto.runner.start('run', 'schedule', undefined, 'guests'); await settle(auto.runner)
  assert.deepEqual(st.applied, ['101@1.2.0'])
})

test('runner: an approved fix runs before the update, both in the guest phase', async () => {
  const st = state({ issues: [FIX] })
  const { runner, store } = setup(st)
  const job = await runner.start('run', 'schedule', undefined, 'guests')
  await settle(runner)
  assert.equal((await store.getSteps(job.id)).some(s => s.action.startsWith('app')), false, 'a schedule never applies a fix nor a manual app')
  const m = await runner.start('run', 'manual', 'admin@example.com', 'guests', [APPROVE, 'fix:101:demoapp:abc123abc123:f1f1f1f1f1f1'])
  await settle(runner); await runner.confirm(m.id); await settle(runner)
  assert.deepEqual((await store.getSteps(m.id)).filter(s => s.target === '101').map(s => `${s.action}:${s.status}`), ['snapshot:ok', 'app-config:ok', 'app:ok'])
  assert.deepEqual(st.fixed, ['f1f1f1f1f1f1'])
})

test('runner: a failed app update pauses the job, names the snapshot and the rollback, and undoes nothing', async () => {
  const st = state({ verifyFails: true })
  const { runner, store, fake } = setup(st)
  const job = await runner.start('run', 'manual', 'admin@example.com', 'guests', [APPROVE])
  await settle(runner); await runner.confirm(job.id); await settle(runner)
  const j = (await store.getJob(job.id))!
  assert.equal(j.status, 'paused')
  const app = (await store.getSteps(job.id)).find(s => s.action === 'app')!
  assert.equal(app.status, 'failed')
  assert.match(app.reason!, /updated to 1\.2\.0, but the check failed: control\.ashx refused the origin\. Nothing was rolled back\. Roll the guest back to snapshot hp-upd-\d{12}\./)
  assert.equal(fake.calls.some(c => c.cmd.startsWith('rollback')), false)
  assert.match(j.pauseReason!, /Guest 101 failed/)
})

test('runner: rollback on request — paused jobs only, never for HA guests; then Resume carries on', async () => {
  const st = state({ applyFails: true })
  const { runner, store, fake } = setup(st, 'nodes:\n  default: { upgrade: upgrade, reboot: manual }\n')
  const job = await runner.start('run', 'manual', 'admin@example.com', 'guests', [APPROVE])
  await settle(runner)
  await assert.rejects(runner.rollbackGuest(job.id, '101', 'admin@example.com'), /offered only while it is paused/)
  await runner.confirm(job.id); await settle(runner)
  assert.equal((await store.getJob(job.id))!.status, 'paused')

  fake.haSids = ['ct:101']
  await assert.rejects(runner.rollbackGuest(job.id, '101'), /HA-managed.*ha-manager set ct:101 --state stopped/)
  fake.haSids = []
  await assert.rejects(runner.rollbackGuest(job.id, '102'), /No failed app step for 102/)

  await runner.rollbackGuest(job.id, '101', 'admin@example.com'); await settle(runner)
  assert.ok(fake.calls.some(c => c.where === '101' && /^rollback hp-upd-\d{12}$/.test(c.cmd)))
  const app = (await store.getSteps(job.id)).find(s => s.action === 'app')!
  assert.equal(app.status, 'skipped')
  assert.match(app.reason!, /rolled back to hp-upd-\d{12} by admin@example\.com/)
  assert.match((await store.getJob(job.id))!.pauseReason!, /was rolled back.*Press Resume/)
  assert.ok(store.audits.some(a => a.action === 'updates.app.rollback'))

  await runner.resume(job.id); await settle(runner)
  assert.equal((await store.getJob(job.id))!.status, 'done')
  assert.equal(fake.calls.filter(c => c.cmd === 'guest:app-apply').length, 1, 'Resume does not update the rolled-back guest again')
})

test('runner: a resumed app step that already landed is verified, not installed twice', async () => {
  const st = state()
  const { runner, store, fake } = setup(st)
  const job = await runner.start('run', 'manual', 'admin@example.com', 'guests', [APPROVE])
  await settle(runner)
  st.installed[101] = '1.2.0'   // someone (or an interrupted run) already put the version in place
  await runner.confirm(job.id); await settle(runner)
  assert.equal((await store.getJob(job.id))!.status, 'done')
  assert.equal(fake.calls.some(c => c.cmd === 'guest:app-apply'), false)
  assert.ok(fake.calls.some(c => c.cmd === 'guest:app-verify'))
})

test('runner: approvals are checked for shape before a job exists', async () => {
  const { runner, store } = setup(state())
  await assert.rejects(runner.start('run', 'manual', 'a', 'all', ['app:101:demoapp:abc123abc123@1.2.0;reboot']), /Not an app approval id/)
  assert.equal(await store.activeJob(), null)
})

test('readGuestApps reports errors from latest() on the row and still runs the pre-flight', async () => {
  const e = env(state({ issues: [FIX] }))
  e.providers[0].provider.latest = async () => { throw new Error('registry down') }
  const fake = cluster()
  const r = await readGuestApps(e, fake, parsePolicy(''), { vmid: 101, type: 'lxc', node: 'node-a', name: 'guest-101' }, true)
  assert.equal(r.apps[0].latest, null)
  assert.match(r.apps[0].error!, /registry down/)
  assert.equal(r.apps[0].approvalId, null)
  assert.equal(r.apps[0].issues.length, 1)
})
