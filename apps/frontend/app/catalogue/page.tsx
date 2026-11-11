'use client'

// =============================================================================
//  HyperProx — the service catalogue
//
//  Everything else in HyperProx assumes you already run the thing it talks to.
//  This is the page for when you do not.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { alpha } from '@/lib/theme'
import { apiJson } from '@/lib/api'
import { InstallWizard, type WizardRecipe } from '@/components/catalogue/InstallWizard'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { Page, HudHeader, Panel, Pill, Tiles, FlowPipeline, styles } from '@/components/visual/kit'

const ACCENT = 'var(--accent)'
const BORDER = 'var(--border)'
const CARD   = 'var(--surface)'

interface Recipe extends WizardRecipe {
  installedAt: string | null
}
interface NodeLogin { node: string; address: string | null; hasLogin: boolean }
interface Step { id: string; label: string; status: string; detail?: string }
interface Job {
  jobId: string; recipeId: string; status: string; steps: Step[]
  log: string; vmid?: number; node?: string; ip?: string; url?: string; error?: string
  /** This install created its container (so a failed one can be cleaned up), and whether that was done. */
  created?: boolean; removed?: boolean
  adminCredential?: { user: string; password: string; savedInVault: boolean }
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
  const [notice,  setNotice]  = useState<string | null>(null)
  const [wizard,  setWizard]  = useState<Recipe | null>(null)
  const [cleaning, setCleaning] = useState(false)
  const [reconfirmCleanup, setReconfirmCleanup] = useState<{ jobId: string; vmid?: number; node?: string } | null>(null)
  // Installs that failed or were cut off by a restart and left a container behind, from earlier sessions too.
  const [leftovers, setLeftovers] = useState<Array<{ jobId: string; recipeId: string; status: string; vmid?: number; node?: string; error?: string }>>([])

  // Node login form
  const [formNode, setFormNode] = useState('')
  const [user,     setUser]     = useState('root')
  const [secret,   setSecret]   = useState('')
  const [useKey,   setUseKey]   = useState(false)
  const [saving,   setSaving]   = useState(false)

