'use client'

// Automatic balancing: off by default. On, it checks every so often and, when the cluster has been uneven for a
// sustained time outside busy hours and backups, tells you through the notification channels. "Apply automatically"
// also runs one move at a time, only for guests HA does not manage (HA guests get a suggestion: a move or a rule
// change, for a person to decide), within its own limits. Saving asks for the master password; turning applying on
// records who approved it. The emergency stop turns applying off at once and stops any plan after the move under way.

import { useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { Btn, Note, Switch, SELECT } from '@/components/ha/ui'
import { autoWords, stopWords } from './balance-logic'
import type { AutoSettings, AutoView } from './types'

export function AutoPanel({ auto, admin, onSaved }: { auto: AutoView; admin: boolean; onSaved: () => void }) {
  const [s, setS] = useState<AutoSettings>(auto.settings)
  const [msg, setMsg] = useState<{ tone: 'good' | 'crit' | 'info'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [reconfirm, setReconfirm] = useState(false)
  useEffect(() => { setS(auto.settings) }, [auto.settings])
  const dirty = JSON.stringify(s) !== JSON.stringify(auto.settings)
  const set = <K extends keyof AutoSettings>(k: K, v: AutoSettings[K]) => setS(x => ({ ...x, [k]: v, ...(k === 'enabled' && !v ? { apply: false } : {}) }))

  const save = async () => {
    setBusy(true); setMsg(null)
    const r = await apiJson('/api/placement/auto', 'PUT', s)
    setBusy(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(true); return }
    if (!r.ok) { setMsg({ tone: 'crit', text: r.error ?? 'Not saved.' }); return }
    setMsg({ tone: 'good', text: 'Saved.' }); onSaved()
  }
  const stop = async () => {
    setBusy(true); setMsg(null)
    const r = await apiJson<{ data: { stopped: number; cancelledMoves: number } }>('/api/placement/auto/stop', 'POST', {})
    setBusy(false)
    setMsg(r.ok ? { tone: 'info', text: stopWords(r.body?.data.stopped ?? 0, r.body?.data.cancelledMoves ?? 0) } : { tone: 'crit', text: r.error ?? 'Not stopped.' })
    onSaved()
  }
  const num = (k: 'sustainHours' | 'checkEveryMin' | 'maxMovesPerDay' | 'minHoursBetween', label: string) => (
    <label className="grid gap-1 text-sm" style={{ color: 'var(--text-soft)' }}>
      <span>{label}</span>
      <input type="number" value={s[k]} disabled={!admin} onChange={e => set(k, Number(e.target.value))} style={{ ...SELECT, width: 110 }} aria-label={label} />
    </label>
  )

  return (
    <div className="space-y-3" data-testid="auto-panel">
      <Note tone={!auto.settings.enabled ? 'info' : auto.settings.apply ? 'warn' : 'good'}>{autoWords(auto)}</Note>
      <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
        Applies only to guests HA does not manage. For HA guests it suggests a move or a change to their HA rule, and you decide; Proxmox&apos;s own scheduler keeps its say. It never moves a guest whose measured load would push the other node over the busy line, never copies disks over the network, keeps to the bandwidth limit when moves share the cluster heartbeat&apos;s network, and runs only in quiet windows.
      </p>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Switch on={s.enabled} disabled={!admin} onChange={v => set('enabled', v)} label="Check the balance automatically (notify me)" />
        <Switch on={s.apply} disabled={!admin || !s.enabled} onChange={v => set('apply', v)} label="Apply automatically" />
      </div>
      {s.enabled && (
        <div className="grid gap-3 sm:grid-cols-4">
          {num('sustainHours', 'Uneven for at least (h)')}
          {num('checkEveryMin', 'Check every (min)')}
          {num('maxMovesPerDay', 'Moves per day, at most')}
          {num('minHoursBetween', 'Hours between moves')}
        </div>
      )}
      {auto.settings.apply && <p className="text-xs" style={{ color: 'var(--text-dim)' }}>Emergency stop turns applying off at once, cancels every scheduled plan and scheduled single move, and stops running plans after the move under way.</p>}
      {s.apply && !auto.settings.apply && <Note tone="warn">Turning applying on asks for your master password and records you as the person who approved it, with today's limits (later changes can only make them stricter). The approval lasts 30 days, and Ceph warnings you accept now are good for 7. If your role is lowered, applying turns itself off.</Note>}
      {msg && <Note tone={msg.tone}>{msg.text}</Note>}
      {admin && (
        <div className="flex flex-wrap justify-end gap-2">
          {(auto.settings.apply) && <Btn kind="danger" disabled={busy} onClick={stop} title="Turns applying off, cancels scheduled plans and scheduled single moves, and stops running plans after the move under way">Emergency stop</Btn>}
          <Btn kind="primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save'}</Btn>
        </div>
      )}
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(false)} onDone={() => { setReconfirm(false); void save() }} />}
    </div>
  )
}
