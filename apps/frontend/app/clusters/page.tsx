'use client'

import Link from 'next/link'
import { atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { CommandCenter, useCommandCenter } from '@/components/clusters/CommandCenter'

export default function CommandCenterPage() {
  const { role } = useSession()
  const { data } = useCommandCenter(60_000)
  const totals = data ? data.panels.reduce((a, p) => ({ nodes: a.nodes + p.nodes.total, guests: a.guests + p.guests.running }), { nodes: 0, guests: 0 }) : null
  return (
    <div className="min-h-full px-4 py-5 sm:p-8" style={{ background: 'var(--ground)' }}>
      <div className="max-w-7xl mx-auto flex flex-col gap-5">
        <div className="flex items-end justify-between flex-wrap gap-4">
          <div>
            <div className="font-mono uppercase" style={{ fontSize: 12, letterSpacing: '0.14em', color: 'var(--accent)' }}>All clusters</div>
            <h1 className="font-display font-bold mt-1" style={{ fontSize: 36, lineHeight: 1.1, color: 'var(--text-bright)' }}>Command center</h1>
            {data && totals && (
              <p className="text-sm mt-1" style={{ color: 'var(--text-dimmer)' }}>
                {data.panels.length} {data.panels.length === 1 ? 'cluster' : 'clusters'} · {totals.nodes} nodes · {totals.guests} guests running
              </p>
            )}
          </div>
          {atLeast(role, 'admin') && (
            <Link href="/clusters/add" className="px-4 rounded-md text-sm font-semibold inline-flex items-center" style={{ height: 38, background: 'var(--accent)', color: 'var(--accent-ink)' }}>+ Add a server</Link>
          )}
        </div>
        <CommandCenter />
        <div className="rounded-lg border border-dashed p-3 text-sm" style={{ borderColor: 'var(--border-strong)', color: 'var(--text-muted)' }}>
          Every action on every cluster names the cluster, is checked afterwards, and deleting anything asks you to type its name.
          Secrets come only from the vault; while it is locked nothing runs. Remote servers are never joined to your cluster,
          so a bad connection to one cannot cost you quorum. The files that join a cluster together (corosync) are never touched, on any cluster.
        </div>
      </div>
    </div>
  )
}
