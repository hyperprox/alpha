'use client'

// =============================================================================
//  HyperProx — QNAP: each NAS, visual first
//
//  Phone first: one column of panels, the HUD on top, then the drive bays,
//  volumes, temperatures, firmware, shares and network, and the plain tables
//  folded into Details at the bottom. A NAS beside a remote cluster is amber
//  everywhere, home is teal.
//
//  Actions: refresh (anyone), a quick SMART test from a disk's sheet (operator
//  and above), restart and shut down (admin: master password, the phrase, and
//  the NAS's name typed). Nothing here deletes data.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { useClusters } from '@/lib/clusters'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { BusyNote, GhostButton, INPUT, LABEL, Modal, Notice, PrimaryButton } from '@/components/vault/ui'
import { HudHeader, Panel, Cols, Icon, styles as vs } from '@/components/visual/kit'
import { DetailsSection, PluginSwitcher } from '@/components/plugins/visual/plugin-kit'
import { Sheet } from '@/components/plugins/home-assistant/HomeVisual'
import { BayView, FirmwareCard, NetworkList, SensorGauges, ShareTiles, VolumeRings, hudChips, usage, type Disk, type Reading } from './QnapVisual'
import q from './qnap.module.css'

const API = '/api/plugins/qnap'

export interface Nas {
  id: string; name: string; clusterId: string | null; node?: string | null; reach: 'auto' | 'direct' | 'cluster'
  insecureTLS: boolean; fingerprint?: string | null; alerts: boolean; diskTempWarnC: number | null
  url?: string; username?: string; hasPassword?: boolean
  cluster: { id: string; name: string; kind: 'home' | 'remote' } | null; remote: boolean
  via: 'direct' | 'cluster'; held: string | null; phrases: { restart: string; shutdown: string }
}

type Power = 'restart' | 'shutdown'

