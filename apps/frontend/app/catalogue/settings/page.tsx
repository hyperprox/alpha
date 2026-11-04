'use client'

// =============================================================================
//  HyperProx — Catalogue settings: the container ID rule
//
//  Many homelabs number a container after its address. With the pattern rule
//  on, the install wizard fills in the ID from the node and the IP (and the
//  other way round). The default is simply the next free ID.
// =============================================================================

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { apiJson } from '@/lib/api'
import { INPUT, LABEL, Notice, PrimaryButton } from '@/components/vault/ui'

type Rule = { kind: 'next-free' } | { kind: 'pattern'; pattern: string }

/** The same rule the server applies, for the live example only; the server decides. */
function example(pattern: string, node: string, ip: string): string {
  const digit = /(\d+)$/.exec(node)?.[1]
  const last = (ip.split('.')[3] ?? '').padStart(3, '0')
  if (!/^\d{3}$/.test(last)) return '—'
  return pattern.replace('{node_digit}', digit ?? '?').replace('{ip_last2}', last.slice(-2)).replace('{ip_last3}', last)
}

export default function CatalogueSettings() {
  const [rule, setRule] = useState<Rule>({ kind: 'next-free' })
  const [pattern, setPattern] = useState('{node_digit}{ip_last2}')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'error' | 'info'; text: string } | null>(null)

  useEffect(() => {
    void apiJson<{ data: { vmidRule: Rule } }>('/api/catalogue/wizard/settings').then(r => {
      if (r.ok && r.body?.data) {
        setRule(r.body.data.vmidRule)
        if (r.body.data.vmidRule.kind === 'pattern') setPattern(r.body.data.vmidRule.pattern)
      } else setMsg({ kind: 'error', text: r.error ?? 'Could not read the setting.' })
      setLoaded(true)
    })
  }, [])

  const save = async () => {
    setSaving(true); setMsg(null)
    const vmidRule: Rule = rule.kind === 'pattern' ? { kind: 'pattern', pattern } : { kind: 'next-free' }
    const r = await apiJson<{ data: { vmidRule: Rule } }>('/api/catalogue/wizard/settings', 'PUT', { vmidRule })
    setSaving(false)
    if (!r.ok) return setMsg({ kind: 'error', text: r.error ?? 'Could not save.' })
    setRule(r.body!.data.vmidRule)
    setMsg({ kind: 'info', text: 'Saved. The install wizard uses it from the next install.' })
  }

  const option = (kind: Rule['kind'], title: string, body: string) => (
    <label className="flex gap-3 rounded-lg border p-4 cursor-pointer"
      style={{ borderColor: rule.kind === kind ? 'var(--accent)' : 'var(--border-soft)', background: 'var(--ground-inset)' }}>
      <input type="radio" name="rule" checked={rule.kind === kind}
        onChange={() => setRule(kind === 'pattern' ? { kind, pattern } : { kind })} className="mt-1" />
      <span>
        <span className="block font-display text-[18px] font-semibold" style={{ color: 'var(--text-bright)' }}>{title}</span>
        <span className="block text-sm" style={{ color: 'var(--text-muted)' }}>{body}</span>
      </span>
    </label>
  )

  return (
    <div className="min-h-full p-4 sm:p-8" style={{ background: 'var(--ground)' }}>
      <div className="mb-6 flex flex-col gap-2 max-w-[720px]">
        <Link href="/catalogue" className="font-mono text-[11px] uppercase tracking-[0.14em] hover:underline" style={{ color: 'var(--accent)' }}>
          ← Catalogue
        </Link>
        <h1 className="font-display text-[34px] font-bold leading-none" style={{ color: 'var(--text-bright)' }}>Container ID rule</h1>
        <p className="text-[15px] leading-relaxed" style={{ color: 'var(--text-soft)' }}>
          How the install wizard suggests a container ID. You can always type a different one; it is checked against
          every container and VM before anything is created.
        </p>
      </div>
      {!loaded ? <p className="text-sm" style={{ color: 'var(--text-dim)' }}>loading…</p> : (
        <div className="space-y-3 max-w-[720px]">
          {option('next-free', 'Next free', 'The lowest ID no container or VM has. The default.')}
          {option('pattern', 'Pattern', 'Build the ID from the node and the address. Picking the IP and node fills in the ID, and typing an ID fills in the node and IP.')}
          {rule.kind === 'pattern' && (
            <div className="rounded-lg border p-4 space-y-3" style={{ borderColor: 'var(--border-soft)', background: 'var(--surface)' }}>
              <label className="block">
                <span style={LABEL}>Pattern</span>
                <input value={pattern} onChange={e => setPattern(e.target.value.trim())} style={{ ...INPUT, fontFamily: 'var(--font-mono)' }}
                  autoCapitalize="none" spellCheck={false} />
              </label>
              <ul className="text-[13px] space-y-0.5" style={{ color: 'var(--text-muted)' }}>
                <li><code className="font-mono" style={{ color: 'var(--accent)' }}>{'{node_digit}'}</code> the number at the end of the node name (node-3 → 3)</li>
                <li><code className="font-mono" style={{ color: 'var(--accent)' }}>{'{ip_last2}'}</code> the last two digits of the address (….242 → 42, ….5 → 05)</li>
                <li><code className="font-mono" style={{ color: 'var(--accent)' }}>{'{ip_last3}'}</code> the whole last number, three digits (….5 → 005)</li>
                <li>Anything else must be digits.</li>
              </ul>
              <p className="text-[13px]" style={{ color: 'var(--text-dim)' }}>
                Example: node-7 and 192.0.2.242 give <span className="font-mono" style={{ color: 'var(--text-bright)' }}>{example(pattern, 'node-7', '192.0.2.242')}</span>.
                If the ID it gives is taken, the wizard says so.
              </p>
            </div>
          )}
          {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
          <PrimaryButton onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save'}</PrimaryButton>
        </div>
      )}
    </div>
  )
}
