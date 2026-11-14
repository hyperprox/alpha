'use client'

// =============================================================================
//  HyperProx — Proxy page
//  Every proxy instance (Nginx Proxy Manager, Traefik, Caddy, HAProxy,
//  Pangolin; several of each) in one table. Every host names the instance
//  that owns it; hosts made outside HyperProx are read-only. Every write is
//  previewed first, then applied, then read back from the proxy.
// =============================================================================

import { useEffect, useState, useCallback, useMemo } from 'react'
import { alpha } from '@/lib/theme'
import { atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { Details, HudHeader, Page, Panel, Pill, styles, type PillTone, type StatChip } from '@/components/visual/kit'

// ---------------------------------------------------------------------------
//  Types (the API's shapes, apps/api/src/lib/proxy/types.ts)
// ---------------------------------------------------------------------------

type Kind = 'npm' | 'traefik' | 'caddy' | 'haproxy' | 'pangolin'

interface HostView {
  id: string; instanceId: string; instanceName: string; kind: Kind
  domains: string[]; forwardScheme: 'http' | 'https'; forwardHost: string; forwardPort: number
  enabled: boolean; readOnly: boolean; readOnlyReason?: string
  tls: { kind: 'none' | 'certificate' | 'auto'; certificateId?: string; expiresAt?: string | null; forced?: boolean }
  online?: boolean | null; websockets?: boolean; detail?: string; native?: Record<string, any>
}
// Viewers get id, kind, name, mode and status only; the rest is for admins.
interface Instance {
  id: string; kind: Kind; kindLabel: string; name: string; url?: string; mode: 'byo' | 'managed'
  managed?: { node: string; vmid: number; recipe: string } | null; settings?: Record<string, string>; legacy?: boolean; secretsSet?: string[]
  status?: 'ok' | 'locked' | 'unavailable'
}
interface KindField { key: string; label: string; secret: boolean; required: boolean | 'conditional'; help?: string; default?: string; options?: string[] }
interface KindInfo { kind: Kind; label: string; urlLabel: string; urlHint: string; fields: KindField[]; notes: string[] }
interface Cert { id: string; names: string[]; expiresAt: string | null; issuer: string; instanceId: string }
interface Health { ok: boolean; version?: string; checks: { name: string; ok: boolean; detail: string; warn?: boolean }[] }
interface Plan { id: string; instanceName: string; action: string; changes: string[]; consequences: string[]; warnings: string[]; expiresAt: string }
interface ApplyResult { ok: boolean; message: string; mismatch: string[]; cleanup?: Plan }

const KIND_SHORT: Record<Kind, string> = { npm: 'NPM', traefik: 'Traefik', caddy: 'Caddy', haproxy: 'HAProxy', pangolin: 'Pangolin' }
const KIND_COLOR: Record<Kind, string> = { npm: 'var(--accent)', traefik: 'var(--accent-2)', caddy: 'var(--good)', haproxy: 'var(--violet-2)', pangolin: 'var(--warn-2)' }

// ---------------------------------------------------------------------------
//  Style
// ---------------------------------------------------------------------------

const INPUT = {
  background: 'var(--ground-deep)', border: '1px solid var(--border-strong)',
  color: 'var(--text-bright)', borderRadius: 6, padding: '0 12px', minHeight: 40,
  fontFamily: 'IBM Plex Mono, monospace', fontSize: 13, outline: 'none', width: '100%',
} as React.CSSProperties
const LABEL = { display: 'block', fontSize: 11, fontFamily: 'IBM Plex Mono, monospace',
  color: 'var(--text-dim)', textTransform: 'uppercase' as const, letterSpacing: '0.14em', marginBottom: 6 }
const BTN_SECONDARY = {
  background: 'transparent', color: 'var(--text)', border: '1px solid var(--border-strong)',
  borderRadius: 6, height: 40, padding: '0 16px', fontSize: 14, fontWeight: 500,
} as React.CSSProperties
const BTN_PRIMARY = {
  background: 'var(--accent)', color: 'var(--accent-ink)', border: 'none',
  borderRadius: 6, height: 40, padding: '0 20px', fontSize: 14, fontWeight: 600,
} as React.CSSProperties

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init?.body ? { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } } : init)
  const json = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }))
  if (!json.success) throw new Error(json.error ?? `HTTP ${res.status}`)
  return json.data as T
}

function daysLeft(iso?: string | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso.replace(' ', 'T'))
  return Number.isFinite(t) ? Math.floor((t - Date.now()) / 86_400_000) : null
}

function Badge({ label, color, title }: { label: string; color: string; title?: string }) {
  return (
    <span title={title} className="font-mono px-1.5 py-0.5 rounded whitespace-nowrap" style={{
      fontSize: 10, background: `${alpha(color, 8)}`, color, border: `1px solid ${alpha(color, 19)}`,
    }}>{label}</span>
  )
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <div onClick={() => onChange(!checked)} className="relative rounded-full transition-colors duration-200"
        style={{ width: 32, height: 18, background: checked ? 'var(--accent)' : 'var(--text-faint)', border: `1px solid ${checked ? 'var(--accent)' : 'var(--text-dim)'}` }}>
        <div className="absolute top-0.5 rounded-full transition-all duration-200" style={{ width: 14, height: 14, background: 'var(--surface)', left: checked ? 14 : 2 }} />
      </div>
      <span style={{ fontSize: 14, color: checked ? 'var(--text-bright)' : 'var(--text-soft)' }}>{label}</span>
    </label>
  )
}

