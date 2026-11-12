// Plug-in pages: the typed `visual` numbers each detail() adds beside its stats and tables. Every builder is a
// pure function over the service's own answers, so these feed it made-up answers in the services' shapes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPlexVisual } from '../src/plugins/plex'
import { buildArrVisual, downloadState, failingFromHealth } from '../src/plugins/arrstack'
import { buildUnmanicVisual, baseName } from '../src/plugins/unmanic'
import { buildRouterVisual, logLevel } from '../src/plugins/mikrotik'
import { buildMeshVisual } from '../src/plugins/meshcentral'
import { addressesInConfig, guestNamesFrom } from '../src/lib/guest-names'

// ── Plex ─────────────────────────────────────────────────────────────────────

test('plex: sessions with progress, mode and the show split from the episode', () => {
  const v = buildPlexVisual({
    stream_count: '2', stream_count_transcode: 1, stream_count_direct_play: 1,
    total_bandwidth: 21900, lan_bandwidth: 20000, wan_bandwidth: 1900,
    sessions: [
      { media_type: 'episode', grandparent_title: 'Space Show', title: 'The Pilot', parent_media_index: '2', media_index: '5',
        friendly_name: 'alex', player: 'Phone', quality_profile: '2 Mbps 720p', transcode_decision: 'transcode', state: 'playing', progress_percent: '63',
        thumb: '/library/metadata/501/thumb/1700000001', grandparent_thumb: '/library/metadata/77/thumb/1700000002' },
      { media_type: 'movie', title: 'A Film', year: 1999, user: 'sam', player: 'TV', transcode_decision: 'direct play', state: 'paused', progress_percent: 140,
        thumb: 'http://198.51.100.7:32400/library/metadata/9/thumb/1?X-Plex-Token=leak' },
    ],
  }, [], [])
  assert.equal(v.kind, 'plex')
  assert.deepEqual(v.counts, { streams: 2, transcodes: 1, direct: 1 })
  assert.deepEqual(v.bandwidth, { totalMbps: 21.9, lanMbps: 20, wanMbps: 1.9 })
  const [ep, film] = v.sessions
  assert.equal(ep.title, 'Space Show'); assert.equal(ep.episode, 'The Pilot'); assert.equal(ep.number, 'S2 · E5')
  assert.equal(ep.progress, 63); assert.equal(ep.mode, 'transcode'); assert.equal(ep.user, 'alex')
  assert.equal(film.title, 'A Film'); assert.equal(film.episode, null); assert.equal(film.year, 1999)
  assert.equal(film.progress, 100, 'clamped'); assert.equal(film.state, 'paused'); assert.equal(film.quality, '—')
  assert.equal(ep.art, '/api/plugins/plex/art/77/thumb/1700000002', "an episode shows its show's poster, through HyperProx")
  assert.equal(film.art, null, 'anything but a bare Plex metadata path is dropped, so no address or token reaches the page')
})

test('plex: who watches most is sorted by hours, not by plays', () => {
  const v = buildPlexVisual({ sessions: [] }, [], [
    { stat_id: 'top_users', rows: [{ user: 'a', total_duration: 36 * 3600, total_plays: 90 }, { user: 'b', total_duration: 79 * 3600, total_plays: 40 }, { user: 'c', total_duration: 50 * 3600, total_plays: 60 }] },
  ])
  assert.deepEqual(v.topWatchers.map(w => [w.user, w.minutes / 60]), [['b', 79], ['c', 50], ['a', 36]])
})

test('plex: watchers in minutes, titles by plays across TV and films, history newest first in ms', () => {
  const v = buildPlexVisual({ sessions: [] }, [
    { date: 1_700_000_000, friendly_name: 'alex', full_title: 'Space Show - The Pilot', player: 'Phone', duration: 3000 },
    { started: 'x', user: 'sam', title: 'A Film', duration: null },
  ], [
    { stat_id: 'top_users', rows: [{ friendly_name: 'alex', total_duration: 7200, total_plays: 9 }, { user: 'sam', total_duration: 59, total_plays: 1 }] },
    { stat_id: 'top_tv', rows: [{ title: 'Space Show', total_plays: 4, total_duration: 600 }] },
    { stat_id: 'top_movies', rows: [{ title: 'A Film', total_plays: 7, total_duration: 6000 }] },
  ])
  assert.deepEqual(v.topWatchers, [{ user: 'alex', minutes: 120, plays: 9 }, { user: 'sam', minutes: 1, plays: 1 }])
  assert.deepEqual(v.topTitles.map(t => [t.title, t.plays]), [['A Film', 7], ['Space Show', 4]])
  assert.equal(v.recent[0].at, 1_700_000_000_000); assert.equal(v.recent[0].minutes, 50)
  assert.equal(v.recent[1].at, null); assert.equal(v.recent[1].minutes, 0)
  assert.deepEqual(v.counts, { streams: 0, transcodes: 0, direct: 0 })
})

