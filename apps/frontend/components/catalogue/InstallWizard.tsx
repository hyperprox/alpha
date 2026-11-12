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
import { alpha } from '@/lib/theme'
import { ArrPicker, type ArrNames, type ArrVpn } from './ArrPicker'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { GhostButton, INPUT, LABEL, Notice, PrimaryButton } from '@/components/vault/ui'

export interface WizardRecipe {
  id: string; name: string; summary: string; category: string; port: number; needsDocker: boolean
  defaults: { cores: number; memoryMb: number; diskGb: number; swapMb?: number }
  minimum: { cores: number; memoryMb: number; diskGb: number }
  needsGpu?: boolean
  firstLogin: string | null; firstRunKind?: string; notes: string[]
  satisfies: { kind: string; id: string; setting: string } | null
  categoryLabel?: string
  /** Settings asked for before the install; the server checks each against its kind. */
  options?: RecipeOption[]
}

export interface RecipeOption {
  key: string; label: string; hint?: string; placeholder?: string
  kind: 'text' | 'url' | 'email' | 'username' | 'gitref' | 'path' | 'number' | 'boolean'
  required?: boolean; default?: string; min?: number; max?: number; maxLength?: number
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
  reverse?: { node?: string; nodes?: string[]; ip?: string; problem?: string }
  ip?: { value: string; problems: string[]; unknowns: string[]; unknownKeys: string[]; pinged: boolean | null }
  bridges: Bridge[]
}
interface PreviewData {
  previewId: string; checks: string[]; warnings: string[]; expiresAt: number
  plan: Record<string, string | number | boolean | Record<string, string>>
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

  // Step 1: the recipe's own settings, if it has any (a site title, a git repository).
  // The Arr Stack picks its apps and library in a panel of its own (ArrPicker), with its options held apart.
  const options = recipe.id === 'arr-stack' ? [] : recipe.options ?? []
  const [opts, setOpts] = useState<Record<string, string>>(() => Object.fromEntries(options.map(o => [o.key, o.default ?? ''])))
  const missing = options.filter(o => o.required && !String(opts[o.key] ?? '').trim())

  const isArr = recipe.id === 'arr-stack'
  const [arrOpts, setArrOpts] = useState<Record<string, string>>(() => Object.fromEntries((recipe.options ?? []).map(o => [o.key, o.default ?? ''])))
  const [arrVpn, setArrVpn] = useState<ArrVpn>({})
  const [arrNames, setArrNames] = useState<ArrNames | null>(null)
  const [arrState, setArrState] = useState<{ totals: { cores: number; memoryMb: number; diskGb: number } | null; missing: string[] }>({ totals: null, missing: [] })
  const onArrState = useCallback((st: typeof arrState) => setArrState(st), [])

