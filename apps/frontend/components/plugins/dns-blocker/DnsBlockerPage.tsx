'use client'

// =============================================================================
//  HyperProx — Pi-hole and AdGuard Home: each blocker, visual first
//
//  Phone first: one column of panels. The shield and its numbers on top, then what needs a look (each problem with its fix
//  button), the 24-hour query flow, the domains blocked most (an Allow button each), the busiest devices (hideable), the
//  upstream servers, the block lists, and "point your network at it". The blocker is connected by HyperProx itself when it
//  finds one; adding one by hand is the exception.
//
//  Actions: pause blocking, turn it back on and update the lists (operator and above); restart, allow a domain, switch the
//  upstream and the guest DNS setting (admin, the master password asked again). A confirm says exactly what changes.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { BusyNote, GhostButton, INPUT, LABEL, Modal, Notice, PrimaryButton } from '@/components/vault/ui'
import { HudHeader, Icon, Panel, Cols, styles as vs } from '@/components/visual/kit'
import { PluginSwitcher } from '@/components/plugins/visual/plugin-kit'
import { AutoConnectPanel, AutoConnectedNote } from '@/components/plugins/AutoConnect'
import { Clients, ListFreshness, PauseControls, Problems, QueryFlow, TopBlocked, UpstreamRack } from './DnsBlockerVisual'
import d from './dns-blocker.module.css'
import {
  KIND_NAME, PRESET_CHOICES, SHIELD_WORD, ago, allowPhrase, cleanDomainInput, hudChips, looksLikeDomain, pointNetworkSteps, shieldTone,
  type ActionName, type DnsKind, type Instance, type Problem, type Reading,
} from './logic'

type Retry = () => void

interface Guest { kind: 'lxc' | 'qemu'; vmid: number; name: string }

type Dialog =
  | { kind: 'allow'; domain: string }
  | { kind: 'switch'; initial?: string }
  | { kind: 'restart' }
  | { kind: 'guests'; on: boolean }
  | { kind: 'howto' }

// ── one blocker ──────────────────────────────────────────────────────────────

