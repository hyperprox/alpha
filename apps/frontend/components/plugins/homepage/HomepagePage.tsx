'use client'

// =============================================================================
//  HyperProx — Homepage: fill a Homepage dashboard from the cluster
//
//  Phone first: one column of panels. The HUD; the dashboards HyperProx found
//  (Catalogue installs, the service scan, the install marker) with Connect; and
//  for a connected one, its problems with a fix button each, the dashboard it
//  would build drawn the way Homepage draws it, the line diff of every file,
//  and Apply. Settings: auto-sync (off until turned on), bare guests, excluded
//  subnets. Widgets are opt-in per service and say plainly where their keys end
//  up; turning them on, writing their keys and the Proxmox token all ask for the
//  master password.
//
//  Everything here is admin: the preview maps every LAN address.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { apiJson, atLeast, type ApiResult } from '@/lib/api'
import { useSession } from '@/lib/session'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { BusyNote, GhostButton, INPUT, LABEL, Modal, Notice, PrimaryButton } from '@/components/vault/ui'
import { HudHeader, Icon, Panel, Pill, styles as vs } from '@/components/visual/kit'
import { PluginSwitcher } from '@/components/plugins/visual/plugin-kit'
import h from './homepage.module.css'
import {
  KEYS_WARNING, SOURCE_NAME, SOURCE_WORD, applyGate, diffStats, foldDiff, grouped, keptWords, monogram, plural, syncWords, validSubnets,
  type Detected, type DiffLine, type Instance, type Preview, type PreviewEntry, type Problem,
} from './logic'

const API = '/api/plugins/homepage'

// ── pieces (exported for the tests) ─────────────────────────────────────────

/** The dashboard as Homepage will draw it: one column per group, one tile per entry, its status check and link. */
export function DashboardPreview({ entries, hidden = [], onToggleHidden }: { entries: PreviewEntry[]; hidden?: string[]; onToggleHidden?: (id: string) => void }) {
  if (!entries.length) return <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Nothing on the cluster to put on the dashboard yet.</p>
  return (
    <div className={h.board} role="list" aria-label="Dashboard preview">
      {grouped(entries).map(g => (
        <section key={g.group} className={h.group} role="listitem" aria-label={`${g.group}, ${plural(g.entries.length, 'entry')}`}>
          <h3 className={h.groupHead}>{g.group}<small>{g.entries.length}</small></h3>
          {g.entries.map(e => {
            const isHidden = hidden.includes(e.id)
            return (
              <article key={e.id} className={h.tile} data-hidden={isHidden ? 'true' : undefined} aria-label={e.name} title={`${e.description ? `${e.description} · ` : ''}${SOURCE_WORD[e.source] ?? e.source}`}>
                <span className={h.mono} aria-hidden>{monogram(e.name)}</span>
                <span className={h.tileName}>
                  <i className={h.dot} data-kind={e.status === 'ping' ? 'ping' : e.status ? 'site' : 'none'} aria-hidden />
                  <span title={e.name}>{e.name}</span>
                </span>
                <span className={h.tileMeta}>
                  <span className={h.kind} data-kind={e.hrefKind}>{e.hrefKind === 'public' ? 'public' : e.hrefKind === 'lan' ? 'LAN' : 'no link'}</span>
                  <span>{e.status === 'siteMonitor' ? 'up/down check' : e.status === 'ping' ? 'ping' : 'no status'}</span>
                  {e.widget?.enabled && <span>{e.widget.pending ? 'widget waits for keys' : `${e.widget.type} widget`}</span>}
                  {isHidden && <span>hidden</span>}
                </span>
                {(e.href || onToggleHidden) && (
                  <span className={h.tileActs}>
                    {e.href && <span className={h.tileMeta} style={{ flex: '1 1 100%' }}><a href={e.href} target="_blank" rel="noreferrer noopener">{e.href}</a></span>}
                    {onToggleHidden && <button type="button" aria-pressed={isHidden} onClick={() => onToggleHidden(e.id)}>{isHidden ? 'Show on the dashboard' : 'Leave off the dashboard'}</button>}
                  </span>
                )}
              </article>
            )
          })}
        </section>
      ))}
    </div>
  )
}

