// The redesigned Updates page as plain functions, so every number and sentence can be tested without a browser:
// the hero's three numbers, the "held by policy" and "reboots needed" banners, the chips on node and guest rows,
// the short package summary, and the lines of the Schedule card.
//
// Words used throughout: a MACHINE is a node or a guest. "Machines with security fixes" counts machines;
// "security packages" counts packages. They are never both called just "security".

import type {
  UpdatesCheckCluster, UpdatesGuest, UpdatesInventory, UpdatesNode, UpdatesPkgChange, UpdatesPolicyStatus,
  UpdatesRebootStatus, UpdatesTarget,
} from '@hyperprox/types'
import { daysText, windowText } from '@/lib/auto-reboots'

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** Has a newer docker image waiting. */
export const imageNewer = (g: Pick<UpdatesGuest, 'dockerImages'>) => (g.dockerImages ?? []).some(i => i.latest !== null && i.latest !== i.current)

// --- The hero's numbers ------------------------------------------------------------------------

export interface HeroNumbers {
  /** Machines with anything to update. */
  behind: number
  /** Machines with at least one security fix. */
  securityMachines: number
  /** Security packages across them; null when only the inventory is known. */
  securityPackages: number | null
  /** Machines HyperProx manages (nodes plus managed guests); 0 until the inventory is read. */
  total: number
}

/**
 * The daily check's own counts when there is a complete one (it is what "Update now" works from), otherwise what the
 * inventory shows. Both count machines, never packages, except `securityPackages`, which says so.
 */
export function heroNumbers(row: UpdatesCheckCluster | null, inv: UpdatesInventory | null): HeroNumbers {
  const nodes = inv?.nodes ?? [], guests = (inv?.guests ?? []).filter(g => g.managed)
  const total = inv ? nodes.length + guests.length : 0
  const invBehind = nodes.filter(n => n.pending.length > 0).length + guests.filter(g => g.pending.length > 0 || imageNewer(g)).length
  const invSecurity = nodes.filter(n => n.pending.some(p => p.security)).length + guests.filter(g => g.pending.some(p => p.security)).length
  if (row && row.result === 'ok' && !row.unread.length && !row.notice) {
    return { behind: row.available, securityMachines: row.targets.filter(t => t.packages > 0 && t.security.length > 0).length, securityPackages: row.security, total }
  }
  return { behind: invBehind, securityMachines: invSecurity, securityPackages: null, total }
}

/** "Sat 08:00" in the viewer's own time zone; "—" when there is none. */
export function nextText(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
}

/** What the third number says: when the next automatic install is, or that there is none and why. */
export function nextRunText(policy: UpdatesPolicyStatus | null, remote: boolean): string {
  if (remote) return 'by hand'
  if (!policy) return '…'
  return policy.schedule.enabled && policy.schedule.nextRun ? nextText(policy.schedule.nextRun) : 'off'
}

// --- Banners -----------------------------------------------------------------------------------

/** Nodes HyperProx upgrades with `upgrade` only, or whose kernel is pinned: held packages never move. Null when none. */
export function heldBanner(nodes: UpdatesNode[]): string | null {
  const held = nodes.filter(n => (n.held?.length ?? 0) > 0 || !!n.pinned)
  if (!held.length) return null
  const names = held.map(n => n.node).join(', ')
  const holds = held.reduce((s, n) => s + (n.held?.length ?? 0), 0)
  const pinned = held.some(n => !!n.pinned)
  const only = held.some(n => n.policy.upgrade === 'upgrade')
  const parts = [
    only ? 'upgrades only (never a distribution upgrade)' : '',
    holds ? `${plural(holds, 'package')} held` : '',
    pinned ? 'kernel pinned' : '',
  ].filter(Boolean).join(', ')
  return `${names}: ${parts}.${pinned ? ' Its kernel will not change.' : ''} Held packages are never offered or installed.`
}

