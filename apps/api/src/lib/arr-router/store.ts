// =============================================================================
//  HyperProx — Arr Stack "Sort requests into the right folder": where its state lives
//
//  One small key/value table (ArrRouterSetting): each app's rules, each app's bookmarks (the highest id seen, which
//  new items were already looked at, the ones a person moved back) and the "Recently sorted" list. MemoryRouterStore
//  is the same thing for tests.
// =============================================================================

export interface RouterStore {
  get<T>(id: string): Promise<T | null>
  set(id: string, data: unknown, by: string): Promise<void>
}

export class MemoryRouterStore implements RouterStore {
  rows = new Map<string, { data: unknown; by: string }>()
  async get<T>(id: string) { const r = this.rows.get(id); return r ? structuredClone(r.data) as T : null }
  async set(id: string, data: unknown, by: string) { this.rows.set(id, { data: structuredClone(data), by }) }
}

type Prismaish = {
  arrRouterSetting: {
    findUnique(a: any): Promise<{ data: any } | null>
    upsert(a: any): Promise<unknown>
  }
}

export class PrismaRouterStore implements RouterStore {
  constructor(private db: Prismaish) {}
  async get<T>(id: string): Promise<T | null> {
    const r = await this.db.arrRouterSetting.findUnique({ where: { id } })
    return r ? (r.data as T) : null
  }
  async set(id: string, data: unknown, by: string): Promise<void> {
    await this.db.arrRouterSetting.upsert({ where: { id }, create: { id, data: data as any, updatedBy: by }, update: { data: data as any, updatedBy: by } })
  }
}
