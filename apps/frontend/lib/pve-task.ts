// Waiting for a Proxmox task an action started (snapshot, rollback, delete, migration) to really finish. The
// action's answer is only its task id (UPID); "done" before the task stops was a guess, and the page then
// refreshed too early (a deleted snapshot still listed, a migrated guest still shown on its old node).
// CSS-free so it can be tested on its own.

export interface TaskStatus { status: string; exitstatus?: string }
export interface TaskOutcome { ok: boolean; exitstatus: string; timedOut?: boolean }

/** A Proxmox task id, as the API answers an action with one. */
export function isUpid(v: unknown): v is string {
  return typeof v === 'string' && /^UPID:[^:/?#]+:/.test(v)
}

/** The node a UPID ran on (its second field), for asking about it. */
export function upidNode(upid: string): string | null {
  return /^UPID:([^:]+):/.exec(upid)?.[1] ?? null
}

/**
 * Poll a task until it stops. `read` answers the task's status (null when it could not be read: tried again).
 * Resolves ok only on exit status OK; a timeout says so instead of claiming success.
 */
export async function waitForTask(read: () => Promise<TaskStatus | null>,
  opts: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<TaskOutcome> {
  const interval = opts.intervalMs ?? 1000
  const timeout = opts.timeoutMs ?? 10 * 60_000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  for (let waited = 0; waited <= timeout; waited += interval) {
    const st = await read().catch(() => null)
    if (st && st.status === 'stopped') return { ok: st.exitstatus === 'OK', exitstatus: st.exitstatus ?? 'unknown' }
    await sleep(interval)
  }
  return { ok: false, exitstatus: 'still running', timedOut: true }
}

/** What a page says while and after a task runs: "Migration: running…", "Migration: done", "Migration failed: …". */
export function taskWords(label: string, o: TaskOutcome | null): string {
  if (!o) return `${label}: running…`
  if (o.ok) return `${label}: done`
  if (o.timedOut) return `${label}: still running in Proxmox; check its task log`
  return `${label} failed: ${o.exitstatus}`
}
