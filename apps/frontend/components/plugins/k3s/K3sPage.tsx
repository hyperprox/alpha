'use client'

// =============================================================================
//  HyperProx — K3s: each cluster, visual first
//
//  Phone first: one column of panels. The HUD (nodes ready, pods running,
//  problems, version), a health band with its reasons, the pods in trouble as
//  glowing cards with their reason, last log lines and fix buttons, every node
//  as a card with CPU and memory rings, workloads as tiles with desired
//  against ready, warning events as a feed, ingresses and services with their
//  addresses, namespaces, and the plain tables folded into Details.
//
//  Actions (admin; the master password re-entered; each one confirmed first,
//  with what it does in words): restart, roll back or scale a workload, delete
//  a pod, cordon, uncordon or drain a node (the drain shows what moves, stays
//  and is lost first). Logs are admin too: they hold whatever an app printed.
// =============================================================================

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { BusyNote, GhostButton, INPUT, LABEL, Modal, Notice, PrimaryButton } from '@/components/vault/ui'
import { Feed, HudHeader, Icon, Panel, Tiles, styles as vs } from '@/components/visual/kit'
import { DetailsSection, PluginSwitcher } from '@/components/plugins/visual/plugin-kit'
import { AutoConnectedNote } from '@/components/plugins/AutoConnect'
import k from './k3s.module.css'
import { DrainSummary, NetworkView, NodeCard, ProblemCard, WorkloadTile } from './parts'
import { ago, confirmText, healthWord, type Cluster, type DrainPlan, type Fix, type Reading, type Waiting } from './logic'

const API = '/api/plugins/k3s'
type Data = { ok: boolean; reading?: Reading; error?: string }

function useClusters() {
  const [list, setList] = useState<Cluster[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    const r = await apiJson<{ data: Cluster[] }>(`${API}/clusters`)
    if (r.ok) { setList(r.body!.data ?? []); setError(null) } else setError(r.error ?? 'Could not read the cluster list')
  }, [])
  useEffect(() => { void reload() }, [reload])
  return { list, error, reload }
}

const fixId = (f: Fix) => `${f.action}:${f.target.namespace ?? ''}/${f.target.name}`

// ── one cluster ──────────────────────────────────────────────────────────────

