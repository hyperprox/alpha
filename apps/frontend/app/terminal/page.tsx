'use client'

// =============================================================================
//  HyperProx — Deck
//  A terminal for every host on the cluster, plus anything else you add.
//
//  Panes stay mounted when you switch tabs. Hiding a pane rather than
//  unmounting it is what keeps the socket — and the scrollback — alive; the
//  work itself is in tmux on the host either way.
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import { TerminalPane, type PaneState } from '@/components/terminal/TerminalPane'
import { AddHostDialog, ConnectDialog, SaveLayoutDialog, type CredentialDraft } from '@/components/terminal/TerminalDialogs'
import { HostPalette } from '@/components/terminal/HostPalette'
import { alpha } from '@/lib/theme'

interface TerminalHost {
  id: string; name: string; vmid: number; node: string
  type: 'lxc' | 'qemu' | 'manual'; status: string
  ip: string | null; port?: number; hasCredential: boolean
  source: 'cluster' | 'manual' | 'plugin'
  tmux?: boolean
  hint?: string
}

interface AttachInfo {
  persistent: boolean; session?: string
  hostKeyLearned?: boolean; fingerprint?: string
}

interface Session {
  key:     string          // unique per tab, so one host can be opened twice
  tmux:    string          // tmux session on the host — distinct per pane
  host:    TerminalHost
  address: string
  port:    number
  attempt: number
  state:   PaneState
  detail?: string
  attach:  AttachInfo | null
}

const BORDER = 'var(--border)'
const ACCENT = 'var(--accent)'

const STATE_STYLE: Record<PaneState, { label: string; color: string; dot: string }> = {
  idle:       { label: 'No session',   color: 'var(--text-dim)', dot: 'var(--text-dimmer)' },
  connecting: { label: 'Connecting',   color: 'var(--warn)', dot: 'var(--warn)' },
  ready:      { label: 'Connected',    color: 'var(--good)', dot: 'var(--good)' },
  closed:     { label: 'Disconnected', color: 'var(--text-muted)', dot: 'var(--text-dim)' },
  error:      { label: 'Failed',       color: 'var(--crit)', dot: 'var(--crit)' },
}

type ViewMode = 'tabs' | 'cols' | 'rows' | 'grid'

interface SavedLayout {
  id: string; name: string; view: ViewMode
  panes: Array<{ hostId: string; name: string; address: string; port: number }>
}

// How each mode arranges the open panes. Every pane is live in all of them —
// only `tabs` hides the inactive ones.
const GRID: Record<ViewMode, React.CSSProperties> = {
  tabs: { display: 'block' },
  cols: { display: 'grid', gridAutoFlow: 'column', gridAutoColumns: 'minmax(0, 1fr)' },
  rows: { display: 'grid', gridAutoFlow: 'row',    gridAutoRows:    'minmax(0, 1fr)' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gridAutoRows: 'minmax(0, 1fr)' },
}

const VIEW_LABEL: Record<ViewMode, string> = {
  tabs: 'One at a time',
  cols: 'Side by side',
  rows: 'Stacked',
  grid: 'Grid',
}

function ViewIcon({ mode }: { mode: ViewMode }) {
  const common = { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, width: 13, height: 13 }
  if (mode === 'tabs') return <svg {...common}><rect x="1.5" y="3.5" width="13" height="9" rx="1" /><path d="M1.5 6.5h13" /></svg>
  if (mode === 'cols') return <svg {...common}><rect x="1.5" y="2.5" width="13" height="11" rx="1" /><path d="M8 2.5v11" /></svg>
  if (mode === 'rows') return <svg {...common}><rect x="1.5" y="2.5" width="13" height="11" rx="1" /><path d="M1.5 8h13" /></svg>
  return <svg {...common}><rect x="1.5" y="2.5" width="13" height="11" rx="1" /><path d="M8 2.5v11M1.5 8h13" /></svg>
}

let tabSeq = 0