  const load = useCallback(async () => {
    void apiJson<{ data: { jobs: typeof leftovers } }>('/api/catalogue/wizard/jobs').then(r => { if (r.ok) setLeftovers(r.body?.data.jobs ?? []) })
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

  // Every install goes through the wizard: nothing is placed or numbered without being shown first.
  const install = (r: Recipe) => setWizard(r)

  // A failed install may leave a half-made container. Only the one this install created is offered,
  // and the server checks the container's mark before it removes anything.
  const cleanup = async (target: { jobId: string; vmid?: number; node?: string } | null = job, skipConfirm = false) => {
    if (!target?.vmid) return
    if (!skipConfirm && !window.confirm(`Remove CT ${target.vmid} on ${target.node}? It was created by an install that did not finish. Its disk is deleted.`)) return
    setCleaning(true)
    const r = await apiJson<{ data: { detail: string } }>(`/api/catalogue/wizard/jobs/${target.jobId}/cleanup`, 'POST')
    setCleaning(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirmCleanup(target); return }
    if (!r.ok) return setNotice(r.error ?? 'The container could not be removed.')
    setNotice(r.body!.data.detail)
    if (job?.jobId === target.jobId) setJob({ ...job, removed: true })
    setLeftovers(l => l.filter(x => x.jobId !== target.jobId))
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
    <Page><p className={styles.empty}>loading the catalogue…</p></Page>
  )

  const loginCount = nodes.filter(n => n.hasLogin).length
  const configured = recipes.filter(r => r.installedAt).length
  const unfinished = leftovers.filter(l => l.jobId !== job?.jobId)
  const field = styles.field

  return (
    <Page>
      <HudHeader level={2} eyebrow="Catalogue" icon="plugin" label="Catalogue overview"
        title="Install what you do not run yet"
        chips={[
          { label: 'Services', value: recipes.length },
          { label: 'Configured', value: configured, tone: configured ? 'good' : undefined },
          { label: 'Node logins', value: `${loginCount}/${nodes.length}`, tone: canInstall ? 'good' : 'warn' },
          ...(unfinished.length ? [{ label: 'Unfinished', value: unfinished.length, tone: 'warn' as const }] : []),
        ]}
        actions={<Link href="/catalogue/settings" className={styles.btn} style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>Container ID rule →</Link>}>
        <p style={{ margin: 0, maxWidth: 680, fontSize: 15, lineHeight: 1.6, color: 'var(--text-soft)' }}>
          HyperProx talks to things you already run. This is for the ones you do not. Each install walks you through
          its size, the node it goes on, its ID and its network, and shows the exact plan before anything is created.
        </p>
      </HudHeader>

      {notice && (
        <div className={styles.callout} role="status" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ flex: 1 }}>{notice}</span>
          <button onClick={() => setNotice(null)} className={`${styles.btn} ${styles.btnGhost}`}>dismiss</button>
        </div>
      )}

      {/* ── Node logins. Nothing installs without one, so it leads. ────────── */}
      <Panel title="Node logins" sub={canInstall ? 'ready to install' : 'needed before any install'}
        actions={<Pill tone={canInstall ? 'good' : 'warn'}>{canInstall ? 'logged in' : 'needs a node login'}</Pill>}>
        <p style={{ margin: '0 0 14px', fontSize: 14, lineHeight: 1.6, color: 'var(--text-muted)', maxWidth: 680 }}>
          Installs run with <span className="font-mono" style={{ fontSize: 13, color: ACCENT }}>pct exec</span> from the node, not by SSH into the
          container — a container a minute old has no login, may have no sshd, and may not have an address yet.
          So HyperProx needs one login per node. It is tested before it is stored, and it is not shared with
          the Terminal&rsquo;s guest login.
        </p>

        <ul className={styles.dots} style={{ marginBottom: 16 }} aria-label="Node logins">
          {nodes.map(n => (
            <li key={n.node} className={styles.dot} data-state={n.hasLogin ? 'ok' : 'off'} style={{ textDecoration: 'none' }}>
              <i aria-hidden />
              <span>{n.node}</span>
              <span style={{ color: 'var(--text-dimmer)' }}>{n.address ?? '—'}</span>
              <span className={styles.srOnly}>{n.hasLogin ? 'login stored' : 'no login'}</span>
              {n.hasLogin && (
                <button onClick={() => forget(n.node)} className="hover:underline"
                  style={{ color: 'var(--text-muted)', fontSize: 12, background: 'none', border: 0, cursor: 'pointer' }}>forget</button>
              )}
            </li>
          ))}
        </ul>

        <div className={styles.row} style={{ alignItems: 'flex-end' }}>
          <label className={field} style={{ minWidth: 120 }}>
            <span>Node</span>
            <select value={formNode} onChange={e => setFormNode(e.target.value)} className={styles.input}>
              {nodes.map(n => <option key={n.node} value={n.node}>{n.node}</option>)}
            </select>
          </label>
          <label className={field} style={{ width: 130 }}>
            <span>User</span>
            <input value={user} onChange={e => setUser(e.target.value)} className={styles.input} style={{ fontFamily: 'var(--font-mono)' }} />
          </label>
          <label className={field} style={{ flex: 1, minWidth: 220 }}>
            <span>{useKey ? 'Private key' : 'Password'}</span>
            {useKey ? (
              <textarea value={secret} onChange={e => setSecret(e.target.value)} rows={3}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                className={styles.input} style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }} />
            ) : (
              <input type="password" value={secret} onChange={e => setSecret(e.target.value)} className={styles.input} />
            )}
          </label>
          <button onClick={() => { setUseKey(v => !v); setSecret('') }} className={styles.btn}>
            {useKey ? 'use a password' : 'use a key'}
          </button>
          <button onClick={saveLogin} disabled={saving || !secret} className={`${styles.btn} ${styles.btnPri}`}>
            {saving ? 'verifying…' : 'Verify and save'}
          </button>
        </div>
        <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--text-dimmer)' }}>
          A key is safer than the root password: it can be revoked on the node without changing anything else.
        </p>
      </Panel>

      {/* ── Live install ────────────────────────────────────────────────────── */}
      {job && (
        <Panel title={`Installing ${recipes.find(r => r.id === job.recipeId)?.name ?? job.recipeId}`}
          sub={job.status}
          actions={job.status !== 'running' ? <button onClick={() => setJob(null)} className={`${styles.btn} ${styles.btnGhost}`}>close</button> : undefined}>
          <div style={{ marginBottom: 14 }}>
            <FlowPipeline label="Install steps" stages={job.steps.map((s, i) => ({
              key: s.id,
              label: s.label,
              value: s.status === 'done' ? '✓' : s.status === 'failed' ? '!' : i + 1,
              sub: s.detail,
              state: s.status === 'done' ? 'done' : s.status === 'failed' ? 'bad' : s.status === 'running' ? 'warn' : 'ok',
              status: s.status,
            }))} />
          </div>
          <ul className={styles.feed} style={{ marginBottom: 12 }} aria-label="Install step detail">
            {job.steps.map(s => (
              <li key={s.id} data-tone={s.status === 'done' ? 'ok' : s.status === 'failed' ? 'bad' : s.status === 'running' ? 'warn' : 'off'}>
                <span style={{ color: s.status === 'pending' ? 'var(--text-dim)' : 'var(--text)' }}>
                  {s.label} <small style={{ display: 'inline', color: STATUS_COLOR[s.status] ?? 'var(--text-dimmer)' }}>{s.status}</small>
                  {s.detail && <small>{s.detail}</small>}
                </span>
              </li>
            ))}
          </ul>
          {job.error && (
            <div className={styles.callout} role="alert"
              style={{ marginBottom: 12, borderStyle: 'solid', borderColor: alpha('var(--crit)', 45), background: alpha('var(--crit)', 8), color: 'var(--crit-soft)' }}>
              {job.error}
            </div>
          )}
          {job.url && job.status === 'completed' && (
            <a href={job.url} target="_blank" rel="noreferrer"
              className={`${styles.btn} ${styles.btnPri}`}
              style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none', marginBottom: 12 }}>
              Open {job.url} →
            </a>
          )}
          {job.adminCredential && job.status === 'completed' && (
            <div className={styles.callout} style={{ marginBottom: 12 }}>
              <div style={{ marginBottom: 8, color: 'var(--text)' }}>
                Admin sign-in for this install. Shown once; <strong>Saved in the vault</strong>.
              </div>
              <div className={styles.row} style={{ gap: 12 }}>
                <span className="font-mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>{job.adminCredential.user}</span>
                <code className="font-mono select-all" style={{ fontSize: 12, color: 'var(--text-bright)', overflowWrap: 'anywhere' }}>{job.adminCredential.password}</code>
                <button
                  onClick={() => { void navigator.clipboard?.writeText(job.adminCredential!.password).catch(() => {}) }}
                  className={styles.btn}>
                  Copy password
                </button>
              </div>
            </div>
          )}
          {(job.status === 'failed' || job.status === 'interrupted') && job.created && !job.removed && (
            <div className={styles.row} style={{ gap: 12, marginBottom: 12 }}>
              <button onClick={() => void cleanup(job)} disabled={cleaning} className={`${styles.btn} ${styles.btnDanger}`}>
                {cleaning ? 'removing…' : `Remove the half-made CT ${job.vmid}`}
              </button>
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Only the container this install created; nothing else is touched.</span>
            </div>
          )}
          {job.log && (
            <pre className="font-mono overflow-auto"
              style={{ margin: 0, borderRadius: 8, padding: 12, fontSize: 10, lineHeight: 1.6, background: 'var(--ground-deep)', border: `1px solid ${BORDER}`, color: 'var(--text-muted)', maxHeight: 260 }}>
              {job.log.slice(-6000)}
            </pre>
          )}
        </Panel>
      )}

      {wizard && (
        <InstallWizard recipe={wizard} onClose={() => setWizard(null)}
          onStarted={j => { setJob({ jobId: j.jobId, recipeId: wizard.id, status: 'running', steps: j.steps, log: '' }); setWizard(null) }} />
      )}
      {reconfirmCleanup && (
        <ReconfirmModal onClose={() => setReconfirmCleanup(null)} onDone={() => { const t = reconfirmCleanup; setReconfirmCleanup(null); void cleanup(t, true) }} />
      )}

      {/* ── Unfinished installs, kept across restarts ─────────────────────── */}
      {unfinished.length > 0 && (
        <Panel title="Unfinished installs" sub={`${unfinished.length} left behind`}>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-muted)' }}>
            These failed, or were cut off when HyperProx restarted, and may have left a container. Removing one deletes only the
            container that install created; HyperProx checks its mark first.
          </p>
          <ul className={styles.guests} aria-label="Unfinished installs">
            {unfinished.map(l => (
              <li key={l.jobId} className={styles.guest} style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                <div>
                  <b>CT {l.vmid} · {l.node}</b>
                  <small>{recipes.find(r => r.id === l.recipeId)?.name ?? l.recipeId} · {l.status === 'interrupted' ? 'interrupted by a restart' : 'failed'}</small>
                </div>
                <button onClick={() => void cleanup(l)} disabled={cleaning} className={`${styles.btn} ${styles.btnDanger}`}>
                  Remove CT {l.vmid}
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {/* ── Recipes ─────────────────────────────────────────────────────────── */}
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(min(330px,100%),1fr))' }}>
        {recipes.map(r => (
          <div key={r.id} className={styles.card} style={{ display: 'flex', flexDirection: 'column', borderColor: r.installedAt ? alpha('var(--good)', 40) : undefined }}>
            <div className={styles.row} style={{ marginBottom: 8, flexWrap: 'wrap' }}>
              <h2 className="font-display" style={{ margin: 0, fontSize: 20, fontWeight: 600, lineHeight: 1.15, color: 'var(--text-bright)' }}>{r.name}</h2>
              <span className={styles.tag}>{r.category}</span>
              <span style={{ marginLeft: 'auto' }}>
                <Pill tone={r.installedAt ? 'good' : undefined}>{r.installedAt ? 'configured' : 'not installed'}</Pill>
              </span>
            </div>
            <p style={{ margin: '0 0 14px', fontSize: 14, lineHeight: 1.6, color: 'var(--text-muted)' }}>{r.summary}</p>

            <div style={{ marginBottom: 14 }}>
              <Tiles label={`${r.name} size`} items={[
                { label: 'cores', value: r.defaults.cores },
                /* recommended size; the wizard warns below the minimum */
                { label: 'MB RAM', value: r.defaults.memoryMb },
                { label: 'GB disk', value: r.defaults.diskGb },
                { label: 'port', value: r.port },
              ]} />
              {r.needsDocker && <div style={{ marginTop: 8 }}><Pill tone="violet">docker</Pill></div>}
            </div>

            {r.notes.length > 0 && (
              <ul style={{ margin: '0 0 14px', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {r.notes.map((n, i) => (
                  <li key={i} style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-dim)' }}>· {n}</li>
                ))}
              </ul>
            )}
            {r.firstLogin && (
              <p className={styles.callout}
                style={{ margin: '0 0 14px', borderStyle: 'solid', background: alpha('var(--warn)', 10), color: 'var(--warn-2)', borderColor: alpha('var(--warn)', 35) }}>
                First login — {r.firstLogin}
              </p>
            )}

            <div className={styles.row} style={{ marginTop: 'auto' }}>
              <button onClick={() => install(r)} disabled={!canInstall || job?.status === 'running'}
                className={`${styles.btn} ${r.installedAt ? '' : styles.btnPri}`}
                style={r.installedAt ? { color: ACCENT, borderColor: ACCENT } : undefined}>
                {r.installedAt ? 'Install another…' : 'Install…'}
              </button>
              {r.installedAt && (
                <span className="font-mono truncate" style={{ fontSize: 11, color: 'var(--text-dim)' }}>{r.installedAt}</span>
              )}
              {!canInstall && (
                <span style={{ fontSize: 13, color: 'var(--warn)' }}>needs a node login</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </Page>
  )
}
