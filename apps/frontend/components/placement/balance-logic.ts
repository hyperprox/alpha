// Pure display logic for the Load balancing page: score tones, node load bars before and after a plan, sparkline
// paths, plan buttons and progress words. No React and no CSS, so it is tested on its own (test/balance.test.tsx).

import { gib, seconds, when } from './logic'
import type { AutoSettings, AutoState, BalanceGoal, BalancePlan, BalanceView, NodeLoad, PlanRecord, PlanStep, Sample } from './types'

export const GOAL_WORD: Record<BalanceGoal, string> = { mem: 'RAM', cpu: 'CPU', both: 'CPU and RAM' }

export type ScoreTone = 'good' | 'warn' | 'crit'
/** The score's tone: even, uneven, or badly uneven (twice the threshold). */
export function scoreTone(spread: number, unevenAbove: number): ScoreTone {
  return spread <= unevenAbove ? 'good' : spread <= unevenAbove * 2 ? 'warn' : 'crit'
}

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v * 100)))
export const pct = (v: number) => `${Math.round((Number(v) || 0) * 100)}%`

export interface LoadBar { key: 'cpu' | 'mem'; label: string; pct: number; after: number | null; text: string; over: boolean }

/** A node's CPU and RAM bars (p95 over the window), with the plan's after-value when there is one. */
export function loadBars(n: NodeLoad, after?: { cpu: number; mem: number } | null, lines = { cpu: 0.8, mem: 0.9 }): LoadBar[] {
  return [
    { key: 'cpu', label: 'CPU', pct: clamp(n.cpu.p95), after: after ? clamp(after.cpu) : null, over: n.cpu.p95 >= lines.cpu,
      text: `${pct(n.cpu.p95)} p95 · ${pct(n.cpu.now)} now · ${n.threads} threads` },
    { key: 'mem', label: 'RAM', pct: clamp(n.mem.p95), after: after ? clamp(after.mem) : null, over: n.mem.p95 >= lines.mem,
      text: `${pct(n.mem.p95)} p95 · ${gib(n.mem.p95 * n.maxmem)} of ${gib(n.maxmem)}` },
  ]
}

/** An SVG polyline for a sparkline, 0..1 values on a width × height box. Empty with fewer than two points. */
export function sparkPoints(samples: Sample[], width = 120, height = 28): string {
  if (samples.length < 2) return ''
  const t0 = samples[0][0], t1 = samples[samples.length - 1][0]
  const span = Math.max(1, t1 - t0)
  return samples.map(([t, v]) => `${Math.round(((t - t0) / span) * width * 10) / 10},${Math.round((1 - Math.max(0, Math.min(1, v))) * height * 10) / 10}`).join(' ')
}

/** One move, as a sentence. */
export function stepLine(s: PlanStep): string {
  const outage = s.type === 'lxc' ? `about ${seconds(s.downtimeSec ?? 20)} offline (a container restarts)` : 'no outage expected (a VM moves live)'
  const copy = s.copyBytes > 0 ? `${gib(s.copyBytes)} to copy, about ${seconds(s.copySec)}` : 'its disks stay on shared storage'
  return `${s.name || s.sid}: ${s.from} → ${s.to}. ${outage}; ${copy}${s.bwlimitKiB ? `; at most ${Math.round(s.bwlimitKiB / 1024)} MiB/s` : ''}. +${Math.round(s.gain)} points.`
}

/** The plan's buttons: run now in a quiet window, or schedule for the next one. */
export function planChoices(v: Pick<BalanceView, 'plan' | 'quiet' | 'running'>): Array<'now' | 'schedule'> {
  if (!v.plan.steps.length || v.running) return []
  if (v.quiet.quietNow) return ['now', 'schedule']
  return v.quiet.nextQuiet ? ['schedule'] : []
}

export const PLAN_WORD: Record<PlanRecord['status'], string> = {
  scheduled: 'scheduled', running: 'running', done: 'done', stopped: 'stopped', failed: 'failed', cancelled: 'cancelled', skipped: 'skipped',
}

/** "2 of 3 moves done", for a plan's progress. */
export function progressWords(p: PlanRecord, tz?: string): string {
  const done = p.steps.filter(s => s.status === 'done').length
  const head = `${p.source === 'auto' ? 'Automatic' : 'Plan'} · ${PLAN_WORD[p.status]} · ${done} of ${p.steps.length} move${p.steps.length === 1 ? '' : 's'} done`
  if (p.status === 'scheduled' && p.scheduledFor) return `${head} · runs ${when(p.scheduledFor, tz)}`
  if (p.status === 'running' && p.stopRequested) return `${head} · stopping after the move under way`
  return `${head} · score ${Math.round(p.scoreBefore)} → ${Math.round(p.scoreTarget)}`
}

/** Automatic balancing in one line. */
export function autoWords(a: { settings: AutoSettings; state: AutoState }): string {
  if (!a.settings.enabled) return 'Off. HyperProx does not check or move anything on its own.'
  const base = a.settings.apply
    ? `On, applying: up to ${a.settings.maxMovesPerDay} move${a.settings.maxMovesPerDay === 1 ? '' : 's'} a day, at least ${a.settings.minHoursBetween} h apart, in quiet windows only${a.state.approver ? `, approved by ${a.state.approver.email}` : ''}.`
    : 'On, notifying only: it tells you when a plan is worth running and moves nothing.'
  return a.state.lastWhy ? `${base} Last check: ${a.state.lastWhy}` : base
}

/** The page's node order: counted nodes busiest first by the goal, then the rest. */
export function orderNodes(nodes: NodeLoad[], goal: BalanceGoal): NodeLoad[] {
  const k = (n: NodeLoad) => (goal === 'cpu' ? n.cpu.p95 : goal === 'mem' ? n.mem.p95 : (n.cpu.p95 + n.mem.p95) / 2)
  return [...nodes].sort((a, b) => Number(b.counted) - Number(a.counted) || k(b) - k(a))
}

/** After-values per node, from the plan. */
export function afterOf(plan: BalancePlan | null): Map<string, { cpu: number; mem: number }> {
  return new Map((plan?.steps.length ? plan.nodesAfter : []).map(n => [n.node, { cpu: n.cpu, mem: n.mem }]))
}
