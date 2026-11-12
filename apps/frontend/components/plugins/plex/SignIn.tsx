'use client'

// =============================================================================
//  HyperProx — Sign in with Plex
//
//  Shows the 4-character code to type at plex.tv/link (or a link that signs in in a new tab), waits while the
//  API checks plex.tv, then lists the account's own servers to choose from. The API tests the chosen server and
//  saves its address and server token in the vault. No Plex token ever comes to this page.
//
//  Starting and saving both ask for the master password again (they save plug-in settings).
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { styles } from '@/components/visual/kit'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'

interface Connection { uri: string; protocol: 'http' | 'https'; address: string; port: number; local: boolean }
interface Server { id: string; name: string; version: string; connections: Connection[]; preferred: string | null; matchesKnown: boolean }
interface Flow {
  id: string; state: 'waiting' | 'signed-in' | 'expired' | 'error' | 'saved'
  code: string; linkUrl: string; authUrl: string; expiresAt: number
  user?: string; servers?: Server[]; suggested?: string | null; error?: string
}
interface Tried { uri: string; error: string }

const BASE = '/api/plugins/plex/signin'

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}

const where = (c: Connection) => c.protocol === 'https'
  ? `${c.local ? 'On your network' : 'Over the internet'} · secure`
  : c.local ? 'On your network · plain http' : 'Over the internet · plain http, the token is sent unencrypted'

