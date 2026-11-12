'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  UpdatesInventory, UpdatesJob, UpdatesNode, UpdatesPlan, UpdatesPolicyStatus, UpdatesWsPayload, UpdatesScope,
  UpdatesCheckStatus, UpdatesRebootPreview } from '@hyperprox/types'
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
import { SelfUpdatePanel } from '@/components/updates/SelfUpdatePanel'
import { ClusterHeader, ClusterTag, CheckPanel, RebootPreviewList, useUpdatesCluster } from '@/components/updates/ClusterBits'
import { Page, HudHeader, Tiles, GlowBars, type Tone } from '@/components/visual/kit'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { clusterColor } from '@/lib/clusters'

const ACTIVE = ['running', 'paused', 'awaiting-confirm']
const LOG_CAP = 500

// The backend may land after this page; a 404 is "not there yet", not a failure to alarm about.
function apiError(r: ApiResult, what: string): string {
  if (r.status === 404) return `The Updates API is not available on this server yet (${what}).`
  if (r.status === 403) return 'Updates is limited to admins.'
  return r.error ?? `Could not load ${what}`
}

// Whether any of a guest's docker images has a newer one waiting.
const imageNewer = (g: UpdatesInventory['guests'][number]) => (g.dockerImages ?? []).some(i => i.latest !== null && i.latest !== i.current)

