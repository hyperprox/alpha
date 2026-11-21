'use client'

// =============================================================================
//  HyperProx — the Immich plug-in page
//
//  A visual page, phone first: the library (photos and videos and how the storage splits), who uses how much, the
//  server's version and whether an update exists, and every job queue as a bar. A queue that is paused or holds failed
//  jobs is a problem with a fix button; the fix is confirmed first (the server enforces it and says in words what it
//  will do) and read back after. Admin only: it names Immich's users.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { BusyNote, Notice } from '@/components/vault/ui'
import { HudHeader, Icon, Panel, Pill, styles as vs } from '@/components/visual/kit'
import { PluginSwitcher } from '@/components/plugins/visual/plugin-kit'
import { headline, photoShare, plural, queueFill, queueOrder, size, type Overview, type Problem, type QueueRow } from './logic'

const API = '/api/plugins/immich'

export function Bar({ value, tone = 'var(--hx-accent)', label }: { value: number; tone?: string; label: string }) {
  return (
    <div role="img" aria-label={label} style={{ height: 8, borderRadius: 4, background: 'var(--ground-inset)', overflow: 'hidden' }}>
      <div style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`, height: '100%', background: tone }} />
    </div>
  )
}

/** Problems, worst first, each with its fix. */
export function ProblemList({ problems, busy, onFix }: { problems: Problem[]; busy: string | null; onFix: (p: Problem) => void }) {
  if (!problems.length) return <p className="text-sm" style={{ color: 'var(--good)' }}><Icon name="check" size={14} /> No problems: every queue is running and nothing has failed.</p>
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {problems.map(p => (
        <li key={p.id} data-sev={p.severity} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <Icon name={p.severity === 'bad' ? 'error' : 'warn'} size={18} label={p.severity === 'bad' ? 'Problem' : 'Warning'} />
          <div style={{ flex: 1, minWidth: 200 }}><b>{p.title}</b><p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--text-dim)' }}>{p.detail}</p></div>
          {p.fix && <button type="button" className={`${vs.btn} ${p.severity === 'bad' ? vs.btnPri : ''}`} disabled={busy === p.id} onClick={() => onFix(p)}>{busy === p.id ? 'Working…' : p.fix.label}</button>}
        </li>
      ))}
    </ul>
  )
}

export function QueueList({ queues }: { queues: QueueRow[] }) {
  if (!queues.length) return <p className="text-sm" style={{ color: 'var(--text-dim)' }}>Immich reported no queues.</p>
  return (
    <ul aria-label="Job queues" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill,minmax(min(260px,100%),1fr))' }}>
      {queueOrder(queues).map(q => (
        <li key={q.name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <b style={{ fontSize: 14 }}>{q.label}</b>
            <span style={{ fontSize: 12, color: q.failed ? 'var(--crit-soft)' : q.paused ? 'var(--warn-2)' : 'var(--text-dim)' }}>
              {q.failed ? `${q.failed} failed` : q.paused ? 'paused' : q.active ? `${q.active} running` : q.waiting ? `${q.waiting} waiting` : 'idle'}
            </span>
          </span>
          <Bar value={queueFill(q)} tone={q.failed ? 'var(--crit)' : q.paused ? 'var(--warn)' : 'var(--hx-accent)'} label={`${q.label}: ${q.active} running, ${q.waiting} waiting, ${q.failed} failed`} />
        </li>
      ))}
    </ul>
  )
}

export function ImmichPage() {
  const { role } = useSession()
  const admin = atLeast(role, 'admin')
  const [o, setO] = useState<Overview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null)

  const load = useCallback(async () => {
    const r = await apiJson<{ data: Overview }>(`${API}/overview`)
    if (r.ok) { setO(r.body!.data); setError(null) } else setError(r.error ?? 'Could not read Immich.')
  }, [])
  useEffect(() => { if (admin) void load() }, [admin, load])

  if (!admin) return (
    <div className={vs.page}><PluginSwitcher current="immich" />
      <Notice kind="info">The Immich plug-in page needs the admin role: it names Immich&apos;s users and what each stores. The card on the Plug-ins page shows the totals.</Notice></div>
  )

  // The server asks for the confirmation (apiJson shows it, with the sentence the server wrote) and audits before it acts.
  const fix = async (p: Problem) => {
    if (!p.fix) return
    setBusy(p.id); setNote(null)
    const r = await apiJson<{ data: { message: string } }>(`${API}/actions`, 'POST', { action: p.fix.action, queue: p.fix.queue })
    setBusy(null)
    setNote(r.ok ? { text: r.body!.data.message, ok: true } : { text: r.error ?? 'Nothing was changed.', ok: false })
    await load()
  }

  const chips = o ? [
    { label: 'photos', value: o.photos.toLocaleString('en-US'), tone: 'accent' as const },
    { label: 'videos', value: o.videos.toLocaleString('en-US'), tone: 'accent' as const },
    { label: 'used', value: size(o.bytes), tone: 'dim' as const },
    { label: 'problems', value: o.problems.length, tone: o.problems.some(p => p.severity === 'bad') ? 'crit' as const : o.problems.length ? 'warn' as const : 'good' as const },
  ] : [{ label: 'reading', value: '…', tone: 'dim' as const }]

  return (
    <div className={vs.page}>
      <PluginSwitcher current="immich" />
      <HudHeader eyebrow="Plug-in · Photos" title="Immich" icon="cloud" chips={chips}
        ring={o ? { value: photoShare(o), text: `${Math.round(photoShare(o) * 100)}%`, label: 'photos by size' } : undefined} />
      {error && <Notice kind="error">{error}{' '}<a href="/catalogue?recipe=immich" style={{ color: 'var(--hx-accent)' }}>Install Immich from the Catalogue</a></Notice>}
      {!o && !error && <BusyNote>Reading Immich…</BusyNote>}
      {note && <p className="text-sm" role="status" style={{ color: note.ok ? 'var(--good)' : 'var(--warn-2)' }}>{note.text}</p>}
      {o && (
        <>
          <Panel title="What needs you" sub={headline(o)}><ProblemList problems={o.problems} busy={busy} onFix={p => void fix(p)} /></Panel>
          <Panel title="Server" sub={o.version ?? 'unknown version'}>
            <p className="text-sm" style={{ margin: 0, color: 'var(--text-soft)' }}>
              {o.update.available ? <><Pill tone="warn">update</Pill> {o.update.latest} is available. Upgrade by changing the version in its compose folder.</> : <><Pill tone="good">up to date</Pill> {o.update.checkedAt ? 'Checked by Immich itself.' : 'Immich has not checked for a newer release yet.'}</>}
            </p>
          </Panel>
          <Panel title="Job queues" sub={`${o.queues.length} queues`}><QueueList queues={o.queues} /></Panel>
          <Panel title="Who uses what" sub={plural(o.users.length, 'user')}>
            {o.users.length === 0 ? <p className="text-sm" style={{ color: 'var(--text-dim)' }}>No users yet.</p> : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {o.users.map(u => (
                  <li key={u.name}>
                    <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 14 }}><b>{u.name}</b><span style={{ color: 'var(--text-dim)' }}>{u.photos.toLocaleString('en-US')} photos · {u.videos.toLocaleString('en-US')} videos · {size(u.bytes)}</span></span>
                    <Bar value={o.bytes > 0 ? u.bytes / o.bytes : 0} label={`${u.name} uses ${size(u.bytes)} of ${size(o.bytes)}`} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </div>
  )
}
