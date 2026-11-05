'use client'

// The structured editor. It sends only the fields that changed; the server turns them into a preview.
// Keys it does not model (raw lxc.* lines, args, hookscript, passthrough, anything new) are listed read-only.

import { useMemo, useState } from 'react'
import { apiJson } from '@/lib/api'
import { GhostButton, Notice, PrimaryButton } from '@/components/vault/ui'
import { PreviewDialog } from './PreviewDialog'
import { API, type GuestView } from './types'

const FIELD: React.CSSProperties = { background: 'var(--ground-deep)', border: '1px solid var(--border-strong)', color: 'var(--text-bright)', borderRadius: 6, padding: '0 10px', height: 38, fontSize: 14, width: '100%', outline: 'none', fontFamily: 'inherit' }
const LBL: React.CSSProperties = { display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }

const props = (s?: string) => {
  const out: Record<string, string> = {}
  ;(s ?? '').split(',').forEach((p, i) => { const eq = p.indexOf('='); if (eq < 0) out[i === 0 ? '_head' : p] = p; else out[p.slice(0, eq)] = p.slice(eq + 1) })
  return out
}

export function Section({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="font-mono uppercase" style={{ fontSize: 11, letterSpacing: '0.14em', color: 'var(--text-dimmer)' }}>{title}</h3>
        {note && <p className="text-xs mt-0.5" style={{ color: 'var(--text-dimmer)' }}>{note}</p>}
      </div>
      {children}
    </section>
  )
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <div><label style={LBL}>{label}</label>{children}{hint && <p className="text-[11px] mt-1" style={{ color: 'var(--text-dimmer)' }}>{hint}</p>}</div>
}

type Form = Record<string, any>

function initial(v: GuestView): Form {
  const c = v.config
  return {
    cores: c.cores ?? '', sockets: c.sockets ?? '', memory: c.memory ?? '', swap: c.swap ?? '', balloon: c.balloon ?? '',
    cpulimit: c.cpulimit ?? '', cpuunits: c.cpuunits ?? '', onboot: String(c.onboot ?? 0) === '1', startup: c.startup ?? '',
    description: (c.description ?? '').replace(/\n+$/, ''), tags: String(c.tags ?? '').split(/[;, ]+/).filter(Boolean).join(' '),
    nameserver: c.nameserver ?? '', searchdomain: c.searchdomain ?? '', hostname: c.hostname ?? '', name: c.name ?? '',
    boot: c.boot ?? '', agent: /^(1|enabled=1)/.test(String(c.agent ?? '0')),
  }
}

