// Shapes follow packages/types/src/updates.ts (not imported: the API build does not reach outside apps/api).
type UpdatesPkgChange = { name: string; from: string | null; to: string; security?: boolean }
type PlanStep = { seq: number; target: string; action: string; detail?: string }

// Demo fixtures: updates, catalogue, AI, the Deck (terminal), settings, secrets, API tokens, notifications, setup.
import type { FixtureRoute } from './types'
import { NODES, GUESTS, DOMAIN, DEMO_OWNER, REMOTE, CLUSTER_NAME, iso, HOUR, DAY, MIN, GiB, fingerprint } from './data'

const ok = (data: unknown) => ({ success: true, data })
const HOME = { id: 'home', name: CLUSTER_NAME, kind: 'home' as const }

// -- Updates ---------------------------------------------------------------------------------------
const PKGS: UpdatesPkgChange[] = [
  { name: 'pve-manager', from: '9.1.2', to: '9.1.4' }, { name: 'proxmox-kernel-6.17', from: '6.17.2-1', to: '6.17.4-1' },
  { name: 'openssl', from: '3.5.1-1', to: '3.5.1-1+deb13u1', security: true }, { name: 'libssl3t64', from: '3.5.1-1', to: '3.5.1-1+deb13u1', security: true },
  { name: 'ceph-common', from: '19.2.3-pve2', to: '19.2.3-pve3' }, { name: 'curl', from: '8.14.1-2', to: '8.14.1-2+deb13u1', security: true },
  { name: 'tzdata', from: '2025b-4', to: '2025c-0+deb13u1' },
]
function inventory() {
  return {
    refreshedAt: iso(8 * HOUR), cluster: HOME,
    nodes: NODES.map((n, i) => ({
      node: n.node, online: true, pending: PKGS.slice(0, 7 - i), cephPending: i < 2, kernelPending: i < 2, rebootRequired: false, rebootPending: false,
      policy: { upgrade: 'dist-upgrade', reboot: 'manual', order: i === 0 ? 'last' : undefined }, holdsOk: null, pinOk: null, isSelf: n.node === 'pve-a',
    })),
    guests: GUESTS.map(x => {
      const win = x.name === 'windows-11', haos = x.name === 'home-assistant'
      const pending: UpdatesPkgChange[] = x.status !== 'running' || win || haos ? [] : x.vmid % 3 === 0 ? [PKGS[2], PKGS[3], PKGS[5]] : x.vmid % 3 === 1 ? [PKGS[6]] : []
      return {
        vmid: x.vmid, type: x.type, name: x.name, node: x.node, running: x.status === 'running',
        managed: x.status === 'running' && !win && !haos, unmanagedReason: win ? 'windows' : haos ? 'no-apt' : x.status !== 'running' ? 'not-running' : undefined,
        pending, rebootRequired: false, haManaged: !!x.ha, snapshotCapable: true,
        docker: ['nextcloud', 'immich', 'arr-stack'].includes(x.name) ? 'auto' : 'none',
        dockerImages: x.name === 'immich' ? [{ image: 'ghcr.io/immich-app/immich-server', current: 'v2.2.1', latest: 'v2.2.3' }] : undefined,
        lastBackup: { at: iso(5 * HOUR), ok: true, thisGuest: true },
      }
    }),
  }
}
function plan() {
  const steps: PlanStep[] = []
  let seq = 1
  for (const x of GUESTS.filter(g => g.status === 'running' && g.type === 'lxc').slice(0, 6)) {
    steps.push({ seq: seq++, target: String(x.vmid), action: 'snapshot', detail: `snapshot pre-update before changing ${x.name}` })
    steps.push({ seq: seq++, target: String(x.vmid), action: 'apt', detail: 'apt-get upgrade' })
  }
  for (const n of [...NODES].reverse()) steps.push({ seq: seq++, target: n.node, action: 'node-upgrade', detail: 'dist-upgrade, one node at a time; guests stay where they are' })
  return { steps, warnings: ['pve-a runs HyperProx itself, so it is upgraded last.'], scope: 'all', cluster: HOME }
}
function jobs() {
  const done = (d: number) => ({
    id: `job-${d}`, trigger: d % 2 ? 'schedule' : 'manual', status: 'done', plan: plan(),
    report: { summary: `Updates done: ${12 - d} ok, 1 skipped, 0 failed.`, changed: GUESTS.slice(0, 5).map(x => ({ target: String(x.vmid), packages: 2 + (x.vmid % 4) })), skipped: [{ target: '307', reason: 'not running' }], rebootsPending: [] },
    startedAt: iso(d * 7 * DAY), finishedAt: iso(d * 7 * DAY - 24 * MIN), steps: [],
  })
  return [done(1), done(2), done(3)]
}
const policy = () => ({
  loaded: true, path: 'config/updates.yaml', cluster: HOME,
  schedule: { enabled: true, cron: '0 4 * * 3', nextRun: new Date(Date.now() + 2 * DAY).toISOString(), windowHours: 3 },
  check: { enabled: true, cron: '30 6 * * *', nextRun: new Date(Date.now() + 10 * HOUR).toISOString(), reminderDays: 7 },
  sections: [{ cluster: HOME, section: null }, { cluster: { id: REMOTE.id, name: REMOTE.name, kind: 'remote' }, section: null }],
})
const checkStatus = () => ({
  running: false, lastRun: iso(8 * HOUR), nextRun: new Date(Date.now() + 10 * HOUR).toISOString(), lastNotified: iso(8 * HOUR), blocked: null, manualAfter: null,
  clusters: [
    { cluster: HOME, at: iso(8 * HOUR), result: 'ok', lastOkAt: iso(8 * HOUR), targets: [], unread: [], available: 14, packages: 23, security: 3 },
    { cluster: { id: REMOTE.id, name: REMOTE.name, kind: 'remote' }, at: iso(8 * HOUR), result: 'ok', lastOkAt: iso(8 * HOUR), targets: [], unread: [], available: 6, packages: 9, security: 1 },
  ],
})

