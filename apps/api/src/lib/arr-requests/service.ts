// =============================================================================
//  HyperProx — Arr Stack, Seerr requests: the service
//
//  Reads Seerr's requests (one shared reading, a few seconds old at most), says where each one is, and does the four
//  things an admin may do about them: approve, decline (with a reason if they like), retry a failed one (Seerr sends it
//  to Radarr or Sonarr again), and the two fixes for what usually makes requests fail: "Fix Seerr's settings" (a quality
//  profile or root folder that no longer exists in Radarr or Sonarr) and "Reconnect" (Seerr's key to Radarr, Sonarr or the
//  media server was refused; the stored one is put back).
//
//  Every change is audited BEFORE it is made, re-reads what it changed, and says plainly when the change did not hold.
//  The route has already checked the role and taken the confirmation. Seerr's address and key stay in the plug-in
//  settings (the endpoint client); nothing secret is in any answer or audit row. Never writes anywhere but Seerr.
// =============================================================================

import type { CoreEndpointClient } from '../plugin-host'
import { MEDIA_NAME, mediaSettingsBody, type MediaKind, type MediaServer } from '../arr/media-server'
import {
  APP_NAME, GROUPS, buildRows, classify, countsOf, fixedServer, problemText, staleServers, titleOf, whyFailed,
  type ArrApp, type ArrFacts, type Group, type HealthProblem, type Kind, type RequestRow, type SortedMove, type StaleServer, type TitleInfo,
} from './logic'

export class RequestsRefusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'RequestsRefusal' }
}

export interface RequestsDeps {
  seerr: () => Promise<CoreEndpointClient | null>
  radarr: () => Promise<CoreEndpointClient | null>
  sonarr: () => Promise<CoreEndpointClient | null>
  /** What the folder sorter has put in folders recently ("sorted into X"). May be empty. */
  moves?: () => Promise<SortedMove[]>
  /** The keys the Arr Stack plug-in holds for Radarr and Sonarr, for the reconnect fix. Never returned. */
  keys: () => Promise<{ radarr?: string; sonarr?: string }>
  /** The media server HyperProx knows (Plex or Jellyfin), for the reconnect fix. */
  media: (prefer?: MediaKind) => Promise<MediaServer | null>
  audit: (action: string, details: Record<string, unknown>) => Promise<void>
  now: () => number
  log?: (m: string) => void
}

const PAGE = 60
const TTL_MS = 4_000
const TITLE_TTL_MS = 6 * 3600_000
const TITLE_BUDGET_MS = 8_000
const msg = (e: any) => String(e?.message ?? e).slice(0, 160)

export type ActionName = 'approve' | 'decline' | 'retry' | 'fix-settings' | 'reconnect'
export const ACTIONS: ActionName[] = ['approve', 'decline', 'retry', 'fix-settings', 'reconnect']
export type Target = 'radarr' | 'sonarr' | 'media'

export interface Listing { configured: boolean; rows: RequestRow[]; counts: Record<Group, number>; readAt: string; capped: boolean }
export interface HealthReading { configured: boolean; problems: HealthProblem[]; stale: StaleServer[]; readAt: string }
export interface ActResult { action: ActionName; done: boolean; summary: string; notes: string[] }

export class RequestsService {
  private titles = new Map<string, { at: number; info: TitleInfo }>()
  private memo: { at: number; raw: any[]; capped: boolean } | null = null
  /** The last reading's titles, for the confirmation sentence: id → title. */
  private known = new Map<number, string>()

  constructor(private d: RequestsDeps) {}

  private async seerr(): Promise<CoreEndpointClient | null> { return this.d.seerr().catch(() => null) }

  /** The title of a request in the last reading, for a confirmation's words. */
  titleOfRequest(id: unknown): string | null { return typeof id === 'number' ? this.known.get(id) ?? null : null }

  private async readRaw(c: CoreEndpointClient): Promise<{ raw: any[]; capped: boolean }> {
    const now = this.d.now()
    if (this.memo && now - this.memo.at < TTL_MS) return this.memo
    const a = await c.get(`/api/v1/request?take=${PAGE}&skip=0&sort=added&filter=all`, 20_000)
    const raw = Array.isArray(a?.results) ? a.results : []
    const total = Number(a?.pageInfo?.results)
    this.memo = { at: now, raw, capped: Number.isFinite(total) && total > raw.length }
    return this.memo
  }

