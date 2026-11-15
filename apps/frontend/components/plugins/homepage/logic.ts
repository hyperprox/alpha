// =============================================================================
//  HyperProx — Homepage page: the shapes the API sends and the pure logic the page draws from
// =============================================================================

export const GROUP_ORDER = ['Media', 'Downloads', 'Infrastructure', 'Home', 'Dev', 'Websites', 'Guests'] as const

export interface Detected {
  machineId: string; kind: 'lxc' | 'qemu'; vmid: number; node: string; name: string; url: string | null
  via: Array<'catalogue' | 'scan' | 'marker' | 'proxy'>; running: boolean; connected: string | null
}

export interface Instance {
  id: string; machineId: string; kind: 'lxc' | 'qemu'; vmid: number; node: string; name: string; container: string; configDir: string
  composeDir: string | null; url: string | null
  options: { excludeSubnets: string[]; includeBareGuests: boolean; hiddenGroups: string[]; hiddenEntries: string[]; widgets: string[] }
  autoSync: boolean; managedGroups: string[]; exportedVars: string[]; releasedGroups: string[]
  proxmoxToken: { tokenId: string; createdAt: number; createdBy: string } | null
  lastSync: { at: number; by: string; ok: boolean; message: string; wrote: string[]; counts: Record<string, number>; backups: string[] } | null
}

export interface PreviewEntry {
  id: string; group: string; name: string; href: string | null; hrefKind: 'public' | 'lan' | 'none'; icon: string; description: string
  status: 'siteMonitor' | 'ping' | null
  widget: { type: string; enabled: boolean; pending: boolean; vars: string[] } | null
  guest: { vmid: number; name: string } | null; source: string
}
export interface DiffLine { op: ' ' | '+' | '-'; text: string }
export interface Preview {
  planId: string; expiresAt: number; counts: Record<string, number>; errors: string[]; failed: string[]; changed: boolean
  notes: { keptUserGroups: string[]; keptUserEntries: string[]; keptEdits: string[]; userRemovedGroups: string[]; renamed: Array<{ from: string; to: string }>; droppedSamples: boolean; adopted: string[] }
  entries: PreviewEntry[]
  files: Array<{ name: string; changed: boolean; diff: DiffLine[] }>
}
export interface Problem { id: string; severity: 'bad' | 'warn'; title: string; detail: string; fix: { id: string; label: string; confirm?: string; secure?: boolean } | null }

export const plural = (n: number, one: string, many?: string) => `${n} ${n === 1 ? one : many ?? (one.endsWith('y') ? `${one.slice(0, -1)}ies` : `${one}s`)}`

/** Entries in Homepage's group order, each group's entries by name. */
export function grouped(entries: PreviewEntry[]): Array<{ group: string; entries: PreviewEntry[] }> {
  const order = (g: string) => { const i = (GROUP_ORDER as readonly string[]).indexOf(g); return i < 0 ? 99 : i }
  const groups = [...new Set(entries.map(e => e.group))].sort((a, b) => order(a) - order(b) || a.localeCompare(b))
  return groups.map(group => ({ group, entries: entries.filter(e => e.group === group).sort((a, b) => a.name.localeCompare(b.name)) }))
}

/** Lines added and removed, without the unchanged ones. */
export function diffStats(diff: DiffLine[]): { added: number; removed: number } {
  return { added: diff.filter(l => l.op === '+').length, removed: diff.filter(l => l.op === '-').length }
}

/**
 * The diff with unchanged runs folded: `context` lines kept around each change, the rest as one "N unchanged lines"
 * marker, so a long file reads on a phone.
 */
export function foldDiff(diff: DiffLine[], context = 2): Array<DiffLine | { fold: number }> {
  const near = diff.map((_, i) => diff.slice(Math.max(0, i - context), i + context + 1).some(l => l.op !== ' '))
  const out: Array<DiffLine | { fold: number }> = []
  let run = 0
  diff.forEach((l, i) => {
    if (l.op !== ' ' || near[i]) { if (run) { out.push({ fold: run }); run = 0 } out.push(l) } else run++
  })
  if (run) out.push({ fold: run })
  return out
}