function BlockerView({ kind, inst, onChanged }: { kind: DnsKind; inst: Instance; onChanged: () => void }) {
  const API = `/api/plugins/${kind}`
  const name = KIND_NAME[kind]
  const { role } = useSession()
  const who: string = role ?? 'viewer'
  const admin = atLeast(role, 'admin')
  const operator = atLeast(role, 'operator')
  const [data, setData] = useState<{ ok: boolean; reading?: Reading; error?: string; held?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [acting, setActing] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [reconfirm, setReconfirm] = useState<null | Retry>(null)
  const inFlight = useRef(false)

  const load = useCallback(async (fresh = false) => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true)
    const r = await apiJson<{ data: { ok: boolean; reading?: Reading; error?: string; held?: boolean } }>(`${API}/instances/${inst.id}/reading${fresh ? '?fresh=1' : ''}`)
    inFlight.current = false; setBusy(false)
    setData(r.ok ? r.body!.data : { ok: false, error: r.error ?? `Could not read ${name}.` })
  }, [API, inst.id, name])

  useEffect(() => {
    void load()
    const t = setInterval(() => { if (!document.hidden) void load() }, 60_000)
    return () => clearInterval(t)
  }, [load])

  const act = async (body: Record<string, unknown>, secure: boolean, id: string | null = null): Promise<boolean> => {
    setActing(id ?? String(body.action)); setNote(null)
    const r = await apiJson<{ data: { message: string } }>(`${API}/instances/${inst.id}/${secure ? 'secure-actions' : 'actions'}`, 'POST', body)
    setActing(null)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void act(body, secure, id)); return false }
    setNote(r.ok ? { text: r.body!.data.message, ok: true } : { text: r.error ?? 'That did not work.', ok: false })
    if (r.ok) { void load(true); onChanged() }
    return r.ok
  }

  const fix = (p: Problem) => {
    if (!p.fix) return
    if (p.fix.action === 'restart_service') { setDialog({ kind: 'restart' }); return }
    if (p.fix.action === 'switch_upstream') { setDialog({ kind: 'switch', initial: String(p.fix.params?.to ?? '') }); return }
    void act({ action: p.fix.action, ...(p.fix.params ?? {}) }, p.fix.secure, p.id)
  }

  const toggleHide = async () => {
    const r = await apiJson(`${API}/instances/${inst.id}`, 'PUT', { hideClients: !inst.hideClients })
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void toggleHide()); return }
    if (!r.ok) { setNote({ text: r.error ?? 'That did not work.', ok: false }); return }
    onChanged(); void load(true)
  }

  const r = data?.reading
  const address = inst.url ? inst.url.replace(/^https?:\/\//, '') : null
  const tone = r ? shieldTone(r) : 'dim'

  return (
    <div className={vs.page}>
      {inst.held && <Notice kind="error">{inst.held}</Notice>}
      {!data && <BusyNote>Reading {inst.name}…</BusyNote>}
      {data && !data.ok && <Notice kind="error">{data.error}{data.held ? '' : ' The page tries again every minute.'}</Notice>}
      {r && (
        <>
          <HudHeader level={2} label={`${inst.name} overview`} eyebrow={`${name}${r.version ? ` · ${r.version}` : ''}`} title={inst.name}
            ring={{ value: r.protection.on ? Math.min(1, r.totals.percentBlocked / 100) : 0, text: r.protection.on ? `${r.totals.percentBlocked}%` : 'OFF', label: 'blocked' }}
            chips={hudChips(r)}
            actions={
              <div className={d.toolbar}>
                <button type="button" className={vs.btn} disabled={busy} onClick={() => void load(true)}><Icon name="check" size={14} /> {busy ? 'Reading…' : 'Refresh'}</button>
                <small>read {ago(r.fetchedAt)}</small>
              </div>
            } />
          {note && <p className="text-sm" role="status" style={{ color: note.ok ? 'var(--good)' : 'var(--warn-2)' }}>{note.text}</p>}
          {inst.autoConnected && <AutoConnectedNote evidence={inst.autoConnected.evidence} />}
          {r.newerVersion && <Notice kind="info">A newer release ({r.newerVersion}) is out. HyperProx pins what it installs, so it does not update by itself: see the Updates page.</Notice>}
          {r.missing.length > 0 && <Notice kind="warn">Part of {name} did not answer ({r.missing.join(', ')}). The rest of the page is real.</Notice>}

          <Panel title="Needs a look" sub={`${r.problems.filter(p => p.severity !== 'info').length} to fix`} label="Problems and their fixes">
            <Problems problems={r.problems} role={who} busy={acting} onFix={fix} onHowTo={() => setDialog({ kind: 'howto' })} />
          </Panel>

          <Panel title="Blocking" label="Pause and resume" sub={SHIELD_WORD[tone]}>
            <PauseControls r={r} role={who} busy={!!acting} onPause={m => void act({ action: 'pause', minutes: m }, false)} onResume={() => void act({ action: 'resume' }, false)} />
            {operator && (
              <div className={d.actions} style={{ marginTop: 12 }}>
                <button type="button" className={d.mini} disabled={!!acting} onClick={() => void act({ action: 'update_lists' }, false)}>{acting === 'update_lists' ? 'Updating…' : 'Update the block lists now'}</button>
              </div>
            )}
          </Panel>

          <Panel title="The last 24 hours" sub={`${r.totals.queries.toLocaleString('en')} queries today`}><QueryFlow r={r} /></Panel>

          <Cols>
            <Panel title="Blocked most" sub={`${r.totals.blocked.toLocaleString('en')} blocked`}>
              <TopBlocked r={r} canAllow={admin} onAllow={domain => setDialog({ kind: 'allow', domain })} />
            </Panel>
            <Panel title="Devices" sub={inst.hideClients ? 'hidden' : undefined}>
              <Clients r={r} canHide={admin} hidden={inst.hideClients} onToggleHide={() => void toggleHide()} />
            </Panel>
          </Cols>

          <Cols>
            <Panel title="Upstream DNS" sub={r.totals.avgMs !== null ? `${r.totals.avgMs} ms on average` : undefined}><UpstreamRack r={r} /></Panel>
            <Panel title="Block lists"><ListFreshness r={r} /></Panel>
          </Cols>

          <Panel title="Point your network at it" label="How to use it">
            <ol className={d.steps}>{pointNetworkSteps(address, name).map((s, i) => <li key={i}>{s}</li>)}</ol>
            {admin && (
              <div className={d.guestDns} style={{ marginTop: 12 }}>
                {inst.guestDns
                  ? <><span className="text-sm" style={{ color: 'var(--good)' }}>Guests HyperProx installs from now on use this blocker first.</span>
                      <button type="button" className={d.mini} onClick={() => setDialog({ kind: 'guests', on: false })}>Stop</button></>
                  : <button type="button" className={d.mini} onClick={() => setDialog({ kind: 'guests', on: true })}>Use for HyperProx-installed guests</button>}
              </div>
            )}
          </Panel>

          {admin && inst.guest && (
            <Panel title="Service" label="Restart">
              <div className={d.actions}><button type="button" className={d.mini} onClick={() => setDialog({ kind: 'restart' })}>Restart {name}</button></div>
            </Panel>
          )}
        </>
      )}

      {dialog?.kind === 'allow' && <AllowDialog domain={dialog.domain} onClose={() => setDialog(null)} onRun={async (dom, confirm) => { const ok = await act({ action: 'allow_domain', domain: dom, confirm }, true); if (ok) setDialog(null) }} />}
      {dialog?.kind === 'switch' && <SwitchDialog initial={dialog.initial} reading={r} onClose={() => setDialog(null)} onRun={async to => { const ok = await act({ action: 'switch_upstream', to }, true); if (ok) setDialog(null) }} />}
      {dialog?.kind === 'restart' && (
        <Modal title={`Restart ${name}`} onClose={() => setDialog(null)} footer={
          <div className="flex flex-wrap justify-end gap-2">
            <GhostButton type="button" onClick={() => setDialog(null)}>Cancel</GhostButton>
            <PrimaryButton type="button" disabled={!inst.guest} onClick={async () => { const ok = await act({ action: 'restart_service' }, true); if (ok) setDialog(null) }}>Restart (master password)</PrimaryButton>
          </div>}>
          <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
            This restarts {name} inside its container. DNS answers stop for a few seconds, and devices using it may notice a short pause.
            HyperProx checks that it answers again before it says it worked.{!inst.guest && ' HyperProx does not know which container it runs in: edit the settings and pick one first.'}
          </p>
        </Modal>
      )}
      {dialog?.kind === 'guests' && (
        <Modal title={dialog.on ? 'Use for HyperProx-installed guests' : 'Stop using it for guests'} onClose={() => setDialog(null)} footer={
          <div className="flex flex-wrap justify-end gap-2">
            <GhostButton type="button" onClick={() => setDialog(null)}>Cancel</GhostButton>
            <PrimaryButton type="button" onClick={async () => { const ok = await act({ action: dialog.on ? 'use_for_guests' : 'stop_using_for_guests' }, true); if (ok) setDialog(null) }}>{dialog.on ? 'Use it' : 'Stop'} (master password)</PrimaryButton>
          </div>}>
          <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
            {dialog.on
              ? 'HyperProx gives each guest it installs a list of DNS servers (Settings, Naming). This puts the blocker first in that list. Guests that already exist are not changed, and no other machine is touched. The servers they had stay after it as a fallback.'
              : 'This puts the DNS servers HyperProx gives new guests back to what they were before. Guests that already exist are not changed.'}
          </p>
        </Modal>
      )}
      {dialog?.kind === 'howto' && (
        <Modal title="Point your network at it" onClose={() => setDialog(null)} footer={<div className="flex justify-end"><PrimaryButton type="button" onClick={() => setDialog(null)}>Done</PrimaryButton></div>}>
          <ol className={d.steps}>{pointNetworkSteps(address, name).map((s, i) => <li key={i}>{s}</li>)}</ol>
        </Modal>
      )}
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const f = reconfirm; setReconfirm(null); f() }} />}
    </div>
  )
}

