// =============================================================================
//  HyperProx — Certificates: the seam to the modules built alongside this one
//
//  policy, timing, dns01, acme (one branch) and probe, inventory, housekeeping,
//  alerts (another) were written at the same time as the service. The service
//  never imports them directly: it takes a CertsModules object, and this file
//  is the only place that names them. Until they are merged the bodies below
//  are minimal stand-ins with the contract's signatures; at merge the
//  stand-ins are swapped for the real modules here and nothing else changes.
//
//  MERGE: delete the contract type copies (policy.ts ... alerts.ts sections)
//  and the stand-ins section, keep the CertsModules interface and
//  productionSources(), and add
//
//    export type { KeyType, TargetSpec, CertsPolicy } from './policy'
//    export type { DnsProvider } from './dns01'
//    export type { IssueDeps, IssuedBundle } from './acme'
//    export type { ProbeTarget, ProbeResult, ProbeOptions } from './probe'
//    export type { InventoryDeps } from './inventory'
//    export type { HousekeepingDeps } from './housekeeping'
//    export type { AlertState } from './alerts'
//    import { loadCertsPolicy, LE_STAGING } from './policy'
//    import { renewAfter, dueForRenewal } from './timing'
//    import { godaddyProvider } from './dns01'
//    import { issueCertificate, fetchAri, zonesFor } from './acme'
//    import { probeEndpoint, verdictFor } from './probe'
//    import { discoverProbeTargets, buildInventory } from './inventory'
//    import { listHousekeeping, applyHousekeeping } from './housekeeping'
//    import { alertChanges, sendWebhook } from './alerts'
//    export const defaultModules: CertsModules = { loadCertsPolicy, LE_STAGING, renewAfter, dueForRenewal,
//      godaddyProvider, issueCertificate, fetchAri, zonesFor, probeEndpoint, verdictFor,
//      discoverProbeTargets, buildInventory, listHousekeeping, applyHousekeeping, alertChanges, sendWebhook }
//
//  then wire the two sources marked MERGE in productionSources().
// =============================================================================

import type { GoDaddyClient } from '../godaddy-client'
import { NPMClient, type NPMCertificate } from '../npm-client'
import { getProviderCredentials } from '../credentials'
import { livePve } from '../pve-env'
import type {
  CertsHousekeepingItem, CertsInventoryEntry, CertsManaged, CertsProbe, CertsStartTls, CertsVerdict,
} from './types'

// --- policy.ts -----------------------------------------------------------------------

export type KeyType = 'ec256' | 'ec384' | 'rsa2048' | 'rsa4096'
export type TargetSpec =
  | { kind: 'guest-files'; vmid: number; files: { fullchain: string; key: string; cert?: string; chain?: string };
      owner: string; keyMode: string; reload: string | null }
  | { kind: 'hyperprox' }
export interface CertsPolicy {
  acme:   { directoryUrl: string; staging: boolean; email: string | null; keyType: KeyType }
  schedule: { check: string }
  alerts: { warnFraction: number; criticalDays: number; webhookUrl: string | null }
  certificates: Record<string, { names: string[]; deploy: { target: string }[] }>
  probes: { host: string; port: number; starttls: CertsStartTls; internal: boolean }[]
  targets: Record<string, TargetSpec>
  proxy:  { guestVmid: number | null }
}

// --- dns01.ts / acme.ts ---------------------------------------------------------------

export interface DnsProvider {
  name: string
  zones(): Promise<string[]>
  present(zone: string, fqdn: string, value: string): Promise<void>
  cleanup(zone: string, fqdn: string, value: string): Promise<void>
}
export interface IssueDeps {
  directoryUrl: string
  email: string | null
  getAccountKey(): Promise<string | null>
  saveAccountKey(pem: string): Promise<void>
  dns: DnsProvider[]
  log(line: string): void
  propagation?: { timeoutMs?: number; intervalMs?: number; zone?: string; authoritative?: (zone: string) => Promise<string[]> }
}
export interface IssuedBundle { keyPem: string; certPem: string; chainPem: string; fullchainPem: string;
  notBefore: Date; notAfter: Date; serial: string; issuer: string; fingerprint256: string }

// --- probe.ts / inventory.ts / housekeeping.ts / alerts.ts -------------------------------

