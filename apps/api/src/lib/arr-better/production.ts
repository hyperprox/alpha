// =============================================================================
//  HyperProx — Arr Stack "Find a better copy": production wiring
//
//  Reads the arrs and qBittorrent through the Arr Stack plug-in's own endpoints (Sonarr is its default endpoint; the
//  keys stay in the vault-backed settings) and audits through lib/audit, failing closed.
// =============================================================================

import { findPlugin } from '../../plugins'
import { pluginEndpointClient, type CoreEndpointClient } from '../plugin-host'
import { auditOrThrow } from '../audit'
import { BetterCopyService } from './service'

const endpoint = (key: string) => async (): Promise<CoreEndpointClient | null> => {
  const p = findPlugin('arrstack')
  return p ? pluginEndpointClient(p, key).catch(() => null) : null
}

let shared: BetterCopyService | null = null

export function betterCopyService(): BetterCopyService {
  if (shared) return shared
  shared = new BetterCopyService({
    clients: { sonarr: endpoint('default'), radarr: endpoint('radarr'), lidarr: endpoint('lidarr') },
    qbit: endpoint('qbit'),
    audit: (action, details) => auditOrThrow(action, 'plugin:arrstack', details),
    now: () => Date.now(),
  })
  return shared
}

/** Tests set their own. */
export function setBetterCopyService(s: BetterCopyService | null): void { shared = s }
