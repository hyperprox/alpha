// =============================================================================
//  HyperProx — K3s: what the API's answers mean
//
//  Pure functions from Kubernetes API lists to the K3s page's reading: nodes
//  (ready, version, CPU and memory), namespaces, workloads with desired against
//  ready, the pods in trouble with their reason (CrashLoopBackOff, an image
//  that cannot be pulled, Pending and why, restarting), recent warning events,
//  services and ingresses with their addresses, and every problem's fixes.
//
//  Everything here is untrusted text from the cluster: names are checked
//  against Kubernetes' own rules before they become a target for an action,
//  and messages are cut to one short line.
// =============================================================================

export const NAME_RE = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/
export const NAMESPACE_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/
export const CONTAINER_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/

const line = (v: unknown, max = 300): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '')
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const ts = (v: unknown): number | null => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null }
const items = (list: any): any[] => (list && Array.isArray(list.items) ? list.items : [])

/** Kubernetes quantities: CPU in millicores, memory in bytes. Null when it is not one. */
export function cpuMilli(q: unknown): number | null {
  const s = typeof q === 'string' ? q.trim() : typeof q === 'number' ? String(q) : ''
  const m = /^(\d+(?:\.\d+)?)(n|u|m)?$/.exec(s)
  if (!m) return null
  const v = Number(m[1])
  return Math.round(m[2] === 'n' ? v / 1e6 : m[2] === 'u' ? v / 1e3 : m[2] === 'm' ? v : v * 1000)
}
const MEM_UNITS: Record<string, number> = { '': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 }
export function memBytes(q: unknown): number | null {
  const s = typeof q === 'string' ? q.trim() : typeof q === 'number' ? String(q) : ''
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(s)
  return m ? Math.round(Number(m[1]) * MEM_UNITS[m[2] ?? '']) : null
}

// ── shapes ───────────────────────────────────────────────────────────────────

export type FixAction = 'restart' | 'rollback' | 'scale' | 'delete-pod' | 'cordon' | 'uncordon' | 'drain' | 'logs' | 'add-agent'

/** A button on a problem: what it does and to what. The server checks the target again before acting. */
export interface Fix {
  action: FixAction
  label: string
  /** Shown in the confirmation: what happens, in words. */
  confirm?: string
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
  desired: number; ready: number; updated: number; available: number; images: string[]
  problem: string | null; fixes: Fix[]
}
export type PodState = 'crashloop' | 'image' | 'pending' | 'restarting' | 'failed' | 'oom' | 'not-ready'
export interface ProblemPod {
  namespace: string; name: string; node: string | null; state: PodState; reason: string; message: string
  container: string | null; restarts: number; since: number | null
  owner: { kind: string; name: string } | null
  /** The last lines of its log (the previous run's for a crash loop). Admin only: the route drops them for everyone else. */
  lastLines?: string[]
  fixes: Fix[]
}
export interface EventRow { namespace: string; kind: string; name: string; reason: string; message: string; count: number; last: number | null }
export interface ServiceRow { namespace: string; name: string; type: string; clusterIP: string | null; external: string[]; ports: string[] }
export interface IngressRow { namespace: string; name: string; hosts: string[]; addresses: string[]; tls: boolean; paths: string[] }

export interface Reading {
  fetchedAt: string
  version: { current: string | null; latest: string | null; upgrade: string | null }
  nodes: NodeRow[]
  namespaces: NamespaceRow[]
  workloads: WorkloadRow[]
  problems: ProblemPod[]
  events: EventRow[]
  services: ServiceRow[]
  ingresses: IngressRow[]
  counts: { pods: number; running: number; problems: number; warnings: number }
  health: { state: 'ok' | 'attention' | 'bad'; reasons: string[] }
  /** Lists that could not be read (metrics while metrics-server starts, say), by name. */
  missing: string[]
}

// ── nodes ────────────────────────────────────────────────────────────────────

