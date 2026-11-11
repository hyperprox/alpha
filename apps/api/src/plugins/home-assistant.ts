// =============================================================================
//  Plug-in — Home Assistant
//
//  Home Assistant knows about every device in the house and shows you almost
//  none of that as operational state. Its dashboard is built for "turn the
//  lamp on", not for "what has quietly stopped working". This plug-in answers
//  the second question: what is unavailable, what is out of battery, what is
//  waiting to update, and what has actually been happening.
//
//  The plug-in itself stays read-only: every write against this API actuates
//  something physical — a lock, a heater, a door — and a plug-in never holds a
//  credential. Controlling devices is HyperProx's own job (lib/ha-control): an
//  allow-list of actions, safety tiers, a read-back and an audit row for each
//  tap, across several Home Assistant instances. This file's settings are
//  instance #1 there.
//
//  One long-lived access token, made in Home Assistant under your profile.
// =============================================================================

import type { Plugin, PluginContext, PluginTileData, PluginDetail, PluginMetric } from '../lib/plugin-host'

export interface HAState {
  entity_id:    string
  state:        string
  attributes:   Record<string, any>
  last_changed: string
  last_updated: string
}

const DEAD = new Set(['unavailable', 'unknown'])

const domainOf = (id: string) => id.split('.')[0] ?? '?'
const nameOf   = (s: HAState) => s.attributes?.friendly_name || s.entity_id

/** Battery level as a number, or null when the entity is not reporting one. */
function batteryLevel(s: HAState): number | null {
  if (s.attributes?.device_class !== 'battery') return null
  const n = Number(s.state)
  return Number.isFinite(n) ? n : null
}

/** "3 hours ago", from an ISO timestamp. Relative reads better than absolute here. */
function since(iso?: string): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const m = Math.floor(ms / 60000)
  if (m < 1)   return 'just now'
  if (m < 60)  return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)  return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

/** The health view (unavailable devices, batteries, updates), for this plug-in and for every other instance. */
export interface HealthOptions {
  /**
   * A viewer's view: entities this says to hide (the house's security devices) are left out entirely, automation
   * times are not shown (when they last ran says when the house is empty) and the error log, which names
   * devices' addresses and hostnames, is not read out.
   */
  viewer?: { hide: (s: HAState) => boolean }
}