function useNas() {
  const [list, setList] = useState<Nas[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    const r = await apiJson<{ data: Nas[] }>(`${API}/instances`)
    if (r.ok) { setList(r.body!.data ?? []); setError(null) } else setError(r.error ?? 'Could not read the NAS list')
  }, [])
  useEffect(() => { void reload() }, [reload])
  return { list, error, reload }
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`
}

function Band({ n }: { n: Nas }) {
  return (
    <div className={`${q.band} ${n.remote ? q.bandRemote : ''}`} role="status">
      <span className="uppercase" style={{ letterSpacing: '0.04em' }}>{n.remote ? 'Remote' : 'Home'} · {n.name}</span>
      {n.remote && n.cluster && <small>Beside {n.cluster.name}{n.via === 'cluster' ? ', reached through its server over SSH' : ''}. Every action here acts on that NAS.</small>}
    </div>
  )
}

// ── one NAS ──────────────────────────────────────────────────────────────────

function NasView({ n }: { n: Nas }) {
  const { role } = useSession()
  const [data, setData] = useState<{ ok: boolean; reading?: Reading; error?: string; held?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState<any>(null)
  const [disk, setDisk] = useState<Disk | null>(null)
  const [smartBusy, setSmartBusy] = useState<number | null>(null)
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null)
  const [power, setPower] = useState<Power | null>(null)
  const [typed, setTyped] = useState('')
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const inFlight = useRef(false)

  const load = useCallback(async (fresh = false) => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true)
    const r = await apiJson<{ data: { ok: boolean; reading?: Reading; error?: string; held?: boolean } }>(`${API}/instances/${n.id}/reading${fresh ? '?fresh=1' : ''}`)
    inFlight.current = false; setBusy(false)
    setData(r.ok ? r.body!.data : { ok: false, error: r.error ?? 'Could not read the NAS.' })
  }, [n.id])

  // A NAS changes slowly: every 60 seconds while the tab is visible.
  useEffect(() => {
    void load()
    const t = setInterval(() => { if (!document.hidden) void load() }, 60_000)
    return () => clearInterval(t)
  }, [load])

  const openDetails = async () => {
    if (detail) return
    const r = await apiJson<{ data: any }>(`${API}/instances/${n.id}/detail`)
    setDetail(r.ok ? r.body!.data : { ok: false, error: r.error })
  }

  const act = async (body: Record<string, unknown>, secure: boolean): Promise<void> => {
    const r = await apiJson<{ data: { message: string } }>(`${API}/instances/${n.id}/${secure ? 'secure-actions' : 'actions'}`, 'POST', body)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void act(body, secure)); return }
    setNote(r.ok ? { text: r.body!.data.message, ok: true } : { text: r.error ?? 'That did not work.', ok: false })
    if (r.ok) void load(true)
  }

  const smartTest = async (d: Disk) => {
    setSmartBusy(d.bay)
    await act({ action: 'smart_test', bay: d.bay }, false)
    setSmartBusy(null)
  }

  const canTest = atLeast(role, 'operator')
  const admin = atLeast(role, 'admin')
  const r = data?.reading
  const u = r ? usage(r) : null

  return (
    <div className={`${vs.page} ${n.remote ? vs.remote : ''}`}>
      <Band n={n} />
      {n.held && <Notice kind="error">{n.held}</Notice>}
      {!data && <BusyNote>Reading {n.name}…</BusyNote>}
      {data && !data.ok && <Notice kind="error">{data.error}{data.held ? '' : ' The page tries again every minute.'}</Notice>}
      {r && u && (
        <>
          <HudHeader level={2} label={`${n.name} overview`} eyebrow={`${n.remote ? 'Remote' : 'Home'} · QNAP · ${r.model ?? 'NAS'}`} title={n.name}
            ring={{ value: u.frac, text: u.total ? `${Math.round(u.frac * 100)}%` : '—', label: 'used' }}
            chips={hudChips(r)}
            actions={
              <div className={q.toolbar}>
                <button type="button" className={vs.btn} disabled={busy} onClick={() => void load(true)}><Icon name="check" size={14} /> {busy ? 'Reading…' : 'Refresh'}</button>
                <small>read {ago(r.fetchedAt)}</small>
              </div>
            } />
          {note && <p className="text-sm" role="status" style={{ color: note.ok ? 'var(--good)' : 'var(--warn-2)' }}>{note.text}</p>}
          {r.missing.length > 0 && (
            <Notice kind="warn">
              Part of the NAS did not answer ({r.missing.join(', ')}). Older firmware lacks some calls, and QTS lets only administrators read some of them;
              the rest of the page is real.
            </Notice>
          )}

          <Panel title="Drive bays" sub={`${r.disks.length} disk${r.disks.length === 1 ? '' : 's'} · tap one for SMART`}>
            <BayView disks={r.disks} warnC={n.diskTempWarnC ?? r.thresholds.diskWarnC ?? 55} errC={r.thresholds.diskErrC} busyBay={smartBusy} onOpen={setDisk} />
          </Panel>

          <Cols>
            <Panel title="Volumes" sub={r.pools.length ? `${r.pools.length} storage pool${r.pools.length === 1 ? '' : 's'}` : undefined}>
              <VolumeRings volumes={r.volumes} pools={r.pools} />
            </Panel>
            <Panel title="Temperature and load">
              <SensorGauges r={r} />
            </Panel>
            <FirmwareCard r={r} readAt={ago(r.fetchedAt)} />
            <Panel title="Network"><NetworkList r={r} /></Panel>
          </Cols>

          <Panel title="Shares" sub={`${r.shares.length}`}><ShareTiles shares={r.shares} /></Panel>

          {admin && (
            <Panel title="Power" sub="admins · master password · typed name">
              <p className="mb-3 text-sm" style={{ color: 'var(--text-soft)' }}>
                Restarting interrupts everyone using {n.name} (shares, backups, media). Shutting down needs someone at the NAS to start it again.
              </p>
              <div className={q.power}>
                <button type="button" className={q.danger} onClick={() => { setTyped(''); setPower('restart') }}><Icon name="power" size={14} /> Restart NAS</button>
                <button type="button" className={q.danger} onClick={() => { setTyped(''); setPower('shutdown') }}><Icon name="power" size={14} /> Shut down NAS</button>
              </div>
            </Panel>
          )}

          <div onClickCapture={() => void openDetails()}>
            <DetailsSection count={detail?.tables?.length ?? 6}>
              {!detail && <BusyNote>Reading…</BusyNote>}
              {detail && !detail.ok && <Notice kind="error">{detail.error}</Notice>}
              {detail?.ok && (detail.tables ?? []).map((t: any) => (
                <section key={t.title} className="rounded-lg border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                  <h3 className="px-3 py-2 font-semibold" style={{ color: 'var(--text-bright)' }}>{t.title} <small style={{ color: 'var(--text-dimmer)' }}>{t.rows.length}</small></h3>
                  {t.rows.length === 0 ? <p className="px-3 pb-3 text-sm" style={{ color: 'var(--text-muted)' }}>{t.empty}</p> : (
                    <div className="overflow-x-auto"><table className="w-full text-sm">
                      <thead><tr>{t.columns.map((c: any) => <th key={c.key} className="px-3 py-1.5 font-mono text-[11px] uppercase" style={{ color: 'var(--text-dim)', textAlign: c.align ?? 'left' }}>{c.label}</th>)}</tr></thead>
                      <tbody>{t.rows.map((row: any, i: number) => (
                        <tr key={i} className="border-t" style={{ borderColor: 'var(--border-dim)' }}>
                          {t.columns.map((c: any) => <td key={c.key} className="px-3 py-1.5" style={{ color: 'var(--text-soft)', textAlign: c.align ?? 'left' }}>{String(row[c.key] ?? '—')}</td>)}
                        </tr>
                      ))}</tbody>
                    </table></div>
                  )}
                </section>
              ))}
            </DetailsSection>
          </div>
        </>
      )}

      {disk && (
        <Sheet title={`Bay ${disk.bay}`} sub={disk.model ?? 'unknown disk'} onClose={() => setDisk(null)}>
          <dl className={q.fw}>
            <dt>Size</dt><dd>{disk.capacity ?? '—'}</dd>
            <dt>Temp</dt><dd>{disk.tempC === null ? '—' : `${disk.tempC} °C`}</dd>
            <dt>SMART</dt><dd style={{ color: disk.smart === 'bad' ? 'var(--crit)' : disk.smart === 'warning' ? 'var(--warn)' : 'var(--good)' }}>{disk.smartText ?? 'not reported'}</dd>
            <dt>Last test</dt><dd>{[disk.lastTest.type, disk.lastTest.status, disk.lastTest.time].filter(Boolean).join(' · ') || 'none recorded'}</dd>
            {disk.serial && <><dt>Serial</dt><dd className="font-mono">{disk.serial}</dd></>}
            {disk.firmware && <><dt>Firmware</dt><dd>{disk.firmware}</dd></>}
          </dl>
          {canTest
            ? <p className="text-sm" style={{ color: 'var(--text-soft)' }}>A quick SMART test reads the disk for a few minutes while it keeps working normally. It changes nothing on it.</p>
            : <p className="text-sm" style={{ color: 'var(--text-dimmer)' }}>SMART tests need the operator role.</p>}
          <div className={vs.sheetRow}>
            <button type="button" className={vs.btn} onClick={() => setDisk(null)}>Close</button>
            {canTest && <button type="button" className={`${vs.btn} ${vs.btnPri}`} disabled={smartBusy !== null}
              onClick={() => { const d = disk; setDisk(null); void smartTest(d) }}>{smartBusy === disk.bay ? 'Starting…' : 'Quick SMART test'}</button>}
          </div>
        </Sheet>
      )}

      {power && (
        <Modal title={power === 'restart' ? 'Restart the NAS' : 'Shut down the NAS'} onClose={() => setPower(null)}>
          <div className="flex flex-col gap-4">
            <p className="text-base font-semibold" style={{ color: 'var(--warn-2)' }}>{n.phrases[power]}</p>
            <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
              This acts on the real NAS{n.remote && n.cluster ? `, beside ${n.cluster.name}` : ''}. It is recorded with your name and sent to your notification channels.
              {power === 'shutdown' ? ' It stays off until someone presses its power button.' : ''}
            </p>
            <label><span style={LABEL}>Type the NAS&apos;s name to confirm: <b>{n.name}</b></span>
              <input style={INPUT} autoFocus autoComplete="off" value={typed} onChange={e => setTyped(e.target.value)} aria-label="NAS name" /></label>
            <div className="flex justify-end gap-2">
              <GhostButton type="button" onClick={() => setPower(null)}>Cancel</GhostButton>
              <PrimaryButton type="button" style={{ background: 'var(--crit)' }} disabled={typed.trim().toLowerCase() !== n.name.toLowerCase()}
                onClick={() => { const a = power; setPower(null); void act({ action: a, confirm: n.phrases[a], typed }, true) }}>{power === 'restart' ? 'Restart' : 'Shut down'}</PrimaryButton>
            </div>
          </div>
        </Modal>
      )}
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const f = reconfirm; setReconfirm(null); f() }} />}
    </div>
  )
}

// ── settings: add, edit, remove (admin, re-confirmed) ────────────────────────

const ADVICE = 'Give HyperProx its own QNAP user, not "admin" and not your own: Control Panel → Users → Create, a long unique password, 2-step verification off for this user (HyperProx cannot answer it), and "No access" on every shared folder so the login cannot read your files. QTS lets only administrators read some health details (SMART, firmware) and restart or shut down, so add the user to the administrators group only if you want those; the page says which parts the NAS would not answer. The login is kept in the vault and never shown again.'

function NasForm({ n, onSaved, onCancel }: { n: Nas | null; onSaved: () => void; onCancel?: () => void }) {
  const { clusters } = useClusters()
  const [f, setF] = useState({
    name: n?.name ?? '', url: n?.url ?? '', username: n?.username ?? '', password: '', clusterId: n?.clusterId ?? '', node: n?.node ?? '',
    reach: n?.reach ?? 'auto', insecureTLS: n?.insecureTLS ?? false, fingerprint: n?.fingerprint ?? '', alerts: n?.alerts ?? true,
    diskTempWarnC: n?.diskTempWarnC === null || n?.diskTempWarnC === undefined ? '' : String(n.diskTempWarnC),
  })
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const [probe, setProbe] = useState<null | { fingerprint: string; subject: string; validTo: string }>(null)
  const set = (k: keyof typeof f, v: any) => setF(x => ({ ...x, [k]: v }))
  const cluster = (clusters ?? []).find(c => c.id === f.clusterId)
  const remote = cluster?.kind === 'remote'

  const readCert = async () => {
    setErr(null)
    const r = await apiJson<{ data: { fingerprint: string; subject: string; validTo: string } }>(`${API}/instances/probe-certificate`, 'POST', { url: f.url })
    if (r.ok) setProbe(r.body!.data); else setErr(r.error ?? 'Could not read the certificate')
  }

  const save = async () => {
    setBusy(true); setErr(null)
    const body: Record<string, unknown> = {
      name: f.name, url: f.url, username: f.username, clusterId: f.clusterId || null, node: remote ? (f.node || null) : null,
      reach: remote ? f.reach : 'auto', insecureTLS: f.insecureTLS, fingerprint: f.fingerprint || null, alerts: f.alerts,
      diskTempWarnC: f.diskTempWarnC === '' ? null : Number(f.diskTempWarnC),
    }
    if (f.password || !n) body.password = f.password
    const r = await apiJson(n ? `${API}/instances/${n.id}` : `${API}/instances`, n ? 'PUT' : 'POST', body)
    setBusy(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void save()); return }
    if (!r.ok) { setErr(r.error ?? 'Could not save'); return }
    set('password', '')
    onSaved()
  }

  const remove = async () => {
    if (!n || !window.confirm(`Remove ${n.name} from HyperProx? Its login is deleted from the vault. The NAS itself is not touched.`)) return
    const r = await apiJson(`${API}/instances/${n.id}`, 'DELETE')
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void remove()); return }
    if (!r.ok) { setErr(r.error ?? 'Could not remove'); return }
    onSaved()
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      <h3 className="font-display font-semibold" style={{ fontSize: 18, color: 'var(--text-bright)' }}>{n ? `Settings: ${n.name}` : 'Add a NAS'}</h3>
      <Notice kind="info">{ADVICE}</Notice>
      <label><span style={LABEL}>Name</span><input style={INPUT} value={f.name} onChange={e => set('name', e.target.value)} placeholder="Office NAS" /></label>
      <label><span style={LABEL}>Address (the NAS web interface)</span><input style={INPUT} value={f.url} onChange={e => set('url', e.target.value)} placeholder="http://10.0.0.20:8080" /></label>
      <label><span style={LABEL}>QNAP user</span><input style={INPUT} autoComplete="off" value={f.username} onChange={e => set('username', e.target.value)} placeholder="hyperprox" /></label>
      <label><span style={LABEL}>Password {n?.hasPassword ? '(saved; leave blank to keep it)' : ''}</span>
        <input style={INPUT} type="password" autoComplete="new-password" value={f.password} onChange={e => set('password', e.target.value)} /></label>
      {n && (f.url !== (n.url ?? '') || f.username !== (n.username ?? '')) && <small style={{ color: 'var(--warn-2)' }}>A new address or user needs the password again: enter it above in the same save.</small>}
      <label><span style={LABEL}>Beside which server</span>
        <select style={INPUT} value={f.clusterId} onChange={e => set('clusterId', e.target.value)}>
          <option value="">Not linked (home)</option>
          {(clusters ?? []).map(c => <option key={c.id} value={c.id}>{c.name}{c.kind === 'remote' ? ' (remote)' : ''}</option>)}
        </select></label>
      {remote && (
        <fieldset className="flex flex-col gap-2 rounded-md border p-3" style={{ borderColor: 'var(--remote)' }}>
          <legend className="px-1 text-sm font-semibold" style={{ color: 'var(--remote)' }}>Reaching it on {cluster!.name}&apos;s network</legend>
          <small style={{ color: 'var(--text-muted)' }}>
            When the NAS is on that server&apos;s LAN, HyperProx cannot reach it directly. Instead it asks through the server, over the SSH login it already has:
            one short session runs curl there and only the answers come back. Nothing is installed or left running on the server.
            Use the NAS&apos;s LAN IP address (http:// is fine: the SSH session is encrypted).
          </small>
          <label><span style={LABEL}>How to reach it</span>
            <select style={INPUT} value={f.reach} onChange={e => set('reach', e.target.value)}>
              <option value="auto">Automatic: through the server for a LAN address</option>
              <option value="cluster">Always through the server</option>
              <option value="direct">Directly (HyperProx has a route to it)</option>
            </select></label>
          <label><span style={LABEL}>Through which node (optional)</span>
            <input style={INPUT} value={f.node} onChange={e => set('node', e.target.value)} placeholder="the first node" /></label>
        </fieldset>
      )}
      {f.url.startsWith('https:') && !(remote && f.reach !== 'direct') && (
        <div className="flex flex-col gap-2 rounded-md border p-3" style={{ borderColor: 'var(--border-strong)' }}>
          <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Certificate</span>
          <small style={{ color: 'var(--text-muted)' }}>A QNAP&apos;s own certificate is self-signed. Read it here, compare the fingerprint with the one your browser shows for that address, and pin it: only that certificate is then accepted.</small>
          {f.fingerprint ? <small className="break-all font-mono" style={{ color: 'var(--good)' }}>Pinned: {f.fingerprint}</small> : null}
          {probe && <small className="break-all font-mono" style={{ color: 'var(--text-soft)' }}>Presented: {probe.fingerprint} ({probe.subject}, valid to {probe.validTo})</small>}
          <div className="flex flex-wrap gap-2">
            <GhostButton type="button" onClick={() => void readCert()}>Read certificate</GhostButton>
            {probe && probe.fingerprint !== f.fingerprint && <GhostButton type="button" onClick={() => set('fingerprint', probe.fingerprint)}>Pin this certificate</GhostButton>}
            {f.fingerprint && <GhostButton type="button" onClick={() => set('fingerprint', '')}>Remove the pin</GhostButton>}
          </div>
          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-soft)' }}>
            <input type="checkbox" checked={f.insecureTLS} onChange={e => set('insecureTLS', e.target.checked)} /> Accept any certificate (not recommended; pin it instead)
          </label>
        </div>
      )}
      <fieldset className="flex flex-col gap-2 rounded-md border p-3" style={{ borderColor: 'var(--border-strong)' }}>
        <legend className="px-1 text-sm font-semibold" style={{ color: 'var(--text)' }}>Alerts</legend>
        <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-soft)' }}>
          <input type="checkbox" checked={f.alerts} onChange={e => set('alerts', e.target.checked)} /> Notify my channels (resources) about this NAS
        </label>
        <small style={{ color: 'var(--text-dimmer)' }}>Once when a disk&apos;s SMART turns bad, a volume is degraded or passes 90% full, or a temperature runs high; once more when it clears. Checked every 5 minutes while HyperProx is unlocked.</small>
        <label><span style={LABEL}>Disk temperature warning (°C, blank: the NAS&apos;s own, or 55)</span>
          <input style={INPUT} inputMode="numeric" value={f.diskTempWarnC} onChange={e => set('diskTempWarnC', e.target.value.replace(/[^0-9]/g, ''))} /></label>
      </fieldset>
      {err && <Notice kind="error">{err}</Notice>}
      <div className="flex flex-wrap justify-end gap-2">
        {n && <GhostButton type="button" onClick={() => void remove()} style={{ color: 'var(--crit-soft)' }}>Remove</GhostButton>}
        {onCancel && <GhostButton type="button" onClick={onCancel}>Cancel</GhostButton>}
        <PrimaryButton type="button" disabled={busy || !f.name || !f.url || !f.username || (!n && !f.password)} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</PrimaryButton>
      </div>
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const fn = reconfirm; setReconfirm(null); fn() }} />}
    </div>
  )
}

// ── the plug-in page ─────────────────────────────────────────────────────────

export function QnapPage() {
  const { role } = useSession()
  const { list, error, reload } = useNas()
  const [sel, setSel] = useState<string | null>(null)
  const [tab, setTab] = useState<'nas' | 'settings'>('nas')
  const [adding, setAdding] = useState(false)
  const n = list?.find(i => i.id === sel) ?? list?.[0] ?? null
  const admin = atLeast(role, 'admin')

  return (
    <div className="min-h-full overflow-x-hidden" style={{ background: 'var(--ground)' }}>
      {admin && (
        <div className="flex flex-wrap items-center gap-3 px-4 pb-2 sm:px-8">
          <span className="ml-auto"><PrimaryButton type="button" onClick={() => setAdding(true)}>Add a NAS</PrimaryButton></span>
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-4 px-4 py-4 sm:px-8">
        <PluginSwitcher current="qnap" />
        {error && <Notice kind="error">{error}</Notice>}
        {!list && !error && <BusyNote>Reading…</BusyNote>}
        {adding && <NasForm n={null} onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); void reload() }} />}
        {list && list.length === 0 && !adding && <Notice kind="info">No NAS is set up yet.{admin ? ' Use "Add a NAS".' : ' An admin can add one.'}</Notice>}
        {list && n && (
          <>
            {list.length > 1 && (
              <div className={q.tabs} role="tablist" aria-label="NAS">
                {list.map(i => (
                  <button key={i.id} role="tab" aria-selected={i.id === n.id} onClick={() => setSel(i.id)} className={`${q.tab} ${i.remote ? q.tabRemote : ''}`}>
                    {i.name}{i.remote ? ' · remote' : ''}
                  </button>
                ))}
              </div>
            )}
            {admin && (
              <div className={q.views} role="tablist" aria-label="View">
                <button role="tab" aria-selected={tab === 'nas'} onClick={() => setTab('nas')}>NAS</button>
                <button role="tab" aria-selected={tab === 'settings'} onClick={() => setTab('settings')}>Settings</button>
              </div>
            )}
            {(tab === 'nas' || !admin) && <NasView key={n.id} n={n} />}
            {tab === 'settings' && admin && <NasForm key={n.id} n={n} onSaved={() => void reload()} />}
          </>
        )}
      </div>
    </div>
  )
}
