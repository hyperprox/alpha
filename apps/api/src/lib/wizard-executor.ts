// =============================================================================
//  HyperProx — Wizard Execution Engine
//  Runs a template's fixed step list from server-held typed fields, step by
//  step, broadcasting live progress via WebSocket.
//
//  The executor decides nothing: the node, ID, storage, template, address and
//  sizes are the run's fields, which were derived and validated against the
//  cluster before the run was handed over. What it still does is refuse, loudly
//  and before anything exists, when the cluster no longer matches them.
//
//  Steps (deploy-service):
//    create_lxc        → Proxmox API: create the container exactly as the fields say
//    start_and_verify  → the start task of this create succeeded, and it stays running
//    install_service   → the recipe's install script, run on the node via pct exec
//    health_check      → the service answers its health path with an expected status
//    configure_proxy   → NPM: proxy host for the domain → container
//    create_dns        → DNS: A record in the longest managed zone
//    wait_propagation  → public resolvers return the WAN address
//    request_ssl       → NPM: certificate, attached to the proxy host
// =============================================================================

import { randomBytes } from 'crypto'
import { ProxmoxClient } from './proxmox-client'
import { wizardCreateHost, wizardRequestCertificate, wizardUpdateHost } from './proxy'
import type { HostPatch, HostSpec } from './proxy/types'
import { GoDaddyClient }  from './godaddy-client'
import { dnsRouter, proxiedProblem, type DnsRouter } from './dns-providers'
import { execInGuest, nodeCredential } from './node-exec'
import { wizardRecipes, healthProblem, type CatalogueRecipe } from './catalogue'
import { installScript, manualCommands, distroOf, hostEnv } from './install-script'
import { assertVmidFree, bridgeInfo, findIpUser, parseCidr } from './wizard-placement'
import { zoneFor } from './dns-zones'
import { archOfKernel, archOfTemplate } from './ai/facts'
import { publishableHostname } from './ai/templates/fields'
import type { DeployFields } from './ai/templates/deploy-service'
import type { StepSpec } from './ai/templates/types'
import type { TerminalCredential } from './ssh-broker'

// ── Types ─────────────────────────────────────────────────────────────────────

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export interface StepState {
  id:              string
  type:            string
  label:           string
  status:          StepStatus
  output?:         string
  error?:          string
  commands?:       string[]   // for install_service manual guidance
  startedAt?:      number
  completedAt?:    number
}

/** What runs: the template, its version, who it is for, its typed fields and its fixed steps. */
export interface DeployRun {
  template: 'deploy-service'
  version:  number
  owner:    string
  fields:   DeployFields
  steps:    StepSpec[]
}

export interface JobState {
  jobId:        string
  status:       'queued' | 'running' | 'completed' | 'failed'
  run:          DeployRun
  steps:        StepState[]
  currentStep:  number
  startedAt:    number
  completedAt?: number
  error?:       string
  // Runtime context shared between steps
  lxcVmid?:    number
  lxcNode?:    string
  lxcIp?:      string
  proxyHostId?: number
  certId?:      number
  wanIp?:       string
  /** The create task's UPID; its start time filters the guest's task history. */
  createUpid?:  string
  /** True only once the install ran and exited 0; nothing is published otherwise. */
  serviceInstalled?: boolean
}

/** The slice of the Proxmox client the create step uses — narrow so a test can stand in for it. */
export type CreatePVE = Pick<ProxmoxClient,
  'fetchNode' | 'fetchStrict' | 'getNodes' | 'createLXC' | 'waitForTask' | 'downloadTemplate'>

export interface ExecDeps {
  pve:   CreatePVE
  wait(ms: number): Promise<unknown>
  fetch: typeof fetch
  exec:  typeof execInGuest
  /** The proxy, through lib/proxy (preview → apply → read-back, audited). The wizard's confirm step is the preview. */
  proxy: WizardProxy
  /** Every configured DNS provider; each zone is written at the one that serves it. */
  dns(): Promise<WizardDns | null>
  /** The stored SSH login for a node, or null when there is none. */
  login(node: string): Promise<TerminalCredential | null>
  /** This site's public IPv4 address, for the A record. */
  wanIp(): Promise<string>
  /** A lookup against public resolvers, never the local one. */
  resolve4(domain: string): Promise<string[]>
  /** The address Let's Encrypt is told; '' when none is configured. */
  letsEncryptEmail(): string
}

