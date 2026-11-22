// =============================================================================
//  HyperProx — Arr Stack, Live TV (Tunarr): production wiring
//
//  Tunarr is read and written through the Arr Stack plug-in's `tunarr` endpoint (lib/plugin-host.ts); it has no key.
//  The newest release is read from GitHub's public release list (https only, cached by lib/app-updates/net.ts).
//  Nothing here keeps state.
// =============================================================================

import { findPlugin } from '../../plugins'
import { pluginEndpointClient, type CoreEndpointClient } from '../plugin-host'
import { auditOrThrow } from '../audit'
import { fetchJson } from '../app-updates/net'
import { TunarrService } from './service'

export const TUNARR_RELEASES = 'https://api.github.com/repos/chrisbenincasa/tunarr/releases/latest'

/** The newest stable release's number, or null. */
export async function latestTunarr(get: (url: string) => Promise<any> = u => fetchJson(u)): Promise<string | null> {
  try {
    const r = await get(TUNARR_RELEASES)
    return typeof r?.tag_name === 'string' ? r.tag_name : null
  } catch { return null }
}

let shared: TunarrService | null = null

export function tunarrService(): TunarrService {
  if (shared) return shared
  shared = new TunarrService({
    client: async (): Promise<CoreEndpointClient | null> => {
      const p = findPlugin('arrstack')
      return p ? pluginEndpointClient(p, 'tunarr').catch(() => null) : null
    },
    latest: () => latestTunarr(),
    audit: (action, details) => auditOrThrow(action, 'plugin:arrstack', details),
    now: () => Date.now(),
  })
  return shared
}

/** Tests and the demo build set their own (or none). */
export function setTunarrService(s: TunarrService | null): void { shared = s }
