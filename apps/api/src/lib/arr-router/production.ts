// =============================================================================
//  HyperProx — Arr Stack "Sort requests into the right folder": production wiring and the timer
//
//  The service reads Radarr and Sonarr through the Arr Stack plug-in's endpoints (Sonarr is its default endpoint),
//  keeps its state in Postgres and audits through lib/audit (a move whose audit row cannot be written is not made).
//  The timer ticks every minute; a tick does nothing while HyperProx is locked (the arrs' keys are in the vault) or
//  while no app has sorting switched on. Started by lib/services/bootstrap.ts.
// =============================================================================

import { findPlugin } from '../../plugins'
import { pluginEndpointClient, type CoreEndpointClient } from '../plugin-host'
import { auditOrThrow } from '../audit'
import { isUnlocked } from '../vault/state'
import { RouterService } from './service'
import { PrismaRouterStore } from './store'

const endpoint = (key: string) => async (): Promise<CoreEndpointClient | null> => {
  const p = findPlugin('arrstack')
  return p ? pluginEndpointClient(p, key).catch(() => null) : null
}

let shared: RouterService | null = null

export function routerService(prisma?: unknown, log?: (m: string) => void): RouterService {
  if (shared) return shared
  if (!prisma) throw new Error('The folder sorter needs the database.')
  shared = new RouterService({
    clients: { sonarr: endpoint('default'), radarr: endpoint('radarr') },
    store: new PrismaRouterStore(prisma as any),
    audit: (action, details) => auditOrThrow(action, 'plugin:arrstack', details),
    now: () => Date.now(),
    unlocked: () => isUnlocked(),
    log,
  })
  return shared
}

/** Tests and the demo build set their own (or none). */
export function setRouterService(s: RouterService | null): void { shared = s }
export function currentRouterService(): RouterService | null { return shared }

/** The timer: a tick every minute, the first one a minute after start. Returns the stop. */
export function startRouterTimer(svc: { tick(): Promise<unknown> }, log?: (m: string) => void, everyMs = 60_000, firstMs = 60_000): () => void {
  const go = () => { svc.tick().catch(e => log?.(`[arr-router] tick failed: ${e?.message ?? e}`)) }
  const first = setTimeout(go, firstMs)
  const every = setInterval(go, everyMs)
  first.unref?.(); every.unref?.()
  return () => { clearTimeout(first); clearInterval(every) }
}
