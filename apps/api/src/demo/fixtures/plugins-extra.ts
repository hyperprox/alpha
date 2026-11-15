// Demo fixtures: the Homepage, Nextcloud, Proxmox Backup Server and ASUS router plug-ins (each has its own page under /plugins/<id>).
// Shapes follow apps/frontend/components/plugins/<id>/. Invented guests, addresses and people only.
import type { FixtureRoute } from './types'
import { iso, HOUR, MIN, DAY, wobble, GiB, TiB, DOMAIN, PEOPLE, seeded } from './data'

const ok = (data: unknown) => ({ success: true, data })

const base = (id: string, name: string, icon: string, description: string) =>
  ({ id, name, icon, kind: 'device', coreTransport: true, baseUrlSetting: 'url', auth: { kind: 'none' }, settings: [] as unknown[], description })

export const EXTRA_PLUGINS = [
  base('homepage', 'Homepage', '🧭', 'Fills your Homepage dashboard from what HyperProx knows: guests, proxy hosts, plug-ins and websites, grouped and kept in sync, without touching what you wrote yourself.'),
  base('nextcloud', 'Nextcloud', '☁️', 'Nextcloud’s own setup checks with a fix behind each, version and app updates with a database dump first, Talk and its signalling server, and who has two-factor on.'),
  { ...base('pbs', 'Proxmox Backup Server', '🛡️', 'Whether last night actually ran: datastore fullness, every backup group’s newest snapshot, verify and prune jobs, and guests with no backup at all.'), refreshSeconds: 0 },
  { ...base('asus', 'ASUS router', '📡', 'Internet throughput, each Wi-Fi band, the AiMesh nodes and every connected device, with a confirmed restart.'), refreshSeconds: 10 },
]

// =============================================================================== Homepage
const HP_GUEST = { vmid: 107, node: 'pve-a', name: 'homepage' }
const HP_INSTANCE = () => ({
  id: 'hp-1', machineId: `lxc-${HP_GUEST.vmid}`, kind: 'lxc' as const, vmid: HP_GUEST.vmid, node: HP_GUEST.node, name: HP_GUEST.name, container: 'homepage',
  configDir: '/opt/homepage/config', composeDir: '/opt/homepage', url: `https://home.${DOMAIN}`,
  options: { excludeSubnets: ['10.0.20.0/24'], includeBareGuests: false, hiddenGroups: [], hiddenEntries: [], widgets: ['proxmox', 'plex', 'sonarr', 'radarr', 'qbittorrent', 'adguard'] },
  autoSync: true, managedGroups: ['Media', 'Downloads', 'Infrastructure', 'Home', 'Dev', 'Websites'], exportedVars: ['HOMEPAGE_VAR_PROXMOX_TOKEN', 'HOMEPAGE_VAR_SONARR_KEY', 'HOMEPAGE_VAR_RADARR_KEY'], releasedGroups: [],
  proxmoxToken: { tokenId: 'hyperprox@pve!homepage', createdAt: Date.now() - 41 * DAY, createdBy: 'alex@example.com' },
  lastSync: { at: Date.now() - 47 * MIN, by: 'automatic sync', ok: true, message: 'Wrote services.yaml and settings.yaml: 21 entries in 6 groups.', wrote: ['services.yaml', 'settings.yaml', 'homepage.env'], counts: { entries: 21, groups: 6, widgets: 6 }, backups: ['services.yaml.hyperprox-bak'] },
})

