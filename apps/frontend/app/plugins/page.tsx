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

interface Finding {
  pluginId: string; setting: string; label: string
  address: string; source: string; needs: string[]
}

interface TileData {
  ok: boolean; error?: string; headline?: string
  tone?: 'good' | 'warn' | 'bad'
  rows?: Array<{ label: string; value: string; tone?: 'good' | 'warn' | 'bad' }>
}

const ACCENT = 'var(--accent)'
const BORDER = 'var(--border)'
const PANEL  = 'var(--surface)'

// Semantic colour, kept separate from the accent so "healthy" never reads as
// "selected" and vice versa.
const TONE: Record<string, string> = {
  good: 'var(--good)', warn: 'var(--warn)', bad: 'var(--crit)', idle: 'var(--text-dim)',
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-muted)' }}>
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
        style={{ borderColor: BORDER, background: 'var(--ground)', color: 'var(--text-dimmer)' }}>
        reading…
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex h-[132px] items-center justify-center rounded border border-dashed font-mono text-[11px]"
        style={{ borderColor: 'var(--border-strong)', background: 'var(--ground)', color: 'var(--text-dimmer)' }}>
        no reading yet
      </div>
    )
  }

  if (!data.ok) {
    return (
      <div className="flex h-[132px] flex-col justify-center gap-1.5 rounded border px-3.5"
        style={{ borderColor: 'color-mix(in srgb, var(--crit) 33%, transparent)', background: 'var(--ground)' }}>
        <span className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: TONE.bad }}>
          not reporting
        </span>
        <span className="text-sm leading-relaxed" style={{ color: 'var(--text-soft)' }}>
          {data.error}
        </span>
      </div>
    )
  }

  const tone = TONE[data.tone ?? 'good']
  return (
    <div className="flex h-[132px] flex-col rounded border px-3.5 py-3"
      style={{ borderColor: BORDER, background: 'var(--ground)' }}>
      <div className="flex items-baseline gap-2">
        <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
          style={{ background: tone, boxShadow: `0 0 6px ${tone}` }} />
        <span className="truncate text-[15px] font-semibold" style={{ color: 'var(--text-bright)' }}>
          {data.headline}
        </span>
      </div>

      <div className="mt-2 flex flex-col gap-1 overflow-hidden">
        {(data.rows ?? []).slice(0, 4).map((r, i) => (
          <div key={i} className="flex items-baseline gap-2 font-mono text-xs">
            <span className="w-[92px] flex-shrink-0 truncate" style={{ color: 'var(--text-dim)' }}>{r.label}</span>
            <span className="truncate tabular-nums" style={{ color: r.tone ? TONE[r.tone] : 'var(--text-soft)' }}>
              {r.value}
            </span>
          </div>
        ))}
        {!data.rows?.length && (
          <span className="text-sm" style={{ color: 'var(--text-dimmer)' }}>nothing to report</span>
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
        style={{ background: PANEL, borderColor: 'var(--border-soft)' }}
      >
        <div className="flex items-center gap-3 border-b px-6 py-4" style={{ borderColor: BORDER }}>
          <span className="flex h-8 w-8 items-center justify-center rounded border text-base"
            style={{ borderColor: 'var(--border-strong)', background: 'var(--ground)' }}>{plugin.icon}</span>
          <div>
            <h2 className="font-display text-[20px] font-semibold" style={{ color: 'var(--text-bright)' }}>{plugin.name}</h2>
            <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
              Stored encrypted. Secrets are never sent back here.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-4 px-6 py-5">
          {plugin.settings.map(s => (
            <div key={s.key}>
              <Label>{s.label}{!s.required && <span style={{ color: 'var(--text-dimmer)' }}> · optional</span>}</Label>
              <input
                type={s.type === 'secret' ? 'password' : 'text'}
                value={values[s.key] ?? ''}
                onChange={e => setValues(v => ({ ...v, [s.key]: e.target.value }))}
                required={s.required && !(s.type === 'secret' && s.isSet)}
                placeholder={s.type === 'secret' && s.isSet ? '•••••••• — leave blank to keep' : ''}
                autoComplete="off"
                className="h-10 w-full rounded-md border px-3 text-[14px] outline-none transition-colors focus:border-cyan"
                style={{ background: 'var(--ground-deep)', borderColor: 'var(--border-strong)', color: 'var(--text-bright)' }}
              />
              {s.hint && (
                <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-dimmer)' }}>{s.hint}</p>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2 border-t px-6 py-4" style={{ borderColor: BORDER }}>
          <button type="button" onClick={onClose}
            className="h-10 rounded-md border px-5 text-sm transition-colors hover:bg-white/5"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text)', background: 'transparent' }}>Cancel</button>
          <button type="submit"
            className="h-10 rounded-md px-5 text-sm font-semibold transition-opacity hover:opacity-85"
            style={{ background: ACCENT, color: 'var(--accent-ink)', border: 'none' }}>Save and test</button>
        </div>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------

interface PluginIdea {
  slug: string; name: string; would: string; category: string; api?: string
}

/**
 * A pre-filled issue on GitHub, opened in the user's own browser.
 *
 * Deliberately not posted by the server: HyperProx holds no GitHub token, so a
 * request arrives under the name of the person who wants it, and no installation
 * has to store a credential for a button to work.
 */
function requestUrl(repo: string, idea?: PluginIdea): string {
  const title = idea ? `Plug-in request: ${idea.name}` : 'Plug-in request: '
  const body = [
    `**What it should talk to:** ${idea?.name ?? ''}`,
    idea?.api ? `**API:** ${idea.api}` : '**API:** ',
    '',
    '**What I would want it to show**',
    idea?.would ?? '',
    '',
    '**How I run it** — version, how it is deployed, anything unusual:',
    '',
    '',
    '---',
    'Sent from the HyperProx plug-in catalogue.',
  ].join('\n')
  return `https://github.com/${repo}/issues/new` +
         `?labels=${encodeURIComponent('plug-in request')}` +
         `&title=${encodeURIComponent(title)}` +
         `&body=${encodeURIComponent(body)}`
}

export default function PluginsPage() {
  const [ideas, setIdeas] = useState<PluginIdea[]>([])
  const [repo,  setRepo]  = useState('hyperprox/alpha')

  useEffect(() => {
    fetch('/api/plugins/wishlist')
      .then(r => r.json())
      .then(d => { if (d.success) { setIdeas(d.data.ideas); setRepo(d.data.repo) } })
      .catch(() => { /* the catalogue simply shows nothing extra */ })
  }, [])

  const [plugins, setPlugins] = useState<PluginCard[]>([])
  const [data,    setData]    = useState<Record<string, TileData>>({})
  const [busy,    setBusy]    = useState<Record<string, boolean>>({})
  const [editing, setEditing] = useState<PluginCard | null>(null)
  const [notice,  setNotice]  = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [findings, setFindings] = useState<Finding[] | null>(null)

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

  const scan = async () => {
    setScanning(true)
    setFindings(null)
    try {
      const res = await fetch('/api/plugins/discover').then(r => r.json())
      if (!res.success) return setNotice(res.error)
      setFindings(res.data)
      if (!res.data.length) setNotice('Nothing found. Only running containers with a readable address are scanned.')
    } catch (e: any) {
      setNotice(e.message)
    } finally {
      setScanning(false)
    }
  }

  // Applying a finding fills in the address only. A key we cannot discover is
  // still a key the user has to paste, and pretending otherwise would just move
  // the failure to the first refresh.
  const applyFinding = async (f: Finding) => {
    const res = await fetch(`/api/plugins/${f.pluginId}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [f.setting]: f.address }),
    }).then(r => r.json())
    if (!res.success) return setNotice(res.error)
    setFindings(prev => (prev ?? []).filter(x => x !== f))
    await load()
    if (f.needs.length) {
      const plugin = plugins.find(p => p.id === f.pluginId)
      setNotice(`${f.label} address saved — it still needs ${f.needs.join(' and ')}.`)
      if (plugin) setEditing(plugin)
    } else {
      readOne(f.pluginId)
    }
  }

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
    <div className="flex h-full flex-col" style={{ background: 'var(--ground)' }}>
      <header className="flex flex-shrink-0 flex-wrap items-end gap-x-4 gap-y-3 border-b px-4 py-5 sm:px-8 sm:py-6"
        style={{ borderColor: BORDER, background: 'var(--surface-raised)' }}>
        <div className="flex flex-col gap-2">
          <p className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: ACCENT }}>
            {loading ? 'loading…' : `${plugins.filter(p => p.configured).length} of ${plugins.length} configured`}
          </p>
          <h1 className="font-display text-[34px] font-bold leading-none" style={{ color: 'var(--text-bright)' }}>Plug-ins</h1>
        </div>
        <button
          onClick={scan}
          disabled={scanning}
          className="ml-auto h-10 rounded-md border px-5 text-sm font-semibold transition-opacity hover:opacity-85 disabled:opacity-40"
          style={{ background: 'transparent', color: ACCENT, borderColor: ACCENT }}
        >
          {scanning ? 'Scanning…' : 'Scan for services'}
        </button>
      </header>

      {notice && (
        <div className="flex flex-shrink-0 items-center gap-3 border-b px-4 py-2.5 text-sm sm:px-8"
          style={{ borderColor: BORDER, background: 'var(--surface-notice)', color: 'var(--text-soft)' }}>
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} style={{ color: 'var(--text-dim)' }}>dismiss</button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-8 sm:py-8">
        <p className="mb-8 max-w-[680px] text-[15px] leading-relaxed" style={{ color: 'var(--text-soft)' }}>
          Plug-ins never see a credential. They declare what they need, and HyperProx makes the
          call on their behalf — so a plug-in can read its own device and nothing else.
        </p>

        {findings && findings.length > 0 && (
          <section className="mb-8 rounded-lg border" style={{ background: PANEL, borderColor: 'color-mix(in srgb, var(--accent) 35%, transparent)' }}>
            <header className="flex items-center gap-3 border-b px-5 py-3.5" style={{ borderColor: BORDER }}>
              <h2 className="font-display text-[20px] font-semibold" style={{ color: 'var(--text-bright)' }}>
                Found on your cluster
              </h2>
              <span className="font-mono text-[11px]" style={{ color: 'var(--text-dimmer)' }}>{findings.length}</span>
              <button onClick={() => setFindings(null)} className="ml-auto text-sm" style={{ color: 'var(--text-dim)' }}>
                dismiss
              </button>
            </header>
            <div className="flex flex-col">
              {findings.map((f, i) => (
                <div key={i} className="flex items-center gap-3 border-b px-5 py-3 last:border-b-0" style={{ borderColor: 'var(--surface-notice)' }}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[15px] font-semibold" style={{ color: 'var(--text-bright)' }}>{f.label}</span>
                      <span className="font-mono text-xs" style={{ color: 'var(--text-dim)' }}>{f.address}</span>
                    </div>
                    <div className="text-[13px]" style={{ color: 'var(--text-dimmer)' }}>
                      on {f.source}
                      {f.needs.length > 0 && (
                        <span style={{ color: 'var(--warn)' }}> · still needs {f.needs.join(' and ')}</span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => applyFinding(f)}
                    className="h-9 rounded-md px-4 text-sm font-semibold transition-opacity hover:opacity-85"
                    style={{ background: ACCENT, color: 'var(--accent-ink)', border: 'none' }}
                  >
                    Use this
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))' }}>
          {plugins.map(p => {
            const d    = data[p.id]
            const tone = !p.configured ? 'idle' : d && !d.ok ? 'bad' : d ? (d.tone ?? 'good') : 'idle'
            return (
              <article key={p.id} className="relative overflow-hidden rounded-lg border"
                style={{ background: PANEL, borderColor: 'var(--border-soft)' }}>
                {/* Severity stripe — state readable before any text is parsed. */}
                <span className="absolute left-0 top-0 h-full w-[2px]" style={{ background: TONE[tone] }} />

                <div className="flex items-start gap-3 px-5 pb-4 pt-5">
                  <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md border text-lg"
                    style={{ borderColor: 'var(--border-strong)', background: 'var(--ground)' }}>{p.icon}</span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate font-display text-[20px] font-semibold leading-tight" style={{ color: 'var(--text-bright)' }}>{p.name}</h2>
                      <span className="flex-shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider"
                        style={{ background: 'color-mix(in srgb, var(--accent) 6%, transparent)', color: 'var(--text-dim)', border: '1px solid var(--border-strong)' }}>
                        {p.kind}
                      </span>
                    </div>
                    <p className="mt-1 text-sm leading-snug" style={{ color: 'var(--text-muted)' }}>{p.description}</p>
                  </div>
                </div>

                <div className="px-5">
                  {p.configured && p.hasDetail ? (
                    <Link href={`/plugins/${p.id}`} className="block transition-opacity hover:opacity-90">
                      <Preview data={d} loading={!!busy[p.id]} />
                    </Link>
                  ) : (
                    <Preview data={d} loading={!!busy[p.id]} />
                  )}
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2 border-t px-5 py-3.5" style={{ borderColor: BORDER }}>
                  <span className="font-mono text-[11px]" style={{ color: TONE[tone] }}>
                    {!p.configured
                      ? `needs ${p.missing.join(' and ')}`
                      : d && !d.ok ? 'unreachable'
                      : d ? 'connected' : 'idle'}
                  </span>

                  <div className="ml-auto flex items-center gap-2">
                    {p.configured && p.hasDetail && (
                      <Link href={`/plugins/${p.id}`}
                        className="inline-flex h-9 items-center rounded-md border px-4 text-sm transition-colors hover:bg-white/5"
                        style={{ borderColor: ACCENT, color: ACCENT, background: 'transparent' }}>
                        Open in full
                      </Link>
                    )}
                    {p.configured && (
                      <button onClick={() => readOne(p.id)} disabled={busy[p.id]}
                        className="h-9 rounded-md border px-4 text-sm transition-colors hover:bg-white/5 disabled:opacity-40"
                        style={{ borderColor: 'var(--border-strong)', color: 'var(--text)', background: 'transparent' }}>
                        Refresh
                      </button>
                    )}
                    <button onClick={() => setEditing(p)}
                      className="h-9 rounded-md px-5 text-sm font-semibold transition-opacity hover:opacity-85"
                      style={{ background: ACCENT, color: 'var(--accent-ink)', border: 'none' }}>
                      {p.configured ? 'Settings' : 'Set up'}
                    </button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>

        {/* ── Not built yet ──────────────────────────────────────────────── */}
        {ideas.length > 0 && (
          <section className="mt-12">
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <h2 className="font-display text-[22px] font-semibold" style={{ color: 'var(--text-bright)' }}>
                Not built yet
              </h2>
              <a href={requestUrl(repo)} target="_blank" rel="noreferrer"
                className="ml-auto inline-flex h-9 items-center rounded-md border px-4 text-sm font-semibold transition-opacity hover:opacity-85"
                style={{ background: 'transparent', color: ACCENT, borderColor: ACCENT }}>
                Suggest something else →
              </a>
            </div>
            <p className="mb-5 text-[15px] leading-relaxed" style={{ color: 'var(--text-soft)', maxWidth: 680 }}>
              Ideas, not promises — nothing here is scheduled. Asking is what moves one up. The button
              opens a pre-filled issue on GitHub in your browser; HyperProx holds no token and posts
              nothing on your behalf.
            </p>

            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))' }}>
              {ideas.map(i => (
                <article key={i.slug} className="flex flex-col rounded-lg border p-5"
                  style={{ background: PANEL, borderColor: 'var(--border-soft)' }}>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="font-display text-[20px] font-semibold leading-tight" style={{ color: 'var(--text-bright)' }}>{i.name}</span>
                    <span className="rounded px-1.5 font-mono text-[10px]"
                      style={{ background: 'color-mix(in srgb, var(--text-faint) 50%, transparent)', color: 'var(--text-dim)' }}>{i.category}</span>
                  </div>
                  <p className="mb-4 text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>{i.would}</p>
                  <div className="mt-auto flex items-center gap-2">
                    <a href={requestUrl(repo, i)} target="_blank" rel="noreferrer"
                      className="inline-flex h-9 items-center rounded-md border px-4 text-sm transition-colors hover:bg-white/5"
                      style={{ borderColor: 'var(--border-strong)', color: 'var(--text)' }}>
                      Request this
                    </a>
                    {i.api && (
                      <span className="truncate font-mono text-[11px]" style={{ color: 'var(--text-dimmest)' }}>{i.api}</span>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </div>

      {editing && <SettingsDialog plugin={editing} onSave={save} onClose={() => setEditing(null)} />}
    </div>
  )
}
