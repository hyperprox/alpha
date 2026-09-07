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
import { AddHostDialog, ConnectDialog, type CredentialDraft } from '@/components/terminal/TerminalDialogs'

interface TerminalHost {
  id: string; name: string; vmid: number; node: string
  type: 'lxc' | 'qemu' | 'manual'; status: string
  ip: string | null; port?: number; hasCredential: boolean
  source: 'cluster' | 'manual'
}

interface AttachInfo {
  persistent: boolean; session?: string
  hostKeyLearned?: boolean; fingerprint?: string
}

interface Session {
  key:     string          // unique per tab, so one host can be opened twice
  host:    TerminalHost
  address: string
  port:    number
  attempt: number
  state:   PaneState
  detail?: string
  attach:  AttachInfo | null
}

const BORDER = '#0f1929'
const ACCENT = '#00e5ff'

const STATE_STYLE: Record<PaneState, { label: string; color: string; dot: string }> = {
  idle:       { label: 'No session',   color: '#4b5563', dot: '#374151' },
  connecting: { label: 'Connecting',   color: '#f59e0b', dot: '#f59e0b' },
  ready:      { label: 'Connected',    color: '#22c55e', dot: '#22c55e' },
  closed:     { label: 'Disconnected', color: '#6b7280', dot: '#4b5563' },
  error:      { label: 'Failed',       color: '#ef4444', dot: '#ef4444' },
}

let tabSeq = 0

