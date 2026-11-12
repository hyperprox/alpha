'use client'

// "Update available" in the top bar, when a newer HyperProx is on offer on this install's channel (or one is
// installing). It reads the last check's result (the API checks every few hours); it never starts one.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSession } from '@/lib/session'
import s from './shell.module.css'

interface Summary { available: { label: string; version: string | null } | null; updating: boolean }

export function UpdateChip() {
  const { status } = useSession()
  const signedIn = !!status?.user && !status.locked
  const [sum, setSum] = useState<Summary | null>(null)
  useEffect(() => {
    if (!signedIn) return
    let alive = true
    const read = () => fetch('/api/self-update/summary').then(r => (r.ok ? r.json() : null)).then(j => { if (alive && j) setSum(j) }).catch(() => undefined)
    read()
    const t = setInterval(read, 10 * 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [signedIn])
  if (!sum || (!sum.available && !sum.updating)) return null
  const text = sum.updating ? 'Updating HyperProx' : 'Update available'
  const title = sum.updating ? 'HyperProx is updating itself — see its progress' : `HyperProx ${sum.available!.label} is available`
  return (
    <Link href="/updates#hyperprox" className={s.updChip} data-state={sum.updating ? 'running' : 'available'} title={title}>
      <i aria-hidden />{text}
    </Link>
  )
}
