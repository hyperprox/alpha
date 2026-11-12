// =============================================================================
//  HyperProx — Sonarr, Radarr and Lidarr posters and covers, through HyperProx
//
//  Same idea as lib/plex-art.ts: the page never gets a Sonarr or Radarr URL, and
//  the API key never leaves the API. The page gets /api/plugins/arrstack/art/<app>/<id>,
//  two checked parts, and the API rebuilds the one upstream path from them, from a
//  fixed list. Nothing a browser sends can name another host, another path or
//  another size.
// =============================================================================

export type ArrApp = 'sonarr' | 'radarr' | 'lidarr'
export interface ArrArtKey { app: ArrApp; id: string }

const ID = /^\d{1,10}$/

/** The two route parts, checked; null for anything else. */
export function arrArtKey(app: unknown, id: unknown): ArrArtKey | null {
  if (typeof app !== 'string' || typeof id !== 'string') return null
  if ((app !== 'sonarr' && app !== 'radarr' && app !== 'lidarr') || !ID.test(id)) return null
  return { app, id }
}

/** The HyperProx path a page may use for one series or film poster, or null for anything that is not a plain id. */
export function artRef(app: ArrApp, id: unknown): string | null {
  const k = arrArtKey(app, String(id))
  return k ? `/api/plugins/arrstack/art/${k.app}/${k.id}` : null
}

/** The upstream paths for one key, in the order tried: the small poster Sonarr and Radarr cache, then the full one. */
export function arrArtUpstream(k: ArrArtKey): string[] {
  // Lidarr (API v1): `id` is an album id, and an album's picture is its cover.
  if (k.app === 'lidarr') return [`/api/v1/mediacover/album/${k.id}/cover-250.jpg`, `/api/v1/mediacover/album/${k.id}/cover.jpg`]
  return [`/api/v3/mediacover/${k.id}/poster-250.jpg`, `/api/v3/mediacover/${k.id}/poster.jpg`]
}
