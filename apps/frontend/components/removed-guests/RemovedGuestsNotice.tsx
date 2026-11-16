'use client'

// =============================================================================
//  HyperProx — the Removed guests notice
//
//  On the dashboard (every removed guest) and on each page that still holds
//  something for one (a plug-in page shows only its own). One sentence per
//  guest — "<name> (container <id>) was removed from Proxmox on <date>.
//  HyperProx still has: …" — and one Clean up. Clean up shows exactly what goes
//  first: HyperProx's records and vault items, the cluster's config line by line
//  (each backup job's new guest list; a job that would back up nothing is only
//  deleted when ticked), and, unticked, the proxy host and DNS name its install
//  made. Admins only; the clean-up asks for the master password again.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { GhostButton, Modal, Notice, PrimaryButton } from '@/components/vault/ui'
import { Icon, Panel, Pill } from '@/components/visual/kit'
import { forPlugin, guestWord, jobLine, plan, resultSummary, type CleanResult, type Holding, type RemovedGuest } from './logic'

const API = '/api/removed-guests'

const ROW: React.CSSProperties = { display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 14px', borderRadius: 8, border: '1px solid var(--border-soft)', borderLeft: '3px solid var(--warn)', background: 'var(--ground-deep)' }
const SMALL: React.CSSProperties = { color: 'var(--text-dimmer)', fontSize: 12.5 }
const MONO: React.CSSProperties = { fontFamily: 'var(--font-mono, "IBM Plex Mono", monospace)', fontSize: 12.5 }

/** One removed guest: the sentence, and its Clean up button. Exported for the tests. */
export function RemovedGuestRow({ g, onClean }: { g: RemovedGuest; onClean?: (g: RemovedGuest) => void }) {
  return (
    <article style={ROW} aria-label={`${g.name ?? `Guest ${g.vmid}`}, removed`}>
      <span style={{ color: 'var(--warn)', marginTop: 2 }} aria-hidden><Icon name="warn" size={18} /></span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-sm" style={{ color: 'var(--text-soft)', margin: 0 }}>{g.words}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone="warn">{guestWord(g)} {g.vmid}</Pill>
          {g.dateFrom === 'noticed' && <small style={SMALL}>HyperProx found it missing; the removal date is not in Proxmox&apos;s task log any more.</small>}
          {g.reused && <small style={SMALL}>ID {g.vmid} now belongs to {g.reused.name}, which is left alone.</small>}
          {g.unread.length > 0 && <small style={SMALL}>Not read this time: {g.unread.join(', ')}.</small>}
          {onClean && <span className="ml-auto"><PrimaryButton type="button" onClick={() => onClean(g)}>Clean up</PrimaryButton></span>}
        </div>
      </div>
    </article>
  )
}

function Item({ h }: { h: Holding }) {
  return (
    <li className="text-sm" style={{ color: 'var(--text-soft)' }}>
      {h.label}: <span style={{ color: 'var(--text-muted)' }}>{h.change}</span>
      {h.job && <div style={{ ...MONO, color: 'var(--text-bright)' }}>{h.job.id}: {jobLine(h)}</div>}
    </li>
  )
}

/** What Clean up will do, with the two choices that are the person's. Exported for the tests. */
export function CleanUpChoices({ g, published, onPublished, deleteJobs, onDeleteJob }: {
  g: RemovedGuest; published: boolean; onPublished: (v: boolean) => void; deleteJobs: string[]; onDeleteJob: (id: string, on: boolean) => void
}) {
  const p = plan(g)
  return (
    <div className="flex flex-col gap-4">
      {p.records.length > 0 && (
        <section>
          <h3 className="font-display text-[15px] font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--accent)' }}>HyperProx&apos;s own records</h3>
          <ul className="mt-2 flex flex-col gap-1.5 pl-4" style={{ listStyle: 'disc' }}>{p.records.map(h => <Item key={h.id} h={h} />)}</ul>
          {p.vault.length > 0 && <p className="mt-2" style={SMALL}>Vault items deleted with them: {p.vault.join(', ')}.</p>}
        </section>
      )}
      {p.cluster.length > 0 && (
        <section>
          <h3 className="font-display text-[15px] font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--accent)' }}>The cluster&apos;s config</h3>
          <ul className="mt-2 flex flex-col gap-1.5 pl-4" style={{ listStyle: 'disc' }}>{p.cluster.map(h => <Item key={h.id} h={h} />)}</ul>
          <p className="mt-2" style={SMALL}>Only ID {g.vmid} is taken out; every other guest in each job stays exactly as it is. Written through the Proxmox API, then read back.</p>
          {p.emptyJobs.map(id => (
            <label key={id} className="mt-2 flex items-start gap-2 text-sm" style={{ color: 'var(--text-soft)' }}>
              <input type="checkbox" checked={deleteJobs.includes(id)} onChange={e => onDeleteJob(id, e.target.checked)} />
              <span><b>Delete backup job {id}</b> · it backs up only this guest, so without it the job would back up nothing. Left unticked, the job is kept as it is.</span>
            </label>
          ))}
        </section>
      )}
      {p.published.length > 0 && (
        <section>
          <h3 className="font-display text-[15px] font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--accent)' }}>Its public name</h3>
          <label className="mt-2 flex items-start gap-2 text-sm" style={{ color: 'var(--text-soft)' }}>
            <input type="checkbox" checked={published} onChange={e => onPublished(e.target.checked)} />
            <span>
              <b>Also remove the proxy host and DNS record its install made</b>
              <ul className="mt-1 pl-4" style={{ listStyle: 'disc' }}>{p.published.map(h => <li key={h.id}>{h.label.replace(/^What its install published: /, '')}</li>)}</ul>
              <small style={SMALL}>Leave this unticked to keep the name for a new install.</small>
            </span>
          </label>
        </section>
      )}
    </div>
  )
}

export function CleanUpResults({ results }: { results: CleanResult[] }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm" style={{ color: results.some(r => r.outcome === 'failed') ? 'var(--warn-2)' : 'var(--good)' }}>{resultSummary(results)}</p>
      <ul className="flex flex-col gap-1 pl-4" style={{ listStyle: 'disc' }}>
        {results.map(r => <li key={r.id} className="text-sm" style={{ color: r.outcome === 'failed' ? 'var(--warn-2)' : 'var(--text-soft)' }}>{r.words}</li>)}
      </ul>
    </div>
  )
}

