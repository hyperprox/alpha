'use client'

// =============================================================================
//  HyperProx — the AI side panel's state
//
//  Lives in the app shell, above every page, so the conversation, the open/closed state and the width all survive
//  moving between pages. Open, closed and width are remembered per person in this browser; the conversation is kept for
//  the browser session. The panel asks the operator (/api/ai/operator/ask): it answers and proposes, and never acts.
// =============================================================================

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import type { OperatorResult, Spend, Tier } from '@/lib/operator-view'
import {
  PANEL_DEFAULT, PHONE_MAX, clampWidth, composeQuestion, itemForApi, pageLabel, parsePrefs, prefsKey,
  type PanelItem, type PanelPrefs,
} from '@/lib/ai-panel'

export type PanelTab = 'ask' | 'assistant'

export interface Msg {
  id: string
  role: 'user' | 'assistant'
  /** What the person typed, or for an answer a short line when it has no result (an error). */
  text: string
  result?: OperatorResult
  /** The full question as sent (with its page line): a retry or an approval sends exactly this again. */
  full?: string
  item?: PanelItem | null
  page?: string
  /** The Opus approval or the retry button was used: it is not offered again. */
  used?: boolean
}

export interface Pending { startedAt: number; tier: Tier | null }

interface PanelCtx {
  prefs: PanelPrefs
  setOpen: (open: boolean) => void
  setWidth: (w: number) => void
  isPhone: boolean
  sheetOpen: boolean
  setSheetOpen: (o: boolean) => void
  tab: PanelTab
  setTab: (t: PanelTab) => void
  /** Open the panel (the sheet on a phone) on a tab. */
  openPanel: (t?: PanelTab) => void
  page: string
  item: PanelItem | null
  askAbout: (item: PanelItem) => void
  clearItem: () => void
  focusTick: number
  messages: Msg[]
  pending: Pending | null
  canAsk: boolean
  force: 'auto' | Tier
  setForce: (f: 'auto' | Tier) => void
  spend: Spend | null
  send: (text: string) => Promise<void>
  approve: (m: Msg) => Promise<void>
  retry: (m: Msg, tier: Tier) => Promise<void>
  clear: () => void
}

const Ctx = createContext<PanelCtx | null>(null)

const NOOP: PanelCtx = {
  prefs: { open: false, width: PANEL_DEFAULT }, setOpen: () => {}, setWidth: () => {}, isPhone: false, sheetOpen: false, setSheetOpen: () => {},
  tab: 'ask', setTab: () => {}, openPanel: () => {}, page: '', item: null, askAbout: () => {}, clearItem: () => {}, focusTick: 0,
  messages: [], pending: null, canAsk: false, force: 'auto', setForce: () => {}, spend: null,
  send: async () => {}, approve: async () => {}, retry: async () => {}, clear: () => {},
}

/** The panel's state. Outside the shell (in a test, on the sign-in page) it is inert, so a page can always call it. */
export const useAiPanel = (): PanelCtx => useContext(Ctx) ?? NOOP

