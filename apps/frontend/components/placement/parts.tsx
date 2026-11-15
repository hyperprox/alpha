// The Placement page's visual pieces: node columns with capacity bars, guests as chips placed on them, a guest's
// per-node verdicts, a move's cost, a suggestion, a history row. This file stays free of styling imports (Tailwind
// classes and the theme's CSS variables only), so each piece renders on its own in a test. Buttons come in from the page.

import type { ReactNode } from 'react'
import { nodeBars, pinWord, verdictOf, VERDICT_WORD, costLines, corosyncLine, moveTitle, gib, type Verdict } from './logic'
import type { GuestPlacement, MovePlan, MoveRecord, PlacementNode, Suggestion, TargetCheck } from './types'

const DOT: Record<Verdict, string> = { free: 'var(--hx-accent)', unknown: 'var(--warn)', fixed: 'var(--violet)', template: 'var(--text-dimmer)' }
const MONO: React.CSSProperties = { fontFamily: 'var(--font-mono)' }
const DISPLAY: React.CSSProperties = { fontFamily: 'var(--font-display)' }

export function Bars({ node }: { node: PlacementNode }) {
  return (
    <ul className="my-2 grid gap-1.5" aria-label={`${node.node} capacity`}>
      {nodeBars(node).map(b => (
        <li key={b.key} className="grid items-center gap-x-2" style={{ gridTemplateColumns: '44px 1fr', ...MONO, fontSize: 10.5, color: 'var(--text-dim)' }}>
          <span>{b.label}</span>
          <span className="relative block overflow-hidden rounded" style={{ height: 8, background: 'var(--track)' }} aria-hidden>
            <i className="absolute inset-y-0 left-0 rounded" data-over={b.over ? 'true' : undefined}
              style={{ width: `${b.pct}%`, background: b.over ? 'linear-gradient(90deg, var(--warn), var(--crit))' : 'var(--hx-accent)',
                boxShadow: b.over ? 'none' : '0 0 8px color-mix(in srgb, var(--hx-accent) 55%, transparent)' }} />
          </span>
          <span style={{ gridColumn: 2, fontSize: 10, color: 'var(--text-dimmer)' }}>{b.text}</span>
        </li>
      ))}
    </ul>
  )
}

export function GuestChip({ g, selected, onPick }: { g: GuestPlacement; selected?: boolean; onPick?: (sid: string) => void }) {
  const v = verdictOf(g)
  const pin = pinWord(g)
  return (
    <button type="button" data-v={v} aria-pressed={selected ? 'true' : 'false'} onClick={() => onPick?.(g.sid)}
      title={g.summary}
      className="inline-flex max-w-full items-center gap-1.5 rounded-lg border text-left"
      style={{ minHeight: 30, padding: '3px 9px 3px 7px', fontSize: 13, color: 'var(--text-bright)', opacity: g.template || g.status !== 'running' ? 0.6 : 1,
        borderColor: selected ? 'var(--hx-accent)' : 'var(--border-strong)',
        background: selected ? 'color-mix(in srgb, var(--hx-accent) 14%, var(--surface))' : 'var(--surface)' }}>
      <i aria-hidden className="inline-block shrink-0 rounded-full" style={{ width: 8, height: 8, background: DOT[v], boxShadow: v === 'free' ? `0 0 6px ${DOT[v]}` : 'none' }} />
      <span className="truncate">{g.name || g.sid}</span>
      <small style={{ ...MONO, fontSize: 10, color: 'var(--text-dimmer)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
        {g.ha ? 'HA · ' : ''}{pin ?? VERDICT_WORD[v]}
      </small>
      <span className="sr-only">, {g.status}, {VERDICT_WORD[v]}</span>
    </button>
  )
}

export function NodeColumn({ node, guests, selected, onPick }: { node: PlacementNode; guests: GuestPlacement[]; selected?: string | null; onPick?: (sid: string) => void }) {
  const off = !node.online || node.maintenance
  const here = guests.filter(g => g.node === node.node).sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.usage.cores - a.usage.cores)
  return (
    <section aria-label={`Node ${node.node}`} className="relative min-w-0 overflow-hidden rounded-xl border p-3"
      style={{ borderColor: off ? 'var(--warn)' : 'var(--hx-line)', background: 'var(--ground-deep)' }}>
      <div aria-hidden className="absolute inset-x-0 top-0" style={{ height: 2, background: off ? 'var(--warn)' : 'linear-gradient(90deg, transparent, var(--hx-accent), transparent)', opacity: 0.7 }} />
      <div className="flex items-baseline justify-between gap-2">
        <h3 style={{ ...DISPLAY, fontWeight: 700, fontSize: 21, color: 'var(--text-bright)' }}>{node.node}</h3>
        <span style={{ ...MONO, fontSize: 11, color: off ? 'var(--warn)' : 'var(--text-dim)' }}>{!node.online ? 'offline' : node.maintenance ? 'maintenance' : `${here.length} guests`}</span>
      </div>
      {node.cpuModel && <p className="truncate" style={{ ...MONO, fontSize: 10.5, color: 'var(--text-dimmer)' }} title={node.cpuModel}>{node.cpuModel}</p>}
      <Bars node={node} />
      <div className="flex flex-wrap gap-1.5">
        {here.map(g => <GuestChip key={g.sid} g={g} selected={selected === g.sid} onPick={onPick} />)}
        {!here.length && <p className="text-xs" style={{ color: 'var(--text-dim)' }}>No guests.</p>}
      </div>
    </section>
  )
}

export function PlacementMapView({ nodes, guests, selected, onPick }: { nodes: PlacementNode[]; guests: GuestPlacement[]; selected?: string | null; onPick?: (sid: string) => void }) {
  return (
    <div>
      <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))' }}>
        {nodes.map(n => <NodeColumn key={n.node} node={n} guests={guests} selected={selected} onPick={onPick} />)}
      </div>
      <p className="mt-2.5 flex flex-wrap gap-3.5" style={{ ...MONO, fontSize: 11, color: 'var(--text-dim)' }}>
        {(['free', 'unknown', 'fixed', 'template'] as Verdict[]).map(v => (
          <span key={v} className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block rounded-full" style={{ width: 8, height: 8, background: DOT[v] }} />{VERDICT_WORD[v]}</span>
        ))}
      </p>
    </div>
  )
}