// -- Catalogue -------------------------------------------------------------------------------------
const recipe = (id: string, name: string, category: string, summary: string, port: number, cores: number, memoryMb: number, diskGb: number, extra: Record<string, unknown> = {}) => ({
  id, name, category, summary, port, needsDocker: true, needsGpu: false, firstRunKind: 'setup-url', healthPath: '/', firstLogin: null, notes: [],
  defaults: { cores, memoryMb, diskGb, swapMb: 512 }, minimum: { cores: 1, memoryMb: Math.min(512, memoryMb), diskGb: Math.min(8, diskGb) }, satisfies: null, installedAt: null, ...extra,
})
const catalogue = () => ({
  canInstall: true,
  nodes: NODES.map(n => ({ node: n.node, address: n.ip, hasLogin: true })),
  recipes: [
    recipe('nginx-proxy-manager', 'Nginx Proxy Manager', 'proxy', 'A reverse proxy with a web UI and Let’s Encrypt built in. HyperProx drives it for proxy hosts and certificates.', 81, 2, 1024, 8, { firstRunKind: 'none', installedAt: `https://proxy.${DOMAIN}` }),
    recipe('ollama', 'Ollama', 'ai', 'Runs open models locally. Gives the deployment wizard a provider that costs nothing and sends nothing off the box.', 11434, 4, 8192, 40, { needsDocker: false, firstRunKind: 'none' }),
    recipe('tautulli', 'Tautulli', 'media', 'Watch history and statistics for Plex. The Plex plug-in reads it for who watched what, and when.', 8181, 1, 1024, 8, { firstRunKind: 'none', installedAt: 'http://10.0.3.11:8181' }),
    recipe('nextcloud', 'Nextcloud', 'apps', 'Files, calendar and contacts you host yourself.', 80, 2, 2048, 32, { installedAt: `https://cloud.${DOMAIN}` }),
    recipe('jellyfin', 'Jellyfin', 'media', 'A media server for your own films and shows.', 8096, 2, 2048, 16),
    recipe('vaultwarden', 'Vaultwarden', 'apps', 'A Bitwarden-compatible password server.', 80, 1, 512, 8, { firstRunKind: 'env-admin' }),
    recipe('gitea', 'Gitea', 'apps', 'A lightweight Git service with a web UI.', 3000, 1, 1024, 16, { installedAt: `https://git.${DOMAIN}` }),
    recipe('uptime-kuma', 'Uptime Kuma', 'monitoring', 'Watches your services and tells you when one goes down.', 3001, 1, 512, 8),
    recipe('homepage', 'Homepage', 'apps', 'A start page that links to everything you run.', 3000, 1, 512, 8, { firstRunKind: 'none' }),
    recipe('grafana', 'Grafana', 'monitoring', 'Dashboards for metrics and logs.', 3000, 1, 1024, 8, { firstRunKind: 'env-admin' }),
  ],
  // The website recipes, for the Websites section's New website tab (the catalogue does not list them).
  websites: [
    recipe('static-site', 'Static site', 'web', 'A static website served by nginx, pulled from a Git repository.', 80, 1, 512, 4, { needsDocker: false, firstRunKind: 'none' }),
    recipe('wordpress', 'WordPress', 'web', 'WordPress on nginx, PHP-FPM and MariaDB.', 80, 1, 1024, 10, { needsDocker: false, firstRunKind: 'none' }),
  ],
})

