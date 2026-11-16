// =============================================================================
//  HyperProx — removed guests: what HyperProx still holds for one, and the clean-up
//
//  For a guest the detector decided is gone, every place HyperProx keeps
//  something that points at it, each with exactly what a clean-up would do:
//
//    HyperProx's own records (removed by "Clean up")
//      homepage        a Homepage dashboard connected to it (+ its Proxmox token
//                      and the token's vault item)
//      nextcloud       a Nextcloud instance on it (+ its vault items)
//      install         a finished Catalogue install record (+ the login vault
//                      item that install made)
//      site            a Sites entry (+ its metrics and vault item)
//      auto-connect    auto-connect's memory of it (connected, pending, or a
//                      dismissal), so a new install there starts clean
//      plugin-address  a plug-in setting holding an address it had (+ the key
//                      stored for that address)
//      deck-address    the Terminal's remembered address for it
//      remote          Remote access's record of the VPN client on it (+ the
//                      device at the provider when HyperProx installed it)
//      wireguard       a WireGuard server or peer on it (+ their vault items)
//      move            a scheduled load-balancing move of it (cancelled)
//    The cluster's config (shown line by line, part of "Clean up")
//      ha              an HA resource still naming it
//      backup-job      a backup job still listing its ID: the new list is shown;
//                      a job that would back up nothing is never deleted unless
//                      the person ticks that job
//    What it published (its own checkbox, off by default)
//      published       the proxy host and DNS record its install recorded
//                      making: never guessed from an address
//
//  Addresses are matched only for an address the guest itself was seen at
//  (the service scan, its install record), only against a scan taken after the
//  removal and after the newest guest was created or restored, and never when
//  a guest that exists now is seen at that address or has it in its config.
//  A pinned SSH host key is never forgotten: nothing proves whose key it is,
//  and a pin that no longer matches already refuses the connection. A record made after the guest was removed is
//  never its. When another guest has the ID now, nothing on the cluster and no
//  record keyed by the ID alone is touched.
// =============================================================================

import type { RemovedGuest } from './detector'
import type { PublishLedger } from '../sites'

export type HoldingKind =
  | 'homepage' | 'nextcloud' | 'install' | 'site' | 'auto-connect' | 'plugin-address' | 'deck-address'
  | 'remote' | 'wireguard' | 'move' | 'ha' | 'backup-job' | 'published'

export type HoldingGroup = 'hyperprox' | 'cluster' | 'published'

export interface Holding {
  id: string
  kind: HoldingKind
  group: HoldingGroup
  /** Plain English, one line: what it is. */
  label: string
  /** What the clean-up does to it. */
  change: string
  /** Vault items it takes with it (names only). */
  vault?: string[]
  /** Backup jobs: the exact change. `empty`: the job would back up nothing, so it is only deleted when ticked. */
  job?: { id: string; before: number[]; after: number[]; empty: boolean; schedule: string | null; comment: string | null }
  /** Which plug-in page shows it (for the notice on that page). */
  plugin?: string
}

// ── what the clean-up reads and writes (production: ./production.ts; tests: fakes) ──

export interface InstallRow { jobId: string; recipeId: string; vmid: number; hostname: string | null; ip: string | null; startedAt: number; owner: string; vaultItem: { category: string; provider: string; createdByJob: boolean } | null; ledgers: PublishLedger[] }
export interface SiteRow { id: string; name: string; vmid: number; ip: string | null; createdAt: number; owner: string; vault: { category: string; provider: string } | null; published: PublishLedger | null }
export interface LiveAddresses { hosts: Set<string>; scanAt: number; newestGuestAt: number | null }
export interface PluginAddress { plugin: string; pluginName: string; setting: string; value: string; also: string[] }
export interface BackupJob { id: string; vmid: string; schedule: string | null; comment: string | null }

