'use strict'
// =============================================================================
//  HyperProx setup wizard — the installer's questions, carried out
//
//  The wizard runs before the vault exists, so a node login or a GoDaddy key it is given is held HERE,
//  in this process's memory only. It is never written to .env or any other file. When setup finishes it
//  is handed to the API over loopback (with the setup key), which holds it in memory until the owner's
//  first sign-in and then stores it in the vault. A restart in between loses it: Settings → Setup
//  checklist asks again.
//
//  Node work uses @hyperprox/hardware, the same scripts bootstrap.sh and the API use: one node at a time,
//  idempotent, packages only ever added. Then it is checked: from here (the exporter answers, power reads
//  above zero) and, when setup finishes, in Prometheus.
// =============================================================================

const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const hw = require('../../packages/hardware')

// ssh2 is the API's dependency; this file has no node_modules of its own.
function ssh2() { return require(require.resolve('ssh2', { paths: [path.join(__dirname, '..', 'api')] })) }

// ── Held in memory only ──────────────────────────────────────────────────────
const held = { nodeLogin: null, godaddy: null }

function heldSummary() {
  return { nodeLogin: held.nodeLogin ? { nodes: [...held.nodeLogin.nodes] } : null, godaddy: Boolean(held.godaddy) }
}
function holdGodaddy(key, secret) { held.godaddy = { key: String(key), secret: String(secret) } }
function forget() { held.nodeLogin = null; held.godaddy = null }

// ── Host keys: pinned on first connection, required for the rest of the run ──
// address -> SHA256 fingerprint. Handed to the API with the login, which pins them in the vault.
const pins = {}
function fingerprintOf(key) { return 'SHA256:' + require('crypto').createHash('sha256').update(key).digest('base64').replace(/=+$/, '') }
/** Pin on first sight; afterwards only the same key is accepted. */
function checkPin(host, fp) {
  if (!fp) return false
  if (!pins[host]) { pins[host] = fp; return true }
  return pins[host] === fp
}
class HostKeyChanged extends Error {
  constructor(host, want, got) { super(`the host key of ${host} changed during setup (was ${want}, now ${got}), so HyperProx stopped talking to it`) }
}
/** Wrap a runner so every result's host key is checked against the pin (the SSH runner also checks before signing in). */
function pinned(run) {
  return async (host, cred, script, t) => {
    const r = await run(host, cred, script, t)
    if (!checkPin(host, r.hostKey)) throw new HostKeyChanged(host, pins[host], r.hostKey)
    return r
  }
}

// ── Running a script on a node ───────────────────────────────────────────────

/** Run `script` on host over SSH (script on stdin, never on a command line). Resolves { code, output }. */
function sshRun(host, cred, script, timeoutMs = 15 * 60_000) {
  const { Client } = ssh2()
  return new Promise((resolve, reject) => {
    const c = new Client()
    let out = '', done = false, seen = null, refused = false
    const end = (fn, v) => { if (done) return; done = true; clearTimeout(t); try { c.end() } catch {} ; fn(v) }
    const t = setTimeout(() => end(resolve, { code: -1, output: out + '\n(timed out)' }), timeoutMs)
    c.on('error', e => end(reject, refused ? new HostKeyChanged(host, pins[host], seen) : e))
    c.on('ready', () => c.exec('bash -s', (err, stream) => {
      if (err) return end(reject, err)
      stream.on('data', d => { out += d })
      stream.stderr.on('data', d => { out += d })
      stream.on('close', code => end(resolve, { code: code == null ? 0 : code, output: out, hostKey: seen }))
      stream.end(script)
    }))
    // Checked before any password is sent: a node that shows a different key from the first one is refused.
    const cfg = { host, port: 22, username: cred.username, readyTimeout: 15_000,
      hostVerifier: (key) => { seen = fingerprintOf(key); const ok = checkPin(host, seen); refused = !ok; return ok } }
    if (cred.privateKey) { cfg.privateKey = cred.privateKey; if (cred.passphrase) cfg.passphrase = cred.passphrase }
    else cfg.password = cred.password
    try { c.connect(cfg) } catch (e) { end(reject, e) }
  })
}

