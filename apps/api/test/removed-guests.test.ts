// Removed guests: the detector never decides on a failed read, a node that is down, a migration or a brief absence;
// the clean-up touches only the removed guest's records; a backup job loses exactly that ID (and an emptied job is
// only deleted when ticked); a backup job naming a gone guest is announced once and resolved after the clean-up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_STATE, MIN_SPAN_MS, markDestroyed, step, type ClusterRead, type DetectorState, type RemovedGuest,
} from '../src/lib/removed-guests/detector'
import { cleanUp, holdingsFor, jobVmids, noticeWords, type HoldingDeps } from '../src/lib/removed-guests/holdings'
import { EMPTY_SERVICE_STATE, RemovedGuestsService, probeGuestConfig, type ConfigProbe, type ServiceState, type TaskRow } from '../src/lib/removed-guests/service'

import { MemoryStateStore, Reconciler } from '../src/lib/auto-connect/core'
import { needsReconfirm, requiredRole } from '../src/lib/roles'

const MIN = 60_000
const NODES = [{ name: 'node-a', online: true }, { name: 'node-b', online: true }]
const guest = (vmid: number, name: string, type: 'lxc' | 'qemu' = 'lxc') => ({ vmid, type, name, node: 'node-a' })
const ok = (at: number, guests: Array<ReturnType<typeof guest>>, nodes = NODES): ClusterRead => ({ ok: true, at, guests, nodes })

/** Three reads ten minutes apart with 105 missing, after one where it was there. */
function goneAfter(s: DetectorState, start: number, input: Partial<Parameters<typeof step>[1]> = {}): DetectorState {
  for (let i = 1; i <= 3; i++) s = step(s, { read: ok(start + i * 5 * MIN, [guest(100, 'keep')]), candidates: [], ...input })
  return s
}

test('detector: present guests are remembered; a guest gone for three reads over ten minutes is removed', () => {
  let s = step(EMPTY_STATE, { read: ok(0, [guest(100, 'keep'), guest(105, 'dash')]), candidates: [], addresses: new Map([[105, ['10.0.0.5']]]) })
  assert.equal(s.seen['105'].name, 'dash')
  s = goneAfter(s, 0)
  const r = s.removed['105']
  assert.ok(r, 'removed after 3 reads spanning 10 minutes')
  assert.equal(r.name, 'dash'); assert.equal(r.type, 'lxc'); assert.deepEqual(r.addresses, ['10.0.0.5'])
  assert.equal(r.dateFrom, 'last-seen'); assert.equal(r.removedAt, 0)
  assert.ok(!s.seen['105'] && !s.absent['105'])
  assert.ok(!s.removed['100'])
})

test('detector: a failed read, or a read while a node is down, never counts', () => {
  let s = step(EMPTY_STATE, { read: ok(0, [guest(100, 'keep'), guest(105, 'dash')]), candidates: [] })
  for (let i = 1; i <= 10; i++) s = step(s, { read: { ok: false, at: i * 5 * MIN, why: 'HTTP 500' }, candidates: [] })
  assert.ok(!s.removed['105'] && !s.absent['105'], 'failed reads say nothing')
  assert.equal(s.lastRead?.ok, false)
  // Every node must be online: a node that is down may be the one the guest is on.
  const half = [{ name: 'node-a', online: true }, { name: 'node-b', online: false }]
  for (let i = 1; i <= 10; i++) s = step(s, { read: ok(60 * MIN + i * 5 * MIN, [guest(100, 'keep')], half), candidates: [] })
  assert.ok(!s.removed['105'] && !s.absent['105'], 'a read with a node down says nothing')
  assert.match(s.lastRead?.why ?? '', /node-b/)
  // An empty answer (no node at all) is not a cluster with no guests.
  s = step(s, { read: ok(200 * MIN, [], []), candidates: [] })
  assert.ok(!s.absent['105'] && !s.absent['100'])
})

test('detector: a brief absence is not enough (reads, and time)', () => {
  let s = step(EMPTY_STATE, { read: ok(0, [guest(100, 'keep'), guest(105, 'dash')]), candidates: [] })
  // Five reads in two minutes: enough reads, not enough time.
  for (let i = 1; i <= 5; i++) s = step(s, { read: ok(i * 20_000, [guest(100, 'keep')]), candidates: [] })
  assert.ok(!s.removed['105'])
  // Back again: the count ends.
  s = step(s, { read: ok(3 * MIN, [guest(100, 'keep'), guest(105, 'dash')]), candidates: [] })
  assert.ok(!s.absent['105'])
  // Two reads over an hour: enough time, not enough reads.
  s = step(s, { read: ok(10 * MIN, [guest(100, 'keep')]), candidates: [] })
  s = step(s, { read: ok(70 * MIN, [guest(100, 'keep')]), candidates: [] })
  assert.ok(!s.removed['105'])
  assert.equal(s.absent['105'].reads, 2)
})

