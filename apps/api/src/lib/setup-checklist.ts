// =============================================================================
//  HyperProx — Settings → Setup checklist
//
//  The installer's questions, for an install that already exists: each shows what it would do, whether it
//  is done (checked live, not remembered), and one button to do it now. Node work runs one node at a time
//  through the stored node login, with the same scripts bootstrap.sh and the setup wizard use, and is
//  checked afterwards in Prometheus.
//
//  Everything secret goes through the vault: the node login (ssh-broker), the GoDaddy key (credentials).
//  While HyperProx is locked the gate answers 423 before any of this runs.
// =============================================================================

import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'
import axios from 'axios'
import { hardware, detectCluster, productionHardwareDeps, type HardwareDeps, type NodeHardware } from './hardware'
import type { TerminalCredential } from './ssh-broker'
import { saveCredential } from './ssh-broker'
import { getProviderCredentials, setCredentials, setCredential } from './credentials'
import { auditCredentialUse } from './audit'
import { resolvePrometheusUrl } from './service-health'
import { syncTargets, lastSync } from './targets'
import { exporterStatus, provisionPveExporter, pveAccessFromEnv } from './pve-exporter'
import { GoDaddyClient } from './godaddy-client'
import { ensureGrafanaAdmin } from './grafana-admin'
import { listPins, pinId, confirmPin, PinConfirmRefusal, pinnedKey, pinSource, isConfirmedSource, evidenceWords, isRemotePinId, type PinRow } from './hostkey-pins'
import { probeHostKey } from './node-exec'
import { verifyNodes, productionVerifyDeps, saveAnchors, ANCHOR_COMMAND, VerifyRefusal, AnchorReplaceRefusal, type NodeVerdict, type VerifyDeps } from './hostkey-verify'
import { publish } from './notify'

const run = promisify(execFile)

export type ItemId = 'node-health' | 'power' | 'gpu' | 'igpu-access' | 'charts' | 'proxmox-metrics' | 'dns' | 'ai' | 'targets' | 'old-backups' | 'host-keys'
/** failed: it was set up, but checking the outcome found it not working (the row or note says why). */
/** unknown: could not be read (no node login yet); neither done nor not done, and never counted as either. */
export type ItemState = 'done' | 'partly' | 'not-done' | 'not-applicable' | 'failed' | 'unknown'

export interface NodeRow { node: string; state: ItemState; reason: string; host?: string; port?: number; fingerprint?: string }
export interface ChecklistItem {
  id: ItemId
  ask: string
  what: string
  notes: string[]
  state: ItemState
  rows: NodeRow[]
  /** Needs a stored login on every node it would change. */
  needsNodeLogin: boolean
  /** What pressing the button would do, in words; null when there is nothing to do. */
  action: string | null
  automatic?: boolean
  /** Host keys: the one-line command to run on any node when HyperProx has nothing trusted to check against. */
  command?: string
}

export interface ChecklistDeps {
  hardware: HardwareDeps
  envFile: string
  hyperproxDir: string
  promQuery(expr: string): Promise<Array<{ node: string; value: number }>>
  compose(args: string[]): Promise<void>
  ollamaModels(): Promise<string[] | null>
  pullModel(model: string): Promise<void>
  pveExporter(): Promise<{ configured: boolean; readOnly: boolean | null }>
  provisionPveExporter(): Promise<unknown>
  dnsKey(): Promise<{ key?: string; secret?: string }>
  saveDnsKey(key: string, secret: string): Promise<void>
  testDnsKey(key: string, secret: string): Promise<number>
  setOllamaUrl(url: string): Promise<void>
  syncTargets(): Promise<unknown>
  saveNodeLogin(node: string, cred: TerminalCredential): Promise<void>
  /** Every host-key pin, with where it came from. */
  pins(): Promise<PinRow[]>
  /** The key a host presents now (nothing is sent to it). */
  presentedKey(host: string, port: number): Promise<string>
  /** Verify the home nodes' host keys with evidence, no comparing by hand (lib/hostkey-verify.ts). */
  verifyHostKeys?(by: string): Promise<NodeVerdict[]>
  /** Does Prometheus answer a query (`up`)? Without it, the outcome is read through promQuery('up'). */
  promReady?(): Promise<PromReadiness>
}

export interface PromReadiness { ok: boolean; reason: string }

/**
 * Charts are done when Prometheus answers a query, not when the compose profile says it should run: the
 * outcome, not the intention. `get` is one GET returning the parsed JSON (tests pass a fake server).
 */