  /** Film and show names and posters for the requests, from Seerr, cached; a lookup that fails leaves a plain placeholder. */
  private async lookupTitles(c: CoreEndpointClient, raw: any[]): Promise<Map<string, TitleInfo>> {
    const now = this.d.now()
    const out = new Map<string, TitleInfo>()
    const want: Array<{ key: string; kind: Kind; id: number }> = []
    for (const r of raw) {
      const kind: Kind | null = r?.media?.mediaType === 'movie' ? 'movie' : r?.media?.mediaType === 'tv' ? 'tv' : null
      const id = Number(r?.media?.tmdbId)
      if (!kind || !Number.isInteger(id) || id < 1) continue
      const key = `${kind}:${id}`
      const hit = this.titles.get(key)
      if (hit && now - hit.at < TITLE_TTL_MS) { out.set(key, hit.info); continue }
      if (!want.some(w => w.key === key)) want.push({ key, kind, id })
    }
    const deadline = now + TITLE_BUDGET_MS
    for (let i = 0; i < want.length; i += 6) {
      if (this.d.now() > deadline) break
      await Promise.all(want.slice(i, i + 6).map(async w => {
        try {
          const info = titleOf(w.kind, await c.get(`/api/v1/${w.kind === 'movie' ? 'movie' : 'tv'}/${w.id}`, 8_000))
          if (info.title) { this.titles.set(w.key, { at: this.d.now(), info }); out.set(w.key, info) }
        } catch { /* the row says "A film" */ }
      }))
    }
    return out
  }

  async list(admin: boolean): Promise<Listing> {
    const c = await this.seerr()
    const readAt = new Date(this.d.now()).toISOString()
    if (!c) return { configured: false, rows: [], counts: countsOf([]), readAt, capped: false }
    const { raw, capped } = await this.readRaw(c)
    const titles = await this.lookupTitles(c, raw)
    const moves = await (this.d.moves?.() ?? Promise.resolve([])).catch(() => [])
    const rows = buildRows(raw, titles, moves, admin)
    for (const r of rows) this.known.set(r.id, r.title)
    return { configured: true, rows, counts: countsOf(rows), readAt, capped }
  }

  /** Seerr's poster for one TMDB file name, through Seerr's own image proxy. */
  async poster(file: string): Promise<{ contentType: string; body: Buffer } | null> {
    const c = await this.seerr()
    if (!c) return null
    try { return await c.image(`/imageproxy/tmdb/t/p/w185/${file}`, 10_000) } catch { return null }
  }

  // ── Settings and health ────────────────────────────────────────────────────

  private async arrClient(app: ArrApp): Promise<CoreEndpointClient | null> { return (app === 'radarr' ? this.d.radarr() : this.d.sonarr()).catch(() => null) }

  private async serversOf(c: CoreEndpointClient, app: ArrApp): Promise<any[]> {
    const l = await c.get(`/api/v1/settings/${app}`, 10_000)
    return Array.isArray(l) ? l : []
  }

  private async factsOf(app: ArrApp): Promise<ArrFacts | null> {
    const a = await this.arrClient(app)
    if (!a) return null
    const [p, r] = await Promise.all([a.get('/api/v3/qualityprofile', 10_000), a.get('/api/v3/rootfolder', 10_000)])
    return {
      profiles: (Array.isArray(p) ? p : []).filter(x => Number.isInteger(x?.id)).map(x => ({ id: Number(x.id), name: String(x.name ?? '').slice(0, 80) })),
      roots: (Array.isArray(r) ? r : []).map(x => String(x?.path ?? '')).filter(Boolean),
    }
  }

  async stale(c?: CoreEndpointClient | null): Promise<StaleServer[]> {
    const s = c ?? await this.seerr()
    if (!s) return []
    const out: StaleServer[] = []
    for (const app of ['radarr', 'sonarr'] as const) {
      try {
        const facts = await this.factsOf(app)
        if (!facts) continue
        out.push(...staleServers(app, await this.serversOf(s, app), facts))
      } catch (e) { this.d.log?.(`[arr-requests] ${app} settings could not be compared: ${msg(e)}`) }
    }
    return out
  }

