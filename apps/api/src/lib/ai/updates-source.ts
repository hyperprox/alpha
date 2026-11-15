// =============================================================================
//  HyperProx — the assistant's read-only view of pending updates
//
//  "What updates does node2 have?", "Does nextcloud need updates?", "Are there
//  security updates?" are answered from the Updates page's own target tree, as
//  last read, with no model call and nothing read from any machine. It never
//  starts an update and offers no way to: updates are chosen and run on the
//  Updates page, after the master password.
//
//  Admin only, like the Updates page: the tree lists every pending package and
//  kernel hold on every host.
// =============================================================================

import type { AskSource, SourceSummary } from './ask'
import type { UpdatesTarget, UpdatesTargetTree } from '../updates/types'
import { hasRole, type Role } from '../roles'
import { stripAddresses } from '../redact-addresses'

export interface UpdatesSourceDeps {
  role: Role | undefined
  /** The tree as the Updates page last read it, or null when it has not been read since HyperProx started. */
  tree(): UpdatesTargetTree | null
}

const RUN_NOTE = 'Updates are chosen and run on the Updates page, with your master password. I cannot start one.'
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const clean = (s: string) => stripAddresses(String(s ?? '')).replace(/\s+/g, ' ').trim()
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The machines a question names: a node by name, a guest by id or by the longest name it mentions as a word. */
export function machinesIn(prompt: string, targets: UpdatesTarget[]): UpdatesTarget[] {
  const p = prompt.toLowerCase()
  const word = (name: string) => new RegExp(`(^|[^a-z0-9-])${esc(name.toLowerCase())}($|[^a-z0-9-])`).test(p)
  const nodes = targets.filter(t => t.kind === 'node' && t.node && word(t.node))
  const guests = targets.filter(t => t.kind === 'guest' && t.vmid !== undefined)
  const byId = [...p.matchAll(/\b(\d{2,9})\b/g)].map(m => Number(m[1]))
  const idHits = guests.filter(g => byId.includes(g.vmid!))
  const nameHits = guests.filter(g => { const n = g.label.replace(/^\d+\s+/, '').replace(/ \(HyperProx\)$/, ''); return n.length > 1 && word(n) })
  return [...new Map([...nodes, ...idHits, ...nameHits].map(t => [t.id, t])).values()]
}

function children(targets: UpdatesTarget[], id: string): UpdatesTarget[] { return targets.filter(t => t.parent === id) }

/** One machine's updates in words: its packages (first few), images, apps, reboot, and anything blocked. */
export function machineLines(t: UpdatesTarget, targets: UpdatesTarget[]): string {
  const name = t.kind === 'node' ? `Node ${t.label}` : t.label
  const kids = children(targets, t.id)
  const pk = t.packages ?? []
  const parts: string[] = []
  if (pk.length) {
    const sec = pk.filter(p => p.security).length
    const shown = pk.slice(0, 8).map(p => `${p.name} ${p.from ?? 'new'} → ${p.to}`).join(', ')
    parts.push(`${plural(pk.length, 'package')} pending${sec ? ` (${sec} security)` : ''}: ${shown}${pk.length > 8 ? `, and ${pk.length - 8} more` : ''}`)
  }
  for (const c of kids.filter(k => k.kind === 'compose' && k.pending)) parts.push(`${c.label}: ${plural(c.pending, 'newer image')}`)
  for (const a of kids.filter(k => k.kind === 'app' && k.pending)) parts.push(`${a.label} ${a.sub ?? ''}`.trim())
  const reboot = kids.find(k => k.kind === 'node-reboot')
  if (reboot) parts.push(reboot.needsReboot ? 'it needs a reboot' : 'it will need a reboot after its kernel update')
  else if (t.needsReboot) parts.push('it asks for a reboot')
  const held = kids.filter(k => !k.selectable && k.blocked && k.kind.endsWith('pkg')).map(k => k.label)
  if (held.length) parts.push(`not offered: ${held.join(', ')} (held, or a kernel this node keeps pinned)`)
  if (!parts.length) parts.push(t.selectable || !t.blocked ? 'nothing pending' : `not updated: ${t.blocked}`)
  return clean(`${name}: ${parts.join('; ')}.`)
}

export function updatesSummary(tree: UpdatesTargetTree): SourceSummary {
  const t = tree.targets
  const machines = t.filter(x => x.kind === 'node' || x.kind === 'guest')
  const behind = machines.filter(m => m.pending > 0 || children(t, m.id).some(k => k.pending > 0))
  const security = behind.filter(m => m.security > 0)
  const reboots = t.filter(x => x.kind === 'node-reboot' && x.needsReboot).map(x => x.node!)
  const nodes = behind.filter(m => m.kind === 'node').length
  const headline = behind.length
    ? `Updates: ${plural(nodes, 'node')} and ${plural(behind.length - nodes, 'guest')} have updates${security.length ? `, ${security.length} with security updates` : ''}.`
    : 'Updates: everything is current.'
  const lines = [
    `As read ${tree.refreshedAt.slice(0, 16).replace('T', ' ')} UTC.`,
    ...behind.slice(0, 30).map(m => machineLines(m, t)),
    ...(reboots.length ? [`Needs a reboot: ${reboots.join(', ')}.`] : []),
  ]
  return { headline, lines, data: { tree } }
}

export function updatesAnswer(prompt: string, s: SourceSummary): string | null {
  const tree = (s.data as { tree?: UpdatesTargetTree } | undefined)?.tree
  if (!tree) return s.lines[0] ?? null
  const p = prompt.toLowerCase()
  const named = machinesIn(prompt, tree.targets)
  if (named.length) return [...named.map(m => machineLines(m, tree.targets)), RUN_NOTE].join(' ')
  if (/\bsecurity\b/.test(p)) {
    const sec = tree.targets.filter(x => (x.kind === 'node' || x.kind === 'guest') && x.security > 0)
    return sec.length ? [`Security updates on: ${sec.map(x => `${x.label} (${x.security})`).join(', ')}.`, RUN_NOTE].join(' ') : 'No security updates are pending.'
  }
  if (/\b(reboots?|restart)\b/.test(p)) {
    const r = tree.targets.filter(x => x.kind === 'node-reboot' && x.needsReboot).map(x => x.node)
    return r.length ? `Needs a reboot: ${r.join(', ')}. A reboot is its own choice on the Updates page, through HA maintenance.` : 'No node is waiting for a reboot.'
  }
  if (/\b(updates?|upgrades?|pending|outdated|out of date|patch(es)?)\b/.test(p)) return [s.headline, ...s.lines.slice(1, 12)].join(' ')
  return null
}

export function updatesSource(d: UpdatesSourceDeps): AskSource {
  return {
    id: 'updates', title: 'Updates', blurb: 'pending packages, images and apps on every node and guest, and which need a reboot',
    aliases: /\b(updates?|upgrades?|patch(es)?|pending packages?|apt|outdated|out of date|security updates?|needs? (a )?reboot)\b/,
    load: async () => {
      if (!d.role || !hasRole(d.role, 'admin')) return { headline: 'Updates: limited to admins.', lines: ['The Updates page, and what it lists, is limited to admins.'] }
      const tree = d.tree()
      if (!tree) return { headline: 'Updates: not read yet.', lines: ['The Updates inventory has not been read since HyperProx started. Open the Updates page to read it, then ask again.'] }
      return updatesSummary(tree)
    },
    answer: updatesAnswer,
  }
}
