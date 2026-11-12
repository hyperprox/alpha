// =============================================================================
//  HyperProx — deleting a website
//
//  A preview lists exactly what would be removed, one item per thing, each with
//  whether HyperProx made it and whether it still exists:
//
//    record     the site record, its metrics history and collector state (always)
//    dns        its A record at the provider that serves the zone
//    proxy      its proxy host, and on NPM its certificate when nothing else uses it
//    container  the container (only for a site HyperProx installed; off by default)
//    backups    a dead ID left in a backup job after the container went
//    vault      the site's vault item (its generated logins and keys)
//
//  Ownership is what the install recorded when it published (the site's ledger,
//  or its install job's): a thing in that ledger, unchanged, is ticked by
//  default; anything else starts unticked with a note saying why, and can only
//  be ticked with the site's name typed out. An adopted site is only ever "stop
//  tracking" unless DNS or the proxy host is ticked that way; its container is
//  never offered. Deleting a container always needs its hostname typed.
//
//  The run goes item by item, each audited before (fail closed) and after, each
//  re-read just before its write and read back afterwards. Something already
//  gone is "already gone", never an error. The record goes last and only when
//  everything ticked worked, so a run that stopped half-way can be previewed
//  and run again: what is gone shows as gone, and only what is left is offered.
// =============================================================================

import { randomBytes } from 'node:crypto'
import { zoneFor } from './dns-zones'
import type { DnsLike, PublishLedger, SiteRecord } from './sites'
import {
  backupJobsWith, destroyOwned, guestName, inHa, removeFromBackupJobs, type ActionDeps,
} from './clusters/guest-actions'

export const DELETE_PREVIEW_TTL_MS = 10 * 60_000

export type ItemKind = 'record' | 'dns' | 'proxy' | 'cert' | 'container' | 'backups' | 'vault'
export type ItemState = 'present' | 'gone' | 'unknown' | 'mismatch'

export interface DeleteItem {
  key: string
  kind: ItemKind
  label: string
  detail: string
  state: ItemState
  /** Can be ticked. An item already gone, unreadable or not matching is shown, never offered. */
  offered: boolean
  /** Always on (the record). */
  locked?: boolean
  defaultOn: boolean
  /** HyperProx made it (true), something else did or it changed since (false), or it cannot tell (null). */
  owned: boolean | null
  /** Text to type before this item may be ticked (an adopted site's DNS or proxy host). */
  typed?: string
  /** The item that must be ticked with this one (a certificate goes with its host). */
  requires?: string
  /** Ticking that item ticks this one too, and unticking it unticks this (the vault item follows the container). */
  tickWith?: string
  /** Shown in red. */
  danger?: string
  notes: string[]
}

/** What the run needs about an item, kept server-side with the preview. */
type Target =
  | { kind: 'record' }
  | { kind: 'dns'; zone: string; name: string; data: string[] }
  | { kind: 'proxy'; instanceId: string; hostId: string; domains: string[] }
  | { kind: 'cert'; instanceId: string; certId: string; hostId: string }
  | { kind: 'container'; node: string; vmid: number; hostname: string }
  | { kind: 'backups'; vmid: number; jobs: string[] }
  | { kind: 'vault'; category: string; provider: string }

export interface DeletePreview {
  id: string
  siteId: string
  siteName: string
  adopted: boolean
  items: DeleteItem[]
  /** A line each for what could not be read at all (a proxy instance down, no DNS provider). */
  notes: string[]
  createdAt: number
  expiresAt: number
}

export interface ItemResult {
  key: string; kind: ItemKind
  outcome: 'removed' | 'already-gone' | 'failed' | 'kept'
  words: string
}

// ── What it reaches, so tests stand in for each ──────────────────────────────

export interface ProxyHostInfo {
  instanceId: string; instanceName: string; kind: string; id: string; domains: string[]
  certificateId?: string; readOnly?: boolean; readOnlyReason?: string
}

