'use client'

// =============================================================================
//  HyperProx — site metrics: the admin's tools on a Metrics tab
//
//  Alert settings, the request-time log format change (preview first: the
//  exact lines, then the master password), forgetting an adopted site, and
//  "Add an existing site" for the Sites page: a list of the websites HyperProx
//  found (proxy hosts and listening containers), one pick to fill the form,
//  and the logging change offered straight after when the log lacks it. Each
//  change is one the API checks again; this page only shows what it was told.
// =============================================================================

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { apiJson } from '@/lib/api'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { styles } from '@/components/visual/kit'
import { StatusIcon, UpState } from './charts'
import type { AlertSettings } from './types'
import s from './metrics.module.css'

// ── alerts ─────────────────────────────────────────────────────────────────

export function AlertSettingsPanel({ siteId, initial }: { siteId: string; initial: AlertSettings }) {
  const [v, setV] = useState(initial)
  const [msg, setMsg] = useState('')
  const save = async () => {
    const r = await apiJson<{ data: { alerts: AlertSettings } }>(`/api/site-metrics/sites/${encodeURIComponent(siteId)}/alerts`, 'PUT', v)
    setMsg(r.ok ? 'Saved.' : r.error ?? 'Could not save.')
    if (r.ok && r.body) setV(r.body.data.alerts)
  }
  const num = (k: keyof AlertSettings, label: string, hint: string, step = 1) => (
    <label className={styles.field}><span>{label}</span>
      <input className={styles.input} type="number" min={0} step={step} value={Number(v[k])} onChange={e => setV({ ...v, [k]: Number(e.target.value) })} aria-describedby={`al-${k}`} />
      <small id={`al-${k}`} className={s.note}>{hint}</small>
    </label>
  )
  return (
    <section className={s.panel} aria-label="Alert settings">
      <h3>Alerts <small>SENT THROUGH SETTINGS → NOTIFICATIONS (RESOURCES)</small></h3>
      <div className={s.form}>
        <label className={styles.row} style={{ gap: 8 }}><input type="checkbox" checked={v.enabled} onChange={e => setV({ ...v, enabled: e.target.checked })} /> Send alerts for this site</label>
        {num('downChecks', 'Down after failed checks in a row', 'Checks run every 5 minutes. 0 turns this off.')}
        {num('errorRatePct', 'Server errors above (%)', '5xx share of the last hour\'s requests, once there are at least 20.', 0.5)}
        {num('certDays', 'Certificate days left below', 'Read from the public address every 6 hours.')}
        {num('spikeFactor', 'Traffic spike at (× usual)', 'Against the average hour of the week before, from 100 requests. 0 turns this off.')}
        <div className={styles.row} style={{ gap: 8 }}><button type="button" className={`${styles.btn} ${styles.btnPri}`} onClick={() => void save()}>Save alerts</button>{msg && <span className={s.note}>{msg}</span>}</div>
      </div>
    </section>
  )
}

// ── the request-time log format ────────────────────────────────────────────

interface Plan {
  edits: Array<{ file: string; line: number; before: string; after: string }>
  insert: { file: string; afterLine: number; text: string } | null
  includeFile: { path: string; content: string } | null
  skipped: Array<{ file: string; line: number; text: string; why: string }>
  refusal?: string; already?: boolean
}