export function ConfigEditor({ view, canEdit, onSaved }: { view: GuestView; canEdit: boolean; onSaved: () => void }) {
  const isLxc = view.guest.type === 'lxc'
  const start = useMemo(() => initial(view), [view])
  const [f, setF] = useState<Form>(start)
  const [change, setChange] = useState<any>(null)
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF(x => ({ ...x, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }))

  const edit = useMemo(() => {
    const e: Record<string, any> = {}
    const num = (k: string, nullable = false) => { if (String(f[k]) !== String(start[k])) e[k] = f[k] === '' ? (nullable ? null : undefined) : Number(f[k]) }
    num('cores'); num('memory'); num('cpulimit', true); num('cpuunits', true)
    if (isLxc) num('swap'); else { num('sockets'); num('balloon') }
    if (f.onboot !== start.onboot) e.onboot = f.onboot
    if (f.startup !== start.startup) e.startup = f.startup || null
    if (f.description !== start.description) e.description = f.description
    if (f.tags !== start.tags) e.tags = f.tags.split(/[\s,;]+/).filter(Boolean)
    if (f.nameserver !== start.nameserver) e.nameserver = f.nameserver || null
    if (f.searchdomain !== start.searchdomain) e.searchdomain = f.searchdomain || null
    if (isLxc && f.hostname !== start.hostname) e.hostname = f.hostname
    if (!isLxc && f.name !== start.name) e.name = f.name
    if (!isLxc && f.boot !== start.boot) e.boot = f.boot
    if (!isLxc && f.agent !== start.agent) e.agent = f.agent
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k]
    return e
  }, [f, start, isLxc])
  const dirty = Object.keys(edit).length > 0
  const dis = !canEdit

  return (
    <div className="space-y-6">
      {view.pending.keys.length > 0 && (
        <Notice kind="warn">Applies on next restart: <span className="font-mono">{view.pending.keys.join(', ')}</span></Notice>
      )}
      {!canEdit && <Notice kind="info">Read-only: editing needs the admin role.</Notice>}

      <Section title="Resources">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Field label="Cores"><input style={FIELD} type="number" min={1} value={f.cores} onChange={set('cores')} disabled={dis} /></Field>
          {!isLxc && <Field label="Sockets"><input style={FIELD} type="number" min={1} value={f.sockets} onChange={set('sockets')} disabled={dis} /></Field>}
          <Field label="Memory (MiB)"><input style={FIELD} type="number" min={16} value={f.memory} onChange={set('memory')} disabled={dis} /></Field>
          {isLxc
            ? <Field label="Swap (MiB)"><input style={FIELD} type="number" min={0} value={f.swap} onChange={set('swap')} disabled={dis} /></Field>
            : <Field label="Balloon minimum (MiB)" hint="0 turns ballooning off"><input style={FIELD} type="number" min={0} value={f.balloon} onChange={set('balloon')} disabled={dis} /></Field>}
          <Field label="CPU limit (cores)" hint="empty: no limit"><input style={FIELD} type="number" min={0} step="0.1" value={f.cpulimit} onChange={set('cpulimit')} disabled={dis} /></Field>
          <Field label="CPU weight"><input style={FIELD} type="number" min={1} value={f.cpuunits} onChange={set('cpuunits')} disabled={dis} /></Field>
        </div>
      </Section>

      <Section title="Boot">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text)' }}><input type="checkbox" checked={f.onboot} onChange={set('onboot')} disabled={dis} /> Start when the node boots</label>
          <Field label="Startup order" hint="e.g. order=3,up=30"><input style={FIELD} value={f.startup} onChange={set('startup')} disabled={dis} /></Field>
          {!isLxc && <Field label="Boot order" hint="e.g. order=scsi0;net0"><input style={FIELD} value={f.boot} onChange={set('boot')} disabled={dis} /></Field>}
          {!isLxc && <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text)' }}><input type="checkbox" checked={f.agent} onChange={set('agent')} disabled={dis} /> QEMU guest agent</label>}
        </div>
      </Section>

      <Section title="Identity">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {isLxc ? <Field label="Hostname"><input style={FIELD} value={f.hostname} onChange={set('hostname')} disabled={dis} /></Field>
                 : <Field label="Name"><input style={FIELD} value={f.name} onChange={set('name')} disabled={dis} /></Field>}
          <Field label="Tags" hint="space separated"><input style={FIELD} value={f.tags} onChange={set('tags')} disabled={dis} /></Field>
          <Field label="DNS servers" hint="empty: the node's"><input style={FIELD} value={f.nameserver} onChange={set('nameserver')} disabled={dis} /></Field>
          <Field label="Search domain"><input style={FIELD} value={f.searchdomain} onChange={set('searchdomain')} disabled={dis} /></Field>
        </div>
        <Field label="Description"><textarea style={{ ...FIELD, height: 90, padding: 10 }} value={f.description} onChange={set('description')} disabled={dis} /></Field>
      </Section>

      <MountsEditor view={view} canEdit={canEdit} onSaved={onSaved} />

      <Section title={`Kept as they are · ${view.keys.rawCount} raw, ${view.keys.unknownCount} other`} note="Never written by this form. Counted before and after every save; a save that would lose one is refused.">
        {view.keys.raw.length + view.keys.unknown.length === 0 ? <p className="text-sm" style={{ color: 'var(--text-dimmer)' }}>None.</p> : (
          <ul className="font-mono rounded-md border p-2 space-y-0.5 overflow-x-auto" style={{ fontSize: 12, borderColor: 'var(--border-dim)', background: 'var(--ground-deep)' }}>
            {view.keys.raw.map((r, i) => <li key={`r${i}`} style={{ color: 'var(--warn-2)' }}>{r.key}: {r.value}</li>)}
            {view.keys.unknown.map((r, i) => <li key={`u${i}`} style={{ color: 'var(--text-muted)' }}>{r.key}: {r.value}</li>)}
          </ul>
        )}
      </Section>

      {canEdit && (
        <div className="sticky bottom-0 flex gap-2 justify-end py-3" style={{ background: 'var(--surface-raised)' }}>
          <GhostButton onClick={() => setF(start)} disabled={!dirty}>Reset</GhostButton>
          <PrimaryButton onClick={() => setChange({ kind: 'edit', edit })} disabled={!dirty}>Review changes</PrimaryButton>
        </div>
      )}
      {change && <PreviewDialog guest={view.guest} change={change} title="Save config changes" onClose={() => setChange(null)} onApplied={onSaved} />}
    </div>
  )
}

