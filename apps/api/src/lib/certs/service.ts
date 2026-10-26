// =============================================================================
//  HyperProx — Certificates: the service
//
//  Everything the routes and the scheduler do goes through CertsService, and
//  everything it touches outside this process comes in through CertsServiceDeps:
//  the store, the vault, the DNS providers, the deploy paths, the read-only
//  sources and the ACME/probe/inventory modules. Production binds them in
//  productionCertsService(); every test binds fakes.
//
//  Rules this file exists to keep:
//    - One issuance per label at a time (the store's beginIssue; 409 otherwise).
//    - A failed issuance changes nothing that is deployed: the previous
//      certificate, its metadata and its vault entry stay as they were.
//    - Nothing issues a certificate that has never been issued. The first
//      issuance of a label is always a person pressing Issue; the daily check
//      only renews what already exists.
//    - Keys and PEMs go to the vault, metadata to the database.
// =============================================================================

import { X509Certificate, createPrivateKey } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { GoDaddyClient } from '../godaddy-client'
import { getCredential, getProviderCredentials, setCredential, setCredentials } from '../credentials'
import { nextRun } from '../updates/cron'
import { productionExecutor } from '../updates/executor'
import {
  defaultModules, productionSources,
  type CertsModules, type CertsPolicy, type CertsSources, type DnsProvider, type HousekeepingDeps,
  type IssuedBundle, type ProbeOptions, type ProbeResult, type ProbeTarget, type TargetSpec, type AlertState,
} from './modules'
import { deployBundle, guestRunner, installHyperproxCert, sameFingerprint, type DeployDeps } from './deploy'
import {
  PrismaCertsStore, RenewingError, eventView, iso, probeView,
  type CertsStore, type ManagedRecord, type ProbeRecord, type TargetRecord,
} from './store'
import type {
  CertsEvent, CertsHousekeepingItem, CertsInventoryEntry, CertsManaged, CertsOverview, CertsPolicyStatus,
  CertsProbe, CertsTargetState, CertsVerdict,
} from './types'

export { RenewingError }

/** 400: the request cannot be acted on as it stands (no policy, never issued, bad input). */
export class CertsInputError extends Error { constructor(m: string) { super(m); this.name = 'CertsInputError' } }
/** 404: no such label, endpoint or housekeeping item. */
export class CertsNotFoundError extends Error { constructor(m: string) { super(m); this.name = 'CertsNotFoundError' } }
/** 409: something else is already happening to this certificate. */
export class CertsBusyError extends Error { constructor(m: string) { super(m); this.name = 'CertsBusyError' } }

// --- The vault ---------------------------------------------------------------------------

export interface StoredBundle { keyPem: string; fullchainPem: string }

export interface CertsSecrets {
  getAccountKey(): Promise<string | null>
  saveAccountKey(pem: string): Promise<void>
  getBundle(label: string): Promise<StoredBundle | null>
  saveBundle(label: string, b: StoredBundle): Promise<void>
}

const VAULT_CATEGORY = 'certs'
// Prefixed so a certificate label can never collide with the account item.
const bundleItem = (label: string) => `cert-${label}`

/**
 * Through the credential store, so it is one Secure Note per certificate in the HyperProx collection
 * (`hyperprox:certs/cert-<label>`), written as the signed-in user, unreadable while locked.
 */
export function vaultSecrets(): CertsSecrets {
  return {
    getAccountKey: () => getCredential(VAULT_CATEGORY, 'acme-account', 'key_pem'),
    saveAccountKey: pem => setCredential(VAULT_CATEGORY, 'acme-account', 'key_pem', pem),
    async getBundle(label) {
      const f = await getProviderCredentials(VAULT_CATEGORY, bundleItem(label))
      return f.key_pem && f.fullchain_pem ? { keyPem: f.key_pem, fullchainPem: f.fullchain_pem } : null
    },
    async saveBundle(label, b) {
      // One write for both: a key and a certificate from different issuances must never sit side by side.
      await setCredentials(VAULT_CATEGORY, bundleItem(label), { fullchain_pem: b.fullchainPem, key_pem: b.keyPem })
    },
  }
}

const PEM_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\s*/g

/**
 * The full bundle from what the vault keeps (key + full chain), with every derived field read from the
 * certificate itself. Throws when the key does not belong to the certificate.
 */
export function bundleFromPems(keyPem: string, fullchainPem: string): IssuedBundle {
  const blocks = chainBlocks(fullchainPem)
  const leaf = new X509Certificate(blocks[0])
  if (!leaf.checkPrivateKey(createPrivateKey(keyPem))) throw new Error('the stored key does not belong to the stored certificate')
  return {
    keyPem, fullchainPem,
    certPem: blocks[0].trim() + '\n',
    chainPem: blocks.slice(1).map(b => b.trim() + '\n').join(''),
    notBefore: new Date(leaf.validFrom), notAfter: new Date(leaf.validTo),
    serial: leaf.serialNumber, issuer: issuerName(leaf.issuer), fingerprint256: leaf.fingerprint256,
  }
}

function chainBlocks(fullchainPem: string): string[] {
  const blocks: string[] = fullchainPem.match(PEM_RE) ?? []
  if (!blocks.length) throw new Error('the stored chain holds no certificate')
  return blocks
}