function AllowDialog({ domain, onClose, onRun }: { domain: string; onClose: () => void; onRun: (domain: string, confirm: string) => void }) {
  const [dom, setDom] = useState(domain)
  const [typed, setTyped] = useState('')
  const clean = cleanDomainInput(dom)
  const phrase = allowPhrase(clean)
  const ok = looksLikeDomain(clean) && typed.trim() === phrase
  return (
    <Modal title="Allow a domain" onClose={onClose} footer={
      <div className="flex flex-wrap justify-end gap-2">
        <GhostButton type="button" onClick={onClose}>Cancel</GhostButton>
        <PrimaryButton type="button" disabled={!ok} onClick={() => onRun(clean, typed.trim())}>Allow it (master password)</PrimaryButton>
      </div>}>
      <div className={d.form}>
        <p className="text-sm" style={{ color: 'var(--text-soft)' }}>An allowed domain is never blocked again, for every device that uses this blocker. Do this only for a site you trust that is broken because of the block.</p>
        <label><span style={LABEL}>Domain</span><input style={INPUT} autoCapitalize="none" autoComplete="off" value={dom} onChange={e => { setDom(e.target.value); setTyped('') }} /></label>
        <label><span style={LABEL}>Type <code>{phrase}</code> to confirm</span><input style={INPUT} autoCapitalize="none" autoComplete="off" value={typed} onChange={e => setTyped(e.target.value)} /></label>
        {clean && !looksLikeDomain(clean) && <Notice kind="warn">That does not look like one domain name, such as ads.example.com.</Notice>}
      </div>
    </Modal>
  )
}