// ── network interfaces ───────────────────────────────────────────────────────

export function NetworkEditor({ view, canEdit, onSaved }: { view: GuestView; canEdit: boolean; onSaved: () => void }) {
  const isLxc = view.guest.type === 'lxc'
  const nics = Object.keys(view.config).filter(k => /^net\d+$/.test(k)).sort()
  const [editing, setEditing] = useState<string | null>(null)
  const [nf, setNf] = useState<Record<string, any>>({})
  const [change, setChange] = useState<any>(null)
  const open = (k: string | null) => {
    const p = props(k ? view.config[k] : '')
    const ipc = props(view.config[`ipconfig${k?.slice(3) ?? 0}`])
    setNf({ key: k ?? `net${[...Array(10).keys()].find(i => !nics.includes(`net${i}`))}`, bridge: p.bridge ?? 'vmbr0', ip: isLxc ? (p.ip ?? 'dhcp') : (ipc.ip ?? ''), gw: isLxc ? (p.gw ?? '') : (ipc.gw ?? ''), tag: p.tag ?? '', firewall: p.firewall === '1', rate: p.rate ?? '', isNew: !k })
    setEditing(k ?? 'new')
  }
  const submit = () => {
    const ne: any = { bridge: nf.bridge, tag: nf.tag === '' ? null : Number(nf.tag), firewall: nf.firewall, rate: nf.rate === '' ? null : Number(nf.rate) }
    const e: any = {}
    if (isLxc) { ne.ip = nf.ip; ne.gw = nf.ip === 'dhcp' ? null : (nf.gw || null) }
    else if (nf.ip) e.ipconfig = { [`ipconfig${nf.key.slice(3)}`]: { ip: nf.ip, gw: nf.gw || null } }
    e.net = { [nf.key]: ne }
    setChange({ kind: 'edit', edit: e })
  }
  return (
    <div className="space-y-3">
      {nics.map(k => {
        const p = props(view.config[k])
        const ipc = props(view.config[`ipconfig${k.slice(3)}`])
        return (
          <div key={k} className="rounded-md border p-3 flex flex-wrap items-center gap-x-4 gap-y-1" style={{ borderColor: 'var(--border-dim)', background: 'var(--ground-deep)' }}>
            <span className="font-mono" style={{ color: 'var(--accent)' }}>{k}</span>
            <span className="text-sm" style={{ color: 'var(--text)' }}>{p.bridge}{p.tag ? ` · VLAN ${p.tag}` : ''}</span>
            <span className="font-mono text-sm" style={{ color: 'var(--text-bright)' }}>{isLxc ? (p.ip ?? '—') : (ipc.ip ?? 'from the guest')}</span>
            {(isLxc ? p.gw : ipc.gw) && <span className="text-xs" style={{ color: 'var(--text-dimmer)' }}>gw {isLxc ? p.gw : ipc.gw}</span>}
            {p.firewall === '1' && <span className="text-xs" style={{ color: 'var(--warn-2)' }}>firewall</span>}
            {p.rate && <span className="text-xs" style={{ color: 'var(--text-dimmer)' }}>{p.rate} MB/s</span>}
            {canEdit && <div className="ml-auto flex gap-2"><GhostButton style={{ height: 32 }} onClick={() => open(k)}>Edit</GhostButton><GhostButton style={{ height: 32 }} onClick={() => setChange({ kind: 'edit', edit: { net: { [k]: null } } })}>Remove</GhostButton></div>}
          </div>
        )
      })}
      {canEdit && <GhostButton onClick={() => open(null)}>+ Add interface</GhostButton>}
      {editing && (
        <div className="rounded-md border p-3 grid grid-cols-2 sm:grid-cols-3 gap-3" style={{ borderColor: 'var(--border-soft)' }}>
          <Field label="Bridge"><input style={FIELD} value={nf.bridge} onChange={e => setNf(x => ({ ...x, bridge: e.target.value }))} /></Field>
          <Field label={isLxc ? 'Address (CIDR or dhcp)' : 'Cloud-init address'}><input style={FIELD} value={nf.ip} placeholder="dhcp" onChange={e => setNf(x => ({ ...x, ip: e.target.value }))} /></Field>
          <Field label="Gateway"><input style={FIELD} value={nf.gw} onChange={e => setNf(x => ({ ...x, gw: e.target.value }))} disabled={nf.ip === 'dhcp'} /></Field>
          <Field label="VLAN tag"><input style={FIELD} type="number" value={nf.tag} onChange={e => setNf(x => ({ ...x, tag: e.target.value }))} /></Field>
          <Field label="Rate limit (MB/s)"><input style={FIELD} type="number" value={nf.rate} onChange={e => setNf(x => ({ ...x, rate: e.target.value }))} /></Field>
          <label className="flex items-center gap-2 text-sm self-end" style={{ color: 'var(--text)' }}><input type="checkbox" checked={nf.firewall} onChange={e => setNf(x => ({ ...x, firewall: e.target.checked }))} /> Firewall</label>
          <div className="col-span-full flex gap-2 justify-end"><GhostButton onClick={() => setEditing(null)}>Cancel</GhostButton><PrimaryButton onClick={submit}>Review {nf.key}</PrimaryButton></div>
        </div>
      )}
      {change && <PreviewDialog guest={view.guest} change={change} title="Network change" onClose={() => { setChange(null); setEditing(null) }} onApplied={onSaved} />}
    </div>
  )
}

