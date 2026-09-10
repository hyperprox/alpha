'use client'

const gpuNodes = (process.env.NEXT_PUBLIC_GPU_NODES ?? '').split(',').filter(Boolean)


import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { formatBytes, formatUptime } from '@/lib/utils'
import { alpha } from '@/lib/theme'

interface PVENode { node: string; status: string; maxcpu: number; maxmem: number }
interface PVEVM {
  vmid: number; name: string; status: string; type: 'qemu'|'lxc'
  node: string; cpus: number; cpu: number; mem: number; maxmem: number
  maxdisk: number; disk: number; uptime: number; hastate?: string; tags?: string
}
interface Snapshot { name: string; description: string; snaptime: number; vmstate: number; parent?: string }

type ActionState = { vmid: number; action: string } | null

const STATUS_COLOR: Record<string, string> = {
  running: 'var(--good)', stopped: 'var(--text-dimmer)', paused: 'var(--warn-2)', suspended: 'var(--violet-2)',
}

function Badge({ label, color }: { label: string; color: string }) {
  return <span className="font-mono px-1.5 py-0.5 rounded" style={{ fontSize: 9, background: `${alpha(color, 8)}`, color, border: `1px solid ${alpha(color, 15)}` }}>{label}</span>
}

// VM detail / actions panel
function VMPanel({ vm, nodes, onClose, onRefresh }: {
  vm: PVEVM; nodes: PVENode[]; onClose: () => void; onRefresh: () => void
}) {
  const [tab,        setTab]       = useState<'overview'|'snapshots'|'migrate'|'config'>('overview')
  const [snapshots,  setSnapshots] = useState<Snapshot[]>([])
  const [snapName,   setSnapName]  = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [migrTarget, setMigrTarget] = useState('')
  const [acting,     setActing]    = useState(false)
  const [status,     setStatus]    = useState<string|null>(null)
  const [error,      setError]     = useState<string|null>(null)
  const [config,     setConfig]    = useState<any>(null)
  const router = useRouter()


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

  // Opens a pane on the Terminal page rather than a Proxmox noVNC popup.
  //
  // The popup never worked: the URL was built from NEXT_PUBLIC_PROXMOX_URL,
  // which is read in one line of this repo and set nowhere, so it opened a
  // relative path at our own root and middleware bounced it to /login. Our own
  // terminal is also the better destination — it reconnects, it keeps
  // scrollback, and its session survives closing the tab.
  const openConsole = () => {
    router.push(`/terminal?open=${vm.type}-${vm.vmid}`)
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

  const deleteVM = async () => {
    setActing(true)
    try {
      const endpoint = vm.type === 'lxc'
        ? `/api/proxmox/nodes/${vm.node}/lxc/${vm.vmid}`
        : `/api/proxmox/nodes/${vm.node}/qemu/${vm.vmid}`
      const res = await fetch(endpoint, { method: 'DELETE' }).then(r=>r.json())
      if (res.success) {
        setStatus('Deleted successfully')
        setConfirmDelete(false)
        onClose()
      } else {
        setStatus('Delete failed: ' + (res.error ?? 'unknown error'))
      }
    } catch (e: any) {
      setStatus('Delete failed: ' + e.message)
    } finally {
      setActing(false) }
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

  const INPUT = { background:'var(--ground-deep)', border:'1px solid var(--text-faint)', color:'var(--text-bright)', borderRadius:6, padding:'6px 10px', fontFamily:'IBM Plex Mono,monospace', fontSize:11, outline:'none' } as React.CSSProperties
  const isRunning = vm.status === 'running'

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" style={{ background:'rgba(0,0,0,0.85)', backdropFilter:'blur(4px)' }}>
      <div className="w-full max-w-2xl rounded-xl border overflow-hidden" style={{ background:'var(--surface-raised)', borderColor:'color-mix(in srgb, var(--accent) 15%, transparent)', boxShadow:'0 0 40px color-mix(in srgb, var(--accent) 3%, transparent)' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor:'var(--border-dim)' }}>
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full" style={{ background: STATUS_COLOR[vm.status]??'var(--text-dimmer)', boxShadow:`0 0 5px ${STATUS_COLOR[vm.status]??'var(--text-dimmer)'}` }}/>
            <span className="font-display font-semibold uppercase" style={{ color:'var(--accent)', fontSize:15 }}>{vm.name}</span>
            <Badge label={vm.type.toUpperCase()} color={vm.type==='lxc'?'var(--accent)':'var(--violet)'}/>
            <Badge label={`CT/VM ${vm.vmid}`} color="var(--text-dimmer)"/>
            <Badge label={vm.node} color="var(--text-muted)"/>
          </div>
          <button onClick={onClose} style={{ color:'var(--text-dimmer)', fontSize:18 }}>✕</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b" style={{ borderColor:'var(--border-dim)' }}>
          {(['overview','snapshots','migrate','config'] as const).map(t=>(
            <button key={t} onClick={()=>setTab(t)} className="px-4 py-2.5 text-xs font-mono uppercase tracking-wider capitalize transition-colors"
              style={{ borderBottom: tab===t?'2px solid var(--accent)':'2px solid transparent', color: tab===t?'var(--accent)':'var(--text-dim)', background:'transparent' }}>
              {t}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto" style={{ maxHeight:'55vh' }}>

          {/* Status/error bar */}
          {(status||error) && (
            <div className="mb-4 px-3 py-2 rounded text-xs font-mono" style={{
              background: error?'color-mix(in srgb, var(--crit-2) 6%, transparent)':'color-mix(in srgb, var(--good) 6%, transparent)',
              color:      error?'var(--crit-soft)':'var(--good)',
              border:     `1px solid ${error?'color-mix(in srgb, var(--crit-2) 19%, transparent)':'color-mix(in srgb, var(--good) 19%, transparent)'}`,
            }}>{error??status}</div>
          )}

          {/* OVERVIEW */}
          {tab === 'overview' && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                {[
                  {label:'Status',  value:vm.status,                        color:STATUS_COLOR[vm.status]??'var(--text-dimmer)'},
                  {label:'CPU',     value:`${Math.round(vm.cpu*100)}% / ${vm.cpus} cores`, color:'var(--accent)'},
                  {label:'Memory',  value:`${formatBytes(vm.mem)} / ${formatBytes(vm.maxmem)}`, color:'var(--accent)'},
                  {label:'Disk',    value:formatBytes(vm.maxdisk),           color:'var(--violet-2)'},
                  {label:'Uptime',  value:vm.uptime?formatUptime(vm.uptime):'—', color:'var(--text-muted)'},
                  {label:'HA',      value:vm.hastate??'none',                color:vm.hastate==='started'?'var(--good)':vm.hastate?'var(--warn-2)':'var(--text-dimmer)'},
                ].map(({label,value,color})=>(
                  <div key={label} className="p-3 rounded" style={{background:'var(--ground-deep)',border:'1px solid var(--border-dim)'}}>
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
                    <ActionBtn label="Start"    color="var(--good)" onClick={()=>doAction('start')}    disabled={acting}/>
                  )}
                  {isRunning && (
                    <>
                      <ActionBtn label="Shutdown"  color="var(--warn-2)" onClick={()=>doAction('shutdown')} disabled={acting}/>
                      <ActionBtn label="Reboot"    color="var(--violet-2)" onClick={()=>doAction('reboot')}   disabled={acting}/>
                      <ActionBtn label="Stop"      color="var(--crit-2)" onClick={()=>doAction('stop')}     disabled={acting}/>
                    </>
                  )}
                  <ActionBtn label="Console" color="var(--accent)" onClick={openConsole} disabled={acting}/>
                </div>
              </div>

              {/* HA actions */}
              {vm.hastate !== undefined && (
                <div>
                  <div className="text-xs font-mono text-gray-500 uppercase tracking-wider mb-2">HA State</div>
                  <div className="flex gap-2">
                    <ActionBtn label="Start HA"   color="var(--good)" onClick={()=>setHAState('started')}  disabled={acting||vm.hastate==='started'}/>
                    <ActionBtn label="Stop HA"    color="var(--warn-2)" onClick={()=>setHAState('stopped')}  disabled={acting||vm.hastate==='stopped'}/>
                    <ActionBtn label="Disable HA" color="var(--text-dimmer)" onClick={()=>setHAState('disabled')} disabled={acting||vm.hastate==='disabled'}/>
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
                  <ActionBtn label="Create" color="var(--accent)" onClick={createSnapshot} disabled={acting||!snapName.trim()}/>
                </div>
              </div>
              {/* Danger zone */}
              <div className="mt-2 pt-3" style={{borderTop:'1px solid var(--text-faint)'}}>
                <div className="text-xs font-mono text-gray-500 uppercase tracking-wider mb-2">Danger Zone</div>
                {!confirmDelete ? (
                  <ActionBtn label={`Delete ${vm.type.toUpperCase()}`} color="var(--crit-2)" onClick={()=>setConfirmDelete(true)} disabled={acting||isRunning}/>
                ) : (
                  <div className="flex items-center gap-2 p-2 rounded" style={{background:'color-mix(in srgb, var(--crit-2) 8%, transparent)',border:'1px solid color-mix(in srgb, var(--crit-2) 19%, transparent)'}}>
                    <span className="text-xs font-mono text-red-400 flex-1">Delete {vm.name} ({vm.vmid})? This cannot be undone.</span>
                    <ActionBtn label="Confirm" color="var(--crit-2)" onClick={deleteVM} disabled={acting}/>
                    <ActionBtn label="Cancel" color="var(--text-dimmer)" onClick={()=>setConfirmDelete(false)} disabled={acting}/>
                  </div>
                )}
                {isRunning && <div className="text-xs font-mono text-gray-600 mt-1">Stop the {vm.type.toUpperCase()} before deleting</div>}
              </div>
            </div>
          )}

          {/* SNAPSHOTS */}
          {tab === 'snapshots' && (
            <div className="space-y-3">
              <div className="flex gap-2 mb-4">
                <input style={{...INPUT,flex:1}} value={snapName} placeholder="New snapshot name"
                  onChange={e=>setSnapName(e.target.value)}/>
                <ActionBtn label="Create" color="var(--accent)" onClick={createSnapshot} disabled={acting||!snapName.trim()}/>
              </div>
              {snapshots.length === 0 ? (
                <div className="text-xs font-mono text-gray-600 text-center py-4">No snapshots</div>
              ) : snapshots.filter(s=>s.name!=='current').map(snap=>(
                <div key={snap.name} className="flex items-center gap-3 p-3 rounded" style={{background:'var(--ground-deep)',border:'1px solid var(--border-dim)'}}>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-mono text-white">{snap.name}</div>
                    {snap.description&&<div className="text-xs font-mono text-gray-600 truncate">{snap.description}</div>}
                    <div className="text-xs font-mono text-gray-700">{snap.snaptime?new Date(snap.snaptime*1000).toLocaleString():''}</div>
                  </div>
                  <div className="flex gap-1">
                    <ActionBtn label="Rollback" color="var(--warn-2)" onClick={()=>rollbackSnapshot(snap.name)} disabled={acting}/>
                    <ActionBtn label="Delete"   color="var(--crit-2)" onClick={()=>deleteSnapshot(snap.name)}   disabled={acting}/>
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
              <div className="p-3 rounded text-xs font-mono" style={{background:'color-mix(in srgb, var(--warn-2) 6%, transparent)',border:'1px solid color-mix(in srgb, var(--warn-2) 15%, transparent)',color:'var(--warn)'}}>
                {vm.type==='qemu'?'Live migration — VM will continue running during migration.':'CT migration requires the container to be stopped first.'}
              </div>
              <ActionBtn label={`Migrate to ${migrTarget||'...'}`} color="var(--accent)" onClick={migrate} disabled={acting||!migrTarget}/>
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
      background: disabled?'var(--text-faint)':`${alpha(color, 8)}`,
      color:      disabled?'var(--text-dimmer)':color,
      border:     `1px solid ${disabled?'var(--text-faint)':`${alpha(color, 19)}`}`,
      cursor:     disabled?'not-allowed':'pointer',
    }}>{label}</button>
  )
}

// Main infrastructure page
export default function InfrastructurePage() {
  const [nodes,     setNodes]     = useState<PVENode[]>([])
  // Watts per node, keyed by name. Null means the node reports no source at
  // all, which is a different thing from drawing nothing and is shown as such.
  const [nodePower, setNodePower] = useState<Record<string, number | null>>({})
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

      fetch('/api/prometheus/power')
        .then(r => r.json())
        .then(d => {
          if (!d.success) return
          setNodePower(Object.fromEntries(
            d.data.nodes.map((n: any) => [n.node, n.total as number | null])))
        })
        .catch(() => { /* the chips simply carry no wattage */ })
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

  const [showCreate, setShowCreate] = useState(false)
  const [createType, setCreateType] = useState<'lxc'|'qemu'>('lxc')
  const [templates, setTemplates] = useState<any[]>([])
  const [nextId, setNextId] = useState<number>(100)
  const [createForm, setCreateForm] = useState({
    node: '', hostname: '', vmid: '', ostemplate: '', storage: 'local-lvm',
    cores: '1', memory: '512', swap: '512', rootfs_size: '8',
    net0: 'name=eth0,bridge=vmbr0,ip=dhcp', password: '', start: true, unprivileged: true,
    // VM specific
    name: '', disk_size: '32', iso: '', ostype: 'l26',
  })
  const [nodeStorages, setNodeStorages] = useState<any[]>([])
  const [isos, setISOs] = useState<any[]>([])
  const [nodeLoading, setNodeLoading] = useState(false)
  const [nodeSpec, setNodeSpec] = useState<{cpus:number,maxmem:number}|null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [createSuccess, setCreateSuccess] = useState('')

  const loadNodeData = async (node: string) => {
    setNodeLoading(true)
    try {
      const [storRes, nodeRes] = await Promise.all([
        fetch('/api/proxmox/storage').then(r=>r.json()),
        fetch(`/api/proxmox/nodes/${node}`).then(r=>r.json()),
      ])
      if (storRes.success) {
        const suitable = storRes.data.filter((s:any) =>
          s.node === node && s.active === 1 &&
          (s.content?.includes('rootdir') || s.content?.includes('images'))
        )
        setNodeStorages(suitable)
        if (suitable.length > 0) setCreateForm(f=>({...f, storage: suitable[0].storage}))
      }
      if (nodeRes.success) {
        setNodeSpec({ cpus: nodeRes.data.cpuinfo?.cpus ?? 1, maxmem: nodeRes.data.memory?.total ?? 0 })
      }
    } catch {}
    finally { setNodeLoading(false) }
  }

  const openCreate = async (type: 'lxc'|'qemu') => {
    setCreateType(type)
    setCreateError('')
    setCreateSuccess('')
    setShowCreate(true)
    try {
      fetch('/api/proxmox/isos').then(r=>r.json()).then(r=>{ if(r.success) setISOs(r.data) }).catch(()=>{})
    const [tplRes, idRes] = await Promise.all([
        fetch('/api/proxmox/templates').then(r=>r.json()),
        fetch('/api/proxmox/nextid').then(r=>r.json()),
      ])
      if (tplRes.success) setTemplates(tplRes.data)
      if (idRes.success) {
        const firstNode = nodes[0]?.node ?? ''
        setNextId(Number(idRes.data))
        setCreateForm(f=>({...f, vmid: String(idRes.data), node: firstNode}))
        if (firstNode) loadNodeData(firstNode)
      }
    } catch {}
  }

  const submitCreate = async () => {
    setCreating(true)
    setCreateError('')
    setCreateSuccess('')
    try {
      const endpoint = createType === 'lxc' ? '/api/proxmox/lxc' : '/api/proxmox/vm'
      const params = createType === 'lxc' ? {
        vmid: Number(createForm.vmid),
        hostname: createForm.hostname,
        ostemplate: createForm.ostemplate,
        storage: createForm.storage,
        rootfs_size: Number(createForm.rootfs_size),
        memory: Number(createForm.memory),
        swap: Number(createForm.swap),
        cores: Number(createForm.cores),
        net0: createForm.net0,
        password: createForm.password,
        start: createForm.start,
        unprivileged: createForm.unprivileged,
      } : {
        vmid: Number(createForm.vmid),
        name: createForm.name,
        memory: Number(createForm.memory),
        cores: Number(createForm.cores),
        storage: createForm.storage,
        disk_size: Number(createForm.disk_size),
        iso: createForm.iso,
        ostype: createForm.ostype,
        start: createForm.start,
      }
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ node: createForm.node, params }),
      }).then(r=>r.json())
      if (res.success) {
        setCreateSuccess(`${createType.toUpperCase()} ${createForm.vmid} created successfully!`)
        setTimeout(() => { setShowCreate(false); setCreateSuccess('') }, 2000)
      } else {
        setCreateError(res.error ?? 'Creation failed')
      }
    } catch (e: any) {
      setCreateError(e.message ?? 'Unknown error')
    } finally {
      setCreating(false)
    }
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

  const FIELD = {background:'var(--surface)',border:'1px solid var(--text-faint)',color:'var(--text-bright)',borderRadius:6,padding:'6px 10px',fontSize:12,fontFamily:'monospace',width:'100%',outline:'none'}
  const SELECT = {...FIELD}

  return (
    <div className="min-h-full p-3 sm:p-6" style={{background:'var(--ground)'}}>
      {/* Create Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{background:'rgba(0,0,0,0.8)',paddingLeft:'220px'}}>
          <div className="rounded-xl border p-6" style={{background:'var(--surface)',borderColor:'var(--text-faint)',maxHeight:'90vh',overflowY:'auto',width:'100%',maxWidth:'480px'}}>
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="w-1 h-5 rounded-full" style={{background: createType==='lxc'?'var(--accent)':'var(--violet)'}}/>
                <h2 className="font-display font-semibold uppercase tracking-wide whitespace-nowrap" style={{color: createType==='lxc'?'var(--accent)':'var(--violet)'}}>{createType === 'lxc' ? 'Create LXC Container' : 'Create Virtual Machine'}</h2>
              </div>
              <button onClick={()=>setShowCreate(false)} style={{color:'var(--text-dim)',fontSize:18}}>✕</button>
            </div>

            {nodeLoading && (
              <div className="flex items-center gap-2 px-3 py-2 rounded mb-2 text-xs font-mono" style={{background:'color-mix(in srgb, var(--accent) 3%, transparent)',border:'1px solid color-mix(in srgb, var(--accent) 13%, transparent)',color:'var(--accent)'}}>
                <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" strokeOpacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" /></svg>
                Scanning node for available resources...
              </div>
            )}
            <div className="grid gap-3" style={{opacity: nodeLoading ? 0.4 : 1, pointerEvents: nodeLoading ? 'none' : 'auto', transition:'opacity 0.2s'}}>
              {/* Node */}
              <div>
                <label className="text-xs font-mono text-gray-500 mb-1 block">Node</label>
                <select style={SELECT} value={createForm.node} onChange={e=>{ setCreateForm(f=>({...f,node:e.target.value})); loadNodeData(e.target.value) }}>
                  {nodes.map(n=><option key={n.node} value={n.node}>{n.node}</option>)}
                </select>
              </div>

              {/* VM ID */}
              <div>
                <label className="text-xs font-mono text-gray-500 mb-1 block">VM ID</label>
                <input style={FIELD} value={createForm.vmid} onChange={e=>setCreateForm(f=>({...f,vmid:e.target.value}))} placeholder="100"/>
              </div>

              {/* Hostname / Name */}
              <div>
                <label className="text-xs font-mono text-gray-500 mb-1 block">{createType==='lxc'?'Hostname':'Name'}</label>
                <input style={FIELD}
                  value={createType==='lxc'?createForm.hostname:createForm.name}
                  onChange={e=>setCreateForm(f=>createType==='lxc'?{...f,hostname:e.target.value}:{...f,name:e.target.value})}
                  placeholder={createType==='lxc'?'my-container':'my-vm'}/>
              </div>

              {/* Template (LXC) or ISO (VM) */}
              {createType === 'lxc' ? (
                <div>
                  <label className="text-xs font-mono text-gray-500 mb-1 block">Template</label>
                  <select style={SELECT} value={createForm.ostemplate} onChange={e=>setCreateForm(f=>({...f,ostemplate:e.target.value}))}>
                    <option value="">— select template —</option>
                    {templates.map(t=><option key={t.volid} value={t.volid}>{t.name}</option>)}
                  </select>
                </div>
              ) : (
                <>
                  <div>
                    <label className="text-xs font-mono text-gray-500 mb-1 block">ISO (optional)</label>
                    <select style={SELECT} value={createForm.iso} onChange={e=>setCreateForm(f=>({...f,iso:e.target.value}))}>
                      <option value="">— no ISO / boot from disk —</option>
                      {isos.map(i=><option key={i.volid} value={i.volid}>{i.name} ({i.storage})</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-mono text-gray-500 mb-1 block">Network (net0)</label>
                    <input style={FIELD} value={createForm.net0} onChange={e=>setCreateForm(f=>({...f,net0:e.target.value}))}/>
                  </div>
                </>
              )}

              {/* Resources row */}
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-xs font-mono text-gray-500 mb-1 block">Cores {nodeSpec ? <span style={{color:'var(--text-dim)'}}>/ {nodeSpec.cpus} max</span> : ''}</label>
                  <input style={FIELD} type="number" min="1" max={nodeSpec?.cpus ?? 999} value={createForm.cores} onChange={e=>setCreateForm(f=>({...f,cores:e.target.value}))}/>
                </div>
                <div>
                  <label className="text-xs font-mono text-gray-500 mb-1 block">RAM (MB) {nodeSpec ? <span style={{color:'var(--text-dim)'}}>/ {Math.round(nodeSpec.maxmem/1048576/1024)}GB ({Math.round(nodeSpec.maxmem/1048576)}MB) max</span> : ''}</label>
                  <input style={FIELD} type="number" min="64" max={nodeSpec ? Math.round(nodeSpec.maxmem/1048576) : 999999} value={createForm.memory} onChange={e=>setCreateForm(f=>({...f,memory:e.target.value}))}/>
                </div>
                <div>
                  <label className="text-xs font-mono text-gray-500 mb-1 block">{createType==='lxc'?'Swap (MB)':'Disk (GB)'}</label>
                  <input style={FIELD} type="number" min="0"
                    value={createType==='lxc'?createForm.swap:createForm.disk_size}
                    onChange={e=>setCreateForm(f=>createType==='lxc'?{...f,swap:e.target.value}:{...f,disk_size:e.target.value})}/>
                </div>
              </div>

              {/* Storage */}
              <div>
                <label className="text-xs font-mono text-gray-500 mb-1 block">{createType==='lxc'?'Root Disk Storage':'Storage'}</label>
                <select style={SELECT} value={createForm.storage} onChange={e=>setCreateForm(f=>({...f,storage:e.target.value}))}>
                  {nodeStorages.length === 0 && <option value="">Loading storage...</option>}
                  {nodeStorages.map(s => {
                    const free = s.avail ? `${(s.avail/1073741824).toFixed(1)}GB free` : 'N/A'
                    const total = s.total ? `/ ${(s.total/1073741824).toFixed(1)}GB` : ''
                    return <option key={s.storage} value={s.storage}>{s.storage} — {free} {total}</option>
                  })}
                </select>
              </div>

              {createType === 'lxc' && (
                <>
                  {/* Disk size */}
                  <div>
                    <label className="text-xs font-mono text-gray-500 mb-1 block">Root Disk Size (GB)</label>
                    <input style={FIELD} type="number" min="1" value={createForm.rootfs_size} onChange={e=>setCreateForm(f=>({...f,rootfs_size:e.target.value}))}/>
                  </div>
                  {/* Network */}
                  <div>
                    <label className="text-xs font-mono text-gray-500 mb-1 block">Network (net0)</label>
                    <input style={FIELD} value={createForm.net0} onChange={e=>setCreateForm(f=>({...f,net0:e.target.value}))}/>
                  </div>
                  {/* Password */}
                  <div>
                    <label className="text-xs font-mono text-gray-500 mb-1 block">Root Password</label>
                    <input style={FIELD} type="password" value={createForm.password} onChange={e=>setCreateForm(f=>({...f,password:e.target.value}))} placeholder="optional"/>
                  </div>
                  {/* Options */}
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 text-xs font-mono text-gray-400 cursor-pointer">
                      <input type="checkbox" checked={createForm.unprivileged} onChange={e=>setCreateForm(f=>({...f,unprivileged:e.target.checked}))}/>
                      Unprivileged
                    </label>
                    <label className="flex items-center gap-2 text-xs font-mono text-gray-400 cursor-pointer">
                      <input type="checkbox" checked={createForm.start} onChange={e=>setCreateForm(f=>({...f,start:e.target.checked}))}/>
                      Start after create
                    </label>
                  </div>
                </>
              )}

              {createType === 'qemu' && (
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 text-xs font-mono text-gray-400 cursor-pointer">
                    <input type="checkbox" checked={createForm.start} onChange={e=>setCreateForm(f=>({...f,start:e.target.checked}))}/>
                    Start after create
                  </label>
                </div>
              )}

              {/* Error / Success */}
              {createError && <div className="text-xs font-mono px-3 py-2 rounded" style={{background:'color-mix(in srgb, var(--crit) 8%, transparent)',border:'1px solid color-mix(in srgb, var(--crit) 19%, transparent)',color:'var(--crit)'}}>{createError}</div>}
              {createSuccess && <div className="text-xs font-mono px-3 py-2 rounded" style={{background:'color-mix(in srgb, var(--good) 8%, transparent)',border:'1px solid color-mix(in srgb, var(--good) 19%, transparent)',color:'var(--good)'}}>{createSuccess}</div>}
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={()=>setShowCreate(false)} className="px-4 py-2 rounded text-xs font-mono" style={{background:'var(--text-faint)',color:'var(--text-soft)'}}>Cancel</button>
              <button onClick={submitCreate} disabled={creating} className="px-4 py-2 rounded text-xs font-mono transition-all"
                style={{background: createType==='lxc'?'color-mix(in srgb, var(--accent) 13%, transparent)':'color-mix(in srgb, var(--violet) 13%, transparent)', border:`1px solid ${createType==='lxc'?'color-mix(in srgb, var(--accent) 25%, transparent)':'color-mix(in srgb, var(--violet) 25%, transparent)'}`, color: createType==='lxc'?'var(--accent)':'var(--violet)', opacity: creating?0.5:1}}>
                {creating ? 'Creating...' : `Create ${createType.toUpperCase()}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-1 h-6 rounded-full" style={{background:'var(--accent)',boxShadow:'0 0 8px var(--accent)'}}/>
          <h1 className="font-display text-2xl font-semibold tracking-wide uppercase" style={{color:'var(--accent)'}}>Infrastructure</h1>
        </div>
        <div className="flex items-center gap-3">
          {lastSync && <span className="text-xs font-mono text-gray-600">synced {lastSync.toLocaleTimeString()}</span>}
          <div className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono" style={{background:'color-mix(in srgb, var(--good) 6%, transparent)',border:'1px solid color-mix(in srgb, var(--good) 19%, transparent)'}}>
            <span style={{color:'var(--good)'}}>{running}</span>
            <span className="text-gray-600">running</span>
          </div>
          <div className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono" style={{background:'var(--text-dimmer)',border:'1px solid var(--text-faint)'}}>
            <span className="text-gray-400">{vms.length}</span>
            <span className="text-gray-600">total</span>
          </div>
          <button onClick={()=>openCreate('lxc')} className="px-3 py-1.5 rounded text-xs font-mono transition-all" style={{background:'color-mix(in srgb, var(--accent) 8%, transparent)',border:'1px solid color-mix(in srgb, var(--accent) 25%, transparent)',color:'var(--accent)'}}>+ LXC</button>
          <button onClick={()=>openCreate('qemu')} className="px-3 py-1.5 rounded text-xs font-mono transition-all" style={{background:'color-mix(in srgb, var(--violet) 8%, transparent)',border:'1px solid color-mix(in srgb, var(--violet) 25%, transparent)',color:'var(--violet)'}}>+ VM</button>
        </div>
      </div>

      {/* Node summary row */}
      <div className="grid gap-3 mb-6" style={{gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))'}}>
        {nodes.sort((a,b)=>gpuNodes.includes(a.node)?-1:gpuNodes.includes(b.node)?1:a.node.localeCompare(b.node)).map(node=>{
          const nodeVMs  = vms.filter(v=>v.node===node.node)
          const nodeRunning = nodeVMs.filter(v=>v.status==='running').length
          const isGpu    = gpuNodes.includes(node.node)
          const accent   = isGpu?'var(--violet)':'var(--accent)'
          const isActive = nodeFilter===node.node
          return (
            <button key={node.node} onClick={()=>setNodeFilter(isActive?'all':node.node)}
              className="p-3 rounded-lg border text-left transition-all"
              style={{background:isActive?`${alpha(accent, 8)}`:'var(--surface)',borderColor:isActive?`${alpha(accent, 25)}`:`${alpha(accent, 13)}`}}>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-1.5 h-1.5 rounded-full" style={{background:accent,boxShadow:`0 0 4px ${accent}`}}/>
                <span className="font-display font-semibold uppercase text-xs" style={{color:accent}}>{node.node}</span>
                {isGpu&&<span className="font-mono" style={{fontSize:8,background:'color-mix(in srgb, var(--violet) 13%, transparent)',color:'var(--violet)',border:'1px solid color-mix(in srgb, var(--violet) 25%, transparent)',padding:'0 4px',borderRadius:3}}>GPU</span>}
              </div>
              <div className="flex gap-2 text-xs font-mono items-baseline">
                <span style={{color:'var(--good)'}}>{nodeRunning} on</span>
                <span style={{color:'var(--text-dimmer)'}}>{nodeVMs.length-nodeRunning} off</span>
                {node.node in nodePower && (
                  <span className="ml-auto" style={{color: nodePower[node.node] === null ? 'var(--text-dimmer)' : 'var(--warn)', fontVariantNumeric:'tabular-nums'}}
                    title={nodePower[node.node] === null
                      ? 'Nothing on this node reports watts — no RAPL, and no exporter publishing a package figure.'
                      : 'CPU package plus any discrete GPU. Drives, fans and PSU losses are not measured.'}>
                    {nodePower[node.node] === null ? '— W' : `${Math.round(nodePower[node.node]!)} W`}
                  </span>
                )}
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
              background: filter===f?'color-mix(in srgb, var(--accent) 8%, transparent)':'transparent',
              color:      filter===f?'var(--accent)':'var(--text-dim)',
              border:     `1px solid ${filter===f?'color-mix(in srgb, var(--accent) 19%, transparent)':'var(--text-faint)'}`,
            }}>{f}</button>
          ))}
        </div>
        <input type="text" placeholder="Search name or ID..." value={search} onChange={e=>setSearch(e.target.value)}
          className="ml-auto text-xs font-mono px-3 py-1.5 rounded outline-none w-48"
          style={{background:'var(--surface)',border:'1px solid var(--text-faint)',color:'var(--text-soft)',caretColor:'var(--accent)'}}/>
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
              const typeColor = vm.type === 'lxc' ? 'var(--accent)' : 'var(--violet)'
              const statusColor = STATUS_COLOR[vm.status] ?? 'var(--text-dimmer)'
              const cpuPct    = isRunning ? Math.round(vm.cpu * 100) : 0
              const memPct    = vm.maxmem > 0 ? Math.round((vm.mem / vm.maxmem) * 100) : 0
              const barColor  = (p: number) => p > 90 ? 'var(--crit-2)' : p > 75 ? 'var(--warn-2)' : typeColor

              return (
                <div key={`${vm.node}-${vm.vmid}`}
                  className="rounded-xl border p-4 cursor-pointer flex flex-col gap-3 transition-all duration-150"
                  style={{
                    background:   'linear-gradient(135deg, var(--surface) 0%, var(--ground) 100%)',
                    borderColor:  isRunning ? `${alpha(typeColor, 19)}` : 'var(--border-dim)',
                    boxShadow:    isRunning ? `0 0 12px ${alpha(typeColor, 2)}` : 'none',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = `${alpha(typeColor, 31)}`; (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = isRunning ? `${alpha(typeColor, 19)}` : 'var(--border-dim)'; (e.currentTarget as HTMLElement).style.transform = 'translateY(0)' }}
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
                      {isGpu && <span className="font-mono px-1.5 py-0.5 rounded" style={{fontSize:8,background:'color-mix(in srgb, var(--violet) 13%, transparent)',color:'var(--violet)',border:'1px solid color-mix(in srgb, var(--violet) 25%, transparent)'}}>GPU</span>}
                      {vm.hastate && <span className="font-mono px-1.5 py-0.5 rounded" style={{fontSize:8,background:'color-mix(in srgb, var(--violet) 8%, transparent)',color:'var(--violet)',border:'1px solid color-mix(in srgb, var(--violet) 19%, transparent)'}}>HA</span>}
                      <span className="font-mono px-1.5 py-0.5 rounded" style={{fontSize:8,background:`${alpha(typeColor, 8)}`,color:typeColor,border:`1px solid ${alpha(typeColor, 19)}`}}>{vm.type.toUpperCase()}</span>
                    </div>
                  </div>

                  {/* Meta row */}
                  <div className="flex items-center gap-3 text-xs font-mono text-gray-500">
                    <span>#{vm.vmid}</span>
                    <span style={{color:'var(--text-dimmer)'}}>·</span>
                    <span style={{color: gpuNodes.includes(vm.node)?'var(--violet)':'var(--text-dim)'}}>{vm.node}</span>
                    {vm.uptime > 0 && <>
                      <span style={{color:'var(--text-dimmer)'}}>·</span>
                      <span className="text-gray-600">{formatUptime(vm.uptime)}</span>
                    </>}
                  </div>

                  {/* Resource bars — only when running */}
                  {isRunning && (
                    <div className="space-y-1.5">
                      <div>
                        <div className="flex justify-between text-xs font-mono mb-0.5">
                          <span style={{color:'var(--text-dimmer)'}}>CPU</span>
                          <span style={{color:barColor(cpuPct)}}>{cpuPct}%</span>
                        </div>
                        <div className="h-1 rounded-full overflow-hidden" style={{background:'var(--text-faint)'}}>
                          <div className="h-full rounded-full transition-all duration-500" style={{width:`${cpuPct}%`,background:barColor(cpuPct)}}/>
                        </div>
                      </div>
                      {vm.maxmem > 0 && (() => {
                        // For a VM, Proxmox reports what the guest has taken from
                        // the host — which for any Linux guest includes its page
                        // cache. That climbs to the ceiling and stays there on a
                        // perfectly healthy machine, so colouring it red says
                        // "out of memory" about something that is fine. A
                        // container reports real cgroup usage and is coloured
                        // normally.
                        const isVM = vm.type === 'qemu'
                        const memColor = isVM ? 'var(--text-muted)' : barColor(memPct)
                        return (
                          <div>
                            <div className="flex justify-between text-xs font-mono mb-0.5">
                              <span style={{color:'var(--text-dimmer)'}}>
                                MEM{isVM && <span style={{color:'var(--text-faint)'}}> allocated</span>}
                              </span>
                              <span
                                style={{color:memColor}}
                                title={isVM
                                  ? 'Memory the guest has taken from the host, which counts the guest\u2019s page cache. Linux fills spare RAM with cache and releases it on demand, so this sits near the ceiling on a healthy VM. Install the guest agent to see what is actually in use.'
                                  : undefined}
                              >
                                {formatBytes(vm.mem)} / {formatBytes(vm.maxmem)}
                              </span>
                            </div>
                            <div className="h-1 rounded-full overflow-hidden" style={{background:'var(--text-faint)'}}>
                              <div className="h-full rounded-full transition-all duration-500"
                                style={{width:`${memPct}%`,background:memColor}}/>
                            </div>
                          </div>
                        )
                      })()}
                    </div>
                  )}

                  {/* Stopped state */}
                  {!isRunning && (
                    <div className="text-xs font-mono text-gray-700">
                      {formatBytes(vm.maxdisk)} disk · {vm.cpus} cores · {formatBytes(vm.maxmem)} RAM
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-1.5 pt-1 border-t" style={{borderColor:'var(--border-dim)'}} onClick={e=>e.stopPropagation()}>
                    {isRunning ? (
                      <>
                        <ActionBtn label="⏹ Stop"    color="var(--crit-2)" onClick={()=>quickAction(vm,'stop')}     disabled={isActing}/>
                        <ActionBtn label="↺ Reboot"  color="var(--violet-2)" onClick={()=>quickAction(vm,'reboot')}   disabled={isActing}/>
                      </>
                    ) : (
                      <ActionBtn label="▶ Start" color="var(--good)" onClick={()=>quickAction(vm,'start')} disabled={isActing}/>
                    )}
                    {vm.hastate === 'stopped' && (
                      <ActionBtn label="HA ▶" color="var(--violet)" onClick={async()=>{
                        const sid=`${vm.type==='qemu'?'vm':'ct'}:${vm.vmid}`
                        await fetch(`/api/infra/ha/${encodeURIComponent(sid)}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:'started'})})
                        fetchData()
                      }} disabled={isActing}/>
                    )}
                    <button
                      className="ml-auto px-2.5 py-1 rounded text-xs font-mono transition-all"
                      style={{background:`${alpha(typeColor, 6)}`,color:`${alpha(typeColor, 50)}`,border:`1px solid ${alpha(typeColor, 13)}`}}
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