export async function prometheusReadiness(base: string, get: (url: string) => Promise<any> = async url => (await axios.get(url, { timeout: 5000 })).data): Promise<PromReadiness> {
  const url = `${base.replace(/\/+$/, '')}/api/v1/query?query=up`
  try {
    const data = await get(url)
    if (data?.status !== 'success') return { ok: false, reason: `Prometheus at ${base} answered, but not with a result (${String(data?.error ?? data?.status ?? 'no status').slice(0, 120)})` }
    const rows: any[] = Array.isArray(data?.data?.result) ? data.data.result : []
    const up = rows.filter(r => String(r?.value?.[1]) === '1').length
    return { ok: true, reason: `Prometheus answers queries: ${up} of ${rows.length} target(s) up` }
  } catch (e: any) {
    const status = e?.response?.status
    return { ok: false, reason: `Prometheus at ${base} did not answer a query (${status ? `HTTP ${status}` : e?.code ?? e?.message ?? 'no answer'})` }
  }
}

async function promReadiness(deps: ChecklistDeps): Promise<PromReadiness> {
  if (deps.promReady) return deps.promReady().catch((e: any) => ({ ok: false, reason: e?.message ?? String(e) }))
  try {
    const rows = await deps.promQuery('up')
    return { ok: true, reason: `Prometheus answers queries: ${rows.filter(r => r.value === 1).length} of ${rows.length} target(s) up` }
  } catch (e: any) { return { ok: false, reason: `Prometheus did not answer a query (${e?.message ?? e})` } }
}

export function productionChecklistDeps(): ChecklistDeps {
  const dir = process.env.HYPERPROX_DIR || '/opt/hyperprox'
  return {
    hardware: productionHardwareDeps(),
    envFile: process.env.ENV_FILE_PATH || path.join(dir, '.env'),
    hyperproxDir: dir,
    async promQuery(expr) {
      const base = await resolvePrometheusUrl()
      const { data } = await axios.get(`${base}/api/v1/query`, { params: { query: expr }, timeout: 8000 })
      if (data?.status !== 'success') throw new Error('Prometheus returned an error')
      return (data.data?.result ?? []).map((r: any) => ({ node: r.metric?.node ?? r.metric?.instance ?? '', value: Number(r.value?.[1]) }))
    },
    async compose(args) { await run('docker', ['compose', ...args], { cwd: dir, timeout: 10 * 60_000 }) },
    async ollamaModels() {
      try {
        const { data } = await axios.get('http://127.0.0.1:11434/api/tags', { timeout: 4000 })
        return (data?.models ?? []).map((m: any) => String(m.name))
      } catch { return null }
    },
    async pullModel(model) {
      // Minutes on a slow line: started, not awaited. The checklist shows it done once the model is there.
      const child = require('child_process').spawn('docker', ['exec', 'hyperprox-ollama', 'ollama', 'pull', model], { detached: true, stdio: 'ignore' })
      child.unref()
    },
    pveExporter: () => exporterStatus(),
    provisionPveExporter: () => provisionPveExporter({ access: pveAccessFromEnv() }),
    async dnsKey() {
      const c = await getProviderCredentials('dns', 'godaddy').catch(() => ({} as Record<string, string>))
      return { key: c.api_key, secret: c.api_secret }
    },
    async saveDnsKey(key, secret) { await setCredentials('dns', 'godaddy', { api_key: key, api_secret: secret }) },
    async testDnsKey(key, secret) { return (await new GoDaddyClient(key, secret).getDomains()).length },
    async setOllamaUrl(url) { await setCredential('ai', 'ollama', 'url', url, false) },
    syncTargets: () => syncTargets(),
    saveNodeLogin: (node, cred) => saveCredential(`node-${node}`, cred),
    pins: () => listPins(),
    presentedKey: (host, port) => probeHostKey(host, port, 5000),
    verifyHostKeys: by => verifyHomeHostKeys(by),
    promReady: async () => prometheusReadiness(await resolvePrometheusUrl()),
  }
}

// ── .env (plain settings only) ───────────────────────────────────────────────

function envGet(file: string, key: string): string | undefined {
  try {
    const m = new RegExp(`^${key}=['"]?([^'"\\n]*)`, 'm').exec(fs.readFileSync(file, 'utf8'))
    return m?.[1]
  } catch { return undefined }
}
function envSet(file: string, key: string, value: string): void {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const line = `${key}=${value}`
  const next = new RegExp(`^${key}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${key}=.*$`, 'm'), line) : `${text.replace(/\n?$/, '\n')}${line}\n`
  fs.writeFileSync(file, next, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}
export function composeProfiles(file: string): string[] {
  return (envGet(file, 'COMPOSE_PROFILES') ?? '').split(',').map(s => s.trim()).filter(Boolean)
}
function addProfile(file: string, profile: string): void {
  const p = composeProfiles(file)
  if (!p.includes(profile)) envSet(file, 'COMPOSE_PROFILES', [...p, profile].join(','))
}

