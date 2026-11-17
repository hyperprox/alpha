'use client'

// =============================================================================
//  /balance — Load balancing
//
//  Leads with the balance of the cluster: every node's CPU and RAM over the
//  history window as a share of its own capacity, a balance score (100 less
//  the gap between the busiest and the least busy node), and a headline.
//  Then the plan that would even it out: the fewest moves for the most gain,
//  each shown travelling between nodes with both nodes' bars before and after,
//  its outage, the data to copy and the network cost. "Balance the cluster"
//  runs it in a quiet window or schedules it for the next one, with your
//  confirmation once; the server runs the moves one at a time and stops on
//  any change. Automatic balancing is off by default. Why each guest is where
//  it is, and single moves, are below.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { Page, HudHeader, Panel, Details } from '@/components/visual/kit'
import { Btn, Note } from '@/components/ha/ui'
import { PlacementMapView, TargetList, WhyHere, SuggestionCard, MoveRow } from '@/components/placement/parts'
import { LoadColumns, PlanView, PlanProgress } from '@/components/placement/balance-parts'
import { MoveDialog } from '@/components/placement/MoveDialog'
import { PlanDialog } from '@/components/placement/PlanDialog'
import { AutoPanel } from '@/components/placement/AutoPanel'
import { quietWords, when } from '@/components/placement/logic'
import { GOAL_WORD, afterOf, orderNodes, planChoices, scoreTone, autoWords } from '@/components/placement/balance-logic'
import type { Advice, BalanceGoal, BalanceView, MapView, MoveRecord, PlanRecord } from '@/components/placement/types'

const GOALS: BalanceGoal[] = ['mem', 'cpu', 'both']

