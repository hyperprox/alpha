'use client'

import Link from 'next/link'
import { atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { CommandCenter, useCommandCenter } from '@/components/clusters/CommandCenter'
import { HudHeader, Page, styles as vs, type StatChip } from '@/components/visual/kit'

export default function CommandCenterPage() {
  const { role } = useSession()
  const { data } = useCommandCenter(60_000)
  const totals = data ? data.panels.reduce((a, p) => ({ nodes: a.nodes + p.nodes.total, guests: a.guests + p.guests.running }), { nodes: 0, guests: 0 }) : null
  const chips: StatChip[] = data && totals ? [
    { label: data.panels.length === 1 ? 'cluster' : 'clusters', value: data.panels.length, tone: 'accent' },
    { label: 'nodes', value: totals.nodes },
    { label: 'guests running', value: totals.guests, tone: 'good' },
  ] : []
  return (
    <Page>
      <HudHeader level={2} label="All clusters" eyebrow="All clusters" icon="mesh"
        title={data ? `${data.panels.length} ${data.panels.length === 1 ? 'cluster' : 'clusters'} under one roof` : 'Reading your clusters…'}
        chips={chips}
        actions={atLeast(role, 'admin') ? <Link href="/clusters/add" className={`${vs.btn} ${vs.btnPri}`} style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>+ Add a server</Link> : undefined} />
      <CommandCenter />
      <div className={vs.callout}>
        Every action on every cluster names the cluster, is checked afterwards, and deleting anything asks you to type its name.
        Secrets come only from the vault; while it is locked nothing runs. Remote servers are never joined to your cluster,
        so a bad connection to one cannot cost you quorum. The files that join a cluster together (corosync) are never touched, on any cluster.
      </div>
    </Page>
  )
}
