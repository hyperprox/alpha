// =============================================================================
//  HyperProx — "what's on my cluster": every guest, said by code
//
//  Per node, each running guest with what it is (an app HyperProx already found
//  there, its name, its tags), its address when one is known and whether HA
//  looks after it; then the stopped guests and the templates, grouped at the
//  end, and short totals at the top. Long lists are cut with a count, never
//  silently. Built from the cluster's own guest list, which is fast; what each
//  guest is comes from detectors HyperProx already runs (lib/ai/inventory-hints.ts)
//  and is left out, with a note, when they are slow. Pure: no I/O.
// =============================================================================

import type { ClusterSummary } from './ask-sources'
import { appFromName } from '../homepage/catalog'
import { clockAt } from './when'

/** What HyperProx already knows about each guest, by VMID. */
export interface AppHints {
  /** App names found on a guest (the Catalogue, the service scan, plug-in settings, Websites). */
  apps: Record<number, string[]>
  /** One address per guest, when known and the person may see it. */
  addresses: Record<number, string>
  /** When the slower part of this was read (unix ms); null when it is fresh. */
  asOf: number | null
  /** Said under the list, e.g. that apps are still being looked up. */
  note: string | null
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Each pattern is the whole question (after politeness and a trailing "?"), so a longer question that only starts
// the same way is not this: "what do I have to do to install X", "what is running on port 8080", "what do we run for
// backups" are not inventory questions.
const PLACE = String.raw`(cluster|server|servers|proxmox|pve|homelab|home\s*lab|lab|nodes?)`
const GUESTS = String.raw`(guests|apps|applications|containers|cts|lxcs|vms|virtual\s+machines|services|machines)`
const NOW = String.raw`(\s+(right\s+now|now|at\s+the\s+moment|currently))?`
const WHERE = String.raw`(\s+(on|in)\s+(my|the|our|this)\s+${PLACE})?`
const INVENTORY = [
  String.raw`what('?s|\s+is)\s+(on|in|running\s+on)\s+(my|the|our|this)\s+${PLACE}${NOW}`,
  String.raw`what('?s|\s+is|\s+are)\s+running${NOW}${WHERE}`,
  String.raw`what\s+(do|have)\s+(i|we)\s+(got|have|running)${WHERE}`,
  String.raw`what\s+do\s+(i|we)\s+(have|run)${WHERE}`,
  String.raw`(list|show)(\s+me)?(\s+all)?(\s+of)?(\s+(my|the|our))?\s+${GUESTS}(\s+(on|in)\s+[\w.-]+(\s+(cluster|server|node))?)?`,
  String.raw`what\s+${GUESTS}\s+(do\s+(i|we)\s+have|are\s+there|are\s+running|have\s+(i|we)\s+got|(do|are)\s+(i|we)\s+run(ning)?)${WHERE}`,
  String.raw`(which|what)\s+${GUESTS}\s+(are\s+)?(running|stopped)${NOW}${WHERE}`,
].map(r => new RegExp(`^${r}$`))
const LEAD = /^((hey|hi|ok|okay|so|and|please|can\s+you|could\s+you|tell\s+me)\b[\s,]*)+/

/**
 * True for "what's on my cluster", "what's running", "what do I have", "list my guests/apps/containers/VMs" and the
 * same about a named cluster or node ("what's on node2"; `names`: cluster and node names). Not for a question about
 * one guest ("is plex running?"), a count ("how many containers"), or a longer question that only starts the same way.
 */
export function isInventoryQuestion(prompt: string, names: string[] = []): boolean {
  const p = prompt.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[?.!\s]+$/, '').replace(LEAD, '').trim()
  if (INVENTORY.some(r => r.test(p))) return true
  return names.filter(n => n && n.trim()).some(n => new RegExp(`^what('?s|\\s+is)\\s+(on|running\\s+on)\\s+(the\\s+)?${esc(n.trim().toLowerCase())}(\\s+(cluster|server|node))?$`).test(p))
}

