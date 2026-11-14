'use client'

// =============================================================================
//  Settings → Setup checklist
//  The installer's questions, for an install that already exists. Each says what it does, whether it is
//  done (checked live), and has one button to do it now. Node work needs one login for your nodes, asked
//  once and kept in the vault. Admin only; while HyperProx is locked the API refuses and this page sends
//  you to sign in.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { GhostButton, INPUT, LABEL, Notice, PrimaryButton } from '@/components/vault/ui'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { HudHeader, Page, Panel, Pill, styles as ks, type PillTone, type StatChip } from '@/components/visual/kit'
import ss from '../settings.module.css'

type State = 'done' | 'partly' | 'not-done' | 'not-applicable' | 'failed'
interface Row { node: string; state: State; reason: string; host?: string; port?: number; fingerprint?: string }
interface Item { id: string; ask: string; what: string; notes: string[]; state: State; rows: Row[]; needsNodeLogin: boolean; action: string | null; automatic?: boolean; command?: string }
interface Job { id: string; item: string; status: 'running' | 'done' | 'failed'; results: Array<{ node?: string; label: string; status: string; reason: string }>; checks: Array<{ node?: string; status: string; reason: string }> }
interface Data { summary: string; logins: Record<string, boolean>; items: Item[]; running: Job | null }

// The tone repeats the word; a state with no tone (not done, skipped, does not apply) is a plain pill.
const TONE: Record<string, PillTone> = {
  done: 'good', ok: 'good', already: 'good', partly: 'warn', failed: 'bad', waiting: 'warn',
}
const WORDS: Record<string, string> = { done: 'Done', partly: 'Partly done', 'not-done': 'Not done', 'not-applicable': 'Does not apply', failed: 'Failed' }

function Tag({ s }: { s: string }) {
  return <Pill tone={TONE[s]}>{WORDS[s] ?? s}</Pill>
}

