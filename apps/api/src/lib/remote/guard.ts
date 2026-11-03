// =============================================================================
//  HyperProx — Remote access: the node guard
//
//  Before and after any change on a Proxmox node: the default routes, the
//  resolver, and quorum. Any difference, or anything that cannot be read, is a
//  reason to roll back. "Could not read quorum" never counts as "quorate".
// =============================================================================

export interface NodeSnapshot {
  read: boolean
  def4: string; def6: string; resolvLink: string; resolv: string
  quorate: string     // Yes | No | standalone | unknown
}

export function parseSnapshot(output: string): NodeSnapshot {
  const m = new Map<string, string>()
  for (const line of output.split('\n')) {
    const x = /^(HP_[A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (x) m.set(x[1], x[2].trim())
  }
  return {
    read: m.has('HP_QUORATE') && m.has('HP_DEF4') && m.has('HP_RESOLV'),
    def4: m.get('HP_DEF4') ?? '', def6: m.get('HP_DEF6') ?? '',
    resolvLink: m.get('HP_RESOLV_LINK') ?? '', resolv: m.get('HP_RESOLV') ?? '',
    quorate: m.get('HP_QUORATE') || 'unknown',
  }
}

const QUORATE_OK = new Set(['Yes', 'standalone'])

/** Null when the node may be changed, or why not. */
export function snapshotReady(s: NodeSnapshot): string | null {
  if (!s.read) return 'could not read the node\'s routes, resolver and quorum'
  if (s.quorate === 'No') return 'the cluster is not quorate'
  if (!QUORATE_OK.has(s.quorate)) return `could not read quorum (pvecm status said "${s.quorate}")`
  return null
}

/** Every difference that matters, in plain words. Empty when the node is as it was. */
export function compareSnapshots(before: NodeSnapshot, after: NodeSnapshot): string[] {
  if (!after.read) return ['could not read the node\'s routes, resolver and quorum after the change']
  const out: string[] = []
  if (before.def4 !== after.def4) out.push(`the IPv4 default route changed (was "${before.def4 || 'none'}", now "${after.def4 || 'none'}")`)
  if (before.def6 !== after.def6) out.push(`the IPv6 default route changed (was "${before.def6 || 'none'}", now "${after.def6 || 'none'}")`)
  if (before.resolvLink !== after.resolvLink || before.resolv !== after.resolv) {
    out.push(`the resolver changed (was "${before.resolv || 'empty'}" via ${before.resolvLink || '?'}, now "${after.resolv || 'empty'}" via ${after.resolvLink || '?'})`)
  }
  if (!QUORATE_OK.has(after.quorate) || before.quorate !== after.quorate) out.push(`quorum changed (was ${before.quorate}, now ${after.quorate})`)
  return out
}
