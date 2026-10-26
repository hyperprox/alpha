// =============================================================================
//  HyperProx — Certificates: the seam between the service and its modules
//
//  The service never imports policy, timing, dns01, acme, probe, inventory,
//  housekeeping or alerts directly: it takes a CertsModules object, and this
//  file is the only place that names them. Tests swap single members for
//  fakes; production uses defaultModules. productionSources() binds the
//  read-only inputs (the proxy's API, the nodes' certificate info) and the one
//  housekeeping write (deleting a dead proxy certificate).
// =============================================================================

import type { GoDaddyClient } from '../godaddy-client'
import { NPMClient, type NPMCertificate } from '../npm-client'
import { getProviderCredentials } from '../credentials'
import { livePve } from '../pve-env'
import type { CertsHousekeepingItem, CertsInventoryEntry, CertsProbe, CertsVerdict } from './types'
import type { KeyType, CertsPolicy } from './policy'
import type { DnsProvider } from './dns01'
import type { IssueDeps, IssuedBundle } from './acme'
import type { ProbeTarget, ProbeResult, ProbeOptions } from './probe'
import type { InventoryDeps } from './inventory'
import type { HousekeepingDeps } from './housekeeping'
import type { AlertState } from './alerts'
import { loadCertsPolicy, LE_STAGING } from './policy'
import { renewAfter, dueForRenewal } from './timing'
import { godaddyProvider } from './dns01'
import { issueCertificate, fetchAri, zonesFor } from './acme'
import { probeEndpoint, verdictFor } from './probe'
import { discoverProbeTargets, buildInventory } from './inventory'
import { listHousekeeping, applyHousekeeping } from './housekeeping'
import { alertChanges, sendWebhook } from './alerts'

export type { KeyType, TargetSpec, CertsPolicy } from './policy'
export type { DnsProvider } from './dns01'
export type { IssueDeps, IssuedBundle } from './acme'
export type { ProbeTarget, ProbeResult, ProbeOptions } from './probe'
export type { InventoryDeps } from './inventory'
export type { HousekeepingDeps } from './housekeeping'
export type { AlertState } from './alerts'

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

export const defaultModules: CertsModules = {
  loadCertsPolicy, LE_STAGING, renewAfter, dueForRenewal,
  godaddyProvider, issueCertificate, fetchAri, zonesFor, probeEndpoint, verdictFor,
  discoverProbeTargets, buildInventory, listHousekeeping, applyHousekeeping, alertChanges, sendWebhook,
}

// --- Sources for inventory, discovery and housekeeping ------------------------------------------
// All read-only except deleteNpmCertificate, which housekeeping calls only for an item the admin confirmed.

export interface CertsSources {
  npmCertificates(): Promise<NPMCertificate[]>
  npmHosts(): Promise<{ domain_names: string[]; certificate_id: number | null; enabled: boolean }[]>
  nodeCertificates: InventoryDeps['nodeCertificates']
  /** Every proxy, redirection and 404 host and stream; rejects if any list cannot be read. */
  npmCertificateUsers(): Promise<{ certificate_id: number | null }[]>
  deleteNpmCertificate(id: number): Promise<void>
}

const certId = (v: unknown): number | null => (typeof v === 'number' && v > 0 ? v : null)

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
      certificate_id: certId(h.certificate_id),
      enabled: !!h.enabled,
    })),
    nodeCertificates: () => nodeCertificatesFromPve(),
    async npmCertificateUsers() {
      const npm = await npmClient()
      // All four or nothing: Promise.all rejects on the first list that fails.
      const lists = await Promise.all([npm.getProxyHosts(), npm.getRedirectionHosts(), npm.getDeadHosts(), npm.getStreams()])
      return lists.flat().map(h => ({ certificate_id: certId(h.certificate_id) }))
    },
    deleteNpmCertificate: async id => (await npmClient()).deleteCertificate(id),
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
  const got = await Promise.allSettled(nodes.map(async n => ({
    node: n.name, host: n.ip,
    certs: (await pve.getNodeCertificates(n.name)).map(c => ({
      filename: c.filename, issuer: c.issuer, notbefore: c.notbefore, notafter: c.notafter, san: c.san, fingerprint: c.fingerprint,
    })),
  })))
  const ok = got.flatMap(g => (g.status === 'fulfilled' ? [g.value] : []))
  const failed = got.find(g => g.status === 'rejected') as PromiseRejectedResult | undefined
  if (!ok.length && failed) throw failed.reason
  return ok
}
