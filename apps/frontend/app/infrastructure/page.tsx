'use client'

// Infrastructure: every guest at a glance (status, resources, address, tags, GPU, VPN and HA), fast filters,
// grouping by node, a drill-down per guest with the config editor, and a Devices view per node.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { alpha } from '@/lib/theme'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { Notice } from '@/components/vault/ui'
import { GuestTable } from '@/components/guest-config/GuestList'
import { GuestDrawer } from '@/components/guest-config/GuestDrawer'
import { DevicesPanel } from '@/components/guest-config/DevicesPanel'
import { CreateGuestModal } from '@/components/guest-config/CreateGuest'
import { API, type GuestRow } from '@/components/guest-config/types'
import { useHaBadges } from '@/components/ha'

interface PVENode { node: string; status: string; maxcpu: number; maxmem: number; cpu?: number; mem?: number }

type StatusFilter = 'all' | 'running' | 'stopped'
type TypeFilter = 'all' | 'lxc' | 'qemu'

function Chip({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button onClick={onClick} title={title} className="text-sm px-3 rounded-md whitespace-nowrap" style={{
      height: 34, background: active ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent',
      color: active ? 'var(--accent)' : 'var(--text-dim)', border: `1px solid ${active ? 'color-mix(in srgb, var(--accent) 35%, transparent)' : 'var(--border-dim)'}`,
    }}>{children}</button>
  )
}

