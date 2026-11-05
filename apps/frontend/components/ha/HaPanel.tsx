'use client'

// =============================================================================
//  HaPanel — high availability for one guest, in plain words
//
//  Mount it anywhere a guest is shown (the Infrastructure drill-down's "High
//  availability" tab):
//
//    <HaPanel type="lxc" vmid={901} onChanged={() => reload()} />
//
//  Everything it changes goes through a server-held preview and is applied
//  by id (useHaChange). Viewers see the status; changes need an admin.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { HomePicker } from './HomePicker'
import { MigrationPreflight } from './MigrationPreflight'
import { RefusalNote, useHaChange, type Refusal } from './PreviewDialog'
import { Btn, Dialog, Label, Note, SELECT, Section, Switch, Tag } from './ui'
import type { GuestHa, HomeChoice } from './types'

export interface HaPanelProps {
  type: 'lxc' | 'qemu'
  vmid: number
  /** Called after any change was applied (so the host page can re-read its own data). */
  onChanged?: () => void
  /** Hide the migration grid (e.g. when the host page shows it in its own tab). */
  hidePreflight?: boolean
}

export function HaPanel({ type, vmid, onChanged, hidePreflight }: HaPanelProps) {
  const { role } = useSession()
  const admin = atLeast(role, 'admin')
  const [g, setG] = useState<GuestHa | null>(null)
  const [error, setError] = useState('')
  const [home, setHome] = useState<HomeChoice>({ mode: 'none', tiers: [] })
  const [strictAsk, setStrictAsk] = useState(false)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [partner, setPartner] = useState('')
  const [relation, setRelation] = useState<'negative' | 'positive'>('negative')
  const [adv, setAdv] = useState(false)
  const [res, setRes] = useState({ maxRestart: 1, maxRelocate: 1, failback: true, autoRebalance: true })

  const load = useCallback(async () => {
    const r = await apiJson<{ data: GuestHa }>(`/api/ha/guests/${type}/${vmid}`)
    if (r.ok && r.body) {
      const d = r.body.data
      setG(d); setError('')
      setHome(d.home.disabled || d.home.avoid.length ? { mode: 'none', tiers: [] } : d.home.choice)
      if (d.resource) setRes({ maxRestart: d.resource.maxRestart, maxRelocate: d.resource.maxRelocate, failback: d.resource.failback, autoRebalance: d.resource.autoRebalance })
    } else setError(r.error ?? 'Could not read HA for this guest.')
  }, [type, vmid])
  useEffect(() => { void load() }, [load])

  const change = useHaChange(r => { if (r.ok) { void load(); onChanged?.() } })
  const ask = async (body: Record<string, unknown>) => { setRefusal(null); const ref = await change.preview(body); if (ref) setRefusal(ref) }

  if (error) return <Note tone="warn">{error}</Note>
  if (!g) return <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Reading HA…</p>

  const label = (sid: string) => { const o = g.others.find(x => x.sid === sid); return o ? `${o.name || sid} (${sid.split(':')[1]})` : sid }
  const inAffinity = g.together.some(t => !t.disabled) || g.apart.some(t => !t.disabled)
  const homeDirty = JSON.stringify(home) !== JSON.stringify(g.home.disabled || g.home.avoid.length ? { mode: 'none', tiers: [] } : g.home.choice)
  const saveHome = (confirmStrict = false) => ask({ action: 'set-home', sid: g.sid, home, ...(confirmStrict ? { confirmStrict: true } : {}) })
  const removeRelation = (rule: string, others: string[]) => {
    if (others.length <= 1) return ask({ action: 'delete-rule', ruleId: rule })
    return ask({ action: 'update-rule', rule: { id: rule, type: 'resource-affinity', affinity: g.apart.some(a => a.rule === rule) ? 'negative' : 'positive', resources: others } })
  }
  const addRelation = () => {
    if (!partner) return
    const id = `ha-${relation === 'negative' ? 'apart' : 'together'}-${g.vmid}-${partner.split(':')[1]}`
    return ask({ action: 'create-rule', rule: { id, type: 'resource-affinity', affinity: relation, resources: [g.sid, partner] } })
  }

  return (
    <div className="space-y-4">
      {!g.quorate && <Note tone="crit">The cluster has lost quorum. HA cannot act, and HyperProx changes nothing until quorum is back.</Note>}

      {/* 1. The switch */}
      <Section title="Automatic restart">
        <div className="space-y-3">
          <Switch on={g.protected} disabled={!admin || change.busy} label="Restart this automatically on another node if its node fails."
            onChange={on => ask(on ? { action: 'protect', sid: g.sid } : { action: 'unprotect', sid: g.sid })} />
          <p className="text-[15px] leading-relaxed" style={{ color: 'var(--text-soft)' }} aria-live="polite">{g.statusLine}</p>
          {!g.protected && (
            <ul className="list-disc space-y-0.5 pl-5 text-sm" style={{ color: 'var(--text-muted)' }}>
              <li>Turning it on keeps the guest running: HA starts it if it is off and restarts it on another node if {g.node} fails.</li>
              <li>If it fails to start, HA tries once more on the same node (max_restart 1), then moves it once to another node (max_relocate 1).</li>
            </ul>
          )}
          {g.warnings.map((w, i) => <Note key={i} tone="warn">{w}</Note>)}
          {g.protected && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Tag tone={g.haState === 'started' ? 'good' : g.haState === 'error' ? 'crit' : 'muted'}>HA: {g.haState ?? g.resource?.state}</Tag>
              {admin && <Btn small disabled={change.busy || g.resource?.state === 'started'} onClick={() => ask({ action: 'set-state', sid: g.sid, state: 'started' })}>Start through HA</Btn>}
              {admin && <Btn small disabled={change.busy || g.resource?.state === 'stopped'} onClick={() => ask({ action: 'set-state', sid: g.sid, state: 'stopped' })}>Stop through HA</Btn>}
              <span className="text-xs" style={{ color: 'var(--text-dim)' }}>An HA guest is started and stopped through HA, from here and from every power button in HyperProx.</span>
            </div>
          )}
        </div>
      </Section>

      {refusal && <RefusalNote refusal={refusal} onFix={admin ? rule => ask({ action: 'flatten', ruleId: rule }) : undefined} />}

      {g.protected && (
        <>
          {/* 2. Home */}
          <Section title="Home node">
            <div className="space-y-3">
              <p className="text-sm" style={{ color: 'var(--text-soft)' }}>{g.home.words}</p>
              {g.home.avoid.length > 0 && <Note tone="info">Its rule "{g.home.rule?.id}" says where it must not run. Picking a home here replaces that rule.</Note>}
              {g.home.sharedWith.length > 0 && <Note tone="info">It shares the home rule "{g.home.rule?.id}" with {g.home.sharedWith.map(label).join(', ')}. A change here gives it its own rule and leaves theirs alone.</Note>}
              {admin ? (
                <>
                  <HomePicker value={home} nodes={g.nodes} mustBeEqual={inAffinity} onChange={setHome} />
                  <div className="flex justify-end">
                    <Btn kind={home.mode === 'only' ? 'danger' : 'primary'} disabled={!homeDirty || change.busy || (home.mode !== 'none' && !home.tiers.length)}
                      onClick={() => home.mode === 'only' ? setStrictAsk(true) : saveHome()}>Preview this home</Btn>
                  </div>
                </>
              ) : null}
            </div>
          </Section>

          {/* 3. Together / apart */}
          <Section title="Keep apart from… / together with…">
            <div className="space-y-3">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Keep apart: never on the same node, so one node failure takes only one of them down (for example two DNS servers). Keep together: always on the same node, and they move as one (for example an app and its database).</p>
              {[...g.apart.map(a => ({ ...a, kind: 'apart' as const })), ...g.together.map(t => ({ ...t, kind: 'together' as const }))].map(x => (
                <div key={x.rule} className="flex flex-wrap items-center gap-2 text-sm" style={{ color: 'var(--text)' }}>
                  <Tag tone={x.kind === 'apart' ? 'violet' : 'accent'}>{x.kind === 'apart' ? 'kept apart from' : 'kept together with'}</Tag>
                  <span>{x.with.map(label).join(', ')}</span>
                  {x.disabled && <Tag tone="muted">rule off</Tag>}
                  {admin && <Btn small onClick={() => removeRelation(x.rule, x.with)}>Remove</Btn>}
                </div>
              ))}
              {admin && g.others.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <select aria-label="Relation" value={relation} style={SELECT} onChange={e => setRelation(e.target.value as any)}>
                    <option value="negative">Keep apart from</option>
                    <option value="positive">Keep together with</option>
                  </select>
                  <select aria-label="Other guest" value={partner} style={{ ...SELECT, minWidth: 200 }} onChange={e => setPartner(e.target.value)}>
                    <option value="">pick an HA guest…</option>
                    {g.others.map(o => <option key={o.sid} value={o.sid}>{o.name || o.sid} ({o.sid.split(':')[1]}) on {o.node}</option>)}
                  </select>
                  <Btn kind="primary" disabled={!partner || change.busy} onClick={addRelation}>Preview</Btn>
                </div>
              )}
              {admin && g.others.length === 0 && <p className="text-xs" style={{ color: 'var(--text-dim)' }}>Only HA guests can be kept apart or together. Protect another guest first.</p>}
            </div>
          </Section>

          {/* Advanced: the resource's own settings */}
          <Section title="Advanced" right={<Btn small onClick={() => setAdv(a => !a)}>{adv ? 'Hide' : 'Show'}</Btn>}>
            {adv ? (
              <div className="space-y-3 text-sm" style={{ color: 'var(--text)' }}>
                <label className="flex flex-wrap items-center gap-2">Restart tries on the same node before moving it
                  <input type="number" min={0} max={10} value={res.maxRestart} disabled={!admin} style={{ ...SELECT, width: 72 }} onChange={e => setRes({ ...res, maxRestart: Number(e.target.value) })} /></label>
                <label className="flex flex-wrap items-center gap-2">Moves to another node if it still will not start
                  <input type="number" min={0} max={10} value={res.maxRelocate} disabled={!admin} style={{ ...SELECT, width: 72 }} onChange={e => setRes({ ...res, maxRelocate: Number(e.target.value) })} /></label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={res.failback} disabled={!admin} onChange={e => setRes({ ...res, failback: e.target.checked })} />Return home automatically when its home node is back (failback)</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={res.autoRebalance} disabled={!admin} onChange={e => setRes({ ...res, autoRebalance: e.target.checked })} />HA may move it to balance load between nodes</label>
                {g.home.rule && <p className="font-mono text-xs" style={{ color: 'var(--text-soft)' }}>Home rule "{g.home.rule.id}": {(g.home.rule.nodes ?? []).map(n => `${n.node}:${n.priority}`).join(',')} · strict={g.home.rule.strict ? 1 : 0}{g.home.rule.disabled ? ' · disabled' : ''}</p>}
                {g.resource?.group && <p className="text-xs" style={{ color: 'var(--text-dim)' }}>Legacy HA group: {g.resource.group} (ignored by Proxmox 9; its home rule is what counts).</p>}
                {admin && <div className="flex justify-end"><Btn kind="primary" disabled={change.busy} onClick={() => ask({ action: 'update-resource', sid: g.sid, ...res })}>Preview</Btn></div>}
              </div>
            ) : <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Restart and move limits, failback and load balancing. The defaults suit almost every guest.</p>}
          </Section>
        </>
      )}

      {/* 5. Where can it move */}
      {!hidePreflight && (
        <Section title="Where can it move?">
          <MigrationPreflight type={type} vmid={vmid} />
        </Section>
      )}

      {strictAsk && (
        <Dialog title="Only ever run on these nodes?" onClose={() => setStrictAsk(false)}>
          <Note tone="crit">
            If {home.tiers.flat().join(' and ')} {home.tiers.flat().length > 1 ? 'are all' : 'is'} down, this guest does not start anywhere — it stays off until one of them is back. HA will not move it to a healthy node.
          </Note>
          <p className="text-sm" style={{ color: 'var(--text-soft)' }}>Choose this only when the guest is useless on any other node (it needs that node's GPU, disks or USB device). Otherwise pick "Prefer a node, but run anywhere if needed".</p>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setStrictAsk(false)}>Cancel</Btn>
            <Btn kind="danger" onClick={() => { setStrictAsk(false); void saveHome(true) }}>Yes, only these nodes</Btn>
          </div>
        </Dialog>
      )}
      {change.dialog}
      <Label>{g.fencing === 'armed' ? 'HA fencing is armed on this cluster' : `HA fencing: ${g.fencing}`}</Label>
    </div>
  )
}
