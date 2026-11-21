'use client'

// =============================================================================
//  HyperProx — MikroTik: addresses that are not yours, and the LAN guard
//
//  Shown on the router page when a device uses an address outside every network the router owns, or when the guard
//  is on. The fix button asks the API, which answers with a confirmation naming exactly what will be added (the
//  shared dialog, lib/confirm-bus.ts); nothing here writes to the router itself. Admin only; an API token is
//  refused by the API.
// =============================================================================

import type { RouterVisual } from '@hyperprox/types'
import { useState } from 'react'
import { Icon, Panel, styles as s } from '@/components/visual/kit'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'

type Lan = NonNullable<RouterVisual['lan']>
const BASE = '/api/plugins/mikrotik/lan-guard'
const WARN = { color: 'var(--warn)' } as const

/** One stray device, in words. */
export function strayFacts(d: Lan['strays'][number]): string[] {
  return [
    `MAC ${d.mac}`,
    `Port ${d.port}`,
    d.softwareMade ? 'Software-made address' : 'Hardware address',
    d.connections ? `${d.connections} live connection${d.connections === 1 ? '' : 's'}` : 'No live connections',
    ...(d.lastSeen ? [`Last seen ${d.lastSeen}`] : []),
  ]
}

/** What the guard card says and which buttons it offers, from the guard's state. Pure, so it is tested. */
export function guardCard(g: Lan['guard'], canAct: boolean): {
  headline: string; detail: string; apply: { label: string; disabled: boolean } | null; undo: boolean; note?: string
  /** Shown as a warning with the Finish button when the guard is only partly in place. */
  warning?: string
} {
  const where = g.interface ? ` coming in on ${g.interface}` : ''
  const routedText = g.routed.length ? ` It also allows ${g.routed.map(r => `${r.subnet} reached via ${r.via}`).join(', ')}.` : ''
  const nets = g.subnets.join(', ')
  const blocked = canAct && g.canWrite === false
    ? 'This router login can only read, so HyperProx cannot add this. Give that router user a group with the write policy first.'
    : !canAct ? 'Only an admin can do this.' : undefined
  if (g.state === 'on') {
    return { headline: 'Blocked', detail: `The router drops traffic${where} from any address outside ${nets}.${routedText}`, apply: null, undo: canAct && g.canWrite !== false, note: blocked }
  }
  if (g.state === 'partial') {
    const why = g.ruleProblem ?? (g.missing.length ? `The guard's list is missing ${g.missing.join(', ')}. Until it is added, traffic from there is dropped too.` : 'The guard is only partly on the router.')
    return {
      headline: 'Partly in place',
      warning: why,
      detail: why,
      apply: g.interface ? { label: 'Finish the guard', disabled: !canAct || g.canWrite === false } : null, undo: canAct && g.canWrite !== false, note: blocked,
    }
  }
  if (!g.interface || !g.subnets.length) {
    return { headline: 'Not available', detail: g.unavailable ?? 'HyperProx cannot work out a safe plan for this router.', apply: null, undo: false }
  }
  return {
    headline: 'Not blocked',
    detail: `Adds the address list "${g.listName}" with ${nets}, and one rule at the top of the forward chain that drops traffic${where} from any other address.${routedText} Nothing else changes, and Undo removes exactly those two things.`,
    apply: { label: 'Block addresses that are not yours', disabled: !canAct || g.canWrite === false }, undo: false, note: blocked,
  }
}

export function StrayPanel({ lan, canAct, busy, msg, err, onApply, onUndo }: {
  lan: Lan; canAct: boolean; busy: boolean; msg?: string | null; err?: string | null; onApply: () => void; onUndo: () => void
}) {
  const card = guardCard(lan.guard, canAct)
  const warn = card.warning && (
    <div className={`${s.alert} ${s.alertWarn}`} role="group" aria-label="The LAN guard is only partly in place">
      <Icon name="warn" size={22} label="Warning" />
      <div className={s.alertBody}><b>The LAN guard is only partly in place</b><small>{card.warning}</small></div>
      {card.apply && <div className={s.alertAct}><button type="button" className={`${s.btn} ${s.btnPri}`} disabled={busy || card.apply.disabled} onClick={onApply}>{card.apply.label}</button></div>}
    </div>
  )
  return (
    <>
    {warn}
    <Panel title="Addresses that are not yours" sub={lan.strays.length ? `${lan.strays.length} FOUND` : 'GUARD ON'} label="Addresses that are not yours">
      {lan.strays.length === 0 ? <p className={s.empty}>No device is using an address outside your networks right now.</p> : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }} aria-label="Devices with addresses outside your networks">
          {lan.strays.map(d => (
            <li key={`${d.mac}-${d.address}`} style={{ border: '1px solid var(--warn)', borderRadius: 10, padding: '10px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={WARN} aria-hidden><Icon name="warn" size={14} /></span>
                <b>{d.name ?? d.address}</b>
                <code>{d.address}</code>
                <span style={WARN}>Address outside your networks</span>
              </div>
              <small style={{ display: 'block', color: 'var(--text-muted)', marginTop: 4 }}>
                Not one of your networks: {d.net}
              </small>
              <small style={{ display: 'block', color: 'var(--text-muted)', marginTop: 2 }}>{strayFacts(d).join(' · ')}</small>
            </li>
          ))}
        </ul>
      )}
      <div style={{ marginTop: 14 }}>
        <p style={{ margin: '0 0 6px' }}><b>{card.headline}.</b> {card.detail}</p>
        {card.note && <p className={s.note} style={{ color: 'var(--warn)' }}>{card.note}</p>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          {card.apply && !card.warning && <button type="button" className={`${s.btn} ${s.btnPri}`} disabled={busy || card.apply.disabled} onClick={onApply}>{card.apply.label}</button>}
          {card.undo && <button type="button" className={s.btn} disabled={busy} onClick={onUndo}>Undo: remove the guard</button>}
        </div>
        {err && <p role="alert" style={{ color: 'var(--crit)', marginTop: 8 }}>{err}</p>}
        {msg && <p role="status" style={{ marginTop: 8 }}>{msg}</p>}
      </div>
    </Panel>
    </>
  )
}

/** The panel with its buttons wired to the API. It shows nothing for a router with no stray and no guard. */
export function LanGuard({ lan, onChanged }: { lan?: RouterVisual['lan']; onChanged?: () => void }) {
  const { role } = useSession()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  if (!lan || (lan.strays.length === 0 && lan.guard.state === 'off')) return null

  const run = async (path: string, body: unknown) => {
    setBusy(true); setErr(null); setMsg(null)
    const res = await apiJson<{ data: { message: string } }>(`${BASE}/${path}`, 'POST', body)
    setBusy(false)
    if (res.ok) { setMsg(res.body?.data?.message ?? 'Done.'); onChanged?.() } else setErr(res.error ?? 'That did not work.')
  }
  return (
    <StrayPanel lan={lan} canAct={atLeast(role, 'admin')} busy={busy} msg={msg} err={err}
      onApply={() => run('apply', { interface: lan.guard.interface, subnets: lan.guard.subnets, routed: lan.guard.routed })}
      onUndo={() => run('undo', {})} />
  )
}
