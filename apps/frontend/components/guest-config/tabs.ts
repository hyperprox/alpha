// The guest drill-down's tabs, as a registry: a later package adds its tab here without touching the page.
// `when` hides a tab that does not apply (or that the role cannot use).

import type { GuestRow } from './types'

export interface TabDef {
  id: string
  label: string
  when?: (g: GuestRow, ctx: { canOperate: boolean; canAdmin: boolean }) => boolean
}

export const GUEST_TABS: TabDef[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'config', label: 'Config' },
  { id: 'network', label: 'Network' },
  { id: 'devices', label: 'GPU & devices' },
  { id: 'ha', label: 'High availability' },
  { id: 'snapshots', label: 'Snapshots' },
  { id: 'console', label: 'Console', when: (_g, c) => c.canOperate },
  { id: 'history', label: 'History' },
  { id: 'vpn', label: 'VPN' },
]
