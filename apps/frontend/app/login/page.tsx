'use client'

import { Suspense, useState } from 'react'
import { useSearchParams } from 'next/navigation'

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
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/'
  return raw
}

function LoginForm() {
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

      /**
       * A FULL document navigation, deliberately — not `router.replace()`.
       *
       * The old pair was `router.replace(dest)` followed by `router.refresh()`, and it failed on
       * the first submit every time: enter the password, nothing happens, reload, enter it again,
       * in you go.
       *
       * `router.replace` is a SOFT navigation. It consults Next's client-side Router Cache rather
       * than re-running middleware — and the entry cached for `/` is the middleware bounce to
       * `/login?next=/` from the visit that sent the user here in the first place. So the cookie
       * was set correctly, the navigation replayed the cached redirect back to the page already on
       * screen, and nothing appeared to happen. `router.refresh()` did clear the cache, one line
       * too late to affect the navigation that had just read it. The reload then emptied the cache
       * by hand, which is the only reason the second attempt worked.
       *
       * Swapping the two lines would also work, but a hard navigation is the honest thing at a
       * session boundary: it re-runs middleware server-side with the new cookie, and drops every
       * RSC payload and cached fetch belonging to the logged-out session instead of trusting an
       * invalidation to reach all of them.
       */
      window.location.assign(safeNext(params.get('next')))
    } catch {
      setError('Could not reach the API')
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="w-full max-w-sm space-y-6 rounded-lg border p-8"
      style={{
        background: 'var(--surface)',
        borderColor: 'var(--border-soft)',
        boxShadow: '0 24px 60px color-mix(in srgb, var(--ground-deep) 80%, transparent)',
      }}
    >
      <div className="space-y-2 text-center">
        <div
          className="font-mono uppercase"
          style={{ fontSize: 11, letterSpacing: '0.14em', color: 'var(--warn-2)' }}
        >
          Secure sign-in
        </div>
        <h1
          className="font-display"
          style={{ fontSize: 36, fontWeight: 700, letterSpacing: '0.12em', color: 'var(--text-bright)', lineHeight: 1.1 }}
        >
          HYPER<span style={{ color: 'var(--accent)' }}>PROX</span>
        </h1>
        <p className="text-sm" style={{ color: 'var(--text-soft)' }}>Sign in to continue</p>
      </div>

      <div className="space-y-2">
        <label htmlFor="password" className="block text-sm" style={{ color: 'var(--text-soft)' }}>Admin password</label>
        <input
          id="password"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          className="w-full rounded-md border px-3 font-mono text-sm outline-none focus:border-[var(--accent)]"
          style={{ height: 42, background: 'var(--ground-deep)', borderColor: 'var(--border-strong)', color: 'var(--text-bright)' }}
        />
      </div>

      {error && (
        <p
          className="rounded-md border px-3 py-2 text-sm"
          style={{
            background: 'color-mix(in srgb, var(--crit) 10%, transparent)',
            borderColor: 'color-mix(in srgb, var(--crit) 35%, transparent)',
            color: 'var(--crit-soft)',
          }}
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || !password}
        className="w-full rounded-md disabled:opacity-40"
        style={{ height: 42, background: 'var(--accent)', color: 'var(--accent-ink)', fontWeight: 600, border: 'none' }}
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
