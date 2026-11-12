// =============================================================================
//  HyperProx — site metrics: the paths HyperProx itself asks sites for
//
//  The catalogue's detection fingerprints and the recipes' health paths. A
//  request with a HyperProx User-Agent is HyperProx's own only when it is an
//  ordinary request or one of these; anything else (a secret file, an admin
//  panel) is a scanner borrowing the name, which anyone can read in this
//  public repository, and is counted as one.
// =============================================================================

import { CATALOGUE } from '../catalogue'
import { DETECT } from '../catalogue-detect'

let cached: Set<string> | null = null

export function ownRequestPaths(): Set<string> {
  if (cached) return cached
  const out = new Set<string>()
  const add = (p: unknown) => { if (typeof p === 'string' && p.startsWith('/')) out.add(p.split('?')[0]) }
  for (const fps of Object.values(DETECT)) for (const f of fps) add(f.path)
  for (const r of CATALOGUE) add(r.healthPath)
  cached = out
  return out
}