test('plex: an empty or broken answer still gives a whole, empty visual', () => {
  const v = buildPlexVisual(undefined, null, { not: 'a list' })
  assert.deepEqual(v.sessions, []); assert.deepEqual(v.topWatchers, []); assert.deepEqual(v.recent, [])
  assert.deepEqual(v.bandwidth, { totalMbps: 0, lanMbps: 0, wanMbps: 0 })
})

// ── Arr Stack ────────────────────────────────────────────────────────────────

test('arr: qBittorrent states fold into the five the page draws', () => {
  assert.equal(downloadState('downloading'), 'downloading'); assert.equal(downloadState('metaDL'), 'downloading')
  assert.equal(downloadState('stalledDL'), 'stalled'); assert.equal(downloadState('uploading'), 'seeding')
  assert.equal(downloadState('stalledUP'), 'seeding'); assert.equal(downloadState('queuedDL'), 'queued')
  assert.equal(downloadState('checkingResumeData'), 'checking'); assert.equal(downloadState('stoppedUP'), 'paused')
  assert.equal(downloadState('error'), 'other')
})

test('arr: failing indexer names are read out of the health message', () => {
  const f = failingFromHealth([{ message: 'Indexers unavailable due to failures for more than 6 hours: Alpha (Prowlarr), Beta Two (Prowlarr)' }, { message: 'Something else: x' }])
  assert.deepEqual([...f].sort(), ['alpha', 'beta two'])
})

test('arr: pipeline counts, one alert per blocked download, indexer states, downloads ordered', () => {
  const now = Date.parse('2026-01-01T00:00:00Z')
  const v = buildArrVisual({
    now,
    arrs: [
      { label: 'Sonarr', total: 3, health: [{ type: 'warning', message: 'Indexers unavailable due to failures for more than 6 hours: Beta (Prowlarr)' }], queue: [
        { id: 1, downloadId: 'D1', title: 'Show S01 pack', trackedDownloadState: 'importBlocked', statusMessages: [{ messages: ['No files found are eligible'] }] },
        { id: 2, downloadId: 'D1', title: 'Show S01 pack', trackedDownloadState: 'importBlocked' },
        { id: 3, downloadId: 'D2', title: 'Other S02E01', trackedDownloadState: 'downloading', status: 'downloading' },
      ] },
      { label: 'Radarr', total: 0, health: [], queue: [], error: 'down' },
    ],
    indexers: [{ id: 1, name: 'Alpha', enable: true }, { id: 2, name: 'Beta', enable: true }, { id: 3, name: 'Gamma', enable: false }, { id: 4, name: 'Delta', enable: true }],
    indexerStatus: [{ indexerId: 4, disabledTill: '2026-01-02T00:00:00Z' }, { indexerId: 1, disabledTill: '2025-12-31T00:00:00Z' }],
    transfer: { dl_info_speed: 1000, up_info_speed: 50 },
    torrents: [
      { name: 'seeding one', state: 'uploading', progress: 1, size: 10, dlspeed: 0, upspeed: 9, eta: 8_640_000 },
      { name: 'moving one', state: 'downloading', progress: 0.5, size: 20, dlspeed: 500, upspeed: 0, eta: 60, category: 'tv' },
      { name: 'stuck one', state: 'stalledDL', progress: 0.809, size: 30, dlspeed: 0, upspeed: 0, eta: 8_640_000 },
      { name: 'paused one', state: 'pausedDL', progress: 0.1, size: 1 },
    ],
  })
  assert.deepEqual(v.pipeline, { indexersOn: 3, indexersTotal: 4, indexersFailing: 2, queued: 3, downloading: 1, stalled: 1, seeding: 1, importBlocked: 1, downBps: 1000, upBps: 50 })
  assert.deepEqual(v.blocked, [{ service: 'Sonarr', title: 'Show S01 pack', reason: 'No files found are eligible', downloadId: 'D1' }])
  assert.deepEqual(v.indexers.map(i => `${i.name}:${i.state}`), ['Beta:failing', 'Delta:failing', 'Alpha:ok', 'Gamma:off'])
  assert.deepEqual(v.downloads.map(d => d.name), ['stuck one', 'moving one', 'seeding one'], 'stalled first, paused left out')
  assert.equal(v.downloads[0].progress, 80.9); assert.equal(v.downloads[0].etaSec, null); assert.equal(v.downloads[1].etaSec, 60)
  assert.equal(v.downloads[1].category, 'tv')
  assert.deepEqual(v.services, [{ name: 'Sonarr', up: true }, { name: 'Radarr', up: false }])
  assert.equal(v.health[0].level, 'warning')
})

