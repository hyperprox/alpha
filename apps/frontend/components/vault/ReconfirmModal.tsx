'use client'

import { useState } from 'react'
import { apiJson } from '@/lib/api'
import { GhostButton, INPUT, Modal, Notice, PrimaryButton } from './ui'

/** Master-password re-confirmation (valid ~5 min server-side). Calls onDone with the expiry time (ms). */
export function ReconfirmModal({ onDone, onClose }: { onDone: (until: number) => void; onClose: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    const r = await apiJson<{ until: string | number }>('/api/auth/reconfirm', 'POST', { password })
    if (!r.ok) { setError(r.status === 401 || r.status === 403 ? 'Wrong master password.' : r.error ?? 'Could not confirm'); setBusy(false); return }
    const until = r.body?.until ? new Date(r.body.until).getTime() : Date.now() + 5 * 60_000
    onDone(isNaN(until) ? Date.now() + 5 * 60_000 : until)
  }
  return (
    <Modal title="Confirm it's you" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm" style={{ color: 'var(--text-soft)' }}>Enter your master password to continue. It is checked, never stored.</p>
        <input type="password" autoFocus autoComplete="current-password" aria-label="Master password" value={password}
               onChange={e => setPassword(e.target.value)} style={INPUT} />
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex gap-2 justify-end">
          <GhostButton type="button" onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton type="submit" disabled={busy || !password}>{busy ? 'Checking...' : 'Confirm'}</PrimaryButton>
        </div>
      </form>
    </Modal>
  )
}
