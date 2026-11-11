// =============================================================================
//  The top bar's crumb and title for pages whose name is only known at run time
//
//  nav.tsx names every fixed page. A plug-in page (/plugins/<id>) is named after
//  the plug-in itself ("Router", "Home Assistant"), and a page under a list (a
//  plug-in, a cluster) gets a crumb that links back to that list. Kept apart
//  from nav.tsx, which draws icons, so it can be tested without a browser.
// =============================================================================

export interface PageMeta { crumb: string; title: string; crumbHref?: string }

/** Names shown before the plug-in list has loaded, so the title never flashes a generic word. */
export const PLUGIN_NAMES: Record<string, string> = {
  'home-assistant': 'Home Assistant', plex: 'Plex', arrstack: 'Arr Stack', unmanic: 'Unmanic',
  mikrotik: 'MikroTik', meshcentral: 'MeshCentral', qnap: 'QNAP',
}

/** The plug-in a path is for (/plugins/<id>), or null. */
export function pluginIdOf(pathname: string): string | null {
  const m = /^\/plugins\/([^/?#]+)\/?$/.exec(pathname)
  if (!m) return null
  const id = decodeURIComponent(m[1])
  return id === '' ? null : id
}

/** A readable name for an id nobody listed: "my-thing" -> "My thing". */
function humanise(id: string): string {
  const words = id.replace(/[-_]+/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : 'Plug-in'
}

/**
 * The crumb and title for `pathname`, starting from what nav.tsx says (`base`). `names` maps plug-in ids to the
 * names the API reports; it wins over the built-in list, so a renamed or new plug-in shows its own name.
 */
export function resolvePageMeta(base: PageMeta, pathname: string, names?: Record<string, string> | null): PageMeta {
  const plugin = pluginIdOf(pathname)
  if (plugin) return { crumb: 'Plug-ins', crumbHref: '/plugins', title: names?.[plugin] || PLUGIN_NAMES[plugin] || humanise(plugin) }
  if (/^\/clusters\/[^/]+(\/updates)?$/.test(pathname) && pathname !== '/clusters/add') return { ...base, crumbHref: '/clusters' }
  return base
}
