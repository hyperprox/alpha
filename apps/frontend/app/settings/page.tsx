'use client'

import { useEffect, useState, useCallback } from 'react'
import { alpha } from '@/lib/theme'

// ---------------------------------------------------------------------------
//  Types
// ---------------------------------------------------------------------------

interface CredentialField {
  provider: string
  key:      string
  label:    string
  value:    string
  masked:   boolean
  isSet:    boolean
}

interface TestResult {
  success: boolean
  message?: string
  error?:  string
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const INPUT = {
  background: 'var(--ground-deep)', border: '1px solid var(--text-faint)',
  color: 'var(--text-bright)', borderRadius: 6, padding: '8px 12px',
  fontFamily: 'IBM Plex Mono, monospace', fontSize: 12,
  outline: 'none', width: '100%',
} as React.CSSProperties

const LABEL = {
  display: 'block', fontSize: 10, fontFamily: 'IBM Plex Mono, monospace',
  color: 'var(--text-dim)', textTransform: 'uppercase' as const,
  letterSpacing: '0.05em', marginBottom: 4,
}

const CATEGORY_META: Record<string, { label: string; accent: string; providers: Record<string, string> }> = {
  proxmox: { label: 'Proxmox',        accent: 'var(--warn)', providers: { proxmox: 'Proxmox VE' } },
  proxy:   { label: 'Proxy',          accent: 'var(--accent)', providers: { npm: 'Nginx Proxy Manager', traefik: 'Traefik', caddy: 'Caddy' } },
  dns:     { label: 'DNS',            accent: 'var(--accent-2)', providers: { godaddy: 'GoDaddy', cloudflare: 'Cloudflare', namecheap: 'Namecheap' } },
  system:  { label: 'System',         accent: 'var(--text-muted)', providers: { hyperprox: 'HyperProx' } },
}

// ---------------------------------------------------------------------------
//  Credential section for one provider
// ---------------------------------------------------------------------------

function ProviderSection({
  category, provider, providerLabel, accent, fields, onSave, onTest,
}: {
  category:      string
  provider:      string
  providerLabel: string
  accent:        string
  fields:        CredentialField[]
  onSave:        (category: string, provider: string, values: Record<string, string>) => Promise<void>
  onTest:        (category: string, provider: string) => Promise<TestResult>
}) {
  const [values,   setValues]   = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map(f => [f.key, '']))
  )
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [saving,   setSaving]   = useState(false)
  const [testing,  setTesting]  = useState(false)
  const [result,   setResult]   = useState<TestResult | null>(null)
  const [saved,    setSaved]    = useState(false)

  const providerFields = fields.filter(f => f.provider === provider)

  const handleSave = async () => {
    setSaving(true)
    setSaved(false)
    const payload = Object.fromEntries(
      Object.entries(values).filter(([, v]) => v.trim() !== '')
    )
    await onSave(category, provider, payload)
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleTest = async () => {
    setTesting(true)
    setResult(null)
    const r = await onTest(category, provider)
    setResult(r)
    setTesting(false)
  }

  const allSet = providerFields.every(f => f.isSet)

  return (
    <div className="rounded-lg border p-5" style={{
      background: 'var(--surface-raised)', borderColor: allSet ? `${alpha(accent, 15)}` : 'var(--text-faint)',
    }}>
      {/* Provider header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full" style={{
            background: allSet ? accent : 'var(--text-dimmer)',
            boxShadow:  allSet ? `0 0 5px ${accent}` : 'none',
          }} />
          <span className="font-mono text-sm font-medium" style={{ color: allSet ? 'var(--text-bright)' : 'var(--text-muted)' }}>
            {providerLabel}
          </span>
          {allSet && (
            <span className="text-xs font-mono px-1.5 py-0.5 rounded" style={{
              background: `${alpha(accent, 8)}`, color: accent, border: `1px solid ${alpha(accent, 19)}`, fontSize: 9,
            }}>CONFIGURED</span>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={handleTest} disabled={testing}
            className="text-xs font-mono px-3 py-1.5 rounded transition-all"
            style={{
              background: testing ? 'var(--text-dimmer)' : 'color-mix(in srgb, var(--text-bright) 3%, transparent)',
              color:      testing ? 'var(--text-muted)' : 'var(--text-soft)',
              border:     '1px solid var(--text-faint)',
            }}>
            {testing ? 'Testing...' : 'Test'}
          </button>
          <button onClick={handleSave} disabled={saving}
            className="text-xs font-mono px-3 py-1.5 rounded transition-all"
            style={{
              background: saved ? `${alpha(accent, 13)}` : saving ? 'var(--text-dimmer)' : `${alpha(accent, 8)}`,
              color:      saved ? accent : saving ? 'var(--text-muted)' : accent,
              border:     `1px solid ${alpha(accent, 19)}`,
            }}>
            {saved ? '✓ Saved' : saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {/* Test result */}
      {result && (
        <div className="mb-4 px-3 py-2 rounded text-xs font-mono" style={{
          background: result.success ? 'color-mix(in srgb, var(--good) 6%, transparent)' : 'color-mix(in srgb, var(--crit-2) 6%, transparent)',
          color:      result.success ? 'var(--good)' : 'var(--crit-soft)',
          border:     `1px solid ${result.success ? 'color-mix(in srgb, var(--good) 19%, transparent)' : 'color-mix(in srgb, var(--crit-2) 19%, transparent)'}`,
        }}>
          {result.success ? `✓ ${result.message ?? 'Connection successful'}` : `✗ ${result.error}`}
        </div>
      )}

      {/* Fields */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {providerFields.map(field => (
          <div key={field.key}>
            <label style={LABEL}>
              {field.label}
              {field.isSet && <span style={{ color: 'var(--good)', marginLeft: 6 }}>✓</span>}
            </label>
            <div className="relative">
              <input
                type={field.masked && !revealed[field.key] ? 'password' : 'text'}
                style={INPUT}
                value={values[field.key]}
                placeholder={field.isSet ? (field.masked ? '••••••••' : field.value) : `Enter ${field.label.toLowerCase()}...`}
                onChange={e => setValues(v => ({ ...v, [field.key]: e.target.value }))}
              />
              {field.masked && (
                <button
                  onClick={() => setRevealed(r => ({ ...r, [field.key]: !r[field.key] }))}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono"
                  style={{ color: 'var(--text-dimmer)' }}
                >
                  {revealed[field.key] ? 'hide' : 'show'}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
//  Main settings page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const [tab,    setTab]    = useState<'proxmox' | 'proxy' | 'dns' | 'system'>('proxmox')
  const [fields, setFields] = useState<Record<string, CredentialField[]>>({})
  const [loading, setLoading] = useState(true)

  const fetchCategory = useCallback(async (category: string) => {
    const res  = await fetch(`/api/settings/${category}`)
    const json = await res.json()
    if (json.success) setFields(f => ({ ...f, [category]: json.data }))
  }, [])

  useEffect(() => {
    Promise.all(['proxmox', 'proxy', 'dns', 'system'].map(fetchCategory))
      .finally(() => setLoading(false))
  }, [fetchCategory])

  const handleSave = async (category: string, provider: string, values: Record<string, string>) => {
    await fetch(`/api/settings/${category}/${provider}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(values),
    })
    fetchCategory(category)
  }

  const handleTest = async (category: string, provider: string): Promise<TestResult> => {
    try {
      const res  = await fetch(`/api/settings/test/${category}/${provider}`, { method: 'POST' })
      const json = await res.json()
      return { success: json.success, message: json.data?.message, error: json.error ?? json.data?.error ?? 'Test failed' }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  const meta = CATEGORY_META[tab]

  return (
    <div className="min-h-full p-3 sm:p-6" style={{ background: 'var(--ground)' }}>

      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-1 h-6 rounded-full" style={{ background: 'var(--text-muted)', boxShadow: '0 0 8px color-mix(in srgb, var(--text-muted) 38%, transparent)' }} />
        <h1 className="font-display text-2xl font-semibold tracking-wide uppercase" style={{ color: 'var(--text-soft)' }}>
          Settings
        </h1>
      </div>

      {/* Category tabs */}
      <div className="flex gap-1 mb-6 border-b" style={{ borderColor: 'var(--border-dim)' }}>
        {(Object.keys(CATEGORY_META) as Array<keyof typeof CATEGORY_META>).map(cat => {
          const m = CATEGORY_META[cat]
          const catFields = fields[cat] ?? []
          const allSet = catFields.length > 0 && catFields.every(f => f.isSet)
          return (
            <button key={cat} onClick={() => setTab(cat as any)}
              className="px-5 py-3 text-xs font-mono uppercase tracking-wider transition-colors flex items-center gap-2"
              style={{
                borderBottom: tab === cat ? `2px solid ${m.accent}` : '2px solid transparent',
                color:        tab === cat ? m.accent : 'var(--text-dim)',
                background:   'transparent',
              }}>
              {m.label}
              {allSet && <div className="w-1.5 h-1.5 rounded-full" style={{ background: m.accent }} />}
            </button>
          )
        })}
      </div>

      {loading ? (
        <div className="text-xs font-mono text-gray-600 animate-pulse">Loading credentials...</div>
      ) : (
        <div className="space-y-4 max-w-3xl">
          {Object.entries(meta.providers).map(([provider, label]) => {
            const providerFields = (fields[tab] ?? []).filter(f => f.provider === provider)
            if (providerFields.length === 0) return null
            return (
              <ProviderSection
                key={provider}
                category={tab}
                provider={provider}
                providerLabel={label}
                accent={meta.accent}
                fields={providerFields}
                onSave={handleSave}
                onTest={handleTest}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
