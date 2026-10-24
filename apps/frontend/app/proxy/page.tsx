'use client'

import { useEffect, useState, useCallback } from 'react'
import { alpha } from '@/lib/theme'

// ---------------------------------------------------------------------------
//  Types
// ---------------------------------------------------------------------------

interface Certificate {
  id:           number
  nice_name:    string
  domain_names: string[]
  expires_on:   string
  provider:     string
}

interface ProxyHost {
  id:                      number
  domain_names:            string[]
  forward_host:            string
  forward_port:            number
  forward_scheme:          string
  certificate_id:          number | false
  ssl_forced:              boolean
  enabled:                 boolean
  block_exploits:          boolean
  allow_websocket_upgrade: boolean
  http2_support:           boolean
  hsts_enabled:            boolean
  hsts_subdomains:         boolean
  caching_enabled:         boolean
  trust_forwarded_proto:   boolean
  advanced_config:         string
  created_on:              string
  modified_on:             string
  meta:        { nginx_online: boolean; nginx_err: string | null; letsencrypt_email?: string }
  certificate?: Certificate
}

interface Stats {
  total: number; enabled: number; disabled: number
  online: number; ssl: number; expiring: number; expired: number
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function daysUntilExpiry(expiresOn: string): number {
  return Math.floor((new Date(expiresOn).getTime() - Date.now()) / 86400000)
}

function sslStatus(host: ProxyHost): 'valid' | 'expiring' | 'expired' | 'none' {
  if (!host.certificate) return 'none'
  const d = daysUntilExpiry(host.certificate.expires_on)
  if (d < 0)  return 'expired'
  if (d < 30) return 'expiring'
  return 'valid'
}

const SSL_COLOR: Record<string, string> = { valid: 'var(--good)', expiring: 'var(--warn-2)', expired: 'var(--crit-2)', none: 'var(--text-dimmer)' }
const SSL_LABEL: Record<string, string> = { valid: '✓ SSL', expiring: '⚠ SSL', expired: '✗ SSL', none: 'No SSL' }

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

// ---------------------------------------------------------------------------
//  Toggle switch
// ---------------------------------------------------------------------------

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <div
        onClick={() => onChange(!checked)}
        className="relative rounded-full transition-colors duration-200"
        style={{ width: 32, height: 18, background: checked ? 'var(--accent)' : 'var(--text-faint)', border: `1px solid ${checked ? 'var(--accent)' : 'var(--text-dimmer)'}` }}
      >
        <div className="absolute top-0.5 rounded-full transition-all duration-200"
          style={{ width: 14, height: 14, background: 'var(--surface)', left: checked ? 14 : 2 }} />
      </div>
      <span style={{ fontSize: 14, color: checked ? 'var(--text-bright)' : 'var(--text-soft)' }}>{label}</span>
    </label>
  )
}

// ---------------------------------------------------------------------------
//  Create / Edit modal
// ---------------------------------------------------------------------------

const EMPTY_FORM = {
  domain_names:            [''],
  forward_scheme:          'http',
  forward_host:            '',
  forward_port:            80,
  ssl_forced:              false,
  block_exploits:          true,
  allow_websocket_upgrade: false,
  http2_support:           false,
  hsts_enabled:            false,
  hsts_subdomains:         false,
  caching_enabled:         false,
  trust_forwarded_proto:   false,
  advanced_config:         '',
  // SSL options
  requestSSL:              false,
  letsencrypt_email:       '',
}

type FormState = typeof EMPTY_FORM