function SwitchDialog({ initial, reading, onClose, onRun }: { initial?: string; reading?: Reading; onClose: () => void; onRun: (to: string) => void }) {
  const healthyOffered = !!reading && reading.upstreams.some(u => u.state === 'failing') && reading.upstreams.some(u => u.state === 'ok' || u.state === 'slow')
  const [to, setTo] = useState(initial && (initial === 'healthy' ? healthyOffered : true) ? initial : healthyOffered ? 'healthy' : 'cloudflare')
  return (
    <Modal title="Switch the upstream DNS servers" onClose={onClose} footer={
      <div className="flex flex-wrap justify-end gap-2">
        <GhostButton type="button" onClick={onClose}>Cancel</GhostButton>
        <PrimaryButton type="button" onClick={() => onRun(to)}>Switch (master password)</PrimaryButton>
      </div>}>
      <div className={d.form}>
        <p className="text-sm" style={{ color: 'var(--text-soft)' }}>These are the servers it asks for names it does not block. Everything that uses this blocker follows the change. HyperProx reads it back to check it took.</p>
        <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <legend style={LABEL}>Use</legend>
          {healthyOffered && (
            <label className="flex items-start gap-2 text-sm"><input type="radio" name="to" checked={to === 'healthy'} onChange={() => setTo('healthy')} />
              <span>Only the servers that answer<span className="block text-[12px]" style={{ color: 'var(--text-dim)' }}>{reading!.upstreams.filter(u => u.state === 'ok' || u.state === 'slow').map(u => u.address).join(', ')}</span></span></label>
          )}
          {PRESET_CHOICES.map(p => (
            <label key={p.id} className="flex items-start gap-2 text-sm"><input type="radio" name="to" checked={to === p.id} onChange={() => setTo(p.id)} />
              <span>{p.label}<span className="block text-[12px]" style={{ color: 'var(--text-dim)' }}>{p.servers}</span></span></label>
          ))}
        </fieldset>
      </div>
    </Modal>
  )
}

