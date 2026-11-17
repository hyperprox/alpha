'use client'

// =============================================================================
//  HyperProx — Nextcloud: each instance, visual first
//
//  Phone first: one column of panels. The HUD (a health ring, the version, the
//  counts), the version track with its update, every setup warning as a card
//  grouped by severity with its own action, Talk (signalling server and Client
//  Push), the system and background jobs, and the log.
//
//  Actions (admin): a one-click fix opens a confirm that says exactly what
//  changes; a guided step opens its form or its steps; long work runs in the
//  background with its steps and output shown live. The update opens its check
//  first (who is online, where the dump goes, the rollback), which is its
//  confirmation, as with the other secure actions.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { IN_PAGE } from '@/lib/confirm-bus'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { BusyNote, CopyButton, GhostButton, INPUT, LABEL, Modal, Notice, PrimaryButton } from '@/components/vault/ui'
import { HudHeader, Icon, Panel, Pill, styles as vs } from '@/components/visual/kit'
import { PluginSwitcher } from '@/components/plugins/visual/plugin-kit'
import { AutoConnectPanel, AutoConnectedNote } from '@/components/plugins/AutoConnect'
import { RemovedGuestsNotice } from '@/components/removed-guests/RemovedGuestsNotice'
import n from './nextcloud.module.css'
import { CheckGroups, JobView, LogView, Steps, SystemView, TalkView, UpdateCheckView, VersionTrack } from './parts'
import {
  ago, cronSnippet, healthScore, hourWords, manualUpdateSteps, pushComposeSnippet, pushNginxSnippet, regionOptions, stopWatchingWords, twoFactorWords, verdictOf,
  type ActionId, type Check, type Job, type Reading, type TwoFactorView, type UpdatePreview,
} from './logic'

const API = '/api/plugins/nextcloud'

interface Instance {
  id: string; name: string; guest?: { kind: 'lxc' | 'qemu'; vmid: number }; url?: string | null; user?: string | null; hasAppPassword: boolean; deployment?: { kind: string } | null
  /** Connected by HyperProx itself (auto-connect), and how its web login was made. */
  autoConnected?: { at: string; evidence: string[]; webLogin: string | null } | null
  appPasswordMadeByHyperProx?: boolean
}

/** POST an action. Each is confirmed in this page's own dialog first, so the API's confirmation step needs no second one. */
async function post<T>(path: string, body: unknown): Promise<{ ok: boolean; data?: T; error?: string; body?: any } | null> {
  const r = await apiJson<{ data: T }>(path, 'POST', body, IN_PAGE)
  return r.ok ? { ok: true, data: r.body!.data } : { ok: false, error: r.error ?? 'That did not work.', body: r.body }
}

// ── confirm a one-click fix ──────────────────────────────────────────────────

function FixModal({ c, r, onClose, onRun }: { c: Check; r: Reading; onClose: () => void; onRun: (action: ActionId, body: Record<string, unknown>, secure: boolean) => void }) {
  const rem = c.remedy
  const [hour, setHour] = useState(Number((rem.kind === 'fix' && rem.params?.hour) ?? r.suggest.windowHour))
  const [region, setRegion] = useState(String((rem.kind === 'fix' && rem.params?.region) || r.suggest.region || ''))
  const [sid, setSid] = useState(String((rem.kind === 'fix' && rem.params?.id) ?? r.suggest.serverId))
  if (rem.kind !== 'fix') return null
  const body: Record<string, unknown> = rem.action === 'maintenance-window' ? { hour } : rem.action === 'phone-region' ? { region } : rem.action === 'server-id' ? { id: Number(sid) } : {}
  const ready = rem.action !== 'phone-region' || !!region
  return (
    <Modal title={rem.label} onClose={onClose} footer={
      <div className="flex flex-wrap justify-end gap-2">
        <GhostButton type="button" onClick={onClose}>Cancel</GhostButton>
        <PrimaryButton type="button" disabled={!ready} onClick={() => onRun(rem.action, body, rem.secure)}>{rem.long ? 'Start' : 'Do it'}</PrimaryButton>
      </div>}>
      <div className={n.form}>
        <p className="text-sm" style={{ color: 'var(--text-soft)' }}>{rem.confirm}</p>
        {rem.action === 'maintenance-window' && (
          <label><span style={LABEL}>Start hour (UTC)</span>
            <select style={INPUT} value={hour} onChange={e => setHour(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourWords(h, Intl.DateTimeFormat().resolvedOptions().timeZone)}</option>)}
            </select>
            <small style={{ color: 'var(--text-muted)' }}>{r.suggest.windowWhy}</small></label>
        )}
        {rem.action === 'phone-region' && (
          <label><span style={LABEL}>Country</span>
            <select style={INPUT} value={region} onChange={e => setRegion(e.target.value)}>
              {!region && <option value="">Pick one…</option>}
              {regionOptions(r.suggest.region).map(o => <option key={o.code} value={o.code}>{o.name} ({o.code})</option>)}
            </select>
            <small style={{ color: 'var(--text-muted)' }}>{r.suggest.regionWhy}</small></label>
        )}
        {rem.action === 'server-id' && (
          <label><span style={LABEL}>Server id (0 to 1023)</span>
            <input style={INPUT} inputMode="numeric" value={sid} onChange={e => setSid(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))} /></label>
        )}
        {rem.long && <Notice kind="info">It runs in the background; this page shows its steps and output as it goes. Leaving the page does not stop it.</Notice>}
      </div>
    </Modal>
  )
}