function ClusterView({ c, admin, onRemoved }: { c: Cluster; admin: boolean; onRemoved: () => void }) {
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null)
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const [ask, setAsk] = useState<{ fix: Fix; replicas?: number; drain?: DrainPlan | null; lostOk?: boolean } | null>(null)
  const [logs, setLogs] = useState<{ title: string; lines: string[] | null; error?: string } | null>(null)
  const [showAll, setShowAll] = useState(false)
  const inFlight = useRef(false)

  const load = useCallback(async (fresh = false) => {
    if (inFlight.current) return
    inFlight.current = true; setLoading(true)
    const r = await apiJson<{ data: Data }>(`${API}/clusters/${c.id}/reading${fresh ? '?fresh=1' : ''}`)
    inFlight.current = false; setLoading(false)
    setData(r.ok ? r.body!.data : { ok: false, error: r.error ?? 'Could not read the cluster.' })
  }, [c.id])

  // Pods change by the second: every 30 seconds while the tab is visible.
  useEffect(() => {
    void load()
    const t = setInterval(() => { if (!document.hidden) void load() }, 30_000)
    return () => clearInterval(t)
  }, [load])

  const run = async (f: Fix, body: Record<string, unknown>): Promise<void> => {
    setBusy(fixId(f)); setNote(null)
    const r = await apiJson<{ data: { done: string } }>(`${API}/clusters/${c.id}/actions/${f.action}`, 'POST', { kind: f.target.kind, namespace: f.target.namespace, name: f.target.name, ...body })
    setBusy(null)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void run(f, body)); return }
    setNote(r.ok ? { text: r.body!.data.done, ok: true } : { text: r.error ?? 'That did not work.', ok: false })
    if (r.ok) setTimeout(() => void load(true), 1500)
  }

  const onFix = async (f: Fix) => {
    if (f.action === 'logs') {
      setLogs({ title: `${f.target.namespace}/${f.target.name}`, lines: null })
      const q = new URLSearchParams({ namespace: f.target.namespace ?? '', pod: f.target.name, ...(f.target.container ? { container: f.target.container } : {}), previous: '1' })
      const r = await apiJson<{ data: { container: string; lines: string[] } }>(`${API}/clusters/${c.id}/logs?${q}`)
      setLogs(r.ok ? { title: `${f.target.namespace}/${f.target.name} · ${r.body!.data.container}`, lines: r.body!.data.lines } : { title: f.target.name, lines: [], error: r.error ?? 'The logs could not be read.' })
      return
    }
    if (f.action === 'add-agent') { window.location.href = '/catalogue?recipe=k3s-agent'; return }
    if (f.action === 'drain') {
      setAsk({ fix: f, drain: null })
      const r = await apiJson<{ data: DrainPlan }>(`${API}/clusters/${c.id}/drain-preview`, 'POST', { node: f.target.name })
      if (!r.ok) { setAsk(null); setNote({ text: r.error ?? 'What the drain would move could not be read.', ok: false }); return }
      setAsk({ fix: f, drain: r.body!.data, lostOk: false })
      return
    }
    const w = r?.workloads.find(x => x.kind === f.target.kind && x.namespace === f.target.namespace && x.name === f.target.name)
    setAsk({ fix: f, replicas: f.action === 'scale' ? Math.max(0, (w?.desired ?? 1) - 1) : undefined })
  }

  const r = data?.reading
  const ready = r ? r.nodes.filter(n => n.ready).length : 0
  const shownWorkloads = r ? (showAll ? r.workloads : r.workloads.filter(w => w.namespace !== 'kube-system' || w.problem)) : []

  return (
    <div className={vs.page}>
      {!data && <BusyNote>Reading {c.name}…</BusyNote>}
      {data && !data.ok && <Notice kind="error">{data.error} The page tries again every 30 seconds.</Notice>}
      {c.via === 'auto-connect' && <AutoConnectedNote evidence={['found on the network, its K3s login read from inside its guest']} />}
      {r && (
        <>
          <HudHeader level={2} label={`${c.name} overview`} eyebrow={`K3s${r.version.current ? ` · ${r.version.current}` : ''}`} title={c.name}
            ring={{ value: r.nodes.length ? ready / r.nodes.length : 0, text: `${ready}/${r.nodes.length}`, label: 'nodes ready' }}
            chips={[
              { label: 'pods running', value: `${r.counts.running}/${r.counts.pods}` },
              { label: 'in trouble', value: r.problems.length, tone: r.problems.some(p => p.state !== 'pending' && p.state !== 'restarting') ? 'crit' : r.problems.length ? 'warn' : 'good' },
              { label: 'warnings 1 h', value: r.events.length, tone: r.events.length ? 'warn' : 'good' },
              { label: 'workloads', value: r.workloads.length },
            ]}
            actions={
              <div className={k.toolbar}>
                <button type="button" className={vs.btn} disabled={loading} onClick={() => void load(true)}><Icon name="check" size={14} /> {loading ? 'Reading…' : 'Refresh'}</button>
                <small>read {ago(Date.parse(r.fetchedAt))}</small>
              </div>
            } />
          <div className={k.band} data-state={r.health.state} role="status">
            <b>{healthWord(r.health)}</b>
            <span>{r.health.state === 'ok' ? 'Every node is ready and no pod is in trouble.' : r.health.reasons.join(' · ')}</span>
          </div>
          {r.version.upgrade && (
            <p className={k.upgrade} role="status"><Icon name="warn" size={14} /> A newer stable K3s is out: <b>{r.version.upgrade}</b> (this cluster runs {r.version.current}).
              Upgrade one node at a time: drain it, run K3s&apos;s install with the new version, uncordon it.</p>
          )}
          {note && <p className="text-sm" role="status" style={{ color: note.ok ? 'var(--good)' : 'var(--warn-2)' }}>{note.text}</p>}
          {r.missing.length > 0 && <Notice kind="info">Not read this time: {r.missing.join(', ')}. (Node CPU and memory come from metrics-server, which takes a minute after a start.)</Notice>}

          <Panel title="Pods in trouble" sub={r.problems.length ? 'each with what can fix it' : undefined}>
            {r.problems.length === 0 ? <p className="text-sm" style={{ color: 'var(--good)' }}>No pod is crashing, pending or restarting.</p> : (
              <div className={k.problems}>{r.problems.map(p => <ProblemCard key={`${p.namespace}/${p.name}`} p={p} admin={admin} busy={busy} onFix={f => void onFix(f)} />)}</div>
            )}
            {admin && r.problems.some(p => p.fixes.some(f => f.action === 'add-agent')) && (
              <p className="mt-2 text-[12px]" style={{ color: 'var(--text-dimmer)' }}>
                Pending pods need room: scale something down, or <Link href="/catalogue?recipe=k3s-agent" style={{ color: 'var(--accent)' }}>add a K3s agent on another node</Link>.
              </p>
            )}
          </Panel>

          <Panel title="Nodes" sub={`${ready} of ${r.nodes.length} ready`}>
            <div className={k.nodes}>{r.nodes.map(n => <NodeCard key={n.name} n={n} admin={admin} busy={busy} onFix={f => void onFix(f)} />)}</div>
          </Panel>

          <Panel title="Workloads" sub="ready against desired" actions={
            <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-soft)' }}><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> include kube-system</label>}>
            {shownWorkloads.length === 0 ? <p className={k.quiet}>No workloads of your own yet.</p>
              : <ul className={k.wls}>{shownWorkloads.map(w => <WorkloadTile key={`${w.kind}/${w.namespace}/${w.name}`} w={w} admin={admin} busy={busy} onFix={f => void onFix(f)} />)}</ul>}
          </Panel>

          <Panel title="Warning events" sub="last hour">
            {r.events.length === 0 ? <p className="text-sm" style={{ color: 'var(--good)' }}>No warnings in the last hour.</p> : (
              <Feed label="Warning events" items={r.events.slice(0, 20).map((e, i) => ({
                key: `${e.namespace}/${e.name}/${e.reason}/${i}`, tone: 'warn' as const, title: `${e.reason} · ${e.kind} ${e.name}`,
                detail: e.message, meta: `${e.namespace || 'cluster'}${e.count > 1 ? ` · ×${e.count}` : ''} · ${ago(e.last)}`,
              }))} />
            )}
          </Panel>

          <Panel title="Network" sub="how apps are reached">
            <NetworkView services={r.services} ingresses={r.ingresses} />
          </Panel>

          <Panel title="Namespaces">
            <Tiles label="Namespaces" items={r.namespaces.map(n => ({ label: n.name, value: `${n.pods} pod${n.pods === 1 ? '' : 's'}`, tone: n.problems ? 'warn' : undefined, title: n.problems ? `${n.problems} in trouble` : undefined }))} />
          </Panel>

          <DetailsSection count={3}>
            <section className="rounded-lg border p-3 text-sm" style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text-soft)' }}>
              <p>Reads use HyperProx&apos;s read-only account <code>hyperprox-reader</code> in kube-system (no secrets, no config maps). The buttons use a second account, <code>hyperprox-operator</code>, that can only restart, roll back and scale workloads, delete pods, and cordon, uncordon and drain nodes.</p>
              <p className="mt-2">The admin kubeconfig{c.hasJoinToken ? ' and the join token are' : ' is'} in the vault ({`plugin/k3s.${c.id}.admin`}), where an admin can reveal {c.hasJoinToken ? 'them' : 'it'}. The Kubernetes API stays on your network: HyperProx gives it no public name.</p>
              {c.url && <p className="mt-2 font-mono">{c.url} · CA {c.caFingerprint.slice(0, 29)}…</p>}
            </section>
            {admin && <RemoveCluster c={c} onRemoved={onRemoved} />}
          </DetailsSection>
        </>
      )}

      {ask && (
        <Modal title={ask.fix.action === 'drain' ? `Drain ${ask.fix.target.name}?` : `${ask.fix.label}?`} onClose={() => setAsk(null)} footer={
          <div className="flex justify-end gap-2">
            <GhostButton type="button" onClick={() => setAsk(null)}>Cancel</GhostButton>
            <PrimaryButton type="button" disabled={(ask.fix.action === 'drain' && (!ask.drain || (ask.drain.lost.length > 0 && !ask.lostOk))) || (ask.fix.action === 'scale' && (ask.replicas === undefined || ask.replicas < 0 || ask.replicas > 50))}
              onClick={() => { const a = ask; setAsk(null); void run(a.fix, a.fix.action === 'scale' ? { replicas: a.replicas } : a.fix.action === 'drain' ? { confirmLost: !!a.lostOk } : {}) }}>
              {ask.fix.action === 'drain' ? 'Drain' : ask.fix.label}
            </PrimaryButton>
          </div>}>
          <div className="flex flex-col gap-3">
            <p className="text-sm" style={{ color: 'var(--text-bright)' }}>{ask.fix.target.kind} <b>{ask.fix.target.namespace ? `${ask.fix.target.namespace}/` : ''}{ask.fix.target.name}</b></p>
            {ask.fix.action === 'scale' && (
              <label><span style={LABEL}>Replicas (0 to 50)</span>
                <input style={INPUT} inputMode="numeric" value={ask.replicas ?? ''} onChange={e => setAsk({ ...ask, replicas: e.target.value === '' ? undefined : Number(e.target.value.replace(/[^0-9]/g, '')) })} /></label>
            )}
            {ask.fix.action === 'drain' ? (ask.drain ? <DrainSummary plan={ask.drain} /> : <BusyNote>Reading what runs on {ask.fix.target.name}…</BusyNote>)
              : <p className="text-sm" style={{ color: 'var(--text-soft)' }}>{confirmText(ask.fix, ask.replicas)}</p>}
            {ask.drain && ask.drain.lost.length > 0 && (
              <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--text)' }}>
                <input type="checkbox" checked={!!ask.lostOk} onChange={e => setAsk({ ...ask, lostOk: e.target.checked })} />
                <span>Delete those {ask.drain.lost.length} pod{ask.drain.lost.length === 1 ? '' : 's'} for good</span>
              </label>
            )}
            <small style={{ color: 'var(--text-dimmer)' }}>Done with HyperProx&apos;s action account, recorded in the audit log, and asks for your master password if it has not been entered in the last five minutes.</small>
          </div>
        </Modal>
      )}
      {logs && (
        <Modal title={`Logs: ${logs.title}`} onClose={() => setLogs(null)}>
          {logs.error ? <Notice kind="error">{logs.error}</Notice> : logs.lines === null ? <BusyNote>Reading…</BusyNote>
            : logs.lines.length === 0 ? <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No log lines: the container has not printed anything yet (an image that cannot be pulled never starts).</p>
            : <pre className={k.log} style={{ maxHeight: '60vh' }}>{logs.lines.join('\n')}</pre>}
        </Modal>
      )}
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const f = reconfirm; setReconfirm(null); f() }} />}
    </div>
  )
}

