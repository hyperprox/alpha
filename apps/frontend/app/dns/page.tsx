'use client'

import { useEffect, useState, useCallback } from 'react'
import { alpha } from '@/lib/theme'
import { Details, GlowBars, HudHeader, Page, Panel, Pill, styles, type StatChip } from '@/components/visual/kit'
import { GlobeIcon, SplitIcon, MailIcon, CheckCircleIcon, WrenchIcon, LockIcon } from '@/components/dns/icons'

// ---------------------------------------------------------------------------
//  Types
// ---------------------------------------------------------------------------

type RecordType = 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'SRV' | 'NS' | 'CAA'

interface DNSRecord {
  type:      RecordType
  name:      string
  data:      string
  ttl:       number
  priority?: number
  /** Cloudflare only: traffic goes through Cloudflare (orange cloud). */
  proxied?:  boolean
  proxiable?: boolean
  /** Cloudflare only: which record this is, when a name holds several. */
  id?:       string
}

type ProviderId = 'godaddy' | 'cloudflare'

interface Domain {
  domain:    string
  domainId?: number
  status:    string
  expires?:  string
  renewAuto?: boolean
  locked?:   boolean
  provider?: ProviderId
  active?:   boolean
}

interface ProviderStatus {
  id: ProviderId; label: string; configured: boolean; ok: boolean; zones: number; active: number; error?: string
}

const PROVIDER_LABEL: Record<ProviderId, string> = { godaddy: 'GoDaddy', cloudflare: 'Cloudflare' }
const PROXIABLE = new Set(['A', 'AAAA', 'CNAME'])
const enc = encodeURIComponent
/** The record's own path, plus its id when Cloudflare has several values on the name. */
const recordPath = (domain: string, r: DNSRecord) =>
  `/api/dns/domains/${enc(domain)}/records/${enc(r.type)}/${enc(r.name)}${r.id ? `?id=${enc(r.id)}` : ''}`

