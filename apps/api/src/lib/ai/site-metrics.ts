// =============================================================================
//  HyperProx — site metrics, as the assistant reads them
//
//  One small interface: a site's visitors, page views, error rate, p95 response
//  time, top pages and referrers, and uptime, for today, this week or this
//  month. The assistant answers "how many visitors did <site> get today" from
//  these figures alone, with no model call.
//
//  routes/ai.ts adapts lib/site-metrics onto SiteMetrics below; tests drive it
//  through a fake (test/ai-home-features.test.ts).
// =============================================================================

export type MetricsRange = 'today' | 'week' | 'month'
export const METRICS_RANGES: MetricsRange[] = ['today', 'week', 'month']

export interface SiteMetrics {
  range:       MetricsRange
  visitors:    number
  pageViews:   number
  /** Share of requests answered with a 5xx, 0 to 1. */
  errorRate:   number | null
  /** 95th percentile response time, milliseconds. */
  p95Ms:       number | null
  /** Paths only, never a query string. */
  topPages:    Array<{ path: string; views: number }>
  /** Referring hosts. */
  topReferrers: Array<{ source: string; visits: number }>
  /** Share of checks the public address answered, 0 to 100. */
  uptimePct:   number | null
}

export interface SiteMetricsSource {
  /** False while nothing collects site metrics: every answer then says so instead of reading as zero. */
  available(): boolean
  /** One site's figures for a range, or null when there are none for it. */
  siteMetrics(siteId: string, range: MetricsRange): Promise<SiteMetrics | null>
}

/** The adapter until the site-metrics module is on main: nothing is collected, and the assistant says so. */
export const NOT_COLLECTED: SiteMetricsSource = {
  available: () => false,
  siteMetrics: async () => null,
}
