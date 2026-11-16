// How a plug-in card words its state. A plug-in that was never set up is not "unreachable": nothing was
// asked of it, so nothing failed. CSS-free so it can be tested on its own.

export interface PluginReading { off?: boolean; error?: string; code?: string; tone?: 'good' | 'warn' | 'bad'; headline?: string }
export type PluginKind = 'off' | 'not-set-up' | 'unreachable' | 'attention' | 'active'

/**
 * The plug-in has nothing to talk to yet. The API says so with code not_configured (or credential_required); the
 * text ("Not configured yet: add a router on ...") is still matched for an older API.
 */
export function isNotConfigured(error: string | undefined | null, code?: string | null): boolean {
  if (code === 'not_configured' || code === 'credential_required') return true
  return !!error && /^\s*not (configured|set up)\b|\bnot configured yet\b|\bno (address|login|token|api key|server|router|nas)\b.*\b(saved|added|set up|configured)\b/i.test(error)
}

export function pluginKind(p: PluginReading): PluginKind {
  // Not set up has one name everywhere: a plug-in with no settings (off) and one whose own answer says it has
  // nothing to talk to read the same, "Not set up", on the dashboard, the gallery and the detail page.
  if (p.off) return 'not-set-up'
  if (p.error) return isNotConfigured(p.error, p.code) ? 'not-set-up' : 'unreachable'
  if (p.tone === 'bad' || p.tone === 'warn') return 'attention'
  return 'active'
}

/** The short phrase beside a plug-in's name on the dashboard chips. */
export function pluginWord(p: PluginReading): string {
  switch (pluginKind(p)) {
    case 'off': return 'Off'
    case 'not-set-up': return 'Not set up'
    case 'unreachable': return 'Needs attention: unreachable'
    case 'attention': return `Needs attention: ${p.headline ?? 'check it'}`
    default: return 'Active'
  }
}

/** The badge on a full card. */
export function pluginBadge(p: PluginReading): string {
  switch (pluginKind(p)) {
    case 'not-set-up': return 'NOT SET UP'
    case 'unreachable': return 'UNREACHABLE'
    case 'attention': return p.tone === 'bad' ? 'NEEDS YOU' : 'CHECK'
    case 'off': return 'OFF'
    default: return 'LIVE'
  }
}

/** What auto-connect says about a plug-in (GET /api/auto-connect), as much as a card needs. */
export interface AutoConnectSummary {
  pending: Record<string, unknown>
  lastRun: { results: Record<string, Partial<Record<string, number>>> } | null
  waitingForUnlock: boolean
}

/** Plug-ins whose installs auto-connect finds and connects by itself. */
export const AUTO_CONNECT_PLUGINS = ['homepage', 'nextcloud', 'unmanic', 'arrstack', 'plex', 'pihole', 'adguard']

/**
 * The card's state line for a plug-in that is not set up but that auto-connect is handling, or null to show the
 * plug-in's own "needs …" and its Set up button. A pick waiting wins; then a locked vault; then "connecting" while it
 * has found something it has not finished (or before its first pass has run, for a plug-in with nothing to type).
 */
export function autoConnectWord(pluginId: string, s: AutoConnectSummary | null): { word: string; pick: boolean } | null {
  if (!s || !AUTO_CONNECT_PLUGINS.includes(pluginId)) return null
  if (Object.keys(s.pending ?? {}).some(k => k.startsWith(`${pluginId}/`))) return { word: 'one to pick: see "Connecting by itself"', pick: true }
  const r = s.lastRun?.results?.[pluginId] ?? {}
  const n = (did: string) => r[did] ?? 0
  const noForm = pluginId === 'homepage' || pluginId === 'nextcloud' || pluginId === 'pihole' || pluginId === 'adguard'
  // Found and being connected (the card turns "connected" on its next read). A key that is missing, or a failure,
  // is not "connecting": those keep the plug-in's own "needs …" and Set up.
  const busy = n('connected') + n('filled') > 0 || (noForm && !s.lastRun)
  if (s.waitingForUnlock && (busy || noForm)) return { word: 'connects automatically once HyperProx is unlocked', pick: false }
  if (busy) return { word: 'connecting automatically…', pick: false }
  return null
}
