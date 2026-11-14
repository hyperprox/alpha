'use client'

// WireGuard on the VPN page: HyperProx servers and their peers, machines connected as clients, and the
// MikroTik router's WireGuard (read through the plug-in; peers written only with the limited login).

import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { RemoteMachineRow } from '@hyperprox/types'
import { apiJson, type ApiResult } from '@/lib/api'
import { browserKeypair } from '@/lib/wg-keys'
import { Badge, Btn, ConfirmDialog, Notice, fmtTime } from '@/components/updates/ui'
import { Panel } from './panel'
import { StatusDots, type DotState } from '@/components/visual/kit'
import { InstallHandoffNotice, WgServerHeading, type PendingVpnEntry } from './InstallHandoff'

type Send = <T>(path: string, method: string, body?: unknown) => Promise<ApiResult<T> | null>

interface Server { id: string; machineId: string; iface: string; listenPort: number; address: string; endpoint: string; publicKey: string; keyBackedUp: boolean }
interface Peer { id: string; serverId: string | null; routerIface: string | null; routerPeerId: string | null; kind: 'device' | 'machine'; name: string; machineId: string | null; publicKey: string; address: string; allowedIps: string[]; clientAllowedIps: string[]; previousUntil: string | null }
interface Live { publicKey: string; latestHandshake: string | null; rx: number; tx: number; endpoint: string | null }
interface RouterView {
  /** false: no MikroTik is set up (an empty view, with setupNote saying so). */
  configured?: boolean
  interfaces: Array<{ id: string; name: string; listenPort: number | null; publicKey: string | null; running: boolean; firewallOk: boolean | null; firewallCommand: string | null }>
  peers: Array<{ id: string; interface: string; name: string | null; allowedAddress: string[]; currentEndpoint: string | null; lastHandshake: string | null; rx: number; tx: number; comment: string | null; managed: boolean }>
  writable: boolean; setup: string[] | null; setupNote: string
}

