// =============================================================================
//  HyperProx — MikroTik change engine
//
//  Every write to the router goes through here:
//
//    1. the lockout guard reads the router and refuses a plan that would cut the way in (lockout.ts)
//    2. the audit row is written (fail closed: if it cannot be written, nothing happens)
//    3. the internet path is tested (ping) when the plan can affect it
//    4. the router's configuration is exported and kept (per router, the last 20)
//    5. the dead-man switch is put on the router: a script holding the inverse commands, and a scheduler entry that
//       runs it in 90 seconds (script.ts)
//    6. the steps are applied; a failing step puts back the steps already done
//    7. the result is verified (the same login still reads the router, HyperProx's own service is still on, every
//       step shows in the tables, the internet path still answers when it did before); a failure puts everything back
//    8. the dead-man switch is removed. When HyperProx cannot reach the router the switch stays, and the router puts
//       itself back.
//    9. the change is written to the history with the exact operations that undo it
// =============================================================================

import { createHash, randomBytes } from 'node:crypto'
import { canonicalJson } from '../confirm'
import { checkLockout, type Snapshot } from './lockout'
import { arr, matchRow } from './rows'
import { deadManName, deadManScheduler, deadManScript, deadManComment } from './script'
import type { ChangeStore } from './store'
import { ChangeRefusal, opPath, type ChangePlan, type ChangeRouter, type HistoryEntry, type HistoryView, type Management, type Op, type PlanStep, type Row } from './types'

export const DEAD_MAN_SECONDS = 90
/** Past this many seconds after the switch was armed, HyperProx stops and leaves the rest to the router. */
export const LATEST_CANCEL_SECONDS = 70

export interface EngineDeps {
  router: ChangeRouter
  management: Management
  store: ChangeStore
  routerKey: string
  by: string
  /** Written, and awaited, before the first change. A throw stops everything. */
  audit(action: string, details: Record<string, unknown>): Promise<void>
  now?: () => number
  newId?: () => string
}

export interface ApplyResult { id: string; message: string; steps: string[] }

// ── plan identity ────────────────────────────────────────────────────────────

/** The hash of what a plan would do: the page sends it back and the API checks the plan is still the same. */
export function planHash(plan: ChangePlan): string {
  return createHash('sha256').update(canonicalJson({ k: plan.kind, s: plan.steps.map(s => [s.forward, s.inverse]), t: plan.needsTick })).digest('hex').slice(0, 24)
}

export function planView(plan: ChangePlan) {
  return { hash: planHash(plan), title: plan.title, steps: plan.steps.map(s => s.words), warnings: plan.warnings, needsTick: plan.needsTick }
}

/** What the confirmation says: the title, every step and every warning, in words. */
export function planSummary(plan: ChangePlan): string {
  const steps = plan.steps.map((s, i) => `${i + 1}. ${s.words}`).join(' ')
  const warn = plan.warnings.length ? ` Note: ${plan.warnings.join(' ')}` : ''
  return `${plan.title}. ${steps}${warn} Before it runs HyperProx saves the router's settings and arms a safety switch on the router: if HyperProx cannot confirm the change within ${DEAD_MAN_SECONDS} seconds, the router undoes it by itself. You can also undo it from the change history.`
}

// ── reading and writing the router ───────────────────────────────────────────

const t15 = 15_000

async function table(router: ChangeRouter, path: string): Promise<Row[]> {
  const v = await router.get(opPath(path), t15)
  if (!Array.isArray(v)) throw new Error(`The router gave an unreadable answer for ${path}.`)
  return v
}

export async function readSnapshot(router: ChangeRouter): Promise<Snapshot> {
  const g = (p: string) => table(router, p).catch(() => [] as Row[])
  const [addresses, routes, services, users, interfaces, filter] = await Promise.all([
    g('/ip/address'), g('/ip/route'), g('/ip/service'), g('/user'), g('/interface'), g('/ip/firewall/filter'),
  ])
  return { addresses, routes, services, users, interfaces, filter }
}

const idOf = (r: any): string | null => { const x = Array.isArray(r) ? r[0] : r; return x && typeof x['.id'] === 'string' ? x['.id'] : null }

