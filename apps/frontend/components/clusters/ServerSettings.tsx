'use client'

// Edit a server: name and address, its certificate, its token, node addresses and logins, file roots, and
// removing it. Credentials go to the vault and are never shown back.

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'
import { type ClusterInfo } from '@/lib/clusters'
import { INPUT, LABEL, Notice, BusyNote, CopyButton } from '@/components/vault/ui'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border p-4 flex flex-col gap-3" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      <h2 className="font-display font-bold uppercase" style={{ fontSize: 17, letterSpacing: '0.04em', color: 'var(--text-bright)' }}>{title}</h2>
      {children}
    </section>
  )
}
const Btn = (p: React.ButtonHTMLAttributes<HTMLButtonElement> & { solid?: boolean }) => {
  const { solid, ...rest } = p
  return <button {...rest} className="px-4 rounded-md text-sm font-semibold disabled:opacity-40 border" style={{ height: 36, ...(solid ? { background: 'var(--remote)', color: 'var(--remote-ink)', borderColor: 'var(--remote)' } : { borderColor: 'var(--border-strong)', color: 'var(--text)' }) }} />
}

/** Run a call that may need the master password: the modal opens and the call is retried after. */
function useReconfirm() {
  const [pending, setPending] = useState<null | (() => void)>(null)
  const run = useCallback(async <T,>(fn: () => Promise<{ ok: boolean; status: number; code?: string } & T>, retry: () => void) => {
    const r = await fn()
    if (r.status === 403 && r.code === 'reconfirm_required') { setPending(() => retry); return null }
    return r
  }, [])
  const modal = pending ? <ReconfirmModal onClose={() => setPending(null)} onDone={() => { const f = pending; setPending(null); f() }} /> : null
  return { run, modal }
}

export function ServerSettings({ c, onChanged }: { c: ClusterInfo; onChanged: () => void }) {
  const router = useRouter()
  const remote = c.kind === 'remote'
  const { run, modal } = useReconfirm()
  const [name, setName] = useState(c.name)
  const [note, setNote] = useState(c.note)
  const [address, setAddress] = useState(c.address)
  const [port, setPort] = useState(String(c.port))
  const [roots, setRoots] = useState(c.allowedRoots.join('\n'))
  const [ignored, setIgnored] = useState((c.ignoredGuests ?? []).join('\n'))
  const [msg, setMsg] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)

  // Name and note are a plain edit; address, port and folders change where HyperProx connects or writes, so they
  // go to the re-confirmed connection route.
  const save = async (patch: Record<string, unknown>, done: string, connection = false) => {
    setMsg(null)
    const r = await run(() => apiJson<{ data: ClusterInfo; certNeedsConfirming?: boolean }>(connection ? `/api/clusters/${c.id}/connection` : `/api/clusters/${c.id}`, connection ? 'POST' : 'PATCH', patch), () => void save(patch, done, connection))
    if (!r) return
    if (!r.ok) { setMsg({ kind: 'error', text: (r as any).error ?? 'Not saved' }); return }
    setMsg({ kind: 'info', text: (r as any).body?.certNeedsConfirming ? `${done} The address changed, so confirm its certificate below before HyperProx sends it anything.` : done })
    onChanged()
  }

  return (
    <div className="flex flex-col gap-4">
      {modal}
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <Section title="Name and address">
        <div><label style={LABEL}>Name</label><input style={INPUT} value={name} maxLength={60} onChange={e => setName(e.target.value)} /></div>
        {remote && (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'minmax(0,1fr) 7rem' }}>
            <div><label style={LABEL}>Address</label><input style={INPUT} value={address} onChange={e => setAddress(e.target.value)} spellCheck={false} autoCapitalize="none" /></div>
            <div><label style={LABEL}>Port</label><input style={INPUT} value={port} inputMode="numeric" onChange={e => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))} /></div>
          </div>
        )}
        <div><label style={LABEL}>Note</label><input style={INPUT} value={note} maxLength={500} onChange={e => setNote(e.target.value)} /></div>
        <div><Btn onClick={async () => { await save({ name, note }, 'Saved.'); if (remote && (address !== c.address || Number(port) !== c.port)) await save({ address, port: Number(port) }, 'Address saved.', true) }}>Save</Btn></div>
      </Section>

      {remote && <CertificateSection c={c} onChanged={onChanged} run={run} />}
      {remote && <TokenSection c={c} run={run} />}
      <NodesSection c={c} onChanged={onChanged} run={run} />
      <PlexSection c={c} run={run} onChanged={onChanged} />

      <Section title="Folders files may be copied into">
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>One folder per line, for example the media share. A copy to this cluster can only write inside these. System folders are refused.</p>
        <textarea style={{ ...INPUT, height: 110, padding: 10, fontFamily: 'var(--font-mono)' }} value={roots} onChange={e => setRoots(e.target.value)} placeholder="/mnt/media" />
        <div><Btn onClick={() => save({ allowedRoots: roots.split('\n').map(s => s.trim()).filter(Boolean) }, 'File roots saved.', true)}>Save folders</Btn></div>
      </Section>

      {remote && (
        <Section title="Never look inside">
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Send files reads Plex's settings and library list inside this server's running containers that use shared folders. Containers listed here (by number, one per line or separated by commas) are never entered, and neither is any container tagged hyperprox-ignore.</p>
          <textarea style={{ ...INPUT, height: 70, padding: 10, fontFamily: 'var(--font-mono)' }} value={ignored} onChange={e => setIgnored(e.target.value)} placeholder="101" />
          <div><Btn onClick={() => save({ ignoredGuests: ignored.split(/[\s,]+/).map(s => s.trim()).filter(Boolean) }, 'Saved.', true)}>Save</Btn></div>
        </Section>
      )}

      {remote && <RemoveSection c={c} run={run} onRemoved={() => router.push('/clusters')} />}
    </div>
  )
}

