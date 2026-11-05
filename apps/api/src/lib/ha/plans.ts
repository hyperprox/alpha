// =============================================================================
//  HyperProx — HA writes: preview, then apply, then re-read
//
//  /etc/pve is replicated to every node on write, with no undo, and HA fencing
//  acts on what is written there. So a change is two calls:
//
//    preview  reads the cluster, works out the exact PVE API calls, checks the
//             resulting rule set the way PVE does (and refuses what PVE would
//             refuse, or would silently drop at runtime), and returns a
//             server-held plan: every change and its predicted effect in words
//             ("nothing moves now", "X will migrate to node B now").
//    apply    takes only that plan's id. Single use, ten minutes, the same
//             person. It refuses when the cluster is not quorate, and when the
//             HA configuration changed in any way since the preview. Then the
//             calls, through the PVE API only (never the files under
//             /etc/pve/ha), then a re-read compared with the plan.
//
//  Maintenance mode is the one change with no PVE API: it is a command
//  (`ha-manager crm-command node-maintenance`) run over the node login.
// =============================================================================

import { createHash, randomUUID } from 'node:crypto'
import { formBody, hardwareWords, parseSid, ruleParams, sidOf, tiedToNode } from './parse'
import { flatten, freeRuleId, homeOf, homeRule, homeWords, list, problemsOfChange, ruleWords, RULE_ID } from './rules'
import { headroom, labelOf, validateContext } from './insight'
import { moveNow, predictFailover } from './predict'
import { readSnapshot, type HaPve } from './read'
import { redactText } from './redact'
import { HaRefusal, type Actor, type HaResource, type HaRule, type HaSnapshot, type HomeChoice, type NodeAffinityRule, type RuleProblem, type Sid } from './types'

// --- requests -----------------------------------------------------------------------------------------

export type HaChange =
  | { action: 'protect'; sid: Sid; maxRestart?: number; maxRelocate?: number; state?: 'started' | 'stopped'; failback?: boolean; comment?: string }
  | { action: 'unprotect'; sid: Sid }
  | { action: 'update-resource'; sid: Sid; maxRestart?: number; maxRelocate?: number; failback?: boolean; autoRebalance?: boolean; comment?: string }
  | { action: 'set-state'; sid: Sid; state: 'started' | 'stopped' | 'disabled' | 'ignored' }
  | { action: 'set-home'; sid: Sid; home: HomeChoice; confirmStrict?: boolean }
  | { action: 'create-rule'; rule: HaRule; confirmStrict?: boolean }
  | { action: 'update-rule'; rule: HaRule; confirmStrict?: boolean }
  | { action: 'delete-rule'; ruleId: string }
  | { action: 'enable-rule'; ruleId: string }
  | { action: 'disable-rule'; ruleId: string }
  | { action: 'flatten'; ruleId: string }
  | { action: 'maintenance'; node: string; enable: boolean }

export type HaOp =
  | { kind: 'resource-create'; sid: Sid; params: Record<string, string> }
  | { kind: 'resource-set'; sid: Sid; params: Record<string, string> }
  | { kind: 'resource-delete'; sid: Sid }
  | { kind: 'rule-create'; rule: HaRule }
  | { kind: 'rule-set'; rule: HaRule; before: HaRule }
  | { kind: 'rule-delete'; ruleId: string }
  | { kind: 'maintenance'; node: string; enable: boolean }

export interface HaPlan {
  id:        string
  action:    HaChange['action']
  title:     string
  /** Each resource or rule change, in words. */
  changes:   string[]
  /** What happens to running guests the moment it is applied. */
  effects:   string[]
  warnings:  string[]
  /** True when the plan makes a guest strict ("only ever on…"): the UI shows it in red. */
  strict:    boolean
  /** Problems already in the rule set that this change neither causes nor fixes. */
  existing:  RuleProblem[]
  /** The exact PVE calls, for "Advanced". */
  calls:     string[]
  createdBy: string
  createdAt: string
  expiresAt: string
}

interface HeldPlan extends HaPlan {
  ops:         HaOp[]
  fingerprint: string
  expect:      { resources: HaResource[]; rules: HaRule[]; touchedSids: Sid[]; touchedRules: string[]; maintenance?: { node: string; enable: boolean } }
}

export interface HaApplyResult { ok: boolean; planId: string; message: string; mismatch: string[]; done: string[] }

export interface PlannerDeps {
  pve:      () => HaPve
  audit:    (action: string, resource: string, details: Record<string, unknown>) => Promise<void>
  /** Runs a command on a node over its stored login. Absent: maintenance mode is not offered. */
  nodeExec?: (node: string, command: string) => Promise<{ code: number; output: string }>
  hasNodeLogin?: (node: string) => Promise<boolean>
  now?:     () => number
  /** How long to wait for maintenance mode to show up in HA's status. */
  maintenanceWaitMs?: number
  sleep?:   (ms: number) => Promise<void>
  /** True while HyperProx is locked: the Proxmox token and node logins live in the vault, so nothing is written. */
  isLocked?: () => boolean
}

export const LOCKED_WRITE = 'HyperProx is locked — sign in to change HA settings. Nothing was changed.'

const TTL_MS = 10 * 60_000

