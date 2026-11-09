// =============================================================================
//  HyperProx — actions the assistant prepares, on any cluster
//
//  A request such as "restart plex on the remote" is read here, by code, into a small template: what to do,
//  which cluster, which guest, and for some actions one more field (a backup storage, a snapshot name, a
//  folder). A field that is missing or ambiguous is asked for, with the real choices; the model is never asked
//  to pick a target. When every field is known, the server checks it against the cluster right now and keeps
//  the plan (PreparedStore): the browser only ever holds its id.
//
//  A plan is bound to one cluster: its id, the certificate fingerprint it was planned under, and for a guest the
//  Proxmox config digest. Applying it is refused unless the apply request is for that same cluster (its
//  X-HyperProx-Cluster header), the cluster's connection is unchanged, and the guest's config is unchanged.
//
//  Applying goes through the same functions the Command center's buttons call (lib/clusters/guest-actions,
//  monitoring, files), each of which reads its result back from Proxmox or the node. The role and the master
//  password re-confirmation are decided by lib/roles.ts for the route the same action has in the UI, so the
//  assistant can never do more than the person could do by hand, and never skips a re-confirmation for them.
//  A delete also needs the guest's name typed. The audit entry names who, what and which cluster; never a value.
// =============================================================================

import type { ProxmoxClient } from '../proxmox-client'
import type { Role } from '../roles'
import { requiredRole, needsReconfirm, hasRole } from '../roles'
import type { ClusterRow } from '../clusters/store'
import type { PreparedStore } from './prepared'
import { resolveTargets, withoutClusterWords, type ClusterRef } from './clusters'
import type { GuestType, PowerAction } from '../clusters/guest-actions'
import { GuestActionRefusal } from '../clusters/guest-actions'

export type GuestVerb = 'start' | 'stop' | 'shutdown' | 'reboot' | 'snapshot' | 'backup' | 'delete'
export type ActionKind = GuestVerb | 'copy' | 'monitoring-install' | 'monitoring-remove'

export interface ParsedAction {
  kind: ActionKind
  /** The words naming the guest, or for a copy the folder, as typed. */
  target: string
  /** The text the cluster is read from (for a copy, each end has its own). */
  where: string
  snapName?: string
  copyFrom?: string
  copyTo?: string
  /** Choices already made by a follow-up: "from node X", "onto node Y", "into /path". */
  srcNode?: string
  dstNode?: string
  dstPath?: string
}

// ---------------------------------------------------------------------------
//  Reading the request
// ---------------------------------------------------------------------------

const LEAD = /^\s*((please|ok|okay|hey|now|then|so|go ahead and|can you|could you|would you|will you|i want to|i'd like to|i would like to|i need to|let's)\b[\s,]*)+/i

const VERBS: Array<[GuestVerb, RegExp]> = [
  ['backup',   /^(?:back\s*up|backup|take\s+a\s+backup\s+of|make\s+a\s+backup\s+of)\s+(.+)$/i],
  ['snapshot', /^(?:snapshot|snap|take\s+a\s+snapshot\s+of|make\s+a\s+snapshot\s+of)\s+(.+)$/i],
  ['reboot',   /^(?:restart|reboot|bounce)\s+(.+)$/i],
  ['shutdown', /^(?:shut\s*down|shutdown)\s+(.+)$/i],
  ['stop',     /^(?:stop|power\s+off|turn\s+off|halt|kill)\s+(.+)$/i],
  ['start',    /^(?:start\s+up|start|boot|power\s+on|turn\s+on)\s+(.+)$/i],
  ['delete',   /^(?:delete|destroy|remove|purge)\s+(.+)$/i],
]

/** The first sentence, without politeness or a trailing full stop. */
function head(prompt: string): string {
  const first = prompt.trim().split(/(?<=[.!?;])\s+/)[0] ?? ''
  return first.replace(/[.!?;]+$/, '').replace(LEAD, '').trim()
}