test('arr: without Prowlarr or qBittorrent the numbers are zero or null, not made up', () => {
  const v = buildArrVisual({ arrs: [{ label: 'Sonarr', total: 0, health: [], queue: [] }], indexers: null, transfer: null, torrents: null })
  assert.equal(v.pipeline.downBps, null); assert.equal(v.pipeline.indexersTotal, 0); assert.deepEqual(v.downloads, [])
})

// ── Unmanic ──────────────────────────────────────────────────────────────────

test('unmanic: one reactor per worker, slots counted, file names without folders, down workers kept out of totals', () => {
  const v = buildUnmanicVisual([
    { key: 'default', label: 'Worker 1', busy: 1, idle: 2, paused: 0, pending: 5,
      current: [{ worker: 'W-1', file: '/library/tv/Show/Season 1/Show S01E01.mkv', progress: 42.5, elapsedSec: 90 }] },
    { key: 'node2', label: 'Worker 2', busy: 0, idle: 1, paused: 1, pending: 0, current: [] },
    { key: 'node3', label: 'Worker 3', busy: 0, idle: 0, paused: 0, pending: 0, current: [], error: 'timed out' },
  ])
  assert.equal(v.workers.length, 3)
  assert.equal(v.workers[0].slots, 3); assert.equal(v.workers[1].slots, 2); assert.equal(v.workers[2].up, false)
  assert.deepEqual(v.workers[0].encoding, [{ worker: 'W-1', file: 'Show S01E01.mkv', progress: 42.5, elapsedSec: 90 }])
  assert.deepEqual(v.totals, { busy: 1, idle: 3, paused: 1, pending: 5, slots: 5 })
  assert.equal(baseName('C:\\media\\film.mkv'), 'film.mkv')
})

// ── Router ───────────────────────────────────────────────────────────────────