function RemoveCluster({ c, onRemoved }: { c: Cluster; onRemoved: () => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [force, setForce] = useState(false)
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const remove = async () => {
    setBusy(true); setErr(null)
    const r = await apiJson<{ data: { left: string[] } }>(`${API}/clusters/${c.id}${force ? '?force=1' : ''}`, 'DELETE')
    setBusy(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void remove()); return }
    if (!r.ok) { setErr(r.error ?? 'It could not be removed.'); if (r.code === 'revoke_failed') setForce(true); return }
    onRemoved()
  }
  return (
    <section className="flex flex-col gap-2 rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
      <p className="text-sm" style={{ color: 'var(--text-soft)' }}>Removing {c.name} deletes HyperProx&apos;s two accounts in the cluster and its tokens and kubeconfig from the vault. The cluster itself keeps running. Auto-connect will not add it back by itself.</p>
      {err && <Notice kind="error">{err}</Notice>}
      {force && <small style={{ color: 'var(--warn-2)' }}>Removing again removes it from HyperProx anyway; delete hyperprox-reader and hyperprox-operator in kube-system yourself.</small>}
      <div><GhostButton type="button" disabled={busy} onClick={() => void remove()} style={{ color: 'var(--crit-soft)' }}>{busy ? 'Removing…' : force ? 'Remove anyway' : `Remove ${c.name} from HyperProx`}</GhostButton></div>
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const f = reconfirm; setReconfirm(null); f() }} />}
    </section>
  )
}

