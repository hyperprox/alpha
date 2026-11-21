// =============================================================================
//  HyperProx — Arr Stack, Seerr requests: the service
//
//  Reads Seerr's requests (one shared reading, a few seconds old at most), says where each one is, and does the four
//  things an admin may do about them: approve, decline, retry a failed one (Seerr sends it
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
  APP_NAME, GROUPS, buildRows, classify, countsOf, describeFix, fixedServer, planFix, problemText, staleId, staleServers, titleOf, whyFailed,
  type ArrApp, type ArrFacts, type FixChoice, type Group, type HealthProblem, type Kind, type RequestRow, type SortedMove, type StaleServer, type TitleInfo,
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
  /** The addresses the Arr Stack plug-in holds for Radarr and Sonarr: the reconnect fix only touches Seerr entries that are that app. */
  urls?: () => Promise<{ radarr?: string; sonarr?: string }>
  /** The media server HyperProx knows (Plex or Jellyfin), for the reconnect fix. */
  media: (prefer?: MediaKind) => Promise<MediaServer | null>
  audit: (action: string, details: Record<string, unknown>) => Promise<void>
  now: () => number
  log?: (m: string) => void
}

const PAGE = 60
const TTL_MS = 4_000
const HEALTH_TTL_MS = 60_000
const TITLE_TTL_MS = 6 * 3600_000
const TITLE_BUDGET_MS = 8_000
const msg = (e: any) => String(e?.message ?? e).slice(0, 160)

export type ActionName = 'approve' | 'decline' | 'retry' | 'fix-settings' | 'reconnect'
export type { FixChoice }
export const ACTIONS: ActionName[] = ['approve', 'decline', 'retry', 'fix-settings', 'reconnect']
export type Target = 'radarr' | 'sonarr' | 'media'

export interface Listing { configured: boolean; rows: RequestRow[]; counts: Record<Group, number>; readAt: string; capped: boolean }
export interface HealthReading { configured: boolean; problems: HealthProblem[]; stale: StaleServer[]; staleId: string; readAt: string }
export interface ActResult { action: ActionName; done: boolean; summary: string; notes: string[] }

export class RequestsService {
  private titles = new Map<string, { at: number; info: TitleInfo }>()
  private memo: { at: number; raw: any[]; capped: boolean } | null = null
  private healthMemo: { at: number; h: HealthReading } | null = null
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

  /** The last stale set read (for a confirmation's words), from the shared health reading. */
  async staleNow(): Promise<StaleServer[]> { return (await this.health()).stale }

  /** The exact sentence for a "Fix Seerr's settings" with these choices, from the same plan the action makes. */
  describeFix(choices: FixChoice[]): string | null {
    const p = planFix(this.healthMemo?.h.stale ?? [], choices)
    return p.items.length && !p.unresolved.length && !p.invalid.length ? describeFix(p.items) : null
  }

  /** One shared reading for a minute: it asks Radarr, Sonarr and the media server, so open pages must not each cause one. */
  async health(): Promise<HealthReading> {
    const now = this.d.now()
    if (this.healthMemo && now - this.healthMemo.at < HEALTH_TTL_MS) return this.healthMemo.h
    const h = await this.readHealth()
    this.healthMemo = { at: now, h }
    return h
  }

