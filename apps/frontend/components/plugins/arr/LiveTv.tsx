'use client'

// =============================================================================
//  HyperProx — Arr Stack, Live TV (Tunarr)
//
//  The channels as cards: number and icon, what is on now and next, how many programmes, how many hours of guide are
//  published (a bar that fills at 24 hours and turns warm below it), and who is watching (an admin sees the address and
//  player; everyone else a count). Above them, anything wrong carries its fix button for an admin: "Refresh guide"
//  when a guide is short, "Restart stream" for a channel whose stream session has failed. Both ask first, and the
//  server asks again (IN_PAGE sends the confirmation the server's token stands for). Tunarr's API has no other action
//  this page uses, so everything else is read-only, and it says so. Read from routes/arr-tunarr.ts every 20 s while the
//  tab is visible. No address of Tunarr or of its media sources is ever on this page.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { IN_PAGE } from '@/lib/confirm-bus'
import { useSession } from '@/lib/session'
import { Panel, Pill, RingGauge, styles as s } from '@/components/visual/kit'
import c from './livetv.module.css'
import {
  ACT_LABEL, confirmText, guideFill, guideWord, iconPath, untilWord, versionWord, viewersWord,
  type Act, type ActResult, type LiveTv, type TvChannel,
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

/** One channel, as a card. */
export function ChannelCard({ ch, canAct, onAct }: { ch: TvChannel; canAct: boolean; onAct: (a: Act, name: string) => void }) {
  const icon = iconPath(ch)
  const [broken, setBroken] = useState(false)
  const failed = ch.sessions.some(x => x.state === 'error')
  return (
    <li className={c.card} data-live={ch.viewers > 0} data-ok={ch.canStream} data-channel={ch.number}>
      <div className={c.badge} aria-hidden>
        <span>{ch.name.slice(0, 1).toUpperCase()}</span>
        {icon && !broken && <img src={icon} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />}
        <b>{ch.number}</b>
      </div>
      <div className={c.body}>
        <h3 className={c.title}>{ch.name}<small>Channel {ch.number}</small></h3>
        <p className={c.on}>
          {ch.now ? <>On now: <b>{ch.now.title}</b> until {untilWord(ch.now.until)}</> : 'Nothing on right now'}
          {ch.next ? <> · Next: {ch.next.title} at {untilWord(ch.next.at)}</> : null}
        </p>
        <div className={c.bar} role="progressbar" aria-label="Hours of guide published" aria-valuemin={0} aria-valuemax={24} aria-valuenow={Math.round((ch.guideHours ?? 0))} data-short={ch.guideShort}>
          <i style={{ width: `${Math.round(guideFill(ch.guideHours) * 100)}%` }} />
        </div>
        <div className={c.row}>
          <Pill tone={ch.guideShort ? 'warn' : undefined}>{guideWord(ch.guideHours)}</Pill>
          <Pill>{ch.programCount} {ch.programCount === 1 ? 'programme' : 'programmes'}</Pill>
          <Pill tone={ch.viewers ? 'accent' : undefined}>{viewersWord(ch.viewers)}</Pill>
          {!ch.canStream && <Pill tone="warn">Cannot stream</Pill>}
        </div>
        {ch.sessions.some(x => x.who.length) && (
          <ul className={c.who} aria-label="Connected players">
            {ch.sessions.flatMap(x => x.who).map((w, i) => <li key={i}>{w.ip}{w.agent ? ` · ${w.agent}` : ''}</li>)}
          </ul>
        )}
        {ch.problems.map(p => <p key={p} className={c.bad}>{p}</p>)}
        {canAct && failed && (
          <div className={c.row}><button type="button" className={c.primary} onClick={() => onAct({ action: 'stop-session', channelId: ch.id }, `${ch.number} ${ch.name}`)}>{ACT_LABEL['stop-session']}</button></div>
        )}
      </div>
    </li>
  )
}

/** The tab's body for one reading (rendered in tests). */
export function LiveTvView({ tv, canAct, onAct }: { tv: LiveTv; canAct: boolean; onAct: (a: Act, name: string) => void }) {
  const hours = tv.summary.shortestGuideHours
  return (
    <>
      <div className={c.summary}>
        <RingGauge value={tv.summary.channels ? 1 - tv.summary.cannotStream / tv.summary.channels : 0} size={84} big text={`${tv.summary.channels - tv.summary.cannotStream}/${tv.summary.channels}`} label="Can stream"
          color={tv.summary.cannotStream ? 'var(--warn)' : 'var(--hx-accent)'} />
        <div className={c.facts}>
          <div className={c.row}>
            <Pill tone={tv.summary.viewers ? 'accent' : undefined}>{viewersWord(tv.summary.viewers)}</Pill>
            <Pill tone={tv.summary.guideShort ? 'warn' : 'good'}>{hours === null ? 'Guide length unknown' : `Shortest guide ${hours} h`}</Pill>
            <Pill tone={tv.version.behind ? 'warn' : undefined}>Tunarr {versionWord(tv.version)}</Pill>
            {tv.version.ffmpeg && <Pill>ffmpeg {tv.version.ffmpeg}</Pill>}
          </div>
          {tv.sources.length > 0 && (
            <ul className={c.sources} aria-label="Media sources">
              {tv.sources.map(x => <li key={x.name}><Pill tone={x.state === 'ok' ? 'good' : x.state === 'down' ? 'warn' : undefined}>{x.name}: {x.state === 'ok' ? 'connected' : x.state === 'down' ? 'not answering' : 'no answer'}</Pill></li>)}
            </ul>
          )}
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
      ) : <p className={c.allwell}><Pill tone="good">All well</Pill> Every channel can stream and every guide holds a day or more.</p>}
      {tv.channels.length === 0
        ? <p className={s.empty}>Tunarr has no channels yet.</p>
        : <ul className={c.list} aria-label="Channels">{tv.channels.map(ch => <ChannelCard key={ch.id} ch={ch} canAct={canAct} onAct={onAct} />)}</ul>}
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

  const load = useCallback(async () => {
    const r = await apiJson<{ data: LiveTv }>('/api/plugins/arrstack/tunarr')
    if (!r.ok || !r.body?.data) { setErr(r.error ?? 'Tunarr could not be read.'); return }
    setErr(null); setTv(r.body.data)
  }, [])
  useEffect(() => {
    void load()
    const t = setInterval(() => { if (!document.hidden) void load() }, 20_000)
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

  if (!tv && !err) return <Panel title="Live TV" sub="TUNARR"><p className={s.empty}>Reading Tunarr…</p></Panel>
  return (
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
  )
}