// --- fingerprint --------------------------------------------------------------------------------------

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().filter(k => (v as any)[k] !== undefined).map(k => `${JSON.stringify(k)}:${stable((v as any)[k])}`).join(',')}}`
  return JSON.stringify(v ?? null)
}
const normRule = (r: HaRule) => ({ ...r, order: undefined, resources: [...r.resources].sort(), ...(r.type === 'node-affinity' ? { nodes: [...r.nodes].sort((a, b) => a.node.localeCompare(b.node)) } : {}) })

/** The HA configuration as it bears on a plan: every resource and every rule, and which nodes are in maintenance. */
export function fingerprint(s: HaSnapshot): string {
  const basis = {
    resources: [...s.resources].sort((a, b) => a.sid.localeCompare(b.sid)),
    rules: [...s.rules].map(normRule).sort((a, b) => a.id.localeCompare(b.id)),
    maintenance: s.nodes.filter(n => n.maintenance).map(n => n.node).sort(),
  }
  return createHash('sha256').update(stable(basis)).digest('hex')
}

// --- words --------------------------------------------------------------------------------------------

const DEFAULTS = {
  maxRestart: 'Restart tries on the same node before moving it: 1. One retry covers a hiccup; more only delays the move.',
  maxRelocate: 'Moves to another node if it still will not start: 1. One move, then HA stops trying and marks it as failed.',
  state: 'Kept running: HA starts it if it is off, and restarts it elsewhere if its node fails.',
}

function callWords(op: HaOp): string {
  switch (op.kind) {
    case 'resource-create': return `POST /cluster/ha/resources ${formBody(op.params)}`
    case 'resource-set': return `PUT /cluster/ha/resources/${op.sid} ${formBody(op.params)}`
    case 'resource-delete': return `DELETE /cluster/ha/resources/${op.sid} purge=1`
    case 'rule-create': return `POST /cluster/ha/rules ${formBody(ruleParams(op.rule))}`
    case 'rule-set': return `PUT /cluster/ha/rules/${op.rule.id} ${formBody({ ...ruleParams(op.rule, true), ...deletesFor(op.rule, op.before) })}`
    case 'rule-delete': return `DELETE /cluster/ha/rules/${op.ruleId}`
    case 'maintenance': return `on ${op.node}: ha-manager crm-command node-maintenance ${op.enable ? 'enable' : 'disable'} ${op.node}`
  }
}

function deletesFor(rule: HaRule, before: HaRule): Record<string, string> {
  const del: string[] = []
  if (before.disabled && !rule.disabled) del.push('disable')
  if (before.comment && !rule.comment) del.push('comment')
  return del.length ? { delete: del.join(',') } : {}
}

const intIn = (v: unknown, name: string, d: number) => {
  if (v === undefined || v === null || v === '') return d
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > 10) throw new HaRefusal(`${name} is a whole number from 0 to 10.`, 400)
  return n
}
const NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/

// --- the planner --------------------------------------------------------------------------------------

export class HaPlanner {
  private plans = new Map<string, HeldPlan>()
  constructor(private d: PlannerDeps) {}
  private now() { return (this.d.now ?? Date.now)() }
  private sweep() { const t = this.now(); for (const [k, p] of this.plans) if (Date.parse(p.expiresAt) < t) this.plans.delete(k) }

  async preview(req: HaChange, actor: Actor): Promise<HaPlan> {
    this.sweep()
    if (this.d.isLocked?.()) throw new HaRefusal(LOCKED_WRITE, 423)
    if (!req || typeof req !== 'object' || typeof (req as any).action !== 'string') throw new HaRefusal('Say what to change (action).', 400)
    const snap = await readSnapshot(this.d.pve())
    if (!snap.quorate) throw new HaRefusal('The cluster is not quorate. HyperProx changes nothing in HA until quorum is back.', 409)
    const built = await this.build(snap, req)
    const plan: HeldPlan = {
      ...built, id: randomUUID(), action: req.action, calls: built.ops.map(callWords), createdBy: actor.email,
      createdAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + TTL_MS).toISOString(), fingerprint: fingerprint(snap),
    }
    this.plans.set(plan.id, plan)
    return publicPlan(plan)
  }

  /** Checks a draft rule without holding a plan: the editor calls this as the person types. */
  async check(rule: HaRule, replacing: string | null): Promise<{ blocking: RuleProblem[]; existing: RuleProblem[]; words: string; headroom: ReturnType<typeof headroom> }> {
    if (this.d.isLocked?.()) throw new HaRefusal(LOCKED_WRITE, 423)
    const snap = await readSnapshot(this.d.pve(), { configs: 'none' })
    const r = normaliseRule(rule)
    const after = [...snap.rules.filter(x => x.id !== (replacing ?? r.id)), r]
    const res = problemsOfChange(snap.rules, after, [r.id], validateContext(snap))
    if (!replacing && snap.rules.some(x => x.id === r.id)) res.blocking.unshift({ code: 'duplicate-id', rules: [r.id], message: `There is already a rule called "${r.id}".` })
    return { ...res, words: ruleWords(r, labelOf(snap)), headroom: headroom(snap, after).filter(h => h.rule === r.id) }
  }

  private async build(snap: HaSnapshot, req: HaChange): Promise<Omit<HeldPlan, 'id' | 'action' | 'calls' | 'createdBy' | 'createdAt' | 'expiresAt' | 'fingerprint'>> {
    const label = labelOf(snap)
    const ops: HaOp[] = []
    const changes: string[] = []
    const effects: string[] = []
    const warnings: string[] = []
    let resources = [...snap.resources]
    let rules = [...snap.rules]
    const touchedSids: Sid[] = []
    const touchedRules: string[] = []
    let strict = false
    let title = ''
    let maintenance: { node: string; enable: boolean } | undefined
    let existingProblems: RuleProblem[] = []

    const guestOf = (sid: unknown) => {
      const s = String(sid ?? '')
      const g = snap.guests.find(x => x.sid === s)
      if (!parseSid(s) || !g) throw new HaRefusal(`There is no guest ${s}.`, 404)
      return g
    }
    const resourceOf = (sid: Sid) => {
      const r = snap.resources.find(x => x.sid === sid)
      if (!r) throw new HaRefusal(`${label(sid)} is not protected by HA.`, 409)
      return r
    }
    const ruleOf = (id: unknown) => {
      const r = snap.rules.find(x => x.id === String(id ?? ''))
      if (!r) throw new HaRefusal(`There is no HA rule "${String(id)}".`, 404)
      return r
    }
    const setRule = (rule: HaRule, before: HaRule | null) => {
      if (before) { ops.push({ kind: 'rule-set', rule, before }); rules = rules.map(r => r.id === rule.id ? rule : r) }
      else { ops.push({ kind: 'rule-create', rule }); rules = [...rules, rule] }
      touchedRules.push(rule.id)
    }
    const dropRule = (id: string) => { ops.push({ kind: 'rule-delete', ruleId: id }); rules = rules.filter(r => r.id !== id); touchedRules.push(id) }

    switch (req.action) {
      case 'protect': {
        const g = guestOf(req.sid)
        if (g.template) throw new HaRefusal(`${label(g.sid)} is a template; templates cannot be HA guests.`, 409)
        if (snap.resources.some(r => r.sid === g.sid)) throw new HaRefusal(`${label(g.sid)} is already protected.`, 409)
        const maxRestart = intIn(req.maxRestart, 'Restart tries', 1)
        const maxRelocate = intIn(req.maxRelocate, 'Moves to another node', 1)
        const state = req.state === 'stopped' ? 'stopped' : 'started'
        const params: Record<string, string> = { sid: g.sid, state, max_restart: String(maxRestart), max_relocate: String(maxRelocate) }
        if (req.failback === false) params.failback = '0'
        if (req.comment) params.comment = String(req.comment).slice(0, 200)
        ops.push({ kind: 'resource-create', sid: g.sid, params })
        const res: HaResource = { sid: g.sid, type: g.type === 'lxc' ? 'ct' : 'vm', vmid: g.vmid, state, maxRestart, maxRelocate, failback: req.failback !== false, autoRebalance: true, ...(params.comment ? { comment: params.comment } : {}) }
        resources = [...resources, res]
        touchedSids.push(g.sid)
        title = `Protect ${label(g.sid)}`
        changes.push(`Turn on automatic restart for ${label(g.sid)}: if ${g.node} fails, HA starts it on another node.`)
        changes.push(state === 'started' ? DEFAULTS.state : 'Kept stopped: HA watches it but does not start it until you do.')
        changes.push(maxRestart === 1 ? DEFAULTS.maxRestart : `Restart tries on the same node before moving it: ${maxRestart}.`)
        changes.push(maxRelocate === 1 ? DEFAULTS.maxRelocate : `Moves to another node if it still will not start: ${maxRelocate}.`)
        if (state === 'started' && g.status !== 'running') effects.push(`HA starts ${label(g.sid)} on ${g.node} now.`)
        else effects.push(`Nothing moves now: ${label(g.sid)} stays ${g.status === 'running' ? 'running' : 'stopped'} on ${g.node}.`)
        const after = { ...snap, resources }
        effects.push(predictFailover(after, g.sid).words)
        if (!homeOf(rules, g.sid).rule) warnings.push(`It has no home yet: after a failover it stays wherever it lands. Give it a home next${tiedToNode(g.hardware) ? `; it needs ${g.node}'s hardware (${list(hardwareWords(g.hardware))})` : ''}.`)
        if (g.hardware?.bindMounts.length) warnings.push(`It has a local bind mount (${list(g.hardware.bindMounts.map(b => b.path))}). HA can restart it elsewhere only if that path exists on the other node too.`)
        break
      }
      case 'unprotect': {
        const g = guestOf(req.sid)
        resourceOf(g.sid)
        title = `Stop protecting ${label(g.sid)}`
        changes.push(`Turn off automatic restart for ${label(g.sid)}.`)
        // A keep-together/apart rule left with one guest does nothing: remove it first, and say so.
        for (const r of snap.rules.filter(r => r.type === 'resource-affinity' && r.resources.includes(g.sid) && r.resources.length <= 2)) {
          dropRule(r.id)
          changes.push(`Remove rule "${r.id}" (${ruleWords(r, label)}): with only one guest left it would do nothing.`)
        }
        ops.push({ kind: 'resource-delete', sid: g.sid })
        resources = resources.filter(r => r.sid !== g.sid)
        touchedSids.push(g.sid)
        // purge=1: PVE takes the guest out of every other rule, and deletes a rule it was the only guest in.
        for (const r of rules.filter(r => r.resources.includes(g.sid))) {
          const rest = r.resources.filter(s => s !== g.sid)
          touchedRules.push(r.id)
          if (!rest.length) { rules = rules.filter(x => x.id !== r.id); changes.push(`Remove rule "${r.id}" (${ruleWords(r, label)}): it was only about this guest.`) }
          else { rules = rules.map(x => x.id === r.id ? { ...x, resources: rest } as HaRule : x); changes.push(`Take ${label(g.sid)} out of rule "${r.id}".`) }
        }
        effects.push(`Nothing moves now: ${label(g.sid)} keeps ${g.status === 'running' ? 'running' : 'its state'} on ${g.node}.`)
        effects.push(`From now on, if ${g.node} dies, this stays off until you start it.`)
        break
      }
      case 'update-resource': {
        const g = guestOf(req.sid)
        const cur = resourceOf(g.sid)
        const params: Record<string, string> = {}
        const next = { ...cur }
        if (req.maxRestart !== undefined) { next.maxRestart = intIn(req.maxRestart, 'Restart tries', 1); if (next.maxRestart !== cur.maxRestart) { params.max_restart = String(next.maxRestart); changes.push(`Restart tries on the same node: ${cur.maxRestart} → ${next.maxRestart}.`) } }
        if (req.maxRelocate !== undefined) { next.maxRelocate = intIn(req.maxRelocate, 'Moves to another node', 1); if (next.maxRelocate !== cur.maxRelocate) { params.max_relocate = String(next.maxRelocate); changes.push(`Moves to another node when it will not start: ${cur.maxRelocate} → ${next.maxRelocate}.`) } }
        if (req.failback !== undefined && !!req.failback !== cur.failback) { next.failback = !!req.failback; params.failback = next.failback ? '1' : '0'; changes.push(next.failback ? 'Return home automatically when the home node is back: on.' : 'Return home automatically: off. After a failover it stays where it landed until you move it.') }
        if (req.autoRebalance !== undefined && !!req.autoRebalance !== cur.autoRebalance) { next.autoRebalance = !!req.autoRebalance; params['auto-rebalance'] = next.autoRebalance ? '1' : '0'; changes.push(next.autoRebalance ? 'HA may move it to balance load: on.' : 'HA may move it to balance load: off.') }
        if (req.comment !== undefined && String(req.comment) !== (cur.comment ?? '')) { const c = String(req.comment).slice(0, 200); if (c) { params.comment = c; next.comment = c } else { params.delete = 'comment'; delete next.comment }; changes.push('Change the note on it.') }
        if (!changes.length) throw new HaRefusal('Nothing would change.', 400)
        ops.push({ kind: 'resource-set', sid: g.sid, params })
        resources = resources.map(r => r.sid === g.sid ? next : r)
        touchedSids.push(g.sid)
        title = `Change HA settings of ${label(g.sid)}`
        const mv = next.failback && !cur.failback ? moveNow({ ...snap, resources }, g.sid, rules) : null
        effects.push(mv?.to ? `${label(g.sid)} will migrate to ${mv.to} now (${mv.why}).` : 'Nothing moves now.')
        break
      }
      case 'set-state': {
        const g = guestOf(req.sid)
        const cur = resourceOf(g.sid)
        if (!['started', 'stopped', 'disabled', 'ignored'].includes(req.state)) throw new HaRefusal('The state is started, stopped, disabled or ignored.', 400)
        if (cur.state === req.state) throw new HaRefusal(`${label(g.sid)} is already ${req.state} in HA.`, 400)
        ops.push({ kind: 'resource-set', sid: g.sid, params: { state: req.state } })
        resources = resources.map(r => r.sid === g.sid ? { ...r, state: req.state } : r)
        touchedSids.push(g.sid)
        title = `${req.state === 'started' ? 'Start' : req.state === 'stopped' ? 'Stop' : req.state === 'disabled' ? 'Disable' : 'Ignore'} ${label(g.sid)} through HA`
        changes.push(`HA state of ${label(g.sid)}: ${cur.state} → ${req.state}.`)
        effects.push(
          req.state === 'started' ? (g.status === 'running' ? 'Nothing moves now: it is already running.' : `HA starts ${label(g.sid)} on ${g.node} now.`)
          : req.state === 'stopped' ? (g.status === 'running' ? `HA shuts ${label(g.sid)} down now (forced off if it does not stop in time), and keeps it off on every node.` : 'Nothing moves now: it is already off, and HA keeps it off.')
          : req.state === 'disabled' ? `HA stops ${label(g.sid)} now and will not recover it until it is enabled again.`
          : `HA leaves ${label(g.sid)} alone from now on: no restarts, no moves, until you set it back.`)
        break
      }
      case 'set-home': {
        const g = guestOf(req.sid)
        resourceOf(g.sid)
        const choice = normaliseHome(req.home, snap)
        const cur = homeOf(snap.rules, g.sid)
        title = `Home for ${label(g.sid)}`
        if (choice.mode === 'none') {
          if (!cur.rule) throw new HaRefusal(`${label(g.sid)} has no home already.`, 400)
          if (cur.sharedWith.length) {
            setRule({ ...cur.rule, resources: cur.rule.resources.filter(s => s !== g.sid) } as HaRule, cur.rule)
            changes.push(`Take ${label(g.sid)} out of home rule "${cur.rule.id}"; ${list(cur.sharedWith.map(label))} keep${cur.sharedWith.length === 1 ? 's' : ''} it.`)
          } else {
            dropRule(cur.rule.id)
            changes.push(`Remove home rule "${cur.rule.id}".`)
          }
          changes.push('No home: after a failover it stays wherever it lands.')
        } else {
          const strictBefore = !!cur.rule && cur.rule.strict && cur.rule.affinity === 'positive'
          if (choice.mode === 'only') {
            strict = true
            if (!req.confirmStrict) throw new HaRefusal('"Only ever run on…" means the guest stays off when those nodes are down. Confirm it to continue.', 400)
          }
          if (cur.rule && !cur.sharedWith.length) {
            const next: NodeAffinityRule = { ...homeRule(g.sid, cur.rule.id, choice, cur.rule.comment), order: cur.rule.order }
            setRule(next, cur.rule)
            changes.push(`Change home rule "${cur.rule.id}": ${homeWords(choice)}`)
          } else {
            if (cur.rule) {
              setRule({ ...cur.rule, resources: cur.rule.resources.filter(s => s !== g.sid) } as HaRule, cur.rule)
              changes.push(`Take ${label(g.sid)} out of the home rule "${cur.rule.id}" it shares with ${list(cur.sharedWith.map(label))}.`)
            }
            const id = freeRuleId(rules, `home-${g.vmid}`)
            setRule(homeRule(g.sid, id, choice), null)
            changes.push(`Add home rule "${id}": ${homeWords(choice)}`)
          }
          if (choice.mode === 'only' && !strictBefore) warnings.push(`Strict: if ${list(choice.tiers.flat(), 'and')} ${choice.tiers.flat().length > 1 ? 'are all' : 'is'} down, ${label(g.sid)} does not start anywhere. That turns a preference into an outage.`)
          const top = choice.tiers[0] ?? []
          if (tiedToNode(g.hardware) && !top.includes(g.node)) warnings.push(`It needs ${g.node}'s hardware (${list(hardwareWords(g.hardware))}), but ${g.node} is not its first choice.`)
        }
        break
      }
      case 'create-rule':
      case 'update-rule': {
        const rule = normaliseRule(req.rule)
        const before = req.action === 'update-rule' ? ruleOf(rule.id) : null
        if (req.action === 'create-rule' && snap.rules.some(r => r.id === rule.id)) throw new HaRefusal(`There is already a rule called "${rule.id}".`, 409)
        if (before && before.type !== rule.type) throw new HaRefusal('A rule keeps its type; delete it and create a new one instead.', 400)
        if (rule.type === 'node-affinity' && rule.strict && rule.affinity === 'positive') {
          strict = true
          if (!req.confirmStrict) throw new HaRefusal('A strict rule keeps its guests off when its nodes are down. Confirm it to continue.', 400)
        }
        if (before && stable(normRule(before)) === stable(normRule({ ...rule, order: before.order }))) throw new HaRefusal('Nothing would change.', 400)
        setRule(before ? { ...rule, order: before.order } : rule, before)
        title = `${before ? 'Change' : 'Add'} rule "${rule.id}"`
        changes.push(`${before ? 'Change' : 'Add'} rule "${rule.id}": ${ruleWords(rule, label)}`)
        if (rule.type === 'node-affinity' && rule.strict && rule.affinity === 'positive' && !(before?.type === 'node-affinity' && before.strict)) {
          warnings.push(`Strict: if ${list(rule.nodes.map(n => n.node), 'and')} are all down, ${list(rule.resources.map(label))} do${rule.resources.length === 1 ? 'es' : ''} not start anywhere.`)
        }
        for (const h of headroom(snap, rules).filter(h => h.rule === rule.id && h.level !== 'ok')) warnings.push(h.words)
        break
      }
      case 'delete-rule': {
        const r = ruleOf(req.ruleId)
        dropRule(r.id)
        title = `Remove rule "${r.id}"`
        changes.push(`Remove rule "${r.id}" (${ruleWords(r, label)}).`)
        if (r.type === 'node-affinity' && r.affinity === 'positive') for (const s of r.resources) if (snap.resources.some(x => x.sid === s)) {
          warnings.push(`${label(s)} will have no home: after a failover it stays wherever it lands.`)
        }
        break
      }
      case 'enable-rule':
      case 'disable-rule': {
        const r = ruleOf(req.ruleId)
        const disabled = req.action === 'disable-rule'
        if (r.disabled === disabled) throw new HaRefusal(`Rule "${r.id}" is already ${disabled ? 'off' : 'on'}.`, 400)
        setRule({ ...r, disabled } as HaRule, r)
        title = `${disabled ? 'Turn off' : 'Turn on'} rule "${r.id}"`
        changes.push(`${disabled ? 'Turn off' : 'Turn on'} rule "${r.id}" (${ruleWords({ ...r, disabled: false } as HaRule, label)}).`)
        if (disabled) changes.push('A rule that is off is kept, but does nothing, until it is turned on again.')
        break
      }
      case 'flatten': {
        const r = ruleOf(req.ruleId)
        if (r.type !== 'node-affinity' || new Set(r.nodes.map(n => n.priority)).size <= 1) throw new HaRefusal(`Rule "${r.id}" has no first and second choices to flatten.`, 400)
        const flat = flatten(r)
        setRule(flat, r)
        title = `Flatten the priorities of "${r.id}"`
        changes.push(`Make every node in "${r.id}" an equal choice: ${list(r.nodes.map(n => n.node))}.`)
        changes.push(`${list(r.resources.map(label))} no longer prefer${r.resources.length === 1 ? 's' : ''} one of them over the others; this is what lets ${r.resources.length === 1 ? 'it' : 'them'} be kept together with or apart from other guests.`)
        break
      }
      case 'maintenance': {
        const node = String(req.node ?? '')
        const n = snap.nodes.find(x => x.node === node)
        if (!NODE_NAME.test(node) || !n) throw new HaRefusal(`There is no node ${node}.`, 404)
        const enable = !!req.enable
        if (n.maintenance === enable) throw new HaRefusal(`${node} is ${enable ? 'already' : 'not'} in maintenance mode.`, 400)
        if (!this.d.nodeExec || !(await (this.d.hasNodeLogin?.(node) ?? Promise.resolve(false)))) {
          throw new HaRefusal(`Proxmox has no API for maintenance mode, so HyperProx runs it over ${node}'s login. Add a login for ${node} (Terminal → node logins) first.`, 409)
        }
        if (enable && !n.online) throw new HaRefusal(`${node} is offline.`, 409)
        ops.push({ kind: 'maintenance', node, enable })
        maintenance = { node, enable }
        title = `${enable ? 'Put' : 'Take'} ${node} ${enable ? 'into' : 'out of'} maintenance mode`
        changes.push(enable ? `Maintenance mode on ${node}: HA moves its guests away first, and starts nothing there until it is turned off.` : `Maintenance mode off on ${node}: HA uses it again.`)
        const place = new Map(snap.services.map(s => [s.sid, s.node]))
        const here = snap.resources.filter(r => place.get(r.sid) === node)
        if (enable) {
          if (!here.length) effects.push(`Nothing moves: no HA guest is on ${node}.`)
          for (const r of here) {
            const p = predictFailover(snap, r.sid, node)
            effects.push(p.to ? `${label(r.sid)} will migrate to ${p.to} now.` : `${label(r.sid)} has nowhere it is allowed to go, so it stays on ${node}.`)
          }
          const others = snap.guests.filter(g => g.node === node && g.status === 'running' && !snap.resources.some(r => r.sid === g.sid))
          if (others.length) warnings.push(`${others.length} running guest${others.length === 1 ? ' is' : 's are'} not HA-managed and stay${others.length === 1 ? 's' : ''} on ${node}: ${list(others.slice(0, 8).map(g => label(g.sid)))}${others.length > 8 ? ', …' : ''}. Shut ${others.length === 1 ? 'it' : 'them'} down yourself before rebooting.`)
          effects.push('Turn it off when you are done: until then the node takes no HA guests.')
        } else {
          const back = snap.resources.filter(r => r.failback && homeOf(snap.rules, r.sid).choice.tiers[0]?.includes(node) && place.get(r.sid) !== node)
          effects.push(back.length ? `Guests whose home is ${node} move back now: ${list(back.map(r => label(r.sid)))}.` : 'Nothing moves now.')
        }
        break
      }
      default:
        throw new HaRefusal(`Unknown action "${(req as any).action}".`, 400)
    }

    // The resulting rule set, checked the way PVE checks it: refuse what PVE refuses or would silently drop.
    if (touchedRules.length || req.action === 'protect' || req.action === 'unprotect') {
      const ctx = { ...validateContext(snap), haSids: new Set(resources.map(r => r.sid)) }
      const { blocking, existing } = problemsOfChange(snap.rules, rules, touchedRules, ctx)
      if (blocking.length) throw new HaRefusal(blocking.map(b => b.message).join(' '), 409, blocking)
      existingProblems = existing
      // Rule changes: who moves the moment it is applied.
      if (touchedRules.length && req.action !== 'unprotect') {
        const after = { ...snap, resources, rules }
        const affected = new Set<Sid>()
        for (const id of touchedRules) for (const r of [...snap.rules, ...rules].filter(x => x.id === id)) r.resources.forEach(s => affected.add(s))
        const moves: string[] = []
        for (const sid of affected) {
          if (!resources.some(r => r.sid === sid && r.state === 'started')) continue
          const mv = moveNow(after, sid, rules)
          if (!mv) continue
          const g = snap.guests.find(x => x.sid === sid)
          const restart = g?.type === 'lxc' && g.status === 'running' ? ' (a container moves with a restart: a short outage)' : ''
          moves.push(mv.to ? `${label(sid)} will migrate to ${mv.to} now: ${mv.why}${restart}.` : `${label(sid)} will move now: ${mv.why}.`)
        }
        effects.push(...(moves.length ? moves : ['Nothing moves now.']))
        for (const sid of affected) if (resources.some(r => r.sid === sid)) effects.push(`${label(sid)}: ${predictFailover(after, sid).words}`)
        if (snap.crs.autoRebalance && moves.length === 0) effects.push('HA may still move guests later on its own to balance load (automatic rebalancing is on).')
      }
    }
    return { title, changes, effects, warnings, strict, existing: existingProblems, ops, expect: { resources, rules, touchedSids, touchedRules, ...(maintenance ? { maintenance } : {}) } }
  }

  async apply(planId: string, actor: Actor): Promise<HaApplyResult> {
    this.sweep()
    const plan = this.plans.get(String(planId))
    if (!plan) throw new HaRefusal('That preview has expired or was already used; preview the change again.', 410)
    if (plan.createdBy !== actor.email) throw new HaRefusal('That preview belongs to someone else.', 403)
    this.plans.delete(plan.id)   // single use, whatever happens next
    if (this.d.isLocked?.()) {
      await this.d.audit(`ha.${plan.action}`, 'ha', { by: actor.email, ok: false, refused: 'locked', plan: plan.title })
      throw new HaRefusal(LOCKED_WRITE, 423)
    }
    const pve = this.d.pve()
    const now = await readSnapshot(pve, { configs: 'none' })
    if (!now.quorate) {
      await this.d.audit(`ha.${plan.action}`, 'ha', { by: actor.email, ok: false, refused: 'not quorate', plan: plan.title })
      throw new HaRefusal('The cluster is not quorate. Nothing was changed.', 409)
    }
    if (fingerprint(now) !== plan.fingerprint) {
      await this.d.audit(`ha.${plan.action}`, 'ha', { by: actor.email, ok: false, refused: 'changed since preview', plan: plan.title })
      throw new HaRefusal('The HA configuration changed after the preview. Nothing was changed; preview again.', 409)
    }
    const done: string[] = []
    let digests = { ...now.digests }
    try {
      for (const op of plan.ops) {
        await runOp(pve, op, digests, this.d)
        done.push(callWords(op))
        // Each write changes the file's digest; the next set must carry the new one.
        if (op.kind.startsWith('rule') || op.kind.startsWith('resource')) {
          const fresh = await readSnapshot(pve, { configs: 'none' })
          digests = { ...fresh.digests }
        }
      }
    } catch (e: any) {
      const why = redactText(String(e?.message ?? e))
      await this.d.audit(`ha.${plan.action}`, 'ha', { by: actor.email, ok: false, error: why, done, plan: plan.title })
      const partial = done.length ? ` These calls had already gone through: ${done.join('; ')}.` : ' Nothing was changed.'
      return { ok: false, planId: plan.id, message: `Proxmox refused: ${why}.${partial}`, mismatch: [], done }
    }
    if (plan.expect.maintenance) await this.waitMaintenance(plan.expect.maintenance)
    const after = await readSnapshot(pve, { configs: 'none' })
    const mismatch = compare(plan.expect, after)
    const ok = mismatch.length === 0
    await this.d.audit(`ha.${plan.action}`, 'ha', { by: actor.email, ok, mismatch, done, plan: plan.title, changes: plan.changes })
    return {
      ok, planId: plan.id, done, mismatch,
      message: ok ? `Done, and read back from Proxmox: ${plan.title}.` : `The change was sent, but Proxmox does not show what was planned: ${mismatch.join('; ')}.`,
    }
  }

  private async waitMaintenance(m: { node: string; enable: boolean }) {
    const sleep = this.d.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))
    const until = this.now() + (this.d.maintenanceWaitMs ?? 30_000)
    while (this.now() < until) {
      const s = await readSnapshot(this.d.pve(), { configs: 'none' })
      if (s.nodes.find(n => n.node === m.node)?.maintenance === m.enable) return
      await sleep(2000)
    }
  }

  /** For tests. */
  get size() { return this.plans.size }
}