type Run = <T>(fn: () => Promise<{ ok: boolean; status: number; code?: string } & T>, retry: () => void) => Promise<({ ok: boolean; status: number; code?: string } & T) | null>

function CertificateSection({ c, onChanged, run }: { c: ClusterInfo; onChanged: () => void; run: Run }) {
  const [state, setState] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  const [presented, setPresented] = useState<string | null>(null)
  const [why, setWhy] = useState<string | null>(null)
  const [matches, setMatches] = useState(false)
  const [busy, setBusy] = useState(false)
  // No certificate at this address yet: HyperProx verifies it itself over a private link; only when it cannot does it
  // show the fingerprint to compare, with the reason.
  const verify = async () => {
    setBusy(true); setState(null)
    const r = await run(() => apiJson<{ data: ClusterInfo }>(`/api/clusters/${c.id}/certificate`, 'POST', {}), () => void verify())
    setBusy(false)
    if (!r) return
    if (r.ok) { setState({ kind: 'info', text: 'Verified automatically. HyperProx accepts only this certificate from now on.' }); onChanged(); return }
    const b = (r as any).body ?? {}
    if (r.code === 'cert_manual' && b.certificate?.fingerprint) { setPresented(b.certificate.fingerprint); setWhy((r as any).error ?? null); return }
    setState({ kind: 'error', text: (r as any).error ?? 'Not verified' })
    if (r.code === 'cert_changed') setPresented(b.presented ?? null)
  }
  const check = async () => {
    setBusy(true); setState(null)
    if (!c.cert.fingerprint) { setBusy(false); return verify() }
    const r = await apiJson<{ data: { latencyMs: number; version: string } }>(`/api/clusters/${c.id}/test`, 'POST')
    setBusy(false)
    if (r.ok) setState({ kind: 'info', text: `Connected: Proxmox ${r.body!.data.version}, answered in ${r.body!.data.latencyMs} ms with the confirmed certificate.` })
    else { setState({ kind: 'error', text: r.error ?? 'Did not connect' }); if (r.code === 'cert_changed') setPresented((r.body as any)?.presented ?? null) }
  }
  const confirm = async () => {
    const r = await run(() => apiJson(`/api/clusters/${c.id}/certificate`, 'POST', { fingerprint: presented }), () => void confirm())
    if (!r) return
    if (r.ok) { setState({ kind: 'info', text: 'Confirmed. HyperProx accepts only this certificate from now on.' }); setPresented(null); setMatches(false); onChanged() }
    else setState({ kind: 'error', text: (r as any).error ?? 'Not confirmed' })
  }
  return (
    <Section title="Certificate">
      {c.cert.fingerprint ? (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{c.cert.verified ? `Verified automatically (${c.cert.verified})` : `Confirmed${c.cert.confirmedBy ? ` by ${c.cert.confirmedBy}` : ''}`}{c.cert.confirmedAt ? ` on ${new Date(c.cert.confirmedAt).toLocaleString()}` : ''}:<br /><span className="font-mono break-all" style={{ color: 'var(--remote)' }}>{c.cert.fingerprint}</span></p>
      ) : <Notice kind="warn">Not verified at this address yet. HyperProx sends this server nothing until its certificate is verified.</Notice>}
      <div><Btn disabled={busy} onClick={check}>{c.cert.fingerprint ? 'Test the connection' : 'Verify automatically'}</Btn></div>
      {busy && <BusyNote>Checking…</BusyNote>}
      {state && <Notice kind={state.kind}>{state.text}</Notice>}
      {presented && (
        <div className="flex flex-col gap-2">
          {why && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{why}</p>}
          <p className="text-sm" style={{ color: 'var(--text)' }}>It presents:</p>
          <div className="font-mono text-sm break-all" style={{ color: 'var(--remote)' }}>{presented}</div>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Compare it with that server's own page (the node, then System, then Certificates). If you did not renew its certificate, do not confirm: something else may be answering at that address.</p>
          <label className="flex gap-2 items-start text-sm" style={{ color: 'var(--text)' }}><input type="checkbox" className="mt-1" checked={matches} onChange={e => setMatches(e.target.checked)} /><span>I compared it and it matches.</span></label>
          <div><Btn solid disabled={!matches} onClick={confirm}>Confirm this certificate</Btn></div>
        </div>
      )}
    </Section>
  )
}

