'use client'

// =============================================================================
//  HyperProx — "Disconnect" in a plug-in's settings
//
//  A plug-in set up by its settings forgets them all (its vault item goes),
//  and the addresses it was set up for are remembered as disconnected, so
//  auto-connect does not add them straight back. It then shows as not set up
//  and leaves the dashboard. A plug-in with its own list of devices or
//  instances is removed one by one on its own page; this says where.
// =============================================================================

import { useState } from 'react'
import Link from 'next/link'

/** Plug-ins whose devices or instances are removed on their own page (the API refuses them here too). */
export const OWN_PAGE: Record<string, { words: string; href: string }> = {
  homepage: { words: 'Disconnect each dashboard on the Homepage page.', href: '/plugins/homepage' },
  nextcloud: { words: 'Remove each Nextcloud on the Nextcloud page.', href: '/plugins/nextcloud' },
  pbs: { words: 'Remove each backup server on the Proxmox Backup Server page.', href: '/plugins/pbs' },
  qnap: { words: 'Remove each NAS on the QNAP page.', href: '/plugins/qnap' },
  asus: { words: 'Remove each router on the ASUS page.', href: '/plugins/asus' },
  'home-assistant': { words: 'Remove each house on the Home Assistant page.', href: '/plugins/home-assistant' },
}

export function DisconnectPlugin({ plugin, onDisconnect }: {
  plugin: { id: string; name: string; configured: boolean; settings?: Array<{ isSet: boolean }> }
  /** Resolves null when it worked, or the error to show. */
  onDisconnect: () => Promise<string | null>
}) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const own = OWN_PAGE[plugin.id]
  // Something saved (set up, or half set up): it can be disconnected.
  if (!plugin.configured && !plugin.settings?.some(x => x.isSet)) return null
  if (own) {
    return (
      <p className="border-t px-6 py-3 text-[12.5px]" style={{ borderColor: 'var(--border)', color: 'var(--text-dimmer)' }}>
        To remove {plugin.name}: <Link href={own.href} style={{ color: 'var(--accent)' }}>{own.words}</Link>
      </p>
    )
  }
  const go = async () => {
    setBusy(true); setError(null)
    const e = await onDisconnect()
    setBusy(false)
    if (e) setError(e)
  }
  return (
    <div className="flex flex-col gap-2 border-t px-6 py-3" style={{ borderColor: 'var(--border)' }} aria-label={`Disconnect ${plugin.name}`}>
      {!asking ? (
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => setAsking(true)} className="rounded-md border px-3 text-sm" style={{ height: 34, borderColor: 'var(--border-strong)', color: 'var(--crit-soft, var(--crit))' }}>Disconnect</button>
          <small style={{ color: 'var(--text-dimmer)' }}>Forget its settings and keys. Nothing changes on the device itself.</small>
        </div>
      ) : (
        <div role="alertdialog" aria-label={`Disconnect ${plugin.name}?`} className="flex flex-col gap-2">
          <p className="text-sm" style={{ color: 'var(--text-soft)', margin: 0 }}>
            HyperProx forgets every {plugin.name} setting, and its saved keys leave the vault. {plugin.name} then shows as not set up and leaves the dashboard. HyperProx will not connect the same address again by itself; Connect again on this page does.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setAsking(false)} className="rounded-md border px-3 text-sm" style={{ height: 34, borderColor: 'var(--border-strong)', color: 'var(--text-soft)' }}>Cancel</button>
            <button type="button" disabled={busy} onClick={() => void go()} className="rounded-md px-3 text-sm font-semibold disabled:opacity-40" style={{ height: 34, background: 'var(--crit)', color: 'var(--accent-ink)' }}>{busy ? 'Disconnecting…' : `Disconnect ${plugin.name}`}</button>
          </div>
        </div>
      )}
      {error && <p className="text-sm" role="alert" style={{ color: 'var(--warn-2)', margin: 0 }}>{error}</p>}
    </div>
  )
}