// ── State ────────────────────────────────────────────────────────────────────

export function roll(rows: NodeRow[]): ItemState {
  const live = rows.filter(r => r.state !== 'not-applicable')
  if (!live.length) return 'not-applicable'
  // Unknown rows count neither way: the item is what the known rows say, or unknown if none is known.
  const known = live.filter(r => r.state !== 'unknown')
  if (!known.length) return 'unknown'
  if (known.every(r => r.state === 'done')) return known.length === live.length ? 'done' : 'partly'
  return known.some(r => r.state === 'done') ? 'partly' : 'not-done'
}

export async function checklistState(deps: ChecklistDeps = productionChecklistDeps()) {
  const det = await detectCluster(deps.hardware)
  const nodes = det.nodes
  const logins = Object.fromEntries(await Promise.all(nodes.map(async n => [n.node!, Boolean(await deps.hardware.login(n.node!))])))
  const q = new Map(hardware.QUESTIONS.map(x => [x.id, x]))
  const notes = new Map(hardware.applicableQuestions(nodes).map(x => [x.id, x.notes ?? []]))
  const items: ChecklistItem[] = []
  const base = (id: Exclude<ItemId, 'targets' | 'old-backups' | 'host-keys'>) => ({ id, ask: q.get(id)!.ask, what: q.get(id)!.what, notes: notes.get(id) ?? [] })
  const unknown = (n: NodeHardware) => n.source === 'proxmox-api' && !logins[n.node!]

  const health: NodeRow[] = nodes.map(n => n.nodeExporter === 'running'
    ? { node: n.node!, state: 'done', reason: 'answering on port 9100' }
    : { node: n.node!, state: 'not-done', reason: 'node_exporter is not answering' })
  items.push({ ...base('node-health'), rows: health, state: roll(health), needsNodeLogin: true,
    action: roll(health) === 'done' ? null : 'Install node_exporter where it is missing, one node at a time' })

  const power: NodeRow[] = nodes.map(n => n.rapl === 'none' ? { node: n.node!, state: 'not-applicable', reason: 'no power counters on this CPU' }
    : n.rapl === 'readable' ? { node: n.node!, state: 'done', reason: 'energy counters readable' }
    : n.rapl !== 'root-only' && unknown(n) ? { node: n.node!, state: 'unknown', reason: 'unknown until a node login is saved' }
    : { node: n.node!, state: 'not-done', reason: n.rapl === 'root-only' ? 'counters are root-only' : 'no power reading yet' })
  items.push({ ...base('power'), rows: power, state: roll(power), needsNodeLogin: true,
    action: ['done', 'not-applicable', 'unknown'].includes(roll(power)) ? null : 'Add the power rule where the counters are root-only' })

  const gpu: NodeRow[] = []
  for (const n of nodes) {
    if (!n.gpus.length) { gpu.push({ node: n.node!, state: 'not-applicable', reason: 'no GPU' }); continue }
    const words = n.gpus.map(hardware.gpuWords).join(', ')
    const parts: ItemState[] = []
    if (n.gpus.some(g => g.vendor === 'intel')) parts.push(n.intelExporter === 'running' ? 'done' : 'not-done')
    if (n.gpus.some(g => g.vendor === 'nvidia')) parts.push(n.nvidiaExporter === 'running' ? 'done' : 'not-done')
    if (n.gpus.some(g => g.vendor === 'amd')) parts.push(n.amdMetrics === 'on' ? 'done' : 'not-done')
    if (!parts.length) { gpu.push({ node: n.node!, state: 'not-applicable', reason: words }); continue }
    const st: ItemState = parts.every(p => p === 'done') ? 'done' : 'not-done'
    gpu.push({ node: n.node!, state: st, reason: `${words}: ${st === 'done' ? 'monitored' : 'no exporter answering'}` })
  }
  items.push({ ...base('gpu'), rows: gpu, state: roll(gpu), needsNodeLogin: true,
    action: ['done', 'not-applicable'].includes(roll(gpu)) ? null : 'Add the GPU exporter where it is missing' })

  if (hardware.applicableQuestions(nodes).some(x => x.id === 'igpu-access')) {
    const ig: NodeRow[] = nodes.map(n => n.igpuAccess === 'none' || (n.igpuAccess === null && !n.gpus.some(g => g.kind === 'integrated' && g.vendor !== 'nvidia'))
      ? { node: n.node!, state: 'not-applicable', reason: 'no built-in graphics' }
      : n.igpuAccess === 'open' ? { node: n.node!, state: 'done', reason: 'containers can use the built-in graphics' }
      : n.igpuAccess === 'closed' ? { node: n.node!, state: 'not-done', reason: 'only the render group can use them' }
      : { node: n.node!, state: 'unknown', reason: 'unknown until a node login is saved' })
    items.push({ ...base('igpu-access'), rows: ig, state: roll(ig), needsNodeLogin: true,
      action: ['done', 'not-applicable', 'unknown'].includes(roll(ig)) ? null : 'Open the built-in graphics to containers' })
  }

  // Done only when Prometheus answers a query; switched on but silent is a failure with its reason.
  const chartsOn = composeProfiles(deps.envFile).includes('monitoring')
  const prom = chartsOn ? await promReadiness(deps) : null
  const chartsState: ItemState = !chartsOn ? 'not-done' : prom!.ok ? 'done' : 'failed'
  items.push({ ...base('charts'), state: chartsState, needsNodeLogin: false,
    rows: prom ? [{ node: 'Prometheus', state: prom.ok ? 'done' : 'failed', reason: prom.reason }] : [],
    action: chartsState === 'done' ? null : chartsState === 'failed' ? 'Start Prometheus and Grafana again' : 'Start Prometheus and Grafana on this machine' })

  const exp = await deps.pveExporter().catch(() => ({ configured: false, readOnly: null }))
  const pveDone = exp.configured && exp.readOnly === true
  items.push({ ...base('proxmox-metrics'), rows: [], state: pveDone ? 'done' : 'not-done', needsNodeLogin: false,
    notes: exp.configured && exp.readOnly === false ? ['The exporter has a token that is not read-only. Pressing the button replaces it with a read-only one.'] : [],
    action: pveDone ? null : 'Make the read-only token and restart the exporter' })

  const dns = await deps.dnsKey()
  items.push({ ...base('dns'), rows: [], state: dns.key && dns.secret ? 'done' : 'not-done', needsNodeLogin: false,
    action: dns.key && dns.secret ? 'Replace the key' : 'Paste a key' })

  const models = await deps.ollamaModels()
  const aiDone = Boolean(models?.some(m => m.split(':')[0] === hardware.AI_MODEL.split(':')[0]))
  items.push({ ...base('ai'), rows: [], state: aiDone ? 'done' : 'not-done', needsNodeLogin: false,
    notes: models && !aiDone ? [`Ollama is running; the model (${hardware.AI_MODEL}) is not there yet. It may still be downloading.`] : [],
    action: aiDone ? null : `Start the bundled Ollama and download ${hardware.AI_MODEL}` })

  // Plaintext copies of .env that an earlier version kept when keys moved into the vault.
  const old = oldBackups(deps.envFile)
  if (old.length) {
    items.push({ id: 'old-backups', ask: 'Old plaintext copies of .env were found. Do you want HyperProx to shred them?', notes: [],
      what: 'An earlier version kept a copy of .env from before your keys moved into the vault. The vault has every key, so these copies are only a risk.',
      rows: old.map(f => ({ node: path.basename(f), state: 'not-done' as const, reason: 'plaintext, readable by root' })),
      state: 'not-done', needsNodeLogin: false, action: 'Shred them' })
  }

  // Host keys: a node's login is only sent to the key an admin confirmed (Terminal or here).
  items.push(await hostKeyItem(deps, nodes.map(n => n.node!), det.addresses))

  const ls = lastSync()
  items.push({ id: 'targets', ask: 'Metrics list kept up to date', automatic: true, notes: [],
    what: 'Always on: HyperProx adds new nodes and GPUs to Prometheus by itself, after setup and whenever a node joins.',
    rows: [], state: 'done', needsNodeLogin: false, action: 'Check now' ,
    ...(ls ? { notes: [`Last checked ${ls.at}.`] } : {}) })

  return { summary: det.summary, nodes, logins, items }
}