type Guest = ClusterSummary['guests'][number]
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`
const kind = (t: 'lxc' | 'qemu') => (t === 'lxc' ? 'container' : 'VM')
/** Tags Proxmox or HyperProx put on for their own reasons, which say nothing about what a guest is. */
const NOISE_TAGS = /^(hyperprox[-\w]*|pinned|ha|managed|template|test)$/

const MAX_PER_NODE = 15
const MAX_GROUPED = 15

function whatItIs(g: Guest, h: AppHints | null, full = true): string[] {
  // Below admin: name, type, node, state and HA only, as on the Guests page; what runs inside is the admin pages'.
  if (!full) return []
  const found = [...new Set(h?.apps[g.vmid] ?? [])]
  if (found.length) return found.slice(0, 3)
  const byName = appFromName(g.name)
  if (byName) return [byName.name]
  const tags = (g.tags ?? []).filter(t => !NOISE_TAGS.test(t))
  return tags.length ? [`tagged ${tags.slice(0, 3).join(', ')}`] : []
}

function guestLine(g: Guest, h: AppHints | null, haSids: Set<string>, o: { where?: boolean; full?: boolean } = {}): string {
  const ha = haSids.has(`${g.type === 'lxc' ? 'ct' : 'vm'}:${g.vmid}`)
  const parts = [...whatItIs(g, h, o.full !== false)]
  // A guest tagged to be left alone now has no address shown, even if the kept inventory is older than the tag.
  const addr = o.full !== false && !(g.tags ?? []).includes('hyperprox-ignore') ? h?.addresses[g.vmid] : undefined
  if (addr) parts.push(addr)
  if (ha) parts.push('HA')
  return `- ${g.name || `guest ${g.vmid}`} (${kind(g.type)} ${g.vmid}${o.where ? `, ${g.node}` : ''})${parts.length ? `: ${parts.join(', ')}` : ''}`
}


/**
 * The inventory answer. `prompt` narrows it: a node named in it (only that node), "containers" or "VMs" (only that
 * type), "apps" (only guests with an app found). `name`: the cluster's name for the first line.
 */
export function inventoryText(s: ClusterSummary, h: AppHints | null, o: { prompt?: string; name?: string; now?: number; detail?: 'basic' | 'full' } = {}): string {
  const full = o.detail !== 'basic'
  if (!full) h = null
  if (s.partial.includes('resources')) return 'I could not read the guest list from the cluster just now, so I cannot list what is on it. Try again in a moment.'
  const p = (o.prompt ?? '').toLowerCase()
  const now = o.now ?? Date.now()
  const node = s.nodes.find(n => new RegExp(`(^|[^a-z0-9-])${esc(n.node.toLowerCase())}($|[^a-z0-9-])`).test(p))?.node ?? null
  const wantCt = /\b(containers?|cts?|lxcs?)\b/.test(p), wantVm = /\b(vms?|virtual machines?)\b/.test(p)
  const type: 'lxc' | 'qemu' | null = wantCt && !wantVm ? 'lxc' : wantVm && !wantCt ? 'qemu' : null
  const askedApps = /\b(apps?|applications?|services?)\b/.test(p) && !type
  const appsOnly = askedApps && full
  const haSids = new Set(s.ha?.sids ?? [])
  const byName = (a: { name: string; vmid: number }, b: { name: string; vmid: number }) => (a.name || '').localeCompare(b.name || '') || a.vmid - b.vmid

  let guests = s.guests.filter(g => (!node || g.node === node) && (!type || g.type === type))
  const templates = (s.templates ?? []).filter(t => (!node || t.node === node) && (!type || t.type === type))
  if (appsOnly) guests = guests.filter(g => whatItIs(g, h, full).some(w => !w.startsWith('tagged ')))
  const running = guests.filter(g => g.running), stopped = guests.filter(g => !g.running)

  const what = type ? (type === 'lxc' ? 'container' : 'VM') : appsOnly ? 'guest with an app' : 'guest'
  const whatMany = type ? (type === 'lxc' ? 'containers' : 'VMs') : appsOnly ? 'guests with an app' : 'guests'
  const ct = guests.filter(g => g.type === 'lxc').length, vm = guests.length - ct
  const scope = node ? `On ${node}` : o.name ? `On ${o.name}` : 'On your cluster'
  const head = `${scope}: ${plural(guests.length, what, whatMany)}, ${running.length} running and ${stopped.length} stopped` +
    (!type && !appsOnly && guests.length ? ` (${plural(ct, 'container')}, ${plural(vm, 'VM')})` : '') +
    (templates.length && !appsOnly ? `, plus ${plural(templates.length, 'template')}` : '') +
    (!node ? ` across ${plural(s.nodes.length, 'node')}` : '') + '.'
  if (!guests.length && !templates.length) {
    return appsOnly ? `${scope}: I found no guest with an app I recognise. Ask "what's on my cluster" for every guest.` : `${scope}: no ${whatMany}.`
  }

  const out = [head]
  const nodes = s.nodes.filter(n => !node || n.node === node).slice().sort((a, b) => a.node.localeCompare(b.node))
  for (const n of nodes) {
    const here = running.filter(g => g.node === n.node).sort(byName)
    if (!n.online) { out.push('', `${n.node}: offline`); continue }
    if (!here.length) continue
    out.push('', `${n.node} (${here.length} running):`)
    for (const g of here.slice(0, MAX_PER_NODE)) out.push(guestLine(g, h, haSids, { full }))
    if (here.length > MAX_PER_NODE) {
      const rest = here.slice(MAX_PER_NODE)
      out.push(`- and ${rest.length} more: ${rest.slice(0, 10).map(g => g.name || g.vmid).join(', ')}${rest.length > 10 ? ', …' : ''}`)
    }
  }
  // Guests on a node that is not in the node list (a node removed mid-read) are still said.
  const orphans = running.filter(g => !nodes.some(n => n.node === g.node))
  if (orphans.length) { out.push('', 'Elsewhere:'); for (const g of orphans.sort(byName).slice(0, MAX_PER_NODE)) out.push(guestLine(g, h, haSids, { where: true, full })) }

  if (stopped.length) {
    const offline = new Set(s.nodes.filter(n => !n.online).map(n => n.node))
    const list = stopped.slice().sort(byName)
    const shown = list.slice(0, MAX_GROUPED).map(g => {
      const w = whatItIs(g, h, full)
      return `${g.name || `guest ${g.vmid}`} (${kind(g.type)} ${g.vmid}, ${g.node}${offline.has(g.node) ? ', node offline' : ''}${w.length ? `; ${w[0]}` : ''})`
    })
    out.push('', `Stopped (${stopped.length}): ${shown.join(', ')}${list.length > MAX_GROUPED ? `, and ${list.length - MAX_GROUPED} more` : ''}.`)
  }
  if (templates.length && !appsOnly) {
    const list = templates.slice().sort(byName)
    out.push(`Templates (${templates.length}): ${list.slice(0, MAX_GROUPED).map(t => `${t.name || t.vmid} (${t.node})`).join(', ')}${list.length > MAX_GROUPED ? `, and ${list.length - MAX_GROUPED} more` : ''}.`)
  }
  const notes: string[] = []
  if (askedApps && !full) notes.push('What runs in each guest is shown to admins only.')
  if (h?.note) notes.push(h.note)
  if (h?.asOf && now - h.asOf > 5 * 60_000) notes.push(`What each guest runs is as of ${clockAt(h.asOf, now)}.`)
  if (notes.length) out.push('', notes.join(' '))
  return out.join('\n')
}
