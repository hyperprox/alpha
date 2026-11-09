'use client'

// The hardware scan for one cluster, in plain words. Read-only: nothing is installed or changed.

import { useCallback, useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'
import { Notice, BusyNote } from '@/components/vault/ui'
import { clusterColor } from '@/lib/clusters'

interface ScannedNode {
  node: string; address: string | null; source: 'probe' | 'proxmox-api'
  gpus: Array<{ name: string; vendor: string; kind: string; capability: string; checkedWith: 'vainfo' | 'estimate' }>
  nodeExporter: string; amdMetrics: string; vainfo: 'checked' | 'not-installed' | 'no-login' | 'failed'; note?: string
}

const exporterWords: Record<string, string> = { running: 'running', installed: 'installed, not running', absent: 'not installed', unknown: 'unknown (no node login yet)' }

export function HardwareScan({ clusterId, kind }: { clusterId: string; kind: 'home' | 'remote' }) {
  const [data, setData] = useState<{ nodes: ScannedNode[]; summary: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const scan = useCallback(async (login: boolean) => {
    setBusy(true); setErr(null)
    const r = await apiJson<{ data: { nodes: ScannedNode[]; summary: string } }>(`/api/clusters/${clusterId}/hardware${login ? '?login=1' : ''}`)
    setBusy(false)
    if (r.ok) setData(r.body!.data); else setErr(r.error ?? 'The scan did not finish')
  }, [clusterId])
  useEffect(() => { void scan(false) }, [scan])
  return (
    <div className="flex flex-col gap-3">
      {busy && <BusyNote>Scanning…</BusyNote>}
      {err && <Notice kind="error">{err}</Notice>}
      {data && data.nodes.map(n => (
        <div key={n.node} className="rounded-lg border p-3 flex flex-col gap-1.5" style={{ borderColor: 'var(--border-dim)', background: 'var(--ground-deep)' }}>
          <div className="flex gap-2 items-center flex-wrap">
            <b className="font-display" style={{ fontSize: 17, color: 'var(--text-bright)' }}>{n.node}</b>
            <span className="text-xs font-mono" style={{ color: 'var(--text-dimmer)' }}>{n.source === 'probe' ? 'checked over its node login' : 'what Proxmox reports (no node login used)'}</span>
          </div>
          {n.gpus.length === 0 ? <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No GPU found.</p> : n.gpus.map((g, i) => (
            <p key={i} className="text-sm" style={{ color: 'var(--text)' }}>
              <span style={{ color: clusterColor(kind) }}>✓</span> <b>{g.name}</b> ({g.kind === 'integrated' ? 'built in' : 'a card'}). {g.capability}
            </p>
          ))}
          {n.gpus.length > 0 && n.vainfo === 'not-installed' && <p className="text-xs" style={{ color: 'var(--text-muted)' }}>vainfo is not installed on that server, so what the GPU decodes is an estimate. (Install the "vainfo" package there to check it; HyperProx does not install it for you.)</p>}
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Server metrics (node_exporter): {exporterWords[n.nodeExporter] ?? n.nodeExporter}. AMD GPU figures: {n.amdMetrics === 'on' ? 'on' : n.amdMetrics === 'off' ? 'off' : 'unknown'}.</p>
          {n.note && <p className="text-xs" style={{ color: 'var(--warn-2)' }}>{n.note}</p>}
        </div>
      ))}
      <div className="flex gap-2 flex-wrap">
        <button disabled={busy} onClick={() => scan(false)} className="px-3 rounded-md text-xs border disabled:opacity-40" style={{ height: 32, borderColor: 'var(--border-strong)', color: 'var(--text)' }}>Scan again</button>
        <button disabled={busy} onClick={() => scan(true)} className="px-3 rounded-md text-xs border disabled:opacity-40" style={{ height: 32, borderColor: 'var(--border-strong)', color: 'var(--text)' }} title="Uses a saved node login: read-only, including vainfo">Full scan (uses the node login)</button>
      </div>
    </div>
  )
}
