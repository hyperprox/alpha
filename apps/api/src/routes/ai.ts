// =============================================================================
//  HyperProx — AI Deployment Wizard Routes
//  Natural language → template fields → questions → a server-held run → execute
//
//  The model only reads the template's extractable fields out of the request;
//  derive and validate in the template fill and check everything else against
//  the cluster. What the browser holds is a plan id: the run that executes is
//  the server's copy, derived and validated again against fresh facts first.
// =============================================================================

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { randomUUID }         from 'crypto'
import { setCredential }      from '../lib/credentials'
import { executeDeployJob, getJob, type DeployRun, type JobState } from '../lib/wizard-executor'
import { gatherTemplateFacts } from '../lib/ai/facts'
import { PreparedStore }      from '../lib/ai/prepared'
import { currentContext, type RequestContext } from '../lib/auth'

import { startLoop, type Extraction, type IntentResult, type LoopDeps } from '../lib/ai/loop'
import { matchIntent, NO_TASK_ANSWER } from '../lib/ai/intent'
import { answerQuestion, type AskSource } from '../lib/ai/ask'
import { coreSources, pluginSources, type CertLite } from '../lib/ai/ask-sources'
import { PLUGINS }            from '../plugins'
import { pveFromEnv, connectionKey } from '../lib/pve-env'
import { listClusters, clusterRow, HOME_ID } from '../lib/clusters/registry'
import { runInCluster, currentClusterId } from '../lib/clusters/context'
import { readPanel, livePromQuery } from '../lib/clusters/overview'
import { jobStore, previewCopy, startCopy, kickCopies } from '../lib/clusters/files'
import { scanCluster }        from '../lib/clusters/scan'
import { previewMonitoring, applyMonitoring } from '../lib/clusters/monitoring'
import { power, snapshot, backupNow, backupStorages, destroy } from '../lib/clusters/guest-actions'
import { isReconfirmed }      from '../lib/auth'
import { auditCredentialUse } from '../lib/audit'
import type { Role }          from '../lib/roles'
import { isQuestionPrompt }   from '../lib/ai/intent'
import { resolveTargets, promptOn, type ClusterRef } from '../lib/ai/clusters'
import { perClusterSources, homeOnlySource, answerAcross, boundTo, type ClusterSourceDeps } from '../lib/ai/cluster-sources'
import { parseAction, prepareAction, applyAction, type ActionPlan, type PrepareDeps, type ApplyDeps } from '../lib/ai/actions'
import type { ModelCall }     from '../lib/ai/extract'
import { runPluginSummary }   from '../lib/plugin-host'
import { isUnlocked }         from '../lib/vault/state'
import { productionCertsService } from '../lib/certs/service'
import { extractFields }      from '../lib/ai/extract'
import { getTemplate }        from '../lib/ai/templates'
import { deployService, toDeployFields, type DeployFields } from '../lib/ai/templates/deploy-service'
import type { Fields, TaskTemplate, TemplateFacts, TemplateSettings } from '../lib/ai/templates/types'
import { wizardRecipes }      from '../lib/catalogue'
import { zoneFor }            from '../lib/dns-zones'
import { qnapSource, alertsSource, notifySource, housesSource, sitesSource, siteMetricsSource, toChannelLite, type NasEntry, type HouseRead, type SiteLite } from '../lib/ai/home-sources'
import { NOT_COLLECTED, type SiteMetricsSource } from '../lib/ai/site-metrics'
import { parseHomeAction, prepareHomeAction, applyHomeAction, isTokenSid, type HomePlan, type HomePrepareDeps, type HomeApplyDeps, type HomeSite, type HomeNas } from '../lib/ai/home-actions'
import { isWebsiteRequest, websiteTurn, asChoices, WebsiteDrafts, type WebsitePlanDeps } from '../lib/ai/templates/website'
import { qnapService } from '../lib/qnap'
import { fetchPrometheusAlerts, FileForwarderState, notForwardedFromEnv } from '../lib/alerts/forwarder'
import { getNotifyService } from '../lib/notify'
import { getCluster } from '../lib/clusters/registry'
import { productionHAControl } from './ha-control'
import { listSites, getSite, siteHealth, realPublishDeps } from '../lib/sites'
import { realRun } from './sites'
import { findRecipe } from '../lib/catalogue'
import { wizardView, placementFor, nextIdOf, previewInstall } from '../lib/catalogue-installer'
import { runPluginDetail } from '../lib/plugin-host'
import type { HAControlService } from '../lib/ha-control/service'
import {
  callStructured, listProviders, activeProvider, setActiveProvider,
  type ProviderId, type ProviderInfo,
} from '../lib/ai/providers'

const PROVIDER_IDS: ProviderId[] = ['anthropic', 'openai', 'ollama']

function isProvider(v: unknown): v is ProviderId {
  return typeof v === 'string' && (PROVIDER_IDS as string[]).includes(v)
}

/**
 * What the routes reach outside themselves for. Tests pass fakes; production
 * takes the defaults below.
 */