export function buildHealthDetail(states: unknown, config: any, log: unknown, warn: number, opts: HealthOptions = {}): PluginDetail {
  const all: HAState[] = Array.isArray(states) ? states : []
  const list = opts.viewer ? all.filter(s => !opts.viewer!.hide(s)) : all
  if (opts.viewer) log = ''

  const dead    = list.filter(s => DEAD.has(s.state))
  const lowBatt = list
    .map(s => ({ s, b: batteryLevel(s) }))
    .filter(x => x.b !== null && x.b < warn)
    .sort((a, b) => (a.b ?? 0) - (b.b ?? 0))
  const updates = list.filter(s => s.entity_id.startsWith('update.') && s.state === 'on')
  const autos   = list.filter(s => s.entity_id.startsWith('automation.'))
  const onNow   = list.filter(s => /^(light|switch|fan)\./.test(s.entity_id) && s.state === 'on')

  const byDomain = new Map<string, { total: number; dead: number }>()
  for (const s of list) {
    const d = domainOf(s.entity_id)
    const row = byDomain.get(d) ?? { total: 0, dead: 0 }
    row.total += 1
    if (DEAD.has(s.state)) row.dead += 1
    byDomain.set(d, row)
  }

  // Only the lines that look like a problem, newest last as the log has them.
  const logLines = String(log ?? '')
    .split('\n')
    .filter(l => /ERROR|WARNING|Traceback|Timeout|failed/i.test(l))
    .slice(-25)

  const attention = [
    ...updates.map(s => ({
      what: nameOf(s), kind: 'update waiting',
      detail: `${s.attributes?.installed_version ?? '?'} → ${s.attributes?.latest_version ?? '?'}`,
    })),
    ...lowBatt.map(x => ({ what: nameOf(x.s), kind: 'battery', detail: `${x.b}%` })),
    ...dead.slice(0, 40).map(s => ({ what: nameOf(s), kind: s.state, detail: since(s.last_changed) })),
  ]

  return {
    stats: [
      { label: 'Home',        value: String(config?.location_name ?? 'Home Assistant') },
      { label: 'Version',     value: String(config?.version ?? '—') },
      { label: 'Entities',    value: String(list.length) },
      { label: 'Integrations', value: String((config?.components ?? []).length) },
      { label: 'Unavailable', value: String(dead.length),
        tone: dead.length ? 'bad' : 'good' },
      { label: 'Low battery', value: String(lowBatt.length),
        tone: lowBatt.length ? 'warn' : 'good' },
      { label: 'Updates',     value: String(updates.length),
        tone: updates.length ? 'warn' : 'good' },
      { label: 'Automations', value: `${autos.filter(a => a.state === 'on').length} of ${autos.length} on` },
    ],
    tables: [
      {
        title: `Needs you (${attention.length})`,
        empty: 'Nothing is unavailable, flat, or waiting to update.',
        columns: [
          { key: 'what',   label: 'Entity' },
          { key: 'kind',   label: 'Why' },
          { key: 'detail', label: 'Detail' },
        ],
        rows: attention,
      },
      {
        title: 'Batteries',
        empty: 'No entities report a battery level.',
        columns: [
          { key: 'name',  label: 'Entity' },
          { key: 'level', label: 'Level', align: 'right' },
          { key: 'seen',  label: 'Last changed', align: 'right' },
        ],
        rows: list
          .map(s => ({ s, b: batteryLevel(s) }))
          .filter(x => x.b !== null)
          .sort((a, b) => (a.b ?? 0) - (b.b ?? 0))
          .map(x => ({ name: nameOf(x.s), level: `${x.b}%`, seen: since(x.s.last_changed) })),
      },
      {
        title: 'Unavailable',
        empty: 'Everything is responding.',
        columns: [
          { key: 'name',   label: 'Entity' },
          { key: 'id',     label: 'Entity id' },
          { key: 'state',  label: 'State' },
          { key: 'since',  label: 'Since', align: 'right' },
        ],
        // Longest-dead first: a device that dropped out months ago is a
        // different problem from one that dropped out during breakfast.
        rows: dead
          .slice()
          .sort((a, b) => new Date(a.last_changed).getTime() - new Date(b.last_changed).getTime())
          .map(s => ({ name: nameOf(s), id: s.entity_id, state: s.state, since: since(s.last_changed) })),
      },
      {
        title: 'Automations',
        empty: 'No automations.',
        columns: [
          { key: 'name',      label: 'Automation' },
          { key: 'state',     label: 'Enabled' },
          { key: 'triggered', label: 'Last triggered', align: 'right' },
        ],
        rows: autos
          .slice()
          .sort((a, b) => (a.state === 'on' ? 0 : 1) - (b.state === 'on' ? 0 : 1)
                       || nameOf(a).localeCompare(nameOf(b)))
          .map(s => ({
            name: nameOf(s),
            state: s.state === 'on' ? 'yes' : 'no',
            triggered: opts.viewer ? '—' : since(s.attributes?.last_triggered),
          })),
      },
      {
        title: `On now (${onNow.length})`,
        empty: 'Nothing is on.',
        columns: [
          { key: 'name',   label: 'Entity' },
          { key: 'domain', label: 'Kind' },
          { key: 'since',  label: 'On since', align: 'right' },
        ],
        rows: onNow.map(s => ({
          name: nameOf(s), domain: domainOf(s.entity_id), since: since(s.last_changed),
        })),
      },
      {
        title: 'Entities by domain',
        empty: 'No entities.',
        columns: [
          { key: 'domain', label: 'Domain' },
          { key: 'total',  label: 'Entities',    align: 'right' },
          { key: 'dead',   label: 'Unavailable', align: 'right' },
        ],
        rows: [...byDomain.entries()]
          .sort((a, b) => b[1].total - a[1].total)
          .map(([domain, v]) => ({ domain, total: v.total, dead: v.dead || '—' })),
      },
      {
        title: 'Recent problems in the log',
        empty: opts.viewer ? 'The log is shown to operators and above.' : 'Nothing in the log looks like an error.',
        columns: [{ key: 'line', label: 'Line' }],
        rows: logLines.map(line => ({ line: line.trim().slice(0, 300) })),
      },
    ],
  }
}