export default function TerminalPage() {
  const [hosts,     setHosts]     = useState<TerminalHost[]>([])
  const [loading,   setLoading]   = useState(true)
  const [notice,    setNotice]    = useState<string | null>(null)
  const [query,     setQuery]     = useState('')
  const [hasShared, setHasShared] = useState(false)

  const [sessions,  setSessions]  = useState<Session[]>([])
  const [activeKey, setActiveKey] = useState<string | null>(null)

  const [credentialFor, setCredentialFor] = useState<TerminalHost | null>(null)
  const [addingHost,    setAddingHost]    = useState(false)

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

  const openSession = (host: TerminalHost, address: string, port: number) => {
    const key = `${host.id}#${++tabSeq}`
    setSessions(prev => [...prev, {
      key, host, address, port, attempt: 1, state: 'connecting', attach: null,
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
  const saveCredential = async (draft: CredentialDraft, address: string) => {
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

  // -- Grouping ---------------------------------------------------------------
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = hosts.filter(h =>
      !q || h.name.toLowerCase().includes(q) || String(h.vmid).includes(q) || (h.ip ?? '').includes(q))

    const byGroup = new Map<string, TerminalHost[]>()
    for (const h of filtered) {
      const k = h.source === 'manual' ? 'Added by hand' : h.node
      if (!byGroup.has(k)) byGroup.set(k, [])
      byGroup.get(k)!.push(h)
    }
    return [...byGroup.entries()].sort((a, b) =>
      a[0] === 'Added by hand' ? 1 : b[0] === 'Added by hand' ? -1 : a[0].localeCompare(b[0]))
  }, [hosts, query])

  const openIds = new Set(sessions.map(s => s.host.id))
  const s = active ? STATE_STYLE[active.state] : null

  return (
    <div className="flex h-full">
      {/* ---- Host rail ------------------------------------------------------ */}
      <aside className="flex w-[264px] flex-shrink-0 flex-col border-r" style={{ background: '#060a10', borderColor: BORDER }}>
        <div className="flex flex-shrink-0 items-center justify-between border-b px-4" style={{ height: 56, borderColor: BORDER }}>
          <div>
            <h1 className="font-display text-lg font-light tracking-[0.18em] text-white">TERMINAL</h1>
            <p className="font-mono text-[10px]" style={{ color: '#374151' }}>
              {loading ? 'loading…' : `${hosts.length} hosts · ${sessions.length} open`}
            </p>
          </div>
          <button
            onClick={() => setAddingHost(true)}
            title="Add a host by hand"
            className="flex h-7 w-7 items-center justify-center rounded border transition-colors hover:bg-white/5"
            style={{ borderColor: '#16233a', color: '#4b5563' }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
              <path d="M8 3v10M3 8h10" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="flex-shrink-0 px-3 py-2.5">
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Filter by name, id or address"
            className="w-full rounded border px-2.5 py-1.5 font-mono text-[12px] outline-none transition-colors focus:border-cyan"
            style={{ background: '#080c14', borderColor: '#16233a', color: '#cbd5e1' }}
          />
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-3">
          {groups.map(([group, list]) => (
            <div key={group} className="mb-3">
              <div className="px-2 pb-1.5 pt-1 font-display text-[10px] uppercase tracking-[0.18em]" style={{ color: '#1f2937' }}>
                {group}
              </div>
              <div className="flex flex-col gap-px">
                {list.map(host => {
                  const isOpen  = openIds.has(host.id)
                  const running = host.status === 'running'
                  return (
                    <div key={host.id} className="group flex items-center rounded transition-colors hover:bg-white/[0.04]"
                      style={active?.host.id === host.id ? { background: '#00e5ff10' } : undefined}>
                      <button onClick={() => open(host)} className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left">
                        <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                          style={{
                            background: running ? '#22c55e' : '#374151',
                            boxShadow:  running ? '0 0 5px #22c55e' : 'none',
                          }} />
                        <span className="flex-1 truncate font-mono text-[12.5px]"
                          style={{ color: active?.host.id === host.id ? ACCENT : running ? '#cbd5e1' : '#4b5563' }}>
                          {host.name}
                        </span>
                        {isOpen && (
                          <span className="flex-shrink-0 rounded px-1 font-mono text-[9px]"
                            style={{ background: '#00e5ff15', color: ACCENT }}>open</span>
                        )}
                        {host.hasCredential && !isOpen && (
                          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="#374151" strokeWidth={1.6}
                            className="flex-shrink-0" aria-label="login saved">
                            <circle cx="6" cy="8" r="3" /><path d="M9 8h5M12 8v2.5" strokeLinecap="round" />
                          </svg>
                        )}
                        <span className="flex-shrink-0 font-mono text-[10px] tabular-nums" style={{ color: '#1f2937' }}>
                          {host.source === 'manual' ? 'ssh' : host.vmid}
                        </span>
                      </button>
                      {host.source === 'manual' && (
                        <button
                          onClick={() => removeHost(host)}
                          title={`Remove ${host.name}`}
                          className="mr-1 hidden h-5 w-5 flex-shrink-0 items-center justify-center rounded group-hover:flex hover:bg-white/10"
                          style={{ color: '#4b5563' }}
                        >
                          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8}>
                            <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                          </svg>
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}

          {!loading && !groups.length && (
            <p className="px-2 py-6 text-center font-mono text-[11px]" style={{ color: '#374151' }}>
              {query ? 'Nothing matches that filter.' : 'No hosts found.'}
            </p>
          )}
        </nav>
      </aside>

      {/* ---- Panes ---------------------------------------------------------- */}
      <section className="flex min-w-0 flex-1 flex-col">
        {/* Tab bar */}
        {sessions.length > 0 && (
          <div className="flex flex-shrink-0 items-stretch overflow-x-auto border-b"
            style={{ borderColor: BORDER, background: '#060a10' }}>
            {sessions.map(sess => {
              const isActive = sess.key === activeKey
              const st = STATE_STYLE[sess.state]
              return (
                <div key={sess.key}
                  className="group flex flex-shrink-0 items-center gap-2 border-r pl-3 pr-1.5 transition-colors"
                  style={{
                    borderColor: BORDER,
                    background:  isActive ? '#0d1220' : 'transparent',
                    boxShadow:   isActive ? `inset 0 -2px 0 ${ACCENT}` : 'none',
                  }}>
                  <button onClick={() => setActiveKey(sess.key)} className="flex items-center gap-2 py-2">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: st.dot }} />
                    <span className="font-mono text-[12px]" style={{ color: isActive ? ACCENT : '#6b7280' }}>
                      {sess.host.name}
                    </span>
                  </button>
                  <button onClick={() => closeSession(sess.key)} title="Close this pane"
                    className="flex h-5 w-5 items-center justify-center rounded opacity-0 transition-opacity hover:bg-white/10 group-hover:opacity-100"
                    style={{ color: '#4b5563' }}>
                    <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              )
            })}
          </div>
        )}

        {/* Header for the active pane */}
        <header className="flex flex-shrink-0 items-center gap-3 border-b px-4"
          style={{ height: 52, borderColor: BORDER, background: '#0a0f18' }}>
          {active && s ? (
            <>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="truncate font-display text-[15px] font-semibold tracking-wide text-white">{active.host.name}</span>
                  <span className="font-mono text-[11px]" style={{ color: '#374151' }}>
                    {active.address}:{active.port}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 pt-0.5">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.dot }} />
                  <span className="font-mono text-[11px]" style={{ color: s.color }}>{s.label}</span>
                  {active.detail && <span className="font-mono text-[11px]" style={{ color: '#374151' }}>· {active.detail}</span>}
                </div>
              </div>

              <div className="ml-auto flex items-center gap-2">
                {active.attach && (
                  <span className="rounded px-2 py-1 font-mono text-[10.5px]"
                    style={active.attach.persistent
                      ? { background: '#00e5ff12', color: ACCENT,   border: '1px solid #00e5ff28' }
                      : { background: '#f59e0b12', color: '#f59e0b', border: '1px solid #f59e0b28' }}
                    title={active.attach.persistent
                      ? 'The shell runs in tmux on the host. Close this tab and it keeps running.'
                      : 'tmux is not installed on this host, so closing this pane ends the session.'}>
                    {active.attach.persistent ? `tmux · ${active.attach.session}` : 'not persistent'}
                  </span>
                )}
                <button onClick={() => forgetHostKey(active)}
                  title="Clear the pinned host key — do this only when the guest was genuinely rebuilt"
                  className="rounded border px-2.5 py-1 font-display text-xs tracking-wide transition-colors hover:bg-white/5"
                  style={{ borderColor: '#16233a', color: '#6b7280' }}>
                  Clear host key
                </button>
                <button onClick={() => forgetCredential(active.host)}
                  className="rounded border px-2.5 py-1 font-display text-xs tracking-wide transition-colors hover:bg-white/5"
                  style={{ borderColor: '#16233a', color: '#6b7280' }}>
                  Forget login
                </button>
                <button onClick={() => setCredentialFor(active.host)}
                  className="rounded border px-2.5 py-1 font-display text-xs tracking-wide transition-colors hover:bg-white/5"
                  style={{ borderColor: '#16233a', color: '#6b7280' }}>
                  Change login
                </button>
                <button onClick={() => patch(active.key, { attempt: active.attempt + 1, attach: null })}
                  className="rounded px-3 py-1 font-display text-xs font-semibold tracking-wide transition-opacity hover:opacity-85"
                  style={{ background: '#00e5ff15', color: ACCENT, border: '1px solid #00e5ff30' }}>
                  Reconnect
                </button>
              </div>
            </>
          ) : (
            <span className="font-mono text-[12px]" style={{ color: '#374151' }}>Pick a host to open a terminal</span>
          )}
        </header>

        {active?.attach?.hostKeyLearned && (
          <div className="flex-shrink-0 border-b px-4 py-2 font-mono text-[11px]"
            style={{ borderColor: BORDER, background: '#0b1420', color: '#6b7280' }}>
            First connection to this host — its key is now pinned as{' '}
            <span style={{ color: '#9ca3af' }}>{active.attach.fingerprint}</span>. A change will be refused.
          </div>
        )}

        {notice && (
          <div className="flex flex-shrink-0 items-center gap-3 border-b px-4 py-2 font-mono text-[11px]"
            style={{ borderColor: BORDER, background: '#0b1420', color: '#9ca3af' }}>
            <span className="flex-1">{notice}</span>
            <button onClick={() => setNotice(null)} style={{ color: '#4b5563' }}>dismiss</button>
          </div>
        )}

        {/* Every open pane stays mounted; only the active one is shown. */}
        <div className="relative flex flex-1 flex-col" style={{ minHeight: 0, background: '#080c14' }}>
          {/* Inline display beats the utility class here: Tailwind's .flex would
              otherwise override [hidden]{display:none} and stack every pane on
              top of the active one. */}
          {sessions.map(sess => (
            <div
              key={sess.key}
              className="absolute inset-0 flex-col"
              style={{ display: sess.key === activeKey ? 'flex' : 'none' }}
            >
              <TerminalPane
                host={sess.address}
                hostId={sess.host.id}
                port={sess.port}
                attempt={sess.attempt}
                onState={(state, detail) => patch(sess.key, { state, detail })}
                onAttach={attach => patch(sess.key, { attach })}
              />
            </div>
          ))}

          {!sessions.length && (
            <div className="flex flex-1 items-center justify-center">
              <div className="max-w-sm px-6 text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded border"
                  style={{ borderColor: '#16233a', color: '#1f2937' }}>
                  <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4}>
                    <rect x="1" y="2.5" width="14" height="11" rx="1.5" />
                    <path d="M4 6.5l2 1.75-2 1.75M8 10.5h4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <p className="font-display text-sm tracking-wide" style={{ color: '#6b7280' }}>
                  Every guest on the cluster is already listed.
                </p>
                <p className="mt-1.5 font-mono text-[11px] leading-relaxed" style={{ color: '#374151' }}>
                  Pick one to open a terminal. Open as many as you like — panes stay
                  connected in the background, and the work runs in tmux on the host.
                </p>
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
      {addingHost && <AddHostDialog onSave={addHost} onClose={() => setAddingHost(false)} />}
    </div>
  )
}
