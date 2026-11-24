'use client'

import { usePathname } from 'next/navigation'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { SessionProvider } from '@/lib/session'
import { DemoBanner, DemoLayer } from '@/components/demo/DemoLayer'
import { ConfirmHost } from '@/components/vault/ConfirmHost'
import { AiPanelProvider } from '@/components/ai/panel/PanelProvider'
import { AiPanel } from '@/components/ai/panel/AiPanel'
import s from './shell.module.css'

/** Pages that fill the whole window (the Deck's terminals) get the frame without the page padding or scroll. */
const FULL = ['/terminal']

/** The sign-in page stands alone: no navigation to a vault that is locked. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const bare = pathname === '/login' || pathname === '/join'
  const full = FULL.some(p => pathname === p || pathname.startsWith(p + '/'))
  if (bare) {
    return (
      <SessionProvider>
        <main className="flex-1 min-h-0 min-w-0 overflow-y-auto" style={{ height: '100dvh' }}>{children}</main>
      </SessionProvider>
    )
  }
  return (
    <SessionProvider>
      <AiPanelProvider>
      <div className={s.app}>
        <Sidebar />
        <div className={s.col}>
          <main id="main" className={`${s.main} ${full ? s.mainFull : ''}`}>
            <DemoBanner />
            <TopBar full={full} />
            <div className={`${s.content} ${full ? s.contentFull : ''}`}>{children}</div>
          </main>
        </div>
        {/* The AI panel, on every page: it keeps its conversation while the page changes (components/ai/panel). */}
        <AiPanel />
      </div>
      </AiPanelProvider>
      <DemoLayer />
      {/* The one confirmation dialog for every page (lib/confirm-bus.ts). */}
      <ConfirmHost />
    </SessionProvider>
  )
}
