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
  try {
    const cs = await pveRequest(host, port, tokenId, tokenSecret, '/cluster/ceph/status')
    if (cs && cs.health) ceph = { healthy: cs.health.status === 'HEALTH_OK', pools: (cs.pools || []).length }
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
  }
}

// =============================================================================
// Service scanner
// =============================================================================

function probeHttp(host, port, path, match, timeoutMs = 2500, useHttps = false) {
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
    { key: 'npm',     name: 'Nginx Proxy Manager', port: 81,    path: '/api',         match: 'nginx proxy manager' },
    { key: 'ollama',  name: 'Ollama',               port: 11434, path: '/api/tags',    match: 'models' },
    { key: 'pbs',     name: 'Proxmox Backup Server',port: 8007,  path: '/api2/json/version', match: 'version', https: true },
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
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--cyan:#00c8e0;--bg:#0a0f1a;--surface:#111827;--border:#1e2d45;--text:#e2e8f0;--muted:#64748b;--green:#22c55e;--red:#ef4444;--amber:#f59e0b}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}
.wrap{width:100%;max-width:560px}
.logo{font-size:2rem;font-weight:700;letter-spacing:2px;margin-bottom:4px}
.logo span{color:var(--cyan)}
.tagline{color:var(--muted);font-size:14px;margin-bottom:2.5rem}
.steps{display:flex;gap:0;margin-bottom:2rem;align-items:center}
.step{display:flex;align-items:center;flex:1}
.step:last-child{flex:0}
.dot{width:30px;height:30px;border-radius:50%;border:1.5px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:var(--muted);flex-shrink:0;font-family:monospace;transition:.2s}
.dot.active{border-color:var(--cyan);color:var(--cyan);background:rgba(0,200,224,.1)}
.dot.done{border-color:var(--green);color:var(--green);background:rgba(34,197,94,.1)}
.line{flex:1;height:1px;background:var(--border);margin:0 4px}
.line.done{background:var(--green)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:1.75rem;margin-bottom:1rem}
.card-title{font-size:1.25rem;font-weight:600;margin-bottom:.35rem}
.card-desc{font-size:14px;color:var(--muted);margin-bottom:1.5rem;line-height:1.6}
.field{margin-bottom:1rem}
.field label{display:block;font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px;font-family:monospace}
.field input{width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:#0d1424;color:var(--text);font-size:14px;font-family:monospace;outline:none;transition:.15s}
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
.steps-box{background:#0d1220;border:1px solid #00e5ff20;border-radius:8px;padding:1.25rem;margin-bottom:1.25rem}
.steps-title{color:#00e5ff;font-size:.8rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:1rem}
.steps-method{margin-bottom:1rem}
.steps-method:last-child{margin-bottom:0}
.steps-method-label{color:#9ca3af;font-size:.8rem;margin-bottom:.5rem;font-weight:500}
.code-block{background:#080c14;border:1px solid #00e5ff30;border-radius:4px;padding:.5rem .75rem;font-family:monospace;font-size:.8rem;color:#00e5ff;user-select:all;cursor:pointer}
.steps-note{color:#6b7280;font-size:.75rem;margin-top:.4rem}
.steps-list{color:#d1d5db;font-size:.82rem;padding-left:1.25rem;margin:0}
.steps-list li{margin-bottom:.35rem}
.steps-list strong{color:#f9fafb}
.steps-list code{background:#080c14;padding:.1rem .3rem;border-radius:3px;font-size:.8rem;color:#00e5ff}
.hint{font-size:12px;color:var(--muted)}
.detect-row{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);font-size:14px}
.detect-row:last-child{border:none}
.badge{display:inline-flex;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:600;font-family:monospace}
.badge-ok{background:rgba(34,197,94,.12);color:var(--green);border:1px solid rgba(34,197,94,.25)}
.badge-warn{background:rgba(245,158,11,.12);color:var(--amber);border:1px solid rgba(245,158,11,.25)}
.badge-off{background:rgba(100,116,139,.1);color:var(--muted);border:1px solid var(--border)}
.badge-scan{background:rgba(0,200,224,.1);color:var(--cyan);border:1px solid rgba(0,200,224,.25)}
.node-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-top:1rem}
.node-card{background:#0d1424;border:1px solid var(--border);border-radius:8px;padding:10px 12px}
.node-name{font-size:13px;font-weight:600;font-family:monospace;color:var(--cyan)}
.node-sub{font-size:11px;color:var(--muted);margin-top:2px}
.svc-card{border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;transition:.15s}
.svc-card:hover{border-color:#2e3f5c}
.svc-card.on{border-color:var(--cyan);background:rgba(0,200,224,.05)}
.svc-name{font-size:14px;font-weight:600}
.svc-detail{font-size:12px;color:var(--muted);font-family:monospace;margin-top:2px}
.toggle{width:36px;height:20px;border-radius:10px;border:1px solid var(--border);background:#0d1424;position:relative;transition:.2s;flex-shrink:0}
.toggle.on{background:var(--cyan);border-color:var(--cyan)}
.toggle::after{content:'';position:absolute;width:14px;height:14px;border-radius:50%;background:#fff;top:2px;left:2px;transition:.2s}
.toggle.on::after{transform:translateX(16px)}
.err{color:var(--red);font-size:13px;margin-top:.75rem;padding:10px 12px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:8px;display:none}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(0,200,224,.3);border-top-color:var(--cyan);border-radius:50%;animation:spin .6s linear infinite;vertical-align:middle;margin-right:6px}
@keyframes spin{to{transform:rotate(360deg)}}
.link-row{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#0d1424;border-radius:8px;margin-bottom:8px;font-size:13px}
.link-url{font-family:monospace;color:var(--cyan);font-size:12px}
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
    <div class="card-title">Connect your Proxmox cluster</div>
    <div class="card-desc">Connect HyperProx to your Proxmox cluster using an API token.</div>
    <div class="steps-box">
      <div class="steps-title">Create an API token — choose one method:</div>
      <div class="steps-method">
        <div class="steps-method-label">Option A — Command line (run on any Proxmox node):</div>
        <div class="code-block">pveum user token add root@pam hyperprox --privsep=0</div>
        <div class="code-block">pveum acl modify / --token 'root@pam!hyperprox' --role Administrator</div>
        <div class="steps-note">Copy the token secret from the first command output — it is only shown once.</div>
      </div>
      <div class="steps-method">
        <div class="steps-method-label">Option B — Web UI:</div>
        <ol class="steps-list">
          <li>Log into your Proxmox web UI</li>
          <li>Go to <strong>Datacenter → Permissions → API Tokens</strong></li>
          <li>Click <strong>Add</strong>, select user <code>root@pam</code></li>
          <li>Set Token ID to <code>hyperprox</code></li>
          <li>Uncheck <strong>Privilege Separation</strong></li>
          <li>Click <strong>Add</strong> and copy the secret</li>
          <li>Go to <strong>Datacenter → Permissions → Add → API Token Permission</strong></li>
          <li>Set Path to <code>/</code>, Token to <code>root@pam!hyperprox</code>, Role to <code>Administrator</code></li>
        </ol>
      </div>
    </div>
    <div class="field"><label>Proxmox host / IP</label><input id="px-host" placeholder="192.168.1.100" value="\${S.proxmox.host}"></div>
    <div class="row">
      <div class="field"><label>Port</label><input id="px-port" value="\${S.proxmox.port}" style="width:80px"></div>
    </div>
    <div class="field"><label>API Token ID</label><input id="px-tid" placeholder="root@pam!hyperprox" value="\${S.proxmox.tokenId}"></div>
    <div class="field"><label>API Token Secret</label><input id="px-sec" type="password" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value="\${S.proxmox.tokenSecret}"></div>
    <div class="field"><label>Public URL (optional — for noVNC outside LAN)</label><input id="px-pub" placeholder="https://pve.yourdomain.com" value="\${S.proxmox.publicUrl}"></div>
    <div class="err" id="px-err"></div>
    <div class="btn-row">
      <span class="hint">Step 1 of 6</span>
      <button class="btn btn-primary" id="btn-px">Test connection →</button>
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
    <div class="detect-row"><span>Cluster name</span><span style="font-family:monospace">\${c.name}</span><span class="badge badge-ok">online</span></div>
    <div class="detect-row"><span>Proxmox version</span><span style="font-family:monospace">\${c.version}</span><span class="badge badge-ok">supported</span></div>
    <div class="detect-row"><span>Nodes</span><span style="font-family:monospace">\${c.nodeCount} nodes</span><span class="badge \${c.quorate?'badge-ok':'badge-warn'}">\${c.quorate?'quorate':'no quorum'}</span></div>
    <div class="detect-row"><span>Running workloads</span><span style="font-family:monospace">\${c.runningVms} VMs · \${c.runningCts} CTs</span><span class="badge badge-ok">✓</span></div>
    \${c.ceph ? \`<div class="detect-row"><span>CEPH storage</span><span style="font-family:monospace">\${c.ceph.pools} pools</span><span class="badge \${c.ceph.healthy?'badge-ok':'badge-warn'}">\${c.ceph.healthy?'healthy':'degraded'}</span></div>\` : ''}
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
  const cards = Object.values(svcs).map(s =>
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
  ).join('') || '<div style="color:var(--muted);font-size:14px">Scanning... please wait</div>'

  return \`<div class="card">
    <div class="card-title">Existing services</div>
    <div class="card-desc">HyperProx scanned your cluster. Enable what you want to manage, skip the rest — you can connect more later.</div>
    \${cards}
    <div class="btn-row">
      <button class="btn btn-ghost" onclick="go(2)">← Back</button>
      <button class="btn btn-primary" onclick="go(4)">Continue →</button>
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
    const host = document.getElementById('px-host').value.trim()
    const port = document.getElementById('px-port').value.trim() || '8006'
    const tid  = document.getElementById('px-tid').value.trim()
    const sec  = document.getElementById('px-sec').value.trim()
    const pub  = document.getElementById('px-pub').value.trim()
    if(!host || !tid || !sec){ setErr('px-err','Host, Token ID and Token Secret are required.'); return }
    btnPx.disabled = true
    btnPx.innerHTML = '<span class="spinner"></span>Testing...'
    setErr('px-err','')
    const res = await api('POST','/api/setup/test-proxmox',{ host, port, tokenId:tid, tokenSecret:sec })
    if(res.ok){
      Object.assign(S.proxmox, { host, port, tokenId:tid, tokenSecret:sec, publicUrl:pub })
      S.cluster = res.cluster
      await api('POST','/api/setup/save-proxmox',{ host, port, tokenId:tid, tokenSecret:sec, publicUrl:pub })
      go(1)
    } else {
      setErr('px-err', res.error || 'Connection failed')
      btnPx.disabled = false
      btnPx.textContent = 'Test connection →'
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

    // ── save-proxmox ──────────────────────────────────────────────────────────
    if (req.method === 'POST' && route === 'save-proxmox') {
      const { host, port = '8006', tokenId, tokenSecret, publicUrl } = body
      const [proxmoxUser, proxmoxTokenId] = tokenId.includes('!') ? tokenId.split('!') : ['root@pam', tokenId]
      writeEnv({
        PROXMOX_HOST:         host,
        PROXMOX_PORT:         port,
        PROXMOX_USER:         proxmoxUser,
        PROXMOX_TOKEN_ID:     proxmoxTokenId,
        PROXMOX_TOKEN_SECRET: tokenSecret,
        ...(publicUrl ? { PROXMOX_PUBLIC_URL: publicUrl } : {}),
      })
      return sendJson(res, 200, { ok: true })
    }

    // ── create-admin ──────────────────────────────────────────────────────────
    if (req.method === 'POST' && route === 'create-admin') {
      const { username, password } = body
      if (!username || username.length < 3) return sendJson(res, 400, { error: 'Username must be at least 3 characters' })
      if (!password || password.length < 12) return sendJson(res, 400, { error: 'Password must be at least 12 characters' })
      if (readEnv().SETUP_ADMIN_CREATED === 'true') return sendJson(res, 409, { error: 'Admin already exists' })
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

      // Restart services and shut down
      setTimeout(() => {
        exec('systemctl restart hyperprox-api hyperprox-frontend', err => {
          if (err) console.warn('[setup] Restart warning:', err.message)
          console.log('[setup] Complete. Shutting down setup service.')
          process.exit(0)
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
