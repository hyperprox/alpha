// =============================================================================
//  HyperProx — the Open WebUI plug-in page: the pure parts (tested on their own)
// =============================================================================

export interface ModelRow { name: string; sizeBytes: number | null }
export interface Problem {
  id: string; severity: 'bad' | 'warn'; title: string; detail: string
  fix: { action: 'reconnect-ollama' | 'close-signup'; label: string; confirm: string } | null
}
export interface Overview {
  version: string | null
  models: ModelRow[]
  ollama: { enabled: boolean; connected: boolean; answering: boolean | null; error: string | null }
  signupOpen: boolean | null
  problems: Problem[]
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function modelSize(bytes: number | null): string {
  if (!bytes) return '—'
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}

/** The Ollama connection in words, and the tone the page draws it in. */
export function ollamaState(o: Overview['ollama']): { text: string; tone: 'good' | 'warn' | 'crit' } {
  if (!o.enabled || !o.connected) return { text: 'No Ollama connected', tone: 'warn' }
  if (o.answering === false) return { text: 'The Ollama does not answer', tone: 'crit' }
  return { text: 'Connected and answering', tone: 'good' }
}

/** Largest models first, so what takes the room is at the top. */
export const modelsBySize = (m: ModelRow[]) => [...m].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) || a.name.localeCompare(b.name))