/** One file's diff, unchanged runs folded. */
export function DiffView({ name, diff }: { name: string; diff: DiffLine[] }) {
  const st = diffStats(diff)
  return (
    <div className="flex flex-col gap-2">
      <div className={h.diffHead}>{name} <small><span className={h.plus}>+{st.added}</span> <span className={h.minus}>−{st.removed}</span></small></div>
      <pre className={h.diff} aria-label={`Changes to ${name}: ${st.added} lines added, ${st.removed} removed`}>
        {foldDiff(diff).map((l, i) => 'fold' in l
          ? <div key={i} data-fold>… {plural(l.fold, 'unchanged line')}</div>
          : <div key={i} data-op={l.op}><span aria-hidden>{l.op === ' ' ? '  ' : `${l.op} `}</span>{l.op === '+' ? <span className="sr-only">added: </span> : l.op === '-' ? <span className="sr-only">removed: </span> : null}{l.text || ' '}</div>)}
      </pre>
    </div>
  )
}

/** Problems, worst first, each with its fix. */
export function ProblemList({ problems, busy, onFix }: { problems: Problem[]; busy: string | null; onFix: (p: Problem) => void }) {
  if (!problems.length) return <p className="text-sm" style={{ color: 'var(--good)' }}><Icon name="check" size={14} /> No problems: Homepage answers, its config is valid and writable.</p>
  const list = [...problems].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'bad' ? -1 : 1))
  return (
    <ul className={h.problems}>
      {list.map(p => (
        <li key={p.id} className={h.problem} data-sev={p.severity}>
          <Icon name={p.severity === 'bad' ? 'error' : 'warn'} size={18} label={p.severity === 'bad' ? 'Problem' : 'Warning'} />
          <div><b>{p.title}</b><p>{p.detail}</p></div>
          {p.fix && <div className={h.fixRow}><button type="button" className={`${vs.btn} ${p.severity === 'bad' ? vs.btnPri : ''}`} disabled={busy === p.id} onClick={() => onFix(p)}>{busy === p.id ? 'Working…' : p.fix.label}</button></div>}
        </li>
      ))}
    </ul>
  )
}

/** The widgets that could be turned on, with the plain warning about where their keys go. */
export function WidgetList({ entries, chosen, onChange }: { entries: PreviewEntry[]; chosen: string[]; onChange: (ids: string[]) => void }) {
  const offers = entries.filter(e => e.widget)
  if (!offers.length) return <p className="text-sm" style={{ color: 'var(--text-muted)' }}>None of the services found has a Homepage widget HyperProx can fill in.</p>
  return (
    <div className={h.rows}>
      <p className={h.warnBox} role="note"><b>Plaintext on the guest.</b> {KEYS_WARNING}</p>
      {offers.map(e => (
        <label key={e.id} className={h.check}>
          <input type="checkbox" checked={chosen.includes(e.id)} onChange={ev => onChange(ev.target.checked ? [...chosen, e.id] : chosen.filter(x => x !== e.id))} />
          <span><b>{e.name}</b> · {e.widget!.type} widget{e.widget!.vars.length ? ` · needs ${plural(e.widget!.vars.length, 'key')}` : ' · no key needed'}</span>
        </label>
      ))}
    </div>
  )
}

// ── the page ────────────────────────────────────────────────────────────────

function useInstalls() {
  const [data, setData] = useState<{ detected: Detected[]; instances: Instance[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    const r = await apiJson<{ data: { detected: Detected[]; instances: Instance[] } }>(`${API}/installs`)
    if (r.ok) { setData(r.body!.data); setError(null) } else setError(r.error ?? 'Could not read the dashboards.')
  }, [])
  useEffect(() => { void reload() }, [reload])
  return { data, error, reload }
}

