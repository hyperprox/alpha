'use client'

import { useEffect, useState, useCallback } from 'react'
import { PluginCards } from '@/components/plugins/PluginCards'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Alert {
  name: string
  severity: 'critical' | 'warning' | 'info'
  state: string
  node: string
  summary: string
  description: string
  firedAt: string
}

interface NodeStat {
  node: string
  cpu: number
  memory: number
  disk: number
  load: number
  rxKBs?: number
  txKBs?: number
}

const GRAFANA = process.env.NEXT_PUBLIC_GRAFANA_URL || 'http://localhost:3003'
const DASHBOARDS = [
  { uid: 'hyperprox-cluster', title: 'Cluster Overview', orgId: 1, vars: '' },
  { uid: 'hyperprox-plugins', title: 'Plug-ins',         orgId: 1, vars: '' },
]

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------
function severityColor(s: string) {
  if (s === 'critical') return 'var(--crit)'
  if (s === 'warning')  return 'var(--warn)'
  return 'var(--accent)'
}

function severityBg(s: string) {
  if (s === 'critical') return 'color-mix(in srgb, var(--crit) 8%, transparent)'
  if (s === 'warning')  return 'color-mix(in srgb, var(--warn) 8%, transparent)'
  return 'color-mix(in srgb, var(--accent) 8%, transparent)'
}

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------
function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (!values.length) return <div style={{ height: 32, background: 'var(--border)', borderRadius: 4 }} />
  const max = Math.max(...values, 1)
  const min = Math.min(...values)
  const range = max - min || 1
  const w = 120, h = 32, pad = 2
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2)
    const y = h - pad - ((v - min) / range) * (h - pad * 2)
    return `${x},${y}`
  }).join(' ')


  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Gauge bar
