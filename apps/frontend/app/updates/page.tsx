'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  UpdatesInventory, UpdatesJob, UpdatesNode, UpdatesPlan, UpdatesPolicyStatus, UpdatesWsPayload, UpdatesScope } from '@hyperprox/types'
import { apiJson, atLeast, type ApiResult } from '@/lib/api'
import { wsBase } from '@/lib/ws'
import { useSession } from '@/lib/session'
import { Btn, ConfirmDialog, Empty, Notice, Panel, fmtTime } from '@/components/updates/ui'
import { PolicyStrip } from '@/components/updates/PolicyStrip'
import { NodesTable } from '@/components/updates/NodesTable'
import { GuestsTable } from '@/components/updates/GuestsTable'
import { AppsTable, appRows, offeredApprovals } from '@/components/updates/AppsTable'
import { PlanList } from '@/components/updates/PlanList'
import { JobPanel, type LogLine } from '@/components/updates/JobPanel'
import { History } from '@/components/updates/History'

const ACTIVE = ['running', 'paused', 'awaiting-confirm']
const LOG_CAP = 500

// The backend may land after this page; a 404 is "not there yet", not a failure to alarm about.
function apiError(r: ApiResult, what: string): string {
  if (r.status === 404) return `The Updates API is not available on this server yet (${what}).`
  if (r.status === 403) return 'Updates is limited to admins.'
  return r.error ?? `Could not load ${what}`
}

