'use client'

// =============================================================================
//  HyperProx — the 3proxy plug-in page
//
//  Phone first, one column of panels. The HUD; the proxies HyperProx connected
//  by itself after a Catalogue install; then for one proxy: "How to use this
//  proxy" (its address and where each device takes it), the shield (the rules
//  in force and the self-check that proves them), what is wrong with a fix
//  button each, the traffic picture (lib: ForwardProxyPanel), the users (each
//  password in the vault, revealed through the vault), and its settings.
//
//  Everything here is admin. A new user, a new password, a removed user and
//  every setting are confirmed first, as are reload and letting it reach
//  your network.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { apiJson, atLeast, type ApiResult } from '@/lib/api'
import { useSession } from '@/lib/session'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { BusyNote, CopyButton, GhostButton, INPUT, LABEL, Modal, Notice, PrimaryButton } from '@/components/vault/ui'
import { HudHeader, Icon, Panel, Pill, styles as vs } from '@/components/visual/kit'
import { PluginSwitcher } from '@/components/plugins/visual/plugin-kit'
import { AutoConnectPanel, AutoConnectedNote } from '@/components/plugins/AutoConnect'
import { ForwardProxyPanel } from './ForwardProxyPanel'
import f from './fwdproxy.module.css'
import {
  CHECK_TITLE, USER_RE, checkNetworks, endpoints, fieldFor, howTo, plural, rate, ruleWords, size,
  type Instance, type Problem, type Reading, type SelfCheck,
} from './logic'

// ── pieces (exported for the tests) ─────────────────────────────────────────

/** The plain "How to use this proxy" box: the address, then where each kind of device takes it. */
export function HowToUse({ listen, r }: { listen: string | null; r?: Reading | null }) {
  const eps = endpoints(listen, r)
  return (
    <div className={f.howto}>
      <div className={f.endpoints} role="list" aria-label="Proxy addresses">
        {eps.map(e => (
          <div key={e.protocol} className={f.endpoint} role="listitem">
            <small>{e.protocol} proxy</small>
            <b>{e.host}:{e.port}</b>
            <span className={f.toolbar}><CopyButton text={`${e.host}:${e.port}`} label="Copy address" /></span>
          </div>
        ))}
      </div>
      <p className={f.quiet}>Every app or device signs in with a proxy user and its password (below). Only devices on {r?.allow.length ? r.allow.join(', ') : 'the allowed networks'} can use it.</p>
      <dl className={f.steps}>
        {howTo(listen, r).map(s => <div key={s.where} style={{ display: 'contents' }}><dt>{s.where}</dt><dd>{s.what}</dd></div>)}
      </dl>
    </div>
  )
}

/** The rules in force, with the self-check's results beside them. */
export function Shield({ r, checks }: { r: Reading; checks: SelfCheck[] | null }) {
  const rules = ruleWords(r)
  const failed = checks?.some(c => c.state === 'fail')
  const state = failed || !r.active ? 'bad' : rules.some(x => !x.on) ? 'warn' : 'good'
  return (
    <div className={f.shield}>
      <div className={f.shieldMark} data-state={state} role="img" aria-label={state === 'good' ? 'Locked down' : state === 'warn' ? 'Locked down, with an exception you allowed' : 'Needs a look'}>
        <svg viewBox="0 0 64 72" width="80" height="90" aria-hidden>
          <path d="M32 3 6 13v19c0 17 11 30 26 37 15-7 26-20 26-37V13z" fill="color-mix(in srgb, currentColor 12%, transparent)" stroke="currentColor" strokeWidth="2.5" />
          {state === 'bad' ? <path d="M32 22v18M32 48v1" stroke="currentColor" strokeWidth="4" strokeLinecap="round" /> : <path d="m21 36 8 8 15-17" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />}
        </svg>
      </div>
      <div className="flex flex-col gap-3">
        <ul className={f.rules} aria-label="Rules in force">
          {rules.map(x => <li key={x.id} data-on={x.on ? 'true' : 'false'}>{x.text}</li>)}
        </ul>
        {checks && (
          <ul className={f.rules} aria-label="Self-check results">
            {checks.map(c => <li key={c.id} data-state={c.state}><span><b>{c.state === 'ok' ? 'Passed' : c.state === 'fail' ? 'FAILED' : 'Note'}: {CHECK_TITLE[c.id] ?? c.id}</b><small>{c.detail}</small></span></li>)}
          </ul>
        )}
      </div>
    </div>
  )
}

