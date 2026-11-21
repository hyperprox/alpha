// =============================================================================
//  HyperProx — the media server Seerr reads (Plex or Jellyfin)
//
//  Seerr needs one media server to know what is already in the library. HyperProx knows a Plex server from the Plex
//  plug-in, and a Jellyfin server from the Jellyfin plug-in's saved address, API key and administrator sign-in (all kept
//  in the vault). Which one Seerr uses: what the owner chose in the wizard; with no choice, Plex when both are known.
//  Seerr's own settings API wants the address split into host, port and TLS, which is done here, once, for the setup
//  and for the Requests tab's reconnect fix.
// =============================================================================

export type MediaKind = 'plex' | 'jellyfin'
export type MediaPrefer = MediaKind | ''

export interface PlexServer { kind: 'plex'; url: string; token: string }
/** `user` and `password` are an administrator's sign-in: Seerr's owner is a Jellyfin account, and only a password signs one in. */
export interface JellyfinServer { kind: 'jellyfin'; url: string; apiKey: string; user?: string; password?: string }
export type MediaServer = PlexServer | JellyfinServer

export const MEDIA_NAME: Record<MediaKind, string> = { plex: 'Plex', jellyfin: 'Jellyfin' }

/** The server Seerr should use. A choice that is not known here falls back to the other; nothing known is null. */
export function pickMediaServer(prefer: MediaPrefer | undefined, plex: PlexServer | null, jellyfin: JellyfinServer | null): MediaServer | null {
  if (prefer === 'jellyfin' && jellyfin) return jellyfin
  if (prefer === 'plex' && plex) return plex
  return plex ?? jellyfin
}

/** The plug-in settings the Plex and Jellyfin plug-ins keep, read the same way by setup and by the Requests tab. */
export function serversFromSettings(plex: Record<string, string>, jellyfin: Record<string, string>): { plex: PlexServer | null; jellyfin: JellyfinServer | null } {
  return {
    plex: plex.plex_url && plex.plex_token ? { kind: 'plex', url: plex.plex_url, token: plex.plex_token } : null,
    jellyfin: jellyfin.jellyfin_url && jellyfin.jellyfin_key
      ? { kind: 'jellyfin', url: jellyfin.jellyfin_url, apiKey: jellyfin.jellyfin_key, ...(jellyfin.jellyfin_user && jellyfin.jellyfin_password ? { user: jellyfin.jellyfin_user, password: jellyfin.jellyfin_password } : {}) }
      : null,
  }
}

export interface HostParts { ip: string; port: number; useSsl: boolean; urlBase: string }

/** Seerr's host, port, TLS flag and URL base for an address. Throws a plain sentence for something that is not an address. */
export function hostParts(url: string, kind: MediaKind): HostParts {
  let u: URL
  try { u = new URL(url) } catch { throw new Error(`The ${MEDIA_NAME[kind]} address is not a web address.`) }
  const useSsl = u.protocol === 'https:'
  const port = Number(u.port || (useSsl ? 443 : kind === 'plex' ? 32400 : 8096))
  const urlBase = kind === 'jellyfin' && u.pathname !== '/' ? u.pathname.replace(/\/+$/, '') : ''
  return { ip: u.hostname, port, useSsl, urlBase }
}

/** The body for Seerr's POST /api/v1/settings/{plex|jellyfin}. */
export function mediaSettingsBody(ms: MediaServer): Record<string, unknown> {
  const h = hostParts(ms.url, ms.kind)
  if (ms.kind === 'plex') return { ip: h.ip, port: h.port, useSsl: h.useSsl }
  return { ip: h.ip, port: h.port, useSsl: h.useSsl, urlBase: h.urlBase, apiKey: ms.apiKey }
}
