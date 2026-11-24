'use client'

import { useEffect, useState, useCallback } from 'react'
import { alpha } from '@/lib/theme'
import { BoltIcon } from './icons'
import { assistantMode } from '@/lib/ai-assistant-mode'
import { Page, HudHeader, Tiles, styles } from '@/components/visual/kit'
import { useAiPanel } from '@/components/ai/panel/PanelProvider'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ModelSpec {
  id:              string
  name:            string
  description:     string
  params:          string
  ramGB:           number
  vramGB:          number
  sizeGB:          number
  tier:            string
  strengths:       string[]
  good_for_wizard: boolean
  tags:            string[]
  recommended:     boolean
  installed:       boolean
  fits_gpu:        boolean
  fits_cpu:        boolean
}

interface Hardware {
  totalRamGB:  number
  maxVramGB:   number
  totalCores:  number
}

interface CatalogData {
  catalog:     ModelSpec[]
  hardware:    Hardware | null
  recommended: string[]
}

interface OllamaStatus {
  connected: boolean
  url:       string | null
  models:    Array<{ name: string; size: number }>
  error?:    string
}

type ProviderId = 'anthropic' | 'openai' | 'ollama'

interface ProviderInfo {
  id:         ProviderId
  name:       string
  kind:       'local' | 'cloud'
  configured: boolean
  model:      string
  missing:    string[]
  note:       string
}

// ── Style constants ───────────────────────────────────────────────────────────

const ACCENT = 'var(--violet)'
const CARD   = 'var(--surface)'
const BORDER = 'var(--border-strong)'

const mono: React.CSSProperties = { fontFamily: 'IBM Plex Mono, monospace' }

const primaryBtn: React.CSSProperties = { background: 'var(--accent)', color: 'var(--accent-ink)', border: 'none', borderRadius: 6, fontWeight: 600 }
const secondaryBtn: React.CSSProperties = { background: 'transparent', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: 6 }
const inputStyle: React.CSSProperties = { background: 'var(--ground-deep)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-bright)', outline: 'none' }
const errBox: React.CSSProperties = { background: 'color-mix(in srgb, var(--crit) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--crit) 35%, transparent)', color: 'var(--crit)' }

const badge = (color: string): React.CSSProperties => ({
  display:       'inline-flex',
  alignItems:    'center',
  padding:       '2px 8px',
  borderRadius:  99,
  fontSize:      10,
  fontWeight:    600,
  fontFamily:    'IBM Plex Mono, monospace',
  background:    `${alpha(color, 9)}`,
  color,
  border:        `1px solid ${alpha(color, 19)}`,
})

const TIER_COLOR: Record<string, string> = {
  nano:   'var(--text-muted)',
  small:  'var(--good)',
  medium: 'var(--accent)',
  large:  'var(--violet)',
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ marginBottom: '1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <h2 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-bright)' }}>
          {title}
        </h2>
      </div>
      {subtitle && <p style={{ fontSize: 15, color: 'var(--text-soft)' }}>{subtitle}</p>}
    </div>
  )
}