export interface ProbeTarget { host: string; port: number; starttls: CertsStartTls; servername?: string; internal?: boolean }
export interface ProbeResult {
  ok: boolean; error?: string
  leaf?: { subject: string; issuer: string; names: string[]; notBefore: Date; notAfter: Date; serial: string; fingerprint256: string; selfSigned: boolean }
  trusted: boolean | null; authorizationError?: string; namesMatch: boolean | null
}
export interface InventoryDeps {
  npmCertificates(): Promise<NPMCertificate[]>
  npmHosts(): Promise<{ domain_names: string[]; certificate_id: number | null; enabled: boolean }[]>
  nodeCertificates(): Promise<{ node: string; host: string; certs: { filename: string; issuer: string; notbefore: number; notafter: number; san?: string[]; fingerprint?: string }[] }[]>
  managed: CertsManaged[]
  probes: CertsProbe[]
  policy: CertsPolicy
  now: Date
}
export interface HousekeepingDeps {
  npmCertificates(): Promise<NPMCertificate[]>
  npmHosts(): Promise<{ certificate_id: number | null }[]>
  deleteNpmCertificate(id: number): Promise<void>
  guestExec: ((script: string) => Promise<{ code: number; output: string }>) | null
  warn?: (message: string) => void
}
export interface ProbeOptions { ca?: string | string[] }
export interface AlertState { key: string; verdict: CertsVerdict; reason: string | null }

// --- The seam ---------------------------------------------------------------------------

export interface CertsModules {
  loadCertsPolicy(path?: string): { loaded: boolean; path: string; error?: string; policy: CertsPolicy }
  LE_STAGING: string
  renewAfter(c: { notBefore: Date; notAfter: Date }, ari: { start: Date; end: Date } | null, rand?: () => number): Date
  dueForRenewal(now: Date, renewAfterAt: Date | null, notAfter: Date | null): boolean
  godaddyProvider(client: GoDaddyClient): DnsProvider
  issueCertificate(deps: IssueDeps, names: string[], keyType: KeyType): Promise<IssuedBundle>
  fetchAri(directoryUrl: string, certPem: string): Promise<{ start: Date; end: Date } | null>
  zonesFor(names: string[], dns: DnsProvider[]): Promise<{ name: string; zone: string | null; provider: string | null }[]>
  probeEndpoint(t: ProbeTarget, timeoutMs?: number, opts?: ProbeOptions): Promise<ProbeResult>
  verdictFor(r: ProbeResult, ctx: { now: Date; warnFraction: number; criticalDays: number;
    expectFingerprint?: string; internal?: boolean; stagingIssuers?: RegExp }): { verdict: CertsVerdict; reason: string | null }
  discoverProbeTargets(d: Pick<InventoryDeps, 'npmHosts' | 'nodeCertificates' | 'policy' | 'managed'>): Promise<(ProbeTarget & { source: CertsProbe['source'] })[]>
  buildInventory(d: InventoryDeps): Promise<CertsInventoryEntry[]>
  listHousekeeping(d: HousekeepingDeps, now: Date): Promise<CertsHousekeepingItem[]>
  applyHousekeeping(item: CertsHousekeepingItem, d: HousekeepingDeps): Promise<string>
  alertChanges(prev: Map<string, AlertState>, next: AlertState[], now: Date, lastReminder: Date | null):
    { messages: string[]; state: Map<string, AlertState>; reminderSent: boolean }
  sendWebhook(url: string, messages: string[]): Promise<void>
}

// --- Stand-ins until merge -----------------------------------------------------------------
// Deliberately inert: nothing here reaches a CA, a DNS provider or an endpoint.

const LE_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory'
const NOT_MERGED = (what: string) => new Error(`${what} is not part of this build yet`)

const DEFAULT_POLICY: CertsPolicy = {
  acme: { directoryUrl: LE_PRODUCTION, staging: false, email: null, keyType: 'ec256' },
  schedule: { check: '15 6 * * *' },
  alerts: { warnFraction: 0.33, criticalDays: 7, webhookUrl: null },
  certificates: {}, probes: [], targets: {}, proxy: { guestVmid: null },
}

