// =============================================================================
//  Plug-in — Unmanic
//
//  A transcode farm is usually several workers on several machines, so this
//  declares one endpoint per worker rather than pretending there is one box.
//  Only the first is required; the others are left blank on a single-node setup
//  and simply do not appear.
// =============================================================================

import type { Plugin, PluginContext, PluginTileData, PluginDetail, PluginMetric } from '../lib/plugin-host'

const NODES = ['default', 'node2', 'node3'] as const

interface NodeState {
  key: string; label: string
  busy: number; idle: number; paused: number
  pending: number
  current: Array<{ worker: string; file: string }>
  error?: string
}

async function readNode(ctx: PluginContext, key: string, label: string): Promise<NodeState | null> {
  if (key !== 'default' && !ctx.has(key)) return null
  const c = key === 'default' ? ctx : ctx.from(key)
  const state: NodeState = { key, label, busy: 0, idle: 0, paused: 0, pending: 0, current: [] }

  try {
    const w = await c.get('/unmanic/api/v2/workers/status')
    for (const worker of w?.workers_status ?? []) {
      if (worker.paused)      state.paused++
      else if (worker.idle)   state.idle++
      else {
        state.busy++
        if (worker.current_file) {
          state.current.push({ worker: worker.name ?? worker.id, file: worker.current_file })
        }
      }
    }
  } catch (e: any) {
    return { ...state, error: e.message }
  }

  // The queue is a POST with paging; only the total matters here, so ask for
  // one row rather than pulling a backlog that can run to thousands.
  try {
    const q = await c.post('/unmanic/api/v2/pending/tasks', { start: 0, length: 1, search_value: '' })
    state.pending = Number(q?.recordsFiltered ?? q?.recordsTotal ?? 0)
  } catch { /* worker status is the point; a missing queue count is survivable */ }

  return state
}

async function readAll(ctx: PluginContext): Promise<NodeState[]> {
  const labels: Record<string, string> = {
    default: ctx.option('label') || 'Worker 1',
    node2:   ctx.option('label2') || 'Worker 2',
    node3:   ctx.option('label3') || 'Worker 3',
  }
  const out = await Promise.all(NODES.map(k => readNode(ctx, k, labels[k])))
  return out.filter((x): x is NodeState => x !== null)
}

export const unmanicPlugin: Plugin = {
  manifest: {
    id:   'unmanic',
    name: 'Unmanic',
    description: 'Transcode workers across every node: what is encoding right now and how deep the queue is.',
    kind: 'device',
    icon: '🎞️',
    baseUrlSetting: 'url',
    auth: { kind: 'none' },
    endpoints: [
      { key: 'node2', label: 'Worker 2', baseUrlSetting: 'url2', auth: { kind: 'none' } },
      { key: 'node3', label: 'Worker 3', baseUrlSetting: 'url3', auth: { kind: 'none' } },
    ],
    settings: [
      { key: 'url',    label: 'Worker 1 address', type: 'url',  required: true,
        hint: 'http://192.168.1.20:8888 — Unmanic has no authentication, so keep it on the LAN.' },
      { key: 'label',  label: 'Worker 1 name',    type: 'text', required: false },
      { key: 'url2',   label: 'Worker 2 address', type: 'url',  required: false },
      { key: 'label2', label: 'Worker 2 name',    type: 'text', required: false },
      { key: 'url3',   label: 'Worker 3 address', type: 'url',  required: false },
      { key: 'label3', label: 'Worker 3 name',    type: 'text', required: false },
    ],
  },

  async load(ctx: PluginContext): Promise<PluginTileData> {
    const nodes = await readAll(ctx)
    const reachable = nodes.filter(n => !n.error)
    const busy    = reachable.reduce((t, n) => t + n.busy, 0)
    const idle    = reachable.reduce((t, n) => t + n.idle, 0)
    const pending = reachable.reduce((t, n) => t + n.pending, 0)
    const down    = nodes.filter(n => n.error)

    const rows = nodes.map(n => ({
      label: n.label,
      value: n.error ? 'unreachable' : `${n.busy} encoding · ${n.pending} queued`,
      tone: (n.error ? 'bad' : n.busy ? 'good' : 'warn') as 'good' | 'warn' | 'bad',
    }))

    // Idle workers with a full queue is the failure this is worth watching for:
    // everything looks up, and nothing is being encoded.
    const stalled = busy === 0 && pending > 0
    return {
      headline: down.length === nodes.length
        ? 'No workers reachable'
        : `${busy} encoding · ${pending} queued`,
      tone: down.length ? 'bad' : stalled ? 'warn' : 'good',
      rows: stalled
        ? [{ label: 'Stalled', value: `${idle} idle workers with ${pending} queued`, tone: 'warn' as const }, ...rows]
        : rows,
    }
  },

  async detail(ctx: PluginContext): Promise<PluginDetail> {
    const nodes = await readAll(ctx)
    return {
      stats: [
        { label: 'Encoding', value: String(nodes.reduce((t, n) => t + n.busy, 0)) },
        { label: 'Idle',     value: String(nodes.reduce((t, n) => t + n.idle, 0)) },
        { label: 'Paused',   value: String(nodes.reduce((t, n) => t + n.paused, 0)) },
        { label: 'Queued',   value: String(nodes.reduce((t, n) => t + n.pending, 0)) },
        { label: 'Workers',  value: String(nodes.filter(n => !n.error).length + ' of ' + nodes.length) },
      ],
      tables: [
        {
          title: 'Encoding now',
          empty: 'No worker is encoding anything.',
          columns: [
            { key: 'node',   label: 'Node' },
            { key: 'worker', label: 'Worker' },
            { key: 'file',   label: 'File' },
          ],
          rows: nodes.flatMap(n => n.current.map(c => ({ node: n.label, worker: c.worker, file: c.file }))),
        },
        {
          title: 'Workers',
          empty: 'No workers configured.',
          columns: [
            { key: 'node',    label: 'Node' },
            { key: 'state',   label: 'State' },
            { key: 'busy',    label: 'Encoding', align: 'right' },
            { key: 'idle',    label: 'Idle',     align: 'right' },
            { key: 'paused',  label: 'Paused',   align: 'right' },
            { key: 'pending', label: 'Queued',   align: 'right' },
          ],
          rows: nodes.map(n => ({
            node: n.label, state: n.error ? 'unreachable' : 'ok',
            busy: n.busy, idle: n.idle, paused: n.paused, pending: n.pending,
          })),
        },
      ],
    }
  },

  async metrics(ctx: PluginContext): Promise<PluginMetric[]> {
    const nodes = await readAll(ctx)
    const out: PluginMetric[] = []
    for (const n of nodes) {
      const labels = { node: n.label }
      out.push({ name: 'unmanic_workers', help: 'Unmanic workers by state.', type: 'gauge',
        value: n.busy, labels: { ...labels, state: 'encoding' } })
      out.push({ name: 'unmanic_workers', help: 'Unmanic workers by state.', type: 'gauge',
        value: n.idle, labels: { ...labels, state: 'idle' } })
      out.push({ name: 'unmanic_queue', help: 'Files waiting to be encoded.', type: 'gauge',
        value: n.pending, labels })
      out.push({ name: 'unmanic_node_up', help: 'Whether the Unmanic worker answered.', type: 'gauge',
        value: n.error ? 0 : 1, labels })
    }
    return out
  },
}
