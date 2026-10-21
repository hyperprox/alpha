'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import QRCode from 'qrcode'
import { apiJson, type AuthStatus } from '@/lib/api'
import { alpha } from '@/lib/theme'
import { BusyNote, GhostButton, INPUT, LABEL, Notice, PrimaryButton, passwordStrength } from '@/components/vault/ui'

/**
 * Where to go after signing in — a path on this origin, or `/`.
 *
 * `next` arrives in the query string, so it is whatever the caller put there. With a hard
 * navigation an absolute URL would be an open redirect: `/login?next=https://elsewhere.example`
 * would take a freshly-authenticated operator off-site on a page they trust. Anything that is not
 * a single-slash-rooted path is discarded rather than sanitised — `//host` is protocol-relative
 * and reads as a path only until a browser resolves it.
 */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/login')) return '/'
  return raw
}

const MIN_PASSWORD = 12

/** Maps a failed auth call to words a person can act on. */
function authError(r: { status: number; code?: string; error?: string }, fallback: string): string {
  switch (r.code) {
    case 'bad_credentials': return 'Wrong email or master password.'
    case 'totp_invalid':
    case 'totp_required':   return 'That 2FA code is wrong or expired. Enter the current 6-digit code.'
    case 'not_member':      return 'This vault account is not a member of the HyperProx organization.'
    case 'unauthenticated': return 'Your session has ended. Sign in again.'
    case 'locked_out':      return 'Too many failed attempts. Wait a few minutes and try again.'
  }
  if (r.status === 0) return 'Could not reach the API.'
  if (r.status === 502 || r.status === 503 || r.status === 504) return 'The vault is unreachable. HyperProx cannot sign anyone in until it is back.'
  if (r.status === 401) return 'Wrong email, master password or 2FA code.'
  if (r.status === 429) return 'Too many attempts. Wait a few minutes and try again.'
  return r.error ?? fallback
}

function Card({ eyebrow, subtitle, children, onSubmit }: {
  eyebrow: string; subtitle: string; children: React.ReactNode; onSubmit: (e: React.FormEvent) => void
}) {
  return (
    <form
      onSubmit={onSubmit}
      className="w-full max-w-sm space-y-5 rounded-lg border p-6 sm:p-8"
      style={{
        background: 'var(--surface)',
        borderColor: 'var(--border-soft)',
        boxShadow: '0 24px 60px color-mix(in srgb, var(--ground-deep) 80%, transparent)',
      }}
    >
      <div className="space-y-2 text-center">
        <div className="font-mono uppercase" style={{ fontSize: 11, letterSpacing: '0.14em', color: 'var(--warn-2)' }}>{eyebrow}</div>
        <h1 className="font-display" style={{ fontSize: 36, fontWeight: 700, letterSpacing: '0.12em', color: 'var(--text-bright)', lineHeight: 1.1 }}>
          HYPER<span style={{ color: 'var(--accent)' }}>PROX</span>
        </h1>
        <p className="font-display" style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-bright)' }}>{subtitle}</p>
        <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
          Your vault master password unlocks HyperProx. It is never stored.
        </p>
      </div>
      {children}
    </form>
  )
}

function Field({ id, label, ...rest }: { id: string; label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={id} style={LABEL}>{label}</label>
      <input id={id} {...rest} style={{ ...INPUT, ...(rest.inputMode === 'numeric' ? { fontFamily: 'var(--font-mono)', letterSpacing: '0.3em' } : {}) }}
             className="focus:border-[var(--accent)]" />
    </div>
  )
}

function StrengthBar({ password }: { password: string }) {
  const { score, label } = passwordStrength(password)
  const color = score <= 1 ? 'var(--crit)' : score === 2 ? 'var(--warn)' : 'var(--good)'
  return (
    <div className="mt-2" aria-live="polite">
      <div className="flex gap-1">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="h-1 flex-1 rounded-full" style={{ background: password && i <= score ? color : 'var(--border-strong)' }} />
        ))}
      </div>
      <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
        {password.length < MIN_PASSWORD
          ? `${MIN_PASSWORD - password.length} more character${MIN_PASSWORD - password.length === 1 ? '' : 's'} needed (minimum ${MIN_PASSWORD})`
          : label}
      </div>
    </div>
  )
}