export const defaultModules: CertsModules = {
  loadCertsPolicy: (path = '/opt/hyperprox/config/certs.yaml') =>
    ({ loaded: false, path, error: 'certificate policy support is not part of this build yet', policy: DEFAULT_POLICY }),
  LE_STAGING: 'https://acme-staging-v02.api.letsencrypt.org/directory',
  renewAfter: c => new Date(c.notBefore.getTime() + (c.notAfter.getTime() - c.notBefore.getTime()) * 2 / 3),
  dueForRenewal: (now, at, notAfter) => (at !== null && now >= at) || (notAfter !== null && now >= notAfter),
  godaddyProvider: () => ({
    name: 'godaddy',
    zones: async () => [],
    present: async () => { throw NOT_MERGED('DNS-01') },
    cleanup: async () => undefined,
  }),
  issueCertificate: async () => { throw NOT_MERGED('ACME issuance') },
  fetchAri: async () => null,
  zonesFor: async names => names.map(name => ({ name, zone: null, provider: null })),
  probeEndpoint: async () => ({ ok: false, error: 'the TLS probe is not part of this build yet', trusted: null, namesMatch: null }),
  verdictFor: r => (r.ok ? { verdict: 'ok', reason: null } : { verdict: 'error', reason: r.error ?? 'probe failed' }),
  discoverProbeTargets: async d => d.policy.probes.map(p => ({ ...p, source: 'policy' as const })),
  buildInventory: async () => [],
  listHousekeeping: async () => [],
  applyHousekeeping: async () => { throw NOT_MERGED('Housekeeping') },
  alertChanges: (prev, next) => ({ messages: [], state: new Map(next.map(s => [s.key, s])), reminderSent: false }),
  sendWebhook: async () => undefined,
}

// --- Read-only sources for inventory, discovery and housekeeping ------------------------------
// nodeCertificates and deleteNpmCertificate call client methods the watch branch adds
// (ProxmoxClient.getNodeCertificates, NPMClient.deleteCertificate). They are reached through the
// structural types below so this file compiles before that merge and needs no edit after it; until
// then they throw, which the service reports as "unavailable" rather than as "nothing there".

export interface CertsSources {
  npmCertificates(): Promise<NPMCertificate[]>
  npmHosts(): Promise<{ domain_names: string[]; certificate_id: number | null; enabled: boolean }[]>
  nodeCertificates: InventoryDeps['nodeCertificates']
  deleteNpmCertificate(id: number): Promise<void>
}

async function npmClient(): Promise<NPMClient> {
  const c = await getProviderCredentials('proxy', 'npm')
  if (!c?.url || !c?.email || !c?.password) throw new Error('Nginx Proxy Manager is not configured')
  return new NPMClient(c.url, c.email, c.password)
}

export function productionSources(): CertsSources {
  return {
    npmCertificates: async () => (await npmClient()).getCertificates(),
    npmHosts: async () => (await (await npmClient()).getProxyHosts()).map(h => ({
      domain_names: h.domain_names,
      certificate_id: typeof h.certificate_id === 'number' && h.certificate_id > 0 ? h.certificate_id : null,
      enabled: !!h.enabled,
    })),
    nodeCertificates: () => nodeCertificatesFromPve(),
    async deleteNpmCertificate(id) {
      const c = await npmClient() as unknown as Partial<{ deleteCertificate(id: number): Promise<void> }>
      if (typeof c.deleteCertificate !== 'function') throw NOT_MERGED('Deleting proxy certificates')
      await c.deleteCertificate(id)
    },
  }
}

type NodeCertInfo = { filename: string; issuer: string; notbefore: number; notafter: number; san?: string[]; fingerprint?: string }

/**
 * Each online node's pveproxy certificates, with the address its console is probed on (the node's IP from
 * cluster status, not its name: node names need not resolve from here). A node that fails is left out; if
 * every node fails, the first error is thrown so the page says the source is down.
 */
async function nodeCertificatesFromPve(): Promise<{ node: string; host: string; certs: NodeCertInfo[] }[]> {
  const pve = livePve()
  const rows = await pve.fetchStrict<any[]>('/cluster/status')
  if (!Array.isArray(rows)) throw new Error('Proxmox returned no cluster status')
  const nodes = rows.filter(r => r.type === 'node' && r.online === 1)
    .map(r => ({ name: String(r.name), ip: r.ip ? String(r.ip) : String(r.name) }))
  const api = pve as unknown as Partial<{ getNodeCertificates(node: string): Promise<NodeCertInfo[]> }>
  if (typeof api.getNodeCertificates !== 'function') throw NOT_MERGED('Reading node certificates')
  const got = await Promise.allSettled(nodes.map(async n => ({
    node: n.name, host: n.ip,
    certs: (await api.getNodeCertificates!(n.name)).map(c => ({
      filename: c.filename, issuer: c.issuer, notbefore: c.notbefore, notafter: c.notafter, san: c.san, fingerprint: c.fingerprint,
    })),
  })))
  const ok = got.flatMap(g => (g.status === 'fulfilled' ? [g.value] : []))
  const failed = got.find(g => g.status === 'rejected') as PromiseRejectedResult | undefined
  if (!ok.length && failed) throw failed.reason
  return ok
}
