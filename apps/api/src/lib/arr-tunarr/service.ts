// =============================================================================
//  HyperProx — Arr Stack, Live TV (Tunarr): reading it and its two fixes
//
//   read      the tab's numbers (lib/arr-tunarr/logic.ts), shared for 20 s so several open pages cost one look.
//             Every call is a GET; a part Tunarr does not answer (an older release, a slow media source) is left out
//             of the reading rather than failing it.
//   icon      one channel's icon through HyperProx: the path comes from Tunarr's own answer, never from the request.
//   act       refresh-guide  runs Tunarr's own "UpdateXmlTvTask" (POST /api/tasks/UpdateXmlTvTask/run), the job that
//                            rebuilds the guide and the XMLTV file. It runs in the background, so the answer says what
//                            Tunarr accepted and what the guide holds now, not that it has finished.
//             stop-session   DELETE /api/channels/:id/sessions, which ends that channel's stream sessions (ffmpeg stops;
//                            players reconnect on their own). Only for a channel that has a session right now.
//           Each is audited BEFORE it runs: if the entry cannot be written, nothing is sent to Tunarr.
//
//  Tunarr has no key. Its optional basic-auth login (environment variables on its side) is not supported here: the
//  plug-in's host sends one kind of credential per address, and a Tunarr behind a login is reported as "not answering".
//  Nothing Tunarr says about its own address or login is ever put in an answer.
// =============================================================================

import type { CoreEndpointClient } from '../plugin-host'
import { buildLiveTv, forViewer, sessionsOf, type LiveTv, type RawReading } from './logic'

export class TunarrRefusal extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); this.name = 'TunarrRefusal' }
}

export const ACTIONS = ['refresh-guide', 'stop-session'] as const
export type ActionName = typeof ACTIONS[number]
export interface ActResult { action: ActionName; done: boolean; summary: string; notes: string[] }

export interface TunarrDeps {
  /** Tunarr's connection from the plug-in settings; null when no address is saved. */
  client(): Promise<CoreEndpointClient | null>
  /** The newest stable release (the GitHub tag, with or without a leading v), or null when it cannot be read. */
  latest(): Promise<string | null>
  /** Throws when the entry cannot be written: the action then does not run. */
  audit(action: string, details: Record<string, unknown>): Promise<void>
  now(): number
}

const CACHE_MS = 20_000
const msg = (e: any) => String(e?.message ?? e).slice(0, 200)
const TASK = 'UpdateXmlTvTask'
const GUIDE_WINDOW_MS = 6 * 3_600_000

export class TunarrService {
  private memo: { at: number; v: LiveTv } | null = null
  private icons = new Map<string, string>()
  constructor(private d: TunarrDeps) {}

  async read(admin: boolean): Promise<LiveTv> {
    const now = this.d.now()
    if (!this.memo || now - this.memo.at >= CACHE_MS) this.memo = { at: now, v: await this.reading() }
    return admin ? this.memo.v : forViewer(this.memo.v)
  }

  /** A person has just acted: the next read must look again. */
  private forget() { this.memo = null }

  private async reading(): Promise<LiveTv> {
    const c = await this.d.client()
    const now = this.d.now()
    if (!c) {
      return { ...buildLiveTv({ now }, false), configured: false, warnings: [] }
    }
    const soft = async <T>(p: Promise<T>): Promise<T | null> => { try { return await p } catch { return null } }
    const iso = (t: number) => new Date(t).toISOString()
    // The channel list is the one answer the tab cannot do without: a failure here is the tab's error.
    const channels = await c.get('/api/channels', 15_000)
    const [version, guideStatus, guide, sessions, health, sources, tasks, latest] = await Promise.all([
      soft(c.get('/api/version', 10_000)),
      soft(c.get('/api/guide/status', 20_000)),
      soft(c.get(`/api/guide/channels?dateFrom=${encodeURIComponent(iso(now))}&dateTo=${encodeURIComponent(iso(now + GUIDE_WINDOW_MS))}`, 20_000)),
      soft(c.get('/api/sessions', 10_000)),
      soft(c.get('/api/system/health', 15_000)),
      soft(this.sourceStates(c)),
      soft(c.get('/api/tasks', 10_000)),
      soft(this.d.latest()),
    ])
    const tv = buildLiveTv({ version, channels, guideStatus, guide, sessions, health, sources, tasks, latest, now }, true)
    this.icons = new Map((Array.isArray(channels) ? channels : []).filter((x: any) => typeof x?.icon?.path === 'string' && x.icon.path.startsWith('/') && !x.icon.path.startsWith('//')).map((x: any) => [String(x.id), String(x.icon.path)]))
    return tv
  }