export default function BalancePage() {
  const { role } = useSession()
  const admin = atLeast(role, 'admin')
  const [goal, setGoal] = useState<BalanceGoal | null>(null)
  const [view, setView] = useState<BalanceView | null>(null)
  const [map, setMap] = useState<MapView | null>(null)
  const [advice, setAdvice] = useState<Advice | null>(null)
  const [moves, setMoves] = useState<MoveRecord[]>([])
  const [error, setError] = useState('')
  const [pick, setPick] = useState<string | null>(null)
  const [moving, setMoving] = useState<{ sid: string; name: string; to: string } | null>(null)
  const [planning, setPlanning] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const loadBalance = useCallback(async (g: BalanceGoal | null) => {
    const r = await apiJson<{ data: BalanceView }>(`/api/placement/balance${g ? `?goal=${g}` : ''}`)
    if (r.ok && r.body) { setView(r.body.data); setError('') }
    else setError(r.status === 404 ? 'Load balancing is not on this server yet.' : r.error ?? 'Could not read the cluster.')
  }, [])
  const loadRest = useCallback(async () => {
    const [m, h] = await Promise.all([apiJson<{ data: MapView }>('/api/placement/map'), apiJson<{ data: MoveRecord[] }>('/api/placement/moves')])
    if (m.ok && m.body) setMap(m.body.data)
    if (h.ok && h.body) setMoves(h.body.data)
  }, [])
  const loadAdvice = useCallback(async () => {
    const a = await apiJson<{ data: Advice }>('/api/placement/advice')
    if (a.ok && a.body) setAdvice(a.body.data)
  }, [])
  useEffect(() => { void loadBalance(goal) }, [goal, loadBalance])
  useEffect(() => { void loadRest(); void loadAdvice() }, [loadRest, loadAdvice])

  // While a plan runs, follow it; reload everything when it ends.
  const runningId = view?.running?.id ?? null
  useEffect(() => {
    if (!runningId) return
    let stop = false
    void (async () => {
      for (let i = 0; i < 7200 && !stop && alive.current; i++) {
        await new Promise(res => setTimeout(res, 3000))
        const r = await apiJson<{ data: PlanRecord }>(`/api/placement/plans/${encodeURIComponent(runningId)}`)
        if (!r.ok || !r.body || stop) continue
        const p = r.body.data
        setView(v => (v ? { ...v, running: p.status === 'running' ? p : null, plans: v.plans.map(x => (x.id === p.id ? p : x)) } : v))
        if (p.status !== 'running') { void loadBalance(goal); void loadRest(); return }
      }
    })()
    return () => { stop = true }
  }, [runningId, goal, loadBalance, loadRest])

  const guests = map?.map.guests ?? []
  const g = guests.find(x => x.sid === pick) ?? null
  const needsCheck = g && g.targets.some(t => t.reasons.some(r => r.level === 'unknown' && (r.code === 'shared-mount' || r.code === 'gpu')))
  const lastMove = g ? moves.find(m => m.sid === g.sid && (m.status === 'done' || m.status === 'failed')) : null
  const shownGoal = goal ?? view?.goal ?? 'both'
  const tone = view ? scoreTone(view.score.spread, view.settings.unevenAbove) : 'good'
  const choices = view ? planChoices(view) : []
  const lines = view ? { cpu: view.settings.cpuAbove, mem: view.settings.memAbove } : undefined

  const checkPaths = async () => {
    if (!g) return
    setBusy(true); setNote('')
    const r = await apiJson(`/api/placement/guests/${g.type}/${g.vmid}/paths`, 'POST', {})
    setBusy(false)
    setNote(r.ok ? 'Checked on every node HyperProx can log in to. Nodes without a login stay "not checked".' : r.error ?? 'Could not check.')
    void loadRest()
  }
  const corosync = async (id: string) => { setBusy(true); const r = await apiJson(`/api/placement/moves/${encodeURIComponent(id)}/corosync`, 'POST', {}); setBusy(false); if (!r.ok) setNote(r.error ?? 'Could not read corosync.'); void loadRest() }
  const resolve = async (id: string) => { setBusy(true); const r = await apiJson(`/api/placement/moves/${encodeURIComponent(id)}/resolve`, 'POST', {}); setBusy(false); setNote(r.ok ? 'Resolved: read back from Proxmox.' : r.error ?? 'Not resolved.'); void loadRest() }
  const cancel = async (id: string) => { const r = await apiJson(`/api/placement/moves/${encodeURIComponent(id)}/cancel`, 'POST', {}); if (!r.ok) setNote(r.error ?? 'Not cancelled.'); void loadRest() }
  const stopPlan = async (id: string) => {
    setBusy(true)
    const r = await apiJson(`/api/placement/plans/${encodeURIComponent(id)}/stop`, 'POST', {})
    setBusy(false)
    setNote(r.ok ? 'Stopping: a scheduled plan is cancelled; a running one stops after the move under way (a migration is never cut off).' : r.error ?? 'Not stopped.')
    void loadBalance(goal)
  }

  return (
    <Page>
      <HudHeader level={2} eyebrow="Cluster · load balancing" label="Load balancing overview"
        title={!view ? 'Reading the cluster' : view.headline}
        ring={view ? { value: Math.max(0, Math.min(1, view.score.score / 100)), text: String(Math.round(view.score.score)), label: 'balance score' } : { value: 0, text: '…', label: 'balance score' }}
        chips={view ? [
          { label: 'Balance by', value: GOAL_WORD[shownGoal], tone: 'dim' },
          { label: 'Spread', value: `${Math.round(view.score.spread * 100)} pts`, tone: tone === 'good' ? 'good' : tone === 'warn' ? 'warn' : 'crit' },
          { label: 'After the plan', value: view.plan.steps.length ? String(Math.round(view.plan.target.score)) : '—', tone: view.plan.steps.length ? 'good' : 'dim' },
          { label: 'Quiet now', value: view.quiet.quietNow ? 'yes' : 'no', tone: view.quiet.quietNow ? 'good' : 'warn' },
          { label: 'Automatic', value: !view.auto.settings.enabled ? 'off' : view.auto.settings.apply ? 'applying' : 'notify', tone: view.auto.settings.apply ? 'warn' : 'dim' },
        ] : undefined}>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Balance by">
          <span className="text-sm" style={{ color: 'var(--text-soft)' }}>Balance by</span>
          {GOALS.map(x => (
            <button key={x} type="button" aria-pressed={shownGoal === x} onClick={() => setGoal(x)} className="rounded px-2.5 py-1 text-xs"
              style={{ border: '1px solid var(--border-strong)', fontFamily: 'var(--font-mono)', background: shownGoal === x ? 'var(--hx-accent)' : 'transparent', color: shownGoal === x ? 'var(--accent-ink)' : 'var(--text-soft)' }}>
              {GOAL_WORD[x]}
            </button>
          ))}
        </div>
      </HudHeader>

      {error && <Note tone="warn">{error}</Note>}
      {note && <Note tone="info">{note}</Note>}
      {view && view.unread.length > 0 && <Note tone="warn">Not read: {view.unread.join('; ')}. Anything that depends on it is left out, never guessed.</Note>}

      {view && (
        <Panel title="Load per node" sub={`last ${view.window.hours} h, backup windows left out`}>
          <LoadColumns nodes={orderNodes(view.nodes, shownGoal)} after={afterOf(view.plan)} lines={lines} busiest={view.uneven ? view.score.busiest : null} />
        </Panel>
      )}

      {view && (
        <Panel title="Balancing plan" sub={view.plan.steps.length ? `${view.plan.steps.length} move${view.plan.steps.length === 1 ? '' : 's'} · score ${Math.round(view.plan.score.score)} → ${Math.round(view.plan.target.score)}` : view.uneven ? 'nothing can usefully move' : 'nothing to do'}>
          <div className="space-y-3">
            {view.running && <PlanProgress p={view.running} tz={view.quiet.tz} action={admin && !view.running.stopRequested ? <Btn small kind="danger" disabled={busy} onClick={() => stopPlan(view.running!.id)}>Stop</Btn> : null} />}
            {!view.uneven && !view.running && <Note tone="good">{view.headline} No plan is needed.</Note>}
            {(view.uneven || view.plan.steps.length > 0) && (
              <PlanView plan={view.plan}
                suggestionAction={() => <Link href="/ha" className="underline" style={{ color: 'var(--accent)' }}>HA page</Link>}
                actions={admin && view.plan.steps.length > 0 && !view.running ? (
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {!choices.length && <span className="text-xs" style={{ color: 'var(--text-dim)' }}>No quiet window is known in the next week.</span>}
                    <Btn kind="primary" disabled={!choices.length} onClick={() => setPlanning(true)}>Balance the cluster…</Btn>
                  </div>
                ) : null} />
            )}
          </div>
        </Panel>
      )}

      {view && (
        <Panel title="Automatic balancing" sub={!view.auto.settings.enabled ? 'off' : view.auto.settings.apply ? 'on, applying' : 'on, notify only'}>
          <AutoPanel auto={view.auto} admin={admin} onSaved={() => void loadBalance(goal)} />
        </Panel>
      )}

      {view && view.plans.filter(p => p.id !== view.running?.id).length > 0 && (
        <Panel title="Recent plans" sub="manual and automatic">
          <div className="space-y-2">
            {view.plans.filter(p => p.id !== view.running?.id).slice(0, 6).map(p => (
              <PlanProgress key={p.id} p={p} tz={view.quiet.tz} action={admin && p.status === 'scheduled' ? <Btn small onClick={() => stopPlan(p.id)}>Cancel</Btn> : null} />
            ))}
          </div>
        </Panel>
      )}

      <Panel title="Why each guest is where it is" sub="and where it could go: tap a guest">
        {!map ? <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Reading the guests…</p> : (
          <div className="space-y-3">
            <PlacementMapView nodes={map.map.nodes} guests={guests} selected={pick} onPick={sid => setPick(p => (p === sid ? null : sid))} />
            {g && (
              <div className="space-y-3 rounded-xl border p-3" style={{ borderColor: 'var(--hx-line)' }}>
                <div className="flex items-baseline justify-between gap-2">
                  <b style={{ fontFamily: 'var(--font-display)', fontSize: 20, color: 'var(--text-bright)' }}>{g.name || g.sid} <span style={{ fontSize: 14, color: 'var(--text-dim)' }}>on {g.node}</span></b>
                  <Btn small onClick={() => setPick(null)}>Close</Btn>
                </div>
                <WhyHere g={g} />
                {lastMove && <p className="text-sm" style={{ color: 'var(--text-soft)' }}>Last time this moved: {lastMove.fromNode} → {lastMove.toNode || '?'}, {lastMove.status === 'done' ? 'it went fine' : 'it failed'}. {lastMove.corosync ? '' : 'Corosync around it was not checked.'}</p>}
                {needsCheck && admin && <Btn small disabled={busy} onClick={checkPaths}>Check paths and devices on the nodes</Btn>}
                <TargetList g={g} action={node => {
                  const t = g.targets.find(x => x.node === node)!
                  return admin && t.verdict === 'ok' ? <Btn small kind="primary" onClick={() => setMoving({ sid: g.sid, name: g.name, to: node })}>Move here…</Btn> : null
                }} />
                {g.everywhere.filter(r => r.level !== 'block').length > 0 && (
                  <ul className="list-disc pl-5 text-[13px]" style={{ color: 'var(--text-dim)' }}>{g.everywhere.filter(r => r.level !== 'block').map((r, i) => <li key={i}>{r.words}</li>)}</ul>
                )}
              </div>
            )}
            {advice && (
              <Details summary="Sustained pressure" sub={advice.balanced ? 'no node busy for hours' : advice.headline}>
                <div className="space-y-2">
                  {advice.suggestions.map(s => (
                    <SuggestionCard key={`${s.sid}-${s.to}`} s={s} action={s.kind === 'move'
                      ? (admin ? <Btn small kind="primary" onClick={() => setMoving({ sid: s.sid, name: s.name, to: s.to })}>Check this move…</Btn> : null)
                      : <Link href="/ha" className="text-sm underline" style={{ color: 'var(--accent)' }}>Change the rule on the HA page</Link>} />
                  ))}
                  {advice.stuck.map((x, i) => <Note key={i} tone="info">{x}</Note>)}
                  <ul className="list-disc space-y-1 pl-5 text-sm" style={{ color: 'var(--text-soft)' }}>{advice.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>
                </div>
              </Details>
            )}
          </div>
        )}
      </Panel>

      {view && (
        <Panel title="Quiet windows" sub={`cluster time: ${view.quiet.tz}`} href="/settings/balance" linkLabel="Settings">
          <div className="space-y-2">
            <Note tone={view.quiet.quietNow ? 'good' : 'warn'}>{quietWords(view.quiet)}</Note>
            {view.quiet.upcoming.length > 0 && (
              <ul className="space-y-0.5 text-sm" style={{ color: 'var(--text-soft)' }}>
                {view.quiet.upcoming.slice(0, 6).map((u, i) => <li key={i}>{when(u.start, view.quiet.tz)} – {when(u.end, view.quiet.tz)}: {u.reason}</li>)}
              </ul>
            )}
          </div>
        </Panel>
      )}

      {view && (
        <Panel title="Network cost" sub={view.network.shared ? 'moves share the heartbeat link' : view.network.shared === false ? 'separate migration network' : 'unknown'}>
          <ul className="list-disc space-y-1 pl-5 text-sm" style={{ color: 'var(--text-soft)' }}>{view.network.words.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </Panel>
      )}

      <Panel title="Moves" sub="HyperProx's, and migrations seen in Proxmox">
        {!moves.length ? <p className="text-sm" style={{ color: 'var(--text-dim)' }}>No moves recorded yet.</p> : (
          <ul className="space-y-2">
            {moves.slice(0, 40).map(m => (
              <MoveRow key={m.id} m={m} action={admin ? (
                m.status === 'scheduled' ? <Btn small onClick={() => cancel(m.id)}>Cancel</Btn>
                  : m.status === 'stuck' ? <Btn small disabled={busy} onClick={() => resolve(m.id)} title="Once Proxmox shows it finished: read it back and settle it">Resolve</Btn>
                  : (m.status === 'done' || m.status === 'failed') && !m.corosync?.checked?.length ? <Btn small disabled={busy} onClick={() => corosync(m.id)}>Check corosync</Btn> : null
              ) : null} />
            ))}
          </ul>
        )}
      </Panel>

      {view && !admin && <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{autoWords(view.auto)} Running a plan or a move needs the admin role.</p>}
      {moving && <MoveDialog sid={moving.sid} name={moving.name} to={moving.to} onClose={() => setMoving(null)} onDone={() => { void loadBalance(goal); void loadRest(); void loadAdvice() }} />}
      {planning && view && <PlanDialog view={view} onClose={() => setPlanning(false)} onStarted={p => { setPlanning(false); setNote(p.status === 'scheduled' ? `Scheduled for ${p.scheduledFor ? when(p.scheduledFor, view.quiet.tz) : 'the next quiet window'}. It is checked again before it runs.` : 'The plan is running: one move at a time.'); void loadBalance(goal) }} />}
    </Page>
  )
}