function TokenSection({ c, run }: { c: ClusterInfo; run: Run }) {
  const [tokenId, setTokenId] = useState(c.token?.id ?? 'hyperprox@pve!main')
  const [secret, setSecret] = useState('')
  const [state, setState] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  const replace = async () => {
    const r = await run(() => apiJson(`/api/clusters/${c.id}/token`, 'POST', { tokenId, tokenSecret: secret }), () => void replace())
    if (!r) return
    setState(r.ok ? { kind: 'info', text: 'The new token works and is in the vault.' } : { kind: 'error', text: (r as any).error ?? 'Not saved' })
    if (r.ok) setSecret('')
  }
  return (
    <Section title="Admin token">
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{c.token?.saved ? `In the vault: ${c.token.id}. The secret is never shown.` : c.token?.saved === false ? 'No token is saved.' : 'HyperProx is locked, so the vault cannot be read.'}</p>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(14rem,1fr))' }}>
        <div><label style={LABEL}>Token ID</label><input style={INPUT} value={tokenId} onChange={e => setTokenId(e.target.value)} spellCheck={false} /></div>
        <div><label style={LABEL}>New token secret</label><input style={INPUT} type="password" autoComplete="off" value={secret} onChange={e => setSecret(e.target.value)} /></div>
      </div>
      <div><Btn disabled={!secret.trim()} onClick={replace}>Test and replace the token</Btn></div>
      {state && <Notice kind={state.kind}>{state.text}</Notice>}
    </Section>
  )
}

interface NodeRow { node: string; status: string; address: string | null; login: boolean | null }

