// =============================================================================
//  HyperProx — Wizard Execution Engine
//  Runs deployment plans step by step, broadcasting live progress via WebSocket.
//
//  Step types:
//    create_lxc        → Proxmox API: find best node, get VMID, create + start CT
//    install_service   → Generate install commands, auto-complete with instructions
//    configure_proxy   → NPM: create proxy host pointing to CT IP
//    create_dns        → GoDaddy: create A record pointing to WAN IP
//    wait_propagation  → Poll DNS until domain resolves correctly
//    request_ssl       → NPM: request Let's Encrypt cert, attach to proxy host
// =============================================================================

import { ProxmoxClient } from './proxmox-client'
import { NPMClient }      from './npm-client'
import { GoDaddyClient }  from './godaddy-client'
import { getCredential }  from './credentials'
import { execInGuest, nodeCredential } from './node-exec'
import { findRecipe, getInstallCommands } from './service-recipes'
import {
  chooseNode, pickTemplate, pickDownloadable, assertVmidFree, parseCidr, sameSubnet,
  findIpUser, bridgeGateway, type NodeInfo,
} from './wizard-placement'

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

export interface JobState {
  jobId:        string
  status:       'queued' | 'running' | 'completed' | 'failed'
  plan:         any
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
  /** False once a step has configured around a service it could not install. */
  serviceInstalled?: boolean
  certId?:      number
  wanIp?:       string
}

// ── In-memory job store ───────────────────────────────────────────────────────

const jobs = new Map<string, JobState>()

export function getJob(jobId: string): JobState | undefined {
  return jobs.get(jobId)
}

// ── Broadcast hook ────────────────────────────────────────────────────────────

let _broadcast: ((type: string, payload: any) => void) | null = null

export function setWizardBroadcast(fn: (type: string, payload: any) => void) {
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
  })
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

async function getNPM(): Promise<NPMClient | null> {
  const url  = await getCredential('proxy', 'npm', 'url').catch(() => null)
  const em   = await getCredential('proxy', 'npm', 'email').catch(() => null)
  const pass = await getCredential('proxy', 'npm', 'password').catch(() => null)
  if (!url || !em || !pass) {
    if (process.env.NPM_URL) return new NPMClient(process.env.NPM_URL, process.env.NPM_EMAIL!, process.env.NPM_PASSWORD!)
    return null
  }
  return new NPMClient(url, em, pass)
}

async function getGoDaddy(): Promise<GoDaddyClient | null> {
  const key    = await getCredential('dns', 'godaddy', 'api_key').catch(() => null)
  const secret = await getCredential('dns', 'godaddy', 'api_secret').catch(() => null)
  if (!key || !secret) return null
  return new GoDaddyClient(key, secret)
}

// ── Sleep helper ──────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ── Step handlers ─────────────────────────────────────────────────────────────

/** The slice of the Proxmox client the create step uses — narrow so a test can stand in for it. */
export type CreatePVE = Pick<ProxmoxClient,
  'fetchNode' | 'fetchStrict' | 'getNodes' | 'createLXC' | 'waitForTask' | 'downloadTemplate'>

function hostnameFor(wanted: string | undefined, service: string | undefined): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return clean(wanted ?? '') || clean(service ?? '') || 'hyperprox-ct'
}

