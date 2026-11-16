// =============================================================================
//  HyperProx — K3s page: the shapes the API answers and the pure logic on them
//
//  Kept apart from the components so the words and the tones can be tested
//  without rendering anything.
// =============================================================================

export type FixAction = 'restart' | 'rollback' | 'scale' | 'delete-pod' | 'cordon' | 'uncordon' | 'drain' | 'logs' | 'add-agent'
export interface Fix {
  action: FixAction; label: string; confirm?: string
  target: { kind: 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'Pod' | 'Node'; namespace?: string; name: string; container?: string }
}
export interface NodeRow {
  name: string; ready: boolean; reason: string | null; roles: string[]; version: string | null; ip: string | null; os: string | null
  unschedulable: boolean; pressure: string[]; pods: number
  cpu: { capMilli: number | null; usedMilli: number | null }; mem: { capBytes: number | null; usedBytes: number | null }
  fixes: Fix[]
}
export interface NamespaceRow { name: string; phase: string; pods: number; problems: number }
export interface WorkloadRow {
  kind: 'Deployment' | 'StatefulSet' | 'DaemonSet'; namespace: string; name: string
  desired: number; ready: number; updated: number; available: number; images: string[]; problem: string | null; fixes: Fix[]
}
export type PodState = 'crashloop' | 'image' | 'pending' | 'restarting' | 'failed' | 'oom' | 'not-ready'
export interface ProblemPod {
  namespace: string; name: string; node: string | null; state: PodState; reason: string; message: string
  container: string | null; restarts: number; since: number | null; owner: { kind: string; name: string } | null
  lastLines?: string[]; fixes: Fix[]
}
export interface EventRow { namespace: string; kind: string; name: string; reason: string; message: string; count: number; last: number | null }
export interface ServiceRow { namespace: string; name: string; type: string; clusterIP: string | null; external: string[]; ports: string[] }
export interface IngressRow { namespace: string; name: string; hosts: string[]; addresses: string[]; tls: boolean; paths: string[] }
export interface Reading {
  fetchedAt: string
  version: { current: string | null; latest: string | null; upgrade: string | null }
  nodes: NodeRow[]; namespaces: NamespaceRow[]; workloads: WorkloadRow[]; problems: ProblemPod[]
  events: EventRow[]; services: ServiceRow[]; ingresses: IngressRow[]
  counts: { pods: number; running: number; problems: number; warnings: number }
  health: { state: 'ok' | 'attention' | 'bad'; reasons: string[] }
  missing: string[]
}
export interface Cluster { id: string; name: string; url?: string; via: 'catalogue' | 'auto-connect' | 'person'; guest: { kind: string; vmid: number } | null; agents: Array<{ kind: string; vmid: number }>; caFingerprint: string; hasJoinToken?: boolean }
export interface Waiting { key: string; label: string; message: string; at: number }
export interface DrainPlan { node: string; move: string[]; stay: string[]; lost: string[]; localData: string[] }

export const STATE_WORD: Record<PodState, string> = {
  crashloop: 'Crash loop', oom: 'Out of memory', image: 'Image cannot be pulled', pending: 'Pending', restarting: 'Restarting', failed: 'Failed', 'not-ready': 'Not ready',
}
export const STATE_TONE: Record<PodState, 'bad' | 'warn'> = {
  crashloop: 'bad', oom: 'bad', image: 'bad', failed: 'bad', pending: 'warn', restarting: 'warn', 'not-ready': 'warn',
}

/** A share 0..1, or null when either side is unknown. */
export function share(used: number | null, cap: number | null): number | null {
  return used === null || cap === null || cap <= 0 ? null : Math.max(0, Math.min(1, used / cap))
}
export function cores(milli: number | null): string { return milli === null ? '—' : milli >= 1000 ? `${(milli / 1000).toFixed(milli % 1000 ? 1 : 0)} cores` : `${milli}m` }
export function gib(b: number | null): string { return b === null ? '—' : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(b / 1024 ** 2)} MiB` }

export function healthWord(h: Reading['health']): string {
  return h.state === 'ok' ? 'Healthy' : h.state === 'attention' ? 'Needs a look' : 'Not healthy'
}

export function ago(ms: number | null, now = Date.now()): string {
  if (!ms) return '—'
  const s = Math.max(0, Math.round((now - ms) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`
}

/** Fixes a viewer may see as buttons: none change anything without an admin, so below admin only "logs" is hidden too. */
export function visibleFixes(fixes: Fix[], admin: boolean): Fix[] {
  return admin ? fixes : []
}

/** What the confirmation says before an action runs. */
export function confirmText(f: Fix, replicas?: number): string {
  if (f.action === 'scale') return `${f.target.name} goes to ${replicas ?? '?'} replica${replicas === 1 ? '' : 's'}. ${replicas === 0 ? 'Every pod of it stops until you scale it up again.' : ''}`.trim()
  return f.confirm ?? `${f.label}: ${f.target.name}.`
}

/** Words for a drain plan: what moves, what stays and what is lost for good. */
export function drainWords(p: DrainPlan): string[] {
  const out = [`${p.move.length} pod${p.move.length === 1 ? '' : 's'} move to other nodes (their controllers start them again there).`]
  if (p.stay.length) out.push(`${p.stay.length} DaemonSet pod${p.stay.length === 1 ? '' : 's'} stay: one runs on every node.`)
  if (p.localData.length) out.push(`${p.localData.length} use an emptyDir: whatever they kept there is lost when they move.`)
  if (p.lost.length) out.push(`${p.lost.length} ha${p.lost.length === 1 ? 's' : 've'} no controller and will be deleted for good: ${p.lost.slice(0, 5).join(', ')}.`)
  out.push('The node is cordoned first, so nothing new is scheduled there. Uncordon it when you are done.')
  return out
}

/** The address an ingress or LoadBalancer service is reached on, as a link when it is a plain host. */
export function ingressLinks(i: IngressRow): string[] {
  const base = i.addresses[0]
  return i.hosts.map(h => (h === '*' ? (base ? `http://${base}/` : '') : `${i.tls ? 'https' : 'http'}://${h}/`)).filter(Boolean)
}