function NodesSection({ c, onChanged, run }: { c: ClusterInfo; onChanged: () => void; run: Run }) {
  const [rows, setRows] = useState<NodeRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [addrs, setAddrs] = useState<Record<string, string>>(c.nodeAddresses)
  const [login, setLogin] = useState<{ node: string; fp: string | null; user: string; pw: string; key: string; matches: boolean; msg: string | null } | null>(null)
  const [once, setOnce] = useState({ user: 'root', pw: '', key: '' })
  const [record, setRecord] = useState('')
  const [command, setCommand] = useState<string | null>(null)
  const [checked, setChecked] = useState<Array<{ node: string; state: string; how: string; login: string | null }> | null>(null)
  const [verifying, setVerifying] = useState(false)
  // One action: verify every node's host key with evidence, and save the login (if given) where a key is verified.
  const verifyKeys = async () => {
    setVerifying(true); setErr(null)
    const login = once.pw || once.key.trim() ? { username: once.user, ...(once.key.trim() ? { privateKey: once.key } : { password: once.pw }) } : undefined
    const r = await run(() => apiJson<{ data: { nodes: Array<{ node: string; state: string; how: string; login: string | null }>; command: string | null } }>(`/api/clusters/${c.id}/verify-keys`, 'POST', { login, ...(record.trim() ? { record } : {}) }), () => void verifyKeys())
    setVerifying(false)
    if (!r) return
    if (r.ok) { setChecked((r as any).body.data.nodes); setCommand((r as any).body.data.command ?? null); setRecord(''); setOnce(o => ({ ...o, pw: '', key: '' })); void load() } else setErr((r as any).error ?? 'Could not verify')
  }
  const load = useCallback(async () => {
    const r = await apiJson<{ data: NodeRow[] }>(`/api/clusters/${c.id}/nodes`)
    if (r.ok) { setRows(r.body!.data); setErr(null) } else setErr(r.error ?? 'Could not list the nodes')
  }, [c.id])
  useEffect(() => { void load() }, [load])

  const saveAddrs = async () => {
    const r = await run(() => apiJson<{ loginsCleared?: string[] }>(`/api/clusters/${c.id}/connection`, 'POST', { nodeAddresses: addrs }), () => void saveAddrs())
    if (!r) return
    const cleared = (r as any).body?.loginsCleared ?? []
    setErr(r.ok ? (cleared.length ? `Saved. ${cleared.join(', ')} changed address, so its saved login and host key were removed: press Verify keys (with the login) to set it up again.` : null) : (r as any).error ?? 'Not saved')
    if (r.ok) { onChanged(); void load() }
  }
  const readKey = async (node: string) => {
    setLogin({ node, fp: null, user: 'root', pw: '', key: '', matches: false, msg: null })
    const r = await apiJson<{ data: { fingerprint: string } }>(`/api/clusters/${c.id}/nodes/${encodeURIComponent(node)}/hostkey`, 'POST')
    setLogin(l => l && ({ ...l, fp: r.ok ? r.body!.data.fingerprint : null, msg: r.ok ? null : r.error ?? 'Could not read its host key' }))
  }
  const saveLogin = async () => {
    if (!login) return
    const body = { username: login.user, fingerprint: login.fp, ...(login.key.trim() ? { privateKey: login.key } : { password: login.pw }) }
    const r = await run(() => apiJson(`/api/clusters/${c.id}/nodes/${encodeURIComponent(login.node)}/login`, 'POST', body), () => void saveLogin())
    if (!r) return
    if (r.ok) { setLogin(null); void load() } else setLogin(l => l && ({ ...l, msg: (r as any).error ?? 'Not saved' }))
  }
  const removeLogin = async (node: string) => {
    const r = await run(() => apiJson(`/api/clusters/${c.id}/nodes/${encodeURIComponent(node)}/login`, 'DELETE'), () => void removeLogin(node))
    if (r?.ok) void load()
  }

  return (
    <Section title={c.kind === 'remote' ? 'Nodes and logins' : 'Node addresses for file copies'}>
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        {c.kind === 'remote'
          ? 'The address HyperProx reaches each node on (its private-link address: Tailscale or WireGuard), and a root login for the hardware scan, monitoring and file copies, kept in the vault. HyperProx verifies each node\'s host key by itself and sends the login only to a node whose key is verified.'
          : 'The private-link address (Tailscale or WireGuard) a remote server reaches each of your nodes on, for files sent to this cluster. Node logins for the home cluster are in Settings, Setup checklist.'}
      </p>
      {err && <Notice kind="error">{err}</Notice>}
      {c.kind === 'remote' && (
        <div className="flex flex-col gap-2">
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(12rem,1fr))' }}>
            <div><label style={LABEL}>Node login (optional; saved where a key is verified)</label><input style={INPUT} value={once.user} onChange={e => setOnce({ ...once, user: e.target.value })} /></div>
            <div><label style={LABEL}>Password</label><input style={INPUT} type="password" autoComplete="off" value={once.pw} onChange={e => setOnce({ ...once, pw: e.target.value })} /></div>
          </div>
          <details><summary className="text-sm cursor-pointer" style={{ color: 'var(--text-muted)' }}>Use a private key instead</summary>
            <textarea style={{ ...INPUT, height: 80, padding: 8, fontFamily: 'var(--font-mono)', fontSize: 12 }} value={once.key} onChange={e => setOnce({ ...once, key: e.target.value })} /></details>
          <div><Btn solid disabled={verifying} onClick={verifyKeys}>{verifying ? 'Verifying…' : 'Verify keys'}</Btn></div>
          {command && <div className="flex flex-col gap-2 text-sm">
            <span style={{ color: 'var(--text-muted)' }}>HyperProx had nothing trusted to check some keys against. Run this once in any of that server's node Shells and paste what it prints (public keys only), then Verify keys again:</span>
            <pre className="rounded p-2 overflow-x-auto font-mono text-xs" style={{ background: 'var(--ground-deep)', color: 'var(--text-bright)' }}>{command}</pre>
            <textarea style={{ ...INPUT, height: 70, padding: 8, fontFamily: 'var(--font-mono)', fontSize: 12 }} value={record} onChange={e => setRecord(e.target.value)} placeholder="Paste the output here" />
          </div>}
          {checked && <ul className="text-sm">{checked.map(x => <li key={x.node}><b>{x.node}</b>: {x.state === 'verified' || x.state === 'already' ? 'verified' : x.state === 'blocked' ? 'refused' : 'not verified'}{x.login === 'saved' ? ', login saved' : ''}. <span style={{ color: 'var(--text-muted)' }}>{x.how}</span></li>)}</ul>}
        </div>
      )}
      {rows === null ? <BusyNote>Reading nodes…</BusyNote> : rows.map(n => (
        <div key={n.node} className="rounded-lg border p-3 flex flex-col gap-2" style={{ borderColor: 'var(--border-dim)', background: 'var(--ground-deep)' }}>
          <div className="flex gap-2 items-center flex-wrap">
            <b className="font-display" style={{ fontSize: 16, color: 'var(--text-bright)' }}>{n.node}</b>
            <span className="text-xs" style={{ color: n.status === 'online' ? 'var(--good)' : 'var(--crit-soft)' }}>{n.status}</span>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{n.login ? 'login saved' : 'no login'}</span>
          </div>
          <input style={INPUT} value={addrs[n.node] ?? ''} placeholder="its private-link address" onChange={e => setAddrs(a => ({ ...a, [n.node]: e.target.value }))} spellCheck={false} />
          {c.kind === 'remote' && <div className="flex gap-2 flex-wrap">
            {n.address && !n.login && checked?.some(x => x.node === n.node && x.state === 'no-evidence') && <Btn onClick={() => readKey(n.node)}>Compare its key by hand</Btn>}
            {n.login && <Btn onClick={() => removeLogin(n.node)}>Remove login</Btn>}
          </div>}
          {login?.node === n.node && (
            <div className="flex flex-col gap-2">
              {login.fp === null && !login.msg && <BusyNote>Reading its host key…</BusyNote>}
              {login.fp && <>
                <p className="text-sm" style={{ color: 'var(--text)' }}>Its host key: <span className="font-mono break-all" style={{ color: 'var(--remote)' }}>{login.fp}</span></p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>HyperProx found no evidence to verify this node's key by itself, so compare it once with the output of this command in that node's Shell:</p>
                <div className="flex gap-2 items-center flex-wrap"><code className="font-mono text-xs" style={{ color: 'var(--text-bright)' }}>for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done</code><CopyButton text={'for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done'} /></div>
                <label className="flex gap-2 items-start text-sm" style={{ color: 'var(--text)' }}><input type="checkbox" className="mt-1" checked={login.matches} onChange={e => setLogin({ ...login, matches: e.target.checked })} /><span>One of those lines shows this exact fingerprint.</span></label>
                <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(12rem,1fr))' }}>
                  <div><label style={LABEL}>User</label><input style={INPUT} value={login.user} onChange={e => setLogin({ ...login, user: e.target.value })} /></div>
                  <div><label style={LABEL}>Password</label><input style={INPUT} type="password" autoComplete="off" value={login.pw} onChange={e => setLogin({ ...login, pw: e.target.value })} /></div>
                </div>
                <div><label style={LABEL}>Or a private key (instead of the password)</label><textarea style={{ ...INPUT, height: 80, padding: 8, fontFamily: 'var(--font-mono)', fontSize: 12 }} value={login.key} onChange={e => setLogin({ ...login, key: e.target.value })} /></div>
                <div className="flex gap-2"><Btn solid disabled={!login.matches || (!login.pw && !login.key.trim())} onClick={saveLogin}>Test and save the login</Btn><Btn onClick={() => setLogin(null)}>Cancel</Btn></div>
              </>}
              {login.msg && <Notice kind="error">{login.msg}</Notice>}
            </div>
          )}
        </div>
      ))}
      <div><Btn onClick={saveAddrs}>Save node addresses</Btn></div>
    </Section>
  )
}

