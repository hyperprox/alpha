'use client'

// =============================================================================
//  HyperProx — Updates: HyperProx itself
//
//  The version this install runs, whether a newer one is out on its channel,
//  and the update: a preview of every step, the master password, then the
//  steps and log as the updater runs them. The updater restarts HyperProx, so
//  the progress comes from its state file: when the API is back, the next
//  poll carries on from where the updater is.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiJson, type ApiResult } from '@/lib/api'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { Badge, Btn, ConfirmDialog, Notice, Panel, fmtTime } from './ui'

type Channel = 'stable' | 'alpha'
interface Commit { sha: string; text: string; date: string | null }
interface Available {
  channel: Channel; sha: string; ref: string; label: string; version: string | null; date: string | null
  notes: string | null; url: string | null; commits: Commit[]; totalCommits: number
  flags: { breaking: string[]; migrations: string[]; keyholder: boolean; unknownBase: boolean; filesUnknown: boolean }
  signature: { annotated: boolean; signed: boolean | null; verifiedByHost: boolean | null } | null
}
interface Check { checkedAt: string; source: string | null; available: Available | null; note: string; error: string | null }
interface Settings { channel: Channel; checkEveryHours: number; notify: boolean; requireSigned: boolean; autoInstall: boolean; window: { days: number[]; start: string; end: string } }
interface Step { id: string; label: string; status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; detail?: string }
interface Job {
  id: string; status: 'running' | 'succeeded' | 'failed' | 'rolled-back' | 'rollback-failed' | 'interrupted'; by: string
  from: { sha: string; version: string }; target: { sha: string; label: string }; steps: Step[]; log: string[]
  startedAt: string; finishedAt?: string; summary?: string; backupFile?: string; migrationsApplied: boolean; dbRestored: boolean
}
interface Status {
  installed: { version: string; sha: string; describe: string; branch: string | null; git: boolean }
  running: { version: string; commit: string }
  settings: Settings; check: Check | null; job: Job | null
  upstream: { repoUrl: string; mirrorUrl: string | null; trustedKeys: boolean }
}
interface Refusal { code: string; text: string; detail?: string[] }
interface Preview { target: Available | null; refusals: Refusal[]; warnings: string[]; steps: string[]; disk: { freeMiB: number | null; needMiB: number } }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const STEP_MARK: Record<Step['status'], string> = { pending: '○', running: '◐', done: '✓', failed: '✗', skipped: '–' }
const STEP_TONE: Record<Step['status'], string> = { pending: 'var(--text-muted)', running: 'var(--accent)', done: 'var(--good)', failed: 'var(--crit)', skipped: 'var(--text-dimmer)' }
const JOB_TONE: Record<Job['status'], 'accent' | 'good' | 'warn' | 'crit'> = { running: 'accent', succeeded: 'good', failed: 'crit', 'rolled-back': 'warn', 'rollback-failed': 'crit', interrupted: 'crit' }
const JOB_WORD: Record<Job['status'], string> = { running: 'Updating', succeeded: 'Updated', failed: 'Not updated', 'rolled-back': 'Rolled back', 'rollback-failed': 'Rollback failed', interrupted: 'Interrupted' }

