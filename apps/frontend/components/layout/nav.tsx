// =============================================================================
//  HyperProx — the navigation map
//
//  One list feeds the side rail, the top bar's crumb and title, and the
//  "Find anything" palette, so a page added here appears in all three and a
//  rename cannot leave one of them behind.
// =============================================================================

import type { ReactNode } from 'react'

export interface NavItem {
  href: string
  label: string
  /** What else a person might type to find it in the palette. */
  keywords?: string
  icon: ReactNode
}

export interface NavGroup { section: string | null; items: NavItem[] }

const I = (d: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
)

export const NAV: NavGroup[] = [
  {
    section: null,
    items: [
      { href: '/dashboard', label: 'Dashboard', keywords: 'home overview', icon: I('M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z') },
      { href: '/clusters', label: 'Command center', keywords: 'clusters remote servers all', icon: I('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18') },
    ],
  },
  {
    section: 'Cluster',
    items: [
      { href: '/infrastructure', label: 'Infrastructure', keywords: 'nodes guests vms containers', icon: I('M3 4h18v6H3zM3 14h18v6H3zM7 7h.01M7 17h.01') },
      { href: '/storage', label: 'Storage', keywords: 'ceph disks pools nas backup', icon: I('M4 5c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3') },
      { href: '/monitoring', label: 'Monitoring', keywords: 'grafana prometheus metrics alerts', icon: I('M3 12h4l3-8 4 16 3-8h4') },
      { href: '/updates', label: 'Updates', keywords: 'packages apt upgrade', icon: I('M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5') },
      { href: '/ha', label: 'High availability', keywords: 'ha failover rules', icon: I('M12 3 4 7v5c0 5 3.4 8.5 8 9 4.6-.5 8-4 8-9V7zM9 12l2 2 4-4') },
    ],
  },
  {
    section: 'Network',
    items: [
      { href: '/certificates', label: 'Certificates', keywords: 'ssl tls acme', icon: I('M12 3 4 7v5c0 5 3.4 8.5 8 9 4.6-.5 8-4 8-9V7z') },
      { href: '/dns', label: 'DNS', keywords: 'domains records', icon: I('M4 7h16M4 12h16M4 17h10') },
      { href: '/proxy', label: 'Proxy', keywords: 'reverse proxy hosts nginx', icon: I('M5 12a2 2 0 1 0 0 .01M19 12a2 2 0 1 0 0 .01M7 12h10M12 6v3M12 15v3') },
      { href: '/vpn', label: 'VPN & remote access', keywords: 'wireguard tailscale remote access', icon: I('M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4') },
    ],
  },
  {
    // Websites have their own section: the sites, the New website wizard, adopting one already running, and metrics.
    section: 'Web',
    items: [
      { href: '/sites', label: 'Websites', keywords: 'sites wordpress static new website add existing metrics visitors', icon: I('M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0zM3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z') },
    ],
  },
  {
    section: 'Apps',
    items: [
      { href: '/plugins', label: 'Plug-ins', keywords: 'integrations', icon: I('M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5') },
      { href: '/catalogue', label: 'Catalogue', keywords: 'install apps', icon: I('M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3 7.5 12 12l9-4.5M12 12v9') },
      { href: '/terminal', label: 'Deck', keywords: 'terminal shell ssh console', icon: I('M3 4h18v16H3zM7 9l3 3-3 3M13 15h4') },
      { href: '/ai', label: 'AI assistant', keywords: 'chat ask', icon: I('M12 3v3M12 18v3M3 12h3M18 12h3M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z') },
    ],
  },
  {
    section: 'System',
    items: [
      { href: '/settings', label: 'Settings', keywords: 'vault users tokens notifications secrets setup', icon: I('M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z') },
    ],
  },
]

/** Pages that are not in the rail but still want a proper title, found by the palette too. */
export const EXTRA_PAGES: Array<{ href: string; label: string; section: string; keywords?: string }> = [
  { href: '/clusters/add', label: 'Add a server', section: 'Command center', keywords: 'remote cluster connect' },
  { href: '/catalogue/settings', label: 'Container ID rule', section: 'Catalogue', keywords: 'vmid numbering' },
  { href: '/settings/setup-checklist', label: 'Setup checklist', section: 'Settings', keywords: 'gpu exporter monitoring' },
  { href: '/settings/api-tokens', label: 'API tokens', section: 'Settings', keywords: 'keys automation' },
  { href: '/settings/naming', label: 'Naming & addresses', section: 'Settings', keywords: 'vmid ip range subnet dhcp vlan numbering convention' },
  { href: '/settings/notifications', label: 'Notifications', section: 'Settings', keywords: 'alerts email discord' },
  { href: '/settings/secrets', label: 'Secrets', section: 'Settings', keywords: 'vault passwords credentials' },
]

export function isActive(pathname: string, href: string): boolean {
  return pathname === href || (href !== '/dashboard' && pathname.startsWith(href + '/'))
}

/** The top bar's crumb and title for a path: the group it sits in, and the page's own name. */
export function pageMeta(pathname: string): { crumb: string; title: string } {
  const extra = EXTRA_PAGES.find(p => p.href === pathname)
  if (extra) return { crumb: extra.section, title: extra.label }
  if (/^\/clusters\/[^/]+\/updates$/.test(pathname)) return { crumb: 'Command center', title: 'Updates' }
  if (/^\/clusters\/[^/]+$/.test(pathname)) return { crumb: 'Command center', title: 'Cluster' }
  if (/^\/plugins\/[^/]+$/.test(pathname)) return { crumb: 'Plug-ins', title: 'Plug-in' }
  if (/^\/sites\/[^/]+$/.test(pathname)) return { crumb: 'Websites', title: 'Site metrics' }
  for (const g of NAV) {
    for (const it of g.items) {
      if (isActive(pathname, it.href)) return { crumb: g.section ?? 'Overview', title: it.label }
    }
  }
  return { crumb: 'HyperProx', title: 'HyperProx' }
}
