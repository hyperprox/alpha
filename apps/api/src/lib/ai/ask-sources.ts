// =============================================================================
//  HyperProx — the knowledge sources behind read-only questions
//
//  Each reads a short summary through access HyperProx already has, and never
//  includes a secret, token, password, webhook URL or log. A source that needs
//  the vault reports "locked" instead of failing.
// =============================================================================

import type { AskSource, SourceSummary } from './ask'
import { LOCKED_NOTE } from './ask'
import type { TemplateFacts } from './templates/types'
import type { Plugin, PluginDetail } from '../plugin-host'
import { visualLines } from './visual-lines'
import { APP_VERSION } from '../version'
import { hasRole, type Role } from '../roles'

// ---------------------------------------------------------------------------
//  Cluster (Proxmox, HA, storage, Ceph)
// ---------------------------------------------------------------------------

export interface ClusterSummary {
  nodes: Array<{ node: string; online: boolean; cores: number; memUsedMb: number; memTotalMb: number }>
  guests: Array<{ vmid: number; node: string; type: 'lxc' | 'qemu'; name: string; running: boolean }>
  storages: Array<{ storage: string; node: string; shared: boolean; usedPct: number; totalGb: number }>
  ceph: string | null
  ha: { total: number; problems: string[] } | null
  version: string
  /** Sources that could not be read: resources. */
  partial: string[]
}

type Fetch = <T>(path: string) => Promise<T>

export async function gatherClusterSummary(fetchStrict: Fetch): Promise<ClusterSummary> {
  const [resR, cephR, haR] = await Promise.allSettled([
    fetchStrict<any[]>('/cluster/resources'),
    fetchStrict<any>('/cluster/ceph/status'),
    fetchStrict<any[]>('/cluster/ha/status/current'),
  ])
  const partial: string[] = []
  const res = resR.status === 'fulfilled' && Array.isArray(resR.value) ? resR.value : (partial.push('resources'), [])
  const out: ClusterSummary = { nodes: [], guests: [], storages: [], ceph: null, ha: null, version: APP_VERSION.version, partial }
  for (const r of res) {
    if (r?.type === 'node') {
      out.nodes.push({ node: String(r.node), online: r.status === 'online', cores: Number(r.maxcpu ?? 0),
        memUsedMb: Math.round(Number(r.mem ?? 0) / 1048576), memTotalMb: Math.round(Number(r.maxmem ?? 0) / 1048576) })
    } else if ((r?.type === 'lxc' || r?.type === 'qemu') && r.vmid && !r.template) {
      out.guests.push({ vmid: Number(r.vmid), node: String(r.node), type: r.type, name: String(r.name ?? ''), running: r.status === 'running' })
    } else if (r?.type === 'storage' && Number(r.maxdisk) > 0) {
      out.storages.push({ storage: String(r.storage), node: String(r.node), shared: Boolean(r.shared),
        usedPct: Math.round(100 * Number(r.disk ?? 0) / Number(r.maxdisk)), totalGb: Math.round(Number(r.maxdisk) / 1073741824) })
    }
  }
  if (cephR.status === 'fulfilled' && typeof cephR.value?.health?.status === 'string') out.ceph = cephR.value.health.status
  if (haR.status === 'fulfilled' && Array.isArray(haR.value)) {
    const svc = haR.value.filter(x => x?.type === 'service')
    out.ha = { total: svc.length, problems: svc.filter(x => ['error', 'fence', 'recovery'].includes(String(x.state))).map(x => String(x.sid)) }
  }
  return out
}

