// =============================================================================
//  HyperProx — which managed DNS zone a hostname belongs to
//
//  The longest zone the hostname is in or under, never "the last two labels":
//  a.b.example.co.uk is in example.co.uk, and evil-example.com is in nothing
//  that example.com covers.
// =============================================================================

const norm = (s: string) => String(s ?? '').trim().toLowerCase().replace(/\.$/, '')

/** The managed zone `domain` belongs to and its record name there ('@' at the apex), or null. */
export function zoneFor(domain: string, zones: string[]): { zone: string; name: string } | null {
  const d = norm(domain)
  if (!d) return null
  const zone = zones.map(norm).filter(z => z && (d === z || d.endsWith('.' + z)))
    .sort((a, b) => b.length - a.length)[0]
  if (!zone) return null
  return { zone, name: d === zone ? '@' : d.slice(0, d.length - zone.length - 1) }
}