function ModelCard({
  model, onPull, onDelete, pulling,
}: {
  model:   ModelSpec
  onPull:  (id: string) => void
  onDelete:(id: string) => void
  pulling: string | null
}) {
  const tierColor = TIER_COLOR[model.tier] ?? 'var(--text-muted)'
  const isPulling = pulling === model.id

  return (
    <div style={{
      background:   CARD,
      border:       `1px solid ${model.recommended ? alpha(ACCENT, 31) : BORDER}`,
      borderRadius: 10,
      padding:      '1.25rem',
      position:     'relative',
      transition:   'border-color .15s',
    }}>
      {model.recommended && (
        <div style={{ position: 'absolute', top: -10, left: 12, ...badge(ACCENT), fontSize: 9 }}><BoltIcon size={10} /> RECOMMENDED</div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 4 }}>{model.name}</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            <span style={badge(tierColor)}>{model.params}</span>
            <span style={badge('var(--text-dimmer)')}>{model.sizeGB}GB</span>
            {model.good_for_wizard && <span style={badge('var(--good)')}>✓ wizard-ready</span>}
            {model.installed && <span style={badge('var(--good)')}>installed</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {!model.installed ? (
            <button onClick={() => onPull(model.id)} disabled={!!pulling}
              style={{
                padding: '6px 14px', fontSize: 13,
                cursor: pulling ? 'default' : 'pointer',
                ...primaryBtn,
                opacity: isPulling ? 0.6 : 1,
              }}>
              {isPulling ? '↓ pulling...' : '↓ install'}
            </button>
          ) : (
            <button onClick={() => onDelete(model.id)}
              style={{ padding: '6px 12px', borderRadius: 6, fontSize: 13, cursor: 'pointer', background: 'transparent', color: 'var(--text-dimmer)', border: '1px solid transparent' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--crit)'; (e.currentTarget as HTMLElement).style.borderColor = 'color-mix(in srgb, var(--crit) 19%, transparent)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text-dimmer)'; (e.currentTarget as HTMLElement).style.borderColor = 'transparent' }}
            >✕ remove</button>
          )}
        </div>
      </div>

      <p style={{ fontSize: 14, color: 'var(--text-soft)', lineHeight: 1.5, marginBottom: 12 }}>{model.description}</p>

      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {model.strengths.map(s => (
          <span key={s} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'var(--border-dim)', color: 'var(--text-soft)', ...mono }}>{s}</span>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 12, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${BORDER}` }}>
        <div style={{ fontSize: 10, color: 'var(--text-dimmer)', ...mono }}>
          RAM: <span style={{ color: model.fits_cpu ? 'var(--good)' : 'var(--crit)' }}>{model.ramGB}GB</span>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-dimmer)', ...mono }}>
          VRAM: <span style={{ color: model.fits_gpu ? 'var(--good)' : 'var(--text-muted)' }}>{model.vramGB}GB</span>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AIPage() {
  const panel = useAiPanel()
  const [tab,         setTab]         = useState<'models' | 'settings'>('models')
  const [status,      setStatus]      = useState<OllamaStatus | null>(null)
  const [catalog,     setCatalog]     = useState<CatalogData | null>(null)
  const [loading,     setLoading]     = useState(true)
  const [pulling,     setPulling]     = useState<string | null>(null)
  const [ollamaUrl,   setOllamaUrl]   = useState('')
  const [detecting,   setDetecting]   = useState(false)
  const [detected,    setDetected]    = useState<Array<{url:string;name:string;vmid:number}>>([])
  const [connecting,  setConnecting]  = useState(false)
  const [connectErr,  setConnectErr]  = useState<string | null>(null)

  const [providers,   setProviders]   = useState<ProviderInfo[]>([])
  const [activeProv,  setActiveProv]  = useState<ProviderId>('ollama')
  const [provDraft,   setProvDraft]   = useState<Record<string, Record<string, string>>>({})
  const [provBusy,    setProvBusy]    = useState<string | null>(null)
  const [provResult,  setProvResult]  = useState<Record<string, string>>({})
  const fetchAll = useCallback(async () => {
    const [statusRes, catalogRes, provRes] = await Promise.all([
      fetch('/api/ai/status'),
      fetch('/api/ai/catalog'),
      fetch('/api/ai/providers'),
    ])
    const [s, c, pr] = await Promise.all([statusRes.json(), catalogRes.json(), provRes.json()])
    setStatus(s)
    if (c.ok) setCatalog(c)
    if (pr.ok) {
      setProviders(pr.providers); setActiveProv(pr.active)
    }
    setLoading(false)
  }, [])

  // Which provider is selected, and whether it can actually be used. Ollama is
  // "configured" as soon as an address is stored, but it is only usable once
  // that address answers — hence the two different checks.
  const activeInfo     = providers.find(p => p.id === activeProv) ?? null
  const providerReady  = activeProv === 'ollama'
    ? Boolean(status?.connected)
    : Boolean(activeInfo?.configured)
  // Without a model the assistant still answers by code, so the input stays usable either way.
  const mode = assistantMode({ providerReady, planning: false, providerName: activeInfo?.name, model: activeInfo?.model })

  const selectProvider = async (id: ProviderId) => {
    setActiveProv(id)
    await fetch('/api/ai/provider/select', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: id }),
    })
  }

  const saveProvider = async (id: ProviderId) => {
    const draft = provDraft[id] ?? {}
    if (!Object.keys(draft).length) return
    setProvBusy(id)
    setProvResult(r => ({ ...r, [id]: '' }))
    const res  = await fetch(`/api/ai/provider/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    })
    const data = await res.json()
    setProvBusy(null)
    setProvDraft(d => ({ ...d, [id]: {} }))
    setProvResult(r => ({ ...r, [id]: data.ok ? 'saved' : `✗ ${data.error}` }))
    await fetchAll()
  }

  const testProvider = async (id: ProviderId) => {
    setProvBusy(id)
    setProvResult(r => ({ ...r, [id]: 'planning a test deployment…' }))
    const res  = await fetch('/api/ai/provider/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: id }),
    })
    const data = await res.json()
    setProvBusy(null)
    setProvResult(r => ({
      ...r,
      [id]: data.ok
        ? `✓ read ${data.sample.fields} field${data.sample.fields === 1 ? '' : 's'}${data.sample.service ? ` (${data.sample.service})` : ''} in ${(data.ms / 1000).toFixed(1)}s`
        : `✗ ${data.error}`,
    }))
  }

  useEffect(() => { fetchAll() }, [fetchAll])

  const handleConnect = async () => {
    if (!ollamaUrl) return
    setConnecting(true)
    setConnectErr(null)
    const res  = await fetch('/api/ai/connect', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url: ollamaUrl }),
    })
    const json = await res.json()
    setConnecting(false)
    if (json.ok) { await fetchAll() }
    else setConnectErr(json.error)
  }

  const handlePull = async (modelId: string) => {
    setPulling(modelId)
    await fetch('/api/ai/pull', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model: modelId }),
    })
    const poll = setInterval(async () => {
      const res  = await fetch('/api/ai/status')
      const data = await res.json()
      setStatus(data)
      const installed = (data.models ?? []).some((m: any) => m.name.startsWith(modelId.split(':')[0]))
      if (installed) { clearInterval(poll); setPulling(null); fetchAll() }
    }, 3000)
  }

  const handleDelete = async (modelId: string) => {
    await fetch(`/api/ai/models/${encodeURIComponent(modelId)}`, { method: 'DELETE' })
    fetchAll()
  }

  if (loading) return (
    <Page><p className={styles.empty}>initializing ai...</p></Page>
  )

  return (
    <Page>
      {/* Header: the provider's state as a HUD, in words as well as colour */}
      <HudHeader level={2} icon="plugin" label="AI assistant status"
        eyebrow={mode.eyebrow}
        title={mode.title}
        chips={[
          { label: 'Status', value: mode.status.value, tone: mode.status.tone },
          { label: 'Provider', value: activeInfo?.name ?? 'none' },
          { label: 'Model', value: activeInfo?.model || '—' },
          { label: 'Local model', value: status?.connected ? 'connected' : 'not connected', tone: status?.connected ? 'good' : 'dim' },
        ]} />

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: '1.5rem', borderBottom: `1px solid ${BORDER}` }}>
        {(['models', 'settings'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{
              padding: '10px 18px', fontSize: 15, fontWeight: 600, cursor: 'pointer',
              background: 'transparent', color: tab === t ? 'var(--accent)' : 'var(--text-dim)',
              border: 'none', borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
              textTransform: 'capitalize', transition: 'color .15s',
            }}
          >{t}</button>
        ))}
        <a href="/ai/operator" style={{ padding: '10px 18px', fontSize: 15, fontWeight: 600, color: 'var(--text-dim)', textDecoration: 'none', borderBottom: '2px solid transparent' }}>Operator</a>
        <a href="/ai/handbook" style={{ padding: '10px 18px', fontSize: 15, fontWeight: 600, color: 'var(--text-dim)', textDecoration: 'none', borderBottom: '2px solid transparent' }}>Handbook</a>
      </div>

      {/* The assistant moved to the side panel, which stays open on every page. This page keeps the models and providers. */}
      <p style={{ margin: '0 0 1.25rem', fontSize: 14, color: 'var(--text-soft)' }}>
        The assistant now lives in the side panel, open on every page.{' '}
        <button onClick={() => panel.openPanel('assistant')} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, font: 'inherit', textDecoration: 'underline' }}>Open it</button>
      </p>
      {tab === 'models' && (
        <div>
          {catalog?.hardware && (
            <div style={{ marginBottom: '1.5rem' }}>
              <Tiles label="Cluster hardware" items={[
                { label: 'Cluster RAM', value: `${catalog.hardware.totalRamGB.toFixed(0)}GB` },
                { label: 'GPU VRAM', value: catalog.hardware.maxVramGB > 0 ? `${catalog.hardware.maxVramGB.toFixed(0)}GB` : 'none', tone: catalog.hardware.maxVramGB > 0 ? 'violet' : 'dim' },
                { label: 'CPU Cores', value: catalog.hardware.totalCores },
              ]} />
              <p style={{ margin: '10px 0 0', fontSize: 14, color: 'var(--text-soft)' }}>Models marked <span style={{ color: ACCENT }}><BoltIcon size={12} /> recommended</span> are best for your hardware.</p>
            </div>
          )}
          <SectionHeader title="Model Library" subtitle="Download and manage AI models. Recommended models are highlighted for your hardware." />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
            {(catalog?.catalog ?? []).map(model => (<ModelCard key={model.id} model={model} onPull={handlePull} onDelete={handleDelete} pulling={pulling} />))}
          </div>
        </div>
      )}
      {tab === 'settings' && (
        <div style={{ maxWidth: 640 }}>
          <SectionHeader title="Cloud Providers" subtitle="Bring your own API key. Cloud models plan against the same cluster facts as a local one, and are usable immediately — no download." />
          {providers.filter(p => p.kind === 'cloud').map(p => {
            const draft = provDraft[p.id] ?? {}
            const field = (key: string, label: string, placeholder: string, type = 'text') => (
              <label key={key} style={{ display: 'block', marginBottom: 8 }}>
                <span style={{ display: 'block', fontSize: 10, color: 'var(--text-dim)', ...mono, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 }}>{label}</span>
                <input
                  type={type}
                  value={draft[key] ?? ''}
                  placeholder={placeholder}
                  onChange={e => setProvDraft(d => ({ ...d, [p.id]: { ...(d[p.id] ?? {}), [key]: e.target.value } }))}
                  style={{ width: '100%', height: 42, padding: '0 12px', ...inputStyle, fontSize: 13, ...mono }} />
              </label>
            )
            const result = provResult[p.id]
            return (
              <div key={p.id} style={{ background: CARD, border: `1px solid ${p.id === activeProv ? alpha(ACCENT, 25) : BORDER}`, borderRadius: 10, padding: '1.5rem', marginBottom: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-bright)' }}>{p.name}</div>
                  <span style={badge(p.configured ? 'var(--good)' : 'var(--text-dimmer)')}>{p.configured ? 'configured' : 'no key'}</span>
                  {p.id === activeProv && <span style={badge(ACCENT)}>active</span>}
                  <button onClick={() => selectProvider(p.id)} disabled={!p.configured || p.id === activeProv}
                    style={{ marginLeft: 'auto', fontSize: 13, padding: '6px 14px', borderRadius: 6, cursor: (!p.configured || p.id === activeProv) ? 'default' : 'pointer', background: 'transparent', color: (!p.configured || p.id === activeProv) ? 'var(--text-dimmer)' : 'var(--accent)', border: `1px solid ${(!p.configured || p.id === activeProv) ? BORDER : 'var(--accent)'}` }}>
                    use this
                  </button>
                </div>
                <div style={{ fontSize: 14, color: 'var(--text-soft)', marginBottom: '1rem', lineHeight: 1.5 }}>{p.note}</div>
                {field('api_key', 'API key', p.configured ? '•••••••• stored — type to replace' : 'sk-…', 'password')}
                {field('model', 'Model', p.model)}
                {p.id === 'openai' && field('base_url', 'Base URL', 'https://api.openai.com/v1')}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                  <button onClick={() => saveProvider(p.id)} disabled={provBusy === p.id || !Object.keys(draft).length}
                    style={{ height: 40, padding: '0 20px', fontSize: 14, cursor: (provBusy === p.id || !Object.keys(draft).length) ? 'default' : 'pointer', ...primaryBtn, opacity: (provBusy === p.id || !Object.keys(draft).length) ? 0.4 : 1 }}>
                    {provBusy === p.id ? '…' : 'Save'}
                  </button>
                  <button onClick={() => testProvider(p.id)} disabled={!p.configured || provBusy === p.id}
                    style={{ height: 40, padding: '0 20px', fontSize: 14, cursor: (!p.configured || provBusy === p.id) ? 'default' : 'pointer', ...secondaryBtn, opacity: (!p.configured || provBusy === p.id) ? 0.4 : 1 }}>
                    Test
                  </button>
                  {result && (
                    <span style={{ fontSize: 13, color: result.startsWith('✗') ? 'var(--crit)' : result.startsWith('✓') ? 'var(--good)' : 'var(--text-muted)' }}>
                      {result}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
          <SectionHeader title="Ollama Connection" subtitle="Connect to an existing Ollama instance or deploy a managed one." />
          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, padding: '1.5rem', marginBottom: '1rem' }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 4 }}>Connect existing Ollama</div>
            <div style={{ fontSize: 14, color: 'var(--text-soft)', marginBottom: '1rem' }}>Already running Ollama on another machine? Point HyperProx at it.</div>
            <div style={{ marginBottom: 8 }}>
              <button onClick={async () => { setDetecting(true); setDetected([]); const res = await fetch('/api/ai/detect'); const data = await res.json(); setDetected(data.found ?? []); setDetecting(false); if (data.found?.length === 1) setOllamaUrl(data.found[0].url) }} disabled={detecting}
                style={{ height: 40, padding: '0 16px', fontSize: 14, fontWeight: 600, cursor: detecting ? 'default' : 'pointer', background: 'transparent', color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 6, opacity: detecting ? 0.6 : 1 }}>
                {detecting ? '⟳ scanning cluster...' : '⟳ auto-detect'}
              </button>
              {detected.length > 0 && (<div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>{detected.map(d => (<button key={d.url} onClick={() => setOllamaUrl(d.url)} style={{ padding: '6px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer', textAlign: 'left', ...mono, background: ollamaUrl === d.url ? `${alpha(ACCENT, 8)}` : 'var(--surface-raised)', color: ollamaUrl === d.url ? ACCENT : 'var(--text-muted)', border: `1px solid ${ollamaUrl === d.url ? alpha(ACCENT, 19) : BORDER}` }}>✓ {d.name} — {d.url}</button>))}</div>)}
              {!detecting && detected.length === 0 && (<span style={{ marginLeft: 10, fontSize: 13, color: 'var(--text-dimmer)' }}>or enter manually below</span>)}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={ollamaUrl} onChange={e => setOllamaUrl(e.target.value)} placeholder="http://your-server:11434"
                style={{ flex: 1, height: 42, padding: '0 12px', ...inputStyle, fontSize: 13, ...mono }} />
              <button onClick={handleConnect} disabled={!ollamaUrl || connecting}
                style={{ height: 42, padding: '0 22px', fontSize: 14, cursor: (!ollamaUrl || connecting) ? 'default' : 'pointer', ...primaryBtn, opacity: (!ollamaUrl || connecting) ? 0.5 : 1 }}>
                {connecting ? 'connecting...' : 'Connect'}
              </button>
            </div>
            {connectErr && (<div style={{ marginTop: 8, fontSize: 14, padding: '8px 10px', borderRadius: 6, ...errBox }}>✗ {connectErr}</div>)}
            {status?.connected && (
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: 14, color: 'var(--good)' }}>✓ Connected to {status.url} — {status.models.length} model{status.models.length !== 1 ? 's' : ''} installed</div>
                <button onClick={async () => { await fetch('/api/ai/disconnect', { method: 'DELETE' }); await fetchAll() }} style={{ fontSize: 13, padding: '6px 14px', borderRadius: 6, cursor: 'pointer', background: 'transparent', color: 'var(--crit)', border: '1px solid var(--crit)' }}>disconnect</button>
              </div>
            )}
          </div>
          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, padding: '1.5rem', opacity: 0.6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 4 }}>Deploy managed Ollama</div>
                <div style={{ fontSize: 14, color: 'var(--text-soft)' }}>HyperProx creates a dedicated Ollama LXC on your cluster automatically.</div>
              </div>
              <span style={badge('var(--text-dimmer)')}>v1.0</span>
            </div>
          </div>
        </div>
      )}
    </Page>
  )
}