/** A request to act, read by code; null when it is not one (questions, deploys and everything else). */
export function parseAction(prompt: string): ParsedAction | null {
  const first = prompt.trim().split(/(?<=[.!?;])\s+/)[0] ?? ''
  // "Restart plex?" asks about it; "Can you restart plex?" asks for it.
  if (/\?\s*$/.test(first) && !/^\s*(please\s+)?(can|could|would|will)\s+you\b/i.test(first)) return null
  let p = head(prompt)
  if (!p) return null
  const choices: Partial<ParsedAction> = {}
  p = p.replace(/\s+from\s+node\s+([A-Za-z0-9][A-Za-z0-9.-]*)\b/i, (_m, n) => { choices.srcNode = n; return '' })
       .replace(/\s+onto\s+node\s+([A-Za-z0-9][A-Za-z0-9.-]*)\b/i, (_m, n) => { choices.dstNode = n; return '' })
       .replace(/\s+into\s+(\/\S+)/i, (_m, d) => { choices.dstPath = d; return '' }).trim()

  if (/\bmonitoring\b/i.test(p)) {
    if (/^(install|set\s*up|add|turn\s+on|enable|put|start)\b/i.test(p)) return { kind: 'monitoring-install', target: '', where: p, ...choices }
    if (/^(remove|uninstall|turn\s+off|disable|take\s+off|stop)\b/i.test(p)) return { kind: 'monitoring-remove', target: '', where: p, ...choices }
    return null
  }
  const copy = /^(?:copy|send)\s+(.+)\s+to\s+(.+)$/i.exec(p)
  if (copy) {
    const from = /^(.+?)\s+from\s+(.+)$/i.exec(copy[1])
    return { kind: 'copy', target: (from ? from[1] : copy[1]).trim(), where: p, copyFrom: from ? from[2].trim() : undefined, copyTo: copy[2].trim(), ...choices }
  }
  for (const [kind, re] of VERBS) {
    const m = re.exec(p)
    if (!m) continue
    let target = m[1]
    let snapName: string | undefined
    if (kind === 'snapshot') target = target.replace(/\s+(?:called|named|as)\s+([A-Za-z][\w-]{1,39})\s*$/i, (_x, n) => { snapName = n; return '' })
    return { kind, target, where: p, ...(snapName ? { snapName } : {}), ...choices }
  }
  return null
}