function PlexSection({ c, run, onChanged }: { c: ClusterInfo; run: Run; onChanged: () => void }) {
  const [url, setUrl] = useState(c.plexUrl ?? '')
  const [token, setToken] = useState('')
  const [state, setState] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  const save = async () => {
    const r = await run(() => apiJson(`/api/clusters/${c.id}/plex`, 'POST', { url: url.trim() || null, token: token.trim() || undefined }), () => void save())
    if (!r) return
    setState(r.ok ? { kind: 'info', text: (r as any).body?.data?.tokenDropped ? 'Saved. The address moved to another host, so the old token was deleted: give this Plex\'s token too.' : 'Saved. The token is in the vault.' } : { kind: 'error', text: (r as any).error ?? 'Not saved' })
    if (r.ok) { setToken(''); onChanged() }
  }
  return (
    <Section title="Plex on this cluster (optional)">
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>So a finished copy can ask Plex to scan for the new titles. Its token goes to the vault.</p>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(14rem,1fr))' }}>
        <div><label style={LABEL}>Plex address</label><input style={INPUT} value={url} placeholder="http://10.0.0.5:32400" onChange={e => setUrl(e.target.value)} spellCheck={false} /></div>
        <div><label style={LABEL}>Plex token (leave empty to keep the saved one)</label><input style={INPUT} type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} /></div>
      </div>
      <div><Btn onClick={save}>Save Plex</Btn></div>
      {state && <Notice kind={state.kind}>{state.text}</Notice>}
    </Section>
  )
}

