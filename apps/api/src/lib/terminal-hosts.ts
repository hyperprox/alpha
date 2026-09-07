// =============================================================================
//  HyperProx — Manual Deck hosts
//
//  Hosts Proxmox has never heard of: a router, a NAS, a laptop, a VPS. Kept in
//  the credential store so this phase needs no schema migration — the values are
//  not secret, only small. A dedicated table is the right home once Decks and
//  tiles land beside them.
// =============================================================================

import { getCredential, setCredential, deleteCredential, listCredentialKeys } from './credentials'

export const CREDENTIAL_CATEGORY = 'deck'
const PROVIDER = 'manualhost'

export interface ManualHost {
  id:      string
  name:    string
  address: string
  port:    number
}

/** Prefixed so a manual host can never collide with a cluster guest id. */
function idFor(name: string): string {
  return 'ssh-' + name.toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 60)
}

export async function listManualHosts(): Promise<ManualHost[]> {
  const keys  = await listCredentialKeys(CREDENTIAL_CATEGORY, PROVIDER)
  const hosts: ManualHost[] = []

  for (const { key } of keys) {
    const raw = await getCredential(CREDENTIAL_CATEGORY, PROVIDER, key)
    if (!raw) continue
    try { hosts.push(JSON.parse(raw) as ManualHost) }
    catch { /* a corrupt row must not blank the whole list */ }
  }

  return hosts.sort((a, b) => a.name.localeCompare(b.name))
}

export async function saveManualHost(input: Omit<ManualHost, 'id'>): Promise<ManualHost> {
  const host: ManualHost = { id: idFor(input.name), ...input }
  await setCredential(CREDENTIAL_CATEGORY, PROVIDER, host.id, JSON.stringify(host), false)
  return host
}

export async function removeManualHost(id: string): Promise<void> {
  await deleteCredential(CREDENTIAL_CATEGORY, PROVIDER, id)
}