export function LogFormatDialog({ siteId, onClose }: { siteId: string; onClose: () => void }) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [planId, setPlanId] = useState<string | null>(null)
  const [msg, setMsg] = useState('Reading nginx\'s configuration…')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void apiJson<{ data: { planId: string | null; plan: Plan } }>(`/api/site-metrics/sites/${encodeURIComponent(siteId)}/log-format/preview`, 'POST', {}).then(r => {
      if (!r.ok || !r.body) { setMsg(r.error ?? 'Could not read the configuration.'); return }
      setPlan(r.body.data.plan); setPlanId(r.body.data.planId); setMsg('')
    })
  }, [siteId])
  const apply = async () => {
    setBusy(true)
    const r = await apiJson<{ data: { message: string; backups: string[] } }>(`/api/site-metrics/sites/${encodeURIComponent(siteId)}/log-format/apply`, 'POST', { planId })
    setBusy(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setConfirm(true); return }
    setMsg(r.ok && r.body ? `${r.body.data.message} Backups: ${r.body.data.backups.join(', ')}` : r.error ?? 'The change failed.')
    if (r.ok) setPlanId(null)
  }
  return (
    <div className={s.dialog} role="dialog" aria-modal="true" aria-label="Add the request time to the access log">
      <div>
        <h2>Add response times</h2>
        <p className={s.note}>HyperProx will change only the lines below, back up each file beside itself, run <code>nginx -t</code>, and reload nginx only if the test passes. If it fails, every file is put back.</p>
        {plan?.refusal && <p className={styles.callout}>{plan.refusal}</p>}
        {plan && !plan.refusal && (
          <>
            {plan.includeFile && <><strong>New file {plan.includeFile.path}</strong><pre className={s.diff}><ins>{plan.includeFile.content}</ins></pre></>}
            {plan.insert && <><strong>{plan.insert.file}, after line {plan.insert.afterLine}</strong><pre className={s.diff}><ins>+ {plan.insert.text.trim()}</ins></pre></>}
            {plan.edits.map(e => (
              <div key={`${e.file}:${e.line}`}><strong>{e.file}, line {e.line}</strong>
                <pre className={s.diff}><del>- {e.before.trim()}</del><ins>+ {e.after.trim()}</ins></pre></div>
            ))}
            {plan.skipped.map(k => <p key={`${k.file}:${k.line}`} className={s.note}>Left alone: {k.file} line {k.line} ({k.text}): {k.why}.</p>)}
          </>
        )}
        {msg && <p className={s.note} role="status">{msg}</p>}
        <div className={styles.row} style={{ gap: 8, flexWrap: 'wrap' }}>
          {planId && <button type="button" className={`${styles.btn} ${styles.btnPri}`} disabled={busy} onClick={() => void apply()}>{busy ? 'Changing…' : 'Make this change'}</button>}
          <button type="button" className={styles.btn} onClick={onClose}>Close</button>
        </div>
      </div>
      {confirm && <ReconfirmModal onClose={() => setConfirm(false)} onDone={() => { setConfirm(false); void apply() }} />}
    </div>
  )
}

// ── adopt ──────────────────────────────────────────────────────────────────

interface Guest { vmid: number; name: string; node: string; status: string }
interface CheckResult {
  ok: boolean; errors: string[]; warnings?: string[]
  facts?: { nginx?: boolean; litespeed?: boolean; behindProxyWithoutForwardedFor?: boolean; sample: { lines: number; formats: Record<string, number> } }
}
/** One website HyperProx found (GET /api/site-metrics/adopt/candidates). Paths and facts only, never config text. */
export interface Candidate {
  id: string; domains: string[]; url: string | null; source: 'proxy' | 'listener'
  proxy: { instances: Array<{ instanceName: string; kind: string }>; tls: boolean; forward: { scheme: string; host: string; port: number } } | null
  guest: { vmid: number; name: string; node: string; type: 'lxc' | 'qemu'; status: string } | null
  notAGuest: string | null
  server: 'nginx' | 'apache' | 'caddy' | 'litespeed' | null
  kind: 'static' | 'wordpress' | 'other' | null
  logPath: string | null
  logFormat: { name: string; requestTime: boolean | null; forwardedFor: boolean | null } | null
  wpPath: string | null
  /** LiteSpeed: the site's own error log, and the lsphp WP-CLI runs with. */
  errorLog?: string | null; phpBin?: string | null
  /** Behind the proxy the log holds only the proxy's address. */
  visitorsApproximate?: boolean
  alreadyASite: boolean; alreadyAdopted: boolean; siteId: string | null
  up: boolean | null; adoptable: boolean; whyNot: string | null; notes: string[]
}
interface Found {
  candidates: Candidate[]; errors: string[]; builtAt: number
  listenerScan: { state: 'done' | 'partial' | 'skipped'; looked: number; of: number; note?: string }
  defaults: { logPath: string; wpPath: string }
}

