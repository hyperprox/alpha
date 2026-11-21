// =============================================================================
//  HyperProx — Open WebUI: which Ollama it will be pointed at
//
//  Resolved when the plan is previewed and kept in the plan (a value in a request is never used): the Ollama HyperProx
//  already knows (the AI page's connection, which the Ollama recipe writes when it installs one), or the address the
//  person gave, or none. An address is asked to list its models before anything is made, so a wrong one is found now.
// =============================================================================

import type { Http } from '../arr/setup'
import { cleanOllamaUrl } from './recipe'

export interface OpenWebuiPreviewDeps {
  http: Http
  /** The Ollama address the AI page is connected to, or null. */
  knownOllama(): Promise<string | null>
}

/** How many models an Ollama lists, or null when it does not answer like one. */
export async function askOllama(url: string, http: Http): Promise<number | null> {
  const r = await http({ method: 'GET', url: `${url}/api/tags`, timeoutMs: 8000 }).catch(() => null)
  if (!r || r.status !== 200) return null
  try { const m = JSON.parse(r.body)?.models; return Array.isArray(m) ? m.length : null } catch { return null }
}

export async function openwebuiPreview(values: Record<string, string>, d: OpenWebuiPreviewDeps): Promise<{
  errors: string[]; warnings: string[]; checks: string[]; options: Record<string, string>; offerOllama: boolean
}> {
  const errors: string[] = [], warnings: string[] = [], checks: string[] = []
  const options: Record<string, string> = { ...values, OWUI_OLLAMA_URL: '', OWUI_OLLAMA_ENABLED: '0' }
  let offerOllama = false
  const mode = values.OWUI_OLLAMA || 'auto'
  const use = async (url: string, how: string) => {
    const n = await askOllama(url, d.http)
    if (n === null) return false
    options.OWUI_OLLAMA_URL = url; options.OWUI_OLLAMA_ENABLED = '1'
    checks.push(`${how} answers at ${url} and lists ${n} model${n === 1 ? '' : 's'}; Open WebUI will use it.`)
    if (n === 0) warnings.push('That Ollama has no models yet. Pull one from the AI page or from Open WebUI\'s Admin → Settings → Models.')
    return true
  }
  if (mode === 'address') {
    const url = cleanOllamaUrl(values.OWUI_OLLAMA_ADDRESS ?? '')
    if (!url) errors.push('The Ollama address is not usable.')
    else if (!await use(url, 'The Ollama you named')) errors.push(`No Ollama answered at ${url}. Check the address and that Ollama listens on the network (OLLAMA_HOST=0.0.0.0), or pick another choice.`)
  } else if (mode === 'auto') {
    const known = await d.knownOllama().catch(() => null)
    const url = known ? cleanOllamaUrl(known) : null
    if (url && await use(url, 'The Ollama HyperProx knows')) { /* in use */ }
    else {
      offerOllama = true
      warnings.push(known
        ? `HyperProx knows an Ollama at ${known}, but it did not answer, so Open WebUI starts with no model server. Fix it, or give another address.`
        : 'HyperProx does not know an Ollama yet, so Open WebUI starts with no model server. When the install finishes it offers to install Ollama next, and HyperProx connects the two.')
    }
  } else checks.push('No Ollama for now: Open WebUI starts with no model server. Add one later in Open WebUI\'s Admin → Settings → Connections, or reconnect it from the plug-in.')
  checks.push('Open sign-up is off, and new accounts start as pending until the administrator approves them.')
  checks.push('Open WebUI gets no public name unless you ask for one below: it is on the container\'s own address only.')
  return { errors, warnings, checks, options, offerOllama }
}
