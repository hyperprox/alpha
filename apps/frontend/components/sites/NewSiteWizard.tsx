'use client'

// =============================================================================
//  HyperProx — New website
//
//  One flow from nothing to a working site: the kind, the public name, where it
//  runs, the site basics, the whole plan, then the run. It is the catalogue
//  wizard underneath: the server reads the cluster, checks the name against the
//  DNS provider and the proxy, holds the plan, and Install sends only its id.
//
//  With `previewId` (a plan the AI assistant made through the same preview
//  route's code), the wizard opens on that held plan at Review, with every
//  earlier step filled in from it; Install still asks for the master password.
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiJson } from '@/lib/api'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { ModalFrame } from '@/components/layout/ModalFrame'
import { ConfirmOverride, NamingCallout, confirmNeeded, useProposal, type NamingSettingsView, type Proposal } from '@/components/catalogue/NamingProposal'
import { FlowPipeline, Pill, Tiles, styles } from '@/components/visual/kit'
import type { RecipeOption, WizardRecipe } from '@/components/catalogue/InstallWizard'

export interface SiteRecipe extends WizardRecipe {
  sizes?: Record<'small' | 'medium' | 'large', { cores: number; memoryMb: number; diskGb: number }> | null
  healthPath?: string
}

interface AddressOptions { dnsConfigured: boolean; domains: string[]; proxies: Array<{ id: string; name: string; kind: string; status: string | null; certificates: string }> }
interface AddressPlan {
  plan?: { domain: string; zone: string; name: string; instanceName: string; record: { type: string; name: string; data: string; ttl: number }; certificate: string }
  errors: string[]; warnings: string[]; checks: string[]; existing?: Array<{ type: string; data: string }>
}
interface NodeRow {
  node: string; online: boolean; cores: number; memTotalMb: number; memUsedMb: number
  bridges: Array<{ iface: string; cidr?: string; gateway?: string }>
  rootStorages: Array<{ storage: string; type: string; shared: boolean; freeGb: number }>
  verdict: { eligible: boolean; why: string[]; storage: { storage: string } | null }
}
interface Placement {
  nodes: NodeRow[]; recommendation: { node: string; reason: string } | null; nextVmid: number; partial: string[]
  naming?: { settings: NamingSettingsView | null; detection: Proposal['detection'] }
}
interface Identity {
  suggestedVmid: number
  vmid?: { free: boolean; problem?: string }
  reverse?: { ip?: string }
  ip?: { problems: string[]; unknowns: string[]; unknownKeys: string[]; pinged: boolean | null }
}
interface Preview { previewId: string; plan: any; checks: string[]; warnings: string[] }
interface Job {
  jobId: string; status: string; steps: Array<{ id: string; label: string; status: string; detail?: string }>
  error?: string; url?: string; vmid?: number; node?: string; created?: boolean; removed?: boolean; siteId?: string
  adminCredential?: { user: string; password: string }
}

const STEPS = ['Kind', 'Address', 'Placement', 'Basics', 'Review', 'Run'] as const
const SIZE_WORD = { small: 'Small', medium: 'Medium', large: 'Large' } as const

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block min-w-0">
      <span style={{ display: 'block', font: '500 .66rem var(--font-mono)', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6 }}>{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px]" style={{ color: 'var(--text-dim)' }}>{hint}</span>}
    </label>
  )
}
const Bad = ({ items }: { items: string[] }) => items.length ? <ul className="space-y-1">{items.map((p, i) => <li key={i} className="text-sm" style={{ color: 'var(--crit-soft)' }}>· {p}</li>)}</ul> : null
const Good = ({ items }: { items: string[] }) => items.length ? <ul className="space-y-0.5">{items.map((c, i) => <li key={i} className="text-[13px]" style={{ color: 'var(--text-muted)' }}>✓ {c}</li>)}</ul> : null