function goNext(raw: string | null) {
  // A FULL document navigation, deliberately — not router.replace(). A soft navigation consults
  // Next's client Router Cache, which still holds the middleware bounce to /login from the visit
  // that sent the user here, so the page would appear not to move. A hard navigation re-runs
  // middleware with the new cookie and drops every payload from the signed-out session.
  window.location.assign(safeNext(raw))
}

function SignIn({ next, initialEmail = '', notice }: { next: string | null; initialEmail?: string; notice?: string }) {
  const [email, setEmail] = useState(initialEmail)
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    const r = await apiJson('/api/auth/sign-in', 'POST', { email: email.trim(), password, code: code.trim() })
    if (!r.ok) { setError(authError(r, 'Sign-in failed')); setBusy(false); return }
    goNext(next)
  }

  return (
    <Card eyebrow="Secure sign-in" subtitle="Sign in" onSubmit={submit}>
      {notice && <Notice kind="info">{notice}</Notice>}
      <Field id="email" label="Email" type="email" autoFocus={!initialEmail} autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} />
      <Field id="password" label="Master password" type="password" autoFocus={!!initialEmail} autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
      <Field id="code" label="2FA code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456"
             value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} />
      {error && <Notice kind="error">{error}</Notice>}
      <PrimaryButton type="submit" className="w-full" disabled={busy || !email || !password || code.length !== 6}>
        {busy ? 'Signing in...' : 'Sign in'}
      </PrimaryButton>
      {busy && <BusyNote>Signing in to the vault — this takes about 20 seconds.</BusyNote>}
    </Card>
  )
}

