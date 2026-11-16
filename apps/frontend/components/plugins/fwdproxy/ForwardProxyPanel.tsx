'use client'

// =============================================================================
//  HyperProx — the 3proxy traffic picture
//
//  One reading drawn as: a traffic trace over the window (requests a minute,
//  with the bytes under it), rings for open connections per protocol and for
//  refusals, requests per protocol, who used it (when per-user figures are on)
//  and what was refused and why. Every figure is also said in words; colour
//  only repeats it.
// =============================================================================

import { useId } from 'react'
import { GlowBars, Panel, RingGauge, Tiles } from '@/components/visual/kit'
import f from './fwdproxy.module.css'
import { areaPath, plural, rate, size, type Reading } from './logic'

/** Requests a minute over the window, as a glowing trace with the traffic under it. */
export function TrafficTrace({ r }: { r: Reading }) {
  const id = useId().replace(/:/g, '')
  const W = 600, H = 120
  const req = areaPath(r.perMinute.map(m => m.requests), W, H)
  const bytes = areaPath(r.perMinute.map(m => m.bytes), W, H)
  const peak = r.perMinute.reduce((a, b) => (b.requests > a.requests ? b : a), { at: 0, requests: 0, bytes: 0 })
  return (
    <figure className={f.trace} aria-label={`${r.totals.requests} requests and ${size(r.totals.bytes)} in the last ${r.minutes} minutes; busiest minute ${peak.requests} requests`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id={`${id}a`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--hx-accent)" stopOpacity=".38" /><stop offset="1" stopColor="var(--hx-accent)" stopOpacity="0" /></linearGradient>
          <linearGradient id={`${id}b`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--hx-violet)" stopOpacity=".22" /><stop offset="1" stopColor="var(--hx-violet)" stopOpacity="0" /></linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map(y => <line key={y} x1="0" x2={W} y1={H * y} y2={H * y} className={f.grid} />)}
        {bytes.area && <path d={bytes.area} fill={`url(#${id}b)`} />}
        {bytes.line && <path d={bytes.line} className={f.bytesLine} />}
        {req.area && <path d={req.area} fill={`url(#${id}a)`} />}
        {req.line && <path d={req.line} className={f.reqLine} />}
      </svg>
      <figcaption>
        <span><i className={f.keyReq} aria-hidden />requests a minute <b>{rate(r)}</b> now, peak <b>{peak.requests}</b></span>
        <span><i className={f.keyBytes} aria-hidden />traffic <b>{size(r.totals.bytes)}</b> in {r.minutes} min</span>
      </figcaption>
    </figure>
  )
}

/** Open connections per protocol (out of the 256 3proxy allows at once) and the share refused. */
export function ProxyGauges({ r }: { r: Reading }) {
  return (
    <div className={f.gauges}>
      {r.conns.http !== null && <RingGauge value={Math.min(1, r.conns.http / 256)} text={String(r.conns.http)} label="HTTP connections" size={108} />}
      {r.conns.socks !== null && <RingGauge value={Math.min(1, r.conns.socks / 256)} text={String(r.conns.socks)} label="SOCKS connections" size={108} color="var(--hx-violet)" />}
      <RingGauge value={r.totals.requests ? Math.min(1, r.totals.denied / r.totals.requests) : 0} text={String(r.totals.denied)} label="refused" size={108} color="var(--warn)" />
    </div>
  )
}

/** The whole picture for one reading. */
export function ForwardProxyPanel({ r }: { r: Reading }) {
  return (
    <>
      <Panel title="Traffic" sub={`last ${r.minutes} minutes`}>
        <TrafficTrace r={r} />
        <Tiles label="Totals" items={[
          { label: 'requests', value: r.totals.requests, tone: 'accent' },
          { label: 'traffic', value: size(r.totals.bytes) },
          { label: 'refused', value: r.totals.denied, tone: r.totals.denied ? 'warn' : 'good' },
          { label: 'users', value: r.users.length },
        ]} />
      </Panel>
      <Panel title="Connections" sub={r.active ? 'running' : 'not running'}>
        <ProxyGauges r={r} />
        {r.services.length > 0 && (
          <GlowBars label="Requests per protocol" items={r.services.map(s => ({ key: s.name, label: s.name, value: s.requests, text: `${s.requests} · ${size(s.bytes)}` }))} />
        )}
      </Panel>
      <Panel title="Who used it" sub={r.perClient ? undefined : 'per-user figures are off'}>
        {!r.perClient ? <p className={f.quiet}>Per-user and per-device figures are off for this proxy, so only totals are shown. Turn them on under Settings.</p>
          : r.byUser.length || r.byClient.length ? (
            <div className={f.twoCol}>
              {r.byUser.length > 0 && <GlowBars label="Traffic by user" items={r.byUser.slice(0, 8).map(u => ({ key: u.name, label: u.name, value: u.bytes, text: `${size(u.bytes)} · ${plural(u.requests, 'request')}` }))} />}
              {r.byClient.length > 0 && <GlowBars warm label="Traffic by device" items={r.byClient.slice(0, 8).map(c => ({ key: c.address, label: c.address, value: c.bytes, text: `${size(c.bytes)} · ${plural(c.requests, 'request')}` }))} />}
            </div>
          ) : <p className={f.quiet}>Nobody used it in the window.</p>}
      </Panel>
      <Panel title="Refused" sub={r.totals.denied ? plural(r.totals.denied, 'refusal') : 'none'}>
        {r.denied.length
          ? <GlowBars warm label="Refusals by reason" items={r.denied.map(d => ({ key: d.code, label: d.label, value: d.count, text: String(d.count) }))} />
          : <p className={f.quiet}>Nothing was refused in the window.</p>}
        <p className={f.quiet}>A refusal is the proxy doing its job: a wrong password, a device outside the allowed networks, or a place it never goes (your own network, itself, a tunnel to a port other than 443).</p>
      </Panel>
    </>
  )
}
