'use client'

// =============================================================================
//  HyperProx — NGINX, Caddy and Envoy: each proxy, visual first
//
//  Phone first: one column of panels. The HUD (a health core: the outer ring
//  is the verdict, the inner one the share of requests that were not server
//  errors), what is wrong with a fix button on each, the route map (names on
//  the left, a moving wire through the proxy, every target with a reach dot),
//  the traffic gauges, and the certificates as remaining-life bars.
//
//  Actions are for admins: each opens a confirm with the action's own words,
//  then the server runs it only if a reading taken at that moment still offers
//  it, and audits it. Proxies connect by themselves (auto-connect); this page
//  never asks for an address or a login.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { BusyNote, GhostButton, Modal, Notice, PrimaryButton } from '@/components/vault/ui'
import { GlowBars, HudHeader, Panel, ProgressBar, SemiGauge, StatusDots, Tiles, styles as vs } from '@/components/visual/kit'
import { PluginSwitcher } from '@/components/plugins/visual/plugin-kit'
import { AutoConnectPanel } from '@/components/plugins/AutoConnect'
import w from './webproxy.module.css'
import {
  KIND_ICON, KIND_NAME, certLife, chipsOf, classBars, errorShare, pct, plural, routeRows, uptime, verdictOf, viaWords,
  type Action, type Cert, type Detail, type Found, type Kind, type Problem, type Reading, type RouteRow,
} from './logic'

const api = (k: Kind) => `/api/plugins/${k}`

// ── pieces (exported for the tests) ──────────────────────────────────────────

/** What is wrong, worst first, each with its fix when there is one. */
export function ProblemCards({ problems, admin, onFix }: { problems: Problem[]; admin: boolean; onFix: (a: Action) => void }) {
  if (!problems.length) return <p className={w.allClear}><span aria-hidden>✓</span> Nothing needs attention.</p>
  const sorted = [...problems].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
  return (
    <ul className={w.problems} aria-label="What needs attention">
      {sorted.map(p => (
        <li key={p.id} className={w.problem} data-sev={p.severity}>
          <span className={w.sev}>{p.severity === 'error' ? 'Error' : 'Warning'}</span>
          <div>
            <b>{p.title}</b>
            <p>{p.detail}</p>
            {p.fix && (admin
              ? <button type="button" className={w.fixBtn} onClick={() => onFix(p.fix!)}>{p.fix.label}</button>
              : <small className={w.muted}>An admin can fix this: {p.fix.label.toLowerCase()}.</small>)}
          </div>
        </li>
      ))}
    </ul>
  )
}

