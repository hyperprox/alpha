// =============================================================================
//  HyperProx — Updates: persistence
//
//  The runner persists every state change through this interface, so a restart
//  finds the job exactly where it stopped. Production uses Prisma; tests use the
//  in-memory store below, which keeps the same one-job-at-a-time rule.
//
//  One job at a time is enforced by the database, not by a flag in this
//  process: a single UpdateLock row whose primary key is a constant. Creating a
//  job inserts it in the same transaction, so a second insert fails on the key
//  however many requests race, and the row names the job that holds it.
// =============================================================================

import type { PrismaClient } from '@prisma/client'
import type { UpdatesJob, UpdatesJobStatus, UpdatesPlan, UpdatesReport, UpdatesStep, UpdatesStepAction, UpdatesStepStatus } from './types'

export interface JobRecord {
  id:          string
  trigger:     UpdatesJob['trigger']
  status:      UpdatesJobStatus
  pauseReason: string | null
  plan:        UpdatesPlan
  report:      UpdatesReport | null
  startedAt:   Date
  finishedAt:  Date | null
}

export interface StepRecord {
  id:        string
  jobId:     string
  seq:       number
  target:    string
  action:    UpdatesStepAction
  status:    UpdatesStepStatus
  detail:    string | null
  reason:    string | null
  output:    string | null
  startedAt: Date | null
  endedAt:   Date | null
}

export type NewStep = Pick<StepRecord, 'seq' | 'target' | 'action'> & Partial<Pick<StepRecord, 'status' | 'detail' | 'reason'>>

export class ActiveJobError extends Error {
  constructor(public runningJobId: string) {
    super(`An update job is already active (${runningJobId})`)
    this.name = 'ActiveJobError'
  }
}

export const TERMINAL: UpdatesJobStatus[] = ['done', 'failed', 'cancelled']

export interface UpdatesStore {
  /** Throws ActiveJobError when another job holds the lock. */
  createJob(input: { trigger: JobRecord['trigger']; status: UpdatesJobStatus; plan: UpdatesPlan }): Promise<JobRecord>
  updateJob(id: string, patch: Partial<Omit<JobRecord, 'id'>>): Promise<JobRecord>
  /**
   * Apply `patch` only if the job's status is still one of `from`; null when it was not.
   * Every status change goes through here, so two requests racing (Resume twice, Confirm
   * against Cancel) cannot both win.
   */
  transitionJob(id: string, from: UpdatesJobStatus[], patch: Partial<Omit<JobRecord, 'id'>>): Promise<JobRecord | null>
  /** Drop the lock if this job holds it. Called when a job reaches a terminal status. */
  releaseLock(jobId: string): Promise<void>
  getJob(id: string): Promise<JobRecord | null>
  listJobs(limit: number): Promise<JobRecord[]>
  /** The job holding the lock, if any. */
  activeJob(): Promise<JobRecord | null>
  addSteps(jobId: string, steps: NewStep[]): Promise<StepRecord[]>
  updateStep(id: string, patch: Partial<Omit<StepRecord, 'id' | 'jobId'>>): Promise<StepRecord>
  getSteps(jobId: string): Promise<StepRecord[]>
  audit(action: string, resource: string, details?: Record<string, unknown>): Promise<void>
}

// --- Shapes for the API ------------------------------------------------------------

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

export function stepView(s: StepRecord): UpdatesStep {
  const v: UpdatesStep = {
    id: s.id, seq: s.seq, target: s.target, action: s.action, status: s.status,
    reason: s.reason, output: s.output, startedAt: iso(s.startedAt), endedAt: iso(s.endedAt),
  }
  if (s.detail) v.detail = s.detail
  return v
}

export function jobView(j: JobRecord, steps: StepRecord[] = []): UpdatesJob {
  return {
    id: j.id, trigger: j.trigger, status: j.status, pauseReason: j.pauseReason,
    plan: j.plan, report: j.report, startedAt: j.startedAt.toISOString(), finishedAt: iso(j.finishedAt),
    steps: [...steps].sort((a, b) => a.seq - b.seq).map(stepView),
  }
}

