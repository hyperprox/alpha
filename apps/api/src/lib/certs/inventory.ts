// =============================================================================
//  HyperProx — certificate inventory
//
//  One list of every certificate the network has, wherever it comes from: the
//  proxy's (its API), HyperProx's own (DNS-01), the hypervisor nodes' (their
//  API), and anything a probe found served that none of those explain. Each
//  entry carries the worst verdict of the endpoints that serve it, so a good
//  certificate on disk cannot hide a bad one on the wire.
// =============================================================================

import type { NPMCertificate } from '../npm-client'
import type { CertsInventoryEntry, CertsManaged, CertsProbe, CertsStartTls, CertsVerdict } from './types'
import { daysPhrase, fractionPhrase, normalizeFingerprint, STAGING_ISSUERS, type ProbeTarget } from './probe'

/**
 * The part of the policy (policy.ts, CertsPolicy) the inventory reads. Declared structurally so this module
 * does not depend on the loader; a full CertsPolicy satisfies it.
 */
export interface InventoryPolicy {
  alerts:       { warnFraction: number; criticalDays: number }
  certificates: Record<string, { names: string[]; deploy: { target: string }[] }>
  probes:       { host: string; port: number; starttls: CertsStartTls; internal: boolean; connect?: string | null }[]
  targets:      Record<string, { kind: string }>
}

export interface NodeCertificate {
  filename:     string
  issuer:       string
  notbefore:    number          // epoch seconds, as Proxmox reports them
  notafter:     number
  san?:         string[]
  fingerprint?: string
}

export interface InventoryDeps {
  npmCertificates(): Promise<NPMCertificate[]>
  npmHosts(): Promise<{ domain_names: string[]; certificate_id: number | null; enabled: boolean }[]>
  nodeCertificates(): Promise<{ node: string; host: string; certs: NodeCertificate[] }[]>
  managed: CertsManaged[]
  probes:  CertsProbe[]
  policy:  InventoryPolicy
  now:     Date
}

export const NODE_CONSOLE_PORT = 8006
const DAY_MS = 86_400_000

// Issuers whose certificates came from a public ACME CA rather than a node's own cluster CA.
const PUBLIC_ACME = /Let's Encrypt|\(STAGING\)|ZeroSSL|Buypass|Google Trust Services|SSL\.com|\bPebble\b/i

// pveproxy serves pveproxy-ssl.pem when it exists (a custom or ACME certificate), else pve-ssl.pem.
const PVE_CUSTOM = 'pveproxy-ssl.pem'
const PVE_DEFAULT = 'pve-ssl.pem'
const PVE_ROOT_CA = 'pve-root-ca.pem'

const SEVERITY: Record<CertsVerdict, number> = { ok: 0, unknown: 1, warn: 2, error: 3, critical: 4 }

export function worseVerdict(a: CertsVerdict, b: CertsVerdict): boolean {
  return SEVERITY[a] > SEVERITY[b]
}

const endpoint = (host: string, port: number) => `${host.toLowerCase()}:${port}`
const probeable = (name: string) => !name.startsWith('*.')

/** Hosts a managed certificate is delivered to over HTTPS on 443 (target kinds that serve its names there). */
function managedHttpsHosts(policy: InventoryPolicy, label: string, names: string[]): string[] {
  const spec = policy.certificates[label]
  if (!spec) return []
  const servesNames = spec.deploy.some(d => policy.targets[d.target]?.kind === 'hyperprox')
  return servesNames ? names.filter(probeable) : []
}

/**
 * Every endpoint worth probing, de-duplicated by host:port. When two sources name the same endpoint, the
 * first wins in this order: policy probes (tagged managed when they serve a managed name), managed targets,
 * proxy hosts, node consoles. Policy comes first because it is the only source that knows STARTTLS.
 */
