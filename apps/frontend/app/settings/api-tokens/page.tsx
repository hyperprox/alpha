'use client'

// =============================================================================
//  Settings → API tokens
//  Bearer tokens for scripts and coding agents. A token is shown once, when it
//  is made; HyperProx keeps only its hash. Creating and revoking need the master
//  password again (the API enforces it). Tokens work only while HyperProx is
//  unlocked and can never reach secrets, terminals or anything that needs a
//  re-confirmation.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { apiJson, atLeast, type Role } from '@/lib/api'
import { useSession } from '@/lib/session'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { CopyButton, GhostButton, INPUT, LABEL, Modal, Notice, PrimaryButton } from '@/components/vault/ui'

interface TokenRow {
  id:         string
  name:       string
  role:       string
  createdBy:  string
  createdAt:  string
  lastUsedAt: string | null
  expiresAt:  string | null
  revokedAt:  string | null
  state:      'active' | 'expired' | 'revoked'
}

const TOKEN_ROLES: Role[] = ['viewer', 'operator', 'admin']
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function fmtDate(s: string | null) {
  if (!s) return '—'
  const d = new Date(s)
  return isNaN(d.getTime()) ? s : d.toLocaleString()
}

const STATE_COLOUR: Record<TokenRow['state'], string> = {
  active: 'var(--good)', expired: 'var(--warn)', revoked: 'var(--text-muted)',
}

function StateTag({ state }: { state: TokenRow['state'] }) {
  return (
    <span className="rounded border px-1.5 text-[10px] uppercase font-mono"
          style={{ borderColor: STATE_COLOUR[state], color: STATE_COLOUR[state], letterSpacing: '0.1em' }}>
      {state}
    </span>
  )
}

// ---------------------------------------------------------------------------

