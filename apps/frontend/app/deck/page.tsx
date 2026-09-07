'use client'

// =============================================================================
//  HyperProx — Deck
//  A terminal for every host on the cluster, plus anything else you add.
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import { DeckTerminal, type PaneState } from '@/components/deck/DeckTerminal'
import { AddHostDialog, ConnectDialog, type CredentialDraft } from '@/components/deck/DeckDialogs'

interface DeckHost {
  id: string; name: string; vmid: number; node: string
  type: 'lxc' | 'qemu' | 'manual'; status: string
  ip: string | null; port?: number; hasCredential: boolean
  source: 'cluster' | 'manual'
}

interface AttachInfo {
  persistent: boolean; session?: string
  hostKeyLearned?: boolean; fingerprint?: string
}

const BORDER = '#0f1929'
const ACCENT = '#00e5ff'

const STATE_STYLE: Record<PaneState, { label: string; color: string; dot: string }> = {
  idle:       { label: 'No session',  color: '#4b5563', dot: '#374151' },
  connecting: { label: 'Connecting',  color: '#f59e0b', dot: '#f59e0b' },
  ready:      { label: 'Connected',   color: '#22c55e', dot: '#22c55e' },
  closed:     { label: 'Disconnected',color: '#6b7280', dot: '#4b5563' },
  error:      { label: 'Failed',      color: '#ef4444', dot: '#ef4444' },
}