/** The route map: names → the proxy → each target, with a dot saying whether the container reaches it. */
export function RouteMap({ rows, kind }: { rows: RouteRow[]; kind: Kind }) {
  if (!rows.length) return <p className={w.muted}>{kind === 'envoy' ? 'No clusters yet.' : 'No sites with a name yet. Publish one from the Proxy page.'}</p>
  const word = { ok: 'reachable', bad: 'not reachable', warn: 'failing requests', off: 'not checked' }
  return (
    <ul className={w.map} aria-label={kind === 'envoy' ? 'Clusters and their hosts' : 'Routes'}>
      {rows.map(r => (
        <li key={r.key} className={w.route} data-mine={r.mine ? 'true' : undefined}>
          <div className={w.names}>
            {r.names.map(n => <span key={n} className={w.name}>{r.tls && <i className={w.lock} aria-label="HTTPS">🔒</i>}{n}</span>)}
            {r.note && <small>{r.note}</small>}
          </div>
          <div className={w.wire} aria-hidden><i /><span>{r.via}</span></div>
          <ul className={w.targets}>
            {r.targets.map(t => (
              <li key={t.label} data-state={t.state} title={`${t.label}: ${word[t.state]}`}>
                <i aria-hidden />{t.label}<span className={vs.srOnly}>, {word[t.state]}</span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  )
}

/** Certificates as remaining-life bars (a full bar is 90 days). */
export function CertBars({ certs, waiting = [] }: { certs: Cert[]; waiting?: string[] }) {
  if (!certs.length && !waiting.length) return <p className={w.muted}>No certificates.</p>
  return (
    <ul className={w.certs} aria-label="Certificates">
      {certs.map(c => {
        const l = certLife(c)
        return (
          <li key={c.path} data-tone={l.tone}>
            <span className={w.certName}>{c.name}{c.issuer && <small>{c.issuer}</small>}</span>
            <ProgressBar value={l.value * 100} variant={l.tone === 'good' ? 'normal' : 'stall'} label={`${c.name}: ${l.words}`} />
            <em>{l.words}</em>
          </li>
        )
      })}
      {waiting.map(n => (
        <li key={n} data-tone="warn">
          <span className={w.certName}>{n}<small>waiting for a certificate</small></span>
          <ProgressBar value={null} variant="stall" label={`${n}: waiting for a certificate`} />
          <em>not issued yet</em>
        </li>
      ))}
    </ul>
  )
}

function Traffic({ d }: { d: Detail }) {
  if (d.kind === 'nginx') {
    const s = d.status
    return (
      <div className={w.gauges}>
        {s ? <SemiGauge value={s.active} max={Math.max(10, Math.ceil(s.active * 1.5))} label="Active connections" unit="open" />
          : <p className={w.muted}>The status page is off, so connections are not shown.</p>}
        {s && <Tiles label="Connections now" items={[{ label: 'reading', value: s.reading }, { label: 'writing', value: s.writing }, { label: 'waiting', value: s.waiting }, { label: 'requests served', value: s.requests }]} />}
        <div className={w.barsBox}>
          <h3>Last 5 minutes · {plural(d.traffic.total, 'request')}</h3>
          <GlowBars label="Requests by status in the last five minutes" items={classBars(d.traffic.byClass)} />
        </div>
      </div>
    )
  }
  if (d.kind === 'envoy') {
    return (
      <div className={w.gauges}>
        <Tiles label="Envoy" items={[
          { label: 'state', value: d.draining ? 'drained' : (d.state ?? '—').toLowerCase(), tone: d.draining ? 'warn' : 'good' },
          { label: 'up for', value: uptime(d.uptimeSeconds) }, { label: 'listeners', value: d.listeners.length }, { label: 'requests', value: d.requests.total },
        ]} />
        <StatusDots label="Listeners" items={d.listeners.map(l => ({ label: `${l.name} · ${l.address}`, state: 'ok' as const }))} />
        <div className={w.barsBox}>
          <h3>Since Envoy started · {pct(d.requests.errorRate)} server errors</h3>
          <GlowBars label="Requests by status since Envoy started" items={classBars(d.requests.byClass)} />
        </div>
      </div>
    )
  }
  if (d.kind === 'caddy') {
    return (
      <div className={w.upGrid}>
        {d.upstreams.length ? d.upstreams.map(u => (
          <div key={u.address} className={w.upCard} data-state={u.reachable === false ? 'bad' : u.fails ? 'warn' : u.reachable ? 'ok' : 'off'}>
            <b>{u.address}</b>
            <span>{u.reachable === false ? 'not reachable' : u.reachable ? 'reachable' : 'not checked'}</span>
            <small>{plural(u.requests, 'request')} in flight · {plural(u.fails, 'recent failure')}</small>
          </div>
        )) : <p className={w.muted}>No upstreams yet.</p>}
      </div>
    )
  }
  return null
}

function ConfirmModal({ a, name, onClose, onRun, busy }: { a: Action; name: string; onClose: () => void; onRun: () => void; busy: boolean }) {
  return (
    <Modal title={`${a.label}: ${name}`} onClose={onClose} footer={
      <div className="flex flex-wrap justify-end gap-2">
        <GhostButton type="button" onClick={onClose}>Cancel</GhostButton>
        <PrimaryButton type="button" disabled={busy} onClick={onRun}>{busy ? 'Working…' : a.danger ? `Yes, ${a.label.toLowerCase()}` : a.label}</PrimaryButton>
      </div>}>
      <p className="text-sm" style={{ color: 'var(--text-soft)' }}>{a.confirm}</p>
      {a.danger && <Notice kind="warn">This affects traffic going through {name} right now.</Notice>}
    </Modal>
  )
}

// ── one proxy ────────────────────────────────────────────────────────────────

function ProxyView({ r: first, kind, admin, onGone }: { r: Reading; kind: Kind; admin: boolean; onGone: () => void }) {
  const [r, setR] = useState(first)
  const [ask, setAsk] = useState<Action | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null)
  useEffect(() => setR(first), [first])
  const d = r.detail

  const run = async () => {
    if (!ask) return
    setBusy(true); setNote(null)
    const res = await apiJson<{ data: { ok: boolean; message: string; reading: Reading } }>(`${api(kind)}/instances/${r.id}/actions/${ask.id}`, 'POST', { confirm: true })
    setBusy(false); setAsk(null)
    if (res.ok) { setNote({ text: res.body!.data.message, ok: res.body!.data.ok }); setR(res.body!.data.reading) }
    else setNote({ text: res.error ?? 'That did not work.', ok: false })
  }
  const refresh = async () => {
    setBusy(true)
    const res = await apiJson<{ data: Reading }>(`${api(kind)}/instances/${r.id}?fresh=1`)
    setBusy(false)
    if (res.ok) setR(res.body!.data); else setNote({ text: res.error ?? 'Could not read it.', ok: false })
  }
  const disconnect = async () => {
    if (!window.confirm(`Stop watching ${r.name}? HyperProx will not connect it again by itself; nothing changes in the container.`)) return
    const res = await apiJson(`${api(kind)}/instances/${r.id}`, 'DELETE')
    if (res.ok) onGone(); else setNote({ text: res.error ?? 'Could not disconnect it.', ok: false })
  }
  const others = r.actions.filter(a => !r.problems.some(p => p.fix?.id === a.id))

  return (
    <>
      <Panel title="What needs attention" sub={r.problems.length ? plural(r.problems.length, 'item') : undefined}
        actions={<GhostButton type="button" disabled={busy} onClick={() => void refresh()}>{busy ? 'Reading…' : 'Read again'}</GhostButton>}>
        {note && <p className="text-sm" role="status" style={{ color: note.ok ? 'var(--good)' : 'var(--warn-2)' }}>{note.text}</p>}
        {r.error ? <Notice kind="error">{r.error}</Notice> : <ProblemCards problems={r.problems} admin={admin} onFix={setAsk} />}
        {admin && others.length > 0 && (
          <div className={w.toolbar} aria-label="Actions">
            {others.map(a => <button key={a.id} type="button" className={w.actBtn} data-danger={a.danger ? 'true' : undefined} onClick={() => setAsk(a)}>{a.label}</button>)}
          </div>
        )}
      </Panel>
      {d && (
        <Panel title={kind === 'envoy' ? 'Clusters' : 'Route map'} sub={kind === 'envoy' ? plural(d.kind === 'envoy' ? d.clusters.length : 0, 'cluster') : `through ${r.name}`}>
          <RouteMap rows={routeRows(d)} kind={kind} />
          {d.kind === 'nginx' && d.upstreams.length > 0 && (
            <div className={w.upGrid}>
              {d.upstreams.map(u => (
                <div key={u.name} className={w.upCard} data-state={u.servers.some(x => d.reach?.[x] === false) ? 'warn' : 'ok'}>
                  <b>upstream {u.name}</b><small>{plural(u.servers.length, 'server')} · {u.file.split('/').slice(-1)[0]}</small>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}
      {d && <Panel title={kind === 'caddy' ? 'Upstreams' : 'Traffic'}><Traffic d={d} /></Panel>}
      {d && d.kind !== 'envoy' && (
        <Panel title="Certificates" sub={d.kind === 'caddy' ? 'Caddy gets and renews them by itself' : d.certbot ? 'certbot renews them' : 'from the configuration'}>
          <CertBars certs={d.certs} waiting={d.kind === 'caddy' ? d.missingCerts : []} />
        </Panel>
      )}
      {admin && (
        <p className={w.footer}>
          CT {r.vmid} on {r.node} · read {new Date(r.at).toLocaleTimeString()} ·{' '}
          <button type="button" className={w.linkBtn} onClick={() => void disconnect()}>Stop watching</button>
        </p>
      )}
      {ask && <ConfirmModal a={ask} name={r.name} busy={busy} onClose={() => setAsk(null)} onRun={() => void run()} />}
    </>
  )
}

// ── the page ─────────────────────────────────────────────────────────────────

export function WebProxyPage({ kind }: { kind: Kind }) {
  const { role } = useSession()
  const admin = atLeast(role, 'admin')
  const [data, setData] = useState<{ readings: Reading[]; found: Found[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pick, setPick] = useState<string | null>(null)
  const name = KIND_NAME[kind]

  const reload = useCallback(async () => {
    const r = await apiJson<{ data: { readings: Reading[]; found: Found[] } }>(`${api(kind)}/instances`)
    if (r.ok) { setData(r.body!.data); setError(null) } else setError(r.error ?? `Could not read the ${name} proxies.`)
  }, [kind, name])
  useEffect(() => { void reload() }, [reload])

  const readings = data?.readings ?? []
  const current = readings.find(x => x.id === pick) ?? readings[0] ?? null
  const v = current ? verdictOf(current) : null
  const share = errorShare(current?.detail ?? null)

  return (
    <div className={vs.page}>
      <PluginSwitcher current={kind} />
      <HudHeader eyebrow={`Plug-in · ${name}`} title={current ? current.name : name} icon={KIND_ICON[kind]}
        core={current && v ? {
          outer: { value: v.score, label: 'health', color: v.tone === 'good' ? 'var(--good)' : v.tone === 'warn' ? 'var(--warn)' : 'var(--crit)' },
          ...(share.rate !== null ? { inner: { value: 1 - share.rate, label: `requests without a server error, ${share.over}` } } : {}),
          text: current.detail?.version ?? '—', caption: name, verdict: { text: v.text, tone: v.tone },
        } : undefined}
        chips={current ? chipsOf(current) : [{ label: 'proxies', value: readings.length }]} />
      {error && <Notice kind="error">{error}</Notice>}
      {!data && !error && <BusyNote>Reading {name}…</BusyNote>}

      <AutoConnectPanel plugins={[kind]} onChanged={() => void reload()} />

      {data && !readings.length && (
        <Panel title="Found on the cluster" sub={data.found.length ? plural(data.found.length, 'proxy', 'proxies') : undefined}>
          {data.found.length
            ? <ul className={w.found}>{data.found.map(f => (
                <li key={f.machineId}><span><b>{f.name}</b> <small>CT {f.vmid} · {f.node} · {viaWords(f.via)}</small></span>
                  <small>{f.running ? 'Connecting by itself…' : 'Not running: connected when it starts'}</small></li>))}</ul>
            : <p className="text-sm" style={{ color: 'var(--text-soft)' }}>No {name} found yet. Install it from the <a href="/catalogue" style={{ color: 'var(--hx-accent)' }}>Catalogue</a> (Reverse proxy → {name}): HyperProx connects it here by itself{kind !== 'envoy' ? ' and adds it to the Proxy page, so you can publish apps through it' : ''}.</p>}
        </Panel>
      )}

      {readings.length > 1 && (
        <div className={w.toolbar} role="tablist" aria-label={`${name} proxies`}>
          {readings.map(x => <button key={x.id} type="button" role="tab" aria-selected={current?.id === x.id} className={vs.btn} onClick={() => setPick(x.id)}>{x.name}</button>)}
        </div>
      )}
      {current && <ProxyView key={current.id} r={current} kind={kind} admin={admin} onGone={() => { setPick(null); void reload() }} />}
    </div>
  )
}
