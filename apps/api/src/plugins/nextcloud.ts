// =============================================================================
//  Plug-in — Nextcloud
//
//  Each Nextcloud as something to look after: its version and the update, the
//  admin page's setup warnings grouped by severity, background jobs, Talk's
//  signalling server and Client Push, PHP and the database, users and the log.
//  Every warning gets an action (a one-click fix, a guided step, or an honest
//  "optional" with snooze); the update itself backs the database up first and
//  needs the master password. The logins and every action live in
//  lib/nextcloud; this file is the gallery card and its health, read through
//  lib/nextcloud's own transport (coreTransport).
//
//  Instances are added on the plug-in's own page (Add a Nextcloud), not
//  through settings here.
// =============================================================================

import { PluginNotConfigured } from '../lib/plugin-host'
import type { Plugin, PluginContext, PluginDetail, PluginTileData } from '../lib/plugin-host'
import type { TileRow } from '../lib/nextcloud'
import { stripAddresses } from '../lib/redact-addresses'
import { asOfText, clockAt } from '../lib/ai/when'
import '../lib/nextcloud'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
export function tileOf(rows: TileRow[]): PluginTileData {
  if (!rows.length) throw new PluginNotConfigured('Not configured yet: HyperProx connects a Nextcloud it finds by itself; none found so far.')
  const lines = rows.map(x => {
    if (!x.counts) return { label: x.name, value: x.error ?? 'not reachable', tone: 'bad' as const }
    const c = x.counts
    const parts = [x.update ? `update to ${x.update}` : null, c.error ? plural(c.error, 'error') : null, c.warning ? plural(c.warning, 'warning') : null].filter(Boolean)
    return { label: x.name, value: parts.length ? parts.join(', ') : `${x.version ?? ''} · all checks pass`.trim(), tone: (c.error ? 'bad' : parts.length ? 'warn' : 'good') as 'good' | 'warn' | 'bad' }
  })
  const bad = lines.filter(l => l.tone !== 'good')
  return {
    headline: !bad.length ? (rows.length === 1 ? 'all checks pass' : `${rows.length} instances, all fine`) : rows.length === 1 ? bad[0].value : `${bad[0].label}: ${bad[0].value}${bad.length > 1 ? ` (+${bad.length - 1})` : ''}`,
    rows: lines,
    tone: lines.some(l => l.tone === 'bad') ? 'bad' : bad.length ? 'warn' : 'good',
  }
}

export function detailOf(rows: TileRow[]): PluginDetail {
  return {
    stats: rows.map(r => ({ label: r.name, value: r.version ?? '—', hint: r.update ? `${r.update} available` : r.error ?? undefined, tone: r.error ? 'bad' as const : r.update || r.counts?.warning || r.counts?.error ? 'warn' as const : 'good' as const })),
    tables: [{ title: 'Instances', empty: 'No Nextcloud added yet.', columns: [
      { key: 'name', label: 'Name' }, { key: 'version', label: 'Version' }, { key: 'update', label: 'Update' },
      { key: 'error', label: 'Errors', align: 'right' }, { key: 'warning', label: 'Warnings', align: 'right' }, { key: 'info', label: 'Info', align: 'right' }],
      rows: rows.map(r => ({ name: r.name, version: r.version ?? '—', update: r.update ?? '—', error: r.counts?.error ?? '—', warning: r.counts?.warning ?? '—', info: r.counts?.info ?? '—' })) }],
  }
}

export const nextcloudPlugin: Plugin = {
  manifest: {
    id: 'nextcloud',
    name: 'Nextcloud',
    description: 'Each Nextcloud: version and update, the setup warnings grouped by severity with a fix, a guided step or an honest "optional" for each, background jobs, Talk signalling and Client Push, PHP, database, users and the log. Updates a Docker Compose install with a database dump first, behind the master password.',
    kind: 'device',
    icon: '☁️',
    baseUrlSetting: 'url',
    coreTransport: true,
    auth: { kind: 'none' },
    settings: [],
  },
  needsWhat: 'a Nextcloud on the cluster (connected by itself once found)',

  async load(ctx: PluginContext): Promise<PluginTileData> {
    return tileOf(await ctx.get('/readings'))
  },

  async detail(ctx: PluginContext): Promise<PluginDetail> {
    const rows: TileRow[] = await ctx.get('/readings')
    if (!Array.isArray(rows) || !rows.length) throw new PluginNotConfigured('Not configured yet: HyperProx connects a Nextcloud it finds by itself; none found so far.')
    return detailOf(rows)
  },

  // For the assistant: the reading HyperProx already holds (refreshed in the background), so a question never waits
  // on occ in the guest; a reading older than a few minutes says when it was taken.
  async summary(ctx: PluginContext) {
    const rows: TileRow[] = await ctx.get('/readings/cached')
    return {
      title: 'Nextcloud',
      lines: (Array.isArray(rows) ? rows : []).map(r => {
        const why = stripAddresses(String(r.error ?? 'no answer')).replace(/[.\s]+$/, '')
        if (!r.counts) return `${r.name}: could not be read (${why})`
        const last = `Nextcloud ${r.version ?? 'unknown'}${r.update ? `, ${r.update} available` : ''}; ${r.counts.error} errors, ${r.counts.warning} warnings, ${r.counts.info} notes`
        // The newest read failed: said first, with the last good reading after it.
        if (r.failedSince) return `${r.name}: could not be read since ${clockAt(r.failedSince)} (${why}); last reading${asOfText(r.at, Date.now(), 0)}: ${last}`
        return `${r.name}: ${last}${asOfText(r.at, Date.now(), 5 * 60_000)}`
      }),
    }
  },
}