function publicPlan(p: HeldPlan): HaPlan {
  const { ops: _o, fingerprint: _f, expect: _e, ...pub } = p
  return pub
}

function normaliseHome(h: any, snap: HaSnapshot): HomeChoice {
  const mode = h?.mode === 'only' || h?.mode === 'prefer' ? h.mode : 'none'
  if (mode === 'none') return { mode, tiers: [] }
  const known = new Set(snap.nodes.map(n => n.node))
  const seen = new Set<string>()
  const tiers: string[][] = (Array.isArray(h?.tiers) ? h.tiers : []).map((t: unknown) => (Array.isArray(t) ? t : [t]).map(String).filter(n => {
    if (!known.has(n)) throw new HaRefusal(`There is no node ${n}.`, 400)
    if (seen.has(n)) return false
    seen.add(n); return true
  })).filter((t: string[]) => t.length)
  if (!tiers.length) throw new HaRefusal('Pick at least one node.', 400)
  return { mode, tiers }
}

export function normaliseRule(r: any): HaRule {
  if (!r || typeof r !== 'object') throw new HaRefusal('Describe the rule.', 400)
  const id = String(r.id ?? '').trim()
  if (!RULE_ID.test(id)) throw new HaRefusal('Give the rule a name: start with a letter, then letters, digits, - or _.', 400)
  const resources = Array.from(new Set((Array.isArray(r.resources) ? r.resources : []).map((s: unknown) => String(s).trim()).filter(Boolean))) as Sid[]
  for (const s of resources) if (!parseSid(s)) throw new HaRefusal(`"${s}" is not a guest (use ct:<id> or vm:<id>).`, 400)
  const comment = r.comment ? String(r.comment).slice(0, 200) : undefined
  const base = { id, resources, disabled: !!r.disabled, ...(comment ? { comment } : {}) }
  if (r.type === 'node-affinity') {
    const nodes = (Array.isArray(r.nodes) ? r.nodes : []).map((n: any) => ({ node: String(n?.node ?? n).trim(), priority: Number.isInteger(Number(n?.priority ?? 0)) ? Number(n?.priority ?? 0) : 0 }))
    for (const n of nodes) {
      if (!NODE_NAME.test(n.node)) throw new HaRefusal(`"${n.node}" is not a node name.`, 400)
      if (n.priority < 0 || n.priority > 1000) throw new HaRefusal('Priorities are whole numbers from 0 to 1000.', 400)
    }
    return { ...base, type: 'node-affinity', affinity: r.affinity === 'negative' ? 'negative' : 'positive', strict: !!r.strict, nodes }
  }
  if (r.type === 'resource-affinity') return { ...base, type: 'resource-affinity', affinity: r.affinity === 'negative' ? 'negative' : 'positive' }
  throw new HaRefusal('A rule is node-affinity (where it runs) or resource-affinity (together or apart).', 400)
}

