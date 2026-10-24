'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { wsBase } from '@/lib/ws'
import { alpha } from '@/lib/theme'
import { BoxIcon, SplitIcon, GlobeIcon, HourglassIcon, LockIcon, GearIcon, BoltIcon } from './icons'

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

interface WizardStep {
  id:          string
  type:        string
  label:       string
  description: string
  params:      Record<string, any>
}

interface DeployPlan {
  service:      string
  domain:       string
  understood:   string
  steps:        WizardStep[]
  requirements: { ram_mb: number; disk_gb: number; cpu_cores: number }
  warnings:     string[]
}

type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

interface LiveStep {
  id:           string
  type:         string
  label:        string
  status:       StepStatus
  output?:      string
  error?:       string
  commands?:    string[]
  startedAt?:   number
  completedAt?: number
}

interface JobProgress {
  jobId:       string
  status:      'queued' | 'running' | 'completed' | 'failed'
  currentStep: number
  totalSteps:  number
  steps:       LiveStep[]
  lxcVmid?:   number
  lxcNode?:   string
  lxcIp?:     string
}

// ── Style constants ───────────────────────────────────────────────────────────

const ACCENT = 'var(--violet)'
const BG     = 'var(--ground)'
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

const STEP_ICON: Record<string, (p: { size?: number }) => JSX.Element> = {
  create_lxc:       BoxIcon,
  configure_proxy:  SplitIcon,
  create_dns:       GlobeIcon,
  wait_propagation: HourglassIcon,
  request_ssl:      LockIcon,
  install_service:  GearIcon,
}

function stepIcon(type: string, size: number) {
  const Icon = STEP_ICON[type]
  return Icon ? <Icon size={size} /> : null
}

const STATUS_COLOR: Record<StepStatus, string> = {
  pending:   'var(--text-dimmer)',
  running:   'var(--warn)',
  completed: 'var(--good)',
  failed:    'var(--crit)',
  skipped:   'var(--text-muted)',
}

