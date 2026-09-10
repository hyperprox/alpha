'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState('')
  const [busy,     setBusy]     = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')

    try {
      const res = await fetch('/api/auth/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ password }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Login failed' }))
        setError(body.error ?? 'Login failed')
        setBusy(false)
        return
      }

      router.replace(params.get('next') || '/')
      router.refresh()
    } catch {
      setError('Could not reach the API')
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="w-full max-w-sm space-y-6 rounded-lg border border-white/10 bg-white/5 p-8"
    >
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-wide text-[var(--accent)]">HyperProx</h1>
        <p className="text-sm text-white/50">Sign in to continue</p>
      </div>

      <div className="space-y-2">
        <label htmlFor="password" className="text-sm text-white/70">Admin password</label>
        <input
          id="password"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          className="w-full rounded border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-white outline-none focus:border-[var(--accent)]"
        />
      </div>

      {error && (
        <p className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || !password}
        className="w-full rounded bg-[var(--accent)] px-4 py-2 font-medium text-[var(--ground)] disabled:opacity-40"
      >
        {busy ? 'Signing in...' : 'Sign in'}
      </button>
    </form>
  )
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--ground)] px-4">
      {/* useSearchParams() forces client rendering; without this boundary the
          production build fails to prerender this route. */}
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
  )
}