function uniqueStorages(s: ClusterSummary) {
  const seen = new Set<string>()
  return s.storages.filter(x => { if (!x.shared) return true; if (seen.has(x.storage)) return false; seen.add(x.storage); return true })
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`
const gb = (mb: number) => (mb / 1024).toFixed(1)

/** An exact answer for the most common cluster questions, or null. */
export function clusterAnswer(prompt: string, s: ClusterSummary): string | null {
  const p = prompt.toLowerCase().replace(/[?.!]+\s*$/, '')
  const CT = /\b(containers?|cts?|lxcs?)\b/, VM = /\b(vms?|virtual machines?)\b/, GUEST = /\b(guests?|machines?|workloads?)\b/
  const MANY = /\bhow many\b|\bnumber of\b|\bcount\b/
  const STATE = /\b(running|stopped|powered off|off|down)\b/
  const MEM = /\b(memory|ram)\b/
  const FREE = /\b(free|available|spare|left|remaining|much)\b/
  const STORE = /\b(storage|storages|disk space|disk usage|space)\b/
  const USE = /\b(use|used|usage|full|free|left|available|much)\b/
  let kind: 'guests' | 'memory' | 'storage' | null = null
  if (MANY.test(p) && (CT.test(p) || VM.test(p) || GUEST.test(p))) kind = 'guests'
  else if (STATE.test(p) && (CT.test(p) || VM.test(p) || GUEST.test(p)) && /\b(which|what|list|how)\b/.test(p)) kind = 'guests'
  else if (MEM.test(p) && FREE.test(p)) kind = 'memory'
  else if (STORE.test(p) && USE.test(p)) kind = 'storage'
  if (!kind) return null

  if (s.partial.includes('resources')) return 'I could not read the guest, node and storage list from the cluster just now, so I cannot answer that.'
  if (kind === 'guests') {
    const ct = s.guests.filter(g => g.type === 'lxc'), vm = s.guests.filter(g => g.type === 'qemu')
    const part = (l: ClusterSummary['guests'], one: string, many: string) =>
      `${plural(l.length, one, many)}, ${l.filter(g => g.running).length} running and ${l.filter(g => !g.running).length} stopped`
    const wantCt = CT.test(p), wantVm = VM.test(p)
    if (wantCt && !wantVm) return `You have ${part(ct, 'container', 'containers')}.`
    if (wantVm && !wantCt) return `You have ${part(vm, 'VM', 'VMs')}.`
    const run = s.guests.filter(g => g.running).length
    return `You have ${plural(s.guests.length, 'guest')}: ${plural(ct.length, 'container')} and ${plural(vm.length, 'VM')}. ` +
           `${run} ${run === 1 ? 'is' : 'are'} running and ${s.guests.length - run} stopped.`
  }
  if (kind === 'memory') {
    const on = s.nodes.filter(n => n.online)
    if (!on.length) return 'I could not find an online node to read memory from.'
    const free = on.reduce((a, n) => a + n.memTotalMb - n.memUsedMb, 0), total = on.reduce((a, n) => a + n.memTotalMb, 0)
    return `${gb(free)} GB of ${gb(total)} GB memory is free across ${plural(on.length, 'online node')}: ` +
           `${on.map(n => `${n.node} ${gb(n.memTotalMb - n.memUsedMb)} GB`).join(', ')}.`
  }
  const st = uniqueStorages(s)
  if (!st.length) return 'I found no storage with a size to report.'
  return `Storage used: ${st.map(x => `${x.storage} ${x.usedPct}%`).join(', ')}.`
}

export function clusterSummary(s: ClusterSummary): SourceSummary {
  const ct = s.guests.filter(g => g.type === 'lxc'), vm = s.guests.filter(g => g.type === 'qemu')
  const run = (l: ClusterSummary['guests']) => `${l.filter(g => g.running).length} running, ${l.filter(g => !g.running).length} stopped`
  const lines = [`HyperProx ${s.version}`]
  if (s.nodes.length) lines.push('Nodes: ' + s.nodes.map(n => n.online
    ? `${n.node} online, ${n.cores} CPU, memory ${gb(n.memUsedMb)}/${gb(n.memTotalMb)} GB used` : `${n.node} OFFLINE`).join('; '))
  lines.push(`Guests: ${s.guests.length} total; ${ct.length} containers (${run(ct)}); ${vm.length} VMs (${run(vm)})`)
  if (s.nodes.length) lines.push('Guests per node: ' + s.nodes.map(n => {
    const g = s.guests.filter(x => x.node === n.node); return `${n.node} ${g.length} (${g.filter(x => x.running).length} running)`
  }).join('; '))
  const stopped = s.guests.filter(g => !g.running)
  if (stopped.length) lines.push('Stopped: ' + stopped.slice(0, 10).map(g => `${g.name || g.vmid} (${g.vmid})`).join(', ') + (stopped.length > 10 ? `, and ${stopped.length - 10} more` : ''))
  const st = uniqueStorages(s)
  if (st.length) lines.push('Storage used: ' + st.map(x => `${x.storage} ${x.usedPct}% of ${x.totalGb} GB`).join('; '))
  if (s.ha) lines.push(`HA: ${s.ha.total} resources` + (s.ha.problems.length ? `; in trouble: ${s.ha.problems.join(', ')}` : '; none in trouble'))
  if (s.ceph) lines.push(`Ceph health: ${s.ceph}`)
  const offline = s.nodes.filter(n => !n.online).length
  const headline = s.partial.length ? 'Cluster: could not be read.'
    : `Cluster: ${s.nodes.length - offline}/${s.nodes.length} nodes online, ${s.guests.filter(g => g.running).length}/${s.guests.length} guests running` +
      (s.ceph ? `, Ceph ${s.ceph}` : '') + '.'
  return { headline, lines, unread: s.partial.length ? ['the guest, node and storage list'] : undefined, data: s }
}

// ---------------------------------------------------------------------------
//  Backups (PVE vzdump tasks)
// ---------------------------------------------------------------------------

export interface BackupRun { vmid: string; node: string; ok: boolean; status: string }

export interface BackupReport {
  /** Unix seconds: when the most recent scheduled run began, and when its last node finished (null while running). */
  start: number | null
  end: number | null
  /** Seconds the nodes' clocks are ahead of UTC, read from their own task logs; null when it could not be told. */
  offset: number | null
  /** One row per guest across every node of that run. */
  guests: BackupRun[]
  /** Guests whose backup had started but not finished, on a node whose task is still going. */
  running: number
  /** Nodes whose tasks or logs could not be read. */
  unread: string[]
}

const enc = encodeURIComponent
const RUN_WINDOW_S = 20 * 60          // the nodes start one scheduled run within seconds of each other
const LOOKBACK_S = 3 * 86400

const localSeconds = (stamp: string) => Date.parse(stamp.replace(' ', 'T') + 'Z') / 1000

/** Cuts at a word boundary, never mid-word; adds an ellipsis only when something was cut. */
export function shorten(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const at = cut.lastIndexOf(' ')
  return (at > max / 2 ? cut.slice(0, at) : cut.replace(/\S*$/, '')).replace(/[\s,;:(-]+$/, '') + '\u2026'
}

/** Per-guest results from one node's vzdump task log. */
export function parseBackupLog(node: string, lines: string[], finished: boolean, status: string): { guests: BackupRun[]; running: number; localEnd: string | null } {
  const guests: BackupRun[] = []
  const started = new Set<string>(), done = new Set<string>()
  let localEnd: string | null = null
  for (const t of lines) {
    let m: RegExpExecArray | null
    if ((m = /^INFO: Starting Backup of VM (\d+)/.exec(t))) started.add(m[1])
    else if ((m = /^INFO: Finished Backup of VM (\d+)/.exec(t))) { done.add(m[1]); guests.push({ vmid: m[1], node, ok: true, status: 'OK' }) }
    else if ((m = /^ERROR: Backup of VM (\d+) failed\s*-?\s*(.*)$/.exec(t))) { done.add(m[1]); guests.push({ vmid: m[1], node, ok: false, status: shorten(m[2] || 'failed', 60) }) }
    else if ((m = /^INFO: Backup finished at (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/.exec(t))) localEnd = m[1]
  }
  let running = 0
  for (const v of started) if (!done.has(v)) {
    if (finished) guests.push({ vmid: v, node, ok: false, status: 'did not finish' })
    else running++
  }
  // A task that failed as a whole with no guest named: one failure for the node, not silence.
  if (finished && !/^(OK|WARNINGS)/.test(status) && !guests.some(g => !g.ok)) guests.push({ vmid: '', node, ok: false, status: shorten(status || 'failed', 60) })
  return { guests, running, localEnd }
}

/**
 * The most recent scheduled backup run across ALL nodes. Each node runs its own vzdump task for the job (its
 * id is empty, so /cluster/tasks cannot say which guests were in it, and it lists only the newest tasks of
 * the whole cluster), so each node's recent vzdump tasks are listed and the log of every task in the run is
 * read for its per-guest results.
 */
export async function gatherBackups(fetchStrict: Fetch, now = Date.now()): Promise<BackupReport> {
  const nodes = (await fetchStrict<any[]>('/nodes')).map(n => String(n?.node ?? '')).filter(Boolean)
  const unread: string[] = []
  const lists = await Promise.all(nodes.map(async node => {
    try { return (await fetchStrict<any[]>(`/nodes/${enc(node)}/tasks?typefilter=vzdump&limit=10`)).map(t => ({ ...t, node })) }
    catch { unread.push(node); return [] }
  }))
  const since = now / 1000 - LOOKBACK_S
  const tasks = lists.flat().filter(t => t?.type === 'vzdump' && Number(t.starttime) > since && t.upid)
  if (!tasks.length) return { start: null, end: null, offset: null, guests: [], running: 0, unread }
  const start = Math.max(...tasks.map(t => Number(t.starttime)))
  const run = tasks.filter(t => start - Number(t.starttime) <= RUN_WINDOW_S)

  const guests: BackupRun[] = []
  let running = 0, end: number | null = 0, offset: number | null = null
  await Promise.all(run.map(async t => {
    const node = String(t.node), finished = !!t.endtime
    let log: string[]
    try { log = (await fetchStrict<any[]>(`/nodes/${enc(node)}/tasks/${enc(String(t.upid))}/log?limit=0`)).map(x => String(x?.t ?? '')) }
    catch { unread.push(node); return }
    const r = parseBackupLog(node, log, finished, String(t.status ?? ''))
    guests.push(...r.guests); running += r.running
    if (!finished) end = null
    else if (end !== null) end = Math.max(end, Number(t.endtime))
    if (finished && r.localEnd && offset === null) {
      const diff = localSeconds(r.localEnd) - Number(t.endtime), q = Math.round(diff / 900) * 900
      if (Math.abs(diff - q) < 300) offset = q
    }
  }))
  guests.sort((a, b) => Number(a.vmid) - Number(b.vmid))
  return { start, end: end || null, offset, guests, running, unread: [...new Set(unread)] }
}

export function backupSummary(r: BackupReport, now = Date.now()): SourceSummary {
  const unread = r.unread.length ? [`the backup tasks of ${r.unread.join(', ')}`] : undefined
  if (r.start === null || (!r.guests.length && !r.running)) {
    return r.unread.length && r.start === null
      ? { headline: 'Backups: could not be read.', lines: ['No backup run could be read.'], unread, data: r }
      : { headline: 'Backups: no backup job finished in the last 3 days.', lines: ['No backup job finished in the last 3 days.'], unread, data: r }
  }
  const at = (t: number) => t + (r.offset ?? 0)
  const clock = (t: number) => new Date(at(t) * 1000).toISOString().slice(11, 16) + (r.offset === null ? ' UTC' : '')
  const day = (t: number) => new Date(at(t) * 1000).toISOString().slice(0, 10)
  const label = now / 1000 - r.start < 30 * 3600 ? `Last night's backup (${clock(r.start)})` : `Last backup (${day(r.start)} ${clock(r.start)})`
  const bad = r.guests.filter(g => !g.ok)
  const okN = r.guests.length - bad.length
  const lines = [r.end === null
    ? `${label} is still running: ${plural(okN, 'guest')} done, ${bad.length} failed so far, ${r.running} in progress.`
    : `${label}: ${plural(okN, 'guest')} backed up, ${bad.length} failed, finished ${clock(r.end)}.`]
  if (bad.length) lines.push('Failed: ' + bad.slice(0, 10).map(g => `${g.vmid ? 'guest ' + g.vmid : g.node} (${g.status})`).join(', '))
  const headline = r.end === null ? `Backups: running, ${okN} guests done.` : `Backups: ${okN} guests ok, ${bad.length} failed (${clock(r.start)} run).`
  return { headline, lines, unread, data: r }
}

