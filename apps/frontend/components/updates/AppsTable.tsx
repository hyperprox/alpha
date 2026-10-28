'use client'

import { Fragment, useState } from 'react'
import type { UpdatesApp, UpdatesGuest } from '@hyperprox/types'
import { Badge, Chevron, Notice, TH, THEAD_STYLE } from './ui'

// Apps installed outside apt and docker, found by plug-in providers. Nothing here changes a guest:
// ticking a box only adds an approval id to the next run, and the plan preview shows what that run
// would do with it. Config changes are approved separately, word for word.

type Row = { g: UpdatesGuest; a: UpdatesApp }

export function appRows(guests: UpdatesGuest[]): Row[] {
  return guests.flatMap(g => (g.apps ?? []).map(a => ({ g, a })))
    .sort((x, y) => Number(y.a.isSecurity && !!y.a.approvalId) - Number(x.a.isSecurity && !!x.a.approvalId) || x.g.vmid - y.g.vmid || x.a.name.localeCompare(y.a.name))
}

/** Every approval id the inventory currently offers, so stale ones can be dropped. */
export function offeredApprovals(guests: UpdatesGuest[]): Set<string> {
  const ids = new Set<string>()
  for (const { a } of appRows(guests)) {
    if (a.approvalId) ids.add(a.approvalId)
    for (const i of a.issues) if (i.fix) ids.add(i.fix.id)
  }
  return ids
}

const safeLink = (u?: string) => (u && /^https:\/\/github\.com\//.test(u) ? u : undefined)

function Check({ checked, onChange, disabled, label, children }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; children: React.ReactNode }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm" style={{ color: disabled ? 'var(--text-dimmer)' : 'var(--text-soft)' }}>
      <input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)}
             className="h-4 w-4" style={{ accentColor: 'var(--accent)' }} />
      {children}
    </label>
  )
}

