// How one GPU row reads, on a phone first. Pure functions with no imports, so the API's test runner can check
// them (apps/api/test/gpu-rows-front.test.ts) without a browser.

export interface GpuRowData {
  node: string
  name: string
  shortName?: string
  vendor: string
  pci?: string | null
  load: number | null
  vramUsed: number | null
  vramTotal: number | null
  memory?: 'dedicated' | 'shared'
  tempC: number | null
  fanPct: number | null
  freqMHz?: number | null
  powerW?: number | null
  state?: 'measured' | 'waiting' | 'stale' | 'unsupported' | 'not-monitored'
  stateNote?: string | null
  setupHref?: string | null
  capability: string
  capabilityShort?: string
}

function bytesShort(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0, v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}

/** The short GPU name the API sent, or one made from the full name for an older API. */
export function gpuShortName(g: Pick<GpuRowData, 'name' | 'shortName'>): string {
  if (g.shortName) return g.shortName
  const bracket = /\[([^\]]+)\]/.exec(g.name)?.[1]
  return (bracket ?? g.name).split(' / ')[0].replace(/^(NVIDIA|Intel|AMD)\s+/i, '').trim()
}

/** "node2 · HD Graphics 630": the node always comes first, so a cut-off row still says where it is. */
export function gpuRowLabel(g: GpuRowData): string {
  return `${g.node} · ${gpuShortName(g)}`
}

/** The full name and address, for the row's title (long-press or hover) and the expanded view. */
export function gpuRowTitle(g: GpuRowData): string {
  return `${g.node}: ${g.name}${g.pci ? ` (${g.pci})` : ''}`
}

/** The right-hand figure: the load when measured, otherwise a dash (the line under the row says why). */
export function gpuRowRight(g: GpuRowData): string {
  const pct = gpuRowPct(g)
  return pct === null ? '—' : `${pct}%`
}

/** The bar's fill, or null when there is nothing measured to draw. */
export function gpuRowPct(g: GpuRowData): number | null {
  const state = g.state ?? (g.load === null ? 'not-monitored' : 'measured')
  return state === 'measured' && g.load !== null ? Math.round(g.load) : null
}

/** One short line under the bar: memory, temperature, clock and power where known, and the HEVC line. */
export function gpuRowDetail(g: GpuRowData): string {
  const parts: string[] = []
  if (g.vramTotal) parts.push(`${bytesShort(g.vramUsed)} / ${bytesShort(g.vramTotal)} VRAM`)
  else if (g.memory === 'shared') parts.push('shared memory')
  else parts.push('VRAM not reported')
  if (g.tempC !== null && g.tempC !== undefined) parts.push(`${Math.round(g.tempC)} °C`)
  if (g.fanPct !== null && g.fanPct !== undefined) parts.push(`fan ${g.fanPct}%`)
  if (g.freqMHz !== null && g.freqMHz !== undefined) parts.push(`${Math.round(g.freqMHz)} MHz`)
  if (g.powerW !== null && g.powerW !== undefined) parts.push(`${g.powerW.toFixed(1)} W`)
  parts.push(g.capabilityShort ?? capabilityShortFrom(g.capability))
  return parts.join(' · ')
}

/** What to say when the row is not measured: the reason, and a link to set monitoring up when that is the fix. */
export function gpuRowAction(g: GpuRowData): { words: string; href: string | null } | null {
  const state = g.state ?? (g.load === null ? 'not-monitored' : 'measured')
  if (state === 'measured') return null
  if (state === 'not-monitored') return { words: 'not monitored · set up monitoring', href: g.setupHref ?? null }
  return { words: g.stateNote ?? (state === 'unsupported' ? 'not supported on this GPU' : state === 'stale' ? 'figures stopped arriving' : 'no figures yet'), href: null }
}

/** For an older API that sent only the long sentence. */
export function capabilityShortFrom(long: string): string {
  const checked = /checked with vainfo/.test(long)
  if (checked) return `HEVC decode: ${/decodes[^;]*HEVC/.test(long) ? 'yes' : 'no'} (checked)`
  if (/unknown|depends on its generation/.test(long)) return 'HEVC decode: unknown (estimate)'
  if (/likely not HEVC|not HEVC/.test(long)) return 'HEVC decode: likely no (estimate)'
  return /HEVC/.test(long) ? 'HEVC decode: likely yes (estimate)' : 'HEVC decode: unknown (estimate)'
}