const HP_ENTRIES: Array<[string, string, string, string, 'public' | 'lan', string, 'siteMonitor' | 'ping' | null, string | null, string]> = [
  ['plex', 'Media', 'Plex', `https://plex.${DOMAIN}`, 'public', 'plex', 'siteMonitor', 'plex', 'Stream the library'],
  ['jellyfin', 'Media', 'Jellyfin', 'http://10.0.3.14:8096', 'lan', 'jellyfin', 'ping', null, 'Second media server (stopped)'],
  ['immich', 'Media', 'Immich', `https://photos.${DOMAIN}`, 'public', 'immich', 'siteMonitor', null, 'Photos and videos'],
  ['sonarr', 'Downloads', 'Sonarr', 'http://10.0.3.12:8989', 'lan', 'sonarr', 'siteMonitor', 'sonarr', 'TV'],
  ['radarr', 'Downloads', 'Radarr', 'http://10.0.3.12:7878', 'lan', 'radarr', 'siteMonitor', 'radarr', 'Films'],
  ['qbittorrent', 'Downloads', 'qBittorrent', 'http://10.0.3.12:8080', 'lan', 'qbittorrent', 'siteMonitor', 'qbittorrent', 'Downloads'],
  ['unmanic', 'Downloads', 'Unmanic', 'http://10.0.3.13:8888', 'lan', 'unmanic', 'siteMonitor', null, 'Library encodes'],
  ['proxmox', 'Infrastructure', 'Proxmox (homelab)', 'https://10.0.0.11:8006', 'lan', 'proxmox', 'ping', 'proxmox', 'The cluster'],
  ['hyperprox', 'Infrastructure', 'HyperProx', `https://hyperprox.${DOMAIN}`, 'public', 'hyperprox', 'siteMonitor', null, 'This dashboard’s control plane'],
  ['proxy', 'Infrastructure', 'Nginx Proxy Manager', `https://proxy.${DOMAIN}`, 'public', 'nginx-proxy-manager', 'siteMonitor', null, 'Reverse proxy'],
  ['adguard', 'Infrastructure', 'AdGuard Home', 'http://10.0.1.12:3000', 'lan', 'adguard-home', 'siteMonitor', 'adguard', 'DNS filtering'],
  ['backup', 'Infrastructure', 'Backup server', 'https://10.0.1.16:8007', 'lan', 'proxmox-backup-server', 'ping', null, 'Backups'],
  ['vaultwarden', 'Infrastructure', 'Vaultwarden', `https://vault.${DOMAIN}`, 'public', 'vaultwarden', 'siteMonitor', null, 'Passwords'],
  ['ha', 'Home', 'Home Assistant', 'http://10.0.2.11:8123', 'lan', 'home-assistant', 'ping', null, 'Home automation'],
  ['nextcloud', 'Home', 'Nextcloud', `https://cloud.${DOMAIN}`, 'public', 'nextcloud', 'siteMonitor', null, 'Files and calendar'],
  ['gitea', 'Dev', 'Gitea', `https://git.${DOMAIN}`, 'public', 'gitea', 'siteMonitor', null, 'Git hosting'],
  ['grafana', 'Dev', 'Grafana', 'http://10.0.2.16:3000', 'lan', 'grafana', 'ping', null, 'Dashboards (stopped)'],
  ['site-www', 'Websites', `www.${DOMAIN}`, `https://www.${DOMAIN}`, 'public', 'nginx', 'siteMonitor', null, 'Static site'],
  ['site-blog', 'Websites', `blog.${DOMAIN}`, `https://blog.${DOMAIN}`, 'public', 'wordpress', 'siteMonitor', null, 'WordPress'],
  ['minecraft', 'Dev', 'Minecraft', 'http://10.0.3.15:25565', 'lan', 'minecraft', 'ping', null, 'Game server'],
  ['mesh', 'Infrastructure', 'MeshCentral', `https://mesh.${DOMAIN}`, 'public', 'meshcentral', 'siteMonitor', null, 'Remote support'],
]

