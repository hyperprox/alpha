'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

// ---------------------------------------------------------------------------
//  Nav items
// ---------------------------------------------------------------------------

const NAV = [
  {
    section: null,
    items: [
      { href: '/dashboard',      label: 'Dashboard',      icon: DashboardIcon },
      { href: '/infrastructure', label: 'Infrastructure', icon: InfraIcon },
    ],
  },
  {
    section: 'MANAGE',
    items: [
      { href: '/proxy',    label: 'Proxy',        icon: ProxyIcon    },
      { href: '/dns',      label: 'DNS',          icon: DNSIcon      },
      { href: '/storage',     label: 'Storage',      icon: StorageIcon     },
      { href: '/monitoring',   label: 'Monitoring',   icon: MonitoringIcon  },
    ],
  },
  {
    section: 'INTELLIGENCE',
    items: [
      { href: '/ai',       label: 'AI Assistant', icon: AIIcon       },
    ],
  },
  {
    section: 'SYSTEM',
    items: [
      { href: '/settings', label: 'Settings',     icon: SettingsIcon },
    ],
  },
]

// ---------------------------------------------------------------------------
//  Sidebar
// ---------------------------------------------------------------------------

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false)
  const pathname = usePathname()

  return (
    <aside
      className="flex flex-col border-r transition-all duration-300 ease-in-out flex-shrink-0"
      style={{
        width:       collapsed ? 56 : 220,
        background:  '#060a10',
        borderColor: '#0f1929',
      }}
    >
      {/* Logo */}
      <div
        className="flex items-center border-b px-3 flex-shrink-0"
        style={{ height: 56, borderColor: '#0f1929' }}
      >
        {collapsed ? (
          <div
            className="w-8 h-8 rounded flex items-center justify-center font-display font-bold text-sm cursor-pointer"
            style={{ background: '#00e5ff15', color: '#00e5ff', border: '1px solid #00e5ff30' }}
            onClick={() => setCollapsed(false)}
          >
            HP
          </div>
        ) : (
          <div className="flex items-center justify-between w-full">
            <span className="font-display text-lg font-light tracking-widest">
              HYPER<span className="font-bold" style={{ color: '#00e5ff' }}>PROX</span>
            </span>
            <button
              onClick={() => setCollapsed(true)}
              className="p-1 rounded transition-colors hover:bg-white/5"
              style={{ color: '#374151' }}
            >
              <CollapseIcon />
            </button>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-3 space-y-1">
        {NAV.map((group, gi) => (
          <div key={gi} className={gi > 0 ? 'mt-4' : ''}>
            {group.section && !collapsed && (
              <div
                className="px-3 pb-1 text-xs font-mono tracking-widest"
                style={{ color: '#1f2937', fontSize: 10 }}
              >
                {group.section}
              </div>
            )}
            {group.section && collapsed && <div className="my-2 mx-3 border-t" style={{ borderColor: '#0f1929' }} />}

            {group.items.map(item => {
              const active = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href))
              return (
                <Link key={item.href} href={item.href}>
                  <div
                    className="flex items-center gap-3 mx-2 rounded-md transition-all duration-150 cursor-pointer group"
                    style={{
                      padding:    collapsed ? '8px 10px' : '8px 10px',
                      background: active ? '#00e5ff12' : 'transparent',
                      border:     `1px solid ${active ? '#00e5ff25' : 'transparent'}`,
                      color:      active ? '#00e5ff' : '#4b5563',
                    }}
                    onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.color = '#9ca3af' }}
                    onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.color = '#4b5563' }}
                  >
                    <div className="flex-shrink-0 w-4 h-4" style={{ color: active ? '#00e5ff' : 'inherit' }}>
                      <item.icon />
                    </div>
                    {!collapsed && (
                      <span className="text-sm font-mono truncate" style={{ color: active ? '#00e5ff' : 'inherit' }}>
                        {item.label}
                      </span>
                    )}
                    {active && !collapsed && (
                      <div className="ml-auto w-1 h-4 rounded-full" style={{ background: '#00e5ff', boxShadow: '0 0 6px #00e5ff' }} />
                    )}
                  </div>
                </Link>
              )
            })}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div
        className="flex items-center border-t px-3 flex-shrink-0"
        style={{ height: 44, borderColor: '#0f1929' }}
      >
        {collapsed ? (
          <button
            onClick={() => setCollapsed(false)}
            className="w-8 h-8 flex items-center justify-center rounded transition-colors hover:bg-white/5"
            style={{ color: '#1f2937' }}
          >
            <ExpandIcon />
          </button>
        ) : (
          <div className="flex items-center gap-2 w-full">
            <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: '#22c55e', boxShadow: '0 0 4px #22c55e' }} />
            <span className="text-xs font-mono" style={{ color: '#1f2937' }}>{process.env.NEXT_PUBLIC_CLUSTER_NAME ?? 'My Cluster'}</span>
            <span className="text-xs font-mono ml-auto" style={{ color: '#111827' }}>v0.1.0</span>
          </div>
        )}
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
//  Icons — inline SVGs, 16x16
// ---------------------------------------------------------------------------


function InfraIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <rect x="1" y="10" width="4" height="5" rx="0.5" />
      <rect x="6" y="7" width="4" height="8" rx="0.5" />
      <rect x="11" y="4" width="4" height="11" rx="0.5" />
      <path d="M1 8l2-3 3 2 3-4 3-2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function DashboardIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <rect x="1" y="1" width="6" height="6" rx="1" />
      <rect x="9" y="1" width="6" height="6" rx="1" />
      <rect x="1" y="9" width="6" height="6" rx="1" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </svg>
  )
}

function ProxyIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <circle cx="3" cy="8" r="2" />
      <circle cx="13" cy="8" r="2" />
      <path d="M5 8h6" />
      <path d="M8 3v2M8 11v2" />
    </svg>
  )
}

function DNSIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 1.5c-2 2-3 4-3 6.5s1 4.5 3 6.5" />
      <path d="M8 1.5c2 2 3 4 3 6.5s-1 4.5-3 6.5" />
      <path d="M1.5 8h13" />
      <path d="M2 5h12M2 11h12" />
    </svg>
  )
}

function StorageIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <ellipse cx="8" cy="4" rx="6" ry="2" />
      <path d="M2 4v4c0 1.1 2.7 2 6 2s6-.9 6-2V4" />
      <path d="M2 8v4c0 1.1 2.7 2 6 2s6-.9 6-2V8" />
    </svg>
  )
}

function AIIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M8 2a3 3 0 0 1 3 3v1h1a2 2 0 0 1 0 4h-1v1a3 3 0 0 1-6 0v-1H4a2 2 0 0 1 0-4h1V5a3 3 0 0 1 3-3z" />
      <circle cx="6.5" cy="7" r=".5" fill="currentColor" />
      <circle cx="9.5" cy="7" r=".5" fill="currentColor" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" />
    </svg>
  )
}

function MonitoringIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <polyline points="1,11 4,7 7,9 10,4 13,6" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M1 14h14" strokeLinecap="round"/>
      <circle cx="13" cy="6" r="1.5" fill="currentColor" stroke="none"/>
    </svg>
  )
}

function CollapseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M9 2L4 7l5 5" />
    </svg>
  )
}

function ExpandIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M5 2l5 5-5 5" />
    </svg>
  )
}
