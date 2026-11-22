// =============================================================================
//  HyperProx — MikroTik change engine
//
//  Every write to the router goes through here:
//
//    1. the lockout guard reads the router and refuses a plan that would cut the way in (lockout.ts)
//    2. the audit row is written (fail closed: if it cannot be written, nothing happens)
//    3. the internet path is tested (ping) when the plan can affect it
//    4. the router's configuration is exported, read in full and kept (per router, the last 20); the router's copy is
//       always removed again. A backup that cannot be read in full refuses the change.
//    5. the dead-man switch is put on the router: a script holding the inverse commands, and a scheduler entry that
//       runs it in 90 seconds (script.ts)
//    6. the steps are applied; a failing step puts back the steps already done AND the failing step itself (it may
//       have landed before the answer was lost); "the router is as it was" is only said after reading it back
//       (the router's own undo runs after 90 seconds, HyperProx stops touching things after 70: see LATEST_CANCEL_SECONDS)
//    7. the result is verified (the same login still reads the router, HyperProx's own service is still on, every
//       step shows in the tables, the internet path still answers when it did before); a failure puts everything back
//    8. the dead-man switch is removed. When HyperProx cannot reach the router the switch stays, and the router puts
//       itself back.
//    9. the change is written to the history with the exact operations that undo it
// =============================================================================

import { createHash, randomBytes } from 'node:crypto'
import { canonicalJson } from '../confirm'
import { checkLockout, type Snapshot } from './lockout'
import { checkRestore } from './plans'
import { findSelf, readInputs } from './inputs'
import { arr, guardOf, isTrue, matchRow } from './rows'
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

/** The lockout guard's view of the router. Any table the router does not answer is an error: no guard on half a picture. */
export async function readSnapshot(router: ChangeRouter): Promise<Snapshot> {
  const g = (p: string) => table(router, p)
  const [addresses, routes, services, users, interfaces, filter, arp, leases] = await Promise.all([
    g('/ip/address'), g('/ip/route'), g('/ip/service'), g('/user'), g('/interface'), g('/ip/firewall/filter'), g('/ip/arp'), g('/ip/dhcp-server/lease'),
  ])
  return { addresses, routes, services, users, interfaces, filter, arp, leases }
}

const idOf = (r: any): string | null => { const x = Array.isArray(r) ? r[0] : r; return x && typeof x['.id'] === 'string' ? x['.id'] : null }

/** Rows a `set` acts on: the ids captured when the switch was armed, else whatever matches `where`. */
function setRows(rows: Row[], op: Extract<Op, { kind: 'set' }>): Row[] {
  return op.ids?.length ? rows.filter(r => op.ids!.includes(String(r['.id']))) : rows.filter(r => matchRow(r, op.where))
}

/**
 * Run one operation. `inverse` is set when the operation puts something back: it is then safe to run twice (a row that
 * is already there is not added again), because the step it undoes may or may not have landed.
 */
