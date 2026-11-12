'use client'

// =============================================================================
//  HyperProx — the Arr Stack's picker, step 1 of the install wizard
//
//  Which apps, whether qBittorrent goes through a VPN, where the library
//  lives, and (optionally) public names. Each app is a card that lights up
//  when it is on; Prowlarr locks on when something needs it; the VPN only
//  opens under qBittorrent. The strip at the top adds up what the picked apps
//  cost, and the size step starts from it. The server checks all of it again.
// =============================================================================

import { useEffect, useMemo, useState } from 'react'
import { apiJson } from '@/lib/api'
import { alpha } from '@/lib/theme'
import { INPUT, LABEL, Notice } from '@/components/vault/ui'

interface AppFact { id: string; name: string; blurb: string; option: string; default: boolean; image: string; port: number; cost: Cost; private: boolean }
interface Cost { cores: number; memoryMb: number; diskGb: number }
interface Facts {
  apps: AppFact[]; vpnProviders: Array<{ id: string; name: string; portForwarding: boolean }>
  base: Cost; vpnCost: Cost; layoutLine: string; splitWarning: string
  mediaServer: { kind: string; url: string } | null; pluginConfigured: boolean
  nas: Array<{ storage: string; server: string; export: string }>
}
interface AddressOptions { dnsConfigured: boolean; domains: string[]; proxies: Array<{ id: string; name: string; status: string | null; certificates: string }> }

export interface ArrVpn { wireguard_private_key?: string; wireguard_addresses?: string; openvpn_user?: string; openvpn_password?: string }
export interface ArrNames { zone: string; instanceId: string; names: Record<string, string> }

const MONO = 'font-mono text-[12px]'
/** What needs Prowlarr: the apps that find releases through it. */
const FINDERS = ['ARR_SONARR', 'ARR_RADARR', 'ARR_LIDARR']

/** The same sum the server makes (lib/arr/components.ts totals). */
export function arrTotals(f: Pick<Facts, 'apps' | 'base' | 'vpnCost'>, opts: Record<string, string>): Cost {
  const parts = [f.base, ...f.apps.filter(a => opts[a.option] === '1').map(a => a.cost), ...(opts.ARR_VPN === '1' ? [f.vpnCost] : [])]
  const sum = parts.reduce((t, p) => ({ cores: t.cores + p.cores, memoryMb: t.memoryMb + p.memoryMb, diskGb: t.diskGb + p.diskGb }), { cores: 0, memoryMb: 0, diskGb: 0 })
  const extra = opts.ARR_DOWNLOADS === 'local' ? Math.max(0, Number(opts.ARR_DOWNLOAD_GB) || 0) : 0
  return { cores: Math.max(1, Math.ceil(sum.cores)), memoryMb: Math.ceil(sum.memoryMb / 256) * 256, diskGb: Math.ceil(sum.diskGb + extra) }
}

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block min-w-0">
      <span style={LABEL}>{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px]" style={{ color: 'var(--text-dim)' }}>{hint}</span>}
    </label>
  )
}

function Segmented<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: Array<[T, string]>; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="grid rounded-md border overflow-hidden" style={{ borderColor: 'var(--border-strong)', gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
      {items.map(([v, l]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}
          className="min-h-[42px] px-2 text-[13px] leading-tight"
          style={{ background: value === v ? 'var(--accent)' : 'transparent', color: value === v ? 'var(--accent-ink)' : 'var(--text-soft)' }}>
          {l}
        </button>
      ))}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-dim)' }}>{label}</p>
      <p className="font-display text-[22px] font-bold leading-none mt-1" style={{ color: 'var(--text-bright)' }}>{value}</p>
    </div>
  )
}

/**
 * The picker. `opts` holds the recipe's ARR_* options; the VPN login and the public names are kept apart from them
 * (the login goes to the vault, never into the plan). `onState` reports what the size step should start from and
 * whether everything needed has been filled in.
 */
