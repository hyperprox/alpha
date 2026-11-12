'use client'

// =============================================================================
//  HyperProx — Delete website
//
//  Asks the API for a preview of exactly what would go (POST /api/sites/<id>/
//  delete/preview), one checkbox per thing, ticked the way HyperProx's own
//  records say: what it made is ticked, what it cannot vouch for is not. The
//  site record is always on. An adopted site is "stop tracking" unless its DNS
//  or proxy host is ticked with its name typed out. The delete itself needs
//  the master password; after it, each item says what happened, and if any
//  did not go, "Preview again" retries only what is left.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'
import { INPUT, Modal } from '@/components/vault/ui'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { styles } from '@/components/visual/kit'

interface Item {
  key: string; kind: string; label: string; detail: string
  state: 'present' | 'gone' | 'unknown' | 'mismatch'
  offered: boolean; locked?: boolean; defaultOn: boolean; owned: boolean | null
  typed?: string; requires?: string; danger?: string; notes: string[]
}
interface Preview { id: string; siteName: string; adopted: boolean; items: Item[]; notes: string[]; expiresAt: number }
interface Result { key: string; kind: string; outcome: 'removed' | 'already-gone' | 'failed' | 'kept'; words: string }

const STATE_TAG: Record<Item['state'], string> = { present: '', gone: 'already gone', unknown: 'cannot check', mismatch: 'does not match' }
const OUTCOME: Record<Result['outcome'], string> = { removed: '✓ removed', 'already-gone': '✓ already gone', failed: '✕ not removed', kept: '• kept' }