/** The leaf certificate of a stored chain, without the key: enough to ask the CA for its renewal window. */
export function leafPemOf(fullchainPem: string): string {
  const leaf = chainBlocks(fullchainPem)[0]
  new X509Certificate(leaf)   // throws on a damaged certificate
  return leaf.trim() + '\n'
}

function issuerName(dn: string): string {
  const cn = /(?:^|\n)CN=([^\n]+)/.exec(dn)?.[1]
  const o = /(?:^|\n)O=([^\n]+)/.exec(dn)?.[1]
  return cn && o ? `${o} ${cn}` : cn ?? o ?? dn
}

// --- Dependencies ------------------------------------------------------------------------------

export interface CertsServiceDeps {
  store:   CertsStore
  secrets: CertsSecrets
  modules: CertsModules
  policyPath?: string
  /** The DNS providers HyperProx manages; empty while none is configured. */
  dnsProviders(): Promise<DnsProvider[]>
  deploy:  Omit<DeployDeps, 'endpoints' | 'probe'>
  sources: CertsSources
  log(msg: string): void
  now?(): Date
  probeConcurrency?: number
  probeTimeoutMs?: number
  /** Extra trust anchors for probes (a network with its own CA; tests). */
  probeOptions?: ProbeOptions
  /** Script runner in the proxy's guest for housekeeping; shorter-lived than a deploy. Defaults to deploy.guestExec. */
  housekeepingExec?(vmid: number, script: string): Promise<{ code: number; output: string }>
}

const INVENTORY_TTL_MS = 5 * 60_000
const DNS_TTL_MS = 10 * 60_000
const STAGING_ISSUERS = /\(STAGING\)|\bPebble\b/i
const DAY = 86_400_000

type PolicyLoad = ReturnType<CertsModules['loadCertsPolicy']>

const msg = (e: any) => String(e?.message ?? e)

interface ChallengeEntry { provider: string; zone: string; fqdn: string; value: string }
const JOURNAL_KEY = 'challenges'
const entryKey = (e: ChallengeEntry) => [e.provider, e.zone, e.fqdn, e.value].join('\n')
const key = (host: string, port: number) => `${host.toLowerCase()}:${port}`

/** Does `name` (a certificate name, possibly a wildcard) cover `host`? */
export function covers(name: string, host: string): boolean {
  const n = name.toLowerCase(), h = host.toLowerCase()
  if (n === h) return true
  if (!n.startsWith('*.')) return false
  const rest = h.slice(h.indexOf('.') + 1)
  return h.includes('.') && rest === n.slice(2)
}

/** A name a client could ask for: the first plain name, else the wildcard with a label in front. */
function concreteName(names: string[]): string {
  return names.find(n => !n.startsWith('*.')) ?? names[0].replace(/^\*\./, 'www.')
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]) } }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

export class CertsService {
  private jobs = new Set<Promise<unknown>>()
  private deploying = new Set<string>()
  private checking: Promise<void> | null = null
  private inventoryCache: { at: number; entries: CertsInventoryEntry[] } | null = null
  private dnsCache = new Map<string, { at: number; dns: CertsManaged['dns'] }>()
  private journalChain: Promise<unknown> = Promise.resolve()
  /** Challenge values this process has presented and not yet cleaned up; a sweep never touches these. */
  private liveChallenges = new Set<string>()

  constructor(private deps: CertsServiceDeps) {}

  private now(): Date { return this.deps.now ? this.deps.now() : new Date() }
  private get m(): CertsModules { return this.deps.modules }

  policy(): PolicyLoad { return this.m.loadCertsPolicy(this.deps.policyPath) }