const STATUS_ICON: Record<StepStatus, string> = {
  pending:   '○',
  running:   '◎',
  completed: '✓',
  failed:    '✗',
  skipped:   '–',
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
      border:       `1px solid ${model.recommended ? ACCENT + '50' : BORDER}`,
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

// ── Live execution progress ───────────────────────────────────────────────────

function ExecutionView({ job, onDone }: { job: JobProgress; onDone: () => void }) {
  const elapsed = job.steps.filter(s => s.completedAt && s.startedAt)
    .reduce((t, s) => t + ((s.completedAt! - s.startedAt!) / 1000), 0)

  const isComplete = job.status === 'completed' || job.status === 'failed'

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      {/* Header */}
      <div style={{
        background: CARD,
        border: `1px solid ${job.status === 'failed' ? 'color-mix(in srgb, var(--crit) 19%, transparent)' : job.status === 'completed' ? 'color-mix(in srgb, var(--good) 19%, transparent)' : `${alpha(ACCENT, 19)}`}`,
        borderRadius: 10,
        padding: '1.5rem',
        marginBottom: '1rem',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 600, fontFamily: 'var(--font-display)', color: job.status === 'failed' ? 'var(--crit)' : job.status === 'completed' ? 'var(--good)' : 'var(--text-bright)', marginBottom: 4 }}>
              {job.status === 'completed' ? '✓ Deployment complete' :
               job.status === 'failed'    ? '✗ Deployment failed'   :
               `Deploying — step ${job.currentStep + 1} of ${job.totalSteps}`}
            </div>
            {job.lxcIp && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', ...mono }}>
                CT {job.lxcVmid} on {job.lxcNode} · {job.lxcIp}
              </div>
            )}
          </div>
          {isComplete && (
            <button onClick={onDone}
              style={{ padding: '8px 18px', fontSize: 14, cursor: 'pointer', ...primaryBtn }}>
              New deployment →
            </button>
          )}
        </div>

        {/* Progress bar */}
        {!isComplete && (
          <div style={{ marginTop: '1rem', height: 3, background: 'var(--border-dim)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              width:  `${((job.currentStep) / job.totalSteps) * 100}%`,
              background: ACCENT,
              borderRadius: 2,
              transition: 'width 0.5s ease',
              boxShadow: `0 0 8px ${ACCENT}`,
            }} />
          </div>
        )}
      </div>

      {/* Steps */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {job.steps.map((step, i) => {
          const sc      = STATUS_COLOR[step.status]
          const duration = step.startedAt && step.completedAt
            ? ((step.completedAt - step.startedAt) / 1000).toFixed(1) + 's'
            : null

          return (
            <div key={step.id} style={{
              background:   CARD,
              border:       `1px solid ${step.status === 'running' ? sc + '50' : BORDER}`,
              borderRadius: 10,
              padding:      '1rem 1.25rem',
              transition:   'border-color 0.2s',
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                {/* Status indicator */}
                <div style={{
                  width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: `${alpha(sc, 8)}`, border: `1px solid ${alpha(sc, 25)}`,
                  fontSize: 13, color: sc,
                  ...(step.status === 'running' ? { animation: 'pulse 1s infinite' } : {}),
                }}>
                  {step.status === 'running' ? stepIcon(step.type, 14) ?? '◎' : STATUS_ICON[step.status]}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: step.output || step.error || step.commands ? 6 : 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 600, color: step.status === 'pending' ? 'var(--text-dim)' : 'var(--text-bright)' }}>
                      {i + 1}. {step.label}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {duration && <span style={{ fontSize: 10, color: 'var(--text-dim)', ...mono }}>{duration}</span>}
                      <span style={{ ...badge(sc), fontSize: 9 }}>{step.status}</span>
                    </div>
                  </div>

                  {/* Output */}
                  {step.output && (
                    <div style={{ fontSize: 11, color: 'var(--good)', ...mono, background: 'var(--ground-deep)', padding: '6px 10px', borderRadius: 6, marginBottom: step.commands ? 8 : 0 }}>
                      {step.output}
                    </div>
                  )}

                  {/* Error */}
                  {step.error && (
                    <div style={{ fontSize: 11, ...mono, ...errBox, padding: '6px 10px', borderRadius: 6 }}>
                      ✗ {step.error}
                    </div>
                  )}

                  {/* Manual install commands */}
                  {step.commands && step.commands.length > 0 && (
                    <div style={{ marginTop: 6 }}>
                      <div style={{ fontSize: 13, color: 'var(--warn-2)', marginBottom: 4 }}>
                        <GearIcon size={13} /> Run these commands in CT {job.lxcVmid ?? '?'} console:
                      </div>
                      <div style={{ background: 'var(--ground-deep)', border: '1px solid var(--border-strong)', borderRadius: 6, padding: '8px 10px', overflow: 'auto', maxHeight: 160 }}>
                        {step.commands.map((cmd, ci) => (
                          <div key={ci} style={{ fontSize: 11, color: cmd.startsWith('#') ? 'var(--text-dim)' : 'var(--text-bright)', ...mono, lineHeight: 1.6 }}>
                            {cmd}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Job error */}
      {job.status === 'failed' && job.steps.every(s => s.status !== 'failed') && (
        <div style={{ marginTop: 12, padding: '10px 14px', ...errBox, borderRadius: 8, fontSize: 14 }}>
          ✗ Job failed: check step errors above
        </div>
      )}
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
  const [activeModel, setActiveModel] = useState<string>('llama3.2:3b')
  const [providers,   setProviders]   = useState<ProviderInfo[]>([])
  const [activeProv,  setActiveProv]  = useState<ProviderId>('ollama')
  const [provDraft,   setProvDraft]   = useState<Record<string, Record<string, string>>>({})
  const [provBusy,    setProvBusy]    = useState<string | null>(null)
  const [provResult,  setProvResult]  = useState<Record<string, string>>({})
  const [messages,    setMessages]    = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([])
  const [liveJob,     setLiveJob]     = useState<JobProgress | null>(null)
  const chatRef = useRef<HTMLDivElement>(null)
  const wsRef   = useRef<WebSocket | null>(null)

  const fetchAll = useCallback(async () => {
    const [statusRes, catalogRes, provRes] = await Promise.all([
      fetch('/api/ai/status'),
      fetch('/api/ai/catalog'),
      fetch('/api/ai/providers'),
    ])
    const [s, c, pr] = await Promise.all([statusRes.json(), catalogRes.json(), provRes.json()])
    setStatus(s)
    if (c.ok) setCatalog(c)
    if (pr.ok) { setProviders(pr.providers); setActiveProv(pr.active) }
    setLoading(false)
  }, [])

  // Which provider is selected, and whether it can actually be used. Ollama is
  // "configured" as soon as an address is stored, but it is only usable once
  // that address answers — hence the two different checks.
  const activeInfo     = providers.find(p => p.id === activeProv) ?? null
  const providerReady  = activeProv === 'ollama'
    ? Boolean(status?.connected)
    : Boolean(activeInfo?.configured)

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
        ? `✓ ${data.sample.steps}-step plan in ${(data.ms / 1000).toFixed(1)}s`
        : `✗ ${data.error}`,
    }))
  }

  useEffect(() => { fetchAll() }, [fetchAll])

  // WebSocket — listen for wizard_progress events
  useEffect(() => {
    const ws = new WebSocket(wsBase())
    wsRef.current = ws

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        if (msg.type === 'wizard_progress') {
          setLiveJob(msg.payload as JobProgress)
        }
      } catch { /* ignore */ }
    }

    return () => ws.close()
  }, [])

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
      // The model override only means anything for Ollama, where the dropdown
      // lists what is installed. Cloud models are set once, in Settings.
      body:    JSON.stringify(activeProv === 'ollama'
        ? { prompt: userMsg, provider: activeProv, model: activeModel }
        : { prompt: userMsg, provider: activeProv }),
    })
    const data = await res.json()
    setPlanning(false)

    if (data.ok && data.plan) {
      setPlan(data.plan)
      setMessages(m => [...m, {
        role:    'assistant',
        content: data.plan.domain
          ? `Got it — here's my plan to deploy ${data.plan.service} at ${data.plan.domain}. Review the steps below and confirm to execute.`
          : `Here's my plan to deploy ${data.plan.service}. Read the warnings first — it is not ready to run as written.`,
      }])
    } else if (data.ok && data.conversational) {
      // Not every prompt is a deployment. Say what came back rather than
      // reporting a failure that did not happen.
      setMessages(m => [...m, { role: 'assistant', content: data.message }])
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
      setPlan(null)
      setMessages([])
      // liveJob will populate via WebSocket
      // Seed it immediately so the UI switches right away
      const seedJob = {
        jobId:       data.jobId,
        status:      'queued' as const,
        currentStep: 0,
        totalSteps:  plan.steps.length,
        steps:       plan.steps.map(s => ({ ...s, status: 'pending' as const })),
      }
      setLiveJob(seedJob)
      // REST polling fallback in case WS misses events
      const pollId = setInterval(async () => {
        const r = await fetch(`/api/ai/wizard/jobs/${data.jobId}`)
        const j = await r.json()
        if (j.ok) setLiveJob(j)
        if (j.status === 'completed' || j.status === 'failed') clearInterval(pollId)
      }, 2000)
    }
  }

  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: BG }}>
      <div style={{ fontSize: 14, color: 'var(--text-dimmer)' }}>initializing ai...</div>
    </div>
  )

  return (
    <div style={{ minHeight: '100vh', padding: '2rem 2.5rem', background: BG }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--accent)', marginBottom: 8, ...mono }}>
              {providerReady
                ? `${activeInfo?.name ?? 'provider'} · ${activeInfo?.model ?? ''}`
                : `${activeInfo?.name ?? 'no provider'} not ready — configure it in Settings`}
            </div>
            <h1 className="font-display" style={{ fontSize: 36, fontWeight: 700, color: 'var(--text-bright)', lineHeight: 1.1 }}>
              AI Assistant
            </h1>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: providerReady ? 'var(--good)' : 'var(--crit)', boxShadow: providerReady ? '0 0 6px var(--good)' : 'none' }} />
          <span style={{ fontSize: 12, letterSpacing: '0.1em', color: providerReady ? 'var(--good)' : 'var(--crit)', ...mono }}>
            {providerReady ? 'READY' : 'NOT READY'}
          </span>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: '1.5rem', borderBottom: `1px solid ${BORDER}` }}>
        {(['wizard', 'models', 'settings'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{
              padding: '10px 18px', fontSize: 15, fontWeight: 600, cursor: 'pointer',
              background: 'transparent', color: tab === t ? 'var(--accent)' : 'var(--text-dim)',
              border: 'none', borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
              textTransform: 'capitalize', transition: 'color .15s',
            }}
          >{t}</button>
        ))}
      </div>

      {/* ── WIZARD TAB ── */}
      {tab === 'wizard' && (
        <>
          {/* Live execution view */}
          {liveJob ? (
            <ExecutionView
              job={liveJob}
              onDone={() => setLiveJob(null)}
            />
          ) : (
            <div style={{ maxWidth: 760, margin: '0 auto' }}>
              {!providerReady && (
                <div style={{ background: `${alpha(ACCENT, 6)}`, border: `1px solid ${alpha(ACCENT, 15)}`, borderRadius: 10, padding: '1rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ display: 'flex', color: ACCENT }}><BoltIcon size={20} /></span>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: ACCENT, marginBottom: 2 }}>
                      {activeInfo?.name ?? 'No AI provider'} is not ready
                    </div>
                    <div style={{ fontSize: 14, color: 'var(--text-soft)' }}>
                      {activeInfo?.missing?.length
                        ? `Add its ${activeInfo.missing.join(' and ')} in the `
                        : 'Finish configuring it in the '}
                      <button onClick={() => setTab('settings')} style={{ color: ACCENT, background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, textDecoration: 'underline' }}>
                        Settings tab
                      </button>
                      {' '}to use the deployment wizard.
                    </div>
                  </div>
                </div>
              )}
              <div ref={chatRef} style={{ minHeight: 200, maxHeight: 360, overflowY: 'auto', marginBottom: '1rem', display: 'flex', flexDirection: 'column', gap: 12 }}>
                {messages.length === 0 && (
                  <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-dimmer)', fontSize: 14 }}>
                    <div style={{ fontSize: 32, marginBottom: 12 }}>✦</div>
                    <div className="font-display" style={{ marginBottom: 12, color: 'var(--text-bright)', fontSize: 22, fontWeight: 600 }}>Describe what you want to deploy</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 320, margin: '0 auto' }}>
                      {[
                        '"Deploy Nextcloud at cloud.mydomain.com"',
                        '"Set up Jellyfin at media.home.net"',
                        '"Install Vaultwarden at vault.yourdomain.com"',
                      ].map(ex => (
                        <button key={ex} onClick={() => setPrompt(ex.replace(/"/g, ''))}
                          style={{ padding: '8px 12px', borderRadius: 6, fontSize: 13, cursor: 'pointer', ...mono, background: 'var(--surface)', color: 'var(--text-soft)', border: `1px solid ${BORDER}`, textAlign: 'left', transition: 'border-color .15s' }}
                          onMouseEnter={e => (e.currentTarget as HTMLElement).style.borderColor = ACCENT + '40'}
                          onMouseLeave={e => (e.currentTarget as HTMLElement).style.borderColor = BORDER}
                        >{ex}</button>
                      ))}
                    </div>
                  </div>
                )}
                {messages.map((msg, i) => (
                  <div key={i} style={{ alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '80%', padding: '10px 14px', borderRadius: 10, fontSize: 15, lineHeight: 1.55, background: msg.role === 'user' ? `${alpha(ACCENT, 8)}` : CARD, color: msg.role === 'user' ? ACCENT : 'var(--text-bright)', border: `1px solid ${msg.role === 'user' ? ACCENT + '30' : BORDER}` }}>{msg.content}</div>
                ))}
                {planning && (
                  <div style={{ alignSelf: 'flex-start', padding: '10px 14px', borderRadius: 10, background: CARD, border: `1px solid ${BORDER}`, fontSize: 14, color: 'var(--text-muted)' }}>thinking...</div>
                )}
              </div>
              {plan && (
                <div style={{ background: CARD, border: `1px solid ${alpha(ACCENT, 19)}`, borderRadius: 10, padding: '1.5rem', marginBottom: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                    <div>
                      <div className="font-display" style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 2 }}>{plan.service} → {plan.domain}</div>
                      <div style={{ fontSize: 14, color: 'var(--text-soft)' }}>{plan.understood}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, fontSize: 11, ...mono }}>
                      <span style={badge('var(--text-muted)')}>{plan.requirements.ram_mb}MB RAM</span>
                      <span style={badge('var(--text-muted)')}>{plan.requirements.disk_gb}GB disk</span>
                      <span style={badge('var(--text-muted)')}>{plan.requirements.cpu_cores} vCPU</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: '1rem' }}>
                    {plan.steps.map((step, i) => (
                      <div key={step.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, background: 'var(--ground)', border: `1px solid ${BORDER}` }}>
                        <div style={{ fontSize: 16, width: 24, textAlign: 'center' }}>{stepIcon(step.type, 16) ?? '▸'}</div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-bright)' }}>{i + 1}. {step.label}</div>
                          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{step.description}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                  {plan.warnings.length > 0 && (
                    <div style={{ background: 'color-mix(in srgb, var(--warn) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--warn) 35%, transparent)', borderRadius: 8, padding: '10px 12px', marginBottom: '1rem' }}>
                      {plan.warnings.map((w, i) => (
                        <div key={i} style={{ fontSize: 14, color: 'var(--warn-2)' }}>⚠ {w}</div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button onClick={() => setPlan(null)} style={{ padding: '10px 18px', fontSize: 14, cursor: 'pointer', ...secondaryBtn }}>Cancel</button>
                    <button onClick={() => { if (window.confirm(`Execute ${plan?.steps?.length} steps to deploy ${plan?.service}?`)) handleExecute() }} disabled={executing}
                      style={{ padding: '10px 22px', fontSize: 14, cursor: executing ? 'default' : 'pointer', ...primaryBtn, opacity: executing ? 0.6 : 1 }}>
                      {executing ? 'Starting...' : `Execute ${plan.steps.length} steps →`}
                    </button>
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>Provider:</span>
                <select value={activeProv} onChange={e => selectProvider(e.target.value as ProviderId)}
                  style={{ padding: '8px 12px', ...inputStyle, fontSize: 13, cursor: 'pointer' }}>
                  {providers.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name}{p.configured ? '' : ' — not configured'}
                    </option>
                  ))}
                </select>
                {activeProv === 'ollama' ? (
                  <select value={activeModel} onChange={e => { setActiveModel(e.target.value); fetch('/api/ai/model/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: e.target.value }) }) }}
                    style={{ flex: 1, padding: '8px 12px', ...inputStyle, fontSize: 13, ...mono, cursor: 'pointer' }}>
                    {(status?.models ?? []).map((m: any) => (<option key={m.name} value={m.name}>{m.name}</option>))}
                  </select>
                ) : (
                  <span style={{ flex: 1, fontSize: 11, color: 'var(--text-dim)', ...mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {activeInfo?.model}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleWizardSubmit()}
                  placeholder='Deploy Nextcloud at cloud.mydomain.com...'
                  disabled={!providerReady || planning}
                  style={{ flex: 1, padding: '11px 14px', ...inputStyle, fontSize: 15, opacity: (!providerReady || planning) ? 0.5 : 1 }} />
                <button onClick={handleWizardSubmit} disabled={!prompt.trim() || !providerReady || planning}
                  style={{ padding: '10px 22px', fontSize: 15, cursor: (!prompt.trim() || !providerReady || planning) ? 'default' : 'pointer', ...primaryBtn, opacity: (!prompt.trim() || !providerReady || planning) ? 0.4 : 1 }}>
                  {planning ? '...' : '→'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {tab === 'models' && (
        <div>
          {catalog?.hardware && (
            <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, padding: '1.25rem 1.5rem', marginBottom: '2rem', display: 'flex', gap: '2rem' }}>
              <div><div style={{ fontSize: 10, color: 'var(--text-dim)', ...mono, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 }}>Cluster RAM</div><div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-bright)', ...mono }}>{catalog.hardware.totalRamGB.toFixed(0)}GB</div></div>
              <div><div style={{ fontSize: 10, color: 'var(--text-dim)', ...mono, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 }}>GPU VRAM</div><div style={{ fontSize: 20, fontWeight: 700, color: catalog.hardware.maxVramGB > 0 ? ACCENT : 'var(--text-dimmer)', ...mono }}>{catalog.hardware.maxVramGB > 0 ? `${catalog.hardware.maxVramGB.toFixed(0)}GB` : 'none'}</div></div>
              <div><div style={{ fontSize: 10, color: 'var(--text-dim)', ...mono, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 }}>CPU Cores</div><div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-bright)', ...mono }}>{catalog.hardware.totalCores}</div></div>
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}><div style={{ fontSize: 14, color: 'var(--text-soft)', maxWidth: 260 }}>Models marked <span style={{ color: ACCENT }}><BoltIcon size={12} /> recommended</span> are best for your hardware.</div></div>
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
              <div key={p.id} style={{ background: CARD, border: `1px solid ${p.id === activeProv ? ACCENT + '40' : BORDER}`, borderRadius: 10, padding: '1.5rem', marginBottom: '1rem' }}>
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
              {detected.length > 0 && (<div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>{detected.map(d => (<button key={d.url} onClick={() => setOllamaUrl(d.url)} style={{ padding: '6px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer', textAlign: 'left', ...mono, background: ollamaUrl === d.url ? `${alpha(ACCENT, 8)}` : 'var(--surface-raised)', color: ollamaUrl === d.url ? ACCENT : 'var(--text-muted)', border: `1px solid ${ollamaUrl === d.url ? ACCENT + '30' : BORDER}` }}>✓ {d.name} — {d.url}</button>))}</div>)}
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
    </div>
  )
}
