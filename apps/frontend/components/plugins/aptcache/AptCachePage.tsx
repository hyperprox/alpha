'use client'

// =============================================================================
//  HyperProx — the package cache plug-in page (apt-cacher-ng)
//
//  Phone first, one column of panels. The HUD (how much comes from the cache);
//  the cache HyperProx connected by itself after a Catalogue install; Updates'
//  "Use the package cache" switch (automatic, on, off; nodes apart); what is
//  wrong, with a fix button each; the picture (AptCachePanel); then the cache
//  itself: clean-up, restart, prove it, grow its disk, who may use it.
//
//  Everything here is admin. The Updates setting, who may use the cache and
//  writing or removing the setting on every guest also ask for the master
//  password; every fix is confirmed first. API tokens cannot change anything.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { apiJson, atLeast, type ApiResult } from '@/lib/api'
import { useSession } from '@/lib/session'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { BusyNote, GhostButton, INPUT, LABEL, Modal, Notice, PrimaryButton } from '@/components/vault/ui'
import { HudHeader, Icon, Panel, Pill, styles as vs } from '@/components/visual/kit'
import { PluginSwitcher } from '@/components/plugins/visual/plugin-kit'
import { AutoConnectPanel, AutoConnectedNote } from '@/components/plugins/AutoConnect'
import { PreviewDialog } from '@/components/guest-config/PreviewDialog'
import { AptCachePanel } from './AptCachePanel'
import a from './aptcache.module.css'
import {
  CHECK_TITLE, MODE_WORDS, checkNetworks, diskGb, diskUse, expiryWords, pct, plural, size,
  type Instance, type Problem, type Reading, type SelfCheck, type UseMode, type UseView,
} from './logic'

const API = '/api/plugins/apt-cacher-ng'

// ── pieces (exported for the tests) ─────────────────────────────────────────

/** Updates' "Use the package cache": a three-way switch, what it means now, and nodes apart. */
export function UseSwitch({ v, busy, onMode, onNodes }: { v: UseView; busy: boolean; onMode: (m: UseMode) => void; onNodes: (on: boolean) => void }) {
  return (
    <div className={a.rows}>
      <div className={a.modes} role="group" aria-label="Use the package cache">
        {(['auto', 'on', 'off'] as UseMode[]).map(m => (
          <button key={m} type="button" className={a.mode} aria-pressed={v.mode === m} disabled={busy} title={MODE_WORDS[m].hint} onClick={() => v.mode !== m && onMode(m)}>{MODE_WORDS[m].label}</button>
        ))}
      </div>
      <p className={a.state} data-on={v.effective ? 'true' : 'false'} role="status"><span><b>{v.effective ? 'In use.' : 'Not in use.'}</b> {v.why}</span></p>
      {v.clients > 0 && <p className={a.quiet}>{plural(v.clients, 'machine')} carr{v.clients === 1 ? 'ies' : 'y'} HyperProx&apos;s cache setting now.</p>}
      <label className={a.check}>
        <input type="checkbox" checked={v.nodes} disabled={busy} onChange={e => onNodes(e.target.checked)} />
        <span><b>Proxmox nodes too</b> · off by default. Only an apt setting of HyperProx&apos;s own is added (with the same fallback); no repository file is changed and no package is held or released.</span>
      </label>
    </div>
  )
}

/** Problems, worst first, each with its fix. */
export function ProblemList({ problems, busy, onFix }: { problems: Problem[]; busy: string | null; onFix: (p: Problem) => void }) {
  if (!problems.length) return <p className="text-sm" style={{ color: 'var(--good)' }}><Icon name="check" size={14} /> No problems: it runs, it has room, and it cleans up after itself.</p>
  const list = [...problems].sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'bad' ? -1 : 1))
  return (
    <ul className={a.problems}>
      {list.map(p => (
        <li key={p.id} className={a.problem} data-sev={p.severity}>
          <Icon name={p.severity === 'bad' ? 'error' : 'warn'} size={18} label={p.severity === 'bad' ? 'Problem' : 'Warning'} />
          <div><b>{p.title}</b><p>{p.detail}</p></div>
          {p.fix && <div className={a.fixRow}><button type="button" className={`${vs.btn} ${p.severity === 'bad' ? vs.btnPri : ''}`} disabled={busy === p.id} onClick={() => onFix(p)}>{busy === p.id ? 'Working…' : p.fix.label}</button></div>}
        </li>
      ))}
    </ul>
  )
}

