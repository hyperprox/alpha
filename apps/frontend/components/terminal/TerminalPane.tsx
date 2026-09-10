'use client'

// =============================================================================
//  HyperProx — Deck terminal pane
//
//  xterm.js over the /ws/terminal/term socket. The session itself lives in tmux on
//  the target, so this component is only a window onto it: unmounting closes the
//  socket and leaves the work running.
// =============================================================================

import { useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { wsBase } from '@/lib/ws'

export type PaneState = 'idle' | 'connecting' | 'ready' | 'closed' | 'error'

export interface TerminalPaneProps {
  host:     string
  hostId:   string
  port:     number
  /** tmux session on the host. Distinct per pane, so two panes on one host do
      not attach to the same session and mirror each other. */
  session:  string
  /** False for an appliance CLI — RouterOS and friends have no shell to host
      tmux, and probing for one only wastes a round trip on every connect. */
  tmux?:    boolean
  /** Bumping this remounts the session — used by Reconnect. */
  attempt:  number
  onState:  (s: PaneState, detail?: string) => void
  onAttach: (info: { persistent: boolean; session?: string; hostKeyLearned?: boolean; fingerprint?: string }) => void
}

const FONT_STACK = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace'

// Terminal colours are the HyperProx palette, not xterm's defaults — a stock
// terminal theme inside this shell looks like a foreign object.
const THEME = {
  background:          'var(--ground)',
  foreground:          'var(--text)',
  cursor:              'var(--accent)',
  cursorAccent:        'var(--ground)',
  selectionBackground: 'rgba(0,229,255,0.24)',
  black:   'var(--surface)', red:     'var(--crit)', green:   'var(--good)', yellow:  'var(--warn)',
  blue:    'var(--accent-2)', magenta: 'var(--violet)', cyan:    'var(--accent)', white:   'var(--text)',
  brightBlack:   'var(--text-dim)', brightRed:     'var(--crit-soft)', brightGreen:   'var(--good)',
  brightYellow:  'var(--warn)', brightBlue:    'var(--accent-2)', brightMagenta: 'var(--violet)',
  brightCyan:    'var(--accent-2)', brightWhite:   'var(--text-bright)',
}

/**
 * Wait for the terminal font before measuring a character cell.
 *
 * xterm derives the whole grid from one measured cell. IBM Plex Mono arrives
 * from Google Fonts asynchronously, so fitting immediately measures the fallback
 * and then the real font swaps in underneath a grid computed for different
 * metrics — misaligned columns and a cursor that sits off the text.
 */
async function fontReady(): Promise<void> {
  const fonts = (document as any).fonts
  if (!fonts) return
  try {
    await fonts.load(`13px ${FONT_STACK}`)
    await fonts.ready
  } catch { /* a font that never loads must not block the terminal */ }
}

export function TerminalPane({ host, hostId, port, session, tmux = true, attempt, onState, onAttach }: TerminalPaneProps) {
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
    let cleanup: (() => void) | null = null

    ;(async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ])
      await fontReady()
      if (disposed || !mountRef.current) return

      const term = new Terminal({
        theme:            THEME,
        fontFamily:       FONT_STACK,
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

      // A fit against a zero-height container yields a 1-row grid that never
      // recovers, so refuse to measure until the pane has been laid out.
      const safeFit = () => {
        const el = mountRef.current
        if (!el || el.clientWidth < 2 || el.clientHeight < 2) return false
        try { fit.fit() } catch { return false }
        return true
      }

      safeFit()
      // One more pass after the browser has painted: web fonts can settle a
      // frame late even once fonts.ready has resolved.
      requestAnimationFrame(() => { if (!disposed) safeFit() })

      setFatal(null)
      onStateRef.current('connecting')

      const params = new URLSearchParams({
        host, id: hostId, port: String(port), session, tmux: tmux ? '1' : '0',
        cols: String(term.cols), rows: String(term.rows),
      })
      socket = new WebSocket(`${wsBase()}/terminal/term?${params}`)

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
            // tmux paints for the size it was told about, so make sure the size
            // we reported is the one we actually have before it draws.
            sendResize()
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

      function sendResize() {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }))
        }
      }

      // ResizeObserver fires for every intermediate width while a pane animates.
      // Refitting on each one repaints the grid dozens of times and tmux redraws
      // behind it; coalesce to one fit per frame-ish.
      let pending: number | null = null
      const onResize = () => {
        if (pending) window.clearTimeout(pending)
        pending = window.setTimeout(() => {
          pending = null
          if (safeFit()) sendResize()
        }, 60)
      }

      window.addEventListener('resize', onResize)
      const observer = new ResizeObserver(onResize)
      observer.observe(mountRef.current)

      cleanup = () => {
        if (pending) window.clearTimeout(pending)
        window.removeEventListener('resize', onResize)
        observer.disconnect()
        term.dispose()
      }
    })()

    return () => {
      disposed = true
      cleanup?.()
      socket?.close()
    }
  }, [host, hostId, port, session, attempt])

  return (
    <div className="relative flex-1 min-h-0" style={{ background: 'var(--ground)' }}>
      {/* The padding lives on this wrapper, never on the element xterm mounts
          into: FitAddon subtracts the padding of the terminal element itself,
          not of its parent, so padding on the mount node is counted as usable
          space and the grid overflows by exactly that much — clipping the last
          column and row. */}
      <div className="absolute inset-0 px-3 py-2">
        <div ref={mountRef} className="h-full w-full" />
      </div>
      {fatal && (
        <div
          className="absolute left-4 right-4 bottom-4 rounded border px-3 py-2 font-mono text-xs whitespace-pre-wrap"
          style={{ background: 'var(--ground)', borderColor: 'var(--crit)', color: 'var(--crit-soft)' }}
          role="alert"
        >
          {fatal}
        </div>
      )}
    </div>
  )
}