function RemoveSection({ c, run, onRemoved }: { c: ClusterInfo; run: Run; onRemoved: () => void }) {
  const [typed, setTyped] = useState('')
  const [done, setDone] = useState<string[] | null>(null)
  const [manual, setManual] = useState<Array<{ where: string; command: string }>>([])
  const [err, setErr] = useState<string | null>(null)
  const remove = async () => {
    const r = await run(() => apiJson<{ data: { cleanup: string[] } }>(`/api/clusters/${c.id}`, 'DELETE', { confirmName: typed }), () => void remove())
    if (!r) return
    if (r.ok) { setDone((r as any).body?.data?.cleanup ?? []); setManual((r as any).body?.data?.sendingKeysManual ?? []) } else setErr((r as any).error ?? 'Not removed')
  }
  return (
    <Section title="Remove this server from HyperProx">
      {done ? (
        <>
          <Notice kind="info">Removed. Its token and logins are gone from the vault. Nothing on that server was changed. To delete the token there too, run this in its Shell:</Notice>
          <pre className="rounded-lg p-3 overflow-x-auto font-mono text-xs" style={{ background: 'var(--ground-deep)', color: 'var(--text-bright)' }}>{done.join('\n')}</pre>
          {manual.length > 0 && <Notice kind="warn">HyperProx could not reach these nodes to take its sending keys off them. Run the command shown on each, as root:</Notice>}
          {manual.map((m, i) => <div key={i} className="text-xs"><b style={{ color: 'var(--text)' }}>{m.where}</b><pre className="rounded p-2 mt-1 overflow-x-auto font-mono" style={{ background: 'var(--ground-deep)', color: 'var(--text-bright)' }}>{m.command}</pre></div>)}
          <div><Btn onClick={onRemoved}>Back to the Command center</Btn></div>
        </>
      ) : (
        <>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>HyperProx forgets it: its token, logins, sending keys (taken off the nodes they were installed on) and its Prometheus targets. Nothing else on the server changes: monitoring installed there stays until you remove it first.</p>
          <div><label style={LABEL}>Type <b style={{ color: 'var(--text-bright)' }}>{c.name}</b> to remove it</label><input style={INPUT} value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" /></div>
          <div><button disabled={typed !== c.name} onClick={remove} className="px-4 rounded-md text-sm font-semibold disabled:opacity-40" style={{ height: 36, background: 'var(--crit)', color: '#fff' }}>Remove</button></div>
          {err && <Notice kind="error">{err}</Notice>}
        </>
      )}
    </Section>
  )
}
