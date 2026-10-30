// =============================================================================
//  HyperProx — what the wizard knows how to install
//
//  Kept apart from the executor so the plan audit can ask "is there a recipe for
//  this service?" without importing everything that runs a deployment. A service
//  with no recipe used to fall through to `image: <name>:latest` on port 80, which
//  starts nothing useful and still got a proxy host and a certificate.
// =============================================================================

export interface ServiceRecipe { port: number; compose: string }

export const SERVICE_CATALOG: Record<string, { port: number; compose: string }> = {
  nextcloud: {
    port: 80,
    compose: `services:
  nextcloud:
    image: nextcloud:latest
    restart: unless-stopped
    ports: ["80:80"]
    volumes: ["./data:/var/www/html"]`,
  },
  jellyfin: {
    port: 8096,
    compose: `services:
  jellyfin:
    image: jellyfin/jellyfin:latest
    restart: unless-stopped
    ports: ["8096:8096"]
    volumes: ["./config:/config", "./media:/media"]`,
  },
  vaultwarden: {
    port: 80,
    compose: `services:
  vaultwarden:
    image: vaultwarden/server:latest
    restart: unless-stopped
    ports: ["80:80"]
    volumes: ["./data:/data"]`,
  },
  gitea: {
    port: 3000,
    compose: `services:
  gitea:
    image: gitea/gitea:latest
    restart: unless-stopped
    ports: ["3000:3000"]
    volumes: ["./data:/data"]`,
  },
  'uptime-kuma': {
    port: 3001,
    compose: `services:
  uptime-kuma:
    image: louislam/uptime-kuma:latest
    restart: unless-stopped
    ports: ["3001:3001"]
    volumes: ["./data:/app/data"]`,
  },
  homepage: {
    port: 3000,
    compose: `services:
  homepage:
    image: ghcr.io/gethomepage/homepage:latest
    restart: unless-stopped
    ports: ["3000:3000"]
    volumes: ["./config:/app/config"]`,
  },
  grafana: {
    port: 3000,
    compose: `services:
  grafana:
    image: grafana/grafana:latest
    restart: unless-stopped
    ports: ["3000:3000"]
    volumes: ["./data:/var/lib/grafana"]`,
  },
}

/** Catalogue key for a service name as a person or model writes it. */
export function serviceKey(serviceName: string): string {
  return serviceName.toLowerCase().trim().replace(/\s+/g, '-')
}

/** The install recipe for a service, or undefined when the wizard has none. */
export function findRecipe(serviceName: string): ServiceRecipe | undefined {
  return Object.prototype.hasOwnProperty.call(SERVICE_CATALOG, serviceKey(serviceName))
    ? SERVICE_CATALOG[serviceKey(serviceName)]
    : undefined
}

export function getInstallCommands(serviceName: string, recipe: ServiceRecipe): string[] {
  const slug = serviceName.toLowerCase().replace(/[^a-z0-9]/g, '-')
  return [
    `# Run these commands inside the container:`,
    `apt-get update -qq && apt-get install -y docker.io && (apt-get install -y docker-compose-v2 || apt-get install -y docker-compose)`,
    `mkdir -p /opt/${slug} && cd /opt/${slug}`,
    `cat > docker-compose.yml << 'EOF'`,
    recipe.compose,
    `EOF`,
    `docker compose up -d`,
    `# Service will be available on port ${recipe.port}`,
  ]
}