/** The guest words alone: cluster words, "now", articles and guest-type words taken out. */
export function guestWords(target: string, clusters: ClusterRef[]): string {
  return withoutClusterWords(target, clusters)
    .replace(/\s+(?:to|on|onto|in)\s+storage\s+\S+/ig, ' ')
    .replace(/\b(right\s+now|now|please|immediately|for\s+me|again)\b/ig, ' ')
    .replace(/\b(the|my|our|a|an)\b/ig, ' ')
    .replace(/\b(guest|container|vm|ct|lxc|virtual\s+machine|machine|server)\b/ig, ' ')
    .replace(/[.,!?]+/g, ' ').replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
//  Plans
// ---------------------------------------------------------------------------

export interface GuestRef { node: string; type: GuestType; vmid: number; name: string }

export interface ActionPlan {
  kind: ActionKind
  owner: string
  /** The cluster the plan acts on: the apply request must be for this cluster. */
  clusterId: string
  clusterName: string
  clusterKind: 'home' | 'remote'
  /** The certificate fingerprint the remote was planned under (null for home). */
  fingerprint: string | null
  guest?: GuestRef
  /** Proxmox's config digest of the guest when this was planned. */
  digest?: string
  snapName?: string
  storage?: string
  monitoringPlanId?: string
  copyPreviewId?: string
  /** A copy: the other end, checked the same way. */
  peer?: { id: string; name: string; fingerprint: string | null }
}

export interface ActionCard {
  planId: string
  action: ActionKind
  cluster: ClusterRef
  /** A copy's source cluster, when it is not the destination. */
  from?: ClusterRef
  title: string
  words: string
  steps: string[]
  needsReconfirm: boolean
  /** A delete: the guest's name, typed exactly to confirm. */
  typedName: string | null
  role: Role
}

/** The route the same action has in the UI: lib/roles.ts decides its role and re-confirmation from it. */
export function uiRouteFor(plan: Pick<ActionPlan, 'kind' | 'clusterId' | 'guest'>): string {
  const enc = encodeURIComponent
  if (plan.kind === 'copy') return '/api/clusters/files/jobs'
  if (plan.kind === 'monitoring-install' || plan.kind === 'monitoring-remove') return `/api/clusters/${enc(plan.clusterId)}/monitoring/apply`
  const g = plan.guest!
  const leafOf: Record<GuestVerb, string> = { start: 'power', stop: 'power', shutdown: 'power', reboot: 'power', snapshot: 'snapshot', backup: 'backup', delete: 'delete' }
  return `/api/clusters/${enc(plan.clusterId)}/guests/${enc(g.node)}/${g.type}/${g.vmid}/${leafOf[plan.kind as GuestVerb]}`
}

export const LOCKED_SAY = 'HyperProx is locked, so I did nothing. Sign in to unlock it, then ask again.'

export type PrepareResult =
  | { kind: 'card'; card: ActionCard }
  | { kind: 'say'; message: string; choices?: string[] }

export interface PrepareDeps {
  inCluster<T>(id: string, fn: () => Promise<T>): Promise<T>
  /** The client of the cluster the caller runs in (pveFromEnv); only called inside inCluster. */
  pve(): Pick<ProxmoxClient, 'fetchStrict'>
  row(id: string): ClusterRow | null
  unlocked(): boolean
  prepared: PreparedStore<ActionPlan>
  backupStorages(node: string): Promise<Array<{ storage: string }>>
  monitoringPreview(clusterId: string, owner: string, kind: 'install' | 'remove'): Promise<{ planId: string; steps: string[] }>
  copyPreview(owner: string, input: { src: { cluster: string; node: string; path: string }; dst: { cluster: string; node: string; path: string }; speedKBps: number; plexScan: boolean }): Promise<{ previewId: string; words: string }>
  /** Online nodes of the cluster the caller runs in. */
  nodes(): Promise<string[]>
  now(): Date
}

export interface Who { owner: string; role: Role | undefined; current: ClusterRef; clusters: ClusterRef[] }

const VERB_WORDS: Record<GuestVerb, [string, string]> = {
  start: ['Start', 'start it'], stop: ['Stop', 'stop it (a hard stop, like pulling the plug)'], shutdown: ['Shut down', 'shut it down cleanly'],
  reboot: ['Restart', 'restart it'], snapshot: ['Snapshot', 'take a snapshot'], backup: ['Back up', 'back it up now'], delete: ['Delete', 'delete it and its disks'],
}

const kindWord = (t: GuestType) => (t === 'lxc' ? 'CT' : 'VM')
const say = (message: string, choices?: string[]): PrepareResult => ({ kind: 'say', message, ...(choices?.length ? { choices } : {}) })

/** Refuses what the person's role could not do by hand. Null when it is allowed. */
function roleRefusal(plan: Pick<ActionPlan, 'kind' | 'clusterId' | 'guest'>, role: Role | undefined): string | null {
  const need = requiredRole('POST', uiRouteFor(plan)) ?? 'viewer'
  if (role && hasRole(role, need)) return null
  return `That needs the ${need} role${role ? `, and you are signed in as ${role}` : ''}, so I did not prepare it.`
}

function card(plan: ActionPlan, id: string, title: string, words: string, steps: string[], from?: ClusterRef): ActionCard {
  const route = uiRouteFor(plan)
  return {
    planId: id, action: plan.kind, cluster: { id: plan.clusterId, name: plan.clusterName, kind: plan.clusterKind }, ...(from ? { from } : {}),
    title, words, steps, needsReconfirm: needsReconfirm('POST', route), typedName: plan.kind === 'delete' ? plan.guest!.name : null,
    role: requiredRole('POST', route) ?? 'viewer',
  }
}

const where = (c: ClusterRef) => (c.kind === 'home' ? `${c.name} (home)` : `${c.name} (remote)`)

/** Prepare `a` for the person in `who`. Every read runs in the target cluster's context. */
export async function prepareAction(prompt: string, a: ParsedAction, who: Who, d: PrepareDeps): Promise<PrepareResult> {
  if (!d.unlocked()) return say(LOCKED_SAY)
  if (a.kind === 'copy') return prepareCopy(prompt, a, who, d)

  const t = resolveTargets(a.where, who.clusters, who.current)
  if (t.kind === 'ask') return say(t.message, t.choices.map(n => `${prompt.replace(/[.!?]+$/, '')} on ${n}`))
  if (t.clusters.length !== 1) return say('I act on one cluster at a time. Name the one you mean.', t.clusters.map(c => `${prompt.replace(/[.!?]+$/, '')} on ${c.name}`))
  const c = t.clusters[0]
  const row = d.row(c.id)
  if (!row) return say('That cluster was removed. Nothing was prepared.')
  const base = { owner: who.owner, clusterId: c.id, clusterName: c.name, clusterKind: c.kind, fingerprint: row.certFingerprint ?? null }

  if (a.kind === 'monitoring-install' || a.kind === 'monitoring-remove') {
    if (c.kind === 'home') return say('Monitoring on the home cluster is set up in Settings -> Setup checklist, not by the assistant. Nothing was prepared.')
    const plan0: ActionPlan = { kind: a.kind, ...base }
    const refused = roleRefusal(plan0, who.role)
    if (refused) return say(refused)
    let pv: { planId: string; steps: string[] }
    try { pv = await d.monitoringPreview(c.id, who.owner, a.kind === 'monitoring-install' ? 'install' : 'remove') }
    catch (e: any) { return say(`I could not prepare that on ${c.name}: ${plainError(e)}`) }
    const plan: ActionPlan = { ...plan0, monitoringPlanId: pv.planId }
    const id = d.prepared.put(who.owner, plan)
    const title = `${a.kind === 'monitoring-install' ? 'Install' : 'Remove'} monitoring on ${c.name}`
    return { kind: 'card', card: card(plan, id, title, `${title}. This runs on ${c.name}'s nodes over their saved logins, then reads the result back.`, pv.steps) }
  }

  // A guest action.
  const verb = a.kind as GuestVerb
  const words = guestWords(a.target, who.clusters)
  let guests: Array<{ vmid: number; node: string; type: GuestType; name: string; status: string }>
  try {
    guests = await d.inCluster(c.id, async () => ((await d.pve().fetchStrict<any[]>('/cluster/resources?type=vm')) ?? [])
      .filter(r => (r?.type === 'lxc' || r?.type === 'qemu') && Number(r.template ?? 0) !== 1)
      .map(r => ({ vmid: Number(r.vmid), node: String(r.node), type: r.type as GuestType, name: String(r.name ?? ''), status: String(r.status ?? '') })))
  } catch (e: any) { return say(`I could not read the guests on ${c.name}: ${plainError(e)} Nothing was prepared.`) }

  const retry = (g: { name: string; vmid: number }) => `${VERB_WORDS[verb][0].toLowerCase()} ${g.name || g.vmid} on ${c.name}`
  if (!words) {
    const some = guests.slice().sort((x, y) => x.vmid - y.vmid).slice(0, 8)
    return say(`Which guest on ${c.name} should I ${VERB_WORDS[verb][0].toLowerCase()}? I act on one guest at a time.`, some.map(retry))
  }
  const id = /^\d+$/.test(words) ? Number(words) : null
  let hits = id !== null ? guests.filter(g => g.vmid === id) : guests.filter(g => g.name.toLowerCase() === words.toLowerCase())
  if (!hits.length && id === null) {
    const w = new RegExp(`(^|[^a-z0-9])${words.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`)
    hits = guests.filter(g => w.test(g.name.toLowerCase()))
  }
  if (!hits.length) return say(`I could not find a guest called "${words}" on ${c.name}. Nothing was prepared.`)
  if (hits.length > 1) return say(`More than one guest on ${c.name} matches "${words}". Which one?`, hits.slice(0, 8).map(g => `${VERB_WORDS[verb][0].toLowerCase()} ${g.vmid} on ${c.name}`))
  const g0 = hits[0]
  const guest: GuestRef = { node: g0.node, type: g0.type, vmid: g0.vmid, name: g0.name || String(g0.vmid) }
  const plan0: ActionPlan = { kind: verb, ...base, guest }
  const refused = roleRefusal(plan0, who.role)
  if (refused) return say(refused)

  const label = `${guest.name} (${kindWord(guest.type)} ${guest.vmid} on ${guest.node})`
  if (verb === 'start' && g0.status === 'running') return say(`${label} on ${c.name} is already running. Nothing was prepared.`)
  if ((verb === 'stop' || verb === 'shutdown') && g0.status === 'stopped') return say(`${label} on ${c.name} is already stopped. Nothing was prepared.`)
  if (verb === 'reboot' && g0.status !== 'running') return say(`${label} on ${c.name} is ${g0.status || 'not running'}, so there is nothing to restart. Ask me to start it instead.`)
  if (verb === 'delete' && g0.status !== 'stopped') return say(`${label} on ${c.name} is ${g0.status}. Stop it first, then ask me to delete it.`)

  const extra: Partial<ActionPlan> = {}
  const steps: string[] = []
  try {
    await d.inCluster(c.id, async () => {
      const cfg = await d.pve().fetchStrict<any>(`/nodes/${encodeURIComponent(guest.node)}/${guest.type}/${guest.vmid}/config`)
      if (!cfg) throw new GuestActionRefusal('No such guest on that node.', 'not-found')
      extra.digest = String(cfg.digest ?? '')
      if (verb === 'backup') {
        const stores = await d.backupStorages(guest.node)
        if (!stores.length) throw new GuestActionRefusal(`No storage on ${guest.node} takes backups.`)
        const named = stores.filter(s => new RegExp(`\\b${s.storage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(a.where))
        if (named.length === 1) extra.storage = named[0].storage
        else if (stores.length === 1) extra.storage = stores[0].storage
        else throw Object.assign(new Error('ask'), { ask: stores.map(s => s.storage) })
      }
    })
  } catch (e: any) {
    if (Array.isArray(e?.ask)) return say(`Which storage on ${guest.node} should the backup of ${guest.name} go to?`, e.ask.map((s: string) => `back up ${guest.vmid} on ${c.name} to storage ${s}`))
    return say(`I could not prepare that on ${c.name}: ${plainError(e)}`)
  }
  if (verb === 'snapshot') {
    const now = d.now(), p2 = (n: number) => String(n).padStart(2, '0')
    extra.snapName = a.snapName ?? `ai-${now.getUTCFullYear()}${p2(now.getUTCMonth() + 1)}${p2(now.getUTCDate())}-${p2(now.getUTCHours())}${p2(now.getUTCMinutes())}`
  }
  const plan: ActionPlan = { ...plan0, ...extra }
  const planId = d.prepared.put(who.owner, plan)
  const title = `${VERB_WORDS[verb][0]} ${guest.name} on ${c.name}`
  const what: Record<GuestVerb, string> = {
    start: 'Proxmox is asked to start it; the answer is its state read back.',
    stop: 'Proxmox is asked to stop it at once (not a clean shutdown); the answer is its state read back.',
    shutdown: 'Proxmox is asked to shut it down cleanly; the answer is its state read back.',
    reboot: 'Proxmox is asked to restart it; the answer is its state read back.',
    snapshot: `A snapshot named ${extra.snapName} is taken; the answer is the snapshot list read back.`,
    backup: `A backup to ${extra.storage} starts now; it can take a while, and its task is followed.`,
    delete: 'The guest and its disks are deleted for good. Type its name to confirm; the answer checks it is gone.',
  }
  steps.push(`${label} on ${where(c)}.`, what[verb])
  return { kind: 'card', card: card(plan, planId, title, `${title}. ${what[verb]}`, steps) }
}

async function prepareCopy(prompt: string, a: ParsedAction, who: Who, d: PrepareDeps): Promise<PrepareResult> {
  const pick = (text: string | undefined): { c: ClusterRef } | { no: PrepareResult } => {
    if (!text) return { c: who.current }
    const t = resolveTargets(/\b(on|to|from|in)\b/i.test(text) ? text : `on ${text}`, who.clusters, who.current)
    if (t.kind === 'ask') return { no: say(t.message) }
    if (t.clusters.length !== 1 || !t.named) return { no: say(`I could not tell which cluster "${text}" is. Your clusters are: ${who.clusters.map(c => c.name).join(', ')}.`) }
    return { c: t.clusters[0] }
  }
  const dp = pick(a.copyTo); if ('no' in dp) return dp.no
  const sp = pick(a.copyFrom); if ('no' in sp) return sp.no
  const dst = dp.c, src = sp.c
  const dRow = d.row(dst.id), sRow = d.row(src.id)
  if (!dRow || !sRow) return say('That cluster was removed. Nothing was prepared.')
  const base = { owner: who.owner, clusterId: dst.id, clusterName: dst.name, clusterKind: dst.kind, fingerprint: dRow.certFingerprint ?? null }
  const plan0: ActionPlan = { kind: 'copy', ...base, peer: { id: src.id, name: src.name, fingerprint: sRow.certFingerprint ?? null } }
  const refused = roleRefusal(plan0, who.role)
  if (refused) return say(refused)

  const folder = a.target.replace(/\b(the|my|our)\b/ig, ' ').replace(/\b(folders?|directory|files?)\b/ig, ' ').replace(/\s+/g, ' ').trim()
  if (!folder) return say('Which folder should I copy?')
  const again = prompt.replace(/[.!?]+$/, '')
  // The source path: an absolute one as given, else the folder inside one of the source's allowed folders.
  let srcPath: string
  if (folder.startsWith('/')) srcPath = folder
  else {
    if (!sRow.allowedRoots.length) return say(`No folders are allowed for copies on ${src.name} yet. An admin adds them in Command center -> ${src.name} -> Edit server.`)
    const cands = sRow.allowedRoots.map(r => `${r}/${folder}`)
    if (cands.length > 1) return say(`Which ${folder} on ${src.name}?`, cands.map(p => again.replace(folder, p)))
    srcPath = cands[0]
  }
  let dstPath = a.dstPath
  if (!dstPath) {
    if (!dRow.allowedRoots.length) return say(`No folders are allowed for copies on ${dst.name} yet. An admin adds them in Command center -> ${dst.name} -> Edit server.`)
    if (dRow.allowedRoots.length > 1) return say(`Into which folder on ${dst.name}?`, dRow.allowedRoots.map(r => `${again} into ${r}`))
    dstPath = dRow.allowedRoots[0]
  }
  let srcNodes: string[], dstNodes: string[]
  try {
    srcNodes = await d.inCluster(src.id, () => d.nodes())
    dstNodes = await d.inCluster(dst.id, () => d.nodes())
  } catch (e: any) { return say(`I could not read the nodes: ${plainError(e)} Nothing was prepared.`) }
  const srcNode = a.srcNode ?? (srcNodes.length === 1 ? srcNodes[0] : undefined)
  if (!srcNode || !srcNodes.includes(srcNode)) return say(`Which node of ${src.name} holds ${folder}?`, srcNodes.map(n => `${again} from node ${n}`))
  const dstNode = a.dstNode ?? (dstNodes.length === 1 ? dstNodes[0] : undefined)
  if (!dstNode || !dstNodes.includes(dstNode)) return say(`Which node of ${dst.name} should receive it?`, dstNodes.map(n => `${again} onto node ${n}`))

  let pv: { previewId: string; words: string }
  try {
    pv = await d.copyPreview(who.owner, { src: { cluster: src.id, node: srcNode, path: srcPath }, dst: { cluster: dst.id, node: dstNode, path: dstPath }, speedKBps: 0, plexScan: false })
  } catch (e: any) { return say(`I could not prepare that copy: ${plainError(e)}`) }
  const plan: ActionPlan = { ...plan0, copyPreviewId: pv.previewId }
  const id = d.prepared.put(who.owner, plan)
  const title = `Copy ${folder} from ${src.name} to ${dst.name}`
  return { kind: 'card', card: card(plan, id, title, `${title}. ${pv.words}`, [`From ${srcNode}:${srcPath} on ${where(src)}.`, `To ${dstNode}:${dstPath} on ${where(dst)}.`, pv.words], src.id === dst.id ? undefined : src) }
}

/** An error in plain words: never a stack, and the message only as the refusals word it. */
export function plainError(e: any): string {
  if (e?.name === 'VaultLockedError') return 'HyperProx is locked.'
  const m = String(e?.message ?? e ?? 'unknown error').replace(/\s+/g, ' ').trim()
  return /[.!?]$/.test(m) ? m : `${m}.`
}

// ---------------------------------------------------------------------------
//  Applying
// ---------------------------------------------------------------------------

export interface ApplyDeps {
  prepared: PreparedStore<ActionPlan>
  owner: string
  /** The signed-in person (or token) asking: their session id and role. */
  ctx: { sid: string; role: Role } | undefined
  /** The cluster this apply request is for (its X-HyperProx-Cluster header; home without one). */
  requestCluster: string
  row(id: string): ClusterRow | null
  unlocked(): boolean
  reconfirmed(sid: string): boolean
  inCluster<T>(id: string, fn: () => Promise<T>): Promise<T>
  pve(): ProxmoxClient
  ops: {
    power(pve: ProxmoxClient, g: { node: string; type: GuestType; vmid: number }, action: PowerAction): Promise<{ ok: boolean; words: string }>
    snapshot(pve: ProxmoxClient, g: { node: string; type: GuestType; vmid: number }, name: string): Promise<{ ok: boolean; words: string }>
    backupNow(pve: ProxmoxClient, g: { node: string; type: GuestType; vmid: number }, storage: string): Promise<{ upid: string; node: string }>
    destroy(pve: ProxmoxClient, g: { node: string; type: GuestType; vmid: number }, confirmName: string): Promise<{ ok: boolean; words: string }>
  }
  applyMonitoring(planId: string, owner: string, clusterId: string): Promise<{ ok: boolean; results: Array<{ node: string; status: string; reason: string }>; checks: Array<{ ok: boolean; words: string }> }>
  startCopy(previewId: string, owner: string): Promise<{ id: string; state: string }>
  audit(action: string, resource: string, details: Record<string, unknown>): Promise<void>
}

export interface ApplyAnswer { status: number; body: Record<string, unknown> }

const refuse = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): ApplyAnswer =>
  ({ status, body: { ok: false, code, error, ...extra } })

/**
 * Apply a prepared plan by id. Checked in this order, and nothing is done unless every check passes: unlocked,
 * the plan is this person's, the request is for the plan's cluster, that cluster's connection is unchanged, the
 * role, the master-password re-confirmation, the typed name (delete), then the guest's config digest.
 * A refusal the person can fix (re-confirm, type the name) keeps the plan; every other refusal uses it up.
 */
export async function applyAction(planId: unknown, body: { confirmName?: unknown }, d: ApplyDeps): Promise<ApplyAnswer> {
  if (!d.unlocked()) return refuse(423, 'locked', 'HyperProx is locked. Sign in to unlock it, then try again. Nothing was done.', { locked: true })
  if (typeof planId !== 'string' || !planId) return refuse(400, 'invalid', 'planId is required.')
  const held = d.prepared.peek(planId, d.owner)
  if (!held) return refuse(404, 'not_found', 'That plan has expired or was already used. Ask again.')
  const plan = held.payload
  const burn = () => d.prepared.take(planId, d.owner)
  const there = d.row(plan.clusterId)

  if (d.requestCluster !== plan.clusterId) {
    burn()
    const other = d.row(d.requestCluster)?.name ?? 'another cluster'
    return refuse(409, 'wrong_cluster', `This was prepared for ${plan.clusterName}, but this request is for ${other}. Nothing was done. Ask again on the cluster you mean.`)
  }
  if (!there || (there.certFingerprint ?? null) !== plan.fingerprint ||
      (plan.peer && (d.row(plan.peer.id)?.certFingerprint ?? null) !== plan.peer.fingerprint) || (plan.peer && !d.row(plan.peer.id))) {
    burn()
    return refuse(409, 'cluster_changed', `${plan.clusterName}'s connection changed (or it was removed) since this was prepared. Nothing was done. Ask again.`)
  }
  const route = uiRouteFor(plan)
  const need = requiredRole('POST', route) ?? 'viewer'
  if (!d.ctx || !hasRole(d.ctx.role, need)) {
    burn()
    return refuse(403, 'forbidden', `This needs the ${need} role. Nothing was done.`, { required: need })
  }
  if (needsReconfirm('POST', route) && !d.reconfirmed(d.ctx.sid)) {
    return refuse(403, 'reconfirm_required', 'Re-enter your master password to continue')
  }
  if (plan.kind === 'delete' && String(body.confirmName ?? '') !== plan.guest!.name) {
    return refuse(428, 'confirm', `Type the guest's name exactly (${plan.guest!.name}) to delete it.`)
  }
  if (!d.prepared.take(planId, d.owner)) return refuse(404, 'not_found', 'That plan has expired or was already used. Ask again.')

  const cluster = { id: plan.clusterId, name: plan.clusterName, kind: plan.clusterKind }
  const by = d.owner
  try {
    if (plan.kind === 'monitoring-install' || plan.kind === 'monitoring-remove') {
      const r = await d.applyMonitoring(plan.monitoringPlanId!, d.owner, plan.clusterId)
      await d.audit('cluster.monitoring.apply', `cluster:${plan.clusterId}`, { by, via: 'assistant', ok: r.ok, nodes: r.results.map(x => x.node) })
      const words = [...r.results.map(x => `${x.node}: ${x.status}${x.reason ? ` (${x.reason})` : ''}`), ...r.checks.map(c => c.words)].join(' ')
      return { status: r.ok ? 200 : 502, body: { ok: r.ok, cluster, words: words || 'Done.', ...(r.ok ? {} : { error: words }) } }
    }
    if (plan.kind === 'copy') {
      const j = await d.startCopy(plan.copyPreviewId!, d.owner)
      return { status: 200, body: { ok: true, cluster, jobId: j.id, words: `The copy is ${j.state}. Its progress is on the Send files page.` } }
    }
    const g = plan.guest!
    const out = await d.inCluster(plan.clusterId, async () => {
      const pve = d.pve()
      const cfg = await pve.fetchStrict<any>(`/nodes/${encodeURIComponent(g.node)}/${g.type}/${g.vmid}/config`).catch(() => null)
      if (!cfg) return { changed: `${g.name} is no longer on ${g.node}.` }
      if (String(cfg.digest ?? '') !== (plan.digest ?? '')) return { changed: `${g.name}'s settings changed since this was prepared.` }
      const ref = { node: g.node, type: g.type, vmid: g.vmid }
      switch (plan.kind) {
        case 'start': case 'stop': case 'shutdown': case 'reboot': return { r: await d.ops.power(pve, ref, plan.kind) }
        case 'snapshot': return { r: await d.ops.snapshot(pve, ref, plan.snapName!) }
        case 'backup': { const t = await d.ops.backupNow(pve, ref, plan.storage!); return { r: { ok: true, words: `The backup of ${g.name} to ${plan.storage} has started; follow it in the task list.`, upid: t.upid } } }
        case 'delete': return { r: await d.ops.destroy(pve, ref, String(body.confirmName ?? '')) }
      }
      return { changed: 'Unknown action.' }
    }) as { changed?: string; r?: { ok: boolean; words: string; upid?: string } }
    if (out.changed) return refuse(409, 'changed', `${out.changed} Nothing was done. Ask again.`)
    const r = out.r!
    const leaf = { start: 'power', stop: 'power', shutdown: 'power', reboot: 'power', snapshot: 'snapshot', backup: 'backup', delete: 'delete' }[plan.kind as GuestVerb]
    await d.audit(`cluster.guest.${leaf}`, `cluster:${plan.clusterId}`, { by, via: 'assistant', node: g.node, guest: `${g.type}/${g.vmid}`, ok: r.ok, ...(leaf === 'power' ? { action: plan.kind } : {}) })
    return { status: r.ok ? 200 : 502, body: { ok: r.ok, cluster, words: r.words, ...(r.upid ? { upid: r.upid, node: g.node } : {}), ...(r.ok ? {} : { error: r.words }) } }
  } catch (e: any) {
    if (e?.name === 'VaultLockedError') return refuse(423, 'locked', 'HyperProx is locked. Sign in to unlock it, then try again.', { locked: true })
    if (e instanceof GuestActionRefusal) return refuse(e.code === 'not-found' ? 404 : e.code === 'confirm' ? 428 : 422, e.code, e.message)
    const code = e?.name === 'CertificateChangedError' ? 'cert_changed' : e?.name === 'CertificateNotConfirmedError' ? 'cert_unconfirmed' : 'failed'
    return refuse(code === 'failed' ? 502 : 409, code, plainError(e))
  }
}