function ttlLabel(ttl: number): string {
  if (ttl === 1) return 'Auto'
  return ttl >= 86400 ? `${ttl / 86400}d` : ttl >= 3600 ? `${ttl / 3600}h` : ttl >= 60 ? `${ttl / 60}m` : `${ttl}s`
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TYPE_COLORS: Record<string, string> = {
  A:     'var(--accent)',
  AAAA:  'var(--accent-2)',
  CNAME: 'var(--violet)',
  TXT:   'var(--warn)',
  MX:    'var(--good)',
  SRV:   'var(--warn)',
  NS:    'var(--text-muted)',
  CAA:   'var(--violet)',
}

const INPUT = {
  background: 'var(--ground-deep)', border: '1px solid var(--border-strong)',
  color: 'var(--text-bright)', borderRadius: 6, padding: '0 12px', minHeight: 40,
  fontFamily: 'IBM Plex Mono, monospace', fontSize: 13,
  outline: 'none', width: '100%',
} as React.CSSProperties

const LABEL = {
  display: 'block', fontSize: 11, color: 'var(--text-dim)',
  fontFamily: 'IBM Plex Mono, monospace',
  textTransform: 'uppercase' as const, letterSpacing: '0.14em', marginBottom: 6,
}

const BTN_SECONDARY = {
  background: 'transparent', color: 'var(--text)', border: '1px solid var(--border-strong)',
  borderRadius: 6, height: 40, padding: '0 16px', fontSize: 14, fontWeight: 500,
} as React.CSSProperties

const BTN_PRIMARY = {
  background: 'var(--accent)', color: 'var(--accent-ink)', border: 'none',
  borderRadius: 6, height: 40, padding: '0 20px', fontSize: 14, fontWeight: 600,
} as React.CSSProperties

function daysUntilExpiry(expires?: string): number | null {
  if (!expires) return null
  return Math.floor((new Date(expires).getTime() - Date.now()) / 86400000)
}

// ---------------------------------------------------------------------------
//  Record modal — create (wizard) / edit (direct form)
// ---------------------------------------------------------------------------

const EMPTY: DNSRecord = { type: 'A', name: '', data: '', ttl: 3600 }

// ---------------------------------------------------------------------------
// Intent definitions for the wizard
// ---------------------------------------------------------------------------
const INTENTS = [
  {
    id:    'point-server',
    Icon:  GlobeIcon,
    title: 'Point to this server',
    desc:  'Create an A record pointing to your WAN IP',
    type:  'A' as const,
  },
  {
    id:    'subdomain',
    Icon:  SplitIcon,
    title: 'Point subdomain elsewhere',
    desc:  'CNAME to another hostname or service',
    type:  'CNAME' as const,
  },
  {
    id:    'email',
    Icon:  MailIcon,
    title: 'Set up email',
    desc:  'Add MX records for your email provider',
    type:  'MX' as const,
  },
  {
    id:    'verify',
    Icon:  CheckCircleIcon,
    title: 'Verify domain ownership',
    desc:  'Add a TXT record for verification',
    type:  'TXT' as const,
  },
  {
    id:    'custom',
    Icon:  WrenchIcon,
    title: 'Custom record',
    desc:  'Full control — all record types',
    type:  null,
  },
]

const EMAIL_PROVIDERS: Record<string, { name: string; custom?: boolean; records: { priority: number; data: string }[] }> = {
  google: {
    name: 'Google Workspace',
    records: [
      { priority: 1,  data: 'aspmx.l.google.com.' },
      { priority: 5,  data: 'alt1.aspmx.l.google.com.' },
      { priority: 5,  data: 'alt2.aspmx.l.google.com.' },
      { priority: 10, data: 'alt3.aspmx.l.google.com.' },
      { priority: 10, data: 'alt4.aspmx.l.google.com.' },
    ],
  },
  microsoft: {
    name: 'Microsoft 365',
    records: [{ priority: 0, data: '<tenant>.mail.protection.outlook.com.' }],
  },
  proton: {
    name: 'Proton Mail',
    records: [
      { priority: 10, data: 'mail.protonmail.ch.' },
      { priority: 20, data: 'mailsec.protonmail.ch.' },
    ],
  },
  zoho: {
    name: 'Zoho Mail',
    records: [
      { priority: 10, data: 'mx.zoho.com.' },
      { priority: 20, data: 'mx2.zoho.com.' },
      { priority: 50, data: 'mx3.zoho.com.' },
    ],
  },
  fastmail: {
    name: 'Fastmail',
    records: [
      { priority: 10, data: 'in1-smtp.messagingengine.com.' },
      { priority: 20, data: 'in2-smtp.messagingengine.com.' },
    ],
  },
  icloud: {
    name: 'iCloud Mail',
    records: [
      { priority: 10, data: 'mx01.mail.icloud.com.' },
      { priority: 20, data: 'mx02.mail.icloud.com.' },
    ],
  },
  custom: {
    name: 'Custom / Other',
    custom: true,
    records: [{ priority: 10, data: '' }],
  },
}

function RecordModal({ record, domain, provider, onClose, onSave, wanIp }: {
  record:  DNSRecord | null
  domain:  string
  provider?: ProviderId
  onClose: () => void
  onSave:  () => void
  wanIp?:  string
}) {
  const isEdit = !!record
  const isCf = provider === 'cloudflare'
  const ttlOptions = [...(isCf ? [{ v: 1, l: 'Auto' }] : []), { v: 600, l: '10 min' }, { v: 1800, l: '30 min' }, { v: 3600, l: '1 hour' },
    { v: 14400, l: '4 hours' }, { v: 86400, l: '1 day' }]

  // Wizard state (create only)
  const [intent,        setIntent]        = useState<string | null>(null)
  const [emailProvider, setEmailProvider] = useState<string>('google')

  // Form state
  const [form,    setForm]    = useState<DNSRecord>(record ?? EMPTY)
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [status,  setStatus]  = useState<string | null>(null)

  const set = (k: keyof DNSRecord, v: any) => setForm(f => ({ ...f, [k]: v }))

  // When intent is selected, pre-fill the form
  const selectIntent = (id: string) => {
    setIntent(id)
    setError(null)
    if (id === 'point-server') {
      setForm({ type: 'A', name: '', data: wanIp || '', ttl: 600 })
    } else if (id === 'subdomain') {
      setForm({ type: 'CNAME', name: '', data: '', ttl: 3600 })
    } else if (id === 'email') {
      setForm({ type: 'MX', name: '@', data: '', ttl: 3600, priority: 10 })
    } else if (id === 'verify') {
      setForm({ type: 'TXT', name: '@', data: '', ttl: 600 })
    } else {
      setForm(EMPTY)
    }
  }

  // Save single record
  const saveRecord = async (rec: DNSRecord) => {
    const res = await fetch(`/api/dns/domains/${enc(domain)}/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // At Cloudflare a new record is DNS only unless the toggle below was switched on.
      body: JSON.stringify(isCf && PROXIABLE.has(rec.type) ? { ...rec, proxied: rec.proxied === true } : { ...rec, proxied: undefined }),
    })
    const json = await res.json()
    if (!json.success) throw new Error(json.error || 'Failed to create record')
  }

  const handleSave = async () => {
    setSaving(true); setError(null)
    try {
      if (isEdit) {
        const res = await fetch(recordPath(domain, record!), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          // The proxy setting is sent only at Cloudflare, and only as the toggle shows it (it starts as the record's own).
          body: JSON.stringify({ data: form.data, ttl: form.ttl, priority: form.priority,
            ...(isCf && PROXIABLE.has(form.type) ? { proxied: form.proxied === true } : {}) }),
        })
        const json = await res.json().catch(() => ({}))
        if (!json.success) throw new Error(json.error || 'Failed to save record')
      } else if (intent === 'email') {
        // Create all MX records for the selected provider
        const provider = EMAIL_PROVIDERS[emailProvider]
        for (const mx of provider.records) {
          await saveRecord({ type: 'MX', name: '@', data: mx.data, ttl: 3600, priority: mx.priority })
        }
      } else {
        if (!form.name || !form.data) { setError('Name and value are required'); setSaving(false); return }
        await saveRecord(form)
      }
      setStatus('Saved!')
      setTimeout(() => { onSave(); onClose() }, 500)
    } catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'var(--scrim)', backdropFilter: 'blur(4px)' }}>
      <div className="w-full max-w-lg rounded-xl border overflow-y-auto overscroll-contain max-h-[calc(100dvh-2rem)]"
        style={{ background: 'var(--surface-raised)', borderColor: 'color-mix(in srgb, var(--accent) 15%, transparent)', boxShadow: '0 0 40px color-mix(in srgb, var(--accent) 3%, transparent)' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border-dim)' }}>
          <div className="flex items-center gap-3">
            <div className="w-1 h-5 rounded-full" style={{ background: 'var(--accent)', boxShadow: '0 0 8px var(--accent)' }}/>
            <h2 className="font-display" style={{ color: 'var(--text-bright)', fontSize: 22, fontWeight: 600 }}>
              {isEdit ? 'Edit Record' : intent ? 'New Record' : 'Add DNS Record'}
            </h2>
            <span className="text-xs font-mono" style={{ color: 'var(--text-dimmer)' }}>{domain}</span>
          </div>
          <div className="flex items-center gap-2">
            {!isEdit && intent && (
              <button onClick={() => setIntent(null)}
                className="text-sm px-3 py-1 rounded-md"
                style={{ color: 'var(--text-soft)', border: '1px solid var(--border-strong)', background: 'transparent' }}>
                ← Back
              </button>
            )}
            <button onClick={onClose} style={{ color: 'var(--text-dimmer)', fontSize: 18 }}>✕</button>
          </div>
        </div>

        {/* Error / status */}
        {(error || status) && (
          <div className="mx-5 mt-4 px-3 py-2 rounded text-sm" style={{
            background: error ? 'color-mix(in srgb, var(--crit-2) 6%, transparent)' : 'color-mix(in srgb, var(--good) 6%, transparent)',
            color:      error ? 'var(--crit-soft)'   : 'var(--good)',
            border:     `1px solid ${error ? 'color-mix(in srgb, var(--crit-2) 19%, transparent)' : 'color-mix(in srgb, var(--good) 19%, transparent)'}`,
          }}>{error ?? status}</div>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* INTENT PICKER (create only, before intent selected)              */}
        {/* ---------------------------------------------------------------- */}
        {!isEdit && !intent && (
          <div className="p-5 space-y-2">
            <div className="text-sm mb-4" style={{ color: 'var(--text-soft)' }}>
              What do you want to do?
            </div>
            {INTENTS.map(i => (
              <button key={i.id} onClick={() => selectIntent(i.id)}
                className="w-full flex items-center gap-4 px-4 py-3 rounded-lg transition-all"
                style={{ background: 'var(--ground-deep)', border: '1px solid var(--border-soft)', cursor: 'pointer', textAlign: 'left' }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--accent) 25%, transparent)')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border-soft)')}
              >
                <span className="flex" style={{ color: 'var(--accent)' }}><i.Icon size={20} /></span>
                <div>
                  <div className="text-base font-semibold" style={{ color: 'var(--text-bright)' }}>{i.title}</div>
                  <div className="text-sm mt-0.5" style={{ color: 'var(--text-dim)' }}>{i.desc}</div>
                </div>
                <span className="ml-auto" style={{ color: 'var(--text-dimmer)' }}>→</span>
              </button>
            ))}
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* EMAIL PROVIDER PICKER                                             */}
        {/* ---------------------------------------------------------------- */}
        {!isEdit && intent === 'email' && (
          <div className="p-5 space-y-4">
            <div className="text-sm" style={{ color: 'var(--text-soft)' }}>Select your email provider</div>
            <div className="space-y-2">
              {Object.entries(EMAIL_PROVIDERS).map(([key, prov]) => (
                <button key={key} onClick={() => setEmailProvider(key)}
                  className="w-full flex items-center justify-between px-4 py-3 rounded-lg"
                  style={{
                    background: emailProvider === key ? 'color-mix(in srgb, var(--accent) 6%, transparent)' : 'var(--ground-deep)',
                    border: `1px solid ${emailProvider === key ? 'color-mix(in srgb, var(--accent) 25%, transparent)' : 'var(--text-faint)'}`,
                    cursor: 'pointer',
                  }}
                >
                  <span className="text-sm font-semibold" style={{ color: emailProvider === key ? 'var(--accent)' : 'var(--text-bright)' }}>
                    {prov.name}
                  </span>
                  <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
                    {prov.records.length} record{prov.records.length !== 1 ? 's' : ''}
                  </span>
                </button>
              ))}
            </div>
            {EMAIL_PROVIDERS[emailProvider].custom ? (
              <div className="space-y-2">
                <div className="text-sm" style={{ color: 'var(--text-soft)' }}>Enter your mail server:</div>
                <input style={INPUT} placeholder="mail.yourdomain.com."
                  value={form.data} onChange={e => set('data', e.target.value)} />
                <input style={INPUT} type="number" placeholder="Priority (e.g. 10)"
                  value={form.priority ?? 10} onChange={e => set('priority', Number(e.target.value))} />
              </div>
            ) : (
              <div className="rounded-lg p-3" style={{ background: 'var(--ground-deep)', border: '1px solid var(--border-soft)' }}>
                <div className="text-sm mb-2" style={{ color: 'var(--text-soft)' }}>Records to be created:</div>
                {EMAIL_PROVIDERS[emailProvider].records.map((r, i) => (
                  <div key={i} className="text-xs font-mono flex gap-3 py-1" style={{ color: 'var(--text-muted)' }}>
                    <span style={{ color: 'var(--good)' }}>MX</span>
                    <span>@</span>
                    <span style={{ color: 'var(--text-bright)' }}>{r.data}</span>
                    <span style={{ color: 'var(--text-dimmer)' }}>priority: {r.priority}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* FORM (edit OR create after intent selected, non-email)           */}
        {/* ---------------------------------------------------------------- */}
        {(isEdit || (intent && intent !== 'email')) && (
          <div className="p-5 space-y-4">

            {/* Point to server — show WAN IP hint */}
            {intent === 'point-server' && (
              <div className="px-3 py-2 rounded text-sm flex items-center gap-2"
                style={{ background: 'color-mix(in srgb, var(--accent) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)', color: 'var(--text-soft)' }}>
                <span className="flex" style={{ color: 'var(--accent)' }}><GlobeIcon /></span>
                <span>WAN IP pre-filled — edit if pointing to a different IP</span>
              </div>
            )}

            {/* Type row — only show for custom or edit */}
            {(isEdit || intent === 'custom') && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label style={LABEL}>Type</label>
                  <select style={{ ...INPUT, cursor: 'pointer' }} value={form.type}
                    onChange={e => set('type', e.target.value)} disabled={isEdit}>
                    {(isCf && !isEdit ? ['A','AAAA','CNAME','TXT','MX','SRV','CAA'] : ['A','AAAA','CNAME','TXT','MX','SRV','NS','CAA']).map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={LABEL}>TTL</label>
                  <select style={{ ...INPUT, cursor: 'pointer' }} value={form.ttl}
                    onChange={e => set('ttl', Number(e.target.value))}>
                    {ttlOptions.map(({ v, l }) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* TTL for non-custom wizard intents */}
            {!isEdit && intent !== 'custom' && (
              <div>
                <label style={LABEL}>TTL</label>
                <select style={{ ...INPUT, cursor: 'pointer' }} value={form.ttl}
                  onChange={e => set('ttl', Number(e.target.value))}>
                  {ttlOptions.map(({ v, l }) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Name */}
            <div>
              <label style={LABEL}>
                {intent === 'point-server' ? 'Subdomain (@ for root domain)' :
                 intent === 'subdomain'    ? 'Subdomain' :
                 intent === 'verify'       ? 'Name (@ for root)' :
                 'Name'}
              </label>
              <input style={INPUT} value={form.name}
                placeholder={
                  intent === 'point-server' ? '@ or app, api, www...' :
                  intent === 'subdomain'    ? 'app, api, www...' :
                  intent === 'verify'       ? '@' :
                  '@ or subdomain'
                }
                onChange={e => set('name', e.target.value)}
                disabled={isEdit}
                autoFocus
              />
            </div>

            {/* Value */}
            <div>
              <label style={LABEL}>
                {form.type === 'A'     ? 'IP Address' :
                 form.type === 'AAAA'  ? 'IPv6 Address' :
                 form.type === 'CNAME' ? 'Points to' :
                 form.type === 'TXT'   ? 'Text Value' :
                 form.type === 'MX'    ? 'Mail Server' :
                 form.type === 'NS'    ? 'Nameserver' : 'Value'}
              </label>
              <input style={INPUT} value={form.data}
                placeholder={
                  form.type === 'A'     ? wanIp || '1.2.3.4' :
                  form.type === 'CNAME' ? 'myapp.vercel.app.' :
                  form.type === 'TXT'   ? 'Paste verification code here' :
                  ''
                }
                onChange={e => set('data', e.target.value)}
              />
              {intent === 'point-server' && form.data === wanIp && (
                <div className="mt-1 text-xs" style={{ color: 'var(--text-dim)' }}>
                  ✓ Your current WAN IP
                </div>
              )}
            </div>

            {form.type === 'MX' && (
              <div>
                <label style={LABEL}>Priority</label>
                <input style={INPUT} type="number" value={form.priority ?? 10}
                  onChange={e => set('priority', Number(e.target.value))}/>
              </div>
            )}

            {isCf && PROXIABLE.has(form.type) && (
              <div>
                <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-bright)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.proxied === true} onChange={e => set('proxied', e.target.checked)} />
                  Proxy through Cloudflare (orange cloud)
                </label>
                <div className="mt-1 text-xs" style={{ color: 'var(--text-dim)' }}>
                  Off (DNS only) suits proxy hosts: proxying hides your address but breaks Let&apos;s Encrypt checks in the proxy and any port that is not web.
                </div>
                {form.proxied && (
                  <div className="mt-1 text-xs" style={{ color: 'var(--warn)' }}>
                    While this is on, the name resolves to Cloudflare, so HyperProx cannot get a Let&apos;s Encrypt certificate for it through the proxy.
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Footer — only show when there's something to save */}
        {(isEdit || intent) && (
          <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--border-dim)' }}>
            <button onClick={onClose}
              style={BTN_SECONDARY}>
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving}
              style={{ ...BTN_PRIMARY, opacity: saving ? 0.5 : 1 }}>
              {saving ? 'Saving...' :
               isEdit ? 'Save Changes' :
               intent === 'email' ? `Create ${EMAIL_PROVIDERS[emailProvider]?.records.length} MX Records` :
               'Create Record'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
//  Delete confirmation
// ---------------------------------------------------------------------------

function DeleteModal({ record, domain, onClose, onDelete }: {
  record:   DNSRecord
  domain:   string
  onClose:  () => void
  onDelete: () => void
}) {
  const [deleting, setDeleting] = useState(false)

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await fetch(recordPath(domain, record), { method: 'DELETE' })
      onDelete(); onClose()
    } finally { setDeleting(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'var(--scrim)', backdropFilter: 'blur(4px)' }}>
      <div className="w-full max-w-sm rounded-xl border p-6 overflow-y-auto overscroll-contain max-h-[calc(100dvh-2rem)]"
        style={{ background: 'var(--surface-raised)', borderColor: 'color-mix(in srgb, var(--crit-2) 15%, transparent)' }}>
        <h2 className="font-display mb-2" style={{ color: 'var(--crit-2)', fontSize: 22, fontWeight: 600 }}>Delete Record</h2>
        <p className="text-sm mb-1" style={{ color: 'var(--text-soft)' }}>This will permanently delete:</p>
        <p className="text-sm font-mono mb-1" style={{ color: 'var(--text-bright)' }}>
          <span style={{ color: TYPE_COLORS[record.type] }}>{record.type}</span> {record.name}.{domain}
        </p>
        <p className="text-xs font-mono mb-5" style={{ color: 'var(--text-dimmer)' }}>→ {record.data}</p>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose}
            style={BTN_SECONDARY}>Cancel</button>
          <button onClick={handleDelete} disabled={deleting}
            style={{ ...BTN_SECONDARY, color: 'var(--crit)', borderColor: 'var(--crit)' }}>
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
//  Domain selector card
// ---------------------------------------------------------------------------

function DomainCard({ domain, selected, recordCount, onSelect }: {
  domain:      Domain
  selected:    boolean
  recordCount: number
  onSelect:    () => void
}) {
  const days = daysUntilExpiry(domain.expires)
  const expiryColor = days === null ? 'var(--text-dim)' : days < 30 ? 'var(--crit)' : days < 90 ? 'var(--warn)' : 'var(--good)'
  const active = domain.active ?? /^active$/i.test(domain.status)

  return (
    <button onClick={onSelect} aria-pressed={selected}
      className="p-4 rounded-lg border text-left transition-all w-full"
      style={{
        background:   selected ? alpha('var(--accent)', 10) : 'var(--ground-deep)',
        borderColor:  selected ? alpha('var(--accent)', 55) : 'var(--border-soft)',
        boxShadow:    selected ? `0 0 14px ${alpha('var(--accent)', 18)}` : 'none',
      }}>
      <div className="flex items-center justify-between mb-2 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-2 h-2 rounded-full flex-shrink-0" aria-hidden style={{
            background:  active ? 'var(--good)' : 'var(--crit)',
            boxShadow:   active ? `0 0 5px ${alpha('var(--good)', 80)}` : 'none',
          }}/>
          <span className="font-mono text-sm font-semibold" style={{ color: selected ? 'var(--accent)' : 'var(--text-bright)', overflowWrap: 'anywhere' }}>
            {domain.domain}
          </span>
        </div>
        <span className="flex items-center gap-1">
          {domain.provider && <Pill tone={domain.provider === 'cloudflare' ? 'warn' : 'accent'} title={`DNS served by ${PROVIDER_LABEL[domain.provider]}`}>{PROVIDER_LABEL[domain.provider]}</Pill>}
          {domain.locked && <span className="flex" style={{ color: 'var(--text-muted)' }} title="Locked"><LockIcon size={13} /><span className="sr-only">Locked</span></span>}
        </span>
      </div>
      <div className="flex items-center gap-3 text-xs flex-wrap">
        <span style={{ color: 'var(--text-muted)' }}>{active ? 'active' : domain.status.toLowerCase()}</span>
        <span style={{ color: 'var(--text-muted)' }}>{recordCount} records</span>
        {days !== null && (
          <span style={{ color: expiryColor }}>
            {days > 0 ? `expires in ${days}d` : 'EXPIRED'}
          </span>
        )}
        {domain.renewAuto && <span style={{ color: 'var(--good)', fontSize: 10 }}>AUTO-RENEW</span>}
      </div>
    </button>
  )
}

// ---------------------------------------------------------------------------
//  Main DNS page
// ---------------------------------------------------------------------------

export default function DNSPage() {
  const [domains,     setDomains]     = useState<Domain[]>([])
  const [activeDomain,setActiveDomain]= useState<string | null>(null)
  const [records,     setRecords]     = useState<DNSRecord[]>([])
  const [recordCounts,setRecordCounts]= useState<Record<string, number>>({})
  const [wanIP,       setWanIP]       = useState<string | null>(null)
  const [loading,     setLoading]     = useState(true)
  const [recLoading,  setRecLoading]  = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [editRecord,  setEditRecord]  = useState<DNSRecord | null | undefined>(undefined)
  const [deleteRecord,setDeleteRecord]= useState<DNSRecord | null>(null)
  const [typeFilter,  setTypeFilter]  = useState<string>('all')
  const [search,      setSearch]      = useState('')
  const [ddnsRunning, setDdnsRunning] = useState(false)
  const [ddnsResult,  setDdnsResult]  = useState<string | null>(null)
  const [lastSync,    setLastSync]    = useState<Date | null>(null)
  const [providers,   setProviders]   = useState<ProviderStatus[]>([])

  // Load domains (from every provider) + the providers themselves + WAN IP
  useEffect(() => {
    Promise.all([
      fetch('/api/dns/domains').then(r => r.json()),
      fetch('/api/dns/wan').then(r => r.json()),
      fetch('/api/dns/providers').then(r => r.json()).catch(() => ({})),
    ]).then(([domsJson, wanJson, provJson]) => {
      if (provJson?.success) setProviders(provJson.data)
      if (domsJson.success) {
        setDomains(domsJson.data)
        if (domsJson.data.length > 0) setActiveDomain(domsJson.data[0].domain)
      } else setError(domsJson.error || 'The DNS providers could not be read')
      if (wanJson.success) setWanIP(wanJson.data.ip)
    }).catch(e => setError(e.message))
    .finally(() => setLoading(false))
  }, [])

  // Load records for active domain
  const loadRecords = useCallback(async (domain: string) => {
    setRecLoading(true)
    try {
      const res  = await fetch(`/api/dns/domains/${enc(domain)}/records`)
      const json = await res.json()
      if (json.success) {
        setRecords(json.data)
        setRecordCounts(prev => ({ ...prev, [domain]: json.data.length }))
        setLastSync(new Date())
      }
    } finally { setRecLoading(false) }
  }, [])

  useEffect(() => {
    if (activeDomain) loadRecords(activeDomain)
  }, [activeDomain, loadRecords])

  // Pre-fetch record counts for all domains
  useEffect(() => {
    domains.forEach(async d => {
      if (d.domain === activeDomain) return
      try {
        const res  = await fetch(`/api/dns/domains/${enc(d.domain)}/records`)
        const json = await res.json()
        if (json.success) setRecordCounts(prev => ({ ...prev, [d.domain]: json.data.length }))
      } catch { /* ignore */ }
    })
  }, [domains, activeDomain])

  const runDDNS = async () => {
    if (!activeDomain) return
    setDdnsRunning(true); setDdnsResult(null)
    try {
      const res  = await fetch(`/api/dns/domains/${enc(activeDomain)}/ddns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const json = await res.json()
      if (json.success) {
        const { updated, skipped, wanIP: newIP } = json.data
        setWanIP(newIP)
        setDdnsResult(updated.length > 0 ? `Updated ${updated.length} records to ${newIP}` : `All records already point to ${newIP}`)
        if (updated.length > 0) loadRecords(activeDomain)
      }
    } finally { setDdnsRunning(false) }
  }

  const filtered = records
    .filter(r => typeFilter === 'all' || r.type === typeFilter)
    .filter(r => !search || r.name.toLowerCase().includes(search.toLowerCase()) || r.data.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))

  const types = [...new Set(records.map(r => r.type))].sort()

  if (loading) return (
    <Page>
      <Panel title="DNS"><p className={`${styles.empty} animate-pulse`} role="status">loading DNS...</p></Panel>
    </Page>
  )

  if (error) return (
    <Page>
      <Panel title="DNS">
        <div role="alert">
          <div className="font-display" style={{ color: 'var(--crit)', fontSize: 22, fontWeight: 600 }}>Failed to reach the DNS provider</div>
          <div className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>{error}</div>
          <div className="text-sm mt-2" style={{ color: 'var(--text-dim)' }}>Check Settings → DNS (GoDaddy or Cloudflare)</div>
        </div>
      </Panel>
    </Page>
  )

  // Chips: how much DNS there is, and the soonest domain expiry (the one date that can hurt).
  const soonest = domains
    .map(d => ({ d, days: daysUntilExpiry(d.expires) }))
    .filter((x): x is { d: Domain; days: number } => x.days !== null)
    .sort((a, b) => a.days - b.days)[0]
  const chips: StatChip[] = [
    { label: 'domains', value: domains.length },
    { label: 'records here', value: records.length },
  ]
  if (wanIP) chips.push({ label: 'WAN address', value: wanIP })
  if (soonest) chips.push({ label: 'next expiry', value: soonest.days > 0 ? `${soonest.days}d` : 'expired', tone: soonest.days < 30 ? 'crit' : soonest.days < 90 ? 'warn' : 'good' })

  const aRecords = records.filter(r => r.type === 'A')
  const offWan = wanIP ? aRecords.filter(r => r.data !== wanIP).length : 0

  // How many records of each type this domain has: the shape of the zone at a glance.
  const typeBars = types.map(tp => ({
    key: tp, label: tp, value: records.filter(r => r.type === tp).length,
    text: String(records.filter(r => r.type === tp).length),
  }))

  const activeProvider = domains.find(d => d.domain === activeDomain)?.provider
  const configured = providers.filter(p => p.configured)

  return (
    <Page>
      <HudHeader
        eyebrow={activeProvider ? PROVIDER_LABEL[activeProvider] : 'DNS'}
        title={activeDomain ? `${activeDomain}: ${records.length} record${records.length === 1 ? '' : 's'}` : `${domains.length} domain${domains.length === 1 ? '' : 's'}`}
        icon="router"
        level={2}
        chips={chips}
        label="DNS overview"
        actions={activeDomain ? (
          <>
            <button onClick={runDDNS} disabled={ddnsRunning} className={`${styles.btn} ${styles.btnWarn}`}>
              {ddnsRunning ? '↻ Updating...' : '↻ DDNS Update'}
            </button>
            <button onClick={() => setEditRecord(null)} className={`${styles.btn} ${styles.btnPri}`}>+ New Record</button>
          </>
        ) : undefined}
      >
        {lastSync && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>synced {lastSync.toLocaleTimeString()}</span>}
      </HudHeader>

      {ddnsResult && (
        <div className={styles.callout} role="status" style={{ color: 'var(--good)' }}>✓ {ddnsResult}</div>
      )}

      {configured.length > 0 && (
        <Panel title="DNS providers" sub="each domain is served by the provider that holds its zone">
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 15rem), 1fr))' }}>
            {configured.map(p => (
              <div key={p.id} className="p-4 rounded-lg border" style={{ background: 'var(--ground-deep)', borderColor: 'var(--border-soft)' }}>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="font-semibold" style={{ color: 'var(--text-bright)' }}>{p.label}</span>
                  <Pill tone={p.ok ? 'good' : 'bad'}>{p.ok ? 'connected' : 'not answering'}</Pill>
                </div>
                {!p.ok ? <div className="text-xs font-mono" style={{ color: 'var(--crit-soft)', overflowWrap: 'anywhere' }}>{p.error}</div>
                  : p.zones === 0 ? <div className="text-sm" style={{ color: 'var(--text-dim)' }}>
                      {p.id === 'cloudflare' ? 'No domains on this Cloudflare account yet: add one in Cloudflare and it appears here.' : `No domains on this ${p.label} account yet.`}
                    </div>
                  : <div className="text-sm" style={{ color: 'var(--text-dim)' }}>{p.zones} domain{p.zones === 1 ? '' : 's'}{p.active !== p.zones ? `, ${p.active} active` : ''}</div>}
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel title="Domains" sub={`${domains.length} across ${configured.length || 'the'} provider${configured.length === 1 ? '' : 's'}`}>
        {domains.length === 0 && <p className={styles.empty}>No domains yet. Add a DNS provider under Settings → DNS, or a domain at your provider.</p>}
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 15rem), 1fr))' }}>
          {domains.map(d => (
            <DomainCard key={d.domain} domain={d} selected={activeDomain === d.domain}
              recordCount={recordCounts[d.domain] ?? 0}
              onSelect={() => setActiveDomain(d.domain)}/>
          ))}
        </div>
      </Panel>

      {activeDomain && (
        <Panel title="Shape of this zone" sub={activeDomain}>
          {recLoading ? <p className={`${styles.empty} animate-pulse`}>Loading records...</p>
            : records.length === 0 ? <p className={styles.empty}>No records in this domain.</p>
            : (
              <div className="flex flex-col gap-4">
                <GlowBars items={typeBars} label="Records by type" />
                {wanIP && aRecords.length > 0 && (
                  <div className={styles.row}>
                    <Pill tone="good">{aRecords.length - offWan} A records point at the WAN address</Pill>
                    {offWan > 0 && <Pill tone="warn" title="A records whose value is not the current WAN address">{offWan} point elsewhere</Pill>}
                  </div>
                )}
              </div>
            )}
        </Panel>
      )}

      {activeDomain && (
        <Details summary="Records" sub="exact rows: filter, edit, delete" open>
          {/* Domain toolbar */}
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <div className="flex gap-1 flex-wrap" role="group" aria-label="Filter by record type">
              <button key="all" onClick={() => setTypeFilter('all')} aria-pressed={typeFilter === 'all'}
                className="text-xs font-mono px-2.5 py-1.5 rounded-md" style={{
                  background: typeFilter === 'all' ? alpha('var(--accent)', 12) : 'transparent',
                  color:      typeFilter === 'all' ? 'var(--accent)'   : 'var(--text-muted)',
                  border:     `1px solid ${typeFilter === 'all' ? 'var(--accent)' : 'var(--border-strong)'}`,
                }}>All</button>
              {types.map(t => (
                <button key={t} onClick={() => setTypeFilter(t)} aria-pressed={typeFilter === t}
                  className="text-xs font-mono px-2.5 py-1.5 rounded" style={{
                    background: typeFilter === t ? alpha(TYPE_COLORS[t], 10) : 'transparent',
                    color:      typeFilter === t ? TYPE_COLORS[t]        : 'var(--text-muted)',
                    border:     `1px solid ${typeFilter === t ? alpha(TYPE_COLORS[t], 40) : 'var(--border)'}`,
                  }}>{t}</button>
              ))}
            </div>

            <input type="text" placeholder="Search name or value..." aria-label="Search records by name or value" value={search}
              onChange={e => setSearch(e.target.value)}
              className={styles.input} style={{ maxWidth: 240 }}/>

            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{filtered.length} records</span>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {['TYPE', 'NAME', 'VALUE', 'TTL', 'ACTIONS'].map(h => <th key={h} scope="col">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {recLoading ? (
                  <tr><td colSpan={5} className="text-center animate-pulse">Loading records...</td></tr>
                ) : filtered.map((rec, i) => (
                  <tr key={rec.id ?? `${rec.type}-${rec.name}-${i}`}>
                    <td>
                      <span className="px-1.5 py-0.5 rounded font-mono" style={{
                        fontSize: 10, background: alpha(TYPE_COLORS[rec.type] ?? 'var(--text-dim)', 12),
                        color: TYPE_COLORS[rec.type] ?? 'var(--text-dim)',
                        border: `1px solid ${alpha(TYPE_COLORS[rec.type] ?? 'var(--text-dim)', 35)}`,
                      }}>{rec.type}</span>
                    </td>
                    <td className="font-mono">
                      <span style={{ color: 'var(--text-bright)' }}>{rec.name}</span>
                      <span style={{ color: 'var(--text-dim)' }}>.{activeDomain}</span>
                    </td>
                    <td className="font-mono">
                      <span className="truncate block max-w-xs" title={rec.data}>
                        {rec.data.length > 50 ? rec.data.slice(0, 50) + '…' : rec.data}
                      </span>
                      {/* Highlight if matches WAN IP */}
                      {rec.type === 'A' && rec.data === wanIP && (
                        <span style={{ color: 'var(--good)', fontSize: 10 }}>✓ WAN</span>
                      )}
                      {rec.type === 'A' && wanIP && rec.data !== wanIP && (
                        <span style={{ color: 'var(--warn)', fontSize: 10 }}>≠ WAN ({wanIP})</span>
                      )}
                      {typeof rec.proxied === 'boolean' && rec.proxiable !== false && (
                        <span className="ml-1" style={{ color: rec.proxied ? 'var(--warn)' : 'var(--text-dim)', fontSize: 10 }}
                          title={rec.proxied ? 'Proxied through Cloudflare (orange cloud)' : 'DNS only (grey cloud)'}>
                          {rec.proxied ? '● proxied' : '○ DNS only'}
                        </span>
                      )}
                    </td>
                    <td className="font-mono" style={{ color: 'var(--text-muted)' }}>
                      {ttlLabel(rec.ttl)}
                    </td>
                    <td>
                      <div className="flex gap-1">
                        <button onClick={() => setEditRecord(rec)} className={styles.btn} style={{ minHeight: 32, padding: '4px 12px', color: 'var(--accent)' }}
                          aria-label={`Edit ${rec.type} record ${rec.name}`}>Edit</button>
                        <button onClick={() => setDeleteRecord(rec)} className={styles.btn} style={{ minHeight: 32, padding: '4px 10px', color: 'var(--crit)' }}
                          aria-label={`Delete ${rec.type} record ${rec.name}`}>✕</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!recLoading && filtered.length === 0 && (
                  <tr><td colSpan={5} className="text-center" style={{ color: 'var(--text-muted)' }}>No records match filter</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Details>
      )}

      {/* Modals */}
      {editRecord !== undefined && activeDomain && (
        <RecordModal record={editRecord} domain={activeDomain} provider={activeProvider} wanIp={wanIP ?? undefined}
          onClose={() => setEditRecord(undefined)}
          onSave={() => loadRecords(activeDomain)}/>
      )}
      {deleteRecord && activeDomain && (
        <DeleteModal record={deleteRecord} domain={activeDomain}
          onClose={() => setDeleteRecord(null)}
          onDelete={() => loadRecords(activeDomain)}/>
      )}
    </Page>
  )
}
