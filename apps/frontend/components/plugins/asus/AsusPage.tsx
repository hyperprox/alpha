'use client'

// =============================================================================
//  HyperProx — ASUS router: each router, visual first
//
//  Phone first: one column of panels. The HUD on top (model, firmware, uptime,
//  CPU and RAM), then the internet connection with live rates, the Wi-Fi bands,
//  what needs attention, and the connected devices; the plain tables fold into
//  Details at the bottom.
//
//  Roles: a viewer sees names, connection types, signal and online time; MAC
//  addresses, client addresses and the WAN address are for operators and up
//  (the API leaves them out below that). Reboot is admin only: the master
//  password, the phrase and the router's name typed.
//
//  Adding a router asks for the address, the admin user and its password and
//  nothing else: HyperProx finds the router, pins an https certificate on
//  first use, and reads the model and firmware itself.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { BusyNote, GhostButton, INPUT, LABEL, Modal, Notice, PrimaryButton } from '@/components/vault/ui'
import { HudHeader, Panel, Cols, Icon, styles as vs } from '@/components/visual/kit'
import { DetailsSection, PluginSwitcher } from '@/components/plugins/visual/plugin-kit'
import { BandTiles, DeviceList, HealthList, UplinkPanel, WanPanel, hudChips, routes, type Reading } from './AsusVisual'
import a from './asus.module.css'

const API = '/api/plugins/asus'

/** `by` is only sent to operators and up. */
interface LastAction { action: 'reboot'; at: string; by?: string; state: 'sending' | 'sent' | 'unconfirmed' | 'back' | 'not_back'; detail: string | null }

export interface Router {
  id: string; name: string; insecureTLS: boolean; fingerprint?: string | null; model: string | null; firmware: string | null
  url?: string; username?: string; hasPassword?: boolean
  held: string | null; phrase: string; lastAction: LastAction | null
}

type Answer = { ok: boolean; reading?: Reading; error?: string; held?: boolean; lastAction?: LastAction | null }

