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
//  Caddy's admin API has no login of its own: the Managed container listens
//  for it on its own address, so put that address where only HyperProx can
//  reach it. Traefik's API and HAProxy's Data Plane take the generated secret.
// =============================================================================

import { createHash, randomBytes } from 'node:crypto'
import type { CatalogueRecipe } from '../catalogue'
import type { InstanceInput } from './service'

export type ManagedKind = 'traefik' | 'caddy' | 'haproxy'

export function managedSecret(): string { return randomBytes(18).toString('base64url') }

const base = { category: 'proxy' as const, needsDocker: true, firstRun: { kind: 'none' as const }, wizard: false,
  defaults: { cores: 1, memoryMb: 512, diskGb: 4 } }

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
      return { ...base, id: 'caddy', name: 'Caddy', port: 2019, healthPath: '/config/', expectStatus: [200],
        summary: 'A reverse proxy with automatic HTTPS. HyperProx drives it through its admin API.',
        notes: ['Takes ports 80 and 443 on this container.', 'Its admin API (port 2019) has no login: keep this container’s address reachable only by HyperProx.'],
        install: { kind: 'compose', dir: '/opt/caddy', compose: `services:
  caddy:
    image: caddy:2.10
    restart: unless-stopped
    command: ["caddy", "run", "--resume", "--config", "/etc/caddy/initial.json"]
    ports: ["80:80", "443:443", "2019:2019"]
    volumes: ["./initial.json:/etc/caddy/initial.json:ro", "./data:/data", "./config:/config"]
` } }
    case 'haproxy':
      return { ...base, id: 'haproxy', name: 'HAProxy', port: 5555, healthPath: '/v3/info', expectStatus: [200, 401],
        summary: 'A load balancer and reverse proxy. HyperProx drives it through the Data Plane API, validating every change before HAProxy reloads.',
        notes: ['Takes port 80 on this container.'],
        install: { kind: 'compose', dir: '/opt/haproxy', compose: `services:
  haproxy:
    image: haproxytech/haproxy-debian:3.2
    restart: unless-stopped
    ports: ["80:80", "5555:5555"]
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
    case 'caddy': return { '/opt/caddy/initial.json': JSON.stringify({ admin: { listen: '0.0.0.0:2019' }, apps: { http: { servers: { srv0: { listen: [':80'], routes: [] } } } } }, null, 2) + '\n' }
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
  host: 0.0.0.0
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
    case 'caddy': return { kind, name: o.name, url: `http://${o.ip}:2019`, mode: 'managed', managed, settings: {}, secrets: {} }
    case 'haproxy': return { kind, name: o.name, url: `http://${o.ip}:5555`, mode: 'managed', managed,
      settings: { user: 'hyperprox', frontend: 'http' }, secrets: { password: o.secret } }
  }
}
