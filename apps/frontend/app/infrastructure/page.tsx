'use client'

const gpuNodes = (process.env.NEXT_PUBLIC_GPU_NODES ?? '').split(',').filter(Boolean)


import { useEffect, useState, useCallback } from 'react'
import { formatBytes, formatUptime } from '@/lib/utils'

interface PVENode { node: string; status: string; maxcpu: number; maxmem: number }
interface PVEVM {
  vmid: number; name: string; status: string; type: 'qemu'|'lxc'
  node: string; cpus: number; cpu: number; mem: number; maxmem: number
  maxdisk: number; disk: number; uptime: number; hastate?: string; tags?: string
}
interface Snapshot { name: string; description: string; snaptime: number; vmstate: number; parent?: string }

type ActionState = { vmid: number; action: string } | null

const STATUS_COLOR: Record<string, string> = {
  running: '#22c55e', stopped: '#374151', paused: '#ffaa00', suspended: '#6366f1',
}

function Badge({ label, color }: { label: string; color: string }) {
  return <span className="font-mono px-1.5 py-0.5 rounded" style={{ fontSize: 9, background: `${color}15`, color, border: `1px solid ${color}25` }}>{label}</span>
}

// VM detail / actions panel
function VMPanel({ vm, nodes, onClose, onRefresh }: {
  vm: PVEVM; nodes: PVENode[]; onClose: () => void; onRefresh: () => void
}) {
  const [tab,        setTab]       = useState<'overview'|'snapshots'|'migrate'|'config'>('overview')
  const [snapshots,  setSnapshots] = useState<Snapshot[]>([])
  const [snapName,   setSnapName]  = useState('')
  const [migrTarget, setMigrTarget] = useState('')
  const [acting,     setActing]    = useState(false)
  const [status,     setStatus]    = useState<string|null>(null)
  const [error,      setError]     = useState<string|null>(null)
  const [config,     setConfig]    = useState<any>(null)

  const proxmoxUrl = process.env.NEXT_PUBLIC_PROXMOX_URL ?? ''

  useEffect(() => {
    if (tab === 'snapshots') {
      fetch(`/api/infra/vms/${vm.node}/${vm.vmid}/${vm.type}/snapshots`)
        .then(r=>r.json()).then(j=>{ if(j.success) setSnapshots(j.data) })
    }
    if (tab === 'config') {
      fetch(`/api/infra/vms/${vm.node}/${vm.vmid}/${vm.type}/config`)
        .then(r=>r.json()).then(j=>{ if(j.success) setConfig(j.data) })
    }
  }, [tab, vm])

  const doAction = async (action: string) => {
    setActing(true); setStatus(`${action}...`); setError(null)
    try {
      const res  = await fetch(`/api/infra/vms/${vm.node}/${vm.vmid}/${vm.type}/${action}`, { method: 'POST' })
      const json = await res.json()
      if (!json.success) throw new Error(json.error)
      setStatus(`${action} initiated`)
      setTimeout(() => { onRefresh(); setStatus(null) }, 1500)
    } catch(e: any) { setError(e.message) }
    finally { setActing(false) }
  }

  const openConsole = async () => {
    try {
      const res  = await fetch(`/api/infra/vms/${vm.node}/${vm.vmid}/${vm.type}/vnc`, { method: 'POST' })
      const json = await res.json()
      if (!json.success) throw new Error(json.error)
      const { ticket, port } = json.data
      const url = `${proxmoxUrl}/?console=${vm.type}&novnc=1&vmid=${vm.vmid}&vmname=${vm.name}&node=${vm.node}&ticket=${encodeURIComponent(ticket)}`
      window.open(url, '_blank', 'width=1024,height=768')
    } catch(e: any) { setError((e as any).message) }
  }

  const setHAState = async (state: 'started'|'stopped'|'disabled') => {
    const sid = `${vm.type==='qemu'?'vm':'ct'}:${vm.vmid}`
    setActing(true); setStatus(`Setting HA ${state}...`); setError(null)
    try {
      const res  = await fetch(`/api/infra/ha/${encodeURIComponent(sid)}`, {
        method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ state }),
      })
      const json = await res.json()
      if (!json.success) throw new Error(json.error)
      setStatus(`HA state set to ${state}`)
      setTimeout(() => { onRefresh(); setStatus(null) }, 1500)
    } catch(e: any) { setError((e as any).message) }
    finally { setActing(false) }
  }

  const createSnapshot = async () => {
    if (!snapName.trim()) return
    setActing(true); setStatus('Creating snapshot...')
    try {
      const res  = await fetch(`/api/infra/vms/${vm.node}/${vm.vmid}/${vm.type}/snapshots`, {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name: snapName }),
      })
      const json = await res.json()
      if (!json.success) throw new Error(json.error)
      setSnapName(''); setStatus('Snapshot created')
      setTimeout(() => { setTab('snapshots'); setStatus(null) }, 1000)
    } catch(e: any) { setError((e as any).message) }
    finally { setActing(false) }
  }

  const deleteSnapshot = async (snapname: string) => {
    setActing(true)
    try {
      await fetch(`/api/infra/vms/${vm.node}/${vm.vmid}/${vm.type}/snapshots/${snapname}`, { method: 'DELETE' })
      setSnapshots(s => s.filter(x => x.name !== snapname))
    } finally { setActing(false) }
  }

  const rollbackSnapshot = async (snapname: string) => {
    if (!confirm(`Rollback to ${snapname}? This cannot be undone.`)) return
    setActing(true); setStatus('Rolling back...')
    try {
      const res  = await fetch(`/api/infra/vms/${vm.node}/${vm.vmid}/${vm.type}/snapshots/${snapname}/rollback`, { method: 'POST' })
      const json = await res.json()
      if (!json.success) throw new Error(json.error)
      setStatus('Rollback initiated')
      setTimeout(() => { onRefresh(); onClose() }, 1500)
    } catch(e: any) { setError((e as any).message) }
    finally { setActing(false) }
  }

  const migrate = async () => {
    if (!migrTarget) return
    setActing(true); setStatus(`Migrating to ${migrTarget}...`)
    try {
      const res  = await fetch(`/api/infra/vms/${vm.node}/${vm.vmid}/${vm.type}/migrate`, {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ target: migrTarget }),
      })
      const json = await res.json()
      if (!json.success) throw new Error(json.error)
      setStatus('Migration started')
      setTimeout(() => { onRefresh(); onClose() }, 2000)
    } catch(e: any) { setError((e as any).message) }
    finally { setActing(false) }
  }

  const INPUT = { background:'#060a10', border:'1px solid #1f2937', color:'#e5e7eb', borderRadius:6, padding:'6px 10px', fontFamily:'IBM Plex Mono,monospace', fontSize:11, outline:'none' } as React.CSSProperties
  const isRunning = vm.status === 'running'

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" style={{ background:'rgba(0,0,0,0.85)', backdropFilter:'blur(4px)' }}>
      <div className="w-full max-w-2xl rounded-xl border overflow-hidden" style={{ background:'#0a0f1a', borderColor:'#00e5ff25', boxShadow:'0 0 40px #00e5ff08' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor:'#111827' }}>
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full" style={{ background: STATUS_COLOR[vm.status]??'#374151', boxShadow:`0 0 5px ${STATUS_COLOR[vm.status]??'#374151'}` }}/>
            <span className="font-display font-semibold uppercase" style={{ color:'#00e5ff', fontSize:15 }}>{vm.name}</span>
            <Badge label={vm.type.toUpperCase()} color={vm.type==='lxc'?'#00e5ff':'#a78bfa'}/>
            <Badge label={`CT/VM ${vm.vmid}`} color="#374151"/>
            <Badge label={vm.node} color="#6b7280"/>
          </div>
          <button onClick={onClose} style={{ color:'#374151', fontSize:18 }}>✕</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b" style={{ borderColor:'#111827' }}>
          {(['overview','snapshots','migrate','config'] as const).map(t=>(
            <button key={t} onClick={()=>setTab(t)} className="px-4 py-2.5 text-xs font-mono uppercase tracking-wider capitalize transition-colors"
              style={{ borderBottom: tab===t?'2px solid #00e5ff':'2px solid transparent', color: tab===t?'#00e5ff':'#4b5563', background:'transparent' }}>
              {t}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto" style={{ maxHeight:'55vh' }}>

          {/* Status/error bar */}
          {(status||error) && (
            <div className="mb-4 px-3 py-2 rounded text-xs font-mono" style={{
              background: error?'#ff444410':'#22c55e10',
              color:      error?'#f87171':'#4ade80',
              border:     `1px solid ${error?'#ff444430':'#22c55e30'}`,
            }}>{error??status}</div>
          )}

          {/* OVERVIEW */}
          {tab === 'overview' && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                {[
                  {label:'Status',  value:vm.status,                        color:STATUS_COLOR[vm.status]??'#374151'},
                  {label:'CPU',     value:`${Math.round(vm.cpu*100)}% / ${vm.cpus} cores`, color:'#00e5ff'},
                  {label:'Memory',  value:`${formatBytes(vm.mem)} / ${formatBytes(vm.maxmem)}`, color:'#00e5ff'},
                  {label:'Disk',    value:formatBytes(vm.maxdisk),           color:'#818cf8'},
                  {label:'Uptime',  value:vm.uptime?formatUptime(vm.uptime):'—', color:'#6b7280'},
                  {label:'HA',      value:vm.hastate??'none',                color:vm.hastate==='started'?'#22c55e':vm.hastate?'#ffaa00':'#374151'},
                ].map(({label,value,color})=>(
                  <div key={label} className="p-3 rounded" style={{background:'#060a10',border:'1px solid #111827'}}>
                    <div className="text-xs font-mono text-gray-500 mb-1">{label}</div>
                    <div className="text-xs font-mono font-semibold" style={{color}}>{value}</div>
                  </div>
                ))}
              </div>

              {/* Power actions */}
              <div>
                <div className="text-xs font-mono text-gray-500 uppercase tracking-wider mb-2">Power</div>
                <div className="flex gap-2 flex-wrap">
                  {!isRunning && (
                    <ActionBtn label="Start"    color="#22c55e" onClick={()=>doAction('start')}    disabled={acting}/>
                  )}
                  {isRunning && (
                    <>
                      <ActionBtn label="Shutdown"  color="#ffaa00" onClick={()=>doAction('shutdown')} disabled={acting}/>
                      <ActionBtn label="Reboot"    color="#6366f1" onClick={()=>doAction('reboot')}   disabled={acting}/>
                      <ActionBtn label="Stop"      color="#ff4444" onClick={()=>doAction('stop')}     disabled={acting}/>
                    </>
                  )}
                  <ActionBtn label="Console" color="#00e5ff" onClick={openConsole} disabled={acting}/>
                </div>
              </div>

              {/* HA actions */}
              {vm.hastate !== undefined && (
                <div>
                  <div className="text-xs font-mono text-gray-500 uppercase tracking-wider mb-2">HA State</div>
                  <div className="flex gap-2">
                    <ActionBtn label="Start HA"   color="#22c55e" onClick={()=>setHAState('started')}  disabled={acting||vm.hastate==='started'}/>
                    <ActionBtn label="Stop HA"    color="#ffaa00" onClick={()=>setHAState('stopped')}  disabled={acting||vm.hastate==='stopped'}/>
                    <ActionBtn label="Disable HA" color="#374151" onClick={()=>setHAState('disabled')} disabled={acting||vm.hastate==='disabled'}/>
                  </div>
                </div>
              )}

              {/* Quick snapshot */}
              <div>
                <div className="text-xs font-mono text-gray-500 uppercase tracking-wider mb-2">Quick Snapshot</div>
                <div className="flex gap-2">
                  <input style={{...INPUT, flex:1}} value={snapName} placeholder="snapshot-name"
                    onChange={e=>setSnapName(e.target.value)}
                    onKeyDown={e=>e.key==='Enter'&&createSnapshot()}/>
                  <ActionBtn label="Create" color="#00e5ff" onClick={createSnapshot} disabled={acting||!snapName.trim()}/>
                </div>
              </div>
            </div>
          )}

          {/* SNAPSHOTS */}
          {tab === 'snapshots' && (
            <div className="space-y-3">
              <div className="flex gap-2 mb-4">
                <input style={{...INPUT,flex:1}} value={snapName} placeholder="New snapshot name"
                  onChange={e=>setSnapName(e.target.value)}/>
                <ActionBtn label="Create" color="#00e5ff" onClick={createSnapshot} disabled={acting||!snapName.trim()}/>
              </div>
              {snapshots.length === 0 ? (
                <div className="text-xs font-mono text-gray-600 text-center py-4">No snapshots</div>
              ) : snapshots.filter(s=>s.name!=='current').map(snap=>(
                <div key={snap.name} className="flex items-center gap-3 p-3 rounded" style={{background:'#060a10',border:'1px solid #111827'}}>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-mono text-white">{snap.name}</div>
                    {snap.description&&<div className="text-xs font-mono text-gray-600 truncate">{snap.description}</div>}
                    <div className="text-xs font-mono text-gray-700">{snap.snaptime?new Date(snap.snaptime*1000).toLocaleString():''}</div>
                  </div>
                  <div className="flex gap-1">
                    <ActionBtn label="Rollback" color="#ffaa00" onClick={()=>rollbackSnapshot(snap.name)} disabled={acting}/>
                    <ActionBtn label="Delete"   color="#ff4444" onClick={()=>deleteSnapshot(snap.name)}   disabled={acting}/>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* MIGRATE */}
          {tab === 'migrate' && (
            <div className="space-y-4">
              <div>
                <div className="text-xs font-mono text-gray-500 mb-2">Target Node</div>
                <select style={{...INPUT,width:'100%',cursor:'pointer'}} value={migrTarget} onChange={e=>setMigrTarget(e.target.value)}>
                  <option value="">Select target node...</option>
                  {nodes.filter(n=>n.node!==vm.node&&n.status==='online').map(n=>(
                    <option key={n.node} value={n.node}>{n.node}</option>
                  ))}
                </select>
              </div>
              <div className="p-3 rounded text-xs font-mono" style={{background:'#ffaa0010',border:'1px solid #ffaa0025',color:'#d97706'}}>
                {vm.type==='qemu'?'Live migration — VM will continue running during migration.':'CT migration requires the container to be stopped first.'}
              </div>
              <ActionBtn label={`Migrate to ${migrTarget||'...'}`} color="#00e5ff" onClick={migrate} disabled={acting||!migrTarget}/>
            </div>
          )}

          {/* CONFIG */}
          {tab === 'config' && (
            <div>
              {config ? (
                <pre className="text-xs font-mono text-gray-400 overflow-auto" style={{maxHeight:300}}>
                  {JSON.stringify(config,null,2)}
                </pre>
              ) : (
                <div className="text-xs font-mono text-gray-600 animate-pulse">Loading config...</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ActionBtn({ label, color, onClick, disabled }: { label:string; color:string; onClick:()=>void; disabled?:boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} className="px-3 py-1.5 rounded text-xs font-mono transition-all" style={{
      background: disabled?'#1f2937':`${color}15`,
      color:      disabled?'#374151':color,
      border:     `1px solid ${disabled?'#1f2937':`${color}30`}`,
      cursor:     disabled?'not-allowed':'pointer',
    }}>{label}</button>
  )
}

// Main infrastructure page
export default function InfrastructurePage() {
  const [nodes,     setNodes]     = useState<PVENode[]>([])
  const [vms,       setVMs]       = useState<PVEVM[]>([])
  const [loading,   setLoading]   = useState(true)
  const [selected,  setSelected]  = useState<PVEVM|null>(null)
  const [filter,    setFilter]    = useState<'all'|'running'|'stopped'|'lxc'|'qemu'>('all')
  const [nodeFilter,setNodeFilter]= useState<string>('all')
  const [search,    setSearch]    = useState('')
  const [lastSync,  setLastSync]  = useState<Date|null>(null)
  const [acting,    setActing]    = useState<ActionState>(null)

  const fetchData = useCallback(async () => {
    try {
      const [nodesRes, vmsRes] = await Promise.all([
        fetch('/api/proxmox/nodes'),
        fetch('/api/proxmox/vms'),
      ])
      const nodesJson = await nodesRes.json()
      const vmsJson   = await vmsRes.json()
      if (nodesJson.success) setNodes(nodesJson.data)
      if (vmsJson.success)   setVMs(vmsJson.data)
      setLastSync(new Date())
    } catch(e) { console.error(e) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchData(); const t = setInterval(fetchData, 5000); return ()=>clearInterval(t) }, [fetchData])

  const quickAction = async (vm: PVEVM, action: string) => {
    setActing({ vmid: vm.vmid, action })
    try {
      await fetch(`/api/infra/vms/${vm.node}/${vm.vmid}/${vm.type}/${action}`, { method:'POST' })
      setTimeout(fetchData, 1000)
    } finally { setActing(null) }
  }

  const filtered = vms
    .filter(v => {
      if (filter === 'running') return v.status === 'running'
      if (filter === 'stopped') return v.status === 'stopped'
      if (filter === 'lxc')    return v.type === 'lxc'
      if (filter === 'qemu')   return v.type === 'qemu'
      return true
    })
    .filter(v => nodeFilter === 'all' || v.node === nodeFilter)
    .filter(v => !search || v.name.toLowerCase().includes(search.toLowerCase()) || String(v.vmid).includes(search))
    .sort((a,b) => a.vmid - b.vmid)

  const running = vms.filter(v=>v.status==='running').length

  return (
    <div className="min-h-full p-6" style={{background:'#080c14'}}>

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-1 h-6 rounded-full" style={{background:'#00e5ff',boxShadow:'0 0 8px #00e5ff'}}/>
          <h1 className="font-display text-2xl font-semibold tracking-wide uppercase" style={{color:'#00e5ff'}}>Infrastructure</h1>
        </div>
        <div className="flex items-center gap-3">
          {lastSync && <span className="text-xs font-mono text-gray-600">synced {lastSync.toLocaleTimeString()}</span>}
          <div className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono" style={{background:'#22c55e10',border:'1px solid #22c55e30'}}>
            <span style={{color:'#22c55e'}}>{running}</span>
            <span className="text-gray-600">running</span>
          </div>
          <div className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono" style={{background:'#374151',border:'1px solid #1f2937'}}>
            <span className="text-gray-400">{vms.length}</span>
            <span className="text-gray-600">total</span>
          </div>
        </div>
      </div>

      {/* Node summary row */}
      <div className="grid gap-3 mb-6" style={{gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))'}}>
        {nodes.sort((a,b)=>gpuNodes.includes(a.node)?-1:gpuNodes.includes(b.node)?1:a.node.localeCompare(b.node)).map(node=>{
          const nodeVMs  = vms.filter(v=>v.node===node.node)
          const nodeRunning = nodeVMs.filter(v=>v.status==='running').length
          const isGpu    = gpuNodes.includes(node.node)
          const accent   = isGpu?'#a78bfa':'#00e5ff'
          const isActive = nodeFilter===node.node
          return (
            <button key={node.node} onClick={()=>setNodeFilter(isActive?'all':node.node)}
              className="p-3 rounded-lg border text-left transition-all"
              style={{background:isActive?`${accent}15`:'#0d1220',borderColor:isActive?`${accent}40`:`${accent}20`}}>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-1.5 h-1.5 rounded-full" style={{background:accent,boxShadow:`0 0 4px ${accent}`}}/>
                <span className="font-display font-semibold uppercase text-xs" style={{color:accent}}>{node.node}</span>
                {isGpu&&<span className="font-mono" style={{fontSize:8,background:'#7c3aed20',color:'#a78bfa',border:'1px solid #7c3aed40',padding:'0 4px',borderRadius:3}}>GPU</span>}
              </div>
              <div className="flex gap-2 text-xs font-mono">
                <span style={{color:'#22c55e'}}>{nodeRunning} on</span>
                <span style={{color:'#374151'}}>{nodeVMs.length-nodeRunning} off</span>
              </div>
            </button>
          )
        })}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="flex gap-1">
          {(['all','running','stopped','lxc','qemu'] as const).map(f=>(
            <button key={f} onClick={()=>setFilter(f)} className="text-xs font-mono px-3 py-1.5 rounded capitalize" style={{
              background: filter===f?'#00e5ff15':'transparent',
              color:      filter===f?'#00e5ff':'#4b5563',
              border:     `1px solid ${filter===f?'#00e5ff30':'#1f2937'}`,
            }}>{f}</button>
          ))}
        </div>
        <input type="text" placeholder="Search name or ID..." value={search} onChange={e=>setSearch(e.target.value)}
          className="ml-auto text-xs font-mono px-3 py-1.5 rounded outline-none w-48"
          style={{background:'#0d1220',border:'1px solid #1f2937',color:'#9ca3af',caretColor:'#00e5ff'}}/>
        <span className="text-xs font-mono text-gray-600">{filtered.length} shown</span>
      </div>

      {/* VM Grid */}
      {loading ? (
        <div className="text-xs font-mono text-gray-600 animate-pulse">Loading infrastructure...</div>
      ) : (
        <div className="grid gap-2">
          {/* VM Cards grid */}
          <div className="grid gap-3" style={{gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))'}}>
            {filtered.map(vm=>{
              const isActing  = acting?.vmid === vm.vmid
              const isRunning = vm.status === 'running'
              const isGpu     = gpuNodes.includes(vm.node)
              const typeColor = vm.type === 'lxc' ? '#00e5ff' : '#a78bfa'
              const statusColor = STATUS_COLOR[vm.status] ?? '#374151'
              const cpuPct    = isRunning ? Math.round(vm.cpu * 100) : 0
              const memPct    = vm.maxmem > 0 ? Math.round((vm.mem / vm.maxmem) * 100) : 0
              const barColor  = (p: number) => p > 90 ? '#ff4444' : p > 75 ? '#ffaa00' : typeColor

              return (
                <div key={`${vm.node}-${vm.vmid}`}
                  className="rounded-xl border p-4 cursor-pointer flex flex-col gap-3 transition-all duration-150"
                  style={{
                    background:   'linear-gradient(135deg, #0d1220 0%, #080c14 100%)',
                    borderColor:  isRunning ? `${typeColor}30` : '#111827',
                    boxShadow:    isRunning ? `0 0 12px ${typeColor}06` : 'none',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = `${typeColor}50`; (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = isRunning ? `${typeColor}30` : '#111827'; (e.currentTarget as HTMLElement).style.transform = 'translateY(0)' }}
                  onClick={() => setSelected(vm)}
                >
                  {/* Card header */}
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-2 h-2 rounded-full flex-shrink-0" style={{
                        background: statusColor,
                        boxShadow:  isRunning ? `0 0 6px ${statusColor}` : 'none',
                      }}/>
                      <span className="font-mono text-sm font-bold text-white truncate">{vm.name}</span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                      {isGpu && <span className="font-mono px-1.5 py-0.5 rounded" style={{fontSize:8,background:'#7c3aed20',color:'#a78bfa',border:'1px solid #7c3aed40'}}>GPU</span>}
                      {vm.hastate && <span className="font-mono px-1.5 py-0.5 rounded" style={{fontSize:8,background:'#a78bfa15',color:'#a78bfa',border:'1px solid #a78bfa30'}}>HA</span>}
                      <span className="font-mono px-1.5 py-0.5 rounded" style={{fontSize:8,background:`${typeColor}15`,color:typeColor,border:`1px solid ${typeColor}30`}}>{vm.type.toUpperCase()}</span>
                    </div>
                  </div>

                  {/* Meta row */}
                  <div className="flex items-center gap-3 text-xs font-mono text-gray-500">
                    <span>#{vm.vmid}</span>
                    <span style={{color:'#374151'}}>·</span>
                    <span style={{color: gpuNodes.includes(vm.node)?'#a78bfa':'#4b5563'}}>{vm.node}</span>
                    {vm.uptime > 0 && <>
                      <span style={{color:'#374151'}}>·</span>
                      <span className="text-gray-600">{formatUptime(vm.uptime)}</span>
                    </>}
                  </div>

                  {/* Resource bars — only when running */}
                  {isRunning && (
                    <div className="space-y-1.5">
                      <div>
                        <div className="flex justify-between text-xs font-mono mb-0.5">
                          <span style={{color:'#374151'}}>CPU</span>
                          <span style={{color:barColor(cpuPct)}}>{cpuPct}%</span>
                        </div>
                        <div className="h-1 rounded-full overflow-hidden" style={{background:'#1f2937'}}>
                          <div className="h-full rounded-full transition-all duration-500" style={{width:`${cpuPct}%`,background:barColor(cpuPct)}}/>
                        </div>
                      </div>
                      {vm.maxmem > 0 && (
                        <div>
                          <div className="flex justify-between text-xs font-mono mb-0.5">
                            <span style={{color:'#374151'}}>MEM</span>
                            <span style={{color:barColor(memPct)}}>{formatBytes(vm.mem)} / {formatBytes(vm.maxmem)}</span>
                          </div>
                          <div className="h-1 rounded-full overflow-hidden" style={{background:'#1f2937'}}>
                            <div className="h-full rounded-full transition-all duration-500" style={{width:`${memPct}%`,background:barColor(memPct)}}/>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Stopped state */}
                  {!isRunning && (
                    <div className="text-xs font-mono text-gray-700">
                      {formatBytes(vm.maxdisk)} disk · {vm.cpus} cores · {formatBytes(vm.maxmem)} RAM
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-1.5 pt-1 border-t" style={{borderColor:'#111827'}} onClick={e=>e.stopPropagation()}>
                    {isRunning ? (
                      <>
                        <ActionBtn label="⏹ Stop"    color="#ff4444" onClick={()=>quickAction(vm,'stop')}     disabled={isActing}/>
                        <ActionBtn label="↺ Reboot"  color="#6366f1" onClick={()=>quickAction(vm,'reboot')}   disabled={isActing}/>
                      </>
                    ) : (
                      <ActionBtn label="▶ Start" color="#22c55e" onClick={()=>quickAction(vm,'start')} disabled={isActing}/>
                    )}
                    {vm.hastate === 'stopped' && (
                      <ActionBtn label="HA ▶" color="#a78bfa" onClick={async()=>{
                        const sid=`${vm.type==='qemu'?'vm':'ct'}:${vm.vmid}`
                        await fetch(`/api/infra/ha/${encodeURIComponent(sid)}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:'started'})})
                        fetchData()
                      }} disabled={isActing}/>
                    )}
                    <button
                      className="ml-auto px-2.5 py-1 rounded text-xs font-mono transition-all"
                      style={{background:`${typeColor}10`,color:`${typeColor}80`,border:`1px solid ${typeColor}20`}}
                      onClick={e=>{e.stopPropagation();setSelected(vm)}}
                    >Details →</button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* VM Panel */}
      {selected && (
        <VMPanel
          vm={selected}
          nodes={nodes}
          onClose={()=>setSelected(null)}
          onRefresh={fetchData}
        />
      )}
    </div>
  )
}