// ── Running an item ──────────────────────────────────────────────────────────

export interface Job {
  id: string
  item: ItemId
  status: 'running' | 'done' | 'failed'
  startedAt: string
  finishedAt?: string
  results: Array<{ node?: string; label: string; status: string; reason: string }>
  checks: Array<{ node?: string; status: string; reason: string }>
}

const jobs = new Map<string, Job>()
let active: Job | null = null

export function getJob(id: string): Job | undefined { return jobs.get(id) }
export function activeJob(): Job | null { return active }

export class ChecklistRefusal extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

/** Starts one item. One at a time: node changes never overlap. Returns at once; poll getJob(). */
export async function startItem(id: ItemId, body: any, by: string, deps: ChecklistDeps = productionChecklistDeps()): Promise<Job> {
  if (active) throw new ChecklistRefusal(`"${active.item}" is still running. Wait for it to finish.`, 409)
  if (!['node-health', 'power', 'gpu', 'igpu-access', 'charts', 'proxmox-metrics', 'dns', 'ai', 'targets', 'old-backups', 'host-keys'].includes(id)) throw new ChecklistRefusal('No such item', 404)
  // The DNS key is checked before the job exists, so a wrong key is an answer, not a failed job.
  if (id === 'dns') {
    const key = typeof body?.key === 'string' ? body.key.trim() : ''
    const secret = typeof body?.secret === 'string' ? body.secret.trim() : ''
    if (!key || !secret) throw new ChecklistRefusal('Paste both the API key and the secret.')
    let domains: number
    try { domains = await deps.testDnsKey(key, secret) }
    catch (e: any) { throw new ChecklistRefusal(`GoDaddy did not accept that key (${e?.response?.status ?? e?.message ?? 'no answer'}). Use a Production key.`) }
    await deps.saveDnsKey(key, secret)
    await auditCredentialUse('dns_key.save', 'dns:godaddy', { by, domains })
    const job: Job = { id: randomUUID(), item: id, status: 'done', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      results: [{ label: 'GoDaddy key', status: 'done', reason: `kept in the vault; ${domains} domain(s) found` }], checks: [] }
    jobs.set(job.id, job)
    return job
  }
  const job: Job = { id: randomUUID(), item: id, status: 'running', startedAt: new Date().toISOString(), results: [], checks: [] }
  jobs.set(job.id, job)
  active = job
  void runItem(job, by, deps).then(
    () => { job.status = job.results.some(r => r.status === 'failed') || job.checks.some(c => c.status === 'failed') ? 'failed' : 'done' },
    (e: any) => { job.status = 'failed'; job.results.push({ label: id, status: 'failed', reason: e?.message ?? String(e) }) },
  ).finally(() => { job.finishedAt = new Date().toISOString(); active = null })
  return job
}

