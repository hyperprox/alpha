'use client'

// =============================================================================
//  HyperProx — the Open WebUI plug-in page
//
//  A visual page, phone first: the connection to the Ollama (a big state, with a Reconnect button when it does not
//  answer), the models available as bars by size, whether open sign-up is off, and what needs you. A fix is confirmed
//  first (the server enforces it and says in words what it will do) and read back after. Admin only.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { BusyNote, Notice } from '@/components/vault/ui'
import { HudHeader, Icon, Panel, Pill, styles as vs } from '@/components/visual/kit'
import { PluginSwitcher } from '@/components/plugins/visual/plugin-kit'
import { modelSize, modelsBySize, ollamaState, plural, type Overview, type Problem } from './logic'

const API = '/api/plugins/openwebui'

export function ProblemList({ problems, busy, onFix }: { problems: Problem[]; busy: string | null; onFix: (p: Problem) => void }) {
  if (!problems.length) return <p className="text-sm" style={{ color: 'var(--good)' }}><Icon name="check" size={14} /> No problems: the Ollama answers and sign-up is closed.</p>
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {problems.map(p => (
        <li key={p.id} data-sev={p.severity} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <Icon name={p.severity === 'bad' ? 'error' : 'warn'} size={18} label={p.severity === 'bad' ? 'Problem' : 'Warning'} />
          <div style={{ flex: 1, minWidth: 200 }}><b>{p.title}</b><p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--text-dim)' }}>{p.detail}</p></div>
          {p.fix && <button type="button" className={`${vs.btn} ${p.severity === 'bad' ? vs.btnPri : ''}`} disabled={busy === p.id} onClick={() => onFix(p)}>{busy === p.id ? 'Working…' : p.fix.label}</button>}
        </li>
      ))}
    </ul>
  )
}

export function Models({ models }: { models: Overview['models'] }) {
  if (!models.length) return <p className="text-sm" style={{ color: 'var(--text-dim)' }}>No models yet. Pull one into the Ollama from the AI page.</p>
  const top = Math.max(1, ...models.map(m => m.sizeBytes ?? 0))
  return (
    <ul aria-label="Models" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {modelsBySize(models).map(m => (
        <li key={m.name}>
          <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 14 }}><b style={{ overflowWrap: 'anywhere' }}>{m.name}</b><span style={{ color: 'var(--text-dim)' }}>{modelSize(m.sizeBytes)}</span></span>
          <div role="img" aria-label={`${m.name}: ${modelSize(m.sizeBytes)}`} style={{ height: 6, borderRadius: 3, background: 'var(--ground-inset)', overflow: 'hidden' }}>
            <div style={{ width: `${Math.round(((m.sizeBytes ?? 0) / top) * 100)}%`, height: '100%', background: 'var(--hx-accent)' }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

export function OpenWebuiPage() {
  const { role } = useSession()
  const admin = atLeast(role, 'admin')
  const [o, setO] = useState<Overview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null)

  const load = useCallback(async () => {
    const r = await apiJson<{ data: Overview }>(`${API}/overview`)
    if (r.ok) { setO(r.body!.data); setError(null) } else setError(r.error ?? 'Could not read Open WebUI.')
  }, [])
  useEffect(() => { if (admin) void load() }, [admin, load])

  if (!admin) return (
    <div className={vs.page}><PluginSwitcher current="openwebui" />
      <Notice kind="info">The Open WebUI plug-in page needs the admin role. The card on the Plug-ins page shows the totals.</Notice></div>
  )

  const fix = async (p: Problem) => {
    if (!p.fix) return
    setBusy(p.id); setNote(null)
    const r = await apiJson<{ data: { message: string; overview: Overview } }>(`${API}/actions`, 'POST', { action: p.fix.action })
    setBusy(null)
    setNote(r.ok ? { text: r.body!.data.message, ok: true } : { text: r.error ?? 'Nothing was changed.', ok: false })
    await load()
  }

  const st = o ? ollamaState(o.ollama) : null
  const chips = o ? [
    { label: 'models', value: o.models.length, tone: 'accent' as const },
    { label: 'ollama', value: st!.tone === 'good' ? 'up' : st!.tone === 'crit' ? 'down' : 'none', tone: st!.tone },
    { label: 'sign-up', value: o.signupOpen === null ? '?' : o.signupOpen ? 'open' : 'closed', tone: o.signupOpen ? 'crit' as const : 'good' as const },
  ] : [{ label: 'reading', value: '…', tone: 'dim' as const }]

  return (
    <div className={vs.page}>
      <PluginSwitcher current="openwebui" />
      <HudHeader eyebrow="Plug-in · AI" title="Open WebUI" icon="cloud" chips={chips} />
      {error && <Notice kind="error">{error}{' '}<a href="/catalogue?recipe=open-webui" style={{ color: 'var(--hx-accent)' }}>Install Open WebUI from the Catalogue</a></Notice>}
      {!o && !error && <BusyNote>Reading Open WebUI…</BusyNote>}
      {note && <p className="text-sm" role="status" style={{ color: note.ok ? 'var(--good)' : 'var(--warn-2)' }}>{note.text}</p>}
      {o && st && (
        <>
          <Panel title="Ollama" sub={o.version ? `Open WebUI ${o.version}` : undefined}>
            <p className="text-sm" role="status" style={{ margin: 0, color: st.tone === 'good' ? 'var(--good)' : st.tone === 'crit' ? 'var(--crit-soft)' : 'var(--warn-2)' }}><b>{st.text}.</b>{o.ollama.error ? ` ${o.ollama.error}` : ''}</p>
          </Panel>
          <Panel title="What needs you"><ProblemList problems={o.problems} busy={busy} onFix={p => void fix(p)} /></Panel>
          <Panel title="Models available" sub={plural(o.models.length, 'model')}><Models models={o.models} /></Panel>
          <Panel title="Sign-up"><p className="text-sm" style={{ margin: 0, color: 'var(--text-soft)' }}>{o.signupOpen === null ? 'Open WebUI did not say.' : o.signupOpen ? <><Pill tone="bad">open</Pill> Anyone who can reach it can make an account.</> : <><Pill tone="good">closed</Pill> People are added by an administrator.</>}</p></Panel>
        </>
      )}
    </div>
  )
}