function getText(url, timeoutMs = 4000) {
  return new Promise(resolve => {
    const lib = url.startsWith('https') ? https : http
    const req = lib.get(url, { timeout: timeoutMs, rejectUnauthorized: false }, res => {
      let b = ''; res.on('data', d => { b += d }); res.on('end', () => resolve(res.statusCode < 400 ? b : null))
    })
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

// ── Detection without a login (Proxmox's PCI list + asking the exporters) ────

async function detectFromProxmox(pve, nodes, addrs) {
  const out = []
  for (const n of nodes) {
    const pci = await pve(`/nodes/${n}/hardware/pci`).catch(() => [])
    const a = addrs[n] || n
    const [m9100, m8081, m9835] = await Promise.all([9100, 8081, 9835].map(p => getText(`http://${a}:${p}/metrics`)))
    out.push(hw.fromProxmox(n, pci, {
      nodeExporter: m9100 && /^node_exporter_build_info/m.test(m9100) ? 'running' : null,
      rapl: m9100 && /^node_rapl_package_joules_total/m.test(m9100) ? 'readable' : null,
      intelExporter: m8081 && /^igpu_/m.test(m8081) ? 'running' : 'absent',
      nvidiaExporter: m9835 && /^nvidia_smi_memory_total_bytes/m.test(m9835) ? 'running' : 'absent',
    }))
  }
  return out
}

// ── The node login: asked once, tested on every node, held in memory ─────────

async function testNodeLogin(input, nodes, addrs, rawRun = sshRun) {
  const run = pinned(rawRun)
  const username = String(input && input.username || '').trim()
  const password = input && input.password ? String(input.password) : ''
  const privateKey = input && input.privateKey ? String(input.privateKey) : ''
  if (!username) return { ok: false, error: 'Enter the user name you sign in to your nodes with (usually root).' }
  if (!password && !privateKey) return { ok: false, error: 'Enter the password, or paste a private key.' }
  const cred = { username, ...(password ? { password } : {}), ...(privateKey ? { privateKey } : {}), ...(input.passphrase ? { passphrase: String(input.passphrase) } : {}) }
  const rows = []
  for (const n of nodes) {
    try {
      const r = await run(addrs[n] || n, cred, 'pveversion\n', 20_000)
      const a = addrs[n] || n
      rows.push(r.code === 0 && /pve-manager/.test(r.output)
        ? { node: n, ok: true, reason: r.output.trim().split('\n')[0], fingerprint: pins[a] || null }
        : { node: n, ok: false, reason: 'signed in, but this does not look like a Proxmox node', fingerprint: pins[a] || null })
    } catch (e) {
      rows.push({ node: n, ok: false, reason: /authentication/i.test(e && e.message || '') ? 'that login was not accepted' : `could not connect: ${e && e.message}` })
    }
  }
  const okNodes = rows.filter(r => r.ok).map(r => r.node)
  const hostKeys = {}
  for (const n of okNodes) { const a = addrs[n] || n; if (pins[a]) hostKeys[n] = { address: a, fingerprint: pins[a] } }
  if (okNodes.length) held.nodeLogin = { ...cred, nodes: okNodes, hostKeys }
  return { ok: okNodes.length > 0, nodes: rows }
}

// ── Doing it ─────────────────────────────────────────────────────────────────

const job = { status: 'idle', events: [], results: [], checks: [], nodes: [], summary: '' }

/**
 * Probe every node with the held login (falling back to Proxmox's view where it does not work), plan the
 * node work for these answers, run it one node at a time, then check from here.
 */
async function applyAnswers(answers, ctx, rawRun = sshRun) {
  const run = pinned(rawRun)
  if (job.status === 'running') return { ok: false, error: 'Already running.' }
  Object.assign(job, { status: 'running', events: [], results: [], checks: [], answers })
  try {
    const login = held.nodeLogin
    const nodes = []
    for (const n of ctx.nodes) {
      let facts = null
      if (login && login.nodes.includes(n)) {
        try {
          const r = await run(ctx.addrs[n] || n, login, hw.probeScript(), 60_000)
          const p = hw.parseProbe(r.output, n)
          if (p.arch) facts = p
        } catch {}
      }
      nodes.push(facts || (await detectFromProxmox(ctx.pve, [n], ctx.addrs))[0])
    }
    job.nodes = nodes
    job.summary = hw.summarise(nodes)
    const plan = hw.planNodeWork(answers, nodes)
    const runnable = plan.filter(p => login && login.nodes.includes(p.node))
    for (const p of plan.filter(p => !runnable.includes(p))) {
      job.results.push({ node: p.node, label: hw.STEP_LABEL[p.step], status: 'skipped', reason: 'no working node login for this node' })
    }
    const res = await hw.runNodeWork(runnable, (node, script) => run(ctx.addrs[node] || node, login, script), e => job.events.push(e))
    job.results.push(...res)
    job.checks = await checkFromHere(answers, nodes, ctx.addrs)
    job.status = 'done'
  } catch (e) {
    job.status = 'failed'
    job.results.push({ label: 'Setup', status: 'failed', reason: e && e.message ? e.message : String(e) })
  }
  return { ok: true }
}

async function raplJoules(addr) {
  const m = await getText(`http://${addr}:9100/metrics`)
  if (!m) return null
  return m.split('\n').filter(l => l.startsWith('node_rapl_package_joules_total')).reduce((a, l) => a + Number(l.split(' ').pop()), 0)
}

/** The outcome from this machine, which is where Prometheus scrapes from. */
async function checkFromHere(answers, nodes, addrs, sleep = ms => new Promise(r => setTimeout(r, ms))) {
  const out = []
  for (const n of nodes) {
    const a = addrs[n.node] || n.node
    if (answers['node-health']) {
      const m = await getText(`http://${a}:9100/metrics`)
      out.push(m && /^node_exporter_build_info/m.test(m) ? { id: 'node-health', node: n.node, status: 'ok', reason: 'answers on port 9100' }
        : { id: 'node-health', node: n.node, status: 'failed', reason: 'port 9100 does not answer from here' })
    }
    if (answers.power && n.rapl !== 'none') {
      const j1 = await raplJoules(a); await sleep(2000); const j2 = await raplJoules(a)
      out.push(j1 != null && j2 != null && j2 > j1 ? { id: 'power', node: n.node, status: 'ok', reason: `${((j2 - j1) / 2).toFixed(1)} W` }
        : { id: 'power', node: n.node, status: 'failed', reason: 'no energy reading yet' })
    }
    if (answers.gpu) {
      if (n.gpus.some(g => g.vendor === 'intel')) {
        const m = await getText(`http://${a}:8081/metrics`)
        out.push({ id: 'gpu', node: n.node, status: m && /^igpu_/m.test(m) ? 'ok' : 'failed', reason: m ? 'Intel GPU answers on port 8081' : 'port 8081 does not answer from here' })
      }
      if (n.gpus.some(g => g.vendor === 'nvidia')) {
        const m = await getText(`http://${a}:9835/metrics`)
        out.push({ id: 'gpu', node: n.node, status: m && /^nvidia_smi_memory_total_bytes/m.test(m) ? 'ok' : 'failed', reason: m ? 'NVIDIA GPU answers on port 9835' : 'port 9835 does not answer from here' })
      }
    }
  }
  return out
}

// ── Finishing ────────────────────────────────────────────────────────────────

/** Prometheus targets for what was found, merged into what is there. */
function writeTargets(dir, nodes, addrs) {
  const wanted = hw.targetsFor(nodes, n => addrs[n] || n)
  fs.mkdirSync(dir, { recursive: true })
  for (const [file, list] of Object.entries(wanted)) {
    const p = path.join(dir, file)
    let have = []
    try { have = JSON.parse(fs.readFileSync(p, 'utf8')) } catch {}
    fs.writeFileSync(p, JSON.stringify(hw.mergeTargets(have, list).merged, null, 2))
  }
}

/** Prometheus on this machine, as the shared verifier asks it. */
function promQuery(base = 'http://127.0.0.1:9090') {
  return async expr => {
    const t = await getText(`${base}/api/v1/query?query=${encodeURIComponent(expr)}`, 6000)
    if (!t) throw new Error('Prometheus is not answering')
    const d = JSON.parse(t)
    if (d.status !== 'success') throw new Error('Prometheus returned an error')
    return (d.data.result || []).map(r => ({ node: r.metric.node || r.metric.instance || '', value: Number(r.value[1]) }))
  }
}

/**
 * Give the API what is held, over loopback with the setup key, then forget it here. `hostRecord` is what bootstrap.sh
 * read on the node it ran on (the cluster's record of its nodes' host keys; public keys only): it rides the same
 * one-time hand-over and becomes the anchor HyperProx verifies its nodes' keys against.
 */
function handOff(apiPort, setupKey, hostRecord = null) {
  const body = JSON.stringify({
    ...(held.nodeLogin ? { nodeLogin: held.nodeLogin } : {}),
    ...(held.godaddy ? { godaddy: held.godaddy } : {}),
    ...(hostRecord ? { hostRecord } : {}),
  })
  if (body === '{}') return Promise.resolve({ ok: true, held: { nodeLogin: null, godaddy: false } })
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: apiPort, path: '/api/auth/setup-handoff', method: 'POST', timeout: 10_000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Setup-Key': setupKey } }, res => {
      let b = ''; res.on('data', d => { b += d })
      res.on('end', () => {
        let j = {}; try { j = JSON.parse(b) } catch {}
        if (res.statusCode === 200) forget()
        resolve({ ok: res.statusCode === 200, held: j.held || null, error: res.statusCode === 200 ? null : (j.error || `API answered ${res.statusCode}`) })
      })
    })
    req.on('error', e => resolve({ ok: false, error: e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'the API did not answer' }) })
    req.end(body)
  })
}

/** A GoDaddy key is tested before it is held: a wrong key is an answer now, not a failure later. */
function testGodaddy(key, secret) {
  return new Promise(resolve => {
    const req = https.get({ host: 'api.godaddy.com', path: '/v1/domains?limit=5', timeout: 10_000,
      headers: { Authorization: `sso-key ${key}:${secret}`, Accept: 'application/json' } }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode === 200 ? { ok: true } : { ok: false, error: `GoDaddy did not accept that key (${res.statusCode}). Use a Production key.` }))
    })
    req.on('error', e => resolve({ ok: false, error: `Could not reach GoDaddy: ${e.message}` }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'GoDaddy did not answer' }) })
  })
}

/** What bootstrap.sh found and did, when it ran first (no secrets in it). */
function bootstrapAnswers(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'data/setup/bootstrap.json'), 'utf8')) } catch { return null }
}

module.exports = {
  pins, checkPin, fingerprintOf, HostKeyChanged,
  hw, held, heldSummary, holdGodaddy, forget, sshRun, testNodeLogin, applyAnswers, job, checkFromHere,
  detectFromProxmox, writeTargets, promQuery, handOff, testGodaddy, bootstrapAnswers, getText,
}
