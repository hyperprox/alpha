'use client'

import { useEffect, useState, useCallback, useRef } from 'react'

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

interface WizardStep {
  id:          string
  type:        string
  label:       string
  description: string
  params:      Record<string, any>
}

interface DeployPlan {
  service:     string
  domain:      string
  understood:  string
  steps:       WizardStep[]
  requirements: { ram_mb: number; disk_gb: number; cpu_cores: number }
  warnings:    string[]
}

// ── Style constants ───────────────────────────────────────────────────────────

const ACCENT = '#a78bfa'
const BG     = '#080c14'
const CARD   = '#0d1220'
const BORDER = '#1a2035'

const mono: React.CSSProperties = { fontFamily: 'IBM Plex Mono, monospace' }

const badge = (color: string): React.CSSProperties => ({
  display:       'inline-flex',
  alignItems:    'center',
  padding:       '2px 8px',
  borderRadius:  99,
  fontSize:      10,
  fontWeight:    600,
  fontFamily:    'IBM Plex Mono, monospace',
  background:    `${color}18`,
  color,
  border:        `1px solid ${color}30`,
})

const TIER_COLOR: Record<string, string> = {
  nano:   '#6b7280',
  small:  '#22c55e',
  medium: '#00e5ff',
  large:  '#a78bfa',
}

