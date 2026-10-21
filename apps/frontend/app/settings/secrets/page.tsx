'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { BusyNote, CopyButton, GhostButton, INPUT, LABEL, Modal, Notice, PrimaryButton } from '@/components/vault/ui'

interface SecretRow { name: string; updatedAt?: string; managed?: boolean; fields?: string[] }

const REVEAL_SECONDS = 30

/** Accepts `[...]`, `{ secrets: [...] }` or `{ data: [...] }`, with rows as strings or objects. */
function parseRows(body: any): SecretRow[] {
  const list = Array.isArray(body) ? body : body?.secrets ?? body?.data ?? []
  if (!Array.isArray(list)) return []
  return list.map((x: any) => typeof x === 'string' ? { name: x } : {
    name: String(x.name), updatedAt: x.updatedAt,
    managed: !!x.managed || String(x.name).startsWith('hyperprox:'),
    fields: Array.isArray(x.fields) ? x.fields.map(String) : undefined,
  })
}

/** The reveal response is either one `value` or a map of fields; flatten to label/value pairs. */
function parseRevealed(body: any): Array<[string, string]> {
  const b = body?.data ?? body
  if (typeof b?.value === 'string') return [['value', b.value]]
  const fields = b?.fields ?? b?.secret?.fields
  if (fields && typeof fields === 'object') return Object.entries(fields).map(([k, v]) => [k, String(v)])
  return []
}

function fmtDate(s?: string) {
  if (!s) return '—'
  const d = new Date(s)
  return isNaN(d.getTime()) ? s : d.toLocaleString()
}

// ---------------------------------------------------------------------------

function RevealModal({ name, values, onClose }: { name: string; values: Array<[string, string]>; onClose: () => void }) {
  const [left, setLeft] = useState(REVEAL_SECONDS)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const id = setInterval(() => setLeft(l => l - 1), 1000)
    return () => clearInterval(id)
  }, [])
  useEffect(() => { if (left <= 0) onClose() }, [left, onClose])
  return (
    <Modal title={name} onClose={onClose}>
      <div className="space-y-3">
        {values.length === 0 && <Notice kind="info">This item has no stored value.</Notice>}
        {values.map(([k, v]) => (
          <div key={k}>
            <div style={LABEL}>{k}</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 break-all rounded-md border px-3 py-2 text-sm"
                    style={{ fontFamily: 'var(--font-mono)', background: 'var(--ground-deep)', borderColor: 'var(--border-strong)', color: 'var(--text-bright)' }}>
                {shown ? v : '•'.repeat(Math.min(Math.max(v.length, 8), 24))}
              </code>
              <CopyButton text={v} />
            </div>
          </div>
        ))}
        <div className="flex items-center justify-between">
          <button type="button" onClick={() => setShown(s => !s)} className="text-sm" style={{ color: 'var(--accent)' }}>
            {shown ? 'Hide' : 'Show'}
          </button>
          <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>Hides in {Math.max(left, 0)}s</span>
        </div>
      </div>
    </Modal>
  )
}