test('detector: a guest migrating or being restored is never removed; its count starts again', () => {
  let s = step(EMPTY_STATE, { read: ok(0, [guest(100, 'keep'), guest(105, 'dash')]), candidates: [] })
  for (let i = 1; i <= 6; i++) s = step(s, { read: ok(i * 5 * MIN, [guest(100, 'keep')]), candidates: [], busy: new Set([105]) })
  assert.ok(!s.removed['105'] && !s.absent['105'])
  s = goneAfter(s, 30 * MIN)
  assert.ok(s.removed['105'], 'once it stops moving, the same rule applies')
})

test('detector: a guest only a record names is found too, dated by the destroy task; the same guest restored is not removed', () => {
  let s = step(EMPTY_STATE, { read: ok(0, [guest(100, 'keep')]), candidates: [{ vmid: 105, type: 'lxc', name: 'dash', addresses: ['10.0.0.5'] }] })
  s = goneAfter(s, 0, { candidates: [{ vmid: 105, type: 'lxc', name: 'dash', addresses: ['10.0.0.5'] }], destroyedAt: v => (v === 105 ? 1234_000 : null) })
  assert.equal(s.removed['105'].dateFrom, 'task'); assert.equal(s.removed['105'].removedAt, 1234_000)
  assert.deepEqual(s.removed['105'].addresses, ['10.0.0.5'])
  // Restored from a backup under the same name: not removed any more.
  const back = step(s, { read: ok(60 * MIN, [guest(100, 'keep'), guest(105, 'dash')]), candidates: [] })
  assert.ok(!back.removed['105'])
  // Another guest on that ID: still removed, marked as reused.
  const reused = step(s, { read: ok(60 * MIN, [guest(100, 'keep'), guest(105, 'other', 'qemu')]), candidates: [] })
  assert.equal(reused.removed['105'].reused?.name, 'other')
})

test('detector: HyperProx\'s own delete marks it removed at once', () => {
  const s = markDestroyed(EMPTY_STATE, { vmid: 107, type: 'qemu', name: 'tool', node: 'node-b' }, 5000)
  assert.equal(s.removed['107'].destroyedByHyperProx, true)
  assert.equal(s.removed['107'].removedAt, 5000)
})

// ── holdings and the clean-up ────────────────────────────────────────────────

interface World {
  homepage: Array<{ id: string; kind: 'lxc' | 'qemu'; vmid: number; name: string; addedAt: number; token: string | null }>
  nextcloud: Array<{ id: string; name: string; kind: 'lxc' | 'qemu'; vmid: number; addedAt: number }>
  installs: any[]
  sites: any[]
  ac: Array<{ plugin: string; key: string; label: string; state: 'connected' | 'pending' | 'dismissed' }>
  plugin: Array<{ plugin: string; pluginName: string; setting: string; value: string; also: string[] }>
  deckAddr: Record<string, string>
  remote: Array<{ machineId: string; provider: string; deviceId: string | null; adopted: boolean }>
  wg: { servers: any[]; peers: any[] }
  moves: Array<{ id: string; sid: string; name: string }>
  ha: string[]
  jobs: Array<{ id: string; vmid: string; schedule: string | null; comment: string | null }>
  live: Set<string>
  scanAt: number
  newestAt: number | null
  calls: string[]
  audits: Array<{ action: string; details: any }>
  auditDown?: boolean
}

function world(): World {
  return {
    homepage: [{ id: 'h1', kind: 'lxc', vmid: 105, name: 'dash', addedAt: 100, token: 'u@pve!t' }, { id: 'h2', kind: 'lxc', vmid: 100, name: 'keep', addedAt: 100, token: null }],
    nextcloud: [{ id: 'n1', name: 'Cloud', kind: 'lxc', vmid: 100, addedAt: 100 }],
    installs: [{ jobId: 'j1', recipeId: 'homepage', vmid: 105, hostname: 'dash', ip: '10.0.0.5', startedAt: 50, owner: 'o@example.com', vaultItem: { category: 'catalogue', provider: 'homepage-j1', createdByJob: true }, ledgers: [{ proxyHost: { instanceId: 'npm', hostId: '7' }, dnsRecord: { zone: 'example.com', type: 'A', name: 'dash', data: '192.0.2.1' } }] }],
    sites: [],
    ac: [{ plugin: 'homepage', key: 'lxc-105', label: 'dash', state: 'connected' }, { plugin: 'homepage', key: 'lxc-100', label: 'keep', state: 'connected' },
      { plugin: 'arrstack', key: 'sonarr_url@http://10.0.0.5:8989', label: 'Arr: 10.0.0.5', state: 'dismissed' }],
    plugin: [{ plugin: 'arrstack', pluginName: 'Arr Stack', setting: 'sonarr_url', value: 'http://10.0.0.5:8989', also: ['sonarr_key'] },
      { plugin: 'arrstack', pluginName: 'Arr Stack', setting: 'radarr_url', value: 'http://10.0.0.6:7878', also: ['radarr_key'] }],
    deckAddr: { 'lxc-105': '10.0.0.5', 'lxc-100': '10.0.0.9' },
    remote: [{ machineId: 'lxc-105', provider: 'tailscale', deviceId: 'd1', adopted: false }, { machineId: 'lxc-100', provider: 'tailscale', deviceId: 'd2', adopted: false }],
    wg: { servers: [], peers: [{ id: 'p1', machineId: 'lxc-105', name: 'dash-tun', serverId: 's9' }] },
    moves: [{ id: 'm1', sid: 'ct:105', name: 'dash' }, { id: 'm2', sid: 'ct:100', name: 'keep' }],
    ha: ['ct:105', 'ct:100'],
    jobs: [{ id: 'backup-daily', vmid: '100,105,110', schedule: '02:00', comment: 'daily' }, { id: 'backup-only', vmid: '105', schedule: 'sun 01:00', comment: null }, { id: 'backup-other', vmid: '100', schedule: null, comment: null }],
    live: new Set(['10.0.0.9', '10.0.0.6']), scanAt: 5000, newestAt: null,
    calls: [], audits: [],
  }
}

