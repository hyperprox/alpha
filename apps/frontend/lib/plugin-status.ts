// How a plug-in card words its state. A plug-in that was never set up is not "unreachable": nothing was
// asked of it, so nothing failed. CSS-free so it can be tested on its own.

export interface PluginReading { off?: boolean; error?: string; tone?: 'good' | 'warn' | 'bad'; headline?: string }
export type PluginKind = 'off' | 'not-set-up' | 'unreachable' | 'attention' | 'active'

/** The plug-in's own answer says it has nothing to talk to yet ("Not configured yet: add a router on ..."). */
export function isNotConfigured(error: string | undefined | null): boolean {
  return !!error && /^\s*not (configured|set up)\b|\bnot configured yet\b|\bno (address|login|token|api key|server|router|nas)\b.*\b(saved|added|set up|configured)\b/i.test(error)
}

export function pluginKind(p: PluginReading): PluginKind {
  // Not set up has one name everywhere: a plug-in with no settings (off) and one whose own answer says it has
  // nothing to talk to read the same, "Not set up", on the dashboard, the gallery and the detail page.
  if (p.off) return 'not-set-up'
  if (p.error) return isNotConfigured(p.error) ? 'not-set-up' : 'unreachable'
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
