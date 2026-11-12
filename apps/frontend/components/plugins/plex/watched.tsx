'use client'

// =============================================================================
//  HyperProx — Plex: who has watched what, in words
//
//  Shared by Clear-out and the Library. The API counts an account as having
//  watched something when the play history has a play by it OR Plex has it as
//  watched (a viewCount, any watched episode, a lastViewedAt), so a title
//  marked watched by hand, or watched before the history starts, counts.
//  Names come only for operators and up; a viewer gets the counts.
// =============================================================================

export interface WatchInfo {
  plays: number
  watchers?: number
  marked?: number
  watchedBy?: Array<{ name: string; how: 'played' | 'marked' }>
}

export interface WatchState {
  accounts: number; shared: number; reading: boolean; done: number; total: number
  at: number | null; note: string | null; ownerOnly: boolean
}

export const MARKED_TIP = 'Plex has it as watched, but its play history has no play: marked as watched by hand, or watched before the history begins.'

/** "3 plays · watched by 2 people (alex; sam, marked)", or "0 plays · nobody has watched it". */
export function watchedText(w: WatchInfo): string {
  const n = w.watchers ?? 0
  const plays = `${w.plays} ${w.plays === 1 ? 'play' : 'plays'}`
  if (!n) return `${plays} · nobody has watched it`
  const people = `watched by ${n} ${n === 1 ? 'person' : 'people'}`
  const names = w.watchedBy?.length ? ` (${w.watchedBy.map(x => (x.how === 'marked' ? `${x.name}, marked` : x.name)).join('; ')})` : ''
  const marked = !w.watchedBy?.length && w.marked ? `, ${w.marked} by a watched mark` : ''
  return `${plays} · ${people}${names}${marked}`
}

/** Whose watched marks the page counts, and the background reading's progress. */
export function watchStateText(st: WatchState | undefined | null): string {
  if (!st) return ''
  if (st.reading) {
    return `Reading who has watched what${st.total ? `: ${st.done} of ${st.total} accounts so far` : ''}. The lists update when it is done${st.at ? '' : ', and nothing can be removed from Clear-out until then'}.`
  }
  if (st.ownerOnly) return 'Only the server owner’s watched marks are counted, as well as the play history.'
  const base = `Watched marks from ${st.accounts} ${st.accounts === 1 ? 'account' : 'accounts'} count as well as the play history, so something marked as watched is not “never watched”.`
  return st.note ? `${base} ${st.note}` : base
}
