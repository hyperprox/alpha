'use client'

// =============================================================================
//  HyperProx — AI, Operator, Tiers
//
//  The ladder of models the operator climbs (local, Haiku, Sonnet, Opus), what each costs, what is hidden before
//  anything leaves, and a box to ask it a question. The local model's key is pasted here and goes straight to the
//  vault: this page is only ever told "stored" or "not stored".
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { apiJson } from '@/lib/api'
import { Page, HudHeader, Panel } from '@/components/visual/kit'
import { AnswerCard, Ladder, SpendMeter } from '@/components/ai/operator/OperatorView'
import s from '@/components/ai/operator/operator.module.css'
import f from './form.module.css'
import { TIERS, parseTopics, tierWord, type OperatorResult, type Spend, type Tier, type TierStatus } from '@/lib/operator-view'

interface Settings {
  tiers: Record<Tier, { enabled: boolean; model: string }>
  localBaseUrl: string
  opusNeedsApproval: boolean
  monthlyCapUsd: number
  redactBeforeCloud: boolean
  localOnlyTopics: string[]
}
interface Keys { localKeyStored: boolean; anthropicKeyStored: boolean; locked: boolean }

export default function OperatorPage() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [keys, setKeys] = useState<Keys | null>(null)
  const [tiers, setTiers] = useState<TierStatus[]>([])
  const [spend, setSpend] = useState<Spend | null>(null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [topics, setTopics] = useState('')
  const [keyText, setKeyText] = useState('')
  const [question, setQuestion] = useState('')
  const [force, setForce] = useState<'auto' | Tier>('auto')
  const [result, setResult] = useState<OperatorResult | null>(null)
  const [askedText, setAskedText] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [a, b, c] = await Promise.all([
      apiJson<{ settings: Settings; keys: Keys }>('/api/ai/operator/settings'),
      apiJson<{ tiers: TierStatus[] }>('/api/ai/operator/tiers'),
      apiJson<Spend>('/api/ai/operator/spend'),
    ])
    if (!a.ok) { setError(a.error ?? 'The operator settings could not be read.'); return }
    setError('')
    setSettings(a.body!.settings); setKeys(a.body!.keys); setTopics(a.body!.settings.localOnlyTopics.join('\n'))
    if (b.ok) setTiers(b.body!.tiers)
    if (c.ok) setSpend(c.body!)
  }, [])
  useEffect(() => { void load() }, [load])

  const save = async (patch: Record<string, unknown>, what: string) => {
    setSaved(''); setError('')
    const r = await apiJson<{ settings: Settings }>('/api/ai/operator/settings', 'PUT', patch)
    if (!r.ok) { setError(r.error ?? 'That did not save.'); return }
    setSaved(`${what} saved.`)
    await load()
  }

  const saveKey = async (clear = false) => {
    setSaved(''); setError('')
    const r = await apiJson<{ stored: boolean }>('/api/ai/operator/key', 'PUT', { key: clear ? '' : keyText })
    setKeyText('')                       // never keep a pasted key on the page
    if (!r.ok) { setError(r.error ?? 'The key was not saved.'); return }
    setSaved(r.body!.stored ? 'Key stored in the vault.' : 'Key removed from the vault.')
    await load()
  }

  const ask = async (approval?: string) => {
    setBusy(true); setError('')
    const text = approval ? askedText : question
    if (!approval) setAskedText(question)
    const r = await apiJson<{ result: OperatorResult }>(approval ? '/api/ai/operator/ask/approve' : '/api/ai/operator/ask', 'POST',
      approval ? { text, approval } : { text, force: force === 'auto' ? null : force })
    setBusy(false)
    if (!r.ok) { setError(r.error ?? 'The operator did not answer.'); return }
    setResult(r.body!.result)
    void load()
  }

  if (!settings) {
    return <Page><p className={f.hint}>{error || 'Loading the operator...'}</p></Page>
  }
  const locked = keys?.locked

  return (
    <Page>
      <HudHeader level={2} icon="plugin" label="AI operator"
        eyebrow="AI / Operator"
        title="Tiers"
        chips={[
          { label: 'Ready tiers', value: `${tiers.filter(t => t.ready).length} of 4`, tone: tiers.some(t => t.ready) ? 'good' : 'warn' },
          { label: 'Opus', value: settings.opusNeedsApproval ? 'asks first' : 'runs freely', tone: settings.opusNeedsApproval ? 'good' : 'warn' },
          { label: 'Privacy', value: settings.redactBeforeCloud ? 'hidden before cloud' : 'not hidden', tone: settings.redactBeforeCloud ? 'good' : 'warn' },
        ]} />
      <p className={f.hint}><Link href="/ai">Back to AI</Link> · <Link href="/ai/handbook">Handbook: playbooks and house rules</Link></p>

      {locked && <p className={f.notice} role="status">HyperProx is locked, so keys cannot be read or saved. Sign in to unlock it.</p>}
      {error && <p className={f.error} role="alert">{error}</p>}
      {saved && <p className={f.ok} role="status">{saved}</p>}

      <Panel title="The ladder" sub="A question starts on the cheapest tier that can handle it and moves up only when it has to.">
        <Ladder tiers={tiers} />
      </Panel>

      <Panel title="Ask the operator" sub="Try it here. Start your question with “ask Sonnet:” (or Haiku, Opus, local) to choose a tier yourself.">
        <label className={f.field}>
          <span className={f.label}>Your question</span>
          <textarea className={f.input} rows={4} maxLength={8000} value={question} onChange={e => setQuestion(e.target.value)} placeholder="Why is the nightly backup slow?" />
        </label>
        <label className={f.field}>
          <span className={f.label}>Which tier</span>
          <select className={f.input} value={force} onChange={e => setForce(e.target.value as any)}>
            <option value="auto">Automatic (recommended)</option>
            {TIERS.map(t => <option key={t} value={t}>Always {tierWord(t)}</option>)}
          </select>
        </label>
        <button type="button" className={s.primary} disabled={busy || !question.trim() || locked} onClick={() => void ask()}>{busy ? 'Thinking...' : 'Ask'}</button>
        {result && <AnswerCard result={result} busy={busy} onApprove={result.status === 'needs_approval' ? () => void ask(result.approvalToken) : undefined} />}
      </Panel>

      <Panel title="Spend" sub="Estimated from token counts, not billed. Your provider's invoice is the real figure.">
        {spend && <SpendMeter spend={spend} />}
        <label className={f.field}>
          <span className={f.label}>Monthly cap in US dollars (0 means no cap)</span>
          <input className={f.input} type="number" min={0} step="1" defaultValue={settings.monthlyCapUsd}
            onBlur={e => { const v = Number(e.target.value); if (Number.isFinite(v) && v !== settings.monthlyCapUsd) void save({ monthlyCapUsd: v }, 'The cap') }} />
        </label>
      </Panel>

      <Panel title="Local model" sub="Any server that speaks the OpenAI chat format. Nothing you ask it leaves your network.">
        <label className={f.field}>
          <span className={f.label}>Address</span>
          <input className={f.input} defaultValue={settings.localBaseUrl} placeholder="http://10.0.0.5:8080/v1" inputMode="url"
            onBlur={e => { if (e.target.value.trim() !== settings.localBaseUrl) void save({ localBaseUrl: e.target.value }, 'The address') }} />
        </label>
        <label className={f.field}>
          <span className={f.label}>Model name</span>
          <input className={f.input} defaultValue={settings.tiers.local.model}
            onBlur={e => { if (e.target.value.trim() !== settings.tiers.local.model) void save({ tiers: { local: { model: e.target.value } } }, 'The model name') }} />
        </label>
        <label className={f.field}>
          <span className={f.label}>Key for the local model (optional)</span>
          <input className={f.input} type="password" autoComplete="off" value={keyText} onChange={e => setKeyText(e.target.value)}
            placeholder={keys?.localKeyStored ? 'A key is stored. Paste a new one to replace it.' : 'Paste the key if the server needs one'} />
        </label>
        <p className={f.hint}>Status: <b>{keys?.localKeyStored ? 'a key is stored in the vault' : 'no key stored'}</b>. HyperProx never shows a stored key again.</p>
        <div className={f.row}>
          <button type="button" className={s.primary} disabled={!keyText.trim() || locked} onClick={() => void saveKey()}>Store key</button>
          {keys?.localKeyStored && <button type="button" className={f.secondary} disabled={locked} onClick={() => void saveKey(true)}>Remove key</button>}
        </div>
      </Panel>

      <Panel title="Each tier" sub="Turn a tier off to skip it. The cloud tiers use the Anthropic key from AI, Providers.">
        {TIERS.map(t => (
          <div key={t} className={f.tierRow}>
            <label className={f.check}>
              <input type="checkbox" checked={settings.tiers[t].enabled} onChange={e => void save({ tiers: { [t]: { enabled: e.target.checked } } }, `${tierWord(t)}`)} />
              <span>{tierWord(t)}</span>
            </label>
            {t !== 'local' && (
              <input className={f.input} aria-label={`${tierWord(t)} model`} defaultValue={settings.tiers[t].model}
                onBlur={e => { if (e.target.value.trim() !== settings.tiers[t].model) void save({ tiers: { [t]: { model: e.target.value } } }, `The ${tierWord(t)} model`) }} />
            )}
          </div>
        ))}
        {keys && !keys.anthropicKeyStored && <p className={f.notice}>No Anthropic key is stored yet, so Haiku, Sonnet and Opus are not ready. Add one under AI, Providers.</p>}
      </Panel>

      <Panel title="Safety" sub="What happens before anything is sent to the cloud.">
        <label className={f.check}>
          <input type="checkbox" checked={settings.opusNeedsApproval} onChange={e => void save({ opusNeedsApproval: e.target.checked }, 'The Opus setting')} />
          <span>Ask me before using Opus, every time</span>
        </label>
        <label className={f.check}>
          <input type="checkbox" checked={settings.redactBeforeCloud} onChange={e => void save({ redactBeforeCloud: e.target.checked }, 'The privacy setting')} />
          <span>Hide addresses and host names before anything goes to the cloud</span>
        </label>
        <label className={f.field}>
          <span className={f.label}>Keep these topics on the local model (one per line)</span>
          <textarea className={f.input} rows={3} value={topics} onChange={e => setTopics(e.target.value)}
            onBlur={() => { const next = parseTopics(topics); if (JSON.stringify(next) !== JSON.stringify(settings.localOnlyTopics)) void save({ localOnlyTopics: next }, 'The topic list') }}
            placeholder="payroll" />
        </label>
        <p className={f.hint}>A question that mentions any of these words is never sent to the cloud.</p>
      </Panel>
    </Page>
  )
}