/** Machines that need a reboot, and what will happen to them. Null when none. */
export function rebootBanner(nodes: UpdatesNode[], reboots: UpdatesRebootStatus | null, remote: boolean): string | null {
  const need = new Set(nodes.filter(n => n.rebootRequired || n.rebootPending).map(n => n.node))
  for (const w of reboots?.waiting.nodes ?? []) need.add(w.node)
  const guests = reboots?.waiting.guests.length ?? 0
  if (!need.size && !guests) return null
  const what = [need.size ? plural(need.size, 'node') : '', guests ? plural(guests, 'guest') : ''].filter(Boolean).join(' and ')
  if (remote) return `${what} ${need.size + guests === 1 ? 'needs' : 'need'} a reboot. HyperProx does not reboot a remote server by itself: reboot each by hand from its row below.`
  const s = reboots?.available ? reboots.settings : null
  if (s && (s.nodes || s.guests)) return `${what} ${need.size + guests === 1 ? 'needs' : 'need'} a reboot. Done automatically in the ${windowText(s.window)} window (${daysText(s.window.days)}), one at a time${s.quiet ? ', waiting while anyone is watching' : ''}.`
  return `${what} ${need.size + guests === 1 ? 'needs' : 'need'} a reboot. Automatic reboots are off, so reboot each by hand from its row below.`
}

// --- Rows --------------------------------------------------------------------------------------

export interface Chip { label: string; tone: 'crit' | 'warn' | 'good' | 'accent' | 'muted'; title?: string }

export function nodeChips(n: UpdatesNode): Chip[] {
  const c: Chip[] = []
  if (!n.online) c.push({ label: 'offline', tone: 'crit' })
  if (n.isSelf) c.push({ label: 'runs HyperProx', tone: 'accent', title: 'HyperProx itself runs on this node' })
  if (n.pending.some(p => p.security)) c.push({ label: 'security', tone: 'crit', title: 'Some packages come from a security suite' })
  if (n.kernelPending) c.push({ label: 'kernel', tone: 'warn', title: 'A new kernel is pending; it runs only after a reboot' })
  if (n.cephPending) c.push({ label: 'ceph', tone: 'accent', title: 'Ceph packages are pending; they update on every node together' })
  if (n.rebootRequired || n.rebootPending) c.push({ label: 'reboot needed', tone: 'warn' })
  if (n.pinned) c.push({ label: 'pinned kernel', tone: 'accent', title: `Kernel pinned to ${n.pinned}` })
  if (n.policy.upgrade === 'upgrade' && ((n.held?.length ?? 0) > 0 || !!n.pinned)) c.push({ label: 'upgrade only', tone: 'muted' })
  if (n.factsUnknown && n.online) c.push({ label: 'holds/pin unknown', tone: 'muted', title: 'Its holds and kernel pin could not be read (no node login). It is not upgraded until they can be.' })
  if (!n.factsUnknown && n.holdsOk === false) c.push({ label: 'holds missing', tone: 'crit', title: 'A required apt hold is missing; the run stops before touching this node' })
  if (!n.factsUnknown && n.pinOk === false) c.push({ label: 'pin missing', tone: 'crit', title: 'The required kernel pin is not set; the run stops before touching this node' })
  if (n.error) c.push({ label: 'could not read', tone: 'crit' })
  c.push(n.pending.length ? { label: plural(n.pending.length, 'pkg'), tone: 'muted' } : { label: 'current', tone: 'good' })
  return c
}

export function guestChips(g: UpdatesGuest, excludedWhy?: string): Chip[] {
  if (!g.managed) return [{ label: excludedWhy ? 'skipped' : 'not managed', tone: 'accent' }]
  const c: Chip[] = []
  if (g.error) c.push({ label: 'could not read', tone: 'crit' })
  if (g.pending.some(p => p.security)) c.push({ label: 'security', tone: 'crit' })
  if (g.rebootRequired) c.push({ label: 'reboot needed', tone: 'warn' })
  const imgs = (g.dockerImages ?? []).filter(i => i.latest !== null && i.latest !== i.current).length
  const apps = (g.apps ?? []).filter(a => a.latest !== null && a.latest !== a.installed).length
  if (g.pending.length) c.push({ label: String(g.pending.length), tone: 'muted', title: plural(g.pending.length, 'package') })
  if (imgs || apps) c.push({ label: `${imgs + apps} app${imgs + apps === 1 ? '' : 's'}`, tone: 'muted', title: [imgs ? plural(imgs, 'image') : '', apps ? plural(apps, 'app') : ''].filter(Boolean).join(' and ') + ' newer' })
  if (!g.pending.length && !imgs && !apps && !g.error) c.push({ label: 'current', tone: 'good' })
  return c
}