export interface SiteDeleteDeps {
  dns(): Promise<DnsLike | null>
  proxy: {
    /** Every proxy instance's hosts (fresh, not cached), with the instances that could not be read. */
    hosts(): Promise<{ hosts: ProxyHostInfo[]; errors: Array<{ instanceName: string; error: string }> }>
    /** One instance's hosts, read now (the read-back). */
    instanceHosts(instanceId: string): Promise<ProxyHostInfo[]>
    deleteHost(instanceId: string, hostId: string, actor: { email: string }): Promise<void>
    /** NPM only: the certificate ids every proxy, redirection and 404 host and stream uses; rejects if a list cannot be read. */
    certificateUsers(instanceId: string): Promise<Array<{ hostKind: string; id: string; certificateId: string | null }>>
    certificates(instanceId: string): Promise<Array<{ id: string; names: string[] }>>
    deleteCertificate(instanceId: string, certId: string): Promise<void>
  }
  /** The home cluster, for the container: identity, HA, backup jobs and the delete itself. */
  guest: ActionDeps
  /** What the install recorded it published: the site's own copy, else its install job's. Null when neither exists. */
  ledger(site: SiteRecord): Promise<PublishLedger | null>
  /** The hostname the install gave the container, when it is on record. */
  hostname(site: SiteRecord): Promise<string | null>
  /** The mark an install writes into its container's description. */
  installMark(jobId: string): string
  /** The site's vault item: whether the install created it (false: it existed before), or null when unknown. */
  vaultCreatedByInstall(site: SiteRecord): Promise<boolean | null>
  /** The item's key names (never values); [] when it is empty or missing. Throws while the vault is locked. */
  vaultKeys(category: string, provider: string): Promise<string[]>
  deleteVault(category: string, provider: string): Promise<void>
  /** The vault's display name for an item. */
  vaultName(category: string, provider: string): string
  site(id: string): Promise<SiteRecord | undefined>
  forget(id: string): Promise<void>
  deleteMetrics(id: string): Promise<void>
  metricsLeft(id: string): Promise<boolean>
  /** Writes an audit row or throws. */
  audit(action: string, resource: string, details?: Record<string, unknown>): Promise<void>
  now(): number
}

export class SiteDeleteRefusal extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'refused') { super(message) }
}

export const isAdoptedSite = (s: SiteRecord) => s.recipeId.startsWith('adopted-')
const lc = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/\.$/, '')

// ── The preview ──────────────────────────────────────────────────────────────

interface Built { items: DeleteItem[]; targets: Map<string, Target>; notes: string[] }

/** Read everything the site has and say what deleting it would remove. Writes nothing. */
export async function buildDeletePreview(site: SiteRecord, d: SiteDeleteDeps): Promise<Built> {
  const adopted = isAdoptedSite(site)
  const items: DeleteItem[] = [], targets = new Map<string, Target>(), notes: string[] = []
  const ledger = adopted ? null : await d.ledger(site).catch(() => null)

  items.push({
    key: 'record', kind: 'record', state: 'present', offered: true, locked: true, defaultOn: true, owned: true,
    label: adopted ? 'Stop tracking: the site record' : 'The site record',
    detail: `${site.name} in Sites, its metrics history and the collector's state`,
    notes: adopted ? ['HyperProx did not make this site, so stopping tracking only removes it from Sites and deletes its numbers.'] : [],
  })
  targets.set('record', { kind: 'record' })

  const domain = lc(site.domain)
  if (domain) {
    await dnsItem(site, domain, adopted, ledger, d, items, targets, notes)
    await proxyItems(site, domain, adopted, ledger, d, items, targets, notes)
  } else notes.push('The site has no public name, so there is no DNS record or proxy host to remove.')

  if (!adopted) await containerItems(site, d, items, targets)
  if (!adopted && site.vault) await vaultItem(site, site.vault, d, items, targets)
  else notes.push(`The container (CT ${site.vmid}) is never offered for an adopted site: HyperProx did not make it.`)
  return { items, targets, notes }
}