async function runOp(router: ChangeRouter, op: Op): Promise<void> {
  switch (op.kind) {
    case 'add': {
      const res = await router.put(opPath(op.path), op.props)
      if (op.top) {
        const id = idOf(res)
        if (!id) throw new Error('The router did not say which rule it made.')
        if (!router.post) throw new Error('This connection cannot move a rule to the top, so it was not left at the bottom.')
        const first = (await table(router, op.path)).find(r => r['.id'] !== id && r.dynamic !== 'true')
        if (first) await router.post(`${opPath(op.path)}/move`, { numbers: id, destination: first['.id'] })
      }
      return
    }
    case 'set': {
      const rows = (await table(router, op.path)).filter(r => matchRow(r, op.where))
      if (!rows.length) throw new Error('The router no longer has the entry this change was going to edit.')
      if (!router.patch) throw new Error('This connection cannot edit router entries.')
      for (const r of rows) await router.patch(`${opPath(op.path)}/${r['.id']}`, op.props)
      return
    }
    case 'remove': {
      for (const r of (await table(router, op.path)).filter(r => matchRow(r, op.where))) await router.delete(`${opPath(op.path)}/${r['.id']}`)
      return
    }
    case 'command': {
      const rows = (await table(router, op.path.replace(/\/[^/]+$/, ''))).filter(r => matchRow(r, op.where))
      if (!rows.length) throw new Error('The router no longer has the entry this change was going to act on.')
      if (!router.post) throw new Error('This connection cannot run router commands.')
      await router.post(opPath(op.path), { numbers: rows.map(r => r['.id']).join(',') })
    }
  }
}

/** Whether one step shows in the router's tables now. */
async function stepShows(router: ChangeRouter, step: PlanStep): Promise<boolean> {
  const op = step.forward
  if (op.kind === 'add') {
    const probe = step.inverse.find(i => i.kind === 'remove')
    if (!probe || probe.kind !== 'remove') return true
    return (await table(router, op.path)).some(r => matchRow(r, probe.where))
  }
  if (op.kind === 'remove') return !(await table(router, op.path)).some(r => matchRow(r, op.where))
  if (op.kind === 'set') {
    const after = { ...op.where, ...op.props }
    // A value the router writes in its own form (a time, a boolean) is compared on the identity keys only.
    const identity = Object.fromEntries(Object.entries(after).filter(([k]) => !['time', 'disabled', 'comment'].includes(k) || k in op.where && !(k in op.props)))
    const rows = (await table(router, op.path)).filter(r => matchRow(r, identity))
    if (!rows.length) return false
    if ('disabled' in op.props) return rows.every(r => (r.disabled === 'true' || r.disabled === 'yes') === (op.props.disabled === 'true'))
    return true
  }
  return true
}

async function ping(router: ChangeRouter): Promise<boolean> {
  if (!router.post) return false
  try {
    const res = await router.post('/rest/tool/ping', { address: '1.1.1.1', count: '3' }, 20_000)
    const rows = arr(res)
    if (!rows.length) return false
    const last = rows[rows.length - 1]
    if (last['packet-loss'] !== undefined) return Number(last['packet-loss']) < 100
    return rows.some(r => Number(r.received) > 0)
  } catch { return false }
}

// ── backup and dead-man switch ───────────────────────────────────────────────

async function takeBackup(d: EngineDeps, id: string): Promise<HistoryEntry['backup']> {
  if (!d.router.post) throw new ChangeRefusal(409, 'no_backup', 'This connection cannot ask the router for a backup, so nothing was changed.')
  const name = `hyperprox-${id}`
  try {
    await d.router.post('/rest/export', { file: name }, 30_000)
    const files = arr(await d.router.get('/rest/file', t15))
    const f = files.find(x => x.name === `${name}.rsc`)
    const text = typeof f?.contents === 'string' ? f.contents : ''
    if (!f || !text.trim()) throw new Error('empty export')
    const size = Number(f.size)
    const truncated = Number.isFinite(size) && size > Buffer.byteLength(text)
    await d.store.saveBackup(d.routerKey, id, text)
    // A complete copy is kept here; the router's own file is removed. A cut-off one stays on the router.
    if (!truncated) await d.router.delete(`/rest/file/${f['.id']}`).catch(() => {})
    return { id, bytes: Buffer.byteLength(text), truncated }
  } catch (e: any) {
    throw new ChangeRefusal(409, 'backup_failed', 'HyperProx could not save the router\'s settings first, so nothing was changed. The router login needs the right to export its configuration.')
  }
}