export function backupAnswer(prompt: string, s: SourceSummary): string | null {
  if (!/\b(work(ed)?|succe\w+|fail\w*|ok|okay|run|ran|last|good|complete\w*|finish\w*)\b/i.test(prompt)) return null
  return s.lines.join(' ')
}

// ---------------------------------------------------------------------------
//  Certificates
// ---------------------------------------------------------------------------

export interface CertLite { names: string[]; daysLeft: number | null; notAfter: string | null; verdict: string; source: string }

export function certSummary(certs: CertLite[]): SourceSummary {
  const dated = certs.filter(c => c.daysLeft !== null).sort((a, b) => a.daysLeft! - b.daysLeft!)
  const soon = dated.filter(c => c.daysLeft! <= 30)
  const name = (c: CertLite) => c.names[0] ?? c.source
  const lines = [`${certs.length} certificates; ${soon.length} expire within 30 days; ${certs.filter(c => c.verdict === 'critical' || c.verdict === 'error').length} critical or in error.`]
  for (const c of dated.slice(0, 6)) lines.push(`${name(c)}: ${c.daysLeft} days left (${(c.notAfter ?? '').slice(0, 10)})`)
  return { headline: `Certificates: ${certs.length}, ${soon.length} expiring within 30 days.`, lines, data: { certs, soon } }
}

