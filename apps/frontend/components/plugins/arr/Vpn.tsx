'use client'

// =============================================================================
//  HyperProx — Arr Stack, VPN (Gluetun) panel
//
//  Shown only for a stack with the VPN option: the tunnel as a ring (up or down), where it comes out, the forwarded
//  port beside qBittorrent's listening port (a dashed red link when they differ), speeds and uptime. The public
//  address is for admins; everyone else sees "hidden". Every problem carries its fix button for an admin, each with a
//  confirm that says what it does (downloads pause during a reconnect). Read from routes/arr-vpn.ts every 30 s while
//  the tab is visible. The VPN's login is never on this page.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { Panel, Pill, RingGauge, duration, rate, styles as s } from '@/components/visual/kit'
import c from './giveup.module.css'
import b from './better.module.css'
import { ConfirmBox } from './GiveUp'
import { FIX_LABEL, fixConfirm, portWord, tunnelWord, type FixName, type VpnActResult, type VpnStatus } from './better-view'

/** The panel's body for one reading (rendered in tests). */
export function VpnView({ v, canAct, onFix }: { v: VpnStatus; canAct: boolean; onFix: (f: FixName) => void }) {
  const up = v.tunnel === 'up'
  return (
    <>
      <div className={b.vpn}>
        <RingGauge value={up ? 1 : v.tunnel === 'down' ? 0.08 : 0.5} size={96} big text={up ? 'UP' : v.tunnel === 'down' ? 'DOWN' : '?'} label="Tunnel"
          color={up ? 'var(--hx-accent)' : 'var(--warn)'} spin={up} />
        <div className={b.vpnFacts}>
          <div className={b.where}>
            {up ? (v.location ?? 'Connected') : tunnelWord(v)}
            <small>{[v.provider, v.vpnType, v.chosen ? `chosen: ${v.chosen}` : ''].filter(Boolean).join(' · ')}</small>
          </div>
          <div className={c.row}>
            <Pill tone={up ? 'good' : 'warn'}>{tunnelWord(v)}</Pill>
            {v.publicIp ? <Pill>Public address {v.publicIp}</Pill> : v.publicIpHidden ? <Pill>Public address hidden</Pill> : null}
            {v.health && <Pill tone={v.health === 'healthy' ? 'good' : 'warn'}>Health check {v.health}</Pill>}
          </div>
          {v.portForwarding && (
            <div className={b.ports} data-match={v.portMatch} role="img" aria-label={portWord(v)}>
              <div className={b.port}><span>VPN forwards</span><b>{v.forwardedPort ?? '—'}</b></div>
              <i className={b.link} aria-hidden />
              <div className={b.port}><span>qBittorrent listens</span><b>{v.listenPort ?? '—'}</b></div>
            </div>
          )}
          {!v.portForwarding && <p className={c.note}>{portWord(v)}</p>}
          <div className={b.speeds}>
            <span>↓ <b>{v.downBps !== null ? rate(v.downBps) : '—'}</b></span>
            <span>↑ <b>{v.upBps !== null ? rate(v.upBps) : '—'}</b></span>
            {v.connection && <span>qBittorrent: <b>{v.connection}</b></span>}
            <span>Up for <b>{duration(v.uptimeSec)}</b></span>
          </div>
        </div>
      </div>
      {v.problems.length > 0 && (
        <ul className={b.problems} aria-label="Problems">
          {v.problems.map(p => (
            <li key={p.code} className={b.problem} data-code={p.code}>
              <p>{p.text}</p>
              {canAct && p.fix && <div className={c.row}><button type="button" className={c.primary} onClick={() => onFix(p.fix!)}>{FIX_LABEL[p.fix]}</button></div>}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

export function ArrVpn() {
  const { role } = useSession()
  const canAct = atLeast(role, 'admin')
  const [v, setV] = useState<VpnStatus | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [fix, setFix] = useState<FixName | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<VpnActResult | null>(null)

  const load = useCallback(async () => {
    const r = await apiJson<{ data: VpnStatus }>('/api/plugins/arrstack/vpn')
    if (!r.ok || !r.body?.data) { setErr(r.error ?? 'The VPN could not be read.'); return }
    setErr(null); setV(r.body.data)
  }, [])
  useEffect(() => {
    void load()
    const t = setInterval(() => { if (!document.hidden) void load() }, 30_000)
    return () => clearInterval(t)
  }, [load])

  const run = async () => {
    if (!fix) return
    setBusy(true)
    const r = await apiJson<{ data: VpnActResult }>('/api/plugins/arrstack/vpn/actions', 'POST', { action: fix, confirmed: true })
    setBusy(false); setFix(null)
    if (!r.ok || !r.body?.data) { setErr(r.error ?? 'The fix did not run.'); return }
    setResult(r.body.data); setV(r.body.data.status)
  }

  // A stack without Gluetun shows nothing at all.
  if (!v && !err) return null
  if (v && !v.present && !v.unavailable) return null
  return (
    <Panel title="VPN" sub={v?.guest ? `GLUETUN · ${v.guest.toUpperCase()}` : 'GLUETUN'}>
      {err && <p className={c.bad} role="alert">{err}</p>}
      {v?.unavailable && <p className={c.note} role="status">{v.unavailable}</p>}
      {result && (
        <div className={c.result} data-result={result.done ? 'queued' : 'removed-executable'} role="status">
          <p>{result.summary}</p>{result.notes.map(n => <p key={n} className={c.note}>{n}</p>)}
        </div>
      )}
      {fix && v && <ConfirmBox text={fixConfirm(fix, v)} yes={FIX_LABEL[fix]} busy={busy} onYes={() => void run()} onNo={() => setFix(null)} />}
      {busy && fix === 'reconnect' && <p className={s.empty}>Reconnecting… this can take a minute.</p>}
      {v?.present && <VpnView v={v} canAct={canAct && !fix} onFix={setFix} />}
    </Panel>
  )
}
