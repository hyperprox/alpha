// =============================================================================
//  HyperProx — Arr Stack, Seerr requests: production wiring
//
//  Seerr, Radarr and Sonarr are read and written through the Arr Stack plug-in's endpoints (the keys never leave
//  lib/plugin-host.ts). The reconnect fix reads Radarr's and Sonarr's keys and the media server's sign-in from the
//  plug-in settings in the vault, and passes them to Seerr only. Nothing here keeps state.
// =============================================================================

import { findPlugin } from '../../plugins'
import { getSettings, pluginEndpointClient, type CoreEndpointClient } from '../plugin-host'
import { auditOrThrow } from '../audit'
import { pickMediaServer, serversFromSettings } from '../arr/media-server'
import { currentRouterService } from '../arr-router/production'
import { RequestsService } from './service'
import type { SortedMove } from './logic'

const endpoint = (key: string) => async (): Promise<CoreEndpointClient | null> => {
  const p = findPlugin('arrstack')
  return p ? pluginEndpointClient(p, key).catch(() => null) : null
}

let shared: RequestsService | null = null

export function requestsService(log?: (m: string) => void): RequestsService {
  if (shared) return shared
  const none = {} as Record<string, string>
  shared = new RequestsService({
    seerr: endpoint('seerr'), radarr: endpoint('radarr'), sonarr: endpoint('default'),
    moves: async (): Promise<SortedMove[]> => {
      const r = currentRouterService()
      return r ? (await r.recent()).map(m => ({ app: m.app, title: m.title, year: m.year, to: m.to, ok: m.ok })) : []
    },
    keys: async () => { const s = await getSettings('arrstack').catch(() => none); return { radarr: s.radarr_key || undefined, sonarr: s.sonarr_key || undefined } },
    media: async prefer => {
      const [p, j] = await Promise.all([getSettings('plex').catch(() => none), getSettings('jellyfin').catch(() => none)])
      const k = serversFromSettings(p, j)
      return pickMediaServer(prefer, k.plex, k.jellyfin)
    },
    audit: (action, details) => auditOrThrow(action, 'plugin:arrstack', details),
    now: () => Date.now(),
    log,
  })
  return shared
}

/** Tests and the demo build set their own (or none). */
export function setRequestsService(s: RequestsService | null): void { shared = s }