export function certAnswer(prompt: string, s: SourceSummary): string | null {
  const d = s.data as { soon: CertLite[]; certs: CertLite[]; adminOnly?: boolean }
  if (d?.adminOnly) return ADMIN_ONLY_CERTS
  const p = prompt.toLowerCase()
  if (!/\b(expir\w*|renew\w*|soon|valid|how long)\b/.test(p)) return null
  // A certificate named in the question: its own date.
  const named = d.certs.filter(c => c.daysLeft !== null && c.names.some(n => n && p.includes(n.toLowerCase())))
  if (named.length) return named.slice(0, 4).map(c => `${c.names[0]} expires in ${c.daysLeft} days (${(c.notAfter ?? '').slice(0, 10)}).`).join(' ')
  if (!d.soon.length) {
    // "When does my certificate expire": the next one, so the answer is a date and not only "not soon".
    const next = d.certs.filter(c => c.daysLeft !== null).sort((a, b) => a.daysLeft! - b.daysLeft!)[0]
    return 'No certificate expires within the next 30 days.' +
      (next && /\bwhen\b/.test(p) ? ` The next is ${next.names[0] ?? next.source} in ${next.daysLeft} days (${(next.notAfter ?? '').slice(0, 10)}).` : '')
  }
  return `${plural(d.soon.length, 'certificate')} expire${d.soon.length === 1 ? 's' : ''} within 30 days: ` +
    d.soon.slice(0, 8).map(c => `${c.names[0] ?? c.source} in ${c.daysLeft} days`).join(', ') + '.'
}

