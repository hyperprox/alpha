'use client'

// =============================================================================
//  HyperProx — Deck terminal pane
//
//  xterm.js over the /ws/deck/term socket. The session itself lives in tmux on
//  the target, so this component is only a window onto it: unmounting closes the
//  socket and leaves the work running.
// =============================================================================

import { useEffect, useRef, useState, useCallback } from 'react'
import '@xterm/xterm/css/xterm.css'

export type PaneState = 'idle' | 'connecting' | 'ready' | 'closed' | 'error'

export interface DeckTerminalProps {
  host:     string
  hostId:   string
  port:     number
  /** Bumping this remounts the session — used by Reconnect. */
  attempt:  number
  onState:  (s: PaneState, detail?: string) => void
  onAttach: (info: { persistent: boolean; session?: string; hostKeyLearned?: boolean; fingerprint?: string }) => void
}

// Terminal colours are the HyperProx palette, not xterm's defaults — a stock
// terminal theme inside this shell looks like a foreign object.
const THEME = {
  background:          '#080c14',
  foreground:          '#c7d2dd',
  cursor:              '#00e5ff',
  cursorAccent:        '#080c14',
  selectionBackground: 'rgba(0,229,255,0.24)',
  black:   '#0d1220', red:     '#ef4444', green:   '#22c55e', yellow:  '#f59e0b',
  blue:    '#3b82f6', magenta: '#a78bfa', cyan:    '#00e5ff', white:   '#c7d2dd',
  brightBlack:   '#4b5563', brightRed:     '#f87171', brightGreen:   '#4ade80',
  brightYellow:  '#fbbf24', brightBlue:    '#60a5fa', brightMagenta: '#c4b5fd',
  brightCyan:    '#67e8f9', brightWhite:   '#f1f5f9',
}

// The terminal socket must reach the API, not whichever origin served the page.
//
// Two access paths exist and they need different answers:
//   :3000  — the Next.js server directly. Its only rewrite is /api (see
//            next.config.js), so /ws is not proxied and the socket must go
//            straight to the API's own port. Cookies are not port-scoped, so
//            the session cookie set on this host is still sent.
//   :80/443 — a reverse proxy in front, which forwards /ws on the same origin
//            and gives us TLS for free.
//
// NEXT_PUBLIC_WS_URL is deliberately not consulted: the value shipped in .env
// points at the bundled nginx vhost, and that vhost is not the config the nginx
// container actually loads.
function wsBase(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'

  return window.location.port === '3000'
    ? `${proto}//${window.location.hostname}:3002/ws`
    : `${proto}//${window.location.host}/ws`
}

export function DeckTerminal({ host, hostId, port, attempt, onState, onAttach }: DeckTerminalProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [fatal, setFatal] = useState<string | null>(null)

  // Keep the callbacks out of the effect's dependency list — they are recreated
  // on every parent render, and a re-run here would tear down a live session.
  const onStateRef  = useRef(onState);  onStateRef.current  = onState
  const onAttachRef = useRef(onAttach); onAttachRef.current = onAttach

  useEffect(() => {
    if (!mountRef.current) return

    let disposed = false
    let socket: WebSocket | null = null
    let cleanupResize: (() => void) | null = null

    ;(async () => {
      const { Terminal }  = await import('@xterm/xterm')
      const { FitAddon }  = await import('@xterm/addon-fit')
      if (disposed || !mountRef.current) return

      const term = new Terminal({
        theme:            THEME,
        fontFamily:       '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize:         13,
        lineHeight:       1.35,
        cursorBlink:      true,
        cursorStyle:      'bar',
        scrollback:       10_000,
        allowProposedApi: true,
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(mountRef.current)
      fit.fit()

      setFatal(null)
      onStateRef.current('connecting')

      const params = new URLSearchParams({
        host, id: hostId, port: String(port),
        cols: String(term.cols), rows: String(term.rows),
      })
      socket = new WebSocket(`${wsBase()}/deck/term?${params}`)

      socket.onmessage = (ev) => {
        let frame: any
        try { frame = JSON.parse(ev.data) } catch { return }

        if (frame.t === 'data') {
          term.write(frame.d)
        } else if (frame.t === 'status') {
          if (frame.state === 'ready') {
            onStateRef.current('ready')
            onAttachRef.current({
              persistent:     !!frame.persistent,
              session:        frame.session,
              hostKeyLearned: frame.hostKeyLearned,
              fingerprint:    frame.fingerprint,
            })
            term.focus()
          } else if (frame.state === 'closed') {
            onStateRef.current('closed', frame.detail)
          }
        } else if (frame.t === 'error') {
          setFatal(frame.m)
          onStateRef.current('error', frame.m)
        }
      }

      socket.onerror = () => {
        setFatal('The terminal connection failed. Check that the API is running.')
        onStateRef.current('error')
      }
      socket.onclose = () => { if (!disposed) onStateRef.current('closed') }

      term.onData(d => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'data', d }))
      })

      const handleResize = () => {
        try { fit.fit() } catch { return }
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }))
        }
      }
      window.addEventListener('resize', handleResize)

      const observer = new ResizeObserver(handleResize)
      observer.observe(mountRef.current)

      cleanupResize = () => {
        window.removeEventListener('resize', handleResize)
        observer.disconnect()
        term.dispose()
      }
    })()

    return () => {
      disposed = true
      cleanupResize?.()
      socket?.close()
    }
  }, [host, hostId, port, attempt])

  return (
    <div className="relative flex-1 min-h-0" style={{ background: '#080c14' }}>
      <div ref={mountRef} className="absolute inset-0 px-3 py-2" />
      {fatal && (
        <div
          className="absolute left-4 right-4 bottom-4 rounded border px-3 py-2 font-mono text-xs whitespace-pre-wrap"
          style={{ background: '#1a0d10', borderColor: '#7f1d1d', color: '#fca5a5' }}
          role="alert"
        >
          {fatal}
        </div>
      )}
    </div>
  )
}