export function PlexSignIn({ known, onDone, compact }: {
  /** An address discovery already found, to preselect the matching connection. */
  known?: string | null
  /** Called once the server is saved. */
  onDone: (r: { server: string; url: string; note?: string }) => void
  /** Smaller button, for an alert card. */
  compact?: boolean
}) {
  const [flow, setFlow] = useState<Flow | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tried, setTried] = useState<Tried[]>([])
  const [skipped, setSkipped] = useState<string[]>([])
  const [expired, setExpired] = useState(false)
  const [server, setServer] = useState<string>('')
  const [uri, setUri] = useState<string>('')
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const start = useCallback(async () => {
    setBusy(true); setError(null); setTried([]); setSkipped([]); setExpired(false)
    try {
      const r = await call('POST', BASE, { known: known ?? undefined })
      if (r.json?.code === 'reconfirm_required') { setReconfirm(() => () => void start()); return }
      if (!r.json?.success) { setError(r.json?.error ?? 'Could not start the Plex sign-in.'); return }
      setFlow(r.json.data)
    } catch { setError('Could not reach HyperProx.') } finally { setBusy(false) }
  }, [known])

  // Ask HyperProx (never plex.tv) every 2 seconds while the code is waiting.
  useEffect(() => {
    if (!flow || flow.state !== 'waiting') return
    const t = setInterval(async () => {
      const r = await call('GET', `${BASE}/${flow.id}`).catch(() => null)
      if (!alive.current || !r) return
      if (r.status === 404) {
        // The API drops a sign-in at its expiry: past that time, this is the code running out.
        const ranOut = Date.now() >= flow.expiresAt - 5000
        setFlow(null); setExpired(ranOut)
        setError(ranOut ? 'The code expired before it was used. Get a new code and try again.' : 'That Plex sign-in has ended. Start again.')
        return
      }
      if (r.json?.success) setFlow(r.json.data)
    }, 2000)
    return () => clearInterval(t)
  }, [flow?.id, flow?.state])

  // Preselect the suggested server and its preferred address.
  useEffect(() => {
    if (flow?.state !== 'signed-in' || !flow.servers?.length) return
    const s = flow.servers.find(x => x.id === flow.suggested) ?? flow.servers[0]
    setServer(s.id); setUri(s.preferred ?? s.connections[0]?.uri ?? '')
  }, [flow?.id, flow?.state])

  const chosen = flow?.servers?.find(s => s.id === server)

  const connect = useCallback(async () => {
    if (!flow || !server) return
    setBusy(true); setError(null); setTried([]); setSkipped([])
    try {
      const r = await call('POST', `${BASE}/${flow.id}/connect`, { server, uri })
      if (r.json?.code === 'reconfirm_required') { setReconfirm(() => () => void connect()); return }
      if (r.status === 404) { setFlow(null); setError('That Plex sign-in has ended. Get a new code and try again.'); setExpired(true); return }
      if (!r.json?.success) { setError(r.json?.error ?? 'Could not save the server.'); setTried(r.json?.tried ?? []); setSkipped(r.json?.skipped ?? []); return }
      setFlow(null)
      onDone({ server: r.json.data.server, url: r.json.data.url, note: r.json.data.note })
    } catch { setError('Could not reach HyperProx.') } finally { setBusy(false) }
  }, [flow, server, uri, onDone])

  const cancel = () => {
    if (flow) void call('DELETE', `${BASE}/${flow.id}`).catch(() => {})
    setFlow(null); setError(null); setTried([]); setSkipped([]); setExpired(false)
  }

  const box: React.CSSProperties = { border: '1px solid var(--border-strong)', borderRadius: 10, padding: 14, background: 'var(--ground-deep)' }
  const muted: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 13.5, lineHeight: 1.5, margin: 0 }

  return (
    <div className="flex flex-col gap-3">
      {!flow && !expired && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void start()} disabled={busy} className={`${styles.btn} ${styles.btnPri}`}>
            {busy ? 'Starting…' : 'Sign in with Plex'}
          </button>
          {!compact && <span style={muted}>No token to find or paste.</span>}
        </div>
      )}

      {flow?.state === 'waiting' && (
        <div style={box} aria-live="polite">
          <p style={muted}>Go to <a href={flow.linkUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>plex.tv/link</a> on
            any device signed in to Plex, and enter this code:</p>
          <div className="font-mono" aria-label={`Code ${flow.code.split('').join(' ')}`}
            style={{ fontSize: 44, letterSpacing: '0.3em', fontWeight: 700, color: 'var(--text-bright)', margin: '10px 0', textAlign: 'center' }}>
            {flow.code}
          </div>
          <p style={muted}>Waiting for Plex… this updates by itself. The code works for about {Math.max(1, Math.round((flow.expiresAt - Date.now()) / 60_000))} minutes.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {flow.authUrl && (
              <a href={flow.authUrl} target="_blank" rel="noreferrer noopener" className={styles.btn}
                style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>
                Or sign in to Plex in a new tab
              </a>
            )}
            <button type="button" onClick={cancel} className={`${styles.btn} ${styles.btnGhost}`}>Cancel</button>
          </div>
          {flow.authUrl && <p style={{ ...muted, marginTop: 8, fontSize: 12.5 }}>The new-tab sign-in works best on a computer.</p>}
        </div>
      )}

      {(flow?.state === 'expired' || flow?.state === 'error') && (
        <div style={box} role="alert">
          <p style={{ ...muted, color: 'var(--warn)' }}>{flow.error}</p>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={() => void start()} disabled={busy} className={`${styles.btn} ${styles.btnPri}`}>Get a new code</button>
            <button type="button" onClick={cancel} className={`${styles.btn} ${styles.btnGhost}`}>Cancel</button>
          </div>
        </div>
      )}

      {flow?.state === 'signed-in' && flow.servers && (
        <div style={box}>
          <p style={muted}>Signed in as <b style={{ color: 'var(--text-bright)' }}>{flow.user}</b>. Choose the server to read:</p>
          <div className="mt-3 flex flex-col gap-2" role="radiogroup" aria-label="Your Plex servers">
            {flow.servers.map(s => (
              <label key={s.id} className="flex items-start gap-3 rounded-md border p-3"
                style={{ cursor: 'pointer', borderColor: s.id === server ? 'var(--accent)' : 'var(--border)' }}>
                <input type="radio" name="plex-server" checked={s.id === server} style={{ marginTop: 4, accentColor: 'var(--accent)' }}
                  onChange={() => { setServer(s.id); setUri(s.preferred ?? s.connections[0]?.uri ?? '') }} />
                <span className="min-w-0">
                  <span style={{ color: 'var(--text-bright)', fontWeight: 600 }}>{s.name}</span>
                  <span style={{ color: 'var(--text-dimmer)', fontSize: 12.5 }}>{s.version ? ` · Plex ${s.version}` : ''}{s.matchesKnown ? ' · found on your cluster' : ''}</span>
                  <span className="block" style={{ color: 'var(--text-dimmer)', fontSize: 12.5 }}>
                    {s.connections.length} address{s.connections.length === 1 ? '' : 'es'}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {chosen && chosen.connections.length > 0 && (
            <label className="mt-3 block">
              <span style={{ ...muted, display: 'block', marginBottom: 6 }}>Reach it at</span>
              <select value={uri} onChange={e => setUri(e.target.value)} className={styles.input}>
                {chosen.connections.map(c => (
                  <option key={c.uri} value={c.uri}>{c.uri} — {where(c)}</option>
                ))}
              </select>
              <span style={{ ...muted, display: 'block', marginTop: 6, fontSize: 12.5 }}>
                If this address does not answer, HyperProx tries the server’s other addresses, except plain http over the internet.
              </span>
            </label>
          )}
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={() => void connect()} disabled={busy || !server} className={`${styles.btn} ${styles.btnPri}`}>
              {busy ? 'Testing…' : 'Use this server'}
            </button>
            <button type="button" onClick={cancel} className={`${styles.btn} ${styles.btnGhost}`}>Cancel</button>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" style={{ ...box, borderColor: 'var(--warn)' }}>
          <p style={{ ...muted, color: 'var(--warn)' }}>{error}</p>
          {tried.length > 0 && (
            <ul style={{ ...muted, marginTop: 8, paddingLeft: 18, listStyle: 'disc' }}>
              {tried.map(t => <li key={t.uri}><span className="font-mono" style={{ fontSize: 12 }}>{t.uri}</span>: {t.error}</li>)}
            </ul>
          )}
          {skipped.length > 0 && (
            <p style={{ ...muted, marginTop: 8 }}>
              Not tried, because they are plain http over the internet and would send the token unencrypted (choose one
              yourself to use it): <span className="font-mono" style={{ fontSize: 12 }}>{skipped.join(', ')}</span>
            </p>
          )}
          {expired && (
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => void start()} disabled={busy} className={`${styles.btn} ${styles.btnPri}`}>Get a new code</button>
            </div>
          )}
        </div>
      )}

      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const fn = reconfirm; setReconfirm(null); fn() }} />}
    </div>
  )
}