/** Where catalogue apps already run on the invented cluster (GET /api/catalogue/detected). */
const detected = () => ({
  apps: {
    nextcloud: [{ guest: { vmid: 215, name: 'files', node: 'pve-a', type: 'lxc', status: 'running' }, target: '10.0.2.25:80', publicUrl: `https://files.${DOMAIN}`, domains: [`files.${DOMAIN}`], version: '30.0.2', via: 'probe' }],
    gitea: [{ guest: { vmid: 204, name: 'gitea', node: 'pve-b', type: 'lxc', status: 'running' }, target: '10.0.2.14:3000', publicUrl: `https://git.${DOMAIN}`, domains: [`git.${DOMAIN}`], version: '1.22.3', via: 'probe' }],
  },
  builtAt: Date.now(), probed: 6, errors: [],
})

// -- AI --------------------------------------------------------------------------------------------
const aiStatus = () => ({ connected: true, managed: true, url: 'http://127.0.0.1:11434', models: [
  { name: 'qwen3:8b', model: 'qwen3:8b', modified_at: iso(12 * DAY), size: Math.round(5.2 * GiB), digest: fingerprint('qwen', 32).replace(/:/g, '').toLowerCase(),
    details: { parent_model: '', format: 'gguf', family: 'qwen3', families: ['qwen3'], parameter_size: '8.2B', quantization_level: 'Q4_K_M', context_length: 40960, embedding_length: 4096 }, capabilities: ['completion', 'tools', 'thinking'] },
] })
const aiCatalog = () => ({ ok: true, hardware: { totalRamGB: 224, maxVramGB: 12, totalCores: 48 }, recommended: ['qwen3:8b', 'llama3.1:8b'],
  catalog: [
    ['llama3.2:3b', 'Llama 3.2 3B', 'Small and quick. Good for short answers on modest hardware.', '3B', 3, 3, 2.0, 'small', false],
    ['qwen3:8b', 'Qwen3 8B', 'Strong tool use for its size. A good default for the deployment wizard.', '8B', 8, 6, 5.2, 'medium', true],
    ['llama3.1:8b', 'Llama 3.1 8B', 'A dependable general model with a long context.', '8B', 8, 6, 4.9, 'medium', true],
    ['qwen3:14b', 'Qwen3 14B', 'Better plans, slower. Wants a 12 GB GPU.', '14B', 16, 11, 9.3, 'large', true],
    ['gpt-oss:20b', 'gpt-oss 20B', 'Open-weight reasoning model. Needs plenty of memory.', '20B', 24, 16, 14, 'large', false],
  ].map(([id, name, description, params, ramGB, vramGB, sizeGB, tier, good]) => ({ id, name, description, params, ramGB, vramGB, sizeGB, tier, strengths: [], good_for_wizard: good, tags: [],
    recommended: id === 'qwen3:8b', installed: id === 'qwen3:8b', fits_gpu: (vramGB as number) <= 12, fits_cpu: true })) })
const aiProviders = () => ({ ok: true, active: 'ollama', providers: [
  { id: 'anthropic', name: 'Anthropic', kind: 'cloud', configured: false, model: null, missing: ['API key'], note: 'Constrains the plan against the schema natively, so malformed plans are not a failure mode.' },
  { id: 'openai', name: 'OpenAI', kind: 'cloud', configured: false, model: null, missing: ['API key'], note: 'Also reaches any OpenAI-compatible endpoint: set a base URL for a hosted or local server.' },
  { id: 'ollama', name: 'Ollama', kind: 'local', configured: true, model: 'qwen3:8b', missing: [], note: 'Free and private. Small models produce weaker plans; the output is validated before you see it.' },
] })

