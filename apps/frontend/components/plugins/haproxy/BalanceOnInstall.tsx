// =============================================================================
//  HyperProx — HAProxy's install: the optional "Proxy load balancing" step
//
//  The same form as the HAProxy plug-in's "Proxy load balancing" (LoadBalanceForm: guests,
//  port, health check page, the method with its plain explanation, an optional web
//  address). Left off, the install is exactly what it was. The server checks every
//  pick again and the install is done only once the backend reads back healthy.
// =============================================================================

'use client'

import { useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'
import { LoadBalanceForm } from './HaproxyPage'
import { lbProblems, PROXY_LB_LINE, type LbForm, type PickGuest } from './logic'

const API = '/api/plugins/haproxy'
export const EMPTY_LB: LbForm = { name: '', guests: [], port: '', hostname: '', algorithm: 'roundrobin', checkPath: '/', publish: false, zone: '', proxyInstanceId: '' }

export function BalanceOnInstall({ value, onChange }: { value: LbForm | null; onChange: (v: LbForm | null) => void }) {
  const [guests, setGuests] = useState<PickGuest[] | null>(null)
  const [algorithms, setAlgorithms] = useState<Record<string, string>>({})
  const [zones, setZones] = useState<string[]>([])
  const [proxies, setProxies] = useState<Array<{ id: string; name: string }>>([])
  const on = value !== null
  useEffect(() => {
    if (!on) return
    void apiJson<{ data: PickGuest[] }>(`${API}/guests`).then(r => setGuests(r.ok ? r.body!.data : []))
    void apiJson<{ data: { algorithms: Record<string, string> } }>(`${API}/instances`).then(r => r.ok && setAlgorithms(r.body!.data.algorithms ?? {}))
  }, [on])
  const publish = value?.publish === true
  useEffect(() => {
    if (!publish) return
    void apiJson<{ data: Array<{ domain: string }> }>('/api/dns/domains').then(r => setZones(r.ok ? (r.body!.data ?? []).map(d => d.domain) : []))
    void apiJson<{ data: Array<{ id: string; name: string }> }>('/api/proxy/instances').then(r => setProxies(r.ok ? (r.body!.data ?? []) : []))
  }, [publish])
  const problems = value ? lbProblems(value) : []
  return (
    <div className="rounded-lg border p-4 space-y-3" style={{ borderColor: 'var(--border-soft)', background: 'var(--ground-inset)' }}>
      <label className="flex items-start gap-2 text-sm min-w-0" style={{ color: 'var(--text)' }}>
        <input type="checkbox" checked={on} onChange={e => onChange(e.target.checked ? EMPTY_LB : null)} />
        <span>Proxy load balancing now (optional)
          <span className="block text-[12px]" style={{ color: 'var(--text-dim)' }}>Spread traffic for one app across several guests. It is set up once HAProxy is running, and the install is done only when the guests answer their health check. {PROXY_LB_LINE}</span></span>
      </label>
      {value && (
        <>
          <LoadBalanceForm f={value} set={p => onChange({ ...value, ...p })} guests={guests} zones={zones} proxies={proxies} algorithms={algorithms} />
          {problems.length > 0 && <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>To go on: {problems[0]}</p>}
          {publish && <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>A public name points at HAProxy, so give it a fixed address in the next steps.</p>}
        </>
      )}
    </div>
  )
}