export default function DeckPage() {
  const [hosts,    setHosts]    = useState<DeckHost[]>([])
  const [loading,  setLoading]  = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query,    setQuery]    = useState('')

  const [active,   setActive]   = useState<DeckHost | null>(null)
  const [attempt,  setAttempt]  = useState(0)
  const [state,    setState]    = useState<PaneState>('idle')
  const [detail,   setDetail]   = useState<string | undefined>()
  const [attach,   setAttach]   = useState<AttachInfo | null>(null)
  const [hasShared, setHasShared] = useState(false)

  const [credentialFor, setCredentialFor] = useState<DeckHost | null>(null)
  const [addingHost,    setAddingHost]    = useState(false)

  // -- Load -------------------------------------------------------------------
  const load = useCallback(async () => {
    try {
      const [hostRes, credRes] = await Promise.all([
        fetch('/api/deck/hosts').then(r => r.json()),
        fetch('/api/deck/credentials').then(r => r.json()),
      ])
      if (!hostRes.success) throw new Error(hostRes.error ?? 'The host list could not be loaded')
      setHosts(hostRes.data)
      setHasShared(!!credRes?.data?.shared)
      setLoadError(null)
    } catch (e: any) {
      setLoadError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // -- Actions ----------------------------------------------------------------
  const open = (host: DeckHost) => {
    if (!host.hasCredential || !host.ip) return setCredentialFor(host)
    setActive(host); setAttach(null); setDetail(undefined); setAttempt(a => a + 1)
  }

  const saveCredential = async (draft: CredentialDraft, address: string) => {
    const host = credentialFor!
    const res = await fetch(`/api/deck/credentials/${encodeURIComponent(host.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...draft, port: draft.port }),
    }).then(r => r.json())

    if (!res.success) return setLoadError(res.error)

    setCredentialFor(null)
    await load()
    const connected: DeckHost = { ...host, ip: address, port: draft.port, hasCredential: true }
    setActive(connected); setAttach(null); setAttempt(a => a + 1)
  }

  const addHost = async (h: { name: string; address: string; port: number }) => {
    const res = await fetch('/api/deck/manual-hosts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(h),
    }).then(r => r.json())
    setAddingHost(false)
    if (!res.success) return setLoadError(res.error)
    await load()
  }

  const onState  = useCallback((s: PaneState, d?: string) => { setState(s); setDetail(d) }, [])
  const onAttach = useCallback((info: AttachInfo) => setAttach(info), [])

  // -- Grouping ---------------------------------------------------------------
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = hosts.filter(h =>
      !q || h.name.toLowerCase().includes(q) || String(h.vmid).includes(q) || (h.ip ?? '').includes(q))

    const byGroup = new Map<string, DeckHost[]>()
    for (const h of filtered) {
      const key = h.source === 'manual' ? 'Added by hand' : h.node
      if (!byGroup.has(key)) byGroup.set(key, [])
      byGroup.get(key)!.push(h)
    }
    return [...byGroup.entries()].sort((a, b) =>
      a[0] === 'Added by hand' ? 1 : b[0] === 'Added by hand' ? -1 : a[0].localeCompare(b[0]))
  }, [hosts, query])

  const s = STATE_STYLE[state]

  return (
    <div className="flex h-full">
      {/* ---- Host rail ------------------------------------------------------ */}
      <aside className="flex w-[264px] flex-shrink-0 flex-col border-r" style={{ background: '#060a10', borderColor: BORDER }}>
        <div className="flex flex-shrink-0 items-center justify-between border-b px-4" style={{ height: 56, borderColor: BORDER }}>
          <div>
            <h1 className="font-display text-lg font-light tracking-[0.18em] text-white">DECK</h1>
            <p className="font-mono text-[10px]" style={{ color: '#374151' }}>
              {loading ? 'loading…' : `${hosts.length} hosts`}
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
                  const isActive = active?.id === host.id
                  const running  = host.status === 'running'
                  return (
                    <button
                      key={host.id}
                      onClick={() => open(host)}
                      className="group flex items-center gap-2.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
                      style={isActive ? { background: '#00e5ff10' } : undefined}
                    >
                      <span
                        className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                        style={{
                          background: running ? '#22c55e' : '#374151',
                          boxShadow:  running ? '0 0 5px #22c55e' : 'none',
                        }}
                      />
                      <span
                        className="flex-1 truncate font-mono text-[12.5px]"
                        style={{ color: isActive ? ACCENT : running ? '#cbd5e1' : '#4b5563' }}
                      >
                        {host.name}
                      </span>
                      {host.hasCredential && (
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="#374151" strokeWidth={1.6}
                          className="flex-shrink-0" aria-label="login saved">
                          <circle cx="6" cy="8" r="3" /><path d="M9 8h5M12 8v2.5" strokeLinecap="round" />
                        </svg>
                      )}
                      <span className="flex-shrink-0 font-mono text-[10px] tabular-nums" style={{ color: '#1f2937' }}>
                        {host.source === 'manual' ? 'ssh' : host.vmid}
                      </span>
                    </button>
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

      {/* ---- Pane ----------------------------------------------------------- */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex flex-shrink-0 items-center gap-3 border-b px-4"
          style={{ height: 56, borderColor: BORDER, background: '#0a0f18' }}
        >
          {active ? (
            <>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="truncate font-display text-[15px] font-semibold tracking-wide text-white">{active.name}</span>
                  <span className="font-mono text-[11px]" style={{ color: '#374151' }}>
                    {active.ip}:{active.port ?? 22}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 pt-0.5">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.dot }} />
                  <span className="font-mono text-[11px]" style={{ color: s.color }}>{s.label}</span>
                  {detail && <span className="font-mono text-[11px]" style={{ color: '#374151' }}>· {detail}</span>}
                </div>
              </div>

              <div className="ml-auto flex items-center gap-2">
                {attach && (
                  <span
                    className="rounded px-2 py-1 font-mono text-[10.5px]"
                    style={attach.persistent
                      ? { background: '#00e5ff12', color: ACCENT,   border: '1px solid #00e5ff28' }
                      : { background: '#f59e0b12', color: '#f59e0b', border: '1px solid #f59e0b28' }}
                    title={attach.persistent
                      ? 'The shell runs in tmux on the host. Close this tab and it keeps running.'
                      : 'tmux is not installed on this host, so closing this tab ends the session.'}
                  >
                    {attach.persistent ? `tmux · ${attach.session}` : 'not persistent'}
                  </span>
                )}
                <button
                  onClick={() => setCredentialFor(active)}
                  className="rounded border px-2.5 py-1 font-display text-xs tracking-wide transition-colors hover:bg-white/5"
                  style={{ borderColor: '#16233a', color: '#6b7280' }}
                >
                  Change login
                </button>
                <button
                  onClick={() => setAttempt(a => a + 1)}
                  className="rounded px-3 py-1 font-display text-xs font-semibold tracking-wide transition-opacity hover:opacity-85"
                  style={{ background: '#00e5ff15', color: ACCENT, border: '1px solid #00e5ff30' }}
                >
                  Reconnect
                </button>
              </div>
            </>
          ) : (
            <span className="font-mono text-[12px]" style={{ color: '#374151' }}>Pick a host to open a terminal</span>
          )}
        </header>

        {attach?.hostKeyLearned && (
          <div className="flex-shrink-0 border-b px-4 py-2 font-mono text-[11px]"
            style={{ borderColor: BORDER, background: '#0b1420', color: '#6b7280' }}>
            First connection to this host — its key is now pinned as{' '}
            <span style={{ color: '#9ca3af' }}>{attach.fingerprint}</span>. A change will be refused.
          </div>
        )}

        {loadError && (
          <div className="flex-shrink-0 border-b px-4 py-2 font-mono text-[11px]"
            style={{ borderColor: '#7f1d1d', background: '#1a0d10', color: '#fca5a5' }}>
            {loadError}
          </div>
        )}

        {active ? (
          <DeckTerminal
            key={active.id}
            host={active.ip!}
            hostId={active.id}
            port={active.port ?? 22}
            attempt={attempt}
            onState={onState}
            onAttach={onAttach}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center" style={{ background: '#080c14' }}>
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
                Pick one to open a terminal. Sessions run in tmux on the host, so
                closing the tab leaves the work running.
              </p>
            </div>
          </div>
        )}
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