export function DeleteSiteDialog({ siteId, onClose, onDone }: { siteId: string; onClose: () => void; onDone: () => void }) {
  const [p, setP] = useState<Preview | null>(null)
  const [err, setErr] = useState('')
  const [on, setOn] = useState<Record<string, boolean>>({})
  const [typed, setTyped] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [results, setResults] = useState<Result[] | null>(null)
  const [removed, setRemoved] = useState(false)

  const preview = useCallback(async () => {
    setErr(''); setResults(null); setP(null)
    const r = await apiJson<{ data: Preview }>(`/api/sites/${encodeURIComponent(siteId)}/delete/preview`, 'POST')
    if (!r.ok || !r.body) { setErr(r.error ?? 'The preview could not be made.'); return }
    const pv = r.body.data
    setP(pv)
    setOn(Object.fromEntries(pv.items.filter(i => i.offered).map(i => [i.key, i.defaultOn || !!i.locked])))
    setTyped({})
  }, [siteId])
  useEffect(() => { void preview() }, [preview])

  const tick = (it: Item, v: boolean) => setOn(o => {
    const n = { ...o, [it.key]: v }
    // A certificate goes only with its host: unticking the host unticks it.
    if (!v) for (const x of p?.items ?? []) if (x.requires === it.key) n[x.key] = false
    return n
  })
  const chosen = (p?.items ?? []).filter(i => i.offered && on[i.key])
  const typedOk = chosen.every(i => !i.typed || typed[i.key]?.trim().toLowerCase() === i.typed.toLowerCase())
  const onlyRecord = chosen.every(i => i.kind === 'record')

  const run = async () => {
    if (!p) return
    setBusy(true); setErr('')
    const r = await apiJson<{ data: { results: Result[]; recordRemoved: boolean } }>(`/api/sites/${encodeURIComponent(siteId)}/delete`, 'POST', {
      previewId: p.id, items: chosen.map(i => i.key), confirm: Object.fromEntries(chosen.filter(i => i.typed).map(i => [i.key, typed[i.key] ?? ''])),
    })
    setBusy(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setConfirm(true); return }
    // 207: some items did not go. The body still carries every item's result.
    if (r.body?.data?.results) { setResults(r.body.data.results); setRemoved(r.body.data.recordRemoved); return }
    setErr(r.error ?? 'The delete could not be run.')
  }

  const title = p?.adopted ? `Stop tracking ${p.siteName}` : `Delete ${p?.siteName ?? 'website'}`
  return (
    <Modal title={title} onClose={removed ? onDone : onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '70vh', overflowY: 'auto' }}>
        {!p && !err && <p className={styles.empty}>reading what this site has…</p>}
        {err && <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--crit)' }}>{err}</p>}

        {p && !results && (
          <>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
              Exactly what would be removed. Ticked by default: what HyperProx made and recorded when it published the site.
              This preview lasts ten minutes and is used once.
            </p>
            {p.items.map(it => {
              const dim = !it.offered
              const needsHost = !!it.requires && !on[it.requires]
              return (
                <div key={it.key} className={styles.card} style={{ padding: 10, opacity: dim ? 0.7 : 1 }}>
                  <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: dim || it.locked ? 'default' : 'pointer' }}>
                    <input type="checkbox" checked={!!on[it.key] && it.offered} disabled={dim || it.locked || needsHost || busy}
                      onChange={e => tick(it, e.target.checked)} aria-label={it.label} style={{ marginTop: 3 }} />
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                      <span style={{ fontSize: 14, color: 'var(--text-bright)' }}>
                        {it.label}
                        {STATE_TAG[it.state] && <span className={styles.tag} style={{ marginLeft: 8 }}>{STATE_TAG[it.state]}</span>}
                        {it.offered && it.owned === null && <span className={styles.tag} style={{ marginLeft: 8 }}>not known to be HyperProx&apos;s</span>}
                      </span>
                      <span className="font-mono" style={{ fontSize: 12, color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{it.detail}</span>
                      {it.notes.map((n, i) => <span key={i} style={{ fontSize: 12, color: 'var(--text-dim)' }}>{n}</span>)}
                      {it.danger && <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--crit)' }}>{it.danger}</span>}
                    </span>
                  </label>
                  {it.typed && on[it.key] && (
                    <input type="text" placeholder={`Type ${it.typed} to remove it`} aria-label={`Type ${it.typed} to confirm`} value={typed[it.key] ?? ''}
                      onChange={e => setTyped(t => ({ ...t, [it.key]: e.target.value }))} className="font-mono"
                      style={{ ...INPUT, marginTop: 8, height: 36, fontSize: 13, border: '1px solid var(--crit)' }} />
                  )}
                </div>
              )
            })}
            {p.notes.map((n, i) => <p key={i} style={{ margin: 0, fontSize: 12, color: 'var(--text-dim)' }}>{n}</p>)}
            <div className={styles.row} style={{ gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button type="button" className={styles.btn} onClick={onClose} disabled={busy}>Cancel</button>
              <button type="button" className={`${styles.btn} ${styles.btnDanger}`} disabled={busy || !typedOk} onClick={() => void run()}>
                {busy ? 'Working…' : onlyRecord ? (p.adopted ? 'Stop tracking' : 'Remove from Sites') : `Delete ${chosen.length} item${chosen.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </>
        )}

        {results && (
          <>
            {results.map(r => (
              <div key={r.key} style={{ fontSize: 13 }}>
                <span style={{ color: r.outcome === 'failed' ? 'var(--crit)' : 'var(--text-bright)', fontWeight: 600 }}>{OUTCOME[r.outcome]}</span>
                <span style={{ color: 'var(--text-muted)' }}> {r.words}</span>
              </div>
            ))}
            <div className={styles.row} style={{ gap: 8, justifyContent: 'flex-end' }}>
              {!removed && <button type="button" className={styles.btn} onClick={() => void preview()}>Preview again</button>}
              <button type="button" className={`${styles.btn} ${styles.btnPri}`} onClick={removed ? onDone : onClose}>{removed ? 'Done' : 'Close'}</button>
            </div>
          </>
        )}
      </div>
      {confirm && <ReconfirmModal onClose={() => setConfirm(false)} onDone={() => { setConfirm(false); void run() }} />}
    </Modal>
  )
}
