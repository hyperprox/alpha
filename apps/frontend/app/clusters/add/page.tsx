'use client'

// Add a server: name and address, an admin token made on that server, the token pasted straight into the vault,
// and (optionally) the nodes' login, then one Connect under one master password. HyperProx verifies the certificate
// and every node's host key by itself where it has evidence (Tailscale, WireGuard, the cluster's own record), saves
// the login where a key is verified, installs monitoring and checks Send files. Only when it has no evidence for the
// certificate does it show the fingerprint to compare. Then a hardware scan.

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
interface Setup { certificate: string; nodes: Array<{ node: string; key: string; how: string; login: string }>; monitoring: string | null; sending: string | null }

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
  const [why, setWhy] = useState<string | null>(null)
  const [matches, setMatches] = useState(false)
  const [nodeUser, setNodeUser] = useState('root')
  const [nodePw, setNodePw] = useState('')
  const [nodeKey, setNodeKey] = useState('')
  const [monitoring, setMonitoring] = useState(true)
  const [sending, setSending] = useState(true)
  const [setup, setSetup] = useState<Setup | null>(null)
  const [preview, setPreview] = useState<{ certificate: Cert; connectingTo: { device: string; owner: string | null } | null; why: string | null; monitoring: string[]; hash: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const [added, setAdded] = useState<{ id: string; name: string; nodes: string[]; version: string } | null>(null)

  // A different address or port means a different certificate: any manual compare starts again.
  useEffect(() => { setCert(null); setWhy(null); setMatches(false); setPreview(null) }, [address, port])

  // Before the password: what is at that address and what would be installed, shown in the same form. Reads only:
  // no token, no login. Connect sends back its hash, so nothing different from what is shown here can be done.
  useEffect(() => {
    const a = address.trim()
    if (!a || !/^\d+$/.test(port)) return
    const t = setTimeout(async () => {
      const r = await apiJson<{ data: { certificate: Cert; connectingTo: { device: string; owner: string | null } | null; why: string | null; monitoring: string[]; hash: string } }>('/api/clusters/add-preview', 'POST', { address: a, port: Number(port) })
      if (!r.ok) return
      const d = r.body!.data
      setPreview(d)
      if (!d.connectingTo) { setCert(d.certificate); setWhy(d.why) }
    }, 700)
    return () => clearTimeout(t)
  }, [address, port])

  const connect = async () => {
    setBusy('connect'); setErr(null)
    const login = nodePw || nodeKey.trim() ? { username: nodeUser.trim(), ...(nodeKey.trim() ? { privateKey: nodeKey } : { password: nodePw }) } : undefined
    const r = await apiJson<{ data: { cluster: { id: string; name: string }; nodes: string[]; version: string; setup: Setup } }>('/api/clusters', 'POST', {
      name: name.trim(), address: address.trim(), port: Number(port), note, tokenId: tokenId.trim(), tokenSecret: secret.trim(),
      ...(cert && matches ? { fingerprint: cert.fingerprint } : {}), login, monitoring, sending, previewHash: preview?.hash,
    })
    setBusy(null)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void connect()); return }
    if (!r.ok) {
      // No evidence for the certificate: show it, say why in one sentence, and let the owner compare it once.
      if (r.code === 'cert_manual' && (r.body as any)?.certificate) { setCert((r.body as any).certificate); setWhy(r.error ?? null); setMatches(false); return }
      setErr(r.error ?? 'Could not add the server')
      if (r.code === 'cert_changed') { setCert(null); setMatches(false) }
      return
    }
    setSecret(''); setNodePw(''); setNodeKey('')
    const d = r.body!.data
    setSetup(d.setup ?? null)
    setAdded({ id: d.cluster.id, name: d.cluster.name, nodes: d.nodes, version: d.version })
  }

  if (!atLeast(role, 'admin')) return <div className="p-8"><Notice kind="warn">Adding a server needs the admin role.</Notice></div>

  const ready = name.trim() && address.trim() && /^\d+$/.test(port) && tokenId.trim() && secret.trim() && preview && (!cert || matches)

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
            {setup && (
              <ul className="text-sm flex flex-col gap-1" style={{ color: 'var(--text)' }}>
                <li>{setup.certificate}</li>
                {setup.nodes.map(n => <li key={n.node}><b>{n.node}</b>: {n.key === 'verified' || n.key === 'already' ? 'host key verified' : n.key === 'blocked' ? 'host key refused' : 'host key not verified yet'}{n.login === 'saved' ? ', login saved' : ''}. <span style={{ color: 'var(--text-muted)' }}>{n.how}</span></li>)}
                {setup.monitoring && <li>{setup.monitoring}</li>}
                {setup.sending && <li>{setup.sending}</li>}
              </ul>
            )}
            <h3 className="font-display font-semibold" style={{ fontSize: 17, color: 'var(--text-bright)' }}>What HyperProx can see on it</h3>
            <HardwareScan clusterId={added.id} kind="remote" />
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Anything left (a node whose key had no evidence, monitoring without a login) is on the server's Edit page.
            </p>
            <div className="flex gap-2 flex-wrap">
              <button onClick={() => router.push(`/clusters/${added.id}?tab=settings`)} className="px-4 rounded-md text-sm font-semibold" style={{ height: 38, background: 'var(--remote)', color: 'var(--remote-ink)' }}>Edit page</button>
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

            <Step n={4} title="Sign in to its nodes, once (optional)">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                The login you use for SSH on that server's nodes, usually root. HyperProx checks each node's identity by itself and sends the login only to a node it has verified, then keeps it in the vault.
                Leave it empty to add the server without node work.
              </p>
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(12rem,1fr))' }}>
                <div><label style={LABEL}>User</label><input style={INPUT} value={nodeUser} onChange={e => setNodeUser(e.target.value)} autoCapitalize="none" spellCheck={false} /></div>
                <div><label style={LABEL}>Password</label><input style={INPUT} type="password" autoComplete="off" value={nodePw} onChange={e => setNodePw(e.target.value)} /></div>
              </div>
              <details><summary className="text-sm cursor-pointer" style={{ color: 'var(--text-muted)' }}>Use a private key instead</summary>
                <textarea style={{ ...INPUT, height: 90, padding: 8, fontFamily: 'var(--font-mono)', fontSize: 12 }} value={nodeKey} onChange={e => setNodeKey(e.target.value)} /></details>
              <label className="flex gap-2 items-start text-sm" style={{ color: 'var(--text)' }}><input type="checkbox" className="mt-1" checked={monitoring} onChange={e => setMonitoring(e.target.checked)} /><span>Install monitoring on its nodes{preview ? `: ${preview.monitoring.join(' ')}` : ' (node_exporter only; nothing is upgraded or removed)'}</span></label>
              <label className="flex gap-2 items-start text-sm" style={{ color: 'var(--text)' }}><input type="checkbox" className="mt-1" checked={sending} onChange={e => setSending(e.target.checked)} /><span>Check that Send files can reach it</span></label>
              {cert && (
                <div className="flex flex-col gap-2 rounded-lg border p-3" style={{ borderColor: 'var(--warn)' }}>
                  {why && <p className="text-sm" style={{ color: 'var(--text)' }}>{why}</p>}
                  <div className="font-mono text-sm break-all" style={{ color: 'var(--remote)' }}>{cert.fingerprint}</div>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>For {cert.altNames.join(', ') || cert.subject} · issued by {cert.issuer} · valid until {cert.validTo}. In its Shell:</p>
                  <Code lines={['openssl x509 -noout -fingerprint -sha256 -in /etc/pve/local/pveproxy-ssl.pem 2>/dev/null || openssl x509 -noout -fingerprint -sha256 -in /etc/pve/local/pve-ssl.pem']} />
                  <label className="flex gap-2 items-start text-sm" style={{ color: 'var(--text)' }}>
                    <input type="checkbox" checked={matches} onChange={e => setMatches(e.target.checked)} className="mt-1" />
                    <span>I compared it: it matches the fingerprint that server shows. HyperProx will refuse the connection if it ever changes.</span>
                  </label>
                </div>
              )}
              {preview?.connectingTo && <p className="text-sm font-semibold" style={{ color: 'var(--good)' }}>Connecting to {preview.connectingTo.device}{preview.connectingTo.owner ? ` owned by ${preview.connectingTo.owner}` : ''}.</p>}
              {err && <Notice kind="error">{err}</Notice>}
              <div><button disabled={!ready || busy !== null} onClick={connect} className="px-5 rounded-md text-sm font-bold disabled:opacity-40" style={{ height: 40, background: 'var(--accent)', color: 'var(--accent-ink)' }}>{busy === 'connect' ? 'Connecting and setting up…' : 'Connect'}</button></div>
              {busy === 'connect' && <BusyNote>Checking the certificate, the token and each node. This can take a minute.</BusyNote>}
            </Step>
          </>
        )}
      </div>
    </div>
  )
}
