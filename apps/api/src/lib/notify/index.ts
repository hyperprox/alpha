// =============================================================================
//  HyperProx — Notifications: the process-wide entry point
//  publish(event) is the only way anything sends a message. Before the service
//  is installed (tests, early start-up) it does nothing.
// =============================================================================

import type { NotifyService } from './service'
import type { NotifyEventInput } from './types'

let service: NotifyService | null = null

export function setNotifyService(s: NotifyService | null): void { service = s }
export function getNotifyService(): NotifyService | null { return service }

export async function publish(e: NotifyEventInput): Promise<void> {
  if (!service) return
  await service.publish(e)
}

export type { NotifyEventInput, Severity, ChannelKind } from './types'
