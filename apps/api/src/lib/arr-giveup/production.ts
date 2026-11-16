// =============================================================================
//  HyperProx — Arr Stack "Give up after X tries": production wiring and the timer
//
//  The service reads the arrs through the Arr Stack plug-in's endpoints (Sonarr is its default endpoint), keeps
//  its counts in Postgres, audits through lib/audit and notifies through lib/notify. The timer ticks every 15
//  minutes; a tick reads each app at most every three hours and acts at most once a day, and does nothing while
//  HyperProx is locked (the arrs' keys are in the vault). Started by lib/services/bootstrap.ts.
// =============================================================================

import { findPlugin } from '../../plugins'
import { pluginEndpointClient, type CoreEndpointClient } from '../plugin-host'
import { auditOrThrow } from '../audit'
import { publish } from '../notify'
import { isUnlocked } from '../vault/state'
import { GiveUpService } from './service'
import { PrismaGiveUpStore } from './store'

const endpoint = (key: string) => async (): Promise<CoreEndpointClient | null> => {
  const p = findPlugin('arrstack')
  return p ? pluginEndpointClient(p, key).catch(() => null) : null
}

let shared: GiveUpService | null = null

export function giveUpService(prisma?: unknown, log?: (m: string) => void): GiveUpService {
  if (shared) return shared
  if (!prisma) throw new Error('The give-up service needs the database.')
  shared = new GiveUpService({
    clients: { sonarr: endpoint('default'), radarr: endpoint('radarr'), lidarr: endpoint('lidarr') },
    qbit: endpoint('qbit'),
    store: new PrismaGiveUpStore(prisma as any),
    audit: (action, details) => auditOrThrow(action, 'plugin:arrstack', details),
    publish: e => publish(e),
    now: () => Date.now(),
    unlocked: () => isUnlocked(),
    log,
  })
  return shared
}

/** Tests and the demo build set their own (or none). */
export function setGiveUpService(s: GiveUpService | null): void { shared = s }
export function currentGiveUpService(): GiveUpService | null { return shared }

/** The timer: a tick every 15 minutes, the first two minutes after start. Returns the stop. */
export function startGiveUpTimer(svc: { tick(): Promise<unknown> }, log?: (m: string) => void, everyMs = 15 * 60_000, firstMs = 2 * 60_000): () => void {
  const go = () => { svc.tick().catch(e => log?.(`[arr-giveup] tick failed: ${e?.message ?? e}`)) }
  const first = setTimeout(go, firstMs)
  const every = setInterval(go, everyMs)
  first.unref?.(); every.unref?.()
  return () => { clearTimeout(first); clearInterval(every) }
}
