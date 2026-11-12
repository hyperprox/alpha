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

/**
 * A request path that must be refused before any route sees it: on the routes that build Proxmox paths, an
 * encoded "/", "?", "#" or "\\" (the router decodes them inside one parameter, after the role checks here have seen
 * one segment), or a "." / ".." segment. Other routes keep their encoded names (a model called "a/b", say).
 */
const PVE_ROUTES = /^\/api\/(proxmox|infra|clusters)(\/|$)/
export function unsafeRequestPath(url: string): boolean {
  const raw = url.split('?')[0].split('#')[0]
  let dec = raw
  try { dec = decodeURI(raw) } catch { return true }
  // A ';' (raw or encoded) anywhere in the path is refused for every route. Fastify's router used to treat
  // '/api/secrets/reveal;x' as '/api/secrets/reveal' while the role and re-confirm checks saw the whole
  // string and missed it, so the checks and the router could disagree about which route was asked for.
  if (dec.includes(';') || /%3b/i.test(raw)) return true
  if (!PVE_ROUTES.test(dec)) return false
  if (/%(2f|3f|23|5c|2e)/i.test(raw)) return true
  return dec.split('/').some(p => p === '.' || p === '..')
}

// Reachable with no session at all. While locked these still answer.
const PUBLIC_AUTH = new Set([
  '/api/auth/status',
  '/api/auth/sign-out',
  '/api/auth/bootstrap',
  '/api/auth/bootstrap/confirm',
  '/api/auth/sign-in',
  // The setup wizard handing over what it held before the vault existed. It answers only to loopback,
  // unproxied, with the setup key (routes/auth.ts).
  '/api/auth/setup-handoff',
])

/**
 * nginx's auth_request for /grafana/ (config/nginx/conf.d/hyperprox-routes.inc). It answers for itself:
 * 204 for a signed-in person while unlocked, 401 otherwise, locked included. It needs any session (viewer),
 * and its requests do not reset the idle timer: a Grafana tab refreshing itself is not a person.
 */
