'use client'

// =============================================================================
//  Settings → API tokens
//  Bearer tokens for scripts and coding agents. A token is shown once, when it
//  is made; HyperProx keeps only its hash. Creating and revoking need the master
//  password again (the API enforces it). Tokens work only while HyperProx is
//  unlocked and can never reach secrets, terminals or anything that needs a
//  re-confirmation, except that an owner may let one admin token save plug-in
//  settings without it (re-confirmed; the API enforces owner-only).
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { apiJson, atLeast, type Role } from '@/lib/api'
import { useSession } from '@/lib/session'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { CopyButton, GhostButton, INPUT, LABEL, Modal, Notice, PrimaryButton } from '@/components/vault/ui'
import { Details, HudHeader, Page, Panel, Pill, styles as ks, type PillTone, type StatChip } from '@/components/visual/kit'
import ss from '../settings.module.css'
import { exact, inWords } from '../when'

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
  /** Owner-granted: may save plug-in settings without the master password. */
  pluginSettingsWithoutReconfirm?: boolean
  pluginSettingsGrantedBy?: string | null
}

const PLUGIN_BADGE = 'Can save plug-in settings without your master password'

const TOKEN_ROLES: Role[] = ['viewer', 'operator', 'admin']
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function fmtDate(s: string | null) {
  if (!s) return '—'
  const d = new Date(s)
  return isNaN(d.getTime()) ? s : d.toLocaleString()
}

// The state is the pill's word; the tone only repeats it.
const STATE_TONE: Record<TokenRow['state'], PillTone | undefined> = { active: 'good', expired: 'warn', revoked: undefined }

function StateTag({ state }: { state: TokenRow['state'] }) {
  return <Pill tone={STATE_TONE[state]}>{state}</Pill>
}

/** Last used, in words: what a tile says at a glance. */
function lastUsedWords(r: TokenRow) {
  return r.lastUsedAt ? `last used ${inWords(r.lastUsedAt) ?? fmtDate(r.lastUsedAt)}` : 'never used'
}

