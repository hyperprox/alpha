// =============================================================================
//  HyperProx — the Arr Stack's parts
//
//  The catalogue's Arr Stack is one container running several apps under
//  Docker Compose. This file says what each app is, which image (pinned to an
//  exact release, never `latest`) and port it uses, what it costs, and the
//  rules between them: Sonarr, Radarr and Lidarr find releases through
//  Prowlarr, so Prowlarr comes with them; the VPN wraps qBittorrent only.
//
//  Everything here is pure, so the wizard, the preview and the tests all read
//  the same rules.
// =============================================================================

export type ArrAppId =
  | 'sonarr' | 'radarr' | 'prowlarr' | 'qbittorrent' | 'sabnzbd' | 'bazarr' | 'lidarr' | 'seerr' | 'flaresolverr'

export interface ArrApp {
  id:       ArrAppId
  name:     string
  /** One plain line for the picker. */
  blurb:    string
  /** The boolean option that turns it on. */
  option:   string
  /** Ticked when the wizard opens. */
  default:  boolean
  image:    string
  /** The port inside the Docker network. */
  port:     number
  /** The port on the container's own address (only SABnzbd differs: qBittorrent has 8080). */
  hostPort: number
  /** A share of the container: CPU cores, RAM and disk for its image and settings. */
  cost:     { cores: number; memoryMb: number; diskGb: number }
  /** A path that answers without signing in, so "is it up" and the public check need no secret. */
  health:   string
  /** Statuses at `health` that mean it is serving. */
  healthOk: number[]
  /** Not offered for a public name: a download client is never put on the internet. */
  private?: boolean
  /** Reached only inside the Docker network: no port on the container's address (`hostPort` is unused). */
  internal?: boolean
}

/** One user and group for every app, so every file in /data has the same owner and hardlinks just work. */
export const PUID = 1000
export const PGID = 1000

export const APPS: readonly ArrApp[] = [
  { id: 'sonarr', name: 'Sonarr', blurb: 'Finds and downloads TV shows, and files each episode where your media server looks.',
    option: 'ARR_SONARR', default: true, image: 'ghcr.io/linuxserver/sonarr:4.0.20.3014-ls4', port: 8989, hostPort: 8989,
    cost: { cores: 0.5, memoryMb: 512, diskGb: 2 }, health: '/ping', healthOk: [200] },
  { id: 'radarr', name: 'Radarr', blurb: 'The same for films.',
    option: 'ARR_RADARR', default: true, image: 'ghcr.io/linuxserver/radarr:6.4.4.10685-ls326', port: 7878, hostPort: 7878,
    cost: { cores: 0.5, memoryMb: 512, diskGb: 2 }, health: '/ping', healthOk: [200] },
  { id: 'prowlarr', name: 'Prowlarr', blurb: 'Keeps your list of indexers (the sites that list releases) in one place and shares it with the others.',
    option: 'ARR_PROWLARR', default: true, image: 'ghcr.io/linuxserver/prowlarr:2.7.0.5723-ls168', port: 9696, hostPort: 9696,
    cost: { cores: 0.25, memoryMb: 256, diskGb: 1 }, health: '/ping', healthOk: [200] },
  { id: 'qbittorrent', name: 'qBittorrent', blurb: 'Downloads torrents.',
    option: 'ARR_QBITTORRENT', default: true, image: 'ghcr.io/linuxserver/qbittorrent:5.3.0_v2.1.2-ls487', port: 8080, hostPort: 8080,
    cost: { cores: 1, memoryMb: 512, diskGb: 1 }, health: '/api/v2/app/version', healthOk: [200, 403], private: true },
  { id: 'sabnzbd', name: 'SABnzbd', blurb: 'Downloads from Usenet, if you have a Usenet provider.',
    option: 'ARR_SABNZBD', default: false, image: 'ghcr.io/linuxserver/sabnzbd:5.1.3-ls280', port: 8080, hostPort: 8085,
    cost: { cores: 1, memoryMb: 512, diskGb: 1 }, health: '/api?mode=version&output=json', healthOk: [200], private: true },
  { id: 'bazarr', name: 'Bazarr', blurb: 'Fetches subtitles for what Sonarr and Radarr download.',
    option: 'ARR_BAZARR', default: false, image: 'ghcr.io/linuxserver/bazarr:v1.6.2-ls372', port: 6767, hostPort: 6767,
    cost: { cores: 0.25, memoryMb: 384, diskGb: 1 }, health: '/', healthOk: [200] },
  { id: 'lidarr', name: 'Lidarr', blurb: 'Finds and downloads music.',
    option: 'ARR_LIDARR', default: false, image: 'ghcr.io/linuxserver/lidarr:3.1.6.5079-ls48', port: 8686, hostPort: 8686,
    cost: { cores: 0.5, memoryMb: 512, diskGb: 2 }, health: '/ping', healthOk: [200] },
  { id: 'seerr', name: 'Seerr', blurb: 'A page where family and friends ask for films and shows. It follows on from Overseerr and Jellyseerr.',
    option: 'ARR_SEERR', default: false, image: 'ghcr.io/seerr-team/seerr:v3.5.1', port: 5055, hostPort: 5055,
    cost: { cores: 0.25, memoryMb: 384, diskGb: 1 }, health: '/api/v1/status', healthOk: [200] },
  { id: 'flaresolverr', name: 'FlareSolverr', blurb: 'Gets Prowlarr past the "checking your browser" page some indexers show.',
    option: 'ARR_FLARESOLVERR', default: false, image: 'ghcr.io/flaresolverr/flaresolverr:v3.5.2', port: 8191, hostPort: 8191,
    cost: { cores: 0.5, memoryMb: 512, diskGb: 1 }, health: '/', healthOk: [200], private: true, internal: true },
]