async function dnsItem(site: SiteRecord, domain: string, adopted: boolean, ledger: PublishLedger | null, d: SiteDeleteDeps,
  items: DeleteItem[], targets: Map<string, Target>, notes: string[]) {
  const base = { key: 'dns', kind: 'dns' as const, label: 'Its DNS record', defaultOn: false, offered: false, notes: [] as string[] }
  const dns = await d.dns().catch(() => null)
  if (!dns) { items.push({ ...base, state: 'unknown', owned: null, detail: domain, notes: ['No DNS provider is set up, so HyperProx cannot check it.'] }); return }
  const zones = ((await dns.getDomains().catch(() => null)) ?? []).map(z => lc(z.domain)).filter(Boolean)
  const z = zoneFor(domain, zones)
  if (!z) { items.push({ ...base, state: 'unknown', owned: null, detail: domain, notes: [`${domain} is not in a zone your DNS providers list, so HyperProx cannot reach its record.`] }); return }
  const recs = await dns.getRecords(z.zone).catch(() => null)
  if (!recs) { items.push({ ...base, state: 'unknown', owned: null, detail: `${domain} in ${z.zone}`, notes: [`The records of ${z.zone} could not be read.`] }); return }
  const at = recs.filter(r => lc(r.name) === z.name)
  const a = at.filter(r => r.type === 'A').map(r => String(r.data)).sort()
  const other = at.filter(r => r.type !== 'A')
  const n: string[] = other.length ? [`${domain} also has ${other.map(o => `${o.type} ${o.data}`).join(', ')}, which HyperProx leaves alone.`] : []
  if (!a.length) { items.push({ ...base, state: 'gone', owned: null, detail: `A ${z.name} in ${z.zone}`, notes: ['Already gone.', ...n] }); return }
  const mine = ledger?.dnsRecord && lc(ledger.dnsRecord.zone) === z.zone && lc(ledger.dnsRecord.name) === z.name ? ledger.dnsRecord : null
  const owned = adopted ? false : mine ? (a.length === 1 && a[0] === mine.data) : null
  if (adopted) n.unshift('HyperProx did not make this record. Type the site\'s name to remove it anyway.')
  else if (owned === null) n.unshift('HyperProx has no record of making this, so it is not ticked. Type the site\'s name to remove it, only if you know it is this site\'s.')
  else if (!owned) n.unshift(`HyperProx made it pointing at ${mine!.data}; it now holds ${a.join(', ')}, so it is not ticked. Type the site's name to remove it anyway.`)
  if (a.length > 1) n.push(`All ${a.length} A records for ${domain} would be removed.`)
  items.push({ ...base, state: 'present', offered: true, owned, defaultOn: owned === true, detail: `A ${z.name} in ${z.zone} → ${a.join(', ')}`,
    ...(owned !== true ? { typed: domain } : {}), notes: n })
  targets.set('dns', { kind: 'dns', zone: z.zone, name: z.name, data: a })
}

