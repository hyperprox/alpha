// The Certificates page's headline: never "every certificate is healthy" before anything was checked live.
// Kept free of CSS so it can be tested in Node.

interface Entry { verdict: string; daysLeft: number | null }
interface Ov { inventory: Entry[]; probes: unknown[]; managed: Array<{ status: string }>; checkedAt: string | null; checking?: boolean }

export function certsHeadline(ov: Ov | null, ovErr: string | null): string {
  if (!ov) return ovErr ? 'Certificates unavailable' : 'Reading certificates'
  const failing = ov.inventory.filter(e => e.verdict === 'critical' || e.verdict === 'error').length
    + ov.managed.filter(m => m.status === 'failed').length
  if (failing) return `${failing} certificate${failing === 1 ? ' is' : 's are'} failing`
  const n = ov.inventory.length
  const seen = `${n} certificate${n === 1 ? '' : 's'}`
  // Nothing probed yet: the dates alone are not a health check.
  if (!ov.probes.length && !ov.checkedAt) {
    if (ov.checking) return n ? `Checking ${seen} for the first time` : 'Looking for certificates'
    return n ? `${seen} found, not checked yet` : 'No certificates found yet'
  }
  const problems = ov.inventory.filter(e => e.verdict !== 'ok').length
  if (problems) return `${problems} certificate${problems === 1 ? ' needs' : 's need'} a look`
  if (!n) return 'No certificates found yet'
  return 'Every certificate is healthy'
}

/** What the Endpoints panel says when it has no rows. */
export function endpointsEmpty(ov: Pick<Ov, 'checking' | 'checkedAt'>): string {
  if (ov.checking) return 'Checking the endpoints HyperProx found, for the first time...'
  return ov.checkedAt ? 'No endpoints to check: add a proxy host, or list one under probes: in config/certs.yaml.' : 'No endpoints checked yet. Press Check now.'
}