function SendModal({ name, fieldNames, onClose }: { name: string; fieldNames?: string[]; onClose: () => void }) {
  const [hours, setHours] = useState('24')
  const [maxViews, setMaxViews] = useState('1')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [choices, setChoices] = useState<string[]>(fieldNames && fieldNames.length > 1 ? fieldNames : [])
  const [field, setField] = useState('')
  const [link, setLink] = useState<{ url: string; expiresAt?: string } | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    const payload: Record<string, unknown> = { name, hours: Number(hours) || 24, maxViews: Number(maxViews) || 1 }
    if (password) payload.password = password
    if (field) payload.field = field
    const r = await apiJson<{ url: string; expiresAt?: string; fields?: string[] }>('/api/secrets/send', 'POST', payload)
    setBusy(false)
    // Several fields and none chosen: the API lists them; ask which one to send.
    if (r.status === 400 && Array.isArray(r.body?.fields)) { setChoices(r.body!.fields!.map(String)); setError('Choose which field to send.'); return }
    if (!r.ok || !r.body?.url) { setError(r.error ?? 'Could not create the Send'); return }
    setLink(r.body)
  }

  return (
    <Modal title={`Send ${name}`} onClose={onClose}>
      {link ? (
        <div className="space-y-3">
          <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
            One-time link{link.expiresAt ? `, expires ${fmtDate(link.expiresAt)}` : ''}. Anyone with it can view the secret until it expires or runs out of views.
          </p>
          <code className="block break-all rounded-md border px-3 py-2 text-sm select-all"
                style={{ fontFamily: 'var(--font-mono)', background: 'var(--ground-deep)', borderColor: 'var(--border-strong)', color: 'var(--text-bright)' }}>
            {link.url}
          </code>
          <div className="flex gap-2 justify-end"><CopyButton text={link.url} label="Copy link" /><GhostButton onClick={onClose}>Done</GhostButton></div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div><label htmlFor="s-hours" style={LABEL}>Expires after (hours)</label>
              <input id="s-hours" type="number" min={1} max={720} value={hours} onChange={e => setHours(e.target.value)} style={INPUT} /></div>
            <div><label htmlFor="s-views" style={LABEL}>Max views</label>
              <input id="s-views" type="number" min={1} max={100} value={maxViews} onChange={e => setMaxViews(e.target.value)} style={INPUT} /></div>
          </div>
          {choices.length > 0 && (
            <div><label htmlFor="s-field" style={LABEL}>Field to send</label>
              <select id="s-field" value={field} onChange={e => setField(e.target.value)} style={{ ...INPUT, cursor: 'pointer' }}>
                <option value="">Select a field...</option>
                {choices.map(f => <option key={f} value={f}>{f}</option>)}
              </select></div>
          )}
          <div><label htmlFor="s-pw" style={LABEL}>Access password (optional)</label>
            <input id="s-pw" type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} style={INPUT} /></div>
          {error && <Notice kind="error">{error}</Notice>}
          <div className="flex gap-2 justify-end">
            <GhostButton type="button" onClick={onClose}>Cancel</GhostButton>
            <PrimaryButton type="submit" disabled={busy || (choices.length > 0 && !field)}>{busy ? 'Creating...' : 'Create link'}</PrimaryButton>
          </div>
          {busy && <BusyNote>Creating the Send in the vault — this takes about 10 seconds.</BusyNote>}
        </form>
      )}
    </Modal>
  )
}

function GenerateModal({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    const r = await apiJson('/api/secrets/generate', 'POST', { name: name.trim(), purpose: purpose.trim() })
    if (!r.ok) { setError(r.error ?? 'Could not generate'); setBusy(false); return }
    onDone()
  }
  return (
    <Modal title="Generate a password" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm" style={{ color: 'var(--text-soft)' }}>A random 24-character password is saved straight to the vault. It is not shown here.</p>
        <div><label htmlFor="g-name" style={LABEL}>Name</label>
          <input id="g-name" autoFocus value={name} onChange={e => setName(e.target.value)} style={{ ...INPUT, fontFamily: 'var(--font-mono)' }} /></div>
        <div><label htmlFor="g-purpose" style={LABEL}>What it is for</label>
          <input id="g-purpose" value={purpose} onChange={e => setPurpose(e.target.value)} style={INPUT} /></div>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex gap-2 justify-end">
          <GhostButton type="button" onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton type="submit" disabled={busy || !name.trim() || !purpose.trim()}>{busy ? 'Generating...' : 'Generate'}</PrimaryButton>
        </div>
        {busy && <BusyNote>Saving to the vault — this takes about 10 seconds.</BusyNote>}
      </form>
    </Modal>
  )
}

// ---------------------------------------------------------------------------

