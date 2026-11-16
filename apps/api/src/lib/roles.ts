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
  // ── Joining from an invitation link (routes/users.ts buildJoinRoutes). The link's token is the credential,
  // it fixes the email, and the account still needs an admin's confirmation before it can read anything. ──
  '/api/auth/join/check',
  '/api/auth/join/register',
  '/api/auth/join/totp',
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
  return path === '/health' || path.startsWith('/health/') || path === '/api/health' || path === '/api/auth' || path.startsWith('/api/auth/')
}

// Arr Stack queue actions (routes/arr-queue.ts POST /queue/actions): removing, blocklisting, searching, retrying
// an import and moving a torrent to the top of qBittorrent's queue. Admin for every action (the default for a POST),
// previews and the follow-up check included. No master password (nothing permanent is lost: library files are never
// touched), and refused to API tokens by name (lib/api-tokens.ts tokenForbidden).
// Arr Stack give-up (routes/arr-giveup.ts): the rules and the given-up list are a read (viewer). Every POST is admin
// (the default): previews, saving a rule, try again, "See what's available" (it makes the arr search its indexers) and
// downloading a release. Refused to API tokens by name too. No master password: no file is ever deleted.

// Guest power actions. Both route families exist: /api/infra (infrastructure.ts)
// and /api/proxmox (proxmox.ts).
const POWER = /^\/api\/(infra|proxmox)\/vms\/[^/]+\/[^/]+\/[^/]+\/(start|stop|shutdown|reboot)$/
// Terminal (Deck) actions that only use a saved login, never change one.
const TERMINAL_OPERATOR: Array<[string, RegExp]> = [
  ['POST',   /^\/api\/terminal\/hosts\/[^/]+\/tmux-sessions$/],
  // A changed host key: the check, and trusting a key Proxmox verified (anything else needs admin, checked in the route).
  ['POST',   /^\/api\/terminal\/hosts\/[^/]+\/hostkey\/(verify|trust)$/],
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
// Deleting a site removes DNS, proxy hosts and possibly its container: re-confirmed too (the preview is not).
const SITES_RECONFIRM = /^\/api\/sites\/[^/]+\/(admin-login|delete)$/
// Site metrics (routes/site-metrics.ts). Reads are viewer here and trimmed by the route (totals only below
// operator); the adopt reads map containers, so they are admin. Adopting or forgetting a site and changing its
// nginx log format also need the master password re-entered.
const SITE_METRICS_ADMIN_READ = /^\/api\/site-metrics\/adopt(\/|$)/
const SITE_METRICS_RECONFIRM: Array<[string, RegExp]> = [
  ['POST',   /^\/api\/site-metrics\/adopt$/],
  ['DELETE', /^\/api\/site-metrics\/adopt\/[^/]+$/],
  ['POST',   /^\/api\/site-metrics\/sites\/[^/]+\/log-format\/apply$/],
]
const CATALOGUE_RECONFIRM = /^\/api\/catalogue\/wizard\/(apply|jobs\/[^/]+\/(cleanup|finish-seerr))$/
// Guest config editor (routes/guest-config.ts): reads are viewer like any GET, previews admin by the default
// rule, and applying a preview writes a cluster-replicated guest config, so it also needs the master password.
const GUEST_CONFIG_APPLY = /^\/api\/infra\/guest-config\/(apply|guests\/[^/]+\/[^/]+\/[^/]+\/reveal)$/
// HA management (routes/ha.ts). Reads (the HA page, a guest's panel, the migration grid, list badges) are
// viewer: they are status. Every write is admin: previews, the live rule check, and applying a preview,
// which writes cluster-wide HA configuration and so also needs the master password re-entered.
const HA = /^\/api\/ha(\/|$)/
const HA_READ = /^\/api\/ha\/(overview|badges|guests\/(lxc|qemu)\/\d+(\/preflight)?)$/
const HA_RECONFIRM = /^\/api\/ha\/(plans\/[^/]+\/apply|nodes\/[^/]+\/hostkey\/pin)$/
// Load balancing (routes/placement.ts, the /balance page). Reads (the balance, the map, the advice, one guest, the
// history, the plans, the settings, automatic balancing's settings) are viewer, as the guest list is. Everything else
// is admin: the move check, saving settings, checking bind-mount paths and reading corosync's log (both over node
// logins), cancelling a scheduled move, resolving a stuck one, stopping a plan, the emergency stop. A move (now or
// scheduled), running or scheduling a balancing plan, saving the settings (they decide when approved moves run) and
// saving automatic balancing (it can turn on applying automatically) also need the master password re-entered, which
// keeps API tokens out too (lib/api-tokens.ts refuses them those routes outright as well).
const PLACEMENT = /^\/api\/placement(\/|$)/
const PLACEMENT_READ = /^\/api\/placement\/(balance|map|advice|settings|auto|plans(\/[^/]+)?|moves(\/[^/]+)?|guests\/(lxc|qemu)\/\d+)$/
const PLACEMENT_RECONFIRM = /^\/api\/placement\/guests\/(lxc|qemu)\/\d+\/move$/
const PLACEMENT_PLAN_RUN = '/api/placement/plans'
const PLACEMENT_AUTO = '/api/placement/auto'
// Home Assistant control (routes/ha-control.ts). Everyday controls are operator; security controls (locks, alarms,
// garage doors, protected devices) and every change to an instance are admin and re-confirmed, which keeps API
// tokens off them too.
const HA_CONTROL_ACT = /^\/api\/plugins\/home-assistant\/instances\/[^/]+\/actions$/
const HA_CONTROL_RECONFIRM = /^\/api\/plugins\/home-assistant\/instances(\/(?!probe-certificate$)[^/]+(\/secure-actions)?)?$/
// QNAP (routes/qnap.ts). A quick SMART test is operator; restart, shut down and every change to a NAS (it stores a
// login) are admin and re-confirmed, which keeps API tokens off them too.
const QNAP_ACT = /^\/api\/plugins\/qnap\/instances\/[^/]+\/actions$/
const QNAP_RECONFIRM = /^\/api\/plugins\/qnap\/instances(\/(?!probe-certificate$)[^/]+(\/secure-actions)?)?$/
// DNS blockers, Pi-hole and AdGuard Home (lib/dns-blocker/routes.ts). Pausing blocking, turning it back on and updating the
// lists are operator; restarting, allowing a domain, switching the upstream servers, the guest DNS setting and every change
// to a blocker (it stores a login) are admin and re-confirmed, which keeps API tokens off them too.
const DNS_ACT = /^\/api\/plugins\/(pihole|adguard)\/instances\/[^/]+\/actions$/
// The guests a blocker could be tied to (routes: GET .../guests) map the cluster: admin, though a read.
const DNS_ADMIN_READ = /^\/api\/plugins\/(pihole|adguard)\/guests$/
const DNS_RECONFIRM = /^\/api\/plugins\/(pihole|adguard)\/instances(\/[^/]+(\/secure-actions)?)?$/
// ASUS routers (routes/asus.ts). Reads are viewer (trimmed by the route below operator). Every write is admin, the
// default for a POST/PUT/DELETE: finding a router on the LAN, every change to a router (it stores an admin login)
// and rebooting one. All but the search and the certificate read are also re-confirmed, which keeps API tokens off
// them too.
// The diagnostics read (raw, redacted router answers): admin even though it is a GET, not re-confirmed, so an admin's
// API token may call it. It only reads.
const ASUS_DIAGNOSTICS = /^\/api\/plugins\/asus\/instances\/[^/]+\/diagnostics$/
const ASUS_RECONFIRM = /^\/api\/plugins\/asus\/instances(\/(?!probe-certificate$)[^/]+(\/actions)?)?$/
// Plex clear-out and Library (routes/plex-clearout.ts). The lists are a read (viewer). Previewing a removal is
// operator; removing (through Sonarr, Radarr or Plex itself) deletes files, so it is operator with the master password re-entered, which keeps API
// tokens out too.
const PLEX_CLEAROUT_ACT = /^\/api\/plugins\/plex\/(clearout|library)\/(preview|remove)$/
const PLEX_CLEAROUT_RECONFIRM = /^\/api\/plugins\/plex\/(clearout|library)\/remove$/
// Sign in with Plex (routes/plex-signin.ts): admin for every method, reads included (the status names the account's
// servers and their addresses). Starting one and saving the chosen server save plug-in settings, so both are
// re-confirmed like a settings save, which also keeps API tokens out.
const PLEX_SIGNIN = /^\/api\/plugins\/plex\/signin(\/|$)/
const PLEX_SIGNIN_RECONFIRM = /^\/api\/plugins\/plex\/signin(\/[^/]+\/connect)?$/
// Proxmox Backup Server (routes/pbs.ts). Every write is admin (the default for a POST/PUT/DELETE) and re-confirmed:
// adding, changing or removing a server stores a token, and "verify now" starts work on the server.
const PBS_RECONFIRM = /^\/api\/plugins\/pbs\/instances(\/(?!probe-certificate$)[^/]+(\/(actions\/verify|forget))?)?$/
// Backup management (opt-in, lib/pbs/manage.ts): turning it on or off, previews, applies and clean-up. All admin and
// re-confirmed, which keeps API tokens out; the snapshot list of one group is a read (viewer).
const PBS_MANAGE_RECONFIRM = /^\/api\/plugins\/pbs\/instances\/[^/]+\/manage(\/(preview|apply|gc))?$/
// Nextcloud (routes/nextcloud.ts). The instance list and a reading are viewer (trimmed by the route below admin). The
// guest list, the 2FA user list and a job's progress are admin, though reads (they name guests, users and paths). Every
// write is admin, the default for a POST/PUT/DELETE: detection and the update check only read, a snooze changes only
// HyperProx's own list, and the plain actions (lib/nextcloud/checks.ts ACTIONS) each set one setting. Adding, changing or
// removing an instance stores a login, and the secure actions (the update, the Talk signalling update, long database
// work, enforcing 2FA, mail) change much more: those are re-confirmed, which keeps API tokens out too, as is
// "stop watching" a job (it lets a deploy restart HyperProx under work that may still be running).
const NEXTCLOUD_ADMIN_READ = /^\/api\/plugins\/nextcloud\/(candidates|instances\/[^/]+\/(two-factor|jobs\/[^/]+))$/
const NEXTCLOUD_RECONFIRM = /^\/api\/plugins\/nextcloud\/instances(\/[^/]+(\/secure-actions\/[^/]+|\/jobs\/[^/]+\/stop-watching)?)?$/
// Homepage (routes/homepage.ts): admin for every method, reads included (the preview maps every LAN address); its
// gallery card (/api/plugins/homepage/data, the generic plug-in route) stays a viewer read. Turning
// widgets on, writing their keys to the guest, wiring Homepage's key file into its compose file, deleting old key-file
// backups, and making or revoking the Proxmox token are also re-confirmed.
const HOMEPAGE = /^\/api\/plugins\/homepage\/(installs|instances)(\/|$)/
// HAProxy (routes/haproxy.ts): admin for every method, reads included (a reading maps backend addresses, the guest
// picker maps the cluster); its gallery card (/api/plugins/haproxy/data, the generic plug-in route) stays a viewer
// read. Actions are confirmed on the page and audited by the service; none stores or shows a credential.
const HAPROXY = /^\/api\/plugins\/haproxy\/(instances|guests|publish-jobs)(\/|$)/
// Auto-connect (routes/auto-connect.ts): admin for every method, reads included (it names guests, addresses and vault
// item names). A pick or "connect again" is the same read-only connect the background pass makes, so it is not
// re-confirmed; every write and fix those plug-ins have keeps its own rule above.
const AUTO_CONNECT = /^\/api\/auto-connect(\/|$)/
// Removed guests (routes/removed-guests.ts): admin for every method, reads included (it names guests, addresses and
// backup jobs). Clean up is re-confirmed: it deletes vault items and changes the cluster's backup jobs and HA list.
const REMOVED_GUESTS = /^\/api\/removed-guests(\/|$)/
const REMOVED_GUESTS_CLEAN = /^\/api\/removed-guests\/\d{1,9}\/clean-up$/
const HOMEPAGE_RECONFIRM = /^\/api\/plugins\/homepage\/instances\/[^/]+\/(widgets|secrets|proxmox-token|wire-env|purge-key-backups)$/
// 3proxy (routes/fwdproxy.ts): admin for every method, reads included (a reading names users and, unless turned off,
// client addresses). The generic plug-in detail (routes/plugins.ts /:id/detail) is admin too, like its page; its gallery
// card (/data) stays a viewer read, as it carries totals only. Adding, removing or resetting a user (a credential) and
// the settings (who may use it, whether it reaches your LAN, per-user figures) are also re-confirmed. Reload, the
// self-check and disconnect are admin only.
const FWDPROXY = /^\/api\/plugins\/3proxy\/proxies(\/|$)/
const FWDPROXY_ADMIN_READ = /^\/api\/plugins\/3proxy\/detail$/
const FWDPROXY_RECONFIRM = /^\/api\/plugins\/3proxy\/proxies\/[^/]+\/(users(\/[^/]+(\/reset)?)?|settings)$/
// The package cache (routes/aptcache.ts): admin for every method, reads included (a reading names the guests that use
// it); its gallery card (/api/plugins/apt-cacher-ng/data) stays a viewer read. Who may use it, Updates' "Use the package
// cache" and writing or removing the setting on every guest are also re-confirmed.
const APTCACHE = /^\/api\/plugins\/apt-cacher-ng\/(caches|use|guests)(\/|$)/
const APTCACHE_RECONFIRM = /^\/api\/plugins\/apt-cacher-ng\/(caches\/[^/]+\/settings|use|guests\/(repair|remove))$/
// A plug-in's settings hold the address its stored credential is sent to: changing them is re-confirmed (which
// also keeps API tokens out).
const PLUGIN_SETTINGS = /^\/api\/plugins\/[^/]+\/settings$/
// Local plug-ins (lib/local-plugins.ts): admin for every method, reads included, and every change re-confirmed
// (API tokens are refused there outright by api-tokens.ts, reads too). A plug-in may opt out of the re-confirmation
// alone (`reconfirm: false`); the list below is consulted only for an id the loader registered.
const LOCAL = /^\/api\/local(\/|$)/
const LOCAL_PLUGIN_ID = /^\/api\/local\/([a-z][a-z0-9-]{1,39})(\/|$)/

// Which loaded local plug-ins opted out of the re-confirmation. Filled by registerLocalPlugins (lib/local-plugins.ts)
// as each one is registered; kept here so the role rules import nothing. An id never registered — a plug-in that
// failed to load, a typo, anything — keeps the re-confirmation.
const localNoReconfirm = new Set<string>()

/** Record a registered local plug-in and whether its changes need the master password re-entered (the default). */
export function noteLocalPlugin(id: string, opts: { reconfirm?: boolean } = {}): void {
  if (opts.reconfirm === false) localNoReconfirm.add(id)
  else localNoReconfirm.delete(id)
}

/** True only for a registered local plug-in that opted out of the re-confirmation. */
export function localPluginSkipsReconfirm(id: string): boolean {
  return localNoReconfirm.has(id)
}

/** Tests: forget every registration. */
export function resetLocalPluginRegistry(): void {
  localNoReconfirm.clear()
}

/**
 * What an API token with the owner-granted plug-in settings permission may do without a re-confirmation: an explicit
 * allowlist of (method, path) pairs and nothing else. The gate checks both the raw path and the route Fastify matched.
 *   settings   PUT  /api/plugins/:id/settings                         any plug-in's settings, secrets included
 *   instances  POST /api/plugins/{pbs|home-assistant|qnap|asus}/instances   add one (PBS: by token; the confirmed
 *                                                                      fingerprint travels in the same body)
 *              PUT  /api/plugins/{pbs|home-assistant|qnap|asus}/instances/:iid   change one
 *   probe      POST /api/plugins/{pbs|home-assistant|qnap|asus}/instances/probe-certificate   read the fingerprint to confirm
 * Never: PBS add-by-sign-in (it carries a PBS admin password), PBS manage, verify, apply, gc or forget, Home
 * Assistant actions and secure actions, QNAP actions and secure actions, ASUS reboots, or deleting any instance.
 */
export type TokenPluginScope = { pluginId: string; kind: 'settings' | 'instances' | 'probe' }
const INSTANCE_PLUGINS = '(pbs|home-assistant|qnap|asus)'
const TOKEN_PLUGIN_ALLOW: Array<[string, RegExp, TokenPluginScope['kind']]> = [
  ['PUT',  /^\/api\/plugins\/([^/]+)\/settings$/, 'settings'],
  ['POST', new RegExp(`^/api/plugins/${INSTANCE_PLUGINS}/instances$`), 'instances'],
  ['PUT',  new RegExp(`^/api/plugins/${INSTANCE_PLUGINS}/instances/(?!probe-certificate$|signin$)[^/]+$`), 'instances'],
  ['POST', new RegExp(`^/api/plugins/${INSTANCE_PLUGINS}/instances/probe-certificate$`), 'probe'],
]

/** The allowlisted plug-in action this request is, or null (see TOKEN_PLUGIN_ALLOW). */
export function tokenPluginScope(method: string, path: string): TokenPluginScope | null {
  const m = method.toUpperCase()
  const p = normalisePath(path)
  for (const [am, re, kind] of TOKEN_PLUGIN_ALLOW) {
    if (m !== am) continue
    const hit = re.exec(p)
    if (hit) return { pluginId: hit[1], kind }
  }
  return null
}

// The owner-only switch on one API token (routes/api-tokens.ts).
const TOKEN_PLUGIN_SETTINGS = /^\/api\/auth\/tokens\/[^/]+\/plugin-settings$/
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
// HyperProx's own update (routes/self-update.ts): the header chip's summary is for everyone signed in; the rest,
// reads included, is admin (the log names paths and commits). Installing and changing its settings re-confirm.
const SELF_UPDATE = /^\/api\/self-update(\/|$)/
const SELF_UPDATE_SUMMARY = '/api/self-update/summary'

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
  // The public liveness probe (routes/health.ts publicHealthRoute): status only, GET/HEAD, nothing else under it.
  if (p === '/api/health' && (m === 'GET' || m === 'HEAD')) return null
  if (PUBLIC_AUTH.has(p)) return null
  // Authenticates itself with METRICS_TOKEN (a scraper has no session).
  if (p === '/api/plugins/metrics' && (m === 'GET' || m === 'HEAD')) return null

  if (ROLE_MGMT.test(p)) return 'owner'

  // Sign-out only clears the caller's own cookie, so it must work with a stale one.
  if (p === '/api/auth/sign-out') return null
  if (p === '/api/auth/reconfirm') return 'viewer'
  if (p === SESSION_CHECK) return 'viewer'
  if (p === '/api/auth/lock') return 'admin'
  // Letting a token save plug-in settings without the master password: an owner's call.
  if (TOKEN_PLUGIN_SETTINGS.test(p)) return 'owner'
  // API tokens: listing them is admin too (names, roles, who made them).
  if (TOKENS.test(p)) return 'admin'
  if (PROXY.test(p)) return (m === 'GET' || m === 'HEAD') && PROXY_READ.test(p) ? 'viewer' : 'admin'
  if (LOCAL.test(p)) return 'admin'
  if (CATALOGUE_WIZARD.test(p)) return 'admin'
  if (HOMEPAGE.test(p)) return 'admin'
  if (HAPROXY.test(p)) return 'admin'
  if (FWDPROXY.test(p)) return 'admin'
  if ((m === 'GET' || m === 'HEAD') && FWDPROXY_ADMIN_READ.test(p)) return 'admin'
  if (APTCACHE.test(p)) return 'admin'
  if (AUTO_CONNECT.test(p)) return 'admin'
  if (REMOVED_GUESTS.test(p)) return 'admin'
  if (CATALOGUE_DETECTED.test(p)) return 'admin'
  if (PLEX_SIGNIN.test(p)) return 'admin'
  if (SITES.test(p)) return 'admin'
  if (SITE_METRICS_ADMIN_READ.test(p)) return 'admin'
  if (SETUP_CHECKLIST.test(p)) return 'admin'
  if (ASUS_DIAGNOSTICS.test(p)) return 'admin'
  if ((m === 'GET' || m === 'HEAD') && NEXTCLOUD_ADMIN_READ.test(p)) return 'admin'
  if ((m === 'GET' || m === 'HEAD') && DNS_ADMIN_READ.test(p)) return 'admin'
  if (HA.test(p)) return (m === 'GET' || m === 'HEAD') && HA_READ.test(p) ? 'viewer' : 'admin'
  if (PLACEMENT.test(p)) return (m === 'GET' || m === 'HEAD') && PLACEMENT_READ.test(p) ? 'viewer' : 'admin'
  if (SELF_UPDATE.test(p)) return (m === 'GET' || m === 'HEAD') && p === SELF_UPDATE_SUMMARY ? 'viewer' : 'admin'
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
    // ── People in the vault (routes/users.ts): who has access, with their roles and emails. ──
    if (p === '/api/users' || p.startsWith('/api/users/')) return 'admin'
    return 'viewer'
  }

  if (m === 'POST' && POWER.test(p)) return 'operator'
  if (m === 'POST' && HA_CONTROL_ACT.test(p)) return 'operator'
  if (m === 'POST' && QNAP_ACT.test(p)) return 'operator'
  if (m === 'POST' && DNS_ACT.test(p)) return 'operator'
  if (m === 'POST' && PLEX_CLEAROUT_ACT.test(p)) return 'operator'
  for (const [tm, re] of TERMINAL_OPERATOR) if (m === tm && re.test(p)) return 'operator'

  return 'admin'
}