export async function discoverProbeTargets(
  d: Pick<InventoryDeps, 'npmHosts' | 'nodeCertificates' | 'policy' | 'managed'>,
): Promise<(ProbeTarget & { source: CertsProbe['source'] })[]> {
  const out  = new Map<string, ProbeTarget & { source: CertsProbe['source'] }>()
  const add  = (t: ProbeTarget & { source: CertsProbe['source'] }) => {
    const k = endpoint(t.host, t.port)
    if (!out.has(k)) out.set(k, t)
  }
  const managedNames = new Set(d.managed.flatMap(m => m.names.map(n => n.toLowerCase())))
  for (const [label, spec] of Object.entries(d.policy.certificates)) {
    if (!d.managed.some(m => m.label === label)) spec.names.forEach(n => managedNames.add(n.toLowerCase()))
  }

  for (const p of d.policy.probes) {
    add({ host: p.host, port: p.port, starttls: p.starttls, internal: p.internal, connect: p.connect,
          source: managedNames.has(p.host.toLowerCase()) ? 'managed' : 'policy' })
  }
  const labels = new Set([...d.managed.map(m => m.label), ...Object.keys(d.policy.certificates)])
  for (const label of labels) {
    const names = d.managed.find(m => m.label === label)?.names ?? d.policy.certificates[label]?.names ?? []
    for (const host of managedHttpsHosts(d.policy, label, names)) {
      add({ host, port: 443, starttls: 'none', internal: false, source: 'managed' })
    }
  }

  const [hosts, nodes] = await Promise.all([d.npmHosts(), d.nodeCertificates()])
  for (const h of hosts) {
    // A host without a certificate answers 443 with the proxy's default certificate: noise, not a finding.
    if (!h.enabled || !h.certificate_id) continue
    for (const name of h.domain_names) {
      if (probeable(name)) add({ host: name, port: 443, starttls: 'none', internal: false, source: 'proxy' })
    }
  }
  for (const n of nodes) {
    add({ host: n.host, port: NODE_CONSOLE_PORT, starttls: 'none', internal: true, source: 'node' })
  }
  return [...out.values()]
}

// --- building entries -----------------------------------------------------------

type Draft = Omit<CertsInventoryEntry, 'verdict' | 'reason' | 'daysLeft' | 'lifetimeDays'> & {
  endpoints:    string[]                                   // host:port keys whose probes judge this entry
  fingerprint?: string
  baseVerdict:  CertsVerdict
  baseReason:   string | null
  notAfterMs:   number | null
}

function iso(d: Date | null): string | null {
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null
}

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Verdict from dates alone: what can be said without looking at the wire. */
function dateVerdict(notBefore: Date | null, notAfter: Date | null, now: Date, policy: InventoryPolicy): { verdict: CertsVerdict; reason: string | null } {
  if (!notAfter) return { verdict: 'unknown', reason: null }
  const left = notAfter.getTime() - now.getTime()
  if (left <= 0) return { verdict: 'critical', reason: `expired ${daysPhrase(left)}` }
  if (left < policy.alerts.criticalDays * DAY_MS) return { verdict: 'critical', reason: `expires ${daysPhrase(left)}` }
  if (notBefore) {
    const lifetime = notAfter.getTime() - notBefore.getTime()
    if (lifetime > 0 && left / lifetime < policy.alerts.warnFraction) {
      return { verdict: 'warn', reason: `expires ${daysPhrase(left)}, with less than ${fractionPhrase(policy.alerts.warnFraction)} of its ${Math.round(lifetime / DAY_MS)}-day lifetime left` }
    }
  }
  return { verdict: 'ok', reason: null }
}

function npmRenewal(c: NPMCertificate): string {
  if (c.provider === 'letsencrypt') return c.meta?.dns_challenge ? 'Proxy (DNS-01)' : 'Proxy (HTTP-01)'
  return 'Uploaded to the proxy (no renewal)'
}

