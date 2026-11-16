'use client'

// =============================================================================
//  HyperProx — Arr Stack, "Give up after X tries" and "See what's available"
//
//  The rule per app (TV, films, music): off by default; a preview of exactly what it would give up on today must be
//  looked at and confirmed before it is switched on. The given-up list: item, tries, since, why, what was done, and
//  "Try again". "See what's available" runs ONE release search for one item (the server allows one per item every
//  ten minutes) and shows what was found, best first, with "Download this" even for a release the arr rejected.
//  Viewers see the rule and the lists; only an admin sees buttons (the server refuses everyone else anyway).
//  Everything comes from routes/arr-giveup.ts; no Sonarr, Radarr or Lidarr address or key is ever in this page.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { ModalFrame } from '@/components/layout/ModalFrame'
import { Panel, Pill, styles as s } from '@/components/visual/kit'
import c from './giveup.module.css'
import {
  ACTION_WORD, APPS, APP_LABEL, APP_NAME, grabConfirm, hiddenWord, ruleWord, rowTarget, sinceWord, sizeWord, swarm,
  type App, type AppStatus, type GrabAnswer, type Preview, type Release, type ReleaseAnswer, type Row, type Settings, type Status,
} from './giveup-view'

// ── presentational parts (rendered in tests) ─────────────────────────────────

export function ConfirmBox({ text, yes, busy, onYes, onNo }: { text: string; yes: string; busy?: boolean; onYes: () => void; onNo: () => void }) {
  return (
    <div className={c.confirm} role="alertdialog" aria-label="Confirm">
      <p>{text}</p>
      <div className={c.btns}>
        <button type="button" className={c.primary} disabled={busy} onClick={onYes}>{busy ? 'Working…' : yes}</button>
        <button type="button" className={c.ghost} disabled={busy} onClick={onNo}>Cancel</button>
      </div>
    </div>
  )
}

/** One given-up (or would-give-up) item. */
export function ItemCard({ r, canAct, onTryAgain, onLook, now }: { r: Row; canAct: boolean; onTryAgain?: (r: Row) => void; onLook?: (r: Row) => void; now?: number }) {
  return (
    <li className={c.item} data-reason={r.reason.code}>
      <div className={c.itemHead}>
        <span className={c.itemTitle}>{r.title}</span>
        <span className={c.tries} aria-label={`${r.tries} tries`}><b>{r.tries}</b> {r.tries === 1 ? 'try' : 'tries'}</span>
      </div>
      <span className={c.meta}>{[r.detail, `missing since ${sinceWord(r.since, now)}`, r.gaveUpAt ? `given up ${sinceWord(r.gaveUpAt, now)}` : ''].filter(Boolean).join(' · ')}</span>
      <p className={c.why}>{r.reason.text}</p>
      {(r.action || canAct) && (
        <div className={c.row}>
          {r.action && <Pill tone={r.action === 'remove' ? 'warn' : undefined}>{ACTION_WORD[r.action]}</Pill>}
          {canAct && onLook && r.action !== 'remove' && <button type="button" className={c.link} onClick={() => onLook(r)}>See what&apos;s available</button>}
          {canAct && onTryAgain && r.gaveUpAt && <button type="button" className={c.link} onClick={() => onTryAgain(r)}>Try again</button>}
        </div>
      )}
    </li>
  )
}

/** One release, as a card: the quality big, the swarm as a bar, the arr's reasons in words. */
export function ReleaseCard({ r, app, canGrab, onGrab }: { r: Release; app: App; canGrab: boolean; onGrab: (r: Release) => void }) {
  return (
    <li className={c.rel} data-approved={r.approved} data-top={r.topPick} data-exe={r.executable}>
      <div className={c.relQ}>
        <span className={c.res}>{r.resolution ? `${r.resolution}p` : r.quality}</span>
        <span className={c.relSrc}>{[r.source, r.codec].filter(Boolean).join(' · ')}</span>
      </div>
      <div className={c.relBody}>
        <div className={c.itemHead}>
          <span className={c.relTitle}>{r.title}</span>
          {r.topPick && <Pill tone="accent">{APP_NAME[app]}&apos;s pick</Pill>}
          {!r.topPick && r.approved && <Pill tone="good">Acceptable</Pill>}
          {!r.approved && <Pill tone="warn">Rejected</Pill>}
        </div>
        <span className={c.meta}>
          {[r.quality, sizeWord(r.size), r.indexer, r.languages.join(', '),
            r.protocol === 'usenet' ? [r.ageDays !== null ? `${r.ageDays} days old` : '', r.grabs !== null ? `${r.grabs} grabs` : ''].filter(Boolean).join(', ') : ''].filter(Boolean).join(' · ')}
        </span>
        {r.protocol === 'torrent' && (
          <div className={c.swarm} aria-label={`${r.seeders ?? '?'} seeders, ${r.peers ?? '?'} peers`}>
            <span className={c.swarmBar}><i style={{ width: `${Math.round(swarm(r.seeders) * 100)}%` }} /></span>
            <span>{r.seeders ?? '?'} seeders · {r.peers ?? '?'} peers</span>
          </div>
        )}
        {r.reasons.length > 0 && <ul className={c.reasons}>{r.reasons.map(x => <li key={x}>{x}</li>)}</ul>}
        {r.executable && <p className={c.bad} role="note">Its name shows a program file. HyperProx will not download it.</p>}
        {canGrab && !r.executable && <div className={c.row}><button type="button" className={c.primary} onClick={() => onGrab(r)}>Download this</button></div>}
      </div>
    </li>
  )
}