export function SelfCheckList({ checks }: { checks: SelfCheck[] }) {
  return (
    <ul className={a.rules} aria-label="Self-check results">
      {checks.map(c => <li key={c.id} data-state={c.state}><span><b>{c.state === 'ok' ? 'Passed' : c.state === 'fail' ? 'FAILED' : 'Note'}: {CHECK_TITLE[c.id] ?? c.id}</b><small>{c.detail}</small></span></li>)}
    </ul>
  )
}

// ── the page ────────────────────────────────────────────────────────────────

export function AptCachePage() {
  const { role } = useSession()
  const admin = atLeast(role, 'admin')
  const [list, setList] = useState<Instance[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [head, setHead] = useState<Reading | null>(null)

  const reload = useCallback(async () => {
    const r = await apiJson<{ data: Instance[] }>(`${API}/caches`)
    if (r.ok) { setList(r.body!.data); setError(null) } else setError(r.error ?? 'Could not read the package caches.')
  }, [])
  useEffect(() => { if (admin) void reload() }, [admin, reload])

  if (!admin) return (
    <div className={vs.page}><PluginSwitcher current="apt-cacher-ng" />
      <Notice kind="info">The package cache plug-in needs the admin role: it shows which guests use the cache and changes their apt settings.</Notice></div>
  )

  const lookNow = async () => {
    setBusy(true); setNote(null)
    const r = await apiJson<{ data: { waited: string | null } }>('/api/auto-connect/run', 'POST', {})
    setBusy(false)
    if (!r.ok) setNote({ text: r.error ?? 'Could not look again.', ok: false })
    else if (r.body!.data.waited === 'locked') setNote({ text: 'HyperProx is locked; it connects the cache once it is unlocked.', ok: false })
    await reload()
  }

  const current = list?.[0] ?? null
  const chips = head ? [
    { label: 'saved', value: size(head.totals.hitBytes), tone: 'good' as const },
    { label: 'fetches', value: head.totals.requests, tone: 'accent' as const },
    { label: 'disk', value: pct(diskUse(head)), tone: (diskUse(head) ?? 0) >= 0.9 ? 'warn' as const : 'dim' as const },
    { label: 'guests', value: head.clients.filter(c => c.kind === 'guest' || c.kind === 'node').length },
  ] : [{ label: 'caches', value: list?.length ?? '…', tone: 'accent' as const }]

  return (
    <div className={vs.page}>
      <PluginSwitcher current="apt-cacher-ng" />
      <HudHeader eyebrow="Plug-in · Updates" title="Package cache" icon="arr"
        ring={head ? { value: head.byteHitRatio ?? 0, text: pct(head.byteHitRatio), label: 'from cache' } : undefined}
        chips={chips} />
      {error && <Notice kind="error">{error}</Notice>}
      {note && <p className="text-sm" role="status" style={{ color: note.ok ? 'var(--good)' : 'var(--warn-2)' }}>{note.text}</p>}
      {!list && !error && <BusyNote>Looking for the package cache…</BusyNote>}

      <AutoConnectPanel plugins={['apt-cacher-ng']} onChanged={() => void reload()} />
      <UpdatesPanel caches={list ?? []} />

      {list && !list.length && (
        <Panel title="Not installed yet">
          <p className="text-sm" style={{ color: 'var(--text-soft)' }}>Install the package cache from the <a href="/catalogue" style={{ color: 'var(--hx-accent)' }}>Catalogue</a> (Apps → Package cache). When Updates runs, every package is then fetched from the internet once instead of once per guest. HyperProx connects it here and turns it on for Updates by itself.</p>
          <div className={a.toolbar}><GhostButton type="button" disabled={busy} onClick={() => void lookNow()}>{busy ? 'Looking…' : 'Look again now'}</GhostButton></div>
        </Panel>
      )}
      {current && <InstanceView key={current.id} i={current} onChanged={reload} onReading={setHead} />}
    </div>
  )
}

/** Updates' setting for the home cluster, and the two actions on every guest. */
function UpdatesPanel({ caches }: { caches: Instance[] }) {
  const [v, setV] = useState<UseView | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; ok: boolean; results?: Array<{ name: string; outcome: string }> } | null>(null)
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const [confirm, setConfirm] = useState<null | { title: string; text: string; label: string; run: () => void }>(null)

  const load = useCallback(async () => {
    const r = await apiJson<{ data: UseView }>(`${API}/use?cluster=home`)
    if (r.ok) { setV(r.body!.data); setErr(null) } else setErr(r.error ?? 'Could not read the Updates setting.')
  }, [])
  useEffect(() => { void load() }, [load, caches.length])

  const secure = (res: ApiResult, again: () => void) => {
    if (res.status === 403 && res.code === 'reconfirm_required') { setReconfirm(() => again); return false }
    return true
  }
  const save = async (body: Record<string, unknown>): Promise<void> => {
    setBusy('use'); setNote(null)
    const res = await apiJson<{ data: UseView }>(`${API}/use?cluster=home`, 'PUT', body)
    setBusy(null)
    if (!secure(res, () => void save(body))) return
    if (res.ok) { setV(res.body!.data); setNote({ text: 'Saved. It takes effect on each guest the next time Updates runs there.', ok: true }) }
    else setNote({ text: res.error ?? 'Nothing was changed.', ok: false })
  }
  const fleet = async (kind: 'repair' | 'remove'): Promise<void> => {
    setBusy(kind); setNote(null)
    const res = await apiJson<{ data: { message: string; results: Array<{ name: string; outcome: string }> } }>(`${API}/guests/${kind}`, 'POST', {})
    setBusy(null)
    if (!secure(res, () => void fleet(kind))) return
    if (res.ok) { setNote({ text: res.body!.data.message, ok: true, results: res.body!.data.results }); void load() }
    else setNote({ text: res.error ?? 'Nothing was changed.', ok: false })
  }

  return (
    <Panel title="Use the package cache" sub="Updates · master password">
      {err && <Notice kind="error">{err}</Notice>}
      {!v && !err && <BusyNote>Reading…</BusyNote>}
      {v && <UseSwitch v={v} busy={busy === 'use'}
        onMode={m => m === 'off'
          ? setConfirm({ title: 'Turn the package cache off', text: 'Guests fetch their packages directly again, and HyperProx takes its setting out of each guest the next time Updates runs there.', label: 'Turn off', run: () => void save({ mode: 'off' }) })
          : void save({ mode: m })}
        onNodes={on => on
          ? setConfirm({ title: 'Point Proxmox nodes at the cache too', text: 'Before apt runs on a node, Updates adds one apt setting of its own (/etc/apt/apt.conf.d/01hyperprox-cache) that uses the cache only while it answers. No repository file is changed and nothing is held or released. Turning this off takes it out again.', label: 'Include nodes', run: () => void save({ nodes: true }) })
          : void save({ nodes: false })} />}
      <div className={a.toolbar} style={{ marginTop: 12 }}>
        <GhostButton type="button" disabled={!!busy || !v || v.mode === 'off' || !caches.length} onClick={() => setConfirm({ title: 'Repair guests\' cache setting', text: 'Write the cache setting again on every guest Updates looks after (and on nodes, if they are included), and check each one can reach the cache. Guests with their own apt proxy are left alone.', label: 'Repair now', run: () => void fleet('repair') })}>{busy === 'repair' ? 'Repairing…' : 'Repair guests\' setting'}</GhostButton>
        <GhostButton type="button" disabled={!!busy} onClick={() => setConfirm({ title: 'Remove from all guests', text: 'Take HyperProx\'s cache setting out of every guest Updates looks after now (and out of any node it was put on). Nothing else in their apt configuration is touched.', label: 'Remove everywhere', run: () => void fleet('remove') })}>{busy === 'remove' ? 'Removing…' : 'Remove from all guests'}</GhostButton>
      </div>
      {note && <p className="text-sm" role="status" style={{ color: note.ok ? 'var(--good)' : 'var(--warn-2)', marginTop: 8 }}>{note.text}</p>}
      {note?.results?.length ? <ul className={a.results} aria-label="Per guest">{note.results.map(r => <li key={r.name}><b>{r.name}</b>: {r.outcome}</li>)}</ul> : null}
      <p className={a.quiet}>A dead cache never stops an update: a guest that cannot reach it fetches directly. A sick one (full, or failing its check) is skipped once HyperProx notices. Only the Debian and Ubuntu archives go through it; HTTPS and other repositories are fetched directly.</p>
      {confirm && <ConfirmModal c={confirm} onClose={() => setConfirm(null)} />}
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const fn = reconfirm; setReconfirm(null); fn() }} />}
    </Panel>
  )
}

