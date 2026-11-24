'use client'

// =============================================================================
//  HyperProx — the AI assistant, inside the side panel
//
//  The assistant that used to be the "Wizard" tab on the AI page: ask about clusters, a NAS, the house or websites, or
//  describe something to deploy. It plans first and runs nothing until the plan or action card is confirmed. Moved here so
//  it stays open while you move between pages; the provider and model settings are still on AI.
// =============================================================================

import { useEffect, useState, useRef } from 'react'
import { wsBase } from '@/lib/ws'
import { alpha } from '@/lib/theme'
import { pickOllamaModel } from '@/lib/ollama-model'
import { assistantMode, exampleChips, CONNECT_MODEL_WORDS } from '@/lib/ai-assistant-mode'
import { BoxIcon, SplitIcon, GlobeIcon, HourglassIcon, LockIcon, GearIcon, BoltIcon } from '@/app/ai/icons'
import { CLUSTER_HEADER, apiJson } from '@/lib/api'
import { ClusterPicker, ClusterChip, ActionCard, type ActionCardData, type ClusterRef } from '@/components/ai/ClusterAssistant'
import { SourcesUsed } from '@/components/ai/SourcesUsed'
import { sourcesUsed } from '@/lib/ai-sources'

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
  id:    string
  type:  string
  label: string
}

interface DeployPlan {
  service:    string
  domain:     string
  understood: string
  steps:      WizardStep[]
  warnings:   string[]
}

/** One field of the template, as the server derived it: what it is and where it came from. */
interface PlanField {
  value:  unknown
  source: 'user' | 'fact' | 'derived' | 'fixed'
  note?:  string
}

/** The fields shown with a plan, in this order; the rest are the template's constants. */
const SHOWN_FIELDS: Array<[string, string]> = [
  ['node', 'node'], ['vmid', 'ID'], ['ip', 'address'], ['gateway', 'gateway'], ['storage', 'storage'],
  ['template', 'template'], ['hostname', 'hostname'], ['memory_mb', 'MB RAM'], ['disk_gb', 'GB disk'], ['cores', 'vCPU'],
]

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

/** A website plan the server holds (catalogue-installer preview): only its id and words reach the page. */
interface WebsiteCardData { previewId: string; title: string; steps: string[]; checks: string[]; warnings: string[]; link: string; expiresAt: number }

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


