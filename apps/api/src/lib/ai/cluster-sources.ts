// =============================================================================
//  HyperProx — knowledge sources for one cluster, and answers across several
//
//  Every source here is bound to one cluster: its load runs inside that cluster's context (runInCluster), so
//  the Proxmox client it reads through is that cluster's pinned client, never the home one by accident. What a
//  source knows: nodes, guests and storage, the last backup run, GPUs (measured or estimated, as the Command
//  center shows them), monitoring, copy jobs (Send files) and the hardware scan. Features that exist for the
//  home cluster only (DNS, proxy hosts, certificates, plug-ins, deploying a service) answer that plainly on a
//  remote instead of answering with home's data.
//
//  Summaries carry no secret, token, address or log line. Nothing here changes anything.
// =============================================================================

import type { AskSource, SourceSummary } from './ask'
import { answerQuestion } from './ask'
import type { ModelCall } from './extract'
import { gatherClusterSummary, clusterSummary, clusterAnswer, gatherBackups, backupSummary, backupAnswer, type ClusterSummary } from './ask-sources'
import { aboutLine, withoutClusterWords, type ClusterRef } from './clusters'
import type { ClusterPanel, GpuRow } from '../clusters/overview'
import type { JobRow } from '../clusters/files'
import type { ScannedNode } from '../clusters/scan'
import type { NodeMonitoring } from '../clusters/store'

type Fetch = <T>(path: string) => Promise<T>

export interface ClusterSourceDeps {
  /** Runs fn as a request for cluster `id` (lib/clusters/context.ts runInCluster). */
  inCluster<T>(id: string, fn: () => Promise<T>): Promise<T>
  /** A strict GET through the client of the cluster the caller is running in (pveFromEnv). */
  fetchStrict: Fetch
  /** The Command center panel for this cluster, read in its context. */
  panel(c: ClusterRef): Promise<ClusterPanel>
  /** Every copy job (Send files), newest first. */
  copies(): Promise<JobRow[]>
  /** The token-only hardware scan (no node login is used). */
  scan(id: string): Promise<{ nodes: ScannedNode[]; summary: string; note: string | null }>
  /** What HyperProx itself set up for monitoring on a remote's nodes (from its row). */
  monitoring(id: string): Record<string, NodeMonitoring>
  /** Cluster names by id, for copy jobs that name the other end. */
  nameOf(id: string): string
  now?: number
}

export const HOME_ONLY_NOTE = 'only available on the home cluster'

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

// ---------------------------------------------------------------------------
//  Status (the Command center panel in words)
// ---------------------------------------------------------------------------

