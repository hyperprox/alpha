'use client'

// =============================================================================
//  HyperProx — install wizard: where a Proxmox Backup Server keeps its backups
//
//  Two choices. "On a NAS" is first and recommended: it is the only place that
//  survives losing the cluster. A NAS HyperProx already knows (the QNAP plug-in,
//  the cluster's NFS storage) is listed with its NFS exports to pick from;
//  otherwise the NAS's address and export are typed. NFS only: an SMB share is
//  refused, because PBS snapshot names contain ':', which SMB cannot store.
//  "A disk on this cluster" keeps the warning that it is not an off-site copy.
//  The values are the recipe's options; the server checks them again, and the
//  preview looks at the export itself (reachable, free space, existing datastore).
// =============================================================================

import { useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'
import { GhostButton, INPUT, LABEL, Notice } from '@/components/vault/ui'

interface KnownNas { host: string; label: string; source: 'qnap' | 'cluster'; exports: string[] }

const SMB = /^(smb|cifs):|^\\\\|^\/\/[^/]|\\/i

export function PbsLocation({ opts, setOpts }: { opts: Record<string, string>; setOpts: (f: (v: Record<string, string>) => Record<string, string>) => void }) {
  const set = (k: string, v: string) => setOpts(o => ({ ...o, [k]: v }))
  const [known, setKnown] = useState<KnownNas[] | null>(null)
  const [exports, setExports] = useState<{ host: string; list: string[]; note: string | null } | null>(null)
  const [reading, setReading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const nas = opts.PBS_LOCATION !== 'disk'
  const smb = SMB.test(opts.PBS_NFS_HOST ?? '') || SMB.test(opts.PBS_NFS_EXPORT ?? '')

  useEffect(() => {
    void apiJson<{ data: KnownNas[] }>('/api/catalogue/wizard/pbs/nas').then(r => setKnown(r.ok ? r.body!.data : []))
  }, [])

  const readExports = async (host: string) => {
    if (!host) return
    setReading(true); setErr(null)
    const r = await apiJson<{ data: { exports: string[]; note: string | null } }>(`/api/catalogue/wizard/pbs/nas?host=${encodeURIComponent(host)}`)
    setReading(false)
    if (!r.ok) { setErr(r.error ?? 'Could not read the exports.'); return }
    const fromCluster = known?.find(k => k.host === host)?.exports ?? []
    setExports({ host, list: [...new Set([...r.body!.data.exports, ...fromCluster])], note: r.body!.data.note })
  }

  const choice = (on: boolean, title: string, body: React.ReactNode, onPick: () => void, tag?: string) => (
    <button type="button" onClick={onPick} aria-pressed={on} className="w-full rounded-lg border p-4 text-left"
      style={{ borderColor: on ? 'var(--accent)' : 'var(--border-soft)', background: on ? 'color-mix(in srgb, var(--accent) 8%, var(--ground-inset))' : 'var(--ground-inset)',
        boxShadow: on ? '0 0 18px -10px var(--accent)' : undefined }}>
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-display text-[17px] font-semibold" style={{ color: 'var(--text-bright)' }}>{title}</span>
        {tag && <span className="rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em]" style={{ color: 'var(--good)', border: '1px solid color-mix(in srgb, var(--good) 40%, transparent)' }}>{tag}</span>}
      </span>
      <span className="mt-1 block text-sm" style={{ color: 'var(--text-muted)' }}>{body}</span>
    </button>
  )

  return (
    <div className="space-y-4 rounded-lg border p-4" style={{ borderColor: 'var(--border-soft)', background: 'var(--ground-inset)' }}>
      <p className="font-display text-[17px] font-semibold" style={{ color: 'var(--text-bright)' }}>Where the backups live</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {choice(nas, 'On a NAS', 'An NFS export on a NAS or another machine. The only choice that survives losing the cluster: a new backup server can re-attach it.', () => set('PBS_LOCATION', 'nas'), 'Recommended')}
        {choice(!nas, 'A disk on this cluster', 'A new disk on the container\'s storage. Simple, but not an off-site copy.', () => { set('PBS_LOCATION', 'disk'); set('PBS_REATTACH', '0') })}
      </div>

      {nas ? (
        <div className="space-y-3">
          {known && known.length > 0 && (
            <div>
              <span style={LABEL}>A NAS HyperProx knows</span>
              <div className="flex flex-wrap gap-2">
                {known.map(k => (
                  <GhostButton key={k.host} type="button" onClick={() => { set('PBS_NFS_HOST', k.host); void readExports(k.host) }}
                    style={opts.PBS_NFS_HOST === k.host ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}>{k.label}</GhostButton>
                ))}
              </div>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block min-w-0"><span style={LABEL}>NAS address</span>
              <input style={INPUT} value={opts.PBS_NFS_HOST ?? ''} autoCapitalize="none" placeholder="10.0.0.20" onChange={e => set('PBS_NFS_HOST', e.target.value)}
                onBlur={e => { if (e.target.value && exports?.host !== e.target.value) void readExports(e.target.value.trim()) }} /></label>
            <label className="block min-w-0"><span style={LABEL}>NFS export</span>
              {exports && exports.host === opts.PBS_NFS_HOST && exports.list.length > 0 ? (
                <select style={INPUT} value={opts.PBS_NFS_EXPORT ?? ''} onChange={e => set('PBS_NFS_EXPORT', e.target.value)}>
                  <option value="">Choose an export…</option>
                  {exports.list.map(x => <option key={x} value={x}>{x}</option>)}
                </select>
              ) : (
                <input style={INPUT} value={opts.PBS_NFS_EXPORT ?? ''} autoCapitalize="none" placeholder="/Backups" onChange={e => set('PBS_NFS_EXPORT', e.target.value)} />
              )}
            </label>
          </div>
          {reading && <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>Asking the NAS for its NFS exports…</p>}
          {exports?.note && exports.host === opts.PBS_NFS_HOST && <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>{exports.note}</p>}
          {err && <Notice kind="warn">{err}</Notice>}
          {smb && <Notice kind="error">That looks like an SMB/CIFS share. A backup server cannot use one: PBS snapshot names contain &quot;:&quot;, which SMB cannot store, so the datastore breaks. Turn on NFS for the share on the NAS and use its NFS export.</Notice>}
          <Notice kind="info">
            Use NFS, never SMB. The node mounts the export (only the container&apos;s node, with nofail so an offline NAS cannot hang its boot) and passes it into the container.
            Because that mount is on one node, the backup server container cannot be migrated to another node as it is (to move it, remove the mount, move it, and mount the export on the new node).
            PBS writes as the user &quot;backup&quot; (uid 34), which is uid 100034 on the NAS because the container is unprivileged: the export must let uid 100034 write
            (or squash all users to one that can). Setup tests a write first, and the preview checks the export is reachable, has room, and whether it already holds a datastore.
          </Notice>
          <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--text)' }}>
            <input type="checkbox" checked={opts.PBS_REATTACH === '1'} onChange={e => set('PBS_REATTACH', e.target.checked ? '1' : '0')} />
            <span>Re-attach the existing datastore<span className="block text-[12px]" style={{ color: 'var(--text-dim)' }}>Only if the export already holds a PBS datastore: it is used as it is, with its backups. HyperProx never wipes a datastore.</span></span>
          </label>
        </div>
      ) : (
        <Notice kind="warn">A backup server on the same cluster it backs up is not an off-site copy: if the cluster is lost, its backups go with it. A NAS or another machine is the safer place.</Notice>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block min-w-0"><span style={LABEL}>Datastore name</span>
          <input style={INPUT} value={opts.PBS_DATASTORE ?? ''} autoCapitalize="none" maxLength={32} onChange={e => set('PBS_DATASTORE', e.target.value)} /></label>
        <label className="block min-w-0"><span style={LABEL}>{nas ? 'Free space it must have (GB)' : 'Disk size (GB)'}</span>
          <input style={INPUT} type="number" inputMode="numeric" min={8} max={65536} value={opts.PBS_SIZE_GB ?? ''} onChange={e => set('PBS_SIZE_GB', e.target.value)} /></label>
      </div>
      <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--text)' }}>
        <input type="checkbox" checked={opts.PBS_ADD_STORAGE === '1'} onChange={e => set('PBS_ADD_STORAGE', e.target.checked ? '1' : '0')} />
        <span>Add it as backup storage on this cluster
          <span className="block text-[12px]" style={{ color: 'var(--text-dim)' }}>Off by default. On: Proxmox VE gets a &quot;pbs&quot; storage for this server (its backup token and certificate fingerprint), so backup jobs can use it. Nothing is backed up until you add it to a job.</span></span>
      </label>
    </div>
  )
}
