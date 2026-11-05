'use client'

// =============================================================================
//  /ha — High availability, cluster-wide
//
//  Is HA armed, who is protected, who stays down after a node failure, who has
//  no home to return to, whose hardware ties it to a node its rules ignore,
//  which keep-apart rules leave no slack — and the rules themselves, explained
//  by consequence. Every change goes through a server-held preview.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { HaPanel } from '@/components/ha/HaPanel'
import { RuleEditor } from '@/components/ha/RuleEditor'
import { RefusalNote, useHaChange, type Refusal } from '@/components/ha/PreviewDialog'
import { Btn, Dialog, Note, Section, Tag } from '@/components/ha/ui'
import type { HaRule, Overview } from '@/components/ha/types'

const TH = 'px-3 py-2 text-left font-mono font-normal'
const THS: React.CSSProperties = { color: 'var(--text-dimmer)', fontSize: 11, letterSpacing: '0.1em', borderBottom: '1px solid var(--border)' }

export default function HaPage() {
  const { role } = useSession()
  const admin = atLeast(role, 'admin')
  const [ov, setOv] = useState<Overview | null>(null)
  const [error, setError] = useState('')
  const [guest, setGuest] = useState<{ type: 'lxc' | 'qemu'; vmid: number; name: string } | null>(null)
  const [editor, setEditor] = useState<{ rule: HaRule | null } | null>(null)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [showAllUnprotected, setShowAll] = useState(false)

  const load = useCallback(async () => {
    const r = await apiJson<{ data: Overview }>('/api/ha/overview')
    if (r.ok && r.body) { setOv(r.body.data); setError('') } else setError(r.status === 404 ? 'The HA API is not available on this server yet.' : r.error ?? 'Could not read HA.')
  }, [])
  useEffect(() => { void load() }, [load])
  const change = useHaChange(r => { if (r.ok) void load() })
  const ask = async (body: Record<string, unknown>) => { setRefusal(null); const ref = await change.preview(body); if (ref) setRefusal(ref); return ref }

  const sidType = (sid: string) => (sid.startsWith('ct:') ? 'lxc' : 'qemu') as 'lxc' | 'qemu'
  const open = (sid: string, name: string) => setGuest({ type: sidType(sid), vmid: Number(sid.split(':')[1]), name })
  const guestsForRules = ov?.protected.map(p => ({ sid: p.sid, name: p.name })) ?? []

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-6 sm:px-6">
      <header className="space-y-1">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--accent)' }}>Cluster</p>
        <h1 className="font-display text-[34px] font-bold leading-tight" style={{ color: 'var(--text-bright)' }}>High availability</h1>
        <p className="text-[15px]" style={{ color: 'var(--text-soft)' }}>Which guests come back on their own when a node fails, where they go, and whether they ever come home.</p>
      </header>

      {error && <Note tone="warn">{error}</Note>}
      {!ov && !error && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Reading HA…</p>}
      {refusal && <RefusalNote refusal={refusal} onFix={admin ? rule => ask({ action: 'flatten', ruleId: rule }) : undefined} />}

      {ov && (
        <>
          <Section title="Status">
            <div className="space-y-3">
              <Note tone={!ov.cluster.quorate ? 'crit' : ov.cluster.fencing === 'armed' ? 'info' : 'warn'}>{ov.cluster.headline}</Note>
              <ul className="space-y-0.5 text-sm" style={{ color: 'var(--text-muted)' }}>{ov.cluster.detail.map((d, i) => <li key={i}>{d}</li>)}</ul>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {ov.nodes.map(n => (
                  <div key={n.node} className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border)', background: 'var(--ground-inset)' }}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-display text-[17px] font-semibold" style={{ color: 'var(--text-bright)' }}>{n.node}</span>
                      {!n.online ? <Tag tone="crit">offline</Tag> : n.maintenance ? <Tag tone="warn">maintenance</Tag> : <Tag tone="good">online</Tag>}
                    </div>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{n.haGuests} HA guest{n.haGuests === 1 ? '' : 's'}</p>
                    {admin && n.online && (
                      <Btn small className="mt-2" disabled={change.busy} onClick={() => ask({ action: 'maintenance', node: n.node, enable: !n.maintenance })}
                        title={n.maintenance ? 'HA uses this node again' : 'HA moves its guests away first; turn off when done'}>
                        {n.maintenance ? 'End maintenance' : 'Maintenance mode…'}
                      </Btn>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-xs" style={{ color: 'var(--text-dim)' }}>Maintenance mode: HA moves the node's HA guests away first and starts nothing there. Guests HA does not manage stay put. Turn it off when you are done.</p>
            </div>
          </Section>

          <div className="grid gap-2 sm:grid-cols-4">
            {[
              ['Protected', ov.counts.protected, 'good'], ['Not protected', ov.counts.unprotected, 'muted'],
              ['No home', ov.counts.homeless, ov.counts.homeless ? 'warn' : 'muted'], ['Hardware at risk', ov.counts.hardware, ov.counts.hardware ? 'warn' : 'muted'],
            ].map(([l, v, t]) => (
              <div key={l as string} className="rounded-[10px] border px-4 py-3" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                <p className="font-mono text-[11px] uppercase tracking-[0.12em]" style={{ color: 'var(--text-dimmer)' }}>{l}</p>
                <p className="font-display text-[30px] font-bold" style={{ color: `var(--${t === 'muted' ? 'text-soft' : t})` }}>{v as number}</p>
              </div>
            ))}
          </div>

          {(ov.homeless.length > 0 || ov.hardware.length > 0 || ov.headroom.some(h => h.level !== 'ok')) && (
            <Section title="Needs attention">
              <div className="space-y-2">
                {ov.hardware.map(h => (
                  <Note key={`hw-${h.sid}`} tone="warn">{h.words} <button type="button" className="underline" style={{ color: 'var(--accent)' }} onClick={() => open(h.sid, h.name)}>Give it a home on {h.node}</button></Note>
                ))}
                {ov.homeless.filter(h => !ov.hardware.some(x => x.sid === h.sid)).map(h => (
                  <Note key={`hl-${h.sid}`} tone="info">{h.words} <button type="button" className="underline" style={{ color: 'var(--accent)' }} onClick={() => open(h.sid, h.name)}>Give it a home</button></Note>
                ))}
                {ov.headroom.filter(h => h.level !== 'ok').map(h => <Note key={`hr-${h.rule}`} tone={h.level === 'tight' ? 'info' : 'warn'}>Rule "{h.rule}": {h.words}</Note>)}
              </div>
            </Section>
          )}

          <Section title="Protected guests">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr style={THS}><th className={TH}>GUEST</th><th className={TH}>ON</th><th className={TH}>STATE</th><th className={TH}>HOME</th><th className={TH}>IF ITS NODE FAILS</th></tr></thead>
                <tbody>
                  {ov.protected.map(p => (
                    <tr key={p.sid} className="cursor-pointer" style={{ borderBottom: '1px solid var(--border-dim)' }} onClick={() => open(p.sid, p.name)}>
                      <td className="px-3 py-2" style={{ color: 'var(--text-bright)' }}>{p.name} <span className="font-mono text-xs" style={{ color: 'var(--text-dim)' }}>{p.vmid}</span></td>
                      <td className="px-3 py-2" style={{ color: 'var(--text)' }}>{p.node}</td>
                      <td className="px-3 py-2"><Tag tone={p.state === 'started' ? 'good' : p.state === 'error' ? 'crit' : 'muted'}>{p.state}</Tag></td>
                      <td className="px-3 py-2" style={{ color: p.homeless ? 'var(--warn)' : 'var(--text)' }}>{p.home}</td>
                      <td className="px-3 py-2" style={{ color: 'var(--text-muted)' }}>{p.to ? `→ ${p.to}` : 'stays off'}<span className="block text-xs">{p.failover}</span></td>
                    </tr>
                  ))}
                  {!ov.protected.length && <tr><td colSpan={5} className="px-3 py-4" style={{ color: 'var(--text-muted)' }}>No guest is protected yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Not protected" right={<span className="text-xs" style={{ color: 'var(--text-muted)' }}>These stay down after a node failure until someone starts them.</span>}>
            <div className="space-y-1.5">
              {ov.unprotected.filter(u => showAllUnprotected || u.status === 'running').map(u => (
                <div key={u.sid} className="flex flex-wrap items-center gap-2 text-sm" style={{ borderBottom: '1px solid var(--border-dim)', paddingBottom: 6 }}>
                  <span className="min-w-[180px] flex-1" style={{ color: 'var(--text-bright)' }}>{u.name || u.sid} <span className="font-mono text-xs" style={{ color: 'var(--text-dim)' }}>{u.vmid} · {u.node}</span></span>
                  <span className="flex-[2]" style={{ color: 'var(--text-muted)' }}>{u.words}</span>
                  {admin && <Btn small kind="primary" disabled={change.busy} onClick={() => ask({ action: 'protect', sid: u.sid })}>Protect</Btn>}
                  <Btn small onClick={() => open(u.sid, u.name)}>Details</Btn>
                </div>
              ))}
              <button type="button" className="font-mono text-xs underline" style={{ color: 'var(--text-dim)' }} onClick={() => setShowAll(s => !s)}>
                {showAllUnprotected ? 'Show running guests only' : `Show stopped guests too (${ov.unprotected.filter(u => u.status !== 'running').length})`}
              </button>
            </div>
          </Section>

          <Section title="Rules" right={admin ? <Btn small kind="primary" onClick={() => setEditor({ rule: null })}>New rule</Btn> : undefined}>
            <div className="space-y-2">
              {ov.rules.map(({ rule, words, problems }) => (
                <div key={rule.id} className="rounded-md border px-3 py-2" style={{ borderColor: problems.length ? 'var(--warn)' : 'var(--border)', background: 'var(--ground-inset)' }}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm" style={{ color: 'var(--text-bright)' }}>{rule.id}</span>
                    <Tag tone={rule.type === 'node-affinity' ? 'accent' : 'violet'}>{rule.type === 'node-affinity' ? 'where it runs' : rule.affinity === 'negative' ? 'keep apart' : 'keep together'}</Tag>
                    {rule.type === 'node-affinity' && rule.strict && <Tag tone="crit">strict</Tag>}
                    {rule.disabled && <Tag tone="muted">off</Tag>}
                    <span className="flex-1" />
                    {admin && <>
                      <Btn small onClick={() => setEditor({ rule })}>Edit</Btn>
                      <Btn small onClick={() => ask({ action: rule.disabled ? 'enable-rule' : 'disable-rule', ruleId: rule.id })}>{rule.disabled ? 'Turn on' : 'Turn off'}</Btn>
                      <Btn small kind="danger" onClick={() => ask({ action: 'delete-rule', ruleId: rule.id })}>Remove</Btn>
                    </>}
                  </div>
                  <p className="mt-1 text-sm" style={{ color: 'var(--text)' }}>{words}</p>
                  {problems.map((p, i) => (
                    <p key={i} className="mt-1 text-sm" style={{ color: 'var(--warn)' }}>{p.message} Proxmox ignores a rule like this.
                      {p.fix && admin && <> <button type="button" className="underline" style={{ color: 'var(--accent)' }} onClick={() => ask({ action: 'flatten', ruleId: p.fix!.rule })}>{p.fix.words}</button></>}</p>
                  ))}
                </div>
              ))}
              {!ov.rules.length && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No rules: every HA guest can run on any node, and none has a home to return to.</p>}
            </div>
          </Section>
        </>
      )}

      {guest && (
        <Dialog title={`${guest.name || guest.vmid} — high availability`} onClose={() => { setGuest(null); void load() }} wide>
          <HaPanel type={guest.type} vmid={guest.vmid} onChanged={load} />
        </Dialog>
      )}
      {editor && ov && (
        <RuleEditor initial={editor.rule} guests={guestsForRules} nodes={ov.nodes} onClose={() => setEditor(null)}
          onPreview={async c => { const ref = await ask(c); if (!ref) setEditor(null) }} />
      )}
      {change.dialog}
    </div>
  )
}