export interface HoldingDeps {
  homepage: { list(): Promise<Array<{ id: string; kind: 'lxc' | 'qemu'; vmid: number; name: string; addedAt: number; token: string | null }>>; forget(id: string, by: string): Promise<string> }
  nextcloud: { list(): Promise<Array<{ id: string; name: string; kind: 'lxc' | 'qemu'; vmid: number; addedAt: number }>>; forget(id: string, by: string): Promise<string> }
  installs: { list(): Promise<InstallRow[]>; forget(jobId: string, by: string): Promise<string> }
  sites: { list(): Promise<SiteRow[]>; forget(id: string, by: string): Promise<string> }
  autoConnect: { keys(): Promise<Array<{ plugin: string; key: string; label: string; state: 'connected' | 'pending' | 'dismissed' }>>; forget(entries: Array<{ plugin: string; key: string }>): Promise<void> }
  plugins: { addresses(): Promise<PluginAddress[]>; clear(plugin: string, settings: string[], by: string): Promise<void> }
  deck: { addresses(): Promise<Record<string, string>>; forget(hostId: string): Promise<void> }
  remote: { list(): Promise<Array<{ machineId: string; provider: string; deviceId: string | null; adopted: boolean }>>; forget(machineId: string, provider: string, by: string): Promise<string> }
  wireguard: { list(): Promise<{ servers: Array<{ id: string; machineId: string; iface: string }>; peers: Array<{ id: string; machineId: string | null; name: string; serverId: string | null }> }>; forgetMachine(machineId: string, by: string): Promise<string> }
  moves: { scheduled(): Promise<Array<{ id: string; sid: string; name: string }>>; cancel(id: string, by: string): Promise<void> }
  pve: {
    ha(): Promise<string[]>
    removeHa(sid: string): Promise<void>
    backupJobs(): Promise<BackupJob[]>
    setJobVmids(id: string, vmids: number[]): Promise<void>
    deleteJob(id: string): Promise<void>
  }
  publish: { cleanup(ledger: PublishLedger, owner: string): Promise<string[]> }
  /** Addresses a guest that exists now is seen at: never treated as the removed guest's. */
  /**
   * What guests use now: the hosts the last service scan saw on a guest plus every current guest's configured address,
   * when that scan was taken, and when the newest guest was created or restored (null when the task log does not say).
   * Throws when it cannot be read: then no address is matched.
   */
  liveAddresses(): Promise<LiveAddresses>
  /** Take a fresh service scan (the clean-up does, so the addresses it matches are current). */
  refreshScan?(): Promise<void>
  /** Throws when the audit row cannot be written: then nothing is changed. */
  audit(action: string, resource: string, details: Record<string, unknown>): Promise<void>
}

const mid = (type: string, vmid: number) => `${type}-${vmid}`
const sidOf = (type: string, vmid: number) => `${type === 'qemu' ? 'vm' : 'ct'}:${vmid}`

