// Demo fixtures: certificates, DNS, reverse proxy, VPN and remote access.
import type { FixtureRoute } from './types'
import { DOMAIN, DOMAIN2, WAN_IP, GUESTS, NODES, iso, HOUR, DAY, MIN, fingerprint, seeded } from './data'

const ok = (data: unknown) => ({ success: true, data })

// -- Proxy hosts ------------------------------------------------------------------------------------
const HOSTS: Array<[string, number, number, boolean]> = [
  // [subdomain, guest vmid, port, websockets]
  ['cloud', 202, 80, true], ['photos', 203, 2283, true], ['git', 204, 3000, false], ['home', 201, 8123, true], ['plex', 301, 32400, true],
  ['requests', 302, 5055, false], ['vault', 103, 80, true], ['mesh', 105, 443, true], ['hyperprox', 104, 443, true], ['status', 104, 3001, false],
  ['dns', 102, 3000, false], ['play', 305, 8100, false],
]
export function proxyHosts() {
  return HOSTS.map(([sub, vmid, port, ws], i) => {
    const g = GUESTS.find(x => x.vmid === vmid)!
    const domain = `${sub}.${i % 5 === 4 ? DOMAIN2 : DOMAIN}`
    const exp = new Date(Date.now() + (12 + Math.floor(seeded(sub) * 70)) * DAY).toISOString().slice(0, 19).replace('T', ' ')
    return {
      id: String(10 + i), domains: [domain], forwardScheme: port === 443 ? 'https' : 'http', forwardHost: g.ip, forwardPort: port, enabled: true, owned: true,
      tls: { kind: 'certificate', certificateId: String(40 + i), certificateName: domain, expiresAt: exp, forced: true }, online: true, websockets: ws,
      options: { certificate_id: 40 + i, ssl_forced: true, block_exploits: true, http2_support: true, hsts_enabled: true, hsts_subdomains: false, caching_enabled: false, advanced_config: '' },
      instanceId: 'npm', instanceName: 'Nginx Proxy Manager', kind: 'npm', readOnly: false,
    }
  })
}

