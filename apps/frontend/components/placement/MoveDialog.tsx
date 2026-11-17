'use client'

// One move: the server checks it first (the same engine, plus Proxmox's own migrate check), the dialog shows what it
// costs (downtime, data to copy, the network corosync shares), and only then offers to move: now in a quiet window,
// "move anyway" outside one, or held for the next quiet window. This dialog is the confirmation
// (lib/confirm-bus.ts), then it waits for the move to really finish: the server reads the guest back on
// the target before it calls it done.

import { useCallback, useEffect, useRef, useState } from 'react'
import { IN_PAGE } from '@/lib/confirm-bus'
import { apiJson } from '@/lib/api'
import { Btn, Dialog, Label, Note, SELECT } from '@/components/ha/ui'
import { CostList } from './parts'
import { moveChoices, quietWords, when as whenText, STATUS_WORD } from './logic'
import type { MovePlan, MoveRecord } from './types'

export function MoveDialog({ sid, name, to, onClose, onDone }: { sid: string; name: string; to: string; onClose: () => void; onDone?: (m: MoveRecord) => void }) {
  const [type, vmid] = [sid.startsWith('ct:') ? 'lxc' : 'qemu', sid.split(':')[1]]
  const base = `/api/placement/guests/${type}/${vmid}`
  const [plan, setPlan] = useState<MovePlan | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [bw, setBw] = useState('')
  const [move, setMove] = useState<MoveRecord | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const check = useCallback(async (bwlimitKiB?: number) => {
    setBusy(true); setError('')
    const r = await apiJson<{ data: MovePlan }>(`${base}/check`, 'POST', { target: to, ...(bwlimitKiB ? { bwlimitKiB } : {}) })
    setBusy(false)
    if (!r.ok || !r.body) { setError(r.error ?? 'The move could not be checked.'); return }
    setPlan(r.body.data)
    if (r.body.data.bwlimitKiB && !bwlimitKiB) setBw(String(Math.round(r.body.data.bwlimitKiB / 1024)))
  }, [base, to])
  useEffect(() => { void check() }, [check])

  const follow = useCallback(async (id: string) => {
    for (let i = 0; i < 3600 && alive.current; i++) {
      const r = await apiJson<{ data: MoveRecord }>(`/api/placement/moves/${encodeURIComponent(id)}`)
      if (r.ok && r.body) { setMove(r.body.data); if (r.body.data.status !== 'running' && r.body.data.status !== 'stuck') { onDone?.(r.body.data); return } }
      await new Promise(res => setTimeout(res, 2000))
    }
  }, [onDone])

  const go = useCallback(async (when: 'now' | 'next-quiet', anyway: boolean) => {
    setBusy(true); setError('')
    const bwlimitKiB = plan?.method === 'migrate' && bw ? Math.round(Number(bw) * 1024) : undefined
    const r = await apiJson<{ data: MoveRecord }>(`${base}/move`, 'POST', { target: to, when, anyway, ...(bwlimitKiB ? { bwlimitKiB } : {}) }, IN_PAGE)
    setBusy(false)
    if (!r.ok || !r.body) { setError(r.error ?? 'Not moved.'); return }
    setMove(r.body.data)
    if (r.body.data.status === 'running') void follow(r.body.data.id)
    else onDone?.(r.body.data)
  }, [base, to, bw, plan, follow, onDone])

  const choices = plan ? moveChoices(plan) : []
  const finished = move && move.status !== 'running' && move.status !== 'stuck'
  return (
    <Dialog title={`Move ${name || sid} to ${to}`} onClose={onClose} wide>
      {!plan && !error && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Checking the move with Proxmox…</p>}
      {plan && (
        <>
          <div className="space-y-1.5"><Label>What it costs</Label><CostList plan={plan} /></div>
          <Note tone={plan.quiet.quietNow ? 'good' : 'warn'}>{quietWords(plan.quiet)}</Note>
          {plan.network.shared !== false && plan.method === 'migrate' && plan.allowed && !move && (
            <label className="flex flex-wrap items-center gap-2 text-sm" style={{ color: 'var(--text-soft)' }}>
              Bandwidth limit (MiB/s)
              <input inputMode="numeric" value={bw} onChange={e => setBw(e.target.value.replace(/[^\d]/g, ''))} aria-label="Bandwidth limit in MiB/s"
                style={{ ...SELECT, width: 90 }} onBlur={() => { const n = Number(bw); if (n >= 1) void check(n * 1024) }} />
              <span className="text-xs" style={{ color: 'var(--text-dim)' }}>Corosync shares this network: a lower limit is gentler on the cluster heartbeat.</span>
            </label>
          )}
        </>
      )}
      {error && <Note tone="crit">{error}</Note>}
      {move && (
        <Note tone={move.status === 'failed' || move.status === 'skipped' ? 'crit' : move.status === 'done' ? 'good' : 'info'}>
          {move.status === 'scheduled' && move.scheduledFor ? `Scheduled for ${whenText(move.scheduledFor, plan?.quiet.tz)}. It is checked again before it runs, under the stricter of today's settings and the ones in force then, and skipped (with the reason) if anything changed or HyperProx is locked then. Scheduled moves expire after 7 days.`
            : move.status === 'running' ? `Moving ${name || sid} to ${to}… HyperProx waits for Proxmox's task, then checks it really runs there.`
            : move.status === 'stuck' ? `Still running in Proxmox: ${move.error ?? ''} HyperProx keeps watching and starts no other move until it finishes.`
            : move.status === 'done' ? `Moved: ${name || sid} runs on ${to}.` : `${STATUS_WORD[move.status]}: ${move.error ?? 'see the history'}`}
        </Note>
      )}
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <Btn onClick={onClose}>{finished || move?.status === 'scheduled' ? 'Close' : 'Cancel'}</Btn>
        {!move && choices.includes('now') && <Btn kind="primary" disabled={busy} onClick={() => go('now', false)}>{busy ? 'Starting…' : 'Move now'}</Btn>}
        {!move && choices.includes('schedule') && <Btn kind="primary" disabled={busy} onClick={() => go('next-quiet', false)} title="Scheduled moves expire after 7 days">Move in the next quiet window</Btn>}
        {!move && choices.includes('anyway') && <Btn kind="danger" disabled={busy} onClick={() => go('now', true)}>Move anyway, now</Btn>}
      </div>
    </Dialog>
  )
}