/**
 * Requests that need the master password re-entered within the last 5 minutes.
 * `opts.tokenPluginScope` (the gate, for an API token an owner gave the plug-in settings permission) lifts the
 * re-confirmation for exactly the allowlisted pairs in tokenPluginScope(); every other request is unchanged.
 */
export function needsReconfirm(method: string, path: string, opts: { tokenPluginScope?: boolean } = {}): boolean {
  const m = method.toUpperCase()
  const p = normalisePath(path)
  if (opts.tokenPluginScope && tokenPluginScope(m, p)) return false
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
  // Naming & addresses decides which network every new guest lands on: saving it is re-confirmed.
  if (m === 'PUT' && p === '/api/catalogue/wizard/naming') return true
  if (m === 'POST' && SITES_RECONFIRM.test(p)) return true
  for (const [sm, re] of SITE_METRICS_RECONFIRM) if (m === sm && re.test(p)) return true
  if (m === 'POST' && GUEST_CONFIG_APPLY.test(p)) return true
  if (m === 'POST' && HA_RECONFIRM.test(p)) return true
  if (m === 'POST' && PLACEMENT_RECONFIRM.test(p)) return true
  if (m === 'PUT' && p === '/api/placement/settings') return true
  if (m === 'POST' && p === PLACEMENT_PLAN_RUN) return true
  if (m === 'PUT' && p === PLACEMENT_AUTO) return true
  if (m !== 'GET' && m !== 'HEAD' && HA_CONTROL_RECONFIRM.test(p)) return true
  if (m !== 'GET' && m !== 'HEAD' && QNAP_RECONFIRM.test(p)) return true
  if (m !== 'GET' && m !== 'HEAD' && DNS_RECONFIRM.test(p)) return true
  if (m !== 'GET' && m !== 'HEAD' && ASUS_RECONFIRM.test(p)) return true
  if (m !== 'GET' && m !== 'HEAD' && PBS_RECONFIRM.test(p)) return true
  if (m !== 'GET' && m !== 'HEAD' && PBS_MANAGE_RECONFIRM.test(p)) return true
  if (m !== 'GET' && m !== 'HEAD' && NEXTCLOUD_RECONFIRM.test(p)) return true
  if (m !== 'GET' && m !== 'HEAD' && HOMEPAGE_RECONFIRM.test(p)) return true
  if (m !== 'GET' && m !== 'HEAD' && FWDPROXY_RECONFIRM.test(p)) return true
  if (m !== 'GET' && m !== 'HEAD' && APTCACHE_RECONFIRM.test(p)) return true
  if (m === 'PUT' && PLUGIN_SETTINGS.test(p)) return true
  // Disconnecting a plug-in deletes its vault item (every key it had).
  if (m === 'DELETE' && PLUGIN_SETTINGS.test(p)) return true
  if (m === 'POST' && REMOVED_GUESTS_CLEAN.test(p)) return true
  if (m === 'POST' && PLEX_SIGNIN_RECONFIRM.test(p)) return true
  if (m === 'POST' && PLEX_CLEAROUT_RECONFIRM.test(p)) return true
  if (m === 'PUT' && SETTINGS_SAVE.test(p)) return true
  if (m === 'POST' && SETTINGS_TEST.test(p)) return true
  // Creating or revoking an API token, or changing what one may do.
  if ((m === 'POST' || m === 'DELETE' || m === 'PUT') && TOKENS.test(p)) return true
  for (const [rm, re] of REMOTE_RECONFIRM) if (m === rm && re.test(p)) return true
  if (m !== 'GET' && m !== 'HEAD' && VPN.test(p) && !VPN_PREVIEW.test(p)) return true
  for (const [cm, re] of CLUSTERS_RECONFIRM) if (m === cm && re.test(p)) return true
  if (m !== 'GET' && m !== 'HEAD' && LOCAL.test(p)) {
    const id = LOCAL_PLUGIN_ID.exec(p)?.[1]
    return !(id && localPluginSkipsReconfirm(id))
  }
  if (m === 'POST' && p === '/api/self-update/install') return true
  if (m === 'PUT' && p === '/api/self-update/settings') return true
  // ── Vault items and people (routes/secrets.ts delete, routes/users.ts) ─────
  // Deleting a vault item, inviting a person, changing their role or confirming them into the vault.
  if (m === 'POST' && p === '/api/secrets/delete') return true
  if (m !== 'GET' && m !== 'HEAD' && /^\/api\/users(\/|$)/.test(p)) return true
  return false
}