export default function SetupChecklistPage() {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [login, setLogin] = useState({ username: 'root', password: '', privateKey: '' })
  const [loginRows, setLoginRows] = useState<Array<{ node: string; ok: boolean; reason: string }> | null>(null)
  const [dns, setDns] = useState({ key: '', secret: '' })
  const [anchorOut, setAnchorOut] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  // Every change here asks for the master password again; the request is retried once it is confirmed.
  const [confirm, setConfirm] = useState<null | (() => void)>(null)
  async function send(method: string, url: string, body: unknown, retry: () => void): Promise<any | null> {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
    const j = await r.json().catch(() => ({}))
    if (r.status === 403 && j.code === 'reconfirm_required') { setConfirm(() => retry); return null }
    return j
  }

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/setup-checklist')
      const j = await r.json()
      if (!r.ok || !j.success) throw new Error(j.error ?? `HTTP ${r.status}`)
      setData(j.data); setError(null)
      if (j.data.running) setJob(j.data.running)
    } catch (e: any) { setError(e.message) }
  }, [])
  useEffect(() => { void load() }, [load])

  // Follow a running job until it finishes, then re-check everything.
  useEffect(() => {
    if (!job || job.status !== 'running') return
    const t = setInterval(async () => {
      const r = await fetch(`/api/setup-checklist/jobs/${job.id}`).then(x => x.json()).catch(() => null)
      if (r?.success) { setJob(r.data); if (r.data.status !== 'running') { clearInterval(t); void load() } }
    }, 2000)
    return () => clearInterval(t)
  }, [job, load])

  async function run(item: Item) {
    setBusy(item.id); setError(null)
    try {
      const body = item.id === 'dns' ? dns : {}
      const j = await send('POST', `/api/setup-checklist/${item.id}/run`, body, () => run(item))
      if (!j) return
      if (!j.success) throw new Error(j.error)
      setJob(j.data)
      if (item.id === 'dns') { setDns({ key: '', secret: '' }); void load() }
    } catch (e: any) { setError(e.message) } finally { setBusy(null) }
  }

  async function saveLogin() {
    setBusy('login'); setError(null)
    try {
      const j = await send('PUT', '/api/setup-checklist/node-login', login, () => saveLogin())
      if (!j) return
      setLogin(l => ({ ...l, password: '', privateKey: '' }))
      if (j.data?.nodes) setLoginRows(j.data.nodes)
      if (!j.success && !j.data) throw new Error(j.error)
      void load()
    } catch (e: any) { setError(e.message) } finally { setBusy(null) }
  }

  async function igpu(node: string, verb: 'apply' | 'undo') {
    setBusy(`igpu-${node}`); setError(null)
    try {
      const j = await send('POST', `/api/setup-checklist/igpu-access/${node}/${verb}`, {}, () => igpu(node, verb))
      if (!j) return
      if (!j.success) throw new Error(j.error)
      if (j.data.status === 'failed') setError(`${node}: ${j.data.reason}`)
      void load()
    } catch (e: any) { setError(e.message) } finally { setBusy(null) }
  }

  // The one-line command's output from one of the nodes: kept as what keys are checked against, then verified.
  async function saveAnchor(item: Item, replaceInstaller = false) {
    setBusy('anchor'); setError(null)
    try {
      const j = await send('POST', '/api/setup-checklist/host-keys/anchor', { output: anchorOut, replaceInstaller }, () => saveAnchor(item, replaceInstaller))
      if (!j) return
      // It would replace keys the installer read on the node itself: only on a second, explicit confirmation.
      if (j.code === 'anchor_installer') {
        if (window.confirm(`${j.error}\n\nReplace them?`)) return saveAnchor(item, true)
        return
      }
      if (!j.success) throw new Error(j.error)
      setAnchorOut('')
      await run(item)
    } catch (e: any) { setError(e.message) } finally { setBusy(null) }
  }

  async function confirmKey(r: Row) {
    setBusy(`key-${r.node}`); setError(null)
    try {
      const j = await send('POST', '/api/setup-checklist/host-keys/confirm', { host: r.host, port: r.port, fingerprint: r.fingerprint }, () => confirmKey(r))
      if (!j) return
      if (!j.success) throw new Error(j.error)
      void load()
    } catch (e: any) { setError(e.message) } finally { setBusy(null) }
  }

  const missingLogin = data ? Object.entries(data.logins).filter(([, v]) => !v).map(([n]) => n) : []
  // Host keys: the manual compare is offered only for a key Verify automatically found no evidence for, and for a
  // pin that is not a home node (a guest or a hand-added host), which has no cluster record to check against.
  const noEvidence = new Set(job?.item === 'host-keys' && job.status !== 'running' ? job.results.filter(x => x.status === 'skipped' && x.node).map(x => x.node!) : [])

  const items = data?.items ?? []
  const count = (st: State) => items.filter(i => i.state === st).length
  const done = count('done'), partly = count('partly'), notDone = count('not-done'), na = count('not-applicable')
  const applicable = items.length - na
  const chips: StatChip[] = [
    { label: 'done', value: data ? done : '…', tone: data && applicable > 0 && done === applicable ? 'good' : undefined },
    { label: 'partly done', value: data ? partly : '…', tone: partly ? 'warn' : undefined },
    { label: 'not done', value: data ? notDone : '…' },
    { label: 'does not apply', value: data ? na : '…' },
  ]

  return (
    <Page>
      <HudHeader level={2} label="Setup checklist overview"
        eyebrow={<><Link href="/settings" style={{ color: 'inherit' }}>&larr; Settings</Link> · Setup checklist</>}
        title={data ? `${done} of ${applicable} step${applicable === 1 ? '' : 's'} done` : 'Looking at your nodes…'}
        ring={{ value: applicable > 0 ? done / applicable : 0, text: data ? `${done}/${applicable}` : '…', label: 'steps done' }}
        chips={chips}>
        <p className="text-sm max-w-2xl" style={{ margin: 0, color: 'var(--text-muted)' }}>
          The questions the installer asks. Anything you skipped can be done here. HyperProx does the work and then checks it.
        </p>
        {data && <p className="text-sm max-w-2xl" style={{ margin: 0, color: 'var(--text)' }}>{data.summary}</p>}
      </HudHeader>

      {error && <Notice kind="error">{error}</Notice>}
      {!data && !error && <p className={`${ks.empty} animate-pulse`}>Looking at your nodes&hellip;</p>}

      {data && missingLogin.length > 0 && (
        <div id="node-login" style={{ scrollMarginTop: 80 }}>
        <Panel title="Sign in to your nodes, once">
          <p className="text-sm" style={{ margin: '0 0 12px', color: 'var(--text-muted)' }}>
            To set things up on your nodes, HyperProx signs in to them. Use the login you use for SSH, usually root.
            It is tested on every node, then kept in the vault. No login yet for: {missingLogin.join(', ')}.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label><span style={LABEL}>User</span><input style={INPUT} value={login.username} onChange={e => setLogin({ ...login, username: e.target.value })} /></label>
            <label><span style={LABEL}>Password</span><input style={INPUT} type="password" autoComplete="off" value={login.password} onChange={e => setLogin({ ...login, password: e.target.value })} /></label>
          </div>
          <details className="mt-2"><summary className="text-sm cursor-pointer" style={{ color: 'var(--text-muted)', minHeight: 32, display: 'flex', alignItems: 'center' }}>Use a private key instead</summary>
            <textarea aria-label="Private key" style={{ ...INPUT, height: 90, paddingTop: 8, fontFamily: 'var(--font-mono, monospace)' }} value={login.privateKey} onChange={e => setLogin({ ...login, privateKey: e.target.value })} />
          </details>
          <div className="mt-3"><PrimaryButton disabled={busy === 'login'} onClick={saveLogin}>{busy === 'login' ? 'Testing on each node…' : 'Test and save'}</PrimaryButton></div>
          {loginRows && <ul className={ss.lines} style={{ marginTop: 12 }}>{loginRows.map(r => <li key={r.node}><Tag s={r.ok ? 'done' : 'failed'} /> <span className="font-mono">{r.node}</span>: {r.reason}</li>)}</ul>}
        </Panel>
        </div>
      )}

      {confirm && <ReconfirmModal onClose={() => setConfirm(null)} onDone={() => { const f = confirm; setConfirm(null); f() }} />}

      {data && items.length > 0 && (
        <Panel title="Steps" sub="checked live on your nodes">
          <ol className={ss.steps} aria-label="Setup steps">
            {items.map(item => (
              <li key={item.id} className={ss.step} data-state={item.state}>
                <div className={`${ss.item} ${ss.stepBody}`}>
                  <div className={ss.stepHead}>
                    <div style={{ minWidth: 0, flex: '1 1 14rem' }}>
                      <h3>{item.ask}</h3>
                      <div className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>{item.what}</div>
                      {item.notes.map(n => <div key={n} className="text-sm mt-1" style={{ color: 'var(--warn)' }}>{n}</div>)}
                    </div>
                    <Tag s={item.state} />
                  </div>
                  {item.rows.length > 0 && (
                    <ul className={ss.lines}>
                      {item.rows.map(r => <li key={r.node}><Tag s={r.state} /><span className="font-mono">{r.node}</span><span style={{ color: 'var(--text-muted)' }}>{r.reason}</span>
                        {item.id === 'host-keys' && r.state === 'not-done' && r.fingerprint && (noEvidence.has(r.node) || r.node.includes(':')) && <GhostButton disabled={!!busy} title="HyperProx found no evidence for this key. Compare it with the fingerprint the machine prints (for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf $f; done), then confirm." onClick={() => confirmKey(r)}>Compare by hand and confirm</GhostButton>}
                        {item.id === 'igpu-access' && r.state === 'done' && <GhostButton disabled={!!busy} onClick={() => igpu(r.node, 'undo')}>Undo</GhostButton>}
                        {item.id === 'igpu-access' && r.state === 'not-done' && data.logins[r.node] && <GhostButton disabled={!!busy} onClick={() => igpu(r.node, 'apply')}>Open on this node</GhostButton>}
                      </li>)}
                    </ul>
                  )}
                  {item.id === 'host-keys' && item.command && (
                    <div className="text-sm flex flex-col gap-2">
                      <div style={{ color: 'var(--text-muted)' }}>Not installed from a node? Run this once on any node&apos;s own console (its screen, IPMI or iKVM, or an SSH session whose key you already checked; not HyperProx&apos;s Terminal on a key that is not verified yet), and paste what it prints (public keys only):</div>
                      <pre className={ss.pre}>{item.command}</pre>
                      <textarea aria-label="Command output" style={{ ...INPUT, height: 70, paddingTop: 8, fontFamily: 'var(--font-mono, monospace)' }} value={anchorOut} onChange={e => setAnchorOut(e.target.value)} placeholder="Paste the output here" />
                      <div><PrimaryButton disabled={!anchorOut.trim() || !!busy} onClick={() => saveAnchor(item)}>{busy === 'anchor' ? 'Verifying…' : 'Use it and verify'}</PrimaryButton></div>
                    </div>
                  )}
                  {item.id === 'dns' && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label><span style={LABEL}>GoDaddy API key (Production)</span><input style={INPUT} autoComplete="off" value={dns.key} onChange={e => setDns({ ...dns, key: e.target.value })} /></label>
                      <label><span style={LABEL}>API secret</span><input style={INPUT} type="password" autoComplete="off" value={dns.secret} onChange={e => setDns({ ...dns, secret: e.target.value })} /></label>
                    </div>
                  )}
                  {item.action && (
                    <div>
                      {item.automatic
                        ? <GhostButton disabled={!!busy || job?.status === 'running'} onClick={() => run(item)}>{item.action}</GhostButton>
                        : <PrimaryButton disabled={!!busy || job?.status === 'running' || (item.needsNodeLogin && !Object.values(data!.logins).some(Boolean))}
                                         onClick={() => run(item)}>{busy === item.id ? 'Starting…' : item.action}</PrimaryButton>}
                    </div>
                  )}
                  {job && job.item === item.id && (
                    <div className="text-sm">
                      {job.status === 'running' && <div style={{ color: 'var(--accent)' }}>Working, one node at a time&hellip;</div>}
                      <ul className={ss.lines} style={{ marginTop: 4 }}>
                        {job.results.map((r, i) => <li key={`r${i}`}><Tag s={r.status} /> {r.label}{r.node ? ` · ${r.node}` : ''}: {r.reason}</li>)}
                        {job.checks.map((c, i) => <li key={`c${i}`}><Tag s={c.status} /> Check{c.node ? ` · ${c.node}` : ''}: {c.reason}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </Panel>
      )}
    </Page>
  )
}