/** Problems, worst first, each with its fix. */
export function ProblemList({ problems, busy, onFix }: { problems: Problem[]; busy: string | null; onFix: (p: Problem) => void }) {
  if (!problems.length) return <p className="text-sm" style={{ color: 'var(--good)' }}><Icon name="check" size={14} /> No problems: it runs, it has users, and it keeps to its rules.</p>
  const list = [...problems].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'bad' ? -1 : 1))
  return (
    <ul className={f.problems}>
      {list.map(p => (
        <li key={p.id} className={f.problem} data-sev={p.severity}>
          <Icon name={p.severity === 'bad' ? 'error' : 'warn'} size={18} label={p.severity === 'bad' ? 'Problem' : 'Warning'} />
          <div><b>{p.title}</b><p>{p.detail}</p></div>
          {p.fix && <div className={f.fixRow}><button type="button" className={`${vs.btn} ${p.severity === 'bad' ? vs.btnPri : ''}`} disabled={busy === p.id} onClick={() => onFix(p)}>{busy === p.id ? 'Working…' : p.fix.label}</button></div>}
        </li>
      ))}
    </ul>
  )
}

// ── the page ────────────────────────────────────────────────────────────────

const API = '/api/plugins/3proxy/proxies'
const NAME = '3proxy'

export function ThreeProxyPage() {
  const { role } = useSession()
  const admin = atLeast(role, 'admin')
  const [list, setList] = useState<Instance[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pick, setPick] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [head, setHead] = useState<Reading | null>(null)
  const name = NAME

  const reload = useCallback(async () => {
    const r = await apiJson<{ data: Instance[] }>(API)
    if (r.ok) { setList(r.body!.data); setError(null) } else setError(r.error ?? `Could not read the ${name} proxies.`)
  }, [name])
  useEffect(() => { if (admin) void reload() }, [admin, reload])

  if (!admin) return (
    <div className={vs.page}><PluginSwitcher current="3proxy" />
      <Notice kind="info">The {name} plug-in needs the admin role: it shows who uses the proxy and where they go.</Notice></div>
  )

  const current = list?.find(i => i.id === pick) ?? list?.[0] ?? null

  const lookNow = async () => {
    setBusy(true); setNote(null)
    const r = await apiJson<{ data: { waited: string | null } }>('/api/auto-connect/run', 'POST', {})
    setBusy(false)
    if (!r.ok) setNote({ text: r.error ?? 'Could not look again.', ok: false })
    else if (r.body!.data.waited === 'locked') setNote({ text: 'HyperProx is locked; it connects them once it is unlocked.', ok: false })
    await reload()
  }

  const chips = head ? [
    { label: 'requests', value: head.totals.requests, tone: 'accent' as const },
    { label: 'connections', value: (head.conns.http ?? 0) + (head.conns.socks ?? 0) },
    { label: 'traffic', value: size(head.totals.bytes) },
    { label: 'refused', value: head.totals.denied, tone: head.totals.denied ? 'warn' as const : 'dim' as const },
  ] : [{ label: 'proxies', value: list?.length ?? '…', tone: 'accent' as const }]

  return (
    <div className={vs.page}>
      <PluginSwitcher current="3proxy" />
      <HudHeader eyebrow="Plug-in · Forward proxy" title={name} icon="proxy"
        chips={chips} />
      {error && <Notice kind="error">{error}</Notice>}
      {note && <p className="text-sm" role="status" style={{ color: note.ok ? 'var(--good)' : 'var(--warn-2)' }}>{note.text}</p>}
      {!list && !error && <BusyNote>Looking for {name} on the cluster…</BusyNote>}

      <AutoConnectPanel plugins={['3proxy']} onChanged={() => void reload()} />

      {list && !list.length && (
        <Panel title="Not installed yet">
          <p className="text-sm" style={{ color: 'var(--text-soft)' }}>Install {name} from the <a href="/catalogue" style={{ color: 'var(--hx-accent)' }}>Catalogue</a> (Forward proxy → {name}). It is locked down from the start: sign-in required, only your network may use it, and it cannot reach your own services. HyperProx connects it here by itself.</p>
          <div className={f.toolbar}><GhostButton type="button" disabled={busy} onClick={() => void lookNow()}>{busy ? 'Looking…' : 'Look again now'}</GhostButton></div>
        </Panel>
      )}

      {list && list.length > 1 && (
        <div className={f.toolbar} role="tablist" aria-label={`${name} proxies`}>
          {list.map(i => <button key={i.id} type="button" role="tab" aria-selected={current?.id === i.id} className={vs.btn} onClick={() => setPick(i.id)}>{i.name}</button>)}
        </div>
      )}
      {current && <InstanceView key={current.id} i={current} onChanged={reload} onReading={setHead} />}
    </div>
  )
}