// ---------------------------------------------------------------------------
//  Building the list
// ---------------------------------------------------------------------------

export interface CoreDeps {
  fetchStrict: Fetch
  facts: TemplateFacts
  certs(): Promise<CertLite[]>
  unlocked(): boolean
  now?: number
  /** Who is asking. Given and below admin: certificates are not read (the Certificates page is admin only). */
  role?: Role
}

export const ADMIN_ONLY_CERTS = 'The Certificates page is admin only, so I show certificates to admins only.'

export function coreSources(d: CoreDeps): AskSource[] {
  const fp = d.facts.partial
  return [
    {
      id: 'cluster', title: 'Cluster', blurb: 'Proxmox nodes, guests, HA, storage, Ceph',
      aliases: /\b(cluster|nodes?|guests?|containers?|cts?|lxcs?|vms?|virtual machines?|memory|ram|cpu|storage|disk|space|ceph|ha|proxmox|pve|version|running|stopped)\b/,
      load: async () => clusterSummary(await gatherClusterSummary(d.fetchStrict)),
      answer: (p, s) => clusterAnswer(p, s.data as ClusterSummary),
    },
    {
      id: 'dns', title: 'DNS', blurb: 'zones and records',
      aliases: /\b(dns|domains?|zones?|records?|cname|godaddy|cloudflare|subdomain)\b/,
      load: async () => {
        const unread = fp.filter(p => p === 'zones' || p.startsWith('records:')).map(p => p === 'zones' ? 'the DNS zone list' : `the records of ${p.slice(8)}`)
        const prov = d.facts.zoneProvider ?? {}
        const label: Record<string, string> = { godaddy: 'GoDaddy', cloudflare: 'Cloudflare' }
        const lines = d.facts.zones.map(z => `${z}${prov[z] ? ` (${label[prov[z]] ?? prov[z]})` : ''}: ${d.facts.records[z]?.length ?? 'unknown'} records`)
        return { headline: `DNS: ${d.facts.zones.length} zones.`, lines: lines.length ? lines : ['No DNS zones are configured.'], unread: unread.length ? unread : undefined }
      },
      answer: (p, s) => /\bhow many\b.*\b(zones?|domains?)\b/i.test(p) ? s.headline.replace('DNS: ', 'You have ') : null,
    },
    {
      id: 'proxy', title: 'Proxy hosts', blurb: 'reverse proxy hosts',
      aliases: /\b(proxy|proxies|reverse proxy|npm|nginx|hosts?|websites?|sites?|published)\b/,
      load: async () => {
        const n = d.facts.proxyHosts.length
        const unread = fp.includes('proxy') ? ['the proxy host list'] : undefined
        return { headline: d.facts.hasReverseProxy ? `Proxy: ${n} hosts.` : 'Proxy: not configured.',
          lines: d.facts.hasReverseProxy ? [`${n} proxy hosts`, ...d.facts.proxyHosts.slice(0, 15)] : ['No reverse proxy is configured.'], unread }
      },
      answer: (p, s) => /\bhow many\b.*\b(proxy|hosts?|sites?|websites?)\b/i.test(p) && !s.unread ? s.lines[0] + '.' : null,
    },
    {
      id: 'certs', title: 'Certificates', blurb: 'expiry and renewal',
      aliases: /\b(certs?|certificates?|ssl|tls|https|expir\w*|renew\w*|let'?s ?encrypt)\b/,
      load: async () => d.role && !hasRole(d.role, 'admin') ? { headline: 'Certificates: admins only.', lines: [ADMIN_ONLY_CERTS], data: { certs: [], soon: [], adminOnly: true } }
        : d.unlocked() ? certSummary(await d.certs()) : { headline: 'Certificates: locked.', lines: [], locked: true },
      answer: certAnswer,
    },
    {
      id: 'backups', title: 'Backups', blurb: 'recent backup job results',
      aliases: /\b(backups?|backed up|vzdump|pbs|snapshots?|restore)\b/,
      load: async () => backupSummary(await gatherBackups(d.fetchStrict, d.now), d.now),
      answer: backupAnswer,
    },
  ]
}

// ---------------------------------------------------------------------------
//  Plug-ins
// ---------------------------------------------------------------------------

export interface PluginDeps {
  plugins: Plugin[]
  unlocked(): boolean
  /** Runs a plug-in's summary hook with its brokered, read-only context. */
  run(p: Plugin): Promise<{ title: string; lines: string[] }>
  /** Runs its detail hook the same way: a plug-in with no summary is read from its page's `visual` reading. */
  detail?(p: Plugin): Promise<PluginDetail>
  /** Plug-in ids that have a source of their own (QNAP: lib/ai/home-sources.ts), so they are not read twice. */
  skip?: string[]
}

/** One source per plug-in. A plug-in without a `summary` hook is listed but has nothing to read. */
export function pluginSources(d: PluginDeps): AskSource[] {
  return d.plugins.filter(p => !(d.skip ?? []).includes(p.manifest.id)).map(p => {
    const m = p.manifest
    const word = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim()
    const names = [...new Set([word(m.id), word(m.name), ...word(m.name).split(/\s+/).filter(w => w.length > 3)])].filter(Boolean)
    const extra: Record<string, string> = {
      'home-assistant': 'home|lights?|switch(es)?|doors?|locks?|sensors?|temperature|garage|thermostat|automations?',
      mikrotik: 'router|wan|bandwidth|internet|firewall',
      asus: 'asus|merlin|asuswrt|router|wi-?fi|wireless|ssid|wan|internet',
      plex: 'plex|tautulli|streams?|watching|transcod\\w*',
      arrstack: 'sonarr|radarr|lidarr|prowlarr|downloads?|queue|movies?|shows?|music|albums?|artists?',
    }
    const alias = [...names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), extra[m.id]].filter(Boolean).join('|')
    return {
      id: `plugin:${m.id}`, title: m.name, blurb: shorten(m.description.split(/[.;]/)[0], 60),
      aliases: new RegExp(`\\b(${alias})\\b`, 'i'), matchLines: true,
      load: async (): Promise<SourceSummary> => {
        const nothing = { headline: `${m.name}: connected, nothing to summarise.`, lines: [], unread: [`${m.name} (it offers no summary)`], noSummary: true }
        if (!p.summary && !(p.detail && d.detail)) return nothing
        if (!d.unlocked()) return { headline: `${m.name}: locked.`, lines: [], locked: true }
        if (!p.summary) {
          // The page's own figures (Plex now playing, the arr pipeline, Unmanic, the router), said by code.
          const v = (await d.detail!(p)).visual
          if (!v) return nothing
          const lines = visualLines(v).slice(0, 40).map(l => shorten(l, 200))
          return { headline: shorten(`${m.name}: ${lines[0] ?? 'nothing to report'}`, 80), lines }
        }
        const r = await d.run(p)
        // The plug-in's own first line is its headline ("12 entities, 1 unavailable"); the catalogue description never is.
        return { headline: shorten(`${r.title}: ${r.lines[0] ?? 'nothing to report'}`, 80), lines: r.lines.slice(0, 40).map(l => shorten(l, 160)) }
      },
    }
  })
}

export { LOCKED_NOTE }
