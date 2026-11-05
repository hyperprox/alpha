#!/usr/bin/env node
'use strict'

/**
 * HyperProx Setup Wizard
 * Single-file, zero dependencies, zero build step.
 * Run with: node setup.js
 */

const http      = require('http')
const https     = require('https')
const fs        = require('fs')
const path      = require('path')
const crypto    = require('crypto')
const { exec }  = require('child_process')
const exporter  = require('./pve-exporter')
const onboard   = require('./onboarding')

const PORT     = parseInt(process.env.SETUP_PORT || '3001', 10)
const ENV_PATH = path.resolve(process.env.ENV_FILE_PATH || '/opt/hyperprox/.env')
const HPX_DIR  = process.env.HYPERPROX_DIR || '/opt/hyperprox'
const API_PORT = parseInt(process.env.API_PORT || '3002', 10)

// ── Bail if already set up ────────────────────────────────────────────────────
// Only when run as the service: tests load this file for its decision functions.
if (require.main === module && process.env.SETUP_COMPLETE === 'true') {
  console.log('[hyperprox-setup] Already complete — exiting.')
  process.exit(0)
}

// =============================================================================
// ENV helpers
// =============================================================================

function readEnv() {
  try {
    const map = {}
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq === -1) continue
      map[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    }
    return map
  } catch { return {} }
}

function writeEnv(updates) {
  let raw = ''
  try { raw = fs.readFileSync(ENV_PATH, 'utf8') } catch {}

  const lines    = raw.split('\n')
  const updated  = new Set()

  const newLines = lines.map(line => {
    const t = line.trim()
    if (!t || t.startsWith('#')) return line
    const eq = t.indexOf('=')
    if (eq === -1) return line
    const key = t.slice(0, eq).trim()
    if (key in updates) { updated.add(key); return `${key}=${updates[key]}` }
    return line
  })

  for (const [k, v] of Object.entries(updates)) {
    if (!updated.has(k)) newLines.push(`${k}=${v}`)
  }

  // .env holds the Proxmox token and every secret not yet in the vault: owner-only, whatever mode it had.
  fs.writeFileSync(ENV_PATH, newLines.join('\n'), { encoding: 'utf8', mode: 0o600 })
  fs.chmodSync(ENV_PATH, 0o600)
  Object.assign(process.env, updates)
}

/** Remove keys from .env entirely (SETUP_SECRET once setup is done). */
function removeEnv(keys) {
  let raw = ''
  try { raw = fs.readFileSync(ENV_PATH, 'utf8') } catch { return }
  const drop = new Set(keys)
  const kept = raw.split('\n').filter(line => {
    const t = line.trim(); const eq = t.indexOf('=')
    return !(eq > 0 && !t.startsWith('#') && drop.has(t.slice(0, eq).trim()))
  })
  fs.writeFileSync(ENV_PATH, kept.join('\n'), { encoding: 'utf8', mode: 0o600 })
  fs.chmodSync(ENV_PATH, 0o600)
  for (const k of keys) delete process.env[k]
}

// =============================================================================
// Proxmox API helper
// =============================================================================

function pveRequest(host, port, tokenId, tokenSecret, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      port: parseInt(port, 10),
      path: `/api2/json${path}`,
      method: 'GET',
      headers: { Authorization: `PVEAPIToken=${tokenId}=${tokenSecret}` },
      rejectUnauthorized: false,   // LAN self-signed certs
      timeout: 6000,
    }
    const req = https.request(options, res => {
      let body = ''
      res.on('data', d => { body += d })
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`PVE ${res.statusCode}: ${body}`))
        try { resolve(JSON.parse(body).data) } catch { reject(new Error('Invalid JSON from Proxmox')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Connection timed out')) })
    req.end()
  })
}

/**
 * Any Proxmox API call with a ticket (cookie + CSRF), an API token ({ token: 'PVEAPIToken=...' }) or none,
 * form-encoded body. connectWithLogin uses the user's own session to create HyperProx's token; the
 * exporter's read-only token is made with whichever of the two the wizard has.
 */
