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

export interface CatalogueRecipe {
  id:          string
  name:        string
  /** One line: what it is, in the reader's terms. */
  summary:     string
  category:    'proxy' | 'ai' | 'media' | 'monitoring'
  /** The plug-in or integration this satisfies once installed. */
  satisfies?:  { kind: 'plugin' | 'credential'; id: string; setting: string }
  /** Port the service answers on, used for the integration URL and the check. */
  port:        number
  /** Path that proves it is actually serving, not merely listening. */
  healthPath:  string
  /** Docker needs a privileged container with nesting and keyctl. */
  needsDocker: boolean
  defaults:    { cores: number; memoryMb: number; diskGb: number }
  /** Shown before anything runs, so the choice is informed. */
  firstLogin?: string
  notes?:      string[]
  script:      string
}

const DOCKER_PREAMBLE = `
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl docker.io docker-compose-v2
systemctl enable --now docker
`.trim()

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
    needsDocker: true,
    defaults: { cores: 2, memoryMb: 1024, diskGb: 8 },
    firstLogin: 'admin@example.com / changeme — it forces a change on first sign-in.',
    notes: [
      'Takes ports 80 and 443 on this container, so give it an address nothing else is publishing from.',
      'Point your router’s port forwards at this container once it is up, or certificates cannot be issued.',
    ],
    script: `${DOCKER_PREAMBLE}
mkdir -p /opt/npm/data /opt/npm/letsencrypt
cat > /opt/npm/docker-compose.yml <<'YAML'
services:
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
      - ./letsencrypt:/etc/letsencrypt
YAML
cd /opt/npm && docker compose up -d
echo "Nginx Proxy Manager starting. Admin UI on port 81."`,
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
    needsDocker: false,
    defaults: { cores: 4, memoryMb: 8192, diskGb: 40 },
    notes: [
      'No model is pulled here — an 8B model is around 5 GB and which one you want depends on your hardware. Pull one from the AI page once this is up.',
      'CPU only in a plain container. GPU passthrough is a separate piece of work HyperProx does not do for you yet.',
      'Disk fills up fast: each model is gigabytes. 40 GB holds a few.',
    ],
    script: `export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
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
echo "Ollama listening on 0.0.0.0:11434. No models pulled yet."`,
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
    needsDocker: true,
    defaults: { cores: 1, memoryMb: 512, diskGb: 8 },
    firstLogin: 'It asks you to create an account on first open, then for your Plex server.',
    notes: [
      'Point it at your existing Plex server during its own setup — HyperProx does not do that part, because only you know which server and which token.',
      'History starts from the day it is installed. It cannot backfill what Plex has already forgotten.',
    ],
    script: `${DOCKER_PREAMBLE}
mkdir -p /opt/tautulli/config
cat > /opt/tautulli/docker-compose.yml <<'YAML'
services:
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
      - ./config:/config
YAML
cd /opt/tautulli && docker compose up -d
echo "Tautulli starting on port 8181."`,
  },
]

export function findRecipe(id: string): CatalogueRecipe | undefined {
  return CATALOGUE.find(r => r.id === id)
}
