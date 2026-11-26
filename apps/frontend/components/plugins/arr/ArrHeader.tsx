'use client'

// =============================================================================
//  HyperProx — Arr Stack, the compact sticky header
//
//  One block that stays at the top while the page scrolls: the one-sentence summary (the same words the
//  dashboard tile shows, taken from the queue reading), whether the readings are stale, Pause and Refresh (the page name and live dot are the top bar's), and the six tabs.
//  Kept to a few lines on a phone so it leaves room for the page under it.
// =============================================================================

import c from './arrux.module.css'

export type ArrTab = 'needs' | 'downloading' | 'requests' | 'comingup' | 'livetv' | 'advanced'
export const ARR_TABS: Array<[ArrTab, string]> = [
  ['needs', 'Needs you'], ['downloading', 'Downloading'], ['requests', 'Requests'], ['comingup', 'Coming up'], ['livetv', 'Live TV'], ['advanced', 'Advanced'],
]

/** A tab remembered by an older version of this page, read as the one that replaced it. Anything unknown is null. */
export function readTab(raw: string | null): ArrTab | null {
  switch (raw) {
    case 'needs': case 'downloading': case 'requests': case 'comingup': case 'livetv': case 'advanced': return raw
    case 'queue': return 'downloading'
    case 'upcoming': return 'comingup'
    case 'overview': case 'sorting': return 'advanced'
    default: return null
  }
}

export function ArrHeader({ summary, live, fresh, lastWord, onLive, onRefresh, loading, tab, onTab, needs }: {
  summary: string; live: boolean; fresh: boolean; lastWord: string | null; onLive?: () => void; onRefresh: () => void; loading: boolean
  tab: ArrTab; onTab: (t: ArrTab) => void; needs: number
}) {
  return (
    <header className={c.head} aria-label="Arr Stack">
      <div className={c.headTop}>
        <p className={c.summary} aria-live="polite">{summary}</p>
        {/* The top bar already names the page and shows the live dot, so this marker appears only when the readings are stale. */}
        {live && !fresh && <span className={c.live} role="status" data-fresh={fresh}><i aria-hidden />{lastWord ? `updated ${lastWord}` : 'connecting…'}</span>}
        <span className={c.ctl}>
          {onLive && <button type="button" aria-pressed={live} onClick={onLive} title={live ? 'The queue updates every 4 s, the rest every 30 s. Tap to pause.' : 'Updates are paused. Tap to resume.'}>{live ? 'Pause' : 'Paused'}</button>}
          <button type="button" onClick={onRefresh} disabled={loading}>{loading ? '…' : 'Refresh'}</button>
        </span>
      </div>
      <div role="tablist" aria-label="Arr Stack views" className={c.tabs}>
        {ARR_TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => onTab(k)}>
            {label}{k === 'needs' && needs > 0 && <span className={c.badge} aria-label={`${needs} need you`}>{needs}</span>}
          </button>
        ))}
      </div>
    </header>
  )
}
