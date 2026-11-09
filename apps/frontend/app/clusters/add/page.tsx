'use client'

// Add a server: name and address, an admin token made on that server, the token pasted straight into the
// vault, and its certificate confirmed by comparing fingerprints. Then a hardware scan, before anything installs.

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { useClusters } from '@/lib/clusters'
import { INPUT, LABEL, Notice, CopyButton, BusyNote } from '@/components/vault/ui'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { HardwareScan } from '@/components/clusters/HardwareScan'

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border p-4 flex flex-col gap-3 min-w-0" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      <span className="font-mono font-bold" style={{ fontSize: 12, color: 'var(--accent)' }}>STEP {n}</span>
      <h2 className="font-display font-bold uppercase" style={{ fontSize: 19, letterSpacing: '0.04em', color: 'var(--text-bright)' }}>{title}</h2>
      {children}
    </section>
  )
}

const Code = ({ lines }: { lines: string[] }) => (
  <div className="flex flex-col gap-2">
    <pre className="rounded-lg p-3 overflow-x-auto font-mono text-xs" style={{ background: 'var(--ground-deep)', color: 'var(--text-bright)', border: '1px solid var(--border-dim)' }}>{lines.join('\n')}</pre>
    <div><CopyButton text={lines.join('\n')} label="Copy commands" /></div>
  </div>
)

interface Cert { fingerprint: string; subject: string; issuer: string; validFrom: string; validTo: string; altNames: string[] }