export function SelfUpdatePanel() {
  const [st, setSt] = useState<Status | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [away, setAway] = useState(false)          // the API is restarting under a running update
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'warn' | 'crit' | 'info'; text: string } | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [showCommits, setShowCommits] = useState(false)
  const [editing, setEditing] = useState<Settings | null>(null)
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const logRef = useRef<HTMLPreElement>(null)

  const load = useCallback(async () => {
    const r = await apiJson<Status>('/api/self-update/status')
    if (r.ok && r.body) { setSt(r.body); setJob(r.body.job); setErr(null) }
    else setErr(r.status === 403 ? 'Updating HyperProx is limited to admins.' : r.error ?? 'Could not read the HyperProx version.')
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => { if (typeof window !== 'undefined' && window.location.hash === '#hyperprox') document.getElementById('hyperprox')?.scrollIntoView() }, [st === null])

  // While a run is going: poll its state file through the API. A failed poll is the restart, not an error.
  const running = job?.status === 'running'
  useEffect(() => {
    if (!running) return
    let alive = true
    const t = setInterval(async () => {
      const r = await apiJson<{ job: Job | null }>('/api/self-update/job')
      if (!alive) return
      if (r.ok && r.body?.job) {
        setAway(false); setJob(r.body.job)
        if (r.body.job.status !== 'running') load()
      } else setAway(true)
    }, 2000)
    return () => { alive = false; clearInterval(t) }
  }, [running, load])
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }) }, [job?.log.length])

  const askedAgain = (r: ApiResult, retry: () => void) => {
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => retry); return true }
    return false
  }

  const checkNow = async () => {
    setBusy(true); setNotice(null)
    const r = await apiJson<{ check: Check }>('/api/self-update/check', 'POST')
    setBusy(false)
    if (!r.ok) setNotice({ tone: 'warn', text: r.error ?? 'Could not check.' })
    load()
  }
  const openPreview = async () => {
    setBusy(true); setNotice(null)
    const r = await apiJson<Preview>('/api/self-update/preview')
    setBusy(false)
    if (r.ok && r.body) setPreview(r.body); else setNotice({ tone: 'crit', text: r.error ?? 'Could not build the preview.' })
  }
  const install = async () => {
    const sha = preview?.target?.sha
    if (!sha) return
    setBusy(true)
    const r = await apiJson<{ job: Job }>('/api/self-update/install', 'POST', { sha })
    setBusy(false)
    if (askedAgain(r, install)) return
    if (r.ok && r.body?.job) { setPreview(null); setJob(r.body.job); return }
    const refusals: Refusal[] = (r.body as any)?.refusals ?? []
    setNotice({ tone: 'crit', text: refusals.length ? refusals.map(x => x.text).join(' ') : r.error ?? 'The update was not started.' })
    setPreview(null)
  }
  const saveSettings = async () => {
    if (!editing) return
    setBusy(true)
    const r = await apiJson<{ settings: Settings }>('/api/self-update/settings', 'PUT', editing)
    setBusy(false)
    if (askedAgain(r, saveSettings)) return
    if (r.ok) { setEditing(null); setNotice({ tone: 'info', text: 'Self-update settings saved.' }); load() }
    else setNotice({ tone: 'crit', text: r.error ?? 'Could not save.' })
  }

  const av = st?.check?.available ?? null
  const inst = st?.installed
  return (
    <div id="hyperprox">
      <Panel title="HyperProx" right={st && !editing && (
        <div className="flex flex-wrap gap-2">
          <Btn small onClick={() => void checkNow()} disabled={busy || running}>Check now</Btn>
          <Btn small onClick={() => setEditing(structuredClone(st.settings))} disabled={running}>Settings</Btn>
        </div>
      )}>
        {err ? <Notice tone="warn">{err}</Notice> : !st ? <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Reading the version…</p> : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span><span style={{ color: 'var(--text-muted)' }}>Installed </span><b className="font-mono">v{inst!.version}</b></span>
              <span className="font-mono" style={{ color: 'var(--text-muted)' }} title={inst!.sha}>{inst!.describe}</span>
              <Badge tone={st.settings.channel === 'stable' ? 'good' : 'violet'}>{st.settings.channel} channel</Badge>
              {st.settings.autoInstall && <Badge tone="accent" title={`${st.settings.window.days.map(d => DAYS[d]).join(' ')} ${st.settings.window.start}–${st.settings.window.end}`}>auto-install</Badge>}
              {st.settings.requireSigned && <Badge tone="accent">signed releases only</Badge>}
            </div>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              From <span className="font-mono">{st.upstream.repoUrl}</span>{st.upstream.mirrorUrl && <> (mirror <span className="font-mono">{st.upstream.mirrorUrl}</span>)</>}.
              {st.check ? <> Last checked {fmtTime(st.check.checkedAt)}{st.check.source ? ` at ${st.check.source}` : ''}. </> : ' Not checked yet. '}
              {!av && st.check?.note}
            </p>
            {st.check?.error && <Notice tone="warn">{st.check.error}</Notice>}
            {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

            {job && (job.status === 'running' || job.finishedAt) && <JobView job={job} away={away} logRef={logRef} />}

            {av && !running && <Offer av={av} showCommits={showCommits} onCommits={() => setShowCommits(v => !v)} onPreview={() => void openPreview()} busy={busy} />}
            {editing && <SettingsForm s={editing} onChange={setEditing} onSave={() => void saveSettings()} onCancel={() => setEditing(null)} busy={busy} />}
          </div>
        )}
      </Panel>

      {preview && (
        <ConfirmDialog title={preview.target ? `Update HyperProx to ${preview.target.label}?` : 'Update HyperProx'} onClose={() => setPreview(null)}>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm" style={{ color: 'var(--text-soft)' }}>
            {preview.steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
          {preview.warnings.map((w, i) => <Notice key={i} tone="warn">{w}</Notice>)}
          {preview.refusals.map(r => (
            <Notice key={r.code} tone="crit">
              {r.text}
              {r.detail && <pre className="mt-1 max-h-40 overflow-auto font-mono text-xs">{r.detail.join('\n')}</pre>}
            </Notice>
          ))}
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Only HyperProx is updated; nothing else on this machine or cluster is touched. You will be asked for your master password.</p>
          <div className="flex justify-end gap-2">
            <Btn kind="primary" onClick={() => void install()} disabled={busy || preview.refusals.length > 0 || !preview.target}>Install {preview.target?.label ?? ''}</Btn>
            <Btn onClick={() => setPreview(null)}>Cancel</Btn>
          </div>
        </ConfirmDialog>
      )}
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const f = reconfirm; setReconfirm(null); f() }} />}
    </div>
  )
}

