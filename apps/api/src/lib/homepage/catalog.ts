// =============================================================================
//  HyperProx — Homepage: what each known app looks like on the dashboard
//
//  One row per app HyperProx can recognise: the group it goes in, its icon from
//  Homepage's dashboard-icons set (`plex.png`, `sonarr.png`...), a one-line
//  description, the port and scheme it answers on, and the names it goes by (a
//  guest called "jellyseerr", a proxy host "request.example.com" with a guest
//  called "seerr"). Also, for the apps Homepage has a service widget for, which
//  of HyperProx's stored settings would fill that widget in. Widgets are opt-in
//  per service (lib/homepage/service.ts); nothing here turns one on.
// =============================================================================

export const GROUPS = ['Media', 'Downloads', 'Infrastructure', 'Home', 'Dev', 'Websites', 'Guests'] as const
export type GroupName = typeof GROUPS[number]

/** Where a widget field's value comes from: a plug-in's stored setting, or the Proxmox token HyperProx made for Homepage. */
export type WidgetSource =
  | { kind: 'plugin'; plugin: string; setting: string }
  | { kind: 'proxmox-token'; part: 'id' | 'secret' }

export interface WidgetDef {
  /** Homepage's widget type. */
  type: string
  /** Fields whose values are secrets: written as {{HOMEPAGE_VAR_...}} placeholders, the values into the .env. */
  secrets: Array<{ field: string; from: WidgetSource }>
}

export interface KnownApp {
  key: string
  name: string
  group: GroupName
  icon: string
  description: string
  port?: number
  scheme?: 'http' | 'https'
  /** Lower-case words a guest name or a proxy host's first label may be, for this app. */
  aliases: string[]
  /** For the status dot: a path that answers 200 without a login (Plex's root asks for one). */
  monitorPath?: string
  widget?: WidgetDef
}

const arr = (key: string, name: string, port: number, description: string, plugin = 'arrstack'): KnownApp => ({
  key, name, group: 'Downloads', icon: `${key}.png`, description, port, scheme: 'http', monitorPath: '/ping', aliases: [key],
  widget: { type: key, secrets: [{ field: 'key', from: { kind: 'plugin', plugin, setting: `${key}_key` } }] },
})