function npmDrafts(certs: NPMCertificate[], hosts: Awaited<ReturnType<InventoryDeps['npmHosts']>>, d: InventoryDeps): Draft[] {
  return certs.map(c => {
    const users    = hosts.filter(h => h.certificate_id === c.id)
    const usedBy   = [...new Set(users.flatMap(h => h.domain_names))]
    const notAfter = parseDate(c.expires_on)
    // The proxy's API gives no issue date. The row's modified_on moves on every renewal, so it is the issue
    // date to within the renewal job's run time; anything implausible is ignored rather than guessed at.
    const modified = parseDate((c as NPMCertificate & { modified_on?: string }).modified_on)
    const notBefore = modified && notAfter && modified < notAfter && notAfter.getTime() - modified.getTime() < 400 * DAY_MS ? modified : null
    let { verdict, reason } = dateVerdict(notBefore, notAfter, d.now, d.policy)
    if (!usedBy.length && notAfter && notAfter <= d.now) {
      // Dead and unused: a housekeeping item, not an outage.
      verdict = 'warn'
      reason  = `expired ${daysPhrase(notAfter.getTime() - d.now.getTime())} and no proxy host uses it`
    }
    return {
      id: `npm:${c.id}`, source: 'npm', names: c.domain_names,
      issuer: c.provider === 'letsencrypt' ? "Let's Encrypt" : null,
      notBefore: iso(notBefore), notAfter: iso(notAfter),
      renewal: npmRenewal(c), selfSigned: false, staging: false, usedBy,
      endpoints: users.filter(h => h.enabled).flatMap(h => h.domain_names.map(n => endpoint(n, 443))),
      baseVerdict: verdict, baseReason: reason, notAfterMs: notAfter?.getTime() ?? null,
    }
  })
}

function managedDrafts(d: InventoryDeps, probes: CertsProbe[]): Draft[] {
  return d.managed.map(m => {
    const notBefore = parseDate(m.notBefore)
    const notAfter  = parseDate(m.notAfter)
    const names     = new Set(m.names.map(n => n.toLowerCase()))
    const endpoints = probes.filter(p => names.has(p.host.toLowerCase())).map(p => endpoint(p.host, p.port))
    let { verdict, reason } = dateVerdict(notBefore, notAfter, d.now, d.policy)
    if (!notAfter) {
      if (m.status === 'failed') { verdict = 'error'; reason = `issuance failed: ${m.lastError ?? 'no reason recorded'}` }
      else if (m.status === 'renewing') { verdict = 'unknown'; reason = 'being issued now' }
      else { verdict = 'unknown'; reason = 'not issued yet' }
    } else if (m.status === 'failed') {
      const failure = `its last renewal failed: ${m.lastError ?? 'no reason recorded'}`
      if (verdict === 'ok') { verdict = 'warn'; reason = failure }
      else reason = `${reason} and ${failure}`
    } else if (m.staging && verdict === 'ok') {
      verdict = 'warn'; reason = 'is a staging certificate, which clients do not trust'
    }
    return {
      id: `managed:${m.label}`, source: 'managed', names: m.names, issuer: m.issuer,
      notBefore: iso(notBefore), notAfter: iso(notAfter), renewal: 'HyperProx (DNS-01)',
      selfSigned: false, staging: m.staging,
      usedBy: [...m.targets.map(t => t.name), ...endpoints],
      endpoints, baseVerdict: verdict, baseReason: reason, notAfterMs: notAfter?.getTime() ?? null,
    }
  })
}

function sanName(s: string): string {
  return s.replace(/^(DNS|IP Address|IP):/i, '').trim()
}

function nodeDrafts(nodes: Awaited<ReturnType<InventoryDeps['nodeCertificates']>>, d: InventoryDeps): Draft[] {
  const out: Draft[] = []
  for (const n of nodes) {
    const hasCustom = n.certs.some(c => c.filename === PVE_CUSTOM)
    for (const c of n.certs) {
      // The root CA signs, it does not serve; pve-ssl.pem is unused while a custom certificate is installed.
      if (c.filename === PVE_ROOT_CA || (hasCustom && c.filename === PVE_DEFAULT)) continue
      const notBefore = c.notbefore ? new Date(c.notbefore * 1000) : null
      const notAfter  = c.notafter ? new Date(c.notafter * 1000) : null
      const served    = c.filename === PVE_CUSTOM || (!hasCustom && c.filename === PVE_DEFAULT)
      const ep        = endpoint(n.host, NODE_CONSOLE_PORT)
      const { verdict, reason } = dateVerdict(notBefore, notAfter, d.now, d.policy)
      out.push({
        id: `pve:${n.node}:${c.filename}`, source: 'pve',
        names: (c.san ?? []).map(sanName).filter(Boolean),
        issuer: c.issuer || null, notBefore: iso(notBefore), notAfter: iso(notAfter),
        renewal: PUBLIC_ACME.test(c.issuer) ? 'Proxmox ACME' : 'Proxmox internal CA',
        selfSigned: false, staging: STAGING_ISSUERS.test(c.issuer),
        usedBy: served ? [`${n.node} console (${n.host}:${NODE_CONSOLE_PORT})`] : [],
        endpoints: served ? [ep] : [],
        fingerprint: c.fingerprint,
        baseVerdict: verdict, baseReason: reason, notAfterMs: notAfter?.getTime() ?? null,
      })
    }
  }
  return out
}

