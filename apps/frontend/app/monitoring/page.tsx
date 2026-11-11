'use client'

import { useEffect, useState, useCallback } from 'react'
import { PluginCards } from '@/components/plugins/PluginCards'
import { WebsitesPanel, fetchSiteAlerts, siteAlertAsMonitoringAlert } from '@/components/sites/metrics/WebsitesPanel'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { Page, Panel, HudHeader, Feed, NodeTile, NodeTiles, GlowBars, Pill, Spark, styles, type StatChip, type FeedTone } from '@/components/visual/kit'

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

// Same origin, through nginx, which lets only signed-in users through (Grafana itself is on loopback).
const GRAFANA = process.env.NEXT_PUBLIC_GRAFANA_URL || '/grafana'
const DASHBOARDS = [
  { uid: 'hyperprox-cluster', title: 'Cluster Overview', orgId: 1, vars: '' },
  { uid: 'hyperprox-plugins', title: 'Plug-ins',         orgId: 1, vars: '' },
  { uid: 'hyperprox-websites', title: 'Websites',        orgId: 1, vars: '' },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const feedTone = (s: string): FeedTone => (s === 'critical' ? 'bad' : s === 'warning' ? 'warn' : 'ok')
const pillTone = (s: string) => (s === 'critical' ? 'bad' as const : s === 'warning' ? 'warn' as const : 'accent' as const)
const speed = (kbs: number) => (kbs >= 1024 ? `${(kbs / 1024).toFixed(1)} MB/s` : `${kbs.toFixed(1)} KB/s`)

function AlertFeed({ list, label }: { list: Alert[]; label: string }) {
  return (
    <Feed label={label} items={list.map((a, i) => ({
      key: `${a.name}-${a.node}-${i}`, tone: feedTone(a.severity),
      title: <>{a.name} <Pill tone={pillTone(a.severity)}>{a.severity}</Pill> <Pill>{a.state}</Pill></>,
      detail: a.summary || a.description,
      meta: [a.node && `Node: ${a.node}`, a.firedAt && `Since: ${new Date(a.firedAt).toLocaleString()}`].filter(Boolean).join(' · ') || undefined,
    }))} />
  )
}

// ---------------------------------------------------------------------------
// The PVE exporter's read-only token (Grafana's Proxmox panels read through it)
// ---------------------------------------------------------------------------
interface ExporterStatus { configured: boolean; tokenId?: string; readOnly: boolean | null; reasons?: string[]; checkError?: string }

function PveExporterPanel() {
  const { role } = useSession()
  const [st, setSt]       = useState<ExporterStatus | null>(null)
  const [busy, setBusy]   = useState(false)
  const [msg, setMsg]     = useState<{ ok: boolean; text: string } | null>(null)
  // Proxmox says the token is not read-only: the next press asks for a fresh one.
  const [fresh, setFresh] = useState(false)

  const load = useCallback(async () => {
    const r = await apiJson<{ data: ExporterStatus }>('/api/monitoring/pve-exporter')
    if (r.ok && r.body) { setSt(r.body.data); setFresh(r.body.data.readOnly === false && !!r.body.data.configured) }
  }, [])
  useEffect(() => { load() }, [load])

  // Nothing to say once Proxmox confirms the exporter's token is read-only.
  if (!st || (st.configured && st.readOnly === true && !msg)) return null

  const setup = async () => {
    setBusy(true); setMsg(null)
    const r = await apiJson<{ data: { tokenId: string; restarted: boolean } }>('/api/monitoring/pve-exporter', 'POST', fresh ? { fresh: true } : undefined)
    setBusy(false)
    if (r.ok && r.body) {
      setMsg({ ok: true, text: `Read-only token ${r.body.data.tokenId} is in place${r.body.data.restarted ? ' and the exporter was restarted' : ''}. Proxmox panels fill in within a minute.` })
      setFresh(false)
      load()
    } else {
      if (r.code === 'not_read_only') setFresh(true)
      setMsg({ ok: false, text: r.error || 'Could not set up the token' })
    }
  }

  const why = !st.configured
    ? 'The PVE exporter has no Proxmox token yet, so Grafana\'s Proxmox panels are empty.'
    : st.readOnly === false
      ? `The PVE exporter signs in as ${st.tokenId}, which is not read-only: ${(st.reasons ?? []).join('; ')}.`
      : `The PVE exporter signs in as ${st.tokenId}; Proxmox could not be asked whether it is read-only (${st.checkError ?? 'unknown'}).`
  return (
    <div className={styles.callout} role="status" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 320px', color: msg ? (msg.ok ? 'var(--good)' : 'var(--crit)') : 'var(--text-soft)' }}>
        {msg ? msg.text : why}
        {!msg && !atLeast(role, 'admin') && ' An admin can set up a read-only token here.'}
      </div>
      {atLeast(role, 'admin') && !(msg && msg.ok) && (
        <button onClick={setup} disabled={busy} className={`${styles.btn} ${styles.btnPri}`}>
          {busy ? 'Setting up…' : fresh ? 'Make a fresh read-only token' : 'Set up Proxmox metrics'}
        </button>
      )}
    </div>
  )
}

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
      const [alertsRes, nodesRes, siteAlerts] = await Promise.all([
        fetch('/api/prometheus/alerts'),
        fetch('/api/prometheus/nodes'),
        fetchSiteAlerts().catch(() => []),
      ])

      const alertsJson = await alertsRes.json()
      const nodesJson  = await nodesRes.json()

      // Website alerts (lib/site-metrics) sit beside Prometheus's in the same feed.
      if (alertsJson.success || siteAlerts.length) setAlerts([...(alertsJson.success ? alertsJson.data : []), ...siteAlerts.map(siteAlertAsMonitoringAlert)])
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
  const sortedNodes = [...nodes].sort((a, b) => a.node.localeCompare(b.node))
  const firing = alerts.filter(a => a.state === 'firing')
  const chips: StatChip[] = [
    { label: 'critical', value: criticalAlerts.length, tone: criticalAlerts.length ? 'crit' : 'dim' },
    { label: 'warnings', value: warningAlerts.length, tone: warningAlerts.length ? 'warn' : 'dim' },
    { label: 'nodes reporting', value: nodes.length, tone: 'accent' },
  ]
  const title = loading ? 'Reading the metrics…' : criticalAlerts.length ? `${criticalAlerts.length} critical alert${criticalAlerts.length === 1 ? '' : 's'} firing`
    : warningAlerts.length ? `${warningAlerts.length} warning${warningAlerts.length === 1 ? '' : 's'} firing` : firingCount ? `${firingCount} alert${firingCount === 1 ? '' : 's'} firing` : 'All clear'
  const tabs = ['overview', 'grafana', 'alerts'] as const

  return (
    <Page>
      <HudHeader level={2} label="Monitoring status" eyebrow="Prometheus + Grafana"
        title={title} chips={chips}
        icon="alarm">
        <p style={{ margin: 0, color: 'var(--text-soft)', fontSize: 14 }}>{lastUpdate ? `Updated ${lastUpdate.toLocaleTimeString()}` : 'Loading...'}</p>
      </HudHeader>

      <div className={styles.row} role="group" aria-label="Monitoring view">
        {tabs.map(t => (
          <button key={t} onClick={() => setTab(t)} aria-pressed={tab === t} className={`${styles.btn} ${tab === t ? styles.btnPri : ''}`}>
            {t === 'overview' ? 'Overview' : t === 'grafana' ? 'Grafana' : 'Alerts'}{t === 'alerts' && firingCount > 0 ? ` (${firingCount})` : ''}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <Panel title="Nodes" sub="CPU · memory · disk · last hour">
            {sortedNodes.length === 0 ? <p className={styles.empty}>{loading ? 'Loading…' : 'No node metrics yet.'}</p> : (
              <NodeTiles label="Node metrics">
                {sortedNodes.map(n => (
                  <NodeTile key={n.node} name={n.node} cpu={n.cpu || 0} mem={n.memory || 0} sub={`disk ${(n.disk || 0).toFixed(1)}% · load ${(n.load || 0).toFixed(2)}`}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
                      <Spark data={history[n.node] || []} max={100} />
                      <span className="font-mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>CPU, last hour</span>
                      <span className="font-mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        <span style={{ color: 'var(--good)' }}>↓ {speed(n.rxKBs || 0)}</span> · <span style={{ color: 'var(--warn)' }}>↑ {speed(n.txKBs || 0)}</span>
                      </span>
                    </div>
                  </NodeTile>
                ))}
              </NodeTiles>
            )}
          </Panel>

          {sortedNodes.length > 0 && (
            <Panel title="Disk" sub="used per node">
              <GlowBars label="Disk used per node" max={100} hiAt={70}
                items={sortedNodes.map(n => ({ key: n.node, label: n.node, value: n.disk || 0, text: `${(n.disk || 0).toFixed(1)}%` }))} />
            </Panel>
          )}

          <PluginCards heading="" />

          <WebsitesPanel />

          {firing.length > 0 && (
            <Panel title="Active alerts" sub={`${firing.length} firing`}>
              <AlertFeed list={firing.slice(0, 5)} label="Active alerts" />
              {firing.length > 5 && (
                <button onClick={() => setTab('alerts')} className={`${styles.btn} ${styles.btnGhost}`} style={{ marginTop: 10 }}>
                  View all {firing.length} alerts →
                </button>
              )}
            </Panel>
          )}

          {firing.length === 0 && !loading && (
            <Panel title="Alerts"><p className={styles.empty}>No active alerts — cluster is healthy</p></Panel>
          )}
        </>
      )}

      {tab === 'grafana' && (
        <>
          <PveExporterPanel />
          <Panel title="Grafana" sub="live dashboards"
            actions={<a href={`${GRAFANA}/dashboards`} target="_blank" rel="noreferrer" className={styles.btn}>Open Grafana ↗</a>}>
            <div className={styles.row} role="group" aria-label="Dashboard" style={{ marginBottom: 12 }}>
              {DASHBOARDS.map(d => (
                <button key={d.uid} onClick={() => setGrafanaDash(d.uid)} aria-pressed={grafanaDash === d.uid} className={`${styles.btn} ${grafanaDash === d.uid ? styles.btnPri : ''}`}>
                  {d.title}
                </button>
              ))}
            </div>
            <div style={{ borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)', height: 'calc(100vh - 260px)', minHeight: 360 }}>
              <iframe
                key={grafanaDash}
                title={DASHBOARDS.find(d => d.uid === grafanaDash)?.title ?? 'Grafana dashboard'}
                src={`${GRAFANA}/d/${grafanaDash}?orgId=1&refresh=30s&kiosk&theme=dark&${DASHBOARDS.find(d=>d.uid===grafanaDash)?.vars||''}`}
                width="100%"
                height="100%"
                frameBorder="0"
                style={{ display: 'block', background: 'var(--ground)' }}
              />
            </div>
          </Panel>
        </>
      )}

      {tab === 'alerts' && (
        <>
          {alerts.length === 0 && !loading && <Panel title="Alerts"><p className={styles.empty}>No alerts — all systems healthy</p></Panel>}
          {['critical', 'warning', 'info'].map(sev => {
            const sevAlerts = alerts.filter(a => a.severity === sev)
            if (!sevAlerts.length) return null
            return (
              <Panel key={sev} title={sev === 'critical' ? 'Critical' : sev === 'warning' ? 'Warning' : 'Info'} sub={`${sevAlerts.length} alert${sevAlerts.length !== 1 ? 's' : ''}`}>
                <AlertFeed list={sevAlerts} label={`${sev} alerts`} />
              </Panel>
            )
          })}
        </>
      )}
    </Page>
  )
}