  /** Resolves when every issuance and deploy started so far has settled. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.jobs.size) await Promise.allSettled([...this.jobs])
  }

  private track<T>(p: Promise<T>): Promise<T> {
    const t = p.finally(() => this.jobs.delete(t))
    this.jobs.add(t)
    t.catch(e => this.deps.log(`[certs] background job failed: ${msg(e)}`))
    return t
  }

  // --- Challenge journal ---------------------------------------------------------------------------
  // acme.ts always cleans up its own challenge values, but a restart in the middle of an order skips its
  // finally. Every value is written to the journal before it is presented and taken off after its cleanup,
  // so the first unlocked run after a restart can remove whatever was left behind.

  private updateJournal(fn: (list: ChallengeEntry[]) => ChallengeEntry[]): Promise<void> {
    const run = this.journalChain.then(async () => {
      const list = (await this.deps.store.getState<ChallengeEntry[]>(JOURNAL_KEY)) ?? []
      await this.deps.store.setState(JOURNAL_KEY, fn(list))
    })
    this.journalChain = run.catch(() => undefined)
    return run
  }

  private journaled(providers: DnsProvider[]): DnsProvider[] {
    return providers.map(p => ({
      name: p.name,
      zones: () => p.zones(),
      present: async (zone, fqdn, value) => {
        const e: ChallengeEntry = { provider: p.name, zone, fqdn, value }
        this.liveChallenges.add(entryKey(e))
        await this.updateJournal(l => [...l.filter(x => entryKey(x) !== entryKey(e)), e])
        await p.present(zone, fqdn, value)
      },
      cleanup: async (zone, fqdn, value) => {
        const e: ChallengeEntry = { provider: p.name, zone, fqdn, value }
        try {
          await p.cleanup(zone, fqdn, value)
          await this.updateJournal(l => l.filter(x => entryKey(x) !== entryKey(e)))
        } finally {
          // A failed cleanup stays journaled, and the next sweep (daily, or after a restart) retries it.
          this.liveChallenges.delete(entryKey(e))
        }
      },
    }))
  }

  /** Removes challenge values an interrupted order left behind, then forgets them. Returns how many went. */
  async sweepChallenges(): Promise<number> {
    const list = (await this.deps.store.getState<ChallengeEntry[]>(JOURNAL_KEY)) ?? []
    const stale = list.filter(e => !this.liveChallenges.has(entryKey(e)))
    if (!stale.length) return 0
    const providers = await this.deps.dnsProviders()
    let removed = 0
    const failed: string[] = []
    for (const e of stale) {
      const p = providers.find(x => x.name === e.provider)
      try {
        if (!p) throw new Error(`DNS provider ${e.provider} is not configured`)
        await p.cleanup(e.zone, e.fqdn, e.value)
        await this.updateJournal(l => l.filter(x => entryKey(x) !== entryKey(e)))
        removed++
      } catch (err) {
        failed.push(`${e.fqdn}: ${msg(err)}`)
      }
    }
    if (removed) await this.event(null, 'issue', true, `Removed ${removed} challenge record value(s) left behind by an order a restart interrupted`)
    if (failed.length) await this.event(null, 'issue', false, `Could not remove challenge record values left behind by an interrupted order; retried at the next check: ${failed.join('; ')}`)
    return removed
  }

  /** A restart ends any issuance that was running; release those rows so they can be retried. */
  async recover(): Promise<string[]> {
    const labels = await this.deps.store.recoverInterrupted('interrupted by a HyperProx restart; the certificate in place is unchanged')
    for (const label of labels) {
      await this.event(label, 'issue', false, 'Issuance was interrupted by a restart; the certificate in place is unchanged')
    }
    return labels
  }

  private async event(label: string | null, kind: CertsEvent['kind'], ok: boolean, detail: string): Promise<void> {
    try { await this.deps.store.addEvent({ label, kind, ok, detail }) }
    catch (e) { this.deps.log(`[certs] could not record an event (${kind} ${label ?? ''}): ${msg(e)}`) }
  }

  // --- Overview ---------------------------------------------------------------------------------

  policyStatus(load: PolicyLoad): CertsPolicyStatus {
    let next: string | null = null
    try { next = iso(nextRun(load.policy.schedule.check, this.now())) } catch { /* shown as no next run */ }
    const s: CertsPolicyStatus = {
      loaded: load.loaded, path: load.path,
      acme: { directory: load.policy.acme.directoryUrl, staging: load.policy.acme.staging, email: load.policy.acme.email },
      schedule: { cron: load.policy.schedule.check, nextRun: next },
    }
    if (load.error) s.error = load.error
    return s
  }

  private async dnsFor(names: string[]): Promise<CertsManaged['dns']> {
    const k = names.join(',')
    const hit = this.dnsCache.get(k)
    if (hit && this.now().getTime() - hit.at < DNS_TTL_MS) return hit.dns
    const none: CertsManaged['dns'] = names.map(name => ({ name, zone: null, provider: null }))
    let dns = none
    try { dns = await this.m.zonesFor(names, await this.deps.dnsProviders()) }
    catch (e) { this.deps.log(`[certs] zone lookup failed: ${msg(e)}`); return none }
    this.dnsCache.set(k, { at: this.now().getTime(), dns })
    return dns
  }

  private targetView(name: string, spec: TargetSpec | undefined, rec: TargetRecord | undefined, current: string | null): CertsTargetState {
    const kind = (spec?.kind ?? rec?.kind ?? 'guest-files') as CertsTargetState['kind']
    let verdict: CertsVerdict = 'unknown'
    if (!spec) verdict = 'error'
    else if (rec?.lastDeployAt) {
      if (rec.ok === false) verdict = 'critical'
      else if (current && rec.fingerprint && !sameFingerprint(rec.fingerprint, current)) verdict = 'warn'
      else verdict = 'ok'
    }
    const lastResult = !spec ? `no target named ${name} under targets:` : rec?.detail ?? null
    return { name, kind, lastDeployAt: iso(rec?.lastDeployAt), lastResult, verdict }
  }

  private async managedView(label: string, row: ManagedRecord | null, policy: CertsPolicy): Promise<CertsManaged> {
    const spec = policy.certificates[label]
    const names = spec?.names ?? row?.names ?? []
    const recs = row ? await this.deps.store.listTargets(label) : []
    const targets = (spec?.deploy ?? []).map(d =>
      this.targetView(d.target, policy.targets[d.target], recs.find(r => r.name === d.target), row?.fingerprint ?? null))
    return {
      label, names,
      status: row?.status ?? 'pending',
      issuer: row?.issuer ?? null, notBefore: iso(row?.notBefore), notAfter: iso(row?.notAfter),
      renewAfter: iso(row?.renewAfter), ariStart: iso(row?.ariStart), ariEnd: iso(row?.ariEnd),
      staging: row?.staging ?? false, lastError: row?.lastError ?? null,
      dns: names.length ? await this.dnsFor(names) : [],
      targets,
    }
  }

