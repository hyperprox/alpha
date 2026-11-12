'use client'

// =============================================================================
//  HyperProx — Proxmox Backup Server: each server, visual first
//
//  Phone first: one column of panels. The HUD, a health band with its reason,
//  each datastore as a gauge card (used, deduplication, GC), every backup
//  group as a tile that glows red once its newest snapshot is older than the
//  stale threshold, the jobs and the failed tasks as feeds, the optional
//  cluster cross-check, and the plain tables folded into Details.
//
//  Actions: refresh (anyone); "Verify now" and "GC now" per datastore (admin,
//  master password; the server's answer, including which privilege a token
//  lacks, is shown as it came). Nothing here deletes, prunes or forgets.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { BusyNote, GhostButton, INPUT, LABEL, Notice, PrimaryButton } from '@/components/vault/ui'
import { Feed, HudHeader, Icon, Panel, Pill, RingGauge, styles as vs } from '@/components/visual/kit'
import { DetailsSection, PluginSwitcher } from '@/components/plugins/visual/plugin-kit'
import p from './pbs.module.css'

const API = '/api/plugins/pbs'

interface Pin { fingerprint: string; source: 'first-use' | 'ca'; at: string }
export interface Server { id: string; name: string; staleHours: number; pin?: Pin | null; url?: string; tokenId?: string; hasSecret?: boolean }

interface Datastore {
  store: string; total: number | null; used: number | null; avail: number | null; usedFrac: number | null; dedup: number | null
  gc: { lastState: string | null; lastEnd: number | null; next: number | null; schedule: string | null; removedBytes: number | null; pendingBytes: number | null }
  estimatedFull: number | null; error: string | null; groups: number | null; snapshots: number | null
}
interface Group { store: string; ns: string; type: string; id: string; count: number; newest: number | null; size: number | null; verify: 'ok' | 'failed' | 'none'; failedVerifies: number; stale: boolean; ageHours: number | null }
interface Job { kind: 'prune' | 'gc' | 'verify' | 'sync'; id: string; store: string; ns: string | null; schedule: string | null; lastEnd: number | null; result: 'ok' | 'failed' | 'never'; detail: string | null; next: number | null }
interface Task { upid: string; type: string; target: string | null; start: number; end: number | null; status: string }
interface Reading {
  fetchedAt: string; version: string | null; staleHours: number; datastores: Datastore[]; groups: Group[]; jobs: Job[]; failedTasks: Task[]; missing: string[]
  health: { state: 'active' | 'attention'; reason: string | null; reasons: string[] }
}
interface Coverage { clusterId: string; cluster: string; storages: Array<{ storage: string; datastore: string; ns: string }>; noGroup: Array<{ vmid: number; name: string; type: 'vm' | 'ct' }>; notInJob: Array<{ vmid: number; name: string; type: 'vm' | 'ct' }> | null; error?: string }

const FULL_AT = 0.85
const size = (b: number | null) => (b === null ? '—' : b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(2)} TiB` : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(b / 1024 ** 2)} MiB`)
const age = (h: number | null) => (h === null ? 'never' : h < 1 ? 'under 1 h' : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} d ago`)
function when(s: number | null, future = false): string {
  if (!s) return future ? 'not scheduled' : 'never'
  const d = s * 1000 - Date.now()
  const h = Math.abs(d) / 3_600_000
  const words = h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`
  return d >= 0 ? `in ${words}` : `${words} ago`
}
function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function useServers() {
  const [list, setList] = useState<Server[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    const r = await apiJson<{ data: Server[] }>(`${API}/instances`)
    if (r.ok) { setList(r.body!.data ?? []); setError(null) } else setError(r.error ?? 'Could not read the server list')
  }, [])
  useEffect(() => { void reload() }, [reload])
  return { list, error, reload }
}

// ── pieces ───────────────────────────────────────────────────────────────────

