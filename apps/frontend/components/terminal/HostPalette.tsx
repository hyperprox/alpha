'use client'

// =============================================================================
//  HyperProx — the host palette
//
//  Replaces a permanent second column down the left edge. A terminal wants
//  width, and a list of hosts is only needed at the moment you open one — so it
//  is summoned, used, and dismissed, the way a command palette is.
//
//  Keyboard first, because the mouse path already exists: type to narrow,
//  arrows to move, Enter to open, Escape to leave.
// =============================================================================

import { useEffect, useMemo, useRef, useState } from 'react'

const ACCENT = 'var(--accent)'

export interface PaletteHost {
  id: string
  name: string
  vmid: number
  node: string
  type: 'lxc' | 'qemu' | 'manual'
  status: string
  ip: string | null
  port?: number
  hasCredential: boolean
  source: 'cluster' | 'manual' | 'plugin'
  hint?: string
}

export function HostPalette({
  hosts, openIds, activeHostId, loading, onOpen, onRemove, onAddManual, onClose,
}: {
  hosts: PaletteHost[]
  openIds: Set<string>
  activeHostId?: string | null
  loading: boolean
  onOpen: (host: PaletteHost) => void
  onRemove: (host: PaletteHost) => void
  onAddManual: () => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef  = useRef<HTMLDivElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = hosts.filter(h =>
      !q || h.name.toLowerCase().includes(q) || String(h.vmid).includes(q) || (h.ip ?? '').includes(q))

    const byGroup = new Map<string, PaletteHost[]>()
    for (const h of filtered) {
      const k = h.source === 'manual' ? 'Added by hand'
              : h.source === 'plugin' ? 'From plug-ins'
              : h.node
      if (!byGroup.has(k)) byGroup.set(k, [])
      byGroup.get(k)!.push(h)
    }
    const last = (k: string) => k === 'Added by hand' ? 2 : k === 'From plug-ins' ? 1 : 0
    return [...byGroup.entries()].sort((a, b) => last(a[0]) - last(b[0]) || a[0].localeCompare(b[0]))
  }, [hosts, query])

  // One flat order for the keyboard, matching what is rendered — a cursor over
  // the grouped structure would skip or repeat rows at every group boundary.
  const flat = useMemo(() => groups.flatMap(([, list]) => list), [groups])

  useEffect(() => { setCursor(0) }, [query])

  // Follow the cursor, but only when it has actually left the viewport —
  // scrolling on every keystroke fights the mouse.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape')    { e.preventDefault(); onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, flat.length - 1)); return }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); return }
    if (e.key === 'Enter')     {
      e.preventDefault()
      const host = flat[cursor]
      if (host) { onOpen(host); onClose() }
    }
  }

  let idx = -1

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]"
      style={{ background: 'rgba(3,6,12,0.72)', backdropFilter: 'blur(2px)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="flex w-full max-w-lg flex-col overflow-hidden rounded-xl border shadow-2xl"
        style={{ background: 'var(--surface-raised)', borderColor: 'var(--border-strong)', maxHeight: '70vh' }}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-3 border-b px-4" style={{ height: 52, borderColor: 'var(--border-dim)' }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--text-dimmer)" strokeWidth={1.6} className="flex-shrink-0">
            <circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Open a terminal — filter by name, id or address"
            className="w-full bg-transparent font-mono text-[13px] outline-none"
            style={{ color: 'var(--text)' }}
          />
          <span className="flex-shrink-0 font-mono text-[10px]" style={{ color: 'var(--text-faint)' }}>
            {loading ? 'loading…' : `${flat.length} of ${hosts.length}`}
          </span>
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto px-2 py-2">
          {groups.map(([group, list]) => (
            <div key={group} className="mb-2">
              <div className="px-2 pb-1 pt-1 font-display text-[10px] uppercase tracking-[0.18em]" style={{ color: 'var(--text-faint)' }}>
                {group}
              </div>
              <div className="flex flex-col gap-px">
                {list.map(host => {
                  idx += 1
                  const here    = idx
                  const isOpen  = openIds.has(host.id)
                  const running = host.status === 'running'
                  const onCursor = here === cursor
                  return (
                    <div
                      key={host.id}
                      data-idx={here}
                      onMouseEnter={() => setCursor(here)}
                      className="group flex items-center rounded"
                      style={{ background: onCursor ? 'color-mix(in srgb, var(--accent) 7%, transparent)' : 'transparent' }}
                    >
                      <button
                        onClick={() => { onOpen(host); onClose() }}
                        title={host.hint}
                        className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left"
                      >
                        <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                          style={{ background: running ? 'var(--good)' : 'var(--text-dimmer)', boxShadow: running ? '0 0 5px var(--good)' : 'none' }} />
                        <span className="flex-1 truncate font-mono text-[12.5px]"
                          style={{ color: onCursor || activeHostId === host.id ? ACCENT : running ? 'var(--text)' : 'var(--text-dim)' }}>
                          {host.name}
                        </span>
                        {host.ip && (
                          <span className="flex-shrink-0 truncate font-mono text-[10px] tabular-nums" style={{ color: 'var(--text-dimmest)', maxWidth: 120 }}>
                            {host.ip}
                          </span>
                        )}
                        {isOpen && (
                          <span className="flex-shrink-0 rounded px-1 font-mono text-[9px]"
                            style={{ background: 'color-mix(in srgb, var(--accent) 8%, transparent)', color: ACCENT }}>open</span>
                        )}
                        {host.hasCredential && !isOpen && (
                          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="var(--text-dimmer)" strokeWidth={1.6}
                            className="flex-shrink-0" aria-label="login saved">
                            <circle cx="6" cy="8" r="3" /><path d="M9 8h5M12 8v2.5" strokeLinecap="round" />
                          </svg>
                        )}
                        <span className="flex-shrink-0 font-mono text-[10px] tabular-nums" style={{ color: 'var(--text-faint)' }}>
                          {host.source === 'cluster' ? host.vmid : 'ssh'}
                        </span>
                      </button>
                      {host.source === 'manual' && (
                        <button
                          onClick={() => onRemove(host)}
                          title={`Remove ${host.name}`}
                          className="mr-1 hidden h-5 w-5 flex-shrink-0 items-center justify-center rounded group-hover:flex hover:bg-white/10"
                          style={{ color: 'var(--text-dim)' }}
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

          {!loading && !flat.length && (
            <p className="px-2 py-8 text-center font-mono text-[11px]" style={{ color: 'var(--text-dimmer)' }}>
              {query ? 'Nothing matches that filter.' : 'No hosts found.'}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 border-t px-4 py-2" style={{ borderColor: 'var(--border-dim)', background: 'var(--ground)' }}>
          <span className="font-mono text-[10px]" style={{ color: 'var(--text-dimmest)' }}>↑↓ move · ↵ open · esc close</span>
          <button
            onClick={() => { onClose(); onAddManual() }}
            className="ml-auto rounded border px-2.5 py-1 font-display text-[11px] tracking-wide transition-colors hover:bg-white/5"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-muted)' }}
          >
            + Add a host by hand
          </button>
        </div>
      </div>
    </div>
  )
}
