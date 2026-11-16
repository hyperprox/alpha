// The background services are built and started in one place (lib/services/bootstrap.ts), not by the routes.
// Boots the real composition with fakes in place of the services and checks: the exclusion list and the compose
// owners are set before anything can tick; every service starts exactly once; a route registered twice (or not at
// all) changes nothing; and the demo server and the self-update child never reach the composition root.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { bootstrapServices, type BootstrapDeps } from '../src/lib/services/bootstrap'
import { excludedMachineIds, setGuestExclusionSource } from '../src/lib/guest-guard'
import { composeOwnership, registerComposeOwner } from '../src/lib/compose-owners'
import { UpdatesRuntime, setUpdatesRuntime } from '../src/lib/updates/runtime'
import { MemoryStore } from '../src/lib/updates/store'
import { MemoryCheckState } from '../src/lib/updates/check'
import { setHomepageService, productionHomepage } from '../src/lib/homepage'
import { setNextcloudService } from '../src/lib/nextcloud'
import { setAutoConnect } from '../src/lib/auto-connect'
import { setPlacementService } from '../src/lib/placement/production'
import { homepageRoutes } from '../src/routes/homepage'
import { autoConnectRoutes } from '../src/routes/auto-connect'
import { nextcloudRoutes } from '../src/routes/nextcloud'
import { placementRoutes } from '../src/routes/placement'
import { updatesRoutes } from '../src/routes/updates'
import { closure, SRC } from './fakes/import-graph'
import { FakeCluster, node, policyLoad } from './updates-fake'

const quiet = { info() {}, warn() {}, error() {} }

/** Fakes for every service, each recording when it started and whether the sources were in place at that moment. */
function rig() {
  const events: string[] = []
  const counts: Record<string, number> = {}
  const sourcesAtStart: Array<Promise<{ name: string; exclusions: boolean; owners: boolean }>> = []
  const started = (name: string) => {
    events.push(name)
    counts[name] = (counts[name] ?? 0) + 1
    // Read at the moment of starting: a guest command now would need both.
    const owners = composeOwnership().then(o => o.entries.some(e => e.owner === 'test-owner') && !o.unknown.length)
    const exclusions = excludedMachineIds().then(() => true, () => false)
    sourcesAtStart.push(Promise.all([exclusions, owners]).then(([x, o]) => ({ name, exclusions: x, owners: o })))
  }
  const unlockCallbacks: Array<() => void> = []
  const dismissals: string[][] = []
  const rt = new UpdatesRuntime({
    store: new MemoryStore(), exec: new FakeCluster({ nodes: [node('node-a')], guests: [] }),
    loadPolicy: policyLoad('nodes:\n  default: { upgrade: upgrade, reboot: manual }\n'),
    checkState: new MemoryCheckState(), publish: async () => {}, log: () => {},
  })
  const realRecover = rt.recover.bind(rt), realStart = rt.start.bind(rt), realSources = rt.installSources.bind(rt)
  rt.recover = async () => { started('updates-recover'); return realRecover() }
  rt.start = () => { started('updates-timers'); return realStart() }
  rt.installSources = () => { events.push('updates-sources'); realSources() }
  const deps: BootstrapDeps = {
    log: quiet,
    exclusions: async () => ['lxc-999'],
    composeOwners: () => { events.push('compose-owners'); return registerComposeOwner('test-owner', 'the test page', async () => [{ vmid: 1, project: 'p', dir: null }]) },
    dismissed: async (...a) => { dismissals.push(a) },
    updates: rt,
    nextcloud: { resume: async () => { started('nextcloud') } },
    homepage: { start: () => { started('homepage'); return () => { events.push('homepage-stopped') } } },
    autoConnect: { start: on => { started('auto-connect'); on(() => events.push('auto-connect-unlock-pass')); return () => { events.push('auto-connect-stopped') } } },
    placement: { start: async () => { started('placement'); return () => { events.push('placement-stopped') } } },
    arrGiveUp: { start: () => { started('arr-give-up'); return () => { events.push('arr-give-up-stopped') } } },
    onUnlock: cb => { unlockCallbacks.push(cb) },
  }
  return { events, counts, sourcesAtStart, unlockCallbacks, dismissals, rt, deps }
}

let open: FastifyInstance[] = []
afterEach(async () => {
  for (const a of open) await a.close()
  open = []
  setGuestExclusionSource(null)
  setUpdatesRuntime(null)
  setHomepageService(null); setNextcloudService(null); setAutoConnect(null); setPlacementService(null)
})

async function boot(r: ReturnType<typeof rig>, routes?: (app: FastifyInstance) => Promise<void>) {
  const app = Fastify({ logger: false })
  open.push(app)
  const handle = bootstrapServices(app, r.deps)
  if (routes) await routes(app)
  await app.ready()
  return { app, handle }
}

const ALL = ['nextcloud', 'homepage', 'auto-connect', 'updates-recover', 'updates-timers', 'placement', 'arr-give-up']