// ── guided steps ─────────────────────────────────────────────────────────────

function SmtpForm({ r, onRun, onClose }: { r: Reading; onRun: (body: Record<string, unknown>) => void; onClose: () => void }) {
  const m = r.config.mail
  const [f, setF] = useState({ mode: m.mode === 'sendmail' ? 'sendmail' : 'smtp', host: m.host ?? '', port: m.port ?? '587', secure: m.secure === 'ssl' ? 'ssl' : 'starttls', auth: true, user: '', password: '', fromUser: m.from ?? 'cloud', domain: m.domain ?? '' })
  const set = (k: keyof typeof f, v: any) => setF(x => ({ ...x, [k]: v }))
  return (
    <div className={n.form}>
      <p className="text-sm" style={{ color: 'var(--text-soft)' }}>The password is kept in HyperProx&apos;s vault and handed to Nextcloud on its standard input, never on a command line or in a log. Afterwards, send a test mail from Nextcloud (Administration → Basic settings → Send email): that clears the warning.</p>
      <div className={n.grid2}>
        <label><span style={LABEL}>Send with</span><select style={INPUT} value={f.mode} onChange={e => set('mode', e.target.value)}><option value="smtp">An SMTP server</option><option value="sendmail">sendmail in the container</option></select></label>
        {f.mode === 'smtp' && <label><span style={LABEL}>Encryption</span><select style={INPUT} value={f.secure} onChange={e => { set('secure', e.target.value); set('port', e.target.value === 'ssl' ? '465' : '587') }}><option value="starttls">STARTTLS (port 587)</option><option value="ssl">SSL/TLS (port 465)</option><option value="none">None (port 25, local relay only)</option></select></label>}
      </div>
      {f.mode === 'smtp' && (
        <>
          <div className={n.grid2}>
            <label><span style={LABEL}>Server</span><input style={INPUT} autoCapitalize="none" value={f.host} onChange={e => set('host', e.target.value)} placeholder="smtp.example.com" /></label>
            <label><span style={LABEL}>Port</span><input style={INPUT} inputMode="numeric" value={f.port} onChange={e => set('port', e.target.value.replace(/[^0-9]/g, ''))} /></label>
          </div>
          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text)' }}><input type="checkbox" checked={f.auth} onChange={e => set('auth', e.target.checked)} /> The server needs a login</label>
          {f.auth && <div className={n.grid2}>
            <label><span style={LABEL}>Login</span><input style={INPUT} autoCapitalize="none" autoComplete="off" value={f.user} onChange={e => set('user', e.target.value)} placeholder="cloud@example.com" /></label>
            <label><span style={LABEL}>Password (blank keeps the saved one)</span><input style={INPUT} type="password" autoComplete="new-password" value={f.password} onChange={e => set('password', e.target.value)} /></label>
          </div>}
        </>
      )}
      <div className={n.grid2}>
        <label><span style={LABEL}>Sender (before the @)</span><input style={INPUT} autoCapitalize="none" value={f.fromUser} onChange={e => set('fromUser', e.target.value)} placeholder="cloud" /></label>
        <label><span style={LABEL}>Sender domain</span><input style={INPUT} autoCapitalize="none" value={f.domain} onChange={e => set('domain', e.target.value)} placeholder="example.com" /></label>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <GhostButton type="button" onClick={onClose}>Cancel</GhostButton>
        <PrimaryButton type="button" disabled={!f.fromUser || !f.domain || (f.mode === 'smtp' && (!f.host || !f.port || (f.auth && !f.user)))}
          onClick={() => onRun({ ...f, port: Number(f.port) })}>Save</PrimaryButton>
      </div>
    </div>
  )
}