const STEP_ICON: Record<string, string> = {
  create_lxc:       '📦',
  configure_proxy:  '🔀',
  create_dns:       '🌐',
  wait_propagation: '⏳',
  request_ssl:      '🔒',
  install_service:  '⚙️',
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ marginBottom: '1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <div style={{ width: 3, height: 20, borderRadius: 2, background: ACCENT, boxShadow: `0 0 8px ${ACCENT}` }} />
        <h2 style={{ fontSize: 16, fontWeight: 700, color: ACCENT, textTransform: 'uppercase', letterSpacing: 1.5, ...mono }}>
          {title}
        </h2>
      </div>
      {subtitle && <p style={{ fontSize: 13, color: '#4b5563', marginLeft: 13 }}>{subtitle}</p>}
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
  const tierColor = TIER_COLOR[model.tier] ?? '#6b7280'
  const isPulling = pulling === model.id

  return (
    <div style={{
      background:   CARD,
      border:       `1px solid ${model.recommended ? ACCENT + '50' : BORDER}`,
      borderRadius: 12,
      padding:      '1rem',
      position:     'relative',
      transition:   'border-color .15s',
    }}>
      {model.recommended && (
        <div style={{
          position:   'absolute',
          top:        -10,
          left:       12,
          ...badge(ACCENT),
          fontSize:   9,
        }}>⚡ RECOMMENDED</div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', marginBottom: 2 }}>{model.name}</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            <span style={badge(tierColor)}>{model.params}</span>
            <span style={badge('#374151')}>{model.sizeGB}GB</span>
            {model.good_for_wizard && <span style={badge('#22c55e')}>✓ wizard-ready</span>}
            {model.installed && <span style={badge('#22c55e')}>installed</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {!model.installed ? (
            <button
              onClick={() => onPull(model.id)}
              disabled={!!pulling}
              style={{
                padding:      '5px 12px',
                borderRadius: 6,
                fontSize:     11,
                fontWeight:   600,
                cursor:       pulling ? 'default' : 'pointer',
                ...mono,
                background:   isPulling ? `${ACCENT}20` : `${ACCENT}15`,
                color:        isPulling ? `${ACCENT}80` : ACCENT,
                border:       `1px solid ${ACCENT}30`,
              }}
            >
              {isPulling ? '↓ pulling...' : '↓ install'}
            </button>
          ) : (
            <button
              onClick={() => onDelete(model.id)}
              style={{
                padding:      '5px 10px',
                borderRadius: 6,
                fontSize:     11,
                cursor:       'pointer',
                ...mono,
                background:   'transparent',
                color:        '#374151',
                border:       '1px solid transparent',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#ef4444'; (e.currentTarget as HTMLElement).style.borderColor = '#ef444430' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = '#374151'; (e.currentTarget as HTMLElement).style.borderColor = 'transparent' }}
            >✕ remove</button>
          )}
        </div>
      </div>

      <p style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.5, marginBottom: 10 }}>{model.description}</p>

      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {model.strengths.map(s => (
          <span key={s} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: '#111827', color: '#9ca3af', ...mono }}>{s}</span>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 12, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${BORDER}` }}>
        <div style={{ fontSize: 10, color: '#374151', ...mono }}>
          RAM: <span style={{ color: model.fits_cpu ? '#22c55e' : '#ef4444' }}>{model.ramGB}GB</span>
        </div>
        <div style={{ fontSize: 10, color: '#374151', ...mono }}>
          VRAM: <span style={{ color: model.fits_gpu ? '#22c55e' : '#6b7280' }}>{model.vramGB}GB</span>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AIPage() {
  const [tab,         setTab]         = useState<'wizard' | 'models' | 'settings'>('wizard')
  const [status,      setStatus]      = useState<OllamaStatus | null>(null)
  const [catalog,     setCatalog]     = useState<CatalogData | null>(null)
  const [loading,     setLoading]     = useState(true)
  const [pulling,     setPulling]     = useState<string | null>(null)
  const [ollamaUrl,   setOllamaUrl]   = useState('')
  const [detecting,   setDetecting]   = useState(false)
  const [detected,    setDetected]    = useState<Array<{url:string;name:string;vmid:number}>>([])
  const [connecting,  setConnecting]  = useState(false)
  const [connectErr,  setConnectErr]  = useState<string | null>(null)

  // Wizard state
  const [prompt,      setPrompt]      = useState('')
  const [planning,    setPlanning]    = useState(false)
  const [plan,        setPlan]        = useState<DeployPlan | null>(null)
  const [planErr,     setPlanErr]     = useState<string | null>(null)
  const [executing,   setExecuting]   = useState(false)
  const [activeModel, setActiveModel] = useState<string>("llama3.2:3b")
  const [messages,    setMessages]    = useState<Array<{ role: "user" | "assistant"; content: string }>>([])
  const chatRef = useRef<HTMLDivElement>(null)

  const fetchAll = useCallback(async () => {
    const [statusRes, catalogRes] = await Promise.all([
      fetch('/api/ai/status'),
      fetch('/api/ai/catalog'),
    ])
    const [s, c] = await Promise.all([statusRes.json(), catalogRes.json()])
    setStatus(s)
    if (c.ok) setCatalog(c)
    setLoading(false)
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight
  }, [messages, plan])

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
    // Poll until installed
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

  const handleWizardSubmit = async () => {
    if (!prompt.trim() || planning) return
    const userMsg = prompt.trim()
    setPrompt('')
    setPlan(null)
    setPlanErr(null)
    setPlanning(true)
    setMessages(m => [...m, { role: 'user', content: userMsg }])

    const res  = await fetch('/api/ai/wizard/plan', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ prompt: userMsg, model: activeModel }),
    })
    const data = await res.json()
    setPlanning(false)

    if (data.ok && data.plan) {
      setPlan(data.plan)
      setMessages(m => [...m, {
        role:    'assistant',
        content: `Got it — here's my plan to deploy **${data.plan.service}** at **${data.plan.domain}**. Review the steps below and confirm to execute.`,
      }])
    } else {
      const err = data.error ?? 'Failed to generate plan'
      setPlanErr(err)
      setMessages(m => [...m, { role: 'assistant', content: `Error: ${err}` }])
    }
  }

  const handleExecute = async () => {
    if (!plan) return
    setExecuting(true)
    const res  = await fetch('/api/ai/wizard/execute', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ plan }),
    })
    const data = await res.json()
    setExecuting(false)
    if (data.ok) {
      setMessages(m => [...m, {
        role:    'assistant',
        content: `Executing! Job ID: ${data.jobId}. Tracking ${data.steps} steps...`,
      }])
      setPlan(null)
    }
  }

  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: BG }}>
      <div style={{ fontSize: 12, color: '#374151', ...mono, animation: 'pulse 1.5s infinite' }}>initializing ai...</div>
    </div>
  )

  return (
    <div style={{ minHeight: '100vh', padding: '1.5rem', background: BG }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 4, height: 28, borderRadius: 2, background: ACCENT, boxShadow: `0 0 10px ${ACCENT}` }} />
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: ACCENT, textTransform: 'uppercase', letterSpacing: 2, ...mono }}>
              AI Assistant
            </h1>
            <div style={{ fontSize: 11, color: '#4b5563', ...mono }}>
              {status?.connected
                ? `connected · ${status.models.length} model${status.models.length !== 1 ? 's' : ''} installed`
                : 'not connected — configure Ollama below'}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: status?.connected ? '#22c55e' : '#ef4444', boxShadow: status?.connected ? '0 0 6px #22c55e' : 'none' }} />
          <span style={{ fontSize: 11, color: status?.connected ? '#22c55e' : '#ef4444', ...mono }}>
            {status?.connected ? 'ONLINE' : 'OFFLINE'}
          </span>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: '1.5rem', borderBottom: `1px solid ${BORDER}`, paddingBottom: 0 }}>
        {(['wizard', 'models', 'settings'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{
              padding:       '8px 16px',
              fontSize:      12,
              fontWeight:    600,
              cursor:        'pointer',
              ...mono,
              background:    'transparent',
              color:         tab === t ? ACCENT : '#4b5563',
              border:        'none',
              borderBottom:  tab === t ? `2px solid ${ACCENT}` : '2px solid transparent',
              textTransform: 'uppercase',
              letterSpacing: 0.8,
              transition:    'color .15s',
            }}
          >{t}</button>
        ))}
      </div>

      {/* ── WIZARD TAB ── */}
      {tab === 'wizard' && (
        <div style={{ maxWidth: 760, margin: '0 auto' }}>
          {!status?.connected && (
            <div style={{ background: `${ACCENT}10`, border: `1px solid ${ACCENT}25`, borderRadius: 10, padding: '1rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 20 }}>⚡</span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: ACCENT, marginBottom: 2 }}>Ollama not connected</div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>
                  Connect an Ollama instance in the{' '}
                  <button onClick={() => setTab('settings')} style={{ color: ACCENT, background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }}>
                    Settings tab
                  </button>
                  {' '}to use the deployment wizard.
                </div>
              </div>
            </div>
          )}

          {/* Chat history */}
          <div ref={chatRef} style={{
            minHeight:   200,
            maxHeight:   360,
            overflowY:   'auto',
            marginBottom: '1rem',
            display:     'flex',
            flexDirection: 'column',
            gap:         12,
          }}>
            {messages.length === 0 && (
              <div style={{ textAlign: 'center', padding: '2rem', color: '#374151', fontSize: 12, ...mono }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>✦</div>
                <div style={{ marginBottom: 8, color: '#6b7280' }}>Describe what you want to deploy</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 320, margin: '0 auto' }}>
                  {[
                    '"Deploy Nextcloud at cloud.mydomain.com"',
                    '"Set up Jellyfin at media.home.net"',
                    '"Install Vaultwarden at vault.yourdomain.com"',
                  ].map(ex => (
                    <button key={ex} onClick={() => setPrompt(ex.replace(/"/g, ''))}
                      style={{
                        padding:      '6px 12px',
                        borderRadius: 6,
                        fontSize:     11,
                        cursor:       'pointer',
                        ...mono,
                        background:   '#0d1220',
                        color:        '#6b7280',
                        border:       `1px solid ${BORDER}`,
                        textAlign:    'left',
                        transition:   'border-color .15s',
                      }}
                      onMouseEnter={e => (e.currentTarget as HTMLElement).style.borderColor = ACCENT + '40'}
                      onMouseLeave={e => (e.currentTarget as HTMLElement).style.borderColor = BORDER}
                    >{ex}</button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} style={{
                alignSelf:    msg.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth:     '80%',
                padding:      '10px 14px',
                borderRadius: 10,
                fontSize:     13,
                lineHeight:   1.5,
                background:   msg.role === 'user' ? `${ACCENT}15` : CARD,
                color:        msg.role === 'user' ? ACCENT : '#e2e8f0',
                border:       `1px solid ${msg.role === 'user' ? ACCENT + '30' : BORDER}`,
                ...mono,
              }}>{msg.content}</div>
            ))}

            {planning && (
              <div style={{ alignSelf: 'flex-start', padding: '10px 14px', borderRadius: 10, background: CARD, border: `1px solid ${BORDER}`, fontSize: 12, color: '#6b7280', ...mono }}>
                <span style={{ animation: 'pulse 1s infinite' }}>thinking...</span>
              </div>
            )}
          </div>

          {/* Action plan preview */}
          {plan && (
            <div style={{ background: CARD, border: `1px solid ${ACCENT}30`, borderRadius: 12, padding: '1.25rem', marginBottom: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: ACCENT, ...mono, marginBottom: 2 }}>
                    {plan.service} → {plan.domain}
                  </div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>{plan.understood}</div>
                </div>
                <div style={{ display: 'flex', gap: 6, fontSize: 11, ...mono }}>
                  <span style={badge('#6b7280')}>{plan.requirements.ram_mb}MB RAM</span>
                  <span style={badge('#6b7280')}>{plan.requirements.disk_gb}GB disk</span>
                  <span style={badge('#6b7280')}>{plan.requirements.cpu_cores} vCPU</span>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: '1rem' }}>
                {plan.steps.map((step, i) => (
                  <div key={step.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, background: '#080c14', border: `1px solid ${BORDER}` }}>
                    <div style={{ fontSize: 16, width: 24, textAlign: 'center' }}>{STEP_ICON[step.type] ?? '▸'}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0', ...mono }}>{i + 1}. {step.label}</div>
                      <div style={{ fontSize: 11, color: '#6b7280' }}>{step.description}</div>
                    </div>
                  </div>
                ))}
              </div>

              {plan.warnings.length > 0 && (
                <div style={{ background: `rgba(245,158,11,0.08)`, border: '1px solid rgba(245,158,11,0.2)', borderRadius: 8, padding: '10px 12px', marginBottom: '1rem' }}>
                  {plan.warnings.map((w, i) => (
                    <div key={i} style={{ fontSize: 12, color: '#f59e0b', ...mono }}>⚠ {w}</div>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => setPlan(null)}
                  style={{ padding: '8px 16px', borderRadius: 8, fontSize: 12, cursor: 'pointer', ...mono, background: 'transparent', color: '#6b7280', border: `1px solid ${BORDER}` }}>
                  Cancel
                </button>
                <button onClick={() => { if (window.confirm(`Execute ${plan?.steps?.length} steps to deploy ${plan?.service}? This will create infrastructure on your cluster.`)) handleExecute() }} disabled={executing}
                  style={{
                    padding:      '8px 20px',
                    borderRadius: 8,
                    fontSize:     12,
                    fontWeight:   700,
                    cursor:       executing ? 'default' : 'pointer',
                    ...mono,
                    background:   executing ? `${ACCENT}20` : `${ACCENT}15`,
                    color:        executing ? `${ACCENT}60` : ACCENT,
                    border:       `1px solid ${ACCENT}30`,
                  }}>
                  {executing ? 'Executing...' : `Execute ${plan.steps.length} steps →`}
                </button>
              </div>
            </div>
          )}

          {/* Model selector + Input */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: '#4b5563', fontFamily: 'IBM Plex Mono, monospace', whiteSpace: 'nowrap' }}>Model:</span>
            <select
              value={activeModel}
              onChange={e => {
                setActiveModel(e.target.value)
                fetch('/api/ai/model/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: e.target.value }) })
              }}
              style={{ flex: 1, padding: '5px 10px', borderRadius: 6, background: '#0d1220', border: '1px solid #1a2035', color: '#e2e8f0', fontSize: 12, fontFamily: 'IBM Plex Mono, monospace', outline: 'none', cursor: 'pointer' }}
            >
              {(status?.models ?? []).map((m: any) => (
                <option key={m.name} value={m.name}>{m.name}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleWizardSubmit()}
              placeholder='Deploy Nextcloud at cloud.mydomain.com...'
              disabled={!status?.connected || planning}
              style={{
                flex:         1,
                padding:      '10px 14px',
                borderRadius: 8,
                background:   CARD,
                border:       `1px solid ${BORDER}`,
                color:        '#e2e8f0',
                fontSize:     13,
                outline:      'none',
                ...mono,
                opacity:      (!status?.connected || planning) ? 0.5 : 1,
              }}
            />
            <button
              onClick={handleWizardSubmit}
              disabled={!prompt.trim() || !status?.connected || planning}
              style={{
                padding:      '10px 18px',
                borderRadius: 8,
                fontSize:     12,
                fontWeight:   700,
                cursor:       (!prompt.trim() || !status?.connected || planning) ? 'default' : 'pointer',
                ...mono,
                background:   `${ACCENT}15`,
                color:        ACCENT,
                border:       `1px solid ${ACCENT}30`,
                opacity:      (!prompt.trim() || !status?.connected || planning) ? 0.4 : 1,
              }}>
              {planning ? '...' : '→'}
            </button>
          </div>
        </div>
      )}

      {/* ── MODELS TAB ── */}
      {tab === 'models' && (
        <div>
          {catalog?.hardware && (
            <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: '1rem', marginBottom: '1.5rem', display: 'flex', gap: '2rem' }}>
              <div>
                <div style={{ fontSize: 10, color: '#4b5563', ...mono, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 }}>Cluster RAM</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#e2e8f0', ...mono }}>{catalog.hardware.totalRamGB.toFixed(0)}GB</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: '#4b5563', ...mono, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 }}>GPU VRAM</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: catalog.hardware.maxVramGB > 0 ? ACCENT : '#374151', ...mono }}>
                  {catalog.hardware.maxVramGB > 0 ? `${catalog.hardware.maxVramGB.toFixed(0)}GB` : 'none'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: '#4b5563', ...mono, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 }}>CPU Cores</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#e2e8f0', ...mono }}>{catalog.hardware.totalCores}</div>
              </div>
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
                <div style={{ fontSize: 12, color: '#6b7280', maxWidth: 240 }}>
                  Models marked <span style={{ color: ACCENT }}>⚡ recommended</span> are best for your hardware.
                </div>
              </div>
            </div>
          )}

          <SectionHeader title="Model Library" subtitle="Download and manage AI models. Recommended models are highlighted for your hardware." />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
            {(catalog?.catalog ?? []).map(model => (
              <ModelCard
                key={model.id}
                model={model}
                onPull={handlePull}
                onDelete={handleDelete}
                pulling={pulling}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── SETTINGS TAB ── */}
      {tab === 'settings' && (
        <div style={{ maxWidth: 560 }}>
          <SectionHeader title="Ollama Connection" subtitle="Connect to an existing Ollama instance or deploy a managed one." />

          {/* Existing instance */}
          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: '1.25rem', marginBottom: '1rem' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', marginBottom: 4 }}>Connect existing Ollama</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: '1rem' }}>
              Already running Ollama on another machine? Point HyperProx at it.
            </div>
            <div style={{ marginBottom: 8 }}>
              <button
                onClick={async () => {
                  setDetecting(true)
                  setDetected([])
                  const res  = await fetch('/api/ai/detect')
                  const data = await res.json()
                  setDetected(data.found ?? [])
                  setDetecting(false)
                  if (data.found?.length === 1) setOllamaUrl(data.found[0].url)
                }}
                disabled={detecting}
                style={{ padding: '7px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: detecting ? 'default' : 'pointer', ...mono, background: `${ACCENT}10`, color: ACCENT, border: `1px solid ${ACCENT}25`, opacity: detecting ? 0.6 : 1 }}
              >{detecting ? '⟳ scanning cluster...' : '⟳ auto-detect'}</button>
              {detected.length > 0 && (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {detected.map(d => (
                    <button key={d.url} onClick={() => setOllamaUrl(d.url)}
                      style={{ padding: '6px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer', textAlign: 'left', ...mono, background: ollamaUrl === d.url ? `${ACCENT}15` : '#0a0f1a', color: ollamaUrl === d.url ? ACCENT : '#6b7280', border: `1px solid ${ollamaUrl === d.url ? ACCENT + '30' : BORDER}` }}>
                      ✓ {d.name} — {d.url}
                    </button>
                  ))}
                </div>
              )}
              {!detecting && detected.length === 0 && (
                <span style={{ marginLeft: 10, fontSize: 11, color: '#374151', ...mono }}>or enter manually below</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={ollamaUrl}
                onChange={e => setOllamaUrl(e.target.value)}
                placeholder="http://your-server:11434"
                style={{
                  flex:         1,
                  padding:      '8px 12px',
                  borderRadius: 8,
                  background:   '#080c14',
                  border:       `1px solid ${BORDER}`,
                  color:        '#e2e8f0',
                  fontSize:     13,
                  outline:      'none',
                  ...mono,
                }}
              />
              <button
                onClick={handleConnect}
                disabled={!ollamaUrl || connecting}
                style={{
                  padding:      '8px 16px',
                  borderRadius: 8,
                  fontSize:     12,
                  fontWeight:   600,
                  cursor:       (!ollamaUrl || connecting) ? 'default' : 'pointer',
                  ...mono,
                  background:   `${ACCENT}15`,
                  color:        ACCENT,
                  border:       `1px solid ${ACCENT}30`,
                  opacity:      (!ollamaUrl || connecting) ? 0.5 : 1,
                }}>
                {connecting ? 'connecting...' : 'Connect'}
              </button>
            </div>
            {connectErr && (
              <div style={{ marginTop: 8, fontSize: 12, color: '#ef4444', padding: '8px 10px', background: 'rgba(239,68,68,0.08)', borderRadius: 6, border: '1px solid rgba(239,68,68,0.2)', ...mono }}>
                ✗ {connectErr}
              </div>
            )}
            {status?.connected && (
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: 12, color: '#22c55e', ...mono }}>
                  ✓ Connected to {status.url} — {status.models.length} model{status.models.length !== 1 ? 's' : ''} installed
                </div>
                <button
                  onClick={async () => {
                    await fetch('/api/ai/disconnect', { method: 'DELETE' })
                    await fetchAll()
                  }}
                  style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', ...mono, background: 'transparent', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}
                >disconnect</button>
              </div>
            )}
          </div>

          {/* Deploy managed */}
          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: '1.25rem', opacity: 0.6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', marginBottom: 4 }}>Deploy managed Ollama</div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>
                  HyperProx creates a dedicated Ollama LXC on your cluster automatically.
                </div>
              </div>
              <span style={badge('#374151')}>v1.0</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