  private async readHealth(): Promise<HealthReading> {
    const c = await this.seerr()
    const readAt = new Date(this.d.now()).toISOString()
    if (!c) return { configured: false, problems: [], stale: [], staleId: staleId([]), readAt }
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
      try { await this.touchMedia(c, kind) } catch (e) {
        const why = whyFailed('media', e)
        problems.push({ kind: 'media', why, text: problemText('media', why, MEDIA_NAME[kind]) })
      }
    }
    const stale = await this.stale(c)
    return { configured: true, problems, stale, staleId: staleId(stale), readAt }
  }

  /** A read that really makes Seerr ask the media server (never a library sync): Jellyfin's user list, Plex's server list. */
  private async touchMedia(c: CoreEndpointClient, kind: 'plex' | 'jellyfin'): Promise<void> {
    await c.get(kind === 'jellyfin' ? '/api/v1/settings/jellyfin/users' : '/api/v1/settings/plex/devices/servers', 20_000)
  }

  /** Which media server Seerr is set up for, from its main settings; null when it is not set up for one. */
  private async mediaKind(c: CoreEndpointClient): Promise<'plex' | 'jellyfin' | null> {
    try {
      const t = Number((await c.get('/api/v1/settings/main', 10_000))?.mediaServerType)
      return t === 1 ? 'plex' : t === 2 ? 'jellyfin' : null
    } catch { return null }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async act(a: { action: ActionName; id?: number; target?: Target; baseId?: string; choices?: FixChoice[] }, by: string): Promise<ActResult> {
    const c = await this.seerr()
    if (!c || !c.post) throw new RequestsRefusal(409, 'seerr_not_set', 'Seerr is not set up here yet. Save its address and API key in the Arr Stack settings first.')
    if (a.action === 'fix-settings') return this.fixSettings(c, by, a.baseId, a.choices ?? [])
    if (a.action === 'reconnect') return this.reconnect(c, a.target ?? 'media', by)
    return this.requestAction(c, a.action, a.id, by)
  }

  private async requestAction(c: CoreEndpointClient, action: 'approve' | 'decline' | 'retry', id: number | undefined, by: string): Promise<ActResult> {
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
    await this.d.audit(`arr.requests.${action}`, { by, request: id, title })
    await c.post!(`/api/v1/request/${id}/${action}`, {}, 30_000)
    this.memo = null
    const after = classify(await c.get(`/api/v1/request/${id}`, 10_000)).group
    // Approving and retrying are asynchronous in Seerr: it answers at once and hands the request to Radarr or Sonarr after.
    const SENT = 'Sent to Seerr. It will show as downloading once Radarr or Sonarr accept it.'
    if (action === 'approve') {
      if (after === 'pending') return { action, done: false, summary: 'Seerr did not approve it. Nothing changed.', notes: [] }
      return { action, done: true, summary: SENT, notes: after === 'failed' ? ['Seerr could not hand it on yet. If it stays failed, check Seerr\'s settings above.'] : [] }
    }
    if (action === 'decline') {
      return after === 'declined' ? { action, done: true, summary: 'Declined.', notes: [] } : { action, done: false, summary: 'Seerr did not decline it. Nothing changed.', notes: [] }
    }
    return { action, done: true, summary: SENT, notes: after === 'failed' ? ['It is still marked failed for now. If it stays failed, check Seerr\'s settings above.'] : [] }
  }

  private async fixSettings(c: CoreEndpointClient, by: string, baseId: string | undefined, choices: FixChoice[]): Promise<ActResult> {
    // Read fresh, never the shared reading: what is changed must be what is on Seerr and the arrs right now.
    const stale = await this.stale(c)
    if (!stale.length) throw new RequestsRefusal(409, 'nothing_stale', 'Seerr\'s settings already match Radarr and Sonarr. Nothing to fix.')
    if (baseId !== staleId(stale)) throw new RequestsRefusal(409, 'changed', 'What needs fixing changed since you looked. Nothing was changed; look at it again.')
    const plan = planFix(stale, choices)
    if (plan.invalid.length) throw new RequestsRefusal(400, 'bad_choice', 'One of the choices is not something Radarr or Sonarr has.')
    if (plan.unresolved.length) throw new RequestsRefusal(409, 'needs_choice', `Pick what Seerr should use for ${plan.unresolved.map(u => `${u.name}'s ${u.field.replace(/([A-Z])/g, ' $1').toLowerCase()}`).join(', ')}: nothing in ${[...new Set(plan.unresolved.map(u => APP_NAME[u.app]))].join(' or ')} has the same name.`)
    const notes: string[] = []
    let done = 0
    for (const item of plan.items) {
      const entry = (await this.serversOf(c, item.app)).find(x => Number(x?.id) === item.serverId)
      if (!entry) { notes.push(`${item.name} is no longer in Seerr.`); continue }
      await this.d.audit('arr.requests.fix-settings', { by, app: item.app, server: item.serverId, changes: item.lines.map(l => ({ field: l.field, from: l.from, to: l.to })) })
      await c.put(`/api/v1/settings/${item.app}/${item.serverId}`, fixedServer(entry, item), 20_000)
      const back = (await this.serversOf(c, item.app)).find(x => Number(x?.id) === item.serverId)
      const facts = (await this.factsOf(item.app)) ?? { profiles: [], roots: [] }
      if (!back || staleServers(item.app, [back], facts).length) notes.push(`Seerr's ${APP_NAME[item.app]} settings did not keep the change.`)
      else { done++; notes.push(`${item.name}: ${item.lines.map(l => `${l.to}`).join(', ')}.`) }
    }
    this.memo = null; this.healthMemo = null
    return { action: 'fix-settings', done: done === plan.items.length, summary: done ? `Seerr's settings were pointed at what Radarr and Sonarr have now (${done} ${done === 1 ? 'server' : 'servers'}).` : 'Seerr\'s settings were not changed.', notes }
  }

  private async reconnect(c: CoreEndpointClient, target: Target, by: string): Promise<ActResult> {
    if (target === 'media') {
      const was = await this.mediaKind(c)
      const ms = await this.d.media(was ?? undefined).catch(() => null)
      if (!ms || (was && ms.kind !== was)) throw new RequestsRefusal(409, 'no_media_server', 'HyperProx does not know the media server\'s sign-in. Add it to the Plex or Jellyfin plug-in first.')
      const name = MEDIA_NAME[ms.kind]
      await this.d.audit('arr.requests.reconnect', { by, target: ms.kind })
      await c.post!(`/api/v1/settings/${ms.kind}`, mediaSettingsBody(ms), 30_000)
      try { await this.touchMedia(c, ms.kind) } catch (e) {
        const why = whyFailed('media', e)
        return { action: 'reconnect', done: false, summary: `Seerr still cannot use ${name}.`, notes: [problemText('media', why, name)] }
      }
      return { action: 'reconnect', done: true, summary: `Seerr is connected to ${name} again.`, notes: [] }
    }
    const key = (await this.d.keys().catch(() => ({} as Record<string, string | undefined>)))[target]
    if (!key) throw new RequestsRefusal(409, 'no_key', `HyperProx has no ${APP_NAME[target]} key saved. Add it in the Arr Stack settings first.`)
    const url = (await (this.d.urls?.() ?? Promise.resolve({} as Record<string, string | undefined>)).catch(() => ({} as Record<string, string | undefined>)))[target]
    const servers = (await this.serversOf(c, target)).filter(s => isThatApp(s, target, url))
    if (!servers.length) throw new RequestsRefusal(409, 'not_in_seerr', `${APP_NAME[target]} is not added to Seerr, or Seerr's entry is not the one HyperProx has the key for.`)
    const notes: string[] = []
    let fixed = 0
    for (const s of servers) {
      const serverId = Number(s?.id)
      if (!Number.isInteger(serverId)) continue
      // The stored key is tested first, with the entry's own host and port; Seerr's entry is only written when it passes.
      try {
        await c.post!(`/api/v1/settings/${target}/test`, { hostname: s.hostname, port: s.port, apiKey: key, useSsl: s.useSsl === true, baseUrl: s.baseUrl ?? '' }, 15_000)
      } catch (e) { notes.push(problemText(target, whyFailed(target, e)) + ' The saved key did not work either, so nothing was changed.'); continue }
      await this.d.audit('arr.requests.reconnect', { by, target, server: serverId })
      await c.put(`/api/v1/settings/${target}/${serverId}`, { ...s, apiKey: key }, 20_000)
      fixed++
    }
    this.healthMemo = null
    this.memo = null
    return { action: 'reconnect', done: fixed === servers.length, summary: fixed === servers.length ? `Seerr is connected to ${APP_NAME[target]} again.` : `Seerr still cannot use ${APP_NAME[target]}.`, notes }
  }
}

/** True when a Seerr server entry is the app HyperProx holds the key for: same port, and either the address the plug-in uses or the app's own name on the container network. */
export function isThatApp(entry: any, app: ArrApp, url?: string): boolean {
  let host = '', port = ''
  try { const u = new URL(url ?? ''); host = u.hostname.toLowerCase(); port = u.port || (u.protocol === 'https:' ? '443' : '80') } catch { /* no address saved */ }
  const eh = String(entry?.hostname ?? '').toLowerCase()
  if (!url) return eh === app
  return String(entry?.port) === port && (eh === host || eh === app)
}

export { GROUPS }
