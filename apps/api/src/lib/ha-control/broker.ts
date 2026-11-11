// =============================================================================
//  HyperProx — the Home Assistant plug-in's only transport
//
//  The read-only plug-in (card, health page, metrics, the assistant's summary)
//  reads house #1. Its token must never travel through the generic plug-in
//  broker, which knows nothing of this feature's address rules, certificate
//  pins or deadlines. So the plug-in declares coreTransport and this module is
//  the transport: the same InstanceStore connection and the same HttpHAClient
//  the controls use, GET only, and only the paths in PLUGIN_READS.
// =============================================================================

import { setPluginTransport } from '../plugin-host'
import { getCredential, setCredential, deleteProviderCredentials } from '../credentials'
import { HttpHAClient, HAUnreachableError, type HAConnection } from './client'
import { DEFAULT_ID, InstanceStore, PLUGIN_ID } from './instances'

export interface PluginTransportDeps {
  store?: InstanceStore
  clientFor?: (c: HAConnection) => HttpHAClient
}

export function installHAPluginTransport(deps: PluginTransportDeps = {}): void {
  const store = deps.store ?? new InstanceStore({ get: getCredential, set: setCredential, remove: deleteProviderCredentials })
  const clientFor = deps.clientFor ?? (c => new HttpHAClient(c))
  setPluginTransport(PLUGIN_ID, async (method, path, timeoutMs) => {
    if (method !== 'GET') throw new HAUnreachableError('The Home Assistant plug-in only reads.')
    const c = await store.connection(DEFAULT_ID)
    if (!c) throw new Error('Not configured yet: add a house on the Home Assistant page.')
    return clientFor(c).pluginRead(path, timeoutMs)
  })
}

installHAPluginTransport()
