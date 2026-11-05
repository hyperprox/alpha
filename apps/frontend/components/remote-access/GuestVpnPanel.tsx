'use client'

// The per-guest VPN panel the Infrastructure drill-down's VPN tab mounts.
//
//   <GuestVpnPanel type="lxc" vmid={101} name="web" />
//
// Props
//   type    'lxc' | 'qemu'         the guest's type
//   vmid    number                 its id
//   name?   string                 shown in headings (defaults to the id)
//   admin?  boolean                show install / settings / uninstall (default: from the session role)
//   source? VpnStatusSource        defaults to apps/frontend/lib/vpn.ts (the /api/remote/v1 API)
//   onChanged?  () => void         called after a job finishes, so the host page can refresh its badges
//
// Everything that changes something asks for the master password when the API wants it (re-confirmation).

import { useCallback, useEffect, useState } from 'react'
import type { RemoteJob, RemoteProviderId, VpnInstallPreview, VpnMachineStatus, VpnPrefs, VpnSettingsPreview, VpnStatusSource } from '@hyperprox/types'
import { atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { vpnStatusSource, VpnApiError } from '@/lib/vpn'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { Badge, Btn, Notice, fmtTime } from '@/components/updates/ui'

const LABEL: Record<RemoteProviderId, string> = { tailscale: 'Tailscale', netbird: 'NetBird' }

export interface GuestVpnPanelProps {
  type: 'lxc' | 'qemu'
  vmid: number
  name?: string
  admin?: boolean
  source?: VpnStatusSource
  onChanged?: () => void
}

export function GuestVpnPanel({ type, vmid, name, admin, source = vpnStatusSource, onChanged }: GuestVpnPanelProps) {
  const { role } = useSession()
  const isAdmin = admin ?? atLeast(role, 'admin')
  const id = source.guestId(type, vmid)
  const [st, setSt] = useState<VpnMachineStatus | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [job, setJob] = useState<RemoteJob | null>(null)
  const [preview, setPreview] = useState<{ p: RemoteProviderId; pv: VpnInstallPreview } | null>(null)
  const [settings, setSettings] = useState<{ p: RemoteProviderId; cur: VpnPrefs; want: VpnPrefs; pv: VpnSettingsPreview | null } | null>(null)
  const [confirm, setConfirm] = useState<null | (() => void)>(null)

  const load = useCallback(async () => {
    try { setSt(await source.statusFor(id)); setErr(null) } catch (e: any) { setErr(e?.message ?? 'Could not read VPN status') }
  }, [source, id])
  useEffect(() => { load() }, [load])

  // Poll a running job, then refresh.
  useEffect(() => {
    if (!job || job.status !== 'running') return
    const t = setInterval(async () => {
      try { const j = await source.job(job.id); setJob(j); if (j.status !== 'running') { load(); onChanged?.() } } catch { /* keep polling */ }
    }, 1500)
    return () => clearInterval(t)
  }, [job, source, load, onChanged])

  /** Run an action; if it needs the master password, ask and try again. */
  const act = (fn: () => Promise<void>) => fn().catch((e: any) => {
    if (e instanceof VpnApiError && e.code === 'reconfirm_required') setConfirm(() => () => { setConfirm(null); fn().catch(x => setErr(x?.message)) })
    else setErr(e?.message ?? 'Failed')
  })

  const who = name ?? id
  if (err && !st) return <Notice tone="crit">{err}</Notice>
  if (!st) return <p className="text-sm" style={{ color: 'var(--text-dim)' }}>Reading VPN status…</p>

  return (
    <div className="space-y-3">
      {err && <Notice tone="crit">{err}</Notice>}
      {(Object.keys(st.providers) as RemoteProviderId[]).map(p => {
        const c = st.providers[p]
        return (
          <div key={p} className="rounded-md border p-3" style={{ borderColor: 'var(--border)' }}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold" style={{ color: 'var(--text-bright)' }}>{LABEL[p]}</span>
              <Badge tone={c.state === 'connected' ? 'good' : c.state === 'not-installed' || c.state === 'unconfigured' ? 'muted' : 'warn'}>{c.state}</Badge>
              {c.expiryWarning && <Badge tone="warn">key expires soon</Badge>}
            </div>
            <div className="mt-1 text-xs" style={{ color: 'var(--text-soft)' }}>
              {[c.ip, c.dnsName, c.version && `v${c.version}`, c.lastSeen && `last seen ${fmtTime(c.lastSeen)}`, c.expiresAt && `key expires ${fmtTime(c.expiresAt)}`].filter(Boolean).join(' · ') || '—'}
            </div>
            {isAdmin && c.state !== 'unconfigured' && (
              <div className="mt-2 flex flex-wrap gap-2">
                {!c.installed && c.state === 'not-installed' && (
                  <Btn small kind="primary" onClick={() => act(async () => setPreview({ p, pv: await source.installPreview(id, p) }))}>Install</Btn>
                )}
                {c.installed && (
                  <>
                    <Btn small onClick={() => act(async () => { const cur = await source.settings(id, p); setSettings({ p, cur, want: cur, pv: null }) })}>Settings…</Btn>
                    <Btn small kind="danger" onClick={() => act(async () => { const r = await source.uninstall(id, p); setJob(await source.job(r.jobId)) })}>Uninstall</Btn>
                  </>
                )}
                <a href={source.panelUrl(id, p)} className="text-xs underline self-center" style={{ color: 'var(--accent)' }}>Open on the VPN page</a>
              </div>
            )}
          </div>
        )
      })}

      {preview && (
        <div className="rounded-md border p-3 text-sm" style={{ borderColor: 'var(--border)' }}>
          <div className="font-semibold" style={{ color: 'var(--text-bright)' }}>Install {LABEL[preview.p]} on {who}</div>
          <ul className="mt-1 list-disc pl-5" style={{ color: 'var(--text-soft)' }}>{preview.pv.steps.map(s => <li key={s}>{s}</li>)}</ul>
          <div className="mt-2 flex gap-2">
            <Btn small kind="primary" onClick={() => act(async () => { const r = await source.install(id, preview.p); setPreview(null); setJob(await source.job(r.jobId)) })}>Install</Btn>
            <Btn small onClick={() => setPreview(null)}>Cancel</Btn>
          </div>
        </div>
      )}

      {settings && (
        <div className="space-y-2 rounded-md border p-3 text-sm" style={{ borderColor: 'var(--border)' }}>
          <div className="font-semibold" style={{ color: 'var(--text-bright)' }}>{LABEL[settings.p]} settings on {who}</div>
          {([['acceptDns', settings.p === 'tailscale' ? 'Accept DNS (MagicDNS)' : 'Accept DNS (NetBird DNS)'], ['acceptRoutes', 'Accept routes'], ['ssh', `${LABEL[settings.p]} SSH`]] as const).map(([k, l]) => (
            <label key={k} className="flex items-center gap-2" style={{ color: 'var(--text-soft)' }}>
              <input type="checkbox" checked={settings.want[k]} onChange={e => setSettings({ ...settings, want: { ...settings.want, [k]: e.target.checked }, pv: null })} /> {l}
            </label>
          ))}
          {settings.pv && (settings.pv.refusal ? <Notice tone="crit">{settings.pv.refusal}</Notice>
            : <ul className="list-disc pl-5" style={{ color: 'var(--text-soft)' }}>{settings.pv.changes.map(c => <li key={c}>{c}</li>)}</ul>)}
          <div className="flex gap-2">
            <Btn small onClick={() => act(async () => {
              const change = Object.fromEntries((['acceptDns', 'acceptRoutes', 'ssh'] as const).filter(k => settings.want[k] !== settings.cur[k]).map(k => [k, settings.want[k]]))
              setSettings({ ...settings, pv: await source.previewSettings(id, settings.p, change) })
            })}>Preview</Btn>
            <Btn small kind="primary" disabled={!settings.pv || !!settings.pv.refusal || !settings.pv.changes.length} onClick={() => act(async () => {
              const change = Object.fromEntries((['acceptDns', 'acceptRoutes', 'ssh'] as const).filter(k => settings.want[k] !== settings.cur[k]).map(k => [k, settings.want[k]]))
              const r = await source.applySettings(id, settings.p, change); setSettings(null); setJob(await source.job(r.jobId))
            })}>Apply</Btn>
            <Btn small onClick={() => setSettings(null)}>Cancel</Btn>
          </div>
        </div>
      )}

      {job && (
        <Notice tone={job.status === 'failed' ? 'crit' : 'info'}>
          {job.status === 'running' ? 'Working…' : job.steps[0]?.detail ?? job.error ?? job.status}
        </Notice>
      )}
      {confirm && <ReconfirmModal onDone={() => confirm()} onClose={() => setConfirm(null)} />}
    </div>
  )
}

export default GuestVpnPanel
