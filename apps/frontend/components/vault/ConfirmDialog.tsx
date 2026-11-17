'use client'

// The one confirmation dialog: what will happen, in a sentence, with Confirm and Cancel. Drawn above every other dialog
// (the action that asked may itself be in one). Escape, Cancel, the ✕ and a click outside all cancel; Tab stays inside.
// With `typeName`, Confirm stays off until that name is typed exactly (a destructive delete).

import { useState } from 'react'
import { GhostButton, INPUT, LABEL, Modal, PrimaryButton } from './ui'

export function ConfirmDialog({ title = 'Confirm', message, confirmLabel = 'Confirm', danger, typeName, busy, onConfirm, onCancel }: {
  title?: string
  /** What will happen, in plain English. */
  message: React.ReactNode
  confirmLabel?: string
  /** A destructive action: the Confirm button is drawn in the warning colour. */
  danger?: boolean
  /** Confirm only once this is typed exactly. */
  typeName?: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const [typed, setTyped] = useState('')
  const ready = !busy && (typeName === undefined || typed === typeName)
  return (
    <Modal title={title} onClose={onCancel} top
      footer={
        <div className="flex gap-2 justify-end w-full">
          <GhostButton type="button" onClick={onCancel} style={{ minWidth: 96 }}>Cancel</GhostButton>
          <PrimaryButton type="submit" form="hpx-confirm-form" disabled={!ready} autoFocus={typeName === undefined}
            style={{ minWidth: 112, ...(danger ? { background: 'var(--crit)', color: 'var(--text-bright)' } : {}) }}>
            {busy ? 'Working...' : confirmLabel}
          </PrimaryButton>
        </div>
      }>
      <form id="hpx-confirm-form" onSubmit={e => { e.preventDefault(); if (ready) onConfirm() }} className="space-y-4">
        <p className="text-sm" style={{ color: 'var(--text)', margin: 0, lineHeight: 1.5 }}>{message}</p>
        {typeName !== undefined && (
          <div>
            <label htmlFor="hpx-confirm-name" style={LABEL}>Type {typeName} to confirm</label>
            <input id="hpx-confirm-name" autoFocus autoComplete="off" spellCheck={false} value={typed}
              onChange={e => setTyped(e.target.value)} style={INPUT} />
          </div>
        )}
      </form>
    </Modal>
  )
}