function StoreCard({ d, admin, busy, onAct }: { d: Datastore; admin: boolean; busy: string | null; onAct: (action: 'verify' | 'gc', store: string) => void }) {
  const full = d.usedFrac !== null && d.usedFrac >= FULL_AT
  const pct = d.usedFrac === null ? '—' : `${Math.round(d.usedFrac * 100)}%`
  return (
    <article className={p.store} data-full={full ? 'true' : undefined} data-error={d.error ? 'true' : undefined} aria-label={`Datastore ${d.store}`}>
      <div className={p.storeTop}>
        <RingGauge value={d.usedFrac ?? 0} text={pct} label="used" size={92} color={d.error ? 'var(--crit)' : full ? 'var(--warn)' : 'var(--hx-accent)'} />
        <div className="min-w-0">
          <div className={p.storeName}>{d.store}</div>
          <small style={{ color: full ? 'var(--warn-2)' : 'var(--text-muted)' }}>
            {d.error ?? (full ? `over ${Math.round(FULL_AT * 100)}% full` : `${size(d.avail)} free`)}
          </small>
        </div>
      </div>
      <dl className={p.facts}>
        <dt>Used</dt><dd>{size(d.used)} of {size(d.total)}</dd>
        <dt>Dedup</dt><dd>{d.dedup === null ? 'after the first GC' : `${d.dedup.toFixed(2)}×`}</dd>
        <dt>Last GC</dt><dd style={{ color: d.gc.lastState && d.gc.lastState !== 'ok' ? 'var(--crit)' : undefined }}>{d.gc.lastState ? `${d.gc.lastState === 'ok' ? 'OK' : d.gc.lastState}, ${when(d.gc.lastEnd)}` : 'never ran'}</dd>
        <dt>Next GC</dt><dd>{d.gc.schedule ? `${when(d.gc.next, true)} (${d.gc.schedule})` : 'no schedule'}</dd>
        {d.gc.pendingBytes ? <><dt>Pending</dt><dd>{size(d.gc.pendingBytes)} to free</dd></> : null}
        {d.estimatedFull ? <><dt>Full</dt><dd>around {new Date(d.estimatedFull * 1000).toISOString().slice(0, 10)}</dd></> : null}
        <dt>Backups</dt><dd>{d.groups === null ? '—' : `${plural(d.groups, 'group')}, ${plural(d.snapshots ?? 0, 'snapshot')}`}</dd>
      </dl>
      {admin && (
        <div className={p.acts}>
          <button type="button" className={vs.btn} disabled={busy !== null} onClick={() => onAct('verify', d.store)}><Icon name="check" size={14} /> {busy === `verify:${d.store}` ? 'Starting…' : 'Verify now'}</button>
          <button type="button" className={vs.btn} disabled={busy !== null} onClick={() => onAct('gc', d.store)}><Icon name="run" size={14} /> {busy === `gc:${d.store}` ? 'Starting…' : 'GC now'}</button>
        </div>
      )}
    </article>
  )
}