// --- In memory ------------------------------------------------------------------------

let counter = 0
const newId = (p: string) => `${p}${Date.now().toString(36)}${(++counter).toString(36).padStart(4, '0')}`

export class MemoryStore implements UpdatesStore {
  jobs = new Map<string, JobRecord>()
  steps = new Map<string, StepRecord>()
  lock: string | null = null
  audits: Array<{ action: string; resource: string; details?: Record<string, unknown> }> = []

  async createJob(input: { trigger: JobRecord['trigger']; status: UpdatesJobStatus; plan: UpdatesPlan }) {
    // A lock whose job already finished (a crash between the two writes) is stale, not a reason to refuse.
    if (this.lock) {
      const held = this.jobs.get(this.lock)
      if (held && !TERMINAL.includes(held.status)) throw new ActiveJobError(this.lock)
      this.lock = null
    }
    const j: JobRecord = { id: newId('job'), ...input, pauseReason: null, report: null, startedAt: new Date(), finishedAt: null }
    this.jobs.set(j.id, j)
    this.lock = j.id
    return { ...j }
  }
  async updateJob(id: string, patch: Partial<Omit<JobRecord, 'id'>>) {
    const j = this.jobs.get(id)
    if (!j) throw new Error(`no job ${id}`)
    Object.assign(j, patch)
    return { ...j }
  }
  async transitionJob(id: string, from: UpdatesJobStatus[], patch: Partial<Omit<JobRecord, 'id'>>) {
    const j = this.jobs.get(id)
    if (!j || !from.includes(j.status)) return null
    Object.assign(j, patch)
    return { ...j }
  }
  async releaseLock(jobId: string) { if (this.lock === jobId) this.lock = null }
  async getJob(id: string) { const j = this.jobs.get(id); return j ? { ...j } : null }
  async listJobs(limit: number) {
    return [...this.jobs.values()].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || b.id.localeCompare(a.id)).slice(0, limit).map(j => ({ ...j }))
  }
  async activeJob() {
    if (!this.lock) return null
    const j = await this.getJob(this.lock)
    if (!j || TERMINAL.includes(j.status)) { this.lock = null; return null }
    return j
  }
  async addSteps(jobId: string, steps: NewStep[]) {
    return steps.map(s => {
      const r: StepRecord = {
        id: newId('stp'), jobId, seq: s.seq, target: s.target, action: s.action, status: s.status ?? 'pending',
        detail: s.detail ?? null, reason: s.reason ?? null, output: null, startedAt: null, endedAt: null,
      }
      this.steps.set(r.id, r)
      return { ...r }
    })
  }
  async updateStep(id: string, patch: Partial<Omit<StepRecord, 'id' | 'jobId'>>) {
    const s = this.steps.get(id)
    if (!s) throw new Error(`no step ${id}`)
    Object.assign(s, patch)
    return { ...s }
  }
  async getSteps(jobId: string) {
    return [...this.steps.values()].filter(s => s.jobId === jobId).sort((a, b) => a.seq - b.seq).map(s => ({ ...s }))
  }
  async audit(action: string, resource: string, details?: Record<string, unknown>) { this.audits.push({ action, resource, details }) }
}

// --- Prisma -----------------------------------------------------------------------------

const LOCK_ID = 'updates'

function toJob(r: any): JobRecord {
  return {
    id: r.id, trigger: r.trigger, status: r.status, pauseReason: r.pauseReason ?? null,
    plan: r.plan as UpdatesPlan, report: (r.report ?? null) as UpdatesReport | null,
    startedAt: r.startedAt, finishedAt: r.finishedAt ?? null,
  }
}

function toStep(r: any): StepRecord {
  return {
    id: r.id, jobId: r.jobId, seq: r.seq, target: r.target, action: r.action, status: r.status,
    detail: r.detail ?? null, reason: r.reason ?? null, output: r.output ?? null,
    startedAt: r.startedAt ?? null, endedAt: r.endedAt ?? null,
  }
}

