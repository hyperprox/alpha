'use client'

// The rule editor: consequence first, checked against PVE's rules as you edit (POST /api/ha/check), and
// saved through a preview. A weighted home and a keep-together/apart rule on the same guest is caught
// here, with the fix (flatten the priorities) offered before anything is sent.

import { useEffect, useMemo, useState } from 'react'
import { apiJson } from '@/lib/api'
import { HomePicker, weightsOf } from './HomePicker'
import { Btn, Dialog, Label, Note } from './ui'
import { RefusalNote, type Refusal } from './PreviewDialog'
import type { HaRule, Headroom, HomeChoice, RuleProblem } from './types'

interface CheckResult { blocking: RuleProblem[]; existing: RuleProblem[]; words: string; headroom: Headroom[] }

function tiersFromNodes(nodes: Array<{ node: string; priority: number }> = []): string[][] {
  const by = new Map<number, string[]>()
  for (const n of nodes) by.set(n.priority, [...(by.get(n.priority) ?? []), n.node])
  return [...by.entries()].sort((a, b) => b[0] - a[0]).map(([, v]) => v.sort())
}
function nodesFromTiers(t: string[][]) {
  const clean = t.filter(x => x.length)
  return clean.length <= 1 ? (clean[0] ?? []).map(node => ({ node, priority: 0 })) : clean.flatMap((x, i) => x.map(node => ({ node, priority: clean.length - i })))
}

