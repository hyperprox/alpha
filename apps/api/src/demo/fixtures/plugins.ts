// Demo fixtures: plug-ins (Home Assistant with rooms and devices, Plex, Arr Stack, Unmanic, Router, MeshCentral).
import type { FixtureRoute } from './types'
import { iso, HOUR, MIN, DAY, wobble, GiB, PEOPLE, DOMAIN, REMOTE } from './data'
import { QNAP_PLUGIN, QNAP_TILE } from './qnap'

const ok = (data: unknown) => ({ success: true, data })
const mbps = (bps: number) => `${(bps / 1e6).toFixed(1)} Mbps`

const s = (key: string, label: string, type: 'url' | 'secret' | 'text', required: boolean, value?: string) =>
  ({ key, label, type, required, isSet: value !== undefined || type === 'secret', ...(value !== undefined && type !== 'secret' ? { value } : {}) })

const PLUGINS = [
  { id: 'home-assistant', name: 'Home Assistant', icon: '🏠', kind: 'device', coreTransport: true, baseUrlSetting: 'url',
    description: 'What has stopped responding, what is out of battery, and what is waiting to update.',
    auth: { kind: 'header', header: 'Authorization', fromSetting: 'token', prefix: 'Bearer ' },
    settings: [s('url', 'Home Assistant URL', 'url', true, 'http://10.0.2.11:8123'), s('token', 'Long-lived token', 'secret', true), s('battery_warn', 'Battery warning level (%)', 'text', false, '20')] },
  { id: 'plex', name: 'Plex activity', icon: '🎬', kind: 'tile', baseUrlSetting: 'url', description: 'Who is watching right now, what they are watching, and what is transcoding.',
    auth: { kind: 'query', param: 'apikey', fromSetting: 'apikey' }, settings: [s('url', 'Tautulli address', 'url', true, 'http://10.0.3.11:8181'), s('apikey', 'API key', 'secret', true)] },
  { id: 'arrstack', name: 'Arr Stack', icon: '📺', kind: 'device', baseUrlSetting: 'sonarr_url',
    description: 'The whole pipeline — Sonarr, Radarr, Prowlarr and qBittorrent — as one view, with search across every indexer.',
    auth: { kind: 'header', header: 'X-Api-Key', fromSetting: 'sonarr_key' },
    endpoints: [{ key: 'radarr', label: 'Radarr', baseUrlSetting: 'radarr_url' }, { key: 'prowlarr', label: 'Prowlarr', baseUrlSetting: 'prowlarr_url' }, { key: 'qbit', label: 'qBittorrent', baseUrlSetting: 'qbit_url' }],
    settings: [s('sonarr_url', 'Sonarr address', 'url', true, 'http://10.0.3.12:8989'), s('sonarr_key', 'Sonarr API key', 'secret', true), s('radarr_url', 'Radarr address', 'url', false, 'http://10.0.3.12:7878'),
      s('radarr_key', 'Radarr API key', 'secret', false), s('prowlarr_url', 'Prowlarr address', 'url', false, 'http://10.0.3.12:9696'), s('prowlarr_key', 'Prowlarr API key', 'secret', false), s('qbit_url', 'qBittorrent address', 'url', false, 'http://10.0.3.12:8080')] },
  { id: 'unmanic', name: 'Unmanic', icon: '🎞️', kind: 'device', baseUrlSetting: 'url', description: 'Transcode workers across every node: what is encoding right now and how deep the queue is.',
    auth: { kind: 'none' }, settings: [s('url', 'Worker 1 address', 'url', true, 'http://10.0.3.13:8888'), s('label', 'Worker 1 name', 'text', false, 'pve-c'), s('url2', 'Worker 2 address', 'url', false, 'http://10.0.2.15:8888'), s('label2', 'Worker 2 name', 'text', false, 'pve-b')] },
  { id: 'mikrotik', name: 'Router', icon: '🛜', kind: 'device', baseUrlSetting: 'url', refreshSeconds: 10, insecureTLS: true,
    description: 'Internet throughput, how many devices are on the network, and which are awake.',
    auth: { kind: 'basic', userSetting: 'username', passSetting: 'password' },
    settings: [s('url', 'Router address', 'url', true, 'https://10.0.0.1'), s('username', 'Username', 'text', true, 'hyperprox-ro'), s('password', 'Password', 'secret', true), s('wan_down_mbps', 'Plan download (Mbps)', 'text', false, '1000'), s('wan_up_mbps', 'Plan upload (Mbps)', 'text', false, '100')],
    consoleAccess: { defaultPort: 22, label: 'Router console', tmux: false, hint: 'RouterOS CLI over SSH.' } },
  { id: 'meshcentral', name: 'MeshCentral', icon: '🖧', kind: 'device', baseUrlSetting: 'public_url',
    description: 'Finds MeshCentral installed with npm in any guest and keeps it updated from the Updates page: release notes, security flag and a real sign-in check through the public URL.',
    auth: { kind: 'none' }, settings: [s('public_url', 'Public URL', 'text', false, `https://mesh.${DOMAIN}`)] },
  QNAP_PLUGIN,
].map(p => ({ ...p, hasDetail: true, configured: true, missing: [] as string[] }))

