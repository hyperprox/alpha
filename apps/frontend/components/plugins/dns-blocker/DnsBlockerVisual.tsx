'use client'

// =============================================================================
//  HyperProx — DNS blockers: the visual pieces of one blocker
//
//  The shield (a ring that is green while it protects), the 24-hour query flow (a bar per hour with the blocked part
//  glowing), the top blocked domains with an Allow button each, the busiest devices (or a note that they are hidden), the
//  upstream rack (an LED and a latency bar per server), the block-list freshness ring, and the problem cards, each with its
//  fix button. Every one says its reading in words as well as colour.
// =============================================================================

import { GlowBars, Icon, Panel, Pill, RingGauge } from '@/components/visual/kit'
import d from './dns-blocker.module.css'
import {
  PAUSE_MINUTES, STATE_WORD, ageWords, num, pauseLeft, queryBars, whyNot,
  type Problem, type Reading,
} from './logic'

// ── the 24-hour flow ─────────────────────────────────────────────────────────

export function QueryFlow({ r, now }: { r: Reading; now?: number }) {
  const bars = queryBars(r.history, now)
  const total = r.history.reduce((n, h) => n + h.total, 0)
  if (!total) return <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No queries in the last 24 hours yet.</p>
  const peak = bars.reduce((a, b) => (b.total > a.total ? b : a), bars[0])
  return (
    <div>
      <ul className={d.flow} aria-label={`Queries per hour for the last 24 hours. Busiest: ${peak.label}.`}>
        {bars.map(b => (
          <li key={b.at} title={b.label} aria-label={b.label}>
            <i className={d.flowTotal} style={{ height: `${Math.max(b.total ? 4 : 1, b.totalPct)}%` }} />
            <i className={d.flowBlocked} style={{ height: `${b.blocked ? Math.max(3, b.blockedPct) : 0}%` }} />
          </li>
        ))}
      </ul>
      <div className={d.flowKey}><span><i className={d.keyTotal} aria-hidden /> all queries</span><span><i className={d.keyBlocked} aria-hidden /> blocked</span><span>24 hours, oldest on the left</span></div>
    </div>
  )
}

// ── top blocked, with an Allow button each ───────────────────────────────────

export function TopBlocked({ r, canAllow, onAllow }: { r: Reading; canAllow: boolean; onAllow: (domain: string) => void }) {
  if (!r.topBlocked.length) return <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Nothing has been blocked yet.</p>
  const max = Math.max(...r.topBlocked.map(x => x.count), 1)
  return (
    <ul className={d.top} aria-label="Domains blocked most">
      {r.topBlocked.map(x => (
        <li key={x.domain}>
          <span className={d.topName} title={x.domain}>{x.domain}</span>
          <span className={d.topTrack} aria-hidden><i style={{ width: `${Math.max(4, (x.count / max) * 100)}%` }} /></span>
          <em>{num(x.count)}</em>
          {canAllow && <button type="button" className={d.mini} onClick={() => onAllow(x.domain)} aria-label={`Allow ${x.domain}`}>Allow</button>}
        </li>
      ))}
    </ul>
  )
}

// ── devices ──────────────────────────────────────────────────────────────────

export function Clients({ r, canHide, onToggleHide, hidden }: { r: Reading; canHide: boolean; onToggleHide: () => void; hidden: boolean }) {
  if (r.clients === null) {
    return (
      <div>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          {hidden ? 'Per-device numbers are hidden for this blocker, so HyperProx does not even ask for them.' : 'Per-device numbers are shown to operators and admins only.'}
          {r.totals.clients !== null && ` ${num(r.totals.clients)} device${r.totals.clients === 1 ? '' : 's'} asked something.`}
        </p>
        {canHide && hidden && <button type="button" className={d.mini} onClick={onToggleHide}>Show devices again</button>}
      </div>
    )
  }
  return (
    <div>
      <GlowBars label="Devices that ask most" items={r.clients.slice(0, 8).map(c => ({ key: c.ip, label: c.name || c.ip, title: c.name ? `${c.name} (${c.ip})` : c.ip, value: c.count, text: num(c.count) }))} />
      {!r.clients.length && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No device has asked anything yet.</p>}
      {canHide && <button type="button" className={d.mini} onClick={onToggleHide}>Hide per-device numbers</button>}
    </div>
  )
}

// ── upstream rack ────────────────────────────────────────────────────────────