export class PrismaStore implements UpdatesStore {
  constructor(private db: PrismaClient) {}

  async createJob(input: { trigger: JobRecord['trigger']; status: UpdatesJobStatus; plan: UpdatesPlan }): Promise<JobRecord> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.$transaction(async tx => {
          const job = await tx.updateJob.create({ data: { trigger: input.trigger, status: input.status, plan: input.plan as any } })
          await tx.updateLock.create({ data: { id: LOCK_ID, jobId: job.id } })
          return toJob(job)
        })
      } catch (e: any) {
        if (e?.code !== 'P2002') throw e
        const held = await this.db.updateLock.findUnique({ where: { id: LOCK_ID } })
        if (!held) { if (attempt < 2) continue; throw new ActiveJobError('unknown') }
        const job = await this.db.updateJob.findUnique({ where: { id: held.jobId } })
        // A lock whose job already finished is stale (a crash between the two writes): drop it and retry once.
        if (attempt < 2 && (!job || TERMINAL.includes(job.status as UpdatesJobStatus))) {
          await this.db.updateLock.deleteMany({ where: { id: LOCK_ID, jobId: held.jobId } })
          continue
        }
        throw new ActiveJobError(held.jobId)
      }
    }
  }
  async updateJob(id: string, patch: Partial<Omit<JobRecord, 'id'>>) {
    const data: any = { ...patch }
    if ('plan' in patch) data.plan = patch.plan as any
    if ('report' in patch) data.report = patch.report === null ? undefined : (patch.report as any)
    return toJob(await this.db.updateJob.update({ where: { id }, data }))
  }
  async transitionJob(id: string, from: UpdatesJobStatus[], patch: Partial<Omit<JobRecord, 'id'>>) {
    const data: any = { ...patch }
    if ('plan' in patch) data.plan = patch.plan as any
    if ('report' in patch) data.report = patch.report === null ? undefined : (patch.report as any)
    const r = await this.db.updateJob.updateMany({ where: { id, status: { in: from } }, data })
    return r.count === 1 ? this.getJob(id) : null
  }
  async releaseLock(jobId: string) {
    await this.db.updateLock.deleteMany({ where: { id: LOCK_ID, jobId } })
  }
  async getJob(id: string) {
    const r = await this.db.updateJob.findUnique({ where: { id } })
    return r ? toJob(r) : null
  }
  async listJobs(limit: number) {
    return (await this.db.updateJob.findMany({ orderBy: { startedAt: 'desc' }, take: limit })).map(toJob)
  }
  async activeJob() {
    const held = await this.db.updateLock.findUnique({ where: { id: LOCK_ID } })
    if (!held) return null
    const job = await this.getJob(held.jobId)
    if (!job || TERMINAL.includes(job.status)) {
      await this.releaseLock(held.jobId)
      return null
    }
    return job
  }
  async addSteps(jobId: string, steps: NewStep[]) {
    const out: StepRecord[] = []
    for (const s of steps) {
      out.push(toStep(await this.db.updateStep.create({ data: {
        jobId, seq: s.seq, target: s.target, action: s.action, status: s.status ?? 'pending',
        detail: s.detail ?? null, reason: s.reason ?? null,
      } })))
    }
    return out
  }
  async updateStep(id: string, patch: Partial<Omit<StepRecord, 'id' | 'jobId'>>) {
    return toStep(await this.db.updateStep.update({ where: { id }, data: patch as any }))
  }
  async getSteps(jobId: string) {
    return (await this.db.updateStep.findMany({ where: { jobId }, orderBy: { seq: 'asc' } })).map(toStep)
  }
  async audit(action: string, resource: string, details?: Record<string, unknown>) {
    await this.db.auditLog.create({ data: { action, resource, details: (details ?? undefined) as any } })
  }
}