export const SESSION_CHECK = '/api/auth/check'

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
// Terminal (Deck) actions that only use a saved login, never change one.
const TERMINAL_OPERATOR: Array<[string, RegExp]> = [
  ['POST',   /^\/api\/terminal\/hosts\/[^/]+\/tmux-sessions$/],
  ['PUT',    /^\/api\/terminal\/layouts$/],
  ['DELETE', /^\/api\/terminal\/layouts\/[^/]+$/],
]
// Guest destroy.
const DESTROY = /^\/api\/proxmox\/nodes\/[^/]+\/(lxc|qemu)\/[^/]+$/
// Proxy (routes/proxy.ts). Reads are viewer, as the host list always was: kinds, instances (the route
// returns only names, kind, mode and status below admin), hosts, certificates, stats, per-instance hosts, certificates and
// health. Every write is admin: instances, previews, applying a preview, certificate requests. A GET under
// /api/proxy that is not one of these is admin too, so a new read route is closed until it is listed here.
const PROXY = /^\/api\/proxy(\/|$)/
const PROXY_READ = /^\/api\/proxy\/(kinds|instances|hosts|certificates|stats|instances\/[^/]+\/(hosts|certificates|health))$/
// The Catalogue install wizard: the node table, ID and address checks, previews and applies. Admin for every
// method, reads included: it maps every node, guest and address. Apply and clean-up create or destroy a
// container, so both also need the master password re-entered.
const CATALOGUE_WIZARD = /^\/api\/catalogue\/wizard(\/|$)/
// Where each catalogue app already runs (routes/catalogue.ts /detected): it names guests and addresses, so admin.
const CATALOGUE_DETECTED = /^\/api\/catalogue\/detected$/
// Settings → Setup checklist: maps every node and runs installs on them as root. Admin for reads too.
const SETUP_CHECKLIST = /^\/api\/setup-checklist(\/|$)/
// Websites the catalogue made (routes/sites.ts): admin for reads too (they name nodes, addresses and vault items).
// The one-time WordPress admin sign-in is a login, so it also needs the master password re-entered.
const SITES = /^\/api\/sites(\/|$)/
const SITES_RECONFIRM = /^\/api\/sites\/[^/]+\/admin-login$/
// Site metrics (routes/site-metrics.ts). Reads are viewer here and trimmed by the route (totals only below
// operator); the adopt reads map containers, so they are admin. Adopting or forgetting a site and changing its
// nginx log format also need the master password re-entered.
const SITE_METRICS_ADMIN_READ = /^\/api\/site-metrics\/adopt(\/|$)/
const SITE_METRICS_RECONFIRM: Array<[string, RegExp]> = [
  ['POST',   /^\/api\/site-metrics\/adopt$/],
  ['DELETE', /^\/api\/site-metrics\/adopt\/[^/]+$/],
  ['POST',   /^\/api\/site-metrics\/sites\/[^/]+\/log-format\/apply$/],
]
const CATALOGUE_RECONFIRM = /^\/api\/catalogue\/wizard\/(apply|jobs\/[^/]+\/cleanup)$/
// Guest config editor (routes/guest-config.ts): reads are viewer like any GET, previews admin by the default
// rule, and applying a preview writes a cluster-replicated guest config, so it also needs the master password.
const GUEST_CONFIG_APPLY = /^\/api\/infra\/guest-config\/(apply|guests\/[^/]+\/[^/]+\/[^/]+\/reveal)$/
// HA management (routes/ha.ts). Reads (the HA page, a guest's panel, the migration grid, list badges) are
// viewer: they are status. Every write is admin: previews, the live rule check, and applying a preview,
// which writes cluster-wide HA configuration and so also needs the master password re-entered.
const HA = /^\/api\/ha(\/|$)/
const HA_READ = /^\/api\/ha\/(overview|badges|guests\/(lxc|qemu)\/\d+(\/preflight)?)$/
const HA_RECONFIRM = /^\/api\/ha\/(plans\/[^/]+\/apply|nodes\/[^/]+\/hostkey\/pin)$/
// Home Assistant control (routes/ha-control.ts). Everyday controls are operator; security controls (locks, alarms,
// garage doors, protected devices) and every change to an instance are admin and re-confirmed, which keeps API
// tokens off them too.
const HA_CONTROL_ACT = /^\/api\/plugins\/home-assistant\/instances\/[^/]+\/actions$/
const HA_CONTROL_RECONFIRM = /^\/api\/plugins\/home-assistant\/instances(\/(?!probe-certificate$)[^/]+(\/secure-actions)?)?$/
// QNAP (routes/qnap.ts). A quick SMART test is operator; restart, shut down and every change to a NAS (it stores a
// login) are admin and re-confirmed, which keeps API tokens off them too.
const QNAP_ACT = /^\/api\/plugins\/qnap\/instances\/[^/]+\/actions$/
const QNAP_RECONFIRM = /^\/api\/plugins\/qnap\/instances(\/(?!probe-certificate$)[^/]+(\/secure-actions)?)?$/
// Proxmox Backup Server (routes/pbs.ts). Every write is admin (the default for a POST/PUT/DELETE) and re-confirmed:
// adding, changing or removing a server stores a token, and "verify now" and "GC now" start work on the server.
const PBS_RECONFIRM = /^\/api\/plugins\/pbs\/instances(\/[^/]+(\/actions\/(verify|gc))?)?$/
// A plug-in's settings hold the address its stored credential is sent to: changing them is re-confirmed (which
// also keeps API tokens out).
const PLUGIN_SETTINGS = /^\/api\/plugins\/[^/]+\/settings$/
// Settings → connections (routes/settings.ts): saving a provider's login or address, and testing one (which sends
// the stored secret to the stored address). Re-confirmed, which also keeps API tokens out. Notification channels
// live under /api/settings/notifications and keep their own rules.
const SETTINGS_SAVE = /^\/api\/settings\/(?!(notifications|test)\/)[^/]+\/[^/]+$/
const SETTINGS_TEST = /^\/api\/settings\/test\/[^/]+\/[^/]+$/
// Role management (no routes yet; reserved so they are owner-only from day one).
const ROLE_MGMT = /^\/api\/(auth\/)?roles(\/|$)/
// Remote access: what opens a tunnel into the cluster, routes through a machine, removes a device or shows
// a key. Re-confirmed, which also keeps API tokens out (a token cannot re-confirm). Check and update are not,
// except on a node.
const REMOTE_RECONFIRM: Array<[string, RegExp]> = [
  ['POST',   /^\/api\/remote\/jobs$/],
  ['POST',   /^\/api\/remote\/machines\/[^/]+\/(tailscale|netbird)\/(routing|manual-key)$/],
  ['DELETE', /^\/api\/remote\/machines\/[^/]+\/(tailscale|netbird)$/],
  ['POST',   /^\/api\/remote\/machines\/[^/]+\/tun$/],
  ['POST',   /^\/api\/remote\/machines\/[^/]+\/(tailscale|netbird)\/firewall$/],
  ['POST',   /^\/api\/remote\/machines\/[^/]+\/host-key$/],
  // VPN page and the /v1 API other pages use.
  ['POST',   /^\/api\/remote\/v1\/machines\/[^/]+\/(tailscale|netbird)\/(install|settings)$/],
  ['DELETE', /^\/api\/remote\/v1\/machines\/[^/]+\/(tailscale|netbird)$/],
  ['POST',   /^\/api\/remote\/machines\/[^/]+\/(tailscale|netbird)\/(key-expiry|tags|login-url)$/],
  ['POST',   /^\/api\/remote\/devices\/(tailscale|netbird)\/[^/]+\/approve$/],
  ['DELETE', /^\/api\/remote\/devices\/(tailscale|netbird)\/[^/]+$/],
  // On a Proxmox node even a check or an update is re-confirmed: it runs a script on the hypervisor.
  ['POST',   /^\/api\/remote\/machines\/node-[^/]+\/(tailscale|netbird)\/(check|update)$/],
  // Which guests HyperProx must never look inside.
  ['PUT',    /^\/api\/remote\/exclusions$/],
]
// WireGuard (/api/vpn): admin for every call, reads included; every change, reveal or rotation re-confirmed.
// Previews (POST .../preview) only read, so they are not.
const VPN = /^\/api\/vpn(\/|$)/
const VPN_PREVIEW = /^\/api\/vpn\/wg\/router\/peers\/preview$/
// Remote access job output names hosts, packages and addresses: admins only, like Updates.
const REMOTE_JOBS = /^\/api\/remote\/(exclusions$|(v1\/)?jobs(\/|$)|machines\/[^/]+\/((tailscale|netbird)\/firewall|host-key)$|v1\/machines\/[^/]+\/(tailscale|netbird)\/(install-preview|settings)$)/