export async function stepCreateLXC(
  job: JobState,
  pve: CreatePVE = getPVE(),
  wait: (ms: number) => Promise<unknown> = sleep,
): Promise<string> {
  const planned = job.plan.steps?.find((s: any) => s.type === 'create_lxc')?.params ?? {}
  const diskGB  = job.plan.requirements?.disk_gb   || 8
  const ram     = job.plan.requirements?.ram_mb    || 512
  const cores   = job.plan.requirements?.cpu_cores || 1

  // 1. Node. The plan's choice stands when the user named one, but it is checked here too: the plan was
  //    made minutes ago, and a node can have gone offline or filled up since.
  const node = chooseNode(await pve.getNodes() as NodeInfo[], String(planned.node ?? ''), ram)

  // 2. ID. Every call below is strict: Proxmox answers most refusals as {"data":null}, which the lenient
  //    fetchNode hands back as if nothing had happened.
  const guests = ((await pve.fetchStrict<any[]>('/cluster/resources?type=vm')) ?? [])
    .filter((r: any) => (r.type === 'lxc' || r.type === 'qemu') && r.vmid)
  let vmid: number
  if (Number(planned.vmid) > 0) {
    vmid = Number(planned.vmid)
    assertVmidFree(guests, vmid)
  } else {
    vmid = Number(await pve.fetchStrict<number>('/cluster/nextid'))
  }

  // 3. Network. A given address must be well-formed, unused, and on the bridge's own network. The gateway is
  //    read from the node's bridge, never taken from the plan: a model asked for one will invent it.
  let net0 = 'name=eth0,bridge=vmbr0,ip=dhcp,firewall=1'
  let staticIp = ''
  if (String(planned.ip ?? '')) {
    const cidr = parseCidr(String(planned.ip))
    if (!cidr) throw new Error(`"${planned.ip}" is not an IPv4 address in CIDR form (for example 10.0.0.5/24)`)
    const gw = bridgeGateway(await pve.fetchStrict<any[]>(`/nodes/${encodeURIComponent(node)}/network`))
    if (!gw) throw new Error(`Cannot give CT ${vmid} a fixed address: ${node} has no gateway set on vmbr0`)
    if (!sameSubnet(cidr.ip, gw, cidr.prefix)) {
      throw new Error(`${cidr.ip}/${cidr.prefix} is not on the same network as the bridge gateway ${gw}`)
    }
    const configs = await Promise.all(guests.map(async (g: any) => ({
      vmid:   Number(g.vmid),
      config: await pve.fetchNode<any>(`/nodes/${g.node}/${g.type}/${g.vmid}/config`).catch(() => null),
    })))
    const user = findIpUser(configs, cidr.ip)
    if (user) throw new Error(`${cidr.ip} is already configured on guest ${user}`)
    staticIp = cidr.ip
    net0 = `name=eth0,bridge=vmbr0,ip=${cidr.ip}/${cidr.prefix},gw=${gw},firewall=1`
  }

  // 4. Template: the newest Debian standard image on any storage that holds templates.
  const templateStorages = await pve.fetchNode<any[]>(`/nodes/${node}/storage?content=vztmpl`).catch(() => []) ?? []
  const volids: string[] = []
  for (const stor of templateStorages) {
    const contents = await pve.fetchNode<any[]>(
      `/nodes/${node}/storage/${stor.storage}/content?content=vztmpl`).catch(() => []) ?? []
    for (const c of contents) if (c.volid) volids.push(c.volid)
  }
  let template = pickTemplate(volids)

  if (!template) {
    // Last resort: download the newest Debian template Proxmox offers, and wait for the download to finish.
    if (!templateStorages.length) {
      throw new Error(`No LXC template found and ${node} has no storage that holds templates. Download a Debian template via Proxmox first.`)
    }
    const available = (await pve.fetchStrict<any[]>(`/nodes/${encodeURIComponent(node)}/aplinfo`)) ?? []
    const name = pickDownloadable(available)
    if (!name) throw new Error(`No Debian template is on offer to download to ${node}`)
    const stor = templateStorages[0].storage
    await pve.waitForTask(node, await pve.downloadTemplate(node, stor, name), { timeoutMs: 15 * 60_000 })
    template = `${stor}:vztmpl/${name}`
  }

  // 5. Find rootdir storage with enough space
  const rootStores = await pve.fetchNode<any[]>(`/nodes/${node}/storage?content=rootdir`).catch(() => []) ?? []

  // Prefer real block storage (rbd/lvmthin/zfs) over network shares for rootfs
  const TYPE_RANK: Record<string, number> = { rbd: 0, zfspool: 0, lvmthin: 1, lvm: 1, dir: 2, nfs: 3, cifs: 4 }
  const candidates = rootStores
    .filter((s: any) => s.enabled && s.active && s.avail > diskGB * 1024 * 1024 * 1024 * 1.2)
    .sort((a: any, b: any) => {
      const rank = (TYPE_RANK[a.type] ?? 5) - (TYPE_RANK[b.type] ?? 5)
      return rank !== 0 ? rank : b.avail - a.avail
    })

  if (!candidates.length) {
    throw new Error(`No storage on ${node} has ${diskGB}GB free for the container rootfs`)
  }
  const rootStor = candidates[0].storage

  // 6. Create the LXC. nesting is what Docker needs inside an unprivileged container.
  //    keyctl would help some images, but Proxmox lets only root@pam set any feature
  //    flag other than nesting, and HyperProx signs in with an API token, so asking
  //    for it fails the whole create with a 403 before anything exists.
  const hostname = hostnameFor(planned.hostname, job.plan.service)
  const pass     = Math.random().toString(36).slice(-12) + Math.random().toString(36).slice(-4).toUpperCase()

  const upid = await pve.createLXC(node, {
    vmid,
    hostname,
    ostemplate:   template,
    memory:       ram,
    cores,
    storage:      rootStor,
    rootfs_size:  diskGB,
    net0,
    unprivileged: true,
    start:        true,
    password:     pass,
    features:     'nesting=1',
    description:  `Deployed by HyperProx AI Wizard — ${new Date().toISOString()}`,
  })
  job.lxcVmid = vmid
  job.lxcNode = node

  // 7. Wait on the create task itself. Its exit status and log say what went wrong; polling the guest
  //    could only say that it never appeared.
  await pve.waitForTask(node, upid, { timeoutMs: 5 * 60_000 })

  // The create task starts the container but does not wait for it. A container whose start fails
  // can still read as running for a moment, so the start task's own result decides, and the guest
  // must read as running twice, five seconds apart.
  // The create task's start time is the fourth field of its UPID, in hex, on the node's own clock.
  const createdAt = parseInt(String(upid).split(':')[4] ?? '0', 16) || 0
  let running = false
  let seen = 0
  for (let i = 0; i < 8 && !running; i++) {
    await wait(5000)
    const starts = await pve.fetchNode<any[]>(
      `/nodes/${node}/tasks?vmid=${vmid}&typefilter=vzstart&limit=5`).catch(() => []) ?? []
    // Task history outlives the guest: an earlier container with the same ID leaves its own start
    // tasks behind, so only a start that began after this create counts.
    const start = starts.find(t => Number(t.starttime) >= createdAt)
    if (start?.status && start.status !== 'OK') {
      throw new Error(`CT ${vmid} was created but would not start: ${start.status}`)
    }
    const status = await pve.fetchNode<any>(`/nodes/${node}/lxc/${vmid}/status/current`).catch(() => null)
    seen = status?.status === 'running' ? seen + 1 : 0
    running = seen >= 2
  }
  if (!running) throw new Error(`CT ${vmid} was created but is not running after 40s`)

  // 8. Address: the one we set, or whatever DHCP hands out (wait up to 30s).
  if (staticIp) {
    job.lxcIp = staticIp
  } else {
    for (let i = 0; i < 6; i++) {
      await wait(5000)
      const ifaces = await pve.fetchNode<any[]>(`/nodes/${node}/lxc/${vmid}/interfaces`).catch(() => [])
      const eth0   = (ifaces ?? []).find((f: any) => f.name === 'eth0')
      const ip     = eth0?.['inet']?.split('/')?.[0]
      if (ip && !ip.startsWith('169.254')) {
        job.lxcIp = ip
        break
      }
    }
  }

  return `CT ${vmid} (${hostname}) created on ${node}${job.lxcIp ? ` · IP: ${job.lxcIp}` : ' · IP pending'}`
}