// ── adding and changing one ──────────────────────────────────────────────────

function InstanceForm({ kind, inst, onSaved, onCancel }: { kind: DnsKind; inst: Instance | null; onSaved: () => void; onCancel?: () => void }) {
  const API = `/api/plugins/${kind}`
  const name = KIND_NAME[kind]
  const [guests, setGuests] = useState<Guest[] | null>(null)
  const [f, setF] = useState({ name: inst?.name ?? name, url: inst?.url ?? '', username: '', password: '', guest: inst?.guest ? `${inst.guest.kind}:${inst.guest.vmid}` : '', insecure: !!inst?.insecureTLS })
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reconfirm, setReconfirm] = useState<Retry | null>(null)
  const set = (k: keyof typeof f, v: any) => setF(x => ({ ...x, [k]: v }))
  useEffect(() => { void apiJson<{ data: Guest[] }>(`${API}/guests`).then(r => setGuests(r.ok ? r.body!.data : [])) }, [API])
  const guest = () => { if (!f.guest) return null; const [k, v] = f.guest.split(':'); return { kind: k, vmid: Number(v) } }
  const save = async () => {
    setBusy(true); setErr(null)
    const body: Record<string, unknown> = {
      name: f.name, guest: guest(), ...(f.url ? { url: f.url } : {}), ...(kind === 'adguard' && f.username ? { username: f.username } : {}),
      ...(f.password ? { password: f.password } : {}), insecureTLS: f.insecure,
    }
    const r = await apiJson(inst ? `${API}/instances/${inst.id}` : `${API}/instances`, inst ? 'PUT' : 'POST', body)
    setBusy(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void save()); return }
    if (!r.ok) { setErr(r.error ?? 'Could not save.'); return }
    set('password', '')
    onSaved()
  }
  const remove = async () => {
    if (!inst || !window.confirm(`Remove ${inst.name} from HyperProx? Its saved login is deleted from the vault. ${name} itself is not touched.`)) return
    const r = await apiJson(`${API}/instances/${inst.id}`, 'DELETE')
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void remove()); return }
    if (!r.ok) { setErr(r.error ?? 'Could not remove it.'); return }
    onSaved()
  }
  const missing = !f.name || (!inst && (!f.url || !f.password || (kind === 'adguard' && !f.username)))
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      <h3 className="font-display font-semibold" style={{ fontSize: 18, color: 'var(--text-bright)' }}>{inst ? `Settings: ${inst.name}` : `Add a ${name}`}</h3>
      {inst?.autoConnected && <AutoConnectedNote evidence={inst.autoConnected.evidence} />}
      {!inst && <Notice kind="info">HyperProx connects every {name} it finds on the cluster by itself, with the password from the vault. Add one here only when it was not found, or its login is not in the vault.</Notice>}
      <div className={d.grid2}>
        <label><span style={LABEL}>Name</span><input style={INPUT} value={f.name} onChange={e => set('name', e.target.value)} /></label>
        <label><span style={LABEL}>Address of its web page</span><input style={INPUT} autoCapitalize="none" value={f.url} onChange={e => set('url', e.target.value)} placeholder="http://192.0.2.10" /></label>
      </div>
      <div className={d.grid2}>
        {kind === 'adguard' && <label><span style={LABEL}>User name</span><input style={INPUT} autoCapitalize="none" autoComplete="off" value={f.username} onChange={e => set('username', e.target.value)} placeholder="admin" /></label>}
        <label><span style={LABEL}>Password {inst?.hasPassword ? '(saved; blank keeps it)' : ''}</span><input style={INPUT} type="password" autoComplete="new-password" value={f.password} onChange={e => set('password', e.target.value)} /></label>
      </div>
      <label><span style={LABEL}>Runs in (for the restart button; optional)</span>
        <select style={INPUT} value={f.guest} onChange={e => set('guest', e.target.value)}>
          <option value="">{guests ? 'Not set' : 'Reading the guests…'}</option>
          {(guests ?? []).map(g => <option key={`${g.kind}:${g.vmid}`} value={`${g.kind}:${g.vmid}`}>{g.kind === 'lxc' ? 'CT' : 'VM'} {g.vmid} {g.name}</option>)}
        </select></label>
      <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--text)' }}><input type="checkbox" checked={f.insecure} onChange={e => set('insecure', e.target.checked)} />
        <span>Accept a self-signed certificate<span className="block text-[12px]" style={{ color: 'var(--text-dim)' }}>Only for an https:// address on your own network.</span></span></label>
      {err && <Notice kind="error">{err}</Notice>}
      <div className="flex flex-wrap justify-end gap-2">
        {inst && <GhostButton type="button" onClick={() => void remove()} style={{ color: 'var(--crit-soft)' }}>Remove</GhostButton>}
        {onCancel && <GhostButton type="button" onClick={onCancel}>Cancel</GhostButton>}
        <PrimaryButton type="button" disabled={busy || missing} onClick={() => void save()}>{busy ? 'Checking…' : inst ? 'Save' : 'Check and add'}</PrimaryButton>
      </div>
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const fn = reconfirm; setReconfirm(null); fn() }} />}
    </div>
  )
}