async function runOp(pve: HaPve, op: HaOp, digests: HaSnapshot['digests'], d: PlannerDeps): Promise<void> {
  const enc = encodeURIComponent
  switch (op.kind) {
    case 'resource-create': await pve.fetchStrict('/cluster/ha/resources', 'POST', formBody(op.params)); return
    case 'resource-set': await pve.fetchStrict(`/cluster/ha/resources/${enc(op.sid)}`, 'PUT', formBody({ ...op.params, ...(digests.resources ? { digest: digests.resources } : {}) })); return
    case 'resource-delete': await pve.fetchStrict(`/cluster/ha/resources/${enc(op.sid)}?purge=1`, 'DELETE'); return
    case 'rule-create': await pve.fetchStrict('/cluster/ha/rules', 'POST', formBody(ruleParams(op.rule))); return
    case 'rule-set': await pve.fetchStrict(`/cluster/ha/rules/${enc(op.rule.id)}`, 'PUT', formBody({ ...ruleParams(op.rule, true), ...deletesFor(op.rule, op.before), ...(digests.rules ? { digest: digests.rules } : {}) })); return
    case 'rule-delete': await pve.fetchStrict(`/cluster/ha/rules/${enc(op.ruleId)}`, 'DELETE'); return
    case 'maintenance': {
      if (!d.nodeExec) throw new Error('no node login')
      if (!NODE_NAME.test(op.node)) throw new Error('bad node name')
      const r = await d.nodeExec(op.node, `ha-manager crm-command node-maintenance ${op.enable ? 'enable' : 'disable'} ${op.node}`)
      if (r.code !== 0) throw new Error(`ha-manager answered ${r.code}: ${r.output.trim().slice(0, 300)}`)
      return
    }
  }
}

