'use client'

// The Automatic reboots card on the Updates page: what waits for a reboot and when it happens, the window and the
// switches, a rolling reboot in progress node by node, the last ten runs, Reboot now and, after a run that stopped
// with something left on for safety, Make safe. Every change is confirmed on the page and audited by the API.

import { Fragment, useState } from 'react'
import type { UpdatesRebootSettings, UpdatesRebootStatus } from '@hyperprox/types'
import { FlowPipeline, styles } from '@/components/visual/kit'
import { Badge, Btn, Chevron, ConfirmDialog, Empty, Notice, Panel, TH, THEAD_STYLE, fmtTime } from './ui'
import { DAY_NAMES, awayText, daysText, rollingStages, summaryText, whenText, windowText } from '@/lib/auto-reboots'

const STATUS_TONE: Record<string, 'good' | 'warn' | 'crit' | 'muted' | 'accent'> = {
  done: 'good', failed: 'crit', cancelled: 'muted', running: 'accent', paused: 'warn', planned: 'muted', 'awaiting-confirm': 'warn',
}

export function RebootsCard({ status, error, busy, jobActive, tag, onSave, onRebootNow, onMakeSafe }: {
  status: UpdatesRebootStatus | null
  error: string | null
  busy: boolean
  /** Another Updates job is running: Reboot now waits. */
  jobActive: boolean
  tag?: React.ReactNode
  onSave: (patch: Partial<UpdatesRebootSettings>) => void
  onRebootNow: (all: boolean) => void
  onMakeSafe: () => void
}) {
  const [editing, setEditing] = useState<UpdatesRebootSettings | null>(null)
  const [asking, setAsking] = useState(false)
  const [all, setAll] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  if (error) return <Panel title="Automatic reboots" tag={tag}><Notice tone="warn">{error}</Notice></Panel>
  if (!status) return <Panel title="Automatic reboots" tag={tag}><Empty>Reading…</Empty></Panel>
  if (!status.available) return <Panel title="Automatic reboots" tag={tag}><p className="text-sm" style={{ color: 'var(--text-muted)' }}>{status.unavailable}</p></Panel>

  const s = status.settings
  const tz = s.timezone
  const waitingCount = status.waiting.nodes.length + status.waiting.guests.length
  const live = status.active
  const stages = live ? rollingStages(live) : []
  const form = editing ?? s

  return (
    <Panel title="Automatic reboots" tag={tag} right={
      <span className="flex flex-wrap gap-2">
        <Btn small onClick={() => setEditing(editing ? null : { ...s, window: { ...s.window, days: [...s.window.days] } })} disabled={busy} aria-expanded={!!editing}>
          {editing ? 'Close settings' : 'Settings'}
        </Btn>
        <Btn small kind="danger" onClick={() => { setAll(false); setAsking(true) }} disabled={busy || jobActive || !!live}
             title={jobActive ? 'Another Updates job is running.' : undefined}>
          Reboot now (rolling)
        </Btn>
      </span>
    }>
      <p className="text-sm" style={{ color: 'var(--text-soft)' }}>{summaryText(status)}</p>
      {status.nextWindow && (s.nodes || s.guests || status.queued) && (
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          {status.inWindow ? 'In the window now. ' : ''}Next: {whenText(status.nextWindow.start, tz)} ({tz}).
          {status.queued && ` Asked for once by ${status.queued.by} with an update run.`}
        </p>
      )}

      {status.leftOn && (
        <div className="mt-3">
          <Notice tone="crit">
            <div className="flex flex-wrap items-center gap-3">
              <span>
                The last rolling reboot stopped and left {[status.leftOn.maintenance ? `HA maintenance on ${status.leftOn.node}` : '', status.leftOn.noout ? 'Ceph noout' : ''].filter(Boolean).join(' and ')} on, so nothing moves while {status.leftOn.node} is not healthy.
                Make safe clears them; noout comes off only when every OSD is up.
              </span>
              <Btn small kind="primary" onClick={onMakeSafe} disabled={busy || jobActive}>Make safe</Btn>
            </div>
          </Notice>
        </div>
      )}

      {live && (
        <div className="mt-3 space-y-2">
          <p className="text-sm" style={{ color: 'var(--text-bright)' }}>
            Rolling reboot in progress{live.status !== 'running' ? ` (${live.status})` : ''}: one machine at a time.
          </p>
          <FlowPipeline label="Rolling reboot, machine by machine" stages={stages.map(x => ({
            key: x.key, label: x.label, state: x.state, status: x.status,
            value: x.state === 'done' ? '✓' : x.state === 'bad' ? '!' : x.state === 'warn' ? '↻' : '·',
            sub: x.status,
          }))} />
        </div>
      )}

      <div className="mt-3">
        {!waitingCount ? (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Nothing is waiting for a reboot.</p>
        ) : (
          <ul className="space-y-1 text-sm" aria-label="Waiting for a reboot">
            {status.waiting.nodes.map(n => (
              <li key={n.node} style={{ color: 'var(--text-soft)' }}>
                <span className="font-semibold" style={{ color: 'var(--text-bright)' }}>{n.node}</span> — {n.why}.{' '}
                {status.waiting.at ? <span style={{ color: 'var(--accent)' }}>Waiting for its automatic reboot at {whenText(status.waiting.at, tz)}.</span>
                  : <span style={{ color: 'var(--text-muted)' }}>Automatic reboots are off for nodes.</span>}
              </li>
            ))}
            {status.waiting.guests.map(g => (
              <li key={g.vmid} style={{ color: 'var(--text-soft)' }}>
                <span className="font-semibold" style={{ color: 'var(--text-bright)' }}>{g.vmid} {g.name}</span> on {g.node} asks for a reboot.{' '}
                {status.waiting.guestsAt ? <span style={{ color: 'var(--accent)' }}>Waiting for its automatic reboot at {whenText(status.waiting.guestsAt, tz)}.</span>
                  : <span style={{ color: 'var(--text-muted)' }}>Automatic reboots are off for guests.</span>}
              </li>
            ))}
          </ul>
        )}
        {status.byHand.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-xs" aria-label="Not rebooted automatically" style={{ color: 'var(--text-muted)' }}>
            {status.byHand.map(x => <li key={x.target}><span className="font-semibold">{/^\d+$/.test(x.target) ? `guest ${x.target}` : x.target}</span> needs a reboot, but not automatically: {x.reason}.</li>)}
          </ul>
        )}
        {status.never.length > 0 && (
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>Never rebooted automatically (policy <span className="font-mono">auto_reboot: false</span>): {status.never.join(', ')}.</p>
        )}
      </div>

      {editing && (
        <form className="mt-4 grid gap-3 sm:grid-cols-2" aria-label="Automatic reboot settings" onSubmit={e => { e.preventDefault(); onSave(form); setEditing(null) }}>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.nodes} onChange={e => setEditing({ ...form, nodes: e.target.checked })} /> Reboot nodes automatically</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.guests} onChange={e => setEditing({ ...form, guests: e.target.checked })} /> Reboot guests that ask for it</label>
          <label className="text-sm">Window starts
            <input type="time" className={`${styles.input ?? ''} mt-1 block w-full`} value={form.window.start} onChange={e => setEditing({ ...form, window: { ...form.window, start: e.target.value } })} />
          </label>
          <label className="text-sm">Lasts
            <select className={`${styles.input ?? ''} mt-1 block w-full`} value={form.window.hours} onChange={e => setEditing({ ...form, window: { ...form.window, hours: Number(e.target.value) } })}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map(h => <option key={h} value={h}>{h} hour{h === 1 ? '' : 's'}</option>)}
            </select>
          </label>
          <fieldset className="text-sm sm:col-span-2">
            <legend>Days</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {DAY_NAMES.map((d, i) => (
                <label key={d} className="flex items-center gap-1">
                  <input type="checkbox" checked={form.window.days.includes(i)}
                         onChange={e => setEditing({ ...form, window: { ...form.window, days: e.target.checked ? [...form.window.days, i].sort() : form.window.days.filter(x => x !== i) } })} />{d}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="text-sm">Time zone
            <input className={`${styles.input ?? ''} mt-1 block w-full font-mono`} value={form.timezone} onChange={e => setEditing({ ...form, timezone: e.target.value })} />
          </label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.quiet} onChange={e => setEditing({ ...form, quiet: e.target.checked })} /> Only when nobody is watching (waits while Plex has streams, asking again every 10 minutes)</label>
          <p className="text-xs sm:col-span-2" style={{ color: 'var(--text-muted)' }}>
            {windowText(form.window)} {daysText(form.window.days)}, {form.timezone}. Nodes go one at a time, HyperProx&apos;s own node last; the first problem stops the run safely and sends one message.
          </p>
          <div className="flex gap-2 sm:col-span-2">
            <Btn kind="primary" type="submit" disabled={busy || !form.window.days.length}>Save</Btn>
            <Btn onClick={() => setEditing(null)}>Cancel</Btn>
          </div>
        </form>
      )}

      <div className="mt-4">
        <p className="mb-1 text-xs font-mono" style={{ color: 'var(--text-muted)' }}>LAST {Math.min(10, status.history.length) || ''} RUNS</p>
        {!status.history.length ? <Empty>No rolling reboots yet.</Empty> : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr style={THEAD_STYLE}>
                  <th scope="col" className={TH}><span className="sr-only">Expand</span></th>
                  <th scope="col" className={TH}>WHEN</th>
                  <th scope="col" className={TH}>RESULT</th>
                  <th scope="col" className={TH}>WHAT HAPPENED</th>
                </tr>
              </thead>
              <tbody>
                {status.history.map(h => (
                  <Fragment key={h.id}>
                    <tr style={{ borderBottom: '1px solid var(--border-dim)' }}>
                      <td className="px-4 py-2">
                        <button type="button" onClick={() => setOpen(open === h.id ? null : h.id)} aria-expanded={open === h.id} aria-label={`Details of the run started ${fmtTime(h.startedAt)}`}><Chevron open={open === h.id} /></button>
                      </td>
                      <td className="px-4 py-2 text-xs">{fmtTime(h.startedAt)} · {h.kind === 'window' ? 'window' : 'by hand'}</td>
                      <td className="px-4 py-2"><Badge tone={STATUS_TONE[h.status] ?? 'muted'}>{h.status === 'failed' ? 'stopped' : h.status}</Badge></td>
                      <td className="px-4 py-2 text-xs" style={{ color: 'var(--text-soft)' }}>{h.summary}</td>
                    </tr>
                    {open === h.id && (
                      <tr style={{ background: 'var(--ground-inset)' }}>
                        <td colSpan={4} className="px-4 py-2">
                          <ul className="space-y-1 text-xs" style={{ color: 'var(--text-soft)' }}>
                            {h.machines.map(m => (
                              <li key={m.target}>
                                <span className="font-semibold" style={{ color: 'var(--text-bright)' }}>{m.kind === 'guest' ? `guest ${m.target}` : m.target}</span>{' '}
                                {m.status === 'ok' ? 'rebooted' : m.status === 'failed' ? `stopped: ${m.reason ?? ''}` : `not rebooted: ${m.reason ?? m.status}`}
                                {m.result?.kernelBefore || m.result?.kernelAfter ? <span className="font-mono"> · kernel {m.result?.kernelBefore ?? '?'} → {m.result?.kernelAfter ?? '?'}</span> : null}
                                {m.result?.downSeconds != null ? ` · away ${awayText(m.result.downSeconds)}` : ''}
                                {m.result?.inPlace ? ' · guests restarted in place' : ''}
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {asking && (
        <ConfirmDialog title="Reboot now, one machine at a time?" onClose={() => setAsking(false)}>
          <ul className="list-disc space-y-1.5 pl-5 text-sm" style={{ color: 'var(--text-soft)' }}>
            <li>Every node must be online and the cluster must stay quorate with the node gone; Ceph must be healthy.</li>
            <li>Each node: Ceph <span className="font-mono">noout</span>, HA guests moved off (guests that cannot move restart with it), reboot, wait for it and Ceph to be clean, then everything back.</li>
            <li>HyperProx&apos;s own node goes last; HyperProx is away while it reboots and finishes the checks when it is back and unlocked.</li>
            <li>The first problem stops the run, safely, and sends one message.</li>
            {s.quiet && <li>Waits while anyone is watching, for up to {s.window.hours} hour{s.window.hours === 1 ? '' : 's'}.</li>}
          </ul>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> Every node, even ones that do not need a reboot</label>
          <div className="flex justify-end gap-2">
            <Btn kind="danger" onClick={() => { setAsking(false); onRebootNow(all) }}>{all ? 'Reboot every node' : `Reboot ${waitingCount || 'what waits'}`}</Btn>
            <Btn onClick={() => setAsking(false)}>Cancel</Btn>
          </div>
        </ConfirmDialog>
      )}
    </Panel>
  )
}
