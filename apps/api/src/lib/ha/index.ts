// =============================================================================
//  HyperProx — HA management (lib/ha)
//
//    types.ts      the shapes
//    parse.ts      PVE rows ↔ types, guest-config hardware facts
//    rules.ts      simple choices ↔ PVE rules, PVE's feasibility checks
//    predict.ts    "where would it go" (PVE's node selection, in advance)
//    insight.ts    the HA page and the guest panel, in words
//    preflight.ts  the per-node migration grid
//    read.ts       every read, through one small interface
//    plans.ts      preview → apply → re-read; the only config writer
//    power.ts      the hook that routes HA guests' start/stop through HA state
// =============================================================================

export * from './types'
export { sidOf, parseSid, hardwareOf, hardwareWords, buildSnapshot } from './parse'
export { homeOf, homeRule, homeWords, ruleWords, validateRules, problemsOfChange, flatten, tiersOf, prioritiesOf } from './rules'
export { predictFailover, moveNow } from './predict'
export { overview, guestView, badges, headroom, clusterWords, hardwareNote } from './insight'
export { preflightGrid } from './preflight'
export { gpuPortability, setGpuPortability, type GpuPortability, type GpuPortabilityFn } from './gpu'
export { readSnapshot, readMigratePreconditions, readConfig, type HaPve } from './read'
export { HaPlanner, type HaChange, type HaPlan, type HaApplyResult, type PlannerDeps } from './plans'
export { haPowerHook, setHaPowerDeps, type HaPowerResult, type HaPowerDeps } from './power'
export { pinnedFingerprint, probeFingerprint, pinFingerprint } from './hostkey'

import { HaPlanner, type PlannerDeps } from './plans'
import { setHaPowerDeps } from './power'
import { livePve } from '../pve-env'
import { execOnNode, nodeCredential } from '../node-exec'
import { isUnlocked } from '../vault/state'
import { redactSecrets } from './redact'
import { pinnedFingerprint, confirmedFingerprint } from './hostkey'
import { hostname as osHostname } from 'node:os'
export { redactSecrets, redactText } from './redact'

let planner: HaPlanner | null = null

/** A node's address from /cluster/status (names are not reliably resolvable from a container). */
export async function nodeAddress(pve: { fetchStrict<T>(p: string): Promise<T> }, node: string): Promise<string> {
  const rows = await pve.fetchStrict<any[]>('/cluster/status')
  const row = (rows ?? []).find((r: any) => r.type === 'node' && r.name === node)
  if (!row?.ip) throw new Error(`Could not find an address for node ${node}.`)
  return String(row.ip)
}


/** The production planner: the live PVE token, the audit log, and node logins for maintenance mode. */
export function haPlanner(prisma?: any, override?: Partial<PlannerDeps>): HaPlanner {
  if (planner && !override) return planner
  const pve = livePve()
  const audit = async (action: string, resource: string, details: Record<string, unknown>) => {
    if (!prisma?.auditLog) return
    await prisma.auditLog.create({ data: { action, resource, details: redactSecrets(details) } }).catch(() => undefined)
  }
  const hostFor = (node: string) => nodeAddress(pve, node)
  // Credentials come only from the vault: the Proxmox token through the credentials registry (in the
  // process while unlocked, gone on lock), node logins through getCredential. Locked: nothing is written.
  const isLocked = () => !isUnlocked()
  const deps: PlannerDeps = {
    pve: () => pve, audit, isLocked,
    hasNodeLogin: async node => Boolean(await nodeCredential(node).catch(() => null)),
    nodeExec: async (node, command) => {
      const cred = await nodeCredential(node)
      if (!cred) throw new Error(`No login stored for node ${node}`)
      const r = await execOnNode({ host: await hostFor(node), cred, command, timeoutMs: 30_000 })
      return { code: r.timedOut ? 124 : r.code, output: r.output }
    },
    // Maintenance mode needs a pin an admin confirmed, not one learned on first use.
    hostKeyPinned: async node => Boolean(await confirmedFingerprint(await hostFor(node)).catch(() => false)),
    nodeSecrets: async node => {
      const c: any = await nodeCredential(node).catch(() => null)
      return [c?.password, c?.privateKey, c?.passphrase].filter((x: unknown): x is string => typeof x === 'string' && !!x)
    },
    selfSid: snap => {
      const env = process.env.HYPERPROX_GUEST_SID
      if (env && /^(ct|vm):\d+$/.test(env)) return env
      const host = osHostname()
      const hits = snap.guests.filter(g => g.name && g.name === host)
      return hits.length === 1 ? hits[0].sid : null
    },
    ...override,
  }
  setHaPowerDeps({ pve: deps.pve, audit, isLocked: deps.isLocked })
  const p = new HaPlanner(deps)
  if (!override) planner = p
  return p
}
