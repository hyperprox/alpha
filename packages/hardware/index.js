'use strict'
// =============================================================================
//  @hyperprox/hardware — one answer to "what does this node have?"
//
//  The facts come from node/probe.sh, which bootstrap.sh runs on each node and the setup wizard and the
//  API send over SSH. When there is no node login, the API asks Proxmox for the PCI list and runs the same
//  script's classifier on it, so a GPU is "built in" or "dedicated" for one reason everywhere.
//
//  This file adds what the JavaScript side needs on top: parsing, the plain-English summary, the install
//  questions, the plan (which node gets which step), running it one node at a time, and the Prometheus
//  target lists. Plain CommonJS with no dependencies: setup.js has no build step.
// =============================================================================

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const NODE_DIR = path.join(__dirname, 'node')
const STEPS = ['node-exporter', 'rapl', 'intel-gpu-exporter', 'nvidia-gpu-exporter']

function read(name) { return fs.readFileSync(path.join(NODE_DIR, name), 'utf8') }

/** The probe, as one script to send on stdin. It changes nothing on the node. */
function probeScript() { return read('probe.sh') }

/** A node-side step, whole (helpers first), to send on stdin. */
function stepScript(step) {
  if (!STEPS.includes(step)) throw new Error(`Unknown node step: ${step}`)
  return `${read('common.sh')}\n${read(`${step}.sh`)}`
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function parseGpuLine(cols) {
  const [vendor, kind, id, ...rest] = cols
  return { vendor, kind: kind === 'integrated' ? 'integrated' : 'dedicated', id, name: rest.join('\t').trim() }
}

/** probe.sh output → facts about one node. Unknown lines are ignored, missing ones stay null. */
function parseProbe(text, node) {
  const hw = {
    node: node ?? null, source: 'probe', gpus: [], dri: [], nvidiaSmi: null, rapl: null, raplDomains: [],
    nodeExporter: null, docker: null, python3: null, intelGpuTop: null, intelExporter: null, nvidiaExporter: null,
    ceph: null, arch: null, pve: null,
  }
  const yes = v => v === 'yes'
  for (const line of String(text ?? '').split('\n')) {
    const cols = line.replace(/\r$/, '').split('\t')
    const [k, v = '', w = ''] = cols
    switch (k) {
      case 'gpu': hw.gpus.push(parseGpuLine(cols.slice(1))); break
      case 'dri': hw.dri = v.split(/\s+/).filter(Boolean); break
      case 'nvidia_smi': hw.nvidiaSmi = yes(v); break
      case 'rapl': hw.rapl = ['none', 'readable', 'root-only'].includes(v) ? v : null; hw.raplDomains = w.split(',').filter(Boolean); break
      case 'node_exporter': hw.nodeExporter = ['running', 'installed', 'absent'].includes(v) ? v : null; break
      case 'docker': hw.docker = yes(v); break
      case 'python3': hw.python3 = yes(v); break
      case 'intel_gpu_top': hw.intelGpuTop = yes(v); break
      case 'intel_exporter': hw.intelExporter = v === 'running' ? 'running' : 'absent'; break
      case 'nvidia_exporter': hw.nvidiaExporter = v === 'running' ? 'running' : 'absent'; break
      case 'ceph': hw.ceph = yes(v); break
      case 'arch': hw.arch = v || null; break
      case 'pve': hw.pve = v || null; break
    }
  }
  return hw
}

/**
 * GPUs from Proxmox's `/nodes/{node}/hardware/pci` rows (class 03xx only), classified by probe.sh itself.
 * Synchronous: one short bash run.
 */
function classifyPci(rows) {
  const lines = (Array.isArray(rows) ? rows : [])
    .filter(d => /^0x03/i.test(String(d?.class ?? '')))
    .map(d => [d.vendor, d.device, d.device_name ?? ''].map(s => String(s ?? '').replace(/[\t\n]/g, ' ')).join('\t'))
  if (!lines.length) return []
  const out = execFileSync('bash', [path.join(NODE_DIR, 'probe.sh'), 'classify'], { input: lines.join('\n') + '\n', encoding: 'utf8', timeout: 10_000 })
  return out.split('\n').filter(l => l.startsWith('gpu\t')).map(l => parseGpuLine(l.split('\t').slice(1)))
}

/** Facts for a node known only through the Proxmox API (no login): GPUs, and whatever the caller probed. */
function fromProxmox(node, pciRows, extra = {}) {
  return { ...parseProbe('', node), source: 'proxmox-api', gpus: classifyPci(pciRows), ...extra }
}

/** The last HPX-RESULT line of a step's output. */
function parseResult(output, code) {
  const lines = String(output ?? '').split('\n').filter(l => l.startsWith('HPX-RESULT\t'))
  const last = lines[lines.length - 1]
  if (!last) return { status: 'failed', reason: code ? `the step stopped with exit code ${code} before reporting a result` : 'the step reported no result' }
  const [, status, ...reason] = last.split('\t')
  return { status: ['done', 'already', 'skipped', 'failed'].includes(status) ? status : 'failed', reason: reason.join('\t').trim() }
}

// ── Words ────────────────────────────────────────────────────────────────────

function gpuWords(g) { return `${g.name} (${g.kind === 'integrated' ? 'built in' : 'dedicated'})` }

/** "Found 3 nodes. node-a: NVIDIA GeForce GTX 1070 Ti (dedicated). node-b: no GPU." */
function summarise(nodes) {
  const list = Array.isArray(nodes) ? nodes : []
  const parts = [`Found ${list.length} node${list.length === 1 ? '' : 's'}.`]
  for (const n of list) {
    const gpu = n.gpus.length ? n.gpus.map(gpuWords).join(', ') : 'no GPU'
    const extra = []
    if (n.rapl === 'none') extra.push('no power counters')
    if (n.nodeExporter === 'running') extra.push('health monitoring already running')
    parts.push(`${n.node}: ${gpu}${extra.length ? `; ${extra.join('; ')}` : ''}.`)
  }
  if (list.some(n => n.ceph)) parts.push('Ceph storage found.')
  return parts.join(' ')
}

// ── Questions ────────────────────────────────────────────────────────────────
// bootstrap.sh asks the same questions in the shell; test/bootstrap-questions.test.js keeps the words equal.

const QUESTIONS = [
  { id: 'node-health', nodeWork: true, default: true,
    ask: 'Do you want HyperProx to watch the health of each of your nodes (CPU, memory, disks)?',
    what: 'Installs node_exporter on every node. It answers on port 9100.' },
  { id: 'power', nodeWork: true, default: true,
    ask: 'Do you want HyperProx to monitor the power on each of your nodes?',
    what: 'Lets HyperProx read the CPU energy counters. The trade-off: any local user on that node can then read energy use.' },
  { id: 'gpu', nodeWork: true, default: true,
    ask: 'Do you want HyperProx to monitor your GPUs?',
    what: 'Adds a small exporter for each GPU: Intel on port 8081, NVIDIA on port 9835. It only reads the GPU; drivers are never touched.' },
  { id: 'charts', nodeWork: false, default: true,
    ask: 'Do you want charts and dashboards (Prometheus and Grafana)?',
    what: 'Runs Prometheus and Grafana on this machine. You reach them only through HyperProx.' },
  { id: 'proxmox-metrics', nodeWork: false, default: true,
    ask: "Do you want HyperProx to read Proxmox's own metrics?",
    what: 'Makes a read-only Proxmox token (PVEAuditor) for the metrics exporter.' },
  { id: 'dns', nodeWork: false, default: false, optional: true,
    ask: 'Do you manage your domains at GoDaddy? Paste a key to let HyperProx manage DNS.',
    what: 'The key is kept in the vault. You can skip this and add it later.' },
  { id: 'ai', nodeWork: false, default: false,
    ask: 'Do you want a local AI assistant? HyperProx can run a small one on this machine, or you can connect one later.',
    what: 'Runs Ollama here (3 CPUs, 4 GB) and downloads a small model (about 2 GB).' },
]

const AI_MODEL = 'llama3.2:3b'

/** Why a GPU on this node gets no exporter, or null when it can have one. */
function gpuGap(n) {
  if (n.gpus.some(g => g.vendor === 'amd') && !n.gpus.some(g => g.vendor === 'intel' || g.vendor === 'nvidia')) return 'AMD GPUs are not covered yet'
  return null
}

/**
 * The questions that apply to these nodes, in order, each with its default and a note on what it will
 * not cover. A question with nothing to do is left out (no GPU found: no GPU question).
 */
function applicableQuestions(nodes, opts = {}) {
  const list = Array.isArray(nodes) ? nodes : []
  const gpus = list.flatMap(n => n.gpus.map(g => ({ ...g, node: n.node })))
  const out = []
  for (const q of QUESTIONS) {
    const item = { ...q, notes: [] }
    if (q.id === 'power') {
      const probed = list.filter(n => n.rapl !== null)
      if (probed.length && probed.every(n => n.rapl === 'none')) continue
      const none = probed.filter(n => n.rapl === 'none').map(n => n.node)
      if (none.length) item.notes.push(`${none.join(', ')} ${none.length === 1 ? 'has' : 'have'} no power counters and will be skipped.`)
    }
    if (q.id === 'gpu') {
      if (!gpus.length) continue
      if (gpus.some(g => g.vendor === 'amd')) item.notes.push('AMD GPUs are not covered yet, so they will be listed but not monitored.')
      if (!gpus.some(g => g.vendor === 'intel' || g.vendor === 'nvidia')) continue
    }
    if (q.id === 'proxmox-metrics' && opts.charts === false) continue
    out.push(item)
  }
  return out
}

/** The default answers for a question list: { id: boolean }. */
function defaultAnswers(questions) {
  return Object.fromEntries((questions ?? QUESTIONS).map(q => [q.id, q.default]))
}

// ── Planning and running ─────────────────────────────────────────────────────

/**
 * Node work for these answers: [{ node, step, why }] in node order, one node's steps together. A step the
 * node plainly does not need (already running, no such GPU) is not planned; the script would only say so.
 */
function planNodeWork(answers, nodes) {
  const a = answers ?? {}
  const plan = []
  for (const n of nodes ?? []) {
    if (a['node-health'] && n.nodeExporter !== 'running') plan.push({ node: n.node, step: 'node-exporter' })
    if (a.power && n.rapl !== 'none' && n.rapl !== 'readable') plan.push({ node: n.node, step: 'rapl' })
    if (a.gpu) {
      if (n.gpus.some(g => g.vendor === 'intel') && n.intelExporter !== 'running') plan.push({ node: n.node, step: 'intel-gpu-exporter' })
      if (n.gpus.some(g => g.vendor === 'nvidia') && n.nvidiaExporter !== 'running') plan.push({ node: n.node, step: 'nvidia-gpu-exporter' })
    }
  }
  return plan
}

const STEP_LABEL = {
  'node-exporter': 'Health monitoring',
  'rapl': 'Power monitoring',
  'intel-gpu-exporter': 'Intel GPU monitoring',
  'nvidia-gpu-exporter': 'NVIDIA GPU monitoring',
}

/**
 * Run a plan one step at a time, in order, never two at once. `exec(node, script)` resolves to
 * { code, output } or rejects (the node could not be reached). A failure is reported and the run goes on
 * to the next step; nothing is retried.
 */
async function runNodeWork(plan, exec, onEvent = () => {}) {
  const results = []
  for (const item of plan) {
    onEvent({ type: 'start', ...item, label: STEP_LABEL[item.step] })
    let r
    try {
      const out = await exec(item.node, stepScript(item.step))
      r = parseResult(out.output, out.code)
    } catch (e) {
      r = { status: 'failed', reason: `could not reach ${item.node}: ${e && e.message ? e.message : e}` }
    }
    const row = { ...item, label: STEP_LABEL[item.step], ...r }
    results.push(row)
    onEvent({ type: 'result', ...row })
  }
  return results
}

// ── Prometheus targets ───────────────────────────────────────────────────────

/**
 * Target files for these nodes. `addr(node)` gives the address Prometheus should use (falls back to the
 * node name). GPU targets follow the GPUs found, not a list anyone types in.
 */
function targetsFor(nodes, addr = n => n, opts = {}) {
  const t = (port, node) => ({ targets: [port ? `${addr(node)}:${port}` : addr(node)], labels: { node } })
  const files = { 'nodes.json': [], 'pve.json': [], 'intel-gpu.json': [], 'nvidia.json': [], 'ceph.json': [] }
  for (const n of nodes ?? []) {
    files['nodes.json'].push(t(9100, n.node))
    files['pve.json'].push(t(0, n.node))
    if (n.gpus.some(g => g.vendor === 'intel')) files['intel-gpu.json'].push(t(8081, n.node))
    if (n.gpus.some(g => g.vendor === 'nvidia')) files['nvidia.json'].push(t(9835, n.node))
    if (opts.cephMgrs?.has?.(n.node)) files['ceph.json'].push(t(9283, n.node))
  }
  return files
}

/** Add targets that are not there yet; an entry for a node or address already listed is kept as it is. */
function mergeTargets(existing, wanted) {
  const merged = [...(existing ?? [])]
  const added = []
  for (const t of wanted) {
    const node = t.labels?.node
    const target = t.targets?.[0]
    if (merged.some(e => e.labels?.node === node || e.targets?.[0] === target)) continue
    merged.push(t)
    added.push(node ?? target)
  }
  return { merged, added }
}

// ── Checking the outcome ─────────────────────────────────────────────────────

/**
 * Check what the answers were meant to produce, from Prometheus, not from the scripts' own word.
 * `query(expr)` resolves to [{ node, value }] (or rejects when Prometheus cannot be asked).
 * Returns one row per check: { id, node?, status: 'ok'|'failed'|'waiting', reason }.
 */
async function verifyOutcome(answers, nodes, query) {
  const rows = []
  const ask = async expr => { try { return { rows: await query(expr) } } catch (e) { return { error: e } } }
  if (answers['node-health']) {
    const up = await ask('up{job="node"}')
    for (const n of nodes) {
      if (up.error) { rows.push({ id: 'node-health', node: n.node, status: 'waiting', reason: 'Prometheus could not be asked yet' }); continue }
      const r = up.rows.find(x => x.node === n.node)
      rows.push(!r ? { id: 'node-health', node: n.node, status: 'failed', reason: 'not in the metrics list' }
        : r.value === 1 ? { id: 'node-health', node: n.node, status: 'ok', reason: 'answering' }
        : { id: 'node-health', node: n.node, status: 'failed', reason: 'listed, but not answering' })
    }
  }
  if (answers.power) {
    const w = await ask('rate(node_rapl_package_joules_total[2m])')
    for (const n of nodes.filter(x => x.rapl !== 'none')) {
      if (w.error) { rows.push({ id: 'power', node: n.node, status: 'waiting', reason: 'Prometheus could not be asked yet' }); continue }
      const r = w.rows.filter(x => x.node === n.node).reduce((a, x) => a + x.value, 0)
      rows.push(r > 0 ? { id: 'power', node: n.node, status: 'ok', reason: `${r.toFixed(1)} W` }
        : { id: 'power', node: n.node, status: 'waiting', reason: 'no reading yet (it needs two scrapes, about 30 seconds)' })
    }
  }
  if (answers.gpu) {
    for (const [vendor, job] of [['intel', 'intel-gpu'], ['nvidia', 'nvidia']]) {
      const want = nodes.filter(n => n.gpus.some(g => g.vendor === vendor))
      if (!want.length) continue
      const up = await ask(`up{job="${job}"}`)
      for (const n of want) {
        if (up.error) { rows.push({ id: 'gpu', node: n.node, status: 'waiting', reason: 'Prometheus could not be asked yet' }); continue }
        const r = up.rows.find(x => x.node === n.node)
        rows.push(r && r.value === 1 ? { id: 'gpu', node: n.node, status: 'ok', reason: `${vendor === 'intel' ? 'Intel' : 'NVIDIA'} GPU answering` }
          : { id: 'gpu', node: n.node, status: 'failed', reason: r ? 'listed, but not answering' : 'not in the metrics list' })
      }
    }
  }
  return rows
}

module.exports = {
  NODE_DIR, STEPS, STEP_LABEL, QUESTIONS, AI_MODEL,
  probeScript, stepScript, parseProbe, classifyPci, fromProxmox, parseResult,
  summarise, gpuWords, gpuGap, applicableQuestions, defaultAnswers,
  planNodeWork, runNodeWork, targetsFor, mergeTargets, verifyOutcome,
}
