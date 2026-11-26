'use client'

// =============================================================================
//  HyperProx — Arr Stack, Live TV (Tunarr)
//
//  A guide: channels as compact rows in groups (Tunarr's own groups, else bands of ten by number) with a search box and
//  filters. Each row has the number and icon (a letter when Tunarr has none), what is on now (show and episode) with a
//  progress bar, and what is next. A chip appears only when a channel differs: a shorter guide, programmes Tunarr marks
//  marked missing by Tunarr, viewers (an admin sees the address and player; everyone else a count). The guide
//  length and the library sync are said once, at the top. Above them, anything wrong carries its fix button for an admin: "Refresh guide"
//  when a guide is short, "Restart stream" for a channel whose stream session has failed. Both ask first, and the
//  server asks again (IN_PAGE sends the confirmation the server's token stands for). Tunarr's API has no other action
//  this page uses, so everything else is read-only, and it says so. Read from routes/arr-tunarr.ts every 20 s while the
//  tab is visible. No address of Tunarr or of its media sources is ever on this page.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { IN_PAGE } from '@/lib/confirm-bus'
import { useSession } from '@/lib/session'
import { Panel, Pill, RingGauge, styles as s } from '@/components/visual/kit'
import c from './livetv.module.css'
import {
  ACT_LABEL, confirmText, filterChannels, groupChannels, guideDiffers, guideWord, iconPath, leftWord, needsAttention, pollDue, programText,
  progressOf, syncedWord, typicalGuideHours, untilWord, versionWord, viewersWord,
  type Act, type ActResult, type LiveTv, type TvChannel, type TvFilter, type TvGroup,
} from './livetv-view'

export function ConfirmBox({ text, yes, busy, onYes, onNo }: { text: string; yes: string; busy?: boolean; onYes: () => void; onNo: () => void }) {
  return (
    <div className={c.confirm} role="alertdialog" aria-label="Confirm">
      <p>{text}</p>
      <div className={c.row}>
        <button type="button" className={c.primary} disabled={busy} onClick={onYes}>{busy ? 'Working…' : yes}</button>
        <button type="button" className={c.ghost} disabled={busy} onClick={onNo}>Cancel</button>
      </div>
    </div>
  )
}

