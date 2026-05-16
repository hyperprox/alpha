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
  const key    = await getCredential('dns', 'godaddy', 'apiKey').catch(() => null)
  const secret = await getCredential('dns', 'godaddy', 'apiSecret').catch(() => null)
  if (!key || !secret) return null
  return new GoDaddyClient(key, secret)
}

// ── Service install catalog ───────────────────────────────────────────────────

const SERVICE_CATALOG: Record<string, { port: number; compose: string }> = {
  nextcloud: {
    port: 80,
    compose: `services:
  nextcloud:
    image: nextcloud:latest
    restart: unless-stopped
    ports: ["80:80"]
    volumes: ["./data:/var/www/html"]`,
  },
  jellyfin: {
    port: 8096,
    compose: `services:
  jellyfin:
    image: jellyfin/jellyfin:latest
    restart: unless-stopped
    ports: ["8096:8096"]
    volumes: ["./config:/config", "./media:/media"]`,
  },
  vaultwarden: {
    port: 80,
    compose: `services:
  vaultwarden:
    image: vaultwarden/server:latest
    restart: unless-stopped
    ports: ["80:80"]
    volumes: ["./data:/data"]`,
  },
  gitea: {
    port: 3000,
    compose: `services:
  gitea:
    image: gitea/gitea:latest
    restart: unless-stopped
    ports: ["3000:3000"]
    volumes: ["./data:/data"]`,
  },
  'uptime-kuma': {
    port: 3001,
    compose: `services:
  uptime-kuma:
    image: louislam/uptime-kuma:latest
    restart: unless-stopped
    ports: ["3001:3001"]
    volumes: ["./data:/app/data"]`,
  },
  homepage: {
    port: 3000,
    compose: `services:
  homepage:
    image: ghcr.io/gethomepage/homepage:latest
    restart: unless-stopped
    ports: ["3000:3000"]
    volumes: ["./config:/app/config"]`,
  },
  grafana: {
    port: 3000,
    compose: `services:
  grafana:
    image: grafana/grafana:latest
    restart: unless-stopped
    ports: ["3000:3000"]
    volumes: ["./data:/var/lib/grafana"]`,
  },
}

function getServiceConfig(serviceName: string): { port: number; compose: string } {
  const key = serviceName.toLowerCase().replace(/\s+/g, '-')
  return SERVICE_CATALOG[key] ?? { port: 80, compose: `services:\n  app:\n    image: ${key}:latest\n    restart: unless-stopped\n    ports: ["80:80"]` }
}

function getInstallCommands(serviceName: string): string[] {
  const svc  = getServiceConfig(serviceName)
  const slug = serviceName.toLowerCase().replace(/[^a-z0-9]/g, '-')
  return [
    `# Run these commands inside CT ${slug}:`,
    `apt-get update -qq && apt-get install -y docker.io docker-compose-v2`,
    `mkdir -p /opt/${slug} && cd /opt/${slug}`,
    `cat > docker-compose.yml << 'EOF'`,
    svc.compose,
    `EOF`,
    `docker compose up -d`,
    `# Service will be available on port ${svc.port}`,
  ]
}

// ── Sleep helper ──────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ── Step handlers ─────────────────────────────────────────────────────────────

