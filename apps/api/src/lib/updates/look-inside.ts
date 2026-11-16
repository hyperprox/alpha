// =============================================================================
//  HyperProx — Updates and Remote access's "never look inside" list
//
//  A guest on that list (lib/guest-guard.ts) is one HyperProx does not look
//  inside, so Updates does not read its packages, update it, or run anything in
//  it. The home executor gives the list (lookInsideExclusions); a remote
//  cluster's executor has none, and the list does not apply there. When the list
//  cannot be read, no guest is read or updated (fail closed); nodes are unaffected.
// =============================================================================

import { guestExcluded } from '../guest-guard'
import type { UpdatesExecutor } from './executor'

export const REMOTE_EXCLUDED_WORDS = "Excluded in Remote access — HyperProx doesn't look inside this guest"
export const EXCLUSIONS_UNKNOWN_WORDS = "Remote access's exclusion list could not be read, so HyperProx doesn't look inside any guest until it can"

/** The inventory-level notice, so a read that looked inside no guest never passes for "nothing to update". */
export const EXCLUSIONS_UNKNOWN_NOTICE = "HyperProx could not read Remote access's list of guests to leave alone, so it did not look inside any guest this time. An empty guest list here does not mean nothing needs updating. It will try again on the next refresh."

/** The list for this executor: undefined where it does not apply (remote clusters), null when it could not be read. */
export async function lookInsideList(exec: Pick<UpdatesExecutor, 'lookInsideExclusions'>): Promise<string[] | null | undefined> {
  if (!exec.lookInsideExclusions) return undefined
  try { return await exec.lookInsideExclusions() } catch { return null }
}

/** Why Updates must not look inside this guest, as its unmanaged reason, or null. */
export function lookInsideReason(ids: string[] | null | undefined, g: { type: 'lxc' | 'qemu'; vmid: number }): 'remote-excluded' | 'exclusions-unknown' | null {
  if (ids === undefined) return null
  if (ids === null) return 'exclusions-unknown'
  return guestExcluded({ kind: g.type, vmid: g.vmid }, { excludedMachines: ids }) ? 'remote-excluded' : null
}

export const LOOK_INSIDE_WORDS = { 'remote-excluded': REMOTE_EXCLUDED_WORDS, 'exclusions-unknown': EXCLUSIONS_UNKNOWN_WORDS } as const