export interface AiRouteDeps {
  facts(): Promise<TemplateFacts>
  settings(): Promise<TemplateSettings>
  /** Which template a request is for; the provider is the one this request chose. */
  intent(prompt: string, provider?: ProviderId, model?: string): Promise<IntentResult>
  /** The template's extractable fields, read from the user's words. */
  extract(t: TaskTemplate, text: string, facts: TemplateFacts,
          opts?: { asking?: { field: string; question: string }; provider?: ProviderId; model?: string }): Promise<Extraction>
  execute(jobId: string, run: DeployRun): Promise<void>
  /** Runs the server derived and validated, waiting to be executed by id. */
  prepared: PreparedStore<DeployRun>
  /** A job by id, for the progress endpoint. */
  job(jobId: string): JobState | undefined
  /** Who is asking; a run can only be executed, and its job read, by the user it was made for. */
  whoami(req: FastifyRequest): string
  /** Keeps the model picked on the AI page as the stored Ollama model. */
  saveModel(model: string): Promise<void>
  activeProvider(): Promise<ProviderId>
  listProviders(): Promise<ProviderInfo[]>
  /** The read-only knowledge sources a question can be answered from; built per request from its facts. */
  sources(facts: TemplateFacts, prisma?: unknown): AskSource[]
  /** The model call for a question. */
  askCall(provider?: ProviderId, model?: string): ModelCall
  /** Every cluster, home first (lib/clusters/registry.ts). */
  clusters(): ClusterRef[]
  /** The cluster this request is for: its X-HyperProx-Cluster header or ?cluster=, as lib/clusters/context.ts resolved it. */
  currentCluster(): string
  /** Any cluster's sources, each bound to that cluster. `homeFacts` feeds home's DNS and proxy sources. */
  clusterSources(c: ClusterRef, homeFacts: TemplateFacts | null, prisma?: unknown): AskSource[]
  /** Runs fn as a request for cluster `id`. */
  inCluster<T>(id: string, fn: () => Promise<T>): Promise<T>
  /** Who is asking, for the role and re-confirmation checks. */
  session(): { sid: string; role: Role; email?: string } | undefined
  /** Actions the assistant prepared, waiting to be applied by id. */
  actionPlans: PreparedStore<ActionPlan>
  prepareDeps(): Omit<PrepareDeps, 'prepared'>
  applyDeps(): Omit<ApplyDeps, 'prepared' | 'owner' | 'ctx' | 'requestCluster'>
  /** Pull a static site, run a SMART test: prepared here, applied through /actions/apply. */
  homePlans: PreparedStore<HomePlan>
  /** The NAS and site names a request can name, so "restart nas1" is the NAS and never a guest. */
  homeNames(): Promise<{ nas: string[]; sites: string[] }>
  homePrepareDeps(): Omit<HomePrepareDeps, 'prepared'>
  homeApplyDeps(): Omit<HomeApplyDeps, 'prepared' | 'owner' | 'ctx' | 'requestCluster' | 'homeId'>
  /** The create-a-website template: its drafts (one per person) and the wizard's planning code. */
  websiteDrafts: WebsiteDrafts
  websiteDeps(): WebsitePlanDeps
}

// ── What is attached to home, read for the assistant ─────────────────────────

let haService: HAControlService | undefined
const ha = () => (haService ??= productionHAControl())
const beside = (clusterId: string | null) => { const c = clusterId ? getCluster(clusterId) : null; return c && c.kind === 'remote' ? c.name : null }

async function nasEntries(): Promise<NasEntry[]> {
  const svc = qnapService()
  const list = await svc.instances.list()
  return Promise.all(list.map(async m => {
    try { return { id: m.id, name: m.name, beside: beside(m.clusterId), diskTempWarnC: m.diskTempWarnC, reading: await svc.reading(m.id), error: null } }
    catch (e: any) { return { id: m.id, name: m.name, beside: beside(m.clusterId), diskTempWarnC: m.diskTempWarnC, reading: null, error: String(e?.message ?? 'no answer').slice(0, 160) } }
  }))
}

async function houses(viewer: boolean): Promise<HouseRead[]> {
  const svc = ha()
  return Promise.all((await svc.instances.list()).map(async m => {
    try { const d = await svc.devices(m.id, null, { viewer }); return { name: m.name, beside: beside(m.clusterId), areas: d.areas, error: null } }
    catch (e: any) { return { name: m.name, beside: beside(m.clusterId), areas: null, error: String(e?.message ?? 'no answer').slice(0, 160) } }
  }))
}

async function siteLites(): Promise<SiteLite[]> {
  return (await listSites()).map(s => ({ id: s.id, name: s.name, kind: s.recipeId, kindName: findRecipe(s.recipeId)?.name ?? s.recipeId,
    domain: s.domain ?? null, url: s.url ?? null, vmid: s.vmid, node: s.node, hasVault: !!s.vault }))
}

const probe = (url: string) => fetch(url, { signal: AbortSignal.timeout(6000) })
  .then(async r => ({ status: r.status, body: (await r.text().catch(() => '')).slice(0, 200_000) })).catch(() => null)

/** Where site metrics come from. TODO(site-metrics): an adapter over lib/site-metrics once it is on main. */
const siteMetrics: SiteMetricsSource = NOT_COLLECTED

/** Built on the first certificate question and kept: its inventory cache is per instance. */
let certsService: ReturnType<typeof productionCertsService> | undefined

