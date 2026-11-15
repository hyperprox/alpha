// =============================================================================
//  HyperProx — Updates: targets, and plans for the ones a person chose
//
//  The Updates page shows everything that can be updated as a tree: the cluster's
//  nodes (their packages, one by one, and a reboot when one is due), Ceph, and
//  under each node its guests (their packages, compose projects and apps). Any
//  row, or any mix of rows, can be chosen and run.
//
//  Pure, like the planner: inventory + policy + selection in, rows or an ordered
//  plan out. Nothing here reads or runs anything. The runner checks every rule
//  again when a step runs, from what is on the machine then; these functions
//  only decide what is offered and what is planned.
//
//  The rules a selection never gets past:
//    - a held package, a package the policy requires held, and on a node that
//      holds or pins its kernel any kernel, header or kernel metapackage, are
//      never updated one by one;
//    - a node whose holds and pin could not be read is never upgraded;
//    - a node whose required holds or pin are missing is never touched;
//    - Ceph moves only as one item, on every node, daemons in order;
//    - a node reboot is never part of an update unless its reboot row is chosen;
//    - excluded guests, and guests tagged hyperprox-ignore, are never touched.
// =============================================================================

import type { UpdatesGuest, UpdatesInventory, UpdatesNode, UpdatesPlan, UpdatesPlanItem, UpdatesTarget, UpdatesTargetKind } from './types'
import { type Policy, guestPolicy, nodePolicy } from './policy'
import { isCephPackage, isGuardedKernelPackage, isComposeDir, composeKey, COMPOSE_NAME, PKG_NAME } from './commands'
import { orderNodes, cephTarget, DETAIL, type PlanContext, type PlanStep } from './planner'
import { appStepDetail } from './apps'
import { compareVersions, isVersion } from '../app-updates/versions'

// --- Ids ------------------------------------------------------------------------------------

const NODE = '[A-Za-z0-9][A-Za-z0-9.-]{0,62}'
const PKG = '[a-z0-9][a-z0-9+.-]{0,127}'

export const targetId = {
  ceph:       () => 'ceph',
  node:       (n: string) => `node:${n}`,
  nodePkg:    (n: string, p: string) => `node:${n}:pkg:${p}`,
  nodeReboot: (n: string) => `node:${n}:reboot`,
  guest:      (v: number) => `guest:${v}`,
  guestPkg:   (v: number, p: string) => `guest:${v}:pkg:${p}`,
  compose:    (v: number, key: string) => `guest:${v}:compose:${key}`,
  app:        (v: number, key: string) => `guest:${v}:app:${key}`,
  fix:        (v: number, fixId: string) => `guest:${v}:fix:${fixId}`,
}

export type ParsedTarget =
  | { kind: 'ceph' }
  | { kind: 'node'; node: string }
  | { kind: 'node-pkg'; node: string; pkg: string }
  | { kind: 'node-reboot'; node: string }
  | { kind: 'guest'; vmid: number }
  | { kind: 'guest-pkg'; vmid: number; pkg: string }
  /** `key`: the project's name, or (a policy directory Docker does not list) its directory. */
  | { kind: 'compose'; vmid: number; key: string }
  | { kind: 'app'; vmid: number; key: string }
  | { kind: 'app-fix'; vmid: number; fixId: string }

export const MAX_SELECTION = 500

/** A target id, or null for anything that is not one. Nothing in a selection reaches a shell without passing here. */
export function parseTargetId(id: unknown): ParsedTarget | null {
  if (typeof id !== 'string' || id.length > 400) return null
  if (id === 'ceph') return { kind: 'ceph' }
  let m = new RegExp(`^node:(${NODE})$`).exec(id)
  if (m) return { kind: 'node', node: m[1] }
  m = new RegExp(`^node:(${NODE}):pkg:(${PKG})$`).exec(id)
  if (m) return { kind: 'node-pkg', node: m[1], pkg: m[2] }
  m = new RegExp(`^node:(${NODE}):reboot$`).exec(id)
  if (m) return { kind: 'node-reboot', node: m[1] }
  m = /^guest:(\d{1,9})(?::(pkg|compose|app|fix):(.+))?$/.exec(id)
  if (!m) return null
  const vmid = Number(m[1])
  if (!m[2]) return { kind: 'guest', vmid }
  const rest = m[3]
  if (m[2] === 'pkg') return PKG_NAME.test(rest) ? { kind: 'guest-pkg', vmid, pkg: rest } : null
  if (m[2] === 'compose') return isComposeDir(rest) || COMPOSE_NAME.test(rest) ? { kind: 'compose', vmid, key: rest } : null
  if (m[2] === 'app') return /^[a-f0-9]{6,64}$/.test(rest) ? { kind: 'app', vmid, key: rest } : null
  return /^fix:\d{1,9}:[a-z0-9-]{1,41}:[a-f0-9]{6,64}:[a-f0-9]{6,64}$/.test(rest) ? { kind: 'app-fix', vmid, fixId: rest } : null
}

// --- What a node allows -----------------------------------------------------------------------

/**
 * A node that keeps its kernel where it is: its policy names holds or a pin, its kernel is pinned, or it holds a kernel
 * package. (A hold on something else, pve-firmware say, keeps that package and nothing more.)
 */