export function ArrPicker({ opts, setOpts, vpn, setVpn, names, setNames, onState }: {
  opts: Record<string, string>; setOpts: (f: (v: Record<string, string>) => Record<string, string>) => void
  vpn: ArrVpn; setVpn: (v: ArrVpn) => void
  names: ArrNames | null; setNames: (n: ArrNames | null) => void
  onState: (s: { totals: Cost | null; missing: string[] }) => void
}) {
  const [facts, setFacts] = useState<Facts | null>(null)
  const [factsError, setFactsError] = useState('')
  const [addr, setAddr] = useState<AddressOptions | null>(null)

  useEffect(() => {
    void apiJson<{ data: Facts }>('/api/catalogue/wizard/arr').then(r => {
      if (!r.ok || !r.body?.data) { setFactsError(r.error ?? 'Could not read the Arr Stack\'s apps.'); return }
      setFacts(r.body.data)
    })
  }, [])
  useEffect(() => {
    if (!names || addr) return
    void apiJson<{ data: AddressOptions }>('/api/sites/address/options').then(r => {
      if (!r.ok || !r.body) return
      const a = r.body.data
      setAddr(a)
      const usable = a.proxies.find(p => p.certificates !== 'none' && p.status !== 'locked')
      setNames({ ...names, zone: names.zone || a.domains[0] || '', instanceId: names.instanceId || usable?.id || '' })
    })
  }, [names, addr, setNames])

  const on = (k: string) => opts[k] === '1'
  const set = (k: string, v: string) => setOpts(o => ({ ...o, [k]: v }))
  const needsProwlarr = FINDERS.some(on)
  // Prowlarr comes with anything that finds releases through it, and the VPN goes with qBittorrent.
  useEffect(() => {
    if (needsProwlarr && !on('ARR_PROWLARR')) set('ARR_PROWLARR', '1')
    if (!on('ARR_QBITTORRENT') && on('ARR_VPN')) set('ARR_VPN', '0')
  })

  const provider = facts?.vpnProviders.find(p => p.id === opts.ARR_VPN_PROVIDER)
  const vpnType = opts.ARR_VPN_TYPE === 'openvpn' ? 'openvpn' : 'wireguard'
  const totals = useMemo(() => (facts ? arrTotals(facts, opts) : null), [facts, opts])

  const missing = useMemo(() => {
    const m: string[] = []
    if (facts && !facts.apps.some(a => on(a.option))) m.push('at least one app')
    if (on('ARR_VPN')) {
      if (!provider) m.push('the VPN provider')
      if (vpnType === 'wireguard' && !(vpn.wireguard_private_key ?? '').trim()) m.push('the WireGuard private key')
      if (vpnType === 'openvpn' && (!(vpn.openvpn_user ?? '').trim() || !(vpn.openvpn_password ?? '').trim())) m.push('the OpenVPN user name and password')
    }
    if (opts.ARR_MEDIA === 'nfs' && (!opts.ARR_NFS_HOST?.trim() || !opts.ARR_NFS_EXPORT?.trim())) m.push('the NAS and its NFS export')
    if (opts.ARR_MEDIA === 'path' && !opts.ARR_HOST_PATH?.trim()) m.push('the folder on the node')
    if (names && Object.values(names.names).some(Boolean) && (!names.zone || !names.instanceId)) m.push('the domain and proxy for the public names')
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facts, opts, vpn, provider, vpnType, names])
  useEffect(() => { onState({ totals, missing }) }, [totals, missing, onState])

  if (factsError) return <Notice kind="error">{factsError}</Notice>
  if (!facts || !totals) return <p className="text-sm animate-pulse" style={{ color: 'var(--text-muted)' }}>Reading the apps…</p>

  const split = opts.ARR_DOWNLOADS === 'local'
  const publishable = facts.apps.filter(a => on(a.option) && !a.private)

  return (
    <div className="space-y-4">
      {/* The running total, HUD-style: what the picked apps cost the container. */}
      <div className="relative rounded-lg border px-4 py-3" style={{ borderColor: alpha('var(--accent)', 40), background: `linear-gradient(135deg, ${alpha('var(--accent)', 8)}, var(--ground-inset))` }}>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] mb-2" style={{ color: 'var(--accent)' }}>
          {facts.apps.filter(a => on(a.option)).length} apps{on('ARR_VPN') ? ' + VPN' : ''} · this container needs
        </p>
        <div className="grid grid-cols-3 gap-3">
          <Stat label="CPU" value={`${totals.cores} core${totals.cores > 1 ? 's' : ''}`} />
          <Stat label="RAM" value={`${(totals.memoryMb / 1024).toFixed(totals.memoryMb % 1024 ? 2 : 0)} GB`} />
          <Stat label="Disk" value={`${totals.diskGb} GB`} />
        </div>
        <p className="mt-2 text-[12px]" style={{ color: 'var(--text-dim)' }}>
          For the apps themselves{split ? ' and their downloads' : ''}; the library is on top{opts.ARR_MEDIA === 'disk' ? ` (its own ${opts.ARR_MEDIA_GB || '?'} GB disk)` : ''}. The next step starts from these.
        </p>
      </div>

      {/* The apps */}
      <div>
        <p className="font-display text-[17px] font-semibold mb-2" style={{ color: 'var(--text-bright)' }}>Apps</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {facts.apps.map(a => {
            const checked = on(a.option)
            const locked = a.id === 'prowlarr' && needsProwlarr
            return (
              <div key={a.id} className="rounded-lg border transition-colors" style={{
                borderColor: checked ? 'var(--accent)' : 'var(--border-soft)',
                background: checked ? `color-mix(in srgb, var(--accent) 7%, var(--ground-inset))` : 'var(--ground-inset)',
                boxShadow: checked ? `0 0 14px ${alpha('var(--accent)', 18)}` : undefined,
              }}>
                <label className="flex items-start gap-3 p-3 cursor-pointer">
                  <input type="checkbox" className="mt-1" checked={checked} disabled={locked}
                    onChange={e => set(a.option, e.target.checked ? '1' : '0')} aria-describedby={`arr-${a.id}-blurb`} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-display text-[17px] font-semibold" style={{ color: 'var(--text-bright)' }}>{a.name}</span>
                      {locked && <span className="font-mono text-[10px] uppercase tracking-[0.08em] px-1.5 py-0.5 rounded" style={{ color: 'var(--accent)', border: `1px solid ${alpha('var(--accent)', 40)}` }}>needed</span>}
                      {a.default && !locked && <span className="font-mono text-[10px] uppercase tracking-[0.08em]" style={{ color: 'var(--text-dim)' }}>suggested</span>}
                    </span>
                    <span id={`arr-${a.id}-blurb`} className="block text-[13px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {a.blurb}{locked ? ' Sonarr, Radarr and Lidarr find releases through it, so it stays on.' : ''}
                      {a.id === 'seerr' && checked && (facts.mediaServer
                        ? ` It signs in with the Plex server HyperProx knows.`
                        : ' HyperProx knows no Plex server with a token yet, so Seerr is installed but left stopped until you add one to the Plex plug-in (a Seerr nobody has signed in to belongs to whoever opens it first).')}
                    </span>
                    <span className={`${MONO} block mt-1`} style={{ color: 'var(--text-dimmer)' }}>port {a.port}</span>
                  </span>
                </label>
                {/* The VPN lives under qBittorrent: it covers that app only. */}
                {a.id === 'qbittorrent' && checked && (
                  <div className="border-t px-3 py-3 space-y-3" style={{ borderColor: 'var(--border-soft)' }}>
                    <label className="flex items-start gap-2 text-sm cursor-pointer" style={{ color: 'var(--text)' }}>
                      <input type="checkbox" className="mt-1" checked={on('ARR_VPN')} onChange={e => set('ARR_VPN', e.target.checked ? '1' : '0')} />
                      <span>Send qBittorrent through a VPN
                        <span className="block text-[12px]" style={{ color: 'var(--text-dim)' }}>Through Gluetun: if the VPN drops, qBittorrent has no network at all. Only qBittorrent uses it.</span>
                      </span>
                    </label>
                    {on('ARR_VPN') && (
                      <div className="space-y-3">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <Field label="Provider">
                            <select value={opts.ARR_VPN_PROVIDER ?? ''} onChange={e => set('ARR_VPN_PROVIDER', e.target.value)} style={INPUT}>
                              <option value="">Pick one…</option>
                              {facts.vpnProviders.map(p => <option key={p.id} value={p.id}>{p.name}{p.portForwarding ? ' · port forwarding' : ''}</option>)}
                            </select>
                          </Field>
                          <Field label="Connection">
                            <Segmented label="VPN type" value={vpnType} onChange={v => set('ARR_VPN_TYPE', v)} items={[['wireguard', 'WireGuard'], ['openvpn', 'OpenVPN']]} />
                          </Field>
                        </div>
                        {vpnType === 'wireguard' ? (
                          <div className="grid gap-3 sm:grid-cols-2">
                            <Field label="Private key" hint="PrivateKey from your provider's WireGuard file.">
                              <input type="password" autoComplete="off" value={vpn.wireguard_private_key ?? ''} onChange={e => setVpn({ ...vpn, wireguard_private_key: e.target.value })} style={INPUT} spellCheck={false} />
                            </Field>
                            <Field label="Address" hint="The Address line, like 10.2.0.2/32. Some providers do not need it.">
                              <input value={vpn.wireguard_addresses ?? ''} onChange={e => setVpn({ ...vpn, wireguard_addresses: e.target.value })} style={INPUT} spellCheck={false} autoCapitalize="none" />
                            </Field>
                          </div>
                        ) : (
                          <div className="grid gap-3 sm:grid-cols-2">
                            <Field label="OpenVPN user name" hint="Often not your account email: look for OpenVPN credentials.">
                              <input autoComplete="off" value={vpn.openvpn_user ?? ''} onChange={e => setVpn({ ...vpn, openvpn_user: e.target.value })} style={INPUT} spellCheck={false} autoCapitalize="none" />
                            </Field>
                            <Field label="OpenVPN password">
                              <input type="password" autoComplete="off" value={vpn.openvpn_password ?? ''} onChange={e => setVpn({ ...vpn, openvpn_password: e.target.value })} style={INPUT} />
                            </Field>
                          </div>
                        )}
                        <Field label="Countries (optional)" hint="Where to pick a server, like Netherlands, Switzerland. Blank lets the VPN choose.">
                          <input value={opts.ARR_VPN_COUNTRIES ?? ''} onChange={e => set('ARR_VPN_COUNTRIES', e.target.value)} style={INPUT} />
                        </Field>
                        <p className="text-[12px]" style={{ color: provider && !provider.portForwarding ? 'var(--warn-2)' : 'var(--text-dim)' }}>
                          Good torrent speeds need port forwarding, so other people can connect to you. {provider
                            ? provider.portForwarding ? `${provider.name} offers it, and HyperProx turns it on and tells qBittorrent each new port.` : `${provider.name} does not offer it through Gluetun: downloads work, but many will be slow.`
                            : 'Proton VPN, Private Internet Access, PrivateVPN and Perfect Privacy offer it.'} The login goes into the vault, never into the plan.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* The library */}
      <div className="rounded-lg border p-4 space-y-3" style={{ borderColor: 'var(--border-soft)', background: 'var(--ground-inset)' }}>
        <p className="font-display text-[17px] font-semibold" style={{ color: 'var(--text-bright)' }}>Where the library goes</p>
        <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>{facts.layoutLine}</p>
        <Segmented label="Library location" value={(opts.ARR_MEDIA || 'disk') as 'disk' | 'nfs' | 'path'} onChange={v => set('ARR_MEDIA', v)}
          items={[['disk', 'A new disk'], ['nfs', 'A NAS (NFS)'], ['path', 'A folder on the node']]} />
        {(opts.ARR_MEDIA || 'disk') === 'disk' && (
          <Field label="Library disk (GB)" hint="Made on the storage you pick in step 3, mounted at /data. Left out of Proxmox backups: media is too big to back up nightly.">
            <input type="number" min={10} value={opts.ARR_MEDIA_GB ?? ''} onChange={e => set('ARR_MEDIA_GB', e.target.value)} style={INPUT} inputMode="numeric" />
          </Field>
        )}
        {opts.ARR_MEDIA === 'nfs' && (
          <div className="space-y-3">
            {facts.nas.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {facts.nas.map(n => (
                  <button key={n.storage} type="button" onClick={() => { set('ARR_NFS_HOST', n.server); set('ARR_NFS_EXPORT', n.export) }}
                    className="rounded-md border px-2.5 py-1.5 text-[12px]" style={{ borderColor: 'var(--border-strong)', color: 'var(--text-soft)' }}>
                    {n.server}:{n.export} <span style={{ color: 'var(--text-dim)' }}>({n.storage})</span>
                  </button>
                ))}
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="NAS" hint="Its IP address or name.">
                <input value={opts.ARR_NFS_HOST ?? ''} onChange={e => set('ARR_NFS_HOST', e.target.value.trim())} placeholder="10.0.0.20" style={INPUT} autoCapitalize="none" spellCheck={false} />
              </Field>
              <Field label="NFS export" hint="Like /Media (QNAP) or /volume1/media (Synology).">
                <input value={opts.ARR_NFS_EXPORT ?? ''} onChange={e => set('ARR_NFS_EXPORT', e.target.value.trim())} placeholder="/Media" style={INPUT} autoCapitalize="none" spellCheck={false} />
              </Field>
            </div>
            <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
              Mounted on the container&rsquo;s node only (rw, NFS v3, hard, nofail), then passed in. The apps write as uid 101000 on the NAS: let that user write to the export. The preview checks the NAS can be reached before anything is made.
            </p>
          </div>
        )}
        {opts.ARR_MEDIA === 'path' && (
          <Field label="Folder on the node" hint="A folder that already exists on the node you pick, such as /mnt/media. The apps write there as uid 101000.">
            <input value={opts.ARR_HOST_PATH ?? ''} onChange={e => set('ARR_HOST_PATH', e.target.value.trim())} placeholder="/mnt/media" style={INPUT} autoCapitalize="none" spellCheck={false} />
          </Field>
        )}
        <div className="space-y-2">
          <span style={LABEL}>Downloads</span>
          <Segmented label="Downloads" value={(opts.ARR_DOWNLOADS || 'together') as 'together' | 'local'} onChange={v => set('ARR_DOWNLOADS', v)}
            items={[['together', 'With the library (recommended)'], ['local', 'On the container’s own disk']]} />
          {split && (
            <>
              <Field label="Room for downloads (GB)" hint="Added to the container's own disk.">
                <input type="number" min={10} value={opts.ARR_DOWNLOAD_GB ?? ''} onChange={e => set('ARR_DOWNLOAD_GB', e.target.value)} style={INPUT} inputMode="numeric" />
              </Field>
              <Notice kind="warn">{facts.splitWarning}</Notice>
            </>
          )}
        </div>
      </div>

      {/* Sign-in */}
      <div className="rounded-lg border p-4 grid gap-3 sm:grid-cols-2 items-end" style={{ borderColor: 'var(--border-soft)', background: 'var(--ground-inset)' }}>
        <Field label="Sign-in name (optional)" hint="One sign-in for every app. Blank makes one up; the password is always generated and kept in the vault.">
          <input value={opts.ARR_ADMIN_USER ?? ''} onChange={e => set('ARR_ADMIN_USER', e.target.value.toLowerCase().trim())} placeholder="made up for you" style={INPUT} autoCapitalize="none" spellCheck={false} maxLength={32} />
        </Field>
        <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
          {facts.pluginConfigured ? 'The Arr Stack plug-in already reads a stack, so it is left as it is.' : 'The Arr Stack plug-in is connected to the new apps for you.'}
        </p>
      </div>

      {/* Public names: off unless asked for */}
      <div className="rounded-lg border p-4 space-y-3" style={{ borderColor: 'var(--border-soft)', background: 'var(--ground-inset)' }}>
        <label className="flex items-start gap-2 text-sm cursor-pointer" style={{ color: 'var(--text)' }}>
          <input type="checkbox" className="mt-1" checked={Boolean(names)} onChange={e => setNames(e.target.checked ? { zone: '', instanceId: '', names: {} } : null)} />
          <span>Reach them from outside your network (optional)
            <span className="block text-[12px]" style={{ color: 'var(--text-dim)' }}>A public name and certificate per app, through your proxy and DNS provider. Download clients stay private.</span>
          </span>
        </label>
        {names && !addr && <p className="text-[12px] animate-pulse" style={{ color: 'var(--text-dim)' }}>Reading your domains and proxies…</p>}
        {names && addr && (!addr.dnsConfigured || !addr.domains.length) && <Notice kind="warn">No DNS provider is set up, so HyperProx cannot make public names. Add one under Settings → DNS.</Notice>}
        {names && addr && addr.domains.length > 0 && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Domain">
                <select value={names.zone} onChange={e => setNames({ ...names, zone: e.target.value })} style={INPUT}>
                  {addr.domains.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </Field>
              <Field label="Proxy">
                <select value={names.instanceId} onChange={e => setNames({ ...names, instanceId: e.target.value })} style={INPUT}>
                  <option value="">Pick one…</option>
                  {addr.proxies.map(p => <option key={p.id} value={p.id} disabled={p.certificates === 'none' || p.status === 'locked'}>{p.name}</option>)}
                </select>
              </Field>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {publishable.map(a => (
                <Field key={a.id} label={a.name} hint={names.names[a.id] ? `${names.names[a.id]}.${names.zone}` : 'Blank: not published'}>
                  <input value={names.names[a.id] ?? ''} placeholder={a.id}
                    onChange={e => setNames({ ...names, names: { ...names.names, [a.id]: e.target.value.toLowerCase().trim() } })}
                    style={INPUT} autoCapitalize="none" spellCheck={false} />
                </Field>
              ))}
            </div>
            <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>Each app keeps its own sign-in. Publish only what you need away from home.</p>
          </div>
        )}
      </div>
    </div>
  )
}