function pveCall(host, port, method, path, form, auth) {
  return new Promise((resolve, reject) => {
    const body = form ? new URLSearchParams(form).toString() : ''
    const headers = {}
    if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; headers['Content-Length'] = Buffer.byteLength(body) }
    if (auth && auth.token) headers.Authorization = auth.token
    else if (auth) { headers.Cookie = `PVEAuthCookie=${encodeURIComponent(auth.ticket)}`; headers.CSRFPreventionToken = auth.csrf }
    const req = https.request({ hostname: host, port: parseInt(port, 10), path: `/api2/json${path}`, method, headers,
      rejectUnauthorized: false, timeout: 15000 }, res => {
      let out = ''
      res.on('data', d => { out += d })
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(Object.assign(new Error(`PVE ${res.statusCode}: ${out.slice(0, 200)}`), { status: res.statusCode }))
        try { resolve(JSON.parse(out).data) } catch { reject(new Error('Invalid JSON from Proxmox')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Connection timed out')) })
    req.end(body)
  })
}

/**
 * This install's own id: short, random, generated once and kept in .env as HYPERPROX_INSTALL_ID. The
 * hostname alone does not tell installs apart - bootstrap.sh names every container `hyperprox` - so two
 * default installs on one cluster would otherwise share a token name and the second would revoke the
 * first's key.
 */
function installId() {
  const saved = readEnv().HYPERPROX_INSTALL_ID || ''
  if (/^[a-f0-9]{8}$/.test(saved)) return saved
  const id = crypto.randomBytes(4).toString('hex')
  writeEnv({ HYPERPROX_INSTALL_ID: id })
  return id
}

/**
 * The one token name this install uses: `hyperprox-<host>-<install id>`. Fixed for the life of the install,
 * so re-running the connect step finds the token it made last time instead of minting another one on every
 * attempt, and unique to it, so it never names a token another HyperProx on the same cluster runs on.
 */
function tokenName(hostname, id) {
  const h = String(hostname).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 16) || 'install'
  return `hyperprox-${h}-${id}`
}

/** The token comment carries the install id; it is what proves a token is this install's own to replace. */
function tokenComment(hostname, id) {
  return `HyperProx on ${hostname} [install ${id}] (created by the setup wizard)`
}

/**
 * Leave HyperProx holding a working token while changing as little on the cluster as possible:
 *   reuse    - the token HyperProx already holds for this user still authenticates; nothing is changed
 *   create   - no token called `name` exists yet
 *   recreate - `name` exists, its comment carries this install's id, and HyperProx no longer holds a
 *              working secret for it (the secret is only ever shown once): delete that one token and make
 *              it again.
 * A token of that name without this install's id in its comment is refused, never replaced, and no other
 * token is ever deleted. `pve` is the cluster as seen through the user's session:
 * { listTokens(), createToken(name, comment), deleteToken(name), tokenWorks(fullTokenId, secret) }.
 * `held` is what .env records for this same host: { tokenId: 'user@realm!name', secret }, or null.
 */
async function ensureToken(pve, { userid, name, held, installId: id, comment }) {
  if (held && held.tokenId && held.secret && held.tokenId.startsWith(`${userid}!`)
      && await pve.tokenWorks(held.tokenId, held.secret)) {
    return { action: 'reuse', tokenId: held.tokenId, tokenSecret: held.secret }
  }
  const existing = ((await pve.listTokens()) || []).find(t => t && t.tokenid === name)
  let action = 'create'
  if (existing) {
    if (!id || !String(existing.comment || '').includes(`[install ${id}]`)) {
      throw new Error(`A Proxmox token named ${userid}!${name} already exists and was not made by this HyperProx, so it was left alone. Remove it in Proxmox, or paste a token under Advanced.`)
    }
    await pve.deleteToken(name)
    action = 'recreate'
  }
  const tok = await pve.createToken(name, comment)
  if (!tok || !tok.value) throw new Error('Proxmox created the token but returned no secret')
  return { action, tokenId: tok['full-tokenid'] || `${userid}!${name}`, tokenSecret: tok.value }
}

/** True if the token authenticates; false if Proxmox refuses it. Any other failure is thrown. */
async function tokenWorks(host, port, tokenId, tokenSecret) {
  try {
    await pveRequest(host, port, tokenId, tokenSecret, '/version')
    return true
  } catch (err) {
    if (/^PVE (401|403)\b/.test(err.message)) return false
    throw err
  }
}

/**
 * Connect with the same login as the Proxmox web interface. Signs in once, makes sure HyperProx holds its
 * own API token `<user>!hyperprox-<host>-<install id>` with the user's privileges (see ensureToken), tests it, and
 * returns it. The password and the session ticket are used for these calls only and never stored.
 */
async function connectWithLogin(host, port, username, password, otp, held = null) {
  const userid = username.includes('@') ? username : `${username}@pam`
  let t = await pveCall(host, port, 'POST', '/access/ticket', { username: userid, password })
  if (t && t.NeedTFA) {
    if (!otp) throw Object.assign(new Error('This account uses two-factor sign-in — enter your 6-digit code.'), { needTfa: true })
    t = await pveCall(host, port, 'POST', '/access/ticket', { username: userid, 'tfa-challenge': t.ticket, password: `totp:${otp}` })
  }
  const auth = { ticket: t.ticket, csrf: t.CSRFPreventionToken }
  const pve = pveAdapter(host, port, auth, userid)
  const hostname = require('os').hostname()
  const id = installId()
  const { tokenId, tokenSecret, action } = await ensureToken(pve,
    { userid, name: tokenName(hostname, id), held, installId: id, comment: tokenComment(hostname, id) })
  console.log(`[setup] Proxmox token ${tokenId}: ${action}`)
  const cluster = await testProxmox(host, port, tokenId, tokenSecret)
  const exporterResult = await setupExporterSafely(pve, userid, tokenId.split('!')[1])
  return { tokenId, tokenSecret, cluster, exporter: exporterResult }
}

/**
 * The token calls on one Proxmox user, through a sign-in ticket or an API token (see pveCall). HyperProx's
 * own token is made with privilege separation off (it acts with the user's rights); the exporter's with it
 * on, plus one PVEAuditor ACL, so it can only read (apps/setup/pve-exporter.js).
 */
function pveAdapter(host, port, auth, userid) {
  const tokens = `/access/users/${encodeURIComponent(userid)}/token`
  return {
    listTokens:  () => pveCall(host, port, 'GET', tokens, null, auth),
    deleteToken: (name) => pveCall(host, port, 'DELETE', `${tokens}/${encodeURIComponent(name)}`, null, auth),
    // (name, comment) for HyperProx's own token; (name, { privsep, comment }) for the exporter's.
    createToken: (name, o) => pveCall(host, port, 'POST', `${tokens}/${encodeURIComponent(name)}`,
      typeof o === 'string' ? { privsep: '0', comment: o } : { privsep: String(o.privsep), comment: o.comment }, auth),
    getToken:    (name, user = userid) => pveCall(host, port, 'GET',
      `/access/users/${encodeURIComponent(user)}/token/${encodeURIComponent(name)}`, null, auth),
    listAcl:     () => pveCall(host, port, 'GET', '/access/acl', null, auth),
    setAcl:      ({ path: p, role, token }) => pveCall(host, port, 'PUT', '/access/acl',
      { path: p, roles: role, tokens: token, propagate: '1' }, auth),
    tokenWorks:  (id, secret) => tokenWorks(host, port, id, secret),
  }
}

/** Where the exporter reads its token: config/pve-exporter/pve.yml next to this install's .env. */
function exporterConfigPath() {
  return path.join(path.dirname(ENV_PATH), 'config', 'pve-exporter', 'pve.yml')
}

function restartExporter() {
  exec('docker restart hyperprox-pve-exporter', (err) => {
    if (err) console.log('[setup] pve-exporter not restarted (not running yet; it reads pve.yml when it starts)')
  })
}

/**
 * Give the PVE exporter its read-only token and write pve.yml (0600, the exporter's own). Restarts the
 * exporter only when the file changed. `pve` is pveAdapter() for HyperProx's user.
 */
async function setupExporter(pve, userid, adminTokenName, file = exporterConfigPath(), restart = restartExporter) {
  const r = await exporter.ensureExporterToken(pve, { userid, adminTokenName, held: exporter.readPveYml(file) })
  const changed = exporter.writePveYml(file, exporter.renderPveYml({ user: r.user, tokenName: r.tokenName, secret: r.secret }))
  if (changed) restart()
  console.log(`[setup] exporter token ${r.fullTokenId}: ${r.action}`)
  return { ok: true, action: r.action, tokenId: r.fullTokenId }
}

/** Never fails the connect step: monitoring without Proxmox panels is still a working HyperProx. */
async function setupExporterSafely(pve, userid, adminTokenName) {
  try { return await setupExporter(pve, userid, adminTokenName) }
  catch (err) {
    console.warn('[setup] could not set up the exporter token:', err.message)
    return { ok: false, error: err.message }
  }
}

/** The token .env already records for this Proxmox address, if any - the one ensureToken may reuse. */
function heldToken(env, host, port) {
  if (!env.PROXMOX_HOST || env.PROXMOX_HOST !== host || String(env.PROXMOX_PORT || '8006') !== String(port)) return null
  if (!env.PROXMOX_USER || !env.PROXMOX_TOKEN_ID || !env.PROXMOX_TOKEN_SECRET) return null
  return { tokenId: `${env.PROXMOX_USER}!${env.PROXMOX_TOKEN_ID}`, secret: env.PROXMOX_TOKEN_SECRET }
}

async function testProxmox(host, port, tokenId, tokenSecret) {
  const version  = await pveRequest(host, port, tokenId, tokenSecret, '/version')
  const nodes    = await pveRequest(host, port, tokenId, tokenSecret, '/nodes')
  const status   = await pveRequest(host, port, tokenId, tokenSecret, '/cluster/status')
  const cluster  = status.find(e => e.type === 'cluster') || {}

  let runningVms = 0, runningCts = 0
  try {
    const resources = await pveRequest(host, port, tokenId, tokenSecret, '/cluster/resources?type=vm')
    for (const r of resources) {
      if (r.status !== 'running') continue
      if (r.type === 'qemu') runningVms++
      if (r.type === 'lxc')  runningCts++
    }
  } catch {}

  let ceph = null
  let cephMonNode = null
  try {
    const cs = await pveRequest(host, port, tokenId, tokenSecret, '/cluster/ceph/status')
    if (cs && cs.health) {
      ceph = {
        healthy: cs.health.status === 'HEALTH_OK',
        // The pool count lives in pgmap; /cluster/ceph/status has no top-level
        // `pools` key, so the old `(cs.pools || []).length` was always 0.
        pools:   (cs.pgmap && cs.pgmap.num_pools) || 0,
      }

      // /nodes/{node}/ceph/mon is CLUSTER-WIDE despite the path: every node
      // returns every monitor. The previous loop therefore matched on its first
      // iteration and took the first entry of /nodes — which is unordered —
      // without ever checking it against the monitor list it had just fetched.
      const onlineNodes = (nodes || []).filter(n => !n.status || n.status === 'online')
      const nodeNames   = new Set(onlineNodes.map(n => n.node))

      for (const node of onlineNodes) {
        let mons = null
        try { mons = await pveRequest(host, port, tokenId, tokenSecret, `/nodes/${node.node}/ceph/mon`) }
        catch { continue }
        if (!Array.isArray(mons) || mons.length === 0) continue

        // Build the URL from a real Proxmox node name — a monitor id is only
        // "typically" the hostname. Sort by rank; both lists are unordered.
        const usable = mons
          .filter(m => nodeNames.has(m.host || m.name))
          .sort((a, b) => (a.rank == null ? 99 : a.rank) - (b.rank == null ? 99 : b.rank))

        const pick = usable.find(m => m.quorum && m.state === 'running')
                  || usable.find(m => m.state === 'running')
                  || usable[0]
        if (pick) { cephMonNode = pick.host || pick.name; break }
      }
    }
  } catch {}

  return {
    name:       cluster.name || host,
    version:    `${version.version}-${version.release}`,
    nodes:      nodes || [],
    quorate:    Boolean(cluster.quorate),
    nodeCount:  (nodes || []).length,
    runningVms,
    runningCts,
    ceph,
    cephMonNode,
  }
}

/**
 * The step a (re)loaded wizard opens on, decided by what .env already records rather than by the tab:
 *   0 Proxmox    - no saved connection, or the saved token no longer authenticates
 *   1 Cluster    - connected; the service scan (step 2) is not persisted, so it reruns from here
 *   3 Providers  - the install choices from step 2 are saved
 * There is no resuming into step 4: once setup completes, this server exits for good.
 */
function resumeStep(env, proxmoxOk) {
  if (!env.PROXMOX_HOST || !env.PROXMOX_TOKEN_ID || !env.PROXMOX_TOKEN_SECRET || !proxmoxOk) return 0
  if (!('INSTALL_PROMETHEUS' in env)) return 1
  return 3
}

/**
 * The compose profiles the step-2 choices stand for (written to .env as COMPOSE_PROFILES). There is no
 * bundled Nginx Proxy Manager any more (it needs ports 80 and 443, which HyperProx's nginx holds, so it
 * never started); an old INSTALL_NPM=true is ignored. NPM comes from the Catalogue instead.
 */
function composeProfiles(env) {
  const profiles = []
  if (env.INSTALL_PROMETHEUS === 'true' || env.INSTALL_GRAFANA === 'true') profiles.push('monitoring')
  return profiles.join(',')
}

// =============================================================================
// Service scanner
// =============================================================================

function probeHttp(host, port, path, match, timeoutMs = 2500, useHttps = false, hops = 2) {
  return new Promise(resolve => {
    let done = false
    const finish = (val) => { if (!done) { done = true; resolve(val) } }
    const hard = setTimeout(() => finish(false), timeoutMs)

    const net = require('net')
    const socket = net.createConnection({ host, port, timeout: timeoutMs })
    socket.on('error', () => { clearTimeout(hard); finish(false) })
    socket.on('timeout', () => { socket.destroy(); clearTimeout(hard); finish(false) })
    socket.on('connect', () => {
      socket.destroy()
      const lib = useHttps ? require('https') : http
      const req = lib.request({ hostname: host, port, path, method: 'GET', rejectUnauthorized: false }, res => {
        // Follow a same-host redirect (a service answering /api with 302 -> /api/ is a service, not a miss).
        const loc = res.headers.location
        if (res.statusCode >= 300 && res.statusCode < 400 && loc && hops > 0) {
          res.resume(); clearTimeout(hard)
          try {
            const u = new URL(loc, `${useHttps ? 'https' : 'http'}://${host}:${port}`)
            if (u.hostname === host) {
              return probeHttp(host, u.port || (u.protocol === 'https:' ? 443 : 80), u.pathname + u.search, match, timeoutMs, u.protocol === 'https:', hops - 1).then(finish)
            }
          } catch {}
          return finish(false)
        }
        let body = ''
        res.on('data', d => { body += d })
        res.on('end', () => { clearTimeout(hard); finish(body.toLowerCase().includes(match.toLowerCase())) })
      })
      req.on('error', () => { clearTimeout(hard); finish(false) })
      req.setTimeout(timeoutMs, () => { req.destroy(); clearTimeout(hard); finish(false) })
      req.end()
    })
  })
}

async function scanServices(hosts) {
  const probes = [
    // '/' not '/api': NPM 2.16 redirects /api to /api/, whose JSON never names the product; the admin page's
    // <title> does, on every version.
    { key: 'npm',     name: 'Nginx Proxy Manager', port: 81,    path: '/',            match: 'nginx proxy manager' },
    { key: 'ollama',  name: 'Ollama',               port: 11434, path: '/api/tags',    match: 'models' },
    // the version endpoint needs a login (401), so it never matched; the web UI title does not.
    { key: 'pbs',     name: 'Proxmox Backup Server',port: 8007,  path: '/',            match: 'proxmox backup server', https: true },
  ]

  const tasks = hosts.flatMap(host =>
    probes.map(async p => {
      const found = await probeHttp(host, p.port, p.path, p.match, 2500, p.https || false)
      return { ...p, host, found, detail: found ? `${host}:${p.port}` : null }
    })
  )

  const results = await Promise.all(tasks)

  // Deduplicate — one entry per service key, prefer found=true
  const best = {}
  for (const r of results) {
    if (!best[r.key] || (r.found && !best[r.key].found)) best[r.key] = r
  }

  return Object.values(best)
}

// =============================================================================
// Wizard HTML (single-page, no framework, no CDN)
// =============================================================================

const WIZARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HyperProx Setup</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Barlow:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--cyan:#2fd6e8;--bg:#0a111c;--surface:#0f1b2b;--border:#22344a;--text:#c9d4e2;--muted:#9fb0c4;--green:#4ade80;--red:#f05252;--amber:#f5a524}
body{background:var(--bg);color:var(--text);font-family:'Barlow',system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}
.wrap{width:100%;max-width:560px}
.logo{font-family:'Barlow Condensed',sans-serif;font-size:2.4rem;font-weight:700;letter-spacing:.12em;margin-bottom:4px;color:#fff}
.eyebrow{font-family:'IBM Plex Mono',monospace;font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--cyan);margin-bottom:6px}
.card-title{font-family:'Barlow Condensed',sans-serif!important;font-weight:700!important;font-size:1.9rem!important;color:#fff!important}
.field-hint{font-size:12.5px;color:var(--muted);margin-top:6px}
.adv{margin:.5rem 0 1rem;border:1px solid var(--border);border-radius:6px;padding:.6rem .9rem}
.adv summary{cursor:pointer;color:var(--muted);font-size:13px}
.adv[open] summary{margin-bottom:.8rem}
.logo span{color:var(--cyan)}
.tagline{color:var(--muted);font-size:14px;margin-bottom:2.5rem}
.steps{display:flex;gap:0;margin-bottom:2rem;align-items:center}
.step{display:flex;align-items:center;flex:1}
.step:last-child{flex:0}
.dot{width:30px;height:30px;border-radius:50%;border:1.5px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:var(--muted);flex-shrink:0;font-family:'IBM Plex Mono',monospace;transition:.2s}
.dot.active{border-color:var(--cyan);color:var(--cyan);background:rgba(0,200,224,.1)}
.dot.done{border-color:var(--green);color:var(--green);background:rgba(34,197,94,.1)}
.line{flex:1;height:1px;background:var(--border);margin:0 4px}
.line.done{background:var(--green)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:1.75rem;margin-bottom:1rem}
.card-title{font-size:1.25rem;font-weight:600;margin-bottom:.35rem}
.card-desc{font-size:14px;color:var(--muted);margin-bottom:1.5rem;line-height:1.6}
.field{margin-bottom:1rem}
.field label{display:block;font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px;font-family:'IBM Plex Mono',monospace}
.field input{width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:#0d1624;color:var(--text);font-size:14px;font-family:'IBM Plex Mono',monospace;outline:none;transition:.15s}
.field input:focus{border-color:var(--cyan);box-shadow:0 0 0 3px rgba(0,200,224,.12)}
.row{display:flex;gap:8px}
.row .field{flex:1}
.btn{padding:10px 22px;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;transition:.15s;border:none;letter-spacing:.3px}
.btn-primary{background:var(--cyan);color:#050a10}
.btn-primary:hover{opacity:.88}
.btn-primary:disabled{opacity:.35;cursor:default}
.btn-ghost{background:transparent;border:1px solid var(--border);color:var(--muted)}
.btn-ghost:hover{border-color:var(--text);color:var(--text)}
.btn-row{display:flex;justify-content:space-between;align-items:center;margin-top:1.5rem}
.steps-box{background:#0f1b2b;border:1px solid rgba(47,214,232,.13);border-radius:8px;padding:1.25rem;margin-bottom:1.25rem}
.steps-title{color:#2fd6e8;font-size:.8rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:1rem}
.steps-method{margin-bottom:1rem}
.steps-method:last-child{margin-bottom:0}
.steps-method-label{color:#9ca3af;font-size:.8rem;margin-bottom:.5rem;font-weight:500}
.code-block{background:#0a111c;border:1px solid rgba(47,214,232,.19);border-radius:4px;padding:.5rem .75rem;font-family:'IBM Plex Mono',monospace;font-size:.8rem;color:#2fd6e8;user-select:all;cursor:pointer}
.steps-note{color:#6b7280;font-size:.75rem;margin-top:.4rem}
.steps-list{color:#d1d5db;font-size:.82rem;padding-left:1.25rem;margin:0}
.steps-list li{margin-bottom:.35rem}
.steps-list strong{color:#f9fafb}
.steps-list code{background:#0a111c;padding:.1rem .3rem;border-radius:3px;font-size:.8rem;color:#2fd6e8}
.hint{font-size:12px;color:var(--muted)}
.detect-row{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);font-size:14px}
.detect-row:last-child{border:none}
.badge{display:inline-flex;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:600;font-family:'IBM Plex Mono',monospace}
.badge-ok{background:rgba(34,197,94,.12);color:var(--green);border:1px solid rgba(34,197,94,.25)}
.badge-warn{background:rgba(245,158,11,.12);color:var(--amber);border:1px solid rgba(245,158,11,.25)}
.badge-off{background:rgba(100,116,139,.1);color:var(--muted);border:1px solid var(--border)}
.badge-scan{background:rgba(0,200,224,.1);color:var(--cyan);border:1px solid rgba(0,200,224,.25)}
.node-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-top:1rem}
.node-card{background:#0d1624;border:1px solid var(--border);border-radius:8px;padding:10px 12px}
.node-name{font-size:13px;font-weight:600;font-family:'IBM Plex Mono',monospace;color:var(--cyan)}
.node-sub{font-size:11px;color:var(--muted);margin-top:2px}
.svc-card{border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;transition:.15s}
.svc-card:hover{border-color:#2e3f5c}
.svc-card.on{border-color:var(--cyan);background:rgba(0,200,224,.05)}
.svc-name{font-size:14px;font-weight:600}
.svc-detail{font-size:12px;color:var(--muted);font-family:'IBM Plex Mono',monospace;margin-top:2px}
.toggle{width:36px;height:20px;border-radius:10px;border:1px solid var(--border);background:#0d1624;position:relative;transition:.2s;flex-shrink:0}
.toggle.on{background:var(--cyan);border-color:var(--cyan)}
.toggle::after{content:'';position:absolute;width:14px;height:14px;border-radius:50%;background:#fff;top:2px;left:2px;transition:.2s}
.toggle.on::after{transform:translateX(16px)}
.err{color:var(--red);font-size:13px;margin-top:.75rem;padding:10px 12px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:8px;display:none}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(0,200,224,.3);border-top-color:var(--cyan);border-radius:50%;animation:spin .6s linear infinite;vertical-align:middle;margin-right:6px}
@keyframes spin{to{transform:rotate(360deg)}}
.link-row{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#0d1624;border-radius:8px;margin-bottom:8px;font-size:13px}
.link-url{font-family:'IBM Plex Mono',monospace;color:var(--cyan);font-size:12px}
.success-icon{width:52px;height:52px;border-radius:50%;background:rgba(34,197,94,.12);border:1.5px solid rgba(34,197,94,.3);display:flex;align-items:center;justify-content:center;font-size:22px;margin:0 auto 1.5rem}
</style>
</head>
<body>
<div class="wrap">
  <div class="logo">HYPER<span>PROX</span></div>
  <div class="tagline">Setup wizard — let's get your cluster connected</div>
  <div class="steps" id="steps"></div>
  <div id="wizard"></div>
</div>

<script>
const STEPS = ['Proxmox','Cluster','Services','Options','Done']
let cur = 0
const S = {
  proxmox:  { host:'', port:'8006', tokenId:'root@pam!hyperprox', tokenSecret:'', publicUrl:'' },
  cluster:  null,
  services: {},
  installs: { grafana: true, prometheus: true },
  providers:{ godaddy:{ enabled:false, key:'', secret:'' }, npm:{ enabled:false, host:'', port:'81' } },
  hw: null, answers: {}, login: { username:'root', password:'', privateKey:'' }, loginRows: null, apply: null, finish: null
}

function renderSteps(){
  document.getElementById('steps').innerHTML = STEPS.map((s,i) => {
    const done   = i < cur
    const active = i === cur
    const dc     = done ? 'done' : active ? 'active' : ''
    const lc     = i < cur-1 ? 'done' : ''
    const line   = i < STEPS.length-1 ? '<div class="line '+lc+'"></div>' : ''
    return '<div class="step"><div class="dot '+dc+'">'+(done?'✓':(i+1))+'</div>'+line+'</div>'
  }).join('')
}

function go(n){ cur = n; render() }

function setErr(id, msg){
  const el = document.getElementById(id)
  if(!el) return
  el.textContent = msg
  el.style.display = msg ? 'block' : 'none'
}
function escHtml(v){
  return String(v).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]))
}

// The installer prints the wizard link with the setup key (?k=...). It is kept for this tab only and
// taken out of the address bar, so it does not linger in history or get copied into a screenshot.
const SETUP_KEY = (function(){
  const q = new URLSearchParams(location.search).get('k')
  if (q) { try { sessionStorage.setItem('hpx-setup-key', q) } catch {} ; history.replaceState(null, '', location.pathname) }
  try { return q || sessionStorage.getItem('hpx-setup-key') || '' } catch { return q || '' }
})()

async function api(method, path, body){
  const r = await fetch(path, {
    method,
    headers:{ 'Content-Type':'application/json', 'X-Setup-Key': SETUP_KEY },
    body: body ? JSON.stringify(body) : undefined
  })
  if (r.status === 401) {
    document.body.innerHTML = '<div style="max-width:560px;margin:12vh auto;font:15px/1.6 system-ui;color:#e6edf3;background:#0a111c;padding:28px;border:1px solid #2fd6e8;border-radius:10px">' +
      '<h2 style="margin-top:0;color:#2fd6e8">Open the setup link from the installer</h2>' +
      '<p>For safety, the setup wizard only accepts requests that carry the setup key. Use the link the installer printed &mdash; it ends in <code>?k=&hellip;</code>.</p>' +
      '<p>Lost it? On the HyperProx host run:<br><code>grep SETUP_SECRET /opt/hyperprox/.env</code><br>and open <code>https://&lt;host&gt;/setup?k=&lt;that value&gt;</code>.</p></div>'
    throw new Error('setup key required')
  }
  return r.json()
}

// ── Step 0: Proxmox ───────────────────────────────────────────────────────────
function stepProxmox(){
  return \`<div class="card">
    <div class="eyebrow">Step 1 of 5</div>
    <div class="card-title">Connect your Proxmox</div>
    <div class="card-desc">Sign in with the same login you use for the Proxmox web interface. HyperProx creates its own access key from it — your password is used once and never stored.</div>
    <div class="field"><label>Proxmox address</label><input id="px-host" placeholder="192.168.1.100" value="\${S.proxmox.host}"><div class="field-hint">The address you open the Proxmox web interface with, without https:// or :8006.</div></div>
    <div class="field"><label>Username</label><input id="px-user" value="\${S.proxmox.username || 'root@pam'}"></div>
    <div class="field"><label>Password</label><input id="px-pass" type="password" autocomplete="current-password"></div>
    <div class="field" id="px-otp-wrap" style="display:\${S.proxmox.needTfa ? 'block' : 'none'}"><label>Two-factor code</label><input id="px-otp" inputmode="numeric" placeholder="6 digits"></div>
    <details class="adv">
      <summary>Advanced</summary>
      <div class="row"><div class="field"><label>Port</label><input id="px-port" value="\${S.proxmox.port}" style="width:90px"></div></div>
      <div class="field"><label>Public URL (optional — for consoles outside your network)</label><input id="px-pub" placeholder="https://pve.yourdomain.com" value="\${S.proxmox.publicUrl}"></div>
      <div class="field"><label>Already have an API token? Token ID</label><input id="px-tid" placeholder="root@pam!hyperprox" value="\${S.proxmox.tokenId}"></div>
      <div class="field"><label>Token secret</label><input id="px-sec" type="password" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value="\${S.proxmox.tokenSecret}"></div>
    </details>
    <div class="err" id="px-err"></div>
    <div class="btn-row">
      <span class="hint">Nothing is changed on your cluster except one new access key for HyperProx.</span>
      <button class="btn btn-primary" id="btn-px">Connect →</button>
    </div>
  </div>\`
}

// ── Step 1: Cluster info ──────────────────────────────────────────────────────
function stepCluster(){
  const c = S.cluster
  if(!c) return '<div class="card"><div class="card-title">Loading cluster info...</div></div>'
  const nodeCards = c.nodes.map(n =>
    \`<div class="node-card">
      <div class="node-name">\${n.node}</div>
      <div class="node-sub">\${n.maxcpu} vCPU · \${(n.maxmem/1073741824).toFixed(1)}GB</div>
      <div class="node-sub" style="color:\${n.status==='online'?'#22c55e':'#ef4444'}">\${n.status}</div>
    </div>\`).join('')
  return \`<div class="card">
    <div class="card-title">Cluster detected ✓</div>
    <div class="card-desc">HyperProx found your Proxmox cluster. Confirm the details look right before continuing.</div>
    <div class="detect-row"><span>Cluster name</span><span style="font-family:'IBM Plex Mono',monospace">\${c.name}</span><span class="badge badge-ok">online</span></div>
    <div class="detect-row"><span>Proxmox version</span><span style="font-family:'IBM Plex Mono',monospace">\${c.version}</span><span class="badge badge-ok">supported</span></div>
    <div class="detect-row"><span>Nodes</span><span style="font-family:'IBM Plex Mono',monospace">\${c.nodeCount} nodes</span><span class="badge \${c.quorate?'badge-ok':'badge-warn'}">\${c.quorate?'quorate':'no quorum'}</span></div>
    <div class="detect-row"><span>Running workloads</span><span style="font-family:'IBM Plex Mono',monospace">\${c.runningVms} VMs · \${c.runningCts} CTs</span><span class="badge badge-ok">✓</span></div>
    \${c.ceph ? \`<div class="detect-row"><span>CEPH storage</span><span style="font-family:'IBM Plex Mono',monospace">\${c.ceph.pools} pools</span><span class="badge \${c.ceph.healthy?'badge-ok':'badge-warn'}">\${c.ceph.healthy?'healthy':'degraded'}</span></div>\` : ''}
    <div class="node-grid">\${nodeCards}</div>
    \${S.hw ? '<div class="card-desc" style="margin:1rem 0 0" id="hw-summary">' + escHtml(S.hw.summary) + '</div>' : '<div class="field-hint" style="margin-top:1rem">Looking at the hardware on each node...</div>'}
    \${S.exporter && !S.exporter.ok ? \`<div class="field-hint" style="margin-top:.75rem">Proxmox metrics: the exporter's read-only token could not be made (\${escHtml(S.exporter.error)}). After setup, run <code>hyperprox pve-exporter</code> on this machine.</div>\` : ''}
    <div class="btn-row">
      <button class="btn btn-ghost" onclick="go(0)">← Back</button>
      <button class="btn btn-primary" id="btn-cluster-ok">Looks right →</button>
    </div>
  </div>\`
}

// ── Step 2: Services ──────────────────────────────────────────────────────────
function stepServices(){
  const svcs = S.services
  const inst = S.installs
  const cards = Object.values(svcs).length
    ? Object.values(svcs).map(s =>
        \`<div class="svc-card \${s.enabled?'on':''}" onclick="toggleSvc('\${s.key}')">
          <div>
            <div class="svc-name">\${s.name}</div>
            <div class="svc-detail">\${s.found ? s.detail : 'Not detected on this cluster'}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="badge \${s.found?'badge-ok':'badge-off'}">\${s.found?'found':'not found'}</span>
            <div class="toggle \${s.enabled?'on':''}"></div>
          </div>
        </div>\`
      ).join('')
    : '<div style="color:var(--muted);font-size:14px">No existing services detected.</div>'

  const installCards = [
    { key:'prometheus', name:'Prometheus',           desc:'Metrics collection — on this machine only, read through HyperProx' },
    { key:'grafana',    name:'Grafana',              desc:'Dashboards on the Monitoring page — for signed-in users only' },
  ].map(s => \`<div class="svc-card \${inst[s.key]?'on':''}" onclick="toggleInstall('\${s.key}')">
    <div>
      <div class="svc-name">\${s.name}</div>
      <div class="svc-detail">\${s.desc}</div>
    </div>
    <div class="toggle \${inst[s.key]?'on':''}"></div>
  </div>\`).join('')

  return \`<div class="card">
    <div class="card-title">Existing services</div>
    <div class="card-desc">HyperProx scanned your cluster. Enable what you want to manage, skip the rest — you can connect more later.</div>
    \${cards}
    <div class="card-title" style="margin-top:1.25rem">Do you want charts and dashboards (Prometheus and Grafana)?</div>
    <div class="card-desc">Runs Prometheus and Grafana on this machine. You reach them only through HyperProx.</div>
    \${installCards}
    <div class="field-hint" style="margin-top:.75rem">Need Nginx Proxy Manager? Install it from the <strong>Catalogue</strong> after setup: it gets a container of its own, with ports 80 and 443 to itself.</div>
    <div class="btn-row">
      <button class="btn btn-ghost" onclick="go(1)">← Back</button>
      <button class="btn btn-primary" id="btn-installs">Continue →</button>
    </div>
  </div>\`
}

// ── Step 3: Options — the installer's questions, then doing them ────────────
function qOn(id){ return S.answers[id] === true }
function anyNodeWork(){ return (S.hw && S.hw.questions || []).some(q => q.nodeWork && qOn(q.id)) }
function checkRows(rows){
  return (rows||[]).map(r => {
    const mark = (r.status==='done'||r.status==='already'||r.status==='ok') ? '<span class="badge badge-ok">done</span>'
      : r.status==='skipped' ? '<span class="badge badge-off">skipped</span>' : '<span class="badge badge-warn">failed</span>'
    return '<div class="detect-row"><span>' + escHtml((r.label||r.id||'') + (r.node ? ' · ' + r.node : '')) + '<br><span class="hint">' + escHtml(r.reason||'') + '</span></span>' + mark + '</div>'
  }).join('')
}
function stepProviders(){
  const hw = S.hw
  if(!hw) return '<div class="card"><div class="card-title">Looking at your nodes...</div></div>'
  const boot = hw.bootstrap
  let h = '<div class="card"><div class="eyebrow">Step 4 of 5</div><div class="card-title">A few questions</div>'
  h += '<div class="card-desc">' + escHtml(hw.summary) + ' HyperProx does each thing you say yes to, then checks that it worked.</div>'
  if (boot) h += '<div class="field-hint" style="margin-bottom:1rem">You answered these when you ran bootstrap.sh, which did the node work already:</div>' + checkRows(boot.results)
  for (const q of hw.questions) {
    if (q.id === 'charts') continue
    if (boot && q.id !== 'dns') continue
    if (q.id === 'proxmox-metrics' && S.exporter && S.exporter.ok) {
      h += '<div class="detect-row"><span>' + escHtml(q.ask) + '<br><span class="hint">Done: made when you connected.</span></span><span class="badge badge-ok">done</span></div>'
      continue
    }
    const on = qOn(q.id)
    h += '<div class="q" style="padding:12px 0;border-bottom:1px solid var(--border)">'
      + '<div class="svc-name">' + escHtml(q.ask) + '</div><div class="hint" style="margin:4px 0 8px">' + escHtml(q.what) + '</div>'
      + (q.notes||[]).map(n => '<div class="hint" style="color:var(--amber)">' + escHtml(n) + '</div>').join('')
      + '<div style="display:flex;gap:8px;margin-top:6px"><button class="btn ' + (on?'btn-primary':'btn-ghost') + '" data-q="' + q.id + '" data-v="1">Yes</button>'
      + '<button class="btn ' + (!on?'btn-primary':'btn-ghost') + '" data-q="' + q.id + '" data-v="0">No</button></div>'
    if (q.id === 'dns' && on) {
      h += (S.providers.godaddy.saved ? '<div class="field-hint">A key is already held. Leave these empty to keep it.</div>' : '')
        + '<div class="field" style="margin-top:.75rem"><label>GoDaddy API key</label><input id="gd-key" autocomplete="off"></div>'
        + '<div class="field"><label>API secret</label><input id="gd-sec" type="password" autocomplete="off"></div>'
        + '<div class="field-hint">A Production key from developer.godaddy.com/keys. It is checked now, then kept in the vault.</div>'
    }
    h += '</div>'
  }
  if (!boot && anyNodeWork()) {
    h += '<div style="margin-top:1.25rem"><div class="svc-name">Sign in to your nodes, once</div>'
      + '<div class="hint" style="margin:4px 0 10px">To set these up, HyperProx signs in to each node. Use the login you use for SSH, usually root. It is tested on every node now, kept only in memory until you create the owner account, and then kept in the vault. It is never written to a file.</div>'
      + '<div class="row"><div class="field"><label>User</label><input id="nl-user" value="' + escHtml(S.login.username) + '"></div>'
      + '<div class="field"><label>Password</label><input id="nl-pass" type="password" autocomplete="off"></div></div>'
      + '<details class="adv"><summary>Use a private key instead</summary><div class="field"><label>Private key</label><textarea id="nl-key" rows="4" style="width:100%;background:#0d1624;color:var(--text);border:1px solid var(--border);border-radius:8px;font-family:IBM Plex Mono,monospace;font-size:12px"></textarea></div></details>'
      + (S.loginRows ? checkRows(S.loginRows.map(r => ({ label: 'Login', node: r.node, status: r.ok ? 'ok' : 'failed', reason: r.reason }))) : '')
      + '</div>'
  }
  if (S.apply) {
    h += '<div style="margin-top:1.25rem"><div class="svc-name">' + (S.apply.status === 'running' ? '<span class="spinner"></span>Setting up your nodes, one at a time...' : 'What was done') + '</div>'
      + checkRows(S.apply.results) + checkRows((S.apply.checks||[]).map(c => ({ label: 'Check', node: c.node, status: c.status, reason: c.reason }))) + '</div>'
  }
  const ready = !anyNodeWork() || boot || (S.apply && S.apply.status !== 'running')
  h += '<div class="err" id="prov-err"></div><div class="btn-row"><button class="btn btn-ghost" onclick="go(2)">← Back</button>'
    + (ready ? '<button class="btn btn-primary" id="btn-prov">Finish setup →</button>' : '<button class="btn btn-primary" id="btn-apply">Set it up →</button>')
    + '</div></div>'
  return h
}

// ── Step 4: Done ──────────────────────────────────────────────────────────────
// Served through nginx (https://<host>/setup) the app is on this same origin. An older install that
// still opens the wizard on :3001 has the app on :3000.
const APP = location.port === '3001' ? 'http://' + location.hostname + ':3000' : location.origin

function stepDone(){
  const ip  = location.hostname
  return \`<div class="card" style="text-align:center">
    <div class="success-icon">✓</div>
    <div class="card-title" style="margin-bottom:.5rem">Cluster connected</div>
    \${S.finish ? '<div style="text-align:left;margin-bottom:1rem">' + checkRows(S.finish.checklist) + '</div>' : ''}
    <div class="card-desc" style="margin-bottom:1rem">One step left: <strong>create the owner vault account</strong>. Open HyperProx and you will land on the sign-in page, which offers to create it. Choose an email and a master password, then scan the QR code with an authenticator app.</div>
    <div class="card-desc" style="margin-bottom:1.5rem">Two-factor authentication is required for the owner. The master password unlocks HyperProx and is never stored, so keep it safe: this release has no password recovery.</div>
    <div class="link-row"><span style="color:var(--muted)">Create owner</span><span class="link-url">\${APP}/login</span></div>
    <div class="link-row"><span style="color:var(--muted)">Grafana</span><span class="link-url">\${location.port === '3001' ? 'https://' + ip : APP}/grafana/ (after you sign in)</span></div>
    <div style="margin-top:1.5rem">
      <a href="\${APP}/login" style="display:block">
        <button class="btn btn-primary" style="width:100%;font-size:16px">Create the owner account →</button>
      </a>
    </div>
  </div>\`
}

// =============================================================================
// Render + bind
// =============================================================================

const renderers = [stepProxmox, stepCluster, stepServices, stepProviders, stepDone]

function render(){
  renderSteps()
  document.getElementById('wizard').innerHTML = renderers[cur]()
  bind()
}

function bind(){
  // Step 0 — test proxmox
  const btnPx = document.getElementById('btn-px')
  if(btnPx) btnPx.onclick = async () => {
    const v = id => (document.getElementById(id)?.value || '').trim()
    const host = v('px-host'), port = v('px-port') || '8006', pub = v('px-pub')
    const user = v('px-user') || 'root@pam', pass = document.getElementById('px-pass').value, otp = v('px-otp')
    const tid = v('px-tid'), sec = v('px-sec')
    if(!host){ setErr('px-err','Enter your Proxmox address.'); return }
    if(!pass && !(tid && sec)){ setErr('px-err','Enter your Proxmox password.'); return }
    btnPx.disabled = true
    btnPx.innerHTML = '<span class="spinner"></span>Connecting...'
    setErr('px-err','')
    let res
    if(pass){
      res = await api('POST','/api/setup/connect-proxmox',{ host, port, username:user, password:pass, otp, publicUrl:pub })
    } else {
      res = await api('POST','/api/setup/test-proxmox',{ host, port, tokenId:tid, tokenSecret:sec })
      if(res.ok){
        const saved = await api('POST','/api/setup/save-proxmox',{ host, port, tokenId:tid, tokenSecret:sec, publicUrl:pub, cephMonNode: res.cluster.cephMonNode || '' })
        res.exporter = saved.exporter
      }
    }
    if(res.ok){
      Object.assign(S.proxmox, { host, port, username:user, publicUrl:pub, tokenId: res.tokenId || tid, tokenSecret:'' })
      S.cluster = res.cluster
      S.exporter = res.exporter || null
      go(1)
      loadHardware()
    } else {
      if(res.needTfa){ S.proxmox.needTfa = true; document.getElementById('px-otp-wrap').style.display = 'block'; document.getElementById('px-otp').focus() }
      setErr('px-err', res.error || 'Could not connect')
      btnPx.disabled = false
      btnPx.textContent = 'Connect →'
    }
  }

  // Step 1 - cluster confirmed: scan for existing services, then move on
  const btnCl = document.getElementById('btn-cluster-ok')
  if(btnCl) btnCl.onclick = () => {
    if(!S.hw) loadHardware()
    btnCl.disabled = true
    btnCl.innerHTML = '<span class="spinner"></span>Scanning...'
    go(2)
    // Scan with hard 8s client timeout - auto-advance if hung
    const scanDone = new Promise(resolve => {
      api('GET','/api/setup/scan-services').then(r => {
        if(r.ok && r.services){
          S.services = {}
          r.services.forEach(s => { S.services[s.key] = { ...s, enabled: s.found } })
        }
        resolve()
      }).catch(() => resolve())
    })
    const scanTimeout = new Promise(resolve => setTimeout(resolve, 8000))
    Promise.race([scanDone, scanTimeout]).then(() => render())
  }

  // Step 2 — save installs
  const btnInst = document.getElementById('btn-installs')
  if(btnInst) btnInst.onclick = async () => {
    btnInst.disabled = true
    btnInst.innerHTML = '<span class="spinner"></span>Saving...'
    await api('POST','/api/setup/save-installs', { installs: S.installs })
    go(3)
  }

  // Step 3 — yes/no answers
  document.querySelectorAll('[data-q]').forEach(b => { b.onclick = () => { keepFields(); S.answers[b.dataset.q] = b.dataset.v === '1'; render() } })

  const btnApply = document.getElementById('btn-apply')
  if(btnApply) btnApply.onclick = async () => {
    keepFields()
    setErr('prov-err','')
    if(!(await saveDns())) return
    btnApply.disabled = true
    btnApply.innerHTML = '<span class="spinner"></span>Testing the login on each node...'
    const t = await api('POST','/api/setup/node-login', { username: S.login.username, password: S.login.password, privateKey: S.login.privateKey })
    S.login.password = ''; S.login.privateKey = ''
    S.loginRows = t.nodes || null
    if(!t.ok){ render(); setErr('prov-err', t.error || 'That login did not work on any node.'); return }
    await api('POST','/api/setup/apply', { answers: S.answers })
    S.apply = { status: 'running', results: [], checks: [] }
    render()
    for(let i = 0; i < 600; i++){
      await new Promise(r => setTimeout(r, 1500))
      const st = await api('GET','/api/setup/apply-status')
      if(st.ok){ S.apply = st.job; render() }
      if(st.ok && st.job.status !== 'running') break
    }
  }

  const btnProv = document.getElementById('btn-prov')
  if(btnProv) btnProv.onclick = async () => {
    keepFields()
    setErr('prov-err','')
    if(!(await saveDns())) return
    btnProv.disabled = true
    btnProv.innerHTML = '<span class="spinner"></span>Finishing...'
    const res = await api('POST','/api/setup/complete',{ answers: S.answers })
    if(!res.ok){
      setErr('prov-err', (res.errors || [res.error]).join(' '))
      btnProv.disabled = false; btnProv.textContent = 'Finish setup →'; return
    }
    for(let i = 0; i < 120; i++){
      await new Promise(r => setTimeout(r, 1500))
      let st = null
      try { st = await api('GET','/api/setup/finish-status') } catch {}
      if(st && st.ok && st.finish){ S.finish = st.finish; if(st.finish.status !== 'running') break }
    }
    go(4)
  }
}

function keepFields(){
  const v = id => { const el = document.getElementById(id); return el ? el.value : null }
  if(v('nl-user') !== null) S.login.username = v('nl-user').trim() || 'root'
  if(v('nl-pass')) S.login.password = v('nl-pass')
  if(v('nl-key')) S.login.privateKey = v('nl-key')
  if(v('gd-key') !== null){ S.providers.godaddy.key = v('gd-key').trim(); S.providers.godaddy.secret = v('gd-sec') || '' }
}
// A GoDaddy key is checked and held in the wizard's memory; it never goes into a file.
async function saveDns(){
  const gd = S.providers.godaddy
  if(!qOn('dns') || (!gd.key && gd.saved)) return true
  if(!gd.key || !gd.secret){ setErr('prov-err','Paste the GoDaddy API key and secret, or answer No.'); return false }
  const r = await api('POST','/api/setup/save-providers',{ providers: { godaddy: { enabled: true, key: gd.key, secret: gd.secret } } })
  gd.key = ''; gd.secret = ''
  if(!r.ok){ setErr('prov-err', r.error || 'GoDaddy did not accept that key.'); return false }
  gd.saved = true
  return true
}

function toggleSvc(key){
  if(S.services[key]) S.services[key].enabled = !S.services[key].enabled
  render()
}
function toggleInstall(key){
  S.installs[key] = !S.installs[key]
  render()
}
function toggleProv(key){
  S.providers[key].enabled = !S.providers[key].enabled
  render()
}

// Resume from what the server already knows: a reload, or the link opened again tomorrow, lands on the
// step the setup actually reached instead of step 1.
async function init(){
  document.getElementById('wizard').innerHTML = '<div class="card"><div class="card-title">Loading...</div></div>'
  let st = null
  try { st = await api('GET','/api/setup/state') } catch (e) {
    if (String(e && e.message).includes('setup key')) return   // the key page is already showing
  }
  if (st && st.ok) {
    Object.assign(S.proxmox, st.proxmox)
    S.cluster = st.cluster
    if (st.installs) S.installs = st.installs
    if (st.providers && st.providers.godaddy && st.providers.godaddy.enabled) Object.assign(S.providers.godaddy, { enabled: true, saved: true })
    cur = st.step
  }
  render()
  if (st && st.error) setErr('px-err', st.error)
  if (cur >= 1) loadHardware()
}

async function loadHardware(){
  try {
    const r = await api('GET','/api/setup/hardware')
    if(r.ok){
      S.hw = r
      for (const q of r.questions) if (!(q.id in S.answers)) S.answers[q.id] = q.default
      if (r.held && r.held.godaddy) S.providers.godaddy.saved = true
      render()
    }
  } catch {}
}

init()
</script>
</body>
</html>`

// =============================================================================
// The installer's questions: context, answers, finishing
// =============================================================================

/** Proxmox, the online nodes and their addresses, from the token in .env (pre-vault, setup only). */
async function clusterCtx() {
  const env = readEnv()
  if (!env.PROXMOX_HOST || !env.PROXMOX_TOKEN_SECRET) return null
  const tid = `${env.PROXMOX_USER}!${env.PROXMOX_TOKEN_ID}`
  const pve = p => pveRequest(env.PROXMOX_HOST, env.PROXMOX_PORT || '8006', tid, env.PROXMOX_TOKEN_SECRET, p)
  const nodes = ((await pve('/nodes').catch(() => [])) || []).filter(n => !n.status || n.status === 'online').map(n => n.node).sort()
  const addrs = {}
  for (const r of (await pve('/cluster/status').catch(() => [])) || []) if (r && r.type === 'node' && r.name && r.ip) addrs[r.name] = r.ip
  return { pve, nodes, addrs }
}

/** How node scripts run: over SSH, or (tests) a stand-in named by HPX_SETUP_NODE_RUNNER. */
function nodeRunner() {
  if (process.env.HPX_SETUP_NODE_RUNNER) return require(process.env.HPX_SETUP_NODE_RUNNER)
  return onboard.sshRun
}

function sanitizeAnswers(a) {
  const out = {}
  for (const q of onboard.hw.QUESTIONS) if (a && typeof a[q.id] === 'boolean') out[q.id] = a[q.id]
  return out
}

/** Commands that change this machine: docker compose, systemctl. HPX_SETUP_RUN names a stand-in (tests). */
function runCmd(cmd) {
  return new Promise(resolve => {
    const full = process.env.HPX_SETUP_RUN ? `${process.env.HPX_SETUP_RUN} ${cmd}` : cmd
    exec(full, { cwd: HPX_DIR, timeout: 15 * 60_000 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') }))
  })
}

let finish = null

/**
 * Finish: record the choices, write Prometheus's lists from what was found, start the chosen services,
 * check the outcome in Prometheus, restart HyperProx, hand the held secrets to it, then remove the setup
 * key from .env and exit. Every step adds a line to the checklist the Done page shows.
 */
async function finishSetup(answers) {
  const list = finish.checklist
  const add = (label, status, reason) => list.push({ label, status, reason })
  const env = readEnv()

  const ai = answers.ai === true
  writeEnv({ SETUP_COMPLETE: 'true', INSTALL_OLLAMA: ai ? 'true' : 'false', ...(ai ? { OLLAMA_URL: 'http://127.0.0.1:11434', OLLAMA_MODEL: onboard.hw.AI_MODEL } : {}) })
  const profiles = composeProfiles(readEnv()).split(',').filter(Boolean)
  if (ai) profiles.push('ai')
  writeEnv({ COMPOSE_PROFILES: profiles.join(',') })

  const ctx = await clusterCtx().catch(() => null)
  const nodes = onboard.job.nodes.length ? onboard.job.nodes : ctx ? await onboard.detectFromProxmox(ctx.pve, ctx.nodes, ctx.addrs) : []
  try {
    onboard.writeTargets(path.join(HPX_DIR, 'config/prometheus/targets'), nodes, ctx ? ctx.addrs : {})
    add('Metrics list', 'done', `${nodes.length} node(s), with their GPUs; kept up to date by HyperProx from now on`)
  } catch (e) { add('Metrics list', 'failed', e.message) }

  const up = await runCmd('docker compose up -d --remove-orphans')
  add('Services', up.ok ? 'done' : 'failed', up.ok ? (profiles.length ? `started: ${profiles.join(', ')}` : 'started') : up.out.trim().split('\n').pop())

  if (ai && up.ok) {
    // About 2 GB: started in the background, and shown done on Settings → Setup checklist once it is there.
    const pull = `bash -c 'for i in $(seq 1 30); do docker exec hyperprox-ollama ollama list >/dev/null 2>&1 && break; sleep 2; done; docker exec hyperprox-ollama ollama pull ${onboard.hw.AI_MODEL}'`
    const child = require('child_process').spawn('bash', ['-c', process.env.HPX_SETUP_RUN ? `${process.env.HPX_SETUP_RUN} ${pull}` : pull], { detached: true, stdio: 'ignore' })
    child.unref()
    add('Local AI', 'done', `Ollama started; ${onboard.hw.AI_MODEL} is downloading (about 2 GB)`)
  }

  // Check in Prometheus, not the scripts' word. It scrapes every 15 s; give it a minute.
  const monitoring = profiles.includes('monitoring')
  if (monitoring && Object.keys(answers).some(k => ['node-health', 'power', 'gpu'].includes(k) && answers[k])) {
    await runCmd('curl -fsS -X POST http://127.0.0.1:9090/-/reload')
    let checks = []
    const deadline = Date.now() + Number(process.env.HPX_SETUP_VERIFY_MS || 75_000)
    do {
      checks = await onboard.hw.verifyOutcome(answers, nodes, onboard.promQuery())
      if (checks.every(c => c.status === 'ok')) break
      await new Promise(r => setTimeout(r, 5000))
    } while (Date.now() < deadline)
    for (const c of checks) add(`Prometheus: ${c.id}`, c.status === 'ok' ? 'done' : c.status === 'waiting' ? 'skipped' : 'failed', `${c.node ? c.node + ': ' : ''}${c.reason}`)
  }

  const rs = await runCmd('systemctl restart hyperprox-api hyperprox-frontend')
  if (!rs.ok) add('Restart', 'failed', rs.out.trim().split('\n').pop())
  for (let i = 0; i < 60; i++) {
    if (await onboard.getText(`http://127.0.0.1:${API_PORT}/health`, 2000)) break
    await new Promise(r => setTimeout(r, 1000))
  }
  const held = onboard.heldSummary()
  if (held.nodeLogin || held.godaddy) {
    const h = await onboard.handOff(API_PORT, setupSecret())
    const what = [held.nodeLogin ? 'the node login' : '', held.godaddy ? 'the GoDaddy key' : ''].filter(Boolean).join(' and ')
    add('Your keys', h.ok ? 'done' : 'failed', h.ok ? `${what}: held by HyperProx until you create the owner account, then kept in the vault`
      : `${what} could not be handed over (${h.error}); add them under Settings → Setup checklist`)
  }
  // The setup key has done its job. It is not kept: re-running install.sh makes a new one if ever needed.
  removeEnv(['SETUP_SECRET'])
  finish.status = list.some(r => r.status === 'failed') ? 'done-with-problems' : 'done'
  setTimeout(() => { console.log('[setup] Complete. Shutting down setup service.'); process.exit(0) }, Number(process.env.HPX_SETUP_EXIT_MS || 30_000)).unref()
}

// =============================================================================
// HTTP Server
// =============================================================================

/**
 * The setup key, from .env; generated (and logged) if an older install never had one. Read once and kept
 * in memory: when setup completes it is removed from .env, and the last few requests still need it.
 */
let SETUP_KEY_MEM = ''
function setupSecret() {
  if (SETUP_KEY_MEM) return SETUP_KEY_MEM
  let secret = readEnv().SETUP_SECRET || process.env.SETUP_SECRET || ''
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex')
    writeEnv({ SETUP_SECRET: secret })
    console.log('[setup] generated a setup key - open the wizard at http://<host>:' + PORT + '/?k=' + secret)
  }
  SETUP_KEY_MEM = secret
  return secret
}

/** Constant-time comparison of the X-Setup-Key header with the setup key. */
function setupKeyOk(req) {
  const given = String(req.headers['x-setup-key'] || '')
  if (!given) return false
  const a = crypto.createHash('sha256').update(given).digest()
  const b = crypto.createHash('sha256').update(setupSecret()).digest()
  return crypto.timingSafeEqual(a, b)
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}) } catch { reject(new Error('Invalid JSON')) }
    })
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  // No CORS headers, deliberately. The wizard is served by this server and calls it same-origin, so it
  // needs none; `Access-Control-Allow-Origin: *` let any web page the owner visited during setup drive
  // these routes from the owner's own browser (security review, 2026-10-18).
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  const url = req.url.split('?')[0]

  // ── Serve wizard UI ─────────────────────────────────────────────────────────
  if (req.method === 'GET' && (url === '/' || url === '/setup')) {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end(WIZARD_HTML)
  }

  // ── Health ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/health') {
    return sendJson(res, 200, { status: 'ok' })
  }

  // ── API routes ──────────────────────────────────────────────────────────────
  if (!url.startsWith('/api/setup/')) {
    return sendJson(res, 404, { error: 'Not found' })
  }

  let body = {}
  try { body = await readBody(req) } catch { return sendJson(res, 400, { error: 'Invalid JSON' }) }

  // Every setup route needs the setup key. They configure the Proxmox connection and create the only
  // admin login, and this server listens on all interfaces until setup finishes: without the key,
  // anyone who could reach it — or any page the owner opened meanwhile — could replace the admin or
  // repoint Proxmox. The installer generates the key and prints it in the wizard link.
  if (!setupKeyOk(req)) {
    return sendJson(res, 401, { error: 'setup_key_required', message: 'Open the setup link printed by the installer (it ends in ?k=...).' })
  }

  const route = url.replace('/api/setup/', '')

  try {
    // ── state: what the wizard already knows, so a reload resumes instead of starting over ──
    // Secrets never leave: the token secret and provider keys are reported as present or not.
    if (req.method === 'GET' && route === 'state') {
      const env = readEnv()
      const fullTokenId = env.PROXMOX_USER && env.PROXMOX_TOKEN_ID ? `${env.PROXMOX_USER}!${env.PROXMOX_TOKEN_ID}` : ''
      let cluster = null, error = null
      if (env.PROXMOX_HOST && fullTokenId && env.PROXMOX_TOKEN_SECRET) {
        try { cluster = await testProxmox(env.PROXMOX_HOST, env.PROXMOX_PORT || '8006', fullTokenId, env.PROXMOX_TOKEN_SECRET) }
        catch { error = `The saved connection to ${env.PROXMOX_HOST} no longer works. Sign in again to renew HyperProx's access key.` }
      }
      const step = resumeStep(env, Boolean(cluster))
      const installs = 'INSTALL_PROMETHEUS' in env
        ? { grafana: env.INSTALL_GRAFANA === 'true', prometheus: env.INSTALL_PROMETHEUS === 'true' }
        : null
      return sendJson(res, 200, {
        ok: true, step, cluster, error, installs,
        proxmox: { host: env.PROXMOX_HOST || '', port: env.PROXMOX_PORT || '8006', username: env.PROXMOX_USER || 'root@pam',
                   tokenId: fullTokenId, publicUrl: env.PROXMOX_PUBLIC_URL || '' },
        providers: { godaddy: { enabled: env.GODADDY_ENABLED === 'true' || onboard.heldSummary().godaddy } },
      })
    }

    // ── test-proxmox ──────────────────────────────────────────────────────────
    if (req.method === 'POST' && route === 'test-proxmox') {
      const { host, port = '8006', tokenId, tokenSecret } = body
      if (!host || !tokenId || !tokenSecret) return sendJson(res, 400, { error: 'host, tokenId, and tokenSecret are required' })
      try {
        const cluster = await testProxmox(host, port, tokenId, tokenSecret)
        return sendJson(res, 200, { ok: true, cluster })
      } catch (err) {
        let error = err.message
        if (error.includes('ECONNREFUSED'))  error = `Cannot reach ${host}:${port} — check the host and port.`
        if (error.includes('401') || error.includes('403')) error = 'Authentication failed — check your API token.'
        if (error.includes('timed out'))     error = `Connection timed out — is ${host} reachable?`
        return sendJson(res, 400, { ok: false, error })
      }
    }

    // ── connect-proxmox: sign in with the Proxmox login; the wizard makes the token itself ──
    if (req.method === 'POST' && route === 'connect-proxmox') {
      const { host, port = '8006', username = 'root@pam', password, otp, publicUrl } = body
      if (!host || !password) return sendJson(res, 400, { error: 'The Proxmox address and password are required.' })
      try {
        const { tokenId, tokenSecret, cluster, exporter: exp } = await connectWithLogin(host, port, username, password, otp, heldToken(readEnv(), host, port))
        const [proxmoxUser, proxmoxTokenId] = tokenId.split('!')
        writeEnv({
          PROXMOX_HOST: host, PROXMOX_PORT: port, PROXMOX_USER: proxmoxUser, PROXMOX_TOKEN_ID: proxmoxTokenId,
          PROXMOX_TOKEN_SECRET: tokenSecret, CEPH_MON_NODE: '', ...(publicUrl ? { PROXMOX_PUBLIC_URL: publicUrl } : {}),
        })
        return sendJson(res, 200, { ok: true, cluster, tokenId, exporter: exp })
      } catch (err) {
        let error = err.message
        if (err.needTfa) return sendJson(res, 400, { ok: false, needTfa: true, error })
        if (error.includes('ECONNREFUSED') || error.includes('ENOTFOUND') || error.includes('EHOSTUNREACH')) error = `Cannot reach ${host}:${port}. Use the same address you open the Proxmox web interface with.`
        else if (error.includes('timed out')) error = `No answer from ${host}:${port}. Is that the Proxmox address?`
        else if (err.status === 401) error = 'Proxmox did not accept that username and password.'
        else if (err.status === 403) error = 'That account is not allowed to create API tokens. Use root@pam or an administrator account.'
        return sendJson(res, 400, { ok: false, error })
      }
    }

    // ── save-proxmox ──────────────────────────────────────────────────────────
    if (req.method === 'POST' && route === 'save-proxmox') {
      const { host, port = '8006', tokenId, tokenSecret, publicUrl } = body
      const [proxmoxUser, proxmoxTokenId] = tokenId.includes('!') ? tokenId.split('!') : ['root@pam', tokenId]
      // Deliberately empty. The API detects a monitor at runtime and re-detects
      // when a node goes down; pinning it here freezes a moving fact into config
      // — even a correct detection expires at the next reboot. CEPH_MON_NODE
      // stays supported as a manual override for operators who want one.
      const cephMon = ''
      writeEnv({
        PROXMOX_HOST:         host,
        PROXMOX_PORT:         port,
        PROXMOX_USER:         proxmoxUser,
        PROXMOX_TOKEN_ID:     proxmoxTokenId,
        PROXMOX_TOKEN_SECRET: tokenSecret,
        CEPH_MON_NODE:        cephMon,
        ...(publicUrl ? { PROXMOX_PUBLIC_URL: publicUrl } : {}),
      })
      // A pasted token makes the exporter's read-only one too, if it may (it needs User.Modify and
      // Permissions.Modify; a token without them gets a hint to run `hyperprox pve-exporter` later).
      const pve = pveAdapter(host, port, { token: `PVEAPIToken=${proxmoxUser}!${proxmoxTokenId}=${tokenSecret}` }, proxmoxUser)
      const exp = await setupExporterSafely(pve, proxmoxUser, proxmoxTokenId)
      return sendJson(res, 200, { ok: true, exporter: exp })
    }

    // The wizard no longer creates an admin account: HyperProx has no password of its own. The owner
    // account is created in the vault from HyperProx's /login page after setup (404 for the old route).

    // ── scan-services ─────────────────────────────────────────────────────────
    if (req.method === 'GET' && route === 'scan-services') {
      const env = readEnv()
      const hosts = new Set()
      if (env.PROXMOX_HOST) hosts.add(env.PROXMOX_HOST)

      try {
        const fullTokenId = env.PROXMOX_USER + '!' + env.PROXMOX_TOKEN_ID
        // Get all running CTs and VMs across cluster
        const resources = await pveRequest(env.PROXMOX_HOST, env.PROXMOX_PORT || '8006',
          fullTokenId, env.PROXMOX_TOKEN_SECRET, '/cluster/resources?type=vm')

        await Promise.all(resources
          .filter(r => r.status === 'running')
          .map(async r => {
            try {
              if (r.type === 'lxc') {
                // LXC: IP is in config net0 field
                const cfg = await pveRequest(env.PROXMOX_HOST, env.PROXMOX_PORT || '8006',
                  fullTokenId, env.PROXMOX_TOKEN_SECRET, `/nodes/${r.node}/lxc/${r.vmid}/config`)
                for (const [k, v] of Object.entries(cfg)) {
                  if (k.startsWith('net') && typeof v === 'string') {
                    const m = v.match(/ip=([\d.]+)/)
                    if (m) hosts.add(m[1])
                  }
                }
              } else if (r.type === 'qemu') {
                // VM: try guest agent first, fall back to config
                try {
                  const ifaces = await pveRequest(env.PROXMOX_HOST, env.PROXMOX_PORT || '8006',
                    fullTokenId, env.PROXMOX_TOKEN_SECRET,
                    `/nodes/${r.node}/qemu/${r.vmid}/agent/network-get-interfaces`)
                  for (const iface of (ifaces.result || [])) {
                    for (const addr of (iface['ip-addresses'] || [])) {
                      if (addr['ip-address-type'] === 'ipv4' && !addr['ip-address'].startsWith('127.')) {
                        hosts.add(addr['ip-address'])
                      }
                    }
                  }
                } catch {
                  // No guest agent — try config for static IP
                  const cfg = await pveRequest(env.PROXMOX_HOST, env.PROXMOX_PORT || '8006',
                    fullTokenId, env.PROXMOX_TOKEN_SECRET, `/nodes/${r.node}/qemu/${r.vmid}/config`)
                  for (const [k, v] of Object.entries(cfg)) {
                    if (k.startsWith('net') && typeof v === 'string') {
                      const m = v.match(/ip=([\d.]+)/)
                      if (m) hosts.add(m[1])
                    }
                  }
                }
              }
            } catch {}
          })
        )
      } catch (e) {
        console.error('[scan] failed to harvest IPs:', e.message)
      }

      console.log('[scan] probing hosts:', [...hosts])
      const scanTimeout = new Promise(resolve => setTimeout(() => resolve([]), 20000))
      const services = await Promise.race([scanServices([...hosts]), scanTimeout])
      return sendJson(res, 200, { ok: true, services })
    }

    // ── save-installs ─────────────────────────────────────────────────────────
    if (req.method === 'POST' && route === 'save-installs') {
      const { installs = {} } = body
      writeEnv({
        INSTALL_GRAFANA:    installs.grafana    ? 'true' : 'false',
        INSTALL_PROMETHEUS: installs.prometheus ? 'true' : 'false',
      })
      return sendJson(res, 200, { ok: true })
    }

    // ── save-providers ────────────────────────────────────────────────────────
    if (req.method === 'POST' && route === 'save-providers') {
      const { providers = {} } = body
      const updates = {}
      // A GoDaddy key is a secret: checked, then held in memory only, and handed to the vault when setup
      // completes (onboarding.js). It is never written to .env.
      const gd = providers.godaddy
      if (gd && gd.enabled && gd.key && gd.secret) {
        const t = await (process.env.HPX_SETUP_FAKE_GODADDY ? Promise.resolve({ ok: gd.key !== 'bad' }) : onboard.testGodaddy(gd.key, gd.secret))
        if (!t.ok) return sendJson(res, 400, { ok: false, error: t.error || 'GoDaddy did not accept that key.' })
        onboard.holdGodaddy(gd.key, gd.secret)
      }
      const npm = providers.npm
      if (npm && npm.enabled) {
        if (npm.host) updates.NPM_HOST = npm.host
        if (npm.port) updates.NPM_PORT = npm.port
        updates.NPM_ENABLED = 'true'
      }
      if (Object.keys(updates).length) writeEnv(updates)
      return sendJson(res, 200, { ok: true })
    }

    // ── hardware: what each node has, and the questions that apply ────────────
    if (req.method === 'GET' && route === 'hardware') {
      const ctx = await clusterCtx()
      if (!ctx) return sendJson(res, 400, { ok: false, error: 'Connect your Proxmox first.' })
      const nodes = onboard.job.nodes.length ? onboard.job.nodes : await onboard.detectFromProxmox(ctx.pve, ctx.nodes, ctx.addrs)
      const env = readEnv()
      const questions = onboard.hw.applicableQuestions(nodes, { charts: env.INSTALL_PROMETHEUS !== 'false' })
      return sendJson(res, 200, { ok: true, summary: onboard.hw.summarise(nodes), nodes, questions,
        bootstrap: onboard.bootstrapAnswers(HPX_DIR), held: onboard.heldSummary() })
    }

    // ── node-login: asked once, tested on every node, held in memory only ─────
    if (req.method === 'POST' && route === 'node-login') {
      const ctx = await clusterCtx()
      if (!ctx) return sendJson(res, 400, { ok: false, error: 'Connect your Proxmox first.' })
      const r = await onboard.testNodeLogin(body, ctx.nodes, ctx.addrs, nodeRunner())
      return sendJson(res, 200, r)
    }

    // ── apply: carry out the node answers, one node at a time ─────────────────
    if (req.method === 'POST' && route === 'apply') {
      const ctx = await clusterCtx()
      if (!ctx) return sendJson(res, 400, { ok: false, error: 'Connect your Proxmox first.' })
      const answers = sanitizeAnswers(body.answers)
      void onboard.applyAnswers(answers, ctx, nodeRunner())
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'GET' && route === 'apply-status') {
      const j = onboard.job
      return sendJson(res, 200, { ok: true, job: { status: j.status, results: j.results, checks: j.checks, summary: j.summary } })
    }

    // ── hold-secrets: bootstrap.sh hands over a GoDaddy key on stdin ──────────
    if (req.method === 'POST' && route === 'hold-secrets') {
      const gd = body.godaddy
      if (!gd || !gd.key || !gd.secret) return sendJson(res, 400, { ok: false, error: 'Nothing to hold.' })
      onboard.holdGodaddy(gd.key, gd.secret)
      return sendJson(res, 200, { ok: true, held: onboard.heldSummary() })
    }

    if (req.method === 'GET' && route === 'finish-status') {
      return sendJson(res, 200, { ok: true, finish })
    }

    // ── complete ──────────────────────────────────────────────────────────────
    if (req.method === 'POST' && route === 'complete') {
      const env = readEnv()
      const errors = []
      if (!env.PROXMOX_HOST || !env.PROXMOX_TOKEN_SECRET) errors.push('Proxmox not configured')
      if (errors.length) return sendJson(res, 400, { ok: false, errors })
      if (finish && finish.status === 'running') return sendJson(res, 200, { ok: true })
      const answers = { ...(onboard.bootstrapAnswers(HPX_DIR) || {}).answers, ...sanitizeAnswers(body.answers) }
      finish = { status: 'running', checklist: [] }
      sendJson(res, 200, { ok: true })
      void finishSetup(answers).catch(e => {
        finish.status = 'failed'
        finish.checklist.push({ label: 'Finishing', status: 'failed', reason: e && e.message ? e.message : String(e) })
      })
      return
    }

    return sendJson(res, 404, { error: 'Unknown route' })

  } catch (err) {
    console.error('[setup] Error:', err)
    return sendJson(res, 500, { error: err.message || 'Internal error' })
  }
})

module.exports = { tokenName, tokenComment, ensureToken, heldToken, resumeStep, composeProfiles, setupExporter, pveAdapter, WIZARD_HTML }

if (require.main === module) {
  setupSecret()
  // The installer binds this to loopback and serves it through nginx at https://<host>/setup. Older installs
  // left it on every interface, which is still the default for a unit that does not say.
  const BIND = process.env.SETUP_BIND || '0.0.0.0'
  server.listen(PORT, BIND, () => {
    if (BIND === '127.0.0.1') { console.log(`[hyperprox-setup] listening on 127.0.0.1:${PORT} - open https://<host>/setup?k=<SETUP_SECRET>`); return }
    const ip = Object.values(require('os').networkInterfaces())
      .flat()
      .find(i => i && i.family === 'IPv4' && !i.internal)
    console.log('\n  ┌──────────────────────────────────────────────┐')
    console.log('  │        HyperProx Setup Wizard                │')
    console.log('  │                                              │')
    console.log(`  │  Open → http://${(ip ? ip.address : 'localhost').padEnd(15)} :${PORT}         │`)
    console.log('  └──────────────────────────────────────────────┘\n')
  })
}
