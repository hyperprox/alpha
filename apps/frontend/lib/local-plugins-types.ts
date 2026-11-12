// The shape of a local plug-in's page: see scripts/local-plugins.js.
import type { ComponentType } from 'react'

export interface LocalPluginUI {
  /** The same id as its API half: the page is /plugins/local/<id>, its routes /api/local/<id>. */
  id: string
  name: string
  description: string
  /** A short symbol for the gallery card (an emoji or one or two letters). */
  icon?: string
  /** The page, loaded only when it is opened. */
  load: () => Promise<{ default: ComponentType }>
}