function deps(w: World): HoldingDeps {
  const call = (s: string) => { w.calls.push(s) }
  return {
    homepage: { list: async () => w.homepage, forget: async id => { call(`homepage.forget ${id}`); w.homepage = w.homepage.filter(h => h.id !== id); return 'ok' } },
    nextcloud: { list: async () => w.nextcloud, forget: async id => { call(`nextcloud.forget ${id}`); w.nextcloud = w.nextcloud.filter(n => n.id !== id); return 'ok' } },
    installs: { list: async () => w.installs, forget: async id => { call(`install.forget ${id}`); w.installs = w.installs.filter(j => j.jobId !== id); return 'ok' } },
    sites: { list: async () => w.sites, forget: async id => { call(`site.forget ${id}`); return 'ok' } },
    autoConnect: { keys: async () => w.ac, forget: async e => { call(`ac.forget ${e.map(x => `${x.plugin}/${x.key}`).join(',')}`); w.ac = w.ac.filter(a => !e.some(x => x.plugin === a.plugin && x.key === a.key)) } },
    plugins: { addresses: async () => w.plugin, clear: async (p, settings) => { call(`plugin.clear ${p} ${settings.join(',')}`); w.plugin = w.plugin.filter(x => !(x.plugin === p && settings.includes(x.setting))) } },
    deck: {
      addresses: async () => w.deckAddr, forget: async id => { call(`deck.forget ${id}`); delete w.deckAddr[id] },
    },
    remote: { list: async () => w.remote, forget: async (m, p) => { call(`remote.forget ${m} ${p}`); w.remote = w.remote.filter(r => r.machineId !== m); return 'ok' } },
    wireguard: { list: async () => w.wg, forgetMachine: async m => { call(`wg.forget ${m}`); w.wg.peers = w.wg.peers.filter(p => p.machineId !== m); return 'ok' } },
    moves: { scheduled: async () => w.moves, cancel: async id => { call(`move.cancel ${id}`); w.moves = w.moves.filter(m => m.id !== id) } },
    pve: {
      ha: async () => w.ha, removeHa: async sid => { call(`ha.remove ${sid}`); w.ha = w.ha.filter(x => x !== sid) },
      backupJobs: async () => structuredClone(w.jobs),
      setJobVmids: async (id, v) => { call(`job.put ${id} ${v.join(',')}`); const j = w.jobs.find(x => x.id === id)!; j.vmid = v.join(',') },
      deleteJob: async id => { call(`job.delete ${id}`); w.jobs = w.jobs.filter(j => j.id !== id) },
    },
    publish: { cleanup: async l => { call(`publish.cleanup ${l.dnsRecord?.name ?? ''} ${l.proxyHost?.hostId ?? ''}`); return ['Removed the DNS record.', 'Removed the proxy host.'] } },
    liveAddresses: async () => ({ hosts: w.live, scanAt: w.scanAt, newestGuestAt: w.newestAt }),
    audit: async (action, _r, details) => { if (w.auditDown) throw new Error('audit down'); w.audits.push({ action, details }) },
  }
}

const removed = (over: Partial<RemovedGuest> = {}): RemovedGuest => ({ vmid: 105, type: 'lxc', name: 'dash', node: 'node-a', removedAt: 1000, dateFrom: 'task', noticedAt: 2000, addresses: ['10.0.0.5'], reused: null, ...over })