function TwoFactorFlow({ inst, onRun, onUndo, onClose }: { inst: Instance; onRun: (body: Record<string, unknown>) => void; onUndo: () => void; onClose: () => void }) {
  const [data, setData] = useState<TwoFactorView | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [exclude, setExclude] = useState('')
  const [ack, setAck] = useState(false)
  const [adminAck, setAdminAck] = useState(false)
  useEffect(() => { void apiJson<{ data: TwoFactorView }>(`${API}/instances/${inst.id}/two-factor`).then(r => (r.ok ? setData(r.body!.data) : setErr(r.error ?? 'Could not read the users.'))) }, [inst.id])
  const v = twoFactorWords(data)
  return (
    <div className={n.form}>
      {!data && !err && <BusyNote>Reading who has a second factor…</BusyNote>}
      {err && <Notice kind="error">{err}</Notice>}
      {data && (
        <>
          <p className="text-sm" style={{ color: 'var(--text-soft)' }}>{v.state}</p>
          {!data.providers.length && <Notice kind="warn">No second factor a user can set up at sign-in (TOTP or WebAuthn) is enabled, so nobody could set one up. Enable one under Apps first.</Notice>}
          <p className="text-sm" style={{ color: 'var(--text-soft)' }}>{v.without}</p>
          {v.lacking.length > 0 && <ul className={n.userList} aria-label="Users without a second factor">{v.lacking.map(u => <li key={u}><Pill tone="warn">{u}</Pill></li>)}</ul>}
          {v.unknown.length > 0 && <Notice kind="error">HyperProx could not check {v.unknown.join(', ')}. It does not enforce two-factor authentication while any user is unknown.</Notice>}
          {data.truncated && <Notice kind="error">Only the first 100 users were checked, so HyperProx does not enforce it from here.</Notice>}
          {v.adminsLacking.length > 0 && (
            <Notice kind="warn"><b>Admin{v.adminsLacking.length === 1 ? '' : 's'} without a second factor: {v.adminsLacking.join(', ')}.</b> Once enforced, {v.adminsLacking.length === 1 ? 'that admin is' : 'those admins are'} made to set one up at the next sign-in, like everyone else. If that sign-in fails, nobody with admin rights may be able to get in: set one up first if you can.</Notice>
          )}
          <label><span style={LABEL}>Groups that may skip it (optional, comma-separated, no spaces in names; groups already left out stay left out)</span><input style={INPUT} autoCapitalize="none" value={exclude} onChange={e => setExclude(e.target.value)} placeholder="guests" /></label>
          <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--text)' }}><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /><span>I have read the list and the people on it know.</span></label>
          {v.adminsLacking.length > 0 && <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--warn-2)' }}><input type="checkbox" checked={adminAck} onChange={e => setAdminAck(e.target.checked)} /><span>Enforce it although an admin has no second factor yet.</span></label>}
        </>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {data?.enforcement?.enforced && <GhostButton type="button" onClick={onUndo} style={{ color: 'var(--crit-soft)' }} title="Turns enforcement off for everyone; earlier group-only settings are not restored">Stop enforcing 2FA for everyone</GhostButton>}
        <GhostButton type="button" onClick={onClose}>Cancel</GhostButton>
        <PrimaryButton type="button" disabled={!data || !ack || !v.canEnforce || (v.adminsLacking.length > 0 && !adminAck)}
          onClick={() => onRun({ acknowledged: true, adminWithout2fa: adminAck, exclude: exclude.split(',').map(s => s.trim()).filter(Boolean) })}>Enforce</PrimaryButton>
      </div>
    </div>
  )
}

interface ProxyHost { id: string; instanceId: string; kind: string; domains: string[]; forwardHost: string; readOnly: boolean; native?: Record<string, any>; options?: Record<string, any> }

function ClientPushFlow({ inst, r, busy, onAct }: { inst: Instance; r: Reading; busy: boolean; onAct: (action: ActionId, body: Record<string, unknown>) => void }) {
  const host = inst.url ? (() => { try { return new URL(inst.url!).hostname } catch { return null } })() : null
  const [proxy, setProxy] = useState<{ host: ProxyHost | null; error?: string } | null>(null)
  const [plan, setPlan] = useState<any>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => {
    if (!host) { setProxy({ host: null }); return }
    void apiJson<{ data: { hosts: ProxyHost[] } }>('/api/proxy/hosts').then(x => setProxy(x.ok ? { host: x.body!.data.hosts.find(h => h.domains.includes(host)) ?? null } : { host: null, error: x.error }))
  }, [host])
  const upstream = proxy?.host?.forwardHost ?? 'nextcloud-host'
  const snippet = pushNginxSnippet(upstream)
  const current = String(proxy?.host?.native?.advanced_config ?? proxy?.host?.options?.advanced_config ?? '')
  const already = /location\s+\^?~?\s*\/push\//.test(current)
  const preview = async () => {
    const h = proxy!.host!
    const x = await apiJson<{ data: any }>(`/api/proxy/instances/${h.instanceId}/preview`, 'POST', { action: 'update', hostId: h.id, host: { npm: { advanced_config: `${current.trim()}${current.trim() ? '\n\n' : ''}${snippet}\n` } } })
    if (x.ok) setPlan(x.body!.data); else setNote({ ok: false, text: x.error ?? 'The proxy did not take the preview.' })
  }
  const apply = async () => {
    const x = await apiJson<{ data: any }>(`/api/proxy/plans/${plan.id}/apply`, 'POST', {})
    setPlan(null)
    setNote(x.ok ? { ok: true, text: 'The proxy now routes /push to the daemon.' } : { ok: false, text: x.error ?? 'The proxy change did not apply.' })
  }
  const push = r.talk.push
  return (
    <div className={n.form}>
      <Steps items={[
        <span key="1"><b>Install the Client Push app.</b> {push.app === 'enabled' ? <Pill tone="good">done</Pill> : <button type="button" className={vs.btn} disabled={busy} onClick={() => onAct('install-notify-push', {})}>Install it</button>}</span>,
        <span key="2"><b>Run its daemon.</b> {push.daemon === 'running' ? <Pill tone="good">running</Pill> : <>
          It is a small program inside the app; it needs its own container. {r.deployment?.kind === 'compose' ? `Add this service to ${r.deployment.app?.configFile ?? 'your Compose file'}, then docker compose up -d notify_push:` : 'Run it next to Nextcloud:'}
          <pre className={n.pre}>{pushComposeSnippet(r.deployment)}</pre><CopyButton text={pushComposeSnippet(r.deployment)} />
          <small style={{ display: 'block', color: 'var(--text-muted)' }}>HyperProx does not edit your Compose file: the volume name and network have to match yours.</small></>}</span>,
        <span key="3"><b>Route /push to it.</b> {already ? <Pill tone="good">routed</Pill> : proxy === null ? <BusyNote>Looking for the site in HyperProx&apos;s proxy…</BusyNote>
          : proxy.host && proxy.host.kind === 'npm' && !proxy.host.readOnly ? <>
            {host} is managed in HyperProx&apos;s proxy (Nginx Proxy Manager). HyperProx adds this to its Advanced configuration, shown to you before anything changes:
            <pre className={n.pre}>{snippet}</pre>
            {!plan && <button type="button" className={vs.btn} onClick={() => void preview()}>Preview the change</button>}
            {plan && <div className="mt-2 flex flex-col gap-2"><ul className={n.warnings}>{[...(plan.changes ?? []), ...(plan.warnings ?? [])].map((c: string) => <li key={c}>{c}</li>)}</ul>
              <div className="flex gap-2"><button type="button" className={`${vs.btn} ${vs.btnPri}`} onClick={() => void apply()}>Apply</button><button type="button" className={vs.btn} onClick={() => setPlan(null)}>Cancel</button></div></div>}
          </> : <>
            {proxy.host ? `${host} is in HyperProx's proxy but HyperProx cannot edit it there (${proxy.host.kind}${proxy.host.readOnly ? ', read-only' : ''}).` : `${host ?? 'This site'} is not managed in HyperProx's proxy.`} Add this to the nginx server block for Nextcloud (in NPM: the proxy host → Advanced), with the daemon&apos;s address:
            <pre className={n.pre}>{snippet}</pre><CopyButton text={snippet} />
            <small style={{ display: 'block', color: 'var(--text-muted)' }}>Another proxy: forward https://{host ?? 'cloud.example.com'}/push/ to port 7867 of the daemon, with websockets on.</small></>}</span>,
        <span key="4"><b>Tell Nextcloud where it is.</b> {push.endpoint ? <Pill tone="good">{push.endpoint}</Pill> : <button type="button" className={vs.btn} disabled={busy || !inst.url} onClick={() => onAct('notify-push-setup', { url: `${inst.url}/push` })}>Test and save {inst.url ? `${inst.url}/push` : '(add the address in Settings first)'}</button>}</span>,
      ]} />
      {note && <Notice kind={note.ok ? 'info' : 'error'}>{note.text}</Notice>}
      {proxy?.error && <small style={{ color: 'var(--text-muted)' }}>The proxy list could not be read: {proxy.error}</small>}
    </div>
  )
}

function GuideModal({ c, r, inst, busy, onClose, onAct, onSecure }: {
  c: Check; r: Reading; inst: Instance; busy: boolean; onClose: () => void
  onAct: (action: ActionId, body: Record<string, unknown>) => void; onSecure: (action: ActionId, body: Record<string, unknown>) => void
}) {
  if (c.remedy.kind !== 'guided') return null
  const flow = c.remedy.flow
  const title = flow === 'smtp' ? 'Set up mail' : flow === 'enforce-2fa' ? 'Enforce two-factor authentication' : flow === 'client-push' ? 'Set up Client Push' : flow === 'log' ? 'The log' : flow === 'cron' ? 'Switch background jobs to cron' : c.name
  return (
    <Modal title={title} onClose={onClose}>
      {flow === 'smtp' && <SmtpForm r={r} onClose={onClose} onRun={b => onSecure('smtp', b)} />}
      {flow === 'enforce-2fa' && <TwoFactorFlow inst={inst} onClose={onClose} onRun={b => onSecure('enforce-2fa', b)} onUndo={() => onSecure('unenforce-2fa', {})} />}
      {flow === 'client-push' && <ClientPushFlow inst={inst} r={r} busy={busy} onAct={onAct} />}
      {flow === 'log' && <LogView entries={r.log} />}
      {flow === 'cron' && (
        <div className={n.form}>
          <p className="text-sm" style={{ color: 'var(--text-soft)' }}>{c.remedy.why}</p>
          <Steps items={[
            <span key="1">{r.deployment?.kind === 'bare' ? 'Add this line to the web server user\'s crontab:' : `Add this service to ${r.deployment?.app?.configFile ?? 'your Compose file'} (with the same volumes as the app service), then docker compose up -d cron:`}
              <pre className={n.pre}>{cronSnippet(r.deployment)}</pre><CopyButton text={cronSnippet(r.deployment)} /></span>,
            <span key="2">In Nextcloud: Administration → Basic settings → Background jobs → <b>Cron</b>.</span>,
          ]} />
        </div>
      )}
      {(flow === 'update-manual' || flow === 'hpb-manual' || flow === 'app-api-daemon') && (
        <div className={n.form}>
          <p className="text-sm" style={{ color: 'var(--text-soft)' }}>{c.remedy.why}</p>
          {c.id === 'hyperprox:update' && <Steps items={manualUpdateSteps(r.deployment, r.update.core).map(s => <code key={s}>{s}</code>)} />}
          {c.doc && <a className={n.doc} href={c.doc} target="_blank" rel="noreferrer noopener">Nextcloud&apos;s instructions →</a>}
        </div>
      )}
    </Modal>
  )
}

// ── one instance ─────────────────────────────────────────────────────────────

function InstanceView({ inst }: { inst: Instance }) {
  const { role } = useSession()
  const admin = atLeast(role, 'admin')
  const [data, setData] = useState<{ ok: boolean; reading?: Reading; error?: string } | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [loading, setLoading] = useState(false)
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null)
  const [fix, setFix] = useState<Check | null>(null)
  const [guide, setGuide] = useState<Check | null>(null)
  const [update, setUpdate] = useState<UpdatePreview | 'loading' | null>(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const load = useCallback(async (fresh = false) => {
    if (inFlight.current) return
    inFlight.current = true; setLoading(true)
    const r = await apiJson<{ data: { ok: boolean; reading?: Reading; error?: string; job?: Job | null } }>(`${API}/instances/${inst.id}/reading${fresh ? '?fresh=1' : ''}`)
    inFlight.current = false; setLoading(false)
    setData(r.ok ? r.body!.data : { ok: false, error: r.error ?? 'Could not read Nextcloud.' })
    if (r.ok && r.body!.data.job) setJob(j => (j && j.id !== r.body!.data.job!.id && j.state === 'running' ? j : r.body!.data.job!))
  }, [inst.id])

  useEffect(() => {
    void load()
    const t = setInterval(() => { if (!document.hidden) void load() }, 120_000)
    return () => clearInterval(t)
  }, [load])

  // A running job is read every two seconds until it ends, then the page reads Nextcloud again.
  useEffect(() => {
    if (!job || job.state !== 'running') return
    const t = setInterval(async () => {
      const r = await apiJson<{ data: Job }>(`${API}/instances/${inst.id}/jobs/${job.id}`)
      if (!r.ok) return
      setJob(r.body!.data)
      if (r.body!.data.state !== 'running') void load(true)
    }, 2000)
    return () => clearInterval(t)
  }, [job, inst.id, load])

  const run = async (action: ActionId, body: Record<string, unknown>, secure: boolean) => {
    setBusy(true); setNote(null)
    const res = await post<{ message: string; jobId?: string }>(`${API}/instances/${inst.id}/${secure ? 'secure-actions' : 'actions'}/${action}`, body)
    setBusy(false)
    if (!res) return
    setFix(null); setGuide(null); setUpdate(null)
    if (!res.ok) { setNote({ text: [res.error, ...((res.body?.problems as string[] | undefined)?.slice(1) ?? [])].join(' '), ok: false }); return }
    setNote({ text: res.data!.message, ok: true })
    if (res.data!.jobId) {
      const j = await apiJson<{ data: Job }>(`${API}/instances/${inst.id}/jobs/${res.data!.jobId}`)
      if (j.ok) setJob(j.body!.data)
    } else void load(true)
  }

  const stopWatching = async (): Promise<void> => {
    if (!job || !window.confirm(stopWatchingWords(job))) return
    await stopWatchingConfirmed()
  }
  const stopWatchingConfirmed = async (): Promise<void> => {
    if (!job) return
    const res = await post<Job>(`${API}/instances/${inst.id}/jobs/${job.id}/stop-watching`, {})
    if (res?.ok) { setJob(res.data!); setNote({ text: res.data!.result ?? 'HyperProx stopped watching it.', ok: true }) } else if (res) setNote({ text: res.error ?? 'That did not work.', ok: false })
  }

  const snooze = async (c: Check, days: number | 'forever' | 0) => {
    const r = await apiJson(`${API}/instances/${inst.id}/snooze`, 'POST', { check: c.id, days })
    if (!r.ok) setNote({ text: r.error ?? 'Could not snooze it.', ok: false }); else void load(true)
  }

  const openUpdate = async () => {
    setUpdate('loading')
    const r = await apiJson<{ data: UpdatePreview }>(`${API}/instances/${inst.id}/update/preview`, 'POST', {})
    if (r.ok) setUpdate(r.body!.data); else { setUpdate(null); setNote({ text: r.error ?? 'The update check did not run.', ok: false }) }
  }

  const onCheck = (c: Check) => {
    if (c.remedy.kind === 'fix' && c.remedy.action === 'update') return void openUpdate()
    if (c.remedy.kind === 'fix' && c.remedy.action === 'hpb-update') return setFix(c)
    if (c.remedy.kind === 'fix') return setFix(c)
    if (c.remedy.kind === 'guided') return setGuide(c)
  }

  const r = data?.reading
  const v = r ? verdictOf(r) : null
  const hpbCheck = r?.checks.find(c => c.remedy.kind === 'fix' && c.remedy.action === 'hpb-update')
  const pushCheck = r?.checks.find(c => c.remedy.kind === 'guided' && c.remedy.flow === 'client-push')
    ?? (r ? { id: 'hyperprox:push', category: 'talk', name: 'Client Push', severity: 'info', description: '', doc: null, snoozed: null, remedy: { kind: 'guided', flow: 'client-push', label: 'Set up Client Push', why: '' } } as Check : null)
  const updateCheck = r?.checks.find(c => c.id === 'hyperprox:update')

  return (
    <div className={vs.page}>
      {!data && <BusyNote>Reading {inst.name}…</BusyNote>}
      {data && !data.ok && <Notice kind="error">{data.error} The page tries again every two minutes.</Notice>}
      {r && v && (
        <>
          <HudHeader level={2} label={`${inst.name} overview`} eyebrow={`Nextcloud${r.status ? ` · ${r.status.versionString}` : ''}`} title={inst.name}
            ring={{ value: healthScore(r.counts), text: v.tone === 'good' ? 'OK' : String(r.counts.error + r.counts.warning), label: v.text }}
            chips={[
              { label: 'errors', value: r.counts.error, tone: r.counts.error ? 'crit' : 'good' },
              { label: 'warnings', value: r.counts.warning, tone: r.counts.warning ? 'warn' : 'good' },
              { label: 'notes', value: r.counts.info },
              { label: 'update', value: r.update.core ?? 'none', tone: r.update.core ? 'warn' : 'good' },
            ]}
            actions={<div className={n.toolbar}>
              <button type="button" className={vs.btn} disabled={loading} onClick={() => void load(true)}><Icon name="check" size={14} /> {loading ? 'Reading…' : 'Refresh'}</button>
              <small>read {ago(r.fetchedAt)} · checks from {r.checksFrom === 'web' ? 'the admin page' : 'occ'}</small>
            </div>} />
          {note && <p className="text-sm" role="status" style={{ color: note.ok ? 'var(--good)' : 'var(--warn-2)' }}>{note.text}</p>}
          {r.missing.length > 0 && <Notice kind="warn">Not read: {r.missing.join(', ')}. The rest of the page is real.</Notice>}
          {job && (job.state === 'running' || Date.now() - Date.parse(job.endedAt ?? job.startedAt) < 30 * 60_000) && (
            <Panel title="Running now" sub={`${job.action} · started by ${job.by}`}><JobView job={job} onStopWatching={admin ? () => void stopWatching() : undefined} /></Panel>
          )}
          <Panel title="Version" sub={r.update.apps.length ? `${r.update.apps.length} app updates too` : undefined}>
            <VersionTrack r={r} admin={admin} busy={busy || job?.state === 'running'} onUpdate={() => (r.deployment?.kind === 'compose' ? void openUpdate() : updateCheck && setGuide(updateCheck))} />
          </Panel>
          <Panel title="Setup checks" sub={admin ? 'every problem has an action' : 'an admin can fix these'}>
            <CheckGroups checks={r.checks} admin={admin} busy={busy || job?.state === 'running'} onAct={onCheck} onSnooze={(c, d) => void snooze(c, d)} />
          </Panel>
          {r.talk.installed && (
            <Panel title="Talk" sub="signalling server · Client Push">
              <TalkView r={r} admin={admin} busy={busy || job?.state === 'running'} onHpb={() => hpbCheck && setFix(hpbCheck)} onPush={() => pushCheck && setGuide(pushCheck)} />
            </Panel>
          )}
          <Panel title="System" sub="PHP · database · users · background jobs"><SystemView r={r} /></Panel>
          <Panel title="Log" sub="recent warnings and errors"><LogView entries={r.log} /></Panel>
        </>
      )}
      {fix && r && <FixModal c={fix} r={r} onClose={() => setFix(null)} onRun={(a, b, s) => void run(a, b, s)} />}
      {guide && r && <GuideModal c={guide} r={r} inst={inst} busy={busy} onClose={() => setGuide(null)} onAct={(a, b) => void run(a, b, false)} onSecure={(a, b) => void run(a, b, true)} />}
      {update && (
        <Modal title="Update Nextcloud" onClose={() => setUpdate(null)} footer={update !== 'loading' && (
          <div className="flex flex-wrap justify-end gap-2">
            <GhostButton type="button" onClick={() => setUpdate(null)}>Close</GhostButton>
            <PrimaryButton type="button" disabled={!update.ok || busy} onClick={() => void run('update', { confirmBackupDir: update.backupDir }, true)}>Back up and update</PrimaryButton>
          </div>)}>
          {update === 'loading' ? <BusyNote>Checking who is online, calls, backups and room for the dump…</BusyNote> : <UpdateCheckView p={update} />}
        </Modal>
      )}
    </div>
  )
}

// ── settings: add, change, remove ────────────────────────────────────────────

interface Candidate { kind: 'lxc' | 'qemu'; vmid: number; name: string; node: string; running: boolean }

function InstanceForm({ inst, onSaved, onCancel }: { inst: Instance | null; onSaved: () => void; onCancel?: () => void }) {
  const [cands, setCands] = useState<Candidate[] | null>(null)
  const [f, setF] = useState({ name: inst?.name ?? '', guest: inst?.guest ? `${inst.guest.kind}:${inst.guest.vmid}` : '', url: inst?.url ?? '', user: inst?.user ?? '', appPassword: '', create: false })
  const [found, setFound] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f, v: any) => setF(x => ({ ...x, [k]: v }))
  useEffect(() => { if (!inst) void apiJson<{ data: Candidate[] }>(`${API}/candidates`).then(r => setCands(r.ok ? r.body!.data.filter(c => c.running) : [])) }, [inst])
  const guest = () => { const [kind, vmid] = f.guest.split(':'); return { kind, vmid: Number(vmid) } }
  const detect = async () => {
    setErr(null); setFound(null); setBusy(true)
    const r = await apiJson<{ data: any }>(`${API}/detect`, 'POST', { guest: guest() })
    setBusy(false)
    if (r.ok) { const d = r.body!.data; setFound(d.kind === 'compose' ? `Docker Compose: ${d.app.project} in ${d.app.workdir}, image ${d.app.image}${d.app.built ? ' (built here)' : ''}${d.signaling ? `, Talk signalling ${d.signaling.version ?? ''}` : ''}.` : d.kind === 'docker' ? `Docker container ${d.app.container}, without Compose.` : `A plain install at ${d.bareDir}.`) }
    else setErr(r.error ?? 'No Nextcloud found there.')
  }
  const save = async () => {
    setBusy(true); setErr(null)
    const body: Record<string, unknown> = inst
      ? { name: f.name, url: f.url, user: f.user, ...(f.appPassword ? { appPassword: f.appPassword } : {}) }
      : { name: f.name, guest: guest(), ...(f.url ? { url: f.url } : {}), ...(f.user ? { user: f.user } : {}), ...(f.appPassword ? { appPassword: f.appPassword } : {}), ...(f.create ? { createAppPassword: true } : {}) }
    const r = await apiJson(inst ? `${API}/instances/${inst.id}` : `${API}/instances`, inst ? 'PUT' : 'POST', body)
    setBusy(false)
    if (!r.ok) { setErr(r.error ?? 'Could not save.'); return }
    set('appPassword', '')
    onSaved()
  }
  const [forceRemove, setForceRemove] = useState(false)
  const remove = async (force = false) => {
    if (!inst || (!force && !window.confirm(`Remove ${inst.name} from HyperProx? ${inst.appPasswordMadeByHyperProx ? 'The app password HyperProx made is revoked in Nextcloud first, then' : 'Its app password is'} deleted from the vault. HyperProx will not connect it again by itself. Nextcloud itself is not touched.`))) return
    const r = await apiJson(`${API}/instances/${inst.id}${force ? '?force=1' : ''}`, 'DELETE', undefined, force ? undefined : IN_PAGE)
    if (!r.ok) { setErr(r.error ?? 'Could not remove it.'); setForceRemove(r.code === 'revoke_failed'); return }
    onSaved()
  }
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      <h3 className="font-display font-semibold" style={{ fontSize: 18, color: 'var(--text-bright)' }}>{inst ? `Settings: ${inst.name}` : 'Add a Nextcloud'}</h3>
      {inst?.autoConnected && <AutoConnectedNote evidence={inst.autoConnected.evidence} extra={inst.autoConnected.webLogin ? `Web login: ${inst.autoConnected.webLogin}.` : 'No web login yet: occ gives the health and setup checks; the web login adds server details.'} />}
      {!inst && <Notice kind="info">HyperProx connects every Nextcloud it finds on the cluster by itself. Add one here only when it was not found (another network, or a guest the service scan cannot reach).</Notice>}
      <Notice kind="info">HyperProx reaches Nextcloud through its guest, with the node&apos;s login (the same way the VPN page does): it runs occ there, from a fixed list of commands. The web login is optional: an admin&apos;s app password, kept in the vault, used only to read server info and the admin page&apos;s own checks.</Notice>
      <label><span style={LABEL}>Name</span><input style={INPUT} value={f.name} onChange={e => set('name', e.target.value)} placeholder="Cloud" /></label>
      {!inst && (
        <label><span style={LABEL}>Runs in</span>
          <select style={INPUT} value={f.guest} onChange={e => { set('guest', e.target.value); setFound(null) }}>
            <option value="">{cands ? 'Pick the container or VM…' : 'Reading the guests…'}</option>
            {(cands ?? []).map(c => <option key={`${c.kind}:${c.vmid}`} value={`${c.kind}:${c.vmid}`}>{c.kind === 'lxc' ? 'CT' : 'VM'} {c.vmid} {c.name} · {c.node}</option>)}
          </select></label>
      )}
      {!inst && <div className="flex flex-wrap items-center gap-2"><GhostButton type="button" disabled={!f.guest || busy} onClick={() => void detect()}>Look for Nextcloud there</GhostButton>{found && <small style={{ color: 'var(--good)' }}>{found}</small>}</div>}
      <label><span style={LABEL}>Address people use (optional)</span><input style={INPUT} autoCapitalize="none" value={f.url} onChange={e => set('url', e.target.value)} placeholder="https://cloud.example.com" /></label>
      <div className={n.grid2}>
        <label><span style={LABEL}>Admin user (optional)</span><input style={INPUT} autoCapitalize="none" autoComplete="off" value={f.user} onChange={e => set('user', e.target.value)} placeholder="admin" /></label>
        <label><span style={LABEL}>App password {inst?.hasAppPassword ? '(saved; blank keeps it)' : '(optional)'}</span><input style={INPUT} type="password" autoComplete="new-password" disabled={f.create} value={f.appPassword} onChange={e => set('appPassword', e.target.value)} /></label>
      </div>
      {!inst && <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--text)' }}><input type="checkbox" checked={f.create} onChange={e => set('create', e.target.checked)} />
        <span>Make the app password for me<span className="block text-[12px]" style={{ color: 'var(--text-dim)' }}>HyperProx runs occ user:auth-tokens:add for the admin user above, named HyperProx (so its own activity is never counted as a person online), and keeps it in the vault. Revoke it any time under that user&apos;s Security settings.</span></span></label>}
      {err && <Notice kind="error">{err}</Notice>}
      <div className="flex flex-wrap justify-end gap-2">
        {inst && forceRemove && <GhostButton type="button" onClick={() => void remove(true)} style={{ color: 'var(--crit-soft)' }}>Remove anyway (leave the app password)</GhostButton>}
        {inst && <GhostButton type="button" onClick={() => void remove()} style={{ color: 'var(--crit-soft)' }}>Remove</GhostButton>}
        {onCancel && <GhostButton type="button" onClick={onCancel}>Cancel</GhostButton>}
        <PrimaryButton type="button" disabled={busy || !f.name || (!inst && !f.guest)} onClick={() => void save()}>{busy ? 'Checking…' : inst ? 'Save' : 'Check and add'}</PrimaryButton>
      </div>
    </div>
  )
}