async function runItem(job: Job, by: string, deps: ChecklistDeps): Promise<void> {
  const id = job.item
  if (id === 'host-keys') {
    const verdicts = await (deps.verifyHostKeys ?? verifyHomeHostKeys)(by)
    if (!verdicts.length) job.results.push({ label: 'Host keys', status: 'already', reason: 'every node is already verified or confirmed' })
    for (const r of verdicts) job.results.push({ node: r.node, label: 'Host key', status: VERDICT_STATUS[r.state], reason: r.why })
    return
  }
  if (id === 'node-health' || id === 'power' || id === 'gpu' || id === 'igpu-access') {
    const det = await detectCluster(deps.hardware)
    const plan = hardware.planNodeWork({ [id]: true }, det.nodes)
    if (!plan.length) { job.results.push({ label: id, status: 'already', reason: 'nothing to do on any node' }) }
    // Every node the plan touches needs a login; a node without one is reported, not guessed at.
    const creds = new Map<string, TerminalCredential | null>()
    for (const p of plan) if (!creds.has(p.node)) creds.set(p.node, await deps.hardware.login(p.node))
    const runnable = plan.filter(p => creds.get(p.node))
    for (const p of plan.filter(p => !creds.get(p.node))) {
      job.results.push({ node: p.node, label: hardware.STEP_LABEL[p.step], status: 'skipped', reason: 'no node login saved for this node' })
    }
    const results = await hardware.runNodeWork(runnable, async (node, script) => {
      await auditCredentialUse('node_login.use', `node:${node}`, { by, purpose: `setup checklist: ${id}` })
      return deps.hardware.exec(det.addresses[node] ?? node, creds.get(node)!, script)
    })
    for (const r of results) job.results.push({ node: r.node, label: r.label, status: r.status, reason: r.reason })
    await deps.syncTargets().catch(() => undefined)
    // Two scrapes, so a power rate exists before it is checked.
    await new Promise(r => setTimeout(r, Number(process.env.HPX_CHECKLIST_SETTLE_MS ?? 35_000)))
    const fresh = await detectCluster(deps.hardware)
    if (id === 'igpu-access') {
      for (const n of fresh.nodes.filter(x => plan.some(p => p.node === x.node))) {
        job.checks.push(n.igpuAccess === 'open' ? { node: n.node!, status: 'ok', reason: 'renderD128 reads 666' } : { node: n.node!, status: 'failed', reason: `still ${n.igpuAccess ?? 'unknown'}` })
      }
      return
    }
    for (const c of await hardware.verifyOutcome({ [id]: true }, fresh.nodes, deps.promQuery)) job.checks.push(c)
    return
  }
  if (id === 'charts') {
    addProfile(deps.envFile, 'monitoring')
    await deps.compose(['up', '-d', 'prometheus', 'grafana', 'pve-exporter'])
    await deps.syncTargets().catch(() => undefined)
    job.results.push({ label: 'Charts', status: 'done', reason: 'Prometheus and Grafana started' })
    // The outcome, not the command: Prometheus has to answer a query. It takes a few seconds to come up.
    let ready = await promReadiness(deps)
    for (let i = 0; !ready.ok && i < Number(process.env.HPX_CHECKLIST_PROM_TRIES ?? 6); i++) {
      await new Promise(r => setTimeout(r, Number(process.env.HPX_CHECKLIST_SETTLE_MS ?? 5_000)))
      ready = await promReadiness(deps)
    }
    job.checks.push({ status: ready.ok ? 'ok' : 'failed', reason: ready.reason })
    // A Grafana that just set up a new database gets the vault's admin password, never admin/admin.
    const g = await ensureGrafanaAdmin(undefined, by).catch((e: any) => `failed: ${e?.message ?? e}`)
    if (g === 'applied' || g === 'generated') job.results.push({ label: 'Grafana admin password', status: 'done', reason: 'set from the vault' })
    else if (typeof g === 'string' && g.startsWith('failed')) job.results.push({ label: 'Grafana admin password', status: 'failed', reason: g })
    return
  }
  if (id === 'proxmox-metrics') {
    await deps.provisionPveExporter()
    const s = await deps.pveExporter()
    job.results.push({ label: 'Proxmox metrics', status: s.configured && s.readOnly ? 'done' : 'failed',
      reason: s.configured && s.readOnly ? 'read-only token in place' : 'the token could not be confirmed read-only' })
    return
  }
  if (id === 'ai') {
    addProfile(deps.envFile, 'ai')
    await deps.compose(['up', '-d', '--no-deps', 'ollama'])
    await deps.setOllamaUrl('http://127.0.0.1:11434')
    await deps.pullModel(hardware.AI_MODEL)
    job.results.push({ label: 'Local AI', status: 'done', reason: `Ollama started; ${hardware.AI_MODEL} is downloading (about 2 GB)` })
    return
  }
  if (id === 'old-backups') {
    for (const f of oldBackups(deps.envFile)) {
      try { shred(f); job.results.push({ label: path.basename(f), status: 'done', reason: 'overwritten and deleted (copies may remain in snapshots or backups)' }) }
      catch (e: any) { job.results.push({ label: path.basename(f), status: 'failed', reason: e?.message ?? String(e) }) }
    }
    await auditCredentialUse('env_backup.shred', 'system:env', { by, files: job.results.map(r => r.label) })
    return
  }
  if (id === 'targets') {
    const r: any = await deps.syncTargets()
    const n = Object.values(r?.added ?? {}).reduce((a: number, x: any) => a + x.length, 0)
    job.results.push({ label: 'Metrics list', status: 'done', reason: n ? `${n} target(s) added` : 'already up to date' })
  }
}