/** The host of an address (URL, host:port or bare host), lower case, without brackets. */
export function hostOf(v: string): string {
  const s = String(v ?? '').trim()
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`).hostname.toLowerCase().replace(/^\[|\]$/g, '') } catch { return s.toLowerCase() }
}

/** Every ID a backup job's `vmid` lists. */
export const jobVmids = (v: string) => String(v ?? '').split(',').map(x => Number(x.trim())).filter(n => Number.isInteger(n) && n > 0)

/** The machine ids it may have had (its type may be unknown when only a backup job named it). */
function machineIds(g: RemovedGuest): string[] {
  return g.type ? [mid(g.type, g.vmid)] : [mid('lxc', g.vmid), mid('qemu', g.vmid)]
}
function sids(g: RemovedGuest): string[] {
  return g.type ? [sidOf(g.type, g.vmid)] : [sidOf('lxc', g.vmid), sidOf('qemu', g.vmid)]
}

/** Made before the guest was removed (a record made after it is some other guest's). */
function before(g: RemovedGuest, at: number | null | undefined): boolean {
  const cut = g.removedAt ?? g.noticedAt
  // With the ID reused, a record that does not say when it was made could be the new guest's: it is not the old one's.
  if (!at || !Number.isFinite(at)) return !g.reused
  return at <= cut
}

/** The removed guest's addresses that are safe to match now, or null when the picture of what guests use is too old. */
export function addressesTheirs(g: RemovedGuest, live: LiveAddresses | null): Set<string> | null {
  if (!live) return null
  const after = Math.max(g.removedAt ?? g.noticedAt, live.newestGuestAt ?? 0)
  if (live.scanAt <= after) return null
  return new Set(g.addresses.map(hostOf).filter(h => h && !live.hosts.has(h)))
}

const what = (g: RemovedGuest) => g.type === 'qemu' ? 'VM' : g.type === 'lxc' ? 'container' : 'guest'

/** Everything HyperProx still holds for a removed guest. Each source that cannot be read is named in `unread`. */
export async function holdingsFor(g: RemovedGuest, d: HoldingDeps): Promise<{ holdings: Holding[]; unread: string[] }> {
  const out: Holding[] = []
  const unread: string[] = []
  const reused = !!g.reused
  const ids = machineIds(g)
  const read = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => { try { return await fn() } catch { unread.push(name); return null } }
  const live = (await read('which addresses guests use now (so no plug-in address is offered)', () => d.liveAddresses())) ?? null
  // Without a current picture of what guests use, no address is matched at all (one may belong to another guest now).
  const fresh = addressesTheirs(g, live)
  if (live && !fresh && g.addresses.length) unread.push('a service scan newer than the removal (so no plug-in address is offered)')
  const theirs = fresh ?? new Set<string>()

  for (const h of (await read('Homepage', () => d.homepage.list())) ?? []) {
    if (h.vmid !== g.vmid || (g.type && h.kind !== g.type) || !before(g, h.addedAt)) continue
    out.push({ id: `homepage:${h.id}`, kind: 'homepage', group: 'hyperprox', plugin: 'homepage', label: `The Homepage plug-in's connection to ${h.name}`,
      change: `forgotten${h.token ? ', and the read-only Proxmox token made for it revoked' : ''}`, ...(h.token ? { vault: [`homepage/${h.id}`] } : {}) })
  }
  for (const n of (await read('Nextcloud', () => d.nextcloud.list())) ?? []) {
    if (n.vmid !== g.vmid || (g.type && n.kind !== g.type) || !before(g, n.addedAt)) continue
    out.push({ id: `nextcloud:${n.id}`, kind: 'nextcloud', group: 'hyperprox', plugin: 'nextcloud', label: `The Nextcloud plug-in's instance "${n.name}"`, change: 'forgotten, with its saved logins', vault: [`plugin/nextcloud.${n.id}`] })
  }
  const installs = (await read('Catalogue installs', () => d.installs.list())) ?? []
  for (const j of installs) {
    if (j.vmid !== g.vmid || !before(g, j.startedAt)) continue
    out.push({ id: `install:${j.jobId}`, kind: 'install', group: 'hyperprox', label: `The Catalogue install record (${j.recipeId})`, change: 'forgotten',
      ...(j.vaultItem?.createdByJob ? { vault: [`${j.vaultItem.category}/${j.vaultItem.provider}`] } : {}) })
    j.ledgers.forEach((l, i) => { if (l.proxyHost || l.dnsRecord) out.push(publishedHolding(`published:install:${j.jobId}:${i}`, l)) })
  }
  for (const s of (await read('Sites', () => d.sites.list())) ?? []) {
    if (s.vmid !== g.vmid || !before(g, s.createdAt)) continue
    out.push({ id: `site:${s.id}`, kind: 'site', group: 'hyperprox', label: `The website "${s.name}" on the Sites page`, change: 'forgotten, with its metrics', ...(s.vault ? { vault: [`${s.vault.category}/${s.vault.provider}`] } : {}) })
    // The same ledger as its install's: listed once.
    if (s.published && (s.published.proxyHost || s.published.dnsRecord) && !out.some(h => h.kind === 'published' && samePublished(h, s.published!))) out.push(publishedHolding(`published:site:${s.id}`, s.published))
  }
  for (const e of (await read('auto-connect', () => d.autoConnect.keys())) ?? []) {
    const machineKey = e.key.split('#')[0]
    const byMachine = !reused && ids.includes(machineKey)
    const at = e.key.indexOf('@')
    const byAddress = at > 0 && theirs.has(hostOf(e.key.slice(at + 1)))
    if (!byMachine && !byAddress) continue
    out.push({ id: `auto-connect:${e.plugin}/${e.key}`, kind: 'auto-connect', group: 'hyperprox', plugin: e.plugin,
      label: `Auto-connect's memory of ${e.label} (${e.state === 'dismissed' ? 'disconnected by a person' : e.state})`, change: 'forgotten, so a new install there connects by itself' })
  }
  for (const p of (await read('plug-in settings', () => d.plugins.addresses())) ?? []) {
    if (!theirs.has(hostOf(p.value))) continue
    out.push({ id: `plugin-address:${p.plugin}:${p.setting}`, kind: 'plugin-address', group: 'hyperprox', plugin: p.plugin,
      label: `${p.pluginName}'s address ${p.value}`, change: `cleared${p.also.length ? ' with the key saved for it' : ''}`, ...(p.also.length ? { vault: [`plugin/${p.plugin}`] } : {}) })
  }
  const deck = reused ? null : await read('the Terminal', () => d.deck.addresses())
  if (deck) for (const id of ids) if (deck[id]) out.push({ id: `deck-address:${id}`, kind: 'deck-address', group: 'hyperprox', label: `The Terminal's saved address for it (${deck[id]})`, change: 'forgotten' })
  if (!reused) {
    for (const r of (await read('Remote access', () => d.remote.list())) ?? []) {
      if (!ids.includes(r.machineId)) continue
      out.push({ id: `remote:${r.machineId}:${r.provider}`, kind: 'remote', group: 'hyperprox', label: `Remote access's ${r.provider} client on it`,
        change: r.deviceId && !r.adopted ? `forgotten, and its device removed from ${r.provider}` : 'forgotten (its device at the provider is left as it is: HyperProx did not add it)' })
    }
    const wg = await read('WireGuard', () => d.wireguard.list())
    for (const id of ids) {
      const servers = wg?.servers.filter(s => s.machineId === id) ?? []
      const peers = wg?.peers.filter(p => p.machineId === id) ?? []
      if (!servers.length && !peers.length) continue
      out.push({ id: `wireguard:${id}`, kind: 'wireguard', group: 'hyperprox',
        label: `WireGuard: ${[servers.length ? `${servers.length === 1 ? 'a server' : `${servers.length} servers`} on it` : '', peers.length ? `${peers.length === 1 ? 'a tunnel' : `${peers.length} tunnels`} from it` : ''].filter(Boolean).join(' and ')}`,
        change: servers.length ? 'forgotten with the devices that connected to it and their saved configs' : 'forgotten, and taken off the server it connected to' })
    }
    for (const m of (await read('load balancing', () => d.moves.scheduled())) ?? []) {
      if (!sids(g).includes(m.sid)) continue
      out.push({ id: `move:${m.id}`, kind: 'move', group: 'hyperprox', label: `A scheduled load-balancing move of ${m.name}`, change: 'cancelled' })
    }
    const ha = (await read('the HA list', () => d.pve.ha())) ?? []
    for (const sid of sids(g)) if (ha.includes(sid)) out.push({ id: `ha:${sid}`, kind: 'ha', group: 'cluster', label: `HA still manages ${sid}`, change: `${sid} taken out of HA (and out of any HA rule)` })
    for (const j of (await read('the backup jobs', () => d.pve.backupJobs())) ?? []) {
      const list = jobVmids(j.vmid)
      if (!list.includes(g.vmid)) continue
      const after = list.filter(v => v !== g.vmid)
      out.push({ id: `backup-job:${j.id}`, kind: 'backup-job', group: 'cluster', label: `Backup job ${j.comment ? `"${j.comment}" ` : ''}(${j.id}${j.schedule ? `, ${j.schedule}` : ''}) still lists ${g.vmid}`,
        change: after.length ? `its guest list becomes ${after.join(', ')}` : `it would back up nothing: deleted only if you tick it`,
        job: { id: j.id, before: list, after, empty: !after.length, schedule: j.schedule, comment: j.comment } })
    }
  }
  return { holdings: out, unread }
}

