'use client'

// Every config write: a server-held preview in plain words, then apply (master password, a name to type where
// the change is to devices or raw lines, extra ticks where the hardware is risky), then the outcome as read back
// from Proxmox — and, when the guest runs and the change waits for a restart, the offer to restart it now.

import { useCallback, useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { GhostButton, INPUT, Notice, PrimaryButton, BusyNote } from '@/components/vault/ui'
import { API, type ApplyData, type GuestType, type PreviewData } from './types'

const ACK_WORDS: Record<string, string> = {
  'reset-risk': 'I understand this card may not reset, and stopping the VM can hang the host.',
  'display-gpu': 'I understand the host loses its display and console GPU.',
  'unknown-device': 'I understand HyperProx could not identify this device.',
  'exclusive-device': 'I understand only one guest can use this device at a time.',
}

const RESTART_WORDS = { live: 'now', restart: 'on restart', maybe: 'now or on restart' } as const

export function PreviewDialog({ guest, change, title, onClose, onApplied }: {
  guest: { node: string; type: GuestType; vmid: number; name: string }
  change: any
  title: string
  onClose: () => void
  onApplied?: () => void
}) {
  const [pv, setPv] = useState<PreviewData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [acks, setAcks] = useState<string[]>([])
  const [result, setResult] = useState<ApplyData | null>(null)
  const [restart, setRestart] = useState<{ pv: PreviewData | null; result: ApplyData | null; later: boolean }>({ pv: null, result: null, later: false })
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  // "Remove these too?": hand-written entries the person ticks are added to the change, and it is previewed again.
  const [also, setAlso] = useState<Array<{ key: string; value: string }>>([])
  const effective = change?.kind === 'gpu-off' && also.length ? { ...change, off: { alsoRemove: also } } : change

  const load = useCallback(async () => {
    setBusy(true); setErr(null)
    const r = await apiJson<{ data: PreviewData }>(`${API}/preview`, 'POST', { node: guest.node, type: guest.type, vmid: guest.vmid, change: effective })
    setBusy(false)
    if (!r.ok) { setErr(r.error ?? 'Could not build the preview'); return }
    setPv(r.body!.data)
  }, [guest.node, guest.type, guest.vmid, JSON.stringify(effective)])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load() }, [load])

  const applyId = async (previewId: string, onOk: (d: ApplyData) => void) => {
    setBusy(true); setErr(null)
    const r = await apiJson<{ data: ApplyData; problems?: string[] }>(`${API}/apply`, 'POST', { previewId, confirmName: name, acks })
    setBusy(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void applyId(previewId, onOk)); return }
    if (r.body?.data) { onOk(r.body.data); onApplied?.(); return }
    const problems = (r.body as any)?.problems as string[] | undefined
    setErr([r.error, ...(problems ?? [])].filter(Boolean).join(' — '))
    if (r.code === 'changed' || r.code === 'expired' || r.code === 'used') { setPv(null); void load() }
  }

  const offerRestart = async () => {
    if (!pv) return
    setBusy(true)
    const r = await apiJson<{ data: PreviewData }>(`${API}/preview`, 'POST', { node: guest.node, type: guest.type, vmid: guest.vmid, change: { kind: 'restart', after: pv.previewId } })
    setBusy(false)
    if (!r.ok) { setErr(r.error ?? 'Could not plan the restart'); return }
    setRestart({ pv: r.body!.data, result: null, later: false })
  }

  const needsName = pv?.confirmName
  const ready = pv?.canApply && (!needsName || name === pv.guest.name || name === String(pv.guest.vmid)) && pv.extraConfirm.every(a => acks.includes(a))
  const showRestartOffer = result?.ok && pv?.guest.running && (result.restartOffered || (pv.deviceChecks.length > 0))

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4" style={{ background: 'var(--scrim)', backdropFilter: 'blur(4px)' }}
         onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const f = reconfirm; setReconfirm(null); f() }} />}
      <div role="dialog" aria-modal="true" aria-label={title}
           className="w-full sm:max-w-2xl rounded-t-xl sm:rounded-xl border flex flex-col" style={{ background: 'var(--surface-raised)', borderColor: 'var(--border-soft)', maxHeight: '92vh' }}>
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border-dim)' }}>
          <div className="min-w-0">
            <div className="font-mono uppercase" style={{ fontSize: 11, letterSpacing: '0.14em', color: 'var(--accent)' }}>Preview · {guest.type === 'lxc' ? 'CT' : 'VM'} {guest.vmid}</div>
            <h2 className="font-display font-semibold truncate" style={{ fontSize: 22, color: 'var(--text-bright)' }}>{title}</h2>
          </div>
          <button onClick={onClose} aria-label="Close" disabled={busy} style={{ color: 'var(--text-dimmer)', fontSize: 18 }}>✕</button>
        </div>

        <div className="px-5 py-4 overflow-y-auto space-y-4">
          {busy && !pv && <BusyNote>Reading the guest and checking the plan against the cluster…</BusyNote>}
          {err && <Notice kind="error">{err}</Notice>}

          {pv && !result && (
            <>
              {pv.changes.length > 0 ? (
                <ul className="space-y-1.5">
                  {pv.changes.map((c, i) => (
                    <li key={i} className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-dim)', background: 'var(--ground-deep)' }}>
                      <div className="flex items-start gap-2 justify-between">
                        <span className="text-sm" style={{ color: 'var(--text-bright)' }}>{c.words}</span>
                        <span className="font-mono shrink-0 rounded px-1.5" style={{ fontSize: 10, color: c.restart === 'live' ? 'var(--good)' : 'var(--warn-2)', border: `1px solid color-mix(in srgb, ${c.restart === 'live' ? 'var(--good)' : 'var(--warn)'} 35%, transparent)` }}>
                          applies {RESTART_WORDS[c.restart]}
                        </span>
                      </div>
                      {(c.before !== null || c.after !== null) && (
                        <div className="font-mono mt-1 break-all" style={{ fontSize: 11, color: 'var(--text-dimmer)' }}>
                          {c.key}: {c.before ?? '∅'} → {c.after ?? '∅ (removed)'}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              ) : pv.kind === 'restart' ? null : <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No changes.</p>}

              {pv.options.length > 0 && (
                <div className="rounded-md border p-3 space-y-1" style={{ borderColor: 'var(--border-dim)' }}>
                  <p className="text-sm" style={{ color: 'var(--text)' }}>Hand-written GPU entries HyperProx did not add. They stay unless you tick them. Remove these too?</p>
                  {pv.options.map(o => (
                    <label key={`${o.key}${o.value}`} className="flex items-start gap-2 font-mono cursor-pointer break-all" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      <input type="checkbox" className="mt-0.5" checked={also.some(a => a.key === o.key && a.value === o.value)}
                        onChange={e => setAlso(x => e.target.checked ? [...x, { key: o.key, value: o.value }] : x.filter(a => !(a.key === o.key && a.value === o.value)))} />
                      {o.label}
                    </label>
                  ))}
                </div>
              )}
              {pv.rawFile && <Notice kind="info">Proxmox’s API refuses raw lxc.* lines, so this rewrites the whole config file over the node login: only these lines change, snapshots and every other line stay byte for byte, and it is refused if the file changed since this preview. It applies the next time the container starts.</Notice>}
              {pv.restartNeeded && pv.guest.running && <Notice kind="warn">Some of this applies only after the guest restarts. You can restart it after saving, or leave it pending.</Notice>}
              {pv.errors.map((e, i) => <Notice key={`e${i}`} kind="error">{e}</Notice>)}
              {pv.warnings.map((w, i) => <Notice key={`w${i}`} kind="warn">{w}</Notice>)}
              {pv.checks.length > 0 && (
                <ul className="space-y-0.5">{pv.checks.map((c, i) => <li key={i} className="text-[13px]" style={{ color: 'var(--text-muted)' }}>✓ {c}</li>)}</ul>
              )}

              {pv.canApply && pv.extraConfirm.map(a => (
                <label key={a} className="flex items-start gap-2 text-sm cursor-pointer" style={{ color: 'var(--warn-2)' }}>
                  <input type="checkbox" className="mt-1" checked={acks.includes(a)} onChange={e => setAcks(x => e.target.checked ? [...x, a] : x.filter(y => y !== a))} />
                  {ACK_WORDS[a] ?? a}
                </label>
              ))}
              {pv.canApply && needsName && (
                <div>
                  <label className="block text-sm mb-1" style={{ color: 'var(--text-muted)' }}>Type <b style={{ color: 'var(--text-bright)' }}>{pv.guest.name}</b> to confirm this change to {pv.guest.type === 'lxc' ? 'CT' : 'VM'} {pv.guest.vmid}</label>
                  <input value={name} onChange={e => setName(e.target.value)} style={INPUT} autoComplete="off" aria-label="Guest name" />
                </div>
              )}
            </>
          )}

          {result && <OutcomePanel r={result} />}
          {showRestartOffer && !restart.pv && !restart.later && (
            <div className="rounded-md border p-3 space-y-2" style={{ borderColor: 'color-mix(in srgb, var(--warn) 35%, transparent)' }}>
              <p className="text-sm" style={{ color: 'var(--text)' }}>
                {result!.pendingKeys.length ? <>Applies on next restart: <span className="font-mono">{result!.pendingKeys.join(', ')}</span>.</> : 'The device change is checked inside the guest after a restart.'}
                {pv!.guest.haManaged ? ' This guest is HA-managed, so it is restarted through HA (stopped, then started), not by a direct stop and start.' : ''}
              </p>
              <div className="flex gap-2 flex-wrap">
                <PrimaryButton onClick={() => void offerRestart()} disabled={busy}>Restart now</PrimaryButton>
                <GhostButton onClick={() => setRestart(r => ({ ...r, later: true }))}>Later</GhostButton>
              </div>
            </div>
          )}
          {restart.later && <Notice kind="info">Left pending: it applies when {guest.name} next restarts. The guest page shows it as pending until then.</Notice>}
          {restart.pv && !restart.result && (
            <div className="space-y-2">
              {restart.pv.checks.map((c, i) => <p key={i} className="text-[13px]" style={{ color: 'var(--text-muted)' }}>✓ {c}</p>)}
              {restart.pv.warnings.map((w, i) => <Notice key={i} kind="warn">{w}</Notice>)}
              {restart.pv.errors.map((e, i) => <Notice key={i} kind="error">{e}</Notice>)}
              {restart.pv.canApply && <PrimaryButton disabled={busy} onClick={() => void applyId(restart.pv!.previewId, d => setRestart(r => ({ ...r, result: d })))}>{busy ? 'Restarting…' : `Restart ${guest.name}`}</PrimaryButton>}
              {busy && <BusyNote>Restarting and waiting for it to come back. This can take a couple of minutes.</BusyNote>}
            </div>
          )}
          {restart.result?.restart && <RestartPanel r={restart.result.restart} />}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t" style={{ borderColor: 'var(--border-dim)' }}>
          <GhostButton onClick={onClose} disabled={busy}>{result ? 'Close' : 'Cancel'}</GhostButton>
          {pv && !result && pv.kind !== 'restart' && <PrimaryButton disabled={!ready || busy} onClick={() => void applyId(pv.previewId, setResult)}>{busy ? 'Saving…' : 'Save'}</PrimaryButton>}
          {pv && !result && pv.kind === 'restart' && <PrimaryButton disabled={!ready || busy} onClick={() => void applyId(pv.previewId, setResult)}>{busy ? 'Restarting…' : 'Restart'}</PrimaryButton>}
        </div>
      </div>
    </div>
  )
}

export function OutcomePanel({ r }: { r: ApplyData }) {
  if (r.restart) return <RestartPanel r={r.restart} />
  const o = r.outcome
  return (
    <div className="space-y-2">
      <Notice kind={r.ok ? 'info' : 'error'}>{r.ok ? 'Saved, and read back from Proxmox exactly as previewed.' : 'The change did not land as previewed.'}</Notice>
      {o && (
        <p className="font-mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          raw lines {o.rawBefore} → {o.rawAfter} · unmodelled keys {o.unknownBefore} → {o.unknownAfter}
        </p>
      )}
      {o?.problems.map((p, i) => <Notice key={i} kind="error">{p}</Notice>)}
    </div>
  )
}

function RestartPanel({ r }: { r: NonNullable<ApplyData['restart']> }) {
  return (
    <div className="space-y-2">
      <Notice kind={r.ok ? 'info' : 'error'}>{r.ok ? `Restarted ${r.via === 'ha' ? 'through HA' : 'directly'}; everything checked after it.` : 'The restart finished with problems.'}</Notice>
      <ul className="text-[13px] space-y-0.5" style={{ color: 'var(--text-muted)' }}>
        {r.steps.map((s, i) => <li key={i}>· {s}</li>)}
        <li>{r.pendingAfter.length ? `✗ still pending: ${r.pendingAfter.join(', ')}` : '✓ nothing left pending'}</li>
        {r.rawSurvived !== null && <li>{r.rawSurvived ? '✓ raw lines survived the restart' : '✗ raw lines changed across the restart'}</li>}
        {r.devices.map((d, i) => <li key={i}>{d.seen === d.expected ? '✓' : '✗'} {d.path} {d.seen === null ? 'could not be checked' : d.seen ? 'is visible inside' : 'is not visible inside'}</li>)}
      </ul>
      {r.problems.map((p, i) => <Notice key={i} kind="error">{p}</Notice>)}
    </div>
  )
}
