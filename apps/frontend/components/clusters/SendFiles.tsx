'use client'

// Send files, the simple way: what do you want to send, where, then Send. HyperProx finds both servers'
// libraries itself, and the first time it sets everything up after one master-password confirmation.
// Copy only: it adds files there. Nothing that is already there is replaced, and nothing is deleted.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { bytes } from '@/lib/clusters'
import { Notice, BusyNote, INPUT } from '@/components/vault/ui'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'

interface Lib { id: string; name: string; path: string; node: string; free: number | null; size: number | null; plex: boolean }
interface HostKey { node: string; fingerprint: string }
interface Plan {
  ready: boolean; problems: string[]; sourceNode: string | null; looksInside: string
  libraries: Lib[]; sources: Array<{ name: string; path: string }>; speed: number; speedMeasured: boolean
}
interface Entry { name: string; path: string; dir: boolean; size: number | null }
interface Preview { previewId: string; words: string; bytes: number; ready: boolean; steps: string[]; hostKeys: HostKey[]; setupHash: string; items: Array<{ name: string; already: boolean }> }
export interface CopyJob {
  id: string; srcPath: string; dstCluster: string; dstPath: string; state: string; error: string | null; createdAt: string
  progress: { phase?: string; percent?: number | null; rate?: string | null; eta?: string | null; plex?: string | null; note?: string | null } | null
  preview: { item?: string; library?: { name?: string } } | null
}

const BTN = { height: 40, background: 'var(--remote)', color: 'var(--remote-ink)' } as React.CSSProperties
const GHOST = { height: 40, borderColor: 'var(--border-strong)', color: 'var(--text-soft)' } as React.CSSProperties

function duration(s: number): string {
  if (s < 60) return 'under a minute'
  const m = Math.round(s / 60)
  return m < 90 ? `about ${m} min` : `about ${Math.floor(m / 60)} h ${m % 60} min`
}

/** The one button: on a remote panel in the Command center, and on that server's own page. Admins only. */
export function SendFilesButton({ clusterId, clusterName, compact = false }: { clusterId: string; clusterName: string; compact?: boolean }) {
  const { role } = useSession()
  const [open, setOpen] = useState(false)
  if (!atLeast(role, 'admin')) return null
  return (
    <>
      <button onClick={() => setOpen(true)} className={compact ? 'text-xs font-semibold rounded-md px-2.5 py-1' : 'text-sm font-semibold rounded-md px-3 py-1.5'} style={{ background: 'var(--remote)', color: 'var(--remote-ink)' }}>Send files</button>
      {open && <SendFilesDialog clusterId={clusterId} clusterName={clusterName} onClose={() => setOpen(false)} />}
    </>
  )
}

