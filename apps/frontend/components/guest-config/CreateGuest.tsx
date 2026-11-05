'use client'

// Creating a container or VM. Moved as it was from the old Infrastructure page; the page opens it with a type.

import { useEffect, useState } from 'react'

interface PVENode { node: string; status: string }

export function CreateGuestModal({ type, nodes, onClose }: { type: 'lxc' | 'qemu'; nodes: PVENode[]; onClose: () => void }) {
  const [showCreate, setShow] = useState(true)
  const setShowCreate = (v: boolean) => { setShow(v); if (!v) onClose() }
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

  useEffect(() => { void openCreate(type) }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  void nextId
  const FIELD = {background:'var(--ground-deep)',border:'1px solid var(--border-strong)',color:'var(--text-bright)',borderRadius:6,padding:'0 12px',height:40,fontSize:14,fontFamily:'inherit',width:'100%',outline:'none'}
  const SELECT = {...FIELD}
  return (
    <>
      {/* Create Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{background:'var(--scrim)',padding:'16px'}}>
          <div className="rounded-xl border p-6" style={{background:'var(--surface)',borderColor:'var(--border-soft)',maxHeight:'90vh',overflowY:'auto',width:'100%',maxWidth:'480px'}}>
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="w-1 h-5 rounded-full" style={{background: createType==='lxc'?'var(--accent)':'var(--violet)'}}/>
                <h2 className="font-display font-semibold text-xl whitespace-nowrap" style={{color: createType==='lxc'?'var(--accent)':'var(--violet)'}}>{createType === 'lxc' ? 'Create LXC Container' : 'Create Virtual Machine'}</h2>
              </div>
              <button onClick={()=>setShowCreate(false)} style={{color:'var(--text-dim)',fontSize:18}}>✕</button>
            </div>

            {nodeLoading && (
              <div className="flex items-center gap-2 px-3 py-2 rounded mb-2 text-sm" style={{background:'color-mix(in srgb, var(--accent) 3%, transparent)',border:'1px solid color-mix(in srgb, var(--accent) 13%, transparent)',color:'var(--accent)'}}>
                <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" strokeOpacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" /></svg>
                Scanning node for available resources...
              </div>
            )}
            <div className="grid gap-3" style={{opacity: nodeLoading ? 0.4 : 1, pointerEvents: nodeLoading ? 'none' : 'auto', transition:'opacity 0.2s'}}>
              {/* Node */}
              <div>
                <label className="text-sm mb-1 block" style={{color:'var(--text-muted)'}}>Node</label>
                <select style={SELECT} value={createForm.node} onChange={e=>{ setCreateForm(f=>({...f,node:e.target.value})); loadNodeData(e.target.value) }}>
                  {nodes.map(n=><option key={n.node} value={n.node}>{n.node}</option>)}
                </select>
              </div>

              {/* VM ID */}
              <div>
                <label className="text-sm mb-1 block" style={{color:'var(--text-muted)'}}>VM ID</label>
                <input style={FIELD} value={createForm.vmid} onChange={e=>setCreateForm(f=>({...f,vmid:e.target.value}))} placeholder="100"/>
              </div>

              {/* Hostname / Name */}
              <div>
                <label className="text-sm mb-1 block" style={{color:'var(--text-muted)'}}>{createType==='lxc'?'Hostname':'Name'}</label>
                <input style={FIELD}
                  value={createType==='lxc'?createForm.hostname:createForm.name}
                  onChange={e=>setCreateForm(f=>createType==='lxc'?{...f,hostname:e.target.value}:{...f,name:e.target.value})}
                  placeholder={createType==='lxc'?'my-container':'my-vm'}/>
              </div>

              {/* Template (LXC) or ISO (VM) */}
              {createType === 'lxc' ? (
                <div>
                  <label className="text-sm mb-1 block" style={{color:'var(--text-muted)'}}>Template</label>
                  <select style={SELECT} value={createForm.ostemplate} onChange={e=>setCreateForm(f=>({...f,ostemplate:e.target.value}))}>
                    <option value="">— select template —</option>
                    {templates.map(t=><option key={t.volid} value={t.volid}>{t.name}</option>)}
                  </select>
                </div>
              ) : (
                <>
                  <div>
                    <label className="text-sm mb-1 block" style={{color:'var(--text-muted)'}}>ISO (optional)</label>
                    <select style={SELECT} value={createForm.iso} onChange={e=>setCreateForm(f=>({...f,iso:e.target.value}))}>
                      <option value="">— no ISO / boot from disk —</option>
                      {isos.map(i=><option key={i.volid} value={i.volid}>{i.name} ({i.storage})</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-sm mb-1 block" style={{color:'var(--text-muted)'}}>Network (net0)</label>
                    <input style={FIELD} value={createForm.net0} onChange={e=>setCreateForm(f=>({...f,net0:e.target.value}))}/>
                  </div>
                </>
              )}

              {/* Resources row */}
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-sm mb-1 block" style={{color:'var(--text-muted)'}}>Cores {nodeSpec ? <span style={{color:'var(--text-dim)'}}>/ {nodeSpec.cpus} max</span> : ''}</label>
                  <input style={FIELD} type="number" min="1" max={nodeSpec?.cpus ?? 999} value={createForm.cores} onChange={e=>setCreateForm(f=>({...f,cores:e.target.value}))}/>
                </div>
                <div>
                  <label className="text-sm mb-1 block" style={{color:'var(--text-muted)'}}>RAM (MB) {nodeSpec ? <span style={{color:'var(--text-dim)'}}>/ {Math.round(nodeSpec.maxmem/1048576/1024)}GB ({Math.round(nodeSpec.maxmem/1048576)}MB) max</span> : ''}</label>
                  <input style={FIELD} type="number" min="64" max={nodeSpec ? Math.round(nodeSpec.maxmem/1048576) : 999999} value={createForm.memory} onChange={e=>setCreateForm(f=>({...f,memory:e.target.value}))}/>
                </div>
                <div>
                  <label className="text-sm mb-1 block" style={{color:'var(--text-muted)'}}>{createType==='lxc'?'Swap (MB)':'Disk (GB)'}</label>
                  <input style={FIELD} type="number" min="0"
                    value={createType==='lxc'?createForm.swap:createForm.disk_size}
                    onChange={e=>setCreateForm(f=>createType==='lxc'?{...f,swap:e.target.value}:{...f,disk_size:e.target.value})}/>
                </div>
              </div>

              {/* Storage */}
              <div>
                <label className="text-sm mb-1 block" style={{color:'var(--text-muted)'}}>{createType==='lxc'?'Root Disk Storage':'Storage'}</label>
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
                    <label className="text-sm mb-1 block" style={{color:'var(--text-muted)'}}>Root Disk Size (GB)</label>
                    <input style={FIELD} type="number" min="1" value={createForm.rootfs_size} onChange={e=>setCreateForm(f=>({...f,rootfs_size:e.target.value}))}/>
                  </div>
                  {/* Network */}
                  <div>
                    <label className="text-sm mb-1 block" style={{color:'var(--text-muted)'}}>Network (net0)</label>
                    <input style={FIELD} value={createForm.net0} onChange={e=>setCreateForm(f=>({...f,net0:e.target.value}))}/>
                  </div>
                  {/* Password */}
                  <div>
                    <label className="text-sm mb-1 block" style={{color:'var(--text-muted)'}}>Root Password</label>
                    <input style={FIELD} type="password" value={createForm.password} onChange={e=>setCreateForm(f=>({...f,password:e.target.value}))} placeholder="optional"/>
                  </div>
                  {/* Options */}
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 text-sm cursor-pointer" style={{color:'var(--text-muted)'}}>
                      <input type="checkbox" checked={createForm.unprivileged} onChange={e=>setCreateForm(f=>({...f,unprivileged:e.target.checked}))}/>
                      Unprivileged
                    </label>
                    <label className="flex items-center gap-2 text-sm cursor-pointer" style={{color:'var(--text-muted)'}}>
                      <input type="checkbox" checked={createForm.start} onChange={e=>setCreateForm(f=>({...f,start:e.target.checked}))}/>
                      Start after create
                    </label>
                  </div>
                </>
              )}

              {createType === 'qemu' && (
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 text-sm cursor-pointer" style={{color:'var(--text-muted)'}}>
                    <input type="checkbox" checked={createForm.start} onChange={e=>setCreateForm(f=>({...f,start:e.target.checked}))}/>
                    Start after create
                  </label>
                </div>
              )}

              {/* Error / Success */}
              {createError && <div className="text-sm px-3 py-2 rounded" style={{background:'color-mix(in srgb, var(--crit) 8%, transparent)',border:'1px solid color-mix(in srgb, var(--crit) 19%, transparent)',color:'var(--crit)'}}>{createError}</div>}
              {createSuccess && <div className="text-sm px-3 py-2 rounded" style={{background:'color-mix(in srgb, var(--good) 8%, transparent)',border:'1px solid color-mix(in srgb, var(--good) 19%, transparent)',color:'var(--good)'}}>{createSuccess}</div>}
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={()=>setShowCreate(false)} className="px-4 rounded-md text-sm font-medium" style={{height:40,background:'transparent',border:'1px solid var(--border-strong)',color:'var(--text)'}}>Cancel</button>
              <button onClick={submitCreate} disabled={creating} className="px-5 rounded-md text-sm font-semibold transition-all"
                style={{height:40,background: createType==='lxc'?'var(--accent)':'var(--violet)', border:'none', color:'var(--accent-ink)', opacity: creating?0.5:1}}>
                {creating ? 'Creating...' : `Create ${createType.toUpperCase()}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