function GroupTiles({ groups, staleHours }: { groups: Group[]; staleHours: number }) {
  const places = [...new Set(groups.map(g => `${g.store}\u0000${g.ns}`))]
  return (
    <>
      {places.map(k => {
        const [store, ns] = k.split('\u0000')
        const list = groups.filter(g => g.store === store && g.ns === ns)
        return (
          <section key={k} aria-label={`${store}${ns ? ` / ${ns}` : ''}`}>
            <h3 className={p.nsHead}>{store}{ns ? ` / ${ns}` : ' / root'} · {list.length}</h3>
            <ul className={p.groups}>
              {list.map(g => {
                const state = g.stale ? 'stale' : g.verify === 'failed' ? 'verify' : 'ok'
                const fresh = g.ageHours === null ? 0 : Math.max(0.04, 1 - g.ageHours / Math.max(1, staleHours))
                return (
                  <li key={`${g.type}/${g.id}`} className={p.group} data-state={state}
                    title={`${g.type}/${g.id}: newest ${g.newest ? new Date(g.newest * 1000).toLocaleString() : 'none'}, verify ${g.verify}`}>
                    <b><small>{g.type}</small>{g.id}</b>
                    <span className={p.age}>{age(g.ageHours)}{g.stale ? ' · stale' : ''}</span>
                    <div className={p.fresh} aria-hidden><i style={{ width: `${Math.round(fresh * 100)}%` }} /></div>
                    <span className={p.meta}><span>{plural(g.count, 'snap')}</span><span>{size(g.size)}</span></span>
                    <span className={p.meta}><span>verify</span><span style={{ color: g.verify === 'failed' ? 'var(--crit)' : g.verify === 'ok' ? 'var(--good)' : undefined }}>{g.verify === 'none' ? 'not yet' : g.verify}</span></span>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </>
  )
}

const JOB_WORD = { prune: 'Prune', gc: 'GC', verify: 'Verify', sync: 'Sync' } as const

function CoveragePanel({ server }: { server: Server }) {
  const [data, setData] = useState<{ ok: boolean; clusters?: Coverage[]; error?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const check = async () => {
    setBusy(true)
    const r = await apiJson<{ data: { ok: boolean; clusters?: Coverage[]; error?: string } }>(`${API}/instances/${server.id}/coverage`)
    setBusy(false)
    setData(r.ok ? r.body!.data : { ok: false, error: r.error ?? 'The cross-check could not be made.' })
  }
  return (
    <Panel title="Cluster cross-check" sub="guests with no backup here" actions={<button type="button" className={vs.btn} disabled={busy} onClick={() => void check()}>{busy ? 'Checking…' : data ? 'Check again' : 'Check'}</button>}>
      {!data && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Compares every guest of the clusters HyperProx manages that use this server as storage with the backup groups here. Read-only.</p>}
      {data && !data.ok && <Notice kind="error">{data.error}</Notice>}
      {data?.ok && !data.clusters?.length && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No cluster HyperProx manages has this server as a storage.</p>}
      {data?.ok && data.clusters?.map(c => (
        <div key={c.clusterId} className="mb-3 flex flex-col gap-2">
          <p className="text-sm" style={{ color: 'var(--text-soft)' }}><b style={{ color: 'var(--text-bright)' }}>{c.cluster}</b> · storage {c.storages.map(s => `${s.storage} → ${s.datastore}${s.ns ? `/${s.ns}` : ''}`).join(', ')}</p>
          {c.error && <Notice kind="warn">{c.error}</Notice>}
          {c.noGroup.length === 0
            ? <p className="text-sm" style={{ color: 'var(--good)' }}>Every guest has at least one backup here.</p>
            : <div className={p.guests} aria-label="Guests with no backup group">{c.noGroup.map(g => <Pill key={g.vmid} tone="bad" title={`${g.type}/${g.vmid}`}>{g.vmid} {g.name}</Pill>)}</div>}
          {c.notInJob && c.notInJob.length > 0 && (
            <p className="text-sm" style={{ color: 'var(--warn-2)' }}>In no backup job on {c.cluster}: {c.notInJob.map(g => `${g.vmid}${g.name ? ` ${g.name}` : ''}`).join(', ')}.</p>
          )}
        </div>
      ))}
    </Panel>
  )
}

// ── one server ───────────────────────────────────────────────────────────────

function ServerView({ s }: { s: Server }) {
  const { role } = useSession()
  const admin = atLeast(role, 'admin')
  const [data, setData] = useState<{ ok: boolean; reading?: Reading; error?: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [detail, setDetail] = useState<any>(null)
  const [onlyStale, setOnlyStale] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null)
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const inFlight = useRef(false)

  const load = useCallback(async (fresh = false) => {
    if (inFlight.current) return
    inFlight.current = true; setLoading(true)
    const r = await apiJson<{ data: { ok: boolean; reading?: Reading; error?: string } }>(`${API}/instances/${s.id}/reading${fresh ? '?fresh=1' : ''}`)
    inFlight.current = false; setLoading(false)
    setData(r.ok ? r.body!.data : { ok: false, error: r.error ?? 'Could not read the backup server.' })
  }, [s.id])

  // Backups change hourly at most: every two minutes while the tab is visible.
  useEffect(() => {
    void load()
    const t = setInterval(() => { if (!document.hidden) void load() }, 120_000)
    return () => clearInterval(t)
  }, [load])

  const act = async (action: 'verify' | 'gc', store: string): Promise<void> => {
    setBusy(`${action}:${store}`); setNote(null)
    const r = await apiJson<{ data: { message: string } }>(`${API}/instances/${s.id}/actions/${action}`, 'POST', { store })
    setBusy(null)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void act(action, store)); return }
    setNote(r.ok ? { text: r.body!.data.message, ok: true } : { text: r.error ?? 'That did not work.', ok: false })
    if (r.ok) void load(true)
  }

  const openDetails = async () => {
    if (detail) return
    const r = await apiJson<{ data: any }>(`${API}/instances/${s.id}/detail`)
    setDetail(r.ok ? r.body!.data : { ok: false, error: r.error })
  }

  const r = data?.reading
  const worst = r ? Math.max(0, ...r.datastores.map(d => d.usedFrac ?? 0)) : 0
  const stale = r ? r.groups.filter(g => g.stale) : []
  const shown = r ? (onlyStale ? stale : r.groups) : []

  return (
    <div className={vs.page}>
      {!data && <BusyNote>Reading {s.name}…</BusyNote>}
      {data && !data.ok && <Notice kind="error">{data.error} The page tries again every two minutes.</Notice>}
      {r && (
        <>
          <HudHeader level={2} label={`${s.name} overview`} eyebrow={`Proxmox Backup Server${r.version ? ` · ${r.version}` : ''}`} title={s.name}
            ring={{ value: worst, text: `${Math.round(worst * 100)}%`, label: 'fullest' }}
            chips={[
              { label: 'datastores', value: r.datastores.length },
              { label: 'groups', value: r.groups.length },
              { label: 'stale', value: stale.length, tone: stale.length ? 'crit' : 'good' },
              { label: 'failed 24 h', value: r.failedTasks.length, tone: r.failedTasks.length ? 'warn' : 'good' },
            ]}
            actions={
              <div className={p.toolbar}>
                <button type="button" className={vs.btn} disabled={loading} onClick={() => void load(true)}><Icon name="check" size={14} /> {loading ? 'Reading…' : 'Refresh'}</button>
                <small>read {ago(r.fetchedAt)}</small>
              </div>
            } />
          <div className={p.band} data-state={r.health.state} role="status">
            <b>{r.health.state === 'active' ? 'Active' : 'Needs attention'}</b>
            <span>{r.health.state === 'active' ? `Every datastore under ${Math.round(FULL_AT * 100)}%, nothing older than ${r.staleHours} h, no failures in 24 h.` : r.health.reasons.join(' · ')}</span>
          </div>
          {note && <p className="text-sm" role="status" style={{ color: note.ok ? 'var(--good)' : 'var(--warn-2)' }}>{note.text}</p>}
          {r.missing.length > 0 && <Notice kind="warn">Not read: {r.missing.join(', ')}. A read-only token (Audit on /) sees most of it; the rest of the page is real.</Notice>}

          <Panel title="Datastores" sub={admin ? 'verify and GC need the master password' : undefined}>
            {r.datastores.length === 0 ? <p className="text-sm" style={{ color: 'var(--text-muted)' }}>The token sees no datastore. Give it Datastore.Audit (the Audit role on /).</p>
              : <div className={p.stores}>{r.datastores.map(d => <StoreCard key={d.store} d={d} admin={admin} busy={busy} onAct={(a, st) => void act(a, st)} />)}</div>}
          </Panel>

          <Panel title="Backup groups" sub={`red: no snapshot in ${r.staleHours} h`} actions={
            <label className={p.filter}><input type="checkbox" checked={onlyStale} onChange={e => setOnlyStale(e.target.checked)} /> only stale</label>}>
            {shown.length === 0
              ? <p className="text-sm" style={{ color: onlyStale ? 'var(--good)' : 'var(--text-muted)' }}>{onlyStale ? 'No stale groups.' : 'No backups yet.'}</p>
              : <GroupTiles groups={shown} staleHours={r.staleHours} />}
          </Panel>

          <Panel title="Jobs" sub="prune · GC · verify · sync">
            {r.jobs.length === 0 ? <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No jobs are scheduled.</p> : (
              <Feed label="Jobs" items={r.jobs.map(j => ({
                key: `${j.kind}:${j.id}`, tone: j.result === 'failed' ? 'bad' : j.result === 'never' ? 'off' : 'ok',
                title: `${JOB_WORD[j.kind]} · ${j.id}`,
                detail: j.result === 'failed' ? `failed: ${j.detail ?? 'see the task log'}` : j.result === 'never' ? 'has not run yet' : 'OK',
                meta: `${j.store}${j.ns ? `/${j.ns}` : ''} · last ${when(j.lastEnd)} · next ${when(j.next, true)}${j.schedule ? ` (${j.schedule})` : ''}`,
              }))} />
            )}
          </Panel>

          <Panel title="Failed tasks" sub="last 24 h">
            {r.failedTasks.length === 0 ? <p className="text-sm" style={{ color: 'var(--good)' }}>Nothing failed in the last 24 hours.</p> : (
              <Feed label="Failed tasks" items={r.failedTasks.map(t => ({ key: t.upid || `${t.type}${t.start}`, tone: 'bad', title: t.type, detail: t.status, meta: `${t.target ?? ''} · ${when(t.start)}` }))} />
            )}
          </Panel>

          <CoveragePanel server={s} />

          <div onClickCapture={() => void openDetails()}>
            <DetailsSection count={detail?.tables?.length ?? 4}>
              {!detail && <BusyNote>Reading…</BusyNote>}
              {detail && !detail.ok && <Notice kind="error">{detail.error}</Notice>}
              {detail?.ok && (detail.tables ?? []).map((t: any) => (
                <section key={t.title} className="rounded-lg border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                  <h3 className="px-3 py-2 font-semibold" style={{ color: 'var(--text-bright)' }}>{t.title} <small style={{ color: 'var(--text-dimmer)' }}>{t.rows.length}</small></h3>
                  {t.rows.length === 0 ? <p className="px-3 pb-3 text-sm" style={{ color: 'var(--text-muted)' }}>{t.empty}</p> : (
                    <div className="overflow-x-auto"><table className="w-full text-sm">
                      <thead><tr>{t.columns.map((c: any) => <th key={c.key} className="px-3 py-1.5 font-mono text-[11px] uppercase" style={{ color: 'var(--text-dim)', textAlign: c.align ?? 'left' }}>{c.label}</th>)}</tr></thead>
                      <tbody>{t.rows.map((row: any, i: number) => (
                        <tr key={i} className="border-t" style={{ borderColor: 'var(--border-dim)' }}>
                          {t.columns.map((c: any) => <td key={c.key} className="px-3 py-1.5" style={{ color: 'var(--text-soft)', textAlign: c.align ?? 'left' }}>{String(row[c.key] ?? '—')}</td>)}
                        </tr>
                      ))}</tbody>
                    </table></div>
                  )}
                </section>
              ))}
            </DetailsSection>
          </div>
        </>
      )}
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const f = reconfirm; setReconfirm(null); f() }} />}
    </div>
  )
}

// ── settings: add, change, remove (admin, re-confirmed) ──────────────────────

const TOKEN_STEPS = [
  'proxmox-backup-manager user create hyperprox@pbs',
  'proxmox-backup-manager acl update / Audit --auth-id hyperprox@pbs',
  'proxmox-backup-manager user generate-token hyperprox@pbs readonly',
  "proxmox-backup-manager acl update / Audit --auth-id 'hyperprox@pbs!readonly'",
]

function ServerForm({ s, onSaved, onCancel }: { s: Server | null; onSaved: () => void; onCancel?: () => void }) {
  const [f, setF] = useState({ name: s?.name ?? '', url: s?.url ?? '', tokenId: s?.tokenId ?? '', secret: '', staleHours: String(s?.staleHours ?? 26) })
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const set = (k: keyof typeof f, v: string) => setF(x => ({ ...x, [k]: v }))

  const save = async (repin = false) => {
    setBusy(true); setErr(null)
    const body: Record<string, unknown> = { name: f.name, url: f.url, tokenId: f.tokenId, staleHours: Number(f.staleHours) || 26, ...(repin ? { repin: true } : {}) }
    if (f.secret || !s) body.secret = f.secret
    const r = await apiJson(s ? `${API}/instances/${s.id}` : `${API}/instances`, s ? 'PUT' : 'POST', body)
    setBusy(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void save(repin)); return }
    if (!r.ok) { setErr(r.error ?? 'Could not save'); return }
    set('secret', '')
    onSaved()
  }

  const remove = async () => {
    if (!s || !window.confirm(`Remove ${s.name} from HyperProx? Its token is deleted from the vault. The backup server and its backups are not touched.`)) return
    const r = await apiJson(`${API}/instances/${s.id}`, 'DELETE')
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void remove()); return }
    if (!r.ok) { setErr(r.error ?? 'Could not remove'); return }
    onSaved()
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      <h3 className="font-display font-semibold" style={{ fontSize: 18, color: 'var(--text-bright)' }}>{s ? `Settings: ${s.name}` : 'Add a backup server'}</h3>
      <Notice kind="info">
        Give HyperProx its own read-only API token. In the backup server&apos;s shell (or its web interface: Configuration → Access Control) run:
        <code className="mt-2 block whitespace-pre-wrap break-all font-mono text-[12px]">{TOKEN_STEPS.join('\n')}</code>
        The Audit role on / gives Datastore.Audit and Sys.Audit: HyperProx can read everything this page shows and change nothing.
        &quot;Verify now&quot; needs Datastore.Verify and &quot;GC now&quot; needs Datastore.Modify on that datastore as well; without them the server refuses, and the page says which one is missing.
        Paste the token id (hyperprox@pbs!readonly) and the secret PBS showed once. HyperProx checks the connection, pins the server&apos;s certificate and keeps the token in the vault.
      </Notice>
      <label><span style={LABEL}>Name</span><input style={INPUT} value={f.name} onChange={e => set('name', e.target.value)} placeholder="Backups" /></label>
      <label><span style={LABEL}>Address (port 8007 if left out)</span><input style={INPUT} autoCapitalize="none" value={f.url} onChange={e => set('url', e.target.value)} placeholder="https://10.0.0.30:8007" /></label>
      <label><span style={LABEL}>Token id</span><input style={INPUT} autoCapitalize="none" autoComplete="off" value={f.tokenId} onChange={e => set('tokenId', e.target.value)} placeholder="hyperprox@pbs!readonly" /></label>
      <label><span style={LABEL}>Token secret {s?.hasSecret ? '(saved; leave blank to keep it)' : ''}</span>
        <input style={INPUT} type="password" autoComplete="new-password" value={f.secret} onChange={e => set('secret', e.target.value)} /></label>
      {s && (f.url !== (s.url ?? '') || f.tokenId !== (s.tokenId ?? '')) && <small style={{ color: 'var(--warn-2)' }}>A new address or token id needs the secret again: paste it above in the same save.</small>}
      <label><span style={LABEL}>Stale after (hours without a new snapshot)</span>
        <input style={INPUT} inputMode="numeric" value={f.staleHours} onChange={e => set('staleHours', e.target.value.replace(/[^0-9]/g, ''))} /></label>
      {s?.pin && (
        <div className="flex flex-col gap-2 rounded-md border p-3" style={{ borderColor: 'var(--border-strong)' }}>
          <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Certificate</span>
          <small className="break-all font-mono" style={{ color: 'var(--good)' }}>Pinned: {s.pin.fingerprint}</small>
          <small style={{ color: 'var(--text-muted)' }}>
            {s.pin.source === 'ca' ? 'It verified against a public certificate authority, so a renewal is accepted.' : 'The server\'s own certificate, pinned when it was added. Any other certificate is refused before the token is sent.'}
            {' '}If the server&apos;s certificate was replaced on purpose, compare the new fingerprint on its dashboard and re-pin.
          </small>
          <div><GhostButton type="button" disabled={busy} onClick={() => void save(true)}>Re-pin the certificate presented now</GhostButton></div>
        </div>
      )}
      {err && <Notice kind="error">{err}</Notice>}
      <div className="flex flex-wrap justify-end gap-2">
        {s && <GhostButton type="button" onClick={() => void remove()} style={{ color: 'var(--crit-soft)' }}>Remove</GhostButton>}
        {onCancel && <GhostButton type="button" onClick={onCancel}>Cancel</GhostButton>}
        <PrimaryButton type="button" disabled={busy || !f.name || !f.url || !f.tokenId || (!s && !f.secret)} onClick={() => void save()}>{busy ? 'Checking…' : s ? 'Save' : 'Check and add'}</PrimaryButton>
      </div>
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const fn = reconfirm; setReconfirm(null); fn() }} />}
    </div>
  )
}