async function proxyItems(site: SiteRecord, domain: string, adopted: boolean, ledger: PublishLedger | null, d: SiteDeleteDeps,
  items: DeleteItem[], targets: Map<string, Target>, notes: string[]) {
  const all = await d.proxy.hosts().catch((e: any) => ({ hosts: [] as ProxyHostInfo[], errors: [{ instanceName: 'the proxies', error: String(e?.message ?? e) }] }))
  for (const e of all.errors) notes.push(`${e.instanceName} could not be read (${e.error}), so a host for ${domain} there would not be listed.`)
  const hosts = all.hosts.filter(h => h.domains.map(lc).includes(domain))
  if (!hosts.length) {
    items.push({ key: 'proxy', kind: 'proxy', label: 'Its proxy host', detail: domain, state: all.errors.length ? 'unknown' : 'gone',
      offered: false, defaultOn: false, owned: null, notes: [all.errors.length ? 'Not found on the proxies that could be read.' : 'Already gone.'] })
    await leftoverCertificate(domain, adopted, ledger, d, items, targets)
    return
  }
  for (const h of hosts) {
    const key = `proxy:${h.instanceId}:${h.id}`
    const mine = ledger?.proxyHost
    const owned = adopted ? false : mine ? (mine.instanceId === h.instanceId && String(mine.hostId) === h.id) : null
    const others = h.domains.filter(x => lc(x) !== domain)
    const n: string[] = []
    if (adopted) n.push('HyperProx did not make this host. Type the site\'s name to remove it anyway.')
    else if (owned === null) n.push('HyperProx has no record of making this host, so it is not ticked. Type the site\'s name to remove it anyway.')
    else if (!owned) n.push('HyperProx made a different host for this site, so this one is not ticked. Type the site\'s name to remove it anyway.')
    if (others.length) n.push(`It also serves ${others.join(', ')}; removing it takes those off the proxy too, so it is not ticked.`)
    const offered = !h.readOnly
    if (h.readOnly) n.push(h.readOnlyReason ?? 'This proxy host is read-only to HyperProx.')
    items.push({ key, kind: 'proxy', label: 'Its proxy host', detail: `${h.domains.join(', ')} on ${h.instanceName}`, state: 'present',
      offered, owned, defaultOn: offered && owned === true && !others.length, ...(owned !== true ? { typed: domain } : {}), notes: n })
    if (offered) targets.set(key, { kind: 'proxy', instanceId: h.instanceId, hostId: h.id, domains: h.domains })

    if (!h.certificateId) continue
    const ckey = `cert:${h.instanceId}:${h.certificateId}`
    const cbase = { key: ckey, kind: 'cert' as const, label: 'Its certificate', detail: `certificate ${h.certificateId} on ${h.instanceName}`, requires: key }
    if (h.kind !== 'npm') { notes.push(`${h.instanceName} gets its own certificates; there is none for HyperProx to remove.`); continue }
    const users = await d.proxy.certificateUsers(h.instanceId).catch(() => null)
    if (!users) { items.push({ ...cbase, state: 'unknown', offered: false, defaultOn: false, owned: null, notes: ['HyperProx could not read every host on the proxy, so it cannot tell whether anything else uses it. It is kept.'] }); continue }
    const elsewhere = users.filter(u => u.certificateId === h.certificateId && !(u.hostKind === 'proxy' && u.id === h.id))
    if (elsewhere.length) { items.push({ ...cbase, state: 'present', offered: false, defaultOn: false, owned: null, notes: [`${elsewhere.length} other host(s) use it, so it is kept.`] }); continue }
    const cmine = ledger?.certificate
    const cowned = adopted ? false : cmine ? (cmine.instanceId === h.instanceId && String(cmine.id) === h.certificateId) : null
    items.push({ ...cbase, state: 'present', offered: offered, owned: cowned, defaultOn: offered && cowned === true && !others.length,
      ...(cowned !== true ? { typed: domain } : {}),
      notes: [
        'Nothing else on the proxy uses it. It goes only together with its host.',
        ...(cowned === null && !adopted ? ['HyperProx has no record of requesting it, so it is not ticked.'] : []),
        ...(cowned === false && !adopted ? ['HyperProx requested a different certificate for this site, so this one is not ticked.'] : []),
      ] })
    if (offered) targets.set(ckey, { kind: 'cert', instanceId: h.instanceId, certId: h.certificateId, hostId: h.id })
  }
  await leftoverCertificate(domain, adopted, ledger, d, items, targets)
}

/**
 * The certificate the install requested, when its host is already gone (a delete that stopped after the host): it
 * is offered on its own so a retry can finish, but only while nothing on the proxy uses it.
 */
async function leftoverCertificate(domain: string, adopted: boolean, ledger: PublishLedger | null, d: SiteDeleteDeps,
  items: DeleteItem[], targets: Map<string, Target>) {
  const c = ledger?.certificate
  if (adopted || !c || items.some(i => i.key === `cert:${c.instanceId}:${c.id}`)) return
  const certs = await d.proxy.certificates(c.instanceId).catch(() => null)
  if (!certs || !certs.some(x => x.id === String(c.id))) return
  const users = await d.proxy.certificateUsers(c.instanceId).catch(() => null)
  const key = `cert:${c.instanceId}:${c.id}`
  const base = { key, kind: 'cert' as const, label: 'Its certificate', detail: `certificate ${c.id} for ${domain} (its host is gone)` }
  if (!users) { items.push({ ...base, state: 'unknown', offered: false, defaultOn: false, owned: true, notes: ['HyperProx could not read every host on the proxy, so it cannot tell whether anything uses it. It is kept.'] }); return }
  if (users.some(u => u.certificateId === String(c.id))) { items.push({ ...base, state: 'present', offered: false, defaultOn: false, owned: true, notes: ['Another host uses it now, so it is kept.'] }); return }
  items.push({ ...base, state: 'present', offered: true, defaultOn: true, owned: true, notes: ['HyperProx requested it for this site and nothing on the proxy uses it now.'] })
  targets.set(key, { kind: 'cert', instanceId: c.instanceId, certId: String(c.id), hostId: '' })
}

