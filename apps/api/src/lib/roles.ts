// =============================================================================
//  HyperProx — Role matrix
//  Pure functions: given a request's method and path, which role does it need,
//  and does it need a fresh master-password re-confirmation?
//
//  viewer   any GET + the live-status WebSocket
//  operator viewer + guest start/stop/shutdown/reboot + terminal and console
//  admin    everything except role management (API tokens included)
//  owner    everything
//
//  Anything not listed falls to the safe side: a GET is viewer, everything
//  else is admin. A new route is therefore admin-only until someone decides
//  otherwise here.
// =============================================================================

import type { Role } from './vault/broker'

export type { Role }

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 }

/** True when `actual` is at least `required`. */
export function hasRole(actual: Role, required: Role): boolean {
  return (RANK[actual] ?? -1) >= RANK[required]
}

/**
 * Strip the query string and any trailing slash (except on "/"), and decode the
 * path the way the router does before it matches a route (decodeURI: %2F and the
 * other reserved characters stay encoded). Without the decode, /api/secrets/%72eveal
 * reached the reveal handler while every check here saw a path it did not know.
 */
export function normalisePath(url: string): string {
  let p = url.split('?')[0].split('#')[0]
  try { p = decodeURI(p) } catch { /* malformed: the router refuses it too */ }
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p
}

// Reachable with no session at all. While locked these still answer.
const PUBLIC_AUTH = new Set([
  '/api/auth/status',
  '/api/auth/sign-out',
  '/api/auth/bootstrap',
  '/api/auth/bootstrap/confirm',
  '/api/auth/sign-in',
])

// API token management lives under /api/auth but is an ordinary admin route: locked is 423.
const TOKENS = /^\/api\/auth\/tokens(\/|$)/

/** /health* and /api/auth/* (except token management) answer while locked; everything else gets 423. */
export function bypassesLock(path: string): boolean {
  if (TOKENS.test(path)) return false
  return path === '/health' || path.startsWith('/health/') || path === '/api/auth' || path.startsWith('/api/auth/')
}

// Guest power actions. Both route families exist: /api/infra (infrastructure.ts)
// and /api/proxmox (proxmox.ts).
const POWER = /^\/api\/(infra|proxmox)\/vms\/[^/]+\/[^/]+\/[^/]+\/(start|stop|shutdown|reboot)$/
// Console ticket for the browser VNC/xterm.js console.
const CONSOLE = /^\/api\/infra\/vms\/[^/]+\/[^/]+\/[^/]+\/vnc$/
// Terminal (Deck) actions that only use a saved login, never change one.
const TERMINAL_OPERATOR: Array<[string, RegExp]> = [
  ['POST',   /^\/api\/terminal\/hosts\/[^/]+\/tmux-sessions$/],
  ['PUT',    /^\/api\/terminal\/layouts$/],
  ['DELETE', /^\/api\/terminal\/layouts\/[^/]+$/],
]
// Guest destroy.
const DESTROY = /^\/api\/proxmox\/nodes\/[^/]+\/(lxc|qemu)\/[^/]+$/
// Role management (no routes yet; reserved so they are owner-only from day one).
const ROLE_MGMT = /^\/api\/(auth\/)?roles(\/|$)/

/**
 * The role a request needs, or null when it needs no session.
 * `method` is the HTTP method; `path` the URL path (query string is ignored).
 */
export function requiredRole(method: string, path: string): Role | null {
  const m = method.toUpperCase()
  const p = normalisePath(path)

  if (p === '/health' || p.startsWith('/health/')) return null
  if (PUBLIC_AUTH.has(p)) return null
  // Authenticates itself with METRICS_TOKEN (a scraper has no session).
  if (p === '/api/plugins/metrics' && (m === 'GET' || m === 'HEAD')) return null

  if (ROLE_MGMT.test(p)) return 'owner'

  // Sign-out only clears the caller's own cookie, so it must work with a stale one.
  if (p === '/api/auth/sign-out') return null
  if (p === '/api/auth/reconfirm') return 'viewer'
  if (p === '/api/auth/lock') return 'admin'
  // API tokens: listing them is admin too (names, roles, who made them).
  if (TOKENS.test(p)) return 'admin'

  if (m === 'GET' || m === 'HEAD') {
    // Interactive shells on guests and nodes.
    if (p === '/ws/terminal' || p.startsWith('/ws/terminal/')) return 'operator'
    // Provider settings echo stored values (some unmasked, e.g. API key ids).
    if (p === '/api/settings' || p.startsWith('/api/settings/')) return 'admin'
    // Certificates: the inventory maps every endpoint, and the history names keys and targets.
    if (p === '/api/certs' || p.startsWith('/api/certs/')) return 'admin'
    return 'viewer'
  }

  if (m === 'POST' && (POWER.test(p) || CONSOLE.test(p))) return 'operator'
  for (const [tm, re] of TERMINAL_OPERATOR) if (m === tm && re.test(p)) return 'operator'

  return 'admin'
}

/** Requests that need the master password re-entered within the last 5 minutes. */
export function needsReconfirm(method: string, path: string): boolean {
  const m = method.toUpperCase()
  const p = normalisePath(path)
  if (m === 'DELETE' && DESTROY.test(p)) return true
  if (m === 'POST' && p === '/api/secrets/reveal') return true
  if (m !== 'GET' && m !== 'HEAD' && ROLE_MGMT.test(p)) return true
  // Creating or revoking an API token.
  if ((m === 'POST' || m === 'DELETE') && TOKENS.test(p)) return true
  return false
}