export function nodesOf(nodeList: any, metrics: any, pods: any[]): NodeRow[] {
  const use = new Map<string, any>(items(metrics).map((m: any) => [String(m?.metadata?.name ?? ''), m?.usage ?? {}]))
  const podsOn = new Map<string, number>()
  for (const p of pods) {
    const n = p?.spec?.nodeName
    if (typeof n === 'string' && p?.status?.phase !== 'Succeeded' && p?.status?.phase !== 'Failed') podsOn.set(n, (podsOn.get(n) ?? 0) + 1)
  }
  return items(nodeList).map((n: any): NodeRow => {
    const name = line(n?.metadata?.name, 253)
    const conds: any[] = Array.isArray(n?.status?.conditions) ? n.status.conditions : []
    const ready = conds.find(c => c?.type === 'Ready')
    const isReady = ready?.status === 'True'
    const pressure = conds.filter(c => c?.type !== 'Ready' && c?.status === 'True').map(c => line(c.type, 40))
    const labels = n?.metadata?.labels ?? {}
    const roles = Object.keys(labels).filter(k => k.startsWith('node-role.kubernetes.io/')).map(k => k.slice('node-role.kubernetes.io/'.length)).filter(Boolean).sort()
    const addr: any[] = Array.isArray(n?.status?.addresses) ? n.status.addresses : []
    const u = use.get(name)
    const unschedulable = n?.spec?.unschedulable === true
    const fixes: Fix[] = []
    if (NAME_RE.test(name)) {
      if (unschedulable) fixes.push({ action: 'uncordon', label: 'Uncordon', confirm: `New pods may be scheduled on ${name} again.`, target: { kind: 'Node', name } })
      else {
        fixes.push({ action: 'cordon', label: 'Cordon', confirm: `No new pods will be scheduled on ${name}. Pods already there keep running.`, target: { kind: 'Node', name } })
        fixes.push({ action: 'drain', label: 'Drain', target: { kind: 'Node', name } })
      }
    }
    return {
      name, ready: isReady,
      reason: isReady ? null : line(ready?.message || ready?.reason || 'no Ready condition reported', 200),
      roles: roles.length ? roles : ['worker'],
      version: line(n?.status?.nodeInfo?.kubeletVersion, 40) || null,
      ip: line(addr.find(a => a?.type === 'InternalIP')?.address, 45) || null,
      os: line(n?.status?.nodeInfo?.osImage, 80) || null,
      unschedulable, pressure, pods: podsOn.get(name) ?? 0,
      cpu: { capMilli: cpuMilli(n?.status?.allocatable?.cpu ?? n?.status?.capacity?.cpu), usedMilli: u ? cpuMilli(u.cpu) : null },
      mem: { capBytes: memBytes(n?.status?.allocatable?.memory ?? n?.status?.capacity?.memory), usedBytes: u ? memBytes(u.memory) : null },
      fixes,
    }
  }).sort((a, b) => a.name.localeCompare(b.name))
}

// ── pods in trouble ──────────────────────────────────────────────────────────

/** The workload a pod belongs to: a ReplicaSet's Deployment, or the StatefulSet / DaemonSet itself. */
export function ownerOf(pod: any, replicaSets: any[]): { kind: string; name: string } | null {
  const ref = (Array.isArray(pod?.metadata?.ownerReferences) ? pod.metadata.ownerReferences : []).find((r: any) => r?.controller)
  if (!ref) return null
  if (ref.kind === 'ReplicaSet') {
    const rs = replicaSets.find(r => r?.metadata?.name === ref.name && r?.metadata?.namespace === pod?.metadata?.namespace)
    const up = (Array.isArray(rs?.metadata?.ownerReferences) ? rs.metadata.ownerReferences : []).find((r: any) => r?.controller && r?.kind === 'Deployment')
    return up ? { kind: 'Deployment', name: line(up.name, 253) } : { kind: 'ReplicaSet', name: line(ref.name, 253) }
  }
  return { kind: line(ref.kind, 40), name: line(ref.name, 253) }
}

const IMAGE_REASONS = new Set(['ImagePullBackOff', 'ErrImagePull', 'InvalidImageName', 'ErrImageNeverPull'])
const RECENT_MS = 60 * 60_000