function publishedHolding(id: string, l: PublishLedger): Holding {
  const parts = [l.dnsRecord ? `the DNS record ${l.dnsRecord.name === '@' ? l.dnsRecord.zone : `${l.dnsRecord.name}.${l.dnsRecord.zone}`}` : '', l.proxyHost ? 'its proxy host' : ''].filter(Boolean)
  return { id, kind: 'published', group: 'published', label: `What its install published: ${parts.join(' and ')}`, change: 'removed (keep it to reuse the name for a new install)' }
}
const samePublished = (h: Holding, l: PublishLedger) => h.label === publishedHolding('', l).label

export interface CleanChoice {
  /** Remove the proxy host and DNS record too (off by default). */
  published?: boolean
  /** Backup jobs that would back up nothing, which the person ticked to delete. */
  deleteEmptyJobs?: string[]
  /** Leave these kinds alone (the site delete removes its own record and names). */
  except?: HoldingKind[]
  /** Take a fresh service scan first, so addresses are matched against what guests use now (default: yes). */
  freshScan?: boolean
}

export interface CleanResult { id: string; kind: HoldingKind; outcome: 'removed' | 'kept' | 'failed'; words: string }

/**
 * Clean up after a removed guest: HyperProx's own records and vault items, then the cluster's config (an HA entry, the
 * ID in each backup job), and only when chosen what its install published. Read fresh at the moment it runs: a job's
 * list is read again and only this ID is taken out of it. Audited before (fail closed) and after.
 */
