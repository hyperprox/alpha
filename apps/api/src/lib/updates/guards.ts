// =============================================================================
//  HyperProx — Updates: what the plug-ins say about a guest
//
//  Two things a plug-in knows and Updates must respect (home cluster only):
//    - a compose project it manages has its own careful update on its page
//      (lib/compose-owners.ts): Updates shows it, never pulls it;
//    - a long job of its runs in a guest right now (lib/long-jobs.ts, a
//      Nextcloud update or database repair): nothing in that guest is touched.
//  The tree and the plan use these to say why; the runner asks again, fresh,
//  before each guest and before each pull.
// =============================================================================

import { composeOwnerRefusal, composeOwnership, type ComposeOwnership } from '../compose-owners'
import { busyInGuest, busyJobs, busyWords, type LongJob } from '../long-jobs'
import type { GuardContext } from './targets'

/** The checks, from what was read. */
export function guardsFrom(owners: ComposeOwnership, busy: LongJob[]): Required<GuardContext> {
  return {
    composeOwner: (vmid, p) => composeOwnerRefusal(owners, vmid, p),
    guestBusy: vmid => {
      const b = busyInGuest(busy, vmid)
      return b.length ? `${vmid} is busy (${busyWords(b)}); nothing in it is updated until that finishes` : null
    },
  }
}

/** Read now: the plug-ins' compose projects and the long jobs running. */
export async function homeGuards(): Promise<Required<GuardContext>> {
  return guardsFrom(await composeOwnership(), busyJobs())
}