/** One channel as a guide row: number and icon, what is on now with its progress, and what is next. */
export function ChannelRow({ ch, canAct, onAct, nowMs, typical }: { ch: TvChannel; canAct: boolean; onAct: (a: Act, name: string) => void; nowMs: number; typical: number | null }) {
  const icon = iconPath(ch)
  const [broken, setBroken] = useState(false)
  const failed = ch.sessions.some(x => x.state === 'error')
  const pct = Math.round(progressOf(ch.now, nowMs) * 100)
  const unsynced = ch.ready ? ch.ready.programmes - ch.ready.synced : 0
  return (
    <li className={c.row2} data-live={ch.viewers > 0} data-ok={ch.canStream} data-attn={needsAttention(ch)} data-channel={ch.number}>
      <div className={c.badge} aria-hidden>
        <span>{ch.name.slice(0, 1).toUpperCase()}</span>
        {icon && !broken && <img src={icon} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />}
      </div>
      <div className={c.body}>
        <h3 className={c.title}><b className={c.num}>{ch.number}</b>{ch.name}</h3>
        <p className={c.on}>
          {ch.now
            ? <><span className={c.tag}>{ch.now.kind === 'break' ? 'Break' : 'Now'}</span> <b>{ch.now.kind === 'break' ? 'Between programmes' : ch.now.title}</b>{ch.now.episode ? <> — {ch.now.episode}</> : null}{ch.now.code ? <em> {ch.now.code}</em> : null}</>
            : <span className={c.dim}>Nothing on right now</span>}
        </p>
        {ch.now && (
          <div className={c.bar} role="progressbar" aria-label={`Progress through ${programText(ch.now)}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <i style={{ width: `${pct}%` }} />
          </div>
        )}
        <p className={c.next}>
          {ch.now ? <span className={c.dim}>{leftWord(ch.now, nowMs)}</span> : null}
          {ch.next ? <>{ch.now ? ' · ' : ''}<span className={c.tag}>Next</span> {programText(ch.next)} <span className={c.dim}>at {untilWord(ch.next.at)}</span></> : null}
        </p>
        {(ch.viewers > 0 || guideDiffers(ch, typical) || unsynced > 0 || !ch.canStream) && (
          <div className={c.chips}>
            {ch.viewers > 0 && <Pill tone="accent">{viewersWord(ch.viewers)}</Pill>}
            {guideDiffers(ch, typical) && <Pill tone={ch.guideShort ? 'warn' : undefined}>{guideWord(ch.guideHours)}</Pill>}
            {ch.ready && unsynced > 0 && <Pill tone="warn" title="Programmes in the next 48 hours that Tunarr does not mark as missing">{ch.ready.pct}% present</Pill>}
            {!ch.canStream && <Pill tone="warn">Cannot stream</Pill>}
          </div>
        )}
        {ch.sessions.some(x => x.who.length) && (
          <ul className={c.who} aria-label="Connected players">
            {ch.sessions.flatMap(x => x.who).map((w, i) => <li key={i}>{w.ip}{w.agent ? ` · ${w.agent}` : ''}</li>)}
          </ul>
        )}
        {ch.problems.map(p => <p key={p} className={c.bad}>{p}</p>)}
        {canAct && failed && (
          <div className={c.chips}><button type="button" className={c.primary} onClick={() => onAct({ action: 'stop-session', channelId: ch.id }, `${ch.number} ${ch.name}`)}>{ACT_LABEL['stop-session']}</button></div>
        )}
      </div>
    </li>
  )
}

const FILTERS: Array<[TvFilter, string]> = [['all', 'All'], ['attention', 'Needs attention'], ['watching', 'Watching']]

/** The tab's body for one reading (rendered in tests). `nowMs` is the clock the progress bars use. */
export function LiveTvView({ tv, canAct, onAct, nowMs = Date.now() }: { tv: LiveTv; canAct: boolean; onAct: (a: Act, name: string) => void; nowMs?: number }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<TvFilter>('all')
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const hours = tv.summary.shortestGuideHours
  const typical = typicalGuideHours(tv.channels)
  const sync = syncedWord(tv)
  const searching = query.trim() !== '' || filter !== 'all'
  const shown = filterChannels(tv.channels, query, filter)
  const groups = groupChannels(shown)
  const attention = tv.channels.filter(needsAttention).length
  const watching = tv.channels.filter(x => x.viewers > 0).length
  // Short lists are all open; a long one opens only the groups someone should look at (and everything while searching).
  const openByDefault = (g: TvGroup, i: number) => searching || tv.channels.length <= 12 || i === 0 || g.channels.some(x => needsAttention(x) || x.viewers > 0)
  const ringValue = sync ? sync.value : tv.summary.channels ? 1 - tv.summary.cannotStream / tv.summary.channels : 0
  const ringText = sync ? sync.text : `${tv.summary.channels - tv.summary.cannotStream}/${tv.summary.channels}`
  const bad = sync ? sync.value < 1 : tv.summary.cannotStream > 0
  return (
    <>
      <div className={c.summary}>
        <RingGauge value={ringValue} size={84} big text={ringText} label={sync ? 'Present' : 'Playable'} color={bad ? 'var(--warn)' : 'var(--hx-accent)'} />
        <div className={c.facts}>
          <ul className={c.row} aria-label="Status">
            <li><Pill tone={tv.summary.viewers ? 'accent' : undefined}>{viewersWord(tv.summary.viewers)}</Pill></li>
            <li><Pill tone={tv.summary.guideShort ? 'warn' : 'good'}>{hours === null ? 'Guide length unknown' : tv.summary.guideShort ? `Shortest guide ${hours} h` : `Guide ${hours} h or more`}</Pill></li>
            <li><Pill tone={tv.version.behind ? 'warn' : undefined}>Tunarr {versionWord(tv.version)}</Pill></li>
            {tv.version.ffmpeg && <li><Pill>FFmpeg {tv.version.ffmpeg}</Pill></li>}
            {tv.sources.map(x => <li key={x.name}><Pill tone={x.state === 'ok' ? 'good' : x.state === 'down' ? 'warn' : undefined}>{x.name}: {x.state === 'ok' ? 'connected' : x.state === 'down' ? 'not answering' : 'no answer'}</Pill></li>)}
          </ul>
          {tv.summary.notRescanning > 0 && <p className={c.note}>{tv.summary.notRescanning} {tv.summary.notRescanning === 1 ? 'library is' : 'libraries are'} not rescanning in Tunarr. That does not stop their programmes playing.</p>}
        </div>
      </div>
      {tv.warnings.length > 0 ? (
        <ul className={c.warnings} aria-label="Problems">
          {tv.warnings.map((w, i) => (
            <li key={i} className={c.warning} data-level={w.level}>
              <p>{w.text}</p>
              {canAct && w.fix === 'refresh-guide' && tv.actions.refreshGuide && <div className={c.row}><button type="button" className={c.primary} onClick={() => onAct({ action: 'refresh-guide' }, '')}>{ACT_LABEL['refresh-guide']}</button></div>}
              {canAct && w.fix === 'stop-session' && w.channelId && <div className={c.row}><button type="button" className={c.primary} onClick={() => onAct({ action: 'stop-session', channelId: w.channelId! }, tv.channels.find(x => x.id === w.channelId)?.name ?? '')}>{ACT_LABEL['stop-session']}</button></div>}
            </li>
          ))}
        </ul>
      ) : <p className={c.allwell}><Pill tone="good">All well</Pill> Every channel has something on, every guide holds a day or more{sync ? ', and no programme is marked missing' : ''}.</p>}
      {tv.channels.length === 0
        ? <p className={s.empty}>Tunarr has no channels yet.</p>
        : (
          <>
            <div className={c.tools} role="search">
              <input type="search" className={c.search} value={query} onChange={e => setQuery(e.target.value)} placeholder="Search channels or programmes" aria-label="Search channels or programmes" />
              <div className={c.filters} role="group" aria-label="Show">
                {FILTERS.map(([k, label]) => (
                  <button key={k} type="button" className={c.filter} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                    {label}{k === 'attention' ? ` ${attention}` : k === 'watching' ? ` ${watching}` : ` ${tv.channels.length}`}
                  </button>
                ))}
              </div>
            </div>
            {shown.length === 0
              ? <p className={s.empty}>No channel matches.</p>
              : (
                <div className={c.groups} aria-label="Channels">
                  {groups.map((g, i) => (
                    <details key={g.key} className={c.group} open={toggled[g.key] ?? openByDefault(g, i)} onToggle={e => { const o = (e.currentTarget as HTMLDetailsElement).open; setToggled(t => (t[g.key] === o ? t : { ...t, [g.key]: o })) }}>
                      <summary className={c.groupHead}>
                        <span>{g.label}</span>
                        <small>{g.channels.length} {g.channels.length === 1 ? 'channel' : 'channels'}{g.channels.some(needsAttention) ? ` · ${g.channels.filter(needsAttention).length} to check` : ''}</small>
                      </summary>
                      <ul className={c.list}>{g.channels.map(ch => <ChannelRow key={ch.id} ch={ch} canAct={canAct} onAct={onAct} nowMs={nowMs} typical={typical} />)}</ul>
                    </details>
                  ))}
                </div>
              )}
          </>
        )}
      <p className={c.note}>{tv.actions.refreshGuide ? 'Refresh guide and Restart stream are the only changes this page can make; ' : 'Restart stream is the only change this page can make (this Tunarr has no guide task to run); '}everything else about Tunarr is read-only here. Channels, programming and settings are changed in Tunarr itself.</p>
    </>
  )
}

export function ArrLiveTv() {
  const { role } = useSession()
  const canAct = atLeast(role, 'admin')
  const [tv, setTv] = useState<LiveTv | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ask, setAsk] = useState<{ act: Act; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ActResult | null>(null)

  // One reading at a time: a poll that finds the last one still running is skipped, never queued behind it.
  const loading = useRef(false)
  const load = useCallback(async () => {
    if (loading.current) return
    loading.current = true
    try {
      const r = await apiJson<{ data: LiveTv }>('/api/plugins/arrstack/tunarr')
      if (!r.ok || !r.body?.data) { setErr(r.error ?? 'Tunarr could not be read.'); return }
      setErr(null); setTv(r.body.data)
    } finally { loading.current = false }
  }, [])
  useEffect(() => {
    void load()
    const t = setInterval(() => { if (pollDue(document.hidden, loading.current)) void load() }, 20_000)
    return () => clearInterval(t)
  }, [load])

  const run = async () => {
    if (!ask) return
    setBusy(true)
    const r = await apiJson<{ data: ActResult }>('/api/plugins/arrstack/tunarr/actions', 'POST', ask.act, IN_PAGE)
    setBusy(false); setAsk(null)
    if (!r.ok || !r.body?.data) { setErr(r.error ?? 'The change did not run.'); return }
    setResult(r.body.data); void load()
  }

  if (!tv && !err) return <div className={c.root}><Panel title="Live TV" sub="TUNARR"><p className={s.empty}>Reading Tunarr…</p></Panel></div>
  return (
    <div className={c.root}>
    <Panel title="Live TV" sub="TUNARR">
      {err && <p className={c.bad} role="alert">{err}</p>}
      {result && (
        <div className={c.result} data-done={result.done} role="status">
          <p>{result.summary}</p>{result.notes.map(n => <p key={n} className={c.note}>{n}</p>)}
        </div>
      )}
      {ask && <ConfirmBox text={confirmText(ask.act, ask.name)} yes={ACT_LABEL[ask.act.action]} busy={busy} onYes={() => void run()} onNo={() => setAsk(null)} />}
      {tv && !tv.configured && <p className={c.note} role="status">Tunarr is not set up here. Add its address in the Arr Stack settings (Tunarr address) to see your channels, the guide and who is streaming.</p>}
      {tv?.configured && <LiveTvView tv={tv} canAct={canAct && !ask} onAct={(act, name) => setAsk({ act, name })} />}
    </Panel>
    </div>
  )
}
