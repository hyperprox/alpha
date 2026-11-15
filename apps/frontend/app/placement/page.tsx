'use client'

// =============================================================================
//  /placement — the placement advisor
//
//  Every guest on its node (HA or not), why it is there, and where it could go.
//  Imbalance over hours, not a snapshot, with suggestions worked out from each
//  guest's own usage. A move happens only when you ask for one: checked by the
//  server, shown with its downtime, data and network cost, in a quiet window
//  (or "move anyway"), with your master password. Proxmox's own HA scheduler
//  keeps balancing HA guests; this page never competes with it.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { Page, HudHeader, Panel, Details } from '@/components/visual/kit'
import { Btn, Note } from '@/components/ha/ui'
import { PlacementMapView, TargetList, WhyHere, SuggestionCard, MoveRow } from '@/components/placement/parts'
import { MoveDialog } from '@/components/placement/MoveDialog'
import { quietWords, when } from '@/components/placement/logic'
import type { Advice, MapView, MoveRecord } from '@/components/placement/types'

export default function PlacementPage() {
  const { role } = useSession()
  const admin = atLeast(role, 'admin')
  const [view, setView] = useState<MapView | null>(null)
  const [advice, setAdvice] = useState<Advice | null>(null)
  const [moves, setMoves] = useState<MoveRecord[]>([])
  const [error, setError] = useState('')
  const [pick, setPick] = useState<string | null>(null)
  const [moving, setMoving] = useState<{ sid: string; name: string; to: string } | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [m, h] = await Promise.all([apiJson<{ data: MapView }>('/api/placement/map'), apiJson<{ data: MoveRecord[] }>('/api/placement/moves')])
    if (m.ok && m.body) { setView(m.body.data); setError('') } else setError(m.status === 404 ? 'The placement advisor is not on this server yet.' : m.error ?? 'Could not read the cluster.')
    if (h.ok && h.body) setMoves(h.body.data)
  }, [])
  const loadAdvice = useCallback(async () => {
    const a = await apiJson<{ data: Advice }>('/api/placement/advice')
    if (a.ok && a.body) setAdvice(a.body.data)
  }, [])
  useEffect(() => { void load(); void loadAdvice() }, [load, loadAdvice])

  const guests = view?.map.guests ?? []
  const g = guests.find(x => x.sid === pick) ?? null
  const counts = { free: guests.filter(x => x.movable === 'yes' && !x.template).length, fixed: guests.filter(x => x.movable === 'no' && !x.template).length, unknown: guests.filter(x => x.movable === 'unknown').length }
  const needsCheck = g && g.targets.some(t => t.reasons.some(r => r.level === 'unknown' && (r.code === 'shared-mount' || r.code === 'gpu')))
  const lastMove = g ? moves.find(m => m.sid === g.sid && (m.status === 'done' || m.status === 'failed')) : null

  const checkPaths = async () => {
    if (!g) return
    setBusy(true); setNote('')
    const r = await apiJson(`/api/placement/guests/${g.type}/${g.vmid}/paths`, 'POST', {})
    setBusy(false)
    setNote(r.ok ? 'Checked on every node HyperProx can log in to. Nodes without a login stay "not checked".' : r.error ?? 'Could not check.')
    void load()
  }
  const corosync = async (id: string) => {
    setBusy(true)
    const r = await apiJson(`/api/placement/moves/${encodeURIComponent(id)}/corosync`, 'POST', {})
    setBusy(false)
    if (!r.ok) setNote(r.error ?? 'Could not read corosync.')
    void load()
  }
  const resolve = async (id: string) => { setBusy(true); const r = await apiJson(`/api/placement/moves/${encodeURIComponent(id)}/resolve`, 'POST', {}); setBusy(false); setNote(r.ok ? 'Resolved: read back from Proxmox.' : r.error ?? 'Not resolved.'); void load() }
  const cancel = async (id: string) => { const r = await apiJson(`/api/placement/moves/${encodeURIComponent(id)}/cancel`, 'POST', {}); if (!r.ok) setNote(r.error ?? 'Not cancelled.'); void load() }

  return (
    <Page>
      <HudHeader level={2} eyebrow="Cluster · placement" label="Placement overview"
        title={!view ? 'Reading the cluster' : advice ? advice.headline : 'Where every guest runs, and why'}
        ring={view ? { value: guests.length ? counts.free / guests.length : 0, text: String(counts.free), label: 'guests that could move' } : { value: 0, text: '…', label: 'guests that could move' }}
        chips={view ? [
          { label: 'Could move', value: counts.free, tone: 'good' },
          { label: 'Stay put', value: counts.fixed, tone: 'violet' },
          { label: 'Not checked', value: counts.unknown, tone: counts.unknown ? 'warn' : 'dim' },
          { label: 'Quiet now', value: view.quiet.quietNow ? 'yes' : 'no', tone: view.quiet.quietNow ? 'good' : 'warn' },
        ] : undefined}>
        <p className="text-sm" style={{ color: 'var(--text-soft)' }}>An advisor, not a balancer: Proxmox already balances HA guests itself. This shows what can move and what cannot, spots load that stays high for hours, and moves a guest only when you ask.</p>
      </HudHeader>

      {error && <Note tone="warn">{error}</Note>}
      {note && <Note tone="info">{note}</Note>}
      {view && view.map.unread.length > 0 && <Note tone="warn">Not read: {view.map.unread.join('; ')}. Anything that depends on it shows as &quot;not checked&quot;.</Note>}

      {view && (
        <Panel title="Placement map" sub="tap a guest">
          <PlacementMapView nodes={view.map.nodes} guests={guests} selected={pick} onPick={sid => setPick(p => (p === sid ? null : sid))} />
        </Panel>
      )}

      {g && (
        <Panel title={g.name || g.sid} sub={`on ${g.node}`} actions={<Btn small onClick={() => setPick(null)}>Close</Btn>}>
          <div className="space-y-3">
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
        </Panel>
      )}

      <Panel title="Balance" sub={advice ? `last ${advice.window.hours} h, backup windows left out` : 'reading history'}>
        {!advice && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Reading Prometheus history…</p>}
        {advice && (
          <div className="space-y-3">
            <Note tone={advice.balanced ? 'good' : advice.suggestions.length ? 'warn' : 'info'}>{advice.headline}</Note>
            {advice.suggestions.map(s => (
              <SuggestionCard key={`${s.sid}-${s.to}`} s={s} action={s.kind === 'move'
                ? (admin ? <Btn small kind="primary" onClick={() => setMoving({ sid: s.sid, name: s.name, to: s.to })}>Check this move…</Btn> : null)
                : <Link href="/ha" className="text-sm underline" style={{ color: 'var(--accent)' }}>Change the rule on the HA page</Link>} />
            ))}
            {advice.stuck.map((x, i) => <Note key={i} tone="info">{x}</Note>)}
            {advice.unread.length > 0 && <p className="text-xs" style={{ color: 'var(--warn)' }}>Could not read: {advice.unread.join('; ')}.</p>}
            <Details summary="The evidence" sub="what was measured">
              <ul className="list-disc space-y-1 pl-5 text-sm" style={{ color: 'var(--text-soft)' }}>{advice.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>
            </Details>
          </div>
        )}
      </Panel>

      {view && (
        <Panel title="Quiet windows" sub={`cluster time: ${view.quiet.tz}`} href="/settings/placement" linkLabel="Settings">
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
        <Panel title="Network cost" sub={view.map.network.shared ? 'moves share the heartbeat link' : view.map.network.shared === false ? 'separate migration network' : 'unknown'}>
          <ul className="list-disc space-y-1 pl-5 text-sm" style={{ color: 'var(--text-soft)' }}>{view.map.network.words.map((w, i) => <li key={i}>{w}</li>)}</ul>
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

      {moving && <MoveDialog sid={moving.sid} name={moving.name} to={moving.to} onClose={() => setMoving(null)} onDone={() => { void load(); void loadAdvice() }} />}
    </Page>
  )
}