function hpPreview() {
  const entries = HP_ENTRIES.map(([id, group, name, href, hrefKind, icon, status, widget, description]) => ({
    id, group, name, href, hrefKind, icon, description, status,
    widget: widget ? { type: widget, enabled: true, pending: false, vars: widget === 'proxmox' ? ['HOMEPAGE_VAR_PROXMOX_TOKEN'] : [`HOMEPAGE_VAR_${widget.toUpperCase()}_KEY`] } : null,
    guest: null, source: id.startsWith('site-') ? 'site' : id === 'hyperprox' ? 'self' : id === 'proxmox' ? 'cluster' : hrefKind === 'public' ? 'proxy' : 'scan',
  }))
  const lines = (n: string, add: string[], del: string[] = []) => [
    { op: ' ' as const, text: '---' }, { op: ' ' as const, text: `# ${n}: written by HyperProx` },
    ...del.map(text => ({ op: '-' as const, text })), ...add.map(text => ({ op: '+' as const, text })), { op: ' ' as const, text: '# your own groups below are never touched' },
  ]
  return {
    planId: `plan-${Math.floor(Date.now() / 60_000)}`, expiresAt: Date.now() + 10 * MIN, counts: { entries: entries.length, groups: 6, widgets: 7, added: 1, removed: 0 }, errors: [], failed: [], changed: true,
    notes: { keptUserGroups: ['Bookmarks'], keptUserEntries: [], keptEdits: ['Plex (icon)'], userRemovedGroups: [], renamed: [], droppedSamples: false, adopted: [] },
    entries,
    files: [
      { name: 'services.yaml', changed: true, diff: lines('services.yaml', ['- Dev:', '    - Minecraft:', '        href: http://10.0.3.15:25565', '        description: Game server']) },
      { name: 'settings.yaml', changed: false, diff: lines('settings.yaml', []) },
      { name: 'homepage.env', changed: false, diff: lines('homepage.env', []) },
    ],
  }
}

const hpProblems = () => [
  { id: 'unmanic-widget', severity: 'warn' as const, title: 'Unmanic has no widget', detail: 'Unmanic is listed, but Homepage has no key for it, so its tile shows only a status dot.', fix: { id: 'add-unmanic-widget', label: 'Add its widget', confirm: 'Adds the Unmanic widget to services.yaml and its address to homepage.env.' } },
]

// =============================================================================== Nextcloud
const NC = { id: 'nc-1', name: 'Nextcloud', guest: { kind: 'lxc' as const, vmid: 202 }, url: `https://cloud.${DOMAIN}`, user: 'hyperprox', hasAppPassword: true, deployment: { kind: 'compose' } }
const sec = (id: string, category: string, name: string, severity: 'error' | 'warning' | 'info' | 'success', description: string, remedy: unknown, snoozed: string | null = null) =>
  ({ id, category, name, severity, description, doc: null, remedy, snoozed })

