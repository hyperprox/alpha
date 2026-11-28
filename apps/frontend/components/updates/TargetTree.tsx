'use client'

import { Fragment, useMemo, useState } from 'react'
import type { UpdatesTarget } from '@hyperprox/types'
import { styles } from '@/components/visual/kit'
import { forest, tickState, toggle, cascade, helperSelection, type Forest, type Helper, type Tick } from '@/lib/update-targets'
import { Badge, Btn, Chevron } from './ui'
import { PkgList } from './PkgList'

const KIND_WORD: Record<string, string> = {
  'ceph': 'Ceph', 'node': 'node', 'node-pkg': 'package', 'node-reboot': 'reboot', 'guest': 'guest', 'guest-pkg': 'package',
  'compose': 'compose project', 'app': 'app', 'app-fix': 'config change',
}

/** The box: a real checkbox, partly ticked when some of what it covers is chosen. */
function TickBox({ state, label, disabled, onChange }: { state: Tick; label: string; disabled?: boolean; onChange: () => void }) {
  if (state === 'none') return <span className="inline-block w-4" aria-hidden />
  return (
    <input type="checkbox" aria-label={label} checked={state === 'on'} disabled={disabled}
           aria-checked={state === 'some' ? 'mixed' : state === 'on'} data-tick={state}
           ref={el => { if (el) el.indeterminate = state === 'some' }}
           onChange={onChange} className="h-4 w-4 shrink-0 accent-[var(--accent)]" />
  )
}