/** A pod's trouble, or null when it is fine (or finished). */
export function podProblem(pod: any, now: number): Omit<ProblemPod, 'owner' | 'fixes' | 'lastLines'> | null {
  const phase = pod?.status?.phase
  if (phase === 'Succeeded') return null
  const namespace = line(pod?.metadata?.namespace, 63), name = line(pod?.metadata?.name, 253)
  const node = line(pod?.spec?.nodeName, 253) || null
  const statuses: any[] = [...(pod?.status?.initContainerStatuses ?? []), ...(pod?.status?.containerStatuses ?? [])].filter(Boolean)
  const restarts = statuses.reduce((n, c) => n + (num(c?.restartCount) ?? 0), 0)
  const base = { namespace, name, node, restarts, since: ts(pod?.status?.startTime) }
  for (const c of statuses) {
    const w = c?.state?.waiting
    if (w?.reason === 'CrashLoopBackOff') {
      const t = c?.lastState?.terminated
      const why = t ? `${line(t.reason, 40) || 'exited'}${num(t.exitCode) !== null ? ` (exit code ${t.exitCode})` : ''}` : 'it keeps exiting'
      return { ...base, state: t?.reason === 'OOMKilled' ? 'oom' : 'crashloop', reason: 'CrashLoopBackOff', message: `The container ${line(c.name, 63)} keeps stopping: ${why}. Kubernetes waits longer before each restart.`, container: line(c.name, 63) }
    }
    if (IMAGE_REASONS.has(w?.reason)) {
      return { ...base, state: 'image', reason: line(w.reason, 40), message: line(w.message, 300) || `The image ${line(c.image, 200)} cannot be pulled.`, container: line(c.name, 63) }
    }
    // Between two restarts of a crash loop the container shows as terminated with an error, not yet as waiting.
    const t = c?.state?.terminated
    if (t && (num(c?.restartCount) ?? 0) >= 1 && (num(t.exitCode) ?? 0) !== 0 && phase !== 'Failed') {
      return { ...base, state: t.reason === 'OOMKilled' ? 'oom' : 'crashloop', reason: 'CrashLoopBackOff', message: `The container ${line(c.name, 63)} keeps stopping: ${line(t.reason, 40) || 'exited'} (exit code ${t.exitCode}). Kubernetes waits longer before each restart.`, container: line(c.name, 63) }
    }
    if (w?.reason === 'CreateContainerConfigError' || w?.reason === 'CreateContainerError' || w?.reason === 'RunContainerError') {
      return { ...base, state: 'crashloop', reason: line(w.reason, 40), message: line(w.message, 300) || 'The container could not be created.', container: line(c.name, 63) }
    }
  }
  if (phase === 'Failed') {
    return { ...base, state: 'failed', reason: line(pod?.status?.reason, 40) || 'Failed', message: line(pod?.status?.message, 300) || 'The pod failed and will not be restarted.', container: null }
  }
  if (phase === 'Pending') {
    const sched = (pod?.status?.conditions ?? []).find((c: any) => c?.type === 'PodScheduled')
    if (sched?.status === 'False') return { ...base, state: 'pending', reason: line(sched.reason, 40) || 'Pending', message: line(sched.message, 300) || 'No node can take it.', container: null }
    const created = ts(pod?.metadata?.creationTimestamp)
    if (created !== null && now - created > 5 * 60_000) {
      const w = statuses.map(c => c?.state?.waiting).find(Boolean)
      return { ...base, state: 'pending', reason: line(w?.reason, 40) || 'Pending', message: line(w?.message, 300) || 'It has been waiting to start for over five minutes.', container: null }
    }
    return null
  }
  // Running but restarting: three or more restarts with the last one in the past hour.
  const lastRestart = Math.max(0, ...statuses.map(c => ts(c?.lastState?.terminated?.finishedAt) ?? 0))
  if (restarts >= 3 && lastRestart && now - lastRestart < RECENT_MS) {
    const c = statuses.find(x => ts(x?.lastState?.terminated?.finishedAt) === lastRestart)
    const t = c?.lastState?.terminated
    return { ...base, state: t?.reason === 'OOMKilled' ? 'oom' : 'restarting', reason: line(t?.reason, 40) || 'Restarting', message: `Restarted ${restarts} times; the last time ${t?.reason === 'OOMKilled' ? 'it ran out of memory' : `it stopped with ${line(t?.reason, 40) || 'an error'}${num(t?.exitCode) !== null ? ` (exit code ${t.exitCode})` : ''}`}.`, container: line(c?.name, 63) || null }
  }
  return null
}

