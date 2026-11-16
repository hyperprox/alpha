'use client'

// =============================================================================
//  HyperProx — "Sign in with Plex", step 1 of the Plex install
//
//  The new server is claimed to the person's Plex account, and the Plex plug-in is connected to it, as part of the
//  install. For that the person signs in once, here, with the 4-character code at plex.tv/link (or a link that signs
//  in in a new tab). The page only ever asks HyperProx; no Plex token of any kind comes to the browser. The install
//  gets the sign-in's id, nothing else. Skipping it installs the server unclaimed, and the page says what that means.
//
//  Starting a sign-in saves nothing, but it asks for the master password again like the Plex page's own sign-in does.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { styles } from '@/components/visual/kit'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'

export interface ClaimFlow {
  id: string; state: 'waiting' | 'signed-in' | 'expired' | 'error' | 'saved'
  code: string; linkUrl: string; authUrl: string; expiresAt: number; user?: string; error?: string
}

const BASE = '/api/plugins/plex/signin'

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}

const box: React.CSSProperties = { border: '1px solid var(--border-strong)', borderRadius: 10, padding: 14, background: 'var(--ground-deep)' }
const muted: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 13.5, lineHeight: 1.5, margin: 0 }

/** What the sign-in looks like in each state. Pure, so it is rendered in tests without a server. */
export function PlexClaimView({ flow, error, busy, now, onStart, onCancel }: {
  flow: ClaimFlow | null; error: string | null; busy: boolean; now: number
  onStart: () => void; onCancel: () => void
}) {
  const minutes = flow ? Math.max(1, Math.round((flow.expiresAt - now) / 60_000)) : 0
  return (
    <div className="flex flex-col gap-3">
      {!flow && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={onStart} disabled={busy} className={`${styles.btn} ${styles.btnPri}`}>{busy ? 'Starting…' : 'Sign in with Plex'}</button>
          <span style={muted}>Claims the new server to your account for you. No token to find or paste.</span>
        </div>
      )}

      {flow?.state === 'waiting' && (
        <div style={box} aria-live="polite">
          <p style={muted}>Go to <a href={flow.linkUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>plex.tv/link</a> on any
            device signed in to Plex, and enter this code:</p>
          <div className="font-mono" aria-label={`Code ${flow.code.split('').join(' ')}`}
            style={{ fontSize: 44, letterSpacing: '0.3em', fontWeight: 700, color: 'var(--text-bright)', margin: '10px 0', textAlign: 'center' }}>
            {flow.code}
          </div>
          <p style={muted}>Waiting for Plex… this updates by itself. The code works for about {minutes} minute{minutes === 1 ? '' : 's'}.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {flow.authUrl && (
              <a href={flow.authUrl} target="_blank" rel="noreferrer noopener" className={styles.btn} style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>
                Or sign in to Plex in a new tab
              </a>
            )}
            <button type="button" onClick={onCancel} className={`${styles.btn} ${styles.btnGhost}`}>Cancel</button>
          </div>
        </div>
      )}

      {flow?.state === 'signed-in' && (
        <div style={{ ...box, borderColor: 'var(--good)' }} aria-live="polite">
          <p style={{ ...muted, color: 'var(--text-bright)' }}>Signed in as <b>{flow.user}</b>.</p>
          <p style={{ ...muted, marginTop: 6 }}>The install will claim the new server to this account and connect the Plex plug-in to it. Stay on this page until you start the install: the sign-in is kept for about 25 minutes, and only HyperProx holds it.</p>
          <div className="mt-3"><button type="button" onClick={onCancel} className={`${styles.btn} ${styles.btnGhost}`}>Use another account</button></div>
        </div>
      )}

      {(flow?.state === 'expired' || flow?.state === 'error') && (
        <div style={box} role="alert">
          <p style={{ ...muted, color: 'var(--warn)' }}>{flow.error}</p>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={onStart} disabled={busy} className={`${styles.btn} ${styles.btnPri}`}>Get a new code</button>
          </div>
        </div>
      )}

      {error && <div role="alert" style={{ ...box, borderColor: 'var(--warn)' }}><p style={{ ...muted, color: 'var(--warn)' }}>{error}</p></div>}

      {!flow && (
        <p style={{ ...muted, fontSize: 12.5 }}>Without signing in, the server is installed and left unclaimed on your network, and the Plex plug-in is not connected until you sign in on its page.</p>
      )}
    </div>
  )
}

/** The sign-in, wired to HyperProx. `onFlow` gets the id of a signed-in sign-in, or '' when there is none. */
export function PlexClaim({ onFlow }: { onFlow: (id: string) => void }) {
  const [flow, setFlow] = useState<ClaimFlow | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const [now, setNow] = useState(() => Date.now())
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const start = useCallback(async () => {
    setBusy(true); setError(null)
    try {
      const r = await call('POST', BASE, { claim: true })
      if (r.json?.code === 'reconfirm_required') { setReconfirm(() => () => void start()); return }
      if (!r.json?.success) { setError(r.json?.error ?? 'Could not start the Plex sign-in.'); return }
      setFlow(r.json.data); onFlow('')
    } catch { setError('Could not reach HyperProx.') } finally { setBusy(false) }
  }, [onFlow])

  useEffect(() => {
    if (!flow || flow.state !== 'waiting') return
    const t = setInterval(async () => {
      setNow(Date.now())
      const r = await call('GET', `${BASE}/${flow.id}`).catch(() => null)
      if (!alive.current || !r) return
      if (r.status === 404) { setFlow(null); setError('That Plex sign-in has ended. Sign in again.'); return }
      if (r.json?.success) { setFlow(r.json.data); if (r.json.data.state === 'signed-in') onFlow(r.json.data.id) }
    }, 2000)
    return () => clearInterval(t)
  }, [flow?.id, flow?.state, onFlow])

  const cancel = () => {
    if (flow) void call('DELETE', `${BASE}/${flow.id}`).catch(() => {})
    setFlow(null); setError(null); onFlow('')
  }

  return (
    <>
      <PlexClaimView flow={flow} error={error} busy={busy} now={now} onStart={() => void start()} onCancel={cancel} />
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const fn = reconfirm; setReconfirm(null); fn() }} />}
    </>
  )
}
