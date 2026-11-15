// Why the dashboard has no numbers, in words, from the summary's answer or the live feed's problem message. Three
// different situations a person acts on differently: Proxmox refused HyperProx's token (fix it in Settings),
// Proxmox did not answer (HyperProx keeps trying), and HyperProx's own server did not answer. Free of CSS and React
// so it can be tested in Node.

import { API_DOWN_TEXT, requestIdOf } from './api'

export type DashboardProblemKind = 'proxmox_auth' | 'proxmox_unreachable' | 'server'

export interface DashboardProblem {
  kind: DashboardProblemKind
  message: string
  /** The API's reference for the failed request, when there was one. */
  requestId?: string
}

export const PROXMOX_UNREACHABLE_TEXT = "HyperProx can't reach your Proxmox right now. Retrying."
export const SERVER_DOWN_TEXT = "HyperProx's server isn't answering. Retrying."

/** From a failed GET /api/proxmox/summary (status 0: the request itself failed). Null when it did not fail. */
export function summaryProblem(status: number, body: any): DashboardProblem | null {
  if (status >= 200 && status < 300 && body?.success !== false && body?.ok !== false) return null
  const requestId = requestIdOf(body)
  const code = typeof body?.code === 'string' ? body.code : ''
  if (code === 'proxmox_auth') return { kind: 'proxmox_auth', message: typeof body.error === 'string' ? body.error : "Proxmox refused HyperProx's access key. Check the token in Settings → Proxmox.", requestId }
  if (code === 'proxmox_unreachable') return { kind: 'proxmox_unreachable', message: PROXMOX_UNREACHABLE_TEXT, requestId }
  if (code === 'api_down') return { kind: 'server', message: API_DOWN_TEXT }
  if (status === 0 || status === 502 || status === 503 || status === 504 || !body) return { kind: 'server', message: SERVER_DOWN_TEXT, requestId }
  return { kind: 'server', message: typeof body?.error === 'string' && body.error ? body.error : SERVER_DOWN_TEXT, requestId }
}

/** From the live feed: a `feed-problem` message, or the `problem` on a stale `fast` message. */
export function feedProblem(p: any): DashboardProblem | null {
  if (!p || typeof p !== 'object') return null
  if (p.code === 'proxmox_auth') return { kind: 'proxmox_auth', message: typeof p.error === 'string' ? p.error : "Proxmox refused HyperProx's access key. Check the token in Settings → Proxmox." }
  return { kind: 'proxmox_unreachable', message: PROXMOX_UNREACHABLE_TEXT }
}
