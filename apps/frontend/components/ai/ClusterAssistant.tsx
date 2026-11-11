'use client'

// =============================================================================
//  The assistant and clusters: which cluster it is answering about, and the confirm card for an action it
//  prepared. Teal is the home cluster and amber a remote, as in the Command center. The card applies the plan
//  by its id only, with the plan's own cluster in the X-HyperProx-Cluster header: the server refuses it for any
//  other cluster. A delete asks for the guest's name typed; anything that needs the master password asks for it
//  first, exactly as the same button elsewhere does.
// =============================================================================

import { useState } from 'react'
import { CLUSTER_HEADER, type ApiResult } from '@/lib/api'
import { clusterColor, clusterInk } from '@/lib/clusters'
import { styles } from '@/components/visual/kit'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'

export interface ClusterRef { id: string; name: string; kind: 'home' | 'remote' }

export interface ActionCardData {
  planId: string
  action: string
  cluster: ClusterRef
  from?: ClusterRef
  title: string
  words: string
  steps: string[]
  needsReconfirm: boolean
  typedName: string | null
  role: string
}

/** A small label: the cluster's name, teal for home and amber (with REMOTE) for a remote. */
export function ClusterChip({ c, size = 'sm' }: { c: ClusterRef; size?: 'sm' | 'md' }) {
  return (
    <span className="font-mono rounded" style={{
      fontSize: size === 'md' ? 12 : 10.5, padding: size === 'md' ? '3px 8px' : '1px 6px', letterSpacing: '0.04em',
      background: clusterColor(c.kind), color: clusterInk(c.kind), whiteSpace: 'nowrap',
    }}>
      {c.kind === 'remote' ? `REMOTE · ${c.name}` : c.name}
    </span>
  )
}

/** Which cluster the assistant answers about unless a question names another one. */
export function ClusterPicker({ clusters, value, onChange, disabled }: { clusters: ClusterRef[]; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const current = clusters.find(c => c.id === value) ?? clusters[0]
  if (!current) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10, padding: '8px 10px', borderRadius: 8,
      border: `1px solid ${clusterColor(current.kind)}`, background: 'var(--surface)' }}>
      <span style={{ fontSize: 13, color: 'var(--text-soft)' }}>Answering about</span>
      <ClusterChip c={current} size="md" />
      {clusters.length > 1 && (
        <select aria-label="Cluster" value={current.id} disabled={disabled} onChange={e => onChange(e.target.value)}
          style={{ marginLeft: 'auto', padding: '6px 10px', fontSize: 13, borderRadius: 6, background: 'var(--ground-deep)', color: 'var(--text)', border: '1px solid var(--border-strong)' }}>
          {clusters.map(c => <option key={c.id} value={c.id}>{c.kind === 'remote' ? `${c.name} (remote)` : `${c.name} (home)`}</option>)}
        </select>
      )}
      <span style={{ flexBasis: '100%', fontSize: 12, color: 'var(--text-dim)' }}>
        Name another cluster in your question (&quot;on {clusters.find(c => c.kind === 'remote')?.name ?? 'Remote server'}&quot;, &quot;each cluster&quot;) to ask about it instead.
      </span>
    </div>
  )
}

/** The confirm card for a prepared action. `onDone` gets the sentence to show in the conversation. */
export function ActionCard({ card, onDone, onCancel }: { card: ActionCardData; onDone: (words: string) => void; onCancel: () => void }) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reconfirm, setReconfirm] = useState(false)
  const remote = card.cluster.kind === 'remote'
  const colour = clusterColor(card.cluster.kind)
  const ready = !card.typedName || typed === card.typedName

  async function apply() {
    setBusy(true); setError(null)
    let r: ApiResult
    try {
      const res = await fetch('/api/ai/actions/apply', {
        method: 'POST',
        // The plan's own cluster, never the page's: the server refuses a plan for any other.
        headers: { 'Content-Type': 'application/json', [CLUSTER_HEADER]: card.cluster.id },
        body: JSON.stringify(card.typedName ? { planId: card.planId, confirmName: typed } : { planId: card.planId }),
      })
      const body = await res.json().catch(() => null)
      r = { ok: res.ok && body?.ok !== false, status: res.status, body, code: body?.code, error: body?.error }
    } catch { r = { ok: false, status: 0, body: null, error: 'Could not reach HyperProx.' } }
    setBusy(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(true); return }
    if (r.status === 428) { setError(r.error ?? 'Type the name exactly.'); return }
    const words = (r.body as any)?.words ?? r.error ?? 'Done.'
    onDone(r.ok ? `${card.cluster.name}: ${words}` : `Not done on ${card.cluster.name}: ${r.error ?? words}`)
  }

  return (
    <div style={{ background: 'linear-gradient(135deg, var(--surface), var(--surface-hi))', border: `1px solid ${colour}`, borderRadius: 12, padding: '1.25rem', marginBottom: '1rem', boxShadow: 'var(--shadow)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <ClusterChip c={card.cluster} size="md" />
        {card.from && card.from.id !== card.cluster.id && <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>from <ClusterChip c={card.from} /></span>}
        {card.needsReconfirm && <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>asks for your master password</span>}
      </div>
      <div className="font-display" style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 4 }}>{card.title}</div>
      {remote && <div style={{ fontSize: 13, color: colour, marginBottom: 6 }}>This runs on the remote cluster {card.cluster.name}, not on your home cluster.</div>}
      <ul style={{ margin: '6px 0 12px 18px', padding: 0, fontSize: 14, color: 'var(--text-soft)', lineHeight: 1.5 }}>
        {card.steps.map((s, i) => <li key={i}>{s}</li>)}
      </ul>
      {card.typedName && (
        <label style={{ display: 'block', fontSize: 13, color: 'var(--text-soft)', marginBottom: 10 }}>
          Type <span className="font-mono" style={{ color: 'var(--text-bright)' }}>{card.typedName}</span> to delete it.
          <input value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off"
            style={{ display: 'block', width: '100%', marginTop: 6, padding: '8px 10px', borderRadius: 6, background: 'var(--ground)', color: 'var(--text)', border: '1px solid var(--border-strong)' }} />
        </label>
      )}
      {error && <div style={{ fontSize: 13, color: 'var(--crit)', marginBottom: 8 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} disabled={busy} className={styles.btn}>Cancel</button>
        <button onClick={apply} disabled={busy || !ready}
          style={{ padding: '9px 18px', fontSize: 14, fontWeight: 600, cursor: busy || !ready ? 'default' : 'pointer', background: card.typedName ? 'var(--crit)' : colour,
            color: card.typedName ? 'var(--text-bright)' : clusterInk(card.cluster.kind), border: 'none', borderRadius: 6, opacity: busy || !ready ? 0.5 : 1 }}>
          {busy ? 'Working...' : `${card.typedName ? 'Delete' : 'Confirm'} on ${card.cluster.name}`}
        </button>
      </div>
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(false)} onDone={() => { setReconfirm(false); void apply() }} />}
    </div>
  )
}
