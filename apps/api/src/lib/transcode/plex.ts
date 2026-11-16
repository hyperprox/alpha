// =============================================================================
//  HyperProx — Plex Media Server's setup chores
//
//  After the package starts, what a person would otherwise do in Plex's own setup pages:
//
//    wait       until /identity answers with the server's machine identifier;
//    claim      give the server to the Plex account the person signed in with, in the wizard. The claim code is asked
//               of plex.tv at the last moment (it lives about four minutes), posted to the server's own address, and
//               read back (/identity says claimed). With no sign-in, the server is left unclaimed on the network and
//               the step says so;
//    hardware   turn on hardware transcoding when the container was given a graphics card (Plex uses it only for an
//               account with a Plex Pass, which the step says);
//    libraries  a Movies and a TV Shows library on the movies and tv folders inside /data/media, when those folders
//               exist (Plex's own folder browser says), read back from the library list;
//    plug-in    connect HyperProx's Plex plug-in, with the server's token kept in the vault, through the same
//               sign-in that claimed it (lib/plex-signin.ts connectClaimed).
//
//  Every change is read back from the server before a step is "done". No token is logged or put on a step's detail.
// =============================================================================

import type { TcSetupDeps } from './setup'
import { LIBRARY_DIR } from './media'
import { PLEX_PORT } from './compose'

export const plexUrl = (ip: string) => `http://${ip}:${PLEX_PORT}`

class PlexSetupError extends Error {}
const fail = (m: string): never => { throw new PlexSetupError(m) }

/** What a claim needs of the Sign in with Plex service (lib/plex-signin.ts), so tests stand in for plex.tv. */
export interface PlexClaimDeps {
  claimReady(flowId: string, owner: string): { user: string } | null
  claimToken(flowId: string, owner: string): Promise<string>
  connectClaimed(flowId: string, owner: string, o: { machineId: string; url: string; by: string; tries?: number; wait?: (ms: number) => Promise<unknown> }): Promise<{ server: string; user: string }>
  endClaim(flowId: string, owner: string): void
}

export interface PlexSetupDeps extends TcSetupDeps { claim?: PlexClaimDeps }

export interface Identity { machineId: string; version: string; claimed: boolean }

/** Parse /identity: JSON when asked for it, XML otherwise. Null when the answer is not a Plex server's. */
export function parseIdentity(status: number, body: string): Identity | null {
  if (status !== 200) return null
  try {
    const mc = JSON.parse(body)?.MediaContainer
    if (mc && typeof mc.machineIdentifier === 'string' && mc.machineIdentifier) {
      return { machineId: mc.machineIdentifier, version: String(mc.version ?? '').slice(0, 40), claimed: mc.claimed === true || mc.claimed === 1 || mc.claimed === '1' }
    }
    return null
  } catch { /* XML */ }
  const m = /<MediaContainer\b[^>]*>/.exec(body)?.[0]
  const id = m && /\bmachineIdentifier="([^"]+)"/.exec(m)?.[1]
  if (!m || !id) return null
  return { machineId: id, version: /\bversion="([^"]*)"/.exec(m)?.[1]?.slice(0, 40) ?? '', claimed: /\bclaimed="1"/.test(m) }
}

const JSON_HEADERS = { Accept: 'application/json' }

/** Plex turns a request away with 401 or 403 once it is claimed and no token came with it. */
export class PlexAuthRefused extends Error {
  constructor() { super('Plex wants its token for this now that it is claimed.'); this.name = 'PlexAuthRefused' }
}
/** Headers for a request to the server: with the server's own token when there is one (after a claim). */
const hdr = (token?: string): Record<string, string> => (token ? { ...JSON_HEADERS, 'X-Plex-Token': token } : JSON_HEADERS)
const guard = <T extends { status: number }>(r: T | null): T | null => {
  if (r && (r.status === 401 || r.status === 403)) throw new PlexAuthRefused()
  return r
}

async function identity(d: TcSetupDeps, base: string): Promise<Identity | null> {
  const r = await d.http({ method: 'GET', url: `${base}/identity`, headers: JSON_HEADERS, timeoutMs: 6000 }).catch(() => null)
  return r ? parseIdentity(r.status, r.body) : null
}

/** Wait (about three minutes) for the server to answer /identity. */
export async function waitForPlex(d: TcSetupDeps, base: string, tries = 60): Promise<Identity> {
  for (let i = 0; i < tries; i++) {
    const id = await identity(d, base)
    if (id) return id
    await d.wait(3000)
  }
  return fail('Plex did not answer after three minutes. The container may still be starting; open it and check, then run the install again if it never comes up.')
}

/**
 * Claim the server. The claim code goes to the server's own address as a query value and is never logged or shown;
 * the step is done only when /identity says claimed.
 */
export async function claimServer(d: TcSetupDeps, base: string, claimToken: string, tries = 10): Promise<void> {
  if (!/^claim-[A-Za-z0-9_-]{8,64}$/.test(claimToken)) fail('The claim code from plex.tv is not in the form Plex gives.')
  const r = await d.http({ method: 'POST', url: `${base}/myplex/claim?token=${encodeURIComponent(claimToken)}`, headers: JSON_HEADERS, timeoutMs: 30_000 })
  if (r.status < 200 || r.status >= 300) fail(`Plex refused the claim (HTTP ${r.status}). The code lasts four minutes; run the install again to get a new one.`)
  for (let i = 0; i < tries; i++) {
    if ((await identity(d, base))?.claimed) return
    await d.wait(2000)
  }
  fail('Plex accepted the claim but does not say it is claimed yet.')
}