/** The container as it stands, or why it is not the one this site was installed into. */
async function lookContainer(site: SiteRecord, d: SiteDeleteDeps): Promise<
  { state: 'gone' } | { state: 'unknown'; why: string } | { state: 'mismatch'; why: string } | { state: 'present'; node: string; hostname: string; running: boolean; ha: boolean }> {
  let rows: any[] | null
  try { rows = await d.guest.pve.fetchStrict<any[]>('/cluster/resources?type=vm') } catch (e: any) { return { state: 'unknown', why: `Proxmox could not be read: ${e.message}` } }
  if (!Array.isArray(rows)) return { state: 'unknown', why: 'Proxmox did not return the guest list.' }
  const row = rows.find(r => Number(r?.vmid) === site.vmid)
  if (!row) return { state: 'gone' }
  if (row.type !== 'lxc') return { state: 'mismatch', why: `ID ${site.vmid} is now a VM, not this site's container.` }
  const node = String(row.node)
  let cfg: any
  try { cfg = await d.guest.pve.fetchStrict<any>(`/nodes/${encodeURIComponent(node)}/lxc/${site.vmid}/config`) } catch (e: any) { return { state: 'unknown', why: `Its configuration could not be read: ${e.message}` } }
  const hostname = String(cfg?.hostname ?? '')
  if (!String(cfg?.description ?? '').includes(d.installMark(site.jobId))) {
    return { state: 'mismatch', why: `CT ${site.vmid} does not carry this site's install mark in its description, so it is not the container this site was installed into. HyperProx will not delete it.` }
  }
  const want = await d.hostname(site).catch(() => null)
  if (want && hostname !== want) {
    return { state: 'mismatch', why: `CT ${site.vmid} is called "${hostname}", but this site was installed as "${want}". HyperProx will not delete it.` }
  }
  let ha: boolean
  try { ha = await inHa(d.guest.pve, { type: 'lxc', vmid: site.vmid }) } catch { return { state: 'unknown', why: 'The HA list could not be read.' } }
  return { state: 'present', node, hostname, running: String(row.status) !== 'stopped', ha }
}

async function containerItems(site: SiteRecord, d: SiteDeleteDeps, items: DeleteItem[], targets: Map<string, Target>) {
  const c = await lookContainer(site, d)
  const base = { key: 'container', kind: 'container' as const, label: 'Its container', detail: `CT ${site.vmid} on ${site.node}`, defaultOn: false }
  if (c.state === 'gone') {
    items.push({ ...base, state: 'gone', offered: false, owned: true, notes: ['Container gone: it no longer exists, so there is nothing to delete.'] })
    let jobs: Awaited<ReturnType<typeof backupJobsWith>> | null = null
    try { jobs = await backupJobsWith(d.guest.pve, site.vmid) } catch { /* said below */ }
    if (jobs === null) items.push({ key: 'backups', kind: 'backups', label: 'Its backup job entries', detail: `ID ${site.vmid}`, state: 'unknown', offered: false, defaultOn: false, owned: null, notes: ['The backup jobs could not be read.'] })
    else if (jobs.length) {
      items.push({ key: 'backups', kind: 'backups', label: 'Its backup job entries', state: 'present', offered: true, defaultOn: true, owned: true,
        detail: `ID ${site.vmid} in ${jobs.map(j => j.id).join(', ')}`,
        notes: ['The container is gone but its ID is still listed, which fails that job on every node.', ...jobs.filter(j => j.only).map(j => `Job ${j.id} lists only this ID, so the job is deleted.`)] })
      targets.set('backups', { kind: 'backups', vmid: site.vmid, jobs: jobs.map(j => j.id) })
    }
    return
  }
  if (c.state === 'unknown') { items.push({ ...base, state: 'unknown', offered: false, owned: null, notes: [c.why] }); return }
  if (c.state === 'mismatch') { items.push({ ...base, state: 'mismatch', offered: false, owned: false, notes: [c.why] }); return }
  const notes: string[] = []
  if (c.ha) notes.push('It is under HA: it is taken out of HA first.')
  if (c.running) notes.push('It is running: it is stopped first.')
  let jobs: string[] = []
  try { jobs = (await backupJobsWith(d.guest.pve, site.vmid)).map(j => j.id) } catch { notes.push('The backup jobs could not be read now; they are checked again after the delete.') }
  notes.push(jobs.length ? `It is taken out of backup job(s) ${jobs.join(', ')} afterwards (a job that lists only it is deleted).` : 'No backup job lists it.')
  notes.push('A backup-server NAS mount HyperProx made on its node for it is removed too.')
  items.push({ ...base, detail: `CT ${site.vmid} (${c.hostname}) on ${c.node}`, state: 'present', offered: true, owned: true,
    danger: 'Deletes the container and its disk, permanently.', typed: c.hostname, notes })
  targets.set('container', { kind: 'container', node: c.node, vmid: site.vmid, hostname: c.hostname })
}

