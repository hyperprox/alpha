// Leave-alone rules apply everywhere: the live tag read, the 5 s caches, the Updates executor's guest entry (certificate
// deploys and plug-in app steps come only through it), site metrics, the read-only GPU looks, the inventory-level
// "could not read the list" notice and the daily check's report of it, compose owners, and the tag grep.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  ExclusionsUnknownRefusal, GuestExcludedRefusal, excludedMachineIds, guestLeftAloneReason, invalidateGuardCache, liveGuestTags,
  setGuardClock, setGuestExclusionSource, GUARD_CACHE_MS,
} from '../src/lib/guest-guard'
import { productionExecutor } from '../src/lib/updates/executor'
import { guestRunner, deployBundle, type DeployDeps } from '../src/lib/certs/deploy'
import { appContext } from '../src/lib/updates/apps'
import { collectSite, defaultState, LEFT_ALONE_WORDS, LEFT_ALONE_UNKNOWN_WORDS, type CollectorDeps } from '../src/lib/site-metrics/collector'
import { MemoryMetricsStore } from '../src/lib/site-metrics/store'
import type { SiteRecord } from '../src/lib/sites'
import { GpuMoveWatcher } from '../src/lib/guest-config/gpu-watch'
import { makeService, smallCt, FIX } from './fakes/guest-pve'
import { readInventory } from '../src/lib/updates/inventory'
import { parsePolicy } from '../src/lib/updates/policy'
import { UpdatesChecker, MemoryCheckState, type CheckClusterHandle, buildMessage } from '../src/lib/updates/check'
import { EXCLUSIONS_UNKNOWN_NOTICE } from '../src/lib/updates/look-inside'
import { FakeCluster, node, guest } from './updates-fake'
import { composeOwnerRefusal } from '../src/lib/compose-owners'
import { IGNORED_TAG } from '../src/lib/clusters/send-simple'
import { RemoteAccessService } from '../src/lib/remote/service'
import { MemoryRemoteStore } from '../src/lib/remote/store'

beforeEach(() => { setGuardClock(); setGuestExclusionSource(async () => []) })
afterEach(() => { setGuardClock(); setGuestExclusionSource(null) })

/** A fake Proxmox that answers the live resource list and counts how often it was asked. */
function resources(rows: any[]) {
  const pve = { asked: 0, rows, fetchStrict: async (p: string) => { if (p !== '/cluster/resources?type=vm') throw new Error('no such route in this test'); pve.asked++; return pve.rows } }
  return pve as any
}
const G = { vmid: 101, type: 'lxc' as const, node: 'node-a', name: 'mail' }
const IGN = { type: 'lxc', vmid: 101, tags: 'prod;HyperProx-Ignore' }

// ── the shared helper and its caches (item 5) ────────────────────────────────

test('live tags: read once and reused for 5 s per Proxmox client, then read again', async () => {
  let t = 1_000
  setGuardClock(() => t)
  const pve = resources([IGN])
  const read = () => pve.fetchStrict('/cluster/resources?type=vm')
  assert.deepEqual(await liveGuestTags(pve, read, 'lxc', 101), ['prod', 'hyperprox-ignore'])
  assert.equal(await liveGuestTags(pve, read, 'lxc', 999), null, 'not on the cluster')
  t += GUARD_CACHE_MS - 1
  await liveGuestTags(pve, read, 'lxc', 101)
  assert.equal(pve.asked, 1, 'one read inside 5 s')
  t += 2
  await liveGuestTags(pve, read, 'lxc', 101)
  assert.equal(pve.asked, 2)
  // Another client has its own cache.
  const other = resources([])
  await liveGuestTags(other, () => other.fetchStrict('/cluster/resources?type=vm'), 'lxc', 101)
  assert.equal(other.asked, 1)
})

test('the exclusion list: reused for 5 s, forgotten when the source is set again or the cache is invalidated; failures are not cached', async () => {
  let t = 1_000
  setGuardClock(() => t)
  let list = ['lxc-1'], reads = 0
  setGuestExclusionSource(async () => { reads++; return list })
  assert.deepEqual(await excludedMachineIds(), ['lxc-1'])
  list = ['lxc-2']
  assert.deepEqual(await excludedMachineIds(), ['lxc-1'], 'within 5 s: the earlier read')
  assert.equal(reads, 1)
  invalidateGuardCache()
  assert.deepEqual(await excludedMachineIds(), ['lxc-2'])
  t += GUARD_CACHE_MS + 1
  list = ['lxc-3']
  assert.deepEqual(await excludedMachineIds(), ['lxc-3'])
  setGuestExclusionSource(async () => ['lxc-9'])
  assert.deepEqual(await excludedMachineIds(), ['lxc-9'])
  setGuestExclusionSource(async () => { throw new Error('db down') })
  await assert.rejects(excludedMachineIds(), ExclusionsUnknownRefusal)
})

