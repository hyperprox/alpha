// =============================================================================
//  HyperProx — Arr Stack "Give up after X tries": where the counts live
//
//  One row per tracked item (ArrGiveUpItem: its key, app, state and the Track as JSON) and a small key/value
//  table (ArrGiveUpSetting) for each app's settings and the service's own bookmarks (the last history id read,
//  when the daily run last acted). Only changed rows are written. MemoryGiveUpStore is the same thing for tests.
// =============================================================================

import type { App, Track } from './logic'

export interface GiveUpStore {
  tracks(app?: App): Promise<Track[]>
  /** Insert or replace these tracks. */
  save(tracks: Track[]): Promise<void>
  drop(keys: string[]): Promise<void>
  getSetting<T>(id: string): Promise<T | null>
  setSetting(id: string, data: unknown, by: string): Promise<void>
}

export class MemoryGiveUpStore implements GiveUpStore {
  items = new Map<string, Track>()
  settings = new Map<string, { data: unknown; by: string }>()
  async tracks(app?: App) { return [...this.items.values()].filter(t => !app || t.app === app).map(t => structuredClone(t)) }
  async save(tracks: Track[]) { for (const t of tracks) this.items.set(t.key, structuredClone(t)) }
  async drop(keys: string[]) { for (const k of keys) this.items.delete(k) }
  async getSetting<T>(id: string) { const s = this.settings.get(id); return s ? structuredClone(s.data) as T : null }
  async setSetting(id: string, data: unknown, by: string) { this.settings.set(id, { data: structuredClone(data), by }) }
}

type Prismaish = {
  arrGiveUpItem: {
    findMany(a: any): Promise<Array<{ key: string; data: any }>>
    upsert(a: any): Promise<unknown>
    deleteMany(a: any): Promise<unknown>
  }
  arrGiveUpSetting: { findUnique(a: any): Promise<{ data: any } | null>; upsert(a: any): Promise<unknown> }
  $transaction(a: any[]): Promise<unknown>
}

export class PrismaGiveUpStore implements GiveUpStore {
  /** What was last read or written per key, so an unchanged track is not written again. */
  private known = new Map<string, string>()
  constructor(private db: Prismaish) {}

  async tracks(app?: App): Promise<Track[]> {
    const rows = await this.db.arrGiveUpItem.findMany({ where: app ? { app } : {} })
    return rows.map(r => { this.known.set(r.key, JSON.stringify(r.data)); return r.data as Track })
  }

  async save(tracks: Track[]): Promise<void> {
    const changed = tracks.filter(t => this.known.get(t.key) !== JSON.stringify(t))
    for (let i = 0; i < changed.length; i += 200) {
      const chunk = changed.slice(i, i + 200)
      await this.db.$transaction(chunk.map(t => this.db.arrGiveUpItem.upsert({
        where: { key: t.key },
        create: { key: t.key, app: t.app, state: t.state, data: t as any },
        update: { app: t.app, state: t.state, data: t as any },
      })))
      for (const t of chunk) this.known.set(t.key, JSON.stringify(t))
    }
  }

  async drop(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 500) await this.db.arrGiveUpItem.deleteMany({ where: { key: { in: keys.slice(i, i + 500) } } })
    for (const k of keys) this.known.delete(k)
  }

  async getSetting<T>(id: string): Promise<T | null> {
    const r = await this.db.arrGiveUpSetting.findUnique({ where: { id } })
    return r ? (r.data as T) : null
  }

  async setSetting(id: string, data: unknown, by: string): Promise<void> {
    await this.db.arrGiveUpSetting.upsert({ where: { id }, create: { id, data: data as any, updatedBy: by }, update: { data: data as any, updatedBy: by } })
  }
}
