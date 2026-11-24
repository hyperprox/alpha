// =============================================================================
//  Live context for the operator: read-only, through the readings HyperProx already makes.
//
//  No new connection to anything. A question is matched to the one to three areas it is about (the same "sources" the
//  Ask box uses: the Arr Stack queue, Unmanic, Plex, the cluster and so on, each read with the signed-in person's role
//  and its own time budget) and their short summaries are attached to the prompt. The model never calls anything, so
//  it cannot be talked into reading, or changing, something else. Locked or unreadable areas are said, never guessed.
// =============================================================================

import { loadWithin, selectSources, LOCKED_NOTE, type AskSource, type SourceSummary } from '../ask'
import type { LiveTv } from '../../arr-tunarr/logic'

export interface LiveReading { id: string; title: string; lines: string[]; note?: string }

export const LIVE_LINES_PER_SOURCE = 16
export const LIVE_CHARS = 3500

/** Which areas the question is about, read within their budgets. Never throws: a failed area becomes a note. */
export async function readLive(question: string, sources: AskSource[], o: { cacheKey?: string; maxChars?: number; now?: () => number } = {}): Promise<LiveReading[]> {
  const chosen = selectSources(question, sources.filter(s => s.id !== 'operator'))
  const loaded = await Promise.all(chosen.map(s => loadWithin(s, { cacheKey: o.cacheKey, now: o.now })))
  const out: LiveReading[] = []
  let budget = o.maxChars ?? LIVE_CHARS
  for (const { s, sum, state } of loaded) {
    const r = describe(s, sum, state)
    const lines: string[] = []
    for (const l of r.lines) {
      if (budget - l.length < 0) break
      lines.push(l); budget -= l.length + 1
    }
    out.push({ ...r, lines })
  }
  return out
}

function describe(s: AskSource, sum: SourceSummary, state: string): LiveReading {
  if (sum.locked) return { id: s.id, title: s.title, lines: [], note: LOCKED_NOTE }
  const lines = [sum.headline, ...sum.lines].filter(Boolean).slice(0, LIVE_LINES_PER_SOURCE + 1)
  const notes: string[] = []
  if (sum.unread?.length) notes.push(`could not read: ${sum.unread.join('; ')}`)
  if (state === 'cached') notes.push('this is its last reading, not a fresh one')
  if (state === 'pending') notes.push('still being read')
  return { id: s.id, title: s.title, lines: state === 'pending' ? [] : lines, ...(notes.length ? { note: notes.join('. ') } : {}) }
}

/** The text block for a prompt. Empty when nothing was read. */
export function liveBlock(readings: LiveReading[]): string {
  const parts = readings.map(r => `[${r.title}]${r.note ? ` (${r.note})` : ''}\n${r.lines.map(l => `- ${l}`).join('\n')}`.trimEnd())
  return parts.join('\n')
}

// ── Live TV (Tunarr): the one reading the generic plug-in sources do not have ───────────────────────────────

export function tunarrLines(tv: LiveTv): string[] {
  if (!tv.configured) return ['Live TV is not set up.']
  const s = tv.summary
  const out = [`${s.channels} channels, ${s.viewers} watching, ${s.streaming} streaming now; ${s.guideShort} with a short guide, ${s.cannotStream} that cannot stream; ${s.unsynced} not synced.`]
  if (tv.version?.installed) out.push(`Tunarr ${tv.version.installed}${tv.version.behind ? ` (${tv.version.latest} is out)` : ''}.`)
  for (const w of tv.warnings.slice(0, 8)) out.push(`${w.level}: ${w.text}`)
  for (const c of tv.channels.filter(c => c.guideShort).slice(0, 6)) out.push(`Channel ${c.number} ${c.name}: guide only ${c.guideHours ?? '?'} h.`)
  return out
}

export function tunarrSource(d: { unlocked: () => boolean; read: () => Promise<LiveTv> }): AskSource {
  return {
    id: 'live-tv', title: 'Live TV', blurb: 'Tunarr channels, guide and streams',
    aliases: /\b(tunarr|live\s*tv|channels?|guide|epg|iptv|buffer\w*|pip\s*tv)\b/i,
    overview: false,
    load: async () => {
      if (!d.unlocked()) return { headline: 'Live TV: locked.', lines: [], locked: true }
      const tv = await d.read()
      const lines = tunarrLines(tv)
      return { headline: `Live TV: ${lines[0]}`, lines: lines.slice(1) }
    },
  }
}