// ── Host keys ────────────────────────────────────────────────────────────────

const SOURCE_WORDS: Record<string, string> = {
  terminal: 'confirmed in the Terminal', confirmed: 'confirmed by an admin', verified: 'verified automatically',
  wizard: 'learned by the setup wizard, not verified yet', api: 'learned by HyperProx on first use, not verified yet',
  'terminal-auto': 'learned when it was opened in the Terminal, not verified yet', none: 'pinned before HyperProx kept track, not verified yet',
}
const VERDICT_STATUS: Record<NodeVerdict['state'], string> = { verified: 'done', already: 'already', 'no-evidence': 'skipped', blocked: 'failed' }

const pinWords = (p: PinRow) => p.source === 'verified' ? evidenceWords(p.evidence ?? null) : `${p.fingerprint}: ${SOURCE_WORDS[p.source ?? 'none']}`

async function hostKeyItem(deps: ChecklistDeps, nodes: string[], addrs: Record<string, string>): Promise<ChecklistItem> {
  // A remote server's pins are scoped to it and shown on its own Edit page, not here.
  const pins = (await deps.pins().catch(() => [])).filter(p => !isRemotePinId(p.id))
  const byId = new Map(pins.map(p => [p.id, p]))
  const rows: NodeRow[] = await Promise.all(nodes.map(async node => {
    const host = addrs[node] ?? node, port = 22
    const p = byId.get(pinId(host, port))
    byId.delete(pinId(host, port))
    if (p) return { node, host, port, fingerprint: p.fingerprint, state: p.confirmed ? 'done' as const : 'not-done' as const, reason: pinWords(p) }
    const now = await deps.presentedKey(host, port).catch(() => null)
    return now ? { node, host, port, fingerprint: now, state: 'not-done' as const, reason: `${now}: not pinned yet` }
      : { node, host, port, state: 'not-done' as const, reason: 'not pinned yet, and it did not answer on port 22' }
  }))
  // Any other pin nobody confirmed (a guest or a hand-added host), so none is trusted unseen.
  for (const p of byId.values()) {
    if (p.confirmed) continue
    const m = /^(.*):(\d+)$/.exec(p.id)
    rows.push({ node: p.id, host: m ? m[1] : p.id, port: m ? Number(m[2]) : 22, fingerprint: p.fingerprint, state: 'not-done', reason: pinWords(p) })
  }
  const state = roll(rows)
  return {
    id: 'host-keys', ask: "Are your nodes' SSH host keys verified?", notes: [], rows, state, needsNodeLogin: false,
    action: state === 'done' || state === 'not-applicable' ? null : 'Verify automatically',
    what: 'HyperProx sends a node its login only when the node shows a key that is verified or confirmed. After the owner signs in it ' +
      "verifies them by itself, with no node login, against what was read on a node: the cluster's record, that node's own key files, " +
      "and every other node's own key files, read over the cluster's own SSH trust (bootstrap.sh does this; so does the command below). " +
      'A node it cannot prove that way (an older install, or a node that did not answer then) stays not pinned: press Verify automatically ' +
      'after adding a node login (it then proves the rest through nodes already verified, or over Tailscale or WireGuard), or run the ' +
      "command below once on any node's own console (its screen, IPMI or iKVM, or an SSH session whose key you already verified; not this " +
      "HyperProx's Terminal on a key that is not verified yet) and paste what it prints.",
    ...(state === 'done' || state === 'not-applicable' ? {} : { command: ANCHOR_COMMAND }),
  }
}

