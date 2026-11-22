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
import { GUIDE_WINDOW_HOURS, buildLiveTv, forViewer, sessionsOf, type LiveTv, type RawReading } from './logic'

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
  /** The whole reading's deadline in ms (default 20 s); tests shorten it. */
  deadlineMs?: number
}

const CACHE_MS = 20_000
const FAIL_CACHE_MS = 15_000
const READING_DEADLINE_MS = 20_000
const msg = (e: any) => String(e?.message ?? e).slice(0, 200)

/** Resolves with the value, or null once `ms` has passed (the timer is always cleared). */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>(resolve => {
    const t = setTimeout(() => resolve(null), Math.max(0, ms))
    p.then(v => { clearTimeout(t); resolve(v) }, () => { clearTimeout(t); resolve(null) })
  })
}

export class TunarrService {
  private memo: { at: number; v: LiveTv } | null = null
  /** A failed reading, kept 15 s so a page that polls a dead Tunarr does not hammer it. */
  private failed: { at: number; err: unknown } | null = null
  /** The reading in flight: concurrent callers wait for it instead of starting their own. */
  private inflight: Promise<LiveTv> | null = null
  private generation = 0
  private icons = new Map<string, string>()
  constructor(private d: TunarrDeps) {}

  async read(admin: boolean): Promise<LiveTv> {
    const v = await this.shared()
    return admin ? v : forViewer(v)
  }

  private shared(): Promise<LiveTv> {
    const now = this.d.now()
    if (this.memo && now - this.memo.at < CACHE_MS) return Promise.resolve(this.memo.v)
    if (this.failed && now - this.failed.at < FAIL_CACHE_MS) return Promise.reject(this.failed.err)
    if (this.inflight) return this.inflight
    const gen = this.generation
    const p = this.reading().then(v => {
      if (gen === this.generation) { this.memo = { at: this.d.now(), v }; this.failed = null }
      return v
    }, err => {
      if (gen === this.generation) this.failed = { at: this.d.now(), err }
      throw err
    }).finally(() => { if (this.inflight === p) this.inflight = null })
    this.inflight = p
    return p
  }

  /** A person has just acted: the next read must look again. */
  private forget() { this.memo = null; this.failed = null; this.generation++ }

  private async reading(): Promise<LiveTv> {
    const c = await this.d.client()
    const now = this.d.now()
    if (!c) {
      return { ...buildLiveTv({ now }, false), configured: false, warnings: [] }
    }
    // One deadline for the whole reading: whatever has not answered by then is "unknown", never a hung page.
    const total = this.d.deadlineMs ?? READING_DEADLINE_MS
    const t0 = Date.now()
    const left = () => total - (Date.now() - t0)
    const iso = (t: number) => new Date(t).toISOString()
    // The channel list is the one answer the tab cannot do without: no answer here is the tab's error.
    // A real error from Tunarr (HTTP 500, refused) is passed on as it is; only silence becomes "did not answer in time".
    const channels = await new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new TunarrRefusal(504, 'tunarr_slow', 'Tunarr did not answer in time. It may be down, or the saved address may be wrong.')), Math.max(0, Math.min(15_000, left())))
      c.get('/api/channels', 15_000).then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
    })
    const soft = <T>(p: Promise<T>): Promise<T | null> => within(p, left())
    const [version, guideStatus, guide, sessions, health, sources, tasks, latest] = await Promise.all([
      soft(c.get('/api/version', 10_000)),
      soft(c.get('/api/guide/status', 20_000)),
      soft(c.get(`/api/guide/channels?dateFrom=${encodeURIComponent(iso(now))}&dateTo=${encodeURIComponent(iso(now + GUIDE_WINDOW_HOURS * 3_600_000))}`, 20_000)),
      soft(c.get('/api/sessions', 10_000)),
      soft(c.get('/api/system/health', 15_000)),
      // Bounds itself (the list and every status stop at the deadline), so a slow status leaves "unknown", not no sources.
      this.sourceStates(c, left).catch(() => null),
      soft(this.guideTasks(c).then(t => t?.list ?? null)),
      soft(this.d.latest()),
    ])
    const tv = buildLiveTv({ version, channels, guideStatus, guide, sessions, health, sources, tasks, latest, now }, true)
    this.icons = new Map((Array.isArray(channels) ? channels : []).filter((x: any) => typeof x?.icon?.path === 'string' && x.icon.path.startsWith('/') && !x.icon.path.startsWith('//')).map((x: any) => [String(x.id), String(x.icon.path)]))
    this.iconsKnown = true
    return tv
  }

  private iconsKnown = false

  /**
   * Tunarr's task list and which spelling this release uses: 2026.11 answers /api/tasks (id UpdateXmlTvTask), the 0.12
   * line /api/jobs (id update-xmltv). Null when neither lists the guide task.
   */
  private async guideTasks(c: CoreEndpointClient): Promise<{ list: any[]; runPath: string } | null> {
    for (const [base, id] of [['/api/tasks', 'UpdateXmlTvTask'], ['/api/jobs', 'update-xmltv']] as const) {
      try {
        const t = await c.get(base, 10_000)
        const list = Array.isArray(t) ? t : []
        if (list.some(x => x?.id === id)) return { list, runPath: `${base}/${id}/run` }
      } catch { /* try the other spelling */ }
    }
    return null
  }

  /** Every media source's status in parallel, each cut off at the reading's deadline: an unfinished one is "unknown". */
  private async sourceStates(c: CoreEndpointClient, left: () => number): Promise<Array<{ source: any; status: any }>> {
    const list = await within(c.get('/api/media-sources', 10_000), left())
    const rows = (Array.isArray(list) ? list : []).slice(0, 12).filter(s => /^[A-Za-z0-9-]{1,64}$/.test(String(s?.id ?? '')))
    return Promise.all(rows.map(async source => ({ source, status: await within(c.get(`/api/media-sources/${String(source.id)}/status`, 12_000), left()) })))
  }

  /**
   * One channel's icon, or null. The path is the one Tunarr gave for that channel in the last reading. An id Tunarr
   * never listed answers null without a look at Tunarr; only when nothing has been read yet does it share a reading.
   */
  async icon(id: string): Promise<{ contentType: string; body: Buffer } | null> {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return null
    if (!this.iconsKnown) await this.shared().catch(() => null)
    const p = this.icons.get(id)
    if (!p) return null
    const c = await this.d.client()
    if (!c?.image) return null
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
    let task: { list: any[]; runPath: string } | null
    try { task = await this.guideTasks(c) } catch (e) {
      throw new TunarrRefusal(502, 'tunarr_down', `Tunarr did not answer (${msg(e)}). Nothing was changed.`)
    }
    if (!task) throw new TunarrRefusal(409, 'no_task', 'This Tunarr has no guide task to run (it may be too old). Open its own Settings, Tasks page to rebuild the guide there.')
    await this.d.audit('arr.tunarr.refresh-guide', { by })
    await c.post!(task.runPath, {}, 20_000)
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