export async function cleanUp(g: RemovedGuest, choice: CleanChoice, by: string, d: HoldingDeps): Promise<{ results: CleanResult[]; unread: string[] }> {
  if (choice.freshScan !== false && d.refreshScan) await d.refreshScan().catch(() => undefined)
  const { holdings, unread } = await holdingsFor(g, d)
  const skip = new Set(choice.except ?? [])
  const todo = holdings.filter(h => !skip.has(h.kind) && (h.group !== 'published' || choice.published))
  await d.audit('removed_guest.clean_up', `guest:${g.vmid}`, {
    by, name: g.name, type: g.type, items: todo.map(h => h.id), published: !!choice.published, deleteEmptyJobs: choice.deleteEmptyJobs ?? [],
  })
  const results: CleanResult[] = []
  // Kept on purpose (the name stays for a new install); its install record goes, so HyperProx stops tracking it.
  for (const h of holdings.filter(x => x.group === 'published' && !choice.published && !skip.has(x.kind))) {
    results.push({ id: h.id, kind: h.kind, outcome: 'kept', words: `${h.label.replace(/^What its install published: /, 'Kept ')}, for a new install to use.` })
  }
  const installs = todo.some(h => h.kind === 'published') ? await d.installs.list().catch(() => []) : []
  const sites = todo.some(h => h.kind === 'published') ? await d.sites.list().catch(() => []) : []
  // Published names first (their records say what was made), then HyperProx's records, then the cluster.
  const order: HoldingGroup[] = ['published', 'hyperprox', 'cluster']
  for (const group of order) {
    for (const h of todo.filter(x => x.group === group)) {
      try { results.push({ id: h.id, kind: h.kind, ...(await cleanOne(g, h, choice, by, d, { installs, sites })) }) }
      catch (e: any) { results.push({ id: h.id, kind: h.kind, outcome: 'failed', words: `${h.label}: ${String(e?.message ?? e).slice(0, 300)}` }) }
    }
  }
  await d.audit('removed_guest.cleaned', `guest:${g.vmid}`, { by, results: results.map(r => ({ id: r.id, outcome: r.outcome })) }).catch(() => undefined)
  return { results, unread }
}