function ConfirmModal({ c, onClose }: { c: { title: string; text: string; label: string; run: () => void }; onClose: () => void }) {
  return (
    <Modal title={c.title} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm" style={{ color: 'var(--text-soft)' }}>{c.text}</p>
        <div className="flex justify-end gap-2">
          <GhostButton type="button" onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton type="button" onClick={() => { onClose(); c.run() }}>{c.label}</PrimaryButton>
        </div>
      </div>
    </Modal>
  )
}

function InstanceView({ i, onChanged, onReading }: { i: Instance; onChanged: () => Promise<void>; onReading: (r: Reading | null) => void }) {
  const base = `${API}/caches/${i.id}`
  const [r, setR] = useState<Reading | null>(null)
  const [readErr, setReadErr] = useState<string | null>(null)
  const [problems, setProblems] = useState<Problem[] | null>(null)
  const [checks, setChecks] = useState<SelfCheck[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null)
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const [confirm, setConfirm] = useState<null | { title: string; text: string; label: string; run: () => void }>(null)
  const [grow, setGrow] = useState<null | { gb: string; preview: boolean }>(null)
  const [nets, setNets] = useState('')
  const [hours, setHours] = useState(24)

  const say = (text: string, ok: boolean) => setNote({ text, ok })
  const secure = (res: ApiResult, again: () => void): boolean => {
    if (res.status === 403 && res.code === 'reconfirm_required') { setReconfirm(() => again); return false }
    return true
  }

  const load = useCallback(async (fresh = false) => {
    const res = await apiJson<{ data: Reading }>(`${base}/reading?hours=${hours}${fresh ? '&fresh=1' : ''}`)
    if (res.ok) { setR(res.body!.data); setReadErr(null); onReading(res.body!.data); setNets(n => n || res.body!.data.allow.join(', ')) }
    else { setReadErr(res.error ?? 'Could not read the package cache.'); onReading(null) }
  }, [base, hours, onReading])
  const loadProblems = useCallback(async () => {
    const res = await apiJson<{ data: Problem[] }>(`${base}/problems`)
    setProblems(res.ok ? res.body!.data : [{ id: 'unreachable', severity: 'bad', title: 'Could not check', detail: res.error ?? 'The check failed.', fix: { id: 'recheck', label: 'Check again' } }])
  }, [base])
  useEffect(() => { void load(); void loadProblems() }, [load, loadProblems])
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 60_000)
    return () => clearInterval(t)
  }, [load])
  useEffect(() => () => onReading(null), [onReading])

  const after = async () => { await Promise.all([load(true), loadProblems()]) }

  const act = async (action: 'restart' | 'maint' | 'selftest' | 'recheck') => {
    setBusy(action); setNote(null)
    const res = await apiJson<{ data: { message: string; checks?: SelfCheck[] } }>(`${base}/actions`, 'POST', { action })
    setBusy(null)
    if (res.ok) { say(res.body!.data.message, !res.body!.data.checks?.some(c => c.state === 'fail')); if (res.body!.data.checks) setChecks(res.body!.data.checks) }
    else say(res.error ?? 'That did not work.', false)
    if (action !== 'selftest') await after()
  }

  const fleetRepair = async (): Promise<void> => {
    setBusy('guests_stuck'); setNote(null)
    const res = await apiJson<{ data: { message: string } }>(`${API}/guests/repair`, 'POST', {})
    setBusy(null)
    if (!secure(res, () => void fleetRepair())) return
    say(res.ok ? res.body!.data.message : res.error ?? 'Nothing was changed.', res.ok)
    await loadProblems()
  }

  const save = async (body: Record<string, unknown>, done: string): Promise<void> => {
    setBusy('settings'); setNote(null)
    const res = await apiJson<{ data: { message: string } }>(`${base}/settings`, 'PUT', body)
    setBusy(null)
    if (!secure(res, () => void save(body, done))) return
    if (res.ok) { say(done, true); await after() } else say(res.error ?? 'Nothing was changed.', false)
  }

  const fix = (p: Problem) => {
    const go = () => {
      const id = p.fix!.id
      if (id === 'restart') return void act('restart')
      if (id === 'maint') return void act('maint')
      if (id === 'repair_guests') return void fleetRepair()
      if (id === 'grow_disk') return setGrow({ gb: String(r ? diskGb(r) * 2 : 100), preview: false })
      void after()
    }
    if (p.fix?.confirm) setConfirm({ title: p.fix.label, text: p.fix.confirm, label: p.fix.label, run: go })
    else go()
  }

  const disconnect = async () => {
    const res = await apiJson(`${base}`, 'DELETE')
    if (res.ok) await onChanged(); else say(res.error ?? 'Not disconnected.', false)
  }

  const netCheck = checkNetworks(nets)
  const ex = r ? expiryWords(r, Date.now()) : null
  const growTo = Number(grow?.gb)
  const growOk = r ? Number.isInteger(growTo) && growTo > diskGb(r) && growTo <= 4000 : false

  return (
    <>
      <div className={a.band} role="status">
        <span className="uppercase" style={{ letterSpacing: '0.04em' }}>{i.name} · CT {i.vmid} · {i.node}</span>
        <span>{r ? (r.active ? 'running' : 'NOT RUNNING') : readErr ? 'not reachable' : 'reading…'}</span>
        {r?.version && <small>apt-cacher-ng {r.version}</small>}
      </div>
      {note && <p className="text-sm" role="status" style={{ color: note.ok ? 'var(--good)' : 'var(--warn-2)' }}>{note.text}</p>}
      {readErr && <Notice kind="error">{readErr}</Notice>}

      <Panel title="Health" actions={<button type="button" className={vs.btn} onClick={() => { setProblems(null); void loadProblems() }}>Check again</button>}>
        {!problems ? <BusyNote>Checking…</BusyNote> : <ProblemList problems={problems} busy={busy} onFix={fix} />}
        {ex && <p className={a.quiet}><Pill tone={ex.tone}>clean-up</Pill> {ex.text}</p>}
      </Panel>

      {r && (
        <>
          <div className={a.toolbar} role="group" aria-label="Time window">
            {[6, 24, 168, 720].map(h => <button key={h} type="button" className={vs.btn} aria-pressed={hours === h} onClick={() => setHours(h)}>{h < 48 ? `${h} h` : `${h / 24} days`}</button>)}
          </div>
          <AptCachePanel r={r} />
        </>
      )}

      <Panel title="Locked down" sub="what the install proved" actions={<button type="button" className={vs.btn} disabled={busy === 'selftest'} onClick={() => void act('selftest')}>{busy === 'selftest' ? 'Checking…' : 'Prove it now'}</button>}>
        {checks ? <SelfCheckList checks={checks} /> : <p className={a.quiet}>&quot;Prove it now&quot; runs the install&apos;s check again in the cache: it listens only on its LAN address, refuses networks that are not allowed, fetches a Debian index through itself, passes HTTPS through, and keeps its admin actions behind the password.</p>}
      </Panel>

      <Panel title="Settings" sub="master password">
        <div className={a.rows}>
          <label>
            <span style={LABEL}>Who may use it (networks)</span>
            <input style={INPUT} value={nets} onChange={e => setNets(e.target.value)} placeholder="10.0.5.0/24" aria-invalid={!netCheck.ok} />
          </label>
          {!netCheck.ok && nets && <p className="text-xs" style={{ color: 'var(--warn-2)' }}>{netCheck.problem}</p>}
          <div className={a.toolbar}>
            <GhostButton type="button" disabled={!netCheck.ok || busy === 'settings' || netCheck.list.join(' ') === r?.allow.join(' ')} onClick={() => void save({ allow: netCheck.list }, 'Saved: only those networks may use the cache now.')}>Save networks</GhostButton>
            <small>Private networks only, written as the network (10.0.5.0/24).</small>
          </div>
          <label className={a.check}>
            <input type="checkbox" checked={!!r?.report} disabled={!r || busy === 'settings'} onChange={e => void save({ report: e.target.checked }, e.target.checked ? 'The admin page is on your network again.' : 'The admin page is off the network; only HyperProx\'s helper reaches it.')} />
            <span><b>Admin page on your network</b> · apt-cacher-ng&apos;s own statistics page{i.url ? ` (${i.url}/acng-report.html)` : ''}. Its actions always need the password in the vault item {i.vaultItem}.</span>
          </label>
        </div>
      </Panel>

      <Panel title="Package cache">
        {i.autoConnected && <AutoConnectedNote evidence={i.autoConnected.evidence} />}
        <div className={a.toolbar}>
          <GhostButton type="button" disabled={busy === 'maint'} onClick={() => setConfirm({ title: 'Clean out old packages', text: 'Run apt-cacher-ng\'s clean-up (expiry) now. It removes packages no index refers to any more; it also runs by itself once a day.', label: 'Clean up', run: () => void act('maint') })}>{busy === 'maint' ? 'Cleaning…' : 'Run the clean-up'}</GhostButton>
          <GhostButton type="button" disabled={busy === 'restart'} onClick={() => setConfirm({ title: 'Restart the cache', text: 'apt-cacher-ng starts again. A guest fetching right now goes direct for a moment.', label: 'Restart', run: () => void act('restart') })}>{busy === 'restart' ? 'Restarting…' : 'Restart'}</GhostButton>
          <GhostButton type="button" disabled={!r} onClick={() => setGrow({ gb: String(r ? diskGb(r) * 2 : 100), preview: false })}>Grow the disk</GhostButton>
          <GhostButton type="button" onClick={() => setConfirm({ title: 'Disconnect', text: `HyperProx stops showing ${i.name} here, and Updates stops pointing guests at it. The cache itself keeps running, and HyperProx will not connect it again by itself.`, label: 'Disconnect', run: () => void disconnect() })}>Disconnect</GhostButton>
        </div>
        {r && <p className={a.quiet}><Pill tone={r.active ? 'good' : 'bad'}>{r.active ? 'running' : 'stopped'}</Pill> {r.listen ?? ''}:3142 · cache disk {r.disk ? size(r.disk.sizeKb * 1024) : '—'} · {r.allow.join(', ')}</p>}
        <p className={a.quiet}>Figures come from apt-cacher-ng&apos;s own log, added up inside the container: no request or address leaves it.</p>
      </Panel>

      {grow && !grow.preview && r && (
        <Modal title="Grow the cache disk" onClose={() => setGrow(null)}>
          <div className="flex flex-col gap-4">
            <p className="text-sm" style={{ color: 'var(--text-soft)' }}>The cache disk is {diskGb(r)} GB. It grows while the cache keeps running, through the same guest settings change as anywhere else in HyperProx (a preview first, then your master password). A disk can only grow, never shrink.</p>
            <label><span style={LABEL}>New size (GB)</span><input style={INPUT} type="number" min={diskGb(r) + 1} max={4000} value={grow.gb} onChange={e => setGrow({ gb: e.target.value, preview: false })} aria-invalid={!growOk} /></label>
            <div className="flex justify-end gap-2">
              <GhostButton type="button" onClick={() => setGrow(null)}>Cancel</GhostButton>
              <PrimaryButton type="button" disabled={!growOk} onClick={() => setGrow({ ...grow, preview: true })}>Preview</PrimaryButton>
            </div>
          </div>
        </Modal>
      )}
      {grow?.preview && (
        <PreviewDialog guest={{ node: i.node, type: 'lxc', vmid: i.vmid, name: i.name }} title="Grow the cache disk"
          change={{ kind: 'edit', edit: { mounts: { resize: [{ key: 'mp0', sizeGb: growTo }] } } }}
          onClose={() => setGrow(null)} onApplied={() => { setGrow(null); void after() }} />
      )}
      {confirm && <ConfirmModal c={confirm} onClose={() => setConfirm(null)} />}
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const fn = reconfirm; setReconfirm(null); fn() }} />}
    </>
  )
}