test('changing the list through Remote access forgets the cached read at once', async () => {
  const store = new MemoryRemoteStore()
  const m = { id: 'lxc-130', kind: 'lxc' as const, name: 'private', node: 'pve-a', vmid: 130, running: true }
  const svc = new RemoteAccessService({
    store, exec: { listMachines: async () => [m] } as any, detector: {} as any, provider: async () => null, providerSettings: async () => ({ tags: [] }),
    settleMs: 0, sleep: async () => undefined,
  })
  setGuestExclusionSource(() => store.listExclusions())
  assert.deepEqual(await excludedMachineIds(), [])
  await svc.setExclusions(['lxc-130'], 'admin@example.com')
  assert.deepEqual(await excludedMachineIds(), ['lxc-130'])
})

test('guestLeftAloneReason fails closed: tags or list unreadable is a refusal, never "fine"', async () => {
  const pve = resources([{ type: 'lxc', vmid: 101, tags: 'web' }])
  const read = () => pve.fetchStrict('/cluster/resources?type=vm')
  assert.equal(await guestLeftAloneReason(pve, read, { kind: 'lxc', vmid: 101 }), null)
  const boom = { fetchStrict: async () => { throw new Error('down') } }
  await assert.rejects(guestLeftAloneReason(boom, () => boom.fetchStrict(), { kind: 'lxc', vmid: 101 }), ExclusionsUnknownRefusal)
  setGuestExclusionSource(async () => { throw new Error('down') })
  await assert.rejects(guestLeftAloneReason(pve, read, { kind: 'lxc', vmid: 101 }), ExclusionsUnknownRefusal)
})

// ── 1. the Updates executor's guest entry: certificate deploys and app steps ─

test('guestExec refuses a guest carrying the ignore tag (read live), and one that cannot be checked', async () => {
  await assert.rejects(productionExecutor(resources([IGN])).guestExec(G, 'true'), (e: any) => e instanceof GuestExcludedRefusal && /hyperprox-ignore tag/.test(e.message))
  await assert.rejects(productionExecutor({ fetchStrict: async () => { throw new Error('down') } } as any).guestExec(G, 'true'), (e: any) => e instanceof ExclusionsUnknownRefusal)
  // A tag that is merely similar is not the tag: the guard is passed (the fake then fails reaching a node).
  await assert.rejects(productionExecutor(resources([{ ...IGN, tags: 'hyperprox-ignored' }])).guestExec(G, 'true'), (e: any) => !(e instanceof GuestExcludedRefusal) && !(e instanceof ExclusionsUnknownRefusal))
  // A remote cluster is not governed by the home list or home tags.
  await assert.rejects(productionExecutor(resources([IGN]), { remote: true }).guestExec(G, 'true'), (e: any) => !(e instanceof GuestExcludedRefusal))
})

test('a certificate deploy to a tagged guest ends as a plain reason on the target, not a crash, and nothing ran inside', async () => {
  const exec = productionExecutor(resources([IGN]))
  const runner = guestRunner({ listGuests: async () => [{ ...G, running: true, template: false }], guestExec: exec.guestExec })
  const deps: DeployDeps = {
    ...runner, hyperproxInstall: async () => ({ ok: true, detail: '' }), probe: async () => ({ ok: false, error: 'x', trusted: null, namesMatch: null }),
    endpoints: [], probeAttempts: 1, sleep: async () => undefined,
  }
  const r = await deployBundle(
    { kind: 'guest-files', vmid: 101, files: { fullchain: '/etc/ssl/f.pem', key: '/etc/ssl/k.pem' }, owner: 'root:root', keyMode: '0600', reload: 'true' } as any,
    { keyPem: 'k', certPem: 'c', chainPem: '', fullchainPem: 'c', notBefore: new Date(), notAfter: new Date(), serial: '1', issuer: 'x', fingerprint256: 'AA' }, deps)
  assert.equal(r.ok, false)
  assert.match(r.detail, /mail is left alone \(the hyperprox-ignore tag\)/)
})

test('a plug-in app step in a tagged guest is refused by the same entry', async () => {
  const exec = productionExecutor(resources([IGN]))
  const ctx = appContext({} as any, exec, G, {}, () => {})
  await assert.rejects(ctx.run('true'), (e: any) => e instanceof GuestExcludedRefusal)
})

// ── 2. site metrics ──────────────────────────────────────────────────────────