export function UpstreamRack({ r }: { r: Reading }) {
  if (!r.upstreams.length) return <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No upstream servers reported.</p>
  const max = Math.max(...r.upstreams.map(u => u.probeMs ?? u.avgMs ?? 0), 100)
  return (
    <ul className={d.rack} aria-label="Upstream DNS servers">
      {r.upstreams.map(u => {
        const ms = u.probeMs ?? u.avgMs
        return (
          <li key={u.address} data-state={u.state}>
            <i className={d.led} aria-hidden />
            <span className={d.rackName}><b>{u.address}</b>{u.name && <small>{u.name}</small>}</span>
            <span className={d.rackWord}>{STATE_WORD[u.state]}</span>
            <span className={d.rackBar} aria-hidden><i style={{ width: `${ms ? Math.max(4, Math.min(100, (ms / max) * 100)) : 0}%` }} /></span>
            <em>{ms !== null && ms !== undefined ? `${ms} ms` : '—'}</em>
            {u.detail && <small className={d.rackDetail}>{u.detail}{u.queries ? ` · ${num(u.queries)} queries` : ''}</small>}
          </li>
        )
      })}
    </ul>
  )
}

// ── block lists ──────────────────────────────────────────────────────────────

export function ListFreshness({ r }: { r: Reading }) {
  const b = r.blocklists
  // A full ring at the day the lists were refreshed, empty at eight days (the point they count as stale).
  const frac = b.ageHours === null ? 0 : Math.max(0, 1 - b.ageHours / (8 * 24))
  return (
    <div className={d.lists}>
      <RingGauge value={frac} size={104} stroke={8} color={b.stale ? 'var(--warn)' : 'var(--hx-accent)'} text={b.ageHours === null ? '—' : b.ageHours < 48 ? `${b.ageHours}h` : `${Math.round(b.ageHours / 24)}d`} label="list age" />
      <dl>
        <dt>Entries</dt><dd>{num(b.domains)}</dd>
        <dt>Lists</dt><dd>{num(b.lists)}</dd>
        <dt>Updated</dt><dd style={{ color: b.stale ? 'var(--warn)' : undefined }}>{ageWords(b.ageHours)}{b.stale ? ' (overdue)' : ''}</dd>
      </dl>
    </div>
  )
}

// ── problems ─────────────────────────────────────────────────────────────────

export function Problems({ problems, role, busy, onFix, onHowTo }: {
  problems: Problem[]; role: string; busy: string | null; onFix: (p: Problem) => void; onHowTo: () => void
}) {
  if (!problems.length) return <p className="text-sm" style={{ color: 'var(--good)' }}>Nothing needs a look: blocking is on, its servers answer and the lists are fresh.</p>
  return (
    <ul className={d.problems} aria-label="Things that need a look">
      {problems.map(p => {
        const blocked = p.fix ? whyNot(p.fix.secure, role) : ''
        return (
          <li key={p.id} data-severity={p.severity}>
            <span className={d.problemIcon} aria-hidden><Icon name={p.severity === 'info' ? 'check' : 'warn'} size={18} /></span>
            <span className={d.problemText}><b>{p.severity === 'bad' ? 'Not working' : p.severity === 'warn' ? 'Needs a look' : 'To know'}</b>{p.text}</span>
            {p.fix && (
              <button type="button" className={d.fix} disabled={!!blocked || busy === p.id} title={blocked || undefined} onClick={() => onFix(p)}>
                {busy === p.id ? 'Working…' : p.fix.label}{p.fix.secure && !blocked ? ' (master password)' : ''}
              </button>
            )}
            {!p.fix && p.id === 'no_queries' && <button type="button" className={d.fix} onClick={onHowTo}>How to point my network at it</button>}
          </li>
        )
      })}
    </ul>
  )
}

// ── pause controls ───────────────────────────────────────────────────────────

export function PauseControls({ r, role, busy, onPause, onResume }: { r: Reading; role: string; busy: boolean; onPause: (m: number) => void; onResume: () => void }) {
  const why = whyNot(false, role)
  if (!r.protection.on) {
    return (
      <div className={d.pause}>
        <Pill tone="warn">Blocking is off{r.protection.secondsLeft !== null ? `, back on in ${pauseLeft(r.protection.secondsLeft)}` : ''}</Pill>
        <button type="button" className={d.fix} disabled={!!why || busy} title={why || undefined} onClick={onResume}>Turn blocking back on</button>
      </div>
    )
  }
  return (
    <div className={d.pause}>
      <span className={d.pauseLabel}>Pause blocking for</span>
      {PAUSE_MINUTES.map(m => (
        <button key={m} type="button" className={d.mini} disabled={!!why || busy} title={why || undefined} onClick={() => onPause(m)}>{m} min</button>
      ))}
    </div>
  )
}

export { Panel }
