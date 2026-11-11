'use client'

// The hardware scan for one cluster, in plain words. Read-only: nothing is installed or changed.

import { Pill, styles } from '@/components/visual/kit'
import { useCallback, useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'
import { Notice, BusyNote } from '@/components/vault/ui'
import { clusterColor } from '@/lib/clusters'

interface ScannedNode {
  node: string; address: string | null; source: 'probe' | 'proxmox-api'
  gpus: Array<{ name: string; vendor: string; kind: string; capability: string; capabilityShort?: string; checkedWith: 'vainfo' | 'estimate' }>
  nodeExporter: string; amdMetrics: string; vainfo: 'checked' | 'not-installed' | 'no-login' | 'failed'; note?: string
}

const exporterWords: Record<string, string> = { running: 'running', installed: 'installed, not running', absent: 'not installed', unknown: 'unknown (no node login yet)' }

export function HardwareScan({ clusterId, kind }: { clusterId: string; kind: 'home' | 'remote' }) {
  const [data, setData] = useState<{ nodes: ScannedNode[]; summary: string; note?: string | null } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const scan = useCallback(async (login: boolean) => {
    setBusy(true); setErr(null)
    const r = await apiJson<{ data: { nodes: ScannedNode[]; summary: string; note?: string | null } }>(`/api/clusters/${clusterId}/hardware${login ? '?login=1' : ''}`)
    setBusy(false)
    if (r.ok) setData(r.body!.data); else setErr(r.error ?? 'The scan did not finish')
  }, [clusterId])
  useEffect(() => { void scan(false) }, [scan])
  return (
    <div className="flex flex-col gap-3">
      {busy && <BusyNote>Scanning…</BusyNote>}
      {err && <Notice kind="error">{err}</Notice>}
      {data && data.nodes.map(n => (
        <div key={n.node} className="rounded-[10px] border p-3 flex flex-col gap-1.5" style={{ borderColor: 'var(--hx-line)', background: 'var(--ground-deep)' }}>
          <div className="flex gap-2 items-center flex-wrap">
            <b className="font-display" style={{ fontSize: 17, color: 'var(--text-bright)' }}>{n.node}</b>
            <Pill tone={n.source === 'probe' ? 'good' : undefined}>{n.source === 'probe' ? 'node login' : 'proxmox api'}</Pill> <span className="text-xs font-mono" style={{ color: 'var(--text-dimmer)' }}>{n.source === 'probe' ? 'checked over its node login' : 'what Proxmox reports (no node login used)'}</span>
          </div>
          {n.gpus.length === 0 ? <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No GPU found.</p> : n.gpus.map((g, i) => (
            <details key={i} className="text-sm min-w-0" style={{ color: 'var(--text)' }}>
              <summary className="cursor-pointer break-words" title={`${n.node}: ${g.name}`}>
                <span style={{ color: clusterColor(kind) }}>✓</span> <b>{n.node} · {g.name}</b> ({g.kind === 'integrated' ? 'built in' : 'a card'}) · {g.capabilityShort ?? g.capability}
              </summary>
              <span className="block text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{g.capability}</span>
            </details>
          ))}
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Server metrics (node_exporter): {exporterWords[n.nodeExporter] ?? n.nodeExporter}. AMD GPU figures: {n.amdMetrics === 'on' ? 'on' : n.amdMetrics === 'off' ? 'off' : 'unknown'}.</p>
          {n.note && <p className="text-xs" style={{ color: 'var(--warn-2)' }}>{n.note}</p>}
        </div>
      ))}
      {data?.note && <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{data.note}</p>}
      <div className="flex gap-2 flex-wrap">
        <button disabled={busy} onClick={() => scan(false)} className={`${styles.btn} ${styles.btnGhost}`}>Scan again</button>
        <button disabled={busy} onClick={() => scan(true)} className={`${styles.btn} ${styles.btnGhost}`} title="Uses a saved node login: read-only, including vainfo">Full scan (uses the node login)</button>
      </div>
    </div>
  )
}
