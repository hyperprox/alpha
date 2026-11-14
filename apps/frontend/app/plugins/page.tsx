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
import { isNotConfigured } from '@/lib/plugin-status'
import Link from 'next/link'
import { Page, HudHeader, Panel, styles } from '@/components/visual/kit'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { PlexSignIn } from '@/components/plugins/plex/SignIn'
import { LOCAL_PLUGINS } from '@local-plugins'

interface PluginSetting {
  key: string; label: string; type: 'text' | 'secret' | 'url' | 'toggle'
  required: boolean; hint?: string; value: string; isSet: boolean
  /** A heading shown above this setting and the ones after it. */
  section?: string
}

interface PluginCard {
  id: string; name: string; description: string
  kind: 'tile' | 'device'; icon: string
  settings: PluginSetting[]; configured: boolean; missing: string[]
  hasDetail: boolean
}

interface Finding {
  /** null for a plug-in with its own device list (PBS): it is added on `page`, not by an address setting. */
  pluginId: string; setting: string | null; page?: string | null; label: string
  address: string; source: string; needs: string[]
}

interface TileData {
  ok: boolean; error?: string; headline?: string
  tone?: 'good' | 'warn' | 'bad'
  rows?: Array<{ label: string; value: string; tone?: 'good' | 'warn' | 'bad' }>
}

const ACCENT = 'var(--accent)'
const BORDER = 'var(--border)'

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
        style={{ borderColor: BORDER, background: 'var(--ground-deep)', color: 'var(--text-dimmer)' }}>
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
    const unset = isNotConfigured(data.error)
    return (
      <div className="flex h-[132px] flex-col justify-center gap-1.5 rounded border px-3.5"
        style={{ borderColor: unset ? 'var(--border-strong)' : 'color-mix(in srgb, var(--crit) 33%, transparent)', background: 'var(--ground-deep)' }}>
        <span className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: unset ? 'var(--text-muted)' : TONE.bad }}>
          {unset ? 'not set up' : 'not reporting'}
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

/**
 * "Test Lidarr": reads /api/v1/system/status with what is SAVED (never with what is typed in the form, so a typed key can
 * never be sent to a typed address), and says whether Lidarr answered. Shown only once an address and key are saved.
 */
function LidarrTest({ plugin }: { plugin: PluginCard }) {
  const saved = (plugin.settings.find(x => x.key === 'lidarr_url')?.value ?? '') !== '' && !!plugin.settings.find(x => x.key === 'lidarr_key')?.isSet
  const [state, setState] = useState<{ busy: boolean; ok?: boolean; text?: string }>({ busy: false })
  if (!saved) return null
  const run = async () => {
    setState({ busy: true })
    try {
      const r = await fetch('/api/plugins/arrstack/lidarr/test').then(x => x.json())
      const d = r?.data
      setState(d?.ok ? { busy: false, ok: true, text: `Lidarr ${d.version} answered.` } : { busy: false, ok: false, text: d?.error ?? r?.error ?? 'The test could not run.' })
    } catch { setState({ busy: false, ok: false, text: 'The test could not run.' }) }
  }
  return (
    <div className="flex flex-wrap items-center gap-3 border-t px-6 py-3" style={{ borderColor: BORDER }}>
      <button type="button" onClick={run} disabled={state.busy} className={styles.btn}>{state.busy ? 'Testing…' : 'Test Lidarr'}</button>
      {state.text && <span role="status" className="text-[13px]" style={{ color: state.ok ? 'var(--good)' : 'var(--warn)', overflowWrap: 'anywhere' }}>{state.text}</span>}
    </div>
  )
}

