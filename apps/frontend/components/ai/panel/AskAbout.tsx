'use client'

import { useAiPanel } from './PanelProvider'
import type { PanelItem } from '@/lib/ai-panel'
import s from './panel.module.css'

/**
 * "Ask about this": sends one item (an Arr Stack queue row, for now) into the AI side panel. It only points the panel at
 * the item; the person types the question. Other plug-ins use the same button with their own item kind later. It is not
 * drawn for someone who cannot ask the operator (it needs the admin role).
 */
export function AskAbout({ item, className }: { item: PanelItem; className?: string }) {
  const panel = useAiPanel()
  if (!panel.canAsk) return null
  return (
    <button type="button" className={`${s.askAbout} ${className ?? ''}`} onClick={() => panel.askAbout(item)} aria-label={`Ask the AI about ${item.title}`} title="Ask the AI about this">
      <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M10 2.5l1.7 4.6 4.8 1.7-4.8 1.7L10 15.1l-1.7-4.6L3.5 8.8l4.8-1.7z" /><path d="M15.5 14.5v3M14 16h3" />
      </svg>
      <span>Ask about this</span>
    </button>
  )
}