const KIND_LABEL: Record<string, string> = { static: 'Static', wordpress: 'WordPress', other: 'Other' }
const SERVER_LABEL: Record<string, string> = { litespeed: 'LiteSpeed' }
const serverLabel = (v: string) => SERVER_LABEL[v] ?? v
/** LiteSpeed's server-wide log: every site on the server writes it. */
const sharedLog = (p: string | null | undefined) => !!p && p.startsWith('/usr/local/lsws/logs/')
const BLANK = { vmid: '', url: '', logPath: '/var/log/nginx/access.log', kind: 'static', wpPath: '/var/www/wordpress', name: '', errorLog: '', phpBin: '' }

/** The log lacks what the request-time change adds: the time, or (behind a proxy) the visitor's address. */
function needsLogChange(c: Candidate | null, check: CheckResult | null): boolean {
  if (check?.facts && (check.facts.nginx === false || check.facts.litespeed)) return false
  if (c && c.server !== 'nginx') return false
  const f = c?.logFormat
  if (f && (f.requestTime === false || (c?.proxy && f.forwardedFor === false))) return true
  const smp = check?.facts?.sample
  return !!(check?.facts?.behindProxyWithoutForwardedFor || (smp && smp.lines > 0 && !smp.formats.extended))
}

/** What the log lacks, in words, for the offer after adding. */
function logLacks(c: Candidate | null, check: CheckResult | null): { text: string } {
  const f = c?.logFormat
  const noTime = f ? f.requestTime === false : !!check?.facts?.sample && !check.facts.sample.formats.extended
  const noAddr = f ? !!c?.proxy && f.forwardedFor === false : !!check?.facts?.behindProxyWithoutForwardedFor
  const what = [noTime && 'how long each request took', noAddr && 'the visitor\'s address behind the proxy'].filter(Boolean).join(' or ')
  const effect = [noTime && 'response times stay empty', noAddr && 'every visitor counts as the proxy'].filter(Boolean).join(' and ')
  return { text: what ? `The log does not record ${what}, so ${effect} until nginx's log format includes ${noTime && noAddr ? 'them' : 'it'}.` : '' }
}

function CandidateTile({ c, onPick }: { c: Candidate; onPick: (c: Candidate) => void }) {
  const title = c.domains[0] ?? (c.guest ? `CT ${c.guest.vmid}` : c.url ?? 'Unnamed')
  const more = c.domains.length > 1 ? ` +${c.domains.length - 1}` : ''
  const body = (
    <>
      <div className={s.siteHead}>
        <b title={c.domains.join(', ')}>{title}{more && <small className={s.more}>{more}</small>}</b>
        {c.kind && <span className={s.kind}>{KIND_LABEL[c.kind] ?? c.kind}</span>}
        <UpState up={c.up} />
      </div>
      <div className={s.chips2}>
        {c.guest
          ? <span className={s.gchip}>{c.guest.type === 'lxc' ? 'CT' : 'VM'} {c.guest.vmid} · {c.guest.name || 'unnamed'} · {c.guest.node}</span>
          : <span className={s.gchip} data-tone="off">Not a guest: {c.notAGuest}</span>}
        {c.server && <span className={s.gchip}>{serverLabel(c.server)}</span>}
        {c.visitorsApproximate && <span className={s.gchip} data-tone="off" title="The log holds only the proxy's address">visitors approximate</span>}
        {c.source === 'listener' && <span className={s.gchip}>no proxy host</span>}
      </div>
      {c.logPath && <small className={s.path}>{c.logPath}{sharedLog(c.logPath) ? ' (shared: includes every site on this server)' : ''}</small>}
      {c.alreadyASite
        ? <span className={s.added}><StatusIcon tone="good" />{c.alreadyAdopted ? 'Already added' : 'Already a site'}</span>
        : !c.adoptable && c.whyNot && <small className={s.note}>{c.whyNot}</small>}
    </>
  )
  if (c.alreadyASite && c.siteId) return <Link className={s.cand} href={`/sites/${encodeURIComponent(c.siteId)}`} aria-label={`${title}: already added, open its metrics`}>{body}</Link>
  return (
    <button type="button" className={s.cand} disabled={!c.adoptable} onClick={() => onPick(c)}
      aria-label={c.adoptable ? `Add ${title}` : `${title}: ${c.whyNot ?? 'cannot be added'}`}>{body}</button>
  )
}

