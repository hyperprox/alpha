'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  UpdatesInventory, UpdatesJob, UpdatesNode, UpdatesPlan, UpdatesPolicyStatus, UpdatesWsPayload, UpdatesScope,
  UpdatesCheckStatus, UpdatesRebootPreview, UpdatesTargetTree } from '@hyperprox/types'
import { apiJson, atLeast, type ApiResult } from '@/lib/api'
import { wsBase } from '@/lib/ws'
import { useSession } from '@/lib/session'
import { Btn, ConfirmDialog, Empty, Notice, Panel, fmtTime } from '@/components/updates/ui'
import { PolicyStrip } from '@/components/updates/PolicyStrip'
import { NodesTable } from '@/components/updates/NodesTable'
import { appRows } from '@/components/updates/AppsTable'
import { PlanList } from '@/components/updates/PlanList'
import { TargetTree } from '@/components/updates/TargetTree'
import { ItemOrder } from '@/components/updates/ItemList'
import { approvalsFor, helperSelection } from '@/lib/update-targets'
import { JobPanel, type LogLine } from '@/components/updates/JobPanel'
import { History } from '@/components/updates/History'
import { SelfUpdatePanel } from '@/components/updates/SelfUpdatePanel'
import { ClusterHeader, ClusterTag, CheckPanel, RebootPreviewList, useUpdatesCluster } from '@/components/updates/ClusterBits'
import { Page, HudHeader, Tiles, GlowBars, type Tone } from '@/components/visual/kit'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { clusterColor } from '@/lib/clusters'
import { NodeLoginAction } from '@/components/vault/NodeLoginAction'
import { isNoLoginText } from '@/lib/node-login'
import { updatesPageParts } from '@/lib/updates-cluster'

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
  // What this cluster's page offers (lib/updates-cluster.ts): everything, except HyperProx's own update and plug-in
  // app updates on a remote.
  const parts = updatesPageParts(cluster)
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
  const [rollback, setRollback] = useState<string | null>(null)
  // Everything that can be updated, as a tree, and what is ticked. A choice lives on this page only; it travels with
  // the run's start request, and approving one (an app's update, a guest updated without a snapshot) is ticking it.
  const [tree, setTree] = useState<UpdatesTargetTree | null>(null)
  const [treeErr, setTreeErr] = useState<string | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  // The order the ticked rows run in, read again whenever the ticks change; and the confirmation before a run.
  const [order, setOrder] = useState<UpdatesPlan | null>(null)
  const [confirmRun, setConfirmRun] = useState<{ ids: string[]; plan: UpdatesPlan } | null>(null)

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
    const qs = q.toString()
    const r = await apiJson<UpdatesPlan>('/api/updates/plan' + (qs ? `?${qs}` : ''))
    if (r.ok && r.body) { setPlan(r.body); setErr('plan', undefined) } else { setPlan(null); setErr('plan', apiError(r, 'plan')) }
  }, [scope])

  // Compose projects are read only where the policy turns docker on, unless a person asks to look in every guest.
  const [discovering, setDiscovering] = useState(false)
  const discoverCompose = async () => {
    setDiscovering(true)
    const t = await apiJson<UpdatesTargetTree>('/api/updates/targets?discover=1')
    if (t.ok && t.body) { setTree(t.body); setTreeErr(null) } else setTreeErr(apiError(t, 'the compose projects'))
    setDiscovering(false)
  }

  const loadInventory = useCallback(async (fresh: boolean) => {
    const r = await apiJson<UpdatesInventory>('/api/updates/inventory' + (fresh ? '?refresh=1' : ''))
    if (r.ok && r.body) { setInv(r.body); setErr('inv', undefined) } else setErr('inv', apiError(r, 'inventory'))
    // The tree is built from the inventory just read (the API's cache): no second round of reads.
    const t = await apiJson<UpdatesTargetTree>('/api/updates/targets')
    if (t.ok && t.body) { setTree(t.body); setTreeErr(null) } else setTreeErr(apiError(t, 'the update targets'))
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

  useEffect(() => { if (allowed) loadPlan() }, [allowed, loadPlan])

  // A ticked row the tree no longer offers (its update landed, or it can no longer be chosen) is unticked.
  useEffect(() => {
    if (!tree) return
    const ok = new Set(tree.targets.filter(t => t.selectable).map(t => t.id))
    setChosen(c => ([...c].every(id => ok.has(id)) ? c : new Set([...c].filter(id => ok.has(id)))))
  }, [tree])

  // The order the ticked rows would run in, from the inventory as last read. Read-only; shown live under the tree.
  const previewOf = useCallback(async (ids: string[]): Promise<{ plan?: UpdatesPlan; error?: string }> => {
    const approve = tree ? approvalsFor(tree.targets, new Set(ids)) : []
    const r = await apiJson<UpdatesPlan>('/api/updates/preview', 'POST', { select: ids, approve })
    return r.ok && r.body ? { plan: r.body } : { error: apiError(r, 'the order of the run') }
  }, [tree])
  useEffect(() => {
    if (!allowed || !chosen.size) { setOrder(null); return }
    const t = setTimeout(async () => { const r = await previewOf([...chosen]); setOrder(r.plan ?? null); if (r.error) setErr('plan', r.error) }, 300)
    return () => clearTimeout(t)
  }, [allowed, chosen, previewOf])

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

  // "Update this", "Update selected", and the old "Run updates" (now: choose everything, then the same): the order
  // first, in a confirmation, then the run with the master password re-entered.
  const askToRun = async (ids: string[]) => {
    if (!ids.length) { setNotice({ tone: 'info', text: 'Nothing can be updated right now.' }); return }
    setBusy(true); setNotice(null)
    const r = await previewOf(ids)
    setBusy(false)
    if (r.plan) setConfirmRun({ ids, plan: r.plan }); else setNotice({ tone: 'crit', text: r.error ?? 'Could not read the order of the run' })
  }

  const runChosen = async (given?: { ids: string[]; plan: UpdatesPlan }) => {
    const c = given ?? confirmRun
    if (!c) return
    setConfirmRun(null); setBusy(true); setNotice(null)
    const approve = tree ? approvalsFor(tree.targets, new Set(c.ids)) : []
    const r = await apiJson<{ job: UpdatesJob }>('/api/updates/jobs', 'POST', { mode: 'run', select: c.ids, approve })
    setBusy(false)
    if (!r.ok || !r.body?.job) {
      if (askedAgain(r, () => void runChosen(c))) return
      if (!adoptConflict(r)) setNotice({ tone: 'crit', text: apiError(r, 'the run') })
      return
    }
    setChosen(new Set())
    setLogs([]); setActive(r.body.job)
  }

  const runEverything = () => {
    if (!tree) return
    void askToRun(helperSelection(tree.targets, scope === 'guests' ? 'guests' : 'everything'))
  }

  const start = async (mode: 'run' | 'dry-run') => {
    if (mode === 'run') return runEverything()
    setBusy(true); setNotice(null)
    const r = await apiJson<{ job: UpdatesJob }>('/api/updates/jobs', 'POST', { mode, scope })
    setBusy(false)
    if (!r.ok || !r.body?.job) {
      if (askedAgain(r, () => void start(mode))) return
      if (!adoptConflict(r)) setNotice({ tone: 'crit', text: apiError(r, 'job start') })
      return
    }
    const job = r.body.job
    setDetail(d => ({ ...d, [job.id]: job }))
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
  const needsLogin = !!inv && (inv.nodes.some(n => isNoLoginText(n.error)) || inv.guests.some(g => isNoLoginText(g.error)))
  const level: Tone = security ? 'crit' : behind || appsWith.length ? 'warn' : 'good'
  const verdict = !inv ? 'Reading the inventory' : security ? 'Security updates waiting' : behind || appsWith.length ? 'Updates are waiting' : 'Everything is current'

  return (
    <Page remote={remote}>
      <HudHeader level={2} eyebrow={`Manage · ${cluster.name}`} title={<>{verdict} {tag}</>} label="Updates overview"
        ring={{ value: total ? (total - behind) / total : 0, text: inv ? `${behind}` : '…', label: 'machines with updates pending' }}
        chips={[
          { label: 'Nodes with updates', value: inv ? `${nodesWith.length}/${inv.nodes.length}` : '…', tone: nodesWith.length ? 'warn' : 'good' },
          { label: 'Guests with updates', value: inv ? `${guestsWith.length}/${managedGuests}` : '…', tone: guestsWith.length ? 'warn' : 'good' },
          ...(parts.apps ? [{ label: 'Apps with updates', value: inv ? appsWith.length : '…', tone: (appsWith.length ? 'warn' : 'good') as Tone }] : []),
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

      {needsLogin && (
        <Notice tone="warn">
          <div className="flex flex-wrap items-center gap-3">
            <span>Updates cannot read some machines: there is no saved node login.</span>
            <NodeLoginAction small href={parts.nodeLoginHref} />
          </div>
        </Notice>
      )}

      <CheckPanel status={check} error={checkErr} busy={busy} onCheck={checkNow} current={cluster.id} />

      {/* HyperProx's own version and update: not on a remote's page (it updates this install, nothing on a remote). */}
      {parts.selfUpdate && <SelfUpdatePanel />}

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

      <Panel title="Choose what to update" tag={tag} edge={edge} right={
        <span className="flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          Tick any node, package, guest{parts.apps ? ', compose project or app' : ' or compose project'}. A reboot is only ever chosen on its own row.
          {parts.discoverCompose && (
            <Btn small onClick={() => void discoverCompose()} disabled={discovering || jobActive}
                 title={`Runs docker compose ls and reads image digests from the registries, in every running guest of ${cluster.name}`}>
              {discovering ? 'Looking…' : 'Find compose projects in every guest'}
            </Btn>
          )}
        </span>
      }>
        {guestsWith.length > 0 && (
          <div className="mb-3">
            <GlowBars label="Pending packages per guest, most first" warm
              items={[...guestsWith].sort((x, y) => y.pending.length - x.pending.length).slice(0, 8)
                .map(g => ({ label: `${g.vmid} ${g.name}`, value: g.pending.length, text: String(g.pending.length), key: String(g.vmid) }))} />
          </div>
        )}
        {treeErr ? <Notice tone="warn">{treeErr}</Notice>
          : !tree ? <Empty>Reading inventory...</Empty>
          : <TargetTree targets={tree.targets} clusterName={cluster.name} chosen={chosen} onChange={setChosen}
                        onUpdate={ids => void askToRun(ids)} disabled={jobActive || busy || !policy?.loaded} />}
        {policy && !policy.loaded && <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>Updates are disabled until the policy file loads.</p>}
      </Panel>

      {!active && (
        <Panel title={chosen.size ? 'Order of the chosen run' : 'Plan preview'} tag={tag} edge={edge}>
          <div>
            {chosen.size
              ? (order ? <ItemOrder plan={order} /> : <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Working out the order...</p>)
              : errs.plan ? <Notice tone="warn">{errs.plan}</Notice>
              : !plan ? <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Building plan...</p>
              : <><p className="mb-2 text-xs" style={{ color: 'var(--text-muted)' }}>What &quot;Update everything&quot; would run. Tick rows above to run only those.</p><PlanList plan={plan} /></>}
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

      {confirmRun && (
        <ConfirmDialog title={`Run ${confirmRun.plan.items?.length ?? 0} item${confirmRun.plan.items?.length === 1 ? '' : 's'} on ${cluster.name}?`} onClose={() => setConfirmRun(null)}>
          <div>{tag}</div>
          <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
            They run one after another in this order: guests before their node, Ceph before the nodes, one node at a time.
            A failure stops only that item and what waits for it. You are asked for your master password; the plan is then
            read again after <span className="font-mono">apt update</span>, and you confirm it once more before anything changes.
          </p>
          <ItemOrder plan={confirmRun.plan} />
          <div className="flex justify-end gap-2">
            <Btn kind="primary" onClick={() => void runChosen()} disabled={!confirmRun.plan.items?.length}>Start</Btn>
            <Btn onClick={() => setConfirmRun(null)}>Cancel</Btn>
          </div>
        </ConfirmDialog>
      )}

      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const f = reconfirm; setReconfirm(null); f() }} />}
    </Page>
  )
}
