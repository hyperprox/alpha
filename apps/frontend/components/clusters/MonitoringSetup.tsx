'use client'

// Step 5: monitoring on a remote server. Scan first, plain yes/no questions, a preview of every step, apply,
// then the read-back. "Remove monitoring" undoes what HyperProx did.

import { useCallback, useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'
import type { ClusterInfo } from '@/lib/clusters'
import { Notice, BusyNote } from '@/components/vault/ui'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'

interface NodeFacts { node: string; address: string | null; listen: string | null; iface: string | null; amd: boolean; packageInstalled: boolean; problem?: string }
interface Question { id: string; ask: string; what: string; available: boolean; default: boolean; why?: string }

export function MonitoringSetup({ c, onChanged }: { c: ClusterInfo; onChanged: () => void }) {
  const [scan, setScan] = useState<{ nodes: NodeFacts[]; questions: Question[] } | null>(null)
  const [answers, setAnswers] = useState<Record<string, boolean>>({})
  const [preview, setPreview] = useState<{ planId: string; kind: string; steps: string[] } | null>(null)
  const [result, setResult] = useState<{ ok: boolean; results: Array<{ node: string; status: string; reason: string }>; checks: Array<{ node: string; ok: boolean; words: string }> } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const installed = Object.values(c.monitoring ?? {}).some(m => m?.nodeExporter)

  const doScan = useCallback(async () => {
    setBusy('scan'); setErr(null); setPreview(null)
    const r = await apiJson<{ data: { nodes: NodeFacts[]; questions: Question[] } }>(`/api/clusters/${c.id}/monitoring/scan`)
    setBusy(null)
    if (!r.ok) { setErr(r.error ?? 'The scan did not run'); return }
    setScan(r.body!.data)
    setAnswers(Object.fromEntries(r.body!.data.questions.map(q => [q.id, q.available && q.default])))
  }, [c.id])
  useEffect(() => { void doScan() }, [doScan])

  const doPreview = async (kind: 'install' | 'remove') => {
    setBusy('preview'); setErr(null); setResult(null)
    const r = await apiJson<{ data: { planId: string; kind: string; steps: string[] } }>(`/api/clusters/${c.id}/monitoring/preview`, 'POST', { kind, answers })
    setBusy(null)
    if (r.ok) setPreview(r.body!.data); else setErr(r.error ?? 'No preview')
  }
  const apply = async () => {
    if (!preview) return
    setBusy('apply'); setErr(null)
    const r = await apiJson<{ data: typeof result }>(`/api/clusters/${c.id}/monitoring/apply`, 'POST', { planId: preview.planId })
    setBusy(null)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void apply()); return }
    if (!r.ok) { setErr(r.error ?? 'Not applied'); return }
    setResult(r.body!.data); setPreview(null); onChanged()
  }

  return (
    <section className="rounded-xl border p-4 flex flex-col gap-3" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const f = reconfirm; setReconfirm(null); f() }} />}
      <span className="font-mono font-bold" style={{ fontSize: 12, color: 'var(--accent)' }}>STEP 5</span>
      <h2 className="font-display font-bold uppercase" style={{ fontSize: 17, letterSpacing: '0.04em', color: 'var(--text-bright)' }}>Monitoring on {c.name}</h2>
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>HyperProx looks at the server first and asks plain questions. Nothing installs until you press Apply. It uses the saved, confirmed node login, and every step is checked afterwards.</p>
      {busy === 'scan' && <BusyNote>Looking at the server…</BusyNote>}
      {err && <Notice kind="error">{err}</Notice>}
      {scan && (
        <>
          {scan.nodes.map(n => (
            <p key={n.node} className="text-sm" style={{ color: n.problem ? 'var(--warn-2)' : 'var(--text)' }}>
              <b>{n.node}</b>: {n.problem ?? `reached on ${n.listen} (${n.iface}, a private link)${n.amd ? '; AMD GPU found' : ''}${n.packageInstalled ? '; node_exporter is already installed' : ''}.`}
            </p>
          ))}
          <div className="flex flex-col gap-2">
            {scan.questions.map(q => (
              <label key={q.id} className="flex gap-2.5 items-start" style={{ opacity: q.available ? 1 : 0.55 }}>
                <input type="checkbox" className="mt-1" disabled={!q.available} checked={!!answers[q.id]} onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.checked }))} />
                <span><b className="text-sm" style={{ color: 'var(--text-bright)' }}>{q.ask}</b><small className="block text-xs" style={{ color: 'var(--text-muted)' }}>{q.what}{!q.available && q.why ? ` ${q.why}` : ''}</small></span>
              </label>
            ))}
          </div>
          <div className="flex gap-2 flex-wrap">
            <button disabled={busy !== null} onClick={() => doPreview('install')} className="px-4 rounded-md text-sm font-semibold disabled:opacity-40" style={{ height: 36, background: 'var(--accent)', color: 'var(--accent-ink)' }}>Preview install</button>
            {installed && <button disabled={busy !== null} onClick={() => doPreview('remove')} className="px-4 rounded-md text-sm border disabled:opacity-40" style={{ height: 36, borderColor: 'var(--border-strong)', color: 'var(--text)' }}>Remove monitoring</button>}
            <button disabled={busy !== null} onClick={doScan} className="px-4 rounded-md text-sm border disabled:opacity-40" style={{ height: 36, borderColor: 'var(--border-strong)', color: 'var(--text)' }}>Scan again</button>
          </div>
        </>
      )}
      {preview && (
        <div className="rounded-lg border p-3 flex flex-col gap-2" style={{ borderColor: 'var(--remote)', background: 'var(--ground-deep)' }}>
          <h3 className="font-display font-semibold" style={{ fontSize: 16, color: 'var(--text-bright)' }}>Preview: {preview.kind === 'remove' ? 'remove monitoring' : 'install monitoring'} on {c.name}</h3>
          <ul className="list-disc pl-5 text-sm" style={{ color: 'var(--text)' }}>{preview.steps.map((s, i) => <li key={i}>{s}</li>)}</ul>
          <div className="flex gap-2"><button disabled={busy !== null} onClick={apply} className="px-4 rounded-md text-sm font-semibold disabled:opacity-40" style={{ height: 36, background: 'var(--remote)', color: 'var(--remote-ink)' }}>{busy === 'apply' ? 'Applying…' : 'Apply'}</button><button onClick={() => setPreview(null)} className="px-4 rounded-md text-sm border" style={{ height: 36, borderColor: 'var(--border-strong)', color: 'var(--text-soft)' }}>Cancel</button></div>
        </div>
      )}
      {result && (
        <div className="flex flex-col gap-1.5">
          <Notice kind={result.ok ? 'info' : 'warn'}>{result.ok ? 'Done, and checked.' : 'Finished, but not everything checked out. See below.'}</Notice>
          {result.results.map((r, i) => <p key={`r${i}`} className="text-sm" style={{ color: r.status === 'failed' ? 'var(--crit-soft)' : 'var(--text)' }}><b>{r.node}</b>: {r.status}: {r.reason}</p>)}
          {result.checks.map((x, i) => <p key={`c${i}`} className="text-sm" style={{ color: x.ok ? 'var(--good)' : 'var(--warn-2)' }}>{x.ok ? '✓' : '•'} {x.node}: {x.words}</p>)}
        </div>
      )}
    </section>
  )
}