/** "Add an existing site": a dialog, or with `inline` the Websites section's Add existing tab. */
export function AdoptSiteDialog({ onClose, onDone, inline = false }: { onClose: () => void; onDone: (id: string) => void; inline?: boolean }) {
  const shell = inline ? { className: s.inline, role: 'region' as const } : { className: s.dialog, role: 'dialog' as const, 'aria-modal': true as const }
  const [mode, setMode] = useState<'list' | 'form'>('list')
  const [found, setFound] = useState<Found | null>(null)
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [listMsg, setListMsg] = useState('')
  const [picked, setPicked] = useState<Candidate | null>(null)
  const [editing, setEditing] = useState(false)
  const [guests, setGuests] = useState<Guest[] | null>(null)
  const [form, setForm] = useState(BLANK)
  const [check, setCheck] = useState<CheckResult | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [added, setAdded] = useState<string | null>(null)
  const [logDialog, setLogDialog] = useState(false)

  const loadList = async (refresh = false) => {
    setListState('loading'); setListMsg('')
    const r = await apiJson<{ data: Found }>(`/api/site-metrics/adopt/candidates${refresh ? '?refresh=1' : ''}`)
    if (r.ok && r.body) { setFound(r.body.data); setListState('ready') } else { setListMsg(r.error ?? 'Could not look for websites.'); setListState('error') }
  }
  useEffect(() => { void loadList() }, [])
  useEffect(() => {
    if (mode !== 'form' || !editing || guests) return
    void apiJson<{ data: { guests: Guest[] } }>('/api/site-metrics/adopt/guests').then(r => {
      if (r.ok && r.body) setGuests(r.body.data.guests); else setMsg(r.error ?? 'Could not list the containers.')
    })
  }, [mode, editing, guests])

  const body = (f = form) => ({
    ...f, vmid: Number(f.vmid), wpPath: f.kind === 'wordpress' ? f.wpPath : undefined,
    errorLog: f.errorLog || undefined, phpBin: f.kind === 'wordpress' && f.phpBin ? f.phpBin : undefined,
  })
  const runCheck = async (f = form) => {
    setBusy(true); setMsg('')
    const r = await apiJson<{ data: CheckResult }>('/api/site-metrics/adopt/check', 'POST', body(f))
    setBusy(false)
    if (r.ok && r.body) setCheck(r.body.data); else setMsg(r.error ?? 'The check failed.')
  }
  const pick = (c: Candidate) => {
    const f = {
      vmid: String(c.guest?.vmid ?? ''), url: c.url ?? '', logPath: c.logPath ?? found?.defaults.logPath ?? BLANK.logPath,
      kind: c.kind ?? 'other', wpPath: c.wpPath ?? found?.defaults.wpPath ?? BLANK.wpPath, name: '',
      errorLog: c.errorLog ?? '', phpBin: c.phpBin ?? '',
    }
    setPicked(c); setForm(f); setEditing(false); setCheck(null); setMsg(''); setMode('form')
    void runCheck(f)
  }
  const manual = () => { setPicked(null); setForm(BLANK); setEditing(true); setCheck(null); setMsg(''); setMode('form') }
  const backToList = () => { setMode('list'); setPicked(null); setCheck(null); setMsg('') }
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => { setForm({ ...form, [k]: e.target.value }); setCheck(null) }
  const adopt = async () => {
    setBusy(true)
    const r = await apiJson<{ data: { id: string } }>('/api/site-metrics/adopt', 'POST', body())
    setBusy(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setConfirm(true); return }
    if (!r.ok || !r.body) { setMsg(r.error ?? 'Could not add the site.'); return }
    if (needsLogChange(picked, check)) setAdded(r.body.data.id); else onDone(r.body.data.id)
  }

  if (added) {
    const lacks = logLacks(picked, check)
    return (
      <div {...shell} aria-label="Site added">
        <div>
          <h2>Site added</h2>
          <p className={s.note}>HyperProx reads its access log every 5 minutes from now on. {lacks.text}</p>
          <p className={s.note}>HyperProx can make that change: it shows the exact lines first, backs up each file and reloads nginx only if <code>nginx -t</code> passes.</p>
          <div className={styles.row} style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className={`${styles.btn} ${styles.btnPri}`} onClick={() => setLogDialog(true)}>Show the logging change</button>
            <button type="button" className={styles.btn} onClick={() => onDone(added)}>Not now</button>
          </div>
        </div>
        {logDialog && <LogFormatDialog siteId={added} onClose={() => { setLogDialog(false); onDone(added) }} />}
      </div>
    )
  }

  const scan = found?.listenerScan
  return (
    <div {...shell} aria-label="Add an existing site">
      <div>
        <h2>Add an existing site</h2>
        <p className={s.note}>For a website you built yourself in a container, including one served by LiteSpeed or CyberPanel. HyperProx only reads from it: its access log every 5 minutes, its public address, and for WordPress, WP-CLI. Nothing is installed or changed.</p>

        {mode === 'list' && (
          <>
            <div className={styles.row} style={{ justifyContent: 'space-between' }}>
              <strong className={s.listHead}>{listState === 'ready' ? `${found!.candidates.length} found` : 'Websites HyperProx can see'}</strong>
              <button type="button" className={styles.btn} disabled={listState === 'loading'} onClick={() => void loadList(true)}>{listState === 'loading' ? 'Looking…' : 'Refresh'}</button>
            </div>
            {listState === 'loading' && <p className={s.note} role="status">Reading the proxy hosts and looking inside each container. This can take up to half a minute.</p>}
            {listState === 'error' && <p className={styles.callout} role="alert">{listMsg}</p>}
            {listState === 'ready' && !found!.candidates.length && (
              <p className={styles.callout}>No websites were found: no proxy host forwards to a container, and no container without one listens on port 80 or 443.</p>
            )}
            {listState === 'ready' && found!.candidates.length > 0 && (
              <div className={s.cands} role="list" aria-label="Websites found">
                {found!.candidates.map(c => <div role="listitem" key={c.id}><CandidateTile c={c} onPick={pick} /></div>)}
              </div>
            )}
            {listState === 'ready' && (found!.errors.length > 0 || scan?.note) && (
              <ul className={s.errs}>
                {found!.errors.map(e => <li key={e}>{e}</li>)}
                {scan?.note && <li>{scan.note}</li>}
              </ul>
            )}
            <div className={styles.row} style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'space-between' }}>
              <button type="button" className={s.linkBtn} onClick={manual}>Enter manually</button>
              <button type="button" className={styles.btn} onClick={onClose}>Cancel</button>
            </div>
          </>
        )}

        {mode === 'form' && (
          <>
            {picked && !editing && (
              <dl className={s.sum}>
                <div><dt>Container</dt><dd>CT {form.vmid}{picked.guest ? ` · ${picked.guest.name} · ${picked.guest.node}` : ''}</dd></div>
                <div><dt>Public address</dt><dd>{form.url || '—'}</dd></div>
                <div><dt>Kind</dt><dd>{KIND_LABEL[form.kind] ?? form.kind}{picked.server ? ` · ${serverLabel(picked.server)}` : ''}</dd></div>
                <div><dt>Access log</dt><dd>{form.logPath}{picked.logFormat ? ` (${picked.logFormat.name})` : ''}{sharedLog(form.logPath) ? ' · shared: includes every site on this server' : ''}</dd></div>
                {form.kind === 'wordpress' && <div><dt>WordPress folder</dt><dd>{form.wpPath}</dd></div>}
                {form.kind === 'wordpress' && form.phpBin && <div><dt>PHP for WP-CLI</dt><dd>{form.phpBin}</dd></div>}
                {form.errorLog && <div><dt>Error log</dt><dd>{form.errorLog}</dd></div>}
              </dl>
            )}
            {picked && picked.notes.length > 0 && !editing && <ul className={s.errs}>{picked.notes.map(n => <li key={n}>{n}</li>)}</ul>}
            {editing && (
              <div className={s.form}>
                <label className={styles.field}><span>Container</span>
                  <select className={styles.input} value={form.vmid} onChange={set('vmid')}>
                    <option value="">{guests ? 'Pick a container…' : 'Loading the containers…'}</option>
                    {form.vmid && !(guests ?? []).some(g => String(g.vmid) === form.vmid) && <option value={form.vmid}>CT {form.vmid}</option>}
                    {(guests ?? []).map(g => <option key={g.vmid} value={g.vmid} disabled={g.status !== 'running'}>CT {g.vmid} · {g.name || 'unnamed'} · {g.node}{g.status !== 'running' ? ` (${g.status})` : ''}</option>)}
                  </select></label>
                <label className={styles.field}><span>Public address</span><input className={styles.input} value={form.url} onChange={set('url')} placeholder="https://www.example.com" inputMode="url" /></label>
                <label className={styles.field}><span>Kind</span>
                  <select className={styles.input} value={form.kind} onChange={set('kind')}><option value="static">Static site</option><option value="wordpress">WordPress</option><option value="other">Other</option></select></label>
                <label className={styles.field}><span>Access log</span><input className={styles.input} value={form.logPath} onChange={set('logPath')} /><small className={s.note}>Under /var/log (nginx&apos;s default is /var/log/nginx/access.log), or LiteSpeed&apos;s /usr/local/lsws/logs and CyberPanel&apos;s /home/&lt;site&gt;/logs/&lt;site&gt;.access_log.</small></label>
                {form.kind === 'wordpress' && <label className={styles.field}><span>WordPress folder</span><input className={styles.input} value={form.wpPath} onChange={set('wpPath')} /></label>}
                <label className={styles.field}><span>Name (optional)</span><input className={styles.input} value={form.name} onChange={set('name')} maxLength={80} /></label>
              </div>
            )}
            {check && (
              <div className={styles.callout} role="status">
                {check.errors.map(e => <p key={e} style={{ margin: 0, color: 'var(--crit)' }}>✕ {e}</p>)}
                {check.ok && <p style={{ margin: 0 }}>✓ The log can be read{check.facts?.sample.lines ? ` (its last lines are ${Object.keys(check.facts.sample.formats).join(', ') || 'unknown'} format)` : ' (it is empty so far)'}.</p>}
                {(check.warnings ?? []).map(w => <p key={w} style={{ margin: 0 }}>! {w}</p>)}
              </div>
            )}
            {busy && !check && <p className={s.note} role="status">Checking inside the container…</p>}
            {msg && <p className={s.note} role="status">{msg}</p>}
            <div className={styles.row} style={{ gap: 8, flexWrap: 'wrap' }}>
              {(editing || !check) && <button type="button" className={styles.btn} disabled={busy || !form.vmid} onClick={() => void runCheck()}>{busy && !check ? 'Checking…' : 'Check'}</button>}
              <button type="button" className={`${styles.btn} ${styles.btnPri}`} disabled={busy || !check?.ok} onClick={() => void adopt()}>Add site</button>
              {picked && <button type="button" className={styles.btn} aria-pressed={editing} onClick={() => setEditing(!editing)}>{editing ? 'Done editing' : 'Edit'}</button>}
              <button type="button" className={styles.btn} onClick={backToList}>Back to the list</button>
              <button type="button" className={styles.btn} onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
      </div>
      {confirm && <ReconfirmModal onClose={() => setConfirm(false)} onDone={() => { setConfirm(false); void adopt() }} />}
    </div>
  )
}

export function ForgetSiteButton({ siteId, onDone }: { siteId: string; onDone: () => void }) {
  const [confirm, setConfirm] = useState(false)
  const [msg, setMsg] = useState('')
  const forget = async () => {
    if (!window.confirm('Forget this site and its numbers? The container itself is not touched.')) return
    const r = await apiJson(`/api/site-metrics/adopt/${encodeURIComponent(siteId)}`, 'DELETE')
    if (r.status === 403 && r.code === 'reconfirm_required') { setConfirm(true); return }
    if (r.ok) onDone(); else setMsg(r.error ?? 'Could not forget it.')
  }
  return (
    <>
      <button type="button" className={styles.btn} onClick={() => void forget()}>Forget site</button>
      {msg && <span className={s.note}>{msg}</span>}
      {confirm && <ReconfirmModal onClose={() => setConfirm(false)} onDone={() => { setConfirm(false); void forget() }} />}
    </>
  )
}
