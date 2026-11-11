// What /api/site-metrics answers (apps/api/src/lib/site-metrics/view.ts). Never an address or a log line.

export type Range = '24h' | '7d' | '30d'

export interface SiteAlert { kind: string; since: number; detail: string }

export interface SiteSummary {
  id: string; name: string; kind: string; adopted: boolean; domain: string | null; url: string | null
  up: boolean | null; latencyMs: number | null; checkedAt: number | null
  /** People today: visitors whose browser behaved like one (opened a page and loaded its images, styles or scripts). */
  visitorsToday: number; trendPct: number | null; pageViewsToday: number; spark: number[]
  errorRatePct: number | null; p95Ms: number | null; certDays: number | null; alerts: SiteAlert[]
  /** Opened a page but never loaded anything else; distinct bots; HyperProx's own requests. */
  unconfirmedToday?: number; botsToday?: number; ownToday?: number
  /** Today was partly counted before the accuracy fix. */
  countedBeforeFix?: boolean
  /** Bots and scanners bursting in the last hour: a note, never an alert. */
  scannerBurst?: { since: number; detail: string } | null
}

export type ProbeKind = 'secrets' | 'admin' | 'php' | 'api' | 'other'
export interface Security {
  total: number
  kinds: Array<{ kind: ProbeKind; requests: number; refused: number; answered: number; moved: number; errors: number }>
  exposedCount: number; exposed?: KeyValue[]
  catchAllCount: number; catchAll?: KeyValue[]
}

export interface KeyValue { key: string; value: number; pct?: number }

export interface WpInfo {
  checkedAt: number; wpCli: boolean; core: string | null; php: string | null
  fpm: Array<{ unit: string; active: boolean }>
  updates: Array<{ kind: 'core' | 'plugin' | 'theme'; name: string; version: string; available: string }>
  plugins: number; themes: number
  errors: Array<{ level: string; text: string; at: string | null }>
  problem?: string
}

export interface AlertSettings { enabled: boolean; errorRatePct: number; downChecks: number; certDays: number; spikeFactor: number }

export interface ContainerView {
  status: string; cpuPct: number; cores: number; memPct: number; memUsed: number; memMax: number
  diskPct: number; diskUsed: number; diskMax: number; uptimeS: number; netIn7d: number; netOut7d: number
}

export interface SiteDetail {
  summary: SiteSummary
  range: Range
  hud: {
    visitors: number; pageViews: number; requests: number; errorRatePct: number | null; p95Ms: number | null; p50Ms: number | null; bytes: number; uptimePct: number | null; hasRequestTime: boolean
    unconfirmed?: number; botVisitors?: number; unconfirmedPageViews?: number; own?: number; beforeFix?: number
  }
  series: Array<{ at: number; people: number; bots: number; visitors: number; unconfirmed?: number; before?: boolean }>
  security?: Security
  status: { s2xx: number; s3xx: number; s4xx: number; s5xx: number }
  devices: KeyValue[]; browsers: KeyValue[]; os: KeyValue[]
  pages?: KeyValue[]; referrers?: KeyValue[]; notFound?: KeyValue[]
  where?: { vmid: number; node: string }
  collector?: { logPath: string; format: string | null; lastReadAt: number | null; lastError: string | null; gaps: number; malformed: number }
  wordpress?: WpInfo | null
  alertSettings?: AlertSettings
  health: { up: boolean | null; status: number | null; latencyMs: number | null; problem: string | null; certDays: number | null; certIssuer: string | null; certError: string | null }
  container: ContainerView | null
  canAdmin: boolean
}

export const PROBE_WORD: Record<ProbeKind, string> = {
  secrets: 'secret files', admin: 'admin panels', php: 'PHP files', api: 'APIs this site does not have', other: 'other scanner paths',
}

export const ALERT_WORD: Record<string, string> = { down: 'Down', errors: 'Server errors', cert: 'Certificate', spike: 'Traffic spike' }
export const KIND_WORD: Record<string, string> = { static: 'Static', wordpress: 'WordPress', other: 'Other' }

export function fmtMs(ms: number | null): string {
  if (ms === null || ms === undefined) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`
}
export function fmtPct(p: number | null): string { return p === null || p === undefined ? '—' : `${p >= 10 ? p.toFixed(0) : p.toFixed(1)}%` }
export function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
