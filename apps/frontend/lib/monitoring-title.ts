// The Monitoring page's headline. "All clear" is a claim about Prometheus's alerts, so it can only be made when
// Prometheus answered: an unreachable Prometheus is a critical state of its own.
export interface MonitoringReading { loading: boolean; promDown: boolean; critical: number; warning: number; firing: number }

export function monitoringTitle(r: MonitoringReading): string {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  if (r.loading) return 'Reading the metrics…'
  if (r.promDown) return r.critical ? `Prometheus is not answering · ${plural(r.critical, 'critical alert')} from other checks` : 'Prometheus is not answering'
  if (r.critical) return `${plural(r.critical, 'critical alert')} firing`
  if (r.warning) return `${plural(r.warning, 'warning')} firing`
  if (r.firing) return `${plural(r.firing, 'alert')} firing`
  return 'All clear'
}

/** The critical count the chips show: Prometheus being down counts as one. */
export const criticalCount = (alertsCritical: number, promDown: boolean) => alertsCritical + (promDown ? 1 : 0)