  private async sourceStates(c: CoreEndpointClient): Promise<Array<{ source: any; status: any }>> {
    const list = await c.get('/api/media-sources', 10_000)
    const out: Array<{ source: any; status: any }> = []
    for (const s of (Array.isArray(list) ? list : []).slice(0, 12)) {
      const id = String(s?.id ?? '')
      if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) continue
      let status: any = null
      try { status = await c.get(`/api/media-sources/${id}/status`, 12_000) } catch { /* unknown */ }
      out.push({ source: s, status })
    }
    return out
  }

  /** One channel's icon, or null. The path is the one Tunarr gave for that channel in the last reading. */
  async icon(id: string): Promise<{ contentType: string; body: Buffer } | null> {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return null
    const c = await this.d.client()
    if (!c?.image) return null
    if (!this.icons.has(id)) await this.read(true).catch(() => null)
    const p = this.icons.get(id)
    if (!p) return null
    try { return await c.image(p, 10_000) } catch { return null }
  }

  /** The channel's number and name from the last reading, for a confirmation. */
  channelName(id: unknown): string | null {
    const ch = this.memo?.v.channels.find(x => x.id === id)
    return ch ? `${ch.number} ${ch.name}` : null
  }

  async act(a: { action: ActionName; channelId?: string }, by: string): Promise<ActResult> {
    const c = await this.d.client()
    if (!c || !c.post || !c.delete) throw new TunarrRefusal(409, 'tunarr_not_set', 'Tunarr is not set up here yet. Save its address in the Arr Stack settings first.')
    return a.action === 'refresh-guide' ? this.refreshGuide(c, by) : this.stopSession(c, a.channelId, by)
  }

  private async refreshGuide(c: CoreEndpointClient, by: string): Promise<ActResult> {
    let tasks: any[]
    try { const t = await c.get('/api/tasks', 10_000); tasks = Array.isArray(t) ? t : [] } catch (e) {
      throw new TunarrRefusal(502, 'tunarr_down', `Tunarr did not answer (${msg(e)}). Nothing was changed.`)
    }
    if (!tasks.some(t => t?.id === TASK)) throw new TunarrRefusal(409, 'no_task', 'This Tunarr has no guide task to run (it may be too old). Open its own Settings, Tasks page to rebuild the guide there.')
    await this.d.audit('arr.tunarr.refresh-guide', { by })
    await c.post!(`/api/tasks/${TASK}/run`, {}, 20_000)
    this.forget()
    // Tunarr runs it in the background. Say what the guide holds now, so the page never claims more than it saw.
    const notes: string[] = ['Tunarr runs this in the background. Look at the tab again in a minute for the new guide length.']
    try {
      const st = await c.get('/api/guide/status', 20_000)
      const ends = Object.values((st?.guideTimes ?? {}) as Record<string, any>).map(x => Date.parse(String(x?.end))).filter(Number.isFinite)
      if (ends.length) notes.push(`Right now the shortest guide holds ${Math.max(0, Math.round((Math.min(...ends) - this.d.now()) / 360_000) / 10)} hours.`)
    } catch { /* the note is a courtesy */ }
    return { action: 'refresh-guide', done: true, summary: 'Tunarr accepted the request and is rebuilding the guide.', notes }
  }

  private async stopSession(c: CoreEndpointClient, id: string | undefined, by: string): Promise<ActResult> {
    if (!id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new TunarrRefusal(400, 'bad_request', 'Name the channel.')
    let all: Record<string, unknown>
    try { all = (await c.get('/api/sessions', 10_000)) ?? {} } catch (e) {
      throw new TunarrRefusal(502, 'tunarr_down', `Tunarr did not answer (${msg(e)}). Nothing was changed.`)
    }
    const sessions = sessionsOf((all as any)[id])
    if (!sessions.length) throw new TunarrRefusal(409, 'no_session', 'That channel has no stream session right now. Nothing to stop.')
    const label = this.channelName(id)
    await this.d.audit('arr.tunarr.stop-session', { by, channel: id, name: label, sessions: sessions.length, viewers: sessions.reduce((t, s) => t + s.viewers, 0) })
    await c.delete!(`/api/channels/${id}/sessions`, 30_000)
    this.forget()
    let left = -1
    try { left = sessionsOf(((await c.get('/api/sessions', 10_000)) as any)?.[id]).length } catch { /* unknown */ }
    if (left === 0) return { action: 'stop-session', done: true, summary: `The stream on ${label ?? 'that channel'} was stopped. Players start a new one when they reconnect.`, notes: [] }
    if (left < 0) return { action: 'stop-session', done: false, summary: 'Tunarr accepted the request, but it did not answer when asked to confirm.', notes: ['Look at the tab again to see whether the stream is gone.'] }
    return { action: 'stop-session', done: false, summary: 'Tunarr accepted the request, but the session is still listed.', notes: ['Tunarr can take up to half a minute to stop ffmpeg. Look at the tab again.'] }
  }
}