export function ReleaseList({ a, app, canGrab, showZero, onToggleZero, onGrab }: {
  a: ReleaseAnswer; app: App; canGrab: boolean; showZero: boolean; onToggleZero: () => void; onGrab: (r: Release) => void
}) {
  const hidden = hiddenWord(a.hidden)
  return (
    <div className={c.rels}>
      <p className={c.note}>
        {a.found === 0 ? 'No release found at all on your indexers.' : `${a.found} found, ${a.approved} acceptable to ${APP_NAME[app]}.`}
        {a.top.length > 0 && a.approved === 0 ? ` Most often rejected for: ${a.top.join('; ')}.` : ''}
        {a.reused ? ` Results from ${sinceWord(a.searchedAt) === 'today' ? 'a few minutes ago' : sinceWord(a.searchedAt)}; a new search is possible after ${new Date(a.nextSearchAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ''}
      </p>
      {hidden && <p className={c.note} role="note">{hidden}</p>}
      {(a.hidden.zeroSeed > 0 || showZero) && (
        <label className={c.check}><input type="checkbox" checked={showZero} onChange={onToggleZero} /> Show torrents with no seeders{a.hidden.zeroSeed ? ` (${a.hidden.zeroSeed} hidden)` : ''}</label>
      )}
      {a.rows.length > 0 && <ul className={c.relList}>{a.rows.map(r => <ReleaseCard key={r.id} r={r} app={app} canGrab={canGrab} onGrab={onGrab} />)}</ul>}
    </div>
  )
}

export function RuleCard({ st, canAct, onPreview, onOff }: { st: AppStatus; canAct: boolean; onPreview: (app: App, s: Settings) => void; onOff: (app: App) => void }) {
  const [draft, setDraft] = useState<Settings>(st.settings)
  useEffect(() => setDraft(st.settings), [st.settings])
  const set = (p: Partial<Settings>) => setDraft(d => ({ ...d, ...p }))
  const app = st.app
  return (
    <div className={c.rule} data-on={st.settings.enabled}>
      <div className={c.itemHead}>
        <h3 className={c.ruleHead}>{APP_LABEL[app]}</h3>
        <Pill tone={st.settings.enabled ? 'good' : undefined}>{st.settings.enabled ? 'On' : 'Off'}</Pill>
      </div>
      {!st.configured ? <p className={s.empty}>{APP_NAME[app]} is not set up.</p> : (
        <>
          <div className={c.counts}>
            <span><b>{st.tracking}</b> counted</span>
            <span><b>{st.givenUp}</b> given up</span>
            {st.settings.enabled && <span><b>{st.soon}</b> close</span>}
          </div>
          <p className={c.note}>{ruleWord(st.settings.enabled ? st.settings : draft, app)}</p>
          {canAct && (
            <div className={c.form}>
              <label>Tries <input type="number" min={1} max={200} value={draft.tries} onChange={e => set({ tries: Number(e.target.value) })} /></label>
              <label>Days old <input type="number" min={0} max={3650} value={draft.minAgeDays} onChange={e => set({ minAgeDays: Number(e.target.value) })} /></label>
              <label>Counting from
                <select value={draft.ageFrom} onChange={e => set({ ageFrom: e.target.value as Settings['ageFrom'] })}>
                  <option value="released">{app === 'sonarr' ? 'when it aired' : 'its release'}</option>
                  <option value="first-missing">when first seen missing</option>
                </select>
              </label>
              <label>Then
                <select value={draft.action} onChange={e => set({ action: e.target.value as Settings['action'] })}>
                  <option value="unmonitor">stop searching</option>
                  {app !== 'sonarr' && <option value="remove">remove from library</option>}
                </select>
              </label>
              <div className={c.btns}>
                <button type="button" className={c.primary} onClick={() => onPreview(app, { ...draft, enabled: true })}>{st.settings.enabled ? 'Preview changes' : 'Preview, then turn on'}</button>
                {st.settings.enabled && <button type="button" className={c.ghost} onClick={() => onOff(app)}>Turn off</button>}
              </div>
            </div>
          )}
          {st.lastRun && (
            <p className={c.meta}>Last run {sinceWord(st.lastRun.at)}: {st.lastRun.error ? `failed (${st.lastRun.error})` : `gave up on ${st.lastRun.given}${st.lastRun.skipped.length ? `, skipped ${st.lastRun.skipped.length}` : ''}${st.lastRun.failed.length ? `, ${st.lastRun.failed.length} not changed` : ''}`}.</p>
          )}
        </>
      )}
    </div>
  )
}

export function PreviewView({ p }: { p: Preview }) {
  return (
    <div className={c.rels}>
      <p className={c.big}>{p.summary}</p>
      {p.capped && <p className={c.note}>At most 250 a day are given up; the rest follow on the next days.</p>}
      {p.reasons.length > 0 && (
        <ul className={c.reasonBars} aria-label="Why">
          {p.reasons.map(r => <li key={r.code}><span>{r.text}</span><b>{r.count}</b></li>)}
        </ul>
      )}
      <p className={c.note}>Counted from {p.tracking} missing items{p.observedAt ? `, last read ${sinceWord(p.observedAt)}` : ''}. Nothing is deleted; &quot;Try again&quot; undoes each one.</p>
      {p.rows.length > 0 && <ul className={c.items}>{p.rows.map(r => <ItemCard key={r.key} r={r} canAct={false} />)}</ul>}
    </div>
  )
}

// ── "See what's available" (the dialog) ──────────────────────────────────────

export function ReleasesDialog({ target, app, title, onClose }: { target: string; app: App; title: string; onClose: () => void }) {
  const [a, setA] = useState<ReleaseAnswer | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [showZero, setShowZero] = useState(false)
  const [pick, setPick] = useState<Release | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<GrabAnswer | null>(null)

  const load = useCallback(async (zero: boolean) => {
    setErr(null)
    const r = await apiJson<{ data: ReleaseAnswer }>('/api/plugins/arrstack/give-up/releases', 'POST', { target, showZeroSeed: zero })
    if (!r.ok || !r.body?.data) { setErr(r.error ?? 'The search did not work.'); return }
    setA(r.body.data)
  }, [target])
  useEffect(() => { void load(false) }, [load])

  const grab = async () => {
    if (!pick) return
    setBusy(true)
    const r = await apiJson<{ data: GrabAnswer }>('/api/plugins/arrstack/give-up/grab', 'POST', { target, releaseId: pick.id, confirmed: true })
    setBusy(false); setPick(null)
    if (!r.ok || !r.body?.data) { setErr(r.error ?? 'The download could not be started.'); return }
    setDone(r.body.data)
  }

  return (
    <ModalFrame label={`What is available for ${title}`} onClose={onClose} width="sm:max-w-3xl"
      header={<div className={c.dlgHead}><h2>What&apos;s available</h2><span>{a?.label ?? title}</span></div>}
      footer={<button type="button" className={c.ghost} onClick={onClose}>Close</button>}>
      {!a && !err && <p className={s.empty}>Asking every indexer… this can take a minute.</p>}
      {err && <p className={c.bad} role="alert">{err}</p>}
      {done && <div className={c.result} data-result={done.result} role="status"><p>{done.summary}</p>{done.notes.map(n => <p key={n} className={c.note}>{n}</p>)}</div>}
      {pick && <ConfirmBox text={grabConfirm(pick, a?.label ?? title, app)} yes="Download it" busy={busy} onYes={grab} onNo={() => setPick(null)} />}
      {a && !done && <ReleaseList a={a} app={app} canGrab={!pick} showZero={showZero} onToggleZero={() => { const z = !showZero; setShowZero(z); void load(z) }} onGrab={r => setPick(r)} />}
    </ModalFrame>
  )
}

// ── the panel ────────────────────────────────────────────────────────────────

export function ArrGiveUp({ onChanged }: { onChanged?: () => void }) {
  const { role } = useSession()
  const canAct = atLeast(role, 'admin')
  const [st, setSt] = useState<Status | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ p: Preview; settings: Settings } | null>(null)
  const [previewing, setPreviewing] = useState<App | null>(null)
  const [busy, setBusy] = useState(false)
  const [again, setAgain] = useState<Row | null>(null)
  const [look, setLook] = useState<Row | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [filter, setFilter] = useState<App | 'all'>('all')

  const load = useCallback(async () => {
    const r = await apiJson<{ data: Status }>('/api/plugins/arrstack/give-up')
    if (!r.ok || !r.body?.data) { setErr(r.error ?? 'The give-up rules could not be read.'); return }
    setErr(null); setSt(r.body.data)
  }, [])
  useEffect(() => { void load() }, [load])

  const doPreview = async (app: App, settings: Settings) => {
    setPreviewing(app); setNote(null)
    const r = await apiJson<{ data: Preview }>('/api/plugins/arrstack/give-up/preview', 'POST', { app, settings })
    setPreviewing(null)
    if (!r.ok || !r.body?.data) { setNote(r.error ?? 'The preview did not work.'); return }
    setPreview({ p: r.body.data, settings })
  }
  const save = async (app: App, settings: Settings, previewId?: string) => {
    setBusy(true)
    const r = await apiJson('/api/plugins/arrstack/give-up/settings', 'POST', { app, settings, previewId })
    setBusy(false)
    if (!r.ok) { setNote(r.error ?? 'It was not saved.'); return }
    setPreview(null); setNote(settings.enabled ? `${APP_LABEL[app]}: on. It runs once a day; each run is in the audit log.` : `${APP_LABEL[app]}: off.`)
    void load(); onChanged?.()
  }
  const tryAgain = async () => {
    if (!again) return
    setBusy(true)
    const r = await apiJson<{ data: { summary: string; notes: string[] } }>('/api/plugins/arrstack/give-up/try-again', 'POST', { keys: again.keys, confirmed: true })
    setBusy(false); setAgain(null)
    setNote(r.ok ? [r.body?.data.summary, ...(r.body?.data.notes ?? [])].filter(Boolean).join(' ') : (r.error ?? 'It did not work.'))
    void load(); onChanged?.()
  }

  const list = (st?.givenUp ?? []).filter(r => filter === 'all' || r.app === filter)
  return (
    <>
      <Panel title="Give up after X tries" sub="STOP CHASING WHAT NEVER ARRIVES">
        {err && <p className={c.bad} role="alert">{err}</p>}
        {!st && !err && <p className={s.empty}>Reading…</p>}
        {note && <p className={c.note} role="status">{note}</p>}
        {st && (
          <div className={c.rules}>
            {st.apps.filter(x => x.app !== 'lidarr' || x.configured).map(x => (
              <RuleCard key={x.app} st={x} canAct={canAct} onPreview={(a, s2) => void doPreview(a, s2)} onOff={a => void save(a, { ...x.settings, enabled: false })} />
            ))}
          </div>
        )}
        {previewing && <p className={s.empty}>Counting what {APP_LABEL[previewing]} would give up on…</p>}
        {st && <p className={c.note}>Sonarr, Radarr and Lidarr do not count their searches, so HyperProx does: each time one searches again for something still missing is one try. Files are never deleted and quality profiles are never changed.</p>}
      </Panel>

      {st && st.givenUp.length > 0 && (
        <Panel title="Given up" sub={`${st.givenUp.length} ${st.givenUp.length === 1 ? 'ITEM' : 'ITEMS'}`} level={3}>
          <div className={c.seg} role="group" aria-label="Show">
            {(['all', ...APPS] as const).map(k => <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{k === 'all' ? 'All' : APP_LABEL[k]}</button>)}
          </div>
          <ul className={c.items}>{list.map(r => <ItemCard key={r.key} r={r} canAct={canAct} onTryAgain={setAgain} onLook={setLook} />)}</ul>
        </Panel>
      )}

      {preview && (
        <ModalFrame label="Preview" onClose={() => setPreview(null)} width="sm:max-w-3xl"
          header={<div className={c.dlgHead}><h2>Preview: {APP_LABEL[preview.p.app]}</h2><span>{ruleWord(preview.settings, preview.p.app)}</span></div>}
          footer={<>
            <button type="button" className={c.ghost} onClick={() => setPreview(null)}>Cancel</button>
            <button type="button" className={c.primary} disabled={busy} onClick={() => void save(preview.p.app, preview.settings, preview.p.previewId)}>Confirm and turn on</button>
          </>}>
          <PreviewView p={preview.p} />
        </ModalFrame>
      )}
      {again && (
        <ModalFrame label="Try again" onClose={() => setAgain(null)} width="sm:max-w-lg">
          <ConfirmBox busy={busy} yes="Try again"
            text={again.action === 'remove'
              ? `Add ${again.title}${again.detail ? ` ${again.detail}` : ''} back to ${APP_NAME[again.app]} with the profile and folder it had, and search for it?`
              : `Search for ${again.title}${again.detail ? ` ${again.detail}` : ''} again? It is counted from zero.`}
            onYes={() => void tryAgain()} onNo={() => setAgain(null)} />
        </ModalFrame>
      )}
      {look && <ReleasesDialog target={rowTarget(look)} app={look.app} title={`${look.title} ${look.detail}`} onClose={() => { setLook(null); void load() }} />}
    </>
  )
}
