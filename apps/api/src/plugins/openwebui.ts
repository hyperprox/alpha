// =============================================================================
//  Plug-in — Open WebUI
//
//  Your chat page for local models as something to look after: its version, the models available through the Ollama it
//  is connected to, whether that Ollama answers, and whether open sign-up is off. An Ollama that does not answer gets a
//  Reconnect button and an open sign-up a Close button on the plug-in's page (routes/openwebui.ts; each confirmed and
//  audited). Connected by itself after a Catalogue install (HyperProx's own API key, kept in the vault), or by hand
//  with an address and an API key from Open WebUI's Settings → Account.
//
//  This card and its detail are viewer reads and carry counts and model names only.
// =============================================================================

import type { Plugin, PluginContext, PluginDetail, PluginTileData } from '../lib/plugin-host'
import { readOverview, type OpenWebuiOverview } from '../lib/openwebui/service'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function tileOf(o: OpenWebuiOverview): PluginTileData {
  const bad = o.problems.filter(p => p.severity === 'bad').length
  const warn = o.problems.length - bad
  const state = !o.ollama.connected ? 'none connected' : o.ollama.answering === false ? 'not answering' : 'answering'
  return {
    headline: bad ? o.problems[0].title : o.models.length ? `${plural(o.models.length, 'model')} available` : 'no models yet',
    rows: [
      { label: 'Version', value: o.version ?? 'unknown' },
      { label: 'Ollama', value: state, tone: o.ollama.answering === true ? 'good' as const : o.ollama.answering === false ? 'bad' as const : 'warn' as const },
      { label: 'Models', value: String(o.models.length) },
      { label: 'Sign-up', value: o.signupOpen === null ? 'unknown' : o.signupOpen ? 'open' : 'closed', tone: o.signupOpen ? 'bad' as const : 'good' as const },
    ],
    tone: bad ? 'bad' : warn ? 'warn' : 'good',
  }
}

export function detailOf(o: OpenWebuiOverview): PluginDetail {
  return {
    stats: [
      { label: 'Version', value: o.version ?? '—' },
      { label: 'Models', value: String(o.models.length) },
      { label: 'Ollama', value: o.ollama.answering === true ? 'answering' : o.ollama.answering === false ? 'not answering' : 'not connected', tone: o.ollama.answering === true ? 'good' : o.ollama.answering === false ? 'bad' : 'warn' },
      { label: 'Open sign-up', value: o.signupOpen === null ? '—' : o.signupOpen ? 'on' : 'off', tone: o.signupOpen ? 'bad' : 'good' },
    ],
    tables: [{
      title: 'Models', empty: 'No models yet. Pull one into the Ollama.',
      columns: [{ key: 'name', label: 'Model' }, { key: 'size', label: 'Size', align: 'right' }],
      rows: o.models.map(m => ({ name: m.name, size: m.sizeBytes ? `${(m.sizeBytes / 1024 ** 3).toFixed(1)} GB` : '—' })),
    }],
  }
}

const clientOf = (ctx: PluginContext) => ({
  get: (p: string, t?: number) => ctx.get(p, { timeoutMs: t }),
  post: (p: string, b: Record<string, unknown>, t?: number) => ctx.post(p, b, { timeoutMs: t }),
})

export const openWebuiPlugin: Plugin = {
  manifest: {
    id: 'openwebui',
    name: 'Open WebUI',
    description: 'Your chat page for local models: the models available, whether the Ollama behind it answers (with a Reconnect button), and whether open sign-up is off.',
    kind: 'device',
    icon: '💬',
    baseUrlSetting: 'url',
    auth: { kind: 'header', header: 'Authorization', fromSetting: 'token', prefix: 'Bearer ' },
    settings: [
      { key: 'url', label: 'Open WebUI address', type: 'url', required: true, hint: 'The address you open Open WebUI at, such as http://chat.example.lan:8080.' },
      { key: 'token', label: 'API key', type: 'secret', required: true, hint: 'Open WebUI → Settings → Account → API keys (an administrator\'s). Kept in the vault.' },
    ],
  },
  async load(ctx: PluginContext): Promise<PluginTileData> { return tileOf(await readOverview(clientOf(ctx))) },
  async detail(ctx: PluginContext): Promise<PluginDetail> { return detailOf(await readOverview(clientOf(ctx))) },
  async summary(ctx: PluginContext) {
    const o = await readOverview(clientOf(ctx))
    return { title: 'Open WebUI', lines: [`Version ${o.version ?? 'unknown'}, ${plural(o.models.length, 'model')} available`, ...o.models.slice(0, 20).map(m => m.name), ...o.problems.map(p => p.title)] }
  },
}