async function stepCreateLXC(job: JobState): Promise<string> {
  const pve = getPVE()

  // 1. Get next available VMID
  const nextId = await pve.fetchNode<number>('/cluster/nextid')
  const vmid   = Number(nextId)

  // 2. Find node with most free RAM
  const nodes   = await pve.getNodes()
  const online  = nodes.filter(n => n.status === 'online')
  if (!online.length) throw new Error('No online Proxmox nodes found')
  const bestNode = online.sort((a, b) => (b.maxmem - b.mem) - (a.maxmem - a.mem))[0]

  // 3. Find a Debian/Ubuntu template
  let template = ''
  const templateStorages = await pve.fetchNode<any[]>(`/nodes/${bestNode.node}/storage?content=vztmpl`).catch(() => [])

  for (const stor of templateStorages) {
    const contents = await pve.fetchNode<any[]>(
      `/nodes/${bestNode.node}/storage/${stor.storage}/content?content=vztmpl`
    ).catch(() => [])

    const found = contents.find((c: any) =>
      c.volid?.includes('debian-12') || c.volid?.includes('debian-11') || c.volid?.includes('ubuntu-22')
    )
    if (found) { template = found.volid; break }
  }

  if (!template) {
    // Try downloading debian-12 if storage exists
    if (templateStorages.length) {
      const stor = templateStorages[0].storage
      await pve.downloadTemplate(bestNode.node, stor, 'debian-12-standard_12.7-1_amd64.tar.zst').catch(() => {})
      template = `${stor}:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst`
    } else {
      throw new Error('No LXC templates found and no template storage available. Download a Debian 12 template via Proxmox first.')
    }
  }

  // 4. Find rootdir storage with enough space
  const diskGB     = job.plan.requirements?.disk_gb ?? 8
  const rootStores = await pve.fetchNode<any[]>(`/nodes/${bestNode.node}/storage?content=rootdir`).catch(() => [])
  const rootStor   = rootStores.find((s: any) =>
    s.avail > diskGB * 1024 * 1024 * 1024 && s.enabled
  )?.storage ?? 'local-lvm'

  // 5. Build hostname from service name
  const hostname = (job.plan.service ?? 'hyperprox-ct')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .slice(0, 60)

  // 6. Create the LXC
  const ram    = job.plan.requirements?.ram_mb  ?? 512
  const cores  = job.plan.requirements?.cpu_cores ?? 1
  const rootfs = `${rootStor}:${diskGB}`
  const pass   = Math.random().toString(36).slice(-12) + Math.random().toString(36).slice(-4).toUpperCase()

  await pve.createLXC(bestNode.node, {
    vmid,
    hostname,
    ostemplate:   template,
    memory:       ram,
    cores,
    storage:      rootStor,
    rootfs,
    net0:         'name=eth0,bridge=vmbr0,ip=dhcp,firewall=1',
    unprivileged: 1,
    start:        1,
    password:     pass,
    features:     'nesting=1',
    description:  `Deployed by HyperProx AI Wizard — ${new Date().toISOString()}`,
  } as any)

  // 7. Wait for running state (max 90s)
  job.lxcVmid = vmid
  job.lxcNode = bestNode.node

  for (let i = 0; i < 18; i++) {
    await sleep(5000)
    const status = await pve.fetchNode<any>(`/nodes/${bestNode.node}/lxc/${vmid}/status/current`).catch(() => null)
    if (status?.status === 'running') break
    if (i === 17) throw new Error(`CT ${vmid} did not reach running state in 90s`)
  }

  // 8. Get IP address (wait up to 30s for DHCP)
  for (let i = 0; i < 6; i++) {
    await sleep(5000)
    const ifaces = await pve.fetchNode<any[]>(`/nodes/${bestNode.node}/lxc/${vmid}/interfaces`).catch(() => [])
    const eth0   = (ifaces ?? []).find((f: any) => f.name === 'eth0')
    const ip     = eth0?.['inet']?.split('/')?.[0]
    if (ip && !ip.startsWith('169.254')) {
      job.lxcIp = ip
      break
    }
  }

  return `CT ${vmid} (${hostname}) created on ${bestNode.node}${job.lxcIp ? ` · IP: ${job.lxcIp}` : ' · IP pending'}`
}

async function stepInstallService(job: JobState): Promise<string> {
  // Generate install commands — cannot execute directly without SSH to Proxmox host
  // Commands are shown in the UI so the user can run them in the CT console
  const commands = getInstallCommands(job.plan.service ?? 'app')
  const svc      = getServiceConfig(job.plan.service ?? 'app')

  // Store port for proxy step
  job.plan._servicePort = svc.port

  // Attach commands to step so the frontend can display them
  const step = job.steps.find(s => s.type === 'install_service')
  if (step) step.commands = commands

  return `Install commands generated for CT ${job.lxcVmid ?? '?'} · port ${svc.port}`
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

  // Get WAN IP
  const wan = await GoDaddyClient.getWanIP().catch(() => null)
  if (!wan?.ip) throw new Error('Could not determine WAN IP address')
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

  if (!wanIp) return 'Skipped — WAN IP unknown'

  const { Resolver } = await import('dns').then(m => m.promises ? m : require('dns/promises'))

  // Poll up to 5 minutes (30 attempts × 10s)
  for (let i = 0; i < 30; i++) {
    await sleep(10000)
    try {
      const { resolve4 } = await import('dns').then(m => ({ resolve4: (m as any).promises?.resolve4 ?? require('dns/promises').resolve4 }))
      const addrs = await resolve4(domain)
      if (addrs.includes(wanIp)) {
        return `DNS propagated — ${domain} resolves to ${wanIp} (${i * 10 + 10}s)`
      }
    } catch {
      // Not resolved yet — keep polling
    }
  }

  return `DNS propagation timeout — continuing anyway. It may take a few more minutes.`
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

      // Stop execution on failure — don't leave cluster in half-broken state
      if (job.steps[i].status === 'failed') {
        job.status      = 'failed'
        job.error       = job.steps[i].error
        job.completedAt = Date.now()
        emit(jobId)
        return
      }
    }

    job.status      = 'completed'
    job.completedAt = Date.now()
    emit(jobId)

  } catch (err: any) {
    job.status      = 'failed'
    job.error       = err.message
    job.completedAt = Date.now()
    emit(jobId)
  }
}