export function nodeGuarded(policy: Policy, n: Pick<UpdatesNode, 'node' | 'held' | 'pinned'>): boolean {
  const pol = nodePolicy(policy, n.node)
  return Boolean(pol.requireHolds.length || pol.requirePin || n.pinned || n.held?.some(isGuardedKernelPackage))
}

/** Why a node takes no update at all right now, or null. */
export function nodeRefusal(n: UpdatesNode): string | null {
  if (!n.online) return `${n.node} is offline`
  if (n.factsUnknown) return `${n.node}'s package holds and kernel pin could not be read (add a node login), so it is never upgraded until they can be`
  if (n.holdsOk === false) return `${n.node}: required package holds are missing; it is not touched until they are back`
  if (n.pinOk === false) return `${n.node}: the required kernel pin is not in place; it is not touched until it is`
  return null
}

/** Why one package on a node is not updated by itself, or null. */
export function nodePackageRefusal(policy: Policy, n: UpdatesNode, pkg: string, remote = false): string | null {
  if (!PKG_NAME.test(pkg)) return `${pkg} is not a package name`
  const pol = nodePolicy(policy, n.node)
  if (n.held?.includes(pkg)) return `${pkg} is held on ${n.node}: held packages are never installed or unheld`
  if (pol.requireHolds.includes(pkg)) return `${pkg} must stay held on ${n.node} (its policy requires the hold)`
  if (isGuardedKernelPackage(pkg) && nodeGuarded(policy, n)) {
    return `${pkg} moves the kernel, and ${n.node} keeps its kernel held or pinned: kernels, headers and their metapackages are never updated there`
  }
  if (!remote && isCephPackage(pkg)) return `${pkg} is a Ceph package: Ceph moves only through the Ceph item, on every node, daemons in order`
  if (!n.pending.some(p => p.name === pkg)) return `${pkg} has no update pending on ${n.node}`
  return null
}

const GUEST_REASON: Record<string, string> = {
  'excluded':    'excluded in the Updates policy',
  'ignored':     'tagged hyperprox-ignore: HyperProx never looks inside it',
  'not-running': 'stopped, so it cannot be read or updated',
  'no-apt':      'no apt in this guest',
  'no-agent':    'no guest agent, so HyperProx cannot reach inside it',
  'windows':     'a Windows guest',
}

/** Why a guest's packages are not updated, or null. */
function guestAptRefusal(policy: Policy, g: UpdatesGuest): string | null {
  if (g.unmanagedReason) return `${g.vmid} (${g.name}): ${GUEST_REASON[g.unmanagedReason] ?? g.unmanagedReason}`
  if (!g.managed) return `${g.vmid} (${g.name}) could not be read${g.error ? `: ${g.error}` : ''}`
  if (!guestPolicy(policy, g.vmid).apt) return `${g.vmid} (${g.name}): apt is off for it in the policy`
  return null
}

/** Why anything at all in a guest is not touched (excluded, ignored, stopped, unread), or null. */
function guestRefusal(g: UpdatesGuest): string | null {
  if (g.unmanagedReason === 'no-apt') return null
  if (g.unmanagedReason) return `${g.vmid} (${g.name}): ${GUEST_REASON[g.unmanagedReason] ?? g.unmanagedReason}`
  if (!g.managed) return `${g.vmid} (${g.name}) could not be read${g.error ? `: ${g.error}` : ''}`
  return null
}

const newer = (a: { installed: string; latest: string | null }) => isVersion(a.latest) && isVersion(a.installed) && compareVersions(a.latest, a.installed) > 0
const imgNewer = (i: { current: string; latest: string | null }) => i.latest !== null && i.latest !== i.current
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** The compose projects a guest offers: the ones read in it, or (none read) the policy's directories. */
function projectsOf(policy: Policy, g: UpdatesGuest): NonNullable<UpdatesGuest['compose']> {
  if (g.compose) return g.compose
  const pol = guestPolicy(policy, g.vmid)
  if (pol.docker === 'none' || !pol.composeDirs.length) return []
  const one = pol.composeDirs.length === 1
  return pol.composeDirs.map(dir => ({ dir, source: 'policy' as const, images: one ? (g.dockerImages ?? []) : [] }))
}

// --- The tree ---------------------------------------------------------------------------------

/** What the plug-ins and their long jobs say about guests (home cluster): lib/compose-owners.ts, lib/long-jobs.ts. */
export interface GuardContext {
  /** Why this compose project is left to a plug-in's page ("Managed by the Nextcloud page — update it there"), or null. */
  composeOwner?: (vmid: number, project: { name?: string; dir: string }) => string | null
  /** Why nothing in this guest is touched now (a plug-in's long job runs in it), or null. */
  guestBusy?:    (vmid: number) => string | null
}

export interface TargetContext extends GuardContext {
  selfVmid?: number | null
  remote?:   boolean
}

/**
 * Every target, nodes in their run order with Ceph first, each guest under its node. Rows that cannot be chosen
 * are still listed, with the reason, so nothing is silently missing.
 */