// ── the plug-in page ─────────────────────────────────────────────────────────

export function NextcloudPage() {
  const { role } = useSession()
  const admin = atLeast(role, 'admin')
  const [list, setList] = useState<Instance[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [tab, setTab] = useState<'cloud' | 'settings'>('cloud')
  const [adding, setAdding] = useState(false)
  const reload = useCallback(async () => {
    const r = await apiJson<{ data: Instance[] }>(`${API}/instances`)
    if (r.ok) { setList(r.body!.data ?? []); setError(null) } else setError(r.error ?? 'Could not read the list.')
  }, [])
  useEffect(() => { void reload() }, [reload])
  const s = list?.find(i => i.id === sel) ?? list?.[0] ?? null
  return (
    <div className="min-h-full overflow-x-hidden" style={{ background: 'var(--ground)' }}>
      {admin && <div className="flex flex-wrap items-center gap-3 pb-2"><span className="ml-auto"><GhostButton type="button" onClick={() => setAdding(true)}>Add one by hand</GhostButton></span></div>}
      <div className="flex min-w-0 flex-col gap-4 py-4">
        <PluginSwitcher current="nextcloud" />
        {error && <Notice kind="error">{error}</Notice>}
        {!list && !error && <BusyNote>Reading…</BusyNote>}
        {admin && <RemovedGuestsNotice plugin="nextcloud" />}
        {admin && <AutoConnectPanel plugins={['nextcloud']} onChanged={() => void reload()} />}
        {adding && <InstanceForm inst={null} onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); void reload() }} />}
        {list && list.length === 0 && !adding && <Notice kind="info">No Nextcloud found yet. HyperProx connects one by itself as soon as it finds it{admin ? ': install one from the Catalogue, or add one by hand if it is somewhere the scan cannot see.' : '.'}</Notice>}
        {list && s && (
          <>
            {list.length > 1 && <div className={n.tabs} role="tablist" aria-label="Nextcloud instances">{list.map(i => <button key={i.id} role="tab" aria-selected={i.id === s.id} onClick={() => setSel(i.id)} className={n.tab}>{i.name}</button>)}</div>}
            {admin && (
              <div className={n.views} role="tablist" aria-label="View">
                <button role="tab" aria-selected={tab === 'cloud'} onClick={() => setTab('cloud')}>Health</button>
                <button role="tab" aria-selected={tab === 'settings'} onClick={() => setTab('settings')}>Settings</button>
              </div>
            )}
            {(tab === 'cloud' || !admin) && <InstanceView key={s.id} inst={s} />}
            {tab === 'settings' && admin && <InstanceForm key={s.id} inst={s} onSaved={() => void reload()} />}
          </>
        )}
      </div>
    </div>
  )
}
