'use client'

// =============================================================================
//  HyperProx — Arr Stack, "Sort requests into the right folder"
//
//  Request apps send every film to one folder and every show to another. Here the owner sees, per app, a flow: the
//  folder requests arrive in, then the rules in order (each a condition and the folder it sends to), which the owner
//  can switch on or off, point at another folder and reorder. "Test on my library" runs the rules over everything
//  already there (read-only) and shows the agreement as a ring, each folder as a pair of bars (where things are, where
//  the rules would put them), and the disagreements grouped with examples. Sorting is off by default and is switched
//  on from a test's result, with a confirm. "Recently sorted" shows every move with why, and "Move to…" for an admin.
//  Shows also have "Graduate finished shows": a preview first, then a confirm.
//  Viewers see the rules and the moves; only an admin sees controls (the server refuses everyone else anyway).
//  Everything comes from routes/arr-router.ts; no Radarr or Sonarr address or key is ever in this page.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { IN_PAGE } from '@/lib/confirm-bus'
import { useSession } from '@/lib/session'
import { ModalFrame } from '@/components/layout/ModalFrame'
import { Panel, Pill, RingGauge, styles as s } from '@/components/visual/kit'
import c from './giveup.module.css'
import r from './router.module.css'
import { ConfirmBox } from './GiveUp'
import {
  agreementWord, conditionLabel, draftBody, folderName, graduateWord, moveRule, moveWord, parseTmdb, ruleLine, sinceWord, suggestedWord, switchOnWord, tickWord,
  type GraduatePreview, type LibraryTest, type Move, type RouterApp, type RouterAppStatus, type RouterSettings, type RouterStatus, type Rule,
} from './router-view'

const BASE = '/api/plugins/arrstack/router'

// ── presentational parts (rendered in tests) ─────────────────────────────────

