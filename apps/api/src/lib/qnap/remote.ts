// =============================================================================
//  HyperProx — QNAP: running a NAS request on a remote cluster's node
//
//  The same path every other remote-node job takes (lib/clusters/files.ts
//  liveNodeRunner): the cluster's saved node address, its saved node login, a
//  host key that must already be pinned and confirmed, the remote-script
//  guard, and `bash -s` with the script on stdin. Output is capped. Each use of
//  the node login is audited; reads (the page and the alert poller) at most
//  once per node every 10 minutes, actions every time.
// =============================================================================

import { runInCluster } from '../clusters/context'
import { clusterRow } from '../clusters/registry'
import { assertSafeScript } from '../clusters/script-guard'
import { execOnNode, nodeCredential } from '../node-exec'
import { auditCredentialUse } from '../audit'
import type { NodeScriptRunner } from './transport'

const AUDIT_EVERY_MS = 10 * 60_000
const lastAudit = new Map<string, number>()

export function liveNodeRunner(clusterId: string, node: string, purpose: 'read' | 'action'): NodeScriptRunner {
  return async (script, timeoutMs) => {
    assertSafeScript(script)
    return runInCluster(clusterId, async () => {
      const row = clusterRow(clusterId)
      const host = row?.kind === 'remote' ? row.nodeAddresses[node] : null
      if (!host) throw new Error(`No address is known for ${node}.`)
      const cred = await nodeCredential(node)
      if (!cred) throw new Error(`No node login is saved for ${node} (Edit server -> Nodes and logins).`)
      const k = `${clusterId}:${node}`
      const now = Date.now()
      if (purpose === 'action' || now - (lastAudit.get(k) ?? 0) >= AUDIT_EVERY_MS) {
        lastAudit.set(k, now)
        await auditCredentialUse('node_login.use', `node:${node}`, { purpose: `qnap ${purpose}`, cluster: clusterId })
      }
      const r = await execOnNode({ host, cred, command: 'bash -s', input: script, requirePin: true, timeoutMs, maxOutputBytes: 8 * 1024 * 1024 })
      return { code: r.code, output: r.output }
    })
  }
}
