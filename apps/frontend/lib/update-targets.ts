// The Updates page's target tree and item results, as plain functions so they can be tested without a browser.
//
// Choosing works on the tree: ticking a row ticks it and every row below it that can be chosen, except a node
// reboot, which is only ever ticked on its own row. A reboot is never part of an update unless a person ticks it.

import type { UpdatesItemOutcome, UpdatesJob, UpdatesPlan, UpdatesStep, UpdatesStepStatus, UpdatesTarget } from '@hyperprox/types'

export type Forest = { roots: UpdatesTarget[]; kids: Map<string, UpdatesTarget[]>; byId: Map<string, UpdatesTarget> }

/** Rows under their parents, in the order the API sent them (Ceph, then nodes in run order, each node's guests). */
export function forest(targets: UpdatesTarget[]): Forest {
  const byId = new Map(targets.map(t => [t.id, t]))
  const kids = new Map<string, UpdatesTarget[]>()
  const roots: UpdatesTarget[] = []
  for (const t of targets) {
    if (t.parent && byId.has(t.parent)) kids.set(t.parent, [...(kids.get(t.parent) ?? []), t])
    else roots.push(t)
  }
  return { roots, kids, byId }
}

/** Every row below `id`. */
export function descendants(f: Forest, id: string): UpdatesTarget[] {
  const out: UpdatesTarget[] = []
  const walk = (x: string) => { for (const k of f.kids.get(x) ?? []) { out.push(k); walk(k.id) } }
  walk(id)
  return out
}

/** What ticking `id` chooses: the row and every choosable row below it, never a reboot it did not name. */
export function cascade(f: Forest, id: string): string[] {
  const self = f.byId.get(id)
  const rows = [...(self ? [self] : []), ...descendants(f, id).filter(t => t.kind !== 'node-reboot')]
  return rows.filter(t => t.selectable).map(t => t.id)
}

export type Tick = 'on' | 'off' | 'some' | 'none'

/** A row's box: on, off, partly on (some rows below chosen), or none (nothing here can be chosen). */
export function tickState(f: Forest, id: string, chosen: Set<string>): Tick {
  const ids = cascade(f, id)
  if (!ids.length) return 'none'
  const n = ids.filter(x => chosen.has(x)).length
  return n === 0 ? 'off' : n === ids.length ? 'on' : 'some'
}

/** Tick or untick a row (and what it covers). */
export function toggle(f: Forest, id: string, chosen: Set<string>): Set<string> {
  const ids = cascade(f, id)
  const next = new Set(chosen)
  const on = tickState(f, id, chosen) !== 'on'
  for (const x of ids) { if (on) next.add(x); else next.delete(x) }
  return next
}

export type Helper = 'everything' | 'guests' | 'containers' | 'security' | 'nodes' | 'none'

/** The select helpers. Security picks exactly the security packages and apps, nothing else. */
export function helperSelection(targets: UpdatesTarget[], h: Helper): string[] {
  const ok = targets.filter(t => t.selectable)
  switch (h) {
    case 'everything': return ok.filter(t => t.everything).map(t => t.id)
    case 'guests':     return ok.filter(t => t.kind === 'guest' || ((t.kind === 'app' || t.kind === 'compose') && t.everything)).map(t => t.id)
    case 'containers': return ok.filter(t => t.kind === 'compose').map(t => t.id)
    case 'security':   return ok.filter(t => t.security > 0 && (t.kind === 'node-pkg' || t.kind === 'guest-pkg' || t.kind === 'app')).map(t => t.id)
    case 'nodes':      return ok.filter(t => t.kind === 'node').map(t => t.id)
    default:           return []
  }
}

/** Approval ids the chosen rows need sent with the run (a remote guest updated without a snapshot). */
export function approvalsFor(targets: UpdatesTarget[], chosen: Set<string>): string[] {
  return [...new Set(targets.filter(t => chosen.has(t.id)).flatMap(t => t.approvals ?? []))].sort()
}

/** Totals for the header: rows chosen, packages, security updates and reboots among them. */
export function chosenSummary(targets: UpdatesTarget[], chosen: Set<string>): { rows: number; reboots: number; security: number } {
  const rows = targets.filter(t => chosen.has(t.id))
  return { rows: rows.length, reboots: rows.filter(t => t.kind === 'node-reboot').length, security: rows.filter(t => t.kind.endsWith('pkg') || t.kind === 'app').reduce((n, t) => n + t.security, 0) }
}

// --- Items of a run -----------------------------------------------------------------------------

export type ItemView = { id: string; label: string; status: UpdatesStepStatus; reason: string | null; steps: UpdatesStep[]; dependsOn: string[] }

/** Each chosen item with its steps and status, live from the job's steps (the report's outcomes once it is written). */
export function itemViews(job: Pick<UpdatesJob, 'plan' | 'steps' | 'report'>): ItemView[] {
  const plan: UpdatesPlan = job.plan
  if (!plan.items) return []
  const off = plan.stepOffset ?? 0
  const final = new Map<string, UpdatesItemOutcome>((job.report?.items ?? []).map(o => [o.id, o]))
  return plan.items.map(it => {
    const steps = (job.steps ?? []).filter(s => it.seqs.includes(s.seq - off))
    const o = final.get(it.id)
    if (o) return { id: it.id, label: it.label, status: o.status, reason: o.reason ?? null, steps, dependsOn: it.dependsOn }
    const failed = steps.find(s => s.status === 'failed')
    const status: UpdatesStepStatus = failed ? 'failed'
      : steps.some(s => s.status === 'running') ? 'running'
      : !steps.length || steps.some(s => s.status === 'pending') ? (steps.some(s => s.status !== 'pending') ? 'running' : 'pending')
      : steps.every(s => s.status === 'skipped') ? 'skipped' : 'ok'
    const reason = failed?.reason ?? (status === 'skipped' ? steps.find(s => s.reason)?.reason ?? null : null)
    return { id: it.id, label: it.label, status, reason, steps, dependsOn: it.dependsOn }
  })
}
