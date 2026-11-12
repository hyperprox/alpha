// =============================================================================
//  HyperProx — websites: publishing a catalogue install, and the sites it made
//
//  The "New website" wizard is the catalogue wizard with one more block in its
//  plan: a public name. The plan says exactly which DNS record, proxy host and
//  certificate will be made, and the install job records each one as it is
//  made, so a clean-up removes only those. Three rules hold throughout:
//
//  An existing DNS record is never changed or added to. The plan refuses it,
//  and the run reads the zone again right before it writes.
//
//  A site is not published until its public address answers: the last step
//  fetches https://<name><health path>, not the container.
//
//  A one-time admin sign-in link is a secret. It is made from 32 random bytes,
//  only its SHA-256 goes into WordPress, it lives 60 seconds, works once, is
//  sent by POST (so no access log holds it), and is never logged or stored here.
// =============================================================================

import { createHash, randomBytes } from 'node:crypto'
import { GoDaddyClient } from './godaddy-client'
import { dnsRouter, proxiedProblem } from './dns-providers'
import { zoneFor } from './dns-zones'
import { proxyService, proxyPlanner } from './proxy'
import type { HostSpec } from './proxy/types'
import { wizardStore } from './catalogue-store'
import { findRecipe, healthProblem, type CatalogueRecipe } from './catalogue'
import { ownHeaders } from './own-user-agent'
export { WP_LOGIN_MU_PLUGIN } from './catalogue'

// ── What publishing needs, so tests can stand in for every outside call ──────

export interface DnsLike {
  /** `provider` is which DNS provider serves the zone ('godaddy', 'cloudflare'). */
  getDomains(): Promise<Array<{ domain: string; status?: string; provider?: string }>>
  /** `proxied` is Cloudflare's orange cloud: the name then resolves to Cloudflare, not to this site. */
  getRecords(zone: string): Promise<Array<{ type: string; name: string; data: string; ttl?: number; proxied?: boolean }>>
  createRecord(zone: string, record: { type: 'A'; name: string; data: string; ttl: number }): Promise<void>
  deleteRecord(zone: string, type: 'A', name: string): Promise<void>
}

export interface ProxyLike {
  /** Proxy instances HyperProx can drive, and whether each can be asked for a certificate. */
  instances(): Promise<Array<{ id: string; name: string; kind: string; status?: string; certificates: 'request' | 'provider' | 'none' }>>
  createHost(instanceId: string, spec: HostSpec, actor: { email: string }): Promise<{ hostId: string }>
  attachCertificate(instanceId: string, hostId: string, certId: string, actor: { email: string }): Promise<void>
  deleteHost(instanceId: string, hostId: string, actor: { email: string }): Promise<void>
  requestCertificate(instanceId: string, domains: string[], email: string, actor: { email: string }): Promise<{ id: string }>
}

export interface PublishDeps {
  dns(): Promise<DnsLike | null>
  proxy: ProxyLike
  wanIp(): Promise<string>
  resolve4(name: string): Promise<string[]>
  letsEncryptEmail(): string
  /** GET a public URL: its status and page, or null when nothing answered. */
  fetchPublic(url: string): Promise<{ status: number; body: string } | null>
  wait(ms: number): Promise<unknown>
}

/**
 * Every configured DNS provider behind one router: each zone is written at the provider that serves it.
 * A record created here carries no `proxied`, so at Cloudflare it is DNS only (grey cloud) and Let's Encrypt's
 * HTTP check reaches the proxy.
 */
async function realDns(): Promise<DnsLike | null> {
  const r = await dnsRouter().catch(() => null)
  if (!r) return null
  return {
    // Only zones that are live: a Cloudflare zone still pending its nameserver change answers nobody yet.
    getDomains: async () => (await r.getDomains()).filter(z => z.active),
    getRecords: zone => r.getRecords(zone),
    createRecord: (zone, rec) => r.createRecord(zone, rec),
    deleteRecord: (zone, type, name) => r.deleteRecord(zone, type, name),
  }
}


