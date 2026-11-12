'use client'

// Infrastructure: every guest at a glance (status, resources, address, tags, GPU, VPN and HA), fast filters,
// grouping by node, a drill-down per guest with the config editor, and a Devices view per node.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { Notice } from '@/components/vault/ui'
import { GuestTable } from '@/components/guest-config/GuestList'
import { GuestDrawer } from '@/components/guest-config/GuestDrawer'
import { DevicesPanel } from '@/components/guest-config/DevicesPanel'
import { CreateGuestModal } from '@/components/guest-config/CreateGuest'
import { API, type GuestRow } from '@/components/guest-config/types'
import { useHaBadges } from '@/components/ha'
import { formatUptime } from '@/lib/utils'
import { Page, Panel, HudHeader, NodeTile, NodeTiles, Pill, styles, type StatChip } from '@/components/visual/kit'

interface PVENode { node: string; status: string; maxcpu: number; maxmem: number; cpu?: number; mem?: number; disk?: number; maxdisk?: number; uptime?: number }

type StatusFilter = 'all' | 'running' | 'stopped'
type TypeFilter = 'all' | 'lxc' | 'qemu'

function Chip({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button onClick={onClick} title={title} aria-pressed={active} className={`${styles.btn} ${active ? styles.btnPri : ''} whitespace-nowrap`} style={{ minHeight: 34, padding: '4px 12px' }}>{children}</button>
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

  const liveRows = rows.filter(r => !r.template)
  const stopped = liveRows.length - running
  const onlineNodes = nodes.filter(n => n.status === 'online').length
  const gpuGuests = liveRows.filter(r => r.gpu.vendors.length > 0).length
  const chips: StatChip[] = [
    { label: 'running', value: running, tone: 'good' },
    { label: 'stopped', value: stopped, tone: stopped ? undefined : 'dim' },
    { label: 'nodes online', value: `${onlineNodes}/${nodes.length}`, tone: nodes.length && onlineNodes === nodes.length ? 'good' : 'crit' },
    { label: 'GPU guests', value: gpuGuests, tone: 'violet' },
  ]
  const title = loading ? 'Reading the guests…' : `${running} of ${liveRows.length} guests running`

  return (
    <Page>
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const f = reconfirm; setReconfirm(null); f() }} />}
      {create && <CreateGuestModal type={create} nodes={nodes} onClose={() => { setCreate(null); void fetchData() }} />}

      <HudHeader level={2} label="Compute status" eyebrow="Compute" title={title} chips={chips}
        ring={{ value: liveRows.length ? running / liveRows.length : 0, text: `${running}/${liveRows.length}`, label: 'guests running' }}
        actions={
          <>
            <div className={styles.row} role="group" aria-label="View">
              {(['guests', 'devices'] as const).map(v => (
                <button key={v} onClick={() => setView(v)} aria-pressed={view === v} className={`${styles.btn} ${view === v ? styles.btnPri : ''}`}>{v === 'guests' ? 'Guests' : 'Devices'}</button>
              ))}
            </div>
            {canAdmin && <button onClick={() => setCreate('lxc')} className={`${styles.btn} ${styles.btnPri}`}>+ LXC</button>}
            {canAdmin && <button onClick={() => setCreate('qemu')} className={styles.btn} style={{ borderColor: 'var(--violet)', color: 'var(--violet)' }}>+ VM</button>}
          </>
        }>
        {lastSync && <p style={{ margin: 0, color: 'var(--text-soft)', fontSize: 14 }}>synced {lastSync.toLocaleTimeString()}</p>}
      </HudHeader>

      {/* nodes: tap to filter */}
      <Panel title="Nodes" sub="CPU · memory · tap to filter the list">
        <NodeTiles label="Nodes">
          {sortedNodes.map(n => {
            const nr = liveRows.filter(r => r.node === n.node)
            const on = nr.filter(r => r.status === 'running').length
            const gpu = nr.some(r => r.gpu.vendors.length)
            const active = node === n.node
            const off = n.status !== 'online'
            return (
              <NodeTile key={n.node} name={n.node} state={off ? 'off' : 'ok'} cpu={Math.round((n.cpu ?? 0) * 100)} mem={n.maxmem && n.mem ? Math.round(n.mem / n.maxmem * 100) : 0}
                sub={off ? 'offline' : `${n.maxcpu} threads · disk ${n.maxdisk ? Math.round((n.disk ?? 0) / n.maxdisk * 100) : 0}% · up ${formatUptime(n.uptime ?? 0)} · ${on} on · ${nr.length - on} off`}>
                <div className="flex flex-wrap justify-center gap-1.5">
                  {gpu && <Pill tone="violet">GPU</Pill>}
                  {n.node in nodePower && <Pill tone={nodePower[n.node] === null ? undefined : 'warn'} title="CPU package plus any discrete GPU. Drives, fans and PSU losses are not measured.">{nodePower[n.node] === null ? '— W' : `${Math.round(nodePower[n.node]!)} W`}</Pill>}
                </div>
                <button onClick={() => setNode(active ? 'all' : n.node)} aria-pressed={active} className={`${styles.btn} ${active ? styles.btnPri : ''}`} style={{ minHeight: 32, padding: '2px 10px', fontSize: 12 }}>
                  {active ? 'Showing only this node' : 'Show only this node'}
                </button>
              </NodeTile>
            )
          })}
        </NodeTiles>
      </Panel>

      {view === 'devices' ? <DevicesPanel nodes={sortedNodes.map(n => n.node)} /> : (
        <Panel title="Guests" sub={`${filtered.length} shown`}>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <input type="search" placeholder="Search name, ID, IP or tag" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search guests"
              className={`${styles.input} order-first sm:w-64`} />
            <div className="flex gap-1.5 flex-wrap">
              {(['all', 'running', 'stopped'] as const).map(s => <Chip key={s} active={status === s} onClick={() => setStatus(s)}>{s === 'all' ? 'All' : s === 'running' ? 'Running' : 'Stopped'}</Chip>)}
              {(['all', 'lxc', 'qemu'] as const).map(ty => <Chip key={ty} active={type === ty} onClick={() => setType(ty)}>{ty === 'all' ? 'Any type' : ty === 'lxc' ? 'Containers' : 'VMs'}</Chip>)}
              <Chip active={onlyGpu} onClick={() => setOnlyGpu(x => !x)}>GPU</Chip>
              <Chip active={onlyHa} onClick={() => setOnlyHa(x => !x)}>HA</Chip>
              <Chip active={group} onClick={toggleGroup} title="Group the list by node">By node</Chip>
            </div>
          </div>
          {msg && <div className="mb-3"><Notice kind="info">{msg}</Notice></div>}
          {err && <div className="mb-3"><Notice kind="error">{err}</Notice></div>}
          {loading ? <p className={styles.empty} role="status">Loading infrastructure…</p> : (
            <div className="space-y-6">
              {groups.map(gr => (
                <section key={gr.node ?? 'all'} className="space-y-2">
                  {gr.node && <h3 className="font-display font-semibold" style={{ fontSize: 16, color: 'var(--text-bright)' }}>{gr.node} <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>{gr.rows.length}</span></h3>}
                  <GuestTable rows={gr.rows} canOperate={canOperate} canAdmin={canAdmin} onOpen={r => setSelected({ type: r.type, vmid: r.vmid })} onPower={power} onRefresh={() => { void fetchData(); void haBadges.reload() }} ha={haBadges.get} />
                </section>
              ))}
              {filtered.length === 0 && <p className={styles.empty}>No guests match.</p>}
            </div>
          )}
        </Panel>
      )}

      {sel && <GuestDrawer row={sel} nodes={nodes} canOperate={canOperate} canAdmin={canAdmin} onClose={() => setSelected(null)} onRefresh={fetchData} />}
    </Page>
  )
}
