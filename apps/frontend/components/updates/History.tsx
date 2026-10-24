'use client'

import { Fragment, useState } from 'react'
import type { UpdatesJob } from '@hyperprox/types'
import { Badge, Chevron, Empty, TH, THEAD_STYLE, fmtTime } from './ui'
import { PlanList } from './PlanList'
import { StepList } from './JobPanel'

const TONE: Record<string, 'accent' | 'good' | 'warn' | 'crit' | 'muted'> = {
  'planned': 'muted', 'awaiting-confirm': 'warn', 'running': 'accent', 'paused': 'warn', 'failed': 'crit', 'done': 'good', 'cancelled': 'muted',
}

/**
 * A finished dry run whose preflight failed is "done" to the API, but what it found is that a real run
 * would stop. Read it from the preflight step when the steps are loaded, else from the report summary.
 */
function dryRunWouldStop(j: UpdatesJob): boolean {
  if (j.trigger !== 'dry-run' || j.status !== 'done') return false
  const pre = j.steps?.find(s => s.action === 'preflight')
  if (pre) return pre.status === 'failed'
  return /preflight would stop/.test(j.report?.summary ?? '')
}

/** `detail` is the full job when it has been fetched: the list endpoint may omit steps. */
export function History({ jobs, detail, expanded, onToggle }: {
  jobs: UpdatesJob[]
  detail: Record<string, UpdatesJob>
  expanded: string | null
  onToggle: (id: string) => void
}) {
  const [showSteps, setShowSteps] = useState(false)
  if (!jobs.length) return <Empty>No runs yet.</Empty>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr style={THEAD_STYLE}>
            <th scope="col" className={TH}><span className="sr-only">Expand</span></th>
            <th scope="col" className={TH}>STARTED</th>
            <th scope="col" className={TH}>TRIGGER</th>
            <th scope="col" className={TH}>STATUS</th>
            <th scope="col" className={TH}>SUMMARY</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map(j => {
            const open = expanded === j.id
            const full = detail[j.id] ?? j
            const r = full.report
            return (
              <Fragment key={j.id}>
                <tr style={{ borderBottom: '1px solid var(--border-dim)' }}>
                  <td className="px-4 py-2.5">
                    <button type="button" onClick={() => onToggle(j.id)} aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} report for run started ${fmtTime(j.startedAt)}`} style={{ color: 'var(--text-muted)' }}>
                      <Chevron open={open} />
                    </button>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs" style={{ color: 'var(--text-soft)' }}>{fmtTime(j.startedAt)}</td>
                  <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-soft)' }}>{j.trigger}</td>
                  <td className="px-4 py-2.5">
                    {dryRunWouldStop(full)
                      ? <Badge tone="warn">would stop</Badge>
                      : <Badge tone={TONE[j.status] ?? 'muted'}>{j.status}</Badge>}
                  </td>
                  <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-muted)' }}>{j.report?.summary ?? '—'}</td>
                </tr>
                {open && (
                  <tr style={{ borderBottom: '1px solid var(--border-dim)', background: 'var(--ground-inset)' }}>
                    <td colSpan={5} className="space-y-4 px-5 py-4">
                      {r ? (
                        <div className="grid gap-4 md:grid-cols-3">
                          <ReportList title="Changed" empty="Nothing changed."
                                      items={r.changed.map(c => ({ k: c.target, v: `${c.packages} package${c.packages === 1 ? '' : 's'}` }))} />
                          <ReportList title="Skipped" empty="Nothing skipped."
                                      items={r.skipped.map(c => ({ k: c.target, v: c.reason }))} />
                          <ReportList title="Reboots pending" empty="None."
                                      items={r.rebootsPending.map(t => ({ k: t, v: '' }))} />
                        </div>
                      ) : (
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          {full.status === 'done' || full.status === 'failed' || full.status === 'cancelled' ? 'No report was written for this run.' : 'No report yet.'}
                        </p>
                      )}
                      {full.status === 'planned' || full.trigger === 'dry-run' || !full.steps?.length
                        ? <PlanList plan={full.plan} />
                        : (
                          <div className="space-y-2">
                            <button type="button" className="text-xs underline-offset-2 hover:underline" aria-expanded={showSteps}
                                    onClick={() => setShowSteps(s => !s)} style={{ color: 'var(--text-soft)' }}>
                              {showSteps ? 'Hide steps' : `Show ${full.steps.length} steps`}
                            </button>
                            {showSteps && <StepList steps={full.steps} />}
                          </div>
                        )}
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ReportList({ title, items, empty }: { title: string; items: { k: string; v: string }[]; empty: string }) {
  return (
    <div>
      <h3 className="mb-1 font-mono" style={{ fontSize: 11, letterSpacing: '0.1em', color: 'var(--text-dimmer)' }}>{title.toUpperCase()}</h3>
      {items.length === 0 ? <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{empty}</p> : (
        <ul className="space-y-0.5 text-xs">
          {items.map((i, n) => (
            <li key={n}><span className="font-mono" style={{ color: 'var(--text-bright)' }}>{i.k}</span>{i.v && <span style={{ color: 'var(--text-muted)' }}> — {i.v}</span>}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