const realProxy: ProxyLike = {
  async instances() {
    const svc = proxyService()
    const all = await svc.listInstances()
    return Promise.all(all.map(async i => {
      let certificates: 'request' | 'provider' | 'none' = 'none'
      try {
        const { provider } = await svc.provider(i.id)
        certificates = provider.capabilities.requestCertificate ? 'request' : provider.capabilities.certificates === 'auto' ? 'provider' : 'none'
      } catch { /* locked or unreachable: offered as none */ }
      return { id: i.id, name: i.name, kind: i.kind, status: i.status, certificates }
    }))
  },
  async createHost(instanceId, spec, actor) {
    const p = proxyPlanner()
    const r = await p.apply((await p.preview(instanceId, { action: 'create', host: spec }, actor)).id, actor)
    if (!r.ok || !r.hostId) throw new Error(r.message)
    return { hostId: r.hostId }
  },
  async attachCertificate(instanceId, hostId, certId, actor) {
    const p = proxyPlanner()
    const r = await p.apply((await p.preview(instanceId, { action: 'update', hostId,
      host: { npm: { certificate_id: Number(certId), ssl_forced: true, http2_support: true, hsts_enabled: true } } }, actor)).id, actor)
    if (!r.ok) throw new Error(r.message)
  },
  async deleteHost(instanceId, hostId, actor) {
    const p = proxyPlanner()
    const r = await p.apply((await p.preview(instanceId, { action: 'delete', hostId }, actor)).id, actor)
    if (!r.ok) throw new Error(r.message)
  },
  async requestCertificate(instanceId, domains, email, actor) {
    const c = await proxyService().requestCertificate(instanceId, domains, email, actor)
    return { id: String(c.id) }
  },
}

async function publicResolve4(name: string): Promise<string[]> {
  const { Resolver } = await import('dns/promises')
  const r = new Resolver({ timeout: 5000, tries: 1 })
  r.setServers((process.env.DNS_PROPAGATION_RESOLVERS ?? '1.1.1.1,8.8.8.8').split(',').map(s => s.trim()).filter(Boolean))
  return r.resolve4(name)
}

export const realPublishDeps = (): PublishDeps => ({
  dns: realDns,
  proxy: realProxy,
  wanIp: async () => (await GoDaddyClient.getWanIP()).ip,
  resolve4: publicResolve4,
  letsEncryptEmail: () => process.env.LETSENCRYPT_EMAIL ?? process.env.NPM_EMAIL ?? '',
  fetchPublic: url => fetch(url, { headers: ownHeaders('publish-check'), redirect: 'manual', signal: AbortSignal.timeout(8000) })
    .then(async r => ({ status: r.status, body: (await r.text().catch(() => '')).slice(0, 200_000) })).catch(() => null),
  wait: ms => new Promise(r => setTimeout(r, ms)),
})

// ── The plan ─────────────────────────────────────────────────────────────────

export interface PublishInput {
  /** A zone from the DNS provider's list. */
  zone:       string
  /** The label under the zone ('blog', 'www.shop'), or '' / '@' for the zone itself. */
  name?:      string
  instanceId: string
}

