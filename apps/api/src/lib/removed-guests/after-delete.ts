// =============================================================================
//  HyperProx — removed guests: the hook HyperProx's own guest delete runs
//
//  After a delete that read back gone, the same clean-up the Removed guests
//  notice offers runs at once, for the home cluster only (a remote cluster's
//  guests have no HyperProx records here). What the guest's install published
//  goes only when the person chose it. Loaded lazily, so the routes that delete
//  guests do not pull the background services into their import graph.
// =============================================================================

import { isRemoteContext } from '../clusters/context'
import { actorWords, contextActor } from '../http/request-actor'
import type { CleanChoice } from './holdings'

export function forgetAfterDelete(choice: CleanChoice = {}, by: string = actorWords(contextActor())) {
  return async (g: { node: string; type: 'lxc' | 'qemu'; vmid: number }, name: string): Promise<string> => {
    if (isRemoteContext()) return ''
    const { removedGuests } = await import('./index')
    return removedGuests().afterDestroy({ ...g, name }, choice, by)
  }
}
