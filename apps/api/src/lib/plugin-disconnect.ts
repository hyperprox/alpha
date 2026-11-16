// =============================================================================
//  HyperProx — disconnecting a plug-in set up by its settings
//
//  "Disconnect" in a plug-in's settings: every setting it has is forgotten (its
//  vault item goes, keys and all), so it shows as not set up, drops off the
//  dashboard and is no longer read for metrics. Each address it was set up for
//  is remembered as dismissed by auto-connect first, so the next pass does not
//  put it straight back; "Connect again" on the Plug-ins page undoes that.
//
//  A plug-in with its own list of devices or instances (Homepage, Nextcloud,
//  PBS, QNAP, ASUS, Home Assistant) is not disconnected here: each one is
//  removed on that plug-in's page, which also undoes what was set up on it.
// =============================================================================

import { addressSettings, type PluginManifest } from './plugin-host'

/** Plug-ins whose devices or instances are added and removed on their own page. */
export const OWN_PAGE_PLUGINS: Record<string, string> = {
  homepage: 'Disconnect each dashboard on the Homepage page.',
  nextcloud: 'Remove each Nextcloud on the Nextcloud page.',
  pbs: 'Remove each backup server on the Proxmox Backup Server page.',
  qnap: 'Remove each NAS on the QNAP page.',
  asus: 'Remove each router on the ASUS page.',
  'home-assistant': 'Remove each house on the Home Assistant page.',
}

export class PluginDisconnectRefusal extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); this.name = 'PluginDisconnectRefusal' }
}

export interface DisconnectDeps {
  settings(pluginId: string): Promise<Record<string, string>>
  /** Remove the plug-in's whole vault item (every setting). */
  forgetAll(pluginId: string): Promise<void>
  /** Auto-connect's dismissal (lib/auto-connect rememberDismissed). */
  dismiss(plugin: string, key: string, label: string, by: string): Promise<void>
  /** Throws when the row cannot be written: then nothing is changed. */
  audit(action: string, resource: string, details: Record<string, unknown>): Promise<void>
}

const originOf = (v: string) => { try { const u = new URL(v); return `${u.protocol}//${u.host}`.toLowerCase() } catch { return String(v).trim().toLowerCase() } }

/** The auto-connect key an address setting is remembered by (lib/auto-connect/settings-adapter.ts outKey). */
export const dismissKey = (setting: string, address: string) => `${setting}@${originOf(address)}`

export async function disconnectPlugin(m: PluginManifest, by: string, d: DisconnectDeps): Promise<{ forgot: string[]; dismissed: string[] }> {
  if (OWN_PAGE_PLUGINS[m.id]) throw new PluginDisconnectRefusal('use_page', OWN_PAGE_PLUGINS[m.id])
  const stored = await d.settings(m.id)
  const forgot = Object.keys(stored).filter(k => stored[k] !== '').sort()
  if (!forgot.length) throw new PluginDisconnectRefusal('not_set_up', `${m.name} has nothing saved, so there is nothing to disconnect.`, 404)
  const addresses = addressSettings(m).filter(a => (stored[a.key] ?? '').trim()).map(a => ({ key: dismissKey(a.key, stored[a.key]), label: `${m.name}: ${stored[a.key]}` }))
  // Setting names only, never a value.
  await d.audit('plugin.disconnect', `plugin:${m.id}`, { by, settings: forgot, dismissed: addresses.map(a => a.key) })
  // Remembered before anything is forgotten: auto-connect must never see the empty settings without the dismissal.
  for (const a of addresses) await d.dismiss(m.id, a.key, a.label, by)
  await d.forgetAll(m.id)
  return { forgot, dismissed: addresses.map(a => a.key) }
}