  async health(): Promise<HealthReading> {
    const c = await this.seerr()
    const readAt = new Date(this.d.now()).toISOString()
    if (!c) return { configured: false, problems: [], stale: [], readAt }
    const problems: HealthProblem[] = []
    if (c.post) {
      for (const app of ['radarr', 'sonarr'] as const) {
        let servers: any[] = []
        try { servers = await this.serversOf(c, app) } catch { continue }
        for (const s of servers) {
          const serverId = Number(s?.id)
          if (!Number.isInteger(serverId)) continue
          try {
            await c.post(`/api/v1/settings/${app}/test`, { hostname: s.hostname, port: s.port, apiKey: s.apiKey, useSsl: s.useSsl === true, baseUrl: s.baseUrl ?? '' }, 15_000)
          } catch (e) {
            const why = whyFailed(app, e)
            problems.push({ kind: app, serverId, why, text: problemText(app, why) })
          }
        }
      }
    }
    const kind = await this.mediaKind(c)
    if (kind) {
      try { await c.get(`/api/v1/settings/${kind}/library?sync=true`, 20_000) } catch (e) {
        const why = whyFailed('media', e)
        problems.push({ kind: 'media', why, text: problemText('media', why, MEDIA_NAME[kind]) })
      }
    }
    return { configured: true, problems, stale: await this.stale(c), readAt }
  }

