'use client'

// The Command center's client side: the cluster list, and which cluster a page is for.

import { useCallback, useEffect, useState } from 'react'
import { apiJson } from './api'

export interface ClusterInfo {
  id: string
  name: string
  kind: 'home' | 'remote'
  address: string
  port: number
  note: string
  cert: { fingerprint: string | null; confirmedAt: string | null; confirmedBy: string | null }
  nodeAddresses: Record<string, string>
  allowedRoots: string[]
  monitoring: Record<string, { nodeExporter?: { listen: string }; amdGpu?: unknown; intelGpu?: { status: 'measured' | 'unsupported'; reason?: string } }>
  plexUrl: string | null
  token: { saved: boolean | null; id: string | null } | null
}

export interface GpuRow {
  node: string; name: string; shortName: string; vendor: string; kind: 'integrated' | 'dedicated'; pci: string | null
  load: number | null; vramUsed: number | null; vramTotal: number | null; memory: 'dedicated' | 'shared'
  tempC: number | null; fanPct: number | null; freqMHz: number | null; powerW: number | null
  state: 'measured' | 'waiting' | 'stale' | 'unsupported' | 'not-monitored'; stateNote: string | null; setupHref: string | null
  capability: string; capabilityShort: string; capabilitySource: 'vainfo' | 'estimate'
}
export interface Attention { clusterId: string; clusterName: string; kind: 'home' | 'remote'; severity: 'warn' | 'crit' | 'info'; title: string; detail: string }
export interface ClusterPanel {
  id: string; name: string; kind: 'home' | 'remote'; reachable: boolean; error?: string; latencyMs: number | null
  nodes: { online: number; total: number }; quorum: 'ok' | 'lost' | 'standalone' | 'unknown'
  guests: { running: number; total: number }; cpuPct: number | null; memPct: number | null; storagePct: number | null
  gpus: GpuRow[]; gpuNote: string | null; lastBackup: { at: number; ok: boolean; node: string } | null; attention: Attention[]; monitoring: boolean
  /** From the last daily updates check (stored; no machine is read for this). */
  updates?: { available: number; packages: number; security: number; checkedAt: string; result: 'ok' | 'partial' | 'skipped'; reason?: string } | null
}

export function useClusters() {
  const [clusters, setClusters] = useState<ClusterInfo[] | null>(null)
  const [commands, setCommands] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    const r = await apiJson<{ data: ClusterInfo[]; commands: string[] }>('/api/clusters')
    if (r.ok) { setClusters(r.body!.data); setCommands(r.body!.commands ?? []); setError(null) } else setError(r.error ?? 'Could not read the cluster list')
  }, [])
  useEffect(() => { void reload() }, [reload])
  return { clusters, commands, error, reload }
}

/** The colour a cluster is drawn in: home teal, remote amber. */
export const clusterColor = (kind: 'home' | 'remote') => (kind === 'remote' ? 'var(--remote)' : 'var(--accent)')
export const clusterInk = (kind: 'home' | 'remote') => (kind === 'remote' ? 'var(--remote-ink)' : 'var(--accent-ink)')

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let i = 0, v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 90) return 'just now'
  const m = Math.round(s / 60); if (m < 90) return `${m} min ago`
  const h = Math.round(m / 60); if (h < 36) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}
