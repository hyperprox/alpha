// =============================================================================
//  HyperProx — the service catalogue
//
//  HyperProx integrates with things you already run. This is the answer to
//  "what if I do not run one?" — a reverse proxy for the proxy features, an
//  Ollama for the AI wizard, a Tautulli for Plex history. Each recipe knows
//  what it satisfies, so once it is up the integration is configured rather
//  than left as an address to copy.
//
//  Two rules shaped every recipe here.
//
//  Bind to the world, not to localhost. A service reachable only on 127.0.0.1
//  inside its own container is invisible to HyperProx, and the failure looks
//  like a network problem rather than a default. Ollama in particular ships
//  bound to loopback and is the most common "why can't it see my model server".
//
//  Say what the first login is. A recipe that installs a service and does not
//  tell you its default credentials has handed you a locked box.
// =============================================================================

import type { Distro } from './install-script'

/** What a person does the first time they open the service. */
export type FirstRun =
  | { kind: 'none' }
  | { kind: 'setup-url'; path: string }
  | { kind: 'env-admin'; userEnv?: string; passwordEnv: string; user: string }

export interface CatalogueRecipe {
  id:          string
  name:        string
  /** One line: what it is, in the reader's terms. */
  summary:     string
  category:    'proxy' | 'ai' | 'media' | 'monitoring' | 'apps'
  /** The plug-in or integration this satisfies once installed. */
  satisfies?:  { kind: 'plugin' | 'credential'; id: string; setting: string }
  /** Port the service answers on, used for the integration URL and the check. */
  port:        number
  /** Path that proves it is actually serving, not merely listening. */
  healthPath:  string
  /** Statuses that count as serving at healthPath. */
  expectStatus: number[]
  /** Runs under Docker, in an unprivileged container with nesting only. */
  needsDocker: boolean
  /** What the wizard pre-fills: the recommended size. */
  defaults:    { cores: number; memoryMb: number; diskGb: number; swapMb?: number }
  /** Below this it may not start or will struggle; the wizard warns, it does not refuse. */
  minimum:     { cores: number; memoryMb: number; diskGb: number }
  /** Needs a GPU on its node. Placement otherwise keeps GPU nodes free. */
  needsGpu?:   boolean
  /** Shown before anything runs, so the choice is informed. */
  firstLogin?: string
  notes?:      string[]
  firstRun:    FirstRun
  /** Offered to the AI wizard, which installs only recipes with this set. */
  wizard:      boolean
  install:
    | { kind: 'compose'; dir: string; compose: string }
    | { kind: 'script'; script: string }
  /** Extra packages on top of DOCKER_PACKAGES, by distro. */
  packages?:   Partial<Record<Distro, string[]>>
  /**
   * The environment variable a service reads the Host headers it answers from. The installer sets it to
   * the container's address and port (what the health check sends) and, when published, the domain.
   */
  allowedHostsEnv?: string
}