  /** Which media server Seerr is set up for, from its main settings; null when it is not set up for one. */
  private async mediaKind(c: CoreEndpointClient): Promise<'plex' | 'jellyfin' | null> {
    try {
      const t = Number((await c.get('/api/v1/settings/main', 10_000))?.mediaServerType)
      return t === 1 ? 'plex' : t === 2 ? 'jellyfin' : null
    } catch { return null }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async act(a: { action: ActionName; id?: number; reason?: string; target?: Target }, by: string): Promise<ActResult> {
    const c = await this.seerr()
    if (!c || !c.post) throw new RequestsRefusal(409, 'seerr_not_set', 'Seerr is not set up here yet. Save its address and API key in the Arr Stack settings first.')
    if (a.action === 'fix-settings') return this.fixSettings(c, by)
    if (a.action === 'reconnect') return this.reconnect(c, a.target ?? 'media', by)
    return this.requestAction(c, a.action, a.id, a.reason, by)
  }

  private async requestAction(c: CoreEndpointClient, action: 'approve' | 'decline' | 'retry', id: number | undefined, reason: string | undefined, by: string): Promise<ActResult> {
    if (!Number.isInteger(id) || id! < 1) throw new RequestsRefusal(400, 'bad_request', 'Name the request.')
    let now: any
    try { now = await c.get(`/api/v1/request/${id}`, 10_000) } catch { throw new RequestsRefusal(404, 'not_found', 'Seerr has no such request any more.') }
    const before = classify(now).group
    const need: Group = action === 'retry' ? 'failed' : 'pending'
    if (before !== need) {
      throw new RequestsRefusal(409, 'not_in_state', action === 'retry' ? 'Only a failed request can be tried again. This one is not failed any more.' : `Only a request waiting for approval can be ${action === 'approve' ? 'approved' : 'declined'}. This one is already ${before}.`)
    }
    const title = this.known.get(id!) ?? null
    // Audited first: if the log cannot be written, nothing is sent to Seerr.
    await this.d.audit(`arr.requests.${action}`, { by, request: id, title, ...(reason ? { reason: reason.slice(0, 200) } : {}) })
    const body: Record<string, unknown> = action === 'decline' && reason ? { reason } : {}
    await c.post!(`/api/v1/request/${id}/${action}`, body, 30_000)
    this.memo = null
    const after = classify(await c.get(`/api/v1/request/${id}`, 10_000)).group
    if (action === 'approve') {
      if (after === 'pending') return { action, done: false, summary: 'Seerr did not approve it. Nothing changed.', notes: [] }
      if (after === 'failed') return { action, done: false, summary: 'Approved, but Seerr could not send it to Radarr or Sonarr.', notes: ['Check Seerr\'s settings below, then try again.'] }
      return { action, done: true, summary: 'Approved. Seerr is sending it to be downloaded.', notes: [] }
    }
    if (action === 'decline') {
      return after === 'declined' ? { action, done: true, summary: 'Declined.', notes: [] } : { action, done: false, summary: 'Seerr did not decline it. Nothing changed.', notes: [] }
    }
    if (after === 'failed') return { action, done: false, summary: 'Seerr tried again, and it still failed.', notes: ['Radarr or Sonarr refused it again. Check Seerr\'s settings below.'] }
    return { action, done: true, summary: 'Sent to Radarr or Sonarr again.', notes: [] }
  }

  private async fixSettings(c: CoreEndpointClient, by: string): Promise<ActResult> {
    const stale = await this.stale(c)
    const fixable = stale.filter(s => (s.profileStale ? s.wantProfileId !== null : true) && (s.folderStale ? !!s.wantFolder : true))
    if (!stale.length) throw new RequestsRefusal(409, 'nothing_stale', 'Seerr\'s settings already match Radarr and Sonarr. Nothing to fix.')
    if (!fixable.length) throw new RequestsRefusal(409, 'nothing_to_point_at', 'Radarr or Sonarr has no quality profile or library folder for Seerr to use. Add one there first.')
    const notes: string[] = []
    let done = 0
    for (const s of fixable) {
      const servers = await this.serversOf(c, s.app)
      const entry = servers.find(x => Number(x?.id) === s.serverId)
      if (!entry) { notes.push(`${s.name} is no longer in Seerr.`); continue }
      await this.d.audit('arr.requests.fix-settings', { by, app: s.app, server: s.serverId, profile: s.wantProfile, folder: s.wantFolder })
      await c.put(`/api/v1/settings/${s.app}/${s.serverId}`, fixedServer(entry, s), 20_000)
      const back = (await this.serversOf(c, s.app)).find(x => Number(x?.id) === s.serverId)
      const left = staleServers(s.app, back ? [back] : [], (await this.factsOf(s.app)) ?? { profiles: [], roots: [] })
      if (left.length) notes.push(`Seerr's ${APP_NAME[s.app]} settings did not keep the change.`)
      else { done++; notes.push(`${s.name}: ${[s.profileStale && s.wantProfile ? `profile ${s.wantProfile}` : '', s.folderStale && s.wantFolder ? `folder ${s.wantFolder}` : ''].filter(Boolean).join(' and ')}.`) }
    }
    this.memo = null
    return { action: 'fix-settings', done: done === fixable.length, summary: done ? `Seerr's settings were pointed at what Radarr and Sonarr have now (${done} ${done === 1 ? 'server' : 'servers'}).` : 'Seerr\'s settings were not changed.', notes }
  }

  private async reconnect(c: CoreEndpointClient, target: Target, by: string): Promise<ActResult> {
    if (target === 'media') {
      const was = await this.mediaKind(c)
      const ms = await this.d.media(was ?? undefined).catch(() => null)
      if (!ms || (was && ms.kind !== was)) throw new RequestsRefusal(409, 'no_media_server', 'HyperProx does not know the media server\'s sign-in. Add it to the Plex or Jellyfin plug-in first.')
      const name = MEDIA_NAME[ms.kind]
      await this.d.audit('arr.requests.reconnect', { by, target: ms.kind })
      await c.post!(`/api/v1/settings/${ms.kind}`, mediaSettingsBody(ms), 30_000)
      try { await c.get(`/api/v1/settings/${ms.kind}/library?sync=true`, 20_000) } catch (e) {
        const why = whyFailed('media', e)
        return { action: 'reconnect', done: false, summary: `Seerr still cannot use ${name}.`, notes: [problemText('media', why, name)] }
      }
      return { action: 'reconnect', done: true, summary: `Seerr is connected to ${name} again.`, notes: [] }
    }
    const key = (await this.d.keys().catch(() => ({} as Record<string, string | undefined>)))[target]
    if (!key) throw new RequestsRefusal(409, 'no_key', `HyperProx has no ${APP_NAME[target]} key saved. Add it in the Arr Stack settings first.`)
    const servers = await this.serversOf(c, target)
    if (!servers.length) throw new RequestsRefusal(409, 'not_in_seerr', `${APP_NAME[target]} is not added to Seerr.`)
    const notes: string[] = []
    let fixed = 0
    for (const s of servers) {
      const serverId = Number(s?.id)
      if (!Number.isInteger(serverId)) continue
      await this.d.audit('arr.requests.reconnect', { by, target, server: serverId })
      await c.put(`/api/v1/settings/${target}/${serverId}`, { ...s, apiKey: key }, 20_000)
      try {
        await c.post!(`/api/v1/settings/${target}/test`, { hostname: s.hostname, port: s.port, apiKey: key, useSsl: s.useSsl === true, baseUrl: s.baseUrl ?? '' }, 15_000)
        fixed++
      } catch (e) { notes.push(problemText(target, whyFailed(target, e))) }
    }
    this.memo = null
    return { action: 'reconnect', done: fixed === servers.length, summary: fixed === servers.length ? `Seerr is connected to ${APP_NAME[target]} again.` : `Seerr still cannot use ${APP_NAME[target]}.`, notes }
  }
}

export { GROUPS }