// -- Home Assistant -------------------------------------------------------------------------------
const btn = (action: string, label: string, confirm?: string) => ({ action, kind: 'button', label, ...(confirm ? { confirm } : {}) })
const onOff = (secure = false, name = '') => [btn('turn_on', 'On', secure ? `On ${name} at Home` : undefined), btn('turn_off', 'Off', secure ? `Off ${name} at Home` : undefined)]
const light = (id: string, name: string, on: boolean, bri = 70, temp = 3000) => ({
  entityId: `light.${id}`, name, domain: 'light', kind: 'light', tier: 'normal', unavailable: false, state: on ? 'on' : 'off',
  controls: [...onOff(), { action: 'brightness', kind: 'range', label: 'Brightness', min: 0, max: 100, step: 1, unit: '%', value: on ? bri : null },
    { action: 'color_temp', kind: 'range', label: 'Colour temperature', min: 2000, max: 6500, step: 100, unit: 'K', value: on ? temp : null }],
})
const sw = (id: string, name: string, on: boolean, kind = 'switch') => ({ entityId: `switch.${id}`, name, domain: 'switch', kind, tier: 'normal', unavailable: false, state: on ? 'on' : 'off', controls: onOff() })
const media = (id: string, name: string, state: string) => ({ entityId: `media_player.${id}`, name, domain: 'media_player', kind: 'media', tier: 'normal', unavailable: false, state, deviceClass: 'speaker', controls: [btn('play', 'Play'), btn('pause', 'Pause')] })
const sensor = (id: string, name: string, value: number, unit: string, deviceClass: string) => ({ entityId: `sensor.${id}`, name, domain: 'sensor', kind: 'sensor', tier: 'normal', unavailable: false, state: String(value), unit, deviceClass, current: value, controls: [] })
const climate = (id: string, name: string, mode: string, target: number, current: number) => ({
  entityId: `climate.${id}`, name, domain: 'climate', kind: 'climate', tier: 'normal', unavailable: false, state: mode, current, unit: '°C',
  controls: [{ action: 'target_temperature', kind: 'range', label: 'Target', min: 7, max: 30, step: 0.5, unit: '°', value: target },
    { action: 'hvac_mode', kind: 'select', label: 'Mode', options: ['off', 'heat', 'cool', 'auto'], value: mode }],
})
const lock = (id: string, name: string, state: string) => ({ entityId: `lock.${id}`, name, domain: 'lock', kind: 'lock', tier: 'security', unavailable: false, state,
  controls: [btn('lock', 'Lock', `Lock ${name} at Home`), btn('unlock', 'Unlock', `Unlock ${name} at Home`)] })
const cover = (id: string, name: string, state: string) => ({ entityId: `cover.${id}`, name, domain: 'cover', kind: 'cover', tier: 'security', unavailable: false, state, deviceClass: 'garage',
  controls: [btn('open_cover', 'Open', `Open ${name} at Home`), btn('close_cover', 'Close', `Close ${name} at Home`)] })