function CleanUpDialog({ g, onClose, onDone }: { g: RemovedGuest; onClose: () => void; onDone: () => void }) {
  const [published, setPublished] = useState(false)
  const [deleteJobs, setDeleteJobs] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<CleanResult[] | null>(null)
  const [reconfirm, setReconfirm] = useState(false)

  const run = async () => {
    setBusy(true); setError(null)
    const r = await apiJson<{ data: { results: CleanResult[] } }>(`${API}/${g.vmid}/clean-up`, 'POST', { published, deleteEmptyJobs: deleteJobs })
    setBusy(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(true); return }
    if (!r.ok) { setError(r.error ?? 'The clean-up did not work.'); return }
    setResults(r.body!.data.results)
    onDone()
  }

  return (
    <Modal title={`Clean up after ${g.name ?? `guest ${g.vmid}`}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {results ? <CleanUpResults results={results} /> : (
          <>
            <p className="text-sm" style={{ color: 'var(--text-soft)' }}>{g.name ?? `Guest ${g.vmid}`} ({guestWord(g)} {g.vmid}) is no longer on the cluster. This removes what HyperProx still keeps for it:</p>
            <CleanUpChoices g={g} published={published} onPublished={setPublished} deleteJobs={deleteJobs}
              onDeleteJob={(id, on) => setDeleteJobs(cur => on ? [...cur.filter(x => x !== id), id] : cur.filter(x => x !== id))} />
          </>
        )}
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <GhostButton type="button" onClick={onClose}>{results ? 'Close' : 'Cancel'}</GhostButton>
          {!results && <PrimaryButton type="button" disabled={busy} onClick={() => void run()}>{busy ? 'Cleaning up…' : 'Clean up'}</PrimaryButton>}
        </div>
      </div>
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(false)} onDone={() => { setReconfirm(false); void run() }} />}
    </Modal>
  )
}

/**
 * The notice. Renders nothing for a non-admin, while loading, when the list cannot be read, or when there is nothing
 * to clean up: it is additive and never takes a page down.
 */
export function RemovedGuestsNotice({ plugin }: { plugin?: string }) {
  const { role } = useSession()
  const admin = atLeast(role, 'admin')
  const [guests, setGuests] = useState<RemovedGuest[]>([])
  const [open, setOpen] = useState<RemovedGuest | null>(null)

  const load = useCallback(async () => {
    const r = await apiJson<{ data: { guests: RemovedGuest[] } }>(API)
    if (r.ok && r.body?.data) setGuests(r.body.data.guests)
  }, [])

  useEffect(() => { if (admin) void load() }, [admin, load])

  const list = forPlugin(guests, plugin)
  if (!admin || !list.length) return null
  return (
    <Panel title="Removed guests" sub={`${list.length} gone from Proxmox`} label="Removed guests">
      <div className="flex flex-col gap-3">
        {list.map(g => <RemovedGuestRow key={g.vmid} g={g} onClean={setOpen} />)}
      </div>
      {open && <CleanUpDialog g={open} onClose={() => setOpen(null)} onDone={() => void load()} />}
    </Panel>
  )
}
