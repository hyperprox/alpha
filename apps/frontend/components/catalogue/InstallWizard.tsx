'use client'

// =============================================================================
//  HyperProx — the install wizard
//
//  Five steps for one app: what it is, how big, where it goes, what it is
//  called and how it reaches the network, and a review of the exact plan. The
//  server reads the cluster, recommends and checks; the person chooses. The
//  review is a plan the server holds, and Install sends only its id.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiJson } from '@/lib/api'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { GhostButton, INPUT, LABEL, Notice, PrimaryButton } from '@/components/vault/ui'

export interface WizardRecipe {
  id: string; name: string; summary: string; category: string; port: number; needsDocker: boolean
  defaults: { cores: number; memoryMb: number; diskGb: number; swapMb?: number }
  minimum: { cores: number; memoryMb: number; diskGb: number }
  needsGpu?: boolean
  firstLogin: string | null; firstRunKind?: string; notes: string[]
  satisfies: { kind: string; id: string; setting: string } | null
}

interface Storage { storage: string; type: string; shared: boolean; freeGb: number; totalGb?: number; content: string[] }
interface Bridge { iface: string; cidr?: string; gateway?: string; prefix?: number }
interface Verdict { eligible: boolean; why: string[]; notes: string[]; score: number; storage: Storage | null; freeMemAfterMb: number; freeMemAfterLiveMb: number }
interface NodeRow {
  node: string; online: boolean; cores: number; cpuLoad?: number; memTotalMb: number; memUsedMb: number; memCommittedMb?: number
  runningGuests?: number; hasGpu?: boolean; gpuSource?: string; hasIgpu?: boolean; igpuSource?: string
  haMaster?: boolean; haGuests: number; hasLogin?: boolean
  bridges: Bridge[]; rootStorages: Storage[]; excludedStorages?: Array<Storage & { reason: string }>; verdict: Verdict
}
interface Placement {
  nodes: NodeRow[]; recommendation: { node: string; reason: string; storage: string } | null
  partial: string[]; rule: { kind: 'next-free' } | { kind: 'pattern'; pattern: string }; nextVmid: number
}
interface Identity {
  suggestedVmid: number
  rule: Placement['rule']
  vmid?: { value: number; free: boolean; problem?: string }
  derived?: { vmid?: number; taken?: boolean; problem?: string }
  reverse?: { node?: string; ip?: string; problem?: string }
  ip?: { value: string; problems: string[]; pinged: boolean | null }
  bridges: Bridge[]
}
interface PreviewData {
  previewId: string; checks: string[]; warnings: string[]; expiresAt: number
  plan: Record<string, string | number | boolean>
}

const STEPS = ['App', 'Size', 'Where', 'Name & network', 'Review'] as const
const MONO = 'font-mono text-[12px]'
const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block min-w-0">
      <span style={LABEL}>{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px]" style={{ color: 'var(--text-dim)' }}>{hint}</span>}
    </label>
  )
}

function Bar({ used, total, warn }: { used: number; total: number; warn?: boolean }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
  return (
    <div className="h-1.5 w-full rounded-full overflow-hidden" style={{ background: 'var(--ground-deep)' }}>
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: warn || pct > 85 ? 'var(--warn)' : 'var(--accent)' }} />
    </div>
  )
}

function Badge({ children, tone = 'var(--text-muted)' }: { children: React.ReactNode; tone?: string }) {
  return (
    <span className="font-mono text-[10px] uppercase tracking-[0.08em] px-1.5 py-0.5 rounded"
      style={{ color: tone, background: `color-mix(in srgb, ${tone} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${tone} 30%, transparent)` }}>
      {children}
    </span>
  )
}

