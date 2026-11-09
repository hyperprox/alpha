// =============================================================================
//  HyperProx — the one rule for every script sent to a remote cluster's node
//
//  A safety net, not a sandbox: HyperProx's own scripts are fixed text, and this catches a mistake in one of
//  them (or a value that slipped into one) before it reaches a node. It refuses any script naming corosync,
//  pve-cluster or pmxcfs, and any /etc/pve path except the two HyperProx documents: a container's own config
//  file (the guest config editor's write, and its temp files) and reading ceph.conf (the hardware probe).
// =============================================================================

const ALLOWED_PVE = [
  /\/etc\/pve\/nodes\/[A-Za-z0-9.-]+\/lxc\/\d+\.conf(\.tmp\.hpx\.[A-Za-z0-9_.*$]*)?/g,
  /\/etc\/pve\/ceph\.conf/g,
]

export function assertSafeScript(script: string): void {
  if (/corosync|pve-cluster|pmxcfs/i.test(script)) {
    throw new Error('Refused: this script names corosync or pve-cluster, which HyperProx never touches on any cluster.')
  }
  let rest = script
  for (const re of ALLOWED_PVE) rest = rest.replace(re, '')
  if (/\/etc\/pve\b/.test(rest)) throw new Error('Refused: this script names a path under /etc/pve that HyperProx does not write on a remote cluster.')
}