function Offer({ av, showCommits, onCommits, onPreview, busy }: { av: Available; showCommits: boolean; onCommits: () => void; onPreview: () => void; busy: boolean }) {
  return (
    <div className="space-y-2 rounded-md border p-3" style={{ borderColor: 'var(--border-soft)' }}>
      <div className="flex flex-wrap items-center gap-2">
        <b>{av.label}</b>
        {av.date && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{fmtTime(av.date)}</span>}
        {av.flags.breaking.length > 0 && <Badge tone="crit">breaking / migration notes</Badge>}
        {av.flags.migrations.length > 0 && <Badge tone="warn" title={av.flags.migrations.join('\n')}>{av.flags.migrations.length} database migration{av.flags.migrations.length === 1 ? '' : 's'}</Badge>}
        {av.flags.keyholder && <Badge tone="warn">locks once: sign in again</Badge>}
        {av.signature?.signed && <Badge tone="good">signed tag</Badge>}
        {av.url && <a href={av.url} target="_blank" rel="noreferrer noopener" className="text-xs underline" style={{ color: 'var(--accent)' }}>release page</a>}
        <span className="ml-auto"><Btn kind="primary" small onClick={onPreview} disabled={busy}>Preview and install</Btn></span>
      </div>
      {av.flags.breaking.length > 0 && <Notice tone="warn"><ul className="list-disc pl-5">{av.flags.breaking.map((b, i) => <li key={i}>{b}</li>)}</ul></Notice>}
      {av.notes && <div className="max-h-64 overflow-auto whitespace-pre-wrap text-sm" style={{ color: 'var(--text-soft)' }}>{av.notes}</div>}
      {av.commits.length > 0 && (
        <div className="text-sm">
          <button type="button" className="underline" style={{ color: 'var(--accent)' }} onClick={onCommits}>
            {showCommits ? 'Hide' : 'Show'} what changed ({av.totalCommits} commit{av.totalCommits === 1 ? '' : 's'}{av.totalCommits > av.commits.length ? `, newest ${av.commits.length} listed` : ''})
          </button>
          {showCommits && <ul className="mt-1 list-disc space-y-0.5 pl-5" style={{ color: 'var(--text-soft)' }}>{av.commits.map(c => <li key={c.sha}>{c.text}</li>)}</ul>}
        </div>
      )}
    </div>
  )
}