// -- Deck (terminal) -------------------------------------------------------------------------------
const termHosts = () => [
  ...NODES.map(n => ({ id: `node-${n.node}`, name: n.node, vmid: 0, node: n.node, type: 'manual' as const, status: 'online', ip: n.ip, port: 22, hasCredential: true, source: 'cluster' as const, hint: 'Proxmox node' })),
  ...GUESTS.map(x => ({ id: `${x.type}-${x.vmid}`, name: x.name, vmid: x.vmid, node: x.node, type: x.type, status: x.status, ip: x.ip, port: 22, hasCredential: x.type === 'lxc' && x.status === 'running', source: 'cluster' as const })),
  { id: 'plugin-mikrotik', name: 'core-router', vmid: 0, node: '', type: 'manual' as const, status: 'online', ip: '10.0.0.1', port: 22, hasCredential: false, source: 'plugin' as const, hint: 'Router console' },
]

// -- Settings --------------------------------------------------------------------------------------
const MASK = '••••••••'
const field = (provider: string, key: string, label: string, value: string | null, masked = false) =>
  ({ provider, key, label, value: value === null ? '' : masked ? MASK : value, masked, isSet: value !== null, decryptFailed: false })
const SETTINGS: Record<string, unknown[]> = {
  proxmox: [field('proxmox', 'host', 'Host IP', '10.0.0.11'), field('proxmox', 'port', 'Port', '8006'), field('proxmox', 'user', 'User', 'hyperprox@pve'), field('proxmox', 'token_id', 'Token ID', 'main'), field('proxmox', 'token_secret', 'Token Secret', 'set', true)],
  proxy: [field('npm', 'url', 'NPM URL', `https://proxy.${DOMAIN}`), field('npm', 'email', 'Email', `admin@${DOMAIN}`), field('npm', 'password', 'Password', 'set', true)],
  dns: [field('cloudflare', 'api_token', 'API Token', 'set', true), field('cloudflare', 'email', 'Email', `admin@${DOMAIN}`), field('godaddy', 'api_key', 'API Key', null), field('godaddy', 'api_secret', 'API Secret', null, true)],
  remote: [field('tailscale', 'api_token', 'API access token', 'set', true), field('tailscale', 'tailnet', 'Tailnet (blank: your own)', null), field('tailscale', 'default_tags', 'Default tags, e.g. tag:server', 'tag:server')],
  system: [field('hyperprox', 'app_url', 'App URL', `https://hyperprox.${DOMAIN}`), field('grafana', 'admin_password', 'Grafana admin password', 'set', true)],
}

const secrets = () => ({ ok: true, data: [
  { name: 'proxmox / token_secret', updatedAt: iso(40 * DAY), managed: true, fields: ['password'] },
  { name: 'npm / password', updatedAt: iso(31 * DAY), managed: true, fields: ['password'] },
  { name: 'cloudflare / api_token', updatedAt: iso(20 * DAY), managed: true, fields: ['password'] },
  { name: 'tailscale / api_token', updatedAt: iso(12 * DAY), managed: true, fields: ['password'] },
  { name: 'plugin / home-assistant / token', updatedAt: iso(9 * DAY), managed: true, fields: ['password'] },
  { name: 'plugin / plex / apikey', updatedAt: iso(9 * DAY), managed: true, fields: ['password'] },
  { name: 'backup-server root', updatedAt: iso(60 * DAY), managed: false, fields: ['username', 'password'] },
] })

const tokens = () => [
  { id: 'tok1', name: 'backup-report', role: 'viewer', createdBy: DEMO_OWNER.email, createdAt: iso(45 * DAY), lastUsedAt: iso(6 * HOUR), expiresAt: new Date(Date.now() + 320 * DAY).toISOString(), revokedAt: null, state: 'active' },
  { id: 'tok2', name: 'home-dashboard', role: 'viewer', createdBy: DEMO_OWNER.email, createdAt: iso(30 * DAY), lastUsedAt: iso(2 * MIN), expiresAt: null, revokedAt: null, state: 'active' },
  { id: 'tok3', name: 'ci-deploy', role: 'operator', createdBy: 'sam@example.com', createdAt: iso(90 * DAY), lastUsedAt: iso(70 * DAY), expiresAt: iso(10 * DAY), revokedAt: null, state: 'expired' },
]