export function InstallWizard({ recipe, onClose, onStarted }: {
  recipe: WizardRecipe
  onClose: () => void
  onStarted: (job: { jobId: string; steps: any[] }) => void
}) {
  const [step, setStep] = useState(0)

  // Step 2: size, pre-filled from the recipe's recommended values.
  const [cores, setCores] = useState(recipe.defaults.cores)
  const [memoryMb, setMemoryMb] = useState(recipe.defaults.memoryMb)
  const [swapMb, setSwapMb] = useState(recipe.defaults.swapMb ?? 512)
  const [diskGb, setDiskGb] = useState(recipe.defaults.diskGb)

  // Step 3: where.
  const [placement, setPlacement] = useState<Placement | null>(null)
  const [placing, setPlacing] = useState(false)
  const [placeError, setPlaceError] = useState('')
  const [node, setNode] = useState('')
  const [storage, setStorage] = useState('')

  // Step 4: identity and network.
  const [vmid, setVmid] = useState<number | ''>('')
  const [hostname, setHostname] = useState(recipe.id.slice(0, 63))
  const [bridge, setBridge] = useState('')
  const [mode, setMode] = useState<'dhcp' | 'static'>('dhcp')
  const [ip, setIp] = useState('')
  const [gateway, setGateway] = useState('')
  const [dns, setDns] = useState('')
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [checking, setChecking] = useState(false)
  const lastEdit = useRef<'vmid' | 'ip' | 'node' | null>(null)

  // Step 5: the held plan.
  const [preview, setPreview] = useState<PreviewData | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reconfirm, setReconfirm] = useState(false)

  const below = useMemo(() => ({
    cores: cores < recipe.minimum.cores, memory: memoryMb < recipe.minimum.memoryMb, disk: diskGb < recipe.minimum.diskGb,
  }), [cores, memoryMb, diskGb, recipe.minimum])

  const selected = placement?.nodes.find(n => n.node === node)

  const loadPlacement = useCallback(async () => {
    setPlacing(true); setPlaceError('')
    const q = new URLSearchParams({ recipeId: recipe.id, cores: String(cores), memoryMb: String(memoryMb), diskGb: String(diskGb) })
    const r = await apiJson<{ data: Placement }>(`/api/catalogue/wizard/placement?${q}`)
    setPlacing(false)
    if (!r.ok || !r.body?.data) { setPlaceError(r.error ?? 'Could not read the cluster.'); return }
    const p = r.body.data
    setPlacement(p)
    // Keep a choice that is still eligible; otherwise take the recommendation.
    const keep = p.nodes.find(n => n.node === node && n.verdict.eligible)
    const pick = keep ?? p.nodes.find(n => n.node === p.recommendation?.node)
    if (pick) {
      setNode(pick.node)
      setStorage(s => pick.rootStorages.some(x => x.storage === s) && s ? s : (pick.verdict.storage?.storage ?? ''))
    }
    if (vmid === '') setVmid(p.nextVmid)
  }, [recipe.id, cores, memoryMb, diskGb, node, vmid])

  useEffect(() => { if (step === 2 && !placement) void loadPlacement() }, [step, placement, loadPlacement])

  // A different node has different bridges: keep the bridge if it has it, else its first one with an address.
  useEffect(() => {
    if (!selected) return
    if (!selected.bridges.some(b => b.iface === bridge)) {
      const b = selected.bridges.find(x => x.gateway) ?? selected.bridges[0]
      setBridge(b?.iface ?? '')
    }
  }, [selected, bridge])
  const bridgeInfo = selected?.bridges.find(b => b.iface === bridge)
  useEffect(() => { if (mode === 'static' && !gateway && bridgeInfo?.gateway) setGateway(bridgeInfo.gateway) }, [mode, gateway, bridgeInfo])

  // Ask the server about the identity as it is typed: ID free, the rule both ways, address free.
  useEffect(() => {
    if (step !== 3 || !node) return
    const t = setTimeout(async () => {
      setChecking(true)
      const body: any = { node, bridge }
      if (typeof vmid === 'number') body.vmid = vmid
      if (mode === 'static' && ip) { body.ip = ip; if (gateway) body.gateway = gateway }
      const r = await apiJson<{ data: Identity }>('/api/catalogue/wizard/identity', 'POST', body)
      setChecking(false)
      if (!r.ok || !r.body?.data) return
      const a = r.body.data
      setIdentity(a)
      if (a.rule.kind === 'pattern') {
        // The rule fills in the other side of whatever was just edited, and never fights the person.
        if ((lastEdit.current === 'ip' || lastEdit.current === 'node') && a.derived?.vmid && !a.derived.taken && a.derived.vmid !== vmid) {
          lastEdit.current = null; setVmid(a.derived.vmid)
        } else if (lastEdit.current === 'vmid' && a.reverse && !a.reverse.problem) {
          lastEdit.current = null
          if (a.reverse.node && a.reverse.node !== node && placement?.nodes.find(n => n.node === a.reverse!.node)?.verdict.eligible) setNode(a.reverse.node)
          if (a.reverse.ip) { setMode('static'); setIp(a.reverse.ip) }
        }
      }
    }, 450)
    return () => clearTimeout(t)
  }, [step, node, bridge, vmid, mode, ip, gateway, placement])

  const canNext = (() => {
    if (step === 1) return cores >= 1 && memoryMb >= 64 && diskGb >= 1
    if (step === 2) return Boolean(selected?.verdict.eligible && storage)
    if (step === 3) {
      if (typeof vmid !== 'number' || !hostname || !bridge) return false
      if (identity?.vmid && !identity.vmid.free) return false
      if (mode === 'static' && (!ip || (identity?.ip?.problems.length ?? 0) > 0)) return false
      return true
    }
    return true
  })()

  const makePreview = async () => {
    setBusy(true); setError(''); setProblems([]); setWarnings([]); setPreview(null)
    const r = await apiJson<{ data: PreviewData }>('/api/catalogue/wizard/preview', 'POST', {
      recipeId: recipe.id, node, vmid, hostname, cores, memoryMb, swapMb, diskGb, storage, bridge,
      ip: mode === 'dhcp' ? 'dhcp' : ip, ...(mode === 'static' && gateway ? { gateway } : {}), ...(dns ? { dns } : {}),
    })
    setBusy(false)
    if (!r.ok) { setError(r.error ?? 'The plan could not be checked.'); setProblems((r.body as any)?.problems ?? []); setWarnings((r.body as any)?.warnings ?? []); return }
    setPreview(r.body!.data); setWarnings(r.body!.data.warnings)
  }

  const apply = async () => {
    if (!preview) return
    setBusy(true); setError('')
    const r = await apiJson<{ data: { jobId: string; steps: any[] } }>('/api/catalogue/wizard/apply', 'POST', { previewId: preview.previewId })
    setBusy(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(true); return }
    if (!r.ok) {
      setError(r.error ?? 'The install could not be started.')
      setProblems((r.body as any)?.problems ?? [])
      // A used, expired or out-of-date preview cannot be applied again: back to a fresh check.
      setPreview(null)
      return
    }
    onStarted(r.body!.data)
  }

  const go = (to: number) => {
    setError(''); setProblems([])
    if (to === 4) void makePreview()
    if (to === 2 && step === 1) setPlacement(null) // sizes changed: read the cluster again
    setStep(to)
  }

  return (
    <div className="fixed inset-0 z-40 flex items-stretch sm:items-center justify-center sm:p-6"
      style={{ background: 'var(--scrim)', backdropFilter: 'blur(4px)' }}>
      <div role="dialog" aria-modal="true" aria-label={`Install ${recipe.name}`}
        className="flex w-full max-w-4xl flex-col sm:rounded-xl border overflow-hidden"
        style={{ background: 'var(--surface-raised)', borderColor: 'var(--border-soft)', maxHeight: '100dvh' }}>

        {/* Header and step strip */}
        <div className="flex items-start justify-between gap-3 border-b px-4 sm:px-6 py-4" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="min-w-0">
            <p className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--accent)' }}>
              Install · step {step + 1} of {STEPS.length}
            </p>
            <h2 className="font-display text-[26px] font-bold leading-tight truncate" style={{ color: 'var(--text-bright)' }}>{recipe.name}</h2>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-lg px-2" style={{ color: 'var(--text-dimmer)' }}>✕</button>
        </div>
        <ol className="flex gap-1 overflow-x-auto px-4 sm:px-6 pt-3" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s} className="flex-1 min-w-[64px]">
              <div className="h-1 rounded-full" style={{ background: i <= step ? 'var(--accent)' : 'var(--border-strong)' }} />
              <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.08em] truncate"
                style={{ color: i === step ? 'var(--text-bright)' : 'var(--text-dim)' }}>{s}</span>
            </li>
          ))}
        </ol>

        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 space-y-4">
          {/* ── 1. The app ─────────────────────────────────────────────── */}
          {step === 0 && (
            <div className="space-y-4">
              <p className="text-[15px] leading-relaxed" style={{ color: 'var(--text-soft)' }}>{recipe.summary}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border p-4" style={{ borderColor: 'var(--border-soft)', background: 'var(--ground-inset)' }}>
                  <p className="font-display text-[17px] font-semibold mb-2" style={{ color: 'var(--text-bright)' }}>What it needs</p>
                  <ul className="space-y-1 text-sm" style={{ color: 'var(--text-muted)' }}>
                    <li>Its own container, unprivileged{recipe.needsDocker ? ', running Docker inside' : ''}.</li>
                    <li>At least {recipe.minimum.cores} core{recipe.minimum.cores > 1 ? 's' : ''}, {recipe.minimum.memoryMb} MB RAM and {recipe.minimum.diskGb} GB disk.
                      We suggest {recipe.defaults.cores} / {recipe.defaults.memoryMb} MB / {recipe.defaults.diskGb} GB.</li>
                    <li>It answers on port <span className={MONO}>{recipe.port}</span>.</li>
                    {recipe.needsGpu && <li>A GPU on its node.</li>}
                    {recipe.satisfies && <li>Once it is up, HyperProx connects it for you ({recipe.satisfies.id}).</li>}
                  </ul>
                </div>
                <div className="rounded-lg border p-4" style={{ borderColor: 'color-mix(in srgb, var(--warn) 35%, transparent)', background: 'color-mix(in srgb, var(--warn) 6%, transparent)' }}>
                  <p className="font-display text-[17px] font-semibold mb-2" style={{ color: 'var(--text-bright)' }}>First login</p>
                  <p className="text-sm" style={{ color: 'var(--warn-2)' }}>
                    {recipe.firstLogin
                      ?? (recipe.firstRunKind === 'setup-url' ? 'Open it once it is up: it walks you through creating the first account.'
                        : recipe.firstRunKind === 'env-admin' ? 'A strong admin password is generated, kept in the vault, and shown to you once.'
                          : 'No login to set up.')}
                  </p>
                </div>
              </div>
              {recipe.notes.length > 0 && (
                <ul className="space-y-1">
                  {recipe.notes.map((n, i) => <li key={i} className="text-[13px]" style={{ color: 'var(--text-dim)' }}>· {n}</li>)}
                </ul>
              )}
            </div>
          )}

          {/* ── 2. Size ────────────────────────────────────────────────── */}
          {step === 1 && (
            <div className="space-y-4">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                Filled in with what {recipe.name} is happy with. You can change any of it later in Proxmox.
              </p>
              <div className="grid gap-4 grid-cols-2 sm:grid-cols-4">
                <Field label="CPU cores" hint={below.cores ? <span style={{ color: 'var(--warn)' }}>Below the minimum of {recipe.minimum.cores}</span> : `min ${recipe.minimum.cores}`}>
                  <input type="number" min={1} value={cores} onChange={e => setCores(Number(e.target.value))} style={INPUT} inputMode="numeric" />
                </Field>
                <Field label="RAM (MB)" hint={below.memory ? <span style={{ color: 'var(--warn)' }}>Below the minimum of {recipe.minimum.memoryMb} MB</span> : `min ${recipe.minimum.memoryMb}`}>
                  <input type="number" min={64} step={256} value={memoryMb} onChange={e => setMemoryMb(Number(e.target.value))} style={INPUT} inputMode="numeric" />
                </Field>
                <Field label="Swap (MB)" hint="0 for none">
                  <input type="number" min={0} step={256} value={swapMb} onChange={e => setSwapMb(Number(e.target.value))} style={INPUT} inputMode="numeric" />
                </Field>
                <Field label="Disk (GB)" hint={below.disk ? <span style={{ color: 'var(--warn)' }}>Below the minimum of {recipe.minimum.diskGb} GB</span> : `min ${recipe.minimum.diskGb}`}>
                  <input type="number" min={1} value={diskGb} onChange={e => setDiskGb(Number(e.target.value))} style={INPUT} inputMode="numeric" />
                </Field>
              </div>
              {(below.cores || below.memory || below.disk) && (
                <Notice kind="warn">Below the minimum it may not start, or may run slowly. You can still go ahead.</Notice>
              )}
            </div>
          )}

          {/* ── 3. Where ───────────────────────────────────────────────── */}
          {step === 2 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  Live from Proxmox. CPU is a single reading taken right now; RAM is judged on the worse of what is in use and what is promised to running guests. Pick any node that is not greyed out.
                </p>
                <GhostButton onClick={() => void loadPlacement()} disabled={placing} style={{ height: 34 }}>{placing ? 'Reading…' : 'Refresh'}</GhostButton>
              </div>
              {placeError && <Notice kind="error">{placeError}</Notice>}
              {placement?.recommendation && (
                <div className="rounded-lg border px-4 py-3" style={{ borderColor: 'color-mix(in srgb, var(--accent) 40%, transparent)', background: 'color-mix(in srgb, var(--accent) 7%, transparent)' }}>
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] mb-1" style={{ color: 'var(--accent)' }}>Recommended</p>
                  <p className="text-sm" style={{ color: 'var(--text-bright)' }}>{placement.recommendation.reason}</p>
                </div>
              )}
              {placement && !placement.recommendation && (
                <Notice kind="error">No node can take {recipe.name} at this size. Make it smaller, or free up room.</Notice>
              )}
              {placement && placement.partial.length > 0 && (
                <Notice kind="warn">Some things could not be read ({placement.partial.slice(0, 4).join(', ')}{placement.partial.length > 4 ? '…' : ''}). Checks that need them will say so.</Notice>
              )}
              <div className="grid gap-3 md:grid-cols-2">
                {placement?.nodes.map(n => {
                  const on = n.node === node
                  const ok = n.verdict.eligible
                  const freeMb = n.memTotalMb - n.memUsedMb
                  return (
                    <button key={n.node} type="button" disabled={!ok}
                      onClick={() => { setNode(n.node); lastEdit.current = 'node'; setStorage(n.verdict.storage?.storage ?? '') }}
                      aria-pressed={on}
                      className="text-left rounded-lg border p-4 transition-colors disabled:cursor-not-allowed"
                      style={{
                        borderColor: on ? 'var(--accent)' : 'var(--border-soft)',
                        background: on ? 'color-mix(in srgb, var(--accent) 6%, var(--ground-inset))' : 'var(--ground-inset)',
                        opacity: ok ? 1 : 0.5,
                      }}>
                      <div className="flex flex-wrap items-center gap-2 mb-2">
                        <span className="w-2 h-2 rounded-full" style={{ background: n.online ? 'var(--good)' : 'var(--crit)' }} />
                        <span className="font-display text-[19px] font-semibold" style={{ color: 'var(--text-bright)' }}>{n.node}</span>
                        {placement.recommendation?.node === n.node && <Badge tone="var(--accent)">recommended</Badge>}
                        {n.hasGpu && <Badge tone="var(--violet)">GPU</Badge>}
                        {n.hasIgpu && !n.hasGpu && <Badge tone="var(--violet)">iGPU</Badge>}
                        {n.haMaster && <Badge>HA manager</Badge>}
                        {!n.online && <Badge tone="var(--crit)">offline</Badge>}
                      </div>
                      {n.online && (
                        <div className="space-y-2">
                          <div>
                            <div className="flex justify-between text-[12px]" style={{ color: 'var(--text-muted)' }}>
                              <span>CPU · {n.cores} cores</span>
                              <span className={MONO}>{n.cpuLoad !== undefined ? `${Math.round(n.cpuLoad * 100)}% busy right now` : '—'}</span>
                            </div>
                            <Bar used={n.cpuLoad ?? 0} total={1} />
                          </div>
                          <div>
                            <div className="flex justify-between text-[12px]" style={{ color: 'var(--text-muted)' }}>
                              <span>RAM · {gb(n.memUsedMb)} in use of {gb(n.memTotalMb)}</span>
                              <span className={MONO}>{gb(freeMb)} free</span>
                            </div>
                            <Bar used={n.memUsedMb} total={n.memTotalMb} />
                            {n.memCommittedMb !== undefined && (
                              <div className="flex justify-between text-[12px] mt-0.5" style={{ color: 'var(--text-dim)' }}>
                                <span>promised to running guests</span>
                                <span className={MONO}>{gb(n.memCommittedMb)}</span>
                              </div>
                            )}
                          </div>
                          <div className="text-[12px] space-y-0.5" style={{ color: 'var(--text-muted)' }}>
                            {n.rootStorages.length === 0 && <div>No storage for containers.</div>}
                            {n.rootStorages.map(s => (
                              <div key={s.storage} className="flex justify-between gap-2">
                                <span className="truncate"><span className={MONO}>{s.storage}</span> · {s.type} · {s.shared ? 'shared' : 'local'}</span>
                                <span className={MONO}>{s.freeGb} GB free</span>
                              </div>
                            ))}
                            {(n.excludedStorages ?? []).map(s => (
                              <div key={s.storage} className="flex justify-between gap-2" style={{ color: 'var(--text-dimmer)' }} title={s.reason}>
                                <span className="truncate"><span className={MONO}>{s.storage}</span> · {s.type} · not offered</span>
                              </div>
                            ))}
                          </div>
                          <div className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                            {n.runningGuests ?? 0} guests running{n.haGuests ? ` · ${n.haGuests} under HA` : ''}{n.gpuSource ? ` · ${n.gpuSource}` : ''}{!n.gpuSource && n.igpuSource ? ` · ${n.igpuSource}` : ''}
                          </div>
                        </div>
                      )}
                      {ok && <div className="mt-2 text-[12px]" style={{ color: 'var(--text-soft)' }}>
                        After install: {gb(n.verdict.freeMemAfterLiveMb)} RAM free now{n.verdict.freeMemAfterMb < n.verdict.freeMemAfterLiveMb ? `, ${gb(n.verdict.freeMemAfterMb)} if every guest uses what it is promised` : ''}{n.verdict.notes.length ? ` · ${n.verdict.notes.join(' · ')}` : ''}
                      </div>}
                      {!ok && n.verdict.why.length > 0 && (
                        <div className="mt-2 text-[12px]" style={{ color: 'var(--crit-soft)' }}>Can&rsquo;t use: {n.verdict.why.join('; ')}</div>
                      )}
                    </button>
                  )
                })}
              </div>
              {selected?.verdict.eligible && (
                <Field label={`Storage on ${selected.node}`} hint={<>Shared storage lets HA start it on another node if this one fails. Shared block storage (such as Ceph RBD) is preferred over NFS.
                  {(selected.excludedStorages?.length ?? 0) > 0 && <> Not offered: {selected.excludedStorages!.map(s => s.storage).join(', ')}. {selected.excludedStorages![0].reason}</>}</>}>
                  <select value={storage} onChange={e => setStorage(e.target.value)} style={INPUT}>
                    {selected.rootStorages.map(s => {
                      const room = s.freeGb >= Math.ceil(diskGb * 1.2)
                      return <option key={s.storage} value={s.storage} disabled={!room}>
                        {s.storage} · {s.type} · {s.shared ? 'shared' : 'local'} · {s.freeGb} GB free{room ? '' : ' (not enough)'}
                      </option>
                    })}
                  </select>
                </Field>
              )}
            </div>
          )}

          {/* ── 4. Name and network ────────────────────────────────────── */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Container ID" hint={
                  identity?.vmid && !identity.vmid.free ? <span style={{ color: 'var(--crit-soft)' }}>{identity.vmid.problem}</span>
                    : identity?.rule.kind === 'pattern'
                      ? (identity.derived?.problem
                        ? <span style={{ color: 'var(--warn)' }}>{identity.derived.problem}</span>
                        : <>From your ID rule <span className={MONO}>{identity.rule.pattern}</span>.</>)
                      : `The next free ID is ${identity?.suggestedVmid ?? placement?.nextVmid ?? '…'}.`
                }>
                  <div className="flex gap-2">
                    <input type="number" value={vmid} onChange={e => { lastEdit.current = 'vmid'; setVmid(e.target.value === '' ? '' : Number(e.target.value)) }}
                      style={INPUT} inputMode="numeric" aria-invalid={identity?.vmid ? !identity.vmid.free : undefined} />
                    {identity && identity.suggestedVmid !== vmid && (
                      <GhostButton type="button" onClick={() => setVmid(identity.suggestedVmid)} style={{ whiteSpace: 'nowrap' }}>Use {identity.suggestedVmid}</GhostButton>
                    )}
                  </div>
                </Field>
                <Field label="Hostname" hint="Lowercase letters, digits and hyphens.">
                  <input value={hostname} onChange={e => setHostname(e.target.value.toLowerCase())} style={INPUT} autoCapitalize="none" spellCheck={false} />
                </Field>
                <Field label="Network bridge" hint={bridgeInfo?.cidr ? `${bridgeInfo.cidr}${bridgeInfo.gateway ? `, gateway ${bridgeInfo.gateway}` : ''}` : 'Bridges on this node'}>
                  <select value={bridge} onChange={e => setBridge(e.target.value)} style={INPUT}>
                    {(selected?.bridges ?? []).map(b => <option key={b.iface} value={b.iface}>{b.iface}{b.cidr ? ` · ${b.cidr}` : ''}</option>)}
                  </select>
                </Field>
                <Field label="Address">
                  <div className="flex rounded-md border overflow-hidden" style={{ borderColor: 'var(--border-strong)', height: 42 }}>
                    {(['dhcp', 'static'] as const).map(m => (
                      <button key={m} type="button" onClick={() => { setMode(m); lastEdit.current = 'ip' }} className="flex-1 text-sm"
                        aria-pressed={mode === m}
                        style={{ background: mode === m ? 'var(--accent)' : 'transparent', color: mode === m ? 'var(--accent-ink)' : 'var(--text-soft)' }}>
                        {m === 'dhcp' ? 'Automatic (DHCP)' : 'Fixed (static)'}
                      </button>
                    ))}
                  </div>
                </Field>
              </div>
              {mode === 'static' && (
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="IP address / prefix" hint={
                    identity?.ip?.problems.length ? <span style={{ color: 'var(--crit-soft)' }}>{identity.ip.problems.join(' ')}</span>
                      : identity?.ip ? (identity.ip.pinged === false ? 'Free: nothing in the cluster uses it, and nothing answered a ping.'
                        : 'Nothing in the cluster uses it. (It could not be pinged.)')
                        : bridgeInfo?.prefix ? `For example ${(bridgeInfo.gateway ?? '192.0.2.1').replace(/\.\d+$/, '.50')}/${bridgeInfo.prefix}` : 'Like 192.0.2.50/24'
                  }>
                    <input value={ip} onChange={e => { lastEdit.current = 'ip'; setIp(e.target.value.trim()) }} placeholder="192.0.2.50/24"
                      style={INPUT} inputMode="decimal" autoCapitalize="none" spellCheck={false} />
                  </Field>
                  <Field label="Gateway">
                    <input value={gateway} onChange={e => setGateway(e.target.value.trim())} style={INPUT} inputMode="decimal" />
                  </Field>
                  <Field label="DNS servers" hint="Optional. Blank uses the node's.">
                    <input value={dns} onChange={e => setDns(e.target.value)} placeholder="192.0.2.53" style={INPUT} inputMode="decimal" />
                  </Field>
                </div>
              )}
              {mode === 'dhcp' && (
                <Field label="DNS servers" hint="Optional. Blank uses what DHCP or the node gives.">
                  <input value={dns} onChange={e => setDns(e.target.value)} placeholder="192.0.2.53" style={INPUT} inputMode="decimal" />
                </Field>
              )}
              {checking && <p className="text-[12px] animate-pulse" style={{ color: 'var(--text-dim)' }}>Checking…</p>}
            </div>
          )}

          {/* ── 5. Review ──────────────────────────────────────────────── */}
          {step === 4 && (
            <div className="space-y-4">
              {busy && !preview && <p className="text-sm animate-pulse" style={{ color: 'var(--text-muted)' }}>Checking the plan against the cluster…</p>}
              {error && <Notice kind="error">{error}</Notice>}
              {problems.length > 0 && (
                <ul className="space-y-1">{problems.map((p, i) => <li key={i} className="text-sm" style={{ color: 'var(--crit-soft)' }}>· {p}</li>)}</ul>
              )}
              {preview && (
                <>
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                    This is exactly what will be created. HyperProx holds it; Install checks it all again first.
                  </p>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg border p-4"
                    style={{ borderColor: 'var(--border-soft)', background: 'var(--ground-inset)' }}>
                    {([
                      ['Node', preview.plan.node], ['Container ID', preview.plan.vmid], ['Hostname', preview.plan.hostname],
                      ['Cores', preview.plan.cores], ['RAM', `${preview.plan.memoryMb} MB`], ['Swap', `${preview.plan.swapMb} MB`],
                      ['Disk', `${preview.plan.diskGb} GB on ${preview.plan.storage}`], ['Bridge', preview.plan.bridge],
                      ['Address', preview.plan.ip === 'dhcp' ? 'DHCP' : `${preview.plan.ip}${preview.plan.gateway ? `, gateway ${preview.plan.gateway}` : ''}`],
                      ['DNS', preview.plan.dns || 'the node’s'], ['Template', String(preview.plan.template).split('/').pop()],
                      ['Privileges', 'unprivileged, nesting only'], ['Starts at boot', 'yes'],
                    ] as Array<[string, any]>).map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-[13px]" style={{ color: 'var(--text-dim)' }}>{k}</dt>
                        <dd className={`${MONO} break-all`} style={{ color: 'var(--text-bright)' }}>{String(v)}</dd>
                      </div>
                    ))}
                  </dl>
                  {preview.checks.length > 0 && (
                    <div>
                      <p className="font-mono text-[10px] uppercase tracking-[0.14em] mb-1" style={{ color: 'var(--good)' }}>Checked</p>
                      <ul className="space-y-0.5">{preview.checks.map((c, i) => <li key={i} className="text-[13px]" style={{ color: 'var(--text-muted)' }}>✓ {c}</li>)}</ul>
                    </div>
                  )}
                </>
              )}
              {warnings.length > 0 && <Notice kind="warn">{warnings.join(' ')}</Notice>}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t px-4 sm:px-6 py-3" style={{ borderColor: 'var(--border-soft)' }}>
          <GhostButton onClick={() => (step === 0 ? onClose() : go(step - 1))} disabled={busy}>{step === 0 ? 'Cancel' : 'Back'}</GhostButton>
          {step < 4 && <PrimaryButton onClick={() => go(step + 1)} disabled={!canNext || (step === 2 && placing)}>Next</PrimaryButton>}
          {step === 4 && !preview && !busy && <PrimaryButton onClick={() => void makePreview()}>Check again</PrimaryButton>}
          {step === 4 && preview && (
            <PrimaryButton onClick={() => void apply()} disabled={busy}>{busy ? 'Starting…' : `Install ${recipe.name}`}</PrimaryButton>
          )}
        </div>
      </div>
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(false)} onDone={() => { setReconfirm(false); void apply() }} />}
    </div>
  )
}