async function armDeadMan(d: EngineDeps, id: string, inverse: Op[]): Promise<void> {
  const name = deadManName(id)
  try {
    const clock = (await d.router.get('/rest/system/clock', t15)) as Row
    const source = deadManScript(id, inverse)
    await d.router.put('/rest/system/script', { name, source, policy: 'read,write,test', comment: deadManComment(id) })
    await d.router.put('/rest/system/scheduler', deadManScheduler(id, { date: clock?.date, time: clock?.time }, DEAD_MAN_SECONDS))
    const there = arr(await d.router.get('/rest/system/scheduler', t15)).some(r => r.name === name)
    if (!there) throw new Error('the scheduler entry is not on the router')
  } catch {
    await disarmDeadMan(d, id).catch(() => {})
    throw new ChangeRefusal(409, 'no_safety_switch', 'HyperProx could not put its safety switch on the router (a scheduler entry that undoes the change by itself), so nothing was changed. The router login needs the right to write scripts and the scheduler.')
  }
}

async function disarmDeadMan(d: EngineDeps, id: string): Promise<void> {
  const name = deadManName(id)
  await runOp(d.router, { kind: 'remove', path: '/system/scheduler', where: { name } })
  await runOp(d.router, { kind: 'remove', path: '/system/script', where: { name } })
  const left = [...arr(await d.router.get('/rest/system/scheduler', t15)), ...arr(await d.router.get('/rest/system/script', t15))].some(r => r.name === name)
  if (left) throw new Error('the safety switch is still on the router')
}

// ── verification ─────────────────────────────────────────────────────────────

async function verify(d: EngineDeps, plan: ChangePlan, wasOnline: boolean): Promise<string | null> {
  try {
    await d.router.get('/rest/system/resource', 10_000)
    await d.router.get('/rest/system/identity', 10_000)
  } catch { return 'The router stopped answering HyperProx after the change.' }
  try {
    const svc = arr(await d.router.get('/rest/ip/service', 10_000)).find(s => s.name === d.management.service)
    if (svc && (svc.disabled === 'true' || svc.disabled === 'yes')) return `The router's "${d.management.service}" service, which HyperProx uses, is off.`
  } catch { return 'HyperProx could not read the router\'s services after the change.' }
  for (const s of plan.steps) {
    let shows = false
    try { shows = await stepShows(d.router, s) } catch { shows = false }
    if (!shows) return `The router does not show this step as done: ${s.words}`
  }
  if (plan.checkWan && wasOnline && !(await ping(d.router))) return 'The router could reach the internet before the change and cannot now.'
  return null
}

// ── a lock per router ────────────────────────────────────────────────────────

const chains = new Map<string, Promise<unknown>>()
function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  chains.set(key, run.catch(() => {}))
  return run
}

// ── the change ───────────────────────────────────────────────────────────────

export function applyPlan(d: EngineDeps, plan: ChangePlan, opts: { undoOf?: string } = {}): Promise<ApplyResult> {
  return exclusive(d.routerKey, () => applyNow(d, plan, opts))
}