  async managed(policy?: CertsPolicy): Promise<CertsManaged[]> {
    const p = policy ?? this.policy().policy
    const rows = await this.deps.store.listManaged()
    const labels = [...new Set([...Object.keys(p.certificates), ...rows.map(r => r.label)])].sort()
    return Promise.all(labels.map(l => this.managedView(l, rows.find(r => r.label === l) ?? null, p)))
  }

  async managedOne(label: string): Promise<CertsManaged> {
    const p = this.policy().policy
    const row = await this.deps.store.getManaged(label)
    if (!row && !p.certificates[label]) throw new CertsNotFoundError(`No certificate ${label}`)
    return this.managedView(label, row, p)
  }

  /** Each source on its own: a proxy that is down must not blank the hypervisor's certificates. */
  private safe<T>(what: string, fn: () => Promise<T[]>): () => Promise<T[]> {
    return () => fn().catch(e => { this.deps.log(`[certs] ${what} unavailable: ${msg(e)}`); return [] as T[] })
  }

  async overview(refresh: boolean): Promise<CertsOverview> {
    if (refresh) {
      try { await this.probeAll() } catch (e) { this.deps.log(`[certs] refresh probe failed: ${msg(e)}`) }
    }
    const load = this.policy()
    const managed = await this.managed(load.policy)
    const probeRecs = await this.deps.store.listProbes()
    const probes = probeRecs.map(probeView)
    const age = this.inventoryCache ? this.now().getTime() - this.inventoryCache.at : Infinity
    if (refresh || age > INVENTORY_TTL_MS) {
      let entries: CertsInventoryEntry[] = []
      try {
        const s = this.deps.sources
        entries = await this.m.buildInventory({
          npmCertificates: this.safe('proxy certificates', s.npmCertificates),
          npmHosts: this.safe('proxy hosts', s.npmHosts),
          nodeCertificates: this.safe('node certificates', s.nodeCertificates),
          managed, probes, policy: load.policy, now: this.now(),
        })
      } catch (e) { this.deps.log(`[certs] inventory failed: ${msg(e)}`) }
      this.inventoryCache = { at: this.now().getTime(), entries }
    }
    const checked = await this.deps.store.getState<string>('lastCheck')
    return { policy: this.policyStatus(load), inventory: this.inventoryCache!.entries, probes, managed, checkedAt: checked }
  }

  // --- Probes ---------------------------------------------------------------------------------------

  /** Probe targets each managed certificate is delivered to, and the fingerprint each must serve. */
  private endpointsFor(spec: TargetSpec, names: string[], policy: CertsPolicy): ProbeTarget[] {
    if (spec.kind === 'hyperprox') return [{ host: '127.0.0.1', port: 443, starttls: 'none', servername: concreteName(names) }]
    return policy.probes
      .filter(p => names.some(n => covers(n, p.host)))
      .map(p => ({ host: p.host, port: p.port, starttls: p.starttls, servername: p.host, internal: p.internal }))
  }

