'use client'

// =============================================================================
//  Settings → Load balancing & quiet windows
//
//  What a balancing plan evens out (RAM, CPU or both), when the cluster counts
//  as uneven, the smallest gain worth a move and the most moves in one plan.
//  When load balancing may move a guest without "move anyway": outside
//  the cluster's backup jobs (read from its own backup schedules) and outside
//  the hours you say the cluster is in use. Also the bandwidth limit for moves
//  when they share corosync's network, and what counts as a busy node.
//  Times are the cluster's local time. Admin, with the master password re-entered
//  to save; the API checks every field. A move already scheduled runs under the
//  stricter of these and the settings it was approved with; it expires after 7 days.
// =============================================================================

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { apiJson } from '@/lib/api'
import { GhostButton, INPUT, LABEL, Notice, PrimaryButton } from '@/components/vault/ui'
import { HudHeader, Page, Panel } from '@/components/visual/kit'
import { Switch } from '@/components/ha/ui'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { quietWords, seconds } from '@/components/placement/logic'
import type { BusyHours, MapView, PlacementSettings } from '@/components/placement/types'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const GOALS: Array<[PlacementSettings['balanceGoal'], string]> = [['mem', 'RAM'], ['cpu', 'CPU'], ['both', 'CPU and RAM']]

