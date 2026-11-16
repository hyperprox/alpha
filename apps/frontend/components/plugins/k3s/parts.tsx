'use client'

// =============================================================================
//  HyperProx — K3s page pieces: nodes, pods in trouble, workloads, the network
//
//  Pure render from a reading; the page (K3sPage.tsx) holds the state and the
//  calls. Colour is never the only signal: every card says its state in words.
// =============================================================================

import { DualRing, Icon, Pill } from '@/components/visual/kit'
import k from './k3s.module.css'
import {
  STATE_TONE, STATE_WORD, ago, cores, drainWords, gib, ingressLinks, share, visibleFixes,
  type DrainPlan, type Fix, type IngressRow, type NodeRow, type ProblemPod, type ServiceRow, type WorkloadRow,
} from './logic'

export function FixButtons({ fixes, admin, busy, onFix }: { fixes: Fix[]; admin: boolean; busy: string | null; onFix: (f: Fix) => void }) {
  const shown = visibleFixes(fixes, admin)
  if (!shown.length) return null
  return (
    <div className={k.fixes}>
      {shown.map(f => {
        const id = `${f.action}:${f.target.namespace ?? ''}/${f.target.name}`
        return (
          <button key={id} type="button" className={k.fix} data-kind={f.action} disabled={busy !== null} onClick={() => onFix(f)}>
            {busy === id ? 'Working…' : f.label}
          </button>
        )
      })}
    </div>
  )
}

export function NodeCard({ n, admin, busy, onFix }: { n: NodeRow; admin: boolean; busy: string | null; onFix: (f: Fix) => void }) {
  const c = share(n.cpu.usedMilli, n.cpu.capMilli), m = share(n.mem.usedBytes, n.mem.capBytes)
  const state = !n.ready ? 'down' : n.unschedulable ? 'cordoned' : n.pressure.length ? 'pressure' : 'ok'
  return (
    <article className={k.node} data-state={state} aria-label={`Node ${n.name}`}>
      <div className={k.nodeTop}>
        <DualRing cpu={(c ?? 0) * 100} mem={(m ?? 0) * 100} size={84} />
        <div className="min-w-0">
          <h3 className={k.nodeName}>{n.name}</h3>
          <div className={k.pills}>
            <Pill tone={n.ready ? 'good' : 'bad'}>{n.ready ? 'Ready' : 'Not ready'}</Pill>
            {n.unschedulable && <Pill tone="warn">Cordoned</Pill>}
            {n.roles.map(r => <Pill key={r} tone="accent">{r}</Pill>)}
          </div>
        </div>
      </div>
      {!n.ready && n.reason && <p className={k.why}>{n.reason}</p>}
      {n.pressure.length > 0 && <p className={k.why}>Under pressure: {n.pressure.join(', ')}</p>}
      <dl className={k.facts}>
        <dt>CPU</dt><dd>{c === null ? `${cores(n.cpu.capMilli)} (use not read yet)` : `${cores(n.cpu.usedMilli)} of ${cores(n.cpu.capMilli)}`}</dd>
        <dt>Memory</dt><dd>{m === null ? `${gib(n.mem.capBytes)} (use not read yet)` : `${gib(n.mem.usedBytes)} of ${gib(n.mem.capBytes)}`}</dd>
        <dt>Pods</dt><dd>{n.pods}</dd>
        <dt>Version</dt><dd>{n.version ?? '—'}</dd>
        {n.ip && <><dt>Address</dt><dd className="font-mono">{n.ip}</dd></>}
      </dl>
      <FixButtons fixes={n.fixes} admin={admin} busy={busy} onFix={onFix} />
    </article>
  )
}