// -- Certificates ----------------------------------------------------------------------------------
function certsOverview() {
  const hosts = proxyHosts()
  const inventory = hosts.map((h, i) => {
    const notAfter = new Date(h.tls.expiresAt.replace(' ', 'T') + 'Z'), daysLeft = Math.round((notAfter.getTime() - Date.now()) / DAY)
    return { id: `npm:${h.tls.certificateId}`, source: 'npm', names: h.domains, issuer: "Let's Encrypt", notBefore: new Date(notAfter.getTime() - 90 * DAY).toISOString(), notAfter: notAfter.toISOString(),
      lifetimeDays: 90, daysLeft, renewal: 'Proxy (HTTP-01)', selfSigned: false, staging: false, verdict: daysLeft < 21 ? 'warn' : 'ok', reason: daysLeft < 21 ? `Renews in ${daysLeft} days` : null, usedBy: h.domains, _i: i }
  }).map(({ _i, ...r }) => r)
  inventory.push({ id: 'pve:pve-a', source: 'proxmox', names: ['pve-a.lan'], issuer: 'Proxmox Virtual Environment', notBefore: iso(400 * DAY), notAfter: new Date(Date.now() + 330 * DAY).toISOString(),
    lifetimeDays: 730, daysLeft: 330, renewal: 'Proxmox (self-signed)', selfSigned: true, staging: false, verdict: 'info', reason: 'Self-signed: browsers warn, HyperProx pins it', usedBy: ['https://10.0.0.11:8006'] })
  const probes = hosts.slice(0, 8).map(h => ({ host: h.domains[0], port: 443, starttls: 'none', source: 'proxy', internal: false, checkedAt: iso(5 * HOUR), verdict: 'ok', reason: null,
    fingerprint: fingerprint(h.domains[0]), issuer: "C=US, O=Let's Encrypt, CN=R11", notAfter: new Date(h.tls.expiresAt.replace(' ', 'T') + 'Z').toISOString(), trusted: true, namesMatch: true }))
  const managed = [
    { label: 'hyperprox', names: [`hyperprox.${DOMAIN}`], status: 'valid', issuer: "Let's Encrypt R11", notBefore: iso(20 * DAY), notAfter: new Date(Date.now() + 70 * DAY).toISOString(),
      renewAfter: new Date(Date.now() + 40 * DAY).toISOString(), ariStart: null, ariEnd: null, staging: false, lastError: null,
      dns: [{ name: `hyperprox.${DOMAIN}`, zone: DOMAIN, provider: 'cloudflare' }], targets: [{ name: 'self', kind: 'hyperprox', lastDeployAt: iso(20 * DAY), lastResult: 'serving the new certificate on port 443', verdict: 'ok' }] },
    { label: 'wildcard', names: [`*.${DOMAIN2}`, DOMAIN2], status: 'valid', issuer: "Let's Encrypt R10", notBefore: iso(51 * DAY), notAfter: new Date(Date.now() + 39 * DAY).toISOString(),
      renewAfter: new Date(Date.now() + 9 * DAY).toISOString(), ariStart: null, ariEnd: null, staging: false, lastError: null,
      dns: [{ name: `*.${DOMAIN2}`, zone: DOMAIN2, provider: 'cloudflare' }], targets: [{ name: 'proxy', kind: 'npm', lastDeployAt: iso(51 * DAY), lastResult: 'uploaded to Nginx Proxy Manager', verdict: 'ok' }] },
  ]
  return {
    policy: { loaded: true, path: 'config/certs.yaml', acme: { directory: 'https://acme-v02.api.letsencrypt.org/directory', staging: false, email: `admin@${DOMAIN}` }, schedule: { cron: '15 6 * * *', nextRun: new Date(Date.now() + 9 * HOUR).toISOString() } },
    inventory, probes, managed, checkedAt: iso(5 * HOUR),
  }
}
function certEvents() {
  return { events: [
    { id: 'ev1', label: null, kind: 'probe', ok: true, detail: 'Daily check: 13 certificates, none expiring within 21 days', at: iso(5 * HOUR) },
    { id: 'ev2', label: 'wildcard', kind: 'renew', ok: true, detail: `Renewed *.${DOMAIN2} with DNS-01 (Cloudflare)`, at: iso(51 * DAY) },
    { id: 'ev3', label: 'hyperprox', kind: 'deploy', ok: true, detail: 'Deployed to HyperProx itself and reloaded nginx', at: iso(20 * DAY) },
    { id: 'ev4', label: 'hyperprox', kind: 'renew', ok: true, detail: `Renewed hyperprox.${DOMAIN}`, at: iso(20 * DAY + 2 * MIN) },
  ] }
}

// -- DNS -------------------------------------------------------------------------------------------
function domains() {
  return [DOMAIN, DOMAIN2].map((domain, i) => ({ domain, domainId: 1000 + i, status: 'ACTIVE', createdAt: iso((900 + i * 200) * DAY), expires: new Date(Date.now() + (140 + i * 90) * DAY).toISOString(),
    renewAuto: true, renewable: true, locked: true, privacy: true, expirationProtected: false, exposeWhois: false, holdRegistrar: false, transferProtected: false, nameServers: null,
    renewDeadline: new Date(Date.now() + (180 + i * 90) * DAY).toISOString(), registrarCreatedAt: iso((900 + i * 200) * DAY) }))
}
function records(domain: string) {
  const base = [
    { type: 'A', name: '@', data: WAN_IP, ttl: 1800 },
    ...proxyHosts().filter(h => h.domains[0].endsWith(domain)).map(h => ({ type: 'CNAME', name: h.domains[0].replace(`.${domain}`, ''), data: '@', ttl: 3600 })),
    { type: 'MX', name: '@', data: `mail.${domain}`, ttl: 3600, priority: 10 },
    { type: 'TXT', name: '@', data: 'v=spf1 mx -all', ttl: 3600 },
    { type: 'NS', name: '@', data: 'ns1.example-dns.net', ttl: 3600 },
    { type: 'NS', name: '@', data: 'ns2.example-dns.net', ttl: 3600 },
  ]
  return base
}