function haDevices() {
  return {
    areas: [
      { name: 'Living Room', devices: [light('living_ceiling', 'Ceiling Light', true, 80, 2700), light('floor_lamp', 'Floor Lamp', true, 45, 2400), media('living_tv', 'Living Room TV', 'playing'), climate('living_thermostat', 'Thermostat', 'heat', 21, 20.5), sensor('living_temp', 'Temperature', 20.5, '°C', 'temperature')] },
      { name: 'Kitchen', devices: [light('kitchen_pendants', 'Pendant Lights', true, 100, 4000), sw('coffee_machine', 'Coffee Machine', false), sw('dishwasher', 'Dishwasher', true), sensor('kitchen_humidity', 'Humidity', 48, '%', 'humidity')] },
      { name: 'Bedroom', devices: [light('bedroom_main', 'Bedroom Light', false), light('bedside_left', 'Bedside Lamp', false), media('bedroom_speaker', 'Bedroom Speaker', 'idle'), climate('bedroom_heater', 'Heater', 'off', 18, 18.9)] },
      { name: 'Office', devices: [light('office_desk', 'Desk Lamp', true, 90, 5000), sw('office_monitor', 'Monitor Power', true), sensor('office_co2', 'CO₂', 640, 'ppm', 'carbon_dioxide'), sensor('office_power', 'Desk Power', 142, 'W', 'power')] },
      { name: 'Hallway', devices: [light('hallway', 'Hallway Light', false), lock('front_door', 'Front Door', 'locked'), sensor('front_door_battery', 'Front Door Lock Battery', 64, '%', 'battery')] },
      { name: 'Garage', devices: [cover('garage_door', 'Garage Door', 'closed'), light('garage', 'Garage Light', false), sw('ev_charger', 'EV Charger', false)] },
      { name: 'Garden', devices: [light('porch', 'Porch Light', true, 60, 2700), sw('irrigation', 'Irrigation', false), sensor('outdoor_temp', 'Outdoor Temperature', 7.5, '°C', 'temperature')] },
    ],
    warnings: [], areaSource: 'registry', hiddenLed: 2, fetchedAt: iso(0),
  }
}

function haHealth() {
  return {
    ok: true,
    stats: [{ label: 'Home', value: 'Home' }, { label: 'Version', value: '2026.11.1' }, { label: 'Entities', value: '186' }, { label: 'Integrations', value: '42' },
      { label: 'Unavailable', value: '2', tone: 'warn' }, { label: 'Low battery', value: '1', tone: 'warn' }, { label: 'Updates', value: '1', tone: 'warn' }, { label: 'Automations', value: '17 of 19 on' }],
    tables: [
      { title: 'Needs you (4)', empty: 'Nothing is unavailable, flat, or waiting to update.', columns: [{ key: 'what', label: 'Entity' }, { key: 'kind', label: 'Kind' }, { key: 'detail', label: 'Detail' }],
        rows: [{ what: 'Garden Motion Sensor battery', kind: 'battery', detail: '12%' }, { what: 'Shed Door Sensor', kind: 'unavailable', detail: 'since 3h ago' }, { what: 'Kids Room Plug', kind: 'unavailable', detail: 'since 1d ago' }, { what: 'Zigbee2MQTT', kind: 'update', detail: '2.6.2 → 2.7.0' }] },
      { title: 'Batteries', empty: 'No battery sensors.', columns: [{ key: 'name', label: 'Sensor' }, { key: 'level', label: 'Level' }, { key: 'seen', label: 'Seen' }],
        rows: [{ name: 'Garden Motion Sensor', level: '12%', seen: '4 min ago' }, { name: 'Front Door Lock', level: '64%', seen: '1 min ago' }, { name: 'Bedroom Window', level: '88%', seen: '9 min ago' }] },
      { title: 'Automations', empty: 'No automations.', columns: [{ key: 'name', label: 'Automation' }, { key: 'state', label: 'State' }, { key: 'triggered', label: 'Last run' }],
        rows: [{ name: 'Porch light at sunset', state: 'on', triggered: '2h ago' }, { name: 'Heating eco when away', state: 'on', triggered: '6h ago' }, { name: 'Garage left open alert', state: 'on', triggered: '3d ago' }] },
    ],
  }
}