function ncReading() {
  const checks = [
    sec('maintenance-window', 'setup', 'Maintenance window start time', 'warning', 'The server has no maintenance window, so heavy background jobs may run while people are using it.',
      { kind: 'fix', action: 'maintenance-window', label: 'Set the window to 01:00 UTC', confirm: 'Sets maintenance_window_start to 1 (01:00 UTC).', secure: false, long: false, params: { hour: 1 } }),
    sec('phone-region', 'setup', 'Default phone region', 'warning', 'The default phone region is not set, so numbers without a country code cannot be checked.',
      { kind: 'fix', action: 'phone-region', label: 'Set the phone region', confirm: 'Sets default_phone_region for the server.', secure: false, long: false, params: { region: 'GB' } }),
    sec('indices', 'database', 'Missing database indices', 'warning', 'Some columns are missing an index. Adding them can take a while on a large database.',
      { kind: 'fix', action: 'add-indices', label: 'Add the indices', confirm: 'Runs occ db:add-missing-indices. The site stays up.', secure: false, long: true }),
    sec('smtp', 'mail', 'Email server not configured', 'info', 'Without an email server, password resets and share notifications cannot be sent.',
      { kind: 'guided', flow: 'smtp', label: 'Set up email', why: 'You need an SMTP server and a sender address; HyperProx writes the settings and sends a test.' }),
    sec('twofactor', 'security', 'Two-factor authentication is not enforced', 'info', 'Anyone can sign in with a password alone.',
      { kind: 'guided', flow: 'enforce-2fa', label: 'Enforce two-factor', why: 'HyperProx lists who has a second factor first and will not enforce it while anyone is unknown.' }),
    sec('webdav', 'setup', 'WebDAV endpoint', 'success', 'WebDAV answers correctly.', { kind: 'none', why: 'Passing.' }),
    sec('hsts', 'security', 'HSTS header', 'success', 'Strict-Transport-Security is sent by the reverse proxy.', { kind: 'none', why: 'Passing.' }),
    sec('big-upload', 'setup', 'Large uploads', 'info', 'Uploads over 512 MiB are chunked; the proxy allows 10 GiB bodies.', { kind: 'optional', gives: 'Faster large uploads from the desktop app.', needs: 'Nothing: it is already configured on the proxy.' }, 'forever'),
  ]
  const counts = { error: checks.filter(c => c.severity === 'error' && !c.snoozed).length, warning: checks.filter(c => c.severity === 'warning' && !c.snoozed).length, info: checks.filter(c => c.severity === 'info' && !c.snoozed).length }
  const logTime = (min: number) => iso(min * MIN).slice(0, 19) + 'Z'
  return {
    fetchedAt: iso(0), status: { versionString: '30.0.2', maintenance: false, needsDbUpgrade: false },
    update: { core: '30.0.4', apps: [{ app: 'calendar', version: '5.0.9' }, { app: 'spreed', version: '20.1.3' }, { app: 'richdocuments', version: '8.5.4' }], webUpdaterDisabled: true },
    checksFrom: 'web' as const, checks, counts, background: { mode: 'cron', lastRun: Math.floor((Date.now() - 4 * MIN) / 1000) },
    config: { maintenanceWindowStart: null, phoneRegion: null, serverId: 4, timezone: 'UTC', mail: { mode: null, host: null, port: null, secure: null, from: null, domain: null } },
    users: { total: PEOPLE.length + 3, disabled: 1 }, twoFactor: { enforced: false, providers: ['totp', 'webauthn'] },
    log: [
      { level: 2, time: logTime(9), app: 'core', message: 'Background job OCA\\Files_Trashbin\\BackgroundJob\\ExpireTrash took 41 seconds' },
      { level: 2, time: logTime(95), app: 'spreed', message: 'Signalling server answered slowly (1.9 s) during a call' },
      { level: 3, time: logTime(380), app: 'dav', message: 'Calendar sync for sam failed once: connection reset by client' },
    ],
    server: { php: { version: '8.3.14', memoryLimit: 512 * 1024 * 1024 }, db: { type: 'pgsql', version: '16.4', size: Math.round(1.7 * GiB) },
      storage: { users: PEOPLE.length + 3, files: Math.round(184_000 + wobble(40, 40, 'ncf')), freeSpace: Math.round(2.1 * TiB) }, activeUsers: { last5minutes: Math.round(wobble(2, 2, 'nc5')), last24hours: 7 } },
    talk: { installed: true, hpb: { version: '2.0.3', image: 'strukturag/nextcloud-spreed-signaling:2.0.3', container: 'spreed-signaling', missing: [] }, activeCalls: Math.round(wobble(0.6, 0.6, 'nccall')),
      push: { app: 'enabled' as const, daemon: 'running' as const, endpoint: `https://cloud.${DOMAIN}/push` } },
    apps: { enabled: 31, exApps: null },
    deployment: { kind: 'compose' as const,
      app: { container: 'nextcloud-app-1', image: 'nextcloud:30-apache', project: 'nextcloud', service: 'app', workdir: '/opt/nextcloud', configFile: '/opt/nextcloud/compose.yaml', built: false, dockerfile: false, imageVersion: '30.0.2' },
      db: { container: 'nextcloud-db-1', image: 'postgres:16', engine: 'postgres' as const },
      signaling: { container: 'spreed-signaling', image: 'strukturag/nextcloud-spreed-signaling:2.0.3', service: 'signaling', version: '2.0.3', running: true }, notifyPush: { container: 'notify-push', running: true } },
    suggest: { windowHour: 1, windowWhy: 'Nightly backups start at 02:00, and the quietest hour for this server is 01:00 UTC.', region: 'GB', regionWhy: 'Most of the people who sign in are on a UK network.', serverId: 4 },
    php: '8.3.14', dbVersion: '16.4', missing: [],
  }
}

