'use client'

import { useState } from 'react'
import { apiJson, atLeast, type Role } from '@/lib/api'
import { useSession } from '@/lib/session'
import { alpha } from '@/lib/theme'

const ROLE_COLOR: Record<Role, string> = {
  owner:    'var(--accent)',
  admin:    'var(--violet)',
  operator: 'var(--warn)',
  viewer:   'var(--text-muted)',
}

export function RoleBadge({ role }: { role: Role }) {
  return (
    <span
      className="font-mono uppercase rounded"
      style={{
        fontSize: 10, letterSpacing: '0.1em', padding: '2px 6px',
        color: ROLE_COLOR[role], background: alpha(ROLE_COLOR[role], 12),
        border: `1px solid ${alpha(ROLE_COLOR[role], 30)}`,
      }}
    >
      {role}
    </span>
  )
}

/** Signed-in email, role, and (owner/admin) Lock now. Renders nothing until a session is known. */
export function SessionBadge({ compact = false }: { compact?: boolean }) {
  const { email, role } = useSession()
  const [busy, setBusy] = useState(false)
  if (!email || !role) return null

  async function lockNow() {
    setBusy(true)
    await apiJson('/api/auth/lock', 'POST')
    window.location.assign('/login?locked=1')
  }

  return (
    <div className={compact ? 'flex items-center gap-2 min-w-0' : 'space-y-2'}>
      <div className="flex items-center gap-2 min-w-0">
        <span className="truncate font-mono" style={{ fontSize: 12, color: 'var(--text-soft)' }} title={email}>{email}</span>
        <RoleBadge role={role} />
      </div>
      {atLeast(role, 'admin') && (
        <button
          onClick={lockNow}
          disabled={busy}
          className="rounded border px-2 font-medium disabled:opacity-50"
          style={{ height: 26, fontSize: 12, borderColor: 'var(--border-strong)', color: 'var(--text-soft)', background: 'transparent' }}
        >
          {busy ? 'Locking...' : 'Lock now'}
        </button>
      )}
    </div>
  )
}
