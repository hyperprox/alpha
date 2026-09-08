// =============================================================================
//  HyperProx — the plug-in catalogue
//
//  What exists, and what does not yet. The second half matters: a gallery that
//  only shows what is already built tells a visitor nothing about whether the
//  thing they actually run will ever appear, and leaves them with no way to ask
//  except finding the repo themselves.
//
//  Requests open a pre-filled GitHub issue in the user's own browser. HyperProx
//  deliberately holds no GitHub token and posts nothing on anyone's behalf: the
//  request should carry the name of the person who wants it, and asking every
//  installation to store a credential so a button can work is a bad trade.
// =============================================================================

export interface PluginIdea {
  /** Slug used in the issue title, not a plug-in id — none of these exist yet. */
  slug:     string
  name:     string
  /** What it would answer, in the terms someone running it would use. */
  would:    string
  category: 'network' | 'storage' | 'media' | 'home' | 'monitoring' | 'security'
  /** Named so a reader can judge whether it is plausible, not decoration. */
  api?:     string
}

/**
 * Ideas, not promises. Ordered roughly by how often they come up rather than by
 * any plan — nothing here is scheduled, and saying so is better than implying a
 * roadmap that does not exist.
 */
export const PLUGIN_IDEAS: PluginIdea[] = [
  { slug: 'proxmox-backup-server', name: 'Proxmox Backup Server', category: 'storage',
    would: 'Whether last night actually ran, what is verified, what the datastore has left, and which guest has silently dropped out of a job.',
    api: 'PBS REST API on :8007' },
  { slug: 'pihole-adguard', name: 'Pi-hole / AdGuard Home', category: 'network',
    would: 'What is being blocked, which client is generating it, and whether upstream DNS is answering.',
    api: 'Pi-hole PHP API, or AdGuard /control' },
  { slug: 'unifi', name: 'UniFi', category: 'network',
    would: 'Access points, clients per band, retries and airtime — the numbers that explain a slow room.',
    api: 'UniFi controller API' },
  { slug: 'truenas', name: 'TrueNAS', category: 'storage',
    would: 'Pool health, scrub and resilver progress, SMART state per disk, snapshot and replication tasks.',
    api: 'TrueNAS v2.0 REST API' },
  { slug: 'frigate', name: 'Frigate', category: 'security',
    would: 'Cameras up, detections, and whether the accelerator is keeping up with the streams.',
    api: 'Frigate HTTP API' },
  { slug: 'immich', name: 'Immich', category: 'media',
    would: 'Library size, upload activity, and whether machine-learning jobs are backed up.',
    api: 'Immich API' },
  { slug: 'jellyfin', name: 'Jellyfin', category: 'media',
    would: 'Who is watching and what is transcoding — the Plex plug-in, for the other server.',
    api: 'Jellyfin REST API' },
  { slug: 'uptime-kuma', name: 'Uptime Kuma', category: 'monitoring',
    would: 'Which checks are down, for how long, and the certificates about to expire.',
    api: 'Uptime Kuma socket.io or its Prometheus endpoint' },
  { slug: 'zigbee2mqtt', name: 'Zigbee2MQTT', category: 'home',
    would: 'Link quality per device, routers versus end devices, and what has stopped reporting.',
    api: 'MQTT topics, or the frontend API' },
  { slug: 'ups-nut', name: 'UPS (NUT / apcupsd)', category: 'monitoring',
    would: 'Load, battery charge, runtime left, and the transfer log — the one power figure the dashboard cannot measure from RAPL.',
    api: 'NUT upsd, or apcupsd NIS' },
  { slug: 'opnsense-pfsense', name: 'OPNsense / pfSense', category: 'network',
    would: 'The MikroTik plug-in, for the other kind of router: WAN throughput, firewall states, VPN peers.',
    api: 'OPNsense or pfSense REST API' },
  { slug: 'docker-host', name: 'Docker host', category: 'monitoring',
    would: 'Containers on a box that is not a Proxmox guest — restart loops, unhealthy checks, image drift.',
    api: 'Docker Engine API over a socket proxy' },
]

/** Where a request goes. Overridable so a fork does not file issues upstream. */
export function repoSlug(): string {
  return process.env.GITHUB_REPO || 'hyperprox/alpha'
}
