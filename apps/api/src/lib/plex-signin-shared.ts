// =============================================================================
//  HyperProx — the one Sign in with Plex service
//
//  Both the Plex plug-in's sign-in routes (routes/plex-signin.ts) and the Catalogue install of a new Plex server
//  (which claims it to the signed-in account and connects the plug-in) use this single instance, so a sign-in the
//  page started is the one the install finishes.
// =============================================================================

import { randomUUID } from 'node:crypto'
import { auditOrThrow } from './audit'
import { PLUGIN_CATEGORY, fetchWithTimeout, saveSettings } from './plugin-host'
import { getCredential, setCredential } from './credentials'
import { PlexSignin, type PlexHttp, type SigninDeps } from './plex-signin'
import { findPlugin } from '../plugins'

/** The setting that holds this install's Plex client identifier. Not secret: plex.tv shows it as the device. */
export const CLIENT_ID_KEY = 'plex_client_id'

const PLEX_MAX_BYTES = 4 * 1024 * 1024

export const plexHttp: PlexHttp = async (method, url, headers, timeoutMs) => {
  // buffer() stops reading past 4 MiB (text() has no cap).
  const r = await fetchWithTimeout(url, headers, false, method, undefined, timeoutMs, PLEX_MAX_BYTES)
  return { status: r.status, ok: r.ok, json: async () => JSON.parse((await r.buffer()).toString('utf8')) }
}

export async function plexClientId(): Promise<string> {
  const have = await getCredential(PLUGIN_CATEGORY, 'plex', CLIENT_ID_KEY)
  if (have) return have
  const id = randomUUID()
  await setCredential(PLUGIN_CATEGORY, 'plex', CLIENT_ID_KEY, id, false)
  return id
}

export async function savePlexEndpoint(url: string, serverToken: string): Promise<void> {
  const p = findPlugin('plex')
  if (!p) throw new Error('The Plex plug-in is not installed.')
  await saveSettings(p.manifest, { plex_url: url, plex_token: serverToken })
}

let shared: PlexSignin | null = null

export function sharedPlexSignin(log?: (msg: string, fields?: Record<string, unknown>) => void): PlexSignin {
  return (shared ??= new PlexSignin({
    http: plexHttp, clientId: plexClientId, save: savePlexEndpoint,
    // Throws when the row is not written, so the person is told (the save itself stands).
    audit: (action, details) => auditOrThrow(action, 'plugin:plex', details),
    log,
  } satisfies SigninDeps))
}