/** The buttons for a pod in trouble: what can actually help it. */
export function podFixes(p: Omit<ProblemPod, 'fixes'>, nodes: NodeRow[]): Fix[] {
  const out: Fix[] = []
  const valid = NAMESPACE_RE.test(p.namespace) && NAME_RE.test(p.name)
  if (!valid) return out
  const ownerOk = p.owner && NAME_RE.test(p.owner.name)
  const wk = ownerOk && (p.owner!.kind === 'Deployment' || p.owner!.kind === 'StatefulSet' || p.owner!.kind === 'DaemonSet') ? p.owner!.kind as 'Deployment' | 'StatefulSet' | 'DaemonSet' : null
  if (p.state === 'image' && wk === 'Deployment') {
    out.push({ action: 'rollback', label: 'Roll back to the previous version', confirm: `${p.owner!.name} goes back to the pod template it had before the last change (the image that worked).`, target: { kind: 'Deployment', namespace: p.namespace, name: p.owner!.name } })
  }
  if (p.state === 'pending') {
    const cordoned = nodes.filter(n => n.unschedulable)
    for (const n of cordoned.slice(0, 3)) out.push({ action: 'uncordon', label: `Uncordon ${n.name}`, confirm: `New pods may be scheduled on ${n.name} again.`, target: { kind: 'Node', name: n.name } })
    out.push({ action: 'add-agent', label: 'Add a node (K3s agent)', target: { kind: 'Pod', namespace: p.namespace, name: p.name } })
    if (wk === 'Deployment' || wk === 'StatefulSet') out.push({ action: 'scale', label: 'Scale down', target: { kind: wk, namespace: p.namespace, name: p.owner!.name } })
  }
  if (p.state !== 'pending' && p.state !== 'image' && wk) {
    out.push({ action: 'restart', label: `Restart ${wk.toLowerCase()}`, confirm: `Every pod of ${p.owner!.name} is replaced, one at a time where it has more than one.`, target: { kind: wk, namespace: p.namespace, name: p.owner!.name } })
    if (wk === 'Deployment') out.push({ action: 'rollback', label: 'Roll back', confirm: `${p.owner!.name} goes back to the pod template it had before the last change.`, target: { kind: 'Deployment', namespace: p.namespace, name: p.owner!.name } })
  }
  if (p.state !== 'pending') {
    out.push({ action: 'delete-pod', label: 'Delete pod', confirm: wk ? `${p.name} is deleted; ${p.owner!.name} makes a new one at once.` : `${p.name} has no controller, so nothing makes it again: it is gone for good.`, target: { kind: 'Pod', namespace: p.namespace, name: p.name } })
  }
  if (p.state !== 'pending' && p.container && CONTAINER_RE.test(p.container)) {
    out.push({ action: 'logs', label: 'Show logs', target: { kind: 'Pod', namespace: p.namespace, name: p.name, container: p.container } })
  }
  return out
}

// ── workloads ────────────────────────────────────────────────────────────────

const images = (w: any): string[] => (w?.spec?.template?.spec?.containers ?? []).map((c: any) => line(c?.image, 200)).filter(Boolean).slice(0, 6)

export function workloadsOf(deps: any, sts: any, dss: any): WorkloadRow[] {
  const out: WorkloadRow[] = []
  const add = (kind: WorkloadRow['kind'], w: any, desired: number, ready: number, updated: number, available: number) => {
    const namespace = line(w?.metadata?.namespace, 63), name = line(w?.metadata?.name, 253)
    const problem = desired > 0 && ready < desired ? `${ready} of ${desired} ready` : null
    const fixes: Fix[] = []
    if (NAMESPACE_RE.test(namespace) && NAME_RE.test(name)) {
      fixes.push({ action: 'restart', label: 'Restart', confirm: `Every pod of ${name} is replaced, one at a time where it has more than one.`, target: { kind, namespace, name } })
      if (kind !== 'DaemonSet') fixes.push({ action: 'scale', label: 'Scale', target: { kind, namespace, name } })
    }
    out.push({ kind, namespace, name, desired, ready, updated, available, images: images(w), problem, fixes })
  }
  for (const d of items(deps)) add('Deployment', d, num(d?.spec?.replicas) ?? 1, num(d?.status?.readyReplicas) ?? 0, num(d?.status?.updatedReplicas) ?? 0, num(d?.status?.availableReplicas) ?? 0)
  for (const s of items(sts)) add('StatefulSet', s, num(s?.spec?.replicas) ?? 1, num(s?.status?.readyReplicas) ?? 0, num(s?.status?.updatedReplicas) ?? 0, num(s?.status?.availableReplicas) ?? 0)
  for (const d of items(dss)) add('DaemonSet', d, num(d?.status?.desiredNumberScheduled) ?? 0, num(d?.status?.numberReady) ?? 0, num(d?.status?.updatedNumberScheduled) ?? 0, num(d?.status?.numberAvailable) ?? 0)
  return out.sort((a, b) => Number(!!b.problem) - Number(!!a.problem) || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))
}