/** The site's vault item: ticked with the container, or already when the container is gone. */
async function vaultItem(site: SiteRecord, v: { category: string; provider: string }, d: SiteDeleteDeps, items: DeleteItem[], targets: Map<string, Target>) {
  const name = d.vaultName(v.category, v.provider)
  const base = { key: 'vault', kind: 'vault' as const, label: 'Its vault item', detail: name }
  const made = await d.vaultCreatedByInstall(site).catch(() => null)
  if (made === false) { items.push({ ...base, state: 'present', offered: false, defaultOn: false, owned: false, notes: ['It existed before this site was installed, so it is kept.'] }); return }
  let keys: string[]
  try { keys = await d.vaultKeys(v.category, v.provider) } catch (e: any) {
    items.push({ ...base, state: 'unknown', offered: false, defaultOn: false, owned: made, notes: [`The vault could not be read (${e.message}).`] }); return
  }
  if (!keys.length) { items.push({ ...base, state: 'gone', offered: false, defaultOn: false, owned: made, notes: ['Already gone.'] }); return }
  const container = items.find(i => i.key === 'container')
  const gone = container?.state === 'gone'
  items.push({ ...base, detail: `${name}: ${keys.join(', ')}`, state: 'present', offered: true, owned: made, defaultOn: gone,
    ...(container?.offered ? { tickWith: 'container' } : {}),
    notes: [
      gone ? 'The container is gone, so these logins open nothing any more.' : 'The logins and keys the install generated for this site. Ticked when its container is deleted too; kept otherwise, so the site can still be signed in to.',
      ...(made === null ? ['HyperProx has no record of whether the install created it.'] : []),
    ] })
  targets.set('vault', { kind: 'vault', category: v.category, provider: v.provider })
}

// ── Previews: single use, per person, per site, ten minutes ─────────────────

interface Held { preview: DeletePreview; targets: Map<string, Target>; owner: string }

export class DeletePreviewStore {
  private m = new Map<string, Held>()
  constructor(private now: () => number) {}
  put(owner: string, site: SiteRecord, b: Built): DeletePreview {
    this.prune()
    const at = this.now()
    const preview: DeletePreview = { id: randomBytes(16).toString('hex'), siteId: site.id, siteName: site.name, adopted: isAdoptedSite(site),
      items: b.items, notes: b.notes, createdAt: at, expiresAt: at + DELETE_PREVIEW_TTL_MS }
    this.m.set(preview.id, { preview, targets: b.targets, owner })
    return preview
  }
  take(id: unknown, owner: string, siteId: string): Held {
    this.prune()
    const h = typeof id === 'string' ? this.m.get(id) : undefined
    if (!h || h.preview.siteId !== siteId) throw new SiteDeleteRefusal('That preview has expired or is not for this site. Preview the delete again.', 409, 'preview_expired')
    if (h.owner !== owner) throw new SiteDeleteRefusal('That preview belongs to someone else.', 403, 'not_yours')
    this.m.delete(id as string)
    return h
  }
  private prune() { const t = this.now(); for (const [k, v] of this.m) if (v.preview.expiresAt < t) this.m.delete(k) }
}

// ── The run ──────────────────────────────────────────────────────────────────

/** Which items to remove, checked against the preview. Throws before anything is done. */
export function checkChoice(p: DeletePreview, raw: { items?: unknown; confirm?: unknown }): Set<string> {
  const keys = new Set(Array.isArray(raw.items) ? raw.items.filter((k): k is string => typeof k === 'string') : [])
  keys.add('record')
  const confirm = (raw.confirm && typeof raw.confirm === 'object' ? raw.confirm : {}) as Record<string, unknown>
  for (const k of keys) {
    const it = p.items.find(i => i.key === k)
    if (!it) throw new SiteDeleteRefusal(`"${k}" is not in the preview.`)
    if (!it.offered) throw new SiteDeleteRefusal(`${it.label} cannot be removed: ${it.notes[0] ?? it.state}.`)
    if (it.typed && lc(confirm[k]) !== lc(it.typed)) {
      throw new SiteDeleteRefusal(it.kind === 'container' ? `Type the container's hostname (${it.typed}) to delete it.` : `Type ${it.typed} to remove ${it.label.toLowerCase()}: HyperProx has no record of making it.`, 400, 'typed_confirm')
    }
    if (it.requires && !keys.has(it.requires)) throw new SiteDeleteRefusal(`${it.label} goes only together with its proxy host.`)
  }
  return keys
}