const channel = (id: string, name: string, kind: string, minSeverity: string, mask: string, extra: Record<string, unknown> = {}) => ({
  id, name, kind, enabled: true, minSeverity, eventFilter: 'all', quietHours: null, lanOverride: false, usableWhileLocked: kind !== 'telegram', private: true, chatId: null,
  mask, secretReadable: false, hasToken: false, hasSigningSecret: false, lastResult: { at: iso(3 * HOUR), ok: true, status: 204, text: 'Delivered (HTTP 204)' }, lastSentAt: iso(3 * HOUR),
  failingSince: null, seededFrom: null, createdBy: DEMO_OWNER.email, createdAt: iso(40 * DAY), updatedAt: iso(10 * DAY), ...extra,
})
const notifyChannels = () => ({ ok: true,
  channels: [channel('ch1', 'Phone (ntfy)', 'ntfy', 'warning', `ntfy.${DOMAIN}/••••rack`), channel('ch2', 'Homelab Discord', 'discord', 'info', 'discord.com/…/••••Xa9Q'), channel('ch3', 'Lock alerts', 'webhook', 'critical', `hooks.${DOMAIN}/••••lock`)],
  meta: { kinds: ['discord', 'slack', 'teams', 'ntfy', 'gotify', 'telegram', 'webhook'], families: ['vault', 'updates', 'certs', 'jobs', 'backups', 'resources', 'vpn', 'home'], selfHostable: ['ntfy', 'gotify', 'webhook'], lockedOk: ['discord', 'slack', 'teams', 'ntfy', 'gotify', 'webhook'], canSetUsableWhileLocked: true, publicUrlSet: true } })
const deliveries = () => ({ ok: true, deliveries: [
  ['updates.available', 'info', 'Updates: 14 machines have 23 updates (3 security)', 'ch2', 8 * HOUR], ['backups.done', 'info', 'Backup finished: 17 guests, 0 failed', 'ch2', 5 * HOUR],
  ['resources.disk', 'warning', 'minecraft: disk 72% full and growing', 'ch1', 3 * HOUR], ['certs.renewed', 'info', `Renewed *.example.net`, 'ch2', 51 * DAY],
].map(([type, severity, title, channelId, ago], i) => ({ id: `d${i}`, channelId, type, severity, title, status: 'sent', attempts: 1, httpStatus: 204, errorCode: null, createdAt: iso(ago as number), sentAt: iso(ago as number), text: 'Delivered (HTTP 204)' })) })

const row = (node: string, state: string, reason: string) => ({ node, state, reason })
const setupChecklist = () => ({
  summary: 'Found 3 nodes. pve-a: AMD Radeon Vega 8; pve-b: Intel UHD Graphics 770; pve-c: NVIDIA GeForce RTX 3060. Health monitoring is running on all of them.',
  nodes: NODES.map(n => ({ node: n.node, source: 'probe', gpus: n.gpu ? [{ vendor: n.gpu.vendor, kind: n.gpu.dedicated ? 'dedicated' : 'integrated', id: n.gpu.deviceId, name: n.gpu.name }] : [],
    renderNodes: [], dri: ['card0', 'renderD128'], nvidiaSmi: n.gpu?.vendor === 'nvidia', rapl: 'readable', raplDomains: ['package', 'core'], nodeExporter: 'running', docker: true, python3: true,
    intelGpuTop: n.gpu?.vendor === 'intel', intelExporter: n.gpu?.vendor === 'intel' ? 'running' : 'absent', nvidiaExporter: n.gpu?.vendor === 'nvidia' ? 'running' : 'absent', amdMetrics: n.gpu?.vendor === 'amd' ? 'on' : 'off',
    ceph: true, arch: 'x86_64', pve: '9.1.2', igpuAccess: n.gpu?.dedicated ? 'n/a' : 'open', igpuRule: !n.gpu?.dedicated })),
  logins: Object.fromEntries(NODES.map(n => [n.node, true])),
  items: [
    { id: 'node-health', ask: 'Do you want HyperProx to watch the health of each of your nodes (CPU, memory, disks)?', what: 'Installs node_exporter on every node. It answers on port 9100.', notes: [], rows: NODES.map(n => row(n.node, 'done', 'answering on port 9100')), state: 'done', needsNodeLogin: true, action: null },
    { id: 'power', ask: 'Do you want HyperProx to monitor the power on each of your nodes?', what: 'Lets HyperProx read the CPU energy counters.', notes: [], rows: NODES.map(n => row(n.node, 'done', 'energy counters readable')), state: 'done', needsNodeLogin: true, action: null },
    { id: 'gpu', ask: 'Do you want HyperProx to monitor your GPUs?', what: 'Intel and NVIDIA GPUs get a small exporter (ports 8081, 9835); AMD GPUs are read by node_exporter. Drivers are never touched.', notes: [], rows: NODES.map(n => row(n.node, 'done', `${n.gpu?.name}: monitored`)), state: 'done', needsNodeLogin: true, action: null },
    { id: 'charts', ask: 'Do you want charts and dashboards (Prometheus and Grafana)?', what: 'Runs Prometheus and Grafana on this machine. You reach them only through HyperProx.', notes: [], rows: [], state: 'done', needsNodeLogin: false, action: null },
    { id: 'dns', ask: 'Do you manage your domains at a DNS provider? Paste a key to let HyperProx manage DNS.', what: 'The key is kept in the vault. You can skip this and add it later.', notes: [], rows: [], state: 'done', needsNodeLogin: false, action: 'Replace the key' },
    { id: 'ai', ask: 'Do you want a local AI assistant?', what: 'Runs Ollama here and downloads a small model.', notes: [], rows: [], state: 'done', needsNodeLogin: false, action: null },
    { id: 'host-keys', ask: 'Are your nodes\' SSH host keys verified?', what: 'HyperProx sends a node its login only when the node shows a key that is verified or confirmed.', notes: [],
      rows: NODES.map(n => ({ node: n.node, host: n.ip, port: 22, fingerprint: `SHA256:${Buffer.from(fingerprint(n.node + 'ssh', 32).replace(/:/g, ''), 'hex').toString('base64').replace(/=+$/, '')}`, state: 'done', reason: 'verified against the Proxmox API' })), state: 'done', needsNodeLogin: false, action: null },
  ],
  running: null,
})