// Clusters (routes/clusters.ts): the list, the Command center and task status are viewer; guest power is operator,
// as it is on the home pages; everything else is admin, reads included (scans and node lists map machines).
// Storing or replacing a credential (a sending key and a Plex token included), confirming or verifying a certificate
// or host key, deleting and installing also need the master password re-entered. Starting a copy does not: HyperProx's
// copy only adds files (it never replaces or deletes one that was there).
const CLUSTERS = /^\/api\/clusters(\/|$)/
const CLUSTERS_VIEW = /^\/api\/clusters(\/overview|\/[^/]+\/tasks(\/[^/]+\/[^/]+)?|\/files\/jobs(\/[^/]+)?)?$/
const CLUSTERS_POWER = /^\/api\/clusters\/[^/]+\/guests\/[^/]+\/(lxc|qemu)\/\d+\/power$/
const CLUSTERS_RECONFIRM: Array<[string, RegExp]> = [
  ['POST',   /^\/api\/clusters$/],
  ['DELETE', /^\/api\/clusters\/[^/]+$/],
  ['POST',   /^\/api\/clusters\/[^/]+\/(certificate|token|connection)$/],
  ['POST',   /^\/api\/clusters\/[^/]+\/nodes\/[^/]+\/login$/],
  // Verifying host keys changes pins (and may save a node login): a person with the master password only.
  ['POST',   /^\/api\/clusters\/[^/]+\/verify-keys$/],
  ['DELETE', /^\/api\/clusters\/[^/]+\/nodes\/[^/]+\/login$/],
  ['POST',   /^\/api\/clusters\/[^/]+\/guests\/[^/]+\/(lxc|qemu)\/\d+\/delete$/],
  ['POST',   /^\/api\/clusters\/[^/]+\/monitoring\/apply$/],
  ['POST',   /^\/api\/clusters\/files\/keys$/],
  ['POST',   /^\/api\/clusters\/[^/]+\/plex$/],
  // Send files, simple flow: first-time setup sets allowed folders and makes sending keys in one step.
  ['POST',   /^\/api\/clusters\/[^/]+\/send\/setup$/],
]

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
  if (p === SESSION_CHECK) return 'viewer'
  if (p === '/api/auth/lock') return 'admin'
  // API tokens: listing them is admin too (names, roles, who made them).
  if (TOKENS.test(p)) return 'admin'
  if (PROXY.test(p)) return (m === 'GET' || m === 'HEAD') && PROXY_READ.test(p) ? 'viewer' : 'admin'
  if (CATALOGUE_WIZARD.test(p)) return 'admin'
  if (CATALOGUE_DETECTED.test(p)) return 'admin'
  if (SITES.test(p)) return 'admin'
  if (SITE_METRICS_ADMIN_READ.test(p)) return 'admin'
  if (SETUP_CHECKLIST.test(p)) return 'admin'
  if (HA.test(p)) return (m === 'GET' || m === 'HEAD') && HA_READ.test(p) ? 'viewer' : 'admin'
  if (CLUSTERS.test(p)) {
    if (m === 'GET' || m === 'HEAD') return CLUSTERS_VIEW.test(p) ? 'viewer' : 'admin'
    if (m === 'POST' && CLUSTERS_POWER.test(p)) return 'operator'
    return 'admin'
  }

  if (m === 'GET' || m === 'HEAD') {
    // Interactive shells on guests and nodes.
    if (p === '/ws/terminal' || p.startsWith('/ws/terminal/')) return 'operator'
    // Plug-in probes that reach out on the network (a discovery scan of every guest, a downloader's stuck-import
    // scan): admin, though they are reads.
    if (p === '/api/plugins/discover' || /^\/api\/plugins\/[^/]+\/stuck$/.test(p)) return 'admin'
    // A guest's whole Proxmox config (routes/infrastructure.ts; masked, but it still maps disks, networks and mounts).
    if (/^\/api\/infra\/vms\/[^/]+\/[^/]+\/[^/]+\/config$/.test(p)) return 'admin'
    // The vault's item list: every secret's name and field names, the person's own included. Admin, like the rest of /api/secrets.
    if (p === '/api/secrets' || p.startsWith('/api/secrets/')) return 'admin'
    // Provider settings echo stored values (some unmasked, e.g. API key ids).
    if (p === '/api/settings' || p.startsWith('/api/settings/')) return 'admin'
    // Certificates: the inventory maps every endpoint, and the history names keys and targets.
    if (p === '/api/certs' || p.startsWith('/api/certs/')) return 'admin'
    if (REMOTE_JOBS.test(p)) return 'admin'
    if (VPN.test(p)) return 'admin'
    return 'viewer'
  }

  if (m === 'POST' && POWER.test(p)) return 'operator'
  if (m === 'POST' && HA_CONTROL_ACT.test(p)) return 'operator'
  if (m === 'POST' && QNAP_ACT.test(p)) return 'operator'
  for (const [tm, re] of TERMINAL_OPERATOR) if (m === tm && re.test(p)) return 'operator'

  return 'admin'
}