function Preview({ t }: { t: UpdatesTarget }) {
  return (
    <div className="space-y-2">
      {t.packages && t.packages.length > 0 && <PkgList pkgs={t.packages} />}
      {t.images && t.images.length > 0 && (
        <ul className="space-y-0.5 font-mono text-xs">
          {t.images.map(i => (
            <li key={i.image} className="truncate" title={`${i.image} ${i.current} → ${i.latest ?? 'unknown'}`}>
              <span style={{ color: 'var(--text-bright)' }}>{i.image}</span>{' '}
              {i.latest && i.latest !== i.current
                ? <><span style={{ color: 'var(--text-dim)' }}>{i.current.slice(0, 19)} → </span><span style={{ color: 'var(--accent)' }}>{i.latest.slice(0, 19)}</span></>
                : <span style={{ color: 'var(--text-dim)' }}>{i.latest ? 'current' : 'newest not known'}</span>}
            </li>
          ))}
        </ul>
      )}
      {t.notes?.map((n, i) => <p key={i} className="text-xs" style={{ color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{n}</p>)}
      {t.blocked && <p className="text-xs" style={{ color: 'var(--warn-2)' }}>Not offered: {t.blocked}</p>}
    </div>
  )
}

/** Default open: Ceph and the nodes, so every guest shows under its node; a guest's own rows open on request. */
const openByDefault = (t: UpdatesTarget) => t.kind === 'node' || t.kind === 'ceph'

export function TargetRows({ f, rows, depth, chosen, open, disabled, onToggle, onOpen, onUpdateThis }: {
  f: Forest; rows: UpdatesTarget[]; depth: number; chosen: Set<string>; open: Record<string, boolean>; disabled?: boolean
  onToggle: (id: string) => void; onOpen: (id: string) => void; onUpdateThis: (ids: string[]) => void
}) {
  return (
    <>
      {rows.map(t => {
        const kids = f.kids.get(t.id) ?? []
        const isOpen = open[t.id] ?? openByDefault(t)
        const hasMore = kids.length > 0 || !!t.packages?.length || !!t.images?.length || !!t.notes?.length || !!t.blocked
        const state = tickState(f, t.id, chosen)
        const ids = cascade(f, t.id)
        const muted = state === 'none'
        // The preview under an open row: its packages (unless they are its own rows below), images and notes.
        const pkgs = kids.some(k => k.kind.endsWith('pkg')) ? [] : (t.packages ?? [])
        const pv = !t.kind.endsWith('pkg') && (pkgs.length || t.images?.length || t.notes?.length || (t.blocked && !muted)) ? { ...t, packages: pkgs } : null
        return (
          <Fragment key={t.id}>
            <li role="treeitem" aria-level={depth + 1} aria-expanded={hasMore ? isOpen : undefined} aria-selected={state === 'on'}
                data-target={t.id} data-kind={t.kind}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5"
                style={{ paddingLeft: 12 + depth * 20, borderBottom: '1px solid var(--border-dim)', opacity: muted && !t.pending ? 0.7 : 1 }}>
              <TickBox state={state} disabled={disabled} label={`Choose ${KIND_WORD[t.kind] ?? t.kind} ${t.label}`} onChange={() => onToggle(t.id)} />
              {hasMore
                ? <button type="button" onClick={() => onOpen(t.id)} aria-label={`${isOpen ? 'Hide' : 'Show'} ${t.label}`} style={{ color: 'var(--text-muted)' }}><Chevron open={isOpen} /></button>
                : <span className="inline-block w-3" aria-hidden />}
              <span className="min-w-0 flex-1">
                <span className={t.kind === 'node' || t.kind === 'ceph' ? 'font-semibold' : t.kind.endsWith('pkg') ? 'font-mono text-xs' : 'text-sm'}
                      style={{ color: muted ? 'var(--text-muted)' : 'var(--text-bright)' }}>{t.label}</span>
                {t.sub && <span className="ml-2 text-xs" style={{ color: 'var(--text-muted)' }}>{t.sub}</span>}
                {muted && t.blocked && (t.kind === 'guest' || t.kind === 'node' || t.kind.endsWith('pkg')) && (
                  <span className="ml-2 text-xs" style={{ color: 'var(--text-dim)' }} data-blocked>{t.blocked}</span>
                )}
              </span>
              <span className="flex flex-wrap items-center gap-1">
                {t.pending > 0 && t.kind !== 'node-pkg' && t.kind !== 'guest-pkg' && <Badge tone="warn" title={`${t.pending} update${t.pending === 1 ? '' : 's'}`}>{t.pending}</Badge>}
                {t.security > 0 && <Badge tone="crit" title="From a security suite">{t.kind.endsWith('pkg') ? 'security' : `${t.security} security`}</Badge>}
                {t.needsReboot && <Badge tone="warn" title="It asks for a reboot">needs reboot</Badge>}
                {ids.length > 0 && (
                  <Btn small onClick={() => onUpdateThis(ids)} disabled={disabled}
                       aria-label={t.kind === 'node-reboot' ? `Reboot ${t.node ?? t.label} with HA maintenance` : `Update ${t.label}`}>
                    {t.kind === 'node-reboot' ? 'Reboot' : 'Update this'}
                  </Btn>
                )}
              </span>
            </li>
            {isOpen && hasMore && (
              <>
                {pv && (
                  <li role="none" className="px-3 py-2" style={{ paddingLeft: 44 + depth * 20, background: 'var(--ground-inset)', borderBottom: '1px solid var(--border-dim)' }}>
                    <Preview t={pv} />
                  </li>
                )}
                {kids.length > 0 && (
                  <TargetRows f={f} rows={kids} depth={depth + 1} chosen={chosen} open={open} disabled={disabled}
                              onToggle={onToggle} onOpen={onOpen} onUpdateThis={onUpdateThis} />
                )}
              </>
            )}
          </Fragment>
        )
      })}
    </>
  )
}

const HELPERS: [Helper, string][] = [
  ['everything', 'Everything'], ['guests', 'All guests'], ['containers', 'All compose projects'], ['nodes', 'All nodes'], ['security', 'Security updates'], ['none', 'Clear'],
]

/**
 * Everything that can be updated, under its cluster: Ceph, each node (its packages, its reboot when one is due) and
 * each guest under its node (its packages, compose projects and apps). Tick any mix, then "Update selected"; or
 * "Update this" on one row. A reboot is only ever chosen on its own row.
 */
export function TargetTree({ targets, clusterName, chosen, onChange, onUpdate, disabled }: {
  targets: UpdatesTarget[]
  clusterName: string
  chosen: Set<string>
  onChange: (next: Set<string>) => void
  /** Show the order for these ids, then run them. */
  onUpdate: (ids: string[]) => void
  disabled?: boolean
}) {
  const f = useMemo(() => forest(targets), [targets])
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const total = targets.filter(t => t.kind === 'node' || t.kind === 'guest' || t.kind === 'ceph').reduce((n, t) => n + t.pending, 0)
  const nodeRows = targets.filter(t => t.kind === 'node')
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Select:</span>
        {HELPERS.map(([h, label]) => (
          <Btn key={h} small disabled={disabled} onClick={() => onChange(new Set(h === 'none' ? [] : [...chosen, ...helperSelection(targets, h)]))}>{label}</Btn>
        ))}
        <span className="ml-auto flex items-center gap-2">
          <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }} data-chosen-count>{chosen.size} chosen</span>
          <Btn kind="primary" disabled={disabled || !chosen.size} onClick={() => onUpdate([...chosen])}>Update selected</Btn>
        </span>
      </div>
      <div className={styles.tableWrap}>
        <ul role="tree" aria-label={`Update targets on ${clusterName}`} aria-multiselectable="true" className="text-sm">
          <li role="none" className="flex items-center gap-3 px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
            <span className="font-display font-semibold" style={{ color: 'var(--text-bright)' }}>{clusterName}</span>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{nodeRows.length} node{nodeRows.length === 1 ? '' : 's'} · {total} update{total === 1 ? '' : 's'} pending</span>
          </li>
          <TargetRows f={f} rows={f.roots} depth={0} chosen={chosen} open={open} disabled={disabled}
                      onToggle={id => onChange(toggle(f, id, chosen))}
                      onOpen={id => setOpen(o => ({ ...o, [id]: !(o[id] ?? openByDefault(f.byId.get(id)!)) }))}
                      onUpdateThis={onUpdate} />
        </ul>
      </div>
    </div>
  )
}
