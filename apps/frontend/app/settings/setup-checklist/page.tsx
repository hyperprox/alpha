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

type State = 'done' | 'partly' | 'not-done' | 'not-applicable'
interface Row { node: string; state: State; reason: string; host?: string; port?: number; fingerprint?: string }
interface Item { id: string; ask: string; what: string; notes: string[]; state: State; rows: Row[]; needsNodeLogin: boolean; action: string | null; automatic?: boolean; command?: string }
interface Job { id: string; item: string; status: 'running' | 'done' | 'failed'; results: Array<{ node?: string; label: string; status: string; reason: string }>; checks: Array<{ node?: string; status: string; reason: string }> }
interface Data { summary: string; logins: Record<string, boolean>; items: Item[]; running: Job | null }

const COLOUR: Record<string, string> = {
  done: 'var(--good)', ok: 'var(--good)', already: 'var(--good)', partly: 'var(--warn)', 'not-done': 'var(--text-muted)',
  'not-applicable': 'var(--text-dim)', skipped: 'var(--text-muted)', failed: 'var(--bad, #f05252)', waiting: 'var(--warn)',
}
const WORDS: Record<string, string> = { done: 'Done', partly: 'Partly done', 'not-done': 'Not done', 'not-applicable': 'Does not apply' }

function Tag({ s }: { s: string }) {
  return <span className="rounded border px-1.5 text-[10px] uppercase font-mono whitespace-nowrap"
               style={{ borderColor: COLOUR[s] ?? 'var(--border-strong)', color: COLOUR[s] ?? 'var(--text-muted)', letterSpacing: '0.1em' }}>{WORDS[s] ?? s}</span>
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
  async function saveAnchor(item: Item) {
    setBusy('anchor'); setError(null)
    try {
      const j = await send('POST', '/api/setup-checklist/host-keys/anchor', { output: anchorOut }, () => saveAnchor(item))
      if (!j) return
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

  return (
    <div className="min-h-full p-4 sm:p-8" style={{ background: 'var(--ground)' }}>
      <div className="mb-6">
        <Link href="/settings" className="text-sm" style={{ color: 'var(--accent)' }}>&larr; Settings</Link>
        <h1 className="font-display font-bold mt-2" style={{ fontSize: 36, lineHeight: 1.1, color: 'var(--text-bright)' }}>Setup checklist</h1>
        <p className="mt-2 text-sm max-w-2xl" style={{ color: 'var(--text-muted)' }}>
          The questions the installer asks. Anything you skipped can be done here. HyperProx does the work and then checks it.
        </p>
        {data && <p className="mt-3 text-sm max-w-2xl" style={{ color: 'var(--text)' }}>{data.summary}</p>}
      </div>

      {error && <div className="mb-4 max-w-3xl"><Notice kind="error">{error}</Notice></div>}
      {!data && !error && <p style={{ color: 'var(--text-muted)' }}>Looking at your nodes&hellip;</p>}

      {data && missingLogin.length > 0 && (
        <section className="mb-6 max-w-3xl rounded-lg border p-4" style={{ borderColor: 'var(--border-strong)' }}>
          <div className="font-semibold" style={{ color: 'var(--text-bright)' }}>Sign in to your nodes, once</div>
          <p className="text-sm mt-1 mb-3" style={{ color: 'var(--text-muted)' }}>
            To set things up on your nodes, HyperProx signs in to them. Use the login you use for SSH, usually root.
            It is tested on every node, then kept in the vault. No login yet for: {missingLogin.join(', ')}.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label><span style={LABEL}>User</span><input style={INPUT} value={login.username} onChange={e => setLogin({ ...login, username: e.target.value })} /></label>
            <label><span style={LABEL}>Password</span><input style={INPUT} type="password" autoComplete="off" value={login.password} onChange={e => setLogin({ ...login, password: e.target.value })} /></label>
          </div>
          <details className="mt-2"><summary className="text-sm cursor-pointer" style={{ color: 'var(--text-muted)' }}>Use a private key instead</summary>
            <textarea style={{ ...INPUT, height: 90, fontFamily: 'var(--font-mono, monospace)' }} value={login.privateKey} onChange={e => setLogin({ ...login, privateKey: e.target.value })} />
          </details>
          <div className="mt-3"><PrimaryButton disabled={busy === 'login'} onClick={saveLogin}>{busy === 'login' ? 'Testing on each node…' : 'Test and save'}</PrimaryButton></div>
          {loginRows && <ul className="mt-3 text-sm">{loginRows.map(r => <li key={r.node}><Tag s={r.ok ? 'done' : 'failed'} /> {r.node}: {r.reason}</li>)}</ul>}
        </section>
      )}

      {confirm && <ReconfirmModal onClose={() => setConfirm(null)} onDone={() => { const f = confirm; setConfirm(null); f() }} />}

      <div className="space-y-3 max-w-3xl">
        {data?.items.map(item => (
          <section key={item.id} className="rounded-lg border p-4" style={{ borderColor: 'var(--border-dim)' }}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold" style={{ color: 'var(--text-bright)' }}>{item.ask}</div>
                <div className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>{item.what}</div>
                {item.notes.map(n => <div key={n} className="text-sm mt-1" style={{ color: 'var(--warn)' }}>{n}</div>)}
              </div>
              <Tag s={item.state} />
            </div>
            {item.rows.length > 0 && (
              <ul className="mt-3 text-sm space-y-1">
                {item.rows.map(r => <li key={r.node} className="flex gap-2 items-center"><Tag s={r.state} /><span className="font-mono">{r.node}</span><span style={{ color: 'var(--text-muted)' }}>{r.reason}</span>
                  {item.id === 'host-keys' && r.state === 'not-done' && r.fingerprint && (noEvidence.has(r.node) || r.node.includes(':')) && <GhostButton disabled={!!busy} title="HyperProx found no evidence for this key. Compare it with the fingerprint the machine prints (for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf $f; done), then confirm." onClick={() => confirmKey(r)}>Compare by hand and confirm</GhostButton>}
                  {item.id === 'igpu-access' && r.state === 'done' && <GhostButton disabled={!!busy} onClick={() => igpu(r.node, 'undo')}>Undo</GhostButton>}
                  {item.id === 'igpu-access' && r.state === 'not-done' && data.logins[r.node] && <GhostButton disabled={!!busy} onClick={() => igpu(r.node, 'apply')}>Open on this node</GhostButton>}
                </li>)}
              </ul>
            )}
            {item.id === 'host-keys' && item.command && (
              <div className="mt-3 text-sm flex flex-col gap-2">
                <div style={{ color: 'var(--text-muted)' }}>Not installed from a node? Run this once in any node's Shell, and paste what it prints (public keys only):</div>
                <pre className="rounded p-2 overflow-x-auto font-mono text-xs" style={{ background: 'var(--ground-deep)', color: 'var(--text-bright)' }}>{item.command}</pre>
                <textarea style={{ ...INPUT, height: 70, fontFamily: 'var(--font-mono, monospace)' }} value={anchorOut} onChange={e => setAnchorOut(e.target.value)} placeholder="Paste the output here" />
                <div><PrimaryButton disabled={!anchorOut.trim() || !!busy} onClick={() => saveAnchor(item)}>{busy === 'anchor' ? 'Verifying…' : 'Use it and verify'}</PrimaryButton></div>
              </div>
            )}
            {item.id === 'dns' && (
              <div className="grid gap-3 sm:grid-cols-2 mt-3">
                <label><span style={LABEL}>GoDaddy API key (Production)</span><input style={INPUT} autoComplete="off" value={dns.key} onChange={e => setDns({ ...dns, key: e.target.value })} /></label>
                <label><span style={LABEL}>API secret</span><input style={INPUT} type="password" autoComplete="off" value={dns.secret} onChange={e => setDns({ ...dns, secret: e.target.value })} /></label>
              </div>
            )}
            {item.action && (
              <div className="mt-3">
                {item.automatic
                  ? <GhostButton disabled={!!busy || job?.status === 'running'} onClick={() => run(item)}>{item.action}</GhostButton>
                  : <PrimaryButton disabled={!!busy || job?.status === 'running' || (item.needsNodeLogin && !Object.values(data!.logins).some(Boolean))}
                                   onClick={() => run(item)}>{busy === item.id ? 'Starting…' : item.action}</PrimaryButton>}
              </div>
            )}
            {job && job.item === item.id && (
              <div className="mt-3 text-sm">
                {job.status === 'running' && <div style={{ color: 'var(--accent)' }}>Working, one node at a time&hellip;</div>}
                <ul className="space-y-1 mt-1">
                  {job.results.map((r, i) => <li key={`r${i}`}><Tag s={r.status} /> {r.label}{r.node ? ` · ${r.node}` : ''}: {r.reason}</li>)}
                  {job.checks.map((c, i) => <li key={`c${i}`}><Tag s={c.status} /> Check{c.node ? ` · ${c.node}` : ''}: {c.reason}</li>)}
                </ul>
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  )
}