async function applyNow(d: EngineDeps, plan: ChangePlan, opts: { undoOf?: string }): Promise<ApplyResult> {
  if (!plan.steps.length) throw new ChangeRefusal(409, 'nothing_to_do', 'There is nothing to change.')
  const now = d.now ?? Date.now
  const id = (d.newId ?? (() => randomBytes(4).toString('hex')))()
  const inverse = plan.steps.slice().reverse().flatMap(s => s.inverse)

  // 1. refuse a plan that would cut the way in
  checkLockout(plan, d.management, await readSnapshot(d.router))

  // 2. audit first
  await d.audit('mikrotik.change.start', { id, kind: plan.kind, title: plan.title, steps: plan.steps.map(s => s.words), undoOf: opts.undoOf })

  const entry: HistoryEntry = {
    id, at: new Date(now()).toISOString(), by: d.by, kind: plan.kind, title: plan.title, steps: plan.steps.map(s => s.words),
    status: 'applied', ops: plan.steps.map(s => ({ forward: s.forward, inverse: s.inverse })), ...(opts.undoOf ? { undoOf: opts.undoOf } : {}),
  }

  // 3-5. internet path, backup, safety switch: a failure here changes nothing
  const wasOnline = plan.checkWan ? await ping(d.router) : false
  entry.backup = await takeBackup(d, id).catch(async e => { await d.audit('mikrotik.change.refused', { id, error: String(e?.message ?? e).slice(0, 200) }).catch(() => {}); throw e })
  try { await armDeadMan(d, id, inverse) } catch (e: any) { await d.audit('mikrotik.change.refused', { id, error: String(e?.message ?? e).slice(0, 200) }).catch(() => {}); throw e }
  const armedAt = now()

  // 6-7. apply, then verify; a failure puts back what was done
  const done: PlanStep[] = []
  let problem: string | null = null
  try {
    for (const s of plan.steps) { await runOp(d.router, s.forward); done.push(s) }
    problem = await verify(d, plan, wasOnline)
  } catch (e: any) {
    problem = String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 300)
  }

  if (problem) {
    if ((now() - armedAt) / 1000 > LATEST_CANCEL_SECONDS) {
      // Too late to cancel safely: the router's own switch is about to run. Do not race it.
      entry.status = 'rolled-back'; entry.note = 'HyperProx took too long; the router put the change back by itself.'
      await d.store.save(d.routerKey, entry).catch(() => {})
      await d.audit('mikrotik.change.failed', { id, error: problem, rollback: 'left to the router' }).catch(() => {})
      throw new Error(`The change did not check out (${problem}) and took too long to put back, so the router will undo it by itself within a minute or two.`)
    }
    let restored = true
    try { for (const s of done.slice().reverse()) for (const op of s.inverse) await runOp(d.router, op) } catch { restored = false }
    if (restored) await disarmDeadMan(d, id).catch(() => { restored = false })
    entry.status = restored ? 'rolled-back' : 'failed'
    entry.note = problem
    await d.store.save(d.routerKey, entry).catch(() => {})
    await d.audit('mikrotik.change.failed', { id, error: problem, rolledBack: restored }).catch(() => {})
    throw new Error(restored
      ? `The change did not check out (${problem}), so HyperProx put it back. The router is as it was.`
      : `The change did not check out (${problem}) and HyperProx could not finish putting it back. The router will undo it by itself within ${DEAD_MAN_SECONDS} seconds.`)
  }

  // 8. verified: take the switch away
  let note: string | undefined
  if ((now() - armedAt) / 1000 > LATEST_CANCEL_SECONDS) note = 'This took long enough that the router\'s safety switch may have run; check the change history.'
  else await disarmDeadMan(d, id).catch(() => { note = 'The change is in place, but HyperProx could not remove the safety switch, so the router may undo it by itself. Check the change history.' })

  // 9. history
  if (note) entry.note = note
  await d.store.save(d.routerKey, entry).catch(() => {})
  await d.audit('mikrotik.change.done', { id, kind: plan.kind }).catch(() => {})
  return { id, message: `${plan.title}: done.${note ? ' ' + note : ''}`, steps: entry.steps }
}

// ── history and undo ─────────────────────────────────────────────────────────

export function historyView(list: HistoryEntry[]): HistoryView[] {
  const undone = new Set(list.filter(e => e.status === 'applied' && e.undoOf).map(e => e.undoOf))
  return list.map(({ ops, ...rest }) => ({ ...rest, canUndo: rest.status === 'applied' && !rest.undoOf && !undone.has(rest.id) && ops.some(o => o.inverse.length > 0) }))
}

/** The plan that puts one recorded change back, run through the same engine. */
export async function undoPlan(d: Pick<EngineDeps, 'store' | 'routerKey'>, id: string): Promise<{ plan: ChangePlan; entry: HistoryEntry }> {
  const entry = (await d.store.list(d.routerKey)).find(e => e.id === id)
  if (!entry) throw new ChangeRefusal(404, 'not_found', 'That change is not in the history.')
  const later = (await d.store.list(d.routerKey)).some(e => e.undoOf === id && e.status === 'applied')
  if (entry.status !== 'applied' || entry.undoOf || later) throw new ChangeRefusal(409, 'not_undoable', entry.status === 'undone' || later ? 'That change was already undone.' : 'That change cannot be undone.')
  // Newest step first. Each recorded inverse operation becomes a step; the original operation is what puts that step back.
  const steps: PlanStep[] = []
  for (const o of entry.ops.slice().reverse()) {
    o.inverse.forEach((op, i) => steps.push({ words: `Put back: ${entry.title}${entry.ops.length > 1 ? ` (${i + 1} of ${o.inverse.length})` : ''}`, forward: op, inverse: i === o.inverse.length - 1 ? [o.forward] : [] }))
  }
  if (steps.length) steps[0] = { ...steps[0], words: `Put back what "${entry.title}" changed: ${entry.steps.join('; ')}` }
  return { plan: { title: `Undo: ${entry.title}`, kind: 'undo', steps, warnings: [], needsTick: null, checkWan: /^(forward|block)/.test(entry.kind) }, entry }
}

export async function undoChange(d: EngineDeps, id: string): Promise<ApplyResult> {
  const { plan } = await undoPlan(d, id)
  const res = await applyPlan(d, plan, { undoOf: id })
  const orig = (await d.store.list(d.routerKey)).find(e => e.id === id)
  if (orig) await d.store.save(d.routerKey, { ...orig, status: 'undone', undoneAt: new Date((d.now ?? Date.now)()).toISOString(), undoneBy: d.by })
  return res
}