export function AppsTable({ guests, approvals, onApprove, disabled }: {
  guests: UpdatesGuest[]
  approvals: string[]
  onApprove: (id: string, on: boolean) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const rows = appRows(guests)
  const has = (id: string) => approvals.includes(id)

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr style={THEAD_STYLE}>
            <th scope="col" className={TH}>GUEST</th>
            <th scope="col" className={TH}>APP</th>
            <th scope="col" className={TH}>VERSION</th>
            <th scope="col" className={TH}>STATE</th>
            <th scope="col" className={TH}>NEXT RUN</th>
            <th scope="col" className={TH}><span className="sr-only">Details</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ g, a }) => {
            const id = `${g.vmid}:${a.provider}:${a.key}`
            const update = !!a.latest && !!a.approvalId
            const blocking = a.issues.filter(i => i.blocking && !(i.fix && has(i.fix.id)))
            return (
              <Fragment key={id}>
                <tr style={{ borderBottom: '1px solid var(--border-dim)' }}>
                  <td className="px-4 py-2.5">
                    <span className="font-mono" style={{ color: 'var(--text-muted)' }}>{g.vmid}</span>{' '}
                    <span style={{ color: 'var(--text-soft)' }}>{g.name}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="font-semibold" style={{ color: 'var(--text-bright)' }}>{a.name}</span>
                    {a.error && <div className="mt-0.5 text-xs" style={{ color: 'var(--crit-soft)' }}>{a.error}</div>}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">
                    <span style={{ color: 'var(--text-soft)' }}>{a.installed}</span>
                    {a.latest && a.latest !== a.installed && <span style={{ color: a.isSecurity ? 'var(--crit-2)' : 'var(--warn)' }}> → {a.latest}</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {update && a.isSecurity && <Badge tone="crit" title={a.securityNote}>security update</Badge>}
                      {update && !a.isSecurity && <Badge tone="warn">update</Badge>}
                      {!update && a.latest && <Badge tone="good">current</Badge>}
                      {!a.running && <Badge tone="muted">not running</Badge>}
                      {a.issues.some(i => i.blocking) && <Badge tone="warn" title={a.issues.filter(i => i.blocking).map(i => i.message).join('\n')}>pre-flight</Badge>}
                      <Badge tone={a.mode === 'auto' ? 'accent' : 'muted'} title={a.mode === 'auto' ? 'Applied by every run, scheduled ones included' : a.mode === 'off' ? 'Reported, never applied' : 'Applied only when approved for a run'}>{a.mode}</Badge>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    {!update ? <span style={{ color: 'var(--text-dimmer)' }}>—</span>
                      : a.mode === 'off' ? <span className="text-xs" style={{ color: 'var(--text-muted)' }}>off by policy</span>
                      : a.mode === 'auto' ? <span className="text-xs" style={{ color: 'var(--accent)' }}>{blocking.length ? 'blocked by pre-flight' : 'included'}</span>
                      : <Check checked={has(a.approvalId!)} disabled={disabled} onChange={v => onApprove(a.approvalId!, v)} label={`Approve ${a.name} ${a.latest} on ${g.vmid}`}>
                          approve
                        </Check>}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button type="button" onClick={() => setOpen(o => ({ ...o, [id]: !o[id] }))} aria-expanded={!!open[id]}
                            aria-label={`Details for ${a.name} on ${g.vmid}`} className="inline-flex items-center gap-1 text-xs" style={{ color: 'var(--text-soft)' }}>
                      <Chevron open={!!open[id]} /> details
                    </button>
                  </td>
                </tr>
                {open[id] && (
                  <tr style={{ borderBottom: '1px solid var(--border-dim)', background: 'var(--ground-inset)' }}>
                    <td colSpan={6} className="space-y-3 px-4 py-3 text-sm">
                      <p style={{ color: 'var(--text-muted)' }}>{a.how}</p>
                      <p className="font-mono text-xs" style={{ color: 'var(--text-dim)' }}>
                        {a.location} · owner {a.runAs} · {a.service ?? 'no system unit'}
                      </p>
                      {a.isSecurity && a.securityNote && <Notice tone="crit">Security: {a.securityNote}</Notice>}

                      {a.issues.map((i, n) => (
                        <div key={n} className="space-y-2 rounded-md border p-3" style={{ borderColor: 'var(--border)' }}>
                          <div className="flex flex-wrap items-start gap-2">
                            <Badge tone={i.blocking ? 'warn' : 'muted'}>{i.blocking ? 'blocks the update' : 'note'}</Badge>
                            <span style={{ color: 'var(--text)' }}>{i.message}</span>
                          </div>
                          {i.fix && (
                            <div className="space-y-2">
                              <p style={{ color: 'var(--text-soft)' }}>{i.fix.description}. In <span className="font-mono">{i.fix.file}</span>:</p>
                              <pre className="overflow-auto rounded-md px-3 py-2 font-mono text-xs" style={{ background: 'var(--surface)', color: 'var(--text)' }}>{i.fix.change}</pre>
                              <Check checked={has(i.fix.id)} disabled={disabled} onChange={v => onApprove(i.fix!.id, v)} label={`Approve the config change for ${a.name} on ${g.vmid}`}>
                                Approve exactly this change for the next run (a separate step before the update)
                              </Check>
                            </div>
                          )}
                        </div>
                      ))}

                      {a.notes.length > 0 && (
                        <div className="space-y-1">
                          <p className="font-mono text-xs" style={{ color: 'var(--text-dimmer)', letterSpacing: '0.1em' }}>RELEASE NOTES</p>
                          {a.notes.map(note => (
                            <details key={note.version} className="rounded-md border px-3 py-1.5" style={{ borderColor: 'var(--border-dim)' }}>
                              <summary className="cursor-pointer font-mono text-xs" style={{ color: 'var(--text-bright)' }}>
                                {note.version}
                                {safeLink(note.url) && <> · <a href={safeLink(note.url)} target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--accent)' }}>release page</a></>}
                              </summary>
                              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs" style={{ color: 'var(--text)' }}>{note.text || '(no notes)'}</pre>
                            </details>
                          ))}
                        </div>
                      )}

                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}><span style={{ color: 'var(--text-soft)' }}>If it goes wrong:</span> {a.rollback}</p>
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
