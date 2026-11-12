// =============================================================================
//  HyperProx — the Ghost card: version, published posts and members
//
//  Read-only, with the "HyperProx" integration's Admin API key that setup made
//  and kept in the vault. Three GETs to the site's own address (its nginx, on
//  the LAN), each with a five-minute token; nothing is written. The key and the
//  token are never logged or returned, and any message is scrubbed of both.
// =============================================================================

import { adminToken, redact } from './setup'

export interface GhostStats { version: string | null; posts: number | null; members: number | null; checkedAt: number }

export interface GhostStatsDeps {
  readSecrets(category: string, provider: string): Promise<Record<string, string>>
  /** GET a URL with these headers: its status and body, or null when nothing answered. Redirects are not followed. */
  get(url: string, headers: Record<string, string>): Promise<{ status: number; body: string } | null>
  now(): number
}

export const GHOST_STATS_TTL_MS = 5 * 60_000
const CACHE = new Map<string, GhostStats>()
export const clearGhostStatsCache = () => CACHE.clear()

const json = (s: string): any => { try { return JSON.parse(s) } catch { return null } }
const total = (a: { status: number; body: string } | null): number | null => {
  const n = a && a.status === 200 ? json(a.body)?.meta?.pagination?.total : null
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

/** The card's numbers for a Ghost site HyperProx made. Throws a plain message when they cannot be read. */
export async function ghostStats(site: { id: string; recipeId: string; localUrl?: string; vault?: { category: string; provider: string } }, d: GhostStatsDeps, fresh = false): Promise<GhostStats> {
  if (site.recipeId !== 'ghost') throw new Error('Only a Ghost site HyperProx made has an Admin API key for this card.')
  if (!site.vault || !site.localUrl) throw new Error('This site has no vault item or address on record.')
  const cached = CACHE.get(site.id)
  if (cached && !fresh && d.now() - cached.checkedAt < GHOST_STATS_TTL_MS) return cached
  let key: string | undefined
  try { key = (await d.readSecrets(site.vault.category, site.vault.provider)).admin_api_key }
  catch { throw new Error('The vault is locked. Sign in to unlock it.') }
  if (!key) throw new Error('No Admin API key is in this site\'s vault item.')
  const base = site.localUrl.replace(/\/+$/, '')
  let token = ''
  try {
    token = adminToken(key, d.now())
    const auth = { Authorization: `Ghost ${token}`, Accept: 'application/json' }
    const [siteInfo, posts, members] = await Promise.all([
      d.get(`${base}/ghost/api/admin/site/`, { Accept: 'application/json' }),
      d.get(`${base}/ghost/api/admin/posts/?limit=1&fields=id&filter=status:published`, auth),
      d.get(`${base}/ghost/api/admin/members/?limit=1&fields=id`, auth),
    ])
    if (!siteInfo && !posts && !members) throw new Error(`${base} did not answer.`)
    if (posts?.status === 401 || posts?.status === 403) throw new Error(`Ghost refused the Admin API key (${posts.status}). It may have been deleted in Ghost's Integrations.`)
    const v = siteInfo?.status === 200 ? json(siteInfo.body)?.site?.version : null
    const out: GhostStats = { version: typeof v === 'string' && /^[0-9][0-9A-Za-z.+-]{0,30}$/.test(v) ? v : null, posts: total(posts), members: total(members), checkedAt: d.now() }
    CACHE.set(site.id, out)
    return out
  } catch (e: any) {
    throw new Error(redact(String(e?.message ?? e), [key, key.split(':')[1], token]))
  }
}