// One page for every cluster: /updates is home, /clusters/<id>/updates a remote (same component). The cluster is
// named on every card, preview and confirmation, and every API call carries it (lib/api.ts).
export default function UpdatesPage() {
  const { role } = useSession()
  const allowed = atLeast(role, 'admin')
  const cluster = useUpdatesCluster()
  const remote = cluster.kind === 'remote'
  const tag = <ClusterTag c={cluster} />
  const edge = clusterColor(cluster.kind)
  const [check, setCheck] = useState<UpdatesCheckStatus | null>(null)
  const [checkErr, setCheckErr] = useState<string | null>(null)
  // A change on a remote cluster asks for the master password again; the action is retried once it is given.
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const [rebootPv, setRebootPv] = useState<UpdatesRebootPreview | null>(null)
  const [rebootPvErr, setRebootPvErr] = useState<string | null>(null)
  const askedAgain = (r: ApiResult, retry: () => void): boolean => {
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => retry); return true }
    return false
  }

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

  const loadCheck = useCallback(async () => {
    const r = await apiJson<UpdatesCheckStatus>('/api/updates/check')
    if (r.ok && r.body) { setCheck(r.body); setCheckErr(null) } else setCheckErr(apiError(r, 'the daily check'))
  }, [])

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
    loadPolicy(); loadInventory(false); loadPlan(); loadJobs(); loadCheck()
  }, [allowed, loadPolicy, loadInventory, loadPlan, loadJobs, loadCheck])

  // While a check runs, follow it.
  useEffect(() => {
    if (!check?.running) return
    const t = setInterval(loadCheck, 5000)
    return () => clearInterval(t)
  }, [check?.running, loadCheck])

  useEffect(() => { if (allowed) loadPlan() }, [allowed, approvals, loadPlan])

  // An approval names one version of one install; once the inventory no longer offers it, it is dropped.
  useEffect(() => {
    if (!inv) return
    const offered = offeredApprovals(inv.guests)
    for (const g of inv.guests) if (g.noSnapshotAckId) offered.add(g.noSnapshotAckId)
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
      if (askedAgain(r, () => void start(mode))) return
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
    if (!r.ok || !r.body?.job) { if (!askedAgain(r, () => void jobAction(verb))) setNotice({ tone: 'crit', text: apiError(r, verb) }); return }
    const job = r.body.job
    if (ACTIVE.includes(job.status)) setActive(a => (a ? { ...job, steps: job.steps?.length ? job.steps : a.steps } : job))
    else loadJob(job.id)
  }

  const openReboot = async (n: UpdatesNode) => {
    setReboot(n); setRebootPv(null); setRebootPvErr(null)
    if (!remote) return
    const r = await apiJson<UpdatesRebootPreview>(`/api/updates/nodes/${encodeURIComponent(n.node)}/reboot-preview`)
    if (r.ok && r.body) setRebootPv(r.body); else setRebootPvErr(apiError(r, 'what the reboot takes down'))
  }

  const doReboot = async (given?: UpdatesNode) => {
    const n = given ?? reboot
    if (!n) return
    setReboot(null); setBusy(true); setNotice(null)
    const r = await apiJson<{ job: UpdatesJob }>(`/api/updates/nodes/${encodeURIComponent(n.node)}/reboot`, 'POST')
    setBusy(false)
    if (!r.ok || !r.body?.job) {
      if (askedAgain(r, () => void doReboot(n))) return
      if (!adoptConflict(r)) setNotice({ tone: 'crit', text: apiError(r, 'reboot') })
      return
    }
    setLogs([]); setActive(r.body.job)
  }

  const doRollback = async (given?: string) => {
    const target = given ?? rollback
    if (!target || !active) return
    setRollback(null); setBusy(true); setNotice(null)
    const r = await apiJson<{ job: UpdatesJob }>(`/api/updates/jobs/${encodeURIComponent(active.id)}/rollback`, 'POST', { target })
    setBusy(false)
    if (!r.ok || !r.body?.job) {
      if (askedAgain(r, () => void doRollback(target))) return
      setNotice({ tone: 'crit', text: apiError(r, 'rollback') }); return
    }
    setActive(a => (a ? { ...r.body!.job, steps: r.body!.job.steps?.length ? r.body!.job.steps : a.steps } : r.body!.job))
  }

  const checkNow = async () => {
    setNotice(null)
    const r = await apiJson<UpdatesCheckStatus>('/api/updates/check', 'POST')
    if (r.ok && r.body) setCheck(r.body)
    else if (r.status === 409) loadCheck()
    else setNotice({ tone: 'crit', text: apiError(r, 'the check') })
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
      <Page>
        <p className="max-w-xl rounded-md border px-3 py-2 text-sm"
           style={{ background: 'var(--surface-notice)', borderColor: 'var(--border-soft)', color: 'var(--text)' }}>
          Your role can&apos;t view updates. Ask an owner or admin.
        </p>
      </Page>
    )
  }

  const jobActive = !!active
  const canReboot = !!policy?.loaded && !jobActive && !busy
  const rebootWhy = !policy?.loaded ? 'Reboots are disabled until the policy file loads.' : jobActive ? 'A job is already active.' : undefined
  const inactiveJobs = jobs.filter(j => !(active && j.id === active.id))

  // The overview numbers: how many machines have something pending. Read from the inventory, nothing new fetched.
  const nodesWith = inv ? inv.nodes.filter(n => n.pending.length > 0) : []
  const guestsWith = inv ? inv.guests.filter(g => g.managed && (g.pending.length > 0 || imageNewer(g))) : []
  const appsWith = inv ? appRows(inv.guests).filter(r => !!r.a.latest && !!r.a.approvalId) : []
  const managedGuests = inv ? inv.guests.filter(g => g.managed).length : 0
  const total = inv ? inv.nodes.length + managedGuests : 0
  const behind = nodesWith.length + guestsWith.length
  const security = inv ? inv.nodes.filter(n => n.pending.some(p => p.security)).length + inv.guests.filter(g => g.pending.some(p => p.security)).length + appsWith.filter(r => r.a.isSecurity).length : 0
  const level: Tone = security ? 'crit' : behind || appsWith.length ? 'warn' : 'good'
  const verdict = !inv ? 'Reading the inventory' : security ? 'Security updates waiting' : behind || appsWith.length ? 'Updates are waiting' : 'Everything is current'

  return (
    <Page remote={remote}>
      <HudHeader level={2} eyebrow={`Manage · ${cluster.name}`} title={<>{verdict} {tag}</>} label="Updates overview"
        ring={{ value: total ? (total - behind) / total : 0, text: inv ? `${behind}` : '…', label: 'machines with updates pending' }}
        chips={[
          { label: 'Nodes with updates', value: inv ? `${nodesWith.length}/${inv.nodes.length}` : '…', tone: nodesWith.length ? 'warn' : 'good' },
          { label: 'Guests with updates', value: inv ? `${guestsWith.length}/${managedGuests}` : '…', tone: guestsWith.length ? 'warn' : 'good' },
          { label: 'Apps with updates', value: inv ? appsWith.length : '…', tone: appsWith.length ? 'warn' : 'good' },
          { label: 'Machines with security updates', value: inv ? security : '…', tone: level === 'crit' ? 'crit' : 'good' },
        ]}>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Pending packages on every node and guest of {cluster.name}, and the ordered plan to bring them current.
          {remote && ' The preview is apt\'s own simulation; nothing changes until you confirm, with your master password.'}
          {inv && <span className="font-mono"> Inventory read {fmtTime(inv.refreshedAt)}.</span>}
        </p>
      </HudHeader>

      <ClusterHeader c={cluster} />

      <PolicyStrip policy={policy} error={errs.policy ?? null} busy={busy} activeJob={jobActive} refreshing={refreshing}
                   onRefresh={refresh} onRun={start} scope={scope} onScope={setScope} />

      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      <CheckPanel status={check} error={checkErr} busy={busy} onCheck={checkNow} current={cluster.id} />

      {/* HyperProx's own version and update: home only (it updates this install, nothing on a remote). */}
      {!remote && <SelfUpdatePanel />}

      {active && <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>This job runs on {tag}</div>}
      {active && (
        <JobPanel job={active} logs={logs} busy={busy}
                  onConfirm={() => jobAction('confirm')} onCancel={() => jobAction('cancel')} onResume={() => jobAction('resume')}
                  onRollback={setRollback} />
      )}

      <Panel title="Nodes" tag={tag} edge={edge}>
        {inv && inv.nodes.length > 0 && (
          <div className="mb-3">
            <Tiles label="Pending packages per node" items={inv.nodes.map(n => ({
              label: `${n.node}${n.online ? '' : ' (offline)'}${n.rebootRequired ? ' · reboot required' : ''}`,
              value: n.pending.length, tone: !n.online ? 'crit' : n.pending.some(p => p.security) ? 'crit' : n.pending.length ? 'warn' : 'good',
              title: `${n.pending.length} pending package${n.pending.length === 1 ? '' : 's'}`,
            }))} />
          </div>
        )}
        {errs.inv ? <Notice tone="warn">{errs.inv}</Notice>
          : !inv ? <Empty>Reading inventory...</Empty>
          : inv.nodes.length === 0 ? <Empty>No nodes reported.</Empty>
          : <NodesTable nodes={inv.nodes} canReboot={canReboot} rebootWhy={rebootWhy} onReboot={n => void openReboot(n)} />}
      </Panel>

      <Panel title="Guests" tag={tag} edge={edge}>
        {guestsWith.length > 0 && (
          <div className="mb-3">
            <GlowBars label="Pending packages per guest, most first" warm
              items={[...guestsWith].sort((x, y) => y.pending.length - x.pending.length).slice(0, 8)
                .map(g => ({ label: `${g.vmid} ${g.name}`, value: g.pending.length, text: String(g.pending.length), key: String(g.vmid) }))} />
          </div>
        )}
        {errs.inv ? <Notice tone="warn">{errs.inv}</Notice>
          : !inv ? <Empty>Reading inventory...</Empty>
          : inv.guests.length === 0 ? <Empty>No guests reported.</Empty>
          : <GuestsTable guests={inv.guests} acks={approvals} onAck={remote ? approve : undefined} ackDisabled={jobActive || busy} />}
      </Panel>

      {inv && appRows(inv.guests).length > 0 && (
        <Panel title="Apps" tag={tag} edge={edge} right={
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Installed outside apt and docker, found by plug-ins. {approvals.length ? `${approvals.length} approved for the next run.` : 'Manual updates run only when approved.'}
          </span>
        }>
          <AppsTable guests={inv.guests} approvals={approvals} onApprove={approve} disabled={jobActive || busy} />
        </Panel>
      )}

      {!active && (
        <Panel title="Plan preview" tag={tag} edge={edge}>
          <div>
            {errs.plan ? <Notice tone="warn">{errs.plan}</Notice>
              : !plan ? <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Building plan...</p>
              : <PlanList plan={plan} />}
          </div>
        </Panel>
      )}

      <Panel title="History" tag={tag}>
        {errs.jobs ? <Notice tone="warn">{errs.jobs}</Notice>
          : <History jobs={inactiveJobs} detail={detail} expanded={expanded} onToggle={toggleHistory} />}
      </Panel>

      {rollback && active && (
        <ConfirmDialog title={`Roll ${rollback} back on ${cluster.name}?`} onClose={() => setRollback(null)}>
          <div>{tag}</div>
          <ul className="list-disc space-y-1.5 pl-5 text-sm" style={{ color: 'var(--text-soft)' }}>
            <li>The guest is rolled back to the snapshot this run took before touching it, and started again.</li>
            <li>Everything this run did to it is undone: apt packages and images as well as the app.</li>
            <li>Anything written inside the guest since the snapshot is lost.</li>
            <li>The job stays paused; Resume then carries on with the rest of the run.</li>
          </ul>
          <div className="flex justify-end gap-2">
            <Btn kind="danger" onClick={() => void doRollback()}>Roll back {rollback}</Btn>
            <Btn onClick={() => setRollback(null)}>Cancel</Btn>
          </div>
        </ConfirmDialog>
      )}

      {reboot && (
        <ConfirmDialog title={`Reboot ${reboot.node} on ${cluster.name}?`} onClose={() => setReboot(null)}>
          <div>{tag}</div>
          {remote ? (
            rebootPvErr ? <Notice tone="crit">{rebootPvErr}</Notice>
              : !rebootPv ? <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Reading what this reboot takes down…</p>
              : <RebootPreviewList pv={rebootPv} />
          ) : (
          <ul className="list-disc space-y-1.5 pl-5 text-sm" style={{ color: 'var(--text-soft)' }}>
            <li>Ceph <span className="font-mono">noout</span> is set so data does not move while the node is away.</li>
            <li>The node enters HA maintenance and its HA guests move off first.</li>
            <li>The job waits for the node to return, with quorum, all OSDs up and placement groups clean, then clears both.</li>
            <li>Only this node. If it does not return within 15 minutes the job stops and leaves both set for you to clear.</li>
          </ul>
          )}
          {reboot.isSelf && (
            <Notice tone="warn">HyperProx runs on this node. It will be unavailable until the node is back.</Notice>
          )}
          <div className="flex justify-end gap-2">
            <Btn kind="danger" onClick={() => void doReboot()} disabled={remote && (!rebootPv || !rebootPv.standalone)}>Reboot {reboot.node}</Btn>
            <Btn onClick={() => setReboot(null)}>Cancel</Btn>
          </div>
        </ConfirmDialog>
      )}

      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const f = reconfirm; setReconfirm(null); f() }} />}
    </Page>
  )
}