export function buildTargets(inv: UpdatesInventory, policy: Policy, ctx: TargetContext = {}): UpdatesTarget[] {
  const out: UpdatesTarget[] = []
  const ordered = orderNodes(inv.nodes, policy)

  // --- Ceph: one item for the whole cluster -------------------------------------------------
  const cephNodes = inv.nodes.filter(n => n.cephPending)
  if (cephNodes.length && !ctx.remote) {
    const ceph = cephTarget(inv.nodes)
    const pkgs = cephNodes.flatMap(n => n.pending.filter(p => isCephPackage(p.name)).map(p => ({ ...p, name: `${p.name} (${n.node})` })))
    const why = ceph.conflict.length > 1 ? `the nodes' candidate Ceph versions differ (${ceph.conflict.join(', ')}); align the repositories first`
      : cephNodes.find(n => nodeRefusal(n))?.node ? `Ceph moves on every node together, and ${nodeRefusal(cephNodes.find(n => nodeRefusal(n))!)}`
      : inv.nodes.some(n => !n.online) ? 'every node must be online for Ceph to move' : undefined
    out.push({
      id: targetId.ceph(), kind: 'ceph', parent: null, label: 'Ceph',
      sub: ceph.version ? `to ${ceph.version} on ${cephNodes.map(n => n.node).join(', ')}, then mon, mgr and OSD restarts in order` : undefined,
      pending: pkgs.length, security: pkgs.filter(p => p.security).length,
      selectable: !why, ...(why ? { blocked: why } : {}), everything: !why, packages: pkgs,
    })
  }

  // --- Nodes ----------------------------------------------------------------------------------
  for (const n of ordered) {
    const nid = targetId.node(n.node)
    const refusal = nodeRefusal(n)
    const guarded = nodeGuarded(policy, n)
    const own = ctx.remote ? n.pending : n.pending.filter(p => !isCephPackage(p.name))
    // Any hold, not only a kernel one, means apt-get upgrade from a chosen run (the runner decides again).
    const verb = guarded || n.held?.length ? 'upgrade' : n.policy.upgrade
    const notes: string[] = []
    if (guarded) notes.push(`Keeps its kernel held or pinned: it gets apt-get upgrade only, and no kernel, header or kernel metapackage is ever updated here.`)
    if (n.held?.length) notes.push(`Held, never offered: ${n.held.join(', ')}`)
    if (!ctx.remote && n.cephPending) notes.push('Ceph packages are pending here too: they move with the Ceph item, which runs first.')
    if (n.upgradeNote) notes.push(n.upgradeNote)
    if (n.error && !refusal) notes.push(n.error)
    const kernels = guarded ? own.filter(p => isGuardedKernelPackage(p.name) || n.held?.includes(p.name)).map(p => p.name) : []
    const nothing = !own.length ? 'nothing pending'
      : kernels.length ? `keeps its kernel held or pinned, and kernel packages are pending (${kernels.join(', ')}): choose single packages instead` : undefined
    out.push({
      id: nid, kind: 'node', parent: null, label: n.node, node: n.node,
      sub: own.length ? `apt-get ${verb} · ${plural(own.length, 'package')}` : 'up to date',
      pending: own.length, security: own.filter(p => p.security).length,
      selectable: !refusal && !nothing, ...(refusal || nothing ? { blocked: refusal ?? nothing } : {}),
      everything: !refusal && !nothing,
      needsReboot: n.rebootRequired || n.rebootPending,
      packages: own, ...(notes.length ? { notes } : {}),
    })
    for (const p of own) {
      const why = refusal ?? nodePackageRefusal(policy, n, p.name, ctx.remote)
      out.push({
        id: targetId.nodePkg(n.node, p.name), kind: 'node-pkg', parent: nid, label: p.name, node: n.node,
        sub: `${p.from ?? 'new'} → ${p.to}${p.security ? ' · security' : ''}`,
        pending: 1, security: p.security ? 1 : 0, selectable: !why, ...(why ? { blocked: why } : {}), packages: [p],
      })
    }
    const due = n.rebootRequired || n.rebootPending || n.kernelPending || Boolean(n.preview?.rebootAfter)
    if (n.online && due) {
      // A node whose holds or pin are missing or unknown is never rebooted: it could come up on a kernel its GPU driver
      // was not built for.
      const why = refusal ?? (ctx.remote && !n.standalone ? 'on a remote cluster HyperProx reboots only one-node servers; reboot this node by hand after moving its guests' : undefined)
      out.push({
        id: targetId.nodeReboot(n.node), kind: 'node-reboot', parent: nid, node: n.node,
        label: ctx.remote ? 'Reboot (one-node server: its guests stop)' : 'Reboot (with HA maintenance)',
        sub: n.rebootRequired || n.rebootPending ? 'needs reboot' : 'a reboot will be needed after its kernel update',
        pending: 0, security: 0, selectable: !why, ...(why ? { blocked: why } : {}),
        everything: !ctx.remote && !why && nodePolicy(policy, n.node).reboot === 'auto' && (n.kernelPending || n.rebootRequired),
        needsReboot: n.rebootRequired || n.rebootPending,
      })
    }
  }

  // --- Guests, under their node ---------------------------------------------------------------
  const rank = new Map(ordered.map((n, i) => [n.node, i]))
  const guests = [...inv.guests].sort((a, b) => (rank.get(a.node) ?? 99) - (rank.get(b.node) ?? 99) || a.vmid - b.vmid)
  for (const g of guests) {
    const gid = targetId.guest(g.vmid)
    const isSelf = g.vmid === ctx.selfVmid
    const parent = inv.nodes.some(n => n.node === g.node) ? targetId.node(g.node) : null
    const busy = ctx.guestBusy?.(g.vmid) ?? null
    const all = guestRefusal(g) ?? busy
    const apt = busy ?? guestAptRefusal(policy, g)
    const noSnap = Boolean(ctx.remote && g.managed && !g.snapshotCapable)
    const projects = all ? [] : projectsOf(policy, g)
    const apps = busy || (all && g.unmanagedReason !== 'no-apt') ? [] : (g.apps ?? [])
    const appsNewer = apps.filter(newer)
    const imagesNewer = projects.reduce((k, p) => k + p.images.filter(imgNewer).length, 0)
    const notes: string[] = []
    if (isSelf) notes.push('HyperProx itself: its packages are updated last, through a handoff from its node, and the page may reconnect.')
    if (g.keptBack?.length) notes.push(`Held or kept back, never installed: ${g.keptBack.join(', ')}`)
    if (noSnap) notes.push('Cannot be snapshotted (bind-mounted storage): choosing it updates it without a snapshot.')
    if (g.error && !all) notes.push(g.error)
    const nothing = !g.pending.length ? 'no packages pending' : undefined
    const why = apt ?? nothing
    out.push({
      id: gid, kind: 'guest', parent, label: `${g.vmid} ${g.name}${isSelf ? ' (HyperProx)' : ''}`, node: g.node, vmid: g.vmid, guestType: g.type,
      sub: all ?? (g.pending.length ? `apt-get upgrade · ${plural(g.pending.length, 'package')}` : 'packages up to date'),
      pending: (apt ? 0 : g.pending.length) + imagesNewer + appsNewer.length,
      security: (apt ? 0 : g.pending.filter(p => p.security).length) + appsNewer.filter(a => a.isSecurity).length,
      selectable: !why, ...(why ? { blocked: why } : {}),
      everything: !why && !noSnap, needsReboot: g.rebootRequired,
      packages: apt ? [] : g.pending,
      ...(noSnap ? { approvals: [g.noSnapshotAckId ?? `nosnap:${g.vmid}`] } : {}),
      ...(notes.length ? { notes } : {}),
    })
    if (!apt) {
      for (const p of g.pending) {
        const pw = isSelf ? 'HyperProx itself is updated as a whole, not package by package' : g.keptBack?.includes(p.name) ? `${p.name} is held or kept back in the guest` : undefined
        out.push({
          id: targetId.guestPkg(g.vmid, p.name), kind: 'guest-pkg', parent: gid, label: p.name, vmid: g.vmid, node: g.node,
          sub: `${p.from ?? 'new'} → ${p.to}${p.security ? ' · security' : ''}`, pending: 1, security: p.security ? 1 : 0,
          selectable: !pw, ...(pw ? { blocked: pw } : {}), packages: [p],
          ...(noSnap ? { approvals: [g.noSnapshotAckId ?? `nosnap:${g.vmid}`] } : {}),
        })
      }
    }
    for (const c of projects) {
      const fresh = c.images.filter(imgNewer).length
      const pw = isSelf ? "HyperProx's own images are updated by deploying HyperProx" : ctx.composeOwner?.(g.vmid, c) ?? undefined
      const pol = guestPolicy(policy, g.vmid)
      out.push({
        id: targetId.compose(g.vmid, composeKey(c)), kind: 'compose', parent: gid, vmid: g.vmid, node: g.node,
        label: c.name ? `${c.name} (${c.dir})` : c.dir,
        sub: c.error ? c.error : fresh ? `${plural(fresh, 'newer image')} · compose pull, then up` : 'no newer image seen',
        pending: fresh, security: 0, selectable: !pw, ...(pw ? { blocked: pw } : {}),
        everything: !pw && !noSnap && pol.docker === 'auto' && c.source === 'policy',
        images: c.images,
        notes: [c.source === 'found' ? 'Found in the guest (not named in the policy); updated only when chosen.' : `In the policy (docker: ${pol.docker}).`,
          ...(c.files?.length ? [`Config files: ${c.files.join(', ')}`] : [])],
        ...(noSnap ? { approvals: [g.noSnapshotAckId ?? `nosnap:${g.vmid}`] } : {}),
      })
    }
    for (const a of apps) {
      const fixes = a.issues.filter(i => i.fix)
      if (!newer(a) && !fixes.length) continue
      const open = a.issues.filter(i => i.blocking && !i.fix)
      const pw = isSelf ? 'apps inside HyperProx itself are not updated by a run'
        : a.mode === 'off' ? `apps.${a.provider} is off in the policy`
        : !newer(a) ? 'already at the newest version'
        : !a.approvalId ? 'nothing to approve'
        : open.length ? open.map(i => i.message).join('; ') : undefined
      const needsFix = a.issues.some(i => i.blocking && i.fix)
      out.push({
        id: targetId.app(g.vmid, a.key), kind: 'app', parent: gid, label: a.name, vmid: g.vmid, node: g.node,
        sub: newer(a) ? `${a.installed} → ${a.latest}${a.isSecurity ? ' · security' : ''}` : `${a.installed}, current`,
        pending: newer(a) ? 1 : 0, security: newer(a) && a.isSecurity ? 1 : 0,
        selectable: !pw, ...(pw ? { blocked: pw } : {}), everything: !pw && a.mode === 'auto' && !needsFix,
        notes: [a.how, ...(needsFix ? ['Needs its configuration change first: choose it too.'] : []), ...a.notes.slice(0, 3).map(x => `${x.version}: ${x.text}`)],
      })
      for (const i of fixes) {
        out.push({
          id: targetId.fix(g.vmid, i.fix!.id), kind: 'app-fix', parent: gid, label: `${a.name}: ${i.fix!.description}`, vmid: g.vmid, node: g.node,
          sub: `edits ${i.fix!.file}`, pending: 0, security: 0, selectable: !isSelf, ...(isSelf ? { blocked: 'not inside HyperProx itself' } : {}),
          notes: [i.message, i.fix!.change],
        })
      }
    }
  }
  return out
}

