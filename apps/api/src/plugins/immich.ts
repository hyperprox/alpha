// =============================================================================
//  Plug-in — Immich
//
//  Your photo library as something to look after: how many photos and videos, who uses how much of the storage, the
//  server's version and whether a newer release exists, and the job queues (thumbnails, face recognition, video
//  conversion and the rest). A queue that is paused or holds failed jobs is shown as a problem with a fix button on the
//  plug-in's page (routes/immich.ts: resume, restart, clear failed; each confirmed and audited).
//
//  Connected by itself after a Catalogue install (lib/immich/setup.ts makes HyperProx's own API key, which can read the
//  numbers and look after the queues and cannot open a photo), or by hand with an address and a key from Immich's
//  Account settings. This card and its detail are viewer reads and carry totals only; who uses how much by name is on the
//  admin page.
// =============================================================================

import type { Plugin, PluginContext, PluginDetail, PluginTileData } from '../lib/plugin-host'
import { readOverview, type ImmichOverview } from '../lib/immich/service'

export function size(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TB`
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const n = (v: number) => v.toLocaleString('en-US')

export function tileOf(o: ImmichOverview): PluginTileData {
  const bad = o.problems.filter(p => p.severity === 'bad').length
  const warn = o.problems.length - bad
  const busy = o.queues.reduce((a, q) => a + q.active, 0)
  return {
    headline: bad ? `${plural(bad, 'problem')} to fix` : `${n(o.photos)} photos, ${n(o.videos)} videos`,
    rows: [
      { label: 'Library', value: `${n(o.photos)} photos · ${n(o.videos)} videos · ${size(o.bytes)}` },
      { label: 'Users', value: String(o.users.length) },
      { label: 'Version', value: o.version ?? 'unknown', ...(o.update.available ? { tone: 'warn' as const } : {}) },
      { label: 'Update', value: o.update.available ? `${o.update.latest} available` : 'up to date', tone: o.update.available ? 'warn' as const : 'good' as const },
      { label: 'Jobs', value: busy ? `${plural(busy, 'job')} running` : 'idle', tone: bad ? 'bad' as const : warn ? 'warn' as const : 'good' as const },
    ],
    tone: bad ? 'bad' : warn ? 'warn' : 'good',
  }
}

export function detailOf(o: ImmichOverview): PluginDetail {
  return {
    stats: [
      { label: 'Photos', value: n(o.photos) }, { label: 'Videos', value: n(o.videos) },
      { label: 'Storage used', value: size(o.bytes), hint: `${size(o.photoBytes)} photos · ${size(o.videoBytes)} videos` },
      { label: 'Version', value: o.version ?? '—', hint: o.update.available ? `${o.update.latest} available` : undefined, tone: o.update.available ? 'warn' : 'good' },
      { label: 'Problems', value: String(o.problems.length), tone: o.problems.some(p => p.severity === 'bad') ? 'bad' : o.problems.length ? 'warn' : 'good' },
    ],
    tables: [{
      title: 'Job queues', empty: 'No queues reported.',
      columns: [{ key: 'name', label: 'Queue' }, { key: 'state', label: 'State' }, { key: 'active', label: 'Running', align: 'right' }, { key: 'waiting', label: 'Waiting', align: 'right' }, { key: 'failed', label: 'Failed', align: 'right' }],
      rows: o.queues.map(q => ({ name: q.label, state: q.paused ? 'paused' : q.active ? 'running' : 'idle', active: q.active, waiting: q.waiting, failed: q.failed || '—' })),
    }],
  }
}

export const immichPlugin: Plugin = {
  manifest: {
    id: 'immich',
    name: 'Immich',
    description: 'Your photo library: how many photos and videos, who uses how much, the version and whether an update exists, and every job queue. A paused queue or failed jobs get a fix button.',
    kind: 'device',
    icon: '🖼️',
    baseUrlSetting: 'url',
    auth: { kind: 'header', header: 'x-api-key', fromSetting: 'key' },
    settings: [
      { key: 'url', label: 'Immich address', type: 'url', required: true, hint: 'The address you open Immich at, such as http://immich.example.lan:2283.' },
      { key: 'key', label: 'API key', type: 'secret', required: true, hint: 'Immich → Account settings → API keys. HyperProx needs server statistics, queue and job permissions only. Kept in the vault.' },
    ],
  },
  async load(ctx: PluginContext): Promise<PluginTileData> { return tileOf(await readOverview({ get: (p, t) => ctx.get(p, { timeoutMs: t }) })) },
  async detail(ctx: PluginContext): Promise<PluginDetail> { return detailOf(await readOverview({ get: (p, t) => ctx.get(p, { timeoutMs: t }) })) },
  async summary(ctx: PluginContext) {
    const o = await readOverview({ get: (p, t) => ctx.get(p, { timeoutMs: t }) })
    return {
      title: 'Immich',
      lines: [
        `${n(o.photos)} photos and ${n(o.videos)} videos, ${size(o.bytes)} used, ${plural(o.users.length, 'user')}`,
        `Version ${o.version ?? 'unknown'}${o.update.available ? `, ${o.update.latest} is available` : ', up to date'}`,
        ...o.problems.map(p => p.title),
      ],
    }
  },
}