const STEP_ICON: Record<string, (p: { size?: number }) => React.JSX.Element> = {
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

// ── A website plan, opened in the New website wizard ─────────────────────────

function WebsiteCard({ card, onCancel }: { card: WebsiteCardData; onCancel: () => void }) {
  return (
    <div style={{ background: 'linear-gradient(135deg, var(--surface), var(--surface-hi))', border: '1px solid var(--accent)', borderRadius: 12, padding: '1.25rem', marginBottom: '1rem', boxShadow: 'var(--shadow)' }}>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>planned with the New website wizard · held for 10 minutes · nothing made yet</div>
      <div className="font-display" style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 4 }}>{card.title}</div>
      <ul style={{ margin: '6px 0 10px 18px', padding: 0, fontSize: 14, color: 'var(--text-soft)', lineHeight: 1.5 }}>
        {card.steps.map((s, i) => <li key={i}>{s}</li>)}
      </ul>
      {card.checks.length > 0 && (
        <ul style={{ margin: '0 0 10px', padding: 0, listStyle: 'none', fontSize: 13, color: 'var(--text-muted)' }}>
          {card.checks.map((c, i) => <li key={i}>✓ {c}</li>)}
        </ul>
      )}
      {card.warnings.length > 0 && <p style={{ fontSize: 13, color: 'var(--warn)', margin: '0 0 10px' }}>{card.warnings.join(' ')}</p>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button onClick={onCancel} style={{ padding: '9px 16px', fontSize: 14, cursor: 'pointer', ...secondaryBtn }}>Not now</button>
        <a href={card.link} style={{ padding: '9px 18px', fontSize: 14, textDecoration: 'none', ...primaryBtn }}>Review in New website →</a>
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
              border:       `1px solid ${step.status === 'running' ? alpha(sc, 31) : BORDER}`,
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

export function AssistantChat() {
  const [status,      setStatus]      = useState<OllamaStatus | null>(null)
  // Wizard state
  const [prompt,      setPrompt]      = useState('')
  const [planning,    setPlanning]    = useState(false)
  const [plan,        setPlan]        = useState<DeployPlan | null>(null)
  // The server's id for the audited plan; only a plan with one can be executed.
  const [planId,      setPlanId]      = useState<string | null>(null)
  const [planFields,  setPlanFields]  = useState<Record<string, PlanField>>({})
  const [planErr,     setPlanErr]     = useState<string | null>(null)
  const [executing,   setExecuting]   = useState(false)
  const [activeModel, setActiveModel] = useState<string>('')
  const [providers,   setProviders]   = useState<ProviderInfo[]>([])
  const [activeProv,  setActiveProv]  = useState<ProviderId>('ollama')
  const [messages,    setMessages]    = useState<Array<{ role: 'user' | 'assistant'; content: string; clusters?: ClusterRef[]; choices?: Array<{ label: string; prompt: string; cluster: string }>; sources?: string[] }>>([])
  // Which cluster the assistant answers about by default: ?cluster=<id>, else home. A question can still name another.
  const [clusterList, setClusterList] = useState<ClusterRef[]>([])
  const [clusterId,   setClusterId]   = useState('home')
  const [actionCard,  setActionCard]  = useState<ActionCardData | null>(null)
  // A new website the assistant planned with the New website wizard's code: reviewed and installed in the wizard.
  const [websiteCard, setWebsiteCard] = useState<WebsiteCardData | null>(null)
  const [liveJob,     setLiveJob]     = useState<JobProgress | null>(null)
  const chatRef = useRef<HTMLDivElement>(null)
  const wsRef   = useRef<WebSocket | null>(null)

  useEffect(() => {
    void (async () => {
      const [s, pr] = await Promise.all([fetch('/api/ai/status').then(r => r.json()).catch(() => null), fetch('/api/ai/providers').then(r => r.json()).catch(() => null)])
      if (s) setStatus(s)
      if (pr?.ok) {
        setProviders(pr.providers); setActiveProv(pr.active)
        const stored = pr.providers.find((p: ProviderInfo) => p.id === 'ollama')?.model ?? ''
        setActiveModel(cur => cur || stored)
      }
    })()
  }, [])

  // Which provider is selected, and whether it can actually be used. Ollama is
  // "configured" as soon as an address is stored, but it is only usable once
  // that address answers — hence the two different checks.
  const activeInfo     = providers.find(p => p.id === activeProv) ?? null
  // What the dropdown shows is what is sent: a stored model that is not installed would otherwise
  // display as the first installed one while the request carried the stored name.
  const shownModel = pickOllamaModel(activeModel, (status?.models ?? []).map(m => m.name))
  const providerReady  = activeProv === 'ollama'
    ? Boolean(status?.connected)
    : Boolean(activeInfo?.configured)
  // Without a model the assistant still answers by code, so the input stays usable either way.
  const mode = assistantMode({ providerReady, planning, providerName: activeInfo?.name, model: activeInfo?.model })

  const selectProvider = async (id: ProviderId) => {
    setActiveProv(id)
    await fetch('/api/ai/provider/select', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: id }),
    })
  }

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

  useEffect(() => {
    void apiJson<{ data: ClusterRef[] }>('/api/clusters').then(r => {
      if (!r.ok || !Array.isArray(r.body?.data)) return
      const list = r.body!.data.map(c => ({ id: c.id, name: c.name, kind: c.kind }))
      setClusterList(list)
      const wanted = new URLSearchParams(window.location.search).get('cluster')
      if (wanted && list.some(c => c.id === wanted)) setClusterId(wanted)
    })
  }, [])

  // `forCluster`: a choice the assistant offered carries its own cluster, sent for that request whatever the picker says.
  const handleWizardSubmit = async (asked?: string, forCluster?: string) => {
    const text = (asked ?? prompt).trim()
    if (!text || planning) return
    const userMsg = text
    setPrompt('')
    setPlan(null)
    setPlanId(null)
    setPlanErr(null)
    setActionCard(null)
    setWebsiteCard(null)
    setPlanning(true)
    setMessages(m => [...m, { role: 'user', content: userMsg }])

    const res  = await fetch('/api/ai/wizard/plan', {
      method:  'POST',
      // The cluster picked above; home sends nothing, as before.
      headers: { 'Content-Type': 'application/json', ...((forCluster ?? clusterId) !== 'home' ? { [CLUSTER_HEADER]: forCluster ?? clusterId } : {}) },
      // The model override only means anything for Ollama, where the dropdown
      // lists what is installed. Cloud models are set once, in Settings.
      body:    JSON.stringify(activeProv === 'ollama'
        ? { prompt: userMsg, provider: activeProv, model: shownModel }
        : { prompt: userMsg, provider: activeProv }),
    })
    const data = await res.json()
    setPlanning(false)

    if (data.ok && data.website) {
      setWebsiteCard(data.website)
      setMessages(m => [...m, { role: 'assistant', content: 'I planned this website with the New website wizard. Nothing is made yet: open it in the wizard to review it and install.' }])
    } else if (data.ok && data.action) {
      // An action the server prepared and holds. Nothing has run; the card below confirms it.
      setActionCard(data.action)
      setMessages(m => [...m, { role: 'assistant', content: `I prepared this for ${data.action.cluster.name}. Check it below, then confirm.`, clusters: [data.action.cluster] }])
    } else if (data.ok && data.plan) {
      setPlan(data.plan)
      setPlanFields(data.fields ?? {})
      const ready = !data.blocked && typeof data.planId === 'string'
      setPlanId(ready ? data.planId : null)
      setMessages(m => [...m, {
        role:    'assistant',
        content: ready
          ? `Here's my plan: ${data.plan.understood} Review the steps below and confirm to execute.`
          : `I can't deploy ${data.plan.service || 'this'} yet. Read the warnings below.`,
      }])
    } else if (data.ok && data.conversational) {
      // Not every prompt is a deployment. Say what came back rather than
      // reporting a failure that did not happen.
      const about: ClusterRef[] | undefined = Array.isArray(data.clusters) ? data.clusters : data.cluster && data.cluster.kind === 'remote' ? [data.cluster] : undefined
      setMessages(m => [...m, { role: 'assistant', content: data.message, clusters: about, choices: Array.isArray(data.choices) && data.choices.length ? data.choices : undefined, sources: sourcesUsed(data.sources) ?? undefined }])
    } else {
      const err = data.error ?? 'Failed to generate plan'
      setPlanErr(err)
      setMessages(m => [...m, { role: 'assistant', content: `Error: ${err}` }])
    }
  }

  const handleExecute = async () => {
    if (!plan || !planId) return
    setExecuting(true)
    const res  = await fetch('/api/ai/wizard/execute', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ planId }),
    })
    const data = await res.json()
    setExecuting(false)

    if (data.ok) {
      setPlan(null)
      setPlanId(null)
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
    } else {
      // A refused execute has used the plan up (expired, already run, or the
      // cluster changed since it was checked). Say why; it must be planned again.
      setPlanId(null)
      const why = data.warnings?.length
        ? `${data.warnings.join(' ')} Plan it again.`
        : (data.error ?? 'The plan could not be executed. Plan it again.')
      setMessages(m => [...m, { role: 'assistant', content: `Not executed: ${why}` }])
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%', padding: 12 }}>
          {/* Live execution view */}
  {liveJob ? (
    <ExecutionView
      job={liveJob}
      onDone={() => setLiveJob(null)}
    />
  ) : (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' }}>
      {mode.showConnectModel && (
        <div role="note" aria-label={CONNECT_MODEL_WORDS.title} style={{ background: `${alpha(ACCENT, 6)}`, border: `1px solid ${alpha(ACCENT, 15)}`, borderRadius: 10, padding: '1rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ display: 'flex', color: ACCENT, paddingTop: 2 }}><BoltIcon size={20} /></span>
          <div style={{ flex: '1 1 240px', minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: ACCENT, marginBottom: 4 }}>{CONNECT_MODEL_WORDS.title}</div>
            <div style={{ fontSize: 14, color: 'var(--text-soft)', marginBottom: 4 }}>{CONNECT_MODEL_WORDS.works}</div>
            <div style={{ fontSize: 14, color: 'var(--text-soft)' }}>
              {CONNECT_MODEL_WORDS.adds}
              {activeInfo?.missing?.length ? ` ${activeInfo.name} still needs its ${activeInfo.missing.join(' and ')}.` : ''}
            </div>
          </div>
          <a href="/ai" style={{ alignSelf: 'center', padding: '8px 16px', fontSize: 14, cursor: 'pointer', textDecoration: 'none', ...secondaryBtn }}>
            Connect a model
          </a>
        </div>
      )}
      <ClusterPicker clusters={clusterList} value={clusterId} disabled={planning} onChange={id => { setClusterId(id); setActionCard(null); setPlan(null); setPlanId(null) }} />
      <div ref={chatRef} style={{ minHeight: 120, flex: '1 1 auto', overflowY: 'auto', marginBottom: '1rem', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-dimmer)', fontSize: 14 }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>✦</div>
            <div className="font-display" style={{ marginBottom: 12, color: 'var(--text-bright)', fontSize: 22, fontWeight: 600 }}>Ask about your clusters, NAS, house and websites, or describe what to deploy</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 320, margin: '0 auto' }}>
              {exampleChips(clusterList.some(c => c.kind === 'remote')).map(ex => (
                <button key={ex} onClick={() => void handleWizardSubmit(ex)} disabled={!mode.inputEnabled}
                  style={{ padding: '8px 12px', borderRadius: 6, fontSize: 13, cursor: 'pointer', ...mono, background: 'var(--surface)', color: 'var(--text-soft)', border: `1px solid ${BORDER}`, textAlign: 'left', transition: 'border-color .15s' }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.borderColor = alpha(ACCENT, 25)}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.borderColor = BORDER}
                >"{ex}"</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} style={{ alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '94%', padding: '10px 14px', borderRadius: 10, fontSize: 15, lineHeight: 1.55, whiteSpace: 'pre-line', background: msg.role === 'user' ? `${alpha(ACCENT, 8)}` : CARD, color: msg.role === 'user' ? ACCENT : 'var(--text-bright)', border: `1px solid ${msg.role === 'user' ? alpha(ACCENT, 19) : BORDER}` }}>
            {msg.clusters?.length ? (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>{msg.clusters.map(c => <ClusterChip key={c.id} c={c} />)}</div>
            ) : null}
            {msg.content}
            {msg.choices?.length ? (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                {msg.choices.map(ch => (
                  <button key={`${ch.cluster}:${ch.prompt}`} onClick={() => void handleWizardSubmit(ch.prompt, ch.cluster)} disabled={planning}
                    style={{ padding: '5px 10px', borderRadius: 6, fontSize: 13, cursor: 'pointer', background: 'var(--ground)', color: 'var(--text)', border: `1px solid ${BORDER}` }}>{ch.label}</button>
                ))}
              </div>
            ) : null}
            {msg.sources?.length ? <SourcesUsed sources={msg.sources} /> : null}
          </div>
        ))}
        {planning && (
          <div style={{ alignSelf: 'flex-start', padding: '10px 14px', borderRadius: 10, background: CARD, border: `1px solid ${BORDER}`, fontSize: 14, color: 'var(--text-muted)' }}>thinking...</div>
        )}
      </div>
      {plan && (
        <div style={{ background: CARD, border: `1px solid ${alpha(ACCENT, 19)}`, borderRadius: 10, padding: '1.5rem', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <div>
              <div className="font-display" style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 2 }}>{plan.service}{plan.domain ? ` → ${plan.domain}` : ''}</div>
              <div style={{ fontSize: 14, color: 'var(--text-soft)' }}>{plan.understood}</div>
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 11, marginBottom: '1rem', ...mono }}>
            {SHOWN_FIELDS.filter(([k]) => planFields[k] && planFields[k].value !== '' && planFields[k].value != null).map(([k, label]) => (
              <span key={k} style={badge('var(--text-muted)')} title={planFields[k].note ?? planFields[k].source}>
                {['memory_mb', 'disk_gb', 'cores'].includes(k) ? `${String(planFields[k].value)} ${label}` : `${label} ${String(planFields[k].value)}`}
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: '1rem' }}>
            {plan.steps.map((step, i) => (
              <div key={step.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, background: 'var(--ground)', border: `1px solid ${BORDER}` }}>
                <div style={{ fontSize: 16, width: 24, textAlign: 'center' }}>{stepIcon(step.type, 16) ?? '▸'}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-bright)' }}>{i + 1}. {step.label}</div>
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
            <button onClick={() => { setPlan(null); setPlanId(null) }} style={{ padding: '10px 18px', fontSize: 14, cursor: 'pointer', ...secondaryBtn }}>Cancel</button>
            {planId && (
            <button onClick={() => { if (window.confirm(`Execute ${plan?.steps?.length} steps to deploy ${plan?.service}?`)) handleExecute() }} disabled={executing}
              style={{ padding: '10px 22px', fontSize: 14, cursor: executing ? 'default' : 'pointer', ...primaryBtn, opacity: executing ? 0.6 : 1 }}>
              {executing ? 'Starting...' : `Execute ${plan.steps.length} steps →`}
            </button>
            )}
          </div>
        </div>
      )}
      {websiteCard && <WebsiteCard card={websiteCard} onCancel={() => setWebsiteCard(null)} />}
      {actionCard && (
        <ActionCard key={actionCard.planId} card={actionCard}
          onCancel={() => setActionCard(null)}
          onDone={words => { setActionCard(null); setMessages(m => [...m, { role: 'assistant', content: words, clusters: [actionCard.cluster] }]) }} />
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
          <select value={shownModel} onChange={e => { setActiveModel(e.target.value); fetch('/api/ai/model/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: e.target.value }) }) }}
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
        <input value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => e.key === 'Enter' && !e.shiftKey && void handleWizardSubmit()}
          placeholder={clusterId === 'home' ? 'Deploy Nextcloud at cloud.mydomain.com, or ask how each cluster is doing...' : 'How is this server doing? Restart a guest, back one up...'}
          disabled={!mode.inputEnabled}
          style={{ flex: 1, padding: '11px 14px', ...inputStyle, fontSize: 15, opacity: !mode.inputEnabled ? 0.5 : 1 }} />
        <button onClick={() => void handleWizardSubmit()} disabled={!prompt.trim() || !mode.inputEnabled}
          style={{ padding: '10px 22px', fontSize: 15, cursor: (!prompt.trim() || !mode.inputEnabled) ? 'default' : 'pointer', ...primaryBtn, opacity: (!prompt.trim() || !mode.inputEnabled) ? 0.4 : 1 }}>
          {planning ? '...' : '→'}
        </button>
      </div>
    </div>
  )}
    </div>
  )
}