/** What "Update everything" chooses: what a run of the whole plan would do, reboots only where the policy reboots. */
export function everythingSelection(targets: UpdatesTarget[]): string[] {
  return targets.filter(t => t.everything && t.selectable).map(t => t.id)
}

// --- Plans for a selection ----------------------------------------------------------------------

export interface SelectionContext extends PlanContext, GuardContext {
  selection: string[]
}

/** The detail of a chosen-packages step: the runner reads the names back from after the colon. */
export const packagesDetail = (pkgs: string[]) => `only-upgrade (${plural(pkgs.length, 'package')}): ${[...pkgs].sort().join(' ')}`
export function packagesOf(detail: string | null | undefined): string[] {
  const m = /^only-upgrade \(\d+ packages?\): (.+)$/.exec(detail ?? '')
  return m ? m[1].split(' ').filter(Boolean) : []
}
/** A chosen compose step: `compose-project <name>`, or `compose-dir <dir>` for a policy directory Docker does not list. */
export const composeDetail = (key: string) => key.startsWith('/') ? `compose-dir ${key} — pull its images and restart it` : `compose-project ${key} — pull its images and restart it`
export function composeKeyOf(detail: string | null | undefined): string | null {
  const m = /^compose-(dir|project) (\S+)(?: |$)/.exec(detail ?? '')
  if (!m) return null
  return m[1] === 'dir' ? (isComposeDir(m[2]) ? m[2] : null) : (COMPOSE_NAME.test(m[2]) ? m[2] : null)
}

