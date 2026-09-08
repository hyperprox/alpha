// =============================================================================
//  Bundled plug-ins
//
//  These go through exactly the same interface a third-party plug-in would —
//  that is what keeps the interface honest. If something here needs a shortcut,
//  the interface is wrong, not the plug-in.
// =============================================================================

import type { Plugin } from '../lib/plugin-host'
import { mikrotikPlugin }    from './mikrotik'
import { plexPlugin }        from './plex'
import { unmanicPlugin }     from './unmanic'
import { qbittorrentPlugin } from './qbittorrent'
import { arrstackPlugin }    from './arrstack'
import { prowlarrPlugin }    from './prowlarr'

export const PLUGINS: Plugin[] = [
  prowlarrPlugin,
  mikrotikPlugin,
  plexPlugin,
  arrstackPlugin,
  qbittorrentPlugin,
  unmanicPlugin,
]

export function findPlugin(id: string): Plugin | undefined {
  return PLUGINS.find(p => p.manifest.id === id)
}