async function cleanOne(g: RemovedGuest, h: Holding, choice: CleanChoice, by: string, d: HoldingDeps, ctx: { installs: InstallRow[]; sites: SiteRow[] }): Promise<{ outcome: CleanResult['outcome']; words: string }> {
  const rest = h.id.slice(h.kind.length + 1)
  const done = (words: string) => ({ outcome: 'removed' as const, words })
  switch (h.kind) {
    case 'homepage': return done(await d.homepage.forget(rest, by))
    case 'nextcloud': return done(await d.nextcloud.forget(rest, by))
    case 'install': return done(await d.installs.forget(rest, by))
    case 'site': return done(await d.sites.forget(rest, by))
    case 'auto-connect': {
      const slash = rest.indexOf('/')
      await d.autoConnect.forget([{ plugin: rest.slice(0, slash), key: rest.slice(slash + 1) }])
      return done(`Auto-connect forgot ${rest.slice(slash + 1)}.`)
    }
    case 'plugin-address': {
      const [plugin, setting] = rest.split(':')
      const p = (await d.plugins.addresses()).find(x => x.plugin === plugin && x.setting === setting)
      if (!p) return done(`${h.label}: already gone.`)
      const now = addressesTheirs(g, await d.liveAddresses().catch(() => null))
      if (!now?.has(hostOf(p.value))) return { outcome: 'kept', words: `${p.pluginName}'s address ${p.value} was kept: HyperProx could not confirm no guest uses it now.` }
      await d.plugins.clear(plugin, [setting, ...p.also], by)
      return done(`Cleared ${p.pluginName}'s address ${p.value}${p.also.length ? ' and the key saved for it' : ''}.`)
    }
    case 'deck-address': await d.deck.forget(rest); return done(`The Terminal forgot its address for ${rest}.`)
    case 'remote': {
      const [machineId, provider] = rest.split(':')
      return done(await d.remote.forget(machineId, provider, by))
    }
    case 'wireguard': return done(await d.wireguard.forgetMachine(rest, by))
    case 'move': await d.moves.cancel(rest, by); return done('Cancelled the scheduled move.')
    case 'ha': await d.pve.removeHa(rest); return done(`Took ${rest} out of HA.`)
    case 'backup-job': {
      // Read again now: only this ID leaves the list, whatever else changed since the preview.
      const j = (await d.pve.backupJobs()).find(x => x.id === rest)
      if (!j) return done(`Backup job ${rest} is already gone.`)
      const list = jobVmids(j.vmid)
      if (!list.includes(g.vmid)) return done(`Backup job ${rest} no longer lists ${g.vmid}.`)
      const after = list.filter(v => v !== g.vmid)
      if (!after.length) {
        if (!(choice.deleteEmptyJobs ?? []).includes(rest)) return { outcome: 'kept', words: `Backup job ${rest} lists only ${g.vmid}, so it was left as it is (it will keep failing). Tick it to delete the job.` }
        await d.pve.deleteJob(rest)
        return done(`Deleted backup job ${rest}: it listed only ${g.vmid}.`)
      }
      await d.pve.setJobVmids(rest, after)
      const back = (await d.pve.backupJobs()).find(x => x.id === rest)
      const now = back ? jobVmids(back.vmid) : []
      if (now.includes(g.vmid) || now.join(',') !== after.join(',')) return { outcome: 'failed', words: `Backup job ${rest} did not read back as ${after.join(', ')}.` }
      return done(`Backup job ${rest}: ${list.join(', ')} → ${after.join(', ')} (read back).`)
    }
    case 'published': {
      const [, source, id, idx] = h.id.split(':')
      const ledger = source === 'install' ? ctx.installs.find(j => j.jobId === id)?.ledgers[Number(idx)] : ctx.sites.find(s => s.id === id)?.published
      const owner = source === 'install' ? ctx.installs.find(j => j.jobId === id)?.owner : ctx.sites.find(s => s.id === id)?.owner
      if (!ledger) return done('Its published names are already gone.')
      const lines = await d.publish.cleanup(structuredClone(ledger), owner ?? '')
      const kept = lines.some(l => /kept|could not|failed/i.test(l))
      return { outcome: kept ? 'kept' : 'removed', words: lines.join(' ') || 'Nothing published was left.' }
    }
  }
}

/** The sentence a page shows: "<name> (container <id>) was removed from Proxmox on <date>. HyperProx still has: …". */
export function noticeWords(g: RemovedGuest, holdings: Holding[], fmt: (ms: number) => string = ms => new Date(ms).toISOString().slice(0, 10)): string {
  const who = `${g.name ?? `Guest ${g.vmid}`} (${what(g)} ${g.vmid})`
  const when = g.removedAt ? ` on ${fmt(g.removedAt)}` : ''
  const still = holdings.map(h => h.label)
  return `${who} was removed from Proxmox${when}. HyperProx still has: ${still.join('; ')}.`
}