export const GLUETUN_IMAGE = 'qmcgaw/gluetun:v3.41.3'
export const VPN_COST = { cores: 0.25, memoryMb: 64, diskGb: 1 }
/** The container itself: Debian and Docker. */
export const BASE_COST = { cores: 0.5, memoryMb: 512, diskGb: 8 }

export const appById = (id: string) => APPS.find(a => a.id === id)

/**
 * The VPN providers Gluetun knows, by the name it takes in VPN_SERVICE_PROVIDER. Port forwarding (what lets other
 * people connect to you, and so what makes torrents fast) is something only some providers offer.
 */
export const VPN_PROVIDERS: ReadonlyArray<{ id: string; name: string; portForwarding: boolean }> = [
  { id: 'airvpn', name: 'AirVPN', portForwarding: false },
  { id: 'cyberghost', name: 'CyberGhost', portForwarding: false },
  { id: 'expressvpn', name: 'ExpressVPN', portForwarding: false },
  { id: 'ipvanish', name: 'IPVanish', portForwarding: false },
  { id: 'ivpn', name: 'IVPN', portForwarding: false },
  { id: 'mullvad', name: 'Mullvad', portForwarding: false },
  { id: 'nordvpn', name: 'NordVPN', portForwarding: false },
  { id: 'perfect privacy', name: 'Perfect Privacy', portForwarding: true },
  { id: 'privado', name: 'Privado', portForwarding: false },
  { id: 'private internet access', name: 'Private Internet Access', portForwarding: true },
  { id: 'privatevpn', name: 'PrivateVPN', portForwarding: true },
  { id: 'protonvpn', name: 'Proton VPN', portForwarding: true },
  { id: 'purevpn', name: 'PureVPN', portForwarding: false },
  { id: 'surfshark', name: 'Surfshark', portForwarding: false },
  { id: 'torguard', name: 'TorGuard', portForwarding: false },
  { id: 'windscribe', name: 'Windscribe', portForwarding: false },
]

export interface Selection {
  apps: ArrAppId[]
  vpn: boolean
}

/** The apps an option set turns on, in catalogue order. */
export function selectionOf(values: Record<string, string>): Selection {
  return { apps: APPS.filter(a => values[a.option] === '1').map(a => a.id), vpn: values.ARR_VPN === '1' }
}

export const has = (s: Selection, id: ArrAppId) => s.apps.includes(id)

/**
 * The rules between the parts. Errors refuse the plan; warnings are shown. The wizard ticks Prowlarr for you
 * and greys out the VPN without qBittorrent, so a person only meets these through a hand-made request.
 */
export function selectionProblems(s: Selection): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = []
  if (!s.apps.length) errors.push('Pick at least one app.')
  const finders = (['sonarr', 'radarr', 'lidarr'] as const).filter(id => has(s, id))
  if (finders.length && !has(s, 'prowlarr')) {
    errors.push(`${finders.map(id => appById(id)!.name).join(' and ')} find${finders.length === 1 ? 's' : ''} releases through Prowlarr, so Prowlarr is needed too.`)
  }
  if (s.vpn && !has(s, 'qbittorrent')) errors.push('The VPN only covers qBittorrent. Pick qBittorrent, or turn the VPN off.')
  if ((has(s, 'bazarr') || has(s, 'seerr')) && !has(s, 'sonarr') && !has(s, 'radarr')) {
    errors.push(`${[has(s, 'bazarr') && 'Bazarr', has(s, 'seerr') && 'Seerr'].filter(Boolean).join(' and ')} work${has(s, 'bazarr') && has(s, 'seerr') ? '' : 's'} with Sonarr or Radarr. Pick one of them too.`)
  }
  if (has(s, 'flaresolverr') && !has(s, 'prowlarr')) errors.push('FlareSolverr helps Prowlarr, so it needs Prowlarr.')
  if (finders.length && !has(s, 'qbittorrent') && !has(s, 'sabnzbd')) warnings.push('No download client is picked, so nothing will be downloaded until you add one.')
  return { errors, warnings }
}

/** What the selection costs, rounded to what Proxmox takes: whole cores, RAM in 256 MB steps, whole GB. */
export function totals(s: Selection, extraDiskGb = 0): { cores: number; memoryMb: number; diskGb: number } {
  const parts = [BASE_COST, ...APPS.filter(a => has(s, a.id)).map(a => a.cost), ...(s.vpn ? [VPN_COST] : [])]
  const sum = parts.reduce((t, p) => ({ cores: t.cores + p.cores, memoryMb: t.memoryMb + p.memoryMb, diskGb: t.diskGb + p.diskGb }), { cores: 0, memoryMb: 0, diskGb: 0 })
  return {
    cores: Math.max(1, Math.ceil(sum.cores)),
    memoryMb: Math.ceil(sum.memoryMb / 256) * 256,
    diskGb: Math.ceil(sum.diskGb + Math.max(0, extraDiskGb)),
  }
}

/** The selection the wizard opens with. */
export const DEFAULT_SELECTION: Selection = { apps: APPS.filter(a => a.default).map(a => a.id), vpn: false }

/** The category each app files downloads under, in both download clients. */
export const CATEGORY: Partial<Record<ArrAppId, string>> = { sonarr: 'tv', radarr: 'movies', lidarr: 'music' }
/** Where each app keeps its library, inside /data. */
export const LIBRARY: Partial<Record<ArrAppId, string>> = { sonarr: '/data/media/tv', radarr: '/data/media/movies', lidarr: '/data/media/music' }
