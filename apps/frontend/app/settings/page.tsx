'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { HudHeader, Icon, Page, Panel, Pill, styles as ks, type StatChip } from '@/components/visual/kit'
import ss from './settings.module.css'

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

const CATEGORY_META: Record<string, { label: string; accent: string; providers: Record<string, string> }> = {
  proxmox: { label: 'Proxmox',        accent: 'var(--warn)', providers: { proxmox: 'Proxmox VE' } },
  // One NPM login lives here (it is the Proxy page's first instance). Further proxies, of any kind, are added on the Proxy page.
  proxy:   { label: 'Proxy',          accent: 'var(--accent)', providers: { npm: 'Nginx Proxy Manager' } },
  dns:     { label: 'DNS',            accent: 'var(--accent-2)', providers: { godaddy: 'GoDaddy', cloudflare: 'Cloudflare', namecheap: 'Namecheap' } },
  remote:  { label: 'Remote access',  accent: 'var(--good)', providers: { tailscale: 'Tailscale', netbird: 'NetBird', 'routeros-write': 'MikroTik WireGuard (write, limited group)' } },
  system:  { label: 'System',         accent: 'var(--text-muted)', providers: { hyperprox: 'HyperProx' } },
}

// The other settings pages, as tiles on this one.
const AREAS: Array<{ href: string; label: string; icon: string; sub: string }> = [
  { href: '/settings/setup-checklist', label: 'Setup checklist', icon: 'check',  sub: "The installer's questions, for anything you skipped." },
  { href: '/settings/secrets',         label: 'Secrets',         icon: 'lock',   sub: 'What the vault holds. Revealing one may ask for your master password again.' },
  { href: '/settings/api-tokens',      label: 'API tokens',      icon: 'plug',   sub: 'Bearer tokens for scripts and agents.' },
  { href: '/settings/notifications',   label: 'Notifications',   icon: 'alarm',  sub: 'Where HyperProx tells you something needs attention.' },
  { href: '/catalogue/settings',       label: 'Container ID rule', icon: 'plugin', sub: 'How new guests are numbered.' },
]

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

  // Remote access providers have optional fields (OAuth instead of a token, defaults): one secret is enough.
  const allSet = category === 'remote' ? providerFields.some(f => f.masked && f.isSet) : providerFields.every(f => f.isSet)

  return (
    <section className={ss.item} aria-label={providerLabel}>
      {/* Provider header: a lit dot and "Configured" once every secret it needs is saved */}
      <div className={ss.itemHead} style={{ flexWrap: 'wrap' }}>
        <i className={ks.hdot} data-tone={allSet ? 'good' : 'unknown'} aria-hidden
           style={allSet ? { background: accent, boxShadow: `0 0 6px ${accent}` } : undefined} />
        <h3 className="font-display" style={{ margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: '0.06em', color: allSet ? 'var(--text-bright)' : 'var(--text-muted)' }}>
          {providerLabel}
        </h3>
        {allSet ? <Pill tone="good">Configured</Pill> : <span className={ks.srOnly}>not configured</span>}
        <div className={ss.acts} style={{ marginLeft: 'auto', marginTop: 0, paddingTop: 0 }}>
          <button type="button" onClick={handleTest} disabled={testing} className={`${ks.btn} ${ks.btnGhost}`}>
            {testing ? 'Testing...' : 'Test'}
          </button>
          <button type="button" onClick={handleSave} disabled={saving} className={`${ks.btn} ${ks.btnPri}`}>
            {saved ? '✓ Saved' : saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {/* Test result */}
      {result && (
        <p role="status" className="px-3 py-2 text-sm" style={{
          margin: 0, borderRadius: 9,
          background: result.success ? 'color-mix(in srgb, var(--good) 8%, transparent)' : 'color-mix(in srgb, var(--crit) 8%, transparent)',
          color:      result.success ? 'var(--good)' : 'var(--crit-soft)',
          border:     `1px solid ${result.success ? 'color-mix(in srgb, var(--good) 30%, transparent)' : 'color-mix(in srgb, var(--crit) 30%, transparent)'}`,
        }}>
          {result.success ? `✓ ${result.message ?? 'Connection successful'}` : `✗ ${result.error}`}
        </p>
      )}

      {/* Fields */}
      <div className={ss.fields}>
        {providerFields.map(field => {
          const id = `cred-${category}-${provider}-${field.key}`
          return (
            <div key={field.key} className={ks.field}>
              <label htmlFor={id} className="font-mono" style={{ fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                {field.label}
                {field.isSet && <span style={{ color: 'var(--good)', marginLeft: 6 }}>✓<span className={ks.srOnly}> saved</span></span>}
              </label>
              <div className="relative">
                <input
                  id={id}
                  type={field.masked && !revealed[field.key] ? 'password' : 'text'}
                  className={ks.input}
                  style={field.masked ? { paddingRight: 64 } : undefined}
                  value={values[field.key]}
                  placeholder={field.isSet ? (field.masked ? '••••••••' : field.value) : `Enter ${field.label.toLowerCase()}...`}
                  onChange={e => setValues(v => ({ ...v, [field.key]: e.target.value }))}
                />
                {field.masked && (
                  <button
                    type="button"
                    onClick={() => setRevealed(r => ({ ...r, [field.key]: !r[field.key] }))}
                    className={ss.reveal}
                    aria-label={`${revealed[field.key] ? 'Hide' : 'Show'} ${field.label}`}
                  >
                    {revealed[field.key] ? 'hide' : 'show'}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
//  Main settings page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const [tab,    setTab]    = useState<'proxmox' | 'proxy' | 'dns' | 'remote' | 'system'>('proxmox')
  const [fields, setFields] = useState<Record<string, CredentialField[]>>({})
  const [loading, setLoading] = useState(true)
  const { role, status } = useSession()

  const fetchCategory = useCallback(async (category: string) => {
    const res  = await fetch(`/api/settings/${category}`)
    const json = await res.json()
    if (json.success) setFields(f => ({ ...f, [category]: json.data }))
  }, [])

  useEffect(() => {
    Promise.all(['proxmox', 'proxy', 'dns', 'remote', 'system'].map(fetchCategory))
      .finally(() => setLoading(false))
    // Other pages link straight to a tab (?tab=remote).
    const want = new URLSearchParams(window.location.search).get('tab')
    if (want && want in CATEGORY_META) setTab(want as any)
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

  if (role && !atLeast(role, 'admin')) {
    return (
      <Page>
        <Panel title="Settings">
          <p className={ks.callout} style={{ margin: 0 }}>
            Your role can&apos;t view settings. Ask an owner or admin if you need a change.
          </p>
        </Panel>
      </Page>
    )
  }

  // The HUD's reading, from the credentials already loaded: how many providers have their logins saved.
  // "Set" uses the same rule as each provider's own "Configured" badge.
  const providers = (Object.keys(CATEGORY_META) as Array<keyof typeof CATEGORY_META>).flatMap(cat =>
    Object.keys(CATEGORY_META[cat].providers).map(provider => {
      const pf = (fields[cat] ?? []).filter(f => f.provider === provider)
      const set = pf.length > 0 && (cat === 'remote' ? pf.some(f => f.masked && f.isSet) : pf.every(f => f.isSet))
      return { cat, provider, shown: pf.length > 0, set }
    })).filter(p => p.shown)
  const setCount = providers.filter(p => p.set).length
  const catsDone = (Object.keys(CATEGORY_META)).filter(cat => {
    const cf = fields[cat] ?? []
    return cf.length > 0 && cf.every(f => f.isSet)
  }).length
  const vaultWord = status ? (status.locked ? 'Vault locked' : 'Vault unlocked') : 'Vault'
  const chips: StatChip[] = [
    { label: 'logins set', value: loading ? '…' : `${setCount}/${providers.length}`, tone: !loading && providers.length > 0 && setCount === providers.length ? 'good' : 'accent' },
    { label: 'areas complete', value: loading ? '…' : `${catsDone}/${Object.keys(CATEGORY_META).length}` },
    { label: 'your role', value: role ?? '…', tone: 'violet' },
  ]

  return (
    <Page>
      <HudHeader level={2} label="Settings overview" icon="lock"
        eyebrow={[vaultWord, 'Credentials'].join(' · ')}
        title={loading ? 'Reading your settings…' : `${setCount} of ${providers.length} connections have their logins saved`}
        chips={chips}
        actions={
          <Link href="/settings/setup-checklist" className={`${ks.btn} ${ks.btnPri}`} style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>
            Setup checklist &rarr;
          </Link>
        }
      />

      {/* Section tiles: every other settings page, one tap away */}
      <Panel title="Settings areas" sub="everything else lives here">
        <ul className={ss.areas}>
          {AREAS.map(a => (
            <li key={a.href}>
              <Link href={a.href} className={ss.area}>
                <span><Icon name={a.icon} />{a.label}<i aria-hidden>&rarr;</i></span>
                <small>{a.sub}</small>
              </Link>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Connections" sub="the logins HyperProx uses">
        {/* Category tabs */}
        <div className={ss.tabs} role="group" aria-label="Credential category">
          {(Object.keys(CATEGORY_META) as Array<keyof typeof CATEGORY_META>).map(cat => {
            const m = CATEGORY_META[cat]
            const catFields = fields[cat] ?? []
            const allSet = catFields.length > 0 && catFields.every(f => f.isSet)
            return (
              <button key={cat} type="button" onClick={() => setTab(cat as any)} aria-pressed={tab === cat} className={ss.tab}
                style={tab === cat ? { color: m.accent, borderColor: `color-mix(in srgb, ${m.accent} 45%, transparent)` } : undefined}>
                {m.label}
                {allSet && <><i className={ks.hdot} aria-hidden style={{ background: m.accent, boxShadow: 'none' }} /><span className={ks.srOnly}>, all set</span></>}
              </button>
            )
          })}
        </div>

        {loading ? (
          <p className={`${ks.empty} animate-pulse`} style={{ marginTop: 14 }}>Loading credentials...</p>
        ) : (
          <div className="flex flex-col gap-3" style={{ marginTop: 14 }}>
            {tab === 'proxy' && (
              <p className={ks.callout} style={{ margin: 0 }}>
                More proxies (a second NPM, Traefik, Caddy, HAProxy, Pangolin) are added on the <Link href="/proxy" style={{ color: 'var(--accent)' }}>Proxy page</Link>.
              </p>
            )}
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
      </Panel>
    </Page>
  )
}