const haInstances = () => [
  { id: 'ha-main', name: 'Main house', clusterId: null, insecureTLS: false, fingerprint: null, url: 'http://10.0.2.11:8123', hasToken: true, cluster: null, remote: false,
    policy: { protected: [], everyday: ['light.*', 'switch.*', 'media_player.*', 'climate.*'], securityDomains: ['lock', 'cover', 'alarm_control_panel'], normalRole: 'operator', notifySecurity: true } },
  { id: 'ha-family', name: 'Family home', clusterId: REMOTE.id, insecureTLS: false, fingerprint: null, url: 'http://10.0.50.30:8123', hasToken: true, cluster: { id: REMOTE.id, name: REMOTE.name, kind: 'remote' }, remote: true,
    policy: { protected: [], everyday: ['light.*'], securityDomains: ['lock', 'cover'], normalRole: 'operator', notifySecurity: true } },
]

// -- Plex ------------------------------------------------------------------------------------------
function plexDetail() {
  const sessions = [
    { title: 'Severance', episode: 'Who Is Alive?', number: 'S02E04', year: 2025, mediaType: 'episode', user: 'sam', player: 'Living Room TV', quality: '4K', mode: 'direct play', state: 'playing', progress: 38 },
    { title: 'Dune: Part Two', episode: null, number: null, year: 2024, mediaType: 'movie', user: 'jordan', player: 'iPad', quality: '1080p', mode: 'transcode (hw)', state: 'playing', progress: 71 },
    { title: 'Bluey', episode: 'Sleepytime', number: 'S02E26', year: 2018, mediaType: 'episode', user: 'casey', player: 'Kids Tablet', quality: '1080p', mode: 'direct stream', state: 'paused', progress: 52 },
  ]
  const recent = [
    ['sam', 'Severance - Hello, Ms. Cobel', 'Living Room TV', 51], ['riley', 'The Bear - Forks', 'Chrome', 36], ['jordan', 'Arrival', 'iPad', 116],
    ['alex', 'Andor - One Way Out', 'Office PC', 47], ['casey', 'Bluey - Camping', 'Kids Tablet', 8], ['morgan', 'Blade Runner 2049', 'Apple TV', 163],
  ].map(([user, title, player, minutes], i) => ({ at: Date.now() - (i + 1) * 2.4 * HOUR, user, title, player, minutes }))
  const topWatchers = PEOPLE.map((user, i) => ({ user, minutes: 4200 - i * 610, plays: 160 - i * 22 }))
  const topTitles = [['Severance', 41, 2050], ['Bluey', 88, 620], ['The Bear', 30, 990], ['Andor', 24, 1150], ['Shogun', 20, 1180], ['Dune: Part Two', 6, 990]].map(([title, plays, minutes]) => ({ title, plays, minutes }))
  return {
    ok: true,
    visual: { kind: 'plex', sessions, counts: { streams: 3, transcodes: 1, direct: 2 }, bandwidth: { totalMbps: 41.6, lanMbps: 32.4, wanMbps: 9.2 }, topWatchers, topTitles, recent },
    stats: [{ label: 'Watching now', value: '3' }, { label: 'Transcoding', value: '1' }, { label: 'Direct play', value: '2' }, { label: 'Bandwidth', value: '41.6 Mbps' }, { label: 'LAN bandwidth', value: '32.4 Mbps' }, { label: 'WAN bandwidth', value: '9.2 Mbps' }],
    tables: [
      { title: 'Playing now', empty: 'Nobody is watching anything.', columns: [['user', 'Who'], ['title', 'What'], ['player', 'Player'], ['quality', 'Quality'], ['mode', 'Mode'], ['state', 'State'], ['at', 'Progress']].map(([key, label]) => ({ key, label })),
        rows: sessions.map(x => ({ user: x.user, title: x.number ? `${x.title} ${x.number}` : x.title, player: x.player, quality: x.quality, mode: x.mode, state: x.state, at: `${x.progress}%` })) },
      { title: 'Recently watched', empty: 'No history recorded yet.', columns: [['when', 'When'], ['user', 'Who'], ['title', 'What'], ['player', 'Player'], ['length', 'Watched']].map(([key, label]) => ({ key, label })),
        rows: recent.map(r => ({ when: new Date(r.at).toISOString().slice(0, 16).replace('T', ' '), user: r.user, title: r.title, player: r.player, length: `${r.minutes} min` })) },
    ],
  }
}