export interface PublishPlan {
  domain:       string
  zone:         string
  /** The record name in the zone, '@' for the apex. */
  name:         string
  instanceId:   string
  instanceName: string
  /** The A record the run creates, exactly. The data is the WAN address read when the plan was made. */
  record:       { type: 'A'; name: string; data: string; ttl: number }
  /** 'request': HyperProx asks the proxy for a Let's Encrypt certificate. 'provider': the proxy gets its own. */
  certificate:  'request' | 'provider'
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/** The record names that would collide: anything that already answers for this name. */
const CLASHING = ['A', 'AAAA', 'CNAME']

/**
 * Check a public name against the DNS provider and the proxy, and say exactly what will be made.
 * Errors refuse the plan; nothing here writes anything.
 */
export async function planPublish(raw: unknown, deps: PublishDeps): Promise<{ plan?: PublishPlan; errors: string[]; warnings: string[]; checks: string[]; existing?: Array<{ type: string; data: string }> }> {
  const errors: string[] = [], warnings: string[] = [], checks: string[] = []
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<PublishInput>
  const zoneIn = String(input.zone ?? '').trim().toLowerCase().replace(/\.$/, '')
  const sub = String(input.name ?? '').trim().toLowerCase().replace(/\.$/, '')
  const apex = sub === '' || sub === '@'
  if (!apex && !sub.split('.').every(l => LABEL.test(l))) errors.push(`"${sub}" is not a usable name: lowercase letters, digits and inner hyphens, dot-separated.`)
  const dns = await deps.dns().catch(() => null)
  if (!dns) return { errors: [...errors, 'No DNS provider is set up, so HyperProx cannot make the public name. Add one under Settings → DNS.'], warnings, checks }
  const listed = ((await dns.getDomains().catch(() => [])) ?? [])
  const zones = listed.map(d => String(d.domain ?? '').toLowerCase()).filter(Boolean)
  if (!zones.includes(zoneIn)) errors.push(`${zoneIn || 'No domain'} is not one of the domains your DNS provider lists.`)
  const domain = apex ? zoneIn : `${sub}.${zoneIn}`
  // The longest listed zone the name falls in: a sub-zone listed on its own owns its names.
  const z = zoneFor(domain, zones)
  if (z && z.zone !== zoneIn) errors.push(`${domain} belongs to ${z.zone}, which your provider lists separately. Pick ${z.zone}.`)
  let existing: Array<{ type: string; data: string }> = []
  if (!errors.length) {
    const recs = await dns.getRecords(zoneIn).catch(() => null)
    const name = apex ? '@' : sub
    if (!recs) errors.push(`The records of ${zoneIn} could not be read, so HyperProx cannot promise ${domain} is free.`)
    else {
      existing = recs.filter(r => CLASHING.includes(String(r.type)) && String(r.name ?? '').toLowerCase() === name).map(r => ({ type: r.type, data: r.data }))
      if (existing.length) {
        errors.push(`${domain} already has a DNS record (${existing.map(e => `${e.type} ${e.data}`).join(', ')}). HyperProx never changes or adds to an existing record: pick another name, or remove that record first.`)
      } else checks.push(`${domain} has no A, AAAA or CNAME record yet.`)
    }
  }
  const instances = await deps.proxy.instances().catch(() => [])
  const inst = instances.find(i => i.id === input.instanceId)
  if (!inst) errors.push(instances.length ? 'Pick the proxy that will serve the site.' : 'No proxy is set up. Add one on the Proxy page, or install Nginx Proxy Manager from the catalogue.')
  else if (inst.status === 'locked') errors.push(`${inst.name}'s login is locked in the vault. Sign in to unlock it.`)
  else if (inst.certificates === 'none') errors.push(`${inst.name} (${inst.kind}) cannot be asked for a certificate, so the site could not be served over HTTPS. Pick another proxy.`)
  else checks.push(inst.certificates === 'request' ? `${inst.name} will be asked for a Let's Encrypt certificate.` : `${inst.name} gets its own certificate for ${domain}.`)
  if (inst?.certificates === 'request' && !deps.letsEncryptEmail()) errors.push('No Let\'s Encrypt email is set (LETSENCRYPT_EMAIL), so no certificate can be requested.')
  let wan = ''
  try { wan = await deps.wanIp() } catch { errors.push('This site\'s public address could not be read, so the DNS record cannot be planned.') }
  if (wan && !/^\d{1,3}(\.\d{1,3}){3}$/.test(wan)) errors.push(`"${wan}" is not an IPv4 address.`)
  if (apex) warnings.push(`${domain} is the domain itself: anything else that should answer on it (another site, a parking page) will not.`)
  if (errors.length || !inst) return { errors, warnings, checks, existing }
  const record = { type: 'A' as const, name: apex ? '@' : sub, data: wan, ttl: 600 }
  checks.push(`DNS: A record ${record.name} in ${zoneIn} → ${wan} (TTL ${record.ttl}).`)
  if (listed.find(d => String(d.domain).toLowerCase() === zoneIn)?.provider === 'cloudflare') {
    checks.push(`${zoneIn} is on Cloudflare: the record is made DNS only (grey cloud), so Let's Encrypt reaches the proxy directly.`)
  }
  return {
    plan: { domain, zone: zoneIn, name: record.name, instanceId: inst.id, instanceName: inst.name, record, certificate: inst.certificates as 'request' | 'provider' },
    errors, warnings, checks, existing,
  }
}

// ── The run ──────────────────────────────────────────────────────────────────

/** What a run made, one entry per thing, recorded the moment it exists. Clean-up removes only these. */
export interface PublishLedger {
  proxyHost?: { instanceId: string; hostId: string }
  dnsRecord?: { zone: string; type: 'A'; name: string; data: string }
  certificate?: { instanceId: string; id: string }
}

export const PUBLISH_STEPS = [
  { id: 'proxy',   label: 'Create the proxy host' },
  { id: 'dns',     label: 'Create the DNS record' },
  { id: 'propagate', label: 'Wait for the name to resolve' },
  { id: 'cert',    label: 'Get the certificate' },
  { id: 'public',  label: 'Check the public address' },
] as const

export interface PublishStepHooks {
  step(id: string): { detail?: string; status: string }
  save(): void
}

/**
 * Proxy host, DNS record, propagation, certificate, then the public health check. Each thing is in the ledger
 * before the next step starts. Throws at the first failure; the ledger says what exists.
 */
async function isProxied(dns: DnsLike, plan: PublishPlan): Promise<boolean> {
  const now = await dns.getRecords(plan.zone).catch(() => [])
  return now.some(r => r.type === 'A' && String(r.name ?? '').toLowerCase() === plan.name && r.proxied === true)
}

export async function runPublish(
  plan: PublishPlan, recipe: CatalogueRecipe, ip: string, owner: string, ledger: PublishLedger, hooks: PublishStepHooks, d: PublishDeps,
): Promise<string> {
  const actor = { email: owner || 'hyperprox' }
  // 1. Proxy host, plain HTTP first: the certificate is attached once it exists.
  let s = hooks.step('proxy')
  const host = await d.proxy.createHost(plan.instanceId, {
    domains: [plan.domain], forwardScheme: 'http', forwardHost: ip, forwardPort: recipe.port, enabled: true, websockets: true,
    npm: { certificate_id: false, ssl_forced: false, block_exploits: true, http2_support: false, hsts_enabled: false,
      hsts_subdomains: false, caching_enabled: false, advanced_config: '' },
  } as HostSpec, actor)
  ledger.proxyHost = { instanceId: plan.instanceId, hostId: String(host.hostId) }
  hooks.save()
  s.status = 'done'; s.detail = `${plan.domain} → ${ip}:${recipe.port} on ${plan.instanceName}`

  // 2. DNS, after reading the zone again: a record made since the plan is never overwritten.
  s = hooks.step('dns')
  const dns = await d.dns()
  if (!dns) throw new Error('The DNS provider is no longer set up.')
  const now = await dns.getRecords(plan.zone)
  const clash = now.find(r => CLASHING.includes(String(r.type)) && String(r.name ?? '').toLowerCase() === plan.name)
  if (clash) throw new Error(`${plan.domain} got a ${clash.type} record since the plan was made. HyperProx did not change it.`)
  await dns.createRecord(plan.zone, plan.record)
  ledger.dnsRecord = { zone: plan.zone, ...plan.record }
  hooks.save()
  s.status = 'done'; s.detail = `A ${plan.name} in ${plan.zone} → ${plan.record.data}`

  // 3. Resolves publicly, or the certificate request would fail and count against Let's Encrypt's limit.
  s = hooks.step('propagate')
  let seen = false
  for (let i = 0; i < 30 && !seen; i++) {
    await d.wait(10_000)
    seen = (await d.resolve4(plan.domain).catch(() => [] as string[])).includes(plan.record.data)
  }
  if (!seen) {
    if (await isProxied(dns, plan)) throw new Error(proxiedProblem(plan.domain, plan.record.data))
    throw new Error(`${plan.domain} did not resolve to ${plan.record.data} within 5 minutes. Stopped before the certificate, so no failed request counts against Let's Encrypt's limit.`)
  }
  s.status = 'done'; s.detail = `${plan.domain} resolves to ${plan.record.data}`

  // 4. Certificate.
  s = hooks.step('cert')
  if (plan.certificate === 'request') {
    // Someone may have turned the orange cloud on since the record was made; the request would then fail.
    if (await isProxied(dns, plan)) throw new Error(proxiedProblem(plan.domain, plan.record.data))
    const email = d.letsEncryptEmail()
    if (!email) throw new Error('No Let\'s Encrypt email is set.')
    const c = await d.proxy.requestCertificate(plan.instanceId, [plan.domain], email, actor)
    ledger.certificate = { instanceId: plan.instanceId, id: String(c.id) }
    hooks.save()
    await d.proxy.attachCertificate(plan.instanceId, ledger.proxyHost.hostId, String(c.id), actor)
    s.detail = `issued and attached; HTTPS is forced`
  } else s.detail = `${plan.instanceName} gets its own certificate`
  s.status = 'done'

  // 5. The public address, which is what the person will open.
  s = hooks.step('public')
  const url = `https://${plan.domain}`
  let why = 'did not answer'
  for (let i = 0; i < 12; i++) {
    if (i) await d.wait(5000)
    const r = await d.fetchPublic(url + recipe.healthPath)
    const p = r ? healthProblem(recipe, r.status, r.body) : 'did not answer'
    if (!p) { s.status = 'done'; s.detail = `${url}${recipe.healthPath} answered ${r!.status}`; return url }
    why = p
  }
  throw new Error(`${url}${recipe.healthPath} ${why}.`)
}

/**
 * Remove what a run's ledger says it made, newest first. A DNS record is deleted only while it still holds the
 * exact address the run wrote; the name may have been reused since. A certificate stays: proxies offer no way
 * to remove one here, and it expires by itself. Returns one sentence per thing.
 */
export async function cleanupPublish(ledger: PublishLedger, owner: string, d: PublishDeps): Promise<string[]> {
  const out: string[] = []
  const actor = { email: owner || 'hyperprox' }
  if (ledger.dnsRecord) {
    const r = ledger.dnsRecord
    const dns = await d.dns().catch(() => null)
    const fqdn = r.name === '@' ? r.zone : `${r.name}.${r.zone}`
    if (!dns) out.push(`The DNS record for ${fqdn} was kept: the DNS provider is not set up now.`)
    else {
      const now = (await dns.getRecords(r.zone).catch(() => null))
      const same = now?.filter(x => x.type === 'A' && String(x.name).toLowerCase() === r.name)
      if (!now) out.push(`The DNS record for ${fqdn} was kept: the zone could not be read.`)
      else if (!same?.length) { out.push(`The DNS record for ${fqdn} is already gone.`); ledger.dnsRecord = undefined }
      else if (same.length !== 1 || same[0].data !== r.data) out.push(`The DNS record for ${fqdn} was kept: it no longer holds only ${r.data}, so it is not just the one this install made.`)
      else { await dns.deleteRecord(r.zone, 'A', r.name); out.push(`Removed the DNS record ${fqdn} → ${r.data}.`); ledger.dnsRecord = undefined }
    }
  }
  if (ledger.proxyHost) {
    try { await d.proxy.deleteHost(ledger.proxyHost.instanceId, ledger.proxyHost.hostId, actor); out.push('Removed the proxy host.'); ledger.proxyHost = undefined }
    catch (e: any) { out.push(`The proxy host was kept: ${e.message}`) }
  }
  if (ledger.certificate) out.push('The certificate was left on the proxy; it expires by itself, or remove it there.')
  return out
}

// ── The sites it made ────────────────────────────────────────────────────────

export interface SiteRecord {
  id: string; recipeId: string; name: string
  vmid: number; node: string; ip?: string
  domain?: string; url?: string; localUrl?: string
  /** The vault item holding the generated logins, when there is one. */
  vault?: { category: string; provider: string }
  adminUser?: string
  jobId: string; owner: string; createdAt: number
}

export async function recordSite(s: SiteRecord): Promise<void> {
  await wizardStore().put({ id: `site:${s.id}`, kind: 'site', owner: s.owner, data: s, expiresAt: null })
}
export async function listSites(): Promise<SiteRecord[]> {
  return (await wizardStore().list('site')).map(r => r.data as SiteRecord).sort((a, b) => b.createdAt - a.createdAt)
}
export async function getSite(id: string): Promise<SiteRecord | undefined> {
  const r = await wizardStore().get(`site:${id}`).catch(() => null)
  return r?.kind === 'site' ? (r.data as SiteRecord) : undefined
}
export async function forgetSite(id: string): Promise<void> { await wizardStore().delete(`site:${id}`) }

// ── The one-time WordPress admin sign-in ─────────────────────────────────────

export const ADMIN_LINK_TTL_S = 60

/**
 * A one-time sign-in for a WordPress site HyperProx installed. Returns the token for the browser and the script
 * that stores only its hash in WordPress. The script carries the hash on standard input, never on a command line.
 */
export function makeAdminLogin(site: SiteRecord, now = Date.now()): { token: string; expiresAt: number; script: string; postUrl: string } {
  if (site.recipeId !== 'wordpress') throw new Error('Only a WordPress site has an admin sign-in link.')
  if (!site.adminUser || !/^[a-z0-9][a-z0-9._-]*$/.test(site.adminUser)) throw new Error('This site has no admin user on record.')
  const token = randomBytes(32).toString('base64url')
  const hash = createHash('sha256').update(token).digest('hex')
  const expiresAt = Math.floor(now / 1000) + ADMIN_LINK_TTL_S
  const value = JSON.stringify({ hash, exp: expiresAt, user: site.adminUser })
  const script = [
    'set -e',
    // The value is JSON of hex, digits and a checked user name; it goes to WP-CLI on standard input.
    `runuser -u www-data -- env HOME=/var/www /usr/local/bin/wp --path=/var/www/wordpress option update hyperprox_login --format=json --autoload=no >/dev/null <<'HP_LOGIN'`,
    value,
    'HP_LOGIN',
    'echo stored',
  ].join('\n')
  const base = site.url ?? site.localUrl
  if (!base) throw new Error('This site has no address.')
  return { token, expiresAt: expiresAt * 1000, script, postUrl: `${base}/wp-login.php?action=hyperprox` }
}

/** A health read of a site: the container and, when published, the public address. */
export async function siteHealth(site: SiteRecord, probe: (url: string) => Promise<{ status: number; body: string } | null>): Promise<Array<{ url: string; ok: boolean; detail: string }>> {
  const recipe = findRecipe(site.recipeId)
  if (!recipe) return []
  const urls = [site.localUrl, site.url].filter((u): u is string => Boolean(u))
  return Promise.all(urls.map(async u => {
    const r = await probe(u + recipe.healthPath)
    const p = r ? healthProblem(recipe, r.status, r.body) : 'did not answer'
    return { url: u + recipe.healthPath, ok: !p, detail: p ?? `answered ${r!.status}` }
  }))
}