// ── connecting one HyperProx could not find a login for ──────────────────────

function ConnectForm({ waiting, onCancel, onSaved }: { waiting: Waiting[]; onCancel: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: '', address: '', kubeconfig: '', nodeToken: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const set = (key: keyof typeof f, v: string) => setF(x => ({ ...x, [key]: v }))
  const save = async () => {
    setBusy(true); setErr(null)
    const r = await apiJson(`${API}/clusters`, 'POST', f)
    setBusy(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void save()); return }
    if (!r.ok) { setErr(r.error ?? 'It could not be connected.'); return }
    onSaved()
  }
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      <h3 className="font-display font-semibold" style={{ fontSize: 18, color: 'var(--text-bright)' }}>Connect a K3s cluster</h3>
      <Notice kind="info">
        Only needed for a cluster HyperProx could not read by itself (one outside your Proxmox cluster, or a guest it may not look inside).
        Paste the server&apos;s admin kubeconfig (<code>/etc/rancher/k3s/k3s.yaml</code>). HyperProx uses it once to make two accounts of its own (read-only, and one for the actions you confirm), checks the read-only one cannot read secrets, and keeps the kubeconfig in the vault.
      </Notice>
      {waiting.length > 0 && <Notice kind="warn">Found but not connected: {waiting.map(w => w.label).join(', ')}. {waiting[0].message}</Notice>}
      <label><span style={LABEL}>Name</span><input style={INPUT} value={f.name} onChange={e => set('name', e.target.value)} placeholder="K3s" /></label>
      <label><span style={LABEL}>Server address on your network (when the kubeconfig says 127.0.0.1)</span>
        <input style={INPUT} autoCapitalize="none" value={f.address} onChange={e => set('address', e.target.value)} placeholder="https://10.0.0.40:6443" /></label>
      <label><span style={LABEL}>Kubeconfig</span>
        <textarea style={{ ...INPUT, minHeight: 140, fontFamily: 'var(--font-mono)', fontSize: 12 }} autoCapitalize="none" spellCheck={false} value={f.kubeconfig} onChange={e => set('kubeconfig', e.target.value)} /></label>
      <label><span style={LABEL}>Join token (optional: lets the Catalogue add agents)</span>
        <input style={INPUT} type="password" autoComplete="off" value={f.nodeToken} onChange={e => set('nodeToken', e.target.value)} placeholder="/var/lib/rancher/k3s/server/node-token" /></label>
      {err && <Notice kind="error">{err}</Notice>}
      <div className="flex justify-end gap-2">
        <GhostButton type="button" onClick={onCancel}>Cancel</GhostButton>
        <PrimaryButton type="button" disabled={busy || !f.name || !f.kubeconfig} onClick={() => void save()}>{busy ? 'Connecting…' : 'Check and connect'}</PrimaryButton>
      </div>
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const fn = reconfirm; setReconfirm(null); fn() }} />}
    </div>
  )
}