// -- Arr Stack -------------------------------------------------------------------------------------
function arrDetail() {
  const downloads = [
    { name: 'Shogun.2024.S01E05.1080p.WEB.h264', progress: 63.4, sizeBytes: Math.round(2.9 * GiB), downBps: Math.round(wobble(6.2e6, 1.5e6, 'd1')), upBps: 210_000, etaSec: 410, state: 'downloading', category: 'tv' },
    { name: 'The.Martian.2015.Extended.1080p.BluRay.x265', progress: 100, sizeBytes: Math.round(6.1 * GiB), downBps: 0, upBps: 480_000, etaSec: null, state: 'seeding', category: 'movies' },
    { name: 'Slow.Horses.S04E02.1080p.WEB.h264', progress: 12.0, sizeBytes: Math.round(1.8 * GiB), downBps: 0, upBps: 0, etaSec: null, state: 'stalled', category: 'tv' },
  ]
  return {
    ok: true,
    visual: { kind: 'arrstack',
      pipeline: { indexersOn: 6, indexersTotal: 7, indexersFailing: 1, queued: 3, downloading: 1, stalled: 1, seeding: 1, importBlocked: 0, downBps: downloads[0].downBps, upBps: 690_000 },
      blocked: [], downloads,
      indexers: [{ name: 'Nyaa', state: 'ok' }, { name: 'EZTV', state: 'ok' }, { name: 'YTS', state: 'ok' }, { name: 'TorrentGalaxy', state: 'ok' }, { name: 'Knaben', state: 'ok' }, { name: 'LimeTorrents', state: 'failing' }, { name: 'The Pirate Bay', state: 'ok' }],
      health: [{ service: 'Sonarr', level: 'warning', message: 'Indexers unavailable due to failures for more than 6 hours: LimeTorrents' }],
      services: [{ name: 'Sonarr', up: true }, { name: 'Radarr', up: true }, { name: 'Prowlarr', up: true }, { name: 'qBittorrent', up: true }] },
    stats: [{ label: 'In queue', value: '3' }, { label: 'Blocked imports', value: '0', tone: 'good' }, { label: 'Stalled', value: '1', tone: 'warn' }, { label: 'Download', value: mbps(downloads[0].downBps * 8) }, { label: 'Upload', value: '690 KB/s' }, { label: 'Indexers', value: '6 of 7', tone: 'warn' }],
    tables: [
      { title: 'Queue', empty: 'Both queues are empty.', total: 3, columns: [['service', 'Service'], ['title', 'Title'], ['kind', 'Kind'], ['progress', 'Done'], ['status', 'Status']].map(([key, label]) => ({ key, label })),
        rows: [{ service: 'Sonarr', title: 'Shogun S01E05', kind: 'episode', progress: '63%', status: 'downloading' }, { service: 'Sonarr', title: 'Slow Horses S04E02', kind: 'episode', progress: '12%', status: 'warning' }, { service: 'Radarr', title: 'The Martian (2015)', kind: 'movie', progress: '100%', status: 'importing' }] },
    ],
  }
}

// -- Unmanic ---------------------------------------------------------------------------------------
function unmanicDetail() {
  const workers = [
    { name: 'pve-c', up: true, busy: 2, idle: 1, paused: 0, slots: 3, pending: 14, encoding: [
      { worker: 'W1', file: 'Planet Earth III S01E03.mkv', progress: Math.round(wobble(46, 6, 'u1')), elapsedSec: 612 },
      { worker: 'W2', file: 'Interstellar (2014).mkv', progress: Math.round(wobble(18, 4, 'u2')), elapsedSec: 251 }] },
    { name: 'pve-b', up: true, busy: 1, idle: 1, paused: 0, slots: 2, pending: 6, encoding: [{ worker: 'W1', file: 'The Expanse S03E07.mkv', progress: Math.round(wobble(77, 5, 'u3')), elapsedSec: 980 }] },
  ]
  return {
    ok: true,
    visual: { kind: 'unmanic', workers, totals: { busy: 3, idle: 2, paused: 0, pending: 20, slots: 5 } },
    stats: [{ label: 'Encoding', value: '3' }, { label: 'Idle', value: '2' }, { label: 'Paused', value: '0' }, { label: 'Queued', value: '20' }, { label: 'Workers', value: '2 of 2' }],
    tables: [
      { title: 'Encoding now', empty: 'No worker is encoding anything.', columns: [{ key: 'node', label: 'Node' }, { key: 'worker', label: 'Worker' }, { key: 'file', label: 'File' }],
        rows: workers.flatMap(w => w.encoding.map(e => ({ node: w.name, worker: e.worker, file: e.file }))) },
    ],
  }
}