  // Step 2: size, pre-filled from the recipe's recommended values.
  const [cores, setCores] = useState(recipe.defaults.cores)
  const [memoryMb, setMemoryMb] = useState(recipe.defaults.memoryMb)
  const [swapMb, setSwapMb] = useState(recipe.defaults.swapMb ?? 512)
  const [diskGb, setDiskGb] = useState(recipe.defaults.diskGb)
  // The Arr Stack's size follows the apps picked; the size step can still change it.
  useEffect(() => {
    const t = arrState.totals
    if (!isArr || !t) return
    setCores(t.cores); setMemoryMb(t.memoryMb); setDiskGb(t.diskGb)
  }, [isArr, arrState.totals])

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
  const [pinging, setPinging] = useState(false)
  const [pingResult, setPingResult] = useState<{ ip: string; answered: boolean | null; problems: string[] } | null>(null)
  // The tick is given for exactly the unknowns shown when it was ticked; a different set needs a new tick.
  const [ackedKeys, setAckedKeys] = useState<string[] | null>(null)
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
      // An auto-picked node counts as a choice, so the ID rule fills the ID from it.
      if (!keep) lastEdit.current = 'node'
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
        } else if (lastEdit.current === 'vmid' && a.reverse && (a.reverse.nodes?.length ?? 0) > 1) {
          // Two or more nodes fit the ID: nothing is guessed, the person picks one below.
          lastEdit.current = null
          if (a.reverse.ip) { setMode('static'); setIp(a.reverse.ip) }
        } else if (lastEdit.current === 'vmid' && a.reverse && !a.reverse.problem) {
          lastEdit.current = null
          if (a.reverse.node && a.reverse.node !== node && placement?.nodes.find(n => n.node === a.reverse!.node)?.verdict.eligible) setNode(a.reverse.node)
          if (a.reverse.ip) { setMode('static'); setIp(a.reverse.ip) }
        }
      }
    }, 450)
    return () => clearTimeout(t)
  }, [step, node, bridge, vmid, mode, ip, gateway, placement])

  // A changed address is a new address: its tick and its ping no longer apply.
  useEffect(() => { setAckedKeys(null); setPingResult(null) }, [ip, mode, node])

  /** Ask once, on request: does anything answer a ping on this address, from the chosen node? */
  const checkAddress = async () => {
    if (mode !== 'static' || !ip) return
    setPinging(true)
    const r = await apiJson<{ data: Identity }>('/api/catalogue/wizard/identity', 'POST',
      { node, bridge, ip, ...(gateway ? { gateway } : {}), ping: true })
    setPinging(false)
    if (r.ok && r.body?.data?.ip) {
      setIdentity(r.body.data)
      setPingResult({ ip, answered: r.body.data.ip.pinged, problems: r.body.data.ip.problems })
    }
  }
  const unknowns = mode === 'static' ? (identity?.ip?.unknowns ?? []) : []
  const unknownKeys = mode === 'static' ? (identity?.ip?.unknownKeys ?? []) : []
  const addressAck = ackedKeys !== null && unknownKeys.every(k => ackedKeys.includes(k))
  const swapMax = Math.min(Math.max(0, memoryMb) * 2, 8192)

  const canNext = (() => {
    if (step === 0) return missing.length === 0 && (!isArr || (arrState.totals !== null && arrState.missing.length === 0))
    if (step === 1) return cores >= 1 && memoryMb >= 64 && diskGb >= 1 && swapMb >= 0 && swapMb <= swapMax
    if (step === 2) return Boolean(selected?.verdict.eligible && storage)
    if (step === 3) {
      if (typeof vmid !== 'number' || !hostname || !bridge) return false
      if (identity?.vmid && !identity.vmid.free) return false
      if (mode === 'static' && (!ip || (identity?.ip?.problems.length ?? 0) > 0)) return false
      if (unknowns.length && !addressAck) return false
      return true
    }
    return true
  })()

  const makePreview = async () => {
    setBusy(true); setError(''); setProblems([]); setWarnings([]); setPreview(null)
    const r = await apiJson<{ data: PreviewData }>('/api/catalogue/wizard/preview', 'POST', {
      recipeId: recipe.id, node, vmid, hostname, cores, memoryMb, swapMb, diskGb, storage, bridge,
      ip: mode === 'dhcp' ? 'dhcp' : ip, ...(mode === 'static' && gateway ? { gateway } : {}), ...(dns ? { dns } : {}),
      ...(mode === 'static' && ackedKeys?.length ? { addressAck: ackedKeys } : {}),
      ...(options.length ? { options: opts } : {}),
      // The VPN login goes to the vault at the preview, never into the plan; names only when some are given.
      ...(isArr ? {
        options: arrOpts, ...(arrOpts.ARR_VPN === '1' ? { arrVpn } : {}),
        ...(arrNames && Object.values(arrNames.names).some(Boolean) ? { arrNames } : {}),
      } : {}),
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
        style={{ background: 'var(--surface-raised)', borderColor: 'var(--border-strong)', maxHeight: '100dvh', boxShadow: 'var(--shadow)' }}>

        {/* Header and step strip: corner brackets and a glowing current step, like the HUD headers */}
        <div className="flex items-start justify-between gap-3 border-b px-4 sm:px-6 py-4"
          style={{ borderColor: 'var(--border-soft)', background: 'linear-gradient(135deg, var(--surface), var(--surface-hi))' }}>
          <div className="min-w-0">
            <p className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--accent)' }}>
              Install · step {step + 1} of {STEPS.length}
            </p>
            <h2 className="font-display text-[26px] font-bold uppercase leading-tight truncate" style={{ color: 'var(--text-bright)', letterSpacing: '.04em' }}>{recipe.name}</h2>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-lg px-2" style={{ color: 'var(--text-muted)' }}>✕</button>
        </div>
        <ol className="flex gap-1 overflow-x-auto px-4 sm:px-6 pt-3" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s} className="flex-1 min-w-[64px]" aria-current={i === step ? 'step' : undefined}>
              <div className="h-1 rounded-full" style={{ background: i <= step ? 'var(--accent)' : 'var(--border-strong)',
                boxShadow: i === step ? `0 0 10px ${alpha('var(--accent)', 60)}` : undefined }} />
              <span className="mt-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em]"
                style={{ color: i === step ? 'var(--text-bright)' : 'var(--text-dim)' }}>
                <span aria-hidden style={{ color: i < step ? 'var(--good)' : i === step ? 'var(--accent)' : 'var(--text-dimmer)' }}>{i < step ? '✓' : i + 1}</span>
                <span className="truncate">{s}</span>
                <span className="sr-only">{i < step ? ' (done)' : i === step ? ' (current)' : ''}</span>
              </span>
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
              {options.length > 0 && (
                <div className="rounded-lg border p-4 space-y-3" style={{ borderColor: 'var(--border-soft)', background: 'var(--ground-inset)' }}>
                  <p className="font-display text-[17px] font-semibold" style={{ color: 'var(--text-bright)' }}>Settings</p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {options.map(o => o.kind === 'boolean' ? (
                      <label key={o.key} className="flex items-start gap-2 text-sm min-w-0" style={{ color: 'var(--text)' }}>
                        <input type="checkbox" checked={opts[o.key] === '1'} onChange={e => setOpts(v => ({ ...v, [o.key]: e.target.checked ? '1' : '0' }))} />
                        <span>{o.label}{o.hint && <span className="block text-[12px]" style={{ color: 'var(--text-dim)' }}>{o.hint}</span>}</span>
                      </label>
                    ) : (
                      <Field key={o.key} label={`${o.label}${o.required ? ' *' : ''}`} hint={o.hint}>
                        <input value={opts[o.key] ?? ''} onChange={e => setOpts(v => ({ ...v, [o.key]: e.target.value }))}
                          type={o.kind === 'number' ? 'number' : o.kind === 'email' ? 'email' : o.kind === 'url' ? 'url' : 'text'}
                          min={o.min} max={o.max} maxLength={o.maxLength} placeholder={o.placeholder}
                          inputMode={o.kind === 'number' ? 'numeric' : undefined}
                          autoCapitalize="none" spellCheck={o.kind === 'text'} style={INPUT} required={o.required} />
                      </Field>
                    ))}
                  </div>
                  {missing.length > 0 && <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>Fill in {missing.map(o => o.label).join(', ')} to go on.</p>}
                </div>
              )}
              {isArr && (
                <>
                  <ArrPicker opts={arrOpts} setOpts={setArrOpts} vpn={arrVpn} setVpn={setArrVpn} names={arrNames} setNames={setArrNames} onState={onArrState} />
                  {arrState.missing.length > 0 && <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>Fill in {arrState.missing.join(', ')} to go on.</p>}
                </>
              )}
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
                <Field label="Swap (MB)" hint={swapMb > swapMax
                  ? <span style={{ color: 'var(--crit-soft)' }}>At most {swapMax} MB: twice the RAM, never over 8 GB</span> : `0 for none, up to ${swapMax}`}>
                  <input type="number" min={0} max={swapMax} step={256} value={swapMb} onChange={e => setSwapMb(Number(e.target.value))} style={INPUT} inputMode="numeric" />
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
                      : identity?.ip ? (identity.ip.unknowns.length ? 'Not found in use, but not everything could be checked (see below).'
                        : 'Nothing in the cluster uses it. Press Check address to ping it.')
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
              {identity?.reverse?.nodes && identity.reverse.nodes.length > 1 && (
                <div className="rounded-lg border p-3 space-y-2" style={{ borderColor: 'color-mix(in srgb, var(--warn) 35%, transparent)' }}>
                  <p className="text-sm" style={{ color: 'var(--warn-2)' }}>
                    ID {vmid} fits more than one node by your ID rule. Which one did you mean?
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {identity.reverse.nodes.map(n => {
                      const ok = placement?.nodes.find(x => x.node === n)?.verdict.eligible
                      return <GhostButton key={n} type="button" disabled={!ok} onClick={() => setNode(n)}
                        style={{ height: 34, borderColor: n === node ? 'var(--accent)' : undefined }}>
                        {n}{n === node ? ' ✓' : ''}{ok ? '' : ' (not usable)'}
                      </GhostButton>
                    })}
                  </div>
                </div>
              )}
              {mode === 'static' && ip && (
                <div className="flex flex-wrap items-center gap-3">
                  <GhostButton type="button" onClick={() => void checkAddress()} disabled={pinging || (identity?.ip?.problems.length ?? 0) > 0}
                    style={{ height: 34 }}>{pinging ? 'Checking…' : 'Check address'}</GhostButton>
                  <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                    {pingResult?.ip === ip
                      ? (pingResult.answered === true ? <span style={{ color: 'var(--crit-soft)' }}>Something answered on {ip}.</span>
                        : pingResult.answered === false ? `Nothing answered a ping from ${node}. A firewalled device would not either.`
                          : `${ip} could not be pinged from ${node}.`)
                      : 'Sends one ping from the node. Install pings again before it creates anything.'}
                  </span>
                </div>
              )}
              {unknowns.length > 0 && (
                <div className="rounded-lg border p-3 space-y-2" style={{ borderColor: 'color-mix(in srgb, var(--warn) 35%, transparent)', background: 'color-mix(in srgb, var(--warn) 6%, transparent)' }}>
                  <p className="text-sm" style={{ color: 'var(--warn-2)' }}>HyperProx could not check everything about this address:</p>
                  <ul className="text-[13px] space-y-0.5" style={{ color: 'var(--text-muted)' }}>{unknowns.map((u, i) => <li key={i}>· {u}</li>)}</ul>
                  <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text)' }}>
                    <input type="checkbox" checked={addressAck} onChange={e => setAckedKeys(e.target.checked ? unknownKeys : null)} />
                    I checked this address myself, and nothing else uses it.
                  </label>
                </div>
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
                      ['Privileges', isArr ? 'unprivileged, nesting and keyctl' : 'unprivileged, nesting only'], ['Starts at boot', 'yes'],
                      ...(isArr ? arrReview(preview.plan.options as unknown as Record<string, string> | undefined, recipe.options ?? []) : []),
                      ...options.map(o => {
                        const v = (preview.plan.options as unknown as Record<string, string> | undefined)?.[o.key] ?? ''
                        return [o.label, o.kind === 'boolean' ? (v === '1' ? 'yes' : 'no') : (v || '—')] as [string, any]
                      }),
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

/** The Arr Stack's choices in the review, in words rather than as raw options. */
function arrReview(o: Record<string, string> | undefined, all: RecipeOption[]): Array<[string, string]> {
  if (!o) return []
  const apps = all.filter(x => x.kind === 'boolean' && x.key !== 'ARR_VPN' && o[x.key] === '1').map(x => x.label)
  const media = o.ARR_MEDIA === 'nfs' ? `NAS ${o.ARR_NFS_HOST}:${o.ARR_NFS_EXPORT} (NFS)` : o.ARR_MEDIA === 'path' ? `${o.ARR_HOST_PATH} on the node` : `new ${o.ARR_MEDIA_GB} GB disk`
  return [
    ['Apps', apps.join(', ')],
    ['VPN', o.ARR_VPN === '1' ? `qBittorrent through ${o.ARR_VPN_PROVIDER} (${o.ARR_VPN_TYPE === 'openvpn' ? 'OpenVPN' : 'WireGuard'})` : 'none'],
    ['Library', media],
    ['Downloads', o.ARR_DOWNLOADS === 'local' ? `container's own disk (${o.ARR_DOWNLOAD_GB} GB): no hardlinks` : 'with the library: hardlinks work'],
    ['Sign-in name', o.ARR_ADMIN_USER || '—'],
  ]
}
