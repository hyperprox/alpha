// =============================================================================
//  HyperProx — HA insight: what the HA page and the guest panel say
//
//  Pure functions of a snapshot. Every finding is a sentence a person can act
//  on: who is protected, who stays down after a node failure, who has no home
//  to return to, whose hardware ties it to one node without a rule that says
//  so, and which keep-apart rules leave no room to lose a node.
// =============================================================================

import { hardwareWords, tiedToNode } from './parse'
import { allowedBy, homeOf, homeWords, list, ruleWords, validateRules, type HomeView } from './rules'
import { placement, predictFailover, type Prediction } from './predict'
import { gpuPortability } from './gpu'
import type { HaGuest, HaResource, HaRule, HaSnapshot, NodeAffinityRule, ResourceAffinityRule, RuleProblem, Sid } from './types'

export const labelOf = (snap: HaSnapshot) => (sid: Sid) => {
  const g = snap.guests.find(x => x.sid === sid)
  return g?.name ? `${g.name} (${g.vmid})` : sid
}

export function validateContext(snap: HaSnapshot) {
  return {
    haSids: new Set(snap.resources.map(r => r.sid)),
    guests: new Set(snap.guests.map(g => g.sid)),
    nodes: snap.nodes.map(n => n.node),
    label: labelOf(snap),
  }
}

// --- cluster status in words --------------------------------------------------------------------------

export interface ClusterWords { quorate: boolean; fencing: HaSnapshot['fencing']; headline: string; detail: string[] }

export function clusterWords(snap: HaSnapshot): ClusterWords {
  const online = snap.nodes.filter(n => n.online)
  const maint = snap.nodes.filter(n => n.maintenance)
  const detail: string[] = []
  let headline: string
  if (!snap.quorate) headline = 'The cluster has lost quorum: HA cannot move or restart anything, and HyperProx will not change HA settings until quorum is back.'
  else if (snap.fencing === 'armed') headline = 'HA is armed: a node that loses contact with the others is restarted (fenced) after about 2 minutes, and its HA guests are started elsewhere.'
  else if (snap.fencing === 'disarmed') headline = 'HA is disarmed: nodes are not fenced and guests are not recovered after a node failure.'
  else headline = snap.resources.length ? 'HA is idle: fencing is not active yet.' : 'HA is idle: no guest is protected, so nothing is fenced or recovered.'
  detail.push(`${online.length} of ${snap.nodes.length} nodes online${snap.quorate ? ', quorate' : ''}.`)
  if (snap.master) detail.push(`HA manager running on ${snap.master}.`)
  if (maint.length) detail.push(`In maintenance: ${list(maint.map(n => n.node))}. HA starts nothing there.`)
  detail.push(snap.crs.mode === 'basic'
    ? 'Placement: HA picks the node with the fewest HA guests.'
    : `Placement: HA picks the node with the most room (${snap.crs.mode} load)${snap.crs.autoRebalance ? ', and moves guests on its own to keep nodes balanced' : ''}.`)
  return { quorate: snap.quorate, fencing: snap.fencing, headline, detail }
}

// --- one guest ----------------------------------------------------------------------------------------

export interface GuestHa {
  sid:        Sid
  vmid:       number
  type:       'lxc' | 'qemu'
  name:       string
  node:       string
  status:     string
  protected:  boolean
  resource:   HaResource | null
  haState:    string | null
  home:       HomeView & { words: string }
  together:   Array<{ rule: string; with: Sid[]; disabled: boolean }>
  apart:      Array<{ rule: string; with: Sid[]; disabled: boolean }>
  prediction: Prediction | null
  /** The one line under the switch. */
  statusLine: string
  /** What ties it to its node, in words. */
  hardware:   string[]
  warnings:   string[]
  /** Informational: what a failover means for a guest whose hardware stays behind (a deliberate non-strict home). */
  notes:      string[]
}