// -- Router ----------------------------------------------------------------------------------------
function routerDetail() {
  const wan = { downBps: Math.round(wobble(48e6, 18e6, 'rw')), upBps: Math.round(wobble(8e6, 3e6, 'ru')) }
  const talkers = [['plex', '10.0.3.11', 31e6, 1.2e6, 'cluster'], ['Living Room TV', '10.0.10.42', 12e6, 0.3e6, 'router'], ['arr-stack', '10.0.3.12', 6e6, 0.9e6, 'cluster'], ['iPad', '10.0.10.57', 3.1e6, 0.2e6, 'router'], ['nextcloud', '10.0.2.12', 0.8e6, 2.4e6, 'cluster']]
    .map(([name, ip, d, u, source]) => ({ name, ip, downBps: d, upBps: u, source }))
  const forwards = [['WireGuard', 'udp', '51820', '10.0.2.15:51820', 'wireguard'], ['Reverse proxy HTTPS', 'tcp', '443', '10.0.1.11:443', 'proxy'], ['Reverse proxy HTTP', 'tcp', '80', '10.0.1.11:80', 'proxy'], ['Minecraft', 'tcp', '25565', '10.0.3.15:25565', 'minecraft']]
    .map(([name, proto, port, to, toName], i) => ({ name, proto, port, to, toName, active: true, bytes: Math.round((4 - i) * 3.1 * GiB) }))
  return {
    ok: true,
    visual: { kind: 'mikrotik', router: { name: 'core-router', model: 'hEX S', version: '7.20.4', uptime: '3w 1d' },
      wans: [{ name: 'WAN', ...wan }], total: wan, health: { cpuPct: 4, cpuCores: 4, memPct: 23, tempC: 41, voltage: 24.1 },
      subnets: [{ net: '10.0.0.0/16', uplink: 'WAN', devices: 31, downBps: wan.downBps * 0.7, upBps: wan.upBps * 0.6 }, { net: '10.0.10.0/24', uplink: 'WAN', devices: 22, downBps: wan.downBps * 0.3, upBps: wan.upBps * 0.4 }],
      talkers, forwards, forwardsActive: 4,
      log: [{ time: iso(4 * MIN).slice(0, 19).replace('T', ' '), message: 'wireguard: peer sam-phone handshake', level: 'info' }, { time: iso(22 * MIN).slice(0, 19).replace('T', ' '), message: 'dhcp: assigned 10.0.10.57 to iPad', level: 'info' }] },
    stats: [{ label: 'Router', value: 'core-router' }, { label: 'Model', value: 'hEX S' }, { label: 'RouterOS', value: '7.20.4' }, { label: 'Uptime', value: '3w 1d' },
      { label: 'Download', value: mbps(wan.downBps) }, { label: 'Upload', value: mbps(wan.upBps) }, { label: 'CPU', value: '4% of 4 cores', tone: 'good' }, { label: 'Devices', value: '53 awake', hint: '31 on 10.0.0.0/16 · 22 on 10.0.10.0/24' }],
    tables: [
      { title: 'Bandwidth by device', empty: 'Connection tracking returned nothing.', columns: [['name', 'Device'], ['ip', 'Address'], ['down', 'Down'], ['up', 'Up']].map(([key, label]) => ({ key, label })),
        rows: talkers.map(t => ({ name: t.name, ip: t.ip, down: mbps(t.downBps as number), up: mbps(t.upBps as number) })) },
    ],
  }
}

function meshDetail() {
  return { ok: true, visual: { kind: 'meshcentral', connected: true, publicUrl: `https://mesh.${DOMAIN}`, needs: [] },
    stats: [{ label: 'Public URL', value: `mesh.${DOMAIN}` }, { label: 'Version', value: '1.1.53' }, { label: 'Updates', value: 'on the Updates page' }], tables: [] }
}

