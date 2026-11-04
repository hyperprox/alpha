// =============================================================================
//  HyperProx — Managed proxies: Catalogue recipes for Traefik, Caddy, HAProxy
//
//  Not wired in yet. The Catalogue (lib/catalogue.ts) is another package's;
//  the integrator adds the hook:
//    1. offer managedProxyRecipe(kind, secret) in the Catalogue's proxy
//       category (a fresh `secret` per install, from managedSecret());
//    2. after a successful install, register the instance with
//       proxyService().createInstance(managedInstanceInput(...), actor).
//  The compose files are the ones the live tests ran against.
//
//  Caddy's admin API has no login of its own, so the Managed container binds
//  it to 127.0.0.1 (host networking: the container's own loopback) and
//  HyperProx reaches it through the container (`pct exec` on the node with
//  the vault-held login, then curl to loopback; settings api_via=guest).
//  Nothing on the network can reach it. HAProxy's Data Plane is bound to
//  loopback the same way, and keeps its generated password as well.
//  Traefik's API takes the generated secret (a {SHA} hash in its own file).
// =============================================================================

import { createHash, randomBytes } from 'node:crypto'
import type { CatalogueRecipe } from '../catalogue'
import type { InstanceInput } from './service'

export type ManagedKind = 'traefik' | 'caddy' | 'haproxy'

export function managedSecret(): string { return randomBytes(18).toString('base64url') }

const base = { category: 'proxy' as const, needsDocker: true, firstRun: { kind: 'none' as const }, wizard: false,
  defaults: { cores: 1, memoryMb: 512, diskGb: 4 },
  // curl inside the container: how HyperProx reaches an API bound to loopback there.
  packages: { debian: ['curl'], ubuntu: ['curl'] } }

const TRAEFIK_FILE_DIR = '/opt/traefik/dynamic'

export function managedProxyRecipe(kind: ManagedKind, secret: string): CatalogueRecipe {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(secret)) throw new Error('The managed secret must be at least 16 URL-safe characters')
  switch (kind) {
    case 'traefik':
      return { ...base, id: 'traefik', name: 'Traefik', port: 8282, healthPath: '/api/version', expectStatus: [200, 401],
        summary: 'A reverse proxy configured from files. HyperProx writes one file of its own and reads the rest from Traefik’s API.',
        notes: ['Takes port 80 on this container.', `HyperProx writes ${TRAEFIK_FILE_DIR}/hyperprox.yml; put hand-made routers in other files there.`],
        install: { kind: 'compose', dir: '/opt/traefik', compose: `services:
  traefik:
    image: traefik:v3.4
    restart: unless-stopped
    command:
      - --entrypoints.web.address=:80
      - --entrypoints.api.address=:8282
      - --api=true
      - --providers.file.directory=/dynamic
      - --providers.file.watch=true
    ports: ["80:80", "8282:8282"]
    volumes: ["./dynamic:/dynamic"]
` } }
    case 'caddy':
      return { ...base, id: 'caddy', name: 'Caddy', port: 80, healthPath: '/', expectStatus: [200, 404, 308],
        summary: 'A reverse proxy with automatic HTTPS. HyperProx drives it through its admin API, which only the container itself can reach.',
        notes: ['Takes ports 80 and 443 on this container.', 'Its admin API listens on 127.0.0.1 inside the container; HyperProx reaches it through the node.'],
        install: { kind: 'compose', dir: '/opt/caddy', compose: `services:
  caddy:
    image: caddy:2.10
    restart: unless-stopped
    network_mode: host
    command: ["caddy", "run", "--resume", "--config", "/etc/caddy/initial.json"]
    volumes: ["./initial.json:/etc/caddy/initial.json:ro", "./data:/data", "./config:/config"]
` } }
    case 'haproxy':
      return { ...base, id: 'haproxy', name: 'HAProxy', port: 80, healthPath: '/', expectStatus: [503, 200],
        summary: 'A load balancer and reverse proxy. HyperProx drives it through the Data Plane API, validating every change before HAProxy reloads.',
        notes: ['Takes port 80 on this container.', 'The Data Plane API listens on 127.0.0.1 inside the container; HyperProx reaches it through the node.'],
        install: { kind: 'compose', dir: '/opt/haproxy', compose: `services:
  haproxy:
    image: haproxytech/haproxy-debian:3.2
    restart: unless-stopped
    network_mode: host
    volumes: ["./cfg:/usr/local/etc/haproxy"]
` } }
  }
}

