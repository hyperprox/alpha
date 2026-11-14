'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { BusyNote, CopyButton, GhostButton, INPUT, LABEL, Modal, Notice, PrimaryButton } from '@/components/vault/ui'
import { Details, HudHeader, Page, Panel, Pill, styles as ks, type StatChip } from '@/components/visual/kit'
import ss from '../settings.module.css'
import { exact, inWords } from '../when'
import { deleteArmed, deleteOutcome } from '@/lib/vault-delete'

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
              <code className={ss.code}>
                {shown ? v : '•'.repeat(Math.min(Math.max(v.length, 8), 24))}
              </code>
              <CopyButton text={v} />
            </div>
          </div>
        ))}
        <div className="flex items-center justify-between">
          <button type="button" onClick={() => setShown(s => !s)} className={ss.mini} data-tone="accent">
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
  // A Send hands a secret's value out, so the API asks for the master password again, as reveal does.
  const [confirming, setConfirming] = useState(false)

  async function submit(e?: React.FormEvent) {
    e?.preventDefault()
    setBusy(true); setError('')
    const payload: Record<string, unknown> = { name, hours: Number(hours) || 24, maxViews: Number(maxViews) || 1 }
    if (password) payload.password = password
    if (field) payload.field = field
    const r = await apiJson<{ url: string; expiresAt?: string; fields?: string[] }>('/api/secrets/send', 'POST', payload)
    setBusy(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setConfirming(true); return }
    // Several fields and none chosen: the API lists them; ask which one to send.
    if (r.status === 400 && Array.isArray(r.body?.fields)) { setChoices(r.body!.fields!.map(String)); setError('Choose which field to send.'); return }
    if (!r.ok || !r.body?.url) { setError(r.error ?? 'Could not create the Send'); return }
    setLink(r.body)
  }

  if (confirming) {
    return <ReconfirmModal onClose={() => setConfirming(false)} onDone={() => { setConfirming(false); void submit() }} />
  }

  return (
    <Modal title={`Send ${name}`} onClose={onClose}>
      {link ? (
        <div className="space-y-3">
          <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
            One-time link{link.expiresAt ? `, expires ${fmtDate(link.expiresAt)}` : ''}. Anyone with it can view the secret until it expires or runs out of views.
          </p>
          <code className={`${ss.code} select-all`}>
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

/** Delete one item: type its name to arm the button; the master password is asked again; it goes to the vault's trash. */
function DeleteModal({ name, onDone, onClose }: { name: string; onDone: (message: string) => void; onClose: () => void }) {
  const [typed, setTyped] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  async function submit(e?: React.FormEvent) {
    e?.preventDefault()
    if (!deleteArmed(typed, name)) return
    setBusy(true); setError('')
    const r = await apiJson('/api/secrets/delete', 'POST', { name })
    setBusy(false)
    const out = deleteOutcome(r, name)
    if (out.kind === 'reconfirm') { setConfirming(true); return }
    if (out.kind === 'error') { setError(out.message); return }
    onDone(out.message)
  }

  if (confirming) {
    return <ReconfirmModal onClose={() => setConfirming(false)} onDone={() => { setConfirming(false); void submit() }} />
  }

  return (
    <Modal title={`Delete ${name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
          This moves <strong>{name}</strong> to the vault&apos;s trash. Anything that still uses it stops working. It can be restored from a Bitwarden client for 30 days.
        </p>
        <div><label htmlFor="d-name" style={LABEL}>Type the name to confirm</label>
          <input id="d-name" autoFocus value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" style={{ ...INPUT, fontFamily: 'var(--font-mono)' }} /></div>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex gap-2 justify-end">
          <GhostButton type="button" onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton type="submit" disabled={busy || !deleteArmed(typed, name)}>{busy ? 'Deleting...' : 'Delete'}</PrimaryButton>
        </div>
        {busy && <BusyNote>Removing it from the vault — this takes a few seconds.</BusyNote>}
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
  const [deleteFor, setDeleteFor] = useState<string | null>(null)
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

  const managed = (rows ?? []).filter(r => r.managed).length
  const newest = (rows ?? []).map(r => r.updatedAt).filter((x): x is string => !!x && !isNaN(new Date(x).getTime()))
    .sort((x, y) => new Date(y).getTime() - new Date(x).getTime())[0]
  const chips: StatChip[] = [
    { label: 'stored', value: rows ? rows.length : '…', tone: 'accent' },
    { label: 'yours', value: rows ? rows.length - managed : '…' },
    { label: 'system, read-only', value: rows ? managed : '…' },
    { label: 'last change', value: rows ? (inWords(newest) ?? '—') : '…' },
  ]

  return (
    <Page>
      <HudHeader level={2} label="Secrets overview" icon="lock"
        eyebrow={<><Link href="/settings" style={{ color: 'inherit' }}>&larr; Settings</Link> · Secrets</>}
        title={rows === null ? 'Loading secrets...' : `${rows.length} item${rows.length === 1 ? '' : 's'} in the vault`}
        chips={chips}
        actions={canUse && <PrimaryButton onClick={() => setGenerating(true)}>Generate password</PrimaryButton>}>
        <p className="text-sm" style={{ margin: 0, color: 'var(--text-soft)' }}>
          What HyperProx holds in its vault. Values are never listed; revealing one needs your master password again.
        </p>
      </HudHeader>

      {toast && <Notice kind="info">{toast}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}

      <Panel title="Vault items" sub="names only, never values">
        {rows === null ? (
          <p className={`${ks.empty} animate-pulse`}>Loading secrets...</p>
        ) : rows.length === 0 && !error ? (
          <Notice kind="info">No secrets stored yet.</Notice>
        ) : rows.length > 0 ? (
          <ul className={ss.items} aria-label="Secrets">
            {rows.map(r => (
              <li key={r.name} className={ss.item}>
                <div className={ss.itemHead}>
                  <span className={ss.itemName}>{r.name}</span>
                  <span className={ss.pills}>
                    {r.managed && <Pill title="Kept by HyperProx itself">system</Pill>}
                    {r.fields && r.fields.length > 1 && <Pill tone="violet">{r.fields.length} fields</Pill>}
                  </span>
                </div>
                <p className={ss.meta} title={exact(r.updatedAt)}>
                  {r.updatedAt ? `updated ${inWords(r.updatedAt) ?? fmtDate(r.updatedAt)}` : 'no change date'}
                </p>
                {canUse && (
                  r.managed ? <p className={ss.meta} style={{ marginTop: 'auto' }}>read-only</p> : (
                    <div className={ss.acts}>
                      <button type="button" onClick={() => reveal(r.name)} className={ss.mini} aria-label={`Reveal ${r.name}`}>Reveal</button>
                      <button type="button" onClick={() => setSendFor(r.name)} className={ss.mini} data-tone="accent" aria-label={`Send ${r.name}`}>Send</button>
                      <button type="button" onClick={() => setDeleteFor(r.name)} className={ss.mini} data-tone="bad" aria-label={`Delete ${r.name}`}>Delete</button>
                    </div>
                  )
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {role && !canUse && <div style={{ marginTop: 12 }}><Notice kind="info">Only owners and admins can reveal, send, generate or delete secrets.</Notice></div>}
      </Panel>

      {rows && rows.length > 0 && (
        <Details summary="Details" sub="every item, exact times">
          <div className={ks.tableWrap}>
            <table className={ks.table}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.name}>
                    <td className="break-all" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-bright)' }}>
                      {r.name}
                      {r.managed && <span className="ml-2"><Pill>system</Pill></span>}
                    </td>
                    <td className="whitespace-nowrap" style={{ color: 'var(--text-soft)' }}>{fmtDate(r.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Details>
      )}

      {askConfirm && (
        <ReconfirmModal
          onClose={() => setAskConfirm(null)}
          onDone={until => { setReconfirmUntil(until); const t = askConfirm.then; setAskConfirm(null); t() }}
        />
      )}
      {revealed && <RevealModal name={revealed.name} values={revealed.values} onClose={() => setRevealed(null)} />}
      {sendFor && <SendModal name={sendFor} fieldNames={rows?.find(x => x.name === sendFor)?.fields} onClose={() => setSendFor(null)} />}
      {deleteFor && <DeleteModal name={deleteFor} onClose={() => setDeleteFor(null)} onDone={m => { setDeleteFor(null); flash(m); load() }} />}
      {generating && <GenerateModal onClose={() => setGenerating(false)} onDone={() => { setGenerating(false); flash('Password generated and saved to the vault.'); load() }} />}
    </Page>
  )
}
