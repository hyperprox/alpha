'use client'

import type { ReactNode } from 'react'
import { Panel as KitPanel } from '@/components/visual/kit'

/**
 * The remote-access pages' panel: the old `title` / `right` shape on top of the kit's panel, so the VPN and
 * WireGuard parts get the HUD look without each call site changing. `right` becomes the panel's actions.
 */
export function Panel({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return <KitPanel title={title} actions={right}>{children}</KitPanel>
}

/** An empty-state line; the panel already pads. */
export function Empty({ children }: { children: ReactNode }) {
  return <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.9rem' }}>{children}</p>
}