export default function TerminalPage() {
  const [hosts,     setHosts]     = useState<TerminalHost[]>([])
  const [loading,   setLoading]   = useState(true)
  const [notice,    setNotice]    = useState<string | null>(null)
  const [palette,   setPalette]   = useState(false)
  // Two 80-column shells side by side on a phone is two unreadable shells. The
  // panes stay connected either way; this only decides what is shown.
  const [narrow,    setNarrow]    = useState(false)
  const [hasShared, setHasShared] = useState(false)

  const [sessions,  setSessions]  = useState<Session[]>([])
  const [activeKey, setActiveKey] = useState<string | null>(null)

  const [credentialFor, setCredentialFor] = useState<TerminalHost | null>(null)
  const [addingHost,    setAddingHost]    = useState(false)

  const [view,          setView]          = useState<ViewMode>('tabs')
  const [layouts,       setLayouts]       = useState<SavedLayout[]>([])
  const [savingLayout,  setSavingLayout]  = useState(false)
  const [layoutMenu,    setLayoutMenu]    = useState(false)

  const active = sessions.find(s => s.key === activeKey) ?? null

  // -- Load -------------------------------------------------------------------
  const load = useCallback(async () => {
    try {
      const [hostRes, credRes] = await Promise.all([
        fetch('/api/terminal/hosts').then(r => r.json()),
        fetch('/api/terminal/credentials').then(r => r.json()),
      ])
      if (!hostRes.success) throw new Error(hostRes.error ?? 'The host list could not be loaded')
      setHosts(hostRes.data)
      setHasShared(!!credRes?.data?.shared)
      setNotice(null)
    } catch (e: any) {
      setNotice(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const loadLayouts = useCallback(async () => {
    try {
      const res = await fetch('/api/terminal/layouts').then(r => r.json())
      if (res.success) setLayouts(res.data)
    } catch { /* the layout list is a convenience, never a blocker */ }
  }, [])
  useEffect(() => { loadLayouts() }, [loadLayouts])

  // ?open=<host id> — how Infrastructure's Console button lands here.
  // Read from location rather than useSearchParams: the latter forces this
  // statically-rendered page into a Suspense boundary and fails the build.
  const [pendingOpen, setPendingOpen] = useState<string | null>(null)
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('open')
    if (id) {
      setPendingOpen(id)
      window.history.replaceState({}, '', '/terminal')
    }
  }, [])

  useEffect(() => {
    if (!pendingOpen || !hosts.length) return
    const host = hosts.find(h => h.id === pendingOpen)
    setPendingOpen(null)
    if (!host) return setNotice(`No host on this cluster matches "${pendingOpen}".`)
    open(host)
  // `open` is recreated each render; depending on it would re-fire this.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOpen, hosts])

  // -- Sessions ---------------------------------------------------------------
  const patch = useCallback((key: string, fields: Partial<Session>) => {
    setSessions(prev => prev.map(s => (s.key === key ? { ...s, ...fields } : s)))
  }, [])

  // Two panes on one host must not share a tmux session — tmux mirrors every
  // attached client and sizes to the smallest, so they would show the same
  // shell and fight over the window.
  const nextTmuxName = (hostId: string, current: Session[]) => {
    const used = new Set(current.filter(x => x.host.id === hostId).map(x => x.tmux))
    for (let i = 1; i < 50; i++) {
      const name = i === 1 ? 'terminal' : `terminal-${i}`
      if (!used.has(name)) return name
    }
    return `terminal-${Date.now() % 10000}`
  }

  const openSession = (host: TerminalHost, address: string, port: number) => {
    const key = `${host.id}#${++tabSeq}`
    setSessions(prev => [...prev, {
      key, tmux: nextTmuxName(host.id, prev), host, address, port,
      attempt: 1, state: 'connecting', attach: null,
    }])
    setActiveKey(key)
  }

  const open = (host: TerminalHost) => {
    if (!host.hasCredential || !host.ip) return setCredentialFor(host)

    // Clicking a host you already have open focuses that tab rather than
    // stacking duplicates; a second one is still available from the tab bar.
    const existing = sessions.find(s => s.host.id === host.id)
    if (existing) return setActiveKey(existing.key)

    openSession(host, host.ip, host.port ?? 22)
  }

  const closeSession = (key: string) => {
    setSessions(prev => {
      const next = prev.filter(s => s.key !== key)
      if (key === activeKey) setActiveKey(next.length ? next[next.length - 1].key : null)
      return next
    })
  }

  // -- Credentials & hosts ----------------------------------------------------
  const saveCredential = async (draft: CredentialDraft) => {
    const address = draft.address
    const host = credentialFor!
    const res = await fetch(`/api/terminal/credentials/${encodeURIComponent(host.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    }).then(r => r.json())

    if (!res.success) return setNotice(res.error)
    setCredentialFor(null)
    await load()
    openSession({ ...host, ip: address, hasCredential: true }, address, draft.port)
  }

  const forgetCredential = async (host: TerminalHost) => {
    const res = await fetch(`/api/terminal/credentials/${encodeURIComponent(host.id)}`, { method: 'DELETE' })
      .then(r => r.json())
    if (!res.success) return setNotice(res.error)
    setNotice(`Saved login for ${host.name} removed.`)
    await load()
  }

  const forgetHostKey = async (session: Session) => {
    const pin = `${session.address}:${session.port}`
    const res = await fetch(`/api/terminal/hostkeys/${encodeURIComponent(pin)}`, { method: 'DELETE' })
      .then(r => r.json())
    if (!res.success) return setNotice(res.error)
    setNotice(`Pinned host key for ${pin} cleared — it will be learned again on the next connect.`)
  }

  const addHost = async (h: { name: string; address: string; port: number }) => {
    const res = await fetch('/api/terminal/manual-hosts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(h),
    }).then(r => r.json())
    setAddingHost(false)
    if (!res.success) return setNotice(res.error)
    await load()
  }

  const removeHost = async (host: TerminalHost) => {
    const res = await fetch(`/api/terminal/manual-hosts/${encodeURIComponent(host.id)}`, { method: 'DELETE' })
      .then(r => r.json())
    if (!res.success) return setNotice(res.error)
    sessions.filter(s => s.host.id === host.id).forEach(s => closeSession(s.key))
    await load()
  }

  // -- Persistence ------------------------------------------------------------
  const [enabling, setEnabling] = useState(false)

  const enablePersistence = async (sess: Session) => {
    setEnabling(true)
    setNotice(`Installing tmux on ${sess.host.name}…`)
    try {
      const res = await fetch(`/api/terminal/hosts/${encodeURIComponent(sess.host.id)}/enable-persistence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: sess.address, port: sess.port }),
      }).then(r => r.json())

      if (!res.success) return setNotice(res.error)
      setNotice(res.data.message)
      // Reconnecting is what actually picks tmux up — the running shell was
      // started without it.
      patch(sess.key, { attempt: sess.attempt + 1, attach: null })
    } catch (e: any) {
      setNotice(e.message)
    } finally {
      setEnabling(false)
    }
  }

  // -- Layouts ----------------------------------------------------------------
  const saveLayout = async (name: string) => {
    setSavingLayout(false)
    if (!name) return
    const res = await fetch('/api/terminal/layouts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name, view,
        panes: sessions.map(x => ({
          hostId: x.host.id, name: x.host.name, address: x.address, port: x.port,
        })),
      }),
    }).then(r => r.json())
    if (!res.success) return setNotice(res.error)
    setNotice(`Layout "${name}" saved.`)
    loadLayouts()
  }

  const applyLayout = (layout: SavedLayout) => {
    setLayoutMenu(false)
    const opened: Session[] = layout.panes.map(pane => {
      // Prefer the live host record — its status and name may have moved on —
      // but keep the pane if the guest is gone, rather than silently dropping it.
      const live = hosts.find(h => h.id === pane.hostId)
      const host: TerminalHost = live ?? {
        id: pane.hostId, name: pane.name, vmid: 0, node: 'unknown',
        type: 'manual', status: 'unknown', ip: pane.address,
        hasCredential: true, source: 'manual',
      }
      return {
        key: `${host.id}#${++tabSeq}`, host,
        address: pane.address, port: pane.port,
        attempt: 1, state: 'connecting' as PaneState, attach: null,
        tmux: 'terminal',
      }
    })
    // Restored panes on the same host still need distinct sessions.
    const seen = new Map<string, number>()
    for (const o of opened) {
      const n = (seen.get(o.host.id) ?? 0) + 1
      seen.set(o.host.id, n)
      o.tmux = n === 1 ? 'terminal' : `terminal-${n}`
    }
    setSessions(opened)
    setActiveKey(opened.length ? opened[0].key : null)
    setView(layout.view)
    setNotice(`Opened "${layout.name}" — ${opened.length} pane${opened.length === 1 ? '' : 's'}.`)
  }

  const deleteLayout = async (name: string) => {
    const res = await fetch(`/api/terminal/layouts/${encodeURIComponent(name)}`, { method: 'DELETE' })
      .then(r => r.json())
    if (!res.success) return setNotice(res.error)
    loadLayouts()
  }

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const sync = () => setNarrow(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  // Ctrl/Cmd-K is the shortcut people already try in a terminal app. Bound on
  // the window rather than a pane, because a focused xterm swallows keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette(v => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const openIds = new Set(sessions.map(s => s.host.id))
  const s = active ? STATE_STYLE[active.state] : null

  return (
    <div className="flex h-full">
      {/* ---- Panes ---------------------------------------------------------- */}
      <section className="flex min-w-0 flex-1 flex-col">
        {/* Tab bar. Always rendered, because it is also where hosts are opened
            from — the left-hand host column it replaces was a second menu
            stacked against the app's own. */}
        <div className="flex flex-shrink-0 items-stretch overflow-x-auto border-b"
          style={{ borderColor: BORDER, background: 'var(--ground-deep)', height: 37 }}>
          <div className="flex flex-shrink-0 items-center gap-2 border-r px-3" style={{ borderColor: BORDER }}>
            <h1 className="font-display text-[12px] font-light tracking-[0.18em]" style={{ color: 'var(--text-dim)' }}>TERMINAL</h1>
          </div>
          {sessions.map(sess => {
              const isActive = sess.key === activeKey
              const st = STATE_STYLE[sess.state]
              return (
                <div key={sess.key}
                  className="group flex flex-shrink-0 items-center gap-2 border-r pl-3 pr-1.5 transition-colors"
                  style={{
                    borderColor: BORDER,
                    background:  isActive ? 'var(--surface)' : 'transparent',
                    boxShadow:   isActive ? `inset 0 -2px 0 ${ACCENT}` : 'none',
                  }}>
                  <button onClick={() => setActiveKey(sess.key)} className="flex items-center gap-2 py-2">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: st.dot }} />
                    <span className="font-mono text-[12px]" style={{ color: isActive ? ACCENT : 'var(--text-muted)' }}>
                      {sess.host.name}
                    </span>
                  </button>
                  <button onClick={() => closeSession(sess.key)} title="Close this pane"
                    className="flex h-5 w-5 items-center justify-center rounded opacity-0 transition-opacity hover:bg-white/10 group-hover:opacity-100"
                    style={{ color: 'var(--text-dim)' }}>
                    <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                    </svg>
                  </button>
              </div>
            )
          })}

          <button
            onClick={() => setPalette(true)}
            title="Open a terminal   (Ctrl/⌘ K)"
            className="flex flex-shrink-0 items-center gap-1.5 px-3 transition-colors hover:bg-white/5"
            style={{ color: 'var(--text-dim)' }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <path d="M8 3v10M3 8h10" strokeLinecap="round" />
            </svg>
            {!sessions.length && <span className="font-mono text-[11px]">Open a terminal</span>}
          </button>

          <div className="ml-auto flex flex-shrink-0 items-center px-3 font-mono text-[10px]" style={{ color: 'var(--text-faint)' }}>
            {loading ? 'loading…' : `${hosts.length} hosts · ${sessions.length} open`}
          </div>
        </div>

        {/* Header for the active pane */}
        <header className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5 sm:gap-3 sm:px-4"
          style={{ minHeight: 52, borderColor: BORDER, background: 'var(--surface-raised)' }}>
          {active && s ? (
            <>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="truncate font-display text-[15px] font-semibold tracking-wide text-white">{active.host.name}</span>
                  <span className="font-mono text-[11px]" style={{ color: 'var(--text-dimmer)' }}>
                    {active.address}:{active.port}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 pt-0.5">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.dot }} />
                  <span className="font-mono text-[11px]" style={{ color: s.color }}>{s.label}</span>
                  {active.detail && <span className="font-mono text-[11px]" style={{ color: 'var(--text-dimmer)' }}>· {active.detail}</span>}
                </div>
              </div>

              <div className="ml-auto flex flex-wrap items-center gap-2">
                {active.attach?.persistent && (
                  <span className="rounded px-2 py-1 font-mono text-[10.5px]"
                    style={{ background: 'color-mix(in srgb, var(--accent) 7%, transparent)', color: ACCENT, border: '1px solid color-mix(in srgb, var(--accent) 16%, transparent)' }}
                    title="The shell runs in tmux on the host. Close this tab and it keeps running.">
                    tmux · {active.attach.session}
                  </span>
                )}
                {active.attach && !active.attach.persistent && (
                  <button
                    onClick={() => enablePersistence(active)}
                    disabled={enabling}
                    title="This host has no tmux, so closing the pane ends the session. This installs it."
                    className="rounded px-2 py-1 font-mono text-[10.5px] transition-colors hover:bg-amber-400/10 disabled:opacity-50"
                    style={{ background: 'color-mix(in srgb, var(--warn) 7%, transparent)', color: 'var(--warn)', border: '1px solid color-mix(in srgb, var(--warn) 16%, transparent)' }}>
                    {enabling ? 'installing tmux…' : 'not persistent — fix'}
                  </button>
                )}
                <button onClick={() => forgetHostKey(active)}
                  title="Clear the pinned host key — do this only when the guest was genuinely rebuilt"
                  className="rounded border px-2.5 py-1 font-display text-xs tracking-wide transition-colors hover:bg-white/5"
                  style={{ borderColor: 'var(--border-strong)', color: 'var(--text-muted)' }}>
                  Clear host key
                </button>
                <button onClick={() => forgetCredential(active.host)}
                  className="rounded border px-2.5 py-1 font-display text-xs tracking-wide transition-colors hover:bg-white/5"
                  style={{ borderColor: 'var(--border-strong)', color: 'var(--text-muted)' }}>
                  Forget login
                </button>
                <button onClick={() => setCredentialFor(active.host)}
                  className="rounded border px-2.5 py-1 font-display text-xs tracking-wide transition-colors hover:bg-white/5"
                  style={{ borderColor: 'var(--border-strong)', color: 'var(--text-muted)' }}>
                  Change login
                </button>
                <button onClick={() => patch(active.key, { attempt: active.attempt + 1, attach: null })}
                  className="rounded px-3 py-1 font-display text-xs font-semibold tracking-wide transition-opacity hover:opacity-85"
                  style={{ background: 'color-mix(in srgb, var(--accent) 8%, transparent)', color: ACCENT, border: '1px solid color-mix(in srgb, var(--accent) 19%, transparent)' }}>
                  Reconnect
                </button>
              </div>
            </>
          ) : (
            <button onClick={() => setPalette(true)}
              className="flex items-center gap-2 font-mono text-[12px] transition-colors hover:text-slate-300"
              style={{ color: 'var(--text-dimmer)' }}>
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8}>
                <path d="M8 3v10M3 8h10" strokeLinecap="round" />
              </svg>
              Open a terminal
              <span style={{ color: 'var(--text-faint)' }}>Ctrl / ⌘ K</span>
            </button>
          )}

          <div className={`flex items-center gap-2 ${active ? '' : 'ml-auto'}`}>
            {/* View. Every pane stays connected in all four; only `tabs` hides
                the inactive ones. */}
            <div className="hidden rounded border md:flex" style={{ borderColor: 'var(--border-strong)' }}>
              {(['tabs', 'cols', 'rows', 'grid'] as ViewMode[]).map(m => (
                <button key={m} onClick={() => setView(m)} title={VIEW_LABEL[m]}
                  className="flex h-7 w-7 items-center justify-center transition-colors first:rounded-l last:rounded-r hover:bg-white/5"
                  style={view === m ? { background: 'color-mix(in srgb, var(--accent) 8%, transparent)', color: ACCENT } : { color: 'var(--text-dim)' }}>
                  <ViewIcon mode={m} />
                </button>
              ))}
            </div>

            <div className="relative">
              <button onClick={() => setLayoutMenu(v => !v)}
                className="flex items-center gap-1.5 rounded border px-2.5 py-1 font-display text-xs tracking-wide transition-colors hover:bg-white/5"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--text-muted)' }}>
                Layouts
                <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M3 6l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              {layoutMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setLayoutMenu(false)} />
                  <div className="absolute right-0 z-50 mt-1.5 w-60 rounded border shadow-2xl"
                    style={{ background: 'var(--surface)', borderColor: 'var(--border-strong)' }}>
                    {layouts.length === 0 && (
                      <p className="px-3 py-3 font-mono text-[11px]" style={{ color: 'var(--text-dim)' }}>
                        No saved layouts yet.
                      </p>
                    )}
                    {layouts.map(l => (
                      <div key={l.id} className="group flex items-center border-b last:border-b-0"
                        style={{ borderColor: 'var(--border)' }}>
                        <button onClick={() => applyLayout(l)} className="flex min-w-0 flex-1 flex-col px-3 py-2 text-left">
                          <span className="truncate font-mono text-[12px]" style={{ color: 'var(--text)' }}>{l.name}</span>
                          <span className="font-mono text-[10px]" style={{ color: 'var(--text-dimmer)' }}>
                            {l.panes.length} pane{l.panes.length === 1 ? '' : 's'} · {VIEW_LABEL[l.view] ?? l.view}
                          </span>
                        </button>
                        <button onClick={() => deleteLayout(l.name)} title={`Delete "${l.name}"`}
                          className="mr-2 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-white/10 group-hover:opacity-100"
                          style={{ color: 'var(--text-dim)' }}>
                          <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2}>
                            <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                          </svg>
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={() => { setLayoutMenu(false); setSavingLayout(true) }}
                      disabled={!sessions.length}
                      className="w-full border-t px-3 py-2 text-left font-display text-xs tracking-wide transition-colors hover:bg-white/5 disabled:opacity-40"
                      style={{ borderColor: 'var(--border)', color: ACCENT }}>
                      Save current arrangement…
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {active?.attach?.hostKeyLearned && (
          <div className="flex-shrink-0 border-b px-4 py-2 font-mono text-[11px]"
            style={{ borderColor: BORDER, background: 'var(--surface-notice)', color: 'var(--text-muted)' }}>
            First connection to this host — its key is now pinned as{' '}
            <span style={{ color: 'var(--text-soft)' }}>{active.attach.fingerprint}</span>. A change will be refused.
          </div>
        )}

        {notice && (
          <div className="flex flex-shrink-0 items-center gap-3 border-b px-4 py-2 font-mono text-[11px]"
            style={{ borderColor: BORDER, background: 'var(--surface-notice)', color: 'var(--text-soft)' }}>
            <span className="flex-1">{notice}</span>
            <button onClick={() => setNotice(null)} style={{ color: 'var(--text-dim)' }}>dismiss</button>
          </div>
        )}

        {/* Every open pane stays mounted; only the active one is shown. */}
        <div
          className="relative flex-1"
          style={{ ...GRID[narrow ? 'tabs' : view], minHeight: 0, background: 'var(--ground)',
                   gap: (narrow || view === 'tabs') ? 0 : 1 }}
        >
          {/* Inline display beats the utility class here: Tailwind's .flex would
              otherwise override [hidden]{display:none} and stack every pane on
              top of the active one. */}
          {sessions.map(sess => (
            <div
              key={sess.key}
              onClick={() => setActiveKey(sess.key)}
              className={(narrow || view === 'tabs') ? 'absolute inset-0 flex-col' : 'flex min-h-0 min-w-0 flex-col overflow-hidden'}
              style={{
                display: (!narrow && view !== 'tabs') || sess.key === activeKey ? 'flex' : 'none',
                outline: !narrow && view !== 'tabs' && sess.key === activeKey ? `1px solid ${alpha(ACCENT, 25)}` : 'none',
                outlineOffset: -1,
              }}
            >
              {!narrow && view !== 'tabs' && (
                <div className="flex flex-shrink-0 items-center gap-2 border-b px-2.5 py-1"
                  style={{ borderColor: BORDER, background: 'var(--surface-raised)' }}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATE_STYLE[sess.state].dot }} />
                  <span className="truncate font-mono text-[11px]"
                    style={{ color: sess.key === activeKey ? ACCENT : 'var(--text-muted)' }}>
                    {sess.host.name}
                  </span>
                  <button onClick={e => { e.stopPropagation(); closeSession(sess.key) }} title="Close this pane"
                    className="ml-auto flex h-4 w-4 items-center justify-center rounded hover:bg-white/10"
                    style={{ color: 'var(--text-dimmer)' }}>
                    <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              )}
              <TerminalPane
                host={sess.address}
                hostId={sess.host.id}
                port={sess.port}
                session={sess.tmux}
                tmux={sess.host.tmux !== false}
                attempt={sess.attempt}
                onState={(state, detail) => patch(sess.key, { state, detail })}
                onAttach={attach => patch(sess.key, { attach })}
              />
            </div>
          ))}

          {!sessions.length && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="max-w-sm px-6 text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded border"
                  style={{ borderColor: 'var(--border-strong)', color: 'var(--text-faint)' }}>
                  <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4}>
                    <rect x="1" y="2.5" width="14" height="11" rx="1.5" />
                    <path d="M4 6.5l2 1.75-2 1.75M8 10.5h4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <p className="font-display text-sm tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  Every guest on the cluster is one keystroke away.
                </p>
                <p className="mt-1.5 font-mono text-[11px] leading-relaxed" style={{ color: 'var(--text-dimmer)' }}>
                  Open as many as you like — panes stay connected in the background,
                  and the work runs in tmux on the host.
                </p>
                <button
                  onClick={() => setPalette(true)}
                  className="mt-4 rounded px-3 py-1.5 font-display text-xs font-semibold tracking-wide transition-opacity hover:opacity-85"
                  style={{ background: 'color-mix(in srgb, var(--accent) 8%, transparent)', color: ACCENT, border: '1px solid color-mix(in srgb, var(--accent) 19%, transparent)' }}>
                  Open a terminal
                </button>
                <p className="mt-2 font-mono text-[10px]" style={{ color: 'var(--text-dimmest)' }}>or press Ctrl / ⌘ K</p>
              </div>
            </div>
          )}
        </div>
      </section>

      {credentialFor && (
        <ConnectDialog
          hostName={credentialFor.name}
          hostAddress={credentialFor.ip ?? ''}
          hasShared={hasShared}
          onSave={saveCredential}
          onClose={() => setCredentialFor(null)}
        />
      )}
      {palette && (
        <HostPalette
          hosts={hosts}
          openIds={openIds}
          activeHostId={active?.host.id ?? null}
          loading={loading}
          onOpen={open}
          onRemove={removeHost}
          onAddManual={() => setAddingHost(true)}
          onClose={() => setPalette(false)}
        />
      )}
      {addingHost && <AddHostDialog onSave={addHost} onClose={() => setAddingHost(false)} />}
      {savingLayout && (
        <SaveLayoutDialog
          paneCount={sessions.length}
          existing={layouts.map(l => l.name)}
          onSave={saveLayout}
          onClose={() => setSavingLayout(false)}
        />
      )}
    </div>
  )
}