function useRouters() {
  const [list, setList] = useState<Router[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    const r = await apiJson<{ data: Router[] }>(`${API}/instances`)
    if (r.ok) { setList(r.body!.data ?? []); setError(null) } else setError(r.error ?? 'Could not read the router list')
  }, [])
  useEffect(() => { void reload() }, [reload])
  return { list, error, reload }
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`
}

const ACTION_WORD: Record<LastAction['state'], string> = {
  sending: 'is being asked to restart',
  sent: 'is restarting; HyperProx is waiting for it to come back',
  unconfirmed: 'was asked to restart but did not confirm it; HyperProx is checking',
  back: 'came back',
  not_back: 'has not come back as expected',
}

// ── one router ───────────────────────────────────────────────────────────────

function RouterView({ n }: { n: Router }) {
  const { role } = useSession()
  const [data, setData] = useState<Answer | null>(null)
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState<any>(null)
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const [trail, setTrail] = useState<{ down: number[]; up: number[] }>({ down: [], up: [] })
  const inFlight = useRef(false)

  const load = useCallback(async (fresh = false) => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true)
    const r = await apiJson<{ data: Answer }>(`${API}/instances/${n.id}/reading${fresh ? '?fresh=1' : ''}`)
    inFlight.current = false; setBusy(false)
    const d = r.ok ? r.body!.data : { ok: false, error: r.error ?? 'Could not read the router.' }
    setData(d)
    const w = d.reading?.wan
    if (w && w.downBps !== null && w.upBps !== null) setTrail(t => ({ down: [...t.down, w.downBps!].slice(-24), up: [...t.up, w.upBps!].slice(-24) }))
  }, [n.id])

  // Rates are live: every 10 seconds while the tab is visible (the API shares one router session between readings).
  useEffect(() => {
    void load()
    const t = setInterval(() => { if (!document.hidden) void load() }, 10_000)
    return () => clearInterval(t)
  }, [load])

  const openDetails = async () => {
    if (detail) return
    const r = await apiJson<{ data: any }>(`${API}/instances/${n.id}/detail`)
    setDetail(r.ok ? r.body!.data : { ok: false, error: r.error })
  }

  const reboot = async (): Promise<void> => {
    const body = { action: 'reboot', confirm: n.phrase, typed }
    const r = await apiJson<{ data: { message: string } }>(`${API}/instances/${n.id}/actions`, 'POST', body)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void reboot()); return }
    setTyped('')
    setNote(r.ok ? { text: r.body!.data.message, ok: true } : { text: r.error ?? 'That did not work.', ok: false })
  }

  const admin = atLeast(role, 'admin')
  const operator = atLeast(role, 'operator')
  const r = data?.reading
  const last = data?.lastAction ?? n.lastAction

  return (
    <div className={vs.page}>
      {n.held && <Notice kind="error">{n.held}</Notice>}
      {!data && <BusyNote>Reading {n.name}…</BusyNote>}
      {data && !data.ok && <Notice kind="error">{data.error}{data.held ? '' : ' The page tries again every 10 seconds.'}</Notice>}
      {last && (
        <Notice kind={last.state === 'not_back' ? 'error' : last.state === 'back' ? 'info' : 'warn'}>
          Reboot{last.by ? ` by ${last.by}` : ''} {ago(last.at)}: {n.name} {ACTION_WORD[last.state]}{last.detail ? ` (${last.detail})` : ''}.
        </Notice>
      )}
      {r && (
        <>
          <HudHeader level={2} label={`${n.name} overview`} eyebrow={`ASUS · ${r.firmware.flavour === 'merlin' ? 'Asuswrt-Merlin' : 'Asuswrt'}`} title={r.model ?? n.name}
            ring={{ value: r.cpuPct === null ? 0 : r.cpuPct / 100, text: r.cpuPct === null ? '—' : `${Math.round(r.cpuPct)}%`, label: 'CPU' }}
            chips={hudChips(r)}
            actions={
              <div className={a.toolbar}>
                <button type="button" className={vs.btn} disabled={busy} onClick={() => void load(true)}><Icon name="check" size={14} /> {busy ? 'Reading…' : 'Refresh'}</button>
                <small>{n.name} · read {ago(r.fetchedAt)}</small>
              </div>
            } />
          {note && <p className="text-sm" role="status" style={{ color: note.ok ? 'var(--good)' : 'var(--warn-2)' }}>{note.text}</p>}
          {r.missing.length > 0 && (
            <Notice kind="warn">Part of the router did not answer ({r.missing.join(', ')}). Some models and firmware builds leave a call out; the rest of the page is real.</Notice>
          )}

          {routes(r) ? (
            <Panel title="Internet" sub={r.wan.downBps === null ? 'rates appear on the next reading' : 'live · from the router’s counters'}>
              <WanPanel r={r} trail={trail} />
              {!operator && <p className="mt-3 text-sm" style={{ color: 'var(--text-dimmer)' }}>Addresses are shown to operators and admins.</p>}
            </Panel>
          ) : (
            <Panel title="Internet" sub={r.mode?.label ?? 'access point'}>
              <UplinkPanel r={r} />
            </Panel>
          )}

          <Cols>
            <Panel title="Wi-Fi" sub={`${r.bands.filter(b => b.enabled).length} of ${r.bands.length} radios on`}>
              <BandTiles bands={r.bands} />
            </Panel>
            <Panel title={r.health.level === 'good' ? 'Health' : 'Needs attention'} sub={r.health.reasons.length ? `${r.health.reasons.length}` : undefined}>
              <HealthList r={r} />
              {r.update.available && <p className="mt-3 text-sm" style={{ color: 'var(--text-soft)' }}>Install firmware from the router itself (Administration → Firmware Upgrade). HyperProx does not update router firmware.</p>}
            </Panel>
          </Cols>

          <Panel title="Connected devices" sub={`${r.devices.length} online${operator ? '' : ' · MACs and addresses for operators'}`}>
            <DeviceList devices={r.devices} bands={r.bands} offline={r.offlineKnown} />
          </Panel>

          {admin && (
            <Panel title="Reboot" sub="admins · master password · typed name">
              <p className="mb-3 text-sm" style={{ color: 'var(--text-soft)' }}>
                Rebooting drops Wi-Fi and the internet for everyone for 2 to 4 minutes, HyperProx included if it reaches the internet through {n.name}.
              </p>
              <button type="button" className={a.danger} disabled={last?.state === 'sent' || last?.state === 'sending'} onClick={() => { setTyped(''); setConfirming(true) }}><Icon name="power" size={14} /> Reboot router</button>
            </Panel>
          )}

          <div onClickCapture={() => void openDetails()}>
            <DetailsSection count={detail?.tables?.length ?? 4}>
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

      {confirming && (
        <Modal title="Reboot the router" onClose={() => setConfirming(false)}>
          <div className="flex flex-col gap-4">
            <p className="text-base font-semibold" style={{ color: 'var(--warn-2)' }}>{n.phrase}</p>
            <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
              This restarts the real router. It is recorded with your name, sent to your notification channels, and HyperProx checks afterwards that it came back.
            </p>
            <label><span style={LABEL}>Type the router&apos;s name to confirm: <b>{n.name}</b></span>
              <input style={INPUT} autoFocus autoComplete="off" value={typed} onChange={e => setTyped(e.target.value)} aria-label="Router name" /></label>
            <div className="flex justify-end gap-2">
              <GhostButton type="button" onClick={() => setConfirming(false)}>Cancel</GhostButton>
              <PrimaryButton type="button" style={{ background: 'var(--crit)' }} disabled={typed.trim().toLowerCase() !== n.name.toLowerCase()}
                onClick={() => { setConfirming(false); void reboot() }}>Reboot</PrimaryButton>
            </div>
          </div>
        </Modal>
      )}
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const f = reconfirm; setReconfirm(null); f() }} />}
    </div>
  )
}

// ── settings: add, edit, remove (admin, re-confirmed) ────────────────────────

const ADVICE = 'Enter the router’s address and its admin login (Administration → System on the router). HyperProx signs in once to check it, reads the model and firmware itself, and keeps the login in the vault; it is never shown again. ASUS routers allow one admin session at a time, so HyperProx signs out whenever it has not needed the router for two minutes. If you are signed in to the router’s own page at the same moment, one of the two may be asked to sign in again.'

function RouterForm({ n, onSaved, onCancel }: { n: Router | null; onSaved: () => void; onCancel?: () => void }) {
  const [f, setF] = useState({ name: n?.name ?? '', url: n?.url ?? '', username: n?.username ?? '', password: '', insecureTLS: n?.insecureTLS ?? false, fingerprint: n?.fingerprint ?? '' })
  const [probe, setProbe] = useState<null | { fingerprint: string; subject: string; validTo: string }>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [finding, setFinding] = useState(false)
  const [found, setFound] = useState<Array<{ url: string; model: string | null }> | null>(null)
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const set = (k: keyof typeof f, v: any) => setF(x => ({ ...x, [k]: v }))
  const https = f.url.trim().toLowerCase().startsWith('https:')
  const pinChanged = f.fingerprint !== (n?.fingerprint ?? '')
  // Loosening how the router is recognised needs its password in the same save (the API refuses it otherwise).
  const loosening = !!n && ((!!n.fingerprint && !f.fingerprint) || (f.insecureTLS && !n.insecureTLS))

  const readCert = async () => {
    setErr(null)
    const r = await apiJson<{ data: { fingerprint: string; subject: string; validTo: string } }>(`${API}/instances/probe-certificate`, 'POST', { url: f.url })
    if (r.ok) setProbe(r.body!.data); else setErr(r.error ?? 'Could not read the certificate')
  }

  const find = async () => {
    setFinding(true); setErr(null)
    const r = await apiJson<{ data: Array<{ url: string; model: string | null }> }>(`${API}/detect`, 'POST', {})
    setFinding(false)
    if (!r.ok) { setErr(r.error ?? 'Could not look for a router'); return }
    const list = r.body!.data ?? []
    setFound(list)
    if (list.length === 1 && !f.url) set('url', list[0].url)
  }

  const save = async () => {
    setBusy(true); setErr(null); setOk(null)
    const body: Record<string, unknown> = { url: f.url, username: f.username, insecureTLS: f.insecureTLS }
    if (f.name.trim() || n) body.name = f.name.trim() || undefined
    if (f.password || !n) body.password = f.password
    // Only a fingerprint a person read and confirmed here is sent; a new router with none is pinned on first use.
    if (pinChanged) body.fingerprint = f.fingerprint || null
    const r = await apiJson<{ data: Router & { pinnedNow: boolean } }>(n ? `${API}/instances/${n.id}` : `${API}/instances`, n ? 'PUT' : 'POST', body)
    setBusy(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void save()); return }
    if (!r.ok) { setErr(r.error ?? 'Could not save'); return }
    const d = r.body!.data
    setOk(`Saved ${d.name}${d.model ? `: ${d.model}` : ''}${d.firmware ? `, firmware ${d.firmware}` : ''}.${d.pinnedNow ? ' Its certificate is pinned: only that certificate is accepted from now on.' : ''}`)
    setF(x => ({ ...x, password: '' }))
    setProbe(null)
    onSaved()
  }

  const remove = async () => {
    if (!n || !window.confirm(`Remove ${n.name} from HyperProx? Its login is deleted from the vault. The router itself is not touched.`)) return
    const r = await apiJson(`${API}/instances/${n.id}`, 'DELETE')
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void remove()); return }
    if (!r.ok) { setErr(r.error ?? 'Could not remove'); return }
    onSaved()
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      <h3 className="font-display font-semibold" style={{ fontSize: 18, color: 'var(--text-bright)' }}>{n ? `Settings: ${n.name}` : 'Add a router'}</h3>
      <Notice kind="info">{ADVICE}</Notice>
      <label><span style={LABEL}>Address (the router&apos;s web page)</span>
        <input style={INPUT} value={f.url} onChange={e => set('url', e.target.value)} placeholder="http://10.0.0.1" /></label>
      {!n && (
        <div className="flex flex-wrap items-center gap-2">
          <GhostButton type="button" disabled={finding} onClick={() => void find()}>{finding ? 'Looking…' : 'Find my router'}</GhostButton>
          {found && found.length === 0 && <small style={{ color: 'var(--text-muted)' }}>No ASUS router answered at this network&apos;s gateway. Type its address instead.</small>}
          {found && found.map(x => (
            <GhostButton key={x.url} type="button" onClick={() => set('url', x.url)}>{x.model ?? 'ASUS router'} at {x.url}</GhostButton>
          ))}
        </div>
      )}
      <label><span style={LABEL}>Admin user</span><input style={INPUT} autoComplete="off" value={f.username} onChange={e => set('username', e.target.value)} placeholder="admin" /></label>
      <label><span style={LABEL}>Password {n?.hasPassword ? '(saved; leave blank to keep it)' : ''}</span>
        <input style={INPUT} type="password" autoComplete="new-password" value={f.password} onChange={e => set('password', e.target.value)} /></label>
      {n && (f.url !== (n.url ?? '') || f.username !== (n.username ?? '')) && <small style={{ color: 'var(--warn-2)' }}>A new address or user needs the password again: enter it above in the same save.</small>}
      <label><span style={LABEL}>Name (optional: the model, when blank)</span>
        <input style={INPUT} value={f.name} onChange={e => set('name', e.target.value)} placeholder={n?.model ?? 'Living room router'} /></label>
      {https ? (
        <div className="flex flex-col gap-2 rounded-md border p-3" style={{ borderColor: 'var(--border-strong)' }}>
          <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Certificate</span>
          <small style={{ color: 'var(--text-muted)' }}>An ASUS router&apos;s own certificate is self-signed. {n ? 'HyperProx accepts only the pinned one. If the router has a new certificate, read it here, compare the fingerprint with the one your browser shows for that address, and pin it.' : 'HyperProx pins the one it presents when you save, and accepts only that one afterwards. To check it first, read it here and compare it with what your browser shows.'}</small>
          {f.fingerprint ? <small className="break-all font-mono" style={{ color: 'var(--good)' }}>{pinChanged ? 'To pin' : 'Pinned'}: {f.fingerprint}</small>
            : n?.fingerprint ? <small style={{ color: 'var(--warn-2)' }}>The pin will be removed.</small> : null}
          {probe && <small className="break-all font-mono" style={{ color: 'var(--text-soft)' }}>Presented now: {probe.fingerprint} ({probe.subject}, valid to {probe.validTo})</small>}
          <div className="flex flex-wrap gap-2">
            <GhostButton type="button" onClick={() => void readCert()}>Read certificate</GhostButton>
            {probe && probe.fingerprint !== f.fingerprint && <GhostButton type="button" onClick={() => set('fingerprint', probe.fingerprint)}>I compared it: pin this certificate</GhostButton>}
            {f.fingerprint && <GhostButton type="button" onClick={() => set('fingerprint', '')}>Remove the pin</GhostButton>}
          </div>
          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-soft)' }}>
            <input type="checkbox" checked={f.insecureTLS} onChange={e => set('insecureTLS', e.target.checked)} /> Accept any certificate (not recommended; the pin is safer)
          </label>
        </div>
      ) : f.url ? <small style={{ color: 'var(--text-dimmer)' }}>http:// is accepted for a router on your own network only. Use https:// for anything reached over the internet.</small> : null}
      {loosening && !f.password && <small style={{ color: 'var(--warn-2)' }}>{n?.fingerprint && !f.fingerprint ? 'Removing the pin' : 'Accepting any certificate'} needs the router&apos;s password again: enter it above in the same save.</small>}
      {err && <Notice kind="error">{err}</Notice>}
      {ok && <Notice kind="info">{ok}</Notice>}
      {busy && <BusyNote>Signing in to the router once to check the login…</BusyNote>}
      <div className="flex flex-wrap justify-end gap-2">
        {n && <GhostButton type="button" onClick={() => void remove()} style={{ color: 'var(--crit-soft)' }}>Remove</GhostButton>}
        {onCancel && <GhostButton type="button" onClick={onCancel}>Cancel</GhostButton>}
        <PrimaryButton type="button" disabled={busy || !f.url || !f.username || (!n && !f.password)} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</PrimaryButton>
      </div>
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const fn = reconfirm; setReconfirm(null); fn() }} />}
    </div>
  )
}

// ── the plug-in page ─────────────────────────────────────────────────────────

export function AsusPage() {
  const { role } = useSession()
  const { list, error, reload } = useRouters()
  const [sel, setSel] = useState<string | null>(null)
  const [tab, setTab] = useState<'router' | 'settings'>('router')
  const [adding, setAdding] = useState(false)
  const n = list?.find(i => i.id === sel) ?? list?.[0] ?? null
  const admin = atLeast(role, 'admin')

  return (
    <div className="min-h-full overflow-x-hidden" style={{ background: 'var(--ground)' }}>
      {admin && (
        <div className="flex flex-wrap items-center gap-3 px-4 pb-2 sm:px-8">
          <span className="ml-auto"><PrimaryButton type="button" onClick={() => setAdding(true)}>Add a router</PrimaryButton></span>
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-4 px-4 py-4 sm:px-8">
        <PluginSwitcher current="asus" />
        {error && <Notice kind="error">{error}</Notice>}
        {!list && !error && <BusyNote>Reading…</BusyNote>}
        {adding && <RouterForm n={null} onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); void reload() }} />}
        {list && list.length === 0 && !adding && <Notice kind="info">No ASUS router is set up yet.{admin ? ' Use "Add a router".' : ' An admin can add one.'}</Notice>}
        {list && n && (
          <>
            {list.length > 1 && (
              <div className={a.tabs} role="tablist" aria-label="Routers">
                {list.map(i => (
                  <button key={i.id} role="tab" aria-selected={i.id === n.id} onClick={() => setSel(i.id)} className={a.tab}>{i.name}</button>
                ))}
              </div>
            )}
            {admin && (
              <div className={a.views} role="tablist" aria-label="View">
                <button role="tab" aria-selected={tab === 'router'} onClick={() => setTab('router')}>Router</button>
                <button role="tab" aria-selected={tab === 'settings'} onClick={() => setTab('settings')}>Settings</button>
              </div>
            )}
            {(tab === 'router' || !admin) && <RouterView key={n.id} n={n} />}
            {tab === 'settings' && admin && <RouterForm key={n.id} n={n} onSaved={() => void reload()} />}
          </>
        )}
      </div>
    </div>
  )
}