export interface WizardProxy {
  createHost(spec: HostSpec, actor: { email: string }): Promise<{ hostId: string }>
  updateHost(hostId: string, patch: HostPatch, actor: { email: string }): Promise<unknown>
  requestCertificate(domains: string[], email: string, actor: { email: string }): Promise<{ id: string }>
}

const productionProxy: WizardProxy = {
  createHost: (spec, actor) => wizardCreateHost(spec, actor),
  updateHost: (id, patch, actor) => wizardUpdateHost(id, patch, actor),
  requestCertificate: (domains, email, actor) => wizardRequestCertificate(domains, email, actor),
}

// ── In-memory job store ───────────────────────────────────────────────────────

const jobs = new Map<string, JobState>()

export function getJob(jobId: string): JobState | undefined {
  return jobs.get(jobId)
}

// ── Broadcast hook ────────────────────────────────────────────────────────────

let _broadcast: ((type: string, payload: any, owner: string) => void) | null = null

/** `owner` is the email of the person who started the job: progress goes to their sockets only. */
export function setWizardBroadcast(fn: (type: string, payload: any, owner: string) => void) {
  _broadcast = fn
}

function emit(jobId: string) {
  const job = jobs.get(jobId)
  if (!job || !_broadcast) return
  _broadcast('wizard_progress', {
    jobId:       job.jobId,
    status:      job.status,
    currentStep: job.currentStep,
    totalSteps:  job.steps.length,
    steps:       job.steps,
    lxcVmid:    job.lxcVmid,
    lxcNode:    job.lxcNode,
    lxcIp:      job.lxcIp,
  }, job.run.owner)
}

// ── Client helpers ────────────────────────────────────────────────────────────

function getPVE(): ProxmoxClient {
  return new ProxmoxClient(
    process.env.PROXMOX_HOST!,
    Number(process.env.PROXMOX_PORT ?? 8006),
    `${process.env.PROXMOX_USER}!${process.env.PROXMOX_TOKEN_ID}`,
    process.env.PROXMOX_TOKEN_SECRET!,
  )
}

/** The DNS calls the wizard makes. A record it creates carries no `proxied`: at Cloudflare it is DNS only. */
export type WizardDns = Pick<DnsRouter, 'getDomains' | 'getRecords' | 'createRecord'>