test('no route registered: every service still starts, once, in the documented order, after its sources', async () => {
  setGuestExclusionSource(null)
  const r = rig()
  const { handle } = await boot(r)
  assert.deepEqual(handle.steps, [
    'exclusions', 'compose-owners', 'dismissed', 'updates', 'install-hook',
    'nextcloud', 'homepage', 'auto-connect', 'updates-recover', 'updates-timers', 'placement', 'arr-give-up',
  ])
  for (const name of ALL) assert.equal(r.counts[name], 1, `${name} started exactly once`)
  // The compose owners and the read-only Updates sources come before the first thing that can tick or resume.
  const first = r.events.findIndex(e => ALL.includes(e))
  assert.ok(r.events.indexOf('compose-owners') < first && r.events.indexOf('updates-sources') < first, r.events.join(' → '))
  for (const s of await Promise.all(r.sourcesAtStart)) {
    assert.ok(s.exclusions, `${s.name}: the exclusion list was set before it started (a guest command would not fail closed)`)
    assert.ok(s.owners, `${s.name}: the compose owners were registered before it started`)
  }
  assert.deepEqual(await excludedMachineIds(), ['lxc-999'])
  // Auto-connect's pass after an unlock goes through the vault's hook, registered once.
  assert.equal(r.unlockCallbacks.length, 1)
  r.unlockCallbacks[0]()
  assert.ok(r.events.includes('auto-connect-unlock-pass'))
})

test('the timers that waited for the server to be ready still do', async () => {
  const r = rig()
  const app = Fastify({ logger: false })
  open.push(app)
  bootstrapServices(app, r.deps)
  assert.equal(r.counts['updates-timers'], undefined, 'not before onReady')
  assert.equal(r.counts.placement, undefined, 'not before onReady')
  await app.ready()
  assert.equal(r.counts['updates-timers'], 1)
  assert.equal(r.counts.placement, 1)
})

test('booting twice, or registering every route plugin twice, starts nothing twice', async () => {
  const r = rig()
  // The routes resolve the services bootstrap built; give them the fakes' stand-ins.
  setUpdatesRuntime(r.rt)
  setHomepageService({ start: () => { throw new Error('a route started Homepage') } } as any)
  setAutoConnect({ start: () => { throw new Error('a route started auto-connect') } } as any)
  setNextcloudService({ resume: async () => { throw new Error('a route resumed Nextcloud') } } as any)
  setPlacementService({ start: async () => { throw new Error('a route started load balancing') } } as any)
  const { app, handle } = await boot(r, async (a) => {
    for (const prefix of ['/one', '/two']) {
      await a.register(homepageRoutes, { prefix: `${prefix}/homepage` })
      await a.register(autoConnectRoutes, { prefix: `${prefix}/auto-connect` })
      await a.register(nextcloudRoutes, { prefix: `${prefix}/nextcloud` })
      await a.register(placementRoutes, { prefix: `${prefix}/placement` })
      await a.register(updatesRoutes, { prefix: `${prefix}/updates` })
    }
  })
  assert.equal(bootstrapServices(app, r.deps), handle, 'a second call returns the first boot')
  const other = Fastify({ logger: false })
  open.push(other)
  assert.equal(bootstrapServices(other, r.deps), handle, 'even from another app')
  await other.ready()
  for (const name of ALL) assert.equal(r.counts[name], 1, `${name} started exactly once`)
})

test('closing stops everything it started, and a later boot starts again', async () => {
  const r = rig()
  const { app } = await boot(r)
  await app.close()
  open = open.filter(a => a !== app)
  for (const e of ['placement-stopped', 'auto-connect-stopped', 'homepage-stopped']) assert.ok(r.events.includes(e), e)
  // Stopped in reverse: load balancing (started last) first.
  assert.ok(r.events.indexOf('placement-stopped') < r.events.indexOf('auto-connect-stopped'))
  assert.ok(r.events.indexOf('auto-connect-stopped') < r.events.indexOf('homepage-stopped'))
  assert.equal((await composeOwnership()).entries.length, 0, 'the compose owner was taken away')
  const again = rig()
  await boot(again)
  for (const name of ALL) assert.equal(again.counts[name], 1)
})

test('Homepage and Nextcloud reach auto-connect\'s dismissal record through the port bootstrap gives them', async () => {
  const r = rig()
  await boot(r)
  const hp = productionHomepage() as any
  await hp.d.dismissed('lxc-1', 'Dashboard', 'owner@example.com')
  assert.deepEqual(r.dismissals, [['homepage', 'lxc-1', 'Dashboard', 'owner@example.com']])
})

test('the demo server and the self-update child never reach the composition root', () => {
  const root = (f: string) => path.join(SRC, f)
  const background = ['lib/services/bootstrap.ts', 'lib/updates/runtime.ts', 'lib/placement/production.ts'].map(root)
  for (const entry of ['demo/main.ts', 'demo/server.ts', 'lib/self-update/updater-main.ts']) {
    const reach = closure(root(entry))
    assert.ok(reach.size > 1, `${entry} was read`)
    for (const f of background) assert.ok(!reach.has(f), `${entry} must not import ${path.relative(SRC, f)}`)
    assert.ok(!reach.has(root('index.ts')), `${entry} must not import the API's entry point`)
  }
  // And the API itself does reach it (the check above is not vacuous).
  assert.ok(closure(root('index.ts')).has(root('lib/services/bootstrap.ts')))
})