const ncJob = () => ({ id: 'job-1', action: 'update-apps', state: 'done', steps: [{ key: 'dump', label: 'Dump the database', state: 'done' }, { key: 'apps', label: 'Update 3 apps', state: 'done' }, { key: 'check', label: 'Check the site answers', state: 'done' }],
  lines: ['Updating calendar 5.0.8 -> 5.0.9', 'Updating spreed 20.1.2 -> 20.1.3', 'All apps updated.'], startedAt: iso(3 * DAY), endedAt: iso(3 * DAY - 2 * MIN), result: 'Updated 3 apps; the site answered afterwards.', rollback: null, by: 'alex@example.com' })

// =============================================================================== PBS
const PBS = { id: 'pbs-1', name: 'backup-server', staleHours: 26, url: 'https://10.0.1.16:8007', tokenId: 'hyperprox@pbs!readonly', hasSecret: true, manage: null, pin: { fingerprint: 'AA:BB:CC:DD:EE:FF:00:11', source: 'first-use', at: iso(60 * DAY) } }

function pbsReading() {
  const nowS = Math.floor(Date.now() / 1000)
  const group = (type: 'vm' | 'ct', id: string, count: number, ageH: number, sizeGiB: number, verify: 'ok' | 'failed' | 'none' = 'ok') => ({
    store: 'main', ns: '', type, id, count, newest: nowS - Math.round(ageH * 3600), size: Math.round(sizeGiB * GiB), verify, failedVerifies: 0, stale: ageH > 26, ageHours: ageH,
  })
  const groups = [
    group('ct', '101', 17, 7.4, 3.1), group('ct', '102', 17, 7.4, 1.2), group('ct', '103', 17, 7.4, 2.2), group('ct', '104', 17, 7.4, 9.8), group('ct', '105', 17, 7.4, 2.9), group('vm', '106', 9, 33, 41, 'ok'),
    group('vm', '201', 17, 7.5, 18), group('ct', '202', 17, 7.5, 31), group('ct', '203', 17, 7.5, 24), group('ct', '204', 17, 7.5, 6.4), group('ct', '205', 17, 7.4, 0.9), group('ct', '207', 17, 7.5, 1.1), group('ct', '208', 17, 7.5, 3.8),
    group('ct', '301', 17, 7.3, 22), group('ct', '302', 17, 7.3, 15), group('ct', '303', 17, 7.3, 12), group('ct', '305', 17, 7.3, 9.5), group('vm', '306', 17, 7.3, 54, 'none'),
    group('ct', '206', 4, 71, 2.6),
  ]
  const nxt = (h: number) => nowS + Math.round(h * 3600)
  const datastore = (store: string, total: number, used: number, dedup: number | null) => ({
    store, total: Math.round(total), used: Math.round(used), avail: Math.round(total - used), usedFrac: used / total, dedup,
    gc: { lastState: 'ok', lastEnd: nowS - 3 * 3600 - 1800, next: nxt(5 * 24), schedule: 'sat 06:00', removedBytes: Math.round(18 * GiB), pendingBytes: Math.round(wobble(3.4, 0.3, 'pbsgc') * GiB) },
    estimatedFull: null, error: null, groups: store === 'main' ? groups.length : 5, snapshots: store === 'main' ? groups.reduce((a, g) => a + g.count, 0) : 22,
  })
  return {
    fetchedAt: iso(1 * MIN), version: '4.2.0', staleHours: 26,
    datastores: [datastore('main', 8 * TiB, 2.6 * TiB, 14.2), datastore('offsite', 4 * TiB, 3.5 * TiB, 9.1)],
    groups,
    jobs: [
      { kind: 'prune' as const, id: 'daily-prune', store: 'main', ns: null, schedule: '05:00', lastEnd: nowS - 20 * 3600, result: 'ok' as const, detail: null, next: nxt(4) },
      { kind: 'gc' as const, id: 'main-gc', store: 'main', ns: null, schedule: 'sat 06:00', lastEnd: nowS - 3 * 24 * 3600, result: 'ok' as const, detail: null, next: nxt(5 * 24) },
      { kind: 'verify' as const, id: 'weekly-verify', store: 'main', ns: null, schedule: 'sun 08:00', lastEnd: nowS - 5 * 24 * 3600, result: 'ok' as const, detail: null, next: nxt(2 * 24) },
      { kind: 'sync' as const, id: 'push-offsite', store: 'offsite', ns: null, schedule: 'daily 04:30', lastEnd: nowS - 9 * 3600, result: 'failed' as const, detail: 'remote 203.0.113.50:8007 did not answer within 30 s', next: nxt(15) },
    ],
    failedTasks: [{ upid: 'UPID:pbs:00001A2B:0:0:syncjob:offsite:daily:', type: 'syncjob', target: 'offsite', start: nowS - 9 * 3600, end: nowS - 9 * 3600 + 30, status: 'connection timed out' }],
    missing: [],
    health: { state: 'attention' as const, reason: null, reasons: ['1 backup group has no snapshot in 26 h (ct/206)', 'The offsite sync failed last night'] },
  }
}
const pbsCoverage = () => ({
  ok: true, clusters: [{ clusterId: 'home', cluster: 'homelab', storages: [{ storage: 'pbs', datastore: 'main', ns: '' }], noGroup: [{ vmid: 307, name: 'windows-11', type: 'vm' as const }, { vmid: 304, name: 'jellyfin', type: 'ct' as const }],
    notInJob: [{ vmid: 307, name: 'windows-11', type: 'vm' as const }, { vmid: 304, name: 'jellyfin', type: 'ct' as const }, { vmid: 206, name: 'grafana-lab', type: 'ct' as const }] }],
})
function pbsSnapshots(q: Record<string, string>) {
  return Array.from({ length: 12 }, (_, i) => ({ time: Math.floor(Date.now() / 1000) - i * 86400 - 7 * 3600, size: Math.round((3 + seeded(String(q.id) + i)) * GiB), verify: i > 3 ? 'ok' : 'none', protected: i === 6 }))
}

