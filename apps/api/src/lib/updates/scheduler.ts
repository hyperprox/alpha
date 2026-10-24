// =============================================================================
//  HyperProx — Updates: scheduler
//
//  Starts the weekly run from `schedule.cron`. Off unless a policy file loaded
//  and says `schedule.enabled: true`. The policy is re-read at every tick, so
//  turning the schedule off in the file takes effect without a restart.
//
//  A tick that falls while HyperProx is locked is skipped and logged: the
//  Proxmox token and node logins live in the vault, so a locked HyperProx has
//  nothing to run with. Missed runs are not caught up later — an upgrade at an
//  hour nobody chose is worse than one a week late.
// =============================================================================

import { parseCron, cronMatches } from './cron'
import type { PolicyLoad } from './policy'
import type { UpdatesRunner } from './runner'
import { ActiveJobError } from './store'

export interface SchedulerDeps {
  runner:     Pick<UpdatesRunner, 'start'>
  loadPolicy: () => PolicyLoad
  isUnlocked: () => boolean
  log?:       (msg: string) => void
  now?:       () => Date
}

/** Minutes in (after, upTo] at which the expression fires. Pure, for the tick and its tests. */
export function dueMinutes(cron: string, after: Date, upTo: Date): Date[] {
  const spec = parseCron(cron)
  const out: Date[] = []
  const d = new Date(after.getTime())
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  // A long stall (laptop sleep, paused container) must not fire a burst; look back an hour at most.
  const floor = upTo.getTime() - 3_600_000
  if (d.getTime() < floor) d.setTime(floor - (floor % 60_000))
  while (d.getTime() <= upTo.getTime()) {
    if (cronMatches(spec, d)) out.push(new Date(d.getTime()))
    d.setMinutes(d.getMinutes() + 1)
  }
  return out
}

export class UpdatesScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private last: Date

  constructor(private deps: SchedulerDeps) {
    this.last = this.now()
  }

  private now(): Date { return this.deps.now ? this.deps.now() : new Date() }

  start(intervalMs = 30_000): void {
    if (this.timer) return
    this.timer = setInterval(() => { this.tick().catch(e => this.deps.log?.(`[updates] scheduler: ${e.message}`)) }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One check. Returns what it did, for tests and the log. */
  async tick(): Promise<'off' | 'idle' | 'locked' | 'busy' | 'started' | 'error'> {
    const now = this.now()
    const since = this.last
    this.last = now
    const load = this.deps.loadPolicy()
    if (!load.loaded || !load.policy.schedule.enabled) return 'off'
    let due: Date[]
    try { due = dueMinutes(load.policy.schedule.cron, since, now) }
    catch (e: any) { this.deps.log?.(`[updates] schedule not understood: ${e.message}`); return 'error' }
    if (!due.length) return 'idle'
    if (!this.deps.isUnlocked()) {
      this.deps.log?.('[updates] scheduled run skipped: HyperProx is locked, so it has no credentials to run with')
      return 'locked'
    }
    try {
      await this.deps.runner.start('run', 'schedule')
      return 'started'
    } catch (e: any) {
      if (e instanceof ActiveJobError) {
        this.deps.log?.(`[updates] scheduled run skipped: job ${e.runningJobId} is still active`)
        return 'busy'
      }
      this.deps.log?.(`[updates] scheduled run did not start: ${e.message}`)
      return 'error'
    }
  }
}