const SITE: SiteRecord = { id: 's1', recipeId: 'static-site', name: 'Docs', vmid: 901, node: 'pve1', ip: '192.0.2.9', domain: 'www.example.com', url: 'https://www.example.com', jobId: 'j', owner: 'a@example.com', createdAt: 0 }
function collectorDeps(over: Partial<CollectorDeps>): CollectorDeps & { ran: number; checks: number } {
  const now = new Date('2026-11-11T10:30:00Z')
  const d: any = {
    ran: 0, checks: 0, sites: async () => [SITE], store: new MemoryMetricsStore(), unlocked: () => true, now: () => now, log: () => {}, publish: async () => {},
    run: async () => { d.ran++; return { code: 0, output: '' } },
    health: { fetch: async () => { d.checks++; return { status: 200, body: 'ok' } }, tls: async () => ({ notAfter: null, issuer: null, trusted: null, error: null }), now: () => now.getTime() },
    ...over,
  }
  return d
}

test('site metrics: a guest left alone is not entered; the reason is recorded on the site; the public check still runs', async () => {
  const d = collectorDeps({ leftAlone: async () => 'the hyperprox-ignore tag' })
  const st = await collectSite(SITE, d)
  assert.equal(d.ran, 0)
  assert.equal(st.lastError, LEFT_ALONE_WORDS)
  assert.equal(LEFT_ALONE_WORDS, "HyperProx is set to leave this guest alone, so visitor numbers aren't collected.")
  assert.equal(d.checks, 1, 'the public address check does not enter the guest')
})

test('site metrics: fail closed when it cannot be told whether to leave the guest alone', async () => {
  const d = collectorDeps({ leftAlone: async () => { throw new ExclusionsUnknownRefusal() } })
  const st = await collectSite(SITE, d)
  assert.equal(d.ran, 0)
  assert.equal(st.lastError, LEFT_ALONE_UNKNOWN_WORDS)
})

test('site metrics: a guest that is not left alone is read as before', async () => {
  const d = collectorDeps({ leftAlone: async () => null })
  await collectSite(SITE, d)
  assert.ok(d.ran > 0)
  assert.notEqual(defaultState(SITE).lastError, LEFT_ALONE_WORDS)
})

// ── 3. the read-only GPU looks ───────────────────────────────────────────────

function gpuRig(tags: string) {
  const s = makeService()
  s.shell.probes['node-a'] = FIX('probe-nvidia.txt'); s.shell.probes['node-b'] = FIX('probe-igpu.txt')
  const g = s.pve.add({ node: 'node-a', type: 'lxc', vmid: 971, status: 'running', ha: 'started', config: { ...JSON.parse(FIX('ct-nvidia.json')), tags } })
  const looked: string[] = []
  const orig = s.shell.run.bind(s.shell)
  s.shell.run = async (node, cmd, t) => { if (/pct exec 971/.test(cmd)) looked.push(cmd); return orig(node, cmd, t) }
  return { s, g, looked }
}

test('GPU watch: a guest left alone is skipped silently, with a note, and never entered', async () => {
  const { s, g, looked } = gpuRig('hyperprox-ignore')
  const sent: any[] = []
  const w = new GpuMoveWatcher(s.service, async e => { sent.push(e) })
  assert.deepEqual(await w.tick(), [])
  g.node = 'node-b'
  assert.deepEqual(await w.tick(), [], 'moved, but nothing is announced about a guest left alone')
  assert.equal(looked.length, 0)
  assert.equal(sent.length, 0)
  assert.match(w.seen.get(971)!.unknown!, /leave this guest alone, so its GPU is not checked/)
})

test('GPU watch: the list unreadable skips too (fail closed); an ordinary guest is still looked into', async () => {
  const a = gpuRig('media')
  setGuestExclusionSource(async () => { throw new Error('down') })
  const w = new GpuMoveWatcher(a.s.service, async () => {})
  await w.tick(); a.g.node = 'node-b'
  assert.deepEqual(await w.tick(), [])
  assert.equal(a.looked.length, 0)
  setGuestExclusionSource(async () => [])
  invalidateGuardCache()
  const b = gpuRig('media')
  const w2 = new GpuMoveWatcher(b.s.service, async () => {})
  b.s.shell.inside['971'] = ['/dev/dri/renderD128']
  await w2.tick(); b.g.node = 'node-b'
  const ev = await w2.tick()
  assert.equal(ev.length, 1)
  assert.ok(b.looked.length > 0)
})

test('GPU detail on request: a guest left alone is refused, by tag or by the list; nothing is run inside', async () => {
  const { s, g, looked } = gpuRig('hyperprox-ignore')
  await assert.rejects(s.service.gpuDetail({ node: g.node, type: 'lxc', vmid: 971 }), GuestExcludedRefusal)
  const b = gpuRig('media')
  setGuestExclusionSource(async () => ['lxc-971'])
  await assert.rejects(b.s.service.gpuDetail({ node: 'node-a', type: 'lxc', vmid: 971 }), GuestExcludedRefusal)
  assert.equal(looked.length + b.looked.length, 0)
  // The viewer's cached read never looks inside and is not refused.
  await b.s.service.gpuDetail({ node: 'node-a', type: 'lxc', vmid: 971 }, { cachedOnly: true })
})

