// =============================================================================
//  HyperProx — "Tell me when something new is added" (Plex)
//
//  Off by default (the Plex plug-in's notify_new setting). When on, Plex's
//  /library/recentlyAdded is read every few minutes and anything not seen
//  before goes out as ONE message per batch to the notification channels that
//  take the "media" family. De-duplicated two ways: a watermark (the newest
//  addedAt already announced) and the last 500 item keys, so a rescan that
//  re-dates an item, or a restart, never sends it twice. The very first read
//  only sets the watermark: switching it on never floods a channel with the
//  whole library.
//
//  Posters are not attached: the only way to show HyperProx's own cover images
//  to Discord would be a public, unauthenticated image address, and the image
//  route deliberately needs a sign-in. The message links to the Plex page.
// =============================================================================

import fs from 'node:fs'
import path from 'node:path'
import type { NotifyEventInput } from './notify/types'

export interface NewState { watermark: number | null; seen: string[] }
export const emptyNewState = (): NewState => ({ watermark: null, seen: [] })

export interface NewItem { key: string; line: string; addedAt: number }

const n0 = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const clean = (v: unknown, max = 120) => (typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max) : '')

/** recentlyAdded rows as one line each: a film with its year, a season or episodes under their show. */
export function recentItems(body: any): NewItem[] {
  const rows: any[] = Array.isArray(body?.MediaContainer?.Metadata) ? body.MediaContainer.Metadata : []
  const out: NewItem[] = []
  for (const m of rows) {
    const key = clean(String(m?.ratingKey ?? ''), 20)
    if (!/^\d+$/.test(key)) continue
    const addedAt = n0(m?.addedAt)
    if (m?.type === 'movie') {
      const t = clean(m.title); if (!t) continue
      out.push({ key: `movie:${key}`, addedAt, line: `${t}${n0(m.year) ? ` (${n0(m.year)})` : ''}` })
    } else if (m?.type === 'season') {
      const show = clean(m.parentTitle) || 'A show'
      const eps = n0(m.leafCount)
      out.push({ key: `season:${key}`, addedAt, line: `${show}: ${clean(m.title) || 'a season'}${eps ? ` (${eps} episode${eps === 1 ? '' : 's'})` : ''}` })
    } else if (m?.type === 'episode') {
      const show = clean(m.grandparentTitle) || 'A show'
      out.push({ key: `episode:${key}`, addedAt, line: `${show}: ${clean(m.title) || 'a new episode'}` })
    } else if (m?.type === 'show') {
      const t = clean(m.title); if (!t) continue
      out.push({ key: `show:${key}`, addedAt, line: `${t}${n0(m.year) ? ` (${n0(m.year)})` : ''}` })
    }
  }
  return out
}

/**
 * What is new since the state, and the state after sending it. Pure. The first call (no watermark) only records
 * where things stand and returns nothing to send.
 */
export function pickNew(items: NewItem[], state: NewState): { batch: NewItem[]; next: NewState } {
  const newest = items.reduce((a, i) => Math.max(a, i.addedAt), 0)
  if (state.watermark === null) return { batch: [], next: { watermark: newest || Math.floor(Date.now() / 1000), seen: items.map(i => i.key).slice(0, 500) } }
  const seen = new Set(state.seen)
  const batch = items.filter(i => !seen.has(i.key) && i.addedAt > state.watermark! - 3600)
    .sort((a, b) => a.addedAt - b.addedAt)
  const keys = [...batch.map(i => i.key), ...state.seen].slice(0, 500)
  return { batch, next: { watermark: Math.max(state.watermark, newest), seen: keys } }
}

/** One message for one batch. */
export function newMessage(batch: NewItem[]): NotifyEventInput | null {
  if (!batch.length) return null
  const shown = batch.slice(0, 15)
  return {
    type: 'plex.added', severity: 'info',
    title: batch.length === 1 ? `New in Plex: ${shown[0].line}` : `New in Plex: ${batch.length} items`,
    lines: [...shown.map(i => i.line), ...(batch.length > shown.length ? [`and ${batch.length - shown.length} more`] : [])],
    // Titles came from Plex, not from HyperProx: shown as plain text where the channel renders markdown.
    plain: shown.map(i => i.line),
    link: '/plugins/plex', linkLabel: 'Open Plex in HyperProx', where: 'Plex page',
    fingerprint: `plex.added:${batch.map(i => i.key).join(',')}`.slice(0, 200),
  }
}

export interface NewStore { load(): NewState; save(s: NewState): void }

export class FileNewStore implements NewStore {
  constructor(private file = process.env.PLEX_NEW_STATE_PATH || '/opt/hyperprox/data/plex-new.json') {}
  load(): NewState {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return { watermark: typeof j?.watermark === 'number' ? j.watermark : null, seen: Array.isArray(j?.seen) ? j.seen.filter((x: unknown) => typeof x === 'string').slice(0, 500) : [] }
    } catch { return emptyNewState() }
  }
  save(s: NewState): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(s) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
}

export interface NewWatcherDeps {
  /** 'on': the setting is on and Plex can be read. 'off': the setting is off. 'wait': locked, or Plex not set yet. */
  enabled(): Promise<'on' | 'off' | 'wait'>
  recentlyAdded(): Promise<any>
  publish(e: NotifyEventInput): Promise<void>
  store: NewStore
  log?(m: string): void
}

/** One pass: read, pick, send one message, save. When off, forget the watermark so turning it on is quiet. */
export async function newPass(d: NewWatcherDeps): Promise<number> {
  const state = await d.enabled()
  if (state === 'wait') return 0
  if (state === 'off') {
    const s = d.store.load()
    if (s.watermark !== null) d.store.save(emptyNewState())
    return 0
  }
  const { batch, next } = pickNew(recentItems(await d.recentlyAdded()), d.store.load())
  const msg = newMessage(batch)
  if (msg) await d.publish(msg)
  d.store.save(next)
  return batch.length
}

let timer: ReturnType<typeof setInterval> | null = null
export function startNewWatcher(d: NewWatcherDeps, everyMs = 5 * 60_000): () => void {
  if (timer) return () => {}
  let busy = false
  timer = setInterval(() => {
    if (busy) return
    busy = true
    newPass(d).catch(e => d.log?.(`[plex] new-items check failed: ${e?.message ?? e}`)).finally(() => { busy = false })
  }, everyMs)
  timer.unref?.()
  return () => { if (timer) clearInterval(timer); timer = null }
}