const ORDER: ItemKind[] = ['proxy', 'cert', 'dns', 'container', 'backups', 'vault', 'record']
const running = new Set<string>()

/**
 * Remove the ticked items, in order: proxy hosts, certificates, DNS, the container, dead backup-job entries, and the
 * record last. Each is audited before (no audit, no change) and after, re-read just before it is changed, and read
 * back. The record is removed only when every other ticked item is gone, so a failed run can be previewed again.
 */
export async function runDelete(site: SiteRecord, held: Held, keys: Set<string>, by: string, d: SiteDeleteDeps): Promise<{ results: ItemResult[]; recordRemoved: boolean }> {
  if (running.has(site.id)) throw new SiteDeleteRefusal('This site is being deleted already.', 409, 'busy')
  running.add(site.id)
  try {
    const results: ItemResult[] = []
    const chosen = [...keys].map(k => held.preview.items.find(i => i.key === k)!).sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
    for (const it of chosen) {
      // The logins go only once the container they open is gone: a container that stayed keeps them.
      if (it.kind === 'vault' && results.some(r => r.kind === 'container' && r.outcome === 'failed')) {
        results.push({ key: 'vault', kind: 'vault', outcome: 'kept', words: 'The vault item was kept because the container was not deleted, so its logins still open it.' })
        continue
      }
      if (it.kind === 'record') {
        const failed = results.filter(r => r.outcome === 'failed')
        if (failed.length) {
          results.push({ key: 'record', kind: 'record', outcome: 'kept', words: `The site record was kept because ${failed.length} item(s) did not go, so you can preview the delete again and retry.` })
          continue
        }
      }
      results.push(await runItem(site, it, held.targets.get(it.key)!, by, d))
    }
    return { results, recordRemoved: results.some(r => r.kind === 'record' && r.outcome === 'removed') }
  } finally { running.delete(site.id) }
}

async function runItem(site: SiteRecord, it: DeleteItem, t: Target, by: string, d: SiteDeleteDeps): Promise<ItemResult> {
  const resource = `site:${site.id}`
  const r = (outcome: ItemResult['outcome'], words: string): ItemResult => ({ key: it.key, kind: it.kind, outcome, words })
  try { await d.audit('site.delete.item.start', resource, { by, item: it.key, detail: it.detail }) }
  catch (e: any) { return r('failed', `Not removed: the audit log could not be written (${e.message}), so HyperProx did not change anything for this item.`) }
  let out: ItemResult
  try { out = await doItem(site, it, t, by, d, r) }
  catch (e: any) { out = r('failed', `${it.label} was not removed: ${String(e?.message ?? e).slice(0, 300)}`) }
  await d.audit('site.delete.item.result', resource, { by, item: it.key, outcome: out.outcome, words: out.words }).catch(() => {})
  return out
}