export default function UpdatesPage() {
  const { role } = useSession()
  const allowed = atLeast(role, 'admin')

  const [policy, setPolicy] = useState<UpdatesPolicyStatus | null>(null)
  const [inv, setInv] = useState<UpdatesInventory | null>(null)
  const [plan, setPlan] = useState<UpdatesPlan | null>(null)
  const [jobs, setJobs] = useState<UpdatesJob[]>([])
  const [detail, setDetail] = useState<Record<string, UpdatesJob>>({})
  const [errs, setErrs] = useState<{ policy?: string; inv?: string; plan?: string; jobs?: string }>({})
  const [active, setActive] = useState<UpdatesJob | null>(null)
  const [logs, setLogs] = useState<LogLine[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'warn' | 'crit' | 'info'; text: string } | null>(null)
  const [reboot, setReboot] = useState<UpdatesNode | null>(null)
  const [scope, setScope] = useState<UpdatesScope>('all')
  // App updates and config changes approved for the next run. Kept on the page only: an approval is
  // for one run, and travels with that run's start request.
  const [approvals, setApprovals] = useState<string[]>([])
  const [rollback, setRollback] = useState<string | null>(null)
  // Read through a ref so a tick of a box re-reads the plan without rebuilding every loader (and the socket).
  const approvalsRef = useRef<string[]>([])
  approvalsRef.current = approvals

  // The socket handlers outlive any one render, so they read the active job through a ref.
  const activeRef = useRef<UpdatesJob | null>(null)
  activeRef.current = active

  const setErr = (k: keyof typeof errs, v: string | undefined) => setErrs(e => ({ ...e, [k]: v }))

  const loadPolicy = useCallback(async () => {
    const r = await apiJson<UpdatesPolicyStatus>('/api/updates/policy')
    if (r.ok && r.body) { setPolicy(r.body); setErr('policy', undefined) } else setErr('policy', apiError(r, 'policy'))
  }, [])

  const loadPlan = useCallback(async () => {
    const q = new URLSearchParams()
    if (scope === 'guests') q.set('scope', 'guests')
    if (approvalsRef.current.length) q.set('approve', approvalsRef.current.join(','))
    const qs = q.toString()
    const r = await apiJson<UpdatesPlan>('/api/updates/plan' + (qs ? `?${qs}` : ''))
    if (r.ok && r.body) { setPlan(r.body); setErr('plan', undefined) } else { setPlan(null); setErr('plan', apiError(r, 'plan')) }
  }, [scope])

  const loadInventory = useCallback(async (fresh: boolean) => {
    const r = await apiJson<UpdatesInventory>('/api/updates/inventory' + (fresh ? '?refresh=1' : ''))
    if (r.ok && r.body) { setInv(r.body); setErr('inv', undefined) } else setErr('inv', apiError(r, 'inventory'))
  }, [])

  // Fetch one job in full. Still active: it becomes the live panel. Finished: the panel clears and the
  // run lands, open, in the history, with the inventory re-read because it has just changed.
  const loadJob = useCallback(async (id: string) => {
    const r = await apiJson<{ job: UpdatesJob }>(`/api/updates/jobs/${encodeURIComponent(id)}`)
    const job = r.body?.job
    if (!r.ok || !job) return
    setDetail(d => ({ ...d, [id]: job }))
    if (ACTIVE.includes(job.status)) {
      if (activeRef.current?.id !== id) setLogs([])
      setActive(job)
      return
    }
    if (activeRef.current?.id === id) {
      setActive(null)
      setExpanded(id)
      loadInventory(false); loadPlan()
    }
    const l = await apiJson<{ jobs: UpdatesJob[] }>('/api/updates/jobs?limit=20')
    if (l.ok && l.body) setJobs(l.body.jobs)
  }, [loadInventory, loadPlan])

  const loadJobs = useCallback(async () => {
    const r = await apiJson<{ jobs: UpdatesJob[] }>('/api/updates/jobs?limit=20')
    if (!r.ok || !r.body) { setErr('jobs', apiError(r, 'history')); return }
    setErr('jobs', undefined)
    setJobs(r.body.jobs)
    const live = r.body.jobs.find(j => ACTIVE.includes(j.status))
    if (live) loadJob(live.id)
    else if (activeRef.current) loadJob(activeRef.current.id)
  }, [loadJob])

  useEffect(() => {
    if (!allowed) return
    loadPolicy(); loadInventory(false); loadPlan(); loadJobs()
  }, [allowed, loadPolicy, loadInventory, loadPlan, loadJobs])

  useEffect(() => { if (allowed) loadPlan() }, [allowed, approvals, loadPlan])

  // An approval names one version of one install; once the inventory no longer offers it, it is dropped.
  useEffect(() => {
    if (!inv) return
    const offered = offeredApprovals(inv.guests)
    setApprovals(a => (a.every(id => offered.has(id)) ? a : a.filter(id => offered.has(id))))
  }, [inv])

  // Live events. After any reconnect the job is re-read, since events sent while the socket was down are gone.
  useEffect(() => {
    if (!allowed) return
    let ws: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    let opened = false

    const onEvent = (p: UpdatesWsPayload) => {
      const cur = activeRef.current
      if (p.kind === 'job') {
        const j = p.job
        if (ACTIVE.includes(j.status)) {
          if (cur?.id === j.id) setActive(a => (a ? { ...a, ...j, steps: a.steps } : a))
          else loadJob(j.id)
        } else if (cur?.id === j.id) loadJob(j.id)
        else loadJobs()
      } else if (p.kind === 'step') {
        if (cur?.id !== p.jobId) return
        setActive(a => {
          if (!a) return a
          const has = a.steps.some(s => s.id === p.step.id)
          const steps = has ? a.steps.map(s => (s.id === p.step.id ? p.step : s)) : [...a.steps, p.step].sort((x, y) => x.seq - y.seq)
          return { ...a, steps }
        })
      } else if (p.kind === 'log') {
        if (cur?.id !== p.jobId) return
        setLogs(l => [...l, { stepId: p.stepId, line: p.line }].slice(-LOG_CAP))
      }
    }

    const connect = () => {
      // Admin-only channel: these frames carry step output and log lines from hosts.
      ws = new WebSocket(`${wsBase()}/updates`)
      ws.onopen = () => { if (opened) loadJobs(); opened = true }
      ws.onmessage = e => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'updates' && msg.payload) onEvent(msg.payload)
        } catch { /* not ours */ }
      }
      ws.onclose = () => { if (!stopped) timer = setTimeout(connect, 3000) }
      ws.onerror = () => { ws?.close() }
    }
    connect()
    return () => { stopped = true; clearTimeout(timer); ws?.close() }
  }, [allowed, loadJob, loadJobs])

  // Belt and braces: if the socket is silently dead, a running job still moves on screen.
  useEffect(() => {
    if (!active) return
    const id = active.id
    const t = setInterval(() => loadJob(id), 10_000)
    return () => clearInterval(t)
  }, [active?.id, loadJob])

  // --- actions --------------------------------------------------------------------------------

  // 409 means a job is already active: show it instead of reporting a failure.
  const adoptConflict = (r: ApiResult): boolean => {
    if (r.status !== 409) return false
    const id = (r.body as { runningJobId?: string } | null)?.runningJobId
    setNotice({ tone: 'info', text: 'A job is already active. Showing it.' })
    if (id) loadJob(id)
    return true
  }

  const refresh = async () => {
    setRefreshing(true); setNotice(null)
    await loadInventory(true)
    await loadPlan()
    setRefreshing(false)
  }

  const start = async (mode: 'run' | 'dry-run') => {
    setBusy(true); setNotice(null)
    const r = await apiJson<{ job: UpdatesJob }>('/api/updates/jobs', 'POST', { mode, scope, approve: approvals })
    setBusy(false)
    if (!r.ok || !r.body?.job) {
      if (!adoptConflict(r)) setNotice({ tone: 'crit', text: apiError(r, 'job start') })
      return
    }
    const job = r.body.job
    setDetail(d => ({ ...d, [job.id]: job }))
    // A real run has taken the approvals with it; a dry run leaves them for the run after.
    if (mode === 'run') setApprovals([])
    if (ACTIVE.includes(job.status)) { setLogs([]); setActive(job) }
    else { setExpanded(job.id); loadJobs() }
  }

  const jobAction = async (verb: 'confirm' | 'resume' | 'cancel') => {
    if (!active) return
    setBusy(true); setNotice(null)
    const r = await apiJson<{ job: UpdatesJob }>(`/api/updates/jobs/${encodeURIComponent(active.id)}/${verb}`, 'POST')
    setBusy(false)
    if (!r.ok || !r.body?.job) { setNotice({ tone: 'crit', text: apiError(r, verb) }); return }
    const job = r.body.job
    if (ACTIVE.includes(job.status)) setActive(a => (a ? { ...job, steps: job.steps?.length ? job.steps : a.steps } : job))
    else loadJob(job.id)
  }

  const doReboot = async () => {
    const n = reboot
    if (!n) return
    setReboot(null); setBusy(true); setNotice(null)
    const r = await apiJson<{ job: UpdatesJob }>(`/api/updates/nodes/${encodeURIComponent(n.node)}/reboot`, 'POST')
    setBusy(false)
    if (!r.ok || !r.body?.job) {
      if (!adoptConflict(r)) setNotice({ tone: 'crit', text: apiError(r, 'reboot') })
      return
    }
    setLogs([]); setActive(r.body.job)
  }

  const doRollback = async () => {
    const target = rollback
    if (!target || !active) return
    setRollback(null); setBusy(true); setNotice(null)
    const r = await apiJson<{ job: UpdatesJob }>(`/api/updates/jobs/${encodeURIComponent(active.id)}/rollback`, 'POST', { target })
    setBusy(false)
    if (!r.ok || !r.body?.job) { setNotice({ tone: 'crit', text: apiError(r, 'rollback') }); return }
    setActive(a => (a ? { ...r.body!.job, steps: r.body!.job.steps?.length ? r.body!.job.steps : a.steps } : r.body!.job))
  }

  const approve = (id: string, on: boolean) => setApprovals(a => (on ? (a.includes(id) ? a : [...a, id]) : a.filter(x => x !== id)))

  const toggleHistory = (id: string) => {
    const next = expanded === id ? null : id
    setExpanded(next)
    if (next) loadJob(next)
  }

  // --- render ---------------------------------------------------------------------------------

  if (role && !allowed) {
    return (
      <div className="min-h-full p-4 sm:p-8" style={{ background: 'var(--ground)' }}>
        <h1 className="font-display font-bold" style={{ fontSize: 36, lineHeight: 1.1, color: 'var(--text-bright)' }}>Updates</h1>
        <p className="mt-4 max-w-xl rounded-md border px-3 py-2 text-sm"
           style={{ background: 'var(--surface-notice)', borderColor: 'var(--border-soft)', color: 'var(--text)' }}>
          Your role can&apos;t view updates. Ask an owner or admin.
        </p>
      </div>
    )
  }

  const jobActive = !!active
  const canReboot = !!policy?.loaded && !jobActive && !busy
  const rebootWhy = !policy?.loaded ? 'Reboots are disabled until the policy file loads.' : jobActive ? 'A job is already active.' : undefined
  const inactiveJobs = jobs.filter(j => !(active && j.id === active.id))

  return (
    <div className="min-h-full space-y-5 p-4 sm:p-8" style={{ background: 'var(--ground)' }}>
      <div>
        <p className="font-mono" style={{ fontSize: 11, letterSpacing: '0.14em', color: 'var(--text-dimmer)' }}>MANAGE</p>
        <h1 className="mt-2 font-display font-bold" style={{ fontSize: 36, lineHeight: 1.1, color: 'var(--text-bright)' }}>Updates</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
          Pending packages on every node and guest, and the ordered plan to bring them current.
          {inv && <span className="font-mono"> Inventory read {fmtTime(inv.refreshedAt)}.</span>}
        </p>
      </div>

      <PolicyStrip policy={policy} error={errs.policy ?? null} busy={busy} activeJob={jobActive} refreshing={refreshing}
                   onRefresh={refresh} onRun={start} scope={scope} onScope={setScope} />

      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      {active && (
        <JobPanel job={active} logs={logs} busy={busy}
                  onConfirm={() => jobAction('confirm')} onCancel={() => jobAction('cancel')} onResume={() => jobAction('resume')}
                  onRollback={setRollback} />
      )}

      <Panel title="Nodes">
        {errs.inv ? <div className="p-5"><Notice tone="warn">{errs.inv}</Notice></div>
          : !inv ? <Empty>Reading inventory...</Empty>
          : inv.nodes.length === 0 ? <Empty>No nodes reported.</Empty>
          : <NodesTable nodes={inv.nodes} canReboot={canReboot} rebootWhy={rebootWhy} onReboot={setReboot} />}
      </Panel>

      <Panel title="Guests">
        {errs.inv ? <div className="p-5"><Notice tone="warn">{errs.inv}</Notice></div>
          : !inv ? <Empty>Reading inventory...</Empty>
          : inv.guests.length === 0 ? <Empty>No guests reported.</Empty>
          : <GuestsTable guests={inv.guests} />}
      </Panel>

      {inv && appRows(inv.guests).length > 0 && (
        <Panel title="Apps" right={
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Installed outside apt and docker, found by plug-ins. {approvals.length ? `${approvals.length} approved for the next run.` : 'Manual updates run only when approved.'}
          </span>
        }>
          <AppsTable guests={inv.guests} approvals={approvals} onApprove={approve} disabled={jobActive || busy} />
        </Panel>
      )}

      {!active && (
        <Panel title="Plan preview">
          <div className="p-5">
            {errs.plan ? <Notice tone="warn">{errs.plan}</Notice>
              : !plan ? <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Building plan...</p>
              : <PlanList plan={plan} />}
          </div>
        </Panel>
      )}

      <Panel title="History">
        {errs.jobs ? <div className="p-5"><Notice tone="warn">{errs.jobs}</Notice></div>
          : <History jobs={inactiveJobs} detail={detail} expanded={expanded} onToggle={toggleHistory} />}
      </Panel>

      {rollback && active && (
        <ConfirmDialog title={`Roll ${rollback} back?`} onClose={() => setRollback(null)}>
          <ul className="list-disc space-y-1.5 pl-5 text-sm" style={{ color: 'var(--text-soft)' }}>
            <li>The guest is rolled back to the snapshot this run took before touching it, and started again.</li>
            <li>Everything this run did to it is undone: apt packages and images as well as the app.</li>
            <li>Anything written inside the guest since the snapshot is lost.</li>
            <li>The job stays paused; Resume then carries on with the rest of the run.</li>
          </ul>
          <div className="flex justify-end gap-2">
            <Btn kind="danger" onClick={doRollback}>Roll back {rollback}</Btn>
            <Btn onClick={() => setRollback(null)}>Cancel</Btn>
          </div>
        </ConfirmDialog>
      )}

      {reboot && (
        <ConfirmDialog title={`Reboot ${reboot.node}?`} onClose={() => setReboot(null)}>
          <ul className="list-disc space-y-1.5 pl-5 text-sm" style={{ color: 'var(--text-soft)' }}>
            <li>Ceph <span className="font-mono">noout</span> is set so data does not move while the node is away.</li>
            <li>The node enters HA maintenance and its HA guests move off first.</li>
            <li>The job waits for the node to return, with quorum, all OSDs up and placement groups clean, then clears both.</li>
            <li>Only this node. If it does not return within 15 minutes the job stops and leaves both set for you to clear.</li>
          </ul>
          {reboot.isSelf && (
            <Notice tone="warn">HyperProx runs on this node. It will be unavailable until the node is back.</Notice>
          )}
          <div className="flex justify-end gap-2">
            <Btn kind="danger" onClick={doReboot}>Reboot {reboot.node}</Btn>
            <Btn onClick={() => setReboot(null)}>Cancel</Btn>
          </div>
        </ConfirmDialog>
      )}
    </div>
  )
}