function Modal({ title, eyebrow, onClose, children, wide }: { title: string; eyebrow?: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'var(--scrim)' }} onClick={onClose}>
      <div className="rounded-lg border w-full overflow-y-auto" onClick={e => e.stopPropagation()}
        style={{ maxWidth: wide ? 720 : 560, maxHeight: 'calc(100dvh - 32px)', overscrollBehavior: 'contain', background: 'var(--surface)', borderColor: 'var(--border-strong)' }}>
        <div className="flex items-start justify-between p-5 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <div>
            {eyebrow && <div className="font-mono uppercase mb-1" style={{ fontSize: 11, letterSpacing: '0.14em', color: 'var(--accent)' }}>{eyebrow}</div>}
            <div className="font-display" style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-bright)' }}>{title}</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ color: 'var(--text-dim)', fontSize: 18 }}>✕</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
//  Preview → apply → read back
// ---------------------------------------------------------------------------

function PlanDialog({ plan: first, onClose, onDone }: { plan: Plan; onClose: () => void; onDone: () => void }) {
  const [plan, setPlan] = useState(first)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ApplyResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const apply = async () => {
    setBusy(true); setError(null)
    try { setResult(await api<ApplyResult>(`/api/proxy/plans/${plan.id}/apply`, { method: 'POST' })); onDone() }
    catch (e: any) { setError(e.message) }
    finally { setBusy(false) }
  }

  const List = ({ items, color }: { items: string[]; color: string }) => (
    <ul className="flex flex-col gap-1.5 mb-4">{items.map((x, i) => (
      <li key={i} className="text-sm pl-3" style={{ color: 'var(--text)', borderLeft: `2px solid ${color}` }}>{x}</li>
    ))}</ul>
  )

  return (
    <Modal title={result ? (result.ok ? 'Applied and checked' : 'Applied, but not as planned') : 'Check before applying'} eyebrow={plan.instanceName} onClose={onClose}>
      {!result && <>
        <div style={LABEL}>What changes</div>
        <List items={plan.changes} color="var(--accent)" />
        <div style={LABEL}>What that means</div>
        <List items={plan.consequences} color="var(--warn-2)" />
        {plan.warnings.length > 0 && <><div style={LABEL}>Worth knowing</div><List items={plan.warnings} color="var(--violet-2)" /></>}
        <div className="text-xs mb-4" style={{ color: 'var(--text-dim)' }}>
          This preview is held by HyperProx until {new Date(plan.expiresAt).toLocaleTimeString()}. If the host changes on the proxy before you apply, nothing is changed.
        </div>
      </>}
      {result && (
        <div className="text-sm mb-4 rounded-md p-3" style={{
          color: result.ok ? 'var(--good)' : 'var(--crit-2)',
          background: alpha(result.ok ? 'var(--good)' : 'var(--crit-2)', 8), border: `1px solid ${alpha(result.ok ? 'var(--good)' : 'var(--crit-2)', 19)}`,
        }}>
          {result.message}
          {result.mismatch.length > 0 && <ul className="mt-2 list-disc pl-5">{result.mismatch.map((m, i) => <li key={i}>{m}</li>)}</ul>}
        </div>
      )}
      {result?.cleanup && (
        <button onClick={() => { setPlan(result.cleanup!); setResult(null) }} style={{ ...BTN_SECONDARY, marginBottom: 16 }}>
          Review removing only what was made
        </button>
      )}
      {error && <div className="text-sm mb-4" style={{ color: 'var(--crit-2)' }}>{error}</div>}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} style={BTN_SECONDARY}>{result ? 'Close' : 'Cancel'}</button>
        {!result && <button onClick={apply} disabled={busy} style={{ ...BTN_PRIMARY, opacity: busy ? 0.6 : 1 }}>{busy ? 'Applying…' : 'Apply'}</button>}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
//  Host form (create / edit) — the same fields for every proxy; NPM adds its own
// ---------------------------------------------------------------------------

function HostForm({ host, instances, onClose, onPlan }: {
  host: HostView | null; instances: Instance[]; onClose: () => void; onPlan: (p: Plan) => void
}) {
  const n = host?.native ?? {}
  const [instanceId, setInstanceId] = useState(host?.instanceId ?? instances[0]?.id ?? '')
  const inst = instances.find(i => i.id === instanceId)
  const [domains, setDomains] = useState((host?.domains ?? []).join(', '))
  const [scheme, setScheme] = useState<'http' | 'https'>(host?.forwardScheme ?? 'http')
  const [fhost, setFhost] = useState(host?.forwardHost ?? '')
  const [port, setPort] = useState(String(host?.forwardPort ?? 80))
  const [enabled, setEnabled] = useState(host?.enabled ?? true)
  const [ws, setWs] = useState(host?.websockets ?? true)
  const [npm, setNpm] = useState({
    certificate_id: (typeof n.certificate_id === 'number' && n.certificate_id > 0 ? n.certificate_id : false) as number | false,
    ssl_forced: !!n.ssl_forced, block_exploits: host ? !!n.block_exploits : true, http2_support: !!n.http2_support,
    hsts_enabled: !!n.hsts_enabled, hsts_subdomains: !!n.hsts_subdomains, caching_enabled: !!n.caching_enabled,
    advanced_config: String(n.advanced_config ?? ''),
  })
  const [certs, setCerts] = useState<Cert[]>([])
  const [certEmail, setCertEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (inst?.kind !== 'npm') { setCerts([]); return }
    api<Cert[]>(`/api/proxy/instances/${inst.id}/certificates`).then(setCerts).catch(() => setCerts([]))
  }, [inst?.id, inst?.kind])

  const body = () => ({
    domains: domains.split(/[\s,]+/).map(d => d.trim()).filter(Boolean),
    forwardScheme: scheme, forwardHost: fhost.trim(), forwardPort: Number(port), enabled, websockets: ws,
    ...(inst?.kind === 'npm' ? { npm } : {}),
  })

  const preview = async () => {
    setBusy(true); setError(null)
    try {
      onPlan(await api<Plan>(`/api/proxy/instances/${instanceId}/preview`, { method: 'POST',
        body: JSON.stringify(host ? { action: 'update', hostId: host.id, host: body() } : { action: 'create', host: body() }) }))
    } catch (e: any) { setError(e.message) }
    finally { setBusy(false) }
  }

  const requestCert = async () => {
    setBusy(true); setError(null); setMsg('Requesting a certificate from Let’s Encrypt through NPM…')
    try {
      const c = await api<Cert>(`/api/proxy/instances/${instanceId}/certificates`, { method: 'POST', body: JSON.stringify({ domains: body().domains, email: certEmail }) })
      setCerts(cs => [...cs, { ...c, instanceId }])
      setNpm(x => ({ ...x, certificate_id: Number(c.id), ssl_forced: true }))
      setMsg(`Certificate #${c.id} issued. It is attached when you preview and apply.`)
    } catch (e: any) { setError(e.message); setMsg(null) }
    finally { setBusy(false) }
  }

  const writable = instances.filter(i => !host || i.id === host.instanceId)
  return (
    <Modal title={host ? host.domains[0] ?? host.id : 'New host'} eyebrow={host ? `Edit on ${host.instanceName}` : 'Add a proxy host'} onClose={onClose} wide>
      <div className="grid gap-4">
        <div>
          <label style={LABEL}>Proxy</label>
          <select value={instanceId} onChange={e => setInstanceId(e.target.value)} disabled={!!host} style={INPUT}>
            {writable.map(i => <option key={i.id} value={i.id}>{i.name} — {KIND_SHORT[i.kind]}{i.mode === 'managed' ? ' (Managed)' : ''}</option>)}
          </select>
        </div>
        <div>
          <label style={LABEL}>Domain names</label>
          <input value={domains} onChange={e => setDomains(e.target.value)} placeholder="app.example.com, www.app.example.com" style={INPUT} />
          {inst?.kind === 'pangolin' && <div className="text-xs mt-1" style={{ color: 'var(--text-dim)' }}>Pangolin: one name, under one of the organisation’s domains.</div>}
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: '110px 1fr 110px' }}>
          <div><label style={LABEL}>Scheme</label>
            <select value={scheme} onChange={e => setScheme(e.target.value as any)} style={INPUT}><option value="http">http</option><option value="https">https</option></select></div>
          <div><label style={LABEL}>Forward host</label><input value={fhost} onChange={e => setFhost(e.target.value)} placeholder="192.0.2.10" style={INPUT} /></div>
          <div><label style={LABEL}>Port</label><input value={port} onChange={e => setPort(e.target.value.replace(/\D/g, ''))} style={INPUT} /></div>
        </div>
        <div className="flex gap-6 flex-wrap">
          <Toggle checked={enabled} onChange={setEnabled} label="Enabled" />
          {inst?.kind === 'npm' && <Toggle checked={ws} onChange={setWs} label="Websockets" />}
        </div>

        {inst?.kind === 'npm' && (
          <div className="grid gap-3 rounded-md p-4" style={{ border: '1px solid var(--border-soft)' }}>
            <div style={LABEL}>NPM options</div>
            <div>
              <label style={LABEL}>Certificate</label>
              <select value={npm.certificate_id === false ? '' : String(npm.certificate_id)} onChange={e => setNpm(x => ({ ...x, certificate_id: e.target.value ? Number(e.target.value) : false }))} style={INPUT}>
                <option value="">None</option>
                {certs.map(c => <option key={c.id} value={c.id}>#{c.id} {c.names.join(', ')}{c.expiresAt ? ` (until ${c.expiresAt.slice(0, 10)})` : ''}</option>)}
              </select>
            </div>
            <div className="flex gap-2 items-end">
              <div className="flex-1"><label style={LABEL}>Let’s Encrypt email (new certificate)</label><input value={certEmail} onChange={e => setCertEmail(e.target.value)} placeholder="you@example.com" style={INPUT} /></div>
              <button onClick={requestCert} disabled={busy || !certEmail} style={{ ...BTN_SECONDARY, opacity: busy || !certEmail ? 0.5 : 1 }}>Request</button>
            </div>
            <div className="flex gap-x-6 gap-y-2 flex-wrap">
              {([['ssl_forced', 'Force HTTPS'], ['block_exploits', 'Block exploits'], ['http2_support', 'HTTP/2'], ['hsts_enabled', 'HSTS'], ['hsts_subdomains', 'HSTS subdomains'], ['caching_enabled', 'Caching']] as const)
                .map(([k, l]) => <Toggle key={k} checked={npm[k]} onChange={v => setNpm(x => ({ ...x, [k]: v }))} label={l} />)}
            </div>
            <div><label style={LABEL}>Advanced configuration</label>
              <textarea value={npm.advanced_config} onChange={e => setNpm(x => ({ ...x, advanced_config: e.target.value }))} rows={4} style={{ ...INPUT, padding: 10 }} /></div>
          </div>
        )}

        {msg && <div className="text-sm" style={{ color: 'var(--text-soft)' }}>{msg}</div>}
        {error && <div className="text-sm" style={{ color: 'var(--crit-2)' }}>{error}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} style={BTN_SECONDARY}>Cancel</button>
          <button onClick={preview} disabled={busy || !instanceId} style={{ ...BTN_PRIMARY, opacity: busy ? 0.6 : 1 }}>Preview</button>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
//  Instances: Bring Your Own or Managed, any kind, any number
// ---------------------------------------------------------------------------

function InstanceForm({ kinds, onClose, onSaved }: { kinds: KindInfo[]; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<Kind>('npm')
  const info = kinds.find(k => k.kind === kind)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [mode, setMode] = useState<'byo' | 'managed'>('byo')
  const [node, setNode] = useState('')
  const [vmid, setVmid] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [health, setHealth] = useState<Health | null>(null)

  useEffect(() => {
    setValues(Object.fromEntries((info?.fields ?? []).filter(f => f.default).map(f => [f.key, f.default!])))
  }, [kind, info])

  const save = async () => {
    setBusy(true); setError(null)
    const settings: Record<string, string> = {}, secrets: Record<string, string> = {}
    for (const f of info?.fields ?? []) if (values[f.key]) (f.secret ? secrets : settings)[f.key] = values[f.key]
    try {
      const r = await api<{ instance: Instance; health: Health }>('/api/proxy/instances', { method: 'POST', body: JSON.stringify({
        kind, name, url, mode, settings, secrets, ...(mode === 'managed' ? { managed: { node, vmid: Number(vmid), recipe: kind } } : {}),
      }) })
      setHealth(r.health)
      onSaved()
    } catch (e: any) { setError(e.message) }
    finally { setBusy(false) }
  }

  if (health) return (
    <Modal title={health.ok ? 'Instance added' : 'Added, but not answering yet'} eyebrow={name} onClose={onClose}>
      <HealthList health={health} />
      <div className="flex justify-end mt-4"><button onClick={onClose} style={BTN_PRIMARY}>Done</button></div>
    </Modal>
  )

  return (
    <Modal title="Add a proxy" eyebrow="Proxy instances" onClose={onClose} wide>
      <div className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label style={LABEL}>Kind</label>
            <select value={kind} onChange={e => setKind(e.target.value as Kind)} style={INPUT}>
              {kinds.map(k => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </select></div>
          <div><label style={LABEL}>Name <span aria-hidden style={{ color: 'var(--crit)' }}>*</span><span className="sr-only"> (required)</span></label><input value={name} onChange={e => setName(e.target.value)} placeholder="edge" style={INPUT} required aria-required="true" /></div>
        </div>
        <div><label style={LABEL}>{info?.urlLabel ?? 'URL'}</label><input value={url} onChange={e => setUrl(e.target.value)} placeholder={info?.urlHint} style={INPUT} /></div>
        <div>
          <label style={LABEL}>Who runs it</label>
          <div className="flex gap-2">
            {(['byo', 'managed'] as const).map(m => (
              <button key={m} onClick={() => setMode(m)} className="text-sm px-3 py-1.5 rounded-md" style={{
                background: mode === m ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
                color: mode === m ? 'var(--accent)' : 'var(--text-dim)', border: `1px solid ${mode === m ? 'var(--accent)' : 'var(--border-strong)'}`,
              }}>{m === 'byo' ? 'Bring your own' : 'Managed by HyperProx'}</button>
            ))}
          </div>
          <div className="text-xs mt-1" style={{ color: 'var(--text-dim)' }}>
            {mode === 'byo' ? 'A proxy you run; HyperProx uses the login you give it.' : 'Installed by the Catalogue into a container HyperProx knows, so Updates can update it.'}
          </div>
        </div>
        {mode === 'managed' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label style={LABEL}>Node</label><input value={node} onChange={e => setNode(e.target.value)} style={INPUT} /></div>
            <div><label style={LABEL}>Container id</label><input value={vmid} onChange={e => setVmid(e.target.value.replace(/\D/g, ''))} style={INPUT} /></div>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {(info?.fields ?? []).filter(f => f.key !== 'ssh_host_key').map(f => (
            <div key={f.key} className={f.key === 'ssh_private_key' || f.key === 'file' ? 'sm:col-span-2' : ''}>
              <label style={LABEL}>{f.label}{f.required === true ? ' *' : ''}</label>
              {f.options ? (
                <select value={values[f.key] ?? ''} onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))} style={INPUT}>
                  {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : f.key === 'ssh_private_key' ? (
                <textarea value={values[f.key] ?? ''} onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))} rows={3} style={{ ...INPUT, padding: 10 }} />
              ) : (
                <input type={f.secret ? 'password' : 'text'} value={values[f.key] ?? ''} onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))} style={INPUT} autoComplete="off" />
              )}
              {f.help && <div className="text-xs mt-1" style={{ color: 'var(--text-dim)' }}>{f.help}</div>}
            </div>
          ))}
        </div>
        {(info?.notes ?? []).map((x, i) => <div key={i} className="text-xs" style={{ color: 'var(--text-soft)' }}>{x}</div>)}
        <div className="text-xs" style={{ color: 'var(--text-dim)' }}>Passwords, keys and tokens are stored in the vault, never in the database.</div>
        {error && <div className="text-sm" style={{ color: 'var(--crit-2)' }}>{error}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} style={BTN_SECONDARY}>Cancel</button>
          <button onClick={save} disabled={busy || !name || !url} style={{ ...BTN_PRIMARY, opacity: busy || !name || !url ? 0.6 : 1 }}>{busy ? 'Checking…' : 'Add and test'}</button>
        </div>
      </div>
    </Modal>
  )
}