function expiryWords(r: TokenRow) {
  if (r.state === 'revoked') return `revoked ${inWords(r.revokedAt) ?? fmtDate(r.revokedAt)}`
  if (!r.expiresAt) return 'never expires'
  const w = inWords(r.expiresAt) ?? fmtDate(r.expiresAt)
  return r.state === 'expired' ? `expired ${w}` : `expires ${w}`
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
          <code className={`${ss.code} select-all`}>
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

function PluginSettingsModal({ row, onConfirm, onClose }: { row: TokenRow; onConfirm: () => void; onClose: () => void }) {
  const on = !row.pluginSettingsWithoutReconfirm
  return (
    <Modal title={on ? `Let "${row.name}" save plug-in settings?` : `Stop "${row.name}" saving plug-in settings?`} onClose={onClose}>
      <div className="space-y-4">
        {on ? (
          <>
            <Notice kind="warn">
              Anyone holding this token can change plug-in connections and their credentials (addresses, API keys,
              passwords), without your master password.
            </Notice>
            <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
              Only plug-in settings. It still cannot read a saved secret back, reach Secrets or Send, manage users,
              roles or tokens, change cluster logins, or delete anything. Each save is written with your signed-in
              session and recorded in the audit log under this token&apos;s name. You can turn it off at any time.
            </p>
          </>
        ) : (
          <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
            From the next request, this token needs a person&apos;s master password again to save plug-in settings, so it cannot.
          </p>
        )}
        <div className="flex gap-2 justify-end">
          <GhostButton type="button" onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton onClick={onConfirm}>{on ? 'Allow' : 'Turn off'}</PrimaryButton>
        </div>
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
          <PrimaryButton onClick={onConfirm} style={{ background: 'var(--crit)', color: 'var(--accent-ink)' }}>Revoke</PrimaryButton>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------

export default function ApiTokensPage() {
  const { role } = useSession()
  const canUse = atLeast(role, 'admin')
  const isOwner = role === 'owner'
  const [scoping, setScoping] = useState<TokenRow | null>(null)
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

  async function setPluginSettings(row: TokenRow, enabled: boolean) {
    const r = await apiJson<{ data: TokenRow }>(`/api/auth/tokens/${encodeURIComponent(row.id)}/plugin-settings`, 'PUT', { enabled })
    if (r.ok) { setScoping(null); flash(enabled ? `"${row.name}" can now save plug-in settings.` : `"${row.name}" can no longer save plug-in settings.`); load(); return }
    if (r.status === 403 && r.code === 'reconfirm_required') { setAskConfirm({ then: () => setPluginSettings(row, enabled) }); return }
    setScoping(null); flash(r.error ?? 'Could not change the token')
  }

  const counts = { active: 0, expired: 0, revoked: 0 }
  for (const r of rows ?? []) counts[r.state] = (counts[r.state] ?? 0) + 1
  const lastUse = (rows ?? []).map(r => r.lastUsedAt).filter((x): x is string => !!x)
    .sort((x, y) => new Date(y).getTime() - new Date(x).getTime())[0] ?? null
  const chips: StatChip[] = [
    { label: 'active', value: rows ? counts.active : '…', tone: counts.active ? 'good' : undefined },
    { label: 'expired', value: rows ? counts.expired : '…', tone: counts.expired ? 'warn' : undefined },
    { label: 'revoked', value: rows ? counts.revoked : '…' },
    { label: 'last use, any token', value: rows ? (inWords(lastUse) ?? 'never') : '…' },
  ]

  return (
    <Page>
      <HudHeader level={2} label="API tokens overview" icon="plug" eyebrow={<><Link href="/settings" style={{ color: 'inherit' }}>&larr; Settings</Link> · API tokens</>}
        title={rows === null ? 'Loading API tokens...' : `${counts.active} active token${counts.active === 1 ? '' : 's'}`}
        chips={chips}
        actions={canUse && <PrimaryButton onClick={() => setCreating(true)}>New token</PrimaryButton>}>
        <p className="text-sm max-w-3xl" style={{ margin: 0, color: 'var(--text-soft)' }}>
          For scripts and agents that call the HyperProx API. A token works only while HyperProx is unlocked, and never
          reaches secrets, terminals, or anything that needs your master password again. Creating or revoking one asks for it.
          The one exception is opt-in: an owner can let an admin token save plug-in settings without it.
        </p>
      </HudHeader>

      {toast && <Notice kind="info">{toast}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}

      <Panel title="Tokens" sub={rows ? `${rows.length} made` : undefined}>
        {rows === null ? (
          <p className={`${ks.empty} animate-pulse`}>Loading API tokens...</p>
        ) : rows.length === 0 && !error ? (
          <Notice kind="info">No API tokens yet.</Notice>
        ) : rows.length > 0 ? (
          <ul className={ss.items} aria-label="API tokens">
            {rows.map(r => (
              <li key={r.id} className={ss.item} data-dim={r.state !== 'active' ? 'true' : undefined}>
                <div className={ss.itemHead}>
                  <span className={ss.itemName}>{r.name}</span>
                  <span className={ss.pills}><StateTag state={r.state} /><Pill tone="violet">{r.role}</Pill></span>
                </div>
                {r.pluginSettingsWithoutReconfirm && (
                  <p className={ss.said}><Pill tone="warn">{PLUGIN_BADGE}</Pill>
                    {r.pluginSettingsGrantedBy && <span style={{ color: 'var(--text-muted)' }}> allowed by {r.pluginSettingsGrantedBy === 'host-cli' ? 'root on the server' : r.pluginSettingsGrantedBy}</span>}
                  </p>
                )}
                <p className={ss.said}>
                  <span title={exact(r.lastUsedAt) ?? 'Not used yet'}>{lastUsedWords(r)}</span>
                  {' · '}
                  <span title={r.state === 'revoked' ? exact(r.revokedAt) : exact(r.expiresAt) ?? 'No expiry'}>{expiryWords(r)}</span>
                </p>
                <p className={ss.meta} title={exact(r.createdAt)}>by {r.createdBy} · made {inWords(r.createdAt) ?? fmtDate(r.createdAt)}</p>
                {canUse && r.state !== 'revoked' && (
                  <div className={ss.acts}>
                    {isOwner && (r.pluginSettingsWithoutReconfirm || (r.state === 'active' && r.role === 'admin')) && (
                      <button type="button" onClick={() => setScoping(r)} className={ss.mini}
                              aria-label={`${r.pluginSettingsWithoutReconfirm ? 'Stop' : 'Allow'} ${r.name} saving plug-in settings without your master password`}>
                        {r.pluginSettingsWithoutReconfirm ? 'Stop plug-in settings' : 'Allow plug-in settings'}
                      </button>
                    )}
                    <button type="button" onClick={() => setRevoking(r)} className={ss.mini} data-tone="bad"
                            aria-label={`Revoke ${r.name}`}>Revoke</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {role && !canUse && <div style={{ marginTop: 12 }}><Notice kind="info">Only owners and admins can manage API tokens.</Notice></div>}
        <p className="text-xs" style={{ margin: '12px 0 0', color: 'var(--text-muted)' }}>
          On the HyperProx machine, root can also run <code style={{ fontFamily: 'var(--font-mono)' }}>hyperprox token create|list|revoke</code>.
        </p>
      </Panel>

      {rows && rows.length > 0 && (
        <Details summary="Details" sub="every token, exact times">
          <div className={ks.tableWrap}>
            <table className={ks.table}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th>Expires</th>
                  {canUse && <th><span className={ks.srOnly}>Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} style={{ opacity: r.state === 'active' ? 1 : 0.65 }}>
                    <td className="break-all" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-bright)' }}>
                      {r.name} <span className="ml-1"><StateTag state={r.state} /></span>
                      {r.pluginSettingsWithoutReconfirm && <span className="ml-1"><Pill tone="warn">{PLUGIN_BADGE}</Pill></span>}
                      <div className="text-xs mt-0.5" style={{ fontFamily: 'var(--font-body)', color: 'var(--text-muted)' }}>by {r.createdBy}</div>
                    </td>
                    <td style={{ color: 'var(--text-soft)' }}>{r.role}</td>
                    <td className="whitespace-nowrap" style={{ color: 'var(--text-soft)' }}>{fmtDate(r.createdAt)}</td>
                    <td className="whitespace-nowrap" style={{ color: 'var(--text-soft)' }}>{fmtDate(r.lastUsedAt)}</td>
                    <td className="whitespace-nowrap" style={{ color: 'var(--text-soft)' }}>
                      {r.state === 'revoked' ? `revoked ${fmtDate(r.revokedAt)}` : r.expiresAt ? fmtDate(r.expiresAt) : 'never'}
                    </td>
                    {canUse && (
                      <td className="text-right">
                        {r.state !== 'revoked' && (
                          <button type="button" onClick={() => setRevoking(r)} className={ss.mini} data-tone="bad">Revoke</button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Details>
      )}

      {creating && (
        <CreateModal
          myRole={role}
          onClose={() => setCreating(false)}
          onNeedConfirm={retry => setAskConfirm({ then: retry })}
          onCreated={(token, row) => { setCreating(false); setCreated({ token, row }); load() }}
        />
      )}
      {created && <ShowOnceModal token={created.token} row={created.row} onClose={() => setCreated(null)} />}
      {scoping && <PluginSettingsModal row={scoping} onClose={() => setScoping(null)}
        onConfirm={() => setPluginSettings(scoping, !scoping.pluginSettingsWithoutReconfirm)} />}
      {revoking && <RevokeModal row={revoking} onClose={() => setRevoking(null)} onConfirm={() => revoke(revoking)} />}
      {askConfirm && (
        <ReconfirmModal
          onClose={() => setAskConfirm(null)}
          onDone={() => { const t = askConfirm.then; setAskConfirm(null); t() }}
        />
      )}
    </Page>
  )
}