function SettingsDialog({ plugin, onSave, onClose, known, onSignedIn }: {
  plugin: PluginCard
  onSave: (values: Record<string, string>) => void
  onClose: () => void
  /** Plex: an address Scan for services found, to preselect in Sign in with Plex. */
  known?: string | null
  /** Plex: Sign in with Plex saved the server. */
  onSignedIn?: (r: { server: string; url: string; note?: string }) => void
}) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(plugin.settings.map(s => [s.key, s.type === 'secret' ? '' : s.value])),
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'var(--scrim)', backdropFilter: 'blur(4px)' }}>
      <form
        onSubmit={e => { e.preventDefault(); onSave(values) }}
        className="w-full max-w-md rounded-xl border overflow-y-auto"
        style={{ background: 'linear-gradient(135deg, var(--surface), var(--surface-hi))', borderColor: 'var(--border-strong)', boxShadow: 'var(--shadow)', maxHeight: 'calc(100dvh - 48px)' }}
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
          {plugin.id === 'plex' && onSignedIn && (
            <div>
              <h3 className="mb-3 mt-2 font-display text-[15px] font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--accent)' }}>Sign in with Plex</h3>
              <PlexSignIn known={known} onDone={onSignedIn} />
              <p className="mt-3 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-dimmer)' }}>
                Or enter the server address and token by hand below.
              </p>
            </div>
          )}
          {plugin.settings.map(s => (
            <div key={s.key}>
              {s.section && (
                <h3 className="mb-3 mt-2 font-display text-[15px] font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--accent)' }}>{s.section}</h3>
              )}
              {s.type === 'toggle' ? (
                <label className="flex items-center gap-3" style={{ minHeight: 40, cursor: 'pointer' }}>
                  <input type="checkbox" checked={values[s.key] === 'yes'} style={{ width: 22, height: 22, accentColor: 'var(--accent)' }}
                    onChange={e => setValues(v => ({ ...v, [s.key]: e.target.checked ? 'yes' : 'no' }))} />
                  <span className="text-sm" style={{ color: 'var(--text-bright)' }}>{s.label}</span>
                </label>
              ) : (<>
              <Label>{s.label}{!s.required && <span style={{ color: 'var(--text-dimmer)' }}> · optional</span>}</Label>
              <input
                type={s.type === 'secret' ? 'password' : 'text'}
                value={values[s.key] ?? ''}
                onChange={e => setValues(v => ({ ...v, [s.key]: e.target.value }))}
                required={s.required && !(s.type === 'secret' && s.isSet)}
                placeholder={s.type === 'secret' && s.isSet ? '•••••••• — leave blank to keep' : ''}
                autoComplete="off"
                className={styles.input}
              />
              </>)}
              {s.hint && (
                <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-dimmer)' }}>{s.hint}</p>
              )}
            </div>
          ))}
        </div>

        {plugin.id === 'arrstack' && <LidarrTest plugin={plugin} />}
        <div className="flex justify-end gap-2 border-t px-6 py-4" style={{ borderColor: BORDER }}>
          <button type="button" onClick={onClose}
            className={styles.btn}>Cancel</button>
          <button type="submit"
            className={`${styles.btn} ${styles.btnPri}`}>Save and test</button>
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
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)

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
    if (!f.setting) return   // added on its own page (PBS), not by a setting
    const res = await fetch(`/api/plugins/${f.pluginId}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [f.setting]: f.address }),
    }).then(r => r.json())
    if (res?.code === 'reconfirm_required') { setReconfirm(() => () => void applyFinding(f)); return }
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

  const configuredCount = plugins.filter(p => p.configured).length

  const save = async (values: Record<string, string>, plugin?: PluginCard) => {
    const p = plugin ?? editing!
    setEditing(null)
    const res = await fetch(`/api/plugins/${p.id}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    }).then(r => r.json())
    // Settings hold where a stored credential is sent, so saving asks for the master password again.
    if (res?.code === 'reconfirm_required') { setReconfirm(() => () => void save(values, p)); return }
    if (!res.success) return setNotice(res.error)
    await load()
    readOne(p.id)
  }

  return (
    <Page>
      <HudHeader level={2} icon="plugin" eyebrow={loading ? 'loading…' : `${configuredCount} of ${plugins.length} configured`} label="Plug-ins overview"
        title="Plug-ins read your devices"
        chips={[
          { label: 'Plug-ins', value: plugins.length },
          { label: 'Configured', value: configuredCount, tone: configuredCount ? 'good' : 'dim' },
          { label: 'Need setup', value: plugins.length - configuredCount, tone: plugins.length - configuredCount ? 'warn' : 'dim' },
        ]}
        actions={
          <button onClick={scan} disabled={scanning} className={styles.btn}>
            {scanning ? 'Scanning…' : 'Scan for services'}
          </button>
        }>
        <p style={{ margin: 0, maxWidth: 680, fontSize: 15, lineHeight: 1.6, color: 'var(--text-soft)' }}>
          Plug-ins never see a credential. They declare what they need, and HyperProx makes the
          call on their behalf — so a plug-in can read its own device and nothing else.
        </p>
      </HudHeader>

      {notice && (
        <div className={styles.callout} role="status" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ flex: 1 }}>{notice}</span>
          <button onClick={() => setNotice(null)} className={`${styles.btn} ${styles.btnGhost}`}>dismiss</button>
        </div>
      )}

        {findings && findings.length > 0 && (
          <Panel title="Found on your cluster" sub={`${findings.length}`}
            actions={<button onClick={() => setFindings(null)} className={`${styles.btn} ${styles.btnGhost}`}>dismiss</button>}>
            <div className="flex flex-col">
              {findings.map((f, i) => (
                <div key={i} className="flex items-center gap-3 border-b py-3 last:border-b-0" style={{ borderColor: 'var(--border-dim)' }}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-2">
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
                  {f.setting ? (
                    <button onClick={() => applyFinding(f)} className={`${styles.btn} ${styles.btnPri}`}>
                      Use this
                    </button>
                  ) : (
                    <Link href={f.page ?? `/plugins/${f.pluginId}`} className={`${styles.btn} ${styles.btnPri}`}>
                      Add it
                    </Link>
                  )}
                </div>
              ))}
            </div>
          </Panel>
        )}

        {LOCAL_PLUGINS.length > 0 && (
          <Panel title="Local plug-ins" sub="on this install only">
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))' }}>
              {LOCAL_PLUGINS.map(p => (
                <Link key={p.id} href={`/plugins/local/${p.id}`} className={styles.card} style={{ padding: '14px 16px', display: 'flex', gap: 12, alignItems: 'flex-start', textDecoration: 'none' }}>
                  <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md border text-lg"
                    style={{ borderColor: 'var(--border-strong)', background: 'var(--ground-deep)' }}>{p.icon ?? '◆'}</span>
                  <span className="min-w-0">
                    <span className="block truncate font-display text-[19px] font-semibold" style={{ color: 'var(--text-bright)' }}>{p.name}</span>
                    <span className="block text-sm leading-snug" style={{ color: 'var(--text-muted)' }}>{p.description}</span>
                  </span>
                </Link>
              ))}
            </div>
          </Panel>
        )}

        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))' }}>
          {plugins.map(p => {
            const d    = data[p.id]
            const tone = !p.configured ? 'idle' : d && !d.ok ? (isNotConfigured(d.error) ? 'idle' : 'bad') : d ? (d.tone ?? 'good') : 'idle'
            return (
              <article key={p.id} className={styles.card} style={{ padding: 0 }}>
                {/* Severity stripe — state readable before any text is parsed. */}
                <span className="absolute left-0 top-0 h-full w-[2px]" style={{ background: TONE[tone] }} />

                <div className="flex items-start gap-3 px-5 pb-4 pt-5">
                  <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md border text-lg"
                    style={{ borderColor: 'var(--border-strong)', background: 'var(--ground-deep)' }}>{p.icon}</span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate font-display text-[20px] font-semibold leading-tight" style={{ color: 'var(--text-bright)' }}>{p.name}</h2>
                      <span className={styles.tag}>{p.kind}</span>
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
                    <span aria-hidden>● </span>{!p.configured
                      ? `needs ${p.missing.join(' and ')}`
                      : d && !d.ok ? (isNotConfigured(d.error) ? 'not set up' : 'unreachable')
                      : d ? 'connected' : 'idle'}
                  </span>

                  <div className="ml-auto flex items-center gap-2">
                    {p.configured && p.hasDetail && (
                      <Link href={`/plugins/${p.id}`}
                        className={styles.btn} style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none', color: ACCENT, borderColor: ACCENT }}>
                        Open in full
                      </Link>
                    )}
                    {p.configured && (
                      <button onClick={() => readOne(p.id)} disabled={busy[p.id]}
                        className={styles.btn}>
                        Refresh
                      </button>
                    )}
                    <button onClick={() => setEditing(p)}
                      className={`${styles.btn} ${styles.btnPri}`}>
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
          <Panel title="Not built yet" sub={`${ideas.length} ideas`}
            actions={
              <a href={requestUrl(repo)} target="_blank" rel="noreferrer" className={styles.btn}
                style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none', color: ACCENT, borderColor: ACCENT }}>
                Suggest something else →
              </a>
            }>
            <p className="mb-5 text-[15px] leading-relaxed" style={{ color: 'var(--text-soft)', maxWidth: 680, margin: '0 0 16px' }}>
              Ideas, not promises — nothing here is scheduled. Asking is what moves one up. The button
              opens a pre-filled issue on GitHub in your browser; HyperProx holds no token and posts
              nothing on your behalf.
            </p>

            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(min(100%,300px),1fr))' }}>
              {ideas.map(i => (
                <article key={i.slug} className="flex flex-col rounded-lg border p-5"
                  style={{ background: 'var(--ground-deep)', borderColor: 'var(--border-soft)' }}>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <h3 className="font-display text-[20px] font-semibold leading-tight" style={{ color: 'var(--text-bright)', margin: 0 }}>{i.name}</h3>
                    <span className={styles.tag}>{i.category}</span>
                  </div>
                  <p className="mb-4 text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>{i.would}</p>
                  <div className="mt-auto flex items-center gap-2">
                    <a href={requestUrl(repo, i)} target="_blank" rel="noreferrer" className={styles.btn}
                      style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none', whiteSpace: 'nowrap', flexShrink: 0 }}>
                      Request this
                    </a>
                    {i.api && (
                      <span className="truncate font-mono text-[11px]" style={{ color: 'var(--text-dimmest)' }}>{i.api}</span>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </Panel>
        )}

      {editing && (
        <SettingsDialog plugin={editing} onSave={v => void save(v)} onClose={() => setEditing(null)}
          known={findings?.find(f => f.pluginId === 'plex' && f.setting === 'plex_url')?.address ?? null}
          onSignedIn={async r => {
            setEditing(null)
            setNotice(`Plex is set up: ${r.server}, at ${r.url}.${r.note ? ` ${r.note}` : ''}`)
            setFindings(prev => prev ? prev.filter(f => !(f.pluginId === 'plex' && f.setting === 'plex_url')) : prev)
            await load()
            readOne('plex')
          }} />
      )}
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const fn = reconfirm; setReconfirm(null); fn() }} />}
    </Page>
  )
}