async function runOp(router: ChangeRouter, op: Op, opts: { inverse?: boolean } = {}): Promise<void> {
  switch (op.kind) {
    case 'add': {
      if (opts.inverse && (await table(router, op.path)).some(r => matchRow(r, guardOf(op.props)))) return
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
      const rows = setRows(await table(router, op.path), op)
      if (!rows.length || (op.ids?.length && rows.length < op.ids.length)) throw new Error('The router no longer has the entry this change was going to edit.')
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

/** A row's value against a value the engine wrote: booleans in either spelling, an empty value meaning "not set". */
function propHolds(row: Row, k: string, v: string): boolean {
  if (v === '') return !row[k]
  if (v === 'true' || v === 'false' || v === 'yes' || v === 'no') return isTrue(row[k]) === isTrue(v)
  return String(row[k] ?? '') === v
}

/** Whether one operation that puts something back has taken effect: read from the router, not assumed. */
async function inverseHolds(router: ChangeRouter, op: Op): Promise<boolean> {
  switch (op.kind) {
    case 'remove': return !(await table(router, op.path)).some(r => matchRow(r, op.where))
    case 'add': return (await table(router, op.path)).some(r => matchRow(r, guardOf(op.props)))
    case 'set': { const rows = setRows(await table(router, op.path), op); return rows.length > 0 && rows.every(r => Object.entries(op.props).every(([k, v]) => propHolds(r, k, v))) }
    default: return true
  }
}

/**
 * Capture the router ids of the rows each `set` step will edit, and put them on the step's inverse, now, before the
 * safety switch is armed: the router's script then edits exactly those rows by id and never matches on a value. A
 * step that edits a row an earlier step of the same plan makes cannot be resolved yet; it has no inverse of its own.
 */
export async function captureIds(router: ChangeRouter, plan: ChangePlan): Promise<ChangePlan> {
  const steps: PlanStep[] = []
  for (const s of plan.steps) {
    const f = s.forward
    if (f.kind !== 'set') { steps.push(s); continue }
    const wantsIds = s.inverse.some(o => o.kind === 'set')
    const rows = (await table(router, f.path)).filter(r => f.ids?.length ? f.ids.includes(String(r['.id'])) && matchRow(r, f.where) : matchRow(r, f.where))
    if (!rows.length) {
      if (wantsIds || f.ids?.length) throw new ChangeRefusal(409, 'gone', 'The router no longer has the entry this change was going to edit, or it is not the same one any more. Nothing was changed.')
      steps.push(s); continue
    }
    const ids = rows.map(r => String(r['.id']))
    steps.push({ ...s, forward: { ...f, ids }, inverse: s.inverse.map(o => o.kind === 'set' && o.path === f.path ? { ...o, ids } : o) })
  }
  return { ...plan, steps }
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
    const all = await table(router, op.path)
    const rows = op.ids?.length ? setRows(all, op) : all.filter(r => matchRow(r, Object.fromEntries(Object.entries({ ...op.where, ...op.props }).filter(([k]) => !['time', 'disabled', 'comment'].includes(k) || (k in op.where && !(k in op.props))))))
    if (!rows.length) return false
    // The router writes a time in its own form, so a time is only checked when it was cleared.
    return rows.every(r => Object.entries(op.props).every(([k, v]) => (k === 'time' && v !== '') || propHolds(r, k, v)))
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

const READ_CHUNK = 32_768
const MAX_BACKUP_BYTES = 8 * 1024 * 1024

/** The whole file, chunk by chunk (the file table only ever shows the first 4 KB). Throws when it is not all there. */
async function readWhole(router: ChangeRouter, name: string, size: number): Promise<string> {
  if (!router.post) throw new Error('no read')
  const parts: Buffer[] = []
  let offset = 0
  while (offset < size) {
    const res = await router.post('/rest/file/read', { file: name, offset: String(offset), 'chunk-size': String(READ_CHUNK) }, 30_000)
    const row = Array.isArray(res) ? res[0] : res
    const data = typeof row?.data === 'string' ? row.data : ''
    if (!data) throw new Error('short read')
    const buf = Buffer.from(data, 'utf8')
    parts.push(buf); offset += buf.length
  }
  if (offset !== size) throw new Error('size mismatch')
  return Buffer.concat(parts).toString('utf8')
}

async function takeBackup(d: EngineDeps, id: string): Promise<HistoryEntry['backup']> {
  if (!d.router.post) throw new ChangeRefusal(409, 'no_backup', 'This connection cannot ask the router for a backup, so nothing was changed.')
  const name = `hyperprox-${id}`
  try {
    await d.router.post('/rest/export', { file: name }, 30_000)
    const f = arr(await d.router.get('/rest/file', t15)).find(x => x.name === `${name}.rsc`)
    const size = Number(f?.size)
    if (!f || !Number.isInteger(size) || size <= 0) throw new Error('empty export')
    if (size > MAX_BACKUP_BYTES) throw new Error('too large')
    const text = await readWhole(d.router, `${name}.rsc`, size)
    if (!text.trim()) throw new Error('empty export')
    await d.store.saveBackup(d.routerKey, id, text)
    return { id, bytes: Buffer.byteLength(text), truncated: false }
  } catch {
    throw new ChangeRefusal(409, 'backup_failed', 'HyperProx could not save the whole of the router\'s settings first, so nothing was changed. The router login needs the right to export its configuration and read files, and the export must fit (up to 8 MB).')
  } finally {
    // The router's copy goes whatever happened: a settings export left on the router is readable by anyone who can reach its files.
    try {
      for (const x of arr(await d.router.get('/rest/file', t15))) if (x.name === `${name}.rsc`) await d.router.delete(`/rest/file/${x['.id']}`)
    } catch { /* nothing more can be done from here */ }
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

class TooLate extends Error {}

async function applyNow(d: EngineDeps, requested: ChangePlan, opts: { undoOf?: string }): Promise<ApplyResult> {
  if (!requested.steps.length) throw new ChangeRefusal(409, 'nothing_to_do', 'There is nothing to change.')
  const now = d.now ?? Date.now
  const id = (d.newId ?? (() => randomBytes(4).toString('hex')))()

  // 1. refuse a plan that would cut the way in
  checkLockout(requested, d.management, await readSnapshot(d.router))

  // 2. audit first
  await d.audit('mikrotik.change.start', { id, kind: requested.kind, title: requested.title, steps: requested.steps.map(s => s.words), undoOf: opts.undoOf })
  const refused = async (e: any) => { await d.audit('mikrotik.change.refused', { id, error: String(e?.message ?? e).slice(0, 200) }).catch(() => {}); throw e }

  // 3-5. internet path, row ids, backup, safety switch: a failure here changes nothing
  const wasOnline = requested.checkWan ? await ping(d.router) : false
  let plan = requested
  try { plan = await captureIds(d.router, requested) } catch (e) { return refused(e) }
  const inverse = plan.steps.slice().reverse().flatMap(s => s.inverse)
  const entry: HistoryEntry = {
    id, at: new Date(now()).toISOString(), by: d.by, kind: plan.kind, title: plan.title, steps: plan.steps.map(s => s.words),
    status: 'applied', ops: plan.steps.map(s => ({ forward: s.forward, inverse: s.inverse })), ...(opts.undoOf ? { undoOf: opts.undoOf } : {}),
  }
  entry.backup = await takeBackup(d, id).catch(refused)
  // The clock is read inside armDeadMan and the router counts its 90 seconds from that reading, so the stopwatch starts first.
  const armedAt = now()
  try { await armDeadMan(d, id, inverse) } catch (e) { return refused(e) }
  const elapsed = () => (now() - armedAt) / 1000
  const tooLate = () => elapsed() > LATEST_CANCEL_SECONDS

  /** Too late to touch anything: the router's own switch is about to run (or has). Recorded as the router's doing, never as applied. */
  const leaveToRouter = async (what: string): Promise<never> => {
    entry.status = 'rolled-back'
    entry.note = `Undone by the router: ${what} The router's own safety switch puts the settings back by itself.`
    await d.store.save(d.routerKey, entry).catch(() => {})
    await d.audit('mikrotik.change.failed', { id, error: what, rollback: 'left to the router' }).catch(() => {})
    throw new Error(`${what} The router will undo the change by itself within a minute or two, so it is not kept.`)
  }

  // 6-7. apply, then verify. The step being run counts as attempted from the moment it is sent: an answer lost on
  // the way back does not mean the router did nothing.
  const attempted: PlanStep[] = []
  let problem: string | null = null
  try {
    for (const s of plan.steps) {
      if (tooLate()) throw new TooLate()
      attempted.push(s)
      await runOp(d.router, s.forward)
    }
    if (tooLate()) throw new TooLate()
    problem = await verify(d, plan, wasOnline)
  } catch (e: any) {
    problem = e instanceof TooLate ? 'HyperProx was taking too long.' : String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 300)
  }

  if (problem) {
    if (tooLate()) return leaveToRouter(`The change did not check out (${problem}) and there was no time left to put it back.`)
    let restored = false
    try {
      for (const s of attempted.slice().reverse()) for (const op of s.inverse) { if (tooLate()) throw new TooLate(); await runOp(d.router, op, { inverse: true }) }
      // Only a re-read says the router is as it was.
      restored = true
      for (const s of attempted) for (const op of s.inverse) if (!(await inverseHolds(d.router, op))) restored = false
    } catch (e) {
      if (e instanceof TooLate) return leaveToRouter(`The change did not check out (${problem}) and there was no time left to put it back.`)
      restored = false
    }
    if (restored) {
      if (tooLate()) return leaveToRouter(`The change did not check out (${problem}) and there was no time left to finish.`)
      await disarmDeadMan(d, id).catch(() => { restored = false })
    }
    entry.status = restored ? 'rolled-back' : 'failed'
    entry.note = problem
    await d.store.save(d.routerKey, entry).catch(() => {})
    await d.audit('mikrotik.change.failed', { id, error: problem, rolledBack: restored }).catch(() => {})
    throw new Error(restored
      ? `The change did not check out (${problem}), so HyperProx put it back and read the router again to check. The router is as it was.`
      : `The change did not check out (${problem}) and HyperProx could not confirm that it put everything back. The router will undo it by itself within ${DEAD_MAN_SECONDS} seconds.`)
  }

  // 8. verified: take the switch away, unless there is no time left to do it before the router fires
  if (tooLate()) return leaveToRouter('HyperProx took too long to confirm the change.')
  try { await disarmDeadMan(d, id) } catch {
    entry.status = 'failed'
    entry.note = 'The change was made, but HyperProx could not take its safety switch off the router, so the router may undo it by itself.'
    await d.store.save(d.routerKey, entry).catch(() => {})
    await d.audit('mikrotik.change.failed', { id, error: 'safety switch not removed' }).catch(() => {})
    throw new Error(`The change was made, but HyperProx could not take its safety switch off the router, so the router will undo it by itself within ${DEAD_MAN_SECONDS} seconds. Check the change history.`)
  }

  // 9. history
  await d.store.save(d.routerKey, entry).catch(() => {})
  await d.audit('mikrotik.change.done', { id, kind: plan.kind }).catch(() => {})
  return { id, message: `${plan.title}: done.`, steps: entry.steps }
}

// ── history and undo ─────────────────────────────────────────────────────────

export function historyView(list: HistoryEntry[]): HistoryView[] {
  const undone = new Set(list.filter(e => e.status === 'applied' && e.undoOf).map(e => e.undoOf))
  return list.map(({ ops, ...rest }) => ({ ...rest, canUndo: rest.status === 'applied' && !rest.undoOf && !undone.has(rest.id) && ops.some(o => o.inverse.length > 0) }))
}

/** The plan that puts one recorded change back, run through the same engine and checked like a new change. */
export async function undoPlan(d: Pick<EngineDeps, 'store' | 'routerKey' | 'router' | 'management'>, id: string): Promise<{ plan: ChangePlan; entry: HistoryEntry }> {
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
  // What it restores must still fit today's router: a port another forward took, an address given to someone else, a risky port.
  const inputs = await readInputs(d.router, d.management.wan)
  inputs.selfAddress = d.management.selfAddress
  const extra = checkRestore(inputs, steps)
  return { plan: { title: `Undo: ${entry.title}`, kind: 'undo', steps, warnings: extra.needsTick ? [extra.needsTick, ...extra.warnings] : extra.warnings, needsTick: extra.needsTick, checkWan: /^(forward|block)/.test(entry.kind) }, entry }
}

export async function undoChange(d: EngineDeps, id: string): Promise<ApplyResult> {
  const { plan } = await undoPlan(d, id)
  const res = await applyPlan(d, plan, { undoOf: id })
  const orig = (await d.store.list(d.routerKey)).find(e => e.id === id)
  if (orig) await d.store.save(d.routerKey, { ...orig, status: 'undone', undoneAt: new Date((d.now ?? Date.now)()).toISOString(), undoneBy: d.by })
  return res
}