// =============================================================================== ASUS
const AS = { id: 'asus-1', name: 'Office router', insecureTLS: false, fingerprint: null, model: 'RT-AX86U Pro', firmware: '3.0.0.6_102', url: 'http://10.0.10.2', username: 'hyperprox', hasPassword: true,
  held: null, phrase: 'restart Office router', lastAction: null, nameSource: 'user' as const, deviceName: 'RT-AX86U-Pro' }

function asusReading() {
  const devs: Array<[string, string, string, 'wired' | 'wifi', string | null, number | null, number | null, string]> = [
    ['Living Room TV', '10.0.10.42', 'LG Electronics', 'wifi', '5 GHz', -52, 4, 'node'], ['Kitchen Speaker', '10.0.10.43', 'Sonos', 'wifi', '2.4 GHz', -61, 3, 'main'],
    ['Sam iPhone', '10.0.10.44', 'Apple', 'wifi', '5 GHz', -48, 4, 'main'], ['Riley Laptop', '10.0.10.45', 'Intel', 'wifi', '5 GHz', -57, 3, 'main'], ['Jordan iPad', '10.0.10.57', 'Apple', 'wifi', '5 GHz', -66, 2, 'node'],
    ['Kids Tablet', '10.0.10.58', 'Amazon', 'wifi', '2.4 GHz', -70, 2, 'node'], ['Printer', '10.0.10.60', 'Brother', 'wifi', '2.4 GHz', -64, 3, 'main'], ['Thermostat', '10.0.10.61', 'Ecobee', 'wifi', '2.4 GHz', -72, 2, 'node'],
    ['Office PC', '10.0.10.20', 'ASUSTek', 'wired', null, null, null, 'main'], ['Media Box', '10.0.10.21', 'NVIDIA', 'wired', null, null, null, 'main'], ['Doorbell', '10.0.10.62', 'Ring', 'wifi', '2.4 GHz', -68, 2, 'node'],
    ['Casey Phone', '10.0.10.46', 'Samsung', 'wifi', '5 GHz', -55, 3, 'main'], ['Console', '10.0.10.22', 'Sony', 'wired', null, null, null, 'node'], ['Smart Plug 1', '10.0.10.63', 'TP-Link', 'wifi', '2.4 GHz', -75, 1, 'main'],
  ]
  const devices = devs.map(([name, ip, vendor, connection, band, rssi, bars, node], i) => ({
    key: `dev${i}`, name, ip, mac: `AA:BB:CC:00:${(i + 16).toString(16).padStart(2, '0').toUpperCase()}:0${i % 10}`, vendor, connection, band, rssi, bars,
    onlineSec: Math.round(3600 * (2 + seeded(name) * 220)), node: node === 'main' ? 'Office router' : 'Hall node',
  }))
  const up = (n: string) => devs.filter(d => d[4] === n).length
  return {
    fetchedAt: iso(0), mode: { kind: 'router' as const, label: 'Router', aimesh: 'main' as const }, uplink: null, model: AS.model,
    firmware: { version: '3.0.0.6_102', flavour: 'stock' as const }, update: { available: false, version: null }, uptimeSec: 34 * 86400 + 5400,
    cpuPct: Math.round(wobble(9, 4, 'ascpu')), cpuCores: 4, mem: { totalKiB: 1_048_576, usedKiB: 598_000, pct: 57 },
    wan: { up: true, status: 'Connected', type: 'dhcp', ip: '203.0.113.24', gateway: '203.0.113.1', unit: 0, downBps: Math.round(wobble(46e6, 18e6, 'asd')), upBps: Math.round(wobble(7e6, 3e6, 'asu')) },
    bands: [
      { unit: 0, label: '2.4 GHz', ssid: 'Example-Home', channel: '6', widthMhz: 20, enabled: true, clients: up('2.4 GHz') },
      { unit: 1, label: '5 GHz', ssid: 'Example-Home-5G', channel: '44', widthMhz: 80, enabled: true, clients: up('5 GHz') },
    ],
    mesh: [
      { key: 'main', name: 'Office router', model: AS.model, firmware: '3.0.0.6_102', update: null, main: true, online: true, backhaul: null, rssi: null, bars: null, clients: devs.filter(d => d[7] === 'main').length, ip: '10.0.10.2' },
      { key: 'node1', name: 'Hall node', model: 'ZenWiFi XD4', firmware: '3.0.0.4_388', update: null, main: false, online: true, backhaul: '5 GHz wireless', rssi: -58, bars: 3, clients: devs.filter(d => d[7] === 'node').length, ip: '10.0.10.3' },
    ],
    devices, offlineKnown: 9, health: { level: 'good' as const, reasons: [] }, missing: [],
  }
}
const asusDetail = () => {
  const r = asusReading()
  return { ok: true, tables: [
    { title: 'Devices', empty: 'No devices.', columns: [['name', 'Device'], ['ip', 'Address'], ['conn', 'Connection'], ['band', 'Band']].map(([key, label]) => ({ key, label })), rows: r.devices.map(d => ({ name: d.name, ip: d.ip, conn: d.connection, band: d.band ?? 'wired' })) },
  ] }
}

