// =============================================================================
//  HyperProx — Certificates: the daily check
//
//  Fires on `schedule.check` (five-field cron, local time; the default when no
//  policy file exists is 06:15). The policy is re-read at every tick, so a
//  changed schedule takes effect without a restart. Uses the Updates cron
//  parser and its dueMinutes, so a stalled process never fires a burst.
//
//  A check that falls while HyperProx is locked is skipped and recorded: keys,
//  the DNS credential and node logins are in the vault, so a locked HyperProx
//  has nothing to renew or deploy with. Nothing is caught up later, and nothing
//  here ever issues a certificate for the first time (see service.ts).
// =============================================================================

import { dueMinutes } from '../updates/scheduler'
import type { CertsService } from './service'

export interface CertsSchedulerDeps {
  service:    Pick<CertsService, 'dailyCheck' | 'recordSkip'>
  /** The `schedule.check` expression now in force. */
  cron:       () => string
  isUnlocked: () => boolean
  log?:       (msg: string) => void
  now?:       () => Date
}

export type TickResult = 'idle' | 'locked' | 'busy' | 'started' | 'error'

export class CertsScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private last: Date
  private running: Promise<void> | null = null

  constructor(private deps: CertsSchedulerDeps) {
    this.last = this.now()
  }

  private now(): Date { return this.deps.now ? this.deps.now() : new Date() }

  start(intervalMs = 30_000): void {
    if (this.timer) return
    this.timer = setInterval(() => { this.tick().catch(e => this.deps.log?.(`[certs] scheduler: ${e.message}`)) }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Resolves when a check this scheduler started has finished. For tests. */
  async idle(): Promise<void> { await this.running }

  /** One look at the clock. The check itself runs in the background; renewals can take minutes. */
  async tick(): Promise<TickResult> {
    const now = this.now()
    const since = this.last
    this.last = now
    let due: Date[]
    try { due = dueMinutes(this.deps.cron(), since, now) }
    catch (e: any) { this.deps.log?.(`[certs] schedule not understood: ${e.message}`); return 'error' }
    if (!due.length) return 'idle'
    if (!this.deps.isUnlocked()) {
      this.deps.log?.('[certs] daily check skipped: HyperProx is locked, so it has no keys or credentials to work with')
      await this.deps.service.recordSkip('HyperProx was locked').catch(() => undefined)
      return 'locked'
    }
    if (this.running) {
      this.deps.log?.('[certs] daily check skipped: the previous one is still running')
      return 'busy'
    }
    this.running = this.deps.service.dailyCheck()
      .catch(e => this.deps.log?.(`[certs] daily check failed: ${e?.message ?? e}`))
      .finally(() => { this.running = null })
    return 'started'
  }
}