// ── mount points and disks ───────────────────────────────────────────────────

function MountsEditor({ view, canEdit, onSaved }: { view: GuestView; canEdit: boolean; onSaved: () => void }) {
  const isLxc = view.guest.type === 'lxc'
  const disks = Object.keys(view.config).filter(k => (isLxc ? /^(rootfs|mp\d+)$/ : /^(scsi|virtio|sata|ide)\d+$/).test(k) && !/media=cdrom/.test(String(view.config[k]))).sort()
  const [change, setChange] = useState<any>(null)
  const [add, setAdd] = useState<null | { kind: 'volume' | 'bind'; storage: string; sizeGb: string; source: string; mp: string; ro: boolean; shared: boolean }>(null)
  const [check, setCheck] = useState<null | { path: string; ok: boolean; missing: string[]; unverified: string[]; detail: string[] }>(null)
  const [checking, setChecking] = useState(false)
  const [resize, setResize] = useState<Record<string, string>>({})
  const runCheck = async (path: string) => {
    setChecking(true)
    const r = await apiJson<{ data: any }>(`${API}/paths/check`, 'POST', { path })
    setChecking(false)
    setCheck(r.ok ? r.body!.data : { path, ok: false, missing: [], unverified: [r.error ?? 'could not check'], detail: [] })
  }
  return (
    <Section title={isLxc ? 'Disks and mount points' : 'Disks'} note={isLxc ? 'Sizes only grow. A removed volume is kept as an unused disk.' : 'Sizes only grow.'}>
      <div className="space-y-2">
        {disks.map(k => {
          const p = props(view.config[k])
          const bind = (p._head ?? '').startsWith('/')
          return (
            <div key={k} className="rounded-md border p-3 flex flex-wrap items-center gap-x-3 gap-y-2" style={{ borderColor: 'var(--border-dim)', background: 'var(--ground-deep)' }}>
              <span className="font-mono" style={{ color: 'var(--accent)' }}>{k}</span>
              <span className="font-mono text-xs break-all" style={{ color: 'var(--text-muted)' }}>{p._head}</span>
              {p.mp && <span className="text-sm" style={{ color: 'var(--text)' }}>→ {p.mp}</span>}
              {p.size && <span className="text-xs" style={{ color: 'var(--text-dimmer)' }}>{p.size}</span>}
              {bind && <span className="text-xs" style={{ color: p.shared === '1' ? 'var(--good)' : 'var(--warn-2)' }}>{p.shared === '1' ? 'shared=1' : 'bind mount: blocks migration'}</span>}
              {canEdit && (
                <div className="ml-auto flex gap-2 items-center">
                  {!bind && <><input style={{ ...FIELD, width: 80, height: 32 }} type="number" placeholder="GB" value={resize[k] ?? ''} onChange={e => setResize(x => ({ ...x, [k]: e.target.value }))} />
                    <GhostButton style={{ height: 32 }} disabled={!resize[k]} onClick={() => setChange({ kind: 'edit', edit: { mounts: { resize: [{ key: k, sizeGb: Number(resize[k]) }] } } })}>Grow</GhostButton></>}
                  {bind && <GhostButton style={{ height: 32 }} onClick={() => setChange({ kind: 'edit', edit: { mounts: { shared: [{ key: k, shared: p.shared !== '1' }] } } })}>{p.shared === '1' ? 'Unmark shared' : 'Mark shared'}</GhostButton>}
                  {/^mp\d+$/.test(k) && <GhostButton style={{ height: 32 }} onClick={() => setChange({ kind: 'edit', edit: { mounts: { remove: [k] } } })}>Remove</GhostButton>}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {isLxc && canEdit && !add && <GhostButton onClick={() => setAdd({ kind: 'volume', storage: '', sizeGb: '8', source: '', mp: '', ro: false, shared: false })}>+ Add mount point</GhostButton>}
      {add && (
        <div className="rounded-md border p-3 space-y-3" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="flex gap-2">
            {(['volume', 'bind'] as const).map(k => <GhostButton key={k} style={{ height: 32, borderColor: add.kind === k ? 'var(--accent)' : undefined, color: add.kind === k ? 'var(--accent)' : undefined }} onClick={() => { setAdd({ ...add, kind: k }); setCheck(null) }}>{k === 'volume' ? 'New volume' : 'Bind a host path'}</GhostButton>)}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {add.kind === 'volume' ? <>
              <Field label="Storage ID"><input style={FIELD} value={add.storage} onChange={e => setAdd({ ...add, storage: e.target.value })} /></Field>
              <Field label="Size (GB)"><input style={FIELD} type="number" value={add.sizeGb} onChange={e => setAdd({ ...add, sizeGb: e.target.value })} /></Field>
            </> : <Field label="Host path"><input style={FIELD} value={add.source} onChange={e => { setAdd({ ...add, source: e.target.value, shared: false }); setCheck(null) }} /></Field>}
            <Field label="Path in the container"><input style={FIELD} value={add.mp} onChange={e => setAdd({ ...add, mp: e.target.value })} /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text)' }}><input type="checkbox" checked={add.ro} onChange={e => setAdd({ ...add, ro: e.target.checked })} /> Read-only</label>
          {add.kind === 'bind' && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <GhostButton style={{ height: 32 }} disabled={!add.source || checking} onClick={() => void runCheck(add.source)}>{checking ? 'Checking every node…' : 'Check this path on every node'}</GhostButton>
                <label className="flex items-center gap-2 text-sm" style={{ color: check?.ok ? 'var(--text)' : 'var(--text-dimmer)' }}>
                  <input type="checkbox" disabled={!check?.ok || check.path !== add.source} checked={add.shared} onChange={e => setAdd({ ...add, shared: e.target.checked })} /> shared=1 (same data on every node)
                </label>
              </div>
              {check && (check.ok ? <Notice kind="info">Present on every node: {check.detail.join(', ')}</Notice>
                : <Notice kind="error">Cannot mark shared. {check.missing.length ? `Missing on: ${check.missing.join(', ')}. ` : ''}{check.unverified.length ? `Not verified: ${check.unverified.join(', ')}.` : ''}</Notice>)}
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <GhostButton onClick={() => { setAdd(null); setCheck(null) }}>Cancel</GhostButton>
            <PrimaryButton onClick={() => setChange({ kind: 'edit', edit: { mounts: { add: [add.kind === 'volume' ? { kind: 'volume', storage: add.storage, sizeGb: Number(add.sizeGb), mp: add.mp, ro: add.ro } : { kind: 'bind', source: add.source, mp: add.mp, ro: add.ro, shared: add.shared }] } } })}>Review mount point</PrimaryButton>
          </div>
        </div>
      )}
      {change && <PreviewDialog guest={view.guest} change={change} title="Disk change" onClose={() => { setChange(null); setAdd(null) }} onApplied={onSaved} />}
    </Section>
  )
}
