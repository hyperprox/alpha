'use client'

// =============================================================================
//  HyperProx — the optional public name of an app's web page (Catalogue install)
//
//  Off by default: the app is then reachable on your network only. When a domain is given, HyperProx's own DNS and proxy
//  code (the one the Websites wizard uses) makes the DNS record, the proxy host and the certificate. "Check this name"
//  asks the API for the exact plan first, and nothing is created until the install itself runs.
// =============================================================================

import { useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'
import { GhostButton, INPUT, LABEL, Notice } from '@/components/vault/ui'

interface AddressOptions { dnsConfigured: boolean; domains: string[]; proxies: Array<{ id: string; name: string; kind: string; status: string | null; certificates: string }> }
interface AddressPlan {
  plan?: { domain: string; zone: string; name: string; instanceName: string; record: { type: string; name: string; data: string; ttl: number }; certificate: string }
  errors: string[]; warnings: string[]; checks: string[]
}

export interface PublishChoice { zone: string; name: string; instanceId: string }

/**
 * `onChange` gets the choice once it has been checked, `null` for LAN-only, and `undefined` while the person has turned
 * publishing on but not checked the name yet (the wizard waits).
 */
export function PublishBlock({ appName, onChange }: { appName: string; onChange: (v: PublishChoice | null | undefined) => void }) {
  const [opts, setOpts] = useState<AddressOptions | null>(null)
  const [on, setOn] = useState(false)
  const [zone, setZone] = useState('')
  const [sub, setSub] = useState('')
  const [proxy, setProxy] = useState('')
  const [plan, setPlan] = useState<AddressPlan | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void apiJson<{ data: AddressOptions }>('/api/sites/address/options').then(r => {
      if (!r.ok || !r.body) return
      const a = r.body.data
      setOpts(a)
      setZone(a.domains[0] ?? '')
      setProxy(a.proxies.find(p => p.certificates !== 'none' && p.status !== 'locked')?.id ?? '')
    })
  }, [])

  // A changed name is a new name: its check no longer applies.
  useEffect(() => { setPlan(null) }, [zone, sub, proxy, on])
  useEffect(() => { onChange(!on ? null : plan?.plan ? { zone, name: sub, instanceId: proxy } : undefined) }, [on, plan, zone, sub, proxy, onChange])

  const check = async () => {
    setBusy(true)
    const r = await apiJson<{ data: AddressPlan }>('/api/sites/address', 'POST', { zone, name: sub, instanceId: proxy })
    setBusy(false)
    setPlan(r.ok && r.body ? r.body.data : { errors: [r.error ?? 'The name could not be checked.'], warnings: [], checks: [] })
  }

  if (!opts) return null
  const usable = opts.dnsConfigured && opts.domains.length > 0 && opts.proxies.some(p => p.certificates !== 'none' && p.status !== 'locked')
  return (
    <div className="space-y-3 rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
      <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--text)' }}>
        <input type="checkbox" checked={on} disabled={!usable} onChange={e => setOn(e.target.checked)} />
        <span>Give its web page a name and a certificate<span className="block text-[12px]" style={{ color: 'var(--text-dim)' }}>
          {usable ? `Off: ${appName} is reachable on your network only. On: HyperProx makes the DNS record, the proxy host and the certificate. DNS (port 53) is never published.`
            : `${appName} is reachable on your network only. To give it a public name, set up a DNS provider (Settings, DNS) and a proxy first.`}</span></span>
      </label>
      {on && usable && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <label><span style={LABEL}>Domain</span>
              <select style={INPUT} value={zone} onChange={e => setZone(e.target.value)}>{opts.domains.map(d => <option key={d} value={d}>{d}</option>)}</select></label>
            <label><span style={LABEL}>Name</span>
              <input style={INPUT} value={sub} onChange={e => setSub(e.target.value.toLowerCase().trim())} placeholder="dns" autoCapitalize="none" spellCheck={false} /></label>
            <label><span style={LABEL}>Proxy</span>
              <select style={INPUT} value={proxy} onChange={e => setProxy(e.target.value)}>
                {opts.proxies.map(p => <option key={p.id} value={p.id} disabled={p.certificates === 'none' || p.status === 'locked'}>
                  {p.name} · {p.kind}{p.certificates === 'none' ? ' (no certificates)' : p.status === 'locked' ? ' (locked)' : ''}</option>)}
              </select></label>
          </div>
          <GhostButton type="button" onClick={() => void check()} disabled={busy || !zone || !sub || !proxy}>{busy ? 'Checking…' : 'Check this name'}</GhostButton>
          {plan?.errors.length ? <Notice kind="error">{plan.errors.join(' ')}</Notice> : null}
          {plan?.warnings.length ? <Notice kind="warn">{plan.warnings.join(' ')}</Notice> : null}
          {plan?.plan && (
            <Notice kind="info">Will be created: a {plan.plan.record.type} record {plan.plan.record.name} in {plan.plan.zone} pointing to {plan.plan.record.data}, a proxy host for {plan.plan.domain} on {plan.plan.instanceName}, and its certificate.</Notice>
          )}
          {!plan && <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>Check the name before going on. Nothing is created until the install runs.</p>}
        </>
      )}
    </div>
  )
}