/** Behind first (security before the rest), then by node and id. */
export function guestOrder(a: UpdatesGuest, b: UpdatesGuest): number {
  const rank = (g: UpdatesGuest) => (g.pending.some(p => p.security) ? 0 : g.pending.length || imageNewer(g) ? 1 : 2)
  return rank(a) - rank(b) || a.node.localeCompare(b.node) || a.vmid - b.vmid
}

/** "name 1.2 → 1.3, name 2 → 3 and 5 more": the first few packages in a line, the rest counted. */
export function pkgSummary(pkgs: UpdatesPkgChange[], shown = 3): { head: UpdatesPkgChange[]; more: number } {
  const sorted = [...pkgs].sort((x, y) => Number(!!y.security) - Number(!!x.security))
  return { head: sorted.slice(0, shown), more: Math.max(0, sorted.length - shown) }
}

/** The ids "Update just this" runs for one guest: its own row and its apps and compose projects. None when blocked. */
export function guestSelection(targets: UpdatesTarget[], vmid: number): { ids: string[]; blocked?: string } {
  const mine = targets.filter(t => t.vmid === vmid && (t.kind === 'guest' || ((t.kind === 'app' || t.kind === 'compose') && t.everything)))
  const ids = mine.filter(t => t.selectable).map(t => t.id)
  if (ids.length) return { ids }
  return { ids: [], blocked: mine.find(t => t.blocked)?.blocked ?? (mine.length ? 'It cannot be chosen right now.' : 'Nothing to update on it.') }
}

// --- The Schedule card -------------------------------------------------------------------------

/** "daily", "Mon, Wed" or "on its schedule" from a five-field cron line. */
export function cadence(cron: string | null | undefined): string {
  const f = (cron ?? '').trim().split(/\s+/)
  if (f.length !== 5 || !/^\d+$/.test(f[0]) || !/^\d+$/.test(f[1])) return 'on a schedule'
  if (f[2] === '*' && f[3] === '*' && f[4] === '*') return 'daily'
  if (f[2] === '*' && f[3] === '*' && /^[0-6](,[0-6])*$/.test(f[4])) return daysText(f[4].split(',').map(Number))
  return 'on a schedule'
}

export interface ScheduleLine { key: string; label: string; value: string }

export function scheduleLines(i: {
  policy: UpdatesPolicyStatus | null
  auto?: { enabled: boolean } | null
  reboots: UpdatesRebootStatus | null
  remote: boolean
}): ScheduleLine[] {
  const { policy, auto, reboots, remote } = i
  const lines: ScheduleLine[] = []
  const ck = policy?.check
  lines.push({ key: 'check', label: 'Check for updates', value: !policy ? '…' : ck?.enabled ? `${cadence(ck.cron)} · next ${nextText(ck.nextRun)} · read only` : 'off' })
  if (remote) lines.push({ key: 'install', label: 'Install automatically', value: 'never on a remote server: you press Update now' })
  else {
    const sch = policy?.schedule
    lines.push({ key: 'install', label: 'Install automatically', value: !policy ? '…' : sch?.enabled ? `${cadence(sch?.cron)} · next ${nextText(sch?.nextRun)} · ${sch?.windowHours ?? 0} h window` : 'off' })
  }
  if (remote) lines.push({ key: 'reboot', label: 'Reboot automatically', value: 'never on a remote server: reboot by hand' })
  else {
    const s = reboots?.available ? reboots.settings : null
    lines.push({
      key: 'reboot', label: 'Reboot automatically',
      value: !reboots ? '…' : !s ? 'by hand' : s.nodes || s.guests ? `${windowText(s.window)} ${daysText(s.window.days)}${s.quiet ? ' · waits while anyone is watching' : ''}` : 'off: reboots wait for you',
    })
  }
  return lines
}