/** Requests that need the master password re-entered within the last 5 minutes. */
export function needsReconfirm(method: string, path: string): boolean {
  const m = method.toUpperCase()
  const p = normalisePath(path)
  if (m === 'DELETE' && DESTROY.test(p)) return true
  if (m === 'POST' && p === '/api/secrets/reveal') return true
  // A Send hands the value out too (as an expiring link), so it is re-confirmed like reveal.
  if (m === 'POST' && p === '/api/secrets/send') return true
  // Setup checklist changes: storing a node login, and anything that runs as root on your nodes or shreds files.
  if (m !== 'GET' && m !== 'HEAD' && SETUP_CHECKLIST.test(p)) return true
  // A new Grafana admin password goes straight into the vault, but it is still a credential being replaced.
  if (m === 'POST' && p === '/api/monitoring/grafana-admin/reset') return true
  if (m !== 'GET' && m !== 'HEAD' && ROLE_MGMT.test(p)) return true
  if (m === 'POST' && CATALOGUE_RECONFIRM.test(p)) return true
  if (m === 'POST' && SITES_RECONFIRM.test(p)) return true
  for (const [sm, re] of SITE_METRICS_RECONFIRM) if (m === sm && re.test(p)) return true
  if (m === 'POST' && GUEST_CONFIG_APPLY.test(p)) return true
  if (m === 'POST' && HA_RECONFIRM.test(p)) return true
  if (m !== 'GET' && m !== 'HEAD' && HA_CONTROL_RECONFIRM.test(p)) return true
  if (m !== 'GET' && m !== 'HEAD' && QNAP_RECONFIRM.test(p)) return true
  if (m !== 'GET' && m !== 'HEAD' && PBS_RECONFIRM.test(p)) return true
  if (m === 'PUT' && PLUGIN_SETTINGS.test(p)) return true
  if (m === 'PUT' && SETTINGS_SAVE.test(p)) return true
  if (m === 'POST' && SETTINGS_TEST.test(p)) return true
  // Creating or revoking an API token.
  if ((m === 'POST' || m === 'DELETE') && TOKENS.test(p)) return true
  for (const [rm, re] of REMOTE_RECONFIRM) if (m === rm && re.test(p)) return true
  if (m !== 'GET' && m !== 'HEAD' && VPN.test(p) && !VPN_PREVIEW.test(p)) return true
  for (const [cm, re] of CLUSTERS_RECONFIRM) if (m === cm && re.test(p)) return true
  return false
}
