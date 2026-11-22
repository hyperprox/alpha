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

const LATEST_FAIL_MS = 10 * 60_000

/**
 * The newest stable release's number, or null. A failed lookup (GitHub's anonymous allowance used up, offline) is
 * remembered for ten minutes, so a page that polls does not ask again every time; a good answer is cached by
 * lib/app-updates/net.ts. `now` is for tests.
 */
export function makeLatestTunarr(get: (url: string) => Promise<any> = u => fetchJson(u), now: () => number = Date.now): () => Promise<string | null> {
  let failedAt: number | null = null
  return async () => {
    if (failedAt !== null && now() - failedAt < LATEST_FAIL_MS) return null
    try {
      const r = await get(TUNARR_RELEASES)
      if (typeof r?.tag_name === 'string') { failedAt = null; return r.tag_name }
      failedAt = now(); return null
    } catch { failedAt = now(); return null }
  }
}

export const latestTunarr = makeLatestTunarr()

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
