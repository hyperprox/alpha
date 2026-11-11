'use client'

// "Where can it move?" — per node, yes or no, and the reason in words (from PVE's migrate preconditions,
// plus the bind mounts and devices PVE does not report for containers).

import { useCallback, useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'
import { FlowPipeline } from '@/components/visual/kit'
import { Btn, Note, Tag } from './ui'
import type { Preflight } from './types'

export function MigrationPreflight({ type, vmid }: { type: 'lxc' | 'qemu'; vmid: number }) {
  const [data, setData] = useState<Preflight | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    setBusy(true)
    const r = await apiJson<{ data: Preflight }>(`/api/ha/guests/${type}/${vmid}/preflight`)
    setBusy(false)
    if (r.ok && r.body) { setData(r.body.data); setError('') } else setError(r.error ?? 'Could not ask Proxmox.')
  }, [type, vmid])
  useEffect(() => { void load() }, [load])

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm" style={{ color: 'var(--text-soft)' }}>{data?.summary ?? (busy ? 'Asking Proxmox…' : '')}</p>
        <Btn small onClick={load} disabled={busy}>Check again</Btn>
      </div>
      {error && <Note tone="warn">{error}</Note>}
      {data && data.rows.length > 0 && (
        <FlowPipeline label="Where this guest can move, node by node"
          stages={data.rows.map(r => ({
            key: r.node, label: r.node,
            value: r.current ? 'HERE' : r.allowed ? 'YES' : 'NO',
            state: r.current ? 'done' : r.allowed ? 'ok' : 'bad',
            status: r.current ? 'it runs here now' : r.allowed ? 'it can move here' : 'it cannot move here',
          }))} />
      )}
      {data && (
        <div className="grid gap-2 sm:grid-cols-2">
          {data.rows.map(r => (
            <div key={r.node} className="rounded-[10px] border px-3 py-2" style={{ borderColor: 'var(--hx-line)', background: 'var(--ground-deep)' }}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-display text-[17px] font-semibold" style={{ color: 'var(--text-bright)' }}>{r.node}</span>
                {r.current ? <Tag tone="accent">here now</Tag> : r.allowed ? <Tag tone="good">yes</Tag> : <Tag tone="crit">no</Tag>}
              </div>
              {r.reasons.length > 0 && <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm" style={{ color: 'var(--text)' }}>{r.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>}
              {r.notes.filter(n => !r.current || n).map((x, i) => <p key={i} className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{x}</p>)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