test('router: health numbers, names from the router first and cluster guests second, forwards named, log graded', () => {
  const v = buildRouterVisual({
    resource: { 'cpu-load': '7', 'cpu-count': '4', 'total-memory': '1000', 'free-memory': '250', version: '7.20 (stable)', uptime: '5w1d3h', 'board-name': 'RB' },
    identity: { name: 'edge' }, board: { model: 'Model X' },
    health: [{ name: 'cpu-temperature', value: '44' }, { name: 'jack-voltage', value: '24.1' }],
    wanRates: [{ iface: 'wan-a', rx: 3_000_000, tx: 1_000_000 }, { iface: 'wan-b', rx: 1_000_000, tx: 0 }],
    subnets: [{ net: '10.0.1.0/24', uplink: 'wan-a', devices: 12, down: 5, up: 1 }, { net: '10.0.2.0/24', uplink: '—', devices: 3, down: 0, up: 0 }],
    traffic: [
      { ip: '10.0.1.5', name: 'laptop', down: 900, up: 10, bytes: 1 },
      { ip: '10.0.1.9', name: '—', down: 100, up: 300, bytes: 1 },
      { ip: '10.0.1.7', name: '—', down: 1, up: 0, bytes: 1 },
      { ip: '10.0.1.8', name: '—', down: 0, up: 0, bytes: 99 },
    ],
    nat: [
      { action: 'dst-nat', comment: 'Web', protocol: 'tcp', 'dst-port': '443', 'to-addresses': '10.0.1.9', 'to-ports': '443', bytes: '100' },
      { action: 'dst-nat', protocol: 'udp', 'dst-port': '51820', 'to-addresses': '10.0.1.20', disabled: 'true', bytes: '5' },
      { action: 'masquerade' },
    ],
    log: [{ time: 'a', topics: 'system,info', message: 'old' }, { time: 'b', topics: 'script,error', message: ' boom ' }],
    routerNames: new Map([['10.0.1.20', 'nas']]),
    guestNames: new Map([['10.0.1.9', 'proxy'], ['10.0.1.5', 'not-this-one']]),
  })
  assert.deepEqual(v.router, { name: 'edge', model: 'Model X', version: '7.20', uptime: '5w 1d' })
  assert.deepEqual(v.total, { downBps: 4_000_000, upBps: 1_000_000 })
  assert.deepEqual(v.health, { cpuPct: 7, cpuCores: 4, memPct: 75, tempC: 44, voltage: 24.1 })
  assert.equal(v.subnets[1].uplink, null)
  assert.deepEqual(v.talkers.map(t => [t.ip, t.name, t.source]), [['10.0.1.5', 'laptop', 'router'], ['10.0.1.9', 'proxy', 'cluster'], ['10.0.1.7', null, 'none']])
  assert.deepEqual(v.forwards.map(f => [f.name, f.to, f.toName, f.active]), [['Web', '10.0.1.9:443', 'proxy', true], ['udp 51820', '10.0.1.20', 'nas', false]])
  assert.equal(v.forwardsActive, 1)
  assert.deepEqual(v.log.map(l => [l.time, l.level, l.message]), [['b', 'error', 'boom'], ['a', 'info', 'old']])
  assert.equal(logLevel('dhcp,warning'), 'warning'); assert.equal(logLevel('critical'), 'error')
})

test('router: a router without sensors reports no temperature or voltage rather than zero', () => {
  const v = buildRouterVisual({ resource: {}, identity: {}, board: {}, health: [], wanRates: [], subnets: [], traffic: [], nat: [], log: [], routerNames: new Map(), guestNames: new Map() })
  assert.equal(v.health.tempC, null); assert.equal(v.health.voltage, null); assert.equal(v.health.memPct, 0)
})

test('guest names: container and cloud-init addresses, stated before remembered, first claim wins', () => {
  assert.deepEqual(addressesInConfig({ net0: 'name=eth0,bridge=vmbr0,ip=10.0.1.9/24,gw=10.0.1.1', net1: 'name=eth1,ip=dhcp', ipconfig0: 'ip=10.0.1.30/24,gw=10.0.1.1', hostname: 'ip=1.2.3.4' }), ['10.0.1.9', '10.0.1.30'])
  const m = guestNamesFrom([
    { vmid: 101, name: 'proxy', type: 'lxc', config: { net0: 'ip=10.0.1.9/24' } },
    { vmid: 102, name: 'proxy-copy', type: 'lxc', config: { net0: 'ip=10.0.1.9/24' } },
    { vmid: 201, name: 'vm-a', type: 'qemu', config: null },
  ], { 'qemu-201': '10.0.1.40', 'lxc-102': '10.0.1.9', 'qemu-999': 'not-an-ip' })
  assert.deepEqual([...m.entries()].sort(), [['10.0.1.40', 'vm-a'], ['10.0.1.9', 'proxy']])
})

// ── MeshCentral ──────────────────────────────────────────────────────────────

test('meshcentral: not connected, says what is needed, shows no devices and no credentials', () => {
  const v = buildMeshVisual('https://user:pw@mesh.example.com/login, https://other.example.com')
  assert.equal(v.connected, false)
  assert.equal(v.publicUrl, 'https://mesh.example.com')
  assert.equal(v.devices, undefined)
  assert.ok(v.needs.length >= 1)
  assert.equal(JSON.stringify(v).includes('pw'), false)
  assert.equal(buildMeshVisual(undefined).publicUrl, null)
})