/** "If node-c fails this will run on node-a without its GPU (…)", for a hardware-bound guest whose home is only preferred. */
export function hardwareNote(snap: HaSnapshot, sid: Sid): string | null {
  const g = snap.guests.find(x => x.sid === sid)
  const res = snap.resources.find(r => r.sid === sid)
  if (!g || !res || !tiedToNode(g.hardware)) return null
  const home = homeOf(snap.rules, sid)
  if (!home.rule || home.disabled || home.avoid.length || home.choice.mode !== 'prefer') return null
  if (!(home.choice.tiers[0] ?? []).includes(g.node)) return null   // that case is a warning, not a note
  const p = predictFailover(snap, sid)
  if (!p.to || p.to === g.node) return null
  const hw = g.hardware!
  const gpu = hw.devices.some(d => /GPU/.test(d.what))
  const without: string[] = []
  for (const d of hw.devices.filter(d => !/GPU/.test(d.what))) without.push(d.what)
  for (const b of hw.bindMounts) without.push(`its local bind mount (${b.path}), so it may not start there`)
  for (const l of hw.localVolumes) without.push(`its disk on node-local storage "${l.storage}", so it may not start there`)
  const gp = gpu ? gpuPortability(g) : { portable: false as const }
  if (gpu && gp.portable) {
    const there = gp.perNode[p.to] ?? null
    const head = there ? `If ${g.node} fails this runs on ${p.to} using its ${there}` : `If ${g.node} fails this runs on ${p.to} without a GPU`
    return `${head}${without.length ? `, and without ${list(without)}` : ''}.`
  }
  const parts = [...(gpu ? ['its GPU (GPU work such as transcoding falls back to the CPU)'] : []), ...without]
  return `If ${g.node} fails this will run on ${p.to} without ${list(parts)}.${gpu ? ` Turn on Portable GPU to use ${p.to}'s GPU there.` : ''}`
}

export function guestView(snap: HaSnapshot, sid: Sid): GuestHa | null {
  const g = snap.guests.find(x => x.sid === sid)
  if (!g) return null
  const res = snap.resources.find(r => r.sid === sid) ?? null
  const svc = snap.services.find(s => s.sid === sid)
  const home = homeOf(snap.rules, sid)
  const ra = snap.rules.filter((r): r is ResourceAffinityRule => r.type === 'resource-affinity' && r.resources.includes(sid))
  const node = svc?.node ?? g.node
  const prediction = res ? predictFailover(snap, sid) : null
  const hardware = hardwareWords(g.hardware)
  const v: GuestHa = {
    sid, vmid: g.vmid, type: g.type, name: g.name, node, status: g.status, protected: !!res, resource: res,
    haState: svc?.state ?? null, home: { ...home, words: home.disabled ? 'Its home rule is turned off, so it has no home right now.' : homeWords(home.choice, home.avoid) },
    together: ra.filter(r => r.affinity === 'positive').map(r => ({ rule: r.id, with: r.resources.filter(s => s !== sid), disabled: r.disabled })),
    apart: ra.filter(r => r.affinity === 'negative').map(r => ({ rule: r.id, with: r.resources.filter(s => s !== sid), disabled: r.disabled })),
    prediction, statusLine: '', hardware, warnings: [], notes: [],
  }
  v.statusLine = statusLine(snap, v)
  v.warnings = guestWarnings(snap, g, res, home)
  const note = hardwareNote(snap, sid)
  if (note) v.notes.push(note)
  return v
}

function statusLine(snap: HaSnapshot, v: GuestHa): string {
  if (!v.resource) {
    return v.status === 'running'
      ? `Running on ${v.node}. Not protected: if ${v.node} fails, this stays off until you start it.`
      : `Stopped on ${v.node}. Not protected: HA does not watch it.`
  }
  const st = v.haState ?? v.resource.state
  if (st === 'error') return `HA put this guest in an error state on ${v.node}: it failed to start too many times. Turn HA off for it, fix it, then turn HA on again.`
  if (st === 'fence' || st === 'recovery') return `${v.node} is being fenced; HA is recovering this guest elsewhere.`
  if (st === 'migrate' || st === 'relocate') return `HA is moving this guest off ${v.node} now.`
  if (v.resource.state === 'stopped' || st === 'stopped') return `Stopped on ${v.node}, and HA keeps it stopped. Start it here and HA starts it (and restarts it if its node fails).`
  if (v.resource.state === 'ignored') return `On ${v.node}. HA is ignoring this guest for now: nothing is restarted or moved.`
  if (v.resource.state === 'disabled') return `On ${v.node}. HA has this guest disabled: it is kept off and not recovered.`
  const top = v.home.choice.tiers[0] ?? []
  const where = !v.home.rule || v.home.disabled ? `Running on ${v.node}`
    : top.includes(v.node) ? `Running on ${v.node} — its home`
    : v.home.choice.tiers.flat().includes(v.node) ? `Running on ${v.node} — one of its fallback nodes${v.resource.failback ? `; it moves back to ${list(top, 'or')} when that is online` : ''}`
    : v.home.avoid.length ? `Running on ${v.node}`
    : `Running on ${v.node} — away from its home (${list(top, 'or')})${v.resource.failback ? '; it moves back when that node is online' : ''}`
  return `${where}. ${v.prediction?.words ?? ''}`.trim()
}

