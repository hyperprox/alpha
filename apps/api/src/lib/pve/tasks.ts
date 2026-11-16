// =============================================================================
//  HyperProx — Proxmox task rows, and "is a backup running"
//
//  Three features ask whether a backup is running and each keeps its own policy for an answer it could not read
//  (Updates: counts as running; Load balancing: unknown; Nextcloud: unknown, and a backup that has not named
//  its guest blocks every guest). This file reads the rows; the policy stays with each caller.
// =============================================================================

import type { ProxmoxClient } from '../proxmox-client'

/** True for a task that has not finished (Proxmox leaves endtime and status off until it does). */
export const taskRunning = (t: any): boolean => !t?.endtime && (!t?.status || t.status === 'running')

/** The guest a task names in its `id`, or null (a node-wide job has none). */
export function taskVmid(id: unknown): number | null {
  return /^\d{1,9}$/.test(String(id ?? '')) ? Number(id) : null
}

export interface RunningBackup {
  node: string
  /** The task's id as Proxmox sent it: '' when the job has not named its guest yet. */
  id: string
  vmid: number | null
}

/** The running vzdump tasks in a task list. */
export function backupRowsOf(tasks: unknown): RunningBackup[] {
  return (Array.isArray(tasks) ? tasks : [])
    .filter((t: any) => t?.type === 'vzdump' && taskRunning(t))
    .map((t: any) => ({ node: String(t.node), id: String(t.id ?? ''), vmid: taskVmid(t.id) }))
}

/** The cluster's running backups. `read` is false when the task list could not be read (rows is then empty). */
export async function runningBackups(pve: Pick<ProxmoxClient, 'fetchStrict'>): Promise<{ read: boolean; rows: RunningBackup[] }> {
  try {
    const tasks = await pve.fetchStrict<any[]>('/cluster/tasks')
    if (tasks !== undefined && tasks !== null && !Array.isArray(tasks)) return { read: false, rows: [] }
    return { read: true, rows: backupRowsOf(tasks) }
  } catch { return { read: false, rows: [] } }
}
