'use client'

// The one place the schedule is written down: when HyperProx checks, installs and reboots by itself, and when it
// updates itself. "Edit schedule…" opens the existing switches and the reboot window; "Check now" is the one
// way to read the machines again.

import { useEffect, useState } from 'react'
import type { UpdatesRebootSettings, UpdatesRebootStatus } from '@hyperprox/types'
import { apiJson } from '@/lib/api'
import { Btn, ConfirmDialog, Panel } from './ui'
import { RebootSettingsForm } from './RebootSettingsForm'
import type { ScheduleLine } from '@/lib/updates-overview'

interface SelfStatus { installed: { version: string }; check: { available: { label: string } | null; error: string | null } | null }

/** HyperProx's own version and whether a newer one is out; null until read (or when not readable). */
function useSelfLine(on: boolean): string | null {
  const [line, setLine] = useState<string | null>(null)
  useEffect(() => {
    if (!on) return
    let alive = true
    apiJson<SelfStatus>('/api/self-update/status').then(r => {
      if (!alive) return
      if (!r.ok || !r.body) { setLine('could not be read'); return }
      const av = r.body.check?.available
      setLine(`v${r.body.installed.version} · ${av ? `${av.label} is available` : r.body.check?.error ? 'could not check for a newer version' : 'up to date'}`)
    })
    return () => { alive = false }
  }, [on])
  return line
}

export function ScheduleCard({ lines, tag, showSelf, checkLabel, canCheck, checkWhy, onCheck, canEdit, auto, onToggleAuto, reboots, busy, onSaveReboots }: {
  lines: ScheduleLine[]
  tag?: React.ReactNode
  /** The HyperProx-itself line (home only). */
  showSelf: boolean
  checkLabel: string
  canCheck: boolean
  checkWhy?: string
  onCheck: () => void
  canEdit: boolean
  /** null: the switch does not apply (a remote). */
  auto: { enabled: boolean; line: string } | null
  onToggleAuto: (on: boolean) => void
  reboots: UpdatesRebootStatus | null
  busy: boolean
  onSaveReboots: (s: UpdatesRebootSettings) => void
}) {
  const [editing, setEditing] = useState(false)
  const self = useSelfLine(showSelf)
  const all: ScheduleLine[] = [...lines, ...(showSelf ? [{ key: 'self', label: 'HyperProx itself', value: self ?? '…' }] : [])]
  return (
    <Panel title="Schedule" tag={tag}>
      <dl className="grid gap-2 text-sm">
        {all.map(l => (
          <div key={l.key} className="flex flex-wrap justify-between gap-x-4 gap-y-0.5">
            <dt style={{ color: 'var(--text)' }}>{l.label}</dt>
            <dd className="m-0 text-right" style={{ color: 'var(--text-muted)' }}>{l.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        {canEdit && <Btn onClick={() => setEditing(true)}>Edit schedule…</Btn>}
        <span title={checkWhy}><Btn onClick={onCheck} disabled={!canCheck}>{checkLabel}</Btn></span>
      </div>
      {editing && (
        <ConfirmDialog title="Edit schedule" onClose={() => setEditing(false)}>
          {auto && (
            <div className="flex items-start gap-3">
              <button type="button" role="switch" aria-checked={auto.enabled} aria-label="Install updates automatically"
                      disabled={busy} onClick={() => onToggleAuto(!auto.enabled)}
                      className="mt-0.5 h-6 w-11 shrink-0 rounded-full border transition-colors"
                      style={{ background: auto.enabled ? 'var(--accent)' : 'transparent', borderColor: 'var(--hx-line)' }}>
                <span className="block h-4 w-4 rounded-full transition-transform" style={{ background: auto.enabled ? 'var(--accent-ink, #fff)' : 'var(--text-muted)', transform: `translateX(${auto.enabled ? 22 : 3}px)` }} />
              </button>
              <div className="text-sm">
                <p style={{ color: 'var(--text-bright)' }}>Install updates automatically</p>
                <p style={{ color: 'var(--text-muted)' }}>{auto.enabled ? auto.line : `Off. When on: ${auto.line.charAt(0).toLowerCase()}${auto.line.slice(1)}`}</p>
              </div>
            </div>
          )}
          {reboots?.available && (
            <div className="space-y-2">
              <p className="font-semibold" style={{ color: 'var(--text-bright)' }}>Automatic reboots</p>
              <RebootSettingsForm settings={reboots.settings} busy={busy} onSave={s => { onSaveReboots(s); setEditing(false) }} onCancel={() => setEditing(false)} />
            </div>
          )}
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            When the daily check runs comes from the policy file. HyperProx&apos;s own update schedule is under Advanced.
          </p>
          <div className="flex justify-end"><Btn onClick={() => setEditing(false)}>Done</Btn></div>
        </ConfirmDialog>
      )}
    </Panel>
  )
}
