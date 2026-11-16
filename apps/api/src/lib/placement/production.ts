// =============================================================================
//  HyperProx — load balancing: the production service
//
//  One PlacementService for the process, built from the live Proxmox token,
//  Prometheus, Postgres, the audit log and the node logins. The routes
//  (routes/placement.ts) and the assistant (routes/ai.ts) resolve it here; its
//  scheduler is started once, by lib/services/bootstrap.ts.
// =============================================================================

import { approverChanged } from '../users/approvals'
import { publish } from '../notify'
import { nodeAddress } from '../ha'
import { livePve } from '../pve-env'
import { auditOrThrow } from '../audit'
import { isUnlocked } from '../vault/state'
import { nodeExec as runOnNode } from '../node-exec'
import { prometheusBase } from '../service-health'
import { PlacementService } from './service'
import type { LogLike } from '../log-once'
import { livePromRange } from './read'
import { prismaPlacementStore } from './store'
import type { HaPve } from '../ha/read'

let production: PlacementService | null = null

/** The production service: the live Proxmox token, Prometheus, Postgres, the audit log and the node logins. */
export function placementService(prisma: any, log?: LogLike): PlacementService {
  if (production) return production
  const pve = livePve()
  production = new PlacementService({
    pve: () => pve as unknown as HaPve,
    prom: livePromRange(prometheusBase()),
    store: prismaPlacementStore(prisma),
    audit: (action, resource, details) => auditOrThrow(action, resource, details),
    isUnlocked,
    // Has the approver of a scheduled move been removed or demoted since they approved it? From what HyperProx holds,
    // never by borrowing anyone's session: their own live session (its role is current: a role change signs them
    // out), the audit log (a removal names the email; a role change names only a member id, so any demotion since
    // the approval counts), and the operator record a demotion to operator leaves.
    approverChanged: (email, sinceMs) => approverChanged(prisma, email, sinceMs),
    alert: async (title, lines) => {
      await publish({ type: 'placement.move.stuck', severity: 'warning', title, lines, link: '/balance', where: 'Load balancing page', fingerprint: `placement:${title}` }).catch(() => undefined)
    },
    notify: async (title, lines, fingerprint, severity = 'info') => {
      await publish({ type: 'placement.balance', severity, title, lines, link: '/balance', where: 'Load balancing page', fingerprint }).catch(() => undefined)
    },
    nodeExec: async (node, command) => {
      const r = await runOnNode(node, command, { host: n => nodeAddress(pve as any, n), timeoutMs: 30_000, maxOutputBytes: 2_000_000 })
      return r ? { code: r.timedOut ? 124 : r.code, output: r.output } : null
    },
  }, log)
  return production
}

/** For tests: put a service in place (or null to build the production one again). */
export function setPlacementService(s: PlacementService | null): void { production = s }