// -- Proxy instances and kinds ---------------------------------------------------------------------
const proxyInstances = () => [{ id: 'npm', kind: 'npm', name: 'Nginx Proxy Manager', mode: 'byo', managed: null, legacy: false, createdBy: 'settings', createdAt: iso(200 * DAY), updatedAt: iso(20 * DAY),
  url: `https://proxy.${DOMAIN}`, settings: { email: `admin@${DOMAIN}` }, status: 'ok', kindLabel: 'Nginx Proxy Manager', secretsSet: ['password'] }]
const proxyKinds = () => [
  { kind: 'npm', label: 'Nginx Proxy Manager', urlLabel: 'NPM URL', urlHint: 'http://192.0.2.10:81', fields: [{ key: 'email', label: 'Email', secret: false, required: true }, { key: 'password', label: 'Password', secret: true, required: true }], notes: [] },
  { kind: 'caddy', label: 'Caddy', urlLabel: 'Admin API URL', urlHint: 'http://192.0.2.10:2019', fields: [], notes: [] },
  { kind: 'traefik', label: 'Traefik', urlLabel: 'API URL', urlHint: 'http://192.0.2.10:8080', fields: [], notes: ['Read-only: Traefik reads its routes from its own providers.'] },
]

// -- VPN and remote access --------------------------------------------------------------------------
const cell = (state: string, extra: Record<string, unknown> = {}) => ({
  state, managed: false, ip: null, version: null, lastSeen: null, deviceName: null, mode: null, routes: [], exitNode: false, lastError: null, adopted: false, dnsName: null,
  expiresAt: null, expiryWarning: false, keyExpiryDisabled: false, pending: false, tags: [], prefs: null, loginPending: false, detected: null, detectedText: null, checkedAt: null, ...extra,
})
function remoteOverview() {
  const ts = (name: string, n: number, managed = true, extra: Record<string, unknown> = {}) => cell('connected', { managed, ip: `100.88.0.${n}`, version: '1.90.6', lastSeen: iso(MIN), deviceName: `${name}.tail0demo.ts.net`, dnsName: `${name}.tail0demo.ts.net`, keyExpiryDisabled: true, checkedAt: iso(4 * MIN), ...extra })
  const machines = [
    ...NODES.map((n, i) => ({ id: `node-${n.node}`, kind: 'node', name: n.node, node: n.node, running: true, address: n.ip, self: false,
      cells: { tailscale: ts(n.node, 10 + i, true, i === 0 ? { routes: ['10.0.0.0/16'], mode: 'subnet-router' } : {}), netbird: cell('unchecked') } })),
    ...GUESTS.filter(x => x.status === 'running').slice(0, 12).map((x, i) => ({ id: `${x.type}-${x.vmid}`, kind: x.type, name: x.name, node: x.node, running: true, address: x.ip, self: x.name === 'hyperprox',
      cells: { tailscale: ['hyperprox', 'home-assistant', 'nextcloud', 'gitea'].includes(x.name) ? ts(x.name, 20 + i) : x.name === 'wireguard' ? cell('manual', { detectedText: 'WireGuard server found in the guest' }) : cell('not-installed'), netbird: cell('unchecked') } })),
  ]
  return {
    providers: [
      { id: 'tailscale', label: 'Tailscale', configured: true, error: null, devices: 11, onTailnet: 7, summary: null },
      { id: 'netbird', label: 'NetBird', configured: false, error: null, devices: 0, onTailnet: 0, summary: 'Add a NetBird API key to install it and approve devices' },
    ],
    machines, activeJobId: null, detection: { checkedAt: iso(4 * MIN), running: false }, attention: [], pendingRevokes: 0, pendingDevices: [],
  }
}
const wgKey = (k: string) => Buffer.from(fingerprint(k, 32).replace(/:/g, ''), 'hex').toString('base64')
function wg() {
  return {
    servers: [{ id: 'wg1', machineId: 'lxc-205', iface: 'wg0', listenPort: 51820, address: '10.8.0.1/24', endpoint: `vpn.${DOMAIN}:51820`, publicKey: wgKey('wg0'), keyBackedUp: true }],
    peers: ['sam-phone', 'jordan-laptop', 'alex-tablet', 'casey-phone'].map((name, i) => ({ id: `p${i + 1}`, serverId: 'wg1', routerIface: null, routerPeerId: null, kind: 'device', name, machineId: null,
      publicKey: wgKey(name), address: `10.8.0.${10 + i}/32`, allowedIps: [`10.8.0.${10 + i}/32`], clientAllowedIps: ['10.0.0.0/16'], previousUntil: null })),
  }
}
const wgLive = () => wg().peers.map((p, i) => ({ publicKey: p.publicKey, latestHandshake: i < 3 ? iso((i + 1) * 2 * MIN) : null, rx: Math.round((40 - i * 9) * 1048576), tx: Math.round((120 - i * 25) * 1048576), endpoint: i < 3 ? `198.51.100.${30 + i}:5${i}812` : null }))

