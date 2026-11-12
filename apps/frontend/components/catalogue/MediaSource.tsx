'use client'

// =============================================================================
//  HyperProx — where the library is, for the transcoders (Unmanic, Tdarr)
//
//  The same three choices as the Arr Stack's picker, in the same words: a new
//  disk, a NAS over NFS, or a folder on the node. The library inside the
//  container is /data/media, the folder the Arr Stack fills, so the two work on
//  the same files at the same paths. Unlike the Arr Stack these apps replace
//  files in place, so the folder must be writable by the container's user; the
//  preview tests that, and the hint says it first.
// =============================================================================

import { INPUT, LABEL } from '@/components/vault/ui'

export function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block min-w-0">
      <span style={LABEL}>{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px]" style={{ color: 'var(--text-dim)' }}>{hint}</span>}
    </label>
  )
}

/** A row of choices as one control. Two columns on a phone when there are more than three. */
export function Segmented<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: Array<[T, string]>; label: string }) {
  const cols = items.length > 3 ? 'grid-cols-2 sm:grid-cols-4' : items.length === 3 ? 'grid-cols-1 min-[420px]:grid-cols-3' : 'grid-cols-2'
  return (
    <div role="radiogroup" aria-label={label} className={`grid ${cols} rounded-md border overflow-hidden`} style={{ borderColor: 'var(--border-strong)' }}>
      {items.map(([v, l]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}
          className="min-h-[42px] px-2 py-1 text-[13px] leading-tight"
          style={{ background: value === v ? 'var(--accent)' : 'transparent', color: value === v ? 'var(--accent-ink)' : 'var(--text-soft)' }}>
          {l}
        </button>
      ))}
    </div>
  )
}

export interface MediaFacts { nas: Array<{ storage: string; server: string; export: string }> }

/** What the library step still needs, as words for "Fill in …". */
export function mediaMissing(opts: Record<string, string>): string[] {
  const m: string[] = []
  if (opts.TC_MEDIA === 'nfs' && (!opts.TC_NFS_HOST?.trim() || !opts.TC_NFS_EXPORT?.trim())) m.push('the NAS and its NFS export')
  if (opts.TC_MEDIA === 'path' && !opts.TC_HOST_PATH?.trim()) m.push('the folder on the node')
  if ((opts.TC_MEDIA || 'disk') === 'disk' && !(Number(opts.TC_MEDIA_GB) >= 10)) m.push('the library disk size (at least 10 GB)')
  return m
}

export function MediaSource({ opts, set, facts, layoutLine }: {
  opts: Record<string, string>; set: (k: string, v: string) => void; facts: MediaFacts | null; layoutLine: string
}) {
  const media = (opts.TC_MEDIA || 'disk') as 'disk' | 'nfs' | 'path'
  return (
    <div className="rounded-lg border p-4 space-y-3 min-w-0" style={{ borderColor: 'var(--border-soft)', background: 'var(--ground-inset)' }}>
      <p className="font-display text-[17px] font-semibold" style={{ color: 'var(--text-bright)' }}>Where the library is</p>
      <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>{layoutLine}</p>
      <Segmented label="Library location" value={media} onChange={v => set('TC_MEDIA', v)}
        items={[['disk', 'A new disk'], ['nfs', 'A NAS (NFS)'], ['path', 'A folder on the node']]} />
      {media === 'disk' && (
        <Field label="Library disk (GB)" hint="Made on the storage you pick in step 3, mounted at /data. Left out of Proxmox backups: media is too big to back up nightly. Choose this only for a fresh library: the existing one is on a NAS or a folder.">
          <input type="number" min={10} value={opts.TC_MEDIA_GB ?? ''} onChange={e => set('TC_MEDIA_GB', e.target.value)} style={INPUT} inputMode="numeric" />
        </Field>
      )}
      {media === 'nfs' && (
        <div className="space-y-3">
          {facts && facts.nas.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {facts.nas.map(n => (
                <button key={n.storage} type="button" onClick={() => { set('TC_NFS_HOST', n.server); set('TC_NFS_EXPORT', n.export) }}
                  className="rounded-md border px-2.5 py-1.5 text-[12px] text-left break-all" style={{ borderColor: 'var(--border-strong)', color: 'var(--text-soft)' }}>
                  {n.server}:{n.export} <span style={{ color: 'var(--text-dim)' }}>({n.storage})</span>
                </button>
              ))}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="NAS" hint="Its IP address or name.">
              <input value={opts.TC_NFS_HOST ?? ''} onChange={e => set('TC_NFS_HOST', e.target.value.trim())} placeholder="10.0.0.20" style={INPUT} autoCapitalize="none" spellCheck={false} />
            </Field>
            <Field label="NFS export" hint="Like /Media (QNAP) or /volume1/media (Synology). The library is its media folder.">
              <input value={opts.TC_NFS_EXPORT ?? ''} onChange={e => set('TC_NFS_EXPORT', e.target.value.trim())} placeholder="/Media" style={INPUT} autoCapitalize="none" spellCheck={false} />
            </Field>
          </div>
          <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
            Mounted on the container&rsquo;s node only (rw, NFS v3, hard, nofail), then passed in. These apps replace files in place, and write as uid 101000 on the NAS: let that user write to the export. The install tests a write and stops with a plain message if it fails.
          </p>
        </div>
      )}
      {media === 'path' && (
        <Field label="Folder on the node" hint="A folder that already exists on the node you pick, such as /mnt/media. Its media folder is the library. The preview writes one empty file there as uid 101000 (the container's user) and removes it, to be sure files can be replaced.">
          <input value={opts.TC_HOST_PATH ?? ''} onChange={e => set('TC_HOST_PATH', e.target.value.trim())} placeholder="/mnt/media" style={INPUT} autoCapitalize="none" spellCheck={false} />
        </Field>
      )}
    </div>
  )
}