async function doItem(site: SiteRecord, it: DeleteItem, t: Target, by: string, d: SiteDeleteDeps,
  r: (o: ItemResult['outcome'], w: string) => ItemResult): Promise<ItemResult> {
  const actor = { email: by || 'hyperprox' }
  switch (t.kind) {
    case 'proxy': {
      const before = await d.proxy.instanceHosts(t.instanceId)
      const h = before.find(x => x.id === t.hostId)
      if (!h) return r('already-gone', 'The proxy host is already gone.')
      if (JSON.stringify(h.domains.map(lc).sort()) !== JSON.stringify(t.domains.map(lc).sort())) return r('failed', 'The proxy host changed since the preview (its names are different). Preview again.')
      await d.proxy.deleteHost(t.instanceId, t.hostId, actor)
      const after = await d.proxy.instanceHosts(t.instanceId)
      return after.some(x => x.id === t.hostId) ? r('failed', 'The proxy still lists the host after the delete.') : r('removed', `Removed the proxy host for ${t.domains.join(', ')} (read back).`)
    }
    case 'cert': {
      const certs = await d.proxy.certificates(t.instanceId)
      if (!certs.some(c => c.id === t.certId)) return r('already-gone', 'The certificate is already gone.')
      const users = await d.proxy.certificateUsers(t.instanceId)
      const using = users.filter(u => u.certificateId === t.certId)
      if (using.length) return r('failed', `The certificate is in use by ${using.length} host(s) now, so it was kept.`)
      await d.proxy.deleteCertificate(t.instanceId, t.certId)
      const left = await d.proxy.certificates(t.instanceId)
      return left.some(c => c.id === t.certId) ? r('failed', 'The proxy still lists the certificate after the delete.') : r('removed', `Removed certificate ${t.certId} (read back).`)
    }
    case 'dns': {
      const dns = await d.dns()
      if (!dns) return r('failed', 'The DNS provider is no longer set up.')
      const fqdn = t.name === '@' ? t.zone : `${t.name}.${t.zone}`
      const now = (await dns.getRecords(t.zone)).filter(x => x.type === 'A' && lc(x.name) === t.name).map(x => String(x.data)).sort()
      if (!now.length) return r('already-gone', `The DNS record for ${fqdn} is already gone.`)
      if (JSON.stringify(now) !== JSON.stringify(t.data)) return r('failed', `${fqdn} now holds ${now.join(', ')}, not what the preview showed (${t.data.join(', ')}). It was left alone; preview again.`)
      await dns.deleteRecord(t.zone, 'A', t.name)
      const left = (await dns.getRecords(t.zone)).filter(x => x.type === 'A' && lc(x.name) === t.name)
      return left.length ? r('failed', `${fqdn} still has an A record after the delete.`) : r('removed', `Removed the DNS record ${fqdn} → ${t.data.join(', ')} (read back).`)
    }
    case 'container': {
      // The container is looked at again: it must still be the one the preview showed, with the install's mark.
      const c = await lookContainer(site, d)
      if (c.state === 'gone') {
        const jobs = await removeFromBackupJobs(d.guest.pve, t.vmid)
        return jobs.ok ? r('already-gone', `CT ${t.vmid} is already gone. ${jobs.words}`) : r('failed', `CT ${t.vmid} is gone, but ${jobs.words}`)
      }
      if (c.state !== 'present') return r('failed', c.why)
      if (c.hostname !== t.hostname) return r('failed', `CT ${t.vmid} is now called "${c.hostname}", not "${t.hostname}" as in the preview. It was left alone.`)
      const g = { node: c.node, type: 'lxc' as const, vmid: t.vmid }
      const name = await guestName(d.guest.pve, g)
      const out = await destroyOwned(d.guest, g, name)
      return r(out.ok ? 'removed' : 'failed', out.words)
    }
    case 'backups': {
      const live = await d.guest.pve.fetchStrict<any[]>('/cluster/resources?type=vm')
      if (!Array.isArray(live)) return r('failed', 'Proxmox did not return the guest list.')
      if (live.some(x => Number(x?.vmid) === t.vmid)) return r('failed', `ID ${t.vmid} exists again, so its backup entries are not dead. They were left alone.`)
      const out = await removeFromBackupJobs(d.guest.pve, t.vmid)
      if (!out.jobs.length) return r('already-gone', `No backup job lists ${t.vmid} any more.`)
      return r(out.ok ? 'removed' : 'failed', out.words)
    }
    case 'vault': {
      const before = await d.vaultKeys(t.category, t.provider)
      if (!before.length) return r('already-gone', 'The vault item is already gone.')
      await d.deleteVault(t.category, t.provider)
      const left = await d.vaultKeys(t.category, t.provider)
      return left.length ? r('failed', `The vault item still holds ${left.join(', ')} after the delete.`) : r('removed', `Removed the vault item ${d.vaultName(t.category, t.provider)} (${before.join(', ')}; read back).`)
    }
    case 'record': {
      if (!(await d.site(site.id))) return r('already-gone', 'The site record is already gone.')
      await d.forget(site.id)
      await d.deleteMetrics(site.id)
      const left = [(await d.site(site.id)) ? 'the record' : '', (await d.metricsLeft(site.id)) ? 'its metrics' : ''].filter(Boolean)
      return left.length ? r('failed', `${left.join(' and ')} still exist after the delete.`)
        : r('removed', isAdoptedSite(site) ? `Stopped tracking ${site.name}: the record and its metrics are gone (read back).` : `Removed ${site.name} from Sites with its metrics and collector state (read back).`)
    }
  }
}