/** The rules as a flow: where requests arrive, then each rule in order down to "everything else". */
export function RuleFlow({ st, draft, canEdit, onChange }: { st: RouterAppStatus; draft: RouterSettings; canEdit: boolean; onChange: (d: RouterSettings) => void }) {
  const setRule = (i: number, p: Partial<Rule>) => onChange({ ...draft, rules: draft.rules.map((x, j) => (j === i ? { ...x, ...p } : x)) })
  return (
    <ol className={r.flow} aria-label={`${st.label}: the sorting rules, in order`}>
      <li className={r.inlet}>
        <span className={r.stepNo} aria-hidden>IN</span>
        <div className={r.stepBody}>
          <span className={r.stepTitle}>Requests arrive in</span>
          {canEdit ? (
            <select aria-label="The folder requests arrive in" value={draft.defaultRoot ?? ''} onChange={e => onChange({ ...draft, defaultRoot: e.target.value || null })}>
              <option value="">Pick a folder</option>
              {st.roots.map(f => <option key={f} value={f}>{folderName(f)}</option>)}
            </select>
          ) : <span className={r.folder}>{folderName(draft.defaultRoot)}</span>}
          <span className={c.meta}>Only new items that land here are ever moved; nothing you placed yourself is touched.</span>
        </div>
      </li>
      {draft.rules.map((x, i) => (
        <li key={x.condition} className={r.step} data-on={x.enabled && (!!x.folder || x.condition === 'curated')} data-curated={x.condition === 'curated'}>
          <span className={r.stepNo} aria-hidden>{i + 1}</span>
          <div className={r.stepBody}>
            <div className={r.stepHead}>
              <span className={r.stepTitle}>{conditionLabel(st, x.condition)}</span>
              {x.condition !== 'curated' && <span className={r.arrow} aria-hidden>→</span>}
              {canEdit ? (
                <select aria-label={`Folder for ${conditionLabel(st, x.condition)}`} value={x.folder ?? ''} onChange={e => setRule(i, { folder: e.target.value || null, enabled: !!e.target.value && (x.enabled || !x.folder) })}>
                  <option value="">No folder</option>
                  {st.roots.map(f => <option key={f} value={f}>{folderName(f)}</option>)}
                </select>
              ) : <span className={r.folder}>{folderName(x.folder)}</span>}
            </div>
            <span className={c.meta}>{ruleLine(st, x)}</span>
            {canEdit && (
              <div className={c.row}>
                <label className={c.check}><input type="checkbox" checked={x.enabled} disabled={!x.folder} onChange={e => setRule(i, { enabled: e.target.checked })} /> On</label>
                <button type="button" className={c.link} disabled={i === 0} aria-label={`Move ${conditionLabel(st, x.condition)} up`} onClick={() => onChange({ ...draft, rules: moveRule(draft.rules, i, -1) })}>Up</button>
                <button type="button" className={c.link} disabled={i === draft.rules.length - 1} aria-label={`Move ${conditionLabel(st, x.condition)} down`} onClick={() => onChange({ ...draft, rules: moveRule(draft.rules, i, 1) })}>Down</button>
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}

/** "Not cartoons": TMDB numbers of photoreal remakes the owner named (films only). */
export function PhotorealList({ draft, canEdit, onChange }: { draft: RouterSettings; canEdit: boolean; onChange: (d: RouterSettings) => void }) {
  const [v, setV] = useState('')
  const n = parseTmdb(v)
  return (
    <div className={r.chips}>
      <span className={r.stepTitle}>Not cartoons</span>
      <span className={c.meta}>Photoreal remakes are found by their TMDB keywords. Add any it misses by its TMDB number.</span>
      <div className={c.row}>
        {draft.photoreal.length === 0 && <span className={c.meta}>None added.</span>}
        {draft.photoreal.map(id => (
          <span key={id} className={r.chip}>TMDB {id}{canEdit && <button type="button" aria-label={`Remove TMDB ${id}`} onClick={() => onChange({ ...draft, photoreal: draft.photoreal.filter(x => x !== id) })}>×</button>}</span>
        ))}
      </div>
      {canEdit && (
        <div className={c.row}>
          <input className={r.input} aria-label="TMDB number" inputMode="numeric" placeholder="TMDB number" value={v} onChange={e => setV(e.target.value)} />
          <button type="button" className={c.ghost} disabled={n === null || draft.photoreal.includes(n)} onClick={() => { if (n !== null) { onChange({ ...draft, photoreal: [...draft.photoreal, n] }); setV('') } }}>Add</button>
        </div>
      )}
    </div>
  )
}

/** A library test's result: the agreement ring, each folder's two bars, the disagreements grouped. */
export function TestView({ t }: { t: LibraryTest }) {
  const max = Math.max(1, ...t.byFolder.map(f => Math.max(f.actual, f.picked)))
  return (
    <div className={r.test}>
      <div className={r.testHead}>
        <RingGauge value={(t.agreement ?? 0) / 100} size={104} big text={t.agreement === null ? '—' : `${Math.round(t.agreement)}%`} label="Agree"
          color={(t.agreement ?? 0) >= 80 ? 'var(--hx-accent)' : 'var(--warn)'} />
        <div className={r.testFacts}>
          <p className={c.big}>{agreementWord(t)}</p>
          <p className={c.note}>Read-only: nothing was moved. {t.curated ? `${t.curated} in hand-picked folders are left out of the score.` : ''}</p>
        </div>
      </div>
      <ul className={r.bars} aria-label="Folders: now and with these rules">
        {t.byFolder.map(f => (
          <li key={f.folder}>
            <span className={r.barName}>{folderName(f.folder)}</span>
            <span className={r.barPair}>
              <i className={r.now} style={{ width: `${(f.actual / max) * 100}%` }} aria-hidden />
              <i className={r.then} style={{ width: `${(f.picked / max) * 100}%` }} aria-hidden />
            </span>
            <span className={r.barNums}>{f.actual} → <b>{f.picked}</b></span>
          </li>
        ))}
      </ul>
      <p className={c.meta}><span className={r.keyNow} /> where they are now · <span className={r.keyThen} /> where these rules would put them</p>
      {t.disagreements.length > 0 && (
        <ul className={r.groups} aria-label="Where the rules disagree">
          {t.disagreements.map(d => (
            <li key={`${d.actual}>${d.pick}`} className={r.group}>
              <div className={r.groupHead}>
                <span className={r.folder}>{folderName(d.actual)}</span>
                <span className={r.arrow} aria-hidden>→</span>
                <span className={r.folder}>{folderName(d.pick)}</span>
                <b className={r.count}>{d.count}</b>
              </div>
              <span className={c.meta}>{d.condition ? `by the rule for ${d.condition.replace(/-/g, ' ')}` : 'no rule matched'} · e.g. {d.examples.join(', ')}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** One move in Recently sorted: the item, from → to, why, and "Move to…" for an admin. */
export function MoveCard({ m, st, canAct, onMove }: { m: Move; st?: RouterAppStatus; canAct: boolean; onMove?: (m: Move, folder: string) => void }) {
  const [to, setTo] = useState('')
  return (
    <li className={r.move} data-ok={m.ok} data-kind={m.kind}>
      <div className={c.itemHead}>
        <span className={c.itemTitle}>{m.year ? `${m.title} (${m.year})` : m.title}</span>
        <span className={c.meta}>{sinceWord(m.at)}</span>
      </div>
      <div className={r.groupHead}>
        <span className={r.folder}>{folderName(m.from)}</span>
        <span className={r.arrow} aria-hidden>→</span>
        <span className={r.folder}>{folderName(m.to)}</span>
        <Pill tone={m.ok ? 'accent' : 'warn'}>{m.ok ? m.why : 'Not moved'}</Pill>
      </div>
      <span className={c.meta}>{m.ok ? `Because: ${m.detail}${m.kind === 'moved' ? ` · by ${m.by}` : ''}` : m.error}</span>
      {canAct && onMove && st && m.ok && (
        <div className={c.row}>
          <select aria-label={`Move ${m.title} to`} value={to} onChange={e => setTo(e.target.value)}>
            <option value="">Move to…</option>
            {st.roots.filter(f => f !== m.to).map(f => <option key={f} value={f}>{f === m.from ? `${folderName(f)} (undo)` : folderName(f)}</option>)}
          </select>
          <button type="button" className={c.ghost} disabled={!to} onClick={() => onMove(m, to)}>Move</button>
        </div>
      )}
    </li>
  )
}

// ── one app's card ───────────────────────────────────────────────────────────

function AppCard({ st, canAct, onSaved }: { st: RouterAppStatus; canAct: boolean; onSaved: (note: string) => void }) {
  const [draft, setDraft] = useState<RouterSettings | null>(st.settings)
  useEffect(() => setDraft(st.settings), [st.settings])
  const [test, setTest] = useState<LibraryTest | null>(null)
  const [testing, setTesting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ask, setAsk] = useState<'on' | null>(null)
  const [busy, setBusy] = useState(false)
  const [grad, setGrad] = useState<GraduatePreview | null>(null)
  if (!st.configured) return <div className={c.rule}><h3 className={c.ruleHead}>{st.label}</h3><p className={s.empty}>{st.name} is not set up.</p></div>
  if (!draft) return <div className={c.rule}><h3 className={c.ruleHead}>{st.label}</h3><p className={c.bad}>{st.error ?? `${st.name} could not be read.`}</p></div>
  const on = !!st.settings?.enabled
  const changed = JSON.stringify(draftBody({ ...draft, enabled: on })) !== JSON.stringify(draftBody({ ...st.settings!, enabled: on }))

  const runTest = async () => {
    setTesting(true); setErr(null); setTest(null)
    const res = await apiJson<{ data: LibraryTest }>(`${BASE}/test`, 'POST', { app: st.app, settings: draftBody(draft) })
    setTesting(false)
    if (!res.ok || !res.body?.data) { setErr(res.error ?? 'The test did not run.'); return }
    setTest(res.body.data)
  }
  const save = async (enabled: boolean, inPage: boolean) => {
    setBusy(true); setErr(null)
    const res = await apiJson(`${BASE}/settings`, 'POST', { app: st.app, settings: { ...draftBody(draft), enabled }, testId: test?.testId }, inPage ? IN_PAGE : undefined)
    setBusy(false); setAsk(null)
    if (!res.ok) { setErr(res.error ?? 'It was not saved.'); return }
    setTest(null)
    onSaved(`${st.label}: ${enabled ? 'sorting is on. New requests move a minute after they are added.' : 'the rules are saved; sorting is off.'}`)
  }
  const preview = async () => {
    setBusy(true); setErr(null)
    const res = await apiJson<{ data: GraduatePreview }>(`${BASE}/graduate/preview`, 'POST', {})
    setBusy(false)
    if (!res.ok || !res.body?.data) { setErr(res.error ?? 'The preview did not work.'); return }
    setGrad(res.body.data)
  }
  const graduate = async () => {
    if (!grad) return
    setBusy(true)
    const res = await apiJson<{ data: { summary: string } }>(`${BASE}/graduate`, 'POST', { previewId: grad.previewId }, IN_PAGE)
    setBusy(false); setGrad(null)
    if (!res.ok || !res.body?.data) { setErr(res.error ?? 'The shows were not moved.'); return }
    onSaved(res.body.data.summary)
  }

  return (
    <div className={c.rule} data-on={on}>
      <div className={c.itemHead}>
        <h3 className={c.ruleHead}>{st.label}</h3>
        <Pill tone={on ? 'good' : undefined}>{on ? 'Sorting on' : 'Sorting off'}</Pill>
        {st.app === 'sonarr' && st.settings?.graduate && <Pill tone="accent">Graduating</Pill>}
        {!st.saved && <Pill>Suggested rules</Pill>}
      </div>
      {on && <p className={c.meta}>{tickWord(st.lastTick)}</p>}
      {suggestedWord(st) && <p className={c.note}>{suggestedWord(st)}</p>}
      {err && <p className={c.bad} role="alert">{err}</p>}
      <RuleFlow st={st} draft={draft} canEdit={canAct} onChange={d => { setDraft(d); setTest(null) }} />
      {st.app === 'radarr' && <PhotorealList draft={draft} canEdit={canAct} onChange={d => { setDraft(d); setTest(null) }} />}
      {canAct && (
        <div className={c.btns}>
          <button type="button" className={c.primary} disabled={testing} onClick={() => void runTest()}>{testing ? 'Testing…' : 'Test on my library'}</button>
          {!on && changed && <button type="button" className={c.ghost} disabled={busy} onClick={() => void save(false, false)}>Save rules</button>}
          {on && <button type="button" className={c.ghost} disabled={busy} onClick={() => void save(false, false)}>Turn sorting off</button>}
        </div>
      )}
      {testing && <p className={s.empty}>Reading the whole library…</p>}
      {test && (
        <>
          <TestView t={test} />
          {canAct && (
            <div className={c.btns}>
              {(!on || changed) && <button type="button" className={c.primary} disabled={busy || !draft.defaultRoot} onClick={() => setAsk('on')}>{on ? 'Save and keep sorting on' : 'Turn sorting on'}</button>}
              {!on && <button type="button" className={c.ghost} disabled={busy} onClick={() => void save(false, false)}>Save rules, keep it off</button>}
            </div>
          )}
        </>
      )}
      {ask === 'on' && <ConfirmBox text={switchOnWord(st.app, draft)} yes={on ? 'Save it' : 'Turn it on'} busy={busy} onYes={() => void save(true, true)} onNo={() => setAsk(null)} />}
      {st.app === 'sonarr' && (
        <div className={r.chips}>
          <span className={r.stepTitle}>Graduate finished shows</span>
          <span className={c.meta}>A show in the running-shows folder that has ended, with every aired episode on disk, moves to the ended-shows folder. Off until you confirm a preview.</span>
          {canAct && (
            <div className={c.row}>
              {!st.settings?.graduate && <button type="button" className={c.ghost} disabled={busy} onClick={() => void preview()}>Preview</button>}
              {st.settings?.graduate && <button type="button" className={c.ghost} disabled={busy} onClick={() => { setDraft({ ...draft, graduate: false }); void apiJson(`${BASE}/settings`, 'POST', { app: 'sonarr', settings: { ...draftBody(st.settings!), graduate: false } }).then(res => (res.ok ? onSaved('Shows: graduating is off.') : setErr(res.error ?? 'It was not saved.'))) }}>Stop graduating</button>}
            </div>
          )}
        </div>
      )}
      {grad && (
        <ModalFrame label="Graduate finished shows" onClose={() => setGrad(null)} width="sm:max-w-2xl"
          header={<div className={c.dlgHead}><h2>Graduate finished shows</h2><span>{folderName(grad.from)} → {folderName(grad.to)}</span></div>}
          footer={<>
            <button type="button" className={c.ghost} onClick={() => setGrad(null)}>Cancel</button>
            <button type="button" className={c.primary} disabled={busy || grad.shows.length === 0} onClick={() => void graduate()}>Move them and keep graduating</button>
          </>}>
          <p className={c.big}>{grad.shows.length === 0 ? 'No finished show is waiting.' : graduateWord(grad)}</p>
          <ul className={r.groups}>
            {grad.shows.map(x => <li key={x.id} className={r.group}><span className={c.itemTitle}>{x.year ? `${x.title} (${x.year})` : x.title}</span><span className={c.meta}>{x.files} of {x.aired} aired episodes on disk</span></li>)}
          </ul>
        </ModalFrame>
      )}
    </div>
  )
}

// ── the panel ────────────────────────────────────────────────────────────────

export function ArrRouter() {
  const { role } = useSession()
  const canAct = atLeast(role, 'admin')
  const [st, setSt] = useState<RouterStatus | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [app, setApp] = useState<RouterApp | 'all'>('all')
  const [moving, setMoving] = useState<{ m: Move; folder: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const res = await apiJson<{ data: RouterStatus }>(BASE)
    if (!res.ok || !res.body?.data) { setErr(res.error ?? 'The sorting rules could not be read.'); return }
    setErr(null); setSt(res.body.data)
  }, [])
  useEffect(() => {
    void load()
    const t = setInterval(() => { if (!document.hidden) void load() }, 60_000)
    return () => clearInterval(t)
  }, [load])

  const move = async () => {
    if (!moving) return
    setBusy(true)
    const res = await apiJson<{ data: Move }>(`${BASE}/move`, 'POST', { app: moving.m.app, id: moving.m.id, folder: moving.folder }, IN_PAGE)
    setBusy(false); setMoving(null)
    setNote(res.ok ? `Moved ${moving.m.title} to ${folderName(moving.folder)}. It will not be sorted again.` : (res.error ?? 'It was not moved.'))
    void load()
  }

  const recent = (st?.recent ?? []).filter(m => app === 'all' || m.app === app)
  return (
    <>
      <Panel title="Sort requests into folders" sub="EACH NEW REQUEST, INTO ITS OWN FOLDER">
        {err && <p className={c.bad} role="alert">{err}</p>}
        {!st && !err && <p className={s.empty}>Reading…</p>}
        {note && <p className={c.note} role="status">{note}</p>}
        {st && (
          <>
            <p className={c.note}>Request apps send every film to one folder and every show to another. With sorting on, HyperProx moves each new request into the folder its rules pick, using what {st.apps.map(a => a.name).join(' and ')} know about it, about a minute after it is added and usually before it downloads. Only items added after sorting is switched on, within the last {st.lookbackHours} hours, are moved; every move is in the audit log and below.</p>
            <div className={r.apps}>{st.apps.map(a => <AppCard key={a.app} st={a} canAct={canAct} onSaved={n => { setNote(n); void load() }} />)}</div>
          </>
        )}
      </Panel>

      {st && st.recent.length > 0 && (
        <Panel title="Recently sorted" sub={`${st.recent.length} ${st.recent.length === 1 ? 'MOVE' : 'MOVES'}`} level={3}>
          <div className={c.seg} role="group" aria-label="Show">
            {(['all', 'radarr', 'sonarr'] as const).map(k => <button key={k} type="button" aria-pressed={app === k} onClick={() => setApp(k)}>{k === 'all' ? 'All' : k === 'radarr' ? 'Films' : 'Shows'}</button>)}
          </div>
          <ul className={c.items}>{recent.map(m => <MoveCard key={m.key} m={m} st={st.apps.find(a => a.app === m.app)} canAct={canAct} onMove={(mv, folder) => setMoving({ m: mv, folder })} />)}</ul>
        </Panel>
      )}
      {moving && (
        <ModalFrame label="Move" onClose={() => setMoving(null)} width="sm:max-w-lg">
          <ConfirmBox busy={busy} yes="Move it" text={moveWord(moving.m, moving.folder)} onYes={() => void move()} onNo={() => setMoving(null)} />
        </ModalFrame>
      )}
    </>
  )
}
