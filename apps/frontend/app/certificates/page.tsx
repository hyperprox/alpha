'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CertsEvent, CertsHousekeepingItem, CertsManaged, CertsOverview, CertsProbe } from '@hyperprox/types'
import { apiJson, atLeast, type ApiResult } from '@/lib/api'
import { useSession } from '@/lib/session'
import { Btn, ConfirmDialog, Notice, Panel } from '@/components/certificates/ui'
import { PolicyStrip } from '@/components/certificates/PolicyStrip'
import { Inventory } from '@/components/certificates/Inventory'
import { ManagedList, neverIssued } from '@/components/certificates/Managed'
import { Probes } from '@/components/certificates/Probes'
import { HousekeepingList, KIND_EFFECT, KIND_LABEL } from '@/components/certificates/Housekeeping'
import { EventsList } from '@/components/certificates/Events'

const POLL_BUSY_MS = 5_000
const POLL_IDLE_MS = 60_000
// After Issue/Renew/Deploy, poll fast for this long whatever the status says: a deploy never shows
// `renewing`, and a quick issue can finish between two slow polls, so its outcome would sit unseen.
const POLL_AFTER_ACTION_MS = 60_000

// The backend may land after this page; a 404 is "not there yet", not a failure to alarm about.
function apiError(r: ApiResult, what: string): string {
  if (r.status === 404) return `The Certificates API is not available on this server yet (${what}).`
  if (r.status === 403) return 'Certificates is limited to admins.'
  if (r.status === 503) return `${r.error ?? 'A dependency is down'} (${what}).`
  return r.error ?? `Could not load ${what}`
}