// ── the plug-in page ─────────────────────────────────────────────────────────

export function DnsBlockerPage({ kind }: { kind: DnsKind }) {
  const API = `/api/plugins/${kind}`
  const name = KIND_NAME[kind]
  const { role } = useSession()
  const admin = atLeast(role, 'admin')
  const [list, setList] = useState<Instance[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [tab, setTab] = useState<'health' | 'settings'>('health')
  const [adding, setAdding] = useState(false)
  const reload = useCallback(async () => {
    const r = await apiJson<{ data: Instance[] }>(`${API}/instances`)
    if (r.ok) { setList(r.body!.data ?? []); setError(null) } else setError(r.error ?? 'Could not read the list.')
  }, [API])
  useEffect(() => { void reload() }, [reload])
  const s = list?.find(i => i.id === sel) ?? list?.[0] ?? null
  return (
    <div className="min-h-full overflow-x-hidden" style={{ background: 'var(--ground)' }}>
      {admin && <div className="flex flex-wrap items-center gap-3 pb-2"><span className="ml-auto"><GhostButton type="button" onClick={() => setAdding(true)}>Add one by hand</GhostButton></span></div>}
      <div className="flex min-w-0 flex-col gap-4 py-4">
        <PluginSwitcher current={kind} />
        {error && <Notice kind="error">{error}</Notice>}
        {!list && !error && <BusyNote>Reading…</BusyNote>}
        {admin && <AutoConnectPanel plugins={[kind]} onChanged={() => void reload()} />}
        {adding && <InstanceForm kind={kind} inst={null} onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); void reload() }} />}
        {list && list.length === 0 && !adding && (
          <Notice kind="info">No {name} found yet. HyperProx connects one by itself as soon as it finds it{admin ? ': install one from the Catalogue, or add one by hand if it is somewhere the scan cannot reach' : ''}.</Notice>
        )}
        {list && s && (
          <>
            {list.length > 1 && <div className={d.tabs} role="tablist" aria-label={`${name} instances`}>{list.map(i => <button key={i.id} role="tab" aria-selected={i.id === s.id} onClick={() => setSel(i.id)} className={d.tab}>{i.name}</button>)}</div>}
            {admin && (
              <div className={d.views} role="tablist" aria-label="View">
                <button role="tab" aria-selected={tab === 'health'} onClick={() => setTab('health')}>Overview</button>
                <button role="tab" aria-selected={tab === 'settings'} onClick={() => setTab('settings')}>Settings</button>
              </div>
            )}
            {(tab === 'health' || !admin) && <BlockerView key={s.id} kind={kind} inst={s} onChanged={() => void reload()} />}
            {tab === 'settings' && admin && <InstanceForm key={s.id} kind={kind} inst={s} onSaved={() => void reload()} />}
          </>
        )}
      </div>
    </div>
  )
}
