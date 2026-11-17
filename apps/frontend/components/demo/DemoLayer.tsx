'use client'

// =============================================================================
//  The demo layer: what the public demo adds on top of the real pages.
//
//    - A banner saying this is a demo with invented data, with links to the website and GitHub.
//    - When the demo API refuses a change (lib/api.ts raises an event for it), a friendly note:
//      nothing changes in the demo; install HyperProx to do it for real.
//    - A short guided tour on the first visit, which anyone can skip and start again from the banner.
//
//  It renders nothing unless the API says it is the demo (AuthStatus.demo).
// =============================================================================

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useSession } from '@/lib/session'
import { DEMO_REFUSED_EVENT } from '@/lib/api'
import { GhostButton, Modal, PrimaryButton } from '@/components/vault/ui'
import s from './demo.module.css'

const SITE = 'https://hyperprox.dev'
const GITHUB = 'https://github.com/hyperprox/alpha'
const INSTALL = `${SITE}/#install`
const TOUR_KEY = 'hyperprox-demo-tour'

const read = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const write = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private window: the tour just shows again */ } }

export function DemoBanner() {
  const { status } = useSession()
  if (!status?.demo) return null
  return (
    <div className={s.banner} role="note" aria-label="This is a demo">
      <b className={s.tag}>DEMO</b>
      <span className={s.text}>Invented data. Click anything: nothing you do here changes a thing.</span>
      <span className={s.links}>
        <button type="button" className={s.link} onClick={() => window.dispatchEvent(new CustomEvent('hyperprox:demo-tour'))}>Take the tour</button>
        <a className={s.link} href={INSTALL} target="_blank" rel="noopener noreferrer">Install</a>
        <a className={s.link} href={SITE} target="_blank" rel="noopener noreferrer">hyperprox.dev</a>
        <a className={s.link} href={GITHUB} target="_blank" rel="noopener noreferrer">GitHub</a>
      </span>
    </div>
  )
}

/** The refusal note and the tour. Mounted once, beside the pages. */
export function DemoLayer() {
  const { status } = useSession()
  if (!status?.demo) return null
  return <><RefusedNote /><Tour /></>
}

function RefusedNote() {
  const [open, setOpen] = useState(false)
  const last = useRef(0)
  useEffect(() => {
    const on = () => {
      // One note per click, even when a page fires several requests for it.
      if (Date.now() - last.current < 1500) return
      last.current = Date.now()
      setOpen(true)
    }
    window.addEventListener(DEMO_REFUSED_EVENT, on)
    return () => window.removeEventListener(DEMO_REFUSED_EVENT, on)
  }, [])
  if (!open) return null
  return (
    <Modal title="Nothing changes in the demo" onClose={() => setOpen(false)} top
      footer={<div className="flex gap-2 justify-end">
        <GhostButton type="button" onClick={() => setOpen(false)}>Keep exploring</GhostButton>
        <a className={s.installBtn} href={INSTALL} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}>Install HyperProx</a>
      </div>}>
      <p className="text-sm" style={{ color: 'var(--text-soft)', margin: 0 }}>
        In the demo nothing changes. Install HyperProx to do this for real: on your own cluster, this is
        where it would run, with the same checks and confirmations you just went through.
      </p>
    </Modal>
  )
}

// -- The tour -------------------------------------------------------------------------------------------

interface Step { target: string; title: string; body: string }
const STEPS: Step[] = [
  { target: 'section[aria-label="Cluster status"]', title: 'The verdict',
    body: 'One look says whether the cluster is fine: guests running, memory, quorum and storage health, and what needs you, in plain words.' },
  { target: '#hp-rail a[href="/plugins"]', title: 'Plug-ins',
    body: 'Your apps beside your nodes: who is streaming, what is downloading, which devices are offline. Every problem a plug-in finds comes with a button to fix it.' },
  { target: '#hp-rail a[href="/updates"]', title: 'Updates',
    body: 'Every node, guest and app in one tree: what is pending, what is a security fix, and what needs a reboot. Update one target or all of them, with a plan first.' },
  { target: '#hp-rail a[href="/balance"]', title: 'Load balancing',
    body: 'Where every guest runs and why. HyperProx proposes a plan to even the load out, checks each move first, and can do it on its own in quiet hours.' },
  { target: '[data-tour="vault"]', title: 'The vault',
    body: 'Every password and token lives in an encrypted vault that only unlocks with your master password. Important actions show what will happen and ask you to confirm. Try one: the confirmation is real, the change is not.' },
]

function Tour() {
  const pathname = usePathname()
  const router = useRouter()
  const [step, setStep] = useState<number | null>(null)
  const [rect, setRect] = useState<DOMRect | null>(null)

  // First visit: start on the dashboard once it has drawn. The banner's "Take the tour" starts it again.
  useEffect(() => {
    if (read(TOUR_KEY) || pathname !== '/dashboard') return
    const t = setTimeout(() => setStep(0), 1200)
    return () => clearTimeout(t)
  }, [pathname])
  useEffect(() => {
    const again = () => { if (pathname !== '/dashboard') router.push('/dashboard'); setTimeout(() => setStep(0), pathname === '/dashboard' ? 0 : 1200) }
    window.addEventListener('hyperprox:demo-tour', again)
    return () => window.removeEventListener('hyperprox:demo-tour', again)
  }, [pathname, router])

  const place = useCallback(() => {
    if (step === null) return
    const el = document.querySelector(STEPS[step].target) as HTMLElement | null
    const r = el?.getBoundingClientRect()
    // On a phone the menu is folded away: the card then sits at the bottom with nothing highlighted.
    setRect(r && r.width > 0 && r.height > 0 && window.innerWidth >= 760 ? r : null)
  }, [step])
  useLayoutEffect(() => {
    if (step === null) return
    const el = document.querySelector(STEPS[step].target) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [step, place])

  const end = useCallback(() => { write(TOUR_KEY, 'done'); setStep(null) }, [])
  useEffect(() => {
    if (step === null) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') end() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [step, end])

  if (step === null) return null
  const st = STEPS[step]
  const last = step === STEPS.length - 1
  // Beside the target when there is room on its right (the menu), else below it, else at the bottom.
  const card: React.CSSProperties = rect
    ? rect.right + 340 < window.innerWidth
      ? { left: rect.right + 14, top: Math.min(Math.max(12, rect.top - 8), window.innerHeight - 230) }
      : { left: Math.max(12, Math.min(rect.left, window.innerWidth - 352)), top: Math.min(rect.bottom + 12, window.innerHeight - 230) }
    : {}
  return (
    <div className={s.tourLayer}>
      {rect && <div className={s.spot} style={{ left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12 }} aria-hidden />}
      <div className={`${s.card} ${rect ? '' : s.cardDocked}`} style={card} role="dialog" aria-label={`Tour, step ${step + 1} of ${STEPS.length}: ${st.title}`}>
        <div className={s.cardHead}><span className={s.count}>{step + 1} / {STEPS.length}</span><b>{st.title}</b></div>
        <p className={s.cardBody}>{st.body}</p>
        <div className={s.cardFoot}>
          <button type="button" className={s.skip} onClick={end}>Skip the tour</button>
          <span className="flex gap-2">
            {step > 0 && <GhostButton type="button" onClick={() => setStep(step - 1)}>Back</GhostButton>}
            <PrimaryButton type="button" autoFocus onClick={() => last ? end() : setStep(step + 1)}>{last ? 'Start exploring' : 'Next'}</PrimaryButton>
          </span>
        </div>
      </div>
    </div>
  )
}
