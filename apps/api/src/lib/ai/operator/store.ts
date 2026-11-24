// Operator persistence: settings (one JSON row), per-call usage, and the problem-fingerprint log. All non-secret.
import { normalizeSettings, type FingerprintRow, type OperatorSettings, type Tier, type UsageRow, type ProblemClass } from './types'

export interface OperatorStore {
  getSettings(): Promise<OperatorSettings>
  saveSettings(s: OperatorSettings, by: string): Promise<void>
  addUsage(u: UsageRow): Promise<void>
  /** Cloud and local rows on or after `since`. */
  usageSince(since: Date): Promise<UsageRow[]>
  addFingerprint(f: FingerprintRow): Promise<void>
  fingerprintsSince(fingerprint: string, since: Date): Promise<FingerprintRow[]>
}

export class MemoryOperatorStore implements OperatorStore {
  settings: OperatorSettings = normalizeSettings({})
  usage: UsageRow[] = []
  prints: FingerprintRow[] = []
  async getSettings() { return this.settings }
  async saveSettings(s: OperatorSettings) { this.settings = s }
  async addUsage(u: UsageRow) { this.usage.push(u) }
  async usageSince(since: Date) { return this.usage.filter(u => u.at >= since) }
  async addFingerprint(f: FingerprintRow) { this.prints.push(f) }
  async fingerprintsSince(fp: string, since: Date) { return this.prints.filter(p => p.fingerprint === fp && p.at >= since) }
}

const SETTINGS_ID = 'settings'

export class PrismaOperatorStore implements OperatorStore {
  constructor(private db: any) {}
  async getSettings(): Promise<OperatorSettings> {
    const r = await this.db.aiOperatorSetting.findUnique({ where: { id: SETTINGS_ID } })
    return normalizeSettings(r?.data)
  }
  async saveSettings(s: OperatorSettings, by: string): Promise<void> {
    await this.db.aiOperatorSetting.upsert({
      where: { id: SETTINGS_ID }, create: { id: SETTINGS_ID, data: s as any, updatedBy: by }, update: { data: s as any, updatedBy: by },
    })
  }
  async addUsage(u: UsageRow): Promise<void> {
    await this.db.aiOperatorUsage.create({ data: { tier: u.tier, model: u.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUsd, source: u.source, at: u.at } })
  }
  async usageSince(since: Date): Promise<UsageRow[]> {
    const rows = await this.db.aiOperatorUsage.findMany({ where: { at: { gte: since } } })
    return rows.map((r: any) => ({ tier: r.tier as Tier, model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: Number(r.costUsd), source: r.source, at: r.at }))
  }
  async addFingerprint(f: FingerprintRow): Promise<void> {
    await this.db.aiOperatorFingerprint.create({ data: { fingerprint: f.fingerprint, tier: f.tier, problemClass: f.problemClass, at: f.at } })
  }
  async fingerprintsSince(fingerprint: string, since: Date): Promise<FingerprintRow[]> {
    const rows = await this.db.aiOperatorFingerprint.findMany({ where: { fingerprint, at: { gte: since } } })
    return rows.map((r: any) => ({ fingerprint: r.fingerprint, tier: r.tier as Tier, problemClass: r.problemClass as ProblemClass, at: r.at }))
  }
}
