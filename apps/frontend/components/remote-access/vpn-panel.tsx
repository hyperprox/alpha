'use client'

import { useEffect, useState } from 'react'
import type { RemoteCell, RemoteMachineRow, RemoteOverview, RemoteProviderId, VpnInstallPreview, VpnPrefs, VpnSettingsPreview } from '@hyperprox/types'
import { apiJson, type ApiResult } from '@/lib/api'
import { Badge, Btn, ConfirmDialog, Notice, Panel, fmtTime } from '@/components/updates/ui'
import { PROVIDER_LABEL } from './parts'

// The VPN page's per-machine pieces: one-click install, the machine panel (settings read back from the
// client, key expiry, tags, the sign-in link) and devices waiting for approval.

type Send = <T>(path: string, method: string, body?: unknown) => Promise<ApiResult<T> | null>
const enc = encodeURIComponent

export function OneClickDialog({ row, provider, send, onCancel, onStarted }: {
  row: RemoteMachineRow; provider: RemoteProviderId; send: Send; onCancel: () => void; onStarted: (r: ApiResult<any> | null) => void
}) {
  const [pv, setPv] = useState<VpnInstallPreview | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    apiJson<VpnInstallPreview>(`/api/remote/v1/machines/${enc(row.id)}/${provider}/install-preview`)
      .then(r => (r.ok && r.body ? setPv(r.body) : setErr(r.error ?? 'Could not prepare the install')))
  }, [row.id, provider])
  return (
    <ConfirmDialog title={`Install ${PROVIDER_LABEL[provider]} on ${row.name}`} onClose={onCancel}>
      {err && <Notice tone="crit">{err}</Notice>}
      {!pv && !err && <p className="text-sm" style={{ color: 'var(--text-dim)' }}>Preparing…</p>}
      {pv && (
        <ul className="list-disc space-y-1 pl-5 text-sm" style={{ color: 'var(--text-soft)' }}>
          {pv.steps.map(s => <li key={s}>{s}</li>)}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        <Btn kind="primary" disabled={!pv} onClick={async () => onStarted(await send(`/api/remote/v1/machines/${enc(row.id)}/${provider}/install`, 'POST', { confirm: true }))}>Install</Btn>
        <Btn onClick={onCancel}>Cancel</Btn>
      </div>
    </ConfirmDialog>
  )
}

function Toggle({ label, checked, disabled, onChange, hint }: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex items-start gap-2 text-sm" style={{ color: disabled ? 'var(--text-dim)' : 'var(--text-soft)' }} title={hint}>
      <input type="checkbox" className="mt-1" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

const FIELD: React.CSSProperties = { background: 'var(--ground-deep)', border: '1px solid var(--border-strong)', color: 'var(--text-bright)', borderRadius: 6, padding: '6px 10px', fontSize: 14, width: '100%' }

export function MachinePanel({ row, provider, cell, send, onClose, onJob, onNotice }: {
  row: RemoteMachineRow; provider: RemoteProviderId; cell: RemoteCell; send: Send
  onClose: () => void; onJob: (r: ApiResult<any> | null) => void; onNotice: (tone: 'info' | 'warn' | 'crit', text: string) => void
}) {
  const node = row.kind === 'node'
  const label = PROVIDER_LABEL[provider]
  const [current, setCurrent] = useState<VpnPrefs | null>(null)
  const [want, setWant] = useState<VpnPrefs | null>(null)
  const [preview, setPreview] = useState<VpnSettingsPreview | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [tags, setTags] = useState(cell.tags.join(', '))
  const [login, setLogin] = useState<{ url: string; expiresAt: string } | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    apiJson<{ current: VpnPrefs }>(`/api/remote/v1/machines/${enc(row.id)}/${provider}/settings`).then(r => {
      if (r.ok && r.body) { setCurrent(r.body.current); setWant(r.body.current) } else setErr(r.error ?? 'Could not read the settings back from the machine')
    })
  }, [row.id, provider])

  const change = (k: keyof VpnPrefs, v: any) => { setWant(w => (w ? { ...w, [k]: v } : w)); setPreview(null) }
  const diff = (): Partial<VpnPrefs> => {
    if (!current || !want) return {}
    const out: Partial<VpnPrefs> = {}
    for (const k of Object.keys(want) as Array<keyof VpnPrefs>) if (JSON.stringify(want[k]) !== JSON.stringify(current[k])) (out as any)[k] = want[k]
    return out
  }
  const showPreview = async () => {
    const r = await apiJson<VpnSettingsPreview>(`/api/remote/v1/machines/${enc(row.id)}/${provider}/settings/preview`, 'POST', { prefs: diff() })
    if (r.ok && r.body) setPreview(r.body); else setErr(r.error ?? 'Could not preview')
  }

  return (
    <ConfirmDialog title={`${label} on ${row.name}`} onClose={onClose}>
      <div className="space-y-1 text-sm" style={{ color: 'var(--text-soft)' }}>
        <div>{cell.ip ?? 'no overlay address'}{cell.dnsName ? ` · ${cell.dnsName}` : ''}{cell.version ? ` · v${cell.version}` : ''}</div>
        {cell.lastSeen && <div>Last seen {fmtTime(cell.lastSeen)}</div>}
        <div>
          {cell.keyExpiryDisabled ? 'Key expiry is off.' : cell.expiresAt ? `Key expires ${fmtTime(cell.expiresAt)}.` : 'Key expiry unknown.'}
          {cell.expiryWarning && <span style={{ color: 'var(--warn)' }}> Less than 14 days left.</span>}
        </div>
      </div>

      {cell.loginPending && (
        <Notice tone="warn">
          <div className="space-y-2">
            <div>{row.name} is waiting for a {label} sign-in. The link works once and expires after about ten minutes.</div>
            {login ? (
              <>
                <code className="block break-all rounded-md border px-2 py-1 text-xs" style={{ borderColor: 'var(--border)' }}>{login.url}</code>
                <div className="flex gap-2">
                  <Btn small onClick={() => { navigator.clipboard?.writeText(login.url).then(() => setCopied(true)).catch(() => undefined) }}>{copied ? 'Copied' : 'Copy link'}</Btn>
                  <span className="text-xs" style={{ color: 'var(--text-dim)' }}>Expires {fmtTime(login.expiresAt)}</span>
                </div>
              </>
            ) : (
              <Btn small onClick={async () => {
                const r = await send<{ url: string; expiresAt: string }>(`/api/remote/machines/${enc(row.id)}/${provider}/login-url`, 'POST')
                if (r?.ok && r.body) setLogin(r.body); else if (r) onNotice('warn', r.error ?? 'No sign-in link')
              }}>Show the sign-in link</Btn>
            )}
          </div>
        </Notice>
      )}

      {err && <Notice tone="crit">{err}</Notice>}
      {node && <Notice tone="info">Proxmox node profile: its own DNS, no accepted routes, no SSH over {label}, never an exit node. These are locked.</Notice>}
      {want && !node && (
        <div className="space-y-2">
          <Toggle label={`Accept DNS (${provider === 'tailscale' ? 'MagicDNS' : 'NetBird DNS'})`} checked={want.acceptDns} onChange={v => change('acceptDns', v)}
                  hint="On: the client manages this machine's DNS so overlay names resolve. Off: /etc/resolv.conf is left alone." />
          <Toggle label="Accept routes other devices offer" checked={want.acceptRoutes} onChange={v => change('acceptRoutes', v)} />
          <Toggle label={`${label} SSH`} checked={want.ssh} onChange={v => change('ssh', v)} hint="People your ACL allows can open a shell over the overlay." />
          <Toggle label="Offer this machine as an exit node" checked={want.advertiseExitNode} disabled={!!want.exitNode} onChange={v => change('advertiseExitNode', v)} />
          <label className="block text-sm" style={{ color: 'var(--text-muted)' }}>
            Use an exit node ({provider === 'tailscale' ? 'its overlay IP or name' : 'its network route id'}; blank for none)
            <input style={{ ...FIELD, marginTop: 4 }} value={want.exitNode ?? ''} disabled={want.advertiseExitNode}
                   onChange={e => change('exitNode', e.target.value.trim() || null)} placeholder="100.64.0.9" />
          </label>
          {want.exitNode && <Toggle label="Allow LAN access while using it" checked={want.exitNodeAllowLan} onChange={v => change('exitNodeAllowLan', v)} />}
          <label className="block text-sm" style={{ color: 'var(--text-muted)' }}>
            Subnets to offer (one per line)
            <textarea style={{ ...FIELD, marginTop: 4, minHeight: 56 }} value={want.subnets.join('\n')} onChange={e => change('subnets', e.target.value.split(/[\s,]+/).filter(Boolean))} />
          </label>
          {preview && (
            <div className="space-y-1">
              {preview.refusal ? <Notice tone="crit">{preview.refusal}</Notice> : preview.changes.length
                ? <ul className="list-disc space-y-1 pl-5 text-sm" style={{ color: 'var(--text-soft)' }}>{preview.changes.map(c => <li key={c}>{c}</li>)}</ul>
                : <p className="text-sm" style={{ color: 'var(--text-dim)' }}>Nothing to change.</p>}
            </div>
          )}
          <div className="flex gap-2">
            <Btn small onClick={showPreview}>Preview</Btn>
            <Btn small kind="primary" disabled={!preview || !!preview.refusal || !preview.changes.length}
                 onClick={async () => onJob(await send(`/api/remote/v1/machines/${enc(row.id)}/${provider}/settings`, 'POST', { prefs: diff(), confirm: true, acknowledge: true }))}>Apply</Btn>
          </div>
        </div>
      )}

      <div className="space-y-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
        <Btn small onClick={async () => {
          const r = await send<{ message: string }>(`/api/remote/machines/${enc(row.id)}/${provider}/key-expiry`, 'POST', { disabled: !cell.keyExpiryDisabled })
          if (r) onNotice(r.ok ? 'info' : 'crit', r.body?.message ?? r.error ?? '')
        }}>{cell.keyExpiryDisabled ? 'Turn key expiry back on' : 'Disable key expiry (servers)'}</Btn>
        <label className="block text-sm" style={{ color: 'var(--text-muted)' }}>
          {provider === 'tailscale' ? 'Tags' : 'Groups'}
          <input style={{ ...FIELD, marginTop: 4 }} value={tags} onChange={e => setTags(e.target.value)} placeholder={provider === 'tailscale' ? 'tag:server' : 'servers'} />
        </label>
        {provider === 'tailscale' && <p className="text-xs" style={{ color: 'var(--text-dim)' }}>Each tag must be listed in your tailnet policy&apos;s tagOwners for the credential HyperProx uses, or Tailscale refuses it. Tagging a device also removes its user ownership.</p>}
        <Btn small onClick={async () => {
          const r = await send<{ message: string }>(`/api/remote/machines/${enc(row.id)}/${provider}/tags`, 'POST', { tags: tags.split(/[\s,]+/).filter(Boolean) })
          if (r) onNotice(r.ok ? 'info' : 'crit', r.body?.message ?? r.error ?? '')
        }}>Save {provider === 'tailscale' ? 'tags' : 'groups'}</Btn>
      </div>
      <div className="flex justify-end"><Btn onClick={onClose}>Close</Btn></div>
    </ConfirmDialog>
  )
}

