// The AI side panel's rules, kept apart from the markup so they can be tested in Node: how wide it may be, what is
// remembered per person, which page the person is on, how a question carries its page, and how a proposed fix becomes
// a request to the plug-in's own action route.

import type { Tier } from '@/lib/operator-view'

export const PANEL_MIN = 300
export const PANEL_MAX = 640
export const PANEL_DEFAULT = 380
/** The panel is a floating button and a sheet at this width and below. */
export const PHONE_MAX = 768
export const RAIL_WIDTH = 44

export interface PanelPrefs { open: boolean; width: number }

/** The widest the panel may be: its own limit, or half the window so the page always keeps room. */
export const maxWidthFor = (viewport: number): number => Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.floor(viewport / 2)))

export function clampWidth(w: number, viewport: number): number {
  const n = Number.isFinite(w) ? Math.round(w) : PANEL_DEFAULT
  return Math.max(PANEL_MIN, Math.min(maxWidthFor(viewport), n))
}

/** One entry per person, so two people on one browser keep their own. */
export const prefsKey = (who: string | undefined): string => `hyperprox-ai-panel:${(who || 'anon').toLowerCase().slice(0, 120)}`

/** What was stored, or the defaults (open, default width) for nothing or anything unreadable. */
export function parsePrefs(raw: string | null | undefined): PanelPrefs {
  const d: PanelPrefs = { open: true, width: PANEL_DEFAULT }
  if (!raw) return d
  try {
    const o = JSON.parse(raw)
    return {
      open: typeof o?.open === 'boolean' ? o.open : d.open,
      width: typeof o?.width === 'number' && Number.isFinite(o.width) ? Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.round(o.width))) : d.width,
    }
  } catch { return d }
}

// ── Which page the person is on ──────────────────────────────────────────────

const PLUGIN_NAMES: Record<string, string> = { arrstack: 'Arr Stack' }
const TOP_NAMES: Record<string, string> = { ai: 'AI', ha: 'High availability', dns: 'DNS', vpn: 'VPN', 'remote-access': 'Remote access', 'api-tokens': 'API tokens' }

const titleCase = (seg: string): string =>
  TOP_NAMES[seg] ?? seg.split('-').filter(Boolean).map((w, i) => (i === 0 ? w[0]?.toUpperCase() + w.slice(1) : w)).join(' ')

/** A short name for the current page, for the panel's "On:" chip and for the question's context line. */
export function pageLabel(pathname: string | null | undefined): string {
  const segs = (pathname ?? '/').split('/').filter(Boolean)
  if (!segs.length) return 'Home'
  if (segs[0] === 'plugins' && segs[1]) return PLUGIN_NAMES[segs[1]] ?? titleCase(segs[1])
  return segs.slice(0, 2).map(titleCase).join(' / ')
}

/** The one thing the person pointed at with "Ask about this". Only Arr Stack queue downloads can carry fixes. */
export interface PanelItem {
  kind: 'arr-queue'
  instance: 'sonarr' | 'radarr' | 'lidarr'
  downloadId: string
  title: string
  /** A short plain line about it, such as "Season 2 · stalled". Sent as context. */
  detail?: string
}

/** What the server is told about the item: only what its route reads. */
export const itemForApi = (i: PanelItem) => ({ kind: i.kind, instance: i.instance, downloadId: i.downloadId, title: i.title })

/** The question as the operator receives it: one line about where the person is, then what they typed. */
export function composeQuestion(page: string, item: PanelItem | null, text: string): string {
  const where = item
    ? `I am on the ${page} page, looking at "${item.title}"${item.detail ? ` (${item.detail})` : ''}.`
    : `I am on the ${page} page.`
  return `${where}\n\n${text.trim()}`
}

// ── Proposed fixes ────────────────────────────────────────────────────────────

export interface FixProposal { action: 'find-another' | 'retry-import' | 'prioritise'; instance: PanelItem['instance']; downloadId: string; title: string; item: string }

/** Actions that remove and re-search: the queue route asks for them to be previewed and confirmed. */
export const DESTRUCTIVE_FIX = (a: FixProposal['action']): boolean => a === 'find-another'

export const FIX_URL = '/api/plugins/arrstack/queue/actions'

/** The body for the existing queue-actions route. A preview changes nothing; a confirmed run carries `confirmed`. */
export function fixBody(p: FixProposal, mode: 'preview' | 'run') {
  return {
    action: p.action, instance: p.instance, downloadId: p.downloadId,
    ...(mode === 'preview' ? { preview: true } : DESTRUCTIVE_FIX(p.action) ? { confirmed: true } : {}),
  }
}

/** What a preview says would happen, in one plain sentence. */
export function planWords(plan: { items?: Array<{ name: string }>; search?: string[]; blocklist?: boolean } | undefined): string {
  if (!plan) return 'Nothing is listed to change.'
  const names = (plan.items ?? []).map(i => i.name).slice(0, 3)
  const parts: string[] = []
  if (names.length) parts.push(`take ${names.map(n => `"${n}"`).join(', ')} out of the queue${plan.blocklist ? ' and avoid that release' : ''}`)
  if (plan.search?.length) parts.push(`then search for another copy (${plan.search.slice(0, 2).join('; ')})`)
  return parts.length ? `This would ${parts.join(', ')}.` : 'Nothing is listed to change.'
}

// ── Working indicator, retry, and the answer's own words ────────────────────────

/** The line under the spinner. A local answer can take two minutes; the page stays usable. */
export function workingWords(seconds: number, tier: Tier | null): string {
  const s = Math.max(0, Math.floor(seconds))
  const who = tier ? (tier === 'local' ? 'the local model' : tier[0].toUpperCase() + tier.slice(1)) : 'the operator'
  const base = `Asking ${who}... ${s} s.`
  return s >= 10 && (tier === 'local' || tier === null) ? `${base} The local model can take up to two minutes. You can keep using the page.` : base
}

/** "Ask Haiku instead", for a tier that failed. It only ever sends when clicked. */
export const retryLabel = (t: Tier): string => `Ask ${t[0].toUpperCase() + t.slice(1)} instead`

/** The server appends "Playbooks used: ..." to an answer; the panel shows that from the structured list instead. */
export const stripPlaybookLabel = (answer: string): string => answer.replace(/\n\nPlaybooks used: [^\n]*\.?\s*$/, '')

/** Quick questions offered when the panel is pointed at an item. */
export const ITEM_CHIPS = ['Why is this stuck?', 'What should I do about it?']
