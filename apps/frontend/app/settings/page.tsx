'use client'

import { useEffect, useState, useCallback } from 'react'

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
  background: '#060a10', border: '1px solid #1f2937',
  color: '#e5e7eb', borderRadius: 6, padding: '8px 12px',
  fontFamily: 'IBM Plex Mono, monospace', fontSize: 12,
  outline: 'none', width: '100%',
} as React.CSSProperties

const LABEL = {
  display: 'block', fontSize: 10, fontFamily: 'IBM Plex Mono, monospace',
  color: '#4b5563', textTransform: 'uppercase' as const,
  letterSpacing: '0.05em', marginBottom: 4,
}

const CATEGORY_META: Record<string, { label: string; accent: string; providers: Record<string, string> }> = {
  proxmox: { label: 'Proxmox',        accent: '#ff6b35', providers: { proxmox: 'Proxmox VE' } },
  proxy:   { label: 'Proxy',          accent: '#00e5ff', providers: { npm: 'Nginx Proxy Manager', traefik: 'Traefik', caddy: 'Caddy' } },
  dns:     { label: 'DNS',            accent: '#22d3ee', providers: { godaddy: 'GoDaddy', cloudflare: 'Cloudflare', namecheap: 'Namecheap' } },
  system:  { label: 'System',         accent: '#6b7280', providers: { hyperprox: 'HyperProx' } },
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
      background: '#0a0f1a', borderColor: allSet ? `${accent}25` : '#1f2937',
    }}>
      {/* Provider header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full" style={{
            background: allSet ? accent : '#374151',
            boxShadow:  allSet ? `0 0 5px ${accent}` : 'none',
          }} />
          <span className="font-mono text-sm font-medium" style={{ color: allSet ? '#e5e7eb' : '#6b7280' }}>
            {providerLabel}
          </span>
          {allSet && (
            <span className="text-xs font-mono px-1.5 py-0.5 rounded" style={{
              background: `${accent}15`, color: accent, border: `1px solid ${accent}30`, fontSize: 9,
            }}>CONFIGURED</span>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={handleTest} disabled={testing}
            className="text-xs font-mono px-3 py-1.5 rounded transition-all"
            style={{
              background: testing ? '#374151' : '#ffffff08',
              color:      testing ? '#6b7280' : '#9ca3af',
              border:     '1px solid #1f2937',
            }}>
            {testing ? 'Testing...' : 'Test'}
          </button>
          <button onClick={handleSave} disabled={saving}
            className="text-xs font-mono px-3 py-1.5 rounded transition-all"
            style={{
              background: saved ? `${accent}20` : saving ? '#374151' : `${accent}15`,
              color:      saved ? accent : saving ? '#6b7280' : accent,
              border:     `1px solid ${accent}30`,
            }}>
            {saved ? '✓ Saved' : saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {/* Test result */}
      {result && (
        <div className="mb-4 px-3 py-2 rounded text-xs font-mono" style={{
          background: result.success ? '#22c55e10' : '#ff444410',
          color:      result.success ? '#4ade80' : '#f87171',
          border:     `1px solid ${result.success ? '#22c55e30' : '#ff444430'}`,
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
              {field.isSet && <span style={{ color: '#22c55e', marginLeft: 6 }}>✓</span>}
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
                  style={{ color: '#374151' }}
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
      return { success: json.success, message: json.data?.message, error: json.error }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  const meta = CATEGORY_META[tab]

  return (
    <div className="min-h-full p-6" style={{ background: '#080c14' }}>

      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-1 h-6 rounded-full" style={{ background: '#6b7280', boxShadow: '0 0 8px #6b728060' }} />
        <h1 className="font-display text-2xl font-semibold tracking-wide uppercase" style={{ color: '#9ca3af' }}>
          Settings
        </h1>
      </div>

      {/* Category tabs */}
      <div className="flex gap-1 mb-6 border-b" style={{ borderColor: '#111827' }}>
        {(Object.keys(CATEGORY_META) as Array<keyof typeof CATEGORY_META>).map(cat => {
          const m = CATEGORY_META[cat]
          const catFields = fields[cat] ?? []
          const allSet = catFields.length > 0 && catFields.every(f => f.isSet)
          return (
            <button key={cat} onClick={() => setTab(cat as any)}
              className="px-5 py-3 text-xs font-mono uppercase tracking-wider transition-colors flex items-center gap-2"
              style={{
                borderBottom: tab === cat ? `2px solid ${m.accent}` : '2px solid transparent',
                color:        tab === cat ? m.accent : '#4b5563',
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