export default function AddServerPage() {
  const { role } = useSession()
  const router = useRouter()
  const { commands } = useClusters()
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [port, setPort] = useState('8006')
  const [note, setNote] = useState('')
  const [tokenId, setTokenId] = useState('hyperprox@pve!main')
  const [secret, setSecret] = useState('')
  const [cert, setCert] = useState<Cert | null>(null)
  const [matches, setMatches] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const [added, setAdded] = useState<{ id: string; name: string; nodes: string[]; version: string } | null>(null)

  // A different address or port means a different certificate: compare again.
  useEffect(() => { setCert(null); setMatches(false) }, [address, port])

  const readCert = async () => {
    setBusy('cert'); setErr(null)
    const r = await apiJson<{ data: Cert }>('/api/clusters/probe-certificate', 'POST', { address: address.trim(), port: Number(port) })
    setBusy(null)
    if (r.ok) setCert(r.body!.data); else setErr(r.error ?? 'Could not read the certificate')
  }

  const connect = async () => {
    setBusy('connect'); setErr(null)
    const r = await apiJson<{ data: { cluster: { id: string; name: string }; nodes: string[]; version: string } }>('/api/clusters', 'POST', {
      name: name.trim(), address: address.trim(), port: Number(port), note, tokenId: tokenId.trim(), tokenSecret: secret.trim(), fingerprint: cert?.fingerprint,
    })
    setBusy(null)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void connect()); return }
    if (!r.ok) { setErr(r.error ?? 'Could not add the server'); if (r.code === 'cert_changed') { setCert(null); setMatches(false) } return }
    setSecret('')
    const d = r.body!.data
    setAdded({ id: d.cluster.id, name: d.cluster.name, nodes: d.nodes, version: d.version })
  }

  if (!atLeast(role, 'admin')) return <div className="p-8"><Notice kind="warn">Adding a server needs the admin role.</Notice></div>

  const ready = name.trim() && address.trim() && /^\d+$/.test(port) && tokenId.trim() && secret.trim() && cert && matches

  return (
    <div className="min-h-full px-4 py-5 sm:p-8" style={{ background: 'var(--ground)' }}>
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const f = reconfirm; setReconfirm(null); f() }} />}
      <div className="max-w-3xl mx-auto flex flex-col gap-4">
        <Link href="/clusters" className="text-sm" style={{ color: 'var(--text-muted)' }}>‹ Command center</Link>
        <h1 className="font-display font-bold" style={{ fontSize: 34, lineHeight: 1.1, color: 'var(--text-bright)' }}>Add a server</h1>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          A standalone Proxmox server or a whole cluster, managed from here beside your home cluster. It is never joined to your cluster.
          The key goes straight into the vault and never touches a file.
        </p>

        {added ? (
          <section className="rounded-xl border p-4 flex flex-col gap-3" style={{ background: 'var(--surface)', borderColor: 'var(--remote)', borderTopWidth: 3 }}>
            <h2 className="font-display font-bold uppercase" style={{ fontSize: 19, color: 'var(--text-bright)' }}>{added.name} is connected</h2>
            <p className="text-sm" style={{ color: 'var(--text)' }}>Proxmox {added.version}, {added.nodes.length} {added.nodes.length === 1 ? 'node' : 'nodes'} ({added.nodes.join(', ')}). The token is in the vault and the certificate is pinned.</p>
            <h3 className="font-display font-semibold" style={{ fontSize: 17, color: 'var(--text-bright)' }}>What HyperProx can see on it</h3>
            <HardwareScan clusterId={added.id} kind="remote" />
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Nothing has been installed. Step 5 (monitoring) is on the server's Edit page: it needs a node login, then shows everything it would do before it does it.
            </p>
            <div className="flex gap-2 flex-wrap">
              <button onClick={() => router.push(`/clusters/${added.id}?tab=settings`)} className="px-4 rounded-md text-sm font-semibold" style={{ height: 38, background: 'var(--remote)', color: 'var(--remote-ink)' }}>Step 5: monitoring and node login</button>
              <button onClick={() => router.push(`/clusters/${added.id}`)} className="px-4 rounded-md text-sm border" style={{ height: 38, borderColor: 'var(--remote)', color: 'var(--remote)' }}>Open {added.name}</button>
            </div>
          </section>
        ) : (
          <>
            <Step n={1} title="Name and address">
              <div><label style={LABEL}>Name (shown on every page while it is open)</label><input style={INPUT} value={name} maxLength={60} placeholder="Remote server" onChange={e => setName(e.target.value)} /></div>
              <div className="grid gap-3" style={{ gridTemplateColumns: 'minmax(0,1fr) 7rem' }}>
                <div><label style={LABEL}>Address: its Tailscale name or IP, a WireGuard address, or any address HyperProx can reach</label><input style={INPUT} value={address} placeholder="pve1.example" onChange={e => setAddress(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} /></div>
                <div><label style={LABEL}>Port</label><input style={INPUT} value={port} inputMode="numeric" onChange={e => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))} /></div>
              </div>
              <div><label style={LABEL}>Note (optional)</label><input style={INPUT} value={note} maxLength={500} onChange={e => setNote(e.target.value)} /></div>
            </Step>

            <Step n={2} title="Make an admin key on that server">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                Paste these into that server's Shell (in its own Proxmox page: the node, then Shell). The key has full administrator rights,
                the same as you have at home. The last command prints the secret once: copy it for step 3.
              </p>
              <Code lines={commands.length ? commands : ['pveum user add hyperprox@pve --comment "HyperProx"', 'pveum aclmod / -user hyperprox@pve -role Administrator', 'pveum user token add hyperprox@pve main --privsep 0']} />
            </Step>

            <Step n={3} title="Paste the key">
              <div><label style={LABEL}>Token ID</label><input style={INPUT} value={tokenId} onChange={e => setTokenId(e.target.value)} autoCapitalize="none" spellCheck={false} /></div>
              <div><label style={LABEL}>Token secret (the "value" line)</label><input style={INPUT} type="password" autoComplete="off" value={secret} onChange={e => setSecret(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" /></div>
              <p className="text-sm font-semibold" style={{ color: 'var(--good)' }}>Saved to the vault when you press Connect. Not in a file, not in the database, not in the logs.</p>
            </Step>

            <Step n={4} title="Confirm it is really that server">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                HyperProx reads the certificate the server presents, without sending it anything. Compare it with the fingerprint on that server's own
                Proxmox page (the node, then System, then Certificates), or run this in its Shell:
              </p>
              <Code lines={['openssl x509 -noout -fingerprint -sha256 -in /etc/pve/local/pveproxy-ssl.pem 2>/dev/null || openssl x509 -noout -fingerprint -sha256 -in /etc/pve/local/pve-ssl.pem']} />
              <div><button disabled={!address.trim() || busy !== null} onClick={readCert} className="px-4 rounded-md text-sm border disabled:opacity-40" style={{ height: 38, borderColor: 'var(--border-strong)', color: 'var(--text)' }}>Read its certificate</button></div>
              {busy === 'cert' && <BusyNote>Reading the certificate…</BusyNote>}
              {cert && (
                <div className="flex flex-col gap-2">
                  <div className="font-mono text-sm break-all" style={{ color: 'var(--remote)' }}>{cert.fingerprint}</div>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>For {cert.altNames.join(', ') || cert.subject} · issued by {cert.issuer} · valid until {cert.validTo}</p>
                  <label className="flex gap-2 items-start text-sm" style={{ color: 'var(--text)' }}>
                    <input type="checkbox" checked={matches} onChange={e => setMatches(e.target.checked)} className="mt-1" />
                    <span>I compared it: it matches the fingerprint that server shows. HyperProx will refuse the connection if it ever changes.</span>
                  </label>
                </div>
              )}
              {err && <Notice kind="error">{err}</Notice>}
              <div><button disabled={!ready || busy !== null} onClick={connect} className="px-5 rounded-md text-sm font-bold disabled:opacity-40" style={{ height: 40, background: 'var(--accent)', color: 'var(--accent-ink)' }}>{busy === 'connect' ? 'Connecting…' : 'Connect'}</button></div>
            </Step>

            <Step n={5} title="Install monitoring on it">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>After Connect, HyperProx scans the server's hardware and shows you the result. Monitoring is then offered on its Edit page: it asks plain questions and shows every step before anything installs.</p>
            </Step>
          </>
        )}
      </div>
    </div>
  )
}