export function PendingDevices({ ov, send, onDone }: { ov: RemoteOverview; send: Send; onDone: (text: string, ok: boolean) => void }) {
  if (!ov.pendingDevices.length) return null
  return (
    <Panel title="Waiting for approval">
      <ul className="divide-y" style={{ borderColor: 'var(--border-dim)' }}>
        {ov.pendingDevices.map(d => (
          <li key={`${d.provider}:${d.id}`} className="flex flex-wrap items-center gap-3 px-5 py-2 text-sm">
            <span className="font-semibold" style={{ color: 'var(--text-bright)' }}>{d.name}</span>
            <Badge tone="muted">{PROVIDER_LABEL[d.provider]}</Badge>
            <span style={{ color: 'var(--text-soft)' }}>{[d.os, d.user && `added by ${d.user}`, d.createdAt && fmtTime(d.createdAt)].filter(Boolean).join(' · ')}</span>
            <span className="ml-auto flex gap-2">
              <Btn small kind="primary" onClick={async () => { const r = await send<{ message: string }>(`/api/remote/devices/${d.provider}/${enc(d.id)}/approve`, 'POST'); if (r) onDone(r.body?.message ?? r.error ?? '', r.ok) }}>Approve</Btn>
              <Btn small kind="danger" onClick={async () => { const r = await send<{ message: string }>(`/api/remote/devices/${d.provider}/${enc(d.id)}`, 'DELETE'); if (r) onDone(r.body?.message ?? r.error ?? '', r.ok) }}>Remove</Btn>
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  )
}