/** The files a Managed install writes beside its compose file (configuration the service starts from). */
export function managedProxyFiles(kind: ManagedKind, secret: string): Record<string, string> {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(secret)) throw new Error('The managed secret must be at least 16 URL-safe characters')
  switch (kind) {
    case 'traefik': {
      // The API router and its login live in a file of their own, so HyperProx's file never holds them.
      // Traefik accepts {SHA} hashes in basicAuth users; no bcrypt dependency needed.
      const sha = createHash('sha1').update(secret).digest('base64')
      return { [`${TRAEFIK_FILE_DIR}/api.yml`]: `http:
  middlewares:
    api-auth:
      basicAuth:
        users: ["hyperprox:{SHA}${sha}"]
  routers:
    api:
      rule: "PathPrefix(\`/api\`)"
      entryPoints: [api]
      service: api@internal
      middlewares: [api-auth]
` }
    }
    case 'caddy': return { '/opt/caddy/initial.json': JSON.stringify({ admin: { listen: '127.0.0.1:2019' }, apps: { http: { servers: { srv0: { listen: [':80'], routes: [] } } } } }, null, 2) + '\n' }
    case 'haproxy': return {
      '/opt/haproxy/cfg/haproxy.cfg': `global
  master-worker
  expose-deprecated-directives
  stats socket /var/run/haproxy-runtime.sock mode 660 level admin

defaults
  mode http
  timeout connect 5s
  timeout client 30s
  timeout server 30s

program api
  command /usr/local/bin/dataplaneapi -f /usr/local/etc/haproxy/dataplaneapi.yml
  no option start-on-reload

frontend http
  bind :80
`,
      '/opt/haproxy/cfg/dataplaneapi.yml': `dataplaneapi:
  host: 127.0.0.1
  port: 5555
  transaction:
    transaction_dir: /tmp/haproxy
  user:
  - name: hyperprox
    insecure: true
    password: ${secret}
haproxy:
  config_file: /usr/local/etc/haproxy/haproxy.cfg
  haproxy_bin: /usr/local/sbin/haproxy
  reload:
    reload_delay: 2
    reload_cmd: kill -SIGUSR2 1
    restart_cmd: kill -SIGUSR2 1
    reload_strategy: custom
`,
    }
  }
}

/** The instance to register once the Catalogue has installed a Managed proxy at `ip` in container `vmid` on `node`. */
export function managedInstanceInput(kind: ManagedKind, o: { name: string; ip: string; node: string; vmid: number; secret: string }): InstanceInput {
  const managed = { node: o.node, vmid: o.vmid, recipe: kind }
  switch (kind) {
    case 'traefik': return { kind, name: o.name, url: `http://${o.ip}:8282`, mode: 'managed', managed,
      settings: { api_user: 'hyperprox', file: `${TRAEFIK_FILE_DIR}/hyperprox.yml`, entrypoints: 'web', transport: 'guest' }, secrets: { api_password: o.secret } }
    // Loopback inside the container, reached through it: `ip` is not used for these two.
    case 'caddy': return { kind, name: o.name, url: 'http://127.0.0.1:2019', mode: 'managed', managed, settings: { api_via: 'guest' }, secrets: {} }
    case 'haproxy': return { kind, name: o.name, url: 'http://127.0.0.1:5555', mode: 'managed', managed,
      settings: { api_via: 'guest', user: 'hyperprox', frontend: 'http' }, secrets: { password: o.secret } }
  }
}
