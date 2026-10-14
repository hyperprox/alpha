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

const PORT     = parseInt(process.env.SETUP_PORT || '3001', 10)
const ENV_PATH = path.resolve(process.env.ENV_FILE_PATH || '/opt/hyperprox/.env')

// ── Bail if already set up ────────────────────────────────────────────────────
if (process.env.SETUP_COMPLETE === 'true') {
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

  fs.writeFileSync(ENV_PATH, newLines.join('\n'), 'utf8')
  Object.assign(process.env, updates)
}

// =============================================================================
// Crypto helpers  (AES-256-GCM)
// =============================================================================

function getKey() {
  const raw = readEnv().ENCRYPTION_KEY || process.env.ENCRYPTION_KEY || ''
  const buf = Buffer.from(raw, 'hex')
  if (buf.length !== 32) throw new Error('ENCRYPTION_KEY must be 64 hex chars')
  return buf
}

function encrypt(plaintext) {
  const key = getKey()
  const iv  = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag    = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString('base64')
}

// Password hashing with PBKDF2 (no bcrypt needed)
function hashPassword(password) {
  const salt   = crypto.randomBytes(32).toString('hex')
  const hash   = crypto.pbkdf2Sync(password, salt, 310000, 64, 'sha512').toString('hex')
  return `pbkdf2:${salt}:${hash}`
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
 * Any Proxmox API call with a ticket (cookie + CSRF) or none, form-encoded body. Used only by
 * connectWithLogin below, which needs the user's own session to create HyperProx's token.
 */
function pveCall(host, port, method, path, form, auth) {
  return new Promise((resolve, reject) => {
    const body = form ? new URLSearchParams(form).toString() : ''
    const headers = {}
    if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; headers['Content-Length'] = Buffer.byteLength(body) }
    if (auth) { headers.Cookie = `PVEAuthCookie=${encodeURIComponent(auth.ticket)}`; headers.CSRFPreventionToken = auth.csrf }
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
 * Connect with the same login as the Proxmox web interface. Signs in once, (re)creates HyperProx's own
 * API token `<user>!hyperprox-<host>-<rand>` with the user's privileges, tests it, and returns it. The password and
 * the session ticket are used for these calls only and never stored.
 */
async function connectWithLogin(host, port, username, password, otp) {
  const userid = username.includes('@') ? username : `${username}@pam`
  let t = await pveCall(host, port, 'POST', '/access/ticket', { username: userid, password })
  if (t && t.NeedTFA) {
    if (!otp) throw Object.assign(new Error('This account uses two-factor sign-in — enter your 6-digit code.'), { needTfa: true })
    t = await pveCall(host, port, 'POST', '/access/ticket', { username: userid, 'tfa-challenge': t.ticket, password: `totp:${otp}` })
  }
  const auth = { ticket: t.ticket, csrf: t.CSRFPreventionToken }
  // A name of its own per install, and nothing deleted: a second HyperProx on the same cluster (a test
  // install, a rebuild) must never revoke the key the first one is running on.
  const host_ = require('os').hostname().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'install'
  const name = `hyperprox-${host_}-${crypto.randomBytes(2).toString('hex')}`
  const tokenPath = `/access/users/${encodeURIComponent(userid)}/token/${name}`
  const tok = await pveCall(host, port, 'POST', tokenPath, { privsep: '0', comment: `HyperProx on ${require('os').hostname()} (created by the setup wizard)` }, auth)
  const tokenId = tok['full-tokenid'] || `${userid}!${name}`
  const tokenSecret = tok.value
  const cluster = await testProxmox(host, port, tokenId, tokenSecret)
  return { tokenId, tokenSecret, cluster }
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
// Admin creation — writes hash to .env, API handles DB on first launch
// =============================================================================

function createAdmin(username, password) {
  const hash = hashPassword(password)
  writeEnv({
    SETUP_ADMIN_USERNAME: username.toLowerCase(),
    SETUP_ADMIN_HASH:     hash,
    SETUP_ADMIN_CREATED:  'true',
  })
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
const STEPS = ['Proxmox','Cluster','Admin','Services','Providers','Done']
let cur = 0
const S = {
  proxmox:  { host:'', port:'8006', tokenId:'root@pam!hyperprox', tokenSecret:'', publicUrl:'' },
  cluster:  null,
  admin:    { username:'', password:'', confirm:'' },
  services: {},
  installs: { npm: false, grafana: true, prometheus: true },
  providers:{ godaddy:{ enabled:false, key:'', secret:'' }, npm:{ enabled:false, host:'', port:'81' } }
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

async function api(method, path, body){
  const r = await fetch(path, {
    method,
    headers:{ 'Content-Type':'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  return r.json()
}

// ── Step 0: Proxmox ───────────────────────────────────────────────────────────
function stepProxmox(){
  return \`<div class="card">
    <div class="eyebrow">Step 1 of 6</div>
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
    <div class="btn-row">
      <button class="btn btn-ghost" onclick="go(0)">← Back</button>
      <button class="btn btn-primary" onclick="go(2)">Looks right →</button>
    </div>
  </div>\`
}

// ── Step 2: Admin ─────────────────────────────────────────────────────────────
function stepAdmin(){
  return \`<div class="card">
    <div class="card-title">Create admin account</div>
    <div class="card-desc">Your HyperProx login — separate from your Proxmox credentials.</div>
    <div class="field"><label>Username</label><input id="adm-user" placeholder="admin" value="\${S.admin.username}"></div>
    <div class="field"><label>Password</label><input id="adm-pass" type="password" placeholder="Minimum 12 characters"></div>
    <div class="field"><label>Confirm password</label><input id="adm-confirm" type="password" placeholder="Repeat password"></div>
    <div class="err" id="adm-err"></div>
    <div class="btn-row">
      <button class="btn btn-ghost" onclick="go(1)">← Back</button>
      <button class="btn btn-primary" id="btn-admin">Continue →</button>
    </div>
  </div>\`
}

// ── Step 3: Services ──────────────────────────────────────────────────────────
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
    { key:'npm',        name:'Nginx Proxy Manager', desc:'Reverse proxy + SSL — ports 80, 81, 443' },
    { key:'prometheus', name:'Prometheus',           desc:'Metrics collection — port 9090' },
    { key:'grafana',    name:'Grafana',              desc:'Monitoring dashboards — port 3003' },
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
    <div class="card-title" style="margin-top:1.25rem">Install with HyperProx</div>
    <div class="card-desc">Select services to spin up as Docker containers alongside HyperProx.</div>
    \${installCards}
    <div class="btn-row">
      <button class="btn btn-ghost" onclick="go(2)">← Back</button>
      <button class="btn btn-primary" id="btn-installs">Continue →</button>
    </div>
  </div>\`
}

// ── Step 4: Providers ─────────────────────────────────────────────────────────
function stepProviders(){
  const gd = S.providers.godaddy
  return \`<div class="card">
    <div class="card-title">DNS provider</div>
    <div class="card-desc">Connect a DNS provider to manage records, DDNS, and SSL. You can add more providers later in Settings.</div>
    <div class="svc-card \${gd.enabled?'on':''}" onclick="toggleProv('godaddy')" style="margin-bottom:8px">
      <div><div class="svc-name">GoDaddy</div><div class="svc-detail">Manage records, DDNS, domain expiry</div></div>
      <div style="display:flex;align-items:center;gap:8px">
        <div class="toggle \${gd.enabled?'on':''}"></div>
      </div>
    </div>
    \${gd.enabled ? \`
    <div class="field"><label>API Key</label><input id="gd-key" placeholder="dh3jdK..." value="\${gd.key}"></div>
    <div class="field"><label>API Secret</label><input id="gd-sec" type="password" placeholder="QzX7s..." value="\${gd.secret}"></div>\` : ''}
    <div class="err" id="prov-err"></div>
    <div class="btn-row">
      <button class="btn btn-ghost" onclick="go(3)">← Back</button>
      <button class="btn btn-primary" id="btn-prov">Finish setup →</button>
    </div>
  </div>\`
}

// ── Step 5: Done ──────────────────────────────────────────────────────────────
function stepDone(){
  const env = window._env || {}
  const ip  = location.hostname
  return \`<div class="card" style="text-align:center">
    <div class="success-icon">✓</div>
    <div class="card-title" style="margin-bottom:.5rem">HyperProx is ready</div>
    <div class="card-desc" style="margin-bottom:1.5rem">Your cluster is connected. Opening the dashboard now.</div>
    <div class="link-row"><span style="color:var(--muted)">Dashboard</span><span class="link-url">http://\${ip}:3000</span></div>
    <div class="link-row"><span style="color:var(--muted)">Grafana</span><span class="link-url">http://\${ip}:3003</span></div>
    <div class="link-row"><span style="color:var(--muted)">Prometheus</span><span class="link-url">http://\${ip}:9090</span></div>
    <div style="margin-top:1.5rem">
      <a href="http://\${ip}:3000" style="display:block">
        <button class="btn btn-primary" style="width:100%;font-size:16px">Open dashboard →</button>
      </a>
    </div>
  </div>\`
}

// =============================================================================
// Render + bind
// =============================================================================

const renderers = [stepProxmox, stepCluster, stepAdmin, stepServices, stepProviders, stepDone]

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
      if(res.ok) await api('POST','/api/setup/save-proxmox',{ host, port, tokenId:tid, tokenSecret:sec, publicUrl:pub, cephMonNode: res.cluster.cephMonNode || '' })
    }
    if(res.ok){
      Object.assign(S.proxmox, { host, port, username:user, publicUrl:pub, tokenId: res.tokenId || tid, tokenSecret:'' })
      S.cluster = res.cluster
      go(1)
    } else {
      if(res.needTfa){ S.proxmox.needTfa = true; document.getElementById('px-otp-wrap').style.display = 'block'; document.getElementById('px-otp').focus() }
      setErr('px-err', res.error || 'Could not connect')
      btnPx.disabled = false
      btnPx.textContent = 'Connect →'
    }
  }

  // Step 2 — create admin
  const btnAdm = document.getElementById('btn-admin')
  if(btnAdm) btnAdm.onclick = async () => {
    const user = document.getElementById('adm-user').value.trim()
    const pass = document.getElementById('adm-pass').value
    const conf = document.getElementById('adm-confirm').value
    if(!user){ setErr('adm-err','Username is required.'); return }
    if(pass.length < 12){ setErr('adm-err','Password must be at least 12 characters.'); return }
    if(pass !== conf){ setErr('adm-err','Passwords do not match.'); return }
    btnAdm.disabled = true
    btnAdm.innerHTML = '<span class="spinner"></span>Creating...'
    setErr('adm-err','')
    const res = await api('POST','/api/setup/create-admin',{ username:user, password:pass })
    if(res.ok){
      Object.assign(S.admin,{ username:user })
      go(3)
      // Scan with hard 8s client timeout — auto-advance if hung
      const scanDone = new Promise(resolve => {
        api('GET','/api/setup/scan-services').then(r => {
          if(r.ok && r.services){
            S.services = {}
            r.services.forEach(s => { S.services[s.key] = { ...s, enabled: s.found } })
            // Never offer to install a second proxy manager on top of one the cluster already runs.
            if (S.services.npm && S.services.npm.found) S.installs.npm = false
          }
          resolve()
        }).catch(() => resolve())
      })
      const scanTimeout = new Promise(resolve => setTimeout(resolve, 8000))
      Promise.race([scanDone, scanTimeout]).then(() => render())
    } else {
      setErr('adm-err', res.error || 'Failed to create admin')
      btnAdm.disabled = false
      btnAdm.textContent = 'Continue →'
    }
  }

  // Step 3 — save installs
  const btnInst = document.getElementById('btn-installs')
  if(btnInst) btnInst.onclick = async () => {
    btnInst.disabled = true
    btnInst.innerHTML = '<span class="spinner"></span>Saving...'
    await api('POST','/api/setup/save-installs', { installs: S.installs })
    go(4)
  }

  // Step 4 — save providers
  const btnProv = document.getElementById('btn-prov')
  if(btnProv) btnProv.onclick = async () => {
    const gd = S.providers.godaddy
    if(gd.enabled){
      gd.key    = (document.getElementById('gd-key')  || {}).value || gd.key
      gd.secret = (document.getElementById('gd-sec')  || {}).value || gd.secret
      if(!gd.key || !gd.secret){ setErr('prov-err','GoDaddy API Key and Secret are required.'); return }
    }
    btnProv.disabled = true
    btnProv.innerHTML = '<span class="spinner"></span>Finishing...'
    setErr('prov-err','')
    await api('POST','/api/setup/save-providers',{ providers: S.providers })
    const res = await api('POST','/api/setup/complete',{})
    if(res.ok){ go(5) } else {
      setErr('prov-err', (res.errors || [res.error]).join(' '))
      btnProv.disabled = false
      btnProv.textContent = 'Finish setup →'
    }
  }
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

render()
</script>
</body>
</html>`

// =============================================================================
// HTTP Server
// =============================================================================

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
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
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

  const route = url.replace('/api/setup/', '')

  try {
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
        const { tokenId, tokenSecret, cluster } = await connectWithLogin(host, port, username, password, otp)
        const [proxmoxUser, proxmoxTokenId] = tokenId.split('!')
        writeEnv({
          PROXMOX_HOST: host, PROXMOX_PORT: port, PROXMOX_USER: proxmoxUser, PROXMOX_TOKEN_ID: proxmoxTokenId,
          PROXMOX_TOKEN_SECRET: tokenSecret, CEPH_MON_NODE: '', ...(publicUrl ? { PROXMOX_PUBLIC_URL: publicUrl } : {}),
        })
        return sendJson(res, 200, { ok: true, cluster, tokenId })
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
      return sendJson(res, 200, { ok: true })
    }

    // ── create-admin ──────────────────────────────────────────────────────────
    if (req.method === 'POST' && route === 'create-admin') {
      const { username, password } = body
      if (!username || username.length < 3) return sendJson(res, 400, { error: 'Username must be at least 3 characters' })
      if (!password || password.length < 12) return sendJson(res, 400, { error: 'Password must be at least 12 characters' })
      // Setup is not finished (this server exits once it is), so a reloaded or restarted wizard may
      // create the admin again: the newest answer wins. Refusing here stranded anyone who reloaded the
      // page mid-setup, with no way back to an account whose password they had just been asked for.
      createAdmin(username, password)
      return sendJson(res, 200, { ok: true })
    }

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
        INSTALL_NPM:        installs.npm        ? 'true' : 'false',
        INSTALL_GRAFANA:    installs.grafana    ? 'true' : 'false',
        INSTALL_PROMETHEUS: installs.prometheus ? 'true' : 'false',
      })
      return sendJson(res, 200, { ok: true })
    }

    // ── save-providers ────────────────────────────────────────────────────────
    if (req.method === 'POST' && route === 'save-providers') {
      const { providers = {} } = body
      const updates = {}
      const gd = providers.godaddy
      if (gd && gd.enabled && gd.key && gd.secret) {
        updates.GODADDY_API_KEY    = encrypt(gd.key)
        updates.GODADDY_API_SECRET = encrypt(gd.secret)
        updates.GODADDY_ENABLED    = 'true'
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

    // ── complete ──────────────────────────────────────────────────────────────
    if (req.method === 'POST' && route === 'complete') {
      const env = readEnv()
      const errors = []
      if (!env.PROXMOX_HOST || !env.PROXMOX_TOKEN_SECRET) errors.push('Proxmox not configured')
      if (env.SETUP_ADMIN_CREATED !== 'true') errors.push('Admin account not created')
      if (errors.length) return sendJson(res, 400, { ok: false, errors })

      writeEnv({ SETUP_COMPLETE: 'true' })

      // Write Prometheus node targets
      try {
        const cluster = await testProxmox(env.PROXMOX_HOST, env.PROXMOX_PORT || '8006', env.PROXMOX_TOKEN_ID, env.PROXMOX_TOKEN_SECRET)
        const targets  = cluster.nodes.map(n => ({ targets: [`${n.node}:9100`], labels: { node: n.node } }))
        const dest     = '/opt/hyperprox/config/prometheus/targets/nodes.json'
        fs.writeFileSync(dest, JSON.stringify(targets, null, 2))
      } catch (e) {
        console.warn('[setup] Could not write Prometheus targets:', e.message)
      }

      sendJson(res, 200, { ok: true })

      // Start optional containers then restart services and shut down
      setTimeout(() => {
        const finalEnv = readEnv()
        const profiles = []
        if (finalEnv.INSTALL_PROMETHEUS === 'true') profiles.push('monitoring')
        if (finalEnv.INSTALL_NPM === 'true') profiles.push('npm')
        const profileFlag = profiles.length ? '--profile ' + profiles.join(' --profile ') : ''
        const composeCmd = 'docker compose ' + profileFlag + ' up -d --remove-orphans'
        console.log('[setup] Running:', composeCmd)
        exec(composeCmd, { cwd: '/opt/hyperprox' }, (err, stdout, stderr) => {
          if (err) console.warn('[setup] docker compose error:', err.message)
          if (stderr) console.warn('[setup] docker compose stderr:', stderr)
          if (stdout) console.log('[setup] docker compose stdout:', stdout)
          exec('systemctl restart hyperprox-api hyperprox-frontend', err2 => {
            if (err2) console.warn('[setup] Restart warning:', err2.message)
            console.log('[setup] Complete. Shutting down setup service.')
            process.exit(0)
          })
        })
      }, 1000)
      return
    }

    return sendJson(res, 404, { error: 'Unknown route' })

  } catch (err) {
    console.error('[setup] Error:', err)
    return sendJson(res, 500, { error: err.message || 'Internal error' })
  }
})

server.listen(PORT, '0.0.0.0', () => {
  const ip = Object.values(require('os').networkInterfaces())
    .flat()
    .find(i => i && i.family === 'IPv4' && !i.internal)
  console.log('\n  ┌──────────────────────────────────────────────┐')
  console.log('  │        HyperProx Setup Wizard                │')
  console.log('  │                                              │')
  console.log(`  │  Open → http://${(ip ? ip.address : 'localhost').padEnd(15)} :${PORT}         │`)
  console.log('  └──────────────────────────────────────────────┘\n')
})