test('holdings: everything that points at the removed guest, and nothing that points at another', async () => {
  const w = world()
  const { holdings, unread } = await holdingsFor(removed(), deps(w))
  assert.deepEqual(unread, [])
  const ids = holdings.map(h => h.id).sort()
  assert.deepEqual(ids, [
    'auto-connect:arrstack/sonarr_url@http://10.0.0.5:8989', 'auto-connect:homepage/lxc-105',
    'backup-job:backup-daily', 'backup-job:backup-only', 'deck-address:lxc-105', 'ha:ct:105', 'homepage:h1',
    'install:j1', 'move:m1', 'plugin-address:arrstack:sonarr_url', 'published:install:j1:0', 'remote:lxc-105:tailscale', 'wireguard:lxc-105',
  ])
  const daily = holdings.find(h => h.id === 'backup-job:backup-daily')!
  assert.deepEqual(daily.job, { id: 'backup-daily', before: [100, 105, 110], after: [100, 110], empty: false, schedule: '02:00', comment: 'daily' })
  assert.equal(holdings.find(h => h.id === 'backup-job:backup-only')!.job!.empty, true)
  assert.equal(holdings.find(h => h.kind === 'published')!.group, 'published')
  assert.match(noticeWords(removed(), holdings, () => '2026-11-16'), /^dash \(container 105\) was removed from Proxmox on 2026-11-16\. HyperProx still has: The Homepage plug-in's connection to dash; /)
})

test('holdings: an address a guest that exists now is seen at is never the removed guest\'s; none at all without the live list', async () => {
  const w = world()
  w.live.add('10.0.0.5')
  let ids = (await holdingsFor(removed(), deps(w))).holdings.map(h => h.id)
  assert.ok(!ids.some(i => i.startsWith('plugin-address') || i.startsWith('host-key') || i.includes('@http://10.0.0.5')))
  const d = deps(world())
  d.liveAddresses = async () => { throw new Error('no scan') }
  const r = await holdingsFor(removed(), d)
  ids = r.holdings.map(h => h.id)
  assert.ok(!ids.some(i => i.startsWith('plugin-address') || i.startsWith('host-key')))
  assert.ok(r.unread.length === 1)
})

test('holdings: a record made after the removal is not the removed guest\'s; with the ID reused nothing on the cluster is touched', async () => {
  const w = world()
  w.homepage[0].addedAt = 5000
  let ids = (await holdingsFor(removed(), deps(w))).holdings.map(h => h.id)
  assert.ok(!ids.includes('homepage:h1'))
  ids = (await holdingsFor(removed({ reused: { name: 'other', type: 'lxc', at: 9000 } }), deps(world()))).holdings.map(h => h.id)
  for (const k of ['ha:', 'backup-job:', 'deck-address:', 'remote:', 'wireguard:', 'move:', 'auto-connect:homepage/lxc-105']) assert.ok(!ids.some(i => i.startsWith(k)), `${k} is the new guest's`)
  assert.ok(ids.includes('homepage:h1') && ids.includes('install:j1'), 'its own old records still are its')
})

test('clean-up: only the removed guest\'s records; published names only when ticked; each backup job loses exactly that ID', async () => {
  const w = world()
  const { results } = await cleanUp(removed(), {}, 'admin@example.com', deps(w))
  assert.ok(!w.calls.some(c => c.startsWith('publish.cleanup')), 'published names are kept unless ticked')
  assert.ok(w.calls.includes('job.put backup-daily 100,110'))
  assert.ok(!w.calls.some(c => c.startsWith('job.delete')), 'a job that would back up nothing is not deleted unasked')
  assert.equal(results.find(r => r.id === 'backup-job:backup-only')!.outcome, 'kept')
  assert.equal(w.jobs.find(j => j.id === 'backup-other')!.vmid, '100')
  // The other guest's records are all still there.
  assert.ok(w.homepage.some(h => h.id === 'h2') && w.nextcloud.length === 1 && w.ha.includes('ct:100') && w.moves.some(m => m.id === 'm2'))
  assert.ok(w.remote.some(r => r.machineId === 'lxc-100') && w.deckAddr['lxc-100'])
  assert.ok(w.ac.some(a => a.key === 'lxc-100') && w.plugin.some(p => p.setting === 'radarr_url'))
  assert.ok(w.calls.includes('plugin.clear arrstack sonarr_url,sonarr_key'), 'the key saved for that address goes with it')
  // Audited before (the list) and after (the outcome).
  assert.equal(w.audits[0].action, 'removed_guest.clean_up')
  assert.equal(w.audits.at(-1)!.action, 'removed_guest.cleaned')
  // What is left: the emptied job (not ticked) and the published names (not ticked).
  assert.equal(results.find(r => r.kind === 'published')!.outcome, 'kept')
  // What is left: only the emptied job (not ticked). The kept names are no longer tracked once the install record goes.
  const left = (await holdingsFor(removed(), deps(w))).holdings.map(h => h.id).sort()
  assert.deepEqual(left, ['backup-job:backup-only'])
})

test('clean-up: ticking the emptied job deletes it; ticking published removes the names first', async () => {
  const w = world()
  await cleanUp(removed(), { published: true, deleteEmptyJobs: ['backup-only'] }, 'admin@example.com', deps(w))
  assert.ok(w.calls.includes('job.delete backup-only'))
  assert.ok(w.calls.indexOf('publish.cleanup dash 7') < w.calls.indexOf('install.forget j1'), 'names go while the record that says what was made still exists')
  assert.deepEqual((await holdingsFor(removed(), deps(w))).holdings, [])
})

test('clean-up: a job read again at run time loses only that ID, whatever changed since the preview', async () => {
  const w = world()
  const d = deps(w)
  const { holdings } = await holdingsFor(removed(), d)
  assert.deepEqual(holdings.find(h => h.id === 'backup-job:backup-daily')!.job!.after, [100, 110])
  w.jobs[0].vmid = '100,105,110,120'
  await cleanUp(removed(), {}, 'a', d)
  assert.equal(w.jobs[0].vmid, '100,110,120')
  assert.deepEqual(jobVmids(' 100, 110,x,120 '), [100, 110, 120])
})

test('clean-up: nothing changes when the audit row cannot be written', async () => {
  const w = world()
  w.auditDown = true
  await assert.rejects(cleanUp(removed(), {}, 'a', deps(w)), /audit down/)
  assert.deepEqual(w.calls, [])
})

// ── the service: a pass, the alert, and HyperProx's own delete ──────────────

function svc(w: World, reads: ClusterRead[], tasks: TaskRow[] | 'fail' = [], probe: ConfigProbe = 'missing') {
  let state: ServiceState = structuredClone(EMPTY_SERVICE_STATE)
  const published: any[] = []
  let i = 0
  let t = 10_000
  const s = new RemovedGuestsService({
    store: { get: async () => structuredClone(state), put: async x => { state = structuredClone(x) } },
    readCluster: async () => { const r = reads[Math.min(i++, reads.length - 1)]; t = r.at; return r },
    tasks: async () => { if (tasks === 'fail') throw new Error('no tasks'); return tasks },
    candidates: async () => [{ vmid: 105, type: 'lxc', name: 'dash' }, ...w.jobs.flatMap(j => jobVmids(j.vmid).map(vmid => ({ vmid })))],
    scanAddresses: () => new Map(),
    probeConfig: async () => probe,
    holdings: deps(w),
    unlocked: () => true,
    publish: async e => { published.push(e) },
    now: () => t,
  })
  return { s, published, state: () => state }
}

const passes = (n: number, guests: Array<ReturnType<typeof guest>>, from = 0) => Array.from({ length: n }, (_, k) => ok(from + k * 5 * MIN, guests))

test('service: a task log that cannot be read holds every absence; a removal is dated by its destroy task', async () => {
  const w = world()
  const stuck = svc(w, [ok(0, [guest(100, 'keep'), guest(110, 'x'), guest(105, 'dash')]), ...passes(6, [guest(100, 'keep'), guest(110, 'x')], 5 * MIN)], 'fail')
  for (let k = 0; k < 7; k++) await stuck.s.tick()
  assert.deepEqual(stuck.state().removed, {})
  const dated = svc(world(), [ok(0, [guest(100, 'keep'), guest(110, 'x'), guest(105, 'dash')]), ...passes(3, [guest(100, 'keep'), guest(110, 'x')], 5 * MIN)],
    [{ type: 'vzdestroy', id: '105', status: 'OK', starttime: 300 }, { type: 'qmigrate', id: '100', starttime: 1 }])
  for (let k = 0; k < 4; k++) await dated.s.tick()
  assert.equal(dated.state().removed['105'].removedAt, 300_000)
  assert.equal(dated.state().removed['105'].dateFrom, 'task')
})

test('service: a migration task for the guest keeps it from being removed', async () => {
  const tasks: TaskRow[] = [{ type: 'vzmigrate', id: '105', starttime: 0 }]
  const r = svc(world(), [ok(0, [guest(100, 'keep'), guest(110, 'x'), guest(105, 'dash')]), ...passes(5, [guest(100, 'keep'), guest(110, 'x')], 5 * MIN)], tasks)
  for (let k = 0; k < 6; k++) await r.s.tick()
  assert.deepEqual(r.state().removed, {})
})

test('service: the backup-job alert is sent once and resolved after the clean-up; the view carries the notice', async () => {
  const w = world()
  const r = svc(w, [ok(0, [guest(100, 'keep'), guest(110, 'x'), guest(105, 'dash')]), ...passes(5, [guest(100, 'keep'), guest(110, 'x')], 5 * MIN)])
  for (let k = 0; k < 6; k++) await r.s.tick()
  assert.ok(r.state().removed['105'])
  assert.equal(r.published.length, 1, 'announced once, though the pass ran again')
  assert.equal(r.published[0].title, 'A backup job names a guest that no longer exists')
  assert.equal(r.published[0].fingerprint, 'backup.job.dead_guest:105')
  const v = await r.s.view()
  assert.equal(v.guests.length, 1)
  assert.match(v.guests[0].words, /^dash \(container 105\) was removed from Proxmox/)
  await r.s.cleanUp(105, { deleteEmptyJobs: ['backup-only'] }, 'admin@example.com')
  assert.equal(r.published.length, 2)
  assert.equal(r.published[1].resolved, true)
  await assert.rejects(r.s.cleanUp(100, {}, 'a'), /has not found guest 100 removed/)
})

test('service: a guest HyperProx never knew, named only by a backup job, is found and announced too', async () => {
  const w = world()
  w.homepage = []; w.installs = []
  w.jobs = [{ id: 'backup-daily', vmid: '100,333', schedule: null, comment: null }]
  const r = svc(w, [...passes(4, [guest(100, 'keep')])])
  for (let k = 0; k < 4; k++) await r.s.tick()
  assert.ok(r.state().removed['333'])
  assert.ok(r.published.some(e => e.fingerprint === 'backup.job.dead_guest:333'))
  const v = await r.s.view()
  assert.match(v.guests.find(g => g.vmid === 333)!.words, /^Guest 333 \(guest 333\) was removed from Proxmox/)
})

test('service: HyperProx\'s own delete runs the same clean-up at once (published names only when chosen)', async () => {
  const w = world()
  const r = svc(w, [ok(10_000, [guest(100, 'keep')])])
  const words = await r.s.afterDestroy({ vmid: 105, type: 'lxc', name: 'dash', node: 'node-a' }, {}, 'admin@example.com')
  assert.match(words, /HyperProx also cleaned up what it held for it/)
  assert.ok(w.calls.includes('homepage.forget h1') && w.calls.includes('job.put backup-daily 100,110'))
  assert.ok(!w.calls.some(c => c.startsWith('publish.cleanup')))
})

// ── auto-connect forgets, and the routes' roles ─────────────────────────────

test('auto-connect: forget drops connected, pending and dismissed entries for those keys only', async () => {
  const store = new MemoryStateStore()
  store.s.connected['homepage/lxc-105'] = { at: 1, label: 'x', evidence: [], vaultItem: null }
  store.s.dismissed['homepage/lxc-105#web'] = { at: 1, label: 'x', by: 'a' }
  store.s.connected['homepage/lxc-100'] = { at: 1, label: 'y', evidence: [], vaultItem: null }
  const r = new Reconciler({ store, adapters: [], unlocked: () => true, excluded: async () => [], excludedSubnets: () => [], vaultItems: () => [], audit: async () => {} })
  await r.forget([{ plugin: 'homepage', key: 'lxc-105' }, { plugin: 'homepage', key: 'lxc-105#web' }])
  const s = await r.state()
  assert.deepEqual(Object.keys(s.connected), ['homepage/lxc-100'])
  assert.deepEqual(s.dismissed, {})
})

test('roles: removed guests are admin, reads included; clean-up and plug-in disconnect need the master password again', () => {
  assert.equal(requiredRole('GET', '/api/removed-guests'), 'admin')
  assert.equal(requiredRole('POST', '/api/removed-guests/105/clean-up'), 'admin')
  assert.equal(needsReconfirm('POST', '/api/removed-guests/105/clean-up'), true)
  assert.equal(needsReconfirm('POST', '/api/removed-guests/look'), false)
  assert.equal(requiredRole('DELETE', '/api/plugins/arrstack/settings'), 'admin')
  assert.equal(needsReconfirm('DELETE', '/api/plugins/arrstack/settings'), true)
})

test('detector: MIN_SPAN_MS is ten minutes', () => { assert.equal(MIN_SPAN_MS, 10 * MIN) })

// ── review fixes: the re-check before acting, the mass-disappearance guard, current addresses ──

/** 105 seen, then gone for three reads: removed. Later reads are what Clean up sees. */
function removedThen(w: World, after: ClusterRead[], probe: ConfigProbe = 'missing') {
  // Last seen at 1000: the fixture's records (made at 50 and 100) are from before that.
  const base = [ok(1000, [guest(100, 'keep'), guest(110, 'x'), guest(105, 'dash')]), ...passes(3, [guest(100, 'keep'), guest(110, 'x')], 5 * MIN)]
  return svc(w, [...base, ...after], [], probe)
}
const tickN = async (r: ReturnType<typeof svc>, n: number) => { for (let k = 0; k < n; k++) await r.s.tick() }

test('clean-up: removed, ID reused before the next look, then Clean up: only what is safe under a reused ID is touched', async () => {
  const w = world()
  const r = removedThen(w, [ok(30 * MIN, [guest(100, 'keep'), guest(110, 'x'), guest(105, 'other', 'qemu')])])
  await tickN(r, 4)
  assert.ok(r.state().removed['105'] && !r.state().removed['105'].reused)
  const out = await r.s.cleanUp(105, { deleteEmptyJobs: ['backup-only'] }, 'admin@example.com')
  assert.equal(r.state().removed['105'].reused?.name, 'other', 'marked reused at clean-up')
  // Its own old records go; nothing keyed by the ID (now the new guest's) is touched.
  assert.ok(w.calls.includes('homepage.forget h1') && w.calls.includes('install.forget j1'))
  for (const c of ['ha.remove', 'job.put', 'job.delete', 'deck.forget', 'remote.forget', 'wg.forget', 'move.cancel', 'ac.forget homepage/lxc-105']) {
    assert.ok(!w.calls.some(x => x.startsWith(c)), `${c} is the new guest's`)
  }
  assert.ok(out.results.every(x => !['ha', 'backup-job', 'deck-address', 'remote', 'wireguard', 'move'].includes(x.kind)))
})

test('clean-up: the same guest back under its name is not removed any more, and nothing is cleaned', async () => {
  const w = world()
  const r = removedThen(w, [ok(30 * MIN, [guest(100, 'keep'), guest(110, 'x'), guest(105, 'dash')])])
  await tickN(r, 4)
  await assert.rejects(r.s.cleanUp(105, {}, 'a'), (e: any) => e.code === 'back')
  assert.ok(!r.state().removed['105'])
  assert.deepEqual(w.calls, [])
})

test('clean-up: refused when the cluster cannot be read, a node is down, or Proxmox does not say the config is gone', async () => {
  for (const [after, probe] of [
    [{ ok: false, at: 30 * MIN, why: 'HTTP 500' } as ClusterRead, 'missing'],
    [ok(30 * MIN, [guest(100, 'keep'), guest(110, 'x')], [{ name: 'node-a', online: true }, { name: 'node-b', online: false }]), 'missing'],
    [ok(30 * MIN, [guest(100, 'keep'), guest(110, 'x')]), 'unknown'],
    [ok(30 * MIN, [guest(100, 'keep'), guest(110, 'x')]), 'exists'],
  ] as Array<[ClusterRead, ConfigProbe]>) {
    const w = world()
    const r = removedThen(w, [after])
    await tickN(r, 4)
    // The probe used at clean-up is the one given; the tick's own probe saw "missing" first.
    ;(r.s as any).d.probeConfig = async () => probe
    await assert.rejects(r.s.cleanUp(105, {}, 'a'), (e: any) => e.code === 'not_confirmed')
    assert.deepEqual(w.calls, [], 'nothing changed')
  }
})

test('the config probe: only "does not exist" on every node is missing; a 403 or an error proves nothing', async () => {
  const gone = (path: string) => Promise.reject(new Error(`Proxmox GET ${path}: HTTP 500 — Configuration file 'nodes/x/lxc/105.conf' does not exist`))
  assert.equal(await probeGuestConfig(gone, 105, 'lxc', ['node-a', 'node-b']), 'missing')
  assert.equal(await probeGuestConfig(gone, 105, null, ['node-a']), 'missing')
  assert.equal(await probeGuestConfig(() => Promise.reject(new Error('Proxmox GET /x: HTTP 403 — Permission check failed')), 105, 'lxc', ['node-a']), 'unknown')
  assert.equal(await probeGuestConfig(p => p.includes('node-b') ? Promise.resolve({}) : gone(p), 105, 'lxc', ['node-a', 'node-b']), 'exists')
  assert.equal(await probeGuestConfig(gone, 105, 'lxc', []), 'unknown')
  // On a look: a guest whose config the token may not read is not decided removed.
  const r = svc(world(), [ok(0, [guest(100, 'keep'), guest(110, 'x'), guest(105, 'dash')]), ...passes(3, [guest(100, 'keep'), guest(110, 'x')], 5 * MIN)], [], 'unknown')
  await tickN(r, 4)
  assert.deepEqual(r.state().removed, {})
})

test('mass disappearance: a token that can no longer see guests keeps the alert and decides nothing', async () => {
  const many = [100, 101, 102, 103, 104, 105, 106].map(v => guest(v, `g${v}`))
  const few = many.slice(0, 2)
  const w = world()
  w.jobs = []
  // Proxmox will not say they are gone (a token that lost VM.Audit answers 403): they stay "cannot see".
  const r = svc(w, [ok(0, many), ...passes(8, few, 5 * MIN), ok(60 * MIN, many)], [], 'unknown')
  await tickN(r, 9)
  assert.deepEqual(r.state().removed, {}, 'none of them is removed')
  assert.deepEqual(r.state().absent, {}, 'no absence even started')
  assert.match(r.state().lastRead?.why ?? '', /5 guests seen before are missing at once/)
  assert.deepEqual(r.state().massVanish?.names, ['g102', 'g103', 'g104', 'g105', 'g106'])
  const sent = r.published.filter(e => e.type === 'removed_guests.cannot_see')
  assert.equal(sent.length, 1, 'said once, and kept')
  assert.match(sent[0].title, /HyperProx can't see 5 guests it saw before/)
  assert.match(sent[0].lines.join(' '), /token's permissions/)
  assert.match(sent[0].lines.join(' '), /g102, g103, g104, g105, g106/)
  await r.s.tick()
  assert.equal(r.published.filter(e => e.type === 'removed_guests.cannot_see' && e.resolved).length, 1, 'cleared when they are seen again')
  // Over a fifth, even under four: two of five is not a removal either; one of five still is a normal absence.
  const five = [100, 101, 102, 103, 104].map(v => guest(v, `g${v}`))
  let s = step(EMPTY_STATE, { read: ok(0, five), candidates: [] })
  s = step(s, { read: ok(5 * MIN, five.slice(2)), candidates: [] })
  assert.equal(s.lastRead?.ok, false)
  s = step(s, { read: ok(10 * MIN, five.slice(1)), candidates: [] })
  assert.equal(s.lastRead?.ok, true); assert.equal(s.absent['100'].reads, 1)
})

test('mass disappearance: a real bulk delete of five guests is still detected, the usual way, with no alert', async () => {
  const many = [100, 101, 102, 103, 104, 105, 106].map(v => guest(v, `g${v}`))
  const few = many.slice(0, 2)
  const w = world()
  w.jobs = []
  const r = svc(w, [ok(0, many), ...passes(4, few, 5 * MIN)], [], 'missing')
  await tickN(r, 2)
  assert.deepEqual(Object.keys(r.state().removed), [], 'not on the first read: still three reads over ten minutes')
  assert.deepEqual(Object.keys(r.state().absent).sort(), ['102', '103', '104', '105', '106'])
  await tickN(r, 3)
  assert.deepEqual(Object.keys(r.state().removed).sort(), ['102', '103', '104', '105', '106'])
  assert.ok(!r.published.some(e => e.type === 'removed_guests.cannot_see'))
  // Mixed: one proven gone, four Proxmox will not answer for. The four keep the read a "cannot see" one and the
  // alert names only them; the proven one is still counted the usual way.
  const mixed = svc(world(), [ok(0, many), ...passes(4, few, 5 * MIN)], [], 'missing')
  ;(mixed.s as any).d.probeConfig = async (vmid: number) => (vmid >= 103 ? 'unknown' : 'missing')
  ;(mixed.s as any).d.holdings.pve.backupJobs = async () => []
  await tickN(mixed, 5)
  assert.match(mixed.state().massVanish ? mixed.state().massVanish!.names.join(',') : '', /^g103,g104,g105,g106$/)
  assert.ok(mixed.state().absent['102'] || mixed.state().removed['102'], 'the proven one is counted the usual way')
  assert.ok(!mixed.state().removed['103'] && !mixed.state().absent['103'], 'one Proxmox will not answer for is not')
  const sent = mixed.published.filter(e => e.type === 'removed_guests.cannot_see')
  assert.equal(sent.length, 1)
  assert.match(sent[0].lines.join(' '), /g103, g104, g105, g106/)
  assert.ok(!sent[0].lines.join(' ').includes('g102'))
})

test('addresses: matched only against a scan taken after the removal and the newest guest; a configured address of a current guest never; host keys never', async () => {
  const ids = async (w: World, g = removed()) => (await holdingsFor(g, deps(w))).holdings.map(h => h.id)
  const fresh = world()
  assert.ok((await ids(fresh)).includes('plugin-address:arrstack:sonarr_url'))
  const old = world(); old.scanAt = 500
  let r = await holdingsFor(removed(), deps(old))
  assert.ok(!r.holdings.some(h => h.kind === 'plugin-address'), 'a scan from before the removal says nothing about who uses the address now')
  assert.ok(r.unread.some(u => /newer than the removal/.test(u)))
  const created = world(); created.newestAt = 6000
  assert.ok(!(await ids(created)).some(i => i.startsWith('plugin-address')), 'a guest made after the scan may have the address')
  const configured = world(); configured.live.add('10.0.0.5')
  assert.ok(!(await ids(configured)).some(i => i.startsWith('plugin-address') || i.includes('@http://10.0.0.5')))
  assert.ok(!(await ids(fresh)).some(i => i.startsWith('host-key')), 'pinned host keys are never offered')
  // The clean-up checks again at the moment it acts: an address taken since is kept.
  const w = world()
  const d = deps(w)
  d.refreshScan = async () => { w.live.add('10.0.0.5'); w.scanAt = 9000 }
  const out = await cleanUp(removed(), {}, 'a', d)
  assert.ok(!w.calls.some(c => c.startsWith('plugin.clear')))
  assert.ok(!out.results.some(x => x.kind === 'plugin-address'))
})

test('reused ID: a record that does not say when it was made is not the removed guest\'s', async () => {
  const w = world()
  w.homepage[0].addedAt = 0
  const ids = (await holdingsFor(removed({ reused: { name: 'other', type: 'lxc', at: 9000 } }), deps(w))).holdings.map(h => h.id)
  assert.ok(!ids.includes('homepage:h1'))
  assert.ok((await holdingsFor(removed(), deps(w))).holdings.some(h => h.id === 'homepage:h1'), 'not reused: it still is')
})