export function RuleEditor({ initial, guests, nodes, onClose, onPreview }: {
  initial: HaRule | null
  guests: Array<{ sid: string; name: string }>
  nodes: Array<{ node: string; online: boolean; maintenance: boolean }>
  onClose: () => void
  /** Hands the finished change to the page, which previews it; a refusal comes back to show here. */
  onPreview: (change: Record<string, unknown>) => Promise<Refusal | null>
}) {
  const editing = !!initial
  const [id, setId] = useState(initial?.id ?? '')
  const [type, setType] = useState<HaRule['type']>(initial?.type ?? 'node-affinity')
  const [affinity, setAffinity] = useState<HaRule['affinity']>(initial?.affinity ?? (initial ? 'positive' : 'negative'))
  const [resources, setResources] = useState<string[]>(initial?.resources ?? [])
  const [home, setHome] = useState<HomeChoice>({ mode: initial?.strict ? 'only' : 'prefer', tiers: tiersFromNodes(initial?.nodes) })
  const [avoid, setAvoid] = useState(initial?.type === 'node-affinity' && initial.affinity === 'negative')
  // An avoid rule's own strictness, kept as it is unless the person changes it (Advanced).
  const [avoidStrict, setAvoidStrict] = useState(initial?.type === 'node-affinity' && initial.affinity === 'negative' ? !!initial.strict : false)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [comment, setComment] = useState(initial?.comment ?? '')
  const [check, setCheck] = useState<CheckResult | null>(null)
  const [checkErr, setCheckErr] = useState('')
  const [strictAsk, setStrictAsk] = useState(false)

  const rule = useMemo<HaRule>(() => type === 'node-affinity'
    ? { id, type, affinity: avoid ? 'negative' : 'positive', strict: avoid ? avoidStrict : home.mode === 'only', nodes: avoid ? home.tiers.flat().map(node => ({ node, priority: 0 })) : nodesFromTiers(home.tiers), resources, disabled: initial?.disabled ?? false, ...(comment ? { comment } : initial?.comment ? { comment: '' } : {}) }
    : { id, type, affinity, resources, disabled: initial?.disabled ?? false, ...(comment ? { comment } : initial?.comment ? { comment: '' } : {}) },
  [id, type, affinity, resources, home, avoid, avoidStrict, comment, initial?.disabled])

  // Live check, debounced: what PVE would say, before anything is sent.
  useEffect(() => {
    if (!id || !resources.length) { setCheck(null); return }
    const t = setTimeout(async () => {
      const r = await apiJson<{ data: CheckResult }>('/api/ha/check', 'POST', { rule, replacing: initial?.id ?? null })
      if (r.ok && r.body) { setCheck(r.body.data); setCheckErr('') } else { setCheck(null); setCheckErr(r.error ?? '') }
    }, 350)
    return () => clearTimeout(t)
  }, [rule, id, resources.length, initial?.id])

  const strict = type === 'node-affinity' && (avoid ? avoidStrict : home.mode === 'only')
  const wasStrict = initial?.type === 'node-affinity' && !!initial.strict
  const ready = id && resources.length && (type === 'resource-affinity' || home.tiers.flat().length) && !(check?.blocking.length)
  const submit = async (confirmStrict = false, extra: Record<string, unknown> = {}) => {
    setRefusal(null)
    const ref = await onPreview({ action: editing ? 'update-rule' : 'create-rule', rule, ...(confirmStrict ? { confirmStrict: true } : {}), ...extra })
    if (ref) setRefusal(ref)
  }
  const toggle = (sid: string) => setResources(r => r.includes(sid) ? r.filter(x => x !== sid) : [...r, sid])

  return (
    <Dialog title={editing ? `Edit rule "${initial!.id}"` : 'New HA rule'} onClose={onClose} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1"><Label>Name</Label>
          <input value={id} disabled={editing} onChange={e => setId(e.target.value.replace(/\s/g, '-'))} placeholder="e.g. dns-apart"
            className="w-full rounded-md border px-3" style={{ height: 36, background: 'var(--ground-deep)', borderColor: 'var(--border-strong)', color: 'var(--text-bright)' }} />
        </label>
        <div className="space-y-1"><Label>Kind</Label>
          <div className="flex flex-wrap gap-2">
            <Btn kind={type === 'node-affinity' ? 'primary' : 'ghost'} disabled={editing} onClick={() => setType('node-affinity')}>Where it runs</Btn>
            <Btn kind={type === 'resource-affinity' ? 'primary' : 'ghost'} disabled={editing} onClick={() => setType('resource-affinity')}>Together or apart</Btn>
          </div>
        </div>
      </div>

      <div className="space-y-1"><Label>Guests (HA guests only)</Label>
        <div className="flex flex-wrap gap-2">
          {guests.map(g => (
            <label key={g.sid} className="flex items-center gap-1.5 rounded border px-2 py-1 text-sm" style={{ borderColor: resources.includes(g.sid) ? 'var(--accent)' : 'var(--border)', color: 'var(--text)' }}>
              <input type="checkbox" checked={resources.includes(g.sid)} onChange={() => toggle(g.sid)} />{g.name || g.sid} <span className="font-mono text-xs" style={{ color: 'var(--text-dim)' }}>{g.sid}</span>
            </label>
          ))}
        </div>
      </div>

      {type === 'resource-affinity' ? (
        <div className="space-y-2">
          {(['negative', 'positive'] as const).map(a => (
            <label key={a} className="flex items-start gap-2 text-sm" style={{ color: 'var(--text)' }}>
              <input type="radio" className="mt-1" checked={affinity === a} onChange={() => setAffinity(a)} />
              <span><b style={{ color: 'var(--text-bright)' }}>{a === 'negative' ? 'Keep apart' : 'Keep together'}</b> — {a === 'negative'
                ? 'each on a different node, so losing one node takes only one of them down. Needs at least as many nodes as guests, plus spare ones to fail over to.'
                : 'always on the same node; when one moves, the others go with it.'}</span>
            </label>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {!avoid && <HomePicker value={home} nodes={nodes} mustBeEqual={false} onChange={v => setHome(v.mode === 'none' ? { mode: 'prefer', tiers: [] } : v)} />}
          {avoid && <HomePicker value={{ mode: 'prefer', tiers: [home.tiers.flat()] }} nodes={nodes} mustBeEqual onChange={v => setHome({ mode: 'prefer', tiers: [v.tiers.flat()] })} />}
          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
            <input type="checkbox" checked={avoid} onChange={e => setAvoid(e.target.checked)} /> Advanced: avoid the nodes listed instead (run anywhere except these)
          </label>
          {avoid && (
            <label className="flex items-center gap-2 text-sm" style={{ color: avoidStrict ? 'var(--crit-soft)' : 'var(--text-muted)' }}>
              <input type="checkbox" checked={avoidStrict} onChange={e => setAvoidStrict(e.target.checked)} /> Strict: never on these nodes, even if that means staying off
            </label>
          )}
        </div>
      )}

      <label className="block space-y-1"><Label>Note (optional)</Label>
        <input value={comment} onChange={e => setComment(e.target.value)} className="w-full rounded-md border px-3" style={{ height: 36, background: 'var(--ground-deep)', borderColor: 'var(--border-strong)', color: 'var(--text-bright)' }} />
      </label>

      {check && <Note tone={check.blocking.length ? 'warn' : 'info'}>{check.words}</Note>}
      {strict && <Note tone="crit">{avoid ? 'Strict: these guests never run on the avoided nodes; if every other node is down, they stay off.' : 'Strict: if every node listed is down, these guests do not start anywhere.'}</Note>}
      {editing && wasStrict && !strict && <Note tone="crit">This rule stops being strict: its guests may then run on nodes it kept them off. You will be asked to confirm.</Note>}
      {refusal && <RefusalNote refusal={refusal} onFix={r => void onPreview({ action: 'flatten', ruleId: r })} onConfirm={flag => void submit(flag === 'confirmStrict', flag === 'confirmNoRoom' ? { confirmNoRoom: true, ...(strict ? { confirmStrict: true } : {}) } : {})} />}
      {check?.blocking.map((p, i) => (
        <Note key={i} tone="warn">{p.message}{p.fix && <> <button type="button" className="underline" style={{ color: 'var(--accent)' }} onClick={() => void onPreview({ action: 'flatten', ruleId: p.fix!.rule })}>Fix it first: {p.fix.words}</button></>}</Note>
      ))}
      {check?.headroom.filter(h => h.level !== 'ok').map(h => <Note key={h.rule} tone={h.level === 'tight' ? 'info' : 'warn'}>{h.words}</Note>)}
      {checkErr && <Note tone="warn">{checkErr}</Note>}
      {type === 'node-affinity' && !avoid && <p className="font-mono text-xs" style={{ color: 'var(--text-dim)' }}>Proxmox priorities: {weightsOf(home.tiers)}</p>}

      <div className="flex justify-end gap-2">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn kind={strict || (wasStrict && !strict) ? 'danger' : 'primary'} disabled={!ready} onClick={() => (strict && !(editing && wasStrict)) || (editing && wasStrict && !strict) ? setStrictAsk(true) : void submit()}>Preview</Btn>
      </div>
      {strictAsk && (
        <Dialog title={strict ? 'A strict rule?' : 'Stop being strict?'} onClose={() => setStrictAsk(false)}>
          <Note tone="crit">{strict
            ? 'Strict means nowhere else, ever: when the allowed nodes are down, these guests stay off instead of running on a healthy node.'
            : 'Without strict, these guests may run on nodes this rule kept them off, for example a node without the hardware they need.'}</Note>
          <div className="flex justify-end gap-2"><Btn onClick={() => setStrictAsk(false)}>Cancel</Btn><Btn kind="danger" onClick={() => { setStrictAsk(false); void submit(true) }}>{strict ? 'Yes, strict' : 'Yes, no longer strict'}</Btn></div>
        </Dialog>
      )}
    </Dialog>
  )
}
