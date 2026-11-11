// The Websites section's Metrics tab: totals across every site's summary (kept apart from the page so tests can read it).

import type { SiteSummary } from './types'

/** The totals the overview shows, kept apart from the page so they can be read (and tested) on their own. */
export function overviewTotals(sites: SiteSummary[], certWarnDays = 14) {
  const errs = sites.map(x => x.errorRatePct).filter((v): v is number => v !== null)
  return {
    visitorsToday: sites.reduce((n, x) => n + x.visitorsToday, 0),
    pageViewsToday: sites.reduce((n, x) => n + x.pageViewsToday, 0),
    up: sites.filter(x => x.up === true).length,
    down: sites.filter(x => x.up === false).length,
    unchecked: sites.filter(x => x.up === null).length,
    worstErrorPct: errs.length ? Math.max(...errs) : null,
    certsSoon: sites.filter(x => x.certDays !== null && x.certDays < certWarnDays).length,
    alerts: sites.reduce((n, x) => n + x.alerts.length, 0),
  }
}