// ── the plug-in page ─────────────────────────────────────────────────────────

export function PbsPage() {
  const { role } = useSession()
  const { list, error, reload } = useServers()
  const [sel, setSel] = useState<string | null>(null)
  const [tab, setTab] = useState<'server' | 'settings'>('server')
  const [adding, setAdding] = useState(false)
  const s = list?.find(i => i.id === sel) ?? list?.[0] ?? null
  const admin = atLeast(role, 'admin')

  return (
    <div className="min-h-full overflow-x-hidden" style={{ background: 'var(--ground)' }}>
      {admin && (
        <div className="flex flex-wrap items-center gap-3 px-4 pb-2 sm:px-8">
          <span className="ml-auto"><PrimaryButton type="button" onClick={() => setAdding(true)}>Add a backup server</PrimaryButton></span>
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-4 px-4 py-4 sm:px-8">
        <PluginSwitcher current="pbs" />
        {error && <Notice kind="error">{error}</Notice>}
        {!list && !error && <BusyNote>Reading…</BusyNote>}
        {adding && <ServerForm s={null} onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); void reload() }} />}
        {list && list.length === 0 && !adding && <Notice kind="info">No backup server is set up yet.{admin ? ' Use "Add a backup server", or install one from the Catalogue.' : ' An admin can add one.'}</Notice>}
        {list && s && (
          <>
            {list.length > 1 && (
              <div className={p.tabs} role="tablist" aria-label="Backup servers">
                {list.map(i => <button key={i.id} role="tab" aria-selected={i.id === s.id} onClick={() => setSel(i.id)} className={p.tab}>{i.name}</button>)}
              </div>
            )}
            {admin && (
              <div className={p.views} role="tablist" aria-label="View">
                <button role="tab" aria-selected={tab === 'server'} onClick={() => setTab('server')}>Backups</button>
                <button role="tab" aria-selected={tab === 'settings'} onClick={() => setTab('settings')}>Settings</button>
              </div>
            )}
            {(tab === 'server' || !admin) && <ServerView key={s.id} s={s} />}
            {tab === 'settings' && admin && <ServerForm key={s.id} s={s} onSaved={() => void reload()} />}
          </>
        )}
      </div>
    </div>
  )
}