function CreateModal({ myRole, onCreated, onNeedConfirm, onClose }: {
  myRole: Role | undefined
  onCreated: (token: string, row: TokenRow) => void
  onNeedConfirm: (retry: () => void) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('admin')
  const [expires, setExpires] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const nameOk = NAME_RE.test(name.trim())
  const days = expires.trim() === '' ? undefined : Number(expires)
  const daysOk = days === undefined || (Number.isInteger(days) && days >= 1 && days <= 3650)

  async function create() {
    setBusy(true); setError('')
    const payload: Record<string, unknown> = { name: name.trim(), role }
    if (days !== undefined) payload.expiresDays = days
    const r = await apiJson<{ token: string; data: TokenRow }>('/api/auth/tokens', 'POST', payload)
    setBusy(false)
    if (r.ok && r.body?.token) { onCreated(r.body.token, r.body.data); return }
    if (r.status === 403 && r.code === 'reconfirm_required') { onNeedConfirm(create); return }
    setError(r.error ?? 'Could not create the token')
  }

  return (
    <Modal title="New API token" onClose={onClose}>
      <form onSubmit={e => { e.preventDefault(); create() }} className="space-y-4">
        <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
          For a script or an agent. It acts with the role you choose, only while HyperProx is unlocked.
        </p>
        <div><label htmlFor="t-name" style={LABEL}>Name</label>
          <input id="t-name" autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. ci-deploy"
                 style={{ ...INPUT, fontFamily: 'var(--font-mono)' }} />
          {name && !nameOk && <p className="mt-1 text-xs" style={{ color: 'var(--crit-soft)' }}>Letters, digits, dot, dash or underscore; up to 64.</p>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label htmlFor="t-role" style={LABEL}>Role</label>
            <select id="t-role" value={role} onChange={e => setRole(e.target.value as Role)} style={{ ...INPUT, cursor: 'pointer' }}>
              {TOKEN_ROLES.filter(r => atLeast(myRole, r)).map(r => <option key={r} value={r}>{r}</option>)}
            </select></div>
          <div><label htmlFor="t-exp" style={LABEL}>Expires after (days)</label>
            <input id="t-exp" type="number" min={1} max={3650} value={expires} onChange={e => setExpires(e.target.value)}
                   placeholder="never" style={INPUT} /></div>
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex gap-2 justify-end">
          <GhostButton type="button" onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton type="submit" disabled={busy || !nameOk || !daysOk}>{busy ? 'Creating...' : 'Create token'}</PrimaryButton>
        </div>
      </form>
    </Modal>
  )
}

function ShowOnceModal({ token, row, onClose }: { token: string; row: TokenRow; onClose: () => void }) {
  return (
    <Modal title={`Token "${row.name}"`} onClose={onClose}>
      <div className="space-y-3">
        <Notice kind="warn">Copy it now. You will not see this token again — HyperProx keeps only a hash of it.</Notice>
        <div className="flex items-center gap-2">
          <code className="flex-1 min-w-0 break-all rounded-md border px-3 py-2 text-sm select-all"
                style={{ fontFamily: 'var(--font-mono)', background: 'var(--ground-deep)', borderColor: 'var(--border-strong)', color: 'var(--text-bright)' }}>
            {token}
          </code>
          <CopyButton text={token} />
        </div>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Send it as <code style={{ fontFamily: 'var(--font-mono)' }}>Authorization: Bearer &lt;token&gt;</code>.
          Role {row.role}{row.expiresAt ? `, expires ${fmtDate(row.expiresAt)}` : ', no expiry'}.
        </p>
        <div className="flex justify-end"><PrimaryButton onClick={onClose}>Done</PrimaryButton></div>
      </div>
    </Modal>
  )
}

function RevokeModal({ row, onConfirm, onClose }: { row: TokenRow; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal title={`Revoke "${row.name}"?`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
          Anything using this token stops working at once. The name stays taken, so the audit log still reads.
        </p>
        <div className="flex gap-2 justify-end">
          <GhostButton type="button" onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton onClick={onConfirm} style={{ background: 'var(--crit)', color: 'var(--text-bright)' }}>Revoke</PrimaryButton>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------

export default function ApiTokensPage() {
  const { role } = useSession()
  const canUse = atLeast(role, 'admin')
  const [rows, setRows] = useState<TokenRow[] | null>(null)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<null | { token: string; row: TokenRow }>(null)
  const [revoking, setRevoking] = useState<TokenRow | null>(null)
  const [askConfirm, setAskConfirm] = useState<null | { then: () => void }>(null)
  const [toast, setToast] = useState('')
  const toastTimer = useRef<ReturnType<typeof setTimeout>>()

  const load = useCallback(async () => {
    const r = await apiJson<{ data: TokenRow[] }>('/api/auth/tokens')
    if (r.status === 403) { setError('Only owners and admins can manage API tokens.'); setRows([]); return }
    if (!r.ok) { setError(r.error ?? 'Could not load API tokens'); setRows([]); return }
    setError(''); setRows(Array.isArray(r.body?.data) ? r.body!.data : [])
  }, [])
  useEffect(() => { if (role === undefined || canUse) load() }, [load, role, canUse])
  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const flash = (m: string) => { setToast(m); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 4000) }

  async function revoke(row: TokenRow) {
    const r = await apiJson(`/api/auth/tokens/${encodeURIComponent(row.id)}`, 'DELETE')
    if (r.ok) { setRevoking(null); flash(`Revoked "${row.name}".`); load(); return }
    if (r.status === 403 && r.code === 'reconfirm_required') { setAskConfirm({ then: () => revoke(row) }); return }
    setRevoking(null); flash(r.error ?? 'Could not revoke')
  }

  return (
    <div className="min-h-full p-4 sm:p-8" style={{ background: 'var(--ground)' }}>
      <div className="mb-8">
        <Link href="/settings" className="font-mono uppercase" style={{ fontSize: 12, letterSpacing: '0.14em', color: 'var(--accent)' }}>← Settings</Link>
        <div className="flex flex-wrap items-end justify-between gap-3 mt-2">
          <h1 className="font-display font-bold" style={{ fontSize: 36, lineHeight: 1.1, color: 'var(--text-bright)' }}>API tokens</h1>
          {canUse && <PrimaryButton onClick={() => setCreating(true)}>New token</PrimaryButton>}
        </div>
        <p className="mt-2 text-sm max-w-3xl" style={{ color: 'var(--text-soft)' }}>
          For scripts and agents that call the HyperProx API. A token works only while HyperProx is unlocked, and never
          reaches secrets, terminals, or anything that needs your master password again. Creating or revoking one asks for it.
        </p>
      </div>

      <div className="max-w-5xl space-y-4">
        {toast && <Notice kind="info">{toast}</Notice>}
        {error && <Notice kind="error">{error}</Notice>}
        {rows === null ? (
          <div className="text-sm animate-pulse" style={{ color: 'var(--text-dimmer)' }}>Loading API tokens...</div>
        ) : rows.length === 0 && !error ? (
          <Notice kind="info">No API tokens yet.</Notice>
        ) : rows.length > 0 && (
          <div className="hp-table-scroll overflow-x-auto rounded-lg border" style={{ borderColor: 'var(--border-soft)', background: 'var(--surface)' }}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left" style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-dim)' }}>
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Role</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                  <th className="px-4 py-3 font-medium">Last used</th>
                  <th className="px-4 py-3 font-medium">Expires</th>
                  {canUse && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--border-dim)', opacity: r.state === 'active' ? 1 : 0.65 }}>
                    <td className="px-4 py-3 break-all" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-bright)' }}>
                      {r.name} <span className="ml-1"><StateTag state={r.state} /></span>
                      <div className="text-xs mt-0.5" style={{ fontFamily: 'inherit', color: 'var(--text-muted)' }}>by {r.createdBy}</div>
                    </td>
                    <td className="px-4 py-3" style={{ color: 'var(--text-soft)' }}>{r.role}</td>
                    <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--text-soft)' }}>{fmtDate(r.createdAt)}</td>
                    <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--text-soft)' }}>{fmtDate(r.lastUsedAt)}</td>
                    <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--text-soft)' }}>
                      {r.state === 'revoked' ? `revoked ${fmtDate(r.revokedAt)}` : r.expiresAt ? fmtDate(r.expiresAt) : 'never'}
                    </td>
                    {canUse && (
                      <td className="px-4 py-3 text-right">
                        {r.state !== 'revoked' && (
                          <button onClick={() => setRevoking(r)} className="rounded border px-3 text-xs font-medium"
                                  style={{ height: 30, borderColor: 'var(--border-strong)', color: 'var(--crit-soft)' }}>Revoke</button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {role && !canUse && <Notice kind="info">Only owners and admins can manage API tokens.</Notice>}
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          On the HyperProx machine, root can also run <code style={{ fontFamily: 'var(--font-mono)' }}>hyperprox token create|list|revoke</code>.
        </p>
      </div>

      {creating && (
        <CreateModal
          myRole={role}
          onClose={() => setCreating(false)}
          onNeedConfirm={retry => setAskConfirm({ then: retry })}
          onCreated={(token, row) => { setCreating(false); setCreated({ token, row }); load() }}
        />
      )}
      {created && <ShowOnceModal token={created.token} row={created.row} onClose={() => setCreated(null)} />}
      {revoking && <RevokeModal row={revoking} onClose={() => setRevoking(null)} onConfirm={() => revoke(revoking)} />}
      {askConfirm && (
        <ReconfirmModal
          onClose={() => setAskConfirm(null)}
          onDone={() => { const t = askConfirm.then; setAskConfirm(null); t() }}
        />
      )}
    </div>
  )
}