export const KNOWN: KnownApp[] = [
  // ── Media ──
  { key: 'plex', name: 'Plex', group: 'Media', icon: 'plex.png', description: 'Films and TV', port: 32400, scheme: 'http', monitorPath: '/identity', aliases: ['plex'],
    widget: { type: 'plex', secrets: [{ field: 'key', from: { kind: 'plugin', plugin: 'plex', setting: 'plex_token' } }] } },
  { key: 'jellyfin', name: 'Jellyfin', group: 'Media', icon: 'jellyfin.png', description: 'Films and TV', port: 8096, scheme: 'http', monitorPath: '/health', aliases: ['jellyfin'] },
  { key: 'tautulli', name: 'Tautulli', group: 'Media', icon: 'tautulli.png', description: 'Who is watching what', port: 8181, scheme: 'http', aliases: ['tautulli'],
    widget: { type: 'tautulli', secrets: [{ field: 'key', from: { kind: 'plugin', plugin: 'plex', setting: 'apikey' } }] } },
  { key: 'seerr', name: 'Seerr', group: 'Media', icon: 'jellyseerr.png', description: 'Ask for a film or a show', port: 5055, scheme: 'http', aliases: ['seerr', 'jellyseerr', 'overseerr', 'request', 'requests'] },
  { key: 'tunarr', name: 'Tunarr', group: 'Media', icon: 'tunarr.png', description: 'Live TV channels', port: 8000, scheme: 'http', aliases: ['tunarr'] },
  { key: 'immich', name: 'Immich', group: 'Home', icon: 'immich.png', description: 'Photos and videos', port: 2283, scheme: 'http', monitorPath: '/api/server/ping', aliases: ['immich', 'photos'] },
  { key: 'audiobookshelf', name: 'Audiobookshelf', group: 'Media', icon: 'audiobookshelf.png', description: 'Audiobooks and podcasts', port: 13378, scheme: 'http', aliases: ['audiobookshelf', 'abs'] },
  { key: 'navidrome', name: 'Navidrome', group: 'Media', icon: 'navidrome.png', description: 'Music', port: 4533, scheme: 'http', aliases: ['navidrome'] },
  // ── Downloads ──
  arr('sonarr', 'Sonarr', 8989, 'TV shows'),
  arr('radarr', 'Radarr', 7878, 'Films'),
  arr('lidarr', 'Lidarr', 8686, 'Music'),
  arr('prowlarr', 'Prowlarr', 9696, 'Indexers'),
  { key: 'bazarr', name: 'Bazarr', group: 'Downloads', icon: 'bazarr.png', description: 'Subtitles', port: 6767, scheme: 'http', aliases: ['bazarr'] },
  { key: 'qbittorrent', name: 'qBittorrent', group: 'Downloads', icon: 'qbittorrent.png', description: 'Downloads', port: 8080, scheme: 'http', aliases: ['qbittorrent', 'qbit', 'torrent'],
    widget: { type: 'qbittorrent', secrets: [] } },
  { key: 'sabnzbd', name: 'SABnzbd', group: 'Downloads', icon: 'sabnzbd.png', description: 'Usenet downloads', port: 8080, scheme: 'http', aliases: ['sabnzbd'] },
  { key: 'unmanic', name: 'Unmanic', group: 'Downloads', icon: 'unmanic.png', description: 'Transcoding worker', port: 8888, scheme: 'http', aliases: ['unmanic'],
    widget: { type: 'unmanic', secrets: [] } },
  { key: 'tdarr', name: 'Tdarr', group: 'Downloads', icon: 'tdarr.png', description: 'Transcoding', port: 8265, scheme: 'http', aliases: ['tdarr'] },
  // ── Infrastructure ──
  { key: 'proxmox', name: 'Proxmox VE', group: 'Infrastructure', icon: 'proxmox.png', description: 'The cluster', port: 8006, scheme: 'https', aliases: ['proxmox', 'pve'],
    widget: { type: 'proxmox', secrets: [{ field: 'username', from: { kind: 'proxmox-token', part: 'id' } }, { field: 'password', from: { kind: 'proxmox-token', part: 'secret' } }] } },
  { key: 'hyperprox', name: 'HyperProx', group: 'Infrastructure', icon: 'mdi-server-network', description: 'Runs the cluster', scheme: 'https', aliases: ['hyperprox'] },
  { key: 'pbs', name: 'Proxmox Backup Server', group: 'Infrastructure', icon: 'proxmox-backup-server.png', description: 'Backups', port: 8007, scheme: 'https', aliases: ['pbs', 'backup'] },
  { key: 'npm', name: 'Nginx Proxy Manager', group: 'Infrastructure', icon: 'nginx-proxy-manager.png', description: 'Reverse proxy and certificates', port: 81, scheme: 'http', aliases: ['npm', 'nginx-proxy-manager', 'proxy'] },
  { key: 'qnap', name: 'QNAP', group: 'Infrastructure', icon: 'qnap.png', description: 'Network storage', scheme: 'https', aliases: ['qnap', 'nas'] },
  { key: 'mikrotik', name: 'MikroTik', group: 'Infrastructure', icon: 'mikrotik.png', description: 'Router', scheme: 'https', aliases: ['mikrotik', 'router'] },
  { key: 'asus', name: 'ASUS router', group: 'Infrastructure', icon: 'asus-router.png', description: 'Router', scheme: 'https', aliases: ['asus'] },
  { key: 'meshcentral', name: 'MeshCentral', group: 'Infrastructure', icon: 'meshcentral.png', description: 'Remote desktop', port: 443, scheme: 'https', aliases: ['meshcentral', 'mesh'] },
  { key: 'grafana', name: 'Grafana', group: 'Infrastructure', icon: 'grafana.png', description: 'Dashboards', port: 3000, scheme: 'http', aliases: ['grafana'] },
  { key: 'uptime-kuma', name: 'Uptime Kuma', group: 'Infrastructure', icon: 'uptime-kuma.png', description: 'Uptime checks', port: 3001, scheme: 'http', aliases: ['uptime-kuma', 'kuma', 'uptime'] },
  { key: 'homepage', name: 'Homepage', group: 'Infrastructure', icon: 'homepage.png', description: 'This dashboard', port: 3000, scheme: 'http', aliases: ['homepage'] },
  // ── Home ──
  { key: 'home-assistant', name: 'Home Assistant', group: 'Home', icon: 'home-assistant.png', description: 'The house', port: 8123, scheme: 'http', monitorPath: '/manifest.json', aliases: ['home-assistant', 'homeassistant', 'hass', 'ha'] },
  { key: 'nextcloud', name: 'Nextcloud', group: 'Home', icon: 'nextcloud.png', description: 'Files and calendars', port: 443, scheme: 'https', monitorPath: '/status.php', aliases: ['nextcloud', 'cloud'] },
  { key: 'vaultwarden', name: 'Vaultwarden', group: 'Home', icon: 'vaultwarden.png', description: 'Passwords', port: 443, scheme: 'https', monitorPath: '/alive', aliases: ['vaultwarden', 'bitwarden', 'vault'] },
  { key: 'paperless', name: 'Paperless-ngx', group: 'Home', icon: 'paperless-ngx.png', description: 'Documents', port: 8000, scheme: 'http', aliases: ['paperless', 'paperless-ngx'] },
  // ── Dev ──
  { key: 'gitlab', name: 'GitLab', group: 'Dev', icon: 'gitlab.png', description: 'Code', port: 443, scheme: 'https', monitorPath: '/users/sign_in', aliases: ['gitlab'] },
  { key: 'gitea', name: 'Gitea', group: 'Dev', icon: 'gitea.png', description: 'Code', port: 3000, scheme: 'http', aliases: ['gitea', 'forgejo'] },
  { key: 'ollama', name: 'Ollama', group: 'Dev', icon: 'ollama.png', description: 'Local AI models', port: 11434, scheme: 'http', aliases: ['ollama'] },
  { key: 'open-webui', name: 'Open WebUI', group: 'Dev', icon: 'open-webui.png', description: 'Chat with local AI', port: 8080, scheme: 'http', aliases: ['open-webui', 'openwebui', 'webui'] },
  { key: 'code-server', name: 'code-server', group: 'Dev', icon: 'code-server.png', description: 'Editor in the browser', port: 8443, scheme: 'https', aliases: ['code-server', 'vscode'] },
  // ── Websites ──
  { key: 'wordpress', name: 'WordPress', group: 'Websites', icon: 'wordpress.png', description: 'Website', scheme: 'https', aliases: ['wordpress', 'wp'] },
  { key: 'ghost', name: 'Ghost', group: 'Websites', icon: 'ghost.png', description: 'Website', scheme: 'https', aliases: ['ghost', 'blog'] },
  { key: 'website', name: 'Website', group: 'Websites', icon: 'mdi-web', description: 'Website', scheme: 'https', aliases: [] },
  { key: 'guest', name: 'Guest', group: 'Guests', icon: 'mdi-server', description: 'Guest', aliases: [] },
]

