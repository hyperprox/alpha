// =============================================================================
//  HyperProx — Updates: one cluster's view of the job store
//
//  Every cluster gets its own runner (lib/updates/service.ts), and every runner sees the jobs through this
//  wrapper. A job is stamped with the cluster it was planned for, and with a one-way key of how HyperProx
//  reached that cluster (lib/pve-env.ts connectionKey). A runner for another cluster cannot see the job at all,
//  so it cannot confirm, resume, cancel or roll it back: "No job" is all it gets. A job whose cluster has since
//  been re-pointed (another address, certificate or token) is refused too, with the reason.
//
//  The one-job-at-a-time lock stays shared by every cluster. Two Updates jobs never run at once anywhere, and
//  the daily check (lib/updates/check.ts) waits for none: it skips while any job is active.
// =============================================================================

import type { UpdatesClusterRef, UpdatesPlan } from './types'
import { ActiveJobError, type JobRecord, type NewStep, type StepRecord, type UpdatesStore } from './store'
import { JobStateError } from './runner'

/** The cluster a stored job is for. Jobs from before multi-cluster carry none: they are home's. */
export function jobCluster(j: Pick<JobRecord, 'plan'>): string {
  return (j.plan as UpdatesPlan)?.cluster?.id ?? 'home'
}

export interface ScopedStoreOptions {
  cluster: UpdatesClusterRef
  /** The connection key now; throws while locked. Home may leave it out. */
  connection?: () => string
  /** Name of a cluster by id, for a clear 409 when another cluster holds the lock. */
  nameOf?: (id: string) => string | null
}

type PlanWithKey = UpdatesPlan & { connection?: string }

export class ScopedStore implements UpdatesStore {
  constructor(private inner: UpdatesStore, private opts: ScopedStoreOptions) {}

  get clusterId(): string { return this.opts.cluster.id }

  private mine(j: JobRecord | null): JobRecord | null {
    return j && jobCluster(j) === this.clusterId ? j : null
  }

  private stamp(plan: UpdatesPlan): PlanWithKey {
    const out: PlanWithKey = { ...plan, cluster: { ...this.opts.cluster } }
    if (this.opts.connection) out.connection = this.opts.connection()
    return out
  }

  /** Keep the stamp when the runner replaces a job's plan. */
  private keep(id: string, patch: Partial<Omit<JobRecord, 'id'>>, current: JobRecord | null): Partial<Omit<JobRecord, 'id'>> {
    if (!patch.plan) return patch
    const was = (current?.plan ?? {}) as PlanWithKey
    return { ...patch, plan: { ...patch.plan, cluster: was.cluster ?? { ...this.opts.cluster }, ...(was.connection ? { connection: was.connection } : {}) } as PlanWithKey }
  }

  /**
   * Throws when this job must not be acted on: it belongs to another cluster, or it was planned over another
   * connection to this one. Called before confirm and resume (runner.checkJob).
   */
  checkJob = (job: JobRecord): void => {
    if (jobCluster(job) !== this.clusterId) throw new JobStateError(`No job ${job.id}`)
    const key = (job.plan as PlanWithKey).connection
    if (key && this.opts.connection && key !== this.opts.connection()) {
      throw new JobStateError(`Job ${job.id} was planned while ${this.opts.cluster.name} was reached another way (its address, certificate or token has changed since). Cancel it and start a new run.`)
    }
  }

  async createJob(input: { trigger: JobRecord['trigger']; status: JobRecord['status']; plan: UpdatesPlan }): Promise<JobRecord> {
    try { return await this.inner.createJob({ ...input, plan: this.stamp(input.plan) }) }
    catch (e) {
      if (!(e instanceof ActiveJobError)) throw e
      const held = await this.inner.getJob(e.runningJobId).catch(() => null)
      const other = held ? jobCluster(held) : null
      if (other && other !== this.clusterId) {
        const err = new ActiveJobError(e.runningJobId)
        err.message = `An update job is already active on ${this.opts.nameOf?.(other) ?? 'another cluster'} (${e.runningJobId}). One Updates job runs at a time across all clusters.`
        throw err
      }
      throw e
    }
  }

  async updateJob(id: string, patch: Partial<Omit<JobRecord, 'id'>>): Promise<JobRecord> {
    const cur = this.mine(await this.inner.getJob(id))
    if (!cur) throw new Error(`no job ${id}`)
    return this.inner.updateJob(id, this.keep(id, patch, cur))
  }

  async transitionJob(id: string, from: JobRecord['status'][], patch: Partial<Omit<JobRecord, 'id'>>): Promise<JobRecord | null> {
    const cur = this.mine(await this.inner.getJob(id))
    if (!cur) return null
    return this.inner.transitionJob(id, from, this.keep(id, patch, cur))
  }

  async releaseLock(jobId: string): Promise<void> {
    if (this.mine(await this.inner.getJob(jobId))) await this.inner.releaseLock(jobId)
  }

  async getJob(id: string): Promise<JobRecord | null> { return this.mine(await this.inner.getJob(id)) }

  async listJobs(limit: number): Promise<JobRecord[]> {
    // Jobs are few (one at a time, by hand or weekly); reading a wider window and filtering is enough.
    return (await this.inner.listJobs(Math.min(500, limit * 10 + 50))).filter(j => jobCluster(j) === this.clusterId).slice(0, limit)
  }

  async activeJob(): Promise<JobRecord | null> { return this.mine(await this.inner.activeJob()) }

  async addSteps(jobId: string, steps: NewStep[]): Promise<StepRecord[]> {
    if (!this.mine(await this.inner.getJob(jobId))) throw new Error(`no job ${jobId}`)
    return this.inner.addSteps(jobId, steps)
  }

  updateStep(id: string, patch: Partial<Omit<StepRecord, 'id' | 'jobId'>>): Promise<StepRecord> { return this.inner.updateStep(id, patch) }

  async getSteps(jobId: string): Promise<StepRecord[]> {
    return this.mine(await this.inner.getJob(jobId)) ? this.inner.getSteps(jobId) : []
  }

  audit(action: string, resource: string, details?: Record<string, unknown>): Promise<void> {
    return this.inner.audit(action, resource, { ...(details ?? {}), cluster: this.clusterId })
  }
}