// ── events, services, ingresses ──────────────────────────────────────────────

/** Warning events of the last hour, newest first, at most 50. */
export function warningsOf(events: any, now: number): EventRow[] {
  return items(events).filter((e: any) => e?.type === 'Warning').map((e: any): EventRow => ({
    namespace: line(e?.metadata?.namespace ?? e?.involvedObject?.namespace, 63), kind: line(e?.involvedObject?.kind, 40), name: line(e?.involvedObject?.name, 253),
    reason: line(e?.reason, 60), message: line(e?.message ?? e?.note, 300), count: num(e?.count) ?? num(e?.series?.count) ?? 1,
    last: ts(e?.lastTimestamp) ?? ts(e?.eventTime) ?? ts(e?.series?.lastObservedTime) ?? ts(e?.metadata?.creationTimestamp),
  })).filter(e => e.last === null || now - e.last < RECENT_MS).sort((a, b) => (b.last ?? 0) - (a.last ?? 0)).slice(0, 50)
}

export function servicesOf(svcs: any): ServiceRow[] {
  return items(svcs).map((s: any): ServiceRow => {
    const lb: any[] = s?.status?.loadBalancer?.ingress ?? []
    const external = [...(s?.spec?.externalIPs ?? []), ...lb.map(i => i?.ip ?? i?.hostname)].map(x => line(x, 253)).filter(Boolean)
    const ports = (s?.spec?.ports ?? []).map((p: any) => `${num(p?.port) ?? '?'}${p?.nodePort ? `:${p.nodePort}` : ''}/${line(p?.protocol, 8) || 'TCP'}`).slice(0, 10)
    const cip = line(s?.spec?.clusterIP, 45)
    return { namespace: line(s?.metadata?.namespace, 63), name: line(s?.metadata?.name, 253), type: line(s?.spec?.type, 20) || 'ClusterIP', clusterIP: cip && cip !== 'None' ? cip : null, external: [...new Set(external)], ports }
  }).sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))
}

export function ingressesOf(ings: any): IngressRow[] {
  return items(ings).map((i: any): IngressRow => {
    const rules: any[] = i?.spec?.rules ?? []
    const lb: any[] = i?.status?.loadBalancer?.ingress ?? []
    return {
      namespace: line(i?.metadata?.namespace, 63), name: line(i?.metadata?.name, 253),
      hosts: [...new Set(rules.map(r => line(r?.host, 253) || '*'))],
      addresses: [...new Set(lb.map(x => line(x?.ip ?? x?.hostname, 253)).filter(Boolean))],
      tls: Array.isArray(i?.spec?.tls) && i.spec.tls.length > 0,
      paths: rules.flatMap(r => (r?.http?.paths ?? []).map((p: any) => `${line(r?.host, 253) || '*'}${line(p?.path, 200) || '/'} → ${line(p?.backend?.service?.name, 253)}:${p?.backend?.service?.port?.number ?? line(p?.backend?.service?.port?.name, 63)}`)).slice(0, 20),
    }
  }).sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))
}

// ── versions ─────────────────────────────────────────────────────────────────