/** Does this probe show this entry's certificate? A fingerprint settles it; otherwise the expiry must agree. */
function servesEntry(p: CertsProbe, e: Draft): boolean {
  if (p.fingerprint && e.fingerprint) return normalizeFingerprint(p.fingerprint) === normalizeFingerprint(e.fingerprint)
  const pAfter = parseDate(p.notAfter)
  return !!pAfter && e.notAfterMs !== null && Math.abs(pAfter.getTime() - e.notAfterMs) < DAY_MS
}

export async function buildInventory(d: InventoryDeps): Promise<CertsInventoryEntry[]> {
  const [certs, hosts, nodes] = await Promise.all([d.npmCertificates(), d.npmHosts(), d.nodeCertificates()])
  const drafts = [...managedDrafts(d, d.probes), ...npmDrafts(certs, hosts, d), ...nodeDrafts(nodes, d)]

  const explained = new Set<CertsProbe>()
  const entries: CertsInventoryEntry[] = drafts.map(e => {
    let verdict = e.baseVerdict
    let reason  = e.baseReason
    let issuer  = e.issuer
    let staging = e.staging
    for (const p of d.probes) {
      const at = endpoint(p.host, p.port)
      const fingerprintHit = !!(p.fingerprint && e.fingerprint && servesEntry(p, e))
      if (!e.endpoints.includes(at) && !fingerprintHit) continue
      // A managed target serving the old certificate is this entry's problem, not a stranger's; so is an
      // endpoint that serves nothing. Elsewhere a probe only judges the certificate it actually saw.
      const serves = servesEntry(p, e)
      if (!(serves || e.source === 'managed' || p.verdict === 'error')) continue
      explained.add(p)
      if (serves && p.issuer) {
        issuer ??= p.issuer
        staging ||= STAGING_ISSUERS.test(p.issuer)
      }
      if (worseVerdict(p.verdict, verdict)) {
        verdict = p.verdict
        reason  = `${p.host}:${p.port} ${p.reason ?? p.verdict}`
      }
    }
    return finish(e, d.now, verdict, reason, issuer, staging)
  })

  // Whatever is served that nothing above accounts for: a daemon's own self-signed fallback, typically.
  for (const p of d.probes) {
    if (explained.has(p) || !p.fingerprint) continue
    const notAfter = parseDate(p.notAfter)
    entries.push({
      id: `probe:${endpoint(p.host, p.port)}`, source: 'probe', names: [p.host],
      issuer: p.issuer, notBefore: null, notAfter: iso(notAfter), lifetimeDays: null,
      daysLeft: notAfter ? Math.floor((notAfter.getTime() - d.now.getTime()) / DAY_MS) : null,
      renewal: 'Not managed by HyperProx or the proxy',
      selfSigned: /self-signed/i.test(p.reason ?? ''),
      staging: !!p.issuer && STAGING_ISSUERS.test(p.issuer),
      verdict: p.verdict, reason: p.reason, usedBy: [`${p.host}:${p.port}`],
    })
  }

  return entries.sort((a, b) =>
    SEVERITY[b.verdict] - SEVERITY[a.verdict] || (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) || a.id.localeCompare(b.id))
}

function finish(e: Draft, now: Date, verdict: CertsVerdict, reason: string | null, issuer: string | null, staging: boolean): CertsInventoryEntry {
  const notBefore = parseDate(e.notBefore)
  const notAfter  = parseDate(e.notAfter)
  return {
    id: e.id, source: e.source, names: e.names, issuer,
    notBefore: e.notBefore, notAfter: e.notAfter,
    lifetimeDays: notBefore && notAfter ? Math.round((notAfter.getTime() - notBefore.getTime()) / DAY_MS) : null,
    daysLeft:     notAfter ? Math.floor((notAfter.getTime() - now.getTime()) / DAY_MS) : null,
    renewal: e.renewal, selfSigned: e.selfSigned, staging,
    verdict, reason, usedBy: e.usedBy,
  }
}
