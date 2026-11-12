// =============================================================================
//  HyperProx — Arr Stack, Queue: what the Problems filter shows and which badge a group wears (pure)
//
//  Kept apart from the page so it can be tested. No React, no imports.
//
//  Problems filter: a show appears only if it really has a problem, and only its problem seasons and problem downloads
//  are listed under it. A finished ("done") download is not a problem, so it is hidden here. The show's own totals still
//  count everything in it; `scope` tells the page how much of the show it is looking at so it can say so.
//
//  Badge: a failed, blocked, stalled or warning download colours its season and show. A done one never does: it only
//  adds a calm "ready to clear" note, and a group made of nothing but done downloads reads "Done".
// =============================================================================

type Problem = 'failed' | 'blocked' | 'incomplete' | 'sample' | 'stalled' | 'warning'
const SEVERITY: Record<Problem, number> = { failed: 0, blocked: 1, incomplete: 1, sample: 1, stalled: 2, warning: 3 }

interface Dl { problem: Problem | null; done?: boolean }
interface Season<D extends Dl> { problem: Problem | null; done?: boolean; downloads: D[] }
interface Show<S extends Season<Dl>> { problem: Problem | null; done?: boolean; seasons: S[] }

export type Scoped<T> = T & { scope?: { seasons: number; totalSeasons: number; downloads: number; totalDownloads: number } }

const worse = (a: Problem | null, b: Problem | null): Problem | null =>
  a === null ? b : b === null ? a : SEVERITY[a] <= SEVERITY[b] ? a : b

/** The shows that have a real problem, cut down to just those seasons and downloads. Everything else is left out. */
export function problemsOnly<D extends Dl, S extends Season<D>, H extends Show<S>>(shows: H[]): Array<Scoped<H>> {
  const out: Array<Scoped<H>> = []
  for (const sh of shows) {
    const seasons: S[] = []
    for (const se of sh.seasons) {
      const downloads = se.downloads.filter(d => d.problem !== null)
      if (downloads.length) seasons.push({ ...se, downloads })
    }
    if (!seasons.length) continue
    out.push({
      ...sh, seasons,
      problem: seasons.reduce<Problem | null>((p, x) => worse(p, x.problem), null),
      scope: {
        seasons: seasons.length, totalSeasons: sh.seasons.length,
        downloads: seasons.reduce((t, x) => t + x.downloads.length, 0), totalDownloads: sh.seasons.reduce((t, x) => t + x.downloads.length, 0),
      },
    })
  }
  return out
}

interface Album<D extends Dl> { problem: Problem | null; done?: boolean; downloads: D[] }
interface Artist<A extends Album<Dl>> { problem: Problem | null; done?: boolean; albums: A[] }
export type ScopedArtist<T> = T & { scope?: { albums: number; totalAlbums: number; downloads: number; totalDownloads: number } }

/** The same cut for music (Artist → Album → download): only artists, albums and downloads that really have a problem. */
export function problemsOnlyMusic<D extends Dl, A extends Album<D>, H extends Artist<A>>(artists: H[]): Array<ScopedArtist<H>> {
  const out: Array<ScopedArtist<H>> = []
  for (const ar of artists) {
    const albums: A[] = []
    for (const al of ar.albums) {
      const downloads = al.downloads.filter(d => d.problem !== null)
      if (downloads.length) albums.push({ ...al, downloads })
    }
    if (!albums.length) continue
    out.push({
      ...ar, albums,
      problem: albums.reduce<Problem | null>((p, x) => worse(p, x.problem), null),
      scope: {
        albums: albums.length, totalAlbums: ar.albums.length,
        downloads: albums.reduce((t, x) => t + x.downloads.length, 0), totalDownloads: ar.albums.reduce((t, x) => t + x.downloads.length, 0),
      },
    })
  }
  return out
}

export type Badge =
  | { kind: 'problem'; problem: Problem; ready: number }
  | { kind: 'done'; ready: number }
  | { kind: 'ready'; ready: number }
  | null

/** What a season or show wears. `problem` comes only from real problems; done downloads are counted, never coloured. */
export function badgeOf(problem: Problem | null, downloads: Dl[]): Badge {
  const ready = downloads.filter(d => d.done && d.problem === null).length
  if (problem) return { kind: 'problem', problem, ready }
  if (ready && ready === downloads.length) return { kind: 'done', ready }
  if (ready) return { kind: 'ready', ready }
  return null
}