export default function BalanceSettingsPage() {
  const [s, setS] = useState<PlacementSettings | null>(null)
  const [view, setView] = useState<MapView | null>(null)
  const [msg, setMsg] = useState<{ kind: 'error' | 'info'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [reconfirm, setReconfirm] = useState(false)

  useEffect(() => {
    void (async () => {
      const r = await apiJson<{ data: PlacementSettings }>('/api/placement/settings')
      if (r.ok && r.body) setS(r.body.data); else setMsg({ kind: 'error', text: r.error ?? 'Could not read the settings.' })
      const m = await apiJson<{ data: MapView }>('/api/placement/map')
      if (m.ok && m.body) setView(m.body.data)
    })()
  }, [])

  const set = <K extends keyof PlacementSettings>(k: K, v: PlacementSettings[K]) => setS(x => (x ? { ...x, [k]: v } : x))
  const setBusyRow = (i: number, b: Partial<BusyHours>) => s && set('busyHours', s.busyHours.map((x, j) => (j === i ? { ...x, ...b } : x)))

  const save = async () => {
    if (!s) return
    setBusy(true); setMsg(null)
    const r = await apiJson<{ data: PlacementSettings }>('/api/placement/settings', 'PUT', s)
    setBusy(false)
    // Saving changes when approved moves may run, so the server asks for the master password again.
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(true); return }
    if (r.ok && r.body) { setS(r.body.data); setMsg({ kind: 'info', text: 'Saved.' }) } else setMsg({ kind: 'error', text: r.error ?? 'Not saved.' })
  }

  const num = (k: keyof PlacementSettings, label: string, scale = 1, step = 1) => s && (
    <label className="grid gap-1">
      <span style={LABEL}>{label}</span>
      <input type="number" step={step} value={Math.round((Number(s[k]) * scale) * 100) / 100} style={INPUT}
        onChange={e => set(k, (Number(e.target.value) / scale) as any)} />
    </label>
  )

  return (
    <Page>
      <HudHeader level={2} icon="check" eyebrow="Settings" title="Load balancing & quiet windows" label="Load balancing settings" />
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(false)} onDone={() => { setReconfirm(false); void save() }} />}
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      {!s && !msg && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Reading…</p>}
      {s && (
        <>
          <Panel title="Balancing plans" href="/balance" linkLabel="Load balancing">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Balance by">
                <span style={LABEL}>Balance by</span>
                {GOALS.map(([g, w]) => (
                  <button key={g} type="button" aria-pressed={s.balanceGoal === g} onClick={() => set('balanceGoal', g)} className="rounded px-2 py-1 text-xs"
                    style={{ border: '1px solid var(--border-strong)', background: s.balanceGoal === g ? 'var(--accent)' : 'transparent', color: s.balanceGoal === g ? 'var(--accent-ink)' : 'var(--text-soft)' }}>{w}</button>
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {num('unevenAbove', 'Uneven when the gap passes (points)', 100)}
                {num('minGain', 'Smallest gain worth a move (points)', 1, 0.5)}
                {num('maxPlanMoves', 'Moves in one plan, at most')}
              </div>
              <p className="text-xs" style={{ color: 'var(--text-dim)' }}>The balance score is 100 less the gap between the busiest and the least busy node, each measured as a share of its own capacity at the 95th percentile of the window. A plan never pushes a node over the busy line below, and never leaves the node a guest goes to busier than the one it left.</p>
            </div>
          </Panel>
          <Panel title="Quiet windows" sub={view ? `cluster time: ${view.quiet.tz}` : undefined} href="/balance" linkLabel="Load balancing">
            <div className="space-y-4">
              {view && <p className="text-sm" style={{ color: 'var(--text-soft)' }}>{quietWords(view.quiet)}</p>}
              <Switch on={s.avoidBackups} onChange={v => set('avoidBackups', v)} label="Keep moves out of backup job windows" />
              {view && (
                <ul className="list-disc pl-5 text-sm" style={{ color: 'var(--text-soft)' }}>
                  {view.jobs.filter(j => j.enabled).map(j => <li key={j.id}>Backup job at &quot;{j.schedule}&quot;: {j.durationSec ? `its longest recent run took ${seconds(j.durationSec)}` : `no finished run in the task log, so ${s.backupHours} h is assumed`}.</li>)}
                  {!view.jobs.length && <li>No backup jobs found.</li>}
                </ul>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                {num('backupHours', 'Assumed backup length (hours)', 1, 0.25)}
                {num('backupMarginMin', 'Minutes kept clear before a backup')}
              </div>
              <div className="space-y-2">
                <span style={LABEL}>Busy hours (when the cluster is in use)</span>
                {s.busyHours.map((b, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border p-2" style={{ borderColor: 'var(--border-soft)' }}>
                    <div className="flex flex-wrap gap-1" role="group" aria-label="Days">
                      {DAYS.map((d, di) => (
                        <button key={d} type="button" aria-pressed={b.days.includes(di)} onClick={() => setBusyRow(i, { days: b.days.includes(di) ? b.days.filter(x => x !== di) : [...b.days, di].sort() })}
                          className="rounded px-2 py-1 text-xs" style={{ border: '1px solid var(--border-strong)', background: b.days.includes(di) ? 'var(--accent)' : 'transparent', color: b.days.includes(di) ? 'var(--accent-ink)' : 'var(--text-soft)' }}>{d}</button>
                      ))}
                    </div>
                    <input type="time" value={b.start} onChange={e => setBusyRow(i, { start: e.target.value })} style={{ ...INPUT, width: 120 }} aria-label="From" />
                    <span style={{ color: 'var(--text-dim)' }}>to</span>
                    <input type="time" value={b.end} onChange={e => setBusyRow(i, { end: e.target.value })} style={{ ...INPUT, width: 120 }} aria-label="Until" />
                    <input value={b.label ?? ''} placeholder="what (optional)" onChange={e => setBusyRow(i, { label: e.target.value })} style={{ ...INPUT, width: 160 }} aria-label="Label" />
                    <GhostButton type="button" onClick={() => set('busyHours', s.busyHours.filter((_, j) => j !== i))}>Remove</GhostButton>
                  </div>
                ))}
                <GhostButton type="button" onClick={() => set('busyHours', [...s.busyHours, { days: [0, 1, 2, 3, 4, 5, 6], start: '19:00', end: '01:00', label: '' }])}>Add busy hours</GhostButton>
                <p className="text-xs" style={{ color: 'var(--text-dim)' }}>An end before the start runs past midnight. A move outside a quiet window needs &quot;move anyway&quot;, or it can wait for the next quiet window. A move already scheduled runs under the stricter of these and the settings it was approved with, and scheduled moves expire after 7 days. Saving asks for your master password.</p>
              </div>
            </div>
          </Panel>
          <Panel title="Moves on a shared network">
            <div className="grid gap-3 sm:grid-cols-2">
              {num('bwlimitKiB', 'Bandwidth limit for moves (MiB/s)', 1 / 1024)}
              {num('linkMbps', 'Link between nodes (Mbit/s), for estimates')}
            </div>
            <p className="mt-2 text-xs" style={{ color: 'var(--text-dim)' }}>Used when moves share corosync&apos;s network. HA moves take only the datacenter&apos;s own limit.</p>
          </Panel>
          <Panel title="What counts as busy" sub="also the line no plan pushes a node over">
            <div className="grid gap-3 sm:grid-cols-2">
              {num('cpuAbove', 'CPU above (%)', 100)}
              {num('memAbove', 'Memory above (%)', 100)}
              {num('minHours', 'For at least (hours)', 1, 0.5)}
              {num('windowHours', 'Of the last (hours)')}
            </div>
          </Panel>
          <div className="flex flex-wrap justify-end gap-2">
            <Link href="/balance" className="text-sm underline" style={{ color: 'var(--accent)', alignSelf: 'center' }}>Back to Load balancing</Link>
            <PrimaryButton type="button" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</PrimaryButton>
          </div>
        </>
      )}
    </Page>
  )
}