function defaultDeps(): AiRouteDeps {
  return {
    facts: () => gatherTemplateFacts(),
    settings: async () => ({ bridge: 'vmbr0' }),
    intent: (prompt, provider, model) =>
      matchIntent(prompt, { call: r => callStructured(r, provider, undefined, model ? { model } : {}) }),
    extract: (t, text, facts, opts = {}) =>
      extractFields(t, text, facts, {
        asking: opts.asking,
        call: r => callStructured(r, opts.provider, undefined, opts.model ? { model: opts.model } : {}),
      }),
    execute: executeDeployJob,
    prepared: new PreparedStore<DeployRun>(),
    job: getJob,
    whoami: () => ownerOf(currentContext()),
    saveModel: model => setCredential('ai', 'ollama', 'model', model, false),
    activeProvider,
    listProviders,
    sources: (facts, prisma) => productionClusterSources(homeRef(), facts, prisma),
    askCall: (provider, model) => r => callStructured(r, provider, undefined, model ? { model } : {}),
    clusters: () => listClusters().map(c => ({ id: c.id, name: c.name, kind: c.kind })),
    currentCluster: currentClusterId,
    clusterSources: (c, facts, prisma) => productionClusterSources(c, facts, prisma),
    inCluster: (id, fn) => runInCluster(id, fn),
    session: () => { const c = currentContext(); return c ? { sid: c.sid, role: c.role, email: c.email } : undefined },
    actionPlans: new PreparedStore<ActionPlan>(15 * 60_000),
    prepareDeps: () => ({
      inCluster: (id, fn) => runInCluster(id, fn),
      pve: () => pveFromEnv(),
      row: clusterRow,
      connection: connectionKey,
      unlocked: isUnlocked,
      backupStorages: node => backupStorages(pveFromEnv(), node),
      // Every collector the scan finds available, as the Edit server step offers them by default.
      monitoringPreview: async (id, owner, kind) => {
        const p = await previewMonitoring(id, owner, kind, { 'server-metrics': true, 'amd-gpu': true, 'intel-gpu': true })
        return { planId: p.planId, steps: p.steps }
      },
      copyPreview: (owner, input) => previewCopy(owner, input),
      nodes: async () => ((await pveFromEnv().fetchStrict<any[]>('/nodes')) ?? []).filter(n => n?.status === 'online').map(n => String(n.node)),
      now: () => new Date(),
    }),
    applyDeps: () => ({
      row: clusterRow,
      connection: connectionKey,
      unlocked: isUnlocked,
      reconfirmed: sid => isReconfirmed(sid),
      inCluster: (id, fn) => runInCluster(id, fn),
      pve: () => pveFromEnv(),
      ops: {
        power: (pve, g, a) => power({ pve }, g, a),
        snapshot: (pve, g, name) => snapshot({ pve }, g, name),
        backupNow: (pve, g, storage) => backupNow({ pve }, g, storage),
        destroy: (pve, g, name) => destroy({ pve }, g, name),
      },
      applyMonitoring: (planId, owner, clusterId) => applyMonitoring(planId, owner, undefined, clusterId),
      // Started now, not at the runner's next tick.
      startCopy: async (previewId, owner) => { const j = await startCopy(previewId, owner, 'assistant'); kickCopies(); return j },
      audit: auditCredentialUse,
    }),
    homePlans: new PreparedStore<HomePlan>(15 * 60_000),
    homeNames: async () => {
      const [nas, sites] = await Promise.all([qnapService().instances.list().catch(() => []), listSites().catch(() => [])])
      return { nas: nas.map(n => n.name), sites: sites.flatMap(s => [s.name, s.domain ?? ''].filter(Boolean)) }
    },
    homePrepareDeps: () => ({
      unlocked: isUnlocked,
      sites: async (): Promise<HomeSite[]> => (await listSites()).map(s => ({ id: s.id, name: s.name, recipeId: s.recipeId, domain: s.domain ?? null })),
      nas: async (): Promise<HomeNas[]> => (await nasEntries()).map(n => ({ id: n.id, name: n.name, disks: n.reading ? n.reading.disks.filter(x => x.model || x.sizeBytes).map(x => ({ bay: x.bay, model: x.model })) : null })),
    }),
    homeApplyDeps: () => ({
      unlocked: isUnlocked,
      reconfirmed: sid => isReconfirmed(sid),
      site: async id => { const s = await getSite(id); return s ? { id: s.id, name: s.name, recipeId: s.recipeId, domain: s.domain ?? null } : undefined },
      // The same script the Sites page's Pull now runs (routes/sites.ts).
      pull: async id => { const s = await getSite(id); if (!s) throw new Error('No such site.'); return realRun(s, 'set -e\n/usr/local/bin/site-pull') },
      smart: (nasId, bay, actor) => qnapService().act(nasId, { action: 'smart_test', bay }, { ...actor, token: null }, false),
      audit: auditCredentialUse,
    }),
    websiteDrafts: new WebsiteDrafts(),
    websiteDeps: () => ({
      recipe: id => findRecipe(id),
      domains: async () => {
        const dns = await realPublishDeps().dns().catch(() => null)
        if (!dns) return null
        return ((await dns.getDomains().catch(() => [])) ?? []).filter(x => !x.status || /active/i.test(x.status)).map(x => String(x.domain).toLowerCase())
      },
      proxies: () => realPublishDeps().proxy.instances(),
      // The wizard's Placement step: its recommended node and storage, a bridge with a gateway, the next free ID.
      place: async (recipe, need) => {
        const { view } = await wizardView()
        const placed = placementFor(recipe, need, view)
        const rec = placed.recommendation
        if (!rec) return { error: `No node can take it: ${placed.nodes.map(n => `${n.node} (${n.verdict.why[0] ?? 'not usable'})`).join(', ') || 'no node is online'}.` }
        const node = view.nodes.find(n => n.node === rec.node)
        const bridge = node?.bridges.find(b => b.gateway) ?? node?.bridges[0]
        if (!bridge) return { error: `${rec.node} has no network bridge.` }
        return { node: rec.node, storage: rec.storage, bridge: bridge.iface, vmid: nextIdOf(view), reason: rec.reason }
      },
      preview: (input, owner) => previewInstall(input, owner),
    }),
  }
}

const homeRef = (): ClusterRef => {
  const h = listClusters().find(c => c.kind === 'home')
  return { id: HOME_ID, name: h?.name ?? 'Home cluster', kind: 'home' }
}