function JobView({ job, away, logRef }: { job: Job; away: boolean; logRef: React.RefObject<HTMLPreElement> }) {
  return (
    <div className="space-y-2 rounded-md border p-3" style={{ borderColor: 'var(--border-soft)' }} aria-live="polite">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={JOB_TONE[job.status]}>{JOB_WORD[job.status]}</Badge>
        <span>{job.from.version} ({job.from.sha.slice(0, 7)}) → {job.target.label} ({job.target.sha.slice(0, 7)})</span>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>started {fmtTime(job.startedAt)} by {job.by}</span>
      </div>
      {away && job.status === 'running' && <Notice tone="info">HyperProx is restarting. The update carries on by itself; this page picks up its progress when HyperProx answers again.</Notice>}
      {job.summary && <Notice tone={job.status === 'succeeded' ? 'info' : job.status === 'rolled-back' ? 'warn' : 'crit'}>{job.summary}</Notice>}
      {job.dbRestored && <Notice tone="warn">The database was restored from {job.backupFile ?? 'the backup taken before the update'}: changes made in HyperProx while the update ran are gone.</Notice>}
      <ol className="space-y-1 text-sm">
        {job.steps.filter(s => s.id !== 'rollback' || s.status !== 'skipped' || job.status !== 'succeeded').map(s => (
          <li key={s.id} className="flex gap-2">
            <span className="font-mono" style={{ color: STEP_TONE[s.status], width: 14 }} aria-label={s.status}>{STEP_MARK[s.status]}</span>
            <span style={{ color: s.status === 'pending' || s.status === 'skipped' ? 'var(--text-muted)' : 'var(--text)' }}>
              {s.label}{s.detail && <span className="text-xs" style={{ color: 'var(--text-muted)' }}> — {s.detail}</span>}
            </span>
          </li>
        ))}
      </ol>
      <pre ref={logRef} className="max-h-72 overflow-auto rounded p-2 font-mono text-xs" style={{ background: 'var(--surface-sunken, rgba(0,0,0,.25))', color: 'var(--text-soft)' }}>
        {job.log.slice(-200).join('\n') || 'Waiting for the updater…'}
      </pre>
      {job.status === 'succeeded' && <Btn kind="primary" small onClick={() => window.location.reload()}>Reload to use the new version</Btn>}
    </div>
  )
}

function SettingsForm({ s, onChange, onSave, onCancel, busy }: { s: Settings; onChange: (s: Settings) => void; onSave: () => void; onCancel: () => void; busy: boolean }) {
  const set = (p: Partial<Settings>) => onChange({ ...s, ...p })
  const input = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', color: 'var(--text)' }
  return (
    <div className="space-y-3 rounded-md border p-3 text-sm" style={{ borderColor: 'var(--border-soft)' }}>
      <label className="flex flex-wrap items-center gap-2">Channel
        <select value={s.channel} style={input} onChange={e => set({ channel: e.target.value as Channel, autoInstall: e.target.value === 'stable' ? s.autoInstall : false })}>
          <option value="stable">Stable: published releases</option>
          <option value="alpha">Alpha: every commit on main</option>
        </select>
      </label>
      <label className="flex flex-wrap items-center gap-2">Check every
        <input type="number" min={1} max={168} value={s.checkEveryHours} style={{ ...input, width: 70 }} onChange={e => set({ checkEveryHours: Math.max(1, Math.min(168, Number(e.target.value) || 6)) })} /> hours
      </label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={s.notify} onChange={e => set({ notify: e.target.checked })} /> Send a notification when an update is available</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={s.requireSigned} onChange={e => set({ requireSigned: e.target.checked })} /> Require signed releases (refuse a release whose tag is unsigned or does not verify)</label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={s.autoInstall} disabled={s.channel !== 'stable'} onChange={e => set({ autoInstall: e.target.checked })} />
        Install stable releases automatically, inside the maintenance window{s.channel !== 'stable' && ' (stable channel only)'}
      </label>
      {s.autoInstall && (
        <div className="flex flex-wrap items-center gap-2 pl-6">
          {DAYS.map((d, i) => (
            <label key={d} className="flex items-center gap-1"><input type="checkbox" checked={s.window.days.includes(i)}
              onChange={e => set({ window: { ...s.window, days: e.target.checked ? [...s.window.days, i].sort() : s.window.days.filter(x => x !== i) } })} />{d}</label>
          ))}
          <input type="time" value={s.window.start} style={input} onChange={e => set({ window: { ...s.window, start: e.target.value } })} aria-label="Window starts" />
          to
          <input type="time" value={s.window.end} style={input} onChange={e => set({ window: { ...s.window, end: e.target.value } })} aria-label="Window ends" />
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>server time</span>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Btn kind="primary" small onClick={onSave} disabled={busy}>Save</Btn>
        <Btn small onClick={onCancel}>Cancel</Btn>
      </div>
    </div>
  )
}