/**
 * Verify the home nodes' keys (lib/hostkey-verify.ts), with their saved logins. `onlyIfNeeded`: do nothing when every
 * node is already verified or confirmed (the run after each owner sign-in).
 */
export async function verifyHomeHostKeys(by: string, o: { onlyIfNeeded?: boolean; hardware?: HardwareDeps; verify?: VerifyDeps } = {}): Promise<NodeVerdict[]> {
  // Cheap first: with no pin left unverified there is nothing to do, and Proxmox is not asked anything. (A node
  // HyperProx has never connected to has no pin; its first connection pins it and schedules this run.)
  if (o.onlyIfNeeded && !(await listPins().catch(() => [])).some(p => !p.confirmed && !isRemotePinId(p.id))) return []
  const hw = o.hardware ?? productionHardwareDeps()
  const [names, addrs] = await Promise.all([hw.nodes(), hw.addresses()])
  if (o.onlyIfNeeded) {
    const open = await Promise.all(names.map(async n => {
      const host = addrs[n] ?? n
      const [pin, src] = await Promise.all([pinnedKey(host, 22), pinSource(host, 22)])
      return !pin || !isConfirmedSource(src)
    }))
    if (!open.some(Boolean)) return []
  }
  const nodes = await Promise.all(names.map(async n => ({ name: n, address: addrs[n] ?? n, cred: await hw.login(n), alsoKnownAs: addrs[n] && addrs[n] !== n ? [n] : [] })))
  return verifyNodes({ cluster: 'Home cluster', anchorScope: 'home', scope: 'home', nodes, by }, o.verify ?? productionVerifyDeps())
}

/**
 * The output of ANCHOR_COMMAND, run by the admin on one of their nodes and pasted here: kept as the home cluster's
 * anchor (public keys only), then verified against as usual. Re-confirmed like every change here.
 */
export async function saveHostKeyAnchor(input: any, by: string, o: { replaceInstaller?: boolean } = {}): Promise<{ nodes: string[]; replaced: string[]; added: string[]; skipped: Array<{ node: string; why: string }> }> {
  const output = typeof input?.output === 'string' ? input.output : ''
  if (!output.trim()) throw new ChecklistRefusal('Paste what the command printed.')
  try {
    const r = await saveAnchors('home', output, 'pasted', o)
    await auditCredentialUse('host_key.anchor.save', 'cluster:home', { by, source: 'pasted', nodes: r.nodes, added: r.added, skipped: r.skipped })
    if (r.replaced.length) await anchorReplaced('Home cluster', 'cluster:home', by, r.replaced)
    return r
  } catch (e: any) {
    if (e instanceof VerifyRefusal) throw new ChecklistRefusal(e.message, 422)
    if (e instanceof AnchorReplaceRefusal) throw Object.assign(new ChecklistRefusal(e.message, 409), { code: 'anchor_installer' })
    throw e
  }
}

