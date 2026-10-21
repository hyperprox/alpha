'use client'

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { apiJson, installAuthInterceptor, type AuthStatus, type Role } from '@/lib/api'

interface SessionValue {
  status:  AuthStatus | null
  role:    Role | undefined
  email:   string | undefined
  refresh: () => Promise<void>
}

const Ctx = createContext<SessionValue>({ status: null, role: undefined, email: undefined, refresh: async () => {} })

export const useSession = () => useContext(Ctx)

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const pathname = usePathname()

  useEffect(() => { installAuthInterceptor() }, [])

  const refresh = useCallback(async () => {
    const r = await apiJson<AuthStatus>('/api/auth/status')
    if (r.body && typeof r.body === 'object' && 'locked' in r.body) setStatus(r.body)
  }, [])

  // Re-read on every navigation: a lock or a role change elsewhere shows up on the next click.
  useEffect(() => { if (pathname !== '/login') refresh() }, [pathname, refresh])

  // Locked, or unlocked with no session of ours: the sign-in page is the only place to go.
  useEffect(() => {
    if (!status || pathname === '/login') return
    if (status.locked || !status.user) {
      const q = new URLSearchParams()
      if (status.locked) q.set('locked', '1')
      if (pathname !== '/') q.set('next', pathname)
      const qs = q.toString()
      window.location.assign('/login' + (qs ? `?${qs}` : ''))
    }
  }, [status, pathname])

  return (
    <Ctx.Provider value={{ status, role: status?.user?.role, email: status?.user?.email, refresh }}>
      {children}
    </Ctx.Provider>
  )
}
