'use client'

// =============================================================================
//  HyperProx — Plug-ins
//
//  A gallery, not a settings table. Each card carries the plug-in's own live
//  output, so you can see what it renders before you place it anywhere — and
//  so a plug-in that is quietly returning nothing is obvious at a glance rather
//  than after you have wired it into a pane.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

interface PluginSetting {
  key: string; label: string; type: 'text' | 'secret' | 'url'
  required: boolean; hint?: string; value: string; isSet: boolean
}

interface PluginCard {
  id: string; name: string; description: string
  kind: 'tile' | 'device'; icon: string
  settings: PluginSetting[]; configured: boolean; missing: string[]
  hasDetail: boolean
}

interface TileData {
  ok: boolean; error?: string; headline?: string
  tone?: 'good' | 'warn' | 'bad'
  rows?: Array<{ label: string; value: string; tone?: 'good' | 'warn' | 'bad' }>
}

const ACCENT = '#00e5ff'
const BORDER = '#0f1929'
const PANEL  = '#0d1220'

// Semantic colour, kept separate from the accent so "healthy" never reads as
// "selected" and vice versa.
const TONE: Record<string, string> = {
  good: '#22c55e', warn: '#f59e0b', bad: '#ef4444', idle: '#4b5563',
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1.5 block font-display text-[11px] uppercase tracking-[0.14em]" style={{ color: '#6b7280' }}>
      {children}
    </span>
  )
}

// ---------------------------------------------------------------------------
//  Live output, rendered exactly as a pane tile would render it
// ---------------------------------------------------------------------------

