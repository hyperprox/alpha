'use client'

// Settings → Users: who can sign in to HyperProx (the vault organisation's members) and their roles.
// The vault sends no mail here, so an invitation is a one-time link to copy and send. The person joins on
// /join, then an admin confirms them after comparing the key fingerprint the join page showed them.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { BusyNote, CopyButton, GhostButton, INPUT, LABEL, Modal, Notice, PrimaryButton } from '@/components/vault/ui'
import { HudHeader, Page, Panel, Pill, styles as ks, type StatChip } from '@/components/visual/kit'
import ss from '../settings.module.css'
import { ROLE_WORDS, grantableBy, managesRole, memberState, sameFingerprint, type Grantable, type Member, type Role } from '@/lib/users-view'

interface Invitation { id: string; email: string; role: Grantable; by: string; expiresAt: string; joined: boolean }

/** Run a change; on "re-enter your master password" ask for it, then run it again. */
function useReconfirmed() {
  const [ask, setAsk] = useState<null | (() => void)>(null)
  const run = useCallback(async (fn: () => Promise<{ ok: boolean; status: number; code?: string; error?: string }>, then: (r: any) => void) => {
    const r = await fn()
    if (r.status === 403 && r.code === 'reconfirm_required') { setAsk(() => () => { void fn().then(then) }); return }
    then(r)
  }, [])
  const modal = ask && <ReconfirmModal onClose={() => setAsk(null)} onDone={() => { const f = ask; setAsk(null); f() }} />
  return { run, modal }
}

function InviteModal({ me, onClose, onDone }: { me: Role; onClose: () => void; onDone: () => void }) {
  const roles = grantableBy(me)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Grantable>(roles.includes('viewer') ? 'viewer' : roles[0])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [link, setLink] = useState<{ link: string; expiresAt: string } | null>(null)
  const { run, modal } = useReconfirmed()

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    void run(() => apiJson('/api/users/invite', 'POST', { email: email.trim(), role }), r => {
      setBusy(false)
      if (!r.ok) { setError(r.error ?? 'Could not invite'); return }
      setLink(r.body.data); onDone()
    })
  }

  return (
    <Modal title="Invite someone" onClose={onClose}>
      {modal}
      {link ? (
        <div className="space-y-3">
          <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
            Send this link to {email.trim()} yourself (a message, a chat). It works once, until {new Date(link.expiresAt).toLocaleString()}.
            They choose their own master password and set up two-step login. Then confirm them here.
          </p>
          <code className={`${ss.code} select-all`} style={{ overflowWrap: 'anywhere' }}>{link.link}</code>
          <div className="flex gap-2 justify-end"><CopyButton text={link.link} label="Copy link" /><GhostButton onClick={onClose}>Done</GhostButton></div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div><label htmlFor="u-email" style={LABEL}>Email</label>
            <input id="u-email" type="email" autoFocus value={email} onChange={e => setEmail(e.target.value)} style={INPUT} /></div>
          <div><label htmlFor="u-role" style={LABEL}>Role</label>
            <select id="u-role" value={role} onChange={e => setRole(e.target.value as Grantable)} style={{ ...INPUT, cursor: 'pointer' }}>
              {roles.map(r => <option key={r} value={r}>{ROLE_WORDS[r]}</option>)}
            </select></div>
          <p className="text-xs" style={{ margin: 0, color: 'var(--text-muted)' }}>No email is sent: HyperProx gives you a one-time link to pass on.</p>
          {me !== 'owner' && <p className="text-xs" style={{ margin: 0, color: 'var(--text-muted)' }}>Only the owner can invite an operator or admin.</p>}
          {error && <Notice kind="error">{error}</Notice>}
          <div className="flex gap-2 justify-end">
            <GhostButton type="button" onClick={onClose}>Cancel</GhostButton>
            <PrimaryButton type="submit" disabled={busy || !email.includes('@')}>{busy ? 'Inviting...' : 'Make the link'}</PrimaryButton>
          </div>
          {busy && <BusyNote>Adding the invitation to the vault.</BusyNote>}
        </form>
      )}
    </Modal>
  )
}

function ConfirmModal({ member, onClose, onDone }: { member: Member; onClose: () => void; onDone: (m: string) => void }) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { run, modal } = useReconfirmed()
  const match = sameFingerprint(typed, member.fingerprint)
  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!match) return
    setBusy(true); setError('')
    void run(() => apiJson(`/api/users/${member.id}/confirm`, 'POST', { fingerprint: member.fingerprint }), r => {
      setBusy(false)
      if (!r.ok) { setError(r.error ?? 'Could not confirm'); return }
      onDone(`${member.email} can now sign in.`)
    })
  }
  return (
    <Modal title={`Confirm ${member.email}`} onClose={onClose}>
      {modal}
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
          Ask {member.email} for the key fingerprint their join page showed, and type it here. It must match the one the vault has:
          that is how you know the account is theirs. Confirming gives them access with their role.
        </p>
        <code className={ss.code}>{member.fingerprint}</code>
        <div><label htmlFor="c-fp" style={LABEL}>The fingerprint they read to you</label>
          <input id="c-fp" autoFocus autoComplete="off" value={typed} onChange={e => setTyped(e.target.value)} style={{ ...INPUT, fontFamily: 'var(--font-mono)' }} /></div>
        {typed && !match && <Notice kind="warn">Not the same yet. Do not confirm an account whose fingerprint does not match.</Notice>}
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex gap-2 justify-end">
          <GhostButton type="button" onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton type="submit" disabled={busy || !match}>{busy ? 'Confirming...' : 'Confirm'}</PrimaryButton>
        </div>
      </form>
    </Modal>
  )
}

