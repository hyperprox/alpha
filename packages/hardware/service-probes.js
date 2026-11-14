'use strict'
// =============================================================================
//  Which services already run on the cluster: the one list of probes
//
//  Three places ask this question: the setup wizard's "Existing services" step, the Plug-ins page's
//  "Scan for services", and the Catalogue's "already here". They used to carry three lists of their own,
//  with different ports and different rules for a match, so the wizard and Scan found Nginx Proxy
//  Manager, Proxmox Backup Server, Unmanic, the Arr apps and Tautulli while the Catalogue said "not
//  found". This file is the single list and the single scan; each consumer only maps the findings into
//  its own shape.
//
//  Every probe is one unauthenticated GET to a port the service is known to answer on, matched against
//  something only that service returns. No credential is ever sent, nothing is written, and a redirect is
//  followed only within the same origin, scheme, host and port (a service answering /api with 302 -> /api/ is
//  still that service; a redirect elsewhere could point the scan at any address, so it is a miss).
// =============================================================================

/**
 * @typedef {Object} ServiceProbe
 * @property {string} key        Stable id of the service (npm, pbs, sonarr...).
 * @property {string} label      What a person reads.
 * @property {number} port
 * @property {string} path
 * @property {'http'|'https'} scheme
 * @property {string|null} recipeId   The Catalogue recipe this service satisfies, if any.
 * @property {string|null} pluginId   The bundled plug-in it configures, if any.
 * @property {string|null} setting    That plug-in's setting that takes the address.
 * @property {string[]} needs         Settings a person must still supply (a key that cannot be discovered).
 * @property {boolean} multiple       Several of it may legitimately run (Unmanic workers).
 * @property {(status: number, body: string) => boolean} match
 */

const title = (name) => new RegExp('<title>[^<]*' + name + '[^<]*</title>', 'i')

/** @type {ServiceProbe[]} */
const PROBES = [
  // The admin page's <title> names the product on every version ('/' not '/api': 2.16 redirects /api to /api/).
  { key: 'npm', label: 'Nginx Proxy Manager', port: 81, path: '/', scheme: 'http', recipeId: 'nginx-proxy-manager', pluginId: null, setting: null, needs: [], multiple: false,
    match: (s, b) => s === 200 && /nginx proxy manager/i.test(b) },
  // Its version endpoint needs a login; the web interface's title does not.
  { key: 'pbs', label: 'Proxmox Backup Server', port: 8007, path: '/', scheme: 'https', recipeId: 'proxmox-backup-server', pluginId: null, setting: null, needs: [], multiple: false,
    match: (s, b) => s === 200 && /proxmox backup server/i.test(b) },
  { key: 'ollama', label: 'Ollama', port: 11434, path: '/api/tags', scheme: 'http', recipeId: 'ollama', pluginId: null, setting: null, needs: [], multiple: false,
    match: (s, b) => { if (s !== 200) return false; try { return Array.isArray(JSON.parse(b).models) } catch { return false } } },
  // Answers with a bare version string like "v4.6.5" and nothing else.
  { key: 'qbittorrent', label: 'qBittorrent', port: 8080, path: '/api/v2/app/version', scheme: 'http', recipeId: null, pluginId: 'arrstack', setting: 'qbit_url', needs: [], multiple: false,
    match: (s, b) => s === 200 && /^v?\d+\.\d+[0-9A-Za-z.+-]*$/.test(b.trim()) },
  { key: 'unmanic', label: 'Unmanic', port: 8888, path: '/unmanic/api/v2/workers/status', scheme: 'http', recipeId: 'unmanic', pluginId: 'unmanic', setting: 'url', needs: [], multiple: true,
    match: (s, b) => s === 200 && b.includes('workers_status') },
  { key: 'sonarr', label: 'Sonarr', port: 8989, path: '/ping', scheme: 'http', recipeId: 'arr-stack', pluginId: 'arrstack', setting: 'sonarr_url', needs: ['sonarr_key'], multiple: false,
    match: (s, b) => s === 200 && b.includes('"status"') },
  { key: 'radarr', label: 'Radarr', port: 7878, path: '/ping', scheme: 'http', recipeId: 'arr-stack', pluginId: 'arrstack', setting: 'radarr_url', needs: ['radarr_key'], multiple: false,
    match: (s, b) => s === 200 && b.includes('"status"') },
  { key: 'lidarr', label: 'Lidarr', port: 8686, path: '/ping', scheme: 'http', recipeId: 'arr-stack', pluginId: 'arrstack', setting: 'lidarr_url', needs: ['lidarr_key'], multiple: false,
    match: (s, b) => s === 200 && b.includes('"status"') },
  // Answers 401 without a key, which is itself proof it is Prowlarr.
  { key: 'prowlarr', label: 'Prowlarr', port: 9696, path: '/api/v1/system/status', scheme: 'http', recipeId: 'arr-stack', pluginId: 'arrstack', setting: 'prowlarr_url', needs: ['prowlarr_key'], multiple: false,
    match: (s, b) => s === 401 || (s === 200 && b.includes('appName')) },
  // Plex answers /identity without a token, with its machine identifier.
  { key: 'plex', label: 'Plex', port: 32400, path: '/identity', scheme: 'http', recipeId: null, pluginId: 'plex', setting: 'plex_url', needs: ['plex_token'], multiple: false,
    match: (s, b) => s === 200 && /machineIdentifier/.test(b) },
  // Tautulli answers /status without a key; the login page also names itself.
  { key: 'tautulli', label: 'Tautulli (optional, for richer Plex stats)', port: 8181, path: '/status', scheme: 'http', recipeId: 'tautulli', pluginId: 'plex', setting: 'url', needs: ['apikey'], multiple: false,
    match: (s, b) => s < 500 && /tautulli/i.test(b) },
  { key: 'jellyfin', label: 'Jellyfin', port: 8096, path: '/System/Info/Public', scheme: 'http', recipeId: 'jellyfin', pluginId: null, setting: null, needs: [], multiple: false,
    match: (s, b) => s === 200 && /"ProductName"\s*:\s*"[^"]*jellyfin/i.test(b) },
  { key: 'tdarr', label: 'Tdarr', port: 8265, path: '/', scheme: 'http', recipeId: 'tdarr', pluginId: null, setting: null, needs: [], multiple: false,
    match: (s, b) => s === 200 && title('Tdarr').test(b) },
]

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/

