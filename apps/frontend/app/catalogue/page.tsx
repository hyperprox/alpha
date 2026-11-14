'use client'

// =============================================================================
//  HyperProx — the service catalogue
//
//  Everything else in HyperProx assumes you already run the thing it talks to.
//  This is the page for when you do not. An app HyperProx finds already
//  running (GET /api/catalogue/detected: a read-only probe of every proxy
//  target and web-serving container) shows where, and Install becomes
//  "Install another", which asks first. Websites are not listed here: they
//  have their own section (/sites).
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { alpha } from '@/lib/theme'
import { apiJson } from '@/lib/api'
import { InstallWizard, type WizardRecipe } from '@/components/catalogue/InstallWizard'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { Page, HudHeader, Panel, Pill, Tiles, FlowPipeline, styles } from '@/components/visual/kit'
import { NodeLoginAction } from '@/components/vault/NodeLoginAction'

const ACCENT = 'var(--accent)'
const BORDER = 'var(--border)'
const CARD   = 'var(--surface)'

interface Recipe extends WizardRecipe {
  installedAt: string | null
}
/** Where an app already runs (lib/catalogue-detect.ts). */
interface Running {
  guest: { vmid: number; name: string; node: string; type: 'lxc' | 'qemu' } | null
  target: string; publicUrl: string | null; domains: string[]; version: string | null
  /** A port-scan finding (the scan Plug-ins' Scan shares): which service answered, and its own address. */
  service?: string; url?: string
}
interface NodeLogin { node: string; address: string | null; hasLogin: boolean }
interface Step { id: string; label: string; status: string; detail?: string }
interface Job {
  jobId: string; recipeId: string; status: string; steps: Step[]
  log: string; vmid?: number; node?: string; ip?: string; url?: string; error?: string
  /** This install created its container (so a failed one can be cleaned up), and whether that was done. */
  created?: boolean; removed?: boolean
  adminCredential?: { user: string; password: string; savedInVault: boolean }
  /** An Arr Stack's apps, each at its own address. */
  arrApps?: Array<{ id: string; name: string; url: string }>
  /** What to offer next on a finished Unmanic or Tdarr install: another worker or node. */
  tcFollowUp?: { recipeId: string; label: string; url: string }
}

/** Category names, matching the API's labels; the API's own label wins when it sends one. */
const CATEGORY_LABEL: Record<string, string> = {
  proxy: 'Reverse proxy', ai: 'AI', media: 'Media', monitoring: 'Monitoring', apps: 'Apps', web: 'Web hosting',
}
const categoryLabel = (r: { category: string; categoryLabel?: string }) => r.categoryLabel ?? CATEGORY_LABEL[r.category] ?? r.category