export default function UsersPage() {
  const session = useSession()
  const role = session.role as Role | undefined
  const myEmail = session.email
  const canUse = atLeast(role, 'admin')
  const [members, setMembers] = useState<Member[] | null>(null)
  const [invites, setInvites] = useState<Invitation[]>([])
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [inviting, setInviting] = useState(false)
  const [confirmFor, setConfirmFor] = useState<Member | null>(null)
  const { run, modal } = useReconfirmed()

  const load = useCallback(async () => {
    const r = await apiJson<{ data: { members: Member[]; invitations: Invitation[] } }>('/api/users')
    if (r.status === 403) { setError('Only owners and admins can see who has access.'); setMembers([]); return }
    if (!r.ok || !r.body) { setError(r.error ?? 'Could not read the vault members'); setMembers([]); return }
    setError(''); setMembers(r.body.data.members); setInvites(r.body.data.invitations)
  }, [])
  useEffect(() => { if (canUse) void load() }, [canUse, load])

  const changeRole = (m: Member, next: Grantable) => run(() => apiJson(`/api/users/${m.id}/role`, 'PUT', { role: next }), r => {
    if (!r.ok) setError(r.error ?? 'Could not change the role'); else { setToast(`${m.email} is now ${next}.`); void load() }
  })
  const withdraw = (i: Invitation) => run(() => apiJson(`/api/users/invitations/${i.id}`, 'DELETE'), r => {
    if (!r.ok) setError(r.error ?? 'Could not withdraw it'); else { setToast(`The link for ${i.email} no longer works.`); void load() }
  })

  const waiting = (members ?? []).filter(m => m.status === 'accepted').length
  const chips: StatChip[] = [
    { label: 'people', value: members ? members.length : '…', tone: 'accent' },
    { label: 'waiting to be confirmed', value: members ? waiting : '…', tone: waiting ? 'warn' : undefined },
    { label: 'open invitations', value: invites.length },
  ]

  if (role && !canUse) {
    return <Page><Panel title="Users"><p className={ks.empty} style={{ margin: 0 }}>Only owners and admins can manage who has access.</p></Panel></Page>
  }

  return (
    <Page>
      {modal}
      <HudHeader level={2} label="Users overview" icon="lock"
        eyebrow={<><Link href="/settings" style={{ color: 'inherit' }}>&larr; Settings</Link> · Users</>}
        title={members === null ? 'Reading the vault...' : `${members.length} ${members.length === 1 ? 'person' : 'people'} can sign in`}
        chips={chips}
        actions={grantableBy(role).length > 0 && <PrimaryButton onClick={() => setInviting(true)}>Invite someone</PrimaryButton>}>
        <p className="text-sm" style={{ margin: 0, color: 'var(--text-soft)' }}>
          Everyone who signs in to HyperProx is a member of its vault. Invitations are links you pass on; nobody can sign in until you confirm them.
        </p>
      </HudHeader>

      {toast && <Notice kind="info">{toast}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}

      <Panel title="People" sub="the vault organisation's members">
        {members === null ? <p className={`${ks.empty} animate-pulse`}>Reading the vault...</p> : (
          <ul className={ss.items} aria-label="People">
            {members.map(m => {
              const st = memberState(m)
              const self = !!myEmail && m.email === myEmail
              return (
                <li key={m.id} className={ss.item}>
                  <div className={ss.itemHead}>
                    <span className={ss.itemName}>{m.email}</span>
                    <span className={ss.pills}><Pill tone={m.role === 'owner' ? 'violet' : undefined}>{m.role}</Pill><Pill tone={st.tone}>{st.words}</Pill></span>
                  </div>
                  <p className={ss.meta}>{ROLE_WORDS[m.role]}{m.twoFactor ? ' · two-step login on' : ''}</p>
                  <div className={ss.acts}>
                    {st.canConfirm && managesRole(role, m.role) && <button type="button" className={ss.mini} data-tone="accent" onClick={() => setConfirmFor(m)}>Confirm</button>}
                    {role === 'owner' && m.role !== 'owner' && !self && m.status !== 'revoked' && (
                      <select aria-label={`Role for ${m.email}`} value={m.role} onChange={e => changeRole(m, e.target.value as Grantable)} style={{ ...INPUT, width: 'auto', padding: '4px 8px', fontSize: 13 }}>
                        {(['admin', 'operator', 'viewer'] as Grantable[]).map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Panel>

      {invites.length > 0 && (
        <Panel title="Open invitations" sub="links that have not been used yet">
          <ul className={ss.items} aria-label="Invitations">
            {invites.map(i => (
              <li key={i.id} className={ss.item}>
                <div className={ss.itemHead}><span className={ss.itemName}>{i.email}</span><span className={ss.pills}><Pill>{i.role}</Pill>{i.joined && <Pill tone="warn">joining</Pill>}</span></div>
                <p className={ss.meta}>by {i.by}, works until {new Date(i.expiresAt).toLocaleString()}</p>
                {managesRole(role, i.role) && <div className={ss.acts}><button type="button" className={ss.mini} data-tone="bad" onClick={() => withdraw(i)}>Withdraw</button></div>}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {inviting && role && <InviteModal me={role} onClose={() => setInviting(false)} onDone={() => void load()} />}
      {confirmFor && <ConfirmModal member={confirmFor} onClose={() => setConfirmFor(null)} onDone={m => { setConfirmFor(null); setToast(m); void load() }} />}
    </Page>
  )
}