// ── the plug-in page ─────────────────────────────────────────────────────────

export function K3sPage() {
  const { role } = useSession()
  const { list, error, reload } = useClusters()
  const [sel, setSel] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [waiting, setWaiting] = useState<Waiting[]>([])
  const admin = atLeast(role, 'admin')
  const c = list?.find(i => i.id === sel) ?? list?.[0] ?? null

  useEffect(() => {
    if (!admin) return
    void apiJson<{ data: Waiting[] }>(`${API}/waiting`).then(r => { if (r.ok) setWaiting(r.body!.data ?? []) })
  }, [admin, list])

  return (
    <div className="min-h-full overflow-x-hidden" style={{ background: 'var(--ground)' }}>
      {admin && (
        <div className="flex flex-wrap items-center gap-3 pb-2">
          <span className="ml-auto flex flex-wrap gap-2">
            <Link href="/catalogue?recipe=k3s" className={vs.btn}>Install K3s</Link>
            <GhostButton type="button" onClick={() => setAdding(true)}>Connect a cluster</GhostButton>
          </span>
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-4 py-4">
        <PluginSwitcher current="k3s" />
        {error && <Notice kind="error">{error}</Notice>}
        {!list && !error && <BusyNote>Reading…</BusyNote>}
        {admin && waiting.length > 0 && !adding && (
          <Notice kind="warn">{waiting.length === 1 ? waiting[0].message : `${waiting.length} Kubernetes APIs were found that HyperProx could not read a K3s login from (${waiting.map(w => w.label).join(', ')}). Use "Connect a cluster" with each one's kubeconfig.`}</Notice>
        )}
        {adding && <ConnectForm waiting={waiting} onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); void reload() }} />}
        {list && list.length === 0 && !adding && (
          <Notice kind="info">No K3s cluster yet. {admin ? 'Install one from the Catalogue (K3s), and it is connected here by itself; a K3s server HyperProx finds on your guests is connected by itself too.' : 'An admin can install one from the Catalogue.'}</Notice>
        )}
        {list && c && (
          <>
            {list.length > 1 && (
              <div className={k.tabs} role="tablist" aria-label="Clusters">
                {list.map(i => <button key={i.id} role="tab" aria-selected={i.id === c.id} onClick={() => setSel(i.id)} className={k.tab}>{i.name}</button>)}
              </div>
            )}
            <ClusterView key={c.id} c={c} admin={admin} onRemoved={() => { setSel(null); void reload() }} />
          </>
        )}
      </div>
    </div>
  )
}
