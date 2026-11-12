'use client'

// =============================================================================
//  HyperProx — Deck: a changed SSH host key
//
//  Shown over a pane whose host offered a different key from the pinned one. Nobody is asked to compare
//  fingerprints: the API checks the key with Proxmox (the guest's own key files, read on its node) and this panel
//  says what it found.
//    verified  amber: the key belongs to the guest; one button re-pins exactly that key and reconnects
//    mismatch  red: something else answers at the guest's address; an admin can still trust it, by typing a phrase
//    unknown   neutral: why it could not check, the fingerprints, and (admins) the manual path behind a confirm
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { styles } from '@/components/visual/kit'
import { useSession } from '@/lib/session'
import { atLeast } from '@/lib/api'

export interface HostKeyChange { host: string; port: number; pinned: string; offered: string; offeredType: string }

interface Guest { type: 'lxc' | 'qemu'; vmid: number; node: string; name: string; status: string }
interface Verdict {
  verdictId: string | null
  state: 'verified' | 'mismatch' | 'unknown' | 'unchanged'
  host: string; port: number
  pinned: string | null
  offered: { fingerprint: string; type: string }
  guest?: Guest
  guestKeys?: Array<{ type: string; fingerprint: string }>
  reason?: string
  why?: string
  context: string[]
}

const PHRASE = 'trust anyway'

const guestLabel = (g: Guest) => `${g.name} (${g.type === 'lxc' ? 'LXC' : 'VM'} ${g.vmid})`

const TONE = {
  verified: { border: 'var(--warn)', tint: 'color-mix(in srgb, var(--warn) 8%, var(--surface))', title: 'var(--warn)' },
  mismatch: { border: 'var(--crit)', tint: 'color-mix(in srgb, var(--crit) 9%, var(--surface))', title: 'var(--crit-soft)' },
  neutral:  { border: 'var(--border-strong)', tint: 'var(--surface)', title: 'var(--text-bright)' },
}