function guestWarnings(snap: HaSnapshot, g: HaGuest, res: HaResource | null, home: HomeView): string[] {
  const w: string[] = []
  if (!res) return w
  const tied = tiedToNode(g.hardware)
  const why = hardwareWords(g.hardware)
  if (!home.rule || home.disabled) {
    w.push(tied
      ? `No home, and it needs ${g.node}'s hardware (${list(why)}). After a failover it lands on a node without it and stays there. Give it a home on ${g.node}.`
      : 'No home: after a failover it stays on whichever node it lands on, indefinitely.')
  } else if (tied) {
    const top = home.choice.tiers[0] ?? []
    if (home.avoid.length || !top.includes(g.node)) {
      w.push(`It needs ${g.node}'s hardware (${list(why)}), but its home does not put ${g.node} first. Make ${g.node} its first choice.`)
    }
  }
  if (g.hardware?.bindMounts.length) w.push(`A local bind mount (${list(g.hardware.bindMounts.map(b => b.path))}) means it can fail over but can never be migrated back by hand; HA brings it home only by restarting it.`)
  if (res.group) w.push(`It still names the old HA group "${res.group}". Proxmox 9 replaced groups with rules; the group is ignored.`)
  return w
}

// --- the cluster page ---------------------------------------------------------------------------------

export interface Headroom {
  rule:     string
  guests:   Sid[]
  eligible: string[]
  online:   string[]
  slack:    number
  level:    'ok' | 'tight' | 'none' | 'broken'
  words:    string
}

/** Keep-apart rules: N guests across E eligible nodes leaves E-N nodes of slack. */
export function headroom(snap: HaSnapshot, rules: HaRule[] = snap.rules): Headroom[] {
  const clusterNodes = snap.nodes.map(n => n.node)
  const onlineSet = new Set(snap.nodes.filter(n => n.online && !n.maintenance).map(n => n.node))
  const out: Headroom[] = []
  for (const r of rules) {
    if (r.type !== 'resource-affinity' || r.affinity !== 'negative' || r.disabled) continue
    const eligible = new Set<string>()
    for (const s of r.resources) {
      const home = rules.find((x): x is NodeAffinityRule => x.type === 'node-affinity' && !x.disabled && x.resources.includes(s))
      const nodes = !home ? clusterNodes : home.strict ? allowedBy(home, clusterNodes) : clusterNodes
      nodes.forEach(n => eligible.add(n))
    }
    const el = [...eligible].sort()
    const on = el.filter(n => onlineSet.has(n))
    const n = r.resources.length
    const slack = el.length - n
    const level = on.length < n ? 'broken' : slack <= 0 ? 'none' : slack === 1 ? 'tight' : 'ok'
    const words = level === 'broken' ? `${n} guests kept apart, but only ${on.length} eligible node${on.length === 1 ? ' is' : 's are'} online: one of them has nowhere to run right now.`
      : level === 'none' ? `${n} guests kept apart across ${el.length} eligible nodes: zero slack. Lose one node and one guest has nowhere legal to start.`
      : level === 'tight' ? `${n} guests kept apart across ${el.length} eligible nodes: one node of slack. Lose two nodes and one guest has nowhere to start.`
      : `${n} guests kept apart across ${el.length} eligible nodes: ${slack} nodes of slack.`
    out.push({ rule: r.id, guests: r.resources, eligible: el, online: on, slack, level, words })
  }
  return out
}

export interface Overview {
  cluster:     ClusterWords
  nodes:       Array<{ node: string; online: boolean; maintenance: boolean; haGuests: number }>
  protected:   Array<{ sid: Sid; vmid: number; type: string; name: string; node: string; state: string; home: string; homeless: boolean; failover: string; to: string | null }>
  unprotected: Array<{ sid: Sid; vmid: number; type: string; name: string; node: string; status: string; words: string }>
  homeless:    Array<{ sid: Sid; name: string; node: string; words: string }>
  hardware:    Array<{ sid: Sid; name: string; node: string; needs: string[]; words: string }>
  /** Hardware-bound guests with a deliberately non-strict home: informational, not a warning. */
  hardwareNotes: Array<{ sid: Sid; name: string; node: string; words: string }>
  headroom:    Headroom[]
  rules:       Array<{ rule: HaRule; words: string; problems: RuleProblem[] }>
  problems:    RuleProblem[]
  counts:      { protected: number; unprotected: number; homeless: number; hardware: number; tightHeadroom: number }
}

