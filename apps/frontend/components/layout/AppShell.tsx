'use client'

import { usePathname } from 'next/navigation'
import { Sidebar } from './Sidebar'
import { SessionProvider } from '@/lib/session'

/** The sign-in page stands alone: no navigation to a vault that is locked. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const bare = pathname === '/login'
  return (
    <SessionProvider>
      {!bare && <Sidebar />}
      <div className="flex-1 flex flex-col overflow-hidden">
        <main className={`${bare ? '' : 'hp-mobile-offset '}flex-1 overflow-y-auto`}>
          {children}
        </main>
      </div>
    </SessionProvider>
  )
}