// =============================================================================== routes
export const PLUGIN_EXTRA_ROUTES: FixtureRoute[] = [
  { path: '/api/plugins/homepage/installs', get: () => ok({ detected: [{ machineId: `lxc-${HP_GUEST.vmid}`, kind: 'lxc', vmid: HP_GUEST.vmid, node: HP_GUEST.node, name: HP_GUEST.name, url: `https://home.${DOMAIN}`, via: ['catalogue', 'proxy'], running: true, connected: 'hp-1' }], instances: [HP_INSTANCE()] }) },
  { path: '/api/plugins/homepage/instances/:id/problems', get: () => ok(hpProblems()) },
  { path: '/api/plugins/homepage/instances/:id/preview', get: () => ok(hpPreview()) },
  { path: '/api/plugins/nextcloud/instances', get: () => ok([NC]) },
  { path: '/api/plugins/nextcloud/instances/:id/reading', get: () => ok({ ok: true, reading: ncReading(), job: ncJob() }) },
  { path: '/api/plugins/nextcloud/instances/:id/jobs/:jid', get: () => ok(ncJob()) },
  { path: '/api/plugins/nextcloud/instances/:id/two-factor', get: () => ok({
    users: PEOPLE.map((uid, i) => ({ uid, state: i % 3 === 2 ? 'off' as const : 'on' as const })), excluded: [], truncated: false, providers: ['totp', 'webauthn'],
    enforcement: { enforced: false, groups: [], excluded: [] }, admins: [{ uid: 'alex', state: 'on' as const }] }) },
  { path: '/api/plugins/nextcloud/candidates', get: () => ok([{ kind: 'lxc', vmid: 202, name: 'nextcloud', node: 'pve-b', running: true }]) },
  { path: '/api/plugins/pbs/instances', get: () => ok([PBS]) },
  { path: '/api/plugins/pbs/instances/:id/reading', get: () => ok({ ok: true, reading: pbsReading() }) },
  { path: '/api/plugins/pbs/instances/:id/detail', get: () => ok({ ok: true, tables: [
    { title: 'Datastores', empty: 'None.', columns: [['store', 'Datastore'], ['used', 'Used'], ['dedup', 'Dedup']].map(([key, label]) => ({ key, label })),
      rows: pbsReading().datastores.map(d => ({ store: d.store, used: `${((d.used ?? 0) / TiB).toFixed(2)} of ${((d.total ?? 0) / TiB).toFixed(1)} TiB`, dedup: d.dedup ? `${d.dedup}x` : '-' })) },
    { title: 'Jobs', empty: 'None.', columns: [['id', 'Job'], ['kind', 'Kind'], ['result', 'Last result']].map(([key, label]) => ({ key, label })), rows: pbsReading().jobs.map(j => ({ id: j.id, kind: j.kind, result: j.result })) },
  ] }) },
  { path: '/api/plugins/pbs/instances/:id/coverage', get: () => ok(pbsCoverage()) },
  { path: '/api/plugins/pbs/instances/:id/snapshots', get: (_p, q) => ok(pbsSnapshots(q)) },
  { path: '/api/plugins/asus/instances', get: () => ok([AS]) },
  { path: '/api/plugins/asus/instances/:id/reading', get: () => ok({ ok: true, reading: asusReading(), name: AS.name, phrase: AS.phrase, lastAction: null }) },
  { path: '/api/plugins/asus/instances/:id/detail', get: () => ok(asusDetail()) },
]

