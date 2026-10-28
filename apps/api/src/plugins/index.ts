// =============================================================================
//  Bundled plug-ins
//
//  These go through exactly the same interface a third-party plug-in would —
//  that is what keeps the interface honest. If something here needs a shortcut,
//  the interface is wrong, not the plug-in.
// =============================================================================

import type { Plugin } from '../lib/plugin-host'
import { arrstackPlugin } from './arrstack'
import { homeAssistantPlugin } from './home-assistant'
import { meshcentralPlugin } from './meshcentral'
import { mikrotikPlugin } from './mikrotik'
import { plexPlugin }     from './plex'
import { unmanicPlugin }  from './unmanic'

export const PLUGINS: Plugin[] = [
  arrstackPlugin,
  homeAssistantPlugin,
  plexPlugin,
  unmanicPlugin,
  mikrotikPlugin,
  meshcentralPlugin,
]

export function findPlugin(id: string): Plugin | undefined {
  return PLUGINS.find(p => p.manifest.id === id)
}
