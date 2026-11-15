// Pure display logic for the Placement page: what tone a guest gets, how full a node is, and how a move's cost reads.
// No React and no CSS, so it is tested on its own (test/placement.test.tsx).

import type { GuestPlacement, MovePlan, MoveRecord, PlacementNode, QuietStatus } from './types'

export type Verdict = 'free' | 'unknown' | 'fixed' | 'template'

/** One word for a guest's chip: it can move, it cannot, nobody could check, or it is a template. */
export function verdictOf(g: GuestPlacement): Verdict {
  if (g.template) return 'template'
  return g.movable === 'yes' ? 'free' : g.movable === 'unknown' ? 'unknown' : 'fixed'
}

export const VERDICT_WORD: Record<Verdict, string> = { free: 'can move', unknown: 'not checked', fixed: 'stays put', template: 'template' }

/** The short reason on a fixed guest's chip: GPU, bind mount, rule, cores… */
export function pinWord(g: GuestPlacement): string | null {
  if (g.movable !== 'no' || g.template) return null
  const codes = new Set([...g.everywhere, ...g.targets.flatMap(t => t.reasons)].filter(r => r.level === 'block').map(r => r.code))
  for (const [c, w] of [['gpu', 'GPU'], ['device', 'device'], ['bind-mount', 'bind mount'], ['strict-rule', 'HA rule'], ['prefer-rule', 'HA rule'],
    ['local-disk', 'local disk'], ['cores', 'cores'], ['cpu-type', 'CPU type'], ['memory', 'memory'], ['backup-running', 'backup'], ['migrating', 'moving']] as const) {
    if (codes.has(c)) return w
  }
  return 'no room'
}

const clampPct = (v: number) => Math.max(0, Math.min(100, Math.round(v)))

/** A node's three bars: CPU now, memory now, and vCPUs given out against its threads (can pass 100%). */
export function nodeBars(n: PlacementNode): Array<{ key: string; label: string; pct: number; text: string; over: boolean }> {
  const memPct = n.maxmem ? (n.mem / n.maxmem) * 100 : 0
  const corePct = n.threads ? (n.cpusAssigned / n.threads) * 100 : 0
  return [
    { key: 'cpu', label: 'CPU', pct: clampPct(n.cpu * 100), text: `${Math.round(n.cpu * 100)}%`, over: n.cpu >= 0.8 },
    { key: 'mem', label: 'RAM', pct: clampPct(memPct), text: `${gib(n.mem)} / ${gib(n.maxmem)}`, over: memPct >= 90 },
    { key: 'cores', label: 'Cores', pct: clampPct(corePct), text: `${n.cpusAssigned} vCPU / ${n.threads} threads`, over: corePct > 100 },
  ]
}

export function gib(b: number): string {
  const g = (Number(b) || 0) / 1024 ** 3
  return g >= 10 ? `${Math.round(g)} GiB` : `${g.toFixed(1)} GiB`
}

export function seconds(s: number): string {
  if (s < 90) return `${Math.max(1, Math.round(s))} s`
  if (s < 5400) return `${Math.round(s / 60)} min`
  return `${(s / 3600).toFixed(1)} h`
}

/** The confirm dialog's three facts, as sentences. */
export function costLines(p: MovePlan): string[] {
  const out: string[] = []
  if (p.type === 'lxc' && p.running) out.push(`Downtime: about ${seconds(p.downtimeSec ?? 20)}. A running container is stopped, moved and started again.`)
  else if (p.running) out.push('Downtime: none expected. A running VM moves live; it pauses for a moment at the end.')
  else out.push('Downtime: none. It is stopped, and moves stopped.')
  out.push(p.copyBytes > 0
    ? `Data to copy: ${gib(p.copyBytes)}${p.localDisks ? ' (its local disks' + (p.type === 'qemu' && p.running ? ' and its memory)' : ')') : p.type === 'qemu' && p.running ? ' (its memory)' : ''}, about ${seconds(p.copySec)}.`
    : 'Data to copy: almost none. Its disks are on shared storage; only the configuration moves.')
  if (p.network.shared === true) out.push(`Network: it shares the link the cluster heartbeat (corosync) uses. ${p.bwlimitKiB ? `HyperProx limits it to ${Math.round(p.bwlimitKiB / 1024)} MiB/s.` : p.network.datacenterBwlimit ? `The cluster limits it to ${Math.round(p.network.datacenterBwlimit / 1024)} MiB/s.` : 'Nothing limits it.'}`)
  else if (p.network.shared === false) out.push('Network: moves use their own network, away from corosync.')
  else out.push('Network: whether it shares corosync\'s link could not be told.')
  return out
}

/** Which buttons the dialog offers. */
export function moveChoices(p: MovePlan): Array<'now' | 'anyway' | 'schedule'> {
  if (!p.allowed) return []
  if (p.quiet.quietNow) return ['now']
  return p.quiet.nextQuiet ? ['schedule', 'anyway'] : ['anyway']
}

export function when(ms: number, tz?: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms))
  } catch { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') }
}

export function quietWords(q: QuietStatus): string {
  if (q.quietNow) return q.nextQuiet ? `Quiet now, until ${when(q.nextQuiet.end, q.tz)}.` : 'Quiet now.'
  const next = q.nextQuiet ? ` Next quiet window: ${when(q.nextQuiet.start, q.tz)}.` : ' No quiet window in the next week.'
  return `Not a quiet window: ${q.nowWhy.join('; ')}.${next}`
}

export const STATUS_WORD: Record<MoveRecord['status'], string> = {
  scheduled: 'scheduled', running: 'moving', done: 'moved', failed: 'failed', skipped: 'skipped', cancelled: 'cancelled',
}

export function moveTitle(m: MoveRecord): string {
  return `${m.name || m.sid}: ${m.fromNode} → ${m.toNode || '?'} · ${STATUS_WORD[m.status]}${m.source === 'proxmox' ? ' (seen in Proxmox)' : ''}`
}

export function corosyncLine(m: MoveRecord): string {
  const c = m.corosync
  if (!c) return 'Corosync: not checked.'
  if (!c.checked.length) return c.unavailable ?? 'Corosync: could not be read.'
  const n = c.retransmits + c.linkDown + c.tokenLost
  return n === 0 ? `Corosync stayed quiet on ${c.checked.join(' and ')}.`
    : `Corosync on ${c.checked.join(' and ')}: ${c.retransmits} retransmits, link down ${c.linkDown}×, ${c.tokenLost} lost tokens.`
}