const VERDICT_TARGET: Record<TargetCheck['verdict'], { word: string; color: string }> = {
  ok: { word: 'can go', color: 'var(--hx-accent)' }, unknown: { word: 'not checked', color: 'var(--warn)' }, no: { word: 'no', color: 'var(--violet)' },
}

/** Every other node, with the verdict and its reasons. `action` renders a button for a node (the page's "Move…"). */
export function TargetList({ g, action }: { g: GuestPlacement; action?: (node: string) => ReactNode }) {
  return (
    <ul className="grid gap-2" aria-label={`Where ${g.name || g.sid} could go`}>
      {g.targets.map(t => {
        const v = VERDICT_TARGET[t.verdict]
        const shown = t.reasons.filter(r => r.level !== 'info')
        return (
          <li key={t.node} data-v={t.verdict} className="border-l-[3px] py-1 pl-2.5" style={{ borderColor: v.color }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span><b style={{ ...DISPLAY, fontSize: 17, color: 'var(--text-bright)' }}>{t.node}</b> <span style={{ ...MONO, fontSize: 11, color: v.color }}>{v.word}</span></span>
              {action?.(t.node)}
            </div>
            {shown.length > 0 && <ul className="mt-0.5 list-disc pl-4 text-[13px]" style={{ color: 'var(--text-soft)' }}>{shown.map((r, i) => <li key={i}>{r.words}</li>)}</ul>}
          </li>
        )
      })}
    </ul>
  )
}

/** The guest card's top: why it is where it is, in plain words. */
export function WhyHere({ g }: { g: GuestPlacement }) {
  return (
    <div className="space-y-1">
      <p className="text-sm" style={{ color: 'var(--text-bright)' }}>{g.summary}</p>
      {g.why.length
        ? <ul className="list-disc pl-5 text-sm" style={{ color: 'var(--text-soft)' }}>{g.why.map((w, i) => <li key={i}>{w}</li>)}</ul>
        : <p className="text-sm" style={{ color: 'var(--text-soft)' }}>Nothing ties it to {g.node}: no passed-through device, bind mount, local disk or HA rule.</p>}
      <p style={{ ...MONO, fontSize: 11, color: 'var(--text-dim)' }}>
        {g.type === 'lxc' ? 'Container' : 'VM'} {g.vmid} · {g.status} · {g.cpus || 'no limit'} vCPU · {gib(g.maxmem)}{g.ha ? ' · HA' : ''}
        {g.usage.cores ? ` · using ${g.usage.cores.toFixed(1)} cores, ${gib(g.usage.mem)}` : ''}
      </p>
    </div>
  )
}

/** The confirm dialog's facts: downtime, data, network, then the refusals and warnings. */
export function CostList({ plan }: { plan: MovePlan }) {
  return (
    <div className="space-y-2" data-testid="move-cost">
      <ul className="space-y-1 text-sm" style={{ color: 'var(--text-bright)' }}>{costLines(plan).map((l, i) => <li key={i}>{l}</li>)}</ul>
      {plan.refusals.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm" style={{ color: 'var(--crit-soft)' }} aria-label="Why it cannot move">{plan.refusals.map((r, i) => <li key={i}>{r}</li>)}</ul>}
      {plan.warnings.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm" style={{ color: 'var(--warn)' }} aria-label="Worth knowing">{plan.warnings.map((r, i) => <li key={i}>{r}</li>)}</ul>}
      <p style={{ ...MONO, fontSize: 11, color: 'var(--text-dim)' }}>{plan.method === 'ha' ? 'Through HA (as ha-manager migrate does).' : 'A Proxmox migrate.'} {plan.call}</p>
    </div>
  )
}

const hrs = (h: number) => (h >= 10 ? Math.round(h) : Math.round(h * 10) / 10)

export function SuggestionCard({ s, action }: { s: Suggestion; action?: ReactNode }) {
  const m = s.effect.metric === 'cpu' ? 'CPU' : 'memory'
  return (
    <article className="space-y-2 rounded-xl border p-3" style={{ borderColor: 'var(--hx-line)', background: 'var(--ground-deep)' }} aria-label={`Suggestion for ${s.name || s.sid}`}>
      <div className="grid items-center gap-2.5" style={{ gridTemplateColumns: '1fr auto 1fr' }}>
        <div><b style={{ ...DISPLAY, fontSize: 18, color: 'var(--text-bright)' }}>{s.from}</b>
          <p style={{ ...MONO, fontSize: 11, color: 'var(--text-dim)' }}>busy {hrs(s.effect.from.before)} h → {hrs(s.effect.from.after)} h</p></div>
        <span style={{ ...MONO, color: 'var(--hx-accent)' }} aria-hidden>{s.name || s.sid} ⟶</span>
        <div><b style={{ ...DISPLAY, fontSize: 18, color: 'var(--text-bright)' }}>{s.to}</b>
          <p style={{ ...MONO, fontSize: 11, color: 'var(--text-dim)' }}>busy {hrs(s.effect.to.before)} h → {hrs(s.effect.to.after)} h</p></div>
      </div>
      <p className="text-sm" style={{ color: 'var(--text-bright)' }}>
        {s.kind === 'move' ? `Move ${s.name || s.sid} from ${s.from} to ${s.to}.` : `Change the HA rule${s.rule ? ` "${s.rule}"` : ''} so ${s.name || s.sid} prefers ${s.to}.`}
        <span className="sr-only"> Hours above the {m} line: {s.from} {hrs(s.effect.from.before)} to {hrs(s.effect.from.after)}, {s.to} {hrs(s.effect.to.before)} to {hrs(s.effect.to.after)}.</span>
      </p>
      <ul className="list-disc space-y-0.5 pl-5 text-[13px]" style={{ color: 'var(--text-soft)' }}>{s.why.map((w, i) => <li key={i}>{w}</li>)}</ul>
      {action}
    </article>
  )
}

export function MoveRow({ m, action }: { m: MoveRecord; action?: ReactNode }) {
  const t = m.startedAt ?? m.scheduledFor
  const tone = m.status === 'failed' ? 'var(--crit-soft)' : m.status === 'done' ? 'var(--text-bright)' : 'var(--text-soft)'
  return (
    <li className="border-l-2 py-1 pl-2.5" style={{ borderColor: m.status === 'failed' ? 'var(--crit)' : 'var(--hx-line)' }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm" style={{ color: tone }}>{moveTitle(m)}</span>
        {action}
      </div>
      <p style={{ ...MONO, fontSize: 11, color: 'var(--text-dim)' }}>
        {t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : ''}{m.by ? ` · ${m.by}` : ''}{m.status === 'done' || m.status === 'failed' ? ` · ${corosyncLine(m)}` : ''}
      </p>
      {m.error && <p className="text-[13px]" style={{ color: 'var(--text-soft)' }}>{m.error}</p>}
      {m.status === 'scheduled' && <p className="text-[13px]" style={{ color: 'var(--text-dim)' }}>Checked again before it runs. Scheduled moves expire after 7 days.</p>}
    </li>
  )
}