// ---------------------------------------------------------------------------
function Bar({ value, color }: { value: number; color: string }) {
  const pct = Math.min(100, Math.max(0, value || 0))
  const c = pct > 90 ? 'var(--crit)' : pct > 70 ? 'var(--warn)' : color
  return (
    <div style={{ position: 'relative', height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${pct}%`, background: c, borderRadius: 2, transition: 'width 0.5s' }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function MonitoringPage() {
  const [tab, setTab]           = useState<'overview' | 'grafana' | 'alerts'>('overview')
  const [grafanaDash, setGrafanaDash] = useState(DASHBOARDS[0].uid)
  const [alerts, setAlerts]     = useState<Alert[]>([])
  const [nodes, setNodes]       = useState<NodeStat[]>([])
  const [history, setHistory]   = useState<Record<string, number[]>>({})
  const [loading, setLoading]   = useState(true)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)


  // -------------------------------------------------------------------------
  // Fetch alerts + node stats
  // -------------------------------------------------------------------------
  const fetchData = useCallback(async () => {
    try {
      const [alertsRes, nodesRes] = await Promise.all([
        fetch('/api/prometheus/alerts'),
        fetch('/api/prometheus/nodes'),
      ])

      const alertsJson = await alertsRes.json()
      const nodesJson  = await nodesRes.json()

      if (alertsJson.success) setAlerts(alertsJson.data)
      if (nodesJson.success) {
        const nodeStats: NodeStat[] = nodesJson.data
        // Fetch network for each node
        try {
          const netRes = await fetch('/api/network/stats')
          const netJson = await netRes.json()
          if (netJson.success) {
            const netMap: Record<string, {rx: number, tx: number}> = {}
            for (const n of netJson.data.nodes) netMap[n.node] = { rx: n.netin / 1024, tx: n.netout / 1024 }
            for (const n of nodeStats) { n.rxKBs = netMap[n.node]?.rx || 0; n.txKBs = netMap[n.node]?.tx || 0 }
          }
        } catch {}
        setNodes(nodeStats)
      }
      setLastUpdate(new Date())
    } catch (err) {
      console.error('Monitoring fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  // -------------------------------------------------------------------------
  // Fetch CPU history sparklines (last 1 hour)
  // -------------------------------------------------------------------------
  const fetchHistory = useCallback(async () => {
    try {
      const end   = Math.floor(Date.now() / 1000)
      const start = end - 3600
      const res = await fetch(
        `/api/prometheus/range?q=${encodeURIComponent('100 - (avg by(node) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)')}&start=${start}&end=${end}&step=60`
      )
      const json = await res.json()
      if (!json.success) return

      const h: Record<string, number[]> = {}
      for (const series of json.data.result) {
        const node = series.metric.node
        if (node) h[node] = series.values.map((v: any[]) => parseFloat(v[1]))
      }
      setHistory(h)
    } catch (err) {
      console.error('History fetch error:', err)
    }
  }, [])

  useEffect(() => {
    fetchData()
    fetchHistory()
    const dataInterval    = setInterval(fetchData, 15000)
    const historyInterval = setInterval(fetchHistory, 60000)
    return () => { clearInterval(dataInterval); clearInterval(historyInterval) }
  }, [fetchData, fetchHistory])

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------
  const criticalAlerts = alerts.filter(a => a.severity === 'critical' && a.state === 'firing')
  const warningAlerts  = alerts.filter(a => a.severity === 'warning'  && a.state === 'firing')
  const firingCount    = alerts.filter(a => a.state === 'firing').length

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div style={{ padding: 24, minHeight: '100vh', background: 'var(--ground)', fontFamily: "'IBM Plex Mono', monospace" }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 22, fontWeight: 700, color: 'var(--text-bright)', letterSpacing: '0.05em' }}>
            MONITORING
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dimmer)', marginTop: 2 }}>
            Prometheus + Grafana — {lastUpdate ? `updated ${lastUpdate.toLocaleTimeString()}` : 'loading...'}
          </div>
        </div>

        {/* Alert badges */}
        <div style={{ display: 'flex', gap: 8 }}>
          {criticalAlerts.length > 0 && (
            <div style={{ padding: '4px 12px', borderRadius: 4, background: 'color-mix(in srgb, var(--crit) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--crit) 25%, transparent)', color: 'var(--crit)', fontSize: 12 }}>
              🔴 {criticalAlerts.length} Critical
            </div>
          )}
          {warningAlerts.length > 0 && (
            <div style={{ padding: '4px 12px', borderRadius: 4, background: 'color-mix(in srgb, var(--warn) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--warn) 25%, transparent)', color: 'var(--warn)', fontSize: 12 }}>
              🟡 {warningAlerts.length} Warning
            </div>
          )}
          {firingCount === 0 && !loading && (
            <div style={{ padding: '4px 12px', borderRadius: 4, background: 'color-mix(in srgb, var(--good) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--good) 25%, transparent)', color: 'var(--good)', fontSize: 12 }}>
              ✓ All Clear
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, borderBottom: '1px solid var(--border)', paddingBottom: 0 }}>
        {(['overview', 'grafana', 'alerts'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              background: 'none', border: 'none',
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
              color: tab === t ? 'var(--accent)' : 'var(--text-dim)',
              padding: '8px 16px', cursor: 'pointer',
              fontFamily: "'Rajdhani', sans-serif", fontWeight: 600,
              fontSize: 13, letterSpacing: '0.05em', textTransform: 'uppercase',
              marginBottom: -1,
            }}
          >
            {t}{t === 'alerts' && firingCount > 0 ? ` (${firingCount})` : ''}
          </button>
        ))}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* TAB: OVERVIEW                                                        */}
      {/* ------------------------------------------------------------------ */}
      {tab === 'overview' && (
        <div>
          {/* Node stat cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16, marginBottom: 24 }}>
            {nodes.sort((a, b) => a.node.localeCompare(b.node)).map(n => (
              <div key={n.node} style={{ background: 'var(--surface-notice)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <div style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 14, color: 'var(--text-bright)', letterSpacing: '0.08em' }}>
                    {n.node.toUpperCase()}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--good)', border: '1px solid color-mix(in srgb, var(--good) 19%, transparent)', padding: '2px 6px', borderRadius: 3 }}>
                    ONLINE
                  </div>
                </div>

                {/* Sparkline */}
                <div style={{ marginBottom: 12 }}>
                  <Sparkline values={history[n.node] || []} color="var(--accent)" />
                  <div style={{ fontSize: 10, color: 'var(--text-dimmer)', marginTop: 2 }}>CPU — 1hr</div>
                </div>

                {/* Stat bars */}
                {[
                  { label: 'CPU',    value: n.cpu,    color: 'var(--accent)' },
                  { label: 'MEMORY', value: n.memory, color: 'var(--violet)' },
                  { label: 'DISK',   value: n.disk,   color: 'var(--warn)' },
                ].map(s => (
                  <div key={s.label} style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                      <span style={{ fontSize: 10, color: 'var(--text-dimmer)' }}>{s.label}</span>
                      <span style={{ fontSize: 10, color: s.color }}>{(s.value || 0).toFixed(1)}%</span>
                    </div>
                    <Bar value={s.value} color={s.color} />
                  </div>
                ))}

                {/* Load */}
                <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-dimmer)' }}>
                  LOAD <span style={{ color: 'var(--text-bright)' }}>{(n.load || 0).toFixed(2)}</span>
                </div>
                {/* Network */}
                <div style={{ marginTop: 6, display: 'flex', gap: 12, fontSize: 10, color: 'var(--text-dimmer)' }}>
                  <span>↓ <span style={{ color: 'var(--good)' }}>{((n.rxKBs||0) >= 1024 ? ((n.rxKBs||0)/1024).toFixed(1)+' MB/s' : (n.rxKBs||0).toFixed(1)+' KB/s')}</span></span>
                  <span>↑ <span style={{ color: 'var(--warn)' }}>{((n.txKBs||0) >= 1024 ? ((n.txKBs||0)/1024).toFixed(1)+' MB/s' : (n.txKBs||0).toFixed(1)+' KB/s')}</span></span>
                </div>
              </div>
            ))}
          </div>

          <div style={{ marginBottom: 24 }}><PluginCards heading="" /></div>

          {/* Recent alerts preview */}
          {alerts.length > 0 && (
            <div style={{ background: 'var(--surface-notice)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 11, color: 'color-mix(in srgb, var(--accent) 53%, transparent)', letterSpacing: '0.1em', marginBottom: 12 }}>
                ACTIVE ALERTS
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {alerts.filter(a => a.state === 'firing').slice(0, 5).map((a, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: 10, borderRadius: 6, background: severityBg(a.severity), border: `1px solid ${severityColor(a.severity)}30` }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: severityColor(a.severity), flexShrink: 0, marginTop: 3, boxShadow: `0 0 6px ${severityColor(a.severity)}` }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, color: 'var(--text-bright)', fontWeight: 500 }}>{a.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{a.summary || a.description}</div>
                      {a.node && <div style={{ fontSize: 10, color: 'var(--text-dimmer)', marginTop: 2 }}>Node: {a.node}</div>}
                    </div>
                    <div style={{ fontSize: 10, color: severityColor(a.severity), flexShrink: 0, padding: '2px 6px', border: `1px solid ${severityColor(a.severity)}40`, borderRadius: 3 }}>
                      {a.severity.toUpperCase()}
                    </div>
                  </div>
                ))}
              </div>
              {alerts.filter(a => a.state === 'firing').length > 5 && (
                <button onClick={() => setTab('alerts')} style={{ marginTop: 8, background: 'none', border: 'none', color: 'var(--accent)', fontSize: 11, cursor: 'pointer', fontFamily: "'IBM Plex Mono', monospace" }}>
                  View all {alerts.filter(a => a.state === 'firing').length} alerts →
                </button>
              )}
            </div>
          )}

          {alerts.filter(a => a.state === 'firing').length === 0 && !loading && (
            <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-dimmer)', fontSize: 12 }}>
              <div style={{ fontSize: 24, marginBottom: 8 }}>✓</div>
              No active alerts — cluster is healthy
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* TAB: GRAFANA                                                         */}
      {/* ------------------------------------------------------------------ */}
      {tab === 'grafana' && (
        <div>
          {/* Dashboard selector */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {DASHBOARDS.map(d => (
              <button
                key={d.uid}
                onClick={() => setGrafanaDash(d.uid)}
                style={{
                  padding: '6px 14px', borderRadius: 4, cursor: 'pointer',
                  background: grafanaDash === d.uid ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'transparent',
                  border: `1px solid ${grafanaDash === d.uid ? 'color-mix(in srgb, var(--accent) 25%, transparent)' : 'var(--border-soft)'}`,
                  color: grafanaDash === d.uid ? 'var(--accent)' : 'var(--text-dim)',
                  fontSize: 12, fontFamily: "'IBM Plex Mono', monospace",
                }}
              >
                {d.title}
              </button>
            ))}
            <a
              href={`${GRAFANA}/dashboards`}
              target="_blank"
              rel="noreferrer"
              style={{ marginLeft: 'auto', padding: '6px 14px', borderRadius: 4, border: '1px solid var(--border-soft)', color: 'var(--text-dimmer)', fontSize: 12, textDecoration: 'none', fontFamily: "'IBM Plex Mono', monospace" }}
            >
              Open Grafana ↗
            </a>
          </div>

          {/* Grafana embed */}
          <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border-soft)', height: 'calc(100vh - 220px)' }}>
            <iframe
              key={grafanaDash}
              src={`${GRAFANA}/d/${grafanaDash}?orgId=1&refresh=30s&kiosk&theme=dark&${DASHBOARDS.find(d=>d.uid===grafanaDash)?.vars||''}`}
              width="100%"
              height="100%"
              frameBorder="0"
              style={{ display: 'block', background: 'var(--ground)' }}
            />
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* TAB: ALERTS                                                          */}
      {/* ------------------------------------------------------------------ */}
      {tab === 'alerts' && (
        <div>
          {alerts.length === 0 && !loading && (
            <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-dimmer)', fontSize: 12 }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>✓</div>
              No alerts — all systems healthy
            </div>
          )}

          {['critical', 'warning', 'info'].map(sev => {
            const sevAlerts = alerts.filter(a => a.severity === sev)
            if (!sevAlerts.length) return null
            return (
              <div key={sev} style={{ marginBottom: 24 }}>
                <div style={{ fontSize: 11, color: severityColor(sev), letterSpacing: '0.1em', marginBottom: 12 }}>
                  {sev.toUpperCase()} — {sevAlerts.length} alert{sevAlerts.length !== 1 ? 's' : ''}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {sevAlerts.map((a, i) => (
                    <div key={i} style={{ background: 'var(--surface-notice)', border: `1px solid ${severityColor(a.severity)}30`, borderLeft: `3px solid ${severityColor(a.severity)}`, borderRadius: 6, padding: 16 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                        <div style={{ fontSize: 14, color: 'var(--text-bright)', fontFamily: "'Rajdhani', sans-serif", fontWeight: 600 }}>{a.name}</div>
                        <div style={{ fontSize: 10, padding: '2px 8px', borderRadius: 3, background: severityBg(a.severity), color: severityColor(a.severity), border: `1px solid ${severityColor(a.severity)}40`, flexShrink: 0 }}>
                          {a.state.toUpperCase()}
                        </div>
                      </div>
                      {a.summary && <div style={{ fontSize: 12, color: 'var(--text-soft)', marginBottom: 6 }}>{a.summary}</div>}
                      {a.description && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>{a.description}</div>}
                      <div style={{ display: 'flex', gap: 16, fontSize: 10, color: 'var(--text-dimmer)' }}>
                        {a.node && <span>Node: <span style={{ color: 'var(--text-muted)' }}>{a.node}</span></span>}
                        {a.firedAt && <span>Since: <span style={{ color: 'var(--text-muted)' }}>{new Date(a.firedAt).toLocaleString()}</span></span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
