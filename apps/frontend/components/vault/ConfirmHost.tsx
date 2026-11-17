'use client'

// Mounted once (components/layout/AppShell.tsx). Shows the shared ConfirmDialog whenever the API asks for an action to be confirmed
// (lib/confirm-bus.ts); one at a time, in the order they were asked.

import { useEffect, useRef, useState } from 'react'
import { setConfirmAsker, type ConfirmRequest } from '@/lib/confirm-bus'
import { ConfirmDialog } from './ConfirmDialog'

interface Waiting { id: number; req: ConfirmRequest; answer: (yes: boolean) => void }
let nextId = 1

export function ConfirmHost() {
  const queue = useRef<Waiting[]>([])
  const [current, setCurrent] = useState<Waiting | null>(null)

  useEffect(() => setConfirmAsker(req => new Promise<boolean>(answer => {
    queue.current.push({ id: nextId++, req, answer })
    setCurrent(c => c ?? queue.current[0])
  })), [])

  function done(yes: boolean) {
    const w = queue.current.shift()
    w?.answer(yes)
    setCurrent(queue.current[0] ?? null)
  }

  if (!current) return null
  return <ConfirmDialog key={current.id} message={current.req.summary} onConfirm={() => done(true)} onCancel={() => done(false)} />
}
