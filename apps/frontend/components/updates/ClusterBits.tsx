'use client'

// The cluster an Updates page is for, said everywhere it matters: teal for home, amber with REMOTE and the name
// for a remote. The page is /updates for home and /clusters/<id>/updates for a remote; every API call from a
// remote's page carries its cluster (lib/api.ts), so what is shown and what is changed are the same machine.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { UpdatesCheckCluster, UpdatesCheckStatus, UpdatesClusterRef, UpdatesRebootPreview } from '@hyperprox/types'
import { pageClusterId } from '@/lib/api'
import { useClusters, clusterColor, clusterInk, ago } from '@/lib/clusters'
import { Badge, Btn, Empty, Notice, Panel, fmtTime } from './ui'

export function useUpdatesCluster(): UpdatesClusterRef & { loaded: boolean; all: UpdatesClusterRef[] } {
  const path = usePathname() ?? ''
  const id = pageClusterId(path) ?? 'home'
  const { clusters } = useClusters()
  const all: UpdatesClusterRef[] = (clusters ?? []).map(c => ({ id: c.id, name: c.name, kind: c.kind }))
  const c = all.find(x => x.id === id)
  return { id, name: c?.name ?? (id === 'home' ? 'Home cluster' : 'Remote server'), kind: id === 'home' ? 'home' : 'remote', loaded: !!clusters, all }
}

export const updatesHref = (c: { id: string; kind: string }) => (c.kind === 'home' ? '/updates' : `/clusters/${c.id}/updates`)

/** "HOME · Home cluster" in teal, "REMOTE · Remote server" in amber. On every card, preview and confirmation. */
export function ClusterTag({ c }: { c: Pick<UpdatesClusterRef, 'name' | 'kind'> }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 font-mono uppercase"
          style={{ fontSize: 10.5, letterSpacing: '0.08em', background: clusterColor(c.kind), color: clusterInk(c.kind) }}>
      {c.kind === 'remote' ? 'remote' : 'home'} · <span style={{ textTransform: 'none', letterSpacing: 0 }}>{c.name}</span>
    </span>
  )
}

/** The banner at the top of a remote's Updates page, and the switcher between clusters. */
export function ClusterHeader({ c }: { c: ReturnType<typeof useUpdatesCluster> }) {
  return (
    <div className="space-y-2">
      {c.kind === 'remote' && (
        <div className="rounded-md px-4 py-2 font-semibold" role="status" style={{ background: 'var(--remote)', color: 'var(--remote-ink)' }}>
          <span className="uppercase" style={{ letterSpacing: '0.04em' }}>Updating: {c.name}</span>{' '}
          <small className="font-medium" style={{ opacity: 0.85 }}>Everything on this page happens on that server, not on your home cluster.</small>
        </div>
      )}
      {c.all.length > 1 && (
        <nav aria-label="Which cluster" className="flex flex-wrap gap-2">
          {c.all.map(x => (
            <Link key={x.id} href={updatesHref(x)} aria-current={x.id === c.id ? 'page' : undefined}
                  className="rounded-md border px-2.5 py-1 text-xs font-semibold"
                  style={{ borderColor: clusterColor(x.kind), color: x.id === c.id ? clusterInk(x.kind) : clusterColor(x.kind), background: x.id === c.id ? clusterColor(x.kind) : 'transparent' }}>
              {x.kind === 'remote' ? 'REMOTE · ' : 'HOME · '}{x.name}
            </Link>
          ))}
        </nav>
      )}
    </div>
  )
}

function checkLine(r: UpdatesCheckCluster): string {
  if (r.result === 'skipped') return `Not checked ${fmtTime(r.at)}: ${r.reason ?? 'skipped'}.${r.lastOkAt ? ` Last full check ${fmtTime(r.lastOkAt)}.` : ''}`
  if (!r.available) return `Checked ${fmtTime(r.at)}: nothing to update.${r.unread.length ? ` ${r.unread.length} not read.` : ''}`
  return `Checked ${fmtTime(r.at)}: ${r.available} machine${r.available === 1 ? '' : 's'} with updates, ${r.packages} package${r.packages === 1 ? '' : 's'}${r.security ? `, ${r.security} security` : ''}.${r.unread.length ? ` ${r.unread.length} not read.` : ''}`
}

/** The daily read-only check: when it last ran, what it found per cluster, and Check now. */
export function CheckPanel({ status, error, busy, onCheck, current }: {
  status: UpdatesCheckStatus | null; error: string | null; busy: boolean; onCheck: () => void; current: string
}) {
  return (
    <Panel title="Daily check" right={
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Read-only: refreshes package lists and asks apt what it would do. {status?.nextRun ? `Next ${fmtTime(status.nextRun)}.` : ''}
        </span>
        <Btn small onClick={onCheck} disabled={busy || !!status?.running}>{status?.running ? 'Checking…' : 'Check now'}</Btn>
      </div>
    }>
      {error ? <div className="p-5"><Notice tone="warn">{error}</Notice></div>
        : !status ? <Empty>Reading the last check…</Empty>
        : !status.clusters.length ? <Empty>No check has run yet.</Empty>
        : (
          <ul className="divide-y" style={{ borderColor: 'var(--border-dim)' }}>
            {status.clusters.map(r => (
              <li key={r.cluster.id} className="flex flex-wrap items-center gap-2 px-5 py-2.5 text-sm" style={{ background: r.cluster.id === current ? 'var(--ground-inset)' : undefined }}>
                <ClusterTag c={r.cluster} />
                {r.security > 0 && <Badge tone="crit">security</Badge>}
                <span style={{ color: r.result === 'skipped' ? 'var(--warn-2)' : 'var(--text)' }}>{checkLine(r)}</span>
                {r.cluster.id !== current && <Link href={updatesHref(r.cluster)} className="ml-auto text-xs font-semibold" style={{ color: clusterColor(r.cluster.kind) }}>Open ›</Link>}
              </li>
            ))}
          </ul>
        )}
      {status?.lastNotified && <p className="px-5 pb-3 text-xs" style={{ color: 'var(--text-dimmer)' }}>Last message to the Updates channels {ago(Date.parse(status.lastNotified))}.</p>}
    </Panel>
  )
}

/** What a remote one-node server's reboot takes down, in words, before the re-confirmed reboot. */
export function RebootPreviewList({ pv }: { pv: UpdatesRebootPreview }) {
  return (
    <div className="space-y-2 text-sm" style={{ color: 'var(--text-soft)' }}>
      <ul className="list-disc space-y-1.5 pl-5">
        <li>Nothing is moved first: {pv.standalone ? 'this server has no other node' : 'HyperProx reboots only one-node servers on a remote'}.</li>
        <li>Running now, and stopping until it is back: {pv.goingDown.length ? pv.goingDown.map(g => `${g.vmid} (${g.name})${g.onboot ? '' : ' — stays stopped'}`).join(', ') : 'none'}.</li>
        <li>Running kernel {pv.runningKernel ?? 'unknown'}; after the reboot {pv.bootsKernel ?? 'unknown'}.{pv.rebootNeeded ? '' : ' No reboot is needed right now.'}</li>
        <li>HyperProx waits up to 15 minutes for a new boot, then reports the kernel and which guests came back. It changes nothing else.</li>
      </ul>
      {pv.warnings.map((w, i) => <Notice key={i} tone="warn">{w}</Notice>)}
    </div>
  )
}