export function HostKeyPanel({ hostId, change, onTrusted, onClose }: {
  hostId: string
  change: HostKeyChange
  onTrusted: (message: string) => void
  onClose: () => void
}) {
  const { role } = useSession()
  const admin = atLeast(role, 'admin')
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [override, setOverride] = useState(false)
  const [phrase, setPhrase] = useState('')

  const check = useCallback(async () => {
    setError(null); setVerdict(null); setOverride(false); setPhrase('')
    try {
      const res = await fetch(`/api/terminal/hosts/${encodeURIComponent(hostId)}/hostkey/verify`, { method: 'POST' }).then(r => r.json())
      if (!res.success) return setError(res.error ?? 'HyperProx could not check the key.')
      setVerdict(res.data)
    } catch (e: any) { setError(e?.message ?? 'HyperProx could not check the key.') }
  }, [hostId])

  useEffect(() => { check() }, [check])

  const trust = async (body: Record<string, unknown>) => {
    if (!verdict?.verdictId) return
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/terminal/hosts/${encodeURIComponent(hostId)}/hostkey/trust`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verdictId: verdict.verdictId, ...body }),
      }).then(r => r.json())
      if (!res.success) return setError(res.error ?? 'The key was not trusted.')
      onTrusted(`The new key for ${verdict.host}:${verdict.port} is pinned. Reconnecting.`)
    } catch (e: any) { setError(e?.message ?? 'The key was not trusted.') }
    finally { setBusy(false) }
  }

  const tone = verdict?.state === 'verified' ? TONE.verified : verdict?.state === 'mismatch' ? TONE.mismatch : TONE.neutral

  const fingerprints = (
    <details className="mt-3 text-[12px]" style={{ color: 'var(--text-dim)' }}>
      <summary className="cursor-pointer select-none">Fingerprints</summary>
      <div className="mt-2 space-y-1 font-mono text-[11.5px] break-all">
        <div>pinned:  {verdict?.pinned ?? change.pinned}</div>
        <div>offered: {verdict?.offered.fingerprint ?? change.offered} ({verdict?.offered.type ?? change.offeredType})</div>
        {verdict?.guestKeys?.map(k => <div key={k.fingerprint + k.type}>guest:   {k.fingerprint} ({k.type})</div>)}
      </div>
    </details>
  )

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center p-4" style={{ background: 'color-mix(in srgb, var(--ground) 82%, transparent)' }}>
      <div role={verdict?.state === 'mismatch' ? 'alert' : 'status'} className="w-full max-w-lg rounded-md border px-4 py-4 text-[13.5px] leading-relaxed"
        style={{ borderColor: tone.border, background: tone.tint, color: 'var(--text-soft)' }}>

        {!verdict && !error && (
          <p>This host offered a different SSH key from the one HyperProx pinned. Checking with Proxmox…</p>
        )}

        {verdict?.state === 'verified' && verdict.guest && (
          <>
            <p className="font-semibold" style={{ color: tone.title }}>This guest&apos;s SSH key changed.</p>
            <p className="mt-1">
              HyperProx checked with Proxmox, and the new key belongs to {guestLabel(verdict.guest)}. This usually means it was
              rebuilt, restored or renumbered.
            </p>
          </>
        )}

        {verdict?.state === 'mismatch' && (
          <>
            <p className="font-semibold" style={{ color: tone.title }}>
              Something other than {verdict.guest ? guestLabel(verdict.guest) : 'this guest'} is answering at this address. Don&apos;t connect.
            </p>
            <p className="mt-1">
              HyperProx read the guest&apos;s own SSH keys through Proxmox, and the key offered at {verdict.host}:{verdict.port} is not one of them.
              No login was sent.
            </p>
          </>
        )}

        {verdict?.state === 'unknown' && (
          <>
            <p className="font-semibold" style={{ color: tone.title }}>HyperProx could not check this key.</p>
            <p className="mt-1">{verdict.why}</p>
            <p className="mt-1">No login was sent. If you did not expect this host to change, don&apos;t trust the new key.</p>
          </>
        )}

        {verdict?.state === 'unchanged' && (
          <p>The host offers its pinned key again. Reconnect to open the session.</p>
        )}

        {!!verdict?.context.length && (
          <ul className="mt-2 list-disc pl-5 text-[12.5px]" style={{ color: 'var(--text-dim)' }}>
            {verdict.context.map(c => <li key={c}>{c}</li>)}
          </ul>
        )}

        {(verdict || error) && fingerprints}

        {error && <p className="mt-3 text-[13px]" style={{ color: 'var(--crit-soft)' }}>{error}</p>}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {verdict?.state === 'verified' && (
            <button onClick={() => trust({})} disabled={busy} className={`${styles.btn} ${styles.btnPri}`}>
              {busy ? 'Trusting…' : 'Trust the new key and connect'}
            </button>
          )}

          {verdict?.state === 'unchanged' && (
            <button onClick={() => onTrusted('Reconnecting.')} className={`${styles.btn} ${styles.btnPri}`}>Reconnect</button>
          )}

          {verdict?.state === 'mismatch' && admin && !override && (
            <button onClick={() => setOverride(true)} className={styles.btn}>I understand, trust anyway…</button>
          )}
          {verdict?.state === 'mismatch' && admin && override && (
            <div className="w-full">
              <label className="block text-[12.5px]" style={{ color: 'var(--text-dim)' }}>
                Type <span className="font-mono">{PHRASE}</span> to pin the offered key. This is recorded in the audit log.
              </label>
              <div className="mt-1.5 flex gap-2">
                <input value={phrase} onChange={e => setPhrase(e.target.value)} autoFocus
                  className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1 font-mono text-[12.5px]"
                  style={{ borderColor: 'var(--border-strong)', color: 'var(--text)' }} />
                <button onClick={() => trust({ phrase })} disabled={busy || phrase.trim().toLowerCase() !== PHRASE}
                  className={`${styles.btn} ${styles.btnDanger}`}>
                  Trust anyway
                </button>
              </div>
            </div>
          )}

          {verdict?.state === 'unknown' && admin && (
            <button disabled={busy} className={styles.btn}
              onClick={() => { if (window.confirm(`Pin ${verdict.offered.fingerprint} for ${verdict.host}:${verdict.port}? HyperProx could not check it. This is recorded in the audit log.`)) trust({ confirmed: true }) }}>
              Trust the offered key…
            </button>
          )}
          {(verdict?.state === 'unknown' || verdict?.state === 'mismatch') && !admin && (
            <span className="text-[12.5px]" style={{ color: 'var(--text-dim)' }}>Only an admin can trust this key.</span>
          )}

          {(verdict || error) && <button onClick={check} disabled={busy} className={styles.btn}>Check again</button>}
          <button onClick={onClose} className={`${styles.btn} ml-auto`}>Close</button>
        </div>
      </div>
    </div>
  )
}