async function stepInstallService(job: JobState): Promise<string> {
  // This used to install nothing at all: it printed commands and reported
  // SKIPPED, because the executor had no shell on the container it had just
  // created. Reporting anything else would have been worse — the wizard went on
  // to point NPM at the box, create the DNS record and issue a real certificate,
  // and announcing success there means handing someone a 502 and calling it a
  // deployment.
  //
  // It can now run the install, via `pct exec` from the node. That needs an SSH
  // login for the *node*, not the guest — a guest thirty seconds old has no
  // credential, may have no sshd, and may not have finished DHCP. Where no node
  // login is stored the old behaviour stands, honestly labelled, because a
  // wizard that silently does half its job is how this bug existed in the first
  // place.
  const step = job.steps.find(s => s.type === 'install_service')

  // No recipe, no install. The old fallback guessed `image: <name>:latest` on port 80, which starts nothing
  // useful, and the run then published it behind a certificate.
  const svc = findRecipe(job.plan.service ?? '')
  if (!svc) {
    job.serviceInstalled = false
    throw new Error(`INSTALL FAILED — HyperProx has no install recipe for "${job.plan.service ?? ''}". ` +
                    `The container exists but is empty. Proxy, DNS and certificate steps were not run.`)
  }
  const commands = getInstallCommands(job.plan.service ?? 'app', svc)
  job.plan._servicePort = svc.port

  const cred = job.lxcNode ? await nodeCredential(job.lxcNode).catch(() => null) : null
  if (!cred || !job.lxcNode || !job.lxcVmid) {
    if (step) { step.commands = commands; step.status = 'skipped' }
    job.serviceInstalled = false
    return `NOT INSTALLED — no SSH login is stored for node ${job.lxcNode ?? '?'}, so the ` +
           `commands below have to be run by hand inside CT ${job.lxcVmid ?? '?'}. Add one under ` +
           `Settings → Nodes and the wizard will do this itself next time. Everything after this ` +
           `step is configured and waiting.`
  }

  const script = [
    // Stop at the first failure, so the exit code and the output point at the step that broke rather
    // than at a later command that could not exist without it.
    'set -e',
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -qq',
    'apt-get install -y -qq ca-certificates curl docker.io',
    // Ubuntu packages Compose v2 as docker-compose-v2; Debian ships v2 as docker-compose.
    'apt-get install -y -qq docker-compose-v2 || apt-get install -y -qq docker-compose',
    'systemctl enable --now docker',
    `mkdir -p /opt/app && cd /opt/app`,
    `cat > docker-compose.yml <<'HP_COMPOSE'`,
    svc.compose,
    'HP_COMPOSE',
    'docker compose up -d',
  ].join('\n')

  try {
    const nodeIp = await nodeAddressFor(job.lxcNode)
    const run = await execInGuest({
      host: nodeIp, cred, vmid: job.lxcVmid, script, timeoutMs: 20 * 60_000,
    })
    if (run.timedOut) throw new Error('the install ran for twenty minutes without finishing')
    if (run.code !== 0) {
      const tail = String(run.output ?? '').trim().split('\n').slice(-12).join('\n')
      throw new Error(`the install exited ${run.code}${tail ? `. Last output:\n${tail}` : ''}`)
    }

    job.serviceInstalled = true
    if (step) step.status = 'completed'
    return `Installed and started on port ${svc.port} inside CT ${job.lxcVmid}.`
  } catch (e: any) {
    // A failed install stops the run. The proxy, DNS record and certificate that follow would publish an
    // empty box under a real hostname and report success; they stay pending instead, and the commands
    // are kept on the step so the install can be finished by hand.
    if (step) step.commands = commands
    job.serviceInstalled = false
    throw new Error(`INSTALL FAILED — ${e.message}. The commands on this step will do it by hand inside ` +
                    `CT ${job.lxcVmid}. Proxy, DNS and certificate steps were not run.`)
  }
}

