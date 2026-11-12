// =============================================================================
//  HyperProx — Proxmox Backup Server from the catalogue: which NAS to put the
//  backups on
//
//  The NAS HyperProx already knows: every QNAP the QNAP plug-in reads, and every
//  NFS server the cluster already uses as storage (the network storage on the
//  cluster's cards), with the export each one shares. For a NAS, its NFS
//  exports are read from the chosen node with showmount, so the person picks
//  one instead of typing a path. Nothing here mounts or writes anything.
// =============================================================================

import { exportsScript } from './nfs'

export interface KnownNas { host: string; label: string; source: 'qnap' | 'cluster'; exports: string[] }

export interface NasListDeps {
  /** The QNAP plug-in's NAS: name and address. */
  qnap(): Promise<Array<{ name: string; url: string }>>
  /** The cluster's storage list. */
  storages(): Promise<any[]>
}

export async function knownNas(d: NasListDeps): Promise<KnownNas[]> {
  const out = new Map<string, KnownNas>()
  const add = (host: string, label: string, source: KnownNas['source'], exp?: string) => {
    const k = host.toLowerCase()
    const row = out.get(k) ?? { host, label, source, exports: [] }
    if (exp && !row.exports.includes(exp)) row.exports.push(exp)
    out.set(k, row)
  }
  for (const q of await d.qnap().catch(() => [])) {
    try { add(new URL(q.url).hostname, `${q.name} (QNAP)`, 'qnap') } catch { /* no address */ }
  }
  for (const s of await d.storages().catch(() => [])) {
    if (s?.type === 'nfs' && typeof s.server === 'string' && typeof s.export === 'string') add(s.server, `${s.server} (used by the cluster as ${s.storage})`, 'cluster', s.export)
  }
  return [...out.values()]
}

/** Parse showmount's answer from exportsScript. */
export function parseExports(out: string): { exports: string[]; noShowmount: boolean } {
  const lines = String(out ?? '').split('\n').map(l => l.trim())
  return {
    noShowmount: lines.includes('@@pbs noshowmount'),
    exports: lines.map(l => /^@@pbs export (\/\S*)$/.exec(l)?.[1]).filter((x): x is string => !!x && /^\/[A-Za-z0-9._+@/-]*$/.test(x)),
  }
}

export async function listExports(node: string, host: string, run: (node: string, script: string, timeoutMs: number) => Promise<{ code: number; output: string }>): Promise<{ exports: string[]; note: string | null }> {
  const r = parseExports((await run(node, exportsScript(host), 20_000)).output)
  if (r.noShowmount) return { exports: [], note: 'The node has no showmount (nfs-common); type the export path instead.' }
  return { exports: r.exports, note: r.exports.length ? null : 'The NAS listed no NFS exports to this node. Turn NFS on for the share on the NAS, or type the path.' }
}
