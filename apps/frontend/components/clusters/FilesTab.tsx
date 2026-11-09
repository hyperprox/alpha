'use client'

// Send files: pick a file or folder on one cluster, a folder on another (or the same), preview, then copy in
// the background. Copy is the only mode offered: it adds files; HyperProx never replaces or deletes one that was there.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { useClusters, clusterColor, clusterInk, bytes, type ClusterInfo } from '@/lib/clusters'
import { INPUT, LABEL, Notice, BusyNote } from '@/components/vault/ui'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { Dot } from './CommandCenter'

interface Entry { name: string; dir: boolean; size: number }
interface Side { cluster: string; node: string; path: string }

function useNodes(clusterId: string) {
  const [nodes, setNodes] = useState<string[]>([])
  useEffect(() => {
    if (!clusterId) return
    apiJson<{ data: Array<{ node: string; status: string }> }>(`/api/clusters/${clusterId}/nodes`).then(r => setNodes(r.ok ? (r.body!.data ?? []).filter(n => n.status === 'online').map(n => n.node) : []))
  }, [clusterId])
  return nodes
}

function Picker({ title, side, setSide, clusters, wantDir, kindOf }: { title: string; side: Side; setSide: (s: Side) => void; clusters: ClusterInfo[]; wantDir: boolean; kindOf: (id: string) => 'home' | 'remote' }) {
  const nodes = useNodes(side.cluster)
  const c = clusters.find(x => x.id === side.cluster)
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [cwd, setCwd] = useState<string>('')
  useEffect(() => { if (nodes.length && !nodes.includes(side.node)) setSide({ ...side, node: nodes[0], path: '' }) }, [nodes]) // eslint-disable-line react-hooks/exhaustive-deps
  const open = useCallback(async (p: string) => {
    if (!side.node || !p) { setEntries(null); return }
    setErr(null); setCwd(p)
    const r = await apiJson<{ data: { entries: Entry[] } }>(`/api/clusters/${side.cluster}/files/browse?node=${encodeURIComponent(side.node)}&path=${encodeURIComponent(p)}`)
    if (r.ok) setEntries(r.body!.data.entries); else { setEntries(null); setErr(r.error ?? 'Could not list that folder') }
  }, [side.cluster, side.node])
  useEffect(() => { setEntries(null); setCwd('') }, [side.cluster, side.node])
  const k = kindOf(side.cluster)
  const up = cwd && c && !c.allowedRoots.includes(cwd) ? cwd.replace(/\/[^/]+$/, '') : null
  return (
    <div className="rounded-xl border p-4 flex flex-col gap-3 min-w-0" style={{ background: 'var(--surface)', borderColor: 'var(--border)', borderTop: `3px solid ${clusterColor(k)}` }}>
      <div className="flex items-center gap-2"><Dot kind={k} /><h2 className="font-display font-bold uppercase" style={{ fontSize: 17, color: 'var(--text-bright)' }}>{title}</h2></div>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(9rem,1fr))' }}>
        <div><label style={LABEL}>Cluster</label><select style={INPUT} value={side.cluster} onChange={e => setSide({ cluster: e.target.value, node: '', path: '' })}>{clusters.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
        <div><label style={LABEL}>Node</label><select style={INPUT} value={side.node} onChange={e => setSide({ ...side, node: e.target.value, path: '' })}>{nodes.map(n => <option key={n} value={n}>{n}</option>)}</select></div>
      </div>
      {c && !c.allowedRoots.length && <Notice kind="warn">{c.name} has no folders set for copies yet. Add them under Edit server, folders.</Notice>}
      {c && c.allowedRoots.length > 0 && (
        <div className="flex flex-col gap-1 text-sm" style={{ color: 'var(--text-muted)' }}>
          <div className="flex gap-2 flex-wrap">{c.allowedRoots.map(r => <button key={r} onClick={() => { void open(r); if (wantDir) setSide({ ...side, path: r }) }} className="font-mono text-xs rounded border px-2 py-0.5" style={{ borderColor: 'var(--border-strong)', color: 'var(--text)' }}>{r}</button>)}</div>
          {err && <Notice kind="error">{err}</Notice>}
          {entries && (
            <div className="rounded-md border p-2 max-h-72 overflow-y-auto" style={{ borderColor: 'var(--border-dim)', background: 'var(--ground-deep)' }}>
              <div className="font-mono text-xs mb-1 break-all" style={{ color: 'var(--text-dim)' }}>{cwd}</div>
              {up && <button className="block text-left w-full py-0.5" onClick={() => { void open(up); if (wantDir) setSide({ ...side, path: up }) }}>▴ up</button>}
              {entries.length === 0 && <div className="text-xs">Empty.</div>}
              {entries.map(e => {
                const full = `${cwd}/${e.name}`
                const picked = side.path === full
                return (
                  <div key={e.name} className="flex items-center gap-2 py-0.5">
                    {(!wantDir || e.dir) && <input type="radio" checked={picked} onChange={() => setSide({ ...side, path: full })} aria-label={`Pick ${e.name}`} />}
                    {e.dir ? <button className="text-left truncate" style={{ color: picked ? 'var(--text-bright)' : 'var(--text)', fontWeight: picked ? 600 : 400 }} onClick={() => void open(full)}>▸ {e.name}</button>
                      : <span className="truncate" style={{ color: picked ? 'var(--text-bright)' : 'var(--text-muted)' }}>{e.name} <span className="text-xs">({bytes(e.size)})</span></span>}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
      <div className="text-xs font-mono break-all" style={{ color: side.path ? clusterColor(k) : 'var(--text-dimmer)' }}>{side.path || (wantDir ? 'Pick a folder to copy into' : 'Pick a file or folder to copy')}</div>
    </div>
  )
}

interface Job { id: string; srcCluster: string; srcPath: string; dstCluster: string; dstPath: string; state: string; progress: any; error: string | null; preview: any; createdAt: string }

export function FilesTab({ clusterId }: { clusterId: string }) {
  const { role } = useSession()
  const { clusters } = useClusters()
  const kindOf = useCallback((id: string) => (clusters?.find(c => c.id === id)?.kind ?? 'home') as 'home' | 'remote', [clusters])
  const nameOf = useCallback((id: string) => clusters?.find(c => c.id === id)?.name ?? id, [clusters])
  // The open cluster is the destination by default; from the home cluster's page, the first remote is.
  const [src, setSrc] = useState<Side>({ cluster: 'home', node: '', path: '' })
  const [dst, setDst] = useState<Side>({ cluster: clusterId, node: '', path: '' })
  useEffect(() => { if (clusters && clusterId === 'home') { const r = clusters.find(c => c.kind === 'remote'); if (r) { setSrc({ cluster: 'home', node: '', path: '' }); setDst({ cluster: r.id, node: '', path: '' }) } } }, [clusters, clusterId])
  const [speedMB, setSpeedMB] = useState('20')
  const [plex, setPlex] = useState(false)
  const [more, setMore] = useState(false)
  const [preview, setPreview] = useState<{ previewId: string; words: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<{ text: string; setup?: boolean } | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const dstC = clusters?.find(c => c.id === dst.cluster)
  const dstRoot = useMemo(() => dstC?.allowedRoots.filter(r => dst.path === r || dst.path.startsWith(r + '/')).sort((a, b) => b.length - a.length)[0] ?? null, [dstC, dst.path])

  const loadJobs = useCallback(async () => { const r = await apiJson<{ data: Job[] }>('/api/clusters/files/jobs'); if (r.ok) setJobs(r.body!.data ?? []) }, [])
  useEffect(() => { void loadJobs(); const t = setInterval(loadJobs, 5000); return () => clearInterval(t) }, [loadJobs])

  if (!clusters) return <BusyNote>Reading clusters…</BusyNote>
  if (!atLeast(role, 'admin')) return <Notice kind="warn">Sending files needs the admin role.</Notice>

  const doPreview = async () => {
    setBusy('preview'); setErr(null); setPreview(null)
    const r = await apiJson<{ data: { previewId: string; words: string } }>('/api/clusters/files/preview', 'POST', { mode: 'copy', src, dst, speedKBps: Math.round(Number(speedMB || 0) * 1024), plexScan: plex })
    setBusy(null)
    if (r.ok) setPreview(r.body!.data); else setErr({ text: r.error ?? 'No preview', setup: /not set up to send/.test(r.error ?? '') })
  }
  const setup = async () => {
    setBusy('setup')
    const r = await apiJson<{ data: { words: string } }>('/api/clusters/files/keys', 'POST', { src: src.cluster, dst: dst.cluster, dstNode: dst.node, root: dstRoot })
    setBusy(null)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void setup()); return }
    setErr(r.ok ? { text: `${r.body!.data.words} Press Preview again.` } : { text: r.error ?? 'Not set up' })
  }
  const start = async () => {
    if (!preview) return
    setBusy('start')
    const r = await apiJson('/api/clusters/files/jobs', 'POST', { previewId: preview.previewId })
    setBusy(null)
    if (r.ok) { setPreview(null); void loadJobs() } else setErr({ text: r.error ?? 'Not started' })
  }
  const jobAct = async (id: string, what: 'cancel' | 'resume') => { await apiJson(`/api/clusters/files/jobs/${id}/${what}`, 'POST'); void loadJobs() }
  const dk = kindOf(dst.cluster)

  return (
    <div className="flex flex-col gap-4">
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const f = reconfirm; setReconfirm(null); f() }} />}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 rounded-md font-semibold" style={{ background: clusterColor(dk), color: clusterInk(dk) }}>
        <span className="uppercase">Destination: {nameOf(dst.cluster)}</span>
        <small className="font-medium" style={{ opacity: 0.85 }}>Copy adds files there. Your files stay where they are, and HyperProx replaces and deletes nothing that was already there.</small>
      </div>
      <Notice kind="warn">First version: copying has been tested with HyperProx's own checks, not yet against real servers. Try a small folder first.</Notice>
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,19rem),1fr))' }}>
        <Picker title="From" side={src} setSide={s => { setSrc(s); setPreview(null) }} clusters={clusters} wantDir={false} kindOf={kindOf} />
        <Picker title="To" side={dst} setSide={s => { setDst(s); setPreview(null) }} clusters={clusters} wantDir kindOf={kindOf} />
      </div>
      <div className="rounded-xl border p-4 flex flex-col gap-3" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <div className="flex gap-2 items-center flex-wrap">
          <span className="rounded-md px-3 py-1 text-sm font-semibold" style={{ background: clusterColor(dk), color: clusterInk(dk) }}>Copy</span>
          <button onClick={() => setMore(m => !m)} className="rounded-md px-3 py-1 text-sm border border-dashed" style={{ borderColor: 'var(--border-strong)', color: 'var(--text-muted)' }}>More options {more ? '▴' : '▾'}</button>
        </div>
        {more && <p className="text-sm" style={{ color: 'var(--text-muted)' }}><b>Sync</b> (the destination mirrors the source and extras are deleted) and <b>Move</b> (copy, check, then remove the originals) are coming soon. Both delete files, so they will ask you to type the folder name, and warn when the source has no backup.</p>}
        <p className="text-sm" style={{ color: 'var(--text)' }}>✓ Keeps the same folder names, so Plex finds them without renaming. ✓ Checks every copied file afterwards (size and checksum must match, or it is copied again).</p>
        <label className="flex gap-2 items-center text-sm" style={{ color: dstC?.plexUrl ? 'var(--text)' : 'var(--text-dimmer)' }}>
          <input type="checkbox" disabled={!dstC?.plexUrl} checked={plex && !!dstC?.plexUrl} onChange={e => setPlex(e.target.checked)} />
          Ask {nameOf(dst.cluster)}'s Plex to scan when done{!dstC?.plexUrl ? ' (set its Plex under Edit server first)' : ''}
        </label>
        <div style={{ maxWidth: 260 }}><label style={LABEL}>Speed limit, MB/s (0 for none)</label><input style={INPUT} value={speedMB} inputMode="decimal" onChange={e => setSpeedMB(e.target.value.replace(/[^\d.]/g, '').slice(0, 7))} /></div>
        {err && <Notice kind={err.setup ? 'warn' : 'error'}>{err.text}</Notice>}
        {err?.setup && dstRoot && <div><button disabled={busy !== null} onClick={setup} className="px-4 rounded-md text-sm border disabled:opacity-40" style={{ height: 36, borderColor: 'var(--border-strong)', color: 'var(--text)' }}>Set up sending to {dstRoot} on {dst.node}</button></div>}
        <div><button disabled={!src.path || !dst.path || busy !== null} onClick={doPreview} className="px-4 rounded-md text-sm font-bold disabled:opacity-40" style={{ height: 38, background: clusterColor(dk), color: clusterInk(dk) }}>{busy === 'preview' ? 'Checking…' : 'Preview, then send'}</button></div>
        {preview && (
          <div className="rounded-lg border p-3 flex flex-col gap-2" style={{ borderColor: clusterColor(dk), background: 'var(--ground-deep)' }}>
            <h3 className="font-display font-semibold" style={{ fontSize: 16, color: 'var(--text-bright)' }}>Preview: copy {src.path.split('/').pop()}</h3>
            <p className="text-sm" style={{ color: 'var(--text)' }}>{preview.words}</p>
            <div className="flex gap-2"><button disabled={busy !== null} onClick={start} className="px-4 rounded-md text-sm font-semibold" style={{ height: 36, background: clusterColor(dk), color: clusterInk(dk) }}>Start copy</button><button onClick={() => setPreview(null)} className="px-4 rounded-md text-sm border" style={{ height: 36, borderColor: 'var(--border-strong)', color: 'var(--text-soft)' }}>Cancel</button></div>
          </div>
        )}
      </div>
      <div className="rounded-xl border p-4 flex flex-col gap-2" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <h2 className="font-display font-bold uppercase" style={{ fontSize: 17, color: 'var(--text-bright)' }}>Transfers</h2>
        {jobs.length === 0 && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>None yet.</p>}
        {jobs.map(j => {
          const k = kindOf(j.dstCluster)
          const pct = j.state === 'done' ? 100 : j.progress?.percent ?? 0
          return (
            <div key={j.id} className="flex flex-col gap-1">
              <div className="grid items-center gap-2 text-xs" style={{ gridTemplateColumns: 'minmax(0,12rem) minmax(0,1fr) 8rem', color: 'var(--text-muted)' }}>
                <span className="truncate" title={j.srcPath}>{j.srcPath.split('/').pop()}</span>
                <span className="block h-2 rounded overflow-hidden" style={{ background: 'var(--ground-deep)' }}><span className="block h-full" style={{ width: `${pct}%`, background: clusterColor(k) }} /></span>
                <span className="text-right font-mono">{j.state === 'running' ? `${pct}%${j.progress?.eta ? ` · ${j.progress.eta}` : ''}${j.progress?.phase === 'verify' ? ' · checking' : ''}` : j.state}</span>
              </div>
              <div className="text-xs flex gap-2 flex-wrap" style={{ color: j.error ? 'var(--crit-soft)' : 'var(--text-dimmer)' }}>
                <span>{nameOf(j.srcCluster)} → {nameOf(j.dstCluster)} {j.dstPath}</span>
                {j.error && <span>{j.error}</span>}
                {j.progress?.plex && <span>{j.progress.plex}</span>}
                {j.progress?.note && <span>{j.progress.note}</span>}
                {(j.state === 'running' || j.state === 'queued') && <button className="underline" onClick={() => jobAct(j.id, 'cancel')}>Cancel</button>}
                {['failed', 'interrupted', 'cancelled'].includes(j.state) && <button className="underline" onClick={() => jobAct(j.id, 'resume')}>Resume</button>}
              </div>
            </div>
          )
        })}
        <p className="text-xs mt-1" style={{ color: 'var(--text-dimmer)' }}>If the connection drops, it carries on from where it stopped. Every transfer is in the audit log with who started it, never with any keys.</p>
      </div>
    </div>
  )
}
