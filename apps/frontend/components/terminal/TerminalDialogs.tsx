'use client'

// =============================================================================
//  HyperProx — Terminal dialogs: saving a login, adding a host, naming a layout
//
//  Each dialog's <form> wraps the whole panel including the footer, so the
//  submit button is a plain in-form button. An earlier version put the button
//  outside the form and associated it with form="…", which silently submitted
//  nothing — the dialog looked like it saved and no request was ever made.
// =============================================================================

import { useState } from 'react'

const PANEL  = { background: '#0d1220', borderColor: '#0f1929' }
const FIELD  = { background: '#080c14', borderColor: '#16233a', color: '#e2e8f0' }
const ACCENT = '#00e5ff'

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="block font-display text-[11px] uppercase tracking-[0.14em] mb-1.5" style={{ color: '#6b7280' }}>
      {children}
    </span>
  )
}

function Field(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="w-full rounded border px-2.5 py-1.5 font-mono text-[13px] outline-none focus:border-cyan transition-colors"
      style={FIELD}
    />
  )
}

function Shell({ title, subtitle, submitLabel = 'Save', onSubmit, onClose, children }: {
  title: string
  subtitle: string
  submitLabel?: string
  onSubmit: (e: React.FormEvent) => void
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'rgba(4,7,12,0.78)' }}>
      <form onSubmit={onSubmit} className="w-full max-w-md rounded-lg border shadow-2xl" style={PANEL}>
        <div className="border-b px-5 py-3.5" style={{ borderColor: '#0f1929' }}>
          <h2 className="font-display text-base font-semibold tracking-wide text-white">{title}</h2>
          <p className="mt-0.5 font-mono text-[11px]" style={{ color: '#6b7280' }}>{subtitle}</p>
        </div>

        <div className="px-5 py-4">{children}</div>

        <div className="flex justify-end gap-2 border-t px-5 py-3" style={{ borderColor: '#0f1929' }}>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 font-display text-sm tracking-wide transition-colors hover:bg-white/5"
            style={{ color: '#9ca3af' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded px-4 py-1.5 font-display text-sm font-semibold tracking-wide transition-opacity hover:opacity-85"
            style={{ background: ACCENT, color: '#04202a' }}
          >
            {submitLabel}
          </button>
        </div>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
//  Credentials
// ---------------------------------------------------------------------------

export interface CredentialDraft {
  username: string; port: number; address: string; password?: string
  privateKey?: string; passphrase?: string; alsoShared?: boolean
}

export function ConnectDialog({ hostName, hostAddress, hasShared, onSave, onClose }: {
  hostName: string
  hostAddress: string
  hasShared: boolean
  onSave: (draft: CredentialDraft) => void
  onClose: () => void
}) {
  const [address,    setAddress]    = useState(hostAddress)
  const [username,   setUsername]   = useState('root')
  const [port,       setPort]       = useState('22')
  const [mode,       setMode]       = useState<'password' | 'key'>('password')
  const [password,   setPassword]   = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [alsoShared, setAlsoShared] = useState(false)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave({
      username: username.trim(),
      address:  address.trim(),
      port:     Number(port) || 22,
      ...(mode === 'key' ? { privateKey, passphrase } : { password }),
      alsoShared,
    })
  }

  return (
    <Shell
      title={`Sign in to ${hostName}`}
      subtitle="Stored encrypted. Never sent back to the browser."
      onSubmit={submit}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3.5">
        <div className="grid grid-cols-[1fr_88px] gap-3">
          <div>
            <Label>Address</Label>
            <Field value={address} onChange={e => setAddress(e.target.value)} placeholder="192.168.1.20" required />
          </div>
          <div>
            <Label>Port</Label>
            <Field value={port} onChange={e => setPort(e.target.value)} inputMode="numeric" />
          </div>
        </div>

        <div>
          <Label>Username</Label>
          <Field value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" required />
        </div>

        <div className="flex gap-1 rounded border p-0.5" style={{ borderColor: '#16233a' }}>
          {(['password', 'key'] as const).map(m => (
            <button key={m} type="button" onClick={() => setMode(m)}
              className="flex-1 rounded py-1 font-display text-xs uppercase tracking-[0.12em] transition-colors"
              style={mode === m ? { background: '#00e5ff15', color: ACCENT } : { color: '#4b5563' }}
            >
              {m === 'password' ? 'Password' : 'Private key'}
            </button>
          ))}
        </div>

        {mode === 'password' ? (
          <div>
            <Label>Password</Label>
            <Field type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" />
          </div>
        ) : (
          <>
            <div>
              <Label>Private key</Label>
              <textarea
                value={privateKey} onChange={e => setPrivateKey(e.target.value)} rows={4}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                className="w-full rounded border px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-cyan"
                style={FIELD}
              />
            </div>
            <div>
              <Label>Passphrase — if the key has one</Label>
              <Field type="password" value={passphrase} onChange={e => setPassphrase(e.target.value)} />
            </div>
          </>
        )}

        <label className="flex cursor-pointer items-start gap-2.5 rounded border px-3 py-2.5" style={{ borderColor: '#16233a' }}>
          <input type="checkbox" checked={alsoShared} onChange={e => setAlsoShared(e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 accent-cyan" />
          <span className="text-[12px] leading-snug" style={{ color: '#9ca3af' }}>
            Also use this for every host that has none of its own
            <span className="mt-0.5 block font-mono text-[11px]" style={{ color: alsoShared && hasShared ? '#f59e0b' : '#4b5563' }}>
              {alsoShared && hasShared
                ? 'This REPLACES the current shared login, which every other host relies on.'
                : 'Leave this off unless you mean to change the fallback for every host.'}
            </span>
          </span>
        </label>
      </div>
    </Shell>
  )
}

// ---------------------------------------------------------------------------
//  Manual hosts — anything with SSH, whether Proxmox knows about it or not
// ---------------------------------------------------------------------------

export function AddHostDialog({ onSave, onClose }: {
  onSave: (host: { name: string; address: string; port: number }) => void
  onClose: () => void
}) {
  const [name,    setName]    = useState('')
  const [address, setAddress] = useState('')
  const [port,    setPort]    = useState('22')

  return (
    <Shell
      title="Add a host"
      subtitle="A router, a NAS, a laptop, a VPS — anything reachable over SSH."
      submitLabel="Add"
      onSubmit={e => { e.preventDefault(); onSave({ name: name.trim(), address: address.trim(), port: Number(port) || 22 }) }}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3.5">
        <div>
          <Label>Name</Label>
          <Field value={name} onChange={e => setName(e.target.value)} placeholder="edge-router" required />
        </div>
        <div className="grid grid-cols-[1fr_88px] gap-3">
          <div>
            <Label>Address</Label>
            <Field value={address} onChange={e => setAddress(e.target.value)} placeholder="192.168.1.1" required />
          </div>
          <div>
            <Label>Port</Label>
            <Field value={port} onChange={e => setPort(e.target.value)} inputMode="numeric" />
          </div>
        </div>
      </div>
    </Shell>
  )
}

// ---------------------------------------------------------------------------
//  Saving an arrangement
// ---------------------------------------------------------------------------

export function SaveLayoutDialog({ paneCount, existing, onSave, onClose }: {
  paneCount: number
  existing: string[]
  onSave: (name: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const clash = existing.includes(name.trim())

  return (
    <Shell
      title="Save this arrangement"
      subtitle={`${paneCount} pane${paneCount === 1 ? '' : 's'}, and how they are laid out.`}
      onSubmit={e => { e.preventDefault(); onSave(name.trim()) }}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3.5">
        <div>
          <Label>Name</Label>
          <Field value={name} onChange={e => setName(e.target.value)} placeholder="TitanCoder" required autoFocus />
        </div>
        <p className="font-mono text-[11px] leading-relaxed" style={{ color: clash ? '#f59e0b' : '#4b5563' }}>
          {clash
            ? `"${name.trim()}" already exists — saving replaces it.`
            : 'Reopening a layout restores these hosts. The sessions live in tmux on each host, so they are still running when you come back.'}
        </p>
      </div>
    </Shell>
  )
}