/** "an item it depends on failed": the reason a skipped dependent carries, and how Resume knows to retry it. */
export const DEPENDS_ON = 'not run: it waits for'

/**
 * The plan for the targets a person chose. Guests first (each node's guests before the node itself), then Ceph,
 * then the nodes one at a time in policy order, then HyperProx itself; a reboot only where its row was chosen.
 * Every chosen id is either planned or listed in `refused` with the reason.
 */
export function buildSelectedPlan(inv: UpdatesInventory, policy: Policy, ctx: SelectionContext): UpdatesPlan {
  const steps: PlanStep[] = []
  const warnings: string[] = []
  const refused: { id: string; reason: string }[] = []
  const items: UpdatesPlanItem[] = []
  if (ctx.policyNote) warnings.push(ctx.policyNote)
  const approvals = new Set(ctx.approvals ?? [])
  const used = new Set<string>()
  const add = (target: string, action: PlanStep['action'], detail: string) => {
    steps.push({ seq: steps.length + 1, target, action, detail })
    return steps.length
  }
  const refuse = (ids: string[], reason: string) => { for (const id of ids) refused.push({ id, reason }) }
  const item = (id: string, label: string, kind: UpdatesTargetKind, ids: string[], seqs: number[], dependsOn: string[] = []) => {
    items.push({ id, label, kind, ids, seqs, dependsOn })
    return id
  }

  const chosen: { id: string; t: ParsedTarget }[] = []
  for (const id of [...new Set(ctx.selection)].slice(0, MAX_SELECTION)) {
    const t = parseTargetId(id)
    if (t) chosen.push({ id, t }); else refused.push({ id: String(id).slice(0, 80), reason: 'not a target id' })
  }
  const nodes = new Map(inv.nodes.map(n => [n.node, n]))
  const guests = new Map(inv.guests.map(g => [g.vmid, g]))
  const ordered = orderNodes(inv.nodes, policy)
  const rank = new Map(ordered.map((n, i) => [n.node, i]))

  // --- Guests ------------------------------------------------------------------------------
  const guestItemsOn = new Map<string, string[]>()
  const byGuest = new Map<number, { id: string; t: ParsedTarget }[]>()
  for (const c of chosen) {
    if (!('vmid' in c.t)) continue
    const list = byGuest.get(c.t.vmid) ?? []
    list.push(c); byGuest.set(c.t.vmid, list)
  }
  const guestOrder = [...byGuest.keys()].sort((a, b) =>
    (rank.get(guests.get(a)?.node ?? '') ?? 99) - (rank.get(guests.get(b)?.node ?? '') ?? 99) || a - b)
  let selfApt: UpdatesGuest | null = null
  for (const vmid of guestOrder) {
    const sel = byGuest.get(vmid)!
    const g = guests.get(vmid)
    if (!g) { refuse(sel.map(s => s.id), `no guest ${vmid} in the inventory`); continue }
    const all = guestRefusal(g) ?? ctx.guestBusy?.(vmid) ?? null
    if (all) { refuse(sel.map(s => s.id), all); continue }
    const pol = guestPolicy(policy, vmid)
    const isSelf = vmid === ctx.selfVmid
    const whole = sel.find(s => s.t.kind === 'guest')
    const pkgSel = sel.filter(s => s.t.kind === 'guest-pkg')
    const aptWhy = guestAptRefusal(policy, g)

    // Work out every piece first; steps are added only once the guest is known to be planned.
    let aptWhole = false
    const pkgs: string[] = []
    const pkgIds: string[] = []
    if (whole) {
      if (aptWhy) refuse([whole.id], aptWhy)
      else if (!g.pending.length) refuse([whole.id], `${vmid} (${g.name}) has no packages pending`)
      else aptWhole = true
    }
    for (const s of pkgSel) {
      const p = (s.t as { pkg: string }).pkg
      if (aptWhole) continue   // covered by the whole guest
      const why = aptWhy ?? (isSelf ? 'HyperProx itself is updated as a whole, not package by package'
        : g.keptBack?.includes(p) ? `${p} is held or kept back in ${vmid}: never installed by a run`
        : !g.pending.some(x => x.name === p) ? `${p} has no update pending in ${vmid}` : null)
      if (why) refuse([s.id], why); else { pkgs.push(p); pkgIds.push(s.id) }
    }
    const projects = projectsOf(policy, g)
    const composeSel: { id: string; key: string; label: string }[] = []
    for (const s of sel.filter(x => x.t.kind === 'compose')) {
      const key = (s.t as { key: string }).key
      const proj = projects.find(p => composeKey(p) === key)
      const why = isSelf ? "HyperProx's own images are updated by deploying HyperProx, not by this run"
        : policy.guests[String(vmid)]?.docker === 'none' ? `docker is off for ${vmid} in the policy`
        : !proj ? `${key} is not a compose project HyperProx found in ${vmid}`
        : ctx.composeOwner?.(vmid, proj) ?? null
      if (why) refuse([s.id], why); else composeSel.push({ id: s.id, key, label: proj!.name ?? proj!.dir })
    }
    const fixSel: { id: string; detail: string; label: string }[] = []
    const appSel: { id: string; detail: string; label: string; approval: string }[] = []
    for (const s of sel.filter(x => x.t.kind === 'app-fix')) {
      const fixId = (s.t as { fixId: string }).fixId
      const a = g.apps?.find(x => x.issues.some(i => i.fix?.id === fixId))
      const fx = a?.issues.find(i => i.fix?.id === fixId)?.fix
      if (isSelf || !a || !fx) { refuse([s.id], isSelf ? 'not inside HyperProx itself' : 'that configuration change is no longer offered (re-read the inventory)'); continue }
      used.add(fixId)
      fixSel.push({ id: s.id, detail: appStepDetail(a.provider, fixId.split(':').pop()!, a.key, fx.description), label: `${vmid} ${a.name}: ${fx.description}` })
    }
    for (const s of sel.filter(x => x.t.kind === 'app')) {
      const key = (s.t as { key: string }).key
      const a = g.apps?.find(x => x.key === key)
      if (!a) { refuse([s.id], 'that app is no longer found in the guest (re-read the inventory)'); continue }
      const open = a.issues.filter(i => i.blocking && !(i.fix && fixSel.some(f => f.id === targetId.fix(vmid, i.fix!.id))))
      const why = isSelf ? 'apps inside HyperProx itself are not updated by a run'
        : a.mode === 'off' ? `apps.${a.provider} is off in the policy`
        : !newer(a) || !a.approvalId ? `${a.name} is already at the newest version`
        : open.length ? `${a.name}: ${open.map(i => i.message + (i.fix ? ' (choose the offered configuration change too)' : '')).join('; ')}` : null
      if (why) { refuse([s.id], why); continue }
      used.add(a.approvalId!)
      appSel.push({ id: s.id, approval: a.approvalId!, label: `${vmid} ${a.name} ${a.installed} → ${a.latest}`,
        detail: appStepDetail(a.provider, a.latest!, a.key, `${a.name} ${a.installed} → ${a.latest}${a.isSecurity ? ' (security)' : ''}`) })
    }
    if (!aptWhole && !pkgs.length && !composeSel.length && !fixSel.length && !appSel.length) continue

    const t = String(vmid)
    if (isSelf) {
      // HyperProx's own guest: snapshot now, the upgrade itself last, through the handoff.
      selfApt = g
      continue
    }
    let snap: number
    if (!g.snapshotCapable && ctx.remote) {
      const ack = g.noSnapshotAckId ?? `nosnap:${vmid}`
      if (!approvals.has(ack)) {
        refuse([...(aptWhole ? [whole!.id] : []), ...pkgIds, ...composeSel.map(c => c.id), ...fixSel.map(f => f.id), ...appSel.map(a => a.id)],
          `${vmid} (${g.name}) cannot be snapshotted; updating it needs "update without a snapshot" approved (${ack})`)
        continue
      }
      used.add(ack)
      snap = add(t, 'snapshot', `${DETAIL.snapshotNone} — bind-mounted storage; updating without a snapshot was approved`)
    } else snap = add(t, 'snapshot', g.snapshotCapable ? 'before updating' : `${DETAIL.snapshotNone} — bind-mounted storage`)

    // Within one guest the pieces run in order and stop at the first failure (the guest is then left for a person,
    // with its snapshot named), so each item waits for the one before it.
    const mine: string[] = []
    const chain = () => (mine.length ? [mine[mine.length - 1]] : [])
    const seqs = (first: number[]) => (mine.length ? first : [snap, ...first])
    if (aptWhole) {
      const reboot = g.type === 'qemu' && pol.reboot === 'if-required' ? ', then reboot if the guest asks for one (its policy)' : ''
      const s = add(t, 'apt', `apt-get upgrade (${plural(g.pending.length, 'package')})${reboot}`)
      mine.push(item(whole!.id, `${vmid} ${g.name}: ${plural(g.pending.length, 'package')}`, 'guest', [whole!.id], seqs([s]), chain()))
    }
    if (pkgs.length) {
      const s = add(t, 'apt-packages', packagesDetail(pkgs))
      mine.push(item(`guest:${vmid}:pkgs`, `${vmid} ${g.name}: ${pkgs.join(', ')}`, 'guest-pkg', pkgIds, seqs([s]), chain()))
    }
    for (const c of composeSel) {
      const s = add(t, 'docker', composeDetail(c.key))
      mine.push(item(c.id, `${vmid} ${g.name}: ${c.label}`, 'compose', [c.id], seqs([s]), chain()))
    }
    for (const f of fixSel) {
      const s = add(t, 'app-config', f.detail)
      mine.push(item(f.id, f.label, 'app-fix', [f.id], seqs([s]), chain()))
    }
    for (const a of appSel) {
      const s = add(t, 'app', a.detail)
      mine.push(item(a.id, a.label, 'app', [a.id], seqs([s]), chain()))
    }
    if (pol.check && (aptWhole || pkgs.length || composeSel.length || appSel.length)) {
      const last = items.find(i => i.id === mine[mine.length - 1])!
      last.seqs.push(add(t, 'check', pol.check))
    }
    guestItemsOn.set(g.node, [...(guestItemsOn.get(g.node) ?? []), ...mine])
  }
  if (selfApt?.snapshotCapable) {
    // Taken in the guest phase, so the rollback point exists before the handoff upgrades it.
    add(String(selfApt.vmid), 'snapshot', 'before updating HyperProx itself')
  }

  // --- Ceph ----------------------------------------------------------------------------------
  const cephSel = chosen.find(c => c.t.kind === 'ceph')
  let cephItem: string | null = null
  if (cephSel) {
    const ceph = cephTarget(inv.nodes)
    const pendingOn = ordered.filter(n => n.cephPending)
    const bad = pendingOn.map(nodeRefusal).find(Boolean)
    const why = ctx.remote ? 'a remote cluster has no Ceph phase: Ceph packages go with each node upgrade, which refuses while Ceph runs there'
      : !pendingOn.length ? 'no Ceph packages are pending'
      : ceph.conflict.length > 1 ? `the nodes' candidate Ceph versions differ (${ceph.conflict.join(', ')}); align the repositories first`
      : inv.nodes.some(n => !n.online) ? 'every node must be online for Ceph to move'
      : bad ? `Ceph moves on every node together, and ${bad}` : null
    if (why) refuse([cephSel.id], why)
    else {
      const seqs: number[] = []
      for (const n of pendingOn) seqs.push(add(n.node, 'ceph', `${DETAIL.cephInstall} ${ceph.version}`))
      for (const d of ['mon', 'mgr', 'osd'] as const) for (const n of pendingOn) seqs.push(add(n.node, 'ceph', `${DETAIL.cephRestart} ${d}`))
      cephItem = item(cephSel.id, `Ceph ${ceph.version} on ${pendingOn.map(n => n.node).join(', ')}`, 'ceph', [cephSel.id], seqs)
    }
  }

  // --- Nodes, one at a time ------------------------------------------------------------------
  let selfReboot: { node: string; deps: string[]; id: string } | null = null
  const forced: number[] = []
  // A chosen node that is not in the cluster any more is refused, never silently dropped.
  for (const c of chosen) if ('node' in c.t && !nodes.has(c.t.node)) refuse([c.id], `no node ${c.t.node} in this cluster`)
  for (const n of ordered) {
    const sel = chosen.filter(c => 'node' in c.t && c.t.node === n.node)
    if (!sel.length) continue
    const whole = sel.find(s => s.t.kind === 'node')
    const pkgSel = sel.filter(s => s.t.kind === 'node-pkg')
    const rebootSel = sel.find(s => s.t.kind === 'node-reboot')
    const refusal = nodeRefusal(n)
    const mine: string[] = []
    const guarded = nodeGuarded(policy, n)

    if (whole) {
      const own = ctx.remote ? n.pending : n.pending.filter(p => !isCephPackage(p.name))
      const why = refusal
        ?? (!own.length ? `${n.node} has no packages pending` : null)
        ?? (!ctx.remote && n.cephPending && !cephItem ? `Ceph packages are pending on ${n.node}, and a node upgrade never moves Ceph: choose Ceph too (it runs first), or choose single packages` : null)
        ?? (guarded && own.some(p => isGuardedKernelPackage(p.name) || n.held?.includes(p.name))
          ? `${n.node} keeps its kernel held or pinned, and kernel packages are pending (${own.filter(p => isGuardedKernelPackage(p.name) || n.held?.includes(p.name)).map(p => p.name).join(', ')}): choose single packages instead` : null)
      if (why) refuse([whole.id], why)
      else {
        // A node that keeps its kernel held or pinned never gets dist-upgrade from a chosen update (the runner decides again).
        // Any hold, not only a kernel one, means apt-get upgrade from a chosen run (the runner decides again).
        const verb = guarded || n.held?.length ? 'upgrade' : n.policy.upgrade
        const seqs = [add(n.node, 'node-upgrade', `apt-get ${verb} (${plural(own.length, 'package')})`)]
        // No kernel is installed on a node that holds or pins its kernel, so none is removed there either.
        if (n.kernelPending && !guarded) seqs.push(add(n.node, 'kernel-cleanup', 'keep the running kernel, the pinned one and one fallback; apt clean'))
        mine.push(item(whole.id, `${n.node}: ${plural(own.length, 'package')} (apt-get ${verb})`, 'node', [whole.id], seqs, cephItem && n.cephPending ? [cephItem] : []))
      }
    }
    if (pkgSel.length && !mine.length) {
      const ok: string[] = []
      const okIds: string[] = []
      for (const s of pkgSel) {
        const p = (s.t as { pkg: string }).pkg
        const why = refusal ?? nodePackageRefusal(policy, n, p, ctx.remote)
        if (why) refuse([s.id], why); else { ok.push(p); okIds.push(s.id) }
      }
      if (ok.length) {
        const s = add(n.node, 'node-packages', packagesDetail(ok))
        mine.push(item(`node:${n.node}:pkgs`, `${n.node}: ${ok.join(', ')}`, 'node-pkg', okIds, [s]))
      }
    }
    if (rebootSel) {
      const why = refusal ? `${refusal}; it is not rebooted`
        : ctx.remote && !n.standalone ? 'on a remote cluster HyperProx reboots only one-node servers; reboot this node by hand after moving its guests' : null
      if (why) refuse([rebootSel.id], why)
      else {
        // The reboot waits for this node's guests and its own update: if one of them failed, it does not happen.
        const deps = [...(guestItemsOn.get(n.node) ?? []), ...mine]
        if (n.isSelf && !ctx.remote) selfReboot = { node: n.node, deps, id: rebootSel.id }
        else {
          const detail = ctx.remote
            ? `${DETAIL.rebootStandalone} — chosen by a person; its running guests stop until it is back`
            : `${DETAIL.rebootAuto} — chosen by a person, through HA maintenance (forced)`
          const s = add(n.node, 'node-reboot', detail)
          forced.push(s)
          item(rebootSel.id, `Reboot ${n.node}`, 'node-reboot', [rebootSel.id], [s], deps)
        }
      }
    }
  }

  // --- HyperProx itself, last ------------------------------------------------------------------
  if (selfApt && ctx.selfVmid) {
    const id = targetId.guest(selfApt.vmid)
    const s = add(String(selfApt.vmid), 'self', `${DETAIL.selfGuest} (${plural(selfApt.pending.length, 'package')}) — through a handoff, the API may restart`)
    const snapSeq = steps.find(x => x.target === String(selfApt!.vmid) && x.action === 'snapshot')?.seq
    item(id, `${selfApt.vmid} ${selfApt.name} (HyperProx itself)`, 'guest', [id], snapSeq ? [snapSeq, s] : [s])
    guestItemsOn.set(selfApt.node, [...(guestItemsOn.get(selfApt.node) ?? []), id])
  }
  if (selfReboot) {
    const s = add(selfReboot.node, 'self', `${DETAIL.selfReboot} — HyperProx's own node, through a handoff from another node (forced)`)
    forced.push(s)
    item(selfReboot.id, `Reboot ${selfReboot.node} (HyperProx's own node)`, 'node-reboot', [selfReboot.id], [s],
      [...selfReboot.deps, ...(guestItemsOn.get(selfReboot.node) ?? []).filter(x => !selfReboot!.deps.includes(x))])
  }

  for (const r of refused) warnings.push(`Not planned: ${r.id} — ${r.reason}`)
  if (!steps.length) warnings.push('Nothing to run: none of the chosen targets can be updated now.')
  const plan: UpdatesPlan = { steps, warnings, scope: 'all', selection: chosen.map(c => c.id), items, refused, ...(forced.length ? { forced } : {}) }
  if (used.size) plan.approved = [...used].sort()
  return plan
}