async function getDns(): Promise<WizardDns | null> {
  const r = await dnsRouter().catch(() => null)
  if (!r) return null
  return { getDomains: async () => (await r.getDomains()).filter(z => z.active), getRecords: (z, t) => r.getRecords(z, t), createRecord: (z, rec) => r.createRecord(z, rec) }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function publicResolve4(domain: string): Promise<string[]> {
  // Public resolvers directly: the system resolver caches the NXDOMAIN from before the record existed.
  const { Resolver } = await import('dns/promises')
  const resolver = new Resolver({ timeout: 5000, tries: 1 })
  resolver.setServers((process.env.DNS_PROPAGATION_RESOLVERS ?? '1.1.1.1,8.8.8.8').split(',').map(s => s.trim()).filter(Boolean))
  return resolver.resolve4(domain)
}

function defaultDeps(): ExecDeps {
  return {
    pve: getPVE(), wait: sleep, fetch, exec: execInGuest, proxy: productionProxy, dns: getDns,
    login: nodeCredential,
    wanIp: async () => (await GoDaddyClient.getWanIP()).ip,
    resolve4: publicResolve4,
    letsEncryptEmail: () => process.env.LETSENCRYPT_EMAIL ?? process.env.NPM_EMAIL ?? '',
  }
}

/** The template's constants, as the create sends them. A run whose fields say otherwise does not run. */
const FEATURES = 'nesting=1'
const enc = encodeURIComponent

function recipeFor(run: DeployRun): CatalogueRecipe {
  const r = wizardRecipes().find(x => x.id === run.fields.service)
  if (!r) throw new Error(`HyperProx has no install recipe for "${run.fields.service}".`)
  return r
}

/** The create task's start time: the fourth field of its UPID, in hex, on the node's own clock. */
function upidStart(upid: string | undefined): number {
  return parseInt(String(upid ?? '').split(':')[4] ?? '0', 16) || 0
}

// ── Step handlers ─────────────────────────────────────────────────────────────

export async function stepCreateLXC(
  job: JobState,
  pve: CreatePVE = getPVE(),
  wait: (ms: number) => Promise<unknown> = sleep,
): Promise<string> {
  void wait
  const f = job.run.fields
  const node = f.node
  if (f.features !== FEATURES) throw new Error(`A HyperProx container gets features ${FEATURES} and nothing else, not "${f.features}".`)

  // Everything below was validated when the run was prepared and again when it was handed over; the
  // cluster can still move in between. Each check reads Proxmox strictly and refuses before the create.

  // 1. ID.
  const guests = ((await pve.fetchStrict<any[]>('/cluster/resources?type=vm')) ?? [])
    .filter((r: any) => (r.type === 'lxc' || r.type === 'qemu') && r.vmid)
  assertVmidFree(guests, f.vmid)
  const sameName = guests.find((g: any) => String(g.name ?? '').toLowerCase() === f.hostname.toLowerCase())
  if (sameName) throw new Error(`${f.hostname} is already the name of guest ${sameName.vmid}. Nothing was created.`)

  // 2. Network: the bridge as the node has it now, and the gateway the preview showed.
  const bridge = bridgeInfo(await pve.fetchStrict<any[]>(`/nodes/${enc(node)}/network`), f.bridge)
  if (!bridge) throw new Error(`${node} no longer has the bridge ${f.bridge}. Nothing was created.`)
  let net0 = `name=eth0,bridge=${f.bridge},ip=dhcp,firewall=1`
  let staticIp = ''
  if (f.ip !== 'dhcp') {
    const cidr = parseCidr(f.ip)
    if (!cidr) throw new Error(`"${f.ip}" is not an IPv4 address in CIDR form. Nothing was created.`)
    if (!f.gateway || bridge.gateway !== f.gateway) {
      throw new Error(`The gateway of ${f.bridge} on ${node} is now ${bridge.gateway || 'unset'}, not the ${f.gateway ?? 'unset'} ` +
                      `this was planned with. Nothing was created; plan it again.`)
    }
    const configs = await Promise.all(guests.map(async (g: any) => ({
      vmid:   Number(g.vmid),
      config: await pve.fetchStrict<any>(`/nodes/${enc(g.node)}/${g.type}/${Number(g.vmid)}/config`),
    })))
    const user = findIpUser(configs, cidr.ip)
    if (user) throw new Error(`${cidr.ip} is already configured on guest ${user}. Nothing was created.`)
    staticIp = cidr.ip
    net0 = `name=eth0,bridge=${f.bridge},ip=${cidr.ip}/${cidr.prefix},gw=${f.gateway},firewall=1`
  }

  // 3. Template: built for this node's CPU, as the node reports it now; downloaded only if it is not there.
  const status = await pve.fetchStrict<any>(`/nodes/${enc(node)}/status`)
  const arch = archOfKernel(status?.['current-kernel']?.machine)
  const tArch = archOfTemplate(f.template)
  if (!arch || tArch !== arch) {
    throw new Error(`${f.template} is built for ${tArch}, and ${node} is ${arch || 'an unknown CPU'}. Nothing was created.`)
  }
  const m = /^([^:]+):vztmpl\/(.+)$/.exec(f.template)
  if (!m) throw new Error(`"${f.template}" is not a container template volume. Nothing was created.`)
  const [, tStor, tName] = m
  const present = ((await pve.fetchStrict<any[]>(`/nodes/${enc(node)}/storage/${enc(tStor)}/content?content=vztmpl`)) ?? [])
    .some((c: any) => c?.volid === f.template)
  if (!present) {
    const offered = ((await pve.fetchStrict<any[]>(`/nodes/${enc(node)}/aplinfo`)) ?? [])
      .some((a: any) => (a?.template ?? a?.package) === tName)
    if (!offered) throw new Error(`${tName} is not on ${tStor} and is not on offer to download to ${node}. Nothing was created.`)
    await pve.waitForTask(node, await pve.downloadTemplate(node, tStor, tName), { timeoutMs: 15 * 60_000 })
  }

  // 4. Create. Proxmox lets only root@pam set any feature flag other than nesting, and HyperProx signs in
  //    with an API token, so nesting is the only one. The create task also starts the container.
  const upid = await pve.createLXC(node, {
    vmid:         f.vmid,
    hostname:     f.hostname,
    ostemplate:   f.template,
    memory:       f.memory_mb,
    cores:        f.cores,
    storage:      f.storage,
    rootfs_size:  f.disk_gb,
    net0,
    unprivileged: true,
    start:        true,
    onboot:       true,
    password:     randomBytes(18).toString('base64url'),
    features:     FEATURES,
    description:  `Deployed by HyperProx AI Wizard — ${new Date().toISOString()}`,
  })
  job.lxcVmid = f.vmid
  job.lxcNode = node
  job.createUpid = upid
  if (staticIp) job.lxcIp = staticIp

  // 5. Wait on the create task itself: its exit status and log say what went wrong.
  await pve.waitForTask(node, upid, { timeoutMs: 5 * 60_000 })
  return `CT ${f.vmid} (${f.hostname}) created on ${node} from ${tName}`
}

export async function stepStartAndVerify(
  job: JobState,
  pve: CreatePVE = getPVE(),
  wait: (ms: number) => Promise<unknown> = sleep,
): Promise<string> {
  const node = job.lxcNode, vmid = job.lxcVmid
  if (!node || !vmid || !job.createUpid) throw new Error('The container was not created, so there is nothing to start.')

  // The create task starts the container but does not wait for it. A container whose start fails can still
  // read as running for a moment, so the start task's own result decides, and the guest must read as
  // running twice, five seconds apart. Task history outlives the guest: an earlier container with the same
  // ID leaves its own start tasks behind, so only a start that began after this create counts.
  const createdAt = upidStart(job.createUpid)
  let running = false
  let seen = 0
  for (let i = 0; i < 8 && !running; i++) {
    await wait(5000)
    const starts = await pve.fetchNode<any[]>(`/nodes/${enc(node)}/tasks?vmid=${vmid}&typefilter=vzstart&limit=5`).catch(() => []) ?? []
    const start = starts.find(t => Number(t.starttime) >= createdAt)
    if (start?.status && start.status !== 'OK') throw new Error(`CT ${vmid} was created but would not start: ${start.status}`)
    const status = await pve.fetchNode<any>(`/nodes/${enc(node)}/lxc/${vmid}/status/current`).catch(() => null)
    seen = status?.status === 'running' ? seen + 1 : 0
    running = seen >= 2
  }
  if (!running) throw new Error(`CT ${vmid} was created but is not running after 40s`)

  // The address: the one the fields set, or whatever DHCP hands out (up to 30s).
  if (!job.lxcIp) {
    for (let i = 0; i < 6 && !job.lxcIp; i++) {
      await wait(5000)
      const ifaces = await pve.fetchNode<any[]>(`/nodes/${enc(node)}/lxc/${vmid}/interfaces`).catch(() => [])
      const ip = (ifaces ?? []).find((x: any) => x.name === 'eth0')?.inet?.split('/')?.[0]
      if (ip && !ip.startsWith('169.254')) job.lxcIp = ip
    }
  }
  return `CT ${vmid} is running${job.lxcIp ? ` · IP: ${job.lxcIp}` : ' · no address yet'}`
}

async function stepInstallService(job: JobState, step: StepState, d: ExecDeps): Promise<string> {
  job.serviceInstalled = false
  const recipe = recipeFor(job.run)
  const distro = distroOf(job.run.fields.template)
  if (!distro) throw new Error(`INSTALL FAILED — ${job.run.fields.template} is neither Debian nor Ubuntu, and the Docker packages differ between them. Nothing was installed.`)
  const commands = manualCommands(recipe, distro)
  const node = job.lxcNode, vmid = job.lxcVmid
  if (!node || !vmid) throw new Error('INSTALL FAILED — the container was not created.')

  // The install runs via `pct exec` from the node, which needs an SSH login for the node, not the guest.
  // Without one the commands are shown, honestly labelled, and nothing after this is published.
  const cred = await d.login(node).catch(() => null)
  if (!cred) {
    step.commands = commands
    step.status = 'skipped'
    return `NOT INSTALLED — no SSH login is stored for node ${node}, so the commands below have to be run by hand ` +
           `inside CT ${vmid}. Add one under Settings → Setup checklist (Add node login) and the wizard will do this itself next time.`
  }

  try {
    const host = await nodeAddress(d.pve, node)
    const f = job.run.fields
    const env = hostEnv(recipe, { ip: job.lxcIp, domain: f.exposure === 'public' ? f.domain : undefined })
    const res = await d.exec({ host, cred, vmid, script: installScript(recipe, distro, env), timeoutMs: 20 * 60_000 })
    if (res.timedOut) throw new Error('the install ran for twenty minutes without finishing')
    if (res.code !== 0) {
      const tail = String(res.output ?? '').trim().split('\n').slice(-12).join('\n')
      throw new Error(`the install exited ${res.code}${tail ? `. Last output:\n${tail}` : ''}`)
    }
  } catch (e: any) {
    step.commands = commands
    throw new Error(`INSTALL FAILED — ${e.message}. The commands on this step will do it by hand inside CT ${vmid}.`)
  }
  job.serviceInstalled = true
  return `Installed and started on port ${recipe.port} inside CT ${vmid}.`
}

/** Node name to address; names are not reliably resolvable from a container. */
async function nodeAddress(pve: CreatePVE, node: string): Promise<string> {
  const status = await pve.fetchStrict<any[]>('/cluster/status')
  const row = (status ?? []).find((r: any) => r.type === 'node' && r.name === node)
  if (!row?.ip) throw new Error(`no address found for node ${node}`)
  return row.ip
}

export async function stepHealthCheck(
  job: JobState,
  fetchImpl: typeof fetch = fetch,
  wait: (ms: number) => Promise<unknown> = sleep,
): Promise<string> {
  const recipe = recipeFor(job.run)
  if (!job.lxcIp) throw new Error('The container has no address, so the service cannot be checked.')
  const url = `http://${job.lxcIp}:${recipe.port}${recipe.healthPath}`
  const want = recipe.expectStatus.join(', ')
  // A service just started by Compose can take a while to listen: up to two minutes, then a loud failure.
  let last = ''
  for (let i = 0; i < 24; i++) {
    if (i) await wait(5000)
    try {
      const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
      const body = recipe.healthBody ? await res.text().catch(() => undefined) : undefined
      const problem = healthProblem(recipe, res.status, body)
      if (!problem) return `${url} answered ${res.status}`
      last = recipe.expectStatus.includes(res.status) ? `${url} ${problem}` : `${url} answered ${res.status}, expected ${want}`
    } catch (e: any) {
      last = `${url} did not answer: ${e?.cause?.message ?? e?.message ?? e}`
    }
  }
  throw new Error(`HEALTH CHECK FAILED — ${last}.`)
}

function assertNoFirstRun(job: JobState): void {
  const recipe = recipeFor(job.run)
  if (recipe.firstRun.kind === 'none' || job.run.steps.some(s => s.id === 'secure_first_run')) return
  throw new Error(`${recipe.name} shows a first-run setup page to whoever visits first, so HyperProx will not publish it yet. ` +
                  `Finish setup at http://${job.lxcIp ?? '?'}:${recipe.port}, then publish it.`)
}

/** The run's domain, checked again here: one valid hostname, never a wildcard, whatever validate let by. */
function domainOf(job: JobState): string {
  const d = job.run.fields.domain
  if (!d) throw new Error('This run has no domain to publish on.')
  const ok = publishableHostname(d)
  if (!ok.ok) throw new Error(`"${d}" is not a hostname HyperProx will publish (${ok.message}). Nothing was published.`)
  return ok.value as string
}

async function stepConfigureProxy(job: JobState, d: ExecDeps): Promise<string> {
  // Phase 5 replaces this guard with the first-run lock.
  assertNoFirstRun(job)
  const ip = job.lxcIp
  if (!ip) throw new Error('The container has no address to point the proxy at.')
  const port = recipeFor(job.run).port
  const domain = domainOf(job)

  // The options the wizard has always set; everything else is NPM's default for a new host.
  const host = await d.proxy.createHost({
    domains: [domain], forwardScheme: 'http', forwardHost: ip, forwardPort: port, enabled: true, websockets: true,
    npm: { certificate_id: false, ssl_forced: false, block_exploits: true, http2_support: false, hsts_enabled: false,
      hsts_subdomains: false, caching_enabled: false, advanced_config: '' },
  }, { email: job.run.owner })

  job.proxyHostId = Number(host.hostId)
  return `Proxy host created — ${domain} → ${ip}:${port}`
}

export async function stepCreateDNS(job: JobState, d: ExecDeps): Promise<string> {
  const gd = await d.dns()
  if (!gd) throw new Error('DNS is not configured in HyperProx settings')
  const domain = domainOf(job)
  // The longest managed zone the name is in, never "the last two labels".
  const zones = ((await gd.getDomains()) ?? []).map((x: any) => x.domain).filter(Boolean)
  const z = zoneFor(domain, zones)
  if (!z) throw new Error(`${domain} is in no DNS zone HyperProx manages.`)
  if (z.name === '@') throw new Error(`${domain} is the main address of ${z.zone}; HyperProx will not replace it.`)

  // Read again right before the write: a record made since the plan is never overwritten or added to.
  const existing = ((await gd.getRecords(z.zone)) ?? [])
    .find((r: any) => ['A', 'AAAA', 'CNAME'].includes(r?.type) && String(r?.name ?? '').toLowerCase() === z.name)
  if (existing) throw new Error(`${domain} already has a DNS record (${existing.type}). HyperProx will not change or add to it.`)

  const wan = await d.wanIp()
  job.wanIp = wan
  await gd.createRecord(z.zone, { type: 'A', name: z.name, data: wan, ttl: 600 })
  return `DNS A record created — ${domain} → ${wan}`
}

async function stepWaitPropagation(job: JobState, d: ExecDeps): Promise<string> {
  const domain = domainOf(job)
  const wanIp  = job.wanIp
  if (!wanIp) throw new Error('Cannot verify DNS propagation — the WAN IP is unknown, so create_dns did not complete')

  for (let i = 0; i < 30; i++) {
    await d.wait(10000)
    const addrs = await d.resolve4(domain).catch(() => [] as string[])
    if (addrs.includes(wanIp)) return `DNS propagated — ${domain} resolves to ${wanIp} (${i * 10 + 10}s)`
  }
  // A Cloudflare record someone set to proxied resolves to Cloudflare, never to the WAN address: say so.
  const dns = await d.dns().catch(() => null)
  const z = dns ? zoneFor(domain, ((await dns.getDomains().catch(() => [])) ?? []).map((x: any) => x.domain)) : null
  if (dns && z && ((await dns.getRecords(z.zone).catch(() => [])) ?? []).some((r: any) => r?.type === 'A' && String(r?.name ?? '').toLowerCase() === z.name && r?.proxied === true)) {
    throw new Error(proxiedProblem(domain, wanIp))
  }
  // Failing here keeps a doomed Let's Encrypt challenge from counting against the hourly limit.
  throw new Error(
    `DNS did not propagate within 5 minutes — ${domain} does not resolve to ${wanIp}. ` +
    `Stopping before the SSL step: requesting a certificate now would fail Let's Encrypt ` +
    `validation and count against the 5-failures-per-hour limit for this hostname.`)
}

async function stepRequestSSL(job: JobState, d: ExecDeps): Promise<string> {
  if (!job.proxyHostId) throw new Error('Proxy host ID not available')
  const domain = domainOf(job)

  const email = d.letsEncryptEmail()
  if (!email) throw new Error('Let\'s Encrypt email not configured. Set LETSENCRYPT_EMAIL in HyperProx settings.')

  const actor = { email: job.run.owner }
  const cert = await d.proxy.requestCertificate([domain], email, actor)
  job.certId = Number(cert.id)
  // A patch: only these four options change; the host keeps everything else it has.
  await d.proxy.updateHost(String(job.proxyHostId), {
    npm: { certificate_id: Number(cert.id), ssl_forced: true, http2_support: true, hsts_enabled: true },
  }, actor)
  return `SSL certificate issued and attached — ${domain} is now HTTPS`
}

// ── Step dispatcher ───────────────────────────────────────────────────────────

const PUBLISHING = new Set(['configure_proxy', 'create_dns', 'wait_propagation', 'request_ssl', 'verify_url'])

async function runStep(step: StepState, job: JobState, d: ExecDeps): Promise<void> {
  step.status    = 'running'
  step.startedAt = Date.now()
  emit(job.jobId)

  try {
    let output: string
    switch (step.type) {
      case 'create_lxc':        output = await stepCreateLXC(job, d.pve, d.wait);       break
      case 'start_and_verify':  output = await stepStartAndVerify(job, d.pve, d.wait);  break
      case 'install_service':   output = await stepInstallService(job, step, d);        break
      case 'health_check':
        if (!job.serviceInstalled) {
          step.status = 'skipped'
          output = 'Not checked — the service was not installed.'
        } else {
          output = await stepHealthCheck(job, d.fetch, d.wait)
        }
        break
      case 'configure_proxy':   output = await stepConfigureProxy(job, d);   break
      case 'create_dns':        output = await stepCreateDNS(job, d);        break
      case 'wait_propagation':  output = await stepWaitPropagation(job, d);  break
      case 'request_ssl':       output = await stepRequestSSL(job, d);       break
      default:
        // A step this executor cannot run is a failure, never a silent skip.
        throw new Error(`HyperProx cannot run the step "${step.type}" yet.`)
    }

    if (step.status !== 'skipped') step.status = 'completed'
    step.output      = output
    step.completedAt = Date.now()
  } catch (err: any) {
    step.status      = 'failed'
    step.error       = err.message
    step.completedAt = Date.now()
    throw err
  } finally {
    emit(job.jobId)
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function executeDeployJob(jobId: string, run: DeployRun, over: Partial<ExecDeps> = {}): Promise<void> {
  const d: ExecDeps = { ...defaultDeps(), ...over }
  const job: JobState = {
    jobId,
    status:      'running',
    run,
    currentStep: 0,
    startedAt:   Date.now(),
    steps:       run.steps.map((s): StepState => ({ id: s.id, type: s.id, label: s.label, status: 'pending' })),
  }
  jobs.set(jobId, job)
  emit(jobId)

  const notRun = () => job.steps.filter(s => s.status === 'pending').map(s => s.label)
  try {
    for (let i = 0; i < job.steps.length; i++) {
      const step = job.steps[i]
      // Publishing needs a service that installed and answered. An install that was only shown, not run,
      // stops the run here, before anything points a public name at an empty container.
      // Fails closed: a run without a completed install step publishes nothing.
      const installed = job.serviceInstalled === true && job.steps.some(s => s.type === 'install_service' && s.status === 'completed')
      if (PUBLISHING.has(step.type) && !installed) {
        job.status      = 'failed'
        job.error       = `The service was not installed, so it was not published. Not run: ${notRun().join(', ')}.`
        job.completedAt = Date.now()
        emit(jobId)
        return
      }
      job.currentStep = i
      emit(jobId)
      await runStep(step, job, d)
    }
    // A run whose install was only shown, not run, has deployed nothing that works: it ends failed.
    const install = job.steps.find(s => s.type === 'install_service')
    if (install?.status === 'skipped') {
      job.status = 'failed'
      job.error  = `The service was not installed: ${install.output ?? 'the install did not run.'}`
    } else {
      job.status = 'completed'
    }
    job.completedAt = Date.now()
    emit(jobId)
  } catch (err: any) {
    // A failed step stops the run; whatever is still pending is left untouched and named here.
    const rest = notRun()
    job.status      = 'failed'
    job.error       = rest.length ? `${err.message} Not run: ${rest.join(', ')}.` : err.message
    job.completedAt = Date.now()
    emit(jobId)
  }
}