/** "CT 425 nextcloud · cloud.example.com", or the address when it is not a guest. */
const where = (x: Running) => [x.guest ? `${x.guest.type === 'lxc' ? 'CT' : 'VM'} ${x.guest.vmid} ${x.guest.name}` : x.target, x.domains.find(d => !d.includes('*'))].filter(Boolean).join(' · ')

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
  // Settings the wizard starts from: an extra Unmanic worker or Tdarr node starts from the main one's address.
  const [wizardOpts, setWizardOpts] = useState<Record<string, string> | undefined>(undefined)
  const [category, setCategory] = useState<string>('all')
  const [cleaning, setCleaning] = useState(false)
  const [reconfirmCleanup, setReconfirmCleanup] = useState<{ jobId: string; vmid?: number; node?: string } | null>(null)
  // Arr Stacks whose Seerr waits for a Plex server, and the one being finished.
  const [seerrJobs, setSeerrJobs] = useState<Array<{ jobId: string; vmid?: number; node?: string; ip?: string }>>([])
  const [finishing, setFinishing] = useState<string | null>(null)
  const [reconfirmSeerr, setReconfirmSeerr] = useState<string | null>(null)
  // Installs that failed or were cut off by a restart and left a container behind, from earlier sessions too.
  const [leftovers, setLeftovers] = useState<Array<{ jobId: string; recipeId: string; status: string; vmid?: number; node?: string; error?: string }>>([])

  // Node login form
  const [running,  setRunning]  = useState<Record<string, Running[]> | null>(null)
  const [detectState, setDetectState] = useState<'loading' | 'ready' | 'unavailable'>('loading')

  const detect = useCallback(async (refresh = false) => {
    setDetectState('loading')
    const r = await apiJson<{ data: { apps: Record<string, Running[]> } }>(`/api/catalogue/detected${refresh ? '?refresh=1' : ''}`)
    if (r.ok && r.body) { setRunning(r.body.data.apps); setDetectState('ready') } else setDetectState('unavailable')
  }, [])
  useEffect(() => { void detect() }, [detect])

  const load = useCallback(async () => {
    void apiJson<{ data: { jobs: typeof leftovers } }>('/api/catalogue/wizard/jobs').then(r => { if (r.ok) setLeftovers(r.body?.data.jobs ?? []) })
    void apiJson<{ data: { jobs: typeof seerrJobs } }>('/api/catalogue/wizard/arr/seerr').then(r => { if (r.ok) setSeerrJobs(r.body?.data.jobs ?? []) })
    const res = await fetch('/api/catalogue').then(r => r.json()).catch(() => null)
    if (res?.success) {
      setRecipes(res.data.recipes)
      setNodes(res.data.nodes)
      setCanInstall(res.data.canInstall)
    }
    setLoading(false)
  }, [])

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
  const install = (r: Recipe) => {
    const here = running?.[r.id] ?? []
    if (here.length && !window.confirm(`${r.name} is already running on ${here.map(where).join(', ')}. Install another copy anyway?`)) return
    setWizardOpts(undefined)
    setWizard(r)
  }

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

  // Seerr was left unstarted until it can be claimed: with Plex connected, start it and connect it now.
  const finishSeerr = async (jobId: string) => {
    setFinishing(jobId); setNotice(null)
    const r = await apiJson<{ data: { detail: string } }>(`/api/catalogue/wizard/jobs/${jobId}/finish-seerr`, 'POST')
    setFinishing(null)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirmSeerr(jobId); return }
    if (!r.ok) return setNotice(r.error ?? 'Seerr could not be finished.')
    setNotice(`Seerr is connected. ${r.body!.data.detail}`)
    setSeerrJobs(l => l.filter(x => x.jobId !== jobId))
    if (job?.jobId === jobId) setJob({ ...job, steps: job.steps.map(st => st.id === 'arr-seerr' ? { ...st, status: 'done', detail: r.body!.data.detail } : st) })
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
  const configured = recipes.filter(r => r.installedAt || (running?.[r.id]?.length ?? 0) > 0).length
  const unfinished = leftovers.filter(l => l.jobId !== job?.jobId)
  const categories = [...new Set(recipes.map(r => r.category))]
  const shown = category === 'all' ? recipes : recipes.filter(r => r.category === category)

  return (
    <Page>
      <HudHeader level={2} eyebrow="Catalogue" icon="plugin" label="Catalogue overview"
        title="Install what you do not run yet"
        chips={[
          { label: 'Services', value: recipes.length },
          // No count while the scan is still looking: "0 already here" would be a claim, not a reading.
          { label: 'Already here', value: detectState === 'loading' ? '…' : configured, tone: detectState !== 'loading' && configured ? 'good' : undefined },
          { label: 'Node logins', value: `${loginCount}/${nodes.length}`, tone: canInstall ? 'good' : 'warn' },
          ...(unfinished.length ? [{ label: 'Unfinished', value: unfinished.length, tone: 'warn' as const }] : []),
        ]}
        actions={<div className={styles.row} style={{ gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className={styles.btn} onClick={() => void detect(true)} disabled={detectState === 'loading'}>{detectState === 'loading' ? 'Looking for running apps…' : 'Look again'}</button>
          <Link href="/catalogue/settings" className={styles.btn} style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>Container ID rule →</Link>
        </div>}>
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
          So HyperProx needs a login for the nodes: add it once on the Setup checklist, where it is tested on every
          node before it is stored. It is not shared with the Terminal&rsquo;s guest login.
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

        {/* One login for every node, saved and tested on Settings → Setup checklist (the same store installs use). */}
        {nodes.some(n => !n.hasLogin) && <NodeLoginAction why />}
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
          {job.arrApps && job.arrApps.length > 0 && job.status === 'completed' && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              {job.arrApps.map(a => (
                <a key={a.id} href={a.url} target="_blank" rel="noreferrer" className={`${styles.btn} ${styles.btnGhost}`}
                  style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>
                  {a.name} →
                </a>
              ))}
            </div>
          )}
          {job.tcFollowUp && job.status === 'completed' && (() => {
            const next = recipes.find(r => r.id === job.tcFollowUp!.recipeId)
            if (!next) return null
            return (
              <div style={{ marginBottom: 12 }}>
                <button className={styles.btn} type="button"
                  onClick={() => { setWizardOpts({ TC_MAIN_URL: job.tcFollowUp!.url.replace(/^https?:\/\//, '').replace(/\/$/, '') }); setWizard(next) }}>
                  {job.tcFollowUp.label}
                </button>
                <small style={{ display: 'block', marginTop: 4, color: 'var(--text-dim)' }}>Pick another node in step 3; HyperProx looks at its hardware and joins the new one to this one.</small>
              </div>
            )
          })()}
          {job.url && job.status === 'completed' && !job.arrApps?.length && (
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
        <InstallWizard recipe={wizard} initialOptions={wizardOpts} onClose={() => setWizard(null)}
          onStarted={j => { setJob({ jobId: j.jobId, recipeId: wizard.id, status: 'running', steps: j.steps, log: '' }); setWizard(null) }} />
      )}
      {reconfirmCleanup && (
        <ReconfirmModal onClose={() => setReconfirmCleanup(null)} onDone={() => { const t = reconfirmCleanup; setReconfirmCleanup(null); void cleanup(t, true) }} />
      )}

      {reconfirmSeerr && (
        <ReconfirmModal onClose={() => setReconfirmSeerr(null)} onDone={() => { const t = reconfirmSeerr; setReconfirmSeerr(null); void finishSeerr(t) }} />
      )}

      {/* ── Arr Stacks whose Seerr waits for Plex ───────────────────────────── */}
      {seerrJobs.length > 0 && (
        <Panel title="Seerr is waiting" sub={`${seerrJobs.length} Arr Stack${seerrJobs.length > 1 ? 's' : ''}`}>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-muted)' }}>
            Seerr was installed but not started, because a Seerr nobody has signed in to belongs to whoever opens it first.
            Connect Plex in HyperProx (the Plex plug-in&rsquo;s server and token), then press Finish Seerr: it starts Seerr,
            signs it in with that Plex account and connects it to Sonarr and Radarr.
          </p>
          <ul className={styles.guests} aria-label="Seerr waiting">
            {seerrJobs.map(l => (
              <li key={l.jobId} className={styles.guest} style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                <div><b>CT {l.vmid} · {l.node}</b><small>Arr Stack{l.ip ? ` at ${l.ip}` : ''}</small></div>
                <button onClick={() => void finishSeerr(l.jobId)} disabled={finishing !== null} className={`${styles.btn} ${styles.btnPri}`}>
                  {finishing === l.jobId ? 'finishing…' : 'Finish Seerr'}
                </button>
              </li>
            ))}
          </ul>
        </Panel>
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
      <Link href="/sites" className={styles.callout} style={{ display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none', marginBottom: 12 }}>
        <span style={{ flex: 1 }}><b>Websites</b> have their own section: a new static site, WordPress or Ghost, adding one you already run, and their metrics.</span>
        <span aria-hidden style={{ color: ACCENT }}>→</span>
      </Link>
      {categories.length > 1 && (
        <div role="group" aria-label="Filter by category" className={styles.row} style={{ flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          {['all', ...categories].map(c => (
            <button key={c} type="button" onClick={() => setCategory(c)} aria-pressed={category === c}
              className={`${styles.btn} ${category === c ? styles.btnPri : ''}`} style={{ minHeight: 34, padding: '4px 12px' }}>
              {c === 'all' ? `All (${recipes.length})` : `${categoryLabel({ category: c, categoryLabel: recipes.find(r => r.category === c)?.categoryLabel })} (${recipes.filter(r => r.category === c).length})`}
            </button>
          ))}
        </div>
      )}
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(min(330px,100%),1fr))' }}>
        {shown.map(r => { const here = running?.[r.id] ?? []; const isHere = here.length > 0 || !!r.installedAt; return (
          <div key={r.id} className={styles.card} style={{ display: 'flex', flexDirection: 'column', borderColor: isHere ? alpha('var(--good)', 40) : undefined }}>
            <div className={styles.row} style={{ marginBottom: 8, flexWrap: 'wrap' }}>
              <h2 className="font-display" style={{ margin: 0, fontSize: 20, fontWeight: 600, lineHeight: 1.15, color: 'var(--text-bright)' }}>{r.name}</h2>
              <span className={styles.tag}>{categoryLabel(r)}</span>
              <span style={{ marginLeft: 'auto' }}>
                <Pill tone={isHere ? 'good' : undefined}>{here.length ? 'running' : r.installedAt ? 'configured' : detectState === 'loading' ? 'looking…' : 'not found'}</Pill>
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

            {here.length > 0 && (
              <ul style={{ margin: '0 0 12px', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }} aria-label={`Where ${r.name} runs`}>
                {here.map(x => (
                  <li key={`${x.target}|${x.publicUrl}`} className={styles.row} style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, color: 'var(--text-soft)', overflowWrap: 'anywhere', flex: 1, minWidth: 0 }}>
                      Running on {where(x)}{x.service && x.service !== r.name ? ` · ${x.service}` : ''}{x.version ? ` · ${x.version}` : ''}
                    </span>
                    {(x.publicUrl ?? x.url ?? (x.target ? `http://${x.target}` : null)) && (
                      <a className={styles.btn} href={x.publicUrl ?? x.url ?? `http://${x.target}`} target="_blank" rel="noreferrer" style={{ minHeight: 32, padding: '4px 10px', textDecoration: 'none' }}>Open</a>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <div className={styles.row} style={{ marginTop: 'auto' }}>
              <button onClick={() => install(r)} disabled={!canInstall || job?.status === 'running'}
                className={`${styles.btn} ${isHere ? '' : styles.btnPri}`}
                style={isHere ? { color: ACCENT, borderColor: ACCENT } : undefined}>
                {isHere ? 'Install another…' : 'Install…'}
              </button>
              {r.installedAt && (
                <span className="font-mono truncate" style={{ fontSize: 11, color: 'var(--text-dim)' }}>{r.installedAt}</span>
              )}
              {!canInstall && (
                <span style={{ fontSize: 13, color: 'var(--warn)' }}>needs a node login</span>
              )}
            </div>
          </div>
        ) })}
      </div>
    </Page>
  )
}
