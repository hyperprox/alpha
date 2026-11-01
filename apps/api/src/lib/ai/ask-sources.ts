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
import type { Plugin } from '../plugin-host'
import { APP_VERSION } from '../version'

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

export interface BackupRun { vmid: string; node: string; ok: boolean; status: string; endtime: number }

export async function gatherBackups(fetchStrict: Fetch, now = Date.now()): Promise<BackupRun[]> {
  const tasks = await fetchStrict<any[]>('/cluster/tasks')
  const day = now / 1000 - 3 * 86400
  return tasks.filter(t => t?.type === 'vzdump' && t.endtime && t.endtime > day)
    .map(t => ({ vmid: String(t.id ?? ''), node: String(t.node ?? ''), ok: t.status === 'OK', status: String(t.status ?? ''), endtime: Number(t.endtime) }))
    .sort((a, b) => b.endtime - a.endtime)
}

export function backupSummary(runs: BackupRun[]): SourceSummary {
  if (!runs.length) return { headline: 'Backups: no backup job finished in the last 3 days.', lines: ['No backup job finished in the last 3 days.'], data: runs }
  const last = runs[0].endtime
  const latest = runs.filter(r => last - r.endtime < 6 * 3600)          // the most recent run of the nightly job
  const bad = latest.filter(r => !r.ok)
  const when = new Date(last * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  const lines = [`Last backups finished ${when}: ${latest.length - bad.length} ok, ${bad.length} failed.`]
  if (bad.length) lines.push('Failed guests: ' + bad.slice(0, 10).map(r => `${r.vmid || r.node} (${r.status.slice(0, 60)})`).join(', '))
  return { headline: `Backups: last run ${when}, ${bad.length ? bad.length + ' failed' : 'all ok'}.`, lines, data: runs }
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
  const d = s.data as { soon: CertLite[]; certs: CertLite[] }
  const p = prompt.toLowerCase()
  if (!/\b(expir\w*|renew\w*|soon|valid|how long)\b/.test(p)) return null
  if (!d.soon.length) return 'No certificate expires within the next 30 days.'
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
}

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
      aliases: /\b(dns|domains?|zones?|records?|cname|godaddy|subdomain)\b/,
      load: async () => {
        const unread = fp.filter(p => p === 'zones' || p.startsWith('records:')).map(p => p === 'zones' ? 'the DNS zone list' : `the records of ${p.slice(8)}`)
        const lines = d.facts.zones.map(z => `${z}: ${d.facts.records[z]?.length ?? 'unknown'} records`)
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
      load: async () => d.unlocked() ? certSummary(await d.certs()) : { headline: 'Certificates: locked.', lines: [], locked: true },
      answer: certAnswer,
    },
    {
      id: 'backups', title: 'Backups', blurb: 'recent backup job results',
      aliases: /\b(backups?|backed up|vzdump|pbs|snapshots?|restore)\b/,
      load: async () => backupSummary(await gatherBackups(d.fetchStrict, d.now)),
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
}

/** One source per plug-in. A plug-in without a `summary` hook is listed but has nothing to read. */
export function pluginSources(d: PluginDeps): AskSource[] {
  return d.plugins.map(p => {
    const m = p.manifest
    const word = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim()
    const names = [...new Set([word(m.id), word(m.name), ...word(m.name).split(/\s+/).filter(w => w.length > 3)])].filter(Boolean)
    const extra: Record<string, string> = {
      'home-assistant': 'home|lights?|switch(es)?|doors?|locks?|sensors?|temperature|garage|thermostat|automations?',
      mikrotik: 'router|wan|bandwidth|internet|firewall',
      plex: 'plex|tautulli|streams?|watching|transcod\\w*',
      arrstack: 'sonarr|radarr|prowlarr|downloads?|queue|movies?|shows?',
    }
    const alias = [...names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), extra[m.id]].filter(Boolean).join('|')
    return {
      id: `plugin:${m.id}`, title: m.name, blurb: m.description.split(/[.;]/)[0].slice(0, 60),
      aliases: new RegExp(`\\b(${alias})\\b`, 'i'), matchLines: true,
      load: async (): Promise<SourceSummary> => {
        if (!p.summary) return { headline: `${m.name}: no summary available.`, lines: [], unread: [`${m.name} (it offers no summary)`] }
        if (!d.unlocked()) return { headline: `${m.name}: locked.`, lines: [], locked: true }
        const r = await d.run(p)
        return { headline: `${r.title}: ${r.lines[0] ?? 'nothing to report'}`, lines: r.lines.slice(0, 40).map(l => l.slice(0, 160)) }
      },
    }
  })
}

export { LOCKED_NOTE }
