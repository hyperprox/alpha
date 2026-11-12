'use client'

// =============================================================================
//  HyperProx — Proxmox Backup Server: managing backups (opt-in)
//
//  Off by default. When an admin turns it on (Settings, or when adding the
//  server), HyperProx keeps a second token on the server that may delete and
//  prune on the chosen datastores. Everything here goes through a preview the
//  server holds (single use, yours, ten minutes): it lists exactly what goes
//  and what stays (protected snapshots always stay), asks a second time before
//  a guest's last snapshot goes, and refuses while that guest's backup runs.
// =============================================================================

import { useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { BusyNote, GhostButton, INPUT, LABEL, Modal, Notice, PrimaryButton } from '@/components/vault/ui'
import { Sheet } from '@/components/plugins/home-assistant/HomeVisual'
import { styles as vs } from '@/components/visual/kit'

const API = '/api/plugins/pbs'

export const MANAGE_WARNING = 'Anyone who gets into HyperProx as an admin, with the master password, could then delete or prune backups on the chosen datastores. HyperProx keeps a second token for this (DatastoreAdmin on those datastores only, never on /); turning it off deletes that token on the server.'

interface Item { type: string; id: string; time: number; protected: boolean; size: number | null }
export interface ManagePreview {
  id: string; action: 'delete-snapshots' | 'delete-group' | 'prune'; store: string; ns: string
  remove: Item[]; kept: Array<Item & { why: 'protected' | 'kept' }>; lastSnapshot: string[]; acks: string[]
  keep?: { from: string; settings: Record<string, number> }; warnings: string[]; expiresAt: number
}

const at = (t: number) => new Date(t * 1000).toLocaleString()
const size = (b: number | null) => (b === null ? '' : b >= 1024 ** 3 ? ` · ${(b / 1024 ** 3).toFixed(1)} GiB` : ` · ${Math.round(b / 1024 ** 2)} MiB`)

/** POST with the master-password step when the gate asks for it. */
export function useReconfirmed() {
  const [retry, setRetry] = useState<null | (() => void)>(null)
  const call = async <T,>(path: string, method: string, body: unknown, onDone: (r: { ok: boolean; body?: T; error?: string; code?: string }) => void): Promise<void> => {
    const r = await apiJson<T>(path, method, body)
    if (r.status === 403 && r.code === 'reconfirm_required') { setRetry(() => () => void call(path, method, body, onDone)); return }
    onDone(r as any)
  }
  const modal = retry ? <ReconfirmModal onClose={() => setRetry(null)} onDone={() => { const f = retry; setRetry(null); f() }} /> : null
  return { call, modal }
}

/** The preview, then the apply: exactly what goes, what stays, and the second confirmation when it is the last. */
export function PreviewModal({ serverId, p, onClose, onDone }: { serverId: string; p: ManagePreview; onClose: () => void; onDone: (message: string) => void }) {
  const [last, setLast] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { call, modal } = useReconfirmed()
  const title = p.action === 'prune' ? `Prune ${p.store}` : p.action === 'delete-group' ? 'Delete a whole backup group' : 'Delete snapshots'
  const apply = () => {
    setBusy(true); setErr(null)
    void call<{ data: { message: string } }>(`${API}/instances/${serverId}/manage/apply`, 'POST', { previewId: p.id, acks: last ? ['last-snapshot'] : [] }, r => {
      setBusy(false)
      if (r.ok) onDone(r.body!.data.message); else setErr(r.error ?? 'Nothing was removed.')
    })
  }
  return (
    <Modal title={title} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {p.keep && <p className="text-sm" style={{ color: 'var(--text-soft)' }}>Keep settings from {p.keep.from}: {Object.entries(p.keep.settings).map(([k, v]) => `${k.replace('keep-', '')} ${v}`).join(', ')}. This is PBS&apos;s own dry-run: exactly this goes.</p>}
        <p className="font-semibold" style={{ color: p.remove.length ? 'var(--crit)' : 'var(--text-soft)' }}>{p.remove.length ? `${p.remove.length} snapshot${p.remove.length === 1 ? '' : 's'} will be deleted for good` : 'Nothing would be removed.'}</p>
        {p.remove.length > 0 && (
          <ul className="max-h-56 overflow-y-auto text-sm" style={{ color: 'var(--text)' }} aria-label="Deleted">
            {p.remove.map(s => <li key={`${s.type}/${s.id}/${s.time}`} className="font-mono text-[12px]">✕ {s.type}/{s.id} · {at(s.time)}{size(s.size)}</li>)}
          </ul>
        )}
        {p.kept.length > 0 && (
          <details><summary className="text-sm" style={{ color: 'var(--text-muted)' }}>{p.kept.length} kept ({p.kept.filter(k => k.why === 'protected').length} protected)</summary>
            <ul className="max-h-40 overflow-y-auto">{p.kept.map(s => <li key={`${s.type}/${s.id}/${s.time}`} className="font-mono text-[12px]" style={{ color: 'var(--good)' }}>✓ {s.type}/{s.id} · {at(s.time)} · {s.why === 'protected' ? 'protected, never deleted' : 'kept'}</li>)}</ul>
          </details>
        )}
        {p.warnings.map(w => <Notice key={w} kind="warn">{w}</Notice>)}
        {p.acks.includes('last-snapshot') && (
          <label className="flex items-start gap-2 rounded-md border p-3 text-sm" style={{ borderColor: 'var(--crit)', color: 'var(--text)' }}>
            <input type="checkbox" checked={last} onChange={e => setLast(e.target.checked)} />
            <span>I understand {p.lastSnapshot.join(', ')} will have <b>no backup left</b> on this server.</span>
          </label>
        )}
        <small style={{ color: 'var(--text-dimmer)' }}>This preview is yours, works once, and expires {new Date(p.expiresAt).toLocaleTimeString()}. Space returns at the next clean-up.</small>
        {err && <Notice kind="error">{err}</Notice>}
        <div className="flex justify-end gap-2">
          <GhostButton type="button" onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton type="button" style={{ background: 'var(--crit)' }} disabled={busy || !p.remove.length || (p.acks.includes('last-snapshot') && !last)} onClick={apply}>{busy ? 'Deleting…' : 'Delete'}</PrimaryButton>
        </div>
      </div>
      {modal}
    </Modal>
  )
}

/** One group's snapshots, to pick from; protected ones cannot be picked. */
export function GroupSheet({ serverId, store, ns, type, id, onClose, onPreview }: { serverId: string; store: string; ns: string; type: string; id: string; onClose: () => void; onPreview: (p: ManagePreview) => void }) {
  const [list, setList] = useState<Array<{ time: number; size: number | null; verify: string; protected: boolean }> | null>(null)
  const [pick, setPick] = useState<number[]>([])
  const [err, setErr] = useState<string | null>(null)
  const { call, modal } = useReconfirmed()
  useEffect(() => {
    void apiJson<{ data: any[] }>(`${API}/instances/${serverId}/snapshots?${new URLSearchParams({ store, ns, type, id })}`).then(r => (r.ok ? setList(r.body!.data) : setErr(r.error ?? 'Could not read the snapshots.')))
  }, [serverId, store, ns, type, id])
  const preview = (body: Record<string, unknown>) => void call<{ data: ManagePreview }>(`${API}/instances/${serverId}/manage/preview`, 'POST', { store, ns, ...body }, r => (r.ok ? onPreview(r.body!.data) : setErr(r.error ?? 'No preview.')))
  return (
    <Sheet title={`${type}/${id}`} sub={`${store}${ns ? ` / ${ns}` : ''}`} onClose={onClose}>
      {!list && !err && <BusyNote>Reading…</BusyNote>}
      {err && <Notice kind="error">{err}</Notice>}
      {list && (
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto" aria-label="Snapshots">
          {list.map(s => (
            <li key={s.time}>
              <label className="flex items-center gap-2 text-sm" style={{ color: s.protected ? 'var(--text-dimmer)' : 'var(--text)' }}>
                <input type="checkbox" disabled={s.protected} checked={pick.includes(s.time)} onChange={e => setPick(x => (e.target.checked ? [...x, s.time] : x.filter(t => t !== s.time)))} />
                <span className="font-mono text-[12px]">{at(s.time)}{size(s.size)} · verify {s.verify}{s.protected ? ' · protected' : ''}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className={vs.sheetRow}>
        <button type="button" className={vs.btn} onClick={onClose}>Close</button>
        <button type="button" className={vs.btn} disabled={!pick.length} onClick={() => preview({ action: 'delete-snapshots', items: pick.map(time => ({ type, id, time })) })}>Delete selected…</button>
        <button type="button" className={vs.btn} onClick={() => preview({ action: 'delete-group', group: { type, id } })}>Delete whole group…</button>
      </div>
      {modal}
    </Sheet>
  )
}

/** Prune now (a preview first) and Clean up now, for one datastore under management. */
export function StoreManageButtons({ serverId, store, onPreview, onNote }: { serverId: string; store: string; onPreview: (p: ManagePreview) => void; onNote: (n: { text: string; ok: boolean }) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const { call, modal } = useReconfirmed()
  return (
    <>
      <button type="button" className={vs.btn} disabled={busy !== null} onClick={() => { setBusy('prune'); void call<{ data: ManagePreview }>(`${API}/instances/${serverId}/manage/preview`, 'POST', { action: 'prune', store }, r => { setBusy(null); r.ok ? onPreview(r.body!.data) : onNote({ text: r.error ?? 'No preview.', ok: false }) }) }}>{busy === 'prune' ? 'Dry run…' : 'Prune now…'}</button>
      <button type="button" className={vs.btn} disabled={busy !== null} onClick={() => { setBusy('gc'); void call<{ data: { message: string } }>(`${API}/instances/${serverId}/manage/gc`, 'POST', { store }, r => { setBusy(null); onNote(r.ok ? { text: r.body!.data.message, ok: true } : { text: r.error ?? 'It did not start.', ok: false }) }) }}>{busy === 'gc' ? 'Starting…' : 'Clean up now'}</button>
      {modal}
    </>
  )
}

/** Settings: turn management on (datastores and an admin sign-in, used once) or off (deletes the manage token). */
export function ManageSettings({ serverId, manage, stores, onSaved }: { serverId: string; manage: { tokenId: string; stores: string[] } | null; stores: string[]; onSaved: () => void }) {
  const [f, setF] = useState({ username: 'root', realm: 'pam', password: '' })
  const [chosen, setChosen] = useState<string[]>(manage?.stores ?? stores)
  const [ok, setOk] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { call, modal } = useReconfirmed()
  const save = (enabled: boolean) => {
    setBusy(true); setErr(null)
    void call(`${API}/instances/${serverId}/manage`, 'PUT', { enabled, stores: chosen, ...f }, r => {
      setBusy(false); setF(x => ({ ...x, password: '' }))
      if (r.ok) onSaved(); else setErr(r.error ?? 'That did not work.')
    })
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3" style={{ borderColor: manage ? 'var(--crit)' : 'var(--border-strong)' }}>
      <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Backup management: {manage ? `on (${manage.stores.join(', ')})` : 'off (read-only)'}</span>
      <small style={{ color: 'var(--warn-2)' }}>{MANAGE_WARNING}</small>
      {!manage && (
        <>
          <span style={LABEL}>Datastores to manage</span>
          <div className="flex flex-wrap gap-3">{stores.map(s => (
            <label key={s} className="flex items-center gap-1 text-sm" style={{ color: 'var(--text)' }}><input type="checkbox" checked={chosen.includes(s)} onChange={e => setChosen(x => (e.target.checked ? [...x, s] : x.filter(y => y !== s)))} />{s}</label>
          ))}</div>
          <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--text)' }}><input type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} /><span>I understand the consequence above.</span></label>
        </>
      )}
      <div className="grid gap-2 sm:grid-cols-3">
        <label><span style={LABEL}>PBS admin user</span><input style={INPUT} autoCapitalize="none" value={f.username} onChange={e => setF(x => ({ ...x, username: e.target.value }))} /></label>
        <label><span style={LABEL}>Realm</span><select style={INPUT} value={f.realm} onChange={e => setF(x => ({ ...x, realm: e.target.value }))}><option value="pam">pam</option><option value="pbs">pbs</option></select></label>
        <label><span style={LABEL}>Password (used once)</span><input style={INPUT} type="password" autoComplete="off" value={f.password} onChange={e => setF(x => ({ ...x, password: e.target.value }))} /></label>
      </div>
      <small style={{ color: 'var(--text-dimmer)' }}>Making or deleting a token needs an admin sign-in; the password is used once and never stored.</small>
      {err && <Notice kind="error">{err}</Notice>}
      <div>{manage
        ? <GhostButton type="button" disabled={busy || !f.password} onClick={() => save(false)}>{busy ? 'Turning off…' : 'Turn off and delete the manage token'}</GhostButton>
        : <GhostButton type="button" disabled={busy || !f.password || !ok || !chosen.length} onClick={() => save(true)} style={{ color: 'var(--crit-soft)' }}>{busy ? 'Turning on…' : 'Turn on backup management'}</GhostButton>}</div>
      {modal}
    </div>
  )
}