/** The plan's expected HA configuration against what Proxmox now has, for the guests and rules it touched. */
function compare(expect: HeldPlan['expect'], after: HaSnapshot): string[] {
  const out: string[] = []
  for (const sid of expect.touchedSids) {
    const want = expect.resources.find(r => r.sid === sid)
    const got = after.resources.find(r => r.sid === sid)
    if (!want && got) out.push(`${sid} is still an HA resource`)
    else if (want && !got) out.push(`${sid} is not an HA resource`)
    else if (want && got) {
      for (const k of ['state', 'maxRestart', 'maxRelocate', 'failback', 'autoRebalance'] as const) if (want[k] !== got[k]) out.push(`${sid} ${k} is ${got[k]}, planned ${want[k]}`)
      if ((want.comment ?? '') !== (got.comment ?? '')) out.push(`${sid} note differs`)
    }
  }
  for (const id of expect.touchedRules) {
    const want = expect.rules.find(r => r.id === id)
    const got = after.rules.find(r => r.id === id)
    if (!want && got) out.push(`rule "${id}" is still there`)
    else if (want && !got) out.push(`rule "${id}" is missing`)
    else if (want && got && stable({ ...normRule(want), order: undefined }) !== stable({ ...normRule(got), order: undefined })) out.push(`rule "${id}" is not what was planned`)
  }
  if (expect.maintenance) {
    const n = after.nodes.find(x => x.node === expect.maintenance!.node)
    if (n?.maintenance !== expect.maintenance.enable) out.push(`${expect.maintenance.node} is ${n?.maintenance ? '' : 'not '}in maintenance mode yet (HA can take a minute; check the HA page)`)
  }
  return out
}

/** sid helper for routes. */
export { sidOf }