  private async expectedFingerprints(policy: CertsPolicy): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (const row of await this.deps.store.listManaged()) {
      const spec = policy.certificates[row.label]
      if (!spec || !row.fingerprint) continue
      for (const d of spec.deploy) {
        const t = policy.targets[d.target]
        if (!t) continue
        for (const ep of this.endpointsFor(t, spec.names, policy)) out.set(key(ep.host, ep.port), row.fingerprint)
        // Discovery probes HyperProx's own names on 443 as well (inventory.ts); those must serve it too.
        if (t.kind === 'hyperprox') for (const n of spec.names) if (!n.startsWith('*.')) out.set(key(n, 443), row.fingerprint)
      }
    }
    return out
  }

  private async probeTargets(list: (ProbeTarget & { source: CertsProbe['source'] })[], policy: CertsPolicy): Promise<ProbeRecord[]> {
    const expect = await this.expectedFingerprints(policy)
    return mapLimit(list, this.deps.probeConcurrency ?? 4, async t => {
      const now = this.now()
      const r = await this.m.probeEndpoint(t, this.deps.probeTimeoutMs, this.deps.probeOptions)
        .catch((e): ProbeResult => ({ ok: false, error: msg(e), trusted: null, namesMatch: null }))
      const v = this.m.verdictFor(r, {
        now, warnFraction: policy.alerts.warnFraction, criticalDays: policy.alerts.criticalDays,
        expectFingerprint: expect.get(key(t.host, t.port)), internal: t.internal, stagingIssuers: STAGING_ISSUERS,
      })
      return {
        host: t.host, port: t.port, starttls: t.starttls, source: t.source, internal: !!t.internal,
        checkedAt: now, verdict: v.verdict, reason: v.reason,
        fingerprint: r.leaf?.fingerprint256 ?? null, issuer: r.leaf?.issuer ?? null, notAfter: r.leaf?.notAfter ?? null,
        trusted: r.trusted, namesMatch: r.namesMatch,
      }
    })
  }

  /** Every endpoint HyperProx knows about: the policy's, the discovered ones, and what was probed before. */
  private async knownTargets(policy: CertsPolicy): Promise<(ProbeTarget & { source: CertsProbe['source'] })[]> {
    let list: (ProbeTarget & { source: CertsProbe['source'] })[]
    try {
      list = await this.m.discoverProbeTargets({
        npmHosts: this.safe('proxy hosts', this.deps.sources.npmHosts),
        nodeCertificates: this.safe('node certificates', this.deps.sources.nodeCertificates),
        policy, managed: await this.managed(policy),
      })
    } catch (e) {
      this.deps.log(`[certs] endpoint discovery failed, probing the policy's endpoints only: ${msg(e)}`)
      list = policy.probes.map(p => ({ ...p, source: 'policy' as const }))
    }
    const seen = new Set(list.map(t => key(t.host, t.port)))
    for (const p of policy.probes) {
      if (!seen.has(key(p.host, p.port))) { list.push({ ...p, source: 'policy' }); seen.add(key(p.host, p.port)) }
    }
    return list
  }

  async probeAll(): Promise<CertsProbe[]> {
    const policy = this.policy().policy
    const recs = await this.probeTargets(await this.knownTargets(policy), policy)
    await this.deps.store.replaceProbes(recs)
    await this.deps.store.setState('lastCheck', this.now().toISOString())
    this.inventoryCache = null
    const count = (v: CertsVerdict) => recs.filter(r => r.verdict === v).length
    await this.event(null, 'probe', count('critical') + count('error') === 0,
      `Probed ${recs.length} endpoint(s): ${count('ok')} ok, ${count('warn')} warn, ${count('critical')} critical, ${count('error')} unreachable`)
    return recs.map(probeView)
  }

  /** One endpoint HyperProx already knows. Unknown host:port is a 404: this is not a general TLS scanner. */
  async probeOne(host: string, port: number): Promise<CertsProbe[]> {
    const policy = this.policy().policy
    const known = await this.knownTargets(policy)
    const stored = await this.deps.store.listProbes()
    const k = key(host, port)
    const t = known.find(x => key(x.host, x.port) === k)
      ?? (() => { const s = stored.find(x => key(x.host, x.port) === k); return s ? { host: s.host, port: s.port, starttls: s.starttls, internal: s.internal, source: s.source } : undefined })()
    if (!t) throw new CertsNotFoundError(`${host}:${port} is not an endpoint HyperProx knows; add it under probes: in the policy`)
    const [rec] = await this.probeTargets([t], policy)
    await this.deps.store.upsertProbe(rec)
    this.inventoryCache = null
    return [probeView(rec)]
  }

  async probe(target?: { host?: string; port?: number }, by?: string): Promise<CertsProbe[]> {
    const port = target?.port ?? 443
    await this.deps.store.audit('certs.probe', target?.host ? `${target.host}:${port}` : 'all', { by: by ?? null })
    if (target?.host) return this.probeOne(target.host, port)
    return this.probeAll()
  }

  // --- Issue and deploy -----------------------------------------------------------------------------

  private requirePolicy(label: string): { load: PolicyLoad; spec: CertsPolicy['certificates'][string] } {
    const load = this.policy()
    if (!load.loaded) {
      throw new CertsInputError(load.error
        ? `The certificate policy did not load (${load.path}): ${load.error}`
        : `There is no certificate policy yet: create ${load.path} (see config/certs.example.yaml)`)
    }
    const spec = load.policy.certificates[label]
    if (!spec) throw new CertsNotFoundError(`No certificate ${label} in the policy`)
    if (!spec.names.length) throw new CertsInputError(`Certificate ${label} lists no names`)
    return { load, spec }
  }

  /** Issue (first time) or renew now. Returns with the label `renewing`; the work continues in the background. */
  async issue(label: string, by?: string): Promise<CertsManaged> {
    const { load, spec } = this.requirePolicy(label)
    if (this.deploying.has(label)) throw new CertsBusyError(`Certificate ${label} is being deployed`)
    await this.deps.store.beginIssue(label, spec.names)
    await this.deps.store.audit('certs.issue', label, { by: by ?? null, names: spec.names, directory: load.policy.acme.directoryUrl })
    this.track(this.runIssue(label, load.policy, 'manual'))
    return this.managedOne(label)
  }

  private isStaging(policy: CertsPolicy): boolean {
    return policy.acme.staging || policy.acme.directoryUrl === this.m.LE_STAGING
  }

  /** The issuance itself. The label must already be `renewing` (beginIssue). Never throws. */
  private async runIssue(label: string, policy: CertsPolicy, trigger: 'manual' | 'schedule'): Promise<void> {
    const spec = policy.certificates[label]
    const store = this.deps.store
    let before: ManagedRecord | null = null
    let bundle: IssuedBundle
    try {
      before = await store.getManaged(label)
      const issued = await this.m.issueCertificate({
        directoryUrl: policy.acme.directoryUrl,
        email: policy.acme.email,
        getAccountKey: () => this.deps.secrets.getAccountKey(),
        saveAccountKey: pem => this.deps.secrets.saveAccountKey(pem),
        dns: this.journaled(await this.deps.dnsProviders()),
        log: line => this.deps.log(`[certs] ${label}: ${line}`),
      }, spec.names, policy.acme.keyType)
      // Re-derived from the PEMs: the fingerprint must be in the same form the probe reports.
      bundle = bundleFromPems(issued.keyPem, issued.fullchainPem)
      await this.deps.secrets.saveBundle(label, { keyPem: bundle.keyPem, fullchainPem: bundle.fullchainPem })
    } catch (e) {
      const kept = before?.notAfter ? '; the current certificate stays in place' : ''
      await store.updateManaged(label, { status: 'failed', lastError: msg(e) })
        .catch(err => this.deps.log(`[certs] ${label}: could not record the failure: ${msg(err)}`))
      await this.event(label, before?.notAfter ? 'renew' : 'issue', false, `${before?.notAfter ? 'Renewal' : 'Issuance'} failed (${trigger}): ${msg(e)}${kept}`)
      return
    }

    const first = !before?.notAfter
    const ari = await this.m.fetchAri(policy.acme.directoryUrl, bundle.certPem).catch(e => {
      this.deps.log(`[certs] ${label}: no renewal information from the CA: ${msg(e)}`); return null
    })
    try {
      await store.updateManaged(label, {
        status: 'valid', names: spec.names, issuer: bundle.issuer, serial: bundle.serial, fingerprint: bundle.fingerprint256,
        notBefore: bundle.notBefore, notAfter: bundle.notAfter, ariStart: ari?.start ?? null, ariEnd: ari?.end ?? null,
        renewAfter: this.m.renewAfter(bundle, ari), staging: this.isStaging(policy), lastError: null, issuedAt: this.now(),
      })
    } catch (e) {
      // The new certificate is in the vault but the database did not take it; leave the row retryable.
      await store.updateManaged(label, { status: 'failed', lastError: `issued, but recording it failed: ${msg(e)}` }).catch(() => undefined)
      await this.event(label, first ? 'issue' : 'renew', false, `Issued, but recording it failed: ${msg(e)}`)
      return
    }
    await this.event(label, first ? 'issue' : 'renew', true,
      `${first ? 'Issued' : 'Renewed'} (${trigger}) for ${spec.names.join(', ')} by ${bundle.issuer}, valid until ${bundle.notAfter.toISOString().slice(0, 10)}`)
    this.inventoryCache = null
    await this.deployAll(label, policy, bundle)
  }

  /** Redeploy the current certificate to every target. Returns at once; the work runs in the background. */
  async deploy(label: string, by?: string): Promise<CertsManaged> {
    const { load } = this.requirePolicy(label)
    const row = await this.deps.store.getManaged(label)
    if (!row?.fingerprint) throw new CertsInputError(`Certificate ${label} has not been issued yet`)
    if (row.status === 'renewing') throw new CertsBusyError(`Certificate ${label} is being issued`)
    if (this.deploying.has(label)) throw new CertsBusyError(`Certificate ${label} is already being deployed`)
    const stored = await this.deps.secrets.getBundle(label)
    if (!stored) throw new CertsInputError(`The vault holds no key for ${label}; issue it again`)
    const bundle = bundleFromPems(stored.keyPem, stored.fullchainPem)
    await this.deps.store.audit('certs.deploy', label, { by: by ?? null, fingerprint: bundle.fingerprint256 })
    this.track(this.deployAll(label, load.policy, bundle))
    return this.managedOne(label)
  }

  /** Deliver to each target (all, or `only`), one after another; a failed target does not stop the rest. */
  private async deployAll(label: string, policy: CertsPolicy, bundle: IssuedBundle, only?: string[]): Promise<void> {
    const spec = policy.certificates[label]
    if (!spec) return
    this.deploying.add(label)
    try {
      const endpoints: ProbeTarget[] = []
      for (const d of spec.deploy) {
        if (only && !only.includes(d.target)) continue
        const t = policy.targets[d.target]
        let ok: boolean, detail: string
        if (!t) { ok = false; detail = `no target named ${d.target} under targets:` }
        else {
          const eps = this.endpointsFor(t, spec.names, policy)
          endpoints.push(...eps)
          const r = await deployBundle(t, bundle, {
            ...this.deps.deploy, endpoints: eps,
            probe: ep => this.m.probeEndpoint(ep, this.deps.probeTimeoutMs, this.deps.probeOptions),
          })
          ok = r.ok; detail = r.detail
        }
        await this.deps.store.setTarget(label, {
          name: d.target, kind: t?.kind ?? 'guest-files', lastDeployAt: this.now(), ok, detail, fingerprint: bundle.fingerprint256,
        })
        await this.event(label, 'deploy', ok, `${d.target}: ${detail}`)
      }
      // The page should show what is served now, not what was served before the deploy.
      const seen = new Set<string>()
      const unique = endpoints.filter(ep => !seen.has(key(ep.host, ep.port)) && seen.add(key(ep.host, ep.port)))
      if (unique.length) {
        const stored = await this.deps.store.listProbes()
        const recs = await this.probeTargets(unique.map(ep => ({
          ...ep, source: stored.find(s => key(s.host, s.port) === key(ep.host, ep.port))?.source ?? 'managed' as const,
        })), policy)
        for (const r of recs) await this.deps.store.upsertProbe(r)
      }
      this.inventoryCache = null
    } finally {
      this.deploying.delete(label)
    }
  }

  // --- History and housekeeping -----------------------------------------------------------------------

  async events(label: string | undefined, limit: number): Promise<CertsEvent[]> {
    return (await this.deps.store.listEvents(label, limit)).map(eventView)
  }

  private housekeepingDeps(policy: CertsPolicy): HousekeepingDeps {
    const vmid = policy.proxy.guestVmid
    const s = this.deps.sources
    return {
      npmCertificates: () => s.npmCertificates(),
      npmCertificateUsers: () => s.npmCertificateUsers(),
      deleteNpmCertificate: id => s.deleteNpmCertificate(id),
      guestExec: vmid === null ? null : script => (this.deps.housekeepingExec ?? this.deps.deploy.guestExec)(vmid, script),
      warn: m => this.deps.log(`[certs] housekeeping: ${m}`),
    }
  }

  async housekeeping(): Promise<CertsHousekeepingItem[]> {
    return this.m.listHousekeeping(this.housekeepingDeps(this.policy().policy), this.now())
  }

  /** Re-lists before acting, so an item that changed since the page loaded is not acted on blind. */
  async applyHousekeeping(id: string, by?: string): Promise<string> {
    const deps = this.housekeepingDeps(this.policy().policy)
    const item = (await this.m.listHousekeeping(deps, this.now())).find(i => i.id === id)
    if (!item) throw new CertsNotFoundError(`No housekeeping item ${id} (it may already be done)`)
    await this.deps.store.audit('certs.housekeeping.apply', id, { by: by ?? null, kind: item.kind, names: item.names })
    try {
      const detail = await this.m.applyHousekeeping(item, deps)
      await this.event(null, 'housekeeping', true, `${item.names.join(', ') || item.id}: ${detail}`)
      this.inventoryCache = null
      return detail
    } catch (e) {
      await this.event(null, 'housekeeping', false, `${item.names.join(', ') || item.id}: ${msg(e)}`)
      throw e
    }
  }

  // --- The daily check ------------------------------------------------------------------------------------

  async recordSkip(reason: string): Promise<void> {
    await this.event(null, 'probe', false, `Daily check skipped: ${reason}`)
  }

  /** Refresh ARI, renew what is due, retry failed deliveries, re-probe, alert. One at a time. */
  async dailyCheck(): Promise<void> {
    if (this.checking) return this.checking
    this.checking = this.runCheck().finally(() => { this.checking = null })
    return this.checking
  }

  private async runCheck(): Promise<void> {
    const load = this.policy()
    const policy = load.policy
    if (!load.loaded) this.deps.log(`[certs] daily check without a policy (${load.error ?? 'no file'}): probes only`)
    try { await this.sweepChallenges() } catch (e) { this.deps.log(`[certs] challenge sweep failed: ${msg(e)}`) }
    for (const row of await this.deps.store.listManaged()) {
      try { await this.checkOne(row, policy) }
      catch (e) { this.deps.log(`[certs] daily check of ${row.label} failed: ${msg(e)}`) }
    }
    // Verdicts as they stood before this check: the baseline for alerts when none has been saved yet.
    const before = await this.deps.store.listProbes()
    try { await this.probeAll() } catch (e) { this.deps.log(`[certs] daily probe failed: ${msg(e)}`) }
    try { await this.alerts(policy, before) } catch (e) { this.deps.log(`[certs] alerts failed: ${msg(e)}`) }
  }

  private async checkOne(row: ManagedRecord, policy: CertsPolicy): Promise<void> {
    const spec = policy.certificates[row.label]
    // Never issued (or dropped from the policy): only a person starts the first issuance.
    if (!spec || !row.notAfter || !row.notBefore || row.status === 'renewing') return
    const now = this.now()
    // Nothing between here and the due check may stop it: a damaged vault entry is exactly when renewal matters.
    const stored = await this.deps.secrets.getBundle(row.label).catch(e => {
      this.deps.log(`[certs] ${row.label}: could not read the stored certificate: ${msg(e)}`); return null
    })
    let renewAt = row.renewAfter
    if (stored) {
      try {
        // The chain alone: ARI needs the certificate, not the key, so a bad key cannot block it.
        const ari = await this.m.fetchAri(policy.acme.directoryUrl, leafPemOf(stored.fullchainPem))
        // Re-roll only when the CA moved the window; otherwise the decided moment stands.
        if (ari && (ari.start.getTime() !== row.ariStart?.getTime() || ari.end.getTime() !== row.ariEnd?.getTime())) {
          renewAt = this.m.renewAfter({ notBefore: row.notBefore, notAfter: row.notAfter }, ari)
          await this.deps.store.updateManaged(row.label, { ariStart: ari.start, ariEnd: ari.end, renewAfter: renewAt })
          await this.event(row.label, 'renew', true, `The CA's renewal window is now ${ari.start.toISOString()} to ${ari.end.toISOString()}`)
        }
      } catch (e) {
        this.deps.log(`[certs] ${row.label}: renewal window not refreshed: ${msg(e)}`)
      }
    }
    let bundle: IssuedBundle | null = null
    if (stored) {
      try { bundle = bundleFromPems(stored.keyPem, stored.fullchainPem) }
      catch (e) {
        await this.event(row.label, 'deploy', false,
          `The vault holds a key and certificate that do not belong together (${msg(e)}); nothing is redeployed from them until a renewal replaces both`)
      }
    }
    if (this.m.dueForRenewal(now, renewAt, row.notAfter)) {
      if (this.deploying.has(row.label)) return
      try { await this.deps.store.beginIssue(row.label, spec.names) }
      catch (e) { if (e instanceof RenewingError) return; throw e }
      await this.deps.store.audit('certs.renew', row.label, { by: 'schedule', names: spec.names })
      await this.track(this.runIssue(row.label, policy, 'schedule'))
      return
    }
    // A delivery that failed is retried once a day with the certificate already issued.
    if (!bundle || row.status !== 'valid') return
    const recs = await this.deps.store.listTargets(row.label)
    const retry = spec.deploy.map(d => d.target).filter(name => {
      const r = recs.find(x => x.name === name)
      return !r || r.ok === false || !r.fingerprint || !sameFingerprint(r.fingerprint, row.fingerprint ?? '')
    })
    if (retry.length && !this.deploying.has(row.label)) {
      await this.track(this.deployAll(row.label, policy, bundle, retry))
    }
  }

  /** Alert states for managed certificates: a renewal that keeps failing is reported once thresholds are reached. */
  private managedAlerts(rows: ManagedRecord[], policy: CertsPolicy, now: Date): AlertState[] {
    const out: AlertState[] = []
    for (const r of rows) {
      if (!policy.certificates[r.label] || !r.notAfter || !r.notBefore) continue
      const left = r.notAfter.getTime() - now.getTime()
      const life = r.notAfter.getTime() - r.notBefore.getTime()
      const days = Math.floor(left / DAY)
      const failing = r.status === 'failed' && r.lastError ? ` and its last renewal failed: ${r.lastError}` : ''
      let verdict: CertsVerdict = 'ok', reason: string | null = null
      if (left <= 0) { verdict = 'critical'; reason = `expired ${r.notAfter.toISOString().slice(0, 10)}${failing}` }
      else if (left < policy.alerts.criticalDays * DAY) { verdict = 'critical'; reason = `expires in ${days} day(s)${failing}` }
      else if (life > 0 && left / life < policy.alerts.warnFraction) { verdict = 'warn'; reason = `expires in ${days} day(s)${failing}` }
      out.push({ key: `certificate ${r.label}`, verdict, reason })
    }
    return out
  }

  private probeAlert(p: ProbeRecord): AlertState {
    return { key: `${p.host}:${p.port}`, verdict: p.verdict ?? 'unknown', reason: p.reason }
  }

  /**
   * Alert on what changed since the last check. The previous state is persisted with lastReminder, so a
   * restart does not re-announce standing problems; with no saved state yet (first check), the probe
   * verdicts already on the page are the baseline, for the same reason.
   */
  private async alerts(policy: CertsPolicy, probesBefore: ProbeRecord[] = []): Promise<void> {
    const now = this.now()
    const store = this.deps.store
    const next: AlertState[] = [
      ...this.managedAlerts(await store.listManaged(), policy, now),
      ...(await store.listProbes()).map(p => this.probeAlert(p)),
    ]
    const saved = await store.getState<AlertState[]>('alerts')
    const baseline = saved ?? probesBefore.filter(p => p.checkedAt).map(p => this.probeAlert(p))
    const prev = new Map(baseline.map(s => [s.key, s] as const))
    const lastReminder = await store.getState<string>('lastReminder')
    const res = this.m.alertChanges(prev, next, now, lastReminder ? new Date(lastReminder) : null)
    if (res.messages.length) {
      let sent = ''
      if (policy.alerts.webhookUrl) {
        try { await this.m.sendWebhook(policy.alerts.webhookUrl, res.messages); sent = ' (sent to the webhook)' }
        catch (e) { sent = ` (the webhook failed: ${msg(e)})` }
      }
      await this.event(null, 'alert', !sent.includes('failed'), `${res.messages.join('\n')}${sent}`)
    }
    await store.setState('alerts', [...res.state.values()])
    if (res.reminderSent) await store.setState('lastReminder', now.toISOString())
  }
}

// =============================================================================
//  Production binding
// =============================================================================

export function productionCertsService(db: PrismaClient, log: (m: string) => void): CertsService {
  const modules = defaultModules
  const exec = productionExecutor()
  return new CertsService({
    store: new PrismaCertsStore(db),
    secrets: vaultSecrets(),
    modules,
    async dnsProviders() {
      // The DNS credential already in the vault; no new one for certificates.
      const c = await getProviderCredentials('dns', 'godaddy').catch(() => ({} as Record<string, string>))
      return c.api_key && c.api_secret ? [modules.godaddyProvider(new GoDaddyClient(c.api_key, c.api_secret))] : []
    },
    deploy: { ...guestRunner(exec), hyperproxInstall: b => installHyperproxCert(b) },
    housekeepingExec: guestRunner(exec, 60_000).guestExec,
    sources: productionSources(),
    log,
  })
}