/**
 * @typedef {{ status: number, body: string, location?: string|null }} Answer
 * @typedef {(url: string) => Promise<Answer|null>} Getter   One GET, redirects NOT followed, body capped.
 * @typedef {{ address: string, source: string, guest?: any }} ScanHost
 */

/**
 * One probe against one host. Follows at most two redirects, and only within the same origin. Never throws.
 * @param {Getter} get
 * @param {string} host
 * @param {ServiceProbe} probe
 */
async function probeHost(get, host, probe) {
  let url = `${probe.scheme}://${host}:${probe.port}${probe.path}`
  for (let hops = 0; hops <= 2; hops++) {
    let a = null
    try { a = await get(url) } catch { a = null }
    if (!a) return false
    if (a.status >= 300 && a.status < 400) {
      if (!a.location) return false
      let next
      try { next = new URL(a.location, url) } catch { return false }
      if (next.origin !== new URL(url).origin) return false
      url = next.toString()
      continue
    }
    return Boolean(probe.match(a.status, String(a.body ?? '').slice(0, 64 * 1024)))
  }
  return false
}

/** At most `limit` at once. */
async function mapLimit(items, limit, fn) {
  let i = 0
  const run = async () => { while (i < items.length) { const n = i++; await fn(items[n], n) } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
}

/**
 * The scan: every probe against every host. One finding per (host, service) that answered.
 * The result is sorted so every consumer sees the same order.
 * @param {ScanHost[]} hosts
 * @param {Getter} get
 * @param {{ probes?: ServiceProbe[], concurrency?: number }} [opts]
 */
async function scanHosts(hosts, get, opts = {}) {
  const probes = opts.probes || PROBES
  const seen = new Set()
  const clean = []
  for (const h of hosts || []) {
    const address = String(h && h.address || '').trim()
    if (!(IPV4.test(address) || HOSTNAME.test(address)) || address.startsWith('127.') || seen.has(address)) continue
    seen.add(address)
    clean.push({ ...h, address })
  }
  const jobs = clean.flatMap(h => probes.map(p => ({ h, p })))
  const found = []
  await mapLimit(jobs, opts.concurrency || 16, async ({ h, p }) => {
    if (await probeHost(get, h.address, p)) {
      found.push({ key: p.key, label: p.label, recipeId: p.recipeId, pluginId: p.pluginId, setting: p.setting, needs: p.needs.slice(),
        multiple: p.multiple, address: `${p.scheme}://${h.address}:${p.port}`, host: h.address, port: p.port, source: h.source, guest: h.guest ?? null })
    }
  })
  return found.sort((a, b) => a.label.localeCompare(b.label) || a.host.localeCompare(b.host, undefined, { numeric: true }))
}

/**
 * The verdict per service key: found or not, and where. What the wizard's "Existing services" step shows,
 * and what the other consumers must agree with.
 * @param {Array<{key: string, address: string}>} findings
 */
function verdicts(findings, probes = PROBES) {
  const out = {}
  for (const p of probes) out[p.key] = { found: false, addresses: [] }
  for (const f of findings) {
    const v = out[f.key] || (out[f.key] = { found: false, addresses: [] })
    v.found = true
    if (!v.addresses.includes(f.address)) v.addresses.push(f.address)
  }
  return out
}

const TIMEOUT_MS = 2500
const MAX_BYTES = 64 * 1024

/**
 * The real GET for every consumer: nothing sent but the request line and a user agent, redirects returned (not
 * followed; probeHost decides), 2.5 s timeout, at most 64 KiB read. Internal services mostly have self-signed
 * certificates, and nothing secret is sent, so the certificate is not checked.
 * @type {Getter}
 */
function realGet(url) {
  return new Promise(resolve => {
    let u
    try { u = new URL(url) } catch { resolve(null); return }
    const mod = u.protocol === 'https:' ? require('https') : require('http')
    const req = mod.request(u, {
      method: 'GET', timeout: TIMEOUT_MS,
      headers: { 'user-agent': 'HyperProx-service-scan', accept: 'application/json, text/html;q=0.9, */*;q=0.5' },
      ...(u.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
    }, res => {
      const chunks = []
      let n = 0
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        const loc = res.headers.location
        resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8'), location: typeof loc === 'string' ? loc : null })
      }
      res.on('data', c => { n += c.length; if (n <= MAX_BYTES) chunks.push(c); else { res.destroy(); done() } })
      res.on('end', done); res.on('close', done); res.on('error', () => resolve(null))
    })
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.on('error', () => resolve(null))
    req.end()
  })
}

module.exports = { PROBES, probeHost, scanHosts, verdicts, realGet }