export const homeAssistantPlugin: Plugin = {
  manifest: {
    id:   'home-assistant',
    name: 'Home Assistant',
    description: 'What has stopped responding, what is out of battery, and what is waiting to update.',
    kind: 'device',
    icon: '🏠',
    baseUrlSetting: 'url',
    // The token never goes through the generic broker: lib/ha-control/broker.ts is the only transport, with the
    // house's address checks, certificate check or pin, no redirects and a deadline per request.
    coreTransport: true,
    // The token is a bearer credential; the broker adds the prefix so the
    // stored value stays the bare token a user copies out of Home Assistant.
    auth: { kind: 'header', header: 'Authorization', fromSetting: 'token', prefix: 'Bearer ' },
    settings: [
      { key: 'url',   label: 'Home Assistant URL', type: 'url',    required: true,
        hint: 'http://homeassistant.local:8123 — the same address you open in a browser.' },
      { key: 'token', label: 'Long-lived token',   type: 'secret', required: true,
        hint: 'Best made as a dedicated, non-admin Home Assistant user for HyperProx: sign in as that user, then Profile → Security → Long-lived access tokens → Create token. Kept in the vault.' },
      { key: 'battery_warn', label: 'Battery warning level (%)', type: 'text', required: false,
        hint: 'Below this counts as low. Default 20.' },
    ],
  },

  async load(ctx: PluginContext): Promise<PluginTileData> {
    const states: HAState[] = await ctx.get('/api/states', { timeoutMs: 15_000 })
    const list = Array.isArray(states) ? states : []
    const warn = Number(ctx.option('battery_warn') ?? 20) || 20

    const dead    = list.filter(s => DEAD.has(s.state))
    const lowBatt = list.filter(s => { const b = batteryLevel(s); return b !== null && b < warn })
    const updates = list.filter(s => s.entity_id.startsWith('update.') && s.state === 'on')
    const on      = list.filter(s => /^(light|switch|fan)\./.test(s.entity_id) && s.state === 'on')

    const rows = [
      { label: 'Entities',    value: String(list.length) },
      { label: 'Unavailable', value: String(dead.length),
        tone: (dead.length ? 'warn' : 'good') as 'warn' | 'good' },
      { label: 'Low battery', value: lowBatt.length ? `${lowBatt.length} under ${warn}%` : 'none',
        tone: (lowBatt.length ? 'warn' : 'good') as 'warn' | 'good' },
      { label: 'Updates',     value: updates.length ? `${updates.length} waiting` : 'up to date',
        tone: (updates.length ? 'warn' : 'good') as 'warn' | 'good' },
      { label: 'On now',      value: `${on.length} lights, switches and fans` },
    ]

    const needs = dead.length + lowBatt.length + updates.length
    return {
      headline: needs ? `${needs} need attention` : `${list.length} entities, all healthy`,
      rows,
      tone: dead.length || lowBatt.length ? 'warn' : 'good',
    }
  },

  async detail(ctx: PluginContext): Promise<PluginDetail> {
    const opt = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback)
    const [states, config, log] = await Promise.all([
      opt(ctx.get('/api/states', { timeoutMs: 20_000 }), [] as HAState[]),
      opt(ctx.get('/api/config'), {} as any),
      // The error log is plain text, not JSON, and can be megabytes.
      opt(ctx.get('/api/error_log', { timeoutMs: 15_000 }), '' as any),
    ])
    return buildHealthDetail(states, config, log, Number(ctx.option('battery_warn') ?? 20) || 20)
  },

  // The AI assistant reads this (first house only) and nothing else of Home Assistant. It is deliberately given
  // no control: actions go through lib/ha-control with a person's role, re-confirmation and confirm step, and an
  // assistant that could turn a sentence into "unlock the front door" would sit outside all three.
  async summary(ctx: PluginContext) {
    const states: HAState[] = await ctx.get('/api/states', { timeoutMs: 15_000 })
    const list = Array.isArray(states) ? states : []
    // Things a person asks about: lights, switches, locks, covers, doors and windows, climate. Names only,
    // never attributes, and nothing that sounds like a credential.
    const rank: Record<string, number> = { light: 0, switch: 1, lock: 2, cover: 3, binary_sensor: 4, climate: 5 }
    const picked = list.filter(s => domainOf(s.entity_id) in rank && !/pass|code|token|\bkey\b|\bpin\b/i.test(nameOf(s)))
      .filter(s => domainOf(s.entity_id) !== 'binary_sensor' || ['door', 'window', 'garage_door', 'opening', 'motion'].includes(s.attributes?.device_class))
      .sort((a, b) => rank[domainOf(a.entity_id)] - rank[domainOf(b.entity_id)])
    const on = list.filter(s => s.state === 'on' && domainOf(s.entity_id) === 'light').length
    return {
      title: 'Home Assistant',
      lines: [`${list.length} entities, ${list.filter(s => DEAD.has(s.state)).length} unavailable, ${on} lights on`,
        ...picked.slice(0, 40).map(s => `${nameOf(s)}: ${s.state}`)],
    }
  },

  async metrics(ctx: PluginContext): Promise<PluginMetric[]> {
    const states: HAState[] = await ctx.get('/api/states', { timeoutMs: 20_000 })
    const list = Array.isArray(states) ? states : []
    const warn = Number(ctx.option('battery_warn') ?? 20) || 20

    const dead    = list.filter(s => DEAD.has(s.state)).length
    const lowBatt = list.filter(s => { const b = batteryLevel(s); return b !== null && b < warn }).length
    const updates = list.filter(s => s.entity_id.startsWith('update.') && s.state === 'on').length
    const autos   = list.filter(s => s.entity_id.startsWith('automation.'))

    return [
      { name: 'home_entities', help: 'Entities known to Home Assistant.', type: 'gauge', value: list.length },
      { name: 'home_entities_unavailable', help: 'Entities reporting unavailable or unknown.',
        type: 'gauge', value: dead },
      { name: 'home_batteries_low', help: `Battery entities below ${warn}%.`, type: 'gauge', value: lowBatt },
      { name: 'home_updates_pending', help: 'Update entities with an update waiting.',
        type: 'gauge', value: updates },
      { name: 'home_automations', help: 'Automations, labelled by whether they are enabled.',
        type: 'gauge', value: autos.filter(a => a.state === 'on').length, labels: { state: 'on' } },
      { name: 'home_automations', help: 'Automations, labelled by whether they are enabled.',
        type: 'gauge', value: autos.filter(a => a.state !== 'on').length, labels: { state: 'off' } },
    ]
  },
}