const MAX_KEPT = 40
let seq = 0
const newId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`

const read = (store: 'local' | 'session', key: string): string | null => {
  try { return (store === 'local' ? window.localStorage : window.sessionStorage).getItem(key) } catch { return null }
}
const write = (store: 'local' | 'session', key: string, value: string) => {
  try { (store === 'local' ? window.localStorage : window.sessionStorage).setItem(key, value) } catch { /* private window: it just is not remembered */ }
}

export function AiPanelProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const { email, role } = useSession()
  const [prefs, setPrefs] = useState<PanelPrefs>({ open: true, width: PANEL_DEFAULT })
  const [isPhone, setIsPhone] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [tab, setTab] = useState<PanelTab>('ask')
  const [item, setItem] = useState<PanelItem | null>(null)
  const [focusTick, setFocusTick] = useState(0)
  const [messages, setMessages] = useState<Msg[]>([])
  const [pending, setPending] = useState<Pending | null>(null)
  const [force, setForce] = useState<'auto' | Tier>('auto')
  const [spend, setSpend] = useState<Spend | null>(null)
  const loadedFor = useRef<string | null>(null)
  const page = pageLabel(pathname)
  const canAsk = atLeast(role, 'admin')

  // This person's remembered state, once we know who they are.
  useEffect(() => {
    if (!email || loadedFor.current === email) return
    loadedFor.current = email
    setPrefs(parsePrefs(read('local', prefsKey(email))))
    try {
      const kept = JSON.parse(read('session', prefsKey(email) + ':chat') ?? '[]')
      if (Array.isArray(kept)) setMessages(kept.filter((m: any) => m && typeof m.id === 'string' && (m.role === 'user' || m.role === 'assistant')).slice(-MAX_KEPT))
    } catch { /* an unreadable copy is just dropped */ }
  }, [email])

  const savePrefs = useCallback((next: PanelPrefs) => {
    setPrefs(next)
    if (email) write('local', prefsKey(email), JSON.stringify(next))
  }, [email])
  const setOpen = useCallback((open: boolean) => savePrefs({ ...prefs, open }), [prefs, savePrefs])
  const setWidth = useCallback((w: number) => savePrefs({ ...prefs, width: clampWidth(w, window.innerWidth) }), [prefs, savePrefs])

  useEffect(() => {
    if (!email || loadedFor.current !== email) return
    write('session', prefsKey(email) + ':chat', JSON.stringify(messages.slice(-MAX_KEPT)))
  }, [messages, email])

  // Phone or not, following the window.
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${PHONE_MAX}px)`)
    const on = () => setIsPhone(mq.matches)
    on(); mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  // What the person pointed at belongs to the page it was on.
  useEffect(() => { setItem(null) }, [pathname])

  const loadSpend = useCallback(async () => {
    const r = await apiJson<Spend>('/api/ai/operator/spend')
    if (r.ok && r.body) setSpend({ month: r.body.month, monthUsd: r.body.monthUsd, capUsd: r.body.capUsd })
  }, [])
  useEffect(() => { if (email) void loadSpend() }, [email, loadSpend])

  const openPanel = useCallback((t?: PanelTab) => {
    if (t) setTab(t)
    if (isPhone) setSheetOpen(true)
    else if (!prefs.open) savePrefs({ ...prefs, open: true })
    setFocusTick(n => n + 1)
  }, [isPhone, prefs, savePrefs])

  const askAbout = useCallback((it: PanelItem) => { setItem(it); openPanel('ask') }, [openPanel])

  const run = useCallback(async (o: { full: string; item: PanelItem | null; page: string; force: Tier | null; approval?: string }) => {
    setPending({ startedAt: Date.now(), tier: o.force })
    const body = { text: o.full, force: o.force, ...(o.item ? { item: itemForApi(o.item) } : {}), ...(o.approval ? { approval: o.approval } : {}) }
    const r = await apiJson<{ result: OperatorResult }>(o.approval ? '/api/ai/operator/ask/approve' : '/api/ai/operator/ask', 'POST', body)
    setPending(null)
    const base = { id: newId(), role: 'assistant' as const, full: o.full, item: o.item, page: o.page }
    if (!r.ok || !r.body?.result) {
      setMessages(m => [...m, { ...base, text: r.error ?? 'The operator did not answer.' }])
      return
    }
    const result = r.body.result
    setMessages(m => [...m, { ...base, text: result.status === 'answered' ? result.answer : result.status === 'refused' ? result.message : result.reason, result }])
    if (result.status === 'answered' && result.spend) setSpend(result.spend)
    else void loadSpend()
  }, [loadSpend])

  const send = useCallback(async (text: string) => {
    const t = text.trim()
    if (!t || pending) return
    const full = composeQuestion(page, item, t)
    setMessages(m => [...m, { id: newId(), role: 'user', text: t, item, page }])
    await run({ full, item, page, force: force === 'auto' ? null : force })
  }, [page, item, force, pending, run])

  const approve = useCallback(async (m: Msg) => {
    if (m.result?.status !== 'needs_approval' || !m.full || pending) return
    setMessages(all => all.map(x => (x.id === m.id ? { ...x, used: true } : x)))
    await run({ full: m.full, item: m.item ?? null, page: m.page ?? page, force: null, approval: m.result.approvalToken })
  }, [page, pending, run])

  const retry = useCallback(async (m: Msg, tier: Tier) => {
    if (!m.full || pending) return
    setMessages(all => all.map(x => (x.id === m.id ? { ...x, used: true } : x)))
    await run({ full: m.full, item: m.item ?? null, page: m.page ?? page, force: tier })
  }, [page, pending, run])

  const clear = useCallback(() => { setMessages([]) }, [])

  const value = useMemo<PanelCtx>(() => ({
    prefs, setOpen, setWidth, isPhone, sheetOpen, setSheetOpen, tab, setTab, openPanel, page, item, askAbout,
    clearItem: () => setItem(null), focusTick, messages, pending, canAsk, force, setForce, spend, send, approve, retry, clear,
  }), [prefs, setOpen, setWidth, isPhone, sheetOpen, tab, openPanel, page, item, askAbout, focusTick, messages, pending, canAsk, force, spend, send, approve, retry, clear])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