function Bootstrap({ next, onSignInRequired }: { next: string | null; onSignInRequired: (email: string) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [uri, setUri] = useState<string | null>(null)
  const [qr, setQr] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const mismatch = again.length > 0 && again !== password
  const valid = email.includes('@') && password.length >= MIN_PASSWORD && password === again

  useEffect(() => {
    if (!uri) return
    QRCode.toDataURL(uri, { margin: 1, width: 224, errorCorrectionLevel: 'M', color: { dark: '#0a111c', light: '#ffffff' } })
      .then(setQr).catch(() => setQr(''))
  }, [uri])

  // The manual-entry secret is already inside the otpauth URI.
  const secret = uri ? (() => { try { return new URL(uri).searchParams.get('secret') ?? '' } catch { return '' } })() : ''

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    const r = await apiJson<{ otpauthUri: string }>('/api/auth/bootstrap', 'POST', { email: email.trim(), password })
    if (!r.ok || !r.body?.otpauthUri) { setError(authError(r, 'Could not create the owner account')); setBusy(false); return }
    setUri(r.body.otpauthUri); setBusy(false)
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    const r = await apiJson('/api/auth/bootstrap/confirm', 'POST', { email: email.trim(), password, code: code.trim() })
    // HyperProx restarted between the two steps and the account already exists: go to the sign-in form.
    if (!r.ok && r.code === 'sign_in') { onSignInRequired(email.trim()); return }
    if (!r.ok && r.code === 'restart_setup') { setUri(null); setCode(''); setError('Setup was interrupted. Start again.'); setBusy(false); return }
    if (!r.ok) { setError(authError(r, 'Could not confirm the code')); setBusy(false); return }
    // Rarely the account is created but no session cookie comes back: sign in with the next code.
    if (r.body?.signInRequired) { onSignInRequired(email.trim()); return }
    goNext(next)
  }

  if (!uri) {
    return (
      <Card eyebrow="First-time setup" subtitle="Create the owner account" onSubmit={create}>
        <Field id="email" label="Email" type="email" autoFocus autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} />
        <div>
          <Field id="password" label="Master password" type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} />
          <StrengthBar password={password} />
        </div>
        <Field id="again" label="Master password again" type="password" autoComplete="new-password" value={again} onChange={e => setAgain(e.target.value)} />
        {mismatch && <Notice kind="error">The two passwords do not match.</Notice>}
        <Notice kind="warn">There is no password reset for this account. If you lose the master password you lose the vault.</Notice>
        {error && <Notice kind="error">{error}</Notice>}
        <PrimaryButton type="submit" className="w-full" disabled={busy || !valid}>
          {busy ? 'Creating...' : 'Create owner account'}
        </PrimaryButton>
        {busy && <BusyNote>Creating the account in the vault — this can take several seconds.</BusyNote>}
      </Card>
    )
  }

  return (
    <Card eyebrow="Step 2 of 2" subtitle="Set up 2FA" onSubmit={confirm}>
      <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
        Scan this code with an authenticator app, then enter the 6-digit code it shows. 2FA is required for the owner.
      </p>
      <div className="flex justify-center">
        {qr
          ? /* eslint-disable-next-line @next/next/no-img-element */
            <img src={qr} alt="2FA QR code" width={224} height={224} className="rounded-md" style={{ background: '#ffffff', border: `1px solid ${alpha('var(--accent)', 30)}` }} />
          : <div className="text-sm animate-pulse" style={{ color: 'var(--text-dimmer)' }}>Rendering code...</div>}
      </div>
      {secret && (
        <div>
          <div style={LABEL}>Can&apos;t scan? Enter this key manually</div>
          <code className="block break-all rounded-md border px-3 py-2 text-sm select-all"
                style={{ fontFamily: 'var(--font-mono)', background: 'var(--ground-deep)', borderColor: 'var(--border-strong)', color: 'var(--text-bright)' }}>
            {secret}
          </code>
        </div>
      )}
      <Notice kind="warn">Save this key. HyperProx has no recovery yet: if you lose your master password and 2FA, the only way back is reinstalling.</Notice>
      <Field id="code" label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" autoFocus
             value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} />
      {error && <Notice kind="error">{error}</Notice>}
      <div className="flex gap-2">
        <GhostButton type="button" disabled={busy} onClick={() => { setUri(null); setQr(''); setCode(''); setError('') }}>Back</GhostButton>
        <PrimaryButton type="submit" className="flex-1" disabled={busy || code.length !== 6}>
          {busy ? 'Verifying...' : 'Confirm and continue'}
        </PrimaryButton>
      </div>
      {busy && <BusyNote>Verifying with the vault — this can take several seconds.</BusyNote>}
    </Card>
  )
}

function LoginForm() {
  const params = useSearchParams()
  const next = params.get('next')
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [failed, setFailed] = useState(false)
  const [prefill, setPrefill] = useState<string | null>(null)

  useEffect(() => {
    apiJson<AuthStatus>('/api/auth/status').then(r => {
      if (r.body && 'bootstrapped' in r.body) {
        // Already unlocked with a live session of ours: nothing to do here.
        if (!r.body.locked && r.body.user) { goNext(next); return }
        setStatus(r.body)
      } else setFailed(true)
    })
  }, [next])

  return (
    <div className="w-full max-w-sm space-y-4">
      {params.get('locked') && (
        <Notice kind="warn">HyperProx is locked. Sign in with your vault account to unlock it.</Notice>
      )}
      {status && !status.reachable && (
        <Notice kind="error">The vault is unreachable. Sign-in will fail until it is running again.</Notice>
      )}
      {failed && <Notice kind="error">Could not reach the API.</Notice>}
      {status && (status.bootstrapped || prefill !== null
        ? <SignIn next={next} initialEmail={prefill ?? ''} notice={prefill !== null ? 'Your owner account is created. Sign in with your next 2FA code to finish.' : undefined} />
        : <Bootstrap next={next} onSignInRequired={setPrefill} />)}
      {!status && !failed && <div className="text-center text-sm animate-pulse" style={{ color: 'var(--text-dimmer)' }}>Checking the vault...</div>}
    </div>
  )
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--ground)] px-4 py-8">
      {/* useSearchParams() forces client rendering; without this boundary the
          production build fails to prerender this route. */}
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
  )
}