export function NewSiteWizard({ recipes, onClose, onDone, previewId }: { recipes: SiteRecipe[]; onClose: () => void; onDone: () => void; previewId?: string | null }) {
  const [step, setStep] = useState(0)
  const [recipe, setRecipe] = useState<SiteRecipe | null>(null)

  // Address
  const [addr, setAddr] = useState<AddressOptions | null>(null)
  const [lanOnly, setLanOnly] = useState(false)
  const [zone, setZone] = useState('')
  const [sub, setSub] = useState('')
  const [apex, setApex] = useState(false)
  const [proxy, setProxy] = useState('')
  const [addrPlan, setAddrPlan] = useState<AddressPlan | null>(null)
  const [checkingAddr, setCheckingAddr] = useState(false)

  // Placement
  const [size, setSize] = useState<'small' | 'medium' | 'large'>('medium')
  const [cores, setCores] = useState(1), [memoryMb, setMemoryMb] = useState(512), [diskGb, setDiskGb] = useState(4)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const [node, setNode] = useState(''), [storage, setStorage] = useState('')
  const [vmid, setVmid] = useState<number | ''>(''), [hostname, setHostname] = useState('')
  const [bridge, setBridge] = useState(''), [mode, setMode] = useState<'dhcp' | 'static'>('dhcp')
  const [ip, setIp] = useState(''), [gateway, setGateway] = useState('')
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [acked, setAcked] = useState(false)
  const [dns, setDns] = useState(''), [vlan, setVlan] = useState<number | ''>('')
  // The server's pick fills the ID and address in until the person changes one of them.
  const [touchedNet, setTouchedNet] = useState(false)
  const [namingConfirm, setNamingConfirm] = useState('')
  const { proposal, loading: proposing, error: proposeError, refresh: repropose } = useProposal(node, step === 2 && !!placement)
  const applyProposal = useCallback((p: Proposal) => {
    setVmid(p.vmid)
    if (p.bridge) setBridge(p.bridge)
    if (p.ip === 'dhcp') setMode('dhcp')
    else { setMode('static'); setIp(p.ip); setGateway(p.gateway ?? '') }
    setDns(p.dns.join(' ')); setVlan(p.vlan ?? '')
  }, [])
  useEffect(() => { if (proposal && !touchedNet) applyProposal(proposal) }, [proposal, touchedNet, applyProposal])
  useEffect(() => { setNamingConfirm('') }, [ip, mode])

  // Basics
  const [opts, setOpts] = useState<Record<string, string>>({})

  // Review and run
  const [preview, setPreview] = useState<Preview | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reconfirm, setReconfirm] = useState<null | 'apply' | 'cleanup'>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [cleanupNote, setCleanupNote] = useState('')

  const options: RecipeOption[] = recipe?.options ?? []
  const missing = options.filter(o => o.required && !String(opts[o.key] ?? '').trim())
  const selected = placement?.nodes.find(n => n.node === node)
  const domain = lanOnly ? '' : apex ? zone : sub && zone ? `${sub}.${zone}` : ''

  const pick = (r: SiteRecipe) => {
    setRecipe(r)
    setOpts(Object.fromEntries((r.options ?? []).map(o => [o.key, o.default ?? ''])))
    const sz = r.sizes?.medium ?? r.defaults
    setCores(sz.cores); setMemoryMb(sz.memoryMb); setDiskGb(sz.diskGb); setSize('medium')
    setSub(s => s || (r.id === 'wordpress' ? 'blog' : 'www'))
  }
  const applySize = (k: 'small' | 'medium' | 'large') => {
    const sz = recipe?.sizes?.[k]; if (!sz) return
    setSize(k); setCores(sz.cores); setMemoryMb(sz.memoryMb); setDiskGb(sz.diskGb); setPlacement(null)
  }

  useEffect(() => {
    if (step !== 1 || addr) return
    void apiJson<{ data: AddressOptions }>('/api/sites/address/options').then(r => {
      if (!r.ok || !r.body) return
      const a = r.body.data
      setAddr(a)
      if (!zone && a.domains[0]) setZone(a.domains[0])
      const usable = a.proxies.find(p => p.certificates !== 'none' && p.status !== 'locked')
      if (!proxy && usable) setProxy(usable.id)
      if (!a.dnsConfigured || !a.domains.length) setLanOnly(true)
    })
  }, [step, addr, zone, proxy])

  // A changed name is a new name: its check no longer applies.
  useEffect(() => { setAddrPlan(null) }, [zone, sub, apex, proxy, lanOnly])

  const checkAddress = async () => {
    setCheckingAddr(true)
    const r = await apiJson<{ data: AddressPlan }>('/api/sites/address', 'POST', { zone, name: apex ? '@' : sub, instanceId: proxy })
    setCheckingAddr(false)
    setAddrPlan(r.ok && r.body ? r.body.data : { errors: [r.error ?? 'The name could not be checked.'], warnings: [], checks: [] })
  }

  // Placement: read the cluster for this size, take the recommendation, propose the ID and hostname.
  useEffect(() => {
    if (step !== 2 || placement || !recipe) return
    const q = new URLSearchParams({ recipeId: recipe.id, cores: String(cores), memoryMb: String(memoryMb), diskGb: String(diskGb) })
    void apiJson<{ data: Placement }>(`/api/catalogue/wizard/placement?${q}`).then(r => {
      if (!r.ok || !r.body) { setError(r.error ?? 'Could not read the cluster.'); return }
      const p = r.body.data
      setPlacement(p)
      const n = p.nodes.find(x => x.node === node && x.verdict.eligible) ?? p.nodes.find(x => x.node === p.recommendation?.node)
      if (n) {
        setNode(n.node); setStorage(n.verdict.storage?.storage ?? '')
        const b = n.bridges.find(x => x.gateway) ?? n.bridges[0]; setBridge(b?.iface ?? ''); if (b?.gateway) setGateway(b.gateway)
      }
      if (vmid === '') setVmid(p.nextVmid)
      if (!hostname) setHostname((domain.split('.')[0] || recipe.id).replace(/[^a-z0-9-]/g, '-').slice(0, 63))
    })
  }, [step, placement, recipe, cores, memoryMb, diskGb, node, vmid, hostname, domain])

  // As the identity is typed: the ID free, the ID rule's address, and the address free.
  useEffect(() => {
    if (step !== 2 || !node) return
    const t = setTimeout(async () => {
      const body: any = { node, bridge }
      if (typeof vmid === 'number') body.vmid = vmid
      if (mode === 'static' && ip) { body.ip = ip; if (gateway) body.gateway = gateway }
      const r = await apiJson<{ data: Identity }>('/api/catalogue/wizard/identity', 'POST', body)
      if (!r.ok || !r.body) return
      setIdentity(r.body.data)
      if (r.body.data.reverse?.ip && mode === 'dhcp' && !ip) { setMode('static'); setIp(r.body.data.reverse.ip) }
    }, 400)
    return () => clearTimeout(t)
  }, [step, node, bridge, vmid, mode, ip, gateway])
  useEffect(() => { setAcked(false) }, [ip, mode, node])

  const unknownKeys = mode === 'static' ? identity?.ip?.unknownKeys ?? [] : []
  const overrideNeed = confirmNeeded(placement?.naming?.settings, mode, ip)

  const canNext = useMemo(() => {
    if (step === 0) return Boolean(recipe)
    if (step === 1) return lanOnly || Boolean(addrPlan?.plan)
    if (step === 2) {
      if (!selected?.verdict.eligible || !storage || typeof vmid !== 'number' || !hostname || !bridge) return false
      if (identity?.vmid && !identity.vmid.free) return false
      if (mode === 'static' && (!ip || (identity?.ip?.problems.length ?? 0) > 0)) return false
      if (unknownKeys.length && !acked) return false
      if (overrideNeed && namingConfirm.trim().toUpperCase() !== overrideNeed.word.toUpperCase()) return false
      return true
    }
    if (step === 3) return missing.length === 0
    return true
  }, [step, recipe, lanOnly, addrPlan, selected, storage, vmid, hostname, bridge, identity, mode, ip, unknownKeys, acked, missing, overrideNeed, namingConfirm])

  const makePreview = async () => {
    if (!recipe) return
    setBusy(true); setError(''); setProblems([]); setPreview(null)
    // A public address the person gave in the basics wins; otherwise the published name is WordPress's address.
    const sent = { ...opts }
    if (recipe.id === 'wordpress' && domain && !sent.WP_URL) sent.WP_URL = `https://${domain}`
    const r = await apiJson<{ data: Preview }>('/api/catalogue/wizard/preview', 'POST', {
      recipeId: recipe.id, node, vmid, hostname, cores, memoryMb, swapMb: Math.min(512, memoryMb), diskGb, storage, bridge,
      ip: mode === 'dhcp' ? 'dhcp' : ip, ...(mode === 'static' && gateway ? { gateway } : {}),
      ...(dns.trim() ? { dns: dns.trim() } : {}), ...(vlan !== '' ? { vlan } : {}),
      ...(overrideNeed ? { namingConfirm } : {}),
      ...(mode === 'static' && acked && unknownKeys.length ? { addressAck: unknownKeys } : {}),
      options: sent, ...(domain ? { publish: { zone, name: apex ? '@' : sub, instanceId: proxy } } : {}),
    })
    setBusy(false)
    if (!r.ok) { setError(r.error ?? 'The plan could not be checked.'); setProblems((r.body as any)?.problems ?? []); return }
    setPreview(r.body!.data)
  }

  const apply = async () => {
    if (!preview) return
    setBusy(true); setError('')
    const r = await apiJson<{ data: { jobId: string; steps: Job['steps'] } }>('/api/catalogue/wizard/apply', 'POST', { previewId: preview.previewId })
    setBusy(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm('apply'); return }
    if (!r.ok) { setError(r.error ?? 'The install could not be started.'); setProblems((r.body as any)?.problems ?? []); setPreview(null); return }
    setJob({ jobId: r.body!.data.jobId, status: 'running', steps: r.body!.data.steps })
    setStep(5)
  }

  // The run: poll, with the read-back each step reports.
  useEffect(() => {
    if (!job || job.status !== 'running') return
    const t = setInterval(async () => {
      const r = await apiJson<{ data: Job }>(`/api/catalogue/jobs/${job.jobId}`)
      if (r.ok && r.body) setJob(r.body.data)
    }, 2500)
    return () => clearInterval(t)
  }, [job])

  const cleanup = async () => {
    if (!job) return
    if (!window.confirm(`Remove what this run made: CT ${job.vmid}, and its proxy host and DNS record if they were made? Nothing else is touched.`)) return
    setBusy(true)
    const r = await apiJson<{ data: { detail: string } }>(`/api/catalogue/wizard/jobs/${job.jobId}/cleanup`, 'POST')
    setBusy(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm('cleanup'); return }
    setCleanupNote(r.ok ? r.body!.data.detail : r.error ?? 'Clean-up failed.')
    if (r.ok) setJob({ ...job, removed: true })
  }

  // A held plan from the assistant: read it back (it is this person's, or the server says there is none) and open Review.
  const [loadedPreview, setLoadedPreview] = useState(false)
  useEffect(() => {
    if (!previewId || loadedPreview || !recipes.length) return
    setLoadedPreview(true)
    void apiJson<{ data: Preview & { used?: boolean } }>(`/api/catalogue/wizard/preview/${encodeURIComponent(previewId)}`).then(r => {
      if (!r.ok || !r.body) { setError(r.error ?? 'That plan has expired. Make it again, here or with the assistant.'); return }
      const pv = r.body.data, pl = pv.plan
      const rc = recipes.find(x => x.id === pl.recipeId)
      if (!rc || pv.used) { setError(pv.used ? 'That plan was already installed.' : 'That plan is not for a website.'); return }
      setRecipe(rc); setOpts(Object.fromEntries(Object.entries(pl.options ?? {}).map(([k, v]) => [k, String(v)])))
      setCores(pl.cores); setMemoryMb(pl.memoryMb); setDiskGb(pl.diskGb)
      setNode(pl.node); setStorage(pl.storage); setVmid(pl.vmid); setHostname(pl.hostname); setBridge(pl.bridge)
      setTouchedNet(true)
      if (pl.ip && pl.ip !== 'dhcp') { setMode('static'); setIp(pl.ip); if (pl.gateway) setGateway(pl.gateway) }
      if (pl.dns) setDns(String(pl.dns)); if (pl.vlan) setVlan(Number(pl.vlan))
      if (pl.publish) { setLanOnly(false); setZone(pl.publish.zone); setApex(pl.publish.name === '@'); setSub(pl.publish.name === '@' ? '' : pl.publish.name); setProxy(pl.publish.instanceId) }
      else setLanOnly(true)
      setPreview({ previewId: pv.previewId, plan: pl, checks: pv.checks, warnings: pv.warnings })
      setStep(4)
    })
  }, [previewId, loadedPreview, recipes])

  const go = (to: number) => { setError(''); setProblems([]); if (to === 4) void makePreview(); setStep(to) }
  const field = styles.field

  return (
    <ModalFrame label="New website" escape={false}
      frameClassName={styles.card} frameStyle={{ padding: 0 }}
      after={reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const w = reconfirm; setReconfirm(null); void (w === 'apply' ? apply() : cleanup()) }} />}
      header={<>
        <div className="flex items-start justify-between gap-3 border-b px-4 sm:px-6 py-4" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="min-w-0">
            <p className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--accent)' }}>New website · step {step + 1} of {STEPS.length}</p>
            <h2 className="font-display text-[26px] font-bold uppercase leading-tight truncate" style={{ color: 'var(--text-bright)', letterSpacing: '.04em' }}>
              {recipe?.name ?? 'Choose a kind'}{domain ? ` · ${domain}` : ''}
            </h2>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-lg px-2" style={{ color: 'var(--text-muted)' }} disabled={job?.status === 'running'}>✕</button>
        </div>
        <div className="px-4 sm:px-6 pt-3">
          <FlowPipeline label="Wizard steps" stages={STEPS.map((s, i) => ({ key: s, label: s, value: i < step ? '✓' : i + 1, state: i < step ? 'done' : i === step ? 'ok' : undefined }))} />
        </div>
      </>}
      footer={<>
        {step < 5 ? <button type="button" className={styles.btn} onClick={() => (step === 0 ? onClose() : go(step - 1))} disabled={busy}>{step === 0 ? 'Cancel' : 'Back'}</button>
          : <span />}
        {step < 4 && <button type="button" className={`${styles.btn} ${styles.btnPri}`} onClick={() => go(step + 1)} disabled={!canNext}>Next</button>}
        {step === 4 && !preview && !busy && <button type="button" className={`${styles.btn} ${styles.btnPri}`} onClick={() => void makePreview()}>Check again</button>}
        {step === 4 && preview && <button type="button" className={`${styles.btn} ${styles.btnPri}`} onClick={() => void apply()} disabled={busy}>{busy ? 'Starting…' : 'Install'}</button>}
        {step === 5 && job?.status !== 'running' && <button type="button" className={`${styles.btn} ${styles.btnPri}`} onClick={onDone}>Done</button>}
      </>}>
          {step === 0 && (
            <div className="grid gap-3 sm:grid-cols-3">
              {recipes.map(r => (
                <button key={r.id} type="button" onClick={() => pick(r)} aria-pressed={recipe?.id === r.id} className={styles.card}
                  style={{ textAlign: 'left', borderColor: recipe?.id === r.id ? 'var(--accent)' : undefined }}>
                  <b className="font-display" style={{ fontSize: 19, color: 'var(--text-bright)' }}>{r.name}</b>
                  <p style={{ margin: '6px 0 0', fontSize: 13, lineHeight: 1.5, color: 'var(--text-muted)' }}>{r.summary}</p>
                </button>
              ))}
              <div className={styles.card} aria-disabled="true" style={{ opacity: 0.55 }}>
                <b className="font-display" style={{ fontSize: 19, color: 'var(--text-bright)' }}>Ghost</b>
                <p style={{ margin: '6px 0 0', fontSize: 13, lineHeight: 1.5, color: 'var(--text-muted)' }}>
                  Not available yet. Ghost supports only MySQL 8 in production, which Debian 13 does not ship, and its installer takes the database password on the command line.
                </p>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              {!addr && <p className={styles.empty}>reading your domains and proxies…</p>}
              {addr && !addr.dnsConfigured && <p className={styles.callout}>No DNS provider is set up, so this site can only be reached on your network. Add one under Settings → DNS to publish it.</p>}
              {addr && (
                <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text)' }}>
                  <input type="checkbox" checked={lanOnly} onChange={e => setLanOnly(e.target.checked)} disabled={!addr.dnsConfigured || !addr.domains.length} />
                  Do not publish it: reachable on my network only
                </label>
              )}
              {addr && !lanOnly && (
                <>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label="Domain">
                      <select className={field} value={zone} onChange={e => setZone(e.target.value)}>
                        {addr.domains.map(d => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </Field>
                    <Field label="Name" hint={apex ? `The site answers on ${zone} itself.` : `The site answers on ${sub || '…'}.${zone}.`}>
                      <input className={field} value={apex ? '' : sub} disabled={apex} onChange={e => setSub(e.target.value.toLowerCase().trim())} placeholder="blog" autoCapitalize="none" spellCheck={false} />
                    </Field>
                    <Field label="Proxy" hint="It serves the site and holds its certificate.">
                      <select className={field} value={proxy} onChange={e => setProxy(e.target.value)}>
                        {addr.proxies.map(p => <option key={p.id} value={p.id} disabled={p.certificates === 'none' || p.status === 'locked'}>
                          {p.name} · {p.kind}{p.certificates === 'none' ? ' (no certificates)' : p.status === 'locked' ? ' (locked)' : ''}</option>)}
                      </select>
                    </Field>
                  </div>
                  <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text)' }}>
                    <input type="checkbox" checked={apex} onChange={e => setApex(e.target.checked)} /> Use the domain itself ({zone}), not a name under it
                  </label>
                  <button type="button" className={styles.btn} onClick={() => void checkAddress()} disabled={checkingAddr || !zone || (!apex && !sub) || !proxy}>
                    {checkingAddr ? 'Checking…' : 'Check this name'}
                  </button>
                  {addrPlan && <Bad items={addrPlan.errors} />}
                  {addrPlan?.warnings.length ? <p className={styles.callout}>{addrPlan.warnings.join(' ')}</p> : null}
                  {addrPlan?.plan && (
                    <div className={styles.card}>
                      <p className="font-mono text-[10px] uppercase tracking-[0.14em] mb-2" style={{ color: 'var(--good)' }}>Will be created</p>
                      <Tiles label="DNS record" items={[
                        { label: 'type', value: addrPlan.plan.record.type }, { label: 'name', value: addrPlan.plan.record.name },
                        { label: 'points to', value: addrPlan.plan.record.data }, { label: 'TTL', value: addrPlan.plan.record.ttl },
                      ]} />
                      <div style={{ marginTop: 10 }}><Good items={addrPlan.checks} /></div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {step === 2 && recipe && (
            <div className="space-y-4">
              {recipe.sizes && (
                <div role="group" aria-label="Site size" className={styles.row} style={{ gap: 8, flexWrap: 'wrap' }}>
                  {(['small', 'medium', 'large'] as const).map(k => (
                    <button key={k} type="button" aria-pressed={size === k} onClick={() => applySize(k)} className={`${styles.btn} ${size === k ? styles.btnPri : ''}`}>
                      {SIZE_WORD[k]} · {recipe.sizes![k].cores} core{recipe.sizes![k].cores > 1 ? 's' : ''}, {recipe.sizes![k].memoryMb} MB, {recipe.sizes![k].diskGb} GB
                    </button>
                  ))}
                </div>
              )}
              <div className="grid gap-4 grid-cols-3">
                <Field label="Cores"><input className={field} type="number" min={1} value={cores} onChange={e => { setCores(Number(e.target.value)); setPlacement(null) }} /></Field>
                <Field label="RAM (MB)"><input className={field} type="number" min={64} step={256} value={memoryMb} onChange={e => { setMemoryMb(Number(e.target.value)); setPlacement(null) }} /></Field>
                <Field label="Disk (GB)"><input className={field} type="number" min={1} value={diskGb} onChange={e => { setDiskGb(Number(e.target.value)); setPlacement(null) }} /></Field>
              </div>
              {!placement && <p className={styles.empty}>reading the cluster…</p>}
              {placement?.recommendation && <p className={styles.callout}>Recommended: {placement.recommendation.reason}</p>}
              {placement && (
                <NamingCallout proposal={proposal} loading={proposing} error={proposeError} applied={!touchedNet}
                  onUse={() => { setTouchedNet(false); if (proposal) applyProposal(proposal) }} onRefresh={() => { setTouchedNet(false); void repropose() }} />
              )}
              {placement && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Node">
                    <select className={field} value={node} onChange={e => {
                      const n = placement.nodes.find(x => x.node === e.target.value)
                      setNode(e.target.value); setStorage(n?.verdict.storage?.storage ?? '')
                    }}>
                      {placement.nodes.map(n => <option key={n.node} value={n.node} disabled={!n.verdict.eligible}>
                        {n.node} · {((n.memTotalMb - n.memUsedMb) / 1024).toFixed(1)} GB free{n.verdict.eligible ? '' : ` (${n.verdict.why[0] ?? 'not usable'})`}</option>)}
                    </select>
                  </Field>
                  <Field label="Storage">
                    <select className={field} value={storage} onChange={e => setStorage(e.target.value)}>
                      {(selected?.rootStorages ?? []).map(s => <option key={s.storage} value={s.storage}>{s.storage} · {s.type} · {s.shared ? 'shared' : 'local'} · {s.freeGb} GB free</option>)}
                    </select>
                  </Field>
                  <Field label="Container ID" hint={identity?.vmid && !identity.vmid.free ? <span style={{ color: 'var(--crit-soft)' }}>{identity.vmid.problem}</span> : `Suggested ${identity?.suggestedVmid ?? placement.nextVmid}.`}>
                    <input className={field} type="number" value={vmid} onChange={e => { setTouchedNet(true); setVmid(e.target.value === '' ? '' : Number(e.target.value)) }} />
                  </Field>
                  <Field label="Hostname"><input className={field} value={hostname} onChange={e => setHostname(e.target.value.toLowerCase())} autoCapitalize="none" spellCheck={false} /></Field>
                  <Field label="Bridge">
                    <select className={field} value={bridge} onChange={e => setBridge(e.target.value)}>
                      {(selected?.bridges ?? []).map(b => <option key={b.iface} value={b.iface}>{b.iface}{b.cidr ? ` · ${b.cidr}` : ''}</option>)}
                    </select>
                  </Field>
                  <Field label="Address" hint={mode === 'static' ? (identity?.ip?.problems.length ? <span style={{ color: 'var(--crit-soft)' }}>{identity.ip.problems.join(' ')}</span> : 'Checked against every guest as you type; Install pings it again.') : <span style={{ color: 'var(--warn)' }}>From DHCP, which may hand out an address on another network. A fixed address suits a published site better.</span>}>
                    <div className={styles.row} style={{ gap: 8 }}>
                      <select className={field} value={mode} onChange={e => { setTouchedNet(true); setMode(e.target.value as 'dhcp' | 'static') }} style={{ maxWidth: 120 }}>
                        <option value="dhcp">DHCP</option><option value="static">Fixed</option>
                      </select>
                      {mode === 'static' && <input className={field} value={ip} onChange={e => { setTouchedNet(true); setIp(e.target.value.trim()) }} placeholder="192.0.2.50/24" />}
                    </div>
                  </Field>
                  {mode === 'static' && <Field label="Gateway"><input className={field} value={gateway} onChange={e => { setTouchedNet(true); setGateway(e.target.value.trim()) }} /></Field>}
                  {mode === 'static' && <Field label="DNS servers" hint="Optional. Blank uses the node's."><input className={field} value={dns} onChange={e => setDns(e.target.value)} placeholder="192.0.2.53" /></Field>}
                  <Field label="VLAN tag" hint="Optional; blank for none.">
                    <input className={field} type="number" min={1} max={4094} value={vlan} onChange={e => setVlan(e.target.value === '' ? '' : Number(e.target.value))} />
                  </Field>
                </div>
              )}
              {overrideNeed && <ConfirmOverride need={overrideNeed} value={namingConfirm} onChange={setNamingConfirm} inputStyle={{}} />}
              {unknownKeys.length > 0 && (
                <div className={styles.callout}>
                  <p style={{ margin: '0 0 6px' }}>HyperProx could not check everything about this address:</p>
                  <ul>{identity!.ip!.unknowns.map((u, i) => <li key={i}>· {u}</li>)}</ul>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={acked} onChange={e => setAcked(e.target.checked)} /> I checked this address myself.</label>
                </div>
              )}
            </div>
          )}

          {step === 3 && recipe && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                {options.map(o => o.kind === 'boolean' ? (
                  <label key={o.key} className="flex items-start gap-2 text-sm" style={{ color: 'var(--text)' }}>
                    <input type="checkbox" checked={opts[o.key] === '1'} onChange={e => setOpts(v => ({ ...v, [o.key]: e.target.checked ? '1' : '0' }))} />
                    <span>{o.label}{o.hint && <span className="block text-[12px]" style={{ color: 'var(--text-dim)' }}>{o.hint}</span>}</span>
                  </label>
                ) : (
                  <Field key={o.key} label={`${o.label}${o.required ? ' *' : ''}`} hint={o.key === 'WP_URL' && domain ? `Blank uses https://${domain}.` : o.hint}>
                    <input className={field} value={opts[o.key] ?? ''} onChange={e => setOpts(v => ({ ...v, [o.key]: e.target.value }))}
                      type={o.kind === 'number' ? 'number' : o.kind === 'email' ? 'email' : 'text'} min={o.min} max={o.max} maxLength={o.maxLength}
                      placeholder={o.placeholder} autoCapitalize="none" spellCheck={o.kind === 'text'} />
                  </Field>
                ))}
              </div>
              {recipe.firstRunKind === 'env-admin' && (
                <p className={styles.callout}>The admin password and the database password are generated, saved in the vault before anything installs, and never shown in a log. The admin password is shown to you once when the install finishes, and the vault can reveal both later.</p>
              )}
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4">
              {busy && !preview && <p className={styles.empty}>checking the whole plan…</p>}
              {error && <p className={styles.callout} style={{ color: 'var(--crit-soft)' }}>{error}</p>}
              <Bad items={problems} />
              {preview && (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className={styles.card}>
                      <p className="font-mono text-[10px] uppercase tracking-[0.14em] mb-2" style={{ color: 'var(--accent)' }}>Container</p>
                      <Tiles label="Container" items={[
                        { label: 'CT', value: preview.plan.vmid }, { label: 'node', value: preview.plan.node },
                        { label: 'cores', value: preview.plan.cores }, { label: 'MB RAM', value: preview.plan.memoryMb }, { label: 'GB disk', value: preview.plan.diskGb },
                      ]} />
                      <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>{preview.plan.hostname} on {preview.plan.storage}, {preview.plan.ip === 'dhcp' ? <b style={{ color: 'var(--warn)' }}>DHCP: no fixed address (see the warning below)</b> : <b style={{ color: 'var(--text-bright)' }}>{preview.plan.ip}</b>}{preview.plan.vlan ? `, VLAN ${preview.plan.vlan}` : ''}, unprivileged.
                        {proposal && proposal.ip === preview.plan.ip && proposal.vmid === preview.plan.vmid && proposal.ip !== 'dhcp' ? ` ${proposal.label}.` : ''}</p>
                    </div>
                    <div className={styles.card}>
                      <p className="font-mono text-[10px] uppercase tracking-[0.14em] mb-2" style={{ color: 'var(--accent)' }}>Publishing</p>
                      {preview.plan.publish ? (
                        <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                          <li>DNS: <b>{preview.plan.publish.record.type} {preview.plan.publish.record.name}</b> in {preview.plan.publish.zone} → {preview.plan.publish.record.data}</li>
                          <li>Proxy host: {preview.plan.publish.domain} → this container, port {recipe?.port}, on {preview.plan.publish.instanceName}</li>
                          <li>Certificate: {preview.plan.publish.certificate === 'request' ? `Let's Encrypt for ${preview.plan.publish.domain}, HTTPS forced` : `${preview.plan.publish.instanceName} gets its own`}</li>
                          <li>Then: https://{preview.plan.publish.domain}{recipe?.healthPath} must answer.</li>
                        </ul>
                      ) : <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>Not published: reachable on your network only.</p>}
                    </div>
                    {recipe?.firstRunKind === 'env-admin' && (
                      <div className={styles.card}>
                        <p className="font-mono text-[10px] uppercase tracking-[0.14em] mb-2" style={{ color: 'var(--accent)' }}>Vault</p>
                        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>One item, apps/{recipe.id}-{preview.plan.vmid}: admin user, admin password, database password.</p>
                      </div>
                    )}
                    <div className={styles.card}>
                      <p className="font-mono text-[10px] uppercase tracking-[0.14em] mb-2" style={{ color: 'var(--accent)' }}>Site</p>
                      <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                        {options.filter(o => preview.plan.options?.[o.key]).map(o => (
                          <li key={o.key}>{o.label}: {o.kind === 'boolean' ? (preview.plan.options[o.key] === '1' ? 'yes' : 'no') : preview.plan.options[o.key]}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  <Good items={preview.checks} />
                  {preview.warnings.length > 0 && <p className={styles.callout}>{preview.warnings.join(' ')}</p>}
                  <p style={{ fontSize: 13, color: 'var(--text-dim)' }}>Install asks for your master password, checks the cluster and the name again, then runs.</p>
                </>
              )}
            </div>
          )}

          {step === 5 && job && (
            <div className="space-y-4">
              <FlowPipeline label="Install steps" stages={job.steps.map(s => ({
                key: s.id, label: s.label, value: s.status === 'done' ? '✓' : s.status === 'failed' ? '✕' : s.status === 'running' ? '…' : '·',
                sub: s.detail, state: s.status === 'done' ? 'done' : s.status === 'failed' ? 'bad' : s.status === 'running' ? 'ok' : undefined,
              }))} />
              <ul className="space-y-1">{job.steps.filter(s => s.detail).map(s => (
                <li key={s.id} className="text-[13px]" style={{ color: s.status === 'failed' ? 'var(--crit-soft)' : 'var(--text-muted)' }}>{s.label}: {s.detail}</li>
              ))}</ul>
              {job.status === 'running' && <p className={styles.empty}>installing… this takes a few minutes</p>}
              {job.status === 'completed' && (
                <div className={styles.card} style={{ borderColor: 'var(--good)' }}>
                  <Pill tone="good">live</Pill>
                  {job.url && <p style={{ margin: '8px 0' }}><a href={job.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{job.url}</a></p>}
                  {job.adminCredential && (
                    <p style={{ margin: '8px 0', fontSize: 13, color: 'var(--text-muted)' }}>
                      Admin <b>{job.adminCredential.user}</b>, password <code className="select-all" style={{ color: 'var(--text-bright)' }}>{job.adminCredential.password}</code>. Shown once here; the vault keeps it.
                    </p>
                  )}
                </div>
              )}
              {(job.status === 'failed' || job.status === 'interrupted') && (
                <div className={styles.card} style={{ borderColor: 'var(--crit)' }}>
                  <p style={{ margin: '0 0 8px', color: 'var(--crit-soft)' }}>{job.error}</p>
                  {job.created && !job.removed && (
                    <button type="button" className={`${styles.btn} ${styles.btnDanger}`} disabled={busy} onClick={() => void cleanup()}>
                      Remove what this run made
                    </button>
                  )}
                  {cleanupNote && <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>{cleanupNote}</p>}
                </div>
              )}
            </div>
          )}
    </ModalFrame>
  )
}