/**
 * Turn hardware transcoding on. Plex lists this preference only once a Plex Pass account has claimed the server, so it
 * cannot be read back through the API: the answer is the server's HTTP 200, and the value was seen to land in its
 * preferences file in the install test. The step says so.
 */
export async function enableHardwareTranscoding(d: TcSetupDeps, base: string, token?: string): Promise<{ status: 'done' | 'skipped'; detail: string }> {
  const put = guard(await d.http({ method: 'PUT', url: `${base}/:/prefs?HardwareAcceleratedCodecs=1`, headers: hdr(token), timeoutMs: 15_000 }).catch(() => null))
  if (!put || put.status < 200 || put.status >= 300) return { status: 'skipped', detail: `Plex would not take the hardware transcoding setting (HTTP ${put?.status ?? 'no answer'}). Turn it on in Plex under Settings, Transcoder.` }
  return { status: 'done', detail: 'Hardware transcoding is switched on. Plex uses the graphics card only for an account with a Plex Pass, and shows this setting only once such an account owns the server.' }
}

/** The folders Plex itself can see under a path (its own folder browser), or null when it cannot be read. */
export async function browse(d: TcSetupDeps, base: string, path: string, token?: string): Promise<string[] | null> {
  const r = guard(await d.http({ method: 'GET', url: `${base}/services/browse/${Buffer.from(path, 'utf8').toString('base64')}?includeFiles=0`, headers: hdr(token), timeoutMs: 15_000 }).catch(() => null))
  if (!r || r.status !== 200) return null
  try { return (JSON.parse(r.body)?.MediaContainer?.Path ?? []).map((p: any) => String(p?.path ?? '')).filter(Boolean) } catch { return null }
}

const LIBS = [
  { name: 'Movies', folder: 'movies', type: 'movie', agent: 'tv.plex.agents.movie', scanner: 'Plex Movie' },
  { name: 'TV Shows', folder: 'tv', type: 'show', agent: 'tv.plex.agents.series', scanner: 'Plex TV Series' },
] as const

/** The libraries the server has now: title and the folders each reads. */
async function sections(d: TcSetupDeps, base: string, token?: string): Promise<Array<{ title: string; locations: string[] }> | null> {
  const r = guard(await d.http({ method: 'GET', url: `${base}/library/sections`, headers: hdr(token), timeoutMs: 15_000 }).catch(() => null))
  if (!r || r.status !== 200) return null
  try {
    return (JSON.parse(r.body)?.MediaContainer?.Directory ?? []).map((x: any) => ({ title: String(x?.title ?? ''), locations: (x?.Location ?? []).map((l: any) => String(l?.path ?? '')) }))
  } catch { return null }
}

/**
 * Add a Movies and a TV Shows library where the folders exist. A folder that already has a library, by that folder
 * or by that name, is left alone. Each library is read back from the list.
 */
export async function addLibraries(d: TcSetupDeps, base: string, token?: string): Promise<{ status: 'done' | 'skipped'; detail: string }> {
  const have = await sections(d, base, token)
  if (have === null) return { status: 'skipped', detail: 'Plex would not list its libraries. Add your libraries in Plex under Settings, Libraries.' }
  const dirs = await browse(d, base, LIBRARY_DIR, token)
  if (dirs === null) return { status: 'skipped', detail: `Plex could not look inside ${LIBRARY_DIR}. Add your libraries in Plex under Settings, Libraries.` }
  const made: string[] = [], kept: string[] = [], absent: string[] = []
  for (const l of LIBS) {
    const folder = `${LIBRARY_DIR}/${l.folder}`
    if (!dirs.includes(folder)) { absent.push(l.folder); continue }
    if (have.some(h => h.title === l.name || h.locations.includes(folder))) { kept.push(l.name); continue }
    const q = new URLSearchParams({ name: l.name, type: l.type, agent: l.agent, scanner: l.scanner, language: 'en-US', location: folder })
    const r = guard(await d.http({ method: 'POST', url: `${base}/library/sections?${q.toString()}`, headers: hdr(token), timeoutMs: 30_000 }).catch(() => null))
    if (!r || r.status < 200 || r.status >= 300) fail(`Plex refused to add the ${l.name} library (HTTP ${r?.status ?? 'no answer'}).`)
    made.push(l.name)
  }
  if (made.length) {
    const back = await sections(d, base, token)
    const miss = made.filter(n => !back?.some(b => b.title === n))
    if (miss.length) fail(`Plex did not list the ${miss.join(' and ')} library after it was added.`)
  }
  const parts = [
    made.length ? `Added ${made.join(' and ')}.` : '',
    kept.length ? `${kept.join(' and ')} already existed.` : '',
    absent.length ? `No ${absent.map(a => `${LIBRARY_DIR}/${a}`).join(' or ')} folder to point at; add that library in Plex when the folder is there.` : '',
  ].filter(Boolean)
  return { status: made.length || kept.length ? 'done' : 'skipped', detail: parts.join(' ') }
}

/** The step texts for a Plex install, the claim and plug-in steps depending on the sign-in the person made. */
export interface PlexRunInput {
  ip: string; by: string; owner: string; signinId: string; librariesWanted: boolean; hardware: boolean
}

export const PLEX_NO_SIGNIN = 'No Plex sign-in was made, so the server is not claimed. Open it from a device on your network to claim it; the Plex plug-in then connects with Sign in with Plex on its page.'
