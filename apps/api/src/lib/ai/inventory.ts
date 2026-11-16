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

const INVENTORY = [
  /\bwhat'?s\s+(on|in|running\s+on)\s+(my|the|our|this)\s+(cluster|server|servers|proxmox|pve|homelab|home\s*lab|lab|nodes?)\b/,
  /\bwhat\s+is\s+(on|in|running\s+on)\s+(my|the|our|this)\s+(cluster|server|servers|proxmox|pve|homelab|home\s*lab|lab|nodes?)\b/,
  /\bwhat\s+(is|are|'?s)\s+running\s*(\?|$|\bright now\b|\bat the moment\b|\bon\b)/,
  /\bwhat'?s\s+running\s*(\?|$|\bright now\b|\bat the moment\b|\bon\b)/,
  /\bwhat\s+(do|have)\s+(i|we)\s+(got|have|run|running)\b/,
  /\bwhat\s+do\s+(i|we)\s+have\b/,
  /\b(list|show)(\s+me)?\s+(all\s+)?(of\s+)?(my|the|our)?\s*(guests|apps|applications|containers|cts|lxcs|vms|virtual\s+machines|services|machines)\b/,
  /\bwhat\s+(guests|apps|applications|containers|vms|services|machines)\s+(do\s+(i|we)\s+have|are\s+(there|running|on)|run|have\s+i\s+got)\b/,
  /\b(which|what)\s+(guests|containers|vms|apps|services)\s+(are\s+)?(running|stopped)\b/,
]

/**
 * True for "what's on my cluster", "what's running", "what do I have", "list my guests/apps/containers/VMs" and the
 * same about a named cluster or node ("what's on node2"; `names`: cluster and node names). Not for a question about
 * one guest ("is plex running?") or a count ("how many containers"), which have their own exact answers.
 */
export function isInventoryQuestion(prompt: string, names: string[] = []): boolean {
  const p = prompt.toLowerCase().replace(/\s+/g, ' ').trim()
  if (/\bhow many\b|\bnumber of\b/.test(p)) return false
  if (INVENTORY.some(r => r.test(p))) return true
  return names.filter(n => n && n.trim()).some(n => new RegExp(`\\bwhat'?s\\s+(on|running\\s+on)\\s+(the\\s+)?${esc(n.trim().toLowerCase())}(\\s+(cluster|server|node))?\\s*\\??$`).test(p))
}

type Guest = ClusterSummary['guests'][number]
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`
const kind = (t: 'lxc' | 'qemu') => (t === 'lxc' ? 'container' : 'VM')
/** Tags Proxmox or HyperProx put on for their own reasons, which say nothing about what a guest is. */
const NOISE_TAGS = /^(hyperprox[-\w]*|pinned|ha|managed|template|test)$/

const MAX_PER_NODE = 15
const MAX_GROUPED = 15

function whatItIs(g: Guest, h: AppHints | null): string[] {
  const found = [...new Set(h?.apps[g.vmid] ?? [])]
  if (found.length) return found.slice(0, 3)
  const byName = appFromName(g.name)
  if (byName) return [byName.name]
  const tags = (g.tags ?? []).filter(t => !NOISE_TAGS.test(t))
  return tags.length ? [`tagged ${tags.slice(0, 3).join(', ')}`] : []
}

function guestLine(g: Guest, h: AppHints | null, haSids: Set<string>, o: { where?: boolean } = {}): string {
  const ha = haSids.has(`${g.type === 'lxc' ? 'ct' : 'vm'}:${g.vmid}`)
  const parts = [...whatItIs(g, h)]
  const addr = h?.addresses[g.vmid]
  if (addr) parts.push(addr)
  if (ha) parts.push('HA')
  return `- ${g.name || `guest ${g.vmid}`} (${kind(g.type)} ${g.vmid}${o.where ? `, ${g.node}` : ''})${parts.length ? `: ${parts.join(', ')}` : ''}`
}

const clock = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

/**
 * The inventory answer. `prompt` narrows it: a node named in it (only that node), "containers" or "VMs" (only that
 * type), "apps" (only guests with an app found). `name`: the cluster's name for the first line.
 */
export function inventoryText(s: ClusterSummary, h: AppHints | null, o: { prompt?: string; name?: string; now?: number } = {}): string {
  if (s.partial.includes('resources')) return 'I could not read the guest list from the cluster just now, so I cannot list what is on it. Try again in a moment.'
  const p = (o.prompt ?? '').toLowerCase()
  const now = o.now ?? Date.now()
  const node = s.nodes.find(n => new RegExp(`(^|[^a-z0-9-])${esc(n.node.toLowerCase())}($|[^a-z0-9-])`).test(p))?.node ?? null
  const wantCt = /\b(containers?|cts?|lxcs?)\b/.test(p), wantVm = /\b(vms?|virtual machines?)\b/.test(p)
  const type: 'lxc' | 'qemu' | null = wantCt && !wantVm ? 'lxc' : wantVm && !wantCt ? 'qemu' : null
  const appsOnly = /\b(apps?|applications?|services?)\b/.test(p) && !type
  const haSids = new Set(s.ha?.sids ?? [])
  const byName = (a: { name: string; vmid: number }, b: { name: string; vmid: number }) => (a.name || '').localeCompare(b.name || '') || a.vmid - b.vmid

  let guests = s.guests.filter(g => (!node || g.node === node) && (!type || g.type === type))
  const templates = (s.templates ?? []).filter(t => (!node || t.node === node) && (!type || t.type === type))
  if (appsOnly) guests = guests.filter(g => whatItIs(g, h).some(w => !w.startsWith('tagged ')))
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
    for (const g of here.slice(0, MAX_PER_NODE)) out.push(guestLine(g, h, haSids))
    if (here.length > MAX_PER_NODE) {
      const rest = here.slice(MAX_PER_NODE)
      out.push(`- and ${rest.length} more: ${rest.slice(0, 10).map(g => g.name || g.vmid).join(', ')}${rest.length > 10 ? ', …' : ''}`)
    }
  }
  // Guests on a node that is not in the node list (a node removed mid-read) are still said.
  const orphans = running.filter(g => !nodes.some(n => n.node === g.node))
  if (orphans.length) { out.push('', 'Elsewhere:'); for (const g of orphans.sort(byName).slice(0, MAX_PER_NODE)) out.push(guestLine(g, h, haSids, { where: true })) }

  if (stopped.length) {
    const offline = new Set(s.nodes.filter(n => !n.online).map(n => n.node))
    const list = stopped.slice().sort(byName)
    const shown = list.slice(0, MAX_GROUPED).map(g => {
      const w = whatItIs(g, h)
      return `${g.name || `guest ${g.vmid}`} (${kind(g.type)} ${g.vmid}, ${g.node}${offline.has(g.node) ? ', node offline' : ''}${w.length ? `; ${w[0]}` : ''})`
    })
    out.push('', `Stopped (${stopped.length}): ${shown.join(', ')}${list.length > MAX_GROUPED ? `, and ${list.length - MAX_GROUPED} more` : ''}.`)
  }
  if (templates.length && !appsOnly) {
    const list = templates.slice().sort(byName)
    out.push(`Templates (${templates.length}): ${list.slice(0, MAX_GROUPED).map(t => `${t.name || t.vmid} (${t.node})`).join(', ')}${list.length > MAX_GROUPED ? `, and ${list.length - MAX_GROUPED} more` : ''}.`)
  }
  const notes: string[] = []
  if (h?.note) notes.push(h.note)
  if (h?.asOf && now - h.asOf > 5 * 60_000) notes.push(`What each guest runs is as of ${clock(h.asOf)}.`)
  if (notes.length) out.push('', notes.join(' '))
  return out.join('\n')
}