export function HomepagePage() {
  const { role } = useSession()
  const admin = atLeast(role, 'admin')
  const { data, error, reload } = useInstalls()
  const [pick, setPick] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  if (!admin) return (
    <div className={vs.page}><PluginSwitcher current="homepage" />
      <Notice kind="info">The Homepage plug-in needs the admin role: its preview shows every service&apos;s address on your network.</Notice></div>
  )

  const instances = data?.instances ?? []
  const current = instances.find(i => i.id === pick) ?? instances[0] ?? null
  const unconnected = (data?.detected ?? []).filter(d => !d.connected)

  const connect = async (d: Detected) => {
    setBusy(d.machineId); setNote(null)
    const r = await apiJson<{ data: Instance }>(`${API}/instances`, 'POST', { machineId: d.machineId })
    setBusy(null)
    if (r.ok) { setPick(r.body!.data.id); await reload() } else setNote({ text: r.error ?? 'Could not connect it.', ok: false })
  }

  return (
    <div className={vs.page}>
      <PluginSwitcher current="homepage" />
      <HudHeader eyebrow="Plug-in · Homepage" title="Homepage" icon="home"
        chips={[
          { label: 'dashboards', value: instances.length, tone: 'accent' },
          { label: 'entries', value: current?.lastSync ? Object.values(current.lastSync.counts).reduce((a, b) => a + b, 0) : '—' },
          { label: 'auto-sync', value: current?.autoSync ? 'on' : 'off', tone: current?.autoSync ? 'good' : 'dim' },
        ]} />
      {error && <Notice kind="error">{error}</Notice>}
      {note && <p className="text-sm" role="status" style={{ color: note.ok ? 'var(--good)' : 'var(--warn-2)' }}>{note.text}</p>}
      {!data && !error && <BusyNote>Looking for Homepage on the cluster…</BusyNote>}

      {data && (unconnected.length > 0 || !instances.length) && (
        <Panel title="Found on the cluster" sub={unconnected.length ? plural(unconnected.length, 'dashboard') : undefined}>
          {unconnected.length === 0
            ? <p className="text-sm" style={{ color: 'var(--text-soft)' }}>No Homepage found. Install it from the <a href="/catalogue" style={{ color: 'var(--hx-accent)' }}>Catalogue</a> (Apps → Homepage), then come back here.</p>
            : (
              <ul className={h.found}>
                {unconnected.map(d => (
                  <li key={d.machineId}>
                    <span><b style={{ color: 'var(--text-bright)' }}>{d.name}</b> <small>{d.kind === 'lxc' ? 'CT' : 'VM'} {d.vmid} · {d.node} · {d.via.map(v => ({ catalogue: 'Catalogue install', scan: 'service scan', marker: 'install note', proxy: 'proxy host' })[v]).join(', ')}</small></span>
                    <button type="button" className={`${vs.btn} ${vs.btnPri}`} disabled={!d.running || busy === d.machineId} onClick={() => void connect(d)}>
                      {!d.running ? 'Not running' : busy === d.machineId ? 'Looking inside…' : 'Connect'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          <p className="mt-2 text-xs" style={{ color: 'var(--text-dimmer)' }}>Connecting looks inside the guest once, read-only, for the Homepage container and the folder Docker mounts as its config. Nothing is written until you apply a preview.</p>
        </Panel>
      )}

      {instances.length > 1 && (
        <div className={h.toolbar} role="tablist" aria-label="Dashboards">
          {instances.map(i => <button key={i.id} type="button" role="tab" aria-selected={current?.id === i.id} className={vs.btn} onClick={() => setPick(i.id)}>{i.name}</button>)}
        </div>
      )}
      {current && <InstanceView key={current.id} i={current} onChanged={reload} />}
    </div>
  )
}

function InstanceView({ i, onChanged }: { i: Instance; onChanged: () => Promise<void> }) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [problems, setProblems] = useState<Problem[] | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null)
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const [confirmFix, setConfirmFix] = useState<Problem | null>(null)
  const [chosen, setChosen] = useState<string[]>(i.options.widgets)
  const [subnets, setSubnets] = useState(i.options.excludeSubnets.join(', '))
  const [disconnecting, setDisconnecting] = useState(false)
  const [anyway, setAnyway] = useState(false)
  const [forceWidgets, setForceWidgets] = useState(false)
  const sync = syncWords(i)

  const secure = async (r: ApiResult, again: () => void): Promise<boolean> => {
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => again); return false }
    return true
  }

  const loadProblems = useCallback(async () => {
    const r = await apiJson<{ data: Problem[] }>(`${API}/instances/${i.id}/problems`)
    setProblems(r.ok ? r.body!.data : [{ id: 'unreachable', severity: 'bad', title: 'Could not check', detail: r.error ?? 'The check failed.', fix: { id: 'recheck', label: 'Check again' } }])
  }, [i.id])

  const loadPreview = useCallback(async (fresh = false) => {
    setLoading('preview'); setNote(null)
    const r = await apiJson<{ data: Preview }>(`${API}/instances/${i.id}/preview${fresh ? '?fresh=1' : ''}`)
    setLoading(null)
    if (r.ok) setPreview(r.body!.data); else { setPreview(null); setNote({ text: r.error ?? 'Could not build the preview.', ok: false }) }
  }, [i.id])

  useEffect(() => { void loadProblems(); void loadPreview() }, [loadProblems, loadPreview])

  const apply = async () => {
    if (!preview) return
    setLoading('apply'); setNote(null)
    const r = await apiJson<{ data: { wrote: string[]; backups: string[]; verify: { ok: boolean; missing: string[]; error?: string }; unchanged: boolean } }>(`${API}/instances/${i.id}/apply`, 'POST', { planId: preview.planId, applyAnyway: anyway })
    setLoading(null)
    if (r.ok) {
      const d = r.body!.data
      setNote({ ok: d.verify.ok, text: d.unchanged ? 'Already up to date: nothing was written.'
        : d.verify.ok ? `Written (${d.wrote.join(' and ')}), backed up first. Homepage shows every entry.`
        : `Written (${d.wrote.join(' and ')}), but Homepage does not show ${d.verify.missing.slice(0, 4).join(', ')}${d.verify.error ? `: ${d.verify.error}` : ''}.` })
      await onChanged(); void loadProblems(); void loadPreview()
    } else setNote({ text: r.error ?? 'Nothing was written.', ok: false })
  }

  const saveSettings = async (body: Record<string, unknown>) => {
    const r = await apiJson(`${API}/instances/${i.id}/settings`, 'PUT', body)
    if (!r.ok) { setNote({ text: r.error ?? 'Not saved.', ok: false }); return }
    await onChanged(); void loadPreview()
  }

  const toggleHidden = (id: string) => {
    const hidden = i.options.hiddenEntries.includes(id) ? i.options.hiddenEntries.filter(x => x !== id) : [...i.options.hiddenEntries, id]
    void saveSettings({ hiddenEntries: hidden })
  }

  const saveWidgets = async (force = false): Promise<void> => {
    const r = await apiJson(`${API}/instances/${i.id}/widgets`, 'PUT', { entries: chosen, force })
    if (!(await secure(r, () => void saveWidgets(force)))) return
    if (r.code === 'keys_remain') {
      setNote({ text: r.error ?? 'The keys could not be taken off the guest.', ok: false })
      setForceWidgets(true)
      return
    }
    setForceWidgets(false)
    setNote(r.ok ? { text: 'Widgets saved. Write their keys to the guest, then preview and apply.', ok: true } : { text: r.error ?? 'Not saved.', ok: false })
    if (r.ok) { await onChanged(); void loadPreview(); void loadProblems() }
  }

  const exportKeys = async (): Promise<void> => {
    setLoading('keys')
    const r = await apiJson<{ data: { written: string[]; removed: string[]; missing: string[]; restarted: boolean } }>(`${API}/instances/${i.id}/secrets`, 'POST', {})
    setLoading(null)
    if (!(await secure(r, () => void exportKeys()))) return
    if (r.ok) {
      const d = r.body!.data
      setNote({ ok: true, text: `${plural(d.written.length, 'key')} written to the guest's homepage.env${d.restarted ? ' and Homepage recreated' : ' (recreating Homepage failed; run docker compose up -d there)'}.${d.missing.length ? ` Not held by HyperProx: ${d.missing.join(', ')}.` : ''} Preview and apply to add the widgets.` })
      await onChanged(); void loadPreview(); void loadProblems()
    } else setNote({ text: r.error ?? 'No key was written.', ok: false })
  }

  const token = async (make: boolean): Promise<void> => {
    setLoading('token')
    const r = await apiJson(`${API}/instances/${i.id}/proxmox-token`, make ? 'POST' : 'DELETE', make ? {} : undefined)
    setLoading(null)
    if (!(await secure(r, () => void token(make)))) return
    setNote(r.ok ? { ok: true, text: make ? 'A read-only (PVEAuditor) Proxmox token was made for this dashboard and kept in the vault. Write the keys to the guest to use it.' : 'The Proxmox token was revoked.' } : { text: r.error ?? 'That did not work.', ok: false })
    if (r.ok) { await onChanged(); void loadPreview() }
  }

  const wireEnv = async (): Promise<void> => {
    setLoading('env_not_wired')
    const r = await apiJson<{ data: { message: string } }>(`${API}/instances/${i.id}/wire-env`, 'POST', {})
    setLoading(null)
    if (!(await secure(r, () => void wireEnv()))) return
    setNote(r.ok ? { text: r.body!.data.message, ok: true } : { text: r.error ?? 'The compose file was not changed.', ok: false })
    void loadProblems()
  }

  const purgeBackups = async (): Promise<void> => {
    setLoading('key_backups')
    const r = await apiJson<{ data: { message: string } }>(`${API}/instances/${i.id}/purge-key-backups`, 'POST', {})
    setLoading(null)
    if (!(await secure(r, () => void purgeBackups()))) return
    setNote(r.ok ? { text: r.body!.data.message, ok: true } : { text: r.error ?? 'Nothing was deleted.', ok: false })
    void loadProblems()
  }

  const manageAgain = async (g: string) => {
    await saveSettings({ manageAgain: g })
    setNote({ ok: true, text: `HyperProx manages ${g} again from the next write. Entries in it that are exactly HyperProx's are taken back; the rest stay yours.` })
  }

  const takeOver = async (g: string) => {
    await saveSettings({ takeOver: g })
    setNote({ ok: true, text: `${g} is yours now: HyperProx will not write it again.` })
  }

  const fix = async (p: Problem): Promise<void> => {
    if (p.fix?.id === 'export_keys') return exportKeys()
    if (p.fix?.id === 'wire_env') return wireEnv()
    if (p.fix?.id === 'purge_key_backups') return purgeBackups()
    setLoading(p.id)
    const r = await apiJson<{ data: { message: string } }>(`${API}/instances/${i.id}/fix`, 'POST', { fix: p.fix!.id, applyAnyway: anyway })
    setLoading(null)
    setNote(r.ok ? { text: r.body!.data.message, ok: true } : { text: r.error ?? 'The fix did not work.', ok: false })
    await onChanged(); void loadProblems(); void loadPreview()
  }

  const disconnect = async (force = false) => {
    const r = await apiJson<{ data: { keysRemoved: string[]; keysLeft: string[] } }>(`${API}/instances/${i.id}${force ? '?force=1' : ''}`, 'DELETE')
    setDisconnecting(false)
    if (r.ok) { await onChanged(); return }
    setNote({ text: r.error ?? 'Not disconnected.', ok: false })
    if (r.code === 'keys_remain') setDisconnecting(true)
  }

  const sub = validSubnets(subnets)
  const gate = applyGate(preview?.failed ?? [], anyway)
  const changedFiles = preview?.files.filter(f => f.changed) ?? []
  const kept = preview ? keptWords(preview.notes) : []

  return (
    <>
      <div className={h.band} role="status">
        <span className="uppercase" style={{ letterSpacing: '0.04em' }}>{i.name} · {i.kind === 'lxc' ? 'CT' : 'VM'} {i.vmid}</span>
        {i.url && <a href={i.url} target="_blank" rel="noreferrer noopener">Open the dashboard</a>}
        <small>{sync.text}</small>
      </div>
      {note && <p className="text-sm" role="status" style={{ color: note.ok ? 'var(--good)' : 'var(--warn-2)' }}>{note.text}</p>}

      <Panel title="Health" sub="Homepage, its config, its widgets" actions={<button type="button" className={vs.btn} onClick={() => { setProblems(null); void loadProblems() }}>Check again</button>}>
        {!problems ? <BusyNote>Checking…</BusyNote> : <ProblemList problems={problems} busy={loading} onFix={p => (p.fix?.confirm ? setConfirmFix(p) : void fix(p))} />}
      </Panel>

      <Panel title="The dashboard" sub={preview ? `${plural(preview.entries.length, 'entry')} in ${plural(Object.keys(preview.counts).length, 'group')}` : undefined}
        actions={<button type="button" className={vs.btn} disabled={loading === 'preview'} onClick={() => void loadPreview(true)}>{loading === 'preview' ? 'Reading the cluster…' : 'Sync now'}</button>}>
        {!preview && loading === 'preview' && <BusyNote>Reading what runs on the cluster…</BusyNote>}
        {preview && (
          <div className="flex flex-col gap-4">
            {preview.failed.length > 0 && (
              <Notice kind="warn">
                Not read: {preview.failed.map(f => SOURCE_NAME[f] ?? f).join(', ')}. The dashboard below may be missing entries, or show some it should not. Auto-sync waits until everything can be read. ({preview.errors.join('; ')})
              </Notice>
            )}
            <DashboardPreview entries={preview.entries} hidden={i.options.hiddenEntries} onToggleHidden={toggleHidden} />
            {i.options.hiddenEntries.length > 0 && <p className="text-xs" style={{ color: 'var(--text-dimmer)' }}>{plural(i.options.hiddenEntries.length, 'entry')} left off the dashboard by you.</p>}
            {kept.length > 0 && <ul className={h.notes}>{kept.map(k => <li key={k}>{k}</li>)}</ul>}
            {changedFiles.length === 0
              ? <p className="text-sm" style={{ color: 'var(--good)' }}><Icon name="check" size={14} /> Homepage already shows exactly this. Nothing to write.</p>
              : (
                <>
                  {changedFiles.map(f => <DiffView key={f.name} name={f.name} diff={f.diff} />)}
                  <p className="text-xs" style={{ color: 'var(--text-dimmer)' }}>
                    Applying writes exactly these lines. Each file is copied to a dated backup beside it first, and the write is refused if the file changed since this preview. Homepage reloads by itself; nothing is restarted. HyperProx changes only the groups marked as its own.
                  </p>
                  {preview.failed.length > 0 && !preview.failed.includes('exclusions') && (
                    <label className={h.check}>
                      <input type="checkbox" checked={anyway} onChange={e => setAnyway(e.target.checked)} />
                      <span><b>Apply anyway</b> · write this although part of the inventory could not be read. Entries from {preview.failed.map(f => SOURCE_NAME[f] ?? f).join(', ')} may be missing.</span>
                    </label>
                  )}
                  {gate.reason && <p className="text-xs" style={{ color: 'var(--warn-2)' }}>{gate.reason}</p>}
                  <div className={h.toolbar}>
                    <button type="button" className={`${vs.btn} ${vs.btnPri}`} disabled={loading === 'apply' || !gate.ok} onClick={() => void apply()}>{loading === 'apply' ? 'Writing…' : `Apply ${plural(changedFiles.length, 'file')}`}</button>
                    <small>preview good for 10 minutes</small>
                  </div>
                </>
              )}
          </div>
        )}
      </Panel>

      <Panel title="Keep in sync">
        <div className={h.rows}>
          <label className={h.check}>
            <input type="checkbox" checked={i.autoSync} onChange={e => void saveSettings({ autoSync: e.target.checked })} />
            <span><b>Auto-sync</b> · rewrite the dashboard when the cluster changes (a new guest, proxy host, Catalogue install or removal). At most once every ten minutes, and only when the content would change. Your own groups and edits are always kept.</span>
          </label>
          <label className={h.check}>
            <input type="checkbox" checked={i.options.includeBareGuests} onChange={e => void saveSettings({ includeBareGuests: e.target.checked })} />
            <span><b>List guests with no web service</b> · in a Guests group, with a ping dot.</span>
          </label>
          <label>
            <span style={LABEL}>Leave these subnets off the dashboard</span>
            <input style={INPUT} value={subnets} onChange={e => setSubnets(e.target.value)} placeholder="192.0.2.0/24, 198.51.100.0/24" aria-invalid={!sub.ok} />
          </label>
          {!sub.ok && <p className="text-xs" style={{ color: 'var(--warn-2)' }}>Write each subnet like 192.0.2.0/24.</p>}
          <div className={h.toolbar}>
            <GhostButton type="button" disabled={!sub.ok || sub.list.join(',') === i.options.excludeSubnets.join(',')} onClick={() => void saveSettings({ excludeSubnets: sub.list })}>Save subnets</GhostButton>
            <small>Guests tagged hyperprox-ignore and guests on Remote access&apos;s exclusion list are always left off.</small>
          </div>
          {i.options.hiddenGroups.length > 0 && (
            <div className={h.toolbar}>
              <small>Groups you removed (not put back): {i.options.hiddenGroups.join(', ')}</small>
              <GhostButton type="button" onClick={() => void saveSettings({ hiddenGroups: [] })}>Bring them back</GhostButton>
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Service widgets" sub="opt-in · master password">
        <div className={h.rows}>
          <WidgetList entries={preview?.entries ?? []} chosen={chosen} onChange={setChosen} />
          <div className={h.toolbar}>
            <GhostButton type="button" disabled={chosen.join(',') === i.options.widgets.join(',')} onClick={() => void saveWidgets()}>Save widget choice</GhostButton>
            {forceWidgets && <GhostButton type="button" onClick={() => void saveWidgets(true)}>Save anyway and leave those keys on the guest</GhostButton>}
            <PrimaryButton type="button" disabled={!i.options.widgets.length || loading === 'keys'} onClick={() => void exportKeys()}>{loading === 'keys' ? 'Writing keys…' : 'Write the keys to the guest'}</PrimaryButton>
          </div>
          <p className="text-xs" style={{ color: 'var(--text-dimmer)' }}>
            Keys come from HyperProx&apos;s vault (each plug-in&apos;s settings) and go only to the address that plug-in is set up for. services.yaml only ever holds a {'{{HOMEPAGE_VAR_…}}'} placeholder; the value goes into Homepage&apos;s own homepage.env (mode 0600, never the shared .env), and only the Homepage container is recreated so it reads it. Turning a widget off, revoking the token or disconnecting takes its key off the guest again.
            {i.exportedVars.length > 0 && ` On the guest now: ${plural(i.exportedVars.length, 'key')}.`}
          </p>
          <div className={h.toolbar}>
            {i.proxmoxToken
              ? <><Pill tone="accent">Proxmox token {i.proxmoxToken.tokenId}</Pill><GhostButton type="button" disabled={loading === 'token'} onClick={() => void token(false)}>Revoke the Proxmox token</GhostButton></>
              : <GhostButton type="button" disabled={loading === 'token'} onClick={() => void token(true)}>Make a read-only Proxmox token for the cluster widget</GhostButton>}
          </div>
          <p className="text-xs" style={{ color: 'var(--text-dimmer)' }}>The token is privilege-separated with only PVEAuditor on /: it can read the cluster, never change it. HyperProx records it here so it can be revoked.</p>
        </div>
      </Panel>

      <Panel title="Connection">
        <p className="text-sm" style={{ color: 'var(--text-soft)' }}>Container <b>{i.container}</b>, config at <code>{i.configDir}</code>{i.composeDir ? <>, compose in <code>{i.composeDir}</code></> : null}. HyperProx owns the groups {i.managedGroups.length ? i.managedGroups.join(', ') : '(none yet)'}.</p>
        {i.releasedGroups?.length > 0 && (
          <div className={h.toolbar}>
            <small>Yours now, never written by HyperProx:</small>
            {i.releasedGroups.map(g => <GhostButton key={g} type="button" onClick={() => void manageAgain(g)}>Let HyperProx manage {g} again</GhostButton>)}
          </div>
        )}
        {i.managedGroups.length > 0 && (
          <div className={h.toolbar}>
            <small>Make a group yours, and HyperProx leaves it alone from then on:</small>
            {i.managedGroups.map(g => <GhostButton key={g} type="button" onClick={() => void takeOver(g)}>{g}</GhostButton>)}
          </div>
        )}
        {i.lastSync?.backups?.length ? <p className="text-xs" style={{ color: 'var(--text-dimmer)' }}>Last backup: {i.lastSync.backups.join(', ')}</p> : null}
        <div className={h.toolbar}><GhostButton type="button" onClick={() => setDisconnecting(true)}>Disconnect</GhostButton><small>Leaves the dashboard as it is.</small></div>
      </Panel>

      {confirmFix && (
        <Modal title={confirmFix.fix!.label} onClose={() => setConfirmFix(null)}>
          <div className="flex flex-col gap-4">
            <p className="text-sm" style={{ color: 'var(--text-soft)' }}>{confirmFix.fix!.confirm}</p>
            <div className="flex justify-end gap-2">
              <GhostButton type="button" onClick={() => setConfirmFix(null)}>Cancel</GhostButton>
              <PrimaryButton type="button" onClick={() => { const p = confirmFix; setConfirmFix(null); void fix(p) }}>{confirmFix.fix!.label}</PrimaryButton>
            </div>
          </div>
        </Modal>
      )}
      {disconnecting && (
        <Modal title="Disconnect this dashboard" onClose={() => setDisconnecting(false)}>
          <div className="flex flex-col gap-4">
            <p className="text-sm" style={{ color: 'var(--text-soft)' }}>HyperProx stops filling {i.name}. Widget keys are taken off the guest first; the dashboard stays as it is now, and connecting again takes its groups back.</p>
            <div className="flex justify-end gap-2">
              <GhostButton type="button" onClick={() => setDisconnecting(false)}>Cancel</GhostButton>
              {note && !note.ok && i.exportedVars.length > 0 && <GhostButton type="button" onClick={() => void disconnect(true)}>Disconnect and leave the keys there</GhostButton>}
              <PrimaryButton type="button" onClick={() => void disconnect()}>Disconnect</PrimaryButton>
            </div>
          </div>
        </Modal>
      )}
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const f = reconfirm; setReconfirm(null); f() }} />}
    </>
  )
}
