// =============================================================================
//  HyperProx — Updates: the package cache step before apt
//
//  Just before apt runs on a guest (or on a node, only when the cluster's
//  setting turns nodes on), the runner asks the package cache's service what
//  to do there (lib/aptcache/service.ts decide): point apt at the cache, take
//  HyperProx's drop-in out again, or leave it. The script runs through the
//  same executor as apt itself, so the leave-alone rule applies.
//
//  It never fails an update: whatever goes wrong here is one line in the
//  step's log, and apt runs as it would have. The drop-in has its own
//  fallback too (lib/aptcache/dropin.ts): a dead cache never stops an
//  update, and a sick one is skipped once HyperProx notices. Nothing here holds, unholds or touches a repository
//  file; on a node it writes only its own drop-in and detect script.
// =============================================================================

import { ensureScript, parseEnsure, parseRemove, REMOVE_SCRIPT } from '../aptcache/dropin'
import type { CacheDecision, ClientRecord } from '../aptcache/service'

export interface AptCacheHook {
  decide(clusterId: string, target: { key: string; kind: 'guest' | 'node' }): Promise<CacheDecision>
  record(clusterId: string, key: string, rec: ClientRecord): Promise<void>
}

type Exec = (script: string) => Promise<{ code: number; output: string; timedOut?: boolean }>

/** Point one guest or node at the cache (or take it out), as decided. Never throws; returns the line it logged. */
export async function prepareAptCache(
  hook: AptCacheHook | undefined, clusterId: string,
  target: { key: string; kind: 'guest' | 'node'; name: string },
  run: Exec, log: (line: string) => void, now: () => number = Date.now,
): Promise<string | null> {
  if (!hook) return null
  const say = (line: string) => { log(line); return line }
  let d: CacheDecision
  try { d = await hook.decide(clusterId, target) }
  catch (e: any) { return say(`package cache: not checked (${String(e?.message ?? e).slice(0, 160)}); apt fetches directly`) }
  if (d.action === 'leave') return null
  try {
    if (d.action === 'ensure') {
      const r = await run(ensureScript(d.host!, d.port!))
      const e = parseEnsure(r.output)
      const at = now()
      if (!e) {
        await hook.record(clusterId, target.key, { kind: target.kind, name: target.name, state: 'failed', src: null, at, detail: 'the setting could not be written' }).catch(() => {})
        return say('package cache: the setting could not be written; apt fetches directly')
      }
      if (e.result === 'own-proxy') {
        await hook.record(clusterId, target.key, { kind: target.kind, name: target.name, state: 'own-proxy', src: null, at, detail: e.own ? `its own proxy is set in ${e.own}` : undefined }).catch(() => {})
        return say(`package cache: left alone, ${target.name} has its own apt proxy${e.own ? ` (${e.own})` : ''}`)
      }
      if (e.result === 'no-apt') return null
      await hook.record(clusterId, target.key, { kind: target.kind, name: target.name, state: 'set', src: e.src, reachable: e.reachable, at }).catch(() => {})
      return say(e.reachable ? `package cache: ${d.reason}` : `package cache: set, but ${target.name} cannot reach it now, so apt fetches directly`)
    }
    const r = await run(REMOVE_SCRIPT)
    const gone = parseRemove(r.output)
    if (!gone) {
      // Not known to be gone: keep it on record as a failure, so the next run (or Remove from all guests) tries again.
      await hook.record(clusterId, target.key, { kind: target.kind, name: target.name, state: 'failed', src: null, at: now(), detail: 'its cache setting could not be taken out' }).catch(() => {})
      return say('package cache: HyperProx\'s setting could not be taken out; apt runs as usual')
    }
    await hook.record(clusterId, target.key, { kind: target.kind, name: target.name, state: 'removed', src: null, at: now() }).catch(() => {})
    return gone === 'removed' ? say(`package cache: HyperProx's setting taken out (${d.reason})`) : null
  } catch (e: any) {
    return say(`package cache: skipped (${String(e?.message ?? e).slice(0, 160)}); apt fetches directly`)
  }
}

/** The production hook: the package cache's service, loaded when first asked (it reads Updates' runtime too). */
export function productionAptCacheHook(): AptCacheHook {
  const svc = async () => (await import('../aptcache')).aptCacheService()
  return {
    decide: async (c, t) => (await svc()).decide(c, t),
    record: async (c, k, r) => (await svc()).record(c, k, r),
  }
}
