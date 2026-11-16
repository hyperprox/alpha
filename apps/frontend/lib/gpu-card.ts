// What the dashboard's GPU card says, as plain functions with no imports: where a GPU lives, who uses it, and
// how each figure reads. Checked by apps/frontend/test/gpu-card.test.tsx.

export interface GpuGuestRef { vmid: number; name: string; type: 'lxc' | 'qemu'; status: string }

export interface GpuLiveFigures {
  kind: 'intel' | 'amd' | 'nvidia'
  busy: number | null
  engines: { render: number | null; video: number | null; enhance: number | null } | null
  freqMHz: number | null
  powerW: number | null
  vramUsed: number | null
  vramTotal: number | null
  gttUsed: number | null
  gttTotal: number | null
  tempC: number | null
  note: string | null
}

export interface NodeGPUStatus {
  node: string
  reachable: boolean
  gpus: { type: string; vendorName: string; deviceName: string; dedicated: boolean; live?: GpuLiveFigures | null; guests?: GpuGuestRef[] }[]
  port: number
  install: { title: string; steps: string[] } | null
}

/** "NVIDIA GeForce GTX 1070 Ti" -> "GeForce GTX 1070 Ti"; the maker is already a badge elsewhere. */
export function shortGpuLabel(name: string): string {
  return String(name ?? '').replace(/^(NVIDIA|Intel|AMD)\s+/i, '').replace(/\s*\(.*\)\s*$/, '').trim() || String(name ?? '')
}

/** "in node-b": every GPU says where it lives. */
export function whereLine(node: string): string { return `in ${node}` }

/** "Used by: media (CT 102), cuda-vm (VM 301)", or null when no guest is given this GPU. Stopped guests say so. */
export function guestsLine(guests: GpuGuestRef[] | undefined | null): string | null {
  if (!guests?.length) return null
  const shown = guests.slice(0, 6).map(g => `${g.name || (g.type === 'qemu' ? 'VM' : 'CT')} (${g.type === 'qemu' ? 'VM' : 'CT'} ${g.vmid})${g.status === 'running' ? '' : ' - stopped'}`)
  const more = guests.length - shown.length
  return `Used by: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
}

/** The row of the NVIDIA GPU the big card shows: the first NVIDIA GPU whose name matches, else the first NVIDIA GPU. */
export function primaryNvidia(status: NodeGPUStatus[], name: string): { node: string; index: number } | null {
  const all = status.flatMap(n => n.gpus.map((g, index) => ({ node: n.node, index, g }))).filter(x => x.g.type === 'nvidia')
  const same = (a: string, b: string) => shortGpuLabel(a).toLowerCase() === shortGpuLabel(b).toLowerCase()
  const hit = all.find(x => same(x.g.deviceName, name)) ?? all.find(x => shortGpuLabel(name).toLowerCase().includes(shortGpuLabel(x.g.deviceName).toLowerCase()) || shortGpuLabel(x.g.deviceName).toLowerCase().includes(shortGpuLabel(name).toLowerCase())) ?? all[0]
  return hit ? { node: hit.node, index: hit.index } : null
}

/** True when at least one figure arrived. */
export function hasFigures(l: GpuLiveFigures | null | undefined): boolean {
  if (!l) return false
  return [l.busy, l.freqMHz, l.powerW, l.vramTotal, l.gttTotal, l.tempC, l.engines?.render, l.engines?.video, l.engines?.enhance].some(v => v !== null && v !== undefined)
}

const MIB = 1024 * 1024
/** A memory size in the card's compact form: "19 MB", "2.9 GB". */
export function sizeShort(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'
  if (bytes >= 1024 * MIB) { const g = bytes / (1024 * MIB); return `${g >= 10 ? Math.round(g) : g.toFixed(1)} GB` }
  return `${Math.round(bytes / MIB)} MB`
}

export function pctOfTotal(used: number | null, total: number | null): number | null {
  return used === null || total === null || !(total > 0) ? null : Math.min(100, Math.round((used / total) * 100))
}

/** What a missing figure means, for its tooltip. */
export function missingWhy(what: string, live: GpuLiveFigures | null | undefined): string {
  if (live?.note) return live.note
  return `${what} is not being reported for this GPU. Not every exporter or chip publishes it.`
}
