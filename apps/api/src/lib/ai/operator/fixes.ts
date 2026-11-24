// =============================================================================
//  HyperProx — fixes the operator may propose (AI side panel)
//
//  The operator never acts. When the person points it at one download in the Arr Stack queue ("Ask about this"),
//  a model may name which of the queue's own safe fixes would help. This file turns that into proposals the panel
//  shows as cards: only the actions below, only for the download the person pointed at, never anything the model
//  invented. The card's button then calls the queue's existing action route, which does its own role check,
//  confirmation and audit, after a human click.
// =============================================================================

export const FIX_ACTIONS = ['find-another', 'retry-import', 'prioritise'] as const
export type FixAction = typeof FIX_ACTIONS[number]
export const INSTANCES = ['sonarr', 'radarr', 'lidarr'] as const

/** The one item the person pointed at. */
export interface AskItem { kind: 'arr-queue'; instance: typeof INSTANCES[number]; downloadId: string; title: string }

export interface FixProposal { action: FixAction; instance: AskItem['instance']; downloadId: string; title: string; item: string }

const PHRASE: Record<FixAction, string> = {
  'find-another': 'Look for another copy',
  'retry-import': 'Retry the import',
  prioritise: 'Move it to the top of the queue',
}

/** The item from a request body, or null when it is missing or malformed. */
export function parseItem(v: unknown): AskItem | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.kind !== 'arr-queue') return null
  if (!(INSTANCES as readonly unknown[]).includes(o.instance)) return null
  if (typeof o.downloadId !== 'string' || !o.downloadId || o.downloadId.length > 220) return null
  const title = typeof o.title === 'string' ? o.title.slice(0, 160) : ''
  return { kind: 'arr-queue', instance: o.instance as AskItem['instance'], downloadId: o.downloadId, title }
}

/** What the model named, kept to the known actions and made into proposals for this item. At most three, no repeats. */
export function proposalsFor(item: AskItem | null | undefined, named: unknown): FixProposal[] {
  if (!item || !Array.isArray(named)) return []
  const out: FixProposal[] = []
  for (const n of named) {
    if (!(FIX_ACTIONS as readonly unknown[]).includes(n) || out.some(p => p.action === n)) continue
    out.push({ action: n as FixAction, instance: item.instance, downloadId: item.downloadId, title: PHRASE[n as FixAction], item: item.title })
  }
  return out.slice(0, FIX_ACTIONS.length)
}

export const FIX_NOTE =
  ' The person pointed at one download in the Arr Stack queue. If a fix from this list would help, name it in fixes: ' +
  'find-another (look for a different copy), retry-import, prioritise (move it to the top). You cannot run them: the person ' +
  'sees a button and decides. Leave fixes empty when none would help.'

export const FIXES_SCHEMA = {
  type: 'array', items: { type: 'string', enum: [...FIX_ACTIONS] },
  description: 'Fixes from the list that would help, or an empty list.',
} as const