const BY_KEY = new Map(KNOWN.map(a => [a.key, a]))

/** Catalogue recipe ids (and the shared probes' keys) that name an app by another key. */
const ALIAS_KEY: Record<string, string> = {
  'nginx-proxy-manager': 'npm', 'proxmox-backup-server': 'pbs', 'static-site': 'website', 'tdarr-node': 'tdarr',
  'arr-stack': 'sonarr', qbit: 'qbittorrent', 'home-assistant': 'home-assistant', jellyseerr: 'seerr', overseerr: 'seerr',
}

export function knownApp(key: string | null | undefined): KnownApp | null {
  if (!key) return null
  const k = key.toLowerCase()
  return BY_KEY.get(k) ?? BY_KEY.get(ALIAS_KEY[k] ?? '') ?? null
}

/**
 * The app a name suggests: a guest's name or a proxy host's first label. Exact alias first, then an alias that is a
 * whole word in the name ("media-plex" is Plex). Short aliases ("ha", "wp") only match exactly.
 */
export function appFromName(...names: Array<string | null | undefined>): KnownApp | null {
  for (const raw of names) {
    const n = String(raw ?? '').toLowerCase().trim()
    if (!n) continue
    for (const a of KNOWN) if (a.aliases.includes(n)) return a
    const words = n.split(/[^a-z0-9]+/).filter(Boolean)
    for (const a of KNOWN) if (a.aliases.some(al => al.length >= 4 && (words.includes(al) || (al.includes('-') && n.includes(al))))) return a
  }
  return null
}