function HealthList({ health }: { health: Health }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {health.checks.map((c, i) => {
        const col = c.ok ? 'var(--good)' : c.warn ? 'var(--warn-2)' : 'var(--crit-2)'
        return <li key={i} className="text-sm pl-3" style={{ borderLeft: `2px solid ${col}`, color: 'var(--text)' }}>
          <span className="font-mono" style={{ color: col }}>{c.name}</span> — {c.detail}
        </li>
      })}
    </ul>
  )
}

function InstancesPanel({ instances, kinds, admin, onChanged }: { instances: Instance[]; kinds: KindInfo[]; admin: boolean; onChanged: () => void }) {
  const [adding, setAdding] = useState(false)
  const [health, setHealth] = useState<Record<string, Health | 'checking'>>({})
  const [error, setError] = useState<string | null>(null)

  const check = async (id: string) => {
    setHealth(h => ({ ...h, [id]: 'checking' }))
    try { const r = await api<Health>(`/api/proxy/instances/${id}/health`); setHealth(h => ({ ...h, [id]: r })) }
    catch (e: any) { setHealth(h => ({ ...h, [id]: { ok: false, checks: [{ name: 'api', ok: false, detail: e.message }] } })) }
  }
  const remove = async (i: Instance) => {
    if (!confirm(`Forget "${i.name}"? HyperProx stops showing and managing it; nothing on the proxy itself changes.`)) return
    setError(null)
    try { await api(`/api/proxy/instances/${i.id}`, { method: 'DELETE' }); onChanged() } catch (e: any) { setError(e.message) }
  }

  return (
    <Panel title="Proxies" sub={`${instances.length} connected`}
      actions={admin ? <button onClick={() => setAdding(true)} className={styles.btn} style={{ minHeight: 32, padding: '4px 12px', color: 'var(--accent)' }}>+ Add proxy</button> : undefined}>
      {instances.length === 0 && <div className={styles.empty}>No proxy is connected yet. Add one, or set the NPM login in Settings → Proxy.</div>}
      <div className="grid gap-2">
        {instances.map(i => {
          const h = health[i.id]
          return (
            <div key={i.id} className="rounded-md p-3" style={{ border: '1px solid var(--border-soft)', background: 'var(--ground-deep)' }}>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge label={KIND_SHORT[i.kind]} color={KIND_COLOR[i.kind]} />
                <span className="font-display" style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-bright)' }}>{i.name}</span>
                <Badge label={i.mode === 'managed' ? 'MANAGED' : 'BRING YOUR OWN'} color={i.mode === 'managed' ? 'var(--good)' : 'var(--text-muted)'}
                  title={i.mode === 'managed' && i.managed ? `Container ${i.managed.vmid} on ${i.managed.node}` : 'Credentials given to HyperProx'} />
                {i.legacy && <Badge label="SETTINGS LOGIN" color="var(--text-dim)" title="The NPM login in Settings → Proxy" />}
                {i.status && i.status !== 'ok' && <Badge label={i.status === 'locked' ? 'LOCKED' : 'UNAVAILABLE'} color="var(--warn-2)" title="Its login cannot be read until HyperProx is unlocked" />}
                {i.url && <span className="font-mono text-xs" style={{ color: 'var(--text-dim)' }}>{i.url}</span>}
                <div className="ml-auto flex gap-2">
                  <button onClick={() => check(i.id)} className="text-xs px-2 py-1 rounded" style={{ color: 'var(--text-soft)', border: '1px solid var(--border-strong)' }}>{h === 'checking' ? 'Checking…' : 'Check'}</button>
                  {admin && !i.legacy && <button onClick={() => remove(i)} className="text-xs px-2 py-1 rounded" style={{ color: 'var(--crit-2)', border: '1px solid var(--border-strong)' }}>Forget</button>}
                </div>
              </div>
              {admin && i.settings?.ssh_host_key && <div className="text-xs font-mono mt-1" style={{ color: 'var(--text-dim)' }}>SSH host key pinned: {i.settings.ssh_host_key}</div>}
              {h && h !== 'checking' && <div className="mt-2"><HealthList health={h} /></div>}
            </div>
          )
        })}
      </div>
      {error && <div className="text-sm mt-2" style={{ color: 'var(--crit-2)' }}>{error}</div>}
      {adding && <InstanceForm kinds={kinds} onClose={() => setAdding(false)} onSaved={onChanged} />}
    </Panel>
  )
}

