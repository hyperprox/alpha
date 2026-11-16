// =============================================================================
//  HyperProx — what each guest on the home cluster is, for "what's on my cluster"
//
//  Nothing new is scanned. What HyperProx already found is reused: the Homepage
//  inventory (the shared service scan, the Catalogue's "already here" and its
//  install records, the addresses saved in configured plug-ins and their device
//  lists, and each guest's configured address) and the Websites list. The
//  inventory is read from its cache at once, however old (the answer then says
//  "as of"), and rebuilt in the background when stale; it is waited for only
//  when it was never built, and then only up to a budget. A guest on Remote access's "never look inside" list (or tagged
//  hyperprox-ignore) has none shown. Admins only (hintsForRole): below admin the
//  inventory is the Guests page's facts and nothing here is read.
// =============================================================================

import type { AppHints } from './inventory'
import type { Inventory } from '../homepage/types'
import { knownApp } from '../homepage/catalog'
import { hasRole, type Role } from '../roles'

export interface HintDeps {
  peek(): { inv: Inventory; at: number } | null
  build(): Promise<Inventory>
  /** How long a built inventory counts as fresh (ms). */
  freshMs: number
  sites(): Promise<Array<{ name: string; kindName: string; vmid: number }>>
  /** How long to wait for an inventory that was never built (ms). */
  budgetMs: number
  now(): number
}

const late = <T,>(p: Promise<T>, ms: number): Promise<T | 'late'> => {
  let t: NodeJS.Timeout | undefined
  return Promise.race([p, new Promise<'late'>(r => { t = setTimeout(() => r('late'), ms) })]).finally(() => { if (t) clearTimeout(t) })
}

/**
 * The hints for who is asking: admins only, as the Catalogue's detection, the Websites list and guest addresses are
 * admin pages. Below admin nothing is read at all (not read and then hidden).
 */
export async function hintsForRole(role: Role | undefined, d: HintDeps): Promise<AppHints | null> {
  return role && hasRole(role, 'admin') ? appHints(d) : null
}

export async function appHints(d: HintDeps): Promise<AppHints> {
  const out: AppHints = { apps: {}, addresses: {}, asOf: null, note: null }
  const add = (vmid: number, name: string) => {
    if (!Number.isFinite(vmid) || !name) return
    const list = (out.apps[vmid] ??= [])
    if (!list.includes(name)) list.push(name)
  }

  const sitesP = d.sites().catch(() => [])
  let inv: Inventory | null = null
  const kept = d.peek()
  if (kept) {
    inv = kept.inv
    out.asOf = kept.at
    if (d.now() - kept.at >= d.freshMs) void d.build().catch(() => {})
  } else {
    const got = await late(d.build().catch(() => null), d.budgetMs)
    if (got === 'late') out.note = 'What each guest runs is still being looked up; ask again in a minute for the apps and addresses.'
    else if (got) { inv = got; out.asOf = null }
    else out.note = 'HyperProx could not work out what each guest runs just now, so only names and tags are shown.'
  }

  if (inv) {
    const hidden = new Set(inv.excludedMachineIds)
    for (const s of inv.services) {
      const vmid = s.guest?.vmid
      if (vmid === undefined || vmid === null) continue
      add(Number(vmid), knownApp(s.key)?.name ?? (s.key === 'hyperprox' ? 'HyperProx' : s.key))
    }
    for (const g of inv.guests) {
      if (hidden.has(g.machineId) || g.tags.includes('hyperprox-ignore')) continue
      if (g.addresses[0]) out.addresses[g.vmid] = g.addresses[0]
    }
  }
  for (const s of await sitesP) add(Number(s.vmid), `${s.kindName} website ${s.name}`)
  return out
}
