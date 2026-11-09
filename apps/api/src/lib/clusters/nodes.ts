// =============================================================================
//  HyperProx — the address HyperProx reaches a node on
//
//  Home: the address Proxmox reports for the node (/cluster/status), as before. Remote: the address saved for
//  that node in the registry. The address a remote node reports is on its own LAN, which HyperProx usually
//  cannot reach, so it is never guessed: a one-node server gets the server's own address when it is added, and
//  a multi-node remote has each node's private-link address entered on its Edit page.
// =============================================================================

import { currentRemote } from './context'

/** The remote's saved address for `node`, or null; `undefined` when this is not a remote context. */
export function remoteNodeAddress(node: string): string | null | undefined {
  const r = currentRemote()
  if (!r) return undefined
  return r.nodeAddresses[node] ?? null
}

/** Address for a node: the remote's saved one, else what the home cluster reports. */
export async function nodeAddressInContext(node: string, fromHome: () => Promise<string | null>): Promise<string | null> {
  const remote = remoteNodeAddress(node)
  if (remote !== undefined) return remote
  return fromHome()
}

/** Every node's address in this context, for the nodes given. */
export async function addressesInContext(nodes: string[], fromHome: () => Promise<Record<string, string>>): Promise<Record<string, string>> {
  const r = currentRemote()
  if (!r) return fromHome()
  const out: Record<string, string> = {}
  for (const n of nodes) if (r.nodeAddresses[n]) out[n] = r.nodeAddresses[n]
  return out
}
