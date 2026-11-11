'use client'

// =============================================================================
//  HyperProx — site metrics: the admin's tools on a Metrics tab
//
//  Alert settings, the request-time log format change (preview first: the
//  exact lines, then the master password), forgetting an adopted site, and
//  "Add an existing site" for the Sites page. Each change is one the API
//  checks again; this page only shows what it was told.
// =============================================================================

import { useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { styles } from '@/components/visual/kit'
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
interface CheckResult { ok: boolean; errors: string[]; warnings?: string[]; facts?: { sample: { lines: number; formats: Record<string, number> } } }

export function AdoptSiteDialog({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const [guests, setGuests] = useState<Guest[]>([])
  const [form, setForm] = useState({ vmid: '', url: '', logPath: '/var/log/nginx/access.log', kind: 'static', wpPath: '/var/www/wordpress', name: '' })
  const [check, setCheck] = useState<CheckResult | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    void apiJson<{ data: { guests: Guest[]; defaults: { logPath: string; wpPath: string } } }>('/api/site-metrics/adopt/guests').then(r => {
      if (r.ok && r.body) setGuests(r.body.data.guests); else setMsg(r.error ?? 'Could not list the containers.')
    })
  }, [])
  const body = () => ({ ...form, vmid: Number(form.vmid), wpPath: form.kind === 'wordpress' ? form.wpPath : undefined })
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => { setForm({ ...form, [k]: e.target.value }); setCheck(null) }
  const runCheck = async () => {
    setBusy(true); setMsg('')
    const r = await apiJson<{ data: CheckResult }>('/api/site-metrics/adopt/check', 'POST', body())
    setBusy(false)
    if (r.ok && r.body) setCheck(r.body.data); else setMsg(r.error ?? 'The check failed.')
  }
  const adopt = async () => {
    setBusy(true)
    const r = await apiJson<{ data: { id: string } }>('/api/site-metrics/adopt', 'POST', body())
    setBusy(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setConfirm(true); return }
    if (r.ok && r.body) onDone(r.body.data.id); else setMsg(r.error ?? 'Could not add the site.')
  }
  return (
    <div className={s.dialog} role="dialog" aria-modal="true" aria-label="Add an existing site">
      <div>
        <h2>Add an existing site</h2>
        <p className={s.note}>For a website you built yourself in a container. HyperProx only reads from it: its access log every 5 minutes, its public address, and for WordPress, WP-CLI. Nothing is installed or changed.</p>
        <div className={s.form}>
          <label className={styles.field}><span>Container</span>
            <select className={styles.input} value={form.vmid} onChange={set('vmid')}>
              <option value="">Pick a container…</option>
              {guests.map(g => <option key={g.vmid} value={g.vmid} disabled={g.status !== 'running'}>CT {g.vmid} · {g.name || 'unnamed'} · {g.node}{g.status !== 'running' ? ` (${g.status})` : ''}</option>)}
            </select></label>
          <label className={styles.field}><span>Public address</span><input className={styles.input} value={form.url} onChange={set('url')} placeholder="https://www.example.com" inputMode="url" /></label>
          <label className={styles.field}><span>Kind</span>
            <select className={styles.input} value={form.kind} onChange={set('kind')}><option value="static">Static site</option><option value="wordpress">WordPress</option><option value="other">Other</option></select></label>
          <label className={styles.field}><span>Access log</span><input className={styles.input} value={form.logPath} onChange={set('logPath')} /><small className={s.note}>Under /var/log. nginx&apos;s default is /var/log/nginx/access.log.</small></label>
          {form.kind === 'wordpress' && <label className={styles.field}><span>WordPress folder</span><input className={styles.input} value={form.wpPath} onChange={set('wpPath')} /></label>}
          <label className={styles.field}><span>Name (optional)</span><input className={styles.input} value={form.name} onChange={set('name')} maxLength={80} /></label>
        </div>
        {check && (
          <div className={styles.callout} role="status">
            {check.errors.map(e => <p key={e} style={{ margin: 0, color: 'var(--crit)' }}>✕ {e}</p>)}
            {check.ok && <p style={{ margin: 0 }}>✓ The log can be read{check.facts?.sample.lines ? ` (its last lines are ${Object.keys(check.facts.sample.formats).join(', ') || 'unknown'} format)` : ' (it is empty so far)'}.</p>}
            {(check.warnings ?? []).map(w => <p key={w} style={{ margin: 0 }}>! {w}</p>)}
          </div>
        )}
        {msg && <p className={s.note} role="status">{msg}</p>}
        <div className={styles.row} style={{ gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className={styles.btn} disabled={busy || !form.vmid} onClick={() => void runCheck()}>{busy && !check ? 'Checking…' : 'Check'}</button>
          <button type="button" className={`${styles.btn} ${styles.btnPri}`} disabled={busy || !check?.ok} onClick={() => void adopt()}>Add site</button>
          <button type="button" className={styles.btn} onClick={onClose}>Cancel</button>
        </div>
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