/** v1.37.1+k3s1 as numbers to compare; null when it is not one. */
export function versionKey(v: string | null | undefined): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:\+k3s(\d+))?$/.exec(String(v ?? '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0)] : null
}
export function newer(latest: string | null, current: string | null): boolean {
  const a = versionKey(latest), b = versionKey(current)
  if (!a || !b) return false
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

// ── the whole reading ────────────────────────────────────────────────────────

export interface RawLists {
  version: any; nodes: any; nodeMetrics: any | null; namespaces: any; pods: any; replicaSets: any
  deployments: any; statefulSets: any; daemonSets: any; events: any; services: any; ingresses: any | null
  latest: string | null; missing: string[]
}

export function readingOf(raw: RawLists, now: number): Reading {
  const pods = items(raw.pods)
  const rs = items(raw.replicaSets)
  const nodes = nodesOf(raw.nodes, raw.nodeMetrics, pods)
  const problemsRaw = pods.map(p => { const pr = podProblem(p, now); return pr ? { ...pr, owner: ownerOf(p, rs) } : null }).filter(Boolean) as Array<Omit<ProblemPod, 'fixes'>>
  const order: Record<PodState, number> = { crashloop: 0, oom: 1, image: 2, failed: 3, pending: 4, restarting: 5, 'not-ready': 6 }
  const problems: ProblemPod[] = problemsRaw.map(p => ({ ...p, fixes: podFixes(p, nodes) }))
    .sort((a, b) => order[a.state] - order[b.state] || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))
  const byNs = new Map<string, { pods: number; problems: number }>()
  for (const p of pods) { const ns = String(p?.metadata?.namespace ?? ''); const e = byNs.get(ns) ?? { pods: 0, problems: 0 }; e.pods++; byNs.set(ns, e) }
  for (const p of problems) { const e = byNs.get(p.namespace); if (e) e.problems++ }
  const namespaces = items(raw.namespaces).map((n: any): NamespaceRow => {
    const name = line(n?.metadata?.name, 63)
    return { name, phase: line(n?.status?.phase, 20) || 'Active', pods: byNs.get(name)?.pods ?? 0, problems: byNs.get(name)?.problems ?? 0 }
  }).sort((a, b) => a.name.localeCompare(b.name))
  const workloads = workloadsOf(raw.deployments, raw.statefulSets, raw.daemonSets)
  const events = warningsOf(raw.events, now)
  const current = line(raw.version?.gitVersion, 40) || null
  const upgrade = raw.latest && newer(raw.latest, current) ? raw.latest : null

  const reasons: string[] = []
  const down = nodes.filter(n => !n.ready)
  if (down.length) reasons.push(`${down.length === 1 ? `node ${down[0].name} is` : `${down.length} nodes are`} not ready`)
  const crash = problems.filter(p => p.state === 'crashloop' || p.state === 'oom' || p.state === 'image' || p.state === 'failed')
  if (crash.length) reasons.push(`${crash.length} pod${crash.length === 1 ? '' : 's'} failing`)
  const pend = problems.filter(p => p.state === 'pending')
  if (pend.length) reasons.push(`${pend.length} pod${pend.length === 1 ? '' : 's'} pending`)
  const restarting = problems.filter(p => p.state === 'restarting')
  if (restarting.length) reasons.push(`${restarting.length} pod${restarting.length === 1 ? '' : 's'} restarting`)
  const short = workloads.filter(w => w.problem)
  if (short.length && !crash.length && !pend.length) reasons.push(`${short.length} workload${short.length === 1 ? '' : 's'} not fully ready`)
  const cordoned = nodes.filter(n => n.unschedulable)
  if (cordoned.length) reasons.push(`${cordoned.length === 1 ? `node ${cordoned[0].name} is` : `${cordoned.length} nodes are`} cordoned`)
  const state: Reading['health']['state'] = down.length || crash.length ? 'bad' : reasons.length ? 'attention' : 'ok'
  return {
    fetchedAt: new Date(now).toISOString(),
    version: { current, latest: raw.latest, upgrade },
    nodes, namespaces, workloads, problems, events,
    services: servicesOf(raw.services), ingresses: raw.ingresses ? ingressesOf(raw.ingresses) : [],
    counts: { pods: pods.length, running: pods.filter(p => p?.status?.phase === 'Running').length, problems: problems.length, warnings: events.length },
    health: { state, reasons },
    missing: raw.missing,
  }
}