export default function SecretsPage() {
  const { role } = useSession()
  const canUse = atLeast(role, 'admin')
  const [rows, setRows] = useState<SecretRow[] | null>(null)
  const [error, setError] = useState('')
  const [reconfirmUntil, setReconfirmUntil] = useState(0)
  const [askConfirm, setAskConfirm] = useState<null | { then: () => void }>(null)
  const [revealed, setRevealed] = useState<null | { name: string; values: Array<[string, string]> }>(null)
  const [sendFor, setSendFor] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [toast, setToast] = useState('')
  const toastTimer = useRef<ReturnType<typeof setTimeout>>()

  const load = useCallback(async () => {
    const r = await apiJson('/api/secrets')
    if (r.status === 403) { setError('Your role cannot view secrets.'); setRows([]); return }
    if (!r.ok) { setError(r.error ?? 'Could not load secrets'); setRows([]); return }
    setError(''); setRows(parseRows(r.body))
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const flash = (m: string) => { setToast(m); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 4000) }

  async function doReveal(name: string) {
    const r = await apiJson('/api/secrets/reveal', 'POST', { name })
    if (r.ok) { setRevealed({ name, values: parseRevealed(r.body) }); return }
    // The server's re-confirmation window may be shorter than ours (restart, clock): ask again.
    if (r.status === 403 && (r.code === 'reconfirm_required' || /confirm/i.test(r.error ?? ''))) {
      setReconfirmUntil(0); setAskConfirm({ then: () => doReveal(name) }); return
    }
    flash(r.error ?? 'Could not reveal')
  }

  function reveal(name: string) {
    if (Date.now() < reconfirmUntil) doReveal(name)
    else setAskConfirm({ then: () => doReveal(name) })
  }

  return (
    <div className="min-h-full p-4 sm:p-8" style={{ background: 'var(--ground)' }}>
      <div className="mb-8">
        <Link href="/settings" className="font-mono uppercase" style={{ fontSize: 12, letterSpacing: '0.14em', color: 'var(--accent)' }}>← Settings</Link>
        <div className="flex flex-wrap items-end justify-between gap-3 mt-2">
          <h1 className="font-display font-bold" style={{ fontSize: 36, lineHeight: 1.1, color: 'var(--text-bright)' }}>Secrets</h1>
          {canUse && <PrimaryButton onClick={() => setGenerating(true)}>Generate password</PrimaryButton>}
        </div>
        <p className="mt-2 text-sm" style={{ color: 'var(--text-soft)' }}>
          What HyperProx holds in its vault. Values are never listed; revealing one needs your master password again.
        </p>
      </div>

      <div className="max-w-3xl space-y-4">
        {toast && <Notice kind="info">{toast}</Notice>}
        {error && <Notice kind="error">{error}</Notice>}
        {rows === null ? (
          <div className="text-sm animate-pulse" style={{ color: 'var(--text-dimmer)' }}>Loading secrets...</div>
        ) : rows.length === 0 && !error ? (
          <Notice kind="info">No secrets stored yet.</Notice>
        ) : rows.length > 0 && (
          <div className="hp-table-scroll overflow-x-auto rounded-lg border" style={{ borderColor: 'var(--border-soft)', background: 'var(--surface)' }}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left" style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-dim)' }}>
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Updated</th>
                  {canUse && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.name} style={{ borderBottom: '1px solid var(--border-dim)' }}>
                    <td className="px-4 py-3 break-all" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-bright)' }}>
                      {r.name}
                      {r.managed && <span className="ml-2 rounded border px-1.5 text-[10px] uppercase" style={{ borderColor: 'var(--border-strong)', color: 'var(--text-muted)', letterSpacing: '0.1em' }}>system</span>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--text-soft)' }}>{fmtDate(r.updatedAt)}</td>
                    {canUse && (
                      <td className="px-4 py-3">
                        {r.managed ? <div className="text-right text-xs" style={{ color: 'var(--text-muted)' }}>read-only</div> : (
                        <div className="flex justify-end gap-2">
                          <button onClick={() => reveal(r.name)} className="rounded border px-3 text-xs font-medium" style={{ height: 30, borderColor: 'var(--border-strong)', color: 'var(--text-soft)' }}>Reveal</button>
                          <button onClick={() => setSendFor(r.name)} className="rounded border px-3 text-xs font-medium" style={{ height: 30, borderColor: 'var(--border-strong)', color: 'var(--accent)' }}>Send</button>
                        </div>)}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {role && !canUse && <Notice kind="info">Only owners and admins can reveal, send or generate secrets.</Notice>}
      </div>

      {askConfirm && (
        <ReconfirmModal
          onClose={() => setAskConfirm(null)}
          onDone={until => { setReconfirmUntil(until); const t = askConfirm.then; setAskConfirm(null); t() }}
        />
      )}
      {revealed && <RevealModal name={revealed.name} values={revealed.values} onClose={() => setRevealed(null)} />}
      {sendFor && <SendModal name={sendFor} fieldNames={rows?.find(x => x.name === sendFor)?.fields} onClose={() => setSendFor(null)} />}
      {generating && <GenerateModal onClose={() => setGenerating(false)} onDone={() => { setGenerating(false); flash('Password generated and saved to the vault.'); load() }} />}
    </div>
  )
}
