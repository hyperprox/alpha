'use client'

import { useEffect, useState, useCallback } from 'react'

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
}

interface Domain {
  domain:    string
  domainId:  number
  status:    string
  expires?:  string
  renewAuto: boolean
  locked:    boolean
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TYPE_COLORS: Record<string, string> = {
  A:     '#00e5ff',
  AAAA:  '#22d3ee',
  CNAME: '#a78bfa',
  TXT:   '#f59e0b',
  MX:    '#22c55e',
  SRV:   '#f97316',
  NS:    '#6b7280',
  CAA:   '#ec4899',
}

const INPUT = {
  background: '#060a10', border: '1px solid #1f2937',
  color: '#e5e7eb', borderRadius: 6, padding: '7px 10px',
  fontFamily: 'IBM Plex Mono, monospace', fontSize: 11,
  outline: 'none', width: '100%',
} as React.CSSProperties

const LABEL = {
  display: 'block', fontSize: 10, color: '#4b5563',
  fontFamily: 'IBM Plex Mono, monospace',
  textTransform: 'uppercase' as const, letterSpacing: '0.05em', marginBottom: 4,
}

function daysUntilExpiry(expires?: string): number | null {
  if (!expires) return null
  return Math.floor((new Date(expires).getTime() - Date.now()) / 86400000)
}

// ---------------------------------------------------------------------------
//  Record modal — create / edit
// ---------------------------------------------------------------------------

const EMPTY: DNSRecord = { type: 'A', name: '', data: '', ttl: 3600 }

function RecordModal({ record, domain, onClose, onSave }: {
  record:  DNSRecord | null   // null = create
  domain:  string
  onClose: () => void
  onSave:  () => void
}) {
  const isEdit = !!record
  const [form,    setForm]    = useState<DNSRecord>(record ?? EMPTY)
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [status,  setStatus]  = useState<string | null>(null)

  const set = (k: keyof DNSRecord, v: any) => setForm(f => ({ ...f, [k]: v }))

  const handleSave = async () => {
    if (!form.name || !form.data) { setError('Name and value are required'); return }
    setSaving(true); setError(null)

    try {
      if (isEdit) {
        await fetch(`/api/dns/domains/${domain}/records/${record!.type}/${encodeURIComponent(record!.name)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: form.data, ttl: form.ttl, priority: form.priority }),
        })
      } else {
        const res  = await fetch(`/api/dns/domains/${domain}/records`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form),
        })
        const json = await res.json()
        if (!json.success) throw new Error(json.error)
      }
      setStatus('Saved!')
      setTimeout(() => { onSave(); onClose() }, 500)
    } catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(4px)' }}>
      <div className="w-full max-w-lg rounded-xl border overflow-hidden"
        style={{ background: '#0a0f1a', borderColor: '#00e5ff25', boxShadow: '0 0 40px #00e5ff08' }}>

        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: '#111827' }}>
          <div className="flex items-center gap-3">
            <div className="w-1 h-5 rounded-full" style={{ background: '#00e5ff', boxShadow: '0 0 8px #00e5ff' }}/>
            <h2 className="font-display font-semibold uppercase" style={{ color: '#00e5ff', fontSize: 15 }}>
              {isEdit ? 'Edit Record' : 'New Record'}
            </h2>
            <span className="text-xs font-mono text-gray-600">{domain}</span>
          </div>
          <button onClick={onClose} style={{ color: '#374151', fontSize: 18 }}>✕</button>
        </div>

        <div className="p-5 space-y-4">
          {(error || status) && (
            <div className="px-3 py-2 rounded text-xs font-mono" style={{
              background: error ? '#ff444410' : '#22c55e10',
              color:      error ? '#f87171'   : '#4ade80',
              border:     `1px solid ${error ? '#ff444430' : '#22c55e30'}`,
            }}>{error ?? status}</div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label style={LABEL}>Type</label>
              <select style={{ ...INPUT, cursor: 'pointer' }} value={form.type}
                onChange={e => set('type', e.target.value)} disabled={isEdit}>
                {['A','AAAA','CNAME','TXT','MX','SRV','NS','CAA'].map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={LABEL}>TTL (seconds)</label>
              <select style={{ ...INPUT, cursor: 'pointer' }} value={form.ttl}
                onChange={e => set('ttl', Number(e.target.value))}>
                {[{ v: 600, l: '10 min' }, { v: 1800, l: '30 min' }, { v: 3600, l: '1 hour' },
                  { v: 14400, l: '4 hours' }, { v: 86400, l: '1 day' }].map(({ v, l }) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label style={LABEL}>Name {form.type !== 'MX' && <span className="text-gray-600">(@ for root)</span>}</label>
            <input style={INPUT} value={form.name} placeholder="@ or subdomain"
              onChange={e => set('name', e.target.value)} disabled={isEdit}/>
          </div>

          <div>
            <label style={LABEL}>
              {form.type === 'A'     && 'IP Address'}
              {form.type === 'AAAA'  && 'IPv6 Address'}
              {form.type === 'CNAME' && 'Target (FQDN)'}
              {form.type === 'TXT'   && 'Text Value'}
              {form.type === 'MX'    && 'Mail Server (FQDN)'}
              {form.type === 'NS'    && 'Nameserver'}
              {!['A','AAAA','CNAME','TXT','MX','NS'].includes(form.type) && 'Value'}
            </label>
            <input style={INPUT} value={form.data}
              placeholder={form.type === 'A' ? '192.168.1.1' : form.type === 'CNAME' ? 'target.example.com.' : ''}
              onChange={e => set('data', e.target.value)}/>
          </div>

          {form.type === 'MX' && (
            <div>
              <label style={LABEL}>Priority</label>
              <input style={INPUT} type="number" value={form.priority ?? 10}
                onChange={e => set('priority', Number(e.target.value))}/>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: '#111827' }}>
          <button onClick={onClose} className="px-4 py-2 rounded text-xs font-mono"
            style={{ background: 'transparent', color: '#4b5563', border: '1px solid #1f2937' }}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving}
            className="px-5 py-2 rounded text-xs font-mono"
            style={{ background: '#00e5ff15', color: saving ? '#00e5ff60' : '#00e5ff', border: '1px solid #00e5ff30' }}>
            {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Record'}
          </button>
        </div>
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
      await fetch(`/api/dns/domains/${domain}/records/${record.type}/${encodeURIComponent(record.name)}`, { method: 'DELETE' })
      onDelete(); onClose()
    } finally { setDeleting(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(4px)' }}>
      <div className="w-full max-w-sm rounded-xl border p-6"
        style={{ background: '#0a0f1a', borderColor: '#ff444425' }}>
        <h2 className="font-display font-semibold uppercase mb-2" style={{ color: '#ff6666' }}>Delete Record</h2>
        <p className="text-xs font-mono text-gray-400 mb-1">This will permanently delete:</p>
        <p className="text-sm font-mono mb-1" style={{ color: '#e5e7eb' }}>
          <span style={{ color: TYPE_COLORS[record.type] }}>{record.type}</span> {record.name}.{domain}
        </p>
        <p className="text-xs font-mono mb-5 text-gray-600">→ {record.data}</p>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded text-xs font-mono"
            style={{ background: 'transparent', color: '#4b5563', border: '1px solid #1f2937' }}>Cancel</button>
          <button onClick={handleDelete} disabled={deleting}
            className="px-4 py-2 rounded text-xs font-mono"
            style={{ background: '#ff444415', color: '#ff6666', border: '1px solid #ff444430' }}>
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
  const expiryColor = days === null ? '#374151' : days < 30 ? '#ff4444' : days < 90 ? '#ffaa00' : '#22c55e'

  return (
    <button onClick={onSelect}
      className="p-4 rounded-lg border text-left transition-all w-full"
      style={{
        background:   selected ? '#00e5ff12' : '#0a0f1a',
        borderColor:  selected ? '#00e5ff40' : '#111827',
        boxShadow:    selected ? '0 0 12px #00e5ff08' : 'none',
      }}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{
            background:  domain.status === 'ACTIVE' ? '#22c55e' : '#ff4444',
            boxShadow:   domain.status === 'ACTIVE' ? '0 0 5px #22c55e' : 'none',
          }}/>
          <span className="font-mono text-sm font-semibold" style={{ color: selected ? '#00e5ff' : '#e5e7eb' }}>
            {domain.domain}
          </span>
        </div>
        {domain.locked && <span className="text-xs font-mono text-gray-600">🔒</span>}
      </div>
      <div className="flex items-center gap-3 text-xs font-mono">
        <span className="text-gray-600">{recordCount} records</span>
        {days !== null && (
          <span style={{ color: expiryColor }}>
            {days > 0 ? `expires ${days}d` : 'EXPIRED'}
          </span>
        )}
        {domain.renewAuto && <span style={{ color: '#22c55e', fontSize: 9 }}>AUTO-RENEW</span>}
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

  // Load domains + WAN IP
  useEffect(() => {
    Promise.all([
      fetch('/api/dns/domains').then(r => r.json()),
      fetch('/api/dns/wan').then(r => r.json()),
    ]).then(([domsJson, wanJson]) => {
      if (domsJson.success) {
        setDomains(domsJson.data)
        if (domsJson.data.length > 0) setActiveDomain(domsJson.data[0].domain)
      }
      if (wanJson.success) setWanIP(wanJson.data.ip)
    }).catch(e => setError(e.message))
    .finally(() => setLoading(false))
  }, [])

  // Load records for active domain
  const loadRecords = useCallback(async (domain: string) => {
    setRecLoading(true)
    try {
      const res  = await fetch(`/api/dns/domains/${domain}/records`)
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
        const res  = await fetch(`/api/dns/domains/${d.domain}/records`)
        const json = await res.json()
        if (json.success) setRecordCounts(prev => ({ ...prev, [d.domain]: json.data.length }))
      } catch { /* ignore */ }
    })
  }, [domains, activeDomain])

  const runDDNS = async () => {
    if (!activeDomain) return
    setDdnsRunning(true); setDdnsResult(null)
    try {
      const res  = await fetch(`/api/dns/domains/${activeDomain}/ddns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
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
    <div className="min-h-full flex items-center justify-center" style={{ background: '#080c14' }}>
      <div className="text-xs font-mono text-gray-500 animate-pulse">loading DNS...</div>
    </div>
  )

  if (error) return (
    <div className="min-h-full flex items-center justify-center" style={{ background: '#080c14' }}>
      <div className="text-center">
        <div className="text-red-400 font-mono text-sm mb-1">Failed to connect to GoDaddy</div>
        <div className="text-gray-600 font-mono text-xs">{error}</div>
        <div className="text-gray-700 font-mono text-xs mt-2">Check Settings → DNS → GoDaddy</div>
      </div>
    </div>
  )

  return (
    <div className="min-h-full p-6" style={{ background: '#080c14' }}>

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-1 h-6 rounded-full" style={{ background: '#22d3ee', boxShadow: '0 0 8px #22d3ee' }}/>
          <h1 className="font-display text-2xl font-semibold tracking-wide uppercase" style={{ color: '#22d3ee' }}>DNS Manager</h1>
          <span className="text-xs font-mono px-2 py-0.5 rounded" style={{ background: '#22d3ee10', color: '#22d3ee60', border: '1px solid #22d3ee20' }}>GoDaddy</span>
        </div>
        <div className="flex items-center gap-3">
          {wanIP && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-mono" style={{ background: '#060a10', border: '1px solid #1f2937' }}>
              <span className="text-gray-500">WAN</span>
              <span style={{ color: '#00e5ff' }}>{wanIP}</span>
            </div>
          )}
          {lastSync && <span className="text-xs font-mono text-gray-600">synced {lastSync.toLocaleTimeString()}</span>}
        </div>
      </div>

      <div className="flex gap-5">

        {/* Domain list */}
        <div className="w-64 flex-shrink-0 space-y-2">
          <div className="text-xs font-mono text-gray-600 uppercase tracking-wider mb-3">
            Domains ({domains.length})
          </div>
          {domains.map(d => (
            <DomainCard key={d.domain} domain={d} selected={activeDomain === d.domain}
              recordCount={recordCounts[d.domain] ?? 0}
              onSelect={() => setActiveDomain(d.domain)}/>
          ))}
        </div>

        {/* Records panel */}
        <div className="flex-1 min-w-0">
          {activeDomain && (
            <>
              {/* Domain toolbar */}
              <div className="flex items-center gap-3 mb-4 flex-wrap">
                <div className="flex gap-1">
                  <button key="all" onClick={() => setTypeFilter('all')}
                    className="text-xs font-mono px-2.5 py-1.5 rounded" style={{
                      background: typeFilter === 'all' ? '#22d3ee15' : 'transparent',
                      color:      typeFilter === 'all' ? '#22d3ee'   : '#4b5563',
                      border:     `1px solid ${typeFilter === 'all' ? '#22d3ee30' : '#1f2937'}`,
                    }}>All</button>
                  {types.map(t => (
                    <button key={t} onClick={() => setTypeFilter(t)}
                      className="text-xs font-mono px-2.5 py-1.5 rounded" style={{
                        background: typeFilter === t ? `${TYPE_COLORS[t]}15` : 'transparent',
                        color:      typeFilter === t ? TYPE_COLORS[t]        : '#4b5563',
                        border:     `1px solid ${typeFilter === t ? TYPE_COLORS[t]+'30' : '#1f2937'}`,
                      }}>{t}</button>
                  ))}
                </div>

                <input type="text" placeholder="Search name or value..." value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="text-xs font-mono px-3 py-1.5 rounded outline-none w-48"
                  style={{ background: '#0d1220', border: '1px solid #1f2937', color: '#9ca3af', caretColor: '#22d3ee' }}/>

                <span className="text-xs font-mono text-gray-600">{filtered.length} records</span>

                <div className="ml-auto flex gap-2">
                  {/* DDNS button */}
                  <button onClick={runDDNS} disabled={ddnsRunning}
                    className="text-xs font-mono px-3 py-1.5 rounded transition-all flex items-center gap-1.5"
                    style={{ background: '#f59e0b15', color: ddnsRunning ? '#f59e0b60' : '#f59e0b', border: '1px solid #f59e0b30' }}>
                    {ddnsRunning ? '↻ Updating...' : '↻ DDNS Update'}
                  </button>
                  {/* New record */}
                  <button onClick={() => setEditRecord(null)}
                    className="text-xs font-mono px-3 py-1.5 rounded transition-all flex items-center gap-1.5"
                    style={{ background: '#22d3ee15', color: '#22d3ee', border: '1px solid #22d3ee30' }}>
                    + New Record
                  </button>
                </div>
              </div>

              {/* DDNS result */}
              {ddnsResult && (
                <div className="mb-3 px-3 py-2 rounded text-xs font-mono" style={{ background: '#22c55e10', color: '#4ade80', border: '1px solid #22c55e30' }}>
                  ✓ {ddnsResult}
                </div>
              )}

              {/* Records table */}
              <div className="rounded-lg border overflow-hidden" style={{ borderColor: '#0f1929' }}>
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr style={{ background: '#060a10', borderBottom: '1px solid #0f1929' }}>
                      {['TYPE', 'NAME', 'VALUE', 'TTL', ''].map(h => (
                        <th key={h} className="px-4 py-2 text-left text-gray-600 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {recLoading ? (
                      <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-600 animate-pulse">Loading records...</td></tr>
                    ) : filtered.map((rec, i) => (
                      <tr key={`${rec.type}-${rec.name}-${i}`}
                        style={{ borderBottom: '1px solid #0a0f1a', background: i % 2 === 0 ? '#080c14' : '#0a0f1a' }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = '#0d1220'}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = i % 2 === 0 ? '#080c14' : '#0a0f1a'}
                      >
                        <td className="px-4 py-2.5">
                          <span className="px-1.5 py-0.5 rounded font-mono" style={{
                            fontSize: 9, background: `${TYPE_COLORS[rec.type] ?? '#374151'}15`,
                            color: TYPE_COLORS[rec.type] ?? '#374151',
                            border: `1px solid ${TYPE_COLORS[rec.type] ?? '#374151'}30`,
                          }}>{rec.type}</span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="text-white">{rec.name}</span>
                          <span className="text-gray-600">.{activeDomain}</span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="text-gray-300 truncate block max-w-xs" title={rec.data}>
                            {rec.data.length > 50 ? rec.data.slice(0, 50) + '…' : rec.data}
                          </span>
                          {/* Highlight if matches WAN IP */}
                          {rec.type === 'A' && rec.data === wanIP && (
                            <span className="text-xs" style={{ color: '#22c55e', fontSize: 9 }}>✓ WAN</span>
                          )}
                          {rec.type === 'A' && wanIP && rec.data !== wanIP && (
                            <span className="text-xs" style={{ color: '#ffaa00', fontSize: 9 }}>≠ WAN ({wanIP})</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-gray-600">
                          {rec.ttl >= 86400 ? `${rec.ttl / 86400}d` :
                           rec.ttl >= 3600  ? `${rec.ttl / 3600}h`  :
                           rec.ttl >= 60    ? `${rec.ttl / 60}m`    : `${rec.ttl}s`}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex gap-1">
                            <button onClick={() => setEditRecord(rec)}
                              className="px-2 py-1 rounded text-xs font-mono"
                              style={{ background: '#22d3ee10', color: '#22d3ee80', border: '1px solid #22d3ee20' }}>Edit</button>
                            <button onClick={() => setDeleteRecord(rec)}
                              className="px-2 py-1 rounded text-xs font-mono transition-all"
                              style={{ background: 'transparent', color: '#374151', border: '1px solid transparent' }}
                              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#ff6666'; (e.currentTarget as HTMLElement).style.borderColor = '#ff444430' }}
                              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = '#374151'; (e.currentTarget as HTMLElement).style.borderColor = 'transparent' }}>✕</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {!recLoading && filtered.length === 0 && (
                      <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-600">No records match filter</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Modals */}
      {editRecord !== undefined && activeDomain && (
        <RecordModal record={editRecord} domain={activeDomain}
          onClose={() => setEditRecord(undefined)}
          onSave={() => loadRecords(activeDomain)}/>
      )}
      {deleteRecord && activeDomain && (
        <DeleteModal record={deleteRecord} domain={activeDomain}
          onClose={() => setDeleteRecord(null)}
          onDelete={() => loadRecords(activeDomain)}/>
      )}
    </div>
  )
}