const DATA: Record<string, unknown> = {
  'home-assistant': { ok: true, headline: '4 need attention', tone: 'warn', rows: [{ label: 'Entities', value: '186' }, { label: 'Lights on', value: '5' }, { label: 'Low battery', value: '1', tone: 'warn' }, { label: 'Unavailable', value: '2', tone: 'warn' }] },
  plex: { ok: true, headline: '3 watching', tone: 'good', rows: [{ label: 'sam', value: 'Severance · S02E04 · 38%' }, { label: 'jordan', value: 'Dune: Part Two · transcoding · 71%', tone: 'warn' }, { label: 'casey', value: 'Bluey · paused · 52%' }] },
  arrstack: { ok: true, headline: '3 in queue', tone: 'warn', rows: [{ label: 'Downloading', value: '1' }, { label: 'Stalled', value: '1 download', tone: 'warn' }, { label: 'Indexers', value: '6 of 7', tone: 'warn' }] },
  unmanic: { ok: true, headline: '3 encoding · 20 queued', tone: 'good', rows: [{ label: 'pve-c', value: '2 encoding · 14 queued' }, { label: 'pve-b', value: '1 encoding · 6 queued' }] },
  mikrotik: { ok: true, headline: '↓ 48 ↑ 8 Mbps · 53 devices', tone: 'good', rows: [{ label: 'Internet', value: '↓ 48.0 · ↑ 8.0 Mbps', tone: 'good' }, { label: 'CPU', value: '4%' }, { label: 'Devices', value: '53 awake' }] },
  qnap: QNAP_TILE,
  meshcentral: { ok: true, headline: 'Up to date', tone: 'good', rows: [{ label: 'Public URL', value: `mesh.${DOMAIN}` }, { label: 'Version', value: '1.1.53' }] },
}
const DETAIL: Record<string, () => unknown> = { qnap: () => ({ ok: true, stats: QNAP_TILE.rows, tables: [] }), 'home-assistant': haHealth, plex: plexDetail, arrstack: arrDetail, unmanic: unmanicDetail, mikrotik: routerDetail, meshcentral: meshDetail }

export const PLUGIN_ROUTES: FixtureRoute[] = [
  { path: '/api/plugins', get: () => ok(PLUGINS) },
  { path: '/api/plugins/discover', get: () => ok([{ pluginId: 'arrstack', setting: 'prowlarr_url', label: 'Prowlarr', address: 'http://10.0.3.12:9696', source: 'arr-stack (302)', needs: ['prowlarr_key'] }]) },
  { path: '/api/plugins/wishlist', get: () => ok({ repo: 'hyperprox/hyperprox', built: PLUGINS.map(p => ({ id: p.id, name: p.name, description: p.description, icon: p.icon })),
    ideas: [
      { slug: 'proxmox-backup-server', name: 'Proxmox Backup Server', category: 'storage', would: 'Whether last night actually ran, what is verified, and which guest has silently dropped out of a job.', api: 'PBS REST API on :8007' },
      { slug: 'uptime-kuma', name: 'Uptime Kuma', category: 'monitoring', would: 'Which monitors are down and for how long, beside the guests they watch.', api: 'Uptime Kuma socket API' },
      { slug: 'adguard-home', name: 'AdGuard Home', category: 'network', would: 'Queries blocked today, the noisiest clients, and whether filtering is on.', api: 'AdGuard Home REST API' },
    ] }) },
  { path: '/api/plugins/metrics', refuse: true },
  { path: '/api/plugins/:id/data', get: p => ok(DATA[p.id] ?? { ok: false, error: 'Not part of the demo.' }) },
  { path: '/api/plugins/:id/detail', get: p => ok(DETAIL[p.id]?.() ?? { ok: false, error: 'Not part of the demo.' }) },
  { path: '/api/plugins/:id/stuck', get: () => ok([]) },
  { path: '/api/plugins/home-assistant/instances', get: () => ok(haInstances()) },
  { path: '/api/plugins/home-assistant/instances/:iid/status', get: () => ok({ reachable: true, error: null, version: '2026.11.1', location: 'Home', user: { name: 'hyperprox', isAdmin: false, isOwner: false } }) },
  { path: '/api/plugins/home-assistant/instances/:iid/devices', get: () => ok(haDevices()) },
  { path: '/api/plugins/home-assistant/instances/:iid/health', get: () => ok(haHealth()) },
]