/** A pasted anchor replaced different keys: audited, and an alert goes out (it may be a rebuild, or not). */
export async function anchorReplaced(cluster: string, resource: string, by: string, nodes: string[]): Promise<void> {
  await auditCredentialUse('host_key.anchor.replace', resource, { by, nodes })
  await publish({ type: 'hostkey.anchor', severity: 'warning', title: `${cluster}: the host keys HyperProx checks against were replaced`,
    lines: [`By ${by}, for ${nodes.join(', ')}. If you did not just paste a node's output yourself, check the keys on each node's own console.`],
    where: 'Setup checklist', link: '/settings/setup-checklist', fingerprint: `hostkey-anchor:${resource}` }).catch(() => undefined)
}

/** Confirm one fingerprint the admin compared on the machine. It must be the key presented right now. */
export async function confirmHostKey(input: any, by: string, deps: ChecklistDeps = productionChecklistDeps()) {
  const host = typeof input?.host === 'string' ? input.host.trim() : ''
  const port = Number(input?.port ?? 22)
  const fingerprint = typeof input?.fingerprint === 'string' ? input.fingerprint.trim() : ''
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new ChecklistRefusal('host and port are required')
  try {
    const r = await confirmPin(host, port, fingerprint, deps.presentedKey)
    await auditCredentialUse('host_key.confirm', `host:${host}:${port}`, { by, fingerprint, result: r })
    return { host, port, fingerprint, result: r }
  } catch (e: any) {
    if (e instanceof PinConfirmRefusal) throw new ChecklistRefusal(e.message, 409)
    throw new ChecklistRefusal(`Could not read the key ${host}:${port} presents: ${e?.message ?? e}`, 502)
  }
}

// ── Old plaintext backups ────────────────────────────────────────────────────

export function oldBackups(envFile: string): string[] {
  const dir = path.dirname(envFile)
  try {
    // lstat, never stat: a symlink named like a backup is not followed, listed or shredded.
    return fs.readdirSync(dir).filter(f => /^\.env\.pre-vault(\.\d+)?$/.test(f)).map(f => path.join(dir, f))
      .filter(f => fs.lstatSync(f).isFile()).sort()
  } catch { return [] }
}

/** Overwrite with random bytes (twice), flush, then delete. Copies in snapshots or backups are not reached. */
export function shred(file: string): void {
  const st = fs.lstatSync(file)
  if (!st.isFile()) throw new Error(`${path.basename(file)} is not a plain file, so it was left alone`)
  const size = st.size
  for (let pass = 0; pass < 2; pass++) {
    const fd = fs.openSync(file, 'r+')
    try { fs.writeSync(fd, require('crypto').randomBytes(Math.max(size, 1)), 0, Math.max(size, 1), 0); fs.fsyncSync(fd) }
    finally { fs.closeSync(fd) }
  }
  fs.unlinkSync(file)
}

// ── The node login ───────────────────────────────────────────────────────────

/**
 * One login for every node, asked once. Tested on each node (pveversion: read-only, and it proves the
 * host is a Proxmox node) before it is stored, and stored in the vault per node only where it worked.
 */
export async function saveNodeLoginForAll(input: any, by: string, deps: ChecklistDeps = productionChecklistDeps()) {
  const username = typeof input?.username === 'string' ? input.username.trim() : ''
  const password = typeof input?.password === 'string' && input.password ? input.password : undefined
  const privateKey = typeof input?.privateKey === 'string' && input.privateKey.trim() ? input.privateKey : undefined
  const passphrase = typeof input?.passphrase === 'string' && input.passphrase ? input.passphrase : undefined
  if (!username) throw new ChecklistRefusal('Enter the user name you sign in to your nodes with (usually root).')
  if (!password && !privateKey) throw new ChecklistRefusal('Enter the password, or paste a private key.')
  const cred: TerminalCredential = { username, password, privateKey, passphrase, port: 22 } as any
  const [names, addrs] = await Promise.all([deps.hardware.nodes(), deps.hardware.addresses()])
  const rows: Array<{ node: string; ok: boolean; reason: string }> = []
  for (const node of names) {
    try {
      const r = await deps.hardware.exec(addrs[node] ?? node, cred, 'pveversion\n', 20_000)
      if (r.code !== 0 || !/pve-manager/.test(r.output)) { rows.push({ node, ok: false, reason: 'signed in, but this does not look like a Proxmox node' }); continue }
      await deps.saveNodeLogin(node, cred)
      await auditCredentialUse('node_login.save', `node:${node}`, { by, source: 'setup checklist' })
      rows.push({ node, ok: true, reason: r.output.trim().split('\n')[0] })
    } catch (e: any) {
      rows.push({ node, ok: false, reason: /authentication/i.test(e?.message ?? '') ? 'that login was not accepted' : `could not connect: ${e?.message ?? e}` })
    }
  }
  return rows
}