// ---------------------------------------------------------------------------
//  Host table
// ---------------------------------------------------------------------------

function HostRow({ h, admin, onEdit, onAction }: { h: HostView; admin: boolean; onEdit: (h: HostView) => void; onAction: (h: HostView, a: 'enable' | 'disable' | 'delete') => void }) {
  const days = daysLeft(h.tls.expiresAt)
  const tlsCol = h.tls.kind === 'none' ? 'var(--text-dim)' : days !== null && days < 0 ? 'var(--crit-2)' : days !== null && days < 30 ? 'var(--warn-2)' : 'var(--good)'
  const tlsLabel = h.tls.kind === 'none' ? 'No TLS' : h.tls.kind === 'auto' ? 'Auto TLS' : 'Certificate'
  const dot = !h.enabled ? 'var(--text-dim)' : h.online === false ? 'var(--warn-2)' : 'var(--good)'
  return (
    <tr style={{ borderBottom: '1px solid var(--border-soft)' }}>
      <td className="px-4 py-3 w-6"><div className="w-2 h-2 rounded-full" style={{ background: dot }} title={h.enabled ? (h.online === false ? 'Enabled, not answering' : 'Enabled') : 'Disabled'} /><span className="sr-only">{h.enabled ? (h.online === false ? 'Enabled, not answering' : 'Enabled') : 'Disabled'}</span></td>
      <td className="px-4 py-3">
        <div className="font-mono text-sm" style={{ color: 'var(--text-bright)' }}>{h.domains[0] ?? <span style={{ color: 'var(--text-dim)' }}>(no Host rule)</span>}</div>
        {h.domains.length > 1 && <div className="text-xs" style={{ color: 'var(--text-dim)' }} title={h.domains.join(', ')}>+{h.domains.length - 1} more</div>}
        {h.detail && h.kind !== 'npm' && <div className="text-xs font-mono truncate" style={{ color: 'var(--text-dim)', maxWidth: 360 }} title={h.detail}>{h.detail}</div>}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2"><Badge label={KIND_SHORT[h.kind]} color={KIND_COLOR[h.kind]} /><span className="text-sm" style={{ color: 'var(--text)' }}>{h.instanceName}</span></div>
      </td>
      <td className="px-4 py-3"><span className="text-xs font-mono" style={{ color: 'var(--text-soft)' }}>{h.forwardHost ? `${h.forwardScheme}://${h.forwardHost}:${h.forwardPort}` : '—'}</span></td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <Badge label={tlsLabel} color={tlsCol} />
          {days !== null && <span className="text-xs font-mono" style={{ color: days < 14 ? 'var(--crit-2)' : 'var(--text-dim)' }}>{days}d</span>}
        </div>
      </td>
      <td className="px-4 py-3">
        {h.readOnly ? <Badge label="READ-ONLY" color="var(--text-muted)" title={h.readOnlyReason ?? 'Made outside HyperProx; never rewritten'} />
          : admin ? (
            <div className="flex items-center gap-1">
              <button onClick={() => onEdit(h)} className="px-3 py-1 rounded-md text-sm" style={{ color: 'var(--accent)', border: '1px solid var(--accent)' }}>Edit</button>
              <button onClick={() => onAction(h, h.enabled ? 'disable' : 'enable')} className="px-3 py-1 rounded-md text-sm"
                style={{ color: h.enabled ? 'var(--crit)' : 'var(--good)', border: `1px solid ${h.enabled ? 'var(--crit)' : 'var(--good)'}` }}>{h.enabled ? 'Off' : 'On'}</button>
              <button onClick={() => onAction(h, 'delete')} className="px-2 py-1 rounded-md text-sm" style={{ color: 'var(--text-dim)' }} aria-label="Delete">✕</button>
            </div>
          ) : null}
      </td>
    </tr>
  )
}

