'use client'

import type { UpdatesPkgChange } from '@hyperprox/types'

export function PkgList({ pkgs }: { pkgs: UpdatesPkgChange[] }) {
  if (!pkgs.length) return <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Nothing pending.</p>
  return (
    <ul className="grid gap-x-6 gap-y-0.5 font-mono text-xs sm:grid-cols-2 lg:grid-cols-3">
      {pkgs.map(p => (
        <li key={p.name} className="truncate" title={`${p.name} ${p.from ?? 'new'} -> ${p.to}`}>
          <span style={{ color: 'var(--text-bright)' }}>{p.name}</span>{p.security && <span style={{ color: 'var(--crit-2)' }}> security</span>}{' '}
          <span style={{ color: 'var(--text-dim)' }}>{p.from ?? 'new'} → </span>
          <span style={{ color: 'var(--accent)' }}>{p.to}</span>
        </li>
      ))}
    </ul>
  )
}

/** The first few packages and a count of the rest; "+N more" shows them all, in place. */
export function PkgSummary({ pkgs, head, more, open, onToggle }: {
  pkgs: UpdatesPkgChange[]; head: UpdatesPkgChange[]; more: number; open: boolean; onToggle: () => void
}) {
  if (!pkgs.length) return <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Nothing pending.</p>
  return (
    <div className="space-y-1.5">
      <PkgList pkgs={open ? pkgs : head} />
      {more > 0 && (
        <button type="button" onClick={onToggle} aria-expanded={open} className="font-mono text-xs" style={{ color: 'var(--accent)' }}>
          {open ? 'Show fewer' : `+${more} more`}
        </button>
      )}
    </div>
  )
}
