// Handbook persistence: playbooks and the house rules. In memory for tests, Prisma in production.
import type { HouseRules, Playbook, PlaybookInput } from './playbook'
import { normalizeRules, normalizePlaybook } from './playbook'

export interface PlaybookStore {
  list(o?: { approved?: boolean }): Promise<Playbook[]>
  get(id: string): Promise<Playbook | null>
  getByKey(key: string): Promise<Playbook | null>
  create(p: Required<PlaybookInput>): Promise<Playbook>
  /** Change some fields. Null when there is no such playbook. */
  update(id: string, patch: Partial<Required<PlaybookInput>>): Promise<Playbook | null>
  remove(id: string): Promise<boolean>
  getRules(): Promise<HouseRules>
  saveRules(r: { text: string; rules: string[] }, by: string): Promise<HouseRules>
}

const EMPTY_RULES: HouseRules = { text: '', rules: [], updatedAt: null, updatedBy: '' }

export class MemoryPlaybookStore implements PlaybookStore {
  rows: Playbook[] = []
  rules: HouseRules = { ...EMPTY_RULES }
  private n = 0
  async list(o: { approved?: boolean } = {}) { return this.rows.filter(r => o.approved === undefined || r.approved === o.approved).map(r => ({ ...r })) }
  async get(id: string) { const r = this.rows.find(x => x.id === id); return r ? { ...r } : null }
  async getByKey(key: string) { const r = this.rows.find(x => x.key === key); return r ? { ...r } : null }
  async create(p: Required<PlaybookInput>) {
    const now = new Date()
    const row: Playbook = { ...p, id: `pb${++this.n}`, createdAt: now, updatedAt: now }
    this.rows.push(row)
    return { ...row }
  }
  async update(id: string, patch: Partial<Required<PlaybookInput>>) {
    const r = this.rows.find(x => x.id === id)
    if (!r) return null
    Object.assign(r, patch, { updatedAt: new Date() })
    return { ...r }
  }
  async remove(id: string) { const n = this.rows.length; this.rows = this.rows.filter(x => x.id !== id); return this.rows.length < n }
  async getRules() { return { ...this.rules } }
  async saveRules(r: { text: string; rules: string[] }, by: string) { this.rules = { ...normalizeRules(r), updatedAt: new Date(), updatedBy: by }; return { ...this.rules } }
}

const row = (r: any): Playbook => ({
  id: r.id, key: r.key, title: r.title, tags: r.tags ?? [], symptoms: r.symptoms ?? [], severity: r.severity, area: r.area,
  checks: r.checks, cause: r.cause, fix: r.fix, safety: r.safety, testScenario: r.testScenario, source: r.source, approved: r.approved,
  createdAt: r.createdAt, updatedAt: r.updatedAt,
})

const RULES_ID = 'rules'

export class PrismaPlaybookStore implements PlaybookStore {
  constructor(private db: any) {}
  async list(o: { approved?: boolean } = {}) {
    const rows = await this.db.aiPlaybook.findMany({ where: o.approved === undefined ? {} : { approved: o.approved }, orderBy: [{ area: 'asc' }, { title: 'asc' }] })
    return rows.map(row)
  }
  async get(id: string) { const r = await this.db.aiPlaybook.findUnique({ where: { id } }); return r ? row(r) : null }
  async getByKey(key: string) { const r = await this.db.aiPlaybook.findUnique({ where: { key } }); return r ? row(r) : null }
  async create(p: Required<PlaybookInput>) {
    // A second playbook with the same key gets a numbered one, so a person's "add" never collides with an import.
    let key = p.key, n = 1
    while (await this.db.aiPlaybook.findUnique({ where: { key } })) key = `${p.key}-${++n}`
    return row(await this.db.aiPlaybook.create({ data: { ...p, key } }))
  }
  async update(id: string, patch: Partial<Required<PlaybookInput>>) {
    try { return row(await this.db.aiPlaybook.update({ where: { id }, data: patch })) } catch (e: any) { if (e?.code === 'P2025') return null; throw e }
  }
  async remove(id: string) {
    try { await this.db.aiPlaybook.delete({ where: { id } }); return true } catch (e: any) { if (e?.code === 'P2025') return false; throw e }
  }
  async getRules(): Promise<HouseRules> {
    const r = await this.db.aiHouseRules.findUnique({ where: { id: RULES_ID } })
    if (!r) return { ...EMPTY_RULES }
    const n = normalizeRules({ text: r.text, rules: r.rules })
    return { ...n, updatedAt: r.updatedAt, updatedBy: r.updatedBy }
  }
  async saveRules(input: { text: string; rules: string[] }, by: string): Promise<HouseRules> {
    const n = normalizeRules(input)
    const r = await this.db.aiHouseRules.upsert({
      where: { id: RULES_ID }, create: { id: RULES_ID, text: n.text, rules: n.rules, updatedBy: by }, update: { text: n.text, rules: n.rules, updatedBy: by },
    })
    return { ...n, updatedAt: r.updatedAt, updatedBy: r.updatedBy }
  }
}

/** Create or update a playbook by its key. Used by the importer, which must be safe to run twice. */
export async function upsertByKey(store: PlaybookStore, input: unknown, o: { overwrite: boolean }): Promise<'created' | 'updated' | 'skipped' | { error: string }> {
  const n = normalizePlaybook(input)
  if (!n.ok) return { error: n.error }
  const have = await store.getByKey(n.value.key)
  if (!have) { await store.create(n.value); return 'created' }
  if (!o.overwrite) return 'skipped'
  const { key: _k, ...rest } = n.value
  await store.update(have.id, rest)
  return 'updated'
}