function Preview({ data, loading }: { data?: TileData; loading: boolean }) {
  if (loading) {
    return (
      <div className="flex h-[132px] items-center justify-center rounded border font-mono text-[11px]"
        style={{ borderColor: BORDER, background: '#080c14', color: '#374151' }}>
        reading…
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex h-[132px] items-center justify-center rounded border border-dashed font-mono text-[11px]"
        style={{ borderColor: '#16233a', background: '#080c14', color: '#374151' }}>
        no reading yet
      </div>
    )
  }

  if (!data.ok) {
    return (
      <div className="flex h-[132px] flex-col justify-center gap-1.5 rounded border px-3.5"
        style={{ borderColor: '#7f1d1d55', background: '#12080b' }}>
        <span className="font-display text-[11px] uppercase tracking-[0.14em]" style={{ color: TONE.bad }}>
          not reporting
        </span>
        <span className="font-mono text-[11px] leading-relaxed" style={{ color: '#9ca3af' }}>
          {data.error}
        </span>
      </div>
    )
  }

  const tone = TONE[data.tone ?? 'good']
  return (
    <div className="flex h-[132px] flex-col rounded border px-3.5 py-3"
      style={{ borderColor: BORDER, background: '#080c14' }}>
      <div className="flex items-baseline gap-2">
        <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
          style={{ background: tone, boxShadow: `0 0 6px ${tone}` }} />
        <span className="truncate font-display text-[15px] font-semibold tracking-wide text-white">
          {data.headline}
        </span>
      </div>

      <div className="mt-2 flex flex-col gap-1 overflow-hidden">
        {(data.rows ?? []).slice(0, 4).map((r, i) => (
          <div key={i} className="flex items-baseline gap-2 font-mono text-[11px]">
            <span className="w-[92px] flex-shrink-0 truncate" style={{ color: '#4b5563' }}>{r.label}</span>
            <span className="truncate tabular-nums" style={{ color: r.tone ? TONE[r.tone] : '#9ca3af' }}>
              {r.value}
            </span>
          </div>
        ))}
        {!data.rows?.length && (
          <span className="font-mono text-[11px]" style={{ color: '#374151' }}>nothing to report</span>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
//  Settings — the form is generated from what the plug-in declares
// ---------------------------------------------------------------------------

function SettingsDialog({ plugin, onSave, onClose }: {
  plugin: PluginCard
  onSave: (values: Record<string, string>) => void
  onClose: () => void
}) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(plugin.settings.map(s => [s.key, s.type === 'secret' ? '' : s.value])),
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'rgba(4,7,12,0.78)' }}>
      <form
        onSubmit={e => { e.preventDefault(); onSave(values) }}
        className="w-full max-w-md rounded-lg border shadow-2xl"
        style={{ background: PANEL, borderColor: BORDER }}
      >
        <div className="flex items-center gap-3 border-b px-5 py-3.5" style={{ borderColor: BORDER }}>
          <span className="flex h-8 w-8 items-center justify-center rounded border text-base"
            style={{ borderColor: '#16233a', background: '#080c14' }}>{plugin.icon}</span>
          <div>
            <h2 className="font-display text-base font-semibold tracking-wide text-white">{plugin.name}</h2>
            <p className="font-mono text-[11px]" style={{ color: '#6b7280' }}>
              Stored encrypted. Secrets are never sent back here.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3.5 px-5 py-4">
          {plugin.settings.map(s => (
            <div key={s.key}>
              <Label>{s.label}{!s.required && <span style={{ color: '#374151' }}> · optional</span>}</Label>
              <input
                type={s.type === 'secret' ? 'password' : 'text'}
                value={values[s.key] ?? ''}
                onChange={e => setValues(v => ({ ...v, [s.key]: e.target.value }))}
                required={s.required && !(s.type === 'secret' && s.isSet)}
                placeholder={s.type === 'secret' && s.isSet ? '•••••••• — leave blank to keep' : ''}
                autoComplete="off"
                className="w-full rounded border px-2.5 py-1.5 font-mono text-[13px] outline-none transition-colors focus:border-cyan"
                style={{ background: '#080c14', borderColor: '#16233a', color: '#e2e8f0' }}
              />
              {s.hint && (
                <p className="mt-1 font-mono text-[10.5px] leading-relaxed" style={{ color: '#374151' }}>{s.hint}</p>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2 border-t px-5 py-3" style={{ borderColor: BORDER }}>
          <button type="button" onClick={onClose}
            className="rounded px-3 py-1.5 font-display text-sm tracking-wide transition-colors hover:bg-white/5"
            style={{ color: '#9ca3af' }}>Cancel</button>
          <button type="submit"
            className="rounded px-4 py-1.5 font-display text-sm font-semibold tracking-wide transition-opacity hover:opacity-85"
            style={{ background: ACCENT, color: '#04202a' }}>Save and test</button>
        </div>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------

export default function PluginsPage() {
  const [plugins, setPlugins] = useState<PluginCard[]>([])
  const [data,    setData]    = useState<Record<string, TileData>>({})
  const [busy,    setBusy]    = useState<Record<string, boolean>>({})
  const [editing, setEditing] = useState<PluginCard | null>(null)
  const [notice,  setNotice]  = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const readOne = useCallback(async (id: string) => {
    setBusy(b => ({ ...b, [id]: true }))
    try {
      const res = await fetch(`/api/plugins/${id}/data`).then(r => r.json())
      setData(d => ({ ...d, [id]: res.success ? res.data : { ok: false, error: res.error } }))
    } catch (e: any) {
      setData(d => ({ ...d, [id]: { ok: false, error: e.message } }))
    } finally {
      setBusy(b => ({ ...b, [id]: false }))
    }
  }, [])

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/plugins').then(r => r.json())
      if (!res.success) throw new Error(res.error)
      setPlugins(res.data)
      res.data.filter((p: PluginCard) => p.configured).forEach((p: PluginCard) => readOne(p.id))
    } catch (e: any) {
      setNotice(e.message)
    } finally {
      setLoading(false)
    }
  }, [readOne])

  useEffect(() => { load() }, [load])

  const save = async (values: Record<string, string>) => {
    const p = editing!
    setEditing(null)
    const res = await fetch(`/api/plugins/${p.id}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    }).then(r => r.json())
    if (!res.success) return setNotice(res.error)
    await load()
    readOne(p.id)
  }

  return (
    <div className="flex h-full flex-col" style={{ background: '#080c14' }}>
      <header className="flex flex-shrink-0 items-baseline gap-3 border-b px-6"
        style={{ height: 56, borderColor: BORDER, background: '#0a0f18' }}>
        <h1 className="font-display text-lg font-light tracking-[0.18em] text-white">PLUG-INS</h1>
        <p className="font-mono text-[11px]" style={{ color: '#374151' }}>
          {loading ? 'loading…' : `${plugins.filter(p => p.configured).length} of ${plugins.length} configured`}
        </p>
      </header>

      {notice && (
        <div className="flex flex-shrink-0 items-center gap-3 border-b px-6 py-2 font-mono text-[11px]"
          style={{ borderColor: BORDER, background: '#0b1420', color: '#9ca3af' }}>
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} style={{ color: '#4b5563' }}>dismiss</button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <p className="mb-5 max-w-2xl font-mono text-[11.5px] leading-relaxed" style={{ color: '#4b5563' }}>
          Plug-ins never see a credential. They declare what they need, and HyperProx makes the
          call on their behalf — so a plug-in can read its own device and nothing else.
        </p>

        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
          {plugins.map(p => {
            const d    = data[p.id]
            const tone = !p.configured ? 'idle' : d && !d.ok ? 'bad' : d ? (d.tone ?? 'good') : 'idle'
            return (
              <article key={p.id} className="relative overflow-hidden rounded-lg border"
                style={{ background: PANEL, borderColor: BORDER }}>
                {/* Severity stripe — state readable before any text is parsed. */}
                <span className="absolute left-0 top-0 h-full w-[2px]" style={{ background: TONE[tone] }} />

                <div className="flex items-start gap-3 px-4 pb-3 pt-4">
                  <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded border text-lg"
                    style={{ borderColor: '#16233a', background: '#080c14' }}>{p.icon}</span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate font-display text-[15px] font-semibold tracking-wide text-white">{p.name}</h2>
                      <span className="flex-shrink-0 rounded px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider"
                        style={{ background: '#00e5ff10', color: '#4b5563', border: '1px solid #16233a' }}>
                        {p.kind}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11.5px] leading-snug" style={{ color: '#6b7280' }}>{p.description}</p>
                  </div>
                </div>

                <div className="px-4">
                  {p.configured && p.hasDetail ? (
                    <Link href={`/plugins/${p.id}`} className="block transition-opacity hover:opacity-90">
                      <Preview data={d} loading={!!busy[p.id]} />
                    </Link>
                  ) : (
                    <Preview data={d} loading={!!busy[p.id]} />
                  )}
                </div>

                <div className="mt-3 flex items-center gap-2 border-t px-4 py-2.5" style={{ borderColor: BORDER }}>
                  <span className="font-mono text-[10.5px]" style={{ color: TONE[tone] }}>
                    {!p.configured
                      ? `needs ${p.missing.join(' and ')}`
                      : d && !d.ok ? 'unreachable'
                      : d ? 'connected' : 'idle'}
                  </span>

                  <div className="ml-auto flex items-center gap-2">
                    {p.configured && p.hasDetail && (
                      <Link href={`/plugins/${p.id}`}
                        className="rounded border px-2.5 py-1 font-display text-xs tracking-wide transition-colors hover:bg-white/5"
                        style={{ borderColor: '#16233a', color: ACCENT }}>
                        Open in full
                      </Link>
                    )}
                    {p.configured && (
                      <button onClick={() => readOne(p.id)} disabled={busy[p.id]}
                        className="rounded border px-2.5 py-1 font-display text-xs tracking-wide transition-colors hover:bg-white/5 disabled:opacity-40"
                        style={{ borderColor: '#16233a', color: '#6b7280' }}>
                        Refresh
                      </button>
                    )}
                    <button onClick={() => setEditing(p)}
                      className="rounded px-3 py-1 font-display text-xs font-semibold tracking-wide transition-opacity hover:opacity-85"
                      style={p.configured
                        ? { background: '#00e5ff12', color: ACCENT, border: '1px solid #00e5ff30' }
                        : { background: ACCENT, color: '#04202a', border: '1px solid transparent' }}>
                      {p.configured ? 'Settings' : 'Set up'}
                    </button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      </div>

      {editing && <SettingsDialog plugin={editing} onSave={save} onClose={() => setEditing(null)} />}
    </div>
  )
}