export default function CertificatesPage() {
  const { role } = useSession()
  const allowed = atLeast(role, 'admin')

  const [ov, setOv] = useState<CertsOverview | null>(null)
  const [ovErr, setOvErr] = useState<string | null>(null)
  const [events, setEvents] = useState<CertsEvent[]>([])
  const [evErr, setEvErr] = useState<string | null>(null)
  const [evLabel, setEvLabel] = useState('')
  const [hk, setHk] = useState<CertsHousekeepingItem[] | null>(null)
  const [hkErr, setHkErr] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState<Set<string>>(new Set())
  const [notice, setNotice] = useState<{ tone: 'warn' | 'crit' | 'info'; text: string } | null>(null)
  const [firstIssue, setFirstIssue] = useState<CertsManaged | null>(null)
  const [applying, setApplying] = useState<CertsHousekeepingItem | null>(null)
  const [burstUntil, setBurstUntil] = useState(0)

  const loadOverview = useCallback(async (fresh: boolean) => {
    const r = await apiJson<CertsOverview>('/api/certs/overview' + (fresh ? '?refresh=1' : ''))
    if (r.ok && r.body) { setOv(r.body); setOvErr(null) } else setOvErr(apiError(r, 'overview'))
  }, [])

  const evLabelRef = useRef(evLabel)
  evLabelRef.current = evLabel
  const loadEvents = useCallback(async () => {
    const q = new URLSearchParams({ limit: '50' })
    if (evLabelRef.current) q.set('label', evLabelRef.current)
    const r = await apiJson<{ events: CertsEvent[] }>('/api/certs/events?' + q)
    if (r.ok && r.body) { setEvents(r.body.events); setEvErr(null) } else setEvErr(apiError(r, 'events'))
  }, [])

  const loadHk = useCallback(async () => {
    const r = await apiJson<{ items: CertsHousekeepingItem[] }>('/api/certs/housekeeping')
    if (r.ok && r.body) { setHk(r.body.items); setHkErr(null) } else { setHk(null); setHkErr(apiError(r, 'housekeeping')) }
  }, [])

  useEffect(() => {
    if (!allowed) return
    loadOverview(false); loadHk()
  }, [allowed, loadOverview, loadHk])

  useEffect(() => { if (allowed) loadEvents() }, [allowed, evLabel, loadEvents])

  // Poll quickly while anything is being issued or just after an action, slowly otherwise. A finished
  // renewal or deploy also changes the history, so events ride along on each fast poll.
  const renewing = !!ov?.managed.some(m => m.status === 'renewing')
  useEffect(() => {
    if (!burstUntil) return
    const t = setTimeout(() => setBurstUntil(0), Math.max(0, burstUntil - Date.now()))
    return () => clearTimeout(t)
  }, [burstUntil])
  const fast = renewing || burstUntil > 0
  useEffect(() => {
    if (!allowed) return
    const t = setInterval(() => { loadOverview(false); if (fast) loadEvents() }, fast ? POLL_BUSY_MS : POLL_IDLE_MS)
    return () => clearInterval(t)
  }, [allowed, fast, loadOverview, loadEvents])

  // --- actions --------------------------------------------------------------------------------

  const checkNow = async () => {
    setRefreshing(true); setNotice(null)
    await loadOverview(true)
    await loadEvents()
    setRefreshing(false)
  }

  const checkOne = async (p: CertsProbe) => {
    const key = `${p.host}:${p.port}`
    setChecking(s => new Set(s).add(key)); setNotice(null)
    const r = await apiJson<{ probes: CertsProbe[] }>('/api/certs/probe', 'POST', { host: p.host, port: p.port })
    if (!r.ok || !r.body) setNotice({ tone: 'crit', text: apiError(r, `probe of ${key}`) })
    else {
      const got = r.body.probes
      setOv(o => o && { ...o, probes: o.probes.map(x => got.find(g => g.host === x.host && g.port === x.port) ?? x) })
      loadOverview(false)
    }
    setChecking(s => { const n = new Set(s); n.delete(key); return n })
  }

  // 409: already renewing. Say so and show the live state instead of reporting a failure.
  const managedAction = async (m: CertsManaged, verb: 'issue' | 'deploy') => {
    setBusy(true); setNotice(null)
    const r = await apiJson<{ managed: CertsManaged }>(`/api/certs/managed/${encodeURIComponent(m.label)}/${verb}`, 'POST')
    setBusy(false)
    if (r.status === 409) setNotice({ tone: 'info', text: `${m.label} is already being processed. Showing its progress.` })
    else if (!r.ok || !r.body?.managed) { setNotice({ tone: 'crit', text: apiError(r, verb) }); return }
    else {
      const next = r.body.managed
      setOv(o => o && { ...o, managed: o.managed.map(x => x.label === next.label ? next : x) })
    }
    setBurstUntil(Date.now() + POLL_AFTER_ACTION_MS)
    loadOverview(false); loadEvents()
  }

  const onIssue = (m: CertsManaged) => { if (neverIssued(m)) setFirstIssue(m); else managedAction(m, 'issue') }

  const confirmIssue = () => {
    const m = firstIssue
    setFirstIssue(null)
    if (m) managedAction(m, 'issue')
  }

  const confirmApply = async () => {
    const item = applying
    if (!item) return
    setApplying(null); setBusy(true); setNotice(null)
    const r = await apiJson<{ ok: true; detail: string }>(`/api/certs/housekeeping/${encodeURIComponent(item.id)}/apply`, 'POST')
    setBusy(false)
    if (!r.ok) setNotice({ tone: 'crit', text: apiError(r, 'housekeeping') })
    else setNotice({ tone: 'info', text: r.body?.detail ?? 'Done.' })
    loadHk(); loadEvents(); loadOverview(false)
  }

  // --- render ---------------------------------------------------------------------------------

  if (role && !allowed) {
    return (
      <div className="min-h-full p-4 sm:p-8" style={{ background: 'var(--ground)' }}>
        <h1 className="font-display font-bold" style={{ fontSize: 36, lineHeight: 1.1, color: 'var(--text-bright)' }}>Certificates</h1>
        <p className="mt-4 max-w-xl rounded-md border px-3 py-2 text-sm"
           style={{ background: 'var(--surface-notice)', borderColor: 'var(--border-soft)', color: 'var(--text)' }}>
          Your role can&apos;t view certificates. Ask an owner or admin.
        </p>
      </div>
    )
  }

  const labels = ov?.managed.map(m => m.label) ?? []

  return (
    <div className="min-h-full space-y-5 p-4 sm:p-8" style={{ background: 'var(--ground)' }}>
      <div>
        <p className="font-mono" style={{ fontSize: 11, letterSpacing: '0.14em', color: 'var(--text-dimmer)' }}>MANAGE</p>
        <h1 className="mt-2 font-display font-bold" style={{ fontSize: 36, lineHeight: 1.1, color: 'var(--text-bright)' }}>Certificates</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
          Every certificate this network serves, what is actually served at each endpoint, and the ones HyperProx issues and renews itself.
        </p>
      </div>

      <PolicyStrip policy={ov?.policy ?? null} error={ovErr} checkedAt={ov?.checkedAt ?? null} refreshing={refreshing} onCheck={checkNow} />

      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      <Panel title="Inventory">
        {!ov ? <p className="px-5 py-6 text-sm" style={{ color: 'var(--text-muted)' }}>{ovErr ? 'Inventory unavailable.' : 'Reading certificates...'}</p>
          : <Inventory entries={ov.inventory} />}
      </Panel>

      <Panel title="Managed by HyperProx">
        {!ov ? <p className="px-5 py-6 text-sm" style={{ color: 'var(--text-muted)' }}>{ovErr ? 'Unavailable.' : 'Reading...'}</p>
          : <ManagedList items={ov.managed} busy={busy} onIssue={onIssue} onDeploy={m => managedAction(m, 'deploy')} />}
      </Panel>

      <Panel title="Endpoints">
        {!ov ? <p className="px-5 py-6 text-sm" style={{ color: 'var(--text-muted)' }}>{ovErr ? 'Unavailable.' : 'Reading...'}</p>
          : <Probes probes={ov.probes} checking={checking} onCheck={checkOne} />}
      </Panel>

      <Panel title="Housekeeping">
        {hkErr ? <div className="p-5"><Notice tone="warn">{hkErr}</Notice></div>
          : !hk ? <p className="px-5 py-6 text-sm" style={{ color: 'var(--text-muted)' }}>Reading...</p>
          : <HousekeepingList items={hk} busy={busy} onApply={setApplying} />}
      </Panel>

      <Panel title="Events">
        <EventsList events={events} labels={labels} label={evLabel} onLabel={setEvLabel} error={evErr} />
      </Panel>

      {firstIssue && (
        <ConfirmDialog title={`Issue ${firstIssue.label}?`} onClose={() => setFirstIssue(null)}>
          <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
            Every name on a publicly trusted certificate is published in Certificate Transparency logs, permanently. Anyone can see that these names exist:
          </p>
          <ul className="list-disc space-y-1 pl-5 font-mono text-xs" style={{ color: 'var(--text-bright)' }}>
            {firstIssue.names.map(n => <li key={n}>{n}</li>)}
          </ul>
          {firstIssue.staging && <Notice tone="info">The CA is set to staging, so this certificate is logged in the staging logs and is not trusted by browsers.</Notice>}
          <div className="flex justify-end gap-2">
            <Btn kind="primary" onClick={confirmIssue}>Issue certificate</Btn>
            <Btn onClick={() => setFirstIssue(null)}>Cancel</Btn>
          </div>
        </ConfirmDialog>
      )}

      {applying && (
        <ConfirmDialog title="Apply housekeeping?" onClose={() => setApplying(null)}>
          <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
            {KIND_LABEL[applying.kind]}: <span className="font-mono">{applying.names.join(', ') || applying.id}</span>
          </p>
          <p className="text-sm" style={{ color: 'var(--text-soft)' }}>{KIND_EFFECT[applying.kind]}</p>
          <div className="flex justify-end gap-2">
            <Btn kind="danger" onClick={confirmApply}>Apply</Btn>
            <Btn onClick={() => setApplying(null)}>Cancel</Btn>
          </div>
        </ConfirmDialog>
      )}
    </div>
  )
}
