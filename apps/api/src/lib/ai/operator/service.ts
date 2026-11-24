// The operator service: settings, tier status, spend and the local-tier key, around the router.
import type { OperatorStore } from './store'
import { askOperator, monthSpend, type AskInput, type OperatorDeps, type OperatorResult, type TierCall } from './router'
import { DEFAULT_PRICES, monthStart } from './pricing'
import { TIERS, isCloud, normalizeSettings, type OperatorSettings, type Tier } from './types'

export interface ServiceDeps {
  store: OperatorStore
  call: TierCall
  vaultUnlocked: () => boolean
  /** Whether a key is stored for the local tier, and for Anthropic. Never the values. */
  localKeyStored: () => Promise<boolean>
  anthropicKeyStored: () => Promise<boolean>
  /** Vault writes, for a signed-in session only (lib/credentials.ts refuses an API token). */
  saveLocalKey: (value: string) => Promise<void>
  clearLocalKey: () => Promise<void>
  knownHosts?: () => Promise<string[]>
  audit?: OperatorDeps['audit']
  now?: () => Date
}

export interface TierStatus {
  tier: Tier; enabled: boolean; model: string; cloud: boolean
  configured: boolean
  /** In words: what is still needed, or why the tier is off. Empty when it is ready. */
  missing: string
  /** Enabled and configured. */
  ready: boolean
}

export class OperatorService {
  constructor(private d: ServiceDeps) {}

  private now(): Date { return this.d.now?.() ?? new Date() }

  settings(): Promise<OperatorSettings> { return this.d.store.getSettings() }

  /** A partial change merged into the stored settings, validated, not saved. Tiers merge one by one. */
  async preview(patch: unknown): Promise<{ current: OperatorSettings; next: OperatorSettings }> {
    const cur = await this.settings()
    const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, any>
    const next = normalizeSettings({
      ...cur, ...p,
      tiers: Object.fromEntries(TIERS.map(t => [t, { ...cur.tiers[t], ...(p.tiers?.[t] ?? {}) }])),
      classStart: { ...cur.classStart, ...(p.classStart ?? {}) },
      priceOverrides: p.priceOverrides !== undefined ? p.priceOverrides : cur.priceOverrides,
    })
    return { current: cur, next }
  }

  async saveSettings(patch: unknown, by: string): Promise<OperatorSettings> {
    const { next } = await this.preview(patch)
    await this.d.store.saveSettings(next, by)
    return next
  }

  async tiers(): Promise<TierStatus[]> {
    const s = await this.settings()
    const out: TierStatus[] = []
    for (const t of TIERS) {
      const r = await this.readiness(t, s)
      out.push({ tier: t, enabled: s.tiers[t].enabled, model: s.tiers[t].model, cloud: isCloud(t), configured: r.configured, missing: r.missing, ready: s.tiers[t].enabled && r.configured })
    }
    return out
  }

  /** Is the tier set up, apart from whether it is switched on? */
  private async readiness(tier: Tier, s: OperatorSettings): Promise<{ configured: boolean; missing: string }> {
    if (!this.d.vaultUnlocked()) return { configured: false, missing: 'HyperProx is locked' }
    if (tier === 'local') {
      if (!s.localBaseUrl) return { configured: false, missing: 'an address for the local server' }
      if (!s.tiers.local.model) return { configured: false, missing: 'a model name' }
      return { configured: true, missing: '' }
    }
    return (await this.d.anthropicKeyStored().catch(() => false))
      ? { configured: true, missing: '' }
      : { configured: false, missing: 'an Anthropic key (AI, Providers)' }
  }

  async spend(): Promise<{ month: string; monthUsd: number; capUsd: number; byTier: Record<Tier, { calls: number; usd: number }>; prices: typeof DEFAULT_PRICES }> {
    const now = this.now(), s = await this.settings()
    const rows = await this.d.store.usageSince(monthStart(now))
    const byTier = Object.fromEntries(TIERS.map(t => [t, { calls: 0, usd: 0 }])) as Record<Tier, { calls: number; usd: number }>
    for (const r of rows) { byTier[r.tier].calls++; byTier[r.tier].usd = Math.round((byTier[r.tier].usd + r.costUsd) * 1e6) / 1e6 }
    return {
      month: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
      monthUsd: await monthSpend(this.d.store, now), capUsd: s.monthlyCapUsd, byTier,
      prices: Object.fromEntries(TIERS.map(t => [t, s.priceOverrides[t] ?? DEFAULT_PRICES[t]])) as typeof DEFAULT_PRICES,
    }
  }

  async keyStatus(): Promise<{ localKeyStored: boolean; anthropicKeyStored: boolean; locked: boolean }> {
    if (!this.d.vaultUnlocked()) return { localKeyStored: false, anthropicKeyStored: false, locked: true }
    return { localKeyStored: await this.d.localKeyStored().catch(() => false), anthropicKeyStored: await this.d.anthropicKeyStored().catch(() => false), locked: false }
  }

  async setLocalKey(value: string): Promise<void> {
    if (value === '') await this.d.clearLocalKey()
    else await this.d.saveLocalKey(value)
  }

  /** What the router needs, built from this service. Also what a chat connector's askOperator() call uses. */
  routerDeps(): OperatorDeps {
    return {
      store: this.d.store, call: this.d.call, vaultUnlocked: this.d.vaultUnlocked, knownHosts: this.d.knownHosts, audit: this.d.audit, now: this.d.now,
      tierReady: async (t, s) => {
        const r = await this.readiness(t, s)
        return { ready: r.configured, missing: r.missing ? `it still needs ${r.missing}` : undefined }
      },
    }
  }

  ask(input: AskInput): Promise<OperatorResult> { return askOperator(input, this.routerDeps()) }

  /** The read-only summary the AI's knowledge sources use. No secrets, no questions, no answers. */
  async summary(): Promise<{ tiers: TierStatus[]; spend: Awaited<ReturnType<OperatorService['spend']>>; settings: OperatorSettings }> {
    return { tiers: await this.tiers(), spend: await this.spend(), settings: await this.settings() }
  }
}

