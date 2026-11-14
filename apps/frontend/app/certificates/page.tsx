'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CertsEvent, CertsHousekeepingItem, CertsManaged, CertsOverview, CertsProbe } from '@hyperprox/types'
import { apiJson, atLeast, type ApiResult } from '@/lib/api'
import { useSession } from '@/lib/session'
import { Btn, ConfirmDialog, Notice, fmtDateTime, fmtDays } from '@/components/certificates/ui'
import { Details, GlowBars, HudHeader, Page, Panel, StatusDots, styles, type DotState, type StatChip } from '@/components/visual/kit'
import { PolicyStrip } from '@/components/certificates/PolicyStrip'
import { Inventory } from '@/components/certificates/Inventory'
import { ManagedList, neverIssued } from '@/components/certificates/Managed'
import { Probes } from '@/components/certificates/Probes'
import { HousekeepingList, KIND_EFFECT, KIND_LABEL } from '@/components/certificates/Housekeeping'
import { EventsList } from '@/components/certificates/Events'
import { certsHeadline, endpointsEmpty } from '@/lib/certs-summary'

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
  const [hkNote, setHkNote] = useState<string | null>(null)
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
    const r = await apiJson<{ items: CertsHousekeepingItem[]; configured?: boolean; reason?: string }>('/api/certs/housekeeping')
    if (r.ok && r.body) { setHk(r.body.items); setHkErr(null); setHkNote(r.body.configured === false ? (r.body.reason ?? 'No proxy is connected, so there is nothing to tidy.') : null) }
    else { setHk(null); setHkNote(null); setHkErr(apiError(r, 'housekeeping')) }
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
      <Page>
        <Panel title="Certificates">
          <p className={styles.empty} style={{ margin: 0, color: 'var(--text)' }}>Your role can&apos;t view certificates. Ask an owner or admin.</p>
        </Panel>
      </Page>
    )
  }

  const labels = ov?.managed.map(m => m.label) ?? []

  // The HUD counts: what HyperProx issues itself, what is close to expiry, and what is failing right now.
  const inventory = ov?.inventory ?? []
  const expiring = inventory.filter(e => e.daysLeft !== null && e.daysLeft <= 14).length
  const failing = inventory.filter(e => e.verdict === 'critical' || e.verdict === 'error').length
    + (ov?.managed.filter(m => m.status === 'failed').length ?? 0)
  const chips: StatChip[] = ov ? [
    { label: 'managed', value: ov.managed.length },
    { label: 'expiring in 14 days', value: expiring, tone: expiring ? 'warn' : undefined },
    { label: 'failing', value: failing, tone: failing ? 'crit' : 'good' },
    { label: 'certificates seen', value: inventory.length },
  ] : []
  const title = certsHeadline(ov, ovErr)

  // Expiry as glow bars: a bar fills as a certificate uses up its lifetime, so a full bar is the one nearest
  // to expiry. The text always says the days left, and a week or less counts as full whatever the lifetime.
  const expiry = [...inventory]
    .filter(e => e.daysLeft !== null)
    .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0))
    .slice(0, 12)
    .map(e => {
      const used = e.lifetimeDays ? 100 - Math.max(0, Math.min(1, (e.daysLeft ?? 0) / e.lifetimeDays)) * 100 : 50
      return {
        key: e.id,
        label: e.names[0] ?? '(no names)',
        value: (e.daysLeft ?? 0) <= 7 ? 100 : used,
        text: (e.daysLeft ?? 0) < 0 ? fmtDays(e.daysLeft) : `${fmtDays(e.daysLeft)} left`,
        title: e.names.join(', '),
      }
    })

  const probeDots = (ov?.probes ?? []).map(p => ({
    label: `${p.host}:${p.port}`,
    state: (p.verdict === 'ok' ? 'ok' : p.verdict === 'warn' ? 'warn' : p.verdict === 'unknown' ? 'off' : 'bad') as DotState,
  }))

  const feed = events.slice(0, 8).map(e => ({
    key: String(e.id),
    title: e.label ?? e.kind,
    detail: e.ok ? e.kind : e.detail,
    meta: fmtDateTime(e.at),
    tone: (e.ok ? 'ok' : 'bad') as 'ok' | 'bad',
  }))

  return (
    <Page>
      <HudHeader
        eyebrow="Manage"
        title={title}
        icon="lock"
        level={2}
        chips={chips}
        label="Certificate overview"
      >
        <PolicyStrip policy={ov?.policy ?? null} error={ovErr} checkedAt={ov?.checkedAt ?? null} refreshing={refreshing} onCheck={checkNow} />
      </HudHeader>

      <p className={styles.empty}>
        Every certificate this network serves, what is actually served at each endpoint, and the ones HyperProx issues and renews itself.
      </p>

      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      <Panel title="Expiry" sub="days left, nearest first">
        {!ov ? <p className={styles.empty}>{ovErr ? 'Expiry unavailable.' : 'Reading certificates...'}</p>
          : expiry.length === 0 ? <p className={styles.empty}>No expiry dates known yet.</p>
          : <GlowBars items={expiry} max={100} hiAt={90} label="Share of each certificate lifetime already used" />}
      </Panel>

      <Panel title="Managed by HyperProx">
        {!ov ? <p className={styles.empty}>{ovErr ? 'Unavailable.' : 'Reading...'}</p>
          : <ManagedList items={ov.managed} busy={busy} onIssue={onIssue} onDeploy={m => managedAction(m, 'deploy')} />}
      </Panel>

      <Panel title="Endpoints" sub="what each one serves right now">
        {!ov ? <p className={styles.empty}>{ovErr ? 'Unavailable.' : 'Reading...'}</p>
          : probeDots.length === 0 ? <p className={styles.empty}>{endpointsEmpty(ov)}</p>
          : <StatusDots items={probeDots} label="Endpoint certificate checks" />}
      </Panel>

      <Panel title="Housekeeping">
        {hkErr ? <Notice tone="warn">{hkErr}</Notice>
          : hkNote ? <p className={styles.empty}>{hkNote}</p>
          : !hk ? <p className={styles.empty}>Reading...</p>
          : <HousekeepingList items={hk} busy={busy} onApply={setApplying} />}
      </Panel>

      <Panel title="Events">
        <EventsList events={events} labels={labels} label={evLabel} onLabel={setEvLabel} error={evErr} feed={feed} />
      </Panel>

      <Details summary="Inventory" sub="every certificate, with filters">
        {!ov ? <p className={styles.empty}>{ovErr ? 'Inventory unavailable.' : 'Reading certificates...'}</p>
          : <Inventory entries={ov.inventory} />}
      </Details>

      <Details summary="Endpoint table" sub="issuer, expiry, trust, and a check button per endpoint">
        {!ov ? <p className={styles.empty}>{ovErr ? 'Unavailable.' : 'Reading...'}</p>
          : <Probes probes={ov.probes} checking={checking} onCheck={checkOne} />}
      </Details>

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
    </Page>
  )
}