export const NETWORK: FixtureRoute[] = [
  { path: '/api/proxy/hosts', get: () => ok({ hosts: proxyHosts(), errors: [] }) },
  { path: '/api/proxy/instances', get: () => ok(proxyInstances()) },
  { path: '/api/proxy/kinds', get: () => ok(proxyKinds()) },
  { path: '/api/proxy/instances/:id/hosts', get: () => ok(proxyHosts()) },
  { path: '/api/proxy/instances/:id/health', get: () => ok({ ok: true, version: '2.12.6', latencyMs: 4 }) },
  { path: '/api/proxy/stats', get: () => ok({ total: 12, enabled: 12, disabled: 0, online: 12, ssl: 12, expiring: 1, expired: 0 }) },
  { path: '/api/certs/overview', get: () => certsOverview() },
  { path: '/api/certs/events', get: () => certEvents() },
  { path: '/api/certs/housekeeping', get: () => ({ items: [] }) },
  { path: '/api/dns/domains', get: () => ok(domains()) },
  { path: '/api/dns/wan', get: () => ok({ ip: WAN_IP, source: 'router' }) },
  { path: '/api/dns/domains/:domain', get: p => ok(domains().find(d => d.domain === p.domain) ?? null) },
  { path: '/api/dns/domains/:domain/records', get: p => ok(records(p.domain)) },
  { path: '/api/dns/domains/:domain/stats', get: () => ok({ records: 14, proxied: 0 }) },
  { path: '/api/remote/overview', get: () => remoteOverview() },
  { path: '/api/remote/exclusions', get: () => ({ machineIds: [], tag: 'hyperprox-ignore' }) },
  { path: '/api/remote/jobs/:id', get: () => ({ id: 'job', state: 'done', steps: [] }) },
  { path: '/api/remote/v1/status', get: () => remoteOverview() },
  { path: '/api/vpn/wg', get: () => wg() },
  { path: '/api/vpn/wg/servers/:id/status', get: () => ({ peers: wgLive().map(live => ({ live })) }) },
  { path: '/api/vpn/wg/router', get: () => ({ interfaces: [{ id: '*1', name: 'wg-road', listenPort: 13231, publicKey: wgKey('router'), running: true, firewallOk: true, firewallCommand: null }],
    peers: [{ id: '*A', interface: 'wg-road', name: 'riley-phone', allowedAddress: ['10.9.0.2/32'], currentEndpoint: null, lastHandshake: '3m12s', rx: 4_800_000, tx: 31_000_000, comment: null, managed: false }],
    writable: false,
    setup: ['/user group add name=hyperprox-wg policy=read,write,api,rest-api comment="HyperProx WireGuard"', '/user add name=hyperprox-wg group=hyperprox-wg password=<choose one>'],
    setupNote: 'Read-only for now: the router login HyperProx uses cannot change WireGuard. These two commands make one that can.' }) },
  // Reveals: a peer's private config, login links and key exports never leave the demo, even as reads.
  { path: '/api/vpn/wg/peers/:id/reveal', refuse: true },
  { path: '/api/remote/machines/:id/:provider/login-url', refuse: true },
]