/**
 * The knowledge sources for one cluster, read through that cluster's own client. Home: the core sources
 * (cluster, DNS, proxy, certificates, backups), the per-cluster ones (status, GPUs, monitoring, copies,
 * hardware) and the plug-ins. A remote: the per-cluster ones, and one that says which features are home-only.
 */
function productionClusterSources(c: ClusterRef, facts: TemplateFacts | null, prisma?: unknown): AskSource[] {
  const fetchStrict = <T,>(p: string) => runInCluster(c.id, () => pveFromEnv().fetchStrict<T>(p))
  const d: ClusterSourceDeps = {
    inCluster: (id, fn) => runInCluster(id, fn),
    fetchStrict,
    panel: ref => runInCluster(ref.id, async () => {
      const info = listClusters().find(x => x.id === ref.id)
      if (!info) throw new Error('That cluster was removed.')
      return readPanel(info, { pve: () => pveFromEnv(), prom: livePromQuery, now: Date.now })
    }),
    copies: () => jobStore().list(),
    scan: id => scanCluster(id, { useLogin: false }),
    monitoring: id => clusterRow(id)?.monitoring ?? {},
    nameOf: id => clusterRow(id)?.name ?? 'a removed cluster',
  }
  const extra = perClusterSources(c, d)
  if (c.kind === 'remote') return [...extra, homeOnlySource(c)]
  const role = currentContext()?.role
  const certs = async (): Promise<CertLite[]> => {
    const svc = (certsService ??= productionCertsService(prisma as any, () => {}))
    return (await svc.overview(false)).inventory.map(e => ({ names: e.names, daysLeft: e.daysLeft, notAfter: e.notAfter, verdict: e.verdict, source: e.source }))
  }
  // What is attached to HyperProx itself: every NAS, the alerts, notification channels, every house, the websites.
  // Before the per-cluster sources, so "is my NAS healthy" is the NAS and not the cluster's network storage.
  const attached: AskSource[] = [
    qnapSource({ list: nasEntries, role, unlocked: isUnlocked }),
    alertsSource({ fetch: () => fetchPrometheusAlerts(), state: () => new FileForwarderState().load(), notForwarded: () => notForwardedFromEnv(), clusterName: id => getCluster(id)?.name ?? null }),
    notifySource({ role, channels: async () => {
      const svc = getNotifyService()
      if (!svc) return null
      // Only the fields a person may read about a channel: never its mask, chat id, URL or token.
      return (await svc.listChannels()).map(toChannelLite)
    } }),
    housesSource({ houses, role, unlocked: isUnlocked }),
    sitesSource({
      role, sites: siteLites,
      health: async id => {
        const s = await getSite(id)
        if (!s) return { container: null, public: null }
        const checks = await siteHealth(s, probe)
        const pub = s.url ? checks.find(x => x.url.startsWith(s.url!)) : undefined
        const ct = s.localUrl ? checks.find(x => x.url.startsWith(s.localUrl!)) : undefined
        return { container: ct ? ct.ok : null, public: pub ? { ok: pub.ok, detail: pub.detail } : null }
      },
      certs: async () => (isUnlocked() ? certs() : null),
    }),
    siteMetricsSource({ metrics: siteMetrics, sites: siteLites, role }),
  ]
  // Home's own sources (cluster, DNS, proxy, certificates, backups, plug-ins) are read in home's context whatever
  // cluster this request is for: a certificate inventory built while a remote is open must still be home's.
  return [
    ...boundTo(HOME_ID, coreSources({
      fetchStrict, facts: facts ?? EMPTY_FACTS, unlocked: isUnlocked, role,
      certs,
    }), runInCluster),
    ...boundTo(HOME_ID, attached, runInCluster),
    ...extra.filter(s => s.id !== 'cluster' && s.id !== 'backups'),
    ...boundTo(HOME_ID, pluginSources({ plugins: PLUGINS, unlocked: isUnlocked, run: runPluginSummary, detail: runPluginDetail, skip: ['qnap'] }), runInCluster),
  ]
}

/** Home's facts when they could not be gathered: every source they feed reads as unread, never as empty. */
const EMPTY_FACTS: TemplateFacts = {
  nodes: [], storages: [], templates: [], downloadable: [], guests: [], nextVmid: 0, zones: [], proxyHosts: [],
  hasReverseProxy: false, records: {}, partial: ['zones', 'proxy'],
}

/**
 * Who owns a plan and its job. A signed-in user is their email; an API token is its id, never its name, so
 * a token revoked and re-issued under the same name cannot use the old one's plans.
 */
export function ownerOf(ctx: Pick<RequestContext, 'sid' | 'email'> | undefined): string {
  if (!ctx) return ''
  return ctx.sid?.startsWith('token:') ? ctx.sid : (ctx.email ?? '')
}

// ── Checking a run again before it runs ─────────────────────────────────────

/**
 * The partial sources these fields' validation reads. A source that failed reads as empty (no guests, no
 * zones, no templates), and an empty list passes checks it should fail, so any of these refuses execute.
 */
export function unreadFor(f: DeployFields, facts: TemplateFacts): string[] {
  const n = f.node
  const exact = new Set(['nodes', 'resources', `status:${n}`, `login:${n}`, `network:${n}`, `storage:${n}`])
  // A template already on the node does not need the download list; one still to download does.
  if (!facts.templates.some(t => t.node === n && t.volid === f.template)) exact.add(`aplinfo:${n}`)
  const prefixes = [`templates:${n}/`]
  if (f.ip !== 'dhcp') prefixes.push('config:')
  if (f.exposure === 'public') {
    exact.add('zones'); exact.add('proxy')
    const z = f.domain ? zoneFor(f.domain, facts.zones) : null
    if (z) exact.add(`records:${z.zone}`)
    else prefixes.push('records:')
  }
  return facts.partial.filter(p => exact.has(p) || prefixes.some(x => p.startsWith(x)))
}