/** Node name to address; names are not reliably resolvable from a container. */
async function nodeAddressFor(node: string): Promise<string> {
  const status = await getPVE().fetchNode<any[]>('/cluster/status').catch(() => [])
  const row = (status ?? []).find((r: any) => r.type === 'node' && r.name === node)
  if (!row?.ip) throw new Error(`no address found for node ${node}`)
  return row.ip
}

async function stepConfigureProxy(job: JobState): Promise<string> {
  const npm = await getNPM()
  if (!npm) throw new Error('Nginx Proxy Manager is not configured in HyperProx settings')

  const ip   = job.lxcIp
  if (!ip)   throw new Error('LXC IP not available — create_lxc step may have failed')

  const port = job.plan._servicePort ?? job.plan.steps?.find((s: any) => s.type === 'install_service')?.params?.port ?? 80

  const host = await npm.createProxyHost({
    domain_names:            [job.plan.domain],
    forward_scheme:          'http',
    forward_host:            ip,
    forward_port:            port,
    ssl_forced:              false,
    block_exploits:          true,
    allow_websocket_upgrade: true,
    http2_support:           false,
    hsts_enabled:            false,
    hsts_subdomains:         false,
    caching_enabled:         false,
    enabled:                 true,
    certificate_id:          false,
    trust_forwarded_proto:   false,
    advanced_config:         '',
    meta:                    {},
  } as any)

  job.proxyHostId = host.id
  return `Proxy host created — ${job.plan.domain} → ${ip}:${port}`
}

async function stepCreateDNS(job: JobState): Promise<string> {
  const gd = await getGoDaddy()
  if (!gd) throw new Error('GoDaddy DNS is not configured in HyperProx settings')

  // Split domain into name + apex (e.g. cloud.mydomain.com → name=cloud, domain=mydomain.com)
  const parts   = job.plan.domain.split('.')
  const apex    = parts.slice(-2).join('.')
  const name    = parts.slice(0, -2).join('.') || '@'

  // Get WAN IP. getWanIP throws with detail if both lookup services fail or return
  // a non-IPv4 value — let that message surface instead of collapsing it.
  const wan = await GoDaddyClient.getWanIP()
  job.wanIp = wan.ip

  await gd.createRecord(apex, {
    type: 'A',
    name,
    data: wan.ip,
    ttl:  600,
  })

  return `DNS A record created — ${job.plan.domain} → ${wan.ip}`
}