// -- tiles for /plugins and the switcher ----------------------------------------------------------
export const EXTRA_DATA: Record<string, unknown> = {
  get homepage() { return { ok: true, headline: 'In sync', tone: 'good', rows: [{ label: 'Entries', value: '21 in 6 groups' }, { label: 'Last write', value: '47 min ago' }, { label: 'Problems', value: '1', tone: 'warn' }] } },
  get nextcloud() { return { ok: true, headline: '2 warnings · update 30.0.4', tone: 'warn', rows: [{ label: 'Version', value: '30.0.2 (30.0.4 available)', tone: 'warn' }, { label: 'People online', value: String(Math.round(wobble(2, 2, 'nc5'))) }, { label: 'Talk calls', value: String(Math.round(wobble(0.6, 0.6, 'nccall'))) }] } },
  get pbs() { return { ok: true, headline: 'Needs attention', tone: 'warn', rows: [{ label: 'main', value: '33% used · 19 groups' }, { label: 'Stale', value: '1 group', tone: 'warn' }, { label: 'Offsite sync', value: 'failed last night', tone: 'bad' }] } },
  get asus() { const bps = Math.round(wobble(46e6, 18e6, 'asd')); return { ok: true, headline: `↓ ${(bps / 1e6).toFixed(0)} Mbps · 14 devices`, tone: 'good', rows: [{ label: 'Internet', value: 'connected', tone: 'good' }, { label: 'Devices', value: '14 awake' }, { label: 'Mesh', value: '2 nodes online' }] } },
}
export const EXTRA_DETAIL: Record<string, () => unknown> = {
  homepage: () => ({ ok: true, stats: (EXTRA_DATA.homepage as any).rows, tables: [] }),
  nextcloud: () => ({ ok: true, stats: (EXTRA_DATA.nextcloud as any).rows, tables: [] }),
  pbs: () => ({ ok: true, stats: (EXTRA_DATA.pbs as any).rows, tables: [] }),
  asus: () => ({ ok: true, stats: (EXTRA_DATA.asus as any).rows, tables: [] }),
}
void HOUR