/** The stored fields as a person's values again, so derive keeps them and recomputes every fact. */
function asUserFields(t: TaskTemplate, f: DeployFields): Fields {
  const out: Fields = {}
  for (const spec of t.fields) {
    const v = (f as unknown as Record<string, unknown>)[spec.name]
    if (v !== undefined && (spec.source === 'user' || spec.source === 'derived')) out[spec.name] = { value: v, source: 'user' }
  }
  return out
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Re-derive and re-validate against fresh facts: every issue, and every fact that moved, by field. */
function revalidate(t: TaskTemplate, run: DeployRun, facts: TemplateFacts, settings: TemplateSettings): string[] {
  const derived = t.derive(asUserFields(t, run.fields), facts, settings)
  const problems = t.validate(derived, facts).map(i => i.message)
  const stored = run.fields as unknown as Record<string, unknown>
  for (const spec of t.fields) {
    const was = stored[spec.name], now = derived[spec.name]?.value
    if (same(was, now)) continue
    const show = (v: unknown) => (v === undefined || v === null || v === '' ? 'unset' : Array.isArray(v) ? v.join(' ') : String(v))
    problems.push(spec.name === 'gateway'
      ? `The gateway of ${run.fields.bridge} on ${run.fields.node} is now ${show(now)}, not the ${show(was)} this was planned with.`
      : `${spec.name} is now ${show(now)}, not the ${show(was)} this was planned with.`)
  }
  if (!same(t.steps(derived).map(s => s.id), run.steps.map(s => s.id))) problems.push('The steps for this request have changed since it was planned.')
  return [...new Set(problems)]
}

/** What a run in flight holds, so a second run planned against the same facts cannot take it too. */
function claimsOf(f: DeployFields): Array<{ key: string; message: string }> {
  const out = [{ key: `vmid:${f.vmid}`, message: `Container ID ${f.vmid} is being used by a deployment that is running now.` },
               { key: `hostname:${f.hostname}`, message: `${f.hostname} is the hostname of a deployment that is running now.` }]
  if (f.ip !== 'dhcp') {
    const ip = f.ip.split('/')[0]
    out.push({ key: `ip:${ip}`, message: `${ip} is being given to a deployment that is running now.` })
  }
  return out
}

/** A plain account of the fields, written here from the fields, never by the model. */
function understood(f: Fields): string {
  const v = (k: string) => f[k]?.value
  const name = wizardRecipes().find(r => r.id === v('service'))?.name ?? String(v('service') ?? 'a service')
  const where = v('node') ? ` on ${v('node')}` : ''
  const id = v('vmid') ? `CT ${v('vmid')}` : 'a new container'
  const addr = v('ip') === 'dhcp' ? 'DHCP' : v('ip') ? String(v('ip')) : 'no address yet'
  const reach = v('exposure') === 'public' && v('domain') ? `published at ${v('domain')}` : v('exposure') === 'lan' ? 'LAN only' : ''
  return `${name} in ${id}${where} (${addr})${reach ? `, ${reach}` : ''}.`
}

function firstRunNotice(f: Fields): string | null {
  if (f.exposure?.value !== 'public') return null
  const r = wizardRecipes().find(x => x.id === f.service?.value)
  if (!r || r.firstRun.kind === 'none') return null
  return `${r.name} shows a first-run setup page to whoever visits first, so HyperProx will not publish it yet. ` +
         `It installs it on your network and stops before the proxy, DNS and certificate steps; finish setup at its LAN address, then publish it.`
}

export function buildAiRoutes(overrides: Partial<AiRouteDeps> = {}): FastifyPluginAsync {
  const deps: AiRouteDeps = { ...defaultDeps(), ...overrides }
  // Claims of runs in flight, by key; released when the run settles. Checked and taken with no await in
  // between, so two executes racing for one ID or address cannot both pass.
  const claims = new Map<string, string>()
  return async (fastify) => {
    // ── Providers ──────────────────────────────────────────────────────────────

    // GET /api/ai/providers — what can plan, and what each still needs
    fastify.get('/providers', async (_req, reply) => {
      const [providers, active] = await Promise.all([deps.listProviders(), deps.activeProvider()])
      return reply.send({ ok: true, active, providers })
    })

    // POST /api/ai/provider/select — choose which one the wizard uses
    fastify.post<{ Body: { provider: string } }>('/provider/select', async (req, reply) => {
      const { provider } = req.body ?? {}
      if (!isProvider(provider)) {
        return reply.status(400).send({ ok: false, error: `provider must be one of ${PROVIDER_IDS.join(', ')}` })
      }
      await setActiveProvider(provider)
      return reply.send({ ok: true, active: provider })
    })

    // PUT /api/ai/provider/:id — store this provider's key, model or base URL
    fastify.put<{
      Params: { id: string }
      Body:   { api_key?: string; model?: string; base_url?: string; url?: string }
    }>('/provider/:id', async (req, reply) => {
      const id = req.params.id
      if (!isProvider(id)) return reply.status(400).send({ ok: false, error: 'unknown provider' })

      const body = req.body ?? {}
      const saved: string[] = []

      // An empty string clears a setting; undefined leaves it alone. That
      // distinction is what lets the UI send only the field the user edited.
      for (const [key, masked] of [
        ['api_key', true], ['model', false], ['base_url', false], ['url', false],
      ] as Array<[keyof typeof body, boolean]>) {
        const value = body[key]
        if (value === undefined) continue
        await setCredential('ai', id, String(key), value, masked)
        saved.push(String(key))
      }

      if (!saved.length) return reply.status(400).send({ ok: false, error: 'nothing to save' })
      return reply.send({ ok: true, provider: id, saved })
    })

    // POST /api/ai/provider/test — a real round trip, not a reachability check
    fastify.post<{ Body: { provider?: string } }>('/provider/test', async (req, reply) => {
      const id = req.body?.provider
      if (id !== undefined && !isProvider(id)) {
        return reply.status(400).send({ ok: false, error: 'unknown provider' })
      }
      const started = Date.now()
      try {
        // The smallest request that still exercises structured output end to end.
        const facts = await deps.facts()
        const x = await deps.extract(deployService, 'Deploy Uptime Kuma. No domain yet.', facts, { provider: id })
        return reply.send({
          ok: true,
          ms: Date.now() - started,
          provider: id ?? await deps.activeProvider(),
          sample: { service: x.values.service ?? null, fields: Object.keys(x.values).length },
        })
      } catch (err: any) {
        return reply.status(502).send({ ok: false, ms: Date.now() - started, error: err.message })
      }
    })

    // ── The wizard ─────────────────────────────────────────────────────────────

    // POST /api/ai/wizard/plan — natural language → the template's fields, its questions and its steps
    fastify.post<{ Body: { prompt: string; provider?: string; model?: string } }>(
      '/wizard/plan', async (req, reply) => {
        const { prompt, provider } = req.body ?? {}
        if (!prompt || typeof prompt !== 'string') return reply.status(400).send({ ok: false, error: 'prompt is required' })
        if (provider !== undefined && !isProvider(provider)) {
          return reply.status(400).send({ ok: false, error: 'unknown provider' })
        }

        const chosen = provider ?? await deps.activeProvider()

        // A per-request model is only meaningful for Ollama, where the UI lists the models that are
        // installed. It is used for this request's calls directly (not read back from the store), and
        // persisted so the dropdown and the next request agree.
        const model = chosen === 'ollama' && typeof req.body.model === 'string' && req.body.model.trim()
          ? req.body.model.trim() : undefined
        if (model) await deps.saveModel(model)

        // ── Which cluster, and is it an action? ─────────────────────────────────
        // The open cluster is the request's (header or ?cluster=); the words can name another one or all of them.
        const clusters = deps.clusters()
        const currentId = deps.currentCluster()
        const current = clusters.find(c => c.id === currentId)
        if (!current) return reply.status(404).send({ ok: false, code: 'unknown_cluster', error: 'No such cluster. It may have been removed.' })
        const owner = deps.whoami(req)
        const said = (message: string, extra: Record<string, unknown> = {}) =>
          reply.send({ ok: true, conversational: true, provider: chosen, message, cluster: current, ...extra })

        const sess = deps.session()
        const home: ClusterRef = clusters.find(c => c.kind === 'home') ?? { id: HOME_ID, name: 'Home cluster', kind: 'home' }

        // Pull a static site, run a SMART test, and what is done by hand (a NAS restart, WordPress sign-in, Home
        // Assistant devices): read before guest actions, so "restart nas1" is never read as a guest called nas1.
        const homeish = /\b(smart|nas|qnap|pull|sync|refresh|redeploy|update|sign|log|wordpress|wp|restart|reboot|shut|power|halt|turn|switch|set|open|close|lock|unlock|arm|disarm|dim|toggle)\b/i.test(prompt)
        const names = homeish ? await deps.homeNames().catch(() => ({ nas: [], sites: [] })) : { nas: [], sites: [] }
        const homeAction = homeish ? parseHomeAction(prompt, names) : null
        if (homeAction) {
          if (homeAction.kind !== 'by-hand' && current.kind !== 'home') return said(`That is done on the home cluster's assistant. Pick ${home.name} at the top and ask again. Nothing was prepared.`)
          if (homeAction.kind !== 'by-hand' && !owner) return reply.status(401).send({ ok: false, error: 'Sign in to do that.' })
          const r = await prepareHomeAction(prompt, homeAction, { owner, role: sess?.role, token: isTokenSid(sess?.sid), home },
            { ...deps.homePrepareDeps(), prepared: deps.homePlans })
          if (r.kind === 'card') return reply.send({ ok: true, conversational: false, provider: chosen, action: r.card, cluster: home })
          return said(r.message, r.choices ? { choices: r.choices } : {})
        }

        // A new website: the template asks for what is missing, then the New website wizard's code plans it and holds
        // the plan for the person to review and install in the wizard. A reply to its question carries on the draft.
        const draft = owner ? deps.websiteDrafts.get(owner) : null
        if (isWebsiteRequest(prompt) || (draft && !parseAction(prompt) && !isQuestionPrompt(prompt) && !/\?\s*$/.test(prompt))) {
          if (!owner) return reply.status(401).send({ ok: false, error: 'Sign in to do that.' })
          if (current.kind !== 'home') return said(`Making a website is only available on the home cluster, from the assistant with ${home.name} selected. Nothing was planned.`)
          const r = await websiteTurn(prompt, { owner, role: sess?.role, token: isTokenSid(sess?.sid), unlocked: deps.prepareDeps().unlocked() }, deps.websiteDrafts, deps.websiteDeps())
          if (r.kind === 'card') return reply.send({ ok: true, conversational: false, provider: chosen, website: r.card, cluster: home })
          return said(r.message, r.choices?.length ? { choices: asChoices(r.choices, home.id) } : {})
        }

        // An action on a guest, monitoring or a copy: read by code, prepared and checked by the server, applied
        // only through /actions/apply. Never through the model, never on the browser's word.
        const action = parseAction(prompt)
        if (action) {
          if (!owner) return reply.status(401).send({ ok: false, error: 'Sign in to do that.' })
          const r = await prepareAction(prompt, action, { owner, role: deps.session()?.role, current, clusters },
            { ...deps.prepareDeps(), prepared: deps.actionPlans })
          if (r.kind === 'card') return reply.send({ ok: true, conversational: false, provider: chosen, action: r.card, cluster: current })
          return said(r.message, r.choices ? { choices: r.choices } : {})
        }

        const targets = resolveTargets(prompt, clusters, current)
        if (targets.kind === 'ask') return said(targets.message, { choices: targets.choices.map(c => ({ label: c.name, prompt: promptOn(prompt, c.name), cluster: c.id })) })
        const onlyHome = current.kind === 'home' && targets.clusters.length === 1 && targets.clusters[0].kind === 'home'
        if (!onlyHome) {
          // Deploying a service (proxy, DNS, certificate) is the home cluster's, and only from the home cluster's
          // assistant: its facts and its run are home's.
          if (!isQuestionPrompt(prompt) && /\b(deploy|install|set\s*up|spin\s*up|stand\s*up|host|launch|provision)\b/i.test(prompt)) {
            return said(`Deploying a service is only available on the home cluster for now, from the assistant with Home cluster selected. Nothing was planned.`, { clusters: targets.clusters })
          }
          // Home's DNS and proxy sources read home's facts, gathered in home's context whatever this request's is.
          const homeFacts = targets.clusters.some(c => c.kind === 'home')
            ? await deps.inCluster(HOME_ID, () => deps.facts()).catch(() => null) : null
          const message = await answerAcross(prompt, targets.clusters, {
            sourcesFor: c => deps.clusterSources(c, homeFacts, (fastify as any).prisma),
            call: deps.askCall(chosen, model), fallback: NO_TASK_ANSWER, clusters,
            services: wizardRecipes().flatMap(r => [r.id, r.name.toLowerCase()]),
          })
          return said(message, { clusters: targets.clusters })
        }

        let facts: TemplateFacts, settings: TemplateSettings
        try {
          [facts, settings] = await Promise.all([deps.facts(), deps.settings()])
        } catch (err: any) {
          return reply.status(502).send({ ok: false, error: `Cannot read the cluster, so there is nothing to plan against: ${err.message}` })
        }

        const loopDeps: LoopDeps = {
          facts, settings, now: () => new Date(),
          intent: p => deps.intent(p, chosen, model),
          ask: p => answerQuestion(p, { sources: deps.sources(facts, (fastify as any).prisma), call: deps.askCall(chosen, model), fallback: NO_TASK_ANSWER,
            services: wizardRecipes().flatMap(r => [r.id, r.name.toLowerCase()]) }),
          extract: (t, text, f, opts) => deps.extract(t, text, f, { ...opts, provider: chosen, model }),
        }
        let s
        try {
          s = await startLoop(prompt, loopDeps)
        } catch (err: any) {
          return reply.status(502).send({ ok: false, provider: chosen, error: err.message })
        }

        // Not a task: the answer is shown, and nothing is planned.
        const t = s.template ? getTemplate(s.template) : undefined
        if (s.state === 'answer' || !t) {
          return reply.send({ ok: true, conversational: true, provider: chosen, message: s.answer || NO_TASK_ANSWER })
        }

        const fields = s.fields
        const steps = s.steps ?? t.steps(fields)
        const notice = firstRunNotice(fields)
        let run: DeployRun | undefined
        let unread: string[] = []
        if (s.state === 'ready') {
          const typed = toDeployFields(fields, t)
          unread = unreadFor(typed, facts)
          run = { template: 'deploy-service', version: t.version, owner: '', fields: typed, steps }
        }
        const warnings = [...new Set([
          ...s.issues.map(i => i.message),
          ...(s.pending ? [s.pending.question] : []),
          ...unread.map(src => `HyperProx could not read ${src} from the cluster, so this could not be fully checked. Try again in a moment.`),
          ...(notice ? [notice] : []),
        ])]
        // Interim until the first-run lock: a public app with a first-run page is not planned at all.
        const blocked = !run || unread.length > 0 || !!notice

        // Only a ready, fully checked run is kept, and only for the user who asked. Execute takes this id;
        // nothing the browser shows or sends is run.
        const planId = !blocked && owner && run ? deps.prepared.put(owner, structuredClone({ ...run, owner })) : undefined

        const name = wizardRecipes().find(r => r.id === fields.service?.value)?.name ?? String(fields.service?.value ?? '')
        return reply.send({
          ok: true,
          provider: chosen,
          model: model ?? (await deps.listProviders()).find(p => p.id === chosen)?.model,
          plan: {
            service: name,
            domain: typeof fields.domain?.value === 'string' ? fields.domain.value : '',
            understood: understood(fields),
            steps: steps.map(x => ({ id: x.id, type: x.id, label: x.label })),
            warnings,
          },
          fields,
          // `blocked` is the run not being ready, or not fully checked: the UI offers Execute only without it.
          blocked,
          ...(planId ? { planId } : {}),
        })
      })

    // POST /api/ai/wizard/execute — run what /wizard/plan prepared, by its id
    fastify.post<{ Body: Record<string, unknown> }>('/wizard/execute', async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>

      // A plan, fields or steps in the body are refused outright, even next to a valid id: what runs is the
      // server's, and accepting them invites the mistake of running them.
      if (body.plan !== undefined || body.fields !== undefined || body.steps !== undefined) {
        return reply.status(400).send({
          ok: false,
          error: 'Execution takes a planId from /wizard/plan; a plan or fields sent by the browser are never run.',
        })
      }
      if (typeof body.planId !== 'string' || !body.planId) {
        return reply.status(400).send({ ok: false, error: 'planId is required' })
      }

      const stored = deps.prepared.take(body.planId, deps.whoami(req))
      if (!stored) {
        return reply.status(404).send({ ok: false, error: 'That plan has expired or was already run. Plan it again.' })
      }
      const run = stored.payload
      const t = getTemplate(run.template)
      if (!t || t.version !== run.version) {
        return reply.status(409).send({ ok: false, blocked: true, error: 'HyperProx has changed how it does this since it was planned. Start again.' })
      }

      // The cluster may have moved since planning: another guest took the ID or the address, a node went
      // away, a gateway changed. Everything is derived and validated again against fresh facts.
      let facts: TemplateFacts, settings: TemplateSettings
      try {
        [facts, settings] = await Promise.all([deps.facts(), deps.settings()])
      } catch (err: any) {
        return reply.status(502).send({
          ok: false, blocked: true,
          error: `Cannot read the cluster, so the plan cannot be checked again before it runs: ${err.message}`,
        })
      }
      const unavailable = unreadFor(run.fields, facts)
      if (unavailable.length) {
        return reply.status(502).send({
          ok: false, blocked: true, unavailable,
          error: `Cannot read ${unavailable.join(', ')} from the cluster, so the plan cannot be checked again before it runs. Plan it again.`,
        })
      }
      const problems = revalidate(t, run, facts, settings)
      if (problems.length) return reply.status(409).send({ ok: false, blocked: true, warnings: problems })

      // Runs already in flight are not in the facts yet. No await from here to the claim.
      const mine = claimsOf(run.fields)
      const clash = mine.filter(c => claims.has(c.key)).map(c => c.message)
      if (clash.length) return reply.status(409).send({ ok: false, blocked: true, warnings: clash })

      const jobId = randomUUID()
      for (const c of mine) claims.set(c.key, jobId)
      const release = () => { for (const c of mine) if (claims.get(c.key) === jobId) claims.delete(c.key) }

      // Fire-and-forget — execution runs in background, progress via WebSocket
      deps.execute(jobId, run)
        .catch(err => fastify.log.error(`[wizard] Job ${jobId} failed: ${err.message}`))
        .finally(release)

      return reply.send({
        ok:      true,
        jobId,
        message: `Executing ${run.steps.length} steps. Track progress via WebSocket.`,
        steps:   run.steps.length,
      })
    })

    // POST /api/ai/actions/apply — apply what /wizard/plan prepared as an action, by its id
    // The request must be for the plan's cluster (the confirm card sends its X-HyperProx-Cluster header);
    // lib/ai/actions.ts says what else is checked, and in which order.
    fastify.post<{ Body: Record<string, unknown> }>('/actions/apply', async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      for (const k of ['plan', 'action', 'guest', 'cluster', 'clusterId', 'node', 'vmid', 'storage'])
        if (body[k] !== undefined) return reply.status(400).send({ ok: false, error: 'Apply takes a planId (and, for a delete, the typed name). Anything else sent by the browser is never used.' })
      const owner = deps.whoami(req)
      if (!owner) return reply.status(401).send({ ok: false, error: 'Sign in to do that.' })
      // A plan for something attached to home (a site pull, a SMART test) is applied by its own module.
      if (typeof body.planId === 'string' && deps.homePlans.peek(body.planId, owner)) {
        const h = await applyHomeAction(body.planId, { ...deps.homeApplyDeps(), prepared: deps.homePlans, owner, ctx: deps.session(), requestCluster: deps.currentCluster(), homeId: HOME_ID })
        return reply.status(h.status).send(h.body)
      }
      const r = await applyAction(body.planId, { confirmName: body.confirmName }, {
        ...deps.applyDeps(), prepared: deps.actionPlans, owner, ctx: deps.session(), requestCluster: deps.currentCluster(),
      })
      return reply.status(r.status).send(r.body)
    })

    // GET /api/ai/wizard/jobs/:jobId — get execution status (REST fallback for WS)
    fastify.get<{ Params: { jobId: string } }>('/wizard/jobs/:jobId', async (req, reply) => {
      // Another user's job reads as no job at all.
      const job = deps.job(req.params.jobId)
      const who = deps.whoami(req)
      if (!job || !who || job.run.owner !== who) return reply.status(404).send({ ok: false, error: 'Job not found' })

      return reply.send({
        ok:          true,
        jobId:       job.jobId,
        status:      job.status,
        currentStep: job.currentStep,
        totalSteps:  job.steps.length,
        steps:       job.steps,
        lxcVmid:    job.lxcVmid,
        lxcNode:    job.lxcNode,
        lxcIp:      job.lxcIp,
        startedAt:   job.startedAt,
        completedAt: job.completedAt,
        error:       job.error,
      })
    })

    // POST /api/ai/model/select — set the active Ollama model
    fastify.post<{ Body: { model: string } }>('/model/select', async (req, reply) => {
      const { model } = req.body
      if (!model) return reply.status(400).send({ error: 'model is required' })
      await setCredential('ai', 'ollama', 'model', model, false)
      return reply.send({ ok: true, model })
    })
  }
}

export const aiRoutes: FastifyPluginAsync = buildAiRoutes()