export function overview(snap: HaSnapshot): Overview {
  const label = labelOf(snap)
  const place = placement(snap)
  const haSids = new Set(snap.resources.map(r => r.sid))
  const prot: Overview['protected'] = []
  const homeless: Overview['homeless'] = []
  const hardware: Overview['hardware'] = []
  const hardwareNotes: Overview['hardwareNotes'] = []
  for (const r of snap.resources) {
    const g = snap.guests.find(x => x.sid === r.sid)
    const v = guestView(snap, r.sid)
    const name = g?.name ?? r.sid
    const node = place.get(r.sid)?.node ?? g?.node ?? ''
    const home = homeOf(snap.rules, r.sid)
    const noHome = !home.rule || home.disabled
    const p = v?.prediction ?? null
    prot.push({ sid: r.sid, vmid: r.vmid, type: r.type, name, node, state: snap.services.find(s => s.sid === r.sid)?.state ?? r.state,
      home: noHome ? 'No home' : homeWords(home.choice, home.avoid), homeless: noHome, failover: p?.words ?? '', to: p?.to ?? null })
    if (noHome) homeless.push({ sid: r.sid, name, node, words: `${label(r.sid)}: no home. If ${node} fails it moves and never comes back on its own.` })
    const note = hardwareNote(snap, r.sid)
    if (note) hardwareNotes.push({ sid: r.sid, name, node, words: `${label(r.sid)}: ${note}` })
    if (g && tiedToNode(g.hardware)) {
      const top = home.choice.tiers[0] ?? []
      if (noHome || home.avoid.length || !top.includes(g.node)) {
        const needs = hardwareWords(g.hardware)
        hardware.push({ sid: r.sid, name, node: g.node, needs,
          words: `${label(r.sid)} needs ${g.node}'s hardware (${list(needs)}) but ${noHome ? 'has no home' : `its home puts ${list(top, 'or')} first`}. After a failover it can end up running without it.` })
      }
    }
  }
  const unprotected: Overview['unprotected'] = snap.guests.filter(g => !haSids.has(g.sid) && !g.template).map(g => ({
    sid: g.sid, vmid: g.vmid, type: g.type, name: g.name, node: g.node, status: g.status,
    words: g.status === 'running' ? `Stays down after a failure of ${g.node} until someone starts it.` : 'Stopped, and not watched by HA.',
  }))
  const ctx = validateContext(snap)
  const problems = validateRules(snap.rules, ctx)
  const hr = headroom(snap)
  return {
    cluster: clusterWords(snap),
    nodes: snap.nodes.map(n => ({ node: n.node, online: n.online, maintenance: n.maintenance, haGuests: snap.resources.filter(r => place.get(r.sid)?.node === n.node).length })),
    protected: prot, unprotected, homeless, hardware, hardwareNotes, headroom: hr,
    rules: [...snap.rules].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id)).map(rule => ({ rule, words: ruleWords(rule, label), problems: problems.filter(p => p.rules.includes(rule.id)) })),
    problems,
    counts: { protected: prot.length, unprotected: unprotected.length, homeless: homeless.length, hardware: hardware.length, tightHeadroom: hr.filter(h => h.level !== 'ok' && h.level !== 'tight').length },
  }
}

/** One small record per guest, for list badges. */
export interface Badge { sid: Sid; protected: boolean; state: string | null; home: 'none' | 'prefer' | 'only' | 'avoid'; homeNodes: string[]; warn: string | null }

export function badges(snap: HaSnapshot): Record<Sid, Badge> {
  const out: Record<Sid, Badge> = {}
  const ov = overview(snap)
  const warnBy = new Map<Sid, string>()
  for (const h of ov.hardware) warnBy.set(h.sid, h.words)
  for (const h of ov.homeless) if (!warnBy.has(h.sid)) warnBy.set(h.sid, h.words)
  for (const g of snap.guests) {
    const res = snap.resources.find(r => r.sid === g.sid)
    const home = homeOf(snap.rules, g.sid)
    const mode = !res || !home.rule || home.disabled ? 'none' : home.avoid.length ? 'avoid' : home.choice.mode
    out[g.sid] = { sid: g.sid, protected: !!res, state: res ? (snap.services.find(s => s.sid === g.sid)?.state ?? res.state) : null,
      home: mode, homeNodes: home.avoid.length ? home.avoid : (home.choice.tiers[0] ?? []), warn: res ? (warnBy.get(g.sid) ?? null) : null }
  }
  return out
}