async function stepWaitPropagation(job: JobState): Promise<string> {
  const domain = job.plan.domain
  const wanIp  = job.wanIp

  if (!wanIp) {
    throw new Error('Cannot verify DNS propagation — WAN IP is unknown, so the create_dns step did not complete')
  }

  // Query public resolvers directly rather than the system resolver, which caches
  // the NXDOMAIN from before the record existed and would report a freshly created
  // record as unpropagated for the length of the negative TTL.
  const { Resolver } = await import('dns/promises')
  const resolver = new Resolver({ timeout: 5000, tries: 1 })
  resolver.setServers(
    (process.env.DNS_PROPAGATION_RESOLVERS ?? '1.1.1.1,8.8.8.8')
      .split(',').map(s => s.trim()).filter(Boolean)
  )

  // Poll up to 5 minutes (30 attempts × 10s)
  for (let i = 0; i < 30; i++) {
    await sleep(10000)
    try {
      const addrs = await resolver.resolve4(domain)
      if (addrs.includes(wanIp)) {
        return `DNS propagated — ${domain} resolves to ${wanIp} (${i * 10 + 10}s)`
      }
    } catch {
      // Not resolved yet — keep polling
    }
  }

  // Fail the step. Continuing to request_ssl guarantees a failed Let's Encrypt
  // challenge, and five of those per hostname per hour locks out issuance.
  throw new Error(
    `DNS did not propagate within 5 minutes — ${domain} does not resolve to ${wanIp}. ` +
    `Stopping before the SSL step: requesting a certificate now would fail Let's Encrypt ` +
    `validation and count against the 5-failures-per-hour limit for this hostname.`
  )
}

async function stepRequestSSL(job: JobState): Promise<string> {
  const npm = await getNPM()
  if (!npm) throw new Error('Nginx Proxy Manager is not configured')
  if (!job.proxyHostId) throw new Error('Proxy host ID not available')

  // Get the letsencrypt email from NPM settings or env
  const email = process.env.LETSENCRYPT_EMAIL ?? process.env.NPM_EMAIL ?? ''
  if (!email) throw new Error('Let\'s Encrypt email not configured. Set LETSENCRYPT_EMAIL in HyperProx settings.')

  const cert = await npm.requestCertificate({
    domain_names:        [job.plan.domain],
    provider:            'letsencrypt',
    nice_name:           job.plan.domain,
    letsencrypt_email:   email,
  })

  job.certId = cert.id

  // Attach cert to the proxy host
  await npm.updateProxyHost(job.proxyHostId, {
    certificate_id: cert.id,
    ssl_forced:     true,
    http2_support:  true,
    hsts_enabled:   true,
  } as any)

  if (job.serviceInstalled === false) {
    return `Certificate issued and attached to ${job.plan.domain} over HTTPS. The service ` +
           `itself is NOT yet installed — ${job.plan.domain} will return 502 until the install ` +
           `commands from the earlier step are run inside CT ${job.lxcVmid ?? '?'}.`
  }
  return `SSL certificate issued and attached — ${job.plan.domain} is now HTTPS`
}

// ── Step dispatcher ───────────────────────────────────────────────────────────

async function runStep(step: StepState, job: JobState): Promise<void> {
  step.status    = 'running'
  step.startedAt = Date.now()
  emit(job.jobId)

  try {
    let output: string

    switch (step.type) {
      case 'create_lxc':        output = await stepCreateLXC(job);       break
      case 'install_service':   output = await stepInstallService(job);   break
      case 'configure_proxy':   output = await stepConfigureProxy(job);   break
      case 'create_dns':        output = await stepCreateDNS(job);        break
      case 'wait_propagation':  output = await stepWaitPropagation(job);  break
      case 'request_ssl':       output = await stepRequestSSL(job);       break
      default:
        output = `Unknown step type: ${step.type} — skipped`
        step.status = 'skipped'
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

export async function executeWizardJob(jobId: string, plan: any): Promise<void> {
  // Build initial job state
  const job: JobState = {
    jobId,
    status:      'running',
    plan,
    currentStep: 0,
    startedAt:   Date.now(),
    steps:       (plan.steps ?? []).map((s: any): StepState => ({
      id:     s.id,
      type:   s.type,
      label:  s.label,
      status: 'pending',
    })),
  }

  jobs.set(jobId, job)
  emit(jobId)

  try {
    for (let i = 0; i < job.steps.length; i++) {
      job.currentStep = i
      emit(jobId)
      await runStep(job.steps[i], job)

    }

    job.status      = 'completed'
    job.completedAt = Date.now()
    emit(jobId)

  } catch (err: any) {
    // A failed step stops the run; whatever is still pending is left untouched and named here.
    const notRun = job.steps.filter(s => s.status === 'pending').map(s => s.label)
    job.status      = 'failed'
    job.error       = notRun.length ? `${err.message} Not run: ${notRun.join(', ')}.` : err.message
    job.completedAt = Date.now()
    emit(jobId)
  }
}