/** A host as a tile: its domain, a state pill and an SSL pill (both in words), and the flow domain → proxy → upstream. */
function HostTile({ h }: { h: HostView }) {
  const days = daysLeft(h.tls.expiresAt)
  const state: { text: string; tone: PillTone | undefined } = !h.enabled ? { text: 'disabled', tone: undefined }
    : h.online === false ? { text: 'not answering', tone: 'warn' } : { text: 'live', tone: 'good' }
  const tls: { text: string; tone: PillTone | undefined } = h.tls.kind === 'none' ? { text: 'no TLS', tone: undefined }
    : days !== null && days < 0 ? { text: 'cert expired', tone: 'bad' }
    : days !== null && days < 30 ? { text: `TLS ${days}d left`, tone: 'warn' }
    : { text: h.tls.kind === 'auto' ? 'auto TLS' : 'TLS ok', tone: 'good' }
  const upstream = h.forwardHost ? `${h.forwardHost}:${h.forwardPort}` : null
  return (
    <li className="rounded-lg p-3" style={{ background: 'var(--ground-deep)', border: '1px solid var(--border-soft)', minWidth: 0, opacity: h.enabled ? 1 : 0.7 }}>
      <div className="font-mono text-sm" style={{ color: 'var(--text-bright)', overflowWrap: 'anywhere' }}>
        {h.domains[0] ?? <span style={{ color: 'var(--text-dim)' }}>(no Host rule)</span>}
        {h.domains.length > 1 && <span className="text-xs" style={{ color: 'var(--text-dim)' }} title={h.domains.join(', ')}> +{h.domains.length - 1}</span>}
      </div>
      <div className="flex gap-1.5 flex-wrap mt-2">
        <Pill tone={state.tone}>{state.text}</Pill>
        <Pill tone={tls.tone}>{tls.text}</Pill>
        {h.readOnly && <Pill title={h.readOnlyReason ?? 'Made outside HyperProx; never rewritten'}>read-only</Pill>}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap mt-2 font-mono text-xs" style={{ color: 'var(--text-soft)' }} aria-label={`Flow: domain to ${h.instanceName} to ${upstream ?? 'no upstream'}`}>
        <span>domain</span><span aria-hidden style={{ color: 'var(--accent)' }}>→</span>
        <span title={KIND_SHORT[h.kind]}>{h.instanceName}</span><span aria-hidden style={{ color: 'var(--accent)' }}>→</span>
        <span style={{ overflowWrap: 'anywhere' }}>{upstream ? `${h.forwardScheme}://${upstream}` : 'no upstream'}</span>
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------
//  Page
// ---------------------------------------------------------------------------

export default function ProxyPage() {
  const { role } = useSession()
  const admin = atLeast(role, 'admin')
  const [hosts, setHosts] = useState<HostView[]>([])
  const [failing, setFailing] = useState<Array<{ instanceName: string; error: string }>>([])
  const [instances, setInstances] = useState<Instance[]>([])
  const [kinds, setKinds] = useState<KindInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [only, setOnly] = useState<string>('all')
  const [filter, setFilter] = useState<'all' | 'enabled' | 'disabled' | 'read-only' | 'expiring'>('all')
  const [search, setSearch] = useState('')
  const [lastSync, setLastSync] = useState<Date | null>(null)
  const [editing, setEditing] = useState<HostView | null | undefined>(undefined)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [h, i, k] = await Promise.all([
        api<{ hosts: HostView[]; errors: Array<{ instanceName: string; error: string }> }>('/api/proxy/hosts'),
        api<Instance[]>('/api/proxy/instances'), api<KindInfo[]>('/api/proxy/kinds'),
      ])
      setHosts(h.hosts); setFailing(h.errors); setInstances(i); setKinds(k); setError(null); setLastSync(new Date())
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  // Poll only while the tab is visible; catch up as soon as it is shown again.
  useEffect(() => {
    load()
    const t = setInterval(() => { if (!document.hidden) load() }, 30_000)
    const onShow = () => { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', onShow)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onShow) }
  }, [load])

  const act = async (h: HostView, action: 'enable' | 'disable' | 'delete') => {
    setActionError(null)
    try { setPlan(await api<Plan>(`/api/proxy/instances/${h.instanceId}/preview`, { method: 'POST', body: JSON.stringify({ action, hostId: h.id }) })) }
    catch (e: any) { setActionError(e.message) }
  }

  const shown = useMemo(() => hosts
    .filter(h => only === 'all' || h.instanceId === only)
    .filter(h => {
      if (filter === 'enabled') return h.enabled
      if (filter === 'disabled') return !h.enabled
      if (filter === 'read-only') return h.readOnly
      if (filter === 'expiring') { const d = daysLeft(h.tls.expiresAt); return d !== null && d < 30 }
      return true
    })
    .filter(h => !search || h.domains.some(d => d.includes(search.toLowerCase())) || h.forwardHost.includes(search.toLowerCase()) || h.instanceName.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (a.domains[0] ?? '~').localeCompare(b.domains[0] ?? '~')), [hosts, only, filter, search])

  const counts = { total: hosts.length, enabled: hosts.filter(h => h.enabled).length, readOnly: hosts.filter(h => h.readOnly).length, tls: hosts.filter(h => h.tls.kind !== 'none').length }
  const writable = instances

  if (loading) return (
    <Page>
      <Panel title="Proxy"><p className={`${styles.empty} animate-pulse`} role="status">loading proxy hosts...</p></Panel>
    </Page>
  )

  const offline = hosts.filter(h => h.enabled && h.online === false).length
  const expiring = hosts.filter(h => { const d = daysLeft(h.tls.expiresAt); return d !== null && d < 30 }).length
  const chips: StatChip[] = [
    { label: 'hosts', value: counts.total },
    { label: 'enabled', value: counts.enabled, tone: 'good' },
    { label: 'with TLS', value: counts.tls },
    { label: 'certs expiring in 30 days', value: expiring, tone: expiring ? 'warn' : undefined },
  ]
  const title = failing.length ? `${failing.length} prox${failing.length === 1 ? 'y is' : 'ies are'} not answering`
    : offline ? `${offline} host${offline === 1 ? ' is' : 's are'} not answering`
    : `${counts.enabled} of ${counts.total} hosts are live`

  const TILE_LIMIT = 24
  const tiles = shown.slice(0, TILE_LIMIT)

  return (
    <Page>
      <HudHeader
        eyebrow="Reverse proxies"
        title={title}
        icon="router"
        level={2}
        chips={chips}
        label="Proxy overview"
        actions={<>
          {lastSync && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>synced {lastSync.toLocaleTimeString()}</span>}
          {admin && writable.length > 0 && (
            <button onClick={() => setEditing(null)} className={`${styles.btn} ${styles.btnPri}`}>+ New Host</button>
          )}
        </>}
      />

      {error && <div className={styles.callout} role="alert" style={{ color: 'var(--crit)' }}>{error}</div>}
      {failing.map((f, i) => (
        <div key={i} className={styles.callout} role="alert" style={{ color: 'var(--warn)' }}>
          {f.instanceName} is not answering: {f.error}. Its hosts are not shown.
        </div>
      ))}

      <InstancesPanel instances={instances} kinds={kinds} admin={admin} onChanged={load} />

      <Panel title="Hosts" sub={`${shown.length} shown`}>
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <select value={only} onChange={e => setOnly(e.target.value)} aria-label="Show hosts from one proxy" className={styles.input} style={{ width: 'auto' }}>
            <option value="all">All proxies</option>
            {instances.map(i => <option key={i.id} value={i.id}>{i.name} ({KIND_SHORT[i.kind]})</option>)}
          </select>
          <div className="flex gap-1 flex-wrap" role="group" aria-label="Filter hosts">
            {(['all', 'enabled', 'disabled', 'read-only', 'expiring'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f} className="text-sm px-3 py-1.5 rounded-md capitalize" style={{
                background: filter === f ? alpha('var(--accent)', 12) : 'transparent',
                color: filter === f ? 'var(--accent)' : 'var(--text-muted)', border: `1px solid ${filter === f ? 'var(--accent)' : 'var(--border-strong)'}`,
              }}>{f}</button>
            ))}
          </div>
          <input type="text" placeholder="Search domain, host or proxy..." aria-label="Search hosts" value={search} onChange={e => setSearch(e.target.value)}
            className={`${styles.input} sm:ml-auto sm:w-64`} style={{ width: undefined }} />
        </div>
        {actionError && <div className="text-sm mb-3" role="alert" style={{ color: 'var(--crit)' }}>{actionError}</div>}

        {shown.length === 0 ? <p className={styles.empty}>No hosts match the current filter</p> : (
          <ul className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 17rem), 1fr))', listStyle: 'none', padding: 0, margin: 0 }} aria-label="Proxy hosts">
            {tiles.map(h => <HostTile key={`${h.instanceId}/${h.id}`} h={h} />)}
          </ul>
        )}
        {shown.length > TILE_LIMIT && (
          <p className={styles.empty} style={{ marginTop: 12 }}>Showing the first {TILE_LIMIT} of {shown.length}. The table below lists every host.</p>
        )}
      </Panel>

      <Details summary="Host table" sub="every host, with edit, on/off and delete" open={false}>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col"><span className="sr-only">State</span></th>
                {['Domain', 'Proxy', 'Target', 'TLS'].map(h => <th key={h} scope="col">{h}</th>)}
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.map(h => <HostRow key={`${h.instanceId}/${h.id}`} h={h} admin={admin} onEdit={setEditing} onAction={act} />)}
              {shown.length === 0 && <tr><td colSpan={6} className="text-center" style={{ color: 'var(--text-muted)' }}>No hosts match the current filter</td></tr>}
            </tbody>
          </table>
        </div>
      </Details>

      {editing !== undefined && <HostForm host={editing} instances={writable} onClose={() => setEditing(undefined)} onPlan={p => { setEditing(undefined); setPlan(p) }} />}
      {plan && <PlanDialog plan={plan} onClose={() => setPlan(null)} onDone={load} />}
    </Page>
  )
}
