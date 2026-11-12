// =============================================================================
//  HyperProx — the assistant's read-only view of the Plex clear-out
//
//  What the Clear-out page shows, in plain sentences worked out by code: how far
//  back Plex's history goes, how much of each library nobody has played, what
//  the never-watched and idle lists add up to, the largest items on them, and
//  what the keep rules held back. It never removes anything and offers no way to.
// =============================================================================

import type { AskSource, SourceSummary } from './ask'
import type { ClearoutReport } from '../plex-clearout/logic'
import type { LibraryRow } from '../plex-clearout/service'

export interface ClearoutSourceDeps {
  unlocked(): boolean
  /** The newest reading, read (or re-read when stale) through the clear-out service. */
  report(): Promise<{ report: ClearoutReport; library?: LibraryRow[] }>
}

const gb = (b: number) => (b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : `${(b / 1e9).toFixed(1)} GB`)
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export function clearoutLines(r: ClearoutReport, library: LibraryRow[] = []): string[] {
  const out: string[] = []
  out.push(r.historySince
    ? `Plex play history goes back to ${day(r.historySince)} (${r.historyPlays} plays, every account); nothing older is known.`
    : 'Plex has no play history yet, so every item counts as never watched.')
  for (const [name, t, kind] of [['TV', r.totals.tv, 'show'], ['Movies', r.totals.movies, 'movie']] as const) {
    out.push(`${name}: ${t.items} in Plex, ${t.unwatched} (${t.unwatchedShare}%) never played. Clear-out lists ${t.never} never watched (in Plex over ${r.cutoffs.neverMinMonths} months) and ${t.idle} idle (not played for ${r.cutoffs.idleMonths} months), about ${gb(t.listBytes)} together.`)
    const big = r.rows.filter(x => x.kind === kind).slice(0, 5)
    if (big.length) out.push(`Largest on the ${name} list: ${big.map(x => `${x.title}${x.year ? ` (${x.year})` : ''} ${x.sizeBytes ? gb(x.sizeBytes) : 'size unknown'}, ${x.list === 'never' ? 'never watched' : `last played ${x.lastPlayed ? day(x.lastPlayed) : 'unknown'}`}`).join('; ')}.`)
  }
  if (r.kept.length) out.push(`Kept off the list: ${r.kept.map(k => `${k.label.toLowerCase()} ${k.tv + k.movies}`).join(', ')}.`)
  if (library.length) {
    const shows = library.filter(x => x.kind === 'show'), films = library.filter(x => x.kind === 'movie')
    const arr = library.filter(x => x.via !== 'plex').length
    out.push(`Library: ${shows.length} shows and ${films.length} films, ${gb(library.reduce((a, x) => a + (x.sizeBytes ?? 0), 0))} in all; ${arr} are managed by Sonarr or Radarr, the rest would be removed through Plex itself.`)
    const big = [...library].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0)).slice(0, 5)
    out.push(`Largest in the library: ${big.map(x => `${x.title}${x.year ? ` (${x.year})` : ''} ${x.sizeBytes ? gb(x.sizeBytes) : 'size unknown'}`).join('; ')}.`)
  }
  out.push('Removing is done on the Plex page (Clear-out or Library): through Sonarr or Radarr when they manage the item, otherwise through Plex itself, after a preview and the master password. I cannot remove anything.')
  return out
}

export function clearoutSource(d: ClearoutSourceDeps): AskSource {
  return {
    id: 'plex-clearout', title: 'Plex clear-out', blurb: 'what nobody watches in Plex, and how much space it takes',
    aliases: /\b(library|biggest (shows?|films?|movies?)|seasons?|episodes? (size|space)|unwatched|never watched|not watched|nobody watch\w*|idle|clear.?out|free (up )?space|space hogs?|delete what|largest (films?|movies?|shows?))\b/i,
    matchLines: true,
    load: async (): Promise<SourceSummary> => {
      if (!d.unlocked()) return { headline: 'Plex clear-out: locked.', lines: [], locked: true }
      const { report: r, library } = await d.report()
      const lines = clearoutLines(r, library ?? [])
      return { headline: `Plex clear-out: ${r.totals.tv.never + r.totals.tv.idle + r.totals.movies.never + r.totals.movies.idle} items listed`, lines }
    },
  }
}