function HostModal({
  host, certs, onClose, onSave,
}: {
  host:    ProxyHost | null
  certs:   Certificate[]
  onClose: () => void
  onSave:  () => void
}) {
  const isEdit = !!host
  const [form, setForm]       = useState<FormState>(() => {
    if (!host) return EMPTY_FORM
    return {
      domain_names:            host.domain_names,
      forward_scheme:          host.forward_scheme,
      forward_host:            host.forward_host,
      forward_port:            host.forward_port,
      ssl_forced:              host.ssl_forced,
      block_exploits:          host.block_exploits,
      allow_websocket_upgrade: host.allow_websocket_upgrade,
      http2_support:           host.http2_support,
      hsts_enabled:            host.hsts_enabled,
      hsts_subdomains:         host.hsts_subdomains,
      caching_enabled:         host.caching_enabled,
      trust_forwarded_proto:   host.trust_forwarded_proto,
      advanced_config:         host.advanced_config ?? '',
      requestSSL:              false,
      letsencrypt_email:       host.meta?.letsencrypt_email ?? '',
    }
  })

  const [saving,  setSaving]  = useState(false)
  const [status,  setStatus]  = useState<string | null>(null)
  const [error,   setError]   = useState<string | null>(null)
  const [certId,  setCertId]  = useState<number | false>(host?.certificate_id ?? false)
  const [tab,     setTab]     = useState<'details' | 'ssl' | 'advanced'>('details')

  const set = (k: keyof FormState, v: any) => setForm(f => ({ ...f, [k]: v }))

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setStatus(null)

    try {
      let finalCertId: number | false | 0 = certId

      // Step 1 — request new cert if checked
      if (form.requestSSL && !isEdit) {
        setStatus('Requesting Let\'s Encrypt certificate...')
        const certRes = await fetch('/api/proxy/certificates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            domain_names:      form.domain_names.filter(Boolean),
            provider:          'letsencrypt',
            nice_name:         form.domain_names[0],
            letsencrypt_email: form.letsencrypt_email,
          }),
        })
        const certJson = await certRes.json()
        if (!certJson.success) throw new Error(certJson.error ?? 'Certificate request failed')
        finalCertId = certJson.data.id
        setStatus('Certificate obtained. Saving host...')
      }

      // Step 2 — create or update host
      const payload = {
        domain_names:            form.domain_names.filter(Boolean),
        forward_scheme:          form.forward_scheme,
        forward_host:            form.forward_host,
        forward_port:            Number(form.forward_port),
        certificate_id:          finalCertId || 0,
        ssl_forced:              form.ssl_forced,
        block_exploits:          form.block_exploits,
        allow_websocket_upgrade: form.allow_websocket_upgrade,
        http2_support:           form.http2_support,
        hsts_enabled:            form.hsts_enabled,
        hsts_subdomains:         form.hsts_subdomains,
        caching_enabled:         form.caching_enabled,
        trust_forwarded_proto:   form.trust_forwarded_proto,
        advanced_config:         form.advanced_config,
        meta: {
          letsencrypt_agree: form.requestSSL,
          letsencrypt_email: form.letsencrypt_email,
          dns_challenge:     false,
        },
      }

      const url    = isEdit ? `/api/proxy/hosts/${host!.id}` : '/api/proxy/hosts'
      const method = isEdit ? 'PUT' : 'POST'

      const res  = await fetch(url, {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (!json.success) throw new Error(json.error ?? 'Failed to save host')

      setStatus('Saved!')
      setTimeout(() => { onSave(); onClose() }, 600)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(4px)' }}>
      <div className="w-full max-w-2xl rounded-xl border overflow-hidden" style={{
        background: 'var(--surface-raised)', borderColor: 'color-mix(in srgb, var(--accent) 15%, transparent)',
        boxShadow: '0 0 40px color-mix(in srgb, var(--accent) 3%, transparent)',
      }}>

        {/* Modal header */}
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'var(--border-dim)' }}>
          <div className="flex items-center gap-3">
            <div className="w-1 h-5 rounded-full" style={{ background: 'var(--accent)', boxShadow: '0 0 8px var(--accent)' }} />
            <h2 className="font-display" style={{ color: 'var(--text-bright)', fontSize: 22, fontWeight: 600 }}>
              {isEdit ? 'Edit Proxy Host' : 'New Proxy Host'}
            </h2>
          </div>
          <button onClick={onClose} style={{ color: 'var(--text-dimmer)', fontSize: 20, lineHeight: 1 }}>✕</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b" style={{ borderColor: 'var(--border-dim)' }}>
          {(['details', 'ssl', 'advanced'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className="px-5 py-3 text-sm font-semibold transition-colors capitalize"
              style={{
                borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
                color: tab === t ? 'var(--accent)' : 'var(--text-dim)',
                background: 'transparent',
              }}>{t}</button>
          ))}
        </div>

        {/* Tab content */}
        <div className="p-6 space-y-4 overflow-y-auto" style={{ maxHeight: '60vh' }}>

          {/* DETAILS TAB */}
          {tab === 'details' && (
            <>
              <div>
                <label style={LABEL}>Domain Name(s)</label>
                {form.domain_names.map((d, i) => (
                  <div key={i} className="flex gap-2 mb-2">
                    <input
                      style={INPUT} value={d} placeholder="domain.example.com"
                      onChange={e => {
                        const arr = [...form.domain_names]
                        arr[i] = e.target.value
                        set('domain_names', arr)
                      }}
                    />
                    {i === form.domain_names.length - 1 ? (
                      <button onClick={() => set('domain_names', [...form.domain_names, ''])}
                        className="px-3 rounded-md text-sm"
                        style={{ background: 'transparent', color: 'var(--accent)', border: '1px solid var(--accent)', whiteSpace: 'nowrap' }}>
                        + Add
                      </button>
                    ) : (
                      <button onClick={() => set('domain_names', form.domain_names.filter((_, j) => j !== i))}
                        className="px-3 rounded-md text-sm"
                        style={{ background: 'transparent', color: 'var(--crit)', border: '1px solid var(--crit)' }}>
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-4 gap-3">
                <div>
                  <label style={LABEL}>Scheme</label>
                  <select style={{ ...INPUT, cursor: 'pointer' }} value={form.forward_scheme}
                    onChange={e => set('forward_scheme', e.target.value)}>
                    <option value="http">http</option>
                    <option value="https">https</option>
                  </select>
                </div>
                <div className="col-span-2">
                  <label style={LABEL}>Forward Host / IP</label>
                  <input style={INPUT} value={form.forward_host} placeholder="10.0.0.x or hostname"
                    onChange={e => set('forward_host', e.target.value)} />
                </div>
                <div>
                  <label style={LABEL}>Port</label>
                  <input style={INPUT} type="number" value={form.forward_port}
                    onChange={e => set('forward_port', Number(e.target.value))} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2">
                <Toggle checked={form.block_exploits}          onChange={v => set('block_exploits', v)}          label="Block Common Exploits" />
                <Toggle checked={form.allow_websocket_upgrade} onChange={v => set('allow_websocket_upgrade', v)} label="WebSocket Support" />
                <Toggle checked={form.caching_enabled}         onChange={v => set('caching_enabled', v)}         label="Cache Assets" />
                <Toggle checked={form.trust_forwarded_proto}   onChange={v => set('trust_forwarded_proto', v)}   label="Trust Forwarded IP" />
              </div>
            </>
          )}

          {/* SSL TAB */}
          {tab === 'ssl' && (
            <>
              {/* Existing cert selector */}
              <div>
                <label style={LABEL}>SSL Certificate</label>
                <select
                  style={{ ...INPUT, cursor: 'pointer' }}
                  value={typeof certId === 'number' ? certId : 0}
                  onChange={e => {
                    const v = Number(e.target.value)
                    setCertId(v === 0 ? false : v)
                    if (v !== 0) set('requestSSL', false)
                  }}
                >
                  <option value={0}>No SSL</option>
                  {certs.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.nice_name} (exp. {new Date(c.expires_on).toLocaleDateString()})
                    </option>
                  ))}
                </select>
              </div>

              {!isEdit && (
                <div className="p-4 rounded-lg border" style={{ background: 'var(--ground-deep)', borderColor: 'var(--border-soft)' }}>
                  <Toggle checked={form.requestSSL} onChange={v => { set('requestSSL', v); if (v) setCertId(false) }}
                    label="Request new Let's Encrypt certificate" />
                  {form.requestSSL && (
                    <div className="mt-3">
                      <label style={LABEL}>Let's Encrypt Email</label>
                      <input style={INPUT} value={form.letsencrypt_email}
                        onChange={e => set('letsencrypt_email', e.target.value)} />
                      <div className="mt-2 text-sm" style={{ color: 'var(--text-soft)' }}>
                        DNS for {form.domain_names.filter(Boolean).join(', ') || 'your domain'} must point to NPM before saving.
                      </div>
                    </div>
                  )}
                </div>
              )}

              {(certId || form.requestSSL) && (
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <Toggle checked={form.ssl_forced}    onChange={v => set('ssl_forced', v)}    label="Force HTTPS" />
                  <Toggle checked={form.http2_support} onChange={v => set('http2_support', v)} label="HTTP/2" />
                  <Toggle checked={form.hsts_enabled}  onChange={v => set('hsts_enabled', v)}  label="HSTS" />
                  {form.hsts_enabled && (
                    <Toggle checked={form.hsts_subdomains} onChange={v => set('hsts_subdomains', v)} label="HSTS Subdomains" />
                  )}
                </div>
              )}
            </>
          )}

          {/* ADVANCED TAB */}
          {tab === 'advanced' && (
            <div>
              <label style={LABEL}>Custom Nginx Config</label>
              <textarea
                style={{ ...INPUT, height: 200, padding: '10px 12px', resize: 'vertical' as const }}
                value={form.advanced_config}
                placeholder="# Custom nginx directives..."
                onChange={e => set('advanced_config', e.target.value)}
              />
              <div className="mt-2 text-sm" style={{ color: 'var(--text-dim)' }}>
                Injected into the nginx location block for this host.
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t" style={{ borderColor: 'var(--border-dim)' }}>
          <div className="text-sm" style={{ color: error ? 'var(--crit-2)' : 'var(--good)' }}>
            {error ?? status ?? ''}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="transition-colors"
              style={BTN_SECONDARY}>
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving}
              className="transition-all"
              style={{
                ...BTN_PRIMARY,
                opacity: saving ? 0.5 : 1,
                cursor:  saving ? 'not-allowed' : 'pointer',
              }}>
              {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Host'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
//  Delete confirmation modal
// ---------------------------------------------------------------------------

function DeleteModal({ host, onClose, onDelete }: {
  host:     ProxyHost
  onClose:  () => void
  onDelete: () => void
}) {
  const [deleting, setDeleting] = useState(false)

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await fetch(`/api/proxy/hosts/${host.id}`, { method: 'DELETE' })
      onDelete()
      onClose()
    } catch (e) {
      setDeleting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(4px)' }}>
      <div className="w-full max-w-md rounded-xl border p-6" style={{
        background: 'var(--surface-raised)', borderColor: 'color-mix(in srgb, var(--crit-2) 15%, transparent)',
      }}>
        <h2 className="font-display mb-2" style={{ color: 'var(--crit-2)', fontSize: 22, fontWeight: 600 }}>Delete Proxy Host</h2>
        <p className="text-sm mb-1" style={{ color: 'var(--text-soft)' }}>This will permanently delete:</p>
        <p className="text-sm font-mono mb-4" style={{ color: 'var(--text-bright)' }}>
          {host.domain_names.join(', ')}
        </p>
        <p className="text-sm mb-6" style={{ color: 'var(--text-dim)' }}>
          The SSL certificate will not be deleted. The nginx configuration will be removed immediately.
        </p>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose}
            style={BTN_SECONDARY}>
            Cancel
          </button>
          <button onClick={handleDelete} disabled={deleting}
            style={{ ...BTN_SECONDARY, color: 'var(--crit)', borderColor: 'var(--crit)' }}>
            {deleting ? 'Deleting...' : 'Delete Host'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
//  Stat card
// ---------------------------------------------------------------------------

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg border p-4 flex flex-col gap-1" style={{ background: 'var(--surface)', borderColor: 'var(--border-soft)' }}>
      <div className="font-display" style={{ color, fontSize: 28, fontWeight: 700 }}>{value}</div>
      <div className="font-mono uppercase" style={{ color: 'var(--text-dim)', fontSize: 11, letterSpacing: '0.14em' }}>{label}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
//  Host row
// ---------------------------------------------------------------------------

function HostRow({ host, onEdit, onDelete, onToggle }: {
  host:     ProxyHost
  onEdit:   (h: ProxyHost) => void
  onDelete: (h: ProxyHost) => void
  onToggle: (id: number, enabled: boolean) => void
}) {
  const ssl    = sslStatus(host)
  const sslCol = SSL_COLOR[ssl]
  const days   = host.certificate ? daysUntilExpiry(host.certificate.expires_on) : null
  const target = `${host.forward_scheme}://${host.forward_host}:${host.forward_port}`

  return (
    <tr style={{ borderBottom: '1px solid var(--border-soft)' }}
      onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--surface)'}
      onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
    >
      <td className="px-4 py-3 w-6">
        <div className="w-2 h-2 rounded-full" style={{
          background:  host.enabled && host.meta?.nginx_online ? 'var(--good)' : host.enabled ? 'var(--warn-2)' : 'var(--text-dimmer)',
          boxShadow:   host.enabled && host.meta?.nginx_online ? '0 0 5px var(--good)' : 'none',
        }} />
      </td>
      <td className="px-4 py-3">
        <div className="font-mono text-sm" style={{ color: 'var(--text-bright)' }}>{host.domain_names[0]}</div>
        {host.domain_names.length > 1 && (
          <div className="text-xs" style={{ color: 'var(--text-dim)' }}>+{host.domain_names.length - 1} more</div>
        )}
      </td>
      <td className="px-4 py-3">
        <span className="text-xs font-mono" style={{ color: 'var(--text-soft)' }}>{target}</span>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono px-2 py-0.5 rounded" style={{
            background: `${alpha(sslCol, 8)}`, color: sslCol, border: `1px solid ${alpha(sslCol, 19)}`,
          }}>{SSL_LABEL[ssl]}</span>
          {days !== null && (
            <span className="text-xs font-mono" style={{ color: days < 14 ? 'var(--crit-2)' : 'var(--text-dimmer)' }}>{days}d</span>
          )}
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex gap-1 flex-wrap">
          {host.block_exploits          && <Badge label="SEC"   color="var(--violet-2)" />}
          {host.allow_websocket_upgrade && <Badge label="WS"    color="var(--accent-2)" />}
          {host.http2_support           && <Badge label="H2"    color="var(--accent-2)" />}
          {host.ssl_forced              && <Badge label="HTTPS" color="var(--good)" />}
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1">
          {/* Edit */}
          <button onClick={() => onEdit(host)}
            className="px-3 py-1 rounded-md text-sm transition-all"
            style={{ background: 'transparent', color: 'var(--accent)', border: '1px solid var(--accent)' }}>
            Edit
          </button>
          {/* Enable/Disable */}
          <button onClick={() => onToggle(host.id, host.enabled)}
            className="px-3 py-1 rounded-md text-sm transition-all"
            style={{
              background: 'transparent',
              color:      host.enabled ? 'var(--crit)'   : 'var(--good)',
              border:     `1px solid ${host.enabled ? 'var(--crit)' : 'var(--good)'}`,
            }}>
            {host.enabled ? 'Off' : 'On'}
          </button>
          {/* Delete */}
          <button onClick={() => onDelete(host)}
            className="px-2 py-1 rounded-md text-sm transition-all"
            style={{ background: 'transparent', color: 'var(--text-dimmer)', border: '1px solid transparent' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--crit-2)'; (e.currentTarget as HTMLElement).style.borderColor = 'color-mix(in srgb, var(--crit-2) 19%, transparent)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text-dimmer)'; (e.currentTarget as HTMLElement).style.borderColor = 'transparent' }}
          >✕</button>
        </div>
      </td>
    </tr>
  )
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span className="font-mono px-1 py-0.5 rounded" style={{
      fontSize: 9, background: `${alpha(color, 8)}`, color, border: `1px solid ${alpha(color, 15)}`,
    }}>{label}</span>
  )
}

// ---------------------------------------------------------------------------
//  Main proxy page
// ---------------------------------------------------------------------------

export default function ProxyPage() {
  const [hosts,     setHosts]     = useState<ProxyHost[]>([])
  const [certs,     setCerts]     = useState<Certificate[]>([])
  const [stats,     setStats]     = useState<Stats | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [filter,    setFilter]    = useState<'all' | 'enabled' | 'disabled' | 'expiring'>('all')
  const [search,    setSearch]    = useState('')
  const [lastSync,  setLastSync]  = useState<Date | null>(null)
  const [editHost,  setEditHost]  = useState<ProxyHost | null | undefined>(undefined) // undefined=closed, null=new
  const [deleteHost, setDeleteHost] = useState<ProxyHost | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const [hostsRes, statsRes, certsRes] = await Promise.all([
        fetch('/api/proxy/hosts'),
        fetch('/api/proxy/stats'),
        fetch('/api/proxy/certificates'),
      ])
      const [hostsJson, statsJson, certsJson] = await Promise.all([
        hostsRes.json(), statsRes.json(), certsRes.json(),
      ])
      if (hostsJson.success) { setHosts(hostsJson.data); setError(null) }
      else { setHosts([]); setError(hostsJson.error ?? 'NPM not configured') }
      if (statsJson.success) setStats(statsJson.data)
      else setStats(null)
      if (certsJson.success) setCerts(certsJson.data)
      setLastSync(new Date())
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    fetchData()
    const t = setInterval(fetchData, 30000)
    return () => clearInterval(t)
  }, [fetchData])

  const handleToggle = async (id: number, enabled: boolean) => {
    await fetch(`/api/proxy/hosts/${id}/${enabled ? 'disable' : 'enable'}`, { method: 'POST' })
    fetchData()
  }

  const filtered = hosts
    .filter(h => {
      if (filter === 'enabled')  return h.enabled
      if (filter === 'disabled') return !h.enabled
      if (filter === 'expiring') { const s = sslStatus(h); return s === 'expiring' || s === 'expired' }
      return true
    })
    .filter(h => {
      if (!search) return true
      const q = search.toLowerCase()
      return h.domain_names.some(d => d.toLowerCase().includes(q)) || h.forward_host.toLowerCase().includes(q)
    })
    .sort((a, b) => a.domain_names[0].localeCompare(b.domain_names[0]))

  if (error) return (
    <div className="min-h-full flex items-center justify-center" style={{ background: "var(--ground)" }}>
      <div className="text-center">
        <div className="mb-4 flex justify-center" style={{ color: "var(--text-dimmer)" }}>
          {/* A plug with nothing to plug into: the proxy manager this page fronts is not reachable. */}
          <svg width="40" height="40" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 1.5v3M10 1.5v3" />
            <rect x="3.5" y="4.5" width="9" height="5" rx="1" />
            <path d="M8 9.5v3a2 2 0 0 0 2 2h1" />
          </svg>
        </div>
        <div className="font-display mb-2" style={{ color: "var(--text-bright)", fontSize: 28, fontWeight: 700 }}>NPM Not Connected</div>
        <div className="text-sm mb-6 max-w-sm" style={{ color: "var(--text-soft)" }}>{error}</div>
        <a href="/settings" className="px-4 py-2 rounded text-xs font-mono" style={{ background: "color-mix(in srgb, var(--accent) 8%, transparent)", color: "var(--accent)", border: "1px solid color-mix(in srgb, var(--accent) 19%, transparent)" }}>Configure in Settings →</a>
      </div>
    </div>
  )

  if (loading) return (
    <div className="min-h-full flex items-center justify-center" style={{ background: 'var(--ground)' }}>
      <div className="text-sm animate-pulse" style={{ color: 'var(--text-dim)' }}>loading proxy hosts...</div>
    </div>
  )

  return (
    <div className="min-h-full p-4 sm:p-8 lg:p-10" style={{ background: 'var(--ground)' }}>

      {/* Header */}
      <div className="flex items-end justify-between mb-8 flex-wrap gap-4">
        <div>
          <div className="font-mono uppercase mb-2" style={{ fontSize: 11, letterSpacing: '0.14em', color: 'var(--accent)' }}>NPM</div>
          <h1 className="font-display" style={{ fontSize: 36, fontWeight: 700, color: 'var(--text-bright)', lineHeight: 1.15 }}>
            Proxy Manager
          </h1>
        </div>
        <div className="flex items-center gap-3">
          {lastSync && <span className="text-xs" style={{ color: 'var(--text-dim)' }}>synced {lastSync.toLocaleTimeString()}</span>}
          <button
            onClick={() => setEditHost(null)}
            className="flex items-center gap-2 px-4 rounded-md text-sm transition-all"
            style={{ height: 40, background: 'var(--accent)', color: 'var(--accent-ink)', fontWeight: 600, border: 'none' }}
          >
            <span style={{ fontSize: 14 }}>+</span> New Host
          </button>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
          <StatCard label="Total"    value={stats.total}    color="var(--text-muted)" />
          <StatCard label="Enabled"  value={stats.enabled}  color="var(--good)" />
          <StatCard label="Disabled" value={stats.disabled} color="var(--text-dimmer)" />
          <StatCard label="Online"   value={stats.online}   color="var(--accent)" />
          <StatCard label="SSL"      value={stats.ssl}      color="var(--good)" />
          <StatCard label="Expiring" value={stats.expiring} color="var(--warn-2)" />
          <StatCard label="Expired"  value={stats.expired}  color="var(--crit-2)" />
        </div>
      )}

      {/* Filter + search */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="flex gap-1">
          {(['all', 'enabled', 'disabled', 'expiring'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className="text-sm px-3 py-1.5 rounded-md transition-colors capitalize"
              style={{
                background: filter === f ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
                color:      filter === f ? 'var(--accent)'   : 'var(--text-dim)',
                border:     `1px solid ${filter === f ? 'var(--accent)' : 'var(--border-strong)'}`,
              }}>{f}</button>
          ))}
        </div>
        <input
          type="text" placeholder="Search domain or host..." value={search}
          onChange={e => setSearch(e.target.value)}
          className="ml-auto text-sm px-3 rounded-md outline-none w-56 focus:border-[var(--accent)]"
          style={{ height: 36, background: 'var(--ground-deep)', border: '1px solid var(--border-strong)', color: 'var(--text-bright)', caretColor: 'var(--accent)' }}
        />
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>{filtered.length} hosts</span>
      </div>

      {/* Table */}
      <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border-soft)', background: 'var(--surface)' }}>
        <div className="hp-table-scroll overflow-x-auto"><table className="w-full">
          <thead>
            <tr style={{ background: 'var(--ground-deep)', borderBottom: '1px solid var(--border-soft)' }}>
              <th className="px-4 py-3 w-6" />
              {['Domain', 'Target', 'SSL', 'Features', 'Actions'].map(h => (
                <th key={h} className="px-4 py-3 text-left font-mono font-normal uppercase" style={{ color: 'var(--text-dim)', fontSize: 11, letterSpacing: '0.14em' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map(host => (
              <HostRow key={host.id} host={host}
                onEdit={setEditHost}
                onDelete={setDeleteHost}
                onToggle={handleToggle}
              />
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-sm" style={{ color: 'var(--text-dim)' }}>
                No hosts match the current filter
              </td></tr>
            )}
          </tbody>
        </table></div>
      </div>

      {/* Modals */}
      {editHost !== undefined && (
        <HostModal
          host={editHost}
          certs={certs}
          onClose={() => setEditHost(undefined)}
          onSave={fetchData}
        />
      )}
      {deleteHost && (
        <DeleteModal
          host={deleteHost}
          onClose={() => setDeleteHost(null)}
          onDelete={fetchData}
        />
      )}
    </div>
  )
}
