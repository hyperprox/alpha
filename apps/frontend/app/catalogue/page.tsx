'use client'

// =============================================================================
//  HyperProx — the service catalogue
//
//  Everything else in HyperProx assumes you already run the thing it talks to.
//  This is the page for when you do not.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { alpha } from '@/lib/theme'

const ACCENT = 'var(--accent)'
const BORDER = 'var(--border)'
const CARD   = 'var(--surface)'

interface Recipe {
  id: string; name: string; summary: string; category: string
  port: number; needsDocker: boolean
  defaults: { cores: number; memoryMb: number; diskGb: number }
  firstLogin: string | null; notes: string[]
  satisfies: { kind: string; id: string; setting: string } | null
  installedAt: string | null
}
interface NodeLogin { node: string; address: string | null; hasLogin: boolean }
interface Step { id: string; label: string; status: string; detail?: string }
interface Job {
  jobId: string; recipeId: string; status: string; steps: Step[]
  log: string; vmid?: number; node?: string; ip?: string; url?: string; error?: string
}

const STATUS_COLOR: Record<string, string> = {
  pending: 'var(--text-dimmer)', running: 'var(--warn)', done: 'var(--good)', failed: 'var(--crit)', skipped: 'var(--text-dim)',
}

export default function CataloguePage() {
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [nodes,   setNodes]   = useState<NodeLogin[]>([])
  const [canInstall, setCanInstall] = useState(false)
  const [loading, setLoading] = useState(true)
  const [job,     setJob]     = useState<Job | null>(null)
  const [busy,    setBusy]    = useState<string | null>(null)
  const [notice,  setNotice]  = useState<string | null>(null)

  // Node login form
  const [formNode, setFormNode] = useState('')
  const [user,     setUser]     = useState('root')
  const [secret,   setSecret]   = useState('')
  const [useKey,   setUseKey]   = useState(false)
  const [saving,   setSaving]   = useState(false)

  const load = useCallback(async () => {
    const res = await fetch('/api/catalogue').then(r => r.json()).catch(() => null)
    if (res?.success) {
      setRecipes(res.data.recipes)
      setNodes(res.data.nodes)
      setCanInstall(res.data.canInstall)
      if (!formNode && res.data.nodes.length) setFormNode(res.data.nodes[0].node)
    }
    setLoading(false)
  }, [formNode])

  useEffect(() => { load() }, [load])

  // An install runs for minutes. Poll rather than guess when it is done.
  useEffect(() => {
    if (!job || job.status !== 'running') return
    const id = setInterval(async () => {
      const res = await fetch(`/api/catalogue/jobs/${job.jobId}`).then(r => r.json()).catch(() => null)
      if (res?.success) {
        setJob(res.data)
        if (res.data.status !== 'running') load()
      }
    }, 2500)
    return () => clearInterval(id)
  }, [job, load])

  const install = async (r: Recipe) => {
    if (!window.confirm(
      `Create a container for ${r.name} (${r.defaults.cores} cores, ` +
      `${r.defaults.memoryMb} MB, ${r.defaults.diskGb} GB) and install it?`)) return
    setBusy(r.id)
    const res = await fetch('/api/catalogue/install', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipeId: r.id }),
    }).then(x => x.json()).catch(() => null)
    setBusy(null)
    if (!res?.success) return setNotice(res?.error ?? 'The install could not be started.')
    setJob({ jobId: res.data.jobId, recipeId: r.id, status: 'running', steps: res.data.steps, log: '' })
  }

  const saveLogin = async () => {
    if (!formNode || !user || !secret) return
    setSaving(true); setNotice(null)
    const body: any = { username: user }
    if (useKey) body.privateKey = secret; else body.password = secret
    const res = await fetch(`/api/catalogue/nodes/${encodeURIComponent(formNode)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(r => r.json()).catch(() => null)
    setSaving(false)
    if (res?.success) { setSecret(''); setNotice(`${formNode}: ${res.data.version}`); load() }
    else setNotice(res?.error ?? 'Could not verify that login.')
  }

  const forget = async (node: string) => {
    if (!window.confirm(`Remove the stored login for ${node}?`)) return
    await fetch(`/api/catalogue/nodes/${encodeURIComponent(node)}`, { method: 'DELETE' })
    load()
  }

  if (loading) return (
    <div className="p-8 font-mono text-xs" style={{ color: 'var(--text-dim)' }}>loading the catalogue…</div>
  )

  return (
    <div className="min-h-full p-3 sm:p-6" style={{ background: 'var(--ground)' }}>
      <div className="flex items-center gap-3 mb-1">
        <div className="w-1 h-7 rounded" style={{ background: ACCENT, boxShadow: `0 0 10px ${ACCENT}` }} />
        <h1 className="font-display text-xl font-light tracking-[0.2em] uppercase" style={{ color: ACCENT }}>
          Service Catalogue
        </h1>
      </div>
      <p className="font-mono text-[11px] mb-6 ml-4" style={{ color: 'var(--text-dim)' }}>
        HyperProx talks to things you already run. This is for the ones you do not.
      </p>

      {notice && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border px-4 py-2 font-mono text-[11px]"
          style={{ borderColor: BORDER, background: 'var(--surface-notice)', color: 'var(--text-soft)' }}>
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} style={{ color: 'var(--text-dim)' }}>dismiss</button>
        </div>
      )}

      {/* ── Node logins. Nothing installs without one, so it leads. ────────── */}
      <div className="rounded-xl border p-5 mb-6"
        style={{ background: CARD, borderColor: canInstall ? BORDER : 'color-mix(in srgb, var(--warn) 25%, transparent)' }}>
        <div className="flex items-center gap-2 mb-1">
          <div className="w-2 h-2 rounded-full" style={{ background: canInstall ? 'var(--good)' : 'var(--warn)' }} />
          <span className="font-display text-sm font-semibold uppercase tracking-widest"
            style={{ color: canInstall ? 'var(--good)' : 'var(--warn)' }}>
            Node logins
          </span>
        </div>
        <p className="font-mono text-[11px] leading-relaxed mb-4" style={{ color: 'var(--text-muted)' }}>
          Installs run with <span style={{ color: ACCENT }}>pct exec</span> from the node, not by SSH into the
          container — a container a minute old has no login, may have no sshd, and may not have an address yet.
          So HyperProx needs one login per node. It is tested before it is stored, and it is not shared with
          the Terminal&rsquo;s guest login.
        </p>

        <div className="flex flex-wrap gap-2 mb-4">
          {nodes.map(n => (
            <div key={n.node} className="flex items-center gap-2 rounded-lg border px-3 py-1.5"
              style={{ borderColor: n.hasLogin ? 'color-mix(in srgb, var(--good) 19%, transparent)' : BORDER, background: 'var(--ground-inset)' }}>
              <div className="w-1.5 h-1.5 rounded-full" style={{ background: n.hasLogin ? 'var(--good)' : 'var(--text-dimmer)' }} />
              <span className="font-mono text-[12px]" style={{ color: n.hasLogin ? 'var(--text)' : 'var(--text-dim)' }}>{n.node}</span>
              <span className="font-mono text-[10px]" style={{ color: 'var(--text-dimmest)' }}>{n.address ?? '—'}</span>
              {n.hasLogin && (
                <button onClick={() => forget(n.node)} className="font-mono text-[10px] hover:underline"
                  style={{ color: 'var(--text-dim)' }}>forget</button>
              )}
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--text-dim)' }}>Node</span>
            <select value={formNode} onChange={e => setFormNode(e.target.value)}
              className="rounded border px-2 py-1.5 font-mono text-[12px] outline-none"
              style={{ background: 'var(--ground)', borderColor: 'var(--border-strong)', color: 'var(--text)' }}>
              {nodes.map(n => <option key={n.node} value={n.node}>{n.node}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--text-dim)' }}>User</span>
            <input value={user} onChange={e => setUser(e.target.value)}
              className="rounded border px-2 py-1.5 font-mono text-[12px] outline-none w-28"
              style={{ background: 'var(--ground)', borderColor: 'var(--border-strong)', color: 'var(--text)' }} />
          </label>
          <label className="flex flex-1 flex-col gap-1 min-w-[220px]">
            <span className="font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--text-dim)' }}>
              {useKey ? 'Private key' : 'Password'}
            </span>
            {useKey ? (
              <textarea value={secret} onChange={e => setSecret(e.target.value)} rows={3}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                className="rounded border px-2 py-1.5 font-mono text-[11px] outline-none"
                style={{ background: 'var(--ground)', borderColor: 'var(--border-strong)', color: 'var(--text)' }} />
            ) : (
              <input type="password" value={secret} onChange={e => setSecret(e.target.value)}
                className="rounded border px-2 py-1.5 font-mono text-[12px] outline-none"
                style={{ background: 'var(--ground)', borderColor: 'var(--border-strong)', color: 'var(--text)' }} />
            )}
          </label>
          <button onClick={() => { setUseKey(v => !v); setSecret('') }}
            className="rounded border px-2.5 py-1.5 font-mono text-[11px]"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-muted)' }}>
            {useKey ? 'use a password' : 'use a key'}
          </button>
          <button onClick={saveLogin} disabled={saving || !secret}
            className="rounded px-3 py-1.5 font-display text-xs font-semibold tracking-wide"
            style={{ background: `${alpha(ACCENT, 8)}`, color: ACCENT, border: `1px solid ${alpha(ACCENT, 19)}`,
                     opacity: (saving || !secret) ? 0.4 : 1 }}>
            {saving ? 'verifying…' : 'Verify and save'}
          </button>
        </div>
        <p className="font-mono text-[10px] mt-2" style={{ color: 'var(--text-dimmest)' }}>
          A key is safer than the root password: it can be revoked on the node without changing anything else.
        </p>
      </div>

      {/* ── Live install ────────────────────────────────────────────────────── */}
      {job && (
        <div className="rounded-xl border p-5 mb-6" style={{ background: CARD, borderColor: `${alpha(ACCENT, 19)}` }}>
          <div className="flex items-center justify-between mb-3">
            <span className="font-display text-sm font-semibold uppercase tracking-widest" style={{ color: ACCENT }}>
              Installing {recipes.find(r => r.id === job.recipeId)?.name ?? job.recipeId}
            </span>
            {job.status !== 'running' && (
              <button onClick={() => setJob(null)} className="font-mono text-[11px]" style={{ color: 'var(--text-dim)' }}>close</button>
            )}
          </div>
          <div className="flex flex-col gap-1.5 mb-3">
            {job.steps.map(s => (
              <div key={s.id} className="flex items-center gap-2.5">
                <div className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ background: STATUS_COLOR[s.status] ?? 'var(--text-dimmer)' }} />
                <span className="font-mono text-[12px]" style={{ color: s.status === 'pending' ? 'var(--text-dim)' : 'var(--text)' }}>
                  {s.label}
                </span>
                {s.detail && <span className="font-mono text-[10px]" style={{ color: 'var(--text-dim)' }}>· {s.detail}</span>}
              </div>
            ))}
          </div>
          {job.error && (
            <div className="rounded px-3 py-2 font-mono text-[11px] mb-3"
              style={{ background: 'color-mix(in srgb, var(--crit) 6%, transparent)', color: 'var(--crit-soft)', border: '1px solid color-mix(in srgb, var(--crit) 19%, transparent)' }}>
              {job.error}
            </div>
          )}
          {job.url && job.status === 'completed' && (
            <a href={job.url} target="_blank" rel="noreferrer"
              className="inline-block rounded px-3 py-1.5 font-display text-xs font-semibold tracking-wide mb-3"
              style={{ background: 'color-mix(in srgb, var(--good) 8%, transparent)', color: 'var(--good)', border: '1px solid color-mix(in srgb, var(--good) 19%, transparent)' }}>
              Open {job.url} →
            </a>
          )}
          {job.log && (
            <pre className="rounded p-3 font-mono text-[10px] leading-relaxed overflow-auto"
              style={{ background: 'var(--ground-deep)', border: `1px solid ${BORDER}`, color: 'var(--text-muted)', maxHeight: 260 }}>
              {job.log.slice(-6000)}
            </pre>
          )}
        </div>
      )}

      {/* ── Recipes ─────────────────────────────────────────────────────────── */}
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(330px,1fr))' }}>
        {recipes.map(r => (
          <div key={r.id} className="rounded-xl border p-5 flex flex-col"
            style={{ background: CARD, borderColor: r.installedAt ? 'color-mix(in srgb, var(--good) 15%, transparent)' : BORDER }}>
            <div className="flex items-baseline gap-2 mb-1">
              <span className="font-display text-sm font-semibold" style={{ color: 'var(--text-bright)' }}>{r.name}</span>
              <span className="font-mono text-[9px] px-1.5 rounded"
                style={{ background: 'color-mix(in srgb, var(--text-faint) 50%, transparent)', color: 'var(--text-muted)' }}>{r.category}</span>
              {r.installedAt && (
                <span className="font-mono text-[9px] px-1.5 rounded ml-auto"
                  style={{ background: 'color-mix(in srgb, var(--good) 8%, transparent)', color: 'var(--good)' }}>configured</span>
              )}
            </div>
            <p className="font-mono text-[11px] leading-relaxed mb-3" style={{ color: 'var(--text-muted)' }}>{r.summary}</p>

            <div className="flex gap-3 font-mono text-[10px] mb-3" style={{ color: 'var(--text-dim)' }}>
              <span>{r.defaults.cores} cores</span>
              <span>{r.defaults.memoryMb} MB</span>
              <span>{r.defaults.diskGb} GB</span>
              <span>port {r.port}</span>
              {r.needsDocker && <span style={{ color: 'var(--violet)' }}>docker</span>}
            </div>

            {r.notes.length > 0 && (
              <ul className="mb-3 flex flex-col gap-1">
                {r.notes.map((n, i) => (
                  <li key={i} className="font-mono text-[10px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>· {n}</li>
                ))}
              </ul>
            )}
            {r.firstLogin && (
              <p className="font-mono text-[10px] mb-3 rounded px-2 py-1.5"
                style={{ background: 'color-mix(in srgb, var(--warn) 6%, transparent)', color: 'var(--warn)', border: '1px solid color-mix(in srgb, var(--warn) 15%, transparent)' }}>
                First login — {r.firstLogin}
              </p>
            )}

            <div className="mt-auto flex items-center gap-2">
              <button onClick={() => install(r)} disabled={!canInstall || busy === r.id || job?.status === 'running'}
                className="rounded px-3 py-1.5 font-display text-xs font-semibold tracking-wide"
                style={{
                  background: `${alpha(ACCENT, 8)}`, color: ACCENT, border: `1px solid ${alpha(ACCENT, 19)}`,
                  opacity: (!canInstall || busy === r.id || job?.status === 'running') ? 0.35 : 1,
                }}>
                {busy === r.id ? 'starting…' : r.installedAt ? 'Install another' : 'Install'}
              </button>
              {r.installedAt && (
                <span className="font-mono text-[10px] truncate" style={{ color: 'var(--text-dim)' }}>{r.installedAt}</span>
              )}
              {!canInstall && (
                <span className="font-mono text-[10px]" style={{ color: 'var(--warn)' }}>needs a node login</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