export function SendFilesDialog({ clusterId, clusterName, onClose }: { clusterId: string; clusterName: string; onClose: () => void }) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [step, setStep] = useState<'what' | 'where' | 'sent'>('what')
  const [err, setErr] = useState<string | null>(null)
  const [picked, setPicked] = useState<Map<string, Entry>>(new Map())
  const [lib, setLib] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [keysOk, setKeysOk] = useState(false)
  const [reconfirm, setReconfirm] = useState(false)
  const [sentWords, setSentWords] = useState<string | null>(null)

  const look = useCallback(async (fresh = false) => {
    setErr(null); setBusy('look')
    const r = await apiJson<{ data: Plan }>(`/api/clusters/${clusterId}/send/discover`, 'POST', { fresh })
    setBusy(null)
    if (r.ok) setPlan(r.body!.data); else setErr(r.error ?? 'Could not look at the servers.')
  }, [clusterId])
  useEffect(() => { void look() }, [look])
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !reconfirm) onClose() }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [onClose, reconfirm])

  const pickedList = useMemo(() => [...picked.values()], [picked])
  const pickedBytes = pickedList.every(p => p.size !== null) ? pickedList.reduce((a, p) => a + (p.size ?? 0), 0) : null

  const doPreview = useCallback(async (libraryId: string) => {
    setLib(libraryId); setPreview(null); setErr(null); setBusy('preview')
    const r = await apiJson<{ data: Preview }>(`/api/clusters/${clusterId}/send/preview`, 'POST', { items: [...picked.keys()], library: libraryId })
    setBusy(null)
    if (r.ok) setPreview(r.body!.data); else setErr(r.error ?? 'Could not check what would be sent.')
  }, [clusterId, picked])

  const send = useCallback(async () => {
    if (!preview) return
    setErr(null)
    if (!preview.ready) {
      setBusy('setup')
      const s = await apiJson<{ data: { words: string; ready: boolean } }>(`/api/clusters/${clusterId}/send/setup`, 'POST', { previewId: preview.previewId, setupHash: preview.setupHash, confirmHostKeys: keysOk ? preview.hostKeys.map(h => h.fingerprint) : [] })
      if (s.status === 403 && s.code === 'reconfirm_required') { setBusy(null); setReconfirm(true); return }
      if (!s.ok) { setBusy(null); setErr(s.error ?? 'Setting up did not work. Nothing was sent.'); return }
      setPreview({ ...preview, ready: true })
    }
    setBusy('send')
    const r = await apiJson<{ data: { words: string; notStarted: unknown[] } }>(`/api/clusters/${clusterId}/send`, 'POST', { previewId: preview.previewId })
    setBusy(null)
    if (r.ok) { setSentWords(r.body!.data.notStarted.length ? r.body!.data.words : null); setStep('sent') } else setErr(r.error ?? 'Not sent.')
  }, [clusterId, preview, keysOk])

  const nothingToSend = !!preview && preview.items.every(i => i.already)
  const needKeys = !!preview && !preview.ready && preview.hostKeys.length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-center sm:p-4" style={{ background: 'var(--scrim)', backdropFilter: 'blur(4px)' }}
         onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(false)} onDone={() => { setReconfirm(false); void send() }} />}
      <div role="dialog" aria-modal="true" aria-label={`Send files to ${clusterName}`} className="w-full sm:max-w-2xl sm:rounded-xl border flex flex-col min-h-0 overflow-hidden max-h-[100dvh] sm:max-h-[calc(100dvh-2rem)]"
           style={{ background: 'var(--surface-raised)', borderColor: 'var(--border-soft)', borderTop: '4px solid var(--remote)' }}>
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
          <h2 className="font-display font-semibold truncate" style={{ fontSize: 20, color: 'var(--text-bright)' }}>Send files to {clusterName}</h2>
          <button onClick={onClose} aria-label="Close" style={{ color: 'var(--text-dimmer)', fontSize: 18, minWidth: 32, minHeight: 32 }}>✕</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 flex flex-col gap-4 min-w-0">
          {!plan && busy === 'look' && <BusyNote>Looking at both servers&apos; libraries. The first time takes a few seconds.</BusyNote>}
          {plan?.problems.map((p, i) => <Notice key={i} kind="warn">{p}</Notice>)}
          {err && <Notice kind="error">{err}</Notice>}

          {plan && step === 'what' && <WhatStep clusterId={clusterId} plan={plan} picked={picked} setPicked={setPicked} />}

          {plan && step === 'where' && (
            <div className="flex flex-col gap-3">
              <h3 className="font-display font-semibold" style={{ fontSize: 17, color: 'var(--text-bright)' }}>Where?</h3>
              {plan.libraries.length === 0 && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No library was found on {clusterName}.</p>}
              <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,11rem),1fr))' }}>
                {plan.libraries.map(l => {
                  const on = lib === l.id
                  return (
                    <button key={l.id} onClick={() => void doPreview(l.id)} disabled={busy !== null} className="text-left rounded-lg border p-3 flex flex-col gap-1 disabled:opacity-60"
                            style={{ borderColor: on ? 'var(--remote)' : 'var(--border-strong)', background: on ? 'var(--surface)' : 'transparent', borderWidth: on ? 2 : 1 }}>
                      <b style={{ color: 'var(--text-bright)' }}>{l.name}</b>
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{l.free !== null ? `${bytes(l.free)} free` : 'Free space unknown'}</span>
                      {pickedBytes !== null && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{duration(pickedBytes / plan.speed)} for what you picked</span>}
                    </button>
                  )
                })}
              </div>
              <p className="text-xs" style={{ color: 'var(--text-dimmer)' }}>
                Times are at {(plan.speed / 1024 / 1024).toFixed(1)} MB/s{plan.speedMeasured ? ', the speed of the last copies to this server' : ', a cautious guess until the first copy finishes'}.
              </p>
              {busy === 'preview' && <BusyNote>Checking what is already there…</BusyNote>}
              {preview && (
                <div className="rounded-lg border p-3 flex flex-col gap-3" style={{ borderColor: 'var(--remote)', background: 'var(--ground-deep)' }}>
                  <p className="font-semibold" style={{ color: 'var(--text-bright)' }}>{preview.words}</p>
                  {!preview.ready && !nothingToSend && (
                    <div className="flex flex-col gap-2 text-sm" style={{ color: 'var(--text)' }}>
                      <b>First time only. When you press Send, HyperProx will:</b>
                      <ul className="list-disc pl-5 flex flex-col gap-1">{preview.steps.map((s, i) => <li key={i}>{s}</li>)}</ul>
                      {preview.hostKeys.map(h => (
                        <div key={h.node} className="rounded-md border p-2 flex flex-col gap-1" style={{ borderColor: 'var(--border-strong)' }}>
                          <span>{h.node}&apos;s identity key is</span>
                          <code className="font-mono text-xs break-all" style={{ color: 'var(--text-bright)' }}>{h.fingerprint}</code>
                          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>To check it, run <code className="font-mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> on {h.node} and compare.</span>
                        </div>
                      ))}
                      {plan && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{plan.looksInside}</span>}
                      {needKeys && <label className="flex gap-2 items-center"><input type="checkbox" checked={keysOk} onChange={e => setKeysOk(e.target.checked)} /> The key{preview.hostKeys.length > 1 ? 's match' : ' matches'}</label>}
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>You will be asked for your master password once.</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {step === 'sent' && (
            <div className="flex flex-col gap-3">
              {sentWords && <Notice kind="warn">{sentWords}</Notice>}
              <Notice kind="info">Sending. You can close this; it carries on, and you will be told when it is done if notifications are set up.</Notice>
              <SendJobs clusterId={clusterId} />
            </div>
          )}
        </div>
        <div className="flex gap-2 justify-end flex-wrap px-4 py-3 border-t" style={{ borderColor: 'var(--border)' }}>
          {step === 'what' && plan && (
            <>
              <span className="mr-auto text-sm self-center" style={{ color: 'var(--text-muted)' }}>{picked.size ? `${picked.size} picked${pickedBytes !== null ? `, ${bytes(pickedBytes)}` : ''}` : 'Nothing picked yet'}</span>
              <button disabled={!picked.size} onClick={() => { setStep('where'); setPreview(null); setLib(null) }} className="px-5 rounded-md text-sm font-bold disabled:opacity-40" style={BTN}>Next</button>
            </>
          )}
          {step === 'where' && (
            <>
              <button onClick={() => { setStep('what'); setPreview(null) }} className="px-4 rounded-md text-sm border mr-auto" style={GHOST}>Back</button>
              <button disabled={!preview || nothingToSend || busy !== null || (needKeys && !keysOk)} onClick={() => void send()} className="px-6 rounded-md text-sm font-bold disabled:opacity-40" style={BTN}>
                {busy === 'setup' ? 'Setting up…' : busy === 'send' ? 'Starting…' : 'Send'}
              </button>
            </>
          )}
          {step === 'sent' && <button onClick={onClose} className="px-5 rounded-md text-sm font-bold" style={BTN}>Close</button>}
        </div>
      </div>
    </div>
  )
}

function WhatStep({ clusterId, plan, picked, setPicked }: { clusterId: string; plan: Plan; picked: Map<string, Entry>; setPicked: (m: Map<string, Entry>) => void }) {
  const [path, setPath] = useState<string | null>(null)
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [up, setUp] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Entry[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const open = useCallback(async (p: string) => {
    setBusy(true); setErr(null); setResults(null)
    const r = await apiJson<{ data: { path: string; entries: Entry[]; up: string | null } }>(`/api/clusters/${clusterId}/send/browse?path=${encodeURIComponent(p)}`)
    setBusy(false)
    if (r.ok) { setPath(r.body!.data.path); setEntries(r.body!.data.entries); setUp(r.body!.data.up) } else setErr(r.error ?? 'Could not open that folder.')
  }, [clusterId])
  useEffect(() => { if (!path && plan.sources.length) void open(plan.sources[0].path) }, [plan.sources]) // eslint-disable-line react-hooks/exhaustive-deps

  const search = async () => {
    if (query.trim().length < 2) return
    setBusy(true); setErr(null)
    const r = await apiJson<{ data: Entry[] }>(`/api/clusters/${clusterId}/send/search?q=${encodeURIComponent(query.trim())}`)
    setBusy(false)
    if (r.ok) setResults(r.body!.data); else setErr(r.error ?? 'Search did not work.')
  }
  const toggle = (e: Entry) => { const m = new Map(picked); if (m.has(e.path)) m.delete(e.path); else m.set(e.path, e); setPicked(m) }
  const rootName = (p: string | null) => plan.sources.find(s => p === s.path || (p ?? '').startsWith(s.path + '/'))

  const list = results ?? entries
  return (
    <div className="flex flex-col gap-3 min-w-0">
      <h3 className="font-display font-semibold" style={{ fontSize: 17, color: 'var(--text-bright)' }}>What do you want to send?</h3>
      <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void search() }}>
        <input style={INPUT} value={query} onChange={e => { setQuery(e.target.value); if (!e.target.value) setResults(null) }} placeholder="Search by name" aria-label="Search by name" />
        <button type="submit" disabled={query.trim().length < 2 || busy} className="px-4 rounded-md text-sm border disabled:opacity-40" style={GHOST}>Search</button>
      </form>
      <div className="flex gap-2 flex-wrap">
        {plan.sources.map(s => {
          const on = !results && rootName(path)?.path === s.path
          return <button key={s.path} onClick={() => { setQuery(''); void open(s.path) }} className="text-sm rounded-full border px-3 py-1" style={{ borderColor: on ? 'var(--remote)' : 'var(--border-strong)', color: on ? 'var(--text-bright)' : 'var(--text)', fontWeight: on ? 600 : 400 }}>{s.name}</button>
        })}
      </div>
      {err && <Notice kind="error">{err}</Notice>}
      {busy && <BusyNote>{results === null && query ? 'Searching…' : 'Reading…'}</BusyNote>}
      {list && (
        <div className="rounded-md border" style={{ borderColor: 'var(--border-dim)', background: 'var(--ground-deep)' }}>
          {!results && path && (
            <div className="flex items-center gap-2 px-2 py-1.5 border-b text-xs" style={{ borderColor: 'var(--border-dim)', color: 'var(--text-dim)' }}>
              {up && <button onClick={() => void open(up)} className="rounded border px-2 py-0.5" style={{ borderColor: 'var(--border-strong)', color: 'var(--text)' }}>‹ Back</button>}
              <span className="truncate">{rootName(path)?.name}{path !== rootName(path)?.path ? ` / ${path.slice((rootName(path)?.path.length ?? 0) + 1)}` : ''}</span>
            </div>
          )}
          {results && <div className="px-2 py-1.5 border-b text-xs" style={{ borderColor: 'var(--border-dim)', color: 'var(--text-dim)' }}>{results.length} found for &quot;{query}&quot; <button className="underline ml-2" onClick={() => { setResults(null); setQuery('') }}>Clear</button></div>}
          {list.length === 0 && <p className="text-sm p-3" style={{ color: 'var(--text-muted)' }}>{results ? 'Nothing found.' : 'Empty.'}</p>}
          <ul className="max-h-[50vh] overflow-y-auto">
            {list.map(e => (
              <li key={e.path} className="flex items-center gap-3 px-2 border-b last:border-b-0" style={{ borderColor: 'var(--border-dim)', minHeight: 44 }}>
                <input type="checkbox" checked={picked.has(e.path)} onChange={() => toggle(e)} aria-label={`Pick ${e.name}`} style={{ width: 20, height: 20 }} />
                {e.dir && !results
                  ? <button onClick={() => void open(e.path)} className="flex-1 min-w-0 text-left truncate" style={{ color: 'var(--text)' }}>📁 {e.name}</button>
                  : <span className="flex-1 min-w-0 truncate" style={{ color: 'var(--text)' }} title={e.path}>{e.dir ? '📁 ' : ''}{e.name}</span>}
                <span className="text-xs font-mono shrink-0" style={{ color: 'var(--text-muted)' }}>{e.size !== null ? bytes(e.size) : ''}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {picked.size > 0 && (
        <div className="flex gap-1.5 flex-wrap">
          {[...picked.values()].map(p => <button key={p.path} onClick={() => toggle(p)} className="text-xs rounded-full px-2.5 py-1" style={{ background: 'var(--surface)', color: 'var(--text)' }} title="Remove">{p.name} ✕</button>)}
        </div>
      )}
    </div>
  )
}

const STATE_WORDS: Record<string, string> = { queued: 'Waiting', running: 'Sending', done: 'Done', failed: 'Stopped', cancelled: 'Cancelled', interrupted: 'Interrupted' }

/** Copies to one server (or all, without clusterId): progress, speed, time left, and cancel or resume. */
export function SendJobs({ clusterId }: { clusterId?: string }) {
  const [jobs, setJobs] = useState<CopyJob[]>([])
  const [err, setErr] = useState<string | null>(null)
  const load = useCallback(async () => { const r = await apiJson<{ data: CopyJob[] }>('/api/clusters/files/jobs'); if (r.ok) setJobs(r.body!.data ?? []) }, [])
  useEffect(() => { void load(); const t = setInterval(load, 4000); return () => clearInterval(t) }, [load])
  const act = async (id: string, what: 'cancel' | 'resume') => { const r = await apiJson(`/api/clusters/files/jobs/${id}/${what}`, 'POST'); setErr(r.ok ? null : r.error ?? 'That did not work.'); void load() }
  const mine = jobs.filter(j => !clusterId || j.dstCluster === clusterId).slice(0, 20)
  if (!mine.length) return <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No copies yet.</p>
  return (
    <div className="flex flex-col gap-3">
      {err && <Notice kind="error">{err}</Notice>}
      {mine.map(j => {
        const name = j.preview?.item ?? j.srcPath.split('/').pop()
        const pct = j.state === 'done' ? 100 : j.progress?.percent ?? 0
        const checking = j.state === 'running' && j.progress?.phase === 'verify'
        return (
          <div key={j.id} className="flex flex-col gap-1">
            <div className="flex items-baseline gap-2 text-sm min-w-0">
              <b className="truncate" style={{ color: 'var(--text-bright)' }} title={j.srcPath}>{name}</b>
              <span className="text-xs shrink-0" style={{ color: 'var(--text-muted)' }}>{j.preview?.library?.name ? `to ${j.preview.library.name}` : ''}</span>
              <span className="ml-auto text-xs font-mono shrink-0" style={{ color: 'var(--text-muted)' }}>{checking ? 'Checking' : STATE_WORDS[j.state] ?? j.state}</span>
            </div>
            <span className="block h-2 rounded overflow-hidden" style={{ background: 'var(--ground-deep)' }}><span className="block h-full" style={{ width: `${pct}%`, background: 'var(--remote)' }} /></span>
            <div className="text-xs flex gap-x-3 gap-y-1 flex-wrap" style={{ color: 'var(--text-dimmer)' }}>
              {j.state === 'running' && !checking && <span>{pct}%{j.progress?.rate ? ` · ${j.progress.rate}` : ''}{j.progress?.eta ? ` · ${j.progress.eta} left` : ''}</span>}
              {j.state === 'done' && j.progress?.plex && <span style={{ color: 'var(--text)' }}>{j.progress.plex}</span>}
              {j.error && <span style={{ color: 'var(--crit-soft)' }}>{j.error}</span>}
              {j.progress?.note && <span>{j.progress.note}</span>}
              {(j.state === 'running' || j.state === 'queued') && <button className="underline" onClick={() => void act(j.id, 'cancel')}>Cancel</button>}
              {['failed', 'interrupted', 'cancelled'].includes(j.state) && <button className="underline" onClick={() => void act(j.id, 'resume')}>Resume</button>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