// ── 4. the list cannot be read: one notice, not "nothing to update" ──────────

const POLICY = parsePolicy('nodes:\n  default: { upgrade: upgrade }\n')
function brokenCluster() {
  const fake = new FakeCluster({ nodes: [node('node-a', { pending: [] })], guests: [guest(101, 'node-a')] })
  fake.ceph = null
  ;(fake as any).lookInsideExclusions = async () => { throw new Error('database down') }
  return fake
}

test('inventory: an unreadable list raises one inventory-level notice in plain words (and still reads no guest)', async () => {
  const inv = (await readInventory(brokenCluster(), POLICY, { hostname: 'x' })).inventory
  assert.equal(inv.notice, EXCLUSIONS_UNKNOWN_NOTICE)
  assert.match(inv.notice!, /could not read Remote access's list of guests to leave alone/)
  assert.match(inv.notice!, /does not mean nothing needs updating/)
  assert.equal(inv.guests[0].unmanagedReason, 'exclusions-unknown', 'the row stays out of every action')
  const ok = new FakeCluster({ nodes: [node('node-a')], guests: [guest(101, 'node-a')] }); ok.ceph = null
  assert.equal((await readInventory(ok, POLICY, { hostname: 'x' })).inventory.notice, undefined)
})

test('daily check: the unreadable list is a warn in the log, a partial result and a message of its own', async () => {
  const file = { loaded: true as const, path: '/t', policy: parsePolicy('nodes:\n  default: { upgrade: upgrade }\ncheck:\n  cron: "30 6 * * *"\n') }
  const logs: Array<[string, string | undefined]> = []
  const sent: any[] = []
  const state = new MemoryCheckState()
  const handles = (): CheckClusterHandle[] => [{ ref: { id: 'home', name: 'Home cluster', kind: 'home' }, exec: brokenCluster(), loadPolicy: () => file, remote: false }]
  const checker = new UpdatesChecker({
    clusters: handles, loadPolicy: () => file, activeJob: async () => null, isUnlocked: () => true, state,
    publish: async e => { sent.push(e) }, log: (m, l) => { logs.push([m, l]) },
    now: () => new Date('2026-11-10T06:30:00Z'), gapMs: 1, clusterGapMs: 1, sleep: async () => undefined,
  })
  await checker.run('manual')
  const c = state.state.clusters.home
  assert.equal(c.result, 'partial')
  assert.equal(c.notice, EXCLUSIONS_UNKNOWN_NOTICE)
  assert.ok(logs.some(([m, l]) => l === 'warn' && /could not read Remote access's list/.test(m)), 'logged at warn')
  assert.equal(sent.length, 1, 'sent although there were no updates to report')
  assert.equal(sent[0].severity, 'warning')
  assert.match(sent[0].lines.join('\n'), /no guest was looked inside/)
  assert.match(sent[0].title, /could not read the guests/)
  const m = buildMessage([c], false)
  assert.match(m.lines!.join(' '), /does not mean nothing needs updating/)
})

// ── 6. compose owners ────────────────────────────────────────────────────────

test('compose owners: an entry with a project name but no directory covers a policy compose directory in the guest', () => {
  const o = { entries: [{ owner: 'nextcloud', page: 'the Nextcloud page', vmid: 101, project: 'nextcloud', dir: null }], unknown: [] }
  assert.match(composeOwnerRefusal(o, 101, { dir: '/opt/stack' })!, /Managed by the Nextcloud page/)
  assert.equal(composeOwnerRefusal(o, 102, { dir: '/opt/stack' }), null, 'another guest is not covered')
  // Docker's own answer (name and directory known) still tells projects apart.
  assert.equal(composeOwnerRefusal(o, 101, { name: 'other', dir: '/opt/other' }), null)
  assert.match(composeOwnerRefusal(o, 101, { name: 'nextcloud', dir: '/opt/nc' })!, /Managed by/)
})

// ── 7. the tag grep on the node ──────────────────────────────────────────────

test('the node-side tag test matches the whole tag only', () => {
  const hit = (line: string) => spawnSync('bash', ['-c', `printf '%s\\n' "$1" | ${IGNORED_TAG}`, '_', line]).status === 0
  for (const l of ['tags: hyperprox-ignore', 'tags: media;hyperprox-ignore', 'tags: HyperProx-Ignore;x', 'tags: a,hyperprox-ignore,b', 'tags: a hyperprox-ignore']) assert.equal(hit(l), true, l)
  for (const l of ['tags: hyperprox-ignored', 'tags: x;hyperprox-ignore2', 'tags: not-hyperprox-ignore', 'tags: media', 'description: hyperprox-ignore', 'tags: xhyperprox-ignore']) assert.equal(hit(l), false, l)
})