export function statusSummary(c: ClusterRef, p: ClusterPanel, now = Date.now()): SourceSummary {
  if (!p.reachable) {
    // The panel's own error can name an address or a certificate fingerprint: plain words only.
    const why = /certificate/i.test(p.error ?? '') ? 'its certificate changed, so HyperProx sent it nothing' : 'it is not answering right now'
    return { headline: `${c.name}: cannot be read (${why}).`, lines: [`${c.name} cannot be read: ${why}.`], unread: [`${c.name} (${why})`], data: p }
  }
  const pct = (v: number | null) => (v === null ? 'unknown' : `${v}%`)
  const lines = [
    `Nodes: ${p.nodes.online} of ${p.nodes.total} online; quorum ${p.quorum}.`,
    `Guests: ${p.guests.running} of ${p.guests.total} running.`,
    `CPU ${pct(p.cpuPct)}, memory ${pct(p.memPct)}, storage ${pct(p.storagePct)} used.`,
  ]
  if (p.lastBackup) {
    const hours = Math.max(0, Math.round((now - p.lastBackup.at) / 3_600_000))
    lines.push(`Last backup: ${hours < 48 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`}, on ${p.lastBackup.node}, ${p.lastBackup.ok ? 'finished cleanly' : 'did not finish cleanly'}.`)
  } else lines.push('Last backup: none found in the recent task lists.')
  lines.push(`Monitoring: ${p.monitoring ? 'installed' : 'not installed'}.`)
  const att = p.attention.filter(a => a.severity !== 'info')
  if (att.length) lines.push('Needs attention: ' + att.slice(0, 6).map(a => a.title).join('; ') + '.')
  else lines.push('Nothing needs attention.')
  const headline = `${c.name}: ${p.nodes.online}/${p.nodes.total} nodes online, ${p.guests.running}/${p.guests.total} guests running` +
    (att.length ? `, ${plural(att.length, 'thing')} need${att.length === 1 ? 's' : ''} attention.` : ', nothing needs attention.')
  return { headline, lines, data: p }
}

// ---------------------------------------------------------------------------
//  GPUs
// ---------------------------------------------------------------------------

export function gpuLine(g: GpuRow): string {
  const load = g.state === 'measured' && g.load !== null ? `load ${g.load}% (measured)` : `load not measured (${g.stateNote ?? g.state})`
  const video = `${g.capabilityShort} (${g.capabilitySource === 'vainfo' ? 'checked with vainfo' : 'estimated from the model name'})`
  return `${g.node}: ${g.shortName}, ${g.kind}; ${load}; video: ${video}.`
}

export function gpuSummary(c: ClusterRef, p: ClusterPanel): SourceSummary {
  if (!p.reachable) return { headline: `${c.name} GPUs: cannot be read.`, lines: [], unread: [`${c.name}'s GPU list`] }
  if (!p.gpus.length) return { headline: `${c.name}: no GPU found.`, lines: ['No GPU is listed in Proxmox\'s PCI list on any online node.'], data: p }
  const lines = p.gpus.map(gpuLine)
  if (p.gpuNote) lines.push(p.gpuNote)
  return { headline: `${c.name}: ${plural(p.gpus.length, 'GPU')}, ${p.gpus.filter(g => g.state === 'measured').length} measured.`, lines, data: p }
}

// ---------------------------------------------------------------------------
//  Monitoring
// ---------------------------------------------------------------------------

export function monitoringSummary(c: ClusterRef, rec: Record<string, NodeMonitoring>, panel: ClusterPanel | null): SourceSummary {
  if (c.kind === 'home') {
    const on = panel ? (panel.monitoring ? 'is set up' : 'is not set up') : 'is set up from Settings -> Setup checklist'
    return { headline: `Monitoring on ${c.name}: managed in the setup checklist.`, lines: [`Monitoring on the home cluster ${on}; it is managed in Settings -> Setup checklist.`] }
  }
  const nodes = Object.entries(rec ?? {}).filter(([, m]) => m?.nodeExporter)
  if (!nodes.length) return { headline: `Monitoring on ${c.name}: not installed.`, lines: [`Monitoring is not installed on ${c.name}. An admin can install it (Command center -> ${c.name} -> Edit server, step 5), or ask me to.`] }
  const lines = nodes.map(([node, m]) => `${node}: server figures collected` +
    (m.amdGpu ? ', AMD GPU figures on' : '') +
    (m.intelGpu ? `, Intel GPU figures ${m.intelGpu.status === 'measured' ? 'measured' : 'not supported on this GPU'}` : '') +
    (m.nodeExporter!.installedByHyperProx ? ' (installed by HyperProx)' : '') + '.')
  return { headline: `Monitoring on ${c.name}: ${plural(nodes.length, 'node')} monitored.`, lines }
}

// ---------------------------------------------------------------------------
//  Copy jobs (Send files)
// ---------------------------------------------------------------------------

const leaf = (p: string) => p.split('/').filter(Boolean).pop() ?? p

export function copySummary(c: ClusterRef, jobs: JobRow[], nameOf: (id: string) => string): SourceSummary {
  const mine = jobs.filter(j => j.srcCluster === c.id || j.dstCluster === c.id)
  if (!mine.length) return { headline: `Copies for ${c.name}: none.`, lines: [`No copy job has sent files to or from ${c.name}.`] }
  const active = mine.filter(j => j.state === 'queued' || j.state === 'running')
  const lines = mine.slice(0, 8).map(j => {
    const files = Number(j.preview?.files ?? 0)
    return `${leaf(j.srcPath)} from ${nameOf(j.srcCluster)} to ${nameOf(j.dstCluster)}: ${j.state}` +
      (files ? `, ${plural(files, 'file')}` : '') + (j.state === 'failed' && j.error ? ` (${String(j.error).slice(0, 80)})` : '') + '.'
  })
  return { headline: `Copies for ${c.name}: ${active.length} running or queued, ${mine.filter(j => j.state === 'failed').length} failed.`, lines }
}

// ---------------------------------------------------------------------------
//  Hardware scan
// ---------------------------------------------------------------------------

export function hardwareSummary(c: ClusterRef, s: { nodes: ScannedNode[]; summary: string; note: string | null }): SourceSummary {
  const lines = s.nodes.map(n => `${n.node}: ${n.gpus.length ? n.gpus.map(g => `${g.name} (${g.checkedWith === 'vainfo' ? 'checked with vainfo' : 'estimated'})`).join(', ') : 'no GPU'}; node_exporter ${n.nodeExporter}.`)
  if (s.note) lines.push(s.note)
  return { headline: `${c.name} hardware: ${plural(s.nodes.length, 'node')} scanned.`, lines: lines.length ? lines : ['The scan found no node.'] }
}

// ---------------------------------------------------------------------------
//  The sources for one cluster
// ---------------------------------------------------------------------------

/** A source bound to `c`: its load always runs in that cluster's context. */
function bound(c: ClusterRef, d: ClusterSourceDeps, s: Omit<AskSource, 'load'> & { load(): Promise<SourceSummary> }): AskSource {
  return { ...s, load: () => d.inCluster(c.id, () => s.load()) }
}

/** The per-cluster sources (both kinds of cluster). Home adds its home-only sources beside these. */
export function perClusterSources(c: ClusterRef, d: ClusterSourceDeps): AskSource[] {
  let panelP: Promise<ClusterPanel> | null = null
  const panel = () => (panelP ??= d.panel(c))
  const exact = (_p: string, s: SourceSummary) => (s.unread?.length && !s.lines.length ? null : s.lines.join(' '))
  return [
    bound(c, d, {
      id: 'cluster', title: 'Cluster', blurb: 'Proxmox nodes, guests, HA, storage, Ceph',
      aliases: /\b(cluster|nodes?|guests?|containers?|cts?|lxcs?|vms?|virtual machines?|memory|ram|cpu|storage|disk|space|ceph|ha|proxmox|pve|version|running|stopped)\b/,
      load: async () => clusterSummary(await gatherClusterSummary(d.fetchStrict)),
      answer: (p, s) => clusterAnswer(p, s.data as ClusterSummary),
    }),
    bound(c, d, {
      id: 'backups', title: 'Backups', blurb: 'recent backup job results',
      aliases: /\b(backups?|backed up|vzdump|pbs|restore)\b/,
      load: async () => backupSummary(await gatherBackups(d.fetchStrict, d.now), d.now),
      answer: backupAnswer,
    }),
    bound(c, d, {
      id: 'status', title: 'Status', blurb: 'how the cluster is doing, what needs attention',
      aliases: /\b(doing|status|health\w*|okay|ok|attention|problems?|issues?|wrong|alright|all right)\b/,
      load: async () => statusSummary(c, await panel(), d.now),
      answer: exact,
    }),
    bound(c, d, {
      id: 'gpus', title: 'GPUs', blurb: 'GPUs, load measured or not, video support',
      aliases: /\b(gpus?|graphics|video cards?|igpu|nvidia|radeon|hevc|h\.?265|encod\w*|decod\w*|transcod\w*)\b/,
      load: async () => gpuSummary(c, await panel()),
      answer: exact,
    }),
    bound(c, d, {
      id: 'monitoring', title: 'Monitoring', blurb: 'what is monitored',
      aliases: /\b(monitor\w*|node.?exporter|prometheus|grafana|metrics)\b/,
      load: async () => monitoringSummary(c, d.monitoring(c.id), c.kind === 'home' ? await panel().catch(() => null) : null),
      answer: exact,
    }),
    bound(c, d, {
      id: 'copies', title: 'Copies', blurb: 'Send files copy jobs and their state',
      aliases: /\b(cop(y|ies|ying)|send files|transfers?|rsync)\b/,
      load: async () => copySummary(c, await d.copies(), d.nameOf),
      answer: exact,
    }),
    bound(c, d, {
      id: 'hardware', title: 'Hardware scan', blurb: 'what each node has, from the hardware scan',
      aliases: /\b(hardware|scan|pci|devices?)\b/,
      load: async () => hardwareSummary(c, await d.scan(c.id)),
      answer: exact,
    }),
  ]
}

/** On a remote: one source that says plainly which features are the home cluster's only. */
export function homeOnlySource(c: ClusterRef): AskSource {
  const line = `DNS, proxy hosts, certificates, plug-ins, updates and deploying a service are ${HOME_ONLY_NOTE}, so I cannot answer that for ${c.name}.`
  return {
    id: 'home-only', title: 'Home-only features', blurb: 'features the home cluster has and a remote does not',
    aliases: /\b(dns|domains?|zones?|records?|cname|proxy|proxies|reverse proxy|npm|nginx|certs?|certificates?|ssl|tls|https|let'?s ?encrypt|plug-?ins?|home assistant|sonarr|radarr|tautulli|updates?|upgrades?)\b/,
    load: async () => ({ headline: `${c.name}: DNS, proxy, certificates and plug-ins are home-only.`, lines: [line] }),
    answer: () => line,
  }
}

// ---------------------------------------------------------------------------
//  Answering about one or more clusters
// ---------------------------------------------------------------------------

export interface AcrossDeps {
  /** The sources for a cluster, already bound to it. */
  sourcesFor(c: ClusterRef): AskSource[]
  call: ModelCall
  fallback: string
  services?: string[]
  /** Every cluster, to take their names out of the question before sources are picked. */
  clusters: ClusterRef[]
}

/**
 * One answer per cluster, each from that cluster's own sources only, each labelled with the cluster's name, under
 * a line that says which clusters this is about. A question no source of a cluster knows about is answered with
 * that cluster's status, so "how is the remote server doing" never falls through to the deploy planner.
 */
export async function answerAcross(prompt: string, targets: ClusterRef[], d: AcrossDeps): Promise<string> {
  const q = withoutClusterWords(prompt, d.clusters) || prompt
  const parts = await Promise.all(targets.map(async c => {
    const sources = d.sourcesFor(c)
    let a = await answerQuestion(q, { sources, call: d.call, fallback: d.fallback, services: d.services })
    if (a === null) {
      const status = sources.find(s => s.id === 'status')
      if (status) {
        const sum = await status.load().catch(() => null)
        a = sum ? sum.lines.join(' ') : `I could not read ${c.name} just now.`
      } else a = d.fallback
    }
    return { c, a: a.trim() }
  }))
  const head = aboutLine(targets)
  if (parts.length === 1) return `${head}\n${parts[0].a}`
  return `${head}\n` + parts.map(({ c, a }) => `${c.name}: ${a}`).join('\n')
}