export function ProblemCard({ p, admin, busy, onFix, now }: { p: ProblemPod; admin: boolean; busy: string | null; onFix: (f: Fix) => void; now?: number }) {
  return (
    <article className={k.problem} data-tone={STATE_TONE[p.state]} aria-label={`${STATE_WORD[p.state]}: ${p.namespace}/${p.name}`}>
      <header className={k.problemHead}>
        <Icon name={STATE_TONE[p.state] === 'bad' ? 'error' : 'warn'} size={18} />
        <b>{STATE_WORD[p.state]}</b>
        <small>{p.reason}</small>
      </header>
      <h3 className={k.podName}><small>{p.namespace}/</small>{p.name}</h3>
      <p className={k.msg}>{p.message}</p>
      <div className={k.meta}>
        {p.owner && <span>{p.owner.kind} {p.owner.name}</span>}
        {p.node && <span>on {p.node}</span>}
        {p.restarts > 0 && <span>{p.restarts} restart{p.restarts === 1 ? '' : 's'}</span>}
        {p.since && <span>started {ago(p.since, now)}</span>}
      </div>
      {p.lastLines && p.lastLines.length > 0 && (
        <pre className={k.log} aria-label="Last log lines">{p.lastLines.join('\n')}</pre>
      )}
      <FixButtons fixes={p.fixes} admin={admin} busy={busy} onFix={onFix} />
    </article>
  )
}

export function WorkloadTile({ w, admin, busy, onFix }: { w: WorkloadRow; admin: boolean; busy: string | null; onFix: (f: Fix) => void }) {
  const frac = w.desired > 0 ? Math.min(1, w.ready / w.desired) : 1
  const state = w.problem ? (w.ready === 0 ? 'bad' : 'warn') : 'ok'
  return (
    <li className={k.wl} data-state={state} aria-label={`${w.kind} ${w.namespace}/${w.name}: ${w.ready} of ${w.desired} ready`}>
      <div className={k.wlHead}><small>{w.kind}</small><span>{w.namespace}</span></div>
      <b className={k.wlName}>{w.name}</b>
      <div className={k.count}><span>{w.ready}</span>/{w.desired} <small>ready</small></div>
      <div className={k.bar} aria-hidden><i style={{ width: `${Math.round(frac * 100)}%` }} /></div>
      {w.images[0] && <small className={k.image} title={w.images.join(', ')}>{w.images[0]}{w.images.length > 1 ? ` +${w.images.length - 1}` : ''}</small>}
      <FixButtons fixes={w.fixes} admin={admin} busy={busy} onFix={onFix} />
    </li>
  )
}

export function NetworkView({ services, ingresses }: { services: ServiceRow[]; ingresses: IngressRow[] }) {
  const exposed = services.filter(s => s.type === 'LoadBalancer' || s.type === 'NodePort' || s.external.length)
  return (
    <div className={k.net}>
      <section aria-label="Ingresses">
        <h3 className={k.sub}>Ingresses · {ingresses.length}</h3>
        {ingresses.length === 0 ? <p className={k.quiet}>No ingress yet. One makes an app reachable on ports 80 and 443 of the nodes.</p> : (
          <ul className={k.routes}>
            {ingresses.map(i => (
              <li key={`${i.namespace}/${i.name}`}>
                <b>{i.name}</b> <small>{i.namespace}{i.tls ? ' · TLS' : ''}</small>
                {i.paths.map(p => <code key={p}>{p}</code>)}
                <span className={k.addrs}>{i.addresses.length ? i.addresses.join(', ') : 'no address yet'}</span>
                {ingressLinks(i).slice(0, 2).map(u => <a key={u} href={u} target="_blank" rel="noreferrer noopener">{u}</a>)}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Services">
        <h3 className={k.sub}>Services · {services.length}{exposed.length ? ` · ${exposed.length} exposed` : ''}</h3>
        <ul className={k.routes}>
          {services.map(s => (
            <li key={`${s.namespace}/${s.name}`} data-exposed={s.type !== 'ClusterIP' ? 'true' : undefined}>
              <b>{s.name}</b> <small>{s.namespace} · {s.type}</small>
              <code>{s.ports.join('  ')}</code>
              <span className={k.addrs}>{[s.clusterIP, ...s.external].filter(Boolean).join(' · ') || '—'}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

export function DrainSummary({ plan }: { plan: DrainPlan }) {
  return (
    <div className="flex flex-col gap-2">
      <ul className="list-disc pl-5 text-sm" style={{ color: 'var(--text-soft)' }}>
        {drainWords(plan).map(w => <li key={w}>{w}</li>)}
      </ul>
      {plan.move.length > 0 && <pre className={k.log} aria-label="Pods that move">{plan.move.join('\n')}</pre>}
      {plan.lost.length > 0 && <p className="text-sm" style={{ color: 'var(--crit-soft)' }}>Deleted for good: {plan.lost.join(', ')}</p>}
    </div>
  )
}