export const CATALOGUE: CatalogueRecipe[] = [
  // ── Reverse proxy ───────────────────────────────────────────────────────
  {
    id: 'nginx-proxy-manager',
    name: 'Nginx Proxy Manager',
    summary: 'A reverse proxy with a web UI and Let’s Encrypt built in. HyperProx drives it for proxy hosts and certificates.',
    category: 'proxy',
    satisfies: { kind: 'credential', id: 'npm', setting: 'url' },
    port: 81,
    healthPath: '/',
    expectStatus: [200],
    needsDocker: true,
    defaults: { cores: 2, memoryMb: 1024, diskGb: 8, swapMb: 512 },
    minimum: { cores: 1, memoryMb: 512, diskGb: 8 },
    firstRun: { kind: 'none' },
    wizard: false,
    firstLogin: 'admin@example.com / changeme — it forces a change on first sign-in.',
    notes: [
      'Takes ports 80 and 443 on this container, so give it an address nothing else is publishing from.',
      'Point your router’s port forwards at this container once it is up, or certificates cannot be issued.',
    ],
    install: { kind: 'compose', dir: '/opt/npm', compose: `services:
  app:
    image: jc21/nginx-proxy-manager:latest
    container_name: npm
    restart: unless-stopped
    ports:
      - "80:80"
      - "81:81"
      - "443:443"
    volumes:
      - ./data:/data
      - ./letsencrypt:/etc/letsencrypt` },
  },

  // ── Local AI ────────────────────────────────────────────────────────────
  {
    id: 'ollama',
    name: 'Ollama',
    summary: 'Runs open models locally. Gives the deployment wizard a provider that costs nothing and sends nothing off the box.',
    category: 'ai',
    satisfies: { kind: 'credential', id: 'ollama', setting: 'url' },
    port: 11434,
    healthPath: '/api/tags',
    expectStatus: [200],
    needsDocker: false,
    defaults: { cores: 4, memoryMb: 8192, diskGb: 40, swapMb: 1024 },
    minimum: { cores: 2, memoryMb: 4096, diskGb: 20 },
    firstRun: { kind: 'none' },
    wizard: false,
    notes: [
      'No model is pulled here — an 8B model is around 5 GB and which one you want depends on your hardware. Pull one from the AI page once this is up.',
      'CPU only in a plain container. GPU passthrough is a separate piece of work HyperProx does not do for you yet.',
      'Disk fills up fast: each model is gigabytes. 40 GB holds a few.',
    ],
    install: { kind: 'script', script: `apt-get update -qq
apt-get install -y -qq curl ca-certificates
curl -fsSL https://ollama.com/install.sh | sh

# Ollama binds 127.0.0.1 by default, which makes it invisible to anything
# outside its own container - including HyperProx. This is the single most
# common reason a model server "cannot be reached".
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/override.conf <<'CONF'
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
CONF
systemctl daemon-reload
systemctl enable --now ollama
systemctl restart ollama
sleep 3
echo "Ollama listening on 0.0.0.0:11434. No models pulled yet."` },
  },

  // ── Plex history ────────────────────────────────────────────────────────
  {
    id: 'tautulli',
    name: 'Tautulli',
    summary: 'Watch history and statistics for Plex. The Plex plug-in reads it for who watched what, and when.',
    category: 'media',
    satisfies: { kind: 'plugin', id: 'plex', setting: 'tautulli_url' },
    port: 8181,
    healthPath: '/auth/login',
    expectStatus: [200],
    needsDocker: true,
    firstRun: { kind: 'none' },
    wizard: false,
    defaults: { cores: 1, memoryMb: 512, diskGb: 8, swapMb: 512 },
    minimum: { cores: 1, memoryMb: 512, diskGb: 8 },
    firstLogin: 'It asks you to create an account on first open, then for your Plex server.',
    notes: [
      'Point it at your existing Plex server during its own setup — HyperProx does not do that part, because only you know which server and which token.',
      'History starts from the day it is installed. It cannot backfill what Plex has already forgotten.',
    ],
    install: { kind: 'compose', dir: '/opt/tautulli', compose: `services:
  tautulli:
    image: ghcr.io/tautulli/tautulli:latest
    container_name: tautulli
    restart: unless-stopped
    environment:
      - PUID=0
      - PGID=0
      - TZ=Etc/UTC
    ports:
      - "8181:8181"
    volumes:
      - ./config:/config` },
  },

  // ── Apps the AI wizard can install ──────────────────────────────────────
  {
    id: 'nextcloud',
    name: 'Nextcloud',
    summary: 'Files, calendar and contacts you host yourself.',
    category: 'apps',
    port: 80,
    healthPath: '/status.php',
    expectStatus: [200],
    needsDocker: true,
    defaults: { cores: 2, memoryMb: 2048, diskGb: 20, swapMb: 512 },
    minimum: { cores: 1, memoryMb: 1024, diskGb: 10 },
    firstRun: { kind: 'setup-url', path: '/' },
    wizard: true,
    install: { kind: 'compose', dir: '/opt/app', compose: `services:
  nextcloud:
    image: nextcloud:latest
    restart: unless-stopped
    ports: ["80:80"]
    volumes: ["./data:/var/www/html"]` },
  },
  {
    id: 'jellyfin',
    name: 'Jellyfin',
    summary: 'A media server for your own films and shows.',
    category: 'media',
    port: 8096,
    healthPath: '/health',
    expectStatus: [200],
    needsDocker: true,
    defaults: { cores: 4, memoryMb: 2048, diskGb: 20, swapMb: 512 },
    minimum: { cores: 2, memoryMb: 1024, diskGb: 10 },
    firstRun: { kind: 'setup-url', path: '/' },
    wizard: true,
    install: { kind: 'compose', dir: '/opt/app', compose: `services:
  jellyfin:
    image: jellyfin/jellyfin:latest
    restart: unless-stopped
    ports: ["8096:8096"]
    volumes: ["./config:/config", "./media:/media"]` },
  },
  {
    id: 'vaultwarden',
    name: 'Vaultwarden',
    summary: 'A Bitwarden-compatible password server.',
    category: 'apps',
    port: 80,
    healthPath: '/alive',
    expectStatus: [200],
    needsDocker: true,
    defaults: { cores: 1, memoryMb: 512, diskGb: 8, swapMb: 512 },
    minimum: { cores: 1, memoryMb: 512, diskGb: 8 },
    // Sign-ups are off, so a published server is not open to anyone who finds it. The owner signs in to
    // /admin with the generated token (shown once, kept in the vault) and invites users from there.
    firstRun: { kind: 'env-admin', passwordEnv: 'ADMIN_TOKEN', user: '/admin' },
    firstLogin: 'Open /admin and sign in with the admin token shown once after the install (it is kept in the vault). Sign-ups are off: invite each user from there.',
    // Not offered to the wizard until phase 5's first-run lock exists, for the same reason as Grafana:
    // the wizard cannot hand the generated token back to the person who asked. The catalogue page
    // installs it with one.
    wizard: false,
    install: { kind: 'compose', dir: '/opt/app', compose: `services:
  vaultwarden:
    image: vaultwarden/server:latest
    restart: unless-stopped
    ports: ["80:80"]
    volumes: ["./data:/data"]
    environment:
      - SIGNUPS_ALLOWED=false
      - ADMIN_TOKEN=\${ADMIN_TOKEN:?the installer sets this}` },
  },
  {
    id: 'gitea',
    name: 'Gitea',
    summary: 'A lightweight Git service with a web UI.',
    category: 'apps',
    port: 3000,
    healthPath: '/',
    expectStatus: [200],
    needsDocker: true,
    defaults: { cores: 2, memoryMb: 1024, diskGb: 12, swapMb: 512 },
    minimum: { cores: 1, memoryMb: 512, diskGb: 8 },
    firstRun: { kind: 'setup-url', path: '/' },
    wizard: true,
    install: { kind: 'compose', dir: '/opt/app', compose: `services:
  gitea:
    image: gitea/gitea:latest
    restart: unless-stopped
    ports: ["3000:3000"]
    volumes: ["./data:/data"]` },
  },
  {
    id: 'uptime-kuma',
    name: 'Uptime Kuma',
    summary: 'Watches your services and tells you when one goes down.',
    category: 'monitoring',
    port: 3001,
    healthPath: '/',
    expectStatus: [200, 302],
    needsDocker: true,
    defaults: { cores: 1, memoryMb: 512, diskGb: 8, swapMb: 512 },
    minimum: { cores: 1, memoryMb: 512, diskGb: 8 },
    firstRun: { kind: 'setup-url', path: '/' },
    wizard: true,
    install: { kind: 'compose', dir: '/opt/app', compose: `services:
  uptime-kuma:
    image: louislam/uptime-kuma:latest
    restart: unless-stopped
    ports: ["3001:3001"]
    volumes: ["./data:/app/data"]` },
  },
  {
    id: 'homepage',
    name: 'Homepage',
    summary: 'A start page that links to everything you run.',
    category: 'apps',
    port: 3000,
    healthPath: '/',
    expectStatus: [200],
    needsDocker: true,
    defaults: { cores: 1, memoryMb: 512, diskGb: 8, swapMb: 512 },
    minimum: { cores: 1, memoryMb: 512, diskGb: 8 },
    firstRun: { kind: 'none' },
    wizard: true,
    // Current images answer only a Host listed in HOMEPAGE_ALLOWED_HOSTS; anything else, the health
    // check included, gets an error page.
    allowedHostsEnv: 'HOMEPAGE_ALLOWED_HOSTS',
    install: { kind: 'compose', dir: '/opt/app', compose: `services:
  homepage:
    image: ghcr.io/gethomepage/homepage:latest
    restart: unless-stopped
    ports: ["3000:3000"]
    volumes: ["./config:/app/config"]
    environment:
      - HOMEPAGE_ALLOWED_HOSTS=\${HOMEPAGE_ALLOWED_HOSTS:?the installer sets this}` },
  },
  {
    id: 'grafana',
    name: 'Grafana',
    summary: 'Dashboards for metrics and logs.',
    category: 'monitoring',
    port: 3000,
    healthPath: '/api/health',
    expectStatus: [200],
    needsDocker: true,
    defaults: { cores: 2, memoryMb: 512, diskGb: 8, swapMb: 512 },
    minimum: { cores: 1, memoryMb: 512, diskGb: 8 },
    firstRun: { kind: 'env-admin', passwordEnv: 'GF_SECURITY_ADMIN_PASSWORD', user: 'admin' },
    // Not offered to the wizard until phase 5's first-run lock exists: the wizard cannot hand a
    // generated admin password back to the person who asked, and a service nobody can sign in to
    // safely is not a deployment. The catalogue page installs it with a generated password.
    wizard: false,
    install: { kind: 'compose', dir: '/opt/app', compose: `services:
  grafana:
    image: grafana/grafana:latest
    restart: unless-stopped
    ports: ["3000:3000"]
    volumes: ["./data:/var/lib/grafana"]
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=\${GF_SECURITY_ADMIN_PASSWORD:?the installer sets this}` },
  },
]

export function findRecipe(id: string): CatalogueRecipe | undefined {
  return CATALOGUE.find(r => r.id === id)
}

/** Lowercase, trimmed, whitespace to hyphens: how a person or a model writes a service name. */
export function serviceKey(name: string): string {
  return String(name ?? '').toLowerCase().trim().replace(/\s+/g, '-')
}

/**
 * Exact match on normalised id or name; anything looser is a suggestion, never an assumption.
 * Lookups use Array.find, so prototype keys such as "toString" cannot match.
 */
export function matchRecipe(name: string): { recipe?: CatalogueRecipe; suggestions: CatalogueRecipe[] } {
  const key = serviceKey(name)
  if (!key) return { suggestions: [] }
  const recipe = CATALOGUE.find(r => r.id === key || serviceKey(r.name) === key)
  if (recipe) return { recipe, suggestions: [] }
  const suggestions = wizardRecipes().filter(r => r.id.includes(key) || serviceKey(r.name).includes(key))
  return { suggestions }
}

export function wizardRecipes(): CatalogueRecipe[] {
  return CATALOGUE.filter(r => r.wizard)
}
