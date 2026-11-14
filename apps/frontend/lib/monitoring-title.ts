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

/** Ceph health as Proxmox reports it (/cluster/ceph/status). */
export interface CephReading { health?: { status?: string; checks?: Record<string, { severity?: string; summary?: { message?: string } } | unknown> } }
export interface CephAlert { name: string; severity: 'critical' | 'warning'; state: 'firing'; node: string; summary: string; description: string; firedAt: string }

/** Checks a cluster carries on purpose (a size=1 pool), as the dashboard treats them: shown, never counted. */
export const INTENTIONAL_CEPH = new Set(['POOL_NO_REDUNDANCY'])

/**
 * Ceph's health checks as Monitoring alerts, so Monitoring and the dashboard agree: the dashboard listed Ceph
 * warnings while Monitoring said "All clear, 0 warnings" (its Prometheus rule waits five minutes, and the
 * checks are the detail). Cluster-wide: no node. HEALTH_ERR checks are critical.
 */
export function cephAlerts(c: CephReading | null | undefined): CephAlert[] {
  const status = c?.health?.status
  if (!status || status === 'HEALTH_OK') return []
  return Object.entries(c?.health?.checks ?? {}).filter(([k]) => !INTENTIONAL_CEPH.has(k)).map(([k, v]) => {
    const chk = (v ?? {}) as { severity?: string; summary?: { message?: string } }
    return { name: `Ceph: ${k}`, severity: chk.severity === 'HEALTH_ERR' ? 'critical' : 'warning', state: 'firing', node: '',
      summary: `Ceph: ${k}`, description: chk.summary?.message ?? '', firedAt: '' }
  })
}

/** Prometheus's alerts plus Ceph's checks; with the checks shown, its whole-cluster Ceph alert would count twice. */
export function withCephAlerts<A extends { name: string }>(alerts: A[], ceph: CephAlert[]): Array<A | CephAlert> {
  if (!ceph.length) return alerts
  return [...alerts.filter(a => !/^CephHealth(Warning|Error)$/.test(a.name)), ...ceph]
}