const FIELD: React.CSSProperties = { background: 'var(--ground-deep)', border: '1px solid var(--border-strong)', color: 'var(--text-bright)', borderRadius: 6, padding: '6px 10px', fontSize: 14, width: '100%' }
const bytes = (n: number) => (n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MiB` : `${Math.round(n / 1024)} KiB`)

function ConfigDialog({ title, config, onClose }: { title: string; config: string; onClose: () => void }) {
  const [qr, setQr] = useState<string | null>(null)
  useEffect(() => { QRCode.toDataURL(config, { margin: 1, width: 260 }).then(setQr).catch(() => setQr(null)) }, [config])
  return (
    <ConfirmDialog title={title} onClose={onClose}>
      <Notice tone="warn">This contains the device&apos;s private key. Scan it or download it now; it is kept in the vault and can be shown again only after your master password.</Notice>
      {qr && <img src={qr} alt="WireGuard config QR code" className="mx-auto rounded bg-white p-2" width={260} height={260} />}
      <div className="flex justify-end gap-2">
        <Btn small onClick={() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([config], { type: 'text/plain' })); a.download = `${title.replace(/[^A-Za-z0-9-]+/g, '-')}.conf`; a.click(); URL.revokeObjectURL(a.href) }}>Download .conf</Btn>
        <Btn onClick={onClose}>Done</Btn>
      </div>
    </ConfirmDialog>
  )
}

export function WireguardSection({ machines, send, notice }: { machines: RemoteMachineRow[]; send: Send; notice: (tone: 'info' | 'warn' | 'crit', text: string) => void }) {
  const [servers, setServers] = useState<Server[]>([])
  const [peers, setPeers] = useState<Peer[]>([])
  const [live, setLive] = useState<Record<string, Live[]>>({})
  const [router, setRouter] = useState<RouterView | null>(null)
  // Whether WireGuard can run in the machine chosen for a new server (a container needs its node's module).
  const [wgMod, setWgMod] = useState<{ ok: boolean | null; reason: string | null; fix: string | null } | null>(null)
  const checkModule = async (machineId: string) => {
    setWgMod(null)
    if (!machineId) return
    const r = await apiJson<{ ok: boolean | null; reason: string | null; fix: string | null }>(`/api/vpn/wg/module?machineId=${encodeURIComponent(machineId)}`)
    setWgMod(r.ok && r.body ? r.body : { ok: null, reason: r.error ?? null, fix: null })
  }
  const [routerErr, setRouterErr] = useState<string | null>(null)
  const [shown, setShown] = useState<{ title: string; config: string } | null>(null)
  const [form, setForm] = useState<null | 'server' | { device: string } | 'connect' | 'router-device'>(null)
  const [f, setF] = useState<Record<string, any>>({})
  const [pending, setPending] = useState<PendingVpnEntry[]>([])

  const load = useCallback(async () => {
    const r = await apiJson<{ servers: Server[]; peers: Peer[] }>('/api/vpn/wg')
    if (r.ok && r.body) { setServers(r.body.servers); setPeers(r.body.peers) }
    const rv = await apiJson<RouterView>('/api/vpn/wg/router')
    if (rv.ok && rv.body) { setRouter(rv.body); setRouterErr(null) } else { setRouter(null); setRouterErr(rv.error ?? null) }
    const ip = await apiJson<{ entries: PendingVpnEntry[] }>('/api/vpn/install-pending')
    setPending(ip.ok && ip.body ? ip.body.entries : [])
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    for (const s of servers) apiJson<{ peers: Array<{ live: Live | null }> }>(`/api/vpn/wg/servers/${s.id}/status`).then(r => {
      if (r.ok && r.body) setLive(l => ({ ...l, [s.id]: r.body!.peers.map(p => p.live).filter((x): x is Live => !!x) }))
    })
  }, [servers])

  const done = (r: ApiResult<any> | null, ok: string) => { if (!r) return false; if (!r.ok) { notice('crit', r.error ?? 'Failed'); return false } notice('info', ok); setForm(null); setF({}); load(); return true }
  const keys = async () => (await browserKeypair()) ?? null
  const guests = machines.filter(m => m.kind !== 'host')
  const nameOf = (id: string | null) => machines.find(m => m.id === id)?.name ?? id ?? ''

  return (
    <Panel title="WireGuard" right={<div className="flex gap-2"><Btn small onClick={() => setForm('server')}>New server…</Btn><Btn small onClick={() => setForm('connect')}>Connect a machine…</Btn></div>}>
      <div className="space-y-4">
        <InstallHandoffNotice entries={pending}
          retry={<Btn small onClick={async () => { done(await send('/api/vpn/install-pending/retry', 'POST'), 'Tried again.') }}>Retry now</Btn>} />
        {!servers.length && <p className="text-sm" style={{ color: 'var(--text-dim)' }}>No WireGuard server yet. A server runs in a container or VM; its key is made there and never leaves it.</p>}
        {servers.map(s => (
          <div key={s.id} className="rounded-md border" style={{ borderColor: 'var(--border)' }}>
            <WgServerHeading name={nameOf(s.machineId)} iface={s.iface} address={s.address} endpoint={s.endpoint} keyBackedUp={s.keyBackedUp}
              peers={peers.filter(p => p.serverId === s.id).length}
              add={<Btn small kind="primary" onClick={() => setForm({ device: s.id })}>Add phone or laptop…</Btn>}
              badge={<Badge tone="muted" title="The server key also has a copy in the vault">key in vault</Badge>} />
            {peers.some(p => p.serverId === s.id) && (
              <div className="px-3 py-2">
                {/* A peer is working when it shook hands in the last five minutes, warning when it did once but not lately, off when never. */}
                <StatusDots label={`Peers of ${nameOf(s.machineId)}`} items={peers.filter(p => p.serverId === s.id).map(p => {
                  const hs = live[s.id]?.find(x => x.publicKey === p.publicKey)?.latestHandshake
                  const age = hs ? Date.now() - new Date(hs).getTime() : NaN
                  const state: DotState = !hs ? 'off' : Number.isFinite(age) && age < 5 * 60_000 ? 'ok' : 'warn'
                  return { label: p.name, state }
                })} />
              </div>
            )}
            <ul className="divide-y text-sm" style={{ borderColor: 'var(--border-dim)' }}>
              {peers.filter(p => p.serverId === s.id).map(p => {
                const l = live[s.id]?.find(x => x.publicKey === p.publicKey)
                return (
                  <li key={p.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <span style={{ color: 'var(--text-bright)' }}>{p.name}</span>
                    <Badge tone="muted">{p.kind === 'device' ? 'device' : 'machine'}</Badge>
                    <span className="font-mono text-xs" style={{ color: 'var(--text-soft)' }}>{p.address}</span>
                    <span className="text-xs" style={{ color: 'var(--text-dim)' }}>{l?.latestHandshake ? `handshake ${fmtTime(l.latestHandshake)} · ${bytes(l.rx)} in · ${bytes(l.tx)} out` : 'no handshake yet'}</span>
                    {p.previousUntil && <Badge tone="warn" title="The previous key is kept until then, so the rotation can be undone">rotated</Badge>}
                    <span className="ml-auto flex flex-wrap gap-1">
                      {p.kind === 'device' && <Btn small onClick={async () => { const r = await send<{ config: string }>(`/api/vpn/wg/peers/${p.id}/reveal`, 'POST'); if (r?.ok && r.body) setShown({ title: p.name, config: r.body.config }) }}>QR / config…</Btn>}
                      {p.kind === 'device' && <Btn small onClick={async () => {
                        const k = await keys()
                        const r = await send<{ config: string }>(`/api/vpn/wg/peers/${p.id}/rotate`, 'POST', k ?? { keygen: 'server' })
                        if (done(r, `Rotated ${p.name}; the old key is kept seven days.`) && r?.body) setShown({ title: `${p.name} (new key)`, config: r.body.config })
                      }}>Rotate key</Btn>}
                      {p.previousUntil && <Btn small onClick={async () => done(await send(`/api/vpn/wg/peers/${p.id}/rollback`, 'POST'), 'Rotation undone.')}>Undo rotation</Btn>}
                      <Btn small kind="danger" onClick={async () => done(await send(`/api/vpn/wg/peers/${p.id}`, 'DELETE'), `Removed ${p.name}.`)}>Remove</Btn>
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}

        <div className="space-y-2">
          <h3 className="font-display font-semibold" style={{ fontSize: 18, color: 'var(--text-bright)' }}>Router</h3>
          {routerErr && <p className="text-sm" style={{ color: 'var(--text-dim)' }}>{routerErr}</p>}
          {router && router.configured === false && <p className="text-sm" style={{ color: 'var(--text-dim)' }}>{router.setupNote}</p>}
          {router && router.configured !== false && (
            <>
              {!router.writable && (
                <Notice tone="info">
                  <div className="space-y-1">
                    <div>Read-only: HyperProx has no write login for the router. It never uses the router&apos;s admin login. To let it add WireGuard peers, run these on the router, then add the login under Settings → Credentials → Remote access:</div>
                    <pre className="whitespace-pre-wrap rounded border p-2 font-mono text-xs" style={{ borderColor: 'var(--border)' }}>{router.setup!.join('\n')}</pre>
                  </div>
                </Notice>
              )}
              <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{router.setupNote} HyperProx never changes the router&apos;s firewall, addresses or routes.</p>
              {router.interfaces.map(i => (
                <div key={i.id} className="rounded-md border p-3 text-sm" style={{ borderColor: 'var(--border)' }}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold" style={{ color: 'var(--text-bright)' }}>{i.name}</span>
                    <span className="font-mono text-xs" style={{ color: 'var(--text-soft)' }}>port {i.listenPort ?? '—'}</span>
                    <Badge tone={i.running ? 'good' : 'warn'}>{i.running ? 'running' : 'stopped'}</Badge>
                    {router.writable && <span className="ml-auto"><Btn small onClick={() => { setF({ iface: i.name }); setForm('router-device') }}>Add phone or laptop…</Btn></span>}
                  </div>
                  {i.firewallOk === false && (
                    <Notice tone="warn">
                      <div className="space-y-1">
                        <div>No input rule lets WireGuard in on UDP {i.listenPort}. HyperProx does not change the router&apos;s firewall. Review this command and run it on the router yourself:</div>
                        <code className="block break-all font-mono text-xs">{i.firewallCommand}</code>
                      </div>
                    </Notice>
                  )}
                  <ul className="mt-2 space-y-1">
                    {router.peers.filter(p => p.interface === i.name).map(p => (
                      <li key={p.id} className="flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--text-soft)' }}>
                        <span style={{ color: 'var(--text-bright)' }}>{p.name ?? p.comment ?? p.id}</span>
                        <span className="font-mono">{p.allowedAddress.join(', ')}</span>
                        <span>{p.lastHandshake ? `handshake ${p.lastHandshake} ago` : 'no handshake'} · {bytes(p.rx)} in · {bytes(p.tx)} out{p.currentEndpoint ? ` · from ${p.currentEndpoint}` : ''}</span>
                        {p.managed ? <Badge tone="accent">HyperProx</Badge> : <Badge tone="muted" title="Not created by HyperProx, so HyperProx never changes it">yours</Badge>}
                        {p.managed && router.writable && <Btn small kind="danger" onClick={async () => done(await send(`/api/vpn/wg/router/peers/${encodeURIComponent(p.id)}`, 'DELETE'), 'Removed from the router.')}>Remove</Btn>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {form === 'server' && (
        <ConfirmDialog title="New WireGuard server" onClose={() => setForm(null)}>
          <select style={FIELD} value={f.machineId ?? ''} onChange={e => { const id = e.target.value; setF({ ...f, machineId: id }); void checkModule(id) }}>
            <option value="">Choose a container or VM…</option>
            {guests.filter(m => m.kind !== 'node' && m.running).map(m => <option key={m.id} value={m.id}>{m.name} ({m.id})</option>)}
          </select>
          <input style={FIELD} placeholder="Tunnel network, e.g. 100.64.10.1/24" value={f.address ?? ''} onChange={e => setF({ ...f, address: e.target.value })} />
          <input style={FIELD} placeholder="Address clients connect to, e.g. vpn.example.com:51820" value={f.endpoint ?? ''} onChange={e => setF({ ...f, endpoint: e.target.value })} />
          <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--text-soft)' }}>
            <input type="checkbox" className="mt-1" checked={!!f.backupKey} onChange={e => setF({ ...f, backupKey: e.target.checked })} />
            <span>Also keep the server key in the vault. A rebuilt server then keeps its key and no peer needs changing; but anyone who can reveal secrets in the vault could impersonate the server.</span>
          </label>
          {wgMod && wgMod.ok === false && (
            <Notice tone="warn">
              <div className="space-y-1">
                <div>{wgMod.reason} HyperProx never loads it for you. Run this on the node, then choose the machine again:</div>
                <pre className="whitespace-pre-wrap rounded border p-2 font-mono text-xs" style={{ borderColor: 'var(--border)' }}>{wgMod.fix}</pre>
              </div>
            </Notice>
          )}
          {wgMod && wgMod.ok === null && <Notice tone="warn">HyperProx could not check the wireguard module on this machine&apos;s node{wgMod.reason ? ` (${wgMod.reason})` : ''}, so it cannot create a server here. Add a node login (Settings → Setup checklist), or choose a VM.</Notice>}
          <div className="flex justify-end gap-2">
            <Btn kind="primary" disabled={wgMod?.ok !== true} onClick={async () => done(await send('/api/vpn/wg/servers', 'POST', { ...f, listenPort: Number((f.endpoint ?? '').split(':').pop()) || 51820 }), 'WireGuard server ready.')}>Create</Btn>
            <Btn onClick={() => setForm(null)}>Cancel</Btn>
          </div>
        </ConfirmDialog>
      )}

      {form && typeof form === 'object' && 'device' in form && (
        <ConfirmDialog title="Add a phone or laptop" onClose={() => setForm(null)}>
          <input style={FIELD} placeholder="Name, e.g. Pixel" value={f.name ?? ''} onChange={e => setF({ ...f, name: e.target.value })} />
          <p className="text-xs" style={{ color: 'var(--text-dim)' }}>The key is made in this browser and goes straight into the vault; if the browser cannot make one, the server container makes it.</p>
          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-soft)' }}>
            <input type="checkbox" checked={!!f.home} onChange={e => setF({ ...f, home: e.target.checked })} />
            Reach my whole home network (not only HyperProx)
          </label>
          <div className="flex justify-end gap-2">
            <Btn kind="primary" onClick={async () => {
              const k = await keys()
              const r = await send<{ config: string }>(`/api/vpn/wg/servers/${form.device}/devices`, 'POST', { name: f.name, reach: f.home ? 'home' : 'hyperprox', ...(k ?? { keygen: 'server' }) })
              if (done(r, `Added ${f.name}.`) && r?.body) setShown({ title: f.name, config: r.body.config })
            }}>Add</Btn>
            <Btn onClick={() => setForm(null)}>Cancel</Btn>
          </div>
        </ConfirmDialog>
      )}

      {form === 'router-device' && (
        <ConfirmDialog title={`Add a phone or laptop to ${f.iface}`} onClose={() => setForm(null)}>
          <input style={FIELD} placeholder="Name" value={f.name ?? ''} onChange={e => setF({ ...f, name: e.target.value })} />
          <input style={FIELD} placeholder="Its tunnel address, e.g. 100.64.20.10/32" value={f.address ?? ''} onChange={e => setF({ ...f, address: e.target.value })} />
          <input style={FIELD} placeholder="Router address for clients, e.g. home.example.com:13231" value={f.endpoint ?? ''} onChange={e => setF({ ...f, endpoint: e.target.value })} />
          <input style={FIELD} placeholder="Networks to reach, e.g. 100.64.20.0/24" value={f.allowed ?? ''} onChange={e => setF({ ...f, allowed: e.target.value })} />
          <div className="flex justify-end gap-2">
            <Btn kind="primary" onClick={async () => {
              const k = await keys()
              if (!k) { notice('crit', 'This browser cannot make WireGuard keys; use a current browser for router peers.'); return }
              const r = await send<{ config: string }>('/api/vpn/wg/router/devices', 'POST', { iface: f.iface, name: f.name, address: f.address, endpoint: f.endpoint, allowedIps: String(f.allowed ?? '').split(/[\s,]+/).filter(Boolean), ...k })
              if (done(r, `Added ${f.name} to the router.`) && r?.body) setShown({ title: f.name, config: r.body.config })
            }}>Add</Btn>
            <Btn onClick={() => setForm(null)}>Cancel</Btn>
          </div>
        </ConfirmDialog>
      )}

      {form === 'connect' && (
        <ConfirmDialog title="Connect a machine to WireGuard" onClose={() => setForm(null)}>
          <select style={FIELD} value={f.machineId ?? ''} onChange={e => { const id = e.target.value; setF({ ...f, machineId: id }); void checkModule(id) }}>
            <option value="">Choose a node or guest…</option>
            {guests.filter(m => m.running).map(m => <option key={m.id} value={m.id}>{m.name} ({m.id})</option>)}
          </select>
          <select style={FIELD} value={f.target ?? ''} onChange={e => setF({ ...f, target: e.target.value })}>
            <option value="">To…</option>
            {servers.map(s => <option key={s.id} value={`server:${s.id}`}>{nameOf(s.machineId)} · {s.iface}</option>)}
            {router?.interfaces.map(i => <option key={i.id} value={`router:${i.name}`} disabled={!router.writable}>Router · {i.name}{router.writable ? '' : ' (read-only)'}</option>)}
          </select>
          {String(f.target ?? '').startsWith('router:') && (
            <>
              <input style={FIELD} placeholder="Its tunnel address, e.g. 100.64.20.11/32" value={f.address ?? ''} onChange={e => setF({ ...f, address: e.target.value })} />
              <input style={FIELD} placeholder="Router address, e.g. 192.0.2.1:13231" value={f.endpoint ?? ''} onChange={e => setF({ ...f, endpoint: e.target.value })} />
            </>
          )}
          <input style={FIELD} placeholder="Networks it reaches through the tunnel, e.g. 100.64.10.0/24" value={f.allowed ?? ''} onChange={e => setF({ ...f, allowed: e.target.value })} />
          <input style={FIELD} placeholder="Site-to-site: the other side's subnets it reaches (optional)" value={f.remote ?? ''} onChange={e => setF({ ...f, remote: e.target.value })} />
          <input style={FIELD} placeholder="Site-to-site: its own subnets the other side may reach (optional)" value={f.sites ?? ''} onChange={e => setF({ ...f, sites: e.target.value })} />
          <p className="text-xs" style={{ color: 'var(--text-dim)' }}>The key is made on the machine and never leaves it. On a Proxmox node no default route goes through the tunnel, and what it routes may together cover at most a /8 outside the tunnel network (a declared other-side subnet excepted); nothing may overlap a cluster network, and the change is checked before and after and rolled back if anything else moved.</p>
          <div className="flex justify-end gap-2">
            <Btn kind="primary" onClick={async () => {
              const [kind, target] = String(f.target ?? '').split(':')
              const body = { allowedIps: String(f.allowed ?? '').split(/[\s,]+/).filter(Boolean), siteSubnets: String(f.sites ?? '').split(/[\s,]+/).filter(Boolean),
                remoteSubnets: String(f.remote ?? '').split(/[\s,]+/).filter(Boolean),
                ...(kind === 'server' ? { serverId: target } : { router: { iface: target, endpoint: f.endpoint, address: f.address } }) }
              done(await send(`/api/vpn/wg/machines/${encodeURIComponent(f.machineId ?? '')}/connect`, 'POST', body), 'Connected.')
            }}>Connect</Btn>
            <Btn onClick={() => setForm(null)}>Cancel</Btn>
          </div>
        </ConfirmDialog>
      )}

      {shown && <ConfigDialog title={shown.title} config={shown.config} onClose={() => setShown(null)} />}
    </Panel>
  )
}
