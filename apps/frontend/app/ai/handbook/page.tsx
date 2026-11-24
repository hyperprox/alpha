'use client'

// =============================================================================
//  HyperProx — AI, Handbook
//
//  What the operator reads before it answers: playbooks (written-down fixes) and the house rules. Read, add, edit,
//  approve and delete playbooks; paste one in as markdown; edit the rules. Only approved playbooks reach the operator,
//  and a draft written by a cloud model waits here for a person.
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { apiJson } from '@/lib/api'
import { Page, HudHeader, Panel } from '@/components/visual/kit'
import { PlaybookCard } from '@/components/ai/handbook/HandbookView'
import s from '@/components/ai/handbook/handbook.module.css'
import f from '../operator/form.module.css'
import op from '@/components/ai/operator/operator.module.css'
import {
  SECTIONS, bodyOf, countLine, draftOf, emptyDraft, filterPlaybooks, parseRules, rulesText,
  type Draft, type Filter, type HouseRules, type Playbook,
} from '@/lib/handbook-view'

const BASE = '/api/ai/handbook'
type Tab = 'playbooks' | 'rules'

export default function HandbookPage() {
  const [tab, setTab] = useState<Tab>('playbooks')
  const [list, setList] = useState<Playbook[] | null>(null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<Filter>('all')
  const [openId, setOpenId] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null)
  const [pasting, setPasting] = useState(false)
  const [markdown, setMarkdown] = useState('')
  const [exported, setExported] = useState<{ id: string; text: string } | null>(null)
  const [rules, setRules] = useState<HouseRules | null>(null)
  const [ruleText, setRuleText] = useState('')
  const [ruleList, setRuleList] = useState('')
  const [probe, setProbe] = useState('')
  const [matches, setMatches] = useState<Array<{ id: string; title: string; score: number }> | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([apiJson<{ playbooks: Playbook[] }>(`${BASE}/playbooks`), apiJson<{ rules: HouseRules }>(`${BASE}/rules`)])
    if (!a.ok) { setError(a.error ?? 'The handbook could not be read.'); return }
    setError(''); setList(a.body!.playbooks)
    if (b.ok) { setRules(b.body!.rules); setRuleText(b.body!.rules.text); setRuleList(rulesText(b.body!.rules.rules)) }
  }, [])
  useEffect(() => { void load() }, [load])

  const shown = useMemo(() => filterPlaybooks(list ?? [], { q, status }), [list, q, status])

  const act = async (what: string, run: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true); setSaved(''); setError('')
    const r = await run()
    setBusy(false)
    if (!r.ok) { setError(r.error ?? 'That did not work.'); return false }
    setSaved(what)
    await load()
    return true
  }

  const saveDraft = async () => {
    if (!editing) return
    const ok = await act('Playbook saved.', () => editing.id
      ? apiJson(`${BASE}/playbooks/${editing.id}`, 'PUT', bodyOf(editing.draft))
      : apiJson(`${BASE}/playbooks`, 'POST', bodyOf(editing.draft)))
    if (ok) setEditing(null)
  }
  const approve = (p: Playbook, approved: boolean) => act(approved ? 'Approved. The operator can use it now.' : 'Withdrawn. The operator will not use it.', () => apiJson(`${BASE}/playbooks/${p.id}/approve`, 'POST', { approved }))
  const remove = (p: Playbook) => act('Playbook deleted.', () => apiJson(`${BASE}/playbooks/${p.id}`, 'DELETE'))
  const doImport = async () => {
    const ok = await act('Added. It waits for your approval.', () => apiJson(`${BASE}/playbooks/import`, 'POST', { markdown }))
    if (ok) { setPasting(false); setMarkdown(''); setStatus('waiting') }
  }
  const doExport = async (p: Playbook) => {
    const r = await apiJson<{ markdown: string }>(`${BASE}/playbooks/${p.id}/export`)
    if (!r.ok) { setError(r.error ?? 'Could not export it.'); return }
    setExported({ id: p.id, text: r.body!.markdown })
  }
  const saveRules = () => act('House rules saved.', () => apiJson(`${BASE}/rules`, 'PUT', { text: ruleText, rules: parseRules(ruleList) }))
  const tryMatch = async () => {
    const r = await apiJson<{ matches: Array<{ id: string; title: string; score: number }> }>(`${BASE}/match?q=${encodeURIComponent(probe)}`)
    if (!r.ok) { setError(r.error ?? 'Could not test that.'); return }
    setMatches(r.body!.matches)
  }

  if (!list) return <Page><p className={f.hint}>{error || 'Loading the handbook...'}</p></Page>

  const set = (patch: Partial<Draft>) => setEditing(e => (e ? { ...e, draft: { ...e.draft, ...patch } } : e))

  return (
    <Page>
      <HudHeader level={2} icon="plugin" label="AI handbook" eyebrow="AI / Handbook" title="Handbook"
        chips={[
          { label: 'Playbooks', value: String(list.length), tone: 'good' },
          { label: 'Waiting', value: String(list.filter(p => !p.approved).length), tone: list.some(p => !p.approved) ? 'warn' : 'good' },
          { label: 'Rules', value: String(rules?.rules.length ?? 0), tone: 'good' },
        ]} />
      <p className={f.hint}><Link href="/ai/operator">Back to the operator</Link></p>
      {error && <p className={f.error} role="alert">{error}</p>}
      {saved && <p className={f.ok} role="status">{saved}</p>}

      <div className={s.tabs} role="tablist">
        {(['playbooks', 'rules'] as Tab[]).map(t => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`${s.tab} ${tab === t ? s.tabOn : ''}`} onClick={() => setTab(t)}>
            {t === 'playbooks' ? 'Playbooks' : 'House rules'}
          </button>
        ))}
      </div>

      {tab === 'playbooks' && (
        <>
          <Panel title="Playbooks" sub={`${countLine(list)} The operator only uses approved ones.`}>
            <div className={s.tools}>
              <label className={f.field}>
                <span className={f.label}>Search</span>
                <input className={f.input} value={q} onChange={e => setQ(e.target.value)} placeholder="a word from the title, a tag or a symptom" />
              </label>
              <div className={s.chips}>
                {(['all', 'waiting', 'approved'] as Filter[]).map(x => (
                  <button key={x} type="button" className={`${s.chip} ${status === x ? s.chipOn : ''}`} aria-pressed={status === x} onClick={() => setStatus(x)}>
                    {x === 'all' ? 'All' : x === 'waiting' ? 'Waiting for approval' : 'Approved'}
                  </button>
                ))}
              </div>
            </div>
            <div className={s.actions}>
              <button type="button" className={op.primary} onClick={() => { setEditing({ id: null, draft: emptyDraft() }); setPasting(false) }}>Add a playbook</button>
              <button type="button" className={f.secondary} onClick={() => { setPasting(p => !p); setEditing(null) }}>Paste markdown</button>
            </div>
          </Panel>

          {pasting && (
            <Panel title="Paste a playbook" sub="Start with --- and list title, tags, symptoms, severity and area, then the sections Checks, Cause, Fix, Safety and Test scenario. It is added as waiting for approval.">
              <textarea className={f.input} rows={12} value={markdown} onChange={e => setMarkdown(e.target.value)} aria-label="Playbook markdown" />
              <div className={f.row}>
                <button type="button" className={op.primary} disabled={busy || !markdown.trim()} onClick={() => void doImport()}>Add it</button>
                <button type="button" className={f.secondary} onClick={() => setPasting(false)}>Cancel</button>
              </div>
            </Panel>
          )}

          {editing && (
            <Panel title={editing.id ? 'Edit playbook' : 'New playbook'} sub="Write it so someone who has never seen the problem could follow it.">
              <label className={f.field}><span className={f.label}>Title</span>
                <input className={f.input} value={editing.draft.title} maxLength={160} onChange={e => set({ title: e.target.value })} /></label>
              <label className={f.field}><span className={f.label}>Tags (commas)</span>
                <input className={f.input} value={editing.draft.tags} onChange={e => set({ tags: e.target.value })} /></label>
              <label className={f.field}><span className={f.label}>What it looks like (one symptom per line)</span>
                <textarea className={f.input} rows={3} value={editing.draft.symptoms} onChange={e => set({ symptoms: e.target.value })} /></label>
              <label className={f.field}><span className={f.label}>How serious</span>
                <select className={f.input} value={editing.draft.severity} onChange={e => set({ severity: e.target.value as Draft['severity'] })}>
                  <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
                </select></label>
              <label className={f.field}><span className={f.label}>Area (a short word, such as the plug-in)</span>
                <input className={f.input} value={editing.draft.area} maxLength={40} onChange={e => set({ area: e.target.value })} /></label>
              {SECTIONS.map(x => (
                <label key={x.key} className={f.field}><span className={f.label}>{`${x.label}: ${x.hint}`}</span>
                  <textarea className={f.input} rows={4} value={editing.draft[x.key]} onChange={e => set({ [x.key]: e.target.value } as Partial<Draft>)} /></label>
              ))}
              {!editing.id && (
                <label className={f.check}><input type="checkbox" checked={editing.draft.approved} onChange={e => set({ approved: e.target.checked })} />
                  <span>Approve it now, so the operator can use it</span></label>
              )}
              <div className={f.row}>
                <button type="button" className={op.primary} disabled={busy || !editing.draft.title.trim()} onClick={() => void saveDraft()}>Save</button>
                <button type="button" className={f.secondary} onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </Panel>
          )}

          <ul className={s.list}>
            {shown.map(p => (
              <PlaybookCard key={p.id} p={p} open={openId === p.id} onToggle={() => setOpenId(openId === p.id ? null : p.id)}>
                <div className={s.actions}>
                  {p.approved
                    ? <button type="button" className={f.secondary} disabled={busy} onClick={() => void approve(p, false)}>Withdraw approval</button>
                    : <button type="button" className={op.primary} disabled={busy} onClick={() => void approve(p, true)}>Approve</button>}
                  <button type="button" className={f.secondary} onClick={() => { setEditing({ id: p.id, draft: draftOf(p) }); setPasting(false) }}>Edit</button>
                  <button type="button" className={f.secondary} onClick={() => void doExport(p)}>Export markdown</button>
                  <button type="button" className={f.secondary} disabled={busy} onClick={() => void remove(p)}>Delete</button>
                </div>
                {exported?.id === p.id && <pre className={s.mono}>{exported.text}</pre>}
              </PlaybookCard>
            ))}
          </ul>
          {!shown.length && <p className={f.hint}>{list.length ? 'Nothing matches that search.' : 'No playbooks yet. Add one, or paste one in.'}</p>}

          <Panel title="Test a question" sub="See which approved playbooks the operator would be given for a question.">
            <label className={f.field}><span className={f.label}>Question</span>
              <input className={f.input} value={probe} onChange={e => setProbe(e.target.value)} placeholder="A download is stuck at 0%" /></label>
            <button type="button" className={op.primary} disabled={!probe.trim()} onClick={() => void tryMatch()}>Which playbooks?</button>
            {matches && (matches.length
              ? <ol className={s.match}>{matches.map(m => <li key={m.id}>{m.title}</li>)}</ol>
              : <p className={f.hint}>No approved playbook matches that. The operator would answer from the rules and the live readings alone.</p>)}
          </Panel>
        </>
      )}

      {tab === 'rules' && (
        <Panel title="House rules" sub="Standing rules the operator is given with every question. Where a rule and a playbook disagree, the rule wins.">
          <label className={f.field}><span className={f.label}>Notes (free text)</span>
            <textarea className={f.input} rows={6} value={ruleText} maxLength={20000} onChange={e => setRuleText(e.target.value)} /></label>
          <label className={f.field}><span className={f.label}>Rules (one per line)</span>
            <textarea className={f.input} rows={14} value={ruleList} onChange={e => setRuleList(e.target.value)} /></label>
          <p className={f.hint}>{`${parseRules(ruleList).length} rules. The ones that touch a question come first; all are sent while they fit the local model's room.${rules?.updatedAt ? ` Last saved ${new Date(rules.updatedAt).toLocaleString()}.` : ''}`}</p>
          <button type="button" className={op.primary} disabled={busy} onClick={() => void saveRules()}>Save the rules</button>
        </Panel>
      )}
    </Page>
  )
}