/** Two letters for an entry's tile (no icon is fetched from outside HyperProx). */
export function monogram(name: string): string {
  const words = name.replace(/\(.*?\)/g, '').trim().split(/[\s._-]+/).filter(Boolean)
  if (!words.length) return '?'
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase()
}

/** What the preview kept of the person's own file, in words. Empty when there is nothing to say. */
export function keptWords(n: Preview['notes']): string[] {
  const out: string[] = []
  if (n.droppedSamples) out.push('Homepage\'s three example groups are replaced (they are exactly as a fresh install writes them).')
  if (n.adopted.length) out.push(`HyperProx had no record of this file; it takes back the groups its own header names: ${n.adopted.join(', ')}.`)
  if (n.keptUserGroups.length) out.push(`Your groups stay as they are: ${n.keptUserGroups.join(', ')}.`)
  if (n.keptUserEntries.length) out.push(`Entries you added to HyperProx's groups stay: ${n.keptUserEntries.join(', ')}.`)
  if (n.keptEdits.length) out.push(`Entries you edited are left as you edited them: ${n.keptEdits.join(', ')}.`)
  if (n.userRemovedGroups.length) out.push(`Groups you deleted are not put back: ${n.userRemovedGroups.join(', ')}.`)
  for (const r of n.renamed) out.push(`You already have a group called ${r.from}, so HyperProx's is called ${r.to}.`)
  return out
}

export function syncWords(i: Instance, now = Date.now()): { text: string; tone: 'good' | 'warn' | 'bad' } {
  const s = i.lastSync
  if (!s) return { text: 'Not filled yet', tone: 'warn' }
  const mins = Math.max(0, Math.round((now - s.at) / 60_000))
  const when = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 48 * 60 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`
  return { text: `${s.ok ? 'In sync' : 'Last write needs a look'} · ${when} · ${s.by}`, tone: s.ok ? 'good' : 'bad' }
}

/** How each entry was found, in words. */
export const SOURCE_WORD: Record<string, string> = {
  scan: 'found by the service scan', catalogue: 'found by the Catalogue', install: 'installed from the Catalogue', plugin: 'from a plug-in\'s settings',
  self: 'HyperProx itself', cluster: 'the cluster', proxy: 'a proxy host', site: 'a HyperProx website', guest: 'a running guest',
}

export const KEYS_WARNING = 'Homepage reads widget keys from its own config, so they are stored in plaintext on the Homepage guest: in homepage.env beside its compose file (mode 0600, readable by root on that guest), in the container\'s environment, and in that file\'s dated backups until you delete them. Anyone with root there can read them. Only turn on widgets whose keys you are happy to keep there.'

/** Words for the inventory sources a preview could not read. */
export const SOURCE_NAME: Record<string, string> = {
  guests: 'the guest list', exclusions: 'Remote access\'s exclusion list', scan: 'the service scan', proxies: 'the proxy hosts', plugins: 'the plug-ins',
  detected: 'the Catalogue\'s detection', installs: 'the Catalogue\'s installs', sites: 'the Websites', instances: 'the plug-in devices', self: 'HyperProx\'s own address',
}

/** Whether Apply may go ahead: never without the exclusions; with another source missing, only when ticked. */
export function applyGate(failed: string[], anyway: boolean): { ok: boolean; reason: string | null } {
  if (failed.includes('exclusions')) return { ok: false, reason: 'Remote access\'s exclusion list could not be read, so this preview could show a guest that must be left out. Preview again later.' }
  if (failed.length && !anyway) return { ok: false, reason: `Not read: ${failed.map(f => SOURCE_NAME[f] ?? f).join(', ')}. Entries could be missing or wrong.` }
  return { ok: true, reason: null }
}

/** A subnet as a person types it: 192.0.2.0/24. */
export function validSubnets(text: string): { ok: boolean; list: string[] } {
  const list = text.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
  const ok = list.every(c => { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(c); return !!m && m.slice(1, 5).every(x => Number(x) <= 255) && Number(m[5]) >= 8 && Number(m[5]) <= 32 })
  return { ok, list }
}
