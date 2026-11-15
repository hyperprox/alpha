'use client'

// =============================================================================
//  HyperProx — what auto-connect left for a person (GET /api/auto-connect)
//
//  Plug-ins connect what they find by themselves (lib/auto-connect on the API).
//  Only two things are left for a person, and this panel shows exactly those
//  for the plug-ins it is given: a pick when two candidates could not be told
//  apart, and "Connect again" for something they disconnected. Nothing else
//  here is a step to click through. Admin only (the API refuses others).
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'
import { Panel, styles as vs } from '@/components/visual/kit'

interface Pending { at: number; label: string; message: string; choiceKind: string; choices: Array<{ id: string; label: string }> }
interface State {
  dismissed: Record<string, { at: number; label: string; by: string }>
  connected: Record<string, { at: number; label: string; evidence: string[]; vaultItem: { id: string; name: string } | null }>
  pending: Record<string, Pending>
  lastRun: { at: number; waited: string | null } | null
  waitingForUnlock: boolean
}

const split = (k: string) => { const i = k.indexOf('/'); return { plugin: k.slice(0, i), key: k.slice(i + 1) } }

export function AutoConnectPanel({ plugins, onChanged }: { plugins: string[]; onChanged?: () => void }) {
  const [s, setS] = useState<State | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null)
  const load = useCallback(async () => {
    const r = await apiJson<{ data: State }>('/api/auto-connect')
    if (r.ok) setS(r.body!.data)
  }, [])
  useEffect(() => { void load() }, [load])

  if (!s) return null
  const mine = (k: string) => plugins.includes(split(k).plugin)
  const pending = Object.entries(s.pending).filter(([k]) => mine(k))
  const dismissed = Object.entries(s.dismissed).filter(([k]) => mine(k))
  if (!pending.length && !dismissed.length && !s.waitingForUnlock) return null

  const act = async (id: string, path: string, body: Record<string, string>, done: string) => {
    setBusy(id); setNote(null)
    const r = await apiJson(`/api/auto-connect/${path}`, 'POST', body)
    setBusy(null)
    setNote(r.ok ? { text: done, ok: true } : { text: r.error ?? 'That did not work.', ok: false })
    await load()
    onChanged?.()
  }

  return (
    <Panel title="Connecting by itself" sub={pending.length ? `${pending.length} to pick` : undefined}>
      {s.waitingForUnlock && <p className="text-sm" style={{ color: 'var(--text-soft)' }}>HyperProx is locked: it connects what it found as soon as it is unlocked.</p>}
      {note && <p className="text-sm" role="status" style={{ color: note.ok ? 'var(--good)' : 'var(--warn-2)' }}>{note.text}</p>}
      {pending.map(([k, p]) => (
        <div key={k} className="mb-3">
          <p className="text-sm" style={{ color: 'var(--text-bright)' }}>{p.message}</p>
          <div className="flex flex-wrap gap-2 mt-1">
            {p.choices.map(c => (
              <button key={c.id} type="button" className={`${vs.btn} ${vs.btnPri}`} disabled={busy === k}
                onClick={() => void act(k, 'pick', { ...split(k), choice: c.id }, `Connected with ${c.label}.`)}>
                {p.choiceKind === 'vault-item' ? `Use ${c.label}` : c.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      {dismissed.length > 0 && (
        <ul className="text-sm" style={{ color: 'var(--text-soft)' }}>
          {dismissed.map(([k, d]) => (
            <li key={k} className="flex flex-wrap items-center gap-2 mb-1">
              <span>{d.label}: disconnected by {d.by}, so HyperProx leaves it alone.</span>
              <button type="button" className={vs.btn} disabled={busy === k} onClick={() => void act(k, 'connect-again', split(k), `${d.label} is connected again.`)}>Connect again</button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

/** "Connected automatically" beside an instance HyperProx connected by itself. */
export function AutoConnectedNote({ evidence, extra }: { evidence: string[]; extra?: string | null }) {
  return (
    <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
      Connected automatically{evidence.length ? ` (${evidence.join(', ')})` : ''}.{extra ? ` ${extra}` : ''}
    </p>
  )
}
