'use client'

// =============================================================================
//  HyperProx — Arr Stack, Advanced: the numbers behind the summary
//
//  The summary counts shows, films and artists. Everything counted another way lives here, each with its unit named:
//  queue rows (one per episode), downloads (a season pack is one), and the download client's torrents with its own
//  state words. The pipeline view, the VPN panel, folder sorting and the seven detail tables sit below this on the
//  same tab. These are read at their own moments (the queue every 4 s, the rest every 30 s), so they can differ from the
//  summary by a download or two; the summary is the one to go by.
// =============================================================================

import type { ArrVisual } from '@hyperprox/types'
import { Panel } from '@/components/visual/kit'
import c from './arrux.module.css'
import type { QueueData } from './Queue'

export function ArrBehindNumbers({ data, v }: { data: QueueData | null; v?: ArrVisual }) {
  const p = data?.plain
  const downloads = p ? p.items.reduce((t, i) => t + i.downloadIds.length, 0) : null
  const rows: Array<[string, string | number]> = []
  if (p) {
    rows.push(['Shows in the queue', p.summary.shows], ['Films in the queue', p.summary.films])
    if (p.summary.artists) rows.push(['Artists in the queue', p.summary.artists])
    rows.push(['Downloading now (shows, films, artists)', p.summary.downloading], ['Waiting in line (shows, films, artists)', p.summary.waiting], ['Stuck (items needing you)', p.summary.stuck])
  }
  if (downloads !== null) rows.push(['Downloads (a season pack counts once)', downloads])
  if (data) rows.push(['Queue rows (one per episode or album)', data.summary.rows])
  if (v) {
    rows.push(['Torrents downloading (download client)', v.pipeline.downloading], ['Torrents stalled (download client)', v.pipeline.stalled], ['Torrents sharing (download client)', v.pipeline.seeding], ['Blocked imports (rows)', v.pipeline.importBlocked])
  }
  return (
    <Panel title="Behind the numbers" sub="WHAT EACH COUNT MEANS" className={c.adv}>
      <table className={c.raw}>
        <tbody>{rows.map(([k, n]) => <tr key={k}><th scope="row">{k}</th><td>{n}</td></tr>)}</tbody>
      </table>
      <p className={c.rawNote}>{p?.summary.unit ?? 'The summary counts shows, films and artists.'} The rows and torrents below are the raw counts from Sonarr, Radarr and the download client: a show with twenty episodes is twenty rows, and each torrent is one download.</p>
    </Panel>
  )
}
