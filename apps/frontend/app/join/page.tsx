'use client'

// Joining HyperProx from an invitation link (/join#<token>). Public: the link is the credential, and it fixes
// the email. Two steps: a master password (the vault account is made with it, as the owner's was), then
// two-step login. The page then shows the key fingerprint to read to whoever invited you; they confirm you.

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { apiJson } from '@/lib/api'
import { BusyNote, INPUT, LABEL, Notice, PrimaryButton } from '@/components/vault/ui'
import { ThemeToggle } from '@/components/layout/ThemeToggle'
import { MIN_PASSWORD, joinToken } from '@/lib/users-view'
import s from '../login/login.module.css'

type Step = 'loading' | 'invalid' | 'password' | 'totp' | 'done'

function Field({ id, label, ...rest }: { id: string; label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={id} style={LABEL}>{label}</label>
      <input id={id} {...rest} style={{ ...INPUT, ...(rest.inputMode === 'numeric' ? { fontFamily: 'var(--font-mono)', letterSpacing: '0.3em' } : {}) }} />
    </div>
  )
}

export default function JoinPage() {
  const [token, setToken] = useState<string | null>(null)
  const [step, setStep] = useState<Step>('loading')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [uri, setUri] = useState('')
  const [qr, setQr] = useState('')
  const [fingerprint, setFingerprint] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const t = joinToken(window.location.hash)
    setToken(t)
    if (!t) { setStep('invalid'); return }
    void apiJson<{ data: { email: string; role: string; step: 'password' | 'totp' } }>('/api/auth/join/check', 'POST', { token: t }).then(r => {
      if (!r.ok || !r.body) { setStep('invalid'); setError(r.error ?? ''); return }
      setEmail(r.body.data.email); setRole(r.body.data.role)
      // Already registered (a reload, or HyperProx restarted): the password again starts two-step login again.
      setStep('password')
    })
  }, [])

  useEffect(() => {
    if (!uri) return
    QRCode.toDataURL(uri, { margin: 1, width: 224, errorCorrectionLevel: 'M', color: { dark: '#0a111c', light: '#ffffff' } }).then(setQr).catch(() => setQr(''))
  }, [uri])
  const secret = uri ? (() => { try { return new URL(uri).searchParams.get('secret') ?? '' } catch { return '' } })() : ''

  async function register(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    const r = await apiJson<{ data: { otpauthUri: string; fingerprint: string } }>('/api/auth/join/register', 'POST', { token, password })
    setBusy(false)
    if (!r.ok || !r.body) { setError(r.error ?? 'Could not make the account'); return }
    setUri(r.body.data.otpauthUri); setFingerprint(r.body.data.fingerprint); setStep('totp')
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    const r = await apiJson('/api/auth/join/totp', 'POST', { token, password, code: code.trim() })
    setBusy(false)
    if (!r.ok && r.code === 'restart_join') { setStep('password'); setUri(''); setCode(''); setError(r.error ?? 'Start again.'); return }
    if (!r.ok) { setError(r.error ?? 'Could not confirm the code'); return }
    setStep('done')
  }

  const valid = password.length >= MIN_PASSWORD && password === again
  return (
    <div className={s.stage}>
      <div className={s.theme}><ThemeToggle /></div>
      <form className={s.card} onSubmit={step === 'password' ? register : step === 'totp' ? confirm : e => e.preventDefault()} aria-label="Join HyperProx">
        <div className={s.head}>
          <div className={s.eyebrow}>{step === 'totp' ? 'Step 2 of 2' : step === 'password' ? 'Step 1 of 2' : 'Invitation'}</div>
          <h1 className={s.logo}>HYPER<span>PROX</span></h1>
          <p className={s.sub}>{step === 'done' ? 'Almost there' : 'Join'}</p>
          {email && <p className={s.lead}>{email}, as {role}</p>}
        </div>
        <div className={s.body}>
          {step === 'loading' && <p className={s.lead}>Reading the invitation...</p>}
          {step === 'invalid' && <Notice kind="error">{error || 'This invitation link is not valid. It may have expired or been used. Ask for a new one.'}</Notice>}
          {step === 'password' && (<>
            <p className={s.lead}>Choose a master password. It unlocks HyperProx and its vault, and is never stored. There is no reset: keep it safe.</p>
            <Field id="j-pw" label="Master password" type="password" autoFocus autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} />
            <Field id="j-again" label="Master password again" type="password" autoComplete="new-password" value={again} onChange={e => setAgain(e.target.value)} />
            {password && password.length < MIN_PASSWORD && <Notice kind="warn">At least {MIN_PASSWORD} characters.</Notice>}
            {again && again !== password && <Notice kind="error">The two passwords do not match.</Notice>}
            {error && <Notice kind="error">{error}</Notice>}
            <PrimaryButton type="submit" className="w-full" disabled={busy || !valid}>{busy ? 'Making the account...' : 'Continue'}</PrimaryButton>
            {busy && <BusyNote>Making the account in the vault — this takes a few seconds.</BusyNote>}
          </>)}
          {step === 'totp' && (<>
            <p className={s.lead}>Scan this with an authenticator app, then enter the 6-digit code it shows. Two-step login is required.</p>
            <div className="flex justify-center">
              {qr
                ? /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={qr} alt="Two-step login QR code" width={224} height={224} className="rounded-md" style={{ background: '#ffffff' }} />
                : <div className="text-sm animate-pulse">Rendering code...</div>}
            </div>
            {secret && <div><div style={LABEL}>Can&apos;t scan? Enter this key</div><code className="block break-all text-sm select-all" style={{ fontFamily: 'var(--font-mono)' }}>{secret}</code></div>}
            <Field id="j-code" label="Code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} />
            {error && <Notice kind="error">{error}</Notice>}
            <PrimaryButton type="submit" className="w-full" disabled={busy || code.length !== 6}>{busy ? 'Checking...' : 'Turn on two-step login'}</PrimaryButton>
          </>)}
          {step === 'done' && (<>
            <p className={s.lead}>Your account is ready. Read this key fingerprint to whoever invited you: they confirm it matches, and then you can sign in.</p>
            <code className="block text-center text-base select-all" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.05em' }}>{fingerprint}</code>
            <a href="/login" className="text-sm" style={{ color: 'var(--accent)', textAlign: 'center' }}>Go to sign-in</a>
          </>)}
        </div>
      </form>
    </div>
  )
}