export default function InfrastructurePage() {
  const { role } = useSession()
  const canOperate = atLeast(role, 'operator')
  const canAdmin = atLeast(role, 'admin')
  const [view, setView] = useState<'guests' | 'devices'>('guests')
  const [nodes, setNodes] = useState<PVENode[]>([])
  const [rows, setRows] = useState<GuestRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [lastSync, setLastSync] = useState<Date | null>(null)
  const [nodePower, setNodePower] = useState<Record<string, number | null>>({})
  const [status, setStatus] = useState<StatusFilter>('all')
  const [type, setType] = useState<TypeFilter>('all')
  const [node, setNode] = useState('all')
  const [onlyGpu, setOnlyGpu] = useState(false)
  const [onlyHa, setOnlyHa] = useState(false)
  const [search, setSearch] = useState('')
  const [group, setGroup] = useState(false)
  const [selected, setSelected] = useState<{ type: string; vmid: number } | null>(null)
  const [create, setCreate] = useState<null | 'lxc' | 'qemu'>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const haBadges = useHaBadges()

  useEffect(() => { try { setGroup(localStorage.getItem('infra.group') === '1') } catch { /* private mode */ } }, [])
  const toggleGroup = () => setGroup(g => { try { localStorage.setItem('infra.group', g ? '0' : '1') } catch { /* ignore */ } return !g })

  const fetchData = useCallback(async () => {
    const [n, o] = await Promise.all([apiJson<{ data: PVENode[] }>('/api/proxmox/nodes'), apiJson<{ data: GuestRow[] }>(`${API}/overview`)])
    if (n.ok) setNodes(n.body!.data ?? [])
    if (o.ok) { setRows(o.body!.data ?? []); setErr(null); setLastSync(new Date()) } else setErr(o.error ?? 'Could not read the guests')
    setLoading(false)
  }, [])
  useEffect(() => { void fetchData(); const t = setInterval(fetchData, 8000); return () => clearInterval(t) }, [fetchData])
  useEffect(() => {
    apiJson<{ data: { nodes: Array<{ node: string; total: number | null }> } }>('/api/prometheus/power')
      .then(r => { if (r.ok) setNodePower(Object.fromEntries(r.body!.data.nodes.map(x => [x.node, x.total]))) })
  }, [lastSync?.getMinutes()])   // eslint-disable-line react-hooks/exhaustive-deps

  /** Power from the list. HA guests go through HA state; the rest use the power routes as before. */
  const power = async (g: GuestRow, action: string) => {
    const ha = action.startsWith('ha:')
    const path = ha ? `/api/infra/ha/${encodeURIComponent(`${g.type === 'qemu' ? 'vm' : 'ct'}:${g.vmid}`)}` : `/api/infra/vms/${g.node}/${g.vmid}/${g.type}/${action}`
    const r = await apiJson(path, ha ? 'PUT' : 'POST', ha ? { state: action.slice(3) } : undefined)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void power(g, action)); return }
    setMsg(r.ok ? `${g.name}: ${ha ? `HA ${action.slice(3)}` : action} requested` : `${g.name}: ${r.error ?? 'failed'}`)
    setTimeout(fetchData, 1200)
  }

  const q = search.trim().toLowerCase()
  const filtered = useMemo(() => rows
    .filter(r => !r.template)
    .filter(r => status === 'all' || (status === 'running' ? r.status === 'running' : r.status !== 'running'))
    .filter(r => type === 'all' || r.type === type)
    .filter(r => node === 'all' || r.node === node)
    .filter(r => !onlyGpu || r.gpu.vendors.length > 0 || r.gpu.toggle === 'off')
    .filter(r => !onlyHa || r.ha.managed)
    .filter(r => !q || r.name.toLowerCase().includes(q) || String(r.vmid).includes(q) || (r.ip ?? '').includes(q) || r.tags.some(t => t.includes(q)))
    .sort((a, b) => a.vmid - b.vmid), [rows, status, type, node, onlyGpu, onlyHa, q])

  const groups = useMemo(() => {
    if (!group) return [{ node: null as string | null, rows: filtered }]
    const by = new Map<string, GuestRow[]>()
    for (const r of filtered) by.set(r.node, [...(by.get(r.node) ?? []), r])
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([n, rs]) => ({ node: n, rows: rs }))
  }, [filtered, group])

  const sel = selected ? rows.find(r => r.type === selected.type && r.vmid === selected.vmid) ?? null : null
  const running = rows.filter(r => r.status === 'running').length
  const sortedNodes = [...nodes].sort((a, b) => a.node.localeCompare(b.node))

  return (
    <div className="min-h-full px-4 py-5 sm:p-8" style={{ background: 'var(--ground)' }}>
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const f = reconfirm; setReconfirm(null); f() }} />}
      {create && <CreateGuestModal type={create} nodes={nodes} onClose={() => { setCreate(null); void fetchData() }} />}

      <div className="flex items-end justify-between flex-wrap gap-4 mb-6">
        <div>
          <div className="font-mono uppercase" style={{ fontSize: 12, letterSpacing: '0.14em', color: 'var(--accent)' }}>Compute</div>
          <h1 className="font-display font-bold mt-1" style={{ fontSize: 36, lineHeight: 1.1, color: 'var(--text-bright)' }}>Infrastructure</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-dimmer)' }}>{running} running of {rows.filter(r => !r.template).length}{lastSync ? ` · synced ${lastSync.toLocaleTimeString()}` : ''}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex rounded-md border overflow-hidden" style={{ borderColor: 'var(--border-strong)' }}>
            {(['guests', 'devices'] as const).map(v => (
              <button key={v} onClick={() => setView(v)} className="px-4 text-sm" style={{ height: 38, background: view === v ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent', color: view === v ? 'var(--accent)' : 'var(--text-dim)' }}>{v === 'guests' ? 'Guests' : 'Devices'}</button>
            ))}
          </div>
          {canAdmin && <button onClick={() => setCreate('lxc')} className="px-4 rounded-md text-sm font-semibold" style={{ height: 38, background: 'var(--accent)', color: 'var(--accent-ink)' }}>+ LXC</button>}
          {canAdmin && <button onClick={() => setCreate('qemu')} className="px-4 rounded-md text-sm font-semibold" style={{ height: 38, border: '1px solid var(--violet)', color: 'var(--violet)' }}>+ VM</button>}
        </div>
      </div>

      {/* nodes: tap to filter */}
      <div className="flex gap-2 overflow-x-auto pb-1 mb-5 -mx-4 px-4 sm:mx-0 sm:px-0 sm:grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' }}>
        {sortedNodes.map(n => {
          const nr = rows.filter(r => r.node === n.node && !r.template)
          const on = nr.filter(r => r.status === 'running').length
          const gpu = nr.some(r => r.gpu.vendors.length)
          const active = node === n.node
          const memPct = n.maxmem && n.mem ? Math.round(n.mem / n.maxmem * 100) : null
          return (
            <button key={n.node} onClick={() => setNode(active ? 'all' : n.node)} className="shrink-0 min-w-[150px] rounded-lg border p-3 text-left"
              style={{ background: active ? alpha('var(--accent)', 8) : 'var(--surface)', borderColor: active ? alpha('var(--accent)', 35) : 'var(--border-dim)' }}>
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: n.status === 'online' ? 'var(--good)' : 'var(--crit-2)' }} />
                <span className="font-display font-semibold" style={{ fontSize: 17, color: 'var(--text-bright)' }}>{n.node}</span>
                {gpu && <span className="font-mono rounded px-1" style={{ fontSize: 9, color: 'var(--violet)', border: '1px solid color-mix(in srgb, var(--violet) 35%, transparent)' }}>GPU</span>}
              </div>
              <div className="flex gap-2 text-xs font-mono mt-1" style={{ fontVariantNumeric: 'tabular-nums' }}>
                <span style={{ color: 'var(--good)' }}>{on} on</span><span style={{ color: 'var(--text-dimmer)' }}>{nr.length - on} off</span>
                {memPct !== null && <span style={{ color: 'var(--text-dimmer)' }}>RAM {memPct}%</span>}
                {n.node in nodePower && <span className="ml-auto" style={{ color: nodePower[n.node] === null ? 'var(--text-dimmer)' : 'var(--warn)' }}
                  title="CPU package plus any discrete GPU. Drives, fans and PSU losses are not measured.">{nodePower[n.node] === null ? '— W' : `${Math.round(nodePower[n.node]!)} W`}</span>}
              </div>
            </button>
          )
        })}
      </div>

      {view === 'devices' ? <DevicesPanel nodes={sortedNodes.map(n => n.node)} /> : (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <input type="search" placeholder="Search name, ID, IP or tag" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search guests"
              className="text-sm px-3 rounded-md outline-none w-full sm:w-64 order-first" style={{ height: 38, background: 'var(--ground-deep)', border: '1px solid var(--border-strong)', color: 'var(--text-bright)' }} />
            <div className="flex gap-1.5 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 w-[calc(100%+2rem)] sm:w-auto">
              {(['all', 'running', 'stopped'] as const).map(s => <Chip key={s} active={status === s} onClick={() => setStatus(s)}>{s === 'all' ? 'All' : s === 'running' ? 'Running' : 'Stopped'}</Chip>)}
              <span className="w-px shrink-0" style={{ background: 'var(--border-dim)' }} />
              {(['all', 'lxc', 'qemu'] as const).map(t => <Chip key={t} active={type === t} onClick={() => setType(t)}>{t === 'all' ? 'Any type' : t === 'lxc' ? 'Containers' : 'VMs'}</Chip>)}
              <span className="w-px shrink-0" style={{ background: 'var(--border-dim)' }} />
              <Chip active={onlyGpu} onClick={() => setOnlyGpu(x => !x)}>GPU</Chip>
              <Chip active={onlyHa} onClick={() => setOnlyHa(x => !x)}>HA</Chip>
              <Chip active={group} onClick={toggleGroup} title="Group the list by node">By node</Chip>
            </div>
            <span className="text-sm sm:ml-auto" style={{ color: 'var(--text-dimmer)' }}>{filtered.length} shown</span>
          </div>
          {msg && <div className="mb-3"><Notice kind="info">{msg}</Notice></div>}
          {err && <div className="mb-3"><Notice kind="error">{err}</Notice></div>}
          {loading ? <div className="text-sm animate-pulse" style={{ color: 'var(--text-dimmer)' }}>Loading infrastructure…</div> : (
            <div className="space-y-6">
              {groups.map(gr => (
                <section key={gr.node ?? 'all'} className="space-y-2">
                  {gr.node && <h2 className="font-display font-semibold" style={{ fontSize: 18, color: 'var(--text-bright)' }}>{gr.node} <span className="font-mono text-xs" style={{ color: 'var(--text-dimmer)' }}>{gr.rows.length}</span></h2>}
                  <GuestTable rows={gr.rows} canOperate={canOperate} canAdmin={canAdmin} onOpen={r => setSelected({ type: r.type, vmid: r.vmid })} onPower={power} onRefresh={() => { void fetchData(); void haBadges.reload() }} ha={haBadges.get} />
                </section>
              ))}
              {filtered.length === 0 && <p className="text-sm" style={{ color: 'var(--text-dimmer)' }}>No guests match.</p>}
            </div>
          )}
        </>
      )}

      {sel && <GuestDrawer row={sel} nodes={nodes} canOperate={canOperate} canAdmin={canAdmin} onClose={() => setSelected(null)} onRefresh={fetchData} />}
    </div>
  )
}
