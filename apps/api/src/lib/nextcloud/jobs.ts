// =============================================================================
//  HyperProx — Nextcloud: where jobs are kept
//
//  A job (an update, a database repair) is written to the database when it
//  starts and at every change, so a page finds it again after the API restarts
//  and the service picks a detached update up again on startup
//  (NextcloudService.resume). Tests use the memory store.
// =============================================================================

import type { Job } from './types'

export interface JobStore {
  save(j: Job): Promise<void>
  /** Jobs still marked running, newest first. */
  running(): Promise<Job[]>
  /** The newest job of one instance. */
  latest(instanceId: string): Promise<Job | null>
  get(id: string): Promise<Job | null>
}

export class MemoryJobStore implements JobStore {
  rows = new Map<string, Job>()
  async save(j: Job) { this.rows.set(j.id, JSON.parse(JSON.stringify(j))) }
  async running() { return [...this.rows.values()].filter(j => j.state === 'running').sort((a, b) => b.startedAt.localeCompare(a.startedAt)) }
  async latest(instanceId: string) { return [...this.rows.values()].filter(j => j.instanceId === instanceId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null }
  async get(id: string) { return this.rows.get(id) ?? null }
}

const fromRow = (r: any): Job | null => {
  if (!r?.data || typeof r.data !== 'object') return null
  return { ...(r.data as Job), id: r.id, instanceId: r.instanceId, state: r.state }
}

export function prismaJobStore(db: any): JobStore {
  return {
    async save(j) {
      const row = { plugin: 'nextcloud', instanceId: j.instanceId, action: j.action, state: j.state, data: j as any, startedAt: new Date(j.startedAt), endedAt: j.endedAt ? new Date(j.endedAt) : null }
      await db.pluginJob.upsert({ where: { id: j.id }, create: { id: j.id, ...row }, update: row })
    },
    async running() {
      return (await db.pluginJob.findMany({ where: { plugin: 'nextcloud', state: 'running' }, orderBy: { startedAt: 'desc' }, take: 50 })).map(fromRow).filter(Boolean) as Job[]
    },
    async latest(instanceId) {
      return fromRow(await db.pluginJob.findFirst({ where: { plugin: 'nextcloud', instanceId }, orderBy: { startedAt: 'desc' } }))
    },
    async get(id) { return fromRow(await db.pluginJob.findUnique({ where: { id } })) },
  }
}