function InstanceView({ i, onChanged, onReading }: { i: Instance; onChanged: () => Promise<void>; onReading: (r: Reading | null) => void }) {
  const base = `${API}/${i.id}`
  const [r, setR] = useState<Reading | null>(null)
  const [readErr, setReadErr] = useState<string | null>(null)
  const [problems, setProblems] = useState<Problem[] | null>(null)
  const [checks, setChecks] = useState<SelfCheck[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null)
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const [confirm, setConfirm] = useState<null | { title: string; text: string; label: string; run: () => void }>(null)
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [newUser, setNewUser] = useState('')
  const [nets, setNets] = useState('')
  const [minutes, setMinutes] = useState(60)

  const say = (text: string, ok: boolean) => setNote({ text, ok })
  const secure = (res: ApiResult, again: () => void): boolean => {
    if (res.status === 403 && res.code === 'reconfirm_required') { setReconfirm(() => again); return false }
    return true
  }

  const load = useCallback(async (fresh = false) => {
    const res = await apiJson<{ data: Reading }>(`${base}/reading?minutes=${minutes}${fresh ? '&fresh=1' : ''}`)
    if (res.ok) { setR(res.body!.data); setReadErr(null); onReading(res.body!.data); setNets(n => n || res.body!.data.allow.join(', ')) }
    else { setReadErr(res.error ?? 'Could not read the proxy.'); onReading(null) }
  }, [base, minutes, onReading])
  const loadProblems = useCallback(async () => {
    const res = await apiJson<{ data: Problem[] }>(`${base}/problems`)
    setProblems(res.ok ? res.body!.data : [{ id: 'unreachable', severity: 'bad', title: 'Could not check', detail: res.error ?? 'The check failed.', fix: { id: 'recheck', label: 'Check again' } }])
  }, [base])
  useEffect(() => { void load(); void loadProblems() }, [load, loadProblems])
  // Live enough to watch traffic, cheap enough for the guest: once every 30 seconds while the tab is visible.
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 30_000)
    return () => clearInterval(t)
  }, [load])
  useEffect(() => () => onReading(null), [onReading])

  const after = async () => { await Promise.all([load(true), loadProblems()]) }

  const act = async (action: 'reload' | 'selftest') => {
    setBusy(action); setNote(null)
    const res = await apiJson<{ data: { message: string; checks?: SelfCheck[] } }>(`${base}/actions`, 'POST', { action })
    setBusy(null)
    if (res.ok) { say(res.body!.data.message, !res.body!.data.checks?.some(c => c.state === 'fail')); if (res.body!.data.checks) setChecks(res.body!.data.checks) }
    else say(res.error ?? 'That did not work.', false)
    if (action !== 'selftest') await after()
  }

  const addUser = async (user: string): Promise<void> => {
    setBusy('add'); setNote(null)
    const res = await apiJson<{ data: { message: string } }>(`${base}/users`, 'POST', { name: user })
    setBusy(null)
    if (!secure(res, () => void addUser(user))) return
    if (res.ok) { setNewUser(''); say(`${res.body!.data.message} Press "Show password" to see it.`, true); await after() } else say(res.error ?? 'The user was not added.', false)
  }

  const resetUser = async (user: string): Promise<void> => {
    setBusy(`reset:${user}`); setNote(null)
    const res = await apiJson<{ data: { message: string } }>(`${base}/users/${encodeURIComponent(user)}/reset`, 'POST', {})
    setBusy(null)
    if (!secure(res, () => void resetUser(user))) return
    if (res.ok) { setRevealed(v => { const n = { ...v }; delete n[user]; return n }); say(res.body!.data.message, true); await after() } else say(res.error ?? 'The password was not changed.', false)
  }

  const removeUser = async (user: string): Promise<void> => {
    setBusy(`del:${user}`); setNote(null)
    const res = await apiJson<{ data: { message: string } }>(`${base}/users/${encodeURIComponent(user)}`, 'DELETE')
    setBusy(null)
    if (!secure(res, () => void removeUser(user))) return
    if (res.ok) { say(res.body!.data.message, true); await after() } else say(res.error ?? 'The user was not removed.', false)
  }

  // The vault's reveal: master password re-confirmed, the value shown here only, cleared after a minute.
  const reveal = async (user: string): Promise<void> => {
    const res = await apiJson<{ data: { fields: Record<string, string> } }>('/api/secrets/reveal', 'POST', { name: i.vaultItem })
    if (!secure(res, () => void reveal(user))) return
    if (!res.ok || !res.body) { say(res.error ?? 'The vault could not reveal it.', false); return }
    const key = fieldFor(user, res.body.data.fields)
    if (!key) { say(`${user} has no password in the vault. Give it a new one.`, false); return }
    setRevealed(v => ({ ...v, [user]: res.body!.data.fields[key] }))
    setTimeout(() => setRevealed(v => { const n = { ...v }; delete n[user]; return n }), 60_000)
  }

  const save = async (body: Record<string, unknown>, done: string): Promise<void> => {
    setBusy('settings'); setNote(null)
    const res = await apiJson<{ data: { message: string; reading: Reading } }>(`${base}/settings`, 'PUT', body)
    setBusy(null)
    if (!secure(res, () => void save(body, done))) return
    if (res.ok) { setR(res.body!.data.reading); onReading(res.body!.data.reading); say(done, true); void loadProblems() } else say(res.error ?? 'Nothing was changed.', false)
  }

  const fix = (p: Problem) => {
    const go = () => {
      const id = p.fix!.id
      if (id === 'reload') return void act('reload')
      if (id === 'block_lan') return void save({ lanTargets: false }, 'Your own network is refused again.')
      if (id === 'reset_user' && p.fix!.user) return void resetUser(p.fix!.user)
      if (id === 'add_user') { document.getElementById(`${i.id}-newuser`)?.focus(); return }
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
  const userOk = USER_RE.test(newUser)

  return (
    <>
      <div className={f.band} role="status">
        <span className="uppercase" style={{ letterSpacing: '0.04em' }}>{i.name} · CT {i.vmid} · {i.node}</span>
        <span>{r ? (r.active ? 'running' : 'NOT RUNNING') : readErr ? 'not reachable' : 'reading…'}</span>
        {r?.version && <small>{NAME} {r.version}</small>}
      </div>
      {note && <p className="text-sm" role="status" style={{ color: note.ok ? 'var(--good)' : 'var(--warn-2)' }}>{note.text}</p>}
      {readErr && <Notice kind="error">{readErr}</Notice>}

      <Panel title="How to use this proxy">
        <HowToUse listen={r?.listen ?? i.listen} r={r} />
      </Panel>

      <Panel title="Locked down" sub="the rules in force" actions={<button type="button" className={vs.btn} disabled={busy === 'selftest'} onClick={() => void act('selftest')}>{busy === 'selftest' ? 'Checking…' : 'Prove it now'}</button>}>
        {r ? <Shield r={r} checks={checks} /> : <BusyNote>Reading…</BusyNote>}
        <p className={f.quiet}>&quot;Prove it now&quot; runs the install&apos;s self-check again from the proxy: a request without a password must be refused, one with the first user&apos;s password must work, and the proxy must refuse to reach itself and your network.</p>
      </Panel>

      <Panel title="Health" actions={<button type="button" className={vs.btn} onClick={() => { setProblems(null); void loadProblems() }}>Check again</button>}>
        {!problems ? <BusyNote>Checking…</BusyNote> : <ProblemList problems={problems} busy={busy} onFix={fix} />}
      </Panel>

      {r && (
        <>
          <div className={f.toolbar} role="group" aria-label="Time window">
            {[15, 60, 360, 1440].map(m => <button key={m} type="button" className={vs.btn} aria-pressed={minutes === m} onClick={() => setMinutes(m)}>{m < 60 ? `${m} min` : `${m / 60} h`}</button>)}
          </div>
          <ForwardProxyPanel r={r} />
        </>
      )}

      <Panel title="Users" sub={r ? plural(r.users.length, 'user') : undefined}>
        <div className={f.rows}>
          <ul className={f.users}>
            {(r?.users ?? []).map(u => (
              <li key={u} className={f.user}>
                <span><b>{u}</b>{r?.byUser.find(x => x.name === u) && <small style={{ color: 'var(--text-muted)' }}> · {size(r.byUser.find(x => x.name === u)!.bytes)} in the window</small>}</span>
                {revealed[u] && <span className={f.toolbar}><code>{revealed[u]}</code><CopyButton text={revealed[u]} /></span>}
                <span className={f.acts}>
                  {!revealed[u] && <GhostButton type="button" onClick={() => void reveal(u)}>Show password</GhostButton>}
                  <GhostButton type="button" disabled={busy === `reset:${u}`} onClick={() => setConfirm({ title: `New password for ${u}`, text: `Give ${u} a new password, kept in the vault? Apps signed in with the old one stop working until they use the new one.`, label: 'New password', run: () => void resetUser(u) })}>New password</GhostButton>
                  <GhostButton type="button" disabled={busy === `del:${u}` || (r?.users.length ?? 0) <= 1} title={(r?.users.length ?? 0) <= 1 ? 'The last user cannot be removed' : undefined}
                    onClick={() => setConfirm({ title: `Remove ${u}`, text: `${u} can no longer use the proxy, and its password is taken out of the vault.`, label: 'Remove', run: () => void removeUser(u) })}>Remove</GhostButton>
                </span>
              </li>
            ))}
          </ul>
          <label>
            <span style={LABEL}>Add a user</span>
            <input id={`${i.id}-newuser`} style={INPUT} value={newUser} onChange={e => setNewUser(e.target.value.toLowerCase())} placeholder="laptop" aria-invalid={!!newUser && !userOk} maxLength={32} />
          </label>
          {newUser && !userOk && <p className="text-xs" style={{ color: 'var(--warn-2)' }}>Lowercase letters, digits, dots, dashes and underscores.</p>}
          <div className={f.toolbar}>
            <PrimaryButton type="button" disabled={!userOk || busy === 'add'} onClick={() => void addUser(newUser)}>{busy === 'add' ? 'Adding…' : 'Add user'}</PrimaryButton>
            <small>HyperProx makes the password and keeps it in the vault; it is never shown in a log or a message.</small>
          </div>
        </div>
      </Panel>

      <Panel title="Settings" sub="confirmed before saving">
        <div className={f.rows}>
          <label>
            <span style={LABEL}>Who may use it (networks)</span>
            <input style={INPUT} value={nets} onChange={e => setNets(e.target.value)} placeholder="10.0.5.0/24" aria-invalid={!netCheck.ok} />
          </label>
          {!netCheck.ok && nets && <p className="text-xs" style={{ color: 'var(--warn-2)' }}>{netCheck.problem}</p>}
          <div className={f.toolbar}>
            <GhostButton type="button" disabled={!netCheck.ok || busy === 'settings' || netCheck.list.join(' ') === r?.allow.join(' ')} onClick={() => void save({ allow: netCheck.list }, 'Saved: only those networks may use the proxy now.')}>Save networks</GhostButton>
            <small>Private networks only. A public one would open the proxy to the internet.</small>
          </div>
          <label className={f.check}>
            <input type="checkbox" checked={!!r?.lanTargets} disabled={!r || busy === 'settings'} onChange={e => {
              if (e.target.checked) setConfirm({ title: 'Let it reach your network', text: 'Anyone with a proxy login could then reach the services on your own network (10.x, 172.16–31.x, 192.168.x) through it. The proxy itself, loopback and link-local stay refused.', label: 'Allow my network', run: () => void save({ lanTargets: true }, 'It can reach your network now.') })
              else void save({ lanTargets: false }, 'Your own network is refused again.')
            }} />
            <span><b>Let it reach your own network</b> · off by default, so the proxy cannot be used to get at your other services.</span>
          </label>
          <label className={f.check}>
            <input type="checkbox" checked={!!r?.perClient} disabled={!r || busy === 'settings'} onChange={e => void save({ perClient: e.target.checked }, e.target.checked ? 'Figures per user and device are on.' : 'Only totals now: no user or device figures are kept.')} />
            <span><b>Figures per user and device</b> · off shows only totals, 3proxy&apos;s log keeps no client address or user name, and the log written so far is emptied.</span>
          </label>
        </div>
      </Panel>

      <Panel title="Proxy">
        {i.autoConnected && <AutoConnectedNote evidence={i.autoConnected.evidence} />}
        <div className={f.toolbar}>
          <GhostButton type="button" disabled={busy === 'reload'} onClick={() => setConfirm({ title: 'Restart 3proxy', text: '3proxy starts again on its current config. Open connections drop.', label: 'Restart', run: () => void act('reload') })}>{busy === 'reload' ? 'Restarting…' : 'Restart'}</GhostButton>
          <GhostButton type="button" onClick={() => setConfirm({ title: 'Disconnect', text: `HyperProx stops showing ${i.name} here. The proxy keeps running, and HyperProx will not connect it again by itself.`, label: 'Disconnect', run: () => void disconnect() })}>Disconnect</GhostButton>
        </div>
        <p className={f.quiet}>Passwords live in the vault item {i.vaultItem}. Figures come from 3proxy&apos;s own log, read in the container every 30 seconds while this page is open.</p>
        {r && <p className={f.quiet}><Pill tone={r.active ? 'good' : 'bad'}>{r.active ? 'running' : 'stopped'}</Pill> {r.listen ?? ''}</p>}
      </Panel>

      {confirm && (
        <Modal title={confirm.title} onClose={() => setConfirm(null)}>
          <div className="flex flex-col gap-4">
            <p className="text-sm" style={{ color: 'var(--text-soft)' }}>{confirm.text}</p>
            <div className="flex justify-end gap-2">
              <GhostButton type="button" onClick={() => setConfirm(null)}>Cancel</GhostButton>
              <PrimaryButton type="button" onClick={() => { const c = confirm; setConfirm(null); c.run() }}>{confirm.label}</PrimaryButton>
            </div>
          </div>
        </Modal>
      )}
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const fn = reconfirm; setReconfirm(null); fn() }} />}
    </>
  )
}