export const APPS: FixtureRoute[] = [
  { path: '/api/updates/check', get: () => checkStatus() },
  { path: '/api/updates/policy', get: () => policy() },
  { path: '/api/updates/plan', get: () => plan() },
  { path: '/api/updates/inventory', get: () => inventory() },
  { path: '/api/updates/jobs', get: () => ({ jobs: jobs() }) },
  { path: '/api/updates/jobs/:id', get: p => ({ job: jobs().find(j => j.id === p.id) ?? jobs()[0] }) },
  { path: '/api/updates/nodes/:node/reboot-preview', get: p => ({ node: p.node, guests: [], moves: [], ok: true }) },
  { path: '/api/catalogue', get: () => ok(catalogue()) },
  { path: '/api/catalogue/detected', get: () => ok(detected()) },
  { path: '/api/catalogue/wizard/jobs', get: () => ok({ jobs: [] }) },
  { path: '/api/catalogue/wizard/settings', get: () => ok({ vmidRule: { kind: 'node-prefix' } }) },
  { path: '/api/catalogue/jobs/:jobId', get: () => ok({ state: 'done' }) },
  { path: '/api/ai/status', get: () => aiStatus() },
  { path: '/api/ai/catalog', get: () => aiCatalog() },
  { path: '/api/ai/providers', get: () => aiProviders() },
  { path: '/api/ai/detect', get: () => ({ ok: true, found: [] }) },
  { path: '/api/terminal/hosts', get: () => ok(termHosts()) },
  { path: '/api/terminal/credentials', get: () => ok({ shared: true, hosts: termHosts().filter(h => h.hasCredential).map(h => h.id) }) },
  { path: '/api/terminal/layouts', get: () => ok([{ name: 'media', panes: ['lxc-301', 'lxc-302', 'lxc-303'], updatedAt: iso(4 * DAY) }]) },
  { path: '/api/terminal/manual-hosts', get: () => ok([]) },
  { path: '/api/settings/providers', get: () => ok({ dns: ['cloudflare', 'godaddy', 'namecheap'], proxy: ['npm'] }) },
  { path: '/api/settings/:category', get: p => ok(SETTINGS[p.category] ?? []) },
  { path: '/api/secrets', get: () => secrets() },
  { path: '/api/auth/tokens', get: () => ok(tokens()) },
  { path: '/api/settings/notifications/channels', get: () => notifyChannels() },
  { path: '/api/settings/notifications/deliveries', get: () => deliveries() },
  { path: '/api/setup-checklist', get: () => ok(setupChecklist()) },
  { path: '/api/setup-checklist/jobs/:id', get: () => ok({ state: 'done' }) },
]
